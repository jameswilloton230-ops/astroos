// tests/platform/core/registry-prefs.test.js — registry-backed platform
// prefs (the old nova_* localStorage keys).
//
// RegistryPrefs reads and writes HKNU/apps/*, HKNU/shell/* and
// HKND/overlay/position through the engine, adopting the legacy localStorage
// values exactly once. The suite wires a memory-store registry + the shared
// localStorage stub from setup.js, then exercises every accessor, the
// adoption guard, and the fail-soft legacy fallback when no registry exists.
import { describe, it, expect, beforeEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import RegistryPrefs from '../../../js/platform/core/registry-prefs.js';
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

// Simulates the shell: RegistryPrefs finds the engine on window.
function withWindowRegistry(Reg) {
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = Reg;
}

beforeEach(() => {
  resetTestStorage();
  RegistryPrefs._internal.resetAdopted();
  withWindowRegistry(freshRegistry());
});

describe('registry prefs (js/platform/core/registry-prefs.js)', () => {
  it('adopts legacy localStorage values into live registry paths exactly once', () => {
    localStorage.setItem('nova_disabled_apps', JSON.stringify(['com.astroos.files']));
    localStorage.setItem('nova_boot_apps', JSON.stringify(['com.astroos.clock']));
    localStorage.setItem('nova_show_hidden_apps', '1');
    localStorage.setItem('novabyte-shortcuts', JSON.stringify({ 'toggle-launchpad': 'Ctrl+Space' }));
    localStorage.setItem('novaOS_notifPendingActions', JSON.stringify([{ appId: 'com.a', actionId: 'open' }]));

    expect(RegistryPrefs.disabledApps()).toEqual(['com.astroos.files']);
    expect(NovaRegistry.get('HKNU/apps/disabled')).toEqual(['com.astroos.files']);
    expect(NovaRegistry.get('HKNU/apps/boot')).toEqual(['com.astroos.clock']);
    expect(RegistryPrefs.showHiddenApps()).toBe(true);
    expect(NovaRegistry.get('HKNU/apps/showHidden')).toBe(true);
    expect(RegistryPrefs.shortcuts()).toEqual({ 'toggle-launchpad': 'Ctrl+Space' });
    expect(RegistryPrefs.notifPendingActions()).toEqual([{ appId: 'com.a', actionId: 'open' }]);
    expect(NovaRegistry.get('HKNU/shell/notifications/pendingActions')).toEqual([{ appId: 'com.a', actionId: 'open' }]);
    expect(NovaRegistry.stat('HKND/_migration/prefsDone')).not.toBeNull();

    // The guard holds: legacy edits after adoption never leak back in.
    localStorage.setItem('nova_disabled_apps', JSON.stringify(['com.astroos.browser']));
    expect(RegistryPrefs.disabledApps()).toEqual(['com.astroos.files']);
  });

  it('round-trips every accessor through its registry path', () => {
    RegistryPrefs.setDisabledApps(['com.astroos.files', { id: 'com.third.party' }]);
    expect(RegistryPrefs.disabledApps()).toEqual(['com.astroos.files', 'com.third.party']);
    expect(RegistryPrefs.isAppDisabled('com.third.party')).toBe(true);
    expect(RegistryPrefs.isAppDisabled('com.astroos.browser')).toBe(false);

    RegistryPrefs.setBootApps(['com.astroos.clock']);
    expect(RegistryPrefs.bootApps()).toEqual(['com.astroos.clock']);

    RegistryPrefs.setShowHiddenApps(true);
    expect(RegistryPrefs.showHiddenApps()).toBe(true);
    RegistryPrefs.setShowHiddenApps(false);
    expect(RegistryPrefs.showHiddenApps()).toBe(false);

    RegistryPrefs.setShortcuts({ 'screenshot': 'PrintScreen' });
    expect(RegistryPrefs.shortcuts()).toEqual({ 'screenshot': 'PrintScreen' });

    RegistryPrefs.setNotifChannels({ 'com.app': { messages: { id: 'messages', importance: 'high' } } });
    expect(RegistryPrefs.notifChannels()['com.app'].messages.importance).toBe('high');

    RegistryPrefs.setNotifChannelOverrides({ 'com.app|messages': { enabled: false } });
    expect(RegistryPrefs.notifChannelOverrides()['com.app|messages']).toEqual({ enabled: false });

    RegistryPrefs.setNotifPendingActions([{ appId: 'com.app', actionId: 'reply' }]);
    expect(RegistryPrefs.notifPendingActions()).toEqual([{ appId: 'com.app', actionId: 'reply' }]);
    expect(NovaRegistry.get('HKNU/shell/notifications/pendingActions')).toEqual([{ appId: 'com.app', actionId: 'reply' }]);

    expect(RegistryPrefs.setOverlayPosition(120, 80)).toBe(true);
    expect(RegistryPrefs.overlayPosition()).toEqual({ x: 120, y: 80 });
    expect(NovaRegistry.get('HKND/overlay/position')).toEqual({ x: 120, y: 80 });
  });

  it('keeps { id, reason, ts } diagnostics entries written by init.js intact', () => {
    RegistryPrefs.setDisabledApps([{ id: 'com.astroos.devconsole', reason: 'broken: js/apps/console.js', ts: 123 }]);
    // Reads normalize to ids for launch gating…
    expect(RegistryPrefs.disabledApps()).toEqual(['com.astroos.devconsole']);
    // …but the stored entries keep their diagnostics shape.
    expect(NovaRegistry.get('HKNU/apps/disabled')[0].reason).toBe('broken: js/apps/console.js');
  });

  it('falls back to the legacy localStorage channel when no registry exists', () => {
    withWindowRegistry(null); // engine unavailable (pre-boot, corrupted install…)

    RegistryPrefs.setDisabledApps(['com.astroos.files']);
    expect(JSON.parse(localStorage.getItem('nova_disabled_apps'))).toEqual(['com.astroos.files']);
    expect(RegistryPrefs.disabledApps()).toEqual(['com.astroos.files']);

    RegistryPrefs.setBootApps(['com.astroos.clock']);
    expect(RegistryPrefs.bootApps()).toEqual(['com.astroos.clock']);

    RegistryPrefs.setShowHiddenApps(true);
    expect(RegistryPrefs.showHiddenApps()).toBe(true);

    RegistryPrefs.setShortcuts({ a: 'F1' });
    expect(RegistryPrefs.shortcuts()).toEqual({ a: 'F1' });

    RegistryPrefs.setNotifPendingActions([{ appId: 'com.app', actionId: 'open' }]);
    expect(RegistryPrefs.notifPendingActions()).toEqual([{ appId: 'com.app', actionId: 'open' }]);
    expect(JSON.parse(localStorage.getItem('novaOS_notifPendingActions'))).toEqual([{ appId: 'com.app', actionId: 'open' }]);

    // Legacy '1'/'0' encoding and the old nova_show_system_apps default.
    expect(RegistryPrefs.overlayPosition()).toBeNull();
    RegistryPrefs.setOverlayPosition(5, 6);
    expect(RegistryPrefs.overlayPosition()).toEqual({ x: 5, y: 6 });
  });

  it('reads the legacy show-hidden default from nova_show_system_apps', () => {
    withWindowRegistry(null);
    localStorage.setItem('nova_show_system_apps', '1');
    expect(RegistryPrefs.showHiddenApps()).toBe(true);
    localStorage.setItem('nova_show_hidden_apps', '0');
    expect(RegistryPrefs.showHiddenApps()).toBe(false);
  });

  it('ignores junk gracefully: non-array lists and malformed positions', () => {
    NovaRegistry.set('HKNU/apps/disabled', 'garbage', { type: 'REG_SZ' });
    NovaRegistry.set('HKND/overlay/position', { x: 'nope' }, { type: 'REG_JSON' });
    NovaRegistry.set('HKNU/shell/notifications/pendingActions', 'garbage', { type: 'REG_SZ' });
    expect(RegistryPrefs.disabledApps()).toEqual([]);
    expect(RegistryPrefs.overlayPosition()).toBeNull();
    expect(RegistryPrefs.notifPendingActions()).toEqual([]);
    expect(RegistryPrefs.setOverlayPosition('x', 1)).toBe(false);
  });
});
