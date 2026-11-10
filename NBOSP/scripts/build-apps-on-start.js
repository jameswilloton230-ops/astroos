'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

if (process.env.NBOSP_SKIP_APP_BUILD === '1') {
  console.log('[app-build] Skipping NovaApp build (NBOSP_SKIP_APP_BUILD=1).');
  process.exit(0);
}

const builder = path.resolve(__dirname, '..', 'build-apps.mjs');
const result = spawnSync(process.execPath, [builder], {
  cwd: path.resolve(__dirname, '..'),
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error('[app-build] Failed to start NovaApp builder:', result.error.message);
  process.exit(1);
}
if (result.signal) {
  console.error(`[app-build] NovaApp builder terminated by signal ${result.signal}.`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
