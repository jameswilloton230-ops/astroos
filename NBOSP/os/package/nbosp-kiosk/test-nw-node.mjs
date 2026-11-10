import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [binaryArg, appDirArg] = process.argv.slice(2);
if (!binaryArg || !appDirArg) {
  throw new Error("Usage: test-nw-node.mjs <NW.js binary> <app package directory>");
}

const binaryPath = path.resolve(binaryArg);
const appDir = path.resolve(appDirArg);
if (!fs.existsSync(binaryPath) || !fs.existsSync(path.join(appDir, "node_modules", "better-sqlite3"))) {
  throw new Error("NW.js binary or better-sqlite3 dependency is missing");
}

const distributionDir = path.dirname(binaryPath);
const testRoot = path.dirname(appDir);
const testAppDir = path.join(testRoot, `.nbosp-nw-node-test-${process.pid}`);
const testRuntimeDir = path.join(testRoot, `.nbosp-nw-runtime-test-${process.pid}`);
const testBinaryPath = path.join(testRuntimeDir, path.basename(binaryPath));
const resultPath = path.join(testAppDir, "result");
const errorPath = path.join(testAppDir, "error");
fs.mkdirSync(testAppDir);
fs.mkdirSync(testRuntimeDir);

try {
  fs.symlinkSync(
    path.join(appDir, "node_modules"),
    path.join(testAppDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(
    path.join(testAppDir, "package.json"),
    JSON.stringify({
      name: "nbosp-nw-node-test",
      main: "index.html",
      "node-main": "test.js",
    }),
  );
  fs.writeFileSync(
    path.join(testAppDir, "index.html"),
    "<!doctype html><title>NW.js runtime check</title>",
  );
  fs.writeFileSync(
    path.join(testAppDir, "test.js"),
    [
      'try {',
      '  const assert = require("node:assert/strict");',
      '  assert.equal(typeof process.versions.node, "string");',
      '  const Database = require("better-sqlite3");',
      '  const db = new Database(":memory:");',
      '  assert.equal(db.prepare("SELECT 42 AS answer").get().answer, 42);',
      '  db.close();',
      '  require("node:fs").writeFileSync(require("node:path").join(__dirname, "result"), "NBOSP_NWJS_NODE_RUNTIME_OK");',
      '  nw.App.quit();',
      '} catch (error) {',
      '  console.error(error.stack || error);',
      '  require("node:fs").writeFileSync(require("node:path").join(__dirname, "error"), error.stack || String(error));',
      '  process.exit(1);',
      '}',
    ].join("\n"),
  );

  fs.copyFileSync(binaryPath, testBinaryPath);
  for (const entry of fs.readdirSync(distributionDir, { withFileTypes: true })) {
    if (entry.name === path.basename(binaryPath) || entry.name === "package.nw") continue;
    const sourcePath = path.join(distributionDir, entry.name);
    const targetPath = path.join(testRuntimeDir, entry.name);
    fs.symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "dir" : "file");
  }

  const result = spawnSync(
    testBinaryPath,
    ["--disable-gpu", "--no-sandbox", testAppDir],
    {
      cwd: testRuntimeDir,
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const diagnostics = [
    `status: ${result.status}`,
    `signal: ${result.signal}`,
    result.error ? `spawn error: ${result.error.message}` : "",
    result.stderr,
    result.stdout,
    fs.existsSync(errorPath) ? fs.readFileSync(errorPath, "utf8") : "",
  ].filter(Boolean).join("\n");
  assert.equal(result.status, 0, diagnostics);
  const resultMarker = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : null;
  assert.equal(
    resultMarker,
    "NBOSP_NWJS_NODE_RUNTIME_OK",
    `NW.js exited without completing its Node integration check.\n${diagnostics}`,
  );
  console.log("NW.js node-main and better-sqlite3 runtime test passed.");
} finally {
  fs.rmSync(testAppDir, { recursive: true, force: true });
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
}
