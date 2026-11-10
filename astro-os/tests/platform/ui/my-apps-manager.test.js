import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// ── my-apps-manager.js — packaged-app management UI backend ─────────────────
// CJS module (module.exports = MyAppsManager). In the Node test environment
// `document` is undefined, so the module's auto-initialize block is skipped —
// every test drives initialize() explicitly against a stubbed AppRegistry.
// WM / OS / AppSandbox / AppDirs / AppPackage / TrustStore / Notify / EventLog
// are stubbed per test; undefined globals are always (re)assigned first so
// bare-identifier references resolve.

const MAM_PATH = '../../../js/platform/ui/my-apps-manager.js';
let MyAppsManager;
let AppRegistry;
let EventLog;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function makeApp(id, extra = {}) {
  return { id, name: id, ...extra };
}

describe('MyAppsManager (js/platform/ui/my-apps-manager.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    EventLog = { log: vi.fn() };
    globalThis.EventLog = EventLog;
    globalThis.Notify = { show: vi.fn() };
    const sharedAppA = makeApp('com.a');
    AppRegistry = {
      registerApp: vi.fn((app) => app),
      uninstallApp: vi.fn(async () => true),
      // Stable identity: launch counters accumulate on the SAME record, as
      // they do against the real registry.
      getApp: vi.fn((id) => (id === 'com.a' ? sharedAppA : null)),
      getAllApps: vi.fn(() => [
        makeApp('com.a'),
        makeApp('svc.hidden', { systemService: true }),
        makeApp('svc.headless', { headlessSystemService: true }),
      ]),
      onInstall: vi.fn(),
      onUninstall: vi.fn(),
      getStats: vi.fn(() => ({ totalApps: 3, totalLaunches: 7 })),
    };
    globalThis.AppRegistry = AppRegistry;
    MyAppsManager = requireFresh(MAM_PATH);
  });

  afterEach(() => {
    for (const g of ['AppRegistry', 'WM', 'OS', 'AppSandbox', 'AppDirs', 'AppPackage', 'TrustStore', 'Notify', 'EventLog']) {
      delete globalThis[g];
    }
    vi.restoreAllMocks();
  });

  describe('surface', () => {
    it('exposes the documented manager API', () => {
      for (const fn of [
        'initialize', 'addApp', 'removeApp', 'getApp', 'getAllApps', 'launchApp',
        'installFromFile', 'installFromUrl', 'showInstallUI', 'showAppList',
        'showAppDetails', 'onAdd', 'onRemove', 'onLaunch', 'getStats',
      ]) {
        expect(typeof MyAppsManager[fn]).toBe('function');
      }
    });

    it('does not auto-initialize in a DOM-less environment until initialize() is called', () => {
      expect(AppRegistry.onInstall).not.toHaveBeenCalled();

      MyAppsManager.initialize();
      expect(AppRegistry.onInstall).toHaveBeenCalledTimes(1);
      expect(AppRegistry.onUninstall).toHaveBeenCalledTimes(1);
    });
  });

  describe('install/uninstall notifications', () => {
    it('routes registry install events to the onAdd callback and Notify', () => {
      const onAdded = vi.fn();
      MyAppsManager.onAdd(onAdded);
      MyAppsManager.initialize();

      const installCb = AppRegistry.onInstall.mock.calls[0][0];
      const uninstallCb = AppRegistry.onUninstall.mock.calls[0][0];
      const app = makeApp('com.new', { name: 'New App' });

      installCb(app);
      expect(onAdded).toHaveBeenCalledWith(app);
      expect(globalThis.Notify.show).toHaveBeenCalledWith(expect.objectContaining({
        title: 'App Installed',
        body: 'New App has been installed successfully',
        type: 'success',
      }));

      uninstallCb(app);
      expect(globalThis.Notify.show).toHaveBeenLastCalledWith(expect.objectContaining({
        type: 'info',
      }));
    });
  });

  describe('addApp / registry passthrough', () => {
    it('registers through AppRegistry and returns the registered app', () => {
      const appData = makeApp('com.b', { name: 'B' });
      expect(MyAppsManager.addApp(appData)).toBe(appData);
      expect(AppRegistry.registerApp).toHaveBeenCalledWith(appData);
    });

    it('rethrows registration failures after logging them to EventLog', () => {
      AppRegistry.registerApp = vi.fn(() => { throw new Error('duplicate id'); });
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => MyAppsManager.addApp(makeApp('com.a'))).toThrow('duplicate id');
      expect(EventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        app: 'MyAppsManager',
        severity: 'error',
        message: expect.stringContaining('Failed to add app'),
      }));
    });
  });

  describe('removeApp — full data teardown before registry uninstall', () => {
    it('closes the app\'s windows, clears every storage layer, then uninstalls', async () => {
      const closeWindow = vi.fn(async () => {});
      globalThis.WM = { closeWindow };
      globalThis.OS = { windows: new Map([
        ['w1', { appId: 'com.a' }],
        ['w2', { appId: 'com.a' }],
        ['w3', { appId: 'com.other' }],
      ]) };
      globalThis.AppSandbox = {
        clearAppPartition: vi.fn(async () => {}),
        storageClear: vi.fn(async () => {}),
        storageLedger: { removeApp: vi.fn() },
      };
      globalThis.AppDirs = { removeAppData: vi.fn(async () => {}) };

      const result = await MyAppsManager.removeApp('com.a');

      expect(result).toBe(true);
      expect(closeWindow).toHaveBeenCalledTimes(2);
      for (const wid of ['w1', 'w2']) expect(closeWindow).toHaveBeenCalledWith(wid);
      expect(globalThis.AppSandbox.clearAppPartition).toHaveBeenCalledWith('com.a');
      expect(globalThis.AppSandbox.storageClear).toHaveBeenCalledWith('com.a');
      expect(globalThis.AppSandbox.storageLedger.removeApp).toHaveBeenCalledWith('com.a');
      expect(globalThis.AppDirs.removeAppData).toHaveBeenCalledWith('com.a');
      expect(AppRegistry.uninstallApp).toHaveBeenCalledWith('com.a');
    });

    it('degrades gracefully when the sandbox/WM layers are absent', async () => {
      // No WM, OS, AppSandbox or AppDirs defined at all.
      const result = await MyAppsManager.removeApp('com.a');
      expect(result).toBe(true);
      expect(AppRegistry.uninstallApp).toHaveBeenCalledWith('com.a');
    });

    it('returns false (and logs) when the registry uninstall fails', async () => {
      AppRegistry.uninstallApp = vi.fn(async () => { throw new Error('store locked'); });
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await MyAppsManager.removeApp('com.a');
      expect(result).toBe(false);
      expect(EventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'error',
        data: { appId: 'com.a' },
      }));
    });

    it('returns false when there is no registry uninstall hook at all', async () => {
      globalThis.AppRegistry = undefined;
      const result = await MyAppsManager.removeApp('com.a');
      expect(result).toBe(false);
    });
  });

  describe('getAllApps / getApp', () => {
    it('hides system services from the user-facing app list', () => {
      const apps = MyAppsManager.getAllApps();
      expect(apps.map((a) => a.id)).toEqual(['com.a']);
    });

    it('returns the registry record or null', () => {
      expect(MyAppsManager.getApp('com.a')).toEqual(makeApp('com.a'));
      expect(MyAppsManager.getApp('nope')).toBeNull();
    });
  });

  describe('launchApp', () => {
    it('counts the launch and fires onLaunch when no WM window is created', () => {
      const onLaunched = vi.fn();
      MyAppsManager.onLaunch(onLaunched);

      const { app, window: win } = MyAppsManager.launchApp('com.a', { noWindow: true });

      expect(win).toBeUndefined();
      expect(app.launchCount).toBe(1);
      expect(app.lastLaunched).toBeTypeOf('string');
      expect(onLaunched).toHaveBeenCalledWith({ app });

      const { app: second } = MyAppsManager.launchApp('com.a', { noWindow: true });
      expect(second.launchCount).toBe(2);
    });

    it('creates a window through WM and reports both app and window', () => {
      const winStub = { id: 'win-1' };
      globalThis.WM = { createWindow: vi.fn(() => winStub) };
      const onLaunched = vi.fn();
      MyAppsManager.onLaunch(onLaunched);

      const result = MyAppsManager.launchApp('com.a', { windowOptions: { w: 300 } });

      expect(globalThis.WM.createWindow).toHaveBeenCalledWith('com.a', { w: 300 });
      expect(result).toEqual({ app: expect.objectContaining({ id: 'com.a' }), window: winStub });
      expect(onLaunched).toHaveBeenCalledWith({ app: expect.objectContaining({ id: 'com.a' }), window: winStub });
      // WM path does not touch the launch counters.
      expect(result.app.launchCount).toBeUndefined();
    });

    it('throws a descriptive error for unknown apps and logs it', () => {
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(() => MyAppsManager.launchApp('com.ghost')).toThrow('App not found: com.ghost');
      expect(EventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'error',
        data: { appId: 'com.ghost' },
      }));
    });
  });

  describe('installFromFile / installFromUrl', () => {
    it('hands already-parsed package objects to AppPackage with trust-store options merged in', async () => {
      const isRevoked = vi.fn(() => false);
      globalThis.TrustStore = { list: vi.fn(() => [{ name: 'AstroOS Trusted Signing' }]), isRevoked };
      globalThis.AppPackage = { installPackage: vi.fn((pkg, opts) => ({ ok: true, pkg, opts })) };

      const pkg = { novabyte_app: true, manifest: { id: 'com.x' } };
      const result = await MyAppsManager.installFromFile(pkg);

      expect(globalThis.AppPackage.installPackage).toHaveBeenCalledTimes(1);
      const [, opts] = globalThis.AppPackage.installPackage.mock.calls[0];
      expect(opts.trustStore).toEqual([{ name: 'AstroOS Trusted Signing' }]);
      expect(opts.revocationCheck).toBe(isRevoked);
      expect(result.pkg).toBe(pkg);
    });

    it('parses JSON strings and lets caller options override the trust defaults', async () => {
      globalThis.TrustStore = { list: vi.fn(() => ['default']), isRevoked: vi.fn() };
      globalThis.AppPackage = { installPackage: vi.fn(() => ({ ok: true })) };

      await MyAppsManager.installFromFile('{"novabyte_app":true}', { trustStore: ['custom'] });

      const [, opts] = globalThis.AppPackage.installPackage.mock.calls[0];
      expect(opts.trustStore).toEqual(['custom']);
    });

    it('rejects inputs that are neither package objects, Files, nor JSON strings', async () => {
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(MyAppsManager.installFromFile(1234)).rejects.toThrow('Invalid package format');
      // null is typeof 'object', so the source dereferences it before the
      // format check and the raw TypeError surfaces instead.
      await expect(MyAppsManager.installFromFile(null)).rejects.toThrow();
    });

    it('fetches .novaapp packages over HTTP and enforces response.ok', async () => {
      globalThis.AppPackage = { installPackage: vi.fn(() => ({ ok: true })) };
      const pkg = { novabyte_app: true, manifest: { id: 'com.remote' } };
      globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => pkg }));

      await MyAppsManager.installFromUrl('https://localhost/packs/com.remote.novaapp');
      expect(globalThis.AppPackage.installPackage).toHaveBeenCalledTimes(1);
      expect(globalThis.AppPackage.installPackage.mock.calls[0][0]).toEqual(pkg);

      globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
      await expect(
        MyAppsManager.installFromUrl('https://localhost/packs/missing.novaapp'),
      ).rejects.toThrow('HTTP 404: Not Found');
      expect(EventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('Install from URL failed'),
        data: { url: 'https://localhost/packs/missing.novaapp' },
      }));
    });
  });

  describe('getStats', () => {
    it('passes registry stats through', () => {
      expect(MyAppsManager.getStats()).toEqual({ totalApps: 3, totalLaunches: 7 });
    });

    it('falls back to a zeroed shape when the registry is gone', () => {
      globalThis.AppRegistry = undefined;
      expect(MyAppsManager.getStats()).toEqual({
        totalApps: 0, totalLaunches: 0, byCategory: {}, verifiedApps: 0,
      });
    });
  });
});
