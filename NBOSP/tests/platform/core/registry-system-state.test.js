// tests/platform/core/registry-system-state.test.js — registry-backed
// system state (the last machine-scoped config on raw localStorage).
//
// RegistrySystemState reads and writes HKNS/apps/* and
// HKNS/security/appPermissions through the engine, adopting the legacy
// localStorage values exactly once. The suite wires a memory-store
// registry + the shared localStorage stub from setup.js, then exercises
// every accessor, the adoption guard (never clobbers an existing hive
// value), and the fail-soft legacy fallback when no registry exists.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import RegistrySystemState from '../../../js/platform/core/registry-system-state.js';
import { resetTestStorage } from '../../setup.js';

function memStorage() {
  const map = new Map();
  return {
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function freshRegistry() {
  NovaRegistry._internal.resetState();
  NovaRegistry.init({ storage: memStorage(), events: null, logger: console });
  return NovaRegistry;
}

// Simulates the shell: RegistrySystemState finds the engine on window.
function withWindowRegistry(Reg) {
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = Reg;
  window.RegistrySystemState = RegistrySystemState;
}

beforeEach(() => {
  resetTestStorage();
  RegistrySystemState._internal.resetAdopted();
  withWindowRegistry(freshRegistry());
});

// The UMD modules assign window.* globals at import time and the suite
// re-assigns them per test — clear them so later suites sharing this
// vitest worker (isolate:false) never see a stale engine.
afterAll(() => {
  delete window.NovaRegistry;
  delete window.RegistrySystemState;
});

describe('registry system state (js/platform/core/registry-system-state.js)', () => {
  it('adopts legacy localStorage values into live registry paths exactly once', () => {
    localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.example.app', version: '1.0' }]));
    localStorage.setItem('nova_app_permissions', JSON.stringify([
      { appId: 'com.example.app', permission: 'notifications', granted: true, grantedAt: '2026-01-01T00:00:00.000Z' },
    ]));
    localStorage.setItem('nova_app_alarms', JSON.stringify({ version: 1, apps: { 'com.example.app': { alarms: {} } } }));
    localStorage.setItem('nova_store_update_interval_minutes', '30');

    expect(RegistrySystemState.installedApps()).toEqual([{ id: 'com.example.app', version: '1.0' }]);
    expect(NovaRegistry.get('HKNS/apps/installed')).toEqual([{ id: 'com.example.app', version: '1.0' }]);
    expect(RegistrySystemState.appPermissions()).toHaveLength(1);
    expect(NovaRegistry.get('HKNS/security/appPermissions')).toHaveLength(1);
    expect(RegistrySystemState.alarms()).toEqual({ version: 1, apps: { 'com.example.app': { alarms: {} } } });
    expect(RegistrySystemState.storeUpdateInterval()).toBe(30);
    expect(NovaRegistry.get('HKNS/apps/store/updateIntervalMinutes')).toBe(30);
    expect(NovaRegistry.stat('HKND/_migration/sysStateDone')).not.toBeNull();
  });

  it('never clobbers an existing hive value with a stale localStorage shadow', () => {
    NovaRegistry.set('HKNS/apps/installed', [{ id: 'com.example.fresh', version: '2.0' }], { source: 'test' });
    localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.example.stale' }]));

    RegistrySystemState._internal.resetAdopted();
    expect(RegistrySystemState.installedApps()).toEqual([{ id: 'com.example.fresh', version: '2.0' }]);
  });

  it('round-trips every domain through the hive', () => {
    expect(RegistrySystemState.setInstalledApps([{ id: 'com.a' }, { id: 'com.b' }])).toBe(true);
    expect(RegistrySystemState.installedApps()).toHaveLength(2);
    expect(NovaRegistry.get('HKNS/apps/installed')).toEqual([{ id: 'com.a' }, { id: 'com.b' }]);

    expect(RegistrySystemState.setAlarms({ version: 1, apps: { 'com.a': { alarms: { wake: {} } } } })).toBe(true);
    expect(RegistrySystemState.alarms().apps['com.a'].alarms.wake).toBeDefined();

    expect(RegistrySystemState.setPush({ version: 1, tokens: { t1: {} }, queue: {} })).toBe(true);
    expect(RegistrySystemState.push().tokens.t1).toBeDefined();

    expect(RegistrySystemState.setPushDeviceId('device-12345678')).toBe(true);
    expect(RegistrySystemState.pushDeviceId()).toBe('device-12345678');
    expect(NovaRegistry.get('HKNS/apps/pushDeviceId')).toBe('device-12345678');

    expect(RegistrySystemState.setStoreUpdateInterval(15)).toBe(true);
    expect(RegistrySystemState.storeUpdateInterval()).toBe(15);
  });

  it('rejects malformed writes instead of corrupting the hive', () => {
    expect(RegistrySystemState.setInstalledApps('nope')).toBe(false);
    expect(RegistrySystemState.setAlarms([1, 2])).toBe(false);
    expect(RegistrySystemState.setPush(null)).toBe(false);
    expect(RegistrySystemState.setPushDeviceId('')).toBe(false);
    expect(RegistrySystemState.setStoreUpdateInterval('60')).toBe(false);
    expect(RegistrySystemState.installedApps()).toEqual([]);
  });

  it('falls back to the legacy localStorage channel when no registry exists', () => {
    delete window.NovaRegistry;
    RegistrySystemState._internal.resetAdopted();

    localStorage.setItem('nova_installed_apps', JSON.stringify([{ id: 'com.legacy' }]));
    expect(RegistrySystemState.installedApps()).toEqual([{ id: 'com.legacy' }]);

    expect(RegistrySystemState.setInstalledApps([{ id: 'com.new' }])).toBe(false);
    expect(JSON.parse(localStorage.getItem('nova_installed_apps'))).toEqual([{ id: 'com.new' }]);

    expect(RegistrySystemState.setStoreUpdateInterval(60)).toBe(false);
    expect(localStorage.getItem('nova_store_update_interval_minutes')).toBe('60');

    expect(RegistrySystemState.setPushDeviceId('device-fallback1')).toBe(false);
    expect(localStorage.getItem('nova_push_device_id')).toBe('device-fallback1');
  });
});

describe('registry system state — machine inventories and service bookkeeping', () => {
  beforeEach(() => {
    resetTestStorage();
    RegistrySystemState._internal.resetAdopted();
    withWindowRegistry(freshRegistry());
  });

  it('adopts the inventory/bookkeeping legacy keys exactly once', () => {
    localStorage.setItem('nova_web_apps', JSON.stringify({ version: 2, apps: [{ id: 'web:example' }] }));
    localStorage.setItem('nova_registry_meta', JSON.stringify([{ id: 'com.nbosp.clock' }]));
    localStorage.setItem('nova_share_inbound', JSON.stringify({ version: 1, apps: { 'com.a': [] } }));
    localStorage.setItem('nova_store_update_notified', JSON.stringify({ 'com.a': '1.2.0' }));
    localStorage.setItem('nova_perm_last_sweep', '1700000000000');
    localStorage.setItem('nova_perms_bootstrapped', '1');

    expect(RegistrySystemState.webApps()).toEqual({ version: 2, apps: [{ id: 'web:example' }] });
    expect(NovaRegistry.get('HKNS/apps/webapps').apps).toHaveLength(1);
    expect(RegistrySystemState.builtinMeta()).toEqual([{ id: 'com.nbosp.clock' }]);
    expect(RegistrySystemState.shareInbound()).toEqual({ version: 1, apps: { 'com.a': [] } });
    expect(RegistrySystemState.storeNotified()).toEqual({ 'com.a': '1.2.0' });
    expect(RegistrySystemState.permLastSweep()).toBe(1700000000000);
    expect(RegistrySystemState.permsBootstrapped()).toBe(true);
    expect(NovaRegistry.stat('HKND/_migration/permsBootstrapped')).not.toBeNull();
  });

  it('round-trips every inventory through the hive', () => {
    expect(RegistrySystemState.setWebApps({ version: 3, apps: [{ id: 'web:x' }] })).toBe(true);
    expect(RegistrySystemState.webApps().version).toBe(3);

    expect(RegistrySystemState.setBuiltinMeta([{ id: 'com.nbosp.settings' }])).toBe(true);
    expect(RegistrySystemState.builtinMeta()).toHaveLength(1);

    expect(RegistrySystemState.setShareInbound({ version: 1, apps: { 'com.b': [{ title: 'hi' }] } })).toBe(true);
    expect(RegistrySystemState.shareInbound().apps['com.b']).toHaveLength(1);

    expect(RegistrySystemState.setStoreNotified({ 'com.b': '2.0.0' })).toBe(true);
    expect(RegistrySystemState.storeNotified()['com.b']).toBe('2.0.0');

    expect(RegistrySystemState.setPermLastSweep(1700000001000)).toBe(true);
    expect(RegistrySystemState.permLastSweep()).toBe(1700000001000);
    expect(NovaRegistry.get('HKNS/security/meta/lastSweep')).toBe(1700000001000);
  });

  it('marks the permission bootstrap once and stays marked', () => {
    expect(RegistrySystemState.permsBootstrapped()).toBe(false);
    expect(RegistrySystemState.markPermsBootstrapped()).toBe(true);
    // Registry marker AND legacy shadow both set.
    expect(NovaRegistry.stat('HKND/_migration/permsBootstrapped')).not.toBeNull();
    expect(localStorage.getItem('nova_perms_bootstrapped')).toBe('1');
    expect(RegistrySystemState.permsBootstrapped()).toBe(true);
  });

  it('rejects malformed inventory writes', () => {
    expect(RegistrySystemState.setWebApps([1])).toBe(false);
    expect(RegistrySystemState.setBuiltinMeta({ id: 'x' })).toBe(false);
    expect(RegistrySystemState.setShareInbound([])).toBe(false);
    expect(RegistrySystemState.setStoreNotified(null)).toBe(false);
    expect(RegistrySystemState.setPermLastSweep('1700000001000')).toBe(false);
    expect(RegistrySystemState.webApps()).toBeNull();
    expect(RegistrySystemState.builtinMeta()).toBeNull();
  });
});
