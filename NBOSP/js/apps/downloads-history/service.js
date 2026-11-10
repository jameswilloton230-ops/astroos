'use strict';

const DOWNLOADS_STORAGE_KEY = 'nova_downloads';
const DOWNLOADS_MAX_ENTRIES = 500;
const downloadListeners = new Set();
const nativeDownloadIds = new Map();

function safeDownloadName(item) {
  let name = '';
  if (item.filename) {
    name = String(item.filename).split(/[\\/]/).pop();
  } else {
    try {
      name = decodeURIComponent(new URL(item.url).pathname.split('/').pop());
    } catch (error) {
      console.warn('[DownloadsHistory] Could not parse download filename:', error);
    }
  }
  return (name || `download_${Date.now()}`)
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 128) || `download_${Date.now()}`;
}

function nativeDownloadStatus(state) {
  if (state === 'complete') return 'done';
  if (state === 'interrupted') return 'failed';
  return 'downloading';
}

function loadDownloadHistory() {
  try {
    const raw = localStorage.getItem(DOWNLOADS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('[DownloadsHistory] Could not read download history:', error);
    return [];
  }
}

function saveDownloadHistory(items) {
  if (!Array.isArray(items)) throw new TypeError('Download history must be an array');
  const boundedItems = items.slice(0, DOWNLOADS_MAX_ENTRIES);
  if (typeof window.lsSave === 'function') {
    window.lsSave(DOWNLOADS_STORAGE_KEY, boundedItems);
  } else {
    localStorage.setItem(DOWNLOADS_STORAGE_KEY, JSON.stringify(boundedItems));
  }
  return boundedItems;
}

function notifyDownloadListeners(change) {
  const items = loadDownloadHistory();
  for (const listener of [...downloadListeners]) {
    try {
      listener(items, change);
    } catch (error) {
      console.error('[DownloadsHistory] Listener failed:', error);
    }
  }
}

function createDownloadId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('A secure random source is required to create download IDs');
}

const Downloads = Object.freeze({
  add(name, url, size, mimeType, status = 'done') {
    const entry = {
      id: createDownloadId(),
      name: name || 'Unknown file',
      url: url || '',
      size: size || 0,
      mimeType: mimeType || '',
      ts: Date.now(),
      status,
    };
    saveDownloadHistory([entry, ...loadDownloadHistory()]);
    notifyDownloadListeners('add');
    return entry;
  },

  setStatus(id, status, size) {
    const items = loadDownloadHistory();
    const entry = items.find(item => item.id === id);
    if (!entry) return false;
    entry.status = status;
    if (size != null) entry.size = size;
    saveDownloadHistory(items);
    notifyDownloadListeners('status');
    return true;
  },

  getAll() {
    return loadDownloadHistory();
  },

  remove(id) {
    const items = loadDownloadHistory();
    const nextItems = items.filter(item => item.id !== id);
    if (nextItems.length === items.length) return false;
    saveDownloadHistory(nextItems);
    notifyDownloadListeners('remove');
    return true;
  },

  clearCompleted() {
    const items = loadDownloadHistory();
    const nextItems = items.filter(item => item.status === 'downloading');
    if (nextItems.length === items.length) return false;
    saveDownloadHistory(nextItems);
    notifyDownloadListeners('clear-completed');
    return true;
  },

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Download history listener must be a function');
    downloadListeners.add(listener);
    return () => downloadListeners.delete(listener);
  },
});

window.Downloads = Downloads;

function attachNativeDownloads(api) {
  if (!api?.onDeterminingFilename?.addListener || !api?.onCreated?.addListener || !api?.onChanged?.addListener) {
    console.warn('[DownloadsHistory] Native downloads API is unavailable.');
    return false;
  }

  api.onDeterminingFilename.addListener((item, suggest) => {
    suggest({ filename: safeDownloadName(item), conflictAction: 'uniquify' });
  });

  api.onCreated.addListener(item => {
    const entry = Downloads.add(
      safeDownloadName(item),
      item.url,
      item.totalBytes > 0 ? item.totalBytes : 0,
      item.mime || '',
      nativeDownloadStatus(item.state),
    );
    if (item.state !== 'complete' && item.state !== 'interrupted') {
      nativeDownloadIds.set(item.id, entry.id);
    }
  });

  api.onChanged.addListener((delta, downloadId) => {
    const entryId = nativeDownloadIds.get(downloadId);
    if (!entryId) return;

    const state = delta.state?.current;
    const status = state ? nativeDownloadStatus(state) : undefined;
    const size = delta.totalBytes?.current > 0
      ? delta.totalBytes.current
      : delta.bytesReceived?.current;
    if (status) Downloads.setStatus(entryId, status, size);
    else if (size != null) {
      const current = Downloads.getAll().find(item => item.id === entryId);
      if (current) Downloads.setStatus(entryId, current.status, size);
    }
    if (state === 'complete' || state === 'interrupted') nativeDownloadIds.delete(downloadId);
  });

  return true;
}

if (typeof chrome !== 'undefined' && chrome.downloads) {
  attachNativeDownloads(chrome.downloads);
}

window.addEventListener('storage', event => {
  if (event.key === DOWNLOADS_STORAGE_KEY || event.key === null) {
    notifyDownloadListeners('storage');
  }
});
