// tests/platform/core/settings-shim.test.js — the registry-backed OS.settings.
//
// The shim is what makes the NovaByte Registry the OS configuration source
// of truth: settings.set commits straight into the hives, settings.load
// hydrates from them (adopting the legacy store exactly once), and external
// registry writes fan back out through 'settings:changed'. Every test runs
// against the same memory-store + event-recorder harness as the engine
// suite, with the legacy channel forced onto the web path so nothing ever
// touches the real user settings file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import Shim from '../../../js/platform/core/settings-shim.js';

function memStorage() {
  const map = new Map();
  return {
    _map: map,
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function makeBus() {
  const listeners = {};
  const events = [];
  return {
    events,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, data) {
      events.push({ name, data });
      for (const fn of (listeners[name] || []).slice()) fn(data);
    },
  };
}

// Legacy-shaped OS.settings — exactly the surface kernel.js exposes before
// the shim replaces set()/load().
function makeSettings() {
  return {
    _cache: {},
    volatile: false,
    defaults: { theme: 'nova-dark', clockFormat: '12h', pinnedApps: [] },
    get(key) {
      const val = this._cache[key] !== undefined ? this._cache[key] : this.defaults[key];
      if (val !== null && typeof val === 'object') return structuredClone(val);
      return val;
    },
    applySafeModeDefaults() { this._cache = {}; },
    // Original legacy load — records that the fallback path ran.
    async legacyLoadMarker() { this._legacyLoadRan = true; },
    load() { return this.legacyLoadMarker(); },
  };
}

function freshOS({ legacyStore = {}, workerFail = false } = {}) {
  const bus = makeBus();
  const workerCalls = [];
  const settings = makeSettings();
  const OS = {
    settings,
    events: bus,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    workers: {
      fs: {
        call: async (method, ...args) => {
          workerCalls.push([method, ...args]);
          if (workerFail) throw new Error('worker down');
          if (method === 'getAllSettings') return legacyStore;
          return undefined;
        },
      },
    },
  };
  return { OS, bus, settings, workerCalls };
}

// Fresh registry sharing the OS event bus — exactly how boot wires the
// engine and the shell together (the shim's external-write fan-out depends
// on both ends using the same bus).
function freshRegistry(bus) {
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
  return NovaRegistry;
}

function settingsEvents(bus) {
  return bus.events.filter((e) => e.name === 'settings:changed').map((e) => e.data);
}

beforeEach(() => {
  // Tests must never read or write the real user settings file.
  Shim._internal.setLinuxRuntime(false);
});

afterEach(() => {
  // Spies on the engine singleton must never leak into the next test.
  vi.restoreAllMocks();
});

describe('settings shim (js/platform/core/settings-shim.js)', () => {
  // Registry + OS share one bus, like boot does; call after freshOS().
  function attachAll(OS) {
    const Reg = freshRegistry(OS.events);
    Shim.attach(OS, Reg);
    return Reg;
  }

  it('refuses to attach without a usable registry and leaves settings untouched', () => {
    const { OS, settings } = freshOS();
    const Reg = freshRegistry(OS.events);
    const originalSet = settings.set;
    expect(Shim.attach(OS, null)).toBe(false);
    expect(Shim.attach(null, Reg)).toBe(false);
    expect(OS.settings.set).toBe(originalSet);
    expect(OS.settings.__registryBacked).toBeUndefined();
  });

  it('commits settings.set straight into the registry hive and emits once', () => {
    const { OS, bus } = freshOS();
    const Reg = attachAll(OS);

    OS.settings.set('clockFormat', '24h');
    expect(Reg.get('HKNU/settings/clockFormat')).toBe('24h');
    expect(OS.settings.get('clockFormat')).toBe('24h');
    const evts = settingsEvents(bus).filter((e) => e.key === 'clockFormat');
    expect(evts).toEqual([{ key: 'clockFormat', value: '24h' }]);
    // Audited with the shell actor, tagged with the settings source.
    const audit = Reg.audit().filter((e) => e.path === 'HKNU/settings/clockFormat');
    expect(audit.length).toBe(1);
    expect(audit[0].actor).toBe('shell');
  });

  it('routes mapped keys to their canonical paths (theme → HKNS/shell/theme)', () => {
    const { OS } = freshOS();
    const Reg = attachAll(OS);
    OS.settings.set('theme', 'dracula');
    expect(Reg.get('HKNS/shell/theme')).toBe('dracula');
    expect(Reg.stat('HKNU/settings/theme')).toBeNull();
  });

  it('files unknown runtime keys under HKNU/settings automatically', () => {
    const { OS } = freshOS();
    const Reg = attachAll(OS);
    OS.settings.set('someFuturePref', { a: 1 });
    expect(Reg.get('HKNU/settings/someFuturePref')).toEqual({ a: 1 });
  });

  it('keeps excluded oversized keys (customWallpaper) on the legacy channel', () => {
    const { OS, workerCalls } = freshOS({ legacyStore: {} });
    const Reg = attachAll(OS);
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(1000);
    OS.settings.set('customWallpaper', dataUrl);
    expect(Reg.stat('HKNU/settings/customWallpaper')).toBeNull();
    expect(Reg.stat('HKNU/settings/customWallpaperName')).toBeNull();
    expect(workerCalls.some(([m, k]) => m === 'putSetting' && k === 'customWallpaper')).toBe(true);
    expect(OS.settings.get('customWallpaper')).toBe(dataUrl);
  });

  it('enforces the wallpaper-change policy before anything is persisted', () => {
    const { OS, bus } = freshOS();
    const Reg = attachAll(OS);
    Reg.set('HKNS/security/policy/prohibitWallpaperChange', true, { type: 'REG_BOOL' });
    OS.settings._cache.prohibitWallpaperChange = true;

    expect(OS.settings.set('wallpaperId', 'stock-red')).toBe(false);
    expect(Reg.get('HKNS/shell/wallpaper')).toBeUndefined();
    expect(settingsEvents(bus).filter((e) => e.key === 'wallpaperId')).toEqual([]);
  });

  it('skips all persistence in volatile (Safe Mode) sessions but still applies live', () => {
    const { OS, bus } = freshOS();
    const Reg = attachAll(OS);
    OS.settings.volatile = true;
    OS.settings.set('theme', 'nord');
    expect(Reg.get('HKNS/shell/theme')).toBeUndefined();
    expect(OS.settings.get('theme')).toBe('nord');
    expect(settingsEvents(bus).filter((e) => e.key === 'theme')).toEqual([{ key: 'theme', value: 'nord' }]);
  });

  it('falls back to the legacy store when a registry write throws', () => {
    const { OS, workerCalls } = freshOS();
    const Reg = attachAll(OS);
    const originalSet = Reg.set.bind(Reg);
    vi.spyOn(Reg, 'set').mockImplementation((path, value, opts) => {
      if (String(path).startsWith('HKNU/settings/')) throw new Error('hive sealed');
      return originalSet(path, value, opts);
    });
    OS.settings.set('clockFormat', '24h');
    expect(workerCalls.some(([m, k]) => m === 'putSetting' && k === 'clockFormat')).toBe(true);
    expect(OS.settings.get('clockFormat')).toBe('24h');
  });

  describe('load() — hydration & legacy adoption', () => {
    it('hydrates the cache from the registry and adopts the legacy store exactly once', async () => {
      const legacy = { theme: 'dracula', clockFormat: '24h', autoLock: '30', customWallpaper: 'data:image/png;base64,xyz' };
      const { OS } = freshOS({ legacyStore: legacy });
      const Reg = attachAll(OS);
      Reg.ensureDefaults(Reg.BOOT_DEFAULTS); // boot seeds first — adoption must beat them

      await OS.settings.load();

      expect(OS.settings.get('theme')).toBe('dracula'); // adopted over the seed
      expect(Reg.get('HKNS/shell/theme')).toBe('dracula');
      expect(OS.settings.get('clockFormat')).toBe('24h');
      expect(OS.settings.get('autoLock')).toBe('30');
      expect(OS.settings.get('customWallpaper')).toBe('data:image/png;base64,xyz');
      expect(Reg.stat('HKND/_migration/registrySourceDone')).not.toBeNull();

      // Second boot: the guard holds — legacy edits after adoption are ignored.
      legacy.theme = 'gruvbox';
      const { OS: OS2 } = freshOS({ legacyStore: legacy });
      // Same registry state (no reset) — simulates the next boot.
      Shim.attach(OS2, Reg);
      await OS2.settings.load();
      expect(OS2.settings.get('theme')).toBe('dracula');
    });

    it('hydrates generic areas (HKNS/system, HKNS/security) and mapped keys alike', async () => {
      const { OS } = freshOS({ legacyStore: {} });
      const Reg = attachAll(OS);
      Reg.set('HKNS/system/osVersion', '3.0.2', { type: 'REG_SZ' });
      Reg.set('HKNS/security/lockPin', 'hashed-pin', { type: 'REG_SZ' });

      await OS.settings.load();

      expect(OS.settings.get('osVersion')).toBe('3.0.2');
      expect(OS.settings.get('lockPin')).toBe('hashed-pin');
    });

    it('falls back to the legacy load when registry hydration throws', async () => {
      const { OS, settings } = freshOS();
      const Reg = attachAll(OS);
      vi.spyOn(Reg, 'get').mockImplementation(() => { throw new Error('hive corrupt'); });
      await OS.settings.load();
      expect(settings._legacyLoadRan).toBe(true);
    });
  });

  describe('external registry writes fan back into settings', () => {
    it('syncs the cache and re-emits settings:changed for a NovaReg-style write', () => {
      const { OS, bus } = freshOS();
      const Reg = attachAll(OS);
      OS.settings.set('theme', 'dracula');
      const before = settingsEvents(bus).length;

      Reg.set('HKNS/shell/theme', 'gruvbox', { source: 'app', appId: 'com.nbosp.novareg' });

      expect(OS.settings.get('theme')).toBe('gruvbox');
      const evts = settingsEvents(bus).filter((e) => e.key === 'theme');
      expect(evts.length).toBe(before + 1);
      expect(evts.at(-1)).toEqual({ key: 'theme', value: 'gruvbox' });
    });

    it('does not double-emit for its own writes (source "settings")', () => {
      const { OS, bus } = freshOS();
      attachAll(OS);
      OS.settings.set('clockFormat', '24h');
      expect(settingsEvents(bus).filter((e) => e.key === 'clockFormat').length).toBe(1);
    });

    it('applies removals: a deleted value falls back to the code default', () => {
      const { OS, bus } = freshOS();
      const Reg = attachAll(OS);
      OS.settings.set('clockFormat', '24h');
      Reg.remove('HKNU/settings/clockFormat', { source: 'app', appId: 'com.nbosp.novareg' });
      expect(OS.settings.get('clockFormat')).toBe('12h'); // defaults again
      expect(settingsEvents(bus).filter((e) => e.key === 'clockFormat').length).toBe(2);
    });

    it('deep-clones external values so the cache never aliases hive data', () => {
      const { OS } = freshOS();
      const Reg = attachAll(OS);
      Reg.set('HKNU/settings/pinnedApps', ['com.nbosp.files'], { type: 'REG_JSON' });
      const fromCache = OS.settings.get('pinnedApps');
      fromCache.push('mutated');
      expect(Reg.get('HKNU/settings/pinnedApps')).toEqual(['com.nbosp.files']);
      expect(OS.settings.get('pinnedApps')).toEqual(['com.nbosp.files']);
    });

    it('ignores registry paths that do not back a settings key', () => {
      const { OS, bus } = freshOS();
      const Reg = attachAll(OS);
      Reg.set('HKNA/com.other.app/volume', 5, { source: 'app', appId: 'com.other.app' });
      expect(settingsEvents(bus)).toEqual([]);
      expect(bus.events.some((e) => e.name === 'nova:reg:changed')).toBe(true);
    });
  });

  it('attaches only once even when boot calls it twice', () => {
    const { OS } = freshOS();
    const Reg = freshRegistry(OS.events);
    expect(Shim.attach(OS, Reg)).toBe(true);
    const patched = OS.settings.set;
    expect(Shim.attach(OS, Reg)).toBe(true);
    expect(OS.settings.set).toBe(patched);
  });
});
