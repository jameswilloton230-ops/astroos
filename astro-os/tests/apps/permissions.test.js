// tests/apps/permissions.test.js — window app: app list with grant counts,
// per-app detail with grant/revoke/reset actions, consent log with cutoff
// persistence, and degraded behaviour without AppPermissionManager.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const CUTOFF_KEY = 'astroos_permissions_log_cutoff';

const DEV_OS = { settings: { get: (key) => key === 'devMode' } };

const APP_REGISTRY_FIXTURE = [
  { id: 'com.test.photo', name: 'Photo Editor', permissions: ['fs:read:images'] },
  { id: 'com.test.notes', name: 'Notes', permissions: [] },
];

// In-memory AppPermissionManager mirroring the real manager's contract:
// grants are keyed per permission+app, revoke marks denied, reset clears.
function makeManagerStub({ grants = {}, log = [] } = {}) {
  const state = { ...grants };
  const calls = [];
  const key = (p, id) => `${p}|${id}`;
  const entry = (p, id) => state[key(p, id)];
  return {
    calls,
    PERMISSION_CATEGORIES: {
      'fs:read:images': { label: 'Read shared images', risk: 'low' },
      'fs:access': { label: 'Manage all files (special access)', risk: 'critical' },
      'net:internal': { label: 'Internal network', risk: 'medium' },
      'system:info': { label: 'System info', risk: 'low' },
    },
    isGranted: (p, id) => entry(p, id)?.granted === true,
    isDenied: (p, id) => entry(p, id)?.granted === false,
    getAppPermissions: (appId) => Object.entries(state)
      .filter(([k]) => k.endsWith('|' + appId))
      .map(([k, v]) => ({ permission: k.split('|')[0], ...v })),
    getConsentLog: () => log.slice(),
    grantPermission: async (p, id, opts = {}) => {
      calls.push(['grant', p, id, opts]);
      state[key(p, id)] = { granted: true, grantedAt: Date.now(), permanent: true };
      return true;
    },
    revokePermission: async (p, id) => {
      calls.push(['revoke', p, id]);
      state[key(p, id)] = { granted: false, grantedAt: Date.now(), permanent: false };
    },
    resetPermission: async (p, id) => {
      calls.push(['reset', p, id]);
      delete state[key(p, id)];
    },
    revokeAllPermissions: async (appId) => {
      calls.push(['revokeAll', appId]);
      for (const k of Object.keys(state)) if (k.endsWith('|' + appId)) delete state[k];
    },
  };
}

const BOOTSTRAP_MAP = {
  'com.test.photo': { normal: ['system:info'], dangerous: ['fs:access'] },
};

async function loadPermissions({ manager, registry = APP_REGISTRY_FIXTURE, extra = {} } = {}) {
  const loaded = await loadWindowApp('permissions', {
    stubs: {
      extra: {
        OS: DEV_OS,
        ...(manager ? { AppPermissionManager: manager } : {}),
        ...(registry ? { APP_REGISTRY: registry } : {}),
        ...(registry ? { AppPermissionsMap: BOOTSTRAP_MAP } : {}),
        ...extra,
      },
    },
  });
  const content = initApp(loaded.app, { window: loaded.window, state: { cleanups: [] } });
  // The app defers its first render() by 100ms (see setTimeout in init).
  await settle(150);
  return { ...loaded, content };
}

const clickTabBtn = (content, text) =>
  [...content.querySelectorAll('button')].find((b) => b.textContent === text).click();

describe("'Permissions' app (js/apps/permissions)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full dev-only app descriptor with the host', async () => {
    const { app } = await loadWindowApp('permissions');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.permissions');
    expect(app.name).toBe('Permissions');
    expect(app.version).toBe('3.0.2');
    expect(app.category).toBe('developer');
    expect(app.devOnly).toBe(true);
    expect(app.description).toMatch(/permissions/i);
    expect(app.defaultSize).toEqual([720, 600]);
    expect(app.minSize).toEqual([480, 400]);
  });

  it('shows the developer-mode gate when dev mode is off', async () => {
    const { app, window } = await loadWindowApp('permissions', {
      stubs: { extra: { OS: { settings: { get: () => false } } } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Permissions.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('permissions', {
      stubs: { AppDirs: null, extra: { OS: DEV_OS } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
  });

  it('renders the app table with granted/denied/pending counts and the risk glossary', async () => {
    const manager = makeManagerStub({
      grants: { 'fs:access|com.test.photo': { granted: true } },
    });
    const { content } = await loadPermissions({ manager });

    const table = content.querySelector('table');
    expect(table).toBeTruthy();
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.cells[0].textContent)).toEqual(['Photo Editor', 'Notes']);

    // Photo Editor: 3 effective perms (declared fs:read:images + bootstrap
    // system:info + fs:access), one of which is granted.
    expect(rows[0].cells[1].textContent).toBe('1'); // granted
    expect(rows[0].cells[2].textContent).toBe('0'); // denied
    expect(rows[0].cells[3].textContent).toBe('2'); // pending
    // 'Revoke all' exists because granted > 0.
    expect([...rows[0].querySelectorAll('button')].some((b) => b.textContent === 'Revoke all')).toBe(true);

    // Notes declares nothing and has no bootstrap entry → zero column values.
    expect(rows[1].cells[1].textContent).toBe('0');
    expect(rows[1].cells[3].textContent).toBe('0');

    // Glossary sourced from PERMISSION_CATEGORIES with risk colours.
    expect(content.textContent).toContain('Permission Types');
    expect(content.textContent).toContain('fs:access');
    expect(content.textContent).toContain('Manage all files (special access) · critical');
  });

  it('filters the app list by name or id', async () => {
    const manager = makeManagerStub();
    const { content, window } = await loadPermissions({ manager });
    const search = content.querySelector('input[placeholder="Filter by app name or id…"]');

    search.value = 'photo';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    let rows = [...content.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.cells[0].textContent)).toEqual(['Photo Editor']);

    search.value = 'zzz';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('No apps match "zzz"');
    expect(content.querySelector('table')).toBeNull();
  });

  it('drills into an app, shows tiers, and grants a pending permission', async () => {
    const manager = makeManagerStub();
    const { content } = await loadPermissions({ manager });

    const row = [...content.querySelectorAll('tbody tr')][0];
    row.click();

    // Detail header.
    expect(content.querySelector('h3').textContent).toBe('Photo Editor');
    expect(content.textContent).toContain('com.test.photo');
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === '‹ All apps')).toBe(true);

    // Effective permission rows with tier labels from the union logic.
    expect(content.textContent).toContain('fs:read:images');
    expect(content.textContent).toContain('tier: declared');
    expect(content.textContent).toContain('system:info');
    expect(content.textContent).toContain('tier: normal');
    expect(content.textContent).toContain('fs:access');
    expect(content.textContent).toContain('tier: dangerous');

    // Grant the pending fs:read:images permission.
    const grantBtn = [...content.querySelectorAll('button')]
      .find((b) => b.textContent === 'Grant (no prompt)');
    expect(grantBtn).toBeTruthy();
    grantBtn.click();
    await settle(20);

    expect(manager.calls.some(([kind, p, id, opts]) =>
      kind === 'grant' && p === 'fs:read:images' && id === 'com.test.photo' &&
      opts?.reason === 'Granted via Permissions dev tool')).toBe(true);
    // Status badge flips to granted (CSS uppercases it visually).
    expect([...content.querySelectorAll('span')].some((s) => s.textContent === 'granted')).toBe(true);

    // Bulk bar offers revoke-all for the now-granted permission.
    expect([...content.querySelectorAll('button')]
      .some((b) => b.textContent.startsWith('Revoke all granted'))).toBe(true);

    // Back to the list.
    [...content.querySelectorAll('button')].find((b) => b.textContent === '‹ All apps').click();
    expect(content.querySelector('table')).toBeTruthy();
  });

  it('revokes and resets a granted permission from the detail view', async () => {
    const manager = makeManagerStub({
      grants: { 'fs:access|com.test.photo': { granted: true } },
    });
    const { content } = await loadPermissions({ manager });

    [...content.querySelectorAll('tbody tr')][0].click();
    expect(content.textContent).toContain('fs:access');

    const revokeBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Revoke');
    expect(revokeBtn).toBeTruthy();
    revokeBtn.click();
    await settle(20);

    expect(manager.calls.some(([kind, p]) => kind === 'revoke' && p === 'fs:access')).toBe(true);
    // Revoked → denied state with a reset affordance.
    expect([...content.querySelectorAll('span')].some((s) => s.textContent === 'denied')).toBe(true);
    const resetBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Reset to pending');
    expect(resetBtn).toBeTruthy();

    resetBtn.click();
    await settle(20);
    expect(manager.calls.some(([kind, p]) => kind === 'reset' && p === 'fs:access')).toBe(true);
    expect([...content.querySelectorAll('button')]
      .some((b) => b.textContent === 'Grant (no prompt)')).toBe(true);
  });

  it('revokes every grant for an app from the list without navigating away', async () => {
    const manager = makeManagerStub({
      grants: {
        'fs:access|com.test.photo': { granted: true },
        'fs:read:images|com.test.photo': { granted: true },
      },
    });
    const { content } = await loadPermissions({ manager });

    const row = [...content.querySelectorAll('tbody tr')][0];
    const revokeAllBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Revoke all');
    revokeAllBtn.click();
    await settle(20);

    expect(manager.calls.some(([kind, id]) => kind === 'revokeAll' && id === 'com.test.photo')).toBe(true);
    // stopPropagation kept us on the list view; counts refreshed to zero.
    expect(content.querySelector('table')).toBeTruthy();
    const rows = [...content.querySelectorAll('tbody tr')];
    expect(rows[0].cells[1].textContent).toBe('0');
  });

  it('shows the consent log newest-first with search and a persisted clear cutoff', async () => {
    const now = Date.now();
    const manager = makeManagerStub({
      log: [
        { granted: true, permission: 'fs:access', appId: 'com.test.photo', timestamp: now - 10000, reason: 'older grant' },
        { granted: false, permission: 'net:internal', appId: 'com.test.notes', timestamp: now, reason: 'recent deny' },
      ],
    });
    const { content, window } = await loadPermissions({ manager });

    clickTabBtn(content, 'Consent Log');
    const text = content.textContent;
    // Newest first (reversed copy of the chronological log).
    expect(text.indexOf('net:internal')).toBeLessThan(text.indexOf('fs:access'));
    expect(text).toContain('DENY · net:internal → com.test.notes');
    expect(text).toContain('GRANT · fs:access → com.test.photo');
    expect(text).toContain('reason: older grant');

    // Search narrows to matching entries.
    const search = content.querySelector('input[placeholder="Filter by app id or permission…"]');
    search.value = 'notes';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('net:internal');
    expect(content.textContent).not.toContain('GRANT · fs:access');

    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));

    // 'Clear view' persists a cutoff that hides every pre-cutoff entry.
    clickTabBtn(content, 'Apps'); // leave log view
    clickTabBtn(content, 'Consent Log');
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Clear view');
    clearBtn.click();

    expect(Number(window.localStorage.getItem(CUTOFF_KEY))).toBeGreaterThan(0);
    expect(content.textContent).toContain('No consent events recorded yet.');
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Show all')).toBe(true);

    // 'Show all' resets the cutoff to 0 and reveals history again.
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Show all').click();
    expect(window.localStorage.getItem(CUTOFF_KEY)).toBe('0');
    expect(content.textContent).toContain('GRANT · fs:access → com.test.photo');
  });

  it('restores a persisted cutoff on init (Show all offered immediately)', async () => {
    const manager = makeManagerStub({
      log: [{ granted: true, permission: 'fs:access', appId: 'com.test.photo', timestamp: 1 }],
    });
    const loaded = await loadWindowApp('permissions', {
      stubs: {
        extra: {
          OS: DEV_OS,
          AppPermissionManager: manager,
          APP_REGISTRY: APP_REGISTRY_FIXTURE,
          AppPermissionsMap: BOOTSTRAP_MAP,
        },
      },
    });
    loaded.window.localStorage.setItem(CUTOFF_KEY, String(Date.now() + 60000));
    const content = initApp(loaded.app, { window: loaded.window, state: { cleanups: [] } });

    clickTabBtn(content, 'Consent Log');
    expect([...content.querySelectorAll('button')].some((b) => b.textContent === 'Show all')).toBe(true);
    expect(content.textContent).toContain('No consent events recorded yet.');
  });

  it('degrades gracefully when AppPermissionManager is unavailable', async () => {
    const { content } = await loadPermissions({ manager: null });

    expect(content.textContent)
      .toContain('AppPermissionManager unavailable — showing app list only.');
    // Table still renders; pending column shows the unavailable marker.
    const rows = [...content.querySelectorAll('tbody tr')];
    expect(rows.length).toBe(2);
    expect(rows[0].cells[3].textContent).toBe('—');
    expect(rows[0].cells[3].title).toBe('AppPermissionManager unavailable');
    // No action buttons in the manager-less list.
    expect([...rows[0].querySelectorAll('button')]).toHaveLength(0);

    // Log tab reports the missing manager instead of rendering entries.
    clickTabBtn(content, 'Consent Log');
    expect(content.textContent).toContain('AppPermissionManager unavailable.');
  });
});
