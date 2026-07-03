registerApp({
  id: 'nbosp-search',
  name: 'Search',
  icon: 'search',
  description: 'System Search',
  defaultSize: [640, 500],
  minSize: [420, 300],

  init(content, state) {

    // ── Guard: require VFS dir ────────────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.search', 'files')) {
      content.style.cssText = [
        'display:flex', 'align-items:center', 'justify-content:center',
        'height:100%', 'flex-direction:column', 'gap:12px',
        'font-family:var(--font-ui,sans-serif)', 'color:var(--text-muted,#888)',
      ].join(';');
      const warn = createEl('div');
      warn.textContent = '⚠️';
      warn.style.cssText = 'font-size:32px';
      const msg = createEl('div');
      msg.style.cssText = 'font-size:14px;text-align:center';
      const bold = createEl('b');
      bold.textContent = 'com.nbosp.search';
      msg.append(bold, document.createTextNode('\nApp data directory missing.\nThis app requires NovaByte OS.'));
      content.append(warn, msg);
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    // TRIGRAM INDEX
    // Maps every 3-char lowercase substring → Set of items that contain it.
    // Lookup is O(1) per trigram, intersection is O(hits) — not O(total items).
    // Falls back gracefully to linear scan for queries shorter than 3 chars.
    // ════════════════════════════════════════════════════════════════════════

    /** @param {string} s @returns {string[]} */
    function trigrams(s) {
      const out = [];
      for (let i = 0; i <= s.length - 3; i++) out.push(s.slice(i, i + 3));
      return out;
    }

    /**
     * Build a trigram index from an array of items.
     * Stores only 3-grams for memory efficiency.
     * @param {Array}    items
     * @param {Function} keyFn  — returns the string(s) to index for each item
     * @returns {Map<string, Set>}
     */
    function buildTrigramIndex(items, keyFn) {
      const index = new Map();
      for (const item of items) {
        const keys = [].concat(keyFn(item));
        for (const key of keys) {
          const lk = (key || '').toLowerCase();
          for (let i = 0; i <= lk.length - 3; i++) {
            const gram = lk.slice(i, i + 3);
            let bucket = index.get(gram);
            if (!bucket) { bucket = new Set(); index.set(gram, bucket); }
            bucket.add(item);
          }
        }
      }
      return index;
    }

    /**
     * Linear scan fallback for queries shorter than 3 chars.
     */
    function linearSearch(items, lq, verifyFn) {
      const out = [];
      for (const item of items) {
        if (verifyFn(item, lq)) out.push(item);
      }
      return out;
    }

    /**
     * Query a trigram index.
     * Uses the rarest trigram bucket as the starting candidate set,
     * then verifies each candidate actually contains the full query.
     * For queries shorter than 3 chars, falls back to linear scan.
     * @param {Map}    index
     * @param {string} lq     — already-lowercased query
     * @param {Function} verifyFn — (item, lq) => boolean for full-string check
     * @param {Array}  [allItems] — optional full item list for linear fallback
     * @returns {Array}
     */
    function queryIndex(index, lq, verifyFn, allItems) {
      if (!lq) return [];
      if (lq.length < 3) return linearSearch(allItems || [], lq, verifyFn);
      let best = null;
      for (let i = 0; i <= lq.length - 3; i++) {
        const gram = lq.slice(i, i + 3);
        const bucket = index.get(gram);
        if (!bucket) return [];
        if (best === null || bucket.size < best.size) best = bucket;
      }
      if (!best) return [];
      const out = [];
      for (const item of best) {
        if (verifyFn(item, lq)) out.push(item);
      }
      return out;
    }

    // ════════════════════════════════════════════════════════════════════════
    // FILE INDEX — built once on init, updated on FS mutation events
    // ════════════════════════════════════════════════════════════════════════

    let fileIndex = new Map();
    let fileItems = [];
    let filePathCache = new Map();

    function buildFileIndex() {
      try {
        if (!window.FS?.files) return;
        fileItems = [...FS.files.values()].filter(f => f.type === 'file');
        fileIndex = buildTrigramIndex(fileItems, f => f.name || '');
        filePathCache = new Map();
        for (const f of fileItems) {
          filePathCache.set(f.id, FS.getPath ? FS.getPath(f.id) : (f.name || ''));
        }
      } catch (err) {
        console.warn('[nbosp-search] File index build failed:', err);
      }
    }

    buildFileIndex();

    let fsChangeTimer = null;
    try {
      if (window.FS?.addEventListener) {
        FS.addEventListener('change', () => {
          clearTimeout(fsChangeTimer);
          fsChangeTimer = setTimeout(buildFileIndex, 200);
        });
      }
    } catch { /* FS may not support events */ }

    function searchFiles(lq) {
      if (!lq) return [];
      return queryIndex(fileIndex, lq, (f, q) =>
        (f.name || '').toLowerCase().includes(q),
        fileItems
      );
    }

    // ════════════════════════════════════════════════════════════════════════
    // LOCAL DATA CACHE — contacts & downloads
    // Parsed once, re-indexed into trigrams, invalidated only on storage events
    // ════════════════════════════════════════════════════════════════════════

    const localCache = {
      contacts:      null,
      downloads:     null,
      contactIndex:  new Map(),
      downloadIndex: new Map(),

      _loadContacts() {
        try { this.contacts = JSON.parse(localStorage.getItem('nova_contacts') || '[]'); }
        catch { this.contacts = []; }
        this.contactIndex = buildTrigramIndex(
          this.contacts,
          c => [c.name || '', c.email || '', c.phone || '']
        );
      },

      _loadDownloads() {
        try { this.downloads = JSON.parse(localStorage.getItem('nova_downloads') || '[]'); }
        catch { this.downloads = []; }
        this.downloadIndex = buildTrigramIndex(this.downloads, d => d.name || '');
      },

      searchContacts(lq) {
        if (this.contacts === null) this._loadContacts();
        return queryIndex(this.contactIndex, lq, (c, q) =>
          (c.name  || '').toLowerCase().includes(q) ||
          (c.email || '').toLowerCase().includes(q) ||
          (c.phone || '').toLowerCase().includes(q),
          this.contacts
        );
      },

      searchDownloads(lq) {
        if (this.downloads === null) this._loadDownloads();
        return queryIndex(this.downloadIndex, lq, (d, q) =>
          (d.name || '').toLowerCase().includes(q),
          this.downloads
        );
      },

      invalidateContacts()  { this.contacts  = null; this.contactIndex  = new Map(); },
      invalidateDownloads() { this.downloads = null; this.downloadIndex = new Map(); },
    };

    function patchLocalStorageInvalidation() {
      const watched = ['nova_contacts', 'nova_downloads'];
      const origSet = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function(key, value) {
        origSet(key, value);
        if (key === 'nova_contacts')  localCache.invalidateContacts();
        if (key === 'nova_downloads') localCache.invalidateDownloads();
      };
    }
    patchLocalStorageInvalidation();

    window.addEventListener('storage', (e) => {
      if (e.key === 'nova_contacts')  localCache.invalidateContacts();
      if (e.key === 'nova_downloads') localCache.invalidateDownloads();
    });

    // ════════════════════════════════════════════════════════════════════════
    // WEB CACHE — DDG responses, 2-minute TTL
    // ════════════════════════════════════════════════════════════════════════

    const WEB_CACHE_MAX = 50;
    const WEB_CACHE_TTL_MS = 2 * 60 * 1000;
    const webCache = new Map();

    function getCachedWeb(q) {
      const entry = webCache.get(q);
      if (!entry) return null;
      if (Date.now() - entry.ts > WEB_CACHE_TTL_MS) { webCache.delete(q); return null; }
      return entry.hits;
    }

    function setCachedWeb(q, hits) {
      if (webCache.size >= WEB_CACHE_MAX) {
        const oldest = webCache.keys().next().value;
        webCache.delete(oldest);
      }
      webCache.set(q, { hits, ts: Date.now() });
    }

    // ════════════════════════════════════════════════════════════════════════
    // DDG FETCH + PARSE — extracted once, shared by prefetch and doSearch
    // ════════════════════════════════════════════════════════════════════════

    function parseDDGResponse(data) {
      const hits = [];
      if (data.AbstractText) {
        hits.push({
          title: data.Heading || 'Answer',
          href:  data.AbstractURL || 'https://duckduckgo.com',
          desc:  data.AbstractText.slice(0, 120),
        });
      }
      for (const t of (data.RelatedTopics || [])) {
        if (t.Text && t.FirstURL && !t.Name && hits.length < 12) {
          hits.push({
            title: t.Text.split(' - ')[0].slice(0, 80),
            href:  t.FirstURL,
            desc:  t.Text.slice(0, 120),
          });
        }
      }
      return hits;
    }

    function ddgUrl(q) {
      return 'https://api.duckduckgo.com/?' +
        new URLSearchParams({ q, format: 'json', no_html: '1', skip_disambig: '1' });
    }

    async function fetchDDG(q, signal) {
      const resp = await fetch(ddgUrl(q), signal ? { signal } : {});
      if (!resp.ok) throw new Error(`DDG ${resp.status}`);
      return parseDDGResponse(await resp.json());
    }

    // ════════════════════════════════════════════════════════════════════════
    // LAYOUT
    // ════════════════════════════════════════════════════════════════════════

    const root = createEl('div', {
      style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;',
    });

    const barWrap = createEl('div', {
      style: 'padding:12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);',
    });
    const bar = createEl('div', {
      role: 'search',
      style: 'display:flex;align-items:center;gap:8px;background:var(--bg-sunken);border:1px solid var(--border-default);border-radius:8px;padding:7px 10px;transition:border-color 0.15s;',
    });

    const barIco = createEl('span', { style: 'color:var(--text-muted);flex-shrink:0;', 'aria-hidden': 'true' });
    barIco.innerHTML = svgIcon('search', 16);

    const inp = createEl('input', {
      type: 'text',
      placeholder: 'Search files, contacts, downloads…',
      style: 'flex:1;background:none;border:none;outline:none;font-size:14px;color:var(--text-primary);',
      'aria-label': 'Search',
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const clearX = createEl('button', {
      type: 'button',
      style: 'background:none;border:none;color:var(--text-muted);cursor:pointer;display:none;padding:2px;',
      'aria-label': 'Clear search',
    });
    clearX.innerHTML = svgIcon('x', 14);

    bar.append(barIco, inp, clearX);
    barWrap.appendChild(bar);
    root.appendChild(barWrap);

    inp.addEventListener('focus', () => { bar.style.borderColor = 'var(--accent)'; });
    inp.addEventListener('blur',  () => { bar.style.borderColor = 'var(--border-default)'; });

    const results = createEl('div', {
      id: 'nbosp-search-results',
      role: 'region',
      'aria-label': 'Search results',
      'aria-live': 'polite',
      style: 'flex:1;overflow-y:auto;padding:8px;',
    });
    root.appendChild(results);
    content.appendChild(root);

    // ════════════════════════════════════════════════════════════════════════
    // LIVE ROW REGISTRY
    // Maintained at render time — avoids querySelectorAll on every keydown.
    // ════════════════════════════════════════════════════════════════════════

    let liveRows = [];

    // ════════════════════════════════════════════════════════════════════════
    // EVENT DELEGATION — hover + keyboard, on the container not on each row
    // ════════════════════════════════════════════════════════════════════════

    results.addEventListener('mouseover', (e) => {
      const row = e.target.closest('[data-result-row]');
      if (row) row.style.background = 'var(--bg-hover)';
    });
    results.addEventListener('mouseout', (e) => {
      const row = e.target.closest('[data-result-row]');
      if (row) row.style.background = '';
    });

    // Delegated focus ring — no per-row focus/blur listeners needed
    results.addEventListener('focusin', (e) => {
      const row = e.target.closest('[data-result-row]');
      if (row) row.style.boxShadow = '0 0 0 2px var(--accent)';
    });
    results.addEventListener('focusout', (e) => {
      const row = e.target.closest('[data-result-row]');
      if (row) row.style.boxShadow = '';
    });

    results.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      if (!liveRows.length) return;
      if (e.key === 'Enter') {
        const idx = liveRows.indexOf(document.activeElement);
        if (idx !== -1) liveRows[idx].click();
        return;
      }
      e.preventDefault();
      const idx = liveRows.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown'
        ? liveRows[idx + 1] ?? liveRows[0]
        : liveRows[idx - 1] ?? liveRows[liveRows.length - 1];
      next.focus();
    });

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        liveRows[0]?.focus();
      }
    });

    // ════════════════════════════════════════════════════════════════════════
    // DOM HELPERS
    // ════════════════════════════════════════════════════════════════════════

    function iconForMime(mime) {
      if (!mime) return 'file';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('audio/')) return 'music';
      if (mime.startsWith('video/')) return 'video';
      return 'file';
    }

    /** Builds a result row and registers it in liveRows. */
    function buildRow(icon, primary, secondary, onActivate) {
      const row = createEl('div', {
        role: 'button',
        tabindex: '0',
        'data-result-row': '',
        style: 'display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:6px;cursor:pointer;transition:background 0.1s;outline:none;',
      });
      row.addEventListener('click', onActivate);
      liveRows.push(row);

      const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;', 'aria-hidden': 'true' });
      ico.innerHTML = svgIcon(icon, 16);

      const textWrap = createEl('div', { style: 'min-width:0;flex:1;' });
      const pri = createEl('div', { style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
      pri.textContent = primary;
      const sec = createEl('div', { style: 'font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
      sec.textContent = secondary;

      textWrap.append(pri, sec);
      row.append(ico, textWrap);
      return row;
    }

    /** Builds a labelled section from items using renderFn, appended to a fragment. */
    function buildSection(title, items, renderFn) {
      if (!items.length) return null;
      const frag = document.createDocumentFragment();
      const wrap = createEl('div', { style: 'margin-bottom:12px;' });
      const hdr  = createEl('div', {
        style: 'font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;padding:6px 8px 4px;',
      });
      hdr.textContent = title;
      wrap.appendChild(hdr);
      for (const item of items.slice(0, 12)) {
        const row = renderFn(item);
        if (row) wrap.appendChild(row);
      }
      frag.appendChild(wrap);
      return frag;
    }

    function showHint() {
      liveRows = [];
      results.textContent = '';
      const hint = createEl('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:80%;color:var(--text-muted);gap:8px;',
      });
      const ico = createEl('span', { 'aria-hidden': 'true' });
      ico.innerHTML = svgIcon('search', 36);
      const lbl = createEl('div', { style: 'font-size:13px;margin-top:10px;' });
      lbl.textContent = 'Type to search';
      hint.append(ico, lbl);
      results.appendChild(hint);
    }

    function showEmpty(q) {
      const msg = createEl('div', {
        style: 'padding:24px 8px;text-align:center;color:var(--text-muted);font-size:13px;',
      });
      msg.textContent = `No results for "${q}"`;
      results.appendChild(msg);
    }

    // ════════════════════════════════════════════════════════════════════════
    // CORE SEARCH
    // ════════════════════════════════════════════════════════════════════════

    let fetchController = null;

    async function doSearch(rawQuery) {
      fetchController?.abort();
      fetchController = new AbortController();
      const { signal } = fetchController;

      const q  = rawQuery;
      const lq = q.toLowerCase();

      // Reset live row registry and clear results DOM in one shot
      liveRows = [];
      results.textContent = '';

      if (!q.trim()) { showHint(); return; }

      // ── Local results — trigram index lookups (effectively O(1)) ────────────
      let hasAnyLocal = false;

      const fileHits = searchFiles(lq);
      const filesSec = buildSection('Files', fileHits.slice(0, 12), (f) => {
        const path = filePathCache.get(f.id) || (f.name || '');
        return buildRow(iconForMime(f.mimeType), f.name || '(unnamed)', path, () => {
          if (f.mimeType?.startsWith('image/')) WM.createWindow('nbosp-gallery', { fileId: f.id });
          else if (f.mimeType?.startsWith('audio/')) WM.createWindow('nbosp-music', { fileId: f.id });
          else WM.createWindow('quill', { fileId: f.id });
        });
      });
      if (filesSec) { results.appendChild(filesSec); hasAnyLocal = true; }

      const contactHits = localCache.searchContacts(lq);
      const contactsSec = buildSection('Contacts', contactHits, (c) =>
        buildRow('users', c.name || '(no name)', c.email || c.phone || '', () =>
          WM.createWindow('nbosp-contacts', { contactId: c.id })
        )
      );
      if (contactsSec) { results.appendChild(contactsSec); hasAnyLocal = true; }

      const dlHits = localCache.searchDownloads(lq);
      const dlSec = buildSection('Downloads', dlHits, (d) =>
        buildRow('download', d.name || '(unnamed)', d.url || '', () =>
          WM.createWindow('nbosp-downloads', { itemId: d.id })
        )
      );
      if (dlSec) { results.appendChild(dlSec); hasAnyLocal = true; }

      // ── Web results — cache-first, then fetch ────────────────────────────────
      let webHits = getCachedWeb(q);

      if (webHits === null) {
        const loadingEl = createEl('div', { style: 'padding:8px;color:var(--text-muted);font-size:12px;' });
        loadingEl.textContent = 'Fetching web results…';
        results.appendChild(loadingEl);

        webHits = [];
        try {
          webHits = await fetchDDG(q, signal);
          setCachedWeb(q, webHits);
        } catch (err) {
          if (err.name !== 'AbortError') console.warn('[nbosp-search] Web fetch failed:', err);
        }

        if (signal.aborted) return;
        loadingEl.remove();
      }

      if (webHits.length) {
        const webSec = buildSection('Web', webHits, (r) =>
          buildRow('globe', r.title, r.desc || r.href, () =>
            WM.createWindow('browser', { url: r.href })
          )
        );
        if (webSec) results.appendChild(webSec);
      } else {
        const fallback = buildRow(
          'globe',
          `Search Brave for "${q}"`,
          'Open in browser',
          () => WM.createWindow('browser', {
            url: 'https://search.brave.com/search?' + new URLSearchParams({ q }),
          })
        );
        results.appendChild(fallback);
      }

      if (!hasAnyLocal && !webHits.length) showEmpty(q);
    }

    // ════════════════════════════════════════════════════════════════════════
    // INPUT HANDLING — debounce 80ms + independent prefetch
    // ════════════════════════════════════════════════════════════════════════

    let debounceId     = null;
    let lastPrefetchQ  = null;

    inp.addEventListener('input', () => {
      const val = inp.value;
      clearX.style.display = val ? '' : 'none';
      clearTimeout(debounceId);

      if (val.trim().length >= 3 && val !== lastPrefetchQ && !getCachedWeb(val)) {
        lastPrefetchQ = val;
        fetchDDG(val)
          .then(hits => { if (!getCachedWeb(val)) setCachedWeb(val, hits); })
          .catch(() => {});
      }

      debounceId = setTimeout(() => doSearch(val), 80);
    });

    clearX.addEventListener('click', () => {
      inp.value = '';
      clearX.style.display = 'none';
      fetchController?.abort();
      doSearch('');
      inp.focus();
    });

    doSearch('');
    inp.focus();
  },
});