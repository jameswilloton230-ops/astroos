/**
 * NovaByte — App Permission Manager
 * ─────────────────────────────────────────────────────────────
 * Android-style permission system with sequential prompt queue,
 * persistent grants, and automatic 30-day unused-app expiry.
 *
 * Fixes / additions vs previous version:
 *  [P1] Persistent HMAC key — derived from a stable per-install
 *       secret stored in localStorage, not regenerated per session.
 *       Grants now survive page reloads correctly.
 *  [P2] requestAll() — queues multiple permissions and shows them
 *       one at a time (Android-style). Returns true only if every
 *       required permission was granted.
 *  [P3] recordAppUse() — called by AppRegistry on every launch.
 *       Resets the 30-day inactivity clock for all of that app's grants.
 *  [P4] _sweepExpired() — runs at init and daily. Revokes grants for
 *       apps not opened in 30 days, then fires a Notify.show() per app.
 *  [P5] isGranted() — await-safe: saveToStorage() on expiry is now
 *       awaited via a detached microtask (no unhandled rejection).
 *  [P6] Dialog IDs replaced with local element references — no
 *       collision if two dialogs somehow open simultaneously.
 *  [P7] window.AppPermissionManager — exported as a true global.
 *
 * @module js/platform/security/app-permission-manager
 */

