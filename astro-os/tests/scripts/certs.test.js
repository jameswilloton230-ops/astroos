import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ensureCerts } from '../../scripts/certs.js';
import { seedCerts } from '../server/helpers/seed-certs.js';

describe('scripts/certs.js — kiosk localhost certificate handling', () => {
  let appDir;

  afterEach(async () => {
    if (appDir) {
      await fs.rm(appDir, { recursive: true, force: true });
      appDir = undefined;
    }
  });

  it('preserves the localhost-only certificate exception while removing broad bypass flags', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astroos-certs-'));

    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, 'ca.trusted'), 'test');

    const manifestPath = path.join(appDir, 'package.json');
    await fs.writeFile(manifestPath, JSON.stringify({
      window: {
        'chromium-args': [
          '--allow-insecure-localhost',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list=stale-pin',
        ].join(' '),
      },
    }));

    const trustInstaller = vi.fn(() => true);
    await expect(ensureCerts(appDir, trustInstaller)).resolves.toBe(true);
    if (process.platform === 'linux') {
      expect(trustInstaller).toHaveBeenCalledOnce();
      expect(trustInstaller).toHaveBeenCalledWith(path.join(appDir, 'ca.crt'));
    }

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.window['chromium-args']).toContain('--allow-insecure-localhost');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors');
    expect(manifest.window['chromium-args']).not.toContain('--ignore-certificate-errors-spki-list');
  });

  // Regression: an interrupted write left empty/truncated PEMs that passed the
  // old exists-and-recent check, so ssl.js crashed on every boot after.
  it.each([
    ['an empty cert.crt',          'cert.crt', ''],
    ['a truncated cert.key',       'cert.key', '-----BEGIN PRIVATE KEY-----\nMIIE'],
    ['a cert.crt with no PEM',     'cert.crt', 'test'],
  ])('regenerates instead of reusing %s', async (_label, file, content) => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astroos-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);
    await fs.writeFile(path.join(appDir, file), content);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ensureCerts(appDir, () => true);
      expect(log).toHaveBeenCalledWith('[AstroOS] Generating CA and server certificate...');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps valid certs without regenerating', async () => {
    appDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astroos-certs-'));
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ window: {} }));
    await seedCerts(appDir);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(ensureCerts(appDir, () => true)).resolves.toBe(true);
      expect(log).not.toHaveBeenCalledWith('[AstroOS] Generating CA and server certificate...');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
