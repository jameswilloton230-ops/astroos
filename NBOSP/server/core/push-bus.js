'use strict';

// push-bus — the server half of the OS push service (push:receive).
//
// The OS host holds ONE SSE stream per device (never per app — apps get no
// listen sockets, matching the host-side delivery ladder). This module is
// the in-memory wiring between that stream and app backends publishing to
// a subscription token:
//
//   device connects  →  GET /api/push/stream?deviceId=D   (stream attached)
//   host subscribes  →  POST /api/push/subscribe { deviceId, tokens }
//                        (token T ↔ device D, in memory only)
//   backend publishes → POST /api/push/publish { token, ... }
//                        (T → D → SSE frame into D's stream)
//
// Deliberate v1 honesty, mirrored by the NOVAAPP.md docs:
//   - Everything here is in-memory. A server restart forgets token→device
//     mappings — but the host re-subscribes its whole token set on every
//     (re)connect, so the mapping self-heals with no server persistence.
//   - A small per-token backlog (last 16 messages, 24 h) replays to the
//     device on its next connect and is drained there; it covers brief
//     disconnects, not mailboxes. Anything older or beyond the cap is
//     genuinely lost — push is live-delivery semantics, not a queue.

const BACKLOG_MAX = 16;
const BACKLOG_TTL_MS = 24 * 60 * 60 * 1000;

// deviceId → SSE res
const streams = new Map();
// token → deviceId
const tokenIndex = new Map();
// token → [{ message, ts }]
const backlog = new Map();

function isValidDeviceId(deviceId) {
  return typeof deviceId === 'string' && /^[\w-]{8,64}$/.test(deviceId);
}

function isValidPushToken(token) {
  return typeof token === 'string' && /^nps_[0-9a-f]{32}$/.test(token);
}

function isValidAppId(appId) {
  return typeof appId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(appId);
}

function pruneBacklog(entries, now) {
  while (entries.length && (entries.length > BACKLOG_MAX || now - entries[0].ts > BACKLOG_TTL_MS)) {
    entries.shift();
  }
}

/**
 * Record a device's live subscription set. Each entry is { token, appId }
 * — the token is the publish capability, and the TRUSTED host supplies the
 * appId it was issued for, so a backend publishing to a token can never
 * address a different app than the one that registered it. Replaces that
 * device's previous mapping wholesale — the host sends its CURRENT tokens
 * on every sync, so a stale token (revoked grant, uninstalled app) simply
 * stops being mapped. Returns the number of tokens now mapped.
 */
function subscribe(deviceId, subscriptions) {
  if (!isValidDeviceId(deviceId)) return 0;
  if (!Array.isArray(subscriptions)) return 0;
  // Drop this device's old mappings first so re-syncs actually prune.
  for (const [token, mapped] of tokenIndex.entries()) {
    if (mapped.deviceId === deviceId) tokenIndex.delete(token);
  }
  let count = 0;
  for (const entry of subscriptions) {
    const token = entry && entry.token;
    const appId = entry && entry.appId;
    if (!isValidPushToken(token) || !isValidAppId(appId)) continue;
    tokenIndex.set(token, { deviceId, appId });
    count += 1;
  }
  return count;
}

/** Attach a device's SSE stream. Returns a cleanup function. */
function attachStream(deviceId, res) {
  streams.set(deviceId, res);
  return () => {
    if (streams.get(deviceId) === res) streams.delete(deviceId);
  };
}

/**
 * Publish one message to a token. Always stores to the backlog; writes an
 * SSE frame to the device stream only when that device is connected right
 * now. Returns { delivered, reason? } — 'unknown-token' means no device
 * has ever (or recently) subscribed this token; 'device-offline' means a
 * mapping exists but the stream is down and the message only made the
 * backlog.
 */
function publish(token, message) {
  if (!isValidPushToken(token)) return { delivered: false, reason: 'invalid-token' };
  const mapping = tokenIndex.get(token);
  if (!mapping) return { delivered: false, reason: 'unknown-token' };
  const deviceId = mapping.deviceId;

  const now = Date.now();
  if (!backlog.has(token)) backlog.set(token, []);
  const entries = backlog.get(token);
  entries.push({ message: Object.assign({}, message, { sentAt: message && message.sentAt ? message.sentAt : new Date(now).toISOString() }), ts: now });
  pruneBacklog(entries, now);

  const res = streams.get(deviceId);
  if (!res || res.writableEnded || res.destroyed) return { delivered: false, reason: 'device-offline' };
  try {
    const payload = entries[entries.length - 1].message;
    res.write(`data: ${JSON.stringify(Object.assign({ appId: mapping.appId }, payload))}\n\n`);
    return { delivered: true };
  } catch (_) {
    return { delivered: false, reason: 'device-offline' };
  }
}

/**
 * Replay (and drain) the backlog for every token currently mapped to a
 * device — called by the stream route right after attaching, so a device
 * that was briefly offline receives what it missed, once. Tokens with no
 * live mapping keep their backlog untouched (they may come back).
 */
function drainForDevice(deviceId, write) {
  if (!isValidDeviceId(deviceId) || typeof write !== 'function') return 0;
  const now = Date.now();
  let sent = 0;
  for (const [token, mapped] of tokenIndex.entries()) {
    if (!mapped || mapped.deviceId !== deviceId) continue;
    const entries = backlog.get(token);
    if (!entries || !entries.length) continue;
    pruneBacklog(entries, now);
    for (const entry of entries.splice(0, entries.length)) {
      try {
        write(`data: ${JSON.stringify(Object.assign({ appId: tokenIndex.get(token).appId }, entry.message))}\n\n`);
        sent += 1;
      } catch (_) { break; }
    }
  }
  return sent;
}

/** Test helper — wipe all in-memory state. */
function _reset() {
  streams.clear();
  tokenIndex.clear();
  backlog.clear();
}

module.exports = { subscribe, attachStream, publish, drainForDevice, _reset, isValidPushToken, isValidAppId, isValidDeviceId };
