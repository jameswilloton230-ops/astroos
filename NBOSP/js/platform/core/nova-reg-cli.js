/**
 * NovaByte — reg CLI — the reg.exe-flavored command line over the
 * NovaByte Registry engine.
 *
 * Loaded by the dev Console (com.nbosp.devconsole): a line starting with
 * `reg ` is routed here instead of eval(), and window.RegCLI stays exposed
 * for scripts. Pure string-in/string-out over the engine — no DOM, no IPC —
 * so it is fully unit-testable.
 *
 * Commands:
 *   reg query <path> [/s]                       list a key (/s = recurse)
 *   reg add <path> [/t type] /d data [/f]       set a value (auto-typed
 *                                               without /t; /f accepted
 *                                               for reg.exe familiarity)
 *   reg delete <path> [/f]                      delete a value or key
 *                                               (/f = recursive)
 *   reg export <path>                           .nvreg text (or JSON when
 *                                               NovaRegFile is unavailable)
 *   reg import <path> <json|nvreg text>         merge a subtree
 *   reg compare <pathA> <pathB>                 structural diff of subtrees
 *   reg acl <path>                              stored + effective ACL
 *   reg audit [n]                               last n audited writes
 *   reg snapshot <hive> save|list|restore|delete [args]
 *   reg types                                   the REG_* type list
 *
 * @module js/platform/core/nova-reg-cli
 */

