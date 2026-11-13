/**
 * AstroOS — AstroOS Registry
 *
 * A Windows-Registry-style hierarchical configuration store for the OS.
 * Four hives (plus the HKCU alias):
 *
 *   HKNS — NovaSystem: OS-level config (shell, wallpaper, theme, security
 *          policy). Written by the OS and system apps only.
 *   HKNU — NovaUser: per-user preferences (dock pins, default apps, legacy
 *          imports). Also addressable as HKCU — the parser maps HKCU/* to
 *          HKNU/* exactly the way HKEY_CURRENT_USER names a hive.
 *   HKNA — NovaApps: per-app config, namespaced HKNA/<appId>/....
 *   HKND — NovaDev: developer-mode scratch hive; ignored in normal use.
 *
 * Paths look like 'HKNS/shell/wallpaper' ('\' is accepted as a separator
 * too). Intermediate segments are KEYS; the last segment names a VALUE
 * under its parent key. Like Windows, every key implicitly owns a default
 * (unnamed) value stored under the reserved name '(default)': reading or
 * writing a bare key path (HKNS/shell) addresses that default value. Values
 * are typed:
 *
 *   REG_SZ (string) · REG_EXPAND_SZ (string with %VAR% tokens, expanded on
 *   read against HKNS/env/*) · REG_MULTI_SZ (array of strings) · REG_BOOL ·
 *   REG_DWORD (uint32) · REG_QWORD (non-negative safe integer) · REG_JSON
 *   (plain JSON) · REG_BINARY (base64 string)
 *
 * Keys can additionally be LINKS (Windows REG_LINK / NTFS-junction flavor):
 * a link node carries { link: 'HKNU/...' } and is transparently followed on
 * reads (list/get/stat/export) and same-hive writes; removing the link path
 * removes the link, never the target. Create links with setLink().
 *
 * Every commit is clone-validate-swap (a rejected write can never leave a
 * half-applied hive behind), persisted per hive as one JSON document, and
 * announced on the OS event bus as 'nova:reg:changed'. Hives are quota'd
 * (depth, segment length, value bytes, hive bytes, node count) and a
 * corrupt hive file is quarantined, not fatal. batch() groups mutations into
 * an all-or-nothing transaction across hives; saveSnapshot()/restoreSnapshot()
 * give each hive a small ring of restore points (one is taken automatically
 * at boot). Every mutation is appended to a bounded audit ring (audit()).
 *
 * Security lives in the sandbox handlers (app-sandbox.js) — this engine
 * deliberately has no authority model of its own; unrestricted host code
 * (e.g. the NovaReg editor) and host services call it directly. The engine
 * does carry per-key ACLs (setAcl/getAcl/checkAccess): inheritance-aware
 * read/write grants that the sandbox consults on top of its per-hive rules.
 *
 * @module js/platform/core/nova-registry
 */

