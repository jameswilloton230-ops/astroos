import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// ── init.js tests — EARLY-BOOT HARDENING BEHAVIOR ───────────────────────────
// tests/core/core/recovery-request.test.js already covers init.js's recovery
// flow (request-file writes, astroos-power restart, boot flags, app disabling).
// This file deliberately covers DIFFERENT init.js behavior:
//   • the localStorage availability/write-test fallbacks
//   • the CVE-NB-2026-009-M3 secret-key write block
//   • the frame-busting clickjacking guard
//   • the data-fn delegated click dispatcher
//   • production console muting (and the __NOVA_DEBUG opt-out)
//   • the boot watchdog lifecycle (interval registration + os-booted teardown)
//
// Loading strategy mirrors recovery-request.test.js: the source is evaluated
// in a fresh vm context with hand-built host globals, so nothing leaks into
// or out of the vitest Node environment and no real filesystem is touched.

const initSource = readFileSync(new URL('../../../js/core/core/init.js', import.meta.url), 'utf8');

function makeConsole() {
  return {
    log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    group: vi.fn(), groupEnd: vi.fn(), groupCollapsed: vi.fn(), table: vi.fn(), dir: vi.fn(),
  };
}

/**
 * Evaluate init.js in an isolated context.
 * @param {object} opts
 *   - localStorage: a localStorage object to expose (omit for "missing storage")
 *   - top: value for window.top (defaults to the context itself = same frame)
 *   - topLocationSetter: throwing setter to simulate a cross-origin frame
 *   - debug: value for window.__NOVA_DEBUG
 */
function loadInit({ localStorage: ls, top, topLocationSetter, debug } = {}) {
  const consoleMock = makeConsole();
  const docListeners = {};
  const winListeners = {};
  const intervals = [];
  let nextIntervalId = 1;

  const document = {
    addEventListener: (type, fn) => {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    body: { style: {}, classList: { contains: () => false } },
  };

  const context = {
    console: consoleMock,
    process: { platform: 'darwin' }, // off-AstroOS: recovery handoff must stay inert
    require: () => { throw new Error('require not expected in these tests'); },
    document,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms, id: nextIntervalId });
      return nextIntervalId++;
    },
    clearInterval: vi.fn(),
    Date,
  };
  context.window = context;
  context.self = context;
  context.top = top ?? context;
  context.location = { href: 'https://localhost/index.html' };
  if (topLocationSetter) {
    Object.defineProperty(context.top, 'location', {
      set() { throw new Error('cross-origin frame'); },
      get() { return undefined; },
      configurable: true,
    });
  }
  context.addEventListener = (type, fn) => {
    (winListeners[type] = winListeners[type] || []).push(fn);
  };
  if (ls !== undefined) context.localStorage = ls;
  if (debug !== undefined) context.__NOVA_DEBUG = debug;

  // Snapshot the pristine console spies BEFORE init.js mutes them.
  const consoleBefore = { ...consoleMock };
  runInNewContext(initSource, context);
  return { context, consoleMock, consoleBefore, docListeners, winListeners, intervals };
}

// A healthy-looking storage whose writes blow up (Safari private mode shape).
function makeThrowingLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: vi.fn(() => { throw new Error('SecurityError: blocked'); }),
    removeItem: vi.fn((k) => { store.delete(k); }),
    clear: () => store.clear(),
  };
}
function makeWorkingLocalStorage() {
  const store = new Map();
  return {
    store, // exposed so assertions can check the backing store directly
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: vi.fn((k, v) => { store.set(k, String(v)); }),
    removeItem: vi.fn((k) => store.delete(k)),
    clear: () => store.clear(),
  };
}

describe('init.js localStorage hardening', () => {
  it('installs a working memory-backed localStorage when none exists', () => {
    const { context } = loadInit({});
    expect(context.localStorage).toBeDefined();

    context.localStorage.setItem('boot.count', '3');
    expect(context.localStorage.getItem('boot.count')).toBe('3');
    expect(context.localStorage.length).toBe(1);
    expect(context.localStorage.key(0)).toBe('boot.count');
    context.localStorage.removeItem('boot.count');
    expect(context.localStorage.getItem('boot.count')).toBeNull();
    expect(context.localStorage.length).toBe(0);
  });

  it('replaces a present-but-throwing localStorage with a memory-fallback wrapper', () => {
    const broken = makeThrowingLocalStorage();
    const { context } = loadInit({ localStorage: broken });

    // The original object was swapped out — writes no longer throw.
    expect(context.localStorage).not.toBe(broken);
    expect(() => context.localStorage.setItem('wm.state', 'open')).not.toThrow();
    expect(context.localStorage.getItem('wm.state')).toBe('open');
    // The wrapper still attempted the real storage first (best-effort write-through).
    expect(broken.setItem).toHaveBeenCalledWith('wm.state', 'open');
  });

  it('leaves a healthy localStorage in place but still guards it against secret writes', () => {
    const healthy = makeWorkingLocalStorage();
    const { context } = loadInit({ localStorage: healthy });

    expect(context.localStorage).toBe(healthy); // not replaced
    context.localStorage.setItem('plain.key', 'ok');
    // The guard's realSet write-through reached the underlying backing store.
    expect(healthy.store.get('plain.key')).toBe('ok');
  });
});

