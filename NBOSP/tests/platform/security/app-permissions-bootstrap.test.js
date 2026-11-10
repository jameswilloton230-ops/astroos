import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// ── app-permissions-bootstrap.js — boot-time permission bootstrap + web-app gate
// Window-attach script (no module.exports; publishes window.AppPermissionsMap)
// that auto-runs bootstrap() on a microtask after load. AppPermissionManager
// and OS are stubbed globals. The module's _watchForNewWebApps() registers a
// real 2s interval for 5 minutes — setInterval/setTimeout are no-op'd while
// the module loads so no timer outlives a test.

const BOOTSTRAP_PATH = '../../../js/platform/security/app-permissions-bootstrap.js';

let realSetInterval;
let realSetTimeout;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function makeApm() {
  return {
    isGranted: vi.fn(() => false),
    isDenied: vi.fn(() => false),
    grantPermission: vi.fn(async () => {}),
    requestAll: vi.fn(async () => true),
    autoGrantLowRisk: vi.fn(async () => true),
  };
}

async function loadBootstrap({ apps = {}, preStore = {}, noApm = false } = {}) {
  realSetInterval = globalThis.setInterval;
  realSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = () => 0; // swallow _watchForNewWebApps' watcher
  globalThis.setTimeout = () => 0;

  for (const [k, v] of Object.entries(preStore)) localStorage.setItem(k, v);
  globalThis.OS = { apps };
  if (!noApm) globalThis.AppPermissionManager = makeApm();
  // The module reads document.readyState unguarded at load time.
  globalThis.document = { readyState: 'complete', addEventListener: vi.fn() };

  requireFresh(BOOTSTRAP_PATH);
  // bootstrap() is scheduled with Promise.resolve().then(...) — flush microtasks.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('AppPermissionsBootstrap (js/platform/security/app-permissions-bootstrap.js)', () => {
  beforeEach(() => {
    resetTestStorage();
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.OS;
    delete globalThis.AppPermissionManager;
    delete globalThis.document;
    vi.restoreAllMocks();
  });

  describe('surface', () => {
    it('exposes the (intentionally empty, frozen) built-in permission map on window', async () => {
      await loadBootstrap();
      expect(window.AppPermissionsMap).toBeDefined();
      expect(Object.isFrozen(window.AppPermissionsMap)).toBe(true);
      expect(Object.keys(window.AppPermissionsMap)).toEqual([]);
    });
  });

  describe('bootstrap() guards', () => {
    it('skips with a warning when AppPermissionManager is not loaded', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await loadBootstrap({ apps: { wa_x: { name: 'X', init: vi.fn() } }, noApm: true });

      expect(warnSpy).toHaveBeenCalledWith('[PermBootstrap] AppPermissionManager not loaded — skipping');
      // Nothing was bootstrapped or gated.
      expect(localStorage.getItem('nova_perms_bootstrapped')).toBeNull();
      expect(globalThis.OS.apps.wa_x.__permWrapped).toBeFalsy();
    });

    it('marks the first boot in localStorage and logs completion', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await loadBootstrap({ apps: {} });

      expect(localStorage.getItem('nova_perms_bootstrapped')).toBe('1');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('First boot — pre-granting normal permissions'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bootstrap complete'));
    });

    it('does not re-run the first-boot pre-grant on subsequent boots', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await loadBootstrap({ preStore: { nova_perms_bootstrapped: '1' } });

      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('First boot'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Bootstrap complete'));
      expect(localStorage.getItem('nova_perms_bootstrapped')).toBe('1');
    });
  });

  describe('third-party / web-app gating', () => {
    it('wraps web apps (wa_/webapp_/flagged) with the permission gate at boot', async () => {
      const notesInit = vi.fn();
      await loadBootstrap({
        apps: {
          wa_testapp: { name: 'Test WA', init: vi.fn() },
          'webapp_other': { name: 'Other WA', init: vi.fn() },
          'com.nbosp.notes': { name: 'Built-in', init: notesInit }, // not a web app id
        },
      });

      expect(globalThis.OS.apps.wa_testapp.__isWebApp).toBe(true);
      expect(globalThis.OS.apps.wa_testapp.__permWrapped).toBe(true);
      expect(globalThis.OS.apps['webapp_other'].__permWrapped).toBe(true);
      // Non-web-app built-ins are left untouched (the legacy map is empty).
      expect(globalThis.OS.apps['com.nbosp.notes'].__permWrapped).toBeFalsy();
      expect(globalThis.OS.apps['com.nbosp.notes'].init).toBe(notesInit);
    });

    it('gated init auto-grants low-risk network access and prompts for missing dangerous permissions', async () => {
      const originalInit = vi.fn();
      await loadBootstrap({ apps: { wa_camera: { name: 'Camera WA', init: originalInit } } });
      const mgr = globalThis.AppPermissionManager;

      await globalThis.OS.apps.wa_camera.init({ id: 'content' }, {}, {});

      expect(mgr.autoGrantLowRisk).toHaveBeenCalledWith('net:external', 'wa_camera');
      expect(mgr.autoGrantLowRisk).toHaveBeenCalledWith('net:websocket', 'wa_camera');
      expect(mgr.requestAll).toHaveBeenCalledWith(
        ['device:camera', 'device:microphone', 'device:geolocation'],
        'wa_camera',
        'Camera WA',
      );
      // Denial never blocks launch — the real init still runs.
      expect(originalInit).toHaveBeenCalledTimes(1);
    });

    it('does not re-prompt permissions the user already denied — init proceeds anyway', async () => {
      const originalInit = vi.fn();
      await loadBootstrap({ apps: { wa_denied: { name: 'Denied WA', init: originalInit } } });
      const mgr = globalThis.AppPermissionManager;
      mgr.isGranted = vi.fn(() => false);
      mgr.isDenied = vi.fn(() => true); // user denied everything previously

      await globalThis.OS.apps.wa_denied.init(null, {}, {});

      expect(mgr.requestAll).not.toHaveBeenCalled();
      expect(originalInit).toHaveBeenCalledTimes(1);
    });

    it('skips prompts entirely when all dangerous permissions are already granted', async () => {
      const originalInit = vi.fn();
      await loadBootstrap({ apps: { wa_granted: { name: 'Granted WA', init: originalInit } } });
      const mgr = globalThis.AppPermissionManager;
      mgr.isGranted = vi.fn(() => true);

      await globalThis.OS.apps.wa_granted.init(null, {}, {});
      expect(mgr.requestAll).not.toHaveBeenCalled();
      expect(originalInit).toHaveBeenCalledTimes(1);
    });

    it('ignores entries without init and leaves non-web ids unflagged', async () => {
      await loadBootstrap({ apps: { wa_headless: { name: 'No init' } } });
      expect(globalThis.OS.apps.wa_headless.__isWebApp).toBeFalsy();
      expect(globalThis.OS.apps.wa_headless.__permWrapped).toBeFalsy();
    });
  });
});
