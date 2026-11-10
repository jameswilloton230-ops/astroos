// tests/apps/network-activity-log.test.js — service app: in-memory ring buffer.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp } from '../helpers/app-harness.js';

describe('NetworkLog service (js/apps/network-activity-log)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches NetworkLog to window with the documented surface', async () => {
    const { window } = await loadServiceApp('network-activity-log');
    const svc = window.NetworkLog;
    expect(svc).toBeTruthy();
    // Source assigns a plain object literal (window.NetworkLog || {...}) — no freeze.
    expect(Object.isFrozen(svc)).toBe(false);
    expect(typeof svc.push).toBe('function');
    expect(typeof svc.getAll).toBe('function');
    expect(typeof svc.clear).toBe('function');
    expect(svc.MAX_ENTRIES).toBe(500);
    expect(Array.isArray(svc.entries)).toBe(true);
    expect(svc.entries.length).toBe(0);
  });

  it('push() prepends (newest first), calls the render hook, getAll() exposes the live list', async () => {
    const { window } = await loadServiceApp('network-activity-log');
    const svc = window.NetworkLog;
    const renderSizes = [];
    svc._renderFn = () => renderSizes.push(svc.entries.length);

    svc.push({ url: '/first', status: 200 });
    svc.push({ url: '/second', status: 404 });

    expect(renderSizes).toEqual([1, 2]);
    const all = svc.getAll();
    expect(all[0].url).toBe('/second');
    expect(all[1].url).toBe('/first');
    // getAll() hands back the live backing array, not a copy.
    expect(all).toBe(svc.entries);
  });

  it('truncates the buffer at MAX_ENTRIES, keeping the newest entries', async () => {
    const { window } = await loadServiceApp('network-activity-log');
    const svc = window.NetworkLog;
    for (let i = 0; i < 505; i++) svc.push({ i });
    expect(svc.entries.length).toBe(500);
    expect(svc.entries[0].i).toBe(504); // newest survives at the head
    expect(svc.entries[499].i).toBe(5); // oldest tail = entry #5 (0-4 evicted)
    expect(svc.entries[499].i).not.toBe(4);
  });

  it('clear() empties the log and still triggers the render hook', async () => {
    const { window } = await loadServiceApp('network-activity-log');
    const svc = window.NetworkLog;
    svc.push({ a: 1 });
    svc.push({ b: 2 });
    let renders = 0;
    svc._renderFn = () => renders++;
    svc.clear();
    expect(svc.entries.length).toBe(0);
    expect(svc.getAll()).toEqual([]);
    expect(renders).toBe(1);
  });

  it('keeps a pre-existing window.NetworkLog instead of replacing it', async () => {
    // Source guard: window.NetworkLog = window.NetworkLog || {...}
    const kept = { entries: [{ kept: true }], push() {}, getAll() { return this.entries; }, clear() {} };
    const { window } = await loadServiceApp('network-activity-log', {
      stubs: { extra: { NetworkLog: kept } },
    });
    expect(window.NetworkLog).toBe(kept);
    expect(window.NetworkLog.getAll()[0].kept).toBe(true);
  });
});
