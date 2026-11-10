// tests/platform/core/registry-boot-state.test.js — registry-backed boot
// machine state (HKNS/system/boot/*).
//
// RegistryBootState is the single API the boot sequence, the pre-boot
// recovery guard, and the Settings recovery button share. The suite wires a
// memory-store registry + the shared localStorage stub from setup.js, then
// exercises every accessor, the dual-strata write policy (hive is truth,
// legacy key is the pre-boot handoff shadow), the one-time adoption guard,
// and the fail-soft legacy fallback when no registry exists.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import RegistryBootState from '../../../js/platform/core/registry-boot-state.js';
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

// Simulates the shell: RegistryBootState finds the engine on window.
function withWindowRegistry(Reg) {
  globalThis.window = globalThis.window || {};
  window.NovaRegistry = Reg;
  window.RegistryBootState = RegistryBootState;
}

beforeEach(() => {
  resetTestStorage();
  RegistryBootState._internal.resetAdopted();
  withWindowRegistry(freshRegistry());
});

// The UMD modules assign window.* globals at import time and the suite
// re-assigns them per test — clear them so later suites sharing this
// vitest worker (isolate:false) never see a stale engine.
afterAll(() => {
  delete window.NovaRegistry;
  delete window.RegistryBootState;
});

describe('registry boot state (js/platform/core/registry-boot-state.js)', () => {
  it('adopts legacy localStorage boot flags into HKNS/system/boot exactly once', () => {
    localStorage.setItem('nova_safe_mode', '1');
    localStorage.setItem('nova_force_recovery', '1');
    localStorage.setItem('nova_boot_attempts', JSON.stringify([{ ts: 1, ua: 'x' }]));
    localStorage.setItem('nova_home_launch_pending', 'com.third.home');

    expect(RegistryBootState.flag('safeMode')).toBe(true);
    expect(NovaRegistry.get('HKNS/system/boot/safeMode')).toBe(1);
    expect(RegistryBootState.flag('forceRecovery')).toBe(true);
    expect(NovaRegistry.get('HKNS/system/boot/forceRecovery')).toBe(1);
    expect(RegistryBootState.attempts()).toEqual([{ ts: 1, ua: 'x' }]);
    expect(RegistryBootState.homeLaunchPending()).toBe('com.third.home');
    expect(NovaRegistry.stat('HKND/_migration/bootFlags')).not.toBeNull();
  });

  it('never clobbers an existing hive flag with a stale localStorage shadow', () => {
    NovaRegistry.set('HKNS/system/boot/safeMode', 0, { type: 'REG_DWORD', source: 'test' });
    localStorage.setItem('nova_safe_mode', '1');

    RegistryBootState._internal.resetAdopted();
    expect(RegistryBootState.flag('safeMode')).toBe(false);
  });

  it('dual-writes flags: hive dword is truth, legacy key is the handoff shadow', () => {
    expect(RegistryBootState.setFlag('manualRecovery', true)).toBe(true);
    expect(NovaRegistry.get('HKNS/system/boot/manualRecovery')).toBe(1);
    // The pre-boot guard in init.js reads the legacy key — it must be in step.
    expect(localStorage.getItem('nova_manual_recovery')).toBe('1');

    expect(RegistryBootState.flag('manualRecovery')).toBe(true);

    // A false flag clears the shadow so the guard stays quiet next boot.
    expect(RegistryBootState.setFlag('manualRecovery', false)).toBe(true);
    expect(localStorage.getItem('nova_manual_recovery')).toBeNull();
    expect(RegistryBootState.flag('manualRecovery')).toBe(false);
  });

  it('clearFlags removes both strata and clearBootState-style resets work', () => {
    RegistryBootState.setFlag('safeMode', true);
    RegistryBootState.setFlag('forceRecovery', true);
    RegistryBootState.setAttempts([{ ts: 2 }]);

    expect(RegistryBootState.clearFlags('safeMode', 'forceRecovery', 'attempts')).toBe(true);
    expect(NovaRegistry.stat('HKNS/system/boot/safeMode')).toBeNull();
    expect(NovaRegistry.stat('HKNS/system/boot/forceRecovery')).toBeNull();
    expect(NovaRegistry.stat('HKNS/system/boot/attempts')).toBeNull();
    expect(localStorage.getItem('nova_safe_mode')).toBeNull();
    expect(localStorage.getItem('nova_force_recovery')).toBeNull();
    expect(localStorage.getItem('nova_boot_attempts')).toBeNull();
    expect(RegistryBootState.flag('safeMode')).toBe(false);
  });

  it('round-trips attempts, watchdog doc, and the home handoff id', () => {
    expect(RegistryBootState.setAttempts([{ ts: 5, reason: 'boot_timeout_1' }])).toBe(true);
    expect(RegistryBootState.attempts()).toEqual([{ ts: 5, reason: 'boot_timeout_1' }]);
    expect(NovaRegistry.stat('HKNS/system/boot/attempts')).not.toBeNull();

    expect(RegistryBootState.setTimeoutFlag({ start: 10, completed: false })).toBe(true);
    expect(RegistryBootState.timeoutFlag()).toEqual({ start: 10, completed: false });

    expect(RegistryBootState.setHomeLaunchPending('com.example.home')).toBe(true);
    expect(RegistryBootState.homeLaunchPending()).toBe('com.example.home');
    expect(NovaRegistry.get('HKNS/system/boot/homeLaunchPending')).toBe('com.example.home');
    expect(RegistryBootState.clearHomeLaunchPending()).toBe(true);
    expect(RegistryBootState.homeLaunchPending()).toBeNull();
  });

  it('rejects malformed writes instead of corrupting the hive', () => {
    expect(RegistryBootState.setFlag('notAFlag', true)).toBe(false);
    expect(RegistryBootState.setAttempts('nope')).toBe(false);
    expect(RegistryBootState.setAttempts({ ts: 1 })).toBe(false);
    expect(RegistryBootState.setTimeoutFlag([1, 2])).toBe(false);
    expect(RegistryBootState.setHomeLaunchPending('')).toBe(false);
    expect(RegistryBootState.attempts()).toEqual([]);
  });

  it('falls back to the legacy localStorage channel when no registry exists', () => {
    delete window.NovaRegistry;
    RegistryBootState._internal.resetAdopted();

    localStorage.setItem('nova_safe_mode', '1');
    expect(RegistryBootState.flag('safeMode')).toBe(true);

    // Degraded writes still land in the shadow so the boot contract holds.
    expect(RegistryBootState.setFlag('manualRecovery', true)).toBe(false);
    expect(localStorage.getItem('nova_manual_recovery')).toBe('1');

    expect(RegistryBootState.setAttempts([{ ts: 9 }])).toBe(false);
    expect(JSON.parse(localStorage.getItem('nova_boot_attempts'))).toEqual([{ ts: 9 }]);

    expect(RegistryBootState.setHomeLaunchPending('com.legacy.home')).toBe(false);
    expect(localStorage.getItem('nova_home_launch_pending')).toBe('com.legacy.home');

    expect(RegistryBootState.clearFlags('manualRecovery', 'attempts', 'homeLaunchPending')).toBe(false);
    expect(localStorage.getItem('nova_manual_recovery')).toBeNull();
  });
});
