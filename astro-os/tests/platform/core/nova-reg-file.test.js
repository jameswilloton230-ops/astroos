import { describe, it, expect } from 'vitest';
import NovaRegFile from '../../../js/platform/core/nova-reg-file.js';

// The .nvreg text format: every value type round-trips through
// stringify → parse, quoting survives hostile strings, and malformed input
// fails with a line-numbered error instead of half a tree.

const SAMPLE_TREE = {
  keys: {
    sub: {
      keys: {
        deeper: { keys: {}, values: { leaf: { type: 'REG_BOOL', data: true } } },
        alias: { keys: {}, values: {}, link: 'HKNU/desktop' },
      },
      values: { inside: { type: 'REG_DWORD', data: 42 } },
    },
  },
  values: {
    '(default)': { type: 'REG_SZ', data: 'key default' },
    theme: { type: 'REG_SZ', data: 'nova-dark' },
    template: { type: 'REG_EXPAND_SZ', data: '%novaRoot%\\wall.png' },
    list: { type: 'REG_MULTI_SZ', data: ['one', 'two with "quotes"', 'back\\slash'] },
    flag: { type: 'REG_BOOL', data: false },
    count: { type: 'REG_DWORD', data: 4294967295 },
    big: { type: 'REG_QWORD', data: 9007199254740991 },
    cfg: { type: 'REG_JSON', data: { a: 1, b: ['x', 2], c: null } },
    blob: { type: 'REG_BINARY', data: 'aGVsbG8gd29ybGQ=' },
    empty: { type: 'REG_SZ', data: '' },
  },
};

describe('NovaRegFile (.nvreg text format)', () => {
  it('round-trips every value type through stringify → parse', () => {
    const text = NovaRegFile.stringify('HKNS\\shell', SAMPLE_TREE);
    const { tree } = NovaRegFile.parse(text);
    expect(tree.values['(default)']).toEqual({ type: 'REG_SZ', data: 'key default' });
    expect(tree.values.theme.data).toBe('nova-dark');
    expect(tree.values.template).toEqual({ type: 'REG_EXPAND_SZ', data: '%novaRoot%\\wall.png' });
    expect(tree.values.list.data).toEqual(['one', 'two with "quotes"', 'back\\slash']);
    expect(tree.values.flag).toEqual({ type: 'REG_BOOL', data: false });
    expect(tree.values.count).toEqual({ type: 'REG_DWORD', data: 4294967295 });
    expect(tree.values.big).toEqual({ type: 'REG_QWORD', data: 9007199254740991 });
    expect(tree.values.cfg.data).toEqual({ a: 1, b: ['x', 2], c: null });
    expect(tree.values.blob).toEqual({ type: 'REG_BINARY', data: 'aGVsbG8gd29ybGQ=' });
    expect(tree.values.empty.data).toBe('');
    expect(tree.keys.sub.values.inside.data).toBe(42);
    expect(tree.keys.sub.keys.deeper.values.leaf.data).toBe(true);
    // Links round-trip with '/' targets (engine shape).
    expect(tree.keys.sub.keys.alias).toMatchObject({ link: 'HKNU/desktop' });
  });

  it('produces reg-file-style sections and hex encoding', () => {
    const text = NovaRegFile.stringify('HKNS/shell', SAMPLE_TREE);
    expect(text).toContain('[HKNS\\shell]');
    expect(text).toContain('[HKNS\\shell\\sub]');
    expect(text).toContain('[HKNS\\shell\\sub\\deeper]');
    expect(text).toContain('"count"=dword:ffffffff');
    expect(text).toContain('"flag"=bool:false');
    expect(text).toContain('"blob"=hex:68,65,6c,6c,6f,20,77,6f,72,6c,64');
    expect(text).toContain('>alias=HKNU\\desktop');
    expect(text).toContain('@="key default"');
    // Comments and origin header.
    expect(text.startsWith('; nova registry format v1')).toBe(true);
  });

  it('feeds parsed trees straight into the engine import', async () => {
    const NovaRegistry = (await import('../../../js/platform/core/nova-registry.js')).default;
    NovaRegistry._internal.resetState();
    NovaRegistry.init({ storage: { loadAll: () => ({}), save: () => true }, events: null, logger: console });
    const text = NovaRegFile.stringify('HKNS\\shell', SAMPLE_TREE);
    const { tree } = NovaRegFile.parse(text);
    const result = NovaRegistry.import('HKNS/shell/restored', tree);
    expect(result.merged).toBeGreaterThan(8);
    expect(NovaRegistry.get('HKNS/shell/restored/theme')).toBe('nova-dark');
    expect(NovaRegistry.get('HKNS/shell/restored/list')).toEqual(['one', 'two with "quotes"', 'back\\slash']);
    expect(NovaRegistry.get('HKNS/shell/restored/blob')).toBe('aGVsbG8gd29ybGQ=');
    // The link node came back as a working link.
    NovaRegistry.set('HKNU/desktop/taskbar', 'bottom');
    expect(NovaRegistry.list('HKNS/shell/restored/sub/alias').link).toBe('HKNU/desktop');
    expect(NovaRegistry.get('HKNS/shell/restored/sub/alias/taskbar')).toBe('bottom');
  });

  it('rejects malformed input with line numbers', () => {
    const bad = [
      ['[HKNS\\shell', 'unterminated section'],
      ['"x"=nope:1', 'unknown syntax'],
      ['[HKNS\\shell]\n"flag"=bool:maybe', 'bad bool'],
      ['[HKNS\\shell]\n"count"=dword:xyz', 'bad dword'],
      ['[HKNS\\shell]\n"cfg"=json:{nope', 'bad json'],
      ['[HKNS\\shell]\n"blob"=hex:zz', 'bad hex'],
      ['[HKNS\\shell]\n"multi"=multi:"a,"b"', 'bad multi'],
      ['hello', 'no section/value syntax'],
    ];
    for (const [text, why] of bad) {
      let err = null;
      try { NovaRegFile.parse(text); } catch (e) { err = e; }
      expect(err, why).not.toBeNull();
      expect(err.code, why).toBe('INVALID_VALUE');
      if (text.includes('\n')) expect(err.message, why).toMatch(/line \d+/);
    }
    // Empty input is INVALID_ARGS (no text at all to parse).
    try { NovaRegFile.parse(''); expect.unreachable(); }
    catch (err) { expect(err.code).toBe('INVALID_ARGS'); }
  });

  it('handles CRLF input, comment-only files, and out-of-root sections', () => {
    // The first section IS the root: its values land on tree.values.
    const { tree, root } = NovaRegFile.parse('[HKNS\\a]\r\n"x"="1"\r\n;y trailing comment\r\n');
    expect(root).toBe('HKNS/a');
    expect(tree.values.x).toEqual({ type: 'REG_SZ', data: '1' });
    const empty = NovaRegFile.parse('; nothing here\n');
    expect(empty.tree.keys).toEqual({});
    expect(empty.tree.values).toEqual({});
    // A later section that leaves the export root is rejected.
    let err = null;
    try { NovaRegFile.parse('[HKNS\\a]\n[HKNU\\b]\n'); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/outside the export root/);
  });
});
