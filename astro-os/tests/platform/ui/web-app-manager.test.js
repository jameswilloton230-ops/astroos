import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// ── web-app-manager.js — ESM singleton managing shortcut-style web apps ─────
// Loaded with dynamic import (it uses ES module exports). The module keeps a
// singleton `state`, so every test gets a fresh copy via vi.resetModules() +
// re-import, and destroy() is called afterwards to flush/clear the debounced
// save timer so nothing leaks across tests.

const WAM_PATH = '../../../js/platform/ui/web-app-manager.js';

let mod;
let lastManager;

// The module registers pagehide/visibilitychange/beforeunload lifecycle
// listeners on window during initialize(); plain Node's globalThis has no
// addEventListener, so supply the missing browser globals before importing.
const windowListeners = [];
vi.stubGlobal('addEventListener', (type, fn, opts) => windowListeners.push([type, fn, opts]));
vi.stubGlobal('removeEventListener', vi.fn());

async function freshImport() {
  vi.resetModules();
  mod = await import(WAM_PATH);
  lastManager = mod.default;
  return mod;
}

const goodInput = (over = {}) => ({ name: 'Docs', url: 'https://docs.example.com/start', ...over });

describe('WebAppManager (js/platform/ui/web-app-manager.js)', () => {
  beforeEach(() => {
    resetTestStorage();
  });

  afterEach(() => {
    // Flush + clear any pending debounced save from the last used module copy.
    try { lastManager?.destroy(); } catch { /* module never loaded */ }
    windowListeners.length = 0;
    vi.restoreAllMocks();
  });

  describe('surface', () => {
    it('exports the frozen manager, typed error classes, and a global for script-tag consumers', async () => {
      const m = await freshImport();

      expect(Object.isFrozen(m.default)).toBe(true);
      for (const fn of ['initialize', 'addApp', 'removeApp', 'getAllApps', 'getApp', 'launchApp',
        'onAdd', 'onRemove', 'getStats', 'isValidUrl', 'flush', 'destroy', 'setLogLevel']) {
        expect(typeof m.default[fn]).toBe('function');
      }
      expect(typeof m.WebAppManagerError).toBe('function');
      expect(typeof m.ValidationError).toBe('function');
      expect(typeof m.NotFoundError).toBe('function');
      expect(typeof m.StorageError).toBe('function');
      expect(new m.ValidationError('x') instanceof m.WebAppManagerError).toBe(true);
      expect(new m.StorageError('x') instanceof m.WebAppManagerError).toBe(true);
      expect(new m.NotFoundError('x') instanceof m.WebAppManagerError).toBe(true);
      expect(globalThis.WebAppManager).toBe(m.default);
    });

    it('registers pagehide / visibilitychange / beforeunload lifecycle flushes on initialize()', async () => {
      const { default: WAM } = await freshImport();
      WAM.initialize();
      const types = windowListeners.map(([type]) => type);
      expect(types).toEqual(expect.arrayContaining(['pagehide', 'visibilitychange', 'beforeunload']));
      // Every registration carries the lifecycle AbortSignal for destroy().
      for (const [, , opts] of windowListeners) expect(opts.signal).toBeDefined();
    });
  });

  describe('addApp', () => {
    it('creates a frozen web-app record with a generated id and DuckDuckGo favicon fallback', async () => {
      const { default: WAM } = await freshImport();
      const app = WAM.addApp(goodInput({ url: 'https://www.docs.example.com/start' }));

      expect(app.id).toMatch(/^web-app-/);
      expect(app.name).toBe('Docs');
      // The URL itself is kept verbatim — only the favicon hostname loses www.
      expect(app.url).toBe('https://www.docs.example.com/start');
      expect(app.launchCount).toBe(0);
      expect(app.lastLaunched).toBeNull();
      expect(app.addedDate).toBeTypeOf('string');
      // No icon supplied → hostname-based favicon (leading www. stripped).
      expect(app.icon).toBe('https://icons.duckduckgo.com/ico/docs.example.com.ico');
      expect(Object.isFrozen(app)).toBe(true);

      // The returned value is a frozen copy: mutating it throws (strict mode)
      // and cannot corrupt the store.
      expect(() => { app.name = 'hacked'; }).toThrow(TypeError);
      expect(WAM.getApp(app.id).name).toBe('Docs');
    });

    it('honours an explicit icon and fires add/remove subscription events', async () => {
      const { default: WAM } = await freshImport();
      const seen = [];
      const unsubscribe = WAM.onAdd((app) => seen.push(['add', app.name]));
      const removedSeen = [];
      WAM.onRemove((app) => removedSeen.push(app.id));

      const app = WAM.addApp(goodInput({ icon: '📚' }));
      expect(app.icon).toBe('📚');
      expect(seen).toEqual([['add', 'Docs']]);

      unsubscribe();
      WAM.addApp(goodInput({ name: 'Second' }));
      expect(seen).toEqual([['add', 'Docs']]); // unsubscribed → no more adds

      WAM.removeApp(app.id);
      expect(removedSeen).toEqual([app.id]);
    });

    it('persists through the debounced save and reloads after a fresh import', async () => {
      let { default: WAM } = await freshImport();
      WAM.addApp(goodInput());
      WAM.flush();

      const stored = JSON.parse(localStorage.getItem('nova_web_apps'));
      expect(stored.version).toBe(1);
      expect(stored.apps).toHaveLength(1);
      expect(stored.apps[0].name).toBe('Docs');

      // Fresh module copy = simulated restart.
      ({ default: WAM } = await freshImport());
      expect(WAM.getAllApps().map((a) => a.name)).toEqual(['Docs']);
    });
  });

  describe('validation deny paths', () => {
    it.each([
      ['non-object input', 42, 'App input must be an object'],
      ['empty name', goodInput({ name: '   ' }), 'App name must not be empty'],
      ['javascript: URL', goodInput({ url: 'javascript:alert(1)' }), 'Invalid URL'],
      ['ftp URL', goodInput({ url: 'ftp://files.example.com/x' }), 'Invalid URL'],
      ['URL with embedded credentials', goodInput({ url: 'https://user:pass@evil.example.com/' }), 'Invalid URL'],
      ['oversized name', goodInput({ name: 'x'.repeat(101) }), 'must be at most 100 characters'],
      ['oversized URL', goodInput({ url: `https://x.example.com/${'a'.repeat(2100)}` }), 'must be at most 2048 characters'],
    ])('rejects %s with a ValidationError carrying the field', async (_label, input, message) => {
      const { default: WAM, ValidationError } = await freshImport();
      try {
        WAM.addApp(input);
        expect.unreachable('addApp should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err.name).toBe('ValidationError');
        expect(err.message).toContain(message);
        expect(err.field).toBeTypeOf('string');
      }
      expect(WAM.getAllApps()).toEqual([]);
    });

    it('rejects non-function event callbacks', async () => {
      const { default: WAM, ValidationError } = await freshImport();
      expect(() => WAM.onAdd('not a function')).toThrow(ValidationError);
    });
  });

  describe('storage migration / corrupt data resilience', () => {
    it('loads the versioned payload, dropping entries that fail normalization', async () => {
      localStorage.setItem('nova_web_apps', JSON.stringify({
        version: 1,
        apps: [
          { id: 'ok-1', name: 'Good', url: 'https://good.example.com', icon: 'g', addedDate: '2026-01-01T00:00:00.000Z', launchCount: 3, lastLaunched: '2026-01-02T00:00:00.000Z' },
          { id: 'bad-nourl', name: 'NoUrl' }, // missing url + icon
          { id: 'bad-url', name: 'BadUrl', url: 'javascript:alert(1)', icon: 'x' },
          'just a string',
        ],
      }));
      const { default: WAM } = await freshImport();
      const apps = WAM.getAllApps();
      expect(apps).toHaveLength(1);
      expect(apps[0]).toMatchObject({ id: 'ok-1', name: 'Good', launchCount: 3, lastLaunched: '2026-01-02T00:00:00.000Z' });
      expect(Object.isFrozen(apps[0])).toBe(true);
    });

    it('migrates the legacy raw-array shape and re-saves it in the versioned schema on the next mutation', async () => {
      localStorage.setItem('nova_web_apps', JSON.stringify([
        { id: 'legacy-1', name: 'Legacy', url: 'https://legacy.example.com', icon: 'l' },
      ]));
      const { default: WAM } = await freshImport();
      expect(WAM.getAllApps().map((a) => a.id)).toEqual(['legacy-1']);

      // Persistence is lazy: a read-only flush() is a no-op and the legacy
      // payload stays untouched on disk...
      WAM.flush();
      expect(JSON.parse(localStorage.getItem('nova_web_apps'))).toBeInstanceOf(Array);

      // ...but the next mutation rewrites it in the current versioned shape.
      WAM.launchApp('legacy-1');
      WAM.flush();
      const stored = JSON.parse(localStorage.getItem('nova_web_apps'));
      expect(stored.version).toBe(1);
      expect(stored.apps[0]).toMatchObject({ id: 'legacy-1', launchCount: 1 });
    });

    it('resets to an empty list when the stored JSON is corrupt instead of crashing', async () => {
      const eventLog = { log: vi.fn() };
      globalThis.EventLog = eventLog;
      localStorage.setItem('nova_web_apps', '{corrupt json');
      const { default: WAM } = await freshImport();

      expect(WAM.getAllApps()).toEqual([]);
      expect(eventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        app: 'WebAppManager',
        severity: 'error',
        message: expect.stringContaining('corrupt'),
      }));
      delete globalThis.EventLog;
    });

    it('degrades to memory-only operation when localStorage denies writes', async () => {
      const realLS = globalThis.localStorage;
      globalThis.localStorage = {
        getItem: () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); },
        setItem: () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); },
        removeItem: () => {},
        clear: () => {},
      };
      try {
        const { default: WAM } = await freshImport();
        // Probe fails → storageAvailable false → everything still works in-memory.
        const app = WAM.addApp(goodInput());
        expect(WAM.getApp(app.id).name).toBe('Docs');
        expect(() => WAM.flush()).not.toThrow();
        expect(realLS.getItem('nova_web_apps')).toBeNull(); // nothing was persisted
      } finally {
        globalThis.localStorage = realLS;
      }
    });
  });

  describe('removeApp / launchApp', () => {
    it('removes by id, reports unknown ids as false, and validates appId type', async () => {
      const { default: WAM, ValidationError } = await freshImport();
      const app = WAM.addApp(goodInput());

      expect(WAM.removeApp(app.id)).toBe(true);
      expect(WAM.getApp(app.id)).toBeNull();
      expect(WAM.removeApp(app.id)).toBe(false);
      expect(() => WAM.removeApp(42)).toThrow(ValidationError);
    });

    it('records launches with counters and timestamps, and throws NotFoundError for unknown ids', async () => {
      const { default: WAM, NotFoundError } = await freshImport();
      const app = WAM.addApp(goodInput());

      const launched = WAM.launchApp(app.id);
      expect(launched.launchCount).toBe(1);
      expect(launched.lastLaunched).toBeTypeOf('string');
      expect(WAM.launchApp(app.id).launchCount).toBe(2);

      try {
        WAM.launchApp('web-app-missing');
        expect.unreachable('launchApp should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err.name).toBe('NotFoundError');
        expect(err.id).toBe('web-app-missing');
      }
    });

    it('flushes launch counters to storage', async () => {
      const { default: WAM } = await freshImport();
      const app = WAM.addApp(goodInput());
      WAM.launchApp(app.id);
      WAM.launchApp(app.id);
      WAM.flush();

      const stored = JSON.parse(localStorage.getItem('nova_web_apps'));
      expect(stored.apps[0].launchCount).toBe(2);
    });
  });

  describe('getStats / limits / destroy', () => {
    it('aggregates stats without exposing internal state', async () => {
      const { default: WAM } = await freshImport();
      const a = WAM.addApp(goodInput({ name: 'A' }));
      WAM.addApp(goodInput({ name: 'B' }));
      WAM.launchApp(a.id);
      WAM.launchApp(a.id);

      const stats = WAM.getStats();
      expect(stats.totalApps).toBe(2);
      expect(stats.totalLaunches).toBe(2);
      expect(stats.apps).toEqual([
        { name: 'A', launches: 2, added: a.addedDate },
        { name: 'B', launches: 0, added: expect.any(String) },
      ]);
    });

    it('enforces the 200-app ceiling with a StorageError', async () => {
      const { default: WAM, StorageError } = await freshImport();
      for (let i = 0; i < 200; i++) {
        WAM.addApp(goodInput({ name: `App ${i}`, url: `https://app${i}.example.com` }));
      }
      expect(() => WAM.addApp(goodInput({ name: 'App 201' }))).toThrow(StorageError);
      try {
        WAM.addApp(goodInput({ name: 'App 201' }));
        expect.unreachable('addApp should have thrown');
      } catch (err) {
        expect(err.message).toContain('Maximum number of web apps (200) reached');
      }

      // destroy() clears memory, but re-initialization reloads the persisted
      // list — the ceiling still applies until storage itself is cleared.
      WAM.destroy();
      expect(() => WAM.addApp(goodInput({ name: 'Still full' }))).toThrow(StorageError);

      localStorage.removeItem('nova_web_apps');
      WAM.destroy();
      expect(WAM.addApp(goodInput({ name: 'Fresh' })).name).toBe('Fresh');
    });

    it('isValidUrl is exported and enforces the documented URL policy', async () => {
      const { default: WAM } = await freshImport();
      expect(WAM.isValidUrl('https://ok.example.com/path')).toBe(true);
      expect(WAM.isValidUrl('http://ok.example.com')).toBe(true);
      expect(WAM.isValidUrl('javascript:alert(1)')).toBe(false);
      expect(WAM.isValidUrl('https://user:pass@evil.example.com/')).toBe(false);
      expect(WAM.isValidUrl('not a url')).toBe(false);
      expect(WAM.isValidUrl('')).toBe(false);
      expect(WAM.isValidUrl(42)).toBe(false);
    });
  });
});
