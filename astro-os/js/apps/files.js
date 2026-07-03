// Files app for NovaByte OS. A browser-style file manager: icon/list views,
// navigation history, context menus, drag-and-drop and keyboard shortcuts.
// Registered as the "vault" app.

(() => {
  const FILES_VFS_KEY = 'files';
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
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
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

      // UI state
      this.viewMode = 'icon';
      this.sortBy = 'name';
      this.sortAsc = true;
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
      // NovaByte runtime guard — refuse to launch without AppDirs.
      if (!window.AppDirs?.getVFSDir?.('com.nbosp.vault', FILES_VFS_KEY)) {
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

    // Hard-fail screen shown when the NovaByte runtime / VFS isn't present.
    // Built with DOM APIs rather than innerHTML so there's no string-built
    // markup to leak into the page.
    renderMissingRuntimeNotice() {
      const c = this.content;
      c.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      c.replaceChildren();
      const icon = createEl('div', { style: 'font-size:32px', textContent: '⚠️' });
      const text = createEl('div', { style: 'font-size:14px;text-align:center' });
      text.append(
        createEl('b', { textContent: 'com.nbosp.vault' }),
        createEl('br'),
        document.createTextNode('App data directory missing.'),
        createEl('br'),
        document.createTextNode('This app requires NovaByte OS.')
      );
      c.append(icon, text);
    }

    buildUI() {
      const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
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

      toolbar.append(this.backBtn, this.upBtn, pathBarWrap, this.searchInput);
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
        iconDiv.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 36);
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
        ic.innerHTML = svgIcon(f.type === 'folder' ? 'folder' : FS.getMimeIcon(f.mimeType, f.name), 16);
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
      if (isHtmlFile(f)) {
        items.push({ label: 'Edit in Text Editor', icon: 'pen', action: () => WM.createWindow('quill', { fileId: f.id }) });
      }
      items.push({ separator: true });
      items.push({
        label: 'Rename', icon: 'file-text', shortcut: 'F2',
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
      ContextMenu.show(x, y, [
        {
          label: 'New File', icon: 'file', shortcut: 'Ctrl+N',
          action: () => this.promptCreate('untitled.txt', true),
        },
        {
          label: 'New Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N',
          action: () => this.promptCreate('New Folder', false),
        },
        { separator: true },
        { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', action: () => this.pasteFromClipboard() },
        { separator: true },
        { label: 'Sort by Name', action: () => { this.sortBy = 'name'; this.sortAsc = !this.sortAsc; this.renderFiles(); } },
        { label: 'Sort by Size', action: () => { this.sortBy = 'size'; this.sortAsc = !this.sortAsc; this.renderFiles(); } },
        { label: 'Sort by Type', action: () => { this.sortBy = 'mime'; this.sortAsc = !this.sortAsc; this.renderFiles(); } },
        { label: 'Sort by Date', action: () => { this.sortBy = 'modified'; this.sortAsc = !this.sortAsc; this.renderFiles(); } },
        { separator: true },
        { label: 'View: Icons', action: () => { this.viewMode = 'icon'; this.renderFiles(); } },
        { label: 'View: List', action: () => { this.viewMode = 'list'; this.renderFiles(); } },
        { separator: true },
        { label: 'Select All', action: () => this.selectAll() },
      ]);
    }

    async promptCreate(defaultName, isFile) {
      const name = await showPrompt(isFile ? 'New File Name' : 'New Folder', defaultName);
      if (!name) return;
      if (!isValidFileName(name)) {
        notifyBlocked('That name is not valid.');
        return;
      }
      try {
        if (isFile) await FS.createFile(this.nav.cwd, name, '', 'text/plain');
        else await FS.createFolder(this.nav.cwd, name);
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
      const src = FS.files.get(clip.fileId);
      if (!src) return;
      try {
        if (clip.type === 'cut') {
          // Move: persist first, roll back on failure so in-memory state
          // matches storage.
          const originalParentId = src.parentId;
          src.parentId = this.nav.cwd;
          try {
            FS.files.set(src.id, src);
            await OS.workers.fs.call('putFiles', [src]);
          } catch (err) {
            src.parentId = originalParentId;
            FS.files.set(src.id, src);
            throw err;
          }
          OS.clipboard = null;
          this.clipboardOp = null;
        } else {
          await FS.createFile(this.nav.cwd, src.name, src.content, src.mimeType);
        }
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
        if (win?.dataset.appId !== 'vault') return;
        // Only handle if focus is inside this vault window's content.
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

  registerApp({
    id: 'vault',
    name: 'Files',
    icon: 'folder-open',
    description: 'File Manager',
    defaultSize: [780, 520],
    minSize: [480, 340],
    init(content, state, options) {
      const app = new FilesApp(content, state, options);
      app.mount();
    },
    _extMap: EXT_TO_MIME,
    async onDrop(file, state) {
      if (!file || typeof file.name !== 'string') {
        Notify.show({ title: 'Error', body: 'Invalid file dropped.', type: 'error', appName: 'Files' });
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