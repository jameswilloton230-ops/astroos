// tests/apps/appmanager.test.js — window app: package panel, install flow with
// the untrusted-package dialog, disable/enable, search, onDrop routing, web apps.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const APPS_KEY = 'nova_installed_apps';
const LOG_KEY = 'nova_appmanager_log';

function makeOS() {
  return {
    apps: {},
    windows: new Map(),
    settings: { get: () => undefined, set: vi.fn() },
  };
}

// Full host environment appmanager's init expects (registry, Notify, WM, …).
// setInterval is stubbed because init() installs a 2s registry-poll timer.
async function loadAppManager({ seedApps = [] } = {}) {
  const showModal = vi.fn(() => Promise.resolve(undefined));
  const loaded = await loadWindowApp('appmanager', {
    stubs: {
      extra: {
        OS: makeOS(),
        APP_REGISTRY: [],
        Notify: { show: vi.fn() },
        WM: { createWindow: vi.fn(), closeWindow: vi.fn(), updateTaskbar: vi.fn() },
        showModal,
        setInterval: () => 0,
      },
    },
  });
  const { app, window } = loaded;
  if (seedApps.length) window.localStorage.setItem(APPS_KEY, JSON.stringify(seedApps));
  const content = initApp(app, { window });
  await settle(); // init() is async: the UI is built after `await getStoredApps()`
  return { ...loaded, Notify: window.Notify, WM: window.WM, showModal, content };
}

