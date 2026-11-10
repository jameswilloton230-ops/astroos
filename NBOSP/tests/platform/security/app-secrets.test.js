import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

// ── app-secrets.js — per-app AES-256-GCM secret store ───────────────────────
// Plain CJS module (module.exports). The store's location is redirected to a
// temp dir via the source's own NOVA_SECRETS_DIR override hook, so the real
// filesystem persistence paths (master key file + app-secrets.json) run
// without touching the repo or the user profile.

const APP_SECRETS_PATH = '../../../js/platform/security/app-secrets.js';

let secretsDir;
let AppSecrets;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

describe('AppSecrets (js/platform/security/app-secrets.js)', () => {
  beforeEach(() => {
    secretsDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nbosp-secrets-'));
    process.env.NOVA_SECRETS_DIR = secretsDir;
    AppSecrets = requireFresh(APP_SECRETS_PATH);
  });

  afterEach(() => {
    delete process.env.NOVA_SECRETS_DIR;
    nodeFs.rmSync(secretsDir, { recursive: true, force: true });
  });

  describe('surface', () => {
    it('exposes the documented API, budgets and test hooks', () => {
      expect(typeof AppSecrets.set).toBe('function');
      expect(typeof AppSecrets.get).toBe('function');
      expect(typeof AppSecrets.del).toBe('function');
      expect(typeof AppSecrets.keys).toBe('function');
      expect(typeof AppSecrets.count).toBe('function');
      expect(typeof AppSecrets.persistentKey).toBe('function');
      expect(AppSecrets.MAX_PER_APP).toBe(64);
      expect(AppSecrets.MAX_VALUE_BYTES).toBe(8 * 1024);
      expect(AppSecrets.MAX_KEY_LEN).toBe(128);
      expect(typeof AppSecrets._resetForTests).toBe('function');
      expect(typeof AppSecrets._internal.getMasterKey).toBe('function');
      expect(typeof AppSecrets._internal.validSecretKey).toBe('function');
      // Also attached to window for script-tag consumers.
      expect(window.AppSecrets).toBe(AppSecrets);
    });
  });

  describe('set / get / del / keys round-trip', () => {
    it('stores a secret encrypted at rest and reads it back as plaintext', () => {
      const res = AppSecrets.set('com.example.mail', 'imap_token', 'hunter2-super-secret');
      expect(res).toEqual({ ok: true, persisted: true });

      expect(AppSecrets.get('com.example.mail', 'imap_token')).toBe('hunter2-super-secret');
      expect(AppSecrets.keys('com.example.mail')).toEqual(['imap_token']);
      expect(AppSecrets.count('com.example.mail')).toBe(1);

      // Ciphertext-at-rest guarantee: the plaintext must never appear in the
      // JSON store file.
      const raw = nodeFs.readFileSync(nodePath.join(secretsDir, 'app-secrets.json'), 'utf8');
      expect(raw).not.toContain('hunter2-super-secret');
      const store = JSON.parse(raw);
      const blob = store.apps['com.example.mail'].imap_token;
      expect(blob.iv).toBeTypeOf('string');
      expect(blob.tag).toBeTypeOf('string');
      expect(blob.data).toBeTypeOf('string');
      expect(typeof blob.ts).toBe('number');
    });

    it('keeps the master key in a 32-byte file and reports the key as persistent', () => {
      AppSecrets.set('com.example.mail', 'pw', 'x');
      const keyFile = nodePath.join(secretsDir, 'app-secrets.key');
      expect(nodeFs.existsSync(keyFile)).toBe(true);
      expect(nodeFs.readFileSync(keyFile)).toHaveLength(32);
      expect(AppSecrets.persistentKey()).toBe(true);
    });

    it('keeps secrets readable and listable for the session when disk persistence fails', () => {
      const writeSpy = vi.spyOn(nodeFs, 'writeFileSync').mockImplementation(() => {
        throw new Error('simulated read-only filesystem');
      });

      try {
        expect(AppSecrets.set('com.example.mail', 'pw', 'session-only')).toEqual({
          ok: true,
          persisted: false,
        });
        expect(AppSecrets.persistentKey()).toBe(false);
        expect(AppSecrets.get('com.example.mail', 'pw')).toBe('session-only');
        expect(AppSecrets.keys('com.example.mail')).toEqual(['pw']);

        expect(AppSecrets.del('com.example.mail', 'pw')).toBe(true);
        expect(AppSecrets.get('com.example.mail', 'pw')).toBeNull();
        expect(AppSecrets.keys('com.example.mail')).toEqual([]);
      } finally {
        writeSpy.mockRestore();
      }
    });

    it('survives a reboot: a fresh module instance re-loads the key from disk and decrypts old records', () => {
      AppSecrets.set('com.example.mail', 'pw', 'after-reboot');
      // A reboot is exactly "module state gone, disk state remains": the fresh
      // instance must recover the persisted master key, not mint a new one.
      const fresh = requireFresh(APP_SECRETS_PATH);
      expect(fresh.get('com.example.mail', 'pw')).toBe('after-reboot');
    });

    it('deletes secrets and reports honest results for repeat / missing deletes', () => {
      AppSecrets.set('com.a', 'k', 'v');
      expect(AppSecrets.del('com.a', 'k')).toBe(true);
      expect(AppSecrets.get('com.a', 'k')).toBeNull();
      expect(AppSecrets.del('com.a', 'k')).toBe(false);
      expect(AppSecrets.del('com.a', 'never-existed')).toBe(false);
    });

    it('returns keys sorted and never exposes other apps\' values', () => {
      AppSecrets.set('com.a', 'zeta', '1');
      AppSecrets.set('com.a', 'alpha', '2');
      AppSecrets.set('com.b', 'alpha', '3');
      expect(AppSecrets.keys('com.a')).toEqual(['alpha', 'zeta']);
      // Same key name in another app is a different secret.
      expect(AppSecrets.get('com.a', 'alpha')).toBe('2');
      expect(AppSecrets.get('com.b', 'alpha')).toBe('3');
      expect(AppSecrets.get('com.missing', 'alpha')).toBeNull();
    });
  });

  describe('input validation (deny paths)', () => {
    it.each([
      ['empty key', '', 'v'],
      ['129-char key', 'k'.repeat(129), 'v'],
      ['untrimmed key', ' padded', 'v'],
      ['control char in key', 'bad\nkey', 'v'],
    ])('rejects %s with INVALID_ARGS', (_label, key, value) => {
      expect(AppSecrets.set('com.a', key, value)).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    });

    it.each([
      ['number value', 42],
      ['object value', { nested: true }],
      ['null value', null],
    ])('rejects non-string %s', (_label, value) => {
      expect(AppSecrets.set('com.a', 'k', value)).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    });

    it('enforces the 8 KB per-value UTF-8 byte budget (multi-byte aware)', () => {
      const exactly8k = 'é'.repeat(4096); // 4096 × 2 bytes = 8192
      expect(AppSecrets.set('com.a', 'big', exactly8k)).toMatchObject({ ok: true });
      expect(AppSecrets.set('com.a', 'too-big', 'é'.repeat(4097))).toMatchObject({
        ok: false, code: 'INVALID_ARGS', message: expect.stringContaining('8192 bytes'),
      });
    });

    it('rejects invalid appIds (empty, colon-carrying, non-string)', () => {
      expect(AppSecrets.set('', 'k', 'v')).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
      expect(AppSecrets.set('com:bad', 'k', 'v')).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
      expect(AppSecrets.set(42, 'k', 'v')).toMatchObject({ ok: false, code: 'INVALID_ARGS' });
    });

    it('reads of absent/invalid inputs return null instead of throwing', () => {
      expect(AppSecrets.get('com.a', 'missing')).toBeNull();
      expect(AppSecrets.get('', 'k')).toBeNull();
      expect(AppSecrets.get('com.a', 42)).toBeNull();
      expect(AppSecrets.get('com.a', 'x'.repeat(129))).toBeNull();
    });
  });

  describe('budget enforcement', () => {
    it('caps an app at 64 secrets but still allows replacing an existing key at the cap', () => {
      for (let i = 0; i < AppSecrets.MAX_PER_APP; i++) {
        expect(AppSecrets.set('com.bulk', `key_${i}`, `v${i}`).ok).toBe(true);
      }
      expect(AppSecrets.count('com.bulk')).toBe(64);

      const overflow = AppSecrets.set('com.bulk', 'key_64', 'one too many');
      expect(overflow).toMatchObject({ ok: false, code: 'RATE_LIMITED', message: expect.stringContaining('Max 64') });

      // Replacing an existing secret at the cap is not a new secret.
      expect(AppSecrets.set('com.bulk', 'key_0', 'replaced value')).toEqual({ ok: true, persisted: true });
      expect(AppSecrets.get('com.bulk', 'key_0')).toBe('replaced value');
      expect(AppSecrets.count('com.bulk')).toBe(64);
    });

    it('tracks the per-app budget independently across apps', () => {
      for (let i = 0; i < 64; i++) AppSecrets.set('com.full', `k${i}`, 'v');
      expect(AppSecrets.set('com.full', 'one-more', 'v')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
      // A different app starts from its own empty budget.
      expect(AppSecrets.set('com.other', 'k0', 'v')).toEqual({ ok: true, persisted: true });
    });
  });

  describe('tamper resistance (AES-256-GCM auth)', () => {
    it('refuses to return a secret whose ciphertext was modified on disk', () => {
      AppSecrets.set('com.a', 'token', 'sensitive-value');

      const storePath = nodePath.join(secretsDir, 'app-secrets.json');
      const store = JSON.parse(nodeFs.readFileSync(storePath, 'utf8'));
      // Flip the ciphertext blob (still valid base64) — simulates tampering.
      store.apps['com.a'].token.data = 'AAAA';
      nodeFs.writeFileSync(storePath, JSON.stringify(store));

      // A secret that cannot be authenticated is NOT returned — by design.
      expect(AppSecrets.get('com.a', 'token')).toBeNull();
    });

    it('refuses to return a secret when the auth tag is corrupted', () => {
      AppSecrets.set('com.a', 'token', 'sensitive-value');
      const storePath = nodePath.join(secretsDir, 'app-secrets.json');
      const store = JSON.parse(nodeFs.readFileSync(storePath, 'utf8'));
      store.apps['com.a'].token.tag = 'AAAA';
      nodeFs.writeFileSync(storePath, JSON.stringify(store));
      expect(AppSecrets.get('com.a', 'token')).toBeNull();
    });
  });
});
