// tests/apps/inspector.test.js — window app: registry/window inspection,
// filtering, detail expansion, WM actions, live event refresh, export payload.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

function makeOS({ windows = new Map(), focusedWindowId = null } = {}) {
  const handlers = new Map();
  return {
    settings: { get: (key) => (key === 'devMode' ? true : undefined) },
    windows,
    focusedWindowId,
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

const REGISTRY = [
  { id: 'com.nbosp.clock', name: 'Clock', version: '3.0.2', launchCount: 4, verified: true, category: 'utilities', description: 'Clocks and timers', devOnly: false, autoGrant: false, defaultSize: [420, 480], minSize: [300, 300], permissions: ['fs:access'] },
  { id: 'com.nbosp.devconsole', name: 'Console', version: '3.0.2', category: 'developer', devOnly: true, description: 'Evaluate JS in the OS context', defaultSize: [600, 500], minSize: [400, 300] },
];

function winState(over = {}) {
  return { id: 'w1', appId: 'com.nbosp.clock', x: 10, y: 20, width: 800, height: 600, minimized: false, maximized: false, content: {}, ...over };
}

async function loadInspector({ windows = new Map(), focusedWindowId = null } = {}) {
  const loaded = await loadWindowApp('inspector', {
    stubs: {
      extra: {
        OS: makeOS({ windows, focusedWindowId }),
        APP_REGISTRY: REGISTRY,
        WM: { focusWindow: vi.fn(), closeWindow: vi.fn(), createWindow: vi.fn() },
        Notify: { show: vi.fn() },
        // Inspector installs a 2s polling fallback; stub it out in tests.
        setInterval: () => 0,
      },
    },
  });
  const { app, window } = loaded;
  const state = { cleanups: [] };
  const content = initApp(app, { window, state });
  // First paint is deferred: init schedules render via setTimeout(…, 100).
  await settle(160);
  return { ...loaded, OS: window.OS, state, content };
}

describe('Inspector app (js/apps/inspector)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('inspector');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.inspector');
    expect(app.name).toBe('Inspector');
    expect(app.devOnly).toBe(true);
    expect(app.category).toBe('developer');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toContain('Inspect registered apps');
    expect(app.defaultSize).toEqual([700, 550]);
    expect(app.minSize).toEqual([420, 350]);
    expect(typeof app.init).toBe('function');
  });

  it('refuses to run when Developer Mode is disabled', async () => {
    const { app, window } = await loadWindowApp('inspector');
    window.OS = { settings: { get: () => false } };
    const content = initApp(app, { window });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Inspector.');
    expect(content.querySelector('input')).toBeNull();
  });

  it('lists registered apps and open windows with badges and geometry', async () => {
    const windows = new Map([['w1', winState()]]);
    const { content } = await loadInspector({ windows, focusedWindowId: 'w1' });
    expect(content.textContent).toContain('Registered Apps (2)');
    expect(content.textContent).toContain('Open Windows (1)');
    expect(content.textContent).toContain('Clock');
    expect(content.textContent).toContain('id: com.nbosp.clock · version: 3.0.2 · launchCount: 4');
    expect(content.textContent).toContain('✓ verified');
    expect(content.textContent).toContain('1 perms');
    expect(content.textContent).toContain('Permissions: fs:access');
    // Window row: friendly name + raw id + geometry + focused badge
    expect(content.textContent).toContain('w1');
    expect(content.textContent).toContain('10,20 800x600');
    const focused = [...content.querySelectorAll('span')].find((s) => s.textContent === 'focused');
    expect(focused).toBeTruthy();
  });

  it('filters both sections by app id, name or window id', async () => {
    const windows = new Map([['w1', winState()]]);
    const { content, window } = await loadInspector({ windows });
    const filter = content.querySelector('input');
    filter.value = 'clock';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('Registered Apps (1)');
    expect(content.textContent).toContain('Open Windows (1)'); // w1.appId matches too
    expect(content.textContent).not.toContain('Console');

    filter.value = 'zzz-nothing';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('No apps match filter');
    expect(content.textContent).toContain('No windows match filter');
  });

  it('expands an app row into a detail panel and collapses it again', async () => {
    const { content } = await loadInspector();
    const headers = [...content.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer');
    headers[0].click(); // Clock row header
    expect(content.textContent).toContain('description');
    expect(content.textContent).toContain('Clocks and timers');
    expect(content.textContent).toContain('category');
    expect(content.textContent).toContain('utilities');
    expect(content.textContent).toContain('devOnly');
    expect(content.textContent).toContain('defaultSize');
    expect(content.textContent).toContain('420 x 480');
    expect(content.textContent).toContain('raw permissions:');
    expect(content.textContent).toContain('"fs:access"');
    // Collapse
    const headers2 = [...content.querySelectorAll('div')].filter((d) => d.style.cursor === 'pointer');
    headers2[0].click();
    expect(content.textContent).not.toContain('Clocks and timers');
  });

  it('drives windows through the Focus / Close / Close All buttons', async () => {
    const windows = new Map([
      ['w1', winState({ id: 'w1' })],
      ['w2', winState({ id: 'w2' })],
    ]);
    const { content, window } = await loadInspector({ windows });
    const focusBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Focus');
    focusBtn.click();
    expect(window.WM.focusWindow).toHaveBeenCalledWith('w1');

    const closeBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    closeBtn.click();
    expect(window.WM.closeWindow).toHaveBeenCalledWith('w1');

    // The Clock app has two open windows → per-app "Close All (2)"
    const closeAll = [...content.querySelectorAll('button')].find((b) => b.textContent.startsWith('Close All'));
    expect(closeAll.textContent).toBe('Close All (2)');
    closeAll.click();
    expect(window.WM.closeWindow).toHaveBeenCalledWith('w1');
    expect(window.WM.closeWindow).toHaveBeenCalledWith('w2');
  });

  it('re-renders live when the shell emits app lifecycle events', async () => {
    const windows = new Map();
    const { content, OS, window } = await loadInspector({ windows });
    expect(content.textContent).toContain('Open Windows (0)');
    expect(content.textContent).toContain('No windows open');

    OS.windows.set('w9', winState({ id: 'w9', appId: 'com.nbosp.devconsole' }));
    OS.events.emit('app:opened', { id: 'w9' });
    await settle();
    expect(content.textContent).toContain('Open Windows (1)');
    expect(content.textContent).toContain('Console'); // friendly name resolved via registry

    // A changed focused id re-renders (adds the focused badge)…
    OS.focusedWindowId = 'w9';
    OS.events.emit('app:focused', { id: 'w9' });
    await settle();
    expect([...content.querySelectorAll('span')].some((s) => s.textContent === 'focused')).toBe(true);

    // …but a REDUNDANT focus event for the same id must not re-render again
    const htmlBefore = content.innerHTML;
    OS.events.emit('app:focused', { id: 'w9' }); // same id → guard skips render
    expect(content.innerHTML).toBe(htmlBefore);
  });

  it('exports the filtered snapshot as JSON through a blob download', async () => {
    const windows = new Map([['w1', winState()]]);
    const { content, window } = await loadInspector({ windows, focusedWindowId: 'w1' });
    const created = [];
    window.URL.createObjectURL = (blob) => { created.push(blob); return 'blob:test'; };
    window.URL.revokeObjectURL = () => {};

    const filter = content.querySelector('input');
    filter.value = 'clock';
    filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    const exportBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Export');
    exportBtn.click();
    await settle();

    expect(created).toHaveLength(1);
    const payload = JSON.parse(await created[0].text());
    expect(payload.filter).toBe('clock');
    expect(payload.apps.map((a) => a.id)).toEqual(['com.nbosp.clock']);
    expect(payload.apps[0]).toMatchObject({ name: 'Clock', verified: true, launchCount: 4 });
    expect(payload.windows).toHaveLength(1);
    expect(payload.windows[0]).toMatchObject({ id: 'w1', appId: 'com.nbosp.clock', width: 800, focused: true });
  });

  it('unregisters its live listeners via state.cleanups', async () => {
    const { OS, state, content, window } = await loadInspector();
    expect(typeof state.cleanups[0]).toBe('function');
    expect(content.textContent).toContain('Registered Apps (2)');
    state.cleanups[state.cleanups.length - 1](); // wm teardown
    // After teardown, emitting events must not throw or re-render
    const htmlBefore = content.innerHTML;
    OS.windows.set('wX', winState({ id: 'wX' }));
    OS.events.emit('app:opened', { id: 'wX' });
    await settle();
    expect(content.innerHTML).toBe(htmlBefore);
    expect(window).toBeTruthy();
  });
});
