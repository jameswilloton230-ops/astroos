'use strict';
// AstroOS — real guest-bridge simulator.
//
// This helper reproduces the REAL sandbox runtime as closely as Node allows,
// with zero production code changes:
//
//   ┌──────────────── main world (vm context) ────────────────┐
//   │  capability shim (buildCapabilityShim output, run via  │
//   │  the REAL injectCapabilityShim on the app's real HTML) │
//   │  → window.nova / window.novaOS / NovaXHR / NovaWS      │
//   └──────────────┬─────────────────────────────────────────┘
//                  │ MessagePort (claim-port handshake via
//                  │ window.postMessage, exactly like Chromium)
//   ┌──────────────┴─────────────────────────────────────────┐
//   │  isolated world (vm context)                            │
//   │  transport script (buildIsolatedTransportScript)       │
//   │  → console.log(IPC_MARKER + …)                          │
//   └──────────────┬─────────────────────────────────────────┘
//                  │ webview 'consolemessage' event
//   ┌──────────────┴─────────────────────────────────────────┐
//   │  host: REAL setupAPIBridge console handler →           │
//   │  REAL handleAPICall → REAL respond() →                 │
//   │  webview.executeScript into window.__novaInbox         │
//   └────────────────────────────────────────────────────────┘
//
// The two "worlds" are separate vm contexts (separate JS globals), sharing
// only the DOM-facing window object — the same split Chromium makes between
// an isolated-world content script and the page's main world. A guest page
// cannot see the transport script's console.log wiring because each context
// gets its own `console`.
//
// App code that would run inside the webview is executed as real inline
// <script> blocks extracted from the REAL injectCapabilityShim() output —
// the same byte stream a packaged app actually receives.

const vm = require('vm');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');

const env = require('./env');
const { AppSandbox, AppPermissionManager } = env;
const AstroOS = path.join(__dirname, '..', '..');

const INTERNAL = AppSandbox._internal;

// ── rich clickable DOM (dialogs can be answered like a user would) ──

