import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(process.argv[2] ?? "");
const manifestPath = path.join(appDir, "package.nw", "package.json");
const sqlitePrebuildsDir = path.join(
  appDir,
  "package.nw",
  "node_modules",
  "better-sqlite3",
  "prebuilds",
);

if (!process.argv[2] || !fs.existsSync(manifestPath)) {
  throw new Error(`NW.js app manifest not found: ${manifestPath}`);
}

const sqlitePrebuilds = fs.readdirSync(sqlitePrebuildsDir, { withFileTypes: true });
if (!sqlitePrebuilds.some((entry) => entry.isFile() && entry.name === "linux-x64.node")) {
  throw new Error(`Linux x64 better-sqlite3 prebuild not found: ${sqlitePrebuildsDir}`);
}

for (const entry of sqlitePrebuilds) {
  if (entry.isFile() && entry.name.endsWith(".node") && entry.name !== "linux-x64.node") {
    fs.unlinkSync(path.join(sqlitePrebuildsDir, entry.name));
  }
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.window = {
  ...manifest.window,
  frame: false,
  fullscreen: true,
  kiosk: true,
  "chromium-args": [
    "--no-first-run",
    "--disable-devtools",
    "--allow-insecure-localhost",
    "--enable-features=UseOzonePlatform",
    "--ozone-platform=x11",
    "--use-gl=angle",
    "--use-angle=gl",
    "--disable-features=Vulkan",
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--enable-zero-copy",
    "--user-data-dir=/home/nbosp/.config/novabyte",
  ].join(" "),
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
