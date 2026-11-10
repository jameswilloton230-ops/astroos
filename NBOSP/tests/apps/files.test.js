// tests/apps/files.test.js — window app: file manager grid/list views, folder
// navigation, search, selection, context menus, rename, trash, and file drop.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';
import { createFakeFS } from '../helpers/fake-fs.js';

// Wraps the shared fake FS with the handful of Files-specific members
// (getMimeIcon/uniqueName/emptyTrash, desktop special folder).
function makeFS() {
  const fs = createFakeFS();
  fs.specialFolders.desktop = fs.ensureAppDir('desktop-seed').id;
  fs.getMimeIcon = (mime, name) => (mime && mime.startsWith('image/') ? 'image' : 'file');
  fs.uniqueName = (parentId, name) => name;
  fs.emptyTrash = async () => {};
  return fs;
}

async function loadFiles({ fs, registry = null } = {}) {
  const showPromptValue = { current: null };
  const mocks = {
    Notify: { show: vi.fn() },
    ContextMenu: { show: vi.fn() },
    showModal: vi.fn(() => Promise.resolve(undefined)),
    showPrompt: vi.fn(() => Promise.resolve(showPromptValue.current)),
    openFileWithDefaultApp: vi.fn(),
    renderDesktopIcons: vi.fn(),
    workerCall: vi.fn(async () => {}),
    eventsOn: vi.fn(),
    eventsOff: vi.fn(),
  };
  const OS = {
    settings: { get: () => undefined },
    clipboard: null,
    events: { on: mocks.eventsOn, off: mocks.eventsOff },
    workers: { fs: { call: mocks.workerCall } },
  };
  const loaded = await loadWindowApp('files', {
    stubs: {
      extra: {
        OS,
        Notify: mocks.Notify,
        ContextMenu: mocks.ContextMenu,
        showModal: mocks.showModal,
        showPrompt: mocks.showPrompt,
        WM: { createWindow: vi.fn() },
        openFileWithDefaultApp: mocks.openFileWithDefaultApp,
        renderDesktopIcons: mocks.renderDesktopIcons,
        ...(registry ? { NovaRegistry: registry } : {}),
      },
    },
  });
  const { app, window } = loaded;
  const FS = fs ?? makeFS();
  window.FS = FS;
  const state = { cleanups: [] };
  const content = initApp(app, { window, state });
  await settle(); // ensureDefaultSystemFolders() → initial renderFiles()
  return { ...loaded, FS, OS, state, content, showPromptValue, ...mocks };
}

function fileItems(content) {
  return [...content.querySelectorAll('.vault-file')];
}

