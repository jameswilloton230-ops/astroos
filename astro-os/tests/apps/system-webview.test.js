import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../../js/apps/system-webview/service.js', import.meta.url),
  'utf8'
);

function loadService(windowObject = {}) {
  vi.stubGlobal('window', windowObject);
  new Function(source)();
  return windowObject.NovaSystemWebview;
}

function createCallbacks(responses = []) {
  return {
    respond: (webview, type, requestId, result) => responses.push({ type, requestId, result }),
    respondError: (webview, type, requestId, code, message) => responses.push({
      type, requestId, error: { code, message },
    }),
    generateRequestId: () => 'popup-test',
    log: vi.fn(),
    canNavigate: vi.fn(() => true),
    setupPermissionRequestGate: vi.fn(() => vi.fn()),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Astro System Webview service', () => {
  it('creates isolated guests with app-scoped storage and owns their teardown', async () => {
    const listeners = new Map();
    const attributes = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn((name, value) => attributes.set(name, value)),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
    };
    const parent = { isConnected: true, style: {}, appendChild: vi.fn() };
    const sandbox = { state: { content: parent } };
    const webview = {};
    const responses = [];
    const callbacks = createCallbacks(responses);
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });

    await service.handleRequest({
      payload: {
        action: 'create',
        id: 'nvw_service_test',
        attributes: { src: 'https://example.test/', allowpopups: '' },
      },
      requestId: 'create-view',
      app: { id: 'com.example.app' },
      webview,
      sandbox,
      callbacks,
    });

    expect(Object.fromEntries(attributes)).toMatchObject({
      nodeintegration: 'false',
      nodeintegrationsubframes: 'false',
      enableremotemodule: 'false',
      partition: 'persist:app_com.example.app_webcontent',
      allowpopups: '',
    });
    expect(attributes.has('sandbox')).toBe(false);
    expect(child.src).toBe('https://example.test/');
    expect(callbacks.setupPermissionRequestGate).toHaveBeenCalledWith(child);
    expect(parent.appendChild).toHaveBeenCalledWith(child);
    expect(responses[0].result).toEqual({ success: true });

    expect(service.destroySandbox(sandbox)).toBe(true);
    expect(child.remove).toHaveBeenCalledOnce();
    expect(service.destroySandbox(sandbox)).toBe(false);
  });

  it('rejects navigation without the caller-provided network authorization', async () => {
    const createElement = vi.fn();
    const responses = [];
    const callbacks = createCallbacks(responses);
    callbacks.canNavigate.mockReturnValue(false);
    const service = loadService();
    vi.stubGlobal('document', { createElement });

    await service.handleRequest({
      payload: {
        action: 'create',
        id: 'nvw_denied',
        attributes: { src: 'http://127.0.0.1/' },
      },
      requestId: 'denied-navigation',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox: { state: { content: { isConnected: true, style: {}, appendChild: vi.fn() } } },
      callbacks,
    });

    expect(createElement).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('bounds guests to their app content and destroys pending popups on grant revocation', async () => {
    vi.useFakeTimers();
    const listeners = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
    };
    const parent = { isConnected: true, clientWidth: 400, clientHeight: 300, style: {}, appendChild: vi.fn() };
    const sandbox = { state: { content: parent } };
    const popup = { attach: vi.fn(), discard: vi.fn() };
    const responses = [];
    const callbacks = createCallbacks(responses);
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });

    await service.handleRequest({
      payload: { action: 'create', id: 'nvw_revoke' },
      requestId: 'create-revoke-view',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox,
      callbacks,
    });
    await service.handleRequest({
      payload: { action: 'bounds', id: 'nvw_revoke', bounds: { left: 350, top: 250, width: 100, height: 100, visible: true } },
      requestId: 'set-bounds',
      app: { id: 'com.example.app' },
      webview: {},
      sandbox,
      callbacks,
    });

    expect(child.style).toMatchObject({
      left: '350px',
      top: '250px',
      width: '50px',
      height: '50px',
      display: 'flex',
    });

    const newWindow = { preventDefault: vi.fn(), window: popup };
    listeners.get('newwindow')(newWindow);
    expect(newWindow.preventDefault).toHaveBeenCalledOnce();
    expect(service.revokeApp('com.example.app')).toBe(true);
    expect(child.remove).toHaveBeenCalledOnce();
    expect(popup.discard).toHaveBeenCalledOnce();
    expect(service.revokeApp('com.example.app')).toBe(false);
    vi.useRealTimers();
  });
});

