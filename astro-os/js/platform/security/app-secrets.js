/**
 * AstroOS — App Secrets Store
 *
 * Per-app encrypted key/value storage for small secrets (tokens, passwords,
 * API keys). AES-256-GCM at rest under a per-install master key; plaintext
 * never touches disk. Deliberately a SEPARATE store from nova:storage:* so
 * data:export / data:backup envelopes can never silently carry credentials
 * — an app's secrets simply are not part of its portable namespace.
 *
 * Threat model, stated honestly:
 *  - Protects secrets at rest against another app reading the disk store
 *    and against casual filesystem access (blobs are ciphertext only).
 *  - Does NOT protect against a compromised host: the OS process holds the
 *    master key and the plaintext lives in host memory while in use. This
 *    is app-isolation hygiene, not a hardware vault.
 *  - The master key persists at <root>/app-secrets.key (0600, dir 0700).
 *    If the filesystem refuses, the store degrades to session-only memory
 *    (secrets vanish on reboot) rather than failing every call.
 *
 * Budgets (authoritative, handler + module enforced): 64 secrets per app,
 * 8 KB per value, 128-character keys.
 *
 * @module js/platform/security/app-secrets
 */

const AppSecrets = (() => {
  'use strict';

  let fsMod = null;
  let pathMod = null;
  let cryptoMod = null;
  try {
    fsMod = require('fs');
    pathMod = require('path');
    cryptoMod = require('crypto');
  } catch (_) { /* non-Node environment — memory-only degraded mode */ }

  const MAX_PER_APP = 64;
  const MAX_VALUE_BYTES = 8 * 1024;
  const MAX_KEY_LEN = 128;
  let memoryStore = null;

  // Test/override hook: the default location is the OS install's root/
  // area (the same protected directory root-broker and the boot scripts
  // use — untracked, never shipped with the repo).
  function rootDir() {
    return (process.env && process.env.NOVA_SECRETS_DIR) || (pathMod && pathMod.join(process.cwd(), 'root'));
  }

  // Ephemeral fallback key — used only when the master key cannot be
  // persisted. Secrets then live until reboot and are flagged by
  // persistentKey() === false so the UI can say so honestly.
  let ephemeralKey = null;
  let masterKeyCache = null;
  let masterKeyPersistent = false;

  function getMasterKey() {
    if (masterKeyCache) return masterKeyCache;
    if (!fsMod || !pathMod || !cryptoMod) {
      if (!ephemeralKey) ephemeralKey = cryptoMod ? cryptoMod.randomBytes(32) : null;
      masterKeyPersistent = false;
      masterKeyCache = ephemeralKey;
      return masterKeyCache;
    }
    try {
      const dir = rootDir();
      const keyFile = pathMod.join(dir, 'app-secrets.key');
      try {
        const existing = fsMod.readFileSync(keyFile);
        if (existing && existing.length === 32) {
          masterKeyCache = existing;
          masterKeyPersistent = true;
          return masterKeyCache;
        }
      } catch (_) { /* first boot — create below */ }
      fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const key = cryptoMod.randomBytes(32);
      fsMod.writeFileSync(keyFile, key, { mode: 0o600 });
      try { fsMod.chmodSync(keyFile, 0o600); } catch (_) { /* best-effort on platforms without modes */ }
      masterKeyCache = key;
      masterKeyPersistent = true;
      return masterKeyCache;
    } catch (_) {
      if (!ephemeralKey) ephemeralKey = cryptoMod.randomBytes(32);
      masterKeyPersistent = false;
      masterKeyCache = ephemeralKey;
      return masterKeyCache;
    }
  }

  function validSecretKey(key) {
    return typeof key === 'string'
      && key.length >= 1
      && key.length <= MAX_KEY_LEN
      && !/[\x00-\x1f\x7f]/.test(key)
      && key === key.trim();
  }

  function loadStore() {
    if (memoryStore) return memoryStore;
    if (!fsMod || !pathMod) return { version: 1, apps: {} };
    try {
      const raw = fsMod.readFileSync(pathMod.join(rootDir(), 'app-secrets.json'), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.apps && typeof parsed.apps === 'object') return parsed;
    } catch (_) { /* absent or corrupt — start clean */ }
    return { version: 1, apps: {} };
  }

  function saveStore(state) {
    if (!fsMod || !pathMod || !getMasterKey() || !masterKeyPersistent) {
      memoryStore = state;
      return false;
    }
    try {
      const dir = rootDir();
      try { fsMod.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) { /* may already exist */ }
      fsMod.writeFileSync(pathMod.join(dir, 'app-secrets.json'), JSON.stringify(state), { mode: 0o600 });
      memoryStore = null;
      return true;
    } catch (_) {
      memoryStore = state;
      return false;
    }
  }

  function encrypt(utf8Value) {
    const key = getMasterKey();
    const iv = cryptoMod.randomBytes(12);
    const cipher = cryptoMod.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(utf8Value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: iv.toString('base64'), tag: tag.toString('base64'), data: data.toString('base64') };
  }

  function decrypt(record) {
    try {
      const key = getMasterKey();
      const decipher = cryptoMod.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]);
      return plain.toString('utf8');
    } catch (_) {
      // Wrong key (reinstalled OS), tampered blob, or corrupt record — a
      // secret that cannot be authenticated is NOT returned, by design.
      return null;
    }
  }

  function utf8Len(value) {
    try { return Buffer.byteLength(String(value), 'utf8'); } catch (_) { return String(value).length; }
  }

  /**
   * Store a secret. Returns { ok: true } or { ok: false, code, message }.
   */
  function set(appId, key, value) {
    if (!validSecretKey(key)) return { ok: false, code: 'INVALID_ARGS', message: 'secret key must be 1-128 characters with no control characters' };
    if (typeof value !== 'string') return { ok: false, code: 'INVALID_ARGS', message: 'secret value must be a string' };
    if (utf8Len(value) > MAX_VALUE_BYTES) return { ok: false, code: 'INVALID_ARGS', message: `secret value is limited to ${MAX_VALUE_BYTES} bytes` };
    if (typeof appId !== 'string' || !appId || appId.includes(':')) return { ok: false, code: 'INVALID_ARGS', message: 'invalid appId' };

    const state = loadStore();
    const record = state.apps[appId] || (state.apps[appId] = {});
    const replacing = Object.prototype.hasOwnProperty.call(record, key);
    if (!replacing && Object.keys(record).length >= MAX_PER_APP) {
      return { ok: false, code: 'RATE_LIMITED', message: `Max ${MAX_PER_APP} secrets per app` };
    }
    record[key] = Object.assign(encrypt(value), { ts: Date.now() });
    const saved = saveStore(state);
    if (!saved) {
      memoryStore = state;
      // Keep the in-memory copy available for the rest of this session.
      return { ok: true, persisted: false };
    }
    return { ok: true, persisted: true };
  }

  /**
   * Read a secret. Returns the plaintext string, or null when absent or
   * unauthenticated (wrong key / tampered blob).
   */
  function get(appId, key) {
    if (typeof appId !== 'string' || !appId || !validSecretKey(key)) return null;
    const state = loadStore();
    const record = state.apps[appId];
    const blob = record ? record[key] : null;
    if (!blob || typeof blob !== 'object') return null;
    return decrypt(blob);
  }

  /**
   * Delete a secret. Returns true when something was deleted.
   */
  function del(appId, key) {
    if (typeof appId !== 'string' || !appId || !validSecretKey(key)) return false;
    const state = loadStore();
    const record = state.apps[appId];
    if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return false;
    delete record[key];
    saveStore(state);
    return true;
  }

  /**
   * List this app's own secret key names. Names are not sensitive (they
   * are labels the app itself chose), values are never included.
   */
  function keys(appId) {
    if (typeof appId !== 'string' || !appId) return [];
    const state = loadStore();
    const record = state.apps[appId];
    return record ? Object.keys(record).sort() : [];
  }

  function count(appId) {
    return keys(appId).length;
  }

  /** Whether the master key is persisted (false = session-only secrets). */
  function persistentKey() {
    getMasterKey();
    return masterKeyPersistent;
  }

  // Internal exports for testing and the Settings dashboard. Not covered
  // by stability guarantees.
  function _resetForTests() {
    masterKeyCache = null;
    ephemeralKey = null;
    masterKeyPersistent = false;
    memoryStore = null;
  }

  return {
    set, get, del, keys, count, persistentKey,
    MAX_PER_APP, MAX_VALUE_BYTES, MAX_KEY_LEN,
    _resetForTests,
    _internal: { loadStore, saveStore, getMasterKey, validSecretKey, rootDir },
  };
})();

if (typeof window !== 'undefined') {
  window.AppSecrets = AppSecrets;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSecrets;
}
