import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// ── Mock globals for registry ─────────────────────────────────────────────
const mockOS = {
  apps: {},
  openUrl: undefined,
  openMailto: undefined,
  settings: { get: vi.fn(() => false) },
  events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
};
globalThis.OS = mockOS;
globalThis.window = globalThis;

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: vi.fn((tag) => ({
      tagName: tag.toUpperCase(),
      style: {},
      setAttribute: vi.fn(),
      getAttribute: vi.fn(),
      removeAttribute: vi.fn(),
      appendChild: vi.fn(),
      removeChild: vi.fn(),
      addEventListener: vi.fn(),
      textContent: '',
      innerHTML: '',
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), contains: vi.fn(() => false) },
      dataset: {},
      children: [],
      parentNode: null,
      closest: vi.fn((sel) => {
        if (sel === 'a[href]') return null;
        return null;
      }),
    })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 'complete',
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    body: { appendChild: vi.fn() },
    documentElement: { style: {}, classList: {} },
  };
}

// APP_REGISTRY is used by registry.js (not app-registry.js)
if (!Array.isArray(window.APP_REGISTRY)) {
  window.APP_REGISTRY = [];
}

describe('AppRegistry (js/platform/core/app-registry.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    mockOS.apps = {};
  });

  it('registers an app and populates OS.apps', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const config = { id: 'test-app', name: 'Test', icon: 'box', version: '1.0.0', entry: 'index.html' };
    const result = mod.registerApp(config);
    expect(result).toBeDefined();
    expect(result.id).toBe('test-app');
    expect(result.name).toBe('Test');
    expect(mockOS.apps['test-app']).toBeDefined();
    expect(mockOS.apps['test-app'].name).toBe('Test');
  });

  it('registers system services internally without exposing them as apps', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const service = {
      id: 'com.astroos.service.hidden',
      name: 'Hidden service',
      system: true,
      verified: true,
      signer: 'Astro System',
      source: 'system-bundle',
      manifest: { system: true, systemService: true },
    };

    const registered = mod.registerSystemService(service);

    expect(registered.headlessSystemService).toBe(true);
    expect(mod.getApp(service.id)).toBe(registered);
    expect(mod.isRegistered(service.id)).toBe(true);
    expect(mod.isInstalled(service.id)).toBe(true);
    expect(mod.getAllApps()).toContain(registered);
    expect(mod.getAppsByCategory('system-service')).toContain(registered);
    expect(mockOS.apps[service.id]).toBeUndefined();
    expect(window.APP_REGISTRY.some(app => app.id === service.id)).toBe(false);
    expect(() => mod.registerApp({ id: service.id, name: 'Imposter' })).toThrow(/reserved for a system service/);
  });

  it('rejects system service registration without trusted system provenance', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');

    expect(() => mod.registerSystemService({
      id: 'com.example.untrusted',
      name: 'Untrusted service',
      system: true,
      verified: false,
      signer: 'Unknown',
      manifest: { system: true, systemService: true },
    })).toThrow(/verified Astro System package/);
  });

  it('fills default fields when omitted', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const result = mod.registerApp({ id: 'minimal', name: 'Minimal' });
    expect(result.version).toBe('1.0.0');
    expect(result.type).toBe('webapp');
    expect(result.permissions).toEqual([]);
    expect(result.defaultSize).toEqual([800, 600]);
  });

  it('returns existing app without re-registering', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({ id: 'dup', name: 'First' });
    const second = mod.registerApp({ id: 'dup', name: 'Second' });
    expect(second.name).toBe('First');
  });

  it('throws when id or name is missing', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    expect(() => mod.registerApp({})).toThrow('[AppRegistry] App must have id and name');
    expect(() => mod.registerApp({ id: 'x' })).toThrow('[AppRegistry] App must have id and name');
  });

  it('rejects reserved IDs unless verified is true', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    expect(() => mod.registerApp({ id: 'com.astroos.settings', name: 'Settings' })).toThrow(/reserved/);
    const result = mod.registerApp({ id: 'com.astroos.settings', name: 'Settings', verified: true });
    expect(result.id).toBe('com.astroos.settings');
  });

  it('strips unknown permissions with a warning', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod.registerApp({ id: 'perm-test', name: 'PT', permissions: ['fs:read:images', 'evil:inject'] });
    expect(spy).toHaveBeenCalled();
    const app = mod.getApp('perm-test');
    expect(app.permissions).not.toContain('evil:inject');
    expect(app.permissions).toContain('fs:read:images');
    spy.mockRestore();
  });

  // Legacy vfs-era manifests: the old broad filesystem permission names are
  // translated to their fs-era equivalents BEFORE the unknown-permission
  // strip, so an old .novaapp registers with exactly the grants a modern
  // manifest would carry instead of being silently under-granted. See
  // LEGACY_PERMISSION_ALIASES in app-registry.js for the mapping rationale.
  describe('legacy vfs permission translation', () => {
    it('translates all five legacy vfs permission names', () => {
      vi.resetModules();
      const mod = require('../../../js/platform/core/app-registry.js');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mod.registerApp({
        id: 'vfs-manifest',
        name: 'VFS manifest',
        permissions: ['vfs:access', 'vfs:read', 'vfs:write', 'vfs:delete', 'vfs:metadata'],
      });
      const app = mod.getApp('vfs-manifest');
      // Broad verbs collapse onto fs:access; metadata onto fs:metadata.
      expect(app.permissions).toEqual(['fs:access', 'fs:metadata']);
      // Nothing legacy survives the strip.
      for (const legacy of ['vfs:access', 'vfs:read', 'vfs:write', 'vfs:delete', 'vfs:metadata']) {
        expect(app.permissions).not.toContain(legacy);
      }
      spy.mockRestore();
    });

    it('strips the vfs:metedata typo as unknown and keeps modern names untouched', () => {
      vi.resetModules();
      const mod = require('../../../js/platform/core/app-registry.js');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mod.registerApp({
        id: 'vfs-typo',
        name: 'VFS typo',
        permissions: ['vfs:metedata', 'fs:read:images', 'net:external'],
      });
      const app = mod.getApp('vfs-typo');
      // The vfs:metedata permission alias was removed (it was typo
      // insurance, not a historical spelling — see the LEGACY_PERMISSION_
      // ALIASES rationale): the unknown-permission strip now drops it
      // instead of silently translating it into fs:metadata. The legacy
      // nova:vfs:* / vfs:metedata IPC channel alias in app-sandbox.js is
      // separate and still resolves.
      expect(app.permissions).not.toContain('fs:metadata');
      expect(app.permissions).not.toContain('vfs:metedata');
      expect(app.permissions).toEqual(['fs:read:images', 'net:external']);
      spy.mockRestore();
    });

    it('translates optionalPermissions as well', () => {
      vi.resetModules();
      const mod = require('../../../js/platform/core/app-registry.js');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mod.registerApp({
        id: 'vfs-optional',
        name: 'VFS optional',
        permissions: [],
        optionalPermissions: ['vfs:read', 'vfs:metadata'],
      });
      const app = mod.getApp('vfs-optional');
      expect(app.optionalPermissions).toEqual(['fs:access', 'fs:metadata']);
      spy.mockRestore();
    });

    it('does not dedupe or reorder manifests without legacy names', () => {
      vi.resetModules();
      const mod = require('../../../js/platform/core/app-registry.js');
      mod.registerApp({
        id: 'modern-manifest',
        name: 'Modern manifest',
        permissions: ['net:external', 'net:external', 'fs:access'],
      });
      const app = mod.getApp('modern-manifest');
      expect(app.permissions).toEqual(['net:external', 'net:external', 'fs:access']);
    });

    it('leaves genuinely unknown permissions subject to the strip', () => {
      vi.resetModules();
      const mod = require('../../../js/platform/core/app-registry.js');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mod.registerApp({
        id: 'vfs-mixed',
        name: 'VFS mixed',
        permissions: ['vfs:read', 'evil:inject'],
      });
      const app = mod.getApp('vfs-mixed');
      expect(app.permissions).toEqual(['fs:access']);
      expect(app.permissions).not.toContain('evil:inject');
      spy.mockRestore();
    });
  });

  it('accepts the scoped filesystem and app-launch permissions', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({
      id: 'capability-test',
      name: 'Capability test',
      permissions: ['fs:access', 'system:app-launch', 'apps:communicate'],
    });
    expect(mod.getApp('capability-test').permissions).toEqual(['fs:access', 'system:app-launch', 'apps:communicate']);
  });

  it('preserves root permission declarations for System-signed packages, drops them for unverified restores', () => {
    // 2026-11-12 audit (finding M1): the persisted manifest is
    // package-controlled data, so its system:root declaration is only
    // authoritative for records that carry the System signer triple.
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({
      id: 'root-package',
      name: 'Root package',
      permissions: ['system:root'],
      manifest: { permissions: ['system:root'] },
    });
    expect(mod.getApp('root-package').permissions).toContain('system:root');

    // A System-signed record keeps its root declaration across a restore.
    resetTestStorage();
    localStorage.setItem('nova_registry_meta', JSON.stringify([{
      id: 'restored-system-root',
      name: 'System root package',
      permissions: [],
      manifest: { permissions: ['system:root'], system: true },
      verified: true,
      signer: 'Astro System',
      source: 'file',
    }]));
    vi.resetModules();
    const restored = require('../../../js/platform/core/app-registry.js');
    restored.initialize();
    expect(restored.getApp('restored-system-root').permissions).toContain('system:root');
    expect(restored.getApp('restored-system-root').system).toBe(true);

    // An UNVERIFIED record must NOT get its manifest-asserted root class
    // permission back for free — it re-consents through the dialog (with
    // the UNVERIFIED PUBLISHER banner) at next launch instead.
    resetTestStorage();
    localStorage.setItem('nova_registry_meta', JSON.stringify([{
      id: 'restored-unverified-root',
      name: 'Unverified root package',
      permissions: [],
      manifest: { permissions: ['system:root'] },
      source: 'file',
    }]));
    vi.resetModules();
    const restored2 = require('../../../js/platform/core/app-registry.js');
    restored2.initialize();
    expect(restored2.getApp('restored-unverified-root').permissions).not.toContain('system:root');
  });

  it('unregisters an app and cleans up OS.apps', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({ id: 'to-remove', name: 'Remove' });
    expect(mod.unregisterApp('to-remove')).toBe(true);
    expect(mod.getApp('to-remove')).toBeNull();
    expect(mockOS.apps['to-remove']).toBeUndefined();
    expect(mod.unregisterApp('to-remove')).toBe(false);
  });

  it('uninstalls package storage and removes the persisted runtime registry entry', async () => {
    vi.resetModules();
    const removeApp = vi.fn(async () => true);
    globalThis.NovaAppPackageStore = { removeApp };
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({ id: 'persistent-remove', name: 'Persistent Remove', source: 'package' });

    await expect(mod.uninstallApp('persistent-remove')).resolves.toBe(true);

    expect(removeApp).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'persistent-remove' }),
      { force: false }
    );
    expect(mod.getApp('persistent-remove')).toBeNull();
    expect(mockOS.apps['persistent-remove']).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('nova_registry_meta')))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'persistent-remove' })]));
    delete globalThis.NovaAppPackageStore;
  });

  it('fires onInstall and onUninstall hooks', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const installed = [];
    const uninstalled = [];
    mod.onInstall((app) => installed.push(app.id));
    mod.onUninstall((app) => uninstalled.push(app.id));
    mod.registerApp({ id: 'hook-app', name: 'Hook' });
    expect(installed).toContain('hook-app');
    mod.unregisterApp('hook-app');
    expect(uninstalled).toContain('hook-app');
  });

  it('getStats returns correct counts', () => {
    vi.resetModules();
    localStorage.clear();
    const mod = require('../../../js/platform/core/app-registry.js');
    for (const app of mod.getAllApps()) {
      if (app.systemService) mod.unregisterSystemService(app.id);
      else mod.unregisterApp(app.id);
    }
    mod.registerApp({ id: 'a1', name: 'A1', categories: ['productivity'] });
    mod.registerApp({ id: 'a2', name: 'A2', categories: ['productivity', 'social'] });
    const stats = mod.getStats();
    expect(stats.totalApps).toBe(2);
    expect(stats.byCategory.productivity).toBe(2);
    expect(stats.totalLaunches).toBe(0);
  });

  it('checkPermissions returns true when APM is absent', () => {
    const prev = globalThis.AppPermissionManager;
    globalThis.AppPermissionManager = undefined;
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    const app = mod.registerApp({ id: 'cp-app', name: 'CPA', permissions: ['fs:read:images'] });
    expect(mod.checkPermissions(app)).toBe(true);
    globalThis.AppPermissionManager = prev;
  });

  it('auto-grants low-risk permissions and prompts only for required sensitive permissions', async () => {
    vi.resetModules();
    const previousManager = globalThis.AppPermissionManager;
    const previousSandbox = globalThis.AppSandbox;
    const granted = new Set();
    const requestAll = vi.fn(async (permissions) => {
      permissions.forEach(permission => granted.add(permission));
      return true;
    });
    globalThis.AppPermissionManager = {
      PERMISSION_CATEGORIES: {
        'device:notifications': { risk: 'low' },
        'fs:read:images': { risk: 'medium' },
        'fs:access': { risk: 'critical', specialAccess: true },
        'contacts:read': { risk: 'medium' },
      },
      isGranted: permission => granted.has(permission),
      isDenied: () => false,
      autoGrantLowRisk: vi.fn(async permission => {
        if (permission === 'device:notifications') granted.add(permission);
        return permission === 'device:notifications';
      }),
      requestAll,
      recordAppUse: vi.fn(),
    };
    globalThis.AppSandbox = { launch: vi.fn(async () => ({ launched: true })) };

    try {
      const mod = require('../../../js/platform/core/app-registry.js');
      mod.registerApp({
        id: 'permission-policy-app',
        name: 'Permission Policy',
        permissions: ['device:notifications', 'fs:read:images', 'fs:access'],
        optionalPermissions: ['contacts:read'],
      });

      await mod.launchApp('permission-policy-app', {}, {}, {});

      expect(globalThis.AppPermissionManager.autoGrantLowRisk)
        .toHaveBeenCalledWith('device:notifications', 'permission-policy-app');
      expect(requestAll).toHaveBeenCalledWith(['fs:read:images'], 'permission-policy-app', 'Permission Policy');
    } finally {
      globalThis.AppPermissionManager = previousManager;
      globalThis.AppSandbox = previousSandbox;
    }
  });

  it('updateApp patches fields on an installed app', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({ id: 'patch-me', name: 'Patch' });
    expect(mod.updateApp('patch-me', { version: '2.0.0' })).toBe(true);
    expect(mod.getApp('patch-me').version).toBe('2.0.0');
    expect(mod.updateApp('nonexistent', {})).toBe(false);
  });

  it('getAppsByCategory filters correctly', () => {
    vi.resetModules();
    const mod = require('../../../js/platform/core/app-registry.js');
    mod.registerApp({ id: 'cat1', name: 'C1', categories: ['dev'] });
    mod.registerApp({ id: 'cat2', name: 'C2', categories: ['social'] });
    const devApps = mod.getAppsByCategory('dev');
    expect(devApps).toHaveLength(1);
    expect(devApps[0].id).toBe('cat1');
  });
});

