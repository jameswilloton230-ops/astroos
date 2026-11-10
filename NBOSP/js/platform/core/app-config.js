/**
 * NovaByte — App Config (HKNA accessor)
 *
 * The one API built-in apps use to store their own configuration in the
 * NovaByte Registry instead of ad-hoc localStorage keys. Paths resolve to
 * the per-app hive the sandbox already polices for third-party apps:
 *
 *   HKNA/<appId>/<relPath>
 *
 * Every accessor reads and writes the registry when it is up and silently
 * falls back to the legacy localStorage key when it is not. The first
 * successful read adopts the legacy value into the live path exactly once
 * (a per-path guard under HKND/_migration/appConfig, plus a per-path absent
 * check so an existing hive value is never clobbered), so an upgrading
 * install keeps every preference without a migration step.
 *
 * Built-in apps run in the shell context and may call this directly;
 * sandboxed third-party apps keep going through nova:reg:* with their own
 * HKNA/<app-id>/ scope.
 *
 * UMD: window.NovaAppConfig in the shell, module.exports in tests.
 */
(function () {
  'use strict';

  const GUARD_PATH = 'HKND/_migration/appConfig';

  function reg() {
    if (typeof window === 'undefined' || !window) return null;
    const r = window.NovaRegistry;
    return r && typeof r.get === 'function' ? r : null;
  }

  // HKNA paths are `HKNA/<appId>/<relPath>` — the appId becomes a key name,
  // so it must not contain path separators or whitespace-only content.
  function assertAppId(appId) {
    if (typeof appId !== 'string' || appId.trim().length === 0) {
      throw new TypeError('NovaAppConfig: appId must be a non-empty string');
    }
    if (/[/\\\s]/.test(appId)) {
      throw new TypeError(`NovaAppConfig: invalid appId "${appId}" — no separators or whitespace allowed`);
    }
    return appId;
  }

  function assertRelPath(relPath) {
    if (typeof relPath !== 'string' || relPath.trim().length === 0) {
      throw new TypeError('NovaAppConfig: relPath must be a non-empty string');
    }
    const parts = relPath.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '.' || p === '..')) {
      throw new TypeError(`NovaAppConfig: invalid relPath "${relPath}"`);
    }
    return parts.join('/');
  }

  function resolvePath(appId, relPath) {
    return `HKNA/${assertAppId(appId)}/${assertRelPath(relPath)}`;
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* quota / private mode */ }
  }

  function adoptedMap(registry) {
    try {
      const raw = registry.get(GUARD_PATH);
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (_) { return {}; }
  }

  // One-time import of one legacy key into one live path. The guard records
  // the adoption attempt so a later legacy edit never leaks into the hive.
  function adoptLegacy(registry, path, type, legacyKey) {
    const map = adoptedMap(registry);
    if (map[path]) return false;
    map[path] = Date.now();
    try {
      if (registry.stat(path) === null) {
        const raw = lsGet(legacyKey);
        if (raw !== null && raw !== undefined) {
          const value = coerceLegacy(raw, type);
          if (value !== undefined) {
            registry.set(path, value, { type, source: 'appconfig-import' });
          }
        }
      }
      registry.set(GUARD_PATH, map, { type: 'REG_JSON', source: 'appconfig-import' });
    } catch (_) { /* best-effort — the absent-check still prevents clobbering */ }
    return true;
  }

  // Coerce a raw legacy localStorage string to the value shape the REG_*
  // type implies, so pre-migration readers see the same types they wrote.
  function coerceLegacy(raw, type) {
    if (type === 'REG_JSON') {
      try { return JSON.parse(raw); } catch (_) { return undefined; /* corrupt legacy value */ }
    }
    if (type === 'REG_BOOL') {
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      return undefined;
    }
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      const num = Number(raw);
      return Number.isFinite(num) ? num : undefined;
    }
    return raw; // REG_SZ, REG_BINARY — strings
  }

  /**
   * Read `HKNA/<appId>/<relPath>`. Options:
   *   type       — REG_* type for a first-write/adoption (default REG_JSON)
   *   fallback   — returned when neither registry nor legacy key has a value
   *   legacyKey  — localStorage key adopted once + fail-soft fallback
   */
  function get(appId, relPath, options = {}) {
    const path = resolvePath(appId, relPath);
    const { type = 'REG_JSON', fallback, legacyKey } = options;
    const r = reg();
    if (r) {
      try {
        if (legacyKey) adoptLegacy(r, path, type, legacyKey);
        const value = r.get(path);
        if (value !== undefined) return value;
      } catch (_) { /* fall through to legacy */ }
    }
    if (legacyKey) {
      const raw = lsGet(legacyKey);
      if (raw !== null && raw !== undefined) {
        const coerced = coerceLegacy(raw, type);
        if (coerced !== undefined) return coerced;
      }
    }
    return fallback;
  }

  /**
   * Write `HKNA/<appId>/<relPath>`. Options:
   *   type            — REG_* type (default REG_JSON)
   *   legacyKey       — localStorage fallback key when the registry is down
   *   legacyRaw       — exact legacy string to store (default: JSON of value)
   */
  function set(appId, relPath, value, options = {}) {
    const path = resolvePath(appId, relPath);
    const { type = 'REG_JSON', legacyKey, legacyRaw } = options;
    const r = reg();
    if (r) {
      try {
        if (legacyKey) adoptLegacy(r, path, type, legacyKey);
        r.set(path, value, { type, source: 'appconfig' });
        return true;
      } catch (_) { /* fall through to legacy */ }
    }
    if (legacyKey) lsSet(legacyKey, legacyRaw !== undefined ? legacyRaw : JSON.stringify(value));
    return false;
  }

  /** Remove `HKNA/<appId>/<relPath>` (and its legacy shadow when asked). */
  function remove(appId, relPath, options = {}) {
    const path = resolvePath(appId, relPath);
    const { legacyKey } = options;
    let ok = false;
    const r = reg();
    if (r) {
      try { r.remove(path); ok = true; } catch (_) { /* fall through */ }
    }
    if (legacyKey) {
      try { localStorage.removeItem(legacyKey); } catch (_) { /* private mode */ }
      ok = true;
    }
    return ok;
  }

  const api = {
    GUARD_PATH,
    resolvePath,
    get,
    set,
    remove,
    // Test hook: the adoption guard lives in the hive, so resetting it is
    // a registry operation — convenience for suites.
    _internal: {
      resetAdoption(registry) {
        try { registry.remove(GUARD_PATH); } catch (_) { /* absent */ }
      },
    },
  };

  if (typeof window !== 'undefined' && window) window.NovaAppConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
