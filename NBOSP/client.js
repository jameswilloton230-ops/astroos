'use strict';

const path = require('path');
const { bootstrap } = require('./scripts/startup');

// Capture early synchronous crashes before bootstrap runs
process.on('uncaughtException', (err) => {
  const detail = Error.isError(err) ? (err.stack || err.message) : String(err);
  console.error('[NovaByte] Uncaught exception during startup:', detail);
  process.exit(1);
});

// Capture early asynchronous promise rejections before bootstrap completes
process.on('unhandledRejection', (reason) => {
  const detail = Error.isError(reason) ? (reason.stack || reason.message) : String(reason);
  console.error('[NovaByte] Unhandled rejection during startup:', detail);
  process.exit(1);
});

// Run main application startup sequence
(async () => {
  try {
    await bootstrap(path.resolve(__dirname));
  } catch (err) {
    // Preserve full stack trace and error causes instead of truncating to err.message
    const detail = Error.isError(err) ? (err.stack || err.message) : String(err);
    console.error('[NovaByte] Fatal startup error:', detail);
    process.exit(1);
  }
})();