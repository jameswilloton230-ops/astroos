import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const serviceSource = readFileSync(
  new URL('../../js/apps/astro-system/service.js', import.meta.url),
  'utf8'
);

function createSystem(hardwareContext = {}) {
  const cache = {
    theme: 'nova-dark',
    accentColor: '#58a6ff',
    devMode: false,
    rootAccessEnabled: false,
    pinnedApps: ['com.astroos.browser'],
    lockPin: 'credential-hash',
    pinSalt: 'credential-salt',
  };
  const emitted = [];
  const persisted = [];
  const settings = {
    _cache: cache,
    defaults: { theme: 'nova-dark', pinnedApps: [] },
    get(key) {
      return cache[key] ?? this.defaults[key];
    },
    set(key, value) {
      if ((key === 'wallpaperId' || key === 'customWallpaper') &&
          this.get('prohibitWallpaperChange') === true) return false;
      cache[key] = value;
      emitted.push({ key, value });
    },
  };
  const context = {
    OS: {
      settings,
      events: { emit: event => emitted.push(event) },
      workers: { fs: { call: vi.fn(async (...args) => persisted.push(args)) } },
      username: 'user',
      lockPin: null,
    },
    DebugOverlay: { enable: vi.fn(), disable: vi.fn() },
    console: { info: vi.fn() },
    process: hardwareContext.process,
    screen: hardwareContext.screen,
    NovaConnectivity: hardwareContext.connectivity,
    childProcess: hardwareContext.childProcess,
    require: vi.fn(moduleName => {
      if (moduleName === 'fs') return hardwareContext.fs;
      if (moduleName === 'os') return hardwareContext.os;
      if (moduleName === 'path') return { basename: value => value.split('/').pop() };
      if (moduleName === 'child_process') return hardwareContext.childProcess;
      return undefined;
    }),
  };
  context.window = context;
  runInNewContext(serviceSource, context);
  return { api: context.AstroOSSystem, context, cache, emitted, persisted };
}

