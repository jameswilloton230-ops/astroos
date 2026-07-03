registerApp({
  id: 'nbosp-gallery', name: 'Gallery', icon: 'image',
  description: 'Image Viewer',
  defaultSize: [840, 580], minSize: [500, 360],
  init(content, state) {

    // ── NovaByte runtime guard ──────────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.gallery', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      const warn = createEl('div', { style: 'font-size:32px' });
      warn.textContent = '⚠️';
      const msg = createEl('div', { style: 'font-size:14px;text-align:center' });
      const bold = createEl('b');
      bold.textContent = 'com.nbosp.gallery';
      msg.append(bold, document.createElement('br'), 'App data directory missing.', document.createElement('br'), 'This app requires NovaByte OS.');
      content.append(warn, msg);
      return;
    }

    // ── Root ────────────────────────────────────────────────────────────────
    const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);overflow:hidden;' });
    content.appendChild(root);

    // ── Toolbar ─────────────────────────────────────────────────────────────
    const toolbar = createEl('div', { style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);' });
    const titleEl = createEl('span', { textContent: 'Gallery', style: 'font-size:13px;font-weight:600;flex:1;color:var(--text-primary);' });
    const countEl = createEl('span', { style: 'font-size:11px;color:var(--text-muted);' });
    const refreshBtn = createEl('button', { className: 'browser-nav-btn', title: 'Refresh' });
    refreshBtn.innerHTML = svgIcon('refresh', 15);
    toolbar.append(titleEl, countEl, refreshBtn);
    root.appendChild(toolbar);

    // ── Grid ────────────────────────────────────────────────────────────────
    const gridWrap = createEl('div', { style: 'flex:1;overflow-y:auto;padding:12px;' });
    const grid = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;' });
    gridWrap.appendChild(grid);
    root.appendChild(gridWrap);

    // ── Lightbox ────────────────────────────────────────────────────────────
    const lb = createEl('div', {
      style: 'display:none;position:absolute;inset:0;background:rgba(0,0,0,0.93);z-index:200;align-items:center;justify-content:center;flex-direction:column;',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Image viewer',
    });
    const lbImg = createEl('img', {
      style: 'max-width:88%;max-height:82%;object-fit:contain;border-radius:6px;box-shadow:0 8px 48px rgba(0,0,0,0.8);user-select:none;',
      draggable: 'false',
      alt: '',
    });
    const lbClose = createEl('button', {
      style: 'position:absolute;top:10px;right:14px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#fff;border-radius:6px;width:30px;height:30px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Close',
    });
    lbClose.innerHTML = svgIcon('x', 14);
    const lbPrev = createEl('button', {
      style: 'position:absolute;left:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Previous image',
    });
    lbPrev.innerHTML = svgIcon('chevron-left', 18);
    const lbNext = createEl('button', {
      style: 'position:absolute;right:10px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;display:flex;align-items:center;justify-content:center;',
      'aria-label': 'Next image',
    });
    lbNext.innerHTML = svgIcon('chevron-right', 18);
    const lbCaption = createEl('div', {
      style: 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,0.55);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80%;text-align:center;',
      'aria-live': 'polite',
    });
    lb.append(lbImg, lbClose, lbPrev, lbNext, lbCaption);
    content.style.position = 'relative';
    content.appendChild(lb);

    // ── State ────────────────────────────────────────────────────────────────
    let images = [];
    let lbIdx = 0;

    // blobCache: fileId → object-URL
    // Separate revoke-pending set tracks URLs orphaned after re-render so they
    // are revoked lazily on the next render pass rather than immediately
    // (avoids revoking a URL that is still being painted).
    const blobCache = new Map();
    const revokeQueue = new Set();

    // Recognised image extensions — defined once, never re-allocated.
    const IMG_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff']);

    // ── toBufferData ─────────────────────────────────────────────────────────
    // Normalises whatever the FS layer hands back into something Blob() accepts.
    // ArrayBuffer or TypedArray: pass straight through.
    // String: try native Uint8Array.fromBase64 (ES2026), fall back to atob,
    //         fall back to TextEncoder for plain text.
    // Plain object (IndexedDB round-trip mangling): reconstruct Uint8Array by
    //   reading numeric keys in order. Use a pre-existing keys array so we
    //   don't allocate twice.
    function toBufferData(raw) {
      if (!raw) return null;
      if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw;

      if (typeof raw === 'string') {
        // Native path (ES2026 baseline)
        if (typeof Uint8Array.fromBase64 === 'function') {
          try { return Uint8Array.fromBase64(raw); } catch { /* not base64 */ }
        }
        // atob fallback
        try {
          const bin = atob(raw);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          return u8;
        } catch { /* not base64 */ }
        return new TextEncoder().encode(raw);
      }

      if (typeof raw === 'object') {
        // Plain-object mangling: keys are '0', '1', … but may be sparse or
        // non-contiguous. Sort numerically for correctness.
        const keys = Object.keys(raw);
        const len = keys.length;
        if (len === 0) return null;
        const u8 = new Uint8Array(len);
        // Sort once, then iterate — avoids repeated property lookup in hot path.
        keys.sort((a, b) => a - b);
        for (let i = 0; i < len; i++) u8[i] = raw[keys[i]] ?? 0;
        return u8;
      }

      return null;
    }

    // ── getUrl ───────────────────────────────────────────────────────────────
    // Returns a cached object-URL for a file, creating one if needed.
    // Null results are NOT cached so transient failures can recover on refresh.
    function getUrl(f) {
      const cached = blobCache.get(f.id);
      if (cached !== undefined) return cached;

      const data = toBufferData(f.content);
      if (!data) return null;

      try {
        const blob = new Blob([data], { type: f.mimeType || 'image/png' });
        const url = URL.createObjectURL(blob);
        blobCache.set(f.id, url);
        return url;
      } catch {
        return null;
      }
    }

    // ── Lightbox helpers ─────────────────────────────────────────────────────
    function setLbNavState() {
      const atStart = lbIdx <= 0;
      const atEnd = lbIdx >= images.length - 1;
      lbPrev.style.opacity = atStart ? '0.25' : '1';
      lbNext.style.opacity = atEnd  ? '0.25' : '1';
      lbPrev.disabled = atStart;
      lbNext.disabled = atEnd;
      lbPrev.setAttribute('aria-disabled', String(atStart));
      lbNext.setAttribute('aria-disabled', String(atEnd));
    }

    function openLb(idx) {
      if (!images.length) return;
      lbIdx = Math.max(0, Math.min(idx, images.length - 1));
      const f = images[lbIdx];
      lbImg.alt = f.name;
      lbImg.src = getUrl(f) || '';
      lbCaption.textContent = f.name + '  (' + (lbIdx + 1) + ' / ' + images.length + ')';
      setLbNavState();
      lb.style.display = 'flex';
      lbClose.focus();
    }

    function closeLb() {
      lb.style.display = 'none';
      lbImg.src = '';        // free the decoded image from GPU/RAM immediately
    }

    lbClose.addEventListener('click', closeLb);
    lb.addEventListener('click', e => { if (e.target === lb) closeLb(); });
    lbPrev.addEventListener('click', () => { if (lbIdx > 0) openLb(lbIdx - 1); });
    lbNext.addEventListener('click', () => { if (lbIdx < images.length - 1) openLb(lbIdx + 1); });

    // Keyboard navigation — scoped to `content`, not `document`, so it doesn't
    // bleed into other apps running in the same global scope.
    const onKey = e => {
      if (lb.style.display === 'none') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); if (lbIdx > 0) openLb(lbIdx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); if (lbIdx < images.length - 1) openLb(lbIdx + 1); }
      if (e.key === 'Escape')     closeLb();
    };
    content.addEventListener('keydown', onKey);

    // ── render ───────────────────────────────────────────────────────────────
    function render() {
      // Flush any blob URLs orphaned by the previous render pass.
      for (const url of revokeQueue) URL.revokeObjectURL(url);
      revokeQueue.clear();

      const trashId = FS.specialFolders?.trash;

      // Single-pass collect + filter; sort afterwards.
      const next = [];
      for (const f of FS.files.values()) {
        if (f.type !== 'file' || f.parentId === trashId) continue;
        if (f.mimeType?.startsWith('image/')) { next.push(f); continue; }
        const ext = (f.name || '').split('.').pop().toLowerCase();
        if (IMG_EXTS.has(ext)) next.push(f);
      }
      next.sort((a, b) => b.modified - a.modified);

      // Queue blob URLs for files that are no longer present.
      const nextIds = new Set(next.map(f => f.id));
      for (const [id, url] of blobCache) {
        if (!nextIds.has(id)) {
          revokeQueue.add(url);
          blobCache.delete(id);
        }
      }

      images = next;

      // Rebuild grid using a DocumentFragment to avoid repeated reflows.
      const frag = document.createDocumentFragment();

      countEl.textContent = images.length
        ? images.length + ' image' + (images.length > 1 ? 's' : '')
        : '';

      if (!images.length) {
        const empty = createEl('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 24px;color:var(--text-muted);gap:8px;text-align:center;' });
        empty.innerHTML = svgIcon('image', 38);
        const noImg = createEl('div', { style: 'font-size:13px;margin-top:10px;color:var(--text-secondary);' });
        noImg.textContent = 'No images found';
        const hint = createEl('div', { style: 'font-size:11px;margin-top:4px;' });
        hint.textContent = 'Save image files via Files to view them here';
        empty.append(noImg, hint);
        frag.appendChild(empty);
        grid.textContent = '';  // fast clear
        grid.appendChild(frag);
        return;
      }

      for (let idx = 0; idx < images.length; idx++) {
        const f = images[idx];
        const card = createEl('div', {
          style: 'border-radius:8px;overflow:hidden;cursor:pointer;background:var(--bg-elevated);border:1px solid var(--border-subtle);aspect-ratio:1;display:flex;align-items:center;justify-content:center;transition:transform 0.13s,border-color 0.13s;position:relative;',
          title: f.name,
          role: 'button',
          tabindex: '0',
          'aria-label': f.name,
        });

        // Use event delegation via `idx` closure capture — one listener per card.
        const openThisCard = () => openLb(idx);
        card.addEventListener('click', openThisCard);
        card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThisCard(); } });
        card.addEventListener('mouseenter', () => { card.style.transform = 'scale(1.04)'; card.style.borderColor = 'var(--accent)'; });
        card.addEventListener('mouseleave', () => { card.style.transform = ''; card.style.borderColor = ''; });

        const url = getUrl(f);
        if (url) {
          const img = createEl('img', {
            style: 'width:100%;height:100%;object-fit:cover;',
            alt: f.name,
            draggable: 'false',
            loading: 'lazy',
          });
          img.addEventListener('error', () => {
            // Remove broken img cleanly; append fallback icon without wiping label.
            img.remove();
            const icon = createEl('div', { style: 'color:var(--text-muted);' });
            icon.innerHTML = svgIcon('image', 24);
            card.insertBefore(icon, card.firstChild);
          });
          img.src = url;
          card.appendChild(img);
        } else {
          const icon = createEl('div', { style: 'color:var(--text-muted);' });
          icon.innerHTML = svgIcon('image', 24);
          card.appendChild(icon);
        }

        const label = createEl('div', {
          style: 'position:absolute;bottom:0;left:0;right:0;padding:4px 6px;background:linear-gradient(transparent,rgba(0,0,0,0.7));color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
        });
        label.textContent = f.name;  // textContent — never innerHTML for user data
        card.appendChild(label);
        frag.appendChild(card);
      }

      grid.textContent = '';  // fast clear (no innerHTML parser overhead)
      grid.appendChild(frag);
    }

    refreshBtn.addEventListener('click', render);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    state.cleanups = state.cleanups || [];
    state.cleanups.push(() => {
      content.removeEventListener('keydown', onKey);
      for (const url of blobCache.values()) URL.revokeObjectURL(url);
      blobCache.clear();
      for (const url of revokeQueue) URL.revokeObjectURL(url);
      revokeQueue.clear();
    });

    // ── Initial render ───────────────────────────────────────────────────────
    // Single render call regardless of whether state.fileId is set.
    render();
    if (state.fileId) {
      const startIdx = images.findIndex(f => f.id === state.fileId);
      if (startIdx !== -1) openLb(startIdx);
    }
  }
});



