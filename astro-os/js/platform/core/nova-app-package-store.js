(function () {
  'use strict';

  const APPS_KEY = 'nova_installed_apps';
  const APP_ROOT = 'apps';
  const STORAGE_VERSION = 1;

  function parseJSON(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }

  function loadRegistry() {
    try { return parseJSON(localStorage.getItem(APPS_KEY), []); }
    catch { return []; }
  }

  function safeAppId(id) {
    return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function storagePathForApp(id) {
    return `${APP_ROOT}/${safeAppId(id)}`;
  }

  function normalizePackagePath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      throw new Error(`Invalid package file path: ${path}`);
    }
    return parts.join('/');
  }

  function guessMime(path) {
    const lower = String(path || '').toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
    if (lower.endsWith('.css')) return 'text/css';
    if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.svg')) return 'image/svg+xml';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain';
    return 'application/octet-stream';
  }

  function toMetadata(app, extra = {}) {
    const meta = {};
    for (const [key, value] of Object.entries(app || {})) {
      if (key === 'files' || key === '_cachedHtml') continue;
      if (typeof value === 'function') continue;
      meta[key] = value;
    }
    meta.storageVersion = extra.storageVersion || meta.storageVersion || STORAGE_VERSION;
    meta.storagePath = extra.storagePath || meta.storagePath || storagePathForApp(meta.id);
    if (Number.isFinite(extra.fileCount)) meta.fileCount = extra.fileCount;
    if (Number.isFinite(extra.packageSize)) meta.packageSize = extra.packageSize;
    return meta;
  }

  function toMetadataList(list) {
    return (Array.isArray(list) ? list : []).filter(app => app && app.id).map(app => toMetadata(app));
  }

  function saveRegistry(list) {
    const metadata = toMetadataList(list);
    localStorage.setItem(APPS_KEY, JSON.stringify(metadata));
    if (window.AppDirs?.syncKey) AppDirs.syncKey(APPS_KEY, metadata).catch(() => {});
    return metadata;
  }

  async function ensureReady() {
    if (typeof OPFS === 'undefined') throw new Error('OPFS service is not available yet');
    if (typeof OPFS.init === 'function') await OPFS.init();
  }

  function base64ToBlob(encoded, type) {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  async function readFileIndex(storagePath) {
    await ensureReady();
    const raw = await OPFS.readText(`${storagePath}/files.index.json`);
    return raw ? JSON.parse(raw) : null;
  }

  async function removeStoredFiles(appOrMeta) {
    await ensureReady();
    const storagePath = appOrMeta?.storagePath || storagePathForApp(appOrMeta?.id);
    if (!storagePath) return false;

    let index = null;
    try { index = await readFileIndex(storagePath); }
    catch { index = null; }

    if (Array.isArray(index?.files)) {
      for (const file of index.files) {
        const path = file.storagePath || `${storagePath}/files/${file.path}`;
        await OPFS.deleteBlob(path).catch(() => {});
      }
    }

    await OPFS.deleteBlob(`${storagePath}/files.index.json`).catch(() => {});
    await OPFS.deleteBlob(`${storagePath}/app.json`).catch(() => {});
    await OPFS.deleteBlob(`${storagePath}/manifest.json`).catch(() => {});
    await OPFS.deletePath(storagePath, true).catch(() => {});
    return true;
  }

  async function installApp(appData) {
    if (!appData?.id) throw new Error('App id is required');
    if (!appData.files || typeof appData.files !== 'object') throw new Error('Package files are required');

    await ensureReady();

    const storagePath = storagePathForApp(appData.id);
    await removeStoredFiles({ id: appData.id, storagePath }).catch(() => {});
    await OPFS.ensureDirectory(`${storagePath}/files`).catch(() => null);

    const fileIndex = [];
    let packageSize = 0;

    for (const [rawPath, encoded] of Object.entries(appData.files)) {
      if (typeof encoded !== 'string') continue;
      const relPath = normalizePackagePath(rawPath);
      const filePath = `${storagePath}/files/${relPath}`;
      const blob = base64ToBlob(encoded, guessMime(relPath));
      await OPFS.writeBlob(filePath, blob, blob.type || 'application/octet-stream');
      packageSize += blob.size || 0;
      fileIndex.push({
        path: relPath,
        storagePath: filePath,
        type: blob.type || '',
        size: blob.size || 0
      });
    }

    const metadata = toMetadata(appData, {
      storagePath,
      storageVersion: STORAGE_VERSION,
      fileCount: fileIndex.length,
      packageSize
    });

    await OPFS.writeText(`${storagePath}/files.index.json`, JSON.stringify({
      version: STORAGE_VERSION,
      files: fileIndex
    }, null, 2), 'application/json');
    await OPFS.writeText(`${storagePath}/manifest.json`, JSON.stringify(appData.manifest || metadata, null, 2), 'application/json');
    await OPFS.writeText(`${storagePath}/app.json`, JSON.stringify(metadata, null, 2), 'application/json');

    return metadata;
  }

  async function hydrateApp(app, options = {}) {
    if (!app?.id) return null;

    if (app.files && typeof app.files === 'object') {
      let metadata = toMetadata(app);
      if (options.migrateLegacy !== false) {
        try { metadata = await installApp(app); }
        catch (error) { console.warn('[NovaAppPackageStore] Legacy package migration failed for', app.id, error); }
      }
      return { ...app, ...metadata, files: app.files };
    }

    const storagePath = app.storagePath || storagePathForApp(app.id);
    try {
      const index = await readFileIndex(storagePath);
      if (!Array.isArray(index?.files)) throw new Error('Stored package file index is missing');

      const files = {};
      for (const file of index.files) {
        const relPath = normalizePackagePath(file.path);
        const blob = await OPFS.getBlob(file.storagePath || `${storagePath}/files/${relPath}`);
        if (!blob) throw new Error(`Stored package file is missing: ${relPath}`);
        files[relPath] = await blobToBase64(blob);
      }
      return { ...app, storagePath, files };
    } catch (error) {
      console.warn('[NovaAppPackageStore] Failed to hydrate package', app.id, error);
      return { ...app, storagePath, _loadError: error?.message || String(error) };
    }
  }

  async function hydrateApps(list, options = {}) {
    const source = Array.isArray(list) ? list : [];
    const hydrated = [];
    let registryChanged = false;

    for (const app of source) {
      const full = await hydrateApp(app, options);
      if (!full) continue;
      hydrated.push(full);
      if (app.files || !app.storagePath || app.storagePath !== full.storagePath) registryChanged = true;
    }

    if (registryChanged && options.saveMigrated !== false) {
      try { saveRegistry(hydrated); }
      catch (error) { console.warn('[NovaAppPackageStore] Failed to save migrated registry:', error); }
    }

    return hydrated;
  }

  async function removeApp(appOrId, options = {}) {
    const id = typeof appOrId === 'string' ? appOrId : appOrId?.id;
    if (!id) return false;

    const registry = loadRegistry();
    const meta = typeof appOrId === 'string'
      ? registry.find(app => app.id === id) || { id, storagePath: storagePathForApp(id) }
      : appOrId;

    await removeStoredFiles(meta);

    if (options.updateRegistry !== false) {
      saveRegistry(registry.filter(app => app.id !== id));
    }

    return true;
  }

  window.NovaAppPackageStore = Object.freeze({
    APPS_KEY,
    loadRegistry,
    saveRegistry,
    toMetadata,
    toMetadataList,
    storagePathForApp,
    installApp,
    hydrateApp,
    hydrateApps,
    removeApp
  });
})();