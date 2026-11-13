import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initApp, loadWindowApp } from '../helpers/app-harness.js';

const installerSource = readFileSync(
  new URL('../../js/apps/install-astroos/app.js', import.meta.url),
  'utf8',
);

function registerInstallerForCommandLine(commandLine) {
  const registeredApps = [];
  const context = vm.createContext({
    window: { __novaUnrestrictedPackage: { files: {} } },
    process: { platform: 'linux' },
    console: { error: vi.fn() },
    require(name) {
      if (name === 'fs') {
        return { readFileSync: () => commandLine };
      }
      throw new Error(`Unexpected module during registration: ${name}`);
    },
    registerApp(app) {
      registeredApps.push(app);
    }
  });

  vm.runInContext(installerSource, context);
  return { registeredApps };
}

async function removeInstallerFromSession() {
  const registeredApps = [];
  const deletedFiles = [];
  const settingWrites = [];
  const shortcut = {
    id: 'installer-shortcut',
    name: 'Install AstroOS.lnk',
    mimeType: 'application/x-app-shortcut',
    content: JSON.stringify({ type: 'app-shortcut', target: 'com.astroos.install' })
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
      apps: { 'com.astroos.install': {} },
      windows: new Map(),
      settings: {
        get(key) {
          if (key === 'desktopIconPositions') return { 'file:installer-shortcut': { x: 1, y: 2 } };
          if (key === 'pinnedApps') return ['com.astroos.install', 'com.astroos.terminal'];
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

describe('AstroOS installer availability', () => {
  it('registers the installer on live and installed-root kernel command lines', () => {
    const { registeredApps } = registerInstallerForCommandLine('quiet boot=live');
    const installedRoot = registerInstallerForCommandLine('quiet root=PARTUUID=1234-01 rw');

    expect(registeredApps).toHaveLength(1);
    expect(registeredApps[0].id).toBe('com.astroos.install');
    expect(installedRoot.registeredApps).toHaveLength(1);
    expect(installedRoot.registeredApps[0].id).toBe('com.astroos.install');
  });

  it('uses a native disk dropdown and keeps confirmation controls responsive', async () => {
    const fs = {
      readdirSync: () => ['vda', 'sr0'],
      statSync: device => ({ isBlockDevice: () => device === '/dev/vda' }),
      readFileSync: path => path.endsWith('/size') ? '2097152' : 'AstroOS test disk',
    };
    const loaded = await loadWindowApp('install-astroos', {
      stubs: {
        extra: {
          process: { platform: 'linux' },
          require: name => {
            if (name === 'fs') return fs;
            throw new Error(`Unexpected module: ${name}`);
          },
        },
      },
    });
    const content = initApp(loaded.app, { window: loaded.window });
    const select = content.querySelector('select[aria-label="Installation disk"]');
    const continueButton = [...content.querySelectorAll('button')]
      .find(button => button.textContent === 'Review disk');

    expect(select).toBeTruthy();
    expect(select.options).toHaveLength(2);
    expect(select.options[1].textContent).toContain('/dev/vda');
    expect(continueButton.disabled).toBe(true);

    select.value = '/dev/vda';
    select.dispatchEvent(new loaded.window.Event('change'));
    expect(continueButton.disabled).toBe(false);
    continueButton.click();

    const warning = [...content.querySelectorAll('div')]
      .find(element => element.textContent.includes('permanently erases every partition'));
    const footer = content.querySelector('.astroos-installer-footer');
    const backButton = [...footer.querySelectorAll('button')]
      .find(button => button.textContent === 'Back');
    const eraseButton = [...footer.querySelectorAll('button')]
      .find(button => button.textContent === 'Erase and install');

    expect(warning).toBeTruthy();
    expect(backButton).toBeTruthy();
    expect(eraseButton).toBeTruthy();
    expect(content.querySelector('.astroos-installer-body').style.overflowY).toBe('auto');
    expect(footer.style.flexWrap).toBe('wrap');
    expect(backButton.style.flex).toContain('150px');
    expect(eraseButton.style.flex).toContain('150px');
    expect(eraseButton.disabled).toBe(true);

    const confirmation = content.querySelector('input[aria-label="Type ERASE /dev/vda to confirm"]');
    confirmation.value = 'ERASE /dev/sda';
    confirmation.dispatchEvent(new loaded.window.Event('input'));
    expect(eraseButton.disabled).toBe(true);
    confirmation.value = 'ERASE /dev/vda';
    confirmation.dispatchEvent(new loaded.window.Event('input'));
    expect(eraseButton.disabled).toBe(false);
  });

  it('removes its desktop shortcut, taskbar pin, and runtime registrations after install', async () => {
    const { context, deletedFiles, settingWrites } = await removeInstallerFromSession();

    expect(deletedFiles).toEqual(['installer-shortcut']);
    expect(settingWrites).toContainEqual(['pinnedApps', ['com.astroos.terminal']]);
    expect(context.OS.apps['com.astroos.install']).toBeUndefined();
    expect(context.APP_REGISTRY).toHaveLength(0);
    expect(context.AppRegistry.unregisterApp).toHaveBeenCalledWith('com.astroos.install');
    expect(context.WM.updateTaskbar).toHaveBeenCalled();
  });
});
