import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const nobleHashesMock = {
  blake3: (data) => {
    if (typeof data === 'string') data = new TextEncoder().encode(data);
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = (data[i] + 1) % 256;
    return bytes;
  },
};

describe('AppPackage (js/platform/core/app-package.js)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock('@noble/hashes', () => nobleHashesMock);
    globalThis.AppRegistry = {
      getApp: vi.fn(() => null),
      registerApp: vi.fn((config) => config),
      unregisterApp: vi.fn(() => false),
    };
    globalThis.crypto = {
      randomUUID: () => 'test-uuid',
      getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = (Math.random() * 256) | 0; return arr; },
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        sign: vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xAB)),
        verify: vi.fn().mockResolvedValue(true),
        generateKey: vi.fn().mockResolvedValue({
          publicKey: { type: 'public', algorithm: { name: 'Ed25519' } },
          privateKey: { type: 'private', algorithm: { name: 'Ed25519' } },
        }),
        // Input-dependent digest: a constant mock made every hash identical,
        // so integrity checks could never detect tampering and the
        // "rejects tampered file content" assertions always failed. This
        // folds the input into a deterministic 32-byte digest instead —
        // same bytes in, same hash out; different bytes, different hash.
        digest: vi.fn(async (_algo, data) => {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          const out = new Uint8Array(32);
          for (let i = 0; i < bytes.length; i++) out[i % 32] = (out[i % 32] ^ bytes[i]) & 0xFF;
          out[31] = (out[31] ^ bytes.length) & 0xFF;
          return out.buffer;
        }),
      },
    };
  });

  const validManifest = {
    id: 'com.test.app',
    name: 'Test App',
    version: '1.0.0',
    entry: 'index.html',
  };

  describe('validateManifest', () => {
    it('returns valid for a correct manifest', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      const result = validateManifest(validManifest);
      expect(result.valid).toBe(true);
    });

    it('accepts well-formed file handler declarations and rejects malformed ones', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      expect(validateManifest({
        ...validManifest,
        handles: { protocols: ['https:'], extensions: ['.md'], mimeTypes: ['text/markdown', 'image/*'] },
      }).valid).toBe(true);
      const invalid = validateManifest({
        ...validManifest,
        handles: { extensions: ['md'], mimeTypes: ['image/*/extra'], unexpected: [] },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toEqual(expect.arrayContaining([
        'handles.unexpected is not supported',
        'handles.extensions[0] is invalid',
        'handles.mimeTypes[0] is invalid',
      ]));
    });

    it('accepts valid app IPC declarations and rejects unsupported or malformed exports', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      expect(validateManifest({
        ...validManifest,
        ipc: {
          exports: ['service:com.example.clock.current', 'provider:com.example.contacts.lookup'],
          receives: ['com.example.notes.changed'],
        },
      }).valid).toBe(true);
      const invalid = validateManifest({
        ...validManifest,
        ipc: {
          exports: ['service:../escape', 'unknown:endpoint'],
          receives: ['BAD ACTION'],
          unexpected: [],
        },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors).toEqual(expect.arrayContaining([
        'ipc.unexpected is not supported',
        'ipc.exports[0] is invalid',
        'ipc.exports[1] is invalid',
        'ipc.receives[0] is invalid',
      ]));
    });

    it('flags missing required fields', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      const result = validateManifest({ id: 'com.test' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns invalid for null manifest', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      let threw = false;
      let result = null;
      try {
        result = validateManifest(null);
      } catch (e) {
        threw = true;
      }
      expect(threw || (result && result.valid === false)).toBe(true);
    });
  });

  describe('createPackage', () => {
    it('creates a package with manifest and files', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {
        'index.html': '<h1>Hello</h1>',
        'app.js': 'console.log(1)',
      });
      expect(pkg.novabyte_app).toBe('1.0');
      expect(pkg.manifest.id).toBe('com.test.app');
      expect(Object.keys(pkg.files).length).toBe(2);
      expect(pkg.signing).toBeNull();
      expect(pkg.integrity).toBeNull();
    });

    it('creates empty package with no files', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      expect(pkg).toBeDefined();
      expect(Object.keys(pkg.files).length).toBe(0);
    });

    it('embeds integrity hashes when integrityMethod is provided', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      expect(pkg.integrity).toBeDefined();
      expect(pkg.integrity.method).toBe('sha256');
      expect(typeof pkg.integrity.payloadHash).toBe('string');
    });
  });

  describe('listSigningMethods / listIntegrityMethods', () => {
    it('returns signing methods with expected entries', async () => {
      const { listSigningMethods } = await import('../../../js/platform/core/app-package.js');
      const methods = listSigningMethods();
      const ids = methods.map(m => m.id);
      expect(ids).toContain('ed25519');
      expect(ids).toContain('ml-dsa-65');
      expect(ids).toContain('ed448');
      expect(ids).toContain('ecdsa-p256');
      expect(ids).toContain('ecdsa-p384');
      expect(ids).toContain('rsa-pss-4096');
      expect(ids).toContain('custom');
      expect(methods.find(m => m.id === 'ed25519').experimental).toBeFalsy();
      expect(methods.find(m => m.id === 'ml-dsa-65').experimental).toBe(true);
    });

    it('returns integrity methods with expected entries', async () => {
      const { listIntegrityMethods } = await import('../../../js/platform/core/app-package.js');
      const methods = listIntegrityMethods();
      const ids = methods.map(m => m.id);
      expect(ids).toContain('blake3');
      expect(ids).toContain('sha256');
      expect(ids).toContain('sha512');
      expect(ids).toContain('none');
    });
  });

  describe('getSigningMethod / getIntegrityMethod', () => {
    it('reads signing method from package', async () => {
      const { getSigningMethod } = await import('../../../js/platform/core/app-package.js');
      const pkg = { signing: { method: 'ed25519' } };
      expect(getSigningMethod(pkg)).toBe('ed25519');
    });

    it('returns null for unknown signing method', async () => {
      const { getSigningMethod } = await import('../../../js/platform/core/app-package.js');
      const pkg = { signing: { method: 'unknown' } };
      expect(getSigningMethod(pkg)).toBeNull();
    });

    it('reads integrity method from package', async () => {
      const { getIntegrityMethod } = await import('../../../js/platform/core/app-package.js');
      const pkg = { integrity: { method: 'sha256' } };
      expect(getIntegrityMethod(pkg)).toBe('sha256');
    });

    it('returns null when no integrity block', async () => {
      const { getIntegrityMethod } = await import('../../../js/platform/core/app-package.js');
      expect(getIntegrityMethod({})).toBeNull();
    });
  });

  describe('computeIntegrity / verifyIntegrity', () => {
    it('computes blake3 integrity hashes', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'blake3' });
      expect(pkg.integrity.method).toBe('blake3');
      expect(typeof pkg.integrity.payloadHash).toBe('string');
      expect(Object.keys(pkg.integrity.fileHashes).length).toBe(1);
    });

    it('computes sha256 integrity hashes', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'a.txt': 'abc' }, { integrityMethod: 'sha256' });
      expect(pkg.integrity.method).toBe('sha256');
      expect(typeof pkg.integrity.payloadHash).toBe('string');
    });

    it('skips integrity when method is none', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'a.txt': 'abc' }, { integrityMethod: 'none' });
      expect(pkg.integrity).toBeNull();
    });

    it('verifies integrity for a valid package', async () => {
      const { createPackage, verifyIntegrity } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      const ok = await verifyIntegrity(pkg);
      expect(ok).toBe(true);
    });

    it('rejects tampered file content', async () => {
      const { createPackage, verifyIntegrity } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      pkg.files['index.html'] = btoa(unescape(encodeURIComponent('<h1>Tampered</h1>')));
      const ok = await verifyIntegrity(pkg);
      expect(ok).toBe(false);
    });

    it('returns false when no integrity block', async () => {
      const { createPackage, verifyIntegrity } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      const ok = await verifyIntegrity(pkg);
      expect(ok).toBe(false);
    });
  });

  describe('signPackage / verifyPackage (multi-method)', () => {
    const fakePrivateJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' };
    const fakePublicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x' };

    it('signs a package with Ed25519 and returns a signature string', async () => {
      const { createPackage, signPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      const sig = await signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
      // signPackage is a pure primitive — it does not mutate the envelope;
      // createPackage is what records the method on pkg.signing.
      const signed = await createPackage(validManifest, {}, {
        signingKey: fakePrivateJwk, signingMethod: 'ed25519',
      });
      expect(signed.signing?.method).toBe('ed25519');
      expect(typeof signed.signature).toBe('string');
      expect(signed.signature.length).toBeGreaterThan(0);
    });

    it('verifies a package against a public key with explicit method', async () => {
      const { createPackage, signPackage, verifyPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      const sig = await signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      pkg.signature = sig;
      const ok = await verifyPackage(pkg, fakePublicJwk, 'ed25519');
      expect(ok).toBe(true);
    });

    it('supports custom signing via function', async () => {
      const { createPackage, signPackage, verifyPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      const customSig = 'custom-sig-123';
      const verifier = vi.fn().mockResolvedValue(true);
      const sig = await signPackage(pkg, () => Promise.resolve(customSig), { method: 'custom' });
      expect(sig).toBe(customSig);
      pkg.signature = sig;
      const ok = await verifyPackage(pkg, verifier, 'custom');
      expect(ok).toBe(true);
      expect(verifier).toHaveBeenCalledWith(customSig, expect.any(String));
    });

    it('returns false for null package', async () => {
      const { verifyPackage } = await import('../../../js/platform/core/app-package.js');
      const result = await verifyPackage(null, fakePublicJwk, 'ed25519');
      expect(result).toBe(false);
    });

    it('rejects a package when the trust store has no matching entries', async () => {
      const { createPackage, signPackage, verifyAgainstTrustStore } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, {});
      pkg.signature = await signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      const result = await verifyAgainstTrustStore(pkg, []);
      expect(result.trusted).toBe(false);
      expect(result.signer).toBe(null);
    });
  });

  describe('installPackage', () => {
    it('allows install when integrity fallback is enabled and signature is missing', async () => {
      const { createPackage, installPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      const result = await installPackage(pkg, {
        skipVerify: false,
        trustStore: [],
        allowUnverified: true,
        allowIntegrityFallback: true,
      });
      expect(result.verified).toBe(true);
      expect(result.success).toBe(true);
    });

    it('rejects install when neither signature nor integrity is valid and fallback is disabled', async () => {
      const { createPackage, installPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = await createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'none' });
      let threw = false;
      try {
        await installPackage(pkg, {
          skipVerify: false,
          trustStore: [],
          allowUnverified: false,
          allowIntegrityFallback: false,
        });
      } catch (e) {
        threw = true;
      }
      expect(threw).toBe(true);
    });

    it('preserves package trust metadata on the registered bundled app', async () => {
      const { installPackage } = await import('../../../js/platform/core/app-package.js');
      const pkg = {
        novabyte_app: '1.0',
        compiled_at: 123456789,
        manifest: { ...validManifest, system: true },
        files: { 'index.html': '' },
        signature: null,
        signing: null,
        integrity: { method: 'none' },
      };

      await installPackage(pkg, { source: 'system-bundle' });

      const registeredApp = globalThis.AppRegistry.registerApp.mock.calls[0][0];
      expect(registeredApp).toMatchObject({
        source: 'system-bundle',
        verified: true,
        signer: 'Astro System',
        system: true,
        manifest: pkg.manifest,
        integrity: pkg.integrity,
        signing: pkg.signing,
        novabyte_app: pkg.novabyte_app,
        compiled_at: pkg.compiled_at,
      });
    });
  });
});

  const validManifest = {
    id: 'com.test.app',
    name: 'Test App',
    version: '1.0.0',
    entry: 'index.html',
  };

  describe('validateManifest', () => {
    it('returns valid for a correct manifest', () => {
      const result = AppPackage.validateManifest(validManifest);
      expect(result.valid).toBe(true);
    });

    it('requires unrestrictedEntry for the separate system:root permission', async () => {
      const { validateManifest } = await import('../../../js/platform/core/app-package.js');
      expect(validateManifest({
        ...validManifest,
        permissions: ['system:root'],
      }).errors).toContain('system:root requires unrestrictedEntry to name a packaged JavaScript file');
      expect(validateManifest({
        ...validManifest,
        permissions: ['system:root'],
        unrestrictedEntry: 'root.js',
      }).valid).toBe(true);
    });

    it('accepts the supported Home role and rejects unknown app roles', () => {
      expect(AppPackage.validateManifest({
        ...validManifest,
        handles: { roles: ['home'] },
      }).valid).toBe(true);
      expect(AppPackage.validateManifest({
        ...validManifest,
        handles: { roles: ['system-admin'] },
      }).valid).toBe(false);
    });

    it('flags missing required fields', () => {
      const result = AppPackage.validateManifest({ id: 'com.test' });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('returns invalid for null manifest', () => {
      let threw = false;
      let result = null;
      try {
        result = AppPackage.validateManifest(null);
      } catch (e) {
        threw = true;
      }
      expect(threw || (result && result.valid === false)).toBe(true);
    });
  });

  describe('createPackage', () => {
    it('creates a package with manifest and files', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {
        'index.html': '<h1>Hello</h1>',
        'app.js': 'console.log(1)',
      });
      expect(pkg.novabyte_app).toBe('1.0');
      expect(pkg.manifest.id).toBe('com.test.app');
      expect(Object.keys(pkg.files).length).toBe(2);
      expect(pkg.signing).toBeNull();
      expect(pkg.integrity).toBeNull();
    });

    it('creates empty package with no files', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {});
      expect(pkg).toBeDefined();
      expect(Object.keys(pkg.files).length).toBe(0);
    });

    it('rejects root packages when their declared entry is not packaged', async () => {
      const { createPackage } = await import('../../../js/platform/core/app-package.js');
      await expect(createPackage({
        ...validManifest,
        permissions: ['system:root'],
        unrestrictedEntry: 'root.js',
      }, {
        'index.html': '<p>root</p>',
      })).rejects.toThrow('Root package is missing unrestrictedEntry file "root.js"');
    });

    it('embeds integrity hashes when integrityMethod is provided', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      expect(pkg.integrity).toBeDefined();
      expect(pkg.integrity.method).toBe('sha256');
      expect(pkg.integrity.payloadHash).toBeDefined();
      expect(typeof pkg.integrity.payloadHash).toBe('string');
    });
  });

  describe('listSigningMethods / listIntegrityMethods', () => {
    it('returns signing methods with expected entries', () => {
      const methods = AppPackage.listSigningMethods();
      const ids = methods.map(m => m.id);
      expect(ids).toContain('ed25519');
      expect(ids).toContain('ml-dsa-65');
      expect(ids).toContain('ed448');
      expect(ids).toContain('ecdsa-p256');
      expect(ids).toContain('ecdsa-p384');
      expect(ids).toContain('rsa-pss-4096');
      expect(ids).toContain('custom');
      expect(methods.find(m => m.id === 'ed25519').experimental).toBeFalsy();
      expect(methods.find(m => m.id === 'ml-dsa-65').experimental).toBe(true);
    });

    it('returns integrity methods with expected entries', () => {
      const methods = AppPackage.listIntegrityMethods();
      const ids = methods.map(m => m.id);
      expect(ids).toContain('blake3');
      expect(ids).toContain('sha256');
      expect(ids).toContain('sha512');
      expect(ids).toContain('none');
    });
  });

  describe('getSigningMethod / getIntegrityMethod', () => {
    it('reads signing method from package', () => {
      const pkg = { signing: { method: 'ed25519' } };
      expect(AppPackage.getSigningMethod(pkg)).toBe('ed25519');
    });

    it('returns null for unknown signing method', () => {
      const pkg = { signing: { method: 'unknown' } };
      expect(AppPackage.getSigningMethod(pkg)).toBeNull();
    });

    it('reads integrity method from package', () => {
      const pkg = { integrity: { method: 'sha256' } };
      expect(AppPackage.getIntegrityMethod(pkg)).toBe('sha256');
    });

    it('returns null when no integrity block', () => {
      expect(AppPackage.getIntegrityMethod({})).toBeNull();
    });
  });

  describe('computeIntegrity / verifyIntegrity', () => {
    it('computes blake3 integrity hashes', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'blake3' });
      expect(pkg.integrity.method).toBe('blake3');
      expect(typeof pkg.integrity.payloadHash).toBe('string');
      expect(Object.keys(pkg.integrity.fileHashes).length).toBe(1);
    });

    it('computes sha256 integrity hashes', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'a.txt': 'abc' }, { integrityMethod: 'sha256' });
      expect(pkg.integrity.method).toBe('sha256');
      expect(typeof pkg.integrity.payloadHash).toBe('string');
    });

    it('skips integrity when method is none', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'a.txt': 'abc' }, { integrityMethod: 'none' });
      expect(pkg.integrity).toBeNull();
    });

    it('verifies integrity for a valid package', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      const ok = await AppPackage.verifyIntegrity(pkg);
      expect(ok).toBe(true);
    });

    it('rejects tampered file content', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      pkg.files['index.html'] = btoa(unescape(encodeURIComponent('<h1>Tampered</h1>')));
      const ok = await AppPackage.verifyIntegrity(pkg);
      expect(ok).toBe(false);
    });

    it('returns false when no integrity block', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {});
      const ok = await AppPackage.verifyIntegrity(pkg);
      expect(ok).toBe(false);
    });
  });

  describe('signPackage / verifyPackage (multi-method)', () => {
    const fakePrivateJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' };
    const fakePublicJwk = { kty: 'OKP', crv: 'Ed25519', x: 'x' };

    it('signs a package with Ed25519 and returns a signature string', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {});
      const sig = await AppPackage.signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      expect(typeof sig).toBe('string');
      expect(sig.length).toBeGreaterThan(0);
      // signPackage is a pure primitive — createPackage records the method.
      const signed = await AppPackage.createPackage(validManifest, {}, {
        signingKey: fakePrivateJwk, signingMethod: 'ed25519',
      });
      expect(signed.signing?.method).toBe('ed25519');
      expect(typeof signed.signature).toBe('string');
    });

    it('verifies a package against a public key with explicit method', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {});
      const sig = await AppPackage.signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      pkg.signature = sig;
      const ok = await AppPackage.verifyPackage(pkg, fakePublicJwk, 'ed25519');
      expect(ok).toBe(true);
    });

    it('supports custom signing via function', async () => {
      const pkg = await AppPackage.createPackage(validManifest, {});
      const customSig = 'custom-sig-123';
      const verifier = vi.fn().mockResolvedValue(true);
      const sig = await AppPackage.signPackage(pkg, () => Promise.resolve(customSig), { method: 'custom' });
      expect(sig).toBe(customSig);
      pkg.signature = sig;
      const ok = await AppPackage.verifyPackage(pkg, verifier, 'custom');
      expect(ok).toBe(true);
      expect(verifier).toHaveBeenCalledWith(customSig, expect.any(String));
    });

    it('returns false for null package', async () => {
      const result = await AppPackage.verifyPackage(null, fakePublicJwk, 'ed25519');
      expect(result).toBe(false);
    });

    it('rejects a package when the trust store has no matching entries', async () => {
      const AppPackageFresh = require('../../../js/platform/core/app-package.js');
      const pkg = await AppPackageFresh.createPackage(validManifest, {});
      pkg.signature = await AppPackageFresh.signPackage(pkg, fakePrivateJwk, { method: 'ed25519' });
      const result = await AppPackageFresh.verifyAgainstTrustStore(pkg, []);
      expect(result.trusted).toBe(false);
      expect(result.signer).toBe(null);
    });
  });

  describe('installPackage', () => {
    it('allows install when integrity fallback is enabled and signature is missing', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'sha256' });
      const result = await AppPackage.installPackage(pkg, {
        skipVerify: false,
        trustStore: [],
        allowUnverified: true,
        allowIntegrityFallback: true,
      });
      expect(result.verified).toBe(true);
      expect(result.success).toBe(true);
    });

    it('rejects install when neither signature nor integrity is valid and fallback is disabled', async () => {
      const pkg = await AppPackage.createPackage(validManifest, { 'index.html': '<h1>Hello</h1>' }, { integrityMethod: 'none' });
      let threw = false;
      try {
        await AppPackage.installPackage(pkg, {
          skipVerify: false,
          trustStore: [],
          allowUnverified: false,
          allowIntegrityFallback: false,
        });
      } catch (e) {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

describe('AppPackage.validateManifest — permissionReasons', () => {
  const baseManifest = {
    id: 'com.test.reasons',
    name: 'Reasons App',
    version: '1.0.0',
    entry: 'index.html',
  };
  const PERM_STUB = {
    PERMISSION_TYPES: { SYSTEM_ROOT: 'system:root', FS_ACCESS: 'fs:access', FS_READ_IMAGES: 'fs:read:images', NET_EXTERNAL: 'net:external' },
    LEGACY_PERMISSION_ALIASES: { 'vfs:read': 'fs:access' },
    MAX_REASON_LENGTH: 500,
  };

  afterEach(() => {
    delete globalThis.AppPermissionManager;
  });

  it('accepts a well-formed map without warnings', async () => {
    globalThis.AppPermissionManager = PERM_STUB;
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const result = validateManifest({
      ...baseManifest,
      permissions: ['fs:read:images', 'net:external'],
      permissionReasons: {
        'fs:read:images': 'Displays a gallery of shared images.',
        'net:external': 'Calls the app\u2019s own API.',
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('rejects non-object values (strings, arrays, null)', async () => {
    globalThis.AppPermissionManager = PERM_STUB;
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    for (const bad of ['nope', ['system:root'], null]) {
      const result = validateManifest({ ...baseManifest, permissionReasons: bad });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('permissionReasons must be an object mapping permission strings to reason strings');
    }
  });

  it('rejects values that are not non-empty strings within the cap', async () => {
    globalThis.AppPermissionManager = PERM_STUB;
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const result = validateManifest({
      ...baseManifest,
      permissions: ['system:root'],
      permissionReasons: { 'system:root': '   ' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('permissionReasons["system:root"] must be a non-empty string');

    const tooLong = validateManifest({
      ...baseManifest,
      permissions: ['system:root'],
      permissionReasons: { 'system:root': 'x'.repeat(501) },
    });
    expect(tooLong.valid).toBe(false);
    expect(tooLong.errors).toContain('permissionReasons["system:root"] exceeds 500 characters');
  });

  it('warns on unknown permission keys and on reasons for undeclared permissions', async () => {
    globalThis.AppPermissionManager = PERM_STUB;
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const result = validateManifest({
      ...baseManifest,
      permissions: ['net:external'],
      permissionReasons: {
        'net:external': 'Calls its API.',          // declared — fine
        'fs:read:images': 'Never requested.',      // known but undeclared → warning
        'not:a:permission': 'Typo.',               // unknown → warning
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Unknown permission in permissionReasons: not:a:permission',
      'permissionReasons declares "fs:read:images", which is not in permissions or optionalPermissions',
    ]));
  });

  it('accepts a reason for a permission declared in optionalPermissions and translates legacy alias keys', async () => {
    globalThis.AppPermissionManager = PERM_STUB;
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const optional = validateManifest({
      ...baseManifest,
      optionalPermissions: ['fs:read:images'],
      permissionReasons: { 'fs:read:images': 'Gallery feature, optional.' },
    });
    expect(optional.valid).toBe(true);
    expect(optional.warnings).toEqual([]);

    const legacy = validateManifest({
      ...baseManifest,
      permissions: ['fs:access'],
      permissionReasons: { 'vfs:read': 'Opens files the user picks.' },
    });
    expect(legacy.valid).toBe(true);
    expect(legacy.warnings).toEqual([]);
  });

  it('honors AppPermissionManager.MAX_REASON_LENGTH as the cap when available', async () => {
    globalThis.AppPermissionManager = { ...PERM_STUB, MAX_REASON_LENGTH: 50 };
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const result = validateManifest({
      ...baseManifest,
      permissions: ['net:external'],
      permissionReasons: { 'net:external': 'x'.repeat(51) },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('permissionReasons["net:external"] exceeds 50 characters');
  });

  it('still validates shapes without an AppPermissionManager global (standalone tooling)', async () => {
    const { validateManifest } = await import('../../../js/platform/core/app-package.js');
    const result = validateManifest({
      ...baseManifest,
      permissionReasons: { 'whatever:key': '' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('permissionReasons["whatever:key"] must be a non-empty string');
  });
});
