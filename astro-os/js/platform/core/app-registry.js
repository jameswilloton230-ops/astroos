/**
 * AstroOS — App Registry
 * ─────────────────────────────────────────────────────────────
 * Manages installed applications, registration with OS.apps,
 * and app lifecycle (install, uninstall, update).
 *
 * Fixes applied vs previous version:
 *  [R1] window.AppRegistry — exported as a true global so every
 *       other file (AppPermissionManager, system-events, etc.) can
 *       reference it without import gymnastics.
 *  [R2] launchApp — requests missing required sensitive permissions while
 *       allowing the app to open if the user denies a capability.
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
  const systemServices = new Map();
  const _onInstalled   = [];
  const _onUninstalled = [];

  const KNOWN_PERMISSIONS = new Set([
    'fs:access', 'fs:metadata', 'fs:watch', 'fs:read:images', 'fs:read:video', 'fs:read:audio',
    'apps:communicate',
    'clipboard:read', 'clipboard:write',
    'data:export', 'data:backup', 'secrets:store',
    'net:internal', 'net:external', 'net:websocket',
    'mail:read', 'mail:write', 'mail:send', 'mail:delete',
    'calendar:read', 'calendar:write', 'calendar:delete',
    'contacts:read', 'contacts:write', 'contacts:delete',
    'device:notifications', 'device:geolocation', 'device:camera', 'device:microphone',
    'system:info', 'system:settings', 'system:apps', 'system:app-launch', 'system:events', 'system:root',
    'system:badge', 'system:schedule', 'system:share-target',
    'system:background', 'system:background:live', 'system:autostart',
    'push:receive',
    'registry.read', 'registry.write', 'registry.system',
    'sandbox:nested-webview', 'sandbox:same-origin', 'sandbox:escape-popups',
    'admin:apps', 'admin:users', 'admin:system', 'admin:audit',
  ]);

  // Legacy permission names from the pre-fs ("vfs") era. Old .novaapp
  // manifests still declare these, and the unknown-permission strip below
  // used to silently remove them — leaving old apps permanently
  // under-granted with no diagnostic beyond a console warning. Known legacy
  // names are translated to their fs-era equivalents BEFORE that strip, so
  // an old manifest registers with exactly the grants a modern manifest
  // would carry. Mapping rationale:
  //   vfs:metadata → fs:metadata   exact successor (same label, same risk).
  //   vfs:access / vfs:read / vfs:write / vfs:delete → fs:access
  //     The scoped-storage model collapsed the old broad filesystem verbs
  //     into the single special-access grant: there is no generic fs:read /
  //     fs:write / fs:delete permission anymore. fs:access is critical-risk
  //     AND specialAccess — requestPermission() refuses to prompt for it and
  //     the prompt queue skips it — so translating into it can never widen
  //     an old app's access silently; the user must explicitly enable
  //     "Manage all files" for that app in Settings (the toggle lives in the
  //     per-app permissions panel), the same user-mediated grant path a
  //     modern app declaring fs:access gets. Shared-tree calls old apps make
  //     without that toggle keep the modern handler behavior: app-owned
  //     paths need no grant at all, shared paths ask via picker/confirmation
  //     flows exactly as they do for a modern app.
  // The companion half of this compat layer (legacy nova:vfs:* / vfs:* IPC
  // channel aliases) lives in app-sandbox.js (LEGACY_VFS_CHANNEL_ALIASES).
  const LEGACY_PERMISSION_ALIASES = Object.freeze({
    'vfs:access': 'fs:access',
    'vfs:read': 'fs:access',
    'vfs:write': 'fs:access',
    'vfs:delete': 'fs:access',
    'vfs:metadata': 'fs:metadata',
  });

  // Translate a permission list's legacy vfs:* names to their fs:*
  // equivalents. Lists without any legacy name are returned untouched (same
  // array reference), so modern manifests are not deduped or reordered as a
  // side effect; legacy lists are deduped, since e.g. vfs:read + vfs:write
  // both collapse onto fs:access.
  function translateLegacyPermissions(perms) {
    if (!Array.isArray(perms)) return perms;
    if (!perms.some(p => Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, p))) return perms;
    return [...new Set(perms.map(p =>
      Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, p)
        ? LEGACY_PERMISSION_ALIASES[p]
        : p))];
  }

  const RESERVED_APP_IDS = new Set([
    'app-manager', 'browser', 'calculator', 'calendar-app', 'files', 'quill', 'shell', 'terminal', 'textedit', 'vault',
    'astroos-contacts', 'astroos-downloads', 'astroos-gallery', 'astroos-music', 'astroos-search',
    'com.astroos.appmanager', 'com.astroos.browser', 'com.astroos.calculator', 'com.astroos.calendar',
    'com.astroos.clock', 'com.astroos.contacts', 'com.astroos.downloads', 'com.astroos.email',
    'com.astroos.files', 'com.astroos.gallery', 'com.astroos.music', 'com.astroos.quill', 'com.astroos.search',
    'com.astroos.settings', 'com.astroos.shell', 'com.astroos.terminal', 'com.astroos.textedit', 'com.astroos.vault',
    'com.astroos.devconsole',
    'com.astroos.events',
    'com.astroos.inspector',
    'com.astroos.modules',
    'com.astroos.novareg',
    'com.astroos.packages',
    'com.astroos.perf',
    'com.astroos.permissions',
    'com.astroos.sysaccess',
    'com.astroos.service.background-apps',
    'com.astroos.service.calendar-notifier',
    'com.astroos.service.default-apps',
    'com.astroos.service.event-log',
    'com.astroos.service.notifications',
    'com.astroos.service.registry',
    'com.astroos.service.scanner',
    'com.astroos.service.server-events-bridge',
    'com.astroos.service.system-dialogs',
    'com.astroos.service.system-events',
  ]);

  // ── Storage ────────────────────────────────────────────────────────────────

  function _saveToStorage() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      // Registry-first (HKNS/apps/builtin via RegistrySystemState); the
      // localStorage key is the adoption source and the fail-soft fallback.
      if (typeof window !== 'undefined' && window.NovaRegistry && typeof RegistrySystemState !== 'undefined') {
        try { if (RegistrySystemState.setBuiltinMeta([...installedApps.values()])) return; }
        catch (e) { console.warn('[AppRegistry] registry save failed; using localStorage:', e); }
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...installedApps.values()]));
    } catch (e) {
      if (e.name !== 'SecurityError') {
        console.error('[AppRegistry] save failed:', e);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'error', message: `Registry save failed: ${e?.message || e}` });
        }
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function initialize() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) {
        console.warn('[AppRegistry] localStorage unavailable — in-memory only');
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: 'localStorage unavailable — running in-memory only' });
        }
        return;
      }
      // Registry-first hydration (HKNS/apps/builtin); the legacy key is the
      // adoption source and the fail-soft fallback.
      let raw = null;
      if (typeof window !== 'undefined' && window.NovaRegistry && typeof RegistrySystemState !== 'undefined') {
        try {
          const list = RegistrySystemState.builtinMeta();
          if (list) raw = JSON.stringify(list);
        } catch (e) { /* fall through to localStorage */ }
      }
      if (raw === null) raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const apps = JSON.parse(raw);
      for (const app of apps) {
        if (app.manifest?.permissions?.includes('system:root')
          && !app.permissions?.includes('system:root')) {
          app.permissions = [...(Array.isArray(app.permissions) ? app.permissions : []), 'system:root'];
        }
        // Re-sanitize on restore too — closes the gap for records persisted
        // by a pre-patch version of this file, where a .novaapp install
        // could have had autoGrant: true written to storage before this
        // source-based check existed. See registerApp() for the full
        // rationale; kept in sync with the same rule (source === 'local').
        if ((app.source || 'local') !== 'local' && app.autoGrant) {
          app.autoGrant = false;
        }
        const restoredSystem = app.verified === true &&
          app.signer === 'Astro System' &&
          app.manifest?.system === true;
        app.system = restoredSystem;
        installedApps.set(app.id, app);
        if (typeof OS !== 'undefined' && OS?.apps) {
          // Always rebuild from the persisted record, even if a static
          // OS.apps[app.id] already exists — otherwise a restored install
          // that shares an id with a pre-registered app can never win here,
          // and (see below) never reaches APP_REGISTRY either.
          OS.apps[app.id] = {
            id: app.id, name: app.name, icon: app.icon, description: app.description,
            defaultSize: app.defaultSize || [800, 600], minSize: app.minSize || [400, 300],
            maxSize: app.maxSize ?? null,
            resizable: app.resizable !== false, frame: app.frame !== false,
            alwaysOnTop: app.alwaysOnTop || false, fullscreenable: app.fullscreenable !== false,
            startMinimized: app.startMinimized || false, transparent: app.transparent || false,
            devOnly: app.devOnly || false,
            autoGrant: app.autoGrant || false,
            source: app.source || 'local',
            verified: app.verified === true,
            signer: app.signer || null,
            revoked: app.revoked === true,
            tampered: app.tampered === true,
            system: app.system === true,
            signature: app.signature || null,
            signing: app.signing || null,
            integrity: app.integrity || null,
            novabyte_app: app.novabyte_app,
            compiled_at: app.compiled_at,
            manifest: app.manifest || undefined,
            // See the matching comment in registerApp() below — same field,
            // same reason, needed here too since this is a second, separate
            // rebuild of OS.apps[app.id] (this one runs on every boot/reload
            // for restored installs, registerApp() only runs once at install
            // time), and it was dropping handles the exact same way.
            handles: app.handles ?? app.manifest?.handles ?? undefined,
            init: (content, state, options) => AppRegistry.launchApp(app.id, content, state, options),
            onDrop: app.onDrop ?? undefined,
            onClose: app.onClose ?? undefined,
          };
          // registerApp() (js/apps/registry/service.js) is the only thing
          // that writes into APP_REGISTRY, which is what the launchpad and
          // taskbar actually iterate — see the comment in registerApp() in
          // this file. initialize() rebuilt OS.apps by hand above and never
          // called it, so every restored app vanished from APP_REGISTRY on
          // reload even though OS.apps (and thus direct launches) was fine.
          // This is almost certainly the "old UI comes back after refresh"
          // bug: the render layer was reading a registry that boot never
          // repopulated.
          if (typeof window !== 'undefined' && typeof window.registerApp === 'function') {
            window.registerApp(OS.apps[app.id]);
          }
        }
      }
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
      console.log(`[AppRegistry] Loaded ${installedApps.size} app(s)`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Loaded ${installedApps.size} app(s) from storage`, data: { count: installedApps.size } });
      }
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppRegistry] localStorage denied (sandboxed) — in-memory only');
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: 'localStorage denied (sandboxed) — running in-memory only' });
        }
      } else {
        console.error('[AppRegistry] initialize failed:', e);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'error', message: `Initialize failed: ${e?.message || e}` });
        }
      }
      installedApps = new Map();
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  function registerApp(appConfig, options = {}) {
    if (!appConfig?.id || !appConfig?.name) throw new Error('[AppRegistry] App must have id and name');
    if (systemServices.has(appConfig.id)) {
      throw new Error('[AppRegistry] Registration denied — id "' + appConfig.id + '" is reserved for a system service.');
    }

    if (installedApps.has(appConfig.id) && !options.force) {
      return installedApps.get(appConfig.id);
    }
    if (options.force && installedApps.get(appConfig.id)?.permissions?.includes('system:root')
      && typeof AppSandbox !== 'undefined') {
      AppSandbox.reloadAfterRootRevocation?.(`Root app ${appConfig.id} was updated`);
    }

    if (RESERVED_APP_IDS.has(appConfig.id) && !appConfig.verified) {
      throw new Error('[AppRegistry] Registration denied — id "' + appConfig.id + '" is reserved for system apps. Verify the app signature to proceed.');
    }

    // Legacy vfs-era permission names are translated to their fs-era
    // equivalents before the unknown-permission strip below, so old
    // manifests register with the same grants a modern manifest would
    // carry instead of being silently under-granted (see
    // LEGACY_PERMISSION_ALIASES above). The translation is logged so an
    // audit trail shows exactly what an old manifest was normalized to.
    const legacyPerms = [...(appConfig.permissions || []), ...(appConfig.optionalPermissions || [])]
      .filter(p => Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, p));
    if (legacyPerms.length > 0) {
      const mapped = [...new Set(legacyPerms.map(p => `${p} → ${LEGACY_PERMISSION_ALIASES[p]}`))];
      console.warn('[AppRegistry] Translated legacy permission(s) for', appConfig.id + ':', mapped.join(', '));
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Translated legacy permission(s) for ${appConfig.id}: ${mapped.join(', ')}`, data: { appId: appConfig.id, legacy: legacyPerms } });
      }
    }
    // Only assign back when an array was actually present — assigning
    // `permissions: undefined` onto appConfig would override the default
    // `[]` fill in the app object below via the spread.
    if (Array.isArray(appConfig.permissions)) {
      appConfig.permissions = translateLegacyPermissions(appConfig.permissions);
    }
    if (Array.isArray(appConfig.optionalPermissions)) {
      appConfig.optionalPermissions = translateLegacyPermissions(appConfig.optionalPermissions);
    }

    const allPerms = [...(appConfig.permissions || []), ...(appConfig.optionalPermissions || [])];
    const unknown = allPerms.filter(p => !KNOWN_PERMISSIONS.has(p));
    if (unknown.length > 0) {
      console.warn('[AppRegistry] Rejecting unknown permission(s) for', appConfig.id + ':', unknown.join(', '));
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Rejected unknown permission(s) for ${appConfig.id}: ${unknown.join(', ')}`, data: { appId: appConfig.id, unknown } });
      }
      appConfig.permissions = (appConfig.permissions || []).filter(p => KNOWN_PERMISSIONS.has(p));
      appConfig.optionalPermissions = (appConfig.optionalPermissions || []).filter(p => KNOWN_PERMISSIONS.has(p));
    }

    // Manifest-declared per-permission reasons ("permissionReasons") get the
    // same treatment the permission arrays just got: legacy vfs:* keys are
    // translated (two legacy names can map onto one fs:* target — first
    // non-empty value wins), keys the OS doesn't know are stripped, and
    // values that wouldn't survive display (non-strings, whitespace-only,
    // over the dialog's length cap) are dropped. The cap is enforced by
    // truncation rather than rejection because this code also runs for
    // built-in registrations that never went through package validation —
    // for packaged installs, validateManifest already ERRORS on oversized
    // reasons, so an author sees and fixes them before shipping.
    // Reasons for known permissions the app didn't declare are KEPT (the
    // display path is gated by actual prompts, so they're inert) but logged
    // — validateManifest flags them as a non-fatal warning for the author.
    // The cleaned map lands on the app record via the appConfig spread, so
    // AppPermissionManager.resolvePermissionReason() can pick it up at
    // prompt time via AppRegistry.getApp(id).permissionReasons.
    if (appConfig.permissionReasons !== undefined) {
      const rawReasons = appConfig.permissionReasons;
      if (!rawReasons || typeof rawReasons !== 'object' || Array.isArray(rawReasons)) {
        console.warn('[AppRegistry] Ignoring invalid permissionReasons for', appConfig.id, '(must be an object)');
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Ignored invalid permissionReasons for ${appConfig.id} (must be an object)`, data: { appId: appConfig.id } });
        }
        delete appConfig.permissionReasons;
      } else {
        const REASON_DISPLAY_CAP = 500;
        const translated = {};
        for (const [key, value] of Object.entries(rawReasons)) {
          const mappedKey = Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, key)
            ? LEGACY_PERMISSION_ALIASES[key]
            : key;
          if (translated[mappedKey] === undefined || translated[mappedKey] === null) {
            translated[mappedKey] = value;
          }
        }
        const cleanedReasons = {};
        const rejectedReasons = [];
        for (const [key, value] of Object.entries(translated)) {
          if (!KNOWN_PERMISSIONS.has(key)) {
            rejectedReasons.push(`${key} (unknown permission)`);
            continue;
          }
          if (typeof value !== 'string' || !value.trim()) {
            rejectedReasons.push(`${key} (reason is not a non-empty string)`);
            continue;
          }
          const trimmed = value.trim();
          if (trimmed.length > REASON_DISPLAY_CAP) {
            rejectedReasons.push(`${key} (reason truncated to ${REASON_DISPLAY_CAP} characters)`);
          }
          cleanedReasons[key] = trimmed.length > REASON_DISPLAY_CAP ? trimmed.slice(0, REASON_DISPLAY_CAP) : trimmed;
        }
        const undeclaredReasons = Object.keys(cleanedReasons)
          .filter(p => !(appConfig.permissions || []).includes(p) && !(appConfig.optionalPermissions || []).includes(p));
        if (rejectedReasons.length > 0 || undeclaredReasons.length > 0) {
          const detail = [...rejectedReasons, ...undeclaredReasons.map(p => `${p} (not declared in permissions)`)].join(', ');
          console.warn('[AppRegistry] Normalized permissionReasons for', appConfig.id + ':', detail);
          if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Normalized permissionReasons for ${appConfig.id}: ${detail}`, data: { appId: appConfig.id, rejected: rejectedReasons, undeclared: undeclaredReasons } });
          }
        }
        if (Object.keys(cleanedReasons).length > 0) {
          appConfig.permissionReasons = cleanedReasons;
        } else {
          delete appConfig.permissionReasons;
        }
      }
    }

    // autoGrant silently skips the permission-request prompt entirely (see
    // launchApp() below) — it exists for first-party dev tools that are
    // hardcoded into the JS bundle (console, packages, permissions, etc.),
    // none of which go through a package install path. Every real .novaapp
    // install — whether via the Packages app, App Manager's manual install,
    // or the nova:app:install IPC handler in app-sandbox.js — sets `source`
    // to something other than the 'local' default used by built-ins. Any
    // manifest arriving through one of those paths is untrusted, so strip
    // autoGrant from it here regardless of what the manifest itself claims:
    // otherwise a package author could just declare autoGrant: true and
    // self-grant sandbox:same-origin (or any other permission) with zero
    // user prompt. This is enforced here, once, rather than at each of the
    // several install call sites, so it can't be missed by a new one later.
    const claimedSource = appConfig.source || 'local';
    const isBuiltinSource = claimedSource === 'local';
    if (!isBuiltinSource && appConfig.autoGrant) {
      console.warn('[AppRegistry] Ignoring autoGrant on non-builtin app', appConfig.id, '(source:', claimedSource + ')');
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Ignored autoGrant on non-builtin app ${appConfig.id} (source: ${claimedSource})`, data: { appId: appConfig.id, source: claimedSource } });
      }
    }

    // `system` is authoritative only when it is declared in the signed
    // manifest and the package is verified by the dedicated AstroOS
    // System signing key (a separate, more tightly held key from the
    // general trusted-signing one — see trust-store.js).
    // Never trust a caller-supplied appConfig.system by itself.
    const isSystemSigned = appConfig.verified === true &&
      appConfig.signer === 'Astro System' &&
      appConfig.manifest?.system === true;

    const app = {
      icon: '/assets/no_app_icon.svg', description: '', version: '1.0.0', author: 'Unknown',
      type: 'webapp', entry: 'index.html', permissions: [], optionalPermissions: [],
      defaultSize: [800, 600], minSize: [400, 300], maxSize: null,
      resizable: true, frame: true, sandbox: { allowSameOrigin: false, allowScripts: true, allowForms: true, allowPopups: false },
      categories: ['other'], installedDate: new Date().toISOString(),
      lastLaunched: null, launchCount: 0, source: 'local', signature: null, verified: false,
      ...appConfig,
      id: appConfig.id,
      name: appConfig.name,
      handles: appConfig.handles ?? appConfig.manifest?.handles ?? undefined,
      autoGrant: isBuiltinSource ? (appConfig.autoGrant || false) : false,
      system: isSystemSigned,
    };

    if (typeof OS !== 'undefined' && OS?.apps) {
      OS.apps[app.id] = {
        id: app.id, name: app.name, icon: app.icon, description: app.description,
        defaultSize: app.defaultSize, minSize: app.minSize, maxSize: app.maxSize ?? null,
        resizable: app.resizable !== false, frame: app.frame !== false,
        alwaysOnTop: app.alwaysOnTop || false, fullscreenable: app.fullscreenable !== false,
        startMinimized: app.startMinimized || false, transparent: app.transparent || false,
        devOnly: appConfig.devOnly || false,
        autoGrant: app.autoGrant,
        source: app.source || 'local',
        verified: app.verified === true,
        signer: app.signer || null,
        revoked: app.revoked === true,
        tampered: app.tampered === true,
        system: app.system === true || isSystemSigned,
        signature: app.signature || null,
        signing: app.signing || null,
        integrity: app.integrity || null,
        novabyte_app: app.novabyte_app,
        compiled_at: app.compiled_at,
        manifest: app.manifest || undefined,
        allowNestedWebview: app.allowNestedWebview === true
          || app.manifest?.allowNestedWebview === true,
        // Capability manifest (js/apps/default-apps/service.js reads this
        // to offer the app as a Default Apps candidate for any matching
        // protocol/extension). Optional — omitted rather than defaulted to
        // {} so DefaultApps' `if (!handles) continue` check works as
        // intended for apps that don't declare one.
        handles: app.handles ?? undefined,
        init: (content, state, options) => AppRegistry.launchApp(app.id, content, state, options),
        onDrop: appConfig.onDrop ?? undefined,
        onClose: appConfig.onClose ?? undefined,
      };
    }

    installedApps.set(app.id, app);
    _saveToStorage();
    console.log(`[AppRegistry] Registered: ${app.name} (${app.id}) v${app.version}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Registered ${app.name} (${app.id}) v${app.version}`, data: { appId: app.id, version: app.version, verified: app.verified } });
    }

    // AppRegistry.registerApp() only ever touched installedApps + OS.apps.
    // The launchpad (and taskbar) render from the separate APP_REGISTRY
    // array maintained by the global window.registerApp() in registry.js —
    // installs never reached it, so a package could report success and
    // still never show up anywhere in the UI. Route through the same
    // global registrar here so both registries stay in sync, same as
    // every statically-loaded app already does on boot.
    if (typeof window !== 'undefined' && typeof window.registerApp === 'function' && OS?.apps?.[app.id]) {
      window.registerApp(OS.apps[app.id]);
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
    }

    for (const cb of _onInstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return app;
  }

  function registerSystemService(service) {
    if (!service?.id || !service?.name ||
        service.system !== true || service.verified !== true ||
        service.signer !== 'Astro System' ||
        service.manifest?.system !== true || service.manifest?.systemService !== true) {
      throw new Error('[AppRegistry] System service registration requires a verified Astro System package.');
    }
    if (installedApps.has(service.id)) {
      throw new Error('[AppRegistry] System service id is already registered as an app: ' + service.id);
    }

    const registered = Object.freeze({
      ...service,
      categories: ['system-service'],
      systemService: true,
      headlessSystemService: true,
    });
    systemServices.set(registered.id, registered);
    return registered;
  }

  function unregisterSystemService(serviceId) {
    return systemServices.delete(serviceId);
  }

  function unregisterApp(appId) {
    const app = installedApps.get(appId);
    if (!app) return false;
    if (app.permissions?.includes('system:root') && typeof AppSandbox !== 'undefined') {
      AppSandbox.reloadAfterRootRevocation?.(`Root app ${appId} was uninstalled`);
    }

    // Every uninstall surface (App Manager, desktop right-click,
    // MyAppsManager) funnels through here — close any window still open
    // for this app before its registry entry, files, and permissions are
    // deleted out from under it. forceKill: true so a system:background:live
    // grant can't turn this into an orphaned webview that outlives the
    // registry entry being deleted below.
    if (typeof WM !== 'undefined' && WM.closeWindow && typeof OS !== 'undefined' && OS.windows) {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === appId) openWindowIds.push(wid);
      }
      for (const wid of openWindowIds) WM.closeWindow(wid, { forceKill: true });
    }

    // An app can also be alive in the background with no open window at
    // all (its window was closed in an earlier moment of this session,
    // and its sandbox has been sitting in #background-app-host ever
    // since) — the loop above wouldn't touch that, since it only looks at
    // OS.windows. Catch that case directly so uninstalling a backgrounded
    // app actually stops its process instead of leaving it running with
    // no registry entry, files, or permissions left to justify it.
    if (typeof AppSandbox !== 'undefined' && AppSandbox.getAllSandboxes) {
      for (const sandbox of AppSandbox.getAllSandboxes()) {
        if (sandbox.appId === appId && sandbox.backgrounded) {
          AppSandbox.terminateBackground(sandbox.sandboxId);
          if (typeof Notify !== 'undefined' && Notify.unpin) Notify.unpin(`pin_bg_${appId}`);
        }
      }
    }

    if (typeof OS !== 'undefined' && OS?.apps) delete OS.apps[appId];
    installedApps.delete(appId);
    _saveToStorage();
    console.log(`[AppRegistry] Unregistered: ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Unregistered ${appId}`, data: { appId } });
    }

    // Mirror the registerApp() sync above — remove the stale entry from
    // APP_REGISTRY too, or an uninstalled app keeps showing in the launchpad.
    if (typeof window !== 'undefined' && Array.isArray(window.APP_REGISTRY)) {
      const idx = window.APP_REGISTRY.findIndex(a => a.id === appId);
      if (idx !== -1) window.APP_REGISTRY.splice(idx, 1);
      if (typeof renderLaunchpad === 'function') renderLaunchpad();
    }

    for (const cb of _onUninstalled) { try { cb(app); } catch { /* ignore hook errors */ } }
    return true;
  }

  async function uninstallApp(appId, options = {}) {
    const app = installedApps.get(appId);
    if (!app) return false;
    if (app.system === true && options.force !== true) {
      throw new Error(`System app ${appId} cannot be uninstalled`);
    }
    if (typeof window.NovaAppPackageStore?.removeApp === 'function') {
      const removed = await window.NovaAppPackageStore.removeApp(app, {
        force: options.force === true,
      });
      if (!removed) throw new Error(`Package storage refused to remove ${appId}`);
    }
    return unregisterApp(appId);
  }

  // ── Launch ─────────────────────────────────────────────────────────────────

  /**
   * Launch an app.
   * FIX [R2]: missing required permissions now trigger the sequential
   * permission-request queue rather than throwing immediately.
   */
  async function launchApp(appId, content, state, options) {
    try {
      // Registry-backed (HKNU/apps/disabled) via RegistryPrefs.
      const disabled = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : [];
      if (disabled.some(x => (typeof x === 'string' ? x : x?.id) === appId)) {
        console.warn('[AppRegistry] Launch blocked — disabled app:', appId);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Launch blocked — ${appId} is disabled`, data: { appId } });
        }
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

    if (!OS.settings.get('devMode') && app.devOnly) return null;

    // Low-risk capabilities are granted by system policy; optional sensitive
    // capabilities remain point-of-use requests, while required sensitive
    // capabilities use the launch consent queue.
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const requiredPermissions = app.permissions || [];
    const optionalPermissions = app.optionalPermissions || [];
    const declaredPermissions = [...new Set([...requiredPermissions, ...optionalPermissions])];
    const requestsRoot = requiredPermissions.includes('system:root');
    const rootModeAvailable = requestsRoot
      && OS.settings.get('devMode') === true
      && OS.settings.get('rootAccessEnabled') === true;
    if (mgr && declaredPermissions.length > 0) {
      if (app.autoGrant) {
        const missing = requiredPermissions.filter(p =>
          p !== 'system:root'
          && !mgr.PERMISSION_CATEGORIES?.[p]?.specialAccess
          && !mgr.isGranted(p, appId)
        );
        for (const p of missing) {
          await mgr.grantPermission(p, appId, { permanent: true, reason: 'Auto-granted for developer tool', grantedBy: 'system' });
        }
        if (requestsRoot && rootModeAvailable && !mgr.isGranted('system:root', appId)) {
          await mgr.requestPermission('system:root', appId, { appName: app.name });
        }
      } else {
        for (const permission of declaredPermissions) {
          await mgr.autoGrantLowRisk?.(permission, appId);
        }

        const requiredSensitive = requiredPermissions.filter(permission =>
          mgr.PERMISSION_CATEGORIES?.[permission]?.risk !== 'low'
          && !mgr.PERMISSION_CATEGORIES?.[permission]?.specialAccess
          && (permission !== 'system:root' || rootModeAvailable)
        );
        const missing = requiredSensitive.filter(permission =>
          !mgr.isGranted(permission, appId)
          && !(mgr.isDenied && mgr.isDenied(permission, appId))
        );
        if (missing.length > 0) {
          await mgr.requestAll(missing, appId, app.name);
        }

        // Denials disable the corresponding capability, not the whole app.
        // Keep the missing required permissions available for diagnostics.
        app.__deniedPermissionsAtLaunch = requiredPermissions.filter(
          permission => !mgr.isGranted(permission, appId)
        );
        if (requestsRoot && !rootModeAvailable && typeof EventLog !== 'undefined') {
          EventLog.log({
            app: 'AppRegistry',
            category: 'security',
            severity: 'warn',
            message: `Root execution blocked for ${appId}: Developer Mode and Root Access must both be enabled`,
            data: { appId, permission: 'system:root', action: 'root-blocked' },
          });
        }
        if (app.__deniedPermissionsAtLaunch.length > 0) {
          console.warn(`[AppRegistry] Launch continuing in restricted mode — permissions denied for ${appId}: ${app.__deniedPermissionsAtLaunch.join(', ')}`);
          if (typeof EventLog !== 'undefined') {
            EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'warn', message: `Launch continuing in restricted mode — permissions denied for ${appId}`, data: { appId, missing: app.__deniedPermissionsAtLaunch } });
          }
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
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppRegistry', category: 'apps', severity: 'info', message: `Launching ${app.name} (${appId})`, data: { appId, launchCount: app.launchCount } });
    }

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

  function getApp(appId)              { return installedApps.get(appId) ?? systemServices.get(appId) ?? null; }
  function isRegistered(appId)        { return installedApps.has(appId) || systemServices.has(appId); }
  function isInstalled(appId)         { return isRegistered(appId); }
  function getAllApps()               { return [...installedApps.values(), ...systemServices.values()]; }
  function getAppsByCategory(cat)    {
    return getAllApps().filter(app => (app.categories || []).includes(cat));
  }

  function getStats() {
    const apps = getAllApps();
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
    initialize, registerApp, registerSystemService, unregisterSystemService,
    unregisterApp, uninstallApp, launchApp, updateApp,
    getApp, isRegistered, isInstalled, getAllApps, getAppsByCategory, checkPermissions,
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