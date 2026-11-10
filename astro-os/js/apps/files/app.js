// Files app for AstroOS. A browser-style file manager: icon/list views,
// navigation history, context menus, drag-and-drop and keyboard shortcuts.
// Registered as the "files" app.

(() => {
  const FILES_DATA_DIR = 'files';
  const MAX_NAV_HISTORY = 100;
  const SEARCH_DEBOUNCE_MS = 150;
  const PATH_ERROR_FLASH_MS = 800;

  // Tag colour token used for the small status dot on file icons. Anything
  // outside this map falls back to the warning colour.
  const TAG_COLOR_TOKEN = {
    red: 'text-danger',
    green: 'text-success',
    blue: 'accent',
    yellow: 'text-warning',
  };

  // Characters we refuse in file names. Slashes are path separators; the
  // rest confuse shells or file systems on at least one major platform.
  const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/;

  // Extension → MIME fallback for dropped files whose type the browser could
  // not detect. Exposed as `_extMap` on the app descriptor for back-compat
  // with external callers that read it directly. Kept mutable so callers
  // that historically patched it still work.
  const EXT_TO_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
    tif: 'image/tiff', tiff: 'image/tiff',
    mp3: 'audio/mpeg', mp4: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav',
    flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
    opus: 'audio/ogg; codecs=opus', weba: 'audio/webm', webm: 'audio/webm',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
    json: 'application/json',
  };

  const DEFAULT_SYSTEM_FOLDERS = ['Downloads', 'Documents', 'Pictures', 'Music', 'Videos', 'System'];
  const LIST_HEADER_LABELS = ['Name', 'Size', 'Type', 'Modified'];
  const LIST_HEADER_SORT_KEYS = ['name', 'size', 'mime', 'modified'];

  function isViewOnly() {
    return Boolean(OS?.settings?.get?.('filesViewOnly'));
  }
  function isCopyDisabled() {
    return Boolean(OS?.settings?.get?.('disableClipboardCopy'));
  }
  function isPasteDisabled() {
    return Boolean(OS?.settings?.get?.('disableClipboardPaste'));
  }

  // A name is valid if it is a non-empty trimmed string, not "." or "..",
  // and contains none of the illegal characters.
  function isValidFileName(name) {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed !== name) return false;
    if (trimmed === '.' || trimmed === '..') return false;
    return !ILLEGAL_NAME_RE.test(trimmed);
  }

  // Thin wrapper kept for call-site readability; the actual logic lives on
  // FS (js/core/services/fs.js) so it can be shared with non-Files-app
  // callers like the desktop's empty-area "New File"/"New Folder" menu.
  function uniqueNameFor(destParentId, name, excludeId) {
    return FS.uniqueName(destParentId, name, excludeId);
  }

  // Host-disk counterpart to FS.uniqueName, for exportToHost's bulk path.
  // Same " (1)", " (2)"... convention, but driven by a plain Set of names
  // already seen (populated from fs.readdir, then grown in-place as the
  // batch claims names) instead of a Files listing.
  function uniqueHostName(existingNames, name) {
    if (!existingNames.has(name)) return name;

    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const base = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';

    let i = 1;
    let candidate;
    do {
      candidate = `${base} (${i})${ext}`;
      i++;
    } while (existingNames.has(candidate));
    return candidate;
  }

  function mimeToTypeLabel(mimeType) {
    if (!mimeType) return 'FILE';
    const sub = mimeType.split('/')[1];
    return sub ? sub.toUpperCase() : 'FILE';
  }

  // Show "—" for missing or non-numeric timestamps instead of today's date,
  // which is what `new Date(undefined).toLocaleDateString()` would produce.
  function formatModifiedDate(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
    return new Date(ts).toLocaleDateString();
  }

  function detectMimeFromName(name) {
    const dot = typeof name === 'string' ? name.lastIndexOf('.') : -1;
    if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
    const ext = name.slice(dot + 1).toLowerCase();
    return EXT_TO_MIME[ext] || 'application/octet-stream';
  }

  function isNovaPackage(name) {
    return typeof name === 'string' && name.toLowerCase().endsWith('.novaapp');
  }

  // HTML detection is case-insensitive so ".HTML" / ".Htm" also match.
  function isHtmlFile(node) {
    if (node?.type === 'folder') return false;
    const lower = (node?.name || '').toLowerCase();
    return lower.endsWith('.html') || lower.endsWith('.htm') || node?.mimeType === 'text/html';
  }

  function notifyBlocked(body) {
    Notify.show({ title: 'Blocked', body, type: 'warning', appName: 'Files' });
  }

  function notifyError(title, err) {
    Notify.show({ title, body: String(err?.message || err), type: 'error', appName: 'Files' });
  }

  class FilesApp {
    // ── Shell Bags (HKNU/shell/bags/files) ──────────────────────────
    // View mode + sort remembered across sessions, the way Explorer
    // remembers a folder's view. New persistence — no legacy channel: when
    // the registry engine is down readViewBag() returns null and the
    // defaults apply, so this degrades silently.
    static FILES_BAG_PATH = 'HKNU/shell/bags/files';

    static readViewBag() {
      try {
        const r = window.NovaRegistry;
        if (!r || typeof r.get !== 'function') return null;
        const bag = r.get(FilesApp.FILES_BAG_PATH);
        if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
        return bag;
      } catch { return null; }
    }

    persistViewState() {
      try {
        const r = window.NovaRegistry;
        if (!r || typeof r.set !== 'function') return false;
        r.set(FilesApp.FILES_BAG_PATH, { viewMode: this.viewMode, sortBy: this.sortBy, sortAsc: this.sortAsc },
          { type: 'REG_JSON', source: 'shell-bags' });
        return true;
      } catch { return false; }
    }

    constructor(content, state, options = {}) {
      this.content = content;
      this.state = state;
      this.options = options;

      // The OS calls every function in state.cleanups when the window
      // closes. We push a single dispose() so all teardown paths go through
      // one place.
      if (!Array.isArray(state.cleanups)) state.cleanups = [];
      state.cleanups.push(() => this.dispose());

      // One AbortController governs every listener we attach. dispose() is
      // just `ac.abort()` — no per-listener bookkeeping.
      this.ac = new AbortController();
      this.signal = this.ac.signal;

      // Pending setTimeout handles. Cleared on dispose so we never fire a
      // callback into a detached DOM tree.
      this.timers = new Set();
      this.searchTimer = null;

      // UI state — view mode + sort are Shell Bags (HKNU/shell/bags/files):
      // Explorer-"Bags" persistence so the Files app reopens the way the
      // user left it. Validated against the allowed values; when the
      // registry engine is down the defaults below simply apply.
      this.viewMode = 'icon';
      this.sortBy = 'name';
      this.sortAsc = true;
      const filesBag = FilesApp.readViewBag();
      if (filesBag) {
        if (filesBag.viewMode === 'icon' || filesBag.viewMode === 'list') this.viewMode = filesBag.viewMode;
        if (['name', 'size', 'mime', 'modified'].includes(filesBag.sortBy)) this.sortBy = filesBag.sortBy;
        if (typeof filesBag.sortAsc === 'boolean') this.sortAsc = filesBag.sortAsc;
      }
      this.selectedIds = new Set();
      this.clipboardOp = null;
      this.isRenaming = false;
      this.currentFilesCache = [];
      this._disposed = false;

      // Navigation history, capped to avoid unbounded growth in long
      // browsing sessions.
      const startFolder = options.folderId || FS.rootId;
      this.nav = { cwd: startFolder, history: [startFolder], historyIdx: 0 };
      // Exposed for the onDrop handler so it knows which folder to drop into.
      state._nav = this.nav;
      // Exposed for tests and host tooling — the descriptor's init() creates
      // the instance internally, so this is the only handle to it.
      state.filesApp = this;
    }

    // setTimeout that auto-cancels on dispose.
    later(fn, ms) {
      const id = setTimeout(() => {
        this.timers.delete(id);
        fn();
      }, ms);
      this.timers.add(id);
      return id;
    }

    cancelTimer(id) {
      clearTimeout(id);
      this.timers.delete(id);
    }

    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      this.ac.abort();
      for (const id of this.timers) clearTimeout(id);
      this.timers.clear();
      this.searchTimer = null;
      if (this.state) this.state._nav = null;
    }

    mount() {
      // AstroOS runtime guard — refuse to launch without AppDirs.
      if (!window.AppDirs?.getAppDataPath?.('com.astroos.files', FILES_DATA_DIR)) {
        this.renderMissingRuntimeNotice();
        return;
      }
      this.buildUI();
      this.wireToolbar();
      this.wireFileArea();
      this.wireGlobalShortcuts();
      this.wireFsChangeListeners();
      // Default folders are best-effort: failures are logged but do not
      // block the initial paint.
      this.ensureDefaultSystemFolders()
        .catch(err => console.error('[Files] ensureDefaultSystemFolders failed:', err))
        .finally(() => {
          try { this.renderFiles(); }
          catch (err) { console.error('[Files] initial renderFiles failed:', err); }
        });
    }

    // Hard-fail screen shown when the AstroOS runtime isn't present.
    // Built with DOM APIs rather than innerHTML so there's no string-built
    // markup to leak into the page.
    renderMissingRuntimeNotice() {
      const c = this.content;
      c.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      c.replaceChildren();
      const icon = createEl('div', { style: 'font-size:32px', textContent: '⚠️' });
      const text = createEl('div', { style: 'font-size:14px;text-align:center' });
      text.append(
        createEl('b', { textContent: 'com.astroos.files' }),
        createEl('br'),
        document.createTextNode('App data directory missing.'),
        createEl('br'),
        document.createTextNode('This app requires AstroOS.')
      );
      c.append(icon, text);
    }

    buildUI() {
      const root = createEl('div', { className: 'vault-app-root', style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
      this.content.appendChild(root);
      this.root = root;

      // Toolbar: back · up · path bar · search
      const toolbar = createEl('div', { className: 'browser-toolbar' });
      this.toolbar = toolbar;

      this.backBtn = createEl('button', { className: 'browser-nav-btn', title: 'Back', 'aria-label': 'Back' });
      this.backBtn.innerHTML = svgIcon('chevron-left', 16);
      this.upBtn = createEl('button', { className: 'browser-nav-btn', title: 'Up', 'aria-label': 'Parent folder' });
      this.upBtn.innerHTML = svgIcon('chevron-up', 16);

      const pathBarWrap = createEl('div', { className: 'browser-url-bar-wrap' });
      this.pathBar = createEl('input', {
        className: 'browser-url-bar',
        id: 'file-browser-path-input',
        name: 'file-browser-path',
        'aria-label': 'Current path',
        spellcheck: 'false',
        placeholder: '/',
      });
      const pathIcon = createEl('span', { className: 'browser-url-icon' });
      pathIcon.innerHTML = svgIcon('folder', 14);
      pathBarWrap.append(this.pathBar, pathIcon);

      this.searchInput = createEl('input', {
        className: 'browser-url-bar',
        id: 'file-browser-search-input',
        name: 'file-browser-search',
        style: 'max-width:140px;',
        placeholder: 'Search…',
        'aria-label': 'Search files',
      });

      // Empty Trash: only shown while browsing the Trash folder itself.
      this.emptyTrashBtn = createEl('button', {
        className: 'browser-nav-btn',
        title: 'Empty Trash',
        'aria-label': 'Empty Trash',
        style: 'display:none;',
      });
      this.emptyTrashBtn.innerHTML = svgIcon('trash', 16);

      toolbar.append(this.backBtn, this.upBtn, pathBarWrap, this.searchInput, this.emptyTrashBtn);
      root.appendChild(toolbar);

      // Files area: icon view + list view (only one visible at a time)
      const filesWrap = createEl('div', { style: 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;' });

      this.filesGrid = createEl('div', {
        className: 'vault-files',
        role: 'grid',
        'aria-label': 'Files',
        style: 'display:grid;',
        tabindex: '0',
      });

      this.listView = createEl('div', { style: 'display:none;flex:1;overflow:auto;flex-direction:column;' });
      const listHeader = createEl('div', {
        style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;background:var(--bg-sunken);border-bottom:1px solid var(--border-subtle);flex-shrink:0;position:sticky;top:0;z-index:1;',
        role: 'row',
      });
      LIST_HEADER_LABELS.forEach((label, i) => {
        const key = LIST_HEADER_SORT_KEYS[i];
        const th = createEl('button', {
          style: 'padding:6px 12px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);background:none;border:none;cursor:pointer;',
          textContent: label,
          'aria-label': `Sort by ${label}`,
        });
        th.addEventListener('click', () => {
          if (this.sortBy === key) this.sortAsc = !this.sortAsc;
          else { this.sortBy = key; this.sortAsc = true; }
          this.persistViewState();
          this.renderFiles();
        }, { signal: this.signal });
        listHeader.appendChild(th);
      });
      this.listBody = createEl('div', { style: 'flex:1;overflow-y:auto;' });
      this.listView.append(listHeader, this.listBody);

      filesWrap.append(this.filesGrid, this.listView);
      root.appendChild(filesWrap);

      // Status bar — implicit aria-live polite via role="status".
      this.statusBar = createEl('div', { className: 'vault-statusbar', role: 'status' });
      root.appendChild(this.statusBar);
    }

    wireToolbar() {
      this.backBtn.addEventListener('click', () => this.goBack(), { signal: this.signal });
      this.upBtn.addEventListener('click', () => this.goUp(), { signal: this.signal });
      this.emptyTrashBtn.addEventListener('click', () => this.emptyTrash(), { signal: this.signal });

      this.pathBar.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const trimmed = this.pathBar.value.trim();
          const node = FS.getByPath(trimmed);
          if (node) {
            this.navigateTo(node.id);
          } else {
            this.pathBar.style.color = 'var(--text-danger)';
            this.later(() => { this.pathBar.style.color = ''; }, PATH_ERROR_FLASH_MS);
          }
          this.filesGrid.focus();
        } else if (e.key === 'Escape') {
          this.updatePathBar();
          this.filesGrid.focus();
        }
      }, { signal: this.signal });

      // Debounced search input — avoids re-rendering on every keystroke.
      this.searchInput.addEventListener('input', () => {
        if (this.searchTimer) this.cancelTimer(this.searchTimer);
        this.searchTimer = this.later(() => {
          this.searchTimer = null;
          this.renderFiles(this.searchInput.value.trim());
        }, SEARCH_DEBOUNCE_MS);
      }, { signal: this.signal });
    }

    // Navigation
    navigateTo(folderId) {
      if (!folderId || folderId === this.nav.cwd) {
        // Even a no-op navigation refreshes selection state for safety.
        this.selectedIds.clear();
        this.renderFiles();
        return;
      }
      this.nav.cwd = folderId;
      // Drop any forward history when navigating to a new location.
      if (this.nav.historyIdx < this.nav.history.length - 1) {
        this.nav.history = this.nav.history.slice(0, this.nav.historyIdx + 1);
      }
      this.nav.history.push(folderId);
      // Cap history to keep memory bounded over a long browsing session.
      while (this.nav.history.length > MAX_NAV_HISTORY) {
        this.nav.history.shift();
        this.nav.historyIdx = Math.max(0, this.nav.historyIdx - 1);
      }
      this.nav.historyIdx = this.nav.history.length - 1;
      this.selectedIds.clear();
      this.renderFiles();
    }

    goBack() {
      if (this.nav.historyIdx <= 0) return;
      this.nav.historyIdx--;
      this.nav.cwd = this.nav.history[this.nav.historyIdx];
      this.selectedIds.clear();
      this.renderFiles();
    }

    goUp() {
      const node = FS.files.get(this.nav.cwd);
      if (node?.parentId) this.navigateTo(node.parentId);
    }

    updatePathBar() {
      // Don't clobber the user's in-progress input.
      if (document.activeElement !== this.pathBar) {
        this.pathBar.value = FS.getPath(this.nav.cwd);
      }
    }

    // Ensure the canonical system folders exist at the root. Best-effort:
    // a failure on one folder does not abort the rest.
    async ensureDefaultSystemFolders() {
      if (this.nav.cwd !== FS.rootId) return;
      const existing = FS.listDir(FS.rootId);
      for (const name of DEFAULT_SYSTEM_FOLDERS) {
        const exists = existing.some(item => item.name === name && item.type === 'folder');
        if (exists) continue;
        try {
          await FS.createFolder(FS.rootId, name);
        } catch (err) {
          console.error(`[Files] Could not create default folder "${name}":`, err);
        }
      }
    }

    // Sort folders above files, then by the active key in the active
    // direction.
    sortFiles(files) {
      return [...files].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        let cmp = 0;
        switch (this.sortBy) {
          case 'name': cmp = a.name.localeCompare(b.name); break;
          case 'size': cmp = (a.size || 0) - (b.size || 0); break;
          case 'mime': cmp = (a.mimeType || '').localeCompare(b.mimeType || ''); break;
          case 'modified': cmp = (a.modified || 0) - (b.modified || 0); break;
        }
        return this.sortAsc ? cmp : -cmp;
      });
    }

    // Inline rename. Commit is idempotent: Enter and blur can both fire and
    // would otherwise double-apply the rename.
    async inlineRename(fileNode, nameEl) {
      if (isViewOnly()) {
        notifyBlocked('Renaming disabled by policy.');
        return;
      }
      if (this.isRenaming || !nameEl) return;
      this.isRenaming = true;

      const oldName = fileNode.name;
      const input = createEl('input', {
        id: 'file-rename-input',
        name: 'file-rename',
        value: oldName,
        style: 'width:100%;background:var(--bg-base);border:1px solid var(--accent);border-radius:4px;padding:1px 4px;font-size:11px;color:var(--text-primary);outline:none;',
        'aria-label': 'Rename file',
      });

      nameEl.replaceChildren(input);
      input.focus();
      input.select();

      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        const newName = input.value.trim();
        this.isRenaming = false;
        if (!newName || newName === oldName) {
          this.renderFiles();
          return;
        }
        if (!isValidFileName(newName)) {
          Notify.show({
            title: 'Invalid name',
            body: 'That name contains characters that are not allowed.',
            type: 'warning', appName: 'Files',
          });
          this.renderFiles();
          return;
        }
        try {
          await FS.rename(fileNode.id, newName);
          if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
        } catch (err) {
          console.error('[Files] rename failed:', err);
          notifyError('Rename failed', err);
        }
        this.renderFiles();
      };

      input.addEventListener('blur', commit, { signal: this.signal });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          committed = true;
          this.isRenaming = false;
          this.renderFiles();
        }
      }, { signal: this.signal });
    }

    updateSelectionVisuals() {
      if (this.viewMode === 'icon') {
        for (const item of this.filesGrid.children) {
          const node = item._fileNode;
          if (node) item.classList.toggle('selected', this.selectedIds.has(node.id));
        }
      } else {
        for (const row of this.listBody.children) {
          const node = row._fileNode;
          if (!node) continue;
          const isSel = this.selectedIds.has(node.id);
          // Toggle a class for state queries (e.g. ".vault-list-row.selected")
          // AND set the inline background so the visual is byte-identical.
          row.classList.toggle('selected', isSel);
          row.style.background = isSel ? 'var(--accent-muted)' : '';
        }
      }

      const selCount = this.selectedIds.size;
      const total = this.currentFilesCache.length;
      if (selCount > 0) {
        let totalSize = 0;
        for (const f of this.currentFilesCache) {
          if (this.selectedIds.has(f.id)) totalSize += (f.size || 0);
        }
        this.statusBar.textContent = `${selCount} of ${total} selected${totalSize > 0 ? ' — ' + formatBytes(totalSize) : ''}`;
      } else {
        this.statusBar.textContent = `${total} item${total !== 1 ? 's' : ''}`;
      }
    }

    // Single-click toggles selection (with modifier) or selects only the
    // clicked file (without modifier). Clicking an already-selected file
    // without a modifier preserves the current selection.
    toggleSelection(fileId, additive) {
      if (additive) {
        if (this.selectedIds.has(fileId)) this.selectedIds.delete(fileId);
        else this.selectedIds.add(fileId);
      } else if (!this.selectedIds.has(fileId)) {
        this.selectedIds.clear();
        this.selectedIds.add(fileId);
      }
      this.updateSelectionVisuals();
    }

    // Resolve the icon to show for a file. App-shortcut .lnk files store the
    // pinned app's icon in their JSON content (see desktop.js), so use that
    // instead of FS.getMimeIcon(), which has no case for
    // 'application/x-app-shortcut' and would otherwise fall back to the
    // generic file icon for every shortcut.
    resolveFileIcon(f) {
      if (f.name?.endsWith('.lnk') && f.mimeType === 'application/x-app-shortcut') {
        try {
          const data = JSON.parse(f.content);
          if (data?.type === 'app-shortcut' && data.icon) return data.icon;
        } catch { /* not a valid shortcut, fall through to mime icon */ }
      }
      return FS.getMimeIcon(f.mimeType, f.name);
    }

    // Icon view
    renderFileList(files) {
      this.filesGrid.replaceChildren();
      if (!files.length) {
        const empty = createEl('div', {
          style: 'grid-column:1/-1;text-align:center;color:var(--text-muted);padding:40px;font-size:13px;',
          textContent: 'This folder is empty',
        });
        this.filesGrid.appendChild(empty);
        this.statusBar.textContent = 'Empty';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const f of files) {
        const item = createEl('div', {
          className: 'vault-file' + (this.selectedIds.has(f.id) ? ' selected' : ''),
          role: 'gridcell',
          tabindex: '0',
        });
        item._fileNode = f;

        const iconDiv = createEl('div', { className: 'vault-file-icon', style: 'position:relative;' });
        iconDiv.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : this.resolveFileIcon(f), 36);
        const tag = f.tags?.[0];
        if (tag) {
          const token = TAG_COLOR_TOKEN[tag] || 'text-warning';
          const dot = createEl('div', { style: `position:absolute;bottom:2px;right:2px;width:8px;height:8px;border-radius:50%;background:var(--${token});` });
          iconDiv.appendChild(dot);
        }

        const nameDiv = createEl('div', { className: 'vault-file-name', textContent: f.name });
        item.append(iconDiv, nameDiv);
        fragment.appendChild(item);
      }
      this.filesGrid.appendChild(fragment);
      this.updateSelectionVisuals();
    }

    // List view
    renderListView(files) {
      this.listBody.replaceChildren();
      const fragment = document.createDocumentFragment();
      for (const f of files) {
        const row = createEl('div', {
          // vault-list-row is a stable hook for delegation/hover; the inline
          // styles still own the visuals so the rendered look is unchanged.
          className: 'vault-list-row',
          style: 'display:grid;grid-template-columns:1fr 80px 120px 110px;align-items:center;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background var(--t-fast);',
          role: 'row',
        });
        row._fileNode = f;

        const nameCell = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;min-width:0;' });
        const ic = createEl('span', { style: 'flex-shrink:0;color:var(--text-muted);' });
        ic.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : this.resolveFileIcon(f), 16);
        const nm = createEl('span', {
          className: 'vault-list-row-name',
          style: 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
          textContent: f.name,
        });
        nameCell.append(ic, nm);

        const sizeCell = createEl('div', {
          style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);',
          textContent: f.type === 'folder' ? '—' : formatBytes(f.size || 0),
        });
        const typeCell = createEl('div', {
          style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
          textContent: f.type === 'folder' ? 'Folder' : mimeToTypeLabel(f.mimeType),
        });
        const dateCell = createEl('div', {
          style: 'padding:6px 12px;font-size:12px;color:var(--text-secondary);',
          textContent: formatModifiedDate(f.modified),
        });

        row.append(nameCell, sizeCell, typeCell, dateCell);
        fragment.appendChild(row);
      }
      this.listBody.appendChild(fragment);
      this.updateSelectionVisuals();
    }

    wireFileArea() {
      // Single delegated handler set per parent, torn down via AbortController.
      this.attachDelegatedHandlers(this.filesGrid);
      this.attachDelegatedHandlers(this.listBody);

      // Hover highlight in list view. CSS would be cleaner but the original
      // used inline styles, so we keep the same visual path.
      this.listBody.addEventListener('mouseenter', (e) => {
        const row = e.target.closest?.('.vault-list-row');
        if (row?._fileNode && !this.selectedIds.has(row._fileNode.id)) {
          row.style.background = 'rgba(255,255,255,0.04)';
        }
      }, { capture: true, signal: this.signal });
      this.listBody.addEventListener('mouseleave', (e) => {
        const row = e.target.closest?.('.vault-list-row');
        if (row?._fileNode && !this.selectedIds.has(row._fileNode.id)) {
          row.style.background = '';
        }
      }, { capture: true, signal: this.signal });

      // Empty-area (background) context menu — only when the click lands on
      // the grid itself, not on a file item.
      this.filesGrid.addEventListener('contextmenu', (e) => {
        if (e.target !== this.filesGrid) return;
        e.preventDefault();
        this.showEmptyAreaContextMenu(e.clientX, e.clientY);
      }, { signal: this.signal });

      // Forward list-view empty-area context menu to the same handler.
      this.listBody.addEventListener('contextmenu', (e) => {
        if (e.target !== this.listBody) return;
        e.preventDefault();
        this.showEmptyAreaContextMenu(e.clientX, e.clientY);
      }, { signal: this.signal });
    }

    attachDelegatedHandlers(parent) {
      parent.addEventListener('click', (e) => {
        const item = e.target.closest?.('.vault-file, .vault-list-row');
        if (!item?._fileNode) return;
        this.toggleSelection(item._fileNode.id, e.shiftKey || e.ctrlKey || e.metaKey);
      }, { signal: this.signal });

      parent.addEventListener('dblclick', (e) => {
        const item = e.target.closest?.('.vault-file, .vault-list-row');
        if (!item?._fileNode) return;
        const f = item._fileNode;
        if (f.type === 'folder') this.navigateTo(f.id);
        else openFileWithDefaultApp(f);
      }, { signal: this.signal });

      parent.addEventListener('contextmenu', (e) => {
        const item = e.target.closest?.('.vault-file, .vault-list-row');
        if (!item?._fileNode) return;
        e.preventDefault();
        e.stopPropagation();
        const f = item._fileNode;
        // Right-click selects only the clicked file if it isn't already
        // part of the selection (Windows-like behaviour). If it is already
        // selected, leave the multi-selection intact so bulk actions still
        // work.
        if (!this.selectedIds.has(f.id)) {
          this.selectedIds.clear();
          this.selectedIds.add(f.id);
          this.updateSelectionVisuals();
        }
        this.showFileContextMenu(e.clientX, e.clientY, f);
      }, { signal: this.signal });
    }

    // Main render. Called whenever the cwd, sort, view mode, selection, or
    // search query changes.
    renderFiles(searchQuery) {
      this.updatePathBar();
      let files = FS.listDir(this.nav.cwd);
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        files = files.filter(f => f.name.toLowerCase().includes(q));
      }
      this.currentFilesCache = this.sortFiles(files);

      const inTrash = this.nav.cwd === FS.specialFolders.trash;
      this.emptyTrashBtn.style.display = inTrash ? '' : 'none';
      if (inTrash) this.emptyTrashBtn.disabled = FS.listDir(this.nav.cwd).length === 0;

      this.filesGrid.style.display = this.viewMode === 'icon' ? 'grid' : 'none';
      this.listView.style.display = this.viewMode === 'list' ? 'flex' : 'none';

      if (this.viewMode === 'icon') this.renderFileList(this.currentFilesCache);
      else this.renderListView(this.currentFilesCache);
    }

    // Per-file context menu
    showFileContextMenu(x, y, f) {
      const inTrash = this.nav.cwd === FS.specialFolders.trash;
      const items = [
        {
          label: 'Open', icon: 'eye',
          action: () => {
            if (f.type === 'folder') this.navigateTo(f.id);
            else openFileWithDefaultApp(f);
          },
        },
      ];
      if (f.type === 'file') {
        items.push({
          label: 'Open with...', icon: 'external-link',
          action: () => showOpenWithDialog(f),
        });
        const selectedFileIds = new Set(
          [...this.selectedIds].filter(id => {
            const n = FS.files.get(id);
            return n && n.type === 'file';
          })
        );
        selectedFileIds.add(f.id);
        const count = selectedFileIds.size;
        items.push({
          label: count > 1 ? `Export ${count} Files to Host…` : 'Export to Host…',
          icon: 'download',
          action: () => this.exportToHost([...selectedFileIds]),
        });
      }
      if (isHtmlFile(f)) {
        items.push({ label: 'Edit in Text Editor', icon: 'pen', action: () => WM.createWindow('textedit', { fileId: f.id }) });
      }
      items.push({ separator: true });
      items.push({
         label: 'Rename', icon: 'rename', shortcut: 'F2',
        action: () => this.startRename(f),
      });
      items.push({
        label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C',
        action: () => this.copyFile(f),
      });
      items.push({
        label: 'Move', icon: 'move', shortcut: 'Ctrl+X',
        action: () => this.cutFile(f),
      });
      items.push({ separator: true });
      if (inTrash) {
        items.push(
          { label: 'Restore', icon: 'refresh', action: () => this.restoreFromTrash(f) },
          {
            label: 'Delete Permanently', icon: 'trash', danger: true,
            action: () => this.permanentlyDelete(f),
          }
        );
      } else {
        items.push({
          label: 'Move to Trash', icon: 'trash', danger: true, shortcut: 'Del',
          action: () => this.trashSelected(f),
        });
      }
      ContextMenu.show(x, y, items);
    }

    // Find the inline name element for a given file node across whichever
    // view is active. Returns null if the node isn't currently rendered.
    findRenameTargetForNode(node) {
      if (!node) return null;
      if (this.viewMode === 'icon') {
        for (const item of this.filesGrid.children) {
          if (item._fileNode?.id === node.id) return item.querySelector('.vault-file-name');
        }
        return null;
      }
      for (const row of this.listBody.children) {
        if (row._fileNode?.id === node.id) return row.querySelector('.vault-list-row-name');
      }
      return null;
    }

    // Find the inline name element for the first selected file. Used by the
    // F2 keyboard shortcut.
    findRenameTargetForSelection() {
      if (this.viewMode === 'icon') {
        const item = this.filesGrid.querySelector('.vault-file.selected');
        if (!item?._fileNode) return null;
        const nameEl = item.querySelector('.vault-file-name');
        return nameEl ? { node: item._fileNode, nameEl } : null;
      }
      const row = this.listBody.querySelector('.vault-list-row.selected');
      if (!row?._fileNode) return null;
      const nameEl = row.querySelector('.vault-list-row-name');
      return nameEl ? { node: row._fileNode, nameEl } : null;
    }

    startRename(f) {
      if (isViewOnly()) {
        notifyBlocked('Renaming disabled.');
        return;
      }
      const nameEl = this.findRenameTargetForNode(f);
      if (nameEl) {
        this.inlineRename(f, nameEl);
        return;
      }
      // Fall back to a prompt if the file's DOM node can't be found (e.g.
      // it was scrolled out of view in list mode and the query missed).
      showPrompt('Rename', f.name)
        .then(async (name) => {
          if (!name || name === f.name) return;
          if (!isValidFileName(name)) {
            notifyBlocked('That name is not valid.');
            return;
          }
          try {
            await FS.rename(f.id, name);
            this.renderFiles();
            if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
          } catch (err) {
            console.error('[Files] rename failed:', err);
            notifyError('Rename failed', err);
          }
        })
        .catch(err => console.error('[Files] rename prompt failed:', err));
    }

    copyFile(f) {
      if (isCopyDisabled()) {
        notifyBlocked('Copy disabled.');
        return;
      }
      this.clipboardOp = { type: 'copy', fileId: f.id };
      OS.clipboard = this.clipboardOp;
      Notify.show({ title: 'Copied', body: f.name + ' copied', type: 'info', appName: 'Files' });
    }

    cutFile(f) {
      this.clipboardOp = { type: 'cut', fileId: f.id };
      OS.clipboard = this.clipboardOp;
      Notify.show({ title: 'Cut', body: f.name + ' ready to move', type: 'info', appName: 'Files' });
    }

    // Writes one or more files' bytes out to the real host filesystem.
    // This runs in the Files app's own top-level shell window (a real Node
    // frame — unlike a .novaapp's sandboxed <webview>), so it can drive
    // NW.js's native dialogs + Node's fs module directly instead of going
    // through the nova:download IPC bridge that sandboxed apps need.
    //
    // Single file: SystemDialogs' Save As — lets the user
    // rename on the way out; we confirm before overwriting.
    // Multiple files: a single SystemDialogs folder chooser picks one destination
    // folder, then every file is written into it. Before writing, the
    // destination folder is listed once (fs.readdir) so a name that
    // already exists there — or that collides with another file in this
    // same batch — gets suffixed " (1)", " (2)", etc., the same convention
    // FS.uniqueName uses for its storage backend. Nothing at the destination is ever
    // silently overwritten.
    async exportToHost(target) {
      const ids = Array.isArray(target) ? target : [target.id];
      const nodes = ids
        .map(id => (typeof id === 'string' ? FS.files.get(id) : id))
        .filter(n => n && n.type === 'file');
      if (!nodes.length) return;

      if (nodes.length === 1) {
        const ok = await this.exportOneToHost(nodes[0]);
        if (ok) {
          Notify.show({ title: 'Exported', body: `${nodes[0].name} saved to host`, type: 'success', appName: 'Files' });
        }
        return;
      }

      const destDir = await this.pickHostDirectory();
      if (!destDir) return; // user cancelled the folder picker

      const path = require('path');
      const fs = require('fs');

      // One directory listing up front, rather than a stat-per-file — also
      // lets us dedupe against names claimed earlier in this same loop.
      let existingNames;
      try {
        existingNames = new Set(await new Promise((resolve, reject) => {
          fs.readdir(destDir, (err, entries) => (err ? reject(err) : resolve(entries)));
        }));
      } catch (err) {
        console.error('[Files] could not list destination directory:', err);
        notifyError('Export failed', err);
        return;
      }

      let saved = 0;
      let failed = 0;
      for (const node of nodes) {
        let buffer;
        try {
          buffer = Buffer.from(node.content ?? '');
        } catch {
          failed++;
          continue;
        }
        const finalName = uniqueHostName(existingNames, node.name);
        existingNames.add(finalName); // claimed for the rest of this batch too
        const destPath = path.join(destDir, finalName);
        try {
          // eslint-disable-next-line no-await-in-loop -- writes must not race each other under the same directory handle
          await new Promise((resolve, reject) => {
            fs.writeFile(destPath, buffer, (err) => (err ? reject(err) : resolve()));
          });
          saved++;
        } catch (err) {
          console.error('[Files] export failed for', node.name, err);
          failed++;
        }
      }

      const parts = [`${saved} saved`];
      if (failed) parts.push(`${failed} failed`);
      Notify.show({
        title: 'Export complete', body: parts.join(', '),
        type: failed && !saved ? 'error' : (failed ? 'warning' : 'success'),
        appName: 'Files',
      });
    }

    // Folder chooser via the in-shell SystemDialogs (no native OS dialog).
    // Resolves the chosen absolute path, or null if the user cancelled.
    async pickHostDirectory() {
      const picked = await SystemDialogs.open({ title: 'Choose Destination Folder', directory: true });
      return picked ? picked.path : null;
    }

    // Exports a single file node through SystemDialogs' Save As, resolving
    // true on success, false on cancel/error. node.content is either a
    // string (text files) or a Uint8Array (binary files dropped in from
    // the host) — Buffer.from handles both. SystemDialogs doesn't prompt on
    // overwrite, so the check lives here.
    async exportOneToHost(node) {
      let buffer;
      try {
        buffer = Buffer.from(node.content ?? '');
      } catch (err) {
        notifyError('Export failed', err);
        return false;
      }

      const dest = await SystemDialogs.save({
        title: 'Export File',
        suggestedName: node.name || 'export',
      });
      if (!dest) return false;

      const fs = require('fs');
      if (fs.existsSync(dest.path)) {
        const ok = await showModal('Replace file?', `${dest.name} already exists. Replace it?`, [
          { label: 'Cancel', value: false },
          { label: 'Replace', value: true, primary: true },
        ]);
        if (!ok) return false;
      }
      try {
        await fs.promises.writeFile(dest.path, buffer);
        return true;
      } catch (err) {
        notifyError('Export failed', err);
        return false;
      }
    }

    // Restore from trash: persist first, then update the UI. If persistence
    // fails, roll back the in-memory mutation so the UI stays consistent
    // with storage.
    async restoreFromTrash(f) {
      const desktop = FS.specialFolders.desktop;
      if (!desktop) {
        Notify.show({ title: 'Cannot restore', body: 'Desktop folder is unavailable.', type: 'error', appName: 'Files' });
        return;
      }
      const originalParentId = f.parentId;
      f.parentId = desktop;
      try {
        FS.files.set(f.id, f);
        await OS.workers.fs.call('putFiles', [f]);
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
        Notify.show({ title: 'Restored', body: f.name + ' restored', type: 'success', appName: 'Files' });
      } catch (err) {
        f.parentId = originalParentId;
        FS.files.set(f.id, f);
        console.error('[Files] restore failed:', err);
        notifyError('Restore failed', err);
      }
    }

    async permanentlyDelete(f) {
      const ok = await showModal(
        'Delete Permanently',
        'This cannot be undone.',
        [{ label: 'Cancel' }, { label: 'Delete', style: 'danger' }]
      );
      if (ok !== 'Delete') return;
      try {
        await FS.permanentDelete(f.id);
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      } catch (err) {
        console.error('[Files] permanent delete failed:', err);
        notifyError('Delete failed', err);
      }
    }

    // Empty Trash: permanently deletes everything currently in the Trash
    // folder. Only reachable via the toolbar button, which is only shown
    // while the Trash folder itself is open.
    async emptyTrash() {
      if (isViewOnly()) {
        notifyBlocked('Delete disabled.');
        return;
      }
      const ok = await showModal(
        'Empty Trash',
        'All items in Trash will be permanently deleted. This cannot be undone.',
        [{ label: 'Cancel' }, { label: 'Empty Trash', style: 'danger' }]
      );
      if (ok !== 'Empty Trash') return;
      try {
        await FS.emptyTrash();
        this.selectedIds.clear();
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      } catch (err) {
        console.error('[Files] empty trash failed:', err);
        notifyError('Empty Trash failed', err);
      }
    }

    // Move the current selection (plus the optional context-clicked file) to
    // trash. Sequential await avoids races against the trash worker; if any
    // item fails we abort and surface the error.
    async trashSelected(contextFile) {
      if (isViewOnly()) {
        notifyBlocked('Delete disabled.');
        return;
      }
      const ids = new Set(this.selectedIds);
      if (contextFile) ids.add(contextFile.id);
      if (!ids.size) return;
      try {
        for (const id of ids) {
          await FS.deleteToTrash(id);
        }
        this.selectedIds.clear();
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      } catch (err) {
        console.error('[Files] move to trash failed:', err);
        notifyError('Delete failed', err);
        this.renderFiles();
      }
    }

    showEmptyAreaContextMenu(x, y) {
      const items = [
        {
          label: 'New File', icon: 'file', shortcut: 'Ctrl+N',
          action: () => this.promptCreate('untitled.txt', true),
        },
        {
          label: 'New Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N',
          action: () => this.promptCreate('New Folder', false),
        },
        { separator: true },
      ];
      if (OS.clipboard?.fileId) {
        items.push({ label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: () => this.pasteFromClipboard() });
        items.push({ separator: true });
      }
      items.push(
        { label: 'Sort by Name', action: () => { this.sortBy = 'name'; this.sortAsc = !this.sortAsc; this.persistViewState(); this.renderFiles(); } },
        { label: 'Sort by Size', action: () => { this.sortBy = 'size'; this.sortAsc = !this.sortAsc; this.persistViewState(); this.renderFiles(); } },
        { label: 'Sort by Type', action: () => { this.sortBy = 'mime'; this.sortAsc = !this.sortAsc; this.persistViewState(); this.renderFiles(); } },
        { label: 'Sort by Date', action: () => { this.sortBy = 'modified'; this.sortAsc = !this.sortAsc; this.persistViewState(); this.renderFiles(); } },
        { separator: true },
        { label: 'View: Icons', action: () => { this.viewMode = 'icon'; this.persistViewState(); this.renderFiles(); } },
        { label: 'View: List', action: () => { this.viewMode = 'list'; this.persistViewState(); this.renderFiles(); } },
        { separator: true },
        { label: 'Select All', action: () => this.selectAll() }
      );
      ContextMenu.show(x, y, items);
    }

    async promptCreate(defaultName, isFile) {
      const name = await showPrompt(isFile ? 'New File Name' : 'New Folder', defaultName);
      if (!name) return;
      if (!isValidFileName(name)) {
        notifyBlocked('That name is not valid.');
        return;
      }
      try {
        const finalName = uniqueNameFor(this.nav.cwd, name);
        if (isFile) await FS.createFile(this.nav.cwd, finalName, '', 'text/plain');
        else await FS.createFolder(this.nav.cwd, finalName);
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      } catch (err) {
        console.error('[Files] create failed:', err);
        notifyError('Create failed', err);
      }
    }

    async pasteFromClipboard() {
      if (isPasteDisabled()) {
        notifyBlocked('Paste disabled.');
        return;
      }
      const clip = OS.clipboard;
      if (!clip?.fileId) return;
      try {
        await FS.pasteInto(clip, this.nav.cwd);
        OS.clipboard = null;
        this.clipboardOp = null;
        this.renderFiles();
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
      } catch (err) {
        console.error('[Files] paste failed:', err);
        notifyError('Paste failed', err);
      }
    }

    selectAll() {
      for (const f of FS.listDir(this.nav.cwd)) this.selectedIds.add(f.id);
      this.updateSelectionVisuals();
    }

    // Global keyboard shortcuts. Filtered to only fire when this app's
    // window is focused, so two open vault windows don't both react to the
    // same keypress.
    wireGlobalShortcuts() {
      document.addEventListener('keydown', (e) => {
        const win = this.content.closest('.app-window');
        if (win?.dataset.appId !== 'com.astroos.files') return;
        // Only handle if focus is inside this Files window's content.
        if (!this.content.contains(document.activeElement)) return;
        const ae = document.activeElement;
        if (ae === this.pathBar || ae === this.searchInput) return;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

        if ((e.key === 'Backspace' && !e.altKey) || (e.key === 'ArrowLeft' && e.altKey)) {
          e.preventDefault();
          this.goBack();
        } else if (e.key === 'ArrowUp' && e.altKey) {
          e.preventDefault();
          this.goUp();
        } else if (e.key === 'F2') {
          const target = this.findRenameTargetForSelection();
          if (target) this.inlineRename(target.node, target.nameEl);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          this.trashSelected();
        } else if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
          e.preventDefault();
          this.selectAll();
        } else if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          this.pathBar.focus();
          this.pathBar.select();
        } else if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          this.searchInput.focus();
        }
      }, { signal: this.signal });
    }

    // FS change listeners — refresh the view when another app or worker
    // mutates the file system. Suppressed during inline rename so we don't
    // blow away the user's in-progress input.
    wireFsChangeListeners() {
      const onFsChange = () => {
        if (!this.isRenaming && !this._disposed) this.renderFiles();
      };
      OS.events.on('fs:created', onFsChange);
      OS.events.on('fs:updated', onFsChange);
      OS.events.on('fs:deleted', onFsChange);
      this.state.cleanups.push(
        () => OS.events.off('fs:created', onFsChange),
        () => OS.events.off('fs:updated', onFsChange),
        () => OS.events.off('fs:deleted', onFsChange)
      );
    }
  }

  class LinuxFilesApp {
    constructor(content, state, options = {}) {
      this.content = content;
      this.state = state;
      this.options = options;
      this.fs = require('fs').promises;
      this.fsConstants = require('fs').constants;
      this.path = require('path');
      this.os = require('os');
      this.childProcess = require('child_process');
      this.currentPath = this.path.resolve(options.path || this.os.homedir());
      this.state._linuxPath = this.currentPath;
      this.selectedPath = null;
      this.selectedPaths = new Set();
      this.clipboard = null;
      this.renderVersion = 0;
      this.controller = new AbortController();
      if (!Array.isArray(state.cleanups)) state.cleanups = [];
      state.cleanups.push(() => {
        this.controller.abort();
        this.state._linuxPath = null;
      });
    }

    mount() {
      this.content.replaceChildren();
      this.content.style.cssText = 'padding:0;height:100%;overflow:hidden;';
      const root = createEl('div', {
        style: 'height:100%;display:flex;flex-direction:column;min-height:0;color:var(--text-primary);'
      });
      const toolbar = createEl('div', {
        style: 'display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid var(--border-subtle);'
      });
      const button = (label, title, action) => {
        const el = createEl('button', {
          className: 'btn btn-sm',
          textContent: label,
          title,
          'aria-label': title
        });
        el.addEventListener('click', action, { signal: this.controller.signal });
        return el;
      };
      toolbar.append(
        button('Up', 'Open parent folder', () => this.goUp()),
        button('Home', 'Open home folder', () => this.navigate(this.os.homedir())),
        button('New folder', 'Create a folder', () => this.createEntry(true)),
        button('New file', 'Create an empty file', () => this.createEntry(false)),
        button('Refresh', 'Refresh folder', () => this.render())
      );
      this.pathInput = createEl('input', {
        className: 'input',
        value: this.currentPath,
        'aria-label': 'Linux filesystem path',
        style: 'flex:1;min-width:80px;'
      });
      this.pathInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        this.navigate(this.pathInput.value);
      }, { signal: this.controller.signal });
      this.searchInput = createEl('input', {
        className: 'input',
        placeholder: 'Search this folder',
        'aria-label': 'Search files',
        style: 'width:180px;'
      });
      this.searchInput.addEventListener('input', () => this.render(), { signal: this.controller.signal });
      toolbar.append(this.pathInput, this.searchInput);

      this.list = createEl('div', {
        role: 'listbox',
        'aria-label': 'Linux files and folders',
        tabIndex: 0,
        style: 'flex:1;min-height:0;overflow:auto;padding:8px;'
      });
      this.status = createEl('div', {
        role: 'status',
        style: 'padding:5px 10px;border-top:1px solid var(--border-subtle);color:var(--text-muted);font-size:11px;'
      });
      root.append(toolbar, this.list, this.status);
      this.content.appendChild(root);

      this.list.addEventListener('contextmenu', event => {
        const row = event.target.closest('[data-path]');
        event.preventDefault();
        if (!row || !this.list.contains(row)) {
          ContextMenu.show(event.clientX, event.clientY, [
            { label: 'New folder', action: () => this.createEntry(true) },
            { label: 'New file', action: () => this.createEntry(false) },
            { label: 'Paste', disabled: !this.clipboard, action: () => this.pasteClipboard() },
            { label: 'Refresh', action: () => this.render() }
          ]);
          return;
        }
        if (!this.selectedPaths.has(row.dataset.path)) {
          this.selectedPaths = new Set([row.dataset.path]);
          this.updateSelection();
        }
        this.selectedPath = row.dataset.path;
        this.showContextMenu(event, row._entry);
      }, { signal: this.controller.signal });
      this.list.addEventListener('dblclick', event => {
        const row = event.target.closest('[data-path]');
        if (row?._entry) void this.openEntry(row._entry);
      }, { signal: this.controller.signal });
      this.list.addEventListener('click', event => {
        const row = event.target.closest('[data-path]');
        if (!row || !this.list.contains(row)) return;
        const path = row.dataset.path;
        if (event.ctrlKey || event.metaKey) {
          if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
          else this.selectedPaths.add(path);
        } else {
          this.selectedPaths = new Set([path]);
        }
        this.selectedPath = this.selectedPaths.has(path) ? path : null;
        this.updateSelection();
      }, { signal: this.controller.signal });
      this.list.addEventListener('keydown', event => {
        if (event.ctrlKey || event.metaKey) {
          const key = event.key.toLowerCase();
          if (key === 'c' || key === 'x') {
            event.preventDefault();
            this.copyOrMoveSelection(key === 'x' ? 'cut' : 'copy');
          } else if (key === 'v') {
            event.preventDefault();
            this.pasteClipboard();
          }
        }
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'a') return;
        event.preventDefault();
        this.selectedPaths = new Set(
          [...this.list.querySelectorAll('[data-path]')].map(row => row.dataset.path)
        );
        this.selectedPath = null;
        this.updateSelection();
      }, { signal: this.controller.signal });
      this.render();
    }

    updateSelection() {
      for (const row of this.list.querySelectorAll('[data-path]')) {
        const selected = this.selectedPaths.has(row.dataset.path);
        row.setAttribute('aria-selected', String(selected));
        row.style.background = selected ? 'var(--accent-muted)' : 'transparent';
        row.style.userSelect = 'none';
      }
    }

    async navigate(target) {
      const nextPath = this.path.resolve(this.currentPath, target || '.');
      try {
        const stat = await this.fs.stat(nextPath);
        if (!stat.isDirectory()) throw new Error('That path is not a folder.');
        this.currentPath = nextPath;
        this.state._linuxPath = nextPath;
        this.pathInput.value = nextPath;
        this.searchInput.value = '';
        this.selectedPath = null;
        this.selectedPaths.clear();
        await this.render();
      } catch (error) {
        Notify.show({ title: 'Cannot open folder', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    goUp() {
      const parent = this.path.dirname(this.currentPath);
      if (parent !== this.currentPath) this.navigate(parent);
    }

    async render() {
      const version = ++this.renderVersion;
      this.pathInput.value = this.currentPath;
      this.list.replaceChildren(createEl('div', {
        textContent: 'Loading…',
        style: 'padding:12px;color:var(--text-muted);'
      }));
      try {
        const entries = await this.fs.readdir(this.currentPath, { withFileTypes: true });
        if (version !== this.renderVersion) return;
        const query = this.searchInput.value.trim().toLocaleLowerCase();
        const rows = await Promise.all(entries
          .filter(entry => !query || entry.name.toLocaleLowerCase().includes(query))
          .map(async entry => {
            const fullPath = this.path.join(this.currentPath, entry.name);
            // A dead FUSE mount (/mnt/hgfs with shared folders off) lists fine
            // but lstat()s with EIO. Keep the row instead of failing the folder.
            let stat = null;
            try {
              stat = await this.fs.lstat(fullPath);
            } catch (error) {
              if (error.code !== 'EIO' && error.code !== 'ENOTCONN') throw error;
            }
            return {
              name: entry.name,
              path: fullPath,
              isDirectory: entry.isDirectory(),
              isFile: entry.isFile(),
              isSymlink: entry.isSymbolicLink(),
              unavailable: stat === null,
              executable: stat !== null && entry.isFile() && (stat.mode & 0o111) !== 0
                && !/\.(?:mp3|mp4|m4a|ogg|wav|flac|aac|opus|weba|webm|jpg|jpeg|png|gif|webp|bmp|svg|avif|tif|tiff)$/i.test(entry.name),
              size: stat?.size ?? 0,
              modified: stat ? stat.mtime.toLocaleString() : 'Unavailable'
            };
          }));
        if (version !== this.renderVersion) return;
        rows.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
        const fragment = document.createDocumentFragment();
        for (const entry of rows) {
          const row = createEl('button', {
            type: 'button',
            role: 'option',
            'data-path': entry.path,
            'aria-selected': String(this.selectedPaths.has(entry.path)),
            style: `width:100%;display:grid;grid-template-columns:minmax(0,1fr) 100px 170px;gap:10px;text-align:left;padding:8px;border:0;border-radius:6px;background:${this.selectedPaths.has(entry.path) ? 'var(--accent-muted)' : 'transparent'};color:inherit;cursor:pointer;user-select:none;`
          });
          row._entry = entry;
          row.append(
            createEl('span', { textContent: `${entry.isDirectory ? '📁' : isNovaPackage(entry.name) ? '📦' : entry.executable ? '⚙' : '📄'}  ${entry.name}` }),
            createEl('span', { textContent: entry.isDirectory ? 'Folder' : isNovaPackage(entry.name) ? 'AstroOS Package' : entry.executable ? 'Executable' : 'File', style: 'color:var(--text-secondary);' }),
            createEl('span', { textContent: entry.modified, style: 'color:var(--text-muted);font-size:11px;' })
          );
          fragment.appendChild(row);
        }
        this.list.replaceChildren(fragment);
        if (!rows.length) this.list.appendChild(createEl('div', {
          textContent: 'This folder is empty.',
          style: 'padding:16px;color:var(--text-muted);'
        }));
        this.status.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'} · ${this.currentPath}`;
      } catch (error) {
        if (version !== this.renderVersion) return;
        this.list.replaceChildren(createEl('div', {
          textContent: `Cannot read this folder: ${error.message}`,
          style: 'padding:16px;color:var(--text-danger);'
        }));
        this.status.textContent = this.currentPath;
      }
    }

    async openEntry(entry) {
      if (entry.isDirectory) {
        await this.navigate(entry.path);
      } else if (isNovaPackage(entry.name)) {
        // Checked before the executable branch: these files often carry the
        // exec bit, and double-clicking one must never spawn it as a program.
        this.installPackage(entry.path);
      } else if (entry.name.toLowerCase().endsWith('.iso')) {
        await this.browseIso(entry.path);
      } else if (/\.(?:txt|md|json|js|mjs|c|h|css|html|htm|log|conf|ini|sh)$/i.test(entry.name)) {
        try {
          const text = await this.fs.readFile(entry.path, 'utf8');
          const win = WM.createWindow('com.astroos.textedit', {
            path: entry.path,
            initialContent: text,
          });
          if (!win) throw new Error('TextEdit could not be opened.');
        } catch (error) {
          console.error('[Files] text file open failed:', error);
          Notify.show({ title: 'Cannot open file', body: error.message, type: 'error', appName: 'Files' });
        }
      } else if (/\.(?:mp3|mp4|m4a|ogg|wav|flac|aac|opus|weba|webm|jpg|jpeg|png|gif|webp|bmp|svg|avif|tif|tiff)$/i.test(entry.name)) {
        let file = FS.files.get(entry.path);
        if (!file) {
          file = {
            id: entry.path,
            name: entry.name,
            type: 'file',
            parentId: this.path.dirname(entry.path),
            content: null,
            mimeType: detectMimeFromName(entry.name),
            modified: Date.now(),
          };
          FS.files.set(file.id, file);
          FS._indexFile?.(file);
        } else if (!file.mimeType || file.mimeType === 'application/octet-stream' ||
            /\.(?:mp3|mp4|m4a|ogg|wav|flac|aac|opus|weba|webm|jpg|jpeg|png|gif|webp|bmp|svg|avif|tif|tiff)$/i.test(entry.name)) {
          file.mimeType = detectMimeFromName(entry.name);
        }
        openFileWithDefaultApp(file);
      } else if (entry.executable) {
        await this.runExecutable(entry.path);
      } else {
        await this.previewFile(entry.path);
      }
    }

    showContextMenu(event, entry) {
      const items = [];
      if (entry.isDirectory) {
        items.push(
          { label: 'Open folder', action: () => this.navigate(entry.path) },
          { label: 'Paste into folder', disabled: !this.clipboard, action: () => this.pasteClipboard(entry.path) }
        );
      } else if (isNovaPackage(entry.name)) {
        items.push({ label: 'Install', disabled: entry.unavailable, action: () => this.installPackage(entry.path) });
      } else {
        items.push({ label: 'Open', action: () => this.openEntry(entry) });
        if (entry.name.toLowerCase().endsWith('.iso')) {
          items.push({ label: 'Browse ISO contents', action: () => this.browseIso(entry.path) });
        }
        if (entry.executable) {
          items.push({
            label: 'Run Linux executable',
            action: () => this.runExecutable(entry.path)
          });
        }
      }
      if (!entry.isDirectory && /\.zip$/i.test(entry.name)) {
        items.push({ label: 'Extract', disabled: entry.unavailable, action: () => this.extractZip(entry.path) });
      }
      items.push({ separator: true });
      if (!entry.unavailable) {
        items.push(
          { label: 'Copy', shortcut: 'Ctrl+C', action: () => this.copyOrMove(entry, 'copy') },
          { label: 'Move', shortcut: 'Ctrl+X', action: () => this.copyOrMove(entry, 'cut') }
        );
        items.push({ separator: true });
      }
      items.push(
        { label: 'Copy as path', action: () => this.copyAsPath(entry) },
        { label: 'Compress to zip', disabled: entry.unavailable, action: () => this.compressToZip(entry) }
      );
      items.push({ separator: true });
      items.push(
        { label: 'Rename', action: () => this.renameEntry(entry) },
        { label: 'Delete', danger: true, action: () => this.deleteEntry(entry) }
      );
      ContextMenu.show(event.clientX, event.clientY, items);
    }

    async createEntry(isDirectory) {
      const name = await showPrompt(isDirectory ? 'New folder' : 'New file', isDirectory ? 'New folder' : 'untitled.txt');
      if (!name || !isValidFileName(name)) return;
      const target = this.path.join(this.currentPath, name);
      try {
        if (isDirectory) await this.fs.mkdir(target);
        else await this.fs.writeFile(target, '', { flag: 'wx' });
        await this.render();
      } catch (error) {
        Notify.show({ title: 'Create failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async previewFile(filePath) {
      try {
        const stat = await this.fs.stat(filePath);
        if (stat.size > 256 * 1024) throw new Error('Preview is limited to files under 256 KiB.');
        const data = await this.fs.readFile(filePath);
        if (data.includes(0)) throw new Error('This file is binary and cannot be previewed as text.');
        await showModal(this.path.basename(filePath), data.toString('utf8'), [{ label: 'Close', primary: true }]);
      } catch (error) {
        Notify.show({ title: 'Cannot preview file', body: error.message, type: 'warning', appName: 'Files' });
      }
    }

    async installPackage(filePath) {
      const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
      const appManagerId = 'com.astroos.appmanager';
      try {
        const stat = await this.fs.stat(filePath);
        if (!stat.isFile()) throw new Error('Only regular files can be installed.');
        if (stat.size > MAX_PACKAGE_BYTES) throw new Error('This package is larger than 32 MiB.');
        const data = await this.fs.readFile(filePath);
        // App Manager only accepts a lowercase ".novaapp" suffix.
        const name = this.path.basename(filePath).replace(/\.novaapp$/i, '.novaapp');
        const file = new File([data], name, { type: 'application/octet-stream' });

        // Same gate the window manager applies to a dropped file.
        if (window.Scanner) {
          const verdict = await window.Scanner.scan(file);
          if (!verdict.safe) {
            Notify.show({ title: 'File Blocked', body: verdict.reason, type: 'error', appName: 'Security' });
            return;
          }
        }

        // Hand off to App Manager so scanning, integrity and trust checks run
        // exactly as they do for a drop. Reuse its window if one is open.
        let managerWindow = [...(window.OS?.windows?.values() ?? [])].find(w => w.appId === appManagerId);
        managerWindow ??= WM.createWindow(appManagerId);
        if (!managerWindow) throw new Error('App Manager is not available.');

        // App Manager's init() is async and only then exposes its install hook.
        const deadline = Date.now() + 8000;
        while (typeof managerWindow.content._novaAppProcessFile !== 'function') {
          if (Date.now() > deadline) throw new Error('App Manager took too long to open.');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        await managerWindow.content._novaAppProcessFile(file);
      } catch (error) {
        console.error('[Files] package install failed:', error);
        Notify.show({ title: 'Cannot install package', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    // Right-clicking inside a multi-selection acts on the whole selection.
    actionTargets(entry) {
      return this.selectedPaths.has(entry.path) && this.selectedPaths.size > 1
        ? [...this.selectedPaths]
        : [entry.path];
    }

    copyOrMove(entry, type) {
      this.clipboard = { type, paths: this.actionTargets(entry) };
      Notify.show({
        title: type === 'copy' ? 'Copied' : 'Ready to move',
        body: this.clipboard.paths.length === 1
          ? this.path.basename(this.clipboard.paths[0])
          : `${this.clipboard.paths.length} items`,
        type: 'info',
        appName: 'Files'
      });
    }

    copyOrMoveSelection(type) {
      const paths = [...this.selectedPaths];
      if (!paths.length && this.selectedPath) paths.push(this.selectedPath);
      if (!paths.length) return;
      this.clipboard = { type, paths };
      Notify.show({
        title: type === 'copy' ? 'Copied' : 'Ready to move',
        body: paths.length === 1 ? this.path.basename(paths[0]) : `${paths.length} items`,
        type: 'info',
        appName: 'Files'
      });
    }

    async pasteClipboard(destinationPath = this.currentPath) {
      const clip = this.clipboard;
      if (!clip?.paths?.length) return;
      try {
        for (const source of clip.paths) {
          const stat = await this.fs.lstat(source);
          if (stat.isDirectory()) {
            const relative = this.path.relative(source, destinationPath);
            if (relative && !relative.startsWith('..' + this.path.sep) &&
                relative !== '..' && !this.path.isAbsolute(relative)) {
              throw new Error('A folder cannot be copied or moved into itself.');
            }
          }
          if (clip.type === 'cut' && this.path.dirname(source) === destinationPath) continue;

          const name = this.path.basename(source);
          const dot = name.lastIndexOf('.');
          const hasExtension = !stat.isDirectory() && dot > 0;
          const destination = await this.uniquePath(
            destinationPath,
            hasExtension ? name.slice(0, dot) : name,
            hasExtension ? name.slice(dot) : ''
          );
          if (clip.type === 'cut') {
            await this.fs.rename(source, destination);
          } else {
            await this.fs.cp(source, destination, { recursive: true, errorOnExist: true });
          }
        }
        if (clip.type === 'cut') this.clipboard = null;
        if (destinationPath === this.currentPath) await this.render();
      } catch (error) {
        console.error('[Files] paste failed:', error);
        Notify.show({ title: 'Paste failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async copyAsPath(entry) {
      const paths = this.actionTargets(entry);
      try {
        await navigator.clipboard.writeText(paths.join('\n'));
        Notify.show({
          title: 'Copied as path',
          body: paths.length === 1 ? paths[0] : `${paths.length} paths`,
          type: 'info',
          appName: 'Files'
        });
      } catch (error) {
        Notify.show({ title: 'Could not copy path', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    // First free name next to the originals: "a.zip", "a (2).zip", ...
    async uniquePath(dir, stem, ext) {
      const original = this.path.join(dir, `${stem}${ext}`);
      try {
        await this.fs.lstat(original);
      } catch (error) {
        if (error.code === 'ENOENT') return original;
        throw error;
      }
      for (let n = 1; n < 1000; n++) {
        const candidate = this.path.join(dir, `${stem} (${n})${ext}`);
        try {
          await this.fs.lstat(candidate);
        } catch (error) {
          if (error.code === 'ENOENT') return candidate;
          throw error;
        }
      }
      throw new Error(`Too many items named "${stem}" already exist here.`);
    }

    runBsdtar(args) {
      return new Promise((resolve, reject) => {
        this.childProcess.execFile('/usr/bin/bsdtar', args, {
          timeout: 10 * 60 * 1000,
          maxBuffer: 2 * 1024 * 1024
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || '').trim() || error.message));
          else resolve();
        });
      });
    }

    async compressToZip(entry) {
      const paths = this.actionTargets(entry);
      const dir = this.path.dirname(paths[0]);
      const names = paths.map(p => this.path.basename(p));
      let target = null;
      try {
        target = await this.uniquePath(dir, names.length === 1 ? names[0] : 'Archive', '.zip');
        // "./" keeps a name that starts with "-" from being read as an option.
        await this.runBsdtar(['--format', 'zip', '-cf', target, '-C', dir, ...names.map(name => `./${name}`)]);
        await this.render();
        Notify.show({ title: 'Compressed', body: this.path.basename(target), type: 'success', appName: 'Files' });
      } catch (error) {
        if (target) await this.fs.rm(target, { force: true }).catch(() => {});
        console.error('[Files] compress failed:', error);
        Notify.show({ title: 'Compress failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async extractZip(zipPath) {
      const dir = this.path.dirname(zipPath);
      let dest = null;
      try {
        // Always into a new folder, never straight into the current one.
        dest = await this.uniquePath(dir, this.path.basename(zipPath).replace(/\.zip$/i, ''), '');
        await this.fs.mkdir(dest);
        await this.runBsdtar(['-xf', zipPath, '-C', dest]);
        await this.render();
        Notify.show({ title: 'Extracted', body: this.path.basename(dest), type: 'success', appName: 'Files' });
      } catch (error) {
        // dest was created by this call, so it only ever holds a partial extract.
        if (dest) await this.fs.rm(dest, { recursive: true, force: true }).catch(() => {});
        console.error('[Files] extract failed:', error);
        Notify.show({ title: 'Extract failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async browseIso(filePath) {
      try {
        const output = await new Promise((resolve, reject) => {
          this.childProcess.execFile('/usr/bin/bsdtar', ['-tf', '--', filePath], {
            timeout: 15000,
            maxBuffer: 2 * 1024 * 1024
          }, (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        const listing = output.split('\n').filter(Boolean).slice(0, 2000);
        if (output.split('\n').filter(Boolean).length > listing.length) listing.push('… listing truncated');
        await showModal(`ISO contents: ${this.path.basename(filePath)}`, listing.join('\n') || '(empty image)', [
          { label: 'Close', primary: true }
        ]);
      } catch (error) {
        console.error('[Files] ISO listing failed:', error);
        Notify.show({ title: 'Could not read ISO', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async runExecutable(filePath) {
      try {
        const stat = await this.fs.stat(filePath);
        if (!stat.isFile()) throw new Error('Only regular files can be run.');
        await this.fs.access(filePath, this.fsConstants.X_OK);
        const confirmed = await showModal(
          'Run Linux executable?',
          `This program will run as the regular astroos user and can change files that account can access. Only run software you trust.\n\n${filePath}`,
          [{ label: 'Cancel' }, { label: 'Run', primary: true, value: 'run' }]
        );
        if (confirmed !== 'run') return;
        const child = this.childProcess.spawn(filePath, [], {
          cwd: this.path.dirname(filePath),
          env: process.env,
          detached: true,
          stdio: 'ignore'
        });
        child.once('error', error => {
          console.error('[Files] executable launch failed:', error);
          Notify.show({ title: 'Could not run program', body: error.message, type: 'error', appName: 'Files' });
        });
        child.unref();
        Notify.show({ title: 'Program started', body: this.path.basename(filePath), type: 'success', appName: 'Files' });
      } catch (error) {
        Notify.show({ title: 'Cannot run program', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async renameEntry(entry) {
      const name = await showPrompt('Rename', entry.name);
      if (!name || name === entry.name || name === '.' || name === '..' || /[\\/]/.test(name)) return;
      try {
        const target = this.path.join(this.currentPath, name);
        try {
          await this.fs.lstat(target);
          throw new Error('An item with that name already exists.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        await this.fs.rename(entry.path, target);
        await this.render();
      } catch (error) {
        Notify.show({ title: 'Rename failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }

    async deleteEntry(entry) {
      const confirmed = await showModal(
        'Delete item?',
        `Delete ${entry.name}? Folders must be empty before they can be deleted.`,
        [{ label: 'Cancel' }, { label: 'Delete', danger: true, value: 'delete' }]
      );
      if (confirmed !== 'delete') return;
      try {
        if (entry.isDirectory) await this.fs.rmdir(entry.path);
        else await this.fs.unlink(entry.path);
        await this.render();
      } catch (error) {
        Notify.show({ title: 'Delete failed', body: error.message, type: 'error', appName: 'Files' });
      }
    }
  }

  registerApp({
    id: 'com.astroos.files',
    name: 'Files',
    version: '3.0.2',
    icon: 'folder-open',
    description: 'File Manager',
    defaultSize: [780, 520],
    minSize: [480, 340],
    init(content, state, options) {
      if (typeof process !== 'undefined' && process.platform === 'linux') {
        new LinuxFilesApp(content, state, options).mount();
        return;
      }
      const app = new FilesApp(content, state, options);
      app.mount();
    },
    _extMap: EXT_TO_MIME,
    async onDrop(file, state) {
      if (!file || typeof file.name !== 'string') {
        Notify.show({ title: 'Error', body: 'Invalid file dropped.', type: 'error', appName: 'Files' });
        return;
      }
      if (window.Scanner) {
        let verdict;
        try {
          verdict = await window.Scanner.scan(file);
        } catch (err) {
          console.warn('[Files] Scanner error:', err);
          verdict = { safe: false, reason: `Could not verify "${file.name}" — dropped in a safe state and skipped.` };
        }
        if (!verdict.safe) {
          Notify.show({ title: 'File Blocked', body: verdict.reason, type: 'error', appName: 'Security' });
          return;
        }
      }
      if (typeof process !== 'undefined' && process.platform === 'linux') {
        try {
          if (!isValidFileName(file.name)) throw new Error('File name is not valid.');
          const fs = require('fs').promises;
          const path = require('path');
          const destination = path.resolve(state?._linuxPath || require('os').homedir(), file.name);
          await fs.writeFile(destination, Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
          Notify.show({ title: 'File Added', body: file.name, type: 'success', appName: 'Files' });
        } catch (err) {
          console.error('[Files] Linux file drop failed:', err);
          Notify.show({ title: 'Error', body: err.message || 'Failed to add file.', type: 'error', appName: 'Files' });
        }
        return;
      }
      try {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let mime = file.type;
        if (!mime) {
          const ext = file.name.split('.').pop()?.toLowerCase();
          mime = (ext && this._extMap[ext]) || 'application/octet-stream';
        }
        const parentId = state?._nav?.cwd || FS.specialFolders?.desktop || FS.rootId;
        const node = {
          id: fileId,
          name: file.name,
          type: 'file',
          size: file.size,
          content: bytes,
          mimeType: mime,
          parentId,
          modified: Date.now(),
        };
        FS.files.set(fileId, node);
        await OS.workers.fs.call('putFiles', [node]);
        if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
        Notify.show({ title: 'File Added', body: file.name, type: 'success', appName: 'Files' });
      } catch (err) {
        console.error('[Files] onDrop failed:', err);
        Notify.show({ title: 'Error', body: 'Failed to add file.', type: 'error', appName: 'Files' });
      }
    },
  });
})();