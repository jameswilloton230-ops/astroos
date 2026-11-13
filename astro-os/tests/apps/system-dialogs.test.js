// tests/apps/system-dialogs.test.js — service app: fs-backed open/save dialogs.
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';
import nodeFs from 'node:fs';
import fsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import nodeOs from 'node:os';

// The service does `require('fs')` at eval time — jsdom has no require, so the
// harness gets a shim that hands back the real Node modules. The dialog then
// browses an actual temp directory, exercising the true fs code paths.
let tmpRoot;

async function loadDialogs(notifyCalls = [], userRoot = null) {
  const { window, document } = await loadServiceApp('system-dialogs', {
    stubs: {
      extra: {
        require: (mod) => ({ fs: nodeFs, path: nodePath, os: nodeOs })[mod],
        Notify: { show: (o) => notifyCalls.push(o) },
        ...(userRoot ? {
          FS: {
            rootId: userRoot.id,
            getPath: (id) => id === userRoot.id ? userRoot.path : null,
          },
        } : {}),
      },
    },
  });
  return { window, document, notifyCalls };
}

const items = (document) => [...document.querySelectorAll('.system-file-dialog-item')];
const itemByName = (document, name) => items(document).find((el) => el.getAttribute('aria-label') === name);
const buttons = (document) => [...document.querySelectorAll('.modal-dialog button')];
const confirmBtn = (document) => buttons(document).find((b) => b.classList.contains('btn-primary'));
const cancelBtn = (document) => buttons(document).find((b) => b.textContent === 'Cancel');
const nameInput = (document) => document.querySelector('footer .input, .system-file-dialog-footer .input');
const pathBar = (document) => document.querySelector('.system-file-dialog-path');

