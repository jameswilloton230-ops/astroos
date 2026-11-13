import { describe, it, expect, vi, beforeEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';

// The engine is a UMD module with injectable storage/events — every test
// runs against a memory store and a tiny event recorder so nothing touches
// disk or the shared localStorage stub in setup.js.

function memStorage() {
  const map = new Map();
  return {
    _map: map,
    loadAll() {
      const out = {};
      // Mirrors the real adapter: four hives + the AUDIT/SNAPSHOTS docs.
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = map.has(name) ? JSON.parse(map.get(name)) : null;
      }
      return out;
    },
    save(hive, data) { map.set(hive, JSON.stringify(data)); },
  };
}

function makeBus() {
  const listeners = {};
  const events = [];
  return {
    events,
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    off() {},
    emit(name, data) {
      events.push({ name, data });
      for (const fn of (listeners[name] || []).slice()) fn(data);
    },
  };
}

function freshRegistry() {
  NovaRegistry._internal.resetState();
  const bus = makeBus();
  NovaRegistry.init({ storage: memStorage(), events: bus, logger: console });
  return { bus, Reg: NovaRegistry };
}

describe('AstroOS Registry engine (js/platform/core/nova-registry.js)', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('parses paths with / and \\ separators into one canonical form', () => {
    Reg.set('HKNS\\shell\\taskbar', 'top');
    expect(Reg.get('HKNS/shell/taskbar')).toBe('top');
    expect(Reg.stat('HKNS\\shell\\taskbar').path).toBe('HKNS/shell/taskbar');
    // The hive is case-insensitive; segments keep their case.
    expect(Reg.stat('hkns/shell/taskbar').data).toBe('top');
  });

  it('rejects malformed paths with INVALID_ARGS', () => {
    // 'HKNS' alone is no longer an error: since v2 a bare key path (even a
    // hive root) addresses that key's default value — covered below.
    const bad = ['', 'NOPE/x', 'HKNS/a/', 'HKNS/../etc', 'HKNS/a/../b', 'HKNS/' + 'x'.repeat(65)];
    for (const path of bad) {
      expect(() => Reg.get(path), path).toThrow();
      try { Reg.get(path); } catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
    }
  });

  it('stores and returns every value type', () => {
    const cases = [
      ['HKNU/a/sz', 'hello', 'REG_SZ', 'hello'],
      ['HKNU/a/flag', true, 'REG_BOOL', true],
      ['HKNU/a/dword', 42, 'REG_DWORD', 42],
      ['HKNU/a/qword', 9007199254740991, 'REG_QWORD', 9007199254740991],
      ['HKNU/a/json', { list: [1, 2, 3] }, 'REG_JSON', { list: [1, 2, 3] }],
      ['HKNU/a/bin', 'aGVsbG8=', 'REG_BINARY', 'aGVsbG8='],
      ['HKNU/a/null', null, 'REG_JSON', null],
    ];
    for (const [path, value, type, expected] of cases) {
      Reg.set(path, value, { type });
      const entry = Reg.stat(path);
      expect(entry.type).toBe(type);
      expect(entry.data).toEqual(expected);
      expect(Reg.get(path)).toEqual(expected);
    }
  });

  it('auto-detects types when none is given', () => {
    expect(Reg.set('HKNU/d/b', true).type).toBe('REG_BOOL');
    expect(Reg.set('HKNU/d/small', 7).type).toBe('REG_DWORD');
    expect(Reg.set('HKNU/d/big', 4294967296).type).toBe('REG_QWORD');
    expect(Reg.set('HKNU/d/str', 'x').type).toBe('REG_SZ');
    expect(Reg.set('HKNU/d/obj', { a: 1 }).type).toBe('REG_JSON');
  });

  it('rejects values that do not fit the declared type', () => {
    const bad = [
      ['HKNU/b/sz', 42, 'REG_SZ'],
      ['HKNU/b/bool', 'true', 'REG_BOOL'],
      ['HKNU/b/dword', -1, 'REG_DWORD'],
      ['HKNU/b/dword', 4294967296, 'REG_DWORD'],
      ['HKNU/b/dword', 1.5, 'REG_DWORD'],
      ['HKNU/b/qword', -1, 'REG_QWORD'],
      ['HKNU/b/bin', 'not base64!!', 'REG_BINARY'],
      ['HKNU/b/unknown', 'x', 'REG_NOPE'],
    ];
    for (const [path, value, type] of bad) {
      try { Reg.set(path, value, { type }); expect.unreachable(`${path}`); }
      catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
    }
    // Negative numbers cannot auto-detect to any type either.
    try { Reg.set('HKNU/b/neg', -5); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
  });

  it('dedupes identical writes (one event, not two)', () => {
    Reg.set('HKNU/c/k', 'same');
    Reg.set('HKNU/c/k', 'same');
    const changed = bus.events.filter((e) => e.name === 'nova:reg:changed');
    expect(changed).toHaveLength(1);
    expect(Reg.set('HKNU/c/k', 'different').changed).toBe(true);
    expect(bus.events.filter((e) => e.name === 'nova:reg:changed')).toHaveLength(2);
  });

  it('emits nova:reg:changed with path, type, value, appId and source', () => {
    Reg.set('HKNA/com.example.game/score', 10, { appId: 'com.example.game' });
    const event = bus.events.find((e) => e.name === 'nova:reg:changed');
    expect(event.data).toMatchObject({
      path: 'HKNA/com.example.game/score',
      type: 'REG_DWORD',
      value: 10,
      appId: 'com.example.game',
      source: 'app',
    });
  });

  it('deletes values, and keys only with recursive: true', () => {
    Reg.set('HKNU/del/leaf', 'v');
    expect(Reg.remove('HKNU/del/leaf').removed).toBe('value');

    Reg.set('HKNU/del/key/a', '1');
    Reg.set('HKNU/del/key/b', '2');
    try { Reg.remove('HKNU/del/key'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('SUBTREE_NOT_EMPTY'); }
    expect(Reg.remove('HKNU/del/key', { recursive: true }).removed).toBe('key');
    expect(Reg.list('HKNU/del').keys).toEqual([]);

    try { Reg.remove('HKNU/del/ghost'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NOT_FOUND'); }
  });

  it('lists sorted keys and value entries; unknown keys return null', () => {
    Reg.set('HKNU/list/zebra', '1');
    Reg.set('HKNU/list/alpha', '2');
    Reg.set('HKNU/list/sub/inner', '3');
    const listing = Reg.list('HKNU/list');
    // 'sub' is a child KEY; 'alpha' and 'zebra' are VALUES of this key.
    expect(listing.keys).toEqual(['sub']);
    expect(Object.keys(listing.values).sort()).toEqual(['alpha', 'zebra']);
    expect(Reg.list('HKNU/missing')).toBeNull();
  });

  it('lists a VALUE path as a leaf — list accepts every path get accepts', () => {
    // get/set/stat address the value named by the last segment; list() used
    // to refuse those paths with NOT_FOUND ("no such key"). It must mirror
    // resolveValueTarget instead: same path space, value wins.
    Reg.set('HKNS/shell/theme', 'nova-dark');
    const leaf = Reg.list('HKNS/shell/theme');
    expect(leaf.path).toBe('HKNS/shell/theme');
    expect(leaf.keys).toEqual([]);
    expect(leaf.values.theme).toMatchObject({ type: 'REG_SZ', data: 'nova-dark' });

    // A KEY path still lists the whole node (child keys + value entries).
    Reg.set('HKNS/shell/other', 1);
    const key = Reg.list('HKNS/shell');
    expect(key.keys).toEqual([]);
    expect(Object.keys(key.values).sort()).toEqual(['other', 'theme']);

    // A value reached through a link resolves like get() and names the link.
    Reg.setLink('HKNU/alias', 'HKNS/shell');
    const viaLink = Reg.list('HKNU/alias/theme');
    expect(viaLink.values.theme.data).toBe('nova-dark');
    expect(viaLink.link).toBe('HKNS/shell');

    // Genuinely unknown paths stay null (NOT_FOUND at the IPC layer).
    expect(Reg.list('HKNS/shell/ghost')).toBeNull();
    expect(Reg.list('HKNS/shell/theme/deep')).toBeNull();
  });

  it('exports and imports subtrees (merge semantics, imported wins)', () => {
    Reg.set('HKNA/com.a/src/one', '1');
    Reg.set('HKNA/com.a/src/two', '2');
    Reg.set('HKNA/com.a/src/deep/three', '3');
    const dump = Reg.export('HKNA/com.a/src');

    // Import under a different app's subtree — host policy decides who may
    // do that; the engine only merges what it is told to merge.
    Reg.set('HKNA/com.b/dst/one', 'OLD');
    const result = Reg.import('HKNA/com.b/dst', dump);
    expect(result.merged).toBe(3);
    expect(Reg.get('HKNA/com.b/dst/one')).toBe('1'); // imported wins
    expect(Reg.get('HKNA/com.b/dst/deep/three')).toBe('3');

    try { Reg.import('HKNA/com.b/x', 'not-an-object'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
    try { Reg.import('HKNA/com.b/x', { values: { bad: { type: 'REG_SZ', data: 42 } } }); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
  });

  it('enforces quotas (depth, value size)', () => {
    const deep = ['HKNU', ...Array.from({ length: 17 }, (_, i) => 'k' + i)].join('/');
    try { Reg.set(deep, 'x'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }

    try { Reg.set('HKNU/q/big', 'x'.repeat(256 * 1024 + 1)); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('QUOTA_EXCEEDED'); }
  });

  it('starts fresh from corrupt stored hives instead of crashing', () => {
    NovaRegistry._internal.resetState();
    const broken = {
      loadAll() {
        return { HKNS: '{not json', HKNU: { keys: null }, HKNA: null, HKND: undefined };
      },
      save() { return true; },
    };
    NovaRegistry.init({ storage: broken, events: bus, logger: console });
    expect(Reg.get('HKNS/shell/theme')).toBeUndefined();
    expect(() => Reg.set('HKNS/shell/theme', 'nord')).not.toThrow();
    expect(Reg.get('HKNS/shell/theme')).toBe('nord');
    Reg = NovaRegistry; // keep the alias valid for later tests
  });

  it('seeds defaults once and never clobbers existing values', () => {
    const seeded = Reg.ensureDefaults(Reg.BOOT_DEFAULTS);
    expect(seeded).toBeGreaterThan(0);
    expect(Reg.get('HKNS/shell/theme')).toBe('nova-dark');
    Reg.set('HKNS/shell/theme', 'nord');
    expect(Reg.ensureDefaults(Reg.BOOT_DEFAULTS)).toBe(0);
    expect(Reg.get('HKNS/shell/theme')).toBe('nord');
  });

  it('mirrors mapped settings changes into the registry and ignores the rest', () => {
    expect(Reg.attachSettingsMirror(
      { get: () => undefined, set: () => {} },
      bus,
    )).toBe(true);
    bus.emit('settings:changed', { key: 'theme', value: 'dracula' });
    bus.emit('settings:changed', { key: 'wallpaperId', value: 'dark' });
    bus.emit('settings:changed', { key: 'clockFormat', value: '24h' }); // unmapped
    expect(Reg.get('HKNS/shell/theme')).toBe('dracula');
    expect(Reg.get('HKNS/shell/wallpaper')).toBe('dark');
    expect(Reg.stat('HKNS/clockFormat')).toBeNull();
  });

  it('keeps mutating writes persisted through the storage adapter', () => {
    const storage = memStorage();
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage, events: bus, logger: console });
    NovaRegistry.set('HKNU/persist/k', 'v');
    expect(storage._map.get('HKNU')).toContain('"k"');
  });
});

describe('AstroOS Registry engine v2 — default values', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('reads and writes a key default via the bare key path', () => {
    Reg.set('HKNS/shell/theme', 'nova-dark'); // creates the real key
    expect(Reg.stat('HKNS/shell')).toBeNull(); // default not set yet
    Reg.set('HKNS/shell', 'key-default');
    expect(Reg.get('HKNS/shell')).toBe('key-default');
    expect(Reg.get('HKNS/shell/theme')).toBe('nova-dark'); // child intact
    // Explicit '(default)' segment addresses the same value.
    expect(Reg.get('HKNS/shell/(default)')).toBe('key-default');
    Reg.set('HKNS/shell/(default)', 'rewritten');
    expect(Reg.get('HKNS/shell')).toBe('rewritten');
  });

  it('keeps value-first precedence when a value and key share a name', () => {
    Reg.set('HKNU/dup/kid/x', 'in-child'); // key 'dup' exists with child 'kid'
    Reg.set('HKNU/dup/kid', 'as-value');   // value 'kid' under 'dup'
    expect(Reg.get('HKNU/dup/kid')).toBe('as-value');
    expect(Reg.get('HKNU/dup/kid/x')).toBe('in-child');
  });

  it('hive roots carry a default value too; removal rules stay Windows-like', () => {
    Reg.set('HKNS', 'root-default');
    expect(Reg.get('HKNS')).toBe('root-default');
    expect(() => Reg.remove('HKNS')).toThrow(); // never delete a hive root
    expect(Reg.remove('HKNS/(default)').removed).toBe('value');
    expect(Reg.get('HKNS')).toBeUndefined();
  });

  it('lists the default among the values and deletes the key separately', () => {
    Reg.set('HKNU/k/sub', 'v'); // a VALUE 'sub' under key k
    Reg.set('HKNU/k', 'def');   // key k exists → its default value
    expect(Object.keys(Reg.list('HKNU/k').values).sort()).toEqual(['(default)', 'sub']);
    expect(Reg.remove('HKNU/k/(default)').removed).toBe('value');
    expect(Object.keys(Reg.list('HKNU/k').values)).toEqual(['sub']); // key survives
    expect(Reg.remove('HKNU/k/sub').removed).toBe('value');
    expect(Reg.remove('HKNU/k').removed).toBe('key');
  });
});

describe('AstroOS Registry engine v2 — REG_MULTI_SZ and REG_EXPAND_SZ', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('stores an array of strings as REG_MULTI_SZ (explicit type only)', () => {
    Reg.set('HKNU/m/list', ['a', 'b', 'c'], { type: 'REG_MULTI_SZ' });
    expect(Reg.stat('HKNU/m/list').type).toBe('REG_MULTI_SZ');
    expect(Reg.get('HKNU/m/list')).toEqual(['a', 'b', 'c']);
    // Arrays stay REG_JSON when auto-detected — Windows never guesses types.
    expect(Reg.set('HKNU/m/auto', ['x']).type).toBe('REG_JSON');
    for (const bad of [['a', 1], 'nope', [42], { a: 1 }]) {
      try { Reg.set('HKNU/m/bad', bad, { type: 'REG_MULTI_SZ' }); expect.unreachable(); }
      catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
    }
  });

  it('stores REG_EXPAND_SZ raw and expands %VAR% on read from HKNS/env', () => {
    Reg.set('HKNS/env/novaRoot', '~/.config/novabyte');
    Reg.set('HKNS/env/empty', '');
    Reg.set('HKNS/tpl/path', '%novaRoot%/wall.png', { type: 'REG_EXPAND_SZ' });
    const entry = Reg.stat('HKNS/tpl/path');
    expect(entry.type).toBe('REG_EXPAND_SZ');
    expect(entry.data).toBe('%novaRoot%/wall.png'); // raw at rest
    expect(entry.expanded).toBe('~/.config/novabyte/wall.png');
    expect(Reg.get('HKNS/tpl/path')).toBe('~/.config/novabyte/wall.png'); // get() expands
    // Unknown variables are left verbatim; empty variables expand to ''.
    Reg.set('HKNS/tpl/mix', '%unknown%-%empty%', { type: 'REG_EXPAND_SZ' });
    expect(Reg.get('HKNS/tpl/mix')).toBe('%unknown%-');
    // Same coercion rules as REG_SZ.
    try { Reg.set('HKNS/tpl/bad', 42, { type: 'REG_EXPAND_SZ' }); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
    // Expansion never recurses — the replacement is not re-expanded.
    Reg.set('HKNS/env/a', '%b%');
    Reg.set('HKNS/env/b', 'final');
    Reg.set('HKNS/tpl/nested', '[%a%]', { type: 'REG_EXPAND_SZ' });
    expect(Reg.get('HKNS/tpl/nested')).toBe('[%b%]');
  });

  it('exposes Reg.expand for callers that expand strings against HKNS/env', () => {
    Reg.set('HKNS/env/home', '/home/nova');
    expect(Reg.expand('%home%/docs')).toBe('/home/nova/docs');
    expect(Reg.expand('no-tokens')).toBe('no-tokens');
  });
});

describe('AstroOS Registry engine v2 — HKCU alias', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('maps HKCU onto HKNU in every canonical path', () => {
    Reg.set('HKCU/desktop/pins', ['com.astroos.notes']);
    expect(Reg.get('HKNU/desktop/pins')).toEqual(['com.astroos.notes']);
    expect(Reg.get('hkcu/desktop/pins')).toEqual(['com.astroos.notes']);
    expect(Reg.stat('HKCU/desktop/pins').path).toBe('HKNU/desktop/pins');
    expect(Reg._internal.parsePath('HKCU/x').path).toBe('HKNU/x');
    expect(Reg._internal.parsePath('HKCU/x').hive).toBe('HKNU');
  });
});

describe('AstroOS Registry engine v2 — links (REG_LINK)', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('creates links, follows them on reads, and reports the target', () => {
    Reg.set('HKNA/com.a/state/v3/setting', 7);
    expect(Reg.setLink('HKNA/com.a/latest', 'HKNA/com.a/state/v3').link).toBe('HKNA/com.a/state/v3');
    const listing = Reg.list('HKNA/com.a/latest');
    expect(listing.link).toBe('HKNA/com.a/state/v3');
    expect(Object.keys(listing.values)).toEqual(['setting']);
    expect(Reg.get('HKNA/com.a/latest/setting')).toBe(7); // read-through
    expect(Reg.export('HKNA/com.a/latest').values.setting.data).toBe(7);
  });

  it('writes through same-hive links and refuses cross-hive write-through', () => {
    Reg.set('HKNU/target/deep/value', 'old');
    Reg.setLink('HKNU/alias', 'HKNU/target/deep');
    Reg.set('HKNU/alias/value', 'new'); // lands on the target
    expect(Reg.get('HKNU/target/deep/value')).toBe('new');
    // A bare write through a link hits the target's default value.
    Reg.set('HKNU/alias', 'default-of-target');
    expect(Reg.get('HKNU/target/deep')).toBe('default-of-target');
    // Cross-hive links stay readable but are never written through.
    Reg.set('HKNS/keep/safe', 'yes');
    Reg.setLink('HKNU/cross', 'HKNS/keep');
    expect(Reg.get('HKNU/cross/safe')).toBe('yes');
    try { Reg.set('HKNU/cross/safe', 'no'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('LINK_CROSS_HIVE'); }
    expect(Reg.get('HKNS/keep/safe')).toBe('yes');
  });

  it('removing a link path removes the link, never the target', () => {
    Reg.set('HKNU/t/inner', 1); // value 'inner' under key t
    Reg.setLink('HKNU/l', 'HKNU/t');
    expect(Reg.remove('HKNU/l').removed).toBe('link');
    expect(Object.keys(Reg.list('HKNU/t').values)).toEqual(['inner']); // target untouched
    expect(Reg.list('HKNU/l')).toBeNull();
  });

  it('rejects self-links, non-empty key replacement, and loop chains', () => {
    Reg.set('HKNU/full/x', 1);
    try { Reg.setLink('HKNU/full', 'HKNU/other'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('SUBTREE_NOT_EMPTY'); }
    try { Reg.setLink('HKNU/self', 'HKNU/self/deep'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_LINK'); }
    Reg.setLink('HKNU/loopA', 'HKNU/loopB');
    Reg.setLink('HKNU/loopB', 'HKNU/loopA');
    try { Reg.list('HKNU/loopA'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('LINK_LOOP'); }
    try { Reg.setLink('HKNU/bad', 'NOPE/nope'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
  });

  it('survives export/import: link nodes round-trip as links', () => {
    Reg.set('HKNA/com.a/state/v3/x', 1);
    Reg.setLink('HKNA/com.a/latest', 'HKNA/com.a/state/v3');
    const dump = Reg.export('HKNA/com.a');
    Reg.remove('HKNA/com.a', { recursive: true });
    Reg.import('HKNA/com.a', dump);
    expect(Reg.list('HKNA/com.a/latest').link).toBe('HKNA/com.a/state/v3');
    expect(Reg.get('HKNA/com.a/latest/x')).toBe(1);
  });
});

describe('AstroOS Registry engine v2 — rename', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('renames values and keys atomically with NAME_CONFLICT detection', () => {
    Reg.set('HKNU/r/key/one', 'a');
    Reg.rename('HKNU/r/key/one', 'uno');
    expect(Reg.get('HKNU/r/key/uno')).toBe('a');
    expect(Reg.stat('HKNU/r/key/one')).toBeNull();

    Reg.rename('HKNU/r/key', 'renamed');
    expect(Reg.get('HKNU/r/renamed/uno')).toBe('a');
    expect(Reg.list('HKNU/r/key')).toBeNull();

    Reg.set('HKNU/r/renamed/two', 'b');
    try { Reg.rename('HKNU/r/renamed/uno', 'two'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NAME_CONFLICT'); }
    // A key rename also collides with a sibling VALUE of the same name.
    Reg.set('HKNU/r/sibling', 'x');
    try { Reg.rename('HKNU/r/renamed', 'sibling'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NAME_CONFLICT'); }
    try { Reg.rename('HKNU/r/ghost', 'x'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NOT_FOUND'); }
  });

  it('renaming a value to "(default)" makes it the key default; key rename forbids it', () => {
    Reg.set('HKNU/d/k/v', 1);
    Reg.rename('HKNU/d/k/v', '(default)');
    expect(Reg.get('HKNU/d/k')).toBe(1);
    Reg.set('HKNU/d/k/child', 2);
    try { Reg.rename('HKNU/d/k/child', '(default)'); expect.unreachable(); } // now conflicts with the default VALUE
    catch (err) { expect(err.code).toBe('NAME_CONFLICT'); }
    try { Reg.rename('HKNU/d/k', '(default)'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
    // Rename events announce the NEW path.
    const events = bus.events.filter((e) => e.name === 'nova:reg:changed');
    expect(events.some((e) => e.data.path === 'HKNU/d/k/(default)')).toBe(true);
  });
});

describe('AstroOS Registry engine v2 — ACLs', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('validates shape on setAcl and returns a deep copy on getAcl', () => {
    Reg.set('HKNA/com.a/x', 1);
    const acl = { owner: 'com.a', entries: [{ id: 'com.a', rights: ['read', 'write'] }, { id: '*', rights: ['read'] }] };
    expect(Reg.setAcl('HKNA/com.a', acl).acl.entries).toHaveLength(2);
    const got = Reg.getAcl('HKNA/com.a');
    expect(got.owner).toBe('com.a');
    got.entries[0].rights.push('hax');
    expect(Reg.getAcl('HKNA/com.a').entries[0].rights).toEqual(['read', 'write']);
    for (const { badAcl, why } of [
      { badAcl: 'nope', why: 'non-object' },
      { badAcl: { entries: 'nope' }, why: 'entries not an array' },
      { badAcl: { entries: [{ id: '' }] }, why: 'empty id' },
      { badAcl: { entries: [{ id: 'x', rights: ['own'] }] }, why: 'unknown right' },
      { badAcl: { entries: Array.from({ length: 33 }, () => ({ id: 'x', rights: [] })) }, why: 'too many entries' },
    ]) {
      try { Reg.setAcl('HKNA/com.a', badAcl); expect.unreachable(why); }
      catch (err) { expect(err.code).toBe('INVALID_VALUE'); }
    }
    expect(Reg.setAcl('HKNA/com.a', null).acl).toBeNull(); // removal
    expect(Reg.getAcl('HKNA/com.a')).toBeNull();
  });
  it('evaluates inheritance: deepest entry per id wins, non-inherit stops at the key', () => {
    Reg.set('HKNA/com.a/area/sub/x', 1);
    Reg.setAcl('HKNA/com.a/area', { entries: [
      { id: 'com.a', rights: ['read', 'write'] },
      { id: 'com.b', rights: ['read'] },
      { id: 'com.c', rights: ['read'], inherit: false }, // this key only
    ] });
    // com.a inherited read+write down the subtree.
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.a', 'write')).toMatchObject({ granted: true });
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.b', 'read')).toMatchObject({ granted: true });
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.b', 'write')).toMatchObject({ granted: false });
    // com.c's grant does not inherit past 'area'.
    expect(Reg.checkAccess('HKNA/com.a/area', 'com.c', 'read')).toMatchObject({ granted: true });
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.c', 'read')).toMatchObject({ granted: false });
    // A deeper redefinition for the same id wins.
    Reg.setAcl('HKNA/com.a/area/sub', { entries: [{ id: 'com.b', rights: ['read', 'write'] }] });
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.b', 'write')).toMatchObject({ granted: true, reason: 'acl-grant' });
    // With any ACL in the chain, unlisted actors are denied.
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'com.evil', 'read').granted).toBe(false);
    // The literal system actor always passes.
    expect(Reg.checkAccess('HKNA/com.a/area/sub', 'system', 'write').granted).toBe(true);
    // No ACL anywhere → granted (engine stays policy-neutral).
    expect(Reg.checkAccess('HKNU/plain', 'com.nobody', 'write').granted).toBe(true);
    // Wildcard entries apply to every actor.
    Reg.setAcl('HKNU/wild', { entries: [{ id: '*', rights: ['read'] }] });
    expect(Reg.checkAccess('HKNU/wild', 'com.anyone', 'read').granted).toBe(true);
    expect(Reg.checkAccess('HKNU/wild', 'com.anyone', 'write').granted).toBe(false);
  });

  it('ACLs ride the normal change event and audit trail', () => {
    Reg.set('HKNU/acl/k', 1);
    Reg.setAcl('HKNU/acl', { entries: [{ id: 'com.x', rights: ['read'] }] });
    const event = bus.events.filter((e) => e.name === 'nova:reg:changed').pop();
    expect(event.data.type).toBe('ACL');
    const trail = Reg.audit(1)[0];
    expect(trail.action).toBe('acl');
    expect(trail.path).toBe('HKNU/acl');
  });
});

describe('AstroOS Registry engine v2 — audit ring', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('records actor, action, path and before/after previews, newest first', () => {
    Reg.set('HKNU/aud/v', 'old', { actor: 'com.example.app' });
    Reg.set('HKNU/aud/v', 'new-long-value-' + 'x'.repeat(300), { actor: 'com.example.app' });
    Reg.remove('HKNU/aud/v');
    const trail = Reg.audit(10);
    expect(trail[0].action).toBe('remove');
    expect(trail[1].after.length).toBeLessThanOrEqual(201); // truncated preview
    expect(trail[2]).toMatchObject({ actor: 'com.example.app', action: 'set', path: 'HKNU/aud/v', before: null, after: 'old' });
    // Default actors: settings mirror → shell, seeds → seed.
    Reg.set('HKNU/aud/m', 1, { source: 'settings-mirror' });
    expect(Reg.audit(1)[0].actor).toBe('shell');
    Reg.set('HKNU/aud/s', 1, { source: 'seed' });
    expect(Reg.audit(1)[0].actor).toBe('seed');
  });

  it('caps the ring at MAX_AUDIT_ENTRIES', () => {
    for (let i = 0; i < 505; i++) Reg.set('HKNU/cap/v', i);
    const trail = Reg.audit(1000);
    expect(trail.length).toBe(Reg.LIMITS.MAX_AUDIT_ENTRIES);
    expect(trail[0].after).toBe('504'); // newest kept
  });
});

describe('AstroOS Registry engine v2 — batch transactions', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('commits cross-hive mutations atomically and emits events at commit', () => {
    const result = Reg.batch(() => {
      Reg.set('HKNS/b/one', 1);
      Reg.set('HKNU/b/two', 2);
      Reg.set('HKNA/com.b/three', 3);
    });
    expect(result.committed).toBe(3);
    expect(Reg.get('HKNS/b/one')).toBe(1);
    expect(Reg.get('HKNU/b/two')).toBe(2);
    expect(Reg.get('HKNA/com.b/three')).toBe(3);
    const changed = bus.events.filter((e) => e.name === 'nova:reg:changed');
    expect(changed).toHaveLength(3); // deferred, then all emitted in order
    expect(changed.map((e) => e.data.path)).toEqual(['HKNS/b/one', 'HKNU/b/two', 'HKNA/com.b/three']);
  });

  it('rolls back every hive when the mutator throws, with no events or audit entries', () => {
    Reg.set('HKNU/keep/anchor', 'safe');
    const before = bus.events.filter((e) => e.name === 'nova:reg:changed').length;
    try {
      Reg.batch(() => {
        Reg.set('HKNS/b/one', 1);
        Reg.remove('HKNU/keep/anchor');
        throw new Error('abort the batch');
      });
      expect.unreachable();
    } catch (err) {
      expect(err.message).toBe('abort the batch');
    }
    expect(Reg.get('HKNS/b/one')).toBeUndefined();
    expect(Reg.get('HKNU/keep/anchor')).toBe('safe'); // rolled back
    expect(bus.events.filter((e) => e.name === 'nova:reg:changed')).toHaveLength(before);
    expect(Reg.audit().some((e) => e.path === 'HKNS/b/one')).toBe(false);
  });

  it('persists batched writes exactly once per touched hive', () => {
    const storage = memStorage();
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage, events: bus, logger: console });
    const spy = { saves: [] };
    const counting = {
      loadAll: () => ({}),
      save(hive, data) { spy.saves.push(hive); storage.save(hive, data); },
    };
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: counting, events: bus, logger: console });
    NovaRegistry.batch(() => {
      NovaRegistry.set('HKNS/b/one', 1);
      NovaRegistry.set('HKNS/b/two', 2);
      NovaRegistry.set('HKNU/b/three', 3);
    });
    expect(spy.saves.filter((h) => h === 'HKNS')).toHaveLength(1);
    expect(spy.saves.filter((h) => h === 'HKNU')).toHaveLength(1);
    Reg = NovaRegistry;
  });

  it('rejects nested batches', () => {
    try {
      Reg.batch(() => { Reg.batch(() => {}); });
      expect.unreachable();
    } catch (err) { expect(err.code).toBe('INVALID_STATE'); }
  });
});

describe('AstroOS Registry engine v2 — snapshots', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('saves, lists, restores and deletes hive snapshots (bounded ring)', () => {
    Reg.set('HKNU/snap/v', 'first');
    const snap1 = Reg.saveSnapshot('HKNU', 'before-change');
    Reg.set('HKNU/snap/v', 'second');
    Reg.saveSnapshot('HKNU');
    let list = Reg.snapshots('HKNU');
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('before-change'); // ring is oldest-first

    Reg.restoreSnapshot('HKNU', snap1.id);
    expect(Reg.get('HKNU/snap/v')).toBe('first');
    expect(bus.events.filter((e) => e.name === 'nova:reg:changed').some((e) => e.data.path === 'HKNU')).toBe(true);

    try { Reg.restoreSnapshot('HKNU', 'snap_nope'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('NOT_FOUND'); }
    try { Reg.saveSnapshot('NOPE'); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }

    Reg.deleteSnapshot('HKNU', list[0].id);
    expect(Reg.snapshots('HKNU')).toHaveLength(1);
  });

  it('keeps at most MAX_SNAPSHOTS_PER_HIVE per hive', () => {
    for (let i = 0; i < 5; i++) {
      Reg.set('HKNU/ring/v', i);
      Reg.saveSnapshot('HKNU', 'snap-' + i);
    }
    expect(Reg.snapshots('HKNU')).toHaveLength(Reg.LIMITS.MAX_SNAPSHOTS_PER_HIVE);
  });

  it('takes a boot snapshot of non-empty hives on init (auto-backup)', () => {
    const storage = memStorage();
    // Session 1: empty store, so init takes no boot snapshots yet.
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage, events: bus, logger: console });
    NovaRegistry.set('HKNU/boot/keep', 'me');
    // Session 2 — the "reboot": fresh state over the SAME storage.
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage, events: bus, logger: console });
    expect(NovaRegistry.get('HKNU/boot/keep')).toBe('me');
    const boots = NovaRegistry.snapshots('HKNU').filter((s) => s.label === 'boot');
    expect(boots).toHaveLength(1); // one boot snapshot of the restored hive
    // A hive that was empty gets no boot snapshot.
    expect(NovaRegistry.snapshots('HKND')).toHaveLength(0);
    // Restore brings the last boot's state back after a destructive write.
    const id = boots[0].id;
    NovaRegistry.remove('HKNU/boot', { recursive: true });
    NovaRegistry.restoreSnapshot('HKNU', id);
    expect(NovaRegistry.get('HKNU/boot/keep')).toBe('me');
    Reg = NovaRegistry;
  });
});

describe('AstroOS Registry engine v2 — legacy settings import', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('copies unmapped settings into HKNU/legacy exactly once', () => {
    const settings = new Map([['clockFormat', '24h'], ['username', 'nova']]);
    const get = (key) => settings.get(key);
    expect(Reg.migrateLegacySettings(get, ['clockFormat', 'username', 'absent-key'])).toBe(2);
    expect(Reg.get('HKNU/legacy/clockFormat')).toBe('24h');
    expect(Reg.get('HKNU/legacy/username')).toBe('nova');
    expect(Reg.stat('HKNU/legacy/absent-key')).toBeNull();
    // Second run is a no-op (guarded by the HKND marker).
    settings.set('clockFormat', '12h');
    expect(Reg.migrateLegacySettings(get, ['clockFormat'])).toBe(0);
    expect(Reg.get('HKNU/legacy/clockFormat')).toBe('24h');
    expect(Reg.stat('HKND/_migration/legacySettingsDone')).not.toBeNull();
  });
});

describe('AstroOS Registry engine v2 — settings schema & legacy adoption', () => {
  let Reg, bus;
  beforeEach(() => {
    ({ Reg, bus } = freshRegistry());
  });

  it('maps every OS settings key to its canonical hive path', () => {
    expect(Reg.SETTINGS_KEY_TO_PATH.theme).toBe('HKNS/shell/theme');
    expect(Reg.SETTINGS_KEY_TO_PATH.pinnedApps).toBe('HKNU/desktop/pins');
    expect(Reg.SETTINGS_KEY_TO_PATH.defaultApps).toBe('HKNU/shell/defaultApps');
    expect(Reg.SETTINGS_KEY_TO_PATH.osVersion).toBe('HKNS/system/osVersion');
    expect(Reg.SETTINGS_KEY_TO_PATH.devMode).toBe('HKNS/system/devMode');
    // Multi-user account redesign: credential keys left the settings map —
    // lockPin/pinSalt/biometricCredentialId live in the server's users.db and
    // the account record owns identity, so `username` is unmapped too.
    expect(Reg.SETTINGS_KEY_TO_PATH.lockPin).toBeUndefined();
    expect(Reg.SETTINGS_KEY_TO_PATH.pinSalt).toBeUndefined();
    expect(Reg.SETTINGS_KEY_TO_PATH.biometricCredentialId).toBeUndefined();
    expect(Reg.SETTINGS_KEY_TO_PATH.username).toBeUndefined();
    expect(Reg.SETTINGS_KEY_TO_PATH.prohibitWallpaperChange).toBe('HKNS/security/policy/prohibitWallpaperChange');
    expect(Reg.SETTINGS_KEY_TO_PATH.clockFormat).toBe('HKNU/settings/clockFormat');
  });

  it('resolves paths: mapped keys win, excluded keys return null, unknown keys file under HKNU/settings', () => {
    expect(Reg.settingsPathFor('theme')).toBe('HKNS/shell/theme');
    expect(Reg.settingsPathFor('pinnedApps')).toBe('HKNU/desktop/pins');
    // Retired credential keys are unmapped: they file under HKNU/settings/*
    // (empty by default — the migration deletes the legacy values) instead of
    // the old HKNS/security credential paths.
    expect(Reg.settingsPathFor('lockPin')).toBe('HKNU/settings/lockPin');
    expect(Reg.settingsPathFor('customWallpaper')).toBeNull();
    expect(Reg.SETTINGS_EXCLUDED_KEYS.has('customWallpaper')).toBe(true);
    expect(Reg.settingsPathFor('someFuturePref')).toBe('HKNU/settings/someFuturePref');
    // Path separators in runtime keys can never escape the settings area.
    expect(Reg.settingsPathFor('weird/key')).toBe('HKNU/settings/weird_key');
  });

  it('maps registry paths back to settings keys, including the generic areas', () => {
    expect(Reg.pathToSettingsKey('HKNS/shell/theme')).toBe('theme');
    expect(Reg.pathToSettingsKey('HKNS/shell/wallpaper')).toBe('wallpaperId');
    expect(Reg.pathToSettingsKey('HKNU/desktop/pins')).toBe('pinnedApps');
    expect(Reg.pathToSettingsKey('HKNU/settings/clockFormat')).toBe('clockFormat');
    expect(Reg.pathToSettingsKey('HKNS/system/osVersion')).toBe('osVersion');
    expect(Reg.pathToSettingsKey('HKNS/security/pinSalt')).toBe('pinSalt');
    expect(Reg.pathToSettingsKey('HKNS/security/policy/prohibitWallpaperChange')).toBe('prohibitWallpaperChange');
    // Non-settings paths return null (app config, links, unknown areas).
    expect(Reg.pathToSettingsKey('HKNA/com.app/volume')).toBeNull();
    expect(Reg.pathToSettingsKey('HKNS/shell/theme/subkey')).toBeNull();
    expect(Reg.pathToSettingsKey('HKNU/settings')).toBeNull();
  });

  it('adopts legacy settings into their LIVE paths exactly once, overriding boot seeds', () => {
    Reg.ensureDefaults(Reg.BOOT_DEFAULTS); // seeds theme 'nova-dark' first
    const store = new Map([['theme', 'dracula'], ['clockFormat', '24h'], ['customWallpaper', 'data:huge'], ['pinnedApps', ['com.astroos.files']]]);
    const get = (key) => store.get(key);

    const adopted = Reg.adoptLegacySettings(get, [...store.keys()]);
    expect(adopted).toBe(3); // customWallpaper is excluded — never enters the hive
    expect(Reg.get('HKNS/shell/theme')).toBe('dracula'); // adoption beats the seed
    expect(Reg.get('HKNU/settings/clockFormat')).toBe('24h');
    expect(Reg.get('HKNU/desktop/pins')).toEqual(['com.astroos.files']);
    expect(Reg.stat('HKNU/settings/customWallpaper')).toBeNull();
    expect(Reg.stat('HKND/_migration/registrySourceDone')).not.toBeNull();

    // Second boot: guard holds — later legacy edits are ignored.
    store.set('theme', 'gruvbox');
    expect(Reg.adoptLegacySettings(get, ['theme'])).toBe(0);
    expect(Reg.get('HKNS/shell/theme')).toBe('dracula');
  });

  it('keeps adopting when one bad value throws — one key never aborts the batch', () => {
    const get = (key) => { if (key === 'bad') throw new Error('unreadable'); return 'ok-' + key; };
    expect(Reg.adoptLegacySettings(get, ['clockFormat', 'bad', 'username'])).toBe(2);
    expect(Reg.get('HKNU/settings/clockFormat')).toBe('ok-clockFormat');
    expect(Reg.get('HKNU/settings/username')).toBe('ok-username');
    expect(Reg.stat('HKND/_migration/registrySourceDone')).not.toBeNull();
  });

  it('fails soft on missing parents: remove/rename throw NOT_FOUND instead of crashing', () => {
    expect(() => Reg.remove('HKNU/ghost/child')).toThrow(/NOT_FOUND|no such key/);
    expect(() => Reg.rename('HKNU/ghost/child', 'renamed')).toThrow(/NOT_FOUND|no such key/);
  });
});
