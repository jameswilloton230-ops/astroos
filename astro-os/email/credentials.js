'use strict';
const crypto = require('crypto');
const { gcmsiv } = require('@noble/ciphers/aes.js');
const { randomBytes: nobleRandomBytes } = require('@noble/ciphers/utils.js');

// ── Session-based persistent credential storage (encrypted) ────────────────────
// Stores credentials server-side so they survive session expiry.
// Uses the session store to persist across browser page reloads/app closes.
// This is more secure than storing in localStorage (which XSS can read).
const fs = require('fs');

// In-memory registry of accounts per session (backed by session store)
// Structure: sessionId → { id, type, host, port, ssl, user, pass }[]
const sessionCredentials = new Map();

// Encryption key for credential storage — MUST be set via environment
let CRED_ENCRYPT_KEY = null;
function getCredEncryptKey() {
  if (!CRED_ENCRYPT_KEY) {
    const seed = process.env.NBOSP_CRED_KEY;
    if (!seed) {
      const msg = '[Email] CRITICAL: NBOSP_CRED_KEY environment variable not set. Email credential persistence disabled for security.';
      console.error(msg);
      throw new Error(msg);
    }
    CRED_ENCRYPT_KEY = crypto.createHash('sha256').update(seed).digest();
  }
  return CRED_ENCRYPT_KEY;
}

function encryptCreds(creds) {
  const key = getCredEncryptKey();
  const nonce = nobleRandomBytes(12);
  const cipher = gcmsiv(key, nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(creds));
  const encrypted = cipher.encrypt(plaintext);
  // Prepend nonce to ciphertext for decryption
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString('hex');
}

function decryptCreds(encryptedHex) {
  const key = getCredEncryptKey();
  const combined = Buffer.from(encryptedHex, 'hex');
  const nonce = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decipher = gcmsiv(key, nonce);
  const plaintext = decipher.decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// Session cleanup: remove expired session entries from credential registry
// Also implements LRU cap to prevent unbounded growth (M1)
const MAX_CREDENTIAL_CACHE_SIZE = 1000;
let cleanupInterval = null;

function startCredentialCleanup() {
  if (cleanupInterval) return; // Already running
  cleanupInterval = setInterval(() => {
    // Cleanup entries older than 24 hours
    const cutoff = Date.now() - 86400000;
    for (const [sessionId, entry] of sessionCredentials.entries()) {
      if (entry.createdAt && entry.createdAt < cutoff) {
        sessionCredentials.delete(sessionId);
      }
    }
    // If still over limit, evict oldest (LRU)
    if (sessionCredentials.size > MAX_CREDENTIAL_CACHE_SIZE) {
      const toEvict = sessionCredentials.size - MAX_CREDENTIAL_CACHE_SIZE + 100;
      let evicted = 0;
      for (const [sessionId, entry] of sessionCredentials.entries()) {
        if (evicted >= toEvict) break;
        sessionCredentials.delete(sessionId);
        evicted++;
      }
    }
  }, 300000); // Run every 5 minutes
}

startCredentialCleanup();


function restoreCredsFromSession(req) {
  // Try to restore from persistent storage if session creds are missing.
  // Note: req.emailCreds is request-scoped, not req.session.emailCreds —
  // the plaintext never touches the session object, so it never gets
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
  // Try to restore from persistent storage if session creds are missing
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
  MAX_CREDENTIAL_CACHE_SIZE
};