/**
 * TextEdit  (com.nbosp.quill)  —  NovaByte OS
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewritten from scratch against JS 2026 best practices.
 *
 * Key improvements over original
 * ┌─ Memory / lifecycle ───────────────────────────────────────────────────────
 * │  • AbortController wires ALL listeners; ctrl.abort() on close removes them
 * │    in one call — no per-listener removeEventListener needed.
 * │  • cancelAnimationFrame guard cancels any pending RAF on destroy.
 * │
 * ├─ Performance ──────────────────────────────────────────────────────────────
 * │  • syncGutter:  early-exit if line count didn't change (hot path for
 * │    normal typing). charCode scan avoids regex GC. Pre-allocated Array
 * │    + .join() beats repeated string concatenation.
 * │  • syncStatus:  slice + lastIndexOf instead of character-by-character loop.
 * │  • scheduleUpdate:  collapses every input burst into one RAF frame — no
 * │    redundant gutter/status redraws mid-keystroke.
 * │  • All scroll / input listeners are { passive: true }.
 * │
 * ├─ Security / correctness ────────────────────────────────────────────────────
 * │  • Error UI uses Object.assign (no innerHTML with user data).
 * │  • Clipboard: navigator.clipboard (async, permission-aware) with
 * │    document.execCommand only as a last-resort fallback.
 * │  • Select All: textarea.select() — execCommand('selectAll') is deprecated.
 * │  • All async I/O (FS, showPrompt) wrapped in try/catch with user-visible
 * │    error notifications.
 * │  • Optional-chaining + nullish-coalescing throughout; no implicit coercion.
 * │
 * ├─ Bug fixes ─────────────────────────────────────────────────────────────────
 * │  • Word count: val.trim() before split — empty/whitespace-only text = 0.
 * │  • Word count notification: correct singular ("1 word" not "1 words").
 * │  • Auto-bracket symmetric pairs (', ", `): skip cursor forward when the
 * │    matching closer is already next — prevents double-close on re-entry.
 * │  • Auto-bracket: wraps a non-empty selection in the pair instead of
 * │    ignoring the selection (original did nothing with a selection).
 * │  • Asymmetric closers ), }, ]: skip forward instead of inserting duplicate.
 * │  • Shift+Tab: removes up to 2 leading spaces from current line.
 * │  • Tab on multi-line selection: indents / unindents every affected line;
 * │    trailing empty entry (selection ending at line boundary) is preserved.
 * │  • saveFileAs: trims the filename prompt result; ignores blank/cancel.
 * │
 * └─ Extras ────────────────────────────────────────────────────────────────────
 *    • textarea gets autocomplete/autocorrect/autocapitalize=off — prevents
 *      browser interference in a code/text editor context.
 *    • Status bar gets aria-live="polite" + aria-atomic="true" for a11y.
 *    • content._destroy hook for WM to call on window close.
 *    • PAIRS / OPENERS / ASYM_CLOSERS are frozen constants created once, not
 *      on every keydown.
 */

