import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';

// ── Mock OPFS before FS loads ───────────────────────────────────────────────
const _opfsFiles = new Map();
const _opfsDirs = new Set(['/']);

const opfsMock = {
  available: true,
  root: true,
  async init() {},
  async readText(path) {
    const entry = _opfsFiles.get(path);
    return entry?.type === 'file' ? entry.content ?? null : null;
  },
  async writeText(path, content, type) {
    _opfsFiles.set(path, { type: 'file', content, mime: type ?? 'text/plain' });
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      _opfsDirs.add('/' + parts.slice(0, i).join('/'));
    }
  },
  async getBlob(path) {
    const entry = _opfsFiles.get(path);
    if (!entry || entry.type !== 'file') return null;
    return new Blob([entry.content ?? ''], { type: entry.mime });
  },
  async writeBlob(path, blob, type) {
    const text = await blob.text();
    _opfsFiles.set(path, { type: 'file', content: text, mime: type ?? 'application/octet-stream' });
  },
  async deleteBlob(path) { _opfsFiles.delete(path); },
  async deletePath(path, recursive) {
    if (recursive) {
      for (const k of [..._opfsFiles.keys()]) {
        if (k === path || k.startsWith(path + '/')) _opfsFiles.delete(k);
      }
      for (const d of [..._opfsDirs]) {
        if (d === path || d.startsWith(path + '/')) _opfsDirs.delete(d);
      }
    } else {
      _opfsFiles.delete(path);
    }
  },
  async ensureDirectory(path) { _opfsDirs.add(path); },
  async listEntries() {
    return [..._opfsFiles.entries()].map(([path, entry]) => ({
      path,
      kind: 'file',
      size: (entry.content ?? '').length,
      type: entry.mime,
      fallback: false,
    }));
  },
  async clear() {
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
  },
};

vi.mock('../../../js/platform/core/opfs.js', () => ({
  get OPFS() { return opfsMock; },
  default: opfsMock,
}));

const mockWorker = { call: vi.fn() };
vi.mock('../../../js/core/services/workers.js', () => ({
  createWorker: vi.fn(() => mockWorker),
  get OS() { return { workers: { fs: mockWorker, crypto: mockWorker, search: mockWorker } }; },
}));

// ── Backend pinning ─────────────────────────────────────────────────────────
// fs.js chooses its backend AT LOAD TIME: process.platform === 'linux' swaps
// the whole service for the native disk backend rooted at os.homedir()
// (the real AstroOS kiosk behavior); anything else gets the in-memory virtual
// FS (dev machines). Both contracts are pinned explicitly below so a Linux
// CI box cannot silently skip the virtual suite and a dev mac cannot skip
// the native one — each suite runs the code it names.
async function loadFsBackend(platform, fakeHome) {
  vi.resetModules();
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  let homedirSpy;
  try {
    if (fakeHome) homedirSpy = vi.spyOn(nodeOs, 'homedir').mockReturnValue(fakeHome);
    // Dynamic import re-executes the module after vi.resetModules(); a plain
    // require() would hit the transformed-module cache and hand back the
    // previous backend's instance.
    await import('../../../js/core/services/fs.js');
  } finally {
    homedirSpy?.mockRestore();
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
  return globalThis.window.FS;
}

function stubOsGlobals() {
  globalThis.generateId = () => 'id-' + Math.random().toString(36).slice(2);
  globalThis.OS = {
    events: { emit: vi.fn() },
    workers: { fs: { call: vi.fn() }, crypto: { call: vi.fn() }, search: { call: vi.fn() } },
  };
}

// Loads run at module top level (describe callbacks cannot await): virtual
// first, then the native backend against its temp $HOME.
const outsideRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nova-fs-outside-'));
const fakeHomeDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'nova-fs-home-'));
const virtualFS = await loadFsBackend('darwin');
const nativeFS = await loadFsBackend('linux', fakeHomeDir);

