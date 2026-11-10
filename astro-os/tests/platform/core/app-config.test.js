// tests/platform/core/app-config.test.js — the HKNA per-app config
// accessor built-in apps use instead of ad-hoc localStorage keys.
//
// NovaAppConfig resolves HKNA/<appId>/<relPath>, adopts each legacy
// localStorage key exactly once (guarded per path under
// HKND/_migration/appConfig), coerces legacy strings to the REG_* value
// shape, and falls back to localStorage when no engine is up.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import NovaAppConfig from '../../../js/platform/core/app-config.js';
import { resetTestStorage } from '../../setup.js';

function memStorage() {
  const map = new Map();
  return {
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

function freshRegistry() {
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage: memStorage(), events: null, logger: console });
  return NovaRegistry;
}

function withWindowRegistry(Reg) {
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = Reg;
  window.NovaAppConfig = NovaAppConfig;
}

beforeEach(() => {
  resetTestStorage();
  withWindowRegistry(freshRegistry());
  NovaAppConfig._internal.resetAdoption(NovaRegistry);
});

// The UMD modules assign window.* globals at import time and the suite
// re-assigns them per test — clear them so later suites sharing this
// vitest worker (isolate:false) never see a stale engine.
afterAll(() => {
  delete window.NovaRegistry;
  delete window.NovaAppConfig;
});

describe('app config (js/platform/core/app-config.js)', () => {
  it('resolves HKNA paths from appId + relative path', () => {
    expect(NovaAppConfig.resolvePath('com.astroos.music', 'prefs')).toBe('HKNA/com.astroos.music/prefs');
    expect(NovaAppConfig.resolvePath('com.astroos.clock', 'alarms/deep')).toBe('HKNA/com.astroos.clock/alarms/deep');
  });

  it('rejects malformed app ids and relative paths', () => {
    expect(() => NovaAppConfig.resolvePath('', 'prefs')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com/a', 'prefs')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com.a', '../escape')).toThrow(TypeError);
    expect(() => NovaAppConfig.resolvePath('com.a', '')).toThrow(TypeError);
  });

  it('adopts the legacy localStorage key exactly once and keeps it as fallback', () => {
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.5, shuffle: true }));

    expect(NovaAppConfig.get('com.astroos.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.5, shuffle: true });
    expect(NovaRegistry.get('HKNA/com.astroos.music/prefs')).toEqual({ volume: 0.5, shuffle: true });
    expect(NovaRegistry.stat('HKND/_migration/appConfig')).not.toBeNull();

    // A later legacy edit never leaks into the hive — the guard holds.
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.9 }));
    expect(NovaAppConfig.get('com.astroos.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.5, shuffle: true });
  });

  it('never clobbers an existing hive value during adoption', () => {
    NovaRegistry.set('HKNA/com.astroos.music/prefs', { volume: 0.7 }, { type: 'REG_JSON', source: 'test' });
    localStorage.setItem('nova_music_prefs', JSON.stringify({ volume: 0.1 }));

    expect(NovaAppConfig.get('com.astroos.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.7 });
  });

  it('round-trips values of every scalar type', () => {
    expect(NovaAppConfig.set('com.astroos.textedit', 'wordWrap', true, { type: 'REG_BOOL' })).toBe(true);
    expect(NovaAppConfig.get('com.astroos.textedit', 'wordWrap')).toBe(true);
    expect(NovaRegistry.get('HKNA/com.astroos.textedit/wordWrap')).toBe(true);

    expect(NovaAppConfig.set('com.a', 'level', 3, { type: 'REG_DWORD' })).toBe(true);
    expect(NovaAppConfig.get('com.a', 'level')).toBe(3);

    expect(NovaAppConfig.set('com.a', 'label', 'hello', { type: 'REG_SZ' })).toBe(true);
    expect(NovaAppConfig.get('com.a', 'label')).toBe('hello');
  });

  it('coerces legacy strings to the REG_* value shape on fallback reads', () => {
    localStorage.setItem('astroos.textedit.wordWrap', 'true');
    expect(NovaAppConfig.get('com.astroos.textedit', 'wordWrap', { type: 'REG_BOOL', legacyKey: 'astroos.textedit.wordWrap', fallback: false }))
      .toBe(true);

    localStorage.setItem('astroos.level', '42');
    expect(NovaAppConfig.get('com.a', 'level', { type: 'REG_DWORD', legacyKey: 'astroos.level', fallback: 0 })).toBe(42);

    localStorage.setItem('astroos.corrupt', '{not json');
    expect(NovaAppConfig.get('com.a', 'obj', { type: 'REG_JSON', legacyKey: 'astroos.corrupt', fallback: { safe: 1 } }))
      .toEqual({ safe: 1 });
  });

  it('returns the fallback when nothing is stored anywhere', () => {
    expect(NovaAppConfig.get('com.astroos.music', 'prefs', { fallback: { volume: 1 } })).toEqual({ volume: 1 });
  });

  it('falls back to the legacy localStorage channel when no registry exists', () => {
    delete window.NovaRegistry;

    expect(NovaAppConfig.set('com.astroos.music', 'prefs', { volume: 0.25 }, { legacyKey: 'nova_music_prefs' })).toBe(false);
    expect(JSON.parse(localStorage.getItem('nova_music_prefs'))).toEqual({ volume: 0.25 });
    expect(NovaAppConfig.get('com.astroos.music', 'prefs', { legacyKey: 'nova_music_prefs', fallback: {} }))
      .toEqual({ volume: 0.25 });

    expect(NovaAppConfig.set('com.astroos.textedit', 'wordWrap', true, { type: 'REG_BOOL', legacyKey: 'astroos.textedit.wordWrap', legacyRaw: 'true' })).toBe(false);
    expect(localStorage.getItem('astroos.textedit.wordWrap')).toBe('true');
  });

  it('removes both the hive value and the legacy shadow on remove()', () => {
    NovaAppConfig.set('com.astroos.music', 'prefs', { volume: 0.5 }, { legacyKey: 'nova_music_prefs' });
    expect(NovaAppConfig.remove('com.astroos.music', 'prefs', { legacyKey: 'nova_music_prefs' })).toBe(true);
    expect(NovaRegistry.stat('HKNA/com.astroos.music/prefs')).toBeNull();
    expect(localStorage.getItem('nova_music_prefs')).toBeNull();
  });
});
