// tests/apps/settings.test.js — window app: unavailable-API guard, sidebar
// navigation, appearance theme/clock flows, desktop wallpaper + taskbar
// controls, developer-mode warning dialog, About hardware fixture, and the
// degraded connectivity/default-apps/storage sections.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

// In-memory settings facade mirroring window.AstroOSSystem.settings.
function makeSystemStub(initial = {}) {
  const store = {
    theme: 'nova-dark',
    accentColor: '#58a6ff',
    clockFormat: '12h',
    ...initial,
  };
  const sets = [];
  return {
    store,
    sets,
    get: (key) => store[key],
    set: (key, value) => { sets.push([key, value]); store[key] = value; return value; },
  };
}

function makeAstroOSSystem(initial) {
  const settings = makeSystemStub(initial);
  return {
    settings,
    sets: settings.sets,
    store: settings.store,
    security: { setLockPin: (pin) => settings.sets.push(['lockPin', pin]) },
    developer: {
      setMode: (v) => settings.sets.push(['devMode', v]),
      setRootAccess: (v) => settings.sets.push(['rootAccess', v]),
    },
    hardware: {
      network: null, // connectivity section degrades by default
      getInventory: () => ({
        supported: true,
        graphics: [{ vendor: 'Mesa', driver: 'llvmpipe' }],
        display: { resolution: { width: 1024, height: 768 } },
        cpu: { logicalCores: 8 },
        virtualization: { vendor: 'KVM' },
        vmwareTools: { running: false, installed: false },
        memory: { totalBytes: 8 * 1024 ** 3 },
      }),
    },
  };
}

const WALLPAPERS = [
  { id: 'stock-blue', name: 'Nova Blue', gradient: 'linear-gradient(rgb(2, 12, 30), rgb(10, 20, 40))' },
  { id: 'stock-teal', name: 'Nova Teal', gradient: 'linear-gradient(rgb(10, 94, 112), rgb(4, 40, 50))' },
];