/* ── Global Downloads API ──────────────────────────────────────────────────
   Persists even when the Downloads app window is closed.
   ─────────────────────────────────────────────────────────────────────────*/
(function () {
  const SK = 'nova_downloads';
  const MAX_ENTRIES = 500;

  function _load() {
    try {
      const raw = localStorage.getItem(SK);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function _save(arr) {
    try {
      localStorage.setItem(SK, JSON.stringify(arr.length > MAX_ENTRIES ? arr.slice(0, MAX_ENTRIES) : arr));
    } catch { /* storage full or blocked — fail silently */ }
  }

  // Collision-resistant ID: crypto random beats Date.now() + Math.random()
  // because Date.now() has millisecond resolution and Math.random() is not
  // guaranteed unique. Falls back gracefully if crypto is unavailable.
  function _uid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback: 64-bit hex from getRandomValues
    try {
      const buf = new Uint8Array(8);
      crypto.getRandomValues(buf);
      return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  window.Downloads = {
    _renderFn: null,  // set by Downloads app when its window is open

    add(name, url, size, mimeType) {
      const entry = {
        id:       _uid(),
        name:     name     || 'Unknown file',
        url:      url      || '',
        size:     size     || 0,
        mimeType: mimeType || '',
        ts:       Date.now(),
        status:   'done',
      };
      const arr = _load();
      arr.unshift(entry);
      _save(arr);
      window.Downloads._renderFn?.();
      return entry;
    },

    setStatus(id, status, size) {
      const arr = _load();
      const it = arr.find(x => x.id === id);
      if (it) {
        it.status = status;
        if (size != null) it.size = size;
        _save(arr);
      }
      window.Downloads._renderFn?.();
    },

    getAll() {
      return _load();
    },
  };
})();