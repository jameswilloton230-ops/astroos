// tests/apps/launcher.test.js — desktop shell: launchpad grid/search, taskbar,
// desktop icons, drop-to-pin, settings reconfiguration, workspaces.
// The launcher is a shell app: app.js wires the pre-rendered index.html DOM and
// exports window.LauncherShell / updateTaskbar / renderDesktopIcons / etc. —
// it never calls registerApp, so tests drive the exported shell functions.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, settle } from '../helpers/app-harness.js';
import { createFakeFS } from '../helpers/fake-fs.js';

function makeLauncherOS(values = {}) {
  const store = { pinnedApps: [], ...values };
  const handlers = new Map();
  return {
    settings: {
      get: (key) => (key in store ? store[key] : undefined),
      set: (key, val) => { store[key] = val; },
    },
    apps: {},
    windows: new Map(),
    focusedWindowId: null,
    workspaces: [],
    currentWorkspace: null,
    events: {
      on: (name, fn) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(fn);
      },
      off: (name, fn) => handlers.get(name)?.delete(fn),
      emit: (name, payload) => { for (const fn of [...(handlers.get(name) ?? [])]) fn(payload); },
    },
  };
}

async function loadLauncher({ osValues = {}, devMode = false } = {}) {
  const OS = makeLauncherOS(osValues);
  const mocks = {
    Notify: { show: vi.fn() },
    showModal: vi.fn(() => Promise.resolve('confirm')),
    WM: { createWindow: vi.fn(), focusWindow: vi.fn(), minimizeWindow: vi.fn(), closeWindow: vi.fn(), updateTaskbar: vi.fn(), attachTaskbar: vi.fn() },
    openFileWithDefaultApp: vi.fn(),
    EventLog: { log: vi.fn() },
  };
  const loaded = await loadWindowApp('launcher', {
    stubs: {
      extra: {
        OS,
        Notify: mocks.Notify,
        showModal: mocks.showModal,
        WM: mocks.WM,
        EventLog: mocks.EventLog,
        openFileWithDefaultApp: mocks.openFileWithDefaultApp,
        NovaByteSystem: {
          settings: { get: (key) => (key === 'devMode' ? devMode : key === 'rootAccessEnabled' ? false : undefined) },
          developer: { setRootAccess: vi.fn() },
          hardware: { power: { restart: vi.fn(), powerOff: vi.fn() } },
        },
      },
    },
  });
  const { window, document } = loaded;
  // updateTaskbar() uses the ES2026 Map upsert method; current Node lacks it.
  window.Map.prototype.getOrInsertComputed = window.Map.prototype.getOrInsertComputed
    ?? function (key, makeValue) {
      if (!this.has(key)) this.set(key, makeValue());
      return this.get(key);
    };
  window.APP_REGISTRY = window.APP_REGISTRY || [];
  return { ...loaded, OS, ...mocks };
}

