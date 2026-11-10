import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── workers.js — inline-blob web worker definitions + createWorker wrapper ──
// workers.js is a window-attach script (no module.exports): it publishes
// window.FS_WORKER_CODE / CRYPTO_WORKER_CODE / SEARCH_WORKER_CODE and
// window.createWorker. The worker payloads are plain JS strings, so each one
// is evaluated here against controlled globals:
//   • FS worker  → indexedDB.open() throws, exercising the source's built-in
//                  in-memory IDB fallback (exactly what a sandboxed VM hits)
//   • CRYPTO     → Node's real webcrypto, so digests/PBKDF2 are verified
//                  against node:crypto's own implementations
//   • SEARCH     → pure JS, exercised directly
// createWorker is exercised with a fake Worker global.

const WORKERS_PATH = '../../../js/core/services/workers.js';
const { webcrypto } = require('node:crypto');

// Evaluate a worker payload string and capture its postMessage output.
function runWorkerCode(code, sandbox = {}) {
  const posted = [];
  const fakeSelf = { postMessage: (msg) => posted.push(msg) };
  const paramNames = ['self', ...Object.keys(sandbox)];
  const fn = new Function(...paramNames, code);
  fn(fakeSelf, ...Object.values(sandbox));
  return { self: fakeSelf, posted };
}

// indexedDB stub whose open() throws — pushes the FS worker into its
// documented in-memory fallback DB path.
const blockedIndexedDB = {
  open: () => { throw new Error('SecurityError: IDB blocked in sandboxed VM context'); },
};