function makeRichNode(tag) {
  const handlers = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    // Element nodes: nodeType 1, with the parentElement alias the host's
    // event forwarders read alongside parentNode.
    nodeType: 1,
    style: {}, dataset: {}, children: [],
    textContent: '', value: '', className: '',
    disabled: false, checked: false, removed: false,
    parentNode: null,
    get parentElement() { return node.parentNode; },
    append(...kids) { for (const k of kids) { k.parentNode = node; node.children.push(k); } },
    appendChild(k) { k.parentNode = node; node.children.push(k); return k; },
    replaceChildren(...kids) {
      for (const k of node.children) k.parentNode = null;
      node.children.length = 0;
      for (const k of kids) { k.parentNode = node; node.children.push(k); }
    },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { (node.attrs ||= {})[k] = String(v); },
    getAttribute(k) { return node.attrs ? (node.attrs[k] ?? null) : null; },
    removeAttribute(k) { if (node.attrs) delete node.attrs[k]; },
    // Minimal selector fidelity for the host's overlay event forwarder,
    // which resolves the interaction target with
    // eventTarget.closest('[data-nova-action], [data-nova-field]').
    closest(selector) {
      const alternatives = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
      const matches = (n) => alternatives.some((sel) => {
        if (sel.startsWith('[') && sel.endsWith(']')) {
          const attr = sel.slice(1, -1);
          return !!(n.attrs && n.attrs[attr] !== undefined);
        }
        return n.tagName === sel.toUpperCase();
      });
      let cur = node;
      while (cur) {
        if (matches(cur)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() { node.removed = true; },
    focus() {}, select() {}, click() {},
    classList: {
      add(...c) { node.classListStore = new Set([...(node.classListStore || []), ...c]); },
      remove(...c) { for (const x of c) node.classListStore?.delete(x); },
      toggle() {},
      contains(c) { return node.classListStore?.has(c) ?? false; },
    },
    __handlers: handlers,
    // Real click/input/change/submit/keydown events bubble from the target
    // through every ancestor, so a document-level overlay listener sees
    // element-level __fire() calls like a user click would.
    __fire(type, evt = {}) {
      const event = { stopPropagation() { event.__stopped = true; }, preventDefault() {}, ...evt, target: node, type };
      let cur = node;
      while (cur) {
        for (const fn of cur.__handlers?.[type] || []) {
          try { fn(event); } catch (_) {}
        }
        if (event.__stopped) break;
        cur = cur.parentNode;
      }
    },
  };
  return node;
}

function findInTree(root, pred) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (pred(n)) return n;
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return null;
}

let toastContainer = null;

function installRichDocument() {
  toastContainer = makeRichNode('div');
  toastContainer.id = 'toast-container';
  const body = makeRichNode('body');
  const head = makeRichNode('head');
  global.document = {
    readyState: 'complete',
    body, head,
    addEventListener() {},
    removeEventListener() {},
    cookie: '',
    visibilityState: 'visible',
    hasFocus: () => true,
    getElementById(id) { return id === 'toast-container' ? toastContainer : null; },
    createElement(tag) {
      const node = makeRichNode(tag);
      if (String(tag).toLowerCase() === 'iframe') installIframeFidelity(node);
      return node;
    },
    createTextNode(text) { const n = makeRichNode('#text'); n.textContent = text; return n; },
    createDocumentFragment() { return makeRichNode('#fragment'); },
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.createEl = (tag, opts = {}) => {
    const n = makeRichNode(tag);
    if (opts.className != null) n.className = opts.className;
    if (opts.textContent != null) n.textContent = opts.textContent;
    if (opts.role != null) n.setAttribute('role', opts.role);
    if (opts.style != null) {
      if (typeof opts.style === 'string') n.style.cssText = opts.style;
      else Object.assign(n.style, opts.style);
    }
    return n;
  };
}

installRichDocument();

// ── host-realm window fidelity (the overlay/dialog code lives here) ──

// The host page IS a window; the overlay handler registers resize/scroll
// listeners and reads NovaSystemWebview off it. helpers/env.js may already
// have installed a bare window stub — augment it with the DOM-event surface
// the host realm needs instead of replacing it.
if (!global.window) global.window = global;
global.window.addEventListener = global.window.addEventListener || (() => {});
global.window.removeEventListener = global.window.removeEventListener || (() => {});
global.window.innerWidth = global.window.innerWidth || 1280;
global.window.innerHeight = global.window.innerHeight || 800;
global.addEventListener = global.addEventListener || global.window.addEventListener;
global.removeEventListener = global.removeEventListener || global.window.removeEventListener;
if (typeof global.getComputedStyle !== 'function') {
  global.getComputedStyle = () => ({
    visibility: 'visible', display: 'block', pointerEvents: 'auto', zIndex: 'auto',
    getPropertyValue: () => '',
  });
}

// DOMPurify equivalent for the simulator's host realm. The production host
// loads the real DOMPurify; the overlay path only needs sanitize() to strip
// the forbidden tags/attributes the handler config already names.
if (typeof global.DOMPurify === 'undefined') {
  global.DOMPurify = {
    sanitize(html, options = {}) {
      const forbiddenTags = new Set((options.FORBID_TAGS || []).map((t) => String(t).toLowerCase()));
      const forbiddenAttrs = new Set((options.FORBID_ATTR || []).map((a) => String(a).toLowerCase()));
      let out = String(html)
        .replace(/<!--(?!--\[)[\s\S]*?-->/g, '')
        .replace(/<\/?([a-zA-Z0-9-]+)((?:\s+[^<>]*?)?)\s*\/?>/g, (match, tagName, attrs) => {
          if (forbiddenTags.has(String(tagName).toLowerCase())) return '';
          const cleanedAttrs = String(attrs || '').replace(/([^=\s"'>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, (attrMatch, attrName, attrValue) => {
            const name = String(attrName).toLowerCase();
            if (forbiddenAttrs.has(name) || name.startsWith('on')) return '';
            if (/^(href|src|action|formaction)$/i.test(name) && /^\s*(javascript|data:text\/html)/i.test(attrValue)) return '';
            return attrMatch;
          });
          return `<${match.startsWith('</') ? '/' : ''}${tagName}${cleanedAttrs}>`;
        });
      return out;
    },
  };
}

// A rich contentDocument for simulator <iframe> elements: parse simple HTML
// into rich nodes (attributes preserved) so the host's overlay renderer can
// attach listeners and the audit can click [data-nova-action] elements.
function makeRichSubDocument(ownerNode) {
  const doc = makeRichNode('#document');
  doc.body = makeRichNode('body');
  doc.head = makeRichNode('head');
  doc.body.parentNode = doc;
  doc.head.parentNode = doc;
  doc.documentElement = makeRichNode('html');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  doc.appendChild(doc.documentElement);
  doc.createElement = (tag) => makeRichNode(tag);
  doc.createTextNode = (text) => { const n = makeRichNode('#text'); n.textContent = text; return n; };
  Object.defineProperty(doc.body, 'innerHTML', {
    set(html) {
      doc.body.replaceChildren();
      const tagPattern = /<([a-zA-Z0-9-]+)((?:\s+[^<>]*?)?)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9-]+)((?:\s+[^<>]*?)?)\/>/g;
      let match;
      while ((match = tagPattern.exec(String(html))) !== null) {
        const tagName = match[1] || match[4];
        const attrsRaw = match[2] || match[5] || '';
        const text = match[3] ?? '';
        const el = makeRichNode(tagName);
        const attrPattern = /([^=\s"'>]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
        let attr;
        while ((attr = attrPattern.exec(attrsRaw)) !== null) {
          el.setAttribute(attr[1], attr[2].replace(/^(["'])([\s\S]*)\1$/, '$2'));
        }
        el.textContent = text;
        doc.body.appendChild(el);
      }
    },
    get() { return ''; },
    configurable: true,
  });
  void ownerNode;
  return doc;
}

// A simulator <iframe> behaves like the real thing for the overlay flow:
// contentDocument exists, and 'load' fires (async) once the element is
// appended to the document with a srcdoc assigned.
function installIframeFidelity(iframe) {
  let doc = null;
  let loadArmed = false;
  Object.defineProperty(iframe, 'contentDocument', {
    get() {
      if (!doc) doc = makeRichSubDocument(iframe);
      return doc;
    },
    configurable: true,
  });
  const maybeFireLoad = () => {
    if (loadArmed || iframe.removed) return;
    loadArmed = true;
    setImmediate(() => {
      if (iframe.removed) return;
      iframe.__fire('load');
    });
  };
  let srcdocValue = '';
  Object.defineProperty(iframe, 'srcdoc', {
    set(v) {
      srcdocValue = String(v);
      // A real browser fires 'load' after parsing srcdoc; the host assigns
      // srcdoc then appends, so deferring to the next tick lands after the
      // append without needing parent-side hooks.
      maybeFireLoad();
    },
    get() { return srcdocValue; },
    configurable: true,
  });
}

// ── OS event bus (same on/off/emit contract the real shell exposes) ──

function makeEmitter() {
  const map = new Map();
  return {
    on(ev, fn) {
      if (!map.has(ev)) map.set(ev, []);
      map.get(ev).push(fn);
    },
    off(ev, fn) {
      const l = map.get(ev);
      if (l) { const i = l.indexOf(fn); if (i > -1) l.splice(i, 1); }
    },
    emit(ev, data) {
      for (const fn of [...(map.get(ev) || [])]) fn(data);
    },
  };
}

if (!global.OS.events) global.OS.events = makeEmitter();

// Browsers expose requestAnimationFrame; the SystemDialogs picker uses it
// to focus its grid after rendering.
if (typeof global.requestAnimationFrame !== 'function') {
  global.requestAnimationFrame = (fn) => setTimeout(fn, 16);
}

// ── real SystemDialogs service (the production picker) ──
// Loaded with require injected so the service's Node fs/path usage works;
// it attaches window.SystemDialogs, exactly as the shell does. nova:files:*
// and nova:sysdialog:* route here in production.
try {
  const svcSrc = fs.readFileSync(path.join(AstroOS, 'js', 'apps', 'system-dialogs', 'service.js'), 'utf8');
  new Function('require', 'module', 'exports', svcSrc)(require, { exports: {} }, {});
} catch (e) {
  console.error('[guest] SystemDialogs service failed to load:', e);
}

// ── guest-side DOM classes ──
// The capability shim patches Document.prototype.createElement,
// Element.prototype.innerHTML and HTMLAnchorElement.prototype.click, so the
// guest document and its nodes must genuinely inherit from these prototypes
// — exactly like a real browser — or the patches would intercept nothing.

function GuestElement() {}
Object.defineProperty(GuestElement.prototype, 'innerHTML', {
  get() { return this._innerHTML || ''; },
  set(v) { this._innerHTML = String(v); },
  configurable: true,
});
function GuestHTMLElement() {}
Object.setPrototypeOf(GuestHTMLElement.prototype, GuestElement.prototype);
function GuestHTMLAnchorElement() {}
Object.setPrototypeOf(GuestHTMLAnchorElement.prototype, GuestHTMLElement.prototype);
GuestHTMLAnchorElement.prototype.click = function click() {};

function makeGuestNode(tag) {
  const handlers = {};
  const node = Object.create(GuestHTMLElement.prototype);
  Object.assign(node, {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, children: [],
    textContent: '', value: '', className: '',
    disabled: false, checked: false, removed: false,
    append(...kids) { for (const k of kids) node.children.push(k); },
    appendChild(k) { node.children.push(k); return k; },
    replaceChildren(...kids) { node.children.length = 0; node.children.push(...kids); },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = handlers[type];
      if (list) { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }
    },
    setAttribute(k, v) { (node.attrs ||= {})[k] = String(v); },
    getAttribute(k) { return node.attrs ? (node.attrs[k] ?? null) : null; },
    removeAttribute(k) { if (node.attrs) delete node.attrs[k]; },
    querySelector: () => null,
    querySelectorAll: () => [],
    remove() { node.removed = true; },
    focus() {}, select() {}, click() {},
    classList: {
      add(...c) { node.classListStore = new Set([...(node.classListStore || []), ...c]); },
      remove(...c) { for (const x of c) node.classListStore?.delete(x); },
      toggle() {},
      contains(c) { return node.classListStore?.has(c) ?? false; },
    },
    __handlers: handlers,
    __fire(type, evt = {}) {
      for (const fn of handlers[type] || []) fn({ stopPropagation() {}, preventDefault() {}, ...evt });
    },
  });
  return node;
}

function GuestDocument() {}
GuestDocument.prototype.createElement = function createElement(tag, options) {
  return makeGuestNode(tag);
};

function makeGuestDocument() {
  const doc = Object.create(GuestDocument.prototype);
  Object.assign(doc, {
    readyState: 'complete',
    title: '',
    visibilityState: 'visible',
    hasFocus: () => true,
    cookie: '',
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    createTextNode(text) { const n = makeGuestNode('#text'); n.textContent = text; return n; },
    createDocumentFragment() { return makeGuestNode('#fragment'); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    execCommand: () => true,
  });
  doc.body = makeGuestNode('body');
  doc.head = makeGuestNode('head');
  doc.documentElement = makeGuestNode('html');
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

// ── in-process MessageChannel (postMessage semantics, async delivery) ──

function createMessageChannelPair() {
  function makePort() {
    const port = {
      onmessage: null,
      _started: false,
      _queued: [],
      _other: null,
      postMessage(data) {
        const other = port._other;
        if (!other) throw new TypeError('MessagePort.postMessage: no destination port connected');
        other._queued.push(data);
        other._schedule();
      },
      start() {
        port._started = true;
        port._schedule();
      },
      close() {
        port._started = false;
        port.onmessage = null;
        port._queued.length = 0;
      },
      _schedule() {
        if (!port._started || !port.onmessage || port._scheduled) return;
        port._scheduled = true;
        setImmediate(() => {
          port._scheduled = false;
          while (port._started && port.onmessage && port._queued.length) {
            const data = port._queued.shift();
            port.onmessage({ data });
          }
        });
      },
    };
    return port;
  }
  const a = makePort();
  const b = makePort();
  a._other = b;
  b._other = a;
  return [a, b];
}

class SimMessageChannel {
  constructor() {
    const [port1, port2] = createMessageChannelPair();
    this.port1 = port1;
    this.port2 = port2;
  }
}

// ── the guest ──

const SERVE_HOST = 'apps.sandbox.invalid';
let guestSeq = 0;

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

// Extract inline <script> bodies in document order (external src= scripts
// are deferred by the real deferPackagedScripts and are not simulated).
function extractInlineScripts(html) {
  const scripts = [];
  let m;
  const re = new RegExp(SCRIPT_RE.source, 'gi');
  while ((m = re.exec(html)) !== null) {
    if (/\ssrc\s*=/i.test(m[1])) continue;
    scripts.push(m[2]);
  }
  return scripts;
}

function createGuestWindow(sandboxId, entry) {
  const listeners = new Map(); // type -> Set<fn>
  const location = {
    href: `https://${SERVE_HOST}/api/apps/serve/${sandboxId}/${entry}`,
    origin: `https://${SERVE_HOST}`,
    pathname: `/api/apps/serve/${sandboxId}/${entry}`,
    protocol: 'https:',
    host: SERVE_HOST,
  };
  const crypto = {
    randomUUID: () => webcrypto.randomUUID(),
  };
  const w = {
    location,
    crypto,
    innerWidth: 1280,
    innerHeight: 800,
    // A <webview> guest has no parent process reference — parent === self,
    // exactly like the real sandbox (see the respond() comment upstream).
    get parent() { return w; },
    get top() { return w; },
    get self() { return w; },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(event); } catch (e) { setImmediate(() => { throw e; }); }
      }
    },
    postMessage(data, targetOrigin, transfer) {
      const event = {
        data,
        source: w,
        origin: typeof targetOrigin === 'string' && targetOrigin ? targetOrigin : location.origin,
        ports: Array.isArray(transfer) ? transfer : [],
      };
      // Browsers deliver window.postMessage asynchronously; deliver on the
      // next macrotask so listener re-entrancy matches production semantics.
      setImmediate(() => w.dispatchEvent('message', event));
    },
  };
  return w;
}

function makeGuestWebview(appId, sandboxId, isolatedContext) {
  const listeners = new Map();
  const wv = {
    dataset: { appId, sandboxId },
    src: null,
    // A real NW.js <webview> is a DOM element: it always has a live style
    // object. Host code (e.g. the system dialogs) toggles
    // webview.style.visibility while a modal is open, so the simulator
    // must carry one too or those flows crash the host.
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 };
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emitConsoleMessage(message) {
      const set = listeners.get('consolemessage');
      if (!set) return;
      for (const fn of [...set]) fn({ message: String(message) });
    },
    // Host-initiated guest code execution. Default target is the isolated
    // world — exactly like NW.js executeScript (mainWorld defaults to false)
    // and exactly what respond() and the IPC payload pull rely on.
    executeScript(details, cb) {
      let result;
      try {
        result = vm.runInContext(details.code, isolatedContext, { timeout: 5000 });
      } catch (e) {
        result = undefined;
      }
      if (typeof cb === 'function') setImmediate(() => cb([result]));
      return Promise.resolve([result]);
    },
    close() {}, focus() {}, minimize() {}, maximize() {},
    getWebContentsId() { return 1; },
  };
  return wv;
}

// Launch a packaged app "inside the sandbox": real injectCapabilityShim on
// its real entry HTML, real transport script in the isolated world, real
// setupAPIBridge on the host side. Returns the live guest session.
//
// opts:
//   appId, manifest, html, launchOptions, name, system, permissions (app record)
function launchGuestApp(opts) {
  const appId = opts.appId;
  const sandboxId = 'gsb-' + (++guestSeq);
  const entry = 'index.html';

  const app = env.makeApp(appId, {
    name: opts.name || appId,
    manifest: opts.manifest || {},
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  });
  app.id = appId;
  app.entry = entry;
  app.type = 'blank';
  app.files = { [entry]: Buffer.from(opts.html, 'utf8').toString('base64') };
  env.state.AppRegistry._apps.set(appId, app);
  global.OS.apps[appId] = app;

  const guestWindow = createGuestWindow(sandboxId, entry);
  // The native fetch the shim captures for self-file downloads.
  guestWindow.fetch = (...args) => global.fetch(...args);
  guestWindow.eval = (code) => vm.runInContext(code, null); // replaced below

  const sandboxRecord = {
    appId,
    webview: null,
    iframe: null,
    state: { width: 800, height: 600, x: 10, y: 10, minimized: false, maximized: false, title: opts.name || appId },
    windowId: 'win-1',
    wsConnections: new Map(),
    appIpcEndpoints: new Set(),
    ipcBroadcastActions: new Set(),
    openFile: null,
    homeSurface: false,
    nestedWebviewOptedIn: false,
  };

  // Isolated world context — gets its own console so ONLY the transport
  // script's console.log reaches the host as a consolemessage event.
  const isolatedContext = vm.createContext({
    window: guestWindow,
    console: null, // set below (needs the webview)
    setTimeout, clearTimeout, setInterval, clearInterval,
    MessageChannel: SimMessageChannel,
    TextDecoder, TextEncoder, atob, btoa, URL,
  });

  const webview = makeGuestWebview(appId, sandboxId, isolatedContext);
  sandboxRecord.webview = webview;
  sandboxRecord.iframe = webview;

  isolatedContext.console = {
    log: (...args) => { for (const a of args) webview.emitConsoleMessage(String(a)); },
    warn: () => {}, error: () => {}, info: () => {}, debug: () => {},
  };

  const guestDocument = makeGuestDocument();

  // Main world context — the guest page's own realm.
  const mainContext = vm.createContext({
    window: guestWindow,
    document: guestDocument,
    navigator: global.navigator,
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Headers: global.Headers, Response: global.Response, Request: global.Request,
    fetch: global.fetch,
    TextDecoder, TextEncoder, atob, btoa, URL, URLSearchParams,
    MessageChannel: SimMessageChannel,
    ArrayBuffer: global.ArrayBuffer, Uint8Array: global.Uint8Array,
    Blob: global.Blob,
    Document: GuestDocument,
    Element: GuestElement,
    HTMLElement: GuestHTMLElement,
    HTMLAnchorElement: GuestHTMLAnchorElement,
    customElements: { define() {}, get() { return undefined; } },
    MutationObserver: class MutationObserver {
      constructor() {} observe() {} disconnect() {} takeRecords() { return []; }
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    FileReader: class FileReader {
      readAsText() {} readAsDataURL() {} readAsArrayBuffer() {}
    },
    Event: class Event {}, CustomEvent: class CustomEvent {},
    addEventListener: () => {}, removeEventListener: () => {},
  });
  guestWindow.eval = (code) => vm.runInContext(code, mainContext);

  // Register the sandbox as active and wire the REAL host bridge.
  INTERNAL._activeSandboxes.set(sandboxId, sandboxRecord);
  INTERNAL._eventSubscriptions.set(sandboxId, new Map());
  const teardownBridge = INTERNAL.setupAPIBridge(webview, app, sandboxId, sandboxRecord);

  // 1. Isolated-world transport script — document_start semantics: it runs
  //    before ANY page script, exactly like addContentScripts does.
  vm.runInContext(INTERNAL.buildIsolatedTransportScript(), isolatedContext);

  // 2. Real injection pipeline on the app's real HTML.
  const rawHtml = Buffer.from(app.files[entry], 'base64').toString('utf8');
  const shimmedHtml = INTERNAL.injectCapabilityShim(rawHtml, app, opts.launchOptions || {});

  // 3. Run every inline script in document order in the main world. The
  //    first two are the injected options-shim and capability shim; the
  //    rest are the app's own code — the same order a browser executes.
  const appScripts = extractInlineScripts(shimmedHtml);
  const results = { scriptsRun: 0, scriptErrors: [] };
  for (const src of appScripts) {
    try {
      vm.runInContext(src, mainContext);
      results.scriptsRun++;
    } catch (e) {
      results.scriptErrors.push(String(e && e.message || e));
    }
  }

  const teardown = () => {
    INTERNAL._activeSandboxes.delete(sandboxId);
    INTERNAL._eventSubscriptions.delete(sandboxId);
    teardownBridge();
  };

  return {
    app, appId, sandboxId, webview, sandbox: sandboxRecord,
    window: guestWindow,
    nova: guestWindow.nova,
    novaOS: guestWindow.novaOS,
    teardown,
    results,
  };
}

// Await a guest promise created inside the main-world vm context. Promises
// from a vm context are thenable across realms, so awaiting works directly.
function settle(promise, ms = 8000) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => setTimeout(() => rej(new Error('guest promise did not settle within ' + ms + 'ms')), ms)),
  ]);
}

module.exports = {
  env,
  launchGuestApp,
  settle,
  makeRichNode,
  makeGuestNode,
  findInTree,
  installRichDocument,
  makeEmitter,
  INTERNAL,
};
