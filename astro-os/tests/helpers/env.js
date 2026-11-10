'use strict';
// Test environment for the AstroOS IPC/permission matrix suite.
//
// Loads the REAL app-sandbox.js, the REAL app-permission-manager.js and the
// REAL notifications service into a stubbed browser-ish global environment,
// then exposes helpers to drive every API handler through handleAPICall and
// capture exactly what would be delivered back over the guest bridge.

const fs = require('fs');
const path = require('path');

const AstroOS = path.join(__dirname, '..', '..');

// ── fake browser environment (install before requiring any module) ──

require('./fake-idb').install(global);

const lsMap = new Map();
global.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => { lsMap.set(k, String(v)); },
  removeItem: (k) => { lsMap.delete(k); },
  clear: () => { lsMap.clear(); },
  key: (i) => ([...lsMap.keys()][i] ?? null),
  get length() { return lsMap.size; },
};

global.window = {
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { href: 'file:///usr/share/novabyte/index.html' },
};

// Node ≥21 exposes a read-only global `navigator` getter — override safely.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    geolocation: null,
    mediaDevices: undefined,
    userAgent: 'nova-test',
    clipboard: {
      async readText() { return global.OS?.clipboard ?? ''; },
      async writeText(t) { global.__sysClipboard = t; },
    },
  },
  configurable: true, writable: true,
});

global.document = {
  readyState: 'complete',
  addEventListener() {},
  cookie: '',
  execCommand: () => true,
  getElementById: () => null,
  createElement: () => ({
    style: {}, textContent: '', value: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, replaceChildren() {},
    focus() {}, select() {}, remove() {}, setAttribute() {}, removeAttribute() {},
  }),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
};

// Host-side security event log (respondError feeds this).
global.EventLog = {
  entries: [],
  log(e) { this.entries.push(e); },
  clear() { this.entries = []; },
};

// Host shell state — the subset handlers touch.
const { createFakeFS } = require('./fake-fs');
global.FS = createFakeFS();

function freshOS() {
  return {
    version: '3.0.2',
    securityPatch: '2026-08-02',
    username: 'nova',
    _bootTime: Date.now(),
    notifications: [],
    notifUnread: 0,
    dnd: false,
    clipboard: '',
    clipboardHistory: [],
    // nova:app:install / nova:app:uninstall keep per-app manifest state here.
    apps: {},
    windows: new Map([['win-1', {
      id: 'win-1', x: 10, y: 10, width: 800, height: 600,
      maximized: false, minimized: false,
      titleText: { textContent: 'Test' },
      element: { style: {}, classList: { remove() {}, add() {} } },
    }]]),
    settings: {
      _m: new Map(),
      get(k) { return this._m.has(k) ? this._m.get(k) : undefined; },
      set(k, v) { this._m.set(k, v); return true; },
    },
  };
}
global.OS = freshOS();

// Window manager stub — handlers guard WM usage, but provide the basics.
global.WM = {
  windows: new Map(),
  openApp() { return null; },
  closeWindow() { return true; },
  focusWindow() {},
  minimizeWindow() {},
  maximizeWindow() {},
};

// Controllable app registry.
global.AppRegistry = {
  _apps: new Map(),
  getApp(id) { return this._apps.get(id) || null; },
  getAllApps() { return [...this._apps.values()]; },
  isAppInstalled() { return this._apps.has('x'); }, // never used directly; overridden below
};
AppRegistry.isAppInstalled = (id) => AppRegistry._apps.has(id);

// Array-shaped registry + default-apps service used by home:* handlers.
global.APP_REGISTRY = [];
global.DefaultApps = { getDefault: (type) => (type === 'home' ? 'com.matrix.app' : null) };

// Stubs required by the notifications service module.
let idSeq = 0;
global.generateId = () => 'n' + (++idSeq);
global.createEl = () => ({
  style: {}, textContent: '', dataset: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, addEventListener() {}, replaceChildren() {}, remove() {},
});
global.svgIcon = () => '';
global.updateNotificationBadge = () => {};

// ── load the real permission manager ──
const AppPermissionManager = require(path.join(AstroOS, 'js/platform/security/app-permission-manager.js'));
global.AppPermissionManager = AppPermissionManager;
const AppSecrets = require(path.join(AstroOS, 'js/platform/security/app-secrets.js'));
global.AppSecrets = AppSecrets;

