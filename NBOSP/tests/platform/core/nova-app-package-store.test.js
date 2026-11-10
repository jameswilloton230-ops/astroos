import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetTestStorage } from '../../setup.js';

// ── Mock OPFS ─────────────────────────────────────────────────────────────
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

globalThis.OPFS = opfsMock;

describe('NovaAppPackageStore (js/platform/core/nova-app-package-store.js)', () => {
  beforeEach(() => {
    resetTestStorage();
    _opfsFiles.clear();
    _opfsDirs.clear();
    _opfsDirs.add('/');
    vi.clearAllMocks();
    // Load the module to populate window.NovaAppPackageStore
    require('../../../js/platform/core/nova-app-package-store.js');
  });

  it('exposes expected methods on window.NovaAppPackageStore', () => {
    expect(window.NovaAppPackageStore).toBeDefined();
    expect(typeof window.NovaAppPackageStore.installApp).toBe('function');
    expect(typeof window.NovaAppPackageStore.hydrateApp).toBe('function');
    expect(typeof window.NovaAppPackageStore.saveRegistry).toBe('function');
    expect(typeof window.NovaAppPackageStore.loadRegistry).toBe('function');
    expect(typeof window.NovaAppPackageStore.removeApp).toBe('function');
    expect(typeof window.NovaAppPackageStore.toMetadata).toBe('function');
  });

  it('loadRegistry returns [] when localStorage is empty', () => {
    localStorage.removeItem('nova_installed_apps');
    const result = window.NovaAppPackageStore.loadRegistry();
    expect(result).toEqual([]);
  });

  it('saveRegistry persists metadata to localStorage', () => {
    const list = [{ id: 'app1', name: 'App One', version: '1.0.0' }];
    const saved = window.NovaAppPackageStore.saveRegistry(list);
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('app1');
    expect(saved[0].storageVersion).toBe(1);
    const raw = localStorage.getItem('nova_installed_apps');
    expect(JSON.parse(raw)).toEqual(saved);
  });

  it('saveRegistry strips files and _cachedHtml from metadata', () => {
    const list = [{ id: 'app1', name: 'A', files: { a: '1' }, _cachedHtml: '<html/>', extra: true }];
    const saved = window.NovaAppPackageStore.saveRegistry(list);
    expect(saved[0].files).toBeUndefined();
    expect(saved[0]._cachedHtml).toBeUndefined();
    expect(saved[0].extra).toBe(true);
  });

  it('toMetadata transforms an app object correctly', () => {
    const meta = window.NovaAppPackageStore.toMetadata({ id: 'x', name: 'X', files: { a: '1' }, fn: () => {} });
    expect(meta.id).toBe('x');
    expect(meta.name).toBe('X');
    expect(meta.files).toBeUndefined();
    expect(meta.fn).toBeUndefined();
    expect(meta.storagePath).toBe('apps/x');
    expect(meta.storageVersion).toBe(1);
  });

  it('storagePathForApp sanitizes unsafe characters', () => {
    expect(window.NovaAppPackageStore.storagePathForApp('my.app')).toBe('apps/my.app');
    expect(window.NovaAppPackageStore.storagePathForApp('app/../evil')).toBe('apps/app_.._evil');
    expect(window.NovaAppPackageStore.storagePathForApp('')).toBe('apps/');
  });

  it('installApp writes files to OPFS and returns metadata', async () => {
    const pkg = {
      id: 'inst-app',
      name: 'Installed',
      version: '2.0.0',
      files: {
        'index.html': btoa('<h1>Hello</h1>'),
        'app.js': btoa('console.log(1)'),
      },
    };
    const meta = await window.NovaAppPackageStore.installApp(pkg);
    expect(meta.id).toBe('inst-app');
    expect(meta.fileCount).toBe(2);
    expect(meta.storagePath).toBe('apps/inst-app');
    expect(meta.packageSize).toBeGreaterThan(0);
    const indexRaw = await opfsMock.readText('apps/inst-app/files.index.json');
    expect(indexRaw).toBeDefined();
    const index = JSON.parse(indexRaw);
    expect(index.files).toHaveLength(2);
  });

  it('installApp rejects when id or files are missing', async () => {
    await expect(window.NovaAppPackageStore.installApp({})).rejects.toThrow('App id is required');
    await expect(window.NovaAppPackageStore.installApp({ id: 'x' })).rejects.toThrow('Package files are required');
  });

  it('hydrateApp returns merged object for in-memory packages', async () => {
    const pkg = { id: 'hydrate-mem', name: 'HM', files: { 'a.txt': btoa('test') } };
    const result = await window.NovaAppPackageStore.hydrateApp(pkg);
    expect(result.id).toBe('hydrate-mem');
    expect(result.files).toEqual(pkg.files);
  });

  it('hydrateApp falls back to storage when no files are in memory', async () => {
    await window.NovaAppPackageStore.installApp({
      id: 'stored-app',
      name: 'Stored',
      files: { 'hello.txt': 'aGVsbG8=' },
    });
    const result = await window.NovaAppPackageStore.hydrateApp({ id: 'stored-app', name: 'Stored' });
    expect(result.id).toBe('stored-app');
    expect(result.files).toBeDefined();
    expect(result._loadError).toBeUndefined();
  });

  it('hydrateApps processes a list and returns hydrated apps', async () => {
    await window.NovaAppPackageStore.installApp({
      id: 'list-app',
      name: 'ListApp',
      files: { 'f.txt': btoa('Zm9v') },
    });
    const result = await window.NovaAppPackageStore.hydrateApps([{ id: 'list-app', name: 'ListApp' }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('list-app');
  });

  it('removeApp deletes OPFS files and updates registry', async () => {
    await window.NovaAppPackageStore.installApp({
      id: 'remove-me',
      name: 'Remove',
      files: { 'f.txt': btoa('dGVzdA==') },
    });
    expect(_opfsFiles.size).toBeGreaterThan(0);
    const result = await window.NovaAppPackageStore.removeApp('remove-me');
    expect(result).toBe(true);
    const registry = window.NovaAppPackageStore.loadRegistry();
    expect(registry.some(a => a.id === 'remove-me')).toBe(false);
  });

  it('removeApp returns false when id is missing', async () => {
    const result = await window.NovaAppPackageStore.removeApp('');
    expect(result).toBe(false);
  });
});

// ── Registry-backed inventory (HKNS/apps/installed) ───────────────────────
// With the NovaByte Registry wired onto window (the shell always boots it),
// loadRegistry/saveRegistry go through RegistrySystemState — the localStorage
// key is only the pre-registry adoption source and fail-soft fallback.
describe('NovaAppPackageStore — registry-backed inventory', () => {
  // NOTE: the UMD modules assign their window.* globals at load time, so
  // they are required INSIDE each test — requiring them at collection time
  // would leak the globals into the localStorage-fallback tests above.
  const REG_PATH = '../../../js/platform/core/nova-registry.js';
  const STATE_PATH = '../../../js/platform/core/registry-system-state.js';

  function memStorage(NovaRegistry) {
    const map = new Map();
    return {
      loadAll() {
        const out = {};
        for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
          out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
        }
        return out;
      },
      save(hive, data) { map.set(hive, JSON.stringify(data)); },
    };
  }

  function wireRegistry() {
    const NovaRegistry = require(REG_PATH);
    const RegistrySystemState = require(STATE_PATH);
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: memStorage(NovaRegistry), events: null, logger: console });
    window.NovaRegistry = NovaRegistry;
    window.RegistrySystemState = RegistrySystemState;
    return { NovaRegistry, RegistrySystemState };
  }

  afterEach(() => {
    // Never leak the registry globals into other suites in this worker.
    const RegistrySystemState = require(STATE_PATH);
    delete window.NovaRegistry;
    delete window.RegistrySystemState;
    RegistrySystemState._internal.resetAdopted();
  });

  it('saveRegistry commits into HKNS/apps/installed and loadRegistry reads it back', () => {
    const { NovaRegistry } = wireRegistry();
    localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.legacy.app', version: '1.0' }]));

    const saved = window.NovaAppPackageStore.saveRegistry([{ id: 'com.new.app', version: '2.0', files: { 'a.txt': 'x' } }]);
    expect(saved).toHaveLength(1);
    expect(NovaRegistry.get('HKNS/apps/installed')).toEqual(saved);
    // The legacy LS key is not the store anymore — writes go to the hive only.
    expect(JSON.parse(localStorage.getItem('nova_installed_apps'))).toEqual([{ id: 'com.legacy.app', version: '1.0' }]);

    expect(window.NovaAppPackageStore.loadRegistry()).toEqual(saved);
  });

  it('adopts the pre-registry localStorage inventory on first read', () => {
    const { NovaRegistry } = wireRegistry();
    localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.upgrade.app', version: '9.1' }]));

    expect(window.NovaAppPackageStore.loadRegistry()).toEqual([{ id: 'com.upgrade.app', version: '9.1' }]);
    expect(NovaRegistry.get('HKNS/apps/installed')).toEqual([{ id: 'com.upgrade.app', version: '9.1' }]);
  });

  it('still works with plain localStorage when no registry exists', () => {
    const saved = window.NovaAppPackageStore.saveRegistry([{ id: 'com.plain.app' }]);
    expect(saved).toEqual([expect.objectContaining({ id: 'com.plain.app' })]);
    expect(window.NovaAppPackageStore.loadRegistry()).toEqual(saved);
  });
});
