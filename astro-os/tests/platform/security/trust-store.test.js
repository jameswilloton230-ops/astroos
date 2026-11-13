import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

// ── trust-store.js — root-CA-style signing-authority list + signature revocation
// Plain CJS module (module.exports). In a plain-Node require() the module
// resolves revoked-signatures.json relative to process.cwd() (no
// document.currentScript exists), so every test pins process.cwd() to a temp
// directory. That both isolates the persistence file AND lets us observe the
// real read/write disk behavior.

const TRUST_STORE_PATH = '../../../js/platform/security/trust-store.js';
const REVOCATION_FILE = 'revoked-signatures.json';
const TEST_KEY_PATH = '../../../keys/test-system-key.json';

let tmpDir;
let cwdSpy;
let TrustStore;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

// The trust-store module reads the release-key override from the page's
// <meta name="nova-system-signing-jwk"> tag at load time. These tests run
// in the plain-Node environment (no real document), so the meta tag is
// faked through a minimal document global — exactly the surface the loader
// touches (querySelector + getAttribute).
function withSystemKeyMeta(content, fn) {
  const meta = {
    getAttribute(name) { return name === 'content' ? content : null; },
  };
  const previous = globalThis.document;
  globalThis.document = {
    querySelector(selector) {
      return typeof selector === 'string' && selector.includes('nova-system-signing-jwk') ? meta : null;
    },
  };
  try {
    fn();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

describe('TrustStore (js/platform/security/trust-store.js)', () => {
  beforeEach(() => {
    tmpDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'astroos-truststore-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    TrustStore = requireFresh(TRUST_STORE_PATH);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    nodeFs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('surface', () => {
    it('exposes the documented API and attaches itself to window', () => {
      expect(typeof TrustStore.list).toBe('function');
      expect(typeof TrustStore.add).toBe('function');
      expect(typeof TrustStore.revoke).toBe('function');
      expect(typeof TrustStore.unrevoke).toBe('function');
      expect(typeof TrustStore.isRevoked).toBe('function');
      expect(typeof TrustStore.getRevocation).toBe('function');
      expect(typeof TrustStore.listRevoked).toBe('function');
      expect(typeof TrustStore.systemSignatureTier).toBe('function');
      expect(window.TrustStore).toBe(TrustStore);
    });
  });

  describe('built-in trust entries', () => {
    it('ships the AstroOS signing authorities with their real public keys', () => {
      const entries = TrustStore.list();
      expect(entries).toHaveLength(2);

      expect(entries[0]).toMatchObject({
        name: 'AstroOS Trusted Signing',
        id: 'novabyte-trusted-signing-v1',
        publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY' },
      });
      expect(entries[1]).toMatchObject({
        name: 'Astro System',
        id: 'astro-system-signing-v1',
        publicKey: { kty: 'OKP', crv: 'Ed25519' },
      });
    });

    it('anchors the System entry at the committed AOSP-style test key and reports test-keys (the fresh-clone/fork story)', () => {
      // The 2026-11-12 audit (F1) first rotation deleted the committed key
      // and required env keys, which broke forks. The Android/AOSP model
      // committed a deliberately-public test pair instead: the default
      // anchor must be its public half, so default builds verify as
      // System-signed everywhere. See astro-os/keys/README.md.
      const testKey = JSON.parse(nodeFs.readFileSync(nodePath.resolve(__dirname, TEST_KEY_PATH), 'utf8'));
      const system = TrustStore.list()[1];
      expect(system.publicKey.x).toBe(testKey.x);
      expect(system.tier).toBe('test');
      expect(TrustStore.systemSignatureTier()).toBe('test-keys');
    });

    it('swaps in the server-injected release key (nova-system-signing-jwk meta) and reports release-keys', () => {
      const { generateKeyPairSync } = require('node:crypto');
      const { publicKey } = generateKeyPairSync('ed25519');
      const releaseJwk = publicKey.export({ format: 'jwk' });

      withSystemKeyMeta(JSON.stringify(releaseJwk), () => {
        const rotated = requireFresh(TRUST_STORE_PATH);
        const system = rotated.list()[1];
        expect(system.publicKey.x).toBe(releaseJwk.x);
        expect(system.publicKey.x).not.toBe(
          JSON.parse(nodeFs.readFileSync(nodePath.resolve(__dirname, TEST_KEY_PATH), 'utf8')).x
        );
        expect(system.tier).toBe('release');
        expect(rotated.systemSignatureTier()).toBe('release-keys');
        // The general trusted-signing entry is untouched by the rotation.
        expect(rotated.list()[0].publicKey.x).toBe('Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY');
      });

      // Without the meta (default state) the test key is back.
      const fresh = requireFresh(TRUST_STORE_PATH);
      expect(fresh.systemSignatureTier()).toBe('test-keys');
    });

    it('keeps the default test-key anchor when the injected meta is malformed', () => {
      for (const bad of [
        'not json at all',
        JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'abc' }),
        JSON.stringify({ kty: 'OKP', crv: 'Ed25519' }),
        '',
      ]) {
        withSystemKeyMeta(bad, () => {
          const fresh = requireFresh(TRUST_STORE_PATH);
          expect(fresh.systemSignatureTier()).toBe('test-keys');
          expect(fresh.list()[1].tier).toBe('test');
        });
      }
    });

    it('list() returns a copy of the array — structural tampering cannot touch the store', () => {
      const snapshot = TrustStore.list();
      snapshot.pop();
      expect(TrustStore.list()).toHaveLength(2);

      // SOURCE QUIRK (documented, not fixed): the copy is shallow, so field
      // edits on a returned entry leak into the live store. The array shape
      // itself is protected, which is what add()/revoke() rely on.
      snapshot[0].name = 'forged authority';
      expect(TrustStore.list()[0].name).toBe('forged authority');
    });
  });

  describe('add()', () => {
    it('appends a well-formed authority and logs it', () => {
      const entry = {
        name: 'Partner CA',
        id: 'partner-ca-v1',
        publicKey: { kty: 'EC', crv: 'P-256', x: 'abc' },
      };
      TrustStore.add(entry);
      expect(TrustStore.list()).toHaveLength(3);
      expect(TrustStore.list().at(-1)).toMatchObject({ name: 'Partner CA' });
    });

    it('rejects malformed entries: missing object, blank name, or non-JWK publicKey', () => {
      expect(() => TrustStore.add(null)).toThrow('Trust store entries need at least {name, publicKey}');
      expect(() => TrustStore.add('not an object')).toThrow('Trust store entries need at least {name, publicKey}');
      expect(() => TrustStore.add({ name: '   ', publicKey: { kty: 'OKP' } })).toThrow(
        'Trust store entries need at least {name, publicKey}',
      );
      expect(() => TrustStore.add({ name: 'Broken Key', publicKey: { crv: 'Ed25519' } })).toThrow(
        /doesn't look like a JWK/,
      );
      // Nothing malformed was admitted.
      expect(TrustStore.list()).toHaveLength(2);
    });
  });

  describe('revoke() / isRevoked() — the deny path every install checks', () => {
    it('revokes an exact signature, persists it to disk, and reports it revoked', () => {
      const record = TrustStore.revoke('deadbeef-signature-01', 'malware');
      expect(record).toMatchObject({ signature: 'deadbeef-signature-01', reason: 'malware' });
      expect(typeof record.revokedAt).toBe('number');

      expect(TrustStore.isRevoked('deadbeef-signature-01')).toBe(true);
      expect(TrustStore.getRevocation('deadbeef-signature-01')).toMatchObject({ reason: 'malware' });

      const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(tmpDir, REVOCATION_FILE), 'utf8'));
      expect(onDisk).toEqual([expect.objectContaining({ signature: 'deadbeef-signature-01' })]);
    });

    it('demands the exact signature string', () => {
      expect(() => TrustStore.revoke('')).toThrow('revoke() requires the exact pkg.signature string of the package being revoked');
      expect(() => TrustStore.revoke(null)).toThrow('revoke() requires the exact pkg.signature string of the package being revoked');
      expect(() => TrustStore.revoke(12345)).toThrow('revoke() requires the exact pkg.signature string of the package being revoked');
      expect(TrustStore.listRevoked()).toHaveLength(0);
    });

    it('is idempotent: re-revoking updates the record instead of duplicating it', () => {
      const first = TrustStore.revoke('sig-dup', 'first reason');
      const second = TrustStore.revoke('sig-dup', 'second reason');
      expect(TrustStore.listRevoked()).toHaveLength(1);
      expect(second.reason).toBe('second reason');
      expect(second.revokedAt).toBeGreaterThanOrEqual(first.revokedAt);
    });

    it('un-revoking restores trust and rewrites the persistence file', () => {
      TrustStore.revoke('sig-undo', 'mistake');
      expect(TrustStore.isRevoked('sig-undo')).toBe(true);

      expect(TrustStore.unrevoke('sig-undo')).toBe(true);
      expect(TrustStore.isRevoked('sig-undo')).toBe(false);
      expect(TrustStore.getRevocation('sig-undo')).toBeNull();
      const onDisk = JSON.parse(nodeFs.readFileSync(nodePath.join(tmpDir, REVOCATION_FILE), 'utf8'));
      expect(onDisk).toHaveLength(0);

      expect(TrustStore.unrevoke('never-revoked')).toBe(false);
    });

    it('falsy lookups are simply not revoked (no throw)', () => {
      expect(TrustStore.isRevoked('')).toBe(false);
      expect(TrustStore.isRevoked(null)).toBe(false);
      expect(TrustStore.getRevocation('')).toBeNull();
      expect(TrustStore.getRevocation(null)).toBeNull();
    });
  });

  describe('persistence across restarts', () => {
    it('loads a pre-existing revoked-signatures.json at module init', () => {
      nodeFs.writeFileSync(
        nodePath.join(tmpDir, REVOCATION_FILE),
        JSON.stringify([{ signature: 'SIG-XYZ', reason: 'bad app', revokedAt: 1700000000000 }]),
      );
      vi.resetModules();
      const fresh = requireFresh(TRUST_STORE_PATH);

      // Revocation must take effect immediately, without any in-session revoke().
      expect(fresh.isRevoked('SIG-XYZ')).toBe(true);
      expect(fresh.getRevocation('SIG-XYZ')).toEqual({
        signature: 'SIG-XYZ', reason: 'bad app', revokedAt: 1700000000000,
      });
      expect(fresh.isRevoked('SIG-other')).toBe(false);
    });

    it('starts with an empty revocation list when the file does not exist yet', () => {
      expect(TrustStore.listRevoked()).toEqual([]);
      expect(TrustStore.isRevoked('anything')).toBe(false);
    });

    it('keeps other packages trusted when one signature is revoked (narrow revocation)', () => {
      TrustStore.revoke('sig-bad-app', 'turned out bad');
      // The signing key itself and every other signature remain trusted:
      // the built-in authorities are untouched and unrelated signatures
      // are unaffected.
      expect(TrustStore.list()).toHaveLength(2);
      expect(TrustStore.isRevoked('sig-bad-app')).toBe(true);
      expect(TrustStore.isRevoked('sig-other-package-same-key')).toBe(false);
    });
  });
});
