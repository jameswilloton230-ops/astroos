import { describe, it, expect, beforeEach } from 'vitest';
import NovaRegistry from '../../../js/platform/core/nova-registry.js';
import NovaRegFile from '../../../js/platform/core/nova-reg-file.js';
import RegCLI from '../../../js/platform/core/nova-reg-cli.js';

// The reg CLI is pure string-in/string-out over the real engine, so every
// command is exercised end-to-end here exactly as the dev Console runs it.

function freshEngine() {
  NovaRegistry._internal.resetState();
  const store = new Map();
  const storage = {
    loadAll() {
      const out = {};
      for (const name of [...NovaRegistry.HIVES, 'AUDIT', 'SNAPSHOTS']) {
        out[name] = store.has(name) ? JSON.parse(store.get(name)) : null;
      }
      return out;
    },
    save(name, data) { store.set(name, JSON.stringify(data)); },
  };
  NovaRegistry.init({ storage, events: null, logger: console });
  return NovaRegistry;
}

describe('reg CLI (js/platform/core/nova-reg-cli.js)', () => {
  let engine;
  beforeEach(() => {
    engine = freshEngine();
  });

  const run = (line) => RegCLI.run(line, engine, NovaRegFile);

  it('prints usage for bare `reg`, `reg help` and unknown commands', () => {
    expect(run('reg')).toBe(RegCLI.USAGE);
    expect(run('reg help')).toBe(RegCLI.USAGE);
    expect(run('reg frobnicate')).toMatch(/unknown reg command 'frobnicate'/);
  });

  it('adds, queries and deletes values with auto-typing and explicit types', () => {
    expect(run('reg add HKNU/cli/volume /d 80')).toMatch(/completed successfully/);
    expect(engine.get('HKNU/cli/volume')).toBe(80);
    expect(engine.stat('HKNU/cli/volume').type).toBe('REG_DWORD');

    expect(run('reg add HKNU/cli/flags /t REG_BOOL /d true')).toMatch(/completed successfully/);
    expect(engine.get('HKNU/cli/flags')).toBe(true);

    expect(run('reg add HKNU/cli/hex /t REG_DWORD /d 0xff')).toMatch(/completed successfully/);
    expect(engine.get('HKNU/cli/hex')).toBe(255);

    expect(run('reg add HKNU/cli/missing')).toMatch(/needs \/d/);
    expect(run('reg add HKNU/cli/bad /t REG_BOOL /d maybe')).toMatch(/ERROR: bool data/);

    const out = run('reg query HKNU/cli');
    expect(out).toMatch(/\[HKNU\\cli\]/);
    expect(out).toContain('volume');
    expect(out).toContain('REG_DWORD');

    // Bare key path = the key's default value (engine v2 semantics).
    engine.set('HKNU/cli/sub/child', 1, { type: 'REG_DWORD' });
    expect(run('reg add HKNU/cli/sub /d key-default')).toMatch(/completed successfully/);
    expect(engine.get('HKNU/cli/sub')).toBe('key-default');
    const withDefault = run('reg query HKNU/cli/sub');
    expect(withDefault).toContain('(default)');

    expect(run('reg delete HKNU/cli/volume')).toMatch(/completed successfully. \(value\)/);
    expect(engine.stat('HKNU/cli/volume')).toBeNull();
    // Recursive delete needs /f.
    expect(run('reg delete HKNU/cli/sub')).toMatch(/Use \/f/);
    expect(run('reg delete HKNU/cli/sub /f')).toMatch(/completed successfully. \(key\)/);
  });

  it('queries recursively with /s', () => {
    engine.set('HKNS/deep/a/one', '1');
    engine.set('HKNS/deep/a/two', '2');
    engine.set('HKNS/deep/b/three', '3');
    const out = run('reg query HKNS/deep /s');
    expect(out).toContain('[HKNS\\deep]');
    expect(out).toContain('[HKNS\\deep\\a]');
    expect(out).toContain('[HKNS\\deep\\b]');
    expect(out).toContain('three');
    expect(run('reg query HKNS/missing')).toMatch(/no such key/);
  });

  it('exports as .nvreg and imports both JSON and .nvreg text', () => {
    engine.set('HKNA/com.cli/state/level', 3, { type: 'REG_DWORD' });
    engine.set('HKNA/com.cli/state/name', 'cli');
    const dump = run('reg export HKNA/com.cli/state');
    expect(dump).toContain('[HKNA\\com.cli\\state]');
    expect(dump).toContain('"level"=dword:00000003');

    // JSON import round-trip.
    const json = JSON.stringify(NovaRegFile.parse(dump).tree);
    expect(run(`reg import HKNA/com.cli/restored ${json}`)).toMatch(/Merged 2 value\(s\)/);
    expect(engine.get('HKNA/com.cli/restored/level')).toBe(3);
    expect(engine.get('HKNA/com.cli/restored/name')).toBe('cli');

    // .nvreg import (multi-line — the console textarea accepts Shift+Enter).
    expect(run('reg import HKNA/com.cli/nv [HKNA\\x]\n"v"="1"')).toMatch(/Merged 1 value\(s\)/);
    expect(engine.get('HKNA/com.cli/nv/v')).toBe('1');

    expect(run('reg import HKNA/com.cli')).toMatch(/needs a path and inline data/);
    expect(run('reg import HKNA/com.cli [HKNS\\x] "v"=nope:1')).toMatch(/ERROR: line 1/);
  });

  it('compares two subtrees structurally', () => {
    engine.set('HKNU/cmpA/shared', 'same');
    engine.set('HKNU/cmpA/onlyA', 'x');
    engine.set('HKNU/cmpB/shared', 'same');
    engine.set('HKNU/cmpB/onlyB', 'y');
    const out = run('reg compare HKNU/cmpA HKNU/cmpB');
    expect(out).toMatch(/2 difference\(s\)/);
    expect(out).toContain('<only-in-A>');
    expect(out).toContain('<only-in-B>');
    // Identical trees.
    engine.set('HKNU/cmpB/onlyA', 'x');
    engine.set('HKNU/cmpA/onlyB', 'y');
    expect(run('reg compare HKNU/cmpA HKNU/cmpB')).toMatch(/identical/);
    expect(run('reg compare HKNU/cmpA')).toMatch(/needs two paths/);
  });

  it('reports ACLs, audit entries, snapshots and types', () => {
    engine.set('HKNU/acl-target/k', 1);
    engine.setAcl('HKNU/acl-target', { owner: 'com.owner', entries: [{ id: 'com.owner', rights: ['read', 'write'] }, { id: '*', rights: ['read'] }] });
    const acl = run('reg acl HKNU/acl-target');
    expect(acl).toContain('owner=com.owner');
    expect(acl).toContain('com.owner  read,write');
    expect(acl).toContain('effective');

    engine.set('HKNU/audited', 'value', { actor: 'com.probe' });
    const audit = run('reg audit 5');
    expect(audit).toMatch(/entr/);
    expect(audit).toContain('com.probe');

    const snap = run('reg snapshot HKNU save cli-test');
    expect(snap).toMatch(/Snapshot snap_\w+ saved/);
    const list = run('reg snapshot HKNU list');
    expect(list).toContain('cli-test');
    const id = engine.snapshots('HKNU')[0].id;
    engine.set('HKNU/audited', 'changed');
    expect(run(`reg snapshot HKNU restore ${id}`)).toMatch(/completed successfully/);
    expect(engine.get('HKNU/audited')).toBe('value');
    expect(run(`reg snapshot HKNU delete ${id}`)).toMatch(/completed successfully/);
    expect(run('reg snapshot HKNU list')).toMatch(/no snapshots/);
    expect(run('reg snapshot HKNU bogus')).toMatch(/unknown snapshot subcommand/);

    expect(run('reg types')).toContain('REG_EXPAND_SZ');
    // The HKCU alias works through the CLI too.
    expect(run('reg add HKCU/cli-via-alias /d yes')).toMatch(/completed successfully/);
    expect(engine.get('HKNU/cli-via-alias')).toBe('yes');
  });

  it('reports an unavailable engine cleanly', () => {
    expect(RegCLI.run('reg query HKNS', null, NovaRegFile)).toMatch(/engine is not available/);
  });
});