describe('init.js secret-write block (CVE-NB-2026-009-M3)', () => {
  it.each([
    'db_password',
    'userPasswordHash',
    'api_key',
    'apiKey-main',
    'privateKeyPem',
    'my-secret-key',
    'loginCredential',
  ])('refuses to store secret-looking key "%s" and says why', (key) => {
    const healthy = makeWorkingLocalStorage();
    const { context, consoleMock } = loadInit({ localStorage: healthy });

    expect(() => context.localStorage.setItem(key, 'value')).toThrow(/SECURITY: Refusing to store key/);
    expect(consoleMock.error).toHaveBeenCalledWith(
      expect.stringContaining(`Refusing to store key "${key}"`),
    );
    // The value must not have reached the underlying storage either.
    expect(healthy.store.has(key)).toBe(false);
  });

  it('deliberately allows overloaded non-secret terms like session/token/recovery ids', () => {
    const { context } = loadInit({});
    expect(() => context.localStorage.setItem('sessionCount', '5')).not.toThrow();
    expect(() => context.localStorage.setItem('authTokenExpiry', '1700000000')).not.toThrow();
    expect(() => context.localStorage.setItem('nova_recovery_ids', '[]')).not.toThrow();
    expect(context.localStorage.getItem('sessionCount')).toBe('5');
  });
});

describe('init.js frame-busting clickjacking guard', () => {
  it('hides page content via style (not innerHTML) when the top frame cannot be navigated', () => {
    const top = {};
    const { context } = loadInit({ top, topLocationSetter: true });
    expect(context.document.body.style.display).toBe('none');
  });

  it('does not hide content when the top frame navigation succeeds (same-origin frame)', () => {
    const top = { location: {} }; // assignable — bust "succeeds"
    const { context } = loadInit({ top });
    expect(context.document.body.style.display).toBeUndefined();
  });
});

describe('init.js data-fn delegated click handling', () => {
  function loadWithClick() {
    const loaded = loadInit({});
    const domReady = (loaded.docListeners.DOMContentLoaded || [])[0];
    expect(typeof domReady).toBe('function');
    domReady();
    const clickHandler = (loaded.docListeners.click || [])[0];
    expect(typeof clickHandler).toBe('function');
    return { ...loaded, clickHandler };
  }

  it('invokes the window function named by data-fn on a delegated click', () => {
    const { context, clickHandler } = loadWithClick();
    const fn = vi.fn();
    context.__menuOpen = fn;

    clickHandler({ target: { closest: (sel) => (sel === '[data-fn]' ? { dataset: { fn: '__menuOpen' } } : null) } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('ignores clicks that miss a data-fn element or name a non-function', () => {
    const { context, clickHandler } = loadWithClick();
    const fn = vi.fn();
    context.__menuOpen = fn;

    clickHandler({ target: { closest: () => null } });
    clickHandler({ target: { closest: () => ({ dataset: {} }) } });
    clickHandler({ target: { closest: () => ({ dataset: { fn: '__doesNotExist' } } ) } });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('init.js production console muting (CVE-NB-2026-009-H6)', () => {
  it('mutes log/info/warn/debug but keeps console.error live by default', () => {
    const { context, consoleBefore } = loadInit({});

    expect(context.console.log).not.toBe(consoleBefore.log); // replaced by a no-op
    context.console.log('leak attempt');
    expect(consoleBefore.log).not.toHaveBeenCalled();
    // Errors must still surface.
    expect(context.console.error).toBe(consoleBefore.error);
  });

  it('leaves the console untouched when window.__NOVA_DEBUG is set before boot', () => {
    const { consoleBefore, consoleMock } = loadInit({ debug: true });
    expect(consoleMock.log).toBe(consoleBefore.log);
    consoleMock.log('visible');
    expect(consoleBefore.log).toHaveBeenCalledWith('visible');
  });
});

describe('init.js boot watchdog', () => {
  it('registers a 2s poll and window._bootStartTime', () => {
    const { context, intervals } = loadInit({});
    expect(context._bootStartTime).toBeTypeOf('number');
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(2000);
  });

  it('stops polling once the body reports os-booted (no recovery request)', () => {
    const { context, intervals } = loadInit({});
    context.document.body.classList.contains = () => true;
    intervals[0].fn();
    expect(context.clearInterval).toHaveBeenCalledWith(intervals[0].id);
  });

  it('keeps polling while the boot screen is still up and the OS has not booted', () => {
    const { context, intervals } = loadInit({});
    // body.classList.contains -> false (default stub), boot-screen absent.
    intervals[0].fn();
    expect(context.clearInterval).not.toHaveBeenCalled();
  });

  it('exposes the frozen NovaRecovery surface (recovery flow itself covered elsewhere)', () => {
    const { context } = loadInit({});
    expect(typeof context.NovaRecovery.isAvailable).toBe('function');
    expect(typeof context.NovaRecovery.request).toBe('function');
    expect(Object.isFrozen(context.NovaRecovery)).toBe(true);
    // Off AstroOS Linux there is no recovery handoff available.
    expect(context.NovaRecovery.isAvailable()).toBe(false);
  });

  it('ignores non-syntax window errors entirely (no recovery, no app disabling)', () => {
    const { context, winListeners } = loadInit({});
    const errorHandlers = winListeners.error || [];
    expect(errorHandlers).toHaveLength(1);
    expect(() => errorHandlers[0]({ message: 'TypeError: x is not a function', filename: '/js/core/core/boot.js' })).not.toThrow();
    expect(context.localStorage.getItem('nova_disabled_apps')).toBeNull();
  });
});
