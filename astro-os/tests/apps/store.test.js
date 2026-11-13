// tests/apps/store.test.js — window app: catalog fetch + error recovery,
// browse/category/search rendering, install/uninstall/update flows persisted
// to localStorage, app details with permissions/release track, and update
// settings with/without StoreUpdateService.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const APPS_KEY = 'nova_installed_apps';
const INTERVAL_KEY = 'nova_store_update_interval_minutes';

const CATALOG = [
  {
    id: 'com.example.notes', name: 'Notes Plus', version: '1.2.0', author: 'Example Co',
    description: 'Write notes.', categories: ['productivity'], icon: 'https://example.com/notes.png',
    file: 'packages/notes-plus.novaapp', size: '1.2 MB', featured: true,
  },
  {
    id: 'com.example.paint', name: 'Paint', version: '2.0.0', author: 'Example Co',
    description: 'Draw things.', categories: ['graphics'], icon: '',
    file: 'packages/paint.novaapp', size: '3 MB',
  },
];

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

const NOTES_PKG = {
  novabyte_app: true,
  manifest: {
    id: 'com.example.notes', name: 'Notes Plus', version: '1.2.0', entry: 'index.html',
    description: 'Write notes.', permissions: ['fs:access'], optionalPermissions: ['net:external'],
    releaseNotes: 'New in 1.2.0: tags.',
  },
  files: { 'index.html': b64('<h1>Notes</h1>') },
  signature: null,
  integrity: null,
  compiled_at: '2026-01-01T00:00:00.000Z',
};

function makeFetch({ catalog = CATALOG, community = null, packages = { 'packages/notes-plus.novaapp': NOTES_PKG } } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('apps.json')) {
      if (!catalog) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => catalog };
    }
    if (u.includes('supabase.co')) {
      if (!community) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => community };
    }
    const file = Object.keys(packages).find((f) => u.endsWith(f));
    if (file) return { ok: true, status: 200, json: async () => packages[file] };
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

function makeNotify() {
  const calls = [];
  return { calls, show: (n) => calls.push(n) };
}