describe('Files app (js/apps/files)', () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('files');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.nbosp.files');
    expect(app.name).toBe('Files');
    expect(app.version).toBe('3.0.2');
    expect(app.icon).toBe('folder-open');
    expect(app.defaultSize).toEqual([780, 520]);
    expect(app.minSize).toEqual([480, 340]);
    // Extension → MIME fallback map exposed for external callers
    expect(app._extMap.png).toBe('image/png');
    expect(app._extMap.txt).toBe('text/plain');
    expect(app._extMap['nope']).toBeUndefined();
    expect(typeof app.onDrop).toBe('function');
    expect(typeof app.init).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('files', {
      stubs: {
        AppDirs: null,
        // Quirk: the FilesApp constructor reads FS.rootId BEFORE mount()'s
        // AppDirs guard runs, so the guard is only reachable when the FS
        // service exists. Without FS the init would throw instead.
        extra: { FS: makeFS() },
      },
    });
    const content = initApp(app, { window });
    await settle();
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.nbosp.files');
    expect(content.querySelector('.vault-app-root')).toBeNull();
  });

  it('renders the toolbar, default system folders and seeded files in the grid', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'readme.txt', 'hello', 'text/plain');
    await fs.createFile(fs.rootId, 'photo.png', 'xyz', 'image/png');
    await fs.createFolder(fs.rootId, 'Projects');
    const { content } = await loadFiles({ fs });

    // Toolbar chrome
    expect(content.querySelector('#file-browser-path-input')).toBeTruthy();
    expect(content.querySelector('#file-browser-search-input')).toBeTruthy();
    const back = content.querySelector('[title="Back"]');
    const up = content.querySelector('[title="Up"]');
    expect(back && up).toBeTruthy();

    // 6 default system folders + the fake FS's data/.Trash + Projects + 2 files
    const items = fileItems(content);
    expect(items).toHaveLength(11);
    const names = items.map((i) => i.querySelector('.vault-file-name').textContent);
    expect(names.slice(0, 9)).toEqual(['.Trash', 'data', 'Documents', 'Downloads', 'Music', 'Pictures', 'Projects', 'System', 'Videos']);
    expect(names[9]).toBe('photo.png');
    expect(names[10]).toBe('readme.txt');
    // Status bar counts everything
    expect(content.querySelector('.vault-statusbar').textContent).toBe('11 items');
    expect(content.querySelector('#file-browser-path-input').value).toBe('/');
  });

  it('navigates into folders by double-click, then Back/Up return to the root', async () => {
    const fs = makeFS();
    const docs = await fs.createFolder(fs.rootId, 'Documents');
    await fs.createFile(docs.id, 'cv.pdf', 'xx', 'application/pdf');
    const { content, window } = await loadFiles({ fs });

    const docsItem = fileItems(content).find((i) => i.querySelector('.vault-file-name').textContent === 'Documents');
    docsItem.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(content.querySelector('#file-browser-path-input').value).toBe('/Documents');
    const inside = fileItems(content).map((i) => i.querySelector('.vault-file-name').textContent);
    expect(inside).toEqual(['cv.pdf']);
    expect(content.querySelector('.vault-statusbar').textContent).toBe('1 item');

    // Back returns to the root. Documents already existed, so only 5 default
    // folders were created: 5 + Documents + data + .Trash = 8.
    content.querySelector('[title="Back"]').click();
    expect(content.querySelector('#file-browser-path-input').value).toBe('/');
    expect(fileItems(content)).toHaveLength(8);

    // Navigate in again, then Up goes to the parent
    fileItems(content).find((i) => i.textContent.includes('Documents'))
      .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    content.querySelector('[title="Up"]').click();
    expect(content.querySelector('#file-browser-path-input').value).toBe('/');

    // Typing a valid path in the path bar navigates; an invalid one flashes red
    const pathBar = content.querySelector('#file-browser-path-input');
    pathBar.value = '/Documents';
    pathBar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(pathBar.value).toBe('/Documents');
    pathBar.value = '/does-not-exist';
    pathBar.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(pathBar.style.color).toBe('var(--text-danger)');
  });

  it('filters files through the debounced search box', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'report-2024.txt', 'a', 'text/plain');
    await fs.createFile(fs.rootId, 'photo.png', 'b', 'image/png');
    const { content, window } = await loadFiles({ fs });
    const search = content.querySelector('#file-browser-search-input');
    search.value = 'report';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(200); // 150ms debounce
    const names = fileItems(content).map((i) => i.querySelector('.vault-file-name').textContent);
    expect(names).toEqual(['report-2024.txt']);
  });

  it('selects files (single and ctrl-click) and reports the selection in the status bar', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'readme.txt', 'hello', 'text/plain'); // 5 B
    await fs.createFile(fs.rootId, 'photo.png', 'xyz', 'image/png');     // 3 B
    const { content, window } = await loadFiles({ fs });
    const items = fileItems(content);
    const status = content.querySelector('.vault-statusbar');

    items.find((i) => i.textContent.includes('readme.txt')).click();
    expect(status.textContent).toBe('1 of 10 selected — 5 B'); // 2 files + 8 system folders
    expect(items.find((i) => i.textContent.includes('readme.txt')).classList.contains('selected')).toBe(true);

    items.find((i) => i.textContent.includes('photo.png'))
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    expect(status.textContent).toBe('2 of 10 selected — 8 B');
  });

  it('opens a per-file context menu: Copy sets the clipboard, Move to Trash deletes', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'report.txt', 'abc', 'text/plain');
    const { content, window, ContextMenu, OS, Notify, FS } = await loadFiles({ fs });
    const item = fileItems(content).find((i) => i.textContent.includes('report.txt'));
    item.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    expect(ContextMenu.show).toHaveBeenCalledTimes(1);
    const items = ContextMenu.show.mock.calls[0][2];
    const labels = items.filter((i) => !i.separator).map((i) => i.label);
    expect(labels).toEqual(['Open', 'Open with...', 'Export to Host…', 'Rename', 'Copy', 'Move', 'Move to Trash']);

    // Copy → clipboard op recorded + notification
    items.find((i) => i.label === 'Copy').action();
    expect(OS.clipboard).toMatchObject({ type: 'copy' });
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Copied', body: 'report.txt copied' }));

    // Move to Trash → file moved into the trash folder, list refreshes
    items.find((i) => i.label === 'Move to Trash').action();
    await settle();
    expect(fileItems(content).some((i) => i.textContent.includes('report.txt'))).toBe(false);
    expect(content.querySelector('.vault-statusbar').textContent).toBe('8 items'); // folders remain
    const trashed = [...fs.files.values()].find((n) => n.name === 'report.txt');
    expect(trashed.parentId).toBe(fs.specialFolders.trash);
  });

  it('creates files and folders via the empty-area context menu prompt flow', async () => {
    const fs = makeFS();
    const { content, window, ContextMenu, showPromptValue, Notify } = await loadFiles({ fs });
    const grid = content.querySelector('.vault-files');
    grid.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = ContextMenu.show.mock.calls[0][2];
    const labels = menu.filter((i) => !i.separator).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['New File', 'New Folder', 'Sort by Name', 'View: Icons', 'View: List', 'Select All']));
    // No clipboard yet → no Paste entry
    expect(labels).not.toContain('Paste');

    // New File with a valid name
    showPromptValue.current = 'hello.txt';
    menu.find((i) => i.label === 'New File').action();
    await settle();
    expect(fileItems(content).some((i) => i.textContent.includes('hello.txt'))).toBe(true);

    // Invalid name → blocked notification, nothing created
    showPromptValue.current = 'bad|name';
    grid.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu2 = ContextMenu.show.mock.calls[1][2];
    menu2.find((i) => i.label === 'New File').action();
    await settle();
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Blocked', body: 'That name is not valid.' }));
  });

  it('switches to list view from the empty-area menu with size/type/date columns', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'notes.md', 'abcdef', 'text/markdown');
    const { content, window, ContextMenu } = await loadFiles({ fs });
    const grid = content.querySelector('.vault-files');
    grid.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ContextMenu.show.mock.calls[0][2].find((i) => i.label === 'View: List').action();

    expect(grid.style.display).toBe('none');
    const rows = [...content.querySelectorAll('.vault-list-row')];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r.textContent.includes('notes.md'));
    expect(row.textContent).toContain('6 B');     // size
    expect(row.textContent).toContain('MARKDOWN'); // mimeToTypeLabel
    // Header sort buttons exist
    const headers = [...content.querySelectorAll('[aria-label^="Sort by"]')].map((b) => b.getAttribute('aria-label'));
    expect(headers).toEqual(['Sort by Name', 'Sort by Size', 'Sort by Type', 'Sort by Modified']);
  });

  it('renames inline through the context menu, rejecting illegal names', async () => {
    const fs = makeFS();
    await fs.createFile(fs.rootId, 'old-name.txt', 'x', 'text/plain');
    const { content, window, ContextMenu, Notify } = await loadFiles({ fs });

    fileItems(content).find((i) => i.textContent.includes('old-name.txt'))
      .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ContextMenu.show.mock.calls[0][2].find((i) => i.label === 'Rename').action();

    const renameInput = content.querySelector('#file-rename-input');
    expect(renameInput).toBeTruthy();
    expect(renameInput.value).toBe('old-name.txt');

    // Illegal characters are refused
    renameInput.value = 'bad|name.txt';
    renameInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Invalid name' }));

    // A valid rename commits through FS.rename and re-renders
    fileItems(content).find((i) => i.textContent.includes('old-name.txt'))
      .dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    ContextMenu.show.mock.calls[1][2].find((i) => i.label === 'Rename').action();
    const input2 = content.querySelector('#file-rename-input');
    input2.value = 'renamed.txt';
    input2.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    const names = fileItems(content).map((i) => i.querySelector('.vault-file-name').textContent);
    expect(names).toContain('renamed.txt');
    expect(names).not.toContain('old-name.txt');
    expect([...fs.files.values()].some((n) => n.name === 'renamed.txt')).toBe(true);
  });

  it('drops files into the current folder via onDrop with mime detection', async () => {
    const fs = makeFS();
    const { app, window, Notify, OS, FS, state } = await loadFiles({ fs });
    const bytes = new TextEncoder().encode('PNGDATA');
    const file = { name: 'shot.png', type: '', size: bytes.length, arrayBuffer: async () => bytes.buffer };
    await app.onDrop(file, state);
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'File Added', body: 'shot.png' }));

    const node = [...FS.files.values()].find((n) => n.name === 'shot.png');
    expect(node.type).toBe('file');
    expect(node.mimeType).toBe('image/png'); // from _extMap because file.type was empty
    expect(node.parentId).toBe(FS.rootId); // state._nav.cwd (root)
    expect(OS.workers.fs.call).toHaveBeenCalledWith('putFiles', [node]);
  });

  it('blocks unsafe drops through the Scanner and rejects malformed drop payloads', async () => {
    const fs = makeFS();
    const { app, window, Notify, FS, state } = await loadFiles({ fs });
    window.Scanner = { scan: vi.fn(async () => ({ safe: false, reason: 'EICAR signature' })) };
    const bytes = new TextEncoder().encode('x');
    await app.onDrop({ name: 'evil.txt', type: 'text/plain', size: 1, arrayBuffer: async () => bytes.buffer }, state);
    expect(window.Scanner.scan).toHaveBeenCalledTimes(1);
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({
      title: 'File Blocked', body: 'EICAR signature', type: 'error', appName: 'Security',
    }));
    expect([...FS.files.values()].some((n) => n.name === 'evil.txt')).toBe(false);

    // Not a file object at all
    await app.onDrop(null, state);
    expect(Notify.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', body: 'Invalid file dropped.' }));
  });

  it('opens double-clicked files with the default app and folders navigate', async () => {
    const fs = makeFS();
    const docs = await fs.createFolder(fs.rootId, 'Docs');
    await fs.createFile(fs.rootId, 'song.mp3', 'zz', 'audio/mpeg');
    const { content, window, openFileWithDefaultApp } = await loadFiles({ fs });
    const items = fileItems(content);

    items.find((i) => i.textContent.includes('song.mp3'))
      .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(openFileWithDefaultApp).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'song.mp3', mimeType: 'audio/mpeg' }),
    );

    items.find((i) => i.textContent.includes('Docs'))
      .dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(content.querySelector('#file-browser-path-input').value).toBe('/Docs');
  });

  it('restores the view bag (HKNU/shell/bags/files) on open and persists changes', async () => {
    const store = new Map();
    const registry = {
      get: (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined),
      set: (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); return true; },
    };
    store.set('HKNU/shell/bags/files', { viewMode: 'list', sortBy: 'size', sortAsc: false });

    const { state, window } = await loadFiles({ registry });
    const inst = state.filesApp;
    expect(inst.viewMode).toBe('list');
    expect(inst.sortBy).toBe('size');
    expect(inst.sortAsc).toBe(false);

    // Change the view through the context-menu action handler — persisted.
    inst.viewMode = 'icon';
    inst.sortAsc = true;
    inst.persistViewState();
    expect(store.get('HKNU/shell/bags/files')).toEqual({ viewMode: 'icon', sortBy: 'size', sortAsc: true });
    expect(window.localStorage.getItem('nova_files_view')).toBeNull(); // no legacy shadow was ever created
  });

  it('falls back to defaults when the view bag is absent or malformed', async () => {
    const store = new Map();
    const registry = {
      get: (p) => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined),
      set: (p, v) => { store.set(p, JSON.parse(JSON.stringify(v))); return true; },
    };
    store.set('HKNU/shell/bags/files', { viewMode: 'galaxy', sortBy: 42, sortAsc: 'yes' });

    const { state } = await loadFiles({ registry });
    // Invalid bag fields are ignored — defaults hold.
    expect(state.filesApp.viewMode).toBe('icon');
    expect(state.filesApp.sortBy).toBe('name');
    expect(state.filesApp.sortAsc).toBe(true);
  });
});