// ── load the real AstroOS Registry engine (window.NovaRegistry) ──
// The nova:reg:* handlers resolve window.NovaRegistry at request time; give
// them the REAL engine over an in-memory store so the matrix exercises the
// full storage/quota path without touching disk (or the localStorage state
// other suites assert on). resetHost() re-inits it, same as OS/FS.
const regStore = new Map();
const NovaRegistry = require(path.join(AstroOS, 'js/platform/core/nova-registry.js'));
const registryEvents = {
  _m: Object.create(null),
  on(event, fn) { (this._m[event] = this._m[event] || []).push(fn); },
  off(event, fn) {
    const list = this._m[event];
    if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
  },
  emit(event, data) {
    const list = (this._m[event] || []).slice();
    for (const fn of list) { try { fn(data); } catch (_) {} }
  },
};
const registryStorage = {
  loadAll() {
    const out = {};
    for (const hive of NovaRegistry.HIVES) {
      out[hive] = regStore.has(hive) ? JSON.parse(regStore.get(hive)) : null;
    }
    return out;
  },
  save(hive, data) { regStore.set(hive, JSON.stringify(data)); },
};
function resetRegistry() {
  regStore.clear();
  NovaRegistry.init({ storage: registryStorage, events: registryEvents, logger: console });
}
resetRegistry();
global.window.NovaRegistry = NovaRegistry;
global.__registryEvents = registryEvents;

// ── load the real notifications service (sets window.Notify) ──
const svcSource = fs.readFileSync(path.join(AstroOS, 'js/apps/notifications/service.js'), 'utf8');
// Indirect eval runs it in global scope with the stubs above in place.
(0, eval)(svcSource);
global.Notify = global.window.Notify;

// ── load the real sandbox ──
const AppSandbox = require(path.join(AstroOS, 'js/platform/security/app-sandbox.js'));

// ── network stubs ──
const fetchCalls = [];
function jsonResponse(status, body) {
  const payload = JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: {
      get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null),
      entries: () => [['content-type', 'application/json']][Symbol.iterator](),
      forEach: (fn) => fn('application/json', 'content-type'),
    },
    text: () => Promise.resolve(payload),
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new TextEncoder().encode(payload).buffer),
    blob: () => Promise.resolve({ size: payload.length }),
  });
}
global.fetch = function stubFetch(url, opts) {
  fetchCalls.push({ url: String(url), opts });
  const u = String(url);
  // Host service endpoints the sandbox itself talks to.
  if (u === '/api/security/settings') return jsonResponse(200, { success: true, data: { _meta: { adminMode: true } } });
  if (u === '/api/push/subscribe') {
    const body = JSON.parse(opts?.body || '{}');
    return jsonResponse(200, { ok: true, subscribed: Array.isArray(body.subscriptions) ? body.subscriptions.length : 0 });
  }
  if (u.startsWith('/api/security/audit')) return jsonResponse(200, { success: true, data: [], pagination: {}, statistics: {} });
  if (u.startsWith('/api/admin')) return jsonResponse(200, { success: true, data: {} });
  // Mirrors the REAL /api/proxy response contract (server/proxies.js):
  // { status, statusText, headers, body, bodyEncoding } — the sandbox's
  // external-fetch path reads exactly these fields.
  if (u.includes('/api/proxy')) return jsonResponse(200, {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
    bodyEncoding: 'utf8',
  });
  if (u.startsWith('https://ok.example.com') || u.startsWith('http://ok.example.com') || u.startsWith('http://127.0.0.1')) {
    return jsonResponse(200, { hello: 'world' });
  }
  // The guest simulator's own serve host — a self-file fetch from inside a
  // sandbox (native path, no net permission) lands here.
  if (u.startsWith('https://apps.sandbox.invalid/')) {
    return Promise.resolve({
      ok: true, status: 200, statusText: 'OK',
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'text/html' : null) },
      text: () => Promise.resolve('<!DOCTYPE html><html><body>app entry</body></html>'),
      json: () => Promise.reject(new TypeError('not json')),
    });
  }
  return Promise.reject(new TypeError('stubFetch: no route for ' + u));
};

global.WebSocket = class StubWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    setImmediate(() => { if (this.onopen) this.onopen({}); });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; setImmediate(() => { if (this.onclose) this.onclose({}); }); }
  addEventListener() {}
  removeEventListener() {}
};
// Static readyState constants — the real WebSocket class exposes them and
// handleNetWsSend compares against WebSocket.OPEN.
global.WebSocket.CONNECTING = 0;
global.WebSocket.OPEN = 1;
global.WebSocket.CLOSING = 2;
global.WebSocket.CLOSED = 3;

// ── entity factories ──

