// tests/apps/setup.test.js — AstroOS Setup: the AOSP-style first-boot wizard
// that lives in the com.astroos.setup .novaapp instead of being hardcoded into
// the lock screen.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, settle } from '../helpers/app-harness.js';

let dom;

async function loadSetup({
  accounts = { users: [], policies: {} },
  setupResult = { ok: true, user: { uid: 'u-owner', username: 'ada', role: 'owner' } },
} = {}) {
  const setupCalls = [];
  const settingsWrites = [];
  const adminPuts = [];
  const closedWindows = [];
  const manager = {
    state: () => ({ status: 'loggedout', uid: null }),
    active: () => false,
    isAdmin: () => true,
    listAccounts: async () => ({ ok: true, users: accounts.users, policies: accounts.policies || {} }),
    setupOwner: async (payload) => { setupCalls.push(payload); return setupResult; },
    authFetch: async (path, init) => {
      adminPuts.push({ path, method: init?.method, body: init?.body });
      return { ok: true, json: { success: true } };
    },
  };
  const scope = { enabled: () => true, uid: () => '', activeUsername: () => '' };
  const osSettings = {
    set: (key, value) => settingsWrites.push([key, value]),
    get: () => null,
  };
  const loaded = await loadWindowApp('setup', {
    stubs: {
      extra: {
        OS: {
          settings: osSettings,
          events: { on: () => {}, off: () => {}, emit: () => {} },
          windows: new Map(),
        },
        WM: { closeWindow: (id) => closedWindows.push(id), toggleMaximize: () => {}, createWindow: () => null },
        SessionManager: manager,
        NovaUserScope: scope,
        EventLog: { log: () => {} },
        Notify: { show: () => {} },
      },
    },
  });
  dom = loaded.dom;
  const state = { id: 'win-1', cleanups: [] };
  return { ...loaded, manager, setupCalls, settingsWrites, adminPuts, closedWindows, state };
}

function wizardButtons(content) {
  return {
    next: content.querySelector('.nvsetup-bottom .nvsetup-btn.primary'),
    back: [...content.querySelectorAll('.nvsetup-bottom .nvsetup-btn')].find(b => b.textContent === 'Back'),
    skip: [...content.querySelectorAll('.nvsetup-bottom .nvsetup-btn')].find(b => b.textContent === 'Skip'),
  };
}

afterEach(() => { try { dom?.window.close(); } catch { /* already closed */ } });
beforeEach(() => resetTestStorage());

