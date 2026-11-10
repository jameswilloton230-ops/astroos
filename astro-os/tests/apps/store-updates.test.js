// tests/apps/store-updates.test.js — service app: catalog update checker.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadServiceApp, settle } from '../helpers/app-harness.js';

const CATALOG_URL = 'https://novabyteteam.github.io/novabyte-os/apps.json';

function fetchServing(catalog, calls = []) {
  return (url) => {
    calls.push(url);
    if (catalog === null) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(catalog) });
  };
}

describe('StoreUpdateService service (js/apps/store-updates)', () => {
  beforeEach(() => resetTestStorage());

  it('attaches a frozen StoreUpdateService (no auto-start without Boot)', async () => {
    const calls = [];
    const { window } = await loadServiceApp('store-updates', { stubs: { fetch: fetchServing([], calls) } });
    const svc = window.StoreUpdateService;
    expect(svc).toBeTruthy();
    expect(Object.isFrozen(svc)).toBe(true);
    for (const m of ['start', 'checkNow', 'getIntervalMinutes', 'setIntervalMinutes']) expect(typeof svc[m]).toBe('function');
    await settle();
    expect(calls).toEqual([]); // Boot absent -> the Boot.hooks.after registration is skipped
  });

  it('interval settings: default 60, allowlist enforced, persisted + change event dispatched', async () => {
    const { window } = await loadServiceApp('store-updates');
    const svc = window.StoreUpdateService;
    expect(svc.getIntervalMinutes()).toBe(60);

    const events = [];
    window.addEventListener('nova-store-update-settings-changed', () => events.push('changed'));
    expect(svc.setIntervalMinutes(15)).toBe(15);
    expect(window.localStorage.getItem('nova_store_update_interval_minutes')).toBe('15');
    expect(events).toEqual(['changed']);
    expect(svc.getIntervalMinutes()).toBe(15);

    expect(() => svc.setIntervalMinutes(45)).toThrow(/available minute values/); // cross-realm RangeError

    window.localStorage.setItem('nova_store_update_interval_minutes', '77'); // corrupt -> default
    expect(svc.getIntervalMinutes()).toBe(60);
    window.localStorage.setItem('nova_store_update_interval_minutes', '0'); // 0 = disabled, allowed
    expect(svc.getIntervalMinutes()).toBe(0);
  });

  it('checkNow() detects newer catalog versions and notifies once per version', async () => {
    const calls = [];
    const notifyCalls = [];
    const { window } = await loadServiceApp('store-updates', {
      stubs: {
        fetch: fetchServing([
          { id: 'com.a', name: 'Alpha', version: '1.2.0', releaseNotes: 'Bug fixes' },
          { id: 'com.b', name: 'Beta', version: '1.9.0' }, // older than installed
          { id: 'com.sys', name: 'SystemApp', version: '9.9.9' },
          { id: 'com.c', name: 'Gamma', version: 'not-a-version' },
        ], calls),
        extra: { Notify: { show: (o) => notifyCalls.push(o) } },
      },
    });
    window.localStorage.setItem('nova_installed_apps', JSON.stringify([
      { id: 'com.a', version: '1.0.0' },
      { id: 'com.b', version: '2.0.0' },
      { id: 'com.sys', version: '1.0.0', system: true },
      { id: 'com.c', version: '1.0.0' },
    ]));

    const updates = await window.StoreUpdateService.checkNow();
    expect(calls).toEqual([CATALOG_URL]);
    expect(updates).toEqual([{ id: 'com.a', name: 'Alpha', installedVersion: '1.0.0', version: '1.2.0', releaseNotes: 'Bug fixes' }]);
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toMatchObject({
      title: 'Alpha needs updating',
      appId: 'com.astroos.store',
      appName: 'Store',
      action: 'open-store',
      actionLabel: 'Open store',
    });
    expect(notifyCalls[0].body).toContain('Version 1.2.0 is available (installed: 1.0.0)');
    expect(notifyCalls[0].body).toContain('What’s new in v1.2.0:\nBug fixes');
    expect(JSON.parse(window.localStorage.getItem('nova_store_update_notified'))).toEqual({ 'com.a': '1.2.0' });

    // Second run: still reports the update, but does not re-notify.
    const again = await window.StoreUpdateService.checkNow();
    expect(again.map((u) => u.id)).toEqual(['com.a']);
    expect(notifyCalls).toHaveLength(1);
  });

  it('falls back to versionHistory notes and honors semver prerelease ordering', async () => {
    const notifyCalls = [];
    const { window } = await loadServiceApp('store-updates', {
      stubs: {
        fetch: fetchServing([
          { id: 'com.h', name: 'HistoryApp', version: '2.0.0', versionHistory: [{ version: '1.0.0', notes: 'old' }, { version: '2.0.0', notes: 'Fresh notes' }] },
          { id: 'com.p', name: 'PreApp', version: '1.2.3-rc.1' },
        ]),
        extra: { Notify: { show: (o) => notifyCalls.push(o) } },
      },
    });
    window.localStorage.setItem('nova_installed_apps', JSON.stringify([
      { id: 'com.h', version: '1.0.0' },
      { id: 'com.p', version: '1.2.3' }, // 1.2.3-rc.1 < 1.2.3 release
    ]));
    const updates = await window.StoreUpdateService.checkNow();
    expect(updates.find((u) => u.id === 'com.h').releaseNotes).toBe('Fresh notes');
    expect(updates.find((u) => u.id === 'com.p')).toBeUndefined(); // prerelease is not an upgrade
  });

  it('skips notifications entirely when Notify is unavailable (retried later)', async () => {
    const { window } = await loadServiceApp('store-updates', {
      stubs: { fetch: fetchServing([{ id: 'com.a', name: 'Alpha', version: '2.0.0' }]) },
    });
    window.localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.a', version: '1.0.0' }]));
    const updates = await window.StoreUpdateService.checkNow();
    expect(updates).toHaveLength(1); // still reported...
    expect(window.localStorage.getItem('nova_store_update_notified')).toBe(null); // ...but not marked as notified
  });

  it('checkNow() rejects on HTTP failure and non-list catalogs, and dedupes concurrent calls', async () => {
    const calls3 = [];
    const { window } = await loadServiceApp('store-updates', { stubs: { fetch: fetchServing(null) } });
    await expect(window.StoreUpdateService.checkNow()).rejects.toThrow(/App catalog request failed \(404\)/);

    const { window: w2 } = await loadServiceApp('store-updates', {
      stubs: { fetch: fetchServing({ not: 'a list' }) },
    });
    await expect(w2.StoreUpdateService.checkNow()).rejects.toThrow(/App catalog must contain a list/);

    const { window: w3 } = await loadServiceApp('store-updates', {
      stubs: { fetch: fetchServing([], calls3) },
    });
    const p1 = w3.StoreUpdateService.checkNow();
    const p2 = w3.StoreUpdateService.checkNow();
    await Promise.all([p1, p2]);
    expect(calls3).toEqual([CATALOG_URL]); // second call joined the in-flight check: one fetch
  });

  it('start() runs one immediate check, schedules nothing when the interval is 0, and is idempotent', async () => {
    const calls = [];
    const { window } = await loadServiceApp('store-updates', { stubs: { fetch: fetchServing([], calls) } });
    window.localStorage.setItem('nova_store_update_interval_minutes', '0'); // disabled -> no repeat timer
    window.StoreUpdateService.start();
    await settle();
    expect(calls).toEqual([CATALOG_URL]);
    window.StoreUpdateService.start(); // idempotent
    window.StoreUpdateService.start();
    await settle();
    expect(calls).toEqual([CATALOG_URL]);
  });
});
