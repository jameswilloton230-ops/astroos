/**
 * NovaByte — Built-in App Permissions Bootstrap
 * ─────────────────────────────────────────────────────────────
 * Preserves permission bootstrap for any remaining legacy built-ins. Trusted
 * first-party .novaapp system apps do not declare per-app permissions; the
 * separate third-party/web-app gate below remains enabled.
 *
 * How it works:
 *  1. Defines the canonical permission map for every built-in app,
 *     split into NORMAL (auto-grant, no prompt) and DANGEROUS (prompt).
 *  2. On first boot: silently pre-grants all NORMAL permissions for
 *     all built-in apps. Stores the marker in the registry
 *     (HKND/_migration/permsBootstrapped via RegistrySystemState; legacy
 *     nova_perms_bootstrapped key kept in step) so this only
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

  // ── Legacy built-in permission tier definitions ─────────────────────────
  // Trusted system .novaapp packages run in the host tier and use no permission
  // list. This map intentionally stays empty; third-party/web-app gating below
  // still requests the relevant grants and is not changed.
  const APP_PERMISSION_MAP = Object.freeze({});

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _log(msg)  { console.log('[PermBootstrap] ' + msg); }
  function _warn(msg) { console.warn('[PermBootstrap] ' + msg); }

  // Every other entry in APP_PERMISSION_MAP is safe to auto-grant purely
  // by id, because the map itself is hardcoded source — there's no install
  // step that could put something untrusted under one of those keys. The
  // entries listed here are the exception: ids that now resolve to an
  // installed .novaapp package rather than guaranteed first-party source.
  // For those, matching the map key is not sufficient on its own — the
  // live installed record has to independently pass the same identity
  // check UnrestrictedGate/isTrustedTransparentSystemApp use, or the
  // grant is refused. Add an id here whenever a former built-in moves to
  // the .novaapp pipeline; never remove the signature check afterward.
  const SIGNATURE_REQUIRED_APPS = new Set([
    'com.nbosp.settings',
    'com.nbosp.email',
    'com.nbosp.browser',
    'com.nbosp.service.system-webview',
  ]);

  // Looks up the live installed app record for signature-required ids,
  // mirroring the exact fields UnrestrictedGate checks — verified/signer/
  // manifest.system — rather than trusting the map key by itself. Returns
  // true for any id not in SIGNATURE_REQUIRED_APPS (unchanged behavior for
  // ordinary hardcoded built-ins).
  function _passesSignatureCheck(appId) {
    if (!SIGNATURE_REQUIRED_APPS.has(appId)) return true;

    let app = null;
    try {
      if (typeof AppRegistry !== 'undefined' && AppRegistry?.getApp) {
        app = AppRegistry.getApp(appId);
      }
    } catch (_) { /* fall through to fail-closed below */ }

    if (!app) {
      _warn(`Signature-required app "${appId}" not found in registry — refusing auto-grant`);
      return false;
    }

    const ok = app.verified === true &&
      app.signer === 'NovaByte System' &&
      app.manifest?.system === true;

    if (!ok) {
      _warn(`Signature-required app "${appId}" failed verification — refusing auto-grant (verified=${app.verified}, signer=${app.signer})`);
    }
    return ok;
  }

  async function _autoGrant(permission, appId) {
    if (!_passesSignatureCheck(appId)) return;
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
    try {
      // Registry-backed marker (HKND/_migration/permsBootstrapped via
      // RegistrySystemState); the legacy key stays in step as the shadow.
      if (typeof RegistrySystemState !== 'undefined' && typeof window !== 'undefined' && window.NovaRegistry) {
        RegistrySystemState.markPermsBootstrapped();
      } else {
        localStorage.setItem(BOOTSTRAP_KEY, '1');
      }
    } catch { /* sandboxed */ }
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

    // Do not enforce filesystem permissions by guessing from the focused window.
    // System writes can run while an app is focused, so that check blamed
    // unrelated apps; sandbox filesystem requests use their explicit app id.

    // First boot: pre-grant normal permissions silently. The marker is
    // registry-backed (HKND/_migration/permsBootstrapped); the legacy key is
    // the adoption source and the fallback when no engine is up.
    let isFirstBoot = false;
    try {
      if (typeof RegistrySystemState !== 'undefined' && typeof window !== 'undefined' && window.NovaRegistry) {
        isFirstBoot = !RegistrySystemState.permsBootstrapped();
      } else {
        isFirstBoot = localStorage.getItem(BOOTSTRAP_KEY) !== '1';
      }
    } catch { /* sandboxed */ }

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


  // ── Third-party / web app permission gating ─────────────────────────────────
  //
  // Web apps (id: wa_...) and any app not in APP_PERMISSION_MAP get a default
  // dangerous permission set. We intercept their init the same way as built-ins.

  const WEB_APP_DANGEROUS = ['device:camera', 'device:microphone', 'device:geolocation'];

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
        await mgr.autoGrantLowRisk?.('net:external', appId);
        await mgr.autoGrantLowRisk?.('net:websocket', appId);
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
            await mgr.autoGrantLowRisk?.('net:external', appId);
            await mgr.autoGrantLowRisk?.('net:websocket', appId);
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