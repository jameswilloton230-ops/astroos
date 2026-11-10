import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import RegistryPrefs from '../../../js/platform/core/registry-prefs.js';

// ── app-scheduler.js — Tier 1 scheduled background wakes ────────────────────
// CJS module (module.exports = AppScheduler) that also attaches window.AppScheduler.
// Heavy browser dependencies (document host element, AppSandbox, Temporal,
// AppPermissionManager, OS.apps) are all stubbed per test. Fake timers drive
// the 10s wake deadline and the 15-minute sweep interval deterministically.

const SCHEDULER_PATH = '../../../js/platform/security/app-scheduler.js';

const WAKE_INTERVAL_MS = 15 * 60 * 1000;
const WAKE_DEADLINE_MS = 10 * 1000;

// vi.resetModules() does not bust the CJS require() cache in vitest.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function makeWrapperEl() {
  return { style: { cssText: '' }, isConnected: true, remove: vi.fn() };
}

function setupWorld({ apps = {}, grants = {} } = {}) {
  const host = { appendChild: vi.fn() };
  globalThis.document = {
    getElementById: vi.fn((id) => (id === 'background-app-host' ? host : null)),
    createElement: vi.fn(() => makeWrapperEl()),
  };
  globalThis.OS = { apps };
  globalThis.AppPermissionManager = {
    isGranted: vi.fn((perm, appId) => Boolean(grants[appId])),
  };
  globalThis.AppSandbox = {
    getAllSandboxes: vi.fn(() => []),
    launch: vi.fn(() => ({ success: true, sandboxId: 'sb-owned-1' })),
    dispatchBackgroundWake: vi.fn(() => true),
    destroy: vi.fn(),
  };
  // Disabled-app reads go through RegistryPrefs (registry-backed); with no
  // window.NovaRegistry in this realm it falls back to the legacy
  // localStorage keys these tests seed.
  globalThis.RegistryPrefs = RegistryPrefs;
  // The real NW.js/Chromium runtime provides Temporal; Node does not (yet).
  vi.stubGlobal('Temporal', { Now: { instant: () => ({ toString: () => '2026-01-01T00:00:00.000Z' }) } });
  return host;
}

function bgApp(id) {
  return { id, name: id };
}