// ════════════════════════════════════════════════════════════════════════════
// Backend A — virtual in-memory FS (non-Linux dev contract)
// ════════════════════════════════════════════════════════════════════════════

describe('FS virtual backend (non-Linux contract)', () => {
  const FS = virtualFS;

  beforeEach(() => {
    resetTestStorage();
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
    FS.files.clear();
    FS._childrenByParent.clear();
    FS.rootId = null;
    FS.specialFolders = {};
    FS._searchTimeout = null;
    mockWorker.call.mockClear();
    stubOsGlobals();
  });

  it('reports its backend', () => {
    expect(FS.backend).toBe('virtual');
  });

  describe('createDefaultFS', () => {
    it('creates the standard folder structure when no files exist', async () => {
      mockWorker.call.mockResolvedValue([]);
      await FS.createDefaultFS();
      expect(FS.rootId).not.toBeNull();
      expect(FS.specialFolders.desktop).toBeDefined();
      expect(FS.specialFolders.documents).toBeDefined();
      expect(FS.specialFolders.downloads).toBeDefined();
    });

    it('creates a screenshots folder inside pictures', async () => {
      mockWorker.call.mockResolvedValue([]);
      await FS.createDefaultFS();
      const picturesId = FS.specialFolders.pictures;
      const children = FS.listDir(picturesId);
      const screenshots = children.find((c) => c.name === 'Screenshots');
      expect(screenshots).toBeDefined();
      expect(screenshots.type).toBe('folder');
    });
  });

  describe('listDir', () => {
    it('returns an empty array for an empty folder', () => {
      const result = FS.listDir('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('getPath', () => {
    it('returns "/" for the root node', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getPath('root')).toBe('/');
    });
  });

  describe('getByPath', () => {
    it('returns the root for "/"', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getByPath('/')).toEqual({ id: 'root', name: '/', parentId: null });
    });

    it('returns null for nonexistent paths', () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      expect(FS.getByPath('/nonexistent')).toBeNull();
    });
  });

  describe('createFile', () => {
    it('creates a file with correct properties', async () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      FS._childrenByParent.set('root', new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const file = await FS.createFile('root', 'test.txt', 'hello', 'text/plain');
      expect(file.name).toBe('test.txt');
      expect(file.type).toBe('file');
      expect(file.content).toBe('hello');
      expect(file.parentId).toBe('root');
      expect(FS.files.has(file.id)).toBe(true);
    });
  });

  describe('createFolder', () => {
    it('creates a folder with correct properties', async () => {
      FS.rootId = 'root';
      FS.files.set('root', { id: 'root', name: '/', parentId: null });
      FS._childrenByParent.set('root', new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const folder = await FS.createFolder('root', 'new-folder');
      expect(folder.name).toBe('new-folder');
      expect(folder.type).toBe('folder');
      expect(folder.parentId).toBe('root');
      expect(FS.files.has(folder.id)).toBe(true);
    });
  });

  describe('writeFile', () => {
    it('updates file content', async () => {
      const id = 'file1';
      FS.files.set(id, {
        id,
        name: 'test.txt',
        type: 'file',
        parentId: 'root',
        content: 'old',
        mimeType: 'text/plain',
        size: 3,
      });
      FS._childrenByParent.set('root', new Map([[id, FS.files.get(id)]]));
      mockWorker.call.mockResolvedValue(undefined);

      await FS.writeFile(id, 'new content');
      expect(FS.files.get(id).content).toBe('new content');
    });

    it('returns null for nonexistent file', async () => {
      const result = await FS.writeFile('nonexistent', 'content');
      expect(result).toBeNull();
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const id = 'file1';
      FS.files.set(id, { id, name: 'old.txt', type: 'file', parentId: 'root' });
      mockWorker.call.mockResolvedValue(undefined);

      const result = await FS.rename(id, 'new.txt');
      expect(result.name).toBe('new.txt');
      expect(FS.files.get(id).name).toBe('new.txt');
    });

    it('returns null for nonexistent file', async () => {
      const result = await FS.rename('nonexistent', 'new.txt');
      expect(result).toBeNull();
    });
  });

  describe('move', () => {
    it('moves a file to a new parent', async () => {
      const fileId = 'file1';
      const oldParent = 'oldParent';
      const newParent = 'newParent';
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: oldParent });
      FS._childrenByParent.set(oldParent, new Map([[fileId, FS.files.get(fileId)]]));
      FS._childrenByParent.set(newParent, new Map());
      mockWorker.call.mockResolvedValue(undefined);

      const result = await FS.move(fileId, newParent);
      expect(result).toBeDefined();
      expect(FS.files.get(fileId).parentId).toBe(newParent);
      // After move, the oldParent map may be deleted if empty, so check conditionally
      const oldParentMap = FS._childrenByParent.get(oldParent);
      if (oldParentMap) {
        expect(oldParentMap.has(fileId)).toBe(false);
      }
      expect(FS._childrenByParent.get(newParent)?.has(fileId)).toBe(true);
    });
  });

  describe('deleteToTrash', () => {
    it('moves file to trash folder', async () => {
      const fileId = 'file1';
      const trashId = 'trash';
      FS.specialFolders.trash = trashId;
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: 'root', _originalParent: null });
      FS._childrenByParent.set('root', new Map([[fileId, FS.files.get(fileId)]]));
      FS._childrenByParent.set(trashId, new Map());
      mockWorker.call.mockResolvedValue(undefined);

      await FS.deleteToTrash(fileId);
      expect(FS.files.get(fileId).parentId).toBe(trashId);
    });
  });

  describe('permanentDelete', () => {
    it('removes file from FS entirely', async () => {
      const fileId = 'file1';
      FS.files.set(fileId, { id: fileId, name: 'test.txt', type: 'file', parentId: 'root' });
      mockWorker.call.mockResolvedValue(undefined);

      await FS.permanentDelete(fileId);
      expect(FS.files.has(fileId)).toBe(false);
    });

    it('recursively deletes folder contents', async () => {
      const folderId = 'folder1';
      const childId = 'child1';
      FS.files.set(folderId, { id: folderId, name: 'folder', type: 'folder', parentId: 'root' });
      FS.files.set(childId, { id: childId, name: 'child.txt', type: 'file', parentId: folderId });
      FS._childrenByParent.set(folderId, new Map([[childId, FS.files.get(childId)]]));
      mockWorker.call.mockResolvedValue(undefined);

      await FS.permanentDelete(folderId);
      expect(FS.files.has(folderId)).toBe(false);
      expect(FS.files.has(childId)).toBe(false);
    });
  });

  describe('getMimeIcon', () => {
    it('returns "folder" for directories', () => {
      expect(FS.getMimeIcon('inode/directory', '')).toBe('folder');
    });

    it('returns "image" for image MIME types', () => {
      expect(FS.getMimeIcon('image/png', '')).toBe('image');
    });

    it('returns "file-text" for markdown files', () => {
      expect(FS.getMimeIcon('text/plain', 'readme.md')).toBe('file-text');
    });

    it('returns "file-text" for unknown types', () => {
      expect(FS.getMimeIcon('application/octet-stream', '')).toBe('file-text');
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Backend B — linux-native disk FS (the real-sandbox contract)
// Runs against a real temp $HOME with real files, real Trash, real guards —
// exactly what the AstroOS kiosk executes on Linux.
// ════════════════════════════════════════════════════════════════════════════

describe('FS linux-native backend (real disk contract)', () => {
  const fakeHome = fakeHomeDir;
  const homePath = (rel) => nodePath.join(fakeHome, ...rel.split('/'));
  const trashDir = nodePath.join(fakeHome, '.local', 'share', 'Trash', 'files');
  const appDataRoot = nodePath.join(fakeHome, '.local', 'share', 'novabyte', 'data');
  const migrationMarker = nodePath.join(fakeHome, '.local', 'share', 'novabyte', 'migration', 'vfs-imported');

  const FS = nativeFS;
  let events;

  beforeAll(async () => {
    // Fresh-install boot: the worker holds no legacy virtual FS to migrate.
    // OS must exist before init() — migrateLegacyVfs talks to the fs worker.
    globalThis.OS = {
      events: { emit: vi.fn() },
      workers: { fs: { call: vi.fn().mockResolvedValue([]) }, crypto: { call: vi.fn() }, search: { call: vi.fn() } },
    };
    mockWorker.call.mockResolvedValue([]);
    await FS.init();
  });

  beforeEach(() => {
    mockWorker.call.mockClear();
    events = vi.fn();
    globalThis.OS = {
      events: { emit: events },
      workers: { fs: { call: vi.fn().mockResolvedValue([]) }, crypto: { call: vi.fn() }, search: { call: vi.fn() } },
    };
  });

  afterAll(() => {
    nodeFs.rmSync(fakeHome, { recursive: true, force: true });
    nodeFs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('reports its backend', () => {
    expect(FS.backend).toBe('linux-native');
  });

  it('roots the filesystem at the user home and exposes special folders as real paths', () => {
    expect(FS.rootId).toBe(nodePath.resolve(fakeHome));
    expect(FS.specialFolders.desktop).toBe(nodePath.join(fakeHome, 'Desktop'));
    expect(FS.specialFolders.documents).toBe(nodePath.join(fakeHome, 'Documents'));
    expect(FS.specialFolders.downloads).toBe(nodePath.join(fakeHome, 'Downloads'));
    expect(FS.specialFolders.music).toBe(nodePath.join(fakeHome, 'Music'));
    expect(FS.specialFolders.pictures).toBe(nodePath.join(fakeHome, 'Pictures'));
    expect(FS.specialFolders.videos).toBe(nodePath.join(fakeHome, 'Videos'));
    expect(FS.specialFolders.trash).toBe(trashDir);
    expect(FS.specialFolders.data).toBe(appDataRoot);
  });

  it('boot creates the standard XDG tree, Screenshots, Trash, and the app data root on disk', () => {
    for (const dir of ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']) {
      expect(nodeFs.statSync(nodePath.join(fakeHome, dir)).isDirectory()).toBe(true);
    }
    expect(nodeFs.statSync(nodePath.join(fakeHome, 'Pictures', 'Screenshots')).isDirectory()).toBe(true);
    expect(nodeFs.statSync(trashDir).isDirectory()).toBe(true);
    expect(nodeFs.statSync(appDataRoot).isDirectory()).toBe(true);
    // The legacy-VFS migration marker is written on a fresh install.
    expect(nodeFs.existsSync(migrationMarker)).toBe(true);
  });

  it('init() is idempotent — rebooting an existing home keeps the tree intact', async () => {
    const before = FS.listDir(fakeHome).map((n) => n.name);
    await expect(FS.init()).resolves.toBeUndefined();
    const after = FS.listDir(fakeHome).map((n) => n.name);
    expect(after).toEqual(before);
    expect(FS.rootId).toBe(nodePath.resolve(fakeHome));
  });

  it('listDir reads the real disk, folders first then alphabetical, and hides nothing the disk shows', async () => {
    await FS.createFile(fakeHome, 'zz-notes.txt', 'zz');
    await FS.createFolder(fakeHome, 'aa-folder');
    try {
      const names = FS.listDir(fakeHome).map((n) => n.name);
      // Folders sort before files regardless of their name.
      expect(names.indexOf('aa-folder')).toBeLessThan(names.indexOf('zz-notes.txt'));
      expect(names).toContain('Desktop');
      expect(names).toContain('Documents');
    } finally {
      await FS.permanentDelete(nodePath.join(fakeHome, 'zz-notes.txt'));
      await FS.permanentDelete(nodePath.join(fakeHome, 'aa-folder'));
    }
  });

  it('listDir skips symlinks so they never enter the visible tree', async () => {
    nodeFs.symlinkSync(nodePath.join(fakeHome, 'Documents'), nodePath.join(fakeHome, 'Desktop', 'doc-link'));
    try {
      const names = FS.listDir(nodePath.join(fakeHome, 'Desktop')).map((n) => n.name);
      expect(names).not.toContain('doc-link');
    } finally {
      nodeFs.rmSync(nodePath.join(fakeHome, 'Desktop', 'doc-link'));
    }
  });

  it('createFile writes a real 0600 file and returns a node carrying its content', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'hello.txt', 'hello', 'text/plain');
    try {
      expect(node.name).toBe('hello.txt');
      expect(node.type).toBe('file');
      expect(node.content.toString()).toBe('hello');
      expect(node.size).toBe(5);
      expect(node.mimeType).toBe('text/plain');
      expect(node.id).toBe(nodePath.join(fakeHome, 'Documents', 'hello.txt'));
      expect(nodeFs.readFileSync(node.id, 'utf8')).toBe('hello');
      expect(nodeFs.statSync(node.id).mode & 0o777).toBe(0o600);
      expect(events).toHaveBeenCalledWith('fs:created', expect.objectContaining({ name: 'hello.txt' }));
    } finally {
      await FS.permanentDelete(node.id);
    }
  });

  it('createFile refuses to clobber an existing file (O_EXCL semantics)', async () => {
    await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'twice.txt', 'first');
    try {
      await expect(FS.createFile(nodePath.join(fakeHome, 'Documents'), 'twice.txt', 'second'))
        .rejects.toMatchObject({ code: 'EEXIST' });
      expect(nodeFs.readFileSync(nodePath.join(fakeHome, 'Documents', 'twice.txt'), 'utf8')).toBe('first');
    } finally {
      await FS.permanentDelete(nodePath.join(fakeHome, 'Documents', 'twice.txt'));
    }
  });

  it('createFolder makes a real directory', async () => {
    const node = await FS.createFolder(nodePath.join(fakeHome, 'Documents'), 'projects');
    try {
      expect(node.type).toBe('folder');
      expect(nodeFs.statSync(node.id).isDirectory()).toBe(true);
    } finally {
      await FS.permanentDelete(node.id);
    }
  });

  it('writeFile rewrites the file on disk and refreshes the node', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'writable.txt', 'old');
    try {
      const updated = await FS.writeFile(node.id, 'brand new');
      expect(updated.content.toString()).toBe('brand new');
      expect(nodeFs.readFileSync(node.id, 'utf8')).toBe('brand new');
      expect(events).toHaveBeenCalledWith('fs:updated', expect.objectContaining({ id: node.id }));
    } finally {
      await FS.permanentDelete(node.id);
    }
  });

  it('writeFile refuses directories', async () => {
    await expect(FS.writeFile(nodePath.join(fakeHome, 'Documents'), 'nope'))
      .rejects.toThrow(/Not a regular file/);
  });

  it('rename renames on disk and refuses an existing destination', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'before.txt', 'x');
    const blocker = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'after.txt', 'y');
    try {
      const renamed = await FS.rename(node.id, 'after.txt');
      throw new Error('should have rejected');
    } catch (error) {
      expect(error.code).toBe('EEXIST');
    }
    const renamed = await FS.rename(node.id, 'renamed.txt');
    expect(renamed.name).toBe('renamed.txt');
    expect(nodeFs.existsSync(nodePath.join(fakeHome, 'Documents', 'before.txt'))).toBe(false);
    expect(nodeFs.readFileSync(renamed.id, 'utf8')).toBe('x');
    await FS.permanentDelete(blocker.id);
    await FS.permanentDelete(renamed.id);
  });

  it('move relocates a file into another real folder and refuses collisions', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Desktop'), 'movable.txt', 'm');
    const blocker = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'movable.txt', 'b');
    try {
      await expect(FS.move(node.id, nodePath.join(fakeHome, 'Documents')))
        .rejects.toMatchObject({ code: 'EEXIST' });
      const moved = await FS.move(node.id, nodePath.join(fakeHome, 'Downloads'));
      expect(nodeFs.existsSync(nodePath.join(fakeHome, 'Desktop', 'movable.txt'))).toBe(false);
      expect(nodeFs.readFileSync(moved.id, 'utf8')).toBe('m');
      expect(events).toHaveBeenCalledWith('fs:moved', expect.objectContaining({ id: moved.id }));
      await FS.permanentDelete(moved.id);
    } finally {
      await FS.permanentDelete(blocker.id);
    }
  });

  it('getByPath maps virtual paths onto the real home ("/", relative, "/data")', async () => {
    const root = FS.getByPath('/');
    expect(root.id).toBe(nodePath.resolve(fakeHome));
    expect(root.name).toBe('/');
    expect(root.type).toBe('folder');

    const documents = FS.getByPath('/Documents');
    expect(documents.id).toBe(nodePath.join(fakeHome, 'Documents'));

    expect(FS.getByPath('Documents').id).toBe(nodePath.join(fakeHome, 'Documents'));

    const data = FS.getByPath('/data');
    expect(data.id).toBe(appDataRoot);

    expect(FS.getByPath('/nowhere-at-all')).toBeNull();
  });

  it('getPath returns the real absolute path of a node id', () => {
    expect(FS.getPath(nodePath.join(fakeHome, 'Documents', 'x.txt')))
      .toBe(nodePath.join(fakeHome, 'Documents', 'x.txt'));
  });

  it('confines every operation to the user home — outside paths are rejected', async () => {
    expect(() => FS.getPath('/etc')).toThrow(/outside the user home directory/);
    expect(() => FS.getPath(nodePath.join(outsideRoot, 'file.txt'))).toThrow(/outside the user home directory/);
    const outsideFile = nodePath.join(outsideRoot, 'outside.txt');
    nodeFs.writeFileSync(outsideFile, 'outside');
    await expect(FS.writeFile(outsideFile, 'nope')).rejects.toThrow(/outside the user home directory/);
    await expect(FS.deleteToTrash(outsideFile)).rejects.toThrow(/outside the user home directory/);
  });

  it('blocks symlink escapes: a link inside home pointing outside is refused', async () => {
    const outsideDir = nodePath.join(outsideRoot, 'escape');
    nodeFs.mkdirSync(outsideDir);
    nodeFs.writeFileSync(nodePath.join(outsideDir, 'secret.txt'), 'secret');
    const link = nodePath.join(fakeHome, 'leak');
    nodeFs.symlinkSync(outsideDir, link);
    try {
      // The link path itself sits under home, but its realpath does not.
      expect(() => FS.getPath(link)).toThrow(/traverses a path outside/);
      await expect(FS.deleteToTrash(nodePath.join(link, 'secret.txt'))).rejects.toThrow(/outside the user home directory/);
    } finally {
      nodeFs.rmSync(link);
      nodeFs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('deleteToTrash moves the file into the real Trash with a unique name', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'trashme.txt', 't');
    const trashed = await FS.deleteToTrash(node.id);
    try {
      expect(nodeFs.existsSync(node.id)).toBe(false);
      expect(nodePath.dirname(trashed.id)).toBe(trashDir);
      expect(nodeFs.readFileSync(trashed.id, 'utf8')).toBe('t');
      expect(events).toHaveBeenCalledWith('fs:deleted', expect.objectContaining({ id: trashed.id }));

      // A second file with the same name gets a deduplicated trash name.
      const twin = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'trashme.txt', 't2');
      const trashed2 = await FS.deleteToTrash(twin.id);
      expect(trashed2.id).not.toBe(trashed.id);
      expect(nodeFs.readFileSync(trashed2.id, 'utf8')).toBe('t2');
    } finally {
      await FS.permanentDelete(trashed.id);
      nodeFs.rmSync(trashDir, { recursive: true, force: true });
      nodeFs.mkdirSync(trashDir, { recursive: true });
    }
  });

  it('permanentDelete removes files and whole folder trees from disk, but never the home itself', async () => {
    const folder = await FS.createFolder(nodePath.join(fakeHome, 'Documents'), 'doomed');
    const child = await FS.createFile(folder.id, 'inner.txt', 'inner');
    await FS.permanentDelete(folder.id);
    expect(nodeFs.existsSync(folder.id)).toBe(false);
    expect(nodeFs.existsSync(child.id)).toBe(false);
    expect(FS.files.has(folder.id)).toBe(false);
    expect(FS.files.has(child.id)).toBe(false);

    await expect(FS.permanentDelete(fakeHome)).rejects.toThrow(/Refusing to delete the user home/);
    expect(nodeFs.existsSync(fakeHome)).toBe(true);
  });

  it('emptyTrash clears the real Trash directory', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Desktop'), 'gone.txt', 'g');
    await FS.deleteToTrash(node.id);
    expect(nodeFs.readdirSync(trashDir).length).toBeGreaterThan(0);
    await FS.emptyTrash();
    expect(nodeFs.readdirSync(trashDir)).toEqual([]);
  });

  it('uniqueName deduplicates against real sibling entries', async () => {
    const docs = nodePath.join(fakeHome, 'Documents');
    await FS.createFile(docs, 'report.txt', '1');
    try {
      expect(FS.uniqueName(docs, 'fresh.txt')).toBe('fresh.txt');
      expect(FS.uniqueName(docs, 'report.txt')).toBe('report (1).txt');
      await FS.createFile(docs, 'report (1).txt', '2');
      expect(FS.uniqueName(docs, 'report.txt')).toBe('report (2).txt');
      await FS.permanentDelete(nodePath.join(docs, 'report (1).txt'));
    } finally {
      await FS.permanentDelete(nodePath.join(docs, 'report.txt'));
    }
  });

  it('search walks the real tree by name and content', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Documents'), 'needle-name.txt', 'haystack-content');
    try {
      const byName = await FS.search('needle-name');
      expect(byName.some((n) => n.id === node.id)).toBe(true);
      const byContent = await FS.search('haystack-content');
      expect(byContent.some((n) => n.id === node.id)).toBe(true);
      expect(await FS.search('')).toEqual([]);
    } finally {
      await FS.permanentDelete(node.id);
    }
  });

  it('pasteInto copies and cuts real files with automatic rename on collision', async () => {
    const original = await FS.createFile(nodePath.join(fakeHome, 'Desktop'), 'paste.txt', 'p');
    const copy = await FS.pasteInto({ fileId: original.id, type: 'copy' }, nodePath.join(fakeHome, 'Documents'));
    try {
      expect(nodeFs.readFileSync(copy.id, 'utf8')).toBe('p');
      expect(nodeFs.existsSync(original.id)).toBe(true);

      const cut = await FS.pasteInto({ fileId: original.id, type: 'cut' }, nodePath.join(fakeHome, 'Documents'));
      expect(nodeFs.existsSync(original.id)).toBe(false);
      expect(nodeFs.readFileSync(cut.id, 'utf8')).toBe('p');
      // The copy already occupies 'paste.txt' in Documents, so the cut is renamed.
      expect(cut.name).not.toBe('paste.txt');
      await FS.permanentDelete(copy.id);
      await FS.permanentDelete(cut.id);
    } finally {
      if (nodeFs.existsSync(original.id)) await FS.permanentDelete(original.id);
    }
  });

  it('cut-pasting a file into its own folder is a no-op, not a self-collision', async () => {
    const node = await FS.createFile(nodePath.join(fakeHome, 'Desktop'), 'selfpaste.txt', 's');
    try {
      const result = await FS.pasteInto({ fileId: node.id, type: 'cut' }, nodePath.join(fakeHome, 'Desktop'));
      expect(result.id).toBe(node.id);
      expect(nodeFs.readFileSync(node.id, 'utf8')).toBe('s');
    } finally {
      await FS.permanentDelete(node.id);
    }
  });
});
