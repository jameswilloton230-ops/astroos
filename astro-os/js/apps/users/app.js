'use strict';

/**
 * com.astroos.users — the admin console for accounts.
 *
 * First-class console, not another Settings section: launching requires an
 * admin-role session. It runs in the trusted host (unrestrictedEntry) and
 * calls the /api/auth/admin routes through SessionManager.authFetch; the
 * server re-checks the role on every route. Standard users who launch it get
 * a role-denied splash rather than a silent failure.
 *
 * Three tabs:
 *   Users    — every account: avatar, display name, username, role chip
 *              (Standard/Admin/Owner), status chip (active/disabled/locked),
 *              last login, storage-usage bar against quota; row actions:
 *              edit, credential reset, disable/enable, force logout, delete
 *              with its archive-or-wipe dialog and the last-admin guard.
 *   Policies — the machine account settings: guest access, picker
 *              usernames, lockout ladder, per-account quotas, session
 *              limits, idle-lock maximum, close-apps-on-switch.
 *   Audit    — the persistent per-user event feed with severity coloring,
 *              per-user filtering and CSV export.
 */

registerApp({
  id: 'com.astroos.users',
  name: 'Users',
  version: '3.0.2',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij48Y2lyY2xlIGN4PSIzMiIgY3k9IjM4IiByPSIxMCIgZmlsbD0iIzkzYzVmZCIvPjxwYXRoIGQ9Ik0yIDc0IHYtMSBjMC05IDEzLTE0IDMwLTE0czMwIDUgMzAgMTR2MSB6IiBmaWxsPSIjOTNjNWZkIi8+PGNpcmNsZSBjeD0iNjQiIGN5PSIzMiIgcj0iMTIiIGZpbGw9IiMyNTYzZWIiLz48cGF0aCBkPSJNNDAgNzQgdi0yIGMwLTExIDEwLTIgMjQtMTIgMjQgMTJ2MSB6IiBmaWxsPSIjMjU2M2ViIi8+PHBhdGggZD0iTTY4IDQ2IDIwIDcyIGw2IDcgMjQtMTAgMTAgOSA0LTcgMjQgMjQtMTQgMy0yMCA5LTItNCA1IDcgNC01LTkgMSA0IDctNS0zIDcgMTAgMy0yMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmRlNjhhIiBzdHJva2Utd2lkdGg9IjIuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PGNpcmNsZSBjeD0iNzAiIGN5PSI0NCIgcj0iNSIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==',
  description: 'Admin console for accounts: create, edit, reset, disable, delete, machine policies and the per-user audit feed.',
  category: 'admin',
  permissions: [],
  defaultSize: [880, 640],
  minSize: [560, 420],
  resizable: true,

  async init(content, state, options) {
    const ac = new AbortController();
    state.cleanups?.push(() => ac.abort());
    const { signal } = ac;

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-ui,sans-serif);overflow:hidden;';

    const css = document.createElement('style');
    css.textContent = `
      .nbusers-root { display:flex;flex-direction:column;height:100%;overflow:hidden; }
      .nbusers-tabs { display:flex;border-bottom:1px solid var(--border-subtle);background:var(--bg-elevated);flex-shrink:0; }
      .nbusers-tab { padding:9px 18px;background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:13px;border-bottom:2px solid transparent; }
      .nbusers-tab.active { color:var(--accent);border-bottom-color:var(--accent);background:var(--bg-hover); }
      .nbusers-body { flex:1;overflow:auto;padding:18px; }
      .nbusers-toolbar { display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap; }
      .nbusers-btn { padding:8px 14px;border-radius:9px;border:1px solid var(--border-default);background:var(--bg-elevated);color:var(--text-primary);font-size:12px;cursor:pointer; }
      .nbusers-btn.primary { border-color:var(--accent);background:var(--accent-muted);color:var(--accent);font-weight:600; }
      .nbusers-btn.danger { border-color:var(--text-danger);color:var(--text-danger); }
      .nbusers-btn.ghost { background:transparent;color:var(--text-muted); }
      .nbusers-add-btn { display:inline-flex;align-items:center;gap:6px; }
      .nbusers-table { width:100%;border-collapse:collapse;font-size:13px; }
      .nbusers-table th { text-align:left;color:var(--text-muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:8px 10px;border-bottom:1px solid var(--border-subtle); }
      .nbusers-table td { padding:9px 10px;border-bottom:1px solid var(--border-subtle);vertical-align:middle; }
      .nbusers-account-info { display:flex;align-items:center;gap:10px; }
      .nbusers-avatar { width:34px;height:34px;border-radius:50%;background:var(--accent-muted);color:var(--accent);display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:600; }
      .nbusers-chip { display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--border-default);color:var(--text-muted);margin-right:4px; }
      .nbusers-chip.owner, .nbusers-chip.admin { color:var(--accent);border-color:var(--accent); }
      .nbusers-chip.disabled, .nbusers-chip.locked { color:var(--text-danger);border-color:var(--text-danger); }
      .nbusers-quota { width:120px;height:6px;border-radius:4px;background:var(--bg-overlay);overflow:hidden; }
      .nbusers-quota > div { height:100%;background:var(--accent); }
      .nbusers-quota.over > div { background:var(--text-danger); }
      .nbusers-rowactions { display:flex;gap:6px;flex-wrap:wrap; }
      .nbusers-empty { text-align:center;color:var(--text-muted);padding:48px 12px;font-size:13px; }
      .nbusers-form { display:flex;flex-direction:column;gap:10px;max-width:460px; }
      .nbusers-form label { font-size:11px;color:var(--text-muted); }
      .nbusers-form input, .nbusers-form select { padding:9px 12px;border-radius:9px;border:1px solid var(--border-default);background:var(--bg-overlay);color:var(--text-primary);font-size:13px;outline:none; }
      .nbusers-event { padding:8px 10px;border-left:3px solid var(--border-default);margin-bottom:6px;background:var(--bg-overlay);border-radius:6px;font-size:12px; }
      .nbusers-event.info { border-left-color:var(--accent); }
      .nbusers-event.warn { border-left-color:var(--text-warning); }
      .nbusers-event.error { border-left-color:var(--text-danger); }
      .nbusers-status { min-height:18px;font-size:12px;color:var(--text-danger);margin-top:10px; }
      .nbusers-ok { color:var(--text-muted); }
    `;
    content.appendChild(css);

    const root = createEl('div', { className: 'nbusers-root' });
    content.appendChild(root);

    // ── Admin API transport ───────────────────────────────────────────────
    // System apps run in the trusted host, so this talks to the role-gated
    // /api/auth/admin family through SessionManager.authFetch (bearer + CSRF).
    // The server re-checks the session role on every route.
    const uidPath = (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}`;
    const ROUTES = {
      'accounts.list':            { method: 'GET',    path: () => '/api/auth/admin/users' },
      'accounts.create':          { method: 'POST',   path: () => '/api/auth/admin/users', body: (p) => p.account },
      'accounts.update':          { method: 'PATCH',  path: uidPath, body: (p) => p.patch },
      'accounts.disable':         { method: 'POST',   path: (p) => `${uidPath(p)}/disable` },
      'accounts.enable':          { method: 'POST',   path: (p) => `${uidPath(p)}/enable` },
      'accounts.lock':            { method: 'POST',   path: (p) => `${uidPath(p)}/lock` },
      'accounts.unlock':          { method: 'POST',   path: (p) => `${uidPath(p)}/unlock` },
      'accounts.forceLogout':     { method: 'POST',   path: (p) => `${uidPath(p)}/force-logout` },
      'accounts.resetCredential': { method: 'POST',   path: (p) => `${uidPath(p)}/reset-credential` },
      'accounts.delete':          { method: 'DELETE', path: (p) => `${uidPath(p)}${p.mode === 'wipe' ? '?mode=wipe' : ''}`, body: (p) => (p.mode ? { mode: p.mode } : undefined) },
      'accounts.setPin':          { method: 'POST',   path: (p) => `${uidPath(p)}/credentials/pin`, body: (p) => ({ pin: p.pin }) },
      'accounts.setPassphrase':   { method: 'POST',   path: (p) => `${uidPath(p)}/credentials/passphrase`, body: (p) => ({ passphrase: p.passphrase ?? null }) },
      'accounts.webauthn.list':   { method: 'GET',    path: (p) => `${uidPath(p)}/webauthn` },
      'accounts.webauthn.remove': { method: 'DELETE', path: (p) => `${uidPath(p)}/webauthn/${encodeURIComponent(p.credentialId)}` },
      'policies.get':             { method: 'GET',    path: () => '/api/auth/admin/policies' },
      'policies.set':             { method: 'PUT',    path: () => '/api/auth/admin/policies', body: (p) => p.policies },
      'events.list':              { method: 'GET',    path: (p) => { const q = new URLSearchParams(); for (const k of ['uid', 'severity', 'action', 'limit', 'offset']) if (p?.[k] !== undefined && p?.[k] !== null) q.set(k, String(p[k])); return `/api/auth/admin/events${q.toString() ? '?' + q.toString() : ''}`; } },
      'usage.get':                { method: 'GET',    path: () => '/api/auth/admin/usage' },
    };

    async function adminUsers(action, payload = {}) {
      const sm = window.SessionManager;
      if (!sm || typeof sm.authFetch !== 'function') {
        return { success: false, code: 'UNAVAILABLE', message: 'Session service is not available' };
      }
      if (typeof NovaUserScope === 'undefined' || !NovaUserScope.enabled()) {
        return { success: false, code: 'MULTI_USER_DISABLED', message: 'Multi-user is off. Enable it to manage accounts.' };
      }
      if (!sm.isAdmin()) {
        return { success: false, code: 'PERMISSION_DENIED', message: 'An administrator account is required for account management' };
      }
      if (!Object.prototype.hasOwnProperty.call(ROUTES, action)) {
        return { success: false, code: 'UNAVAILABLE', message: `Unknown action: ${action}` };
      }
      const route = ROUTES[action];
      const args = { ...payload };
      const { status, json, error } = await sm.authFetch(route.path(args), {
        method: route.method,
        body: route.body ? route.body(args) : undefined,
      });
      if (!json || json.success !== true) {
        const code = status === 403 ? 'PERMISSION_DENIED' : (status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE');
        return { success: false, code, message: json?.message || error || `Account management request failed (${status})` };
      }
      return { success: true, data: json.data };
    }

    function isPermissionDenied(result) {
      return result && result.success !== true &&
        (result.code === 'PERMISSION_DENIED' || result.code === 'MULTI_USER_DISABLED' || result.error === 'PERMISSION_DENIED' ||
          /administrator account is required|not in admin mode|admin:users permission/i.test(String(result.message || result.error || '')));
    }

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes; let i = 0;
      while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
      return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
    }

    function fmtDate(ts) {
      if (!ts) return 'never';
      try { return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return String(ts); }
    }

    function avatarText(user) {
      if (typeof user?.avatar === 'string' && user.avatar && user.avatar.length <= 8) return user.avatar;
      return String(user?.displayName || user?.username || '?').trim().charAt(0).toUpperCase();
    }

    // ── Splash when the session is not an admin ────────────────────────────
    function roleDeniedSplash(message) {
      root.innerHTML = '';
      const splash = createEl('div', {
        className: 'nbusers-empty',
        style: 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;',
      });
      splash.appendChild(createEl('div', { style: 'font-size:34px', textContent: '🔒' }));
      splash.appendChild(createEl('div', { style: 'font-size:15px;font-weight:600', textContent: /multi-user is off/i.test(message || '') ? 'Multi-user is off' : 'Administrator account required' }));
      splash.appendChild(createEl('div', { style: 'font-size:12px;max-width:380px;text-align:center', textContent: message || 'The Users console manages accounts machine-wide. Sign in with an Admin or Owner account to use it.' }));
      root.appendChild(splash);
    }

    // ── Shell: tabs ───────────────────────────────────────────────────────
    const tabBar = createEl('div', { className: 'nbusers-tabs' });
    const body = createEl('div', { className: 'nbusers-body' });
    root.appendChild(tabBar);
    root.appendChild(body);

    const TABS = [
      { id: 'users', name: 'Users' },
      { id: 'policies', name: 'Policies' },
      { id: 'audit', name: 'Audit' },
    ];
    let activeTab = 'users';
    const tabButtons = {};

    function selectTab(id) {
      activeTab = id;
      for (const [tid, btn] of Object.entries(tabButtons)) {
        btn.classList.toggle('active', tid === id);
      }
      renderTab();
    }

    for (const tab of TABS) {
      const btn = createEl('button', { className: 'nbusers-tab', textContent: tab.name });
      btn.addEventListener('click', () => selectTab(tab.id), { signal });
      tabButtons[tab.id] = btn;
      tabBar.appendChild(btn);
    }

    // ── Users tab ─────────────────────────────────────────────────────────
    let usersCache = [];
    let usageCache = [];

    async function loadUsers() {
      const result = await adminUsers('accounts.list');
      if (isPermissionDenied(result)) return { denied: true, message: result.message };
      usersCache = result.data?.users || result.users || [];
      const usageResult = await adminUsers('usage.get');
      usageCache = usageResult.data?.usage || usageResult.usage || [];
      return { denied: false };
    }

    function usageFor(uid) {
      return usageCache.find(entry => entry.uid === uid) || null;
    }

    function renderUsers() {
      body.innerHTML = '';
      const toolbar = createEl('div', { className: 'nbusers-toolbar' });
      toolbar.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600', textContent: `Accounts (${usersCache.length})` }));
      const addBtn = createEl('button', { className: 'nbusers-btn primary nbusers-add-btn' });
      addBtn.setAttribute('aria-label', 'Add account');
      const addIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      addIcon.setAttribute('viewBox', '0 0 24 24');
      addIcon.setAttribute('width', '16');
      addIcon.setAttribute('height', '16');
      addIcon.setAttribute('fill', 'none');
      addIcon.setAttribute('stroke', 'currentColor');
      addIcon.setAttribute('stroke-width', '2');
      addIcon.setAttribute('stroke-linecap', 'round');
      addIcon.setAttribute('aria-hidden', 'true');
      const addIconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      addIconPath.setAttribute('d', 'M12 5v14M5 12h14');
      addIcon.appendChild(addIconPath);
      addBtn.appendChild(addIcon);
      addBtn.appendChild(createEl('span', { textContent: 'Add account' }));
      addBtn.addEventListener('click', () => renderAddUser(), { signal });
      toolbar.appendChild(addBtn);
      body.appendChild(toolbar);

      if (!usersCache.length) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: 'No accounts yet — add the first one.' }));
        return;
      }

      const table = createEl('table', { className: 'nbusers-table' });
      const head = createEl('tr');
      for (const label of ['Account', 'Username', 'Role', 'Status', 'Last sign-in', 'Storage', 'Actions']) {
        head.appendChild(createEl('th', { textContent: label }));
      }
      const thead = createEl('thead');
      thead.appendChild(head);
      table.appendChild(thead);
      const tbody = createEl('tbody');

      for (const user of usersCache) {
        const usage = usageFor(user.uid);
        const quota = user.quotaBytes || usage?.quotaBytes || 0;
        const used = usage?.usageBytes || 0;
        const pct = quota ? Math.min(100, Math.round(used / quota * 100)) : 0;

        const row = createEl('tr');

        const cellAccount = createEl('td');
        const accountInfo = createEl('div', { className: 'nbusers-account-info' });
        accountInfo.appendChild(createEl('span', { className: 'nbusers-avatar', textContent: avatarText(user) }));
        const nameWrap = createEl('div');
        nameWrap.appendChild(createEl('div', { style: 'font-weight:600', textContent: user.displayName || user.username }));
        if (user.locked) nameWrap.appendChild(createEl('div', { style: 'font-size:10px;color:var(--text-danger)', textContent: 'locked — needs admin unlock' }));
        accountInfo.appendChild(nameWrap);
        cellAccount.appendChild(accountInfo);
        row.appendChild(cellAccount);

        row.appendChild(createEl('td', { textContent: user.username }));
        row.appendChild(createEl('td', null, [
          createEl('span', { className: `nbusers-chip ${user.role}`, textContent: user.roleLabel || user.role }),
        ]));
        row.appendChild(createEl('td', null, [
          createEl('span', { className: `nbusers-chip ${user.status}`, textContent: user.status }),
          user.locked ? createEl('span', { className: 'nbusers-chip locked', textContent: 'locked' }) : null,
        ]));
        row.appendChild(createEl('td', { textContent: fmtDate(user.lastLoginAt) }));

        const cellQuota = createEl('td');
        const bar = createEl('div', { className: `nbusers-quota${pct >= 90 ? ' over' : ''}` });
        bar.appendChild(createEl('div', { style: `width:${pct}%` }));
        cellQuota.appendChild(bar);
        cellQuota.appendChild(createEl('div', { style: 'font-size:10px;color:var(--text-muted);margin-top:3px', textContent: `${fmtBytes(used)} / ${fmtBytes(quota)}` }));
        row.appendChild(cellQuota);

        const cellActions = createEl('td');
        const actions = createEl('div', { className: 'nbusers-rowactions' });

        const mkBtn = (label, className, handler, title) => {
          const btn = createEl('button', { className: `nbusers-btn ${className || ''}`, textContent: label });
          if (title) btn.title = title;
          btn.addEventListener('click', handler, { signal });
          return btn;
        };

        actions.appendChild(mkBtn('Edit', '', () => renderEditUser(user), 'Display name, role, quota'));
        if (user.role !== 'owner') {
          if (user.status === 'active') {
            actions.appendChild(mkBtn('Disable', '', () => adminAction('accounts.disable', { uid: user.uid }, 'disable'), 'Block sign-in and revoke sessions'));
          } else {
            actions.appendChild(mkBtn('Enable', '', () => adminAction('accounts.enable', { uid: user.uid }, 'enable')));
          }
          if (user.locked) {
            actions.appendChild(mkBtn('Unlock', '', () => adminAction('accounts.unlock', { uid: user.uid }, 'unlock'), 'Clear the brute-force lock'));
          }
        }
        actions.appendChild(mkBtn('Reset PIN', '', () => resetCredential(user), 'Issue a temporary PIN shown once'));
        actions.appendChild(mkBtn('Force out', 'ghost', () => adminAction('accounts.forceLogout', { uid: user.uid }, 'force-logout'), 'Revoke every session of this account'));
        if (user.role !== 'owner') {
          actions.appendChild(mkBtn('Delete', 'danger', () => renderDeleteUser(user), 'Archive or wipe this account'));
        }
        cellActions.appendChild(actions);
        row.appendChild(cellActions);

        tbody.appendChild(row);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    }

    async function adminAction(action, payload, verbLabel) {
      const result = await adminUsers(action, payload);
      if (result?.success) {
        await refresh();
        return true;
      }
      const message = result?.message || result?.error || `${verbLabel} failed`;
      toast(message, true);
      return false;
    }

    let toastTimer = 0;
    function toast(message, isError) {
      let el = root.querySelector('.nbusers-toast');
      if (!el) {
        el = createEl('div', {
          className: 'nbusers-toast',
          style: 'position:sticky;bottom:10px;align-self:center;padding:10px 16px;border-radius:10px;font-size:12px;z-index:5;pointer-events:none;',
        });
        root.appendChild(el);
      }
      el.textContent = message;
      el.style.border = `1px solid ${isError ? 'var(--text-danger)' : 'var(--accent)'}`;
      el.style.color = isError ? 'var(--text-danger)' : 'var(--accent)';
      el.style.background = 'var(--bg-elevated)';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.remove(), 5000);
    }

    // Add-user wizard (Table 9): account → credentials → review.
    function renderAddUser() {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: 'Add account' }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: 'New accounts sign in with the PIN you choose; they can change it from their own lock screen.' }));

      const form = createEl('div', { className: 'nbusers-form' });
      const fields = [
        { id: 'nu-display', label: 'Display name', type: 'text', placeholder: 'Sam Nova' },
        { id: 'nu-username', label: 'Username (3–32 chars, immutable)', type: 'text', placeholder: 'sam' },
        { id: 'nu-role', label: 'Role', type: 'select', options: [['standard', 'Standard — personal data, no machine authority'], ['admin', 'Admin — full system authority']] },
        { id: 'nu-pin', label: 'PIN (4–6 digits)', type: 'password', placeholder: '••••', maxlength: '6' },
        { id: 'nu-pass', label: 'Passphrase (optional, 8+ chars)', type: 'password', placeholder: 'recommended for admins' },
        { id: 'nu-quota', label: 'Storage quota (GB, default 2)', type: 'number', placeholder: '2', min: '1', max: '32', step: '0.5' },
      ];
      const inputs = {};
      for (const f of fields) {
        form.appendChild(createEl('label', { htmlFor: f.id, textContent: f.label }));
        let input;
        if (f.type === 'select') {
          input = createEl('select');
          for (const [value, label] of f.options) {
            input.appendChild(createEl('option', { value, textContent: label }));
          }
        } else {
          input = createEl('input', { id: f.id, type: f.type, placeholder: f.placeholder || '' });
          if (f.maxlength) input.setAttribute('maxlength', f.maxlength);
          if (f.min) input.setAttribute('min', f.min);
          if (f.max) input.setAttribute('max', f.max);
          if (f.step) input.setAttribute('step', f.step);
        }
        input.style.width = '100%';
        form.appendChild(input);
        inputs[f.id] = input;
      }
      body.appendChild(form);

      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);

      const row = createEl('div', { style: 'display:flex;gap:10px;margin-top:6px' });
      const cancel = createEl('button', { className: 'nbusers-btn ghost', textContent: 'Cancel' });
      cancel.addEventListener('click', () => { selectTab('users'); }, { signal });
      const create = createEl('button', { className: 'nbusers-btn primary', textContent: 'Create account' });
      create.addEventListener('click', async () => {
        const displayName = inputs['nu-display'].value.trim();
        const username = inputs['nu-username'].value.trim().toLowerCase();
        const role = inputs['nu-role'].value;
        const pin = inputs['nu-pin'].value;
        const passphrase = inputs['nu-pass'].value;
        const quotaGB = parseFloat(inputs['nu-quota'].value);
        if (!displayName) { status.textContent = 'Enter a display name.'; return; }
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) { status.textContent = 'Username: 3–32 chars — letters, digits, dots, dashes, underscores.'; return; }
        if (!/^\d{4,6}$/.test(pin)) { status.textContent = 'PIN must be 4–6 digits.'; return; }
        if (passphrase && passphrase.length < 8) { status.textContent = 'Passphrase must be 8+ characters (or empty).'; return; }
        status.textContent = 'Creating…';
        const account = { displayName, username, role, pin };
        if (passphrase) account.passphrase = passphrase;
        if (Number.isFinite(quotaGB) && quotaGB > 0) account.quotaBytes = Math.round(quotaGB * 1024 * 1024 * 1024);
        const result = await adminUsers('accounts.create', { account });
        if (result?.success) {
          status.textContent = '';
          await refresh();
          selectTab('users');
          toast(`Account ${username} created`);
        } else {
          status.textContent = result?.message || result?.error || 'Creation failed';
        }
      }, { signal });
      row.appendChild(cancel);
      row.appendChild(create);
      body.appendChild(row);
    }

    function renderEditUser(user) {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: `Edit — ${user.displayName || user.username}` }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: 'The username never changes; the display name, role and quota are editable by an admin.' }));

      const form = createEl('div', { className: 'nbusers-form' });
      const displayNameInput = createEl('input', { type: 'text', value: user.displayName || '' });
      const roleSelect = createEl('select');
      roleSelect.appendChild(createEl('option', { value: 'standard', textContent: 'Standard — personal data, no machine authority' }));
      roleSelect.appendChild(createEl('option', { value: 'admin', textContent: 'Admin — full system authority' }));
      roleSelect.value = user.role === 'admin' ? 'admin' : 'standard';
      if (user.role === 'owner') {
        roleSelect.value = 'admin';
        roleSelect.disabled = true;
      }
      const quotaInput = createEl('input', { type: 'number', min: '1', max: '32', step: '0.5', value: (user.quotaBytes ? +(user.quotaBytes / (1024 ** 3)).toFixed(1) : 2) });
      quotaInput.style.width = '100%';
      displayNameInput.style.width = '100%';

      form.appendChild(createEl('label', { textContent: 'Display name' }));
      form.appendChild(displayNameInput);
      form.appendChild(createEl('label', { textContent: 'Role' }));
      form.appendChild(roleSelect);
      if (user.role !== 'owner') { /* role editing allowed */ }
      form.appendChild(createEl('label', { textContent: 'Storage quota (GB)' }));
      form.appendChild(quotaInput);
      body.appendChild(form);

      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);

      const row = createEl('div', { style: 'display:flex;gap:10px;margin-top:6px' });
      const back = createEl('button', { className: 'nbusers-btn ghost', textContent: 'Back' });
      back.addEventListener('click', () => selectTab('users'), { signal });
      const save = createEl('button', { className: 'nbusers-btn primary', textContent: 'Save' });
      save.addEventListener('click', async () => {
        const patch = { displayName: displayNameInput.value.trim() || user.username };
        if (user.role !== 'owner') patch.role = roleSelect.value;
        const gb = parseFloat(quotaInput.value);
        if (Number.isFinite(gb) && gb > 0) patch.quotaBytes = Math.round(gb * 1024 * 1024 * 1024);
        const result = await adminUsers('accounts.update', { uid: user.uid, patch });
        if (result?.success) {
          await refresh();
          selectTab('users');
          toast('Account updated');
        } else {
          status.textContent = result?.message || result?.error || 'Update failed (last-admin guard?)';
        }
      }, { signal });
      row.appendChild(back);
      row.appendChild(save);
      body.appendChild(row);
    }

    async function resetCredential(user) {
      const result = await adminUsers('accounts.resetCredential', { uid: user.uid });
      if (!result?.success) {
        toast(result?.message || result?.error || 'Reset failed', true);
        return;
      }
      const data = result.data || {};
      // The temporary PIN is shown exactly once.
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: `Temporary PIN — ${user.displayName || user.username}` }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: 'Valid for 15 minutes. The account must choose a new PIN at its next sign-in. Both ends are logged to the audit feed.' }));
      const pinCard = createEl('div', {
        style: 'display:inline-block;padding:18px 26px;border-radius:12px;border:1px dashed var(--accent);font-size:26px;letter-spacing:6px;font-weight:700;color:var(--accent);background:var(--bg-overlay);',
        textContent: String(data.temporaryPin || ''),
      });
      body.appendChild(pinCard);
      const back = createEl('button', { className: 'nbusers-btn', textContent: 'Done' });
      back.style.marginTop = '16px';
      back.addEventListener('click', () => selectTab('users'), { signal });
      body.appendChild(back);
      await refresh();
    }

    function renderDeleteUser(user) {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: `Delete — ${user.displayName || user.username}` }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: 'The owner is never deletable, and the last active admin is protected. Choose what happens to the account\u2019s storage.' }));

      const status = createEl('div', { className: 'nbusers-status' });
      const row = createEl('div', { style: 'display:flex;flex-direction:column;gap:10px;max-width:460px' });

      const mk = (title, description, mode, className) => {
        const card = createEl('div', { style: 'padding:14px;border-radius:10px;border:1px solid var(--border-default);cursor:pointer;' });
        card.appendChild(createEl('div', { style: 'font-weight:600;font-size:13px', textContent: title }));
        card.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:4px', textContent: description }));
        card.addEventListener('click', async () => {
          card.style.borderColor = 'var(--accent)';
          status.textContent = '';
          const result = await adminUsers('accounts.delete', { uid: user.uid, mode });
          if (result?.success) {
            const data = result.data || {};
            await refresh();
            selectTab('users');
            toast(data.archivedTo ? `Archived to /Shared${String(data.archivedTo).split('admin-backups')[1] || ''}` : 'Account deleted');
          } else {
            status.textContent = result?.message || result?.error || 'Deletion refused';
          }
        }, { signal });
        return card;
      };

      row.appendChild(mk('Archive', 'Move this account\u2019s tree into /Shared/admin-backups for later retrieval, then remove the account.', 'archive'));
      row.appendChild(mk('Wipe', 'Remove the account\u2019s storage strata outright: registry files, user home, AppStorage rows, webview partitions.', 'wipe'));
      const back = createEl('button', { className: 'nbusers-btn ghost', textContent: 'Cancel' });
      back.addEventListener('click', () => selectTab('users'), { signal });
      row.appendChild(back);
      body.appendChild(row);
      body.appendChild(status);
    }

    // ── Policies tab ──────────────────────────────────────────────────────
    let policiesCache = null;

    async function loadPolicies() {
      const result = await adminUsers('policies.get');
      if (isPermissionDenied(result)) return { denied: true, message: result.message };
      policiesCache = result.data?.policies || result.policies || null;
      return { denied: false };
    }

    function renderPolicies() {
      body.innerHTML = '';
      if (!policiesCache) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: 'Policies unavailable.' }));
        return;
      }
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: 'Machine account policies' }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:16px', textContent: 'These apply to every account on this machine; individual storage quotas live per account on the Users tab.' }));

      const p = policiesCache;
      const form = createEl('div', { className: 'nbusers-form' });

      const mkToggle = (key, label, hint) => {
        const wrap = createEl('label', { style: 'display:flex;align-items:center;gap:10px;cursor:pointer;font-size:13px;' });
        const input = createEl('input', { type: 'checkbox' });
        input.checked = p[key] === true;
        wrap.appendChild(input);
        const text = createEl('span', {});
        text.appendChild(createEl('div', { textContent: label }));
        if (hint) text.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted)', textContent: hint }));
        wrap.appendChild(text);
        input.dataset.policyKey = key;
        form.appendChild(wrap);
        form.appendChild(createEl('div', { style: 'height:6px' }));
      };

      const mkNumber = (key, label, hint, min, max, step) => {
        form.appendChild(createEl('label', { textContent: label }));
        const input = createEl('input', { type: 'number', min: String(min), max: String(max), step: String(step) });
        const value = p[key];
        input.value = typeof value === 'number' ? value : '';
        input.style.width = '100%';
        input.dataset.policyKey = key;
        form.appendChild(input);
        if (hint) form.appendChild(createEl('div', { style: 'font-size:11px;color:var(--text-muted)', textContent: hint }));
        form.appendChild(createEl('div', { style: 'height:6px' }));
      };

      mkToggle('guestAccess', 'Guest access on the login picker', 'A guest tile starts an ephemeral, volatile session — nothing persists.');
      mkToggle('showUsernamesOnPicker', 'Show usernames on the login picker', 'Relax the display-name default for shared kiosks where real names help.');
      mkToggle('closeAppsOnSwitch', 'Close apps when switching accounts', 'The memory-disciplined default; the keep-running variant arrives later without protocol changes.');
      mkNumber('defaultUserQuotaBytes', 'Default per-account storage (bytes)', 'Applied to newly created accounts.', 1024 * 1024, 32 * 1024 ** 3, 1024 * 1024);
      mkNumber('idleLockMaxMinutes', 'Idle lock maximum (minutes)', 'Accounts may set a shorter idle lock, never longer.', 1, 240, 1);
      mkNumber('lockoutShortMs', 'Lockout step 1 (ms)', 'Failed-attempt ladder: short lockout.', 5000, 600000, 5000);
      mkNumber('lockoutExtendedMs', 'Lockout step 2 (ms)', 'Failed-attempt ladder: extended lockout before the admin-locked state.', 5000, 3600000, 5000);

      body.appendChild(form);
      const status = createEl('div', { className: 'nbusers-status' });
      body.appendChild(status);
      const save = createEl('button', { className: 'nbusers-btn primary', textContent: 'Save policies' });
      save.addEventListener('click', async () => {
        const patch = {};
        for (const input of form.querySelectorAll('[data-policy-key]')) {
          const key = input.dataset.policyKey;
          patch[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
        }
        const result = await adminUsers('policies.set', { policies: patch });
        if (result?.success) {
          policiesCache = result.data?.policies || policiesCache;
          status.textContent = 'Saved';
          status.className = 'nbusers-status nbusers-ok';
        } else {
          status.textContent = result?.message || result?.error || 'Policy save failed';
          status.className = 'nbusers-status';
        }
      }, { signal });
      body.appendChild(save);
    }

    // ── Audit tab ────────────────────────────────────────────────────────
    let auditFilterUid = '';

    async function renderAudit() {
      body.innerHTML = '';
      body.appendChild(createEl('div', { style: 'font-size:14px;font-weight:600;margin-bottom:4px', textContent: 'Account events' }));
      body.appendChild(createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-bottom:14px', textContent: 'The persistent per-user audit feed: sign-ins, credential changes, account lifecycle, admin actions.' }));

      const toolbar = createEl('div', { className: 'nbusers-toolbar' });
      const filter = createEl('select');
      filter.appendChild(createEl('option', { value: '', textContent: 'All accounts' }));
      for (const user of usersCache) {
        filter.appendChild(createEl('option', { value: user.uid, textContent: user.displayName || user.username }));
      }
      filter.value = auditFilterUid;
      filter.addEventListener('change', () => { auditFilterUid = filter.value; renderAudit(); }, { signal });
      toolbar.appendChild(filter);
      const exportBtn = createEl('button', { className: 'nbusers-btn', textContent: 'Export CSV' });
      exportBtn.addEventListener('click', exportAuditCsv, { signal });
      toolbar.appendChild(exportBtn);
      body.appendChild(toolbar);

      const result = await adminUsers('events.list', { limit: 200, ...(auditFilterUid ? { uid: auditFilterUid } : {}) });
      const events = result?.data?.events || result?.events || [];
      if (!events.length) {
        body.appendChild(createEl('div', { className: 'nbusers-empty', textContent: 'No events yet.' }));
        return;
      }
      for (const event of events) {
        const el = createEl('div', { className: `nbusers-event ${event.severity || 'info'}` });
        el.appendChild(createEl('div', {
          style: 'display:flex;justify-content:space-between;gap:10px;color:var(--text-muted);font-size:11px;',
        }, [
          createEl('span', { textContent: fmtDate(event.ts) }),
          createEl('span', { textContent: event.actor || '' }),
        ]));
        el.appendChild(createEl('div', { style: 'font-weight:600', textContent: event.action }));
        if (event.target) el.appendChild(createEl('div', { style: 'color:var(--text-muted)', textContent: `target: ${event.target}` }));
        if (event.detail && typeof event.detail === 'object') {
          el.appendChild(createEl('div', { style: 'color:var(--text-muted);font-size:11px;white-space:pre-wrap;', textContent: JSON.stringify(event.detail) }));
        }
        body.appendChild(el);
      }
    }

    async function exportAuditCsv() {
      const result = await adminUsers('events.list', { ...(auditFilterUid ? { uid: auditFilterUid } : {}), limit: 1000 });
      const events = result?.data?.events || result?.events || [];
      const escapeCell = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      const lines = [ 'ts,actor,action,target,severity,ip' ];
      for (const event of events) {
        lines.push([new Date(event.ts).toISOString(), event.actor || '', event.action, event.target || '', event.severity || '', event.ip || ''].map(escapeCell).join(','));
      }
      try {
        const destination = await window.SystemDialogs.save({
          title: 'Export account events',
          suggestedName: 'novabyte-account-events.csv',
        });
        if (!destination) return;
        const nodeRequire = typeof window.require === 'function'
          ? window.require
          : (typeof require === 'function' ? require : null);
        if (!nodeRequire) throw new Error('File writing is unavailable in this runtime.');
        await nodeRequire('fs').promises.writeFile(destination.path, lines.join('\n'), 'utf8');
        toast('CSV exported to ' + destination.path);
      } catch (err) {
        toast('CSV export failed: ' + (err?.message || err), true);
      }
    }

    // ── Refresh / first paint ─────────────────────────────────────────────
    async function refresh() {
      const users = await loadUsers();
      if (users.denied) {
        roleDeniedSplash(users.message);
        return;
      }
      if (activeTab === 'users') renderUsers();
    }

    async function renderTab() {
      if (activeTab === 'users') {
        const users = await loadUsers();
        if (users.denied) { roleDeniedSplash(users.message); return; }
        renderUsers();
      } else if (activeTab === 'policies') {
        const policies = await loadPolicies();
        if (policies.denied) { roleDeniedSplash(policies.message); return; }
        renderPolicies();
      } else if (activeTab === 'audit') {
        renderAudit();
      }
    }

    // First paint: verify admin role + grant before any chrome renders.
    try {
      const users = await loadUsers();
      if (users.denied) {
        roleDeniedSplash(users.message);
        return;
      }
    } catch (err) {
      roleDeniedSplash('The account service is unreachable: ' + (err?.message || err));
      return;
    }
    renderUsers();
  },
});
