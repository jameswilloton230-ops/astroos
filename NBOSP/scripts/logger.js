'use strict';

const fs   = require('fs');
const path = require('path');
const { getRuntimeDataDir } = require('./runtime-data-dir');

/**
 * Opens server.log in append mode.
 * @param {string} appDir
 * @returns {fs.WriteStream}
 */
function createLogStream(appDir) {
  const stream = fs.createWriteStream(path.join(getRuntimeDataDir(appDir), 'server.log'), { flags: 'a' });
  stream.on('error', (err) => {
    console.error('[NovaByte] Log stream error:', err.message);
  });
  return stream;
}

/**
 * Opens the Windows console output handle when NW_SHOW_CONSOLE=true.
 * Returns null on non-Windows or if the handle cannot be opened.
 * @returns {fs.WriteStream|null}
 */
function createConout() {
  if (process.platform !== 'win32' || process.env.NW_SHOW_CONSOLE !== 'true') {
    return null;
  }
  try {
    const conout = fs.createWriteStream('\\\\.\\CONOUT$', { flags: 'a' });
    conout.on('error', () => {});
    return conout;
  } catch (_) {
    return null;
  }
}

/**
 * Returns a tee function that writes to logStream and either conout or stdout/stderr.
 *
 * @param {fs.WriteStream}       logStream
 * @param {fs.WriteStream|null}  conout
 * @returns {(chunk: Buffer|string, isErr?: boolean) => void}
 */
function makeTee(logStream, conout) {
  let live = conout;
  if (live) {
    live.on('error', () => {
      live = null;
    });
  }

  return function tee(chunk, isErr = false) {
    try {
      if (logStream && logStream.writable) {
        logStream.write(chunk);
      }
    } catch (_) {}

    if (live && live.writable) {
      try {
        live.write(chunk);
      } catch (_) {
        live = null;
      }
    } else {
      try {
        const stream = isErr ? process.stderr : process.stdout;
        if (stream && stream.writable) {
          stream.write(chunk);
        }
      } catch (_) {}
    }
  };
}

module.exports = { createLogStream, createConout, makeTee };