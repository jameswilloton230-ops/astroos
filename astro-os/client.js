'use strict';

const path          = require('path');
const { bootstrap } = require('./scripts/startup');

(async () => {
  try {
    await bootstrap(path.resolve(__dirname));
  } catch (err) {
    console.error('[NovaByte] Fatal startup error:', err.message);
    process.exit(1);
  }
})();