describe('SystemDialogs service (js/apps/system-dialogs)', () => {
  beforeAll(async () => {
    resetTestStorage();
    tmpRoot = await fsPromises.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'astroos-dialogs-'));
    await fsPromises.mkdir(nodePath.join(tmpRoot, 'sub'));
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'alpha.txt'), 'hello alpha', 'utf8');
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'beta.md'), '# beta', 'utf8');
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'sub', 'inner.txt'), 'inner', 'utf8');
  });
  afterAll(() => { try { nodeFs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ } });

  beforeEach(() => resetTestStorage());

  it('attaches SystemDialogs with open() and save()', async () => {
    const { window } = await loadDialogs();
    const svc = window.SystemDialogs;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(false);
    expect(typeof svc.open).toBe('function');
    expect(typeof svc.save).toBe('function');
  });

  it('defaults open/import and save dialogs to the mounted account root', async () => {
    const userRoot = { id: 'logged-in-account-root', path: tmpRoot };
    const { window, document } = await loadDialogs([], userRoot);
    const open = window.SystemDialogs.open();
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);
    itemByName(document, 'alpha.txt').click();
    confirmBtn(document).click();
    await expect(open).resolves.toMatchObject({
      path: nodePath.join(tmpRoot, 'alpha.txt'),
      name: 'alpha.txt',
    });

    const { window: saveWindow, document: saveDocument } = await loadDialogs([], userRoot);
    const save = saveWindow.SystemDialogs.save({ suggestedName: 'account-home.txt' });
    await settle(80);
    expect(pathBar(saveDocument).value).toBe(tmpRoot);
    confirmBtn(saveDocument).click();
    await expect(save).resolves.toEqual({
      path: nodePath.join(tmpRoot, 'account-home.txt'),
      name: 'account-home.txt',
    });
  });

  it('open() lists folders first (sorted), then files (sorted), with grid semantics', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ title: 'Open File', startPath: tmpRoot });
    await settle(80);

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(document.querySelector('.modal-title').textContent).toBe('Open File');
    // folders first, both lists locale-sorted
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'alpha.txt', 'beta.md']);
    expect(pathBar(document).value).toBe(tmpRoot);
    expect(confirmBtn(document).disabled).toBe(true); // nothing selected yet

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
    expect(document.querySelector('.modal-overlay')).toBe(null); // dialog cleaned up
  });

  it('open() picks a file and resolves its content, mime and size', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'beta.md').click();
    expect(nameInput(document).value).toBe('beta.md');
    expect(itemByName(document, 'beta.md').getAttribute('aria-selected')).toBe('true');
    expect(confirmBtn(document).disabled).toBe(false);

    confirmBtn(document).click();
    const result = await p;
    expect(result).toEqual({
      path: nodePath.join(tmpRoot, 'beta.md'),
      name: 'beta.md',
      content: '# beta',
      mimeType: 'text/markdown',
      size: 6,
    });
    expect(document.querySelector('.modal-overlay')).toBe(null);
  });

  it('open() filters with custom predicates and <input accept> lists', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot, filter: (name, isDir) => isDir || name.startsWith('a') });
    await settle(80);
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'alpha.txt']);
    cancelBtn(document).click();
    await p;

    const { window: w2, document: d2 } = await loadDialogs();
    const p2 = w2.SystemDialogs.open({ startPath: tmpRoot, accept: '.md' });
    await settle(80);
    expect(items(d2).map((el) => el.getAttribute('aria-label'))).toEqual(['sub', 'beta.md']);
    cancelBtn(d2).click();
    await p2;
  });

  it('directory mode: selecting a folder resolves { path, name } (falls back to cwd)', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ title: 'Choose Folder', directory: true, startPath: tmpRoot });
    await settle(80);

    expect(confirmBtn(document).textContent).toBe('Select');
    itemByName(document, 'sub').click(); // folders are selectable, files hidden
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['sub']);
    expect(nameInput(document).value).toBe('sub');

    confirmBtn(document).click();
    await expect(p).resolves.toEqual({ path: nodePath.join(tmpRoot, 'sub'), name: 'sub' });
  });

  it('multi-select: click toggles rows, confirm resolves every picked file', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot, multiple: true });
    await settle(80);

    itemByName(document, 'alpha.txt').click();
    itemByName(document, 'beta.md').click();
    expect(nameInput(document).value).toBe('2 files selected');
    itemByName(document, 'beta.md').click(); // toggling off
    expect(nameInput(document).value).toBe('alpha.txt');

    confirmBtn(document).click();
    const results = await p;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'alpha.txt', content: 'hello alpha', mimeType: 'text/plain', size: 11 });
  });

  it('save() prefills the name, resolves { path, name }, and rejects path-like names', async () => {
    const notifyCalls = [];
    const { window, document } = await loadDialogs(notifyCalls);
    const p = window.SystemDialogs.save({ title: 'Save As', suggestedName: 'untitled.txt', startPath: tmpRoot });
    await settle(80);

    expect(nameInput(document).value).toBe('untitled.txt');
    expect(confirmBtn(document).disabled).toBe(false);

    nameInput(document).value = 'sub/evil.txt';
    confirmBtn(document).click();
    await settle(30);
    expect(notifyCalls[0]).toMatchObject({ title: 'Invalid file name', body: 'Enter a file name, not a path.' });
    expect(document.querySelector('.modal-overlay')).toBeTruthy(); // dialog stays open

    nameInput(document).value = 'report.txt';
    confirmBtn(document).click();
    await expect(p).resolves.toEqual({ path: nodePath.join(tmpRoot, 'report.txt'), name: 'report.txt' });
  });

  it('navigates: double-click enters a folder, Up goes to the parent, Back walks history', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'sub').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));
    expect(items(document).map((el) => el.getAttribute('aria-label'))).toEqual(['inner.txt']);

    buttons(document).find((b) => b.title === 'Up').click();
    await settle(80);
    expect(pathBar(document).value).toBe(tmpRoot);

    buttons(document).find((b) => b.title === 'Back').click();
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub'));

    // Enter in the path bar navigates; an unknown folder reports via Notify.
    pathBar(document).value = '/definitely/not/here';
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(80);
    expect(pathBar(document).value).toBe(nodePath.join(tmpRoot, 'sub')); // unchanged

    cancelBtn(document).click();
    await p;
  });

  it('navigating to a missing folder notifies "Folder unavailable" and keeps the dialog', async () => {
    const notifyCalls = [];
    const { window, document } = await loadDialogs(notifyCalls);
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    pathBar(document).value = nodePath.join(tmpRoot, 'nope');
    pathBar(document).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await settle(80);

    expect(notifyCalls[0]).toMatchObject({ title: 'Folder unavailable', type: 'error' });
    expect(document.querySelector('.modal-overlay')).toBeTruthy();
    expect(pathBar(document).value).toBe(tmpRoot); // reset to the current folder

    cancelBtn(document).click();
    await expect(p).resolves.toBe(null);
  });

  it('Escape and backdrop clicks cancel; Enter in the name input confirms (save mode)', async () => {
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);
    document.querySelector('.modal-overlay')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await expect(p).resolves.toBe(null);

    const { window: w2, document: d2 } = await loadDialogs();
    const p2 = w2.SystemDialogs.save({ startPath: tmpRoot, suggestedName: 'via-enter.txt' });
    await settle(80);
    d2.querySelector('.modal-overlay').dispatchEvent(new window.MouseEvent('click')); // target === overlay
    await expect(p2).resolves.toBe(null);

    const { window: w3, document: d3 } = await loadDialogs();
    const p3 = w3.SystemDialogs.save({ startPath: tmpRoot, suggestedName: 'enter-save.txt' });
    await settle(80);
    nameInput(d3).focus(); // the overlay handler only confirms when the name input is focused
    d3.querySelector('.modal-overlay').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    await expect(p3).resolves.toEqual({ path: nodePath.join(tmpRoot, 'enter-save.txt'), name: 'enter-save.txt' });
  });

  it('binary files resolve to a Buffer; text files to a decoded string', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    await fsPromises.writeFile(nodePath.join(tmpRoot, 'tiny.png'), png);
    const { window, document } = await loadDialogs();
    const p = window.SystemDialogs.open({ startPath: tmpRoot });
    await settle(80);

    itemByName(document, 'tiny.png').click();
    confirmBtn(document).click();
    const result = await p;
    expect(result.mimeType).toBe('image/png');
    expect(Buffer.isBuffer(result.content)).toBe(true);
    expect(result.content.equals(png)).toBe(true);
    expect(result.size).toBe(png.length);
  });
});
