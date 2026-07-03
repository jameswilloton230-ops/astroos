registerApp({
  id: 'nbosp-downloads', name: 'Downloads', icon: 'download',
  description: 'Download Manager',
  defaultSize: [580, 460], minSize: [400, 300],

  init(content, _state) {
    // ── NovaByte runtime guard ─────────────────────────────────────────────────
    if (!window.AppDirs?.getVFSDir('com.nbosp.downloads', 'files')) {
      content.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center"><b>com.nbosp.downloads</b>' +
        '<br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    const SK = 'nova_downloads';

    // ── Inject hover / colour styles once per page lifetime ───────────────────
    // FIX #10 #17: CSS hover replaces per-row mouseenter/mouseleave closures.
    // Eliminates O(5N) listener allocations per render and the visual bug where
    // delBtn.style.color='' would inherit the wrong colour after first hover.
    if (!document.getElementById('nbosp-dl-style')) {
      const s = document.createElement('style');
      s.id = 'nbosp-dl-style';
      s.textContent =
        '.dl-row:hover{background:var(--bg-hover)}' +
        '.dl-delbtn{color:var(--text-muted);transition:color 0.1s}' +
        '.dl-row:hover .dl-delbtn{color:var(--text-danger)}';
      document.head.appendChild(s);
    }

    // ── Storage helpers ────────────────────────────────────────────────────────
    // FIX #2: validate parsed value is actually an Array.
    function load() {
      try {
        const parsed = JSON.parse(localStorage.getItem(SK) ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    // FIX #1: save now catches storage errors (quota exceeded / private mode).
    function save(arr) {
      try { lsSave(SK, arr); } catch { /* degrade silently */ }
    }

    // ── Formatters ─────────────────────────────────────────────────────────────
    // FIX #3: typeof guard so 0-byte files show "0 B" rather than "—".
    const fmtSize = (b) => {
      if (typeof b !== 'number' || b < 0) return '—';
      if (b < 1_024)       return `${b} B`;
      if (b < 1_048_576)   return `${(b / 1_024).toFixed(1)} KB`;
      return `${(b / 1_048_576).toFixed(1)} MB`;
    };

    // FIX #13: create DateTimeFormat instance once; reused on every call.
    const _dtf = new Intl.DateTimeFormat([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const fmtDate = (ts) => {
      if (!ts) return '';
      try { return _dtf.format(new Date(+ts)); } catch { return ''; }
    };

    // ── Status style map ───────────────────────────────────────────────────────
    // FIX #9 #14: closed set of known statuses — unknown values fall back to
    // 'done' without touching external strings; frozen singletons = zero allocs.
    const STATUS = Object.freeze({
      downloading: Object.freeze({ bg: 'rgba(88,166,255,0.14)', color: 'var(--accent)' }),
      failed:      Object.freeze({ bg: 'rgba(248,81,73,0.14)',  color: 'var(--text-danger)' }),
      done:        Object.freeze({ bg: 'rgba(63,185,80,0.14)',  color: 'var(--text-success)' }),
    });
    const statusStyle = (s) => STATUS[s] ?? STATUS.done;

    // ── Root layout ────────────────────────────────────────────────────────────
    const root = createEl('div', { style: 'display:flex;flex-direction:column;height:100%;overflow:hidden;' });
    content.appendChild(root);

    // ── Toolbar ────────────────────────────────────────────────────────────────
    const toolbar = createEl('div', {
      style: 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-elevated);',
    });
    // FIX #5: titleEl was created and held in a variable but never read; inlined.
    toolbar.append(
      createEl('span', { textContent: 'Downloads', style: 'font-size:13px;font-weight:600;flex:1;' }),
    );
    const clearBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear completed' });
    toolbar.appendChild(clearBtn);
    root.appendChild(toolbar);

    // ── Download list container ────────────────────────────────────────────────
    const list = createEl('div', { style: 'flex:1;overflow-y:auto;' });
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Downloads');
    root.appendChild(list);

    // ── Row builder ────────────────────────────────────────────────────────────
    function buildRow(item, idx) {
      const row = createEl('div', {
        className: 'dl-row',
        style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border-subtle);transition:background 0.1s;',
      });
      row.setAttribute('role', 'listitem');
      // FIX #7: cap URL length to prevent tooltip reflow abuse.
      if (item.url) row.title = String(item.url).slice(0, 2048);

      // File icon — svgIcon is OS-controlled; innerHTML is safe here.
      const ico = createEl('span', { style: 'color:var(--accent);flex-shrink:0;' });
      ico.innerHTML = svgIcon('file', 18);

      // FIX #6: fallback text when item.name is empty/missing.
      // All user-sourced strings go through textContent — never innerHTML.
      const nameEl = createEl('div', {
        style: 'font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      });
      nameEl.textContent = item.name ?? '(unnamed)';

      const metaEl = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:2px;' });
      metaEl.textContent = item.ts
        ? `${fmtSize(item.size)}  ·  ${fmtDate(item.ts)}`
        : fmtSize(item.size);

      const info = createEl('div', { style: 'flex:1;min-width:0;' });
      info.append(nameEl, metaEl);

      const st = statusStyle(item.status);
      const badge = createEl('span', {
        style: `font-size:10px;padding:2px 8px;border-radius:20px;font-weight:600;flex-shrink:0;background:${st.bg};color:${st.color};`,
      });
      badge.textContent = item.status ?? 'done';

      // FIX #10 #17: no inline colour — CSS .dl-delbtn rule owns the colour for
      // both normal and hover states, so style is never partially cleared.
      const delBtn = createEl('button', {
        className: 'dl-delbtn',
        style: 'background:none;border:none;cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;',
        title: 'Remove',
      });
      delBtn.setAttribute('aria-label', `Remove ${String(item.name ?? 'download').slice(0, 200)}`);
      // FIX #4 (partial): store idx as data attribute so the delegated handler
      // re-validates it against a fresh load() before splicing.
      delBtn.dataset.del = String(idx);
      delBtn.innerHTML = svgIcon('x', 14); // OS-controlled — safe

      row.append(ico, info, badge, delBtn);
      return row;
    }

    // ── Empty state ────────────────────────────────────────────────────────────
    // FIX #8: svgIcon() return value is isolated in its own span.
    // Static label text uses textContent — safe regardless of svgIcon output.
    function buildEmpty() {
      const wrap = createEl('div', {
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-muted);gap:8px;',
      });
      const ico = createEl('span');
      ico.innerHTML = svgIcon('archive', 34); // OS-controlled — safe

      const label = createEl('div', { style: 'font-size:13px;margin-top:10px;color:var(--text-secondary);' });
      label.textContent = 'No downloads yet';

      const sub = createEl('div', { style: 'font-size:11px;margin-top:4px;' });
      sub.textContent = 'Files saved from the browser appear here';

      wrap.append(ico, label, sub);
      return wrap;
    }

    // ── Event delegation: delete ───────────────────────────────────────────────
    // FIX #10: single handler on the container instead of one closure per button.
    // FIX #4:  idx is re-validated against a fresh load() before any splice.
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      const idx = parseInt(btn.dataset.del, 10);
      if (!Number.isFinite(idx) || idx < 0) return;
      const arr = load();
      if (idx >= arr.length) return; // stale-index guard
      arr.splice(idx, 1);
      save(arr);
      render();
    });

    // ── Render ─────────────────────────────────────────────────────────────────
    // FIX #12 #15: replaceChildren(fragment) — single reflow instead of N appends.
    function render() {
      const items = load(); // FIX: single load() call for the whole render pass
      const frag  = document.createDocumentFragment();

      if (items.length === 0) {
        frag.appendChild(buildEmpty());
      } else {
        for (let i = 0; i < items.length; i++) {
          frag.appendChild(buildRow(items[i], i));
        }
      }

      list.replaceChildren(frag);
    }

    // ── Clear completed ────────────────────────────────────────────────────────
    clearBtn.addEventListener('click', () => {
      save(load().filter((it) => it.status === 'downloading'));
      render();
    });

    // ── Hook render into the global Downloads API for live updates ────────────
    // FIX #11 (mitigated): guard against missing API; the strong ref is an
    // intentional NovaByte contract and cannot be avoided without OS-level change.
    if (window.Downloads) window.Downloads._renderFn = render;

    render();
  },
});