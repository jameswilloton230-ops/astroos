'use strict';

const fs   = require('fs');
const path = require('path');

/**
 * Opens server.log in append mode.
 * @param {string} appDir
 * @returns {fs.WriteStream}
 */
function createLogStream(appDir) {
  return fs.createWriteStream(path.join(appDir, 'server.log'), { flags: 'a' });
}

/**
 * Opens the Windows console output handle when NW_SHOW_CONSOLE=true.
 * Returns null on non-Windows or if the handle can't be opened.
 * @returns {fs.WriteStream|null}
 */
function createConout() {
  if (process.platform !== 'win32' || process.env.NW_SHOW_CONSOLE !== 'true') return null;
  try {
    return fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
  } catch (_) {
    return null;
  }
}

/**
 * Returns a tee function that writes to logStream and either conout or
 * stdout/stderr. If conout emits an error it is nulled out in the closure
 * and subsequent calls fall back to stdout/stderr — matching the original
 * behaviour of `_conout = null` inside the error handler.
 *
 * @param {fs.WriteStream}       logStream
 * @param {fs.WriteStream|null}  conout
 * @returns {(chunk: Buffer|string, isErr?: boolean) => void}
 */
function makeTee(logStream, conout) {
  let live = conout;
  if (live) live.on('error', () => { live = null; });

  return function tee(chunk, isErr = false) {
    try { logStream.write(chunk); } catch (_) {}

    if (live) {
      try { live.write(chunk); } catch (_) { live = null; }
    } else {
      try { (isErr ? process.stderr : process.stdout).write(chunk); } catch (_) {}
    }
  };
}

module.exports = { createLogStream, createConout, makeTee };