const NovaRegistry = (() => {
  'use strict';

  const HIVES = Object.freeze(['HKNS', 'HKNU', 'HKNA', 'HKND']);
  const HIVE_SET = new Set(HIVES);

  // Hive alias — HKCU is to HKNU what HKEY_CURRENT_USER is to a user hive.
  const HIVE_ALIASES = Object.freeze({ HKCU: 'HKNU' });

  // The three per-account hives. HKNS is and stays the machine hive, loaded
  // at boot exactly as today; HKNU/HKNA/HKND become MOUNTED hives — the
  // SessionManager mounts them from a per-account directory at login and
  // flushes them at logout or switch. Mounted documents carry the owner in
  // their storage name (user:<segment>:<HIVE>) and the storage adapter resolves
  // that to the per-account file layout, so every other storage surface of
  // the engine is untouched. Because HKCU was always an alias of HKNU and
  // every existing path string keeps its shape, no app-visible API changes.
  // The segment is the account's USERNAME (usernames allow dots); machines
  // that predate that layout keep their uid-keyed documents byte-for-byte —
  // the login-time layout upgrade moves the directories, not the engine.
  const USER_HIVES = Object.freeze(['HKNU', 'HKNA', 'HKND']);
  const USER_DOC_RE = /^user:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):(HKNU|HKNA|HKND)$/;

  const VALUE_TYPES = Object.freeze([
    'REG_SZ', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BOOL', 'REG_DWORD', 'REG_QWORD', 'REG_JSON', 'REG_BINARY',
  ]);
  const TYPE_SET = new Set(VALUE_TYPES);

  // Reserved value name every key implicitly owns (Windows "(Default)").
  const DEFAULT_VALUE_NAME = '(default)';

  const ACL_RIGHTS = Object.freeze(['read', 'write']);

  const LIMITS = Object.freeze({
    MAX_DEPTH: 16,
    MAX_SEG_LENGTH: 64,
    MAX_NAME_LENGTH: 64,
    MAX_VALUE_BYTES: 256 * 1024,
    MAX_HIVE_BYTES: 2 * 1024 * 1024,
    MAX_NODES_PER_HIVE: 4096,
    HIVE_SCHEMA_VERSION: 1,
    MAX_IMPORT_VALUES: 2048,
    MAX_LINK_HOPS: 4,
    MAX_ACL_ENTRIES: 32,
    MAX_AUDIT_ENTRIES: 500,
    MAX_SNAPSHOTS_PER_HIVE: 3,
  });

  // OS.settings keys that live in the registry. Since the registry became
  // the source of truth for OS configuration (the settings shim in
  // platform/core/settings-shim.js writes OS.settings straight through to
  // these paths and hydrates its cache from them at boot), this table is the
  // canonical key ↔ path schema:
  //
  //   HKNS/shell/*    — machine look & feel seeded at boot (theme, accent,
  //                     wallpaper) — system writers only
  //   HKNS/system/*   — machine state (osVersion, devMode)
  //   HKNS/security/* — credentials and policy (lockPin, pinSalt, dev policy)
  //   HKNU/desktop/*  — per-user shell layout (dock pins)
  //   HKNU/shell/*    — per-user shell prefs (default apps)
  //   HKNU/settings/* — every other per-user preference (settingsPathFor
  //                     files unmapped keys here automatically)
  //
  // customWallpaper is deliberately absent (SETTINGS_EXCLUDED_KEYS): a
  // multi-megabyte data URL would blow the per-value size quota, so it keeps
  // riding the legacy persistence channel.
  const SETTINGS_KEY_TO_PATH = Object.freeze({
    // mapped shell & desktop keys
    theme: 'HKNS/shell/theme',
    accentColor: 'HKNS/shell/accentColor',
    wallpaperId: 'HKNS/shell/wallpaper',
    pinnedApps: 'HKNU/desktop/pins',
    defaultApps: 'HKNU/shell/defaultApps',
    // system (machine-scoped) keys
    osVersion: 'HKNS/system/osVersion',
    devMode: 'HKNS/system/devMode',
    // security keys — the multi-user account redesign removed the client-side
    // credential keys from the settings map: lockPin, pinSalt and
    // biometricCredentialId now live in the server's users.db (scrypt rows
    // and WebAuthn descriptors), and the account record owns identity, so
    // `username` is gone too. The registry paths themselves are not migrated
    // away — the 3.0.2 → accounts migration deletes the legacy key values at
    // import time, and machines that never enable multi-user keep the
    // single-user behaviour byte-for-byte through the generic-area scan.
    bootPassword: 'HKNS/security/bootPassword',
    rootAccessEnabled: 'HKNS/security/rootAccessEnabled',
    prohibitWallpaperChange: 'HKNS/security/policy/prohibitWallpaperChange',
    // per-user preferences
    clockFormat: 'HKNU/settings/clockFormat',
    dateFormat: 'HKNU/settings/dateFormat',
    fontSize: 'HKNU/settings/fontSize',
    taskbarStyle: 'HKNU/settings/taskbarStyle',
    wallpaper: 'HKNU/settings/wallpaper',
    windowRadius: 'HKNU/settings/windowRadius',
    animSpeed: 'HKNU/settings/animSpeed',
    iconSize: 'HKNU/settings/iconSize',
    autoLock: 'HKNU/settings/autoLock',
    searchEngine: 'HKNU/settings/searchEngine',
    proxyUrl: 'HKNU/settings/proxyUrl',
    region: 'HKNU/settings/region',
    keyboardLayout: 'HKNU/settings/keyboardLayout',
    timezone: 'HKNU/settings/timezone',
    highContrast: 'HKNU/settings/highContrast',
    removeTransparency: 'HKNU/settings/removeTransparency',
    reduceMotion: 'HKNU/settings/reduceMotion',
    cursorSize: 'HKNU/settings/cursorSize',
    showTaskbarClock: 'HKNU/settings/showTaskbarClock',
    taskbarSize: 'HKNU/settings/taskbarSize',
    doNotDisturb: 'HKNU/settings/doNotDisturb',
    debugOverlayVisible: 'HKNU/settings/debugOverlayVisible',
    customWallpaperName: 'HKNU/settings/customWallpaperName',
  });
  const SETTINGS_PATH_TO_KEY = Object.freeze(
    Object.fromEntries(Object.entries(SETTINGS_KEY_TO_PATH).map(([key, path]) => [path, key]))
  );

  // Settings keys that never enter the registry (oversized payloads).
  const SETTINGS_EXCLUDED_KEYS = Object.freeze(new Set(['customWallpaper']));

  // Path prefixes that map back to a settings key for the generic
  // HKNU/settings/* / HKNS/{settings,system,security[\/policy]}/* areas.
  // Longest prefixes first: 'HKNS/security/policy/' must win over
  // 'HKNS/security/'.
  const SETTINGS_PATH_PREFIXES = Object.freeze([
    'HKNU/settings/',
    'HKNS/settings/',
    'HKNS/system/',
    'HKNS/security/policy/',
    'HKNS/security/',
  ]);

  // Resolves a settings key to its registry path. Explicitly mapped keys
  // win; excluded keys return null (never stored in the registry); anything
  // else is treated as a per-user preference under HKNU/settings/. Path
  // separators inside the key are flattened so arbitrary runtime keys can
  // never escape the settings area.
  function settingsPathFor(key) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_KEY_TO_PATH, key)) {
      return SETTINGS_KEY_TO_PATH[key];
    }
    if (SETTINGS_EXCLUDED_KEYS.has(key)) return null;
    return 'HKNU/settings/' + String(key).replace(/[\\/]/g, '_');
  }

  // Inverse of settingsPathFor: maps a registry path back to the settings
  // key it drives, or null when the path is not settings-backed. Used by the
  // settings shim to sync external registry writes (NovaReg, reg CLI, app
  // IPC) into OS.settings and re-emit 'settings:changed'.
  function pathToSettingsKey(path) {
    if (Object.prototype.hasOwnProperty.call(SETTINGS_PATH_TO_KEY, path)) {
      return SETTINGS_PATH_TO_KEY[path];
    }
    if (typeof path !== 'string') return null;
    for (const prefix of SETTINGS_PATH_PREFIXES) {
      if (path.startsWith(prefix) && path.length > prefix.length) {
        return path.slice(prefix.length);
      }
    }
    return null;
  }

  // Seed-once defaults (merge-only: an existing value is never clobbered).
  const BOOT_DEFAULTS = Object.freeze({
    'HKNS/shell/theme': ['REG_SZ', 'nova-dark'],
    'HKNS/shell/accentColor': ['REG_SZ', '#58a6ff'],
    'HKNS/shell/wallpaper': ['REG_SZ', 'stock-blue'],
    'HKNS/security/policy/prohibitWallpaperChange': ['REG_BOOL', false],
    'HKNS/env/novaRoot': ['REG_SZ', '~/.config/novabyte'],
    'HKNU/desktop/pins': ['REG_JSON', []],
    'HKNU/shell/defaultApps': ['REG_JSON', {}],
  });

  const DEFAULT_VALUE_NAME_QUOTA_NOTE = 'value data exceeds the per-value size limit';

  let state = null; // { hives, storage, events, logger, mirrorAttached, audit, batchDepth, batchLog }

  function freshState() {
    return { hives: {}, storage: null, events: null, logger: null, mirrorAttached: false, audit: [], batchDepth: 0, batchLog: null, userUid: null, userVolatile: false, userSealed: false };
  }

  function logWarn(...args) {
    try {
      if (state && state.logger && typeof state.logger.warn === 'function') state.logger.warn(...args);
      else if (typeof console !== 'undefined') console.warn('[NovaRegistry]', ...args);
    } catch (_) { /* logging must never throw */ }
  }

  // ── Storage ────────────────────────────────────────────────────────────

  // NW.js/Linux runtime: one JSON file per hive under the OS profile
  // directory (~/.config/novabyte/registry/<HIVE>.json), written atomically
  // (tmp + rename) exactly like kernel.js persists settings.json. Everywhere
  // else (plain web / test runs): localStorage under nova_registry_hive_<HIVE>.
  // Two auxiliary documents ride the same adapter under pseudo-hive names:
  // AUDIT (the write ring) and SNAPSHOTS (per-hive restore points).
  function createDefaultStorage() {
    let native = null;
    try {
      if (typeof process !== 'undefined' && process.versions && process.versions.node &&
          typeof require === 'function') {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const dir = path.join(os.homedir(), '.config', 'novabyte', 'registry');
        // user:<segment>:<HIVE> documents resolve to the account's own registry
        // directory — the mounted-hive file layout. The segment is the
        // username when one is known, else the uid (legacy layouts).
        // Everything else keeps the machine location.
        const fileFor = (name) => {
          const m = USER_DOC_RE.exec(name);
          if (m) return path.join(os.homedir(), '.config', 'novabyte', 'users', m[1], 'registry', `${m[2]}.json`);
          return path.join(dir, `${name}.json`);
        };
        native = {
          file: fileFor,
          read: (name) => fs.readFileSync(fileFor(name), 'utf8'),
          write: (name, json) => {
            fs.mkdirSync(path.dirname(fileFor(name)), { recursive: true, mode: 0o700 });
            const tmp = `${fileFor(name)}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, json, { mode: 0o600 });
            fs.renameSync(tmp, fileFor(name));
          },
          quarantine: (name, raw) => {
            try { fs.writeFileSync(`${fileFor(name)}.corrupt`, String(raw), { mode: 0o600 }); } catch (_) {}
          },
        };
      }
    } catch (_) { native = null; }

    const lsKey = (name) => {
      const m = USER_DOC_RE.exec(name);
      return m ? `nova_registry_hive_u_${m[1]}_${m[2]}` : `nova_registry_hive_${name}`;
    };

    return {
      // Single-document read — mountUserHives loads one account's hive
      // without disturbing the machine documents.
      read(name) {
        if (native) {
          try { return native.read(name); } catch (_) { /* fall through to localStorage */ }
        }
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            return localStorage.getItem(lsKey(name));
          }
        } catch (_) { }
        return null;
      },
      loadAll() {
        const out = {};
        // The four hives decode through decodeHive (quarantine on corruption);
        // the two auxiliary documents (audit ring, snapshot ring) are plain
        // JSON objects — a corrupt one is simply dropped.
        const names = [...HIVES, 'AUDIT', 'SNAPSHOTS'];
        for (const name of names) {
          let raw = null;
          if (native) {
            try { raw = native.read(name); } catch (_) { raw = null; }
          }
          if (raw === null && typeof localStorage !== 'undefined' && localStorage) {
            try { raw = localStorage.getItem(lsKey(name)); } catch (_) { raw = null; }
          }
          if (name === 'AUDIT' || name === 'SNAPSHOTS') {
            if (raw !== null) {
              try {
                const doc = JSON.parse(raw);
                out[name] = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : null;
              } catch (_) { out[name] = null; }
            }
            continue;
          }
          out[name] = decodeHive(name, raw, (r) => {
            if (native) native.quarantine(name, r);
            else {
              try { localStorage.setItem(`${lsKey(name)}.corrupt`, String(r)); } catch (_) {}
            }
          });
        }
        return out;
      },
      save(name, data) {
        const json = JSON.stringify(data);
        if (native) {
          try { native.write(name, json); return true; } catch (err) { logWarn('native save failed', name, err); }
        }
        try {
          if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(lsKey(name), json);
            return true;
          }
        } catch (err) { logWarn('localStorage save failed', name, err); }
        return false;
      },
    };
  }

  function decodeHive(hive, raw, quarantine) {
    if (raw === null || raw === undefined) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      if (typeof data.keys !== 'object' || data.keys === null || Array.isArray(data.keys)) return null;
      if (typeof data.values !== 'object' || data.values === null || Array.isArray(data.values)) return null;
      if (typeof data.hive === 'string' && data.hive !== hive) return null;
      return data;
    } catch (_) {
      try { quarantine(raw); } catch (_) {}
      logWarn(`corrupt ${hive} hive quarantined; starting fresh`);
      return null;
    }
  }

  // ── Errors ─────────────────────────────────────────────────────────────

  function regError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  // ── Path handling ──────────────────────────────────────────────────────

  // Accepts '/' or '\' separators. The hive is case-insensitive (HKCU is an
  // alias for HKNU); segments are case-sensitive, trimmed, non-empty, may
  // not be '.'/'..', are capped at MAX_SEG_LENGTH, and a path is capped at
  // MAX_DEPTH segments.
  function parsePath(path) {
    if (typeof path !== 'string' || !path.trim()) {
      return { error: 'INVALID_ARGS', message: 'path is required' };
    }
    const parts = path.trim().split(/[/\\]+/);
    let hive = parts[0].toUpperCase();
    if (!HIVE_SET.has(hive)) {
      if (HIVE_ALIASES[hive]) hive = HIVE_ALIASES[hive];
      else return { error: 'INVALID_ARGS', message: `unknown hive '${parts[0]}' (expected one of ${HIVES.join(', ')}${Object.keys(HIVE_ALIASES).map((a) => `, ${a}`).join('')})` };
    }
    const segments = [];
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i].trim();
      if (!seg) return { error: 'INVALID_ARGS', message: 'path contains an empty segment' };
      if (seg === '.' || seg === '..') return { error: 'INVALID_ARGS', message: "path segments may not be '.' or '..'" };
      if (seg.length > LIMITS.MAX_SEG_LENGTH) {
        return { error: 'INVALID_ARGS', message: `path segment exceeds ${LIMITS.MAX_SEG_LENGTH} characters` };
      }
      segments.push(seg);
    }
    if (segments.length > LIMITS.MAX_DEPTH) {
      return { error: 'INVALID_ARGS', message: `path exceeds ${LIMITS.MAX_DEPTH} segments` };
    }
    return { hive, segments, path: hive + (segments.length ? '/' + segments.join('/') : '') };
  }

  // ── Tree model ─────────────────────────────────────────────────────────
  // A node is { keys: {name: node}, values: {name: {type, data, lastModified}},
  // link?: 'target path' }. Both maps are sparse; the hive root doubles as
  // the top node. A node with `link` is a symbolic link KEY: it must stay
  // empty (no keys/values of its own) and is followed transparently.

  function emptyNode() {
    return { keys: {}, values: {} };
  }

  function ensureHive(hives, hive) {
    if (!hives[hive]) hives[hive] = { version: LIMITS.HIVE_SCHEMA_VERSION, hive, keys: {}, values: {} };
    return hives[hive];
  }

  // Plain walker (no link following) — kept for direct subtree work on one
  // node map. Live reads and writes go through resolveNode() instead.
  function walk(hives, hive, segments, create) {
    let node = ensureHive(hives, hive);
    for (const seg of segments) {
      if (!node.keys[seg]) {
        if (!create) return undefined;
        node.keys[seg] = emptyNode();
      }
      node = node.keys[seg];
    }
    return node;
  }

  // Link-aware resolver. Walks hive/segments, transparently jumping across
  // REG_LINK nodes. `hives` is the node map to operate on (state.hives for
  // live resolution; a single-hive clone map inside commitMutation — which
  // is why cross-hive writes are rejected up front, a clone cannot reach
  // another hive). When `boundedTo` is set, following a link OUT of that
  // hive throws LINK_CROSS_HIVE instead of silently resolving (or worse,
  // creating a phantom hive in a single-hive clone map). Returns
  // { hive, node, link } or null when a segment is missing and create is
  // false. Throws LINK_LOOP / INVALID_LINK on broken chains.
  function resolveNode(hives, hive, segments, options = {}) {
    const { followLinks = true, create = false, boundedTo = null } = options;
    let curHive = hive;
    let segs = segments.slice();
    let node = ensureHive(hives, curHive);
    let hops = 0;
    let lastLink = null;
    const visited = new Set([curHive]);
    for (let i = 0; i < segs.length; i++) {
      if (!node.keys[segs[i]]) {
        if (!create) return null;
        node.keys[segs[i]] = emptyNode();
      }
      node = node.keys[segs[i]];
      if (followLinks && node.link) {
        const target = parsePath(node.link);
        if (target.error) throw regError('INVALID_LINK', `link target '${node.link}' is not a valid registry path`);
        const canonical = target.hive + '/' + target.segments.join('/');
        hops += 1;
        if (visited.has(canonical) || hops > LIMITS.MAX_LINK_HOPS) {
          throw regError('LINK_LOOP', `link chain exceeds ${LIMITS.MAX_LINK_HOPS} hops or loops`);
        }
        visited.add(canonical);
        lastLink = node.link;
        curHive = target.hive;
        if (boundedTo && curHive !== boundedTo) {
          throw regError('LINK_CROSS_HIVE', 'writes through a cross-hive link are not supported; write to the target path instead');
        }
        if (!hives[curHive] && !create) return null;
        node = ensureHive(hives, curHive);
        segs = target.segments.concat(segs.slice(i + 1));
        i = -1; // restart the loop over the re-based segment list
      }
    }
    return { hive: curHive, node, link: lastLink };
  }

  // Resolves where a WRITE to parsed.path would land, following links on the
  // live tree. Writes are same-hive only: a single-hive clone cannot reach
  // another hive's document. boundedTo makes any link crossing throw.
  function assertSameHiveTarget(parsed, verb) {
    const resolved = resolveNode(state.hives, parsed.hive, parsed.segments, { followLinks: true, boundedTo: parsed.hive });
    const targetHive = resolved ? resolved.hive : parsed.hive;
    if (targetHive !== parsed.hive) {
      throw regError('LINK_CROSS_HIVE', `${verb} through a cross-hive link is not supported; write to the target path instead`);
    }
  }

  function countNodes(node) {
    let count = Object.keys(node.values).length;
    for (const child of Object.values(node.keys)) count += 1 + countNodes(child);
    return count;
  }

  // ── Value typing ───────────────────────────────────────────────────────

  function byteLength(type, data) {
    if (type === 'REG_JSON' || type === 'REG_MULTI_SZ') return JSON.stringify(data).length;
    return String(data).length;
  }

  function detectType(value) {
    switch (typeof value) {
      case 'boolean': return 'REG_BOOL';
      case 'number':
        if (Number.isInteger(value) && value >= 0 && value <= 0xFFFFFFFF) return 'REG_DWORD';
        if (Number.isInteger(value) && value >= 0 && Number.isSafeInteger(value)) return 'REG_QWORD';
        throw regError('INVALID_VALUE', 'numbers must be non-negative integers (REG_DWORD/REG_QWORD)');
      case 'string': return 'REG_SZ';
      case 'object':
        return 'REG_JSON';
      default:
        throw regError('INVALID_VALUE', `cannot store a ${typeof value} value in the registry`);
    }
  }

  function coerceValue(type, value) {
    if (!TYPE_SET.has(type)) throw regError('INVALID_VALUE', `unknown value type '${type}'`);
    switch (type) {
      case 'REG_SZ':
      case 'REG_EXPAND_SZ':
        if (typeof value !== 'string') {
          throw regError('INVALID_VALUE', `${type} requires a string`);
        }
        return value;
      case 'REG_MULTI_SZ':
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
          throw regError('INVALID_VALUE', 'REG_MULTI_SZ requires an array of strings');
        }
        return value.slice();
      case 'REG_BOOL':
        if (typeof value !== 'boolean') throw regError('INVALID_VALUE', 'REG_BOOL requires true or false');
        return value;
      case 'REG_DWORD':
        if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
          throw regError('INVALID_VALUE', 'REG_DWORD requires an integer between 0 and 4294967295');
        }
        return value;
      case 'REG_QWORD':
        if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
          throw regError('INVALID_VALUE', 'REG_QWORD requires a non-negative safe integer');
        }
        return value;
      case 'REG_JSON': {
        try { return JSON.parse(JSON.stringify(value ?? null)); } catch (_) {
          throw regError('INVALID_VALUE', 'REG_JSON requires JSON-serializable data');
        }
      }
      case 'REG_BINARY':
        if (typeof value !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(value)) {
          throw regError('INVALID_VALUE', 'REG_BINARY requires a base64 string');
        }
        return value;
      default:
        throw regError('INVALID_VALUE', `unknown value type '${type}'`);
    }
  }

  // ── REG_EXPAND_SZ expansion ────────────────────────────────────────────
  // The variable table lives in the registry itself: every value under
  // HKNS/env/* names a variable (%<name>% → String(data)). Expansion is a
  // single pass — the replacement text is never re-expanded — and unknown
  // variables are left verbatim, both matching Windows behavior.

  function expandString(raw) {
    if (typeof raw !== 'string' || raw.indexOf('%') === -1) return raw;
    let env = {};
    try {
      const envNode = walk(state.hives, 'HKNS', ['env'], false);
      if (envNode) {
        for (const [name, entry] of Object.entries(envNode.values)) env[name] = entry.data;
      }
    } catch (_) { env = {}; }
    return raw.replace(/%([^%]+)%/g, (whole, name) => {
      if (Object.prototype.hasOwnProperty.call(env, name)) {
        const value = env[name];
        return value === undefined || value === null ? '' : String(value);
      }
      return whole;
    });
  }

  // ── Mutation core (clone → validate → swap → persist) ──────────────────

  function commitMutation(hive, mutator) {
    // Sealed phase: the account hives were unmounted (logout / switch) and
    // no account is mounted — a user-hive write here would land in the
    // MACHINE documents with the departed account's data, so it is refused.
    // Machines with multi-user disabled never seal (userUid stays null and
    // userSealed stays false → behaviour byte-identical to 3.0.2).
    if (state.userSealed && USER_HIVES.includes(hive)) {
      throw regError('NOT_READY', `hive ${hive} belongs to an account — no account hives are mounted`);
    }
    const current = ensureHive(state.hives, hive);
    const clone = JSON.parse(JSON.stringify(current));
    const result = mutator(clone); // throws regError on any validation failure
    const serialized = JSON.stringify(clone);
    if (serialized.length > LIMITS.MAX_HIVE_BYTES) {
      throw regError('QUOTA_EXCEEDED', `hive ${hive} exceeds ${LIMITS.MAX_HIVE_BYTES} bytes`);
    }
    if (countNodes(clone) > LIMITS.MAX_NODES_PER_HIVE) {
      throw regError('QUOTA_EXCEEDED', `hive ${hive} exceeds ${LIMITS.MAX_NODES_PER_HIVE} nodes`);
    }
    state.hives[hive] = clone;
    // Inside batch() persistence and events are deferred to commit time.
    // Volatile mounts (guest sessions) persist nothing — discarded by design.
    if (!state.batchDepth && !state.userVolatile && state.storage && typeof state.storage.save === 'function') {
      state.storage.save(storageDocFor(hive), clone);
    }
    return result;
  }

  function emitChanged(hive, path, { type, value, appId, source }) {
    const meta = { type: type || null, value: value === undefined ? null : value, appId: appId || null, source: source || 'app' };
    if (state.batchDepth > 0) {
      state.batchLog.push({ hive, path, meta });
      return;
    }
    const bus = state && state.events;
    if (!bus || typeof bus.emit !== 'function') return;
    try {
      bus.emit('nova:reg:changed', { path, ...meta });
    } catch (err) { logWarn('failed to emit nova:reg:changed', err); }
  }

  // ── Audit ring ─────────────────────────────────────────────────────────
  // Every mutation appends one entry: { ts, actor, action, path, before,
  // after }. before/after are truncated JSON previews (null = absent). The
  // ring is bounded and persisted best-effort under the AUDIT pseudo-hive.

  function actorOf(options = {}) {
    if (options.actor) return String(options.actor).slice(0, 128);
    if (options.appId) return String(options.appId).slice(0, 128);
    if (options.source === 'seed') return 'seed';
    if (options.source === 'settings-mirror') return 'shell';
    return 'system';
  }

  function preview(data, limit = 200) {
    let text;
    try { text = data === undefined || data === null ? '' : (typeof data === 'string' ? data : JSON.stringify(data)); }
    catch (_) { text = String(data); }
    if (!text) return null;
    return text.length > limit ? text.slice(0, limit) + '…' : text;
  }

  function auditPush(entry) {
    if (!state.audit) state.audit = [];
    state.audit.push(entry);
    if (state.audit.length > LIMITS.MAX_AUDIT_ENTRIES) state.audit.splice(0, state.audit.length - LIMITS.MAX_AUDIT_ENTRIES);
  }

  function persistAudit() {
    try { if (state.storage && state.storage.save) state.storage.save('AUDIT', { version: 1, entries: state.audit }); } catch (_) {}
  }

  function auditAppend(options, action, path, before, after) {
    const entry = {
      ts: Date.now(),
      actor: actorOf(options || {}),
      action,
      path,
      before: preview(before),
      after: preview(after),
    };
    // Inside batch() audit records ride the batch log so a rolled-back
    // transaction leaves no phantom entries behind.
    if (state.batchDepth > 0) {
      state.batchLog.push({ auditEntry: entry });
      return;
    }
    auditPush(entry);
    persistAudit();
  }

  function audit(limit = 100) {
    ensureReady();
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    return state.audit.slice(-n).reverse();
  }

  // ── ACLs ───────────────────────────────────────────────────────────────
  // A key may carry acl: { owner: string|null, entries: [{ id, rights:
  // ['read','write'], inherit }] }. Entries with inherit !== false flow down
  // to descendants; the key's own entries always apply. No ACL anywhere →
  // no engine-level restriction (per-hive policy stays the sandbox's job).
  // The engine only EVALUATES ACLs (checkAccess); enforcement still lives
  // in the sandbox handlers, which pass the calling appId as the actor.

  function validateAcl(acl) {
    if (acl === null || acl === undefined) return null;
    if (!acl || typeof acl !== 'object' || Array.isArray(acl)) {
      throw regError('INVALID_VALUE', 'acl must be an object or null');
    }
    if (acl.owner !== undefined && acl.owner !== null &&
        (typeof acl.owner !== 'string' || !acl.owner.trim() || acl.owner.length > 128)) {
      throw regError('INVALID_VALUE', 'acl.owner must be a short string or null');
    }
    const entries = acl.entries === undefined ? [] : acl.entries;
    if (!Array.isArray(entries) || entries.length > LIMITS.MAX_ACL_ENTRIES) {
      throw regError('INVALID_VALUE', `acl.entries must be an array of at most ${LIMITS.MAX_ACL_ENTRIES} entries`);
    }
    const normalized = entries.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 128) {
        throw regError('INVALID_VALUE', 'each acl entry needs an id string (an app id, or * for everyone)');
      }
      const rights = Array.isArray(entry.rights) ? [...new Set(entry.rights)] : [];
      for (const right of rights) {
        if (!ACL_RIGHTS.includes(right)) throw regError('INVALID_VALUE', `unknown ACL right '${right}' (expected ${ACL_RIGHTS.join(', ')})`);
      }
      return { id: entry.id.trim(), rights, inherit: entry.inherit !== false };
    });
    return { owner: acl.owner != null ? acl.owner.trim() : null, entries: normalized };
  }

  // Resolves the key node for ACL work: parents through links, the final
  // segment as a KEY (ACLs live on keys, never on values).
  function aclNode(parsed, create) {
    assertSameHiveTarget(parsed, 'ACL operations');
    return resolveNode(state.hives, parsed.hive, parsed.segments, { followLinks: true, create });
  }

  function setAcl(path, acl, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (parsed.segments.length === 0) throw regError('INVALID_ARGS', 'ACLs apply to keys; give a key path');
    const clean = validateAcl(acl);
    commitMutation(parsed.hive, (root) => {
      const parentSegments = parsed.segments.slice(0, -1);
      const name = parsed.segments[parsed.segments.length - 1];
      const parent = parentSegments.length
        ? resolveNode({ [parsed.hive]: root }, parsed.hive, parentSegments, { followLinks: true, create: true }).node
        : root;
      if (parent.values[name] && !parent.keys[name]) {
        throw regError('INVALID_ARGS', 'ACLs apply to keys; that path names a value');
      }
      if (!parent.keys[name]) parent.keys[name] = emptyNode();
      if (clean === null) delete parent.keys[name].acl;
      else parent.keys[name].acl = JSON.parse(JSON.stringify(clean));
    });
    const applied = getAcl(parsed.path);
    auditAppend(options, 'acl', parsed.path, null, applied);
    emitChanged(parsed.hive, parsed.path, { type: 'ACL', value: applied, appId: options.appId, source: options.source || 'acl' });
    return { path: parsed.path, acl: applied };
  }

  function getAcl(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (parsed.segments.length === 0) throw regError('INVALID_ARGS', 'ACLs apply to keys; give a key path');
    const resolved = aclNode(parsed, false);
    const node = resolved && resolved.node;
    if (!node || !node.acl) return null;
    return JSON.parse(JSON.stringify(node.acl));
  }

  // Walks root → key collecting the effective entries: inherited entries
  // (inherit !== false) from every ancestor plus all entries of the key
  // itself. A deeper entry for the same id replaces a shallower one
  // (deepest definition wins — predictable and easy to explain in the UI).
  // Link nodes are followed; the chain continues inside the link target.
  function effectiveAcl(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    // Step 1: record the physical node chain (hive root → resolved key),
    // following links with the same hop discipline as resolveNode().
    const chain = [];
    let node = ensureHive(state.hives, parsed.hive);
    chain.push(node);
    let segs = parsed.segments.slice();
    let hops = 0;
    const visited = new Set([parsed.hive]);
    for (let i = 0; i < segs.length; i++) {
      if (!node.keys[segs[i]]) break;
      node = node.keys[segs[i]];
      chain.push(node);
      if (node.link) {
        const target = parsePath(node.link);
        const canonical = target.error ? null : target.hive + '/' + target.segments.join('/');
        if (target.error || !canonical || visited.has(canonical) || ++hops > LIMITS.MAX_LINK_HOPS) break;
        visited.add(canonical);
        segs = target.segments.concat(segs.slice(i + 1));
        node = ensureHive(state.hives, target.hive);
        chain.push(node);
        i = -1;
      }
    }
    // Step 2: shallow → deep merge. Entries on the final node always apply;
    // shallower nodes only contribute inherit !== false entries.
    const targetNode = chain[chain.length - 1];
    const entriesById = new Map();
    let owner = null;
    for (const chainNode of chain) {
      if (!chainNode || !chainNode.acl) continue;
      if (chainNode.acl.owner) owner = chainNode.acl.owner;
      const isTarget = chainNode === targetNode;
      for (const entry of chainNode.acl.entries || []) {
        if (!isTarget && entry.inherit === false) continue;
        entriesById.set(entry.id, entry);
      }
    }
    return { owner, entries: [...entriesById.values()].map((e) => ({ id: e.id, rights: [...e.rights], inherit: e.inherit !== false })) };
  }

  // The engine-side ACL evaluator. No entries at all → granted (engine is
  // policy-neutral; per-hive rules stay in the sandbox). Any entries → the
  // actor (or the '*' wildcard, or the literal 'system') must hold the
  // requested right.
  function checkAccess(path, actor, need) {
    ensureReady();
    if (!ACL_RIGHTS.includes(need)) throw regError('INVALID_ARGS', `need must be one of ${ACL_RIGHTS.join(', ')}`);
    const effective = effectiveAcl(path);
    if (actor === 'system' || effective.entries.length === 0) return { granted: true, reason: effective.entries.length ? 'system-actor' : 'no-acl' };
    // Grants are additive, Windows-style: the actor's own entry (deepest
    // definition wins per id) and the '*' wildcard BOTH contribute rights.
    const hasRight = (entry) => !!entry && entry.rights.includes(need);
    if (hasRight(effective.entries.find((e) => e.id === actor)) || hasRight(effective.entries.find((e) => e.id === '*'))) {
      return { granted: true, reason: 'acl-grant' };
    }
    return { granted: false, reason: `no ACL entry grants '${need}' to '${actor}'` };
  }

  // ── Value resolution ───────────────────────────────────────────────────

  // Resolves a parsed path to { node, name } where node is the KEY holding
  // value `name`. get/set/stat address the VALUE named by the last segment —
  // EXCEPT when that segment names an existing KEY (bare key path or an
  // explicit '(default)' segment), which addresses that key's default value,
  // Windows-style. Value wins when both exist (pre-v2 behavior). `hives` is
  // the node map to resolve against (state.hives live; a single-hive clone
  // inside commitMutation). Links are followed on both probes; writes are
  // same-hive only, enforced separately via assertSameHiveTarget().
  function resolveValueTarget(hives, hive, segments, create, resolveOptions = {}) {
    if (segments.length === 0 || segments[segments.length - 1] === DEFAULT_VALUE_NAME) {
      const parentSegments = segments.length === 0 ? [] : segments.slice(0, -1);
      const parent = resolveNode(hives, hive, parentSegments, { followLinks: true, create, ...resolveOptions });
      return { node: parent ? parent.node : null, name: DEFAULT_VALUE_NAME };
    }
    const name = segments[segments.length - 1];
    const parentSegments = segments.slice(0, -1);
    const parent = resolveNode(hives, hive, parentSegments, { followLinks: true, create, ...resolveOptions });
    if (parent && parent.node.values[name] !== undefined) return { node: parent.node, name };
    // The last segment may name an existing KEY — a bare key path reads and
    // writes that key's default value. Probed without create: a set() to a
    // brand-new path must keep creating a plain VALUE, not a key.
    const asKey = resolveNode(hives, hive, segments, { followLinks: true, ...resolveOptions });
    if (asKey && asKey.node) return { node: asKey.node, name: DEFAULT_VALUE_NAME, keyPath: true };
    return { node: parent ? parent.node : null, name };
  }

  function stat(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const { node, name } = resolveValueTarget(state.hives, parsed.hive, parsed.segments, false);
    const entry = node ? node.values[name] : undefined;
    if (!entry) return null;
    const out = { path: parsed.path, type: entry.type, data: entry.data, lastModified: entry.lastModified };
    if (entry.type === 'REG_EXPAND_SZ') out.expanded = expandString(entry.data);
    return out;
  }

  function get(path) {
    const entry = stat(path);
    if (!entry) return undefined;
    return entry.type === 'REG_EXPAND_SZ' ? entry.expanded : entry.data;
  }

  function set(path, value, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const type = options.type ? String(options.type) : detectType(value);
    const data = coerceValue(type, value);
    if (byteLength(type, data) > LIMITS.MAX_VALUE_BYTES) {
      throw regError('QUOTA_EXCEEDED', DEFAULT_VALUE_NAME_QUOTA_NOTE);
    }
    assertSameHiveTarget(parsed, 'writes');
    const before = stat(parsed.path);
    const committed = commitMutation(parsed.hive, (root) => {
      const cloneMap = { [parsed.hive]: root };
      // boundedTo: a link crossing inside the clone must throw, never
      // silently create a phantom target hive that would be discarded.
      const { node, name } = resolveValueTarget(cloneMap, parsed.hive, parsed.segments, true, { boundedTo: parsed.hive });
      if (!node) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
      const existing = node.values[name];
      if (existing && existing.type === type && JSON.stringify(existing.data) === JSON.stringify(data)) {
        return { changed: false, path: parsed.path, type, data };
      }
      node.values[name] = { type, data, lastModified: Date.now() };
      return { changed: true, path: parsed.path, type, data };
    });
    if (committed.changed) {
      auditAppend(options, 'set', parsed.path, before ? before.data : null, data);
      emitChanged(parsed.hive, parsed.path, { type, value: data, appId: options.appId, source: options.source });
    }
    return { path: parsed.path, type, data, changed: committed.changed };
  }

  function remove(path, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (parsed.segments.length === 0) throw regError('INVALID_ARGS', 'cannot delete a hive root');
    // The PARENT chain must stay in-hive (deletes resolve through links);
    // the final segment deliberately does not follow links, so removing a
    // link path removes the link itself — even when its target is another
    // hive.
    assertSameHiveTarget({ ...parsed, segments: parsed.segments.slice(0, -1) }, 'deletes');
    const before = stat(parsed.path);
    const committed = commitMutation(parsed.hive, (root) => {
      // Parent chain follows links; the FINAL segment resolves without
      // following, so removing a link path removes the link, not the target.
      const parentSegments = parsed.segments.slice(0, -1);
      const name = parsed.segments[parsed.segments.length - 1];
      // resolveNode returns null for a missing parent key — treat that like
      // any other absent target (NOT_FOUND) instead of dereferencing null.
      const resolvedParent = parentSegments.length
        ? resolveNode({ [parsed.hive]: root }, parsed.hive, parentSegments, { followLinks: true })
        : { node: root };
      const parent = resolvedParent ? resolvedParent.node : null;
      if (!parent) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
      if (Object.prototype.hasOwnProperty.call(parent.values, name)) {
        delete parent.values[name];
        return { removed: 'value' };
      }
      if (parent.keys[name]) {
        const child = parent.keys[name];
        const hasContent = Object.keys(child.values).length > 0 || Object.keys(child.keys).length > 0;
        if (hasContent && options.recursive !== true) {
          throw regError('SUBTREE_NOT_EMPTY', 'key has content; pass recursive: true to delete it');
        }
        delete parent.keys[name];
        return { removed: child.link ? 'link' : 'key' };
      }
      throw regError('NOT_FOUND', `no such value or key: ${parsed.path}`);
    });
    auditAppend(options, 'remove', parsed.path, before ? before.data : null, null);
    emitChanged(parsed.hive, parsed.path, { type: null, value: null, appId: options.appId, source: options.source });
    return { path: parsed.path, ...committed };
  }

  // Renames a VALUE or KEY within its parent, in one atomic commit. A value
  // renamed to '(default)' becomes the key's default value.
  function rename(path, newName, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (parsed.segments.length === 0) throw regError('INVALID_ARGS', 'cannot rename a hive root');
    if (typeof newName !== 'string' || !newName.trim()) throw regError('INVALID_ARGS', 'newName is required');
    const name = newName.trim();
    if (name === '.' || name === '..' || /[\\/]/.test(name) || name.length > LIMITS.MAX_SEG_LENGTH) {
      throw regError('INVALID_ARGS', `invalid new name '${newName}'`);
    }
    // Parent chain stays in-hive; the final segment may be the link itself
    // (renaming a link renames the link, never the target).
    assertSameHiveTarget({ ...parsed, segments: parsed.segments.slice(0, -1) }, 'renames');
    const before = stat(parsed.path);
    const newPath = parsed.hive + '/' + parsed.segments.slice(0, -1).concat(name).join('/');
    let renamed = null;
    commitMutation(parsed.hive, (root) => {
      const parentSegments = parsed.segments.slice(0, -1);
      const oldName = parsed.segments[parsed.segments.length - 1];
      // Same null-guard as remove(): a missing parent is NOT_FOUND.
      const resolvedParent = parentSegments.length
        ? resolveNode({ [parsed.hive]: root }, parsed.hive, parentSegments, { followLinks: true })
        : { node: root };
      const parent = resolvedParent ? resolvedParent.node : null;
      if (!parent) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
      if (Object.prototype.hasOwnProperty.call(parent.values, oldName)) {
        if (parent.values[name] || parent.keys[name]) throw regError('NAME_CONFLICT', `'${name}' already exists under this key`);
        parent.values[name] = parent.values[oldName];
        delete parent.values[oldName];
        renamed = 'value';
        return;
      }
      if (parent.keys[oldName]) {
        if (name === DEFAULT_VALUE_NAME) throw regError('INVALID_ARGS', `'${DEFAULT_VALUE_NAME}' is reserved for a key's default value`);
        if (parent.keys[name] || parent.values[name]) throw regError('NAME_CONFLICT', `'${name}' already exists under this key`);
        parent.keys[name] = parent.keys[oldName];
        delete parent.keys[oldName];
        renamed = 'key';
        return;
      }
      throw regError('NOT_FOUND', `no such value or key: ${parsed.path}`);
    });
    auditAppend(options, 'rename', `${parsed.path} → ${newPath}`, before ? before.data : null, null);
    emitChanged(parsed.hive, newPath, { type: null, value: null, appId: options.appId, source: options.source || 'rename' });
    return { path: newPath, renamed, from: parsed.path };
  }

  // Creates or replaces a symbolic-link KEY. The link node must be empty;
  // the target must be a valid registry path that is not the link itself or
  // inside it.
  function setLink(linkPath, targetPath, options = {}) {
    ensureReady();
    const parsed = parsePath(linkPath);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (parsed.segments.length === 0) throw regError('INVALID_ARGS', 'cannot link a hive root');
    const target = parsePath(targetPath);
    if (target.error) throw regError('INVALID_ARGS', target.message);
    if (target.hive === parsed.hive && (target.path === parsed.path || target.path.startsWith(parsed.path + '/'))) {
      throw regError('INVALID_LINK', 'a link may not point at itself or into its own subtree');
    }
    // The link NODE is written at the parent (same-hive only); the target
    // may absolutely live in another hive — cross-hive links are readable,
    // only write-through is refused.
    assertSameHiveTarget({ ...parsed, segments: parsed.segments.slice(0, -1) }, 'link writes');
    commitMutation(parsed.hive, (root) => {
      const parentSegments = parsed.segments.slice(0, -1);
      const name = parsed.segments[parsed.segments.length - 1];
      const parent = parentSegments.length
        ? resolveNode({ [parsed.hive]: root }, parsed.hive, parentSegments, { followLinks: true, create: true }).node
        : root;
      const existing = parent.keys[name];
      if (existing && (Object.keys(existing.keys).length > 0 || Object.keys(existing.values).length > 0)) {
        throw regError('SUBTREE_NOT_EMPTY', 'refusing to replace a non-empty key with a link');
      }
      parent.keys[name] = { keys: {}, values: {}, link: target.path };
    });
    auditAppend(options, 'link', parsed.path, null, target.path);
    emitChanged(parsed.hive, parsed.path, { type: 'REG_LINK', value: target.path, appId: options.appId, source: options.source || 'link' });
    return { path: parsed.path, link: target.path };
  }

  // Lists a KEY path (zero segments lists the hive root). Returns sorted key
  // names and a shallow copy of the values map. Link keys are followed: the
  // listing shows the target's content plus a `link` field naming it.
  // get/set/stat also address the VALUE named by a path's last segment, so
  // listing such a path must succeed too: it comes back as a leaf listing
  // (no child keys, a values map holding just that entry) — the `reg query
  // <path> /v <name>` behavior — instead of a spurious "no such key".
  // Value wins when a key and a value share the last segment, matching
  // resolveValueTarget so list() mirrors what get() on the path returns.
  function list(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const name = parsed.segments[parsed.segments.length - 1];
    const parent = parsed.segments.length >= 1
      ? resolveNode(state.hives, parsed.hive, parsed.segments.slice(0, -1), { followLinks: true })
      : null;
    if (parent && parent.node.values[name] !== undefined) {
      const out = {
        path: parsed.path,
        keys: [],
        values: JSON.parse(JSON.stringify({ [name]: parent.node.values[name] })),
      };
      if (parent.link) out.link = parent.link;
      return out;
    }
    const resolved = resolveNode(state.hives, parsed.hive, parsed.segments, { followLinks: true });
    if (!resolved) return null;
    const out = {
      path: parsed.path,
      keys: Object.keys(resolved.node.keys).sort(),
      values: JSON.parse(JSON.stringify(resolved.node.values)),
    };
    if (resolved.link) out.link = resolved.link;
    return out;
  }

  // Validates an import/export subtree node (used by importTree).
  function validateSubtreeNode(node, depth) {
    if (depth > LIMITS.MAX_DEPTH) throw regError('INVALID_VALUE', 'subtree is too deep');
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw regError('INVALID_VALUE', 'subtree nodes must be objects');
    }
    if (node.link !== undefined) {
      if (typeof node.link !== 'string' || parsePath(node.link).error) {
        throw regError('INVALID_VALUE', `invalid link target: ${JSON.stringify(node.link)}`);
      }
      if ((node.keys && Object.keys(node.keys).length) || (node.values && Object.keys(node.values).length)) {
        throw regError('INVALID_VALUE', 'a link node must be empty');
      }
    }
    const values = node.values && typeof node.values === 'object' ? node.values : {};
    const keys = node.keys && typeof node.keys === 'object' ? node.keys : {};
    for (const [name, entry] of Object.entries(values)) {
      if (name.length > LIMITS.MAX_NAME_LENGTH) throw regError('INVALID_VALUE', `value name too long: ${name}`);
      if (!entry || typeof entry !== 'object') throw regError('INVALID_VALUE', `value '${name}' is malformed`);
      const type = entry.type && TYPE_SET.has(entry.type) ? entry.type : detectType(entry.data);
      coerceValue(type, entry.data);
    }
    for (const child of Object.values(keys)) validateSubtreeNode(child, depth + 1);
  }

  // Deep-clones the subtree under a KEY path (zero segments = whole hive).
  function exportTree(path) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    const resolved = resolveNode(state.hives, parsed.hive, parsed.segments, { followLinks: true });
    if (!resolved) throw regError('NOT_FOUND', `no such key: ${parsed.path}`);
    return JSON.parse(JSON.stringify({ keys: resolved.node.keys, values: resolved.node.values }));
  }

  // Merges an exportTree-shaped subtree under a KEY path, creating keys as
  // needed. Existing values keep their data unless the imported subtree has
  // a value of the same name (imported wins). Link nodes are recreated as
  // links (their target is validated, content is rejected). Returns the
  // merged value count.
  function importTree(path, data, options = {}) {
    ensureReady();
    const parsed = parsePath(path);
    if (parsed.error) throw regError(parsed.error, parsed.message);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw regError('INVALID_ARGS', 'import data must be an object ({ keys, values })');
    }
    let merged = 0;
    const validateNode = (node, depth) => {
      validateSubtreeNode(node, depth);
      const values = node.values && typeof node.values === 'object' ? node.values : {};
      const keys = node.keys && typeof node.keys === 'object' ? node.keys : {};
      for (const entry of Object.values(values)) {
        merged += 1;
        if (merged > LIMITS.MAX_IMPORT_VALUES) throw regError('QUOTA_EXCEEDED', 'imported subtree has too many values');
      }
      for (const child of Object.values(keys)) validateNode(child, depth + 1);
    };
    validateNode(data, parsed.segments.length);

    assertSameHiveTarget(parsed, 'imports');
    commitMutation(parsed.hive, (root) => {
      const node = resolveNode({ [parsed.hive]: root }, parsed.hive, parsed.segments, { followLinks: true, create: true }).node;
      const applyNode = (target, importNode) => {
        const values = importNode.values && typeof importNode.values === 'object' ? importNode.values : {};
        for (const [name, entry] of Object.entries(values)) {
          const type = entry.type && TYPE_SET.has(entry.type) ? entry.type : detectType(entry.data);
          const valueData = coerceValue(type, entry.data);
          if (byteLength(type, valueData) > LIMITS.MAX_VALUE_BYTES) {
            throw regError('QUOTA_EXCEEDED', `${DEFAULT_VALUE_NAME_QUOTA_NOTE}: ${name}`);
          }
          target.values[name] = { type, data: valueData, lastModified: Date.now() };
        }
        const keys = importNode.keys && typeof importNode.keys === 'object' ? importNode.keys : {};
        for (const [name, child] of Object.entries(keys)) {
          if (!target.keys[name]) target.keys[name] = emptyNode();
          if (child && child.link !== undefined) {
            target.keys[name] = { keys: {}, values: {}, link: child.link };
            continue;
          }
          applyNode(target.keys[name], child || {});
        }
      };
      applyNode(node, data);
      return { merged };
    });
    auditAppend(options, 'import', parsed.path, null, `${merged} value(s)`);
    emitChanged(parsed.hive, parsed.path, { type: null, value: null, appId: options.appId, source: options.source });
    return { path: parsed.path, merged };
  }

  // ── batch() — all-or-nothing cross-hive transactions ───────────────────
  // Runs mutator(api) with persistence and change events deferred: every
  // api.set/remove/import/rename/setAcl/setLink call inside mutator applies
  // to the live in-memory tree but is NOT persisted or announced. If the
  // mutator throws, every hive is rolled back to the pre-batch snapshot and
  // nothing is persisted or emitted. On success, touched hives are saved
  // once each and the recorded change events are emitted in order.

  function batch(mutator) {
    ensureReady();
    if (typeof mutator !== 'function') throw regError('INVALID_ARGS', 'batch needs a function');
    if (state.batchDepth > 0) throw regError('INVALID_STATE', 'nested batches are not supported');
    const snapshot = JSON.parse(JSON.stringify(state.hives));
    state.batchDepth = 1;
    state.batchLog = [];
    try {
      mutator(api);
    } catch (err) {
      state.hives = snapshot;
      state.batchDepth = 0;
      state.batchLog = null;
      persistAudit();
      throw err;
    }
    state.batchDepth = 0;
    const log = state.batchLog;
    state.batchLog = null;
    const touchedHives = new Set(log.filter((e) => e.hive).map((e) => e.hive));
    for (const hive of touchedHives) {
      if (state.storage && state.storage.save) state.storage.save(storageDocFor(hive), state.hives[hive]);
    }
    let events = 0;
    for (const entry of log) {
      if (entry.auditEntry) { auditPush(entry.auditEntry); continue; }
      events += 1;
      const bus = state.events;
      if (!bus || typeof bus.emit !== 'function') continue;
      try { bus.emit('nova:reg:changed', { path: entry.path, ...entry.meta }); } catch (err) { logWarn('failed to emit nova:reg:changed', err); }
    }
    persistAudit();
    return { committed: events };
  }

  // ── Snapshots — per-hive restore points ────────────────────────────────
  // A small ring (MAX_SNAPSHOTS_PER_HIVE) of full hive copies kept under the
  // SNAPSHOTS pseudo-hive. init() takes one 'boot' snapshot per non-empty
  // hive before anything else runs, so the last session's state is always
  // one restore away.

  function loadSnapshotsDoc() {
    let doc = null;
    try {
      if (state.storage && state.storage.loadAll) {
        const all = state.storage.loadAll();
        doc = all && all.SNAPSHOTS ? all.SNAPSHOTS : null;
      }
    } catch (_) { doc = null; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return doc;
  }

  function saveSnapshotsDoc(doc) {
    try { if (state.storage && state.storage.save) state.storage.save('SNAPSHOTS', doc); } catch (_) {}
  }

  function saveSnapshot(hive, label, options = {}) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    const doc = loadSnapshotsDoc();
    const ring = doc[hive] = Array.isArray(doc[hive]) ? doc[hive] : [];
    const entry = {
      id: 'snap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
      ts: Date.now(),
      label: String(label || 'manual').slice(0, 64),
      data: JSON.parse(JSON.stringify(ensureHive(state.hives, hive))),
    };
    ring.push(entry);
    while (ring.length > LIMITS.MAX_SNAPSHOTS_PER_HIVE) ring.shift();
    saveSnapshotsDoc(doc);
    auditAppend(options, 'snapshot', hive, null, entry.id);
    return { id: entry.id, ts: entry.ts, hive, label: entry.label };
  }

  function snapshots(hive) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    const ring = loadSnapshotsDoc()[hive] || [];
    return ring.map((entry) => ({
      id: entry.id, ts: entry.ts, label: entry.label, bytes: JSON.stringify(entry.data || {}).length,
    }));
  }

  function restoreSnapshot(hive, id, options = {}) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    const ring = loadSnapshotsDoc()[hive] || [];
    const entry = ring.find((candidate) => candidate.id === id);
    if (!entry) throw regError('NOT_FOUND', `no snapshot '${id}' for hive ${hive}`);
    const data = entry.data;
    if (!data || typeof data !== 'object' || !data.keys || !data.values) {
      throw regError('INVALID_VALUE', 'snapshot data is corrupt');
    }
    const restored = JSON.parse(JSON.stringify(data));
    restored.version = LIMITS.HIVE_SCHEMA_VERSION;
    restored.hive = hive;
    state.hives[hive] = restored;
    if (state.storage && state.storage.save) state.storage.save(storageDocFor(hive), restored);
    auditAppend(options, 'restore', hive, null, id);
    emitChanged(hive, hive, { type: null, value: null, appId: options.appId, source: options.source || 'snapshot' });
    return { path: hive, restored: id, ts: entry.ts };
  }

  function deleteSnapshot(hive, id) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    const doc = loadSnapshotsDoc();
    const ring = doc[hive] || [];
    const next = ring.filter((entry) => entry.id !== id);
    if (next.length === ring.length) throw regError('NOT_FOUND', `no snapshot '${id}' for hive ${hive}`);
    doc[hive] = next;
    saveSnapshotsDoc(doc);
    return { hive, deleted: id };
  }

  // ── Seed-once defaults & legacy import ──────────────────────────────────

  // Seed-once defaults: only writes paths that have no value yet. Returns
  // how many defaults were newly seeded.
  function ensureDefaults(defaults) {
    ensureReady();
    const map = defaults || BOOT_DEFAULTS;
    let seeded = 0;
    for (const [path, [type, value]] of Object.entries(map)) {
      if (stat(path) === null) {
        set(path, value, { type, source: 'seed' });
        seeded += 1;
      }
    }
    return seeded;
  }

  // One-time import of legacy (unmapped) settings into HKNU/legacy/<key>.
  // The registry gains a per-user snapshot of pre-registry prefs; the
  // settings store stays the live source of truth for those keys. Guarded
  // by HKND/_migration/legacySettingsDone so it runs exactly once.
  function migrateLegacySettings(getSetting, keys, options = {}) {
    ensureReady();
    if (typeof getSetting !== 'function' || !Array.isArray(keys)) return 0;
    if (stat('HKND/_migration/legacySettingsDone') !== null) return 0;
    let migrated = 0;
    batch(() => {
      for (const key of keys) {
        if (typeof key !== 'string' || !key.trim()) continue;
        let value;
        try { value = getSetting(key); } catch (_) { continue; }
        if (value === undefined) continue;
        set('HKNU/legacy/' + key.replace(/[\\/]/g, '_'), value, { type: 'REG_JSON', source: 'legacy-import' });
        migrated += 1;
      }
      set('HKND/_migration/legacySettingsDone', Date.now(), { type: 'REG_QWORD', source: 'legacy-import' });
    });
    return migrated;
  }

  // One-time ADOPTION of legacy settings into their LIVE registry paths —
  // this is the migration that makes the registry the source of truth.
  // Where migrateLegacySettings only snapshots pre-registry prefs into
  // HKNU/legacy for reference, adoptLegacySettings writes every provided key
  // through settingsPathFor() so OS.settings hydrates from real values on
  // the next boot. Adopted values intentionally override boot seeds (the
  // user's chosen theme beats the seeded default). Guarded by
  // HKND/_migration/registrySourceDone so it runs exactly once. Values that
  // fail validation are skipped with a warning — one bad key never aborts
  // the adoption.
  function adoptLegacySettings(getSetting, keys, options = {}) {
    ensureReady();
    if (typeof getSetting !== 'function' || !Array.isArray(keys)) return 0;
    if (stat('HKND/_migration/registrySourceDone') !== null) return 0;
    let adopted = 0;
    batch(() => {
      for (const key of keys) {
        if (typeof key !== 'string' || !key.trim()) continue;
        const path = settingsPathFor(key);
        if (!path) continue; // excluded (oversized) keys keep their legacy channel
        let value;
        try { value = getSetting(key); } catch (_) { continue; }
        if (value === undefined) continue;
        try {
          set(path, value, { source: 'legacy-adopt' });
          adopted += 1;
        } catch (err) {
          logWarn(`failed to adopt legacy setting '${key}' into ${path}`, err);
        }
      }
      set('HKND/_migration/registrySourceDone', Date.now(), { type: 'REG_QWORD', source: 'legacy-adopt' });
    });
    return adopted;
  }

  // settings → registry mirror. Idempotent; the engine dedupes writes whose
  // value did not change, so the mirror can never loop against the
  // settings shim's nova:reg:changed fan-out. KEPT for compatibility only —
  // since the registry became the source of truth, boot no longer attaches
  // it (the settings shim covers both directions); recovery tooling may
  // still use it.
  function attachSettingsMirror(settings, events) {
    ensureReady();
    if (state.mirrorAttached) return true;
    const bus = events || state.events;
    if (!settings || typeof settings.get !== 'function' || !bus || typeof bus.on !== 'function') return false;
    state.mirrorAttached = true;
    bus.on('settings:changed', (payload) => {
      const key = payload && payload.key;
      const path = SETTINGS_KEY_TO_PATH[key];
      if (!path || payload.value === undefined) return;
      try {
        set(path, payload.value, { source: 'settings-mirror' });
      } catch (err) {
        logWarn(`failed to mirror setting '${key}' into ${path}`, err);
      }
    });
    return true;
  }

  function hiveSnapshot(hive) {
    ensureReady();
    if (!HIVE_SET.has(hive)) throw regError('INVALID_ARGS', `unknown hive '${hive}'`);
    return JSON.parse(JSON.stringify(ensureHive(state.hives, hive)));
  }

  function init(options = {}) {
    state = freshState();
    state.storage = options.storage || createDefaultStorage();
    state.events = options.events !== undefined ? options.events
      : (typeof OS !== 'undefined' && OS && OS.events ? OS.events : null);
    state.logger = options.logger !== undefined ? options.logger
      : (typeof OS !== 'undefined' && OS && OS.logger ? OS.logger : null);
    const loaded = (state.storage && typeof state.storage.loadAll === 'function')
      ? (state.storage.loadAll() || {}) : {};
    for (const hive of HIVES) {
      const raw = loaded[hive];
      state.hives[hive] = (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        raw.keys && typeof raw.keys === 'object' && !Array.isArray(raw.keys) &&
        raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values))
        ? raw
        : { version: LIMITS.HIVE_SCHEMA_VERSION, hive, keys: {}, values: {} };
    }
    // Restore the audit ring (best-effort — a corrupt AUDIT doc is dropped).
    const auditDoc = loaded.AUDIT;
    if (auditDoc && Array.isArray(auditDoc.entries)) {
      state.audit = auditDoc.entries
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
        .slice(-LIMITS.MAX_AUDIT_ENTRIES);
    }
    // Boot auto-backup: one 'boot' snapshot per non-empty hive BEFORE this
    // session's first mutation, so the previous session is always restorable.
    if (options.autoBackup !== false) {
      try {
        for (const hive of HIVES) {
          const node = state.hives[hive];
          if (node && (Object.keys(node.keys).length > 0 || Object.keys(node.values).length > 0)) {
            saveSnapshot(hive, 'boot');
          }
        }
      } catch (err) { logWarn('boot snapshot failed', err); }
    }
    return api;
  }

  function ensureReady() {
    if (!state) init();
    return state;
  }

  // ── Mounted per-user hives ───────────────────────────────────────────

  /** Storage document name for a hive, honouring the mounted account. */
  function storageDocFor(hive) {
    return (state.userUid && USER_HIVES.includes(hive)) ? `user:${state.userUid}:${hive}` : hive;
  }

  function mountedUserUid() {
    return state ? state.userUid : null;
  }

  /**
   * Flushes the currently mounted user hives to their per-account documents.
   * Volatile mounts (guest sessions) are never written — they are discarded
   * by design. Machine documents (HKNS/AUDIT/SNAPSHOTS) are unaffected.
   */
  function flushUserHives() {
    ensureReady();
    if (!state.userUid) return false;
    if (state.userVolatile) return true; // volatile: nothing to flush
    for (const hive of USER_HIVES) {
      const doc = storageDocFor(hive);
      const data = state.hives[hive];
      if (!data) continue;
      try {
        if (state.storage && typeof state.storage.save === 'function') {
          state.storage.save(doc, data);
        }
      } catch (err) { logWarn('user hive flush failed', hive, err); }
    }
    return true;
  }

  /**
   * Mounts HKNU/HKNA/HKND for one account: flushes any previous mount, then
   * loads the account's hive documents (a missing document starts a fresh
   * hive — first login for a new account). Called ONLY by the SessionManager
   * at login: it is the one component permitted to swap registry mounts, so
   * the number of places scoping can be wrong stays at one. The segment is
   * the account's username (user:<username>:<HIVE> on disk under
   * users/<username>/registry/); callers without a username keep the legacy
   * uid-keyed addressing byte-for-byte.
   */
  function mountUserHives(segment, options = {}) {
    ensureReady();
    if (typeof segment !== 'string' || !USER_DOC_RE.exec(`user:${segment}:HKNU`)) {
      throw regError('INVALID_ARGS', `invalid account segment for hive mounting: '${segment}'`);
    }
    flushUserHives();
    state.userUid = segment;
    state.userVolatile = options.volatile === true;
    state.userSealed = false;
    for (const hive of USER_HIVES) {
      const doc = storageDocFor(hive);
      let raw = null;
      if (!state.userVolatile && state.storage && typeof state.storage.read === 'function') {
        try { raw = state.storage.read(doc); } catch (_) { raw = null; }
      }
      const decoded = decodeHive(hive, raw, (r) => {
        if (state.storage && typeof state.storage.quarantine === 'function') {
          try { state.storage.quarantine(doc, r); } catch (_) { }
        }
      });
      state.hives[hive] = decoded || { version: LIMITS.HIVE_SCHEMA_VERSION, hive, keys: {}, values: {} };
    }
    return api;
  }

  /**
   * Unmounts the account hives (flush first). After this the user hives stay
   * in memory but every further mutation is refused, so a picker-phase write
   * can never land in the machine documents. The next mountUserHives()
   * replaces the in-memory trees entirely.
   */
  function unmountUserHives() {
    ensureReady();
    flushUserHives();
    state.userUid = null;
    state.userVolatile = false;
    state.userSealed = true;
    return api;
  }

  const api = {
    HIVES,
    HIVE_ALIASES,
    VALUE_TYPES,
    ACL_RIGHTS,
    DEFAULT_VALUE_NAME,
    LIMITS,
    SETTINGS_KEY_TO_PATH,
    SETTINGS_PATH_TO_KEY,
    SETTINGS_EXCLUDED_KEYS,
    settingsPathFor,
    pathToSettingsKey,
    BOOT_DEFAULTS,
    init,
    get,
    stat,
    set,
    remove,
    delete: remove,
    rename,
    list,
    export: exportTree,
    import: importTree,
    setLink,
    getAcl,
    setAcl,
    checkAccess,
    effectiveAcl,
    batch,
    audit,
    saveSnapshot,
    snapshots,
    restoreSnapshot,
    deleteSnapshot,
    ensureDefaults,
    migrateLegacySettings,
    adoptLegacySettings,
    expand: expandString,
    attachSettingsMirror,
    hiveSnapshot,
    // Mounted per-account hives (multi-user): SessionManager-only surface.
    mountUserHives,
    unmountUserHives,
    flushUserHives,
    mountedUserUid,
    // Test/introspection hooks. resetState() drops all in-memory and does
    // NOT persist — tests re-init with their own storage afterwards.
    _internal: {
      parsePath,
      coerceValue,
      detectType,
      validateAcl,
      walk,
      resolveNode,
      expandString,
      resetState() { state = null; },
      currentState() { return state; },
    },
  };

  return api;
})();

if (typeof window !== 'undefined' && window) window.NovaRegistry = NovaRegistry;
if (typeof module !== 'undefined' && module.exports) module.exports = NovaRegistry;
