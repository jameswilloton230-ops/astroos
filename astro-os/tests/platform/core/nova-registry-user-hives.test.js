import { describe, it, expect, beforeEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';

// Per-account hive mounting (multi-user): HKNU/HKNA/HKND become mounted
// documents carrying the owner (user:<uid>:<HIVE>), HKNS stays the machine
// hive, and the sealed phase between unmount and mount refuses user-hive
// mutations so picker-phase writes can never land in the machine documents.

function memStorage() {
  const map = new Map();
  return {
    _map: map,
    read(name) {
      return map.has(name) ? map.get(name) : null;
    },
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(name, data) { map.set(name, JSON.stringify(data)); return true; },
    quarantine(name, raw) { map.set(`${name}.corrupt`, String(raw)); },
  };
}

function makeBus() {
  const listeners = {};
  const events = [];
  return {
    events,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, payload) { events.push({ name, payload }); (listeners[name] || []).forEach(fn => fn(payload)); },
  };
}

let storage;
let bus;

beforeEach(() => {
  storage = memStorage();
  bus = makeBus();
  NovaRegistry.init({ storage, events: bus, autoBackup: false });
});

describe('NovaRegistry — mounted per-user hives (multi-user)', () => {
  it('no mount by default: user-hive writes land in the machine documents (legacy behaviour)', () => {
    NovaRegistry.set('HKNU/settings/username', 'ada', { source: 'test' });
    expect(storage._map.has('HKNU')).toBe(true);
    expect(storage._map.has('user:u1:HKNU')).toBe(false);
  });

  it('mountUserHives routes user-hive reads and writes to per-account documents', () => {
    NovaRegistry.set('HKNS/shell/theme', 'stock-blue', { source: 'test' }); // machine doc
    NovaRegistry.mountUserHives('u1');

    NovaRegistry.set('HKNU/settings/username', 'ada', { source: 'test' });
    NovaRegistry.set('HKNA/com.example.app/pref', 42, { source: 'test' });
    NovaRegistry.set('HKNS/shell/theme', 'stock-red', { source: 'test' }); // machine doc stays machine

    expect(storage._map.has('user:u1:HKNU')).toBe(true);
    expect(storage._map.has('user:u1:HKNA')).toBe(true);
    expect(storage._map.has('user:u1:HKNS')).toBe(false);
    expect(NovaRegistry.get('HKNU/settings/username')).toBe('ada');
    expect(NovaRegistry.get('HKNS/shell/theme')).toBe('stock-red');
  });

  it('HKCU alias keeps working against a mounted account hive — no app-visible API change', () => {
    NovaRegistry.mountUserHives('u1');
    NovaRegistry.set('HKCU/settings/clockFormat', '24h', { source: 'test' });
    expect(NovaRegistry.get('HKNU/settings/clockFormat')).toBe('24h');
    expect(NovaRegistry.get('HKCU/settings/clockFormat')).toBe('24h');
    expect(storage._map.has('user:u1:HKNU')).toBe(true);
  });

  it('switching accounts: flush + remount gives each account its own isolated tree', () => {
    NovaRegistry.mountUserHives('u1');
    NovaRegistry.set('HKNU/settings/username', 'ada', { source: 'test' });
    expect(NovaRegistry.get('HKNU/settings/username')).toBe('ada');

    NovaRegistry.mountUserHives('u2'); // flushes u1, loads u2's (empty) hives
    expect(NovaRegistry.get('HKNU/settings/username')).toBeUndefined();

    NovaRegistry.set('HKNU/settings/username', 'sam', { source: 'test' });
    NovaRegistry.mountUserHives('u1'); // back to u1
    expect(NovaRegistry.get('HKNU/settings/username')).toBe('ada');
    expect(storage._map.has('user:u1:HKNU')).toBe(true);
    expect(storage._map.has('user:u2:HKNU')).toBe(true);
  });

  it('flushUserHives persists the in-memory tree without a remount', () => {
    NovaRegistry.mountUserHives('u1');
    NovaRegistry.set('HKNU/settings/theme', 'dark', { source: 'test' });
    NovaRegistry.flushUserHives();
    const raw = JSON.parse(storage._map.get('user:u1:HKNU'));
    expect(raw.keys.settings.values.theme.data).toBe('dark');
  });

  it('volatile mounts (guest) are never persisted', () => {
    NovaRegistry.mountUserHives('guest-abc', { volatile: true });
    NovaRegistry.set('HKNU/settings/username', 'guest', { source: 'test' });
    expect(NovaRegistry.flushUserHives()).toBe(true);
    expect(storage._map.has('user:guest-abc:HKNU')).toBe(false);
  });

  it('the sealed phase after unmount refuses user-hive mutations but keeps HKNS writable', () => {
    NovaRegistry.mountUserHives('u1');
    NovaRegistry.set('HKNU/settings/username', 'ada', { source: 'test' });
    NovaRegistry.unmountUserHives();

    // A picker-phase write can never land in the machine documents.
    expect(() => NovaRegistry.set('HKNU/settings/theme', 'dark', { source: 'test' })).toThrow(/no account hives are mounted/);
    expect(() => NovaRegistry.set('HKNA/com.example.app/x', 1, { source: 'test' })).toThrow(/no account hives are mounted/);
    // Machine writes keep working.
    expect(() => NovaRegistry.set('HKNS/shell/theme', 'ok', { source: 'test' })).not.toThrow();
    // And the flushed account data is untouched by the sealed phase.
    expect(JSON.parse(storage._map.get('user:u1:HKNU')).keys.settings.values.username.data).toBe('ada');
  });

  it('mountUserHives rejects malformed uids', () => {
    expect(() => NovaRegistry.mountUserHives('../evil')).toThrow();
    expect(() => NovaRegistry.mountUserHives('')).toThrow();
    expect(() => NovaRegistry.mountUserHives('a:b')).toThrow();
  });

  it('mounts on the USERNAME segment (users/<username>/registry) — dots allowed', () => {
    // Usernames (unlike uids) may contain dots and dashes; the segment is
    // what the storage adapter turns into the per-account file path, so it
    // must validate cleanly and never collide with traversal tricks.
    NovaRegistry.mountUserHives('diraz.v2');
    NovaRegistry.set('HKNU/settings/username', 'diraz', { source: 'test' });
    expect(storage._map.has('user:diraz.v2:HKNU')).toBe(true);
    expect(NovaRegistry.mountedUserUid()).toBe('diraz.v2');
    expect(() => NovaRegistry.mountUserHives('../evil')).toThrow();
  });

  it('mountedUserUid reports the active mount; per-hive quotas still apply per account', () => {
    expect(NovaRegistry.mountedUserUid()).toBe(null);
    NovaRegistry.mountUserHives('u1');
    expect(NovaRegistry.mountedUserUid()).toBe('u1');
    // The 2 MB per-hive quota is enforced on the mounted tree just as on the
    // machine hives — one account cannot bloat another account's limits.
    const bigValue = 'x'.repeat(NovaRegistry.LIMITS.MAX_VALUE_BYTES + 1);
    expect(() => NovaRegistry.set('HKNU/settings/big', bigValue, { source: 'test' })).toThrow();
  });

  it('corrupt per-account hive documents are quarantined and start fresh', () => {
    NovaRegistry.mountUserHives('u1');
    NovaRegistry.set('HKNU/settings/username', 'ada', { source: 'test' });
    NovaRegistry.mountUserHives('u2'); // flushes u1's good copy first
    // Corrupt u1's HKNU document on disk while ANOTHER account is mounted,
    // so nothing in memory can overwrite it before the next mount reads it.
    storage._map.set('user:u1:HKNU', '{ this is not json');
    NovaRegistry.mountUserHives('u1');
    expect(NovaRegistry.get('HKNU/settings/username')).toBeUndefined(); // fresh hive
    expect(storage._map.has('user:u1:HKNU.corrupt')).toBe(true);
  });
});
