// tests/apps/downloads-history.test.js — service app: persistent download history.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

function makeChromeDownloadsStub() {
  const listeners = { determining: [], created: [], changed: [] };
  const api = {
    onDeterminingFilename: { addListener: (f) => listeners.determining.push(f) },
    onCreated: { addListener: (f) => listeners.created.push(f) },
    onChanged: { addListener: (f) => listeners.changed.push(f) },
  };
  return { api, listeners };
}

describe('Downloads service (js/apps/downloads-history)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen Downloads object to window with the documented surface', async () => {
    const { window } = await loadServiceApp('downloads-history');
    const svc = window.Downloads;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    for (const m of ['add', 'setStatus', 'getAll', 'remove', 'clearCompleted', 'subscribe']) {
      expect(typeof svc[m]).toBe('function');
    }
    expect(svc.getAll()).toEqual([]);
  });

  it('add() persists a normalized entry (newest first) and notifies listeners', async () => {
    const { window } = await loadServiceApp('downloads-history');
    const events = [];
    window.Downloads.subscribe((items, change) => events.push({ change, count: items.length }));

    const first = window.Downloads.add('report.pdf', 'https://x/y', 1024, 'application/pdf', 'downloading');
    const second = window.Downloads.add('', 'https://x/z', null, '');

    expect(first).toMatchObject({ name: 'report.pdf', size: 1024, mimeType: 'application/pdf', status: 'downloading' });
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThan(0);
    expect(second.name).toBe('Unknown file'); // falsy name -> fallback
    expect(second.size).toBe(0); // null size -> 0
    expect(second.mimeType).toBe('');
    expect(second.url).toBe('https://x/z');

    const all = window.Downloads.getAll();
    expect(all.map((e) => e.id)).toEqual([second.id, first.id]); // newest first
    expect(JSON.parse(window.localStorage.getItem('nova_downloads'))).toHaveLength(2);
    expect(events.map((e) => e.change)).toEqual(['add', 'add']);
    expect(events[1].count).toBe(2);
  });

  it('setStatus() updates size/status and remove()/clearCompleted() filter by id/status', async () => {
    const { window } = await loadServiceApp('downloads-history');
    const a = window.Downloads.add('a.zip', 'u', 10, '', 'downloading');
    const b = window.Downloads.add('b.zip', 'u', 20, '', 'downloading');

    expect(window.Downloads.setStatus(a.id, 'done', 999)).toBe(true);
    expect(window.Downloads.getAll().find((e) => e.id === a.id)).toMatchObject({ status: 'done', size: 999 });
    expect(window.Downloads.setStatus('missing-id', 'done')).toBe(false);

    expect(window.Downloads.remove(b.id)).toBe(true);
    expect(window.Downloads.remove(b.id)).toBe(false); // already gone
    expect(window.Downloads.getAll().map((e) => e.id)).toEqual([a.id]);

    // a is 'done' at this point — the sweep removes it too.
    expect(window.Downloads.clearCompleted()).toBe(true);
    expect(window.Downloads.getAll()).toEqual([]);
  });

  it('clearCompleted() keeps only in-flight downloads and is idempotent', async () => {
    const { window } = await loadServiceApp('downloads-history');
    const changes = [];
    window.Downloads.subscribe((items, change) => changes.push(change));
    const a = window.Downloads.add('done.bin', 'u', 1, '', 'done');
    const b = window.Downloads.add('active.bin', 'u', 1, '', 'downloading');

    expect(window.Downloads.clearCompleted()).toBe(true);
    expect(window.Downloads.getAll().map((e) => e.id)).toEqual([b.id]);
    expect(changes[changes.length - 1]).toBe('clear-completed');
    expect(window.Downloads.clearCompleted()).toBe(false); // second sweep: nothing to do
  });

  it('subscribe() validates its argument and returns a working unsubscribe', async () => {
    const { window } = await loadServiceApp('downloads-history');
    expect(() => window.Downloads.subscribe('not-a-function')).toThrow(/must be a function/);
    const seen = [];
    const unsub = window.Downloads.subscribe((items, change) => seen.push(change));
    window.Downloads.add('x', 'u', 1, '');
    unsub();
    window.Downloads.add('y', 'u', 1, '');
    expect(seen).toEqual(['add']); // no events after unsubscribe
  });

  it('persists through window.lsSave when the host provides it', async () => {
    const lsSaveCalls = [];
    const { window } = await loadServiceApp('downloads-history', {
      stubs: { extra: { lsSave: (key, value) => lsSaveCalls.push({ key, value }) } },
    });
    window.Downloads.add('via-lssave.bin', 'u', 1, '');
    expect(lsSaveCalls).toHaveLength(1);
    expect(lsSaveCalls[0].key).toBe('nova_downloads');
    expect(lsSaveCalls[0].value).toHaveLength(1);
    expect(window.localStorage.getItem('nova_downloads')).toBe(null); // localStorage path bypassed
  });

  it('survives malformed persisted history and the storage event', async () => {
    const { window } = await loadServiceApp('downloads-history');
    window.localStorage.setItem('nova_downloads', '{corrupt');
    expect(window.Downloads.getAll()).toEqual([]);
    window.localStorage.setItem('nova_downloads', '{"not":"an array"}');
    expect(window.Downloads.getAll()).toEqual([]);

    // storage event (same key or a clear) re-notifies listeners with fresh data
    const seen = [];
    window.Downloads.subscribe((items, change) => seen.push({ change, len: items.length }));
    window.localStorage.setItem('nova_downloads', JSON.stringify([{ id: 'ext', name: 'added elsewhere' }]));
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'nova_downloads' }));
    expect(seen).toEqual([{ change: 'storage', len: 1 }]);
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'unrelated_key' }));
    expect(seen).toHaveLength(1); // other keys are ignored
  });

  it('wires the native chrome.downloads bridge: suggests names, records progress, finalizes', async () => {
    const { api, listeners } = makeChromeDownloadsStub();
    const { window } = await loadServiceApp('downloads-history', {
      stubs: { extra: { chrome: { downloads: api } } },
    });
    expect(listeners.determining).toHaveLength(1);
    expect(listeners.created).toHaveLength(1);
    expect(listeners.changed).toHaveLength(1);

    let suggestion = null;
    listeners.determining[0]({ filename: 'C:\\Users\\nb\\reports\\Q4 Final Report.pdf' }, (s) => { suggestion = s; });
    expect(suggestion).toEqual({ filename: 'Q4 Final Report.pdf', conflictAction: 'uniquify' });

    listeners.created[0]({ id: 'native-1', filename: 'C:\\dl\\setup tool.zip', url: 'https://example.com/a', totalBytes: 4096, mime: 'application/zip', state: 'in_progress' });
    const entry = window.Downloads.getAll()[0];
    expect(entry).toMatchObject({ name: 'setup tool.zip', status: 'downloading', size: 4096, mimeType: 'application/zip' });

    listeners.changed[0]({ state: { current: 'complete' }, totalBytes: { current: 8192 } }, 'native-1');
    expect(window.Downloads.getAll()[0]).toMatchObject({ status: 'done', size: 8192 });

    // After completion the id mapping is dropped — late deltas are ignored.
    expect(() => listeners.changed[0]({ state: { current: 'complete' } }, 'native-1')).not.toThrow();
    expect(window.Downloads.getAll()[0].status).toBe('done');
  });

  it('derives the download name from the URL when the native item has no filename', async () => {
    const { api, listeners } = makeChromeDownloadsStub();
    const { window } = await loadServiceApp('downloads-history', {
      stubs: { extra: { chrome: { downloads: api } } },
    });
    listeners.created[0]({ id: 'n2', url: 'https://example.com/files/photo%20album.png', totalBytes: 0, state: 'complete' });
    expect(window.Downloads.getAll()[0]).toMatchObject({ name: 'photo album.png', status: 'done', size: 0 });
  });
});
