/**
 * SystemDialogs  —  NovaByte OS
 * ─────────────────────────────────────────────────────────────────────────
 * Filesystem picker dialog. Browses the host disk via Node's fs
 * module — no GTK or native OS picker. Rendered entirely in the
 * NovaByte shell window.
 *
 * Usage:
 *   // Open a file — resolves to null if cancelled, otherwise:
 *   // { path, name, content, mimeType, size }
 *   const file = await SystemDialogs.open({
 *     title: 'Open File',
 *     startPath: '/home/nbosp/Downloads',
 *     filter: (name, isDir) => isDir || name.endsWith('.txt'),
 *   });
 *
 *   // Folder — pass directory: true; resolves { path, name } or null.
 *   const dir = await SystemDialogs.open({ title: "Choose Folder", directory: true });
 *
 *   // Multiple files — pass multiple: true; click toggles, resolves an array or null.
 *
 *   // Save — resolves to null if cancelled, otherwise:
 *   // { path, name }  (caller writes the file)
 *   const dest = await SystemDialogs.save({
 *     title: 'Save As',
 *     suggestedName: 'untitled.txt',
 *     startPath: '/home/nbosp/Downloads',
 *   });
 */
const SystemDialogs = (() => {
  'use strict';

  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const DEFAULT_START = os.homedir() || '/home/nbosp';

  // ── Mime guessing (enough for common types) ────────────────────────────
  const EXT_MIME = {
    txt: 'text/plain', md: 'text/markdown', js: 'text/javascript',
    json: 'application/json', html: 'text/html', htm: 'text/html',
    css: 'text/css', sh: 'application/x-sh', xml: 'application/xml',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', zip: 'application/zip',
    novaapp: 'application/json',
  };

  function guessMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return EXT_MIME[ext] || 'application/octet-stream';
  }

  // Wider table for matching an <input accept> list and for pathOnly results.
  // It stays apart from EXT_MIME on purpose: callers that read file contents
  // choose string vs Buffer from guessMime(), so adding text types there
  // would turn a Latin-1 CSV into a mangled UTF-8 string.
  const EXT_MIME_EXTRA = {
    bmp: 'image/bmp', ico: 'image/vnd.microsoft.icon', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
    jxl: 'image/jxl',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
    flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus',
    weba: 'audio/webm', mid: 'audio/midi', midi: 'audio/midi',
    mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', ogv: 'video/ogg',
    mov: 'video/quicktime', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', '3gp': 'video/3gpp',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
    rtf: 'application/rtf', epub: 'application/epub+zip',
    csv: 'text/csv', tsv: 'text/tab-separated-values', ics: 'text/calendar',
    vcf: 'text/vcard', yaml: 'application/yaml', yml: 'application/yaml',
    gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
    bz2: 'application/x-bzip2', xz: 'application/x-xz',
    '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    wasm: 'application/wasm', mjs: 'text/javascript',
    iso: 'application/x-iso9660-image', deb: 'application/vnd.debian.binary-package',
    apk: 'application/vnd.android.package-archive',
  };

  function lookupMime(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return EXT_MIME[ext] || EXT_MIME_EXTRA[ext] || 'application/octet-stream';
  }

  // Turns an <input accept> string (".png,image/*,application/pdf") into a
  // filter(name, isDir), or null when it holds no usable rule. Extension rules
  // are strict. MIME rules let through files whose type we can't identify:
  // the table can't cover every format, and the dialog has no "all files"
  // switch, so hiding an unknown file would make it unpickable.
  function acceptFilter(accept) {
    const rules = String(accept || '').split(',').map(r => r.trim().toLowerCase())
      .filter(r => /^\.[\w+-]+$/.test(r) || /^[\w.+-]+\/(\*|[\w.+-]+)$/.test(r));
    if (!rules.length) return null;
    return (name, isDir) => {
      if (isDir) return true;
      const lowerName = name.toLowerCase();
      const type = lookupMime(name);
      return rules.some(rule => {
        if (rule.startsWith('.')) return lowerName.endsWith(rule);
        if (type === 'application/octet-stream') return true;
        if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
        return type === rule;
      });
    };
  }

  // ── Icon SVGs (minimal, inline) ────────────────────────────────────────
  function folderIcon() {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h3.586a1 1 0 0 1 .707.293L10.414 6.5A1 1 0 0 0 11.121 6.793H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  }
  function fileIcon() {
    return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  }
  function chevronLeft() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
  }
  function chevronUp() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`;
  }

  // ── Read a directory, sorted (folders first) ───────────────────────────
  async function readDir(dirPath) {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = await fs.promises.stat(path.join(dirPath, entry.name));
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          isFile = true;
        }
      }
      if (isDir) dirs.push({ name: entry.name, isDir: true });
      else if (isFile) files.push({ name: entry.name, isDir: false });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  }

  // ── Core dialog ────────────────────────────────────────────────────────
  function _show(opts) {
    const isSave    = opts.mode === 'save';
    // directory: true (open mode only) turns the dialog into a folder chooser.
    // Resolves { path, name } for the highlighted subfolder, or the current one.
    const pickDir   = !isSave && opts.directory === true;
    // multiple: true (open mode, files only) allows click-to-toggle multi-select
    // and resolves an array of file objects (same shape as single open).
    const multi     = !isSave && !pickDir && opts.multiple === true;
    // pathOnly: true (open mode) skips reading file contents and resolves
    // { path, name, mimeType, size } only, for callers that stream the file
    // themselves instead of holding all of it in memory.
    const pathOnly  = !isSave && opts.pathOnly === true;
    const title     = opts.title || (isSave ? 'Save As' : pickDir ? 'Select Folder' : 'Open');
    // accept: an <input accept> style list, combined with filter if both are given.
    const customFilter = typeof opts.filter === 'function' ? opts.filter : null;
    const acceptRule   = acceptFilter(opts.accept);
    const filter    = (name, isDir) =>
      (!customFilter || customFilter(name, isDir)) && (!acceptRule || acceptRule(name, isDir));
    let   cwd       = opts.startPath || DEFAULT_START;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      // ── Modal root ───────────────────────────────────────────────────
      let modalRoot = document.getElementById('system-modal-root');
      if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'system-modal-root';
        Object.assign(modalRoot.style, {
          position: 'fixed', inset: '0',
          width: '100vw', height: '100vh',
          zIndex: '2147483000',
          pointerEvents: 'none',
          isolation: 'isolate',
        });
        document.body.appendChild(modalRoot);
      }

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.style.pointerEvents = 'auto';

      const dialog = document.createElement('div');
      dialog.className = 'modal-dialog system-file-dialog';

      // ── Header ───────────────────────────────────────────────────────
      const header = document.createElement('div');
      header.className = 'modal-title system-file-dialog-title';
      header.textContent = title;

      // ── Toolbar ──────────────────────────────────────────────────────
      const toolbar = document.createElement('div');
      toolbar.className = 'system-file-dialog-toolbar';

      const backBtn = document.createElement('button');
      backBtn.className = 'system-file-dialog-nav-btn';
      backBtn.title = 'Back';
      backBtn.setAttribute('aria-label', 'Back');
      backBtn.innerHTML = chevronLeft();

      const upBtn = document.createElement('button');
      upBtn.className = 'system-file-dialog-nav-btn';
      upBtn.title = 'Up';
      upBtn.setAttribute('aria-label', 'Parent folder');
      upBtn.innerHTML = chevronUp();

      const pathBarWrap = document.createElement('div');
      pathBarWrap.className = 'system-file-dialog-path-wrap';

      const pathBar = document.createElement('input');
      pathBar.className = 'system-file-dialog-path';
      pathBar.setAttribute('aria-label', 'Current folder');
      pathBar.spellcheck = false;
      pathBar.type = 'text';

      pathBarWrap.appendChild(pathBar);
      toolbar.append(backBtn, upBtn, pathBarWrap);

      // ── File grid ────────────────────────────────────────────────────
      const grid = document.createElement('div');
      grid.className = 'system-file-dialog-grid';
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-label', 'Files');

      // ── Footer ───────────────────────────────────────────────────────
      const footer = document.createElement('div');
      footer.className = 'system-file-dialog-footer';

      const nameInput = document.createElement('input');
      nameInput.className = 'input';
      nameInput.type = 'text';
      nameInput.style.flex = '1';
      nameInput.setAttribute('aria-label', isSave ? 'File name' : 'Selected file');
      nameInput.placeholder = isSave ? 'File name…' : pickDir ? 'Current folder' : multi ? 'Select files…' : 'Select a file…';
      if (isSave) nameInput.value = opts.suggestedName || '';
      else nameInput.readOnly = true;

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-sm';
      cancelBtn.textContent = 'Cancel';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-sm btn-primary';
      confirmBtn.textContent = isSave ? 'Save' : pickDir ? 'Select' : 'Open';
      confirmBtn.disabled = pickDir ? false : (!isSave || !nameInput.value.trim());

      footer.append(nameInput, cancelBtn, confirmBtn);
      dialog.append(header, toolbar, grid, footer);
      overlay.appendChild(dialog);

      // ── Navigation state ─────────────────────────────────────────────
      const history = [];
      let histIdx = -1;
      let selectedName = null;
      const selectedSet = new Set();

      function pushHistory(p) {
        if (histIdx < history.length - 1) history.length = histIdx + 1;
        history.push(p);
        histIdx = history.length - 1;
      }

      async function navigateTo(dirPath, { record = true } = {}) {
        const nextPath = path.resolve(dirPath);
        try {
          const target = await fs.promises.stat(nextPath);
          if (!target.isDirectory()) throw new Error('The selected path is not a folder');
        } catch (error) {
          pathBar.value = cwd;
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: 'Folder unavailable', body: error.message, type: 'error' });
          }
          return;
        }
        cwd = nextPath;
        if (record) pushHistory(dirPath);
        selectedName = null;
        selectedSet.clear();
        if (!isSave) {
          nameInput.value = '';
          confirmBtn.disabled = !pickDir;
        }
        pathBar.value = cwd;
        upBtn.disabled = (path.dirname(cwd) === cwd); // at root
        backBtn.disabled = histIdx <= 0;
        await renderGrid();
      }

      backBtn.addEventListener('click', async () => {
        if (histIdx <= 0) return;
        histIdx--;
        cwd = history[histIdx];
        selectedName = null;
        selectedSet.clear();
        if (!isSave) { nameInput.value = ''; confirmBtn.disabled = !pickDir; }
        pathBar.value = cwd;
        upBtn.disabled = (path.dirname(cwd) === cwd);
        backBtn.disabled = histIdx <= 0;
        await renderGrid();
      });

      upBtn.addEventListener('click', () => {
        const parent = path.dirname(cwd);
        if (parent !== cwd) navigateTo(parent);
      });

      pathBar.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const target = pathBar.value.trim();
        if (target) navigateTo(target);
      });

      if (isSave) {
        nameInput.addEventListener('input', () => {
          confirmBtn.disabled = !nameInput.value.trim();
        });
      }

      async function renderGrid() {
        grid.innerHTML = '';
        let entries;
        try {
          entries = await readDir(cwd);
        } catch (error) {
          const message = document.createElement('div');
          message.style.cssText = 'grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted);font-size:12px;';
          message.textContent = `Unable to read folder: ${error.message}`;
          grid.appendChild(message);
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: 'Folder unavailable', body: error.message, type: 'error' });
          }
          return;
        }
        const visible = pickDir
          ? entries.filter(e => e.isDir)
          : entries.filter(e => e.isDir || filter(e.name, false));

        if (visible.length === 0) {
          const empty = document.createElement('div');
          empty.style.cssText = 'grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted);font-size:12px;';
          empty.textContent = '(empty folder)';
          grid.appendChild(empty);
          return;
        }

        for (const entry of visible) {
          const item = document.createElement('div');
          item.className = 'system-file-dialog-item';
          item.tabIndex = 0;
          item.setAttribute('role', 'gridcell');
          item.setAttribute('aria-label', entry.name);
          item.setAttribute('aria-selected', 'false');

          const iconWrap = document.createElement('div');
          iconWrap.className = 'system-file-dialog-icon';
          iconWrap.innerHTML = entry.isDir ? folderIcon() : fileIcon();

          const nameEl = document.createElement('div');
          nameEl.className = 'system-file-dialog-name';
          nameEl.textContent = entry.name;

          item.append(iconWrap, nameEl);

          if (entry.isDir) {
            item.addEventListener('click', () => {
              clearSelection();
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              if (pickDir) { selectedName = entry.name; nameInput.value = entry.name; }
            });
            item.addEventListener('dblclick', () => navigateTo(path.join(cwd, entry.name)));
            item.addEventListener('keydown', e => {
              if (e.key === 'Enter') navigateTo(path.join(cwd, entry.name));
            });
          } else {
            item.addEventListener('click', () => {
              if (multi) {
                const on = !selectedSet.has(entry.name);
                item.classList.toggle('selected', on);
                item.setAttribute('aria-selected', String(on));
                if (on) selectedSet.add(entry.name); else selectedSet.delete(entry.name);
                nameInput.value = selectedSet.size > 1 ? `${selectedSet.size} files selected` : ([...selectedSet][0] || '');
                confirmBtn.disabled = selectedSet.size === 0;
                return;
              }
              clearSelection();
              item.classList.add('selected');
              item.setAttribute('aria-selected', 'true');
              selectedName = entry.name;
              nameInput.value = entry.name;
              if (isSave) confirmBtn.disabled = !nameInput.value.trim();
              else confirmBtn.disabled = false;
            });
            item.addEventListener('dblclick', () => {
              selectedName = entry.name;
              nameInput.value = entry.name;
              if (multi) { selectedSet.add(entry.name); confirmBtn.disabled = false; }
              doConfirm();
            });
            item.addEventListener('keydown', e => {
              if (e.key === 'Enter') {
                selectedName = entry.name;
                if (multi) { selectedSet.add(entry.name); confirmBtn.disabled = false; }
                doConfirm();
              }
            });
          }

          grid.appendChild(item);
        }
      }

      function clearSelection() {
        for (const el of grid.children) {
          el.classList.remove('selected');
          el.setAttribute('aria-selected', 'false');
        }
      }

      async function doConfirm() {
        if (confirmBtn.disabled) return;
        if (pickDir) {
          const dir = selectedName ? path.join(cwd, selectedName) : cwd;
          finish({ path: dir, name: path.basename(dir) || dir });
          return;
        }
        if (multi) {
          const names = [...selectedSet];
          if (!names.length) return;
          const results = [];
          for (const n of names) {
            const fp = path.join(cwd, n);
            try {
              if (pathOnly) {
                const stat = await fs.promises.stat(fp);
                results.push({ path: fp, name: n, mimeType: lookupMime(n), size: stat.size });
                continue;
              }
              const buf = await fs.promises.readFile(fp);
              const mime = guessMime(n);
              const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-sh' || mime === 'application/xml';
              results.push({ path: fp, name: n, content: isText ? buf.toString('utf8') : buf, mimeType: mime, size: buf.length });
            } catch (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: 'Open failed', body: `${n}: ${err.message}`, type: 'error' });
              }
              return;
            }
          }
          finish(results);
          return;
        }
        const name = nameInput.value.trim();
        if (!name) return;
        if (isSave && (name === '.' || name === '..' || name.includes('\0') ||
            path.basename(name) !== name)) {
          if (typeof Notify !== 'undefined') {
            Notify.show({ title: 'Invalid file name', body: 'Enter a file name, not a path.', type: 'error' });
          }
          return;
        }
        const fullPath = path.join(cwd, name);

        if (isSave) {
          finish({ path: fullPath, name });
        } else if (pathOnly) {
          fs.stat(fullPath, (err, stat) => {
            if (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: 'Open failed', body: err.message, type: 'error' });
              }
              return;
            }
            finish({ path: fullPath, name, mimeType: lookupMime(name), size: stat.size });
          });
        } else {
          // read the file content
          fs.readFile(fullPath, (err, buf) => {
            if (err) {
              if (typeof Notify !== 'undefined') {
                Notify.show({ title: 'Open failed', body: err.message, type: 'error' });
              }
              return;
            }
            const mime = guessMime(name);
            const isText = mime.startsWith('text/') || mime === 'application/json' || mime === 'application/x-sh' || mime === 'application/xml';
            finish({
              path: fullPath,
              name,
              content: isText ? buf.toString('utf8') : buf,
              mimeType: mime,
              size: buf.length,
            });
          });
        }
      }

      cancelBtn.addEventListener('click', () => finish(null));
      confirmBtn.addEventListener('click', doConfirm);
      overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });

      function onKeydown(e) {
        if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        else if (e.key === 'Enter' && document.activeElement === nameInput) {
          e.preventDefault();
          doConfirm();
        }
      }
      overlay.addEventListener('keydown', onKeydown);

      function cleanup() {
        overlay.removeEventListener('keydown', onKeydown);
        overlay.remove();
      }

      // ── Init ─────────────────────────────────────────────────────────
      modalRoot.appendChild(overlay);
      navigateTo(cwd, { record: false }).then(() => {
        pushHistory(cwd);
        if (isSave) {
          requestAnimationFrame(() => { nameInput.focus(); nameInput.select(); });
        } else {
          requestAnimationFrame(() => grid.focus());
        }
      });
    });
  }

  return {
    open(opts = {}) { return _show({ ...opts, mode: 'open' }); },
    save(opts = {}) { return _show({ ...opts, mode: 'save' }); },
  };
})();

window.SystemDialogs = SystemDialogs;