describe('workers.js (js/core/services/workers.js)', () => {
  beforeEach(() => {
    // Evict the CJS require cache so the window-attach IIFE re-runs cleanly.
    const resolved = require.resolve(WORKERS_PATH);
    if (require.cache && require.cache[resolved]) delete require.cache[resolved];
    require(WORKERS_PATH);
  });

  describe('surface', () => {
    it('exposes the three worker payloads and the createWorker factory on window', () => {
      expect(typeof window.FS_WORKER_CODE).toBe('string');
      expect(typeof window.CRYPTO_WORKER_CODE).toBe('string');
      expect(typeof window.SEARCH_WORKER_CODE).toBe('string');
      expect(typeof window.createWorker).toBe('function');
      expect(window.FS_WORKER_CODE).toContain('AstroOS_FS');
      expect(window.CRYPTO_WORKER_CODE).toContain('pbkdf2');
      expect(window.SEARCH_WORKER_CODE).toContain('buildIndex');
    });
  });

  describe('FS worker (in-memory IDB fallback)', () => {
    function fsWorker() {
      return runWorkerCode(window.FS_WORKER_CODE, { indexedDB: blockedIndexedDB });
    }

    it('init reports success and putSetting/getSetting round-trip a value', async () => {
      const w = fsWorker();
      await w.self.onmessage({ data: { id: 1, method: 'init', args: [] } });
      expect(w.posted.at(-1)).toEqual({ id: 1, result: true });

      await w.self.onmessage({ data: { id: 2, method: 'putSetting', args: ['theme', 'nova-dark'] } });
      expect(w.posted.at(-1)).toEqual({ id: 2, result: true });

      await w.self.onmessage({ data: { id: 3, method: 'getSetting', args: ['theme'] } });
      expect(w.posted.at(-1)).toEqual({ id: 3, result: 'nova-dark' });
    });

    it('getAllSettings returns the key/value map, missing keys come back undefined', async () => {
      const w = fsWorker();
      await w.self.onmessage({ data: { id: 1, method: 'putSetting', args: ['a', 1] } });
      await w.self.onmessage({ data: { id: 2, method: 'putSetting', args: ['b', 'two'] } });
      await w.self.onmessage({ data: { id: 3, method: 'getAllSettings', args: [] } });
      expect(w.posted.at(-1).result).toEqual({ a: 1, b: 'two' });

      await w.self.onmessage({ data: { id: 4, method: 'getSetting', args: ['missing'] } });
      expect(w.posted.at(-1).result).toBeUndefined();
    });

    it('putFiles/getAllFiles/deleteFile round-trip file records', async () => {
      const w = fsWorker();
      const files = [
        { id: 'f1', name: 'notes.txt', content: 'hello' },
        { id: 'f2', name: 'todo.md', content: '- ship it' },
      ];
      await w.self.onmessage({ data: { id: 1, method: 'putFiles', args: [files] } });
      expect(w.posted.at(-1).result).toBe(true);

      await w.self.onmessage({ data: { id: 2, method: 'getAllFiles', args: [] } });
      expect(w.posted.at(-1).result).toEqual(files);

      await w.self.onmessage({ data: { id: 3, method: 'deleteFile', args: ['f1'] } });
      expect(w.posted.at(-1).result).toBe(true);

      await w.self.onmessage({ data: { id: 4, method: 'getAllFiles', args: [] } });
      expect(w.posted.at(-1).result).toEqual([files[1]]);
    });

    it('answers unknown methods with an error payload instead of crashing', async () => {
      const w = fsWorker();
      await w.self.onmessage({ data: { id: 9, method: 'formatDisk', args: [] } });
      expect(w.posted.at(-1)).toEqual({ id: 9, error: 'Unknown method: formatDisk' });
    });
  });

  describe('SEARCH worker', () => {
    function searchWorker() {
      return runWorkerCode(window.SEARCH_WORKER_CODE);
    }

    const files = [
      { id: 'a', name: 'project doc', content: 'alpha gamma' },
      { id: 'b', name: 'other', content: 'alpha' },
      { id: 'c', name: 'zzz', content: 'nothing' },
    ];

    it('ranks files by number of matching terms and resolves them back to records', () => {
      const w = searchWorker();
      w.self.onmessage({ data: { id: 1, method: 'buildIndex', args: [files] } });
      expect(w.posted.at(-1).result).toBe(true);

      // 'a' matches both 'alpha' and 'gamma' in file a (score 2) but only
      // 'alpha' in file b (score 1) → a must come first.
      w.self.onmessage({ data: { id: 2, method: 'search', args: ['a', files] } });
      expect(w.posted.at(-1).result.map((f) => f.id)).toEqual(['a', 'b']);

      w.self.onmessage({ data: { id: 3, method: 'search', args: ['gamma', files] } });
      expect(w.posted.at(-1).result.map((f) => f.id)).toEqual(['a']);
    });

    it('matches case-insensitively and by substring, returns max 50 results', () => {
      const w = searchWorker();
      w.self.onmessage({ data: { id: 1, method: 'buildIndex', args: [files] } });

      w.self.onmessage({ data: { id: 2, method: 'search', args: ['ALPHA', files] } });
      expect(w.posted.at(-1).result.map((f) => f.id)).toEqual(['a', 'b']);

      w.self.onmessage({ data: { id: 3, method: 'search', args: ['lph', files] } });
      expect(w.posted.at(-1).result.length).toBe(2);

      const many = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, name: `bulk${i}`, content: 'hit' }));
      w.self.onmessage({ data: { id: 4, method: 'buildIndex', args: [many] } });
      w.self.onmessage({ data: { id: 5, method: 'search', args: ['hit', many] } });
      expect(w.posted.at(-1).result).toHaveLength(50);
    });

    it('returns [] for blank queries and no matches, and null for unknown methods', () => {
      const w = searchWorker();
      w.self.onmessage({ data: { id: 1, method: 'search', args: ['   ', files] } });
      expect(w.posted.at(-1).result).toEqual([]);

      w.self.onmessage({ data: { id: 2, method: 'search', args: ['zzzznotfound', files] } });
      expect(w.posted.at(-1).result).toEqual([]);

      w.self.onmessage({ data: { id: 3, method: 'explode', args: [] } });
      expect(w.posted.at(-1)).toEqual({ id: 3, result: null });
    });
  });

  describe('CRYPTO worker (real webcrypto)', () => {
    function cryptoWorker() {
      return runWorkerCode(window.CRYPTO_WORKER_CODE, { crypto: webcrypto });
    }

    it('sha256 produces the same digest as node:crypto', async () => {
      const w = cryptoWorker();
      await w.self.onmessage({ data: { id: 1, method: 'sha256', args: ['nova-bytes'] } });
      const expected = require('node:crypto').createHash('sha256').update('nova-bytes').digest('hex');
      expect(w.posted.at(-1).result).toBe(expected);
    });

    it('pbkdf2 matches node:crypto with the source\'s 100000 iterations / SHA-256 / 256-bit params', async () => {
      const w = cryptoWorker();
      await w.self.onmessage({ data: { id: 1, method: 'pbkdf2', args: ['1234', 'salt-from-kernel'] } });
      const expected = require('node:crypto').pbkdf2Sync('1234', 'salt-from-kernel', 100000, 32, 'sha256').toString('hex');
      expect(w.posted.at(-1).result).toBe(expected);
    }, 20000);

    it('returns null for unknown methods', async () => {
      const w = cryptoWorker();
      await w.self.onmessage({ data: { id: 1, method: 'rot13', args: ['x'] } });
      expect(w.posted.at(-1)).toEqual({ id: 1, result: null });
    });
  });

  describe('createWorker', () => {
    class FakeWorker {
      constructor(url) {
        this.url = url;
        this.terminated = false;
        this.sent = [];
        FakeWorker.instances.push(this);
      }
      postMessage(msg) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    FakeWorker.instances = [];

    afterEach(() => {
      delete globalThis.Worker;
      delete globalThis.EventLog;
    });

    it('resolves call() with the worker\'s reply and tags messages with incrementing ids', async () => {
      vi.stubGlobal('Worker', FakeWorker);
      FakeWorker.instances = [];
      const worker = window.createWorker('code', 'fs');

      const p1 = worker.call('putSetting', 'theme', 'dark');
      const p2 = worker.call('getSetting', 'theme');
      expect(FakeWorker.instances).toHaveLength(1);
      expect(FakeWorker.instances[0].sent[0]).toEqual({ id: 1, method: 'putSetting', args: ['theme', 'dark'] });
      expect(FakeWorker.instances[0].sent[1]).toEqual({ id: 2, method: 'getSetting', args: ['theme'] });

      FakeWorker.instances[0].onmessage({ data: { id: 2, result: 'dark' } });
      FakeWorker.instances[0].onmessage({ data: { id: 1, result: true } });
      await expect(p2).resolves.toBe('dark');
      await expect(p1).resolves.toBe(true);
    });

    it('rejects call() with an Error when the worker replies with an error payload, and logs it', async () => {
      vi.stubGlobal('Worker', FakeWorker);
      FakeWorker.instances = [];
      const eventLog = { log: vi.fn() };
      globalThis.EventLog = eventLog;
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const worker = window.createWorker('code', 'crypto');
      const p = worker.call('pbkdf2', '1234');
      FakeWorker.instances[0].onmessage({ data: { id: 1, error: 'digest failed' } });

      await expect(p).rejects.toThrow('digest failed');
      expect(eventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        app: 'Workers',
        severity: 'error',
        message: 'crypto.pbkdf2 failed: digest failed',
      }));
      expect(consoleErr).not.toHaveBeenCalled(); // replies-with-error is not an onerror
    });

    it('routes uncaught worker onerror to console.error and EventLog without throwing', () => {
      vi.stubGlobal('Worker', FakeWorker);
      FakeWorker.instances = [];
      const eventLog = { log: vi.fn() };
      globalThis.EventLog = eventLog;
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

      const worker = window.createWorker('code', 'search');
      expect(() => FakeWorker.instances[0].onerror({ message: 'boom in worker' })).not.toThrow();
      expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining('search worker'), 'boom in worker');
      expect(eventLog.log).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error', data: { worker: 'search' } }));
    });

    it('terminate() tears the worker down and logs the lifecycle event', () => {
      vi.stubGlobal('Worker', FakeWorker);
      FakeWorker.instances = [];
      const eventLog = { log: vi.fn() };
      globalThis.EventLog = eventLog;

      const worker = window.createWorker('code', 'fs');
      worker.terminate();
      expect(FakeWorker.instances[0].terminated).toBe(true);
      expect(eventLog.log).toHaveBeenCalledWith(expect.objectContaining({
        severity: 'info',
        message: 'Terminated fs worker',
      }));
    });
  });
});