async function loadStore(opts = {}) {
  const notify = makeNotify();
  const loaded = await loadWindowApp('store', {
    stubs: {
      fetch: makeFetch(opts),
      extra: { Notify: notify },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: {} });
  // Attach like the real WM does — the detail view's async enrichment
  // bails out when the panel isn't connected (detail.isConnected check).
  loaded.document.body.appendChild(content);
  await settle(50); // init is async: catalog fetch + first render
  return { ...loaded, content, notify };
}

const cardOf = (content, appId) => content.querySelector(`[data-id="${appId}"]`);
const btnOf = (card, text) => [...card.querySelectorAll('button')].find((b) => b.textContent === text);

describe("'Store' app (js/apps/store)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('store');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.store');
    expect(app.name).toBe('Store');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('store');
    expect(app.description).toMatch(/install apps/);
    expect(app.defaultSize).toEqual([1020, 680]);
    expect(app.minSize).toEqual([720, 480]);
    expect(typeof app.init).toBe('function');
  });

  it('shows a retryable error when both catalogs are unreachable', async () => {
    const { content } = await loadStore({ catalog: null });
    expect(content.querySelector('.store-error h2').textContent).toBe('Could not load the app catalog');
    expect(content.textContent).toContain('Could not load the static or community app catalogs');

    // Retry still fails → same error surface, button re-enabled.
    const retry = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Try again');
    retry.click();
    await settle(50);
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe('Try again');
    expect(content.querySelector('.store-error')).toBeTruthy();
  });

  it('falls back to the raw GitHub catalog when the Pages host cannot be resolved', async () => {
    const calls = [];
    const loaded = await loadWindowApp('store', {
      stubs: {
        fetch: async (url) => {
          const value = String(url);
          calls.push(value);
          if (value.includes('apps.json')) {
            if (value.includes('novabyteteam.github.io')) throw new TypeError('Failed to fetch');
            return { ok: true, status: 200, json: async () => CATALOG };
          }
          return { ok: false, status: 500, json: async () => ({}) };
        },
        extra: { Notify: makeNotify() },
      },
    });
    const content = initApp(loaded.app, { window: loaded.window, state: {} });
    await settle(50);

    expect(cardOf(content, 'com.example.notes')).toBeTruthy();
    expect(calls).toContain('https://raw.githubusercontent.com/AstroOSTeam/novabyte-os/main/src/apps.json');
  });

  it('renders the browse view: category bar, featured hero and app cards', async () => {
    const { content } = await loadStore();
    expect(content.querySelector('.store-title').textContent).toBe('AstroOS');
    expect(content.querySelector('.store-brand-subtitle').textContent).toBe('Store');
    // Category bar: Explore + sorted catalog categories with counts.
    const bar = content.querySelector('.category-bar');
    const labels = [...bar.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Explore2', 'Graphics1', 'Productivity1']);
    expect(bar.textContent).toContain('Discover apps'.slice(0, 0)); // no-op guard
    expect(content.querySelector('.section-heading h1').textContent).toBe('Discover apps');

    // Featured hero from the flagged catalog entry.
    expect(content.querySelector('.featured-app h2').textContent).toBe('Notes Plus');
    expect(content.textContent).toContain('Featured app');

    // Grid cards.
    const grid = content.querySelector('.store-grid');
    expect([...grid.children].map((c) => c.dataset.id)).toEqual(['com.example.notes', 'com.example.paint']);
    expect(cardOf(content, 'com.example.paint').textContent).toContain('Example Co · v2.0.0 · 3 MB');
    expect(cardOf(content, 'com.example.paint').textContent).toContain('Graphics');

    // Not installed → Get buttons. Signature-less catalog → no verified badge.
    expect(btnOf(cardOf(content, 'com.example.notes'), 'Get')).toBeTruthy();
    await settle(30); // verification promise resolves → badge removed
    expect(cardOf(content, 'com.example.notes').querySelector('.verified-badge')).toBeNull();
  });

  it('installs a package from the catalog into the localStorage registry', async () => {
    const { content, notify, window } = await loadStore();
    const card = cardOf(content, 'com.example.notes');
    const getBtn = btnOf(card, 'Get');

    getBtn.click();
    expect(getBtn.textContent).toBe('Downloading…');
    await settle(80);

    const installed = JSON.parse(window.localStorage.getItem(APPS_KEY));
    expect(installed).toHaveLength(1);
    expect(installed[0].id).toBe('com.example.notes');
    expect(installed[0].version).toBe('1.2.0');
    expect(installed[0].files['index.html']).toBe(b64('<h1>Notes</h1>'));
    expect(installed[0].manifest.id).toBe('com.example.notes');
    expect(installed[0].verified).toBe(false); // unsigned package installs unverified
    expect(installed[0].source).toBe('store');

    // View re-rendered → the same card now offers Uninstall.
    expect(cardOf(content, 'com.example.notes').querySelector('.btn-uninstall').textContent).toBe('Uninstall');
    expect(notify.calls.some((n) => n.title === 'App Installed' && n.body.includes('Notes Plus v1.2.0'))).toBe(true);
  });

  it('uninstalls an installed app and returns the card to its Get state', async () => {
    const seeded = [{
      id: 'com.example.notes', name: 'Notes Plus', version: '1.0.0', source: 'store',
      manifest: { id: 'com.example.notes' }, files: {}, system: false,
    }];
    const loaded = await loadWindowApp('store', {
      stubs: { fetch: makeFetch(), extra: { Notify: makeNotify() } },
    });
    loaded.window.localStorage.setItem(APPS_KEY, JSON.stringify(seeded));
    const content = initApp(loaded.app, { window: loaded.window, state: {} });
    await settle(50);

    const card = cardOf(content, 'com.example.notes');
    const uninstallBtn = btnOf(card, 'Uninstall');
    expect(uninstallBtn).toBeTruthy();
    uninstallBtn.click();
    await settle(80);

    expect(JSON.parse(loaded.window.localStorage.getItem(APPS_KEY))).toEqual([]);
    expect(btnOf(cardOf(content, 'com.example.notes'), 'Get')).toBeTruthy();
  });

  it('offers and performs an update when the catalog version is newer', async () => {
    const seeded = [{
      id: 'com.example.notes', name: 'Notes Plus', version: '1.0.0', source: 'store',
      manifest: { id: 'com.example.notes' }, files: {}, system: false,
    }];
    const loaded = await loadWindowApp('store', {
      stubs: { fetch: makeFetch(), extra: { Notify: makeNotify() } },
    });
    loaded.window.localStorage.setItem(APPS_KEY, JSON.stringify(seeded));
    const content = initApp(loaded.app, { window: loaded.window, state: {} });
    await settle(50);

    const updateBtn = [...cardOf(content, 'com.example.notes').querySelectorAll('button')]
      .find((b) => b.textContent === 'Update');
    expect(updateBtn).toBeTruthy();
    expect(updateBtn.getAttribute('aria-label')).toBe('Update Notes Plus to version 1.2.0');

    updateBtn.click();
    await settle(80);

    const installed = JSON.parse(loaded.window.localStorage.getItem(APPS_KEY));
    expect(installed[0].version).toBe('1.2.0');
    expect(installed[0].lastUpdateSource).toBe('store');
    expect(installed[0].lastUpdatedAt).toBeGreaterThan(0);
  });

  it('does not offer updates for system-bundled installs', async () => {
    const seeded = [{
      id: 'com.example.notes', name: 'Notes Plus', version: '1.0.0', system: true,
      manifest: { id: 'com.example.notes' }, files: {},
    }];
    const loaded = await loadWindowApp('store', {
      stubs: { fetch: makeFetch(), extra: { Notify: makeNotify() } },
    });
    loaded.window.localStorage.setItem(APPS_KEY, JSON.stringify(seeded));
    const content = initApp(loaded.app, { window: loaded.window, state: {} });
    await settle(50);

    const card = cardOf(content, 'com.example.notes');
    expect([...card.querySelectorAll('button')].some((b) => b.textContent === 'Update')).toBe(false);
    expect(btnOf(card, 'Uninstall')).toBeTruthy();
  });

  it('shows the detail view with facts, permissions and the release track', async () => {
    const { content } = await loadStore();
    const openBtn = [...cardOf(content, 'com.example.notes').querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'View Notes Plus details');
    openBtn.click();
    await settle(60); // package fetch + detail enrichment

    expect(content.querySelector('.app-detail h1').textContent).toBe('Notes Plus');
    expect(content.textContent).toContain('by Example Co');
    expect(content.textContent).toContain('.novaapp');
    expect(content.textContent).toContain('Release track');
    expect(content.textContent).toContain('Latest release · v1.2.0');
    expect(content.textContent).toContain('New in 1.2.0: tags.');
    // Permission panel fed by the package manifest.
    expect(content.textContent).toContain('Required');
    expect(content.textContent).toContain('fs:access');
    expect(content.textContent).toContain('Optional');
    expect(content.textContent).toContain('net:external');

    // Back to browse.
    [...content.querySelectorAll('button')]
      .find((b) => b.textContent.includes('All apps')).click();
    expect(content.querySelector('.store-grid')).toBeTruthy();
  });

  it('filters the grid by the search box', async () => {
    const { content, window } = await loadStore();
    const search = content.querySelector('input.store-search');
    search.value = 'paint';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    expect(content.querySelector('.section-heading h1').textContent).toBe('Results for “paint”');
    expect([...content.querySelector('.store-grid').children].map((c) => c.dataset.id))
      .toEqual(['com.example.paint']);
  });

  it('manages update settings with and without StoreUpdateService', async () => {
    const { content, window } = await loadStore();

    const settingsBtn = [...content.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Store settings');
    settingsBtn.click();
    expect(content.querySelector('.store-settings-panel h1').textContent).toBe('Update settings');
    // Defaults to the persisted-or-60-minute interval.
    expect(content.querySelector('#store-update-interval').value).toBe('60');

    const interval = content.querySelector('#store-update-interval');
    const status = content.querySelector('.store-settings-status');

    // Without the service → error message in the status line.
    interval.value = '15';
    interval.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(status.textContent).toBe('The update service is unavailable. Restart AstroOS and try again.');

    // With the service → recorded and echoed.
    const serviceCalls = [];
    window.StoreUpdateService = {
      setIntervalMinutes: (v) => serviceCalls.push(v),
      getIntervalMinutes: () => 15,
      checkNow: async () => [],
    };
    interval.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(serviceCalls).toEqual(['15']);
    expect(status.textContent).toBe('Update checks set to 15 minutes.');

    // Back to the store.
    [...content.querySelectorAll('button')].find((b) => b.textContent.includes('Store')).click();
    expect(content.querySelector('.store-grid')).toBeTruthy();
  });
});
