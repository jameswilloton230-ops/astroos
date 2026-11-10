'use strict';
// Minimal in-memory IndexedDB covering exactly the surface app-sandbox.js's
// nova:storage layer uses: open (+upgradeneeded), transaction, objectStore
// get/put/delete, index('by_appId').openCursor with IDBKeyRange.only/bound,
// cursor.continue()/delete(). Requests settle on the next macrotask so the
// async handler code behaves like a real browser.
//
// Not a general polyfill — intentionally only what the tests need.

function keyId(key) {
  return JSON.stringify(key);
}

// IDB key comparison: only strings and arrays of strings occur here, but be
// strict about it so a future code change that stores numbers fails loudly
// instead of silently mis-ordering.
function compareKeys(a, b) {
  const aa = Array.isArray(a), ab = Array.isArray(b);
  if (!aa && !ab) {
    if (typeof a !== typeof b) throw new Error('fake-idb: mixed key types: ' + typeof a + ' vs ' + typeof b);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  if (aa !== ab) throw new Error('fake-idb: mixed array/scalar key');
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = compareKeys(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

class FakeRange {
  constructor(kind, parts) { this.__kind = kind; this.__parts = parts; }
  test(key) {
    if (this.__kind === 'only') return compareKeys(key, this.__parts[0]) === 0;
    // bound(lo, hi, loOpen, hiOpen)
    const [lo, hi, loOpen, hiOpen] = this.__parts;
    const loC = compareKeys(key, lo), hiC = compareKeys(key, hi);
    if (loC < 0 || (loC === 0 && loOpen)) return false;
    if (hiC > 0 || (hiC === 0 && hiOpen)) return false;
    return true;
  }
}

function makeRequest() {
  const req = {
    onsuccess: null, onerror: null, onupgradeneeded: null,
    result: undefined, error: null, readyState: 'pending',
  };
  req.__settle = function (err) {
    req.readyState = 'done';
    setImmediate(() => {
      if (err) {
        req.error = err;
        if (req.onerror) req.onerror({ target: req });
        return;
      }
      if (req.onsuccess) req.onsuccess({ target: req });
    });
  };
  return req;
}

function install(target) {
  const databases = new Map(); // name -> { stores: Map }

  function getDb(name) {
    if (!databases.has(name)) databases.set(name, { stores: new Map() });
    return databases.get(name);
  }

  const indexedDB = {
    open(name /*, version */) {
      const req = makeRequest();
      const db = getDb(name);
      const isNew = !db.stores.has('kv');
      setImmediate(() => {
        if (isNew && req.onupgradeneeded) {
          req.onupgradeneeded({
            target: {
              result: {
                objectStoreNames: { contains: (n) => db.stores.has(n) },
                createObjectStore(n, opts) {
                  const store = { name: n, keyPath: opts.keyPath, indexes: new Map(), rows: new Map() };
                  store.createIndex = (iname, ikeyPath) => store.indexes.set(iname, ikeyPath);
                  db.stores.set(n, store);
                  return store;
                },
              },
            },
          });
        }
        req.result = wrapDb(db);
        req.__settle(null);
      });
      return req;
    },
  };

  function wrapDb(db) {
    return {
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      transaction(storeName /*, mode */) {
        const store = db.stores.get(storeName);
        if (!store) throw new Error('fake-idb: no store ' + storeName);
        const tx = {
          oncomplete: null, onerror: null, onabort: null, error: null,
          objectStore() { return wrapStore(store, tx); },
        };
        // Completion by quiescence: every new request or request settle
        // pushes the commit timer back. A real transaction commits when all
        // outstanding requests are done; a cursor that yields N rows fires
        // its request N+1 times, so request-counting would drift — this
        // model gets the observable behaviour right instead.
        let completeTimer = null, committed = false, txError = null;
        function scheduleCommit() {
          if (completeTimer) clearTimeout(completeTimer);
          completeTimer = setTimeout(() => {
            completeTimer = null;
            if (committed) return;
            committed = true;
            if (txError && tx.onerror) tx.onerror({ target: tx });
            else if (tx.oncomplete) tx.oncomplete({ target: tx });
          }, 12);
        }
        tx.__track = (req) => {
          scheduleCommit();
          const orig = req.__settle.bind(req);
          req.__settle = (err) => {
            if (err) txError = err;
            orig(err);
            setImmediate(scheduleCommit);
          };
          return req;
        };
        return tx;
      },
    };
  }

  function wrapStore(store, tx) {
    return {
      get(key) {
        const req = tx.__track(makeRequest());
        setImmediate(() => {
          const rec = store.rows.get(keyId(key));
          req.result = rec ? rec.value : undefined;
          req.__settle(null);
        });
        return req;
      },
      put(record) {
        const req = tx.__track(makeRequest());
        setImmediate(() => {
          const k = store.keyPath;
          const key = Array.isArray(k) ? k.map((f) => record[f]) : record[k];
          store.rows.set(keyId(key), { __key: key, value: record });
          req.result = key;
          req.__settle(null);
        });
        return req;
      },
      delete(key) {
        const req = tx.__track(makeRequest());
        setImmediate(() => {
          store.rows.delete(keyId(key));
          req.__settle(null);
        });
        return req;
      },
      index(name) {
        const keyPath = store.indexes.get(name);
        if (!keyPath) throw new Error('fake-idb: no index ' + name);
        return {
          openCursor(range) {
            const req = tx.__track(makeRequest());
            // Live iteration like real IDB: each advance re-reads the store
            // so cursor.delete() + continue() lands on the row AFTER the
            // deleted one, and rows written mid-iteration are not skipped.
            const visited = new Set();
            const cursor = {
              value: null,
              key: null,
              delete() {
                const id = cursor.__id;
                if (id != null) store.rows.delete(id);
              },
              continue() {
                setImmediate(() => {
                  advance();
                  req.result = cursor.__id != null ? cursor : null;
                  req.__settle(null);
                });
              },
            };
            function advance() {
              cursor.__id = null;
              cursor.value = null;
              cursor.key = null;
              for (const [id, rec] of store.rows) {
                if (visited.has(id)) continue;
                const key = rec.value[keyPath];
                if (!range || range.test(key)) {
                  visited.add(id);
                  cursor.__id = id;
                  cursor.value = rec.value;
                  cursor.key = key;
                  break;
                }
              }
            }
            setImmediate(() => {
              advance();
              req.result = cursor.__id != null ? cursor : null;
              req.__settle(null);
            });
            return req;
          },
        };
      },
    };
  }

  target.indexedDB = indexedDB;
  target.IDBKeyRange = {
    only: (x) => new FakeRange('only', [x]),
    bound: (lo, hi, loOpen, hiOpen) => new FakeRange('bound', [lo, hi, !!loOpen, !!hiOpen]),
  };
}

module.exports = { install };
