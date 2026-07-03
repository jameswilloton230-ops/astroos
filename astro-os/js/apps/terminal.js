'use strict';

// NovaByte OS Terminal app.
// Registers itself with the host OS via the global registerApp() entry point.
// All DOM output is rendered through createEl / writeLine / writeHTML so the
// visual output matches the original implementation byte-for-byte.
// The rewrite is great thing btw we had lots of issues with complex whatever its called commands, its just a way more efficent way to build upon it without worrying about effiency or issues i think, so good luck i guess, spent 7 bloody fucking hours of my life btw so dont misuse this app [DELETE THIS LINE IN PRODUCTION]

// App bundle id used for the AppDirs runtime guard.
const APP_BUNDLE_ID = 'com.nbosp.shell';

// Builtin command names. Shared between `help`, `which`, and tab completion.
// Frozen so we can safely reuse one instance per tab without defensive copies.
const BUILTINS = Object.freeze([
  'ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'touch', 'cat', 'head', 'tail',
  'wc', 'grep', 'sort', 'uniq', 'cut', 'find', 'tree', 'diff', 'stat', 'chmod',
  'cp', 'mv', 'echo', 'printf', 'base64', 'date', 'sleep', 'yes', 'seq', 'expr',
  'true', 'false', 'env', 'export', 'unset', 'alias', 'unalias', 'which',
  'hostname', 'whoami', 'uname', 'uptime', 'history', 'clear', 'ps', 'kill',
  'neofetch', 'fastfetch', 'help', 'exit'
]);
// Set lookup is O(1) — used by `which`. The original rebuilt the array each call.
const BUILTINS_SET = new Set(BUILTINS);

// Safety caps so a typo can't wedge the tab or exhaust memory.
const MAX_HISTORY = 500;
const YES_LINE_CAP = 25;
const SEQ_LINE_CAP = 1000;
const SLEEP_MAX_SECONDS = 30;
const TREE_MAX_DEPTH = 5;

// Aliases shipped with every new tab. Frozen so they're shared by reference.
const DEFAULT_ALIASES = Object.freeze({
  ll: 'ls -la',
  la: 'ls -a',
  l: 'ls -lh',
  cls: 'clear',
  md: 'mkdir',
  rd: 'rmdir',
  ff: 'fastfetch'
});

function makeDefaultVariables(username) {
  return {
    HOME: '/Desktop',
    USER: username,
    HOSTNAME: 'novabyteOS',
    SHELL: '/bin/sh',
    TERM: 'xterm-256color',
    PATH: '/bin:/usr/bin:/usr/local/bin'
  };
}

// --- Runtime helper fallbacks -------------------------------------------------
// NovaByte OS exposes escapeText / formatBytes / safeEvaluateArithmetic /
// renderDesktopIcons as globals. We provide safe local fallbacks so the file
// degrades gracefully if a future runtime drops one of them, and so it can be
// unit-tested in isolation.

function escapeHtml(text) {
  if (typeof window.escapeText === 'function') return window.escapeText(text);
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytesLocal(bytes) {
  if (typeof window.formatBytes === 'function') return window.formatBytes(bytes);
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes || 1) / 10));
  const value = bytes / 2 ** (i * 10);
  return `${i === 0 ? value : value.toFixed(1)}${units[i]}`;
}

// No-eval arithmetic evaluator (shunting-yard). Used by `expr`.
// Throws SyntaxError on malformed input; callers catch and report.
function evalArithmetic(expr) {
  if (typeof window.safeEvaluateArithmetic === 'function') {
    return window.safeEvaluateArithmetic(expr);
  }
  const tokens = expr.match(/\d+|[+\-*\/%()]/g);
  if (!tokens) throw new SyntaxError('empty expression');
  const output = [];
  const ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      output.push(parseInt(t, 10));
    } else if (t === '(') {
      ops.push(t);
    } else if (t === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') output.push(ops.pop());
      if (!ops.length) throw new SyntaxError('mismatched parentheses');
      ops.pop();
    } else {
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t]) {
        output.push(ops.pop());
      }
      ops.push(t);
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === '(' || op === ')') throw new SyntaxError('mismatched parentheses');
    output.push(op);
  }
  const stack = [];
  for (const t of output) {
    if (typeof t === 'number') {
      stack.push(t);
    } else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new SyntaxError('missing operand');
      switch (t) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/': stack.push(b === 0 ? 0 : Math.trunc(a / b)); break;
        case '%': stack.push(b === 0 ? 0 : a % b); break;
      }
    }
  }
  if (stack.length !== 1) throw new SyntaxError('invalid expression');
  return stack[0];
}

// UTF-8 safe base64. Prefers ES2026 Uint8Array methods when available,
// falls back to TextEncoder + btoa/atob (still UTF-8 safe).
function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64(b64) {
  const trimmed = b64.trim();
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') {
    bytes = Uint8Array.fromBase64(trimmed);
  } else {
    const bin = atob(trimmed);
    bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  }
  return new TextDecoder().decode(bytes);
}

function refreshDesktop() {
  // Optional global provided by the OS desktop. No-op if absent.
  if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
}

// --- Tokenising & parsing -----------------------------------------------------
// These replace the original quote-blind splitters. The originals used
// String.prototype.includes + String.prototype.split, which broke on any line
// containing a quoted operator (e.g. `echo "a;b"`, `grep ">" file`).

