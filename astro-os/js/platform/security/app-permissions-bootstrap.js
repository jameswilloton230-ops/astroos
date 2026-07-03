/**
 * NovaByte — Built-in App Permissions Bootstrap
 * ─────────────────────────────────────────────────────────────
 * Applies the AOSP-style permission model to all built-in apps
 * without touching any individual app file.
 *
 * How it works:
 *  1. Defines the canonical permission map for every built-in app,
 *     split into NORMAL (auto-grant, no prompt) and DANGEROUS (prompt).
 *  2. On first boot: silently pre-grants all NORMAL permissions for
 *     all built-in apps. Stores nova_perms_bootstrapped so this only
 *     ever runs once.
 *  3. Wraps OS.apps[id].init with a permission gate — when WM calls
 *     app.init(), the wrapper checks/requests permissions first, then
 *     calls the original init if granted. This keeps the WM launch
 *     path intact — no rerouting through AppRegistry.launchApp().
 *  4. On every subsequent boot: normal permissions are verified and
 *     re-granted silently if missing.
 *
 * Permission tiers (mirrors AOSP):
 *  NORMAL    — low-risk, auto-granted, never shown to user
 *  DANGEROUS — sensitive, always prompts on first use, user can revoke
 *
 * @module js/platform/security/app-permissions-bootstrap
 */

