// tests/apps/contacts.test.js — window app: contact list, edit form, search,
// delete, and malformed-storage validation.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp } from '../helpers/app-harness.js';

const SK = 'nova_contacts';

function seedContact(over = {}) {
  return {
    id: 'c-' + Math.random().toString(36).slice(2, 8),
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+1 555 0100',
    notes: 'First programmer',
    ...over,
  };
}

describe('Contacts app (js/apps/contacts)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('contacts');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.contacts');
    expect(app.name).toBe('Contacts');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('users');
    expect(app.defaultSize).toEqual([640, 500]);
    expect(app.minSize).toEqual([440, 320]);
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('contacts', { stubs: { AppDirs: null } });
    const content = initApp(app, { window });
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.nbosp.contacts');
    expect(content.querySelector('input')).toBeNull(); // no real UI built
  });

  it('renders the empty state: empty list, "Select a contact" detail, search box', async () => {
    const { app, window } = await loadWindowApp('contacts');
    const content = initApp(app, { window });
    expect(content.querySelector('input[placeholder^="Search contacts"]')).toBeTruthy();
    const addBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Contact'));
    expect(addBtn).toBeTruthy();
    expect(content.textContent).toContain('No contacts yet');
    expect(content.textContent).toContain('Select a contact');
  });

  it('creates a contact through the New Contact edit form and persists it', async () => {
    const { app, window } = await loadWindowApp('contacts', {
      stubs: { extra: { Notify: { show: vi.fn() } } },
    });
    const content = initApp(app, { window });
    const addBtn = [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Contact'));
    addBtn.click();

    // Edit form rendered with labelled inputs
    const nameInp = content.querySelector('input[id$="-name"]');
    const emailInp = content.querySelector('input[id$="-email"]');
    const phoneInp = content.querySelector('input[id$="-phone"]');
    const notesInp = content.querySelector('textarea[id$="-notes"]');
    expect(nameInp && emailInp && phoneInp && notesInp).toBeTruthy();

    nameInp.value = 'Grace Hopper';
    emailInp.value = 'grace@example.com';
    phoneInp.value = '+1 555 0101';
    notesInp.value = 'COBOL';
    const saveBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Save');
    saveBtn.click();

    const stored = JSON.parse(window.localStorage.getItem(SK));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Grace Hopper', email: 'grace@example.com', phone: '+1 555 0101', notes: 'COBOL' });
    expect(typeof stored[0].id).toBe('string');
    // View mode now shows the contact
    expect(content.textContent).toContain('Grace Hopper');
    expect(content.textContent).toContain('grace@example.com');
  });

  it('cancelling a brand-new unsaved contact discards it entirely', async () => {
    const { app, window } = await loadWindowApp('contacts');
    const content = initApp(app, { window });
    [...content.querySelectorAll('button')].find((b) => b.textContent.includes('New Contact')).click();
    // The new contact already exists in memory → the list shows a "(no name)" row
    expect(content.textContent).toContain('(no name)');
    const cancelBtn = [...content.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
    cancelBtn.click();
    // Snapshot name was empty → contact removed, list back to empty
    expect(content.textContent).toContain('No contacts yet');
    expect(window.localStorage.getItem(SK)).toBeNull(); // never persisted
  });

  it('editing an existing contact saves changes; cancel restores the snapshot', async () => {
    const { app, window } = await loadWindowApp('contacts', {
      stubs: { extra: { Notify: { show: vi.fn() } } },
    });
    window.localStorage.setItem(SK, JSON.stringify([seedContact({ name: 'Niklaus Wirth' })]));
    const content = initApp(app, { window });
    // Click the list row (event delegation on data-id)
    content.querySelector('[data-id]').click();
    expect(content.textContent).toContain('Niklaus Wirth');

    // Enter edit mode, change the name, then CANCEL — snapshot is restored
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click();
    const nameInp = content.querySelector('input[id$="-name"]');
    expect(nameInp.value).toBe('Niklaus Wirth');
    nameInp.value = 'Changed But Not Saved';
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
    expect(content.textContent).toContain('Niklaus Wirth');
    expect(content.textContent).not.toContain('Changed But Not Saved');
    expect(JSON.parse(window.localStorage.getItem(SK))[0].name).toBe('Niklaus Wirth');

    // Now edit again and SAVE
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click();
    content.querySelector('input[id$="-email"]').value = 'wirth@pascal.ch';
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Save').click();
    const stored = JSON.parse(window.localStorage.getItem(SK));
    expect(stored[0].email).toBe('wirth@pascal.ch');
    expect(stored[0].name).toBe('Niklaus Wirth'); // untouched field preserved
  });

  it('filters the list by search text and shows a no-matches state', async () => {
    const { app, window } = await loadWindowApp('contacts');
    window.localStorage.setItem(SK, JSON.stringify([
      seedContact({ id: 'c-a', name: 'Ada Lovelace', email: 'ada@example.com' }),
      seedContact({ id: 'c-b', name: 'Alan Turing', email: 'alan@example.com' }),
      seedContact({ id: 'c-c', name: 'Kim Chen', email: 'kim@example.com' }),
    ]));
    const content = initApp(app, { window });
    // Sorted alphabetically
    let rows = [...content.querySelectorAll('[data-id]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Ada Lovelace'),
      expect.stringContaining('Alan Turing'),
      expect.stringContaining('Kim Chen'),
    ]);
    // Avatar initials
    expect(rows[0].textContent).toContain('AL');

    const searchInp = content.querySelector('input[placeholder^="Search contacts"]');
    searchInp.value = 'ada';
    searchInp.dispatchEvent(new window.Event('input', { bubbles: true }));
    rows = [...content.querySelectorAll('[data-id]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Ada Lovelace');

    searchInp.value = 'zzzz';
    searchInp.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.textContent).toContain('No matches');

    searchInp.value = '';
    searchInp.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(content.querySelectorAll('[data-id]')).toHaveLength(3);
  });

  it('deletes the selected contact and updates storage', async () => {
    const { app, window } = await loadWindowApp('contacts', {
      stubs: { extra: { Notify: { show: vi.fn() } } },
    });
    window.localStorage.setItem(SK, JSON.stringify([
      seedContact({ id: 'c-a', name: 'Ada Lovelace' }),
      seedContact({ id: 'c-b', name: 'Alan Turing' }),
    ]));
    const content = initApp(app, { window });
    content.querySelector('[data-id="c-a"]').click();
    [...content.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();

    const stored = JSON.parse(window.localStorage.getItem(SK));
    expect(stored.map((c) => c.id)).toEqual(['c-b']);
    expect(content.textContent).toContain('Alan Turing');
    expect(content.textContent).toContain('Select a contact'); // selection cleared
  });

  it('drops malformed entries when loading persisted contacts', async () => {
    const { app, window } = await loadWindowApp('contacts');
    window.localStorage.setItem(SK, JSON.stringify([
      { id: 'ok-1', name: 'Valid Person', email: 'v@x.y', phone: '1', notes: 'n' },
      { name: 'Missing id', email: 'm@x.y', phone: '1', notes: '' },   // no id
      { id: 'ok-2' },                                                   // missing fields
      'a string', 42, null,                                             // not objects
      { id: 'ok-3', name: 'Wrong Types', email: 5, phone: '1', notes: '' }, // email not string
    ]));
    const content = initApp(app, { window });
    const rows = [...content.querySelectorAll('[data-id]')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Valid Person');
    expect(content.textContent).not.toContain('Missing id');
    expect(content.textContent).not.toContain('Wrong Types');
    // A corrupted non-JSON blob is ignored instead of crashing
    window.localStorage.setItem(SK, '{not json');
    const { app: app2, window: window2 } = await loadWindowApp('contacts');
    const content2 = initApp(app2, { window: window2 });
    expect(content2.textContent).toContain('No contacts yet');
  });
});
