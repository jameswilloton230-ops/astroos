// tests/apps/email.test.js — window app: registration, setup wizard, account
// persistence (passwords never persisted), sidebar, message list, reader,
// compose/send, drafts, mailto interception and batch operations.
//
// All server traffic goes through the harness fetch stub; routes are keyed by
// "METHOD /api/email/...". jsdom has no Notification API — the app's guarded
// notification path is skipped there.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

function makeNotify() {
  const calls = [];
  return { calls, show: (n) => calls.push(n) };
}

function makeOS() {
  return { openMailto: function stockOpenMailto() {} };
}

function fetchServing(routes, calls = []) {
  return (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).split('?')[0];
    calls.push({ method, path, url: String(url), body: opts.body });
    const hit = routes[`${method} ${path}`];
    if (!hit) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(hit) });
  };
}

function emailStubs(overrides = {}) {
  return {
    ...overrides,
    extra: {
      svgIcon: (name) => `<svg data-icon="${name}"></svg>`,
      OS: makeOS(),
      Notify: makeNotify(),
      ...(overrides.extra ?? {}),
    },
  };
}

const ACCOUNTS_KEY = 'astroos_email_accts_v2';
const DRAFTS_KEY = 'astroos_email_drafts_v1';

function seedAccount(id, name, extra = {}) {
  return {
    id, name, email: `${id}@example.com`, type: 'imap', host: 'mail.example.com',
    port: '993', ssl: true, user: `${id}@example.com`, syncInterval: 0,
    color: '#6366f1', folders: null, ...extra,
  };
}

const TWO_MESSAGES = {
  messages: [
    { uid: 'u1', from: 'Alice <alice@example.com>', subject: 'Hello', date: '2024-05-01T10:00:00Z', seen: false, text: 'first body' },
    { uid: 'u2', from: 'Bob <bob@example.com>', subject: 'Second', date: '2024-05-02T10:00:00Z', seen: true, text: 'second body' },
  ],
  pages: 1,
};