describe('Astro System settings coordinator', () => {
  it('validates preference changes and delegates persistence and change events', () => {
    const { api, cache, emitted } = createSystem();

    expect(api.settings.set('theme', 'nord')).toBe(true);
    expect(cache.theme).toBe('nord');
    expect(emitted).toContainEqual({ key: 'theme', value: 'nord' });
    expect(api.settings.set('doNotDisturb', true)).toBe(true);
    expect(api.settings.get('doNotDisturb')).toBe(true);
    expect(api.settings.set('customWallpaperName', 'wallpaper.png')).toBe(true);
    expect(api.settings.get('customWallpaperName')).toBe('wallpaper.png');
    expect(api.settings.set('customWallpaperName', null)).toBe(true);
    expect(() => api.settings.set('doNotDisturb', 'true')).toThrow(/Invalid value/);
    expect(() => api.settings.set('customWallpaperName', '')).toThrow(/Invalid value/);
    expect(() => api.settings.set('theme', 'unknown')).toThrow(/Invalid value/);
    expect(() => api.settings.set('timezone', 'not/a-timezone')).toThrow(/Invalid value/);
    expect(() => api.settings.get('lockPin')).toThrow(/not readable/);

    cache.prohibitWallpaperChange = true;
    expect(api.settings.set('wallpaperId', 'stock-teal')).toBe(false);
    expect(cache.wallpaperId).toBeUndefined();
  });

  it('routes credentials and elevated toggles through dedicated operations', () => {
    const { api, context, cache } = createSystem();

    expect(() => api.developer.setRootAccess(true)).toThrow(/Developer Mode/);
    api.developer.setMode(true);
    expect(cache.devMode).toBe(true);
    expect(context.DebugOverlay.enable).toHaveBeenCalledOnce();
    api.developer.setRootAccess(true);
    expect(cache.rootAccessEnabled).toBe(true);
    api.security.setLockPin('new-credential-hash');
    expect(cache.lockPin).toBe('new-credential-hash');
    expect(context.OS.lockPin).toBe('new-credential-hash');
  });

  it('filters protected and invalid values during import and export', async () => {
    const { api, cache, persisted, emitted } = createSystem();

    const result = await api.settings.import({
      theme: 'dracula',
      pinnedApps: ['com.astroos.files'],
      devMode: true,
      rootAccessEnabled: true,
      lockPin: 'untrusted-hash',
      prohibitWallpaperChange: false,
      unknownSetting: 'ignored',
    });

    expect(result).toEqual({
      imported: ['theme', 'pinnedApps'],
      skipped: ['devMode', 'rootAccessEnabled', 'lockPin', 'prohibitWallpaperChange', 'unknownSetting'],
    });
    expect(cache.theme).toBe('dracula');
    expect(cache.pinnedApps).toEqual(['com.astroos.files']);
    // Import persists through storedSettings.set (registry-backed) — no
    // direct worker-store writes anymore.
    expect(persisted).toEqual([]);
    expect(emitted).toContainEqual({ key: 'theme', value: 'dracula' });
    expect(emitted).toContainEqual({ key: 'pinnedApps', value: ['com.astroos.files'] });
    expect(api.settings.exportSnapshot()).not.toHaveProperty('lockPin');
    expect(api.settings.exportSnapshot()).not.toHaveProperty('pinSalt');
  });

  it('reports VMware guest devices through Linux interfaces and delegates network controls', async () => {
    const files = new Map([
      ['/sys/class/dmi/id/sys_vendor', 'VMware, Inc.'],
      ['/sys/class/drm/card0/device/vendor', '0x15ad'],
      ['/sys/class/drm/card0/device/device', '0x0405'],
      ['/run/vmtoolsd.pid', '777'],
      ['/proc/777/comm', 'vmtoolsd'],
      ['/sys/class/net/eth0/operstate', 'up'],
      ['/proc/asound/cards', ' 0 [Audio          ]: HDA-Intel - VMware Audio'],
    ]);
    const fs = {
      readFileSync: vi.fn(filePath => {
        if (!files.has(filePath)) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        return files.get(filePath);
      }),
      readdirSync: vi.fn(directory => directory === '/sys/class/drm'
        ? ['card0', 'card0-Virtual-1']
        : directory === '/sys/class/net' ? ['lo', 'eth0'] : []),
      realpathSync: vi.fn(filePath => {
        if (filePath === '/sys/class/drm/card0/device/driver') return '/sys/bus/pci/drivers/vmwgfx';
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }),
      existsSync: vi.fn(filePath => filePath === '/usr/bin/vmtoolsd' ||
        filePath === '/usr/bin/vmware-checkvm'),
    };
    const connectivity = { getStatus: vi.fn(async () => ({ supported: true })) };
    const { api } = createSystem({
      fs,
      os: {
        cpus: () => [{ model: 'VMware Virtual CPU' }, { model: 'VMware Virtual CPU' }],
        totalmem: () => 8 * 1024 ** 3,
      },
      process: { platform: 'linux', arch: 'x64' },
      screen: { width: 1920, height: 1080 },
      connectivity,
    });

    const inventory = api.hardware.getInventory();
    expect(inventory.virtualization).toEqual({ detected: true, vendor: 'VMware' });
    expect(inventory.graphics).toEqual([{
      id: 'card0',
      driver: 'vmwgfx',
      vendorId: '0x15ad',
      deviceId: '0x0405',
      vendor: 'VMware',
    }]);
    expect(inventory.vmwareTools).toEqual({
      installed: true,
      running: true,
    });
    expect(inventory.network).toEqual([{
      name: 'eth0',
      type: 'ethernet-or-other',
      state: 'up',
      driver: null,
    }]);
    await expect(api.hardware.network.getStatus()).resolves.toEqual({ supported: true });
    expect(connectivity.getStatus).toHaveBeenCalledOnce();
  });

  it('reports inventory as unsupported outside Linux without inventing guest hardware', () => {
    const { api } = createSystem({
      process: { platform: 'win32' },
      fs: {},
      os: {},
    });

    expect(api.hardware.getInventory()).toEqual({
      supported: false,
      reason: 'Hardware inventory is currently available only in the AstroOS Linux guest.',
    });
  });

  it('routes fixed system power actions through the AstroOS power helper', async () => {
    const execFile = vi.fn((command, args, options, callback) => callback(null, '', ''));
    const { api } = createSystem({
      process: { platform: 'linux' },
      childProcess: { execFile },
    });

    await expect(api.hardware.power.restart()).resolves.toBe(true);
    await expect(api.hardware.power.powerOff()).resolves.toBe(true);
    expect(execFile).toHaveBeenNthCalledWith(
      1, '/usr/bin/astroos-power', ['restart'], { timeout: 15000 }, expect.any(Function)
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2, '/usr/bin/astroos-power', ['poweroff'], { timeout: 15000 }, expect.any(Function)
    );

    const unsupported = createSystem({ process: { platform: 'win32' } });
    await expect(unsupported.api.hardware.power.restart()).rejects.toThrow(/AstroOS Linux guest/);
  });

  it('returns empty device lists when optional Linux inventory files are absent', () => {
    const missingFile = () => {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    };
    const { api } = createSystem({
      fs: {
        readFileSync: missingFile,
        readdirSync: missingFile,
        realpathSync: missingFile,
        existsSync: () => false,
      },
      os: { cpus: () => [], totalmem: () => 0 },
      process: { platform: 'linux', arch: 'x64' },
      screen: { width: 800, height: 600 },
    });

    expect(api.hardware.getInventory()).toMatchObject({
      supported: true,
      virtualization: { detected: false, vendor: null },
      cpu: { model: null, logicalCores: 0 },
      memory: { totalBytes: 0 },
      graphics: [],
      network: [],
      audio: [],
      vmwareTools: { installed: false, running: false },
    });
  });
});
