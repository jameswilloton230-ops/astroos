import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';

const systemWebviewSource = readFileSync(
  new URL('../../../js/apps/system-webview/service.js', import.meta.url),
  'utf8'
);

/* Minimal DOM stubs — just enough surface for the freeze/bookkeeping paths
   of the system webview service. */
function makeStyle() {
  const style = {};
  Object.defineProperty(style, 'cssText', {
    set(value) {
      for (const declaration of String(value).split(';')) {
        const colon = declaration.indexOf(':');
        if (colon <= 0) continue;
        const prop = declaration.slice(0, colon).trim();
        const camel = prop.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        if (camel) style[camel] = declaration.slice(colon + 1).trim();
      }
    },
    get() {
      return Object.entries(style)
        .filter(([, v]) => typeof v === 'string')
        .map(([k, v]) => `${k.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}:${v}`)
        .join(';');
    },
    configurable: true,
    enumerable: true,
  });
  return style;
}

function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: makeStyle(),
    attrs: new Map(),
    listeners: new Map(),
    children: [],
    parentNode: null,
    ownerDocument: doc,
    isRoot: false,
    clientWidth: 4096,
    clientHeight: 2160,
  };
  Object.defineProperty(el, 'isConnected', {
    get() {
      let node = el;
      while (node.parentNode) node = node.parentNode;
      return Boolean(node.isRoot);
    },
  });
  el.setAttribute = (name, value) => el.attrs.set(name, value);
  el.getAttribute = name => (el.attrs.has(name) ? el.attrs.get(name) : null);
  el.removeAttribute = name => el.attrs.delete(name);
  el.addEventListener = (name, fn) => {
    const arr = el.listeners.get(name) || [];
    arr.push(fn);
    el.listeners.set(name, arr);
  };
  el.removeEventListener = (name, fn) => {
    const arr = el.listeners.get(name) || [];
    const index = arr.indexOf(fn);
    if (index >= 0) arr.splice(index, 1);
  };
  el.dispatch = (name, event) => {
    for (const fn of [...(el.listeners.get(name) || [])]) fn(event);
  };
  el.appendChild = child => {
    el.children.push(child);
    child.parentNode = el;
    return child;
  };
  el.insertBefore = (child, ref) => {
    const index = ref ? el.children.indexOf(ref) : -1;
    if (index < 0) el.children.push(child);
    else el.children.splice(index, 0, child);
    child.parentNode = el;
    return child;
  };
  el.remove = () => {
    if (!el.parentNode) return;
    const index = el.parentNode.children.indexOf(el);
    if (index >= 0) el.parentNode.children.splice(index, 1);
    el.parentNode = null;
  };
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  return el;
}

function setup() {
  const root = makeEl('div');
  root.isRoot = true;
  const fakeDocument = { createElement: tag => makeEl(tag, fakeDocument) };
  installSystemWebview();
  vi.stubGlobal('document', fakeDocument);
  return root;
}

function installSystemWebview(windowObject = {}) {
  vi.stubGlobal('window', windowObject);
  new Function(systemWebviewSource)();
  return windowObject.NovaSystemWebview;
}

function makeService(root, { captureResult = 'data:image/png;base64,AAAA' } = {}) {
  const service = window.NovaSystemWebview;
  const responses = [];
  const sandbox = { webview: null, state: { content: root } };
  const callbacks = {
    respond: (webview, type, requestId, result) => responses.push({ type, requestId, result }),
    respondError: (webview, type, requestId, code, message) => responses.push({ type, requestId, error: { code, message } }),
    generateRequestId: (() => {
      let n = 0;
      return () => `req_${++n}`;
    })(),
    log: () => {},
    canNavigate: () => true,
    setupPermissionRequestGate: () => () => {},
  };
  let child = null;
  const request = async payload => {
    const before = root.children.length;
    await service.handleRequest({
      payload,
      requestId: payload.requestId ?? `rq_${responses.length}`,
      app: { id: 'com.example.app' },
      webview: {},
      sandbox,
      callbacks,
    });
    // The create path builds its guest via document.createElement — hand it
    // back to the test for event dispatch and capture wiring.
    if (payload.action === 'create' && root.children.length > before) {
      child = root.children[root.children.length - 1];
      if (captureResult && typeof captureResult !== 'function') {
        child.capturePage = cb => {
          if (typeof captureResult === 'string') cb(captureResult);
          return undefined;
        };
      } else if (captureResult === null) {
        child.capturePage = undefined;
      }
    }
    return child;
  };
  return { service, responses, sandbox, request, getChild: () => child };
}

