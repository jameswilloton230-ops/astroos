registerApp({
  id: 'com.nbosp.downloads', name: 'Downloads', icon: 'download',
  version: '3.0.2',
  description: 'Download Manager',
  defaultSize: [580, 460], minSize: [400, 300],

  init(content, state) {
    // ── NovaByte runtime guard ─────────────────────────────────────────────────
    if (!window.AppDirs?.getAppDataPath('com.nbosp.downloads', 'files')) {
      content.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML =
        '<div style="font-size:32px">⚠️</div>' +
        '<div style="font-size:14px;text-align:center"><b>com.nbosp.downloads</b>' +
        '<br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (typeof window.Downloads?.getAll !== 'function') {
      throw new Error('Downloads History system service is unavailable');
    }

    // ── Formatters ─────────────────────────────────────────────────────────────
    // FIX #3: typeof guard so 0-byte files show "0 B" rather than "—".
    const fmtSize = (b) => {
      if (typeof b !== 'number' || b < 0) return '—';
      if (b < 1_024)       return `${b} B`;
      if (b < 1_048_576)   return `${(b / 1_024).toFixed(1)} KB`;
      return `${(b / 1_048_576).toFixed(1)} MB`;
    };

    // FIX #13: create DateTimeFormat instance once per locale/timezone; reused on every call.
    let _dtfCache = null;
    let _dtfCacheKey = null;
    const getFmtDate = () => {
      const locale = (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function')
        ? OS.settings.get('region') || navigator.language
        : navigator.language;
      const tz = (typeof OS !== 'undefined' && OS.settings && typeof OS.settings.get === 'function')
        ? OS.settings.get('timezone')
        : undefined;
      const cacheKey = locale + '|' + (tz || '');
      if (_dtfCacheKey === cacheKey && _dtfCache) return _dtfCache;
      try {
        const opts = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
        if (tz) opts.timeZone = tz;
        _dtfCache = new Intl.DateTimeFormat(locale, opts);
      } catch {
        _dtfCache = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      }
      _dtfCacheKey = cacheKey;
      return _dtfCache;
    };
    const fmtDate = (ts) => {
      if (!ts) return '';
      try { return getFmtDate().format(new Date(+ts)); } catch { return ''; }
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
    function buildRow(item) {
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
      delBtn.dataset.del = String(item.id);
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
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-del]');
      if (!btn) return;
      window.Downloads.remove(btn.dataset.del);
    });

    // ── Render ─────────────────────────────────────────────────────────────────
    // FIX #12 #15: replaceChildren(fragment) — single reflow instead of N appends.
    function render() {
      const items = window.Downloads.getAll();
      const frag  = document.createDocumentFragment();

      if (items.length === 0) {
        frag.appendChild(buildEmpty());
      } else {
        for (const item of items) {
          frag.appendChild(buildRow(item));
        }
      }

      list.replaceChildren(frag);
    }

    // ── Clear completed ────────────────────────────────────────────────────────
    clearBtn.addEventListener('click', () => {
      window.Downloads.clearCompleted();
    });

    state.cleanups = state.cleanups || [];
    state.cleanups.push(window.Downloads.subscribe(render));

    render();
  },
});