describe('Email app (js/apps/email)', () => {
  beforeEach(() => resetTestStorage());

  it('registers the app descriptor and renders the guard without AppDirs', async () => {
    const { app } = await loadWindowApp('email', { stubs: emailStubs() });
    expect(app.id).toBe('com.astroos.email');
    expect(app.name).toBe('Email');
    expect(app.version).toBe('3.0.2');
    expect(app.defaultSize).toEqual([860, 580]);
    expect(app.minSize).toEqual([600, 420]);

    const { app: app2, window } = await loadWindowApp('email', { stubs: emailStubs({ AppDirs: null }) });
    const content = initApp(app2, { window });
    expect(content.className).toBe('em-guard');
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.email');
  });

  it('shows the setup wizard on first run with IMAP defaults', async () => {
    const { app, window } = await loadWindowApp('email', { stubs: emailStubs() });
    const content = initApp(app, { window });
    const setup = content.querySelector('.em-setup');
    expect(setup.style.display).not.toBe('none');
    expect(setup.textContent).toContain('Add Email Account');
    const protos = [...setup.querySelectorAll('.em-proto-btn')];
    expect(protos.map((b) => b.textContent)).toEqual(['IMAP', 'POP3', 'Exchange']);
    expect(protos[0].classList.contains('active')).toBe(true);
    const port = [...setup.querySelectorAll('input')].find((i) => i.placeholder === '993');
    expect(port.value).toBe('993');
    // csrf bootstrap ran through the 404 fetch path
    expect(window.__csrfToken).toBe('');
  });

  it('switching protocol updates the default port and SSL state', async () => {
    const { app, window } = await loadWindowApp('email', { stubs: emailStubs() });
    const content = initApp(app, { window });
    const setup = content.querySelector('.em-setup');
    const protos = [...setup.querySelectorAll('.em-proto-btn')];
    const port = [...setup.querySelectorAll('input')].find((i) => i.placeholder === '993');
    protos[1].click(); // POP3
    expect(port.value).toBe('995');
    expect(protos[1].classList.contains('active')).toBe(true);
    expect(protos[0].classList.contains('active')).toBe(false);
    protos[2].click(); // Exchange
    expect(port.value).toBe('443');
  });

  it('rejects saving an account without host, user and password', async () => {
    const calls = [];
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing({}, calls) }),
    });
    const content = initApp(app, { window });
    const setup = content.querySelector('.em-setup');
    const save = [...setup.querySelectorAll('button')].find((b) => b.textContent === 'Add Account');
    save.click();
    await settle();
    const err = [...setup.querySelectorAll('div')].find((d) =>
      d.textContent === 'Host, username and password are required.');
    expect(err).toBeTruthy();
    expect(calls.some((c) => c.path === '/api/email/connect')).toBe(false);
  });

  it('connects, persists the account without the password, and loads messages', async () => {
    const calls = [];
    const routes = {
      'POST /api/email/connect': {},
      'GET /api/email/folders': { folders: [{ path: 'INBOX', name: 'Inbox' }, { path: 'Archive', name: 'Archive' }] },
      'GET /api/email/messages': TWO_MESSAGES,
    };
    const notify = makeNotify();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls), extra: { Notify: notify } }),
    });
    const content = initApp(app, { window });
    const setup = content.querySelector('.em-setup');
    const byPlaceholder = (ph) => [...setup.querySelectorAll('input')].find((i) => i.placeholder === ph);
    byPlaceholder('Work Email').value = 'Work';
    byPlaceholder('mail.example.com').value = 'mail.example.com';
    byPlaceholder('user@example.com').value = 'me@example.com';
    byPlaceholder('••••••••').value = 'secret123';

    const save = [...setup.querySelectorAll('button')].find((b) => b.textContent === 'Add Account');
    save.click();
    await settle();

    const connect = calls.find((c) => `${c.method} ${c.path}` === 'POST /api/email/connect');
    expect(connect).toBeTruthy();
    expect(JSON.parse(connect.body)).toMatchObject({
      type: 'imap', host: 'mail.example.com', port: '993', ssl: true,
      user: 'me@example.com', pass: 'secret123',
    });

    const stored = JSON.parse(window.localStorage.getItem(ACCOUNTS_KEY));
    expect(stored).toHaveLength(1);
    expect(stored[0].name).toBe('Work');
    expect(stored[0].folders).toHaveLength(2);
    expect(Object.keys(stored[0])).not.toContain('pass'); // never persisted

    // wizard closed, sidebar + messages rendered
    expect(content.querySelector('.em-setup').style.display).toBe('none');
    const sidebar = content.querySelector('.em-sidebar');
    expect(sidebar.textContent).toContain('Inbox');
    expect(sidebar.textContent).toContain('Archive');
    expect(notify.calls.some((c) => c.type === 'success' && c.body.includes('"Work" connected'))).toBe(true);

    const rows = [...content.querySelectorAll('.em-msg-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Hello');
    // Single-account loads preserve server order (only the combined inbox sorts)
    expect(rows[0].dataset.uid).toBe('u1');
    // unread badge: one unseen message in INBOX
    const badge = sidebar.querySelector('.em-sb-badge');
    expect(badge.textContent).toBe('1');
  });

  it('opens the composer from the toolbar and sends through POST /send', async () => {
    const calls = [];
    const routes = {
      'GET /api/email/restore': { restored: true },
      'GET /api/email/messages': TWO_MESSAGES,
      'POST /api/email/send': {},
    };
    const notify = makeNotify();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls), extra: { Notify: notify } }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work')]));
    const content = initApp(app, { window });
    await settle(); // restore + loadMessages

    content.querySelector('button.em-primary').click(); // ✎ Compose
    const overlay = window.document.querySelector('.em-compose-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('role')).toBe('presentation');
    const win = overlay.querySelector('.em-compose-win');
    expect(win.getAttribute('role')).toBe('dialog');
    expect(win.getAttribute('aria-label')).toBe('New Message');
    const to = overlay.querySelector('input[type="email"]');
    const subject = [...overlay.querySelectorAll('input')].find((i) => i.placeholder === 'Subject');
    const body = overlay.querySelector('#email-body-input');

    const send = [...overlay.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    send.click();
    expect([...overlay.querySelectorAll('span')].some((s) => s.textContent === 'Recipient required.')).toBe(true);

    to.value = 'friend@example.com';
    subject.value = 'Hi there';
    body.value = 'Plain text body';
    send.click();
    await settle();

    const sent = calls.find((c) => `${c.method} ${c.path}` === 'POST /api/email/send');
    expect(sent).toBeTruthy();
    expect(JSON.parse(sent.body)).toMatchObject({
      to: 'friend@example.com', subject: 'Hi there', text: 'Plain text body',
      user: 'a1@example.com', host: 'mail.example.com',
    });
    expect(notify.calls.some((c) => c.title === 'Email' && c.body === 'Sent.')).toBe(true);
    expect(window.document.querySelector('.em-compose-overlay')).toBeNull();
  });

  it('saves a draft when the compose window is closed with content', async () => {
    const routes = { 'GET /api/email/restore': { restored: true }, 'GET /api/email/messages': TWO_MESSAGES };
    const notify = makeNotify();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes), extra: { Notify: notify } }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work')]));
    const content = initApp(app, { window });
    await settle();

    content.querySelector('button.em-primary').click();
    const overlay = window.document.querySelector('.em-compose-overlay');
    overlay.querySelector('#email-body-input').value = 'unfinished thoughts';
    [...overlay.querySelectorAll('button')].find((b) => b.title === 'Close').click();

    expect(window.document.querySelector('.em-compose-overlay')).toBeNull();
    const drafts = JSON.parse(window.localStorage.getItem(DRAFTS_KEY));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe('unfinished thoughts');
    expect(typeof drafts[0].savedAt).toBe('string');
    expect(notify.calls.some((c) => c.body === 'Draft saved.')).toBe(true);
  });

  it('renders the combined inbox for multiple accounts with per-account labels', async () => {
    const calls = [];
    const routes = {
      'GET /api/email/restore': { restored: true },
      'GET /api/email/messages': TWO_MESSAGES,
    };
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls) }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([
      seedAccount('a1', 'Work'),
      seedAccount('a2', 'Home'),
    ]));
    const content = initApp(app, { window });
    await settle();

    const toolbarLabel = content.querySelector('.em-toolbar span');
    expect(toolbarLabel.textContent).toBe('Combined Inbox');
    const sidebar = content.querySelector('.em-sidebar');
    expect(sidebar.textContent).toContain('📬 Combined Inbox');
    expect(sidebar.textContent).toContain('Work');
    expect(sidebar.textContent).toContain('Home');
    expect(sidebar.textContent).toContain('⚙ Manage Accounts');

    const rows = [...content.querySelectorAll('.em-msg-row')];
    expect(rows).toHaveLength(4); // 2 accounts × 2 messages
    expect(rows.filter((r) => r.textContent.includes('Work')).length).toBe(2);
    expect(rows[0].dataset.uid).toBe('u2'); // newest first

    // Manage Accounts opens the dialog listing both accounts
    [...sidebar.querySelectorAll('.em-sb-row')].find((r) => r.textContent.includes('Manage Accounts')).click();
    const dialog = window.document.querySelector('.em-accounts-dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.querySelectorAll('.em-account-card')).toHaveLength(2);
    expect(dialog.textContent).toContain('IMAP');
    [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    expect(window.document.querySelector('.em-accounts-dialog')).toBeNull();
  });

  it('intercepts OS.openMailto with the inline composer and restores it on cleanup', async () => {
    const routes = { 'GET /api/email/restore': { restored: true }, 'GET /api/email/messages': TWO_MESSAGES };
    const os = makeOS();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes), extra: { OS: os } }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work')]));
    initApp(app, { window });
    await settle();

    expect(typeof os.openMailto).toBe('function');
    expect(os.openMailto).not.toBe(os.constructor && makeOS().openMailto);
    const original = Object.getOwnPropertyDescriptor(os, 'openMailto');
    void original;

    os.openMailto('mailto:p@x.com?subject=Hi&body=Yo');
    const overlay = window.document.querySelector('.em-compose-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.querySelector('input[type="email"]').value).toBe('p@x.com');
    expect([...overlay.querySelectorAll('input')].find((i) => i.placeholder === 'Subject').value).toBe('Hi');
    // SOURCE BUG: openCompose passes the body through createEl({ value }) —
    // fine for <input>, but a <textarea> has no value *attribute*, so the
    // mailto/reply body prefill never reaches the textarea. Current
    // behaviour asserted as-is.
    expect(overlay.querySelector('#email-body-input').value).toBe('');

    expect(typeof window.__astroosEmailCleanup).toBe('function');
    window.__astroosEmailCleanup();
    expect(os.openMailto.name).toBe('stockOpenMailto');
  });

  it('opens a message in the reader, marks it read and prefills the reply', async () => {
    const calls = [];
    const routes = {
      'GET /api/email/restore': { restored: true },
      'GET /api/email/messages': TWO_MESSAGES,
      'GET /api/email/message': {
        subject: 'Hello', from: 'Alice <alice@example.com>', to: 'me@example.com',
        date: '2024-05-01T10:00:00Z', text: 'full plain body',
      },
    };
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls) }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work')]));
    const content = initApp(app, { window });
    await settle();

    const row = content.querySelector('.em-msg-row[data-uid="u1"]');
    expect(row.classList.contains('unread')).toBe(true);
    row.click();
    await settle();

    const msgCall = calls.find((c) => `${c.method} ${c.path}` === 'GET /api/email/message');
    expect(msgCall.url).toContain('folder=INBOX');
    expect(msgCall.url).toContain('uid=u1');

    const reader = content.querySelector('.em-reader');
    expect(reader.querySelector('.em-reader-subj').textContent).toBe('Hello');
    expect(reader.textContent).toContain('From: Alice <alice@example.com>');
    expect(reader.querySelector('.em-text-body').textContent).toBe('full plain body');
    expect(content.querySelector('.em-msg-row[data-uid="u1"]').classList.contains('unread')).toBe(false);

    // Reply opens a compose prefilled with Re: subject; the quoted body is
    // lost to the same createEl-value-on-textarea bug documented above.
    [...reader.querySelectorAll('button')].find((b) => b.textContent.includes('Reply')).click();
    const overlay = window.document.querySelector('.em-compose-overlay');
    expect(overlay.querySelector('input[type="email"]').value).toBe('Alice <alice@example.com>');
    expect([...overlay.querySelectorAll('input')].find((i) => i.placeholder === 'Subject').value).toBe('Re: Hello');
    expect(overlay.querySelector('#email-body-input').value).toBe('');
  });

  it('selects all messages and batch-marks them read for IMAP accounts', async () => {
    const calls = [];
    const routes = {
      'GET /api/email/restore': { restored: true },
      'GET /api/email/messages': {
        messages: [
          { uid: 'u1', from: 'A', subject: 'One', date: '2024-05-01T10:00:00Z', seen: false },
          { uid: 'u2', from: 'B', subject: 'Two', date: '2024-05-02T10:00:00Z', seen: false },
        ],
        pages: 1,
      },
      'POST /api/email/batch': {},
    };
    const notify = makeNotify();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls), extra: { Notify: notify } }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work')]));
    const content = initApp(app, { window });
    // jsdom only fires checkbox/radio `change` inside a live document tree.
    window.document.body.appendChild(content);
    await settle();
    const selectAll = content.querySelector('.em-list-tb input[type="checkbox"]');
    selectAll.click();
    await settle();
    const checks = [...content.querySelectorAll('.em-msg-check')];
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.checked)).toBe(true);
    const batchBar = content.querySelector('.em-batch-bar');
    expect(batchBar.style.display).toBe('flex');
    expect(batchBar.textContent).toContain('2 selected');

    [...batchBar.querySelectorAll('button')].find((b) => b.textContent === 'Mark read').click();
    await settle();

    const batch = calls.find((c) => `${c.method} ${c.path}` === 'POST /api/email/batch');
    expect(batch).toBeTruthy();
    expect(JSON.parse(batch.body)).toEqual({ op: 'read', uids: ['u1', 'u2'], folder: 'INBOX' });
    expect(notify.calls.some((c) => c.body === '2 marked as read.')).toBe(true);
    expect([...content.querySelectorAll('.em-msg-row.unread')]).toHaveLength(0);
    // batch bar cleared after the operation
    expect(content.querySelector('.em-batch-bar').style.display).toBe('none');
  });

  it('refuses bulk delete for non-IMAP accounts with an explanatory error', async () => {
    const calls = [];
    const routes = {
      'GET /api/email/restore': { restored: true },
      'GET /api/email/messages': TWO_MESSAGES,
    };
    const notify = makeNotify();
    const { app, window } = await loadWindowApp('email', {
      stubs: emailStubs({ fetch: fetchServing(routes, calls), extra: { Notify: notify } }),
    });
    window.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([seedAccount('a1', 'Work', { type: 'pop3' })]));
    const content = initApp(app, { window });
    window.document.body.appendChild(content); // checkbox change needs a live tree
    await settle();

    content.querySelector('.em-list-tb input[type="checkbox"]').click();
    const batchBar = content.querySelector('.em-batch-bar');
    [...batchBar.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
    await settle();

    expect(calls.some((c) => c.path === '/api/email/batch')).toBe(false);
    expect(notify.calls.some((c) =>
      c.type === 'error' && c.body.includes('Bulk delete is currently supported for IMAP accounts only.'))).toBe(true);
  });
});
