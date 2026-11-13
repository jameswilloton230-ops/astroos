import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

// ── kernel.js is a window-attach script (no module.exports): it publishes
// window.OS and window.getPinSalt. We require() it fresh per test (with
// vi.resetModules) so every test gets a pristine OS singleton.
//
// kernel.js's settings.set() persists to the REAL Linux home directory
// (~/.config/novabyte/settings.json) when process.platform === 'linux'.
// Tests redirect $HOME to a temp dir (os.homedir() honours $HOME on POSIX)
// so the native write path can be exercised without touching the real
// user profile or the repo working tree.

const KERNEL_PATH = '../../../js/core/core/kernel.js';

let fakeFsWorker;
let savedHome;
let tmpHome;
let savedConsoleError;

// vi.resetModules() does not bust the CJS require() cache in vitest, so
// re-require requires an explicit cache eviction to get a pristine OS.
function requireFresh(path) {
  const resolved = require.resolve(path);
  if (require.cache && require.cache[resolved]) delete require.cache[resolved];
  return require(path);
}

function loadKernel() {
  fakeFsWorker = { call: vi.fn(async () => ({})) };
  requireFresh(KERNEL_PATH);
  // The freshly created OS singleton is the same object window.OS points at.
  const OS = window.OS;
  OS.workers.fs = fakeFsWorker;
  return OS;
}

function nativeSettingsPath() {
  return nodePath.join(tmpHome, '.config', 'novabyte', 'settings.json');
}