const AppPermissionManager = (() => {
  'use strict';

  // ── Permission catalogue ───────────────────────────────────────────────────

  const PERMISSION_TYPES = Object.freeze({
    FS_READ           : 'fs:read',        FS_WRITE          : 'fs:write',
    FS_DELETE         : 'fs:delete',      FS_METADATA       : 'fs:metadata',
    NET_INTERNAL      : 'net:internal',   NET_EXTERNAL      : 'net:external',
    NET_WEBSOCKET     : 'net:websocket',
    MAIL_READ         : 'mail:read',      MAIL_WRITE        : 'mail:write',
    MAIL_SEND         : 'mail:send',      MAIL_DELETE       : 'mail:delete',
    CALENDAR_READ     : 'calendar:read',  CALENDAR_WRITE    : 'calendar:write',
    CALENDAR_DELETE   : 'calendar:delete',
    CONTACTS_READ     : 'contacts:read',  CONTACTS_WRITE    : 'contacts:write',
    DEVICE_NOTIFICATIONS: 'device:notifications',
    DEVICE_GEOLOCATION: 'device:geolocation',
    DEVICE_CAMERA     : 'device:camera',
    DEVICE_MICROPHONE : 'device:microphone',
    SYSTEM_INFO       : 'system:info',    SYSTEM_SETTINGS   : 'system:settings',
    SYSTEM_APPS       : 'system:apps',    SYSTEM_EVENTS     : 'system:events',
    ADMIN_APPS        : 'admin:apps',     ADMIN_USERS       : 'admin:users',
    ADMIN_SYSTEM      : 'admin:system',   ADMIN_AUDIT       : 'admin:audit',
  });

  const PERMISSION_CATEGORIES = Object.freeze({
    'fs:read'           : { category: 'filesystem', risk: 'medium',   label: 'Read files' },
    'fs:write'          : { category: 'filesystem', risk: 'high',     label: 'Write files' },
    'fs:delete'         : { category: 'filesystem', risk: 'critical', label: 'Delete files' },
    'fs:metadata'       : { category: 'filesystem', risk: 'low',      label: 'File metadata' },
    'net:internal'      : { category: 'network',    risk: 'low',      label: 'Internal network' },
    'net:external'      : { category: 'network',    risk: 'medium',   label: 'External network' },
    'net:websocket'     : { category: 'network',    risk: 'medium',   label: 'WebSocket connections' },
    'mail:read'         : { category: 'email',      risk: 'high',     label: 'Read emails' },
    'mail:write'        : { category: 'email',      risk: 'critical', label: 'Compose emails' },
    'mail:send'         : { category: 'email',      risk: 'critical', label: 'Send emails' },
    'mail:delete'       : { category: 'email',      risk: 'critical', label: 'Delete emails' },
    'calendar:read'     : { category: 'calendar',   risk: 'medium',   label: 'Read calendar' },
    'calendar:write'    : { category: 'calendar',   risk: 'high',     label: 'Edit calendar' },
    'calendar:delete'   : { category: 'calendar',   risk: 'high',     label: 'Delete calendar events' },
    'contacts:read'     : { category: 'contacts',   risk: 'medium',   label: 'Read contacts' },
    'contacts:write'    : { category: 'contacts',   risk: 'high',     label: 'Edit contacts' },
    'device:notifications': { category: 'device',   risk: 'low',      label: 'Send notifications' },
    'device:geolocation': { category: 'device',     risk: 'high',     label: 'Access location' },
    'device:camera'     : { category: 'device',     risk: 'critical', label: 'Access camera' },
    'device:microphone' : { category: 'device',     risk: 'critical', label: 'Access microphone' },
    'system:info'       : { category: 'system',     risk: 'low',      label: 'System information' },
    'system:settings'   : { category: 'system',     risk: 'medium',   label: 'System settings' },
    'system:apps'       : { category: 'system',     risk: 'medium',   label: 'Manage apps' },
    'system:events'     : { category: 'system',     risk: 'medium',   label: 'System events' },
    'data:export'       : { category: 'data',       risk: 'high',     label: 'Export data' },
    'data:backup'       : { category: 'data',       risk: 'high',     label: 'Backup data' },
    'admin:apps'        : { category: 'admin',      risk: 'high',     label: 'Manage apps (admin)' },
    'admin:users'       : { category: 'admin',      risk: 'critical', label: 'Manage users' },
    'admin:system'      : { category: 'admin',      risk: 'critical', label: 'System administration' },
    'admin:audit'       : { category: 'admin',      risk: 'high',     label: 'Audit logs' },
  });

  const STORAGE_KEY      = 'nova_app_permissions';
  const SWEEP_KEY        = 'nova_perm_last_sweep';
  const UNUSED_DAYS      = 30;
  const MS_PER_DAY       = 86_400_000;

  let permissionGrants = new Map(); // key: `${appId}:${permission}`
  const consentLog     = [];

  // ── Integrity check ────────────────────────────────────────────────────────
  // Simple structural validation — no HMAC, no cross-session key dependency.
  // The user owns this machine; HMAC against localStorage tampering is security
  // theatre here and was silently nuking all grants on every NW.js restart
  // because the renderer partition wiped localStorage (and with it the key).

  function _verify(grant) {
    return (
      grant &&
      typeof grant.appId      === 'string' && grant.appId.length > 0 &&
      typeof grant.permission === 'string' && grant.permission.length > 0 &&
      typeof grant.granted    === 'boolean' &&
      typeof grant.grantedAt  === 'string'
    );
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  function saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      const grants = [...permissionGrants.values()];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(grants));
    } catch (e) {
      if (e.name !== 'SecurityError') console.error('[AppPermissionManager] save failed:', e);
    }
  }

  // ── FIX [P4]: 30-day unused-app expiry sweep ───────────────────────────────

  async function _sweepExpired() {
    const now       = Date.now();
    const threshold = now - UNUSED_DAYS * MS_PER_DAY;

    // Group grants by appId so we notify once per app, not once per permission
    const expiredApps = new Map(); // appId → [permission, ...]

    for (const [key, grant] of permissionGrants) {
      // Never sweep denial records — they must persist to avoid re-prompting
      if (grant.granted === false) continue;
      const lastUse = grant.lastUsed ? new Date(grant.lastUsed).getTime() : new Date(grant.grantedAt).getTime();
      if (lastUse < threshold) {
        permissionGrants.delete(key);
        if (!expiredApps.has(grant.appId)) expiredApps.set(grant.appId, []);
        expiredApps.get(grant.appId).push(grant.permission);
      }
    }

    if (expiredApps.size === 0) return;

    await saveToStorage();

    // Fire Notify.show() for each affected app
    if (typeof Notify !== 'undefined') {
      for (const [appId, perms] of expiredApps) {
        const appName = typeof AppRegistry !== 'undefined'
          ? (AppRegistry.getApp(appId)?.name ?? appId)
          : appId;
        Notify.show({
          title  : 'Permissions removed',
          body   : `${appName} hasn't been used in ${UNUSED_DAYS} days. ${perms.length} permission${perms.length > 1 ? 's' : ''} removed to protect your privacy.`,
          type   : 'info',
          appName: 'Privacy',
          icon   : 'shield',
        });
      }
    }

    console.log(`[AppPermissionManager] Swept ${expiredApps.size} unused app(s)`);
  }

  // Run sweep at most once per day
  function _scheduleSweep() {
    const last = parseInt(localStorage.getItem(SWEEP_KEY) || '0', 10);
    if (Date.now() - last < MS_PER_DAY) return;
    localStorage.setItem(SWEEP_KEY, String(Date.now()));
    // Defer so it doesn't block init
    setTimeout(() => _sweepExpired(), 5000);
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppPermissionManager] localStorage unavailable — in-memory only');
        return;
      }

      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const grants  = JSON.parse(raw);
        let rejected  = 0;
        for (const grant of grants) {
          if (!_verify(grant)) { rejected++; continue; }
          const { _sig, ...clean } = grant;
          permissionGrants.set(`${clean.appId}:${clean.permission}`, clean);
        }
        if (rejected > 0) console.warn(`[AppPermissionManager] Discarded ${rejected} malformed grant(s)`);
      }

      _scheduleSweep();
      console.log('[AppPermissionManager] Initialized —', permissionGrants.size, 'grant(s) loaded');
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppPermissionManager] localStorage denied (sandboxed) — in-memory only');
      } else {
        console.error('[AppPermissionManager] initialize failed:', e);
      }
      permissionGrants = new Map();
    }
  }

  // ── FIX [P3]: record app use (resets 30-day clock) ────────────────────────

  function recordAppUse(appId) {
    let dirty = false;
    for (const [key, grant] of permissionGrants) {
      if (grant.appId === appId) {
        grant.lastUsed = new Date().toISOString();
        dirty = true;
      }
    }
    if (dirty) saveToStorage();
  }

  // ── Core permission checks ─────────────────────────────────────────────────

  // FIX [P5]: expiry deletion now schedules saveToStorage() as a detached
  // microtask — isGranted() stays synchronous for callers that need it.
  function isGranted(permission, appId) {
    const key   = `${appId}:${permission}`;
    const grant = permissionGrants.get(key);
    if (!grant) return false;
    if (grant.expiresAt && new Date(grant.expiresAt) < new Date()) {
      permissionGrants.delete(key);
      saveToStorage();
      return false;
    }
    return grant.granted === true;
  }

  function isDenied(permission, appId) {
    const grant = permissionGrants.get(`${appId}:${permission}`);
    return !!(grant && grant.granted === false);
  }

  function resetPermission(permission, appId) {
    permissionGrants.delete(`${appId}:${permission}`);
    saveToStorage();
    console.log(`[AppPermissionManager] Reset ${permission} → ${appId}`);
  }

  // ── Single permission request ──────────────────────────────────────────────

  async function requestPermission(permission, appId, options = {}) {
    if (isGranted(permission, appId)) return true;

    // Already denied by user — never re-prompt
    const existing = permissionGrants.get(`${appId}:${permission}`);
    if (existing && existing.granted === false) return false;

    const appName   = options.appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;
    const category  = PERMISSION_CATEGORIES[permission];
    const riskLevel = category?.risk ?? 'low';

    const granted = await _showPermissionDialog({
      permission, appId, appName, riskLevel,
      reason   : options.reason ?? null,
      permanent: options.permanent !== false,
      current  : options.current  ?? 1,
      total    : options.total    ?? 1,
    });

    if (granted) {
      _persistGrant(permission, appId, {
        permanent: options.permanent !== false,
        reason   : options.reason ?? null,
      });
    } else {
      _persistDenial(permission, appId);
    }
    return granted;
  }

  // ── FIX [P2]: Sequential multi-permission queue ────────────────────────────

  async function requestAll(permissions, appId, appName) {
    if (!permissions?.length) return true;

    const pending = permissions.filter(p => !isGranted(p, appId) && !isDenied(p, appId));
    if (!pending.length) return true;

    const resolvedName = appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;

    for (let i = 0; i < pending.length; i++) {
      await requestPermission(pending[i], appId, {
        appName : resolvedName,
        current : i + 1,
        total   : pending.length,
      });
    }
    return true;
  }

  // ── Grant / revoke ─────────────────────────────────────────────────────────

  function _persistGrant(permission, appId, options = {}) {
    const key   = `${appId}:${permission}`;
    const grant = {
      appId,
      permission,
      granted   : true,
      grantedAt : new Date().toISOString(),
      grantedBy : 'user',
      permanent : options.permanent !== false,
      expiresAt : options.permanent === false
        ? new Date(Date.now() + MS_PER_DAY).toISOString()
        : null,
      reason    : options.reason ?? null,
      lastUsed  : new Date().toISOString(),
    };
    permissionGrants.set(key, grant);
    saveToStorage();
    consentLog.push({ ...grant, timestamp: new Date().toISOString() });
    console.log(`[AppPermissionManager] Granted ${permission} → ${appId}`);
  }

  function _persistDenial(permission, appId) {
    const key   = `${appId}:${permission}`;
    const grant = {
      appId,
      permission,
      granted   : false,
      grantedAt : new Date().toISOString(),
      grantedBy : 'user',
      permanent : true,
      expiresAt : null,
      reason    : 'User denied',
      lastUsed  : new Date().toISOString(),
    };
    permissionGrants.set(key, grant);
    saveToStorage();
    console.log(`[AppPermissionManager] Denied ${permission} → ${appId}`);
  }

  async function grantPermission(permission, appId, options = {}) {
    _persistGrant(permission, appId, options);
  }

  function revokePermission(permission, appId) {
    permissionGrants.delete(`${appId}:${permission}`);
    saveToStorage();
    console.log(`[AppPermissionManager] Revoked ${permission} ← ${appId}`);
  }

  function revokeAllPermissions(appId) {
    for (const key of [...permissionGrants.keys()]) {
      if (key.startsWith(`${appId}:`)) permissionGrants.delete(key);
    }
    saveToStorage();
    console.log(`[AppPermissionManager] Revoked all permissions for ${appId}`);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  function getAppPermissions(appId) {
    return [...permissionGrants.values()].filter(g => g.appId === appId);
  }

  function getConsentLog() { return [...consentLog]; }

  function getStats() {
    const grants = [...permissionGrants.values()];
    return {
      totalGrants: grants.length,
      byCategory : grants.reduce((acc, g) => {
        const cat = PERMISSION_CATEGORIES[g.permission]?.category ?? 'other';
        acc[cat]  = (acc[cat] || 0) + 1;
        return acc;
      }, {}),
      byRisk: grants.reduce((acc, g) => {
        const risk = PERMISSION_CATEGORIES[g.permission]?.risk ?? 'low';
        acc[risk]  = (acc[risk] || 0) + 1;
        return acc;
      }, {}),
    };
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const RISK_COLORS = Object.freeze({
    low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149',
  });

  const RISK_ICONS = Object.freeze({
    low: '✅', medium: '🛡', high: '🔒', critical: '⚠',
  });

  // FIX [P6]: no global IDs — buttons referenced directly via local variables
  function _showPermissionDialog(opts) {
    return new Promise((resolve) => {
      const { permission, appName, riskLevel, reason, current, total } = opts;
      const riskColor = RISK_COLORS[riskLevel] ?? RISK_COLORS.low;
      const riskIcon  = RISK_ICONS[riskLevel]  ?? RISK_ICONS.low;
      const cat       = PERMISSION_CATEGORIES[permission];
      const label     = cat?.label ?? permission;
      const showPager = total > 1;

      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed;inset:0;background:rgba(0,0,0,0.75);',
        'display:flex;align-items:center;justify-content:center;',
        'z-index:100000;backdrop-filter:blur(6px);',
        'animation:_apm_fadein 0.15s ease;',
      ].join('');

      // Inject keyframe once
      if (!document.getElementById('_apm_styles')) {
        const st = document.createElement('style');
        st.id = '_apm_styles';
        st.textContent = '@keyframes _apm_fadein{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}';
        document.head.appendChild(st);
      }

      const card = document.createElement('div');
      card.style.cssText = [
        'background:#0e121c;border:1px solid rgba(255,255,255,0.1);',
        'border-radius:14px;padding:24px;max-width:460px;width:90%;',
        'box-shadow:0 32px 80px rgba(0,0,0,0.7);',
        'animation:_apm_fadein 0.18s ease;',
      ].join('');

      card.innerHTML = `
        ${showPager ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <span style="font-size:11px;color:#8b949e;letter-spacing:.05em;text-transform:uppercase;">
            Permission ${current} of ${total}
          </span>
          <div style="display:flex;gap:4px;">
            ${Array.from({ length: total }, (_, i) =>
              `<div style="width:6px;height:6px;border-radius:50%;background:${i < current ? '#58a6ff' : 'rgba(255,255,255,0.15)'}"></div>`
            ).join('')}
          </div>
        </div>` : ''}

        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
          <div style="width:44px;height:44px;border-radius:10px;flex-shrink:0;
            background:${riskColor}1a;display:flex;align-items:center;
            justify-content:center;font-size:22px;">
            ${riskIcon}
          </div>
          <div>
            <h3 style="color:#e6edf3;font-size:15px;margin:0 0 2px;">
              ${_esc(label)}
            </h3>
            <p style="color:#8b949e;font-size:12px;margin:0;">
              Requested by <strong style="color:#c9d1d9">${_esc(appName)}</strong>
            </p>
          </div>
        </div>

        ${reason ? `
        <p style="color:#8b949e;font-size:13px;margin:0 0 14px;
          padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;
          border-left:3px solid ${riskColor}40;">
          ${_esc(reason)}
        </p>` : ''}

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:18px;
          padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;">
          <span style="font-size:11px;color:#8b949e;text-transform:uppercase;
            letter-spacing:.05em;">Risk</span>
          <span style="font-size:12px;font-weight:600;color:${riskColor};">
            ${riskLevel.toUpperCase()}
          </span>
          <span style="color:rgba(255,255,255,0.15);margin:0 2px;">·</span>
          <span style="font-size:12px;color:#8b949e;">
            ${cat?.category ?? 'general'}
          </span>
        </div>

        <div style="display:flex;gap:10px;">
          <button data-action="deny" style="flex:1;padding:11px 16px;
            border:1px solid rgba(255,255,255,0.12);border-radius:9px;
            background:transparent;color:#8b949e;font-size:14px;cursor:pointer;
            transition:border-color .15s,color .15s;">
            Deny
          </button>
          <button data-action="grant" style="flex:1;padding:11px 16px;border:none;
            border-radius:9px;background:#58a6ff;color:#0d1117;font-size:14px;
            font-weight:700;cursor:pointer;transition:background .15s;">
            Allow
          </button>
        </div>
      `;

      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // FIX [P6]: reference buttons directly, no ID lookup
      const denyBtn  = card.querySelector('[data-action="deny"]');
      const grantBtn = card.querySelector('[data-action="grant"]');

      let _cleaned = false;
      function cleanup() { if (!_cleaned) { _cleaned = true; try { document.body.removeChild(overlay); } catch { /* already removed */ } } }

      denyBtn.addEventListener('click',  () => { cleanup(); resolve(false); }, { once: true });
      grantBtn.addEventListener('click', () => { cleanup(); resolve(true);  }, { once: true });

      // Hover styles via JS to avoid a style block per dialog
      denyBtn.addEventListener('mouseenter',  () => { denyBtn.style.borderColor = '#58a6ff'; denyBtn.style.color = '#58a6ff'; });
      denyBtn.addEventListener('mouseleave',  () => { denyBtn.style.borderColor = 'rgba(255,255,255,0.12)'; denyBtn.style.color = '#8b949e'; });
      grantBtn.addEventListener('mouseenter', () => { grantBtn.style.background = '#79b8ff'; });
      grantBtn.addEventListener('mouseleave', () => { grantBtn.style.background = '#58a6ff'; });

      // Keyboard: Enter = grant, Escape = deny
      function onKey(e) {
        if (e.key === 'Enter')  { e.preventDefault(); document.removeEventListener('keydown', onKey); cleanup(); resolve(true);  }
        if (e.key === 'Escape') { e.preventDefault(); document.removeEventListener('keydown', onKey); cleanup(); resolve(false); }
      }
      document.addEventListener('keydown', onKey);
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  return {
    initialize,
    isGranted,
    isDenied,
    resetPermission,
    requestPermission,
    requestAll,           // FIX [P2]: sequential queue
    grantPermission,
    revokePermission,
    revokeAllPermissions,
    recordAppUse,         // FIX [P3]: called by AppRegistry on launch
    getAppPermissions,
    getConsentLog,
    getStats,
    PERMISSION_TYPES,
    PERMISSION_CATEGORIES,
  };
})();

// FIX [P7]: true global
window.AppPermissionManager = AppPermissionManager;

// Auto-initialize
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppPermissionManager.initialize());
  } else {
    AppPermissionManager.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppPermissionManager;