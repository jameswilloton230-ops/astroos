// tests/apps/events.test.js — window app: dev-mode/service gates, event log
// filtering, correlation clusters, detail panel, pause, alert rules, saved views.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const FILTERS_KEY = 'nova_events_app_filters';
const ALERTS_KEY = 'nova_events_alerts';
const VIEWS_KEY = 'nova_events_views';

function makeEventLog(initial = []) {
  const store = [...initial];
  const listeners = new Set();
  return {
    getCategories: () => ['console', 'permission', 'package'],
    getAll: () => [...store],
    clear: () => { store.length = 0; },
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    log(entry) { store.unshift(entry); },
    emit: () => { for (const cb of [...listeners]) cb(); },
  };
}

function evt(over = {}) {
  return {
    id: 'e-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    severity: 'info',
    app: 'System',
    category: 'console',
    message: 'something happened',
    data: null,
    ...over,
  };
}

async function loadEvents({ devMode = true, withEventLog = makeEventLog(), registry = null } = {}) {
  const showModal = vi.fn((title, body) => {
    const box = window.document.createElement('div');
    box.dataset.testModal = String(title);
    if (typeof body === 'string') box.textContent = body;
    else box.appendChild(body);
    window.document.body.appendChild(box);
    return Promise.resolve();
  });
  const showPrompt = vi.fn(() => Promise.resolve('Errors only'));
  const loaded = await loadWindowApp('events', {
    stubs: {
      extra: {
        OS: {
          settings: { get: (key) => (key === 'devMode' ? devMode : undefined), set: vi.fn() },
          windows: new Map(),
          focusedWindowId: null,
          events: { on: vi.fn(), off: vi.fn() },
        },
        Notify: { show: vi.fn() },
        showModal,
        showPrompt,
        ...(registry ? { NovaRegistry: registry } : {}),
        ...(withEventLog ? { EventLog: withEventLog } : {}),
      },
    },
  });
  const { app, window } = loaded;
  const state = { cleanups: [] };
  const content = initApp(app, { window, state });
  return { ...loaded, EventLog: withEventLog, showModal, showPrompt, state, content };
}

