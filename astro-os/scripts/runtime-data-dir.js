'use strict';

const path = require('path');

function getRuntimeDataDir(appDir) {
  return process.env.ASTROOS_DATA_DIR || appDir || path.resolve(__dirname, '..');
}

module.exports = { getRuntimeDataDir };