(function () {
  'use strict';

  const BOOTSTRAP_KEY = 'nova_perms_bootstrapped';

  // ── Permission tier definitions ──────────────────────────────────────────

  const APP_PERMISSION_MAP = Object.freeze({

    // Files (vault)
    vault: {
      normal   : ['fs:read', 'fs:metadata'],
      dangerous: ['fs:write', 'fs:delete'],
    },

    // Terminal (shell)
    shell: {
      normal   : ['fs:read', 'system:info'],
      dangerous: ['fs:write', 'fs:delete', 'admin:system'],
    },

    // Text Editor (quill) — id confirmed from textedit.js com.nbosp.quill
    quill: {
      normal   : ['fs:read'],
      dangerous: ['fs:write'],
    },

    // Email
    'nbosp-email': {
      normal   : ['net:internal'],
      dangerous: ['mail:read', 'mail:write', 'mail:send', 'mail:delete', 'net:external', 'fs:write'],
    },

    // Calendar
    'calendar-app': {
      normal   : [],
      dangerous: ['calendar:read', 'calendar:write', 'calendar:delete', 'fs:write'],
    },

    // Contacts
    'nbosp-contacts': {
      normal   : [],
      dangerous: ['contacts:read', 'contacts:write', 'contacts:delete', 'fs:write'],
    },

    // Browser
    browser: {
      normal   : ['net:internal'],
      dangerous: ['net:external', 'device:camera', 'device:microphone', 'device:geolocation', 'fs:write'],
    },

    // Settings (nook) — system UI, never prompt
    nook: {
      normal   : ['system:info', 'system:settings', 'admin:system', 'fs:read', 'fs:write', 'fs:delete', 'fs:metadata', 'device:camera', 'device:microphone', 'device:geolocation'],
      dangerous: [],
    },

    // Gallery
    'nbosp-gallery': {
      normal   : ['fs:read', 'fs:metadata'],
      dangerous: [],
    },

    // Music
    'nbosp-music': {
      normal   : ['fs:read', 'fs:metadata'],
      dangerous: ['fs:write'],
    },

    // Downloads
    'nbosp-downloads': {
      normal   : ['fs:read', 'fs:metadata'],
      dangerous: ['fs:write', 'fs:delete', 'net:external'],
    },

    // Search
    'nbosp-search': {
      normal   : ['fs:read', 'fs:metadata'],
      dangerous: [],
    },

    // App Manager — system UI, never prompt
    'app-manager': {
      normal   : ['system:apps', 'fs:read', 'fs:write', 'fs:delete', 'net:external'],
      dangerous: [],
    },

    // Calculator
    calculator: {
      normal   : [],
      dangerous: [],
    },

    // Clock
    'nbosp-clock': {
      normal   : [],
      dangerous: [],
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _log(msg)  { console.log('[PermBootstrap] ' + msg); }
  function _warn(msg) { console.warn('[PermBootstrap] ' + msg); }

  async function _autoGrant(permission, appId) {
    if (AppPermissionManager.isGranted(permission, appId)) return;
    await AppPermissionManager.grantPermission(permission, appId, {
      permanent: true,
      reason   : 'System permission — auto-granted at first boot',
      grantedBy: 'system',
    });
  }

  // ── Core fix: wrap OS.apps[id].init instead of rerouting through AppRegistry
  //
  // WM calls OS.apps[appId].init(content, state, options) directly at line 145.
  // We wrap that function so the permission check happens first, then the
  // original init runs normally if granted. The WM launch path is untouched.

  function _wrapAppInit(appId, dangerous) {
    const entry = OS?.apps?.[appId];
    if (!entry) { _warn('OS.apps entry missing for: ' + appId); return; }
    if (!entry.init) { _warn('No init on OS.apps entry for: ' + appId); return; }
    if (entry.__permWrapped) return; // already wrapped, don't double-wrap

    const originalInit = entry.init;

    entry.init = async function (content, state, options) {
      // Only check dangerous permissions — normal ones are pre-granted silently
      if (dangerous.length > 0) {
        const mgr = AppPermissionManager;
        const missing = dangerous.filter(p => !mgr.isGranted(p, appId) && !(mgr.isDenied && mgr.isDenied(p, appId)));
        if (missing.length > 0) {
          const appName = entry.name || appId;
          // Denial never blocks launch — app opens regardless.
          // Features needing the denied permission fail gracefully when used.
          await mgr.requestAll(missing, appId, appName);
        }
      }
      // Permissions granted — run the real init
      return originalInit.call(this, content, state, options);
    };

    entry.__permWrapped = true;
  }

  function _wrapAllApps() {
    let wrapped = 0;
    for (const [appId, { dangerous }] of Object.entries(APP_PERMISSION_MAP)) {
      if (dangerous.length > 0) {
        _wrapAppInit(appId, dangerous);
        wrapped++;
      }
    }
    _log('Wrapped ' + wrapped + ' app init functions');
  }

  // ── First-boot normal permission pre-grant ────────────────────────────────

  async function _bootstrapNormalPermissions() {
    _log('First boot — pre-granting normal permissions');
    let count = 0;
    for (const [appId, { normal }] of Object.entries(APP_PERMISSION_MAP)) {
      for (const perm of normal) {
        await _autoGrant(perm, appId);
        count++;
      }
    }
    try { localStorage.setItem(BOOTSTRAP_KEY, '1'); } catch { /* sandboxed */ }
    _log('Pre-granted ' + count + ' normal permission(s)');
  }

  async function _verifyNormalPermissions() {
    let restored = 0;
    for (const [appId, { normal }] of Object.entries(APP_PERMISSION_MAP)) {
      for (const perm of normal) {
        if (!AppPermissionManager.isGranted(perm, appId)) {
          await _autoGrant(perm, appId);
          restored++;
        }
      }
    }
    if (restored > 0) _warn('Restored ' + restored + ' missing normal permission(s)');
  }

  // ── Main entry ────────────────────────────────────────────────────────────

  async function bootstrap() {
    if (typeof AppPermissionManager === 'undefined') {
      _warn('AppPermissionManager not loaded — skipping');
      return;
    }
    if (typeof OS === 'undefined' || !OS?.apps) {
      _warn('OS not loaded — skipping');
      return;
    }

    // Wrap OS.apps[id].init for every app that has dangerous permissions
    _wrapAllApps();

    // Gate third-party / web apps
    _gateThirdPartyApps();

    // Wrap FS methods to enforce fs:write and fs:delete at the operation level
    _wrapFsMethods();

    // First boot: pre-grant normal permissions silently
    let isFirstBoot = false;
    try { isFirstBoot = localStorage.getItem(BOOTSTRAP_KEY) !== '1'; } catch { /* sandboxed */ }

    if (isFirstBoot) {
      await _bootstrapNormalPermissions();
    } else {
      await _verifyNormalPermissions();
    }

    _log('Bootstrap complete');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    Promise.resolve().then(bootstrap);
  }


  // ── FS permission enforcement ─────────────────────────────────────────────
  //
  // Wraps dangerous FS methods so any app that calls them is checked against
  // AppPermissionManager. Caller identity comes from OS.focusedWindowId →
  // WM windows map → state.appId. Falls back to allowing if context is
  // unavailable (e.g. system calls during boot).

  const FS_PERMISSION_MAP = Object.freeze({
    deleteToTrash   : 'fs:delete',
    permanentDelete : 'fs:delete',
    emptyTrash      : 'fs:delete',
    createFile      : 'fs:write',
    createFolder    : 'fs:write',
    writeFile       : 'fs:write',
    move            : 'fs:write',
    rename          : 'fs:write',
  });

  function _getCallerAppId() {
    try {
      // OS.windows is a Map of windowId → state (set by WM.createWindow)
      // OS.focusedWindowId is the currently focused window id
      const winId = OS.focusedWindowId;
      if (!winId || !OS?.windows) return null;
      return OS.windows.get(winId)?.appId ?? null;
    } catch { return null; }
  }

  function _wrapFsMethods() {
    if (typeof FS === 'undefined') { _warn('FS not loaded — skipping FS enforcement'); return; }
    if (FS.__permWrapped) return;

    for (const [method, permission] of Object.entries(FS_PERMISSION_MAP)) {
      if (typeof FS[method] !== 'function') continue;
      const original = FS[method].bind(FS);

      FS[method] = async function (...args) {
        const appId = _getCallerAppId();

        // No caller context (system call) — allow through
        if (!appId) return original(...args);

        const mgr = AppPermissionManager;
        if (!mgr.isGranted(permission, appId)) {
          const appName = OS.apps?.[appId]?.name ?? appId;
          _warn(`${appId} attempted ${method} without ${permission}`);

          // Notify the user instead of silently failing
          if (typeof Notify !== 'undefined') {
            Notify.show({
              title  : 'Permission Denied',
              body   : `${appName} doesn't have permission to do that. Grant "${permission}" in Settings → Apps.`,
              type   : 'error',
              appName: 'Security',
            });
          }
          return; // block the operation
        }

        return original(...args);
      };
    }

    FS.__permWrapped = true;
    _log('FS methods wrapped for permission enforcement');
  }

  // ── Third-party / web app permission gating ─────────────────────────────────
  //
  // Web apps (id: wa_...) and any app not in APP_PERMISSION_MAP get a default
  // dangerous permission set. We intercept their init the same way as built-ins.

  const WEB_APP_DANGEROUS = ['net:external', 'device:camera', 'device:microphone', 'device:geolocation'];

  function _gateThirdPartyApps() {
    if (typeof OS === 'undefined' || !OS?.apps) return;
    for (const [appId, entry] of Object.entries(OS.apps)) {
      if (APP_PERMISSION_MAP[appId] || entry.__permWrapped) continue;
      const isWebApp = appId.startsWith('webapp_') || appId.startsWith('wa_') || entry.__isWebApp;
      if (!isWebApp || !entry.init) continue;

      entry.__isWebApp = true;
      const originalInit = entry.init;
      entry.init = async function (content, state, options) {
        const mgr     = AppPermissionManager;
        const appName = entry.name || appId;
        const missing = WEB_APP_DANGEROUS.filter(p => !mgr.isGranted(p, appId) && !mgr.isDenied(p, appId));
        if (missing.length > 0) {
          await mgr.requestAll(missing, appId, appName);
        }
        return originalInit.call(this, content, state, options);
      };
      entry.__permWrapped = true;
    }
    _watchForNewWebApps();
  }

  function _watchForNewWebApps() {
    let knownIds = new Set(Object.keys(OS.apps || {}));
    const interval = setInterval(() => {
      if (typeof OS === 'undefined' || !OS?.apps) return;
      for (const [appId, entry] of Object.entries(OS.apps)) {
        if (knownIds.has(appId)) continue;
        knownIds.add(appId);
        const isWebApp = appId.startsWith('webapp_') || appId.startsWith('wa_') || entry.__isWebApp;
        if (!entry.__permWrapped && isWebApp && entry.init) {
          const originalInit = entry.init;
          const appName      = entry.name || appId;
          entry.__isWebApp = true;
          entry.init = async function (content, state, options) {
            const mgr     = AppPermissionManager;
            const missing = WEB_APP_DANGEROUS.filter(p => !mgr.isGranted(p, appId) && !mgr.isDenied(p, appId));
            if (missing.length > 0) await mgr.requestAll(missing, appId, appName);
            return originalInit.call(this, content, state, options);
          };
          entry.__permWrapped = true;
          _log('Gated new web app: ' + appId);
        }
      }
    }, 2000);
    setTimeout(() => clearInterval(interval), 300_000);
  }

  // Expose permission map for Settings UI
  window.AppPermissionsMap = APP_PERMISSION_MAP;

})();