function listRows(content) {
  // Sidebar rows: clickable divs with a 34px icon box, inside the packages panel.
  // AstroOS: icons render as Material Symbols tiles (span.material-symbols-rounded)
  // instead of icons8 <img> tags, so match those too.
  return [...content.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer' && d.querySelector('img, .material-symbols-rounded, [style*="width: 34px"]'));
}

describe('App Manager app (js/apps/appmanager)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('appmanager');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.appmanager');
    expect(app.name).toBe('App Manager');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('package');
    expect(app.description).toContain('.novaapp packages');
    expect(app.defaultSize).toEqual([980, 640]);
    expect(app.minSize).toEqual([720, 480]);
    expect(typeof app.onDrop).toBe('function');
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('appmanager', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    await settle();
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.appmanager');
    expect(content.querySelector('[data-tab="packages"]')).toBeNull();
  });

  it('renders the Apps/Web Apps tab bar and the packages panel with an install drop zone', async () => {
    const { content } = await loadAppManager();
    const tabs = [...content.querySelectorAll('[data-tab]')];
    expect(tabs.map((t) => t.dataset.tab)).toEqual(['packages', 'webapps']);
    expect(tabs[0].textContent).toContain('Apps');
    expect(tabs[1].textContent).toContain('Web Apps');
    // Packages panel: search + install + show-hidden + empty detail drop zone
    expect(content.querySelector('#app-installer-search-input')).toBeTruthy();
    expect(content.querySelector('#app-manager-show-hidden')).toBeTruthy();
    const labels = [...content.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toContain('Show hidden apps');
    expect(content.textContent).toContain('Install a .novaapp Package');
    expect(content.textContent).toContain('Drop a');
    // With "Show hidden apps" off and nothing installed, the list offers the hint
    expect(content.textContent).toContain('Enable');
    expect(content.textContent).toContain('Show hidden apps');
  });

  it('lists installed packages sorted by name and shows a detail view on click', async () => {
    const { content, window } = await loadAppManager({
      seedApps: [
        { id: 'com.zeta.app', name: 'Zeta Tool', version: '2.0.0', author: 'Zed', source: 'file' },
        { id: 'com.alpha.app', name: 'Alpha App', version: '1.2.3', author: 'Ann', verified: true, source: 'file' },
      ],
    });
    const rows = listRows(content);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Alpha App'); // alphabetical
    expect(rows[0].textContent).toContain('v1.2.3');
    expect(rows[0].textContent).toContain('✓ Verified'); // verified badge

    rows[0].click();
    // Detail header: name, version, author + action buttons
    expect(content.textContent).toContain('Alpha App');
    expect(content.textContent).toContain('v1.2.3 · Ann');
    const buttons = [...content.querySelectorAll('button')].map((b) => b.textContent.trim());
    expect(buttons.some((t) => t.includes('Launch'))).toBe(true);
    expect(buttons.some((t) => t.includes('Uninstall'))).toBe(true);
    expect(buttons.some((t) => t.includes('Permissions'))).toBe(true);
    expect(buttons.some((t) => t.includes('App Info'))).toBe(true);
    expect(buttons.some((t) => t.includes('Clear App Data'))).toBe(true);
    expect(buttons.some((t) => t.includes('Force Stop'))).toBe(true);
  });

  it('filters the package list by the debounced search box', async () => {
    const { content, window } = await loadAppManager({
      seedApps: [
        { id: 'com.a.one', name: 'Note Taker', version: '1.0.0' },
        { id: 'com.b.two', name: 'Image Tool', version: '1.0.0' },
      ],
    });
    expect(listRows(content)).toHaveLength(2);
    const search = content.querySelector('#app-installer-search-input');
    search.value = 'image';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(200); // 150ms debounce
    const rows = listRows(content);
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Image Tool');

    search.value = 'zzz';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(200);
    expect(content.textContent).toContain('No apps match.');
  });

  it('disables and re-enables an app, persisting to nova_disabled_apps', async () => {
    const { content, window, Notify } = await loadAppManager({
      seedApps: [{ id: 'com.test.app', name: 'Toggle Me', version: '1.0.0' }],
    });
    listRows(content)[0].click();
    let toggle = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Disable'));
    toggle.click();
    expect(JSON.parse(window.localStorage.getItem('nova_disabled_apps'))).toEqual(['com.test.app']);
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'App Disabled', type: 'success' }));
    // List row flags it and the action becomes Enable
    expect(listRows(content)[0].textContent).toContain('disabled');
    toggle = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Enable'));
    expect(toggle).toBeTruthy();
    toggle.click();
    expect(JSON.parse(window.localStorage.getItem('nova_disabled_apps'))).toEqual([]);
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'App Enabled' }));
  });

  it('blocks launching a dev-only tool while Developer Mode is off', async () => {
    const { content, WM, showModal } = await loadAppManager({
      seedApps: [{ id: 'com.astroos.devconsole', name: 'Console', version: '3.0.2', devOnly: true }],
    });
    listRows(content)[0].click();
    const launch = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Launch'));
    launch.click();
    expect(WM.createWindow).not.toHaveBeenCalled();
    expect(showModal).toHaveBeenCalledWith(
      'Developer Mode Required',
      expect.stringContaining('Console'),
      expect.anything(),
    );
  });

  it('installs an unsigned .novaapp after the untrusted-dialog override', async () => {
    const { content, window, Notify, document } = await loadAppManager();
    const pkg = {
      novabyte_app: true,
      manifest: { id: 'com.hobby.app', name: 'Hobby App', version: '0.1.0', description: 'Just testing' },
      files: {},
    };
    const file = new window.File([JSON.stringify(pkg)], 'hobby.novaapp', { type: 'application/json' });

    // Exposed install hook (also used by the registerApp-level onDrop).
    // Don't await yet: the promise stays pending until the dialog is answered.
    const pending = content._novaAppProcessFile(file);
    await settle(); // FileReader runs async, then the untrusted dialog opens
    // Unsigned package (no AppPackage/TrustStore in this context) → dialog
    const moreBtn = document.querySelector('#nb-untrusted-more-btn');
    expect(moreBtn).toBeTruthy();
    expect(document.querySelector('#nb-untrusted-launch-btn').style.display).toBe('none');
    moreBtn.click();
    expect(document.querySelector('#nb-untrusted-launch-btn').style.display).toBe('inline-block');
    document.querySelector('#nb-untrusted-launch-btn').click();

    expect(await pending).toBe('installed');
    const stored = JSON.parse(window.localStorage.getItem(APPS_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'com.hobby.app', name: 'Hobby App', version: '0.1.0', verified: false });
    expect(stored[0].files).toEqual({}); // package files stored verbatim
    // Install log + notification + detail view now shows the app
    const log = JSON.parse(window.localStorage.getItem(LOG_KEY));
    expect(log[0]).toMatchObject({ action: 'install', appId: 'com.hobby.app' });
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'App Installed', type: 'success' }));
    expect(content.textContent).toContain('Hobby App');
    // The package is registered with the OS so the launcher can open it
    expect(window.OS.apps['com.hobby.app']).toBeTruthy();
    expect(window.APP_REGISTRY.some((a) => a.id === 'com.hobby.app')).toBe(true);
  });

  it('rejects invalid packages with an install-failed notification', async () => {
    const { content, window, Notify, document } = await loadAppManager();

    // Not .novaapp at all → invalid-file toast
    await content._novaAppProcessFile(new window.File(['{}'], 'thing.txt', { type: 'text/plain' }));
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Invalid File' }));

    // Malformed JSON → security error (eval-style packages are no longer supported)
    Notify.show.mockClear();
    const r1 = await content._novaAppProcessFile(new window.File(['not json{'], 'bad.novaapp', { type: 'application/json' }));
    expect(r1).toBe('failed');
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Install Failed',
      body: expect.stringContaining('not valid JSON'),
    }));

    // Valid JSON but missing manifest fields
    Notify.show.mockClear();
    const r2 = await content._novaAppProcessFile(new window.File([JSON.stringify({ manifest: { id: 'x' } })], 'x.novaapp', { type: 'application/json' }));
    expect(r2).toBe('failed');
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Missing required manifest fields'),
    }));
    expect(document.querySelector('#nb-untrusted-more-btn')).toBeNull(); // no dialog leaked
    expect(window.localStorage.getItem(APPS_KEY)).toBeNull(); // nothing installed
  });

  it('routes drops through onDrop: rejects non-packages and uninitialized windows', async () => {
    const { app, Notify } = await loadAppManager();
    await app.onDrop({ name: 'photo.png' }, {});
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Invalid File',
      body: 'Please select a valid .novaapp package.',
    }));

    Notify.show.mockClear();
    await app.onDrop({ name: 'app.novaapp' }, {}); // no state.content._novaAppProcessFile
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Not Ready',
      body: expect.stringContaining('still loading'),
    }));
  });

  it('manages web apps on the Web Apps tab with add + launch', async () => {
    const wam = {
      getAllApps: vi.fn(() => [{ id: 'docs', name: 'Docs Site', url: 'https://docs.example.com/page', icon: null }]),
      addApp: vi.fn((data) => ({ id: 'added-' + Date.now(), ...data })),
      removeApp: vi.fn(),
    };
    const { content, window, WM } = await loadAppManager();
    window.WebAppManager = wam;

    content.querySelector('[data-tab="webapps"]').click();
    expect(content.textContent).toContain('Docs Site');
    expect(content.textContent).toContain('docs.example.com'); // extracted host

    // Click the row → detail with Open/Remove
    const rows = listRows(content);
    rows[0].click();
    const openBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Open'));
    openBtn.click();
    // window.openWebApp is not defined → fallback path registers webapp_<id>
    expect(WM.createWindow).toHaveBeenCalledWith('webapp_docs');

    // "+ Add" returns to the add form with required-field validation
    const addBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Add'));
    addBtn.click();
    expect(content.querySelector('#web-app-url-input')).toBeTruthy();
    expect(content.querySelector('#web-app-name-input')).toBeTruthy();
    const save = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Add Web App'));
    save.click();
    expect(content.textContent).toContain('URL is required.');
    content.querySelector('#web-app-url-input').value = 'not a url';
    content.querySelector('#web-app-name-input').value = 'X';
    save.click();
    expect(content.textContent).toContain('Please enter a valid URL.');
  });
});