// POSIX-ish tokeniser. Single quotes are literal; double quotes allow
// \" \\ \$ \` escapes; backslash outside quotes escapes the next character.
function tokenize(line) {
  const tokens = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
    } else if (inDouble) {
      if (ch === '\\') {
        const next = line[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next;
          i += 2;
          continue;
        }
        cur += ch;
      } else if (ch === '"') {
        inDouble = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '\\') {
      const next = line[i + 1];
      if (next !== undefined) {
        cur += next;
        i += 2;
        continue;
      }
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
    i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Quote-and-escape-aware split on a literal operator string (e.g. '|', '&&').
function splitOnOperator(line, operator) {
  const segments = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      cur += ch;
    } else if (inDouble) {
      if (ch === '\\') {
        cur += ch + (line[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === '"') inDouble = false;
      cur += ch;
    } else if (ch === "'") {
      inSingle = true;
      cur += ch;
    } else if (ch === '"') {
      inDouble = true;
      cur += ch;
    } else if (ch === '\\') {
      cur += ch + (line[i + 1] ?? '');
      i += 2;
      continue;
    } else if (line.startsWith(operator, i)) {
      segments.push(cur);
      cur = '';
      i += operator.length;
      continue;
    } else {
      cur += ch;
    }
    i++;
  }
  segments.push(cur);
  return segments;
}

function splitPipes(line) {
  return splitOnOperator(line, '|').map(s => s.trim()).filter(Boolean);
}

// Finds the first chain operator (;, &&, ||) outside quotes/escapes.
// Returns { op, before, after } or null. The scan is left-to-right, so the
// leftmost operator wins — this matches the original's split-all behaviour
// because both process the line left-to-right recursively.
function findChainOperator(line) {
  const ops = ['&&', '||', ';'];
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '\\') {
      i += 2;
      continue;
    } else {
      for (const op of ops) {
        if (line.startsWith(op, i)) {
          return { op, before: line.slice(0, i), after: line.slice(i + op.length) };
        }
      }
    }
    i++;
  }
  return null;
}

// Finds the first unquoted `>` redirect. Returns { before, after } or null.
function findRedirect(line) {
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
    } else if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '\\') {
      i += 2;
      continue;
    } else if (ch === '>') {
      return { before: line.slice(0, i), after: line.slice(i + 1) };
    }
    i++;
  }
  return null;
}

