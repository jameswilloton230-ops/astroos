// tests/apps/lock-screen.test.js — service app: session lock, PIN flow, lockout.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

const LOCK_SCREEN_MARKUP = `
  <div id="lock-screen">
    <div id="lock-username"></div>
    <div id="lock-pin-dots"></div>
    <div id="lock-status"></div>
    <div id="lock-numpad"></div>
  </div>`;

// Module state (enteredPin etc.) lives per jsdom realm, so every test loads a
// fresh instance. The service registers a 30s idle-lock interval at eval time
// that nothing can cancel — window.close() in afterEach stops jsdom timers.
let dom;
async function loadLockScreen({ osOverrides = {}, markup = LOCK_SCREEN_MARKUP, hash = 'hashed-1111' } = {}) {
  const wmCalls = [];
  const eventLogCalls = [];
  const workerCalls = [];
  const os = {
    lockPin: hash,
    username: 'Nova',
    isLocked: false,
    lockoutUntil: 0,
    wrongPinCount: 0,
    idleTimeout: Infinity,
    settings: { get: () => null },
    workers: { crypto: { call: async (op, pin, salt) => { workerCalls.push([op, pin, salt]); return `hashed-${pin}`; } } },
    ...osOverrides,
  };
  const loaded = await loadServiceApp('lock-screen', {
    withBaseUtils: true, // createEl/svgIcon used by renderLockScreen
    stubs: {
      extra: {
        OS: os,
        WM: { minimizeAll: () => wmCalls.push('minimizeAll'), updateTaskbar: () => wmCalls.push('updateTaskbar') },
        EventLog: { log: (e) => eventLogCalls.push(e) },
        Notify: { show: () => {} },
        getPinSalt: () => 'static-salt',
        renderDesktopIcons: () => wmCalls.push('renderDesktopIcons'),
      },
    },
  });
  dom = loaded.dom;
  if (markup) loaded.document.body.innerHTML = markup;
  return { ...loaded, os, wmCalls, eventLogCalls, workerCalls };
}

function numpadButtons(document) {
  return [...document.querySelectorAll('#lock-numpad button')];
}

async function pressPin(document, window, pin) {
  for (const digit of pin) {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: digit, cancelable: true }));
  }
}

describe('LockScreenService service (js/apps/lock-screen)', () => {
  afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });

  beforeEach(() => resetTestStorage());

  it('attaches a frozen LockScreenService exposing only lockScreen()', async () => {
    await loadLockScreen({ markup: '' });
    const svc = dom.window.LockScreenService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    expect(Object.keys(svc)).toEqual(['lockScreen']);
    expect(typeof svc.lockScreen).toBe('function');
  });

  it('lockScreen() without a configured PIN just minimizes all windows', async () => {
    const { window, document, os, wmCalls, eventLogCalls } = await loadLockScreen({ osOverrides: { lockPin: '' } });
    window.LockScreenService.lockScreen();
    expect(wmCalls).toEqual(['minimizeAll']);
    expect(os.isLocked).toBe(false);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(eventLogCalls).toEqual([]);
  });

  it('lockScreen() locks the session, renders the numpad and logs a security event', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen();
    window.LockScreenService.lockScreen();
    expect(os.isLocked).toBe(true);
    expect(document.getElementById('lock-screen').className).toContain('active');
    expect(document.getElementById('lock-username').textContent).toBe('Nova');
    expect(numpadButtons(document)).toHaveLength(12); // 1-9 + C + 0 + backspace
    expect(document.querySelectorAll('.lock-pin-dot')).toHaveLength(4);
    expect(eventLogCalls[0]).toMatchObject({ app: 'System', category: 'security', severity: 'info', message: 'Screen locked' });
  });

  it('unlock flow: correct PIN via keyboard unlocks, logs it and refreshes the shell', async () => {
    const { window, document, os, wmCalls, eventLogCalls, workerCalls } = await loadLockScreen();
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1111'); // 4th digit auto-submits
    await settle();

    expect(workerCalls[0]).toEqual(['pbkdf2', '1111', 'static-salt']);
    expect(os.isLocked).toBe(false);
    expect(document.getElementById('lock-screen').className).not.toContain('active');
    expect(eventLogCalls.at(-1)).toMatchObject({ severity: 'info', message: 'Screen unlocked' });
    await settle(30); // rAF callback
    expect(wmCalls).toContain('updateTaskbar');
    expect(wmCalls).toContain('renderDesktopIcons');
  });

  it('wrong PIN: status message, attempt counter, warn log and cleared dots', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1234');
    await settle();

    expect(os.wrongPinCount).toBe(1);
    expect(document.getElementById('lock-status').textContent).toBe('Incorrect PIN');
    expect(eventLogCalls.at(-1)).toMatchObject({
      severity: 'warn', message: 'Incorrect PIN entered (attempt 1)', data: { wrongPinCount: 1 },
    });
    expect([...document.querySelectorAll('.lock-pin-dot')].every((d) => !d.classList.contains('filled'))).toBe(true);
  });

  it('lockout window blocks verification before the worker is called', async () => {
    const { window, document, os, workerCalls, eventLogCalls } = await loadLockScreen({
      osOverrides: { lockoutUntil: Date.now() + 30000 },
    });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1111');
    await settle();

    expect(workerCalls).toEqual([]); // never reached the hash worker
    expect(document.getElementById('lock-status').textContent).toMatch(/^Locked out\. Try again in \d+s$/);
    expect(eventLogCalls.at(-1)).toMatchObject({ severity: 'warn', message: expect.stringContaining('lockout active') });
    expect(os.isLocked).toBe(true); // still locked
  });

  it('keyboard handling: digits fill dots, auto-submit at 4, Escape/Backspace edit the entry', async () => {
    const { window, document } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();

    await pressPin(document, window, '1234');
    let dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.filter((d) => d.classList.contains('filled'))).toHaveLength(4);
    expect(document.getElementById('lock-status').textContent).toBe('Verifying...'); // submitted

    await settle(); // verification rejects
    expect(document.getElementById('lock-status').textContent).toBe('Incorrect PIN');
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.every((d) => !d.classList.contains('filled'))).toBe(true); // entry reset

    // Escape clears a partial entry and the status line
    await pressPin(document, window, '12');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.every((d) => !d.classList.contains('filled'))).toBe(true);
    expect(document.getElementById('lock-status').textContent).toBe('');

    // Backspace removes one filled dot
    await pressPin(document, window, '12');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));
    dots = [...document.querySelectorAll('.lock-pin-dot')];
    expect(dots.filter((d) => d.classList.contains('filled'))).toHaveLength(1);
  });

  it('re-renders do not stack keydown listeners (remove-before-add)', async () => {
    const { window, document, os } = await loadLockScreen({ hash: 'hashed-9999' });
    window.LockScreenService.lockScreen();
    window.LockScreenService.lockScreen(); // second render over the same DOM
    await pressPin(document, window, '1234');
    await settle();
    // With stacked listeners a single wrong try would count twice.
    expect(os.wrongPinCount).toBe(1);
  });

  it('lockScreen() without the lock-screen DOM still locks and never throws', async () => {
    const { window, document, os, eventLogCalls } = await loadLockScreen({ markup: '' });
    expect(() => window.LockScreenService.lockScreen()).not.toThrow();
    expect(os.isLocked).toBe(true);
    expect(eventLogCalls[0].message).toBe('Screen locked');
    // keydown handling is a no-op without the element (handler unbinds itself)
    expect(() => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: '5' }))).not.toThrow();
  });
});