describe('Launcher shell (js/apps/launcher)', () => {
  beforeEach(() => resetTestStorage());

  it('bootstraps the shell: exports LauncherShell and global functions', async () => {
    const { window } = await loadLauncher();
    expect(window.LauncherShell).toBeTruthy();
    expect(Object.isFrozen(window.LauncherShell)).toBe(true);
    for (const fn of ['renderDesktopIcons', 'updateTaskbar', 'renderLaunchpad', 'toggleLaunchpad',
      'posToCell', 'findFreeCell', 'switchWorkspace', 'showAppSwitcher', 'hideAppSwitcher']) {
      expect(typeof window.LauncherShell[fn]).toBe('function');
    }
    expect(typeof window.updateTaskbar).toBe('function');
    expect(typeof window.renderDesktopIcons).toBe('function');
    expect(typeof window.renderLaunchpad).toBe('function');
    expect(typeof window.toggleLaunchpad).toBe('function');
    expect(typeof window.applyLauncherSettings).toBe('function');
    expect(typeof window.configureLauncherTaskbar).toBe('function');
    // jsdom has no `process`, so the Linux-only restart/power-off actions are hidden
    const power = window.document.getElementById('launchpad-power-actions');
    expect(power.style.display).toBe('none');
  });

  it('opens the launchpad from the Start button and closes it again', async () => {
    // app.js registers toggleLaunchpad on #start-btn from two top-level
    // statements, but identical (type, callback, capture) registrations are
    // deduped by the DOM spec, so one click toggles exactly once.
    const { window, document } = await loadLauncher();
    window.APP_REGISTRY = [];
    const launchpad = document.getElementById('launchpad');
    expect(launchpad.classList.contains('active')).toBe(false);

    document.getElementById('start-btn').click();
    expect(launchpad.classList.contains('active')).toBe(true);
    window.toggleLaunchpad();
    expect(launchpad.classList.contains('active')).toBe(false);
  });

  it('renders the launchpad grid pinned-first, hiding dev-only apps and itself', async () => {
    const { window, document, WM } = await loadLauncher({ devMode: false });
    window.APP_REGISTRY = [
      { id: 'com.nbosp.clock', name: 'Clock', icon: 'clock' },
      { id: 'com.nbosp.devconsole', name: 'Console', icon: 'terminal', devOnly: true },
      { id: 'com.user.zeta', name: 'Zeta App', icon: 'star' },
      { id: 'com.nbosp.launcher', name: 'Launcher', icon: 'home' },
      { id: 'com.nbosp.files', name: 'Files', icon: 'folder-open' },
    ];
    window.toggleLaunchpad();
    const names = [...document.querySelectorAll('.launchpad-item .launchpad-name')].map((n) => n.textContent);
    // Pinned LAUNCHPAD_ORDER apps keep list order (Files before Clock), then
    // unpinned non-system apps alphabetically. Console is devOnly-hidden and
    // the launcher never lists itself.
    expect(names).toEqual(['Files', 'Clock', 'Zeta App']);

    // Clicking an app closes the launchpad and opens the window
    const clockItem = [...document.querySelectorAll('.launchpad-item')]
      .find((i) => i.querySelector('.launchpad-name').textContent === 'Clock');
    clockItem.click();
    expect(WM.createWindow).toHaveBeenCalledWith('com.nbosp.clock');
    expect(document.getElementById('launchpad').classList.contains('active')).toBe(false);
  });

  it('filters launchpad items by search with highlight and a no-results row', async () => {
    const { window, document } = await loadLauncher({ devMode: false });
    window.APP_REGISTRY = [
      { id: 'com.nbosp.clock', name: 'Clock', icon: 'clock' },
      { id: 'com.nbosp.files', name: 'Files', icon: 'folder-open' },
    ];
    window.toggleLaunchpad();
    const search = document.getElementById('launchpad-search');
    search.value = 'cl';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(200); // 150ms debounce

    const items = [...document.querySelectorAll('.launchpad-item')];
    const clockItem = items.find((i) => i.querySelector('.launchpad-name').textContent.includes('Clock'));
    const filesItem = items.find((i) => i.querySelector('.launchpad-name').textContent.includes('Files'));
    expect(filesItem.style.display).toBe('none');
    expect(clockItem.style.display).toBe('');
    const mark = clockItem.querySelector('.launchpad-name mark');
    expect(mark.textContent).toBe('Cl'); // case-insensitive highlight

    // No matches → dedicated message row
    search.value = 'zzz';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(200);
    const noResults = document.getElementById('launchpad-no-results');
    expect(noResults.textContent).toBe('No apps found');
    expect(noResults.style.display).toBe('');

    // Escape closes the launchpad and strips the highlights
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.getElementById('launchpad').classList.contains('active')).toBe(false);
    expect(clockItem.querySelector('.launchpad-name mark')).toBeNull();
  });

  it('builds the taskbar from pinned + running apps and drives window focus', async () => {
    const { window, document, OS, WM } = await loadLauncher({ devMode: false });
    OS.apps['com.nbosp.clock'] = { id: 'com.nbosp.clock', name: 'Clock', icon: 'clock' };
    OS.apps['com.nbosp.devconsole'] = { id: 'com.nbosp.devconsole', name: 'Console', icon: 'terminal', devOnly: true };
    OS.settings.set('pinnedApps', ['com.nbosp.clock', 'com.nbosp.devconsole']);
    OS.windows.set('w1', { id: 'w1', appId: 'com.nbosp.clock', minimized: false });

    window.updateTaskbar();
    let buttons = [...document.querySelectorAll('#taskbar-apps .taskbar-app-btn')];
    // devOnly Console is filtered out of the taskbar while devMode is off
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBe('Clock');
    expect(buttons[0].classList.contains('pinned')).toBe(true);

    buttons[0].click();
    expect(WM.focusWindow).toHaveBeenCalledWith('w1');

    // Focused + visible window minimises on click
    OS.focusedWindowId = 'w1';
    window.updateTaskbar();
    [...document.querySelectorAll('#taskbar-apps .taskbar-app-btn')][0].click();
    expect(WM.minimizeWindow).toHaveBeenCalledWith('w1');

    // Two open windows → count badge and a preview popup on click
    OS.focusedWindowId = null;
    OS.windows.set('w2', { id: 'w2', appId: 'com.nbosp.clock', minimized: true });
    window.updateTaskbar();
    buttons = [...document.querySelectorAll('#taskbar-apps .taskbar-app-btn')];
    expect(buttons[0].getAttribute('aria-label')).toBe('Clock (2 windows)');
    expect(buttons[0].querySelector('.taskbar-window-count').textContent).toBe('2');
    buttons[0].click();
    expect(document.querySelector('.taskbar-window-preview')).toBeTruthy();
  });

  it('renders desktop icons: app shortcuts get an arrow badge and launch on double-click', async () => {
    const { window, document, OS, WM, openFileWithDefaultApp } = await loadLauncher({ devMode: false });
    const FS = createFakeFS();
    FS.getMimeIcon = () => 'file';
    FS.specialFolders.desktop = FS.ensureAppDir('desktop').id; // must exist or the render retries later
    window.FS = FS;
    OS.apps['com.nbosp.clock'] = { id: 'com.nbosp.clock', name: 'Clock', icon: 'clock' };

    await FS.createFile(FS.specialFolders.desktop, 'Clock.lnk',
      JSON.stringify({ target: 'com.nbosp.clock', type: 'app-shortcut', icon: 'clock' }),
      'application/x-app-shortcut');
    await FS.createFile(FS.specialFolders.desktop, 'note.txt', 'hi', 'text/plain');

    window.renderDesktopIcons();
    const icons = [...document.querySelectorAll('#desktop .desktop-icon')];
    expect(icons).toHaveLength(2);

    const shortcut = icons.find((i) => i.getAttribute('data-shortcut-target') === 'com.nbosp.clock');
    expect(shortcut).toBeTruthy();
    expect(shortcut.querySelector('.desktop-icon-label').textContent).toBe('Clock'); // .lnk stripped
    expect(shortcut.textContent).toContain('→'); // shortcut arrow badge

    shortcut.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(WM.createWindow).toHaveBeenCalledWith('com.nbosp.clock');

    const note = icons.find((i) => i.querySelector('.desktop-icon-label').textContent === 'note.txt');
    note.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(openFileWithDefaultApp).toHaveBeenCalledWith(expect.objectContaining({ name: 'note.txt' }));

    // Single click selects the icon
    note.click();
    expect(note.classList.contains('selected')).toBe(true);

    // Policy off-switch clears the desktop entirely
    OS.settings.set('showDesktopIcons', false);
    window.renderDesktopIcons();
    expect(document.getElementById('desktop').children).toHaveLength(0);
  });

  it('pins an app to the taskbar when a shortcut payload is dropped on it', async () => {
    const { window, document, OS, WM, Notify } = await loadLauncher({ devMode: false });
    const FS = createFakeFS();
    FS.getMimeIcon = () => 'file';
    FS.specialFolders.desktop = FS.ensureAppDir('desktop').id;
    window.FS = FS;
    window.renderDesktopIcons(); // attaches the taskbar drop handlers

    const taskbar = document.getElementById('taskbar');
    const makeDrop = (payload) => {
      const e = new window.Event('drop', { bubbles: true, cancelable: true });
      e.dataTransfer = { getData: (type) => (type === 'application/json' ? JSON.stringify(payload) : '') };
      return e;
    };
    const payload = { type: 'app-shortcut', appId: 'com.nbosp.clock', appName: 'Clock' };

    taskbar.dispatchEvent(makeDrop(payload));
    await settle();
    expect(OS.settings.get('pinnedApps')).toEqual(['com.nbosp.clock']);
    expect(WM.updateTaskbar).toHaveBeenCalled();
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Pinned to Taskbar', body: 'Clock pinned to taskbar', appName: 'Taskbar',
    }));

    // Dropping the same app again does not duplicate the pin or re-notify
    Notify.show.mockClear();
    taskbar.dispatchEvent(makeDrop(payload));
    await settle();
    expect(OS.settings.get('pinnedApps')).toEqual(['com.nbosp.clock']);
    expect(Notify.show).not.toHaveBeenCalled();
  });

  it('reconfigures the taskbar layout from settings, live on settings:changed', async () => {
    const { window, document, OS } = await loadLauncher({ osValues: { taskbarPosition: 'left' } });
    const taskbar = document.getElementById('taskbar');
    window.applyLauncherSettings(OS.settings.get.bind(OS.settings));
    // AstroOS positions the pill taskbar via CSS classes, not inline styles
    expect(taskbar.classList.contains('taskbar-left')).toBe(true);
    expect(taskbar.classList.contains('taskbar-top')).toBe(false);
    expect(taskbar.classList.contains('taskbar-right')).toBe(false);

    // Moving it to the top via the live settings:changed event swaps the class.
    OS.settings.set('taskbarPosition', 'top');
    OS.events.emit('settings:changed', { key: 'taskbarPosition' });
    expect(taskbar.classList.contains('taskbar-top')).toBe(true);
    expect(taskbar.classList.contains('taskbar-left')).toBe(false);

    // Auto-hide flag toggles a class
    OS.settings.set('taskbarAutoHide', true);
    OS.events.emit('settings:changed', { key: 'taskbarAutoHide' });
    expect(taskbar.classList.contains('taskbar-autohide')).toBe(true);
  });

  it('creates and switches virtual workspaces via LauncherShell.switchWorkspace', async () => {
    const { window, OS } = await loadLauncher();
    OS.workspaces.push({ id: 11, name: 'Workspace 1' });
    OS.currentWorkspace = 11;

    window.LauncherShell.switchWorkspace(1);
    expect(OS.workspaces).toHaveLength(2); // created Workspace 2
    expect(OS.currentWorkspace).toBe(OS.workspaces[1].id);
    expect(OS.workspaces[1].name).toBe('Workspace 2');

    window.LauncherShell.switchWorkspace(-1);
    expect(OS.currentWorkspace).toBe(11);

    // At the boundary, going further back is a no-op
    window.LauncherShell.switchWorkspace(-1);
    expect(OS.currentWorkspace).toBe(11);
    expect(OS.workspaces).toHaveLength(2);
  });
});
