// tests/apps/registry.test.js — SERVICE side of the app registry.
// js/apps/registry/service.js REPLACES the host's registerApp capture stub
// with its own implementation, defines APP_REGISTRY, the WebAppManager
// localStorage store, the web-app entry builder, the URL/mailto openers and
// the document-level link interceptor. (The platform-side registry is covered
// by tests/platform/core/app-registry.test.js.)
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

function makeOS() {
  const settings = new Map();
  return {
    apps: {},
    windows: new Map(),
    settings: {
      get: (k) => (settings.has(k) ? settings.get(k) : null),
      set: (k, v) => settings.set(k, v),
    },
  };
}

function makeWM() {
  const created = [];
  const closed = [];
  let taskbarCalls = 0;
  return {
    created,
    closed,
    taskbarCalls: () => taskbarCalls,
    createWindow: (appId, opts) => { created.push({ appId, opts }); return { id: `win-${created.length}` }; },
    closeWindow: (wid) => closed.push(wid),
    updateTaskbar: () => { taskbarCalls++; },
  };
}

// Minimal FS with a Desktop folder + shortcut bookkeeping (same contract as
// js/core/services/fs.js — only what removeWebApp touches).
function makeFSWithDesktop(desktopFiles = []) {
  const files = new Map();
  const children = new Map();
  let idc = 0;
  const gen = () => `fs-${++idc}`;
  const index = (f) => {
    let m = children.get(f.parentId);
    if (!m) { m = new Map(); children.set(f.parentId, m); }
    m.set(f.id, f);
  };
  const fs = {
    files,
    specialFolders: {},
    deleted: [],
    createdNodes: [],
    listDir(folderId) {
      const m = children.get(folderId);
      return m ? [...m.values()] : [];
    },
    async permanentDelete(id) {
      children.get(files.get(id)?.parentId)?.delete(id);
      files.delete(id);
      this.deleted.push(id);
    },
  };
  const desktop = { id: gen(), name: 'Desktop', type: 'folder', parentId: 'root' };
  files.set(desktop.id, desktop);
  index(desktop);
  fs.specialFolders.desktop = desktop.id;
  for (const f of desktopFiles) {
    const node = { id: gen(), type: 'file', parentId: desktop.id, ...f };
    files.set(node.id, node);
    index(node);
    fs.createdNodes.push(node);
  }
  return fs;
}

async function boot(extra = {}) {
  const os = makeOS();
  const wm = makeWM();
  const { window } = await loadServiceApp('registry', {
    scripts: ['service.js'],
    stubs: { extra: { OS: os, WM: wm, ...extra } },
  });
  return { window, os, wm };
}

describe('Registry service (js/apps/registry/service.js)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches the registry globals and its own registerApp to window', async () => {
    const { window, os } = await boot();
    expect(Array.isArray(window.APP_REGISTRY)).toBe(true);
    expect(typeof window.registerApp).toBe('function');
    expect(typeof window.WebAppManager.getAllApps).toBe('function');
    expect(typeof window.buildWebAppEntry).toBe('function');
    expect(typeof window.openWebApp).toBe('function');
    expect(typeof window.removeWebApp).toBe('function');
    // the OS-level link openers are installed at eval time
    expect(typeof os.openUrl).toBe('function');
    expect(typeof os.openMailto).toBe('function');
    // the script's own registerApp writes through to OS.apps
    const config = { id: 'com.test.x', name: 'X' };
    window.registerApp(config);
    expect(os.apps['com.test.x']).toBe(config);
  });

  it('registerApp appends new apps and replaces duplicates in place', async () => {
    const { window, os } = await boot();
    const reg = window.APP_REGISTRY;
    const a = { id: 'app.a', name: 'A' };
    const b = { id: 'app.b', name: 'B' };
    window.registerApp(a);
    window.registerApp(b);
    expect(reg).toHaveLength(2);
    expect(os.apps['app.a']).toBe(a);
    expect(os.apps['app.b']).toBe(b);

    // hot-reload of the same id must REPLACE, not append
    const a2 = { id: 'app.a', name: 'A v2' };
    window.registerApp(a2);
    expect(reg).toHaveLength(2);
    expect(reg.find((x) => x.id === 'app.a')).toBe(a2);
    expect(os.apps['app.a']).toBe(a2);
  });

  it('WebAppManager stores web apps in localStorage with generated ids', async () => {
    const { window } = await boot();
    const mgr = window.WebAppManager;
    const app = mgr.addApp({ name: 'My Tool', url: 'https://tool.example.com', icon: '🔧' });
    expect(app.id).toMatch(/^wa_/);
    expect(app.name).toBe('My Tool');
    expect(app.launchCount).toBe(0);
    expect(typeof app.addedAt).toBe('number');

    expect(mgr.getApp(app.id).url).toBe('https://tool.example.com');
    expect(mgr.getApp('nope')).toBeNull();
    expect(mgr.getAllApps()).toHaveLength(1);
    expect(JSON.parse(window.localStorage.getItem('nova_webapps'))).toHaveLength(1);

    // defaults for a bare addApp
    const bare = mgr.addApp({});
    expect(bare.name).toBe('Web App');
    expect(bare.url).toBe('');
    expect(bare.icon).toBe('🌐');
  });

  it('launchApp bumps launchCount/lastUsed and removeApp deletes the record', async () => {
    const { window } = await boot();
    const mgr = window.WebAppManager;
    const app = mgr.addApp({ name: 'Counts', url: 'https://c.example.com' });

    mgr.launchApp(app.id);
    let stored = JSON.parse(window.localStorage.getItem('nova_webapps'));
    expect(stored[0].launchCount).toBe(1);
    expect(typeof stored[0].lastUsed).toBe('number');

    mgr.launchApp(app.id);
    stored = JSON.parse(window.localStorage.getItem('nova_webapps'));
    expect(stored[0].launchCount).toBe(2);

    // launching an unknown id is a no-op, not an error
    expect(() => mgr.launchApp('missing')).not.toThrow();

    mgr.removeApp(app.id);
    expect(mgr.getApp(app.id)).toBeNull();
    expect(window.localStorage.getItem('nova_webapps')).toBe('[]');
  });

  it('buildWebAppEntry creates a window entry that renders a URL bar + webview', () => {
    // buildWebAppEntry needs no boot-time state; call it through a booted realm
    return (async () => {
      const { window } = await boot();
      const entry = window.buildWebAppEntry({ name: 'Maps', icon: '🗺️', url: 'https://maps.example.com' });
      expect(entry.name).toBe('Maps');
      expect(entry.icon).toBe('🗺️');
      expect(entry.defaultSize).toEqual([900, 640]);
      expect(entry.minSize).toEqual([400, 300]);
      expect(typeof entry.init).toBe('function');

      const content = window.document.createElement('div');
      entry.init(content);
      expect(content.style.padding).toBe('0px'); // jsdom normalizes 0 -> 0px
      const urlBar = content.firstChild;
      expect(urlBar.textContent).toBe('🔒 maps.example.com');
      const webview = content.querySelector('webview');
      expect(webview).toBeTruthy();
      expect(webview.src).toBe('https://maps.example.com');

      // invalid URL falls back to the generic label
      const bad = window.buildWebAppEntry({ name: 'Bad', url: '::not a url::' });
      const badContent = window.document.createElement('div');
      bad.init(badContent);
      expect(badContent.textContent).toContain('External Web App');
    })();
  });

  it('buildWebAppEntry builds its guest through the System Webview service with its own partition', async () => {
    const { window } = await boot();
    const handle = { element: window.document.createElement('webview'), navigate: vi.fn(), destroy: vi.fn() };
    window.NovaSystemWebview = { createTrustedGuest: vi.fn(() => handle) };

    const entry = window.buildWebAppEntry({ id: 'wa_1.2/x', name: 'Maps', url: 'https://maps.example.com' });
    const content = window.document.createElement('div');
    const state = { cleanups: [] };
    entry.init(content, state);

    const [caller, options] = window.NovaSystemWebview.createTrustedGuest.mock.calls[0];
    expect(caller).toEqual({ id: 'com.astroos.service.registry', system: true });
    expect(options.partition).toBe('persist:webapp_wa_1_2_x');
    expect(options.sandbox).toBeNull();
    expect(options.parent).toBe(content.firstChild);
    expect(handle.navigate).toHaveBeenCalledWith('https://maps.example.com');

    // window close runs the registered cleanup, which destroys the guest
    expect(state.cleanups).toHaveLength(1);
    state.cleanups[0]();
    expect(handle.destroy).toHaveBeenCalledOnce();
  });

  it('buildWebAppEntry falls back to a plain webview when the record has no usable id', async () => {
    const { window } = await boot();
    window.NovaSystemWebview = { createTrustedGuest: vi.fn() };

    const entry = window.buildWebAppEntry({ name: 'NoId', url: 'https://x.example.com' });
    const content = window.document.createElement('div');
    entry.init(content, { cleanups: [] });

    expect(window.NovaSystemWebview.createTrustedGuest).not.toHaveBeenCalled();
    expect(content.querySelector('webview').src).toBe('https://x.example.com');
  });

  it('openWebApp registers an OS.apps entry, counts the launch and opens a window', async () => {
    const { window, os, wm } = await boot();
    const wa = window.WebAppManager.addApp({ name: 'Pinned', url: 'https://p.example.com' });

    const result = window.openWebApp(wa.id);
    expect(result).toEqual({ id: 'win-1' });
    expect(wm.created[0].appId).toBe(`webapp_${wa.id}`);
    expect(os.apps[`webapp_${wa.id}`].name).toBe('Pinned');
    expect(window.WebAppManager.getApp(wa.id).launchCount).toBe(1);

    // unknown id → null, no OS.apps pollution
    expect(window.openWebApp('missing')).toBeNull();
    expect(Object.keys(os.apps).filter((k) => k.startsWith('webapp_'))).toHaveLength(1);
  });

  it('removeWebApp deletes the record, OS entry, pins, open windows and .lnk shortcuts', async () => {
    const shortcut = {
      name: 'Pinned.lnk',
      mimeType: 'application/x-app-shortcut',
      content: JSON.stringify({ type: 'app-shortcut', target: 'webapp_wa1', appId: 'webapp_wa1' }),
    };
    const otherShortcut = {
      name: 'Other.lnk',
      mimeType: 'application/x-app-shortcut',
      content: JSON.stringify({ type: 'app-shortcut', target: 'webapp_other' }),
    };
    const plainFile = { name: 'readme.txt', mimeType: 'text/plain', content: 'hi' };
    const fs = makeFSWithDesktop([shortcut, otherShortcut, plainFile]);
    const os = makeOS();
    const wm = makeWM();

    const { window } = await loadServiceApp('registry', {
      scripts: ['service.js'],
      stubs: { extra: { OS: os, WM: wm, FS: fs } },
    });
    window.WebAppManager.addApp({ name: 'Pinned', url: 'https://p.example.com' });
    const waId = JSON.parse(window.localStorage.getItem('nova_webapps'))[0].id;
    // point the first .lnk, a pinned entry and an open window at the real id
    fs.createdNodes[0].content = JSON.stringify({ type: 'app-shortcut', target: `webapp_${waId}` });
    os.windows.set('win-1', { appId: `webapp_${waId}` });
    os.windows.set('win-2', { appId: 'com.astroos.other' });
    os.settings.set('pinnedApps', ['com.astroos.other', `webapp_${waId}`]);
    // a stale in-memory entry must be dropped too
    os.apps[`webapp_${waId}`] = { name: 'Pinned' };

    await window.removeWebApp(waId);
    await settle();

    expect(window.WebAppManager.getApp(waId)).toBeNull();
    expect(os.apps[`webapp_${waId}`]).toBeUndefined();
    expect(os.settings.get('pinnedApps')).toEqual(['com.astroos.other']);
    // only the window(s) of the removed app were closed
    expect(wm.closed).toEqual(['win-1']);
    expect(wm.taskbarCalls()).toBe(1);
    // only the matching .lnk was deleted
    expect(fs.deleted).toHaveLength(1);
    const remaining = fs.listDir(fs.specialFolders.desktop).map((f) => f.name).sort();
    expect(remaining).toEqual(['Other.lnk', 'readme.txt']);
  });

  it('OS.openUrl opens https links in the browser and rejects unsafe targets', async () => {
    const isLocalAddress = (url) => /127\.0\.0\.1|localhost|192\.168\./.test(String(url));
    const { window, os, wm } = await boot({ isLocalAddress });

    expect(wm.created).toHaveLength(0);
    const win = os.openUrl('https://example.com/page?x=1');
    expect(win.id).toBe('win-1');
    expect(wm.created[0]).toEqual({
      appId: 'com.astroos.browser',
      opts: { url: 'https://example.com/page?x=1' },
    });

    // invalid / non-http / credentialed / local URLs all return null
    expect(os.openUrl('not a url')).toBeNull();
    expect(os.openUrl('')).toBeNull();
    expect(os.openUrl(42)).toBeNull();
    expect(os.openUrl('ftp://files.example.com')).toBeNull();
    expect(os.openUrl('https://user:pass@example.com')).toBeNull();
    expect(os.openUrl('https://127.0.0.1/admin')).toBeNull();
    expect(wm.created).toHaveLength(1);
  });

  it('OS.openMailto parses mailto URIs into compose options for the email app', async () => {
    const { os, wm } = await boot();
    os.openMailto('mailto:ada@example.com?subject=Hello%20There&body=Line%20one&cc=b@x.com');
    expect(wm.created).toEqual([{
      appId: 'com.astroos.email',
      opts: { compose: { to: 'ada@example.com', subject: 'Hello There', body: 'Line one', cc: 'b@x.com', bcc: '' } },
    }]);
    // empty url is ignored
    os.openMailto('');
    expect(wm.created).toHaveLength(1);
  });

  it('intercepts http(s) and mailto link clicks at the document level', async () => {
    const { window, os, wm } = await boot();
    const doc = window.document;

    const link = doc.createElement('a');
    link.href = 'https://clicked.example.com/deep';
    link.textContent = 'site';
    doc.body.appendChild(link);
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(wm.created).toHaveLength(1);
    expect(wm.created[0].appId).toBe('com.astroos.browser');
    expect(wm.created[0].opts).toEqual({ url: 'https://clicked.example.com/deep' });

    const mailLink = doc.createElement('a');
    mailLink.href = 'mailto:x@y.com';
    doc.body.appendChild(mailLink);
    mailLink.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(wm.created).toHaveLength(2);
    expect(wm.created[1].appId).toBe('com.astroos.email');
    expect(wm.created[1].opts.compose.to).toBe('x@y.com');

    // anchor/fragment and dangerous schemes are left alone
    const fragment = doc.createElement('a');
    fragment.href = '#section';
    doc.body.appendChild(fragment);
    fragment.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const js = doc.createElement('a');
    js.href = 'javascript:alert(1)';
    doc.body.appendChild(js);
    js.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(wm.created).toHaveLength(2);
  });
});