// Glob → RegExp for `find -name`. Supports `*` (non-slash run) and `?`
// (single non-slash). Everything else is escaped so user-supplied names can't
// inject regex metacharacters.
function globToRegExp(pattern) {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

// --- Output helpers -----------------------------------------------------------
// Each helper appends one element and scrolls to bottom. Keeping the scroll
// here means callers don't have to remember to do it.

function scrollOutput(tab) {
  tab.output.scrollTop = tab.output.scrollHeight;
}

function getPromptStr(tab) {
  const path = FS.getPath(tab.cwd).replace(/^\/Desktop/, '~');
  return `<span class="shell-green">${escapeHtml(OS.username)}</span>:<span class="shell-blue">${escapeHtml(path)}</span>$ `;
}

function updatePrompt(tab) {
  tab.prompt.innerHTML = getPromptStr(tab);
}

function writeLine(tab, text, cls) {
  const d = createEl('div');
  if (cls) d.className = cls;
  d.textContent = text;
  tab.output.appendChild(d);
  scrollOutput(tab);
}

function writeHTML(tab, html) {
  const d = createEl('div');
  d.innerHTML = html;
  tab.output.appendChild(d);
  scrollOutput(tab);
}

function writePromptLine(tab, cmd) {
  const d = createEl('div');
  d.innerHTML = getPromptStr(tab) + escapeHtml(cmd);
  tab.output.appendChild(d);
  scrollOutput(tab);
}

function clearOutput(tab) {
  tab.output.innerHTML = '';
}

function welcomeTab(tab) {
  writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span>  <span class="shell-dim">NovaByte ${escapeHtml(OS.version)} — ${escapeHtml(OS.username)}@novabyteOS</span>`);
  writeHTML(tab, `<span class="shell-dim">Type <span class="shell-green">help</span> for commands  ·  <span class="shell-green">Tab</span> autocomplete  ·  <span class="shell-green">Ctrl+Shift+T</span> new tab</span>`);
  writeLine(tab, '');
}

// --- Tab completion -----------------------------------------------------------

function getCompletions(tab, partial) {
  const files = FS.listDir(tab.cwd).map(f => f.name + (f.type === 'folder' ? '/' : ''));
  return [...BUILTINS, ...files].filter(c => c.startsWith(partial));
}

// --- Path resolver ------------------------------------------------------------
// Preserves the original's subtle asymmetry: `..` at root from an absolute
// path stays at root; `..` past root from a relative path returns false.

function resolvePath(cwd, arg) {
  if (!arg || arg === '~') return FS.specialFolders.desktop;
  if (arg === '.') return cwd;
  const isAbsolute = arg.startsWith('/');
  const parts = arg.split('/').filter(Boolean);
  let node = isAbsolute ? FS.rootId : cwd;
  for (const part of parts) {
    if (part === '..') {
      const n = FS.files.get(node);
      if (n && n.parentId) {
        node = n.parentId;
      } else if (!isAbsolute) {
        return false;
      }
      // Absolute path at root: stay (original behaviour).
    } else if (part !== '.') {
      const ch = FS.listDir(node);
      const found = ch.find(c => c.name === part && c.type === 'folder');
      if (!found) return false;
      node = found.id;
    }
  }
  return node;
}

// --- Command implementations --------------------------------------------------
// Each command is (tab, args, pipeIn) => string | Promise<string>.
// Returning a string sends it through writeLine (textContent — XSS-safe).
// Commands that need coloured output call writeHTML directly and return ''.

const COMMANDS = {
  help(tab) {
    const sections = [
      ['Filesystem', 'ls  ll  la  l  cd  pwd  mkdir  rmdir  rm  touch  cp  mv  cat  head  tail  stat  chmod  find  tree  diff'],
      ['Text', 'echo  printf  grep  sort  uniq  cut  wc  base64'],
      ['System', 'clear  history  env  export  unset  alias  unalias  which  hostname  whoami  uname  uptime  date  ps  kill  sleep'],
      ['Math', 'expr  seq'],
      ['Fun', 'neofetch  fastfetch  yes  true  false  exit']
    ];
    writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span> <span class="shell-dim">— ${escapeHtml(OS.username)}@novabyteOS</span>`);
    for (const [s, cmds] of sections) {
      writeHTML(tab, `  <span class="shell-yellow">${s}:</span> <span class="shell-dim">${cmds}</span>`);
    }
    writeHTML(tab, `\n  <span class="shell-dim">Shortcuts: <span class="shell-green">Tab</span>=autocomplete  <span class="shell-green">↑↓</span>=history  <span class="shell-green">Ctrl+L</span>=clear  <span class="shell-green">Ctrl+C</span>=cancel  <span class="shell-green">Ctrl+Shift+T</span>=new tab</span>`);
    return '';
  },

  clear(tab) { clearOutput(tab); return ''; },
  exit() { return 'Use the window close button to exit.'; },
  true() { return ''; },
  false() { return 'Error: false returned exit code 1'; },
  pwd(tab) { return FS.getPath(tab.cwd); },
  whoami() { return OS.username; },
  hostname(tab, args) { return args.includes('-f') ? 'novabyteOS.local' : 'novabyteOS'; },
  date(tab, args) { return args.includes('-u') ? new Date().toUTCString() : new Date().toString(); },

  uptime() {
    const ms = performance.now();
    const hours = Math.floor(ms / 3600000);
    const mins = Math.floor(ms / 60000) % 60;
    return `up  ${hours}:${String(mins).padStart(2, '0')}, load average: 0.08 0.10 0.09`;
  },

  uname(tab, args) {
    if (args.includes('-a')) return `NovaKernel novabyteOS 5.15.0-nova #1 SMP ${new Date().toDateString()} x86_64 GNU/NovaByte`;
    if (args.includes('-r')) return '5.15.0-nova';
    if (args.includes('-m')) return 'x86_64';
    if (args.includes('-s')) return 'NovaKernel';
    if (args.includes('-n')) return 'novabyteOS';
    return 'NovaKernel';
  },

  env(tab, args, pipeIn) {
    if (args[0]) {
      const [k, ...v] = args[0].split('=');
      if (v.length) {
        tab.variables[k] = v.join('=');
        return execOne(tab, args.slice(1).join(' '), pipeIn);
      }
    }
    return Object.entries(tab.variables).map(([k, v]) => `${k}=${v}`).join('\n');
  },

  export(tab, args) {
    if (!args[0]) {
      return Object.entries(tab.variables).map(([k, v]) => `declare -x ${k}="${v}"`).join('\n');
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq > 0) tab.variables[a.slice(0, eq)] = a.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    return '';
  },

  unset(tab, args) {
    for (const a of args) delete tab.variables[a];
    return '';
  },

  alias(tab, args) {
    if (!args[0]) {
      return Object.entries(tab.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n');
    }
    const eq = args[0].indexOf('=');
    if (eq > 0) tab.aliases[args[0].slice(0, eq)] = args[0].slice(eq + 1).replace(/^["']|["']$/g, '');
    return '';
  },

  unalias(tab, args) {
    for (const a of args) delete tab.aliases[a];
    return '';
  },

  which(tab, args) {
    if (!args[0]) return 'which: missing argument';
    return BUILTINS_SET.has(args[0]) ? `/bin/${args[0]}` : `${args[0]}: not found`;
  },

  history(tab, args) {
    if (args[0] === '-c') { tab.history = []; return ''; }
    const n = parseInt(args[0], 10) || tab.history.length;
    return tab.history.slice(0, n).slice().reverse().map((c, i) => `${String(i + 1).padStart(5)}  ${c}`).join('\n') || '(empty)';
  },

  echo(tab, args) {
    // -n is parsed for compatibility but has no visual effect: each line of
    // the result is rendered as its own <div>, so there's no trailing newline
    // to suppress.
    const noNl = args[0] === '-n';
    const en = args[0] === '-e';
    let text = args.slice((noNl || en) ? 1 : 0).join(' ');
    if (en) {
      text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\033\[(\d+)m/g, '');
    }
    return text;
  },

  printf(tab, args) {
    if (!args[0]) return '';
    const fmt = args[0];
    let ai = 1;
    let out = '';
    for (let i = 0; i < fmt.length; i++) {
      if (fmt[i] === '%' && i + 1 < fmt.length) {
        const spec = fmt[++i];
        if (spec === 's') out += (args[ai++] || '');
        else if (spec === 'd') out += parseInt(args[ai++] || '0', 10);
        else if (spec === 'f') out += parseFloat(args[ai++] || '0').toFixed(2);
        else if (spec === '%') out += '%';
        else out += spec;
      } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
        const esc = fmt[++i];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === '\\') out += '\\';
        else out += esc;
      } else {
        out += fmt[i];
      }
    }
    return out;
  },

  async sleep(tab, args) {
    const secs = parseFloat(args[0]) || 1;
    await new Promise(r => setTimeout(r, Math.min(secs, SLEEP_MAX_SECONDS) * 1000));
    return '';
  },

  yes(tab, args) {
    const w = args[0] || 'y';
    return Array(YES_LINE_CAP).fill(w).join('\n') + '\n\x1b[2m(truncated)\x1b[0m';
  },

  seq(tab, args) {
    let start = 1, end = 1, step = 1;
    if (args.length === 1) end = parseInt(args[0], 10);
    else if (args.length === 2) { start = parseInt(args[0], 10); end = parseInt(args[1], 10); }
    else if (args.length === 3) { start = parseInt(args[0], 10); step = parseInt(args[1], 10); end = parseInt(args[2], 10); }
    if (!Number.isFinite(step) || step === 0) step = 1;
    const out = [];
    if (step > 0) {
      for (let i = start; i <= end && out.length < SEQ_LINE_CAP; i += step) out.push(i);
    } else {
      for (let i = start; i >= end && out.length < SEQ_LINE_CAP; i += step) out.push(i);
    }
    return out.join('\n');
  },

  expr(tab, args) {
    try {
      const expr = args.join(' ').replace(/[^0-9+\-*\/()% ]/g, '');
      return String(evalArithmetic(expr));
    } catch {
      return 'expr: syntax error';
    }
  },

  base64(tab, args, pipeIn) {
    const positional = args.filter(a => !a.startsWith('-'));
    let src;
    if (pipeIn) {
      src = pipeIn;
    } else {
      const fname = positional[0];
      const file = fname && FS.listDir(tab.cwd).find(f => f.name === fname);
      src = file ? (file.content || '') : positional.join(' ');
    }
    if (args.includes('-d') || args.includes('--decode')) {
      try { return decodeBase64(src); } catch { return 'base64: invalid input'; }
    }
    try { return encodeBase64(src); } catch { return 'base64: error encoding'; }
  },

  cd(tab, args) {
    if (!args[0] || args[0] === '~') {
      tab.prevCwd = tab.cwd;
      tab.cwd = FS.specialFolders.desktop;
      updatePrompt(tab);
      return '';
    }
    if (args[0] === '-') {
      if (!tab.prevCwd) return 'cd: OLDPWD not set';
      [tab.cwd, tab.prevCwd] = [tab.prevCwd, tab.cwd];
      updatePrompt(tab);
      return FS.getPath(tab.cwd);
    }
    const resolved = resolvePath(tab.cwd, args[0]);
    if (resolved === false) return `cd: ${args[0]}: No such file or directory`;
    const node = FS.files.get(resolved);
    if (!node) return `cd: ${args[0]}: No such file or directory`;
    if (node.type !== 'folder') return `cd: ${args[0]}: Not a directory`;
    tab.prevCwd = tab.cwd;
    tab.cwd = resolved;
    updatePrompt(tab);
    return '';
  },

  ls(tab, args) {
    const hidden = args.some(a => ['-a', '-la', '-al', '-lah'].includes(a));
    const long = args.some(a => ['-l', '-la', '-al', '-lh', '-lah'].includes(a));
    const human = args.some(a => ['-h', '-lh', '-lah'].includes(a));
    const targetArg = args.find(a => !a.startsWith('-'));
    let tid = tab.cwd;
    if (targetArg) {
      const r = resolvePath(tab.cwd, targetArg);
      if (r === false) return `ls: cannot access '${targetArg}': No such file or directory`;
      tid = r;
    }
    let files = FS.listDir(tid);
    if (!hidden) files = files.filter(f => !f.name.startsWith('.'));
    files.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    if (!files.length) return '';
    if (long) {
      const rows = files.map(f => {
        const d = f.type === 'folder';
        const perm = d ? 'drwxr-xr-x' : '-rw-r--r--';
        const sz = human ? formatBytesLocal(f.size || 0).padStart(6) : String(f.size || 0).padStart(8);
        const dt = new Date(f.modified || Date.now());
        const dateStr = dt.toLocaleDateString('en', { month: 'short', day: '2-digit', year: 'numeric' });
        return `<span class="shell-dim">${perm}  1 ${escapeHtml(OS.username)} ${escapeHtml(OS.username)} ${sz} ${dateStr}</span> <span class="${d ? 'shell-blue shell-bold' : ''}">${escapeHtml(f.name)}${d ? '/' : ''}</span>`;
      });
      writeHTML(tab, `<span class="shell-dim">total ${files.length}</span>\n` + rows.join('\n'));
      return '';
    }
    const cols = Math.max(1, Math.floor((tab.output.clientWidth || 600) / 120));
    const items = files.map(f => {
      const d = f.type === 'folder';
      return `<span class="${d ? 'shell-blue shell-bold' : ''}">${escapeHtml(f.name)}${d ? '/' : ''}</span>`;
    });
    for (let i = 0; i < items.length; i += cols) {
      writeHTML(tab, items.slice(i, i + cols).join('  '));
    }
    return '';
  },

  tree(tab) {
    let out = `<span class="shell-blue shell-bold">.</span>\n`;
    const count = { d: 0, f: 0 };
    function drawTree(id, prefix, depth) {
      if (depth > TREE_MAX_DEPTH) return;
      const files = FS.listDir(id);
      files.forEach((f, i) => {
        const last = i === files.length - 1;
        const conn = last ? '└── ' : '├── ';
        const ext = last ? '    ' : '│   ';
        const isD = f.type === 'folder';
        out += `${prefix}${conn}<span class="${isD ? 'shell-blue shell-bold' : ''}">${escapeHtml(f.name)}${isD ? '/' : ''}</span>\n`;
        if (isD) { count.d++; drawTree(f.id, prefix + ext, depth + 1); } else count.f++;
      });
    }
    drawTree(tab.cwd, '', 0);
    out += `\n<span class="shell-dim">${count.d} directories, ${count.f} files</span>`;
    writeHTML(tab, out);
    return '';
  },

  async mkdir(tab, args) {
    const name = args.filter(a => !a.startsWith('-'))[0];
    if (!name) return 'mkdir: missing operand';
    if (args.includes('-p')) {
      const parts = name.split('/').filter(Boolean);
      let cur = tab.cwd;
      for (const p of parts) {
        const ch = FS.listDir(cur);
        const ex = ch.find(f => f.name === p && f.type === 'folder');
        if (ex) cur = ex.id;
        else { const nf = await FS.createFolder(cur, p); cur = nf.id || cur; }
      }
    } else {
      await FS.createFolder(tab.cwd, name);
    }
    refreshDesktop();
    return '';
  },

  async rmdir(tab, args) {
    const name = args[0];
    if (!name) return 'rmdir: missing operand';
    const ch = FS.listDir(tab.cwd);
    const t = ch.find(f => f.name === name && f.type === 'folder');
    if (!t) return `rmdir: failed to remove '${name}': No such file or directory`;
    if (FS.listDir(t.id).length) return `rmdir: failed to remove '${name}': Directory not empty`;
    await FS.permanentDelete(t.id);
    refreshDesktop();
    return '';
  },

  async touch(tab, args) {
    if (!args[0]) return 'touch: missing file operand';
    const ch = FS.listDir(tab.cwd);
    const ex = ch.find(f => f.name === args[0]);
    if (ex) {
      ex.modified = Date.now();
      // Persist the touched mtime — original forgot to, leaving the change
      // in memory only.
      try { await OS.workers.fs.call('putFiles', [ex]); } catch {}
    } else {
      await FS.createFile(tab.cwd, args[0], '', 'text/plain');
    }
    refreshDesktop();
    return '';
  },

  async rm(tab, args) {
    const names = args.filter(a => !a.startsWith('-'));
    if (!names.length) return 'rm: missing operand';
    const recursive = args.includes('-rf') || args.includes('-r') || args.includes('-f');
    for (const name of names) {
      const ch = FS.listDir(tab.cwd);
      const t = ch.find(f => f.name === name);
      if (!t) {
        if (!args.includes('-f')) return `rm: cannot remove '${name}': No such file or directory`;
        continue;
      }
      if (recursive) await FS.permanentDelete(t.id);
      else await FS.deleteToTrash(t.id);
    }
    refreshDesktop();
    return '';
  },

  async cp(tab, args) {
    const names = args.filter(a => !a.startsWith('-'));
    if (names.length < 2) return 'cp: missing destination file operand';
    const [srcName, ...rest] = names;
    const dst = rest[rest.length - 1];
    const ch = FS.listDir(tab.cwd);
    const src = ch.find(f => f.name === srcName);
    if (!src) return `cp: cannot stat '${srcName}': No such file or directory`;
    const dstFolder = resolvePath(tab.cwd, dst);
    if (dstFolder !== false) {
      await FS.createFile(dstFolder, srcName, src.content, src.mimeType);
    } else {
      await FS.createFile(tab.cwd, dst, src.content, src.mimeType);
    }
    refreshDesktop();
    return '';
  },

  async mv(tab, args) {
    const names = args.filter(a => !a.startsWith('-'));
    if (names.length < 2) return 'mv: missing destination file operand';
    const srcName = names[0];
    const dst = names[1];
    const ch = FS.listDir(tab.cwd);
    const src = ch.find(f => f.name === srcName);
    if (!src) return `mv: cannot stat '${srcName}': No such file or directory`;
    const dstFolder = resolvePath(tab.cwd, dst);
    if (dstFolder !== false) {
      src.parentId = dstFolder;
      FS.files.set(src.id, src);
      try { await OS.workers.fs.call('putFiles', [src]); } catch {}
    } else {
      await FS.rename(src.id, dst);
    }
    refreshDesktop();
    return '';
  },

  cat(tab, args, pipeIn) {
    if (!args[0] && pipeIn !== undefined) return pipeIn || '';
    const names = args.filter(a => !a.startsWith('-'));
    if (!names.length) return pipeIn || '';
    const results = [];
    for (const n of names) {
      const ch = FS.listDir(tab.cwd);
      const t = ch.find(f => f.name === n);
      if (!t) return `cat: ${n}: No such file or directory`;
      if (t.type === 'folder') return `cat: ${n}: Is a directory`;
      if (args.includes('-n')) {
        results.push((t.content || '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'));
      } else {
        results.push(t.content || '');
      }
    }
    return results.join('\n');
  },

  head(tab, args, pipeIn) {
    const fname = args.find(a => !a.startsWith('-'));
    const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
    const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag, 10) : 10;
    const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
    return text.split('\n').slice(0, n).join('\n');
  },

  tail(tab, args, pipeIn) {
    const fname = args.find(a => !a.startsWith('-'));
    const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
    const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag, 10) : 10;
    const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
    return text.split('\n').slice(-n).join('\n');
  },

  wc(tab, args, pipeIn) {
    const fname = args.find(a => !a.startsWith('-'));
    const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
    if (args.includes('-l')) return String(text.split('\n').length);
    if (args.includes('-w')) return String(text.split(/\s+/).filter(Boolean).length);
    if (args.includes('-c')) return String(new TextEncoder().encode(text).length);
    const L = text.split('\n').length;
    const W = text.split(/\s+/).filter(Boolean).length;
    const C = text.length;
    return `${String(L).padStart(8)} ${String(W).padStart(8)} ${String(C).padStart(8)}${fname ? ' ' + fname : ''}`;
  },

  grep(tab, args, pipeIn) {
    const patternArg = args.find(a => !a.startsWith('-'));
    if (!patternArg) return 'grep: missing PATTERN';
    const patternIdx = args.indexOf(patternArg);
    const fileArg = args.find((a, i) => !a.startsWith('-') && i !== patternIdx);
    const text = pipeIn || (fileArg && FS.listDir(tab.cwd).find(f => f.name === fileArg)?.content) || '';
    const flags = (args.includes('-i') ? 'i' : '') + (args.includes('-m') ? 'm' : '');
    const invert = args.includes('-v');
    const count = args.includes('-c');
    const lnum = args.includes('-n');
    let rx;
    try { rx = new RegExp(patternArg, flags); } catch { return `grep: invalid regexp: ${patternArg}`; }
    const lines = text.split('\n');
    // Note: line numbers below are 1-based indices into the matched subset,
    // not source line numbers. This matches the original's behaviour exactly
    // (real grep uses source line numbers — kept as-is to preserve output).
    const matched = lines.filter(l => invert ? !rx.test(l) : rx.test(l));
    if (count) return String(matched.length);
    if (lnum) return matched.map((l, i) => `${i + 1}:${l}`).join('\n');
    return matched.join('\n');
  },

  sort(tab, args, pipeIn) {
    const fname = args.find(a => !a.startsWith('-'));
    const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
    let lines = text.split('\n');
    const rev = args.includes('-r');
    const num = args.includes('-n');
    const uniq = args.includes('-u');
    lines.sort((a, b) => num ? (parseFloat(a) - parseFloat(b)) : a.localeCompare(b));
    if (rev) lines.reverse();
    if (uniq) lines = [...new Set(lines)];
    return lines.join('\n');
  },

  uniq(tab, args, pipeIn) {
    const text = pipeIn || '';
    return text.split('\n').filter((l, i, a) => i === 0 || l !== a[i - 1]).join('\n');
  },

  cut(tab, args, pipeIn) {
    const text = pipeIn || '';
    const di = args.indexOf('-d');
    const delim = di >= 0 && args[di + 1] ? args[di + 1] : '\t';
    const fi = args.indexOf('-f');
    const fieldRaw = fi >= 0 ? parseInt(args[fi + 1], 10) : 1;
    const field = Number.isFinite(fieldRaw) ? fieldRaw - 1 : 0;
    return text.split('\n').map(l => l.split(delim)[field] ?? '').join('\n');
  },

  stat(tab, args) {
    if (!args[0]) return 'stat: missing operand';
    const ch = FS.listDir(tab.cwd);
    const t = ch.find(f => f.name === args[0]);
    if (!t) return `stat: cannot statx '${args[0]}': No such file or directory`;
    const dt = new Date(t.modified || Date.now());
    return `  File: ${t.name}\n  Size: ${t.size || 0}\t\tBlocks: ${Math.ceil((t.size || 0) / 512)}\tIO Block: 4096  ${t.type === 'folder' ? 'directory' : 'regular file'}\nDevice: nova0\t\tInode: ${t.id.slice(-8) || 0}\tLinks: 1\nAccess: ${dt.toISOString()}\nModify: ${dt.toISOString()}\nChange: ${dt.toISOString()}`;
  },

  chmod(tab) {
    writeLine(tab, `chmod: permissions are advisory in NovaByte`, 'shell-yellow');
    return '';
  },

  find(tab, args) {
    const startArg = args.find(a => !a.startsWith('-')) || '.';
    const nameArg = args.includes('-name') ? args[args.indexOf('-name') + 1] : null;
    const typeArg = args.includes('-type') ? args[args.indexOf('-type') + 1] : null;
    const startId = startArg === '.' ? tab.cwd : resolvePath(tab.cwd, startArg);
    if (startId === false) return `find: '${startArg}': No such file or directory`;
    // Proper glob match (original used a broken substring heuristic).
    const nameRx = nameArg ? globToRegExp(nameArg) : null;
    const results = [];
    function search(id, prefix) {
      const files = FS.listDir(id);
      for (const f of files) {
        const path = prefix + '/' + f.name;
        const matchName = !nameRx || nameRx.test(f.name);
        const matchType = !typeArg || (typeArg === 'd' && f.type === 'folder') || (typeArg === 'f' && f.type !== 'folder');
        if (matchName && matchType) results.push(path);
        if (f.type === 'folder') search(f.id, path);
      }
    }
    search(startId, '.');
    return results.join('\n') || (nameArg ? '(no matches)' : '');
  },

  diff(tab, args) {
    if (args.length < 2) return 'diff: missing operand after diff';
    const [a1, a2] = args.filter(a => !a.startsWith('-'));
    const ch = FS.listDir(tab.cwd);
    const f1 = ch.find(f => f.name === a1);
    const f2 = ch.find(f => f.name === a2);
    if (!f1) return `diff: ${a1}: No such file or directory`;
    if (!f2) return `diff: ${a2}: No such file or directory`;
    const L1 = (f1.content || '').split('\n');
    const L2 = (f2.content || '').split('\n');
    const max = Math.max(L1.length, L2.length);
    let out = '';
    let hasDiff = false;
    writeHTML(tab, `<span class="shell-dim">--- ${escapeHtml(a1)}</span>\n<span class="shell-dim">+++ ${escapeHtml(a2)}</span>`);
    for (let i = 0; i < max; i++) {
      if (L1[i] !== L2[i]) {
        hasDiff = true;
        if (L1[i] !== undefined) out += `<span class="shell-red">- ${escapeHtml(L1[i])}</span>\n`;
        if (L2[i] !== undefined) out += `<span class="shell-green">+ ${escapeHtml(L2[i])}</span>\n`;
      }
    }
    if (!hasDiff) return '(files are identical)';
    writeHTML(tab, out);
    return '';
  },

  ps(tab) {
    const procs = [
      { pid: 1, user: 'root', stat: 'S', name: 'nova-init' },
      { pid: 2, user: 'root', stat: 'S', name: 'kworker/0:0' },
      { pid: 10, user: 'root', stat: 'S', name: 'nova-kernel' },
      { pid: 100, user: OS.username, stat: 'S', name: 'nova-session' },
      { pid: 101, user: OS.username, stat: 'S', name: 'nova-wm' },
      { pid: 102, user: OS.username, stat: 'S', name: 'nova-fs' },
      { pid: 103, user: OS.username, stat: 'S', name: 'nova-indexer' }
    ];
    let pid = 200;
    if (OS.windows) {
      for (const [, ws] of OS.windows) {
        const app = OS.apps[ws.appId];
        if (app) procs.push({ pid: pid++, user: OS.username, stat: 'S', name: app.name.toLowerCase() });
      }
    }
    const header = '<span class="shell-bold">  PID USER     STAT COMMAND</span>';
    // Pad the raw username for column alignment, then escape. Padding first
    // keeps the visible width correct; escaping after keeps the HTML safe.
    const rows = procs.map(p => {
      const userPadded = p.user.padEnd(8);
      return `${String(p.pid).padStart(5)} ${escapeHtml(userPadded)} ${p.stat}    ${escapeHtml(p.name)}`;
    });
    writeHTML(tab, header);
    return rows.join('\n');
  },

  kill(tab, args) {
    if (!args[0]) return 'kill: usage: kill [-s sigspec] pid';
    const last = args[args.length - 1];
    if (isNaN(parseInt(last, 10))) return `kill: ${last}: invalid signal specification`;
    return `kill: (${last}) - Operation not permitted`;
  },

  neofetch(tab) {
    return COMMANDS.fastfetch(tab);
  },

  fastfetch(tab) {
    const cores = navigator.hardwareConcurrency || 4;
    const ram = (navigator.deviceMemory || 4) + ' GB';
    const engine = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'Browser';
    writeHTML(tab,
      `  <span class="shell-blue shell-bold">  ╔══╗  </span>  <span class="shell-bold shell-green">${escapeHtml(OS.username)}</span><span class="shell-dim">@</span><span class="shell-bold">novabyteOS</span>\n` +
      `  <span class="shell-blue shell-bold">  ║NB║  </span>  <span class="shell-dim">────────────────────────</span>\n` +
      `  <span class="shell-blue shell-bold">  ╚══╝  </span>  <span class="shell-blue">OS:</span>      NovaByte <span class="shell-bold">${escapeHtml(OS.version)}</span>\n` +
      `          <span class="shell-blue">Kernel:</span>  NovaKernel 5.15.0-nova\n` +
      `          <span class="shell-blue">Shell:</span>   Terminal\n` +
      `          <span class="shell-blue">CPU:</span>     ${cores} cores (logical)\n` +
      `          <span class="shell-blue">RAM:</span>     ${escapeHtml(ram)}\n` +
      `          <span class="shell-blue">Engine:</span>  ${escapeHtml(engine)}\n` +
      `          <span class="shell-blue">Screen:</span>  ${screen.width}×${screen.height}@${window.devicePixelRatio}x\n` +
      `          <span class="shell-blue">Theme:</span>   NovaDark (default)\n` +
      `          <span class="shell-blue">User:</span>    ${escapeHtml(OS.username)}`);
    return '';
  }
};