describe('SystemWebview guest freeze (overlay sandwich)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides the guest behind a captured still and restores it on unfreeze', async () => {
    const root = setup();
    const { request, getChild, responses } = makeService(root);

    const child = await request({ action: 'create', id: 'nvw_freeze1', attributes: {} });
    expect(child.style.visibility).toBeUndefined();
    responses.length = 0;

    await request({ action: 'freeze', id: 'nvw_freeze1' });
    expect(responses[0].result).toMatchObject({ success: true, captured: true });
    expect(child.style.visibility).toBe('hidden');
    const twin = root.children.find(node => node !== child && node.tagName === 'IMG');
    expect(twin).toBeDefined();
    expect(twin.style.pointerEvents).toBe('none');
    expect(twin.style.left).toBe(child.style.left || '0px');

    // Bounds updates while frozen keep the still aligned with the guest.
    await request({
      action: 'bounds',
      id: 'nvw_freeze1',
      bounds: { left: 10, top: 20, width: 300, height: 200, visible: true },
    });
    expect(twin.style.left).toBe('10px');
    expect(twin.style.top).toBe('20px');
    expect(twin.style.width).toBe('300px');
    expect(child.style.visibility).toBe('hidden');

    await request({ action: 'unfreeze', id: 'nvw_freeze1' });
    expect(child.style.visibility).toBe('visible');
    expect(root.children.includes(twin)).toBe(false);
  });

  it('falls back to a plain hide when capturePage is unavailable', async () => {
    const root = setup();
    const { request, getChild, responses } = makeService(root, { captureResult: null });

    await request({ action: 'create', id: 'nvw_freeze2', attributes: {} });
    const child = getChild();
    responses.length = 0;

    await request({ action: 'freeze', id: 'nvw_freeze2' });
    expect(responses[0].result).toMatchObject({ success: true, captured: false });
    expect(child.style.visibility).toBe('hidden');
    expect(root.children.filter(node => node.tagName === 'IMG')).toHaveLength(0);

    await request({ action: 'unfreeze', id: 'nvw_freeze2' });
    expect(child.style.visibility).toBe('visible');
  });

  it('refcounts sandbox-level freezes so overlapping overlays restore correctly', async () => {
    const root = setup();
    const { service, request, sandbox, getChild } = makeService(root);

    await request({ action: 'create', id: 'nvw_freeze3', attributes: {} });
    const child = getChild();
    const appWebview = makeEl('webview', document);
    root.appendChild(appWebview);
    sandbox.webview = appWebview;

    // Overlay + context menu open on top of each other.
    await service.freezeSandbox(sandbox);
    await service.freezeSandbox(sandbox);
    expect(appWebview.style.visibility).toBe('hidden');
    expect(child.style.visibility).toBe('hidden');

    service.restoreSandbox(sandbox);
    expect(appWebview.style.visibility).toBe('hidden');
    expect(child.style.visibility).toBe('hidden');

    service.restoreSandbox(sandbox);
    expect(appWebview.style.visibility).toBe('visible');
    expect(child.style.visibility).toBe('visible');
  });

  it('drops the captured still when the view is destroyed while frozen', async () => {
    const root = setup();
    const { request, getChild } = makeService(root);

    await request({ action: 'create', id: 'nvw_freeze4', attributes: {} });
    const child = getChild();
    await request({ action: 'freeze', id: 'nvw_freeze4' });
    const twin = root.children.find(node => node !== child && node.tagName === 'IMG');
    expect(twin).toBeDefined();

    await request({ action: 'destroy', id: 'nvw_freeze4' });
    expect(root.children.includes(twin)).toBe(false);
  });
});

describe('SystemWebview annotation layer', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createWithAnnotation(root, options) {
    const { request, getChild } = makeService(root);
    const child = await request({ action: 'create', id: 'nvw_annot1', attributes: {} });
    const codes = [];
    child.executeScript = (details, cb) => {
      codes.push(details.code);
      if (typeof cb === 'function') cb([true]);
    };
    await request({ action: 'annotation', id: 'nvw_annot1', command: 'enable', options });
    return { child, codes, request };
  }

  it('injects the layer into the guest and applies requested style', async () => {
    const root = setup();
    const { codes } = await createWithAnnotation(root, { color: '#123456', lineWidth: 5, active: true });
    expect(codes[0]).toContain('__novaAnnotationLayer');
    expect(codes[0]).toContain('data-nova-annotation-layer');
    expect(codes[1]).toContain('configure(');
    expect(codes[1]).toContain('#123456');
  });

  it('re-injects and re-applies options after every loadstop', async () => {
    const root = setup();
    const { child, codes, request } = await createWithAnnotation(root, { color: '#010203', active: false });
    codes.length = 0;

    child.dispatch('loadstop', { url: 'https://example.test/' });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(codes[0]).toContain('__novaAnnotationLayer');
    expect(codes[1]).toContain('#010203');
    await request({ action: 'annotation', id: 'nvw_annot1', command: 'style', options: { color: '#445566' } });
    expect(codes[codes.length - 1]).toContain('#445566');
  });

  it('forwards guest export payloads as annotation-export view events', async () => {
    const root = setup();
    const { responses, request, getChild } = makeService(root);
    await request({ action: 'create', id: 'nvw_annot1', attributes: {} });
    const child = getChild();
    responses.length = 0;

    const marker = '__NOVA_ANNOTATION_EXPORT__:nvw_annot1:';
    child.dispatch('consolemessage', { message: `${marker}data:image/png;base64,BBBB` });

    const event = responses.find(entry => entry.type === 'nova:nested-webview:event');
    expect(event).toBeDefined();
    expect(event.result).toMatchObject({
      proxyId: 'nvw_annot1',
      eventName: 'annotation-export',
      dataUrl: 'data:image/png;base64,BBBB',
    });

    // Oversized or malformed payloads are dropped.
    responses.length = 0;
    child.dispatch('consolemessage', { message: `${marker}javascript:alert(1)` });
    child.dispatch('consolemessage', { message: `${marker}${'x'.repeat(2_000_001)}` });
    expect(responses).toHaveLength(0);
  });
});
