// tests/apps/textedit.test.js — window app: editor shell, word-wrap toggle
// persistence, status bar/gutter updates, bracket auto-pairing + skip-over,
// tab indentation, open/save flows through SystemDialogs + FS, drag-and-drop
// import, and listener teardown.
import { describe, expect, it, beforeEach } from 'vitest';
import { resetTestStorage } from '../setup.js';
import { loadWindowApp, initApp, settle } from '../helpers/app-harness.js';
// initApp is still used for the descriptor/fallback tests; the option-driven
// loads call app.init directly (see loadTextedit).

const WRAP_KEY = 'astroos.textedit.wordWrap';

function makeFs() {
  const writes = [];
  const created = [];
  return {
    writes,
    created,
    files: new Map([
      ['f1', { id: 'f1', name: 'hello.txt', type: 'file', content: 'seeded file body', mimeType: 'text/plain' }],
    ]),
    specialFolders: { documents: 'docs-folder' },
    writeFile: async (id, content) => { writes.push([id, content]); return true; },
    createFile: async (folderId, name, content, mime) => {
      created.push([folderId, name, content, mime]);
      return { id: 'new-' + created.length, name };
    },
  };
}

function makeNotify() {
  const calls = [];
  return { calls, show: (n) => calls.push(n) };
}

function makeDialogs({ openResult, saveResult, openError } = {}) {
  const calls = [];
  return {
    calls,
    open: openError ? async (opts) => { calls.push(['open', opts]); throw openError; }
      : async (opts) => { calls.push(['open', opts]); return openResult ?? null; },
    save: async (opts) => { calls.push(['save', opts]); return saveResult ?? null; },
  };
}

async function loadTextedit({ fs = makeFs(), dialogs = makeDialogs(), notify = makeNotify(), wm, seed, options } = {}) {
  const loaded = await loadWindowApp('textedit', {
    stubs: {
      extra: {
        FS: fs,
        SystemDialogs: dialogs,
        Notify: notify,
        ...(wm ? { WM: wm } : {}),
      },
    },
  });
  if (seed) loaded.window.localStorage.setItem(WRAP_KEY, seed);
  // initApp() can't forward the third `options` argument, so mirror what it
  // does (detached div + init call) and pass launch options through.
  const content = loaded.document.createElement('div');
  loaded.app.init(content, { cleanups: [] }, options);
  return { ...loaded, content, fs, dialogs, notify };
}

const editorOf = (content) => content.querySelector('#quill-text-editor');
const btnOf = (content, text) =>
  [...content.querySelectorAll('button')].find((b) => b.textContent === text);