describe('registry.js — OS.openUrl, OS.openMailto, and WebAppManager', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    mockOS.apps = {};
    window.APP_REGISTRY = [];
  });

  it('registerApp adds to OS.apps and APP_REGISTRY', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    const cfg = { id: 'web-app', name: 'Web App', url: 'https://example.com' };
    if (typeof globalThis.registerApp === 'function') {
      globalThis.registerApp(cfg);
    }
    expect(mockOS.apps['web-app']).toEqual(cfg);
    expect(window.APP_REGISTRY).toContain(cfg);
  });

  it('OS.openUrl routes http/https links through the selected OS default app', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn(() => ({ id: 'win1' }));
    globalThis.WM = { createWindow };
    globalThis.nw = undefined;
    globalThis.DefaultApps = {
      resolveHandler: vi.fn((query, fallback) => {
        expect(query).toEqual({ protocol: 'https' });
        expect(fallback).toBe('com.astroos.browser');
        return 'com.example.my-browser';
      }),
    };
    mockOS.openUrl('https://example.com/page');
    expect(DefaultApps.resolveHandler).toHaveBeenCalledOnce();
    expect(createWindow).toHaveBeenCalledWith('com.example.my-browser', { url: 'https://example.com/page' });
  });

  it('OS.openUrl falls back to the built-in Browser when no resolver is present', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn(() => ({ id: 'win1' }));
    globalThis.WM = { createWindow };
    globalThis.DefaultApps = undefined;
    mockOS.openUrl('http://example.com/page');
    expect(createWindow).toHaveBeenCalledWith('com.astroos.browser', { url: 'http://example.com/page' });
  });

  it('OS.openUrl blocks javascript: and data: URLs', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn();
    globalThis.WM = { createWindow };
    globalThis.DefaultApps = { resolveHandler: vi.fn() };
    mockOS.openUrl('javascript:alert(1)');
    mockOS.openUrl('data:text/html,<script>alert(1)</script>');
    expect(createWindow).not.toHaveBeenCalled();
    expect(DefaultApps.resolveHandler).not.toHaveBeenCalled();
  });

  it('OS.openMailto parses a full mailto URI', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn(() => ({ id: 'win1' }));
    globalThis.WM = { createWindow };
    mockOS.openMailto('mailto:alice@example.com?subject=Hello&body=World&cc=bob@example.com&bcc=carol@example.com');
    expect(createWindow).toHaveBeenCalledWith('com.astroos.email', {
      compose: {
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'World',
        cc: 'bob@example.com',
        bcc: 'carol@example.com',
      },
    });
  });

  it('OS.openMailto handles a bare address', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn(() => ({ id: 'win1' }));
    globalThis.WM = { createWindow };
    mockOS.openMailto('mailto:alice@example.com');
    expect(createWindow).toHaveBeenCalledWith('com.astroos.email', {
      compose: { to: 'alice@example.com', subject: '', body: '', cc: '', bcc: '' },
    });
  });

  it('OS.openMailto ignores empty URLs', () => {
    vi.resetModules();
    require('../../../js/apps/registry/service.js');
    const createWindow = vi.fn();
    globalThis.WM = { createWindow };
    mockOS.openMailto('');
    mockOS.openMailto(null);
    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe('WebAppManager (js/apps/registry/service.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    vi.resetModules();
    localStorage.removeItem('nova_webapps');
  });

  it('addApp persists to localStorage and returns an app object', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    const app = window.WebAppManager.addApp({ name: 'Test WA', url: 'https://wa.test' });
    expect(app.id).toBeDefined();
    expect(app.name).toBe('Test WA');
    expect(app.url).toBe('https://wa.test');
    expect(app.launchCount).toBe(0);
    const stored = JSON.parse(localStorage.getItem('nova_webapps'));
    expect(stored.some(a => a.id === app.id)).toBe(true);
  });

  it('getApp retrieves by id', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    const created = window.WebAppManager.addApp({ name: 'Find Me', url: 'https://find.me' });
    const found = window.WebAppManager.getApp(created.id);
    expect(found).not.toBeNull();
    expect(found.name).toBe('Find Me');
  });

  it('getApp returns null for missing id', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    expect(window.WebAppManager.getApp('does-not-exist')).toBeNull();
  });

  it('removeApp deletes the app from storage', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    const created = window.WebAppManager.addApp({ name: 'Delete Me', url: 'https://del.me' });
    window.WebAppManager.removeApp(created.id);
    expect(window.WebAppManager.getApp(created.id)).toBeNull();
  });

  it('launchApp increments launchCount and updates lastUsed', () => {
    vi.resetModules();
    const mod = require('../../../js/apps/registry/service.js');
    const created = window.WebAppManager.addApp({ name: 'Launch Me', url: 'https://launch.me' });
    window.WebAppManager.launchApp(created.id);
    const updated = window.WebAppManager.getApp(created.id);
    expect(updated.launchCount).toBe(1);
    expect(updated.lastUsed).toBeDefined();
  });
});
describe('AppRegistry — permissionReasons normalization', () => {
  it('keeps known, declared reasons on the app record', () => {
    const mod = require('../../../js/platform/core/app-registry.js');
    const app = mod.registerApp({
      id: 'reasons-app',
      name: 'Reasons',
      permissions: ['system:root', 'net:external'],
      permissionReasons: {
        'system:root': 'Needed to manage system services.',
        'net:external': 'Calls the app\u2019s own API.',
      },
    });
    expect(app.permissionReasons).toEqual({
      'system:root': 'Needed to manage system services.',
      'net:external': 'Calls the app\u2019s own API.',
    });
  });

  it('translates legacy vfs:* keys to their fs:* equivalents', () => {
    const mod = require('../../../js/platform/core/app-registry.js');
    const app = mod.registerApp({
      id: 'legacy-reasons',
      name: 'Legacy',
      permissions: ['fs:access'],
      permissionReasons: { 'vfs:read': 'Opens files the user picks.' },
    });
    expect(app.permissionReasons).toEqual({ 'fs:access': 'Opens files the user picks.' });
  });

  it('strips unknown keys and unusable values, keeping the valid rest', () => {
    const mod = require('../../../js/platform/core/app-registry.js');
    const app = mod.registerApp({
      id: 'mixed-reasons',
      name: 'Mixed',
      permissions: ['net:external', 'device:camera'],
      permissionReasons: {
        'net:external': 'Calls its API.',
        'bogus:permission': 'Unknown key.',
        'device:camera': 42,
        'device:microphone': '   ',
      },
    });
    expect(app.permissionReasons).toEqual({ 'net:external': 'Calls its API.' });
  });

  it('truncates oversized reasons to the 500-character display cap', () => {
    const mod = require('../../../js/platform/core/app-registry.js');
    const app = mod.registerApp({
      id: 'long-reason',
      name: 'Long',
      permissions: ['net:external'],
      permissionReasons: { 'net:external': 'x'.repeat(600) },
    });
    expect(app.permissionReasons['net:external']).toHaveLength(500);
  });

  it('drops the field entirely when nothing valid survives or the shape is wrong', () => {
    const mod = require('../../../js/platform/core/app-registry.js');
    const empty = mod.registerApp({
      id: 'empty-reasons',
      name: 'Empty',
      permissions: ['net:external'],
      permissionReasons: { 'net:external': '   ' },
    });
    expect(empty.permissionReasons).toBeUndefined();

    const malformed = mod.registerApp({
      id: 'bad-shape-reasons',
      name: 'BadShape',
      permissionReasons: 'not a map',
    });
    expect(malformed.permissionReasons).toBeUndefined();
  });
});