const NovaRegCLI = (() => {
  'use strict';

  const USAGE = [
    'NovaByte Registry CLI (reg) — Windows reg.exe flavor over the NovaByte Registry.',
    '',
    '  reg query <path> [/s]                    list a key; /s recurses the subtree',
    '  reg add <path> [/t <type>] /d <data>     set a value (/t REG_SZ default-ish',
    '                                           auto-detect; /f accepted, no-op)',
    '  reg delete <path> [/f]                   delete a value or key (/f = recursive)',
    '  reg export <path>                        .nvreg text dump of a subtree',
    '  reg import <path> <json | .nvreg text>   merge a subtree (single line)',
    '  reg compare <pathA> <pathB>              diff two subtrees',
    '  reg acl <path>                           stored + effective ACL for a key',
    '  reg audit [n]                            the last n audited writes (default 15)',
    '  reg snapshot <hive> save <label> | list | restore <id> | delete <id>',
    '  reg types                                list the REG_* value types',
    '  reg help                                 this text',
    '',
    'Paths: HKNS\\shell\\theme — HKCU is an alias for HKNU. Bare key paths read',
    'and write the key\'s (default) value, Windows-style.',
  ].join('\n');

  function tokenize(line) {
    const tokens = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (!inQuotes && /\s/.test(ch)) {
        if (current) { tokens.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
  }

  function parseData(raw, type) {
    const text = String(raw);
    if (type === 'REG_SZ') return text;
    if (type === 'REG_EXPAND_SZ') return text;
    if (type === 'REG_MULTI_SZ') return text.split(',');
    if (type === 'REG_BOOL') {
      if (text === 'true') return true;
      if (text === 'false') return false;
      throw Object.assign(new Error('bool data must be true or false'), { code: 'INVALID_VALUE' });
    }
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      const value = /^0x[0-9a-fA-F]+$/.test(text) ? parseInt(text, 16) : Number(text);
      if (!Number.isFinite(value)) throw Object.assign(new Error('not a number: ' + text), { code: 'INVALID_VALUE' });
      return value;
    }
    if (type === 'REG_BINARY') return text.replace(/\s+/g, '');
    if (type === 'REG_JSON') {
      try { return JSON.parse(text); } catch (err) {
        throw Object.assign(new Error('json data is not valid JSON'), { code: 'INVALID_VALUE' });
      }
    }
    // Auto-detect (no /t): mirror the engine's detectType plus json guess.
    if (/^-?\d+$/.test(text)) {
      const n = Number(text);
      if (n >= 0 && n <= 0xFFFFFFFF) return n;
      if (n >= 0) return n;
    }
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text.startsWith('{') || text.startsWith('[')) {
      try { return JSON.parse(text); } catch (_) { /* fall through */ }
    }
    return text;
  }

  function countNodes(node) {
    let count = Object.keys(node.values || {}).length;
    for (const child of Object.values(node.keys || {})) count += 1 + countNodes(child);
    return count;
  }

  function cmdQuery(engine, args) {
    const flags = args.filter((a) => a.startsWith('/'));
    const positional = args.filter((a) => !a.startsWith('/'));
    if (!positional.length) return 'ERROR: reg query needs a path (e.g. reg query HKNS\\shell)';
    const path = positional[0];
    const recurse = flags.some((f) => f.toLowerCase() === '/s');
    const isRoot = !/[\\/]/.test(path);
    const out = [];
    const emitKey = (keyPath, listing) => {
      out.push(`[${keyPath.replace(/\//g, '\\')}]`);
      if (listing.values['(default)']) {
        out.push(`    (default)    ${listing.values['(default)'].type}    ${preview(listing.values['(default)'].data)}`);
      }
      for (const name of Object.keys(listing.values).filter((n) => n !== '(default)').sort()) {
        const entry = listing.values[name];
        out.push(`    ${name}    ${entry.type}    ${preview(entry.data)}`);
      }
    };
    if (recurse) {
      // Whole-subtree dump: the recursive flavor of reg.exe query output.
      let dump;
      try { dump = engine.export(path); } catch (err) { return `ERROR: ${err.message}`; }
      out.push(`[${path.replace(/\//g, '\\')}]`);
      const walk = (node) => {
        for (const name of Object.keys(node.values || {}).filter((n) => n !== '(default)').sort()) {
          const entry = node.values[name];
          out.push(`    ${name}    ${entry.type}    ${preview(entry.data)}`);
        }
        if (node.values && node.values['(default)']) {
          out.push(`    (default)    ${node.values['(default)'].type}    ${preview(node.values['(default)'].data)}`);
        }
        for (const [name, child] of Object.entries(node.keys || {})) {
          out.push('');
          out.push(`[${path}/${name}]`.replace(/\//g, '\\'));
          walk(child);
        }
      };
      walk(dump);
      return out.join('\n').replace(/\n+$/, '');
    }
    const listing = engine.list(path);
    if (!listing) return `ERROR: no such key: ${path}`;
    emitKey(path, listing);
    if (listing.keys.length) {
      out.push('');
      out.push(`  subkeys (${listing.keys.length}): ${listing.keys.join(', ')}`);
    }
    return out.join('\n');
  }

  function preview(data, limit = 120) {
    let text;
    try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (_) { text = String(data); }
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function cmdAdd(engine, args) {
    const positional = [];
    let type = null;
    let data = null;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const lower = arg.toLowerCase();
      if (lower === '/t') { type = args[++i]; continue; }
      if (lower === '/d') { data = args[++i]; continue; }
      if (lower === '/f') continue; // reg.exe "force" — writes are already unconditional
      positional.push(arg);
    }
    if (!positional.length) return 'ERROR: reg add needs a path';
    if (data === null) return 'ERROR: reg add needs /d <data>';
    const path = positional[0];
    try {
      const value = type ? parseData(data, type) : parseData(data, null);
      const result = engine.set(path, value, {
        type: type || undefined,
        source: 'cli',
        actor: 'devconsole:reg',
      });
      // Live-apply mapped shell keys exactly like the sandbox handler and
      // the NovaReg editor do, so `reg add HKNS/shell/theme ...` repaints.
      const settingsKey = engine.SETTINGS_PATH_TO_KEY[result.path];
      if (settingsKey && typeof OS !== 'undefined' && OS?.settings?.set) {
        try { OS.settings.set(settingsKey, result.data); } catch (_) { /* non-fatal */ }
      }
      return `The operation completed successfully.\n    ${result.path}  (${result.type})`;
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  function cmdDelete(engine, args) {
    const positional = args.filter((a) => !a.startsWith('/'));
    const force = args.some((a) => a.toLowerCase() === '/f');
    if (!positional.length) return 'ERROR: reg delete needs a path';
    try {
      const result = engine.remove(positional[0], { recursive: force, source: 'cli', actor: 'devconsole:reg' });
      return `The operation completed successfully. (${result.removed})`;
    } catch (err) {
      if (err.code === 'SUBTREE_NOT_EMPTY') {
        return `ERROR: ${err.message}\nUse /f to delete recursively.`;
      }
      return `ERROR: ${err.message}`;
    }
  }

  function cmdExport(engine, args, regFile) {
    const positional = args.filter((a) => !a.startsWith('/'));
    if (!positional.length) return 'ERROR: reg export needs a path';
    try {
      const path = positional[0];
      const tree = engine.export(path);
      if (regFile) return regFile.stringify(path, tree);
      return JSON.stringify(tree, null, 2);
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  // `reg import` receives the RAW text after the command word, not the
  // tokenized arguments — JSON and .nvreg payloads are full of quotes and
  // spaces that a shell-style tokenizer would destroy.
  function cmdImportRaw(engine, rawText, regFile) {
    const trimmedAll = String(rawText || '').trim();
    const path = trimmedAll.split(/\s+/)[0];
    const raw = trimmedAll.slice(path.length).trim();
    if (!path || !raw) {
      return 'ERROR: reg import needs a path and inline data: reg import HKNS/shell {"keys":{},"values":{}}';
    }
    try {
      let tree;
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') && trimmed.includes('"values"')) {
        tree = JSON.parse(trimmed);
      } else if (regFile) {
        tree = regFile.parse(trimmed).tree;
      } else {
        tree = JSON.parse(trimmed);
      }
      const result = engine.import(path, tree, { source: 'cli', actor: 'devconsole:reg' });
      return `The operation completed successfully. Merged ${result.merged} value(s) into ${result.path}.`;
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  function cmdCompare(engine, args) {
    const positional = args.filter((a) => !a.startsWith('/'));
    if (positional.length < 2) return 'ERROR: reg compare needs two paths';
    const [aPath, bPath] = positional;
    let aTree; let bTree;
    try { aTree = engine.export(aPath); } catch (err) { return `ERROR: ${aPath}: ${err.message}`; }
    try { bTree = engine.export(bPath); } catch (err) { return `ERROR: ${bPath}: ${err.message}`; }
    const out = [];
    let diffCount = 0;
    const walk = (a, b, prefix) => {
      const aValues = a.values || {};
      const bValues = b.values || {};
      for (const name of Object.keys(aValues)) {
        if (!(name in bValues)) { out.push(`<only-in-A>  ${prefix}${name}  (${aValues[name].type})`); diffCount++; }
      }
      for (const name of Object.keys(bValues)) {
        if (!(name in aValues)) { out.push(`<only-in-B>  ${prefix}${name}  (${bValues[name].type})`); diffCount++; }
      }
      for (const name of Object.keys(aValues)) {
        if (name in bValues) {
          const same = JSON.stringify(aValues[name].data) === JSON.stringify(bValues[name].data)
            && aValues[name].type === bValues[name].type;
          if (!same) {
            out.push(`<different>  ${prefix}${name}\n    A: ${aValues[name].type} ${preview(aValues[name].data, 60)}\n    B: ${bValues[name].type} ${preview(bValues[name].data, 60)}`);
            diffCount++;
          }
        }
      }
      const aKeys = new Set(Object.keys(a.keys || {}));
      const bKeys = new Set(Object.keys(b.keys || {}));
      for (const name of aKeys) {
        if (!bKeys.has(name)) { out.push(`<only-in-A>  ${prefix}${name}\\  (key, ${countNodes((a.keys || {})[name])} nodes)`); diffCount++; continue; }
        walk(a.keys[name], b.keys[name], `${prefix}${name}/`);
      }
      for (const name of bKeys) {
        if (!aKeys.has(name)) { out.push(`<only-in-B>  ${prefix}${name}\\  (key, ${countNodes((b.keys || {})[name])} nodes)`); diffCount++; }
      }
    };
    walk(aTree, bTree, '');
    if (!diffCount) return `Trees are identical (${countNodes(aTree)} nodes each).`;
    out.unshift(`${diffCount} difference(s) between ${aPath} and ${bPath}:`, '');
    return out.join('\n');
  }

  function cmdAcl(engine, args) {
    const positional = args.filter((a) => !a.startsWith('/'));
    if (!positional.length) return 'ERROR: reg acl needs a key path';
    const path = positional[0];
    const out = [];
    let stored = null;
    let effective = null;
    try { stored = engine.getAcl(path); } catch (err) { return `ERROR: ${err.message}`; }
    try { effective = engine.effectiveAcl(path); } catch (_) { /* ignore */ }
    out.push(`ACL for ${path}`);
    if (!stored) {
      out.push('  stored: (none — base hive rules only)');
    } else {
      out.push(`  stored: owner=${stored.owner || '(none)'}`);
      for (const entry of stored.entries) {
        out.push(`    ${entry.id}  ${entry.rights.join(',') || 'none'}${entry.inherit ? '  [inherit]' : '  [this key only]'}`);
      }
    }
    if (effective) {
      out.push('  effective (inherited + own):');
      if (!effective.entries.length) out.push('    (no entries — engine grants everyone)');
      for (const entry of effective.entries) {
        out.push(`    ${entry.id}  ${entry.rights.join(',') || 'none'}`);
      }
    }
    return out.join('\n');
  }

  function cmdAudit(engine, args) {
    const n = args.length && /^\d+$/.test(args[0]) ? parseInt(args[0], 10) : 15;
    const entries = engine.audit(n);
    if (!entries.length) return '(audit ring is empty)';
    const out = [`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (newest first):`];
    for (const entry of entries) {
      out.push(`  ${new Date(entry.ts).toLocaleTimeString()}  ${entry.actor}  ${entry.action}  ${entry.path}`);
      if (entry.before !== null || entry.after !== null) {
        out.push(`      ${entry.before === null ? '∅' : entry.before} → ${entry.after === null ? '∅' : entry.after}`);
      }
    }
    return out.join('\n');
  }

  function cmdSnapshot(engine, args) {
    if (!args.length) return 'ERROR: reg snapshot <hive> save|list|restore|delete [args]';
    const hive = args[0].toUpperCase();
    const sub = (args[1] || 'list').toLowerCase();
    try {
      if (sub === 'save') {
        const snap = engine.saveSnapshot(hive, args.slice(2).join(' ') || 'cli', { actor: 'devconsole:reg' });
        return `Snapshot ${snap.id} saved (${snap.label}).`;
      }
      if (sub === 'list') {
        const snaps = engine.snapshots(hive);
        if (!snaps.length) return `(no snapshots of ${hive})`;
        const out = [`Snapshots of ${hive} (oldest first):`];
        for (const snap of snaps) {
          out.push(`  ${snap.id}  ${snap.label}  ${new Date(snap.ts).toLocaleString()}  ${Math.round(snap.bytes / 1024)} KB`);
        }
        return out.join('\n');
      }
      if (sub === 'restore') {
        if (!args[2]) return 'ERROR: reg snapshot <hive> restore <id>';
        const result = engine.restoreSnapshot(hive, args[2], { actor: 'devconsole:reg' });
        return `The operation completed successfully. ${result.path} restored from ${result.restored}.`;
      }
      if (sub === 'delete') {
        if (!args[2]) return 'ERROR: reg snapshot <hive> delete <id>';
        engine.deleteSnapshot(hive, args[2]);
        return 'The operation completed successfully.';
      }
      return `ERROR: unknown snapshot subcommand '${sub}' (save|list|restore|delete)`;
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  function run(line, engine, regFile) {
    if (!engine || typeof engine.list !== 'function') {
      return 'ERROR: the NovaByte Registry engine is not available.';
    }
    const raw = String(line || '').trim();
    const tokens = tokenize(raw);
    if (!tokens.length || tokens[0].toLowerCase() !== 'reg') return USAGE;
    const command = (tokens[1] || 'help').toLowerCase();
    const args = tokens.slice(2);
    switch (command) {
      case 'query': return cmdQuery(engine, args);
      case 'add': return cmdAdd(engine, args);
      case 'delete': return cmdDelete(engine, args);
      case 'export': return cmdExport(engine, args, regFile);
      case 'import': {
        // Raw text after the command — tokenizing would eat JSON quotes.
        const afterCommand = raw.replace(/^reg\s+import\s*/i, '');
        return cmdImportRaw(engine, afterCommand, regFile);
      }
      case 'compare': return cmdCompare(engine, args);
      case 'acl': return cmdAcl(engine, args);
      case 'audit': return cmdAudit(engine, args);
      case 'snapshot': return cmdSnapshot(engine, args);
      case 'types': return engine.VALUE_TYPES.join(', ');
      case 'help': return USAGE;
      default:
        return `ERROR: unknown reg command '${command}'.\n\n${USAGE}`;
    }
  }

  return { run, USAGE };
})();

if (typeof window !== 'undefined' && window) window.RegCLI = NovaRegCLI;
if (typeof module !== 'undefined' && module.exports) module.exports = NovaRegCLI;