describe('Events app (js/apps/events)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('events');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.events');
    expect(app.name).toBe('Events');
    expect(app.devOnly).toBe(true);
    expect(app.category).toBe('developer');
    expect(app.version).toBe('3.0.2');
    expect(app.defaultSize).toEqual([700, 520]);
    expect(app.minSize).toEqual([420, 320]);
    expect(app.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(typeof app.init).toBe('function');
  });

  it('refuses to run when Developer Mode is disabled', async () => {
    const { app, window } = await loadWindowApp('events');
    window.OS = { settings: { get: () => false } };
    const content = initApp(app, { window });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Events.');
    expect(content.querySelector('input')).toBeNull();
  });

  it('reports a missing EventLog service instead of crashing', async () => {
    const { content } = await loadEvents({ withEventLog: null });
    expect(content.textContent).toContain('EventLog service is not available in this context.');
  });

  it('renders the toolbar and lists entries with severity, app and category', async () => {
    const log = makeEventLog([
      evt({ message: 'first message', severity: 'error', app: 'Email', category: 'console' }),
      evt({ message: 'second message', severity: 'info', app: 'Clock' }),
    ]);
    const { content } = await loadEvents({ withEventLog: log });
    expect(content.querySelector('input[placeholder^="Filter by message"]').placeholder)
      .toBe('Filter by message, app, or appId…');
    // Category select is populated from EventLog.getCategories()
    const categorySelect = [...content.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.textContent === 'All categories'));
    expect([...categorySelect.options].map((o) => o.value)).toEqual(['', 'console', 'permission', 'package']);
    // Count line + rows (newest first)
    expect(content.textContent).toContain('2 events');
    const rows = [...content.querySelectorAll('span')].filter((d) => d.textContent === 'ERROR' || d.textContent === 'INFO');
    expect(rows.map((r) => r.textContent)).toEqual(['ERROR', 'INFO']); // newest first
    expect(content.textContent).toContain('[Email]');
    expect(content.textContent).toContain('[Clock]');
    expect(content.textContent).toContain('first message');
  });

  it('filters by search text and persists the active filters', async () => {
    const log = makeEventLog([
      evt({ id: 'a', message: 'alpha event' }),
      evt({ id: 'b', message: 'gamma event', app: 'Files' }),
    ]);
    const { content, window } = await loadEvents({ withEventLog: log });
    const searchInput = content.querySelector('input[placeholder^="Filter by message"]');
    searchInput.value = 'gamma';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('1 of 2 events');
    expect(content.textContent).toContain('gamma event');
    expect(content.textContent).not.toContain('alpha event');
    const saved = JSON.parse(window.localStorage.getItem(FILTERS_KEY));
    expect(saved.searchQuery).toBe('gamma');

    // Severity filter narrows further and persists too
    const severitySelect = [...content.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.textContent === 'All severities'));
    severitySelect.value = 'error';
    severitySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(content.textContent).toContain('0 of 2 events');
    expect(JSON.parse(window.localStorage.getItem(FILTERS_KEY)).severityFilter).toBe('error');
    // The empty-filter message is distinct from the empty-log message
    expect(content.textContent).toContain('No events match the current filter.');
  });

  it('clusters correlated events that share an appId within the time window', async () => {
    const t = Date.now();
    const log = makeEventLog([
      evt({ id: 'burst-1', timestamp: t, message: 'launch app', data: { appId: 'com.x' } }),
      evt({ id: 'burst-2', timestamp: t - 500, message: 'permission check', data: { appId: 'com.x' } }),
      evt({ id: 'solo', timestamp: t - 9000, message: 'unrelated', data: { appId: 'com.y' } }),
    ]);
    const { content } = await loadEvents({ withEventLog: log });
    expect(content.textContent).toContain('+1 related');
    // The cluster head is the newest entry; the second is indented below it
    const badge = [...content.querySelectorAll('span')].find((s) => s.textContent === '+1 related');
    expect(badge).toBeTruthy();
    expect(content.textContent).toContain('launch app');
    expect(content.textContent).toContain('permission check');
  });

  it('opens a detail panel with the data payload and related breadcrumbs', async () => {
    const t = Date.now();
    const log = makeEventLog([
      evt({ id: 'main', timestamp: t, message: 'window opened', data: { appId: 'com.z', extra: 'payload' } }),
      evt({ id: 'rel', timestamp: t - 1000, message: 'related check', data: { appId: 'com.z' } }),
      evt({ id: 'far', timestamp: t - 30000, message: 'too old to relate', data: { appId: 'com.z' } }),
    ]);
    const { content } = await loadEvents({ withEventLog: log });
    const detailPanel = [...content.querySelectorAll('div')].find((d) => d.style.display === 'none');
    expect(detailPanel.style.display).toBe('none');

    // Click the newest row (first row in the list) → detail opens
    const rows = [...content.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer');
    rows[0].click();
    expect(detailPanel.style.display).toBe('block');
    expect(detailPanel.textContent).toContain('window opened');
    expect(detailPanel.textContent).toContain('Data payload');
    expect(detailPanel.textContent).toContain('"extra": "payload"');
    // Related: same appId within ±3s — includes rel, excludes far
    expect(detailPanel.textContent).toContain('Related events');
    expect(detailPanel.textContent).toContain('related check');
    expect(detailPanel.textContent).not.toContain('too old to relate');

    // Close button hides it again
    const closeBtn = [...detailPanel.querySelectorAll('button')].find((b) => b.textContent === '✕');
    closeBtn.click();
    expect(detailPanel.style.display).toBe('none');
  });

  it('pauses live updates and resumes with a fresh render', async () => {
    const log = makeEventLog([evt({ message: 'before pause' })]);
    const { content } = await loadEvents({ withEventLog: log });
    const pauseBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Pause');
    pauseBtn.click();
    expect(pauseBtn.textContent).toBe('Resume');

    // A new event while paused does NOT appear
    log.log(evt({ message: 'while paused' }));
    log.emit();
    expect(content.textContent).not.toContain('while paused');
    expect(content.textContent).toContain('1 event');

    pauseBtn.click(); // Resume
    expect(pauseBtn.textContent).toBe('Pause');
    expect(content.textContent).toContain('while paused');
    expect(content.textContent).toContain('2 events');
  });

  it('adds alert rules through the modal and fires them on matching new events', async () => {
    const log = makeEventLog([evt({ message: 'startup' })]);
    const { content, window } = await loadEvents({ withEventLog: log });
    const Notify = window.Notify;

    const alertsBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === '⚡ Alerts');
    alertsBtn.click();
    await settle();
    const modal = window.document.querySelector('[data-test-modal="Alert rules"]');
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain('No alert rules yet.');

    modal.querySelector('input[placeholder="Rule name"]').value = 'boom-alert';
    const sevSelect = modal.querySelector('select');
    sevSelect.value = 'error';
    modal.querySelector('input[placeholder^="Message contains"]').value = 'boom';
    [...modal.querySelectorAll('button')].find((b) => b.textContent === '+ Add rule').click();
    // Rule persisted and listed
    const rules = JSON.parse(window.localStorage.getItem(ALERTS_KEY));
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'boom-alert', severity: 'error', contains: 'boom', enabled: true });
    expect(modal.textContent).toContain('[error] */* "boom"');

    // New matching event flows through the live subscription → Notify fires
    Notify.show.mockClear();
    log.log(evt({ severity: 'error', message: 'BOOM! something broke', timestamp: Date.now() }));
    log.emit();
    expect(Notify.show).toHaveBeenCalledTimes(1);
    expect(Notify.show.mock.calls[0][0].title).toBe('⚡ Alert: boom-alert');
    expect(Notify.show.mock.calls[0][0].type).toBe('error');
    // Rate limit marker persisted on the rule
    expect(JSON.parse(window.localStorage.getItem(ALERTS_KEY))[0].lastFiredAt).toBeGreaterThan(0);
  });

  it('saves the current filters as a named view via the prompt flow', async () => {
    const log = makeEventLog([evt({ message: 'x' })]);
    const { content, window, showPrompt } = await loadEvents({ withEventLog: log });
    const searchInput = content.querySelector('input[placeholder^="Filter by message"]');
    searchInput.value = 'needle';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    const saveViewBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === '+ Save view');
    saveViewBtn.click();
    await settle();
    expect(showPrompt).toHaveBeenCalledTimes(1);
    const views = JSON.parse(window.localStorage.getItem(VIEWS_KEY));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ name: 'Errors only', searchQuery: 'needle', sortOrder: 'newest' });
    // The saved view is now selectable in the dropdown
    const savedViewSelect = [...content.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.textContent === 'Saved views…'));
    expect([...savedViewSelect.options].map((o) => o.textContent)).toContain('Errors only');
  });

  it('records the current session id into the sessions log', async () => {
    const { window } = await loadEvents({ withEventLog: makeEventLog() });
    const sessions = JSON.parse(window.localStorage.getItem('nova_events_sessions'));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toMatch(/^session_\d{4}-\d{2}-\d{2}_\d{4}$/);
    expect(typeof sessions[0].startedAt).toBe('number');
  });

  it('records sessions into HKND/events/sessions when the registry engine is up', async () => {
    const store = new Map();
    const registry = {
      get: (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined),
      set: (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); return true; },
      stat: (p) => (store.has(p) ? { name: '(default)', type: 'REG_JSON' } : null),
    };
    const { window } = await loadEvents({ withEventLog: makeEventLog(), registry });
    const sessions = store.get('HKND/events/sessions');
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toMatch(/^session_\d{4}-\d{2}-\d{2}_\d{4}$/);
    // The legacy key stays untouched while the hive is up.
    expect(window.localStorage.getItem('nova_events_sessions')).toBeNull();
  });
});