async function loadSettings({ system, os, wallpaperService, extra = {} } = {}) {
  const nbs = system ?? makeAstroOSSystem();
  const notify = { calls: [], show: (n) => notify.calls.push(n) };
  const loaded = await loadWindowApp('settings', {
    stubs: {
      extra: {
        AstroOSSystem: nbs,
        OS: os ?? { username: 'nova', lockPin: null, version: '3.0.2', dnd: false, apps: {} },
        Notify: notify,
        WallpaperService: wallpaperService ?? { getPresets: () => WALLPAPERS },
        ...extra,
      },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: {} });
  // The real window manager attaches the content element; several render
  // paths check content.isConnected before painting.
  loaded.document.body.appendChild(content);
  return { ...loaded, content, nbs, notify };
}

const sidebarBtn = (content, name) =>
  [...content.querySelectorAll('.nook-section-btn')]
    .find((b) => b.getAttribute('aria-label') === name);

describe("'Settings' app (js/apps/settings)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('settings');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.settings');
    expect(app.name).toBe('Settings');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('settings');
    expect(app.defaultSize).toEqual([700, 500]);
    expect(app.minSize).toEqual([500, 400]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the unavailable-system guard when AstroOSSystem is missing', async () => {
    const { app, window } = await loadWindowApp('settings');
    const content = initApp(app, { window, state: {} });
    expect(content.textContent)
      .toBe('System settings are unavailable. Restart AstroOS and try again.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window, document } = await loadWindowApp('settings', {
      stubs: {
        AppDirs: null,
        extra: { AstroOSSystem: makeAstroOSSystem(), OS: { username: 'nova' } },
      },
    });
    const content = initApp(app, { window, state: {} });
    document.body.appendChild(content);
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.astroos.settings');
  });

  it('renders all 12 sidebar sections and navigates between them', async () => {
    const { content } = await loadSettings();
    const buttons = [...content.querySelectorAll('.nook-section-btn')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Appearance', 'Accessibility', 'Desktop', 'System', 'Date and Region',
      'Connectivity', 'Storage', 'Notifications', 'Privacy', 'Root Access',
      'Default Apps', 'About',
    ]);
    // Appearance is the default section and is marked active.
    expect(content.querySelector('.nook-section-btn.active').getAttribute('aria-label')).toBe('Appearance');

    sidebarBtn(content, 'System').click();
    expect(content.querySelector('.nook-content').dataset.currentTab).toBe('system');
    expect(content.querySelector('.nook-content h2').textContent).toBe('System');
    expect(content.querySelector('#system-username-input').value).toBe('nova');
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Boot to Recovery')).toBe(true);

    sidebarBtn(content, 'Accessibility').click();
    expect(content.querySelector('.nook-content').dataset.currentTab).toBe('accessibility');
    expect(content.querySelector('.nook-content h2').textContent).toBe('Accessibility');
    expect(content.querySelector('.nook-section-btn.active').getAttribute('aria-label')).toBe('Accessibility');
  });

  it('switches the theme and toggles the clock format in Appearance', async () => {
    const { content, nbs } = await loadSettings();
    // Content was detached during init, so the first paint happens on the
    // first sidebar click (the real WM attaches before init).
    sidebarBtn(content, 'Appearance').click();
    const appearance = content.querySelector('.nook-content');

    // 7 theme rows from THEMES/THEME_NAMES.
    const themeGroup = [...appearance.querySelectorAll('.nook-group')]
      .find((g) => g.textContent.includes('Theme'));
    const themeButtons = [...themeGroup.querySelectorAll('button')];
    expect(themeButtons.map((b) => b.textContent)).toEqual([
      'Active', 'Select', 'Select', 'Select', 'Select', 'Select', 'Select',
    ]);

    // Click "Select" on Nord → persisted and re-rendered as Active.
    themeButtons[2].click();
    expect(nbs.sets).toContainEqual(['theme', 'nord']);
    const themeGroup2 = [...content.querySelectorAll('.nook-group')]
      .find((g) => g.textContent.includes('Theme'));
    expect([...themeGroup2.querySelectorAll('button')][2].textContent).toBe('Active');

    // Clock format toggle flips 12h → 24h.
    const clockToggle = appearance.querySelector('button[aria-label="Toggle 24-hour time"]');
    expect(clockToggle.getAttribute('aria-checked')).toBe('false');
    clockToggle.click();
    expect(nbs.sets).toContainEqual(['clockFormat', '24h']);
    expect(clockToggle.getAttribute('aria-checked')).toBe('true');
  });

  it('applies a preset wallpaper and manages taskbar settings in Desktop', async () => {
    const { content, nbs, notify } = await loadSettings();
    sidebarBtn(content, 'Desktop').click();
    const desktop = content.querySelector('.nook-content');

    // Two preset cards from the WallpaperService stub; stock-blue active by default.
    const cards = [...desktop.querySelectorAll('[role="button"][aria-label^="Wallpaper:"]')];
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Wallpaper: Nova Blue (active)', 'Wallpaper: Nova Teal',
    ]);

    cards[1].click();
    expect(nbs.sets).toContainEqual(['wallpaperId', 'stock-teal']);
    expect(nbs.sets).toContainEqual(['customWallpaper', null]);
    expect(notify.calls.some((n) => n.title === 'Wallpaper Changed' && n.body === 'Applied Nova Teal')).toBe(true);
    expect(cards[1].getAttribute('aria-pressed')).toBe('true');

    // Taskbar size buttons.
    const largeBtn = [...desktop.querySelectorAll('button')].find((b) => b.textContent === 'Large');
    largeBtn.click();
    expect(nbs.sets).toContainEqual(['taskbarSize', 'large']);

    // Show-clock toggle hides a live #tray-clock element when present.
    const trayClock = attachTrayClock(content);
    const clockToggle = [...desktop.querySelectorAll('button[role="switch"]')]
      .find((b) => b.getAttribute('aria-label') === 'Toggle clock in taskbar');
    expect(clockToggle.getAttribute('aria-checked')).toBe('true');
    clockToggle.click();
    expect(nbs.sets).toContainEqual(['showTaskbarClock', false]);
    expect(trayClock.style.display).toBe('none');
  });

  it('guards enabling Developer Mode behind the security warning dialog', async () => {
    const { content, nbs, notify, document } = await loadSettings();
    sidebarBtn(content, 'System').click();

    const devToggle = [...content.querySelectorAll('button[role="switch"]')]
      .find((b) => b.getAttribute('aria-label') === 'Toggle developer mode');
    expect(devToggle.getAttribute('aria-checked')).toBe('false');

    devToggle.click();
    // Overlay is mounted on document.body, not inside the window content.
    const overlay = [...document.body.children].find((el) => el.textContent.includes('Developer Mode — Security Warning'));
    expect(overlay).toBeTruthy();

    // Cancel → nothing changes, overlay dismissed.
    [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    expect(nbs.sets).not.toContainEqual(['devMode', true]);
    expect([...document.body.children].some((el) => el.textContent.includes('Security Warning'))).toBe(false);

    // Confirm → dev mode enabled + notification (the dialog resolves a
    // promise, so the setMode continuation lands in a microtask).
    devToggle.click();
    const overlay2 = [...document.body.children].find((el) => el.textContent.includes('Developer Mode — Security Warning'));
    [...overlay2.querySelectorAll('button')].find((b) => b.textContent === 'Turn On Anyway').click();
    await settle(10);
    expect(nbs.sets).toContainEqual(['devMode', true]);
    expect(devToggle.getAttribute('aria-checked')).toBe('true');
    expect(notify.calls.some((n) => n.title === 'Developer Mode Enabled')).toBe(true);
  });

  it('renders the About section from the hardware inventory fixture', async () => {
    const { content, notify } = await loadSettings();
    sidebarBtn(content, 'About').click();
    const about = content.querySelector('.nook-content');

    expect(about.textContent).toContain('Software');
    expect(about.textContent).toContain('AstroOS version');
    expect(about.textContent).toContain('v3.0.2');
    expect(about.textContent).toContain('Build number');
    expect(about.textContent).toContain('NovaByte base');
    expect(about.textContent).toMatch(/Build Date\s*\d{4}-\d{2}-\d{2}/);
    expect(about.textContent).toContain('Platform signature');
    // jsdom has no Node process → the non-Linux fallback values.
    expect(about.textContent).toContain('Not running on Linux');
    expect(about.textContent).toContain('Unavailable');
    expect(about.textContent).toContain('CPU cores');
    expect(about.textContent).toContain('8'); // hardware.cpu.logicalCores
    expect(about.textContent).toContain('Mesa llvmpipe');
    expect(about.textContent).toContain('KVM');
    expect(about.textContent).toContain('Apache 2.0');

    // jsdom exposes no navigator.clipboard → the guarded copy path surfaces
    // a "Copy Failed" notification instead of writing the clipboard.
    [...about.querySelectorAll('button')]
      .find((b) => b.textContent.includes('Copy system info')).click();
    await settle(20);
    expect(notify.calls.some((n) => n.title === 'Copy Failed')).toBe(true);
  });

  it('keeps the disabled Root Access notice compact instead of filling the pane', async () => {
    const { content } = await loadSettings({
      system: makeAstroOSSystem({ devMode: false, rootAccessEnabled: false }),
    });
    sidebarBtn(content, 'Root Access').click();
    const notice = content.querySelector('.nook-content .empty-state');

    expect(notice).not.toBeNull();
    expect(notice.style.height).toBe('auto');
    expect(notice.style.padding).toBe('18px 0px');
    expect(notice.style.alignItems).toBe('flex-start');
    expect(notice.style.justifyContent).toBe('flex-start');
  });

  it('degrades connectivity, default-apps and storage sections without host services', async () => {
    const { content } = await loadSettings();

    sidebarBtn(content, 'Connectivity').click();
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Connectivity service is not available in this build.');

    sidebarBtn(content, 'Default Apps').click();
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Default apps system not available.');

    sidebarBtn(content, 'Storage').click();
    // navigator.storage does not exist in jsdom → estimate() fails into the catch.
    await settle(20);
    expect(content.querySelector('.nook-content').textContent)
      .toContain('Unable to retrieve storage information.');
  });
});

// Attach a tray clock node so the Desktop toggle's live-DOM branch is real.
function attachTrayClock(content) {
  const ownerDoc = content.ownerDocument;
  const tray = ownerDoc.createElement('div');
  tray.id = 'tray-clock';
  ownerDoc.body.appendChild(tray);
  return tray;
}
