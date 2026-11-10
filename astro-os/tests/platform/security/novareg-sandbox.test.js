import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';

// Drives the nova:reg:* handlers through the REAL dispatcher
// (AppSandbox._internal.handleAPICall) with the REAL registry engine over a
// memory store, and asserts the guest-facing bridge contract + the per-hive
// security rules. Complements tests/test_ipc_matrix.js (which proves the MAC
// front-door grants) by covering the context-dependent half in the handlers.

function memStorage() {
  const map = new Map();
  return {
    loadAll() {
      const out = {};
      for (const hive of NovaRegistry.HIVES) {
        out[hive] = map.has(hive) ? JSON.parse(map.get(hive)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function makeBus() {
  const listeners = {};
  return {
    events: [],
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, data) {
      this.events.push({ name, data });
      for (const fn of (listeners[name] || []).slice()) fn(data);
    },
  };
}

const code = (r) => r?.error?.code ?? null;

describe('nova:reg:* sandbox handlers', () => {
  let grants, bus, settingsSet, devMode;

  beforeEach(() => {
    bus = makeBus();
    settingsSet = vi.fn();
    devMode = false;
    grants = new Set();
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
    // setup.js aliases window to globalThis; the handlers resolve the engine
    // off window at call time.
    globalThis.window.NovaRegistry = NovaRegistry;

    vi.stubGlobal('AppPermissionManager', {
      isGranted: (permission) => grants.has(permission),
    });
    vi.stubGlobal('OS', {
      settings: {
        get: (key) => (key === 'devMode' ? devMode : undefined),
        set: settingsSet,
      },
      events: bus,
      logger: console,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function call(type, payload, app) {
    const guestWindow = {};
    const webview = {
      executeScript: ({ code: script }, callback) => {
        const delivered = new Function('window', `return ${script}`)(guestWindow);
        callback([delivered]);
      },
    };
    await AppSandbox._internal.handleAPICall(type, payload, 'req-1', app, webview, { appId: app.id });
    return guestWindow.__novaInbox?.[0] ?? null;
  }

  const plainApp = { id: 'com.probe.app', system: false };
  const systemApp = { id: 'com.astroos.shell', system: true };

  it('denies reads without registry.read (MAC front door)', async () => {
    const r = await call('nova:reg:get', { path: 'HKNU/probe/color' }, plainApp);
    expect(code(r)).toBe('PERMISSION_DENIED');
  });

  it('reads seeded values with registry.read and reports absent ones', async () => {
    grants.add('registry.read');
    NovaRegistry.set('HKNU/probe/color', 'blue');

    const hit = await call('nova:reg:get', { path: 'HKNU/probe/color' }, plainApp);
    expect(hit.result).toMatchObject({ found: true, type: 'REG_SZ', data: 'blue' });

    const miss = await call('nova:reg:get', { path: 'HKNU/probe/nope' }, plainApp);
    expect(miss.result).toMatchObject({ found: false, path: 'HKNU/probe/nope' });
  });

  it('lists a value path as a leaf instead of NOT_FOUND (list covers the get path space)', async () => {
    grants.add('registry.read');
    NovaRegistry.set('HKNS/shell/theme', 'nova-dark');

    // A path that names a VALUE must list — get/stat accept it, so a plain
    // list() used to fail with "no such key" for the exact same path.
    const hit = await call('nova:reg:list', { path: 'HKNS/shell/theme' }, plainApp);
    expect(hit.result).toMatchObject({ path: 'HKNS/shell/theme', keys: [] });
    expect(hit.result.values.theme).toMatchObject({ type: 'REG_SZ', data: 'nova-dark' });

    // Unknown paths still report NOT_FOUND.
    const miss = await call('nova:reg:list', { path: 'HKNS/shell/ghost' }, plainApp);
    expect(code(miss)).toBe('NOT_FOUND');
  });

  it('blocks the HKNS/security subtree without registry.system, allows it with', async () => {
    grants.add('registry.read');
    NovaRegistry.set('HKNS/security/policy/prohibitWallpaperChange', false, { type: 'REG_BOOL' });

    const denied = await call('nova:reg:get', { path: 'HKNS/security/policy/prohibitWallpaperChange' }, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');

    const listed = await call('nova:reg:list', { path: 'HKNS/security' }, plainApp);
    expect(code(listed)).toBe('PERMISSION_DENIED');

    grants.add('registry.system');
    const allowed = await call('nova:reg:get', { path: 'HKNS/security/policy/prohibitWallpaperChange' }, plainApp);
    expect(allowed.result).toMatchObject({ found: true, data: false });
  });

  it('denies writes without registry.write', async () => {
    grants.add('registry.read'); // having read must not grant write
    const r = await call('nova:reg:set', { path: 'HKNA/com.probe.app/volume', value: 5 }, plainApp);
    expect(code(r)).toBe('PERMISSION_DENIED');
  });

  it('lets an app write only its OWN HKNA subtree', async () => {
    grants.add('registry.write');

    const own = await call('nova:reg:set', { path: 'HKNA/com.probe.app/volume', value: 80, type: 'REG_DWORD' }, plainApp);
    expect(own.result).toMatchObject({ success: true, type: 'REG_DWORD' });
    expect(NovaRegistry.get('HKNA/com.probe.app/volume')).toBe(80);

    const foreign = await call('nova:reg:set', { path: 'HKNA/com.other.app/volume', value: 1 }, plainApp);
    expect(code(foreign)).toBe('PERMISSION_DENIED');

    const root = await call('nova:reg:set', { path: 'HKNA/rooted-by-probe', value: 1 }, plainApp);
    expect(code(root)).toBe('PERMISSION_DENIED');
  });

  it('blocks HKNS writes for non-system apps, allows system apps and live-applies mapped keys', async () => {
    grants.add('registry.write');

    const denied = await call('nova:reg:set', { path: 'HKNS/shell/theme', value: 'dracula' }, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect(settingsSet).not.toHaveBeenCalled();

    const allowed = await call('nova:reg:set', { path: 'HKNS/shell/theme', value: 'dracula' }, systemApp);
    expect(allowed.result.success).toBe(true);
    // The sandbox no longer copies into OS.settings — the settings shim
    // subscribes to nova:reg:changed centrally, so the registry alone is
    // the source of truth and the shell live-applies through the shim.
    expect(settingsSet).not.toHaveBeenCalled();
    expect(NovaRegistry.get('HKNS/shell/theme')).toBe('dracula');
  });

  it('requires Developer Mode for the HKND dev hive', async () => {
    grants.add('registry.write');
    const payload = { path: 'HKND/scratch/note', value: 'x' };

    devMode = false;
    const denied = await call('nova:reg:set', payload, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');
    expect(denied.error.message).toMatch(/Developer Mode/i);

    devMode = true;
    const allowed = await call('nova:reg:set', payload, plainApp);
    expect(allowed.result.success).toBe(true);
  });

  it('rejects malformed paths with INVALID_ARGS before permission work', async () => {
    grants.add('registry.read');
    for (const path of ['BOGUS/x', 'HKNS/a/']) {
      const r = await call('nova:reg:get', { path }, plainApp);
      expect(code(r), path).toBe('INVALID_ARGS');
    }
  });

  it('surfaces engine error codes over the bridge (SUBTREE_NOT_EMPTY on delete)', async () => {
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/key/a', '1');
    NovaRegistry.set('HKNA/com.probe.app/key/b', '2');

    const blocked = await call('nova:reg:delete', { path: 'HKNA/com.probe.app/key' }, plainApp);
    expect(code(blocked)).toBe('SUBTREE_NOT_EMPTY');

    const ok = await call('nova:reg:delete', { path: 'HKNA/com.probe.app/key', recursive: true }, plainApp);
    expect(ok.result).toMatchObject({ success: true, removed: 'key' });
  });

  it('exports and imports through the bridge', async () => {
    grants.add('registry.read');
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/a/one', '1');

    const dump = await call('nova:reg:export', { path: 'HKNA/com.probe.app' }, plainApp);
    expect(dump.result.path).toBe('HKNA/com.probe.app');
    // 'one' is a value under the subtree's 'a' KEY.
    expect(dump.result.data.keys.a.values.one.data).toBe('1');

    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
    globalThis.window.NovaRegistry = NovaRegistry;
    // grants survive the re-init (they live in the stub, not the engine)

    const back = await call('nova:reg:import', { path: 'HKNA/com.probe.app/restored', data: dump.result.data }, plainApp);
    expect(back.result).toMatchObject({ success: true, merged: 1 });
    expect(NovaRegistry.get('HKNA/com.probe.app/restored/a/one')).toBe('1');
  });

  it('answers UNAVAILABLE when the engine is not loaded', async () => {
    grants.add('registry.read'); // MAC front door passes; the handler then reports
    vi.stubGlobal('window', {});
    const r = await call('nova:reg:get', { path: 'HKNU/x' }, plainApp);
    expect(code(r)).toBe('UNAVAILABLE');
  });

  it('emits nova:reg:changed to the event bus on committed writes', async () => {
    grants.add('registry.write');
    await call('nova:reg:set', { path: 'HKNA/com.probe.app/seen', value: true, type: 'REG_BOOL' }, plainApp);
    const event = bus.events.find((e) => e.name === 'nova:reg:changed');
    expect(event.data).toMatchObject({
      path: 'HKNA/com.probe.app/seen',
      type: 'REG_BOOL',
      value: true,
      appId: 'com.probe.app',
    });
  });

  it('addresses a key default value through the bridge (bare key path)', async () => {
    grants.add('registry.read');
    grants.add('registry.write');

    // A real KEY first (a value write under it), so the bare path below
    // addresses that key's default value — the engine is value-first when
    // no key exists at the path.
    NovaRegistry.set('HKNA/com.probe.app/agent/version', 1, { type: 'REG_DWORD' });

    const miss = await call('nova:reg:get', { path: 'HKNA/com.probe.app/agent' }, plainApp);
    expect(miss.result).toMatchObject({ found: false, path: 'HKNA/com.probe.app/agent' });

    const set = await call('nova:reg:set', { path: 'HKNA/com.probe.app/agent', value: 'probe/1.0' }, plainApp);
    expect(set.result).toMatchObject({ success: true, type: 'REG_SZ' });

    const hit = await call('nova:reg:get', { path: 'HKNA/com.probe.app/agent' }, plainApp);
    expect(hit.result).toMatchObject({ found: true, data: 'probe/1.0' });
    // Explicit (default) segment addresses the same value; the child is intact.
    const explicit = await call('nova:reg:get', { path: 'HKNA/com.probe.app/agent/(default)' }, plainApp);
    expect(explicit.result).toMatchObject({ found: true, data: 'probe/1.0' });
    const child = await call('nova:reg:get', { path: 'HKNA/com.probe.app/agent/version' }, plainApp);
    expect(child.result).toMatchObject({ found: true, data: 1 });
  });

  it('enforces per-key ACLs on bridge reads and writes', async () => {
    grants.add('registry.read');
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/gated/value', 'secret');

    // No ACL → normal behavior.
    const open = await call('nova:reg:get', { path: 'HKNA/com.probe.app/gated/value' }, plainApp);
    expect(open.result.found).toBe(true);

    // An ACL on the parent key that does not list this app → both denied.
    NovaRegistry.setAcl('HKNA/com.probe.app/gated', { entries: [{ id: 'com.other.app', rights: ['read', 'write'] }] });
    const readDenied = await call('nova:reg:get', { path: 'HKNA/com.probe.app/gated/value' }, plainApp);
    expect(code(readDenied)).toBe('PERMISSION_DENIED');
    expect(readDenied.error.message).toMatch(/ACL denies read/);

    const writeDenied = await call('nova:reg:set', { path: 'HKNA/com.probe.app/gated/value', value: 'x' }, plainApp);
    expect(code(writeDenied)).toBe('PERMISSION_DENIED');
    expect(writeDenied.error.message).toMatch(/ACL denies write/);

    // Wildcard read grant opens reads again, writes stay closed.
    NovaRegistry.setAcl('HKNA/com.probe.app/gated', { entries: [
      { id: '*', rights: ['read'] },
      { id: 'com.probe.app', rights: ['write'] },
    ] });
    const readOk = await call('nova:reg:get', { path: 'HKNA/com.probe.app/gated/value' }, plainApp);
    expect(readOk.result.found).toBe(true);
    const writeOk = await call('nova:reg:set', { path: 'HKNA/com.probe.app/gated/value', value: 'mine' }, plainApp);
    expect(writeOk.result.success).toBe(true);
    // registry.system bypasses ACLs entirely.
    grants.add('registry.system');
    const systemWrite = await call('nova:reg:set', { path: 'HKNA/com.other.app/gated/value', value: 'sys' }, plainApp);
    expect(systemWrite.result.success).toBe(true);
  });

  it('lets a manifest registryScopes.write prefix unlock designated HKNU keys', async () => {
    grants.add('registry.write');
    const scopedApp = { id: 'com.probe.app', system: false, registryScopes: { write: ['HKNU/shell/notifications'] } };

    const denied = await call('nova:reg:set', { path: 'HKNU/shell/notifications/banners', value: true, type: 'REG_BOOL' }, plainApp);
    expect(code(denied)).toBe('PERMISSION_DENIED');

    const allowed = await call('nova:reg:set', { path: 'HKNU/shell/notifications/banners', value: true, type: 'REG_BOOL' }, scopedApp);
    expect(allowed.result.success).toBe(true);
    expect(NovaRegistry.get('HKNU/shell/notifications/banners')).toBe(true);

    // The scope prefix bounds the grant: siblings outside it stay denied.
    const outside = await call('nova:reg:set', { path: 'HKNU/desktop/pins', value: ['x'] }, scopedApp);
    expect(code(outside)).toBe('PERMISSION_DENIED');

    // Scopes never unlock the system hive.
    const hkns = await call('nova:reg:set', { path: 'HKNS/shell/theme', value: 'nord' }, { ...scopedApp, registryScopes: { write: ['HKNS/shell'] } });
    expect(code(hkns)).toBe('PERMISSION_DENIED');
  });

  it('records the calling app id as the audit actor', async () => {
    grants.add('registry.write');
    NovaRegistry.set('HKNA/com.probe.app/audit-anchor', 'before');
    await call('nova:reg:set', { path: 'HKNA/com.probe.app/audit-anchor', value: 'after' }, plainApp);
    const entry = NovaRegistry.audit(1)[0];
    expect(entry).toMatchObject({ actor: 'com.probe.app', action: 'set', path: 'HKNA/com.probe.app/audit-anchor', before: 'before', after: 'after' });
  });

  // Third-party default: a manifest with no registryScopes field gets ONE
  // built-in write scope — HKNU/software/<appId> — while every explicit
  // declaration (even empty) opts out entirely.
  describe('registryScopes defaults for scope-less manifests', () => {
    it('gives a scope-less manifest write access to its own HKNU/software slice', async () => {
      grants.add('registry.write');
      // plainApp = { id: 'com.probe.app', system: false } — no registryScopes.
      const own = await call('nova:reg:set', { path: 'HKNU/software/com.probe.app/theme', value: 'nord' }, plainApp);
      expect(own.result.success).toBe(true);
      expect(NovaRegistry.get('HKNU/software/com.probe.app/theme')).toBe('nord');

      // Subkeys ride the same prefix.
      const deep = await call('nova:reg:set', { path: 'HKNU/software/com.probe.app/window/size', value: { w: 800, h: 600 }, type: 'REG_JSON' }, plainApp);
      expect(deep.result.success).toBe(true);
    });

    it('bounds the default to the app slice — siblings, user keys and other apps stay denied', async () => {
      grants.add('registry.write');
      const foreign = await call('nova:reg:set', { path: 'HKNU/software/com.other.app/theme', value: 'x' }, plainApp);
      expect(code(foreign)).toBe('PERMISSION_DENIED');

      const software = await call('nova:reg:set', { path: 'HKNU/software/shared', value: 'x' }, plainApp);
      expect(code(software)).toBe('PERMISSION_DENIED');

      const pins = await call('nova:reg:set', { path: 'HKNU/desktop/pins', value: ['x'] }, plainApp);
      expect(code(pins)).toBe('PERMISSION_DENIED');
    });

    it('lets a manifest opt out by declaring registryScopes (even empty)', async () => {
      grants.add('registry.write');
      const optedOut = { id: 'com.probe.app', system: false, registryScopes: {} };
      const denied = await call('nova:reg:set', { path: 'HKNU/software/com.probe.app/theme', value: 'nord' }, optedOut);
      expect(code(denied)).toBe('PERMISSION_DENIED');
      expect(NovaRegistry.get('HKNU/software/com.probe.app/theme')).toBe(undefined);
    });

    it('replaces the default with declared scopes — no silent merge', async () => {
      grants.add('registry.write');
      const declared = { id: 'com.probe.app', system: false, registryScopes: { write: ['HKNU/shell/notifications'] } };

      const designated = await call('nova:reg:set', { path: 'HKNU/shell/notifications/banners', value: true, type: 'REG_BOOL' }, declared);
      expect(designated.result.success).toBe(true);

      // The own-software slice is no longer granted once scopes are declared.
      const own = await call('nova:reg:set', { path: 'HKNU/software/com.probe.app/theme', value: 'nord' }, declared);
      expect(code(own)).toBe('PERMISSION_DENIED');
    });

    it('never grants the default to system apps or without registry.write', async () => {
      const sysApp = { id: 'com.astroos.shell', system: true };
      const sys = await call('nova:reg:set', { path: 'HKNU/software/com.astroos.shell/theme', value: 'nord' }, sysApp);
      expect(code(sys)).toBe('PERMISSION_DENIED');

      const noGrant = await call('nova:reg:set', { path: 'HKNU/software/com.probe.app/theme', value: 'nord' }, plainApp);
      expect(code(noGrant)).toBe('PERMISSION_DENIED');
      expect(NovaRegistry.get('HKNU/software/com.probe.app/theme')).toBe(undefined);
    });
  });
});
