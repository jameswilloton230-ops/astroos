import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import AppSandbox from '../../../js/platform/security/app-sandbox.js';

/* ---------------------------------------------------------------------------
   In-memory IndexedDB stub covering exactly the surface the app-sandbox
   storage layer uses (open + kv store keyed [appId,key] + by_appId cursor).
   Cursor chains and transaction completion are microtask-scheduled, and
   transactions only fire oncomplete once every outstanding operation has
   settled — storageClear's cursor.delete()/continue() loop depends on that.
--------------------------------------------------------------------------- */
function installIdbStub() {
  const state = { stores: {} }; // name -> { rows: Map } (rows keyed [appId,key])
  const kkey = (k) => JSON.stringify(k);

  function makeTx() {
    const ops = { pending: 0, scheduled: false };
    const tx = {
      objectStore: (n) => makeStore(n, ops),
      set oncomplete(cb) { ops.complete = cb; },
      set onerror(cb) { ops.fail = cb; },
    };
    ops.settle = () => {
      if (ops.pending > 0 || ops.scheduled) return;
      ops.scheduled = true;
      queueMicrotask(() => { if (ops.pending <= 0) ops.complete?.({ target: tx }); });
    };
    return tx;
  }

  function makeStore(name, ops) {
    const store = () => (state.stores[name] ??= { rows: new Map() });
    /* Single-shot request: runs, dispatches, and settles the transaction. */
    function simple(run) {
      ops.pending++;
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try { run(req); req.onsuccess?.({ target: req }); }
        catch (e) { req.error = e; req.onerror?.({ target: req }); }
        finally { ops.pending--; ops.settle(); }
      });
      return req;
    }
    return {
      get(key) {
        return simple((r) => {
          const row = store().rows.get(kkey(key));
          r.result = row ? { ...row } : undefined;
        });
      },
      put(row) {
        // v2 schema: rows keyed [ownerUid, appId, key] — ownerUid is stamped
        // by the host at the enforcement point (multi-user scoping).
        return simple(() => { store().rows.set(kkey([row.ownerUid ?? '', row.appId, row.key]), { ...row }); });
      },
      delete(key) {
        return simple(() => { store().rows.delete(kkey(key)); });
      },
      index() {
        return {
          /* Cursor chain: one delivery per row, then a null delivery which
             is what finally settles the transaction. */
          openCursor(range) {
            ops.pending++;
            const req = { result: undefined, error: null, onsuccess: null, onerror: null };
            /* Real IDB cursors iterate a snapshot of the range — deletes of
               already-visited rows must not shift the remaining sequence. */
            /* v2: by_owner_app index — ranges carry [ownerUid, appId]. */
            const pair = Array.isArray(range.__only) ? range.__only : null;
            const all = [...store().rows.values()].filter((row) =>
              pair ? (row.ownerUid ?? '') === pair[0] && row.appId === pair[1]
                   : row.appId === range.__only);
            let i = 0;
            const deliver = () => {
              if (i < all.length) {
                const row = all[i];
                req.result = {
                  value: { ...row },
                  delete: () => { state.stores[name].rows.delete(kkey([row.ownerUid ?? '', row.appId, row.key])); },
                  continue: () => { i++; queueMicrotask(deliver); },
                };
                try { req.onsuccess?.({ target: req }); }
                catch (e) { req.onerror?.({ target: req }); }
              } else {
                req.result = null;
                try { req.onsuccess?.({ target: req }); }
                catch (e) { req.onerror?.({ target: req }); }
                ops.pending--; ops.settle();
              }
            };
            queueMicrotask(deliver);
            return req;
          },
        };
      },
    };
  }

  const db = {
    stores: state.stores,
    createObjectStore(name) { state.stores[name] ??= { rows: new Map() }; return { createIndex() {} }; },
    objectStoreNames: { contains: () => true },
    transaction: () => makeTx(),
  };

  vi.stubGlobal('indexedDB', {
    open() {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => { req.result = db; req.onsuccess?.({ target: req }); });
      return req;
    },
  });
  vi.stubGlobal('IDBKeyRange', { only: (v) => ({ __only: v }) });
  return state;
}

/* Real digest behind the setup.js subtle stub so the WebCrypto checksum
   fallback path is exercised end to end. */
crypto.subtle.digest = async (_alg, bytes) => {
  const buf = createHash('sha256').update(Buffer.from(bytes)).digest();
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

function makeCall() {
  const responses = [];
  const webview = { __directResponder: (m) => responses.push(m) };
  async function call(channel, payload, appId = 'com.test.data', granted = true) {
    await AppSandbox._internal.handleAPICall(
      channel,
      payload,
      `req-${channel}-${Math.random()}`,
      { id: appId },
      webview,
      {}
    );
    return responses.shift();
  }
  return { call, responses };
}

describe('data portability — data:export / data:backup (the once-intended, now-real permissions)', () => {
  const idb = installIdbStub();
  const permStub = { isGranted: () => true };
  vi.stubGlobal('AppPermissionManager', permStub);
  beforeEach(() => {
    for (const store of Object.values(idb.stores)) store.rows.clear();
    permStub.isGranted = () => true;
  });

  it('MAC-gates all four channels', async () => {
    permStub.isGranted = () => false;
    const { call } = makeCall();
    for (const channel of ['nova:data:export', 'nova:data:import', 'nova:data:backup', 'nova:data:restore']) {
      const res = await call(channel, {});
      expect(res.error?.code).toBe('PERMISSION_DENIED');
    }
  });

  it('backup snapshots the app namespace into a checksummed envelope', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'recipes.one', value: { title: 'Pancakes' } });
    await call('nova:storage:set', { key: 'recipes.two', value: 'batter' });
    const res = await call('nova:data:backup', {});
    expect(res.result?.success).toBe(true);
    const env = res.result.envelope;
    expect(env.novaDataEnvelope).toBe(1);
    expect(env.format).toBe(1);
    expect(env.kind).toBe('backup');
    expect(env.appId).toBe('com.test.data');
    expect(env.storage).toEqual({ 'recipes.one': { title: 'Pancakes' }, 'recipes.two': 'batter' });
    expect(env.counts).toEqual({ keys: 2, bytes: expect.any(Number) });
    expect(env.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('restore round-trips a backup, and clearFirst wipes keys added after the backup', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'a', value: '1' });
    const { result: backup } = await call('nova:data:backup', {});
    await call('nova:storage:set', { key: 'b', value: 'extra' });
    const res = await call('nova:data:restore', { envelope: backup.envelope, clearFirst: true });
    expect(res.result).toMatchObject({ success: true, restoredKeys: 1, cleared: true, failedKeys: [] });
    const keysRes = await call('nova:storage:keys', {});
    expect(keysRes.result.keys).toEqual(['a']);
    const getRes = await call('nova:storage:get', { key: 'a' });
    expect(getRes.result.value).toBe('1');
  });

  it('refuses to restore another app\u2019s envelope (POLICY_BLOCKED, not a data channel)', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'a', value: '1' }, 'com.other.app');
    const { result: foreign } = await call('nova:data:backup', {}, 'com.other.app');
    const res = await call('nova:data:restore', { envelope: foreign.envelope }, 'com.test.data');
    expect(res.error?.code).toBe('POLICY_BLOCKED');
  });

  it('rejects a tampered envelope via checksum before writing anything', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'a', value: '1' });
    const { result: backup } = await call('nova:data:backup', {});
    const tampered = { ...backup.envelope, storage: { a: 'evil' } };
    const res = await call('nova:data:restore', { envelope: tampered });
    expect(res.error?.code).toBe('INVALID_ARGS');
    expect(res.error.message).toMatch(/checksum/);
    const getRes = await call('nova:storage:get', { key: 'a' });
    expect(getRes.result.value).toBe('1');
  });

  it('rejects kind mismatches and malformed envelopes', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'a', value: '1' });
    const { result: exported } = await call('nova:data:export', { keys: ['a'] });
    const res = await call('nova:data:restore', { envelope: exported.envelope });
    expect(res.error?.code).toBe('INVALID_ARGS');
    const bad = await call('nova:data:restore', { envelope: { hello: true } });
    expect(bad.error?.code).toBe('INVALID_ARGS');
  });

  it('exports by key list and by prefix, and requires a selector', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'recipes.one', value: 'x' });
    await call('nova:storage:set', { key: 'recipes.two', value: 'y' });
    await call('nova:storage:set', { key: 'other', value: 'z' });
    const byPrefix = await call('nova:data:export', { prefix: 'recipes.' });
    expect(byPrefix.result.envelope.storage).toEqual({ 'recipes.one': 'x', 'recipes.two': 'y' });
    expect(byPrefix.result.envelope.kind).toBe('export');
    const byKeys = await call('nova:data:export', { keys: ['other', 'absent'] });
    expect(byKeys.result.envelope.storage).toEqual({ other: 'z' });
    const none = await call('nova:data:export', {});
    expect(none.error?.code).toBe('INVALID_ARGS');
  });

  it('import merges over the live namespace and never deletes', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'recipes.one', value: 'old' });
    await call('nova:storage:set', { key: 'keep.me', value: 'yes' });
    const { result: exported } = await call('nova:data:export', { keys: ['recipes.one'] });
    await call('nova:storage:set', { key: 'recipes.one', value: 'updated-live' });
    const res = await call('nova:data:import', { envelope: exported.envelope });
    expect(res.result).toMatchObject({ success: true, importedKeys: 1, failedKeys: [] });
    const one = await call('nova:storage:get', { key: 'recipes.one' });
    expect(one.result.value).toBe('old'); // envelope won the merge
    const kept = await call('nova:storage:get', { key: 'keep.me' });
    expect(kept.result.value).toBe('yes'); // untouched
  });

  it('reports over-cap values per-key instead of failing the whole call', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'fine', value: 'ok' });
    /* An over-cap value can never enter an envelope through nova:storage:set
       (the per-value cap AND the per-app quota both reject it there), so
       craft a checksummed envelope by hand to exercise the restore-side
       per-key failure path. */
    const huge = 'x'.repeat(5 * 1024 * 1024 + 1);
    const storage = { fine: 'ok', huge };
    const canonical = JSON.stringify(Object.keys(storage).sort().map((k) => [k, storage[k]]));
    const checksum = createHash('sha256').update(canonical).digest('hex');
    const envelope = {
      novaDataEnvelope: 1, format: 1, kind: 'backup', appId: 'com.test.data',
      capturedAt: new Date().toISOString(), storage, counts: { keys: 2, bytes: 0 }, checksum,
    };
    const res = await call('nova:data:restore', { envelope, clearFirst: true });
    expect(res.result.success).toBe(true);
    expect(res.result.restoredKeys).toBe(1);
    expect(res.result.failedKeys).toEqual([{ key: 'huge', reason: expect.stringMatching(/byte limit/) }]);
    const fine = await call('nova:storage:get', { key: 'fine' });
    expect(fine.result.value).toBe('ok');
  });

  it('isolates namespaces — one app never sees another\u2019s keys in backups', async () => {
    const { call } = makeCall();
    await call('nova:storage:set', { key: 'mine', value: 'own' }, 'com.app.one');
    await call('nova:storage:set', { key: 'theirs', value: 'secret' }, 'com.app.two');
    const { result: backup } = await call('nova:data:backup', {}, 'com.app.one');
    expect(backup.envelope.storage).toEqual({ mine: 'own' });
    expect(backup.envelope.storage.theirs).toBeUndefined();
  });
});