registerApp({
  id: 'quill', name: 'TextEdit', icon: 'pen-tool',
  description: 'Text Editor',
  defaultSize: [680, 500], minSize: [360, 260],

  /* ─── init ─────────────────────────────────────────────────────────────── */
  init(content, state, options) {

    // ── Runtime guard ────────────────────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.quill', 'files')) {
      Object.assign(content.style, {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', flexDirection: 'column', gap: '12px',
        fontFamily: 'var(--font-ui, sans-serif)', color: 'var(--text-muted, #888)'
      });
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center"><b>com.nbosp.quill</b>' +
        '<br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    // ── Immutable constants (frozen once; never recreated per keydown) ────────
    /** Open-bracket → close-bracket map */
    const PAIRS = Object.freeze({
      '(': ')', '{': '}', '[': ']', "'": "'", '"': '"', '`': '`'
    });
    /** Set of keys that open a pair */
    const OPENERS = new Set(Object.keys(PAIRS));
    /** Asymmetric closers: ), }, ] — keys that close but cannot open */
    const ASYM_CLOSERS = new Set(
      [...Object.values(PAIRS)].filter(c => !OPENERS.has(c))
    );

    // ── Mutable file state ───────────────────────────────────────────────────
    const file = { id: null, name: 'untitled.txt', content: '', modified: false };

    // ── Lifecycle handles ────────────────────────────────────────────────────
    /** Aborting this removes every event listener added with { signal } */
    const ctrl = new AbortController();
    const { signal } = ctrl;
    /** Pending requestAnimationFrame handle — cancelled on destroy */
    let rafId = 0;

    // ── Build DOM (once; never recreated) ────────────────────────────────────
    const container  = createEl('div',      { className: 'quill-container' });
    const toolbar    = createEl('div',      { className: 'quill-toolbar' });
    const saveBtn    = createEl('button',   {
      className: 'btn btn-sm btn-primary', textContent: 'Save', title: 'Save (Ctrl+S)'
    });
    const saveAsBtn  = createEl('button',   {
      className: 'btn btn-sm', textContent: 'Save As…', title: 'Save a copy with a new name'
    });
    const editorWrap = createEl('div',      { className: 'quill-editor-wrap' });
    const gutter     = createEl('div',      { className: 'quill-gutter', 'aria-hidden': 'true' });
    const textarea   = createEl('textarea', {
      className: 'quill-textarea', id: 'quill-text-editor', name: 'quill-editor',
      spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off',
      'aria-label': 'Text editor', role: 'textbox', 'aria-multiline': 'true'
    });
    const statusBar  = createEl('div', {
      className: 'quill-statusbar',
      role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'
    });

    toolbar.append(saveBtn, saveAsBtn);
    editorWrap.append(gutter, textarea);
    container.append(toolbar, editorWrap, statusBar);
    content.appendChild(container);

    // ── Gutter: incremental, line-count-gated ─────────────────────────────────
    /** Last rendered line count — guards DOM writes */
    let prevLineCount = 0;

    function syncGutter() {
      const val = textarea.value;
      // charCode scan avoids regex allocation on this hot path
      let count = 1;
      for (let i = 0; i < val.length; i++) {
        if (val.charCodeAt(i) === 10) count++; // '\n'
      }
      if (count === prevLineCount) return; // ← zero DOM writes if unchanged
      prevLineCount = count;
      // Pre-allocated array + join beats repeated string concatenation
      const nums = new Array(count);
      for (let i = 0; i < count; i++) nums[i] = i + 1;
      gutter.textContent = nums.join('\n') + '\n';
    }

    // ── Status bar ────────────────────────────────────────────────────────────
    function syncStatus() {
      const val    = textarea.value;
      const pos    = textarea.selectionStart;
      const before = val.slice(0, pos);
      // line: count \n occurrences before cursor
      const line   = (before.match(/\n/g)?.length ?? 0) + 1;
      // col: chars since last \n (or start-of-text)
      const col    = pos - (before.lastIndexOf('\n') + 1) + 1;
      // word count: trim first so whitespace-only text = 0 words
      const trimmed = val.trim();
      const words   = trimmed ? trimmed.split(/\s+/).length : 0;
      statusBar.textContent = `Ln ${line}, Col ${col}  ·  ${words} words`;
    }

    // ── RAF batching ──────────────────────────────────────────────────────────
    /** Collapses any number of rapid input events into one paint frame */
    function scheduleUpdate() {
      if (rafId) return; // already queued
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncGutter();
        syncStatus();
      });
    }

    // ── Platform helper ───────────────────────────────────────────────────────
    function getFilesDir() {
      return AppDirs.getVFSDir('com.nbosp.quill', 'files') ?? FS.specialFolders.documents;
    }

    // ── Atomic text mutation ──────────────────────────────────────────────────
    /** Single point through which all programmatic text changes pass */
    function spliceText(start, end, insert) {
      const val = textarea.value;
      textarea.value = val.slice(0, start) + insert + val.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
      file.modified = true;
      scheduleUpdate();
    }

    // ── Clipboard ─────────────────────────────────────────────────────────────
    async function doCopy() {
      const text = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      if (!text) return;
      try { await navigator.clipboard.writeText(text); }
      catch { document.execCommand('copy'); }
    }

    async function doCut() {
      const { selectionStart: s, selectionEnd: e } = textarea;
      if (s === e) return;
      await doCopy();
      spliceText(s, e, '');
    }

    async function doPaste() {
      try {
        const text = await navigator.clipboard.readText();
        const { selectionStart: s, selectionEnd: e } = textarea;
        spliceText(s, e, text);
      } catch { document.execCommand('paste'); }
    }

    // ── Tab / Shift-Tab: indent & unindent ────────────────────────────────────
    function applyTab(shiftKey) {
      const { selectionStart: s, selectionEnd: e } = textarea;
      const val = textarea.value;

      if (s === e) {
        // ── Single cursor ──────────────────────────────────────────────────
        if (shiftKey) {
          // Remove up to 2 leading spaces from the current line
          const lineStart = val.lastIndexOf('\n', s - 1) + 1;
          const lead = val.slice(lineStart, s).match(/^( {1,2})/)?.[1].length ?? 0;
          if (!lead) return;
          textarea.value = val.slice(0, lineStart) + val.slice(lineStart + lead);
          textarea.selectionStart = textarea.selectionEnd = s - lead;
        } else {
          textarea.value = val.slice(0, s) + '  ' + val.slice(s);
          textarea.selectionStart = textarea.selectionEnd = s + 2;
        }
      } else {
        // ── Multi-line selection ───────────────────────────────────────────
        const lineStart = val.lastIndexOf('\n', s - 1) + 1;
        const lines     = val.slice(lineStart, e).split('\n');
        let totalDiff = 0, firstDiff = 0;

        const newLines = lines.map((ln, idx) => {
          // Preserve trailing empty entry: selection ending at a line boundary
          // produces a split artifact ["...", ""] — don't add spaces to it.
          if (ln === '' && idx === lines.length - 1) return ln;

          if (shiftKey) {
            const stripped = ln.replace(/^ {1,2}/, '');
            const removed  = ln.length - stripped.length;
            if (idx === 0) firstDiff = -removed;
            totalDiff -= removed;
            return stripped;
          }
          if (idx === 0) firstDiff = 2;
          totalDiff += 2;
          return '  ' + ln;
        });

        textarea.value = val.slice(0, lineStart) + newLines.join('\n') + val.slice(e);
        // Clamp selectionStart so it never moves before the line's beginning
        textarea.selectionStart = Math.max(lineStart, s + firstDiff);
        textarea.selectionEnd   = e + totalDiff;
      }

      file.modified = true;
      scheduleUpdate();
    }

    // ── Auto-close brackets ───────────────────────────────────────────────────
    function handleBracket(key) {
      const close = PAIRS[key];
      const { selectionStart: s, selectionEnd: e } = textarea;
      const val = textarea.value;

      // Symmetric pair (', ", `) AND cursor already before the matching closer
      // → skip forward instead of inserting another pair.
      if (key === close && val[s] === key) {
        textarea.selectionStart = textarea.selectionEnd = s + 1;
        syncStatus();
        return;
      }

      if (s !== e) {
        // Non-empty selection: wrap it — e.g. `hello` → `[hello]`
        textarea.value = val.slice(0, s) + key + val.slice(s, e) + close + val.slice(e);
        textarea.selectionStart = s + 1;
        textarea.selectionEnd   = e + 1;
      } else {
        // Empty cursor: insert the pair and park cursor inside
        textarea.value = val.slice(0, s) + key + close + val.slice(s);
        textarea.selectionStart = textarea.selectionEnd = s + 1;
      }
      // Bracket insert never changes line count; update status col only
      syncStatus();
    }

    // ── Master keyboard handler ───────────────────────────────────────────────
    function onKeydown(e) {
      const { key, ctrlKey, metaKey, shiftKey } = e;

      // Ctrl/Cmd + S → save
      if ((ctrlKey || metaKey) && key === 's') {
        e.preventDefault();
        saveFile();
        return;
      }

      // Tab → indent / Shift-Tab → unindent
      if (key === 'Tab') {
        e.preventDefault();
        applyTab(shiftKey);
        return;
      }

      // Opening bracket → auto-close pair
      if (OPENERS.has(key)) {
        e.preventDefault();
        handleBracket(key);
        return;
      }

      // Asymmetric closer ) } ] → skip forward if already present at cursor
      if (
        ASYM_CLOSERS.has(key) &&
        textarea.selectionStart === textarea.selectionEnd &&
        textarea.value[textarea.selectionStart] === key
      ) {
        e.preventDefault();
        textarea.selectionStart = textarea.selectionEnd = textarea.selectionStart + 1;
        syncStatus();
      }
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    async function saveFile() {
      try {
        if (file.id) {
          await FS.writeFile(file.id, textarea.value);
          file.content = textarea.value;
          file.modified = false;
          Notify.show({ title: 'Saved', body: file.name, type: 'success', appName: 'TextEdit' });
        } else {
          await saveFileAs();
        }
      } catch (err) {
        Notify.show({
          title: 'Save Failed', body: err?.message ?? 'Unknown error',
          type: 'error', appName: 'TextEdit'
        });
      }
    }

    async function saveFileAs() {
      try {
        const name = (await showPrompt('Save As', file.name))?.trim();
        if (!name) return; // user cancelled or entered blank
        const node    = await FS.createFile(getFilesDir(), name, textarea.value, 'text/plain');
        file.id       = node.id;
        file.name     = name;
        file.content  = textarea.value;
        file.modified = false;
        renderDesktopIcons();
        Notify.show({ title: 'Saved', body: name, type: 'success', appName: 'TextEdit' });
      } catch (err) {
        Notify.show({
          title: 'Save Failed', body: err?.message ?? 'Unknown error',
          type: 'error', appName: 'TextEdit'
        });
      }
    }

    // ── Context menu ──────────────────────────────────────────────────────────
    function onContextMenu(e) {
      e.preventDefault();
      ContextMenu.show(e.clientX, e.clientY, [
        { label: 'Cut',        icon: 'scissors',  shortcut: 'Ctrl+X', action: doCut },
        { label: 'Copy',       icon: 'copy',      shortcut: 'Ctrl+C', action: doCopy },
        { label: 'Paste',      icon: 'documents', shortcut: 'Ctrl+V', action: doPaste },
        { separator: true },
        {
          label: 'Select All', icon: 'maximize', shortcut: 'Ctrl+A',
          // textarea.select() is standard; execCommand('selectAll') is deprecated
          action: () => { textarea.focus(); textarea.select(); }
        },
        { separator: true },
        {
          label: 'Word Count', icon: 'info',
          action: () => {
            const t = textarea.value.trim();
            const n = t ? t.split(/\s+/).length : 0;
            Notify.show({
              title: 'Word Count',
              body: `${n} word${n !== 1 ? 's' : ''}`,  // correct singular
              type: 'info', appName: 'TextEdit'
            });
          }
        }
      ]);
    }

    // ── Wire all events (AbortSignal = zero-leak teardown) ────────────────────
    saveBtn.addEventListener('click',          saveFile,       { signal });
    saveAsBtn.addEventListener('click',        saveFileAs,     { signal });
    editorWrap.addEventListener('contextmenu', onContextMenu,  { signal });
    editorWrap.addEventListener('click', e => {
      if (e.target === gutter) textarea.focus();
    }, { signal });

    // passive: true — browser never has to wait for these before scrolling/painting
    textarea.addEventListener('input',  () => { file.modified = true; scheduleUpdate(); },    { signal, passive: true });
    textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; },     { signal, passive: true });
    textarea.addEventListener('click',  syncStatus,  { signal, passive: true });
    textarea.addEventListener('keyup',  syncStatus,  { signal, passive: true });
    // keydown must NOT be passive — we call e.preventDefault() inside
    textarea.addEventListener('keydown', onKeydown,  { signal });

    // ── Load file passed via options ──────────────────────────────────────────
    if (options?.fileId) {
      const f = FS.files.get(options.fileId);
      if (f) {
        file.id       = f.id;
        file.name     = f.name;
        file.content  = f.content ?? '';
        file.modified = false;
        textarea.value = file.content;
      }
    }

    // Initial render
    syncGutter();
    syncStatus();
    requestAnimationFrame(() => textarea.focus());

    // ── Destroy hook (called by WM on window close) ───────────────────────────
    content._destroy = () => {
      ctrl.abort();                            // removes every listener at once
      if (rafId) cancelAnimationFrame(rafId); // no dangling frame after close
    };
  },

  /* ─── onDrop ────────────────────────────────────────────────────────────── */
  async onDrop(droppedFile, _state) {
    try {
      const text   = await droppedFile.text();
      const fileId = generateId();
      FS.files.set(fileId, {
        id:       fileId,
        name:     droppedFile.name,
        type:     'text/plain',
        size:     droppedFile.size,
        content:  text,
        mimeType: droppedFile.type || 'text/plain'
      });
      WM.createWindow('quill', { fileId });
      Notify.show({ title: 'File Opened', body: droppedFile.name, type: 'success', appName: 'TextEdit' });
    } catch (err) {
      Notify.show({
        title: 'Error', body: err?.message ?? 'Failed to open file.',
        type: 'error', appName: 'TextEdit'
      });
    }
  }
});