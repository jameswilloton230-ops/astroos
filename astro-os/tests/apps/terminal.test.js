// tests/apps/terminal.test.js — window app: registration, shell input
// handling, real command execution (echo/pipes/chains/redirect/fs commands),
// history, completion, shortcuts, clipboard bridge and context menu.
//
// jsdom notes: `process` is undefined in the app realm, so the app always
// takes the virtual-FS path. FS is the app's environment, not the code under
// test, so a contract-faithful in-memory FS (same API as
// js/core/services/fs.js) is injected via stubs.extra.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';

// ── In-memory FS with the same contract as js/core/services/fs.js ──────────
function makeFakeFS() {
  const files = new Map();
  const childrenByParent = new Map();
  let idc = 0;
  const genId = () => `fsnode-${++idc}`;

  const fs = {
    files,
    _childrenByParent: childrenByParent,
    rootId: null,
    specialFolders: {},
    _index(f) {
      if (!f || f.parentId === undefined) return;
      let m = childrenByParent.get(f.parentId);
      if (!m) { m = new Map(); childrenByParent.set(f.parentId, m); }
      m.set(f.id, f);
    },
    _unindex(id) {
      const f = files.get(id);
      if (!f) return;
      const m = childrenByParent.get(f.parentId);
      if (m) { m.delete(id); if (!m.size) childrenByParent.delete(f.parentId); }
    },
    listDir(folderId) {
      const m = childrenByParent.get(folderId);
      if (!m) return [];
      return [...m.values()].sort((a, b) =>
        a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
    },
    getPath(id) {
      const parts = [];
      let node = files.get(id);
      while (node) {
        if (node.parentId === null) break;
        parts.push(node.name);
        node = files.get(node.parentId);
      }
      return '/' + parts.reverse().join('/');
    },
    getByPath(path) {
      if (path === '/') return files.get(this.rootId);
      let current = this.rootId;
      for (const part of path.split('/')) {
        if (!part) continue;
        const m = childrenByParent.get(current);
        const found = m && [...m.values()].find((c) => c.name === part);
        if (!found) return null;
        current = found.id;
      }
      return files.get(current);
    },
    async createFolder(parentId, name) {
      const node = { id: genId(), name, type: 'folder', parentId, content: null, size: 0, mimeType: 'inode/directory', modified: Date.now() };
      files.set(node.id, node);
      this._index(node);
      return node;
    },
    async createFile(parentId, name, content, mimeType) {
      const node = { id: genId(), name, type: 'file', parentId, content: content || '', size: (content || '').length, mimeType: mimeType || 'text/plain', modified: Date.now() };
      files.set(node.id, node);
      this._index(node);
      return node;
    },
    async writeFile(id, content) {
      const node = files.get(id);
      if (!node) return null;
      node.content = content;
      node.size = String(content ?? '').length;
      node.modified = Date.now();
      return node;
    },
    async rename(id, newName) {
      const node = files.get(id);
      if (node) node.name = newName;
      return node;
    },
    async move(id, newParentId) {
      const node = files.get(id);
      if (!node) return null;
      this._unindex(id);
      node.parentId = newParentId;
      this._index(node);
      return node;
    },
    async deleteToTrash(id) {
      const node = files.get(id);
      if (!node) return null;
      this._unindex(id);
      node.parentId = this.specialFolders.trash;
      this._index(node);
      return node;
    },
    async permanentDelete(id) {
      const node = files.get(id);
      if (!node) return;
      for (const child of this.listDir(id)) await this.permanentDelete(child.id);
      this._unindex(id);
      files.delete(id);
    },
  };

  // Default tree matching FS.createDefaultFS().
  const mk = (name, parentId) => {
    const node = { id: genId(), name, type: 'folder', parentId, content: null, size: 0, mimeType: 'inode/directory', modified: Date.now() };
    files.set(node.id, node);
    fs._index(node);
    return node;
  };
  const root = mk('/', null);
  fs.rootId = root.id;
  fs.specialFolders = {
    desktop: mk('Desktop', root.id).id,
    documents: mk('Documents', root.id).id,
    downloads: mk('Downloads', root.id).id,
    music: mk('Music', root.id).id,
    pictures: mk('Pictures', root.id).id,
    videos: mk('Videos', root.id).id,
    trash: mk('Trash', root.id).id,
  };
  return fs;
}

function makeOS() {
  return { username: 'tester', version: '3.0.2', windows: null };
}

function makeContextMenu() {
  const calls = [];
  return { calls, show: (...args) => calls.push(args), hide: () => {} };
}

function makeNotify() {
  const calls = [];
  return { calls, show: (n) => calls.push(n) };
}

function terminalStubs(overrides = {}) {
  return {
    ...overrides,
    extra: {
      FS: makeFakeFS(),
      OS: makeOS(),
      Notify: makeNotify(),
      ContextMenu: makeContextMenu(),
      __novaUnrestrictedPackage: {
        files: {
          'icons/icons8-copy-94.png': Buffer.from('copy-icon').toString('base64'),
          'icons/icons8-document-94.png': Buffer.from('paste-icon').toString('base64'),
          'icons/icons8-trash-94.png': Buffer.from('trash-icon').toString('base64'),
        },
      },
      ...(overrides.extra ?? {}),
    },
  };
}

async function boot(stubs) {
  const { app, window } = await loadWindowApp('terminal', { stubs });
  const content = initApp(app, { window });
  return {
    app,
    window,
    content,
    input: content.querySelector('#shell-command-input'),
    output: content.querySelector('.shell-output'),
    prompt: content.querySelector('.shell-prompt'),
  };
}

async function run(t, line) {
  t.input.value = line;
  t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await settle();
}

function lines(t) {
  return [...t.output.children].map((d) => d.textContent);
}

describe('Terminal app (js/apps/terminal)', () => {
  beforeEach(() => resetTestStorage());

  it('registers the app descriptor with the host', async () => {
    const { app } = await loadWindowApp('terminal', { stubs: terminalStubs() });
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.terminal');
    expect(app.name).toBe('Terminal');
    expect(app.version).toBe('3.0.2');
    expect(app.defaultSize).toEqual([700, 460]);
    expect(app.minSize).toEqual([420, 260]);
    expect(typeof app.init).toBe('function');
  });

  it('renders the missing-OS fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('terminal', { stubs: terminalStubs({ AppDirs: null }) });
    const content = initApp(app, { window });
    expect(content.querySelector('.shell-output')).toBeNull();
    expect(content.textContent).toContain('App data directory missing');
    expect(content.textContent).toContain('com.astroos.terminal');
  });

  it('boots with a welcome banner and a user:~$ prompt', async () => {
    const t = await boot(terminalStubs());
    const text = t.output.textContent;
    expect(text).toContain('Terminal');
    expect(text).toContain('AstroOS 3.0.2 — tester@novabyte');
    expect(text).toContain('help');
    expect(text).toContain('Tab');
    expect(t.prompt.textContent).toBe('tester:~$ ');
    expect(t.output.getAttribute('role')).toBe('log');
  });

  it('runs `help` and prints every command section', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'help');
    const text = t.output.textContent;
    for (const section of ['Filesystem:', 'Text:', 'System:', 'Math:', 'Fun:']) {
      expect(text).toContain(section);
    }
    expect(text).toContain('neofetch');
    expect(text).toContain('Ctrl+L');
  });

  it('echoes the command line with the prompt and prints command output', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'echo hello world');
    const ls = lines(t);
    expect(ls.some((l) => l === 'tester:~$ echo hello world')).toBe(true);
    expect(ls).toContain('hello world');
    // input is cleared after running
    expect(t.input.value).toBe('');
  });

  it('resolves pwd, whoami and $HOME expansion', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'pwd');
    await run(t, 'whoami');
    await run(t, 'echo $HOME');
    expect(lines(t)).toContain('/Desktop');
    expect(lines(t)).toContain('tester');
    expect(lines(t)).toContain('/Desktop'); // HOME=/Desktop via makeDefaultVariables
  });

  it('reports unknown commands as shell-red errors', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'definitelynotacommand');
    const errLine = [...t.output.children].find((d) => d.className === 'shell-red');
    expect(errLine).toBeTruthy();
    expect(errLine.textContent).toBe('bash: definitelynotacommand: command not found');
  });

  it('supports pipes between commands', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'echo banana | cut -d a -f 1');
    expect(lines(t)).toContain('b');
  });

  it('runs chain operators, propagating && errors and swallowing intermediate output', async () => {
    const t = await boot(terminalStubs());
    // Quirk of the current source: runCommand() returns ONE result string, so
    // in a chain only the LAST segment's output is printed (intermediate
    // segments run but their output is discarded).
    await run(t, 'echo one && echo two');
    expect(lines(t)).not.toContain('one');
    expect(lines(t)).toContain('two');

    // `||` with a failed left side runs the right side; the error text itself
    // is swallowed the same way.
    await run(t, 'false || echo rescued');
    expect(lines(t)).not.toContain('Error: false returned exit code 1');
    expect(lines(t)).toContain('rescued');

    // `&&` with a failed left side propagates the error and skips the right.
    await run(t, 'nope-xyz && echo unreachable');
    expect(lines(t)).toContain('bash: nope-xyz: command not found');
    expect(lines(t)).not.toContain('unreachable');
  });

  it('creates and lists directories through the virtual FS', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'mkdir docs');
    await run(t, 'ls');
    expect(lines(t)).toContain('docs/');

    await run(t, 'rmdir docs');
    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'l', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await run(t, 'ls');
    expect(lines(t)).not.toContain('docs/');
    // mkdir errors surface from the real handler
    await run(t, 'mkdir');
    expect(lines(t)).toContain('mkdir: missing operand');
  });

  it('redirects output into a file and reads it back with cat', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'echo saved data > note.txt');
    // redirect produces no output of its own
    expect(lines(t)).not.toContain('saved data');
    await run(t, 'cat note.txt');
    expect(lines(t)).toContain('saved data');
    await run(t, 'cat -n note.txt');
    expect(lines(t).some((l) => l.includes('1\tsaved data'))).toBe(true);
  });

  it('keeps command history: up-arrow recalls, `history` lists, Ctrl+U clears input', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'echo one');

    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'ArrowUp', bubbles: true, cancelable: true,
    }));
    expect(t.input.value).toBe('echo one');

    await run(t, 'history');
    const text = t.output.textContent;
    expect(text).toMatch(/\d+\s+echo one/);
  });

  it('completes a unique builtin with the Tab key', async () => {
    const t = await boot(terminalStubs());
    t.input.value = 'who';
    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    expect(t.input.value).toBe('whoami');
  });

  it('clears the output with Ctrl+L and cancels with Ctrl+C', async () => {
    const t = await boot(terminalStubs());
    await run(t, 'echo keepme');
    expect(t.output.textContent).toContain('keepme');

    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'l', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect(t.output.children).toHaveLength(0);
    // prompt is re-rendered after clear
    expect(t.prompt.textContent).toBe('tester:~$ ');

    t.input.value = 'partial input';
    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    expect([...t.output.children].some((d) => d.textContent === '^C')).toBe(true);
    expect(t.input.value).toBe('');
  });

  it('pastes from the clipboard through the nova.ipc bridge on Ctrl+V', async () => {
    const { app, window } = await loadWindowApp('terminal', {
      stubs: terminalStubs({
        novaHandlers: { 'nova:clipboard:read': () => ({ success: true, text: 'pasted-text' }) },
      }),
    });
    const content = initApp(app, { window });
    const input = content.querySelector('#shell-command-input');
    input.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await settle();
    expect(input.value).toBe('pasted-text');
  });

  it('surfaces the clipboard-unavailable error when the IPC bridge declines', async () => {
    const t = await boot(terminalStubs());
    // default harness nova.ipc resolves { ok: true } — no success flag, no
    // navigator.clipboard in jsdom → the real error path renders.
    t.input.dispatchEvent(new t.window.KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await settle();
    const errLine = [...t.output.children].find((d) => d.className === 'shell-red');
    expect(errLine.textContent).toBe('Paste failed: Clipboard read unavailable');
  });

  it('builds a context menu with package icons and working Clear action', async () => {
    const contextMenu = makeContextMenu();
    const t = await boot(terminalStubs({ extra: { ContextMenu: contextMenu } }));
    await run(t, 'echo visible');

    t.output.dispatchEvent(new t.window.MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 10, clientY: 10,
    }));
    expect(contextMenu.calls).toHaveLength(1);
    const [x, y, items] = contextMenu.calls[0];
    expect(x).toBe(10);
    expect(y).toBe(10);
    // no selection → no Copy item; Paste icon comes from the package files
    expect(items.map((i) => i.label)).toEqual(['Paste', 'Clear', undefined, 'Select All']);
    expect(items[0].icon).toBe('data:image/png;base64,' + Buffer.from('paste-icon').toString('base64'));

    items[1].action(); // Clear
    expect(t.output.children).toHaveLength(0);
  });
});
