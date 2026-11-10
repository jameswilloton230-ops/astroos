import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── unrestricted-gate.js — identity gate for nova:system:* calls ────────────
// Plain CJS module (module.exports = { checkUnrestrictedApp, isTrustedSettingsAppById }).
// The gate fetches js/apps/novaapp-manifest.json through global fetch (stubbed
// by tests/setup.js) and consults the global OS registry — both are replaced
// per test. Every deny ladder step is asserted explicitly: this gate is
// fail-closed by design, and these tests pin that shut.

const GATE_PATH = '../../../js/platform/security/unrestricted-gate.js';
let UnrestrictedGate;

// vi.resetModules() does not bust the CJS require() cache in vitest — and the
// gate holds a module-level first-party manifest cache that MUST reset per test.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function manifestResponse(ids, { ok = true } = {}) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ids,
  };
}

// A package that satisfies every single gate condition.
function validSystemApp(overrides = {}) {
  return {
    id: 'com.nbosp.settings',
    system: true,
    verified: true,
    signer: 'NovaByte System',
    source: 'system-bundle',
    manifest: { system: true },
    integrity: { method: 'blake3', fileHashes: { 'index.html': 'abc' } },
    ...overrides,
  };
}

describe('UnrestrictedGate (js/platform/security/unrestricted-gate.js)', () => {
  beforeEach(() => {
    UnrestrictedGate = requireFresh(GATE_PATH);
    globalThis.fetch = vi.fn(async () => manifestResponse([
      { id: 'com.nbosp.settings' },
      { id: 'com.nbosp.email' },
    ]));
    globalThis.OS = { apps: {} };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.OS;
    delete globalThis.AppPackage;
  });

  describe('surface', () => {
    it('exports exactly the documented functions and attaches to window', () => {
      expect(typeof UnrestrictedGate.checkUnrestrictedApp).toBe('function');
      expect(typeof UnrestrictedGate.isTrustedSettingsAppById).toBe('function');
      expect(window.UnrestrictedGate).toBe(UnrestrictedGate);
    });
  });

  describe('isTrustedSettingsAppById — the Settings-only identity bypass', () => {
    it('accepts the real Settings app only when every identity field matches', () => {
      globalThis.OS.apps['com.nbosp.settings'] = {
        system: true,
        verified: true,
        signer: 'NovaByte System',
        manifest: { system: true },
      };
      expect(UnrestrictedGate.isTrustedSettingsAppById('com.nbosp.settings')).toBe(true);
    });

    it('denies any other app id outright — even a legitimately signed system app', () => {
      globalThis.OS.apps['com.nbosp.email'] = {
        system: true,
        verified: true,
        signer: 'NovaByte System',
        manifest: { system: true },
      };
      expect(UnrestrictedGate.isTrustedSettingsAppById('com.nbosp.email')).toBe(false);
      expect(UnrestrictedGate.isTrustedSettingsAppById('com.nbosp.SETTINGS')).toBe(false);
      expect(UnrestrictedGate.isTrustedSettingsAppById('')).toBe(false);
    });

    it('fails closed when any identity field is missing or forged', () => {
      const id = 'com.nbosp.settings';
      const permutations = [
        { system: false, verified: true, signer: 'NovaByte System', manifest: { system: true } },
        { system: true, verified: false, signer: 'NovaByte System', manifest: { system: true } },
        { system: true, verified: true, signer: 'Some Random Dev', manifest: { system: true } },
        { system: true, verified: true, signer: 'NovaByte System', manifest: { system: false } },
        { system: true, verified: true, signer: 'NovaByte System' }, // no manifest
        { verified: true, signer: 'NovaByte System', manifest: { system: true } }, // no system flag
      ];
      for (const entry of permutations) {
        globalThis.OS.apps[id] = entry;
        expect(UnrestrictedGate.isTrustedSettingsAppById(id)).toBe(false);
      }
      // No registry entry at all.
      delete globalThis.OS.apps[id];
      expect(UnrestrictedGate.isTrustedSettingsAppById(id)).toBe(false);
    });
  });

  describe('checkUnrestrictedApp — the full deny ladder', () => {
    it('denies missing or malformed app identity first', async () => {
      expect(await UnrestrictedGate.checkUnrestrictedApp(null)).toEqual({
        allowed: false, reason: 'missing app identity',
      });
      expect(await UnrestrictedGate.checkUnrestrictedApp({})).toEqual({
        allowed: false, reason: 'missing app identity',
      });
      expect(await UnrestrictedGate.checkUnrestrictedApp({ id: 42 })).toEqual({
        allowed: false, reason: 'missing app identity',
      });
    });

    it('denies packages that are not verified NovaByte System packages', async () => {
      const bad = [
        { verified: false },
        { signer: 'NovaByte Trusted Signing' },
        { system: false },
      ].map((overrides) => validSystemApp(overrides));

      for (const app of bad) {
        expect(await UnrestrictedGate.checkUnrestrictedApp(app)).toEqual({
          allowed: false, reason: 'app is not a trusted NovaByte System package',
        });
      }
    });

    it('denies packages not running from the trusted system bundle', async () => {
      const result = await UnrestrictedGate.checkUnrestrictedApp(validSystemApp({ source: 'file' }));
      expect(result).toEqual({ allowed: false, reason: 'package is not running from the trusted system bundle' });
    });

    it('denies packages whose manifest does not mark them as system apps', async () => {
      const result = await UnrestrictedGate.checkUnrestrictedApp(
        validSystemApp({ manifest: { system: false } }),
      );
      expect(result).toEqual({ allowed: false, reason: 'package manifest is not marked as a system app' });
    });

    it('denies ids absent from the build-time first-party manifest', async () => {
      const result = await UnrestrictedGate.checkUnrestrictedApp(
        validSystemApp({ id: 'com.evil.impersonator' }),
      );
      expect(result).toEqual({
        allowed: false,
        reason: 'app id is not present in the build-time first-party manifest',
      });
    });

    it('fails closed when the first-party manifest cannot be fetched', async () => {
      globalThis.fetch = vi.fn(async () => manifestResponse([], { ok: false }));
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await UnrestrictedGate.checkUnrestrictedApp(validSystemApp());
      expect(result).toEqual({
        allowed: false,
        reason: 'app id is not present in the build-time first-party manifest',
      });
      expect(consoleErr).toHaveBeenCalledWith(
        expect.stringContaining('[UnrestrictedGate]'),
        expect.anything(),
      );
    });

    it('denies system packages that carry no integrity record', async () => {
      const { integrity, ...noIntegrity } = validSystemApp();
      const result = await UnrestrictedGate.checkUnrestrictedApp(noIntegrity);
      expect(result).toEqual({ allowed: false, reason: 'system package has no integrity record' });
    });

    it('fails closed when AppPackage.verifyIntegrity is unavailable to re-check integrity', async () => {
      // AppPackage deliberately NOT defined in this test.
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await UnrestrictedGate.checkUnrestrictedApp(validSystemApp());
      expect(result).toEqual({ allowed: false, reason: 'package integrity check failed' });
      expect(consoleErr).toHaveBeenCalledWith(
        expect.stringContaining('failing closed'),
      );
    });

    it('fails closed when the integrity re-check fails or throws at call time', async () => {
      // Case 1: verifyIntegrity returns false (tampered since install).
      globalThis.AppPackage = { verifyIntegrity: vi.fn(async () => false) };
      const tampered = validSystemApp();
      tampered.integrity.fileHashes['index.html'] = 'MODIFIED-ON-DISK';
      expect(await UnrestrictedGate.checkUnrestrictedApp(tampered)).toEqual({
        allowed: false, reason: 'package integrity check failed',
      });

      // Case 2: the re-check itself explodes — still denied, never downgraded.
      UnrestrictedGate = requireFresh(GATE_PATH);
      globalThis.AppPackage = { verifyIntegrity: vi.fn(async () => { throw new Error('hasher unavailable'); }) };
      expect(await UnrestrictedGate.checkUnrestrictedApp(validSystemApp())).toEqual({
        allowed: false, reason: 'package integrity check failed',
      });
    });

    it('allows a fully valid system package (identity + bundle + manifest + first-party + integrity)', async () => {
      globalThis.AppPackage = { verifyIntegrity: vi.fn(async () => true) };
      const result = await UnrestrictedGate.checkUnrestrictedApp(validSystemApp());
      expect(result).toEqual({ allowed: true });
      // The re-verification ran against the live package record at call time.
      expect(globalThis.AppPackage.verifyIntegrity).toHaveBeenCalledWith(validSystemApp());
    });
  });
});
