// tests/apps/devconsole.test.js — window app: dev-mode gating, JS eval console,
// error capture, console.* capture, history persistence, autocomplete.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

const HISTORY_KEY = 'astroos_devconsole_history';

function makeOS(devMode) {
  return { settings: { get: (key) => (key === 'devMode' ? devMode : undefined) } };
}

// Loads the console app with the dev-mode gate open and a wm.js-style state.
async function loadConsole({ devMode = true } = {}) {
  const loaded = await loadWindowApp('devconsole', {
    stubs: { extra: { OS: makeOS(devMode), Notify: { show: vi.fn() } } },
  });
  const { app, window } = loaded;
  const state = { cleanups: [] };
  const content = initApp(app, { window, state });
  return { ...loaded, state, content };
}

function runCommand(window, content, code, how = 'enter') {
  const input = content.querySelector('textarea');
  input.value = code;
  if (how === 'enter') {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  } else {
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Run').click();
  }
  return settle(); // run() is async
}

describe('Console app (js/apps/devconsole)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('devconsole');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.devconsole');
    expect(app.name).toBe('Console');
    expect(app.devOnly).toBe(true);
    expect(app.category).toBe('developer');
    expect(app.version).toBe('3.0.2');
    expect(app.defaultSize).toEqual([600, 500]);
    expect(app.minSize).toEqual([400, 300]);
    // The icon is an inline base64 SVG data URL, not an icon-set key
    expect(app.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('devconsole', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('App data directory missing');
    // Quirk: the guard text names com.astroos.settings (copied from the Settings
    // app), not the console's own id.
    expect(content.textContent).toContain('com.astroos.settings');
  });

  it('refuses to run when Developer Mode is disabled', async () => {
    const { app, window } = await loadWindowApp('devconsole', {
      stubs: { extra: { OS: makeOS(false) } },
    });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('Enable Developer Mode in Settings to use Console.');
    expect(content.querySelector('textarea')).toBeNull(); // no console UI built
  });

  it('evaluates a command on Enter, prints the result and persists history', async () => {
    const { content, window } = await loadConsole();
    const input = content.querySelector('textarea');
    expect(input.placeholder).toContain('Enter JS to evaluate');
    const output = content.querySelector('pre');
    expect(output.textContent).toContain('Console ready.');

    await runCommand(window, content, '6 * 7');
    expect(output.textContent).toContain('> 6 * 7');
    expect(output.textContent).toContain('42');
    expect(output.textContent).not.toContain('Console ready.'); // first run resets the banner

    // Command stored (deduped) and the input cleared
    expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY))).toEqual(['6 * 7']);
    expect(input.value).toBe('');
  });

  it('prints eval errors without throwing and dedupes repeated history entries', async () => {
    const { content, window } = await loadConsole();
    await runCommand(window, content, 'JSON.parse("{oops")');
    const output = content.querySelector('pre');
    expect(output.textContent).toContain('> JSON.parse("{oops")');
    expect(output.textContent).toMatch(/Error: /);

    // Same command again → still appended to output but NOT to history
    await runCommand(window, content, 'JSON.parse("{oops")');
    expect(output.textContent.match(/Error: /g).length).toBe(2);
    expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY))).toHaveLength(1);

    // A different command does get recorded; corrupted history falls back to []
    await runCommand(window, content, '1 + 1', 'button');
    expect(output.textContent).toContain('> 1 + 1');
    expect(JSON.parse(window.localStorage.getItem(HISTORY_KEY))).toEqual(['JSON.parse("{oops")', '1 + 1']);
  });

  it('captures console.* output from eval-ed code with level markers', async () => {
    const { content, window } = await loadConsole();
    await runCommand(window, content, 'console.warn("careful", { code: 7 }); "done"');
    const output = content.querySelector('pre');
    expect(output.textContent).toContain('⚠ careful');
    expect(output.textContent).toContain('"code": 7'); // object arg pretty-printed
    expect(output.textContent).toContain('"done"');
  });

  it('formats special results: undefined, functions and DOM nodes', async () => {
    const { content, window } = await loadConsole();
    const output = content.querySelector('pre');
    await runCommand(window, content, 'undefined');
    expect(output.textContent).toContain('undefined');
    await runCommand(window, content, '(function namedFn(){})');
    expect(output.textContent).toContain('[Function: namedFn]');
    await runCommand(window, content, 'document.createElement("span")');
    expect(output.textContent).toContain('[SPAN]');
  });

  it('autocompletes dotted paths: suggests, accepts with Enter, hides with Escape', async () => {
    const { content, window, document } = await loadConsole();
    const input = content.querySelector('textarea');
    // init() appends exactly one element to document.body: the completion box
    // (the app content div is detached, like the window manager's content).
    const acBox = document.body.lastElementChild;
    expect(acBox.style.display).toBe('none');

    input.value = 'Math.m';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(acBox.style.display).toBe('block');
    const suggestions = [...acBox.children].map((c) => c.textContent);
    expect(suggestions).toEqual(['max', 'min']);

    // Enter accepts the highlighted (first) suggestion instead of running
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('Math.max');
    expect(acBox.style.display).toBe('none');

    // Reopen and Escape dismisses without changing the input
    input.value = 'Math.m';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(acBox.style.display).toBe('block');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(acBox.style.display).toBe('none');
    expect(input.value).toBe('Math.m');
  });

  it('recalls previous commands with ArrowUp/ArrowDown and restores the draft', async () => {
    const { content, window } = await loadConsole();
    await runCommand(window, content, 'first command');
    await runCommand(window, content, 'second command');
    const input = content.querySelector('textarea');

    // ArrowUp at position 0 recalls the last command, then the earlier one
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('second command');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('first command');

    // ArrowDown walks forward, then restores the (empty) draft. The app only
    // intercepts ArrowDown when the caret sits at the very end; after ArrowUp
    // the caret is parked at 0, so emulate the browser's default caret move
    // (single-line value → end) between the two presses.
    input.selectionStart = input.selectionEnd = input.value.length;
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.value).toBe('second command');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(input.value).toBe('');
  });

  it('clears the output buffer with the Clear button', async () => {
    const { content, window } = await loadConsole();
    await runCommand(window, content, '2 + 2');
    const output = content.querySelector('pre');
    expect(output.textContent).toContain('4');
    const clearBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Clear');
    clearBtn.click();
    expect(output.textContent).toBe('');
  });

  it('persists command history into HKND/console/history when the registry engine is up', async () => {
    const store = new Map();
    const registry = {
      get: (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined),
      set: (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); return true; },
      stat: (p) => (store.has(p) ? { name: '(default)', type: 'REG_JSON' } : null),
    };
    const loaded = await loadWindowApp('devconsole', {
      stubs: { extra: { OS: makeOS(true), Notify: { show: vi.fn() }, NovaRegistry: registry } },
    });
    const { app, window } = loaded;
    const state = { cleanups: [] };
    const content = initApp(app, { window, state });
    await runCommand(window, content, 'hive one');
    await runCommand(window, content, 'hive two');

    const saved = store.get('HKND/console/history');
    expect(Array.isArray(saved)).toBe(true);
    expect(saved).toContain('hive one');
    expect(saved).toContain('hive two');
    // The legacy key stays untouched while the hive is up.
    expect(window.localStorage.getItem(HISTORY_KEY)).toBeNull();

    // A fresh app instance hydrates its history from the hive.
    const second = await loadWindowApp('devconsole', {
      stubs: { extra: { OS: makeOS(true), Notify: { show: vi.fn() }, NovaRegistry: registry } },
    });
    const state2 = { cleanups: [] };
    const content2 = initApp(second.app, { window: second.window, state: state2 });
    const input2 = content2.querySelector('textarea');
    input2.dispatchEvent(new second.window.KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input2.value).toBe('hive two');
  });
});
