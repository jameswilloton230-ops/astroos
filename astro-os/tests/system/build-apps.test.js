import { execFileSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectDir = fileURLToPath(new URL('../..', import.meta.url));

describe('NovaApp build signatures', () => {
  it('signs both required system services in the format expected by the runtime verifier', () => {
    const appsDir = mkdtempSync(path.join(os.tmpdir(), 'novabyte-app-build-'));
    const appDirs = [
      {
        directory: 'shell-ui',
        id: 'com.astroos.shell-ui',
        entry: 'wm.js',
        source: 'window.shellUiStarted = true;',
      },
      {
        directory: 'app-loader-optimiser',
        id: 'com.astroos.service.app-loader-optimiser',
        entry: 'service.js',
        source: 'window.appLoaderOptimiserStarted = true;',
      },
    ];
    for (const app of appDirs) {
      const appDir = path.join(appsDir, app.directory);
      mkdirSync(appDir);
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

    try {
      execFileSync(process.execPath, [
        path.join(projectDir, 'build-apps.mjs'),
        appsDir,
        ...appDirs.map(app => app.directory),
      ], { cwd: projectDir, stdio: 'ignore' });

      const privateJwk = JSON.parse(readFileSync(path.join(projectDir, 'keys', 'test-system-key.json'), 'utf8'));
      const trustStoreSource = readFileSync(
        path.join(projectDir, 'js', 'platform', 'security', 'trust-store.js'),
        'utf8',
      );
      const systemKeyMatch = trustStoreSource.match(
        /const NOVABYTE_SYSTEM_SIGNING_PUBLIC_JWK = (\{[\s\S]*?\n\};)/,
      );
      expect(systemKeyMatch).not.toBeNull();
      const systemPublicJwk = JSON.parse(systemKeyMatch[1].slice(0, -1));
      expect(privateJwk.x).toBe(systemPublicJwk.x);
      const publicKey = createPublicKey({ key: systemPublicJwk, format: 'jwk' });
      for (const app of appDirs) {
        const pkg = JSON.parse(readFileSync(path.join(appsDir, `${app.id}.novaapp`), 'utf8'));
        const payload = JSON.stringify({
          novabyte_app: pkg.novabyte_app,
          manifest: pkg.manifest,
          files: pkg.files,
          compiled_at: pkg.compiled_at,
        });

        expect(pkg.manifest.id).toBe(app.id);
        expect(pkg.manifest.systemService).toBe(true);
        expect(pkg.signing.method).toBe('ed25519');
        expect(pkg.signature).toBe(pkg.signing.signature);
        expect(verify(
          null,
          Buffer.from(payload, 'utf8'),
          publicKey,
          Buffer.from(pkg.signature, 'hex'),
        )).toBe(true);

        const tamperedPayload = JSON.stringify({
          novabyte_app: pkg.novabyte_app,
          manifest: pkg.manifest,
          files: { ...pkg.files, [app.entry]: Buffer.from('window.tampered = true;').toString('base64') },
          compiled_at: pkg.compiled_at,
        });
        expect(verify(
          null,
          Buffer.from(tamperedPayload, 'utf8'),
          publicKey,
          Buffer.from(pkg.signature, 'hex'),
        )).toBe(false);
      }
    } finally {
      rmSync(appsDir, { recursive: true, force: true });
    }
  });
});
