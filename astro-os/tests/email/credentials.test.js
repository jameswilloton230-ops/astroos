import { describe, it, expect, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ASTROOS_CRED_KEY must exist before the module loads (first encrypt/decrypt
// derives the AES-GCM-SIV key from it via SHA-256).
process.env.ASTROOS_CRED_KEY = 'c'.repeat(64);

const credentials = require('../../email/credentials.js');
const ASTROOS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const CREDS = { type: 'imap', host: 'mail.example.com', port: 993, ssl: true, user: 'alice@example.com', pass: 'secret' };

afterAll(() => {
  // The module starts an unref'd 5-min cleanup tick at load; stop it so the
  // worker tears down cleanly (the exported hook exists for exactly this).
  credentials.stopCredentialCleanup();
});

describe('email/credentials.js — encryptCreds / decryptCreds', () => {
  it('round-trips credentials through AES-GCM-SIV', () => {
    const hex = credentials.encryptCreds(CREDS);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(credentials.decryptCreds(hex)).toEqual(CREDS);
  });

  it('uses a fresh random nonce per call (same plaintext, different ciphertext)', () => {
    const a = credentials.encryptCreds(CREDS);
    const b = credentials.encryptCreds(CREDS);
    expect(a).not.toBe(b);
    expect(credentials.decryptCreds(a)).toEqual(CREDS);
    expect(credentials.decryptCreds(b)).toEqual(CREDS);
  });

  it('rejects a tampered ciphertext (auth tag mismatch)', () => {
    const hex = credentials.encryptCreds(CREDS);
    const chars = hex.split('');
    // flip a byte deep in the ciphertext region (past the 12-byte nonce)
    const idx = 60;
    chars[idx] = chars[idx] === '0' ? '1' : '0';
    expect(() => credentials.decryptCreds(chars.join(''))).toThrow();
  });

  it('rejects a blob too short to contain the nonce with a clear message', () => {
    const short = Buffer.from('aabb', 'hex').toString('hex');
    expect(() => credentials.decryptCreds(short))
      .toThrow('Encrypted credential blob is too short to contain a valid nonce');
  });

  it('derives a stable 32-byte key from ASTROOS_CRED_KEY', () => {
    const k1 = credentials.getCredEncryptKey();
    const k2 = credentials.getCredEncryptKey();
    expect(Buffer.isBuffer(k1)).toBe(true);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('refuses to operate without ASTROOS_CRED_KEY (fresh process)', () => {
    // getCredEncryptKey caches after first success, so the no-env failure path
    // can only be exercised in a fresh process where the key was never derived.
    const script = `
      delete process.env.ASTROOS_CRED_KEY;
      try {
        const creds = require(${JSON.stringify(path.join(ASTROOS_ROOT, 'email/credentials.js'))});
        creds.encryptCreds({ user: 'u', pass: 'p' });
        console.log('NO_THROW');
      } catch (e) {
        console.log('THROWN:' + e.message);
      }
    `;
    const out = execFileSync(process.execPath, ['-e', script], { cwd: ASTROOS_ROOT, encoding: 'utf8' }).trim();
    expect(out.startsWith('THROWN:')).toBe(true);
    expect(out).toContain('ASTROOS_CRED_KEY environment variable not set');
  });
});

describe('email/credentials.js — sessionCredentials guarded Map', () => {
  it('behaves like a Map for get/has/size/entries and for..of', () => {
    const { sessionCredentials } = credentials;
    sessionCredentials.set('sess-a', { creds: CREDS, createdAt: Date.now() });
    expect(sessionCredentials.has('sess-a')).toBe(true);
    expect(sessionCredentials.get('sess-a').creds.user).toBe('alice@example.com');
    expect([...sessionCredentials.keys()]).toContain('sess-a');
    const seen = [];
    for (const [k, v] of sessionCredentials) seen.push([k, v.creds.user]);
    expect(seen).toContainEqual(['sess-a', 'alice@example.com']);
    sessionCredentials.delete('sess-a');
    expect(sessionCredentials.has('sess-a')).toBe(false);
  });

  it(`caps the cache at MAX_CREDENTIAL_CACHE_SIZE (${credentials.MAX_CREDENTIAL_CACHE_SIZE}) by evicting the oldest entry`, () => {
    const { sessionCredentials, MAX_CREDENTIAL_CACHE_SIZE } = credentials;
    sessionCredentials.clear();
    for (let i = 0; i < MAX_CREDENTIAL_CACHE_SIZE; i++) {
      sessionCredentials.set(`s-${i}`, { creds: CREDS, createdAt: i });
    }
    expect(sessionCredentials.size).toBe(MAX_CREDENTIAL_CACHE_SIZE);
    // one more genuinely new key → oldest ("s-0") evicted, size stays capped
    sessionCredentials.set('s-new', { creds: CREDS, createdAt: Date.now() });
    expect(sessionCredentials.size).toBe(MAX_CREDENTIAL_CACHE_SIZE);
    expect(sessionCredentials.has('s-0')).toBe(false);
    expect(sessionCredentials.has('s-new')).toBe(true);
  });

  it('updating an existing key does not evict anything', () => {
    const { sessionCredentials, MAX_CREDENTIAL_CACHE_SIZE } = credentials;
    sessionCredentials.clear();
    for (let i = 0; i < MAX_CREDENTIAL_CACHE_SIZE; i++) {
      sessionCredentials.set(`u-${i}`, { creds: CREDS, createdAt: i });
    }
    const before = sessionCredentials.get('u-0').createdAt;
    sessionCredentials.set('u-0', { creds: CREDS, createdAt: 999999 });
    expect(sessionCredentials.size).toBe(MAX_CREDENTIAL_CACHE_SIZE);
    expect(sessionCredentials.has('u-1')).toBe(true);
    expect(sessionCredentials.get('u-0').createdAt).toBe(999999);
    expect(before).not.toBe(999999);
    sessionCredentials.clear();
  });
});

describe('email/credentials.js — restoreCredsFromSession', () => {
  it('restores plaintext creds from the encrypted session blob and re-registers the session', () => {
    const encrypted = credentials.encryptCreds(CREDS);
    const req = { session: { id: 'sess-restore', emailCredsEncrypted: encrypted } };
    expect(credentials.restoreCredsFromSession(req)).toBe(true);
    expect(req.emailCreds).toEqual(CREDS);
    expect(credentials.sessionCredentials.get('sess-restore').creds.user).toBe('alice@example.com');
    credentials.sessionCredentials.delete('sess-restore');
  });

  it('returns false and leaves req untouched when the blob is undecryptable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = { session: { id: 'sess-bad', emailCredsEncrypted: 'deadbeef'.repeat(20) } };
    expect(credentials.restoreCredsFromSession(req)).toBe(false);
    expect(req.emailCreds).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns false when plaintext creds are already attached to the request', () => {
    const req = { emailCreds: CREDS, session: { id: 'x', emailCredsEncrypted: 'zz' } };
    expect(credentials.restoreCredsFromSession(req)).toBe(false);
    expect(req.emailCreds).toBe(CREDS);
  });

  it('returns false when there is no session at all', () => {
    expect(credentials.restoreCredsFromSession({})).toBe(false);
  });
});

describe('email/credentials.js — requireCreds middleware', () => {
  it('401s with a helpful message when no credentials are present', () => {
    const req = { session: { id: 'sess-none' } };
    const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    const next = vi.fn();
    credentials.requireCreds(req, res, next);
    expect(res.code).toBe(401);
    expect(res.body.error).toContain('POST /api/email/connect');
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() once credentials are available (directly or via restore)', () => {
    const encrypted = credentials.encryptCreds(CREDS);
    const req = { session: { id: 'sess-next', emailCredsEncrypted: encrypted } };
    const res = {};
    const next = vi.fn();
    credentials.requireCreds(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.emailCreds.user).toBe('alice@example.com');
    credentials.sessionCredentials.delete('sess-next');
  });
});
