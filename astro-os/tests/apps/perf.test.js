// tests/apps/perf.test.js — window app: dev gates, pause/reset controls,
// per-window DOM breakdown, browser NetworkLog mirroring, fetch patching and
// cleanup restoration. Canvas 2D is stubbed (jsdom has no canvas backend).
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

// Recording 2D context — drawChart() calls are observable through it.
function makeRecordingCtx() {
  const ops = [];
  return new Proxy({}, {
    get(target, prop) {
      if (prop === '_ops') return ops;
      if (prop in target) return target[prop];
      return (...args) => ops.push([prop, ...args]);
    },
    set(target, prop, value) {
      target[prop] = value;
      ops.push(['set:' + String(prop), value]);
      return true;
    },
  });
}

function stubCanvas(window) {
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!this._recordingCtx) this._recordingCtx = makeRecordingCtx();
    return this._recordingCtx;
  };
}

function makeOsStub({ windows = null } = {}) {
  const os = { settings: { get: (key) => key === 'devMode' } };
  if (windows) {
    os.windows = windows.map;
    os.focusedWindowId = windows.focused;
  }
  return os;
}

// Window-state fixture for the "DOM Nodes by Window" panel — the app counts
// w.content.querySelectorAll('*'), so a stand-in with a recorded length works.
function makeWindowFixture(appId, childCount) {
  return {
    appId,
    id: appId,
    content: { querySelectorAll: (sel) => (sel === '*' ? new Array(childCount) : []) },
  };
}

async function loadPerf({ osWindows = null, networkLog = null, fetch: fetchStub } = {}) {
  const loaded = await loadWindowApp('perf', {
    stubs: {
      ...(fetchStub ? { fetch: fetchStub } : {}),
      extra: {
        OS: makeOsStub({ windows: osWindows }),
        ...(networkLog ? { NetworkLog: networkLog } : {}),
      },
    },
  });
  stubCanvas(loaded.window);
  const state = { cleanups: [] };
  const content = initApp(loaded.app, { window: loaded.window, state });
  return { ...loaded, content, state };
}

const findBtn = (content, text) => [...content.querySelectorAll('button')].find((b) => b.textContent === text);
const statCard = (content, label) => {
  const card = [...content.querySelectorAll('div')]
    .find((d) => d.children.length === 2 && d.children[0].textContent === label);
  return card ? card.children[1] : null;
};
const networkLogList = (content) => {
  const header = [...content.querySelectorAll('h4')].find((h) => h.textContent === 'Network');
  return header.parentElement.nextElementSibling; // netHeader, then netList
};

