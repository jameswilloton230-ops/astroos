registerApp({
  id: 'com.nbosp.inspector',
  name: 'Inspector',
  version: '3.0.2',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iaW5zLXJpbSIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNjBhNWZhIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzI1NjNlYiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iaW5zLWdsYXNzIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNlZmY2ZmYiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjYmZkYmZlIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJpbnMtaGFuZGxlIiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmYmJmMjQiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZDk3NzA2Ii8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogIDwvZGVmcz4KICA8IS0tIHNoYWRvdyAtLT4KICA8ZWxsaXBzZSBjeD0iNDgiIGN5PSI5MCIgcng9IjMwIiByeT0iNiIgZmlsbD0iIzAwMCIgb3BhY2l0eT0iMC4xOCIvPgoKICA8IS0tIGhhbmRsZSAtLT4KICA8cmVjdCB4PSI2MCIgeT0iNTgiIHdpZHRoPSIxNCIgaGVpZ2h0PSIzMCIgcng9IjYiIGZpbGw9InVybCgjaW5zLWhhbmRsZSkiIHRyYW5zZm9ybT0icm90YXRlKDQ1IDY3IDczKSIvPgoKICA8IS0tIGxlbnMgcmltIC0tPgogIDxjaXJjbGUgY3g9IjQyIiBjeT0iNDIiIHI9IjI4IiBmaWxsPSJ1cmwoI2lucy1yaW0pIi8+CiAgPCEtLSBsZW5zIGdsYXNzIC0tPgogIDxjaXJjbGUgY3g9IjQyIiBjeT0iNDIiIHI9IjIwIiBmaWxsPSJ1cmwoI2lucy1nbGFzcykiLz4KCiAgPCEtLSBzY2FuIHB1bHNlIGxpbmUgaW5zaWRlIHRoZSBnbGFzcyAtLT4KICA8cG9seWxpbmUgcG9pbnRzPSIyOCw0NCAzNSw0NCAzOSwzNCA0NSw1MiA0OSw0NCA1Niw0NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMjU2M2ViIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CgogIDwhLS0gaGlnaGxpZ2h0IC0tPgogIDxlbGxpcHNlIGN4PSIzNSIgY3k9IjMwIiByeD0iMTAiIHJ5PSI1IiBmaWxsPSIjZmZmIiBvcGFjaXR5PSIwLjM1IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjUgMzUgMzApIi8+Cjwvc3ZnPgo=',
  description: 'Inspect registered apps and open windows on NovaByte OS',
  category: 'developer',
  devOnly: true,
  defaultSize: [700, 550],
  minSize: [420, 350],
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Inspector.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    // AbortController covers the filter input and every per-row
    // focus/close button rebound on each render(). state.cleanups.push is
    // the real teardown hook (confirmed against wm.js, same as every other
    // dev app here) — init()'s return value is discarded.
    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    const filterRow = createEl('div', { style: 'margin-bottom:12px;flex-shrink:0;display:flex;gap:8px;' });
    const filterInput = createEl('input', { placeholder: 'Filter by app id, name, or window id…', style: 'flex:1;box-sizing:border-box;padding:7px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;' });
    const exportBtn = createEl('button', { textContent: 'Export', title: 'Download the currently filtered apps + windows as JSON', style: 'padding:6px 12px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;' });
    filterRow.appendChild(filterInput);
    filterRow.appendChild(exportBtn);
    content.appendChild(filterRow);

    const scroll = createEl('div', { style: 'flex:1;overflow:auto;' });
    content.appendChild(scroll);

    const expandedApps = new Set(); // app ids currently showing detail panel
    const expandedWins = new Set(); // window ids currently showing detail panel

    function render() {
      const apps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];
      const wins = typeof OS !== 'undefined' && OS.windows ? [...OS.windows.values()] : [];
      const q = filterInput.value.trim().toLowerCase();

      // Look up each window's friendly display name (matching what
      // Registered Apps shows) instead of the raw appId string — 'Clock'
      // vs 'com.nbosp.clock' was the same app shown two different ways.
      const appNameById = new Map(apps.map(a => [a.id, a.name || a.id]));

      const filteredApps = q ? apps.filter(a => (a.id || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q)) : apps;
      const filteredWins = q ? wins.filter(w => (w.appId || '').toLowerCase().includes(q) || (w.id || '').toLowerCase().includes(q)) : wins;

      scroll.innerHTML = '';

      const appsSection = createEl('div', { style: 'margin-bottom:24px;' });
      appsSection.appendChild(createEl('h3', { textContent: `Registered Apps (${filteredApps.length})`, style: 'margin:0 0 8px;font-size:14px;color:var(--accent);' }));
      const appsList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });

      filteredApps.forEach(app => {
        const row = createEl('div', { style: 'padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
        const header = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;cursor:pointer;' });
        const titleWrap = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
        titleWrap.appendChild(createEl('span', { textContent: expandedApps.has(app.id) ? '▾' : '▸', style: 'color:var(--text-muted);font-size:10px;width:10px;display:inline-block;' }));
        titleWrap.appendChild(createEl('strong', { textContent: app.name || app.id }));
        header.appendChild(titleWrap);
        const badges = [];
        if (app.verified) badges.push(createEl('span', { textContent: '✓ verified', style: 'font-size:11px;color:#3fb950;' }));
        if (app.permissions?.length) badges.push(createEl('span', { textContent: app.permissions.length + ' perms', style: 'font-size:11px;color:var(--text-muted);' }));
        badges.forEach(b => header.appendChild(b));
        header.addEventListener('click', () => {
          if (expandedApps.has(app.id)) expandedApps.delete(app.id); else expandedApps.add(app.id);
          render();
        }, { signal: ac.signal });
        row.appendChild(header);

        // Close All — uses the same window.WM.closeWindow(id) call the
        // per-window Close button already uses (see Open Windows section
        // below), just looped over every open window matching this app id.
        // `wins` is the full unfiltered window list from the top of
        // render(), not filteredWins, so this counts/closes all of this
        // app's windows regardless of what the filter box currently shows.
        const appWinIds = wins.filter(w => w.appId === app.id).map(w => w.id);
        if (appWinIds.length) {
          const closeAllBtn = createEl('button', {
            textContent: `Close All (${appWinIds.length})`,
            style: 'padding:2px 8px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:10px;margin-top:6px;'
          });
          closeAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            appWinIds.forEach(id => window.WM?.closeWindow?.(id));
          }, { signal: ac.signal });
          row.appendChild(closeAllBtn);
        }

        const meta = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-top:4px;font-family:monospace;' });
        meta.textContent = `id: ${app.id} · version: ${app.version || '?'} · launchCount: ${app.launchCount || 0}`;
        row.appendChild(meta);

        if (app.permissions?.length) {
          const permStr = app.permissions.map(p => typeof p === 'string' ? p : p.permission || p).join(', ');
          row.appendChild(createEl('div', { textContent: 'Permissions: ' + permStr, style: 'font-size:11px;color:var(--text-muted);margin-top:4px;' }));
        }

        // Detail panel — fields that exist on every registerApp() call in
        // this codebase (confirmed against console.js/perf.js/etc: id,
        // name, description, category, devOnly, autoGrant, defaultSize,
        // minSize are all real declared fields) but weren't surfaced here
        // before, only id/name/permissions/verified/launchCount were.
        if (expandedApps.has(app.id)) {
          const detail = createEl('div', { style: 'margin-top:8px;padding:8px;background:var(--bg-default);border-radius:4px;font-size:11px;font-family:monospace;display:flex;flex-direction:column;gap:4px;' });
          const rows = [
            ['description', app.description || '(none)'],
            ['category', app.category || '(none)'],
            ['devOnly', String(!!app.devOnly)],
            ['autoGrant', String(!!app.autoGrant)],
            ['defaultSize', app.defaultSize ? app.defaultSize.join(' x ') : '(none)'],
            ['minSize', app.minSize ? app.minSize.join(' x ') : '(none)'],
          ];
          rows.forEach(([label, val]) => {
            const r = createEl('div', { style: 'display:flex;gap:8px;' });
            r.appendChild(createEl('span', { textContent: label, style: 'color:var(--text-muted);width:90px;flex-shrink:0;' }));
            r.appendChild(createEl('span', { textContent: String(val), style: 'word-break:break-all;' }));
            detail.appendChild(r);
          });
          if (app.permissions?.length) {
            const rawLabel = createEl('div', { textContent: 'raw permissions:', style: 'color:var(--text-muted);margin-top:2px;' });
            detail.appendChild(rawLabel);
            const rawBox = createEl('div', { textContent: JSON.stringify(app.permissions, null, 2), style: 'white-space:pre-wrap;word-break:break-all;font-size:10px;' });
            detail.appendChild(rawBox);
          }
          row.appendChild(detail);
        }

        appsList.appendChild(row);
      });

      if (!filteredApps.length) {
        appsList.appendChild(createEl('div', { textContent: apps.length ? 'No apps match filter' : 'No apps registered', style: 'color:var(--text-muted);padding:8px;' }));
      }
      appsSection.appendChild(appsList);
      scroll.appendChild(appsSection);

      // Windows section
      const winsSection = createEl('div');
      winsSection.appendChild(createEl('h3', { textContent: `Open Windows (${filteredWins.length})`, style: 'margin:0 0 8px;font-size:14px;color:var(--accent);' }));
      const winsList = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;' });

      filteredWins.forEach(win => {
        const row = createEl('div', { style: 'padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);' });
        const header = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;cursor:pointer;' });
        const titleWrap = createEl('div', { style: 'min-width:0;overflow:hidden;display:flex;align-items:center;gap:8px;' });
        titleWrap.appendChild(createEl('span', { textContent: expandedWins.has(win.id) ? '▾' : '▸', style: 'color:var(--text-muted);font-size:10px;width:10px;display:inline-block;flex-shrink:0;' }));
        titleWrap.appendChild(createEl('strong', { textContent: appNameById.get(win.appId) || win.appId || 'unknown' }));
        titleWrap.appendChild(createEl('span', { textContent: win.appId, style: 'font-size:10px;color:var(--text-muted);opacity:0.7;' }));
        titleWrap.appendChild(createEl('span', { textContent: win.id, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;' }));
        if (OS.focusedWindowId === win.id) {
          titleWrap.appendChild(createEl('span', { textContent: 'focused', style: 'font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px;' }));
        }
        header.appendChild(titleWrap);
        // Clicking the row toggles detail, but the Focus/Close buttons
        // below need to not also trigger that — handled via stopPropagation
        // on the button clicks rather than here, since the buttons are
        // nested inside this same header element.
        header.addEventListener('click', () => {
          if (expandedWins.has(win.id)) expandedWins.delete(win.id); else expandedWins.add(win.id);
          render();
        }, { signal: ac.signal });

        // Click-to-act: WM.focusWindow/closeWindow are real public methods
        // on the window-manager singleton (confirmed as window.WM in
        // wm.js — every internal call site uses the same two functions).
        // No app in this codebase called them before; this is genuinely
        // new capability, not a rename of something that existed.
        //
        // id is read from a data attribute via event.currentTarget inside
        // the handler, not captured via closure over `win` — this makes it
        // impossible for the id to go stale regardless of how often/when
        // render() re-runs relative to when the click actually fires.
        const btns = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
        const focusBtn = createEl('button', { textContent: 'Focus', style: 'padding:3px 10px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;' });
        focusBtn.dataset.windowId = win.id;
        focusBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // don't also toggle the detail panel
          window.WM?.focusWindow?.(e.currentTarget.dataset.windowId);
        }, { signal: ac.signal });
        const closeBtn = createEl('button', { textContent: 'Close', style: 'padding:3px 10px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:11px;' });
        closeBtn.dataset.windowId = win.id;
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.WM?.closeWindow?.(e.currentTarget.dataset.windowId);
        }, { signal: ac.signal });
        btns.appendChild(focusBtn);
        btns.appendChild(closeBtn);
        header.appendChild(btns);
        row.appendChild(header);

        // Confirmed against wm.js: x/y/width/height/minimized/maximized are
        // flat on the state object itself (OS.windows.set(id, state)), not
        // nested under a .state property.
        row.appendChild(createEl('div', { textContent: `${win.x || 0},${win.y || 0} ${win.width || '?'}x${win.height || '?'}${win.minimized ? ' [min]' : ''}${win.maximized ? ' [max]' : ''}`, style: 'font-size:11px;color:var(--text-muted);margin-top:4px;font-family:monospace;' }));

        // Detail panel — the confirmed-real fields above plus a generic
        // dump of any other own-enumerable keys on the state object. Not
        // hand-listing more fields here since inspector.js/perf.js/
        // sysaccess.js only actually reference appId/id/x/y/width/height/
        // minimized/maximized/content anywhere in this codebase; anything
        // beyond that is real but unconfirmed shape, so it's shown
        // generically rather than guessed at by name. `content` (a DOM
        // node) is excluded since it isn't meaningfully displayable as text.
        if (expandedWins.has(win.id)) {
          const detail = createEl('div', { style: 'margin-top:8px;padding:8px;background:var(--bg-default);border-radius:4px;font-size:11px;font-family:monospace;display:flex;flex-direction:column;gap:4px;' });
          const known = new Set(['appId', 'id', 'x', 'y', 'width', 'height', 'minimized', 'maximized', 'content', 'cleanups']);
          const otherKeys = Object.keys(win).filter(k => !known.has(k));
          if (otherKeys.length) {
            const rawLabel = createEl('div', { textContent: 'other fields on this window state:', style: 'color:var(--text-muted);' });
            detail.appendChild(rawLabel);
            otherKeys.forEach(k => {
              let val;
              try {
                val = typeof win[k] === 'object' ? JSON.stringify(win[k]) : String(win[k]);
              } catch {
                val = '(unserializable)';
              }
              const r = createEl('div', { style: 'display:flex;gap:8px;' });
              r.appendChild(createEl('span', { textContent: k, style: 'color:var(--text-muted);width:90px;flex-shrink:0;' }));
              r.appendChild(createEl('span', { textContent: val, style: 'word-break:break-all;' }));
              detail.appendChild(r);
            });
          } else {
            detail.appendChild(createEl('div', { textContent: 'No additional fields beyond those shown above.', style: 'color:var(--text-muted);' }));
          }
          if (Array.isArray(win.cleanups)) {
            detail.appendChild(createEl('div', { textContent: `cleanups registered: ${win.cleanups.length}`, style: 'color:var(--text-muted);margin-top:2px;' }));
          }
          row.appendChild(detail);
        }

        winsList.appendChild(row);
      });

      if (!filteredWins.length) {
        winsList.appendChild(createEl('div', { textContent: wins.length ? 'No windows match filter' : 'No windows open', style: 'color:var(--text-muted);padding:8px;' }));
      }
      winsSection.appendChild(winsList);
      scroll.appendChild(winsSection);
    }

    filterInput.addEventListener('input', render, { signal: ac.signal });

    // Recomputes the filter fresh at click time rather than depending on
    // filteredApps/filteredWins from the last render() call — those are
    // local to render() and would otherwise require hoisting state out or
    // risking a stale closure if render() ran again (e.g. via a live
    // event) between the last paint and the click actually firing.
    exportBtn.addEventListener('click', () => {
      const apps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];
      const wins = typeof OS !== 'undefined' && OS.windows ? [...OS.windows.values()] : [];
      const q = filterInput.value.trim().toLowerCase();
      const filteredApps = q ? apps.filter(a => (a.id || '').toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q)) : apps;
      const filteredWins = q ? wins.filter(w => (w.appId || '').toLowerCase().includes(q) || (w.id || '').toLowerCase().includes(q)) : wins;

      const payload = {
        exportedAt: new Date().toISOString(),
        filter: filterInput.value.trim() || null,
        apps: filteredApps.map(a => ({
          id: a.id, name: a.name, version: a.version, launchCount: a.launchCount,
          verified: !!a.verified, category: a.category, devOnly: !!a.devOnly, autoGrant: !!a.autoGrant,
          defaultSize: a.defaultSize, minSize: a.minSize, permissions: a.permissions,
        })),
        windows: filteredWins.map(w => ({
          id: w.id, appId: w.appId, x: w.x, y: w.y, width: w.width, height: w.height,
          minimized: !!w.minimized, maximized: !!w.maximized, focused: OS.focusedWindowId === w.id,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = createEl('a', { href: url, download: 'nbosp-inspector-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Same delayed-revoke pattern as the export buttons in the other
      // apps in this codebase — some browsers cancel the download if the
      // blob URL is revoked before the click's download actually starts.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, { signal: ac.signal });

    // Live updates: OS.events fires 'app:opened' / 'app:closed' / 'app:focused'
    // (confirmed as the complete set of window-lifecycle events emitted
    // anywhere in wm.js — there's no resize/move/minimize event, so those
    // still rely on the polling fallback below rather than being instant).
    //
    // Root cause found live: wm.js's focusWindow() previously re-emitted
    // 'app:focused' on every single pointerdown inside a window's own
    // content, even when that window was already focused — so clicking
    // ANY button inside Inspector re-triggered a full render() (measured:
    // 63 DOM mutations in 3s just from normal interaction), destroying and
    // recreating the very button being clicked before its own click event
    // could fire. Fixed at the source in wm.js (focusWindow now no-ops
    // when already focused and not minimized). This local guard is a
    // second, cheap layer of defense: even if some other future emitter
    // fires 'app:focused' redundantly, Inspector won't re-render unless
    // the focused window id actually changed.
    let lastFocusedId = OS.focusedWindowId;
    const deferredRender = () => queueMicrotask(render);
    const onOpened  = deferredRender;
    const onClosed  = deferredRender;
    const onFocused = () => {
      if (OS.focusedWindowId === lastFocusedId) return;
      lastFocusedId = OS.focusedWindowId;
      deferredRender();
    };
    OS.events.on('app:opened', onOpened);
    OS.events.on('app:closed', onClosed);
    OS.events.on('app:focused', onFocused);

    const timeoutId = setTimeout(render, 100);
    // Reduced from the original 5s: this is now a fallback for state the
    // event system doesn't cover (minimize/maximize/drag/resize), not the
    // primary refresh mechanism, so a shorter interval doesn't cost much.
    const intervalId = setInterval(render, 2000);

    state.cleanups.push(() => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
      OS.events.off('app:opened', onOpened);
      OS.events.off('app:closed', onClosed);
      OS.events.off('app:focused', onFocused);
    });
  }
});