describe('AppScheduler (js/platform/security/app-scheduler.js)', () => {
  let Scheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    resetTestStorage();
    Scheduler = requireFresh(SCHEDULER_PATH);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.document;
    delete globalThis.OS;
    delete globalThis.AppPermissionManager;
    delete globalThis.AppSandbox;
    delete globalThis.RegistryPrefs;
  });

  describe('surface', () => {
    it('exposes the documented scheduler API and attaches to window', () => {
      expect(typeof Scheduler.start).toBe('function');
      expect(typeof Scheduler.stop).toBe('function');
      expect(typeof Scheduler.runWakeCycle).toBe('function');
      expect(typeof Scheduler.getEligibleApps).toBe('function');
      expect(typeof Scheduler.requestWake).toBe('function');
      expect(typeof Scheduler._markWakeDone).toBe('function');
      expect(Scheduler._pendingWakes).toBeInstanceOf(Map);
      expect(window.AppScheduler).toBe(Scheduler);
    });
  });

  describe('eligibility — installed, not disabled, and holding system:background', () => {
    it('requires AppPermissionManager and warns once when it is missing', () => {
      setupWorld({ apps: { a: bgApp('a') } });
      globalThis.AppPermissionManager = undefined;

      expect(Scheduler.getEligibleApps()).toEqual([]);
    });

    it('filters out apps without the grant, disabled apps, and malformed entries', () => {
      setupWorld({
        apps: {
          granted: bgApp('granted'),
          ungranted: bgApp('ungranted'),
          noId: { name: 'broken' },
        },
        grants: { granted: true, ungranted: false },
      });
      expect(Scheduler.getEligibleApps().map((a) => a.id)).toEqual(['granted']);

      localStorage.setItem('nova_disabled_apps', JSON.stringify(['granted']));
      expect(Scheduler.getEligibleApps()).toEqual([]);
    });

    it('treats a corrupt disabled-apps list as "none disabled" instead of failing the sweep', () => {
      setupWorld({ apps: { a: bgApp('a') }, grants: { a: true } });
      localStorage.setItem('nova_disabled_apps', '{not json');
      expect(Scheduler.getEligibleApps().map((a) => a.id)).toEqual(['a']);
    });

    it('requestWake honestly reports false for every ineligible case (no sandbox touched)', () => {
      setupWorld({
        apps: { known: bgApp('known'), disabled: bgApp('disabled') },
        grants: { known: true },
      });
      localStorage.setItem('nova_disabled_apps', JSON.stringify(['disabled']));

      expect(Scheduler.requestWake('')).toBe(false);
      expect(Scheduler.requestWake(42)).toBe(false);
      expect(Scheduler.requestWake('unknown-app')).toBe(false);
      expect(Scheduler.requestWake('disabled')).toBe(false);
      // Missing permission manager:
      globalThis.AppPermissionManager = undefined;
      expect(Scheduler.requestWake('known')).toBe(false);
      // Ungranted app:
      globalThis.AppPermissionManager = { isGranted: () => false };
      expect(Scheduler.requestWake('known')).toBe(false);

      expect(globalThis.AppSandbox.launch).not.toHaveBeenCalled();
      expect(globalThis.AppSandbox.dispatchBackgroundWake).not.toHaveBeenCalled();
    });
  });

  describe('wake lifecycle (owned sandboxes)', () => {
    it('launches a headless sandbox into #background-app-host and dispatches the wake push', () => {
      const host = setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      const { AppSandbox } = globalThis;

      Scheduler.runWakeCycle();

      expect(AppSandbox.launch).toHaveBeenCalledTimes(1);
      const [appArg, wrapperEl, stateArg, optionsArg] = AppSandbox.launch.mock.calls[0];
      expect(appArg.id).toBe('bg');
      expect(stateArg).toBeNull();
      expect(optionsArg).toEqual({});
      expect(host.appendChild).toHaveBeenCalledWith(wrapperEl);
      expect(wrapperEl.style.cssText).toContain('overflow:hidden');

      expect(AppSandbox.dispatchBackgroundWake).toHaveBeenCalledWith('sb-owned-1', {
        wokeAt: '2026-01-01T00:00:00.000Z',
        deadlineMs: WAKE_DEADLINE_MS,
      });
      const pending = Scheduler._pendingWakes.get('sb-owned-1');
      expect(pending).toMatchObject({ appId: 'bg', ownedByScheduler: true });
    });

    it('tears the owned sandbox down when the 10s wake deadline expires', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      Scheduler.runWakeCycle();

      vi.advanceTimersByTime(WAKE_DEADLINE_MS);

      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledWith('sb-owned-1');
      const wrapperEl = globalThis.AppSandbox.launch.mock.calls[0][1];
      expect(wrapperEl.remove).toHaveBeenCalled();
      expect(Scheduler._pendingWakes.has('sb-owned-1')).toBe(false);
    });

    it('tears down early via _markWakeDone and cancels the deadline timer', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      Scheduler.runWakeCycle();

      Scheduler._markWakeDone('sb-owned-1');
      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledTimes(1);
      expect(Scheduler._pendingWakes.has('sb-owned-1')).toBe(false);

      // Deadline later fires into the void — no double teardown.
      vi.advanceTimersByTime(WAKE_DEADLINE_MS + 1);
      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledTimes(1);
    });

    it('skips the wake entirely when #background-app-host is missing', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      globalThis.document.getElementById = vi.fn(() => null);

      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.launch).not.toHaveBeenCalled();
      expect(globalThis.AppSandbox.dispatchBackgroundWake).not.toHaveBeenCalled();
      expect(Scheduler._pendingWakes.size).toBe(0);
    });

    it('cleans up the wrapper and dispatches nothing when launch fails or throws', () => {
      setupWorld({ apps: { a: bgApp('a') }, grants: { a: true } });
      globalThis.AppSandbox.launch = vi.fn(() => ({ success: false }));
      Scheduler.runWakeCycle();
      expect(globalThis.AppSandbox.dispatchBackgroundWake).not.toHaveBeenCalled();
      expect(globalThis.AppSandbox.destroy).not.toHaveBeenCalled();
      const failedWrapper = globalThis.document.createElement.mock.results[0].value;
      expect(failedWrapper.remove).toHaveBeenCalled();

      // Launch throwing must also be contained (no exception escapes the sweep).
      Scheduler = requireFresh(SCHEDULER_PATH);
      globalThis.AppSandbox.launch = vi.fn(() => { throw new Error('sandbox exploded'); });
      expect(() => Scheduler.runWakeCycle()).not.toThrow();
      expect(Scheduler._pendingWakes.size).toBe(0);
    });
  });

  describe('fail-closed teardown', () => {
    it('destroys the owned sandbox when dispatchBackgroundWake reports failure', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      globalThis.AppSandbox.dispatchBackgroundWake = vi.fn(() => false);

      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledWith('sb-owned-1');
      const wrapperEl = globalThis.AppSandbox.launch.mock.calls[0][1];
      expect(wrapperEl.remove).toHaveBeenCalled();
      expect(Scheduler._pendingWakes.size).toBe(0);
    });

    it('destroys the owned sandbox when the wake push dispatch throws (e.g. Temporal missing)', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      // Node runtimes have no Temporal — the wake push cannot even build its
      // payload. The scheduler must fail closed: no half-woken sandbox left.
      vi.stubGlobal('Temporal', undefined);

      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.dispatchBackgroundWake).not.toHaveBeenCalled();
      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledWith('sb-owned-1');
      expect(Scheduler._pendingWakes.size).toBe(0);
    });

    it('one app failing its wake does not cost the other apps their wake', () => {
      setupWorld({ apps: { bad: bgApp('bad'), good: bgApp('good') }, grants: { bad: true, good: true } });
      globalThis.AppSandbox.launch = vi.fn()
        .mockImplementationOnce(() => { throw new Error('first app is broken'); })
        .mockImplementationOnce(() => ({ success: true, sandboxId: 'sb-good' }));

      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledWith('sb-good', expect.anything());
      expect(Scheduler._pendingWakes.has('sb-good')).toBe(true);
    });
  });

  describe('Tier-2 sandbox reuse', () => {
    it('piggybacks the wake onto a live backgrounded sandbox without owning its lifecycle', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      globalThis.AppSandbox.getAllSandboxes = vi.fn(() => [
        { sandboxId: 'sb-tier2', appId: 'bg', backgrounded: true },
      ]);

      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.launch).not.toHaveBeenCalled();
      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledWith('sb-tier2', expect.objectContaining({ deadlineMs: WAKE_DEADLINE_MS }));
      expect(Scheduler._pendingWakes.get('sb-tier2')).toMatchObject({ ownedByScheduler: false });

      // Deadline expiry must NOT kill someone else's Tier-2 sandbox.
      vi.advanceTimersByTime(WAKE_DEADLINE_MS);
      expect(globalThis.AppSandbox.destroy).not.toHaveBeenCalled();
      expect(Scheduler._pendingWakes.size).toBe(0);
    });

    it('never double-dispatches a wake to a sandbox that is already mid-wake', () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });
      globalThis.AppSandbox.getAllSandboxes = vi.fn(() => [
        { sandboxId: 'sb-tier2', appId: 'bg', backgrounded: true },
      ]);

      Scheduler.runWakeCycle();
      Scheduler.runWakeCycle();

      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledTimes(1);
      expect(globalThis.AppSandbox.destroy).not.toHaveBeenCalled();
    });
  });

  describe('start / stop', () => {
    it('sweeps every 15 minutes, ignores duplicate start() calls, and stops cleanly', async () => {
      setupWorld({ apps: { bg: bgApp('bg') }, grants: { bg: true } });

      Scheduler.start();
      Scheduler.start(); // second call must not stack a second interval
      await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS);
      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledTimes(1);

      // Land just before the next sweep, then cross it: exactly one more wake,
      // proving the duplicate start() did not stack intervals.
      await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS - WAKE_DEADLINE_MS);
      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(WAKE_DEADLINE_MS);
      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledTimes(2);

      // Mid-wake stop(): the owned sandbox is torn down and the interval is gone.
      Scheduler.stop();
      expect(globalThis.AppSandbox.destroy).toHaveBeenCalledWith('sb-owned-1');
      expect(Scheduler._pendingWakes.size).toBe(0);

      const callsAtStop = globalThis.AppSandbox.dispatchBackgroundWake.mock.calls.length;
      await vi.advanceTimersByTimeAsync(WAKE_INTERVAL_MS * 3);
      expect(globalThis.AppSandbox.dispatchBackgroundWake).toHaveBeenCalledTimes(callsAtStop);
    });
  });
});
