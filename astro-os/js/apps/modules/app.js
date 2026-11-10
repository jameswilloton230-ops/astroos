registerApp({
  id: 'com.astroos.modules',
  name: 'Modules',
  version: '3.0.2',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibW9kLWwxIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3AtY29sb3I9IiNmZGU2OGEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJtb2QtbDIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI2ZiYmYyNCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNkOTc3MDYiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9Im1vZC1sMyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjZjU5ZTBiIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iI2I0NTMwOSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBzaGFkb3cgLS0+CiAgPGVsbGlwc2UgY3g9IjQ4IiBjeT0iOTAiIHJ4PSIzMCIgcnk9IjYiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTgiLz4KCiAgPCEtLSB0aHJlZSBzdGFja2VkIGRpYW1vbmQgc2xhYnMgLS0+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCwyNiA3NCwzOCA0OCw1MCAyMiwzOCIgZmlsbD0idXJsKCNtb2QtbDEpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw0MiA3NCw1NCA0OCw2NiAyMiw1NCIgZmlsbD0idXJsKCNtb2QtbDIpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI0OCw1OCA3NCw3MCA0OCw4MiAyMiw3MCIgZmlsbD0idXJsKCNtb2QtbDMpIi8+CgogIDwhLS0gcmVmcmVzaCBsb29wIHdyYXBwaW5nIHRoZSBzdGFjayAtLT4KICA8cGF0aCBkPSJNNzYgNTggQTMyIDMyIDAgMSAxIDY2IDI2IiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHBvbHlnb24gcG9pbnRzPSI2MCwxNiA3NCwyMiA2NCwzMiIgZmlsbD0iI2ZmZmZmZiIvPgoKICA8IS0tIGhpZ2hsaWdodCAtLT4KICA8ZWxsaXBzZSBjeD0iNDAiIGN5PSIzMiIgcng9IjEwIiByeT0iNCIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iMC40IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjAgNDAgMzIpIi8+Cjwvc3ZnPgo=',
  description: 'Hot-reload OS JS modules without restarting AstroOS',
  category: 'developer',
  devOnly: true,
  defaultSize: [600, 600],
  minSize: [420, 380],
  // Fetches arbitrary internal module paths and dynamically imports the
  // response — functionally equivalent to remote code execution against
  // the OS's own module tree. Treat this as high-trust, same tier as
  // net:internal + system:settings, not just system:info.
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.astroos.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.astroos.settings</b><br>App data directory missing.<br>This app requires AstroOS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Modules.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;padding:16px;font-size:13px;box-sizing:border-box;';

    const desc = createEl('div', { style: 'margin-bottom:12px;color:var(--text-muted);font-size:12px;flex-shrink:0;' });
    desc.textContent = 'Reload any JS module without restarting the OS. Useful for rapid iteration.';
    content.appendChild(desc);

    // Defaults kept as a starting point, but the list is now editable and
    // persisted — the original hardcoded array meant any module outside
    // this exact set of 8 paths couldn't be hot-reloaded from this app at
    // all. Scoped storage key, same pattern as devconsole's history (see
    // console.js) since there is no filesystem helper for small app
    // state — lsSave/localStorage is what calendar.js, contacts.js, etc.
    // actually use.
    // Config surfaces (module list + safety overrides) live in this app's
    // registry slice (HKNA/com.astroos.modules/{list,safety} via NovaAppConfig);
    // the scoped localStorage keys are the pre-registry seeds and the
    // fail-soft fallbacks. The reload HISTORY stays on localStorage
    // deliberately — it stores whole file contents (bulk data, not config;
    // Windows keeps documents out of the registry too).
    const STORAGE_KEY = 'astroos_modules_list';
    const SAFETY_KEY = 'astroos_modules_safety';   // { [path]: 'safe' | 'unsafe' } manual overrides
    const HISTORY_KEY = 'astroos_modules_history'; // { [path]: { prevCode, newCode, ts } } last reload only
    const MODULES_REG_SLICE = 'com.astroos.modules';
    const DEFAULT_MODULES = [
      { id: 'boot', path: 'js/core/core/boot.js' },
      { id: 'wm', path: 'js/apps/shell-ui/wm.js' },
      { id: 'fs', path: 'js/core/services/fs.js' },
      { id: 'app-registry', path: 'js/platform/core/app-registry.js' },
      { id: 'app-permission-manager', path: 'js/platform/security/app-permission-manager.js' },
      { id: 'system-events', path: 'js/apps/system-events/service.js' },
      { id: 'base-utils', path: 'js/core/utils/base-utils.js' },
      { id: 'debug-overlay', path: 'js/apps/debug-overlay/service.js' },
    ];
    const LEGACY_DEBUG_OVERLAY_PATH = 'js/core/utils/debug-overlay.js';
    const DEBUG_OVERLAY_PATH = 'js/apps/debug-overlay/service.js';

    function loadJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        const val = raw ? JSON.parse(raw) : null;
        return val ?? fallback;
      } catch {
        return fallback;
      }
    }
    function saveJSON(key, val) {
      try {
        if (typeof lsSave === 'function') lsSave(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch {
        // Best-effort — same degrade-silently pattern used elsewhere for
        // storage failures (quota, private mode, etc).
      }
    }

    let modules = loadJSON(STORAGE_KEY, null);
    if (typeof window !== 'undefined' && window.NovaAppConfig) {
      try {
        const stored = window.NovaAppConfig.get(MODULES_REG_SLICE, 'list', { legacyKey: STORAGE_KEY, fallback: null });
        if (Array.isArray(stored) && stored.length) modules = stored;
      } catch { /* fall back to the localStorage read above */ }
    }
    if (!Array.isArray(modules) || !modules.length) modules = DEFAULT_MODULES.slice();
    let modulesPathMigrated = false;
    modules = modules.map(module => {
      if (module?.path !== LEGACY_DEBUG_OVERLAY_PATH) return module;
      modulesPathMigrated = true;
      return { ...module, path: DEBUG_OVERLAY_PATH };
    });

    // Manual safe/unsafe overrides, keyed by path. Auto-detection (see
    // isDangerous below) is a heuristic and can be wrong in both
    // directions — a module might assign window.X without being a
    // singleton other code depends on, or might be dangerous via some
    // other pattern the heuristic doesn't catch. This lets the user
    // correct it per-module instead of being stuck with the guess.
    let safety = loadJSON(SAFETY_KEY, {});
    if (typeof window !== 'undefined' && window.NovaAppConfig) {
      try {
        const stored = window.NovaAppConfig.get(MODULES_REG_SLICE, 'safety', { legacyKey: SAFETY_KEY, fallback: null });
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) safety = stored;
      } catch { /* fall back to the localStorage read above */ }
    }

    // Last reload only, keyed by path — { prevCode, newCode, ts }.
    // Backs both the diff view and undo. Deliberately not a full history
    // stack: unbounded growth of full file contents in localStorage would
    // risk hitting quota fast, and "undo the last reload" covers the
    // actual use case (a reload just made something worse).
    let reloadHistory = loadJSON(HISTORY_KEY, {});

    function saveModules() {
      saveJSON(STORAGE_KEY, modules); // seed + fallback
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try { window.NovaAppConfig.set(MODULES_REG_SLICE, 'list', modules, { legacyKey: STORAGE_KEY }); } catch { /* best-effort */ }
      }
    }
    function saveSafety() {
      saveJSON(SAFETY_KEY, safety); // seed + fallback
      if (typeof window !== 'undefined' && window.NovaAppConfig) {
        try { window.NovaAppConfig.set(MODULES_REG_SLICE, 'safety', safety, { legacyKey: SAFETY_KEY }); } catch { /* best-effort */ }
      }
    }
    function saveHistory() { saveJSON(HISTORY_KEY, reloadHistory); }
    function migratePathKey(record) {
      if (!record || typeof record !== 'object' ||
          !Object.prototype.hasOwnProperty.call(record, LEGACY_DEBUG_OVERLAY_PATH)) {
        return false;
      }
      if (!Object.prototype.hasOwnProperty.call(record, DEBUG_OVERLAY_PATH)) {
        record[DEBUG_OVERLAY_PATH] = record[LEGACY_DEBUG_OVERLAY_PATH];
      }
      delete record[LEGACY_DEBUG_OVERLAY_PATH];
      return true;
    }

    if (modulesPathMigrated) saveModules();
    if (migratePathKey(safety)) saveSafety();
    if (migratePathKey(reloadHistory)) saveHistory();

    // Heuristic for "this module owns state other live code depends on
    // and reloading it can desync the UI" — e.g. wm.js's
    // `const WM = window.WM = (() => {...})()`. Re-running that
    // reassigns window.WM to a fresh object with no memory of currently
    // open windows, which is what caused the blank-content bug earlier.
    // Deliberately conservative (regex, not a parser) — false positives
    // (flagging something harmless) just cost one extra confirm click;
    // false negatives (missing a real singleton) are the worse failure
    // mode, so the manual override exists specifically to patch those.
    function autoDetectDangerous(code) {
      return /^\s*(?:const|let|var)\s+\w+\s*=\s*window\.\w+\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/m.test(code)
          || /^\s*window\.\w+\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/m.test(code)
          || /^\s*window\.\w+\s*=\s*\{/m.test(code);
    }
    function isDangerous(mod, code) {
      const override = safety[mod.path];
      if (override === 'safe') return false;
      if (override === 'unsafe') return true;
      return autoDetectDangerous(code);
    }


    // AbortController for the per-row click listeners below plus the
    // add-module form and reload-all button — same pattern as console.js
    // and inspector.js. state.cleanups.push is the real teardown hook the
    // window manager honors (confirmed against wm.js).
    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;flex-shrink:0;align-items:center;' });
    const reloadAllBtn = createEl('button', { textContent: 'Reload All', style: 'padding:6px 12px;background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;flex-shrink:0;' });
    const filterInput = createEl('input', { placeholder: 'Filter by id or path…', style: 'flex:1;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;' });
    toolbar.appendChild(reloadAllBtn);
    toolbar.appendChild(filterInput);
    content.appendChild(toolbar);

    const reloadSummaryEl = createEl('div', { style: 'font-size:11px;color:var(--text-muted);margin-bottom:8px;flex-shrink:0;min-height:14px;' });
    content.appendChild(reloadSummaryEl);

    const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;' });
    content.appendChild(list);

    const addRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-shrink:0;' });
    const idInput = createEl('input', { placeholder: 'id (e.g. my-module)', style: 'width:140px;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const pathInput = createEl('input', { placeholder: 'path (e.g. js/apps/foo.js)', style: 'flex:1;padding:6px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;' });
    const addBtn = createEl('button', { textContent: 'Add', style: 'padding:6px 14px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
    addRow.appendChild(idInput);
    addRow.appendChild(pathInput);
    addRow.appendChild(addBtn);
    content.appendChild(addRow);

    // Export/import the module list ({id, path}[] only — not safety
    // overrides or reload history, which are per-installation debugging
    // state, not something you'd want to carry between machines/sessions
    // along with a shared list). Matches the JSON export pattern used by
    // console.js/perf.js/sysaccess.js.
    const ioRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-shrink:0;' });
    const exportBtn = createEl('button', { textContent: 'Export List', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;' });
    const importBtn = createEl('button', { textContent: 'Import List', style: 'padding:5px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;' });
    ioRow.appendChild(exportBtn);
    ioRow.appendChild(importBtn);
    content.appendChild(ioRow);

    exportBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(modules, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = createEl('a', { href: url, download: 'astroos-modules-list-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Same delayed-revoke pattern as other export buttons in this
      // codebase (console.js/perf.js/sysaccess.js) — some browsers cancel
      // the download if the blob URL is revoked before it actually starts.
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, { signal: ac.signal });

    importBtn.addEventListener('click', async () => {
      const file = await SystemDialogs.open({
        title: 'Import Module List',
        filter: (name, isDir) => isDir || name.toLowerCase().endsWith('.json'),
      });
      if (!file) return;
      try {
        const text = typeof file.content === 'string' ? file.content : file.content.toString('utf8');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
        // Validate shape before trusting it — a malformed import (missing
        // id/path, wrong types) would otherwise silently corrupt the list
        // and only surface as confusing errors much later when rendering
        // or reloading a broken entry.
        const valid = parsed.every(m => m && typeof m.id === 'string' && typeof m.path === 'string');
        if (!valid) throw new Error('Each entry must have string "id" and "path" fields');

        // Merge by path (dedupe), imported entries win on conflict — matches
        // "import" intent (bring in a list) rather than silently discarding
        // anything that collides with what's already there.
        const byPath = new Map(modules.map(m => [m.path, m]));
        parsed.forEach(m => byPath.set(m.path, { id: m.id, path: m.path }));
        modules = [...byPath.values()];
        saveModules();
        render();
      } catch (e) {
        // Inline error next to the buttons rather than a blocking alert —
        // consistent with the rest of this app's no-modal-dialogs approach.
        reloadSummaryEl.textContent = 'Import failed: ' + e.message;
        reloadSummaryEl.style.color = '#f85149';
      }
    }, { signal: ac.signal });

    // confirmDanger: small inline confirm, not a blocking window.confirm()
    // (which the rest of this app avoids — modals.js exists for real
    // dialogs, but a lightweight inline yes/no keeps this consistent with
    // the rest of the row-based UI and doesn't block the whole OS thread).
    function confirmDanger(mod) {
      return new Promise((resolve) => {
        const overlay = createEl('div', { style: 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;' });
        const box = createEl('div', { style: 'background:var(--bg-elevated,#1a1c22);border:1px solid var(--border-subtle);border-radius:8px;padding:20px;max-width:360px;font-size:13px;' });
        box.appendChild(createEl('div', { textContent: '⚠️ Reload ' + mod.id + '?', style: 'font-weight:600;margin-bottom:8px;font-size:14px;' }));
        box.appendChild(createEl('div', {
          textContent: 'This module appears to own global state (e.g. window.' + '* singleton) that other running code depends on. Reloading it live can desync or blank open windows. Full page reload is always safe if this goes wrong.',
          style: 'color:var(--text-muted);margin-bottom:14px;line-height:1.4;'
        }));
        const btnRow = createEl('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' });
        const cancelBtn = createEl('button', { textContent: 'Cancel', style: 'padding:6px 12px;background:transparent;color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;' });
        const proceedBtn = createEl('button', { textContent: 'Reload Anyway', style: 'padding:6px 12px;background:#f85149;color:#fff;border:none;border-radius:4px;cursor:pointer;' });
        cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
        proceedBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(proceedBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        content.appendChild(overlay);
      });
    }

    // skipDangerCheck: used by undo's "re-import previous version" path —
    // re-importing code the user already had running isn't a new risk
    // decision, it's reverting one they already made.
    async function reloadOne(mod, btn, { skipDangerCheck = false, codeOverride = null } = {}) {
      btn.disabled = true;
      // No generic :disabled styling exists in style.css (only a
      // browser-nav-btn-specific rule), so the attribute alone wouldn't
      // give any visual feedback that the button is mid-reload — set
      // opacity directly instead.
      btn.style.opacity = '0.6';
      const prevText = btn.textContent;
      const prevBg = btn.style.background;
      btn.textContent = '…';
      try {
        let code;
        if (codeOverride !== null) {
          code = codeOverride;
        } else {
          const url = '/' + mod.path + '?t=' + Date.now();
          const res = await fetch(url);
          if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + mod.path);
          code = await res.text();
        }

        if (!skipDangerCheck && isDangerous(mod, code)) {
          const proceed = await confirmDanger(mod);
          if (!proceed) {
            btn.textContent = prevText;
            btn.style.background = prevBg;
            btn.style.opacity = '';
            btn.disabled = false;
            return { ok: false, cancelled: true };
          }
        }

        const prevEntry = reloadHistory[mod.path];
        const prevCode = codeOverride !== null ? (prevEntry?.prevCode ?? null) : (prevEntry?.newCode ?? null);

        // Real root cause (confirmed via browser console, not guessed):
        // this was never a blob-vs-data URL scheme-support issue. The
        // server's CSP (server/middleware.js, helmet's scriptSrcElem
        // directive) simply never included blob: or data: — even though
        // workerSrc and frameSrc both already allowed blob: for their
        // respective content types, scriptSrcElem was never extended to
        // match. Fixed at the source by adding blob: to scriptSrcElem;
        // reverted here to blob: (no base64/percent-encoding overhead)
        // now that the policy actually permits it.
        const blob = new Blob([code], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        try {
          await import(blobUrl);
        } finally {
          // Safe to revoke right after import() resolves/rejects — by then
          // the module's been fetched and its top-level code has already
          // run (or thrown), so the blob URL has nothing left to serve.
          URL.revokeObjectURL(blobUrl);
        }

        reloadHistory[mod.path] = { prevCode, newCode: code, ts: Date.now() };
        saveHistory();

        // reloadOne re-executes registerApp() for app modules, which
        // updates APP_REGISTRY/OS.apps immediately — but the launchpad and
        // taskbar are memoized views that only rebuild when explicitly
        // asked to (renderLaunchpad diffs a signature string; it won't
        // pick up the change until toggled). Without this, a reloaded
        // app's new name/icon silently doesn't show until the user closes
        // and reopens the launchpad, which looks exactly like "reload had
        // no effect" even though the registry itself updated correctly.
        try {
          if (typeof renderLaunchpad === 'function') renderLaunchpad();
        } catch { /* best-effort refresh, not a reload failure */ }
        try {
          if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
        } catch { /* best-effort refresh, not a reload failure */ }

        btn.textContent = '✓';
        btn.style.background = '#3fb950';
        btn.title = '';
        render(); // refresh row to show/update the diff + undo affordances
        return { ok: true };
      } catch (e) {
        btn.textContent = '✗';
        btn.style.background = '#f85149';
        // Surface the actual error instead of just a red X — hovering
        // shows what broke (bad path, syntax error, import failure, etc),
        // which the original silently discarded.
        btn.title = e.message;
        return { ok: false, error: e.message };
      } finally {
        setTimeout(() => {
          if (btn.textContent === '…') return; // render() may have replaced this row already
          btn.textContent = prevText;
          btn.style.background = prevBg;
          btn.style.opacity = '';
          btn.disabled = false;
        }, 1500);
      }
    }

    // Line-count diff summary — not a real diff algorithm (no LCS/Myers),
    // deliberately: this is a quick "did anything actually change, and
    // roughly how much" indicator for a small UI row, not a code review
    // tool. Counting differing lines by position is O(n) and good enough
    // for that; a real diff view would be a much bigger feature on its own.
    function diffSummary(prevCode, newCode) {
      if (prevCode === null || prevCode === undefined) return null;
      if (prevCode === newCode) return 'No changes';
      const a = prevCode.split('\n');
      const b = newCode.split('\n');
      const max = Math.max(a.length, b.length);
      let changed = 0;
      for (let i = 0; i < max; i++) if (a[i] !== b[i]) changed++;
      const delta = b.length - a.length;
      const deltaStr = delta === 0 ? '' : (delta > 0 ? ' (+' + delta + ' lines)' : ' (' + delta + ' lines)');
      return changed + ' line' + (changed === 1 ? '' : 's') + ' changed' + deltaStr;
    }

    let filterValue = '';

    function render() {
      list.innerHTML = '';
      const q = filterValue.trim().toLowerCase();
      // Filter by real index (not filtered position) so removeBtn's
      // modules.splice(idx, 1) below still targets the correct underlying
      // entry regardless of what's currently hidden by the filter.
      const visible = modules
        .map((mod, idx) => ({ mod, idx }))
        .filter(({ mod }) => !q || mod.id.toLowerCase().includes(q) || mod.path.toLowerCase().includes(q));

      visible.forEach(({ mod, idx }) => {
        const row = createEl('div', { style: 'display:flex;flex-direction:column;padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);gap:6px;' });
        row.dataset.modPath = mod.path;

        const topLine = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });
        const info = createEl('div', { style: 'min-width:0;overflow:hidden;' });
        const idLine = createEl('div', { style: 'font-weight:600;font-size:13px;display:flex;align-items:center;gap:6px;' });
        idLine.appendChild(createEl('span', { textContent: mod.id }));

        // Safety badge — reflects the manual override if set, otherwise
        // the auto-detected guess against whatever content we last saw
        // for this path (falls back to "unknown" until first fetched,
        // since we don't have code to inspect before that).
        const knownCode = reloadHistory[mod.path]?.newCode ?? null;
        const override = safety[mod.path];
        const dangerGuess = override ? override === 'unsafe' : (knownCode !== null ? autoDetectDangerous(knownCode) : null);
        const badge = createEl('span', {
          textContent: dangerGuess === null ? '? unknown' : (dangerGuess ? '⚠ stateful' : '✓ safe'),
          title: override
            ? 'Manually marked ' + override + ' — click to change'
            : (dangerGuess === null ? 'Not yet fetched — reload once to auto-detect' : 'Auto-detected — click to override'),
          style: 'font-size:10px;padding:1px 6px;border-radius:3px;cursor:pointer;user-select:none;' +
            (dangerGuess === null ? 'background:var(--bg-default);color:var(--text-muted);' :
             dangerGuess ? 'background:rgba(248,81,73,0.15);color:#f85149;' : 'background:rgba(63,185,80,0.15);color:#3fb950;')
        });
        badge.addEventListener('click', () => {
          // Cycle: auto -> forced-safe -> forced-unsafe -> auto
          if (!override) safety[mod.path] = 'safe';
          else if (override === 'safe') safety[mod.path] = 'unsafe';
          else delete safety[mod.path];
          saveSafety();
          render();
        }, { signal: ac.signal });
        idLine.appendChild(badge);
        info.appendChild(idLine);
        info.appendChild(createEl('div', { textContent: mod.path, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }));
        topLine.appendChild(info);

        const btns = createEl('div', { style: 'display:flex;gap:6px;flex-shrink:0;' });
        const btn = createEl('button', { textContent: 'Reload', style: 'padding:4px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;' });
        btn.dataset.role = 'reload';
        btn.addEventListener('click', () => reloadOne(mod, btn), { signal: ac.signal });
        btns.appendChild(btn);

        const removeBtn = createEl('button', { textContent: '✕', title: 'Remove from list', style: 'padding:4px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;' });
        removeBtn.addEventListener('click', () => {
          modules.splice(idx, 1);
          saveModules();
          render();
        }, { signal: ac.signal });
        btns.appendChild(removeBtn);

        topLine.appendChild(btns);
        row.appendChild(topLine);

        // Diff + undo row — only shown once we have a reload on record
        // for this path.
        const hist = reloadHistory[mod.path];
        if (hist) {
          const metaLine = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:var(--text-muted);' });
          const summary = diffSummary(hist.prevCode, hist.newCode);
          metaLine.appendChild(createEl('span', { textContent: summary ? summary + ' · last reload ' + new Date(hist.ts).toLocaleTimeString() : 'Reloaded ' + new Date(hist.ts).toLocaleTimeString() }));

          if (hist.prevCode !== null && hist.prevCode !== undefined && hist.prevCode !== hist.newCode) {
            const undoRow = createEl('div', { style: 'display:flex;gap:6px;' });
            const undoBtn = createEl('button', {
              textContent: '↺ Undo (re-import previous)',
              title: 'Re-import the previously loaded version of this module. Does not touch the file on disk.',
              style: 'padding:2px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:10px;'
            });
            undoBtn.addEventListener('click', () => {
              reloadOne(mod, btn, { skipDangerCheck: true, codeOverride: hist.prevCode });
            }, { signal: ac.signal });
            undoRow.appendChild(undoBtn);

            const fullReloadBtn = createEl('button', {
              textContent: '↻ Full page reload',
              title: 'Reload the whole app from scratch. Slower but always correct — use if the module\'s in-memory state is desynced and re-importing old code alone won\'t fix it.',
              style: 'padding:2px 8px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:10px;'
            });
            fullReloadBtn.addEventListener('click', () => location.reload(), { signal: ac.signal });
            undoRow.appendChild(fullReloadBtn);

            metaLine.appendChild(undoRow);
          }
          row.appendChild(metaLine);
        }

        list.appendChild(row);
      });

      if (!visible.length) {
        list.appendChild(createEl('div', { textContent: modules.length ? 'No modules match filter' : 'No modules in list. Add one below.', style: 'color:var(--text-muted);padding:8px;' }));
      }
    }

    filterInput.addEventListener('input', () => {
      filterValue = filterInput.value;
      render();
    }, { signal: ac.signal });

    addBtn.addEventListener('click', () => {
      const id = idInput.value.trim();
      const path = pathInput.value.trim();
      if (!id || !path) return;
      modules.push({ id, path });
      saveModules();
      idInput.value = '';
      pathInput.value = '';
      render();
    }, { signal: ac.signal });

    pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) addBtn.click();
    }, { signal: ac.signal });

    reloadAllBtn.addEventListener('click', async () => {
      reloadAllBtn.disabled = true;
      const origText = reloadAllBtn.textContent;
      reloadAllBtn.textContent = 'Reloading…';

      // Operates on currently visible (filtered) modules only — if the
      // list is filtered down, "Reload All" reloading hidden entries too
      // would be a surprising mismatch between what's on screen and what
      // actually happened. Looked up by data-mod-path rather than
      // positional index, since list.children[i] no longer lines up 1:1
      // with modules[i] once a filter can hide arbitrary rows.
      const q = filterValue.trim().toLowerCase();
      const targets = modules.filter(mod => !q || mod.id.toLowerCase().includes(q) || mod.path.toLowerCase().includes(q));

      const results = await Promise.all(targets.map(mod => {
        const row = list.querySelector(`[data-mod-path="${CSS.escape(mod.path)}"]`);
        const btn = row?.querySelector('[data-role="reload"]');
        return btn ? reloadOne(mod, btn) : Promise.resolve({ ok: false, error: 'row not found' });
      }));

      const okCount = results.filter(r => r.ok).length;
      const cancelledCount = results.filter(r => r.cancelled).length;
      const failCount = results.length - okCount - cancelledCount;
      reloadAllBtn.textContent = origText;
      reloadAllBtn.disabled = false;

      // Brief inline summary next to the button rather than a modal —
      // consistent with the rest of this app avoiding blocking dialogs.
      reloadSummaryEl.textContent = `Last run: ${okCount} ok` +
        (cancelledCount ? `, ${cancelledCount} cancelled` : '') +
        (failCount ? `, ${failCount} failed` : '') +
        ` (${results.length} total)`;
      reloadSummaryEl.style.color = failCount ? '#f85149' : (cancelledCount ? '#fbbf24' : '#3fb950');
    }, { signal: ac.signal });

    render();
  }
});