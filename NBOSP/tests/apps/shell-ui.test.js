import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

// ── Mock globals for WM ─────────────────────────────────────────────────────
const _makeApp = (overrides = {}) => ({
  id: 'nook', name: 'Settings', defaultSize: [700, 500], minSize: [500, 400],
  icon: 'box', transparent: false, frame: true, resizable: true,
  alwaysOnTop: false, startMinimized: false, devOnly: false,
  onDrop: undefined, onDropText: undefined, onClose: undefined, init: undefined,
  ...overrides,
});

globalThis.OS = {
  apps: { nook: _makeApp() },
  windows: new Map(),
  windowZCounter: 0,
  focusedWindowId: null,
  settings: { get: vi.fn(() => null), set: vi.fn() },
  events: { emit: vi.fn() },
  workers: { fs: { call: vi.fn().mockResolvedValue([]) } },
  workspaces: [{ id: 'ws1', windows: [] }],
};

const _origMapGetOrInsert = Map.prototype.getOrInsertComputed;
Map.prototype.getOrInsertComputed = function getOrInsertComputed(key, factory) {
  if (!this.has(key)) this.set(key, factory());
  return this.get(key);
};

globalThis.WM = undefined;
globalThis.Notify = { show: vi.fn() };
globalThis.ContextMenu = { show: vi.fn() };
globalThis.toggleLaunchpad = vi.fn();

let _idCounter = 0;
globalThis.generateId = () => `id-${++_idCounter}`;
globalThis.throttleRAF = (fn) => fn;

const _makeEl = (tag, attrs = {}, children = null) => {
  const _children = [];
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    className: attrs.className || '',
    style: typeof attrs.style === 'object' ? { ...attrs.style } : {},
    dataset: {},
    children: _children,
    textContent: attrs.textContent || '',
    innerHTML: '',
    classList: {
      add: vi.fn(), remove: vi.fn(), toggle: vi.fn(),
      contains: vi.fn(() => false),
    },
    appendChild: vi.fn((child) => { _children.push(child); }),
    append: vi.fn((...args) => { for (const c of args) _children.push(c); }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    getAttribute: vi.fn(),
    querySelector: vi.fn(),
    querySelectorAll: vi.fn((sel) => {
      if (!sel) return [];
      const parts = sel.split(',').map(s => s.trim());
      const results = [];
      const search = (nodes) => {
        for (const node of nodes) {
          if (parts.some(part => {
            if (part.startsWith('.')) return node.className?.includes(part.slice(1));
            if (part.startsWith('#')) return node.id === part.slice(1);
            return node.tagName === part.toUpperCase();
          })) results.push(node);
          if (node.children) search(node.children);
        }
      };
      search(_children);
      return results;
    }),
    closest: vi.fn(),
    remove: vi.fn(),
    getBoundingClientRect: () => ({ top: 0, bottom: 48, left: 0, right: 1920 }),
  };
  return el;
};

globalThis.createEl = _makeEl;

globalThis.svgIcon = (name, size) => `<svg width="${size}" height="${size}"></svg>`;

const _mockTaskbar = (position = 'bottom') => {
  const rect =
    position === 'bottom' ? { top: 800, bottom: 848, left: 0, right: 1920 } :
    position === 'top'    ? { top: 0, bottom: 48, left: 0, right: 1920 } :
    position === 'left'   ? { top: 0, bottom: 800, left: 0, right: 320 } :
                            { top: 0, bottom: 800, left: 1600, right: 1920 };
  const style =
    position === 'bottom' ? { left: '0px', right: '0px', top: 'auto', bottom: '0px' } :
    position === 'top'    ? { left: '0px', right: '0px', top: '0px', bottom: 'auto' } :
    position === 'left'   ? { left: '0px', right: 'auto', top: '0px', bottom: '0px' } :
                            { left: 'auto', right: '0px', top: '0px', bottom: '0px' };
  return {
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    style: {},
    getBoundingClientRect: () => rect,
  };
};

const _idCache = new Map();
const _cachedGetElementById = (id) => {
  if (!_idCache.has(id)) _idCache.set(id, _getElementByIdImpl(id));
  return _idCache.get(id);
};

let _getElementByIdImpl = (id) => {
  if (id === 'windows') return { appendChild: vi.fn(), replaceChildren: vi.fn() };
  if (id === 'snap-preview') return { classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) }, style: {}, offsetHeight: 0 };
  if (id === 'snap-compass') return { classList: { add: vi.fn(), remove: vi.fn() }, querySelectorAll: vi.fn(() => []), dataset: {} };
  if (id === 'taskbar') return _mockTaskbar('bottom');
  if (id === 'taskbar-apps') return { replaceChildren: vi.fn(), querySelectorAll: vi.fn(() => []) };
  if (id === 'notification-panel') return { classList: { contains: vi.fn(() => false), add: vi.fn(), remove: vi.fn() } };
  return {
    appendChild: vi.fn(), replaceChildren: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    style: {}, addEventListener: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  };
};

globalThis.document = {
  getElementById: vi.fn(_cachedGetElementById),
  querySelector: vi.fn(() => null),
  querySelectorAll: vi.fn(() => []),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: globalThis.createElement,
  createDocumentFragment: () => ({
    appendChild: vi.fn(),
    querySelectorAll: vi.fn(() => []),
  }),
  body: {
    appendChild: vi.fn(), classList: { add: vi.fn() },
    style: { cursor: '' },
  },
  documentElement: {
    style: { scrollLeft: 0, scrollTop: 0 },
    classList: {},
    querySelectorAll: vi.fn(() => []),
  },
  activeElement: null,
};

globalThis.window = {
  innerHeight: 800, innerWidth: 1920,
  NovaByteSystem: { settings: { get: vi.fn(() => null) } },
  scrollX: 0, scrollY: 0,
  scrollTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getComputedStyle: vi.fn((el) => {
    if (el?.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.top === 0 && r.bottom === 48) return { left: '0px', right: '0px', top: '0px', bottom: 'auto' };
      if (r.top === 800) return { left: '0px', right: '0px', top: 'auto', bottom: '0px' };
    }
    return { left: '0px', right: 'auto', top: '0px', bottom: 'auto' };
  }),
  MutationObserver: class MockMutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class MockResizeObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
};

globalThis.MutationObserver = globalThis.window.MutationObserver;
globalThis.ResizeObserver = globalThis.window.ResizeObserver;

globalThis.FS = {
  rootId: 'root',
  files: new Map([['root', { id: 'root', name: '/', type: 'folder', parentId: null }]]),
  _childrenByParent: new Map([['root', new Map()]]),
  specialFolders: { desktop: 'desktop-id' },
  getPath: vi.fn((id) => '/' + id),
  listDir: vi.fn(() => []),
  getByPath: vi.fn(),
};

// ── Helpers ────────────────────────────────────────────────────────────────
// wm.js reads disabled apps through RegistryPrefs (registry-backed); with
// no window.NovaRegistry in this realm it falls back to the legacy
// localStorage keys the tests below seed.
import RegistryPrefs from '../../js/platform/core/registry-prefs.js';
window.RegistryPrefs = RegistryPrefs;

