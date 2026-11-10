/**
 * NovaByte — NovaReg File (.nvreg) — the registry's text interchange format.
 *
 * The Windows-registry analog of .reg files: a diffable, human-editable text
 * serialization of registry subtrees. NovaReg's Export/Import buttons and
 * the devconsole `reg export`/`reg import` commands both speak it (JSON
 * stays available as the machine-readable alternative).
 *
 * Format (v1):
 *
 *   ; comment lines start with a semicolon
 *   [HKNS\shell]
 *   @="the key's default value"          ; REG_SZ default (unnamed) value
 *   "theme"="nova-dark"                  ; REG_SZ
 *   "template"=expandz:"%novaRoot%\x"    ; REG_EXPAND_SZ
 *   "list"=multi:"a","b","c"             ; REG_MULTI_SZ
 *   "flag"=bool:true                     ; REG_BOOL
 *   "count"=dword:0000002a               ; REG_DWORD  (8 hex digits)
 *   "big"=qword:00000000000000ff         ; REG_QWORD (16 hex digits)
 *   "cfg"=json:{"a":1,"b":"x"}           ; REG_JSON (single line)
 *   "blob"=hex:68,65,6c,6c,6f            ; REG_BINARY (base64-decoded bytes)
 *   >shortcut=HKNU\desktop               ; REG_LINK key alias
 *
 *   [HKNS\shell\sub]
 *   ...
 *
 * Quoted strings escape \" \\ \n \t; everything after the type prefix for
 * json: is itself one quoted string holding compact JSON. The produced tree
 * matches the engine's export shape ({ keys, values }) so it feeds straight
 * into NovaRegistry.import().
 *
 * @module js/platform/core/nova-reg-file
 */