// --- Pipeline runner ----------------------------------------------------------

// Expands $VAR and ${VAR} references. Unset variables expand to empty string
// (matches the original's behaviour).
function expandVariables(cmdStr, variables) {
  return cmdStr.replace(/\$\{?(\w+)\}?/g, (_, n) => variables[n] ?? '');
}

async function execOne(tab, cmdStr, pipeIn) {
  if (!cmdStr.trim()) return pipeIn || '';
  cmdStr = expandVariables(cmdStr, tab.variables);
  const tokens = tokenize(cmdStr);
  if (!tokens.length) return '';
  let cmd = tokens[0];
  let args = tokens.slice(1);
  // Alias expansion: alias tokens go first, user args follow.
  if (tab.aliases[cmd]) {
    const aliasTokens = tokenize(tab.aliases[cmd]);
    cmd = aliasTokens[0];
    args = [...aliasTokens.slice(1), ...args];
  }
  const handler = COMMANDS[cmd];
  if (handler) {
    const result = await handler(tab, args, pipeIn);
    // Defend against misbehaving commands returning undefined / non-strings.
    return result == null ? '' : String(result);
  }
  // Unknown command — check if it's a file in cwd (→ Permission denied) or
  // truly unknown (→ command not found).
  const ch = FS.listDir(tab.cwd);
  const ex = ch.find(f => f.name === cmd);
  if (ex) return `bash: ${cmd}: Permission denied`;
  return `bash: ${cmd}: command not found`;
}

async function runCommand(tab, line) {
  line = line.trim();
  if (!line) return '';

  // Chain operators (;, &&, ||) — quote-aware. Leftmost operator wins,
  // which gives the same result as the original's split-all approach.
  const chain = findChainOperator(line);
  if (chain) {
    const { op, before, after } = chain;
    const beforeResult = await runCommand(tab, before);
    const isError = typeof beforeResult === 'string'
      && (beforeResult.startsWith('bash:') || beforeResult.startsWith('Error'));
    if (op === ';') return await runCommand(tab, after);
    if (op === '&&') return isError ? beforeResult : await runCommand(tab, after);
    if (op === '||') return isError ? await runCommand(tab, after) : beforeResult;
  }

  // Redirect (>) — quote-aware. Filename is everything up to the next '>',
  // trimmed. This matches the original's behaviour for the common case.
  const redirect = findRedirect(line);
  if (redirect) {
    const { before, after } = redirect;
    const out = await runCommand(tab, before);
    const filename = after.split('>')[0].trim();
    if (filename) {
      const ch = FS.listDir(tab.cwd);
      const ex = ch.find(f => f.name === filename);
      if (ex) {
        ex.content = out;
        try { await OS.workers.fs.call('putFiles', [ex]); } catch {}
      } else {
        await FS.createFile(tab.cwd, filename, out, 'text/plain');
      }
      return '';
    }
    return out;
  }

  // Pipe chain.
  const segs = splitPipes(line);
  if (segs.length === 1) return await execOne(tab, segs[0], '');
  let pipe = '';
  for (const s of segs) pipe = await execOne(tab, s, pipe);
  return pipe;
}

// --- Input handler ------------------------------------------------------------

function setupInput(tab, signal) {
  let completions = [];
  let compIdx = 0;

  async function onInputKeyDown(e) {
    // Stop the event from reaching the global OS shortcut listener so terminal
    // shortcuts (Ctrl+L clear, Ctrl+C cancel, etc.) don't accidentally trigger
    // OS actions (Ctrl+L lock, Ctrl+E file manager, etc.).
    e.stopPropagation();

    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = tab.input.value.trim();
      tab.input.value = '';
      completions = [];
      writePromptLine(tab, cmd);
      if (cmd) {
        tab.history.unshift(cmd);
        tab.historyIdx = -1;
        // Cap history so a long session can't grow it without bound.
        if (tab.history.length > MAX_HISTORY) tab.history.length = MAX_HISTORY;
      }
      try {
        const result = await runCommand(tab, cmd);
        if (result) {
          const isErr = result.startsWith('bash:') || result.startsWith('cd:') || result.startsWith('Error');
          for (const line of result.split('\n')) writeLine(tab, line, isErr ? 'shell-red' : undefined);
        }
      } catch (err) {
        // Shouldn't happen — command errors are returned as strings — but if a
        // handler throws, surface it instead of swallowing.
        writeLine(tab, `Error: ${err?.message || err}`, 'shell-red');
      }
      updatePrompt(tab);
      scrollOutput(tab);

    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (tab.historyIdx < tab.history.length - 1) {
        tab.input.value = tab.history[++tab.historyIdx];
      }

    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (tab.historyIdx > 0) {
        tab.input.value = tab.history[--tab.historyIdx];
      } else {
        tab.historyIdx = -1;
        tab.input.value = '';
      }

    } else if (e.key === 'Tab') {
      e.preventDefault();
      const words = tab.input.value.split(' ');
      const partial = words[words.length - 1];
      if (!completions.length) {
        completions = getCompletions(tab, partial);
        compIdx = 0;
      }
      if (completions.length === 1) {
        words[words.length - 1] = completions[0];
        tab.input.value = words.join(' ');
        completions = [];
      } else if (completions.length > 1) {
        if (completions.length <= 12) {
          writeHTML(tab, `<span class="shell-dim">${completions.map(c => escapeHtml(c)).join('  ')}</span>`);
        }
        words[words.length - 1] = completions[compIdx++ % completions.length];
        tab.input.value = words.join(' ');
      }

    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      clearOutput(tab);
      updatePrompt(tab);
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      writeLine(tab, '^C', 'shell-red');
      tab.input.value = '';
      updatePrompt(tab);
    } else if (e.key === 'u' && e.ctrlKey) {
      e.preventDefault();
      tab.input.value = '';
    } else if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      tab.input.setSelectionRange(0, 0);
    } else if (e.key === 'e' && e.ctrlKey) {
      e.preventDefault();
      const len = tab.input.value.length;
      tab.input.setSelectionRange(len, len);
    } else {
      // Any other key resets the completion cycle.
      completions = [];
      compIdx = 0;
    }
  }

  tab.input.addEventListener('keydown', onInputKeyDown, { signal });
}

