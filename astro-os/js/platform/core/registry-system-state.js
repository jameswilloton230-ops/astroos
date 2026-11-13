/**
 * AstroOS — Registry System State
 *
 * The registry-backed home for the machine-scoped configuration that used to
 * live in ad-hoc localStorage keys inside platform services. This completes
 * the config-database story for everything the system itself owns: what is
 * installed, which permissions were granted, which background alarms and push
 * subscriptions exist, and how often the Store checks for updates.
 *
 *   HKNS/apps/installed                    — installed .novaapp metadata  (REG_JSON [])
 *   HKNS/security/appPermissions           — permission grant records     (REG_JSON [])
 *   HKNS/apps/alarms                       — background alarm registry    (REG_JSON)
 *   HKNS/apps/push                         — push tokens + replay queues  (REG_JSON)
 *   HKNS/apps/pushDeviceId                 — stable push device id        (REG_SZ)
 *   HKNS/apps/store/updateIntervalMinutes  — Store update check interval  (REG_DWORD)
 *   HKNS/apps/store/lastNotifiedAt         — per-app update-notified map  (REG_JSON)
 *   HKNS/apps/webapps                      — installed web-app payload    (REG_JSON)
 *   HKNS/apps/builtin                      — built-in app registry cache  (REG_JSON [])
 *   HKNS/apps/share/inbound                — share-target handoff queue   (REG_JSON)
 *   HKNS/security/meta/lastSweep           — last unused-permission sweep (REG_QWORD)
 *   HKND/_migration/permsBootstrapped      — one-time permission seed mark (REG_QWORD)
 *
 * Every accessor reads and writes the AstroOS Registry when it is up and
 * silently falls back to the legacy localStorage channel when it is not —
 * callers get one API and never parse localStorage themselves again. The
 * first successful access adopts the legacy localStorage values into their
 * live paths exactly once (guarded by HKND/_migration/sysStateDone, with a
 * per-path absent check so an existing hive value is never clobbered), so an
 * upgrading install keeps every setting without a migration step.
 *
 * UMD: window.RegistrySystemState in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  const MIGRATION_GUARD = 'HKND/_migration/sysStateDone';

  const PATHS = Object.freeze({
    installedApps: 'HKNS/apps/installed',
    appPermissions: 'HKNS/security/appPermissions',
    alarms: 'HKNS/apps/alarms',
    push: 'HKNS/apps/push',
    pushDeviceId: 'HKNS/apps/pushDeviceId',
    storeUpdateInterval: 'HKNS/apps/store/updateIntervalMinutes',
    storeNotified: 'HKNS/apps/store/lastNotifiedAt',
    webApps: 'HKNS/apps/webapps',
    builtinMeta: 'HKNS/apps/builtin',
    shareInbound: 'HKNS/apps/share/inbound',
    permLastSweep: 'HKNS/security/meta/lastSweep',
    permsBootstrapped: 'HKND/_migration/permsBootstrapped',
  });

  // The pre-registry localStorage keys, kept for one-time adoption and as
  // the fail-soft fallback when the registry engine is unavailable.
  const LEGACY_KEYS = Object.freeze({
    installedApps: 'nova_installed_apps',
    appPermissions: 'nova_app_permissions',
    alarms: 'nova_app_alarms',
    push: 'nova_app_push',
    pushDeviceId: 'nova_push_device_id',
    storeUpdateInterval: 'nova_store_update_interval_minutes',
    storeNotified: 'nova_store_update_notified',
    webApps: 'nova_web_apps',
    builtinMeta: 'nova_registry_meta',
    shareInbound: 'nova_share_inbound',
    permLastSweep: 'nova_perm_last_sweep',
    permsBootstrapped: 'nova_perms_bootstrapped',
  });

  function reg() {
    if (typeof window === 'undefined' || !window) return null;
    const r = window.NovaRegistry;
    return r && typeof r.get === 'function' ? r : null;
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* quota / private mode */ }
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(lsGet(key) || 'null');
      return parsed ?? fallback;
    } catch (_) { return fallback; }
  }

  function readNumber(key, fallback) {
    const raw = lsGet(key);
    if (raw === null || raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  let adopted = false;

  // One-time import of the legacy localStorage state into their live
  // registry paths. Idempotent; double-guarded by the in-session flag and
  // the HKND/_migration/sysStateDone value. A path that already exists in
  // the hive is never clobbered by its stale localStorage shadow.
  function ensureAdopted() {
    const r = reg();
    if (!r) return false;
    if (adopted) return true;
    try {
      if (r.stat(MIGRATION_GUARD) !== null) { adopted = true; return true; }
      const legacy = {
        [PATHS.installedApps]: readJson(LEGACY_KEYS.installedApps, null),
        [PATHS.appPermissions]: readJson(LEGACY_KEYS.appPermissions, null),
        [PATHS.alarms]: readJson(LEGACY_KEYS.alarms, null),
        [PATHS.push]: readJson(LEGACY_KEYS.push, null),
        [PATHS.pushDeviceId]: lsGet(LEGACY_KEYS.pushDeviceId),
        [PATHS.storeUpdateInterval]: readJson(LEGACY_KEYS.storeUpdateInterval, null),
        [PATHS.storeNotified]: readJson(LEGACY_KEYS.storeNotified, null),
        [PATHS.webApps]: readJson(LEGACY_KEYS.webApps, null),
        [PATHS.builtinMeta]: readJson(LEGACY_KEYS.builtinMeta, null),
        [PATHS.shareInbound]: readJson(LEGACY_KEYS.shareInbound, null),
        [PATHS.permLastSweep]: readNumber(LEGACY_KEYS.permLastSweep, null),
        [PATHS.permsBootstrapped]: lsGet(LEGACY_KEYS.permsBootstrapped) === '1' ? Date.now() : null,
      };
      r.batch(() => {
        for (const [path, value] of Object.entries(legacy)) {
          if (value === null || value === undefined) continue;
          if (r.stat(path) !== null) continue;
          const type = path === PATHS.storeUpdateInterval
            ? 'REG_DWORD'
            : path === PATHS.pushDeviceId ? 'REG_SZ'
            : (path === PATHS.permLastSweep || path === PATHS.permsBootstrapped) ? 'REG_QWORD'
            : 'REG_JSON';
          r.set(path, value, { type, source: 'sysstate-import' });
        }
        r.set(MIGRATION_GUARD, Date.now(), { type: 'REG_QWORD', source: 'sysstate-import' });
      });
      adopted = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function readState(path, legacyFallback) {
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(path);
        if (value !== undefined) return value;
      } catch (_) { /* fall through to legacy */ }
      return typeof legacyFallback === 'function' ? legacyFallback() : legacyFallback;
    }
    return typeof legacyFallback === 'function' ? legacyFallback() : legacyFallback;
  }

  function writeState(path, type, value, legacyKey, legacyRaw) {
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(path, value, { type, source: 'sysstate' });
        return true;
      } catch (_) { /* fall through to legacy */ }
    }
    if (legacyKey) {
      lsSet(legacyKey, legacyRaw !== undefined ? legacyRaw : JSON.stringify(value));
    }
    return false;
  }

  // ── Installed apps (.novaapp metadata lists) ────────────────────────────
  // Windows parity: the Uninstall inventory. `nova-app-package-store.js` is
  // the canonical reader/writer; a few surfaces read it directly.
  //
  // Two lists behind one flat API. Bundled system packages are machine facts
  // (reconciled at boot, before anyone signs in) and stay in HKNS. Whatever a
  // person installs belongs to that account and lives in its mounted HKNU, so
  // an install by one user never shows up for another. Callers keep reading
  // and writing a single list; the split happens here.

  const USER_INSTALLED_PATH = 'HKNU/apps/installed';

  function multiUserOn() {
    return typeof NovaUserScope !== 'undefined' && !!NovaUserScope?.enabled?.();
  }

  // The account whose hives are mounted right now; '' at the login picker or
  // when multi-user is off. Asks the registry instead of NovaUserScope because
  // the stored active uid survives a page reload and the mounted hives don't.
  function scopedUid() {
    if (!multiUserOn()) return '';
    try { return String(reg()?.mountedUserUid?.() || ''); } catch (_) { return ''; }
  }

  function isMachineApp(app) {
    return !!app && (app.system === true || app.builtin === true || app.source === 'system-bundle');
  }

  function asList(value) {
    return Array.isArray(value) ? value : [];
  }

  function machineInstalled() {
    return asList(readState(PATHS.installedApps, () => readJson(LEGACY_KEYS.installedApps, [])));
  }

  function installedApps() {
    const machine = machineInstalled();
    if (!multiUserOn()) return machine;

    const system = machine.filter(isMachineApp);
    const uid = scopedUid();
    if (!uid) return system;

    let own;
    try { own = reg().get(USER_INSTALLED_PATH); } catch (_) { own = undefined; }
    if (Array.isArray(own)) return [...system, ...own];

    // First read for this account. A machine upgraded from single-user still
    // holds the owner's apps in the machine list, so the legacy owner adopts
    // them. Nobody else inherits anything.
    const adopted = uid === NovaUserScope.legacyOwnerUid()
      ? machine.filter(app => !isMachineApp(app))
      : [];
    return [...system, ...adopted];
  }

  function setInstalledApps(list) {
    if (!Array.isArray(list)) return false;
    if (!multiUserOn()) {
      return writeState(PATHS.installedApps, 'REG_JSON', list, LEGACY_KEYS.installedApps);
    }

    // Multi-user with the registry down means no account is mounted
    // (scopedUid() is ''), so only system packages are read or saved and
    // nobody's installs leak into the shared localStorage copy.
    const uid = scopedUid();
    const isLegacyOwner = !!uid && uid === NovaUserScope.legacyOwnerUid();

    // Own list first: if it fails we must not purge the machine copy below.
    if (uid) {
      try {
        reg().set(USER_INSTALLED_PATH, list.filter(app => !isMachineApp(app)), { type: 'REG_JSON', source: 'sysstate' });
      } catch (_) {
        return false;
      }
    }

    // Non-system apps still sitting in the machine list are the legacy
    // owner's, waiting to be adopted. Only the owner's own write may clear
    // them; anyone else's write (or a pre-login boot write) must keep them.
    const unadopted = isLegacyOwner ? [] : machineInstalled().filter(app => !isMachineApp(app));
    return writeState(PATHS.installedApps, 'REG_JSON', [...list.filter(isMachineApp), ...unadopted], LEGACY_KEYS.installedApps);
  }

  // ── Permission grants (AppPermissionManager records) ────────────────────

  // ── Per-user permission grants (multi-user) ──────────────────────────
  // App permission grants are per-account: an app's camera/geolocation/
  // calendar/contacts consents move from the machine hive to the mounted
  // HKNU, so each account consents for itself. Machine-level app facts
  // (installed, alarms) stay in HKNS. The 3.0.2→accounts migration copies
  // the legacy machine grants into the owner's HKNU hive, so upgraded
  // machines keep every consent.
  function appPermissionsPath() {
    const scoped = typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.();
    return scoped ? 'HKNU/security/appPermissions' : PATHS.appPermissions;
  }

  function appPermissions() {
    const value = readState(appPermissionsPath(), () => readJson(LEGACY_KEYS.appPermissions, []));
    return Array.isArray(value) ? value : [];
  }

  function setAppPermissions(grants) {
    if (!Array.isArray(grants)) return false;
    return writeState(appPermissionsPath(), 'REG_JSON', grants, LEGACY_KEYS.appPermissions);
  }

  // ── Background alarm registry (app-sandbox nova:alarm:*) ────────────────

  function alarms() {
    const value = readState(PATHS.alarms, () => readJson(LEGACY_KEYS.alarms, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setAlarms(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return writeState(PATHS.alarms, 'REG_JSON', state, LEGACY_KEYS.alarms);
  }

  // ── Push subscriptions (app-sandbox nova:push:*) ────────────────────────

  function push() {
    const value = readState(PATHS.push, () => readJson(LEGACY_KEYS.push, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setPush(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return writeState(PATHS.push, 'REG_JSON', state, LEGACY_KEYS.push);
  }

  function pushDeviceId() {
    const value = readState(PATHS.pushDeviceId, () => lsGet(LEGACY_KEYS.pushDeviceId));
    return typeof value === 'string' && value ? value : null;
  }

  function setPushDeviceId(id) {
    if (typeof id !== 'string' || !id) return false;
    // Legacy channel stored the bare id, not JSON.
    return writeState(PATHS.pushDeviceId, 'REG_SZ', id, LEGACY_KEYS.pushDeviceId, id);
  }

  // ── Store update check interval ─────────────────────────────────────────

  function storeUpdateInterval() {
    const value = readState(PATHS.storeUpdateInterval, () => readJson(LEGACY_KEYS.storeUpdateInterval, null));
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function setStoreUpdateInterval(minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return false;
    // Legacy channel stored the bare number, not JSON.
    return writeState(PATHS.storeUpdateInterval, 'REG_DWORD', minutes, LEGACY_KEYS.storeUpdateInterval, String(minutes));
  }

  // ── Store update-notified map (appId -> version) ────────────────────────

  function storeNotified() {
    const value = readState(PATHS.storeNotified, () => readJson(LEGACY_KEYS.storeNotified, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setStoreNotified(map) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
    return writeState(PATHS.storeNotified, 'REG_JSON', map, LEGACY_KEYS.storeNotified);
  }

  // ── Web apps (web-app-manager payload { version, apps }) ───────────────

  // Web-app shortcuts are personal: in multi-user mode each account keeps its
  // own payload in its HKNU. The legacy owner of an upgraded machine adopts
  // the old machine-wide payload once; nobody else inherits it. With no
  // account mounted there is nothing to read or save.
  const USER_WEBAPPS_PATH = 'HKNU/apps/webapps';

  function asPayload(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function webApps() {
    const machine = asPayload(readState(PATHS.webApps, () => readJson(LEGACY_KEYS.webApps, null)));
    if (!multiUserOn()) return machine;

    const uid = scopedUid();
    if (!uid) return null;

    let own;
    try { own = reg().get(USER_WEBAPPS_PATH); } catch (_) { own = undefined; }
    if (asPayload(own)) return own;
    return uid === NovaUserScope.legacyOwnerUid() ? machine : null;
  }

  function setWebApps(payload) {
    if (!asPayload(payload)) return false;
    if (!multiUserOn()) return writeState(PATHS.webApps, 'REG_JSON', payload, LEGACY_KEYS.webApps);

    if (!scopedUid()) return true; // nothing mounted: drop it rather than write the shared copy
    try {
      reg().set(USER_WEBAPPS_PATH, payload, { type: 'REG_JSON', source: 'sysstate' });
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Built-in app registry cache (app-registry records) ─────────────────

  function builtinMeta() {
    const value = readState(PATHS.builtinMeta, () => readJson(LEGACY_KEYS.builtinMeta, null));
    return Array.isArray(value) ? value : null;
  }

  function setBuiltinMeta(list) {
    if (!Array.isArray(list)) return false;
    return writeState(PATHS.builtinMeta, 'REG_JSON', list, LEGACY_KEYS.builtinMeta);
  }

  // ── Share-target inbound handoff queue (app-sandbox) ───────────────────

  function shareInbound() {
    const value = readState(PATHS.shareInbound, () => readJson(LEGACY_KEYS.shareInbound, null));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setShareInbound(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    return writeState(PATHS.shareInbound, 'REG_JSON', state, LEGACY_KEYS.shareInbound);
  }

  // ── Permission sweep bookkeeping + one-time bootstrap marker ───────────

  function permLastSweep() {
    const value = readState(PATHS.permLastSweep, () => readNumber(LEGACY_KEYS.permLastSweep, 0));
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  function setPermLastSweep(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    return writeState(PATHS.permLastSweep, 'REG_QWORD', ts, LEGACY_KEYS.permLastSweep, String(ts));
  }

  function permsBootstrapped() {
    const value = readState(PATHS.permsBootstrapped, () => null);
    if (value !== null && value !== undefined) return true;
    return lsGet(LEGACY_KEYS.permsBootstrapped) === '1';
  }

  function markPermsBootstrapped() {
    const ok = writeState(PATHS.permsBootstrapped, 'REG_QWORD', Date.now(), LEGACY_KEYS.permsBootstrapped, '1');
    // The legacy key is a shadow, not a fallback-only channel: the bootstrap
    // must be recognised even when only one stratum survived.
    lsSet(LEGACY_KEYS.permsBootstrapped, '1');
    return ok;
  }

  const api = {
    PATHS,
    LEGACY_KEYS,
    installedApps,
    setInstalledApps,
    isMachineApp,
    scopedUid,
    multiUserOn,
    appPermissions,
    setAppPermissions,
    alarms,
    setAlarms,
    push,
    setPush,
    pushDeviceId,
    setPushDeviceId,
    storeUpdateInterval,
    setStoreUpdateInterval,
    storeNotified,
    setStoreNotified,
    webApps,
    setWebApps,
    builtinMeta,
    setBuiltinMeta,
    shareInbound,
    setShareInbound,
    permLastSweep,
    setPermLastSweep,
    permsBootstrapped,
    markPermsBootstrapped,
    ensureAdopted,
    // Test hook: forget the in-session adoption flag between suites.
    _internal: { resetAdopted() { adopted = false; } },
  };

  if (typeof window !== 'undefined' && window) window.RegistrySystemState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
