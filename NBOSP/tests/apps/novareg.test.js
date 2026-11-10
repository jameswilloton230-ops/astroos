// tests/apps/novareg.test.js — NovaReg registry editor: dev-mode gating and
// the friendly-name layer (info strip under the values header, tree row
// tooltips), including dynamic app-name resolution from the installed
// inventory (HKNS/apps/installed) and the HKNU/settings humanized fallback.
// The editor talks to window.NovaRegistry directly, so these tests stub the
// engine surface the editor touches and drive the real DOM.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const LISTINGS = {
  HKNS: { path: 'HKNS', keys: ['apps', 'shell'], values: {} },
  'HKNS/apps': { path: 'HKNS/apps', keys: ['installed'], values: {} },
  'HKNS/apps/installed': { path: 'HKNS/apps/installed', keys: [], values: {} },
  HKNU: { path: 'HKNU', keys: ['settings', 'software'], values: {} },
  'HKNU/settings': { path: 'HKNU/settings', keys: ['fontSize'], values: {} },
  'HKNU/settings/fontSize': {
    path: 'HKNU/settings/fontSize',
    keys: [],
    values: { fontSize: { type: 'REG_DWORD', data: 14, lastModified: 0 } },
  },
  HKNA: { path: 'HKNA', keys: ['com.acme.paint'], values: {} },
  'HKNA/com.acme.paint': {
    path: 'HKNA/com.acme.paint',
    keys: [],
    values: { brush: { type: 'REG_SZ', data: 'round', lastModified: 0 } },
  },
  HKND: { path: 'HKND', keys: [], values: {} },
};

const INVENTORY = [
  { id: 'com.acme.paint', name: 'Paint' },
  { id: 'com.nbosp.browser', name: 'Nova Browser' },
];

function makeRegistryStub() {
  return {
    HIVES: ['HKNS', 'HKNU', 'HKNA', 'HKND'],
    DEFAULT_VALUE_NAME: '(default)',
    get: (path) => (path === 'HKNS/apps/installed' ? INVENTORY : undefined),
    list: (path) => LISTINGS[path] || { path, keys: [], values: {} },
    set: vi.fn(),
  };
}

function makeOS(devMode) {
  return { settings: { get: (key) => (key === 'devMode' ? devMode : undefined) }, events: { on: vi.fn() } };
}

async function loadEditor({ devMode = true, registry = makeRegistryStub() } = {}) {
  const loaded = await loadWindowApp('novareg', {
    stubs: { extra: { OS: makeOS(devMode), NovaRegistry: registry } },
  });
  const { window } = loaded;
  const state = { cleanups: [] };
  const content = initApp(loaded.app, { window, state });
  await settle();
  return { ...loaded, state, content };
}

// Tree rows prefix their label with a caret glyph; strip it for lookups.
function treeRow(content, label) {
  const rows = [...content.querySelectorAll('div')].filter(
    (row) => row.textContent.replace(/[▾▸·]/g, '').trim() === label,
  );
  return rows[0] || null;
}

function click(window, node) {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

describe('NovaReg app (js/apps/novareg)', () => {
  beforeEach(() => resetTestStorage());

  it('registers the dev-mode editor descriptor', async () => {
    const { app } = await loadWindowApp('novareg');
    expect(app.id).toBe('com.nbosp.novareg');
    expect(app.name).toBe('NovaReg');
    expect(app.devOnly).toBe(true);
    expect(app.category).toBe('developer');
    expect(app.version).toBe('1.2.0');
  });

  it('refuses to start without the registry engine or Developer Mode', async () => {
    const absent = await loadWindowApp('novareg', { stubs: { extra: { NovaRegistry: null } } });
    const state = { cleanups: [] };
    const content = initApp(absent.app, { window: absent.window, state });
    expect(content.textContent).toContain('engine not available');

    const gated = await loadEditor({ devMode: false });
    expect(gated.content.textContent).toContain('Enable Developer Mode');
  });

  it('shows a friendly name for the selected key at boot and after navigation', async () => {
    const { content, window } = await loadEditor();
    // Boot selection is the HKNS hive root.
    expect(content.textContent).toContain('System (machine)');
    expect(content.textContent).toContain('Machine-wide configuration');

    // Drill into HKNS/apps/installed and the strip follows.
    click(window, treeRow(content, 'apps'));
    await settle();
    click(window, treeRow(content, 'installed'));
    await settle();
    expect(content.textContent).toContain('Installed app inventory');
  });

  it('labels tree rows and resolves HKNA subtrees to the installed app name', async () => {
    const { content, window } = await loadEditor();
    click(window, treeRow(content, 'apps'));
    await settle();
    const installedRow = treeRow(content, 'installed');
    expect(installedRow).toBeTruthy();
    expect(installedRow.title).toContain('Installed app inventory');
    expect(installedRow.title).toContain('HKNS/apps/installed');

    // Third-party config: the display name comes from the inventory.
    click(window, treeRow(content, 'HKNA'));
    await settle();
    click(window, treeRow(content, 'com.acme.paint'));
    await settle();
    expect(content.textContent).toContain('App config — Paint');
    expect(content.textContent).toContain("The app's own config subtree");
  });

  it('humanizes HKNU/settings keys and names the default software slice', async () => {
    const { content, window } = await loadEditor();
    click(window, treeRow(content, 'HKNU'));
    await settle();
    click(window, treeRow(content, 'settings'));
    await settle();
    click(window, treeRow(content, 'fontSize'));
    await settle();
    expect(content.textContent).toContain('Font Size');
    expect(content.textContent).toContain('User setting (Settings app mirror)');

    // Unknown app under HKNU/software still resolves (fail-soft, id shown).
    click(window, treeRow(content, 'HKNU'));
    await settle();
    expect(content.textContent).toContain('Current user');
  });
});
