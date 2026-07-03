// WEB WORKERS (INLINE BLOB)

const FS_WORKER_CODE = `
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
const DB_NAME = 'NovaByte_FS';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_SETTINGS = 'settings';
const STORE_NOTIFICATIONS = 'notifications';
const STORE_EVENTS = 'calendar_events';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch(e) {
      // IDB blocked (sandboxed VM context) — build an in-memory fallback DB
      const _stores = {};
      function _ms(n) {
        if (!_stores[n]) _stores[n] = {};
        const s = _stores[n];
        return {
          put(i) { const k = i.id !== undefined ? i.id : i.key !== undefined ? i.key : JSON.stringify(i); s[k] = i; return {}; },
          get(k) { const r = {result: s[k]}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; },
          getAll() { const r = {result: Object.values(s)}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; },
          delete(k) { delete s[k]; return {}; },
          createIndex() { return { getAll() { const r={result:[]}; setTimeout(() => r.onsuccess?.({target:r}), 0); return r; } }; }
        };
      }
      db = {
        objectStoreNames: { contains: n => !!_stores[n] },
        createObjectStore: n => { _stores[n] = {}; return _ms(n); },
        transaction(storeName, mode) {
          const tx = { objectStore: n => _ms(n), oncomplete: null, onerror: null };
          setTimeout(() => tx.oncomplete?.({target:tx}), 0);
          return tx;
        }
      };
      // Pre-create the expected stores
      [STORE_FILES, STORE_SETTINGS, STORE_NOTIFICATIONS, STORE_EVENTS].forEach(n => { _stores[n] = {}; });
      resolve(db);
      return;
    }
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_FILES)) {
        d.createObjectStore(STORE_FILES, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(STORE_SETTINGS)) {
        d.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!d.objectStoreNames.contains(STORE_NOTIFICATIONS)) {
        const ns = d.createObjectStore(STORE_NOTIFICATIONS, { keyPath: 'id' });
        ns.createIndex('timestamp', 'timestamp');
      }
      if (!d.objectStoreNames.contains(STORE_EVENTS)) {
        d.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function getAllFiles() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readonly');
    const req = tx.objectStore(STORE_FILES).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putFiles(files) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readwrite');
    const store = tx.objectStore(STORE_FILES);
    for (const f of files) store.put(f);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFile(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_FILES, 'readwrite');
    tx.objectStore(STORE_FILES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getSetting(key) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
    req.onerror = () => reject(req.error);
  });
}

async function putSetting(key, value) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllSettings() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).getAll();
    req.onsuccess = () => {
      const map = {};
      for (const item of req.result) map[item.key] = item.value;
      resolve(map);
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveEvents(events) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readwrite');
    const store = tx.objectStore(STORE_EVENTS);
    for (const e of events) store.put(e);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEvents() {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readonly');
    const req = tx.objectStore(STORE_EVENTS).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEvent(id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(STORE_EVENTS, 'readwrite');
    tx.objectStore(STORE_EVENTS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'init': await openDB(); result = true; break;
      case 'getAllFiles': result = await getAllFiles(); break;
      case 'putFiles': await putFiles(args[0]); result = true; break;
      case 'deleteFile': await deleteFile(args[0]); result = true; break;
      case 'getSetting': result = await getSetting(args[0]); break;
      case 'putSetting': await putSetting(args[0], args[1]); result = true; break;
      case 'getAllSettings': result = await getAllSettings(); break;
      case 'saveEvents': await saveEvents(args[0]); result = true; break;
      case 'getAllEvents': result = await getAllEvents(); break;
      case 'deleteEvent': await deleteEvent(args[0]); result = true; break;
      default: throw new Error('Unknown method: ' + method);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
`;

      const SEARCH_WORKER_CODE = `
'use strict';
let index = new Map();

function buildIndex(files) {
  index.clear();
  for (const f of files) {
    // Deduplicate terms per file first — cuts index size and memory use significantly
    const termSet = new Set(
      ((f.name || '') + ' ' + (f.content || '')).toLowerCase().split(/\\W+/).filter(t => t.length >= 2)
    );
    for (const t of termSet) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(f.id);
    }
  }
}

function search(query, files) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const fileMap = new Map(files.map(f => [f.id, f]));
  const results = new Map();
  for (const [term, ids] of index) {
    if (term.includes(q)) {
      for (const id of ids) {
        results.set(id, (results.get(id) || 0) + 1);
      }
    }
  }
  return Array.from(results.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([id]) => fileMap.get(id))
    .filter(Boolean);
}

self.onmessage = (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'buildIndex': buildIndex(args[0]); result = true; break;
      case 'search': result = search(args[0], args[1]); break;
      default: result = null;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

      const CRYPTO_WORKER_CODE = `
'use strict';

async function sha256(data) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const array = Array.from(new Uint8Array(hash));
  return array.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2Hash(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256'
  }, keyMaterial, 256);
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
}

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'sha256': result = await sha256(args[0]); break;
      case 'pbkdf2': result = await pbkdf2Hash(args[0], args[1]); break;
      default: result = null;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

      const CALENDAR_WORKER_CODE = `
'use strict';

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    let result;
    switch (method) {
      case 'getEvents': result = JSON.parse(localStorage.getItem('events') || '[]'); break;
      case 'saveEvents': localStorage.setItem('events', JSON.stringify(args[0])); result = true; break;
      default: result = null;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
`;

      function createWorker(code) {
        const blob = new Blob([code], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);
        let _id = 0;
        const pending = new Map();
        worker.onmessage = (e) => {
          const { id, result, error } = e.data;
          const p = pending.get(id);
          if (p) {
            pending.delete(id);
            if (error) p.reject(new Error(error));
            else p.resolve(result);
          }
        };
        return {
          call(method, ...args) {
            const id = ++_id;
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              worker.postMessage({ id, method, args });
            });
          },
          terminate() { worker.terminate(); }
        };
      }

// ── EXPOSE TO GLOBAL RUNTIME SCOPE ───────────────────────────────────────────
if (typeof FS_WORKER_CODE !== 'undefined') window.FS_WORKER_CODE = FS_WORKER_CODE;
if (typeof CRYPTO_WORKER_CODE !== 'undefined') window.CRYPTO_WORKER_CODE = CRYPTO_WORKER_CODE;
if (typeof SEARCH_WORKER_CODE !== 'undefined') window.SEARCH_WORKER_CODE = SEARCH_WORKER_CODE;
if (typeof createWorker !== 'undefined') window.createWorker = createWorker;
