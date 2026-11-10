'use strict';

function buildTrigramIndex(items, keyFn) {
  if (!Array.isArray(items)) throw new TypeError('Search index items must be an array');
  if (typeof keyFn !== 'function') throw new TypeError('Search index key selector must be a function');

  const index = new Map();
  for (const item of items) {
    const keys = [].concat(keyFn(item));
    for (const key of keys) {
      const value = (key || '').toLowerCase();
      for (let i = 0; i <= value.length - 3; i++) {
        const gram = value.slice(i, i + 3);
        let bucket = index.get(gram);
        if (!bucket) {
          bucket = new Set();
          index.set(gram, bucket);
        }
        bucket.add(item);
      }
    }
  }
  return { items, index };
}

function searchTrigramIndex(built, query, verifyFn) {
  if (!built || !Array.isArray(built.items) || !(built.index instanceof Map)) {
    throw new TypeError('Search index is invalid');
  }
  if (typeof verifyFn !== 'function') throw new TypeError('Search verifier must be a function');

  const lowerQuery = String(query || '').toLowerCase();
  if (!lowerQuery) return [];
  if (lowerQuery.length < 3) {
    return built.items.filter(item => verifyFn(item, lowerQuery));
  }

  let rarestBucket = null;
  for (let i = 0; i <= lowerQuery.length - 3; i++) {
    const bucket = built.index.get(lowerQuery.slice(i, i + 3));
    if (!bucket) return [];
    if (rarestBucket === null || bucket.size < rarestBucket.size) rarestBucket = bucket;
  }

  const results = [];
  for (const item of rarestBucket || []) {
    if (verifyFn(item, lowerQuery)) results.push(item);
  }
  return results;
}

function collectSearchableFiles(fs) {
  if (!fs?.files || typeof fs.listDir !== 'function') return [];

  const pending = [fs.rootId, fs.specialFolders?.data].filter(Boolean);
  const visited = new Set();
  const files = new Map();
  while (pending.length) {
    const folderId = pending.pop();
    if (visited.has(folderId)) continue;
    visited.add(folderId);
    for (const entry of fs.listDir(folderId)) {
      if (entry.type === 'folder') {
        if (!entry.name.startsWith('.')) pending.push(entry.id);
      } else if (entry.type === 'file') {
        files.set(entry.id, entry);
      }
    }
  }

  if (!files.size) {
    for (const entry of fs.files.values()) {
      if (entry.type === 'file') files.set(entry.id, entry);
    }
  }
  return [...files.values()];
}

const storageWatchers = new Set();
const originalSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  const result = originalSetItem(key, value);
  for (const watcher of [...storageWatchers]) {
    if (watcher.keys.has(key)) {
      try {
        watcher.listener(key);
      } catch (error) {
        console.error('[SearchIndex] Storage watcher failed:', error);
      }
    }
  }
  return result;
};

function watchStorage(keys, listener) {
  if (!Array.isArray(keys) || typeof listener !== 'function') {
    throw new TypeError('Storage watch requires keys and a listener');
  }
  const watcher = { keys: new Set(keys), listener };
  storageWatchers.add(watcher);
  return () => storageWatchers.delete(watcher);
}

window.addEventListener('storage', event => {
  for (const watcher of [...storageWatchers]) {
    if (event.key === null || watcher.keys.has(event.key)) {
      try {
        watcher.listener(event.key);
      } catch (error) {
        console.error('[SearchIndex] Storage watcher failed:', error);
      }
    }
  }
});

window.SearchIndex = Object.freeze({
  build: buildTrigramIndex,
  search: searchTrigramIndex,
  collectFiles: collectSearchableFiles,
  watchStorage,
});