describe('OS kernel (js/core/core/kernel.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    tmpHome = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'astroos-kernel-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = tmpHome;
    savedConsoleError = console.error;
  });

  afterEach(() => {
    console.error = savedConsoleError;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    nodeFs.rmSync(tmpHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('surface', () => {
    it('exposes the OS singleton and its documented subsystems on window', () => {
      const OS = loadKernel();
      expect(OS).toBeTypeOf('object');
      expect(OS.version).toBe('3.0.2');
      expect(OS.securityPatch).toBe('2026-11-12');
      expect(typeof window.getPinSalt).toBe('function');
      expect(typeof OS.events.on).toBe('function');
      expect(typeof OS.events.off).toBe('function');
      expect(typeof OS.events.emit).toBe('function');
      expect(typeof OS.settings.get).toBe('function');
      expect(typeof OS.settings.set).toBe('function');
      expect(typeof OS.settings.load).toBe('function');
      expect(typeof OS.settings.applySafeModeDefaults).toBe('function');
      expect(typeof OS.logger.debug).toBe('function');
      expect(typeof OS.logger.info).toBe('function');
      expect(typeof OS.logger.warn).toBe('function');
      expect(typeof OS.logger.error).toBe('function');
      expect(OS.windows).toBeInstanceOf(Map);
      expect(OS.workspaces).toEqual([{ id: 1, name: 'Workspace 1', windows: [] }]);
      expect(OS.currentWorkspace).toBe(1);
      expect(OS.maxWorkspaces).toBe(6);
      expect(OS.isLocked).toBe(false);
    });

    it('ships the documented default settings', () => {
      const OS = loadKernel();
      expect(OS.settings.defaults.theme).toBe('nova-dark');
      expect(OS.settings.defaults.clockFormat).toBe('12h');
      expect(OS.settings.defaults.wallpaper).toBe('stock-blue');
      expect(OS.settings.defaults.pinnedApps).toEqual([]);
      expect(OS.settings.defaults.username).toBe('user');
    });
  });

  describe('OS.events', () => {
    it('delivers emitted payloads to on() handlers and stops after off()', () => {
      const OS = loadKernel();
      const seen = [];
      const handler = (data) => seen.push(data);
      OS.events.on('test:event', handler);
      OS.events.emit('test:event', { n: 1 });
      expect(seen).toEqual([{ n: 1 }]);

      OS.events.off('test:event', handler);
      OS.events.emit('test:event', { n: 2 });
      expect(seen).toEqual([{ n: 1 }]);
    });

    it('calls every registered handler in order', () => {
      const OS = loadKernel();
      const order = [];
      OS.events.on('multi', () => order.push('first'));
      OS.events.on('multi', () => order.push('second'));
      OS.events.emit('multi', null);
      expect(order).toEqual(['first', 'second']);
    });

    it('isolates a throwing listener: later handlers still run and the error is logged', () => {
      const OS = loadKernel();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const later = vi.fn();
      OS.events.on('boom', () => { throw new Error('listener exploded'); });
      OS.events.on('boom', later);

      expect(() => OS.events.emit('boom', null)).not.toThrow();
      expect(later).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalled();
    });

    it('uses snapshot semantics: a handler removed mid-emit still gets that emit', () => {
      const OS = loadKernel();
      const second = vi.fn();
      OS.events.on('snap', () => OS.events.off('snap', second));
      OS.events.on('snap', second);
      OS.events.emit('snap', null);
      // Removed before its turn, but the emit iterates a snapshot taken up-front.
      expect(second).toHaveBeenCalledTimes(1);
      // ...and it is genuinely gone for subsequent emits.
      OS.events.emit('snap', null);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('emitting an event with no handlers is a silent no-op', () => {
      const OS = loadKernel();
      expect(() => OS.events.emit('nobody-listens', { x: 1 })).not.toThrow();
    });
  });

  describe('OS.settings', () => {
    it('falls back to defaults and returns deep clones, never live cache references', () => {
      const OS = loadKernel();
      expect(OS.settings.get('theme')).toBe('nova-dark');

      OS.settings.set('pinnedApps', [{ id: 'a' }]);
      const first = OS.settings.get('pinnedApps');
      expect(first).toEqual([{ id: 'a' }]);
      expect(first).not.toBe(OS.settings._cache.pinnedApps);
      // Mutating the returned snapshot must not leak into the cache.
      first[0].id = 'hacked';
      first.push({ id: 'extra' });
      expect(OS.settings.get('pinnedApps')).toEqual([{ id: 'a' }]);
    });

    it('persists set() to the native Linux settings file and emits settings:changed', () => {
      const OS = loadKernel();
      const changes = [];
      OS.events.on('settings:changed', (e) => changes.push(e));

      OS.settings.set('theme', 'midnight');

      expect(changes).toEqual([{ key: 'theme', value: 'midnight' }]);
      const raw = JSON.parse(nodeFs.readFileSync(nativeSettingsPath(), 'utf8'));
      expect(raw.theme).toBe('midnight');
    });

    it('routes persistence through the fs worker instead of the filesystem off Linux', () => {
      // process.platform is read-only on modern Node; defineProperty is the
      // only way to exercise the non-Linux branch of settings.set().
      const desc = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      try {
        const OS = loadKernel();
        OS.settings.set('clockFormat', '24h');
        expect(fakeFsWorker.call).toHaveBeenCalledWith('putSetting', 'clockFormat', '24h');
        // No native file written on this branch.
        expect(nodeFs.existsSync(nativeSettingsPath())).toBe(false);
      } finally {
        Object.defineProperty(process, 'platform', desc);
      }
    });

    it('refuses wallpaper changes while prohibitWallpaperChange is locked on', () => {
      const OS = loadKernel();
      OS.settings.set('prohibitWallpaperChange', true);

      expect(OS.settings.set('wallpaperId', 'w-42')).toBe(false);
      expect(OS.settings.set('customWallpaper', 'data:image/png;base64,AAA')).toBe(false);
      expect(OS.settings.set('customWallpaperName', 'evil.png')).toBe(false);
      // Cache untouched — the deny is real, not just a falsy return.
      expect(OS.settings.get('wallpaperId')).toBeUndefined();
      expect(OS.settings.get('customWallpaper')).toBeUndefined();
      // Unrelated keys are still writable while the wallpaper lock is on.
      expect(OS.settings.set('theme', 'nova-dark')).toBeUndefined();
      expect(OS.settings.get('theme')).toBe('nova-dark');
    });

    it('applySafeModeDefaults resets the session to defaults without persisting', () => {
      const OS = loadKernel();
      OS.settings.set('fontSize', '99');
      expect(OS.settings.get('fontSize')).toBe('99');

      OS.settings.applySafeModeDefaults();
      expect(OS.settings.get('fontSize')).toBe('14');
    });

    it('load() hydrates the cache from the native Linux settings file', async () => {
      nodeFs.mkdirSync(nodePath.dirname(nativeSettingsPath()), { recursive: true });
      nodeFs.writeFileSync(nativeSettingsPath(), JSON.stringify({ theme: 'restored-theme' }));

      const OS = loadKernel();
      await OS.settings.load();
      expect(OS.settings.get('theme')).toBe('restored-theme');
      expect(OS.settings.get('clockFormat')).toBe('12h'); // default still applies
    });

    it('load() rethrows a corrupt (non-ENOENT) settings file failure instead of silently defaulting', async () => {
      nodeFs.mkdirSync(nodePath.dirname(nativeSettingsPath()), { recursive: true });
      nodeFs.writeFileSync(nativeSettingsPath(), '{not json');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const OS = loadKernel();
      await expect(OS.settings.load()).rejects.toThrow();
      expect(errSpy).toHaveBeenCalled();
    });

    it('load() rejects a settings file whose JSON root is not an object', async () => {
      nodeFs.mkdirSync(nodePath.dirname(nativeSettingsPath()), { recursive: true });
      nodeFs.writeFileSync(nativeSettingsPath(), '[1,2,3]');

      const OS = loadKernel();
      await expect(OS.settings.load()).rejects.toThrow('Settings file must contain a JSON object');
    });
  });

  describe('getPinSalt', () => {
    it('generates a stable hex salt — or, on runtimes without Uint8Array.toHex, throws (current behavior)', () => {
      const OS = loadKernel();
      if (typeof new Uint8Array(1).toHex !== 'function') {
        // CURRENT BEHAVIOR / SOURCE QUIRK: kernel.js calls saltBuffer.toHex(),
        // an ES2024 Uint8Array method this Node runtime (v24.22.2) does not
        // ship, so getPinSalt() throws a TypeError here. It works in the
        // NW.js Chromium runtime the OS actually targets. Asserted as-is —
        // not fixed — per task rules.
        expect(() => window.getPinSalt()).toThrow(TypeError);
        return;
      }
      const salt = window.getPinSalt();
      expect(salt).toMatch(/^[0-9a-f]{32}$/);
      expect(window.getPinSalt()).toBe(salt);
      expect(OS.settings.get('pinSalt')).toBe(salt);
    });
  });
});
