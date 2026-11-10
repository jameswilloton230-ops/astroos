'use strict';

const crypto = require('crypto');
const { gcmsiv } = require('@noble/ciphers/aes.js');
const { randomBytes: nobleRandomBytes } = require('@noble/ciphers/utils.js');

// Session-based persistent credential storage (encrypted)
// Stores credentials server-side so they survive session expiry, using the
// session store to persist across browser page reloads / app restarts.
// This is more secure than storing in localStorage, which XSS can read.

// GCM-SIV nonce length in bytes (96-bit nonce per RFC 8452)
const NONCE_LENGTH = 12;

// Cap on total tracked sessions — declared here, before the Map that uses
// it, even though the original ordering (declared after) technically also
// worked: the guarded .set() below only reads this the first time a request
// handler actually calls .set(), which is always after module load has
// fully finished. Still, "referenced above its declaration" reads as a bug
// even when it isn't one, so it's not worth leaving that way.
const MAX_CREDENTIAL_CACHE_SIZE = 1000;

// In-memory registry of accounts per session (backed by the session store)
// Structure: sessionId -> { creds: { type, host, port, ssl, user, pass }, createdAt }
//
// This is a Map wrapped in a Proxy so the MAX_CREDENTIAL_CACHE_SIZE cap is
// enforced on every .set() call, not just on the 5-minute cleanup tick —
// and enforced no matter which module calls .set(), since controller.js
// currently calls sessionCredentials.set(...) directly in three places
// rather than going through a setter exported from here. Wrapping the Map
// itself means those call sites get the cap for free without needing to
// change what they call.
//
// Every other Map method (get/has/delete/entries/keys/values/size, plus
// for..of iteration) passes through untouched. Note the explicit .bind(t)
// below: Map's prototype methods check that `this` is a real Map instance,
// so pulling a method off the target through a Proxy's get trap and
// calling it unbound throws "Method Map.prototype.X called on incompatible
// receiver" — this bit us in testing before the .bind was added, so it's
// not optional.
//
// Note: this is still an in-memory store. It does not survive a process
// restart and is not shared across multiple Node instances (cluster mode,
// multiple containers). If that's ever needed, this needs a shared store
// (Redis etc) instead — that's a bigger change than this file's scope covers.
function createGuardedSessionCredentials() {
  const target = new Map();

  function evictOldest() {
    // Map iteration order is insertion order, so the first key the
    // iterator yields really is the oldest live entry — as long as
    // updating an existing key doesn't shuffle its position, which it
    // doesn't (re-setting a key updates its value in place, it doesn't
    // move it to the end).
    const oldestKey = target.keys().next().value;
    if (oldestKey !== undefined) target.delete(oldestKey);
  }

  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'set') {
        return function guardedSet(key, value) {
          // Only counts as growth if this is a genuinely new key — updating
          // an existing session's entry shouldn't evict an unrelated one.
          if (!t.has(key) && t.size >= MAX_CREDENTIAL_CACHE_SIZE) {
            evictOldest();
          }
          return t.set(key, value);
        };
      }
      const value = Reflect.get(t, prop, t);
      return typeof value === 'function' ? value.bind(t) : value;
    }
  });
}

const sessionCredentials = createGuardedSessionCredentials();

// Encryption key for credential storage — MUST be set via environment
let credEncryptKey = null;

function getCredEncryptKey() {
  if (!credEncryptKey) {
    const seed = process.env.NBOSP_CRED_KEY;
    if (!seed) {
      const msg = '[Email] CRITICAL: NBOSP_CRED_KEY environment variable not set. Email credential persistence disabled for security.';
      console.error(msg);
      throw new Error(msg);
    }
    credEncryptKey = crypto.createHash('sha256').update(seed).digest();
  }
  return credEncryptKey;
}

function encryptCreds(creds) {
  const key = getCredEncryptKey();
  // AES-GCM-SIV is nonce-misuse-resistant — a repeated random nonce here
  // would only reveal that the same plaintext was encrypted twice, not
  // leak the key or any other plaintext, so a fresh random nonce per call
  // is the right call and doesn't need a counter or dedup check.
  const nonce = nobleRandomBytes(NONCE_LENGTH);
  const cipher = gcmsiv(key, nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(creds));
  const encrypted = cipher.encrypt(plaintext);

  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('hex');
}

function decryptCreds(encryptedHex) {
  const key = getCredEncryptKey();
  const combined = Buffer.from(encryptedHex, 'hex');

  // Buffer.from(str, 'hex') doesn't throw on malformed input — it just
  // truncates at the first invalid byte pair, so a corrupted or too-short
  // stored blob would otherwise fail deep inside gcmsiv's auth check with
  // a generic decrypt-failure message. Check the length explicitly so a
  // bad blob fails with a clear reason instead.
  if (combined.length < NONCE_LENGTH) {
    throw new Error('Encrypted credential blob is too short to contain a valid nonce');
  }

  const nonce = combined.subarray(0, NONCE_LENGTH);
  const ciphertext = combined.subarray(NONCE_LENGTH);
  const decipher = gcmsiv(key, nonce);
  const plaintext = decipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// Session cleanup: remove expired entries from the credential registry.
// (MAX_CREDENTIAL_CACHE_SIZE lives near the top of the file now, since it's
// used by the guarded Map above as well as by the cleanup tick below.)
const CREDENTIAL_MAX_AGE_MS = 86400000; // 24 hours
const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

let cleanupInterval = null;

function startCredentialCleanup() {
  if (cleanupInterval) return; // already running

  cleanupInterval = setInterval(() => {
    // The size cap is enforced on every .set() now (see the Proxy above),
    // so this tick only needs to handle age-based expiry — entries that
    // are stale but haven't been evicted by the cap because the Map never
    // got that large.
    const cutoff = Date.now() - CREDENTIAL_MAX_AGE_MS;
    for (const [sessionId, entry] of sessionCredentials.entries()) {
      if (entry.createdAt && entry.createdAt < cutoff) {
        sessionCredentials.delete(sessionId);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Don't let this timer keep the process (or a test runner) alive on its
  // own — it's background maintenance, not something that should block exit.
  cleanupInterval.unref();
}

// Exposed so tests can tear this down cleanly instead of needing --forceExit.
function stopCredentialCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

startCredentialCleanup();

function restoreCredsFromSession(req) {
  // req.emailCreds is request-scoped, not req.session.emailCreds — the
  // plaintext never touches the session object, so it never gets
  // serialized to disk by the session store. Only emailCredsEncrypted
  // (the ciphertext) is durable.
  if (!req.emailCreds && req.session?.emailCredsEncrypted) {
    try {
      const creds = decryptCreds(req.session.emailCredsEncrypted);
      req.emailCreds = creds;
      if (req.session.id) {
        sessionCredentials.set(req.session.id, { creds, createdAt: Date.now() });
      }
      return true;
    } catch (e) {
      console.warn('[Email] Failed to decrypt restored credentials:', e.message);
      return false;
    }
  }
  return false;
}

function requireCreds(req, res, next) {
  restoreCredsFromSession(req);

  if (!req.emailCreds) {
    return res.status(401).json({ error: 'Not connected. POST /api/email/connect first.' });
  }
  next();
}

module.exports = {
  encryptCreds,
  decryptCreds,
  sessionCredentials,
  getCredEncryptKey,
  restoreCredsFromSession,
  requireCreds,
  stopCredentialCleanup,
  MAX_CREDENTIAL_CACHE_SIZE
};