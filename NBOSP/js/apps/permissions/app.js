registerApp({
  id: 'com.nbosp.permissions',
  name: 'Permissions',
  version: '3.0.2',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icHJtLXNoaWVsZCIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNmVlN2I3Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzA1OTY2OSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0icHJtLWZhY2UiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iI2VjZmRmNSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiNhN2YzZDAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9InBybS1iYWRnZSIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjODZlZmFjIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzE2YTM0YSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBzaGFkb3cgLS0+CiAgPGVsbGlwc2UgY3g9IjQ4IiBjeT0iOTAiIHJ4PSIzMCIgcnk9IjYiIGZpbGw9IiMwMDAiIG9wYWNpdHk9IjAuMTgiLz4KCiAgPCEtLSBzaGllbGQgYm9keSAtLT4KICA8cGF0aCBkPSJNNDggMTAgTDc2IDIwIFY0NCBDNzYgNjIgNjQgNzYgNDggODQgQzMyIDc2IDIwIDYyIDIwIDQ0IFYyMCBaIiBmaWxsPSJ1cmwoI3BybS1zaGllbGQpIi8+CiAgPCEtLSBpbm5lciBmYWNlIC0tPgogIDxwYXRoIGQ9Ik00OCAxOCBMNjkgMjYgVjQ0IEM2OSA1OCA2MCA2OSA0OCA3NSBDMzYgNjkgMjcgNTggMjcgNDQgVjI2IFoiIGZpbGw9InVybCgjcHJtLWZhY2UpIi8+CgogIDwhLS0ga2V5aG9sZSAtLT4KICA8Y2lyY2xlIGN4PSI0OCIgY3k9IjQwIiByPSI3IiBmaWxsPSIjMDU5NjY5Ii8+CiAgPHBvbHlnb24gcG9pbnRzPSI0NCw0MiA1Miw0MiA0OS41LDU0IDQ2LjUsNTQiIGZpbGw9IiMwNTk2NjkiLz4KCiAgPCEtLSBjaGVjayBiYWRnZSAtLT4KICA8Y2lyY2xlIGN4PSI2OCIgY3k9IjY2IiByPSIxNCIgZmlsbD0idXJsKCNwcm0tYmFkZ2UpIi8+CiAgPHBvbHlsaW5lIHBvaW50cz0iNjEsNjYgNjYsNzEgNzYsNTgiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2ZmZmZmZiIgc3Ryb2tlLXdpZHRoPSI0IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KCiAgPCEtLSBoaWdobGlnaHQgLS0+CiAgPGVsbGlwc2UgY3g9IjQwIiBjeT0iMjQiIHJ4PSIxMiIgcnk9IjUiIGZpbGw9IiNmZmYiIG9wYWNpdHk9IjAuMzUiIHRyYW5zZm9ybT0icm90YXRlKC0yMCA0MCAyNCkiLz4KPC9zdmc+Cg==',
  description: 'Review, grant, and revoke permissions across registered apps',
  category: 'developer',
  devOnly: true,
  defaultSize: [720, 600],
  minSize: [480, 400],
  init(content, state, options) {
    if (!window.AppDirs?.getAppDataPath('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Permissions.</div>';
      return;
    }

    // grantPermission/revokePermission/resetPermission/getAppPermissions/
    // getConsentLog/getStats/PERMISSION_CATEGORIES are all confirmed
    // present on the exported window.AppPermissionManager object (checked
    // against app-permission-manager.js's own return statement — not
    // guessed from naming convention). RISK_COLORS is defined in that
    // file too but never exported, so this app keeps its own copy rather
    // than reaching into the module's closure.
    const managerAvailable = typeof AppPermissionManager !== 'undefined';
    const RISK_COLORS = { low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149' };

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:hidden;font-size:13px;';

    const ac = new AbortController();
    state.cleanups.push(() => ac.abort());

    // ── View state ───────────────────────────────────────────────────────
    // 'list' = all apps with granted/denied/pending counts (the original
    // view). 'detail' = one app's permissions, one row per permission with
    // grant/revoke/reset actions. 'log' = the consent log, newest first.
    let view = 'list';
    let detailAppId = null;
    let listSearch = '';
    let logSearch = '';

    // AppPermissionManager has no clearConsentLog/exportConsentLog — the
    // manager module doesn't expose one (confirmed against its return
    // statement, only getConsentLog exists). "Clear" therefore can't
    // delete server-side history; it's a client-side cutoff timestamp
    // that hides everything before it. Persisted so it survives closing
    // and reopening the app, same storage pattern as modules.js.
    const LOG_CUTOFF_KEY = 'nbosp_permissions_log_cutoff';
    const LOG_CUTOFF_REG_PATH = 'HKND/com.nbosp.permissions/logCutoff'; // live path; the LS key is the seed + fallback
    function permsReg() {
      return (typeof window !== 'undefined' && window.NovaRegistry && typeof window.NovaRegistry.get === 'function')
        ? window.NovaRegistry : null;
    }
    let logCutoff = 0;
    try {
      const r = permsReg();
      let stored = null;
      if (r) { try { stored = r.get(LOG_CUTOFF_REG_PATH); } catch { stored = null; } }
      if (stored === null || stored === undefined) stored = Number(localStorage.getItem(LOG_CUTOFF_KEY)) || 0;
      logCutoff = Number(stored) || 0;
    } catch { /* best-effort */ }
    function saveLogCutoff() {
      try {
        const r = permsReg();
        if (r) {
          try { r.set(LOG_CUTOFF_REG_PATH, logCutoff, { type: 'REG_QWORD', source: 'permissions-app' }); return; }
          catch { /* fall through to legacy */ }
        }
        if (typeof lsSave === 'function') lsSave(LOG_CUTOFF_KEY, logCutoff);
        else localStorage.setItem(LOG_CUTOFF_KEY, String(logCutoff));
      } catch { /* best-effort, same degrade-silently pattern as elsewhere */ }
    }

    const tabBar = createEl('div', { style: 'display:flex;border-bottom:1px solid var(--border-subtle);background:var(--bg-elevated);flex-shrink:0;' });
    const listTabBtn = createEl('button', { textContent: 'Apps', style: 'padding:8px 16px;background:transparent;border:none;color:var(--accent);cursor:pointer;font-size:13px;border-bottom:2px solid var(--accent);' });
    const logTabBtn = createEl('button', { textContent: 'Consent Log', style: 'padding:8px 16px;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;' });
    listTabBtn.addEventListener('click', () => { view = 'list'; detailAppId = null; syncTabs(); render(); }, { signal: ac.signal });
    logTabBtn.addEventListener('click', () => { view = 'log'; syncTabs(); render(); }, { signal: ac.signal });
    tabBar.appendChild(listTabBtn);
    tabBar.appendChild(logTabBtn);
    content.appendChild(tabBar);

    function syncTabs() {
      const active = view === 'log' ? logTabBtn : listTabBtn;
      [listTabBtn, logTabBtn].forEach(b => {
        b.style.color = b === active ? 'var(--accent)' : 'var(--text-muted)';
        b.style.borderBottomColor = b === active ? 'var(--accent)' : 'transparent';
      });
    }

    const scroll = createEl('div', { style: 'flex:1;overflow:auto;padding:16px;' });
    content.appendChild(scroll);

    function riskBadge(permission) {
      const cat = managerAvailable ? AppPermissionManager.PERMISSION_CATEGORIES[permission] : null;
      const risk = cat?.risk ?? 'low';
      const label = cat?.label ?? permission;
      return { risk, label, color: RISK_COLORS[risk] || RISK_COLORS.low };
    }

    // window.AppPermissionsMap (from app-permissions-bootstrap.js) is the
    // real source of permissions for the 14 built-in apps that never
    // declare a `permissions` array on their own registerApp() call —
    // Clock, Calculator, Browser, Calendar, Contacts, etc. That map is
    // keyed by each app's *internal* id (confirmed against each app file:
    // Settings -> 'com.nbosp.settings', TextEdit -> 'textedit', Terminal -> 'terminal',
    // Files -> 'files', not the display name), split into `normal`
    // (auto-granted, never prompts) and `dangerous` (prompts via
    // requestAll, user-revocable) tiers.
    //
    // A handful of dev-tier apps (sysaccess, perf) declare their own
    // `permissions` array AND have a bootstrap-map entry. perf's two
    // sources agree exactly; sysaccess's don't (its own declared list is
    // missing 'fs:access', which the bootstrap map's dangerous tier
    // includes and the wrapper actually enforces on launch) — so rather
    // than silently pick one source, this unions both and tags entries
    // that came only from the declared array as tier 'declared' so a
    // mismatch like that stays visible instead of getting papered over.
    function getEffectivePermissions(app) {
      const declared = new Set(app.permissions || []);
      const bootstrap = window.AppPermissionsMap?.[app.id];
      const normal = new Set(bootstrap?.normal || []);
      const dangerous = new Set(bootstrap?.dangerous || []);

      const all = new Set([...declared, ...normal, ...dangerous]);
      return [...all].map(permission => ({
        permission,
        tier: dangerous.has(permission) ? 'dangerous' : normal.has(permission) ? 'normal' : 'declared',
      }));
    }

    function renderList() {
      scroll.innerHTML = '';
      const allApps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];

      if (!allApps.length) {
        scroll.appendChild(createEl('div', { textContent: 'No apps registered', style: 'color:var(--text-muted);' }));
        return;
      }

      const searchInput = createEl('input', {
        placeholder: 'Filter by app name or id…',
        value: listSearch,
        style: 'width:100%;padding:6px 10px;margin-bottom:12px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:12px;box-sizing:border-box;'
      });
      // Re-render on every keystroke is fine here — apps list is small
      // (tens, not thousands) and renderList() rebuilds a lightweight
      // table, not a heavy DOM tree. Cursor position is lost on
      // innerHTML reset like the rest of this app's re-render pattern
      // (same tradeoff modules.js and console.js already make).
      searchInput.addEventListener('input', () => { listSearch = searchInput.value; render(); }, { signal: ac.signal });
      scroll.appendChild(searchInput);

      const q = listSearch.trim().toLowerCase();
      const apps = q ? allApps.filter(a => (a.name || '').toLowerCase().includes(q) || a.id.toLowerCase().includes(q)) : allApps;

      if (!managerAvailable) {
        scroll.appendChild(createEl('div', { textContent: 'AppPermissionManager unavailable — showing app list only.', style: 'color:#d29922;margin-bottom:12px;font-size:12px;' }));
      }

      if (q && !apps.length) {
        scroll.appendChild(createEl('div', { textContent: 'No apps match "' + listSearch + '"', style: 'color:var(--text-muted);' }));
        return;
      }

      const table = createEl('table', { style: 'width:100%;border-collapse:collapse;font-size:12px;' });
      table.appendChild(createEl('thead', {},
        [createEl('tr', {}, [
          createEl('th', { textContent: 'App', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Granted', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Denied', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: 'Pending', style: 'text-align:left;padding:6px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted);font-weight:600;' }),
          createEl('th', { textContent: '', style: 'padding:6px;border-bottom:1px solid var(--border-subtle);' }),
        ])]
      ));

      const tbody = createEl('tbody');
      apps.forEach(app => {
        const perms = getEffectivePermissions(app).map(p => p.permission);
        const granted = managerAvailable ? perms.filter(p => AppPermissionManager.isGranted(p, app.id)).length : 0;
        const denied = managerAvailable ? perms.filter(p => AppPermissionManager.isDenied(p, app.id)).length : 0;
        const pending = managerAvailable ? (perms.length - granted - denied) : 0;
        const unknown = managerAvailable ? 0 : perms.length;

        const row = createEl('tr', { style: 'border-bottom:1px solid var(--border-subtle);cursor:pointer;' });
        row.addEventListener('click', () => {
          view = 'detail';
          detailAppId = app.id;
          render();
        }, { signal: ac.signal });
        row.appendChild(createEl('td', { textContent: app.name || app.id, style: 'padding:6px;' }));
        row.appendChild(createEl('td', { textContent: String(granted), style: 'padding:6px;color:#3fb950;' }));
        row.appendChild(createEl('td', { textContent: String(denied), style: 'padding:6px;color:#f85149;' }));
        row.appendChild(createEl('td', { textContent: unknown ? '—' : String(pending), style: 'padding:6px;color:#d29922;', title: unknown ? 'AppPermissionManager unavailable' : '' }));

        const actionsCell = createEl('td', { style: 'padding:6px;text-align:right;white-space:nowrap;' });
        if (managerAvailable && granted > 0) {
          const revokeAllBtn = createEl('button', {
            textContent: 'Revoke all',
            title: 'Revoke every granted permission for ' + (app.name || app.id),
            style: 'padding:2px 8px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:10px;margin-right:6px;'
          });
          revokeAllBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also trigger the row's drill-into-detail click
            AppPermissionManager.revokeAllPermissions(app.id);
            render();
          }, { signal: ac.signal });
          actionsCell.appendChild(revokeAllBtn);
        }
        actionsCell.appendChild(createEl('span', { textContent: '›', style: 'color:var(--text-muted);' }));
        row.appendChild(actionsCell);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      scroll.appendChild(table);

      // Permission type reference — unchanged from before, still useful as
      // a glossary, now sourced from the same PERMISSION_CATEGORIES used
      // for risk badges above instead of the flat PERMISSION_TYPES map, so
      // it shows risk/category context instead of just the raw string.
      const ref = createEl('div', { style: 'margin-top:20px;' });
      ref.appendChild(createEl('h4', { textContent: 'Permission Types', style: 'margin:0 0 8px;font-size:13px;color:var(--accent);' }));
      const cats = managerAvailable ? AppPermissionManager.PERMISSION_CATEGORIES : {};
      const list = createEl('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:4px;font-size:11px;font-family:monospace;' });
      for (const [key, val] of Object.entries(cats)) {
        const row = createEl('div', { style: `padding:4px 6px;background:var(--bg-elevated);border-radius:4px;border-left:3px solid ${RISK_COLORS[val.risk] || RISK_COLORS.low};` });
        row.appendChild(createEl('div', { textContent: key, style: 'color:var(--text-primary);' }));
        row.appendChild(createEl('div', { textContent: `${val.label} · ${val.risk}`, style: 'color:var(--text-muted);font-size:10px;' }));
        list.appendChild(row);
      }
      ref.appendChild(list);
      scroll.appendChild(ref);
    }

    function renderDetail() {
      scroll.innerHTML = '';
      const apps = Array.isArray(window.APP_REGISTRY) ? window.APP_REGISTRY : [];
      const app = apps.find(a => a.id === detailAppId);
      if (!app) {
        view = 'list';
        renderList();
        return;
      }

      const back = createEl('button', { textContent: '‹ All apps', style: 'padding:4px 10px;background:transparent;color:var(--accent);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:12px;margin-bottom:12px;' });
      back.addEventListener('click', () => { view = 'list'; detailAppId = null; render(); }, { signal: ac.signal });
      scroll.appendChild(back);

      scroll.appendChild(createEl('h3', { textContent: app.name || app.id, style: 'margin:0 0 4px;font-size:15px;' }));
      scroll.appendChild(createEl('div', { textContent: app.id, style: 'font-size:11px;color:var(--text-muted);font-family:monospace;margin-bottom:16px;' }));

      const effectivePerms = getEffectivePermissions(app);
      // getAppPermissions(appId) returns only grants that have a recorded
      // state (granted or denied) — a permission the app declares but that
      // was never granted/denied yet won't have an entry, so it's looked
      // up separately here rather than assumed present for every declared
      // permission.
      const grantMap = managerAvailable
        ? new Map(AppPermissionManager.getAppPermissions(app.id).map(g => [g.permission, g]))
        : new Map();

      if (!effectivePerms.length) {
        scroll.appendChild(createEl('div', { textContent: 'This app declares no permissions and has no bootstrap-map entry.', style: 'color:var(--text-muted);' }));
        return;
      }

      if (!managerAvailable) {
        scroll.appendChild(createEl('div', { textContent: 'AppPermissionManager unavailable — grant/revoke disabled.', style: 'color:#d29922;font-size:12px;' }));
      } else {
        // Bulk actions scoped to this one app, backed by real manager
        // calls — grantPermission looped per-pending permission (no bulk
        // grant exists on the manager) and revokeAllPermissions(appId)
        // (which does exist, confirmed in the manager's return statement).
        // Not offering a cross-app bulk button: the manager has no
        // "revoke this permission everywhere" call, and faking one by
        // looping every app client-side would be a much bigger, riskier
        // action to hide behind an innocuous-looking button.
        const pendingPerms = effectivePerms.filter(({ permission }) => {
          const g = grantMap.get(permission);
          return !g; // no recorded grant/deny state = pending
        });
        const grantedCount = effectivePerms.filter(({ permission }) => grantMap.get(permission)?.granted).length;

        if (pendingPerms.length || grantedCount) {
          const bulkBar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
          if (pendingPerms.length) {
            const grantAllBtn = createEl('button', {
              textContent: 'Grant all pending (' + pendingPerms.length + ')',
              style: 'padding:4px 12px;background:#3fb950;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;'
            });
            grantAllBtn.addEventListener('click', async () => {
              grantAllBtn.disabled = true;
              for (const { permission } of pendingPerms) {
                await AppPermissionManager.grantPermission(permission, app.id, { reason: 'Bulk-granted via Permissions dev tool' });
              }
              render();
            }, { signal: ac.signal });
            bulkBar.appendChild(grantAllBtn);
          }
          if (grantedCount) {
            const revokeAllBtn = createEl('button', {
              textContent: 'Revoke all granted (' + grantedCount + ')',
              style: 'padding:4px 12px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:11px;'
            });
            revokeAllBtn.addEventListener('click', () => {
              AppPermissionManager.revokeAllPermissions(app.id);
              render();
            }, { signal: ac.signal });
            bulkBar.appendChild(revokeAllBtn);
          }
          scroll.appendChild(bulkBar);
        }
      }

      effectivePerms.forEach(({ permission, tier }) => {
        const grant = grantMap.get(permission);
        const status = grant ? (grant.granted ? 'granted' : 'denied') : 'pending';
        const statusColor = status === 'granted' ? '#3fb950' : status === 'denied' ? '#f85149' : '#d29922';
        const { risk, label, color } = riskBadge(permission);

        const row = createEl('div', { style: `padding:10px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);border-left:3px solid ${color};margin-bottom:8px;` });

        const header = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' });
        const left = createEl('div', {});
        left.appendChild(createEl('div', { textContent: permission, style: 'font-family:monospace;font-size:12px;font-weight:600;' }));
        left.appendChild(createEl('div', { textContent: `${label} · risk: ${risk} · tier: ${tier}`, style: 'font-size:11px;color:var(--text-muted);' }));
        header.appendChild(left);
        header.appendChild(createEl('span', { textContent: status, style: `font-size:11px;color:${statusColor};border:1px solid ${statusColor};border-radius:3px;padding:1px 6px;flex-shrink:0;text-transform:uppercase;` }));
        row.appendChild(header);

        if (managerAvailable) {
          const actions = createEl('div', { style: 'display:flex;gap:6px;margin-top:8px;' });

          // grantPermission() persists a grant with no user-facing dialog
          // (confirmed: it calls _persistGrant directly, not the
          // _showPermissionDialog path requestPermission() uses). That's
          // appropriate for a devOnly tool but is a real bypass of the
          // normal consent flow, so the button says so rather than reading
          // like an ordinary toggle.
          if (status !== 'granted') {
            const grantBtn = createEl('button', { textContent: 'Grant (no prompt)', style: 'padding:3px 10px;background:#3fb950;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px;' });
            grantBtn.addEventListener('click', async () => {
              grantBtn.disabled = true;
              await AppPermissionManager.grantPermission(permission, app.id, { reason: 'Granted via Permissions dev tool' });
              renderDetail();
            }, { signal: ac.signal });
            actions.appendChild(grantBtn);
          }

          if (status !== 'pending') {
            const resetBtn = createEl('button', { textContent: 'Reset to pending', style: 'padding:3px 10px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;' });
            resetBtn.addEventListener('click', () => {
              AppPermissionManager.resetPermission(permission, app.id);
              renderDetail();
            }, { signal: ac.signal });
            actions.appendChild(resetBtn);
          }

          if (status === 'granted') {
            const revokeBtn = createEl('button', { textContent: 'Revoke', style: 'padding:3px 10px;background:transparent;color:#f85149;border:1px solid #f85149;border-radius:4px;cursor:pointer;font-size:11px;' });
            revokeBtn.addEventListener('click', () => {
              AppPermissionManager.revokePermission(permission, app.id);
              renderDetail();
            }, { signal: ac.signal });
            actions.appendChild(revokeBtn);
          }

          row.appendChild(actions);
        }

        scroll.appendChild(row);
      });
    }

    function renderLog() {
      scroll.innerHTML = '';
      if (!managerAvailable) {
        scroll.appendChild(createEl('div', { textContent: 'AppPermissionManager unavailable.', style: 'color:var(--text-muted);' }));
        return;
      }

      const toolbar = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
      const searchInput = createEl('input', {
        placeholder: 'Filter by app id or permission…',
        value: logSearch,
        style: 'flex:1;padding:6px 10px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:12px;box-sizing:border-box;'
      });
      searchInput.addEventListener('input', () => { logSearch = searchInput.value; render(); }, { signal: ac.signal });
      toolbar.appendChild(searchInput);

      const clearBtn = createEl('button', {
        textContent: 'Clear view',
        title: 'Hides entries older than now. The underlying log itself is not cleared — AppPermissionManager has no delete API — so entries reappear if you clear this cutoff or the manager is reset elsewhere.',
        style: 'padding:6px 12px;background:transparent;color:var(--text-muted);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;'
      });
      clearBtn.addEventListener('click', () => {
        logCutoff = Date.now();
        saveLogCutoff();
        render();
      }, { signal: ac.signal });
      toolbar.appendChild(clearBtn);

      if (logCutoff) {
        const resetBtn = createEl('button', {
          textContent: 'Show all',
          title: 'Remove the clear-view cutoff and show full history again',
          style: 'padding:6px 12px;background:transparent;color:var(--accent);border:1px solid var(--border-subtle);border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;'
        });
        resetBtn.addEventListener('click', () => {
          logCutoff = 0;
          saveLogCutoff();
          render();
        }, { signal: ac.signal });
        toolbar.appendChild(resetBtn);
      }
      scroll.appendChild(toolbar);

      // getConsentLog() appends chronologically (oldest pushed last in
      // time), so reverse a copy for a newest-first display without
      // mutating the manager's internal array.
      let entries = AppPermissionManager.getConsentLog().slice().reverse();
      if (logCutoff) entries = entries.filter(e => (e.timestamp || 0) >= logCutoff);

      const q = logSearch.trim().toLowerCase();
      if (q) entries = entries.filter(e => (e.appId || '').toLowerCase().includes(q) || (e.permission || '').toLowerCase().includes(q));

      if (!entries.length) {
        scroll.appendChild(createEl('div', { textContent: q ? 'No log entries match "' + logSearch + '"' : 'No consent events recorded yet.', style: 'color:var(--text-muted);' }));
        return;
      }
      entries.forEach(e => {
        const color = e.granted ? '#3fb950' : '#f85149';
        const row = createEl('div', { style: `padding:8px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);border-left:3px solid ${color};margin-bottom:6px;font-size:11px;` });
        row.appendChild(createEl('div', { textContent: `${e.granted ? 'GRANT' : 'DENY'} · ${e.permission} → ${e.appId}`, style: `font-family:monospace;color:${color};font-weight:600;` }));
        row.appendChild(createEl('div', { textContent: e.timestamp ? new Date(e.timestamp).toLocaleString() : '', style: 'color:var(--text-muted);margin-top:2px;' }));
        if (e.reason) row.appendChild(createEl('div', { textContent: `reason: ${e.reason}`, style: 'color:var(--text-muted);margin-top:2px;' }));
        scroll.appendChild(row);
      });
    }

    function render() {
      if (view === 'detail') renderDetail();
      else if (view === 'log') renderLog();
      else renderList();
    }

    // The 5s poll exists so externally-changed permission state (granted
    // elsewhere while this window is open) shows up without manual
    // refresh — but blindly calling render() while a search box has
    // focus rebuilds the input via innerHTML and drops both the value
    // binding and cursor position mid-keystroke. document.activeElement
    // check is cheap and avoids that without needing a debounce.
    function pollRender() {
      if (scroll.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
      render();
    }

    const timeoutId = setTimeout(render, 100);
    const intervalId = setInterval(pollRender, 5000);
    state.cleanups.push(() => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    });
  }
});