describe('AstroOS Setup (js/apps/setup — first-boot wizard .novaapp)', () => {
  it('registers a system app descriptor with the trusted-host entry shape', async () => {
    const { app } = await loadSetup();
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.setup');
    expect(app.name).toBe('AstroOS Setup');
    expect(typeof app.init).toBe('function');
  });

  it('first boot: renders the 7-step wizard starting at Welcome with progress dots', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    expect(content.querySelector('.nvsetup-title').textContent).toBe('AstroOS');
    expect(content.style.background).toBe('var(--bg-base)');
    expect(content.style.color).toBe('var(--text-primary)');
    expect(content.querySelectorAll('.nvsetup-dot')).toHaveLength(7);
    expect([...content.querySelectorAll('.nvsetup-dot.on')]).toHaveLength(1);
    const layout = content.querySelector('#nvsetup-keyboard-layout');
    expect(layout.getAttribute('aria-label')).toBe('Keyboard layout');
    expect(layout.querySelectorAll('option').length).toBeGreaterThanOrEqual(2);
    expect(layout.value).toBe('us');
    const { next } = wizardButtons(content);
    expect(next.textContent).toBe('Start');
    expect(next.disabled).toBe(false);
  });

  it('steps forward through network and date/region before privacy', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next, skip } = wizardButtons(content);
    next.click(); // Welcome -> Network
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Connect to network');
    expect([...content.querySelectorAll('.nvsetup-dot.on')]).toHaveLength(2);
    expect(skip.style.visibility).toBe('visible');
    skip.click(); // Network -> Date and Region (network skipped)
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Date and Region');
    expect(content.querySelector('#nvsetup-region')).toBeTruthy();
    expect(content.querySelector('#nvsetup-timezone')).toBeTruthy();
    next.click();
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Your data');
    // Guest access is the only setup policy toggle.
    const rows = [...content.querySelectorAll('.nvsetup-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Guest access');
    expect(content.textContent).not.toContain('Diagnostics');
  });

  it('account step validates and gates Next until the owner account is complete', async () => {
    const { app } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click(); next.click(); // Welcome -> Network -> Date/Region -> Privacy -> Account
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Create the owner account');
    expect(next.textContent).toBe('Create account');
    expect(next.disabled).toBe(true); // empty fields

    const inputs = [...content.querySelectorAll('.nvsetup-input')];
    const [display, username, pin, pin2] = inputs;
    inputs.forEach(i => { i.value = ''; });

    // Invalid username (too short) keeps the button locked.
    display.value = 'Ada Nova';
    username.value = 'ab';
    pin.value = '1234';
    pin2.value = '1234';
    username.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(true);

    username.value = 'ada';
    username.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    pin2.value = '4321'; // mismatched PINs still locked
    pin.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(true);

    pin2.value = '1234';
    pin2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect(next.disabled).toBe(false);
  });

  it('leaving the account step creates the owner through SessionManager.setupOwner', async () => {
    const { app, setupCalls } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click(); next.click();
    await settle();

    const [display, username, pin, pin2, pass] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada Nova';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    pass.value = '';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click(); // create the owner and advance to Appearance
    await settle(30);

    expect(setupCalls).toHaveLength(1);
    expect(setupCalls[0]).toMatchObject({ displayName: 'Ada Nova', username: 'ada', pin: '1234', avatar: 'A' });
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Make it yours');
  });

  it('a failed setupOwner surfaces the message and does not advance', async () => {
    const { app, setupCalls } = await loadSetup({
      setupResult: { ok: false, code: 'USERNAME_TAKEN', message: 'That username is already in use' },
    });
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w1', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    next.click(); next.click(); next.click(); next.click();
    await settle();
    const [display, username, pin, pin2] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click();
    await settle(30);

    expect(setupCalls).toHaveLength(1);
    expect(content.querySelector('.nvsetup-title').textContent).toBe('Create the owner account');
    expect(content.querySelector('.nvsetup-status').textContent).toBe('That username is already in use');
  });

  it('finish applies preferences through the (now owner-mounted) settings store and closes the window', async () => {
    const { app, settingsWrites, adminPuts, closedWindows } = await loadSetup();
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w9', cleanups: [] });
    await settle();

    const { next } = wizardButtons(content);
    const layout = content.querySelector('#nvsetup-keyboard-layout');
    layout.value = 'gb';
    layout.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    next.click(); next.click(); // Welcome -> Network -> Date and Region
    await settle();
    const region = content.querySelector('#nvsetup-region');
    const timezone = content.querySelector('#nvsetup-timezone');
    region.value = 'en-GB';
    region.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    timezone.value = 'Europe/London';
    timezone.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    next.click(); next.click(); // Date and Region -> Privacy -> Account
    await settle();
    const [display, username, pin, pin2] = [...content.querySelectorAll('.nvsetup-input')];
    display.value = 'Ada Nova';
    username.value = 'ada';
    pin.value = '1234';
    pin2.value = '1234';
    for (const input of [display, username, pin, pin2]) {
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    await settle();
    next.click(); // create owner -> Appearance
    await settle(30);
    const themes = [...content.querySelectorAll('.nvsetup-theme-options .nvsetup-row')];
    expect(themes).toHaveLength(7);
    expect(themes[0].getAttribute('aria-pressed')).toBe('true');
    const dracula = themes.find(button => button.textContent === 'Dracula');
    dracula.click();
    expect(dracula.getAttribute('aria-pressed')).toBe('true');
    expect(content.querySelector('style').textContent).toContain('.nvsetup-theme-options .nvsetup-row[aria-pressed="true"]');
    next.click(); // Appearance -> All set
    await settle();
    expect(content.querySelector('.nvsetup-title').textContent).toBe('You\u2019re all set');
    next.click(); // finish
    await settle(30);

    const writes = Object.fromEntries(settingsWrites);
    expect(writes.theme).toBe('dracula');
    expect(writes.accentColor).toBe('#93c5fd');
    expect(writes.keyboardLayout).toBe('gb');
    expect(writes.region).toBe('en-GB');
    expect(writes.timezone).toBe('Europe/London');
    expect(writes.language).toBeUndefined();
    expect(writes.diagnostics).toBeUndefined();
    // The policies PUT must send the patch DIRECTLY as the JSON body
    // (the server's setPolicies contract) — a { policies: ... } envelope
    // is rejected as an unknown key with 400 INVALID_POLICY. Regression
    // test for the first-boot setup console 400.
    const policiesPut = adminPuts.find(p => p.path === '/api/auth/admin/policies' && p.method === 'PUT');
    expect(policiesPut).toBeDefined();
    const sentBody = typeof policiesPut.body === 'string' ? JSON.parse(policiesPut.body) : policiesPut.body;
    expect(sentBody).toEqual({ guestAccess: expect.any(Boolean) });
    expect(closedWindows).toContain('w9');
  });

  it('launching after setup is complete shows the completed state, not the wizard', async () => {
    const { app, setupCalls } = await loadSetup({
      accounts: { users: [{ uid: 'u-owner', username: 'ada' }], policies: {} },
    });
    const content = dom.window.document.createElement('div');
    await app.init(content, { id: 'w2', cleanups: [] });
    await settle();

    expect(content.querySelector('.nvsetup-title').textContent).toBe('Setup is already complete');
    expect(content.querySelectorAll('.nvsetup-dot')).toHaveLength(0);
    expect(setupCalls).toEqual([]);
  });
});