describe("'Perf Monitor' app (js/apps/perf)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full dev-only app descriptor with the host', async () => {
    const { app } = await loadWindowApp('perf');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.perf');
    expect(app.name).toBe('Perf Monitor');
    expect(app.version).toBe('3.0.2');
    expect(app.category).toBe('developer');
    expect(app.devOnly).toBe(true);
    expect(app.description).toMatch(/FPS/);
    expect(app.defaultSize).toEqual([600, 500]);
    expect(app.minSize).toEqual([400, 350]);
  });

  it('shows the developer-mode gate when dev mode is off', async () => {
    const { app, window } = await loadWindowApp('perf', {
      stubs: { extra: { OS: { settings: { get: () => false } } } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Perf Monitor.');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('perf', {
      stubs: { AppDirs: null, extra: { OS: makeOsStub({}) } },
    });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
  });

  it('renders chart canvases, stat cards and the long-task fallback', async () => {
    const { content } = await loadPerf();
    expect(content.querySelector('#perf-chart-fps')).toBeTruthy();
    expect(content.querySelector('#perf-chart-mem')).toBeTruthy();
    expect(content.querySelector('#perf-chart-dom')).toBeTruthy();
    expect(content.textContent).toContain('FPS');
    expect(content.textContent).toContain('Memory (MB)');
    expect(content.textContent).toContain('DOM Nodes');
    expect(content.textContent).toContain('Long Task Log');
    expect(content.textContent).toContain('Network');
    // jsdom has no PerformanceObserver → unsupported-branch message + N/A stat.
    expect(content.textContent).toContain('Long task tracking not supported in this browser');
    // No OS.windows stub → per-window panel shows the empty state.
    expect(content.textContent).toContain('No windows open');
    // Initial stat placeholders.
    expect(statCard(content, 'FPS').textContent).toBe('--');
    expect(statCard(content, 'Memory').textContent).toBe('--');
  });

  it('lists per-window DOM node counts from OS.windows', async () => {
    const { content } = await loadPerf({
      osWindows: { map: new Map([['win-1', makeWindowFixture('com.test.heavy', 3)]]), focused: 'win-1' },
    });
    const section = [...content.querySelectorAll('h4')]
      .find((h) => h.textContent === 'DOM Nodes by Window').parentElement;
    expect(section.textContent).toContain('com.test.heavy');
    expect(section.textContent).toContain('3');

    // Malformed/legacy window entry without content → n/a, not a crash.
    const { content: content2 } = await loadPerf({
      osWindows: { map: new Map([['win-2', { appId: 'com.test.broken', id: 'win-2' }]]), focused: 'win-2' },
    });
    const section2 = [...content2.querySelectorAll('h4')]
      .find((h) => h.textContent === 'DOM Nodes by Window').parentElement;
    expect(section2.textContent).toContain('com.test.broken');
    expect(section2.textContent).toContain('n/a');
  });

  it('pauses and resumes sampling from the toolbar button', async () => {
    const { content } = await loadPerf();
    const pauseBtn = findBtn(content, 'Pause');
    pauseBtn.click();
    expect(pauseBtn.textContent).toBe('Resume');
    expect(pauseBtn.style.color).toBe('var(--accent)');
    pauseBtn.click();
    expect(pauseBtn.textContent).toBe('Pause');
    expect(pauseBtn.style.color).toBe('var(--text-primary)');
  });

  it('renders the first FPS sample after the ~500ms tick and clears on Reset', async () => {
    const { content } = await loadPerf();
    await settle(650); // one 500ms sampling tick

    const fpsEl = statCard(content, 'FPS');
    const memEl = statCard(content, 'Memory');
    const domEl = statCard(content, 'DOM Nodes');
    const longEl = statCard(content, 'Long Tasks');
    expect(fpsEl.textContent).toMatch(/^\d+ fps$/);
    // jsdom has no performance.memory → N/A branch.
    expect(memEl.textContent).toBe('N/A');
    expect(domEl.textContent).toMatch(/^\d+$/);
    // Long tasks unsupported → N/A.
    expect(longEl.textContent).toBe('N/A');
    // Healthy sample → no sustained-low alert colour.
    expect(fpsEl.style.color).toBe('rgb(63, 185, 80)');

    // The FPS chart actually drew a polyline in its signature green.
    const fpsCtx = content.querySelector('#perf-chart-fps')._recordingCtx;
    expect(fpsCtx._ops.some(([op, v]) => op === 'set:strokeStyle' && v === '#00ff00')).toBe(true);
    expect(fpsCtx._ops.some(([op]) => op === 'lineTo')).toBe(true);

    findBtn(content, 'Reset').click();
    expect(fpsEl.style.color).toBe('rgb(63, 185, 80)'); // alert state reset
    const memCtx = content.querySelector('#perf-chart-mem')._recordingCtx;
    expect(memCtx._ops.some(([op, v]) => op === 'set:strokeStyle' && v === '#67e8f9')).toBe(true);
  });

  it('mirrors browser NetworkLog entries and honors the source filter', async () => {
    let clears = 0;
    const networkLog = {
      entries: [
        { method: 'GET', url: 'https://cdn.test/a.png', statusCode: 200, tabTitle: 'Images Tab', time: 20 },
        { method: 'GET', url: 'https://api.test/data', statusCode: 500, tabTitle: 'Data Tab', time: 30 },
      ],
      getAll() { return this.entries; },
      clear() { clears++; },
      _renderFn: null,
    };
    const { content, window } = await loadPerf({ networkLog });
    const netList = networkLogList(content);

    expect(netList.textContent).toContain('https://api.test/data');
    expect(netList.textContent).toContain('browser · Data Tab');

    // Live push through the hook the app installed on window.NetworkLog.
    networkLog.entries.unshift({ method: 'POST', url: 'https://api.test/push', statusCode: 201, tabTitle: 'Data Tab', time: 40 });
    expect(typeof window.NetworkLog._renderFn).toBe('function');
    window.NetworkLog._renderFn();
    expect(netList.textContent).toContain('https://api.test/push');

    // Source filter 'os' hides every browser row.
    const sourceSelect = content.querySelector('select');
    sourceSelect.value = 'os';
    sourceSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(netList.textContent).toContain('No requests match the current filter');

    sourceSelect.value = 'all';
    sourceSelect.dispatchEvent(new window.Event('change', { bubbles: true }));

    // URL search filter.
    const searchInput = [...content.querySelectorAll('input')].find((i) => i.placeholder === 'Filter by URL…');
    searchInput.value = 'a.png';
    searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(netList.textContent).toContain('https://cdn.test/a.png');
    expect(netList.textContent).not.toContain('https://api.test/data');

    // Clear wipes the merged view and calls the browser log's clear().
    findBtn(content, 'Clear').click();
    expect(netList.textContent).toContain('No requests recorded yet');
    expect(clears).toBe(1);
  });

  it('patches window.fetch, records OS-level requests with body capture, and restores on cleanup', async () => {
    const originalFetch = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      clone() { return { text: () => Promise.resolve('{"hello":"world"}') }; },
      json: () => Promise.resolve({}),
    });
    const { content, window, state } = await loadPerf({ fetch: originalFetch });

    const patchedFetch = window.fetch;
    expect(patchedFetch).not.toBe(originalFetch); // wrapper installed

    await window.fetch('/api/data');
    await settle(30);

    const netList = networkLogList(content);
    expect(netList.textContent).toContain('/api/data');
    expect(netList.textContent).toContain('200');
    expect(netList.textContent).toContain('os · unknown app');

    // Body toggle expands the captured response text.
    const bodyToggle = [...netList.querySelectorAll('span')].find((s) => s.textContent === '▸ body');
    expect(bodyToggle).toBeTruthy();
    bodyToggle.click();
    expect(netList.textContent).toContain('{"hello":"world"}');
    expect([...netList.querySelectorAll('span')].some((s) => s.textContent === '▾ body')).toBe(true);

    // Teardown (state.cleanups) restores the original fetch reference.
    for (const fn of state.cleanups) fn();
    expect(window.fetch).toBe(originalFetch);
  });
});