describe('Astro System Webview trusted guests', () => {
  function makeView() {
    const attributes = new Map();
    const listeners = [];
    return {
      attributes,
      listeners,
      style: {},
      setAttribute: vi.fn((k, v) => attributes.set(k, v)),
      addEventListener: vi.fn((t, fn) => listeners.push([t, fn])),
      removeEventListener: vi.fn(),
      remove: vi.fn(),
      setZoom: vi.fn(),
      setUserAgentOverride: vi.fn(),
      executeScript: vi.fn((details, cb) => cb(['https://example.test/'])),
    };
  }
  const browser = { id: 'com.astroos.browser', system: true };
  const parentOf = () => ({ appendChild: vi.fn() });

  it('refuses third-party and spoofed callers', () => {
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(makeView) });
    for (const app of [
      { id: 'com.example.app' },
      { id: 'com.example.app', system: true },
      { id: 'com.astroos.browser' },
      null,
    ]) {
      expect(() => service.createTrustedGuest(app, { parent: parentOf() }))
        .toThrow(/limited to system apps/);
    }
  });

  it('builds a browser-style guest with a caller-chosen partition', () => {
    const view = makeView();
    const parent = parentOf();
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => view) });

    const guest = service.createTrustedGuest(browser, {
      parent, guestId: 'tab1', partition: 'persist:b123', style: 'width:100%;',
    });

    expect(guest.element).toBe(view);
    expect(parent.appendChild).toHaveBeenCalledWith(view);
    expect(Object.fromEntries(view.attributes)).toMatchObject({
      partition: 'persist:b123',
      nodeintegration: 'false',
      nodeintegrationsubframes: 'false',
      enableremotemodule: 'false',
      allowfullscreen: 'true',
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
    });
    expect(view.style.cssText).toBe('width:100%;');
  });

  it('keeps incognito guests off any persistent partition', () => {
    const view = makeView();
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => view) });

    service.createTrustedGuest(browser, {
      parent: parentOf(), guestId: 'tab2', incognito: true, partition: 'persist:b123',
    });

    const partition = view.attributes.get('partition');
    expect(partition).toBe('incognito_com.astroos.browser_tab2');
    expect(partition.startsWith('persist:')).toBe(false);
  });

  it('rejects malformed partition names and can omit the sandbox attribute', () => {
    const service = loadService();
    for (const partition of ['', 'persist:', 'persist:a b', 'persist:../x', 'x'.repeat(200), 42]) {
      vi.stubGlobal('document', { createElement: vi.fn(makeView) });
      expect(() => service.createTrustedGuest(browser, { parent: parentOf(), partition }))
        .toThrow(/Invalid partition/);
    }

    const view = makeView();
    vi.stubGlobal('document', { createElement: vi.fn(() => view) });
    service.createTrustedGuest(browser, { parent: parentOf(), partition: 'persist:webapp_wa_1', sandbox: null });
    expect(view.attributes.has('sandbox')).toBe(false);
    expect(view.attributes.get('partition')).toBe('persist:webapp_wa_1');
  });

  it('blocks script-scheme navigation and exposes guest controls', async () => {
    const view = makeView();
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => view) });
    const guest = service.createTrustedGuest(browser, { parent: parentOf() });

    expect(() => guest.navigate('javascript:alert(1)')).toThrow(/Blocked navigation/);
    expect(() => guest.navigate('  JavaScript:alert(1)')).toThrow(/Blocked navigation/);
    guest.navigate('http://localhost:3000/');
    expect(view.src).toBe('http://localhost:3000/');

    guest.setZoom(1.5);
    guest.setUserAgent('UA/1');
    expect(view.setZoom).toHaveBeenCalledWith(1.5);
    expect(view.setUserAgentOverride).toHaveBeenCalledWith('UA/1');
    await expect(guest.getUrl()).resolves.toBe('https://example.test/');
  });

  it('tears down listeners and the element, and revokeApp cleans up leftovers', () => {
    const first = makeView();
    const second = makeView();
    const views = [first, second];
    const service = loadService();
    vi.stubGlobal('document', { createElement: vi.fn(() => views.shift()) });

    const a = service.createTrustedGuest(browser, { parent: parentOf() });
    service.createTrustedGuest(browser, { parent: parentOf() });
    const handler = vi.fn();
    a.on('loadstop', handler);

    a.destroy();
    a.destroy();
    expect(first.remove).toHaveBeenCalledOnce();
    expect(first.removeEventListener).toHaveBeenCalledWith('loadstop', handler);
    expect(() => a.navigate('https://example.test/')).toThrow(/destroyed/);

    expect(service.revokeApp('com.astroos.browser')).toBe(true);
    expect(second.remove).toHaveBeenCalledOnce();
    expect(service.destroyTrustedGuests('com.astroos.browser')).toBe(false);
  });
});
