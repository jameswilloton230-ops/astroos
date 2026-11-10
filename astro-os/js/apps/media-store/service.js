'use strict';

(() => {
  const MEDIA_EXTENSIONS = Object.freeze({
    image: new Set(['avif', 'bmp', 'gif', 'heic', 'heif', 'jpe', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']),
    audio: new Set(['aac', 'flac', 'm4a', 'mid', 'midi', 'mp3', 'mp4', 'oga', 'ogg', 'opus', 'wav', 'weba']),
    video: new Set(['3gp', 'avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm']),
  });
  const MAX_INDEX_AGE_MS = 30_000;
  const MAX_RESULTS = 5_000;
  let indexedFiles = [];
  let indexDirty = true;
  let indexedAt = 0;

  function getMediaType(file) {
    const mime = String(file.mimeType || '').toLowerCase();
    for (const type of Object.keys(MEDIA_EXTENSIONS)) {
      if (mime.startsWith(`${type}/`)) return type;
    }
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    return Object.keys(MEDIA_EXTENSIONS).find(type => MEDIA_EXTENSIONS[type].has(extension)) || null;
  }

  function rebuildIndex() {
    const fs = window.FS;
    if (!fs || !fs.rootId || typeof fs.listDir !== 'function' || typeof fs.getPath !== 'function') {
      throw new Error('AstroOS filesystem is not ready');
    }

    const files = [];
    const rootPath = fs.getPath(fs.rootId).replace(/[\\/]+$/, '');
    const pending = [fs.rootId];
    const visited = new Set();
    const excludedFolders = new Set([fs.specialFolders?.trash, fs.specialFolders?.data].filter(Boolean));
    while (pending.length && files.length < MAX_RESULTS) {
      const folderId = pending.pop();
      if (visited.has(folderId) || excludedFolders.has(folderId)) continue;
      visited.add(folderId);
      for (const node of fs.listDir(folderId)) {
        if (node.name.startsWith('.')) continue;
        if (node.type === 'folder') {
          pending.push(node.id);
          continue;
        }
        if (node.type !== 'file') continue;
        const type = getMediaType(node);
        if (!type) continue;
        const absolutePath = fs.getPath(node.id);
        const relativePath = absolutePath === rootPath
          ? '/'
          : absolutePath.slice(rootPath.length).replace(/\\/g, '/');
        files.push({
          id: node.id,
          name: node.name,
          type,
          mimeType: node.mimeType || '',
          size: Number.isFinite(node.size) ? node.size : 0,
          created: Number.isFinite(node.created) ? node.created : 0,
          modified: Number.isFinite(node.modified) ? node.modified : 0,
          path: `media:${relativePath.startsWith('/') ? relativePath : `/${relativePath}`}`,
        });
        if (files.length >= MAX_RESULTS) break;
      }
    }
    files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    indexedFiles = files;
    indexedAt = Date.now();
    indexDirty = false;
  }

  function query(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Media query options must be an object');
    }
    const type = options.type || 'all';
    if (!['all', 'image', 'audio', 'video'].includes(type)) {
      throw new TypeError('Media type must be all, image, audio, or video');
    }
    if (indexDirty || Date.now() - indexedAt > MAX_INDEX_AGE_MS) rebuildIndex();

    if (options.offset !== undefined &&
        (!Number.isSafeInteger(options.offset) || options.offset < 0)) {
      throw new TypeError('Media query offset must be a non-negative integer');
    }
    if (options.limit !== undefined &&
        (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
      throw new TypeError('Media query limit must be a positive integer');
    }
    const offset = options.offset ?? 0;
    const limit = Math.min(options.limit ?? 100, 500);
    return indexedFiles
      .filter(file => type === 'all' || file.type === type)
      .slice(offset, offset + limit)
      .map(file => ({ ...file }));
  }

  for (const event of ['fs:created', 'fs:updated', 'fs:moved', 'fs:deleted']) {
    window.OS?.events?.on?.(event, () => { indexDirty = true; });
  }

  window.AstroOSMediaStore = Object.freeze({ query });
})();
