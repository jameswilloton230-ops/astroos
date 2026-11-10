/**
 * NovaByte — Registry Prefs
 *
 * The registry-backed home for OS platform preferences that used to live in
 * ad-hoc localStorage keys. Every accessor reads and writes the NovaByte
 * Registry when it is up and silently falls back to the legacy localStorage
 * channel when it is not — callers get one API and never parse localStorage
 * themselves again.
 *
 *   HKNU/apps/disabled            — app ids the user disabled  (REG_JSON [])
 *   HKNU/apps/boot                — auto-start apps            (REG_JSON [])
 *   HKNU/apps/showHidden          — App Manager "show hidden"  (REG_BOOL)
 *   HKNU/shell/shortcuts          — custom keyboard shortcuts  (REG_JSON)
 *   HKNU/shell/notifications/*    — channels + user overrides +
 *                                   queued notification action taps (REG_JSON)
 *   HKND/overlay/position         — debug overlay position     (REG_JSON)
 *
 * The first successful access adopts the legacy localStorage values into
 * their live paths exactly once (guarded by HKND/_migration/prefsDone), so
 * an upgrading install keeps every pref without a migration step.
 *
 * UMD: window.RegistryPrefs in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  const MIGRATION_GUARD = 'HKND/_migration/prefsDone';

  const PATHS = Object.freeze({
    disabledApps: 'HKNU/apps/disabled',
    bootApps: 'HKNU/apps/boot',
    showHiddenApps: 'HKNU/apps/showHidden',
    shortcuts: 'HKNU/shell/shortcuts',
    notifChannels: 'HKNU/shell/notifications/channels',
    notifChannelOverrides: 'HKNU/shell/notifications/channelOverrides',
    notifPendingActions: 'HKNU/shell/notifications/pendingActions',
    overlayPosition: 'HKND/overlay/position',
  });

  // The pre-registry localStorage keys, kept for one-time adoption and as
  // the fail-soft fallback when the registry engine is unavailable.
  const LEGACY_KEYS = Object.freeze({
    disabledApps: 'nova_disabled_apps',
    bootApps: 'nova_boot_apps',
    showHiddenApps: 'nova_show_hidden_apps',
    shortcuts: 'novabyte-shortcuts',
    notifChannels: 'novaOS_notifChannels',
    notifChannelOverrides: 'novaOS_notifChannelOverrides',
    notifPendingActions: 'novaOS_notifPendingActions',
    overlayPosition: 'debug_overlay_pos',
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

  let adopted = false;

  // One-time import of the legacy localStorage prefs into their live
  // registry paths. Idempotent; double-guarded by the in-session flag and
  // the HKND/_migration/prefsDone value.
  function ensureAdopted() {
    const r = reg();
    if (!r) return false;
    if (adopted) return true;
    try {
      if (r.stat(MIGRATION_GUARD) !== null) { adopted = true; return true; }
      const legacy = {
        [PATHS.disabledApps]: readJson(LEGACY_KEYS.disabledApps, null),
        [PATHS.bootApps]: readJson(LEGACY_KEYS.bootApps, null),
        [PATHS.showHiddenApps]: lsGet(LEGACY_KEYS.showHiddenApps) === null
          ? null
          : lsGet(LEGACY_KEYS.showHiddenApps) === '1',
        [PATHS.shortcuts]: readJson(LEGACY_KEYS.shortcuts, null),
        [PATHS.notifChannels]: readJson(LEGACY_KEYS.notifChannels, null),
        [PATHS.notifChannelOverrides]: readJson(LEGACY_KEYS.notifChannelOverrides, null),
        [PATHS.notifPendingActions]: readJson(LEGACY_KEYS.notifPendingActions, null),
        [PATHS.overlayPosition]: readJson(LEGACY_KEYS.overlayPosition, null),
      };
      r.batch(() => {
        for (const [path, value] of Object.entries(legacy)) {
          if (value === null || value === undefined) continue;
          if (r.stat(path) !== null) continue;
          const type = typeof value === 'boolean' ? 'REG_BOOL' : 'REG_JSON';
          r.set(path, value, { type, source: 'prefs-import' });
        }
        r.set(MIGRATION_GUARD, Date.now(), { type: 'REG_QWORD', source: 'prefs-import' });
      });
      adopted = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  function readPref(path, type, legacyFallback) {
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

  function writePref(path, type, value, legacyKey, legacyValue) {
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(path, value, { type, source: 'prefs' });
        return true;
      } catch (_) { /* fall through to legacy */ }
    }
    if (legacyKey) lsSet(legacyKey, JSON.stringify(legacyValue === undefined ? value : legacyValue));
    return false;
  }

  // ── Disabled apps ───────────────────────────────────────────────────────
  // Entries may be plain ids or { id, reason, ts } objects (both shapes
  // exist in the wild — init.js writes diagnostics objects). Reads
  // normalize to id strings; writes preserve the caller's entry shape.

  function normalizeDisabled(list) {
    if (!Array.isArray(list)) return [];
    return list.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.id : null))
      .filter((x) => typeof x === 'string' && x);
  }

  function sanitizeDisabled(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' || (x && typeof x === 'object' && typeof x.id === 'string'));
  }

  function disabledApps() {
    return normalizeDisabled(readPref(PATHS.disabledApps, 'REG_JSON', () =>
      normalizeDisabled(readJson(LEGACY_KEYS.disabledApps, []))));
  }

  function setDisabledApps(list) {
    const clean = sanitizeDisabled(list);
    return writePref(PATHS.disabledApps, 'REG_JSON', clean, LEGACY_KEYS.disabledApps, clean);
  }

  function isAppDisabled(appId) {
    if (!appId) return false;
    return disabledApps().includes(appId);
  }

  // ── Boot apps ───────────────────────────────────────────────────────────

  function bootApps() {
    const list = readPref(PATHS.bootApps, 'REG_JSON', () => readJson(LEGACY_KEYS.bootApps, []));
    return Array.isArray(list) ? list : [];
  }

  function setBootApps(list) {
    const clean = Array.isArray(list) ? list : [];
    return writePref(PATHS.bootApps, 'REG_JSON', clean, LEGACY_KEYS.bootApps, clean);
  }

  // ── Show hidden apps (App Manager toggle) ───────────────────────────────
  // The legacy keys stored '1'/'0' strings, and the historical default fell
  // back to the even older nova_show_system_apps key — both preserved.

  function showHiddenApps() {
    return readPref(PATHS.showHiddenApps, 'REG_BOOL', () => {
      const raw = lsGet(LEGACY_KEYS.showHiddenApps);
      if (raw === '1') return true;
      if (raw === '0') return false;
      return lsGet('nova_show_system_apps') === '1';
    }) === true;
  }

  function setShowHiddenApps(value) {
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(PATHS.showHiddenApps, value === true, { type: 'REG_BOOL', source: 'prefs' });
        return true;
      } catch (_) { /* fall through to legacy */ }
    }
    lsSet(LEGACY_KEYS.showHiddenApps, value === true ? '1' : '0');
    return false;
  }

  // ── Custom keyboard shortcuts ───────────────────────────────────────────

  function shortcuts() {
    const value = readPref(PATHS.shortcuts, 'REG_JSON', () => readJson(LEGACY_KEYS.shortcuts, {}));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function setShortcuts(map) {
    const clean = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    return writePref(PATHS.shortcuts, 'REG_JSON', clean, LEGACY_KEYS.shortcuts, clean);
  }

  // ── Notification channels + user overrides ──────────────────────────────

  function notifChannels() {
    const value = readPref(PATHS.notifChannels, 'REG_JSON', () => readJson(LEGACY_KEYS.notifChannels, {}));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function setNotifChannels(map) {
    return writePref(PATHS.notifChannels, 'REG_JSON', map || {}, LEGACY_KEYS.notifChannels, map || {});
  }

  function notifChannelOverrides() {
    const value = readPref(PATHS.notifChannelOverrides, 'REG_JSON', () => readJson(LEGACY_KEYS.notifChannelOverrides, {}));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function setNotifChannelOverrides(map) {
    return writePref(PATHS.notifChannelOverrides, 'REG_JSON', map || {}, LEGACY_KEYS.notifChannelOverrides, map || {});
  }

  // ── Pending notification action taps ──────────────────────────────────
  // Queued when the user taps a notification action and drained by the
  // target app on its next launch — machine bookkeeping that must survive
  // a shell reload, so it rides the same hive area as channels/overrides.

  function notifPendingActions() {
    const value = readPref(PATHS.notifPendingActions, 'REG_JSON', () =>
      readJson(LEGACY_KEYS.notifPendingActions, []));
    return Array.isArray(value) ? value : [];
  }

  function setNotifPendingActions(list) {
    const clean = Array.isArray(list) ? list : [];
    return writePref(PATHS.notifPendingActions, 'REG_JSON', clean, LEGACY_KEYS.notifPendingActions, clean);
  }

  // ── Debug overlay position (HKND — developer scratch hive) ─────────────

  function overlayPosition() {
    const value = readPref(PATHS.overlayPosition, 'REG_JSON', () => readJson(LEGACY_KEYS.overlayPosition, null));
    return value && typeof value.x === 'number' && typeof value.y === 'number' ? value : null;
  }

  function setOverlayPosition(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return false;
    // True when the position landed in the registry; false = legacy channel.
    return writePref(PATHS.overlayPosition, 'REG_JSON', { x, y }, LEGACY_KEYS.overlayPosition, { x, y });
  }

  const api = {
    PATHS,
    LEGACY_KEYS,
    disabledApps,
    setDisabledApps,
    isAppDisabled,
    bootApps,
    setBootApps,
    showHiddenApps,
    setShowHiddenApps,
    shortcuts,
    setShortcuts,
    notifChannels,
    setNotifChannels,
    notifChannelOverrides,
    setNotifChannelOverrides,
    notifPendingActions,
    setNotifPendingActions,
    overlayPosition,
    setOverlayPosition,
    ensureAdopted,
    // Test hook: forget the in-session adoption flag between suites.
    _internal: { resetAdopted() { adopted = false; } },
  };

  if (typeof window !== 'undefined' && window) window.RegistryPrefs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
