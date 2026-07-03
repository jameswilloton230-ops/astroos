/**
 * NovaByte — App Registry
 * ─────────────────────────────────────────────────────────────
 * Manages installed applications, registration with OS.apps,
 * and app lifecycle (install, uninstall, update).
 *
 * Fixes applied vs previous version:
 *  [R1] window.AppRegistry — exported as a true global so every
 *       other file (AppPermissionManager, system-events, etc.) can
 *       reference it without import gymnastics.
 *  [R2] launchApp — no longer throws on missing permissions.
 *       Instead it calls AppPermissionManager.requestAll() which
 *       shows the sequential Android-style prompt queue, then
 *       proceeds or aborts cleanly.
 *  [R3] lastLaunched written on every launch — consumed by
 *       AppPermissionManager's 30-day unused-app expiry sweep.
 *  [R4] onInstall / onUninstall accept multiple callbacks via
 *       arrays instead of a single overwriteable reference.
 *  [R5] checkPermissions() guards against AppPermissionManager
 *       not yet being loaded.
 *
 * @module js/platform/core/app-registry
 */

const AppRegistry = (() => {
  'use strict';

  const STORAGE_KEY = 'nova_registry_meta';

  let installedApps    = new Map();
  const _onInstalled   = [];
  const _onUninstalled = [];

  // ── Storage ────────────────────────────────────────────────────────────────

  function _saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...installedApps.values()]));
    } catch (e) {
      if (e.name !== 'SecurityError') console.error('[AppRegistry] save failed:', e);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppRegistry] localStorage unavailable — in-memory only');
        return;
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const apps = JSON.parse(raw);
      for (const app of apps) installedApps.set(app.id, app);
      console.log(`[AppRegistry] Loaded ${installedApps.size} app(s)`);
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppRegistry] localStorage denied (sandboxed) — in-memory only');
      } else {
        console.error('[AppRegistry] initialize failed:', e);
      }
      installedApps = new Map();
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  function registerApp(appConfig) {
    if (!appConfig?.id || !appConfig?.name) throw new Error('[AppRegistry] App must have id and name');

    if (installedApps.has(appConfig.id)) {
      return installedApps.get(appConfig.id);
    }

    const app = {
      icon: 'app-window', description: '', version: '1.0.0', author: 'Unknown',
      type: 'webapp', entry: 'index.html', permissions: [], optionalPermissions: [],
      defaultSize: [800, 600], minSize: [400, 300], maxSize: null,
      resizable: true, frame: true, sandbox: { allowSameOrigin: true, allowScripts: true, allowForms: true, allowPopups: false },
      categories: ['other'], installedDate: new Date().toISOString(),
      lastLaunched: null, launchCount: 0, source: 'local', signature: null, verified: false,
      ...appConfig,
      id: appConfig.id,
      name: appConfig.name,
    };

    if (typeof OS !== 'undefined' && OS?.apps) {
      OS.apps[app.id] = {
        id: app.id, name: app.name, icon: app.icon, description: app.description,
        defaultSize: app.defaultSize, minSize: app.minSize, maxSize: app.maxSize ?? null,
        resizable: app.resizable !== false, frame: app.frame !== false,
        alwaysOnTop: app.alwaysOnTop || false, fullscreenable: app.fullscreenable !== false,
        startMinimized: app.startMinimized || false, transparent: app.transparent || false,
        init: (content, state, options) => AppRegistry.launchApp(app.id, content, state, options),
        onDrop: appConfig.onDrop ?? undefined,
        onClose: appConfig.onClose ?? undefined,
      };
    }

    installedApps.set(app.id, app);
    _saveToStorage();
    console.log(`[AppRegistry] Registered: ${app.name} (${app.id}) v${app.version}`);
    for (const cb of _onInstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return app;
  }

  function unregisterApp(appId) {
    const app = installedApps.get(appId);
    if (!app) return false;
    if (typeof OS !== 'undefined' && OS?.apps) delete OS.apps[appId];
    installedApps.delete(appId);
    _saveToStorage();
    console.log(`[AppRegistry] Unregistered: ${appId}`);
    for (const cb of _onUninstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return true;
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  /**
   * Launch an app.
   * FIX [R2]: missing required permissions now trigger the sequential
   * permission-request queue rather than throwing immediately.
   */
  async function launchApp(appId, content, state, options) {
    try {
      const disabled = JSON.parse(localStorage.getItem('nova_disabled_apps') || '[]');
      if (disabled.some(x => (typeof x === 'string' ? x : x?.id) === appId)) {
        console.warn('[AppRegistry] Launch blocked — disabled app:', appId);
        try {
          const name = OS?.apps?.[appId]?.name || appId;
          if (typeof Notify !== 'undefined' && Notify.show) {
            Notify.show({ title: 'App disabled', body: name + ' has a broken install and was disabled.', type: 'warn', appName: 'System' });
          }
        } catch { }
        return null;
      }
    } catch { }

    const app = installedApps.get(appId);
    if (!app) throw new Error(`[AppRegistry] App not found: ${appId}`);

    // FIX [R2]: request missing permissions before proceeding
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    if (mgr && app.permissions.length > 0) {
      const missing = app.permissions.filter(p => !mgr.isGranted(p, appId));
      if (missing.length > 0) {
        const allGranted = await mgr.requestAll(missing, appId, app.name);
        if (!allGranted) {
          console.warn(`[AppRegistry] Launch aborted — permissions denied for ${appId}`);
          return null;
        }
      }
    }

    // FIX [R3]: update usage timestamps so 30-day expiry sweep has data
    app.launchCount  = (app.launchCount || 0) + 1;
    app.lastLaunched = new Date().toISOString();
    _saveToStorage();

    // Also tell the permission manager this app was just used
    if (mgr?.recordAppUse) mgr.recordAppUse(appId);

    console.log(`[AppRegistry] Launching: ${app.name} (${appId})`);

    if (typeof AppSandbox !== 'undefined') {
      return AppSandbox.launch(app, content, state, options);
    }
    // Fallback if sandbox not loaded
    if (typeof app.init === 'function') return app.init(content, state, options);
    return null;
  }

  // ── Permissions ────────────────────────────────────────────────────────────

  /**
   * FIX [R5]: guard against AppPermissionManager not yet being loaded.
   */
  function checkPermissions(app) {
    if (typeof AppPermissionManager === 'undefined') return true; // defer to launchApp
    return app.permissions.every(p => AppPermissionManager.isGranted(p, app.id));
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch fields on an existing installedApps entry.
   * Used by app-permissions-bootstrap to write permissions[] into the
   * internal map — the only object launchApp() actually reads from.
   */
  function updateApp(appId, patch) {
    const app = installedApps.get(appId);
    if (!app) return false;
    Object.assign(app, patch);
    _saveToStorage();
    return true;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  function getApp(appId)              { return installedApps.get(appId) ?? null; }
  function getAllApps()               { return [...installedApps.values()]; }
  function getAppsByCategory(cat)    { return [...installedApps.values()].filter(a => a.categories.includes(cat)); }

  function getStats() {
    const apps = [...installedApps.values()];
    return {
      totalApps   : apps.length,
      totalLaunches: apps.reduce((s, a) => s + (a.launchCount || 0), 0),
      byCategory  : apps.reduce((acc, a) => {
        for (const c of a.categories) acc[c] = (acc[c] || 0) + 1;
        return acc;
      }, {}),
      verifiedApps: apps.filter(a => a.verified).length,
    };
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  // FIX [R4]: arrays instead of single overwriteable references
  function onInstall(cb)   { if (typeof cb === 'function') _onInstalled.push(cb); }
  function onUninstall(cb) { if (typeof cb === 'function') _onUninstalled.push(cb); }

  return {
    initialize, registerApp, unregisterApp, launchApp, updateApp,
    getApp, getAllApps, getAppsByCategory, checkPermissions,
    onInstall, onUninstall, getStats,
  };
})();

// FIX [R1]: expose as a true global so AppPermissionManager, system-events,
// and any other file can reference window.AppRegistry directly.
window.AppRegistry = AppRegistry;

// Auto-initialize
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppRegistry.initialize());
  } else {
    AppRegistry.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppRegistry;