import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';

const systemWebviewSource = readFileSync(
  new URL('../../../js/apps/system-webview/service.js', import.meta.url),
  'utf8'
);

function installSystemWebview(windowObject = {}) {
  vi.stubGlobal('window', windowObject);
  new Function(systemWebviewSource)();
  return windowObject.NovaSystemWebview;
}

describe('AppSandbox (js/platform/security/app-sandbox.js)', () => {
  it('preserves Unicode in host-to-app filesystem responses', () => {
    const guestWindow = {};
    const webview = {
      executeScript: ({ code }, callback) => {
        const delivered = new Function('window', `return ${code}`)(guestWindow);
        callback([delivered]);
      },
    };
    const content = 'A — café — 日本語 😀';

    AppSandbox._internal.respond(webview, 'nova:dialog:open', 'unicode-file-open', {
      success: true,
      file: { name: 'notes.txt', content },
    });

    expect(guestWindow.__novaInbox[0]).toMatchObject({
      type: 'nova:dialog:open:response',
      requestId: 'unicode-file-open',
      result: { file: { content } },
    });
  });

  it('runs a root-enabled Home app in the host instead of forcing it into a sandbox', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.example.root-home',
      name: 'Root Home',
      permissions: ['system:root'],
      unrestrictedEntry: 'root.js',
      files: { 'root.js': Buffer.from('// root Home entry').toString('base64') },
      handles: { roles: ['home'] },
    };
    const container = { innerHTML: '', style: {} };
    const appendedScripts = [];
    vi.stubGlobal('DefaultApps', {
      getAppsForCategory: () => [{ id: app.id }],
    });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'system:root',
    });
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: {
        get: key => key === 'devMode' || key === 'rootAccessEnabled',
      },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launchHome(app, container);

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(appendedScripts).toHaveLength(1);
      expect(appendedScripts[0].dataset.novaUnrestrictedApp).toBe(app.id);
      expect(init).toHaveBeenCalledWith(
        container,
        expect.objectContaining({ homeSurface: true }),
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('runs a trusted system Home app in the host after the unrestricted gate approves it', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.astroos.trusted-home',
      name: 'Trusted Home',
      system: true,
      verified: true,
      signer: 'Astro System',
      source: 'system-bundle',
      integrity: { method: 'sha256', payloadHash: 'verified-integrity' },
      manifest: { id: 'com.astroos.trusted-home', system: true },
      unrestrictedEntry: 'home.js',
      entry: 'index.html',
      files: {
        'home.js': Buffer.from('// trusted Home entry').toString('base64'),
        'index.html': Buffer.from('<!doctype html><body>Home</body>').toString('base64'),
      },
    };
    const container = { innerHTML: '', style: {}, replaceChildren: vi.fn(), appendChild: vi.fn() };
    const appendedScripts = [];
    vi.stubGlobal('DefaultApps', {
      getAppsForCategory: () => [{ id: app.id }],
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('UnrestrictedGate', {
      checkUnrestrictedApp: vi.fn(async () => ({ allowed: true })),
    });
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: { get: () => false },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launchHome(app, container);

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(UnrestrictedGate.checkUnrestrictedApp).toHaveBeenCalledWith(app);
      expect(appendedScripts).toHaveLength(1);
      expect(init).toHaveBeenCalledWith(
        container,
        expect.objectContaining({ homeSurface: true }),
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('runs an approved first-party system package in the host launch path', async () => {
    AppSandbox._internal._resetState();
    const init = vi.fn();
    const app = {
      id: 'com.astroos.trusted-package',
      name: 'Trusted Package',
      system: true,
      verified: true,
      signer: 'Astro System',
      source: 'system-bundle',
      integrity: { method: 'sha256', payloadHash: 'verified-integrity' },
      manifest: { id: 'com.astroos.trusted-package', system: true },
      unrestrictedEntry: 'app.js',
      files: { 'app.js': Buffer.from('// trusted app entry').toString('base64') },
    };
    const container = { innerHTML: '', style: {} };
    const appendedScripts = [];
    vi.stubGlobal('OS', {
      apps: { [app.id]: { init } },
      settings: { get: () => false },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('UnrestrictedGate', {
      checkUnrestrictedApp: vi.fn(async () => ({ allowed: true })),
    });
    vi.stubGlobal('document', {
      createElement: () => ({ dataset: {}, textContent: '', type: '' }),
      querySelectorAll: () => [],
      querySelector: () => null,
      body: { appendChild: script => appendedScripts.push(script) },
    });

    try {
      const result = await AppSandbox.launch(app, container, {}, {});

      expect(result).toMatchObject({
        success: true,
        unrestricted: true,
        hostRendered: true,
        appId: app.id,
      });
      expect(result.webview).toBeNull();
      expect(UnrestrictedGate.checkUnrestrictedApp).toHaveBeenCalledWith(app);
      expect(appendedScripts).toHaveLength(1);
      expect(init).toHaveBeenCalledWith(container, {}, {});
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('exposes additive novaOS API v2 storage with normalized results', async () => {
    const legacyApi = { ipc: vi.fn() };
    const sandboxWindow = { nova: legacyApi };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:storage:get') {
        return Promise.resolve(payload.key === 'theme'
          ? { success: true, value: 'dark' }
          : { success: true, value: null });
      }
      if (type === 'nova:storage:keys') {
        return Promise.resolve({ success: true, keys: ['theme', 'layout'] });
      }
      return Promise.resolve({ success: true });
    });

    const source = AppSandbox._internal.buildNovaOSFacadeSource();
    expect(() => new Function('window', 'ipc', source)).not.toThrow();
    new Function('window', 'ipc', source)(sandboxWindow, fakeIpc);

    const api = sandboxWindow.novaOS;
    expect(sandboxWindow.nova).toBe(legacyApi);
    expect(api.apiVersion).toBe(2);
    expect(api.capabilities.has('storage.v2')).toBe(true);
    expect(api.capabilities.has('networking.v2')).toBe(false);
    expect(api.capabilities.has(undefined)).toBe(false);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.isFrozen(api.storage)).toBe(true);

    expect(await api.storage.get('theme')).toBe('dark');
    expect(await api.storage.get('missing')).toBeNull();
    expect(await api.storage.set('theme', 'light')).toBeUndefined();
    expect(await api.storage.remove('draft')).toBeUndefined();
    expect(await api.storage.clear()).toBeUndefined();
    expect(await api.storage.keys()).toEqual(['theme', 'layout']);

    expect(calls).toEqual([
      { type: 'nova:storage:get', payload: { key: 'theme' } },
      { type: 'nova:storage:get', payload: { key: 'missing' } },
      { type: 'nova:storage:set', payload: { key: 'theme', value: 'light' } },
      { type: 'nova:storage:delete', payload: { key: 'draft' } },
      { type: 'nova:storage:clear', payload: {} },
      { type: 'nova:storage:keys', payload: {} },
    ]);
  });

  it('preserves storage bridge errors through novaOS v2', async () => {
    const hostError = Object.assign(new Error('Storage quota exceeded'), { code: 'STORAGE_FULL' });
    const fakeIpc = vi.fn(() => Promise.reject(hostError));
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);

    await expect(sandboxWindow.novaOS.storage.set('large', 'value')).rejects.toBe(hostError);
    expect(fakeIpc).toHaveBeenCalledWith('nova:storage:set', { key: 'large', value: 'value' });
  });

  it('exposes novaOS v2 settings and ready facades with normalized results', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:settings:get') {
        return Promise.resolve(payload.key === 'theme'
          ? { success: true, value: 'nord' }
          : { success: true });
      }
      if (type === 'nova:ready') {
        return Promise.resolve({
          success: true,
          appId: 'com.example.app',
          permissions: ['system:info'],
          optionalPermissions: [],
          osVersion: '3.0.0',
          securityPatch: '2026-01-01',
          // username absent for non-system apps — normalized to null.
        });
      }
      return Promise.resolve({ success: true });
    });

    const source = AppSandbox._internal.buildNovaOSFacadeSource();
    expect(() => new Function('window', 'ipc', source)).not.toThrow();
    new Function('window', 'ipc', source)(sandboxWindow, fakeIpc);

    const api = sandboxWindow.novaOS;
    expect(api.capabilities.has('settings.v2')).toBe(true);
    expect(api.capabilities.has('ready.v2')).toBe(true);
    expect(api.capabilities.has('settings.v3')).toBe(false);
    expect(Object.isFrozen(api.settings)).toBe(true);
    expect(Object.isFrozen(api.ready)).toBe(true);

    // settings — raw value out, undefined resolution on mutations.
    expect(await api.settings.get('theme')).toBe('nord');
    expect(await api.settings.get('neverSet')).toBeUndefined();
    expect(await api.settings.set('accentColor', '#112233')).toBeUndefined();

    // ready — normalized handshake snapshot; absent username → null.
    const snap = await api.ready.get();
    expect(snap).toEqual({
      appId: 'com.example.app',
      permissions: ['system:info'],
      optionalPermissions: [],
      osVersion: '3.0.0',
      securityPatch: '2026-01-01',
      username: null,
    });

    expect(calls).toEqual([
      { type: 'nova:settings:get', payload: { key: 'theme' } },
      { type: 'nova:settings:get', payload: { key: 'neverSet' } },
      { type: 'nova:settings:set', payload: { key: 'accentColor', value: '#112233' } },
      { type: 'nova:ready', payload: {} },
    ]);
  });

  it('preserves settings and ready bridge errors through novaOS v2', async () => {
    const hostError = Object.assign(new Error('system:info permission required'), { code: 'PERMISSION_DENIED' });
    const fakeIpc = vi.fn(() => Promise.reject(hostError));
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);

    await expect(sandboxWindow.novaOS.settings.get('theme')).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.settings.set('theme', 'nord')).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.ready.get()).rejects.toBe(hostError);
  });

  it('exposes the full-coverage v2 facades with capabilities and frozen namespaces', () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, vi.fn());

    const api = sandboxWindow.novaOS;
    for (const cap of ['events.v2', 'geolocation.v2', 'media.v2', 'calendar.v2', 'contacts.v2', 'mail.v2', 'admin.v2', 'background.v2', 'permissions.v2', 'net.v2']) {
      expect(api.capabilities.has(cap)).toBe(true);
    }
    expect(api.capabilities.has('events.v3')).toBe(false);
    for (const area of ['events', 'geolocation', 'media', 'calendar', 'contacts', 'mail', 'admin', 'background', 'permissions', 'net']) {
      expect(Object.isFrozen(api[area])).toBe(true);
    }
    // Full method surface of the new areas.
    expect(Object.keys(api.events).sort()).toEqual(['on', 'subscribe', 'unsubscribe']);
    expect(Object.keys(api.geolocation).sort()).toEqual(['getCurrentPosition']);
    // Merged media surface: the indexed-media query AND the device
    // authorization checks live on one namespace (an earlier draft shipped
    // them as two media keys, where the later one clobbered query()).
    expect(Object.keys(api.media).sort()).toEqual(['checkCamera', 'checkMicrophone', 'getUserMedia', 'query']);
    expect(Object.keys(api.calendar).sort()).toEqual(['list', 'remove', 'save']);
    expect(Object.keys(api.contacts).sort()).toEqual(['list', 'remove', 'save']);
    expect(Object.keys(api.mail).sort()).toEqual(['account', 'connect', 'disconnect', 'folders', 'markRead', 'message', 'messages', 'move', 'openLink', 'preview', 'remove', 'restore', 'search', 'send']);
    expect(Object.keys(api.admin).sort()).toEqual(['appsList', 'auditQuery', 'systemGet', 'systemSet', 'usersList', 'usersRevoke']);
    expect(Object.keys(api.background).sort()).toEqual(['onWake', 'stayAlive', 'wakeDone']);
    expect(Object.keys(api.permissions).sort()).toEqual(['checkRateLimited', 'request']);
    expect(Object.keys(api.net).sort()).toEqual(['websocket']);
  });

  it('exposes the novaOS v2 events facade with a host-subscription lifecycle', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      return Promise.resolve({ success: true, subscribed: payload.event });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    // First on() subscribes host-side once; further listeners stack silently.
    const cb1 = vi.fn(); const cb2 = vi.fn();
    const off1 = await api.events.on('system:themeChanged', cb1);
    const off2 = await api.events.on('system:themeChanged', cb2);
    expect(calls).toEqual([{ type: 'nova:events:subscribe', payload: { event: 'system:themeChanged' } }]);

    // off() only unsubscribes when the LAST listener for the name goes.
    expect(typeof off1).toBe('function');
    await off1();
    expect(calls.length).toBe(1);
    await off2();
    expect(calls).toEqual([
      { type: 'nova:events:subscribe', payload: { event: 'system:themeChanged' } },
      { type: 'nova:events:unsubscribe', payload: { event: 'system:themeChanged' } },
    ]);

    // A refused subscription rejects AND does not leave the listener registered.
    const refusingIpc = vi.fn((type) => {
      if (type === 'nova:events:subscribe') {
        return Promise.reject(Object.assign(new Error('not allowed'), { code: 'PERMISSION_DENIED' }));
      }
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, refusingIpc);
    await expect(sandboxWindow.novaOS.events.on('mail:new', vi.fn())).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(refusingIpc.mock.calls.length).toBe(1);

    // ALREADY_SUBSCRIBED (raw subscribe() ran first) is tolerated by on().
    const alreadyIpc = vi.fn((type) => {
      if (type === 'nova:events:subscribe') {
        return Promise.reject(Object.assign(new Error('Already subscribed'), { code: 'ALREADY_SUBSCRIBED' }));
      }
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, alreadyIpc);
    const off3 = await sandboxWindow.novaOS.events.on('system:volumeChanged', vi.fn());
    expect(typeof off3).toBe('function');

    // Raw subscribe/unsubscribe stay available for manual control.
    const rawApi = { nova: { ipc: vi.fn() } };
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(rawApi, vi.fn((type, payload) => {
      calls.push({ type, payload });
      return Promise.resolve({ success: true });
    }));
    await rawApi.novaOS.events.subscribe('system:power');
    await rawApi.novaOS.events.unsubscribe('system:power');
    expect(calls.slice(-2)).toEqual([
      { type: 'nova:events:subscribe', payload: { event: 'system:power' } },
      { type: 'nova:events:unsubscribe', payload: { event: 'system:power' } },
    ]);
    await expect(rawApi.novaOS.events.on('system:power', 'not a function')).rejects.toBeInstanceOf(TypeError);
  });

  it('exposes novaOS v2 geolocation and media facades with normalized results', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const coords = { latitude: 52.52, longitude: 13.405, accuracy: 21 };
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:device:geolocation') return Promise.resolve({ success: true, coords, timestamp: 1730000000000 });
      return Promise.resolve({ success: true, authorized: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    // Geolocation — success flag stripped, options pass through.
    const pos = await api.geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 5000 });
    expect(pos).toEqual({ coords, timestamp: 1730000000000 });
    expect(calls[0]).toEqual({ type: 'nova:device:geolocation', payload: { options: { enableHighAccuracy: true, timeout: 5000 } } });
    await api.geolocation.getCurrentPosition();
    expect(calls[1].payload).toEqual({ options: {} });

    // Media — authorization-only checks resolve true; PERMISSION_DENIED and
    // other host errors reject unchanged.
    await expect(api.media.checkCamera()).resolves.toBe(true);
    await expect(api.media.checkMicrophone()).resolves.toBe(true);

    // getUserMedia — requires at least one of video/audio, then runs the
    // app-level checks before touching the browser API (which test/setup.js
    // provides as a controllable stub).
    await expect(api.media.getUserMedia({})).rejects.toBeInstanceOf(TypeError);
    // Two geolocation fixes + one camera check + one microphone check so far;
    // getUserMedia({}) rejected before making any call of its own.
    expect(fakeIpc.mock.calls.filter((c) => c[0].startsWith('nova:device:')).length).toBe(4);

    // Full path with both checks passing: the stubbed browser API receives
    // the constraints and its stream comes back through the facade.
    const stream = { kind: 'MediaStream' };
    navigator.mediaDevices.getUserMedia.mockReturnValueOnce(Promise.resolve(stream));
    await expect(api.media.getUserMedia({ video: true, audio: true })).resolves.toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(fakeIpc.mock.calls.filter((c) => c[0] === 'nova:device:camera').length).toBe(2);
    expect(fakeIpc.mock.calls.filter((c) => c[0] === 'nova:device:microphone').length).toBe(2);

    // An app-level denial rejects before the browser API is ever reached.
    const denied = Object.assign(new Error('device:camera permission required'), { code: 'PERMISSION_DENIED' });
    const deniedIpc = vi.fn((type) => type === 'nova:device:camera' ? Promise.reject(denied) : Promise.resolve({ success: true }));
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, deniedIpc);
    const callsBefore = navigator.mediaDevices.getUserMedia.mock.calls.length;
    await expect(sandboxWindow.novaOS.media.getUserMedia({ video: true })).rejects.toBe(denied);
    expect(navigator.mediaDevices.getUserMedia.mock.calls.length).toBe(callsBefore);
  });

  it('exposes novaOS v2 calendar and contacts facades with normalized records', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const savedEvent = { id: 'evt_1', title: 'Sync', date: '2026-11-05' };
    const savedContact = { id: 'c_1', name: 'Ada', email: '', phone: '', notes: '' };
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:calendar:read') return Promise.resolve({ success: true, events: [savedEvent] });
      if (type === 'nova:calendar:write') return Promise.resolve({ success: true, event: savedEvent });
      if (type === 'nova:calendar:delete') return Promise.resolve({ success: true, removed: true });
      if (type === 'nova:contacts:read') return Promise.resolve({ success: true, contacts: [savedContact] });
      if (type === 'nova:contacts:write') return Promise.resolve({ success: true, contact: savedContact });
      if (type === 'nova:contacts:delete') return Promise.resolve({ success: true, removed: false });
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    expect(await api.calendar.list()).toEqual([savedEvent]);
    expect(await api.calendar.save({ title: 'Sync', date: '2026-11-05' })).toEqual(savedEvent);
    expect(await api.calendar.remove('evt_1')).toBe(true);
    expect(await api.contacts.list()).toEqual([savedContact]);
    expect(await api.contacts.save({ name: 'Ada' })).toEqual(savedContact);
    expect(await api.contacts.remove('c_1')).toBe(false);

    expect(calls).toEqual([
      { type: 'nova:calendar:read', payload: {} },
      { type: 'nova:calendar:write', payload: { event: { title: 'Sync', date: '2026-11-05' } } },
      { type: 'nova:calendar:delete', payload: { id: 'evt_1' } },
      { type: 'nova:contacts:read', payload: {} },
      { type: 'nova:contacts:write', payload: { contact: { name: 'Ada' } } },
      { type: 'nova:contacts:delete', payload: { id: 'c_1' } },
    ]);

    const hostError = Object.assign(new Error('calendar:read permission required'), { code: 'PERMISSION_DENIED' });
    const deniedIpc = vi.fn(() => Promise.reject(hostError));
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, deniedIpc);
    await expect(sandboxWindow.novaOS.calendar.list()).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.contacts.save({ name: 'Ada' })).rejects.toBe(hostError);
  });

  it('exposes novaOS v2 mail and admin facades as raw passthroughs', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    await api.mail.connect({ host: 'imap.example.com', user: 'a@b.c', pass: 'x', type: 'imap' });
    await api.mail.messages({ folder: 'INBOX', limit: 20 });
    await api.mail.message('42', 'INBOX');
    await api.mail.markRead(['42'], 'INBOX');
    await api.mail.move(['42'], 'Archive', 'INBOX');
    await api.mail.send({ to: 'x@y.z', smtpHost: 'smtp.example.com' });
    await api.mail.remove(['42'], 'INBOX');
    await api.mail.openLink('https://example.com');

    await api.admin.auditQuery({ limit: 10 });
    await api.admin.systemGet();
    await api.admin.systemSet({ lockScreen: true });
    await api.admin.usersRevoke('sess_9');

    expect(calls).toEqual([
      { type: 'nova:mail:session', payload: { action: 'connect', account: { host: 'imap.example.com', user: 'a@b.c', pass: 'x', type: 'imap' } } },
      { type: 'nova:mail:read', payload: { action: 'messages', folder: 'INBOX', limit: 20 } },
      { type: 'nova:mail:read', payload: { action: 'message', uid: '42', folder: 'INBOX' } },
      { type: 'nova:mail:write', payload: { action: 'batch', op: 'read', uids: ['42'], folder: 'INBOX' } },
      { type: 'nova:mail:write', payload: { action: 'batch', op: 'move', uids: ['42'], dest: 'Archive', folder: 'INBOX' } },
      { type: 'nova:mail:send', payload: { to: 'x@y.z', smtpHost: 'smtp.example.com' } },
      { type: 'nova:mail:delete', payload: { uids: ['42'], folder: 'INBOX' } },
      { type: 'nova:email:open-link', payload: { url: 'https://example.com' } },
      { type: 'nova:admin:audit', payload: { limit: 10 } },
      { type: 'nova:admin:system', payload: { action: 'get' } },
      { type: 'nova:admin:system', payload: { action: 'set', settings: { lockScreen: true } } },
      { type: 'nova:admin:users', payload: { action: 'revoke', sessionId: 'sess_9' } },
    ]);
  });

  it('exposes novaOS v2 background and permissions facades', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:background:stay-alive') return Promise.resolve({ success: true, enabled: payload.enabled });
      if (type === 'nova:request-permission') return Promise.resolve({ granted: true });
      if (type === 'nova:permission-rate-limited') return Promise.resolve({ rateLimited: true, retryAfterMs: 30000 });
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    // Background — stayAlive defaults to enabling, resolves the enabled state.
    expect(await api.background.stayAlive()).toEqual({ enabled: true });
    expect(await api.background.stayAlive(false)).toEqual({ enabled: false });
    expect(await api.background.wakeDone()).toBeUndefined();
    expect(typeof api.background.onWake(vi.fn())).toBe('function');
    await expect(api.background.onWake('nope')).rejects.toBeInstanceOf(TypeError);

    // Permissions — request resolves the granted boolean; the cooldown peek
    // passes the raw status record through.
    expect(await api.permissions.request('device:geolocation')).toBe(true);
    expect(await api.permissions.request('device:camera', 'Video calls')).toBe(true);
    expect(await api.permissions.checkRateLimited('device:camera')).toEqual({ rateLimited: true, retryAfterMs: 30000 });

    expect(calls).toEqual([
      { type: 'nova:background:stay-alive', payload: { enabled: true } },
      { type: 'nova:background:stay-alive', payload: { enabled: false } },
      { type: 'nova:background:wake-done', payload: {} },
      { type: 'nova:request-permission', payload: { permission: 'device:geolocation', reason: undefined } },
      { type: 'nova:request-permission', payload: { permission: 'device:camera', reason: 'Video calls' } },
      { type: 'nova:permission-rate-limited', payload: { permission: 'device:camera' } },
    ]);

    const hostError = Object.assign(new Error('denied'), { code: 'PERMISSION_DENIED' });
    const deniedIpc = vi.fn(() => Promise.reject(hostError));
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, deniedIpc);
    await expect(sandboxWindow.novaOS.background.stayAlive()).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.permissions.request('device:camera')).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.geolocation.getCurrentPosition()).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.mail.folders()).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.admin.appsList()).rejects.toBe(hostError);
    await expect(sandboxWindow.novaOS.events.subscribe('system:power')).rejects.toBe(hostError);
  });

  it('exposes one merged novaOS media surface (query + device authorization)', async () => {
    // Regression: an earlier draft shipped query() and the device checks as
    // two separate media keys in the facade object — the later one silently
    // clobbered query(). One surface, all four methods live.
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const files = [{ path: 'media:/Pictures/a.jpg', type: 'image' }];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:media:query') return Promise.resolve({ success: true, files });
      return Promise.resolve({ success: true, authorized: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    expect(Object.isFrozen(api.media)).toBe(true);
    await expect(api.media.query({ type: 'image', limit: 100 })).resolves.toEqual({ success: true, files });
    await expect(api.media.checkCamera()).resolves.toBe(true);
    await expect(api.media.checkMicrophone()).resolves.toBe(true);
    await expect(api.media.getUserMedia({})).rejects.toBeInstanceOf(TypeError);

    expect(calls).toEqual([
      { type: 'nova:media:query', payload: { type: 'image', limit: 100 } },
      { type: 'nova:device:camera', payload: {} },
      { type: 'nova:device:microphone', payload: {} },
    ]);
  });

  it('exposes novaOS v2 net.websocket facade with v1-identical semantics', async () => {
    const sandboxWindow = { nova: { ipc: vi.fn() } };
    const calls = [];
    const fakeIpc = vi.fn((type, payload) => {
      calls.push({ type, payload });
      if (type === 'nova:net:websocket') return Promise.resolve({ success: true, wsId: 'ws_1', readyState: 1 });
      return Promise.resolve({ success: true });
    });
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, fakeIpc);
    const api = sandboxWindow.novaOS;

    expect(api.capabilities.has('net.v2')).toBe(true);
    expect(Object.isFrozen(api.net)).toBe(true);

    // Open resolves a handle once the host socket is OPEN; url and optional
    // subprotocols pass through unchanged.
    const handle = await api.net.websocket('wss://example.com/socket', 'chat');
    expect(handle.wsId).toBe('ws_1');
    expect(handle.readyState).toBe(1);
    expect(typeof handle.send).toBe('function');
    expect(typeof handle.close).toBe('function');
    expect(calls[0]).toEqual({ type: 'nova:net:websocket', payload: { url: 'wss://example.com/socket', protocols: 'chat' } });

    // Listener registration requires functions (consistent with events.on).
    expect(() => handle.onMessage(() => {})).not.toThrow();
    expect(() => handle.onError(() => {})).not.toThrow();
    expect(() => handle.onClose(() => {})).not.toThrow();
    expect(() => handle.onMessage('nope')).toThrow(TypeError);

    // send/close carry the wsId + arguments through unchanged.
    await handle.send('hello');
    await handle.close(1000, 'done');
    expect(calls[1]).toEqual({ type: 'nova:net:ws:send', payload: { wsId: 'ws_1', data: 'hello' } });
    expect(calls[2]).toEqual({ type: 'nova:net:ws:close', payload: { wsId: 'ws_1', code: 1000, reason: 'done' } });

    // A host response without a wsId can't be addressed — rejects.
    const noIdIpc = vi.fn(() => Promise.resolve({ success: true }));
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, noIdIpc);
    await expect(sandboxWindow.novaOS.net.websocket('wss://example.com/socket')).rejects.toThrow('resolved without a wsId');

    // Host errors (PERMISSION_DENIED, INVALID_ARGS, ...) reject unchanged.
    const denied = Object.assign(new Error('net:websocket permission required'), { code: 'PERMISSION_DENIED' });
    const deniedIpc = vi.fn(() => Promise.reject(denied));
    new Function('window', 'ipc', AppSandbox._internal.buildNovaOSFacadeSource())(sandboxWindow, deniedIpc);
    await expect(sandboxWindow.novaOS.net.websocket('wss://example.com/socket')).rejects.toBe(denied);
  });

  it('mediates permitted nested webviews through the host sibling bridge', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(true);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('nova-nested-webview');
    expect(shim).toContain("action: 'create'");
    expect(shim).toContain("action: 'bounds'");
    expect(shim).toContain("customElements.define('nova-nested-webview'");
    expect(shim).toContain('nova-nested-webview{display:block;width:100%;height:100%;}');
    expect(shim).toContain('nova-nested-webview[hidden]{display:none!important;}');
    expect(shim).toContain("attributeFilter: ['class', 'style', 'hidden']");
    expect(shim).toContain('visible: !proxy.hidden && style.display !== \'none\'');
    expect(shim).toContain('window.nova.browser = Object.freeze({');
    expect(shim).toContain('window.novaOS = Object.freeze({');
    expect(shim).toContain("'storage.v2': true");
    expect(shim).toContain("ipc('nova:storage:delete', { key: key })");

    expect(shim).toContain("ipc('nova:home:openDefaultAppsSettings', {})");
    expect(shim).toContain("ipc('nova:home:apps:list', {})");
    expect(shim).toContain("ipc('nova:home:apps:launch', { appId: appId })");
    expect(shim).toContain('files: {');
    expect(shim).toContain('openWith: function(fileId)');
    expect(shim).toContain('appearance: {');
    expect(shim).toContain('set: function(appearance)');
    expect(shim).toContain('contextMenu: {');
    expect(shim).toContain("ipc('nova:context-menu:show'");
    expect(shim).toContain('overlay: {');
    expect(shim).toContain("ipc('nova:overlay:show'");
    expect(shim).toContain('launch: function(appId, options)');
    expect(shim).toContain('onStateChange: function(callback)');
    expect(shim).toContain('share: function(data)');
    expect(shim).toContain("this._emit('navigation-commit'");
    expect(shim).toContain("this._emit('url-change'");
    expect(shim).toContain('let __NOVA_PENDING_INITIAL_URL__ = null;');
    expect(shim).not.toContain('NESTED_WEBVIEW_NAV_DELAY_MS');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:files:open']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:open-with']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:share']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:appearance:get']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:appearance:set']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:openDefaultAppsSettings']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:apps:list']).toBeTypeOf('function');
    expect(AppSandbox._internal.API_HANDLERS['nova:home:apps:launch']).toBeTypeOf('function');
  });

  it('lets only the active sandboxed Home app open Home defaults in Settings', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'settings-window' }));
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:home:openDefaultAppsSettings',
        {},
        'active-home',
        { id: 'com.test.home' },
        webview,
        { homeSurface: true }
      );
      await AppSandbox._internal.handleAPICall(
        'nova:home:openDefaultAppsSettings',
        {},
        'not-home',
        { id: 'com.test.other' },
        webview,
        { homeSurface: false }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledWith('com.astroos.settings', {
      section: 'default-apps',
      highlightCategory: 'home',
      requestingAppId: 'com.test.home',
    });
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
  });

  it('limits Home app listing to Settings and App Manager without system:apps', async () => {
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { confirm: vi.fn(() => true) });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.astroos.settings', name: 'Settings', icon: 'settings' },
      { id: 'com.astroos.appmanager', name: 'App Manager', icon: 'apps' },
      { id: 'com.test.other', name: 'Other App', icon: 'box' },
    ]);
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });
    // The handler reads OS.settings.get('devMode') for the devOnly filter.
    vi.stubGlobal('OS', { settings: { get: () => false } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:home:apps:list',
        {},
        'home-app-list',
        { id: 'com.test.home' },
        { __directResponder: message => responses.push(message) },
        { homeSurface: true }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.fullAccess).toBe(false);
    expect(responses[0].result.apps.map(entry => entry.id)).toEqual([
      'com.astroos.settings',
      'com.astroos.appmanager',
    ]);
  });

  it('always lets the active Home app launch Settings and App Manager, but gates other apps', async () => {
    const responses = [];
    const createWindow = vi.fn(appId => ({ id: `${appId}-window` }));
    let hasLaunchPermission = false;
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'system:app-launch' && hasLaunchPermission });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.astroos.settings', name: 'Settings' },
      { id: 'com.astroos.appmanager', name: 'App Manager' },
      { id: 'com.test.other', name: 'Other App' },
    ]);
    vi.stubGlobal('DefaultApps', { getDefault: () => 'com.test.home' });
    vi.stubGlobal('OS', {
      settings: { get: () => false },
      apps: {
        'com.astroos.settings': {},
        'com.astroos.appmanager': {},
        'com.test.other': {},
      },
    });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const call = (appId, sandbox = { homeSurface: true }) => AppSandbox._internal.handleAPICall(
        'nova:home:apps:launch',
        { appId },
        `launch-${appId}`,
        { id: 'com.test.home' },
        webview,
        sandbox
      );
      await call('com.astroos.settings');
      await call('com.astroos.appmanager');
      await call('com.test.other');
      hasLaunchPermission = true;
      await call('com.test.other');
      await call('com.astroos.settings', { homeSurface: false });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow.mock.calls.map(([appId]) => appId)).toEqual([
      'com.astroos.settings',
      'com.astroos.appmanager',
      'com.test.other',
    ]);
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].result.success).toBe(true);
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
    expect(responses[3].result.success).toBe(true);
    expect(responses[4].error.code).toBe('PERMISSION_DENIED');
  });

  it('returns renderable app icon URLs when listing installed apps', async () => {
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('APP_REGISTRY', [
      { id: 'com.test.svg', name: 'SVG App', icon: 'settings' },
      { id: 'com.test.asset', name: 'Asset App', icon: 'mail' },
      { id: 'com.test.image', name: 'Image App', icon: 'data:image/png;base64,aGVsbG8=' },
      { id: 'com.test.bad', name: 'Bad App', icon: '/assets/../private.png' },
    ]);
    vi.stubGlobal('svgIcon', icon => icon === 'settings'
      ? '<svg viewBox="0 0 24 24"><path d="M1 1"></path></svg>'
      : '<img src="/assets/icons8-mail-94.png">');

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:app:list',
        {},
        'list-apps',
        { id: 'com.test.launcher' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const listed = responses[0].result.apps;
    expect(listed[0].icon).toBe('settings');
    expect(listed[0].iconUrl).toContain('data:image/svg+xml;charset=utf-8,');
    expect(decodeURIComponent(listed[0].iconUrl.split(',')[1])).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(listed[1].iconUrl).toBe('/assets/icons8-mail-94.png');
    expect(listed[2].iconUrl).toBe('data:image/png;base64,aGVsbG8=');
    expect(listed[3].iconUrl).toBeNull();
  });

  it('does not expose host-mediated webview creation when permission is absent', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(false);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(shim).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = false;');
    expect(() => new Function(script)).not.toThrow();
    expect(AppSandbox._internal.API_HANDLERS['nova:nested-webview']).toBeTypeOf('function');
  });

  it('limits a user-opened file grant to the exact file id', async () => {
    const responses = [];
    const selected = { id: 'selected-file', name: 'note.txt', type: 'file', content: 'hello', mimeType: 'text/plain' };
    const other = { id: 'other-file', name: 'secret.txt', type: 'file', content: 'secret', mimeType: 'text/plain' };
    const files = new Map([[selected.id, selected], [other.id, other]]);
    const writeFile = vi.fn(async (id, content) => {
      const node = files.get(id);
      if (!node) return null;
      node.content = content;
      return node;
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', { files, getPath: id => `/${id}`, writeFile });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { openFile: { id: selected.id, node: selected } };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read', { id: selected.id }, 'selected-read',
        { id: 'com.example.editor' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write', { id: selected.id, content: 'updated' }, 'selected-write',
        { id: 'com.example.editor' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read', { id: other.id }, 'other-read',
        { id: 'com.example.editor' }, webview, sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('hello');
    expect(responses[1].result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(selected.id, 'updated');
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
  });

  it('strips file intents from app-requested cross-app launches', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'new-window' }));
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('OS', {
      settings: { get: () => false },
      apps: { 'com.example.viewer': {} },
    });
    vi.stubGlobal('WM', { createWindow });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:app:launch',
        { appId: 'com.example.viewer', options: { fileId: 'selected-file', folderId: 'private-folder', fileIntent: { action: 'open', file: { id: 'selected-file' } } } },
        'app-launch',
        { id: 'com.example.launcher' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledWith('com.example.viewer', {});
    expect(responses[0].result.success).toBe(true);
  });

  it('brokers declared service and content-provider calls between active, authorized apps', async () => {
    const callerResponses = [];
    const targetResponses = [];
    const endpoint = 'provider:com.example.contacts.lookup';
    const targetSandboxId = 'ipc-target-sandbox';
    const targetWebview = {
      dataset: { sandboxId: targetSandboxId },
      __directResponder: message => targetResponses.push(message),
    };
    const targetSandbox = {
      appId: 'com.example.contacts',
      webview: targetWebview,
      appIpcEndpoints: new Set([endpoint]),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission, appId) =>
        permission === 'apps:communicate'
        && ['com.example.client', 'com.example.contacts'].includes(appId),
    });
    vi.stubGlobal('OS', {
      apps: {
        'com.example.contacts': {
          manifest: { ipc: { exports: [endpoint] } },
        },
      },
    });
    AppSandbox._internal._activeSandboxes.set(targetSandboxId, targetSandbox);

    try {
      const invoke = AppSandbox._internal.handleAPICall(
        'nova:ipc:invoke',
        {
          targetAppId: 'com.example.contacts',
          endpoint,
          data: { query: 'Ada' },
        },
        'provider-call',
        { id: 'com.example.client' },
        {
          dataset: { sandboxId: 'ipc-caller-sandbox' },
          __directResponder: message => callerResponses.push(message),
        },
        {}
      );

      expect(targetResponses[0]).toMatchObject({
        type: 'nova:ipc:request:response',
        result: {
          endpoint,
          sourceAppId: 'com.example.client',
          data: { query: 'Ada' },
        },
      });

      await AppSandbox._internal.handleAPICall(
        'nova:ipc:reply',
        { callId: targetResponses[0].requestId, result: { id: 'contact-1' } },
        'provider-reply',
        { id: 'com.example.contacts' },
        targetWebview,
        targetSandbox
      );
      await invoke;
    } finally {
      AppSandbox._internal._activeSandboxes.delete(targetSandboxId);
      vi.unstubAllGlobals();
    }

    expect(callerResponses[0].result).toEqual({ id: 'contact-1' });
  });

  it('requires exported endpoints and receiver actions to be declared before registration', async () => {
    const responses = [];
    const sandboxId = 'ipc-manifest-sandbox';
    const sandbox = {
      appId: 'com.example.provider',
      webview: { dataset: { sandboxId } },
      appIpcEndpoints: new Set(),
      ipcBroadcastActions: new Set(),
    };
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('OS', {
      apps: {
        'com.example.provider': {
          manifest: {
            ipc: {
              exports: ['service:com.example.provider.status'],
              receives: ['com.example.provider.refresh'],
            },
          },
        },
      },
    });
    AppSandbox._internal._activeSandboxes.set(sandboxId, sandbox);

    try {
      const webview = {
        dataset: { sandboxId },
        __directResponder: message => responses.push(message),
      };
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:register',
        { endpoint: 'service:com.example.provider.status' },
        'register-declared-endpoint',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:register',
        { endpoint: 'service:com.example.provider.admin' },
        'register-undeclared-endpoint',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast:subscribe',
        { action: 'com.example.provider.refresh' },
        'subscribe-declared-action',
        { id: sandbox.appId },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast:subscribe',
        { action: 'com.example.provider.delete-all' },
        'subscribe-undeclared-action',
        { id: sandbox.appId },
        webview,
        sandbox
      );
    } finally {
      AppSandbox._internal._activeSandboxes.delete(sandboxId);
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
    expect(responses[2].result.success).toBe(true);
    expect(responses[3].error.code).toBe('PERMISSION_DENIED');
  });

  it('delivers app broadcasts only to declared, subscribed, authorized sandboxes', async () => {
    const senderResponses = [];
    const recipientResponses = [];
    const action = 'com.example.notes.changed';
    const recipientSandboxId = 'broadcast-recipient-sandbox';
    const recipientSandbox = {
      appId: 'com.example.notes',
      webview: {
        dataset: { sandboxId: recipientSandboxId },
        __directResponder: message => recipientResponses.push(message),
      },
      ipcBroadcastActions: new Set([action]),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission, appId) =>
        permission === 'apps:communicate'
        && ['com.example.editor', 'com.example.notes'].includes(appId),
    });
    AppSandbox._internal._activeSandboxes.set(recipientSandboxId, recipientSandbox);

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:ipc:broadcast',
        { action, data: { noteId: 'note-1' } },
        'broadcast',
        { id: 'com.example.editor' },
        { __directResponder: message => senderResponses.push(message) },
        {}
      );
    } finally {
      AppSandbox._internal._activeSandboxes.delete(recipientSandboxId);
      vi.unstubAllGlobals();
    }

    expect(recipientResponses[0]).toMatchObject({
      type: 'nova:ipc:broadcast:response',
      result: {
        action,
        sourceAppId: 'com.example.editor',
        data: { noteId: 'note-1' },
      },
    });
    expect(senderResponses[0].result.delivered).toBe(1);
  });

  it('opens the host Open with chooser only for files in the calling app scope', async () => {
    const responses = [];
    const selected = { id: 'selected', name: 'note.txt', type: 'file', mimeType: 'text/plain' };
    const privateFile = { id: 'private', name: 'secret.txt', type: 'file', mimeType: 'text/plain' };
    const paths = new Map([
      ['selected', '/Documents/note.txt'],
      ['private', '/data/other.app/secret.txt'],
      ['trash', '/Trash'],
    ]);
    const files = new Map([[selected.id, selected], [privateFile.id, privateFile]]);
    const choose = vi.fn(async () => ({ cancelled: false, success: true, appId: 'com.example.editor', windowId: 'opened-window' }));
    vi.stubGlobal('FS', {
      files,
      specialFolders: { trash: 'trash' },
      getPath: id => paths.get(id) || '/',
    });
    vi.stubGlobal('window', { showOpenWithDialog: choose });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: selected.id }, 'open-shared',
        { id: 'com.example.filemanager' }, webview, {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: privateFile.id }, 'open-private',
        { id: 'com.example.filemanager' }, webview, {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(selected);
    expect(responses[0].result).toMatchObject({ success: true, appId: 'com.example.editor' });
    expect(responses[1].error.code).toBe('NOT_FOUND');
  });

  it('allows openWith for the file already granted to this sandbox', async () => {
    const responses = [];
    const selected = { id: 'selected', name: 'note.txt', type: 'file', mimeType: 'text/plain' };
    const privateFile = { id: 'private', name: 'secret.txt', type: 'file', mimeType: 'text/plain' };
    const choose = vi.fn(async node => ({ cancelled: false, success: true, appId: 'com.example.viewer', receivedId: node.id }));
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([[selected.id, selected], [privateFile.id, privateFile]]),
      specialFolders: { trash: 'trash' },
      getPath: id => id === 'root' ? '/' : id === selected.id ? '/data/another.app/note.txt' : '/data/other.app/secret.txt',
    });
    vi.stubGlobal('window', { showOpenWithDialog: choose });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { openFile: { id: selected.id, node: selected } };
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: selected.id }, 'open-granted',
        { id: 'com.example.viewer' }, webview, sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:open-with', { fileId: privateFile.id }, 'open-ungranted',
        { id: 'com.example.viewer' }, webview, sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(selected);
    expect(responses[0].result).toMatchObject({ success: true, receivedId: selected.id });
    expect(responses[1].error.code).toBe('NOT_FOUND');
  });

  it('rejects host-side nested webview requests without the permission grant', async () => {
    const responses = [];
    const webview = { __directResponder: message => responses.push(message) };

    await AppSandbox._internal.handleAPICall(
      'nova:nested-webview',
      { action: 'create', id: 'nvw_test' },
      'request-test',
      { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
      webview,
      { nestedWebviewOptedIn: false }
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('exposes opted-in browser APIs before consent but enforces the grant on the host', async () => {
    const responses = [];
    const app = {
      id: 'com.novabrowser.app',
      manifest: { permissions: ['net:external', 'sandbox:nested-webview'] },
    };
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => false) });

    try {
      const html = AppSandbox._internal.injectCapabilityShim('<!doctype html><html></html>', app);
      expect(html).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = true;');
      expect(AppSandbox._internal.isNestedWebviewPermitted(app)).toBe(false);

      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_consent' },
        'nested-webview-before-consent',
        app,
        { __directResponder: message => responses.push(message) },
        { nestedWebviewOptedIn: true, nestedWebviews: new Map() }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('removes live nested views when their permission is revoked', () => {
    const revokeApp = vi.fn();
    const sandboxId = 'permission-revoke-test';
    vi.stubGlobal('window', { NovaSystemWebview: { revokeApp } });
    AppSandbox._internal._activeSandboxes.set(sandboxId, {
      appId: 'com.novabrowser.app',
    });

    try {
      expect(AppSandbox.handlePermissionRevoked('sandbox:nested-webview', 'com.novabrowser.app')).toBe(true);
    } finally {
      AppSandbox._internal._activeSandboxes.delete(sandboxId);
      vi.unstubAllGlobals();
    }

    expect(revokeApp).toHaveBeenCalledOnce();
    expect(revokeApp).toHaveBeenCalledWith('com.novabrowser.app');
  });

  it('gives nested sites a separate stable partition without inheriting the app sandbox', async () => {
    const responses = [];
    const attributes = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn((name, value) => attributes.set(name, value)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const parent = {
      isConnected: true,
      style: {},
      appendChild: vi.fn(),
    };
    installSystemWebview();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_persistent' },
        'nested-webview-create',
        { id: 'com.example.browser' },
        {
          getAttribute: vi.fn(() => 'allow-scripts allow-forms'),
          __directResponder: message => responses.push(message),
        },
        { nestedWebviewOptedIn: true, state: { content: parent } }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(attributes.get('partition')).toBe('persist:app_com.example.browser_webcontent');
    expect(attributes.has('sandbox')).toBe(false);
    expect(parent.appendChild).toHaveBeenCalledWith(child);
    expect(responses[0].result).toEqual({ success: true });
  });

  it('passes an authorized open-url launch target to the browser webview proxy', () => {
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview' || permission === 'net:external'),
    });

    try {
      const html = AppSandbox._internal.injectCapabilityShim(
        '<!doctype html><html><body></body></html>',
        {
          id: 'com.example.browser',
          allowNestedWebview: true,
          permissions: ['sandbox:nested-webview', 'net:external'],
        },
        { url: 'https://www.google.com/search?q=nova' }
      );
      expect(html).toContain('let __NOVA_PENDING_INITIAL_URL__ = "https://www.google.com/search?q=nova";');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('defers packaged app scripts until parsing completes without requiring DOMContentLoaded guards', () => {
    const html = AppSandbox._internal.injectCapabilityShim(
      '<!doctype html><!-- <script src="comment.js"></script> --><html><head><script src="app.js"></script><script src="async.js" async></script><script type="module" src="module.js"></script><script>inline()</script></head><body><button id="pad"></button></body></html>',
      { id: 'com.example.app', permissions: [] }
    );

    expect(html).toContain('<script src="app.js" defer>');
    expect(html).toContain('<script src="async.js" defer>');
    expect(html).toContain('<script type="module" src="module.js" defer>');
    expect(html).toContain('<!-- <script src="comment.js"></script> -->');
    expect(html).toContain('<script>inline()</script>');
    expect(html).toContain('<button id="pad"></button>');
  });

  it('blocks direct nested-webview navigation unless the app has matching network permission', async () => {
    const responses = [];
    const child = { style: {}, setAttribute: vi.fn(), removeAttribute: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const parent = { isConnected: true, style: {}, appendChild: vi.fn() };
    let callsBeforeNavigation = 0;
    installSystemWebview({ location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview'),
    });

    try {
      const sandbox = { nestedWebviewOptedIn: true, state: { content: parent } };
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_network' },
        'nested-network-create',
        { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
        webview,
        sandbox
      );
      callsBeforeNavigation = child.setAttribute.mock.calls.length;
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'attribute', id: 'nvw_network', name: 'src', value: 'https://www.google.com/' },
        'nested-network-denied',
        { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
        webview,
        sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(child.setAttribute).toHaveBeenCalledTimes(callsBeforeNavigation);
    expect(responses.at(-1).error.code).toBe('PERMISSION_DENIED');
  });

  it('exposes host-validated history and page-find operations for nested browsers', async () => {
    const responses = [];
    const child = {
      style: {},
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => false),
      find: vi.fn((_query, _options, callback) => callback({ activeMatchOrdinal: 1, numberOfMatches: 3 })),
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const webview = { __directResponder: message => responses.push(message) };
    const sandbox = {
      nestedWebviewOptedIn: true,
      state: { content: { isConnected: true, style: {}, appendChild: vi.fn() } },
    };
    installSystemWebview();
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_api' },
        'browser-create',
        { id: 'com.example.browser' },
        webview,
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'command', id: 'nvw_api', command: 'canGoBack' },
        'browser-can-go-back',
        { id: 'com.example.browser' },
        webview,
        sandbox
      );
      expect(responses.at(-1).result).toEqual({ value: true });

      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        {
          action: 'command', id: 'nvw_api', command: 'find',
          query: 'Nova', options: { matchCase: false, backward: true },
        },
        'browser-find',
        { id: 'com.example.browser' },
        webview,
        sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(child.find).toHaveBeenCalledWith('Nova', { matchCase: false, backward: true }, expect.any(Function));
    expect(responses.at(-1).result).toEqual({ activeMatchOrdinal: 1, numberOfMatches: 3 });
  });

  it('opens a user-picked file without a filesystem permission and grants scoped access', async () => {
    const responses = [];
    const pickedNode = {
      id: 'picked-file',
      name: 'notes.txt',
      type: 'file',
      content: 'selected text',
      mimeType: 'text/plain',
    };
    const privateNode = { id: 'private-file', name: 'private.txt', type: 'file' };
    const paths = new Map([
      ['picked-file', '/Documents/notes.txt'],
      ['private-file', '/data/another.app/private.txt'],
    ]);
    const open = vi.fn(async options => {
      expect(options.pathOnly).toBe(true);
      expect(options.accept).toBe('text/plain');
      return pickedNode;
    });
    vi.stubGlobal('window', {
      SystemDialogs: {
        open,
      },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([
        ['picked-file', { ...pickedNode, size: 'selected text'.length }],
        ['private-file', privateNode],
      ]),
      getPath: vi.fn(id => paths.get(id)),
    });

    const sandbox = {};
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:files:open',
        { accept: ['text/plain'] },
        'scoped-file-open',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        sandbox
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'picked-file' },
        'picked-file-read',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        sandbox
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.file).toMatchObject({
      name: 'notes.txt',
      path: '/Documents/notes.txt',
      content: 'selected text',
      size: 'selected text'.length,
      id: 'picked-file',
    });
    expect(responses[1].result.data).toBe('selected text');
    expect(open).toHaveBeenCalledOnce();
  });

  it('lets sandboxed apps open a user-selected host file outside the virtual filesystem', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astroos-picked-file-'));
    const filePath = path.join(directory, 'notes.md');
    writeFileSync(filePath, '# selected from host');
    const responses = [];
    const open = vi.fn(async options => {
      expect(options.pathOnly).toBe(true);
      return {
        path: filePath,
        name: 'notes.md',
        mimeType: 'text/markdown',
        size: 20,
      };
    });
    vi.stubGlobal('window', { SystemDialogs: { open } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:open',
        { startPath: directory },
        'host-file-open',
        { id: 'com.example.preview' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      startPath: directory,
      pathOnly: true,
    }));
    expect(responses[0].result).toMatchObject({
      success: true,
      file: {
        name: 'notes.md',
        content: '# selected from host',
        mimeType: 'text/markdown',
        path: filePath,
      },
    });
  });

  it('lets the scoped file API open the same user-selected host paths', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astroos-scoped-open-'));
    const filePath = path.join(directory, 'notes.txt');
    writeFileSync(filePath, 'selected text');
    const responses = [];
    const open = vi.fn(async options => {
      expect(options.accept).toBe('text/plain');
      return {
        path: filePath,
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 13,
      };
    });
    vi.stubGlobal('window', { SystemDialogs: { open } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:files:open',
        { accept: ['text/plain'], startPath: directory },
        'scoped-host-file-open',
        { id: 'com.example.editor' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(responses[0].result).toMatchObject({
      cancelled: false,
      file: { name: 'notes.txt', content: 'selected text', path: filePath },
    });
  });

  it('writes sandboxed sysdialog saves only to the host path selected by the user', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astroos-save-file-'));
    const filePath = path.join(directory, 'export.txt');
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', {
      SystemDialogs: {
        save: vi.fn(async options => {
          expect(options.startPath).toBe(directory);
          return { path: filePath, name: 'export.txt' };
        }),
      },
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { startPath: directory, suggestedName: 'export.txt', content: 'saved by user choice' },
        'host-file-save',
        { id: 'com.example.editor', name: 'Editor' },
        { __directResponder: message => responses.push(message) },
        {}
      );

      expect(readFileSync(filePath, 'utf8')).toBe('saved by user choice');
      expect(responses[0].result.file).toMatchObject({
        path: filePath,
        name: 'export.txt',
      });
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('saves content only to the destination chosen in the filesystem picker', async () => {
    const responses = [];
    const writeFile = vi.fn(async () => ({
      id: 'existing-file',
      name: 'notes.txt',
      mimeType: 'text/plain',
    }));
    vi.stubGlobal('window', {
      confirm: vi.fn(() => true),
      SystemDialogs: {
        save: vi.fn(async () => ({ folderId: 'documents', name: 'notes.txt' })),
      },
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      files: new Map([
        ['documents', { id: 'documents', type: 'folder' }],
        ['existing-file', { id: 'existing-file', type: 'file', name: 'notes.txt' }],
      ]),
      listDir: vi.fn(() => [{ id: 'existing-file', name: 'notes.txt', type: 'file' }]),
      writeFile,
      createFile: vi.fn(),
      getPath: vi.fn(id => id === 'documents' ? '/Documents' : '/Documents/notes.txt'),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:files:save',
        { filename: 'suggested.txt', content: 'exported text' },
        'scoped-file-save',
        { id: 'com.example.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('existing-file', 'exported text', 'text/plain');
    expect(responses[0].result.file).toMatchObject({
      name: 'notes.txt',
      path: '/Documents/notes.txt',
      size: 'exported text'.length,
    });
  });

  it('allows permission-free access to app-owned files', async () => {
    const responses = [];
    const ownFile = { id: 'own-note', name: 'note.txt', type: 'file', content: 'before' };
    const pathMap = new Map([
      ['root', '/home/user'],
      ['own-note', '/home/user/data/editor_app/note.txt'],
    ]);
    const writeFile = vi.fn(async (id, content) => {
      ownFile.content = content;
      return ownFile;
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['own-note', ownFile]]),
      getPath: id => pathMap.get(id),
      getByPath: path => path === '/data/editor_app/note.txt' ? ownFile : null,
      writeFile,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'own-note' },
        'own-file-read',
        { id: 'editor_app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/data/note.txt', content: 'after' },
        'own-file-write',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('before');
    expect(responses[1].result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('own-note', 'after');
  });

  it('JSON-stringifies object content written to an existing app data file (no "[object Object]")', async () => {
    const responses = [];
    const ownFile = { id: 'own-state', name: 'state.json', type: 'file', content: '{"count":1}' };
    const writeFile = vi.fn(async (id, content) => {
      ownFile.content = content;
      return ownFile;
    });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['own-state', ownFile]]),
      getPath: id => id === 'root' ? '/home/user' : '/home/user/data/editor_app/state.json',
      getByPath: path => path === '/data/editor_app/state.json' ? ownFile : null,
      writeFile,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/data/state.json', content: { count: 2 } },
        'own-file-write-object',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('own-state', '{"count":2}');
    expect(typeof ownFile.content).toBe('string');
    expect(ownFile.content).toBe('{"count":2}');
  });

  it('rejects non-serializable write content with INVALID_ARGS instead of corrupting the file', async () => {
    const responses = [];
    const ownFile = { id: 'own-state', name: 'state.json', type: 'file', content: '{"count":1}' };
    const writeFile = vi.fn(async () => ownFile);
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['own-state', ownFile]]),
      getPath: id => id === 'root' ? '/home/user' : '/home/user/data/editor_app/state.json',
      getByPath: path => path === '/data/editor_app/state.json' ? ownFile : null,
      writeFile,
    });

    try {
      const cyclic = {};
      cyclic.self = cyclic;
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/data/state.json', content: cyclic },
        'own-file-write-cyclic',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].error.code).toBe('INVALID_ARGS');
    expect(responses[0].error.message).toContain('JSON-serializable');
    expect(writeFile).not.toHaveBeenCalled();
    expect(ownFile.content).toBe('{"count":1}');
  });

  it('reads object content stored by pre-fix builds back as JSON text (no "[object Object]")', async () => {
    const responses = [];
    // Content that reaches the VFS as a live object — a file written by a
    // build before the write-side serialization fix, or by any non-IPC
    // writer. nova:fs:read must hand the app text it can display, mirroring
    // what the write path would have stored for the same value.
    const legacyFile = { id: 'legacy-json', name: 'old.json', type: 'file', content: { legacy: true, items: [1, 2] } };
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['legacy-json', legacyFile]]),
      getPath: id => id === 'root' ? '/home/user' : '/home/user/data/editor_app/old.json',
      getByPath: path => path === '/data/editor_app/old.json' ? legacyFile : null,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { path: '/data/old.json' },
        'legacy-read',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.success).toBe(true);
    expect(typeof responses[0].result.data).toBe('string');
    expect(responses[0].result.data).toBe('{"legacy":true,"items":[1,2]}');
  });

  it('reads string file content through unchanged', async () => {
    const responses = [];
    const ownFile = { id: 'own-text', name: 'note.txt', type: 'file', content: 'plain text' };
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['own-text', ownFile]]),
      getPath: id => id === 'root' ? '/home/user' : '/home/user/data/editor_app/note.txt',
      getByPath: path => path === '/data/editor_app/note.txt' ? ownFile : null,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { path: '/data/note.txt' },
        'text-read',
        { id: 'editor_app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('plain text');
  });

  it('serializes object content passed to nova:sysdialog:save instead of silently saving an empty file', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'astroos-save-object-'));
    const filePath = path.join(directory, 'export.json');
    const responses = [];
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', {
      SystemDialogs: {
        save: vi.fn(async () => ({ path: filePath, name: 'export.json' })),
      },
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { startPath: directory, suggestedName: 'export.json', content: { exported: true } },
        'host-file-save-object',
        { id: 'com.example.editor', name: 'Editor' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(responses[0].result).toMatchObject({
      success: true,
      file: { name: 'export.json', size: '{"exported":true}'.length },
    });
  });

  it('limits shared-media reads to the matching media permission', async () => {
    const responses = [];
    const image = { id: 'image', name: 'photo.png', type: 'file', content: 'image', mimeType: 'image/png' };
    const audio = { id: 'audio', name: 'song.mp3', type: 'file', content: 'audio', mimeType: 'audio/mpeg' };
    const document = { id: 'document', name: 'report.pdf', type: 'file', content: 'document', mimeType: 'application/pdf' };
    const pathMap = new Map([
      ['root', '/'],
      ['image', '/Pictures/photo.png'],
      ['audio', '/Music/song.mp3'],
      ['document', '/Documents/report.pdf'],
    ]);
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'fs:read:images',
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([['image', image], ['audio', audio], ['document', document]]),
      getPath: id => pathMap.get(id),
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      for (const id of ['image', 'audio', 'document']) {
        await AppSandbox._internal.handleAPICall(
          'nova:fs:read',
          { id },
          `read-${id}`,
          { id: 'media_app' },
          webview,
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.data).toBe('image');
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
    expect(responses[2].error.code).toBe('PERMISSION_DENIED');
  });

  it('requires user confirmation before deleting a picker-selected shared file', async () => {
    const responses = [];
    const selected = { id: 'shared-note', name: 'note.txt', type: 'file' };
    const deleteToTrash = vi.fn();
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { confirm });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: { trash: 'trash' },
      files: new Map([['shared-note', selected]]),
      getPath: id => id === 'root' ? '/' : '/Documents/note.txt',
      deleteToTrash,
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      const sandbox = { pickedFileIds: new Set(['shared-note']) };
      for (let i = 0; i < 2; i++) {
        await AppSandbox._internal.handleAPICall(
          'nova:fs:delete',
          { id: 'shared-note' },
          `delete-shared-${i}`,
          { id: 'reader_app', name: 'Reader' },
          webview,
          sandbox
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(responses[0].result.cancelled).toBe(true);
    expect(responses[1].result.success).toBe(true);
    expect(deleteToTrash).toHaveBeenCalledOnce();
  });

  it('lets fs:access edit shared files but not another app private data', async () => {
    const responses = [];
    const sharedFile = { id: 'shared-note', name: 'note.txt', type: 'file', content: 'before' };
    const privateFile = { id: 'private-note', name: 'private.txt', type: 'file', content: 'private' };
    const trashedPrivateFile = {
      id: 'trashed-private-note', name: 'private.txt', type: 'file', content: 'private',
      parentId: 'trash', _originalParent: 'other-app-data',
    };
    const trashedOwnFile = {
      id: 'trashed-own-note', name: 'own.txt', type: 'file', content: 'own data',
      parentId: 'trash', _originalParent: 'own-app-data',
    };
    const legacyTrashedFile = {
      id: 'legacy-trashed-note', name: 'legacy.txt', type: 'file', content: 'unknown owner',
      parentId: 'trash',
    };
    const paths = new Map([
      ['shared-note', '/Documents/note.txt'],
      ['private-note', '/data/another.app/private.txt'],
      ['trashed-private-note', '/Trash/private.txt'],
      ['trashed-own-note', '/Trash/own.txt'],
      ['legacy-trashed-note', '/Trash/legacy.txt'],
      ['trash', '/Trash'],
      ['other-app-data', '/data/another.app'],
      ['own-app-data', '/data/editor.app'],
    ]);
    const files = new Map([[sharedFile.id, sharedFile], [privateFile.id, privateFile]]);
    const writeFile = vi.fn(async (_id, content) => { sharedFile.content = content; });
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'fs:access' });
    vi.stubGlobal('FS', {
      files,
      specialFolders: { trash: 'trash' },
      getByPath: vi.fn(path => path === '/Documents/note.txt' ? sharedFile : null),
      getPath: vi.fn(id => paths.get(id)),
      writeFile,
    });
    files.set(trashedPrivateFile.id, trashedPrivateFile);
    files.set(trashedOwnFile.id, trashedOwnFile);
    files.set(legacyTrashedFile.id, legacyTrashedFile);
    files.set('trash', { id: 'trash', name: 'Trash', type: 'folder' });
    files.set('other-app-data', { id: 'other-app-data', name: 'another.app', type: 'folder' });
    files.set('own-app-data', { id: 'own-app-data', name: 'editor.app', type: 'folder' });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:fs:write',
        { path: '/Documents/note.txt', content: 'edited' },
        'shared-file-edit',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'private-note' },
        'private-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'trashed-private-note' },
        'trashed-private-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'trashed-own-note' },
        'trashed-own-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:fs:read',
        { id: 'legacy-trashed-note' },
        'legacy-trashed-file-read',
        { id: 'editor.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('shared-note', 'edited');
    expect(responses[0].result.success).toBe(true);
    expect(responses[1].error.code).toBe('NOT_FOUND');
    expect(responses[2].error.code).toBe('NOT_FOUND');
    expect(responses[3].result.data).toBe('own data');
    expect(responses[4].error.code).toBe('NOT_FOUND');
  });

  it('prevents permissionless apps from deleting filesystem roots', async () => {
    const responses = [];
    const deleteToTrash = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: { trash: 'trash' },
      files: new Map([['root', { id: 'root', type: 'folder' }]]),
      getPath: vi.fn(() => '/'),
      deleteToTrash,
      permanentDelete: vi.fn(),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:fs:delete',
        { id: 'root' },
        'delete-root',
        { id: 'editor.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(deleteToTrash).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PROTECTED_LOCATION');
  });

  it('allows user-picked shared save folders without a broad filesystem grant', async () => {
    const responses = [];
    const sharedFolder = { id: 'documents', name: 'Documents', type: 'folder' };
    const ownFolder = { id: 'own-data', name: 'editor_app', type: 'folder' };
    const foreignFolder = { id: 'foreign-data', name: 'other.app', type: 'folder' };
    const paths = new Map([
      ['documents', '/Documents'],
      ['own-data', '/data/editor_app'],
      ['foreign-data', '/data/other.app'],
      ['root', '/'],
      ['data', '/data'],
    ]);
    const save = vi.fn(async () => {
      return { folderId: 'documents', name: 'notes.txt' };
    });
    const createFile = vi.fn(async () => ({ id: 'saved-note', name: 'notes.txt' }));
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('window', { SystemDialogs: { save } });
    vi.stubGlobal('FS', {
      rootId: 'root',
      specialFolders: {},
      files: new Map([
        ['documents', sharedFolder],
        ['own-data', ownFolder],
        ['foreign-data', foreignFolder],
        ['root', { id: 'root', type: 'folder' }],
        ['data', { id: 'data', type: 'folder' }],
      ]),
      getPath: vi.fn(id => paths.get(id)),
      listDir: vi.fn(() => []),
      createFile,
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { suggestedName: 'notes.txt', content: 'hello' },
        'picked-shared-save',
        { id: 'editor.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createFile).toHaveBeenCalledWith('documents', 'notes.txt', 'hello', 'text/plain');
    expect(responses[0].result.success).toBe(true);
  });

  it('allows validated appearance changes without system:settings', async () => {
    const responses = [];
    const values = new Map([['theme', 'nova-dark']]);
    vi.stubGlobal('OS', {
      settings: {
        get: key => values.get(key),
        set: vi.fn((key, value) => { values.set(key, value); return true; }),
      },
    });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      await AppSandbox._internal.handleAPICall(
        'nova:appearance:set',
        { appearance: { theme: 'nord', highContrast: true, transparentSurfaces: false } },
        'appearance-set-valid',
        { id: 'theme.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:appearance:set',
        { appearance: { username: 'changed' } },
        'appearance-set-invalid',
        { id: 'theme.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(values.get('theme')).toBe('nord');
    expect(values.get('removeTransparency')).toBe(true);
    expect(responses[0].result.appearance.highContrast).toBe(true);
    expect(responses[1].error.code).toBe('INVALID_ARGS');
  });

  it('renders sandbox app context menus in the host layer and returns the selected item', async () => {
    const responses = [];
    let dismissMenu;
    const show = vi.fn((_x, _y, _items, onDismiss) => {
      dismissMenu = onDismiss;
      return { id: 'host-menu' };
    });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', { ContextMenu: { show, hide: vi.fn() } });

    try {
      const request = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        {
          x: 24,
          y: 38,
          items: [
            { label: 'Open', icon: 'folder' },
            { separator: true },
            { label: 'Delete', danger: true },
          ],
        },
        'context-menu-select',
        // sandbox:nested-webview is a double gate: manifest opt-in (the
        // permissions declaration) plus the user grant.
        { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
        {
          getBoundingClientRect: () => ({ left: 100, top: 50 }),
          __directResponder: message => responses.push(message),
        },
        {}
      );
      dismissMenu(2);
      await request;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(show).toHaveBeenCalledWith(
      124,
      88,
      [
        { label: 'Open', icon: 'folder', shortcut: undefined, disabled: false, danger: false, _selectionIndex: 0 },
        { separator: true },
        { label: 'Delete', icon: undefined, shortcut: undefined, disabled: false, danger: true, _selectionIndex: 2 },
      ],
      expect.any(Function)
    );
    expect(responses[0].result).toEqual({ cancelled: false, index: 2 });
  });

  it('resolves a pending context-menu request when a newer menu replaces it', async () => {
    const dismissers = new Map();
    const menus = [];
    const responses = [];
    let nextMenuId = 0;
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', {
      ContextMenu: {
        show: vi.fn((_x, _y, _items, onDismiss) => {
          const menu = { id: ++nextMenuId };
          menus.push(menu);
          dismissers.set(menu, onDismiss);
          return menu;
        }),
        hide: vi.fn(menu => dismissers.get(menu)?.(null)),
      },
    });

    const sandbox = {};
    const app = { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } };
    const webview = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      __directResponder: message => responses.push(message),
    };
    try {
      const firstRequest = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        { x: 1, y: 2, items: [{ label: 'First' }] },
        'context-menu-first',
        app,
        webview,
        sandbox
      );
      const secondRequest = AppSandbox._internal.handleAPICall(
        'nova:context-menu:show',
        { x: 3, y: 4, items: [{ label: 'Second' }] },
        'context-menu-second',
        app,
        webview,
        sandbox
      );

      await firstRequest;
      expect(responses[0].result).toEqual({ cancelled: true, index: null });
      expect(sandbox.contextMenuCleanup).toBeTypeOf('function');

      dismissers.get(menus[1])?.(null);
      await secondRequest;
      expect(responses[1].result).toEqual({ cancelled: true, index: null });
      expect(sandbox.contextMenuCleanup).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels a host-rendered context menu when the sandbox closes', async () => {
    let dismissMenu;
    const hide = vi.fn((_menu) => dismissMenu(null));
    const sandbox = {};
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('window', {
      ContextMenu: {
        show: vi.fn((_x, _y, _items, onDismiss) => {
          dismissMenu = onDismiss;
          return { id: 'host-menu' };
        }),
        hide,
      },
    });

    const request = AppSandbox._internal.handleAPICall(
      'nova:context-menu:show',
      { x: 1, y: 2, items: [{ label: 'Open' }] },
      'context-menu-cancel',
      // sandbox:nested-webview is a double gate: manifest opt-in plus grant.
      { id: 'third-party.app', manifest: { permissions: ['sandbox:nested-webview'] } },
      { getBoundingClientRect: () => ({ left: 0, top: 0 }), __directResponder: vi.fn() },
      sandbox
    );
    try {
      AppSandbox._internal.cleanupSandboxRecord(sandbox);
      await request;
      expect(hide).toHaveBeenCalledOnce();
      expect(sandbox.contextMenuCleanup).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders sanitized app overlays above browser views and forwards marked interactions', async () => {
    const responses = [];
    const documentListeners = new Map();
    const frameListeners = new Map();
    const overlayDocument = {
      body: { innerHTML: '' },
      head: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({ textContent: '' })),
      addEventListener: (type, listener) => documentListeners.set(type, listener),
      removeEventListener: vi.fn(),
    };
    const frame = {
      style: {},
      contentDocument: overlayDocument,
      isConnected: false,
      setAttribute: vi.fn(),
      addEventListener: (type, listener) => frameListeners.set(type, listener),
      remove: vi.fn(function() { this.isConnected = false; }),
    };
    const sanitize = vi.fn(html => `sanitized:${html}`);
    const hostWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const appWindow = {
      isConnected: true,
      appendChild: vi.fn(element => {
        element.isConnected = true;
        frameListeners.get('load')();
      }),
      getBoundingClientRect: () => ({ left: 30, top: 40 }),
    };
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'sandbox:nested-webview',
    });
    vi.stubGlobal('DOMPurify', { sanitize });
    vi.stubGlobal('window', hostWindow);
    vi.stubGlobal('document', {
      createElement: vi.fn(() => frame),
      body: { appendChild: vi.fn() },
    });

    const sandbox = { state: { element: appWindow } };
    const webview = {
      clientWidth: 320,
      clientHeight: 200,
      getBoundingClientRect: () => ({ left: 40, top: 60, width: 320, height: 200 }),
      __directResponder: message => responses.push(message),
    };
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:overlay:show',
        {
          html: '<button data-nova-action="dismiss">Close</button>',
          css: '.panel { color: white; }',
          bounds: { left: 10, top: 20, width: 120, height: 80 },
        },
        'overlay-show',
        { id: 'third-party.app', name: 'Third Party', manifest: { permissions: ['sandbox:nested-webview'] } },
        webview,
        sandbox
      );

      expect(sanitize).toHaveBeenCalledWith(
        '<button data-nova-action="dismiss">Close</button>',
        expect.objectContaining({ FORBID_TAGS: expect.arrayContaining(['script', 'iframe']) })
      );
      expect(frame.setAttribute).toHaveBeenCalledWith('sandbox', 'allow-same-origin');
      expect(frame.srcdoc).toContain("script-src 'none'");
      expect(frame.style.position).toBe('absolute');
      expect(frame.style.left).toBe('20px');
      expect(frame.style.top).toBe('40px');
      expect(frame.style.width).toBe('120px');
      expect(frame.style.height).toBe('80px');
      expect(appWindow.appendChild).toHaveBeenCalledOnce();
      expect(document.body.appendChild).not.toHaveBeenCalled();
      expect(overlayDocument.body.innerHTML).toBe('sanitized:<button data-nova-action="dismiss">Close</button>');
      expect(overlayDocument.head.appendChild.mock.calls[0][0].textContent).toBe('.panel { color: white; }');
      expect(responses[0].result.success).toBe(true);

      const eventTarget = {
        nodeType: 1,
        value: '',
        checked: false,
        closest: selector => selector === 'a' ? null : eventTarget,
        getAttribute: name => name === 'data-nova-action' ? 'dismiss' : null,
      };
      documentListeners.get('click')({
        type: 'click',
        target: eventTarget,
        preventDefault: vi.fn(),
      });
      expect(responses[1].type).toBe('nova:overlay:event:response');
      expect(responses[1].result).toMatchObject({ type: 'click', action: 'dismiss', field: null });

      await AppSandbox._internal.handleAPICall(
        'nova:overlay:hide',
        {},
        'overlay-hide',
        { id: 'third-party.app' },
        webview,
        sandbox
      );
      expect(frame.remove).toHaveBeenCalledOnce();
      expect(sandbox.overlayCleanup).toBeNull();
      expect(responses[2].result).toMatchObject({ success: true, wasOpen: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('allows low-risk app launch and rate-limits repeated launches', async () => {
    const responses = [];
    const createWindow = vi.fn(() => ({ id: 'target-window' }));
    vi.stubGlobal('AppPermissionManager', {
      isGranted: permission => permission === 'system:app-launch',
    });
    vi.stubGlobal('OS', { apps: {}, settings: { get: () => false } });
    vi.stubGlobal('WM', { createWindow });

    try {
      const webview = { __directResponder: message => responses.push(message) };
      for (let i = 0; i < 31; i++) {
        await AppSandbox._internal.handleAPICall(
          'nova:app:launch',
          { appId: 'target-app' },
          `app-launch-${i}`,
          { id: 'launcher.app' },
          webview,
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createWindow).toHaveBeenCalledTimes(30);
    expect(responses.slice(0, 30).every(response => response.result.success)).toBe(true);
    expect(responses[30].error.code).toBe('RATE_LIMITED');
  });

  it('allows benign system events without system:events but protects app inventory events', async () => {
    const responses = [];
    const on = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('OS', { events: { on, off: vi.fn() } });

    try {
      const webview = {
        dataset: { sandboxId: 'theme-sandbox' },
        __directResponder: message => responses.push(message),
      };
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'system:themeChanged' },
        'safe-event',
        { id: 'theme.app' },
        webview,
        {}
      );
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'app:launched' },
        'sensitive-event',
        { id: 'theme.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._eventSubscriptions.delete('theme-sandbox');
    }

    expect(on).toHaveBeenCalledWith('system:themeChanged', expect.any(Function));
    expect(responses[0].result.subscribed).toBe('system:themeChanged');
    expect(responses[1].error.code).toBe('PERMISSION_DENIED');
  });

  it('guards only cancellable top-level navigation, not post-commit or subframe loads', async () => {
    const eventListeners = new Map();
    const child = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, callback) => eventListeners.set(name, callback)),
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    };
    const parent = { isConnected: true, style: {}, appendChild: vi.fn() };
    installSystemWebview({ location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('document', { createElement: vi.fn(() => child) });
    vi.stubGlobal('AppPermissionManager', {
      isGranted: vi.fn(permission => permission === 'sandbox:nested-webview'),
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:nested-webview',
        { action: 'create', id: 'nvw_navigation' },
        'nested-navigation-create',
        { id: 'third-party.app' },
        { getAttribute: () => null, __directResponder: vi.fn() },
        { nestedWebviewOptedIn: true, state: { content: parent } }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(eventListeners.has('loadcommit')).toBe(true);
    eventListeners.get('loadcommit')({
      isTopLevel: true,
      url: 'https://www.google.com/search?q=test',
    });
    expect(child.stop).not.toHaveBeenCalled();

    const preventDefault = vi.fn();
    eventListeners.get('will-navigate')({
      isTopLevel: true,
      url: 'https://www.google.com/search?q=test',
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(child.stop).not.toHaveBeenCalled();

    const subframePreventDefault = vi.fn();
    eventListeners.get('will-navigate')({
      isTopLevel: false,
      url: 'https://accounts.google.com/',
      preventDefault: subframePreventDefault,
    });
    expect(subframePreventDefault).not.toHaveBeenCalled();
  });

  it('clears both app and nested-site partitions for explicit app data removal', async () => {
    const partitions = [];
    const childViews = [];
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ baseUrl: '/api/apps/serve/sandbox-clear' }),
    })));
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        let src = '';
        const listeners = new Map();
        const view = {
          style: {},
          setAttribute: (name, value) => {
            if (name === 'partition') partitions.push(value);
          },
          addEventListener: (name, callback) => listeners.set(name, callback),
          removeEventListener: vi.fn(),
          remove: vi.fn(),
          clearData: vi.fn((_options, _types, callback) => callback()),
          set src(value) {
            src = value;
            if (src) queueMicrotask(() => listeners.get('loadstop')?.());
          },
          get src() { return src; },
        };
        childViews.push(view);
        return view;
      }),
      body: { appendChild: vi.fn() },
    });

    try {
      await AppSandbox.clearAppPartition('com.example.browser');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(partitions).toEqual([
      'persist:app_com.example.browser',
      'persist:app_com.example.browser_webcontent',
    ]);
    expect(childViews).toHaveLength(2);
    expect(childViews.every(view => view.clearData.mock.calls.length === 1)).toBe(true);
  });

  it('honors nested-webview manifest opt-in or permission declaration while requiring the grant', () => {
    vi.stubGlobal('AppPermissionManager', { isGranted: vi.fn(() => true) });
    try {
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: true },
      })).toBe(true);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.browser',
        manifest: { permissions: ['net:external', 'sandbox:nested-webview'] },
      })).toBe(true);
      expect(AppSandbox._internal.injectCapabilityShim(
        '<!doctype html><html></html>',
        {
          id: 'third-party.browser',
          manifest: { permissions: ['sandbox:nested-webview'] },
        }
      )).toContain('const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = true;');
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: false },
      })).toBe(false);

      AppPermissionManager.isGranted.mockReturnValue(false);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.app',
        manifest: { allowNestedWebview: true },
      })).toBe(false);
      expect(AppSandbox._internal.isNestedWebviewPermitted({
        id: 'third-party.browser',
        manifest: { permissions: ['sandbox:nested-webview'] },
      })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('provides a wallpaper IPC route without exposing OS to the app', async () => {
    const responses = [];
    const set = vi.fn(() => true);
    vi.stubGlobal('OS', { settings: { set } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:wallpaper:set',
        { key: 'wallpaperId', value: 'stock-blue' },
        'wallpaper-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const shim = AppSandbox._internal.buildCapabilityShim(false);
    expect(AppSandbox._internal.API_HANDLERS['nova:wallpaper:set']).toBeTypeOf('function');
    expect(shim).toContain("ipc('nova:wallpaper:set'");
    expect(set).toHaveBeenCalledWith('wallpaperId', 'stock-blue');
    expect(responses[0].type).toBe('nova:wallpaper:set:response');
    expect(responses[0].result).toEqual({ success: true });
  });

  it('reports the wallpaper policy block to sandboxed callers', async () => {
    const responses = [];
    const set = vi.fn(() => false);
    vi.stubGlobal('OS', { settings: { set } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:wallpaper:set',
        { key: 'customWallpaper', value: 'data:image/png;base64,abc' },
        'wallpaper-locked-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(set).toHaveBeenCalledWith('customWallpaper', 'data:image/png;base64,abc');
    expect(responses[0].error.code).toBe('POLICY_BLOCKED');
  });

  it('opens validated HTTP(S) URLs using the OS default browser app', async () => {
    const responses = [];
    const openUrl = vi.fn(() => ({ id: 'window-1' }));
    vi.stubGlobal('OS', { openUrl });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:open-url',
        { url: 'https://example.com/path?q=hello' },
        'open-url-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(openUrl).toHaveBeenCalledWith('https://example.com/path?q=hello');
    expect(responses[0].result).toEqual({ success: true, windowId: 'window-1' });
  });

  it('rejects non-HTTP(S) URLs from nova:open-url', async () => {
    const responses = [];
    const openUrl = vi.fn();
    vi.stubGlobal('OS', { openUrl });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:open-url',
        { url: 'javascript:alert(1)' },
        'open-url-invalid-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(openUrl).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('INVALID_ARGS');
  });

  it('preserves proxied image bytes for apps calling fetch().blob()', async () => {
    const responses = [];
    const binaryBody = 'iVBORw0KGgo=';
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    // resolveAndClassifyUrl resolves against window.location.origin, and
    // authedJsonFetch reads the CSRF token from the page's meta tag.
    vi.stubGlobal('window', { location: { origin: 'https://novabyte.test' } });
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'image/png' },
      body: binaryBody,
      bodyEncoding: 'base64',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:net:fetch',
        { url: 'https://images.example/image.png' },
        'binary-fetch-test',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    const shim = AppSandbox._internal.buildCapabilityShim(false);
    expect(responses[0].result).toMatchObject({ body: binaryBody, bodyEncoding: 'base64' });
    expect(shim).toContain("res.bodyEncoding === 'base64'");
    expect(shim).toContain('new Response(responseBody, responseInit)');
  });

  it('updates an existing file selected in the system Save dialog', async () => {
    const existing = { id: 'file-1', name: 'notes.txt', type: 'file' };
    const responses = [];
    const writeFile = vi.fn(async () => existing);
    const createFile = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    vi.stubGlobal('window', {
      SystemDialogs: { save: async () => ({ folderId: 'documents', name: 'notes.txt' }) },
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([
        ['root', { id: 'root', type: 'folder' }],
        ['documents', { id: 'documents', type: 'folder' }],
        [existing.id, existing],
      ]),
      listDir: () => [existing],
      writeFile,
      createFile,
      getPath: id => id === 'root' ? '/' : id === 'documents' ? '/Documents' : '/Documents/notes.txt',
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        { content: 'updated text', mimeType: 'text/plain' },
        'save-test',
        { id: 'com.astroos.textedit' },
        { __directResponder: message => responses.push(message) }
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(writeFile).toHaveBeenCalledWith('file-1', 'updated text', 'text/plain');
    expect(createFile).not.toHaveBeenCalled();
    expect(responses[0].result.file.path).toBe('/Documents/notes.txt');
  });

  it('saves Base64 image data URLs as filesystem binary content with the right MIME type', async () => {
    const responses = [];
    const folder = { id: 'app-data', type: 'folder' };
    const createFile = vi.fn(async (folderId, name, content, mimeType) => ({
      id: 'saved-image',
      name,
      content,
      mimeType,
    }));
    vi.stubGlobal('AppPermissionManager', {
      isGranted: () => false,
    });
    vi.stubGlobal('window', {
      SystemDialogs: { save: async () => ({ folderId: folder.id, name: 'wallhaven.jpg' }) },
    });
    vi.stubGlobal('FS', {
      rootId: 'root',
      files: new Map([[folder.id, folder]]),
      getPath: id => id === folder.id ? '/data/example.app' : '/data/example.app/wallhaven.jpg',
      listDir: () => [],
      createFile,
    });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:sysdialog:save',
        {
          suggestedName: 'wallhaven.jpg',
          content: 'data:image/jpeg;base64,/9j/2Q==',
          mimeType: 'text/plain',
        },
        'save-jpeg-test',
        { id: 'example.app' },
        { __directResponder: message => responses.push(message) },
        {}
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(createFile).toHaveBeenCalledWith(folder.id, 'wallhaven.jpg', '/9j/2Q==', 'image/jpeg');
    expect(responses[0].result.file.name).toBe('wallhaven.jpg');
  });

  it('infers image MIME types from file extensions for raw Base64 content', () => {
    expect(AppSandbox._internal.normalizeFsSavePayload({
      content: '/9j/2Q==',
    }, 'wallhaven.jpg')).toEqual({
      content: '/9j/2Q==',
      mimeType: 'image/jpeg',
      binary: true,
    });
  });

  it('blocks system-only Settings and Clock IPC before any handler side effect', async () => {
    const responses = [];
    const forbidden = [...AppSandbox._internal.GUEST_FORBIDDEN_IPC_APIS];
    const grantPermission = vi.fn();
    const saveItem = vi.fn();
    vi.stubGlobal('AppPermissionManager', {
      isGranted: () => true,
      grantPermission,
      revokePermission: vi.fn(),
      resetPermission: vi.fn(),
    });
    // Node ≥22 may expose localStorage as a non-configurable global, which
    // vi.stubGlobal cannot redefine — fall back to spying on the live one.
    const lsDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const lsSpies = [];
    if (lsDescriptor && lsDescriptor.configurable === false) {
      lsSpies.push(vi.spyOn(globalThis.localStorage, 'getItem').mockReturnValue(null));
      lsSpies.push(vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(saveItem));
      lsSpies.push(vi.spyOn(globalThis.localStorage, 'removeItem').mockReturnValue());
    } else {
      vi.stubGlobal('localStorage', { getItem: () => null, setItem: saveItem, removeItem: vi.fn() });
    }

    try {
      for (let i = 0; i < forbidden.length; i++) {
        const api = forbidden[i];
        expect(AppSandbox._internal.API_HANDLERS[api]).toBeUndefined();
        await AppSandbox._internal.handleAPICall(
          api,
          { appId: 'com.victim.other-app', permission: 'system:root', granted: true, mode: 'factory-reset' },
          'forbidden-' + i,
          { id: 'third-party.malicious' },
          { __directResponder: message => responses.push(message) },
          {}
        );
      }
    } finally {
      vi.unstubAllGlobals();
      for (const spy of lsSpies) spy.mockRestore();
    }

    expect(responses).toHaveLength(forbidden.length);
    expect(responses.every(message => message.error?.code === 'PERMISSION_DENIED')).toBe(true);
    expect(grantPermission).not.toHaveBeenCalled();
    expect(saveItem).not.toHaveBeenCalled();
  });

  it('escapes script-breaking launch option values as literal unicode escapes', () => {
    const options = {
      note: '</script><script>window.pwned=true</script> & suffix',
      separator: '\u2028 and \u2029',
    };
    const html = AppSandbox._internal.injectCapabilityShim(
      '<!doctype html><html><body>entry</body></html>',
      { id: 'com.example.options' },
      options
    );
    const match = html.match(/window\.__NOVA_APP_OPTIONS__=([\s\S]*?);<\/script>/);
    expect(match).not.toBeNull();
    expect(match[1]).toContain('\\u003c/script\\u003e');
    expect(match[1]).toContain('\\u0026');
    expect(match[1]).toContain('\\u2028');
    expect(match[1]).toContain('\\u2029');
    expect(JSON.parse(match[1])).toEqual(options);
    expect(html).not.toContain('</script><script>window.pwned=true');
  });

  it('injects transparent-root CSS even when entry HTML has no head element', () => {
    const html = AppSandbox._internal.injectCapabilityShim(
      '<main id="app">fragment entry</main>',
      { id: 'com.example.transparent', transparent: true },
      {}
    );
    expect(html).toContain('<style id="novaapp-transparent-root">html,body{background:transparent;}</style>');
    expect(html.indexOf('novaapp-transparent-root')).toBeLessThan(html.indexOf('window.__NOVA_APP_OPTIONS__'));
  });

  it('emits syntactically valid XHR bridge code with callbacks, binary bodies, and CRLF headers', () => {
    const shim = AppSandbox._internal.buildCapabilityShim(false);
    const script = shim.slice(shim.indexOf('<script>') + 8, shim.lastIndexOf('</script>'));

    expect(() => new Function(script)).not.toThrow();
    expect(shim).toContain("const propertyHandler = xhr['on' + type]");
    expect(shim).toContain('headerLines.join(\'\\r\\n\')');
    expect(shim).toContain("responseType === 'arraybuffer'");
    // The body cap is baked in from the app's httpBodyBytes ledger budget
    // (default 6 MiB) — the message is computed, not a fixed literal.
    expect(shim).toContain('__NOVA_MAX_BODY_BYTES__');
    expect(shim).toContain("'XHR request body exceeds the '");
    expect(shim).toContain("bodyEncoding: encodedBody.bodyEncoding");
  });

  it('classifies WebSocket URLs and requires net:internal for private destinations', async () => {
    const classify = AppSandbox._internal.resolveAndClassifyWebSocketUrl;
    expect(classify('wss://socket.example.com/events')).toMatchObject({ valid: true, isInternal: false });
    expect(classify('ws://127.0.0.1:9000/events')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://192.168.1.4:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://[::1]:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://router.local:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('ws://printer:9000')).toMatchObject({ valid: true, isInternal: true });
    expect(classify('wss://169.254.169.254/metadata')).toMatchObject({ valid: false });
    expect(classify('https://socket.example.com')).toMatchObject({ valid: false });

    const responses = [];
    const WebSocketMock = vi.fn(function() {});
    vi.stubGlobal('WebSocket', WebSocketMock);
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'net:websocket' });
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:net:websocket',
        { url: 'ws://127.0.0.1:9000/private' },
        'internal-ws-denied',
        { id: 'third-party.app' },
        { __directResponder: message => responses.push(message) },
        { wsConnections: new Map() }
      );
    } finally {
      vi.unstubAllGlobals();
    }
    expect(WebSocketMock).not.toHaveBeenCalled();
    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
  });

  it('completes the raw WebSocket API: push events are subscribable and filtered to the owning app', async () => {
    const responses = [];
    const busHandlers = new Map();
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'net:websocket' });
    vi.stubGlobal('OS', { events: { on: (name, handler) => busHandlers.set(name, handler), off: vi.fn(), emit: vi.fn() } });

    const webview = {
      dataset: { sandboxId: 'ws-push-sandbox' },
      __directResponder: message => responses.push(message),
    };
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'nova:net:ws:message' },
        'ws-push-subscribe',
        { id: 'ws.owner.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._eventSubscriptions.delete('ws-push-sandbox');
    }

    expect(responses[0].result.subscribed).toBe('nova:net:ws:message');
    const handler = busHandlers.get('nova:net:ws:message');
    expect(handler).toBeTypeOf('function');

    // The bus is global, so a payload addressed to another app must not
    // deliver — otherwise any subscriber to the name hears every app's
    // socket traffic.
    handler({ appId: 'other.app', wsId: 'ws_foreign', data: 'secret' });
    expect(responses).toHaveLength(1);

    // The owning app's own socket traffic delivers with the same envelope
    // the wrapper's onMessage receives, plus appId for the filter.
    handler({ appId: 'ws.owner.app', wsId: 'ws_own', data: 'hello' });
    expect(responses[1].type).toBe('nova:events:event:response');
    expect(responses[1].result).toEqual({
      event: 'nova:net:ws:message',
      data: { appId: 'ws.owner.app', wsId: 'ws_own', data: 'hello' },
    });
  });

  it('requires net:websocket to subscribe to WebSocket push events', async () => {
    const responses = [];
    const on = vi.fn();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    vi.stubGlobal('OS', { events: { on, off: vi.fn(), emit: vi.fn() } });

    const webview = {
      dataset: { sandboxId: 'ws-push-denied' },
      __directResponder: message => responses.push(message),
    };
    try {
      await AppSandbox._internal.handleAPICall(
        'nova:events:subscribe',
        { event: 'nova:net:ws:error' },
        'ws-push-denied',
        { id: 'ws.denied.app' },
        webview,
        {}
      );
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._eventSubscriptions.delete('ws-push-denied');
    }

    expect(responses[0].error.code).toBe('PERMISSION_DENIED');
    expect(on).not.toHaveBeenCalled();
  });

  it('mirrors WebSocket socket pushes onto the event bus for raw subscribers', async () => {
    const emit = vi.fn();
    const pushed = [];
    const socket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const WebSocketMock = vi.fn(function() { return socket; });
    vi.stubGlobal('WebSocket', WebSocketMock);
    vi.stubGlobal('AppPermissionManager', { isGranted: permission => permission === 'net:websocket' });
    vi.stubGlobal('OS', { events: { on: vi.fn(), off: vi.fn(), emit } });

    try {
      await AppSandbox._internal.handleAPICall(
        'nova:net:websocket',
        { url: 'wss://socket.example.com/raw' },
        'ws-bus-mirror',
        { id: 'ws.mirror.app' },
        { __directResponder: message => pushed.push(message) },
        { wsConnections: new Map() }
      );
      socket.onmessage({ data: 'payload' });
      socket.onerror({});
      socket.onclose({ code: 1000, reason: 'done', wasClean: true });
    } finally {
      vi.unstubAllGlobals();
    }

    // The bus mirror: one emit per socket event, each carrying the owning
    // app's id so the subscribe-side filter can drop foreign traffic.
    expect(emit).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls[0][0]).toBe('nova:net:ws:message');
    expect(emit.mock.calls[0][1]).toEqual({ appId: 'ws.mirror.app', wsId: expect.any(String), data: 'payload' });
    const wsId = emit.mock.calls[0][1].wsId;
    expect(emit.mock.calls[1]).toEqual(['nova:net:ws:error', { appId: 'ws.mirror.app', wsId, error: 'WebSocket error' }]);
    expect(emit.mock.calls[2][0]).toBe('nova:net:ws:close');
    expect(emit.mock.calls[2][1]).toEqual({ appId: 'ws.mirror.app', wsId, code: 1000, reason: 'done', clean: true });

    // The per-webview direct pushes are untouched — wrapper and facade
    // listeners keep their existing delivery path alongside the bus.
    expect(pushed.map(message => message.type)).toEqual([
      'nova:net:ws:message:response', 'nova:net:ws:error:response', 'nova:net:ws:close:response',
    ]);
  });

  it('cleans nested views, popups, and subscriptions using the captured sandbox record', () => {
    const unsubscribeAppearance = vi.fn();
    const destroySandbox = vi.fn();
    vi.stubGlobal('window', { NovaSystemWebview: { destroySandbox } });
    const record = {
      appearanceSubscription: unsubscribeAppearance,
    };
    const sandboxes = AppSandbox._internal._activeSandboxes;
    sandboxes.set('record-cleanup-test', record);
    sandboxes.delete('record-cleanup-test'); // destroy() deletes before running cleanup
    AppSandbox._internal.cleanupSandboxRecord(record, []);
    vi.unstubAllGlobals();

    expect(destroySandbox).toHaveBeenCalledOnce();
    expect(destroySandbox).toHaveBeenCalledWith(record);
    expect(unsubscribeAppearance).toHaveBeenCalledOnce();
  });

  it('closes sandbox WebSockets after the registry entry has already been removed', () => {
    const socket = { close: vi.fn() };
    const record = { wsConnections: new Map([['ws-1', { ws: socket }]]) };
    const listeners = new Map();
    const webview = {
      addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
      removeEventListener: vi.fn(name => listeners.delete(name)),
    };
    const sandboxId = 'websocket-cleanup-test';
    const teardown = AppSandbox._internal.setupAPIBridge(webview, { id: 'com.example.cleanup' }, sandboxId, record);
    AppSandbox._internal._activeSandboxes.set(sandboxId, record);
    AppSandbox._internal._activeSandboxes.delete(sandboxId);
    teardown();

    expect(socket.close).toHaveBeenCalledWith(1000, 'sandbox closed');
    expect(record.wsConnections.size).toBe(0);
    expect(listeners.size).toBe(0);
  });

  it('blocks relaunch cleanup while a sandbox still uses the shared app partition', async () => {
    const appId = 'com.example.partition-active';
    AppSandbox._internal._activeSandboxes.set('active-partition-user', { appId });
    AppSandbox._internal.partitionCleanupRequired.add(appId);
    try {
      await expect(AppSandbox._internal.ensureExecutionPartitionClean(appId))
        .rejects.toThrow(/close all existing windows before relaunching/);
    } finally {
      AppSandbox._internal._activeSandboxes.delete('active-partition-user');
      AppSandbox._internal.partitionCleanupRequired.delete(appId);
    }
  });

  it('does not report partition cleanup success if the partition cannot be cleared', async () => {
    const listeners = new Map();
    const webview = {
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn((name, handler) => listeners.set(name, handler)),
      removeEventListener: vi.fn(name => listeners.delete(name)),
      remove: vi.fn(),
      clearData: vi.fn(),
      set src(_value) { queueMicrotask(() => listeners.get('loadabort')?.({ reason: 'blocked' })); },
    };
    vi.stubGlobal('document', { createElement: () => webview, body: { appendChild: vi.fn() } });
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    vi.stubGlobal('fetch', vi.fn(async url => url === '/api/apps/serve/register'
      ? { ok: true, json: async () => ({ baseUrl: '/api/apps/serve/cleanup-test' }) }
      : { ok: true }));
    try {
      await expect(AppSandbox._internal.clearAppPartitionsByName('com.example.cleanup', ['app_com.example.cleanup']))
        .rejects.toThrow(/navigation failed/);
      expect(webview.clearData).not.toHaveBeenCalled();
      expect(webview.remove).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/apps\/serve\/unregister\/sandbox_clr_com\.example\.cleanup_\d+$/), expect.objectContaining({ method: 'DELETE' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

});

describe('sandbox escape popups (sandbox:escape-popups)', () => {
  const granted = { isGranted: permission => permission === 'sandbox:escape-popups' };
  const denied = { isGranted: () => false };

  it('honors the documented top-level allowPopupsToEscapeSandbox manifest flag', () => {
    vi.stubGlobal('AppPermissionManager', granted);
    try {
      const app = { id: 'com.example.oauth', allowPopupsToEscapeSandbox: true };
      const attr = AppSandbox._internal.sanitizeSandboxAttr(app.sandbox, app.id, false, app);
      expect(attr).toContain('allow-popups');
      expect(attr).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honors the flag set under manifest.allowPopupsToEscapeSandbox', () => {
    vi.stubGlobal('AppPermissionManager', granted);
    try {
      const app = { id: 'com.example.oauth2', manifest: { allowPopupsToEscapeSandbox: true } };
      const attr = AppSandbox._internal.sanitizeSandboxAttr(app.sandbox, app.id, false, app);
      expect(attr).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the legacy sandbox-object opt-in for direct callers without an app object', () => {
    vi.stubGlobal('AppPermissionManager', granted);
    try {
      const attr = AppSandbox._internal.sanitizeSandboxAttr(
        { allowPopupsToEscapeSandbox: true }, 'com.example.legacy', false
      );
      expect(attr).toContain('allow-popups');
      expect(attr).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('adds the escape token on manifest opt-in even while still ungranted — consent is enforced at popup time', () => {
    vi.stubGlobal('AppPermissionManager', denied);
    try {
      // The attribute records the publisher's INTENT, not the consent
      // decision: it must carry the escape token even before the user has
      // granted anything, because the sandbox attribute is written once at
      // creation while the grant can arrive at any time (the documented
      // requestPermission-at-first-use pattern). Gating the token on the
      // grant here made it a creation-time snapshot: popups spawned by a
      // guest whose attribute lacked the token stayed sandboxed (opaque
      // 'null' origin) and every postMessage relay from a provider callback
      // page was silently dropped. The consent gate lives in
      // setupSandboxPopupHandler, checked per popup at newwindow time.
      const configless = AppSandbox._internal.sanitizeSandboxAttr(
        undefined, 'com.example.ungranted', false,
        { id: 'com.example.ungranted', allowPopupsToEscapeSandbox: true }
      );
      expect(configless).toContain('allow-popups');
      expect(configless).toContain('allow-popups-to-escape-sandbox');

      // Object form with popups never declared: opting in still implies
      // allow-popups alongside the escape token.
      const objectForm = AppSandbox._internal.sanitizeSandboxAttr(
        { allowScripts: true }, 'com.example.ungranted', false,
        { id: 'com.example.ungranted', allowPopupsToEscapeSandbox: true }
      );
      expect(objectForm).toContain('allow-popups');
      expect(objectForm).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats a string-form escape token as the opt-in; the user grant is enforced at popup time, not in the attribute', () => {
    vi.stubGlobal('AppPermissionManager', denied);
    try {
      // Same rule as the object form: the string mentioning the token is
      // the publisher's opt-in, so the attribute carries it regardless of
      // grant state. What keeps an ungranted string-form app from actually
      // opening escaped popups is the per-popup consent check in
      // setupSandboxPopupHandler — the old creation-time gate here was
      // silently stranding mid-session grants.
      const deniedAttr = AppSandbox._internal.sanitizeSandboxAttr(
        'allow-scripts allow-popups allow-popups-to-escape-sandbox', 'com.example.string', false
      );
      expect(deniedAttr).toContain('allow-popups');
      expect(deniedAttr).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('implies allow-popups when escape is permitted but allowPopups was never declared', () => {
    vi.stubGlobal('AppPermissionManager', granted);
    try {
      // allow-popups-to-escape-sandbox only controls sandbox inheritance of
      // an OPENED popup; without allow-popups the popup is blocked outright.
      const app = { id: 'com.example.escape-only', sandbox: {}, allowPopupsToEscapeSandbox: true };
      const attr = AppSandbox._internal.sanitizeSandboxAttr(app.sandbox, app.id, false, app);
      expect(attr).toContain('allow-popups');
      expect(attr).toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves popups blocked for apps without the manifest opt-in', () => {
    vi.stubGlobal('AppPermissionManager', granted);
    try {
      const app = { id: 'com.example.opted-out', sandbox: { allowScripts: true } };
      const attr = AppSandbox._internal.sanitizeSandboxAttr(app.sandbox, app.id, false, app);
      expect(attr).toContain('allow-scripts');
      expect(attr).not.toContain('allow-popups-to-escape-sandbox');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('sandbox popup display (setupSandboxPopupHandler)', () => {
  function makeFakeElement(tag = 'div') {
    const listeners = new Map();
    const element = {
      tagName: tag,
      style: { cssText: '' },
      attrs: {},
      children: [],
      setAttribute(name, value) { element.attrs[name] = value; },
      appendChild(child) { element.children.push(child); return child; },
      append(...children) { element.children.push(...children); },
      addEventListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      removeEventListener(name, fn) {
        const queue = listeners.get(name) || [];
        const index = queue.indexOf(fn);
        if (index !== -1) queue.splice(index, 1);
      },
      remove: vi.fn(),
      fire(name, event) {
        for (const fn of [...(listeners.get(name) || [])]) fn(event);
      },
    };
    return element;
  }

  function installFakeDocument() {
    const created = [];
    vi.stubGlobal('document', {
      createElement: tag => {
        const element = makeFakeElement(tag);
        created.push(element);
        return element;
      },
    });
    vi.stubGlobal('window', { innerWidth: 1024, innerHeight: 768 });
    return created;
  }

  function makeWebview() {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      removeEventListener(name, fn) {
        const queue = listeners.get(name) || [];
        const index = queue.indexOf(fn);
        if (index !== -1) queue.splice(index, 1);
      },
    };
  }

  it('attaches a permitted popup into an OS-owned overlay over the app content', () => {
    const created = installFakeDocument();
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');
    const attach = vi.fn();
    const discard = vi.fn();

    // The attr carries the escape token, so the per-popup consent check
    // consults the manager — this test covers the granted path.
    vi.stubGlobal('AppPermissionManager', { isGranted: () => true });
    const teardown = AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.oauth' }, {
      sandboxAttr: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
      partitionId: 'app_com.example.oauth',
      state: { content: contentEl },
    });

    webview.listeners.get('newwindow')[0]({
      targetUrl: 'https://accounts.example.com/oauth?client_id=1',
      initialWidth: 480,
      initialHeight: 640,
      window: { attach, discard },
    });

    expect(attach).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(contentEl.children).toHaveLength(1);
    const popupWebview = created.find(el => el.tagName === 'webview');
    expect(popupWebview.attrs.partition).toBe('persist:app_com.example.oauth');
    expect(popupWebview.attrs.nodeintegration).toBe('false');
    expect(popupWebview.attrs.enableremotemodule).toBe('false');

    // Closing inside the popup (window.close()) removes the overlay.
    popupWebview.fire('close');
    const backdrop = contentEl.children[0];
    expect(backdrop.remove).toHaveBeenCalledOnce();
    teardown();
    vi.unstubAllGlobals();
  });

  it('refuses to display an escape-capable popup while sandbox:escape-popups is ungranted', () => {
    installFakeDocument();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');
    const attach = vi.fn();
    const discard = vi.fn();

    try {
      AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.ungranted' }, {
        sandboxAttr: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
        partitionId: 'app_com.example.ungranted',
        state: { content: contentEl },
      });

      webview.listeners.get('newwindow')[0]({
        targetUrl: 'https://github.com/login/oauth/authorize',
        window: { attach, discard },
      });

      // The attribute already let Chromium spawn this popup UNSANDBOXED —
      // displaying it would hand out exactly what the consent gate exists
      // to guard, so discard is the only safe outcome (the guest's
      // window.open fails, same visible result as a blocked popup).
      expect(discard).toHaveBeenCalledOnce();
      expect(attach).not.toHaveBeenCalled();
      expect(contentEl.children).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed when the permission manager is unavailable for an escape-capable popup', () => {
    installFakeDocument();
    // No AppPermissionManager global at all — must behave like ungranted.
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');
    const attach = vi.fn();
    const discard = vi.fn();

    AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.nomanager' }, {
      sandboxAttr: 'allow-popups allow-popups-to-escape-sandbox',
      partitionId: 'app_com.example.nomanager',
      state: { content: contentEl },
    });

    webview.listeners.get('newwindow')[0]({
      targetUrl: 'https://example.com/popup',
      window: { attach, discard },
    });

    expect(discard).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('honors an escape-popups grant obtained after the sandbox was created — no relaunch needed', () => {
    // The regression this whole change fixes: consent used to be read once,
    // at sandbox creation, so an app that called requestPermission()
    // mid-session (the documented first-use pattern) kept spawning popups
    // that stayed sandboxed — opaque origin, dropped postMessage relays,
    // OAuth flows dying as "popup closed before sign-in completed".
    let granted = false;
    installFakeDocument();
    vi.stubGlobal('AppPermissionManager', { isGranted: () => granted });
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');

    try {
      AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.late-grant' }, {
        sandboxAttr: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
        partitionId: 'app_com.example.late-grant',
        state: { content: contentEl },
      });

      const beforeGrant = { attach: vi.fn(), discard: vi.fn() };
      webview.listeners.get('newwindow')[0]({
        targetUrl: 'https://github.com/login/oauth/authorize',
        window: beforeGrant,
      });
      expect(beforeGrant.discard).toHaveBeenCalledOnce();

      granted = true; // the user answered the consent dialog mid-session

      const afterGrant = { attach: vi.fn(), discard: vi.fn() };
      webview.listeners.get('newwindow')[0]({
        targetUrl: 'https://github.com/login/oauth/authorize',
        window: afterGrant,
      });
      expect(afterGrant.attach).toHaveBeenCalledOnce();
      expect(afterGrant.discard).not.toHaveBeenCalled();
      expect(contentEl.children).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('discards popups when the sandbox tokens do not permit them', () => {
    installFakeDocument();
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');
    const attach = vi.fn();
    const discard = vi.fn();

    AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.blocked' }, {
      sandboxAttr: 'allow-scripts allow-downloads',
      partitionId: 'app_com.example.blocked',
      state: { content: contentEl },
    });

    webview.listeners.get('newwindow')[0]({
      targetUrl: 'https://ads.example.com/popup',
      window: { attach, discard },
    });

    expect(discard).toHaveBeenCalledOnce();
    expect(attach).not.toHaveBeenCalled();
    expect(contentEl.children).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('discards un-navigable popup targets like about:blank and javascript: URLs', () => {
    installFakeDocument();
    const webview = makeWebview();
    const discard = vi.fn();
    const attach = vi.fn();

    AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.junk' }, {
      sandboxAttr: 'allow-popups',
      partitionId: 'app_com.example.junk',
      state: { content: makeFakeElement('div') },
    });

    for (const targetUrl of ['', 'about:blank', 'javascript:void(0)']) {
      webview.listeners.get('newwindow')[0]({ targetUrl, window: { attach, discard } });
    }

    expect(discard).toHaveBeenCalledTimes(3);
    expect(attach).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('tears down open overlays and the listener when the sandbox is destroyed', () => {
    const created = installFakeDocument();
    const webview = makeWebview();
    const contentEl = makeFakeElement('div');

    const teardown = AppSandbox._internal.setupSandboxPopupHandler(webview, { id: 'com.example.teardown' }, {
      sandboxAttr: 'allow-popups',
      partitionId: 'app_com.example.teardown',
      state: { content: contentEl },
    });

    webview.listeners.get('newwindow')[0]({
      targetUrl: 'https://example.com/first',
      window: { attach: vi.fn() },
    });
    expect(contentEl.children).toHaveLength(1);

    teardown();

    expect(contentEl.children[0].remove).toHaveBeenCalledOnce();
    expect(webview.listeners.get('newwindow')).toHaveLength(0);
    expect(created.find(el => el.tagName === 'webview')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('stable per-app serving alias (sandbox_<appId>)', () => {
  const ORIGIN = 'http://localhost:3003';

  function makeSandboxWebview() {
    const listeners = new Map();
    const webview = {
      tagName: 'webview',
      listeners,
      dataset: {},
      style: { cssText: '' },
      attrs: {},
      contentScripts: [],
      addEventListener(name, fn) {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(fn);
      },
      removeEventListener(name, fn) {
        const queue = listeners.get(name) || [];
        const index = queue.indexOf(fn);
        if (index !== -1) queue.splice(index, 1);
      },
      setAttribute(name, value) { webview.attrs[name] = value; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(webview.attrs, name) ? webview.attrs[name] : null; },
      removeAttribute(name) { delete webview.attrs[name]; },
      addContentScripts(scripts) { webview.contentScripts.push(...scripts); },
    };
    return webview;
  }

  function installSandboxStubs() {
    vi.stubGlobal('document', {
      createElement: tag => (tag === 'webview' ? makeSandboxWebview() : { style: { cssText: '' }, attrs: {}, children: [], appendChild: child => child, append() {}, addEventListener() {}, setAttribute() {} }),
      body: { appendChild() {} },
    });
    vi.stubGlobal('window', { location: { origin: ORIGIN }, innerWidth: 1024, innerHeight: 768 });
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false });
  }

  it('registers bundled files under the stable per-app alias and loads from the session path', async () => {
    installSandboxStubs();
    const registerCalls = [];
    vi.stubGlobal('fetch', vi.fn((url, init) => {
      registerCalls.push({ url, body: JSON.parse(init.body) });
      const sandboxId = registerCalls[registerCalls.length - 1].body.sandboxId;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          baseUrl: `/api/apps/serve/${sandboxId}`,
          stableBaseUrl: `/api/apps/serve/sandbox_com.test.oauth`,
        }),
      });
    }));

    try {
      AppSandbox._internal._resetState();
      const webview = { dataset: { sandboxId: 'sandbox_com.test.oauth_e5be8755-c430-4f3f-802b-56b23abc3999' } };
      const app = {
        id: 'com.test.oauth',
        name: 'OAuth Test',
        entry: 'index.html',
        files: { 'index.html': Buffer.from('<html><body>hi</body></html>').toString('base64') },
      };

      await AppSandbox._internal.loadAppContent(webview, app, {});

      // The registration asks for the stable alias: appId rides along with
      // the sandboxId, and the webview itself still loads from the per-launch
      // session path.
      expect(registerCalls).toHaveLength(1);
      expect(registerCalls[0].url).toBe('/api/apps/serve/register');
      expect(registerCalls[0].body).toMatchObject({
        sandboxId: 'sandbox_com.test.oauth_e5be8755-c430-4f3f-802b-56b23abc3999',
        appId: 'com.test.oauth',
      });
      expect(webview.src).toBe(`${ORIGIN}/api/apps/serve/sandbox_com.test.oauth_e5be8755-c430-4f3f-802b-56b23abc3999/index.html`);
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('degrades to session-only registration for ids that are not alias-eligible', async () => {
    expect(AppSandbox._internal.stableServeAppId('com.test.oauth')).toBe('com.test.oauth');
    expect(AppSandbox._internal.stableServeAppId('webapp_github_123')).toBe('webapp_github_123');
    expect(AppSandbox._internal.stableServeAppId('Bad.App')).toBeNull();
    expect(AppSandbox._internal.stableServeAppId('nodot')).toBeNull();
    expect(AppSandbox._internal.stableServeAppId('sandbox_com.test.oauth')).toBeNull();
    expect(AppSandbox._internal.stableServeAppId(undefined)).toBeNull();

    installSandboxStubs();
    const registerBodies = [];
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      registerBodies.push(JSON.parse(init.body));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, baseUrl: `/api/apps/serve/${registerBodies[registerBodies.length - 1].sandboxId}` }),
      });
    }));

    try {
      AppSandbox._internal._resetState();
      const webview = { dataset: { sandboxId: 'sandbox_weird_id_1' } };
      const app = {
        id: 'not an app id',
        name: 'Odd',
        entry: 'index.html',
        files: { 'index.html': Buffer.from('<html></html>').toString('base64') },
      };

      await AppSandbox._internal.loadAppContent(webview, app, {});

      // No alias requested — the key is absent from the body entirely, so the
      // launch behaves exactly as it did before stable aliases existed.
      expect(registerBodies).toHaveLength(1);
      expect(Object.prototype.hasOwnProperty.call(registerBodies[0], 'appId')).toBe(false);
      expect(webview.src).toBe(`${ORIGIN}/api/apps/serve/sandbox_weird_id_1/index.html`);
    } finally {
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });

  it('scopes the isolated IPC transport to both the session and stable serving paths, and heartbeats only while the sandbox lives', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    installSandboxStubs();
    const fetchStub = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchStub);

    try {
      AppSandbox._internal._resetState();
      const app = {
        id: 'com.test.oauth',
        name: 'OAuth Test',
        entry: 'index.html',
        files: { 'index.html': Buffer.from('<html><body>hi</body></html>').toString('base64') },
      };
      const webview = AppSandbox.createSandbox(app, { innerHTML: '' }, { id: 'win-1' });

      // Transport content script matches this launch's session path AND this
      // app's stable alias — an OAuth provider redirecting the popup back to
      // the stable callback.html gets the same isolated transport.
      expect(webview.contentScripts).toHaveLength(1);
      const sandboxId = webview.dataset.sandboxId;
      expect(sandboxId).toMatch(/^sandbox_com\.test\.oauth_/);
      expect(webview.contentScripts[0].matches).toEqual([
        `${ORIGIN}/api/apps/serve/${sandboxId}/*`,
        `${ORIGIN}/api/apps/serve/sandbox_com.test.oauth/*`,
      ]);

      // Liveness heartbeat: fires on the 5-minute cadence while alive.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0][0]).toBe('/api/apps/serve/heartbeat');
      expect(JSON.parse(fetchStub.mock.calls[0][1].body)).toEqual({ sandboxId });
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(fetchStub).toHaveBeenCalledTimes(2);

      // Teardown (destroy() runs this via sandbox.cleanup) stops the beat.
      AppSandbox._internal._activeSandboxes.get(sandboxId).cleanup();
      const callsAtTeardown = fetchStub.mock.calls.length;
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(fetchStub.mock.calls).toHaveLength(callsAtTeardown);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      AppSandbox._internal._resetState();
    }
  });
});

describe('wallpaper settings keys — value validation (wallpaperId / customWallpaper)', () => {
  // The desktop's applyWallpaper treats wallpaperId as a WALLPAPER_PRESETS id
  // and customWallpaper as the image; an unknown id silently falls back to
  // stock-blue. The sandbox now rejects bad values with INVALID_ARGS so apps
  // can't "succeed" while changing nothing (the Wallpaper Hub 2.1 bug: it set
  // wallpaperId to a data URL and reported "Applied ✓" with no effect).
  const PRESET_IDS = ['stock-blue', 'stock-dark', 'stock-light', 'stock-green',
    'stock-purple', 'stock-red', 'stock-gray', 'stock-teal'];
  const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

  function stubOs(setImpl) {
    const set = vi.fn(setImpl || (() => undefined));
    vi.stubGlobal('OS', { settings: { set, get: () => false } });
    return set;
  }

  async function call(type, key, value) {
    const responses = [];
    await AppSandbox._internal.handleAPICall(
      type,
      { key, value },
      'wp-test',
      { id: 'com.test.wallpaper-app' },
      { __directResponder: (m) => responses.push(m) },
      {}
    );
    return responses[0];
  }

  beforeEach(() => {
    vi.stubGlobal('AppPermissionManager', { isGranted: () => false }); // no system:settings
    vi.stubGlobal('window', {
      WallpaperService: { getPresets: () => PRESET_IDS.map((id) => ({ id, name: id })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a data URL in wallpaperId with INVALID_ARGS (the 2.1 app bug)', async () => {
    stubOs();
    const res = await call('nova:wallpaper:set', 'wallpaperId', DATA_URL);
    expect(res.error).toMatchObject({ code: 'INVALID_ARGS' });
    expect(res.error.message).toMatch(/preset id/i);
  });

  it('rejects an unknown preset id with INVALID_ARGS', async () => {
    stubOs();
    const res = await call('nova:wallpaper:set', 'wallpaperId', 'my-cool-wallpaper');
    expect(res.error).toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('rejects a non-string wallpaperId with INVALID_ARGS', async () => {
    stubOs();
    const res = await call('nova:wallpaper:set', 'wallpaperId', { url: DATA_URL });
    expect(res.error).toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('accepts a known preset id and still requires no permission', async () => {
    const set = stubOs();
    const res = await call('nova:wallpaper:set', 'wallpaperId', 'stock-teal');
    expect(res.result).toMatchObject({ success: true });
    expect(set).toHaveBeenCalledWith('wallpaperId', 'stock-teal');
  });

  it('accepts null and empty string as "clear" values for wallpaperId', async () => {
    stubOs();
    expect((await call('nova:wallpaper:set', 'wallpaperId', null)).result).toMatchObject({ success: true });
    expect((await call('nova:wallpaper:set', 'wallpaperId', '')).result).toMatchObject({ success: true });
  });

  it('accepts a data URL in customWallpaper — the documented image key', async () => {
    const set = stubOs();
    const res = await call('nova:wallpaper:set', 'customWallpaper', DATA_URL);
    expect(res.result).toMatchObject({ success: true });
    expect(set).toHaveBeenCalledWith('customWallpaper', DATA_URL);
  });

  it('rejects a non-string customWallpaper with INVALID_ARGS', async () => {
    stubOs();
    const res = await call('nova:wallpaper:set', 'customWallpaper', 42);
    expect(res.error).toMatchObject({ code: 'INVALID_ARGS' });
  });

  it('keeps the exemption on nova:settings:set (no system:settings needed)', async () => {
    const set = stubOs();
    // Called via the raw handler: nova:settings:set is an isolated-process
    // API type, so handleAPICall would route it through the host-side
    // dispatch shim instead of our capture webview — the permission gate we
    // are asserting on lives in the handler itself.
    const viaHandler = (key, value, requestId) => {
      const responses = [];
      return AppSandbox._internal.API_HANDLERS['nova:settings:set']({
        payload: { key, value },
        requestId,
        app: { id: 'com.test.wallpaper-app' },
        webview: { __directResponder: (m) => responses.push(m) },
      }).then(() => responses[0]);
    };

    // AppPermissionManager.isGranted is false in this describe, so a non-
    // wallpaper key must still fail with PERMISSION_DENIED…
    const denied = await viaHandler('theme', 'nord', 'settings-theme');
    expect(denied.error).toMatchObject({ code: 'PERMISSION_DENIED' });
    // …while the wallpaper keys pass through without any grant.
    const ok = await viaHandler('customWallpaper', DATA_URL, 'settings-wallpaper');
    expect(ok.result).toMatchObject({ success: true });
    expect(set).toHaveBeenCalledWith('customWallpaper', DATA_URL);
  });

  it('still reports POLICY_BLOCKED when OS.settings.set refuses (prohibitWallpaperChange)', async () => {
    stubOs(() => false);
    const res = await call('nova:wallpaper:set', 'wallpaperId', 'stock-dark');
    expect(res.error).toMatchObject({ code: 'POLICY_BLOCKED' });
  });

  it('skips preset-id validation when WallpaperService is unavailable (defensive)', async () => {
    vi.stubGlobal('window', {}); // no WallpaperService
    stubOs();
    const res = await call('nova:wallpaper:set', 'wallpaperId', 'whatever-future-id');
    expect(res.result).toMatchObject({ success: true });
  });
});
