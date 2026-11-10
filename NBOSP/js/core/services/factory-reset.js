(function (global) {
  'use strict';

  async function clearDirectoryContents(directory, expectedDirectory) {
    const fs = require('fs').promises;
    const path = require('path');
    if (typeof directory !== 'string' || !directory
      || typeof expectedDirectory !== 'string' || !expectedDirectory) {
      throw new Error('A reset directory and its approved path are required');
    }
    const resolvedDirectory = path.resolve(directory);
    const resolvedExpectedDirectory = path.resolve(expectedDirectory);

    if (resolvedDirectory !== resolvedExpectedDirectory) {
      throw new Error('Refusing to clear a directory outside the approved reset scope');
    }

    const stats = await fs.lstat(resolvedDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()
      || await fs.realpath(resolvedDirectory) !== resolvedDirectory) {
      throw new Error('The reset target must be a real directory');
    }

    const entries = await fs.readdir(resolvedDirectory);
    for (const entry of entries) {
      await fs.rm(path.join(resolvedDirectory, entry), { recursive: true });
    }
  }

  function isNbospLinuxRuntime(runtime = {}) {
    const hasProcess = typeof process !== 'undefined';
    const os = require('os');
    const path = require('path');
    const platform = runtime.platform ?? (hasProcess ? process.platform : '');
    if (platform !== 'linux') return false;
    const home = path.posix.resolve(runtime.home ?? os.homedir());
    const expectedDataDirectory = path.posix.join(home, '.config', 'novabyte', 'runtime');
    const dataDirectory = runtime.dataDirectory ?? (hasProcess ? process.env.NBOSP_DATA_DIR : '');

    return home === '/home/nbosp'
      && path.posix.resolve(dataDirectory || '') === expectedDataDirectory;
  }

  async function performLinuxFactoryReset() {
    if (!isNbospLinuxRuntime()) return false;

    const fs = require('fs').promises;
    const { execFile } = require('child_process');
    await fs.access('/usr/bin/nbosp-power', require('fs').constants.X_OK);
    await clearDirectoryContents('/home/nbosp', '/home/nbosp');

    await new Promise((resolve, reject) => {
      execFile('/usr/bin/nbosp-power', ['restart'], (error) => {
        if (error) reject(new Error(`User data was erased, but system restart failed: ${error.message}`));
        else resolve();
      });
    });
    return true;
  }

  const api = Object.freeze({ clearDirectoryContents, isNbospLinuxRuntime, performLinuxFactoryReset });
  global.NovaFactoryReset = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
