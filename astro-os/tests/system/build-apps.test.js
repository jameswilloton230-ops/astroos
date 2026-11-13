import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));

/** Extracts the System signing anchor JWK from trust-store.js source. */
function systemAnchorJwk() {
  const trustStoreSource = readFileSync(
    path.join(projectDir, 'js', 'platform', 'security', 'trust-store.js'),
    'utf8',
  );
  const systemKeyMatch = trustStoreSource.match(
    /const NOVABYTE_SYSTEM_SIGNING_PUBLIC_JWK = (\{[\s\S]*?\n  \};)/,
  );
  expect(systemKeyMatch).not.toBeNull();
  return JSON.parse(systemKeyMatch[1].slice(0, -1));
}

/** Builds one throwaway app and returns its parsed .novaapp package. */
function buildApp(appsDir, app, env) {
  execFileSync(process.execPath, [
    path.join(projectDir, 'build-apps.mjs'),
    appsDir,
    app.directory,
  ], {
    cwd: projectDir,
    stdio: 'ignore',
    env,
  });
  return JSON.parse(readFileSync(path.join(appsDir, `${app.id}.novaapp`), 'utf8'));
}

function writeAppSource(appsDir, app) {
  const appDir = path.join(appsDir, app.directory);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'manifest.json'), JSON.stringify({
    id: app.id,
    name: app.id,
    version: '1.0.0',
    entry: app.entry,
    guestEntry: app.entry,
    system: true,
    systemService: true,
    permissions: [],
  }));
  writeFileSync(path.join(appDir, app.entry), app.source);
}

function signedPayload(pkg) {
  return JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at,
  });
}

describe('NovaApp build signatures (AOSP-style test keys)', () => {
  it('default build signs with the committed PUBLIC test key — the fresh-clone/fork story (2026-11-12 follow-up to audit F1)', () => {
    // The first F1 fix removed the committed key and required an env key for
    // every build, which produced UNSIGNED packages no trust anchor matched:
    // anyone forking the repo built an OS whose system apps could not verify
    // at all. The Android/AOSP model is used instead — the default build
    // signs with the deliberately-public test pair committed at
    // astro-os/keys/test-system-key.json, and the trust-store anchor points at
    // its public half, so every clone and fork builds a System-verifiable
    // OS out of the box (like an AOSP build signed with the public
    // platform test keys).
    expect(existsSync(path.join(projectDir, 'keys', 'test-system-key.json'))).toBe(true);
    const testKey = JSON.parse(readFileSync(path.join(projectDir, 'keys', 'test-system-key.json'), 'utf8'));

    const anchor = systemAnchorJwk();
    // The trust-store anchor IS the committed test key's public half.
    expect(anchor.x).toBe(testKey.x);
    expect(anchor).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });

    const appsDir = mkdtempSync(path.join(os.tmpdir(), 'novabyte-app-build-default-'));
    const app = {
      directory: 'clock',
      id: 'com.astroos.clock',
      entry: 'service.js',
      source: 'window.clockStarted = true;',
    };
    try {
      writeAppSource(appsDir, app);
      const pkg = buildApp(appsDir, app, {
        ...process.env,
        ASTROOS_SYSTEM_SIGNING_KEY_PATH: '',
        ASTROOS_SYSTEM_SIGNING_KEY: '',
      });

      expect(pkg.manifest.id).toBe(app.id);
      expect(pkg.manifest.systemService).toBe(true);
      expect(pkg.signing.method).toBe('ed25519');
      expect(pkg.signing.signer).toBe('Astro System');
      // Test-key builds are labelled 'test' — the build-tier field the OS
      // surfaces as systemSignatureTier() 'test-keys' (Android's
      // ro.build.tags=test-keys equivalent). It rides inside pkg.signing,
      // which is excluded from the signed payload.
      expect(pkg.signing.tier).toBe('test');
      expect(pkg.signature).toBe(pkg.signing.signature);

      const anchorKey = createPublicKey({ key: anchor, format: 'jwk' });
      // The signature verifies against the trust-store anchor: a fresh
      // clone's build IS System-verifiable with zero configuration.
      expect(
        verify(null, Buffer.from(signedPayload(pkg), 'utf8'), anchorKey, Buffer.from(pkg.signature, 'hex')),
      ).toBe(true);

      // Tampering the payload breaks the signature.
      const tampered = JSON.stringify({
        novabyte_app: pkg.novabyte_app,
        manifest: pkg.manifest,
        files: { ...pkg.files, [app.entry]: Buffer.from('window.tampered = true;').toString('base64') },
        compiled_at: pkg.compiled_at,
      });
      expect(
        verify(null, Buffer.from(tampered, 'utf8'), anchorKey, Buffer.from(pkg.signature, 'hex')),
      ).toBe(false);

      // Integrity is still recorded (bundled system apps are gated on it).
      expect(pkg.integrity.method).toBe('sha512');
      expect(pkg.integrity.payloadHash).toMatch(/^[a-f0-9]{128}$/);
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });

  it('an env-supplied RELEASE key signs with tier "release" and does not verify against the default test anchor', () => {
    const appsDir = mkdtempSync(path.join(os.tmpdir(), 'novabyte-app-build-release-'));
    const app = {
      directory: 'shell-ui',
      id: 'com.astroos.shell-ui',
      entry: 'wm.js',
      source: 'window.shellUiStarted = true;',
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyFile = path.join(appsDir, 'release-signing-key.json');
    writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })));
    const releasePublicJwk = publicKey.export({ format: 'jwk' });

    try {
      writeAppSource(appsDir, app);
      const pkg = buildApp(appsDir, app, {
        ...process.env,
        ASTROOS_SYSTEM_SIGNING_KEY_PATH: keyFile,
      });

      expect(pkg.signing.method).toBe('ed25519');
      // Env-supplied keys are RELEASE keys: tier 'release', and the runtime
      // anchor must be rotated to match via ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK
      // (server-injected meta) — see keys/README.md.
      expect(pkg.signing.tier).toBe('release');

      const releaseKey = createPublicKey({ key: releasePublicJwk, format: 'jwk' });
      expect(
        verify(null, Buffer.from(signedPayload(pkg), 'utf8'), releaseKey, Buffer.from(pkg.signature, 'hex')),
      ).toBe(true);

      // Against the DEFAULT (test) anchor the release signature must NOT
      // verify — that is the point of rotating.
      const anchor = systemAnchorJwk();
      expect(anchor.x).not.toBe(releasePublicJwk.x);
      const anchorKey = createPublicKey({ key: anchor, format: 'jwk' });
      expect(
        verify(null, Buffer.from(signedPayload(pkg), 'utf8'), anchorKey, Buffer.from(pkg.signature, 'hex')),
      ).toBe(false);
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });
});
