/**
 * AstroOS — Registry Boot State
 *
 * The registry-backed home for machine boot and recovery state — the flags
 * the boot sequence, the pre-boot recovery guard, and the Settings recovery
 * button all coordinate through. Windows keeps the same class of machine
 * state under HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot; here it lives
 * under:
 *
 *   HKNS/system/boot/safeMode           — boot into safe mode next time (REG_DWORD)
 *   HKNS/system/boot/forceRecovery      — watchdog: boot failed, force recovery (REG_DWORD)
 *   HKNS/system/boot/manualRecovery     — user asked for the recovery env (REG_DWORD)
 *   HKNS/system/boot/showRecovery       — show the recovery menu next boot (REG_DWORD)
 *   HKNS/system/boot/attempts           — recent boot attempt records (REG_JSON [])
 *   HKNS/system/boot/timeoutFlag        — watchdog bookkeeping doc       (REG_JSON)
 *   HKNS/system/boot/homeLaunchPending  — Home app launch handoff id    (REG_SZ)
 *
 * Two storage strata, on purpose:
 *  1. The AstroOS Registry is the source of truth from boot() step one
 *     onward — the engine is initialised before the watchdog, so every
 *     read/write here hits the hive.
 *  2. localStorage stays as (a) the fail-soft fallback when the registry
 *     engine is unavailable and (b) the handoff channel to the pre-boot
 *     guard in init.js, which deliberately runs before any core script can
 *     be trusted — it cannot depend on the registry being healthy, because
 *     a broken registry is exactly what recovery is for.
 *
 * Therefore flag writes go to BOTH strata (registry first, then the legacy
 * key), and clears remove from BOTH. The first successful registry access
 * adopts the legacy values into their live paths exactly once (guarded by
 * HKND/_migration/bootFlags, with a per-path absent check so an existing
 * hive value is never clobbered).
 *
 * UMD: window.RegistryBootState in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  const MIGRATION_GUARD = 'HKND/_migration/bootFlags';

  const PATHS = Object.freeze({
    safeMode:          'HKNS/system/boot/safeMode',
    forceRecovery:     'HKNS/system/boot/forceRecovery',
    manualRecovery:    'HKNS/system/boot/manualRecovery',
    showRecovery:      'HKNS/system/boot/showRecovery',
    attempts:          'HKNS/system/boot/attempts',
    timeoutFlag:       'HKNS/system/boot/timeoutFlag',
    homeLaunchPending: 'HKNS/system/boot/homeLaunchPending',
  });

  // The pre-registry localStorage keys — one-time adoption source, fail-soft
  // fallback, and the handoff channel init.js reads before boot() runs.
  const LEGACY_KEYS = Object.freeze({
    safeMode:          'nova_safe_mode',
    forceRecovery:     'nova_force_recovery',
    manualRecovery:    'nova_manual_recovery',
    showRecovery:      'nova_show_recovery',
    attempts:          'nova_boot_attempts',
    timeoutFlag:       'nova_boot_timeout_flag',
    homeLaunchPending: 'nova_home_launch_pending',
  });

  const FLAGS = Object.freeze(['safeMode', 'forceRecovery', 'manualRecovery', 'showRecovery']);

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

  function lsRemove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* ignore */ }
  }

  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(lsGet(key) || 'null');
      return parsed ?? fallback;
    } catch (_) { return fallback; }
  }

  let adopted = false;

  // One-time import of the legacy boot flags into their live registry paths.
  // Idempotent; double-guarded by the in-session flag and the migration
  // guard value. A path that already exists in the hive is never clobbered
  // by its stale localStorage shadow.
  function ensureAdopted() {
    const r = reg();
    if (!r) return false;
    if (adopted) return true;
    try {
      if (r.stat(MIGRATION_GUARD) !== null) { adopted = true; return true; }
      r.batch(() => {
        for (const name of FLAGS) {
          const raw = lsGet(LEGACY_KEYS[name]);
          if (raw !== '1') continue;
          const path = PATHS[name];
          if (r.stat(path) !== null) continue;
          r.set(path, 1, { type: 'REG_DWORD', source: 'bootstate-import' });
        }
        const attempts = readJson(LEGACY_KEYS.attempts, null);
        if (attempts !== null && r.stat(PATHS.attempts) === null) {
          r.set(PATHS.attempts, attempts, { type: 'REG_JSON', source: 'bootstate-import' });
        }
        const timeout = readJson(LEGACY_KEYS.timeoutFlag, null);
        if (timeout !== null && r.stat(PATHS.timeoutFlag) === null) {
          r.set(PATHS.timeoutFlag, timeout, { type: 'REG_JSON', source: 'bootstate-import' });
        }
        const pending = lsGet(LEGACY_KEYS.homeLaunchPending);
        if (pending !== null && r.stat(PATHS.homeLaunchPending) === null) {
          r.set(PATHS.homeLaunchPending, pending, { type: 'REG_SZ', source: 'bootstate-import' });
        }
        r.set(MIGRATION_GUARD, Date.now(), { type: 'REG_QWORD', source: 'bootstate-import' });
      });
      adopted = true;
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── DWORD flags ─────────────────────────────────────────────────────────

  function flag(name) {
    if (!FLAGS.includes(name)) return false;
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(PATHS[name]);
        if (value !== undefined) return value === 1 || value === true;
      } catch (_) { /* fall through to legacy */ }
    }
    return lsGet(LEGACY_KEYS[name]) === '1';
  }

  function setFlag(name, on) {
    if (!FLAGS.includes(name)) return false;
    const r = reg();
    let hiveOk = false;
    if (r) {
      try {
        ensureAdopted();
        r.set(PATHS[name], on ? 1 : 0, { type: 'REG_DWORD', source: 'bootstate' });
        hiveOk = true;
      } catch (_) { /* fall through to legacy only */ }
    }
    // The legacy shadow feeds init.js's pre-boot recovery guard; keep it in
    // step even when the hive write succeeded.
    if (on) lsSet(LEGACY_KEYS[name], '1'); else lsRemove(LEGACY_KEYS[name]);
    return hiveOk;
  }

  function clearFlag(name) {
    if (!FLAGS.includes(name) && name !== 'attempts' && name !== 'timeoutFlag' && name !== 'homeLaunchPending') return false;
    return clearFlags(name);
  }

  function clearFlags(...names) {
    const r = reg();
    let hiveOk = false;
    if (r) {
      try {
        ensureAdopted();
        r.batch(() => {
          for (const name of names) {
            if (PATHS[name] === undefined) continue;
            try { r.delete(PATHS[name]); } catch (_) { /* already gone */ }
          }
        });
        hiveOk = true;
      } catch (_) { hiveOk = false; }
    }
    for (const name of names) lsRemove(LEGACY_KEYS[name]);
    return hiveOk;
  }

  // ── Boot attempt records (REG_JSON []) ──────────────────────────────────

  function attempts() {
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(PATHS.attempts);
        if (value !== undefined) return Array.isArray(value) ? value : [];
      } catch (_) { /* fall through to legacy */ }
    }
    const legacy = readJson(LEGACY_KEYS.attempts, []);
    return Array.isArray(legacy) ? legacy : [];
  }

  function setAttempts(list) {
    if (!Array.isArray(list)) return false;
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(PATHS.attempts, list, { type: 'REG_JSON', source: 'bootstate' });
      } catch (_) { /* fall through to legacy only */ }
    }
    lsSet(LEGACY_KEYS.attempts, JSON.stringify(list));
    return !!r;
  }

  // ── Watchdog bookkeeping doc (REG_JSON) ─────────────────────────────────

  function timeoutFlag() {
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(PATHS.timeoutFlag);
        if (value !== undefined) return value && typeof value === 'object' ? value : null;
      } catch (_) { /* fall through to legacy */ }
    }
    const legacy = readJson(LEGACY_KEYS.timeoutFlag, null);
    return legacy && typeof legacy === 'object' ? legacy : null;
  }

  function setTimeoutFlag(doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(PATHS.timeoutFlag, doc, { type: 'REG_JSON', source: 'bootstate' });
      } catch (_) { /* fall through to legacy only */ }
    }
    lsSet(LEGACY_KEYS.timeoutFlag, JSON.stringify(doc));
    return !!r;
  }

  // ── Home app launch handoff (REG_SZ) ────────────────────────────────────

  function homeLaunchPending() {
    const r = reg();
    if (r && ensureAdopted()) {
      try {
        const value = r.get(PATHS.homeLaunchPending);
        if (value !== undefined) return typeof value === 'string' && value ? value : null;
      } catch (_) { /* fall through to legacy */ }
    }
    const legacy = lsGet(LEGACY_KEYS.homeLaunchPending);
    return typeof legacy === 'string' && legacy ? legacy : null;
  }

  function setHomeLaunchPending(appId) {
    if (typeof appId !== 'string' || !appId) return false;
    const r = reg();
    if (r) {
      try {
        ensureAdopted();
        r.set(PATHS.homeLaunchPending, appId, { type: 'REG_SZ', source: 'bootstate' });
      } catch (_) { /* fall through to legacy only */ }
    }
    lsSet(LEGACY_KEYS.homeLaunchPending, appId);
    return !!r;
  }

  function clearHomeLaunchPending() {
    return clearFlags('homeLaunchPending');
  }

  const api = {
    PATHS,
    LEGACY_KEYS,
    FLAGS,
    flag,
    setFlag,
    clearFlag,
    clearFlags,
    attempts,
    setAttempts,
    timeoutFlag,
    setTimeoutFlag,
    homeLaunchPending,
    setHomeLaunchPending,
    clearHomeLaunchPending,
    ensureAdopted,
    // Test hook: forget the in-session adoption flag between suites.
    _internal: { resetAdopted() { adopted = false; } },
  };

  if (typeof window !== 'undefined' && window) window.RegistryBootState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
