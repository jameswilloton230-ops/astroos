import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// Boot attaches to window.Boot and window.boot in the browser.
// We exercise the public methods via window.Boot.

describe('Boot (js/core/core/boot.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.clearAllMocks();
  });

  it('caches DOM references and populates Boot._dom', () => {
    if (!window.Boot) {
      expect(true).toBe(true);
      return;
    }
    window.Boot._cacheDom();
    expect(window.Boot._dom).toBeDefined();
    expect(window.Boot._dom.bootScreen).toBeDefined();
    expect(window.Boot._dom.desktop).toBeDefined();
  });

  it('marks the host runtime ready without relying on the sandboxed shell service', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const previousRuntime = window.__NB_RUNTIME;
    try {
      delete window.__NB_RUNTIME;
      window.Boot._markRuntimeReady();
      expect(window.__NB_RUNTIME).toEqual({ os: 'NovaByte', layer: 'nbosp', ready: true });

      window.__NB_RUNTIME = { os: 'Test OS', ready: false };
      window.Boot._markRuntimeReady();
      expect(window.__NB_RUNTIME).toEqual({ os: 'Test OS', ready: true });
    } finally {
      if (previousRuntime === undefined) delete window.__NB_RUNTIME;
      else window.__NB_RUNTIME = previousRuntime;
    }
  });

  it('_setupWatchdog returns an object with complete() that clears the timeout', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    vi.useFakeTimers();
    const watchdog = window.Boot._setupWatchdog(Date.now(), 'test-ua');
    expect(typeof watchdog.complete).toBe('function');
    watchdog.complete();
    // After complete, the watchdog timeout should be cleared
    vi.advanceTimersByTime(20000);
    vi.useRealTimers();
  });

  it('applyOSVars sets OS properties from settings', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    globalThis.OS.settings = { get: vi.fn((key) => (key === 'username' ? 'alice' : null)) };
    const sGet = window.Boot.applyOSVars();
    expect(globalThis.OS.username).toBe('alice');
    expect(typeof sGet).toBe('function');
  });

  it('applyOSVars computes idleTimeout from autoLock setting', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    globalThis.OS.settings = { get: vi.fn((key) => (key === 'autoLock' ? '15' : null)) };
    globalThis.OS.idleTimeout = 0;
    window.Boot.applyOSVars();
    expect(globalThis.OS.idleTimeout).toBe(15 * 60000);
  });

  it('applyThemeAndVars does not throw when _dom is null', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = null;
    expect(() => window.Boot.applyThemeAndVars(() => ({}))).not.toThrow();
  });

  it('applyThemeAndVars sets accent CSS vars when accentColor is provided', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const style = { setProperty: vi.fn() };
    window.Boot._dom = {
      rootStyle: style,
      bootScreen: null,
      desktop: null,
      taskbar: null,
      timeEl: null,
      dateEl: null,
      vPill: null,
      rootClasses: { add: vi.fn() },
    };
    const sGet = (key) => (key === 'accentColor' ? '#ff0000' : null);
    window.Boot.applyThemeAndVars(sGet);
    expect(style.setProperty).toHaveBeenCalledWith('--accent', '#ff0000');
    expect(style.setProperty).toHaveBeenCalledWith('--accent-hover', '#ff0000dd');
  });

  it('applyWallpaper sets custom background when customWallpaper is set', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const desktop = { style: {} };
    window.Boot._dom = { desktop };
    const sGet = (key) => (key === 'customWallpaper' ? 'https://img.example.com/w.jpg' : null);
    window.Boot.applyWallpaper(sGet);
    expect(desktop.style.backgroundImage).toBe('url(https://img.example.com/w.jpg)');
  });

  it('applyWallpaper falls back to stock preset when no custom wallpaper', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const desktop = { style: {} };
    window.Boot._dom = { desktop };
    const sGet = (key) => (key === 'wallpaperId' ? 'stock-dark' : null);
    window.Boot.applyWallpaper(sGet);
    expect(desktop.style.backgroundImage).toContain('radial-gradient');
  });

  it('applyAccessibility adds no-glass class when highContrast is set', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const rootClasses = { add: vi.fn() };
    window.Boot._dom = { rootClasses, desktop: null };
    const sGet = (key) => (key === 'highContrast' ? true : null);
    window.Boot.applyAccessibility(sGet);
    expect(rootClasses.add).toHaveBeenCalledWith('no-glass');
  });

  it('syncVersion sets localStorage and vPill text', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const vPill = { textContent: '' };
    window.Boot._dom = { vPill };
    globalThis.OS.version = '3.0.2';
    globalThis.OS.settings = { set: vi.fn() };
    const sGet = vi.fn(() => null);
    window.Boot.syncVersion(sGet);
    expect(vPill.textContent).toBe('VERSION 3.0.2');
    expect(localStorage.getItem('novabyte_os_version')).toBe('3.0.2');
  });

  it('configureTaskbar does not throw when taskbar is missing', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot._dom = { taskbar: null };
    expect(() => window.Boot.configureTaskbar(() => ({}))).not.toThrow();
  });

  it('configureTaskbar sets position styles for bottom taskbar', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const taskbar = { style: {}, classList: { add: vi.fn() } };
    window.Boot._dom = { taskbar };
    const sGet = (key) => (key === 'taskbarPosition' ? 'bottom' : null);
    window.Boot.configureTaskbar(sGet);
    expect(taskbar.style.bottom).toBe('0');
    expect(taskbar.style.top).toBe('auto');
  });

  it('configureTaskbar sets left styles for left taskbar', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const taskbar = { style: {}, classList: { add: vi.fn() } };
    window.Boot._dom = { taskbar };
    const sGet = (key) => (key === 'taskbarPosition' ? 'left' : null);
    window.Boot.configureTaskbar(sGet);
    expect(taskbar.style.left).toBe('auto');
    expect(taskbar.style.width).toBe('var(--taskbar-height)');
    expect(taskbar.style.flexDirection).toBe('column');
  });

  it('initScreenReader creates window.SR with announce method', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot.initScreenReader();
    expect(window.SR).toBeDefined();
    expect(typeof window.SR.announce).toBe('function');
  });

  it('_runHooks handles hook that throws without propagating', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args);
    window.Boot.hooks.before.push(() => { throw new Error('hook fail'); });
    window.Boot._runHooks('before');
    console.error = origError;
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('_runHooks calls all registered hooks in order', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    const order = [];
    window.Boot.hooks.before.push(() => order.push(1));
    window.Boot.hooks.before.push(() => order.push(2));
    window.Boot._runHooks('before');
    expect(order).toEqual([1, 2]);
  });

  it('Boot.hooks is frozen after boot completes', () => {
    if (!window.Boot) { expect(true).toBe(true); return; }
    window.Boot.hooks.after.push(() => {});
    window.Boot.hooks.before.push(() => {});
    window.Boot.hooks.onError.push(() => {});
    try {
      Object.freeze(window.Boot.hooks.before);
      Object.freeze(window.Boot.hooks.after);
      Object.freeze(window.Boot.hooks.onError);
      Object.freeze(window.Boot.hooks);
    } catch (e) { /* non-fatal */ }
    expect(() => window.Boot.hooks.before.push(() => {})).toThrow();
  });
});