function typeKey(window, target, init) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe("'TextEdit' app (js/apps/textedit)", () => {
  beforeEach(() => resetTestStorage());

  it('registers a full app descriptor with the host', async () => {
    const { app } = await loadWindowApp('textedit');
    expect(app).toBeTruthy();
    expect(app.id).toBe('com.astroos.textedit');
    expect(app.name).toBe('TextEdit');
    expect(app.version).toBe('3.0.2');
    expect(app.description).toBe('Text Editor');
    expect(app.icon).toBe('pen-tool');
    expect(app.defaultSize).toEqual([680, 500]);
    expect(app.minSize).toEqual([360, 260]);
    expect(typeof app.init).toBe('function');
    expect(typeof app.onDrop).toBe('function');
  });

  it('shows the missing-data-directory fallback when AppDirs is absent', async () => {
    const { app, window } = await loadWindowApp('textedit', { stubs: { AppDirs: null } });
    const content = initApp(app, { window, state: {} });
    expect(content.textContent).toContain('App data directory missing.');
    expect(content.querySelector('b').textContent).toBe('com.astroos.textedit');
  });

  it('renders the editor shell with gutter, status bar and toolbar', async () => {
    const { content } = await loadTextedit();
    expect(content.querySelector('.quill-container')).toBeTruthy();
    const editor = editorOf(content);
    expect(editor.getAttribute('aria-label')).toBe('Text editor');
    expect(editor.getAttribute('aria-multiline')).toBe('true');
    expect(btnOf(content, 'Save')).toBeTruthy();
    expect(btnOf(content, 'Save As…')).toBeTruthy();
    expect(btnOf(content, 'Open…')).toBeTruthy();
    expect(btnOf(content, 'Word Wrap')).toBeTruthy();
    // Fresh empty editor state.
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 1  ·  0 words');
    expect(content.querySelector('.quill-gutter').textContent).toBe('1');
  });

  it('toggles word wrap and persists the preference', async () => {
    const { content, window } = await loadTextedit();
    const editor = editorOf(content);
    const wrapBtn = btnOf(content, 'Word Wrap');
    expect(editor.getAttribute('wrap')).toBe('off');
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('false');

    wrapBtn.click();
    expect(editor.getAttribute('wrap')).toBe('soft');
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true');
    expect(wrapBtn.classList.contains('btn-primary')).toBe(true);
    expect(window.localStorage.getItem(WRAP_KEY)).toBe('true');

    wrapBtn.click();
    expect(editor.getAttribute('wrap')).toBe('off');
    expect(window.localStorage.getItem(WRAP_KEY)).toBe('false');

    // A load with the preference pre-seeded reads it at init.
    const reloaded = await loadTextedit({ seed: 'true' });
    expect(editorOf(reloaded.content).getAttribute('wrap')).toBe('soft');
  });

  it('updates the status bar (line/col/word count) and gutter as you type', async () => {
    const { content, window } = await loadTextedit();
    const editor = editorOf(content);

    // Assigning .value moves the caret to the end (browser behavior), so pin
    // it to the start before firing input, the way a real click would.
    editor.value = 'hello world foo bar';
    editor.setSelectionRange(0, 0);
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(40); // updates are batched into rAF

    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 1  ·  4 words');
    expect(content.querySelector('.quill-gutter').textContent).toBe('1');

    // Cursor at offset 13 → line 1, col 14.
    editor.setSelectionRange(13, 13);
    editor.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 14  ·  4 words');

    // Multi-line document updates both counters.
    editor.value = 'alpha beta\ngamma\ndelta';
    editor.setSelectionRange(17, 17); // start of 'delta'
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(40);
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 3, Col 1  ·  4 words');
    expect(content.querySelector('.quill-gutter').textContent).toBe('1\n2\n3');
  });

  it('auto-pairs brackets, wraps selections and skips over closers', async () => {
    const { content, window } = await loadTextedit();
    const editor = editorOf(content);

    typeKey(window, editor, { key: '(' });
    expect(editor.value).toBe('()');
    expect(editor.selectionStart).toBe(1);

    // The next opener is inserted at the cursor — inside the parens — and
    // the caret lands between the new pair (setRangeText 'end', then the
    // explicit s+1 correction in handleBracket).
    typeKey(window, editor, { key: '{' });
    expect(editor.value).toBe('({})');
    expect(editor.selectionStart).toBe(2);

    // Typing the closer in front of an identical closer skips over it.
    typeKey(window, editor, { key: '}' });
    expect(editor.value).toBe('({})');
    expect(editor.selectionStart).toBe(3);

    // Selection + opener wraps the selected text.
    editor.value = 'x';
    editor.setSelectionRange(0, 1);
    typeKey(window, editor, { key: '"' });
    expect(editor.value).toBe('"x"');
    expect(editor.selectionStart).toBe(1);
    expect(editor.selectionEnd).toBe(2);
  });

  it('inserts two spaces on Tab; selection indent hits the invalid-SelectionMode bug', async () => {
    const { content, window } = await loadTextedit();
    const editor = editorOf(content);

    // Collapsed cursor + Tab inserts two spaces (setRangeText 'end' path).
    editor.value = 'ab';
    editor.setSelectionRange(1, 1);
    typeKey(window, editor, { key: 'Tab' });
    expect(editor.value).toBe('a  b');
    expect(editor.selectionStart).toBe(3);

    // CURRENT-BEHAVIOUR NOTE (source bug, deliberately not fixed here):
    // applyTab's selection-indent and outdent paths call setRangeText with
    // 'ignore', which is not a member of the SelectionMode enum
    // (select|start|end|preserve) — jsdom rejects it and a real browser
    // throws a TypeError on the same call, so these branches are no-ops.
    editor.value = 'a\nb';
    editor.setSelectionRange(0, 3);
    typeKey(window, editor, { key: 'Tab' });
    expect(editor.value).toBe('a\nb'); // indent did not apply

    editor.value = '  x';
    editor.setSelectionRange(3, 3);
    typeKey(window, editor, { key: 'Tab', shiftKey: true });
    expect(editor.value).toBe('  x'); // outdent did not apply
  });

  it('saves a seeded file with FS.writeFile and keeps modifications tracked', async () => {
    const fs = makeFs();
    const { content, window } = await loadTextedit({ fs, options: { fileId: 'f1' } });
    const editor = editorOf(content);
    expect(editor.value).toBe('seeded file body');

    btnOf(content, 'Save').click();
    await settle(10);
    expect(fs.writes).toContainEqual(['f1', 'seeded file body']);

    // Editing then Ctrl+S saves the new content without a dialog.
    editor.value = 'seeded file body v2';
    editor.dispatchEvent(new window.Event('input', { bubbles: true }));
    typeKey(window, editor, { key: 's', ctrlKey: true });
    await settle(10);
    expect(fs.writes).toContainEqual(['f1', 'seeded file body v2']);
  });

  it('saves a new file via the Save As dialog and re-uses its id afterwards', async () => {
    const fs = makeFs();
    const dialogs = makeDialogs({ saveResult: { name: 'notes.txt', folderId: 'docdir' } });
    const { content } = await loadTextedit({ fs, dialogs });
    const editor = editorOf(content);
    editor.value = 'fresh content';

    btnOf(content, 'Save As…').click();
    await settle(20);

    expect(dialogs.calls.some(([kind, opts]) => kind === 'save' &&
      opts.title === 'Save As' && opts.suggestedName === 'untitled.txt' &&
      opts.startFolderId === '/data/com.astroos.textedit/files')).toBe(true);
    expect(fs.created).toContainEqual(['docdir', 'notes.txt', 'fresh content', 'text/plain']);

    // The saved id sticks: a subsequent Save goes straight to FS.writeFile.
    btnOf(content, 'Save').click();
    await settle(20);
    expect(fs.writes).toEqual([['new-1', 'fresh content']]);
  });

  it('opens a file through the dialog and reports failures via Notify', async () => {
    const dialogs = makeDialogs({
      openResult: { id: 'f9', name: 'readme.md', content: '# Hi', mimeType: 'text/markdown' },
    });
    const { content, notify } = await loadTextedit({ dialogs });

    btnOf(content, 'Open…').click();
    await settle(20);

    const editor = editorOf(content);
    expect(editor.value).toBe('# Hi');
    // Caret sits at the end of the loaded text (4) → col 5; '# Hi' is 2 words.
    expect(content.querySelector('.quill-statusbar').textContent).toBe('Ln 1, Col 5  ·  2 words');
    expect(notify.calls.some((n) => n.title === 'Opened' && n.body === 'readme.md')).toBe(true);

    // Failing dialog → 'Open Failed' notification, editor untouched.
    const failing = makeDialogs({ openError: new Error('permission denied') });
    const second = await loadTextedit({ dialogs: failing, notify });
    btnOf(second.content, 'Open…').click();
    await settle(20);
    expect(notify.calls.some((n) => n.title === 'Open Failed' && n.body === 'permission denied')).toBe(true);
  });

  it('imports dropped text files into the FS and opens a new window', async () => {
    const fs = makeFs();
    const wm = { calls: [], createWindow: (id, opts) => wm.calls.push([id, opts]) };
    const { app, notify } = await loadTextedit({ fs, wm });

    await app.onDrop({ name: 'dropped.txt', size: 7, type: 'text/plain', text: async () => 'dropped' }, {});
    await settle(10);

    const stored = [...fs.files.values()].find((f) => f.name === 'dropped.txt');
    expect(stored.content).toBe('dropped');
    expect(stored.mimeType).toBe('text/plain');
    expect(wm.calls).toContainEqual(['com.astroos.textedit', { fileId: stored.id }]);
    expect(notify.calls.some((n) => n.title === 'File Opened' && n.body === 'dropped.txt')).toBe(true);

    // A rejecting drop surfaces the error notification instead of throwing.
    await app.onDrop({ name: 'bad.txt', text: async () => { throw new Error('unreadable'); } }, {});
    expect(notify.calls.some((n) => n.title === 'Error' && n.body === 'unreadable')).toBe(true);
  });

  it('stops responding to editor commands after teardown', async () => {
    const fs = makeFs();
    const { content } = await loadTextedit({ fs, options: { fileId: 'f1' } });
    expect(content._destroy).toBeTypeOf('function');

    content._destroy();
    btnOf(content, 'Save').click();
    await settle(10);
    expect(fs.writes).toEqual([]); // listeners were aborted with the controller
  });
});