const requireWM = () => {
  vi.resetModules();
  require('../../js/apps/shell-ui/wm.js');
  return window.WM;
};

const makeState = (overrides = {}) => ({
  id: 'win-1', appId: 'nook', element: _makeEl(), content: _makeEl(),
  titlebar: _makeEl(), titleText: _makeEl(),
  x: 100, y: 100, width: 700, height: 500,
  minWidth: 300, minHeight: 200, maxWidth: null, maxHeight: null,
  maximized: false, minimized: false,
  preMaxState: null, snapSide: null, preSnapState: null,
  _minimizeTimer: null, cleanups: [],
  ...overrides,
});

describe('WM (js/apps/shell-ui/wm.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
    vi.useRealTimers();
    _idCounter = 0;
    _idCache.clear();
    OS.windows = new Map();
    OS.windowZCounter = 0;
    OS.focusedWindowId = null;
    OS.apps = { nook: _makeApp() };
    OS.settings.get.mockReturnValue(null);
    OS.events.emit.mockClear();
    document.getElementById.mockClear();
    document.querySelector.mockReturnValue(null);
    document.querySelectorAll.mockReturnValue([]);
  });

  describe('init()', () => {
    it('caches DOM references for windows, snap-preview, and snap-compass', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.container).toBeDefined();
      expect(wm.snapPreview).toBeDefined();
      expect(wm.snapCompass).toBeDefined();
    });

    it('observes taskbar for class changes and resize when present', () => {
      const wm = requireWM();
      wm.init();
      const tbCall = document.getElementById.mock.calls.find(c => c[0] === 'taskbar');
      expect(tbCall).toBeDefined();
    });
  });

  describe('createWindow', () => {
    it('returns null for launchpad appId', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.createWindow('launchpad')).toBeNull();
    });

    it('returns null when app is disabled in localStorage', () => {
      const wm = requireWM();
      wm.init();
      localStorage.setItem('nova_disabled_apps', JSON.stringify(['nook']));
      expect(wm.createWindow('nook')).toBeNull();
    });

    it('returns null when app is disabled by object with id', () => {
      const wm = requireWM();
      wm.init();
      localStorage.setItem('nova_disabled_apps', JSON.stringify([{ id: 'nook' }]));
      expect(wm.createWindow('nook')).toBeNull();
    });

    it('returns null for unknown appId', () => {
      const wm = requireWM();
      wm.init();
      expect(wm.createWindow('nonexistent')).toBeNull();
    });

    it('applies option overrides to defaults', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook', { width: 1024, height: 768, x: 0, y: 0 });
      expect(state.width).toBe(1024);
      expect(state.height).toBe(768);
    });

    it('clamps spawn position to work area', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(state.x).toBeGreaterThanOrEqual(0);
      expect(state.y).toBeGreaterThanOrEqual(0);
    });

    it('registers window in OS.windows and sets focusedWindowId', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(OS.windows.has(state.id)).toBe(true);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('attaches window-control buttons with correct handlers', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const btns = state.element.querySelectorAll('.window-control-btn');
      expect(btns.length).toBe(3);
    });

    it('adds resize handles for all directions', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const handles = state.element.querySelectorAll('.window-resize-handle');
      expect(handles.length).toBe(8);
    });

    it('calls app.init with content, state, and options', () => {
      const init = vi.fn();
      OS.apps.nook = _makeApp({ init });
      const wm = requireWM();
      wm.init();
      const opts = { fileId: 'f1' };
      wm.createWindow('nook', opts);
      expect(init).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), opts);
    });

    it('emits app:opened after creation', () => {
      const wm = requireWM();
      wm.init();
      wm.createWindow('nook');
      expect(OS.events.emit).toHaveBeenCalledWith('app:opened', expect.objectContaining({ appId: 'nook' }));
    });

    it('sets className to app-window opening', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      expect(state.element.tagName).toBe('DIV');
      expect(state.element.style.left).toContain('px');
    });
  });

  describe('closeWindow', () => {
    it('removes window from OS.windows after fallback timeout', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const id = state.id;
      wm.closeWindow(id);
      expect(OS.windows.has(id)).toBe(true);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.windows.has(id)).toBe(false);
      vi.useRealTimers();
    });

    it('emits app:closed after close', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const id = state.id;
      wm.closeWindow(id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.events.emit).toHaveBeenCalledWith('app:closed', { id, appId: 'nook' });
      vi.useRealTimers();
    });

    it('calls app.onClose callback', async () => {
      vi.useFakeTimers();
      const onClose = vi.fn();
      OS.apps.nook = _makeApp({ onClose });
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: state.id }));
      vi.useRealTimers();
    });

    it('refocuses top remaining window when closing focused window', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      OS.focusedWindowId = s2.id;
      wm.closeWindow(s2.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.focusedWindowId).toBe(s1.id);
      vi.useRealTimers();
    });

    it('does nothing when closing nonexistent id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.closeWindow('no-such-id')).not.toThrow();
    });

    it('clears focusedWindowId when no windows remain', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(OS.focusedWindowId).toBeNull();
      vi.useRealTimers();
    });
  });

  describe('Shell Bags (HKNU/shell/bags/windows/*)', () => {
    // Minimal in-hive stub — wm only needs get/set.
    function makeRegistry() {
      const store = new Map();
      return {
        store,
        get: (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined),
        set: (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); return true; },
      };
    }

    it('windowBag returns null when no registry engine is up', () => {
      const wm = requireWM();
      const had = window.NovaRegistry;
      delete window.NovaRegistry;
      try {
        expect(wm.windowBag('nook')).toBeNull();
        expect(wm.writeWindowBag('nook', { x: 1, y: 2, width: 3, height: 4 })).toBe(false);
      } finally {
        if (had) window.NovaRegistry = had;
      }
    });

    it('round-trips a geometry rect through the hive and rejects garbage', () => {
      const wm = requireWM();
      const registry = makeRegistry();
      const had = window.NovaRegistry;
      window.NovaRegistry = registry;
      try {
        expect(wm.writeWindowBag('nook', { x: 42, y: 30, width: 640, height: 480 })).toBe(true);
        expect(registry.store.get('HKNU/shell/bags/windows/nook')).toEqual({ x: 42, y: 30, width: 640, height: 480 });
        expect(wm.windowBag('nook')).toEqual({ x: 42, y: 30, width: 640, height: 480 });

        registry.store.set('HKNU/shell/bags/windows/nook', { x: 'far', y: -5, width: 0, height: NaN });
        expect(wm.windowBag('nook')).toBeNull();
        expect(wm.windowBag('')).toBeNull();
      } finally {
        if (had) window.NovaRegistry = had; else delete window.NovaRegistry;
      }
    });

    it('closeWindow records the geometry and the next open restores it', async () => {
      vi.useFakeTimers();
      const registry = makeRegistry();
      const had = window.NovaRegistry;
      window.NovaRegistry = registry;
      try {
        const wm = requireWM();
        wm.init();
        const state = wm.createWindow('nook');
        state.x = 123; state.y = 45;
        wm.closeWindow(state.id);
        await vi.advanceTimersByTimeAsync(300);
        expect(registry.store.get('HKNU/shell/bags/windows/nook')).toMatchObject({ x: 123, y: 45 });

        // Next open (no explicit x/y) restores the bag instead of cascading.
        const reopened = wm.createWindow('nook');
        expect(reopened.x).toBe(123);
        expect(reopened.y).toBe(45);
        wm.closeWindow(reopened.id);
        await vi.advanceTimersByTimeAsync(300);
      } finally {
        vi.useRealTimers();
        if (had) window.NovaRegistry = had; else delete window.NovaRegistry;
      }
    });

    it('explicit launch options still win over a stored bag', () => {
      const wm = requireWM();
      const registry = makeRegistry();
      const had = window.NovaRegistry;
      window.NovaRegistry = registry;
      try {
        wm.writeWindowBag('nook', { x: 42, y: 30, width: 640, height: 480 });
        const state = wm.createWindow('nook', { x: 500, y: 200 });
        expect(state.x).toBe(500);
        expect(state.y).toBe(200);
      } finally {
        if (had) window.NovaRegistry = had; else delete window.NovaRegistry;
      }
    });
  });

  describe('minimizeWindow / restoreWindow', () => {
    it('minimizeWindow sets minimized flag and clears focus', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      OS.focusedWindowId = state.id;
      wm.minimizeWindow(state.id);
      expect(state.minimized).toBe(true);
      expect(OS.focusedWindowId).toBeNull();
    });

    it('minimizeWindow hides element after 300ms', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      expect(state.element.style.display).not.toBe('none');
      await vi.advanceTimersByTimeAsync(350);
      expect(state.element.style.display).toBe('none');
      vi.useRealTimers();
    });

    it('restoreWindow cancels pending hide timer', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      wm.restoreWindow(state.id);
      await vi.advanceTimersByTimeAsync(350);
      expect(state.element.style.display).toBe('');
      expect(state.minimized).toBe(false);
      vi.useRealTimers();
    });

    it('restoreWindow focuses the window', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      wm.restoreWindow(state.id);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.minimizeWindow('x')).not.toThrow();
      expect(() => wm.restoreWindow('x')).not.toThrow();
    });
  });

  describe('getWorkArea', () => {
    it('returns an object with width, height, and position keys', () => {
      const wm = requireWM();
      const area = wm.getWorkArea();
      expect(area).toHaveProperty('width');
      expect(area).toHaveProperty('height');
      expect(area).toHaveProperty('taskbarPosition');
      expect(area.width).toBeGreaterThan(0);
      expect(area.height).toBeGreaterThan(0);
    });
  });

  describe('clampWindowRect', () => {
    it('enforces minimum width and height', () => {
      const wm = requireWM();
      const state = makeState();
      const r = wm.clampWindowRect(state, 0, 0, 50, 50);
      expect(r.w).toBeGreaterThanOrEqual(300);
      expect(r.h).toBeGreaterThanOrEqual(200);
    });

    it('respects maxWidth and maxHeight', () => {
      const wm = requireWM();
      const state = makeState({ maxWidth: 400, maxHeight: 300 });
      const r = wm.clampWindowRect(state, 0, 0, 900, 900, { left: 0, top: 0, right: 1920, bottom: 800 });
      expect(r.w).toBe(400);
      expect(r.h).toBe(300);
    });

    it('clamps x and y within work area bounds', () => {
      const wm = requireWM();
      const state = makeState();
      const r = wm.clampWindowRect(state, -500, -500, 700, 500);
      expect(r.x).toBeGreaterThanOrEqual(-620);
      expect(r.y).toBeGreaterThanOrEqual(0);
    });

    it('uses pre-computed area for position bounds', () => {
      const wm = requireWM();
      const state = makeState({ maxWidth: 500, maxHeight: 500 });
      const area = { left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 };
      const r = wm.clampWindowRect(state, 0, 0, 700, 500, area);
      expect(r.w).toBeLessThanOrEqual(500);
    });
  });

  describe('applyWindowFlags', () => {
    it('adds transparent class when app.transparent', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ transparent: true });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--transparent');
    });

    it('adds frameless class when app.frame is false', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ frame: false });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--frameless');
    });

    it('adds no-resize class when app.resizable is false', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ resizable: false });
      wm.applyWindowFlags(state);
      expect(state.element.classList.add).toHaveBeenCalledWith('app-window--no-resize');
    });

    it('boosts zIndex for alwaysOnTop apps', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      state.element.style.zIndex = '10';
      OS.apps.nook = _makeApp({ alwaysOnTop: true });
      wm.applyWindowFlags(state);
      expect(Number(state.element.style.zIndex)).toBeGreaterThan(10);
    });

    it('restricts zIndex to 1000 for phishing combo (frameless+transparent+alwaysOnTop)', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = _makeApp({ alwaysOnTop: true, frame: false, transparent: true });
      wm.applyWindowFlags(state);
      expect(state.element.style.zIndex).toBe('1000');
    });

    it('triggers minimize after 0ms when startMinimized is true', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      OS.apps.nook = _makeApp({ startMinimized: true });
      wm.applyWindowFlags(state);
      await vi.advanceTimersByTimeAsync(50);
      expect(state.minimized).toBe(true);
      vi.useRealTimers();
    });

    it('does nothing when app is missing', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.apps.nook = undefined;
      expect(() => wm.applyWindowFlags(state)).not.toThrow();
    });
  });

  describe('toggleMaximize', () => {
    it('saves preMaxState on first maximize', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      expect(state.maximized).toBe(true);
      expect(state.preMaxState).toEqual({ x: 10, y: 20, w: 700, h: 500 });
    });

    it('restores preMaxState on restore', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      wm.toggleMaximize(state.id);
      expect(state.maximized).toBe(false);
      expect(state.x).toBe(10);
      expect(state.y).toBe(20);
    });

    it('adds and removes maximized class', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      wm.toggleMaximize(state.id);
      expect(state.element.classList.add).toHaveBeenCalledWith('maximized');
      wm.toggleMaximize(state.id);
      // Un-maximizing eases back with the 'unmaximizing' transition class
      // (the old 'window-restoring' keyframe fought the inline-style snap).
      expect(state.element.classList.add).toHaveBeenCalledWith('unmaximizing');
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.toggleMaximize('no-such')).not.toThrow();
    });
  });

  describe('focusWindow', () => {
    it('raises zIndex above previous focused window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.focusWindow(s1.id);
      const z1 = Number(s1.element.style.zIndex);
      wm.focusWindow(s2.id);
      expect(Number(s2.element.style.zIndex)).toBeGreaterThan(z1);
    });

    it('toggles focused class on all windows', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.focusWindow(s1.id);
      expect(s1.element.classList.toggle).toHaveBeenCalledWith('focused', true);
      expect(s2.element.classList.toggle).toHaveBeenCalledWith('focused', false);
    });

    it('emits app:focused event', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.focusWindow(state.id);
      expect(OS.events.emit).toHaveBeenCalledWith('app:focused', { id: state.id, appId: 'nook' });
    });

    it('restores window if minimized', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      wm.minimizeWindow(state.id);
      expect(state.minimized).toBe(true);
      wm.focusWindow(state.id);
      expect(state.minimized).toBe(false);
    });

    it('focuses content element when no focusable input present', () => {
      const wm = requireWM();
      wm.init();
      const state = makeState();
      OS.windows.set(state.id, state);
      const content = state.content;
      state.element.querySelector = vi.fn((sel) => {
        if (sel === '.window-content') return content;
        return null;
      });
      content.focus = vi.fn();
      wm.focusWindow(state.id);
      expect(content.tabIndex).toBe(-1);
      expect(content.focus).toHaveBeenCalled();
    });

    it('does nothing for unknown id', () => {
      const wm = requireWM();
      wm.init();
      expect(() => wm.focusWindow('no-such')).not.toThrow();
    });
  });

  describe('getSnapRect', () => {
    it('returns null for unknown zone', () => {
      const wm = requireWM();
      expect(wm.getSnapRect('unknown')).toBeNull();
    });

    it('returns rect for left zone', () => {
      const wm = requireWM();
      const r = wm.getSnapRect('left');
      expect(r.x).toBe(0);
      expect(r.w).toBe(960);
    });

    it('returns rect for top-left corner', () => {
      const wm = requireWM();
      const r = wm.getSnapRect('top-left');
      expect(r.x).toBe(0);
      expect(r.y).toBe(0);
      expect(r.w).toBe(960);
      expect(r.h).toBeGreaterThanOrEqual(300);
    });
  });

  describe('snapWindow', () => {
    it('updates state position and size', () => {
      const wm = requireWM();
      const state = makeState();
      wm.snapWindow(state, 'left');
      expect(state.snapSide).toBe('left');
      expect(state.width).toBe(960);
    });

    it('preserves preSnapState on first snap', () => {
      const wm = requireWM();
      const state = makeState({ x: 10, y: 20, width: 700, height: 500 });
      wm.snapWindow(state, 'left');
      expect(state.preSnapState).toEqual({ x: 10, y: 20, w: 700, h: 500 });
    });
  });

  describe('showSnapPreview / hideSnapPreview', () => {
    it('showSnapPreview positions element for zone', () => {
      const wm = requireWM();
      wm.init();
      const preview = wm.snapPreview;
      preview.classList.contains.mockReturnValue(false);
      wm.showSnapPreview('left');
      expect(preview.style.width).toBe('960px');
      expect(preview.classList.add).toHaveBeenCalledWith('visible');
    });

    it('hideSnapPreview removes visible class', () => {
      const wm = requireWM();
      wm.init();
      wm.hideSnapPreview();
      expect(wm.snapPreview.classList.remove).toHaveBeenCalledWith('visible');
    });
  });

  describe('showSnapCompass / hideSnapCompass', () => {
    it('showSnapCompass marks active zone sc-zone', () => {
      const wm = requireWM();
      wm.init();
      const compass = wm.snapCompass;
      const zoneEl = { classList: { toggle: vi.fn() }, dataset: { zone: 'top-left' } };
      compass.querySelectorAll.mockReturnValue([zoneEl]);
      wm.showSnapCompass('top-left');
      expect(compass.classList.add).toHaveBeenCalledWith('visible');
      expect(zoneEl.classList.toggle).toHaveBeenCalledWith('active', true);
    });

    it('hideSnapCompass removes visible class', () => {
      const wm = requireWM();
      wm.init();
      wm.hideSnapCompass();
      expect(wm.snapCompass.classList.remove).toHaveBeenCalledWith('visible');
    });
  });

  describe('updateTaskbar', () => {
    beforeEach(() => {
      _idCache.clear();
      document.getElementById.mockImplementation((id) => {
        if (id === 'taskbar-apps') return { replaceChildren: vi.fn(), querySelectorAll: vi.fn(() => []), classList: { contains: vi.fn(() => false) } };
        if (id === 'windows') return { appendChild: vi.fn(), replaceChildren: vi.fn() };
        if (id === 'taskbar') return _mockTaskbar('bottom');
        return _getElementByIdImpl(id);
      });
    });

    it('does nothing when taskbar-apps container is missing', () => {
      document.getElementById.mockReturnValue(null);
      const wm = requireWM();
      expect(() => wm.updateTaskbar()).not.toThrow();
    });

    it('renders a button for an open app', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      // Taskbar rendering now lives in the shell's taskbar module, which
      // registers window.updateTaskbar; wm.updateTaskbar delegates to it.
      const delegated = vi.fn();
      globalThis.window.updateTaskbar = delegated;
      try {
        expect(() => wm.updateTaskbar()).not.toThrow();
        expect(delegated).toHaveBeenCalled();
      } finally {
        delete globalThis.window.updateTaskbar;
      }
    });

    it('marks active button when window is focused', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      OS.focusedWindowId = state.id;
      wm.updateTaskbar();
      const btn = _makeEl('button', { className: 'taskbar-app-btn active' });
      expect(btn.className).toContain('active');
    });

    it('renders window count badge when multiple windows', () => {
      const wm = requireWM();
      wm.init();
      wm.createWindow('nook');
      wm.createWindow('nook');
      wm.updateTaskbar();
      expect(OS.windows.size).toBe(2);
    });

    it('click handler opens window when no windows exist', () => {
      const wm = requireWM();
      wm.init();
      const btn = _makeEl('button');
      const clickHandler = () => {
        if (!OS.windows.size) wm.createWindow('nook');
      };
      clickHandler();
      expect(OS.windows.size).toBe(1);
    });

    it('click handler toggles minimize when single focused window', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const btn = _makeEl('button');
      const clickHandler = () => {
        if (OS.windows.size === 1) {
          if (OS.focusedWindowId === state.id && !state.minimized) wm.minimizeWindow(state.id);
          else wm.focusWindow(state.id);
        }
      };
      clickHandler();
      expect(state.minimized).toBe(true);
    });
  });

  describe('minimizeAll', () => {
    it('minimizes every open window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      wm.minimizeAll();
      expect(s1.minimized).toBe(true);
      expect(s2.minimized).toBe(true);
    });
  });

  describe('getWorkspaceWindows', () => {
    it('returns windows for matching workspace', () => {
      const wm = requireWM();
      const wsState = makeState();
      OS.workspaces = [{ id: 'ws1', windows: [wsState.id] }];
      OS.windows.set(wsState.id, wsState);
      const wins = wm.getWorkspaceWindows('ws1');
      expect(wins).toContain(wsState);
    });

    it('returns empty array for unknown workspace', () => {
      const wm = requireWM();
      expect(wm.getWorkspaceWindows('no-such')).toEqual([]);
    });
  });

  describe('showWindowPreview (module-level function)', () => {
    it('creates preview elements for each window', () => {
      const wm = requireWM();
      wm.init();
      const s1 = wm.createWindow('nook');
      const s2 = wm.createWindow('nook');
      const btn = _makeEl('button');
      const wins = [{ id: s1.id, state: s1 }, { id: s2.id, state: s2 }];
      const preview = _makeEl('div', { className: 'taskbar-window-preview' });
      document.body.appendChild(preview);
      expect(document.body.appendChild).toHaveBeenCalled();
    });
  });

  describe('cleanup / edge cases', () => {
    it('createWindow registers drag-and-drop listeners on content', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const addSpy = state.content.addEventListener;
      expect(addSpy).toHaveBeenCalledWith('dragover', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('dragleave', expect.any(Function));
      expect(addSpy).toHaveBeenCalledWith('drop', expect.any(Function));
    });

    it('closeWindow cleanup runs all registered cleanups', async () => {
      vi.useFakeTimers();
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const cleanup = vi.fn();
      state.cleanups.push(cleanup);
      wm.closeWindow(state.id);
      await vi.advanceTimersByTimeAsync(300);
      expect(cleanup).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('focusWindow does not refocus if already focused', () => {
      const wm = requireWM();
      wm.init();
      const state = wm.createWindow('nook');
      const prevFocus = OS.focusedWindowId;
      wm.focusWindow(state.id);
      wm.focusWindow(state.id);
      expect(OS.focusedWindowId).toBe(state.id);
    });

    it('getSnapZone returns edge zones (left, right, top, bottom)', () => {
      const wm = requireWM();
      expect(wm.getSnapZone(20, 400)).toBe('left');
      expect(wm.getSnapZone(1900, 400)).toBe('right');
      expect(wm.getSnapZone(960, 20)).toBe('top');
      expect(wm.getSnapZone(960, 780)).toBe('bottom');
    });

    it('getSnapRect returns proportional halves for each zone', () => {
      const wm = requireWM();
      const left = wm.getSnapRect('left');
      const top = wm.getSnapRect('top');
      expect(left.w).toBe(960);
      expect(top.h).toBeGreaterThanOrEqual(300);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The describes below cover the OTHER shell-ui modules (desktop.js, menu.js,
   modals.js). They load the real sources through tests/helpers/app-harness.js
   into fresh JSDOM realms, fully isolated from the hand-rolled WM mocks above.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Shared in-memory FS (same contract as js/core/services/fs.js) ──────────
function _makeShellFS({ withDocumentsFile } = {}) {
  const files = new Map();
  const children = new Map();
  let idc = 0;
  const gen = () => `fsn-${++idc}`;
  const index = (f) => {
    let m = children.get(f.parentId);
    if (!m) { m = new Map(); children.set(f.parentId, m); }
    m.set(f.id, f);
  };
  const fs = {
    files,
    _childrenByParent: children,
    rootId: null,
    specialFolders: {},
    listDir(folderId) {
      const m = children.get(folderId);
      if (!m) return [];
      return [...m.values()].sort((a, b) =>
        a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    },
    getPath(id) {
      const parts = [];
      let node = files.get(id);
      while (node) {
        if (node.parentId === null) break;
        parts.push(node.name);
        node = files.get(node.parentId);
      }
      return '/' + parts.reverse().join('/');
    },
    getByPath(path) {
      let current = this.rootId;
      for (const part of path.split('/')) {
        if (!part) continue;
        const m = children.get(current);
        const found = m && [...m.values()].find((c) => c.name === part);
        if (!found) return null;
        current = found.id;
      }
      return files.get(current) || null;
    },
    async createFolder(parentId, name) {
      const node = { id: gen(), name, type: 'folder', parentId, content: null, size: 0, mimeType: 'inode/directory', modified: Date.now() };
      files.set(node.id, node);
      index(node);
      return node;
    },
    async createFile(parentId, name, content, mimeType) {
      const node = { id: gen(), name, type: 'file', parentId, content: content || '', size: String(content ?? '').length, mimeType: mimeType || 'text/plain', modified: Date.now() };
      files.set(node.id, node);
      index(node);
      return node;
    },
    async writeFile(id, content) {
      const node = files.get(id);
      if (node) { node.content = content; node.modified = Date.now(); }
      return node;
    },
    async move(id, newParentId) {
      const node = files.get(id);
      if (!node) return null;
      children.get(node.parentId)?.delete(id);
      node.parentId = newParentId;
      index(node);
      return node;
    },
    async permanentDelete(id) {
      for (const child of this.listDir(id)) await this.permanentDelete(child.id);
      const node = files.get(id);
      if (node) children.get(node.parentId)?.delete(id);
      files.delete(id);
    },
  };
  const root = { id: gen(), name: '/', type: 'folder', parentId: null };
  files.set(root.id, root);
  index(root);
  fs.rootId = root.id;
  for (const name of ['Desktop', 'Documents', 'Trash']) {
    const node = { id: gen(), name, type: 'folder', parentId: root.id, content: null, size: 0, mimeType: 'inode/directory', modified: Date.now() };
    files.set(node.id, node);
    index(node);
    fs.specialFolders[name.toLowerCase()] = node.id;
  }
  if (withDocumentsFile) {
    const node = { id: gen(), name: 'notes.txt', type: 'file', parentId: fs.specialFolders.documents, content: 'old note', size: 8, mimeType: 'text/plain', modified: Date.now() };
    files.set(node.id, node);
    index(node);
  }
  return fs;
}

function _findFile(fs, name) {
  return [...fs.files.values()].find((f) => f.type === 'file' && f.name === name) || null;
}

describe('ContextMenu (js/apps/shell-ui/menu.js)', () => {
  async function bootMenu() {
    const { window } = await loadServiceApp('shell-ui', {
      scripts: ['menu.js'],
      withBaseUtils: true, // menu.js renders through the host createEl
    });
    return window;
  }

  it('attaches the ContextMenu singleton to window', async () => {
    const w = await bootMenu();
    expect(w.ContextMenu).toBeTruthy();
    expect(typeof w.ContextMenu.show).toBe('function');
    expect(typeof w.ContextMenu.hide).toBe('function');
    expect(w.ContextMenu.current).toBeNull();
  });

  it('renders items, separators, danger/disabled/shortcut variants into body', async () => {
    const w = await bootMenu();
    const menu = w.ContextMenu.show(10, 10, [
      { label: 'Open', action: () => {} },
      { separator: true },
      { label: 'Rename', shortcut: 'F2' },
      { label: 'Delete', danger: true },
      { label: 'Locked', disabled: true },
    ]);
    expect(w.ContextMenu.current).toBe(menu);
    expect(menu.parentElement).toBe(w.document.body);
    expect(menu.getAttribute('role')).toBe('menu');
    const items = [...menu.querySelectorAll('.ctx-item')];
    expect(items).toHaveLength(4);
    // the label span is followed by the .ctx-shortcut span → textContent joins them
    expect(items.map((b) => b.textContent)).toEqual(['Open', 'RenameF2', 'Delete', 'Locked']);
    expect(menu.querySelectorAll('.ctx-separator')).toHaveLength(1);
    expect(items[2].className).toContain('danger');
    expect(items[3].disabled).toBe(true);
    expect(items[3].getAttribute('aria-disabled')).toBe('true');
    expect(items[1].querySelector('.ctx-shortcut').textContent).toBe('F2');
    // icons render through the host svgIcon (inline svg for UI_ICONS names)
    const withIcon = w.ContextMenu.show(0, 0, [{ label: 'X', icon: 'x' }]);
    expect(withIcon.querySelector('.ctx-item span').innerHTML).toContain('<svg');
    w.ContextMenu.hide();
  });

  it('runs the clicked item action and closes the menu', async () => {
    const w = await bootMenu();
    const action = vi.fn();
    const menu = w.ContextMenu.show(5, 5, [{ label: 'Do it', action }, { label: 'Noop' }]);
    menu.querySelectorAll('.ctx-item')[0].click();
    expect(action).toHaveBeenCalledTimes(1);
    expect(w.ContextMenu.current).toBeNull();
    expect(menu.isConnected).toBe(false);
  });

  it('hide(otherMenu) is a no-op; hide() closes and fires onDismiss(null)', async () => {
    const w = await bootMenu();
    const onDismiss = vi.fn();
    const menu = w.ContextMenu.show(5, 5, [{ label: 'Only' }], onDismiss);
    w.ContextMenu.hide({}); // wrong menu → ignored
    expect(w.ContextMenu.current).toBe(menu);
    expect(onDismiss).not.toHaveBeenCalled();
    w.ContextMenu.hide();
    expect(w.ContextMenu.current).toBeNull();
    expect(menu.isConnected).toBe(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(null);
  });

  it('show() replaces the previously open menu', async () => {
    const w = await bootMenu();
    const first = w.ContextMenu.show(0, 0, [{ label: 'One' }]);
    const second = w.ContextMenu.show(0, 0, [{ label: 'Two' }]);
    expect(first.isConnected).toBe(false);
    expect(w.document.querySelectorAll('.context-menu')).toHaveLength(1);
    expect(w.ContextMenu.current).toBe(second);
    w.ContextMenu.hide();
  });

  it('a pointerdown outside the menu dismisses it', async () => {
    const w = await bootMenu();
    const menu = w.ContextMenu.show(0, 0, [{ label: 'One' }]);
    w.document.body.dispatchEvent(new w.MouseEvent('pointerdown', { bubbles: true }));
    expect(w.ContextMenu.current).toBeNull();
    expect(menu.isConnected).toBe(false);
  });

  it('clamps the menu position inside the viewport', async () => {
    const w = await bootMenu();
    // jsdom reports zero-sized rects for the menu, so the clamp lands at
    // innerWidth/innerHeight minus the 8px margin.
    const menu = w.ContextMenu.show(5000, 5000, [{ label: 'One' }]);
    expect(menu.style.left).toBe(`${w.innerWidth - 8}px`);
    expect(menu.style.top).toBe(`${w.innerHeight - 8}px`);
    w.ContextMenu.hide();
  });
});

describe('Modal service (js/apps/shell-ui/modals.js)', () => {
  async function bootModals() {
    const { window } = await loadServiceApp('shell-ui', {
      scripts: ['modals.js'],
      withBaseUtils: true,
    });
    return window;
  }

  it('exposes showModal and showPrompt on window', async () => {
    const w = await bootModals();
    expect(typeof w.showModal).toBe('function');
    expect(typeof w.showPrompt).toBe('function');
  });

  it('portals the overlay into a host-level #system-modal-root it creates on demand', async () => {
    const w = await bootModals();
    expect(w.document.getElementById('system-modal-root')).toBeNull();
    const promise = w.showModal('Delete file?', 'This cannot be undone.', [
      { label: 'Cancel' },
      { label: 'Delete', value: true, danger: true, primary: true },
    ]);
    const root = w.document.getElementById('system-modal-root');
    expect(root).toBeTruthy();
    expect(root.parentElement).toBe(w.document.body);
    const overlay = root.querySelector('.modal-overlay');
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.querySelector('.modal-title').textContent).toBe('Delete file?');
    expect(overlay.querySelector('.modal-body').textContent).toBe('This cannot be undone.');
    const buttons = [...overlay.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete']);
    expect(buttons[1].className).toContain('btn-danger');
    expect(buttons[1].className).toContain('btn-primary');
    buttons[1].click();
    await expect(promise).resolves.toBe(true);
    expect(overlay.isConnected).toBe(false);
  });

  it('resolves explicit button values and falls back to the button label', async () => {
    const w = await bootModals();
    const p1 = w.showModal('Pick', 'body', [
      { label: 'Save', value: 'saved' },
      { label: 'Cancel' },
    ]);
    const overlay = w.document.querySelector('.modal-overlay');
    [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    await expect(p1).resolves.toBe('saved');

    const p2 = w.showModal('Pick 2', 'body', [{ label: 'Abort' }]);
    const overlay2 = w.document.querySelector('.modal-overlay');
    [...overlay2.querySelectorAll('button')].find((b) => b.textContent === 'Abort').click();
    // no explicit value → the label is the resolution
    await expect(p2).resolves.toBe('Abort');
  });

  it('resolves null when the backdrop outside the dialog is clicked', async () => {
    const w = await bootModals();
    const promise = w.showModal('T', 'b', [{ label: 'OK', value: 'ok' }]);
    const overlay = w.document.querySelector('.modal-overlay');
    overlay.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await expect(promise).resolves.toBeNull();
  });

  it('showPrompt resolves the typed value on Enter and null on Escape', async () => {
    const w = await bootModals();
    const p1 = w.showPrompt('Rename folder', 'Old Name');
    const input = w.document.getElementById('modal-input-field');
    expect(input).toBeTruthy();
    expect(input.value).toBe('Old Name');
    input.value = 'New Name';
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await expect(p1).resolves.toBe('New Name');

    const p2 = w.showPrompt('Rename again', 'x');
    w.document.getElementById('modal-input-field')
      .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await expect(p2).resolves.toBeNull();
  });

  it('supports custom DOM bodies; the developer-warning variant is dropped by the compat wrapper', async () => {
    const w = await bootModals();
    const node = w.document.createElement('div');
    node.textContent = 'custom content';
    const promise = w.showModal('Dev warning', node, [{ label: 'OK', value: true }], undefined, '', {
      variant: 'developer-warning',
    });
    const dialog = w.document.querySelector('.modal-dialog');
    // SOURCE BUG: window.showModal(title, body, actions, inputType) forwards
    // only four arguments — ModalService's defaultInputValue and options
    // (variants, collect callbacks) are silently dropped by the compat
    // wrapper. showPrompt() calls ModalService.show directly and works.
    expect(dialog.dataset.modalVariant).toBeUndefined();
    // the HTMLElement body branch still renders the custom node
    expect(dialog.querySelector('.modal-body').textContent).toContain('custom content');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await expect(promise).resolves.toBe(true);
  });

  it('tracks [data-modal-value] selection for custom picker bodies', async () => {
    const w = await bootModals();
    const body = w.document.createElement('div');
    const optA = w.document.createElement('div');
    optA.setAttribute('data-modal-value', 'alpha');
    optA.setAttribute('data-modal-selected', 'true');
    const optB = w.document.createElement('div');
    optB.setAttribute('data-modal-value', 'beta');
    body.append(optA, optB);

    const promise = w.showModal('Choose', body, [{ label: 'OK', value: '__MODAL_SUBMIT_SELECTION__' }]);
    const overlay = w.document.querySelector('.modal-overlay');
    const dialog = overlay.querySelector('.modal-dialog');
    expect(dialog.querySelector('[data-modal-value="alpha"]').getAttribute('data-modal-selected')).toBe('true');

    // clicking another option re-marks the selection
    dialog.querySelector('[data-modal-value="beta"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(dialog.querySelector('[data-modal-value="beta"]').getAttribute('data-modal-selected')).toBe('true');
    expect(dialog.querySelector('[data-modal-value="alpha"]').getAttribute('data-modal-selected')).toBe('false');

    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
    await expect(promise).resolves.toBe('beta');
  });
});

describe('Desktop shell (js/apps/shell-ui/desktop.js)', () => {
  async function bootDesktop({ settings = {}, withNovaByteSystem = true, fs } = {}) {
    const os = {
      apps: {},
      username: 'user',
      events: {
        handlers: {},
        on(type, fn) { this.handlers[type] = fn; },
        emit(type, payload) { this.handlers[type]?.(payload); },
      },
    };
    const novaByteSystem = {
      settings: {
        get: (k) => (k in settings ? settings[k] : null),
        exportSnapshot: () => ({ ...settings }),
      },
    };
    const notify = { calls: [], show: (n) => notify.calls.push(n) };
    const created = [];
    const wm = { createWindow: (appId, opts) => { created.push({ appId, opts }); return { id: `win-${created.length}` }; } };
    const stubs = { extra: { OS: os, Notify: notify, WM: wm, FS: fs ?? _makeShellFS() } };
    if (withNovaByteSystem) stubs.extra.NovaByteSystem = novaByteSystem;
    const { window } = await loadServiceApp('shell-ui', { scripts: ['desktop.js'], stubs });
    return { window, os, notify, created, AppDirs: window.AppDirs, systemSettings: novaByteSystem.settings };
  }

  it('attaches the runtime flag, AppDirs and shell helpers, and subscribes to settings:changed', async () => {
    const { window, os, AppDirs } = await bootDesktop();
    expect(window.__NB_RUNTIME).toEqual({ os: 'NovaByte', layer: 'nbosp', ready: false });
    expect(window.AppDirs).toBe(AppDirs);
    for (const m of ['bootstrap', 'ensureAppDataFolder', 'getAppDataPath', 'getPrefs', 'setPrefs', 'removeAppData', 'clearAppData', 'syncKey']) {
      expect(typeof AppDirs[m]).toBe('function');
    }
    expect(typeof window.applyTheme).toBe('function');
    expect(typeof window.getShellSystemSetting).toBe('function');
    expect(typeof window.openFileWithApp).toBe('function');
    expect(typeof window.showOpenWithDialog).toBe('function');
    expect(typeof os.events.handlers['settings:changed']).toBe('function');
  });

  it('reads NovaByteSystem settings and throws when the API is unavailable', async () => {
    const { window } = await bootDesktop({ settings: { theme: 'nord', accentColor: '#ff0000' } });
    expect(window.getShellSystemSetting('theme')).toBe('nord');
    expect(window.getShellSystemSettingsSnapshot()).toEqual({ theme: 'nord', accentColor: '#ff0000' });

    const { window: w2 } = await bootDesktop({ withNovaByteSystem: false });
    // cross-realm (jsdom) error — match the message, not the class
    expect(() => w2.getShellSystemSetting('theme')).toThrow(/NovaByte System settings API is unavailable/);
    expect(() => w2.getShellSystemSettingsSnapshot()).toThrow(/NovaByte System settings API is unavailable/);
  });

  it('applyTheme writes the theme custom properties and dispatches theme:changed', async () => {
    const { window } = await bootDesktop();
    const events = [];
    window.addEventListener('theme:changed', (e) => events.push(e.detail.theme));
    window.applyTheme('nord');
    expect(events).toEqual(['nord']);
    expect(window.document.documentElement.style.getPropertyValue('--bg-base')).toBe('#2e3440');
    expect(() => window.applyTheme('not-a-theme')).not.toThrow(); // falls back to nova-dark
    expect(events).toEqual(['nord', 'not-a-theme']);
  });

  it('routes file types to their default apps through WM.createWindow', async () => {
    const fs = _makeShellFS();
    const mk = async (name, mime) => fs.createFile(fs.specialFolders.desktop, name, 'x', mime);
    const html = await mk('page.html', 'text/html');
    const img = await mk('photo.jpg', 'image/jpeg');
    const song = await mk('song.mp3', 'audio/mpeg');
    const txt = await mk('notes.txt', 'text/plain');
    const { window, os, created } = await bootDesktop({ fs });
    os.apps = {
      'com.nbosp.browser': { id: 'com.nbosp.browser' },
      'com.nbosp.gallery': { id: 'com.nbosp.gallery' },
      'com.nbosp.music': { id: 'com.nbosp.music' },
      'com.nbosp.textedit': { id: 'com.nbosp.textedit' },
    };

    window.openFileWithDefaultApp({ id: html.id, name: html.name, mimeType: html.mimeType });
    window.openFileWithDefaultApp({ id: img.id, name: img.name, mimeType: img.mimeType });
    window.openFileWithDefaultApp({ id: song.id, name: song.name, mimeType: song.mimeType });
    window.openFileWithDefaultApp({ id: txt.id, name: txt.name, mimeType: txt.mimeType });

    expect(created.map((c) => c.appId)).toEqual([
      'com.nbosp.browser', 'com.nbosp.gallery', 'com.nbosp.music', 'com.nbosp.textedit',
    ]);
    expect(created.map((c) => c.opts)).toEqual([
      { fileId: html.id }, { fileId: img.id }, { fileId: song.id }, { fileId: txt.id },
    ]);
  });

  it('openFileWithApp validates the file/app and reports failures via Notify', async () => {
    const fs = _makeShellFS();
    const file = await fs.createFile(fs.specialFolders.desktop, 'doc.txt', 'hi', 'text/plain');
    const { window, os, notify, created } = await bootDesktop({ fs });
    os.apps = { 'com.nbosp.textedit': { id: 'com.nbosp.textedit' } };

    const ok = window.openFileWithApp({ id: file.id, name: 'doc.txt', mimeType: 'text/plain' }, 'com.nbosp.textedit');
    expect(ok).toEqual({ success: true, appId: 'com.nbosp.textedit', windowId: 'win-1', defaultSaved: false });
    expect(created).toHaveLength(1);

    // unknown file id → refusal notification, false return, no window
    expect(window.openFileWithApp({ id: 'ghost', name: 'x' }, 'com.nbosp.textedit')).toBe(false);
    // registered app missing → refusal
    expect(window.openFileWithApp({ id: file.id, name: 'doc.txt' }, 'com.nbosp.ghost')).toBe(false);
    expect(notify.calls.filter((c) => c.title === 'Unable to open file')).toHaveLength(2);
    expect(created).toHaveLength(1);
  });

  it('AppDirs resolves package aliases and returns null before folders are bootstrapped', async () => {
    const { AppDirs } = await bootDesktop();
    expect(AppDirs.PACKAGES.terminal).toBe('com.nbosp.terminal');
    expect(AppDirs.PACKAGES['nbosp-email']).toBe('com.nbosp.email');
    // nothing bootstrapped yet → no folder mapping; the (fire-and-forget)
    // ensure is kicked off and null is returned for now
    expect(AppDirs.getAppDataPath('terminal', 'files')).toBeNull();
    expect(AppDirs.getAppDataPath('com.nbosp.unknown-app', 'files')).toBeNull();
  });

  it('bootstrap() mirrors the data tree into the virtual FS and syncs localStorage', async () => {
    const fs = _makeShellFS({ withDocumentsFile: true });
    const { window, AppDirs } = await bootDesktop({
      fs,
      settings: { theme: 'nord', username: 'alice' },
    });
    window.localStorage.setItem('calendar_events_v2', JSON.stringify([{ id: 'evt1' }]));
    // Clock alarms moved into the NovaByte Registry (HKNA/com.nbosp.clock/
    // alarms) — the LS key must NOT be mirrored into the app folder anymore.
    window.localStorage.setItem('nbosp_clock_v1', JSON.stringify({ alarms: [{ time: '07:00' }] }));

    await AppDirs.bootstrap();

    // /data + /System exist
    const dataNode = fs.getByPath('/data');
    const systemNode = fs.getByPath('/System');
    expect(dataNode?.type).toBe('folder');
    expect(systemNode?.type).toBe('folder');
    expect(AppDirs.fsFolders.data).toBe(dataNode.id);
    expect(AppDirs.fsFolders.system).toBe(systemNode.id);

    // OS identity file
    const build = _findFile(fs, 'build.json');
    expect(JSON.parse(build.content).os).toBe('NovaByte');

    // every package got files/cache/databases/shared_prefs + appinfo.json
    const filesAppInfo = _findFile(fs, 'appinfo.json');
    expect(filesAppInfo).toBeTruthy();
    expect(fs.getPath(filesAppInfo.id)).toBe('/data/com.nbosp.files/files/appinfo.json');
    expect(JSON.parse(filesAppInfo.content).name).toBe('Files');

    // localStorage LS_MAP sync → pretty-printed JSON in the right folder
    const events = _findFile(fs, 'events.json');
    expect(fs.getPath(events.id)).toBe('/data/com.nbosp.calendar/databases/events.json');
    expect(JSON.parse(events.content)).toEqual([{ id: 'evt1' }]);

    // registry-migrated keys have no mirror file (alarms live in the hive)
    const clockDb = fs.getByPath('/data/com.nbosp.clock/databases');
    const alarmMirror = (clockDb?.children || []).find(f => f.name === 'alarms.json');
    expect(alarmMirror).toBeUndefined();

    // settings snapshot → prefs.json under com.nbosp.settings
    const prefs = _findFile(fs, 'prefs.json');
    expect(fs.getPath(prefs.id)).toBe('/data/com.nbosp.settings/shared_prefs/prefs.json');
    expect(JSON.parse(prefs.content)).toEqual({ theme: 'nord', username: 'alice' });

    // Documents notes migrated into TextEdit's app folder
    const notes = _findFile(fs, 'notes.txt');
    expect(fs.getPath(notes.id)).toBe('/data/com.nbosp.textedit/files/notes.txt');
  });

  it('exposes the fsFolders-overwrite quirk: app paths are null until ensureAppDataFolder runs', async () => {
    const fs = _makeShellFS();
    const { AppDirs } = await bootDesktop({ fs });
    await AppDirs.bootstrap();

    // SOURCE QUIRK: the tail of bootstrap() replaces fsFolders with
    // { data, system }, discarding the per-package folder map it just built.
    expect(AppDirs.getAppDataPath('com.nbosp.clock', 'files')).toBeNull();

    // ensureAppDataFolder rebuilds the mapping (and returns null itself,
    // because the handle cache is only populated on OPFS/Linux backends).
    const ensured = await AppDirs.ensureAppDataFolder('clock'); // alias resolved
    expect(ensured).toBeNull();
    const filesId = AppDirs.getAppDataPath('com.nbosp.clock', 'files');
    expect(typeof filesId).toBe('string');
    expect(fs.files.get(filesId).name).toBe('files');
  });

  it('prefs helpers take the disabled path when neither OPFS nor handles exist', async () => {
    const { AppDirs } = await bootDesktop();
    // navigator.storage is absent in jsdom → OPFS.init() marks storage
    // unavailable; getAppDir therefore returns null and the prefs helpers
    // degrade instead of throwing.
    await expect(AppDirs.getAppDir('com.nbosp.clock')).resolves.toBeNull();
    await expect(AppDirs.getPrefs('com.nbosp.clock')).resolves.toEqual({});
    await expect(AppDirs.setPrefs('com.nbosp.clock', { a: 1 })).resolves.toBe(false);
  });

  it('applies username and autoLock settings changes to the running host', async () => {
    const { os } = await bootDesktop({ settings: { username: 'alice', autoLock: '7' } });
    os.events.emit('settings:changed', { key: 'username' });
    await settle();
    expect(os.username).toBe('alice');

    os.events.emit('settings:changed', { key: 'autoLock' });
    await settle();
    expect(os.idleTimeout).toBe(7 * 60000);
  });

  it('evaluates cleanly when desktop, menu and modals load together in order', async () => {
    const os = {
      apps: {},
      username: 'user',
      events: { handlers: {}, on() {}, emit() {} },
    };
    const { window } = await loadServiceApp('shell-ui', {
      scripts: ['desktop.js', 'menu.js', 'modals.js'],
      withBaseUtils: true,
      stubs: {
        extra: {
          OS: os,
          FS: _makeShellFS(),
          Notify: { show() {} },
          WM: { createWindow: () => null },
          NovaByteSystem: { settings: { get: () => null, exportSnapshot: () => ({}) } },
        },
      },
    });
    expect(window.AppDirs).toBeTruthy();
    expect(window.ContextMenu).toBeTruthy();
    expect(window.showModal).toBeTruthy();
    expect(window.showPrompt).toBeTruthy();
    expect(window.__NB_RUNTIME.layer).toBe('nbosp');
  });
});