// --- Missing-OS guard ---------------------------------------------------------

function showMissingOSMessage(content) {
  content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
  content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.shell</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
}

// --- Selection helper (replaces deprecated document.execCommand) --------------

function selectAllInOutput(tab) {
  if (!tab?.output) return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(tab.output);
  selection.removeAllRanges();
  selection.addRange(range);
}

// --- App registration ---------------------------------------------------------

registerApp({
  id: 'shell',
  name: 'Terminal',
  icon: 'terminal',
  description: 'Terminal',
  defaultSize: [700, 460],
  minSize: [420, 260],

  init(content, state) {
    // Refuse to launch without NovaByte OS — the FS/OS globals won't exist.
    if (!window.AppDirs?.getVFSDir(APP_BUNDLE_ID, 'files')) {
      showMissingOSMessage(content);
      return;
    }

    // One AbortController for every listener this app instance owns.
    // Aborted via state.cleanups when the host closes the app, which removes
    // every listener added with { signal: ac.signal } in one call.
    const ac = new AbortController();
    state.cleanups = state.cleanups || [];
    state.cleanups.push(() => ac.abort());

    const root = createEl('div', { className: 'shell-container' });
    content.appendChild(root);

    const mainArea = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;' });
    root.appendChild(mainArea);

    const tabs = [];
    let activeTabIdx = 0;

    function createTab(label) {
      const tab = {
        label: label || 'Terminal',
        cwd: FS.specialFolders.desktop,
        prevCwd: null,
        history: [],
        historyIdx: -1,
        variables: makeDefaultVariables(OS.username),
        aliases: { ...DEFAULT_ALIASES },
        element: null,
        output: null,
        input: null,
        prompt: null,
        btnEl: { classList: { toggle() {} } }  // stub for legacy API compat
      };

      const pane = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });
      const output = createEl('div', { className: 'shell-output', role: 'log', 'aria-label': 'Terminal output' });
      const inputLine = createEl('div', { className: 'shell-input-line' });
      const promptEl = createEl('span', { className: 'shell-prompt' });
      const inputEl = createEl('input', {
        className: 'shell-input',
        id: 'shell-command-input',
        name: 'shell-command',
        'aria-label': 'Command input',
        autocomplete: 'off',
        spellcheck: 'false'
      });

      inputLine.appendChild(promptEl);
      inputLine.appendChild(inputEl);
      pane.appendChild(output);
      pane.appendChild(inputLine);

      // Click anywhere in the pane to focus the input (unless the user
      // clicked a link or button inside the output).
      output.addEventListener('click', () => inputEl.focus(), { signal: ac.signal });
      pane.addEventListener('click', (ev) => {
        if (!ev.target.closest('a') && !ev.target.closest('button')) inputEl.focus();
      }, { signal: ac.signal });
      inputLine.addEventListener('click', () => inputEl.focus(), { signal: ac.signal });

      tab.element = pane;
      tab.output = output;
      tab.input = inputEl;
      tab.prompt = promptEl;

      tabs.push(tab);
      setupInput(tab, ac.signal);
      return tab;
    }

    function removeTab() {
      // No-op — single-session model preserved from the original.
      // Ctrl+Shift+W still does nothing, intentionally, to avoid surprises.
    }

    function switchTab(idx) {
      activeTabIdx = idx;
      const tab = tabs[idx];
      if (!tab) return;
      mainArea.innerHTML = '';
      mainArea.appendChild(tab.element);
      tab.input.focus();
      updatePrompt(tab);
    }

    // Context menu: Copy (if selection), Paste, Clear, Select All.
    function onContextMenu(e) {
      if (!e.target.closest('.shell-output') && !e.target.closest('.shell-input-line')) return;
      e.preventDefault();
      const sel = window.getSelection().toString();
      const items = [];
      if (sel) {
        items.push({
          label: 'Copy', icon: 'copy',
          action() {
            const p = navigator.clipboard?.writeText(sel);
            if (p) p.then(
              () => Notify.show({ title: 'Copied', body: 'Text copied', type: 'info', appName: 'Terminal' }),
              () => Notify.show({ title: 'Copy failed', body: 'Clipboard write denied', type: 'error', appName: 'Terminal' })
            );
          }
        });
        items.push({ separator: true });
      }
      items.push({
        label: 'Paste', icon: 'documents',
        action() {
          const p = navigator.clipboard?.readText();
          if (p) p.then(
            (text) => {
              const t = tabs[activeTabIdx];
              if (t?.input) t.input.value += text;
            },
            () => Notify.show({ title: 'Paste failed', body: 'Clipboard read denied', type: 'error', appName: 'Terminal' })
          );
        }
      });
      items.push({
        label: 'Clear', icon: 'trash-2',
        action() {
          const t = tabs[activeTabIdx];
          if (t?.output) t.output.innerHTML = '';
        }
      });
      items.push({ separator: true });
      items.push({
        label: 'Select All', icon: 'maximize',
        action() { selectAllInOutput(tabs[activeTabIdx]); }
      });
      ContextMenu.show(e.clientX, e.clientY, items);
    }
    root.addEventListener('contextmenu', onContextMenu, { signal: ac.signal });

    // Global keyboard shortcuts (only active when this app's window is focused).
    function onKeyDown(e) {
      const win = content.closest('.app-window');
      if (!win || win.dataset.appId !== 'shell') return;
      if (e.ctrlKey && e.shiftKey && e.key === 'T') {
        e.preventDefault();
        const t = createTab('Terminal ' + (tabs.length + 1));
        switchTab(tabs.length - 1);
        welcomeTab(t);
        updatePrompt(t);
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'W') {
        e.preventDefault();
        removeTab(activeTabIdx);
      }
    }
    document.addEventListener('keydown', onKeyDown, { signal: ac.signal });

    // First tab.
    const t0 = createTab('Terminal');
    switchTab(0);
    welcomeTab(t0);
    updatePrompt(t0);
    const focusInitial = () => t0.input.focus();
    requestAnimationFrame(focusInitial);
  }
});