const NovaRegFile = (() => {
  'use strict';

  const FORMAT_HEADER = 'nova registry format v1';

  function regError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // ── escaping ───────────────────────────────────────────────────────────

  function quote(text) {
    return '"' + String(text)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t')
      .replace(/\r/g, '') + '"';
  }

  function unquote(text) {
    if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') {
      throw regError('INVALID_VALUE', `expected a quoted string, got: ${text.slice(0, 40)}`);
    }
    let out = '';
    for (let i = 1; i < text.length - 1; i++) {
      const ch = text[i];
      if (ch !== '\\') { out += ch; continue; }
      const next = text[++i];
      switch (next) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        default: out += next === undefined ? '\\' : next; break;
      }
    }
    return out;
  }

  // ── stringify ──────────────────────────────────────────────────────────

  function encodeValue(entry) {
    const type = entry.type || 'REG_SZ';
    const data = entry.data;
    switch (type) {
      case 'REG_SZ': return quote(data ?? '');
      case 'REG_EXPAND_SZ': return 'expandz:' + quote(data ?? '');
      case 'REG_MULTI_SZ': return 'multi:' + (Array.isArray(data) ? data : []).map(quote).join(',');
      case 'REG_BOOL': return 'bool:' + (data ? 'true' : 'false');
      case 'REG_DWORD': return 'dword:' + (data >>> 0).toString(16).padStart(8, '0');
      case 'REG_QWORD': return 'qword:' + BigInt(data || 0).toString(16).padStart(16, '0');
      case 'REG_JSON': {
        let text;
        try { text = JSON.stringify(data ?? null); } catch (_) {
          throw regError('INVALID_VALUE', 'value holds non-serializable JSON data');
        }
        return 'json:' + text;
      }
      case 'REG_BINARY': {
        let bytes = [];
        try {
          const bin = atob(String(data || ''));
          bytes = Array.from(bin, (ch) => ch.charCodeAt(0));
        } catch (_) {
          throw regError('INVALID_VALUE', 'value holds invalid base64 data');
        }
        return 'hex:' + bytes.map((b) => b.toString(16).padStart(2, '0')).join(',');
      }
      default:
        throw regError('INVALID_VALUE', `value has unknown type '${type}'`);
    }
  }

  function valueToLine(name, entry) {
    return `${quote(name)}=${encodeValue(entry)}`;
  }

  function nodeToLines(sectionPath, node, out) {
    // Values first (the default first when set, then sorted names), then
    // child sections. An absent default emits no line — importing must not
    // invent empty defaults for keys that never had one.
    const values = node.values || {};
    const names = Object.keys(values).filter((n) => n !== '(default)').sort();
    if (values['(default)']) out.push('@=' + encodeValue(values['(default)']));
    for (const name of names) out.push(valueToLine(name, values[name]));
    const keys = node.keys || {};
    for (const name of Object.keys(keys).sort()) {
      const child = keys[name] || {};
      if (child.link) {
        out.push(`>${name}=${String(child.link).replace(/\//g, '\\')}`);
        continue;
      }
      out.push('');
      out.push(`[${sectionPath}\\${name}]`);
      nodeToLines(`${sectionPath}\\${name}`, child, out);
    }
  }

  function stringify(path, tree) {
    const section = String(path || '').replace(/\//g, '\\').replace(/\\+$/, '');
    const out = [`; ${FORMAT_HEADER}`, `; origin: ${section}`, '', `[${section}]`];
    nodeToLines(section, tree && typeof tree === 'object' ? tree : { keys: {}, values: {} }, out);
    return out.join('\n') + '\n';
  }

  // ── parse ──────────────────────────────────────────────────────────────

  function parseValueLine(name, raw) {
    if (raw.startsWith('"')) return { type: 'REG_SZ', data: unquote(raw) };
    const colon = raw.indexOf(':');
    const bare = colon === -1 ? raw : raw.slice(0, colon);
    const rest = colon === -1 ? '' : raw.slice(colon + 1);
    switch (bare) {
      case 'expandz': return { type: 'REG_EXPAND_SZ', data: unquote(rest) };
      case 'multi': {
        // Comma-separated quoted strings.
        const items = [];
        let i = 0;
        while (i < rest.length) {
          if (rest[i] !== '"') throw regError('INVALID_VALUE', `multi: expects quoted strings (${name})`);
          let end = -1;
          for (let j = i + 1; j < rest.length; j++) {
            if (rest[j] === '\\') { j++; continue; }
            if (rest[j] === '"') { end = j; break; }
          }
          if (end === -1) throw regError('INVALID_VALUE', `unterminated string in multi: (${name})`);
          items.push(unquote(rest.slice(i, end + 1)));
          i = end + 1;
          if (rest[i] === ',') i++;
        }
        return { type: 'REG_MULTI_SZ', data: items };
      }
      case 'bool': {
        if (rest !== 'true' && rest !== 'false') throw regError('INVALID_VALUE', `bool: must be true or false (${name})`);
        return { type: 'REG_BOOL', data: rest === 'true' };
      }
      case 'dword': {
        if (!/^[0-9a-fA-F]{1,8}$/.test(rest)) throw regError('INVALID_VALUE', `dword: expects up to 8 hex digits (${name})`);
        return { type: 'REG_DWORD', data: parseInt(rest, 16) };
      }
      case 'qword': {
        if (!/^[0-9a-fA-F]{1,16}$/.test(rest)) throw regError('INVALID_VALUE', `qword: expects up to 16 hex digits (${name})`);
        return { type: 'REG_QWORD', data: Number(BigInt('0x' + rest)) };
      }
      case 'json': {
        // JSON payloads are written unquoted (single line); parse directly.
        try { return { type: 'REG_JSON', data: JSON.parse(rest) }; } catch (err) {
          throw regError('INVALID_VALUE', `json: is not valid JSON (${name})`);
        }
      }
      case 'hex': {
        const clean = rest.replace(/\s+/g, '');
        if (!/^[0-9a-fA-F]*(,[0-9a-fA-F]{2})*$/.test(clean) || clean === '') {
          throw regError('INVALID_VALUE', `hex: expects comma-separated bytes (${name})`);
        }
        const bytes = clean.split(',').map((h) => parseInt(h, 16));
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        return { type: 'REG_BINARY', data: btoa(bin) };
      }
      default:
        throw regError('INVALID_VALUE', `unknown value syntax '${bare}' (${name})`);
    }
  }

  function parse(text) {
    if (typeof text !== 'string' || !text.trim()) {
      throw regError('INVALID_ARGS', 'registry text is empty');
    }
    const root = { keys: {}, values: {} };
    let section = root;
    let rootSegments = null;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const no = index + 1;
      let line = lines[index].trim();
      if (!line || line.startsWith(';')) continue;
      if (line.startsWith('[')) {
        if (!line.endsWith(']')) throw regError('INVALID_VALUE', `line ${no}: unterminated section header`);
        const rawPath = line.slice(1, -1).trim();
        const segments = rawPath.split('\\').map((s) => s.trim()).filter(Boolean);
        if (!segments.length) throw regError('INVALID_VALUE', `line ${no}: empty section header`);
        // The FIRST header defines the export root (engine export shape:
        // values at the root, keys below); later headers must stay inside
        // it and address their node relative to it.
        if (!rootSegments) {
          rootSegments = segments;
          section = root;
          continue;
        }
        if (segments.length < rootSegments.length ||
            rootSegments.some((seg, i) => seg !== segments[i])) {
          throw regError('INVALID_VALUE', `line ${no}: section '${rawPath}' is outside the export root`);
        }
        section = root;
        for (const seg of segments.slice(rootSegments.length)) {
          if (!section.keys[seg]) section.keys[seg] = { keys: {}, values: {} };
          section = section.keys[seg];
        }
        continue;
      }
      if (line.startsWith('>')) {
        const eq = line.indexOf('=');
        if (eq === -1) throw regError('INVALID_VALUE', `line ${no}: link needs a target`);
        const name = line.slice(1, eq).trim();
        const target = line.slice(eq + 1).trim().replace(/\\+/g, '/');
        if (!name || !target) throw regError('INVALID_VALUE', `line ${no}: link needs a name and a target`);
        section.keys[name] = { keys: {}, values: {}, link: target };
        continue;
      }
      let name = '(default)';
      let rest = line;
      if (line.startsWith('@=')) {
        rest = line.slice(2);
      } else if (line.startsWith('"')) {
        // Find the closing quote of the value name (honor \").
        let end = -1;
        for (let j = 1; j < line.length; j++) {
          if (line[j] === '\\') { j++; continue; }
          if (line[j] === '"') { end = j; break; }
        }
        if (end === -1) throw regError('INVALID_VALUE', `line ${no}: unterminated value name`);
        name = unquote(line.slice(0, end + 1));
        if (line[end + 1] !== '=') throw regError('INVALID_VALUE', `line ${no}: expected '=' after the value name`);
        rest = line.slice(end + 2);
      } else {
        throw regError('INVALID_VALUE', `line ${no}: expected a section, @, quoted name, or link`);
      }
      try {
        section.values[name] = parseValueLine(name, rest);
      } catch (err) {
        if (err && /line \d+/.test(err.message)) throw err;
        throw regError((err && err.code) || 'INVALID_VALUE', `line ${no}: ${err.message}`);
      }
    }
    return { tree: root, root: rootSegments ? rootSegments.join('/') : null };
  }

  const api = { FORMAT_HEADER, stringify, parse };
  if (typeof window !== 'undefined' && window) window.NovaRegFile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
