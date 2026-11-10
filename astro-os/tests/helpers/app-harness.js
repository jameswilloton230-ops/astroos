// Shared harness for per-app tests (tests/apps/*.test.js).
//
// Every js/apps/<name> folder is a NovaApp: a window app ships index.html +
// app.js and registers itself through the host's global registerApp();
// a service app ships service.js and attaches a frozen service object to
// window. This harness loads either kind into a real JSDOM window the same
// way the host does — eval the script, capture what it registered — and
// hands the test the registered descriptor plus helpers to drive it.
//
// Usage (window app):
//   const { loadWindowApp, initApp } = await import('../../helpers/app-harness.js');
//   const { dom, app } = await loadWindowApp('clock');
//   const content = initApp(app);
//   // drive content.querySelector(...) — real DOM, real event handlers
//
// Usage (service app):
//   const { dom, window } = await loadServiceApp('wallpaper');
//   window.WallpaperService.apply(...)
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const APPS_BASE = new URL('../../js/apps/', import.meta.url);
const BASE_UTILS_URL = new URL('../../js/core/utils/base-utils.js', import.meta.url);
// Platform prefs helper — index.html loads it globally, so every app harness
// gets it too. Without window.NovaRegistry it falls back to the legacy
// localStorage keys, matching the pre-registry behavior these tests wrote
// their assertions against.
const REGISTRY_PREFS_URL = new URL('../../js/platform/core/registry-prefs.js', import.meta.url);

// Host-provided globals every window app may touch. Overridable per test via
// the `stubs` option (keys listed here win unless overridden).
function installCommonStubs(w, stubs = {}) {
  const ipcCalls = [];
  const nova = {
    calls: ipcCalls,
    ipc(type, payload) {
      ipcCalls.push({ type, payload });
      const h = stubs.novaHandlers?.[type];
      if (h) return Promise.resolve(h(payload));
      return Promise.resolve({ ok: true });
    },
    on() { return () => {}; },
    send() {},
  };
  const defaults = {
    // Desktop shell path builder (real one lives in shell-ui/desktop.js).
    AppDirs: {
      getAppDataPath: (appId, kind) => `/data/${appId}/${kind ?? 'files'}`,
      ensureAppDataFolder: () => Promise.resolve(),
      bootstrap: () => Promise.resolve(),
      syncKey: () => {},
    },
    nova,
    // v2 facade — apps probe it with optional chaining; a capabilities Set
    // plus no-op methods is enough unless a test overrides.
    novaOS: {
      capabilities: new Set(stubCapabilities(stubs)),
      apiVersion: 2,
    },
    nw: stubs.nw ?? {
      Window: { get: () => ({ on() {}, close() {}, show() {} }) },
      App: { quit() {} },
      Shell: { openExternal() {} },
    },
    fetch: stubs.fetch ?? (() => Promise.resolve({
      ok: false, status: 404, json: () => Promise.resolve({}),
    })),
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (stubs[key] === null) continue; // explicit null = "leave absent"
    w[key] = value;
  }
  // Escape hatch for app-specific host globals not covered above, e.g.
  // { stubs: { extra: { __novaUnrestrictedPackage: { files: {} } } } }.
  // Applied before scripts are eval'd; plain values win, functions are bound
  // to the window so `document`/`window` resolve correctly inside them.
  for (const [key, value] of Object.entries(stubs.extra ?? {})) {
    w[key] = typeof value === 'function' ? value.bind(w) : value;
  }
  // Common browser APIs jsdom lacks; inert unless an app exercises them.
  if (typeof w.matchMedia !== 'function') {
    w.matchMedia = () => ({ matches: false, media: '', addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
  }
  if (typeof w.ResizeObserver !== 'function') {
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (typeof w.IntersectionObserver !== 'function') {
    w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  }
  if (typeof w.AudioContext === 'undefined' && typeof w.webkitAudioContext === 'undefined') {
    w.AudioContext = class {
      constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
      createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
      createGain() { return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    };
  }
}

function stubCapabilities(stubs) {
  return stubs.capabilities ?? [];
}

async function evalScripts(dom, appBase, scripts, extraFirst = []) {
  for (const url of extraFirst) {
    dom.window.eval(await readFile(url, 'utf8'));
  }
  for (const script of scripts) {
    dom.window.eval(await readFile(new URL(script, appBase), 'utf8'));
  }
}

/**
 * Load a window app (index.html + app.js) into JSDOM and capture what it
 * registers with registerApp().
 * @param {string} appName folder name under js/apps/
 * @param {object} [opts] { scripts, html, stubs, withBaseUtils }
 */
export async function loadWindowApp(appName, opts = {}) {
  const { scripts = ['app.js'], html = 'index.html', stubs = {}, withBaseUtils = true } = opts;
  const appBase = new URL(`${appName}/`, APPS_BASE);
  const dom = new JSDOM(await readFile(new URL(html, appBase), 'utf8'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `https://localhost/js/apps/${appName}/${html}`,
  });
  installCommonStubs(dom.window, stubs);
  const registered = [];
  dom.window.registerApp = (config) => registered.push(config);
  const extras = withBaseUtils ? [BASE_UTILS_URL, REGISTRY_PREFS_URL] : [REGISTRY_PREFS_URL];
  await evalScripts(dom, appBase, scripts, extras);
  return { dom, window: dom.window, document: dom.window.document, registered, app: registered[0] ?? null };
}

/**
 * Load a service app (service.js, no html). Service scripts attach a frozen
 * object to window; they run against an empty document.
 * @param {string} appName folder name under js/apps/
 * @param {object} [opts] { scripts, stubs, withBaseUtils }
 */
export async function loadServiceApp(appName, opts = {}) {
  const { scripts = ['service.js'], stubs = {}, withBaseUtils = false } = opts;
  const appBase = new URL(`${appName}/`, APPS_BASE);
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `https://localhost/js/apps/${appName}/service.js`,
  });
  installCommonStubs(dom.window, stubs);
  const registered = [];
  dom.window.registerApp = (config) => registered.push(config);
  const extras = withBaseUtils ? [BASE_UTILS_URL, REGISTRY_PREFS_URL] : [REGISTRY_PREFS_URL];
  await evalScripts(dom, appBase, scripts, extras);
  return { dom, window: dom.window, document: dom.window.document, registered };
}

/**
 * Run a registered app's init() against a detached content element, the way
 * the window manager does, and return the content element for querying.
 */
export function initApp(app, { state = {}, window: w } = {}) {
  if (!app || typeof app.init !== 'function') {
    throw new TypeError('registerApp descriptor has no init()');
  }
  const doc = (w ?? globalThis.window).document;
  const content = doc.createElement('div');
  app.init(content, state);
  return content;
}

/** Await microtasks + a macrotask so queued promise chains settle. */
export async function settle(ms = 25) {
  await new Promise((r) => setTimeout(r, ms));
}
