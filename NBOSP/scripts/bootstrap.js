'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const root        = path.resolve(__dirname, '..');
const packageJson = path.join(root, 'package.json');
const packageLock = path.join(root, 'package-lock.json');
const nodeModules = path.join(root, 'node_modules');
const nmLock      = path.join(nodeModules, '.package-lock.json');

function mtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (_) {
    return -1;
  }
}

function readPkg() {
  try {
    return JSON.parse(fs.readFileSync(packageJson, 'utf8'));
  } catch (err) {
    console.error('[bootstrap] Failed to read package.json:', err.message);
    process.exit(1);
  }
}

function shouldInstall() {
  if (!fs.existsSync(nodeModules)) return true;

  // Fast path for npm 7+: npm writes node_modules/.package-lock.json after install
  if (fs.existsSync(packageLock)) {
    const nm = mtime(nmLock);
    return nm === -1 || mtime(packageLock) > nm;
  }

  // Fallback: check that every declared dependency directory exists
  const pkg  = readPkg();
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  return deps.some(d => !fs.existsSync(path.join(nodeModules, d)));
}

function runInstall() {
  const useCi = fs.existsSync(packageLock);
  const args  = useCi
    ? ['ci',      '--no-audit', '--no-fund', '--loglevel=error']
    : ['install', '--no-audit', '--no-fund', '--loglevel=error'];

  console.log(`[bootstrap] Running npm ${args[0]}...`);

  const npmExec          = process.env.npm_execpath;
  const [cmd, spawnArgs] = (npmExec && fs.existsSync(npmExec))
    ? [process.execPath, [npmExec, ...args]]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', args];

  const r = spawnSync(cmd, spawnArgs, {
    cwd: root, stdio: 'inherit', env: process.env, windowsHide: true,
  });

  if (r.error) {
    console.error('[bootstrap] npm spawn failed:', r.error.message);
    process.exit(1);
  }
  if (r.signal) {
    console.error(`[bootstrap] npm killed by signal ${r.signal}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

function syncVendor() {
  const src  = path.join(nodeModules, 'dompurify', 'dist', 'purify.min.js');
  const dest = path.join(root, 'js', 'purify.min.js');

  if (mtime(src) === mtime(dest)) return;

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);

    // Synchronize file timestamps so future stat checks match accurately
    const stat = fs.statSync(src);
    fs.utimesSync(dest, stat.atime, stat.mtime);

    console.log('[bootstrap] Synced vendor: purify.min.js');
  } catch (err) {
    console.error('[bootstrap] Failed to sync DOMPurify:', err.message);
    process.exit(1);
  }
}

if (shouldInstall()) {
  runInstall();
} else {
  console.log('[bootstrap] Dependencies up to date.');
}

syncVendor();