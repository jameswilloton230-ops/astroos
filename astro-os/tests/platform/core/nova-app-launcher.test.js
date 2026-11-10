import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── nova-app-launcher.js — signed .novaapp launch config builder ────────────
// Window-attach script (no module.exports; publishes window.buildNovaAppConfig).
// Pure-config and permission-gating behavior is tested directly; the
// sandbox-launch branch is exercised with a stubbed AppSandbox, and the
// legacy fallback branch is reached by removing AppSandbox entirely.
// No DOM is needed for any path under test.

const LAUNCHER_PATH = '../../../js/platform/core/nova-app-launcher.js';

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function makeAppData(overrides = {}) {
  return {
    id: 'com.example.packaged',
    name: 'Example Package',
    entry: 'index.html',
    files: { 'index.html': 'aHRtbA==' },
    ...overrides,
  };
}

describe('buildNovaAppConfig (js/platform/core/nova-app-launcher.js)', () => {
  beforeEach(() => {
    // The launcher is chatty by design ([AppManager][DIAG] etc.) — keep test
    // output readable; individual tests still spy on error/warn as needed.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    requireFresh(LAUNCHER_PATH);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.AppSandbox;
    delete globalThis.AppPermissionManager;
  });

  describe('surface', () => {
    it('exposes buildNovaAppConfig on window', () => {
      expect(typeof window.buildNovaAppConfig).toBe('function');
    });
  });

  describe('config shape and defaults', () => {
    it('fills documented defaults for a minimal package', () => {
      const cfg = window.buildNovaAppConfig(makeAppData());

      expect(cfg.id).toBe('com.example.packaged');
      expect(cfg.name).toBe('Example Package');
      expect(cfg.entry).toBe('index.html');
      expect(cfg.defaultSize).toEqual([800, 560]);
      expect(cfg.minSize).toEqual([400, 300]);
      expect(cfg.permissions).toEqual([]);
      expect(cfg.optionalPermissions).toEqual([]);
      expect(cfg.sandbox).toEqual({ allowScripts: true, allowForms: true, allowPopups: false });
      expect(cfg.type).toBe('package');
      expect(cfg.source).toBe('file');
      expect(cfg.files).toEqual({ 'index.html': 'aHRtbA==' });
      // Booleans normalize: trust flags default to false, chrome defaults to open.
      expect(cfg.verified).toBe(false);
      expect(cfg.revoked).toBe(false);
      expect(cfg.tampered).toBe(false);
      expect(cfg.system).toBe(false);
      expect(cfg.resizable).toBe(true);
      expect(cfg.frame).toBe(true);
      expect(typeof cfg.init).toBe('function');
    });

    it('only marks system:true for packages signed by the Astro System key', () => {
      const signed = window.buildNovaAppConfig(makeAppData({
        verified: true,
        signer: 'Astro System',
        manifest: { system: true },
      }));
      expect(signed.system).toBe(true);

      const forged = window.buildNovaAppConfig(makeAppData({
        verified: true,
        signer: 'Imposter Systems',
        manifest: { system: true },
      }));
      expect(forged.system).toBe(false);

      const unsigned = window.buildNovaAppConfig(makeAppData({
        manifest: { system: true },
      }));
      expect(unsigned.system).toBe(false);
    });

    it('preserves trust/lifecycle metadata through to the live app config', () => {
      const cfg = window.buildNovaAppConfig(makeAppData({
        verified: true,
        signer: 'AstroOS Trusted Signing',
        source: 'system-bundle',
        signature: 'cafe',
        integrity: { method: 'blake3', fileHashes: {} },
        revoked: true,
        tampered: true,
        devOnly: true,
        minSecurityPatch: '2026-08-02',
        unrestrictedEntry: 'admin.html',
      }));
      expect(cfg.verified).toBe(true);
      expect(cfg.signer).toBe('AstroOS Trusted Signing');
      expect(cfg.source).toBe('system-bundle');
      expect(cfg.signature).toBe('cafe');
      expect(cfg.integrity).toEqual({ method: 'blake3', fileHashes: {} });
      expect(cfg.revoked).toBe(true);
      expect(cfg.tampered).toBe(true);
      expect(cfg.devOnly).toBe(true);
      expect(cfg.minSecurityPatch).toBe('2026-08-02');
      expect(cfg.unrestrictedEntry).toBe('admin.html');
    });
  });

  describe('package icon resolution', () => {
    it('passes through absolute, data: and http(s) icons untouched', () => {
      for (const icon of ['data:image/png;base64,AAA', 'https://cdn.example/i.png', '/assets/pic.svg']) {
        const cfg = window.buildNovaAppConfig(makeAppData({ icon }));
        expect(cfg.icon).toBe(icon);
      }
    });

    it('rewrites packaged icon paths to data: URIs using the package\'s own files', () => {
      const cfg = window.buildNovaAppConfig(makeAppData({
        icon: 'icons/app.png',
        files: { 'index.html': 'aHRtbA==', 'icons/app.png': 'UE5HQkxPQg==' },
      }));
      expect(cfg.icon).toBe('data:image/png;base64,UE5HQkxPQg==');

      const svg = window.buildNovaAppConfig(makeAppData({
        icon: 'icons/app.svg',
        files: { 'icons/app.svg': 'PHN2Zz48L3N2Zz4=' },
      }));
      expect(svg.icon).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
    });

    it('falls back to the stock placeholder when there is no icon at all', () => {
      expect(window.buildNovaAppConfig(makeAppData()).icon).toBe('/assets/no_app_icon.svg');
      // A packaged path with no matching file is returned unchanged, not dropped.
      expect(window.buildNovaAppConfig(makeAppData({ icon: 'icons/missing.png' })).icon).toBe('icons/missing.png');
    });
  });

  describe('init() permission gating (sandbox launch branch)', () => {
    function stubSandbox(result = { success: true, sandboxId: 'sb-1' }) {
      globalThis.AppSandbox = { launch: vi.fn(async () => result) };
      return globalThis.AppSandbox;
    }

    function stubApm({ riskCategories = {} } = {}) {
      globalThis.AppPermissionManager = {
        autoGrantLowRisk: vi.fn(async () => true),
        isGranted: vi.fn(() => false),
        isDenied: vi.fn(() => false),
        requestAll: vi.fn(async () => true),
        PERMISSION_CATEGORIES: riskCategories,
      };
      return globalThis.AppPermissionManager;
    }

    it('prompts only for missing required medium/high-risk permissions and hands off to AppSandbox.launch', async () => {
      const sandbox = stubSandbox();
      const mgr = stubApm({
        riskCategories: {
          'fs:access': { risk: 'critical' },
          'device:notifications': { risk: 'low' },
        },
      });
      const cfg = window.buildNovaAppConfig(makeAppData({
        name: 'Gated App',
        permissions: ['fs:access'],
        optionalPermissions: ['device:notifications'],
        verified: true,
        signer: 'AstroOS Trusted Signing',
      }));

      const result = await cfg.init({ style: {}, innerHTML: '' }, { prev: 1 }, { dry: true });

      // Low-risk perms (required or optional) are auto-granted, never prompted.
      expect(mgr.autoGrantLowRisk).toHaveBeenCalledWith('device:notifications', 'com.example.packaged');
      // Only the missing required sensitive permission enters the consent queue.
      expect(mgr.requestAll).toHaveBeenCalledTimes(1);
      expect(mgr.requestAll).toHaveBeenCalledWith(['fs:access'], 'com.example.packaged', 'Gated App');
      // Launch passes a sandbox-app record that keeps the signed identity.
      expect(sandbox.launch).toHaveBeenCalledTimes(1);
      const [sandboxApp, contentEl, state, options] = sandbox.launch.mock.calls[0];
      expect(sandboxApp.id).toBe('com.example.packaged');
      expect(sandboxApp.verified).toBe(true);
      expect(sandboxApp.signer).toBe('AstroOS Trusted Signing');
      expect(sandboxApp.entry).toBe('index.html');
      expect(sandboxApp.system).toBe(false);
      expect(state).toEqual({ prev: 1 });
      expect(options).toEqual({ dry: true });
      expect(result).toEqual({ success: true, sandboxId: 'sb-1' });
    });

    it('never blocks launch on a previously denied permission (denied = skip prompt)', async () => {
      const sandbox = stubSandbox();
      const mgr = stubApm({ riskCategories: { 'fs:access': { risk: 'critical' } } });
      mgr.isGranted = vi.fn(() => false);
      mgr.isDenied = vi.fn((p) => p === 'fs:access');

      const cfg = window.buildNovaAppConfig(makeAppData({ permissions: ['fs:access'] }));
      await cfg.init({ style: {}, innerHTML: '' }, null, {});

      expect(mgr.requestAll).not.toHaveBeenCalled();
      expect(sandbox.launch).toHaveBeenCalledTimes(1);
    });

    it('propagates AppSandbox.launch failures instead of falling back to the legacy path', async () => {
      stubSandbox();
      globalThis.AppSandbox.launch = vi.fn(async () => { throw new Error('partition busy'); });
      stubApm();
      const cfg = window.buildNovaAppConfig(makeAppData());
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(cfg.init({ style: {}, innerHTML: '' }, null, {})).rejects.toThrow('partition busy');
      expect(consoleErr).toHaveBeenCalled();
    });
  });

  describe('legacy fallback safety blocks (no AppSandbox present)', () => {
    it('shows an in-frame error instead of launching when the entry file is missing from the package', async () => {
      const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
      const contentEl = { style: {}, innerHTML: '' };
      const cfg = window.buildNovaAppConfig(makeAppData({ files: {} }));

      await cfg.init(contentEl, null, {});

      expect(contentEl.innerHTML).toContain('Entry file not found in package.');
      expect(consoleLog).toHaveBeenCalled();
    });

    it('blocks obfuscated packages outright — no execution path is offered', async () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const contentEl = { style: {}, innerHTML: '' };
      const cfg = window.buildNovaAppConfig(makeAppData({ _wasObfuscated: true }));

      await cfg.init(contentEl, null, {});

      expect(contentEl.innerHTML).toContain('obfuscated packages cannot be loaded');
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Obfuscated package blocked'), 'com.example.packaged');
    });
  });
});
