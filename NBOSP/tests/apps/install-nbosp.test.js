import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const installerSource = readFileSync(
  new URL('../../js/apps/install-nbosp/app.js', import.meta.url),
  'utf8',
);

function registerInstallerForCommandLine(commandLine, readError) {
  const registeredApps = [];
  const logger = { error: vi.fn() };
  const context = vm.createContext({
    window: { __novaUnrestrictedPackage: { files: {} } },
    process: { platform: 'linux' },
    console: logger,
    require(name) {
      if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
      return {
        readFileSync() {
          if (readError) throw readError;
          return commandLine;
        }
      };
    },
    registerApp(app) {
      registeredApps.push(app);
    }
  });

  vm.runInContext(installerSource, context);
  return { registeredApps, logger };
}

async function removeInstallerFromSession() {
  const registeredApps = [{ id: 'com.nbosp.install' }];
  const deletedFiles = [];
  const settingWrites = [];
  const shortcut = {
    id: 'installer-shortcut',
    name: 'Install NovaByte.lnk',
    mimeType: 'application/x-app-shortcut',
    content: JSON.stringify({ type: 'app-shortcut', target: 'com.nbosp.install' })
  };
  const context = vm.createContext({
    window: { __novaUnrestrictedPackage: { files: {} } },
    process: { platform: 'linux' },
    console: { error: vi.fn() },
    require(name) {
      if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
      return { readFileSync: () => 'quiet root=PARTUUID=1234-01 rw' };
    },
    registerApp(app) {
      registeredApps.push(app);
    },
    FS: {
      specialFolders: { desktop: 'desktop-id' },
      listDir: () => [shortcut],
      permanentDelete: vi.fn(async id => deletedFiles.push(id))
    },
    OS: {
      apps: { 'com.nbosp.install': {} },
      windows: new Map(),
      settings: {
        get(key) {
          if (key === 'desktopIconPositions') return { 'file:installer-shortcut': { x: 1, y: 2 } };
          if (key === 'pinnedApps') return ['com.nbosp.install', 'com.nbosp.terminal'];
          return undefined;
        },
        set: (key, value) => settingWrites.push([key, value])
      }
    },
    APP_REGISTRY: registeredApps,
    AppRegistry: { unregisterApp: vi.fn() },
    WM: { updateTaskbar: vi.fn() },
    renderDesktopIcons: vi.fn(),
    renderLaunchpad: vi.fn()
  });

  const sourceWithExposedCleanup = installerSource.replace(
    /\}\)\(\);\s*$/,
    'window.removeInstallerFromSession = removeInstallerFromSession;\n})();',
  );
  expect(sourceWithExposedCleanup).not.toBe(installerSource);
  vm.runInContext(sourceWithExposedCleanup, context);
  await context.window.removeInstallerFromSession();
  return { context, deletedFiles, settingWrites };
}

describe('NBOSP installer availability', () => {
  it('registers the installer in the live ISO session', () => {
    const { registeredApps } = registerInstallerForCommandLine('quiet boot=live');

    expect(registeredApps).toHaveLength(1);
    expect(registeredApps[0].id).toBe('com.nbosp.install');
  });

  it('does not register the installer after booting from an installed root disk', () => {
    const { registeredApps } = registerInstallerForCommandLine('quiet root=PARTUUID=1234-01 rw');

    expect(registeredApps).toHaveLength(0);
  });

  it('logs a command-line detection error and leaves the installer available', () => {
    const { registeredApps, logger } = registerInstallerForCommandLine(
      '',
      new Error('proc unavailable'),
    );

    expect(registeredApps).toHaveLength(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it('removes its desktop shortcut, taskbar pin, and runtime registrations after install', async () => {
    const { context, deletedFiles, settingWrites } = await removeInstallerFromSession();

    expect(deletedFiles).toEqual(['installer-shortcut']);
    expect(settingWrites).toContainEqual(['pinnedApps', ['com.nbosp.terminal']]);
    expect(context.OS.apps['com.nbosp.install']).toBeUndefined();
    expect(context.APP_REGISTRY).toHaveLength(0);
    expect(context.AppRegistry.unregisterApp).toHaveBeenCalledWith('com.nbosp.install');
    expect(context.WM.updateTaskbar).toHaveBeenCalled();
  });
});
