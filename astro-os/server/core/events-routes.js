'use strict';

const express        = require('express');
const ServerEventLog = require('./server-event-log');

function setupEventsRoutes(app) {
  const router = express.Router();

  router.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    // Send historical log buffer to newly connected client
    for (const entry of ServerEventLog.getAll()) {
      if (res.writableEnded || res.destroyed) break;
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = ServerEventLog.subscribe((entry) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': heartbeat\n\n');
      }
    }, 25_000);

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe();
    }

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  });

  app.use('/api/events', router);
}

module.exports = { setupEventsRoutes };