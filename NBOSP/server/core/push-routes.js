'use strict';

// push-routes — HTTP surface of the OS push service (push:receive).
//
//   GET  /api/push/stream    — device SSE stream. The OS host only; same
//                              trust gate as every other system-app call
//                              (HMAC-signed via system-fetch).
//   POST /api/push/subscribe — token→device mapping sync. The OS host only.
//   POST /api/push/publish   — app backends. UNTRUSTED on purpose: the
//                              caller proves ownership by holding a
//                              subscription token, and the global /api/
//                              rate limiter treats it like any other
//                              outside traffic (same 100-req/15-min/IP
//                              budget as the rest of the untrusted API).
//
// Message validation lives here so the bus and the host-side delivery
// ladder both see the same normalized shape: { appId?, id?, title?, body?,
// data?, sentAt? } — title ≤ 200 chars, body ≤ 2000, data a JSON object
// ≤ 4 KB. The host re-checks the push:receive grant for the target app on
// every delivery; a publish addressed to an app whose grant was revoked is
// relayed (token mapping is host-supplied) and dropped at the device —
// never allowed to run code.

const express = require('express');
const { isTrustedSystemAppRequest } = require('../rate-limit-auth');
const pushBus = require('./push-bus');

const TITLE_MAX = 200;
const BODY_MAX = 2000;
const DATA_MAX_BYTES = 4 * 1024;
const TOKENS_MAX = 64;

function setupPushRoutes(app) {
  const router = express.Router();

  router.post('/subscribe', (req, res) => {
    if (!isTrustedSystemAppRequest(req)) {
      return res.status(403).json({ error: 'System trust required' });
    }
    const { deviceId, subscriptions } = req.body ?? {};
    if (!pushBus.isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: 'Invalid deviceId' });
    }
    if (!Array.isArray(subscriptions) || subscriptions.length > TOKENS_MAX) {
      return res.status(400).json({ error: `subscriptions must be an array of at most ${TOKENS_MAX} { token, appId } entries` });
    }
    const subscribed = pushBus.subscribe(deviceId, subscriptions);
    return res.json({ ok: true, subscribed });
  });

  router.get('/stream', (req, res) => {
    if (!isTrustedSystemAppRequest(req)) {
      return res.status(403).json({ error: 'System trust required' });
    }
    const deviceId = req.query.deviceId;
    if (!pushBus.isValidDeviceId(deviceId)) {
      return res.status(400).json({ error: 'Invalid deviceId' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const detach = pushBus.attachStream(deviceId, res);

    // Replay whatever this device's tokens missed while it was offline,
    // once — at-most-once per backlog entry, drained on this connect.
    pushBus.drainForDevice(deviceId, (frame) => {
      if (!res.writableEnded && !res.destroyed) res.write(frame);
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
    }, 25_000);

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      detach();
    }
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
  });

  router.post('/publish', (req, res) => {
    const { token, title, body, data, id } = req.body ?? {};
    if (!pushBus.isValidPushToken(token)) {
      return res.status(400).json({ delivered: false, reason: 'invalid-token' });
    }
    if (title !== undefined && (typeof title !== 'string' || title.length > TITLE_MAX)) {
      return res.status(400).json({ delivered: false, reason: 'invalid-title' });
    }
    if (body !== undefined && (typeof body !== 'string' || body.length > BODY_MAX)) {
      return res.status(400).json({ delivered: false, reason: 'invalid-body' });
    }
    if (id !== undefined && (typeof id !== 'string' || id.length < 1 || id.length > 64)) {
      return res.status(400).json({ delivered: false, reason: 'invalid-id' });
    }
    if (data !== undefined && data !== null) {
      if (typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ delivered: false, reason: 'invalid-data' });
      }
      try {
        if (JSON.stringify(data).length > DATA_MAX_BYTES) {
          return res.status(400).json({ delivered: false, reason: 'data-too-large' });
        }
      } catch (_) {
        return res.status(400).json({ delivered: false, reason: 'invalid-data' });
      }
    }

    const result = pushBus.publish(token, {
      id: typeof id === 'string' ? id : undefined,
      title: typeof title === 'string' ? title : undefined,
      body: typeof body === 'string' ? body : undefined,
      data: data ?? null,
      sentAt: new Date().toISOString(),
    });
    // Backlogged-but-offline is a success-shaped 202: the message made it,
    // delivery depends on the device reconnecting (see the backlog contract).
    if (result.delivered) return res.json({ delivered: true });
    if (result.reason === 'unknown-token') return res.status(404).json({ delivered: false, reason: 'unknown-token' });
    return res.status(202).json({ delivered: false, reason: result.reason });
  });

  app.use('/api/push', router);
}

module.exports = { setupPushRoutes };