function makeApp(id, extra = {}) {
  return {
    id,
    name: extra.name || id,
    manifest: extra.manifest || { ipc: { exports: ['service:echo'], receives: ['chat.message'] } },
    ...extra,
  };
}

function makeWebview(appId) {
  const wv = {
    dataset: { appId: appId || '', sandboxId: 'sb-' + (++reqSeq) },
    responses: [],
    doubles: 0,
    __directResponder(msg) {
      if (wv.responses.length >= 1 && wv.responses[0].requestId === msg.requestId) wv.doubles++;
      wv.responses.push(msg);
    },
    executeScript() {}, close() {}, focus() {}, minimize() {}, maximize() {},
    restore() {}, setBounds() {}, getBounds() { return { width: 800, height: 600 }; },
    addEventListener() {}, removeEventListener() {},
    getWebContentsId() { return 1; },
  };
  return wv;
}

function makeSandbox(appId, extra = {}) {
  return {
    appId,
    webview: extra.webview || null,
    iframe: null,
    state: { width: 800, height: 600, x: 10, y: 10, minimized: false, maximized: false, title: 'Test' },
    windowId: 'win-1',
    wsConnections: new Map(),
    appIpcEndpoints: new Set(),
    ipcBroadcastActions: new Set(),
    openFile: null,
    homeSurface: false,
    nestedWebviewOptedIn: false,
    ...extra,
  };
}

let reqSeq = 0;

function registerActive(sandbox) {
  const id = sandbox.webview?.dataset?.sandboxId || 'sb-x';
  AppSandbox._internal._activeSandboxes.set(id, sandbox);
  return id;
}

// Drive one API call through the real dispatcher and return the single
// response object the guest would receive. Detects the "handler responded
// twice" and "handler never responded" conditions as synthetic error codes
// DOUBLE_RESPONSE / NO_RESPONSE so the suite can flag bridge-contract bugs.
async function call(type, payload, opts = {}) {
  const app = opts.app || AppRegistry.getApp(opts.appId || 'com.test.app') || makeApp(opts.appId || 'com.test.app');
  const webview = opts.webview || makeWebview(app.id);
  webview.dataset.appId = app.id;
  const sandbox = opts.sandbox || makeSandbox(app.id, { webview });
  // Register the sandbox as active so ipc:* handlers accept it.
  AppSandbox._internal._activeSandboxes.set(webview.dataset.sandboxId, sandbox);
  // Fresh capture per call — a reused webview (e.g. an IPC target sandbox)
  // must not have earlier traffic flagged as a double response.
  webview.responses.length = 0;
  webview.doubles = 0;
  const requestId = opts.requestId || `req-${++reqSeq}`;
  await AppSandbox._internal.handleAPICall(type, payload, requestId, app, webview, sandbox);
  await new Promise((r) => setTimeout(r, opts.settleMs ?? 25));
  if (webview.responses.length === 0) {
    return { type: `${type}:response`, requestId, result: null, error: { code: 'NO_RESPONSE', message: 'handler never responded' }, __webview: webview, __sandbox: sandbox };
  }
  if (webview.responses.length > 1) {
    return { type: `${type}:response`, requestId, result: null, error: { code: 'DOUBLE_RESPONSE', message: `${webview.responses.length} responses for one request` }, __webview: webview, __sandbox: sandbox };
  }
  return { ...webview.responses[0], __webview: webview, __sandbox: sandbox };
}

async function grant(permission, appId) {
  await AppPermissionManager.grantPermission(permission, appId, { source: 'test' });
}
async function revoke(permission, appId) {
  await AppPermissionManager.revokePermission(permission, appId, { source: 'test' });
}

// Reset all host-side module state between phases without wiping the
// permission manager's own persisted grants (lsMap keeps those).
function resetHost() {
  AppSandbox._internal._resetState();
  global.OS = freshOS();
  global.FS = createFakeFS();
  global.EventLog.clear();
  resetRegistry();
  for (const k of [...lsMap.keys()]) {
    if (k.startsWith('novaOS_notif')) lsMap.delete(k);
  }
  fetchCalls.length = 0;
}

module.exports = {
  AppSandbox, AppPermissionManager, AppSecrets, Notify, NovaRegistry,
  makeApp, makeWebview, makeSandbox, call, grant, revoke, resetHost, registerActive,
  fetchCalls,
  state: {
    get ls() { return lsMap; },
    get FS() { return global.FS; },
    get OS() { return global.OS; },
    get AppRegistry() { return global.AppRegistry; },
    get WM() { return global.WM; },
  },
};
