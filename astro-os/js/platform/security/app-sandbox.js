/**
 * AstroOS — App Sandbox
 *
 * Creates secure execution environments for apps using sandboxed webviews with
 * process isolation. Each app gets its own renderer process, storage partition,
 * and a capability-scoped IPC bridge to host OS services (filesystem, network,
 * notifications, window manager, etc.).
 *
 * @module app-sandbox
 */

const AppSandbox = (() => {
  'use strict';

  // Module state

  // Active sandboxes keyed by sandboxId. Each value holds the webview element,
  // app metadata, window state, WebSocket connections, and a teardown function.
  const activeSandboxes = new Map();
  const rootExecutionApps = new Map();
  const ROOT_AUDIT_STORAGE_KEY = 'novaOS_root_audit';
  const ROOT_AUDIT_MAX_ENTRIES = 1000;
  const rootAuditSetTimeout = window.setTimeout.bind(window);
  const rootAuditClearTimeout = window.clearTimeout.bind(window);
  const rootRevocationSetTimeout = window.setTimeout.bind(window);
  const rootAuditWrappedFunctions = new WeakSet();
  const rootAuditSubscribers = new Set();
  let rootRevocationReloadScheduled = false;
  let rootAuditEntries = null;
  let rootAuditPersistTimer = null;

  // Event subscriptions keyed by sandboxId, then event name -> handler.
  // Kept in a separate map so cleanup can iterate without touching the sandbox
  // object's other fields.
  const eventSubscriptions = new Map();
  const pendingAppIpcCalls = new Map();
  const appIpcRateLimits = new Map();

  // Open file dialogs keyed by sandboxId, so we can tear them down when a
  // sandbox is destroyed mid-dialog (prevents orphaned overlays in the DOM).
  const openDialogs = new Map();
  const shareDialogs = new Map();

  // App execution partitions are shared by every window of the same app id.
  // When policy requires the partition to be wiped, remember that requirement
  // until clearData() completes successfully; launches fail closed while a
  // required wipe is pending or has failed.
  const partitionCleanupPromises = new Map();
  const partitionCleanupRequired = new Set();

  function getRootAuditEntries() {
    if (rootAuditEntries) return rootAuditEntries.slice();
    try {
      const saved = JSON.parse(localStorage.getItem(ROOT_AUDIT_STORAGE_KEY) || '[]');
      rootAuditEntries = Array.isArray(saved) ? saved.filter(entry =>
        entry && typeof entry === 'object' && typeof entry.timestamp === 'number'
      ) : [];
      return rootAuditEntries.slice();
    } catch (error) {
      console.error('[RootAccess] Could not read the root audit log:', error);
      rootAuditEntries = [];
      return [];
    }
  }

  function recordRootAudit(app, api, severity = 'info') {
    const entry = {
      timestamp: Date.now(),
      appId: app.id,
      appName: app.name || app.id,
      api,
      severity,
    };
    if (!rootAuditEntries) rootAuditEntries = getRootAuditEntries();
    rootAuditEntries.unshift(entry);
    if (rootAuditEntries.length > ROOT_AUDIT_MAX_ENTRIES) rootAuditEntries.length = ROOT_AUDIT_MAX_ENTRIES;
    if (!rootAuditPersistTimer) {
      rootAuditPersistTimer = rootAuditSetTimeout(() => {
        rootAuditPersistTimer = null;
        persistRootAudit();
      }, 250);
    }
    for (const subscriber of rootAuditSubscribers) {
      try {
        subscriber(entry);
      } catch (error) {
        console.error('[RootAccess] Root audit subscriber failed:', error);
      }
    }
  }

  function persistRootAudit() {
    try {
      localStorage.setItem(ROOT_AUDIT_STORAGE_KEY, JSON.stringify(rootAuditEntries || []));
    } catch (error) {
      console.error('[RootAccess] Could not persist the root audit log:', error);
    }
  }

  function flushRootAudit() {
    if (rootAuditPersistTimer) {
      rootAuditClearTimeout(rootAuditPersistTimer);
      rootAuditPersistTimer = null;
    }
    persistRootAudit();
  }

  function identifyRootCaller(stack) {
    for (const app of rootExecutionApps.values()) {
      const marker = `novaapp:${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}/`;
      if (stack.includes(marker)) return app;
    }
    return null;
  }

  function isRootExecutionApp(appId) {
    return typeof appId === 'string' && rootExecutionApps.has(appId);
  }

  function installRootApiAudit(app) {
    const existing = rootExecutionApps.get(app.id);
    rootExecutionApps.set(app.id, {
      id: app.id,
      name: app.name || app.id,
      entryLoaded: existing?.entryLoaded === true,
    });
    const seenObjects = new WeakSet();
    const excludedMethods = new Set(['log']);

    function instrument(value, path, depth) {
      if (!value || typeof value !== 'object' || seenObjects.has(value) || depth > 2) return;
      let prototype;
      try {
        prototype = Object.getPrototypeOf(value);
      } catch (error) {
        console.error(`[RootAccess] Could not inspect API namespace ${path}:`, error);
        return;
      }
      if (prototype !== Object.prototype && prototype !== null) return;
      seenObjects.add(value);

      for (const key of Object.keys(value)) {
        let current;
        try {
          current = value[key];
        } catch (error) {
          console.error(`[RootAccess] Could not inspect API ${path}.${key}:`, error);
          continue;
        }
        const apiPath = `${path}.${key}`;
        if (typeof current === 'function' && !excludedMethods.has(key) && !rootAuditWrappedFunctions.has(current)) {
          const original = current;
          const wrapped = function(...args) {
            const caller = identifyRootCaller(new Error().stack || '');
            if (caller) recordRootAudit(caller, apiPath);
            return Reflect.apply(original, this, args);
          };
          try {
            value[key] = wrapped;
            if (value[key] === wrapped) rootAuditWrappedFunctions.add(wrapped);
          } catch (error) {
            console.error(`[RootAccess] Could not instrument API ${apiPath}:`, error);
          }
        } else if (current && typeof current === 'object') {
          instrument(current, apiPath, depth + 1);
        }
      }
    }

    for (const name of ['OS', 'FS', 'WM', 'AppRegistry', 'AppPermissionManager', 'Notify', 'DefaultApps', 'Boot', 'Kernel']) {
      const api = window[name];
      if (api && typeof api === 'object') {
        try {
          instrument(api, name, 0);
        } catch (error) {
          console.error(`[RootAccess] Could not instrument API namespace ${name}:`, error);
        }
      }
      return existing?.entryLoaded === true;
    }
  }

  function reloadAfterRootRevocation(reason) {
    if (!rootExecutionApps.size || rootRevocationReloadScheduled) return false;
    rootRevocationReloadScheduled = true;
    for (const app of rootExecutionApps.values()) {
      recordRootAudit(app, `Root execution revoked: ${reason}`, 'warn');
    }
    flushRootAudit();
    try {
      if (typeof OS !== 'undefined' && typeof WM !== 'undefined') {
        for (const [windowId, state] of OS.windows || []) {
          if (rootExecutionApps.has(state.appId)) WM.closeWindow(windowId);
        }
      }
    } catch (error) {
      console.error('[RootAccess] Could not close every root app window before reload:', error);
    } finally {
      rootRevocationSetTimeout(() => window.location.reload(), 100);
    }
    return true;
  }

  // Constants

  const API_PREFIX = 'nova:';
  // Allow word chars, dash, dot, space. Anything else (slashes, colons) is
  // rejected to prevent key injection across app namespaces.
  const STORAGE_KEY_REGEX = /^[\w\-. ]+$/;
  const STORAGE_VALUE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB per single value
  // The per-app total quota lives in the StorageLedger budget table below
  // (storageQuotaBytes, default raised from the legacy hardcoded 25 MB and
  // overridable per app) — see StorageLedger.DEFAULT_BUDGETS.
  const CLIPBOARD_HISTORY_MAX = 30;
  const ALLOWED_HTTP_METHODS = new Set([
    'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  ]);
  const ALLOWED_WEB_PROTOCOLS = new Set(['http:', 'https:']);
  // Hostnames that count as "internal" for permission gating, beyond
  // whatever isInternalHost's IP-range checks already catch. Named
  // first-party internal services live here since they don't resolve to
  // a fixed literal IP we could range-check.
  const INTERNAL_HOSTS = new Set([
    'localhost', 'api.novabyte.internal',
  ]);
  const DEFAULT_WINDOW_WIDTH = 800;
  const DEFAULT_WINDOW_HEIGHT = 600;
  const MIN_WINDOW_DIMENSION = 100;
  const DIALOG_FOCUS_DELAY_MS = 50;
  const DOWNLOAD_DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 min cap on save dialog
  const CLEAR_PARTITION_TIMEOUT_MS = 4000;

  // ── Storage ledger: per-app accounting, budgets, and access audit ────────
  // The "logical UID" layer. Kernel per-app UIDs don't fit this architecture
  // (single browser process, single-user OS, webview renderers can't carry
  // distinct kernel identities), so per-app isolation is enforced where every
  // app call already funnels through: this bridge. File ownership itself
  // stays path-derived (ownerAppIdForPath — always accurate, no index to
  // drift); what the ledger adds on top is what a UID layer would otherwise
  // give us and path checks can't:
  //   1. per-app resource budgets (storage quota, IPC payload cap, HTTP body
  //      cap, request timeout) — the OS-wide caps become per-app values;
  //   2. per-app accounting (bytes written/read, request count) for the
  //      Settings storage dashboard and future usageStats;
  //   3. an access audit of shared-tree file reads/writes ("who touched
  //      what outside its own sandbox") for the privacy dashboard.
  // Persistence follows the root-audit precedent: debounced localStorage,
  // mirrored to disk on Linux-native installs by the browser-state writer.
  // Accounting counters are best-effort telemetry, NOT security boundaries —
  // every real boundary (ownership, permissions, caps) is enforced at the
  // call site even if this module were deleted.
  const StorageLedger = (() => {
    'use strict';

    const LEDGER_STORAGE_KEY = 'novaOS_storage_ledger';
    const LEDGER_SCHEMA_VERSION = 1;
    const LEDGER_ACCESS_LOG_MAX = 500;
    const LEDGER_SAVE_DEBOUNCE_MS = 400;

    // OS-wide defaults; an app record may override any subset. Values are
    // clamped by BUDGET_LIMITS so a misconfigured override can neither
    // disable a cap entirely nor set an unusably tiny one.
    const DEFAULT_BUDGETS = Object.freeze({
      storageQuotaBytes: 256 * 1024 * 1024, // 256 MB (legacy cap: 25 MB)
      ipcPayloadBytes: 256 * 1024,          // 256 KB (legacy cap: 64 KB)
      httpBodyBytes: 16 * 1024 * 1024,      // 16 MiB (legacy cap: 6 MiB)
      requestTimeoutMs: 60_000,             // 60 s   (legacy cap: 30 s)
    });
    const BUDGET_LIMITS = Object.freeze({
      storageQuotaBytes: { min: 1024 * 1024, max: 2 * 1024 * 1024 * 1024 }, // 1 MB – 2 GB
      ipcPayloadBytes: { min: 1024, max: 8 * 1024 * 1024 },                 // 1 KB – 8 MB
      httpBodyBytes: { min: 64 * 1024, max: 64 * 1024 * 1024 },             // 64 KB – 64 MiB
      requestTimeoutMs: { min: 5000, max: 10 * 60 * 1000 },                 // 5 s – 10 min
    });
    const BUDGET_KEYS = new Set(Object.keys(DEFAULT_BUDGETS));

    let state = null;
    let persistTimer = null;

    function defaultState() {
      return { version: LEDGER_SCHEMA_VERSION, apps: {}, accessLog: [] };
    }

    function load() {
      if (state) return state;
      try {
        const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        state = parsed && typeof parsed === 'object' && parsed.apps && typeof parsed.apps === 'object'
          ? {
              version: LEDGER_SCHEMA_VERSION,
              apps: parsed.apps,
              accessLog: Array.isArray(parsed.accessLog) ? parsed.accessLog.filter(e => e && typeof e === 'object' && typeof e.t === 'number') : [],
            }
          : defaultState();
      } catch (e) {
        console.error('[StorageLedger] Could not read the storage ledger — starting empty:', e);
        state = defaultState();
      }
      for (const [id, rec] of Object.entries(state.apps)) {
        if (!rec || typeof rec !== 'object') delete state.apps[id];
      }
      return state;
    }

    function persist() {
      if (persistTimer) return;
      persistTimer = setTimeout(() => {
        persistTimer = null;
        try {
          localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(load()));
        } catch (e) {
          console.error('[StorageLedger] Could not persist the storage ledger:', e);
        }
      }, LEDGER_SAVE_DEBOUNCE_MS);
    }

    function ensureApp(appId) {
      const key = String(appId || '');
      if (!key) return null;
      const s = load();
      let rec = s.apps[key];
      if (!rec) {
        rec = s.apps[key] = {
          created: Date.now(),
          lastActive: Date.now(),
          bytesWritten: 0,
          bytesRead: 0,
          requestCount: 0,
          budgets: {},
        };
        persist();
      }
      return rec;
    }

    function clampBudget(key, value) {
      const limits = BUDGET_LIMITS[key];
      const n = Math.floor(Number(value));
      if (!limits || !Number.isFinite(n)) return null;
      return Math.min(limits.max, Math.max(limits.min, n));
    }

    return {
      DEFAULT_BUDGETS,
      BUDGET_KEYS,

      getBudget(appId, key) {
        if (!BUDGET_KEYS.has(key)) return null;
        const rec = load().apps[String(appId || '')];
        const override = rec ? rec.budgets[key] : undefined;
        return Number.isFinite(override) ? override : DEFAULT_BUDGETS[key];
      },

      setBudget(appId, key, value) {
        if (!BUDGET_KEYS.has(key)) throw new Error(`Unknown budget '${key}'`);
        const clamped = clampBudget(key, value);
        if (clamped === null) throw new Error(`Invalid budget value for '${key}'`);
        const rec = ensureApp(appId);
        if (!rec) throw new Error('appId is required');
        rec.budgets[key] = clamped;
        persist();
        return clamped;
      },

      touch(appId) { ensureApp(appId); },

      noteRequest(appId) {
        const rec = ensureApp(appId);
        if (!rec) return;
        rec.requestCount = (rec.requestCount || 0) + 1;
        rec.lastActive = Date.now();
        persist();
      },

      noteBytes(appId, delta) {
        const rec = ensureApp(appId);
        if (!rec) return;
        const written = Math.max(0, Math.floor(Number(delta?.written) || 0));
        const read = Math.max(0, Math.floor(Number(delta?.read) || 0));
        if (!written && !read) return;
        rec.bytesWritten = Math.max(0, (rec.bytesWritten || 0) + written);
        rec.bytesRead = Math.max(0, (rec.bytesRead || 0) + read);
        rec.lastActive = Date.now();
        persist();
      },

      // Records one shared-tree access ("this app read/wrote a file outside
      // its own /data/<appId>/ sandbox") for the Settings privacy panel.
      recordAccess(entry) {
        if (!entry || typeof entry !== 'object') return false;
        const appId = String(entry.appId || '');
        const kind = String(entry.kind || '');
        if (!appId || !kind) return false;
        const s = load();
        s.accessLog.unshift({
          t: Date.now(),
          appId,
          kind,
          detail: typeof entry.detail === 'string' ? entry.detail.slice(0, 300) : '',
        });
        if (s.accessLog.length > LEDGER_ACCESS_LOG_MAX) s.accessLog.length = LEDGER_ACCESS_LOG_MAX;
        persist();
        return true;
      },

      getAppStats(appId) {
        const key = String(appId || '');
        const rec = load().apps[key];
        if (!rec) return null;
        return {
          appId: key,
          created: rec.created,
          lastActive: rec.lastActive,
          bytesWritten: rec.bytesWritten || 0,
          bytesRead: rec.bytesRead || 0,
          requestCount: rec.requestCount || 0,
          budgets: { ...DEFAULT_BUDGETS, ...(rec.budgets || {}) },
        };
      },

      getAllStats() {
        const s = load();
        return Object.keys(s.apps).sort().map(id => this.getAppStats(id)).filter(Boolean);
      },

      listAccess(appId, limit) {
        const s = load();
        const cap = Math.max(1, Math.min(LEDGER_ACCESS_LOG_MAX, Math.floor(Number(limit) || 100)));
        const items = appId == null
          ? s.accessLog
          : s.accessLog.filter(e => e.appId === String(appId));
        return items.slice(0, cap);
      },

      // Uninstall: the app's accounting, budget overrides, and access-log
      // entries all die with the install (Android clears app state on
      // uninstall too).
      removeApp(appId) {
        const key = String(appId || '');
        if (!key) return false;
        const s = load();
        if (!s.apps[key]) return false;
        delete s.apps[key];
        s.accessLog = s.accessLog.filter(e => e.appId !== key);
        persist();
        return true;
      },

      // "Clear app data" (app stays installed): counters reset, budget
      // overrides survive — they are configuration, not data.
      resetForApp(appId) {
        const rec = load().apps[String(appId || '')];
        if (!rec) return false;
        rec.bytesWritten = 0;
        rec.bytesRead = 0;
        rec.requestCount = 0;
        rec.lastActive = Date.now();
        persist();
        return true;
      },

      resetAll() {
        state = defaultState();
        persist();
      },
    };
  })();

  // ── MAC policy engine ("NB-MAC": the JS-side SELinux analog) ─────────────
  // The kernel route for per-app mandatory access control is a dead end in
  // this architecture (single browser process, single-user OS — see the
  // StorageLedger preamble and NOVAAPP.md "Linux per-app process mode"), so
  // the SELinux model is reimplemented in JS at the same chokepoint every
  // app call already funnels through: this bridge.
  //
  //   SELinux concept          NB-MAC equivalent
  //   ─────────────────────    ──────────────────────────────────────────
  //   domain (process type)    app → domain via `subjects` pinning, else
  //                            `untrusted_app` (default-deny posture)
  //   type (object class)      IPC endpoint family (nova:fs, nova:admin, …)
  //   allow src tgt:class perm `endpointGrants` rows: endpoint → ANY-of
  //                            permission list, or null (advisory)
  //   neverallow               verifyPolicy() rejects weakening rules
  //   avc audit log            rate-limited denial ring, debounced persist
  //   permissive mode          per-domain: log would-be denials, allow
  //
  // Enforcement contract (the part that makes rollout safe): a grant row is
  // ONLY seeded for endpoints whose handler permission check is
  // unconditional and context-free (verified against test_ipc_matrix.js's
  // MATRIX table — the granted/denied cases there assert the exact same
  // observable behavior with and without this layer). Path-dependent rules
  // (the fs family: app-owned paths need no grant, shared paths do) and
  // handler-internal checks stay handler-level — MAC passes those through
  // as `advisory` and the existing checks remain the boundary. The handler
  // checks are NOT removed anywhere: MAC is the uniform front door, the
  // handlers are defense in depth.
  //
  // What MAC adds over the scattered handler checks:
  //   1. default-deny posture — an endpoint with no policy row is refused
  //      for enforcing domains before it can reach any handler code;
  //   2. a single audit trail of every policy denial (avc-style);
  //   3. permissive mode per domain — new/unknown behavior can be rolled
  //      out log-first, exactly like real SELinux deployments;
  //   4. policy linting (verifyPolicy/verifyCoverage) so a policy that
  //      fails to cover every handler, or weakens a neverallow target,
  //      cannot ship.
  // Accounting is best-effort telemetry; every real boundary is still
  // enforced at the call site even if this module were deleted.
  const MacPolicy = (() => {
    'use strict';

    const MAC_AUDIT_STORAGE_KEY = 'novaOS_mac_audit';
    const MAC_AUDIT_LOG_MAX = 300;
    const MAC_SAVE_DEBOUNCE_MS = 400;
    // Rate limit for AUDIT WRITES only (a flood of denials must not turn
    // into a flood of localStorage churn). Denial decisions themselves are
    // never rate-limited — a denied call is always denied.
    const MAC_AUDIT_RATE_MAX = 60;
    const MAC_AUDIT_RATE_WINDOW_MS = 60 * 1000;

    const MAC_MODES = new Set(['enforcing', 'permissive']);
    const DOMAIN_UNTRUSTED = 'untrusted_app';
    const DOMAIN_PLATFORM = 'platform_module';

    // Family = first two segments of the endpoint type ("nova:fs" from
    // "nova:fs:read"). Documented in NOVAAPP.md; keep familyOf and the seed
    // data below in sync with API_HANDLERS (verifyCoverage enforces it).
    function familyOf(endpointType) {
      const parts = String(endpointType || '').split(':');
      return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : String(endpointType || '');
    }

    // Seed grant table — mirrors the MATRIX table in tests/integration/ipc-matrix.suite.js
    // row for row (ANY-of semantics, same perms). Values:
    //   ['perm:a', 'perm:b'] — enforced here: requires ANY-of the grants
    //   null                 — advisory: handler-level checks are the boundary
    // Grant-coupled rows are exactly the context-free permission gates.
    const SEED_ENDPOINT_GRANTS = Object.freeze({
      // Notifications — every handler checks device:notifications.
      'nova:notifications:show': ['device:notifications'],
      'nova:notifications:clear': ['device:notifications'],
      'nova:notifications:post': ['device:notifications'],
      'nova:notifications:createChannel': ['device:notifications'],
      'nova:notifications:cancel': ['device:notifications'],
      'nova:notifications:cancelAll': ['device:notifications'],
      'nova:notifications:consumeActions': ['device:notifications'],
      // Clipboard.
      'nova:clipboard:read': ['clipboard:read'],
      'nova:clipboard:write': ['clipboard:write'],
      // Data portability (own-namespace export/backup — see the handlers
      // for why restore/import are caller-pinned and checksummed).
      'nova:data:export': ['data:export'],
      'nova:data:import': ['data:export'],
      'nova:data:backup': ['data:backup'],
      'nova:data:restore': ['data:backup'],
      // System settings read/write.
      'nova:settings:get': ['system:info'],
      'nova:settings:set': ['system:settings'],
      // App management (launch is any-of launch|apps, as in the handler).
      'nova:app:launch': ['system:app-launch', 'system:apps'],
      'nova:app:list': ['system:apps'],
      'nova:app:install': ['system:apps'],
      'nova:app:uninstall': ['system:apps'],
      'nova:app:openDefaultAppsSettings': ['system:apps'],
      // nova:home:apps:launch and nova:home:openDefaultAppsSettings are
      // context-dependent, NOT context-free permission gates: both are
      // restricted to the currently selected Home app (isActiveHomeCaller),
      // and Home may always launch Settings/App Manager with no grant at
      // all (documented — the whole point of the Home surface). Requiring
      // system:app-launch/system:apps here denied those documented
      // grant-free Home flows at the MAC front door before the handler's
      // own caller/target checks could run; the handler stays the boundary.
      'nova:home:apps:launch': null,
      'nova:home:openDefaultAppsSettings': null,
      // Admin — also a neverallow target: rows here must never be weakened.
      'nova:admin:audit': ['admin:audit'],
      'nova:admin:system': ['admin:system'],
      'nova:admin:users': ['admin:users'],
      'nova:admin:apps': ['admin:apps'],
      // Mail.
      'nova:mail:read': ['mail:read'],
      'nova:mail:write': ['mail:write'],
      'nova:mail:session': ['mail:write'],
      'nova:mail:send': ['mail:send'],
      'nova:mail:delete': ['mail:delete'],
      // Network. ANY-of: the handler classifies the destination — internal
      // hosts require net:internal, everything else net:external — so the
      // MAC front door must accept either grant and let the handler decide,
      // exactly like the path-dependent fs:* rows. Requiring net:external
      // alone (the old row) locked internal-only apps out of their own
      // internal hosts entirely: MAC denied the call before the handler's
      // correct per-destination check could run.
      'nova:net:fetch': ['net:internal', 'net:external'],
      'nova:net:websocket': ['net:websocket'],
      // Devices.
      'nova:device:geolocation': ['device:geolocation'],
      'nova:device:camera': ['device:camera'],
      'nova:device:microphone': ['device:microphone'],
      // Calendar / contacts.
      'nova:calendar:read': ['calendar:read'],
      'nova:calendar:write': ['calendar:write'],
      'nova:calendar:delete': ['calendar:delete'],
      'nova:contacts:read': ['contacts:read'],
      'nova:contacts:write': ['contacts:write'],
      'nova:contacts:delete': ['contacts:delete'],
      // Misc.
      'nova:system:info': ['system:info'],
      // Locale — ungated on purpose (coarse formatting facts only; see the
      // handler comment). Still an explicit advisory row so policy coverage
      // is a statement, not an accident.
      'nova:locale:get': null,
      // Taskbar badge.
      'nova:badge:set': ['system:badge'],
      'nova:badge:clear': ['system:badge'],
      'nova:nested-webview': ['sandbox:nested-webview'],
      'nova:ipc:register': ['apps:communicate'],
      'nova:ipc:unregister': ['apps:communicate'],
      'nova:ipc:invoke': ['apps:communicate'],
      'nova:ipc:reply': ['apps:communicate'],
      'nova:ipc:broadcast:subscribe': ['apps:communicate'],
      'nova:ipc:broadcast': ['apps:communicate'],
      'nova:background:stay-alive': ['system:background:live'],
      // Advisory endpoints inside otherwise grant-coupled families
      // (cleanup/passive forms, matrix rows assert they are ungated).
      'nova:app:info': null,
      'nova:home:apps:list': null,
      'nova:net:ws:send': null,
      'nova:net:ws:close': null,
      'nova:ipc:broadcast:unsubscribe': null,
      'nova:events:subscribe': null,
      'nova:events:unsubscribe': null,
      'nova:background:wake-done': null,
      // Path-dependent gate — the handler decides per-path (app-owned paths
      // need no grant, shared-tree paths do). Cannot be expressed as a flat
      // grant without breaking app-owned access; see test_storage_ledger.js
      // S5 which writes /data/<app>/ paths with zero grants.
      'nova:fs:read': null,
      'nova:fs:write': null,
      'nova:fs:delete': null,
      'nova:fs:list': null,
      'nova:media:query': null,
      'nova:fs:mkdir': null,
      'nova:fs:stat': null,
      'nova:fs:rename': null,
      'nova:fs:move': null,
      // Watch — context-free fs:watch grant at the front door PLUS the
      // per-path nova:fs:read access rules in the handler (watching is
      // reading). The unwatch counterpart is advisory: dropping your own
      // poller leaks nothing.
      'nova:fs:watch': ['fs:watch'],
      'nova:fs:unwatch': null,
      // Named alarms.
      'nova:alarms:create': ['system:schedule'],
      'nova:alarms:clear': ['system:schedule'],
      'nova:alarms:getAll': ['system:schedule'],
      // Secrets — encrypted per-app credential store.
      'nova:secrets:set': ['secrets:store'],
      'nova:secrets:get': ['secrets:store'],
      'nova:secrets:delete': ['secrets:store'],
      'nova:secrets:keys': ['secrets:store'],
      // Push delivery — registration/unregistration of the app's publish
      // token. The inbound nova:push:message direction is a host→guest
      // push, not a guest request, so it has no row here; the delivery
      // ladder re-checks the grant on every message before the app ever
      // sees one.
      'nova:push:register': ['push:receive'],
      'nova:push:unregister': ['push:receive'],
      // AstroOS Registry — reads (get/list/export) are registry.read,
      // writes (set/delete/import) are registry.write. The handler adds the
      // per-hive rules the flat grant can't express: apps write only their
      // own HKNA/<appId>/ subtree, HKNS writes need a system app, HKNU needs
      // registry.system, HKND additionally needs Developer Mode, and the
      // HKNS/security subtree needs registry.system on top of either grant.
      'nova:reg:get': ['registry.read'],
      'nova:reg:list': ['registry.read'],
      'nova:reg:export': ['registry.read'],
      'nova:reg:set': ['registry.write'],
      'nova:reg:delete': ['registry.write'],
      'nova:reg:import': ['registry.write'],
    });

    // Families with NO grant-coupled endpoints: every endpoint in them is
    // ungated or gated by handler-internal context (picker flows, dialogs,
    // key-value storage ownership, root-execution checks…). NOTE: for
    // two-segment types (nova:ready, nova:open-url, nova:request-permission,
    // …) familyOf() returns the full type, so those keys are the types.
    const SEED_ADVISORY_FAMILIES = Object.freeze([
      'nova:fs', 'nova:storage', 'nova:window', 'nova:appearance',
      'nova:ready', 'nova:dialog', 'nova:sysdialog', 'nova:overlay',
      'nova:context-menu', 'nova:share', 'nova:files', 'nova:email',
      'nova:open-url', 'nova:open-with', 'nova:download',
      'nova:wallpaper', 'nova:request-permission',
      'nova:permission-rate-limited', 'nova:audit', 'nova:locale',
    ]);

    // neverallow v1: the admin family is the platform's privilege anchor —
    // a policy may not make its endpoints advisory (grant-less) or park the
    // family in advisoryFamilies. verifyPolicy() enforces this on every
    // applied policy. (A *dropped* row is not a neverallow violation — no
    // rule means deny, which is stricter — it is a coverage gap caught by
    // verifyCoverage() against the handler table, asserted in tests.)
    const SEED_NEVERALLOW = Object.freeze([
      Object.freeze({ target: 'nova:admin', requireGrant: true, reason: 'admin endpoints must stay grant-coupled' }),
    ]);

    const DEFAULT_POLICY = Object.freeze({
      policyVersion: 1,
      domains: Object.freeze({
        [DOMAIN_UNTRUSTED]: Object.freeze({ mode: 'enforcing' }),
        [DOMAIN_PLATFORM]: Object.freeze({ mode: 'permissive' }),
      }),
      // seapp_contexts analog: pin a specific appId to a domain. Empty by
      // default — every sandboxed app starts as untrusted_app.
      subjects: Object.freeze({}),
      endpointGrants: SEED_ENDPOINT_GRANTS,
      advisoryFamilies: SEED_ADVISORY_FAMILIES,
      neverallow: SEED_NEVERALLOW,
    });

    let active = null;          // live policy (deep copy of seed or applied)
    let domainModes = null;     // domain → mode, derived from active.domains
    let auditState = null;
    let auditPersistTimer = null;
    const auditRateLog = new Map(); // appId → [timestamps] (audit writes only)

    function freshPolicy() {
      return {
        policyVersion: DEFAULT_POLICY.policyVersion,
        domains: { untrusted_app: { mode: 'enforcing' }, platform_module: { mode: 'permissive' } },
        subjects: {},
        endpointGrants: { ...DEFAULT_POLICY.endpointGrants },
        advisoryFamilies: [...DEFAULT_POLICY.advisoryFamilies],
        neverallow: DEFAULT_POLICY.neverallow.map((r) => ({ ...r })),
      };
    }

    function load() {
      if (active) return active;
      active = freshPolicy();
      domainModes = new Map(Object.entries(active.domains).map(([d, v]) => [d, v.mode]));
      return active;
    }

    function defaultAuditState() {
      return { version: 1, entries: [], dropped: 0 };
    }

    function loadAudit() {
      if (auditState) return auditState;
      try {
        const raw = localStorage.getItem(MAC_AUDIT_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        auditState = parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)
          ? { version: 1, entries: parsed.entries.filter((e) => e && typeof e === 'object' && typeof e.t === 'number'), dropped: Math.max(0, Math.floor(Number(parsed.dropped) || 0)) }
          : defaultAuditState();
      } catch (e) {
        console.error('[MacPolicy] Could not read the MAC audit log — starting empty:', e);
        auditState = defaultAuditState();
      }
      return auditState;
    }

    function persistAudit() {
      if (auditPersistTimer) return;
      auditPersistTimer = setTimeout(() => {
        auditPersistTimer = null;
        try {
          localStorage.setItem(MAC_AUDIT_STORAGE_KEY, JSON.stringify(loadAudit()));
        } catch (e) {
          console.error('[MacPolicy] Could not persist the MAC audit log:', e);
        }
      }, MAC_SAVE_DEBOUNCE_MS);
    }

    function rateLimitedFor(appId) {
      const key = String(appId || '');
      const now = Date.now();
      const log = auditRateLog.get(key) || [];
      const fresh = log.filter((t) => now - t < MAC_AUDIT_RATE_WINDOW_MS);
      if (fresh.length >= MAC_AUDIT_RATE_MAX) {
        auditRateLog.set(key, fresh);
        return true;
      }
      fresh.push(now);
      auditRateLog.set(key, fresh);
      return false;
    }

    function recordAudit(entry) {
      const s = loadAudit();
      if (rateLimitedFor(entry.appId)) {
        s.dropped += 1;
        persistAudit();
        return false;
      }
      s.entries.unshift({ ...entry, t: Date.now() });
      if (s.entries.length > MAC_AUDIT_LOG_MAX) s.entries.length = MAC_AUDIT_LOG_MAX;
      persistAudit();
      return true;
    }

    function domainFor(appId) {
      const policy = load();
      return policy.subjects[String(appId || '')] || DOMAIN_UNTRUSTED;
    }

    function modeFor(domain) {
      return domainModes.get(domain) || 'enforcing';
    }

    function safeIsGranted(perm, appId) {
      try {
        return typeof AppPermissionManager !== 'undefined'
          && AppPermissionManager.isGranted(perm, appId) === true;
      } catch (e) {
        return false;
      }
    }

    // Resolve the policy row for an endpoint: exact endpoint row wins, then
    // the endpoint's family if it is advisory, otherwise undefined (which
    // means "no rule" → denied for enforcing domains — default deny).
    function resolveRow(endpointType) {
      const policy = load();
      const rows = policy.endpointGrants;
      if (Object.prototype.hasOwnProperty.call(rows, endpointType)) {
        return { grants: rows[endpointType], source: 'endpoint' };
      }
      const family = familyOf(endpointType);
      if (policy.advisoryFamilies.includes(family)) {
        return { grants: null, source: 'family' };
      }
      return { grants: undefined, source: 'none' };
    }

    // The bridge front-door check. Pure decision + audit; throws nothing.
    function checkIpc(appId, endpointType) {
      const id = String(appId || '');
      const type = String(endpointType || '');
      const domain = domainFor(id);
      const mode = modeFor(domain);
      const row = resolveRow(type);
      if (row.grants !== undefined) {
        if (row.grants === null) {
          return { allowed: true, advisory: true, domain, mode, endpoint: type };
        }
        const held = row.grants.some((p) => safeIsGranted(p, id));
        if (held) {
          return { allowed: true, domain, mode, endpoint: type, rule: [...row.grants] };
        }
        const denial = {
          appId: id, domain, mode, endpoint: type, action: 'call',
          perms: [...row.grants], enforced: mode !== 'permissive',
          avc: `avc: denied { call } for app=${id || '(anonymous)'} endpoint=${type} domain=${domain} mode=${mode} required=${row.grants.join('|')}`,
        };
        recordAudit(denial);
        if (mode === 'permissive') {
          return { allowed: true, wouldDeny: true, domain, mode, endpoint: type, rule: [...row.grants] };
        }
        return { allowed: false, code: 'PERMISSION_DENIED', domain, mode, endpoint: type, rule: [...row.grants] };
      }
      // No policy row: default-deny for enforcing domains (this is the
      // property that keeps future endpoints locked until policy allows
      // them), audit and pass for permissive ones.
      const denial = {
        appId: id, domain, mode, endpoint: type, action: 'call',
        perms: [], enforced: mode !== 'permissive', noRule: true,
        avc: `avc: denied { call } for app=${id || '(anonymous)'} endpoint=${type} domain=${domain} mode=${mode} reason=no_policy_row`,
      };
      recordAudit(denial);
      if (mode === 'permissive') {
        return { allowed: true, wouldDeny: true, domain, mode, endpoint: type, noRule: true };
      }
      return { allowed: false, code: 'PERMISSION_DENIED', domain, mode, endpoint: type, noRule: true };
    }

    // ── Policy linting (the neverallow/coverage compiler) ────────────────

    function verifyPolicy(policy) {
      const errors = [];
      if (!policy || typeof policy !== 'object') {
        return { ok: false, errors: ['policy must be an object'] };
      }
      if (!policy.domains || typeof policy.domains !== 'object'
          || !Object.keys(policy.domains).length) {
        errors.push('domains must be a non-empty object');
      } else {
        for (const [name, def] of Object.entries(policy.domains)) {
          if (!/^[a-z_][a-z0-9_]*$/i.test(name)) errors.push(`bad domain name '${name}'`);
          if (!def || !MAC_MODES.has(def.mode)) errors.push(`domain '${name}' needs mode enforcing|permissive`);
        }
      }
      const subjects = policy.subjects || {};
      if (typeof subjects !== 'object') errors.push('subjects must be an object');
      for (const [appId, domain] of Object.entries(subjects)) {
        if (!policy.domains || !policy.domains[domain]) {
          errors.push(`subject '${appId}' pins unknown domain '${domain}'`);
        }
      }
      const rows = policy.endpointGrants;
      if (!rows || typeof rows !== 'object') {
        errors.push('endpointGrants must be an object');
      } else {
        for (const [endpoint, grants] of Object.entries(rows)) {
          if (!/^[a-z][a-z0-9:-]*$/i.test(endpoint)) errors.push(`bad endpoint key '${endpoint}'`);
          if (grants === null) continue;
          if (!Array.isArray(grants) || !grants.length || grants.some((g) => typeof g !== 'string' || !g.trim())) {
            errors.push(`endpoint '${endpoint}' needs null or a non-empty perm array`);
          }
        }
      }
      const families = policy.advisoryFamilies;
      if (!Array.isArray(families) || families.some((f) => typeof f !== 'string' || !f.trim())) {
        errors.push('advisoryFamilies must be an array of family names');
      }
      // neverallow: covered targets must stay grant-coupled.
      const neverallow = Array.isArray(policy.neverallow) ? policy.neverallow : [];
      for (const rule of neverallow) {
        if (!rule || typeof rule.target !== 'string') { errors.push('neverallow rule needs a target'); continue; }
        const looksLikeFamily = !rule.target.includes(':') || rule.target.split(':').length === 2;
        if (rule.requireGrant) {
          const violates = (key, grants) => grants === null || grants === undefined;
          if (looksLikeFamily) {
            if (Array.isArray(families) && families.includes(rule.target)) {
              errors.push(`neverallow violated: family '${rule.target}' is advisory (${rule.reason || 'must stay grant-coupled'})`);
            }
            for (const [endpoint, grants] of Object.entries(rows || {})) {
              if (familyOf(endpoint) === rule.target && violates(endpoint, grants)) {
                errors.push(`neverallow violated: endpoint '${endpoint}' is not grant-coupled (${rule.reason || 'must stay grant-coupled'})`);
              }
            }
          } else if (Object.prototype.hasOwnProperty.call(rows || {}, rule.target)
            && violates(rule.target, rows[rule.target])) {
            errors.push(`neverallow violated: endpoint '${rule.target}' is not grant-coupled (${rule.reason || 'must stay grant-coupled'})`);
          }
        }
      }
      return { ok: errors.length === 0, errors };
    }

    // Every handler type must resolve to a row or an advisory family — a
    // policy that fails coverage would default-deny existing handlers.
    function verifyCoverage(endpointTypes) {
      const uncovered = [];
      for (const type of endpointTypes || []) {
        if (resolveRow(type).grants === undefined) uncovered.push(type);
      }
      return { ok: uncovered.length === 0, uncovered };
    }

    function applyPolicy(policy) {
      const verdict = verifyPolicy(policy);
      if (!verdict.ok) {
        const err = new Error(`Invalid MAC policy: ${verdict.errors.join('; ')}`);
        err.policyErrors = verdict.errors;
        throw err;
      }
      active = {
        policyVersion: Math.max(1, Math.floor(Number(policy.policyVersion) || 1)),
        domains: JSON.parse(JSON.stringify(policy.domains)),
        subjects: JSON.parse(JSON.stringify(policy.subjects || {})),
        endpointGrants: JSON.parse(JSON.stringify(policy.endpointGrants)),
        advisoryFamilies: [...policy.advisoryFamilies],
        neverallow: JSON.parse(JSON.stringify(policy.neverallow || [])),
      };
      domainModes = new Map(Object.entries(active.domains).map(([d, v]) => [d, v.mode]));
      return true;
    }

    function setDomainMode(domain, mode) {
      if (!MAC_MODES.has(mode)) throw new Error(`Invalid MAC mode '${mode}'`);
      const policy = load();
      if (!policy.domains[domain]) throw new Error(`Unknown domain '${domain}'`);
      policy.domains[domain].mode = mode;
      domainModes.set(domain, mode);
      return mode;
    }

    function getAudit(limit) {
      const cap = Math.max(1, Math.min(MAC_AUDIT_LOG_MAX, Math.floor(Number(limit) || 100)));
      return loadAudit().entries.slice(0, cap);
    }

    function clearAudit() {
      auditState = defaultAuditState();
      persistAudit();
    }

    function getPolicyInfo() {
      const policy = load();
      const grantRows = Object.entries(policy.endpointGrants);
      const now = Date.now();
      const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
      const audit = loadAudit();
      return {
        policyVersion: policy.policyVersion,
        domains: Object.fromEntries(domainModes),
        subjects: Object.keys(policy.subjects).length,
        grantCoupledEndpoints: grantRows.filter(([, g]) => Array.isArray(g)).length,
        advisoryEndpoints: grantRows.filter(([, g]) => g === null).length,
        advisoryFamilies: policy.advisoryFamilies.length,
        neverallow: policy.neverallow.length,
        auditEntries: audit.entries.length,
        auditDropped: audit.dropped,
        denialsToday: audit.entries.filter((e) => e.enforced && e.t >= startOfDay.getTime()).length,
      };
    }

    function _resetForTests() {
      active = null;
      domainModes = null;
      auditState = null;
      if (auditPersistTimer) clearTimeout(auditPersistTimer);
      auditPersistTimer = null;
      auditRateLog.clear();
    }

    return {
      DEFAULT_POLICY,
      checkIpc,
      verifyPolicy,
      verifyCoverage,
      applyPolicy,
      setDomainMode,
      domainFor,
      getAudit,
      clearAudit,
      getPolicyInfo,
      _resetForTests,
    };
  })();

  // Notification gateway
  // Sandboxed apps never touch Notify.show() directly — everything funnels
  // through handleNotificationsShow, which enforces the limits below. This is
  // the actual security boundary: Notify.show() itself will happily execute a
  // function passed as `action` (trusted first-party callers rely on that),
  // so an app-facing payload must never pass anything but plain data through.
  const NOTIF_TITLE_MAX_LEN = 120;
  const NOTIF_BODY_MAX_LEN = 500;
  const NOTIF_ACTION_LABEL_MAX_LEN = 40;
  const ALLOWED_NOTIF_TYPES = new Set(['info', 'success', 'warning', 'error']);
  // Matches the icon set actually implemented by svgIcon() elsewhere in the
  // OS; anything else falls back to the default rather than being passed
  // through to markup/attribute contexts uninspected.
  const ALLOWED_NOTIF_ICONS = new Set([
    'archive', 'bell', 'bookmark', 'box', 'clock', 'file', 'folder', 'globe',
    'image', 'layout', 'lock', 'monitor', 'music', 'package', 'play', 'refresh',
    'search', 'sound', 'star', 'unlock', 'users', 'x',
  ]);
  // Built-in action strings handleable by Notify.showToast()'s action-button
  // switch statement. Anything else is dropped rather than forwarded, since
  // an unrecognized string is silently ignored downstream anyway (console.warn)
  // but there's no reason to let an app probe for future built-ins.
  const ALLOWED_NOTIF_ACTIONS = new Set(['settings', 'open-settings', 'openSettings', 'open-store']);
  // Sliding-window rate limit: N notifications per app per window.
  const NOTIF_RATE_LIMIT_MAX = 10;
  const NOTIF_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  // v2 update budget: posts that update an EXISTING tagged notification run
  // against their own, much larger window instead of the new-post budget.
  // Without this split, a download progress bar updating once a second would
  // hit the spam limiter within ten seconds.
  const NOTIF_UPDATE_RATE_LIMIT_MAX = 60;
  const NOTIF_UPDATE_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  // v2 payload bounds. Slugs match the sandbox-wide id pattern; channel ids
  // and tags end up inside storage keys, so they get the same treatment.
  const NOTIF_CHANNEL_ID_MAX = 64;
  const NOTIF_CHANNEL_LIMIT = 32;
  const NOTIF_TAG_MAX_LEN = 64;
  const NOTIF_ACTIONS_MAX = 3;
  const NOTIF_ACTION_ID_MAX_LEN = 40;
  const NOTIF_PROGRESS_MAX = 100000;
  const NOTIF_SLUG_RE = /^[a-zA-Z0-9_-]+$/;
  // appId -> array of timestamps (ms) within the current window.
  const notifRateLimitLog = new Map();
  // Same shape, separate budget for tagged update-in-place posts (v2).
  const notifUpdateRateLimitLog = new Map();

  // Only an app which passes UnrestrictedGate may execute in the host
  // document. Any package that falls back to a sandbox gets the same
  // permission-gated capabilities as every other sandboxed app.
  function isFullyUnrestricted(app) {
    return app?.__unrestrictedSandbox === true;
  }

  // Shared TextEncoder for the base64 helpers — cheap to construct, but no
  // reason to allocate a new one per call when IPC traffic is high-frequency.
  const sharedTextEncoder = new TextEncoder();
  const sharedTextDecoder = new TextDecoder();

  // Utility helpers

  // Generate a unique request ID for IPC correlation. Prefers crypto.randomUUID
  // when available; falls back to timestamp + random otherwise.
  function generateRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `req_${crypto.randomUUID()}`;
    }
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  // Generate a unique sandbox ID. Uses crypto.randomUUID for collision
  // resistance — Date.now() alone can collide if two sandboxes are created
  // in the same millisecond.
  function generateSandboxId(appId) {
    const unique = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    return `sandbox_${appId}_${unique}`;
  }

  // Stable per-app serving alias. Besides the per-session path (see
  // generateSandboxId), the server also publishes this app's bundled files
  // under `sandbox_<appId>` with NO unique suffix — a URL that survives
  // relaunches, which is what makes pre-registered OAuth/redirect callback
  // URLs possible (register
  // `https://localhost:3003/api/apps/serve/sandbox_<appId>/callback.html`
  // with the provider once; it resolves to the most recent launch). Only ids
  // matching the platform's app-id shapes are eligible — reverse-domain
  // package ids (app-package.js install validation) and webapp_ shortcut ids.
  // Anything else degrades to session-only serving, exactly as before the
  // alias existed, so an unexpected id can never break a launch.
  const APP_SERVE_APP_ID_PATTERN = /^(?:webapp_[a-z0-9._-]{1,112}|[a-z][a-z0-9]*(?:\.[a-z0-9]+)+)$/;

  // Per-sandbox liveness heartbeat cadence for the server-side app-serve
  // registry (server prunes entries idle for 30 minutes — six missed beats,
  // so plenty of margin for a dropped request).
  const APP_SERVE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

  function stableServeAppId(appId) {
    return (typeof appId === 'string' && appId.length <= 128 && APP_SERVE_APP_ID_PATTERN.test(appId))
      ? appId
      : null;
  }

  // Escape a string for safe HTML interpolation. Used whenever app-supplied
  // metadata (name, author, etc.) is embedded into the default shell or error
  // page. Without this, a malicious package could inject <script> tags.
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  // UTF-8 safe base64 encoding. btoa() throws on non-Latin1 characters, so app
  // HTML containing emoji or CJK content would crash the loader. We go through
  // TextEncoder so the full Unicode range survives the round-trip.
  function encodeBase64Utf8(text) {
    const bytes = sharedTextEncoder.encode(text);
    if (typeof bytes.toBase64 === 'function') {
      return bytes.toBase64();
    }
    // Legacy fallback for runtimes without Uint8Array.toBase64 (pre-ES2026).
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // Inverse of encodeBase64Utf8.
  function decodeBase64Utf8(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      return sharedTextDecoder.decode(Uint8Array.fromBase64(b64));
    }
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return sharedTextDecoder.decode(bytes);
  }

  function encodeBase64Bytes(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  // Serial mirror for operator-visible log lines. Field debugging kept dying
  // on the same wall: the popup decision lines (763edcd) and every other
  // info/warn/error from this module go to this window's console, and THIS
  // window's console never reaches the serial console — two captures covered
  // a popup spawning and not one [AppSandbox] line appeared, while the
  // server's process.stdout (the channel carrying the [OS Build] marker and
  // the [Memory] heartbeat) provably does. The UI is served same-origin by
  // the server, so mirroring is a POST to /api/os/log, which the server
  // writes straight to its stdout — i.e. onto the serial console.
  // Fire-and-forget, never throws, debug stays console-only.
  const serialMirror = (() => {
    let windowStart = 0;
    let sentInWindow = 0;
    let dropped = 0;
    const MAX_PER_WINDOW = 40;
    const WINDOW_MS = 5000;
    function formatItem(item) {
      if (typeof item === 'string') return item;
      if (item instanceof Error) return item.stack || `${item.name}: ${item.message}`;
      try { return JSON.stringify(item) ?? String(item); } catch (e) { return String(item); }
    }
    return function mirror(level, message, ...rest) {
      try {
        const now = Date.now();
        if (now - windowStart > WINDOW_MS) { windowStart = now; sentInWindow = 0; }
        if (sentInWindow >= MAX_PER_WINDOW) { dropped += 1; return; }
        sentInWindow += 1;
        const dropNote = dropped > 0 ? `(${dropped} earlier lines dropped by throttle) ` : '';
        dropped = 0;
        const line = `${dropNote}[AppSandbox:${level}] ${message}${rest.length ? ' ' + rest.map(formatItem).join(' ') : ''}`;
        // The sink is a POST route, so it sits behind the server's CSRF gate
        // like every other one: without the token each POST is answered 403
        // CSRF_MISSING and the never-throw policy hides it — which is exactly
        // what happened in the field (the app guest's devtools filled with
        // 403s on :3003/api/os/log while serial never showed one [OS UI]
        // line). The UI window's own document carries the live session token
        // in the csrf-token meta tag injected by GET /, and csrfToken() is
        // the same accessor authedJsonFetch uses for its POSTs.
        fetch('/api/os/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken() },
          body: JSON.stringify({ lines: [line.slice(0, 2000)] }),
          keepalive: true,
        }).catch(() => {});
      } catch (e) { /* logging must never throw */ }
    };
  })();

  // Structured logger. Debug-level messages are gated on a window flag so
  // production builds stay quiet unless an operator opts in.
  function log(level, message, ...rest) {
    const prefix = '[AppSandbox]';
    if (level === 'error') console.error(prefix, message, ...rest);
    else if (level === 'warn') console.warn(prefix, message, ...rest);
    else if (level === 'debug') {
      if (typeof window !== 'undefined' && window.__NOVA_SANDBOX_DEBUG__) {
        console.debug(prefix, message, ...rest);
      }
    } else {
      console.log(prefix, message, ...rest);
    }
    if (level !== 'debug' && typeof fetch === 'function') {
      serialMirror(level, message, ...rest);
    }
  }

  // Cloud metadata endpoints — checked ahead of, and independent of, the
  // internal/external classification below. isInternalHost correctly
  // classifies these as internal (they're link-local), which means any app
  // holding an ordinary net:internal grant (intended for talking to
  // api.novabyte.internal) could also reach them directly and pull
  // instance credentials. There's no legitimate reason a third-party
  // sandboxed app should ever reach these regardless of what network
  // permission it holds, so they get a hard deny here rather than being
  // bundled into the same grant as first-party internal services.
  // 169.254.169.254 covers AWS/GCP/Azure/DigitalOcean's IMDS; fd00:ec2::254
  // is AWS's IPv6 equivalent.
  const BLOCKED_METADATA_HOSTS = new Set(['169.254.169.254', 'fd00:ec2::254']);

  // Resolve a URL string against the current origin and classify it as
  // internal or external. Handles protocol-relative URLs (//host/path) safely
  // by always resolving through new URL(rawUrl, window.location.origin).
  //
  // Without this, an app could pass "//evil.com/foo" to net:fetch and have it
  // treated as internal because the original check only looked at the leading
  // "/" character.
  function resolveAndClassifyUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl === '') {
      return { valid: false, error: 'Invalid URL' };
    }
    let resolved;
    try {
      resolved = new URL(rawUrl, window.location.origin);
    } catch {
      return { valid: false, error: 'Invalid URL' };
    }
    if (!ALLOWED_WEB_PROTOCOLS.has(resolved.protocol)) {
      return { valid: false, error: 'Only http and https URLs are allowed' };
    }
    if (BLOCKED_METADATA_HOSTS.has(resolved.hostname.toLowerCase())) {
      return { valid: false, error: 'Cloud metadata endpoints are not reachable from apps' };
    }
    return {
      valid: true,
      url: resolved.href,
      isInternal: isInternalHost(resolved.hostname),
    };
  }

  // Parse a dotted-decimal IPv4 string into 4 octets, or null if it isn't
  // one. `URL` already normalizes alternate encodings (hex, octal, decimal-
  // integer, short forms like "127.1") into plain dotted-decimal before this
  // ever sees the hostname, so a strict dotted-decimal parse here is safe —
  // it's not re-opening the encodings URL already collapsed.
  // WebSocket destinations use their own protocols, but must enforce the
  // same public-vs-internal boundary as fetch(). Literal private/loopback,
  // link-local, first-party internal, and metadata hosts never qualify as
  // public just because the caller has the low-risk net:websocket grant.
  function resolveAndClassifyWebSocketUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { valid: false, error: 'Invalid WebSocket URL' };
    }
    let resolved;
    try {
      resolved = new URL(rawUrl);
    } catch {
      return { valid: false, error: 'Invalid WebSocket URL' };
    }
    if (!['ws:', 'wss:'].includes(resolved.protocol)) {
      return { valid: false, error: 'Only ws and wss URLs are allowed' };
    }
    if (resolved.username || resolved.password) {
      return { valid: false, error: 'Credentials in WebSocket URLs are not allowed' };
    }
    const hostname = resolved.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (BLOCKED_METADATA_HOSTS.has(hostname)) {
      return { valid: false, error: 'Cloud metadata endpoints are not reachable from apps' };
    }
    // Local-only DNS namespaces and single-label intranet names are internal
    // too, even though they are not literal private IP addresses. This blocks
    // common aliases such as router.local and printer.lan from using the
    // low-risk public-WebSocket grant alone.
    const internalDnsSuffixes = ['.localhost', '.local', '.lan', '.internal', '.home.arpa', '.test'];
    const localDnsName = !hostname.includes('.') || internalDnsSuffixes.some(suffix => hostname.endsWith(suffix));
    return { valid: true, url: resolved.href, isInternal: isInternalHost(hostname) || localDnsName };
  }

  function parseIPv4(hostname) {
    const parts = hostname.split('.');
    if (parts.length !== 4) return null;
    const octets = [];
    for (const p of parts) {
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      octets.push(n);
    }
    return octets;
  }

  // True if the given IPv4 octets fall in a loopback/private/link-local
  // range — i.e. anything that isn't routable "external" address space.
  // Covers: 127.0.0.0/8 (all loopback, not just .1), 10.0.0.0/8,
  // 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 (link-local, which
  // includes the 169.254.169.254 cloud metadata endpoint), 0.0.0.0/8, and
  // 100.64.0.0/10 (RFC 6598 shared address space — used internally by some
  // cloud providers, so it isn't public/routable either even though it
  // isn't classic RFC1918).
  //
  // The 0.0.0.0 check used to only match the literal all-zero address
  // (0.0.0.0), not the wider /8. That mattered because Linux resolves any
  // 0.x.x.x address to loopback — http://0.1.2.3/ reaches the same place
  // as 127.0.0.1 on a Linux host, so treating only 0.0.0.0 as internal left
  // the rest of that /8 misclassified as external and routable via a plain
  // net:external grant.
  function isPrivateIPv4(octets) {
    const [a, b] = octets;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // True if a normalized IPv6 literal (no brackets, lowercase — which is
  // what URL.hostname already gives us) is loopback/private/link-local, or
  // wraps an internal IPv4 address (IPv4-mapped ::ffff:a.b.c.d or the
  // legacy IPv4-compatible ::a.b.c.d form).
  function isPrivateIPv6(hostname) {
    if (hostname === '::1' || hostname === '::') return true;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true;
    // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) — the
    // embedded IPv4 address is what actually gets routed to, so classify
    // by that.
    const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(hostname);
    if (mapped) {
      const octets = parseIPv4(mapped[1]);
      return octets ? isPrivateIPv4(octets) : false;
    }
    return false;
  }

  function isInternalHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (INTERNAL_HOSTS.has(h)) return true;

    const v4 = parseIPv4(h);
    if (v4) return isPrivateIPv4(v4);

    // URL.hostname strips brackets from IPv6 literals, but check both
    // forms defensively in case this is ever called with a raw value.
    const v6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
    if (v6.includes(':')) return isPrivateIPv6(v6);

    return false;
  }

  // Validate that a value is a positive integer within optional bounds.
  // Returns the parsed integer or the fallback when invalid.
  function parsePositiveInt(value, fallback, min = 1) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  // Sanitize an app id for safe interpolation into a /data/ path segment.
  // Dots are PRESERVED so the segment is the app's real id — the same name
  // AppDirs bootstraps under ~/.local/share/novabyte/data/<appId>/ on Linux
  // — instead of a mangled com_example_app shadow folder that split each
  // app's data across two differently-named trees. Safety comes from the
  // shape check rather than from stripping dots: every unsafe character
  // (path separators, whitespace, unicode, ...) is replaced with '_', and
  // the result must START with an alphanumeric character, so '', '.', '..',
  // and any dot-led traversal shape can never survive (they collapse to
  // 'default' or a stripped form). A bare '..' therefore stays unreachable
  // exactly as before — handleAppInstall only admits signature-verified ids
  // today, but this remains the last line of defense for future install
  // paths that might skip that check.
  function sanitizeAppIdSegment(appId) {
    let segment = String(appId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) {
      segment = segment.replace(/^[._-]+/, '');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) segment = 'default';
    }
    return segment;
  }

  // The /data/ segment the CALLING app owns: alias-canonicalized first (a
  // legacy id like com.astroos.quill owns com.astroos.textedit's data subtree —
  // the same folder AppDirs maintains for it), then reduced to a safe
  // segment. Every /data path construction and ownership comparison must go
  // through this so an app's data lives under exactly one folder name.
  function appDataSegment(appId) {
    let canonical = appId;
    try {
      canonical = window.NovaAppIdAliases?.canonicalize?.(appId) || appId;
    } catch (_) { /* no host window (tests) — use the id as-is */ }
    return sanitizeAppIdSegment(canonical);
  }

  // Notification gateway helpers

  // Strictly whitelist and clamp an app-supplied notification payload before
  // it ever reaches Notify.show(). This is the actual security boundary:
  // Notify.show() itself will call `action` if it's a function (trusted
  // first-party callers rely on that), so nothing but plain, bounded data
  // may cross from a sandboxed app into that call.
  function sanitizeNotificationPayload(payload, appName, appId) {
    const raw = payload ?? {};

    const title = typeof raw.title === 'string' && raw.title.trim()
      ? raw.title.slice(0, NOTIF_TITLE_MAX_LEN)
      : 'Notification';
    const body = typeof raw.body === 'string'
      ? raw.body.slice(0, NOTIF_BODY_MAX_LEN)
      : '';
    const type = ALLOWED_NOTIF_TYPES.has(raw.type) ? raw.type : 'info';
    const icon = ALLOWED_NOTIF_ICONS.has(raw.icon) ? raw.icon : null;

    // `action` must never be forwarded as anything but a plain, known string.
    // A function reference (or any other type) is dropped entirely rather
    // than coerced, since coercion here is exactly how a sandbox escape
    // would sneak through.
    const action = typeof raw.action === 'string' && ALLOWED_NOTIF_ACTIONS.has(raw.action)
      ? raw.action
      : null;
    const actionLabel = action && typeof raw.actionLabel === 'string'
      ? raw.actionLabel.slice(0, NOTIF_ACTION_LABEL_MAX_LEN)
      : null;

    return {
      title,
      body,
      type,
      // Clamp appName too — a malicious manifest could declare an absurdly
      // long name that would blow past Notify's layout assumptions.
      appName: typeof appName === 'string' ? appName.slice(0, NOTIF_TITLE_MAX_LEN) : 'App',
      appId,
      icon,
      action,
      actionLabel,
      category: 'app',
    };
  }

  // Sliding-window rate limit: returns true if `appId` is still under
  // NOTIF_RATE_LIMIT_MAX notifications within the last
  // NOTIF_RATE_LIMIT_WINDOW_MS, recording this attempt if so. Returns false
  // (and does not record) if the app is over the limit.
  function checkNotificationRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - NOTIF_RATE_LIMIT_WINDOW_MS;
    const timestamps = (notifRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);

    if (timestamps.length >= NOTIF_RATE_LIMIT_MAX) {
      notifRateLimitLog.set(appId, timestamps);
      return false;
    }

    timestamps.push(now);
    notifRateLimitLog.set(appId, timestamps);
    return true;
  }

  // Drop the rate-limit entry for an app. Called on uninstall so the log
  // doesn't grow unbounded across the app's install/uninstall lifecycle.
  function clearNotificationRateLimit(appId) {
    notifRateLimitLog.delete(appId);
  }

  function checkNotificationUpdateRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - NOTIF_UPDATE_RATE_LIMIT_WINDOW_MS;
    const timestamps = (notifUpdateRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);

    if (timestamps.length >= NOTIF_UPDATE_RATE_LIMIT_MAX) {
      notifUpdateRateLimitLog.set(appId, timestamps);
      return false;
    }

    timestamps.push(now);
    notifUpdateRateLimitLog.set(appId, timestamps);
    return true;
  }

  function clearNotificationUpdateRateLimit(appId) {
    notifUpdateRateLimitLog.delete(appId);
  }

  // Seed channels declared statically in the app manifest under
  // notifications.channels: [{ id, name, importance, description }]. Runs
  // before every post/createChannel — the host-side ensureChannel is
  // idempotent and cheap, so a manifest's channels are always registered by
  // the time a post names one.
  function seedManifestNotificationChannels(appId) {
    try {
      const manifest = OS?.apps?.[appId]?.manifest;
      if (manifest && typeof Notify !== 'undefined' && Notify.ensureChannelsFromManifest) {
        Notify.ensureChannelsFromManifest(appId, manifest);
      }
    } catch (e) {
      log('warn', 'notification channel manifest seeding failed for', appId, e);
    }
  }

  // v2 action buttons: [{id, label}] — ids are slugs so they can be routed
  // back to the app as opaque strings, never functions. The v1 rule that
  // keeps Notify.show() from executing app-controlled code still holds:
  // nothing but plain, bounded data crosses from a sandboxed app.
  function sanitizeNotifActions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const a of raw.slice(0, NOTIF_ACTIONS_MAX)) {
      if (!a || typeof a !== 'object') continue;
      const id = typeof a.id === 'string' && a.id.length >= 1
        && a.id.length <= NOTIF_ACTION_ID_MAX_LEN && NOTIF_SLUG_RE.test(a.id)
        ? a.id
        : null;
      const label = typeof a.label === 'string' && a.label.trim()
        ? a.label.slice(0, NOTIF_ACTION_LABEL_MAX_LEN)
        : null;
      if (id && label) out.push({ id, label });
    }
    return out;
  }

  function sanitizeNotifProgress(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const max = Number.isFinite(raw.max) ? Math.max(1, Math.min(NOTIF_PROGRESS_MAX, Math.floor(raw.max))) : 100;
    if (raw.indeterminate === true) return { max, indeterminate: true, value: null };
    if (!Number.isFinite(raw.value)) return null;
    const value = Math.max(0, Math.min(max, Math.floor(raw.value)));
    return { value, max, indeterminate: false };
  }

  // v2 payload sanitizer: layers channel/tag/actions/progress on top of the
  // v1 clamps (which stay the security boundary for title/body/type/icon).
  // Channel *validation* (does it exist, is it muted) happens in the
  // handler against the host-side registry, not here — this function only
  // normalizes shapes and bounds.
  function sanitizeNotificationPayloadV2(payload, appName, appId) {
    const base = sanitizeNotificationPayload(payload, appName, appId);
    const raw = payload ?? {};
    const channelId = typeof raw.channelId === 'string' && raw.channelId.length >= 1
      && raw.channelId.length <= NOTIF_CHANNEL_ID_MAX
      ? raw.channelId
      : 'general';
    const tag = typeof raw.tag === 'string' && raw.tag.length >= 1 && raw.tag.length <= NOTIF_TAG_MAX_LEN
      ? raw.tag
      : null;
    return {
      ...base,
      channelId,
      tag,
      // Field-wise update contract (see NOVAAPP.md): a tagged post that
      // OMITS actions/progress keeps the previous values — only an explicit
      // actions: [] or progress: null clears them. Normalizing an omitted
      // field to [] / null here silently erased every tagged update's
      // buttons and progress bar, breaking progress tickers and chat
      // previews that legitimately re-post title/body only.
      actions: raw.actions === undefined ? undefined : sanitizeNotifActions(raw.actions),
      progress: raw.progress === undefined ? undefined : sanitizeNotifProgress(raw.progress),
    };
  }

  // Response helpers

  // Send a response back to the sandboxed app.
  //
  // <webview> guests have no parent/embedder window reference at all
  // (window.parent === window for a <webview> guest — confirmed empirically,
  // and matches spec: a window with no parent has parent === itself).
  // postMessage from the host to some captured "source" reference was never
  // reachable, because no such reference is ever set — the guest can't
  // postMessage to the host either, for the same reason (see setupAPIBridge,
  // which reads guest->host messages via the webview's 'consolemessage' DOM
  // event instead).
  //
  // For host->guest, webview.executeScript(...) is a real, confirmed-working
  // NW.js API already used elsewhere in this codebase (see browser.js's
  // URL/title polling and context-menu injection). This pushes the response
  // directly into a well-known array (window.__novaInbox), which the
  // isolated-world transport script's poller drains and relays on to the
  // main-world capability shim via postMessage.
  //
  // Deliberately NOT { mainWorld: true } here — window.__novaInbox now
  // lives inside the isolated-world transport script injected via
  // addContentScripts (see buildIsolatedTransportScript), not on the
  // guest's own main-world window. executeScript's default (mainWorld:
  // false / omitted) targets that same isolated world, which is exactly
  // where this needs to land. A guest page's own script — including one
  // that has redefined window.__novaInbox, Array.prototype methods, or
  // anything else in its own main-world realm — cannot see or interfere
  // with this call, because isolated and main worlds share the DOM but
  // not JS globals.
  //
  // Data is passed as base64-encoded JSON rather than interpolated directly
  // into the injected code string. JSON.stringify does not escape backticks
  // or `${...}`, so an app-supplied value living inside `result` (e.g. an
  // echoed filename) could otherwise break out of the template literal below
  // and run arbitrary code in the target context. Base64's alphabet
  // (A-Za-z0-9+/=) can't contain any of those characters, so splicing it in
  // needs no further escaping. We embed it via JSON.stringify so the JS
  // string literal is well-formed regardless of base64 padding characters.
  function respond(webview, type, requestId, result, error = null) {
    if (typeof webview?.__directResponder === 'function') {
      try {
        webview.__directResponder({ type: `${type}:response`, requestId, result, error });
      } catch (e) {
        log('error', `Failed to respond directly to ${type}:`, e);
      }
      return;
    }
    try {
      const json = JSON.stringify({ type: `${type}:response`, requestId, result, error });
      const b64 = encodeBase64Utf8(json);
      const b64Literal = JSON.stringify(b64);
      // The injected code returns true on success / false on a caught parse
      // error, so the executeScript callback's results array actually means
      // something. executeScript's callback is (results), not (err); the
      // injected push statement returns undefined either way, so we wrap it
      // in a try/catch that returns a boolean.
      const code = `(function(){try{var binary=atob(${b64Literal});var bytes=Uint8Array.from(binary,function(character){return character.charCodeAt(0);});var json=new TextDecoder('utf-8').decode(bytes);window.__novaInbox=window.__novaInbox||[];window.__novaInbox.push(JSON.parse(json));return true;}catch(e){return false;}})();`;
      if (typeof webview?.executeScript !== 'function') {
        log('warn', `Cannot respond to ${type}: webview executeScript unavailable`);
        return;
      }
      webview.executeScript({ code }, (results) => {
        const delivered = Array.isArray(results) ? results[0] : results;
        if (delivered !== true) {
          log('error', `Failed to respond to ${type} (guest-side delivery failed or webview unavailable)`);
        }
      });
    } catch (e) {
      log('error', `Failed to respond to ${type}:`, e);
    }
  }

  // Error codes worth surfacing in the Events app. NOT_FOUND / UNAVAILABLE are
  // routine and would just add noise; PERMISSION_DENIED, RATE_LIMITED, and
  // anything else (unrecognized codes lean toward "new/unexpected", so they're
  // included by default) are the ones a dev actually wants to see happen live.
  const IPC_ERROR_LOG_SKIP = new Set(['NOT_FOUND', 'UNAVAILABLE']);

  function respondError(webview, type, requestId, code, message) {
    if (typeof EventLog !== 'undefined' && !IPC_ERROR_LOG_SKIP.has(code)) {
      const appId = webview?.dataset?.appId || 'unknown';
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: code === 'PERMISSION_DENIED' || code === 'RATE_LIMITED' ? 'warn' : 'error',
        message: `${appId}: ${type} → ${code}${message ? ' — ' + message : ''}`,
        data: { appId, type, code },
      });
    }
    // Coerce message to a string so a non-Error value (e.g. an object
    // thrown by an upstream caller that didn't use Error) doesn't surface
    // as "[object Object]" in the guest-side error handler.
    respond(webview, type, requestId, null, { code, message: String(message ?? '') });
  }

  // Filesystem helpers

  // Resolve a payload (with either `path` or `id`) to a file node.
  // Any /data/<segment>/... path belongs to whichever app's id that
  // segment is — this is the convention every fs:write/mkdir path-rewrite
  // already relies on. Re-derived from the node's own canonical path
  // (FS.getPath), never from whatever the caller claims, since an app
  // could otherwise resolve by raw id and bypass a path-based check
  // entirely.
  function filesystemRelativePath(canonicalPath) {
    const path = String(canonicalPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
    /* Linux keeps app data at ~/.local/share/novabyte/data (the tree AppDirs
       bootstraps), so the app-data root's NATIVE path is not a first-level
       child of home. Map it back to the logical /data form the ownership
       checks and picker rules are written against — before the generic
       root-relative fallback, which would otherwise expose it as a plain
       shared folder under /.local/... */
    const dataRoot = String(FS.specialFolders?.data || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (dataRoot) {
      if (path === dataRoot) return '/data';
      if (path.startsWith(`${dataRoot}/`)) return `/data${path.slice(dataRoot.length)}`;
    }
    const root = String(FS.getPath(FS.rootId) || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (path === root) return '/';
    if (root && path.startsWith(`${root}/`)) return path.slice(root.length);
    return path;
  }

  function ownerAppIdForPath(canonicalPath) {
    const m = /^\/data\/([^/]+)(?:\/|$)/.exec(filesystemRelativePath(canonicalPath));
    return m ? m[1] : null;
  }

  function ownerAppIdForNode(node, canonicalPath) {
    const canonicalOwner = ownerAppIdForPath(canonicalPath);
    if (canonicalOwner !== null) return canonicalOwner;

    const trashId = FS.specialFolders?.trash;
    const trashPath = trashId ? filesystemRelativePath(FS.getPath(trashId)) : null;
    const relativePath = filesystemRelativePath(canonicalPath);
    if (!trashId || !trashPath || !relativePath.startsWith(`${trashPath}/`)) return null;

    let current = node;
    while (current && current.id !== trashId) {
      if (current._originalParent) {
        const originalParentPath = filesystemRelativePath(FS.getPath(current._originalParent));
        return ownerAppIdForPath(`${originalParentPath}/${current.name}`);
      }
      current = FS.files.get(current.parentId);
    }
    return '\0'; // Legacy trash entries without ownership metadata fail closed.
  }

  // requireOwnAppData: true for mutations unless fs:access grants access to
  // shared user files. No grant can reach another app's private data subtree.
  // false for read — apps can see the shared/general tree (anything not
  // under any app's /data/ prefix) plus their own /data/<appId>/, but
  // never another app's /data/<otherAppId>/. This mirrors how mobile
  // scoped storage splits "your own sandboxed folder" from "the general
  // shared area" without handing out unrestricted access to other apps'
  // private data either way.
  //
  // Resolving by raw `id` used to skip this check entirely — any granted
  // filesystem grants could reach any file's node directly as long as
  // it knew (or guessed/enumerated) an id, regardless of which app's
  // /data/ folder it actually lived in. That's the bug this closes.
  // Logical fs roots (see NOVAAPP.md "Scoped filesystem roots"):
  //   appdata:<path> — the CALLING app's own /data/<appId>/<path>; there is
  //     no way to name another app's subtree with this scheme.
  //   shared:<path> / media:<path> — the shared tree (Documents, Downloads,
  //     Pictures, …) under the same permission rules as raw paths; media:
  //     is a read-intent alias. A shared:/media: root is refused if it
  //     resolves into /data — the shared roots address the shared tree, and
  //     app data stays reachable only through appdata:/raw paths where the
  //     regular ownership checks apply.
  function expandLogicalFsPath(rawPath, appId) {
    if (rawPath.startsWith('appdata:')) {
      const rest = rawPath.slice('appdata:'.length).replace(/^\/+/, '');
      // Returns the CALLER-RELATIVE /data form: rewriteDataPath/resolveFile
      // remain the single point that injects the caller's own id segment, so
      // even 'appdata:/someOtherApp/…' lands in the caller's own subtree.
      return '/data/' + rest;
    }
    if (rawPath.startsWith('shared:') || rawPath.startsWith('media:')) {
      const rest = rawPath.slice(rawPath.indexOf(':') + 1).replace(/^\/+/, '');
      const resolved = '/' + rest;
      if (resolved === '/data' || resolved.startsWith('/data/')) return null;
      return resolved;
    }
    return rawPath;
  }

  function resolveFile(payload, appId, requireOwnAppData, allowSharedMutation = false) {
    const { path, id } = payload ?? {};
    let node = null;
    if (id) {
      node = FS.files.get(id) || null;
    } else if (path) {
      const expanded = expandLogicalFsPath(String(path), appId);
      // null from expandLogicalFsPath is a refused shared:/media: mapping.
      if (expanded === null) return null;
      const rewritten = expanded.startsWith('/data/')
        ? '/data/' + appDataSegment(appId) + expanded.slice('/data'.length)
        : expanded;
      node = FS.getByPath(rewritten);
    } else {
      return null;
    }
    if (!node) return null;

    const canonicalPath = FS.getPath(node.id);
    const ownerAppId = ownerAppIdForNode(node, canonicalPath);
    const safeAppId = appDataSegment(appId);

    // Enforce filesystem ownership for every sandboxed caller. Broad access includes
    // shared user files, never another app's private data.
    if (ownerAppId !== null) {
      if (ownerAppId !== safeAppId) return null;
    } else if (requireOwnAppData && !allowSharedMutation) {
      return null;
    }
    return node;
  }

  function hasFsAccess(appId) {
    return AppPermissionManager.isGranted('fs:access', appId);
  }

  function hasPickedFileAccess(sandbox, node) {
    return !!node && (
      (sandbox?.pickedFileIds instanceof Set && sandbox.pickedFileIds.has(node.id))
      || (sandbox?.openFile?.id === node.id && sandbox.openFile.node === node)
    );
  }

  function mediaReadPermission(node) {
    if (node?.type !== 'file') return null;
    const mimeType = String(node.mimeType || '').toLowerCase();
    if (mimeType.startsWith('image/')) return 'fs:read:images';
    if (mimeType.startsWith('video/')) return 'fs:read:video';
    if (mimeType.startsWith('audio/')) return 'fs:read:audio';
    return null;
  }

  function isOwnedByApp(node, appId) {
    return ownerAppIdForNode(node, FS.getPath(node.id)) === appDataSegment(appId);
  }

  function canReadFileContents(node, appId, sandbox) {
    if (!node) return false;
    if (isOwnedByApp(node, appId) || hasFsAccess(appId) || hasPickedFileAccess(sandbox, node)) return true;
    const permission = mediaReadPermission(node);
    return permission !== null && AppPermissionManager.isGranted(permission, appId);
  }

  function canReadMetadata(node, appId, sandbox) {
    if (!node) return false;
    if (isOwnedByApp(node, appId) || hasFsAccess(appId) || hasPickedFileAccess(sandbox, node)) return true;
    return AppPermissionManager.isGranted('fs:metadata', appId)
      || canReadFileContents(node, appId, sandbox);
  }

  function canMutateFile(node, appId, sandbox) {
    if (!node) return false;
    if (isOwnedByApp(node, appId) || hasFsAccess(appId) || hasPickedFileAccess(sandbox, node)) return true;
    return false;
  }

  function confirmSharedFileChange(app, node, action) {
    if (isOwnedByApp(node, app.id) || hasFsAccess(app.id)) return true;
    if (action !== 'delete' && action !== 'overwrite') return true;
    if (typeof window?.confirm !== 'function') return null;
    return window.confirm(`Allow ${app.name || app.id} to ${action} "${node.name}"?`);
  }

  function isAppDataContainer(node) {
    return node?.type === 'folder' && filesystemRelativePath(FS.getPath(node.id)) === '/data';
  }

  function canPickerAccess(node, appId, {
    writable = false, sharedWrite = false, allowContainerNavigation = true,
  } = {}) {
    if (!node) return false;
    if (allowContainerNavigation && (node.id === FS.rootId || isAppDataContainer(node))) return true;
    return !!resolveFile({ id: node.id }, appId, writable, sharedWrite);
  }

  // Convert a file node to a safe serializable object.
  function fileToJSON(node) {
    return {
      id: node.id,
      name: node.name,
      type: node.type,
      mimeType: node.mimeType,
      size: node.size,
      path: FS.getPath(node.id),
      parentId: node.parentId,
      created: node.created,
      modified: node.modified,
      accessed: node.accessed,
      permissions: node.permissions,
      sha256: node.sha256,
      tags: node.tags || [],
    };
  }

  // Rewrite a /data/-prefixed path so the segment immediately after /data/
  // is the calling app's own id. Returns the original path unchanged if it
  // doesn't start with /data/. Used by the write/mkdir/move handlers to
  // normalize before FS.getByPath.
  function rewriteDataPath(rawPath, appId) {
    const p = String(rawPath || '');
    if (!p.startsWith('/data/')) return p;
    return '/data/' + appDataSegment(appId) + p.slice('/data'.length);
  }

  // Lazily create the caller's OWN /data/<appId>/… ancestor folders
  // (mkdir -p semantics), so a write like nova:fs:write('/data/notes/todo.txt')
  // — or the documented appdata.write('notes/todo.txt', …) example — works
  // without the app pre-creating every folder. The app's own subtree is
  // private to it: auto-creating missing folders there has no security
  // impact and removes a whole class of first-run NOT_FOUND failures for
  // apps installed through paths that don't run the AppDirs bootstrap
  // (e.g. programmatic nova:app:install, fresh profiles).
  //
  // ONLY the caller-relative own subtree is touched: the path must already
  // have been through rewriteDataPath/expandLogicalFsPath so its /data/
  // segment is the caller's own id. A missing parent anywhere else (shared
  // tree) returns null and the caller keeps its NOT_FOUND behavior.
  //
  // Returns the folder node for the deepest existing-or-created ancestor,
  // or null when the path is outside the caller's own subtree or a
  // same-named non-folder node blocks the way.
  async function ensureOwnAppDataAncestors(resolvedPath, appId) {
    const ownRoot = '/data/' + appDataSegment(appId);
    if (resolvedPath !== ownRoot && !resolvedPath.startsWith(ownRoot + '/')) return null;
    let cursor = FS.getByPath('/data');
    if (!cursor || cursor.type !== 'folder') {
      try { cursor = await FS.createFolder(FS.rootId, 'data'); } catch { return null; }
    }
    // Walk from the app segment down to the full path, creating missing
    // folders. Bail out (null) if a same-named non-folder node exists —
    // that's a genuinely invalid parent path, not a missing one.
    const segments = resolvedPath.slice('/data/'.length).split('/').filter(Boolean);
    for (const seg of segments) {
      const next = FS.listDir(cursor.id).find((n) => n.name === seg);
      if (next) {
        if (next.type !== 'folder') return null;
        cursor = next;
      } else {
        try { cursor = await FS.createFolder(cursor.id, seg); } catch { return null; }
      }
    }
    return cursor && cursor.type === 'folder' ? cursor : null;
  }

  // File dialog

  // Show a file open/save dialog. The dialog is a custom overlay so it matches
  // the AstroOS visual style. The visuals are kept identical to the original
  // implementation — only internal cleanup wiring has changed.
  function showFileDialog(mode, webview, type, requestId, app, payload, sandbox) {
    // Host-level surface: mount into the same portal ModalService uses
    // (modals.js) rather than document.body directly. #launchpad and
    // .app-window elements carry transform/backdrop-filter, which forms
    // its own stacking context — a plain z-index on a document.body child
    // doesn't reliably win against that. This root uses isolation:isolate
    // and the max-safe z-index specifically to sit above every other
    // layer regardless of what those layers set their own z-index to.
    let modalRoot = document.getElementById('system-modal-root');
    if (!modalRoot) {
      modalRoot = document.createElement('div');
      modalRoot.id = 'system-modal-root';
      Object.assign(modalRoot.style, {
        position: 'fixed',
        inset: '0',
        width: '100vw',
        height: '100vh',
        zIndex: '2147483000',
        pointerEvents: 'none',
        isolation: 'isolate',
      });
      document.body.appendChild(modalRoot);
    }

    const overlay = document.createElement('div');
    overlay.className = 'nsec-overlay';
    overlay.style.cssText = `
      position: fixed; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0,0,0,0.55);
      pointer-events: auto;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: #0e121c; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 24px; max-width: 620px; width: 92%;
      max-height: 80vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      font-family: var(--font-ui, system-ui, sans-serif);
    `;

    const title = document.createElement('h3');
    title.style.cssText = 'color: #e6edf3; margin: 0 0 4px; font-size: 16px; font-weight: 700;';
    title.textContent = mode === 'open' ? '📂 Open File' : '💾 Save File';
    dialog.appendChild(title);

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'color: #8b949e; margin: 0 0 12px; font-size: 12px;';
    subtitle.textContent = payload.title || `Select a ${mode === 'open' ? 'file to open' : 'location to save'}`;
    dialog.appendChild(subtitle);

    const filter = payload.filter || payload.accept || null;
    if (filter) {
      const filterEl = document.createElement('p');
      filterEl.style.cssText = 'color: #d29922; margin: 0 0 12px; font-size: 11px;';
      filterEl.textContent = `Filter: ${Array.isArray(filter) ? filter.join(', ') : filter}`;
      dialog.appendChild(filterEl);
    }

    const pathBar = document.createElement('div');
    pathBar.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;';
    dialog.appendChild(pathBar);

    const fileList = document.createElement('div');
    fileList.style.cssText = 'flex: 1; overflow-y: auto; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; background: rgba(255,255,255,0.02);';

    let currentFolderId = FS.rootId;
    let selectedFile = null;

    // Open mode: enforce the documented accept filter on file rows (folders
    // always stay visible for navigation). accept used to be display-only —
    // a "Filter:" label while every file stayed clickable.
    const acceptMatch = mode === 'open' ? pickerAcceptMatcher(payload.accept) : null;

    function renderFileList() {
      fileList.innerHTML = '';
      const broadAccess = hasFsAccess(app.id);
      const children = FS.listDir(currentFolderId).filter(item =>
        (mode === 'open'
          ? resolveFile({ id: item.id }, app.id)
          : resolveFile({ id: item.id }, app.id, true, broadAccess)
            || (item.type === 'folder' && isAppDataContainer(item))
        ) && (!acceptMatch || item.type === 'folder' || acceptMatch(item.name, item.mimeType))
      );

      children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      if (children.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding: 24px; text-align: center; color: #8b949e; font-size: 13px;';
        empty.textContent = '(empty folder)';
        fileList.appendChild(empty);
      }

      for (const item of children) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; border-radius: 4px; transition: background 0.1s;';
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(88,166,255,0.08)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

        const icon = document.createElement('span');
        icon.textContent = item.type === 'folder' ? '📁' : '📄';
        icon.style.fontSize = '16px';

        const name = document.createElement('span');
        name.style.cssText = 'flex: 1; color: #e6edf3; font-size: 13px;';
        name.textContent = item.name;

        const meta = document.createElement('span');
        meta.style.cssText = 'color: #8b949e; font-size: 11px; font-family: monospace;';
        if (item.type === 'file') {
          const size = item.size || 0;
          meta.textContent = size > 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B';
        }

        row.appendChild(icon);
        row.appendChild(name);
        row.appendChild(meta);

        if (item.type === 'folder') {
          row.addEventListener('click', () => {
            currentFolderId = item.id;
            renderBreadcrumb();
            renderFileList();
            selectedFile = null;
            updateConfirmState();
          });
        } else {
          row.addEventListener('click', () => {
            if (selectedFile === item.id) {
              selectedFile = null;
              row.style.background = 'transparent';
            } else {
              selectedFile = item.id;
              fileList.querySelectorAll('[data-selected]').forEach(el => {
                el.style.background = 'transparent';
                el.removeAttribute('data-selected');
              });
              row.style.background = 'rgba(88,166,255,0.15)';
              row.setAttribute('data-selected', 'true');
            }
            updateConfirmState();
          });

          if (mode === 'save' && item.name === (payload.suggestedName || '')) {
            selectedFile = item.id;
            row.style.background = 'rgba(88,166,255,0.15)';
            row.setAttribute('data-selected', 'true');
          }
        }

        fileList.appendChild(row);
      }
    }

    function renderBreadcrumb() {
      pathBar.innerHTML = '';
      const parts = [];
      let node = FS.files.get(currentFolderId);
      while (node) {
        parts.unshift(node);
        node = FS.files.get(node.parentId);
      }

      parts.forEach((part, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.style.cssText = 'color: #8b949e;';
          sep.textContent = '/';
          pathBar.appendChild(sep);
        }
        const btn = document.createElement('button');
        btn.style.cssText = 'background: none; border: none; color: #58a6ff; cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 3px;';
        btn.textContent = part.name;
        btn.addEventListener('click', () => {
          currentFolderId = part.id;
          renderBreadcrumb();
          renderFileList();
        });
        if (i === parts.length - 1) {
          btn.style.color = '#e6edf3';
          btn.style.fontWeight = '600';
          btn.style.cursor = 'default';
        }
        pathBar.appendChild(btn);
      });
    }

    let filenameInput = null;
    if (mode === 'save') {
      const inputRow = document.createElement('div');
      inputRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px;';

      const label = document.createElement('label');
      label.style.cssText = 'color: #8b949e; font-size: 12px; white-space: nowrap;';
      label.textContent = 'Filename:';

      filenameInput = document.createElement('input');
      filenameInput.type = 'text';
      filenameInput.value = payload.suggestedName || '';
      filenameInput.placeholder = 'Enter filename...';
      filenameInput.style.cssText = 'flex: 1; padding: 6px 10px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #e6edf3; font-size: 13px;';
      filenameInput.addEventListener('input', () => {
        selectedFile = null;
        updateConfirmState();
      });

      inputRow.appendChild(label);
      inputRow.appendChild(filenameInput);
      // Insert the filename row before the file list so the visual order is
      // breadcrumb → filename input → file list → buttons.
      dialog.appendChild(inputRow);
    }

    dialog.appendChild(fileList);

    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding: 8px 18px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; background: transparent; color: #8b949e; cursor: pointer; font-size: 13px; transition: all 0.15s;';
    cancelBtn.addEventListener('mouseenter', () => { cancelBtn.style.background = 'rgba(255,255,255,0.05)'; });
    cancelBtn.addEventListener('mouseleave', () => { cancelBtn.style.background = 'transparent'; });
    cancelBtn.addEventListener('click', () => {
      closeDialog();
      respond(webview, type, requestId, { cancelled: true });
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = mode === 'open' ? 'Open' : 'Save';
    confirmBtn.style.cssText = 'padding: 8px 18px; border: none; border-radius: 6px; background: #58a6ff; color: white; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s;';
    confirmBtn.addEventListener('mouseenter', () => { confirmBtn.style.background = '#3a8be6'; });
    confirmBtn.addEventListener('mouseleave', () => { confirmBtn.style.background = '#58a6ff'; });
    confirmBtn.disabled = mode === 'open';

    function updateConfirmState() {
      if (mode === 'open') {
        confirmBtn.disabled = !selectedFile;
      } else {
        confirmBtn.disabled = !(filenameInput && filenameInput.value.trim());
      }
    }

    confirmBtn.addEventListener('click', async () => {
      if (mode === 'open') {
        if (!selectedFile) return;
        const node = FS.files.get(selectedFile);
        if (!node || node.type === 'folder' || !resolveFile({ id: node.id }, app.id)) return;
        if (!(sandbox.pickedFileIds instanceof Set)) sandbox.pickedFileIds = new Set();
        sandbox.pickedFileIds.add(node.id);
        closeDialog();
        respond(webview, type, requestId, {
          success: true,
          file: {
            id: node.id,
            name: node.name,
            content: coerceFsReadContent(node.content) || '',
            mimeType: node.mimeType || 'text/plain',
            size: node.size || 0,
            path: FS.getPath(node.id),
          },
        });
      } else {
        const name = filenameInput.value.trim();
        if (!name) return;
        if (!resolveFile({ id: currentFolderId }, app.id, true, true)) {
          closeDialog();
          return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'Selected folder is outside the accessible files');
        }
        let saveData;
        try {
          saveData = normalizeFsSavePayload(payload, name);
          const newNode = await FS.createFile(currentFolderId, name, saveData.content, saveData.mimeType);
          closeDialog();
          respond(webview, type, requestId, {
            success: true,
            file: {
              id: newNode.id,
              name: newNode.name,
              path: FS.getPath(newNode.id),
            },
          });
        } catch (e) {
          closeDialog();
          respondError(webview, type, requestId, 'WRITE_ERROR', e?.message || 'Failed to write file');
        }
      }
    });

    // <webview> elements are composited by NW.js as a separate, out-of-
    // process surface — they render above ordinary same-window DOM content
    // regardless of z-index or stacking context, so #system-modal-root's
    // isolation:isolate + max z-index (which correctly beats other host
    // DOM layers like #launchpad) still loses to any running app's
    // webview. The only thing that reliably wins against a webview is
    // toggling its own visibility. Hide every active one for the
    // duration of this dialog and restore exactly the ones we hid.
    const hiddenWebviews = [];
    for (const sandbox of activeSandboxes.values()) {
      const wv = sandbox?.webview;
      if (wv && wv.style.visibility !== 'hidden') {
        hiddenWebviews.push(wv);
        wv.style.visibility = 'hidden';
      }
    }
    function restoreWebviews() {
      for (const wv of hiddenWebviews) wv.style.visibility = '';
    }

    // Closes the dialog overlay and unregisters it from the openDialogs map
    // so destroy() knows it's no longer pending.
    function closeDialog() {
      overlay.remove();
      restoreWebviews();
      const sid = webview.dataset.sandboxId;
      if (sid && openDialogs.get(sid)?.overlay === overlay) {
        openDialogs.delete(sid);
      }
    }

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(confirmBtn);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    modalRoot.appendChild(overlay);

    // Track the open dialog (plus its webview-restore callback) so destroy()
    // can clean it up fully if the sandbox is torn down while the user is
    // still picking a file — not just removing the overlay, but also
    // un-hiding whatever other apps' webviews this dialog hid.
    const sandboxId = webview.dataset.sandboxId;
    if (sandboxId) openDialogs.set(sandboxId, { overlay, restore: restoreWebviews });

    renderBreadcrumb();
    renderFileList();

    if (mode === 'save' && filenameInput) {
      setTimeout(() => filenameInput.focus(), DIALOG_FOCUS_DELAY_MS);
    }
  }

  // IPC handlers
  //
  // Each handler is a named async function that receives a context object
  // with { payload, requestId, app, webview, sandbox }. Handlers that respond
  // synchronously call respond/respondError before returning; async handlers
  // (geolocation, websocket, file dialog) return without responding and send
  // the response later from a callback.

  // Filesystem

  function getOpenFileForSandbox(sandbox, payload) {
    const grantedId = sandbox?.openFile?.id;
    if (!grantedId || payload?.id !== grantedId) return null;
    const node = FS.files.get(grantedId);
    return node?.type === 'file' && sandbox.openFile.node === node ? node : null;
  }

  async function handleFsRead({ payload, requestId, app, webview, sandbox }) {
    const selectedFile = getOpenFileForSandbox(sandbox, payload);
    const node = selectedFile || resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:read', requestId, 'NOT_FOUND', 'File or folder not found');
    if (node.type === 'folder') {
      const hasMetadataPermission = AppPermissionManager.isGranted('fs:metadata', app.id);
      const hasMediaPermission = ['fs:read:images', 'fs:read:video', 'fs:read:audio']
        .some(permission => AppPermissionManager.isGranted(permission, app.id));
      if (!isOwnedByApp(node, app.id) && !hasFsAccess(app.id)
        && !hasMetadataPermission && !hasMediaPermission) {
        return respondError(webview, 'nova:fs:read', requestId, 'PERMISSION_DENIED', 'List app-owned files directly; shared files are available through the file picker or scoped media grants');
      }
      const children = FS.listDir(node.id).filter(child =>
        resolveFile({ id: child.id }, app.id)
        && (child.type === 'folder' || canReadMetadata(child, app.id, sandbox))
      );
      return respond(webview, 'nova:fs:read', requestId, {
        success: true,
        isFolder: true,
        name: node.name,
        id: node.id,
        path: FS.getPath(node.id),
        children: children.map(c => ({
          id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
          size: c.size, modified: c.modified, created: c.created,
        })),
      });
    }
    if (!selectedFile && !canReadFileContents(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:read', requestId, 'PERMISSION_DENIED', 'App-owned files need no grant; shared files require a media read grant, a user-picked file, or fs:access');
    }
    // Accounting + audit. Owner reads only tick the byte counters; anything
    // outside the app's own subtree is audited for the privacy dashboard.
    StorageLedger.noteRequest(app.id);
    StorageLedger.noteBytes(app.id, { read: node.size || 0 });
    if (!isOwnedByApp(node, app.id)) {
      StorageLedger.recordAccess({
        appId: app.id,
        kind: selectedFile ? 'picked-file-read' : 'shared-file-read',
        detail: FS.getPath(node.id),
      });
    }
    return respond(webview, 'nova:fs:read', requestId, {
      success: true,
      data: coerceFsReadContent(node.content),
      mimeType: node.mimeType,
      name: node.name,
      size: node.size,
      id: node.id,
      path: FS.getPath(node.id),
      modified: node.modified,
      created: node.created,
    });
  }

  // Best-effort byte size of a write payload for ledger accounting.
  // Accounting is telemetry — a failure here must never fail the write.
  function ledgerWriteBytes(content) {
    try {
      const s = typeof content === 'string'
        ? content
        : (content == null ? '' : JSON.stringify(content));
      return s ? sharedTextEncoder.encode(s).length : 0;
    } catch (e) {
      return 0;
    }
  }

  // Coerce an app-supplied write payload into the string the VFS stores.
  // Strings (and null/undefined, which callers reject) pass through;
  // everything else is JSON-stringified so structured data round-trips
  // cleanly rather than becoming "[object Object]" somewhere downstream —
  // the same contract the create-file branch and nova:storage:set already
  // use. Throws on values the structured-clone bridge can carry but JSON
  // cannot (cycles, BigInt) so handlers can answer INVALID_ARGS precisely.
  function coerceFsWriteContent(content) {
    if (content == null || typeof content === 'string') return content;
    return JSON.stringify(content);
  }

  // Read-side twin of coerceFsWriteContent: whatever reaches the VFS —
  // including content stored by pre-fix builds or any non-IPC writer — an app
  // reading a file gets text it can display, never a live object that string
  // concatenation turns into "[object Object]". Strings pass through
  // untouched; null/undefined stay null so "absent" remains distinguishable;
  // everything else becomes its JSON text, exactly what the write path would
  // have stored for the same value.
  function coerceFsReadContent(content) {
    return coerceFsWriteContent(content);
  }

  async function handleFsWrite({ payload, requestId, app, webview, sandbox }) {
    const broadAccess = hasFsAccess(app.id);
    const selectedFile = getOpenFileForSandbox(sandbox, payload)
      || (payload?.id && hasPickedFileAccess(sandbox, FS.files.get(payload.id)) ? FS.files.get(payload.id) : null);
    const { path, content, mimeType } = payload ?? {};
    let fileContent;
    try {
      fileContent = coerceFsWriteContent(content);
    } catch (e) {
      return respondError(webview, 'nova:fs:write', requestId, 'INVALID_ARGS',
        `Content is not JSON-serializable: ${e?.message || e}`);
    }
    if (selectedFile) {
      if (content === undefined || content === null) {
        return respondError(webview, 'nova:fs:write', requestId, 'INVALID_ARGS', 'content is required');
      }
      const confirmed = confirmSharedFileChange(app, selectedFile, 'modify');
      if (confirmed === null) {
        return respondError(webview, 'nova:fs:write', requestId, 'UNAVAILABLE', 'User confirmation is required to modify a shared file');
      }
      if (!confirmed) return respond(webview, 'nova:fs:write', requestId, { cancelled: true });
      const saved = await FS.writeFile(selectedFile.id, fileContent);
      if (!saved) return respondError(webview, 'nova:fs:write', requestId, 'NOT_FOUND', 'Selected file no longer exists');
      StorageLedger.noteRequest(app.id);
      StorageLedger.noteBytes(app.id, { written: ledgerWriteBytes(fileContent) });
      if (!isOwnedByApp(selectedFile, app.id)) {
        StorageLedger.recordAccess({ appId: app.id, kind: 'picked-file-write', detail: FS.getPath(selectedFile.id) });
      }
      return respond(webview, 'nova:fs:write', requestId, { success: true, id: selectedFile.id });
    }
    if (!path || content === undefined || content === null) {
      return respondError(webview, 'nova:fs:write', requestId, 'INVALID_ARGS', 'path and content are required');
    }
    const expandedWritePath = expandLogicalFsPath(String(path), app.id);
    if (expandedWritePath === null) {
      return respondError(webview, 'nova:fs:write', requestId, 'PERMISSION_DENIED', 'shared:/media: roots cannot address app data');
    }
    const resolvedPath = rewriteDataPath(expandedWritePath, app.id);
    let node = FS.getByPath(resolvedPath);
    if (node) {
      if (node.type === 'folder') {
        return respondError(webview, 'nova:fs:write', requestId, 'INVALID_OPERATION', 'Cannot write to a folder');
      }
      if (!canMutateFile(node, app.id, sandbox)) {
        return respondError(webview, 'nova:fs:write', requestId, 'PERMISSION_DENIED', 'Write app-owned files directly; shared files must be selected by the user or require fs:access');
      }
      const confirmed = confirmSharedFileChange(app, node, 'modify');
      if (confirmed === null) {
        return respondError(webview, 'nova:fs:write', requestId, 'UNAVAILABLE', 'User confirmation is required to modify a shared file');
      }
      if (!confirmed) return respond(webview, 'nova:fs:write', requestId, { cancelled: true });
      await FS.writeFile(node.id, fileContent);
      StorageLedger.noteRequest(app.id);
      StorageLedger.noteBytes(app.id, { written: ledgerWriteBytes(fileContent) });
      if (!isOwnedByApp(node, app.id)) {
        StorageLedger.recordAccess({ appId: app.id, kind: 'shared-file-write', detail: FS.getPath(node.id) });
      }
      return respond(webview, 'nova:fs:write', requestId, { success: true, id: node.id });
    }
    const parts = resolvedPath.split('/').filter(Boolean);
    const fileName = parts.pop();
    const parentPath = '/' + parts.join('/');
    let parent = parts.length > 0 ? FS.getByPath(parentPath) : FS.files.get(FS.rootId);
    if (!parent && parts.length > 0) {
      // Missing parents inside the caller's OWN /data/<appId>/ subtree are
      // auto-created (see ensureOwnAppDataAncestors) so the documented
      // first-write flows work without a prior mkdir. Shared-tree paths
      // keep the NOT_FOUND below — the host must not silently grow folders
      // outside an app's private subtree.
      parent = await ensureOwnAppDataAncestors(parentPath, app.id);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:write', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    if (!resolveFile({ id: parent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:fs:write', requestId, 'PERMISSION_DENIED', 'New files can only be created in app-owned storage unless fs:access is enabled');
    }
    // fileContent was coerced by coerceFsWriteContent above (strings pass
    // through; objects/arrays/numbers are JSON-stringified), so the same
    // round-trip guarantee holds on the create branch as on every other
    // write branch — no "[object Object]" ever reaches the VFS.
    const newNode = await FS.createFile(parent.id, fileName, fileContent, mimeType || 'text/plain');
    StorageLedger.noteRequest(app.id);
    StorageLedger.noteBytes(app.id, { written: ledgerWriteBytes(fileContent) });
    return respond(webview, 'nova:fs:write', requestId, {
      success: true,
      id: newNode.id,
      path: FS.getPath(newNode.id),
    });
  }

  async function handleFsDelete({ payload, requestId, app, webview, sandbox }) {
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:delete', requestId, 'NOT_FOUND', 'File not found');
    if (node.id === FS.rootId || node.id === FS.specialFolders?.trash
      || filesystemRelativePath(FS.getPath(node.id)) === '/data') {
      return respondError(webview, 'nova:fs:delete', requestId, 'PROTECTED_LOCATION', 'System filesystem roots cannot be deleted');
    }
    if (!canMutateFile(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:delete', requestId, 'PERMISSION_DENIED', 'Delete app-owned files directly; shared files must be selected by the user or require fs:access');
    }
    const confirmed = confirmSharedFileChange(app, node, 'delete');
    if (confirmed === null) {
      return respondError(webview, 'nova:fs:delete', requestId, 'UNAVAILABLE', 'User confirmation is required to delete a shared file');
    }
    if (!confirmed) return respond(webview, 'nova:fs:delete', requestId, { cancelled: true });
    if (payload?.permanent) {
      await FS.permanentDelete(node.id);
    } else {
      await FS.deleteToTrash(node.id);
    }
    return respond(webview, 'nova:fs:delete', requestId, { success: true });
  }

  async function handleFsList({ payload, requestId, app, webview, sandbox }) {
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:list', requestId, 'NOT_FOUND', 'Folder not found');
    if (node.type !== 'folder') {
      return respondError(webview, 'nova:fs:list', requestId, 'INVALID_OPERATION', 'Path is not a folder');
    }
    const hasMetadataPermission = AppPermissionManager.isGranted('fs:metadata', app.id);
    const hasMediaPermission = ['fs:read:images', 'fs:read:video', 'fs:read:audio']
      .some(permission => AppPermissionManager.isGranted(permission, app.id));
    if (!isOwnedByApp(node, app.id) && !hasFsAccess(app.id)
      && !hasMetadataPermission && !hasMediaPermission) {
      return respondError(webview, 'nova:fs:list', requestId, 'PERMISSION_DENIED', 'List app-owned files directly; shared files are available through the file picker or scoped media grants');
    }
    const children = FS.listDir(node.id).filter(child =>
      resolveFile({ id: child.id }, app.id)
      && (child.type === 'folder' || canReadMetadata(child, app.id, sandbox))
    );
    return respond(webview, 'nova:fs:list', requestId, {
      success: true,
      path: FS.getPath(node.id),
      files: children.map(c => ({
        id: c.id, name: c.name, type: c.type, mimeType: c.mimeType,
        size: c.size, modified: c.modified, created: c.created,
      })),
    });
  }

  async function handleMediaQuery({ payload, requestId, app, webview, sandbox }) {
    const type = payload?.type || 'all';
    const permissionForType = {
      image: 'fs:read:images',
      audio: 'fs:read:audio',
      video: 'fs:read:video',
    };
    if (!['all', 'image', 'audio', 'video'].includes(type)) {
      return respondError(webview, 'nova:media:query', requestId, 'INVALID_ARGS', 'type must be all, image, audio, or video');
    }

    const hasMetadata = AppPermissionManager.isGranted('fs:metadata', app.id);
    const readableTypes = type === 'all' ? Object.values(permissionForType) : [permissionForType[type]];
    if (!hasMetadata && !hasFsAccess(app.id) &&
        !readableTypes.some(permission => AppPermissionManager.isGranted(permission, app.id))) {
      return respondError(webview, 'nova:media:query', requestId, 'PERMISSION_DENIED', 'Media queries require a matching media-read grant, fs:metadata, or fs:access');
    }

    const mediaStore = window.AstroOSMediaStore;
    if (!mediaStore || typeof mediaStore.query !== 'function') {
      return respondError(webview, 'nova:media:query', requestId, 'UNAVAILABLE', 'AstroOS MediaStore is unavailable');
    }
    const indexed = mediaStore.query({
      type,
      offset: payload?.offset,
      limit: payload?.limit,
    });
    const files = indexed.filter(file => {
      const node = FS.files.get(file.id);
      return node?.type === 'file'
        && resolveFile({ id: file.id }, app.id)
        && canReadMetadata(node, app.id, sandbox);
    });
    return respond(webview, 'nova:media:query', requestId, { files });
  }

  async function handleFsMkdir({ payload, requestId, app, webview }) {
    const broadAccess = hasFsAccess(app.id);
    const { path, name } = payload ?? {};
    if (!name || typeof name !== 'string') {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'INVALID_ARGS', 'name is required');
    }
    // rewriteDataPath returns '' for null/undefined path; treat that as
    // "root" so a caller can mkdir directly under the app's /data/<appId>/.
    const expandedMkdirPath = expandLogicalFsPath(String(path ?? ''), app.id);
    if (expandedMkdirPath === null) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'PERMISSION_DENIED', 'shared:/media: roots cannot address app data');
    }
    const resolvedPath = rewriteDataPath(expandedMkdirPath, app.id);
    let parent;
    if (resolvedPath) {
      parent = FS.getByPath(resolvedPath);
      if (!parent) {
        // mkdir '/data/' on a fresh install: the app's own root may not
        // exist yet (AppDirs only bootstraps system packages). Create the
        // caller-relative ancestors rather than failing NOT_FOUND on the
        // app's very first mkdir.
        parent = await ensureOwnAppDataAncestors(resolvedPath, app.id);
      }
    } else {
      parent = FS.files.get(FS.rootId);
    }
    if (!parent || parent.type !== 'folder') {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'NOT_FOUND', 'Parent folder not found');
    }
    if (!resolveFile({ id: parent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:fs:mkdir', requestId, 'PERMISSION_DENIED', 'Folders can only be created in app-owned storage unless fs:access is enabled');
    }
    const newFolder = await FS.createFolder(parent.id, name);
    return respond(webview, 'nova:fs:mkdir', requestId, {
      success: true,
      id: newFolder.id,
      path: FS.getPath(newFolder.id),
    });
  }

  async function handleFsStat({ payload, requestId, app, webview, sandbox }) {
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:stat', requestId, 'NOT_FOUND', 'File not found');
    if (!canReadMetadata(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:stat', requestId, 'PERMISSION_DENIED', 'Shared file metadata requires fs:metadata or the matching media read grant');
    }
    return respond(webview, 'nova:fs:stat', requestId, { success: true, stat: fileToJSON(node) });
  }

  async function handleFsRename({ payload, requestId, app, webview, sandbox }) {
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:rename', requestId, 'NOT_FOUND', 'File not found');
    if (!canMutateFile(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:rename', requestId, 'PERMISSION_DENIED', 'Rename app-owned files directly; shared files must be selected by the user or require fs:access');
    }
    const confirmed = confirmSharedFileChange(app, node, 'rename');
    if (confirmed === null) {
      return respondError(webview, 'nova:fs:rename', requestId, 'UNAVAILABLE', 'User confirmation is required to rename a shared file');
    }
    if (!confirmed) return respond(webview, 'nova:fs:rename', requestId, { cancelled: true });
    if (!payload.name) {
      return respondError(webview, 'nova:fs:rename', requestId, 'INVALID_ARGS', 'name is required');
    }
    await FS.rename(node.id, payload.name);
    return respond(webview, 'nova:fs:rename', requestId, { success: true, name: payload.name });
  }

  async function handleFsMove({ payload, requestId, app, webview, sandbox }) {
    const broadAccess = hasFsAccess(app.id);
    const node = resolveFile(payload, app.id);
    if (!node) return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'File not found');
    if (!canMutateFile(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:move', requestId, 'PERMISSION_DENIED', 'Move app-owned files directly; shared files must be selected by the user or require fs:access');
    }
    const confirmed = confirmSharedFileChange(app, node, 'move');
    if (confirmed === null) {
      return respondError(webview, 'nova:fs:move', requestId, 'UNAVAILABLE', 'User confirmation is required to move a shared file');
    }
    if (!confirmed) return respond(webview, 'nova:fs:move', requestId, { cancelled: true });
    const expandedDestPath = expandLogicalFsPath(String(payload.destPath ?? ''), app.id);
    if (expandedDestPath === null) {
      return respondError(webview, 'nova:fs:move', requestId, 'PERMISSION_DENIED', 'shared:/media: roots cannot address app data');
    }
    const destPath = rewriteDataPath(expandedDestPath, app.id);
    const destParent = destPath ? FS.getByPath(destPath) : null;
    if (!destParent || destParent.type !== 'folder') {
      return respondError(webview, 'nova:fs:move', requestId, 'NOT_FOUND', 'Destination folder not found');
    }
    // Same requireOwnAppData=true rule applies to the destination: a move
    // is still a mutation even though it only touches the target folder's
    // listing, not the target's own content — an app moving its own file
    // into another app's /data/<otherAppId>/ would otherwise be able to
    // plant files there despite never having write access to that folder
    // directly.
    if (!resolveFile({ id: destParent.id }, app.id, true, broadAccess)) {
      return respondError(webview, 'nova:fs:move', requestId, 'PERMISSION_DENIED', 'Destination folder is outside this app\'s data directory');
    }
    await FS.move(node.id, destParent.id);
    return respond(webview, 'nova:fs:move', requestId, { success: true, path: FS.getPath(node.id) });
  }

  // Notifications

  async function handleNotificationsShow({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Notify may be absent in headless test environments. Report UNAVAILABLE
    // rather than silently claiming success — apps deserve to know. Check
    // this BEFORE the rate limit counter, otherwise an environment without
    // Notify would still burn a rate-limit slot for every call, eventually
    // throttling the app for "spamming" notifications that never actually
    // rendered anywhere.
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') {
      return respondError(webview, 'nova:notifications:show', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    if (!checkNotificationRateLimit(app.id)) {
      return respondError(webview, 'nova:notifications:show', requestId, 'RATE_LIMITED', `Max ${NOTIF_RATE_LIMIT_MAX} notifications per minute`);
    }
    Notify.show(sanitizeNotificationPayload(payload, app.name, app.id));
    return respond(webview, 'nova:notifications:show', requestId, { success: true });
  }

  async function handleNotificationsClear({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:clear', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.clearForApp !== 'function') {
      return respondError(webview, 'nova:notifications:clear', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.clearForApp(app.id);
    return respond(webview, 'nova:notifications:clear', requestId, { success: true });
  }

  // ── Notifications v2 ────────────────────────────────────────────────────
  // Channels + tagged update-in-place + app-declared actions + progress.
  // The permission model is unchanged (device:notifications covers all of
  // it, still risk:'low'); the v1 show/clear channels above stay untouched
  // for compatibility and keep their 10/min new-post budget.

  async function handleNotificationsCreateChannel({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:createChannel', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.ensureChannel !== 'function') {
      return respondError(webview, 'nova:notifications:createChannel', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    seedManifestNotificationChannels(app.id);
    const def = payload ?? {};
    const id = typeof def.id === 'string' && def.id.length >= 1 && def.id.length <= NOTIF_CHANNEL_ID_MAX ? def.id : null;
    if (!id || !NOTIF_SLUG_RE.test(id)) {
      return respondError(webview, 'nova:notifications:createChannel', requestId, 'INVALID_ARGS',
        `channel id must match ${NOTIF_SLUG_RE} and be <= ${NOTIF_CHANNEL_ID_MAX} chars`);
    }
    const existing = Notify.listChannels(app.id);
    const alreadyDeclared = existing.some((ch) => ch.id === id);
    if (!alreadyDeclared && existing.length >= NOTIF_CHANNEL_LIMIT) {
      return respondError(webview, 'nova:notifications:createChannel', requestId, 'LIMIT_REACHED',
        `Max ${NOTIF_CHANNEL_LIMIT} channels per app`);
    }
    const res = Notify.ensureChannel(app.id, { id, name: def.name, importance: def.importance, description: def.description });
    if (!res) {
      return respondError(webview, 'nova:notifications:createChannel', requestId, 'INVALID_ARGS',
        'channel requires a non-empty name (<= 60 chars)');
    }
    // Android parity: importance is locked at creation. Report the effective
    // importance back so an app trying to change it learns it was a no-op.
    const effective = Notify.getChannel(app.id, res.channel.id);
    return respond(webview, 'nova:notifications:createChannel', requestId, {
      success: true,
      created: res.created,
      channel: { id: res.channel.id, name: res.channel.name, importance: effective ? effective.importance : res.channel.importance },
    });
  }

  async function handleNotificationsPost({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:post', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    // Same UNAVAILABLE-before-rate-limit ordering as the v1 handler: an
    // environment without Notify must not burn rate-limit slots.
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function' || typeof Notify.getChannel !== 'function') {
      return respondError(webview, 'nova:notifications:post', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    seedManifestNotificationChannels(app.id);
    const payloadV2 = sanitizeNotificationPayloadV2(payload, app.name, app.id);
    const channel = Notify.getChannel(app.id, payloadV2.channelId);
    if (!channel) {
      return respondError(webview, 'nova:notifications:post', requestId, 'INVALID_ARGS',
        `Unknown notification channel '${payloadV2.channelId}' — create it first (nova:notifications:createChannel) or declare notifications.channels in the manifest`);
    }
    if (channel.blocked) {
      // A muted channel isn't an app error — the user chose this. Report
      // success with posted:false so apps can tell "muted" apart from
      // "rate limited" or "malformed" without a distinct error path.
      return respond(webview, 'nova:notifications:post', requestId, { success: true, posted: false, reason: 'CHANNEL_MUTED', importance: channel.importance });
    }
    const isUpdate = !!(payloadV2.tag && Notify.findByTag(app.id, payloadV2.tag));
    const underLimit = isUpdate
      ? checkNotificationUpdateRateLimit(app.id)
      : checkNotificationRateLimit(app.id);
    if (!underLimit) {
      const max = isUpdate ? NOTIF_UPDATE_RATE_LIMIT_MAX : NOTIF_RATE_LIMIT_MAX;
      return respondError(webview, 'nova:notifications:post', requestId, 'RATE_LIMITED',
        `Max ${max} notification ${isUpdate ? 'updates' : 'posts'} per minute`);
    }
    const notif = Notify.show(payloadV2);
    return respond(webview, 'nova:notifications:post', requestId, {
      success: true,
      posted: !!notif,
      updated: isUpdate,
      id: notif ? notif.id : null,
      importance: channel.importance,
    });
  }

  async function handleNotificationsCancel({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:cancel', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.cancelByTag !== 'function') {
      return respondError(webview, 'nova:notifications:cancel', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    const { tag, id } = payload ?? {};
    let removed = false;
    if (typeof tag === 'string' && tag) {
      removed = Notify.cancelByTag(app.id, tag);
    } else if (typeof id === 'string' && id) {
      removed = Notify.cancelById(app.id, id);
    } else {
      return respondError(webview, 'nova:notifications:cancel', requestId, 'INVALID_ARGS', 'either tag or id is required');
    }
    return respond(webview, 'nova:notifications:cancel', requestId, { success: true, removed });
  }

  async function handleNotificationsCancelAll({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:cancelAll', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.clearForApp !== 'function') {
      return respondError(webview, 'nova:notifications:cancelAll', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    Notify.clearForApp(app.id);
    return respond(webview, 'nova:notifications:cancelAll', requestId, { success: true });
  }

  // Action delivery is a pull queue: the host opens the app when an action
  // is tapped, and the app drains whatever actions accumulated — including
  // ones clicked while it wasn't running — via this call on launch/resume.
  // Push delivery to a live sandbox is a later refinement (it needs a new
  // guest-side push handler in the injected bridge).
  async function handleNotificationsConsumeActions({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:notifications', app.id)) {
      return respondError(webview, 'nova:notifications:consumeActions', requestId, 'PERMISSION_DENIED', 'device:notifications permission required');
    }
    if (typeof Notify === 'undefined' || typeof Notify.consumePendingActions !== 'function') {
      return respondError(webview, 'nova:notifications:consumeActions', requestId, 'UNAVAILABLE', 'Notification service not available');
    }
    const actions = Notify.consumePendingActions(app.id);
    return respond(webview, 'nova:notifications:consumeActions', requestId, { success: true, actions });
  }

  // Background wake (system:background)
  //
  // Lets a wake handler signal early completion — see AppScheduler.wake,
  // which is the only thing that ever creates the kind of sandbox this
  // gets called from. No permission check needed here: by the time this
  // sandbox exists at all, the scheduler has already verified
  // system:background before spinning it up, and this call does nothing
  // more than flip a flag the scheduler is already polling for.
  async function handleBackgroundWakeDone({ requestId, app, webview }) {
    const sandboxId = webview?.dataset?.sandboxId;
    if (sandboxId && typeof AppScheduler !== 'undefined' && typeof AppScheduler._markWakeDone === 'function') {
      AppScheduler._markWakeDone(sandboxId);
    }
    return respond(webview, 'nova:background:wake-done', requestId, { success: true });
  }

  // Background live (system:background:live)
  //
  // Opts a sandbox into being kept alive if its window closes. This is
  // the piece that was missing: closeWindow() previously backgrounded
  // *any* app holding system:background:live on every close, purely
  // because the grant existed — with no way for the app (or the user, via
  // some in-app "run in background" toggle) to say whether this
  // particular session actually wants that. Holding the permission is
  // necessary but was wrongly being treated as sufficient. Now
  // closeWindow checks this per-sandbox flag in addition to the grant.
  //
  // Deliberately session-only (not persisted): the app calls this each
  // time it wants the current session kept alive, e.g. right when the
  // user clicks its own "run in background" button. Nothing carries over
  // to the next launch automatically.
  async function handleBackgroundStayAlive({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:background:live', app.id)) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'PERMISSION_DENIED', 'system:background:live permission required');
    }
    const sandboxId = webview.dataset.sandboxId;
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      return respondError(webview, 'nova:background:stay-alive', requestId, 'UNAVAILABLE', 'Sandbox not found');
    }
    // enabled defaults true — nova.stayAliveInBackground() with no args
    // means "yes, keep me alive"; passing { enabled: false } lets an app
    // change its mind before it actually closes.
    sandbox.wantsBackgroundLive = payload?.enabled !== false;
    return respond(webview, 'nova:background:stay-alive', requestId, { success: true, enabled: sandbox.wantsBackgroundLive });
  }

  // Settings keys apps holding system:info may read. This used to be a
  // denylist (block these specific sensitive keys, allow everything else by
  // default) — structurally fragile, since every new sensitive settings key
  // added later had to be remembered and added here manually, or it was
  // exposed to any app with system:info by default. Flipped to an allowlist
  // so new keys fail closed instead of open.
  //
  // This list was built by grepping every OS.settings.get()/.set() call
  // site in the codebase (including the sGet() alias used in boot.js) as of
  // this change — it's a snapshot, not derived automatically, so it will
  // drift if a new settings key is added without updating this list too.
  // A key missing from here isn't a bug in itself (it fails closed, the
  // safe direction) but will make legitimate new settings silently
  // unreadable by apps until this list is updated.
  //
  // Deliberately excluded (must stay unreadable regardless of system:info):
  // lockPin, pinSalt, biometricCredentialId, bootPassword — credentials or
  // auth material the OS itself needs to keep private. lockoutUntil and
  // wrongPinCount are also excluded, though for a different reason: they
  // live on the in-memory OS object directly (OS.lockoutUntil,
  // OS.wrongPinCount in kernel.js/system-events.js), never through
  // OS.settings at all, so they were never reachable through this handler
  // in the first place — excluded here only for defense-in-depth in case
  // that ever changes.
  // NOTE: read (system:info) and write (system:settings) are separate,
  // higher/lower-trust grants, so they don't have to share one list.
  // osVersion is the one key here that's fine to read but shouldn't be
  // app-writable: boot.js uses it purely to track the running OS build
  // (`if (sGet('osVersion') !== codeVer) OS.settings.set('osVersion',
  // codeVer)`), and an app overwriting it via nova:settings:set could
  // interfere with that version-detection logic for no legitimate benefit.
  // SETTINGS_WRITABLE_KEYS below additionally excludes devMode, which must
  // only change through the OS-owned Settings confirmation flow.
  const SETTINGS_READABLE_KEYS = new Set([
    '_hiddenDevIconPositions', 'accentColor', 'autoLock', 'browserPartitionId',
    'clockFormat', 'cursorSize', 'customWallpaper', 'debugOverlayVisible',
    'desktopGridSpacing', 'desktopIconPositions', 'desktopIconSize', 'devMode',
    'filesViewOnly', 'highContrast', 'osVersion', 'pinnedApps',
    'prohibitWallpaperChange', 'reduceMotion', 'region', 'removeTransparency',
    'showDesktopIcons', 'showTaskbarClock', 'taskbarAutoHide', 'taskbarPosition',
    'taskbarSize', 'theme', 'timezone', 'username', 'wallpaperId',
  ]);

  const SETTINGS_WRITABLE_KEYS = new Set(
    [...SETTINGS_READABLE_KEYS].filter((k) => k !== 'osVersion' && k !== 'devMode')
  );

  async function handleSettingsGet({ payload, requestId, app, webview }) {
    // system:info gates read access — otherwise any app could read credentials
    // or other sensitive settings keys.
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const key = payload?.key;
    if (typeof key !== 'string' || !key) {
      return respondError(webview, 'nova:settings:get', requestId, 'INVALID_ARGS', 'key is required');
    }
    if (!SETTINGS_READABLE_KEYS.has(key)) {
      return respondError(webview, 'nova:settings:get', requestId, 'PERMISSION_DENIED', `Settings key '${key}' is not readable by apps`);
    }
    const value = OS?.settings?.get(key);
    return respond(webview, 'nova:settings:get', requestId, { success: true, value });
  }

  // The two app-writable wallpaper keys have distinct value shapes:
  //   wallpaperId     — a WALLPAPER_PRESETS id ('stock-blue', 'stock-dark', …)
  //                     or null/'' to fall back to the default preset;
  //   customWallpaper — a string image URL (the Settings app stores a data:
  //                     URL) or null/'' to clear it.
  // Validating here turns a silent no-op (applyWallpaper falls back to
  // stock-blue for an unknown id — an app could "succeed" while changing
  // nothing) into an immediate INVALID_ARGS the developer can see.
  function wallpaperPresetIds() {
    try {
      const presets = window.WallpaperService?.getPresets?.();
      if (Array.isArray(presets) && presets.length) {
        return new Set(presets.map((p) => p.id));
      }
    } catch (_) { /* service unavailable — skip id validation */ }
    return null;
  }

  function validateWallpaperSetting(key, value) {
    if (value === null || value === undefined || value === '') return null;
    if (key === 'wallpaperId') {
      if (typeof value !== 'string') {
        return 'wallpaperId must be a preset id string (stock-blue, stock-dark, …) or null';
      }
      const ids = wallpaperPresetIds();
      if (ids && !ids.has(value)) {
        return `Unknown wallpaperId '${value.slice(0, 60)}' — use a preset id (see WallpaperService.getPresets()) or null to clear`;
      }
      return null;
    }
    // customWallpaper
    if (typeof value !== 'string') {
      return 'customWallpaper must be a string image URL (data: URL) or null to clear';
    }
    return null;
  }

  async function handleSettingsSetWithType({ payload, requestId, app, webview }, type) {
    const key = payload?.key;
    if (typeof key !== 'string' || !key) {
      return respondError(webview, type, requestId, 'INVALID_ARGS', 'key is required');
    }
    // Wallpaper change is a low-risk ambient capability, not a permission
    // prompt — Android treats it the same way, any app can change the
    // wallpaper without a runtime permission. It bypasses the system:settings
    // grant but is still subject to the writable-key allowlist and the
    // prohibitWallpaperChange policy toggle (checked in OS.settings.set
    // itself, so a locked-down kiosk can still block it).
    const isWallpaperKey = key === 'wallpaperId' || key === 'customWallpaper';
    if (!isWallpaperKey && !AppPermissionManager.isGranted('system:settings', app.id)) {
      return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'system:settings permission required');
    }
    if (!SETTINGS_WRITABLE_KEYS.has(key)) {
      return respondError(webview, type, requestId, 'PERMISSION_DENIED', `Settings key '${key}' is not writable by apps`);
    }
    if (isWallpaperKey) {
      const invalidReason = validateWallpaperSetting(key, payload?.value);
      if (invalidReason) {
        return respondError(webview, type, requestId, 'INVALID_ARGS', invalidReason);
      }
    }
    if (typeof OS?.settings?.set !== 'function') {
      return respondError(webview, type, requestId, 'UNAVAILABLE', 'Settings service not available');
    }
    if (OS.settings.set(key, payload?.value) === false && isWallpaperKey) {
      return respondError(webview, type, requestId, 'POLICY_BLOCKED', 'Wallpaper changes are disabled by system policy');
    }
    return respond(webview, type, requestId, { success: true });
  }

  async function handleSettingsSet(args) {
    return handleSettingsSetWithType(args, 'nova:settings:set');
  }

  async function handleWallpaperSet({ payload, requestId, app, webview }) {
    const key = payload?.key;
    if (key !== 'wallpaperId' && key !== 'customWallpaper') {
      return respondError(webview, 'nova:wallpaper:set', requestId, 'INVALID_ARGS', "key must be 'wallpaperId' or 'customWallpaper'");
    }
    return handleSettingsSetWithType({ payload, requestId, app, webview }, 'nova:wallpaper:set');
  }

  // ── AstroOS Registry (nova:reg:*) ───────────────────────────────
  //
  // The engine (window.NovaRegistry — js/platform/core/nova-registry.js)
  // owns storage, typing, quotas and the change events; these handlers own
  // the SECURITY rules on top:
  //
  //   read (registry.read)   — every hive EXCEPT the HKNS/security/**
  //                            subtree, which needs registry.system.
  //   write (registry.write) — only the caller's own HKNA/<app.id>/**
  //                            subtree. System apps may also write HKNS
  //                            (still never HKNS/security without
  //                            registry.system). HKNU needs registry.system
  //                            OR a matching registryScopes.write prefix —
  //                            declared in the manifest, or the built-in
  //                            HKNU/software/<appId> default for manifests
  //                            that declare no registryScopes at all.
  //                            HKND additionally requires Developer Mode.
  //   registry.system        — full access everywhere (devMode still gates
  //                            HKND: it is a dev scratch hive by
  //                            definition).
  //
  // On top of the hive rules, per-key ACLs from the engine (setAcl) are
  // evaluated for every caller without registry.system: any ACL chain that
  // covers the path must grant the actor (the calling app id, or '*') the
  // needed right. Bare key paths address the key's default value — the
  // engine resolves that, the handlers just stop rejecting them.
  //
  // The MAC front door (SEED_ENDPOINT_GRANTS) already required the flat
  // grant before we run; these checks are the context-dependent half.
  // Watching is reading: nova:reg:changed is gated on registry.read via
  // EVENT_DOMAIN_PERMISSIONS, and the v2 facade builds registry.watch() on
  // the events bus rather than a separate channel family.
  //
  // The channels are deliberately NOT in ISOLATED_PROCESS_API_TYPES: the
  // registry engine lives in the OS page, and background/isolated processes
  // have no business mutating live OS config.

  function regEngine() {
    return (typeof window !== 'undefined' && window.NovaRegistry) || null;
  }

  function regReadDeniedReason(app, parsed) {
    if (AppPermissionManager.isGranted('registry.system', app.id)) return null;
    if (!AppPermissionManager.isGranted('registry.read', app.id)) return 'registry.read permission required';
    if (parsed.hive === 'HKNS' && parsed.segments[0] === 'security') {
      return 'HKNS/security is only readable with registry.system';
    }
    return regAclDenied(app, parsed, 'read');
  }

  // Manifest-declared registry scopes: registryScopes.write may name
  // designated prefixes that unlock HKNU writes without registry.system
  // (and document intended HKNA usage). Scopes can never unlock HKNS
  // (including HKNS/security) or another app's HKNA subtree — those stay
  // exactly where the base rules put them. registryScopes.read is
  // advisory: reads are already broad, and HKNS/security is never
  // scope-grantable.
  //
  // Defaults for third-party manifests: an app whose manifest declares NO
  // registryScopes field still gets ONE designated write prefix — its own
  // HKNU/software/<appId> subtree, the user-scoped slice that mirrors
  // HKCU\Software\<App>. Declaring the field at all (even an empty object)
  // opts out — an explicit empty scope list means "no designated keys".
  // System apps never receive the default: they either hold registry.system
  // or declare their intents explicitly.
  function regDefaultScopes(app, mode) {
    if (mode !== 'write' || !app || app.system === true) return null;
    if (app.registryScopes !== undefined) return null; // explicit declaration wins, even when empty
    if (typeof app.id !== 'string' || !app.id) return null;
    return ['HKNU/software/' + app.id];
  }

  function regScopeAllows(app, parsed, mode) {
    let scopes = app?.registryScopes?.[mode];
    if (!Array.isArray(scopes) || !scopes.length) scopes = regDefaultScopes(app, mode);
    if (!Array.isArray(scopes) || !scopes.length) return false;
    if (parsed.hive === 'HKNS') return false; // system hive is never scope-grantable
    if (parsed.hive === 'HKND') return false; // dev scratch stays devMode-gated
    if (parsed.hive === 'HKNA' && mode === 'write' && parsed.segments[0] !== app.id) return false;
    const engine = regEngine();
    if (!engine) return false;
    return scopes.some((raw) => {
      if (typeof raw !== 'string') return false;
      const scope = engine._internal.parsePath(raw);
      if (scope.error) return false;
      return parsed.path === scope.path || parsed.path.startsWith(scope.path + '/');
    });
  }

  // Engine-side per-key ACL evaluation. No ACL chain → granted (the engine
  // stays policy-neutral); any covering chain → the actor (calling app id
  // or '*') must hold the right.
  function regAclDenied(app, parsed, need) {
    const engine = regEngine();
    if (!engine || typeof engine.checkAccess !== 'function') return null;
    const verdict = engine.checkAccess(parsed.path, app.id, need);
    return verdict.granted ? null : `key ACL denies ${need}: ${verdict.reason}`;
  }

  function regWriteDeniedReason(app, parsed) {
    if (AppPermissionManager.isGranted('registry.system', app.id)) {
      if (parsed.hive === 'HKND' && OS?.settings?.get('devMode') !== true) {
        return 'HKND requires Developer Mode';
      }
      return null;
    }
    if (!AppPermissionManager.isGranted('registry.write', app.id)) return 'registry.write permission required';
    if (parsed.hive === 'HKNA') {
      if (parsed.segments[0] !== app.id) return 'apps may only write their own HKNA/<appId>/ subtree';
      return regAclDenied(app, parsed, 'write');
    }
    if (parsed.hive === 'HKNS') {
      if (app.system !== true) return 'writing HKNS requires a system app';
      if (parsed.segments[0] === 'security') return 'HKNS/security is only writable with registry.system';
      return regAclDenied(app, parsed, 'write');
    }
    if (parsed.hive === 'HKNU') {
      if (regScopeAllows(app, parsed, 'write')) return null;
      return 'writing HKNU requires registry.system';
    }
    if (parsed.hive === 'HKND') {
      if (OS?.settings?.get('devMode') !== true) return 'HKND requires Developer Mode';
      return regAclDenied(app, parsed, 'write');
    }
    return 'unsupported hive';
  }

  function regParseOrError(webview, type, requestId, rawPath) {
    const engine = regEngine();
    if (!engine) {
      respondError(webview, type, requestId, 'UNAVAILABLE', 'Registry service not available');
      return null;
    }
    const parsed = engine._internal.parsePath(rawPath);
    if (parsed.error) {
      respondError(webview, type, requestId, parsed.error, parsed.message);
      return null;
    }
    return parsed;
  }

  function regEngineError(webview, type, requestId, err) {
    const code = err && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR';
    respondError(webview, type, requestId, code, err?.message || 'Registry operation failed');
  }

  async function handleRegGet({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:get';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    // A bare key path is fine here: since engine v2 it addresses the key's
    // default value (found: false when unset), Windows-style.
    const denied = regReadDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    try {
      const entry = regEngine().stat(parsed.path);
      if (!entry) return respond(webview, TYPE, requestId, { found: false, path: parsed.path });
      const out = { found: true, path: parsed.path, type: entry.type, data: entry.data, lastModified: entry.lastModified };
      if (entry.type === 'REG_EXPAND_SZ' && typeof entry.expanded === 'string') out.expanded = entry.expanded;
      return respond(webview, TYPE, requestId, out);
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
  }

  async function handleRegSet({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:set';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    // A bare key path writes the key's default value (engine v2).
    const denied = regWriteDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    if (!Object.prototype.hasOwnProperty.call(payload ?? {}, 'value')) {
      return respondError(webview, TYPE, requestId, 'INVALID_ARGS', 'value is required (null is only valid for REG_JSON)');
    }
    let committed;
    try {
      committed = regEngine().set(parsed.path, payload.value, {
        type: typeof payload.type === 'string' ? payload.type : undefined,
        appId: app.id,
        source: 'app',
      });
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
    // Registry → settings live-apply used to be duplicated here; since the
    // settings shim (platform/core/settings-shim.js) subscribes to
    // nova:reg:changed centrally, every external write — app or system —
    // already syncs OS.settings and re-emits 'settings:changed'. Nothing
    // more to do: the registry IS the source of truth.
    return respond(webview, TYPE, requestId, { success: true, path: committed.path, type: committed.type });
  }

  async function handleRegDelete({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:delete';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    if (parsed.segments.length < 1) {
      return respondError(webview, TYPE, requestId, 'INVALID_ARGS', 'path must name a value or key');
    }
    const denied = regWriteDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    try {
      const result = regEngine().remove(parsed.path, {
        recursive: payload?.recursive === true,
        appId: app.id,
        source: 'app',
      });
      return respond(webview, TYPE, requestId, { success: true, path: result.path, removed: result.removed });
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
  }

  async function handleRegList({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:list';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    const denied = regReadDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    try {
      const listing = regEngine().list(parsed.path);
      if (!listing) return respondError(webview, TYPE, requestId, 'NOT_FOUND', `no such key: ${parsed.path}`);
      return respond(webview, TYPE, requestId, listing);
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
  }

  async function handleRegExport({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:export';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    const denied = regReadDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    try {
      return respond(webview, TYPE, requestId, { path: parsed.path, data: regEngine().export(parsed.path) });
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
  }

  async function handleRegImport({ payload, requestId, app, webview }) {
    const TYPE = 'nova:reg:import';
    const parsed = regParseOrError(webview, TYPE, requestId, payload?.path);
    if (!parsed) return;
    if (parsed.segments.length < 1) {
      return respondError(webview, TYPE, requestId, 'INVALID_ARGS', 'import needs a target key path');
    }
    const denied = regWriteDeniedReason(app, parsed);
    if (denied) return respondError(webview, TYPE, requestId, 'PERMISSION_DENIED', denied);
    try {
      const result = regEngine().import(parsed.path, payload?.data, { appId: app.id, source: 'app' });
      return respond(webview, TYPE, requestId, { success: true, path: result.path, merged: result.merged });
    } catch (err) { return regEngineError(webview, TYPE, requestId, err); }
  }

  async function handleNestedWebview({ payload, requestId, app, webview, sandbox }) {
    if (!sandbox?.nestedWebviewOptedIn
      || typeof AppPermissionManager === 'undefined'
      || AppPermissionManager.isGranted('sandbox:nested-webview', app?.id) !== true) {
      return respondError(webview, 'nova:nested-webview', requestId, 'PERMISSION_DENIED', 'sandbox:nested-webview permission required');
    }
    const service = window.NovaSystemWebview;
    if (typeof service?.handleRequest !== 'function') {
      return respondError(webview, 'nova:nested-webview', requestId, 'UNAVAILABLE', 'Astro System Webview service is unavailable');
    }
    return service.handleRequest({
      payload,
      requestId,
      app,
      webview,
      sandbox,
      callbacks: {
        respond,
        respondError,
        generateRequestId,
        log,
        canNavigate: url => canNestedWebviewNavigate(app, url),
        setupPermissionRequestGate: child => setupPermissionRequestGate(child, app),
      },
    });
  }

  async function handleContextMenuShow({ payload, requestId, app, webview, sandbox }) {
    if (!isNestedWebviewPermitted(app)) {
      return respondError(webview, 'nova:context-menu:show', requestId, 'PERMISSION_DENIED', 'sandbox:nested-webview permission required');
    }
    const hostContextMenu = window.ContextMenu;
    if (typeof hostContextMenu?.show !== 'function'
      || typeof webview?.getBoundingClientRect !== 'function'
      || !sandbox) {
      return respondError(webview, 'nova:context-menu:show', requestId, 'UNAVAILABLE', 'Host context menus are unavailable');
    }
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    const items = payload?.items;
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || !Array.isArray(items) || items.length === 0 || items.length > 100) {
      return respondError(webview, 'nova:context-menu:show', requestId, 'INVALID_ARGS', 'A context menu requires finite coordinates and 1-100 items');
    }

    const menuItems = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return respondError(webview, 'nova:context-menu:show', requestId, 'INVALID_ARGS', 'Each context menu item must be an object');
      }
      if (item.separator === true) {
        menuItems.push({ separator: true });
        continue;
      }
      if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120
        || (item.icon !== undefined && (typeof item.icon !== 'string' || item.icon.length > 64))
        || (item.shortcut !== undefined && (typeof item.shortcut !== 'string' || item.shortcut.length > 32))
        || (item.disabled !== undefined && typeof item.disabled !== 'boolean')
        || (item.danger !== undefined && typeof item.danger !== 'boolean')) {
        return respondError(webview, 'nova:context-menu:show', requestId, 'INVALID_ARGS', 'Invalid context menu item');
      }
      menuItems.push({
        label: item.label,
        icon: item.icon,
        shortcut: item.shortcut,
        disabled: item.disabled === true,
        danger: item.danger === true,
        _selectionIndex: menuItems.length,
      });
    }
    if (!menuItems.some(item => !item.separator)) {
      return respondError(webview, 'nova:context-menu:show', requestId, 'INVALID_ARGS', 'A context menu must contain a selectable item');
    }

    const rect = webview.getBoundingClientRect();
    let resolveSelection;
    const selection = new Promise(resolve => { resolveSelection = resolve; });
    sandbox.contextMenuCleanup?.();
    let menuElement;
    const cleanup = () => {
      if (sandbox.contextMenuCleanup === cleanup) sandbox.contextMenuCleanup = null;
      /* Unfreeze the guests this menu hid — see the freeze below. */
      window.NovaSystemWebview?.restoreSandbox?.(sandbox);
      hostContextMenu.hide(menuElement);
    };
    /* The menu MUST be shown synchronously (apps are allowed to dismiss it
       in the same tick, and a newer show must cleanly replace this one), so
       it renders before the guests are frozen: the freeze kicks off right
       after and pops the menu above the captured stills once it lands. The
       menu is body-level host DOM: it loses to every webview guest AND,
       while its window is focused, to the window itself (.context-menu sits
       at --z-popup while focused windows are raised above it) — hence both
       the freeze and the z-index raise. */
    menuElement = hostContextMenu.show(rect.left + x, rect.top + y, menuItems, resolveSelection);
    const windowZ = Number(sandbox.state?.element?.style?.zIndex);
    if (menuElement && Number.isFinite(windowZ)) menuElement.style.zIndex = String(windowZ + 1);
    sandbox.contextMenuCleanup = cleanup;
    window.NovaSystemWebview?.freezeSandbox?.(sandbox)?.catch?.(() => {});

    const selectedIndex = await selection;
    if (sandbox.contextMenuCleanup === cleanup) sandbox.contextMenuCleanup = null;
    return respond(webview, 'nova:context-menu:show', requestId, {
      cancelled: selectedIndex === null,
      index: selectedIndex,
    });
  }

  async function handleContextMenuHide({ requestId, webview, sandbox }) {
    const wasOpen = typeof sandbox?.contextMenuCleanup === 'function';
    sandbox?.contextMenuCleanup?.();
    return respond(webview, 'nova:context-menu:hide', requestId, { success: true, wasOpen });
  }

  async function handleOverlayShow({ payload, requestId, app, webview, sandbox }) {
    if (!isNestedWebviewPermitted(app)) {
      return respondError(webview, 'nova:overlay:show', requestId, 'PERMISSION_DENIED', 'sandbox:nested-webview permission required');
    }
    if (typeof document === 'undefined'
      || typeof document.createElement !== 'function'
      || typeof document.body?.appendChild !== 'function'
      || typeof DOMPurify === 'undefined'
      || typeof DOMPurify.sanitize !== 'function'
      || typeof webview?.getBoundingClientRect !== 'function'
      || !sandbox) {
      return respondError(webview, 'nova:overlay:show', requestId, 'UNAVAILABLE', 'Host app overlays are unavailable');
    }

    const html = payload?.html;
    const css = payload?.css === undefined ? '' : payload.css;
    const bounds = payload?.bounds && typeof payload.bounds === 'object' ? payload.bounds : {};
    const initialRect = webview.getBoundingClientRect();
    if (typeof html !== 'string' || html.length > 100_000
      || typeof css !== 'string' || css.length > 50_000) {
      return respondError(webview, 'nova:overlay:show', requestId, 'INVALID_ARGS', 'Overlay HTML and CSS must be strings within the size limits');
    }
    const requested = [
      bounds.left ?? 0,
      bounds.top ?? 0,
      bounds.width ?? webview.clientWidth ?? initialRect.width,
      bounds.height ?? webview.clientHeight ?? initialRect.height,
    ].map(Number);
    if (!requested.every(Number.isFinite) || requested[2] <= 0 || requested[3] <= 0) {
      return respondError(webview, 'nova:overlay:show', requestId, 'INVALID_ARGS', 'Overlay bounds require finite coordinates and positive dimensions');
    }

    let sanitizedHtml;
    try {
      sanitizedHtml = DOMPurify.sanitize(html, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'link'],
        FORBID_ATTR: ['srcdoc'],
      });
    } catch (error) {
      return respondError(webview, 'nova:overlay:show', requestId, 'SANITIZE_FAILED', error?.message || 'Could not sanitize overlay HTML');
    }

    const iframe = document.createElement('iframe');
    const hostWindow = sandbox.state?.element;
    const overlayParent = hostWindow?.isConnected && typeof hostWindow.appendChild === 'function'
      ? hostWindow
      : document.body;
    const windowScoped = overlayParent !== document.body;
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('aria-label', `${app.name || app.id} overlay`);
    iframe.style.position = windowScoped ? 'absolute' : 'fixed';
    iframe.style.border = '0';
    iframe.style.zIndex = '2147483647';
    iframe.style.background = 'transparent';
    iframe.style.display = 'block';
    iframe.style.overflow = 'hidden';
    const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;min-height:100%;background:transparent}</style></head><body></body></html>`;

    const overlayId = generateRequestId();
    const cleanups = [];
    let responseSent = false;
    const updateBounds = () => {
      if (!iframe.isConnected) return;
      const rect = webview.getBoundingClientRect();
      const maxWidth = Math.max(0, webview.clientWidth || rect.width);
      const maxHeight = Math.max(0, webview.clientHeight || rect.height);
      const left = Math.max(0, Math.min(maxWidth, requested[0]));
      const top = Math.max(0, Math.min(maxHeight, requested[1]));
      let hostLeft = rect.left + left;
      let hostTop = rect.top + top;
      if (windowScoped) {
        const windowRect = hostWindow.getBoundingClientRect();
        hostLeft -= windowRect.left;
        hostTop -= windowRect.top;
      }
      iframe.style.left = `${hostLeft}px`;
      iframe.style.top = `${hostTop}px`;
      iframe.style.width = `${Math.min(requested[2], maxWidth - left)}px`;
      iframe.style.height = `${Math.min(requested[3], maxHeight - top)}px`;
    };
    const cleanup = () => {
      if (sandbox.overlayCleanup === cleanup) sandbox.overlayCleanup = null;
      /* The sandbox's webviews were frozen (hidden behind captured stills) so
         this overlay could composite above them — restore them on the way
         out, whatever path led here. */
      window.NovaSystemWebview?.restoreSandbox?.(sandbox);
      if (!responseSent) {
        responseSent = true;
        respondError(webview, 'nova:overlay:show', requestId, 'CANCELLED', 'Overlay was closed before rendering completed');
      }
      for (const remove of cleanups) remove();
      iframe.remove();
    };
    sandbox.overlayCleanup?.();
    sandbox.overlayCleanup = cleanup;
    const renderTimeout = setTimeout(() => {
      if (responseSent) return;
      responseSent = true;
      cleanup();
      respondError(webview, 'nova:overlay:show', requestId, 'RENDER_FAILED', 'Timed out while loading the host overlay');
    }, 15_000);
    cleanups.push(() => clearTimeout(renderTimeout));

    const onLoad = () => {
      if (sandbox.overlayCleanup !== cleanup) {
        cleanup();
        return;
      }
      try {
        const overlayDocument = iframe.contentDocument;
        if (!overlayDocument?.body || !overlayDocument.head) throw new Error('Overlay document is unavailable');
        const style = overlayDocument.createElement('style');
        style.textContent = css;
        overlayDocument.head.appendChild(style);
        overlayDocument.body.innerHTML = sanitizedHtml;

        const forwardEvent = event => {
          const eventTarget = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
          if (event.type === 'submit' || eventTarget?.closest?.('a')) event.preventDefault();
          const target = eventTarget?.closest?.('[data-nova-action], [data-nova-field]');
          if (!target) return;
          const result = {
            overlayId,
            type: event.type,
            action: target.getAttribute('data-nova-action')?.slice(0, 100) || null,
            field: target.getAttribute('data-nova-field')?.slice(0, 100) || null,
          };
          if (typeof target.value === 'string') result.value = target.value.slice(0, 4096);
          if (typeof target.checked === 'boolean') result.checked = target.checked;
          if (typeof event.key === 'string') result.key = event.key.slice(0, 64);
          respond(webview, 'nova:overlay:event', generateRequestId(), result);
        };
        for (const eventName of ['click', 'input', 'change', 'submit', 'keydown']) {
          overlayDocument.addEventListener(eventName, forwardEvent);
          cleanups.push(() => overlayDocument.removeEventListener(eventName, forwardEvent));
        }
        updateBounds();
        window.addEventListener('resize', updateBounds);
        window.addEventListener('scroll', updateBounds, true);
        window.addEventListener('pointermove', updateBounds, { passive: true });
        cleanups.push(() => {
          window.removeEventListener('resize', updateBounds);
          window.removeEventListener('scroll', updateBounds, true);
          window.removeEventListener('pointermove', updateBounds);
        });
        responseSent = true;
        return respond(webview, 'nova:overlay:show', requestId, { success: true, overlayId });
      } catch (error) {
        responseSent = true;
        cleanup();
        return respondError(webview, 'nova:overlay:show', requestId, 'RENDER_FAILED', error?.message || 'Could not render app overlay');
      }
    };
    iframe.addEventListener('load', onLoad, { once: true });
    iframe.addEventListener('error', () => {
      if (responseSent) return;
      responseSent = true;
      cleanup();
      respondError(webview, 'nova:overlay:show', requestId, 'RENDER_FAILED', 'Could not load the host overlay document');
    }, { once: true });
    /* Host DOM always loses to a <webview> guest surface (regardless of
       z-index), so freeze the sandbox's guests into captured stills before
       the overlay iframe is appended — otherwise this overlay renders
       behind the app's webview and the nested webview and is invisible. */
    try { await window.NovaSystemWebview?.freezeSandbox?.(sandbox); } catch (_) { /* overlay still renders, page may blank */ }
    overlayParent.appendChild(iframe);
    return undefined;
  }

  async function handleOverlayHide({ requestId, webview, sandbox }) {
    const wasOpen = typeof sandbox?.overlayCleanup === 'function';
    sandbox?.overlayCleanup?.();
    return respond(webview, 'nova:overlay:hide', requestId, { success: true, wasOpen });
  }

  // Permission requests

  async function handleRequestPermission({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:request-permission', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const granted = await AppPermissionManager.requestPermission(permission, app.id, {
        reason: payload.reason || `${app.name} wants to access this permission.`,
        permanent: payload.permanent !== false,
      });
      return respond(webview, 'nova:request-permission', requestId, { granted });
    } catch (e) {
      return respondError(webview, 'nova:request-permission', requestId, 'ERROR', e?.message || 'Permission request failed');
    }
  }

  // Lets a caller check rate-limit/cooldown status for a permission without
  // triggering a new prompt — e.g. the Permissions app showing "try again in
  // Ns" instead of blindly calling requestPermission and eating a silent deny.
  async function handlePermissionRateLimited({ payload, requestId, app, webview }) {
    const { permission } = payload ?? {};
    if (!permission) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'INVALID_ARGS', 'permission is required');
    }
    try {
      const status = AppPermissionManager.isRateLimited(permission, app.id);
      return respond(webview, 'nova:permission-rate-limited', requestId, status);
    } catch (e) {
      return respondError(webview, 'nova:permission-rate-limited', requestId, 'ERROR', e?.message || 'Rate limit check failed');
    }
  }

  // Window management
  //
  // These all no-op silently when WM or the window state is missing, then
  // return success. This matches the original behaviour — window operations
  // are best-effort from the app's perspective.

  async function handleWindowClose({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
      WM.closeWindow(windowId);
    }
    return respond(webview, 'nova:window:close', requestId, { success: true });
  }

  async function handleWindowMinimize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.minimizeWindow === 'function') {
      WM.minimizeWindow(windowId);
    }
    return respond(webview, 'nova:window:minimize', requestId, { success: true });
  }

  async function handleWindowMaximize({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && typeof WM !== 'undefined' && typeof WM.toggleMaximize === 'function') {
      WM.toggleMaximize(windowId);
    }
    return respond(webview, 'nova:window:maximize', requestId, { success: true });
  }

  async function handleWindowSetTitle({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && OS?.windows?.get) {
      const state = OS.windows.get(windowId);
      if (state && state.titleText) {
        // Cap the title so an app can't blow the title bar's layout or
        // OOM the WM's title-state tracking with a multi-megabyte string.
        const title = String(payload?.title ?? '').slice(0, 200);
        state.titleText.textContent = title;
      }
    }
    return respond(webview, 'nova:window:setTitle', requestId, { success: true });
  }

  async function handleWindowResize({ payload, requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    if (windowId && OS?.windows?.get) {
      const state = OS.windows.get(windowId);
      if (state && state.element) {
        // parseInt with explicit radix and a minimum bound to prevent
        // zero/negative sizes that would render the window unusable.
        const w = parsePositiveInt(payload?.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_DIMENSION);
        const h = parsePositiveInt(payload?.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_DIMENSION);
        state.element.style.width = w + 'px';
        state.element.style.height = h + 'px';
        state.width = w;
        state.height = h;
        if (state.maximized) {
          state.maximized = false;
          state.element.classList.remove('maximized');
        }
      }
    }
    return respond(webview, 'nova:window:resize', requestId, { success: true });
  }

  async function handleWindowGetState({ requestId, sandbox, webview }) {
    const windowId = sandbox?.windowId;
    const state = windowId && OS?.windows?.get ? OS.windows.get(windowId) : null;
    if (!state) {
      return respondError(webview, 'nova:window:getState', requestId, 'NOT_FOUND', 'Window not found');
    }
    return respond(webview, 'nova:window:getState', requestId, {
      success: true,
      id: state.id,
      x: state.x, y: state.y,
      width: state.width, height: state.height,
      maximized: !!state.maximized,
      minimized: !!state.minimized,
    });
  }

  // Clipboard

  // The system clipboard is a shared, ambient, cross-app channel. It has
  // dedicated permissions rather than inheriting file access.
  function clipboardReadPermitted(appId) {
    return AppPermissionManager.isGranted('clipboard:read', appId);
  }
  function clipboardWritePermitted(appId) {
    return AppPermissionManager.isGranted('clipboard:write', appId);
  }

  async function handleClipboardRead({ requestId, app, webview }) {
    if (!clipboardReadPermitted(app.id)) {
      return respondError(webview, 'nova:clipboard:read', requestId, 'PERMISSION_DENIED', 'clipboard:read permission required for clipboard access');
    }
    let text = null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      // No permission / no focus / insecure context — fall back to the
      // last value this OS instance itself wrote, rather than failing
      // outright, so same-session copy/paste inside Nova still works.
      text = OS.clipboard || null;
    }
    return respond(webview, 'nova:clipboard:read', requestId, {
      success: true,
      text: text,
    });
  }

  async function handleClipboardWrite({ payload, requestId, app, webview }) {
    if (!clipboardWritePermitted(app.id)) {
      return respondError(webview, 'nova:clipboard:write', requestId, 'PERMISSION_DENIED', 'clipboard:write permission required for clipboard access');
    }
    // ?? not || — a payload of { text: 0 } or { text: false } should still
    // write a real value, not silently become the empty-string default.
    const text = payload?.text ?? '';
    try {
      // Actually write to the real system clipboard. navigator.clipboard
      // requires a secure context + (usually) a recent user gesture; if it
      // rejects (no focus, no gesture, permission denied), fall back to the
      // legacy execCommand path before giving up entirely.
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // try/finally ensures the textarea is always removed from the DOM
      // even if select() or execCommand throws — the previous version
      // leaked the element on a select() failure.
      let ok = false;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      try {
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      } finally {
        ta.remove();
      }
      if (!ok) {
        return respondError(webview, 'nova:clipboard:write', requestId, 'CLIPBOARD_UNAVAILABLE', 'Could not write to the system clipboard: ' + (err && err.message ? err.message : String(err)));
      }
    }
    OS.clipboard = text;
    if (!OS.clipboardHistory) OS.clipboardHistory = [];
    if (typeof text === 'string' && text && !OS.clipboardHistory.includes(text)) {
      OS.clipboardHistory.unshift(text);
      if (OS.clipboardHistory.length > CLIPBOARD_HISTORY_MAX) OS.clipboardHistory.pop();
    }
    return respond(webview, 'nova:clipboard:write', requestId, { success: true });
  }

  // Downloads
  //
  // <webview> guests can't reach the host's real filesystem or trigger a
  // native save dialog directly (they're intentionally non-Node frames —
  // see nodeintegration=false above). The capability shim in a guest
  // intercepts <a download> clicks on blob: URLs, reads the blob bytes,
  // and ships them here as base64. This handler is what actually shows
  // the SystemDialogs "Save As" and writes the bytes to disk — it only
  // runs in the top-level shell window, which IS a Node frame, so
  // SystemDialogs and Node's fs module both work here.
  //
  // No standing permission is required for this — the native save dialog
  // itself is the control: the app can propose a filename and bytes, but
  // the user always sees and confirms the real destination before
  // anything touches disk. That mirrors how a normal browser download
  // works, and is a deliberate departure from path-based file writes
  // above, which writes into novabyte-os's own virtual FS without a
  // per-write prompt.
  //
  // No size cap: like Android's DownloadManager there is no artificial
  // byte limit on what a user-approved download may contain. The payload
  // is still buffered in memory (base64 over the bridge, then a Buffer),
  // so enormous files fail on their own footprint rather than a policy
  // number — the user's explicit save-dialog confirmation is the control.

  function sanitizeDownloadFilename(name) {
    const fallback = 'download';
    if (!name || typeof name !== 'string') return fallback;
    // Strip any path components — this is a filename, not a path. Also
    // strip null bytes and other control characters some OSes mishandle.
    let base = name.replace(/[\\/]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
    base = base.replace(/^\.+/, ''); // no leading dots (hidden files / '..' games)
    if (!base) return fallback;
    return base.slice(0, 255); // filesystem-safe length cap
  }

  async function handleDownload({ payload, requestId, app, webview }) {
    const { filename, mimeType, base64Data } = payload ?? {};
    if (typeof base64Data !== 'string' || !base64Data) {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is required');
    }
    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch {
      return respondError(webview, 'nova:download', requestId, 'INVALID_ARGS', 'base64Data is not valid base64');
    }

    const safeName = sanitizeDownloadFilename(filename);

    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:download', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    if (typeof require !== 'function') {
      return respondError(webview, 'nova:download', requestId, 'UNAVAILABLE', 'Node fs module not available in this context');
    }
    let fs;
    try { fs = require('fs'); } catch (e) {
      return respondError(webview, 'nova:download', requestId, 'UNAVAILABLE', `Could not load fs module: ${e?.message || e}`);
    }

    // Cap how long we wait for the save dialog — if the user walks away
    // without dismissing it, the IPC call would otherwise hang forever.
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), DOWNLOAD_DIALOG_TIMEOUT_MS);
    });
    const picked = await Promise.race([
      window.SystemDialogs.save({ title: 'Save Download', suggestedName: safeName }),
      timeout,
    ]).catch((e) => ({ error: e }));
    clearTimeout(timer);

    if (picked === 'timeout') {
      return respondError(webview, 'nova:download', requestId, 'TIMEOUT', 'Save dialog timed out');
    }
    if (picked?.error) {
      return respondError(webview, 'nova:download', requestId, 'IO_ERROR', picked.error?.message || 'Save dialog failed');
    }
    if (!picked) {
      return respond(webview, 'nova:download', requestId, { success: false, cancelled: true });
    }

    try {
      await fs.promises.writeFile(picked.path, buffer);
    } catch (err) {
      return respondError(webview, 'nova:download', requestId, 'IO_ERROR', err?.message || 'Failed to write file');
    }
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'AppSandbox',
        category: 'downloads',
        severity: 'info',
        message: `${app?.id || 'unknown'}: saved download "${safeName}" (${buffer.length} bytes)`,
        data: { appId: app?.id, filename: safeName, size: buffer.length, mimeType: mimeType || null },
      });
    }
    return respond(webview, 'nova:download', requestId, { success: true });
  }

  // App lifecycle

  const crossAppLaunchRateLimits = new Map();
  /* Launch rate limits exist because these are programmatic calls with no
     user-gesture signal: a buggy or hostile app looping on launch would
     otherwise spam window creation with no other guard in front of
     WM.createWindow. The budgets are set far above any human flow (opening
     and closing apps repeatedly) but far below a runaway loop, so real users
     never see RATE_LIMITED from normal use. Launches from the desktop
     launcher/taskbar go through WM directly and are not limited. */
  const LAUNCH_RATE_LIMIT_MAX = 30;
  const HOME_ALWAYS_LAUNCHABLE_APP_IDS = new Set([
    'com.astroos.settings',
    'com.astroos.appmanager',
  ]);

  async function handleAppLaunch({ payload, requestId, app, webview }) {
    // Launching an installed app is a separate, low-risk capability from
    // enumerating, installing, or uninstalling applications.
    if (!AppPermissionManager.isGranted('system:app-launch', app.id)
      && !AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'system:app-launch permission required');
    }
    const now = Date.now();
    const launchTimes = (crossAppLaunchRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (launchTimes.length >= LAUNCH_RATE_LIMIT_MAX) {
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respondError(webview, 'nova:app:launch', requestId, 'RATE_LIMITED', `Max ${LAUNCH_RATE_LIMIT_MAX} cross-app launches per minute`);
    }
    const { appId, options } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (!OS?.settings?.get?.('devMode')) {
      const target = OS?.apps?.[appId];
      if (target?.devOnly) {
        return respondError(webview, 'nova:app:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
      }
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const launchOptions = options && typeof options === 'object' && !Array.isArray(options)
        ? { ...options }
        : {};
      // File access must come from a host user-selection flow, never app-supplied launch options.
      delete launchOptions.fileIntent;
      delete launchOptions.fileId;
      delete launchOptions.folderId;
      const win = WM.createWindow(appId, launchOptions);
      launchTimes.push(now);
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respond(webview, 'nova:app:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:launch', requestId, 'ERROR', e?.message || 'Launch failed');
    }
  }

  function isActiveHomeCaller(app, sandbox) {
    return !!app?.id
      && sandbox?.homeSurface === true
      && typeof DefaultApps !== 'undefined'
      && DefaultApps.getDefault('home') === app.id;
  }

  function getHomeAppListEntry(app) {
    return {
      id: app.id,
      name: app.name || app.id,
      version: app.version || '1.0.0',
      iconUrl: resolveSandboxAppIcon(app.icon),
      description: app.description || '',
      categories: Array.isArray(app.categories) ? app.categories.slice() : [],
      system: app.system === true || app.manifest?.system === true,
    };
  }

  async function handleHomeAppsList({ requestId, app, sandbox, webview }) {
    if (!isActiveHomeCaller(app, sandbox)) {
      return respondError(webview, 'nova:home:apps:list', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can list apps');
    }
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:home:apps:list', requestId, 'UNAVAILABLE', 'App registry not available');
    }

    const canListAll = AppPermissionManager.isGranted('system:apps', app.id);
    const apps = APP_REGISTRY.filter(candidate =>
      (canListAll || HOME_ALWAYS_LAUNCHABLE_APP_IDS.has(candidate.id))
      && (OS?.settings?.get?.('devMode') || candidate.devOnly !== true)
    ).map(getHomeAppListEntry);
    return respond(webview, 'nova:home:apps:list', requestId, {
      success: true,
      apps,
      fullAccess: canListAll,
    });
  }

  async function handleHomeAppsLaunch({ payload, requestId, app, sandbox, webview }) {
    if (!isActiveHomeCaller(app, sandbox)) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can launch apps');
    }
    const appId = typeof payload?.appId === 'string' ? payload.appId : '';
    if (!appId) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'INVALID_ARGS', 'appId is required');
    }

    const registryEntry = typeof APP_REGISTRY !== 'undefined' && Array.isArray(APP_REGISTRY)
      ? APP_REGISTRY.find(candidate => candidate.id === appId)
      : null;
    const target = OS?.apps?.[appId];
    if (!registryEntry || !target) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'NOT_FOUND', 'App is not registered');
    }
    if (!OS?.settings?.get?.('devMode') && (registryEntry.devOnly === true || target.devOnly === true)) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'Developer Mode must be enabled to launch this app');
    }
    const hasLaunchPermission = AppPermissionManager.isGranted('system:app-launch', app.id)
      || AppPermissionManager.isGranted('system:apps', app.id);
    if (!HOME_ALWAYS_LAUNCHABLE_APP_IDS.has(appId) && !hasLaunchPermission) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'PERMISSION_DENIED', 'system:app-launch permission required for this app');
    }

    const now = Date.now();
    const launchTimes = (crossAppLaunchRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (launchTimes.length >= LAUNCH_RATE_LIMIT_MAX) {
      crossAppLaunchRateLimits.set(app.id, launchTimes);
      return respondError(webview, 'nova:home:apps:launch', requestId, 'RATE_LIMITED', `Max ${LAUNCH_RATE_LIMIT_MAX} Home app launches per minute`);
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:home:apps:launch', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow(appId);
      if (win) {
        launchTimes.push(now);
        crossAppLaunchRateLimits.set(app.id, launchTimes);
      }
      return respond(webview, 'nova:home:apps:launch', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (error) {
      return respondError(webview, 'nova:home:apps:launch', requestId, 'ERROR', error?.message || 'Launch failed');
    }
  }

  async function handleEmailOpenLink({ payload, requestId, app, webview }) {
    if (app.id !== 'com.astroos.email' || app.verified !== true || app.signer !== 'Astro System' || app.manifest?.system !== true) {
      return respondError(webview, 'nova:email:open-link', requestId, 'PERMISSION_DENIED', 'Email link bridge denied');
    }

    let url;
    try {
      url = new URL(payload?.url);
    } catch {
      return respondError(webview, 'nova:email:open-link', requestId, 'INVALID_ARGS', 'A valid HTTP(S) URL is required');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return respondError(webview, 'nova:email:open-link', requestId, 'INVALID_ARGS', 'Only credential-free HTTP(S) links can be opened');
    }

    try {
      const win = WM.createWindow('com.astroos.browser', { url: url.href });
      if (!win) {
        return respondError(webview, 'nova:email:open-link', requestId, 'UNAVAILABLE', 'Browser could not be opened');
      }
      return respond(webview, 'nova:email:open-link', requestId, { success: true, windowId: win.id });
    } catch (e) {
      return respondError(webview, 'nova:email:open-link', requestId, 'ERROR', e?.message || 'Could not open Browser');
    }
  }

  async function handleOpenUrl({ payload, requestId, webview }) {
    let url;
    try {
      url = new URL(payload?.url);
    } catch {
      return respondError(webview, 'nova:open-url', requestId, 'INVALID_ARGS', 'A valid HTTP(S) URL is required');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return respondError(webview, 'nova:open-url', requestId, 'INVALID_ARGS', 'Only credential-free HTTP(S) links can be opened');
    }
    if (typeof OS?.openUrl !== 'function') {
      return respondError(webview, 'nova:open-url', requestId, 'UNAVAILABLE', 'OS URL service not available');
    }
    try {
      const win = OS.openUrl(url.href);
      if (!win) {
        return respondError(webview, 'nova:open-url', requestId, 'UNAVAILABLE', 'No default browser app could be opened');
      }
      return respond(webview, 'nova:open-url', requestId, { success: true, windowId: win.id });
    } catch (e) {
      return respondError(webview, 'nova:open-url', requestId, 'ERROR', e?.message || 'Could not open the OS default browser app');
    }
  }

  async function handleOpenWith({ payload, requestId, app, webview, sandbox }) {
    const fileId = payload?.fileId;
    if (typeof fileId !== 'string' || !fileId || fileId.length > 200) {
      return respondError(webview, 'nova:open-with', requestId, 'INVALID_ARGS', 'A fileId is required');
    }
    const node = getOpenFileForSandbox(sandbox, { id: fileId })
      || resolveFile({ id: fileId }, app.id);
    if (!node || node.type !== 'file') {
      return respondError(webview, 'nova:open-with', requestId, 'NOT_FOUND', 'File is unavailable to this app');
    }
    if (typeof window.showOpenWithDialog !== 'function') {
      return respondError(webview, 'nova:open-with', requestId, 'UNAVAILABLE', 'Open with chooser is unavailable');
    }
    try {
      const result = await window.showOpenWithDialog(node);
      return respond(webview, 'nova:open-with', requestId, result || { cancelled: true });
    } catch (error) {
      return respondError(webview, 'nova:open-with', requestId, 'ERROR', error?.message || 'Could not open the file chooser');
    }
  }

  const shareRateLimits = new Map();
  function handleShare({ payload, requestId, app, webview }) {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : app?.name || 'Share';
    let url = '';
    if (payload?.url !== undefined) {
      try {
        const parsed = new URL(payload.url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
        url = parsed.href;
      } catch {
        return respondError(webview, 'nova:share', requestId, 'INVALID_ARGS', 'url must be a credential-free HTTP(S) URL');
      }
    }
    if ((!text && !url) || text.length > 4000) {
      return respondError(webview, 'nova:share', requestId, 'INVALID_ARGS', 'Share requires text or a URL; text is limited to 4000 characters');
    }
    const now = Date.now();
    const recent = (shareRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (recent.length >= 5) {
      shareRateLimits.set(app.id, recent);
      return respondError(webview, 'nova:share', requestId, 'RATE_LIMITED', 'Max 5 share sheets per minute');
    }
    recent.push(now);
    shareRateLimits.set(app.id, recent);
    if (!document?.body) {
      return respondError(webview, 'nova:share', requestId, 'UNAVAILABLE', 'Share sheet is not available');
    }

    const overlay = document.createElement('div');
    const sandboxId = webview?.dataset?.sandboxId;
    overlay.setAttribute('role', 'presentation');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;';
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Share');
    dialog.style.cssText = 'width:min(420px,100%);padding:20px;border-radius:14px;background:var(--surface,#242424);color:var(--text,#fff);box-shadow:0 18px 60px #0008;font:14px system-ui,sans-serif;';
    const heading = document.createElement('h2');
    heading.textContent = title;
    heading.style.cssText = 'font-size:18px;margin:0 0 8px;';
    const preview = document.createElement('p');
    preview.textContent = text || url;
    preview.style.cssText = 'margin:0 0 16px;overflow-wrap:anywhere;opacity:.8;max-height:100px;overflow:auto;';
    const actions = document.createElement('div');
    actions.style.cssText = 'display:grid;gap:8px;';
    dialog.append(heading, preview, actions);
    overlay.appendChild(dialog);

    return new Promise(resolve => {
      let settled = false;
      let cancelShare;
      const untrack = () => {
        const dialogs = shareDialogs.get(sandboxId);
        if (!dialogs) return;
        dialogs.delete(cancelShare);
        if (dialogs.size === 0) shareDialogs.delete(sandboxId);
      };
      const finish = result => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        untrack();
        respond(webview, 'nova:share', requestId, result);
        resolve();
      };
      const fail = error => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        untrack();
        respondError(webview, 'nova:share', requestId, 'SHARE_FAILED', error?.message || String(error));
        resolve();
      };
      const onKeyDown = event => {
        if (event.key === 'Escape') finish({ cancelled: true });
      };
      const addAction = (label, action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'min-height:40px;padding:8px 12px;border:1px solid #ffffff22;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit;';
        button.addEventListener('click', async () => {
          try {
            const result = await action();
            finish({ cancelled: false, action: label, ...result });
          } catch (error) {
            fail(error);
          }
        });
        actions.appendChild(button);
      };
      if (text || url) {
        addAction('Copy', async () => {
          const value = [text, url].filter(Boolean).join('\n');
          OS.clipboard = value;
          OS.clipboardHistory ||= [];
          if (!OS.clipboardHistory.includes(value)) {
            OS.clipboardHistory.unshift(value);
            if (OS.clipboardHistory.length > 30) OS.clipboardHistory.pop();
          }
          return {};
        });
      }
      if (url && typeof OS?.openUrl === 'function') {
        addAction('Open link in browser', () => {
          if (!OS.openUrl(url)) throw new Error('Could not open the default browser');
          return {};
        });
      }
      if (typeof OS?.openMailto === 'function') {
        addAction('Email', () => {
          const body = [text, url].filter(Boolean).join('\n');
          OS.openMailto('mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body));
          return {};
        });
      }
      // Inbound share targets (system:share-target): apps that declared a
      // shareTarget in their manifest and hold the user grant. The user
      // picks one — that IS the delivery consent — and the target receives
      // a nova:share:inbound push now (live) or on its next launch (queued).
      try {
        const shareContent = { text: text, url: url };
        const targets = Object.values(OS?.apps || {})
          .filter((a) => a && a.id && a.id !== app?.id
            && shareTargetMatches(normalizedShareTargetMimes(a), shareContent)
            && AppPermissionManager.isGranted('system:share-target', a.id))
          .slice(0, SHARE_TARGET_SHEET_MAX);
        for (const target of targets) {
          const targetId = target.id;
          const targetName = target.name || targetId;
          addAction('Send to ' + targetName, async () => {
            const outcome = deliverShareTarget(targetId, { title: title, text: text, url: url, sourceAppId: app?.id || null });
            if (!outcome.delivered && typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
              try { WM.createWindow(targetId); } catch (_) { /* window opening is best-effort */ }
            }
            return { sharedWith: targetName, queued: outcome.queued === true };
          });
        }
      } catch (_) { /* targets are an enhancement; the sheet works without them */ }
      addAction('Cancel', async () => ({ cancelled: true }));
      overlay.addEventListener('click', event => {
        if (event.target === overlay) finish({ cancelled: true });
      });
      document.addEventListener('keydown', onKeyDown);
      document.body.appendChild(overlay);
      cancelShare = () => finish({ cancelled: true });
      if (sandboxId) {
        let dialogs = shareDialogs.get(sandboxId);
        if (!dialogs) shareDialogs.set(sandboxId, dialogs = new Set());
        dialogs.add(cancelShare);
      }
      actions.querySelector('button')?.focus();
    });
  }

  // Lets an app send the user to Settings → Default Apps — the "Set as
  // default" button pattern every OS has (Windows' "Make default" link in
  // an installer, Android apps deep-linking into
  // Settings > Apps > Default apps). The app cannot change the default
  // itself; it can only bring the user to the picker, same as the real
  // thing — the actual choice always happens through a human clicking an
  // option in nook, never through this call.
  //
  // On the *why this can't require a genuine click* point: this handler
  // runs after the request has already crossed the sandboxed webview's
  // MessageChannel port (see setupAPIBridge / claimHandshake above). A
  // browser's real click-to-postMessage user-activation state is not
  // preserved across that boundary — nothing server-side can distinguish
  // "app.apps.openDefaultAppsSettings() called from a real onclick" from
  // "called from setInterval." Treating the guest as untrusted (which the
  // whole sandbox already does) means we can't lean on the guest telling
  // us it was a click. The mitigation actually available at this layer is
  // the same one used for notifications: a sliding-window rate limit, so
  // a misbehaving app can steal window focus only a bounded number of
  // times per minute instead of in a tight loop. The budget sits well
  // above any human flow (a user reopening Settings a dozen times in a
  // minute is unusual but legitimate) while a focus-stealing loop still
  // bounces quickly.
  const DEFAULT_APPS_RATE_LIMIT_MAX = 12;
  const DEFAULT_APPS_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  const defaultAppsRateLimitLog = new Map();

  function checkDefaultAppsRateLimit(appId) {
    const now = Date.now();
    const windowStart = now - DEFAULT_APPS_RATE_LIMIT_WINDOW_MS;
    const timestamps = (defaultAppsRateLimitLog.get(appId) ?? []).filter((ts) => ts > windowStart);
    if (timestamps.length >= DEFAULT_APPS_RATE_LIMIT_MAX) {
      defaultAppsRateLimitLog.set(appId, timestamps);
      return false;
    }
    timestamps.push(now);
    defaultAppsRateLimitLog.set(appId, timestamps);
    return true;
  }

  function clearDefaultAppsRateLimit(appId) {
    defaultAppsRateLimitLog.delete(appId);
  }

  async function handleOpenDefaultAppsSettings({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    if (!checkDefaultAppsRateLimit(app.id)) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'RATE_LIMITED', `Max ${DEFAULT_APPS_RATE_LIMIT_MAX} per minute`);
    }
    // category is optional and purely a UI hint (which row nook scrolls to
    // / highlights) — it is never used to decide anything on the app's
    // behalf, and an unrecognized value is just ignored by nook rather
    // than rejected here, since the category list can grow over time.
    const category = (payload && typeof payload.category === 'string') ? payload.category : null;
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow('com.astroos.settings', { section: 'default-apps', highlightCategory: category, requestingAppId: app.id });
      return respond(webview, 'nova:app:openDefaultAppsSettings', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:openDefaultAppsSettings', requestId, 'ERROR', e?.message || 'Failed to open Settings');
    }
  }

  async function handleHomeOpenDefaultAppsSettings({ requestId, app, sandbox, webview }) {
    if (!sandbox?.homeSurface || typeof DefaultApps === 'undefined'
      || DefaultApps.getDefault('home') !== app?.id) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'PERMISSION_DENIED', 'Only the currently selected Home app can open Home settings');
    }
    if (!checkDefaultAppsRateLimit(app.id)) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'RATE_LIMITED', `Max ${DEFAULT_APPS_RATE_LIMIT_MAX} per minute`);
    }
    try {
      if (typeof WM === 'undefined' || typeof WM.createWindow !== 'function') {
        return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'UNAVAILABLE', 'Window manager not available');
      }
      const win = WM.createWindow('com.astroos.settings', {
        section: 'default-apps',
        highlightCategory: 'home',
        requestingAppId: app.id,
      });
      return respond(webview, 'nova:home:openDefaultAppsSettings', requestId, {
        success: !!win,
        windowId: win ? win.id : null,
      });
    } catch (error) {
      return respondError(webview, 'nova:home:openDefaultAppsSettings', requestId, 'ERROR', error?.message || 'Failed to open Home settings');
    }
  }



  async function handleAppInfo({ requestId, app, webview }) {
    if (!app) {
      return respondError(webview, 'nova:app:info', requestId, 'UNAVAILABLE', 'No app context');
    }
    return respond(webview, 'nova:app:info', requestId, {
      success: true,
      id: app.id,
      name: app.name,
      version: app.version,
      icon: app.icon,
      type: app.type,
      permissions: app.permissions || [],
      optionalPermissions: app.optionalPermissions || [],
    });
  }


  async function clockService() {
    for (let i = 0; i < 20; i++) {
      const svc = window.__ASTROOS_BG?.clock;
      if (svc) { svc.ensureBooted?.(); return svc; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Clock background service unavailable');
  }
  async function clockSnapshot() {
    const svc = await clockService();
    const st = svc.state || {};
    return {
      timer: { ...(st.timer || {}) },
      stopwatch: { ...(st.stopwatch || {}), laps: Array.isArray(st.stopwatch?.laps) ? st.stopwatch.laps.slice() : [] },
      lastAlarmMinute: typeof st.lastAlarmMinute === 'string' ? st.lastAlarmMinute : ''
    };
  }
  async function handleClockStateGet({ requestId, webview }) {
    return respond(webview, 'nova:clock:state:get', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStatePersist({ requestId, webview }) {
    const svc = await clockService();
    svc.persist?.();
    return respond(webview, 'nova:clock:state:persist', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockAlarmsGet({ requestId, webview }) {
    const alarms = (await clockService()).loadAlarms?.() || [];
    return respond(webview, 'nova:clock:alarms:get', requestId, { success: true, alarms });
  }
  async function handleClockAlarmsSet({ payload, requestId, webview }) {
    const alarms = Array.isArray(payload?.alarms) ? payload.alarms : [];
    const svc = await clockService();
    svc.saveAlarms?.(alarms);
    return respond(webview, 'nova:clock:alarms:set', requestId, { success: true, alarms: svc.loadAlarms?.() || [] });
  }

  async function handleClockAlarmDialog({ payload, requestId, webview }) {
    try {
      const src = payload?.alarm && typeof payload.alarm === 'object' ? payload.alarm : {};
      const body = document.createElement('div');
      body.className = 'clock-native-alarm-body';
      body.style.cssText = 'display:flex;flex-direction:column;width:320px;max-width:100%;';

      const time = document.createElement('input');
      time.type = 'time';
      time.className = 'input clock-native-alarm-time';
      time.value = /^\d{2}:\d{2}$/.test(src.time || '') ? src.time : '07:00';
      time.setAttribute('aria-label', 'Alarm time');

      const label = document.createElement('input');
      label.type = 'text';
      label.className = 'input';
      label.maxLength = 64;
      label.value = typeof src.label === 'string' ? src.label : '';
      label.placeholder = 'Label (optional)';
      label.setAttribute('aria-label', 'Alarm label');

      const repeat = document.createElement('div');
      repeat.className = 'clock-native-alarm-repeat-title';
      repeat.textContent = 'Repeat';

      const daysWrap = document.createElement('div');
      daysWrap.className = 'clock-native-alarm-days';
      const days = ['S','M','T','W','T','F','S'];
      const fullDays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const selected = Array.isArray(src.days) ? src.days.map(Number) : [];
      for (let i = 0; i < 7; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'clock-native-alarm-day';
        b.title = fullDays[i];
        b.textContent = days[i];
        b.dataset.clockDay = String(i);
        b.dataset.clockSelected = selected.includes(i) ? 'true' : 'false';
        const paint = () => {
          const on = b.dataset.clockSelected === 'true';
          b.style.background = on ? 'var(--accent)' : 'transparent';
          b.style.color = on ? '#fff' : 'var(--text-muted)';
          b.style.borderColor = on ? 'var(--accent)' : 'var(--border-subtle)';
        };
        paint();
        b.addEventListener('click', () => {
          b.dataset.clockSelected = b.dataset.clockSelected === 'true' ? 'false' : 'true';
          paint();
        });
        daysWrap.appendChild(b);
      }

      body.append(time, label, repeat, daysWrap);

      const actions = [];
      if (payload?.editing) actions.push({ label: 'Delete', danger: true, value: '__CLOCK_DELETE__' });
      actions.push({ label: 'Cancel', value: '__CLOCK_CANCEL__' });
      actions.push({ label: 'Save', primary: true, value: '__MODAL_SUBMIT_CUSTOM__' });

      const result = await ModalService.show(
        payload?.editing ? 'Edit Alarm' : 'Add Alarm',
        body,
        actions,
        null,
        '',
        {
          variant: 'clock-alarm',
          collect(root) {
            const chosen = [...root.querySelectorAll('[data-clock-day][data-clock-selected="true"]')]
              .map(x => Number(x.dataset.clockDay));
            return {
              time: time.value,
              label: label.value.trim().slice(0, 64),
              days: chosen,
              enabled: true,
            };
          }
        }
      );
      return respond(webview, 'nova:clock:alarm:dialog', requestId, { success: true, result });
    } catch (e) {
      return respondError(webview, 'nova:clock:alarm:dialog', requestId, 'ERROR', e?.message || 'Clock dialog unavailable');
    }
  }
  async function handleClockTimerSetPreset({ payload, requestId, webview }) {
    const svc = await clockService();
    svc.setTimerPreset?.(payload?.ms);
    return respond(webview, 'nova:clock:timer:set-preset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerStart({ payload, requestId, webview }) {
    const svc = await clockService();
    svc.startTimer?.(payload?.ms);
    return respond(webview, 'nova:clock:timer:start', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerPause({ requestId, webview }) {
    const svc = await clockService();
    svc.pauseTimer?.();
    return respond(webview, 'nova:clock:timer:pause', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerRestart({ requestId, webview }) {
    const svc = await clockService();
    svc.restartTimer?.();
    return respond(webview, 'nova:clock:timer:restart', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockTimerReset({ requestId, webview }) {
    const svc = await clockService();
    svc.resetTimer?.();
    return respond(webview, 'nova:clock:timer:reset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchStart({ requestId, webview }) {
    const svc = await clockService();
    svc.startStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:start', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchPause({ requestId, webview }) {
    const svc = await clockService();
    svc.pauseStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:pause', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchReset({ requestId, webview }) {
    const svc = await clockService();
    svc.resetStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:reset', requestId, { success: true, state: await clockSnapshot() });
  }
  async function handleClockStopwatchLap({ requestId, webview }) {
    const svc = await clockService();
    const lap = svc.lapStopwatch?.();
    return respond(webview, 'nova:clock:stopwatch:lap', requestId, { success: true, lap, state: await clockSnapshot() });
  }

  // Admin: audit / system / apps / users
  //
  // admin:* is the only permission category gated by something below the
  // app-permission layer — /api/security/* checks req.user.role === 'admin'
  // server-side, which reflects a real local admin-state flag (see
  // server/security/admin-state.js) instead of being permanently false.
  // Two gates have to agree: AppPermissionManager (per-app grant, same as
  // every other permission) AND the local admin flag (per-machine, off by
  // default, toggled in Settings). An app can be granted admin:audit and
  // still get nothing back if the machine itself isn't in admin mode —
  // that's intentional, not a bug: granting an app the permission means
  // "if this machine is ever in admin mode, this app may use it," not
  // "make this machine an admin machine."
  //
  // There's no user-account CRUD anywhere in this codebase (no
  // create/delete/edit-user route exists), so admin:users maps to session
  // management (list/revoke active sessions) rather than invented account
  // operations. admin:apps has no dedicated route of its own in
  // security/routes.js; it's folded into admin:system's settings surface
  // for now since nothing else under /api/security exists for it.

  function csrfToken() {
    // Multi-user: the CSRF token belongs to the SESSION, and the active
    // account's session is the one this host fetches with (X-Nova-Session
    // below). The boot-injected meta tag belongs to the anonymous page
    // session — using it for an authed request would fail the CSRF check.
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.() &&
        typeof window !== 'undefined' && window.SessionManager?.csrf) {
      const active = window.SessionManager.csrf();
      if (active) return active;
    }
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }

  /** Owner uid stamped onto storage by the trusted host (never app-supplied). */
  function storageOwnerUid() {
    return (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.())
      ? String(NovaUserScope.ownerUid() || '')
      : '';
  }

  /** True while an admin-role account session is active (multi-user). */
  function isAdminSession() {
    if (typeof NovaUserScope === 'undefined' || !NovaUserScope?.enabled?.()) return true;
    return typeof window !== 'undefined' && !!window.SessionManager?.isAdmin?.();
  }

  function systemAppRateLimitHeaders(app) {
    if (
      app?.verified !== true ||
      app?.signer !== 'Astro System' ||
      app?.system !== true ||
      app?.manifest?.system !== true ||
      typeof require !== 'function' ||
      typeof process === 'undefined'
    ) return {};

    const secret = process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    if (!secret) return {};
    const timestamp = String(Date.now());
    const signature = require('crypto')
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${app.id}`)
      .digest('hex');
    return {
      'X-Nova-System-App': app.id,
      'X-Nova-System-Time': timestamp,
      'X-Nova-System-Signature': signature,
    };
  }

  // Shared helper for admin and mail proxies — both need the same
  // JSON-in/JSON-out shape with a CSRF header. Previously duplicated as
  // adminFetch and mailFetch with identical bodies.
  async function authedJsonFetch(path, options = {}) {
    // Multi-user: present the active session's bearer token so admin/mail
    // proxies authenticate as the signed-in account. The token lives in host
    // memory only — this is host-realm code, never handed to webviews.
    const sessionHeaders = {};
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.() && window.SessionManager?.token) {
      const token = window.SessionManager.token();
      if (token) sessionHeaders['X-Nova-Session'] = token;
    }
    const res = await fetch(path, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken(),
        ...sessionHeaders,
        ...(options.headers || {}),
        ...systemAppRateLimitHeaders(options.app),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON error page, fall through */ }
    return { status: res.status, ok: res.ok, json };
  }

  async function handleAdminAudit({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:audit', app.id)) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'admin:audit permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const q = payload ?? {};
    const params = new URLSearchParams();
    for (const k of ['userId', 'action', 'resource', 'ipAddress', 'success', 'startDate', 'endDate', 'level', 'limit', 'offset']) {
      if (q[k] !== undefined && q[k] !== null) params.set(k, String(q[k]));
    }
    try {
      const { status, json } = await authedJsonFetch(`/api/security/audit?${params.toString()}`, { app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:audit', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', json?.message || 'Failed to query audit log');
      }
      return respond(webview, 'nova:admin:audit', requestId, { success: true, logs: json.data, pagination: json.pagination, statistics: json.statistics });
    } catch (e) {
      return respondError(webview, 'nova:admin:audit', requestId, 'UNAVAILABLE', e?.message || 'Audit request failed');
    }
  }

  async function handleAdminSystem({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:system', app.id)) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'admin:system permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const action = payload?.action === 'set' ? 'set' : 'get';
    try {
      if (action === 'get') {
        const { status, json } = await authedJsonFetch('/api/security/settings', { app });
        if (status === 403) {
          return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to read security settings');
        }
        return respond(webview, 'nova:admin:system', requestId, { success: true, settings: json.data });
      }
      // action === 'set'
      const updates = payload?.settings;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return respondError(webview, 'nova:admin:system', requestId, 'INVALID_ARGS', 'settings object is required for action "set"');
      }
      const { status, json } = await authedJsonFetch('/api/security/settings', { method: 'PUT', body: updates, app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:system', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', json?.message || 'Failed to update security settings');
      }
      return respond(webview, 'nova:admin:system', requestId, { success: true, updated: json.updated });
    } catch (e) {
      return respondError(webview, 'nova:admin:system', requestId, 'UNAVAILABLE', e?.message || 'Admin system request failed');
    }
  }

  async function handleAdminUsers({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:users', app.id)) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'admin:users permission required');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    // Multi-user: the admin:* permission grants gain one additional
    // requirement — the session must belong to an admin-role account. An
    // app holding admin:users under a standard session receives nothing.
    if (!isAdminSession()) {
      return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'An administrator account is required for account management');
    }
    // ── Multi-user account management (the Users app console) ──────────
    // Every account verb proxies to the role-gated /api/auth/admin family
    // through authedJsonFetch (bearer token + CSRF), so the server re-checks
    // the session role on every route — never trusting this client claim.
    const ACCOUNT_ROUTES = {
      'accounts.list':        { method: 'GET',    path: () => '/api/auth/admin/users' },
      'accounts.create':      { method: 'POST',   path: () => '/api/auth/admin/users', body: (p) => p.account },
      'accounts.update':      { method: 'PATCH',  path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}`, body: (p) => p.patch },
      'accounts.disable':     { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/disable` },
      'accounts.enable':      { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/enable` },
      'accounts.lock':        { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/lock` },
      'accounts.unlock':      { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/unlock` },
      'accounts.forceLogout': { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/force-logout` },
      'accounts.resetCredential': { method: 'POST', path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/reset-credential` },
      'accounts.delete':      { method: 'DELETE', path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}${p.mode === 'wipe' ? '?mode=wipe' : ''}`, body: (p) => (p.mode ? { mode: p.mode } : undefined) },
      'accounts.setPin':      { method: 'POST',   path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/credentials/pin`, body: (p) => ({ pin: p.pin }) },
      'accounts.setPassphrase': { method: 'POST', path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/credentials/passphrase`, body: (p) => ({ passphrase: p.passphrase ?? null }) },
      'accounts.webauthn.list':   { method: 'GET',  path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/webauthn` },
      'accounts.webauthn.remove': { method: 'DELETE', path: (p) => `/api/auth/admin/users/${encodeURIComponent(p.uid)}/webauthn/${encodeURIComponent(p.credentialId)}` },
      'policies.get':         { method: 'GET',    path: () => '/api/auth/admin/policies' },
      'policies.set':         { method: 'PUT',    path: () => '/api/auth/admin/policies', body: (p) => p.policies },
      'events.list':          { method: 'GET',    path: (p) => { const q = new URLSearchParams(); for (const k of ['uid', 'severity', 'action', 'limit', 'offset']) if (p?.[k] !== undefined && p?.[k] !== null) q.set(k, String(p[k])); return `/api/auth/admin/events${q.toString() ? '?' + q.toString() : ''}`; } },
      'usage.get':            { method: 'GET',    path: () => '/api/auth/admin/usage' },
    };
    if (Object.prototype.hasOwnProperty.call(ACCOUNT_ROUTES, payload?.action)) {
      const route = ACCOUNT_ROUTES[payload.action];
      try {
        const { status, json } = await authedJsonFetch(route.path(payload), {
          method: route.method,
          body: route.body ? route.body(payload) : undefined,
          app,
        });
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:users', requestId,
            status === 403 ? 'PERMISSION_DENIED' : (status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE'),
            json?.message || `Account management request failed (${status})`);
        }
        return respond(webview, 'nova:admin:users', requestId, { success: true, data: json.data });
      } catch (e) {
        return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', e?.message || 'Account management request failed');
      }
    }
    // ── Legacy session management verbs (pre-accounts surface) ─────────
    const action = payload?.action === 'revoke' ? 'revoke' : 'list';
    try {
      if (action === 'list') {
        const { status, json } = await authedJsonFetch('/api/security/sessions', { app });
        if (status === 401) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', 'No active session');
        }
        if (!json || json.success !== true) {
          return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to list sessions');
        }
        return respond(webview, 'nova:admin:users', requestId, { success: true, sessions: json.data });
      }
      // action === 'revoke'
      const sessionId = payload?.sessionId;
      if (!sessionId) {
        return respondError(webview, 'nova:admin:users', requestId, 'INVALID_ARGS', 'sessionId is required for action "revoke"');
      }
      const { status, json } = await authedJsonFetch(`/api/security/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', app });
      if (status === 403) {
        return respondError(webview, 'nova:admin:users', requestId, 'PERMISSION_DENIED', 'Not permitted to revoke this session');
      }
      if (status === 404) {
        return respondError(webview, 'nova:admin:users', requestId, 'NOT_FOUND', 'Session not found');
      }
      if (!json || json.success !== true) {
        return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', json?.message || 'Failed to revoke session');
      }
      return respond(webview, 'nova:admin:users', requestId, { success: true, revoked: true });
    } catch (e) {
      return respondError(webview, 'nova:admin:users', requestId, 'UNAVAILABLE', e?.message || 'Admin users request failed');
    }
  }

  async function handleAdminApps({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('admin:apps', app.id)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'admin:apps permission required');
    }
    // There's no dedicated /api/security route for app management — the
    // real, non-sandboxed app inventory already lives behind system:apps
    // (nova:app:list/install/uninstall). What system:apps:list can't show
    // is what's actually been *granted* at runtime — a manifest can
    // declare permissions it was never given, or the user may have
    // revoked something after install. admin:apps' real, distinguishing
    // scope is that runtime grant state: "an admin-mode app can audit
    // what every installed app can actually do right now," not just what
    // it asked for. If real admin-only mutating operations (force-
    // uninstall another app, disable an app fleet-wide) get built later,
    // they belong here too.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:admin:apps', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    if (!(await isAdminEnabledClient(app))) {
      return respondError(webview, 'nova:admin:apps', requestId, 'PERMISSION_DENIED', 'This machine is not in admin mode — enable it in Settings first');
    }
    const apps = APP_REGISTRY.map(a => {
      const granted = (typeof AppPermissionManager.getAppPermissions === 'function')
        ? AppPermissionManager.getAppPermissions(a.id).map(g => g.permission)
        : [];
      // Built-in apps never declare permissions on their registerApp()
      // config — that's not a gap in this handler, it's a real second
      // source of truth: js/platform/security/app-permissions-bootstrap.js
      // provides legacy developer-tool declarations only. Trusted .novaapp
      // system apps intentionally declare no app-level permissions, while a
      // third-party package's manifest remains the source of its declarations.
      // Report whichever source applies rather than inventing a list for a
      // trusted system package.
      const bootstrapEntry = (typeof window.AppPermissionsMap === 'object' && window.AppPermissionsMap)
        ? window.AppPermissionsMap[a.id]
        : null;
      const declaredPermissions = bootstrapEntry
        ? [...(bootstrapEntry.normal || [])]
        : (a.permissions || []);
      const declaredOptionalPermissions = bootstrapEntry
        ? [...(bootstrapEntry.dangerous || [])]
        : (a.optionalPermissions || []);
      return {
        id: a.id, name: a.name, version: a.version || '1.0.0',
        source: a.source || 'local', builtin: a.source !== 'file',
        declaredPermissions, declaredOptionalPermissions,
        declaredVia: bootstrapEntry ? 'permissions-bootstrap' : 'manifest',
        grantedPermissions: granted,
      };
    });
    return respond(webview, 'nova:admin:apps', requestId, { success: true, apps });
  }

  // admin:apps has no server route to 403 against (unlike the other three,
  // which proxy to /api/security and get a real 403 from there), so it
  // needs its own client-side admin-mode check. Reuses the same signal:
  // GET /api/security/settings returns a *limited* payload for non-admins
  // (no _meta.editable, no full settings) but always 200s, so the leanest
  // honest check is a settings fetch and looking at whether the admin-only
  // fields came back.
  // ── Settings-only unrestricted handlers ──────────────────────────────
  // These handlers exist in API_HANDLERS for completeness, but the IPC
  // bridge (handleAPICall) is the only dispatch path and the Settings app
  // reaches these features directly through OS.system.* rather than via
  // IPC — so nothing on a live code path calls them. They're left in place
  // as the canonical implementation so a future IPC surface can reuse them
  // without duplicating logic.

  async function handleSystemPermissionsList({ requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined' || typeof AppRegistry === 'undefined') {
      return respondError(webview, 'nova:system:permissions:list', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const apps = (typeof APP_REGISTRY !== 'undefined' && Array.isArray(APP_REGISTRY)) ? APP_REGISTRY : [];
    const result = apps.map(a => ({
      id: a.id,
      name: a.name,
      grants: typeof AppPermissionManager.getAppPermissions === 'function'
        ? AppPermissionManager.getAppPermissions(a.id)
        : [],
    }));
    return respond(webview, 'nova:system:permissions:list', requestId, { success: true, apps: result });
  }

  async function handleSystemPermissionsSet({ payload, requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined') {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const { appId, permission, granted } = payload || {};
    if (!appId || !permission || typeof granted !== 'boolean') {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'INVALID_ARGS', 'appId, permission, and a boolean granted are required');
    }
    try {
      if (granted) {
        await AppPermissionManager.grantPermission(permission, appId, { source: 'settings' });
      } else {
        await AppPermissionManager.revokePermission(permission, appId);
      }
    } catch (e) {
      return respondError(webview, 'nova:system:permissions:set', requestId, 'INTERNAL_ERROR', e?.message || 'Failed to update permission');
    }
    return respond(webview, 'nova:system:permissions:set', requestId, { success: true, appId, permission, granted });
  }

  async function handleSystemPermissionsReset({ payload, requestId, webview }) {
    if (typeof AppPermissionManager === 'undefined') {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'UNAVAILABLE', 'Permission system not available');
    }
    const { appId, permission } = payload || {};
    if (!appId) {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'INVALID_ARGS', 'appId is required');
    }
    try {
      if (permission) {
        await AppPermissionManager.resetPermission(permission, appId);
      } else if (typeof AppPermissionManager.revokeAllPermissions === 'function') {
        await AppPermissionManager.revokeAllPermissions(appId);
      }
    } catch (e) {
      return respondError(webview, 'nova:system:permissions:reset', requestId, 'INTERNAL_ERROR', e?.message || 'Failed to reset permission(s)');
    }
    return respond(webview, 'nova:system:permissions:reset', requestId, { success: true, appId, permission: permission || null });
  }

  // Mirrors settings.js's existing localStorage.length/key()/getItem() loop
  // exactly (see renderPrivacy's backup path) — same data, just moved
  // behind an IPC call instead of a direct host-global read.
  async function handleSystemDataBackup({ requestId, webview }) {
    if (typeof localStorage === 'undefined') {
      return respondError(webview, 'nova:system:data:backup', requestId, 'UNAVAILABLE', 'localStorage not available in this context');
    }
    const localStorageData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      localStorageData[key] = localStorage.getItem(key);
    }
    const settingsData = (typeof OS !== 'undefined' && OS.settings?._cache) ? { ...OS.settings._cache } : {};
    return respond(webview, 'nova:system:data:backup', requestId, {
      success: true,
      localStorage: localStorageData,
      settings: settingsData,
      capturedAt: new Date().toISOString(),
    });
  }

  // Mirrors settings.js's existing restore path (setItem per key, plus a
  // clear-first option for full reset) — moved behind IPC the same way.
  async function handleSystemDataRestore({ payload, requestId, webview }) {
    if (typeof localStorage === 'undefined') {
      return respondError(webview, 'nova:system:data:restore', requestId, 'UNAVAILABLE', 'localStorage not available in this context');
    }
    const { localStorage: dataToRestore, settings: settingsToRestore, clearFirst } = payload || {};
    if (clearFirst) {
      try { localStorage.clear(); } catch (e) { log('warn', 'localStorage.clear() failed during restore:', e); }
    }
    let restoredKeys = 0;
    if (dataToRestore && typeof dataToRestore === 'object') {
      for (const [k, v] of Object.entries(dataToRestore)) {
        try { localStorage.setItem(k, v); restoredKeys++; }
        catch (e) { log('warn', `localStorage.setItem failed for ${k}:`, e); }
      }
    }
    if (settingsToRestore && typeof settingsToRestore === 'object' && typeof OS !== 'undefined' && OS.settings) {
      for (const [k, v] of Object.entries(settingsToRestore)) {
        try {
          // set() routes through the registry-backed shim (persist + change
          // fan-out); direct cache writes would bypass persistence.
          if (typeof OS.settings.set === 'function') OS.settings.set(k, v);
          else if (OS.settings._cache) OS.settings._cache[k] = v;
        } catch (e) { log('warn', `OS.settings restore failed for ${k}:`, e); }
      }
    }
    return respond(webview, 'nova:system:data:restore', requestId, { success: true, restoredKeys, cleared: !!clearFirst });
  }

  async function handleSystemDialog({ payload, requestId, webview }) {
    try {
      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:dialog', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }
      const buttons = Array.isArray(payload?.buttons) && payload.buttons.length
        ? payload.buttons.map(b => ({
            label: String(b?.label || 'OK'),
            value: b?.value,
            primary: !!b?.primary,
            danger: !!b?.danger
          }))
        : [{ label: 'OK', value: true, primary: true }];
      // Runs in the host page: the overlay is outside the Settings webview.
      const value = await dialogService(
        String(payload?.title || 'Settings'),
        String(payload?.message || ''),
        buttons,
        payload?.inputType || null,
      );
      return respond(webview, 'nova:system:dialog', requestId, { success: true, value });
    } catch (e) {
      return respondError(webview, 'nova:system:dialog', requestId, 'DIALOG_ERROR', e?.message || 'Dialog failed');
    }
  }

  async function handleSystemDeveloperModeConfirm({ requestId, webview }) {
    try {
      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:developer-mode:confirm', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }

      // Match the original Settings warning verbatim, but construct it in the
      // host dialog portal so it can never be trapped inside the Settings guest.
      const body = document.createElement('div');
      body.style.cssText = 'font-size:14px;color:var(--text-secondary,#aaa);line-height:1.55;';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px;';
      const warningIcon = document.createElement('span');
      warningIcon.textContent = '\u26A0\uFE0F';
      warningIcon.style.cssText = 'font-size:22px;line-height:1;';
      const warningTitle = document.createElement('div');
      warningTitle.textContent = 'Developer Mode — Security Warning';
      warningTitle.style.cssText = 'font-size:17px;font-weight:700;color:var(--text-danger,#f85149);letter-spacing:0.2px;';
      header.append(warningIcon, warningTitle);
      body.appendChild(header);
      const warningText = document.createElement('div');
      warningText.style.cssText = 'white-space:pre-line;max-height:340px;overflow-y:auto;padding-right:4px;';
      body.appendChild(warningText);
      warningText.textContent =
        'WARNING: Developer Mode enables development and diagnostic tools that can expose or change sensitive system state.\n\n' +
        'Developer Mode does not by itself disable the app sandbox or grant every app unrestricted filesystem, network, or system access. Tools and actions remain subject to their own permission checks. Use these capabilities only on a device you trust.\n\n' +
        'Developer Mode also makes it possible to enable Root Access in Settings. Root Access is a separate device-wide switch, and each app still needs its own explicit grant. A root-approved app runs directly inside the OS page without a sandbox and can read or change system data and UI. Only grant it to apps you fully trust.\n\n' +
        'Developer Mode is intended for development, debugging, and system maintenance. Enable it only when needed, and leave it disabled during normal use.';

      const value = await dialogService(
        '',
        body,
        [
          { label: 'Cancel', value: null },
          { label: 'Turn On Anyway', danger: true, primary: true, value: 'confirm' }
        ],
        null,
        '',
        { variant: 'developer-warning' }
      );
      return respond(webview, 'nova:system:developer-mode:confirm', requestId, { success: true, value });
    } catch (e) {
      console.error('[Settings] developer-mode confirmation failed:', e);
      return respondError(webview, 'nova:system:developer-mode:confirm', requestId, 'DIALOG_ERROR', e?.message || 'Developer mode confirmation failed');
    }
  }

  async function handleSystemBootRecovery({ requestId, webview }) {
    try {
      // Registry-backed (HKNS/system/boot/manualRecovery via BootState — the
      // legacy key stays in step as the pre-boot handoff shadow to init.js).
      if (typeof RegistryBootState !== 'undefined') {
        RegistryBootState.setFlag('manualRecovery', true);
        RegistryBootState.clearFlag('safeMode');
      } else {
        localStorage.setItem('nova_manual_recovery', '1');
        localStorage.removeItem('nova_safe_mode');
      }
      // Reload the HOST window, not the sandbox guest frame. The next boot
      // sees manualRecovery, writes the recovery request and restarts into the Linux recovery environment.
      setTimeout(() => {
        try { location.reload(); } catch (e) { console.error('[Settings] recovery reload failed:', e); }
      }, 120);
      return respond(webview, 'nova:system:boot-recovery', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:system:boot-recovery', requestId, 'ERROR', e?.message || 'Failed to reboot to recovery');
    }
  }

  async function handleSystemStorageEstimate({ requestId, webview }) {
    try {
      // Settings is a first-party system app, so storage is measured from the
      // host OS rather than the sandbox webview. navigator.storage.estimate()
      // is renderer/partition scoped in NW.js and can be unavailable or report
      // only the guest partition, which is why Settings previously showed an
      // error even though the OS volume was healthy.
      if (typeof require === 'function') {
        try {
          const fs = require('fs');
          const path = require('path');
          const root = path.parse(process.cwd()).root || process.cwd();
          if (typeof fs.statfsSync === 'function') {
            try {
              const st = fs.statfsSync(root);
              const blockSize = Number(st.bsize || st.frsize || 0);
              const blocks = Number(st.blocks || 0);
              const available = Number(st.bavail ?? st.bfree ?? 0);
              if (blockSize > 0 && blocks > 0) {
                const quota = blocks * blockSize;
                const usage = Math.max(0, (blocks - available) * blockSize);
                return respond(webview, 'nova:system:storage:estimate', requestId, {
                  success: true,
                  usage,
                  quota,
                  source: 'host-filesystem',
                });
              }
            } catch (statfsErr) {
              console.warn('[Settings] statfs storage estimate failed:', statfsErr);
            }
          }

          // Windows builds of Node/NW.js may not expose statfs. Use the native
          // Win32 logical-disk provider through PowerShell as a host-only
          // fallback. This reads the same volume that contains the OS runtime.
          if (process.platform === 'win32') {
            const cp = require('child_process');
            const drive = String(root).replace(/\\+$/, '');
            const ps = [
              '$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'' + drive.replace(/'/g, "''") + '\'";',
              'if ($null -eq $d) { throw "Drive not found" };',
              '[Console]::WriteLine((@{Size=[Int64]$d.Size; FreeSpace=[Int64]$d.FreeSpace} | ConvertTo-Json -Compress))'
            ].join(' ');
            const out = cp.execFileSync('powershell.exe', [
              '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps
            ], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
            const parsed = JSON.parse(String(out).trim());
            const quota = Number(parsed?.Size || 0);
            const free = Number(parsed?.FreeSpace || 0);
            if (quota > 0 && free >= 0 && free <= quota) {
              return respond(webview, 'nova:system:storage:estimate', requestId, {
                success: true,
                usage: quota - free,
                quota,
                source: 'host-windows-volume',
              });
            }
          }
        } catch (hostErr) {
          console.warn('[Settings] host storage estimate fallback failed:', hostErr);
        }
      }

      // Last fallback: if NW.js exposes a useful renderer estimate, return it.
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        const usage = Number.isFinite(est?.usage) ? est.usage : 0;
        const quota = Number.isFinite(est?.quota) ? est.quota : 0;
        if (quota > 0 || usage > 0) {
          return respond(webview, 'nova:system:storage:estimate', requestId, {
            success: true, usage, quota, usageDetails: est?.usageDetails || null, source: 'webview-fallback'
          });
        }
      }

      return respondError(webview, 'nova:system:storage:estimate', requestId, 'UNAVAILABLE', 'Storage information is unavailable on this device');
    } catch (e) {
      console.error('[Settings] storage estimate failed:', e);
      return respondError(webview, 'nova:system:storage:estimate', requestId, 'ERROR', e?.message || 'Failed to retrieve storage information');
    }
  }

  async function deleteHostIndexedDBs(names) {
    const results = [];
    for (const name of names) {
      const result = await new Promise(resolve => {
        try {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve({ name, ok: true });
          req.onerror = () => resolve({ name, ok: false, reason: 'error' });
          req.onblocked = () => resolve({ name, ok: false, reason: 'blocked' });
        } catch (e) {
          resolve({ name, ok: false, reason: e?.message || 'error' });
        }
      });
      results.push(result);
    }
    return results;
  }

  async function handleSystemDataClear({ payload, requestId, webview }) {
    try {
      const mode = payload?.mode === 'all' ? 'all' : 'cache';
      const cleared = [];

      if (mode === 'cache') {
        try {
          const cacheNames = await caches.keys();
          if (cacheNames.length) {
            await Promise.all(cacheNames.map(n => caches.delete(n)));
            cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length === 1 ? '' : 's'));
          }
        } catch (e) { console.warn('[Settings] cache clear failed:', e); }
        try {
          const tempKeys = Object.keys(localStorage).filter(k =>
            k.includes('_cache') || k.includes('_temp') ||
            k === 'nova_boot_attempts' || k === 'nova_force_recovery'
          );
          if (tempKeys.length) {
            tempKeys.forEach(k => localStorage.removeItem(k));
            cleared.push(tempKeys.length + ' temp key' + (tempKeys.length === 1 ? '' : 's'));
          }
          // Registry copies of the same transient boot state (HKNS/system/boot/*).
          if (typeof RegistryBootState !== 'undefined') {
            RegistryBootState.clearFlags('attempts', 'forceRecovery', 'timeoutFlag');
          }
        } catch (e) { console.warn('[Settings] temp key clear failed:', e); }
        return respond(webview, 'nova:system:data:clear', requestId, { success: true, mode, cleared });
      }

      // Full wipe mirrors the recovery/factory-reset path and, critically,
      // runs in the HOST context so it can reach every app partition.
      // Multi-user machines: the account store is wiped server-side too —
      // an owner-role session must be live for that (the wipe verb is
      // host-only and dialog-gated); the local scope flags reset so the
      // machine returns to first-boot.
      let accountsWiped = false;
      if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
        try {
          const manager = (typeof window !== 'undefined' && window.SessionManager) || null;
          if (manager && manager.isAdmin()) {
            const result = await authedJsonFetch('/api/auth/admin/wipe', { method: 'POST' });
            accountsWiped = !!(result.ok && result.json?.success);
          }
        } catch (e) { console.warn('[Settings] account store wipe failed:', e); }
        try { NovaUserScope.reset(); } catch (e) { console.warn('[Settings] user scope reset failed:', e); }
      }

      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try { if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear(); } catch (e) { console.warn('[Settings] OPFS clear failed:', e); }

      const appIds = (typeof OS !== 'undefined' && OS.apps) ? Object.keys(OS.apps) : [];
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartitions) {
          await AppSandbox.clearAppPartitions(appIds);
        }
      } catch (e) { console.warn('[Settings] app partition wipe failed:', e); }
      try {
        if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAllStorage) {
          await AppSandbox.clearAllStorage();
        }
      } catch (e) { console.warn('[Settings] app storage wipe failed:', e); }
      // The ledger is localStorage-backed and localStorage.clear() above
      // already dropped its persisted copy — reset the in-memory state too
      // so a snapshot taken before the reload can't resurrect stale rows.
      try { StorageLedger.resetAll(); } catch (e) { console.warn('[Settings] storage ledger reset failed:', e); }
      const dbResults = await deleteHostIndexedDBs(['AstroOS_FS', 'novabyte_opfs_fallback', 'AstroOS_AppStorage']);
      const blocked = dbResults.filter(r => !r.ok);

      cleared.push('host settings', 'files', 'application data');
      if (accountsWiped) cleared.push('account store');
      if (blocked.length) cleared.push(blocked.length + ' database(s) could not be deleted because they were blocked');

      setTimeout(() => {
        try { location.reload(); } catch {}
      }, 350);
      return respond(webview, 'nova:system:data:clear', requestId, { success: true, mode, cleared });
    } catch (e) {
      return respondError(webview, 'nova:system:data:clear', requestId, 'WIPE_ERROR', e?.message || 'Failed to clear data');
    }
  }

  function systemDefaultAppsState() {
    if (typeof DefaultApps === 'undefined' || !DefaultApps?.CATEGORIES) return null;
    const categories = Object.entries(DefaultApps.CATEGORIES).map(([id, c]) => {
      const apps = DefaultApps.getAppsForCategory(id);
      const currentId = DefaultApps.getDefault(id) || null;
      const chosen = apps.find(a => a.id === currentId) || apps[0] || null;
      return { id, name: c.name, currentId: chosen?.id || null, currentName: chosen?.name || null, apps };
    });
    return { categories };
  }

  async function handleSystemDefaultAppsGet({ requestId, webview }) {
    const state = systemDefaultAppsState();
    if (!state) return respondError(webview, 'nova:system:default-apps:get', requestId, 'UNAVAILABLE', 'Default apps service not available');
    return respond(webview, 'nova:system:default-apps:get', requestId, { success: true, ...state });
  }

  async function handleSystemDefaultAppsChoose({ payload, requestId, webview }) {
    try {
      if (typeof DefaultApps === 'undefined' || !DefaultApps?.CATEGORIES) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'UNAVAILABLE', 'Default apps service not available');
      }
      const categoryId = String(payload?.categoryId || '');
      const category = DefaultApps.CATEGORIES[categoryId];
      if (!category) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'INVALID_ARGS', 'Unknown default-app category');
      }
      const apps = DefaultApps.getAppsForCategory(categoryId) || [];
      const currentId = DefaultApps.getDefault(categoryId) || apps[0]?.id || null;

      const body = document.createElement('div');
      body.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-height:60vh;overflow:auto;padding:2px;';

      for (const app of apps) {
        const row = document.createElement('div');
        row.setAttribute('data-modal-value', String(app.id));
        row.setAttribute('data-modal-selected', app.id === currentId ? 'true' : 'false');
        row.dataset.modalSelectedStyle = 'radio';
        row.setAttribute('role', 'radio');
        row.setAttribute('aria-checked', app.id === currentId ? 'true' : 'false');
        row.tabIndex = 0;
        row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:9px;cursor:pointer;user-select:none;border:1px solid ' + (app.id === currentId ? 'var(--accent)' : 'transparent') + ';background:' + (app.id === currentId ? 'var(--accent-muted)' : 'transparent') + ';';

        const icon = document.createElement('div');
        icon.style.cssText = 'width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;background:var(--accent-muted);color:var(--accent);font-size:14px;font-weight:700;';
        if (typeof app.icon === 'string' && app.icon.startsWith('data:image/')) {
          const img = document.createElement('img');
          img.src = app.icon;
          img.width = 18; img.height = 18;
          img.alt = '';
          img.draggable = false;
          icon.appendChild(img);
        } else if (typeof app.icon === 'string' && typeof svgIcon === 'function' && /^[a-z][a-z0-9-]*$/.test(app.icon)) {
          // Built-in apps normally publish an icon key (e.g. "mail",
          // "calendar", "settings"), not a data URI. The old chooser treated
          // short keys as literal text, which produced a "mail" word inside
          // the icon box instead of the actual application icon.
          icon.innerHTML = svgIcon(app.icon, 18);
        } else if (typeof app.icon === 'string' && app.icon.length <= 4) {
          icon.textContent = app.icon;
        } else {
          icon.textContent = String(app.name || '?').charAt(0).toUpperCase();
        }

        const label = document.createElement('div');
        label.textContent = String(app.name || app.id);
        label.style.cssText = 'flex:1;font-size:13px;color:var(--text-primary);';

        const radio = document.createElement('div');
        radio.style.cssText = 'width:16px;height:16px;border-radius:50%;border:2px solid ' + (app.id === currentId ? 'var(--accent)' : 'var(--border)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;';
        const dot = document.createElement('div');
        dot.setAttribute('data-modal-radio-dot', '');
        dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--accent);opacity:' + (app.id === currentId ? '1' : '0') + ';';
        radio.appendChild(dot);
        row.append(icon, label, radio);

        const syncVisual = () => {
          const selected = row.getAttribute('data-modal-selected') === 'true';
          row.style.borderColor = selected ? 'var(--accent)' : 'transparent';
          row.style.background = selected ? 'var(--accent-muted)' : 'transparent';
          radio.style.borderColor = selected ? 'var(--accent)' : 'var(--border)';
          dot.style.opacity = selected ? '1' : '0';
        };
        row.addEventListener('click', syncVisual);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            row.click();
          }
        });
        body.appendChild(row);
      }

      if (!apps.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No installed apps support this category yet.';
        empty.style.cssText = 'padding:16px;text-align:center;color:var(--text-muted);font-size:12.5px;';
        body.appendChild(empty);
      }

      const dialogService = (typeof window.ModalService?.show === 'function')
        ? window.ModalService.show.bind(window.ModalService)
        : (typeof window.showModal === 'function' ? window.showModal : null);
      if (!dialogService) {
        return respondError(webview, 'nova:system:default-apps:choose', requestId, 'UNAVAILABLE', 'System dialog service not available');
      }
      const selected = await dialogService(
        'Default ' + String(category.name || 'App'),
        body,
        [
          { label: 'Cancel', value: null },
          { label: 'Select', value: '__MODAL_SUBMIT_SELECTION__', primary: true }
        ]
      );
      return respond(webview, 'nova:system:default-apps:choose', requestId, { success: !!selected, appId: selected || null });
    } catch (e) {
      return respondError(webview, 'nova:system:default-apps:choose', requestId, 'DIALOG_ERROR', e?.message || 'Default app chooser failed');
    }
  }

  async function handleSystemDefaultAppsSet({ payload, requestId, webview }) {
    try {
      const categoryId = typeof payload?.categoryId === 'string' ? payload.categoryId : '';
      const appId = payload?.appId === null || payload?.appId === '' ? null : payload?.appId;
      if (typeof DefaultApps === 'undefined' || !DefaultApps.setDefault) {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'UNAVAILABLE', 'Default apps service not available');
      }
      if (appId !== null && typeof appId !== 'string') {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'INVALID_ARGS', 'App id must be a string or null');
      }
      if (!DefaultApps.setDefault(categoryId, appId)) {
        return respondError(webview, 'nova:system:default-apps:set', requestId, 'INVALID_ARGS', 'App is unavailable or does not support this category');
      }
      const apps = DefaultApps.getAppsForCategory(categoryId);
      const chosen = apps.find(a => a.id === DefaultApps.getDefault(categoryId)) || apps[0] || null;
      return respond(webview, 'nova:system:default-apps:set', requestId, { success: true, categoryId, appId: DefaultApps.getDefault(categoryId), currentName: chosen?.name || null });
    } catch (e) {
      return respondError(webview, 'nova:system:default-apps:set', requestId, 'ERROR', e?.message || 'Failed to update default app');
    }
  }

  function getAdminStateService() {
    const loaders = [];
    if (typeof require === 'function') loaders.push(require);
    if (typeof window !== 'undefined' && window.nw && typeof window.nw.require === 'function') {
      loaders.push(window.nw.require.bind(window.nw));
    }
    if (!loaders.length) throw new Error('Node host module loader unavailable');

    let pathModule = null;
    for (const load of loaders) {
      try { pathModule = load('path'); break; } catch (_) {}
    }
    if (!pathModule) throw new Error('Node path module unavailable');

    const root = (typeof process !== 'undefined' && typeof process.cwd === 'function')
      ? process.cwd() : null;
    const absolute = root
      ? pathModule.resolve(root, 'server/security/admin-state.js')
      : 'server/security/admin-state.js';

    let lastError = null;
    for (const load of loaders) {
      try { return load(absolute); } catch (e) { lastError = e; }
    }
    throw new Error(lastError?.message || 'Unable to load admin state service');
  }

  async function handleSystemAdminModeGet({ requestId, webview }) {
    try {
      const adminState = await getAdminStateService();
      return respond(webview, 'nova:system:admin-mode:get', requestId, { success: true, adminEnabled: !!adminState.isAdminEnabled() });
    } catch (e) {
      console.error('[Settings] admin-mode:get failed:', e);
      return respondError(webview, 'nova:system:admin-mode:get', requestId, 'ERROR', e?.message || 'Failed to read admin mode');
    }
  }

  async function handleSystemAdminModeSet({ payload, requestId, webview }) {
    try {
      const adminState = await getAdminStateService();
      const enabled = !!payload?.enabled;
      const state = adminState.setAdminEnabled(enabled);
      return respond(webview, 'nova:system:admin-mode:set', requestId, { success: true, adminEnabled: !!state.adminEnabled });
    } catch (e) {
      console.error('[Settings] admin-mode:set failed:', e);
      return respondError(webview, 'nova:system:admin-mode:set', requestId, 'ERROR', e?.message || 'Failed to set admin mode');
    }
  }

  async function handleSystemPreferencesGet({ payload, requestId, webview }) {
    if (typeof OS === 'undefined' || !OS.settings || typeof OS.settings.get !== 'function') {
      return respondError(webview, 'nova:system:preferences:get', requestId, 'UNAVAILABLE', 'OS.settings not available');
    }
    const key = payload?.key;
    if (key) {
      return respond(webview, 'nova:system:preferences:get', requestId, { success: true, key, value: OS.settings.get(key) });
    }
    return respond(webview, 'nova:system:preferences:get', requestId, { success: true, all: { ...(OS.settings._cache || {}) } });
  }

  async function handleSystemPreferencesSet({ payload, requestId, webview }) {
    if (typeof OS === 'undefined' || !OS.settings || typeof OS.settings.set !== 'function') {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'UNAVAILABLE', 'OS.settings not available');
    }
    const { key, value } = payload || {};
    if (!key) {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'INVALID_ARGS', 'key is required');
    }
    if (key === 'devMode' || key === 'rootAccessEnabled') {
      return respondError(webview, 'nova:system:preferences:set', requestId, 'PERMISSION_DENIED', `Settings key '${key}' can only be changed from the OS Settings app`);
    }
    OS.settings.set(key, value);
    // Settings runs sandboxed (no window.parent/host reference — see
    // app-sandbox.js's <webview> guest notes), so its own "window.DebugOverlay
    // && enable()/disable()" call is always a no-op: that global simply isn't
    // reachable from inside the guest. Drive the overlay from here instead,
    // where we're already running in the host context that owns it.
    if (key === 'devMode' && typeof window !== 'undefined' && window.DebugOverlay) {
      value ? window.DebugOverlay.enable() : window.DebugOverlay.disable();
    }
    return respond(webview, 'nova:system:preferences:set', requestId, { success: true, key, value });
  }

  async function isAdminEnabledClient(app) {
    try {
      const { json } = await authedJsonFetch('/api/security/settings', { app });
      return !!(json && json.success && json.data && json.data._meta);
    } catch {
      return false;
    }
  }

  function mailNotConnectedError(webview, channel, requestId) {
    return respondError(webview, channel, requestId, 'UNAVAILABLE', 'No email account connected — open the Email app and connect an account first');
  }

  // mail:session — connection/session lifecycle for the bundled Email app.
  // This keeps credential-bearing operations on the host side and out of the
  // guest renderer. Connecting/disconnecting is still permission-gated via
  // mail:write; only the destination server, protocol and credentials supplied
  // by the user are forwarded to the existing Email controller.
  async function handleMailSession({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:write', app.id)) {
      return respondError(webview, 'nova:mail:session', requestId, 'PERMISSION_DENIED', 'mail:write permission required');
    }
    const action = payload?.action;
    try {
      if (action === 'connect') {
        const q = payload?.account || {};
        if (!q.type || !q.host || !q.user || !q.pass) {
          return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'type, host, user and pass are required');
        }
        const ssl = q.ssl === undefined ? true : !!q.ssl;
        if (!ssl) {
          return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'Plaintext connections are not supported');
        }
        const { status, json } = await authedJsonFetch('/api/email/connect', {
          method: 'POST',
          app,
          body: {
            type: String(q.type).toLowerCase(),
            host: String(q.host),
            port: q.port,
            ssl: true,
            user: String(q.user),
            pass: String(q.pass),
          },
        });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Connect failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      if (action === 'disconnect') {
        const { status, json } = await authedJsonFetch('/api/email/disconnect', { method: 'POST', body: {}, app });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Disconnect failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      if (action === 'restore') {
        const { status, json } = await authedJsonFetch('/api/email/restore', { app });
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', json?.error || `Restore failed (${status})`);
        }
        return respond(webview, 'nova:mail:session', requestId, { success: true, action, data: json });
      }
      return respondError(webview, 'nova:mail:session', requestId, 'INVALID_ARGS', 'Unknown session action');
    } catch (e) {
      return respondError(webview, 'nova:mail:session', requestId, 'UNAVAILABLE', e?.message || 'Mail session request failed');
    }
  }

  // mail:read — folders, message lists, single messages, search. All GET,
  // no mutation of mailbox state.
  async function handleMailRead({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:read', app.id)) {
      return respondError(webview, 'nova:mail:read', requestId, 'PERMISSION_DENIED', 'mail:read permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'folders' ? 'folders'
      : q.action === 'message' ? 'message'
      : q.action === 'search' ? 'search'
      : q.action === 'account' ? 'account'
      : 'messages';
    try {
      let url;
      if (action === 'account') {
        url = '/api/email/restore';
      } else if (action === 'folders') {
        url = '/api/email/folders';
      } else if (action === 'message') {
        if (!q.uid) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'uid is required for action "message"');
        const p = new URLSearchParams();
        p.set('uid', String(q.uid));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/message?${p.toString()}`;
      } else if (action === 'search') {
        if (!q.query) return respondError(webview, 'nova:mail:read', requestId, 'INVALID_ARGS', 'query is required for action "search"');
        const p = new URLSearchParams();
        p.set('q', String(q.query));
        if (q.folder) p.set('folder', String(q.folder));
        url = `/api/email/search?${p.toString()}`;
      } else {
        const p = new URLSearchParams();
        if (q.folder) p.set('folder', String(q.folder));
        if (q.page) p.set('page', String(q.page));
        if (q.limit) p.set('limit', String(q.limit));
        url = `/api/email/messages?${p.toString()}`;
      }
      const { status, json } = await authedJsonFetch(url, { app });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:read', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', json?.error || 'Mail read request failed');
      }
      return respond(webview, 'nova:mail:read', requestId, { success: true, action, data: json });
    } catch (e) {
      return respondError(webview, 'nova:mail:read', requestId, 'UNAVAILABLE', e?.message || 'Mail read request failed');
    }
  }

  // mail:write — batch mutations that aren't deletion (mark-read, move)
  // plus HTML preview rendering. Deliberately excludes batch delete,
  // which is mail:delete's job even though both go through /api/email/batch.
  async function handleMailWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:write', app.id)) {
      return respondError(webview, 'nova:mail:write', requestId, 'PERMISSION_DENIED', 'mail:write permission required');
    }
    const q = payload ?? {};
    const action = q.action === 'preview' ? 'preview' : 'batch';
    try {
      if (action === 'preview') {
        if (typeof q.html !== 'string') return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'html string is required for action "preview"');
        const { status, json } = await authedJsonFetch('/api/email/preview', { method: 'POST', body: { html: q.html }, app });
        if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
        if (!json || json.error) {
          return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Preview request failed');
        }
        return respond(webview, 'nova:mail:write', requestId, { success: true, action, token: json.token });
      }
      // action === 'batch', op must be 'read' or 'move' — 'delete' isn't
      // allowed through this handler, that's mail:delete's surface.
      const op = q.op === 'move' ? 'move' : 'read';
      const uids = Array.isArray(q.uids) ? q.uids : [];
      if (!uids.length) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'uids array is required');
      if (op === 'move' && !q.dest) return respondError(webview, 'nova:mail:write', requestId, 'INVALID_ARGS', 'dest is required for op "move"');
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        app,
        body: { op, uids, folder: q.folder || 'INBOX', dest: q.dest },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:write', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', json?.error || 'Mail batch request failed');
      }
      return respond(webview, 'nova:mail:write', requestId, { success: true, action, op });
    } catch (e) {
      return respondError(webview, 'nova:mail:write', requestId, 'UNAVAILABLE', e?.message || 'Mail write request failed');
    }
  }

  // mail:send — SMTP send via the connected account's credentials.
  // The server has no way to know the account's real SMTP host/port on its
  // own: /connect only stores the IMAP/POP3/EWS host (e.g. imap.gmail.com),
  // which is frequently a *different* host than SMTP (smtp.gmail.com) —
  // silently reusing the IMAP host caused real send failures (TLS cert
  // mismatch) before this was required explicitly. The Email app's own UI
  // has a dedicated SMTP Host/Port field for exactly this reason; a
  // sandboxed app calling mail:send needs to supply the same thing rather
  // than have this handler guess at it.
  async function handleMailSend({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:send', app.id)) {
      return respondError(webview, 'nova:mail:send', requestId, 'PERMISSION_DENIED', 'mail:send permission required');
    }
    const q = payload ?? {};
    if (!q.to) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'to is required');
    if (!q.smtpHost) return respondError(webview, 'nova:mail:send', requestId, 'INVALID_ARGS', 'smtpHost is required — the server has no way to infer it from the connected IMAP/POP3/EWS account (they are frequently different hosts)');
    try {
      const { status, json } = await authedJsonFetch('/api/email/send', {
        method: 'POST',
        app,
        body: { to: q.to, cc: q.cc, bcc: q.bcc, subject: q.subject, text: q.text, html: q.html, host: q.smtpHost, port: q.smtpPort },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:send', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', json?.error || 'Send failed');
      }
      return respond(webview, 'nova:mail:send', requestId, { success: true, messageId: json.messageId });
    } catch (e) {
      return respondError(webview, 'nova:mail:send', requestId, 'UNAVAILABLE', e?.message || 'Send request failed');
    }
  }

  // mail:delete — batch delete only.
  async function handleMailDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('mail:delete', app.id)) {
      return respondError(webview, 'nova:mail:delete', requestId, 'PERMISSION_DENIED', 'mail:delete permission required');
    }
    const q = payload ?? {};
    const uids = Array.isArray(q.uids) ? q.uids : [];
    if (!uids.length) return respondError(webview, 'nova:mail:delete', requestId, 'INVALID_ARGS', 'uids array is required');
    try {
      const { status, json } = await authedJsonFetch('/api/email/batch', {
        method: 'POST',
        app,
        body: { op: 'delete', uids, folder: q.folder || 'INBOX' },
      });
      if (status === 401) return mailNotConnectedError(webview, 'nova:mail:delete', requestId);
      if (!json || json.error) {
        return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', json?.error || 'Mail delete request failed');
      }
      return respond(webview, 'nova:mail:delete', requestId, { success: true, deleted: uids.length });
    } catch (e) {
      return respondError(webview, 'nova:mail:delete', requestId, 'UNAVAILABLE', e?.message || 'Mail delete request failed');
    }
  }

  // App list / install / uninstall
  //
  // These, together with launch (above) and info, are what 'system:apps'
  // actually gates. list/uninstall are straightforward reads/writes on
  // AppRegistry. install is the interesting one: the App Manager package's real
  // install flow (processFile in js/apps/appmanager/app.js) can require up to
  // three human confirmation dialogs — untrusted signer, tampered
  // contents, or "already installed, replace?" — none of which a
  // sandboxed app calling this over IPC can click through. Rather than
  // silently bypassing a security gate a human would otherwise have to
  // consciously approve, this handler fails closed: it only succeeds for
  // a package that is fully signed, trust-store-verified, and unmodified,
  // with no existing install of the same app id already present. Anything
  // that would need a dialog is rejected with a message telling the
  // caller to have the user install manually via App Manager instead.

  function resolveSandboxAppIcon(icon) {
    if (typeof icon !== 'string' || !icon) return null;
    if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|x-icon);/i.test(icon)) {
      return icon.length <= 700_000 ? icon : null;
    }
    if (/^\/assets\/[a-zA-Z0-9._/-]+$/.test(icon) && !icon.split('/').includes('..')) {
      return icon;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(icon) || typeof svgIcon !== 'function') return null;

    const markup = svgIcon(icon, 64);
    const svg = markup.match(/<svg\b[\s\S]*?<\/svg>/i)?.[0];
    if (svg) {
      const withNamespace = svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNamespace)}`;
    }

    const assetPath = markup.match(/<img\b[^>]*\bsrc="(\/assets\/[a-zA-Z0-9._/-]+)"/i)?.[1];
    return assetPath && !assetPath.split('/').includes('..') ? assetPath : null;
  }

  async function handleAppList({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:list', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    // AppRegistry.installedApps is NOT what built-in apps register into —
    // built-in apps call the global registerApp() in js/apps/registry/service.js, which writes
    // to OS.apps + the module-level APP_REGISTRY array. AppRegistry's own
    // store only ever gets entries from its initialize() localStorage
    // restore, so it's effectively empty for the running OS's actual app
    // set. APP_REGISTRY is the real, live list everything else (launchpad,
    // taskbar, App Manager) reads from.
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:list', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const apps = APP_REGISTRY.map(a => ({
      id: a.id,
      name: a.name,
      version: a.version || '1.0.0',
      icon: a.icon || null,
      iconUrl: resolveSandboxAppIcon(a.icon),
      description: a.description || '',
      categories: a.categories || [],
      verified: !!a.verified,
      system: a.system === true || a.manifest?.system === true,
      signer: a.signer || null,
      manifest: a.manifest ? { system: a.manifest.system === true } : undefined,
      source: a.source || 'local',
      builtin: a.source !== 'file',
      devOnly: a.devOnly === true,
    }));
    return respond(webview, 'nova:app:list', requestId, { success: true, apps });
  }

  async function handleAppUninstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { appId } = payload ?? {};
    if (!appId) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'appId is required');
    }
    if (appId === app.id) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'INVALID_ARGS', 'An app cannot uninstall itself');
    }
    if (typeof APP_REGISTRY === 'undefined' || !Array.isArray(APP_REGISTRY)) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const target = APP_REGISTRY.find(a => a.id === appId);
    if (!target) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_FOUND', `No installed app with id ${appId}`);
    }
    // Built-in apps (source !== 'file') were never installed as a
    // .novaapp package — there's no package files, storage partition, or
    // app-data directory to clean up, and the App Manager package's own uninstall
    // UI has no path for removing them either. Refuse rather than
    // half-uninstall something that isn't really an installed package.
    if (target.source !== 'file') {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_UNINSTALLABLE', `"${target.name}" is a built-in system app and cannot be uninstalled`);
    }
    // System-signed .novaapp packages (verified against the dedicated
    // 'Astro System' trust-store key, see app-package.js) are equally
    // not user- or app-removable, same reasoning as the built-in check
    // above — PackageStore.removeApp() enforces this too, but checking
    // here first gives a clearer error code/message than letting it fall
    // through to a generic UNAVAILABLE/silent-false from that call.
    if (target.system === true) {
      return respondError(webview, 'nova:app:uninstall', requestId, 'NOT_UNINSTALLABLE', `"${target.name}" is a system app and cannot be uninstalled`);
    }

    // Mirrors the App Manager package's doUninstall(): close open windows, then
    // clean up package files, the app's storage partition, and its app
    // data directory, then remove from every registry/list that tracks
    // it. Each cleanup step is independently best-effort (matching the
    // manual path's own try/catch-per-step), since a failure in one
    // (e.g. partition already cleared) shouldn't block the others.
    if (typeof WM !== 'undefined' && WM.closeWindow && OS?.windows && typeof OS.windows[Symbol.iterator] === 'function') {
      const openWindowIds = [];
      for (const [wid, wstate] of OS.windows) {
        if (wstate.appId === appId) openWindowIds.push(wid);
      }
      await Promise.all(openWindowIds.map(wid => WM.closeWindow(wid)));
    }
    try {
      if (typeof AppRegistry?.uninstallApp !== 'function' ||
          !(await AppRegistry.uninstallApp(appId))) {
        throw new Error('App registry refused the uninstall request');
      }
    } catch (e) {
      log('error', 'nova:app:uninstall — package uninstall failed for', appId, e);
      return respondError(webview, 'nova:app:uninstall', requestId, 'UNINSTALL_FAILED',
        e?.message || 'The app could not be fully uninstalled');
    }
    try {
      if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartition) {
        await AppSandbox.clearAppPartition(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear storage partition for', appId, e);
    }
    // nova:storage:* is a separate host-shell-side IndexedDB keyed by
    // [appId, key] — clearAppPartition never touches it (see destroy()'s
    // long comment). Every manual uninstall path (Launchpad, App Manager,
    // My Apps, Store) wipes both; this IPC path must too, or an
    // uninstall/reinstall cycle leaks the previous install's key-value data.
    try {
      await storageClear(appId);
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear nova:storage for', appId, e);
    }
    // The ledger's accounting, budget overrides, and access-log entries for
    // this app die with the install too (Android clears app state on
    // uninstall).
    try {
      StorageLedger.removeApp(appId);
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear storage ledger for', appId, e);
    }
    // Android parity: uninstalling an app resets its runtime permissions.
    // Without this, grants (and denials) persist in localStorage forever and
    // a reinstall of the same package id silently inherits the previous
    // install's capabilities. revokeAllPermissions also triggers the root
    // reload and the same-origin/nested-webview live-sandbox teardown.
    try {
      if (typeof AppPermissionManager !== 'undefined' && typeof AppPermissionManager.revokeAllPermissions === 'function') {
        await AppPermissionManager.revokeAllPermissions(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to reset permissions for', appId, e);
    }
    try {
      if (typeof AppDirs !== 'undefined' && AppDirs.removeAppData) {
        await AppDirs.removeAppData(appId);
      }
    } catch (e) {
      log('warn', 'nova:app:uninstall — failed to clear app data for', appId, e);
    }
    // Drop the notification rate-limit entries so they don't leak across
    // an uninstall/reinstall cycle for the same app id.
    clearNotificationRateLimit(appId);
    clearNotificationUpdateRateLimit(appId);
    // Channels, channel overrides, and queued notification actions die with
    // the app (Android removes channels on uninstall too). Guarded: Notify
    // lives in the shell bundle and may be absent in headless test runs.
    if (typeof Notify !== 'undefined' && Notify.removeAllAppState) {
      Notify.removeAllAppState(appId);
    }
    clearDefaultAppsRateLimit(appId);

    delete OS.apps[appId];
    const ri = APP_REGISTRY.findIndex(a => a.id === appId);
    if (ri > -1) APP_REGISTRY.splice(ri, 1);

    // the App Manager package's own local installedApps array + its persisted copy
    // is a THIRD place tracking installed-from-file apps, independent of
    // APP_REGISTRY/OS.apps — remove from there too if it's reachable from
    // this scope, same as the manual uninstall path does.
    try {
      if (typeof installedApps !== 'undefined' && Array.isArray(installedApps)) {
        const ii = installedApps.findIndex(a => a.id === appId);
        if (ii > -1) installedApps.splice(ii, 1);
        if (typeof saveStoredApps === 'function') saveStoredApps(installedApps);
      }
    } catch (e) {
      // the App Manager's local state isn't in scope here — APP_REGISTRY/
      // OS.apps removal above is the part that actually matters.
      log('debug', 'nova:app:uninstall — could not sync App Manager local state for', appId, e);
    }

    OS.settings?.set?.('pinnedApps', (OS.settings?.get?.('pinnedApps') || []).filter(id => id !== appId));
    if (typeof WM !== 'undefined' && WM.updateTaskbar) WM.updateTaskbar();
    if (typeof renderDesktopIcons === 'function') {
      try { renderDesktopIcons(); } catch (e) { log('debug', 'renderDesktopIcons threw during uninstall', e); }
    }

    return respond(webview, 'nova:app:uninstall', requestId, { success: true, removed: true });
  }

  async function handleAppInstall({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:apps', app.id)) {
      return respondError(webview, 'nova:app:install', requestId, 'PERMISSION_DENIED', 'system:apps permission required');
    }
    const { package: pkg } = payload ?? {};
    if (!pkg || typeof pkg !== 'object') {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_ARGS', 'package (a parsed .novaapp object) is required');
    }
    if (!pkg.manifest?.id || !pkg.manifest?.name || !pkg.manifest?.version) {
      return respondError(webview, 'nova:app:install', requestId, 'INVALID_PACKAGE', 'Missing required manifest fields (id, name, version)');
    }

    // Malware/heuristic scan — same as the manual install path, and
    // equally non-negotiable: no override, no "proceed anyway".
    if (window.Scanner?.scanBase64 && pkg.files && typeof pkg.files === 'object') {
      for (const [relPath, rawB64] of Object.entries(pkg.files)) {
        if (typeof rawB64 !== 'string') continue;
        try {
          const verdict = await window.Scanner.scanBase64(relPath, rawB64);
          if (!verdict.safe) {
            return respondError(webview, 'nova:app:install', requestId, 'MALICIOUS_PACKAGE',
              `File "${relPath}" was flagged and installation was blocked: ${verdict.reason || 'matched a pattern associated with malicious files'}`);
          }
        } catch (err) {
          // Scanner error is treated as inconclusive, not a pass — the
          // manual path silently continues past scanner errors (best
          // effort, since a human is still there to react to whatever
          // comes next), but this unattended path has no human backstop,
          // so an inconclusive scan blocks install instead.
          return respondError(webview, 'nova:app:install', requestId, 'SCAN_FAILED', `Could not scan "${relPath}": ${err?.message || err}`);
        }
      }
    }

    // Integrity — must be present and must pass. No informational-only
    // path here (the manual flow can warn-and-proceed via a dialog; this
    // one can't warn anyone, so a failed or missing integrity check is a
    // hard stop).
    if (!pkg.integrity || typeof AppPackage === 'undefined' || typeof AppPackage.verifyIntegrity !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNVERIFIED', 'Package has no integrity record — install manually via App Manager');
    }
    let integrityOk = false;
    try { integrityOk = await AppPackage.verifyIntegrity(pkg); } catch (e) {
      log('warn', 'nova:app:install — integrity verification threw for', pkg.manifest.id, e);
    }
    if (!integrityOk) {
      return respondError(webview, 'nova:app:install', requestId, 'TAMPERED', 'Package contents do not match their recorded integrity hashes — install manually via App Manager to review');
    }

    // Trust — must be signed and the signature must resolve to a trusted
    // entry in the trust store, not revoked. This is the check that
    // rejects unsigned packages by design, same as the manual flow would
    // show "Unverified" for one.
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyAgainstTrustStore !== 'function' || typeof TrustStore === 'undefined') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'Trust store not available');
    }
    let trustResult;
    try {
      const revocationCheck = typeof TrustStore.isRevoked === 'function' ? TrustStore.isRevoked : undefined;
      trustResult = await AppPackage.verifyAgainstTrustStore(pkg, TrustStore.list(), revocationCheck);
    } catch (e) {
      log('warn', 'nova:app:install — trust verification threw for', pkg.manifest.id, e);
      trustResult = { trusted: false, signer: null };
    }
    if (!trustResult.trusted) {
      const reason = trustResult.revoked ? 'the signature is on the revocation list' : 'the package is unsigned or not from a trusted publisher';
      return respondError(webview, 'nova:app:install', requestId, 'UNTRUSTED', `Install blocked — ${reason}. Install manually via App Manager to review and confirm.`);
    }

    // Already-installed — the manual flow asks "replace?"; this path has
    // no one to ask, so it refuses rather than silently overwriting an
    // existing install (which could be a downgrade, or could clobber user
    // data tied to the old version).
    if (typeof AppRegistry === 'undefined' || typeof AppRegistry.getApp !== 'function' || typeof AppRegistry.registerApp !== 'function') {
      return respondError(webview, 'nova:app:install', requestId, 'UNAVAILABLE', 'App registry not available');
    }
    const existing = AppRegistry.getApp(pkg.manifest.id);
    if (existing) {
      return respondError(webview, 'nova:app:install', requestId, 'ALREADY_INSTALLED', `"${pkg.manifest.name}" (${pkg.manifest.id}) is already installed — install manually via App Manager to replace it`);
    }

    // All gates passed: signed, trusted, unmodified, not a duplicate.
    // Register it the same way the App Manager package's manual path ultimately
    // does — via AppRegistry, not by hand-rolling a second code path.
    try {
      const appData = {
        ...pkg.manifest,
        manifest: pkg.manifest,
        files: pkg.files,
        signature: pkg.signature,
        integrity: pkg.integrity,
        verified: true,
        signer: trustResult.signer,
        source: 'file',
        installedDate: new Date().toISOString(),
      };
      const registered = AppRegistry.registerApp(appData);
      return respond(webview, 'nova:app:install', requestId, {
        success: true,
        id: registered.id,
        name: registered.name,
        version: registered.version,
      });
    } catch (e) {
      return respondError(webview, 'nova:app:install', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  // Events
  //
  // Basic appearance/workspace/device-state events are public; sensitive
  // app inventory and user-data events require system:events.
  // Without an allowlist, an app could subscribe to internal channels like
  // 'settings:changed' (which fires for every settings write, including
  // password/PIN updates from system code) or 'os:volumeChanged' purely for
  // reconnaissance. Limit subscriptions to the public event surface — names
  // the OS explicitly emits for app consumption — and reject anything else
  // rather than forwarding it.
  const ALLOWED_EVENT_NAMES = new Set([
    'system:notification', 'system:volumeChanged', 'system:themeChanged',
    'system:workspaceChanged', 'system:power', 'system:network',
    'app:installed', 'app:uninstalled', 'app:launched',
    // As of this comment, nothing in the codebase calls OS.events.emit()
    // for any of the five names below — subscribing today is a no-op, not
    // a live leak. Pre-declared for whoever wires up mail/calendar/contacts
    // sync, gated on the same *:read permission each domain's actual data
    // access already requires (see EVENT_DOMAIN_PERMISSIONS below), rather
    // than being reachable through the flat system:events grant alone. An
    // app that can already read your mail gains nothing new from mail:new
    // notifications; an app that only holds system:events (for volume/
    // theme/power — genuinely low-stakes) can't piggyback into mail
    // metadata just because these names exist in this set. Whoever
    // implements the emit side should still double check the actual
    // payload shape against this gate once it's real, since this was
    // designed against the *names* only — no payload existed to review.
    'mail:new', 'mail:updated',
    'calendar:reminder', 'calendar:updated',
    'contacts:updated',
    // Raw WebSocket push channels (the nova:net:websocket data plane).
    // Without these the raw channels were send-only: connect/send/close
    // answered, but the host's per-socket pushes (nova:net:ws:message etc.)
    // only ever reached wrapper/facade listeners registered per wsId — a
    // raw nova.ipc app had no receive path at all. The host mirrors every
    // socket push onto the OS event bus (see handleNetWebsocket's
    // onmessage/onerror/onclose), so subscribing here completes the raw
    // API. Two things keep this from becoming a wiretap:
    //   1. EVENT_DOMAIN_PERMISSIONS below gates the names on net:websocket
    //      — the same permission opening a socket already needs — rather
    //      than the flat system:events grant.
    //   2. The bus is global, so the emitted payload carries the owning
    //      app's id and handleEventsSubscribe drops deliveries addressed
    //      to another app (WS_PUSH_EVENT_NAMES filter). Subscribers only
    //      ever hear their own sockets.
    'nova:net:ws:message', 'nova:net:ws:error', 'nova:net:ws:close',
    // AstroOS Registry change notifications. The engine (nova-registry.js)
    // emits one event per committed write/delete/import with the value path,
    // type, value, and the writing app's id. Registry config facts are not
    // per-app private state — every registry reader may hear that something
    // changed — but subscribing is still gated on registry.read (the same
    // grant reading needs — see EVENT_DOMAIN_PERMISSIONS below), so only
    // apps that could have polled the store get push instead of poll.
    'nova:reg:changed',
  ]);
  // The subscribable WebSocket push names — used by the same-app delivery
  // filter in handleEventsSubscribe. Kept as its own set so adding a future
  // per-event filter can't accidentally forget these.
  const WS_PUSH_EVENT_NAMES = new Set([
    'nova:net:ws:message', 'nova:net:ws:error', 'nova:net:ws:close',
  ]);
  const SENSITIVE_EVENT_NAMES = new Set([
    'system:notification', 'app:installed', 'app:uninstalled', 'app:launched',
    'mail:new', 'mail:updated', 'calendar:reminder', 'calendar:updated', 'contacts:updated',
  ]);

  // Domain-gated events: subscribing requires system:events AND the listed
  // permission, not system:events alone. Events not listed here only need
  // system:events, same as before this split.
  const EVENT_DOMAIN_PERMISSIONS = new Map([
    ['mail:new', 'mail:read'],
    ['mail:updated', 'mail:read'],
    ['calendar:reminder', 'calendar:read'],
    ['calendar:updated', 'calendar:read'],
    ['contacts:updated', 'contacts:read'],
    // WebSocket push events gate on the same permission the raw connect
    // channel requires — an app that can open sockets gains nothing new
    // from hearing them, and an app without the grant can't subscribe.
    ['nova:net:ws:message', 'net:websocket'],
    ['nova:net:ws:error', 'net:websocket'],
    ['nova:net:ws:close', 'net:websocket'],
    // Registry change events gate on the same grant reading the registry
    // needs — watching is reading, exactly like fs:watch vs nova:fs:read.
    ['nova:reg:changed', 'registry.read'],
  ]);

  // Legacy OS-wide default; the live cap is per-app via the ledger budget
  // (ipcPayloadBytes, default 256 KB) — see StorageLedger.DEFAULT_BUDGETS.
  const APP_IPC_LEGACY_MAX_PAYLOAD_BYTES = 64 * 1024;
  const APP_IPC_TIMEOUT_MS = 25_000;
  const APP_IPC_ENDPOINT_PATTERN = /^(?:service|provider):[a-z0-9][a-z0-9._-]{0,127}$/;
  const APP_IPC_ACTION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

  function getAppIpcManifest(appId) {
    const osManifest = OS?.apps?.[appId]?.manifest?.ipc;
    const registryManifest = typeof AppRegistry !== 'undefined'
      ? AppRegistry?.getApp?.(appId)?.manifest?.ipc
      : null;
    const ipcManifest = osManifest || registryManifest;
    return ipcManifest && typeof ipcManifest === 'object' && !Array.isArray(ipcManifest)
      ? ipcManifest
      : {};
  }

  function declaredIpcValues(appId, key) {
    const values = getAppIpcManifest(appId)[key];
    return Array.isArray(values) ? values.filter(value => typeof value === 'string') : [];
  }

  function normalizeAppIpcPayload(value, appId) {
    try {
      const maxBytes = StorageLedger.getBudget(appId, 'ipcPayloadBytes') || APP_IPC_LEGACY_MAX_PAYLOAD_BYTES;
      const serialized = JSON.stringify(value === undefined ? null : value);
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes) {
        return { error: `IPC payload exceeds the ${Math.round(maxBytes / 1024)} KB limit` };
      }
      return { value: JSON.parse(serialized) };
    } catch (error) {
      return { error: `IPC payload is not JSON-serializable: ${error?.message || error}` };
    }
  }

  function appIpcRateLimit(appId, type) {
    const key = `${appId}:${type}`;
    const now = Date.now();
    const recent = (appIpcRateLimits.get(key) || []).filter(timestamp => timestamp > now - 60_000);
    if (recent.length >= 20) {
      appIpcRateLimits.set(key, recent);
      return false;
    }
    recent.push(now);
    appIpcRateLimits.set(key, recent);
    return true;
  }

  function activeSandboxId(webview) {
    return webview?.dataset?.sandboxId || null;
  }

  function cancelAppIpcForSandbox(sandboxId) {
    if (!sandboxId) return;
    for (const [callId, pending] of pendingAppIpcCalls) {
      if (pending.sourceSandboxId !== sandboxId && pending.targetSandboxId !== sandboxId) continue;
      pendingAppIpcCalls.delete(callId);
      clearTimeout(pending.timer);
      pending.resolve({ error: 'An app sandbox closed before the IPC request completed' });
    }
  }

  function handleAppIpcRegister({ payload, requestId, app, webview, sandbox }) {
    const endpoint = payload?.endpoint;
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:register', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    if (typeof endpoint !== 'string' || !APP_IPC_ENDPOINT_PATTERN.test(endpoint)) {
      return respondError(webview, 'nova:ipc:register', requestId, 'INVALID_ARGS', 'endpoint must be a valid service: or provider: name');
    }
    if (!declaredIpcValues(app.id, 'exports').includes(endpoint)) {
      return respondError(webview, 'nova:ipc:register', requestId, 'PERMISSION_DENIED', 'Endpoint is not declared in manifest.ipc.exports');
    }
    const sandboxId = activeSandboxId(webview);
    if (!sandboxId || !sandbox || activeSandboxes.get(sandboxId) !== sandbox || sandbox.appId !== app.id) {
      return respondError(webview, 'nova:ipc:register', requestId, 'UNAVAILABLE', 'App sandbox is not active');
    }
    if (!(sandbox.appIpcEndpoints instanceof Set)) sandbox.appIpcEndpoints = new Set();
    if (sandbox.appIpcEndpoints.has(endpoint)) {
      return respondError(webview, 'nova:ipc:register', requestId, 'ALREADY_REGISTERED', 'Endpoint is already registered');
    }
    sandbox.appIpcEndpoints.add(endpoint);
    return respond(webview, 'nova:ipc:register', requestId, { success: true, endpoint });
  }

  function handleAppIpcUnregister({ payload, requestId, app, webview, sandbox }) {
    // Gated for consistency with the rest of the nova:ipc:* family — an app
    // without apps:communicate never legitimately registered an endpoint, so
    // there is nothing it should be able to tear down over the bridge.
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:unregister', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    const endpoint = payload?.endpoint;
    if (typeof endpoint === 'string') sandbox?.appIpcEndpoints?.delete(endpoint);
    return respond(webview, 'nova:ipc:unregister', requestId, { success: true, endpoint });
  }

  async function handleAppIpcInvoke({ payload, requestId, app, webview }) {
    const targetAppId = typeof payload?.targetAppId === 'string' ? payload.targetAppId : '';
    const endpoint = payload?.endpoint;
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    if (!targetAppId || typeof endpoint !== 'string' || !APP_IPC_ENDPOINT_PATTERN.test(endpoint)) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'INVALID_ARGS', 'targetAppId and a valid endpoint are required');
    }
    if (!appIpcRateLimit(app.id, 'invoke')) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'RATE_LIMITED', 'Max 20 app IPC calls per minute');
    }
    if (!declaredIpcValues(targetAppId, 'exports').includes(endpoint)) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'NOT_FOUND', 'Target app does not export this endpoint');
    }
    if (!AppPermissionManager.isGranted('apps:communicate', targetAppId)) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'PERMISSION_DENIED', 'Target app has not enabled apps:communicate');
    }
    const targetSandbox = [...activeSandboxes.values()].find(candidate =>
      candidate.appId === targetAppId
      && candidate.appIpcEndpoints instanceof Set
      && candidate.appIpcEndpoints.has(endpoint)
      && candidate.webview
    );
    if (!targetSandbox) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'UNAVAILABLE', 'Target endpoint is not running');
    }
    const safePayload = normalizeAppIpcPayload(payload.data, app.id);
    if (safePayload.error) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'INVALID_ARGS', safePayload.error);
    }
    StorageLedger.noteRequest(app.id);

    const callId = generateRequestId();
    const sourceSandboxId = activeSandboxId(webview);
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => {
        pendingAppIpcCalls.delete(callId);
        resolve({ error: 'Target app did not respond before the IPC timeout' });
      }, APP_IPC_TIMEOUT_MS);
      pendingAppIpcCalls.set(callId, {
        sourceSandboxId,
        targetSandboxId: targetSandbox.webview.dataset.sandboxId,
        timer,
        resolve,
      });
      respond(targetSandbox.webview, 'nova:ipc:request', callId, {
        endpoint,
        sourceAppId: app.id,
        data: safePayload.value,
      });
    });
    if (outcome.error) {
      return respondError(webview, 'nova:ipc:invoke', requestId, 'REMOTE_ERROR', outcome.error);
    }
    // Respond with the provider's own return value as the result, NOT a
    // { result: … } wrapper around it. The guest-side shim merges msg.result
    // onto the response's top level AND exposes it as response.result, so a
    // wrapper here made apps read response.result.result — one level deeper
    // than the documented `const response = await nova.ipc.call(…);
    // response.result` contract (NOVAAPP.md, Inter-app communication).
    // A primitive or null provider return round-trips as response.result
    // unchanged; an object return additionally spreads its fields onto the
    // top level, same as every other handler.
    return respond(webview, 'nova:ipc:invoke', requestId, outcome.result);
  }

  function handleAppIpcReply({ payload, requestId, app, webview, sandbox }) {
    // Defense in depth: only an app holding apps:communicate may act as an
    // IPC endpoint at all, so it is also the only thing that can complete a
    // pending request. Without this gate a stripped app could still resolve
    // an in-flight call (e.g. granted, then revoked mid-call).
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:reply', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    const callId = payload?.callId;
    const pending = typeof callId === 'string' ? pendingAppIpcCalls.get(callId) : null;
    const sandboxId = activeSandboxId(webview);
    if (!pending || !sandbox || pending.targetSandboxId !== sandboxId
      || activeSandboxes.get(sandboxId) !== sandbox || sandbox.appId !== app.id) {
      return respondError(webview, 'nova:ipc:reply', requestId, 'NOT_FOUND', 'IPC request is no longer active');
    }
    pendingAppIpcCalls.delete(callId);
    clearTimeout(pending.timer);
    if (typeof payload.error === 'string' && payload.error) {
      pending.resolve({ error: payload.error.slice(0, 500) });
    } else {
      const safeResult = normalizeAppIpcPayload(payload.result, app.id);
      pending.resolve(safeResult.error ? { error: safeResult.error } : { result: safeResult.value });
    }
    return respond(webview, 'nova:ipc:reply', requestId, { success: true });
  }

  function handleAppIpcBroadcastSubscribe({ payload, requestId, app, webview, sandbox }) {
    const action = payload?.action;
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:broadcast:subscribe', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    if (typeof action !== 'string' || !APP_IPC_ACTION_PATTERN.test(action)
      || !declaredIpcValues(app.id, 'receives').includes(action)) {
      return respondError(webview, 'nova:ipc:broadcast:subscribe', requestId, 'PERMISSION_DENIED', 'Broadcast action must be declared in manifest.ipc.receives');
    }
    const sandboxId = activeSandboxId(webview);
    if (!sandboxId || !sandbox || activeSandboxes.get(sandboxId) !== sandbox || sandbox.appId !== app.id) {
      return respondError(webview, 'nova:ipc:broadcast:subscribe', requestId, 'UNAVAILABLE', 'App sandbox is not active');
    }
    if (!(sandbox.ipcBroadcastActions instanceof Set)) sandbox.ipcBroadcastActions = new Set();
    sandbox.ipcBroadcastActions.add(action);
    return respond(webview, 'nova:ipc:broadcast:subscribe', requestId, { success: true, action });
  }

  function handleAppIpcBroadcastUnsubscribe({ payload, requestId, webview, sandbox }) {
    const action = payload?.action;
    if (typeof action === 'string') sandbox?.ipcBroadcastActions?.delete(action);
    return respond(webview, 'nova:ipc:broadcast:unsubscribe', requestId, { success: true, action });
  }

  function handleAppIpcBroadcast({ payload, requestId, app, webview }) {
    const action = payload?.action;
    if (!AppPermissionManager.isGranted('apps:communicate', app.id)) {
      return respondError(webview, 'nova:ipc:broadcast', requestId, 'PERMISSION_DENIED', 'apps:communicate permission required');
    }
    if (typeof action !== 'string' || !APP_IPC_ACTION_PATTERN.test(action)) {
      return respondError(webview, 'nova:ipc:broadcast', requestId, 'INVALID_ARGS', 'A valid broadcast action is required');
    }
    if (!appIpcRateLimit(app.id, 'broadcast')) {
      return respondError(webview, 'nova:ipc:broadcast', requestId, 'RATE_LIMITED', 'Max 20 app broadcasts per minute');
    }
    const safePayload = normalizeAppIpcPayload(payload.data, app.id);
    if (safePayload.error) {
      return respondError(webview, 'nova:ipc:broadcast', requestId, 'INVALID_ARGS', safePayload.error);
    }
    let delivered = 0;
    for (const targetSandbox of activeSandboxes.values()) {
      if (!targetSandbox.ipcBroadcastActions?.has(action)
        || !AppPermissionManager.isGranted('apps:communicate', targetSandbox.appId)) continue;
      respond(targetSandbox.webview, 'nova:ipc:broadcast', generateRequestId(), {
        action,
        sourceAppId: app.id,
        data: safePayload.value,
      });
      delivered++;
    }
    return respond(webview, 'nova:ipc:broadcast', requestId, { delivered });
  }

  async function handleEventsSubscribe({ payload, requestId, app, webview, sandbox }) {
    const { event } = payload ?? {};
    if (SENSITIVE_EVENT_NAMES.has(event) && !AppPermissionManager.isGranted('system:events', app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', 'system:events permission required');
    }
    if (!event) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', 'event name is required');
    }
    if (typeof event !== 'string' || !ALLOWED_EVENT_NAMES.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'INVALID_ARGS', `Event '${event}' is not in the subscribable allowlist`);
    }
    const domainPermission = EVENT_DOMAIN_PERMISSIONS.get(event);
    if (domainPermission && !AppPermissionManager.isGranted(domainPermission, app.id)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'PERMISSION_DENIED', `${domainPermission} permission required to subscribe to '${event}'`);
    }
    const sandboxId = webview.dataset.sandboxId;
    const subs = eventSubscriptions.get(sandboxId);
    if (subs && subs.has(event)) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'ALREADY_SUBSCRIBED', `Already subscribed to '${event}'`);
    }
    const handler = (data) => {
      // WebSocket socket-push events ride the global bus with the owning
      // app's id in the payload — silently drop deliveries addressed to
      // another app, so a subscriber to the name only ever hears its own
      // sockets (see ALLOWED_EVENT_NAMES / WS_PUSH_EVENT_NAMES).
      if (WS_PUSH_EVENT_NAMES.has(event) && data?.appId !== app.id) return;
      respond(webview, 'nova:events:event', generateRequestId(), { event, data });
    };
    // Only register and record the subscription if OS.events actually
    // exists — otherwise we'd record a handler that never fires and
    // silently mislead the app into thinking it's subscribed.
    if (!OS?.events?.on) {
      return respondError(webview, 'nova:events:subscribe', requestId, 'UNAVAILABLE', 'Event bus not available');
    }
    OS.events.on(event, handler);
    if (subs) subs.set(event, handler);
    return respond(webview, 'nova:events:subscribe', requestId, { success: true, subscribed: event });
  }

  async function handleEventsUnsubscribe({ payload, requestId, app, webview }) {
    const { event } = payload ?? {};
    const subs = eventSubscriptions.get(webview.dataset.sandboxId);
    if (subs && subs.has(event)) {
      const handler = subs.get(event);
      OS?.events?.off(event, handler);
      subs.delete(event);
    }
    return respond(webview, 'nova:events:unsubscribe', requestId, { success: true, unsubscribed: event });
  }

  // Network: fetch

  async function handleNetFetch({ payload, requestId, app, webview }) {
    const { url: rawUrl, method, headers, body, bodyEncoding } = payload ?? {};
    if (!rawUrl) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'url is required');
    }
    const safeMethod = (method || 'GET').toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(safeMethod)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', `Method not allowed: ${safeMethod}`);
    }
    // Resolve and classify the URL in one pass. This catches protocol-relative
    // URLs (//evil.com) that the old leading-slash check missed.
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) {
      return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', classified.error);
    }
    const netPerm = classified.isInternal ? 'net:internal' : 'net:external';
    if (!AppPermissionManager.isGranted(netPerm, app.id)) {
      return respondError(webview, 'nova:net:fetch', requestId, 'PERMISSION_DENIED', `${netPerm} permission required`);
    }
    StorageLedger.noteRequest(app.id);
    // Normalize headers to a plain object — apps can pass a Headers instance,
    // an array of pairs, or a plain object. Same conversion the shim does
    // client-side; redo here so the proxy path doesn't choke on a non-plain
    // value getting JSON.stringify'd.
    const headerObj = {};
    if (headers && typeof headers === 'object') {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((v, k) => { headerObj[k] = v; });
      } else if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (Array.isArray(pair) && pair.length >= 2) {
            headerObj[String(pair[0])] = String(pair[1]);
          }
        }
      } else {
        for (const k of Object.keys(headers)) {
          headerObj[k] = String(headers[k]);
        }
      }
    }
    try {
      let requestBody = body ?? null;
      if (bodyEncoding === 'base64' && typeof body === 'string') {
        try {
          const binary = atob(body);
          const maxBodyBytes = StorageLedger.getBudget(app.id, 'httpBodyBytes');
          if (binary.length > maxBodyBytes) {
            return respondError(webview, 'nova:net:fetch', requestId, 'PAYLOAD_TOO_LARGE', `Binary request body exceeds the ${Math.round(maxBodyBytes / (1024 * 1024))} MiB limit`);
          }
          StorageLedger.noteBytes(app.id, { written: binary.length });
          requestBody = Uint8Array.from(binary, character => character.charCodeAt(0));
        } catch (error) {
          return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'Invalid base64 request body');
        }
      } else if (bodyEncoding && bodyEncoding !== 'utf8') {
        return respondError(webview, 'nova:net:fetch', requestId, 'INVALID_ARGS', 'Unsupported request body encoding');
      } else if (typeof requestBody === 'string' && requestBody.length > 0) {
        StorageLedger.noteBytes(app.id, { written: sharedTextEncoder.encode(requestBody).length });
      }
      let resStatus, resStatusText, resHeaders, resBody, resBodyEncoding = 'utf8';

      if (classified.isInternal) {
        // Same-origin requests don't hit CORS, so go direct.
        Object.assign(headerObj, systemAppRateLimitHeaders(app));
        const res = await fetch(classified.url, {
          method: safeMethod,
          headers: headerObj,
          body: requestBody,
        });
        resStatus = res.status;
        resStatusText = res.statusText;
        resHeaders = Object.fromEntries(res.headers.entries());
        const contentType = (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
        const isTextual = contentType.startsWith('text/')
          || contentType === 'application/json'
          || contentType === 'application/javascript'
          || contentType === 'application/xml'
          || contentType === 'application/x-www-form-urlencoded'
          || contentType.endsWith('+json')
          || contentType.endsWith('+xml');
        if (isTextual) {
          resBody = await res.text();
        } else {
          resBody = encodeBase64Bytes(new Uint8Array(await res.arrayBuffer()));
          resBodyEncoding = 'base64';
        }
      } else {
        // External requests go through the server-side proxy. A direct fetch()
        // from this document would be subject to the target server's CORS
        // policy (most external APIs don't allow browser-origin requests),
        // so we hand the request to /api/proxy, which makes it server-to-server.
        const { status: proxyStatus, ok, json: proxyJson } = await authedJsonFetch('/api/proxy', {
          method: 'POST',
          app,
          body: { url: classified.url, method: safeMethod, headers: headerObj, body: body ?? null, bodyEncoding: bodyEncoding || 'utf8' },
        });
        if (!ok) {
          return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', proxyJson?.error || `Proxy request failed (${proxyStatus})`);
        }
        resStatus = proxyJson.status;
        resStatusText = proxyJson.statusText;
        resHeaders = proxyJson.headers || {};
        resBody = proxyJson.body || '';
        resBodyEncoding = proxyJson.bodyEncoding || 'utf8';
      }

      return respond(webview, 'nova:net:fetch', requestId, {
        success: true,
        status: resStatus,
        statusText: resStatusText,
        headers: resHeaders,
        body: resBody,
        bodyEncoding: resBodyEncoding,
      });
    } catch (e) {
      return respondError(webview, 'nova:net:fetch', requestId, 'NETWORK_ERROR', e?.message || String(e));
    }
  }

  // Network: WebSocket

  async function handleNetWebsocket({ payload, requestId, app, webview, sandbox }) {
    const { url, protocols } = payload ?? {};
    if (!url) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', 'url is required');
    }
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:websocket', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!AppPermissionManager.isGranted('net:websocket', app.id)) {
      return respondError(webview, 'nova:net:websocket', requestId, 'PERMISSION_DENIED', 'net:websocket permission required');
    }
    const classified = resolveAndClassifyWebSocketUrl(url);
    if (!classified.valid) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', classified.error);
    }
    if (classified.isInternal && !AppPermissionManager.isGranted('net:internal', app.id)) {
      return respondError(webview, 'nova:net:websocket', requestId, 'PERMISSION_DENIED', 'net:internal permission required for private or first-party WebSocket destinations');
    }
    let ws;
    try {
      ws = protocols?.length
        ? new WebSocket(classified.url, protocols)
        : new WebSocket(classified.url);
    } catch (e) {
      return respondError(webview, 'nova:net:websocket', requestId, 'INVALID_ARGS', e?.message || 'Unknown error');
    }
    const wsId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Track the WebSocket so destroy() can close it when the sandbox is torn
    // down. Without this, sockets would outlive their app and leak.
    if (sandbox) {
      if (!sandbox.wsConnections) sandbox.wsConnections = new Map();
      sandbox.wsConnections.set(wsId, { ws, appId: app.id });
    }
    ws.onopen = () => respond(webview, 'nova:net:websocket', requestId, { success: true, wsId, readyState: ws.readyState });
    ws.onmessage = (e) => {
      respond(webview, 'nova:net:ws:message', generateRequestId(), { wsId, data: e.data });
      // Mirror the push onto the OS event bus so apps subscribed via
      // nova:events:subscribe (window.nova.onEvent / novaOS.events.on) —
      // including apps that opened this socket through the raw channels —
      // receive it too. The per-webview respond above only ever reaches
      // wrapper/facade listeners registered per wsId. The appId in the
      // payload is what handleEventsSubscribe filters on; without it every
      // subscriber to the bus name would hear every app's socket traffic.
      OS?.events?.emit?.('nova:net:ws:message', { appId: app.id, wsId, data: e.data });
    };
    ws.onerror = () => {
      respond(webview, 'nova:net:ws:error', generateRequestId(), { wsId, error: 'WebSocket error' });
      OS?.events?.emit?.('nova:net:ws:error', { appId: app.id, wsId, error: 'WebSocket error' });
    };
    ws.onclose = (e) => {
      respond(webview, 'nova:net:ws:close', generateRequestId(), {
        wsId, code: e.code, reason: e.reason, clean: e.wasClean,
      });
      OS?.events?.emit?.('nova:net:ws:close', {
        appId: app.id, wsId, code: e.code, reason: e.reason, clean: e.wasClean,
      });
      sandbox?.wsConnections?.delete(wsId);
    };
    // Response is sent asynchronously via onopen; nothing to return here.
  }

  async function handleNetWsSend({ payload, requestId, sandbox, webview }) {
    const { wsId, data } = payload ?? {};
    if (typeof WebSocket === 'undefined') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'UNAVAILABLE', 'WebSocket not supported');
    }
    if (!wsId || typeof wsId !== 'string') {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_ARGS', 'wsId is required');
    }
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (!wsState) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'NOT_FOUND', 'WebSocket connection not found');
    }
    if (wsState.ws.readyState !== WebSocket.OPEN) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', 'WebSocket is not open');
    }
    // Coerce data to a string — ws.send accepts strings, ArrayBuffers,
    // and Blobs, but IPC values come through JSON.parse so anything
    // non-string here is probably an object the app meant to JSON-encode.
    let payload2send = data;
    if (payload2send == null) payload2send = '';
    else if (typeof payload2send === 'object') payload2send = JSON.stringify(payload2send);
    else payload2send = String(payload2send);
    try {
      wsState.ws.send(payload2send);
    } catch (e) {
      return respondError(webview, 'nova:net:ws:send', requestId, 'INVALID_STATE', e?.message || 'Failed to send');
    }
    return respond(webview, 'nova:net:ws:send', requestId, { success: true });
  }

  async function handleNetWsClose({ payload, requestId, sandbox, webview }) {
    const { wsId, code, reason } = payload ?? {};
    const wsState = sandbox?.wsConnections?.get(wsId);
    if (wsState) {
      try { wsState.ws.close(code ?? 1000, reason); } catch { /* already closed */ }
      sandbox?.wsConnections?.delete(wsId);
    }
    return respond(webview, 'nova:net:ws:close', requestId, { success: true });
  }

  // Storage
  //
  // Backed by a single host-side IndexedDB database (AstroOS_AppStorage),
  // NOT localStorage. localStorage lives on the shared shell origin and is
  // readable by anything with same-origin access — a string key prefix
  // isn't real isolation, it just stops accidental collisions. IndexedDB
  // here still lives in the host's origin, but every record is keyed by
  // [appId, key] and every operation is scoped with an IDBKeyRange bound
  // to the calling app's own appId, so one app's IPC calls can never read,
  // enumerate, or clear another app's rows even if it somehow forged a
  // request. Key characters are also restricted to prevent path-like
  // injection confusing downstream consumers of the raw key string.

  const STORAGE_DB_NAME = 'AstroOS_AppStorage';
  // Schema v2: every row gains an ownerUid — the sandboxed kv store re-keys
  // from [appId, key] to [ownerUid, appId, key]. Apps keep addressing their
  // data as [appId, key]; the uid dimension is invisible to them, enforced
  // here at the point of stamping (the trusted host resolves the owner from
  // the active session — a guest can never construct a cross-owner address).
  const STORAGE_DB_VERSION = 2;
  const STORAGE_STORE = 'kv2';
  let storageDbPromise = null;

  function openStorageDB() {
    if (storageDbPromise) return storageDbPromise;
    storageDbPromise = new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORAGE_STORE)) {
          // Composite keyPath so [ownerUid, appId, key] is unique and
          // directly addressable; the by_owner_app index lets usage/clear/
          // keys range-scan one owner+app pair, by_appId one app across
          // owners (uninstall-style sweeps).
          const store = d.createObjectStore(STORAGE_STORE, { keyPath: ['ownerUid', 'appId', 'key'] });
          store.createIndex('by_owner_app', ['ownerUid', 'appId']);
          store.createIndex('by_appId', 'appId');
          // v1 → v2 migration: carry every legacy row across, stamped with
          // the owner the 3.0.2 single-user data belongs to (the multi-user
          // migration sets it before this DB first opens; '' on single-user
          // machines, which keeps the addressing semantics identical).
          if (d.objectStoreNames.contains('kv')) {
            try {
              const legacyOwner = storageOwnerUid() ||
                (typeof NovaUserScope !== 'undefined' && NovaUserScope ? String(NovaUserScope.legacyOwnerUid() || '') : '');
              const oldStore = e.target.transaction.objectStore('kv');
              const copy = oldStore.getAll();
              copy.onsuccess = () => {
                for (const row of copy.result || []) {
                  if (row && typeof row === 'object') {
                    store.put({ ...row, ownerUid: legacyOwner });
                  }
                }
              };
            } catch (_) { /* legacy copy is best-effort; fresh installs have none */ }
          }
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => reject(req.error || new Error('Failed to open storage database'));
    });
    // If opening fails, drop the cached promise so the next caller can retry
    // rather than permanently rejecting forever.
    storageDbPromise.catch(() => { storageDbPromise = null; });
    return storageDbPromise;
  }

  function storageOwnerKey(owner, appId, key) {
    return [owner, appId, key];
  }

  function storageAppRange(appId) {
    const owner = storageOwnerUid();
    return IDBKeyRange.bound([owner, appId, ''], [owner, appId, '\uffff'], false, false);
  }

  async function storageGet(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get(storageOwnerKey(storageOwnerUid(), appId, key));
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  // Look up the existing byteSize for a key in a single read, used by
  // storageSet's quota check. Returns 0 if the key doesn't exist yet.
  function storageExistingByteSize(db, appId, key) {
    return new Promise((resolve) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).get(storageOwnerKey(storageOwnerUid(), appId, key));
      req.onsuccess = () => resolve(req.result ? (req.result.byteSize || 0) : 0);
      req.onerror = () => resolve(0);
    });
  }

  async function storageAppUsageBytes(appId, db) {
    const owner = storageOwnerUid();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const idx = tx.objectStore(STORAGE_STORE).index('by_owner_app');
      const req = idx.openCursor(IDBKeyRange.only([owner, appId]));
      let total = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          total += cursor.value.byteSize || 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function storageSet(appId, key, value, valueBytes) {
    const db = await openStorageDB();
    const owner = storageOwnerUid();
    // Check quota against existing usage for this app minus whatever this
    // key already costs (so overwriting an existing key isn't double-counted).
    // Previously this made two redundant storageGet round-trips — one
    // discarded, one that only read byteSize. Now it's a single read.
    const [usage, existing] = await Promise.all([
      storageAppUsageBytes(appId, db),
      storageExistingByteSize(db, appId, key),
    ]);
    // Budgets are per (owner, app): one account filling its quota cannot
    // starve another account's headroom, because the ceiling is charged to
    // the account+app pair, not the machine.
    const ledgerAppKey = owner ? `${owner}~${appId}` : appId;
    const quotaBytes = StorageLedger.getBudget(ledgerAppKey, 'storageQuotaBytes');
    if (usage - existing + valueBytes > quotaBytes) {
      const err = new Error('Storage quota exceeded');
      err.code = 'STORAGE_FULL';
      throw err;
    }
    // Per-USER total ceiling (default 2 GB, admin-adjustable per account):
    // the whole account's AppStorage footprint, not just this app's.
    if (owner) {
      const userUsage = await storageOwnerUsageBytes(owner, db);
      const userQuota = storageUserQuotaBytes();
      if (userUsage - existing + valueBytes > userQuota) {
        const err = new Error('Account storage quota exceeded');
        err.code = 'STORAGE_FULL';
        throw err;
      }
    }
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).put({ ownerUid: owner, appId, key, value, byteSize: valueBytes });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Default per-account storage ceiling (2 GB) — admin-adjustable later. */
  function storageUserQuotaBytes() {
    return 2 * 1024 * 1024 * 1024;
  }

  /** The active account's total AppStorage footprint (one index pass). */
  function storageOwnerUsageBytes(owner, db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const idx = tx.objectStore(STORAGE_STORE).index('by_owner_app');
      const req = idx.openCursor(IDBKeyRange.bound([owner, ''], [owner, '\uffff'], false, false));
      let total = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          total += cursor.value.byteSize || 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function storageDelete(appId, key) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).delete(storageOwnerKey(storageOwnerUid(), appId, key));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageClear(appId) {
    const db = await openStorageDB();
    const owner = storageOwnerUid();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      // Clear only THIS owner's rows for the app — another account's data
      // for the same app is not "clear app data"'s to take.
      tx.objectStore(STORAGE_STORE).index('by_owner_app').openCursor(IDBKeyRange.only([owner, appId])).onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // Wipe every row in the nova:storage store, regardless of appId. For
  // factory-reset / "Wipe All Data" — unlike storageClear(appId), this
  // isn't scoped to one app because a factory reset needs to clear
  // everything, including any rows left behind by an app that's since
  // been uninstalled (an already-cleaned entry wouldn't appear in
  // OS.apps for a per-appId sweep to find). Goes through the same
  // cached connection as every other storage* function rather than
  // indexedDB.deleteDatabase(STORAGE_DB_NAME) directly, since a raw
  // delete call would block on this module's own open connection
  // (storageDbPromise) for the lifetime of the session.
  async function clearAllStorage() {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readwrite');
      tx.objectStore(STORAGE_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function storageKeys(appId) {
    const db = await openStorageDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORAGE_STORE, 'readonly');
      const req = tx.objectStore(STORAGE_STORE).index('by_owner_app').openCursor(IDBKeyRange.only([storageOwnerUid(), appId]));
      const keys = [];
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          keys.push(cursor.value.key);
          cursor.continue();
        } else {
          resolve(keys);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  function validateStorageKey(rawKey) {
    const key = String(rawKey ?? '');
    if (!key || !STORAGE_KEY_REGEX.test(key)) return null;
    return key;
  }

  async function handleStorageGet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:get', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      const value = await storageGet(app.id, rawKey);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value });
    } catch (e) {
      // IndexedDB can throw if disabled/unavailable (e.g. private browsing
      // in some browsers). Treat as "no value" rather than crashing the IPC call.
      log('debug', 'storageGet failed, returning null', e);
      return respond(webview, 'nova:storage:get', requestId, { success: true, value: null });
    }
  }

  async function handleStorageSet({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    // Enforce a per-value size cap, and storageSet enforces the per-app quota
    // against real existing usage in the DB (not just a per-call check).
    // IndexedDB stores structured values directly, so an object value's real
    // on-disk size is its JSON representation — measure that, not the
    // '[object Object]' that String(value) would give, otherwise the quota
    // check is silently too lenient for any non-string value.
    const value = payload?.value ?? '';
    // JSON.stringify can throw on a value the guest bridge would never carry
    // anyway (cyclic structures, BigInt) — but handleAPICall's catch-all
    // surfaces that as an opaque INTERNAL_ERROR. Validate it explicitly so
    // the guest gets a precise INVALID_ARGS instead.
    let valueJson;
    try {
      valueJson = typeof value === 'string' ? value : JSON.stringify(value);
    } catch (e) {
      return respondError(webview, 'nova:storage:set', requestId, 'INVALID_ARGS',
        `Value is not JSON-serializable: ${e?.message || e}`);
    }
    const valueBytes = sharedTextEncoder.encode(valueJson).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', `Value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit`);
    }
    try {
      await storageSet(app.id, rawKey, value, valueBytes);
      const ledgerOwner = storageOwnerUid();
      const ledgerKey = ledgerOwner ? `${ledgerOwner}~${app.id}` : app.id;
      StorageLedger.noteRequest(ledgerKey);
      StorageLedger.noteBytes(ledgerKey, { written: valueBytes });
      return respond(webview, 'nova:storage:set', requestId, { success: true });
    } catch (e) {
      if (e && e.code === 'STORAGE_FULL') {
        return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Per-app storage quota exceeded');
      }
      return respondError(webview, 'nova:storage:set', requestId, 'STORAGE_FULL', 'Failed to write to storage');
    }
  }

  async function handleStorageDelete({ payload, requestId, app, webview }) {
    const rawKey = validateStorageKey(payload?.key);
    if (!rawKey) {
      return respondError(webview, 'nova:storage:delete', requestId, 'INVALID_ARGS', 'Invalid storage key');
    }
    try {
      await storageDelete(app.id, rawKey);
      StorageLedger.noteRequest(app.id);
      return respond(webview, 'nova:storage:delete', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:delete', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  async function handleStorageClear({ requestId, app, webview }) {
    try {
      await storageClear(app.id);
      return respond(webview, 'nova:storage:clear', requestId, { success: true });
    } catch (e) {
      return respondError(webview, 'nova:storage:clear', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  async function handleStorageKeys({ requestId, app, webview }) {
    try {
      const keys = await storageKeys(app.id);
      return respond(webview, 'nova:storage:keys', requestId, { success: true, keys });
    } catch (e) {
      return respondError(webview, 'nova:storage:keys', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  // An app asking about its own usage — the storage equivalent of Android's
  // StorageManager. Returns the authoritative IndexedDB usage plus the
  // ledger budget, so an app can stay under its own quota without guessing.
  async function handleStorageUsage({ requestId, app, webview }) {
    try {
      const db = await openStorageDB();
      const usage = await storageAppUsageBytes(app.id, db);
      return respond(webview, 'nova:storage:usage', requestId, {
        success: true,
        usage,
        budget: StorageLedger.getBudget(app.id, 'storageQuotaBytes'),
      });
    } catch (e) {
      return respondError(webview, 'nova:storage:usage', requestId, 'ERROR', e?.message || 'Unknown error');
    }
  }

  /* ---------------- data portability — data:export / data:backup ----------
     Listed in the early permission docs, never implemented, and eventually
     removed as dead metadata — this is the real thing.

     Scope: strictly the CALLING app's own key/value namespace (the same
     IndexedDB store nova:storage:* uses). Both permissions are 'low' risk
     because there is no cross-app path: export/backup serialize the
     caller's own namespace, and restore/import refuse any envelope whose
     appId does not match the caller, so one app cannot use another app's
     backup as a data-transfer channel. Restores verify the envelope's
     checksum before writing anything, so a corrupted or hand-edited
     envelope fails cleanly instead of half-writing.

     Envelope: { novaDataEnvelope: 1, format, kind: 'backup'|'export',
     appId, capturedAt, storage: {key: value}, counts: {keys, bytes},
     checksum } — checksum is sha256 over a key-sorted serialization of
     storage. Values round-trip through the same storageSet path as
     nova:storage:set, so per-value caps and the per-app quota apply. */

  const DATA_ENVELOPE_FORMAT = 1;

  /* sha256 hex — Node crypto when running inside the NW host (the common
     case for the sandbox bridge), WebCrypto everywhere else. Checksums
     are async throughout so both paths work. */
  async function sha256Hex(text) {
    if (typeof require === 'function') {
      try {
        return require('crypto').createHash('sha256').update(text).digest('hex');
      } catch (_) { /* fall through to WebCrypto */ }
    }
    if (typeof crypto !== 'undefined' && typeof crypto?.subtle?.digest === 'function') {
      const digest = await crypto.subtle.digest('SHA-256', sharedTextEncoder.encode(text));
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('No SHA-256 implementation available for data envelope checksums');
  }

  async function dataChecksum(storageMap) {
    /* Key-sorted pair list — stable across insertion order so the
       checksum a backup produced is the checksum a restore verifies. */
    const canonical = JSON.stringify(
      Object.keys(storageMap).sort().map(k => [k, storageMap[k]])
    );
    return sha256Hex(canonical);
  }

  async function readOwnNamespace(appId) {
    const keys = await storageKeys(appId);
    const entries = await Promise.all(keys.map(async k => [k, await storageGet(appId, k)]));
    return Object.fromEntries(entries);
  }

  async function makeDataEnvelope(kind, appId, storageMap) {
    let bytes = 0;
    for (const [k, v] of Object.entries(storageMap)) {
      let json;
      try { json = typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { json = String(v); }
      bytes += sharedTextEncoder.encode(k).length + sharedTextEncoder.encode(json).length;
    }
    return {
      novaDataEnvelope: 1,
      format: DATA_ENVELOPE_FORMAT,
      kind,
      appId,
      capturedAt: new Date().toISOString(),
      storage: storageMap,
      counts: { keys: Object.keys(storageMap).length, bytes },
      checksum: await dataChecksum(storageMap),
    };
  }

  /* Returns { env } on success or { error, message } for respondError. */
  async function validateDataEnvelope(payload, callerAppId, kind) {
    const env = payload?.envelope;
    if (!env || typeof env !== 'object' || env.novaDataEnvelope !== 1 || env.format !== DATA_ENVELOPE_FORMAT) {
      return { error: 'INVALID_ARGS', message: 'envelope must be a data envelope produced by nova.data.export or nova.data.backup' };
    }
    if (env.kind !== kind) {
      return { error: 'INVALID_ARGS', message: `envelope kind mismatch: expected '${kind}', got '${env.kind}'` };
    }
    if (env.appId !== callerAppId) {
      /* Not INVALID_ARGS — this is a policy boundary: envelopes are pinned
         to their appId and cross-app restore is refused outright. */
      return { error: 'POLICY_BLOCKED', message: 'envelope belongs to a different app — envelopes only restore into their own app' };
    }
    if (!env.storage || typeof env.storage !== 'object' || Array.isArray(env.storage)) {
      return { error: 'INVALID_ARGS', message: 'envelope.storage must be an object of key/value pairs' };
    }
    if (typeof env.checksum !== 'string' || (await dataChecksum(env.storage)) !== env.checksum) {
      return { error: 'INVALID_ARGS', message: 'envelope checksum mismatch — the data is corrupt or was modified' };
    }
    return { env };
  }

  /* Writes one namespace entry through the same path as nova:storage:set
     (per-value cap + quota + ledger accounting). Returns {ok, bytes} or
     {ok:false, reason}. */
  async function writeOwnNamespaceEntry(appId, key, value) {
    let valueJson;
    try { valueJson = typeof value === 'string' ? value : JSON.stringify(value); } catch (e) {
      return { ok: false, reason: `not JSON-serializable: ${e?.message || e}` };
    }
    const valueBytes = sharedTextEncoder.encode(valueJson).length;
    if (valueBytes > STORAGE_VALUE_MAX_BYTES) {
      return { ok: false, reason: `value exceeds ${STORAGE_VALUE_MAX_BYTES} byte limit` };
    }
    try {
      await storageSet(appId, key, value, valueBytes);
      StorageLedger.noteRequest(appId);
      StorageLedger.noteBytes(appId, { written: valueBytes });
      return { ok: true, bytes: valueBytes };
    } catch (e) {
      return { ok: false, reason: e && e.code === 'STORAGE_FULL' ? 'per-app storage quota exceeded' : 'write failed' };
    }
  }

  async function handleDataBackup({ requestId, app, webview }) {
    try {
      const storage = await readOwnNamespace(app.id);
      StorageLedger.noteRequest(app.id);
      return respond(webview, 'nova:data:backup', requestId, {
        success: true,
        envelope: await makeDataEnvelope('backup', app.id, storage),
      });
    } catch (e) {
      return respondError(webview, 'nova:data:backup', requestId, 'ERROR', e?.message || 'Failed to back up app data');
    }
  }

  async function handleDataRestore({ payload, requestId, app, webview }) {
    const check = await validateDataEnvelope(payload, app.id, 'backup');
    if (check.error) {
      return respondError(webview, 'nova:data:restore', requestId, check.error, check.message);
    }
    const { clearFirst } = payload || {};
    try {
      if (clearFirst === true) {
        await storageClear(app.id);
      }
      let restoredKeys = 0;
      const failedKeys = [];
      for (const [key, value] of Object.entries(check.env.storage)) {
        const result = await writeOwnNamespaceEntry(app.id, key, value);
        if (result.ok) restoredKeys++;
        else failedKeys.push({ key, reason: result.reason });
      }
      return respond(webview, 'nova:data:restore', requestId, {
        success: true, restoredKeys, cleared: clearFirst === true, failedKeys,
      });
    } catch (e) {
      return respondError(webview, 'nova:data:restore', requestId, 'ERROR', e?.message || 'Failed to restore app data');
    }
  }

  async function handleDataExport({ payload, requestId, app, webview }) {
    const keys = Array.isArray(payload?.keys) ? payload.keys : null;
    const prefix = typeof payload?.prefix === 'string' && payload.prefix.length ? payload.prefix : null;
    if (!keys && !prefix) {
      return respondError(webview, 'nova:data:export', requestId, 'INVALID_ARGS',
        'provide keys (array of storage keys) or prefix (key prefix) — for everything, use nova:data:backup');
    }
    if (keys && keys.length > 1000) {
      return respondError(webview, 'nova:data:export', requestId, 'INVALID_ARGS', 'keys is limited to 1000 entries per export');
    }
    try {
      const namespace = await readOwnNamespace(app.id);
      let selected;
      if (keys) {
        const wanted = new Set(keys.map(k => String(k)));
        selected = Object.fromEntries(Object.entries(namespace).filter(([k]) => wanted.has(k)));
      } else {
        selected = Object.fromEntries(Object.entries(namespace).filter(([k]) => k.startsWith(prefix)));
      }
      StorageLedger.noteRequest(app.id);
      return respond(webview, 'nova:data:export', requestId, {
        success: true,
        envelope: await makeDataEnvelope('export', app.id, selected),
      });
    } catch (e) {
      return respondError(webview, 'nova:data:export', requestId, 'ERROR', e?.message || 'Failed to export app data');
    }
  }

  async function handleDataImport({ payload, requestId, app, webview }) {
    const check = await validateDataEnvelope(payload, app.id, 'export');
    if (check.error) {
      return respondError(webview, 'nova:data:import', requestId, check.error, check.message);
    }
    try {
      /* Merge semantics only: import writes the envelope's keys over the
         live namespace and never deletes keys it doesn't contain. The
         destructive path (wiping before writing) is backup/restore with
         clearFirst, which is a different permission with full-snapshot
         semantics. */
      let importedKeys = 0;
      const failedKeys = [];
      for (const [key, value] of Object.entries(check.env.storage)) {
        const result = await writeOwnNamespaceEntry(app.id, key, value);
        if (result.ok) importedKeys++;
        else failedKeys.push({ key, reason: result.reason });
      }
      return respond(webview, 'nova:data:import', requestId, { success: true, importedKeys, failedKeys });
    } catch (e) {
      return respondError(webview, 'nova:data:import', requestId, 'ERROR', e?.message || 'Failed to import app data');
    }
  }

  // Host-side snapshot of the MAC policy engine for the Settings privacy
  // dashboard (mode, rule counts, avc denial feed). Same trust model as the
  // storage ledger snapshot: trusted host-tier direct call, deliberately NOT
  // reachable over the sandbox IPC bridge.
  async function macPolicySnapshot() {
    return {
      info: MacPolicy.getPolicyInfo(),
      denials: MacPolicy.getAudit(50),
    };
  }

  // Host-side snapshot of the storage ledger for the Settings storage and
  // privacy dashboard. Settings runs in the trusted host tier and calls
  // AppSandbox.storageLedgerSnapshot() directly — this is deliberately NOT
  // reachable over the sandbox IPC bridge, so apps can never enumerate each
  // other's accounting or the access audit.
  async function storageLedgerSnapshot() {
    let db = null;
    try { db = await openStorageDB(); } catch (e) { db = null; }
    const apps = [];
    for (const stats of StorageLedger.getAllStats()) {
      let kvUsage = 0;
      if (db) {
        try { kvUsage = await storageAppUsageBytes(stats.appId, db); } catch (e) { kvUsage = 0; }
      }
      apps.push({ ...stats, kvUsage });
    }
    return { apps, accessLog: StorageLedger.listAccess(null, 100) };
  }

  // Device: geolocation

  async function handleDeviceGeolocation({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:geolocation', app.id)) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'PERMISSION_DENIED', 'device:geolocation permission required');
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return respondError(webview, 'nova:device:geolocation', requestId, 'UNAVAILABLE', 'Geolocation not available');
    }
    // Response is sent from one of the two callbacks below; we don't respond
    // here because getCurrentPosition returns immediately.
    navigator.geolocation.getCurrentPosition(
      (pos) => respond(webview, 'nova:device:geolocation', requestId, {
        success: true,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          altitude: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      }),
      (err) => respondError(webview, 'nova:device:geolocation', requestId, 'GEOLOCATION_ERROR', err?.message || 'Geolocation error'),
      payload.options || {}
    );
  }

  // Device: camera / microphone
  //
  // Unlike geolocation, a getUserMedia() MediaStream can't cross the IPC
  // bridge at all — it isn't serializable, and this handler runs in the
  // host shell's own document, not inside the guest webview that would
  // actually consume the stream. So these two handlers are
  // authorization-only: they check AppPermissionManager and report
  // whether the app is allowed to use the camera/microphone. The guest is
  // expected to then call navigator.mediaDevices.getUserMedia() itself,
  // inside its own document — see window.nova.getUserMedia in the
  // capability shim below, which calls this check first and only then
  // makes the real getUserMedia() call. That real call still goes through
  // the webview's own permissionrequest gate (setupPermissionRequestGate,
  // 'media' branch) as the actual browser-level enforcement point; this
  // handler is the app-level permission gate, a separate decision the
  // browser-level gate doesn't know about on its own.

  async function handleDeviceCamera({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:camera', app.id)) {
      return respondError(webview, 'nova:device:camera', requestId, 'PERMISSION_DENIED', 'device:camera permission required');
    }
    return respond(webview, 'nova:device:camera', requestId, { success: true, authorized: true });
  }

  async function handleDeviceMicrophone({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('device:microphone', app.id)) {
      return respondError(webview, 'nova:device:microphone', requestId, 'PERMISSION_DENIED', 'device:microphone permission required');
    }
    return respond(webview, 'nova:device:microphone', requestId, { success: true, authorized: true });
  }

  // Calendar
  //
  // Shared calendar service for sandboxed third-party apps. The trusted host
  // Calendar app (com.astroos.calendar) reads/writes this same store directly;
  // these IPC handlers retain per-app permission checks and input validation.
  // Sanitization prevents malformed events from reaching the Calendar UI.

  const CALENDAR_STORE_KEY = 'calendar_events_v2';
  const CALENDAR_COLORS = Object.freeze(['#58a6ff','#3fb950','#d29922','#f85149','#bc8cff','#ff7b72','#79c0ff','#56d364']);

  function sanitizeCalendarEvent(ev) {
    if (!ev || typeof ev !== 'object') return null;
    if (typeof ev.title !== 'string' || !ev.title.trim()) return null;
    if (typeof ev.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
    return {
      id:        typeof ev.id === 'string' && ev.id ? ev.id : cryptoRandomId(),
      title:     ev.title.trim(),
      date:      ev.date,
      timeStart: typeof ev.timeStart === 'string' ? ev.timeStart : '',
      timeEnd:   typeof ev.timeEnd   === 'string' ? ev.timeEnd   : '',
      desc:      typeof ev.desc      === 'string' ? ev.desc      : '',
      color:     CALENDAR_COLORS.includes(ev.color) ? ev.color : CALENDAR_COLORS[0],
    };
  }

  function cryptoRandomId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
      : `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function loadCalendarEvents() {
    try {
      const raw = JSON.parse(localStorage.getItem(CALENDAR_STORE_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.map(sanitizeCalendarEvent).filter(Boolean) : [];
    } catch { return []; }
  }

  function saveCalendarEvents(evs) {
    localStorage.setItem(CALENDAR_STORE_KEY, JSON.stringify(evs));
    if (typeof OS !== 'undefined' && OS.events?.emit) OS.events.emit('calendar:updated');
  }

  async function handleCalendarRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:read', app.id)) {
      return respondError(webview, 'nova:calendar:read', requestId, 'PERMISSION_DENIED', 'calendar:read permission required');
    }
    return respond(webview, 'nova:calendar:read', requestId, { success: true, events: loadCalendarEvents() });
  }

  async function handleCalendarWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:write', app.id)) {
      return respondError(webview, 'nova:calendar:write', requestId, 'PERMISSION_DENIED', 'calendar:write permission required');
    }
    const incoming = sanitizeCalendarEvent(payload && payload.event);
    if (!incoming) {
      return respondError(webview, 'nova:calendar:write', requestId, 'INVALID_EVENT', 'Event must have a title and a YYYY-MM-DD date');
    }
    const events = loadCalendarEvents();
    const idx = events.findIndex(e => e.id === incoming.id);
    if (idx >= 0) events[idx] = incoming; else events.push(incoming);
    saveCalendarEvents(events);
    return respond(webview, 'nova:calendar:write', requestId, { success: true, event: incoming });
  }

  async function handleCalendarDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('calendar:delete', app.id)) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'PERMISSION_DENIED', 'calendar:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:calendar:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const events = loadCalendarEvents();
    const next = events.filter(e => e.id !== id);
    const removed = next.length !== events.length;
    saveCalendarEvents(next);
    return respond(webview, 'nova:calendar:delete', requestId, { success: true, removed });
  }

  // Contacts
  //
  // Same shared-host-storage model as Calendar above; mirrors
  // js/apps/contacts.js's isValidContact() sanitization exactly.

  const CONTACTS_STORE_KEY = 'nova_contacts';

  function isValidContact(c) {
    return c !== null && typeof c === 'object' &&
      typeof c.id === 'string' && c.id.length > 0 &&
      typeof c.name === 'string' &&
      typeof c.email === 'string' &&
      typeof c.phone === 'string' &&
      typeof c.notes === 'string';
  }

  function loadContacts() {
    try {
      const raw = localStorage.getItem(CONTACTS_STORE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(isValidContact).map(c => ({
        id: String(c.id), name: String(c.name), email: String(c.email),
        phone: String(c.phone), notes: String(c.notes),
      }));
    } catch { return []; }
  }

  function saveContacts(arr) {
    localStorage.setItem(CONTACTS_STORE_KEY, JSON.stringify(arr));
    if (typeof OS !== 'undefined' && OS.events?.emit) OS.events.emit('contacts:updated');
  }

  async function handleContactsRead({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:read', app.id)) {
      return respondError(webview, 'nova:contacts:read', requestId, 'PERMISSION_DENIED', 'contacts:read permission required');
    }
    return respond(webview, 'nova:contacts:read', requestId, { success: true, contacts: loadContacts() });
  }

  async function handleContactsWrite({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:write', app.id)) {
      return respondError(webview, 'nova:contacts:write', requestId, 'PERMISSION_DENIED', 'contacts:write permission required');
    }
    const incoming = payload && payload.contact;
    if (!incoming || typeof incoming !== 'object' || typeof incoming.name !== 'string' || !incoming.name.trim()) {
      return respondError(webview, 'nova:contacts:write', requestId, 'INVALID_CONTACT', 'Contact must have at least a name');
    }
    const contact = {
      id: typeof incoming.id === 'string' && incoming.id ? incoming.id : cryptoRandomId(),
      name: incoming.name.trim(),
      email: typeof incoming.email === 'string' ? incoming.email : '',
      phone: typeof incoming.phone === 'string' ? incoming.phone : '',
      notes: typeof incoming.notes === 'string' ? incoming.notes : '',
    };
    const contacts = loadContacts();
    const idx = contacts.findIndex(c => c.id === contact.id);
    if (idx >= 0) contacts[idx] = contact; else contacts.push(contact);
    saveContacts(contacts);
    return respond(webview, 'nova:contacts:write', requestId, { success: true, contact });
  }

  async function handleContactsDelete({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('contacts:delete', app.id)) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'PERMISSION_DENIED', 'contacts:delete permission required');
    }
    const id = payload && payload.id;
    if (typeof id !== 'string' || !id) {
      return respondError(webview, 'nova:contacts:delete', requestId, 'INVALID_ID', 'id must be a non-empty string');
    }
    const contacts = loadContacts();
    const next = contacts.filter(c => c.id !== id);
    const removed = next.length !== contacts.length;
    saveContacts(next);
    return respond(webview, 'nova:contacts:delete', requestId, { success: true, removed });
  }

  // System info

  async function handleSystemInfo({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:info', app.id)) {
      return respondError(webview, 'nova:system:info', requestId, 'PERMISSION_DENIED', 'system:info permission required');
    }
    const bootTime = OS?._bootTime || Date.now();
    return respond(webview, 'nova:system:info', requestId, {
      success: true,
      os: {
        version: OS?.version,
        securityPatch: OS?.securityPatch,
        username: OS?.username,
        uptime: Date.now() - bootTime,
      },
    });
  }

  // ── Locale ─────────────────────────────────────────────────────────────
  // Read-only, deliberately coarse locale facts for formatting: the OS
  // region/timezone settings when the user set them, else environment
  // defaults. No permission gate on purpose — these are the same values a
  // plain web page gets from navigator/Intl on the open web, they identify
  // no one, and gating date formatting behind a prompt would just push
  // apps back to user-agent sniffing. Anything sensitive (username,
  // hostname, …) stays behind system:info; this surface exposes nothing
  // but formatting facts.
  function firstDayOfWeekForRegion(region) {
    // Coarse, documented mapping (enough for calendar grids, not an i18n
    // library): regions whose calendars conventionally start on Sunday.
    const SUNDAY_REGIONS = new Set(['US', 'CA', 'JP', 'CN', 'TW', 'KR', 'SA', 'IL', 'BR', 'PH', 'MX']);
    return region && SUNDAY_REGIONS.has(region) ? 'sunday' : 'monday';
  }

  async function handleLocaleGet({ requestId, app, webview }) {
    let locale = null;
    try {
      locale = (typeof navigator !== 'undefined' && navigator.language) || null;
    } catch (_) { locale = null; }
    if (typeof locale !== 'string' || !locale) locale = 'en-US';
    // User preference wins over the environment default, when set. These
    // two keys are read through the same OS.settings service the Settings
    // app uses, but only the two formatting-innocuous keys — nothing from
    // the system:info-gated set is reachable here.
    let region = null;
    let timeZone = null;
    try {
      const setRegion = OS?.settings?.get?.('region');
      if (typeof setRegion === 'string' && setRegion) region = setRegion;
      const setTz = OS?.settings?.get?.('timezone');
      if (typeof setTz === 'string' && setTz) timeZone = setTz;
    } catch (_) { /* settings service unavailable — fall through to env defaults */ }
    if (!region) {
      const dash = locale.indexOf('-');
      region = dash > 0 ? locale.slice(dash + 1).toUpperCase() : null;
    }
    if (!timeZone) {
      try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { timeZone = null; }
    }
    return respond(webview, 'nova:locale:get', requestId, {
      success: true,
      locale: locale,
      region: region,
      timeZone: timeZone,
      firstDayOfWeek: firstDayOfWeekForRegion(region),
    });
  }

  // ── Taskbar badge (system:badge) ───────────────────────────────────────
  // Per-app badge shown on the app's taskbar icon: a count (0-999) or a
  // short text label (1-4 characters). Session-only host state — nothing
  // persists across reboots, because a badge is a view of live state
  // (like the window count), not data. The taskbar reads the store via
  // window.NovaAppBadges (exported below); updates are pushed to the UI
  // with a nova-badge-changed event plus a WM.updateTaskbar() refresh.
  const appBadgeState = new Map();   // appId -> { count } | { text }
  const badgeRateLimits = new Map(); // appId -> [timestamps]
  const BADGE_RATE_MAX = 30;         // updates per minute — a badge is not a ticker
  const BADGE_TEXT_MAX = 4;
  const BADGE_COUNT_MAX = 999;

  function badgeRateLimited(appId) {
    const now = Date.now();
    const recent = (badgeRateLimits.get(appId) || []).filter((t) => t > now - 60_000);
    if (recent.length >= BADGE_RATE_MAX) {
      badgeRateLimits.set(appId, recent);
      return true;
    }
    recent.push(now);
    badgeRateLimits.set(appId, recent);
    return false;
  }

  // Copy out so callers can't mutate the live store entry.
  function getBadge(appId) {
    const badge = appBadgeState.get(appId);
    if (!badge) return null;
    return badge.count != null ? { count: badge.count } : { text: badge.text };
  }

  function publishBadge(appId) {
    const badge = appBadgeState.get(appId) || null;
    try {
      if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        document.dispatchEvent(new CustomEvent('nova-badge-changed', { detail: { appId: appId, badge: badge } }));
      }
    } catch (_) { /* event dispatch is best-effort; the store is the truth */ }
    try {
      if (typeof WM !== 'undefined' && typeof WM.updateTaskbar === 'function') WM.updateTaskbar();
    } catch (_) { /* taskbar refresh is best-effort */ }
  }

  async function handleBadgeSet({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:badge', app.id)) {
      return respondError(webview, 'nova:badge:set', requestId, 'PERMISSION_DENIED', 'system:badge permission required');
    }
    if (badgeRateLimited(app.id)) {
      return respondError(webview, 'nova:badge:set', requestId, 'RATE_LIMITED', 'Max 30 badge updates per minute');
    }
    const hasCount = payload && Object.prototype.hasOwnProperty.call(payload, 'count');
    const hasText = payload && Object.prototype.hasOwnProperty.call(payload, 'text');
    if (!hasCount && !hasText) {
      return respondError(webview, 'nova:badge:set', requestId, 'INVALID_ARGS', 'provide count (number 0-999) or text (1-4 characters)');
    }
    let badge;
    if (hasCount) {
      const n = payload.count;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > BADGE_COUNT_MAX) {
        return respondError(webview, 'nova:badge:set', requestId, 'INVALID_ARGS', 'count must be a number between 0 and 999');
      }
      const rounded = Math.floor(n);
      if (rounded === 0) {
        // count: 0 means "nothing to show" — identical to clear(), documented.
        appBadgeState.delete(app.id);
        publishBadge(app.id);
        return respond(webview, 'nova:badge:set', requestId, { success: true, badge: null });
      }
      badge = { count: rounded };
    } else {
      const t = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!t || t.length > BADGE_TEXT_MAX) {
        return respondError(webview, 'nova:badge:set', requestId, 'INVALID_ARGS', `text must be 1-${BADGE_TEXT_MAX} characters after trimming`);
      }
      badge = { text: t };
    }
    appBadgeState.set(app.id, badge);
    publishBadge(app.id);
    return respond(webview, 'nova:badge:set', requestId, { success: true, badge: badge });
  }

  async function handleBadgeClear({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:badge', app.id)) {
      return respondError(webview, 'nova:badge:clear', requestId, 'PERMISSION_DENIED', 'system:badge permission required');
    }
    const had = appBadgeState.delete(app.id);
    publishBadge(app.id);
    return respond(webview, 'nova:badge:clear', requestId, { success: true, cleared: had });
  }

  // ── fs:watch (fs:watch permission) ─────────────────────────────────────
  // Change notifications for paths the app could already read. Watching is
  // reading: the watcher is only created for a path that passes the exact
  // same access checks as nova:fs:read (app-owned paths need no grant,
  // shared paths need the same grants a read would), and the fs:watch
  // grant is required on top. Delivery is abstract-FS polling (works
  // across every backend, including the in-memory one) with a debounce so
  // a burst of writes is one event, a per-app push cap so a hot tree can't
  // flood the guest, and a hard per-app watcher budget. Events are
  // best-effort: a missed tick self-heals on the next poll because the
  // snapshot is only advanced after the decision.
  const fsWatchers = new Map();      // watcherId -> record
  const fsWatchPushLog = new Map();  // appId -> [timestamps]
  const fsWatchConfig = { pollMs: 2000, debounceMs: 300, pushesPerMinute: 60 };
  const FS_WATCH_MAX_PER_APP = 8;

  function snapshotFsTarget(node) {
    if (node.type === 'folder') {
      const kids = FS.listDir(node.id)
        .map((c) => `${c.id}~${c.name}~${c.type}~${c.modified ?? ''}`)
        .sort()
        .join('|');
      return 'dir:' + kids;
    }
    return `file:${node.modified ?? 0}:${node.size ?? 0}`;
  }

  // Polling re-resolves by path, and resolveFile rewrites every /data/...
  // path into the CALLER's own subtree — a canonical /data/<appId>/...
  // path would double-nest (/data/<appId>/<appId>/...). App-owned targets
  // therefore poll on the caller-relative form ('/data/' + rest); shared
  // paths resolve as-is.
  function watchablePathFor(node, appId) {
    const canonical = FS.getPath(node.id);
    const prefix = '/data/' + appDataSegment(appId) + '/';
    if (canonical.startsWith(prefix)) {
      return '/data/' + canonical.slice(prefix.length);
    }
    return canonical;
  }

  function stopFsWatcher(watcherId) {
    const w = fsWatchers.get(watcherId);
    if (!w) return false;
    clearInterval(w.timer);
    clearTimeout(w.debounceTimer);
    fsWatchers.delete(watcherId);
    return true;
  }

  function stopFsWatchersForApp(appId) {
    let stopped = 0;
    for (const [id, w] of [...fsWatchers.entries()]) {
      if (w.appId === appId) { stopFsWatcher(id); stopped++; }
    }
    return stopped;
  }

  function fsWatchPushAllowed(appId) {
    const now = Date.now();
    const recent = (fsWatchPushLog.get(appId) || []).filter((t) => t > now - 60_000);
    if (recent.length >= fsWatchConfig.pushesPerMinute) {
      fsWatchPushLog.set(appId, recent);
      return false;
    }
    recent.push(now);
    fsWatchPushLog.set(appId, recent);
    return true;
  }

  function pollFsWatcher(watcherId) {
    const w = fsWatchers.get(watcherId);
    if (!w) return;
    // Re-resolve by canonical path each tick: the node may have been
    // renamed, rewritten, or deleted since the watcher was created.
    let node = null;
    try { node = resolveFile({ path: w.watchPath }, w.appId) || null; } catch (_) { node = null; }
    let snap = null;
    if (node) { try { snap = snapshotFsTarget(node); } catch (_) { snap = null; } }
    if (snap === w.snapshot) return;

    // State changed since the last tick — debounce, then push one event.
    clearTimeout(w.debounceTimer);
    w.debounceTimer = setTimeout(() => {
      const live = fsWatchers.get(watcherId);
      if (!live) return;
      let node2 = null;
      try { node2 = resolveFile({ path: live.watchPath }, live.appId) || null; } catch (_) { node2 = null; }
      let snap2 = null;
      if (node2) { try { snap2 = snapshotFsTarget(node2); } catch (_) { snap2 = null; } }
      const prev = live.snapshot;
      live.snapshot = snap2;
      if (!fsWatchPushAllowed(live.appId)) return; // coalesced; snapshot already advanced
      const kind = snap2 === null ? 'deleted' : (prev === null ? 'created' : 'changed');
      try {
        respond(live.webview, 'nova:fs:changed', generateRequestId(), {
          watcherId: watcherId,
          path: live.canonicalPath,
          kind: kind,
          timestamp: new Date().toISOString(),
        });
      } catch (_) { /* best-effort delivery */ }
    }, Math.max(0, Number(fsWatchConfig.debounceMs) || 0));
    w.snapshot = snap;
  }

  async function handleFsWatch({ payload, requestId, app, webview, sandbox }) {
    if (!AppPermissionManager.isGranted('fs:watch', app.id)) {
      return respondError(webview, 'nova:fs:watch', requestId, 'PERMISSION_DENIED', 'fs:watch permission required');
    }
    const rawPath = payload?.path;
    if (typeof rawPath !== 'string' || !rawPath) {
      return respondError(webview, 'nova:fs:watch', requestId, 'INVALID_ARGS', 'path is required');
    }
    const node = resolveFile({ path: rawPath }, app.id);
    if (!node) {
      return respondError(webview, 'nova:fs:watch', requestId, 'NOT_FOUND', 'File or folder not found');
    }
    // The exact nova:fs:read access rules, per target type — watching is
    // reading, so a watcher can never be a read-access oracle.
    if (node.type === 'folder') {
      const hasMetadataPermission = AppPermissionManager.isGranted('fs:metadata', app.id);
      const hasMediaPermission = ['fs:read:images', 'fs:read:video', 'fs:read:audio']
        .some((permission) => AppPermissionManager.isGranted(permission, app.id));
      if (!isOwnedByApp(node, app.id) && !hasFsAccess(app.id)
        && !hasMetadataPermission && !hasMediaPermission) {
        return respondError(webview, 'nova:fs:watch', requestId, 'PERMISSION_DENIED',
          'watching requires the same access as reading: app-owned paths need no grant, shared paths need the nova:fs:read grants');
      }
    } else if (!canReadFileContents(node, app.id, sandbox)) {
      return respondError(webview, 'nova:fs:watch', requestId, 'PERMISSION_DENIED',
        'watching requires the same access as reading: app-owned paths need no grant, shared paths need the nova:fs:read grants');
    }
    // The caller supplies the watcher id it registered its listener under
    // (the facade generates one per watch() call) — honor it so pushed
    // events carry an id the guest can actually dispatch, including on
    // FIRST registration. Re-registering an existing watcher of this app
    // replaces its target instead of consuming a second budget slot; a
    // foreign id falls through to a fresh host-side id, never hijacked.
    // EVERY new registration counts against the budget — only a true
    // re-registration of the app's own watcher skips it.
    let watcherId = null;
    let reRegister = false;
    if (typeof payload?.watcherId === 'string' && /^w_[a-z0-9_]{4,64}$/.test(payload.watcherId)) {
      const existing = fsWatchers.get(payload.watcherId);
      if (existing && existing.appId === app.id) {
        watcherId = payload.watcherId;
        reRegister = true;
      } else if (!existing) {
        watcherId = payload.watcherId;
      }
    }
    if (!reRegister) {
      const mine = [...fsWatchers.values()].filter((w) => w.appId === app.id).length;
      if (mine >= FS_WATCH_MAX_PER_APP) {
        return respondError(webview, 'nova:fs:watch', requestId, 'RATE_LIMITED', `Max ${FS_WATCH_MAX_PER_APP} watchers per app`);
      }
      if (!watcherId) {
        watcherId = 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      }
    } else {
      stopFsWatcher(watcherId);
    }
    const record = {
      appId: app.id,
      canonicalPath: FS.getPath(node.id),
      watchPath: watchablePathFor(node, app.id),
      snapshot: snapshotFsTarget(node),
      webview,
      timer: null,
      debounceTimer: null,
    };
    fsWatchers.set(watcherId, record);
    record.timer = setInterval(() => pollFsWatcher(watcherId), Math.max(10, Number(fsWatchConfig.pollMs) || 2000));
    return respond(webview, 'nova:fs:watch', requestId, {
      success: true,
      watcherId: watcherId,
      path: record.canonicalPath,
    });
  }

  async function handleFsUnwatch({ payload, requestId, app, webview }) {
    const watcherId = payload?.watcherId;
    const w = typeof watcherId === 'string' ? fsWatchers.get(watcherId) : null;
    // Idempotent and silent about other apps' watcher ids — an unknown id
    // and a foreign id are the same "cleared: false".
    const cleared = !!(w && w.appId === app.id && stopFsWatcher(watcherId));
    return respond(webview, 'nova:fs:unwatch', requestId, { success: true, cleared: cleared });
  }

  // ── Share target (system:share-target) ─────────────────────────────────
  // The inbound half of the share surface. Outbound is user-mediated via
  // nova:share (the sheet); this makes the sheet bidirectional: apps that
  // declare a shareTarget in their manifest AND hold the system:share-target
  // grant are offered as destinations, and the user's pick delivers a
  // nova:share:inbound push to the target. Delivery to a live sandbox is
  // immediate; a closed target gets the entry queued (bounded 8) and it is
  // delivered right after its next nova:ready — the same honest semantics
  // as alarms: the user's click launches the window, the push never starts
  // an app by itself.
  const SHARE_TARGET_QUEUE_KEY = 'nova_share_inbound';
  const SHARE_TARGET_QUEUE_MAX = 8;
  const SHARE_TARGET_SHEET_MAX = 6;

  function normalizedShareTargetMimes(app) {
    const raw = app?.manifest?.shareTarget?.mimeTypes;
    if (!Array.isArray(raw)) return null;
    const mimes = raw
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.split(';', 1)[0].trim().toLowerCase());
    return mimes.length ? mimes : null;
  }

  function shareTargetMatches(mimes, content) {
    if (!Array.isArray(mimes) || !mimes.length) return false;
    const contentMimes = [];
    if (content && content.text) contentMimes.push('text/plain');
    if (content && content.url) contentMimes.push('text/uri-list', 'text/plain');
    if (!contentMimes.length) return false;
    return mimes.some((declared) => declared === '*/*'
      || contentMimes.some((c) => c === declared
        || (declared.endsWith('/*') && c.startsWith(declared.slice(0, -1)))));
  }

  function loadShareQueue() {
    // Registry-first (HKNS/apps/share/inbound via RegistrySystemState); the
    // localStorage key is the adoption source and the fail-soft fallback.
    if (typeof window !== 'undefined' && window.NovaRegistry && typeof RegistrySystemState !== 'undefined') {
      try {
        const stored = RegistrySystemState.shareInbound();
        if (stored && stored.apps && typeof stored.apps === 'object') return stored;
      } catch (_) { /* fall through to legacy */ }
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(SHARE_TARGET_QUEUE_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && parsed.apps && typeof parsed.apps === 'object') return parsed;
    } catch (_) { /* corrupt — start clean */ }
    return { version: 1, apps: {} };
  }

  function saveShareQueue(state) {
    if (typeof window !== 'undefined' && window.NovaRegistry && typeof RegistrySystemState !== 'undefined') {
      try { if (RegistrySystemState.setShareInbound(state)) return; } catch (_) { /* fall through */ }
    }
    try { localStorage.setItem(SHARE_TARGET_QUEUE_KEY, JSON.stringify(state)); } catch (_) { /* best-effort */ }
  }

  function queueShareInbound(appId, entry) {
    const state = loadShareQueue();
    const record = state.apps[appId] || (state.apps[appId] = []);
    if (!Array.isArray(record)) { state.apps[appId] = record = []; }
    record.push(entry);
    if (record.length > SHARE_TARGET_QUEUE_MAX) record.splice(0, record.length - SHARE_TARGET_QUEUE_MAX);
    saveShareQueue(state);
  }

  function flushShareInboundQueue(appId, webview) {
    const state = loadShareQueue();
    const record = state.apps[appId];
    if (!Array.isArray(record) || !record.length) return 0;
    const pending = record.splice(0, record.length);
    if (pending.length) saveShareQueue(state);
    for (const entry of pending) {
      try {
        respond(webview, 'nova:share:inbound', generateRequestId(), Object.assign({}, entry, { queued: true }));
      } catch (_) { /* best-effort */ }
    }
    return pending.length;
  }

  function deliverShareTarget(appId, content) {
    if (typeof AppPermissionManager === 'undefined'
      || !AppPermissionManager.isGranted('system:share-target', appId)) {
      return { delivered: false, queued: false, reason: 'PERMISSION_DENIED' };
    }
    const payload = {
      title: typeof content?.title === 'string' ? content.title.slice(0, 120) : '',
      text: typeof content?.text === 'string' ? content.text.slice(0, 4000) : '',
      url: typeof content?.url === 'string' ? content.url : '',
      sourceAppId: typeof content?.sourceAppId === 'string' ? content.sourceAppId : null,
      firedAt: new Date().toISOString(),
    };
    const sandbox = liveSandboxForApp(appId);
    if (sandbox) {
      try {
        respond(sandbox.webview, 'nova:share:inbound', generateRequestId(), payload);
        return { delivered: true, queued: false };
      } catch (_) { /* fall through to queue */ }
    }
    queueShareInbound(appId, payload);
    return { delivered: false, queued: true };
  }

  // ── Named alarms (system:schedule) ─────────────────────────────────────
  // App-scheduled wake prompts, Chrome-alarms style: an app creates named
  // alarms (a one-shot `when` or a periodic `periodMinutes` with a 15-minute
  // floor, matching Android WorkManager's coarse periodic floor) and gets a
  // nova:background:alarm push each time one fires.
  //
  // Delivery honesty: alarms fire into a LIVE sandbox — a running window or
  // a Tier-2 system:background:live process. While an app is fully closed,
  // periodic alarms skip to their next occurrence and one-shot alarms are
  // queued (bounded at 8, newest kept) and delivered on the next launch,
  // right after nova:ready. Apps that must run brief work while fully
  // closed already have the right tool: system:background's scheduler wakes.
  //
  // Alarm registry persists host-side in the AstroOS Registry
  // (HKNS/apps/alarms via RegistrySystemState — the same store the
  // permission manager uses) so alarms survive OS reboots; timers are
  // rebuilt from persisted state at module load. The localStorage key is
  // the pre-registry adoption source and the fail-soft fallback when no
  // engine is up.
  const ALARMS_STORAGE_KEY = 'nova_app_alarms';
  const ALARMS_MAX_PER_APP = 32;
  const ALARMS_MIN_PERIOD_MINUTES = 15;
  const ALARMS_MAX_NAME_LEN = 64;
  const ALARMS_MAX_WHEN_AHEAD_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
  const ALARMS_QUEUE_MAX = 8;
  const alarmsTimers = new Map(); // `${appId}:${name}` -> timeoutId

  function sysState() {
    return typeof window !== 'undefined' && window ? window.RegistrySystemState : null;
  }

  function loadAlarmState() {
    const state = sysState();
    if (state && typeof state.alarms === 'function') {
      try {
        const fromRegistry = state.alarms();
        if (fromRegistry && typeof fromRegistry === 'object' && fromRegistry.apps && typeof fromRegistry.apps === 'object') {
          return fromRegistry;
        }
      } catch (_) { /* fall through to legacy */ }
    }
    try {
      const raw = localStorage.getItem(ALARMS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.apps && typeof parsed.apps === 'object') return parsed;
    } catch (_) { /* corrupt state — start clean, alarms are app conveniences */ }
    return { version: 1, apps: {} };
  }

  function saveAlarmState(state) {
    const sys = sysState();
    if (sys && typeof sys.setAlarms === 'function') {
      try { sys.setAlarms(state); return; } catch (_) { /* fall through to legacy */ }
    }
    try { localStorage.setItem(ALARMS_STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* best-effort */ }
  }

  function validAlarmName(name) {
    return typeof name === 'string' && name.length >= 1 && name.length <= ALARMS_MAX_NAME_LEN && /^[\w.:\-]+$/.test(name);
  }

  function liveSandboxForApp(appId) {
    if (typeof AppSandbox === 'undefined' || typeof AppSandbox.getAllSandboxes !== 'function') return null;
    const all = AppSandbox.getAllSandboxes() || [];
    // Prefer a visible window; a Tier-2 backgrounded process works too.
    return all.find((s) => s.appId === appId && !s.backgrounded && s.webview)
      || all.find((s) => s.appId === appId && s.webview)
      || null;
  }

  function scheduleAlarmTimer(appId, name, alarm) {
    const key = `${appId}:${name}`;
    const existing = alarmsTimers.get(key);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, Math.min(alarm.nextFire - Date.now(), 2 ** 31 - 1));
    const timerId = setTimeout(() => fireAlarm(appId, name), delay);
    if (typeof timerId === 'object' && timerId !== null && typeof timerId.unref === 'function') timerId.unref();
    alarmsTimers.set(key, timerId);
  }

  function stopAlarmTimer(appId, name) {
    const key = `${appId}:${name}`;
    const timerId = alarmsTimers.get(key);
    if (timerId) { clearTimeout(timerId); alarmsTimers.delete(key); }
  }

  function pushAlarmToSandbox(sandbox, payload) {
    try {
      respond(sandbox.webview, 'nova:background:alarm', generateRequestId(), payload);
      return true;
    } catch (_) { return false; }
  }

  function fireAlarm(appId, name) {
    alarmsTimers.delete(`${appId}:${name}`);
    const state = loadAlarmState();
    const record = state.apps[appId];
    const alarm = record && record.alarms ? record.alarms[name] : null;
    if (!alarm) return; // cleared while the timer was pending

    const now = Date.now();
    const sandbox = liveSandboxForApp(appId);
    let delivered = false;
    if (sandbox) {
      delivered = pushAlarmToSandbox(sandbox, {
        name: name,
        alarm: { name: name, when: alarm.when ?? null, periodMinutes: alarm.periodMinutes ?? null, scheduledTime: alarm.nextFire },
        firedAt: new Date(now).toISOString(),
      });
    }

    if (alarm.periodMinutes) {
      // Periodic: advance past every missed cycle so a long-sleeping OS
      // doesn't fire a burst of catch-up events; the next occurrence is
      // always in the future.
      const periodMs = Math.max(ALARMS_MIN_PERIOD_MINUTES, alarm.periodMinutes) * 60_000;
      let next = alarm.nextFire + periodMs;
      while (next <= now) next += periodMs;
      alarm.nextFire = next;
      saveAlarmState(state);
      scheduleAlarmTimer(appId, name, alarm);
      return;
    }

    // One-shot: consume. Undelivered (app fully closed) → bounded queue
    // for next launch.
    delete record.alarms[name];
    if (!delivered) {
      if (!Array.isArray(record.queue)) record.queue = [];
      record.queue.push({ name: name, firedAt: new Date(now).toISOString(), scheduledTime: alarm.nextFire });
      if (record.queue.length > ALARMS_QUEUE_MAX) record.queue.splice(0, record.queue.length - ALARMS_QUEUE_MAX);
    }
    saveAlarmState(state);
  }

  function bootstrapAlarms() {
    const state = loadAlarmState();
    const now = Date.now();
    let dirty = false;
    for (const [appId, record] of Object.entries(state.apps)) {
      if (!record || typeof record !== 'object' || !record.alarms) continue;
      for (const [name, alarm] of Object.entries(record.alarms)) {
        if (!alarm || typeof alarm.nextFire !== 'number') { delete record.alarms[name]; dirty = true; continue; }
        if (alarm.periodMinutes) {
          const periodMs = Math.max(ALARMS_MIN_PERIOD_MINUTES, alarm.periodMinutes) * 60_000;
          while (alarm.nextFire <= now) { alarm.nextFire += periodMs; dirty = true; }
          scheduleAlarmTimer(appId, name, alarm);
        } else if (alarm.nextFire <= now) {
          // Missed one-shot from before shutdown — treat as undelivered.
          if (!Array.isArray(record.queue)) record.queue = [];
          record.queue.push({ name: name, firedAt: new Date(now).toISOString(), scheduledTime: alarm.nextFire });
          if (record.queue.length > ALARMS_QUEUE_MAX) record.queue.splice(0, record.queue.length - ALARMS_QUEUE_MAX);
          delete record.alarms[name];
          dirty = true;
        } else {
          scheduleAlarmTimer(appId, name, alarm);
        }
      }
    }
    if (dirty) saveAlarmState(state);
  }
  // Rebuild timers once the host module is live. Deferred so a module load
  // inside a test harness never schedules anything before state exists.
  if (typeof setTimeout === 'function') {
    const bootTimer = setTimeout(bootstrapAlarms, 0);
    if (bootTimer && typeof bootTimer.unref === 'function') bootTimer.unref();
  }

  async function handleAlarmsCreate({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:schedule', app.id)) {
      return respondError(webview, 'nova:alarms:create', requestId, 'PERMISSION_DENIED', 'system:schedule permission required');
    }
    const name = payload?.name;
    if (!validAlarmName(name)) {
      return respondError(webview, 'nova:alarms:create', requestId, 'INVALID_ARGS', `name must be 1-${ALARMS_MAX_NAME_LEN} characters of letters, digits, or . : _ -`);
    }
    const hasWhen = payload && Object.prototype.hasOwnProperty.call(payload, 'when') && payload.when != null;
    const hasPeriod = payload && Object.prototype.hasOwnProperty.call(payload, 'periodMinutes') && payload.periodMinutes != null;
    if (hasWhen === hasPeriod) {
      return respondError(webview, 'nova:alarms:create', requestId, 'INVALID_ARGS', 'provide exactly one of when (future epoch ms) or periodMinutes (>= 15)');
    }
    let alarm;
    if (hasWhen) {
      const when = payload.when;
      if (typeof when !== 'number' || !Number.isFinite(when) || when <= Date.now() || when > Date.now() + ALARMS_MAX_WHEN_AHEAD_MS) {
        return respondError(webview, 'nova:alarms:create', requestId, 'INVALID_ARGS', 'when must be a future epoch-ms timestamp no more than a year out');
      }
      alarm = { when: Math.floor(when), nextFire: Math.floor(when) };
    } else {
      const period = payload.periodMinutes;
      if (typeof period !== 'number' || !Number.isFinite(period) || period < ALARMS_MIN_PERIOD_MINUTES) {
        return respondError(webview, 'nova:alarms:create', requestId, 'INVALID_ARGS', `periodMinutes must be a number >= ${ALARMS_MIN_PERIOD_MINUTES}`);
      }
      alarm = { periodMinutes: Math.floor(period), nextFire: Date.now() + Math.floor(period) * 60_000 };
    }
    const state = loadAlarmState();
    const record = state.apps[app.id] || (state.apps[app.id] = { alarms: {}, queue: [] });
    if (!record.alarms || typeof record.alarms !== 'object') record.alarms = {};
    const replacing = Object.prototype.hasOwnProperty.call(record.alarms, name);
    if (!replacing && Object.keys(record.alarms).length >= ALARMS_MAX_PER_APP) {
      return respondError(webview, 'nova:alarms:create', requestId, 'RATE_LIMITED', `Max ${ALARMS_MAX_PER_APP} alarms per app`);
    }
    record.alarms[name] = alarm;
    saveAlarmState(state);
    scheduleAlarmTimer(app.id, name, alarm);
    return respond(webview, 'nova:alarms:create', requestId, {
      success: true,
      replaced: replacing,
      alarm: { name: name, when: alarm.when ?? null, periodMinutes: alarm.periodMinutes ?? null, scheduledTime: alarm.nextFire },
    });
  }

  async function handleAlarmsClear({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:schedule', app.id)) {
      return respondError(webview, 'nova:alarms:clear', requestId, 'PERMISSION_DENIED', 'system:schedule permission required');
    }
    const name = payload?.name;
    if (!validAlarmName(name)) {
      return respondError(webview, 'nova:alarms:clear', requestId, 'INVALID_ARGS', 'a valid alarm name is required');
    }
    const state = loadAlarmState();
    const record = state.apps[app.id];
    const had = !!(record && record.alarms && Object.prototype.hasOwnProperty.call(record.alarms, name));
    if (had) { delete record.alarms[name]; saveAlarmState(state); }
    stopAlarmTimer(app.id, name);
    return respond(webview, 'nova:alarms:clear', requestId, { success: true, cleared: had });
  }

  // ── Secrets (secrets:store) ────────────────────────────────────────────
  // Encrypted per-app key/value store for small credentials, backed by the
  // AppSecrets module (AES-256-GCM, per-install master key, plaintext never
  // on disk). Deliberately NOT part of the app's portable namespace: the
  // data:export / data:backup surfaces read the storage service only, so a
  // backup envelope can never silently carry credentials. The Store module
  // enforces the same budgets (64 secrets, 8 KB values, 128-char keys).
  function secretsPermitted(appId) {
    return AppPermissionManager.isGranted('secrets:store', appId);
  }

  async function handleSecretsSet({ payload, requestId, app, webview }) {
    if (!secretsPermitted(app.id)) {
      return respondError(webview, 'nova:secrets:set', requestId, 'PERMISSION_DENIED', 'secrets:store permission required');
    }
    const result = AppSecrets.set(app.id, payload?.key, payload?.value);
    if (!result.ok) {
      return respondError(webview, 'nova:secrets:set', requestId, result.code, result.message);
    }
    return respond(webview, 'nova:secrets:set', requestId, { success: true, persisted: result.persisted !== false });
  }

  async function handleSecretsGet({ payload, requestId, app, webview }) {
    if (!secretsPermitted(app.id)) {
      return respondError(webview, 'nova:secrets:get', requestId, 'PERMISSION_DENIED', 'secrets:store permission required');
    }
    const value = AppSecrets.get(app.id, payload?.key);
    return respond(webview, 'nova:secrets:get', requestId, { success: true, value: value });
  }

  async function handleSecretsDelete({ payload, requestId, app, webview }) {
    if (!secretsPermitted(app.id)) {
      return respondError(webview, 'nova:secrets:delete', requestId, 'PERMISSION_DENIED', 'secrets:store permission required');
    }
    const deleted = AppSecrets.del(app.id, payload?.key);
    return respond(webview, 'nova:secrets:delete', requestId, { success: true, deleted: deleted });
  }

  async function handleSecretsKeys({ requestId, app, webview }) {
    if (!secretsPermitted(app.id)) {
      return respondError(webview, 'nova:secrets:keys', requestId, 'PERMISSION_DENIED', 'secrets:store permission required');
    }
    return respond(webview, 'nova:secrets:keys', requestId, { success: true, keys: AppSecrets.keys(app.id) });
  }

  async function handleAlarmsGetAll({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('system:schedule', app.id)) {
      return respondError(webview, 'nova:alarms:getAll', requestId, 'PERMISSION_DENIED', 'system:schedule permission required');
    }
    const state = loadAlarmState();
    const record = state.apps[app.id];
    const alarms = [];
    if (record && record.alarms) {
      for (const [name, alarm] of Object.entries(record.alarms)) {
        alarms.push({ name: name, when: alarm.when ?? null, periodMinutes: alarm.periodMinutes ?? null, scheduledTime: alarm.nextFire });
      }
    }
    return respond(webview, 'nova:alarms:getAll', requestId, { success: true, alarms: alarms });
  }

  // ── Push delivery (push:receive) ───────────────────────────────────────
  // Server-to-app push, the FCM shape: the app's own backend publishes a
  // message to a per-app subscription token, the OS push service relays it
  // to the device over ONE connection the OS holds (never the app — apps
  // get no listen sockets), and the message goes down the delivery ladder:
  //
  //   1. app running            → nova:push:message push into the live sandbox
  //   2. closed + system:background → queue + AppScheduler.requestWake();
  //      the queue flushes right after the woken sandbox's ready handshake,
  //      inside the same bounded wake window as any scheduled wake
  //   3. closed, notification payload (title/body) → the OS displays it
  //      attributed to the app (same sanitizer + per-app notification rate
  //      limit as apps posting their own), and…
  //   4. …the data part is always queued (bounded, flushed after nova:ready
  //      on the next launch, exactly like missed one-shot alarms)
  //
  // Every rung re-checks the push:receive grant and the disabled list, so
  // a revoked or disabled app stops receiving at the door — no sandbox is
  // ever started for a message an app may no longer see. The token
  // registry and the queue persist host-side (localStorage, the same store
  // the alarms and permission manager use) so tokens and undelivered
  // messages survive OS reboots.
  //
  // Transport honesty: the host's SSE stream is best-effort. If the server
  // can't be reached, messages published meanwhile are held in the
  // SERVER's small in-memory backlog (last 16 per token, 24 h) and
  // replayed on the next connect; anything older, or beyond the backlog,
  // is genuinely lost — push is live-delivery semantics, not a mailbox.
  // The register/unregister channels work with the transport fully absent
  // (offline, headless test runs): the token is real and stable, and the
  // delivery ladder can be driven locally regardless.
  const PUSH_STORAGE_KEY = 'nova_app_push';
  const PUSH_DEVICE_ID_KEY = 'nova_push_device_id';
  const PUSH_QUEUE_MAX = 8;
  const PUSH_TITLE_MAX = 200;
  const PUSH_BODY_MAX = 2000;
  const PUSH_DATA_MAX_BYTES = 4 * 1024;
  const PUSH_ID_MAX = 64;
  const PUSH_BACKOFF_STEPS_MS = [1000, 2000, 5000, 15000];

  function loadPushState() {
    const state = sysState();
    if (state && typeof state.push === 'function') {
      try {
        const fromRegistry = state.push();
        if (fromRegistry && typeof fromRegistry === 'object' && fromRegistry.tokens && typeof fromRegistry.tokens === 'object') {
          return fromRegistry;
        }
      } catch (_) { /* fall through to legacy */ }
    }
    try {
      const raw = localStorage.getItem(PUSH_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object') return parsed;
    } catch (_) { /* corrupt state — start clean */ }
    return { version: 1, tokens: {}, queue: {} };
  }

  function savePushState(state) {
    const sys = sysState();
    if (sys && typeof sys.setPush === 'function') {
      try { sys.setPush(state); return; } catch (_) { /* fall through to legacy */ }
    }
    try { localStorage.setItem(PUSH_STORAGE_KEY, JSON.stringify(state)); } catch (_) { /* best-effort */ }
  }

  function pushDeviceId() {
    const sys = sysState();
    if (sys && typeof sys.pushDeviceId === 'function') {
      try {
        const existing = sys.pushDeviceId();
        if (existing && /^[\w-]{8,64}$/.test(existing)) return existing;
      } catch (_) { /* fall through to generation */ }
    }
    try {
      const existing = localStorage.getItem(PUSH_DEVICE_ID_KEY);
      if (existing && /^[\w-]{8,64}$/.test(existing)) return existing;
    } catch (_) { /* fall through to generation */ }
    const fresh = generatePushToken().slice(PUSH_TOKEN_PREFIX_LENGTH);
    let stored = false;
    if (sys && typeof sys.setPushDeviceId === 'function') {
      try { stored = sys.setPushDeviceId(fresh); } catch (_) { stored = false; }
    }
    if (!stored) {
      try { localStorage.setItem(PUSH_DEVICE_ID_KEY, fresh); } catch (_) { /* best-effort */ }
    }
    return fresh;
  }

  function generatePushToken() {
    // SECURITY (2026-11-12 audit, finding M3): push tokens/device ids are
    // bearer credentials for the push subscription surface. Math.random
    // (V8 xorshift128+) is predictable, so a fallback to it for token
    // generation is a forgery hole, not a compatibility shim — the token
    // now fails CLOSED when a CSPRNG is genuinely unavailable.
    // crypto.getRandomValues exists in every Chromium context (secure or
    // not), so this throw is unreachable in practice, and any hypothetical
    // caller that hits it must not receive a guessable token.
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      throw new Error('crypto.getRandomValues unavailable: refusing to generate a predictable push token');
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return 'nps_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const PUSH_TOKEN_PREFIX_LENGTH = 4; // slice('nps_') for device ids

  function normalizePushMessage(raw, appId) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const id = typeof src.id === 'string' && src.id.length >= 1 && src.id.length <= PUSH_ID_MAX
      ? src.id
      : generatePushToken().slice(4);
    const title = typeof src.title === 'string' ? src.title.slice(0, PUSH_TITLE_MAX) : '';
    const body = typeof src.body === 'string' ? src.body.slice(0, PUSH_BODY_MAX) : '';
    let data = null;
    if (src.data != null) {
      try {
        const encoded = JSON.stringify(src.data);
        if (encoded.length <= PUSH_DATA_MAX_BYTES) data = JSON.parse(encoded);
      } catch (_) { data = null; }
    }
    return {
      appId: appId,
      id: id,
      title: title,
      body: body,
      data: data,
      sentAt: typeof src.sentAt === 'string' ? src.sentAt : new Date().toISOString(),
    };
  }

  function enqueuePushMessage(state, appId, message) {
    if (!state.queue || typeof state.queue !== 'object') state.queue = {};
    if (!Array.isArray(state.queue[appId])) state.queue[appId] = [];
    state.queue[appId].push(message);
    if (state.queue[appId].length > PUSH_QUEUE_MAX) state.queue[appId].splice(0, state.queue[appId].length - PUSH_QUEUE_MAX);
  }

  function appIsPushDisabled(appId) {
    try {
      // Registry-backed (HKNU/apps/disabled) via RegistryPrefs.
      return typeof RegistryPrefs !== 'undefined' && RegistryPrefs.isAppDisabled
        ? RegistryPrefs.isAppDisabled(appId)
        : false;
    } catch (_) { return false; }
  }

  // The OS-attributed notification rung: the same sanitizer and the same
  // per-app rate budget as an app posting its own notification — the user
  // granted push:receive, not "spawn unlimited popups while closed".
  function showPushNotification(appId, message) {
    if (typeof Notify === 'undefined' || typeof Notify.show !== 'function') return false;
    if (!message.title && !message.body) return false;
    if (!checkNotificationRateLimit(appId)) return false;
    const appRecord = (typeof OS !== 'undefined' && OS.apps && OS.apps[appId]) || {};
    try {
      Notify.show(sanitizeNotificationPayload(
        { title: message.title || 'Notification', body: message.body, type: 'info' },
        appRecord.name || appId,
        appId,
      ));
      return true;
    } catch (_) { return false; }
  }

  // The delivery ladder. Always resolves { delivered, how } — delivered is
  // true whenever the message reached the app or a durable bounded queue,
  // false only when the app may not receive at all (no grant, disabled,
  // uninstalled). Never throws.
  function deliverPushMessage(appId, rawMessage) {
    try {
      if (typeof appId !== 'string' || !appId) return { delivered: false, how: 'bad-app-id' };
      if (appIsPushDisabled(appId)) return { delivered: false, how: 'disabled' };
      if (typeof AppPermissionManager === 'undefined' || !AppPermissionManager.isGranted
        || !AppPermissionManager.isGranted('push:receive', appId)) {
        return { delivered: false, how: 'no-grant' };
      }
      const message = normalizePushMessage(rawMessage, appId);

      // Rung 1 — live sandbox (visible window, else a Tier-2 keep-alive).
      const sandbox = liveSandboxForApp(appId);
      if (sandbox) {
        try {
          respond(sandbox.webview, 'nova:push:message', generateRequestId(), message);
          return { delivered: true, how: 'live' };
        } catch (_) { /* fall through the ladder — a dying sandbox queues */ }
      }

      // Rung 2 — closed but allowed to run brief headless work: queue and
      // request a wake. requestWake uses the same bounded window and
      // teardown as any scheduled wake; whether or not it fires right now,
      // the queue is the durable half of this rung (flushed after
      // nova:ready — next launch at the latest).
      if (typeof AppPermissionManager.isGranted === 'function'
        && AppPermissionManager.isGranted('system:background', appId)
        && typeof AppScheduler !== 'undefined' && typeof AppScheduler.requestWake === 'function') {
        const state = loadPushState();
        enqueuePushMessage(state, appId, message);
        savePushState(state);
        let woke = false;
        try { woke = AppScheduler.requestWake(appId); } catch (_) { woke = false; }
        return { delivered: true, how: woke ? 'wake-queued' : 'queued' };
      }

      // Rung 3+4 — closed and not wakeable: show the notification payload
      // attributed to the app (if any), and queue the data part.
      const notified = showPushNotification(appId, message);
      const state = loadPushState();
      enqueuePushMessage(state, appId, message);
      savePushState(state);
      return { delivered: true, how: notified ? 'notified-queued' : 'queued' };
    } catch (_) {
      return { delivered: false, how: 'error' };
    }
  }

  // Flush the bounded queue into a just-ready sandbox — called from the
  // post-nova:ready block below, alongside the alarm and share flushes.
  // On a mid-flush failure (sandbox dying under us) the undelivered tail
  // goes back to the FRONT of the queue, bounded again, so ordering is
  // preserved for the next attempt.
  function flushPushQueue(appId, webview) {
    if (typeof AppPermissionManager === 'undefined' || !AppPermissionManager.isGranted
      || !AppPermissionManager.isGranted('push:receive', appId)) return;
    const state = loadPushState();
    const record = state.queue ? state.queue[appId] : null;
    if (!Array.isArray(record) || !record.length) return;
    const pending = record.splice(0, record.length);
    try { savePushState(state); } catch (_) { /* best-effort */ }
    let failedAt = -1;
    for (let i = 0; i < pending.length; i++) {
      try {
        respond(webview, 'nova:push:message', generateRequestId(), Object.assign({}, pending[i], { queued: true }));
      } catch (_) { failedAt = i; break; }
    }
    if (failedAt >= 0) {
      const remaining = pending.slice(failedAt);
      const state2 = loadPushState();
      if (!state2.queue || typeof state2.queue !== 'object') state2.queue = {};
      state2.queue[appId] = remaining
        .concat(Array.isArray(state2.queue[appId]) ? state2.queue[appId] : [])
        .slice(-PUSH_QUEUE_MAX);
      savePushState(state2);
    }
  }

  // ── Push transport (host-side SSE client) ─────────────────────────────
  // One connection per device, held by the OS, not by any app. Connects
  // only while at least one installed, enabled app holds push:receive,
  // re-subscribes the token set on every (re)connect, and backs off
  // geometrically on failures. Every branch is defensive: this module must
  // work with fetch, location, and Notify all absent (headless test runs,
  // offline devices) — delivery-ladder and token lifecycle come first.
  let pushStreamAbort = null;
  let pushReconnectTimer = null;
  let pushReconnectStep = 0;
  let pushSubscriptionsDirty = true;

  function pushPermissionHolders() {
    if (typeof OS === 'undefined' || !OS.apps) return [];
    if (typeof AppPermissionManager === 'undefined' || !AppPermissionManager.isGranted) return [];
    let disabled = [];
    try { disabled = (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.disabledApps) ? RegistryPrefs.disabledApps() : []; } catch (_) { disabled = []; }
    return Object.values(OS.apps).filter((app) => app && app.id
      && !(Array.isArray(disabled) && disabled.includes(app.id))
      && AppPermissionManager.isGranted('push:receive', app.id));
  }

  function pushTransportAvailable() {
    return typeof fetch === 'function' && typeof window !== 'undefined' && !!window.location;
  }

  // Push the current token set to the server: one { token, appId } entry
  // for every app that STILL holds the grant. The trusted host supplies
  // the appId, so a backend publishing to a token can never address a
  // different app than the one that registered it. Prunes
  // revoked/uninstalled apps' tokens as a side effect — the server's
  // token→device map is rebuilt from this on every reconnect, so a
  // restart anywhere heals itself.
  async function syncPushSubscriptions(force = false) {
    if (!force && !pushSubscriptionsDirty) return true;
    try {
      const holders = pushPermissionHolders();
      const state = loadPushState();
      const subscriptions = holders
        .map((app) => (state.tokens[app.id] ? { token: state.tokens[app.id].token, appId: app.id } : null))
        .filter(Boolean);
      const response = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: pushDeviceId(), subscriptions: subscriptions }),
      });
      if (!response?.ok) throw new Error(`server returned HTTP ${response?.status ?? 'unknown'}`);
      const result = await response.json();
      if (result?.ok !== true || result.subscribed !== subscriptions.length) {
        throw new Error('server did not confirm every push subscription');
      }
      pushSubscriptionsDirty = false;
      return true;
    } catch (error) {
      pushSubscriptionsDirty = true;
      console.warn('[Push] Subscription sync failed; it will retry on the next registration or stream reconnect:', error?.message || error);
      return false;
    }
  }

  function schedulePushReconnect() {
    if (pushReconnectTimer) return;
    const delay = PUSH_BACKOFF_STEPS_MS[Math.min(pushReconnectStep, PUSH_BACKOFF_STEPS_MS.length - 1)];
    pushReconnectStep += 1;
    pushReconnectTimer = setTimeout(() => {
      pushReconnectTimer = null;
      ensurePushConnection();
    }, delay);
    if (typeof pushReconnectTimer === 'object' && pushReconnectTimer !== null && typeof pushReconnectTimer.unref === 'function') pushReconnectTimer.unref();
  }

  async function pushStreamLoop() {
    // Hold the controller this loop owns so a replaced/aborted connection
    // never clobbers a newer one's state on its way out.
    const controller = pushStreamAbort;
    while (controller && !controller.aborted) {
      let res = null;
      try {
        // system-fetch (OS UI context) signs same-origin /api/ GETs; in
        // environments without it this is a plain fetch and the server's
        // trust check will simply refuse — treated like any other failure.
        res = await fetch('/api/push/stream?deviceId=' + encodeURIComponent(pushDeviceId()), {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        });
      } catch (_) { res = null; }
      if (!res || !res.ok || !res.body) {
        if (pushStreamAbort === controller) pushStreamAbort = null;
        schedulePushReconnect();
        return;
      }

      pushReconnectStep = 0;
      syncPushSubscriptions(true);
      // Drain replay happens server-side at attach; parse the event stream.
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (controller && !controller.aborted) {
          let chunk = null;
          try { chunk = await reader.read(); } catch (_) { chunk = { done: true }; }
          if (chunk.done || !chunk.value) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let sep;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt && evt.appId) deliverPushMessage(evt.appId, evt);
              } catch (_) { /* malformed frame — skip */ }
            }
          }
        }
        try { reader.cancel?.(); } catch (_) { /* closing anyway */ }
      } catch (_) { /* fall out to reconnect */ }
      if (pushStreamAbort === controller) pushStreamAbort = null;
      schedulePushReconnect();
      return;
    }
  }

  function ensurePushConnection() {
    if (!pushTransportAvailable()) return;
    const holders = pushPermissionHolders();
    if (!holders.length) {
      if (pushStreamAbort) { try { pushStreamAbort.abort(); } catch (_) {} pushStreamAbort = null; }
      return;
    }
    if (pushStreamAbort) {
      // Already connected — but the token set may have changed.
      if (pushSubscriptionsDirty) syncPushSubscriptions();
      return;
    }
    pushStreamAbort = new AbortController();
    pushStreamLoop();
  }

  async function handlePushRegister({ payload, requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('push:receive', app.id)) {
      return respondError(webview, 'nova:push:register', requestId, 'PERMISSION_DENIED', 'push:receive permission required');
    }
    const state = loadPushState();
    if (!state.tokens || typeof state.tokens !== 'object') state.tokens = {};
    if (!state.queue || typeof state.queue !== 'object') state.queue = {};
    const existing = state.tokens[app.id];
    const record = existing && /^nps_[0-9a-f]{32}$/.test(existing.token)
      ? existing
      : { token: generatePushToken(), createdAt: new Date().toISOString() };
    const replaced = !!existing && existing !== record;
    state.tokens[app.id] = record;
    savePushState(state);
    // Connection may not exist yet (first registrant boots it); the sync
    // marks the token set dirty even when it can't run right now.
    pushSubscriptionsDirty = true;
    const subscribed = await syncPushSubscriptions(true);
    ensurePushConnection();
    let endpoint = '/api/push/publish';
    try { endpoint = new URL('/api/push/publish', window.location.href).toString(); } catch (_) { /* relative path is fine */ }
    const queued = Array.isArray(state.queue[app.id]) ? state.queue[app.id].length : 0;
    return respond(webview, 'nova:push:register', requestId, {
      success: true,
      token: record.token,
      endpoint: endpoint,
      queued: queued,
      replaced: replaced,
      subscribed: subscribed,
    });
  }

  async function handlePushUnregister({ requestId, app, webview }) {
    if (!AppPermissionManager.isGranted('push:receive', app.id)) {
      return respondError(webview, 'nova:push:unregister', requestId, 'PERMISSION_DENIED', 'push:receive permission required');
    }
    const state = loadPushState();
    const had = !!(state.tokens && Object.prototype.hasOwnProperty.call(state.tokens, app.id));
    if (had) delete state.tokens[app.id];
    // Unregistering stops the surface entirely: the queue is dropped too.
    // Messages published after this point fail the grant check at the
    // delivery ladder anyway — nothing new can queue behind this flush.
    if (state.queue && Object.prototype.hasOwnProperty.call(state.queue, app.id)) delete state.queue[app.id];
    savePushState(state);
    pushSubscriptionsDirty = true;
    await syncPushSubscriptions(true);
    ensurePushConnection();
    return respond(webview, 'nova:push:unregister', requestId, { success: true, removed: had });
  }

  // Rebuild the connection once the host module is live — deferred like
  // the alarm bootstrap so a module load inside a test harness never
  // opens anything before state exists. No-op wherever fetch is absent.
  if (typeof setTimeout === 'function') {
    const pushBootTimer = setTimeout(ensurePushConnection, 0);
    if (pushBootTimer && typeof pushBootTimer.unref === 'function') pushBootTimer.unref();
  }

  const PUBLIC_APPEARANCE_SETTING_KEYS = new Set(['theme', 'accentColor', 'highContrast', 'reduceMotion', 'removeTransparency']);
  const PUBLIC_APPEARANCE_FIELDS = new Set(['theme', 'accentColor', 'highContrast', 'reduceMotion', 'transparentSurfaces']);
  const PUBLIC_THEMES = new Set(['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox']);
  const appearanceSetRateLimits = new Map();

  function getPublicAppearance() {
    const settings = OS?.settings;
    return {
      theme: settings?.get?.('theme') || 'nova-dark',
      accentColor: settings?.get?.('accentColor') || null,
      highContrast: settings?.get?.('highContrast') === true,
      reduceMotion: settings?.get?.('reduceMotion') === true,
      transparentSurfaces: settings?.get?.('removeTransparency') !== true,
    };
  }

  async function handleAppearanceGet({ requestId, webview }) {
    if (!OS?.settings?.get) {
      return respondError(webview, 'nova:appearance:get', requestId, 'UNAVAILABLE', 'Appearance settings are not available');
    }
    return respond(webview, 'nova:appearance:get', requestId, getPublicAppearance());
  }

  async function handleAppearanceSet({ payload, requestId, app, webview }) {
    if (typeof OS?.settings?.set !== 'function') {
      return respondError(webview, 'nova:appearance:set', requestId, 'UNAVAILABLE', 'Appearance settings are not available');
    }
    const patch = payload?.appearance;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', 'appearance must be an object of supported appearance preferences');
    }
    const entries = Object.entries(patch);
    if (!entries.length || entries.some(([key]) => !PUBLIC_APPEARANCE_FIELDS.has(key))) {
      return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', 'Only theme, accentColor, highContrast, reduceMotion, and transparentSurfaces can be changed');
    }
    const now = Date.now();
    const recentUpdates = (appearanceSetRateLimits.get(app.id) || []).filter(time => time > now - 60_000);
    if (recentUpdates.length >= 10) {
      appearanceSetRateLimits.set(app.id, recentUpdates);
      return respondError(webview, 'nova:appearance:set', requestId, 'RATE_LIMITED', 'Max 10 appearance updates per minute');
    }
    for (const [key, value] of entries) {
      const valid = key === 'theme'
        ? PUBLIC_THEMES.has(value)
        : key === 'accentColor'
          ? value === null || (typeof value === 'string' && /^#[\da-f]{6}$/i.test(value))
          : typeof value === 'boolean';
      if (!valid) {
        return respondError(webview, 'nova:appearance:set', requestId, 'INVALID_ARGS', `Invalid value for appearance setting '${key}'`);
      }
    }
    for (const [key, value] of entries) {
      const settingKey = key === 'transparentSurfaces' ? 'removeTransparency' : key;
      const settingValue = key === 'transparentSurfaces' ? !value : value;
      if (OS.settings.set(settingKey, settingValue) === false) {
        return respondError(webview, 'nova:appearance:set', requestId, 'POLICY_BLOCKED', `Appearance setting '${key}' is blocked by system policy`);
      }
    }
    recentUpdates.push(now);
    appearanceSetRateLimits.set(app.id, recentUpdates);
    return respond(webview, 'nova:appearance:set', requestId, { success: true, appearance: getPublicAppearance() });
  }

  async function handleAppearanceSubscribe({ requestId, webview, sandbox }) {
    if (!OS?.events?.on || !sandbox) {
      return respondError(webview, 'nova:appearance:subscribe', requestId, 'UNAVAILABLE', 'Appearance change events are not available');
    }
    if (sandbox.appearanceSubscription) {
      return respondError(webview, 'nova:appearance:subscribe', requestId, 'ALREADY_SUBSCRIBED', 'Already subscribed to appearance changes');
    }
    const handler = change => {
      if (!PUBLIC_APPEARANCE_SETTING_KEYS.has(change?.key)) return;
      respond(webview, 'nova:appearance:changed:event', generateRequestId(), getPublicAppearance());
    };
    OS.events.on('settings:changed', handler);
    sandbox.appearanceSubscription = () => OS.events.off?.('settings:changed', handler);
    return respond(webview, 'nova:appearance:subscribe', requestId, { success: true, appearance: getPublicAppearance() });
  }

  async function handleAppearanceUnsubscribe({ requestId, webview, sandbox }) {
    sandbox?.appearanceSubscription?.();
    if (sandbox) sandbox.appearanceSubscription = null;
    return respond(webview, 'nova:appearance:unsubscribe', requestId, { success: true });
  }

  // Ready handshake

  async function handleReady({ requestId, app, webview }) {
    if (!app) {
      return respondError(webview, 'nova:ready', requestId, 'UNAVAILABLE', 'No app context for ready handshake');
    }
    const mgr = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
    const appPerms = app.permissions || [];
    const appOptional = app.optionalPermissions || [];
    const granted = mgr ? appPerms.filter(p => mgr.isGranted(p, app.id)) : appPerms;
    const optionalGranted = mgr ? appOptional.filter(p => mgr.isGranted(p, app.id)) : appOptional;
    const payload = {
      success: true,
      appId: app.id,
      permissions: granted,
      optionalPermissions: optionalGranted,
      osVersion: OS?.version,
      securityPatch: OS?.securityPatch,
      // System-bundled apps legitimately need the same OS identity that the
      // host UI uses (for example Terminal's `whoami`, prompt, and `$USER`).
      // A webview is a separate JS realm, so it cannot read the host `OS`
      // object directly. Expose the username through the authenticated ready
      // handshake instead of leaving the guest-side compatibility facade at
      // its fallback value of `user`. Non-system apps do not receive it.
      username: app.system === true ? OS?.username : undefined,
    };
    // Some apps (see the capability shim / createDefaultAppShell) read the
    // handshake fields directly off the top-level response object rather
    // than through the generic `result` wrapper. The guest-side shim's
    // inbox poller merges `result` fields onto the top level of what it
    // hands back to app code, so a single respond() call covers both
    // shapes — no separate legacy send needed.
    respond(webview, 'nova:ready', requestId, payload);

    // One-shot alarms that fired while the app was fully closed are
    // delivered right after the ready handshake — the app is up, its
    // listeners can register. Bounded by ALARMS_QUEUE_MAX at enqueue time.
    try {
      const alarmState = loadAlarmState();
      const alarmRecord = alarmState.apps[app.id];
      if (alarmRecord && Array.isArray(alarmRecord.queue) && alarmRecord.queue.length) {
        const pending = alarmRecord.queue.splice(0, alarmRecord.queue.length);
        saveAlarmState(alarmState);
        for (const queued of pending) {
          respond(webview, 'nova:background:alarm', generateRequestId(), {
            name: queued.name,
            alarm: { name: queued.name, when: null, periodMinutes: null, scheduledTime: queued.scheduledTime },
            firedAt: queued.firedAt,
            queued: true,
          });
        }
      }
    } catch (_) { /* best-effort delivery */ }

    // Inbound shares queued while this app was closed (share-target picks
    // with no live sandbox) — delivered right after ready, like alarms.
    try { flushShareInboundQueue(app.id, webview); } catch (_) { /* best-effort */ }

    // Push messages queued while this app was fully closed (delivery
    // ladder rungs 2 and 4) — delivered right after ready, same bounded
    // semantics as the missed-alarm flush above.
    try { flushPushQueue(app.id, webview); } catch (_) { /* best-effort */ }
  }

  // File dialogs

  async function handleDialogOpen({ payload, requestId, app, webview, sandbox }) {
    // Same accept contract as the other two pickers (nova:files:open,
    // nova:sysdialog:open): MIME types and/or .ext entries, array or comma
    // string. An invalid list is rejected loudly instead of silently opening
    // an unfiltered dialog.
    if (payload?.accept !== undefined && normalizePickerAcceptList(payload?.accept) === null) {
      return respondError(webview, 'nova:dialog:open', requestId, 'INVALID_ARGS',
        'accept must be a string or an array of at most 20 MIME types and/or file extensions (e.g. ".json")');
    }
    showFileDialog('open', webview, 'nova:dialog:open', requestId, app, payload, sandbox);
    // Response is sent from the dialog's confirm/cancel handler.
  }

  async function handleDialogSave({ payload, requestId, app, webview, sandbox }) {
    showFileDialog('save', webview, 'nova:dialog:save', requestId, app, payload, sandbox);
  }

  // The trusted picker returns host paths; sandbox filesystem APIs use a
  // separate virtual filesystem and cannot resolve those paths as nodes.

  // Picker accept-list contract (shared by nova:files:open and
  // nova:sysdialog:open): an app may pass MIME types ('text/plain'),
  // file extensions ('.json'), or both, matching <input accept> semantics —
  // SystemDialogs.acceptFilter() has always understood both forms. The
  // files:open handler used to validate entries as MIME-only, so an app
  // sending ['.json', 'text/plain'] was rejected with INVALID_ARGS before
  // the picker ever opened. Both handlers now share this validator.
  const PICKER_ACCEPT_MAX_ENTRIES = 20;
  const PICKER_ACCEPT_ENTRY_MAX_LEN = 64;
  const PICKER_ACCEPT_MIME_RE = /^[\w.+*-]+\/[\w.+*-]+$/;
  const PICKER_ACCEPT_EXT_RE = /^\.[\w+-]+$/i;

  function isValidPickerAcceptEntry(entry) {
    return typeof entry === 'string' && entry.length <= PICKER_ACCEPT_ENTRY_MAX_LEN
      && (PICKER_ACCEPT_MIME_RE.test(entry) || PICKER_ACCEPT_EXT_RE.test(entry));
  }

  // Validates an accept list (array or, for sysdialog, a comma-separated
  // string) and returns it in the single form SystemDialogs consumes:
  // one comma-joined string. Returns undefined for "no filter".
  function normalizePickerAcceptList(raw) {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'string') return raw.length <= 512 ? raw : undefined;
    if (!Array.isArray(raw) || raw.length > PICKER_ACCEPT_MAX_ENTRIES
      || raw.some(entry => !isValidPickerAcceptEntry(entry))) {
      return null; // invalid — caller responds INVALID_ARGS
    }
    return raw.join(',');
  }

  // Multi-select ceiling for a single picker call. Each picked file is read
  // into memory and base64-framed across the guest bridge (up to 10 MB per
  // file), so an uncapped multi-pick lets an app memory-bomb its own sandbox
  // through the bridge. 25 covers real photo/batch-import workflows.
  const PICKER_MULTI_MAX_FILES = 25;

  // Builds a (name, mimeType) => boolean matcher from an accept list in any
  // form the pickers accept (comma string or array of MIME types and/or .ext
  // rules). Mirrors SystemDialogs.acceptFilter semantics: extension rules
  // match by filename suffix; MIME rules match the node's type exactly (or
  // by type/* prefix) and let unidentified (application/octet-stream) files
  // through, since the mime table cannot rule them out. Returns null when
  // the list yields no usable rule. Used by the nova:dialog:open overlay,
  // whose accept field used to be display-only (a "Filter:" label) while the
  // documented example passed ['.txt', '.md'].
  function pickerAcceptMatcher(rawAccept) {
    const joined = normalizePickerAcceptList(rawAccept);
    if (!joined) return null;
    const rules = String(joined).split(',').map(r => r.trim().toLowerCase())
      .filter(r => PICKER_ACCEPT_EXT_RE.test(r) || PICKER_ACCEPT_MIME_RE.test(r));
    if (!rules.length) return null;
    return (name, mimeType) => {
      const lowerName = String(name || '').toLowerCase();
      const type = String(mimeType || '').toLowerCase() || 'application/octet-stream';
      return rules.some(rule => {
        if (PICKER_ACCEPT_EXT_RE.test(rule)) return lowerName.endsWith(rule);
        if (type === 'application/octet-stream') return true;
        if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
        return type === rule;
      });
    };
  }

  // True when the bytes are clean UTF-8 text (no NUL bytes, decodes under a
  // strict decoder). Used for files the mime table can't type — a
  // '.recipe'-style custom text format looks like application/octet-stream
  // but is plain text an app must be able to read as text. Genuinely binary
  // content virtually always contains NULs or invalid UTF-8 sequences and
  // still comes back base64 with encoding:'base64'.
  function looksLikeUtf8Text(bytes) {
    if (!bytes || !bytes.length) return true;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return false;
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function readPickedHostFile(picked) {
    const path = require('path');
    const filePath = typeof picked?.path === 'string' ? picked.path : '';
    const name = typeof picked?.name === 'string' ? picked.name : '';
    const resolvedPath = path.resolve(filePath);
    if (!filePath || !path.isAbsolute(filePath) || !name ||
        name !== path.basename(resolvedPath)) {
      throw new Error('The system picker returned an invalid file');
    }

    const fileHandle = await require('fs').promises.open(resolvedPath, 'r');
    try {
      const stats = await fileHandle.stat();
      if (!stats.isFile()) throw new Error('Select a regular file');
      if (stats.size > 10_000_000) throw new Error('Selected files are limited to 10 MB');
      const data = await fileHandle.readFile();
      if (data.length > 10_000_000) throw new Error('Selected files are limited to 10 MB');

      const mimeType = typeof picked.mimeType === 'string' ? picked.mimeType : 'application/octet-stream';
      const isText = mimeType.startsWith('text/') ||
        ['application/json', 'application/x-sh', 'application/xml'].includes(mimeType) ||
        // Unknown-typed files: sniff. Returning clean UTF-8 as text keeps
        // custom text formats ('.recipe', '.yaml', …) readable; real binary
        // fails the sniff and stays base64. See looksLikeUtf8Text.
        (mimeType === 'application/octet-stream' && looksLikeUtf8Text(data));
      return {
        name,
        path: resolvedPath,
        mimeType,
        size: data.length,
        content: isText ? data.toString('utf8') : data.toString('base64'),
        ...(isText ? {} : { encoding: 'base64' }),
      };
    } finally {
      await fileHandle.close();
    }
  }

  // New dialog pair remains separate from the virtual-filesystem picker API.
  async function handleSysDialogOpen({ payload, requestId, app, webview, sandbox }) {
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    // accept: a comma-separated string OR an array of MIME types and/or file
    // extensions — same contract as nova:files:open (normalizePickerAcceptList).
    // Previously only the string form was read, so an app's array accept list
    // was silently dropped and the picker showed every file unfiltered.
    const accept = normalizePickerAcceptList(payload?.accept);
    if (accept === null) {
      return respondError(webview, 'nova:sysdialog:open', requestId, 'INVALID_ARGS',
        'accept must be a string or an array of at most 20 MIME types and/or file extensions (e.g. ".json")');
    }
    // multiple: true — SystemDialogs has always supported click-to-toggle
    // multi-select (open mode only), but this bridge never forwarded the
    // flag, so every multi-file picker silently degraded to single-file.
    const multiple = payload?.multiple === true;
    try {
      const picked = await window.SystemDialogs.open({
        title: typeof payload?.title === 'string' ? payload.title.slice(0, 100) : undefined,
        startPath: typeof payload?.startPath === 'string' && payload.startPath.length <= 4096
          ? payload.startPath
          : undefined,
        accept: accept || undefined,
        multiple,
        pathOnly: true,
      });
      if (!picked) return respond(webview, 'nova:sysdialog:open', requestId, { cancelled: true });
      // Single picks resolve one descriptor; multi picks resolve an array.
      // Normalize to an array of entries either way and answer with both
      // shapes: `files` (always an array) and `file` (the first entry), so
      // single-select apps keep their existing result.file reads while
      // multi-select apps get a stable list.
      const entries = Array.isArray(picked) ? picked : [picked];
      if (entries.length > PICKER_MULTI_MAX_FILES) {
        return respondError(webview, 'nova:sysdialog:open', requestId, 'LIMIT_REACHED',
          `Multi-select is limited to ${PICKER_MULTI_MAX_FILES} files per pick`);
      }
      const files = [];
      for (const entry of entries) {
        if (typeof entry?.path === 'string') {
          files.push(await readPickedHostFile(entry));
        } else {
          if (!resolveFile({ id: entry.id }, app.id)) {
            return respondError(webview, 'nova:sysdialog:open', requestId, 'PERMISSION_DENIED', 'Selected file is outside this app\'s accessible files');
          }
          if (!(sandbox.pickedFileIds instanceof Set)) sandbox.pickedFileIds = new Set();
          sandbox.pickedFileIds.add(entry.id);
          files.push({
            id: entry.id,
            name: entry.name,
            content: coerceFsReadContent(entry.content) || '',
            mimeType: entry.mimeType || 'text/plain',
            size: entry.size || 0,
            path: FS.getPath(entry.id),
          });
        }
      }
      respond(webview, 'nova:sysdialog:open', requestId, {
        success: true,
        file: files[0],
        files,
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:open', requestId, 'DIALOG_ERROR', e?.message || 'Dialog failed');
    }
  }

  function normalizeFsSavePayload(payload, filename) {
    // Serialize non-string payloads instead of silently dropping them:
    // an app saving { a: 1 } must get '{"a":1}' on disk, not an empty
    // file. null/undefined keeps the historical '' (callers treat a
    // missing content as an empty save); non-JSON values (cycles, BigInt)
    // throw and surface as the caller's own error path.
    let rawContent = payload?.content;
    let content = typeof rawContent === 'string'
      ? rawContent
      : (rawContent == null ? '' : JSON.stringify(rawContent));
    let mimeType = typeof payload?.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(payload.mimeType)
      ? payload.mimeType
      : '';
    const dataUrl = content.match(/^data:([^,]*),(.*)$/is);
    let base64Data = false;

    if (dataUrl) {
      const [mediaType = '', ...parameters] = dataUrl[1].split(';');
      const isBase64 = parameters.some(parameter => parameter.toLowerCase() === 'base64');
      mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(mediaType) ? mediaType : mimeType;
      base64Data = isBase64;
      if (!isBase64) {
        if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
          throw new Error('Image data must be provided as Base64 or a Base64 data URL.');
        }
        try {
          content = decodeURIComponent(dataUrl[2]);
        } catch {
          throw new Error('The selected data URL is malformed.');
        }
      } else {
        content = dataUrl[2].replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
      }
    }

    const extension = String(filename || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    const imageMimeTypes = {
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    };
    if ((!mimeType || mimeType === 'text/plain' || mimeType === 'application/octet-stream') && imageMimeTypes[extension]) {
      mimeType = imageMimeTypes[extension];
    }
    mimeType ||= 'text/plain';

    if (mimeType.startsWith('image/') && (mimeType !== 'image/svg+xml' || base64Data)) {
      const base64 = content.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
      const paddedBase64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
      if (!paddedBase64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(paddedBase64)) {
        throw new Error('Image content must be valid Base64 data.');
      }
      content = paddedBase64;
    }

    const binary = base64Data || (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml');
    return { content, mimeType, binary };
  }

  async function writePickedHostFile(picked, payload, app, broadAccess) {
    const path = require('path');
    const fs = require('fs');
    const filePath = typeof picked?.path === 'string' ? picked.path : '';
    const name = typeof picked?.name === 'string' ? picked.name : '';
    const resolvedPath = path.resolve(filePath);
    if (!filePath || !path.isAbsolute(filePath) || !name ||
        name !== path.basename(resolvedPath)) {
      throw new Error('The system picker returned an invalid save location');
    }

    const { content, mimeType, binary } = normalizeFsSavePayload(payload, name);
    const output = binary ? Buffer.from(content, 'base64') : content;
    const byteLength = Buffer.isBuffer(output) ? output.length : Buffer.byteLength(output, 'utf8');
    if (byteLength > 10_000_000) throw new Error('Saved files are limited to 10 MB');

    let existing = false;
    try {
      const stats = await fs.promises.lstat(resolvedPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error('The selected save target must be a regular file');
      }
      existing = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing && !broadAccess) {
      if (typeof window?.confirm !== 'function') {
        throw new Error('User confirmation is required to overwrite this file');
      }
      if (!window.confirm(`Allow ${app.name || app.id} to overwrite "${name}"?`)) return null;
    }

    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const flags = noFollow
      ? (existing
        ? fs.constants.O_WRONLY | noFollow
        : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow)
      : existing ? 'r+' : 'wx';
    const fileHandle = await fs.promises.open(resolvedPath, flags, 0o600);
    try {
      const stats = await fileHandle.stat();
      if (!stats.isFile()) throw new Error('The selected save target must be a regular file');
      await fileHandle.truncate(0);
      await fileHandle.writeFile(output);
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    return { name, path: resolvedPath, size: byteLength, mimeType };
  }

  async function handleSysDialogSave({ payload, requestId, app, webview }) {
    const broadAccess = hasFsAccess(app.id);
    if (typeof window.SystemDialogs === 'undefined') {
      return respondError(webview, 'nova:sysdialog:save', requestId, 'UNAVAILABLE', 'SystemDialogs not loaded');
    }
    try {
      const picked = await window.SystemDialogs.save({
        title: typeof payload?.title === 'string' ? payload.title.slice(0, 100) : undefined,
        suggestedName: typeof payload?.suggestedName === 'string'
          ? payload.suggestedName.slice(0, 255)
          : '',
        startPath: typeof payload?.startPath === 'string' && payload.startPath.length <= 4096
          ? payload.startPath
          : undefined,
      });
      if (!picked) return respond(webview, 'nova:sysdialog:save', requestId, { cancelled: true });
      if (typeof picked.path !== 'string') {
        if (!resolveFile({ id: picked.folderId }, app.id, true, true)) {
          return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'Selected folder is outside the accessible files');
        }
        const { content, mimeType } = normalizeFsSavePayload(payload, picked.name);
        const existing = FS.listDir(picked.folderId).find(node =>
          node.type === 'file' && node.name === picked.name
        );
        if (existing && !resolveFile({ id: existing.id }, app.id, true, true)) {
          return respondError(webview, 'nova:sysdialog:save', requestId, 'PERMISSION_DENIED', 'Selected file is outside the accessible files');
        }
        if (existing && !isOwnedByApp(existing, app.id) && !broadAccess) {
          if (typeof window?.confirm !== 'function') {
            return respondError(webview, 'nova:sysdialog:save', requestId, 'UNAVAILABLE', 'User confirmation is required to overwrite a shared file');
          }
          if (!window.confirm(`Allow ${app.name || app.id} to overwrite "${existing.name}"?`)) {
            return respond(webview, 'nova:sysdialog:save', requestId, { cancelled: true });
          }
        }
        const newNode = existing
          ? await FS.writeFile(existing.id, content, mimeType)
          : await FS.createFile(picked.folderId, picked.name, content, mimeType);
        if (!newNode) throw new Error('Unable to write the selected file');
        return respond(webview, 'nova:sysdialog:save', requestId, {
          success: true,
          file: { id: newNode.id, name: newNode.name, path: FS.getPath(newNode.id) },
        });
      }
      const file = await writePickedHostFile(picked, payload, app, broadAccess);
      if (!file) return respond(webview, 'nova:sysdialog:save', requestId, { cancelled: true });
      respond(webview, 'nova:sysdialog:save', requestId, {
        success: true,
        file,
      });
    } catch (e) {
      respondError(webview, 'nova:sysdialog:save', requestId, 'WRITE_ERROR', e?.message || 'Failed to write file');
    }
  }

  async function handleScopedFileOpen({ payload, requestId, app, webview, sandbox }) {
    if (typeof window.SystemDialogs?.open !== 'function') {
      return respondError(webview, 'nova:files:open', requestId, 'UNAVAILABLE', 'File picker is not available');
    }
    // Accept entries may be MIME types ('text/plain') and/or file extensions
    // ('.json') — same contract as nova:sysdialog:open; see
    // normalizePickerAcceptList. (Previously MIME-only, which rejected the
    // mixed lists real importers send and killed the feature with
    // INVALID_ARGS before the picker even opened.)
    const accept = normalizePickerAcceptList(payload?.accept);
    if (accept === null) {
      return respondError(webview, 'nova:files:open', requestId, 'INVALID_ARGS',
        'accept must be an array of at most 20 MIME types and/or file extensions (e.g. ".json")');
    }
    try {
      const node = await window.SystemDialogs.open({
        title: typeof payload?.title === 'string' ? payload.title.slice(0, 100) : 'Choose a file',
        startPath: typeof payload?.startPath === 'string' && payload.startPath.length <= 4096
          ? payload.startPath
          : undefined,
        accept: accept || undefined,
        pathOnly: true,
      });
      if (!node) return respond(webview, 'nova:files:open', requestId, { cancelled: true });
      if (typeof node.path === 'string') {
        const file = await readPickedHostFile(node);
        return respond(webview, 'nova:files:open', requestId, { cancelled: false, file });
      }
      if (!resolveFile({ id: node.id }, app.id)) {
        return respondError(webview, 'nova:files:open', requestId, 'PERMISSION_DENIED', 'Selected file is outside this app\'s accessible files');
      }
      const content = node.content;
      if (typeof content !== 'string') {
        return respondError(webview, 'nova:files:open', requestId, 'UNSUPPORTED_TYPE', 'Selected file is not available as text');
      }
      const size = new TextEncoder().encode(content).byteLength;
      if (size > 10_000_000) {
        return respondError(webview, 'nova:files:open', requestId, 'FILE_TOO_LARGE', 'Selected files are limited to 10 MB');
      }
      if (!(sandbox.pickedFileIds instanceof Set)) sandbox.pickedFileIds = new Set();
      sandbox.pickedFileIds.add(node.id);
      return respond(webview, 'nova:files:open', requestId, {
        cancelled: false,
        file: {
          id: node.id,
          name: node.name,
          path: FS.getPath(node.id),
          mimeType: node.mimeType || 'text/plain',
          size,
          content,
        },
      });
    } catch (error) {
      return respondError(webview, 'nova:files:open', requestId, 'PICKER_ERROR', error?.message || 'Could not open the selected file');
    }
  }

  async function handleScopedFileSave({ payload, requestId, app, webview }) {
    if (typeof window.SystemDialogs?.save !== 'function' || typeof FS?.createFile !== 'function') {
      return respondError(webview, 'nova:files:save', requestId, 'UNAVAILABLE', 'File picker is not available');
    }
    if (typeof payload?.content !== 'string') {
      return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', 'content must be a string up to 10 MB');
    }
    let saveData;
    try {
      saveData = normalizeFsSavePayload(payload, payload.filename);
    } catch (error) {
      return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', error?.message || 'Invalid file content');
    }
    const size = new TextEncoder().encode(saveData.content).byteLength;
    if (size > 10_000_000) {
      return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', 'content must be a string up to 10 MB');
    }
    const suggestedName = typeof payload.filename === 'string' ? payload.filename.slice(0, 255) : '';
    try {
      const picked = await window.SystemDialogs.save({
        title: typeof payload.title === 'string' ? payload.title.slice(0, 100) : 'Save file',
        suggestedName,
        startPath: typeof payload.startPath === 'string' && payload.startPath.length <= 4096
          ? payload.startPath
          : undefined,
      });
      if (!picked) return respond(webview, 'nova:files:save', requestId, { cancelled: true });
      if (typeof picked.path === 'string') {
        const file = await writePickedHostFile(picked, payload, app, hasFsAccess(app.id));
        if (!file) return respond(webview, 'nova:files:save', requestId, { cancelled: true });
        return respond(webview, 'nova:files:save', requestId, { cancelled: false, file });
      }
      if (!canPickerAccess(FS.files.get(picked.folderId), app.id, {
        writable: true, sharedWrite: true, allowContainerNavigation: false,
      })) {
        return respondError(webview, 'nova:files:save', requestId, 'PERMISSION_DENIED', 'Selected folder is outside the accessible files');
      }
      const existing = FS.listDir(picked.folderId).find(node =>
        node.type === 'file' && node.name === picked.name
      );
      if (existing && !canPickerAccess(existing, app.id, { writable: true, sharedWrite: true })) {
        return respondError(webview, 'nova:files:save', requestId, 'PERMISSION_DENIED', 'Selected file is outside the accessible files');
      }
      if (existing) {
        const confirmed = confirmSharedFileChange(app, existing, 'overwrite');
        if (confirmed === null) {
          return respondError(webview, 'nova:files:save', requestId, 'UNAVAILABLE', 'User confirmation is required to overwrite a shared file');
        }
        if (!confirmed) return respond(webview, 'nova:files:save', requestId, { cancelled: true });
      }
      const finalSaveData = normalizeFsSavePayload(payload, picked.name);
      const finalSize = new TextEncoder().encode(finalSaveData.content).byteLength;
      if (finalSize > 10_000_000) {
        return respondError(webview, 'nova:files:save', requestId, 'INVALID_ARGS', 'content must be a string up to 10 MB');
      }
      const saved = existing
        ? await FS.writeFile(existing.id, finalSaveData.content, finalSaveData.mimeType)
        : await FS.createFile(picked.folderId, picked.name, finalSaveData.content, finalSaveData.mimeType);
      if (!saved) throw new Error('Could not save the selected file');
      return respond(webview, 'nova:files:save', requestId, {
        cancelled: false,
        file: { name: saved.name, path: FS.getPath(saved.id), mimeType: saved.mimeType || finalSaveData.mimeType, size: finalSize },
      });
    } catch (error) {
      return respondError(webview, 'nova:files:save', requestId, 'PICKER_ERROR', error?.message || 'Could not save the selected file');
    }
  }

  // Audit: eval
  //
  // Sent by the capability shim whenever an app calls eval(). Historically
  // this only logged, since the CSP allowed 'unsafe-eval' by design — but
  // 'unsafe-eval' has since been removed from RELAXED_CSP_META (see that
  // constant below), so the browser now blocks eval()/new Function() before
  // this handler would ever fire from a real call. This audit path is kept
  // for observability/back-compat only; it does not mean eval is permitted.
  // The shim uses fire-and-forget for this so it doesn't wait on a response,
  // but we send one anyway so any caller using the regular ipc() path
  // (rather than ipcFireAndForget) gets an ack instead of timing out after
  // 30 seconds.

  async function handleAuditEval({ app, payload, requestId, webview }) {
    const appName = app?.name || app?.id || 'unknown';
    const appId = app?.id || 'unknown';
    log('warn', `${appName} called eval():`, payload?.preview);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({
        app: 'AppSandbox',
        category: 'security',
        severity: 'warn',
        message: `${appName} called eval()`,
        data: { appId, preview: payload?.preview },
      });
    }
    return respond(webview, 'nova:audit:eval', requestId, { success: true });
  }

  // Handler table
  //
  // Maps API type strings to their handler functions. Using a table instead
  // of a long if/else chain makes the dispatch O(1) and lets new APIs be
  // added by appending a single entry.

  // These implementations are host-only Settings/Clock functionality, not
  // capabilities for arbitrary package code. Keep them out of the generic
  // guest handler table and explicitly reject them at dispatch time so an
  // accidental future registration cannot silently expose system-wide state.
  const GUEST_FORBIDDEN_IPC_APIS = new Set([
    'nova:system:permissions:list', 'nova:system:permissions:set', 'nova:system:permissions:reset',
    'nova:system:data:backup', 'nova:system:data:restore', 'nova:system:dialog',
    'nova:system:developer-mode:confirm', 'nova:system:boot-recovery', 'nova:system:data:clear',
    'nova:system:default-apps:get', 'nova:system:default-apps:choose', 'nova:system:default-apps:set',
    'nova:system:storage:estimate',
    'nova:system:admin-mode:get', 'nova:system:admin-mode:set',
    'nova:system:preferences:get', 'nova:system:preferences:set',
    'nova:clock:state:get', 'nova:clock:state:persist', 'nova:clock:alarms:get',
    'nova:clock:alarms:set', 'nova:clock:alarm:dialog', 'nova:clock:timer:set-preset',
    'nova:clock:timer:start', 'nova:clock:timer:pause', 'nova:clock:timer:restart',
    'nova:clock:timer:reset', 'nova:clock:stopwatch:start', 'nova:clock:stopwatch:pause',
    'nova:clock:stopwatch:reset', 'nova:clock:stopwatch:lap',
    // Session machinery is host-only, exactly like nova:admin — no app may
    // drive login/logout/switch/reverify. Host code calls the SessionManager
    // service directly (trusted OS page realm), never this IPC bridge.
    'nova:auth:login', 'nova:auth:logout', 'nova:auth:lock', 'nova:auth:unlock',
    'nova:auth:reverify', 'nova:auth:switch', 'nova:auth:suspend',
    'nova:auth:resume', 'nova:auth:setup',
  ]);

  const API_HANDLERS = {
    'nova:nested-webview': handleNestedWebview,
    'nova:context-menu:show': handleContextMenuShow,
    'nova:context-menu:hide': handleContextMenuHide,
    'nova:overlay:show': handleOverlayShow,
    'nova:overlay:hide': handleOverlayHide,
    'nova:files:open': handleScopedFileOpen,
    'nova:files:save': handleScopedFileSave,
    'nova:share': handleShare,
    'nova:appearance:get': handleAppearanceGet,
    'nova:appearance:set': handleAppearanceSet,
    'nova:appearance:subscribe': handleAppearanceSubscribe,
    'nova:appearance:unsubscribe': handleAppearanceUnsubscribe,
    'nova:fs:read': handleFsRead,
    'nova:fs:write': handleFsWrite,
    'nova:fs:watch': handleFsWatch,
    'nova:fs:unwatch': handleFsUnwatch,
    'nova:alarms:create': handleAlarmsCreate,
    'nova:alarms:clear': handleAlarmsClear,
    'nova:alarms:getAll': handleAlarmsGetAll,
    'nova:push:register': handlePushRegister,
    'nova:push:unregister': handlePushUnregister,
    'nova:secrets:set': handleSecretsSet,
    'nova:secrets:get': handleSecretsGet,
    'nova:secrets:delete': handleSecretsDelete,
    'nova:secrets:keys': handleSecretsKeys,
    'nova:fs:delete': handleFsDelete,
    'nova:fs:list': handleFsList,
    'nova:media:query': handleMediaQuery,
    'nova:fs:mkdir': handleFsMkdir,
    'nova:fs:stat': handleFsStat,
    'nova:fs:rename': handleFsRename,
    'nova:fs:move': handleFsMove,
    'nova:notifications:show': handleNotificationsShow,
    'nova:notifications:clear': handleNotificationsClear,
    'nova:notifications:post': handleNotificationsPost,
    'nova:notifications:createChannel': handleNotificationsCreateChannel,
    'nova:notifications:cancel': handleNotificationsCancel,
    'nova:notifications:cancelAll': handleNotificationsCancelAll,
    'nova:notifications:consumeActions': handleNotificationsConsumeActions,
    'nova:settings:get': handleSettingsGet,
    'nova:settings:set': handleSettingsSet,
    'nova:wallpaper:set': handleWallpaperSet,
    'nova:reg:get': handleRegGet,
    'nova:reg:set': handleRegSet,
    'nova:reg:delete': handleRegDelete,
    'nova:reg:list': handleRegList,
    'nova:reg:export': handleRegExport,
    'nova:reg:import': handleRegImport,
    'nova:request-permission': handleRequestPermission,
    'nova:permission-rate-limited': handlePermissionRateLimited,
    'nova:window:close': handleWindowClose,
    'nova:window:minimize': handleWindowMinimize,
    'nova:window:maximize': handleWindowMaximize,
    'nova:window:setTitle': handleWindowSetTitle,
    'nova:window:resize': handleWindowResize,
    'nova:window:getState': handleWindowGetState,
    'nova:clipboard:read': handleClipboardRead,
    'nova:clipboard:write': handleClipboardWrite,
    'nova:app:launch': handleAppLaunch,
    'nova:ipc:register': handleAppIpcRegister,
    'nova:ipc:unregister': handleAppIpcUnregister,
    'nova:ipc:invoke': handleAppIpcInvoke,
    'nova:ipc:reply': handleAppIpcReply,
    'nova:ipc:broadcast:subscribe': handleAppIpcBroadcastSubscribe,
    'nova:ipc:broadcast:unsubscribe': handleAppIpcBroadcastUnsubscribe,
    'nova:ipc:broadcast': handleAppIpcBroadcast,
    'nova:email:open-link': handleEmailOpenLink,
    'nova:open-url': handleOpenUrl,
    'nova:open-with': handleOpenWith,
    'nova:app:openDefaultAppsSettings': handleOpenDefaultAppsSettings,
    'nova:home:openDefaultAppsSettings': handleHomeOpenDefaultAppsSettings,
    'nova:home:apps:list': handleHomeAppsList,
    'nova:home:apps:launch': handleHomeAppsLaunch,
    'nova:app:info': handleAppInfo,
    'nova:app:list': handleAppList,
    'nova:app:install': handleAppInstall,
    'nova:app:uninstall': handleAppUninstall,
    'nova:admin:audit': handleAdminAudit,
    'nova:admin:system': handleAdminSystem,
    'nova:admin:users': handleAdminUsers,
    'nova:admin:apps': handleAdminApps,
    'nova:mail:read': handleMailRead,
    'nova:mail:write': handleMailWrite,
    'nova:mail:session': handleMailSession,
    'nova:mail:send': handleMailSend,
    'nova:mail:delete': handleMailDelete,
    'nova:events:subscribe': handleEventsSubscribe,
    'nova:events:unsubscribe': handleEventsUnsubscribe,
    'nova:background:wake-done': handleBackgroundWakeDone,
    'nova:background:stay-alive': handleBackgroundStayAlive,
    'nova:net:fetch': handleNetFetch,
    'nova:net:websocket': handleNetWebsocket,
    'nova:net:ws:send': handleNetWsSend,
    'nova:net:ws:close': handleNetWsClose,
    'nova:storage:get': handleStorageGet,
    'nova:storage:set': handleStorageSet,
    'nova:storage:delete': handleStorageDelete,
    'nova:storage:clear': handleStorageClear,
    'nova:storage:keys': handleStorageKeys,
    'nova:storage:usage': handleStorageUsage,
    'nova:data:export': handleDataExport,
    'nova:data:import': handleDataImport,
    'nova:data:backup': handleDataBackup,
    'nova:data:restore': handleDataRestore,
    'nova:device:geolocation': handleDeviceGeolocation,
    'nova:device:camera': handleDeviceCamera,
    'nova:device:microphone': handleDeviceMicrophone,
    'nova:calendar:read': handleCalendarRead,
    'nova:calendar:write': handleCalendarWrite,
    'nova:calendar:delete': handleCalendarDelete,
    'nova:contacts:read': handleContactsRead,
    'nova:contacts:write': handleContactsWrite,
    'nova:contacts:delete': handleContactsDelete,
    'nova:system:info': handleSystemInfo,
    'nova:locale:get': handleLocaleGet,
    'nova:badge:set': handleBadgeSet,
    'nova:badge:clear': handleBadgeClear,
    'nova:ready': handleReady,
    'nova:dialog:open': handleDialogOpen,
    'nova:dialog:save': handleDialogSave,
    'nova:sysdialog:open': handleSysDialogOpen,
    'nova:sysdialog:save': handleSysDialogSave,
    'nova:audit:eval': handleAuditEval,
    'nova:download': handleDownload,
  };

  const ISOLATED_PROCESS_API_TYPES = new Set([
    'nova:ready', 'nova:app:info',
    'nova:fs:read', 'nova:fs:write', 'nova:fs:delete', 'nova:fs:list',
    'nova:media:query',
    'nova:fs:mkdir', 'nova:fs:stat', 'nova:fs:rename', 'nova:fs:move',
    'nova:fs:watch', 'nova:fs:unwatch',
    'nova:alarms:create', 'nova:alarms:clear', 'nova:alarms:getAll',
    'nova:secrets:set', 'nova:secrets:get', 'nova:secrets:delete', 'nova:secrets:keys',
    'nova:storage:get', 'nova:storage:set', 'nova:storage:delete',
    'nova:storage:clear', 'nova:storage:keys', 'nova:storage:usage',
    'nova:data:export', 'nova:data:import', 'nova:data:backup', 'nova:data:restore',
    'nova:settings:get', 'nova:settings:set',
    'nova:appearance:get', 'nova:appearance:set',
    'nova:notifications:show', 'nova:notifications:clear',
    'nova:notifications:post', 'nova:notifications:createChannel',
    'nova:notifications:cancel', 'nova:notifications:cancelAll',
    'nova:notifications:consumeActions',
    'nova:request-permission',
    'nova:clipboard:read', 'nova:clipboard:write',
    'nova:net:fetch',
    'nova:mail:read', 'nova:mail:write', 'nova:mail:session',
    'nova:mail:send', 'nova:mail:delete',
    'nova:calendar:read', 'nova:calendar:write', 'nova:calendar:delete',
    'nova:contacts:read', 'nova:contacts:write', 'nova:contacts:delete',
    'nova:locale:get', 'nova:badge:set', 'nova:badge:clear',
  ]);

  // ---------------------------------------------------------------------------
  // Legacy VFS channel compat (translate-then-enforce).
  //
  // The pre-scoped-storage era exposed the filesystem as nova:vfs:* channels
  // (read/write/delete/list/mkdir/stat/rename/move) backed by vfs:* permission
  // names. Both families were renamed in the fs:* era, so old apps have been
  // failing with UNKNOWN_API (channels) or silently stripped permissions
  // (manifests) ever since. Instead of leaving those apps broken, legacy
  // channel names are translated to their modern counterparts at the IPC
  // front door — BEFORE handler lookup and the MAC policy check — so a legacy
  // call takes exactly the same enforcement path (MAC front door, per-path
  // scoped-storage rules, handler checks) as if the app had dialed the modern
  // channel. There is no alias bypass: translating first is the whole design.
  //
  // Mappings mirror the historical handler table one-for-one (the payload and
  // response shapes of nova:fs:* are backward-compatible with nova:vfs:* —
  // same path/content/stat fields; the modern handlers only ADD fields):
  //   nova:vfs:read → nova:fs:read      nova:vfs:write → nova:fs:write
  //   nova:vfs:delete → nova:fs:delete  nova:vfs:list → nova:fs:list
  //   nova:vfs:mkdir → nova:fs:mkdir    nova:vfs:stat → nova:fs:stat
  //   nova:vfs:rename → nova:fs:rename  nova:vfs:move → nova:fs:move
  // plus the bare vfs:* spellings, and the metadata variants (vfs:metadata
  // was the legacy permission NAME; as a channel intent it maps to the
  // metadata channel nova:fs:stat — the typo'd 'metedata' spelling is
  // aliased too as free insurance: it is not a verified historical channel
  // name, but aliasing it costs two map entries and a package that ever
  // shipped the typo keeps working). There is deliberately NO vfs:access channel
  // alias: vfs:access was only ever a permission, never a channel (it got
  // UNKNOWN_API in the old era as well); AppRegistry translates it to
  // fs:access on the permission side instead (see LEGACY_PERMISSION_ALIASES
  // in app-registry.js).
  //
  // Response transparency note: handlers respond with their own frozen
  // modern type strings (respond(…, 'nova:fs:read', …)), so a legacy caller's
  // response carries type "nova:fs:read", not "nova:vfs:read". That is safe
  // by construction — the guest shim matches responses to callers by
  // requestId, never by type (see buildCapabilityShim), and error envelopes
  // keep the code/message shape legacy apps already read. Documented in
  // NOVAAPP.md ("Legacy vfs compatibility").
  const LEGACY_VFS_CHANNEL_ALIASES = Object.freeze({
    // Historical channel names (nova-prefixed).
    'nova:vfs:read': 'nova:fs:read',
    'nova:vfs:write': 'nova:fs:write',
    'nova:vfs:delete': 'nova:fs:delete',
    'nova:vfs:list': 'nova:fs:list',
    'nova:vfs:mkdir': 'nova:fs:mkdir',
    'nova:vfs:stat': 'nova:fs:stat',
    'nova:vfs:rename': 'nova:fs:rename',
    'nova:vfs:move': 'nova:fs:move',
    // Bare spellings (no nova: prefix) — accepted for the same reason.
    'vfs:read': 'nova:fs:read',
    'vfs:write': 'nova:fs:write',
    'vfs:delete': 'nova:fs:delete',
    'vfs:list': 'nova:fs:list',
    'vfs:mkdir': 'nova:fs:mkdir',
    'vfs:stat': 'nova:fs:stat',
    'vfs:rename': 'nova:fs:rename',
    'vfs:move': 'nova:fs:move',
    // Metadata spellings → the metadata channel.
    'vfs:metadata': 'nova:fs:stat',
    'vfs:metedata': 'nova:fs:stat',
    'nova:vfs:metadata': 'nova:fs:stat',
    'nova:vfs:metedata': 'nova:fs:stat',
  });

  // Resolve a legacy channel name to its modern counterpart. Non-legacy
  // names (including every modern one) pass through unchanged, so the
  // resolution is idempotent and safe to apply at every entry point.
  function resolveLegacyIpcType(type) {
    return Object.prototype.hasOwnProperty.call(LEGACY_VFS_CHANNEL_ALIASES, type)
      ? LEGACY_VFS_CHANNEL_ALIASES[type]
      : type;
  }

  // Dispatch an incoming IPC message to its handler. Catches sync throws and
  // async rejections so a single misbehaving handler can't take down the
  // bridge. Unknown types get an UNKNOWN_API error response.
  async function handleAPICall(rawType, payload, requestId, app, webview, sandbox) {
    // Legacy vfs:* channels resolve to their modern nova:fs:* counterparts
    // before the forbidden-API gate, handler lookup, and the MAC front door
    // (translate-then-enforce — see LEGACY_VFS_CHANNEL_ALIASES above). All
    // enforcement below therefore sees the modern name and applies the
    // identical rules a modern call would get.
    const type = resolveLegacyIpcType(rawType);
    try {
      if (GUEST_FORBIDDEN_IPC_APIS.has(type)) {
        return respondError(webview, type, requestId, 'PERMISSION_DENIED', 'This system capability is only available through trusted OS UI');
      }
      const handler = API_HANDLERS[type];
      if (!handler) {
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }
      // MAC front door (NB-MAC): mandatory access control before any handler
      // code runs. Denials keep the PERMISSION_DENIED code handlers would
      // produce, so app-visible behavior is unchanged for seeded rules; the
      // denial is avc-audited in MacPolicy. Permissive domains are audited
      // as would-be denials and passed through to the handler as today.
      const macVerdict = MacPolicy.checkIpc(app && app.id, type);
      if (!macVerdict.allowed) {
        const required = macVerdict.rule && macVerdict.rule.length
          ? `requires ${macVerdict.rule.join(' | ')}`
          : 'no policy rule for this endpoint';
        return respondError(webview, type, requestId, 'PERMISSION_DENIED',
          `Blocked by system security policy (MAC): ${required}`);
      }
      await handler({ payload, requestId, app, webview, sandbox });
    } catch (err) {
      // Error.isError (ES2026) is the cross-realm-safe check; fall back to
      // instanceof for older runtimes. Either way, extract a real message
      // string for both the log and the guest-side error response.
      const isError = typeof Error.isError === 'function' ? Error.isError(err) : err instanceof Error;
      const msg = isError ? err.message : String(err);
      log('error', `Error handling ${type}:`, err);
      // Guard against a webview that's been destroyed between the call
      // arriving and an async handler throwing — respond would log a
      // spurious error on top of the real one.
      if (webview && typeof webview.executeScript === 'function') {
        respondError(webview, type, requestId, 'INTERNAL_ERROR', msg || 'Internal error');
      } else if (typeof webview?.__directResponder === 'function') {
        respondError(webview, type, requestId, 'INTERNAL_ERROR', msg || 'Internal error');
      }
    }
  }

  async function dispatchIsolatedProcessRequest({ appId, type, payload, requestId }) {
    if (typeof appId !== 'string' || !appId || typeof type !== 'string' ||
        typeof requestId !== 'string' || !requestId) {
      throw new TypeError('A valid app ID, API type, and request ID are required');
    }
    // Same translate-then-enforce rule as the sandboxed bridge: legacy
    // vfs:* names resolve before the isolated-process allowlist check, so
    // an old app's call gets the identical gate the modern channel gets.
    // The UNAVAILABLE envelope below still echoes the caller's original
    // type, and handleAPICall re-resolves (idempotently) on the way in.
    const resolvedType = resolveLegacyIpcType(type);
    if (!ISOLATED_PROCESS_API_TYPES.has(resolvedType)) {
      return {
        type: `${type}:response`,
        requestId,
        result: null,
        error: { code: 'UNAVAILABLE', message: 'This API is not available to isolated processes' },
      };
    }

    const app = typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId) : null;
    if (!app || app.id !== appId || app.revoked || app.tampered) {
      return {
        type: `${type}:response`,
        requestId,
        result: null,
        error: { code: 'APP_UNAVAILABLE', message: 'The installed app is unavailable or revoked' },
      };
    }

    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          type: `${type}:response`,
          requestId,
          result: null,
          error: { code: 'TIMEOUT', message: 'The OS API request timed out' },
        });
      }, 30_000);
      const webview = {
        __directResponder(message) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(message);
        },
      };
      const sandbox = {
        appId: app.id,
        webview,
        iframe: webview,
        state: null,
        windowId: null,
        wsConnections: new Map(),
        appIpcEndpoints: new Set(),
        ipcBroadcastActions: new Set(),
        openFile: null,
        homeSurface: false,
      };
      void handleAPICall(type, payload, requestId, app, webview, sandbox);
    });
  }

  // API bridge setup

  // Marker prefix for guest->host IPC messages sent over console.log. Kept
  // deliberately weird/specific so an ordinary page's own console output
  // (or a malicious app trying to guess it) can't accidentally collide.
  // This is the same mechanism NB Browser already uses for its right-click
  // context menu (see browser.js's _CTX_MARKER + 'consolemessage' listener)
  // — a real, confirmed-working <webview> DOM event for guest->host data on
  // this exact NW.js build, unlike window.parent.postMessage which never
  // reaches the host at all (window.parent === window for a <webview>
  // guest; there is no cross-process parent reference to send to).
  const IPC_MARKER = '__NOVA_IPC__:';

  // Wire up the API bridge for a sandbox.
  //
  // Guest -> host: the guest's shim calls console.log(IPC_MARKER + JSON)
  // instead of window.parent.postMessage. The host listens on the
  // webview's own 'consolemessage' DOM event (fired for every console.*
  // call inside that specific guest — this is scoped per-webview-element,
  // not a global listener, so there's no cross-app source-pinning problem
  // to solve at all: only messages from *this* webview ever reach this
  // handler).
  //
  // Host -> guest: unchanged in shape, still via webview.executeScript
  // (see respond()), since that direction already works.
  //
  // Every message off the wire is treated as untrusted input from
  // app-controlled content and validated before it's allowed to reach
  // handleAPICall:
  //   - must parse as JSON matching the exact expected shape
  //   - `type` must be an exact, known key in API_HANDLERS (an allowlist,
  //     not just "starts with the right prefix" — a made-up type is
  //     rejected outright rather than silently reaching a handler)
  //   - `requestId` must be a non-empty string
  //   - payload validation is then left to each individual handler
  //
  // setupAPIBridge returns an array of teardown steps that createSandbox
  // collects alongside the other setup functions. destroy() runs them all.
  function setupAPIBridge(webview, app, sandboxId, sandboxRecord) {
    const teardown = [];

    const consoleHandler = (event) => {
      const msg = event?.message;
      if (typeof msg !== 'string' || !msg.startsWith(IPC_MARKER)) return;

      let data;
      try {
        data = JSON.parse(msg.slice(IPC_MARKER.length));
      } catch {
        return; // malformed payload — drop silently, nothing to act on
      }
      if (!data || typeof data !== 'object') return;

      // Note: only {type, requestId} travel over the visible console
      // channel now. The actual payload (which may contain secrets — API
      // keys, auth headers, file bytes) never does; it's pulled back out
      // of the guest's in-memory stash via executeScript below, a
      // host-initiated read that doesn't land in the visible log stream
      // the way console.log broadcasts do.
      const { type, requestId } = data;
      // requestId must be validated BEFORE the type check can answer: an
      // unknown type is answered with UNKNOWN_API, and a response needs a
      // routable requestId to land on. A typeless or id-less message can't
      // be answered at all — dropped as before.
      if (typeof type !== 'string' || !type) return;
      if (typeof requestId !== 'string' || !requestId) return;
      // Legacy vfs:* channel names must resolve BEFORE this membership
      // check, or old apps would be answered UNKNOWN_API right here and
      // never reach handleAPICall's translate-then-enforce path. The
      // UNKNOWN_API answer below still echoes the name the app actually
      // sent, and handleAPICall re-resolves (idempotently) on the way in.
      const resolvedType = resolveLegacyIpcType(type);
      if (!Object.prototype.hasOwnProperty.call(API_HANDLERS, resolvedType) && !GUEST_FORBIDDEN_IPC_APIS.has(resolvedType)) {
        // Unknown endpoint (e.g. a typo'd channel name). Historically this
        // was dropped silently, which left the guest's pending ipc() promise
        // hanging until the bridge timeout — a 30s wait ending in a generic
        // TypeError with no error code. The documented contract (NOVAAPP.md
        // error-code table) says a typo rejects with UNKNOWN_API, so answer
        // it: the guest gets an immediate, code-carrying rejection while the
        // unknown type still never reaches a handler.
        log('warn', `Rejected IPC message with unknown type from ${app?.id || 'unknown app'}: ${type}`);
        return respondError(webview, type, requestId, 'UNKNOWN_API', `Unknown API: ${type}`);
      }

      // Deliberately NOT { mainWorld: true } — window.__novaOutboxPull now
      // lives inside the isolated-world transport script (see
      // buildIsolatedTransportScript), which is also the only realm that
      // could have produced this console.log message in the first place
      // (the guest's own main-world code never touches console.log or
      // __novaOutboxPull directly anymore). executeScript's default
      // (isolated world) is what reaches it.
      const idLiteral = JSON.stringify(requestId);
      // Bail out early if the sandbox has already been destroyed between
      // the consolemessage firing and this host-initiated read landing.
      // Without this guard, handleAPICall would run against a stale
      // webview reference and produce confusing log noise rather than
      // silently dropping the orphaned call.
      if (!activeSandboxes.has(sandboxId)) return;
      webview.executeScript({
        code: `(function(){ var m = window.__novaOutboxPull || {}; var p = m[${idLiteral}]; delete m[${idLiteral}]; return JSON.stringify(p === undefined ? null : p); })()`,
      }, (results) => {
        // Second guard: the executeScript callback is async and may fire
        // after destroy() has torn this sandbox down.
        if (!activeSandboxes.has(sandboxId)) return;
        let payload = null;
        try {
          const raw = Array.isArray(results) ? results[0] : results;
          payload = raw ? JSON.parse(raw) : null;
        } catch (e) {
          log('warn', `Failed to retrieve IPC payload for ${type} from ${app?.id || 'unknown app'}: ${e?.message || e}`);
          return;
        }
        const sandbox = activeSandboxes.get(sandboxId);
        handleAPICall(type, payload, requestId, app, webview, sandbox);
      });
    };

    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      // Detach OS event subscriptions.
      const subs = eventSubscriptions.get(sandboxId);
      if (subs) {
        for (const [eventName, handler] of subs) {
          try { OS?.events?.off(eventName, handler); } catch { /* best-effort */ }
        }
        subs.clear();
      }
      eventSubscriptions.delete(sandboxId);

      // Close any lingering WebSockets so they don't outlive the sandbox.
      // Use the captured record: destroy() deliberately removes its registry
      // entry before calling cleanup to prevent re-entrant double teardown.
      if (sandboxRecord?.wsConnections) {
        for (const [, wsState] of sandboxRecord.wsConnections) {
          try { wsState.ws.close(1000, 'sandbox closed'); } catch { /* already closed */ }
        }
        sandboxRecord.wsConnections.clear();
      }

      // Close any open file dialog so the overlay doesn't linger in the DOM,
      // and restore any other apps' webviews it had hidden to render above
      // them (see showFileDialog's restoreWebviews).
      const dialog = openDialogs.get(sandboxId);
      if (dialog) {
        dialog.overlay.remove();
        dialog.restore?.();
        openDialogs.delete(sandboxId);
      }
      for (const cancelShare of shareDialogs.get(sandboxId) || []) cancelShare();
      shareDialogs.delete(sandboxId);

      // Run the collected teardown steps (listeners removed above).
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'teardown step threw', e); }
      }
    };
  }

  // Error handling

  function setupErrorHandling(webview, app) {
    const teardown = [];

    // loadabort fires when webview navigation is cancelled (network error,
    // blocked URL, etc.). Surface it so we can see why apps fail to load.
    const loadAbortHandler = (event) => {
      log('error', `Load aborted in ${app.name}:`, event.reason);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Load aborted in ${app.name}: ${event.reason}`, data: { appId: app.id } });
      }
    };
    webview.addEventListener('loadabort', loadAbortHandler);
    teardown.push(() => webview.removeEventListener('loadabort', loadAbortHandler));

    // consolemessage proxies console output from the webview's separate
    // renderer process. We can't attach to contentWindow directly due to
    // process isolation, so this is the only surface for runtime visibility.
    const consoleHandler = (event) => {
      // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error.
      if (event.level >= 2) {
        const level = event.level >= 3 ? 'error' : 'warn';
        log(level, `${app.name}:`, event.message,
          event.sourceId ? `(${event.sourceId}:${event.line})` : '');
      }
    };
    webview.addEventListener('consolemessage', consoleHandler);
    teardown.push(() => webview.removeEventListener('consolemessage', consoleHandler));

    return () => {
      for (const fn of teardown) {
        try { fn(); } catch (e) { log('debug', 'error-handling teardown step threw', e); }
      }
    };
  }

  // Permission request gate (webview-level device permissions)
  //
  // Gate webview-level permission requests (geolocation, media) against
  // AppPermissionManager. The sandboxed webview's permissionrequest event is
  // the only enforcement surface for these device features at the
  // renderer-process boundary. Unrecognised permissions are denied by
  // default — fail-closed is the safe choice.
  function setupPermissionRequestGate(webview, app) {
    // NW.js/Chromium can surface the same underlying permission request more
    // than once. Calling allow()/deny() twice on that request throws
    // `Permission has already been decided`. WeakSet keeps this one-shot
    // without retaining request objects after Chromium releases them.
    const decidedRequests = new WeakSet();

    const decide = (e, allowed) => {
      const request = e?.request;
      if (!request || (typeof request.allow !== 'function' && typeof request.deny !== 'function')) return;
      if (decidedRequests.has(request)) return;
      decidedRequests.add(request);
      try {
        if (allowed && typeof request.allow === 'function') request.allow();
        else if (!allowed && typeof request.deny === 'function') request.deny();
      } catch (err) {
        // Chromium may auto-resolve a request between the guard and the call.
        // That is harmless; don't turn it into an uncaught app error.
        log('debug', `Permission request for ${app?.id || 'unknown app'} was already decided`, err?.message || err);
      }
    };

    const handler = (e) => {
      if (!e?.request || decidedRequests.has(e.request)) return;
      if (e.permission === 'fullscreen' || e.permission === 'pointerLock') {
        // These capabilities are not granted automatically to sandboxed apps.
        decide(e, false);
        return;
      }
      if (e.permission === 'geolocation') {
        if (AppPermissionManager?.isGranted('device:geolocation', app.id)) {
          decide(e, true);
        } else {
          decide(e, false);
        }
        return;
      }
      if (e.permission === 'media') {
        // Chromium's MediaPermissionRequest carries no audio/video sub-type
        // (confirmed against the chrome.webviewTag reference — it's just
        // { url, allow, deny }), so this layer can't tell a camera-only
        // getUserMedia({video:true}) call apart from a mic-only or
        // combined one. Requiring BOTH device:camera AND device:microphone
        // would wrongly block an app that's only been granted (and only
        // asked for) one of the two. Allowing on EITHER being granted is
        // the correct trade-off here: the actual audio/video split is
        // still enforced by whatever constraints the guest's own
        // getUserMedia() call passes — this gate only decides whether the
        // app may use the media permission surface at all.
        const camOk = AppPermissionManager?.isGranted('device:camera', app.id);
        const micOk = AppPermissionManager?.isGranted('device:microphone', app.id);
        if (camOk || micOk) {
          decide(e, true);
        } else {
          decide(e, false);
        }
        return;
      }
      // Default-deny any permission we don't explicitly handle. The previous
      // implementation left these to the webview's default, which is
      // non-portable and can silently allow access.
      decide(e, false);
    };
    webview.addEventListener('permissionrequest', handler);
    return () => webview.removeEventListener('permissionrequest', handler);
  }

  // Capability shim
  //
  // Injected as the first <script> in every packaged app's HTML. Overrides
  // fetch / XHR / eval / sendBeacon so apps that use standard web APIs work
  // transparently — all network goes through the IPC bridge where
  // permissions are enforced. connect-src 'none' in the served CSP ensures
  // nothing bypasses this at the browser level.
  //
  // The shim also exposes window.nova for apps that want to call the IPC
  // bridge directly (e.g. to request permissions or subscribe to events).

  // A package may opt in to mediated nested webviews with allowNestedWebview
  // or by declaring sandbox:nested-webview. The API can then be exposed
  // before consent so apps can request the grant at runtime; every host
  // operation still checks the active user-controlled grant.
  function isNestedWebviewOptedIn(app) {
    if (!app) return false;
    const declaredPermissions = [
      ...(Array.isArray(app.permissions) ? app.permissions : []),
      ...(Array.isArray(app.manifest?.permissions) ? app.manifest.permissions : []),
    ];
    return app.allowNestedWebview === true
      || app.manifest?.allowNestedWebview === true
      || declaredPermissions.includes('sandbox:nested-webview');
  }

  // Sandbox popups that escape the app sandbox use the same double gate as
  // allowSameOrigin (manifest opt-in AND a separate user grant), but the
  // manifest opt-in is a TOP-LEVEL allowPopupsToEscapeSandbox field — the
  // same location as allowNestedWebview, which is how NOVAAPP.md and the
  // studio permission picker both document it. Unlike nested-webview,
  // listing sandbox:escape-popups in `permissions` does NOT count as the
  // opt-in: the docs are explicit that the permission alone does nothing,
  // the boolean is the publisher's declaration that this app's popups are
  // meant to run unsandboxed.
  function isEscapePopupsOptedIn(app) {
    if (!app) return false;
    return app.allowPopupsToEscapeSandbox === true
      || app.manifest?.allowPopupsToEscapeSandbox === true;
  }

  function isNestedWebviewPermitted(app) {
    if (!isNestedWebviewOptedIn(app)) return false;
    try {
      return AppPermissionManager?.isGranted('sandbox:nested-webview', app.id) === true;
    } catch (_) {
      return false;
    }
  }

  function isExternalFramesPermitted(app) {
    return isNestedWebviewPermitted(app);
  }

  function canNestedWebviewNavigate(app, rawUrl) {
    const classified = resolveAndClassifyUrl(rawUrl);
    if (!classified.valid) return false;
    let url;
    try {
      url = new URL(classified.url);
    } catch {
      return false;
    }
    if (url.username || url.password) return false;
    const permission = classified.isInternal ? 'net:internal' : 'net:external';
    return typeof AppPermissionManager !== 'undefined'
      && AppPermissionManager?.isGranted(permission, app?.id) === true;
  }

  // Marker used ONLY on the one-shot handshake that hands a MessagePort
  // from the isolated transport script to the main-world capability shim.
  // Deliberately distinct from IPC_MARKER (the guest->host console.log
  // marker). Unlike the previous design, this marker does NOT authenticate
  // ongoing request/response traffic — see the handshake comment below for
  // why a tagged window.postMessage alone is forgeable by any main-world
  // script and can't be trusted for anything beyond the initial port handoff.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  // Cache for buildIsolatedTransportScript — the script is identical for
  // every sandbox, so build it once and reuse the string. Reset by tests
  // via _internal._resetState.
  let _isolatedTransportScriptCache = null;

  // Builds the isolated-world transport content script. This owns the
  // ONLY code path that can produce a valid guest->host IPC message
  // (console.log(IPC_MARKER + ...)) or read a host->guest response
  // (window.__novaInbox). It is injected via webview.addContentScripts()
  // at run_at: 'document_start', which — unlike a <script> spliced into
  // the guest's own HTML — runs in a separate JS realm (Chromium's
  // "isolated world", same mechanism as Chrome extension content
  // scripts) that the guest's own page script cannot reach, patch, or
  // race against. See JavaScript Contexts in NW.js docs: isolated and
  // main-world scripts share the DOM but not JS globals.
  //
  // Ongoing traffic with the main-world capability shim (buildCapabilityShim
  // below) goes over a dedicated MessageChannel, not tagged window.postMessage.
  // This is a deliberate correction: window.postMessage with a __novaBridge
  // tag authenticates "this arrived on this window" but NOT "this actually
  // came from the isolated script" — any main-world code (including an
  // attacker who achieved script execution in the guest's own page, e.g. via
  // an XSS bug in the app itself) can call
  // window.postMessage(sameShapeObject, ...) and a listener keyed only on the
  // tag has no way to tell the difference. Concretely, that let a compromised
  // guest forge a fake "response" for one of its OWN in-flight requestIds and
  // win the race against the real host response, corrupting whatever the
  // guest's own app code does with that result.
  //
  // A MessagePort is what authenticates a message now: holding a reference
  // to port2 is only possible for code that received it in the one-shot
  // handshake below, and the isolated script stops listening for further
  // handshake requests the instant one is claimed — so nothing that runs
  // afterward (including later-injected or dynamically-eval'd guest script)
  // can obtain a second reference to it. A message arriving on
  // `port1.onmessage` can only have been sent via `port2.postMessage`, so no
  // tag/marker is needed to trust port traffic — possession of the port is
  // the credential.
  //
  // This still closes what the window.postMessage version closed relative to
  // the original single-realm shim: (1) a guest page redefining console.log
  // before the shim's IIFE ran could previously blind or spoof the IPC
  // channel — that channel lives in a realm the guest's console.log override
  // never touches; (2) window.__novaInbox / window.__novaOutboxPull used to
  // be plain globals on the guest's own window — now they're closures inside
  // this isolated script, invisible to window.* lookups from the main world.
  // It additionally closes the response-forgery gap the tagged-postMessage
  // bridge itself introduced.
  function buildIsolatedTransportScript() {
    // Cached: the transport script is identical for every sandbox, so build
    // it once. The original code regenerated a multi-KB string template on
    // every launch — measurable on cold boot when several apps launch back
    // to back.
    if (_isolatedTransportScriptCache) return _isolatedTransportScriptCache;
    _isolatedTransportScriptCache = `(function() {
  'use strict';
  const IPC_MARKER = ${JSON.stringify(IPC_MARKER)};
  const BRIDGE_MARKER = ${JSON.stringify(BRIDGE_MARKER)};

  // The MessagePort this isolated script keeps for itself once the
  // handshake completes. port2 (the other end) is handed to the
  // main-world shim exactly once, below. Until the handshake fires,
  // outbound messages queue in pendingOutbound rather than being lost.
  let mainWorldPort = null;
  let pendingOutbound = [];

  function sendToMainWorld(msg) {
    if (mainWorldPort) {
      try { mainWorldPort.postMessage(msg); } catch (e) { /* torn-down guest window */ }
    } else {
      pendingOutbound.push(msg);
    }
  }

  // Host->guest responses land here, pushed to by respond() in
  // app-sandbox.js via executeScript targeting this isolated world
  // specifically (not mainWorld: true — see respond()'s comments).
  window.__novaInbox = window.__novaInbox || [];
  // Guest->host request payloads (may contain secrets) live here,
  // pulled by the host via a host-initiated executeScript read — never
  // broadcast, so never visible in the console stream. Same shape as
  // the pre-split design; only WHERE it lives has changed (isolated
  // world instead of the guest's own main-world window object).
  window.__novaOutboxPull = window.__novaOutboxPull || {};
  const pendingPayloads = window.__novaOutboxPull;

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'xport_' + window.crypto.randomUUID();
    }
    return 'xport_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Relay a request from the main-world shim out to the host. Only the
  // {type, requestId} pair ever appears in the visible console stream —
  // matches the guarantee the original single-realm shim made.
  function sendToHost(type, payload, requestId) {
    try {
      pendingPayloads[requestId] = payload;
      console.log(IPC_MARKER + JSON.stringify({ type: type, requestId: requestId }));
    } catch (e) {
      // Deliver a synthetic error back to the main world so its pending
      // promise doesn't hang forever if console.log itself throws.
      deliverToMainWorld({ kind: 'response', requestId: requestId,
        type: type + ':response', result: null, error: { code: 'TRANSPORT_ERROR', message: String((e && e.message) || e) } });
    }
  }

  // Forward a host response (or pushed event) to the main-world shim, over
  // the dedicated port rather than tagged window.postMessage — see the
  // module-level comment above buildIsolatedTransportScript for why.
  function deliverToMainWorld(msg) {
    sendToMainWorld(msg);
  }

  // Same idle-backoff poller design as the original shim, just relocated:
  // drains window.__novaInbox (host responses / pushed events) and
  // forwards each message to the main world over postMessage instead of
  // resolving a same-realm Promise map directly.
  const POLL_BASELINE_MS = 50;
  const POLL_IDLE_MS = 250;
  const POLL_IDLE_THRESHOLD = 20;
  let pollInterval = POLL_BASELINE_MS;
  let emptyPolls = 0;

  function drainInbox() {
    const inbox = window.__novaInbox;
    if (!inbox || !inbox.length) {
      emptyPolls++;
      if (emptyPolls > POLL_IDLE_THRESHOLD && pollInterval < POLL_IDLE_MS) pollInterval = POLL_IDLE_MS;
      return;
    }
    emptyPolls = 0;
    if (pollInterval !== POLL_BASELINE_MS) pollInterval = POLL_BASELINE_MS;

    const drained = inbox.splice(0, inbox.length);
    for (let i = 0; i < drained.length; i++) {
      const msg = drained[i];
      if (!msg || typeof msg.type !== 'string') continue;
      deliverToMainWorld(Object.assign({ kind: 'response' }, msg));
    }
  }

  function scheduleNextPoll() {
    setTimeout(function() { drainInbox(); scheduleNextPoll(); }, pollInterval);
  }
  scheduleNextPoll();

  // Requests arrive from the main-world shim over the dedicated port once
  // the handshake below completes.
  function handlePortMessage(event) {
    const data = event.data;
    if (!data || data.kind !== 'request') return;
    if (typeof data.type !== 'string' || typeof data.requestId !== 'string') return;
    sendToHost(data.type, data.payload, data.requestId);
  }

  // One-shot handshake: create a MessageChannel and hand port2 to the
  // main-world shim. This is the ONLY message this script ever sends via
  // window.postMessage — everything after this point goes over the port.
  //
  // handshakeClaimed makes the handoff strictly one-time: the instant a
  // valid claim request is processed, the listener stops accepting further
  // claims (even a same-tick duplicate call), so no later script — however
  // it got main-world execution — can obtain a second reference to port2.
  // A legitimate shim always wins this because buildCapabilityShim is
  // guaranteed to run as the very first script in the guest's document
  // (see injectCapabilityShim's unconditional prepend), before any guest
  // HTML/script has had a chance to execute at all; run_at: 'document_start'
  // on this content script additionally guarantees this listener exists
  // before that first script tag runs. So the race this is closing is not
  // "can a guest script beat the shim to the handshake" (it can't — the shim
  // runs first, full stop) but "can a guest script REPLAY or FORGE the claim
  // message after the fact" — handshakeClaimed defeats that by making the
  // claim single-use regardless of timing.
  let handshakeClaimed = false;
  window.addEventListener('message', function(event) {
    if (handshakeClaimed) return;
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'claim-port') return;
    handshakeClaimed = true;

    const channel = new MessageChannel();
    mainWorldPort = channel.port1;
    mainWorldPort.onmessage = handlePortMessage;
    mainWorldPort.start();

    // Flush anything queued before the shim claimed its port (there
    // shouldn't be much — host pushes are rare this early — but this
    // avoids silently dropping a pushed event that raced the handshake).
    const queued = pendingOutbound;
    pendingOutbound = [];
    for (let i = 0; i < queued.length; i++) mainWorldPort.postMessage(queued[i]);

    // Transfer port2 to the shim. This is a structured-clone transfer, not
    // a copy — after this call, this script no longer holds any reference
    // to port2, and neither does anything else that isn't the recipient.
    event.source.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'claim-port-ack' }, event.origin, [channel.port2]);
  });
})();`;
    return _isolatedTransportScriptCache;
  }

  // Source for the additive, modern app-facing API. Keep the facade thin: all
  // operations still go through the existing IPC bridge and host-side handlers,
  // which preserve per-app isolation, validation, quotas, and permission checks.
  //
  // Facade completion policy (documented in NOVAAPP.md under "API versions
  // and backward compatibility"): every facade here is pure sugar over an
  // existing channel — the v1 channel, its payload, its response object,
  // its error codes, and its permission gate are all UNCHANGED. The v1
  // surface is frozen; anything genuinely new ships as a new channel with
  // its own facade method, never as a behavior change to an old one.
  // This is source text because the code runs inside each sandboxed app document.
  function buildNovaOSFacadeSource(maxHttpBodyBytes) {
    const bodyCap = Number(maxHttpBodyBytes) >= 64 * 1024 ? Math.floor(Number(maxHttpBodyBytes)) : 6 * 1024 * 1024;
    return `
  // AstroOS platform API v2. The legacy window.nova surface above remains
  // available with its original return shapes and error behavior.
  // __NOVA_MAX_BODY_BYTES__ is baked in from the calling app's ledger budget
  // (httpBodyBytes); the host re-checks the same budget authoritatively on
  // every request, so these guest-side checks are just early failures.
  const __NOVA_MAX_BODY_BYTES__ = ${bodyCap};
  const NOVAOS_SUPPORTED_CAPABILITIES = Object.freeze({
    // One capability per v2 facade surface. These mean "this runtime ships
    // this facade" — feature detection, NOT permission state (an app must
    // still hold the underlying grant for gated surfaces; the capability
    // tells it whether to bother probing the API at all). New facades add
    // names here; existing names are never removed.
    'storage.v2': true,
    'fs.v2': true,
    'clipboard.v2': true,
    'notifications.v2': true,
    'window.v2': true,
    'dialogs.v2': true,
    'app.v2': true,
    'data.v2': true,
    // New host-side capabilities (each with its own permission — a
    // capability name says the runtime ships the surface, not that the
    // app may use it).
    'locale.v1': true,
    'badge.v1': true,
    'fsWatch.v1': true,
    'alarms.v1': true,
    'secrets.v1': true,
    'shareTarget.v1': true,
    'push.v1': true,
    // v2 sugar over frozen v1 channels (nova:settings:*, nova:ready) —
    // same gates, same payloads, nothing new host-side.
    'settings.v2': true,
    'ready.v2': true,
    // Full-coverage v2 sugar over the remaining frozen v1 channel families
    // (events, device, calendar/contacts, mail, admin, background,
    // permissions, websocket) — still pure sugar, still nothing new
    // host-side.
    'events.v2': true,
    'geolocation.v2': true,
    'media.v2': true,
    'calendar.v2': true,
    'contacts.v2': true,
    'mail.v2': true,
    'admin.v2': true,
    'background.v2': true,
    'permissions.v2': true,
    'net.v2': true,
    // AstroOS Registry — nova:reg:* channels + the nova:reg:changed event.
    'registry.v1': true,
  });
  // Listener state for the v2 event-bus, background-wake, and net facades.
  // Deliberately separate from the v1 bridge's own collections
  // (eventListeners / backgroundWakeListeners — frozen window.nova surface):
  // the push dispatch fans out to both independently, and each side manages
  // only its own callbacks. __v1EventListeners lets the events facade
  // coordinate with v1 listeners when this source is embedded in the full
  // capability shim (always, in a real sandbox): the host holds ONE
  // subscription per sandbox per event name, so while v1 listeners exist
  // for a name we neither re-subscribe (the host would answer
  // ALREADY_SUBSCRIBED) nor host-unsubscribe out from under them. It is
  // null when this source is evaluated standalone (the test harness).
  const novaOSEventListeners = {}; // eventName -> [callback, ...]
  const novaOSWakeListeners = [];
  // Per-socket listeners for the v2 net facade (novaOS.net.websocket) —
  // wsId -> { message: [...], error: [...], close: [...] }. Separate from
  // the v1 wrapper's wsEventListeners for the same reason as above: the
  // push dispatch fans out to both, and each surface manages only its own
  // entries (a wsId's entry goes when its close push arrives).
  const novaOSWsListeners = {};
  const __v1EventListeners = (typeof eventListeners === 'object' && eventListeners !== null) ? eventListeners : null;
  // Shared subscription machinery for the events facade AND registry.watch()
  // (which is v2 sugar over the 'nova:reg:changed' event with a guest-side
  // prefix filter). Stacks any number of listeners per event name over ONE
  // host subscription, tolerates an existing subscription, and returns an
  // off() function that also unsubscribes host-side once the last listener
  // for the name goes. (Body moved verbatim out of the events facade so
  // both surfaces share it.)
  function novaOSEventOn(eventName, callback) {
    if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
    if (!novaOSEventListeners[eventName]) novaOSEventListeners[eventName] = [];
    novaOSEventListeners[eventName].push(callback);
    const v1HasListeners = !!(__v1EventListeners && __v1EventListeners[eventName] && __v1EventListeners[eventName].length);
    const needsSubscribe = novaOSEventListeners[eventName].length === 1 && !v1HasListeners;
    const sub = needsSubscribe
      ? ipc('nova:events:subscribe', { event: eventName }).then(null, function(error) {
          if (error && error.code === 'ALREADY_SUBSCRIBED') {
            return { success: true, subscribed: eventName };
          }
          // The host refused the subscription (allowlist miss,
          // PERMISSION_DENIED, bus unavailable) — don't leave a
          // listener registered for a subscription that will never fire.
          const list = novaOSEventListeners[eventName] || [];
          const index = list.indexOf(callback);
          if (index >= 0) list.splice(index, 1);
          if (list.length === 0) delete novaOSEventListeners[eventName];
          throw error;
        })
      : Promise.resolve({ success: true, subscribed: eventName });
    return sub.then(function() {
      return function() {
        const list = novaOSEventListeners[eventName] || [];
        const index = list.indexOf(callback);
        if (index >= 0) list.splice(index, 1);
        if (list.length === 0 && !(__v1EventListeners && __v1EventListeners[eventName] && __v1EventListeners[eventName].length)) {
          delete novaOSEventListeners[eventName];
          return ipc('nova:events:unsubscribe', { event: eventName }).then(function() {});
        }
        return undefined;
      };
    });
  }
  window.novaOS = Object.freeze({
    apiVersion: 2,
    capabilities: Object.freeze({
      has: function(name) {
        return typeof name === 'string'
          && Object.prototype.hasOwnProperty.call(NOVAOS_SUPPORTED_CAPABILITIES, name)
          && NOVAOS_SUPPORTED_CAPABILITIES[name] === true;
      },
    }),
    storage: Object.freeze({
      // get() returns the stored value directly, or null when the key is absent.
      get: function(key) {
        return ipc('nova:storage:get', { key: key }).then(function(result) {
          return result && Object.prototype.hasOwnProperty.call(result, 'value')
            ? result.value
            : null;
        });
      },
      // Mutations resolve with undefined; host-side errors still reject the promise.
      set: function(key, value) {
        return ipc('nova:storage:set', { key: key, value: value }).then(function() {});
      },
      remove: function(key) {
        return ipc('nova:storage:delete', { key: key }).then(function() {});
      },
      clear: function() {
        return ipc('nova:storage:clear', {}).then(function() {});
      },
      keys: function() {
        return ipc('nova:storage:keys', {}).then(function(result) {
          return result && Array.isArray(result.keys) ? result.keys : [];
        });
      },
      // This app's own usage against its own budget — the storage twin of
      // Android's StorageManager.getAllocatedBytes(). No other app's numbers
      // are reachable, ever.
      usage: function() {
        return ipc('nova:storage:usage', {}).then(function(result) {
          return {
            usage: result && Number.isFinite(result.usage) ? result.usage : 0,
            budget: result && Number.isFinite(result.budget) ? result.budget : 0,
          };
        });
      },
    }),
    // Scoped filesystem roots (host-side expansion — see NOVAAPP.md).
    // appdata: always resolves to THIS app's /data/<appId>/ subtree; there
    // is no syntax to name another app's subtree. shared:/media: address
    // the shared tree under the same permission rules as raw paths —
    // ownership and grant checks happen on every call host-side.
    fs: Object.freeze({
      // Full facade over the raw nova:fs:* channels — same caller-relative
      // paths (appdata:/shared:/media: roots accepted), same permission
      // rules, same file records and error codes. Pure sugar: nothing here
      // bypasses or re-implements the host-side path rewriting, MAC checks,
      // or quotas — the host handler is still the only boundary.
      read: function(path) {
        return ipc('nova:fs:read', { path: path });
      },
      write: function(path, content) {
        return ipc('nova:fs:write', { path: path, content: content });
      },
      list: function(path) {
        return ipc('nova:fs:list', { path: path });
      },
      stat: function(path) {
        return ipc('nova:fs:stat', { path: path });
      },
      mkdir: function(path, name) {
        return ipc('nova:fs:mkdir', { path: path, name: name });
      },
      rename: function(path, name) {
        return ipc('nova:fs:rename', { path: path, name: name });
      },
      move: function(path, destPath) {
        return ipc('nova:fs:move', { path: path, destPath: destPath });
      },
      remove: function(path) {
        return ipc('nova:fs:delete', { path: path });
      },
      // Change watch (fs:watch + the per-path read rules of nova:fs:read —
      // watching is reading). watch() resolves with a handle whose unwatch()
      // stops the events; changes arrive on the callback as
      // { watcherId, path, kind: 'changed'|'created'|'deleted', timestamp }.
      // Delivery is debounced and budgeted host-side (max 8 watchers, 60
      // events/min) and is best-effort — poll if you need guarantees.
      watch: function(path, callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        const watcherId = 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        fsWatchListeners[watcherId] = [callback];
        return ipc('nova:fs:watch', { path: path, watcherId: watcherId }).then(function(result) {
          return {
            watcherId: watcherId,
            path: result && result.path ? result.path : path,
            unwatch: function() {
              delete fsWatchListeners[watcherId];
              return ipc('nova:fs:unwatch', { watcherId: watcherId }).then(function() {});
            },
          };
        }, function(error) {
          delete fsWatchListeners[watcherId];
          throw error;
        });
      },
      // Raw unwatch by watcher id (fs.watch().unwatch() is the usual path).
      unwatch: function(watcherId) {
        return ipc('nova:fs:unwatch', { watcherId: watcherId }).then(function() {});
      },
      appdata: Object.freeze({
        list: function(path) {
          return ipc('nova:fs:list', { path: 'appdata:/' + String(path || '').replace(/^\\/+$|^\\/+/, '') });
        },
        read: function(path) {
          return ipc('nova:fs:read', { path: 'appdata:/' + String(path || '').replace(/^\\/+$|^\\/+/, '') });
        },
        write: function(path, content) {
          return ipc('nova:fs:write', { path: 'appdata:/' + String(path || '').replace(/^\\/+$|^\\/+/, ''), content: content });
        },
        remove: function(path) {
          return ipc('nova:fs:delete', { path: 'appdata:/' + String(path || '').replace(/^\\/+$|^\\/+/, '') });
        },
      }),
      shared: Object.freeze({
        list: function(path) {
          return ipc('nova:fs:list', { path: 'shared:/' + String(path || '').replace(/^\\/+$|^\\/+/, '') });
        },
        read: function(path) {
          return ipc('nova:fs:read', { path: 'shared:/' + String(path || '').replace(/^\\/+$|^\\/+/, '') });
        },
      }),
    }),
    // Indexed shared media metadata (nova:media:query). File bytes must
    // still be read through fs.read(), which applies the usual per-file
    // media permission checks. The device media-authorization checks live
    // on this surface too (device:camera / device:microphone) — the raw
    // channels are authorization-only (a MediaStream can't cross the IPC
    // bridge), so checkCamera()/checkMicrophone() resolve true when the
    // app-level grant is held and reject PERMISSION_DENIED when it isn't.
    // getUserMedia(constraints) mirrors window.nova.getUserMedia:
    // app-level checks first, then the real getUserMedia() in THIS
    // document — the browser's own permission gate still runs separately
    // when it is invoked (the permissionrequest 'media' branch). One
    // merged media surface: an earlier draft shipped these as two
    // media keys, where the later one silently clobbered query().
    media: Object.freeze({
      query: function(options) {
        return ipc('nova:media:query', options || {});
      },
      checkCamera: function() { return ipc('nova:device:camera', {}).then(function() { return true; }); },
      checkMicrophone: function() { return ipc('nova:device:microphone', {}).then(function() { return true; }); },
      getUserMedia: function(constraints) {
        constraints = constraints || {};
        const needsCamera = !!constraints.video;
        const needsMic = !!constraints.audio;
        const checks = [];
        if (needsCamera) checks.push(ipc('nova:device:camera', {}));
        if (needsMic) checks.push(ipc('nova:device:microphone', {}));
        if (checks.length === 0) {
          return Promise.reject(new TypeError('getUserMedia requires at least one of video/audio in constraints'));
        }
        return Promise.all(checks).then(function() {
          if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
            return Promise.reject(new TypeError('getUserMedia not available in this environment'));
          }
          return navigator.mediaDevices.getUserMedia(constraints);
        });
      },
    }),
    // Clipboard facade. readText() normalizes to the text itself (null when
    // nothing is readable — matches nova:clipboard:read's null text field);
    // writeText() resolves undefined. Permission behavior is identical to
    // the raw channels (clipboard:read / clipboard:write, host-checked).
    clipboard: Object.freeze({
      readText: function() {
        return ipc('nova:clipboard:read', {}).then(function(result) {
          return result && Object.prototype.hasOwnProperty.call(result, 'text') ? result.text : null;
        });
      },
      writeText: function(text) {
        return ipc('nova:clipboard:write', { text: text }).then(function() {});
      },
    }),
    // Notifications facade — 1:1 with the v1 channels, same permission gate
    // (device:notifications), same rate limits, same payloads. Mutations
    // resolve undefined; show/post return the raw response (which may be an
    // UNAVAILABLE/RATE_LIMITED error rejection exactly like v1).
    notifications: Object.freeze({
      show: function(options) {
        return ipc('nova:notifications:show', options || {});
      },
      post: function(options) {
        return ipc('nova:notifications:post', options || {});
      },
      createChannel: function(id, name, importance) {
        return ipc('nova:notifications:createChannel', { id: id, name: name, importance: importance });
      },
      cancel: function(id) {
        return ipc('nova:notifications:cancel', { id: id });
      },
      cancelAll: function() {
        return ipc('nova:notifications:cancelAll', {}).then(function() {});
      },
      clear: function() {
        return ipc('nova:notifications:clear', {}).then(function() {});
      },
      consumeActions: function() {
        return ipc('nova:notifications:consumeActions', {});
      },
    }),
    // Window facade — the same controls nova:window:* offers. Mutations
    // resolve undefined; getState() returns the normalized state record
    // (the raw response minus its success flag). Host-side clamps are
    // unchanged: the host still caps titles and dimensions.
    window: Object.freeze({
      close: function() { return ipc('nova:window:close', {}).then(function() {}); },
      minimize: function() { return ipc('nova:window:minimize', {}).then(function() {}); },
      maximize: function() { return ipc('nova:window:maximize', {}).then(function() {}); },
      setTitle: function(title) { return ipc('nova:window:setTitle', { title: title }).then(function() {}); },
      resize: function(width, height) {
        return ipc('nova:window:resize', { width: width, height: height }).then(function() {});
      },
      getState: function() {
        return ipc('nova:window:getState', {}).then(function(result) {
          return {
            id: result.id, x: result.x, y: result.y,
            width: result.width, height: result.height,
            maximized: !!result.maximized, minimized: !!result.minimized,
          };
        });
      },
    }),
    // Dialog facade — unifies the two historical pickers behind one pair of
    // methods. style: 'styled' (default) uses the OS-styled picker
    // (nova:sysdialog:*); style: 'system' uses the plain picker
    // (nova:dialog:*). Both are user-mediated: the app only ever gets what
    // the user actively picked, so no permission gates either path.
    // Extra options (accept, multiple, defaultName, …) pass through
    // unchanged; the style key itself is stripped before sending.
    dialog: Object.freeze({
      pickOpen: function(options) {
        const opts = options || {};
        const payload = Object.assign({}, opts);
        delete payload.style;
        if (opts.style === 'system') return ipc('nova:dialog:open', payload);
        return ipc('nova:sysdialog:open', payload);
      },
      pickSave: function(options) {
        const opts = options || {};
        const payload = Object.assign({}, opts);
        delete payload.style;
        if (opts.style === 'system') return ipc('nova:dialog:save', payload);
        return ipc('nova:sysdialog:save', payload);
      },
    }),
    // App facade — info/list/launch plus the user-mediated intents. Same
    // permission gates as the raw channels (list/install need system:apps,
    // launch needs system:app-launch or system:apps, share/openUrl/openWith
    // are user-mediated and ungated).
    app: Object.freeze({
      info: function() { return ipc('nova:app:info', {}); },
      list: function() { return ipc('nova:app:list', {}); },
      launch: function(appId, options) {
        return ipc('nova:app:launch', { appId: appId, options: options || {} });
      },
      openUrl: function(url) { return ipc('nova:open-url', { url: url }); },
      share: function(data) { return ipc('nova:share', data || {}); },
      openWith: function(fileId) { return ipc('nova:open-with', { fileId: fileId }); },
    }),
    // Data portability facade — thin sugar over nova:data:* (see the
    // Data portability chapter; envelopes are checksummed and pinned to
    // the calling appId host-side).
    data: Object.freeze({
      export: function(options) { return ipc('nova:data:export', options || {}); },
      import: function(envelope) { return ipc('nova:data:import', { envelope: envelope }); },
      backup: function() { return ipc('nova:data:backup', {}); },
      restore: function(envelope, options) {
        return ipc('nova:data:restore', Object.assign({ envelope: envelope }, options || {}));
      },
    }),
    // Locale facade — no permission, coarse formatting facts only (see the
    // host handler). get() returns the normalized record.
    locale: Object.freeze({
      get: function() {
        return ipc('nova:locale:get', {}).then(function(result) {
          return {
            locale: result && typeof result.locale === 'string' ? result.locale : 'en-US',
            region: result && typeof result.region === 'string' ? result.region : null,
            timeZone: result && typeof result.timeZone === 'string' ? result.timeZone : null,
            firstDayOfWeek: result && result.firstDayOfWeek === 'sunday' ? 'sunday' : 'monday',
          };
        });
      },
    }),
    // Taskbar badge (system:badge). set takes a number 0-999 or an object
    // { text } (1-4 chars); set(0) clears, exactly like clear(). Mutations
    // resolve undefined; the host clamps and rate-limits authoritatively.
    badge: Object.freeze({
      set: function(value) {
        const payload = typeof value === 'number' ? { count: value } : (value || {});
        return ipc('nova:badge:set', payload).then(function() {});
      },
      clear: function() { return ipc('nova:badge:clear', {}).then(function() {}); },
    }),
    // Secrets (secrets:store) — encrypted per-app credential store. get()
    // returns the plaintext string or null (absent or unauthenticated);
    // mutations resolve undefined; keys() lists only this app's own labels.
    // Secrets never appear in data export/backup envelopes — they are not
    // part of the portable namespace, by design.
    secrets: Object.freeze({
      set: function(key, value) { return ipc('nova:secrets:set', { key: key, value: value }).then(function() {}); },
      get: function(key) {
        return ipc('nova:secrets:get', { key: key }).then(function(result) {
          return result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null;
        });
      },
      delete: function(key) { return ipc('nova:secrets:delete', { key: key }).then(function() {}); },
      keys: function() {
        return ipc('nova:secrets:keys', {}).then(function(result) {
          return result && Array.isArray(result.keys) ? result.keys : [];
        });
      },
    }),
    // Inbound share (system:share-target) — receive content other apps
    // shared after the user picked THIS app in the share sheet. The push
    // payload: { title, text, url, sourceAppId, firedAt, queued? }.
    share: Object.freeze({
      onInbound: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        shareInboundListeners.push(callback);
        return function() {
          const index = shareInboundListeners.indexOf(callback);
          if (index >= 0) shareInboundListeners.splice(index, 1);
        };
      },
    }),
    // Named alarms (system:schedule). create takes exactly one of
    // when (future epoch ms, one-shot) or periodMinutes (>= 15, periodic);
    // re-creating a name replaces it. Fires arrive via onAlarm as
    // { name, alarm: { scheduledTime, ... }, firedAt, queued? }. Alarms
    // fire while the app is running or keep-alive; one-shots missed while
    // fully closed are delivered right after the next launch.
    alarms: Object.freeze({
      create: function(options) { return ipc('nova:alarms:create', options || {}); },
      clear: function(name) { return ipc('nova:alarms:clear', { name: name }).then(function() {}); },
      getAll: function() {
        return ipc('nova:alarms:getAll', {}).then(function(result) {
          return result && Array.isArray(result.alarms) ? result.alarms : [];
        });
      },
      onAlarm: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        alarmListeners.push(callback);
        return function() {
          const index = alarmListeners.indexOf(callback);
          if (index >= 0) alarmListeners.splice(index, 1);
        };
      },
    }),
    // Push delivery (push:receive) — messages from the app's own backend
    // via the OS push service. register() resolves
    // { success, token, endpoint, queued?, replaced?, subscribed } — hand
    // the stable token to YOUR backend, which publishes to the endpoint
    // documented in NOVAAPP.md. register() is idempotent: the same install
    // keeps the same token. Messages arrive via onMessage as
    // { appId, id, title?, body?, data?, sentAt, queued? }.
    push: Object.freeze({
      register: function() { return ipc('nova:push:register', {}).then(function(result) { return result || {}; }); },
      unregister: function() { return ipc('nova:push:unregister', {}).then(function() {}); },
      onMessage: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        pushListeners.push(callback);
        return function() {
          const index = pushListeners.indexOf(callback);
          if (index >= 0) pushListeners.splice(index, 1);
        };
      },
    }),
    // Settings access — v2 sugar over nova:settings:get/set. The gates are
    // the ones those channels always had, unchanged: reading requires
    // system:info, writing requires system:settings (the wallpaper keys
    // keep their write-grant exemption, still subject to the
    // prohibitWallpaperChange policy toggle host-side), and both directions
    // stay bound to the OS-owned key allowlists — credentials, osVersion,
    // and devMode are unreachable no matter how this is called. get()
    // resolves the raw stored value (undefined when the key is unset);
    // set() resolves undefined. There is deliberately no list/subscribe
    // surface here: the allowlist is deny-by-default, and settings-change
    // events stay host-internal (use the appearance facade for the public
    // appearance subset).
    settings: Object.freeze({
      get: function(key) {
        return ipc('nova:settings:get', { key: key }).then(function(result) {
          return result && Object.prototype.hasOwnProperty.call(result, 'value')
            ? result.value
            : undefined;
        });
      },
      set: function(key, value) {
        return ipc('nova:settings:set', { key: key, value: value }).then(function() {});
      },
    }),
    // Ready-handshake snapshot — v2 sugar over nova:ready (ungated, same as
    // the automatic handshake and the v1 app.getInfo()). Resolves this
    // app's authenticated launch payload: its id, the permission grants
    // actually in effect right now, and OS identity (username only for
    // system-bundled apps — null otherwise). The automatic handshake on
    // load keeps the delivery side effects (queued alarms, shares, and
    // pushes flush right after it); this snapshot never delivers anything,
    // and repeat calls are safe because those queues drain once.
    ready: Object.freeze({
      get: function() {
        return ipc('nova:ready', {}).then(function(result) {
          return {
            appId: result && typeof result.appId === 'string' ? result.appId : null,
            permissions: result && Array.isArray(result.permissions) ? result.permissions : [],
            optionalPermissions: result && Array.isArray(result.optionalPermissions) ? result.optionalPermissions : [],
            osVersion: result && result.osVersion != null ? result.osVersion : null,
            securityPatch: result && result.securityPatch != null ? result.securityPatch : null,
            username: result && typeof result.username === 'string' ? result.username : null,
          };
        });
      },
    }),
    // Event bus (nova:events:*) — OS-to-app push events; there is no
    // app-to-app publish path (that's nova.ipc.broadcast, unchanged). on()
    // stacks any number of listeners per event name over ONE host
    // subscription (the host holds a single subscription per sandbox and
    // the push dispatch fans out here), tolerates a subscription another
    // surface already made (ALREADY_SUBSCRIBED), and returns an off()
    // function that also unsubscribes host-side once the last listener
    // for that name goes. subscribe()/unsubscribe() are the raw channels
    // for manual control — subscribe rejects ALREADY_SUBSCRIBED when on()
    // or a v1 onEvent listener already subscribed the name. The fixed
    // event allowlist and its permission gates (system:events plus the
    // domain read permission for the sensitive families) are unchanged.
    events: Object.freeze({
      on: function(eventName, callback) { return novaOSEventOn(eventName, callback); },
      subscribe: function(eventName) { return ipc('nova:events:subscribe', { event: eventName }); },
      unsubscribe: function(eventName) { return ipc('nova:events:unsubscribe', { event: eventName }).then(function() {}); },
    }),
    // Geolocation (device:geolocation) — one-shot position fix. Same
    // PositionOptions payload as the raw channel (timeout, maximumAge,
    // enableHighAccuracy — passed through as options), normalized to
    // { coords, timestamp } (the raw response minus its success flag).
    // There is deliberately no watchPosition: the v1 channel is one-shot
    // by design and the facade does not invent host behavior.
    geolocation: Object.freeze({
      getCurrentPosition: function(options) {
        return ipc('nova:device:geolocation', { options: options || {} }).then(function(result) {
          return { coords: result.coords, timestamp: result.timestamp };
        });
      },
    }),
    // Calendar/Contacts — the SAME shared stores the host Calendar and
    // Contacts apps use (not per-app isolated data), so writes are visible
    // to those apps and their change events fire exactly as before. list()
    // returns the records array; save() returns the host-normalized record
    // (ids are assigned host-side on create); remove() resolves whether
    // anything was actually deleted. Error codes (INVALID_EVENT,
    // INVALID_CONTACT, INVALID_ID, PERMISSION_DENIED) are unchanged.
    calendar: Object.freeze({
      list: function() {
        return ipc('nova:calendar:read', {}).then(function(result) {
          return result && Array.isArray(result.events) ? result.events : [];
        });
      },
      save: function(event) {
        return ipc('nova:calendar:write', { event: event }).then(function(result) {
          return result && result.event ? result.event : result;
        });
      },
      remove: function(id) {
        return ipc('nova:calendar:delete', { id: id }).then(function(result) {
          return !!(result && result.removed);
        });
      },
    }),
    contacts: Object.freeze({
      list: function() {
        return ipc('nova:contacts:read', {}).then(function(result) {
          return result && Array.isArray(result.contacts) ? result.contacts : [];
        });
      },
      save: function(contact) {
        return ipc('nova:contacts:write', { contact: contact }).then(function(result) {
          return result && result.contact ? result.contact : result;
        });
      },
      remove: function(id) {
        return ipc('nova:contacts:delete', { id: id }).then(function(result) {
          return !!(result && result.removed);
        });
      },
    }),
    // Mail (nova:mail:* + nova:email:open-link) — reuses whatever account
    // is connected in the host shell's Email app (session-scoped; fails
    // UNAVAILABLE when nothing is connected). 1:1 with the v1 wrapper:
    // same actions, same permission gate per action (mail:read/write/send/
    // delete), and unnormalized records — mail responses are action-shaped
    // (folders lists, message pages, preview tokens), so there is no
    // single value to project out.
    mail: Object.freeze({
      connect: function(account) { return ipc('nova:mail:session', { action: 'connect', account: account || {} }); },
      disconnect: function() { return ipc('nova:mail:session', { action: 'disconnect' }); },
      restore: function() { return ipc('nova:mail:session', { action: 'restore' }); },
      account: function() { return ipc('nova:mail:read', { action: 'account' }); },
      folders: function() { return ipc('nova:mail:read', { action: 'folders' }); },
      messages: function(options) { return ipc('nova:mail:read', Object.assign({ action: 'messages' }, options || {})); },
      message: function(uid, folder) { return ipc('nova:mail:read', { action: 'message', uid: uid, folder: folder }); },
      search: function(query, folder) { return ipc('nova:mail:read', { action: 'search', query: query, folder: folder }); },
      preview: function(html) { return ipc('nova:mail:write', { action: 'preview', html: html }); },
      markRead: function(uids, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'read', uids: uids, folder: folder }); },
      move: function(uids, dest, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'move', uids: uids, dest: dest, folder: folder }); },
      send: function(msg) { return ipc('nova:mail:send', msg || {}); }, // msg: { to, cc, bcc, subject, text, html, smtpHost, smtpPort }
      remove: function(uids, folder) { return ipc('nova:mail:delete', { uids: uids, folder: folder }); },
      openLink: function(url) { return ipc('nova:email:open-link', { url: url }); },
    }),
    // Admin (nova:admin:*) — the dual gate is unchanged: the per-app
    // permission grant AND the machine's local admin flag set in Settings;
    // granting an app admin:* never puts the machine in admin mode by
    // itself. Records pass through unnormalized (audit responses carry
    // pagination/statistics; system/users/apps shapes are action-specific).
    admin: Object.freeze({
      auditQuery: function(filters) { return ipc('nova:admin:audit', filters || {}); },
      systemGet: function() { return ipc('nova:admin:system', { action: 'get' }); },
      systemSet: function(settings) { return ipc('nova:admin:system', { action: 'set', settings: settings }); },
      usersList: function() { return ipc('nova:admin:users', { action: 'list' }); },
      usersRevoke: function(sessionId) { return ipc('nova:admin:users', { action: 'revoke', sessionId: sessionId }); },
      appsList: function() { return ipc('nova:admin:apps', {}); },
    }),
    // Background execution — the three tiers are unchanged (system:background
    // scheduled wakes, system:background:live stay-alive, system:autostart).
    // stayAlive() opts THIS session into surviving window close — holding
    // the grant alone is never enough — and resolves the resulting enabled
    // state; call stayAlive(false) to opt back out before closing. wakeDone()
    // ends a scheduled wake early so the host doesn't wait out the deadline
    // (resolves undefined). onWake() registers a wake handler and returns an
    // off() function — it fires only in sandboxes the host started FOR a
    // wake cycle; the wake happening at all IS the system:background check
    // having passed host-side.
    background: Object.freeze({
      stayAlive: function(enabled) {
        return ipc('nova:background:stay-alive', { enabled: enabled !== false }).then(function(result) {
          return { enabled: !!(result && result.enabled) };
        });
      },
      wakeDone: function() { return ipc('nova:background:wake-done', {}).then(function() {}); },
      onWake: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        novaOSWakeListeners.push(callback);
        return function() {
          const index = novaOSWakeListeners.indexOf(callback);
          if (index >= 0) novaOSWakeListeners.splice(index, 1);
        };
      },
    }),
    // Permission requests — the runtime counterpart to the static manifest
    // grants. request() surfaces the OS permission dialog (permanent by
    // default, exactly like the raw channel) and resolves the granted
    // boolean; the host silently denies re-asks while a denial cooldown is
    // active. checkRateLimited() peeks at that cooldown WITHOUT triggering
    // a prompt and returns the raw status record (the Permissions app uses
    // the same shape for its "try again in Ns" display).
    permissions: Object.freeze({
      request: function(permission, reason) {
        return ipc('nova:request-permission', { permission: permission, reason: reason }).then(function(result) {
          return !!(result && result.granted);
        });
      },
      checkRateLimited: function(permission) {
        return ipc('nova:permission-rate-limited', { permission: permission });
      },
    }),
    // WebSocket (nova:net:websocket + ws:send/ws:close) — 1:1 with the v1
    // window.nova.websocket() wrapper: open resolves only once the host's
    // socket is OPEN (the host answers nova:net:websocket from its onopen
    // handler, so a connection that never opens surfaces as the shim's
    // generic IPC timeout rather than a specific failure reason — same as
    // v1), and the handle registers message/error/close callbacks per
    // wsId. Push delivery fans out to this facade's own registry
    // (novaOSWsListeners above) independently of the v1 wrapper's, so each
    // surface only sees callbacks registered through itself. Same gates,
    // same URL rules (ws:/wss: only, no embedded credentials, no
    // cloud-metadata literals; net:internal additionally required for
    // private and first-party destinations), same error codes.
    net: Object.freeze({
      websocket: function(url, protocols) {
        return ipc('nova:net:websocket', { url: url, protocols: protocols }).then(function(res) {
          const wsId = res && res.wsId;
          if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
          novaOSWsListeners[wsId] = { message: [], error: [], close: [] };
          return {
            wsId: wsId,
            readyState: res.readyState,
            onMessage: function(cb) {
              if (typeof cb !== 'function') throw new TypeError('callback must be a function');
              novaOSWsListeners[wsId].message.push(cb);
            },
            onError: function(cb) {
              if (typeof cb !== 'function') throw new TypeError('callback must be a function');
              novaOSWsListeners[wsId].error.push(cb);
            },
            onClose: function(cb) {
              if (typeof cb !== 'function') throw new TypeError('callback must be a function');
              novaOSWsListeners[wsId].close.push(cb);
            },
            send: function(data) { return ipc('nova:net:ws:send', { wsId: wsId, data: data }); },
            close: function(code, reason) { return ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }); },
          };
        });
      },
    }),
    // AstroOS Registry (nova:reg:* + nova:reg:changed) — the typed OS
    // config store. get() resolves the stored value directly, or undefined
    // when the path is absent (stat() returns the full { found, type, data
    // } record). set()/remove()/import() enforce the per-hive rules
    // host-side: apps write only their own HKNA/<app.id>/ subtree, HKNS
    // writes need a system app, HKNU needs registry.system, HKND needs
    // Developer Mode, and HKNS/security needs registry.system everywhere.
    // watch() is sugar over nova:events:subscribe('nova:reg:changed') with
    // a guest-side prefix filter, so it holds the same grants subscribing
    // to that event needs (registry.read) — watching is reading. The off()
    // function it resolves stops the listener AND the host subscription
    // once the last one for the event goes.
    registry: Object.freeze({
      get: function(path) {
        return ipc('nova:reg:get', { path: path }).then(function(result) {
          return result && result.found ? result.data : undefined;
        });
      },
      stat: function(path) { return ipc('nova:reg:get', { path: path }); },
      set: function(path, value, type) {
        return ipc('nova:reg:set', { path: path, value: value, type: type });
      },
      remove: function(path, options) {
        return ipc('nova:reg:delete', { path: path, recursive: !!(options && options.recursive) });
      },
      list: function(path) { return ipc('nova:reg:list', { path: path }); },
      export: function(path) { return ipc('nova:reg:export', { path: path }); },
      import: function(path, data) { return ipc('nova:reg:import', { path: path, data: data }); },
      watch: function(path, callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        const prefix = String(path || '');
        return novaOSEventOn('nova:reg:changed', function(data) {
          const changed = String((data && data.path) || '').split('\\\\').join('/');
          if (!prefix || changed === prefix || changed.indexOf(prefix + '/') === 0) callback(data);
        });
      },
    }),
  });`;
  }

  // Builds the capability shim string for a given app. Whether the package
  // opted in is baked in at injection time; user permission is checked on
  // each host operation so a runtime grant can enable the API without reload.
  // budgets: { requestTimeoutMs, httpBodyBytes } from the app's ledger record
  // (StorageLedger.getBudget) — the guest-side constants match the caps the
  // host actually enforces, so an app with a raised budget doesn't fail
  // client-side at the old lower cap.
  function buildCapabilityShim(nestedWebviewOptedIn, initialUrl = null, budgets = {}) {
  return `<script>
(function() {
  'use strict';
  const REQUEST_TIMEOUT_MS = ${Number(budgets.requestTimeoutMs) >= 5000 ? Math.floor(Number(budgets.requestTimeoutMs)) : 30000};
  // Baked in from the package manifest. Actual permission is checked by the
  // host for every nested-webview IPC request.
  const __NOVA_NESTED_WEBVIEW_OPTED_IN__ = ${nestedWebviewOptedIn ? 'true' : 'false'};
  let __NOVA_PENDING_INITIAL_URL__ = ${JSON.stringify(initialUrl)};

  // A handful of channels block on a human making a decision in a native
  // OS dialog (choosing where to save, which file to open) rather than on
  // a normal async operation — 30s is fine for everything else, but too
  // short here: someone can take well over 30 seconds browsing folders
  // and typing a filename, and hitting the generic timeout mid-decision
  // produced a real bug (a stale "IPC request timed out" rejection while
  // the dialog was still legitimately open, unrelated to the user
  // actually cancelling). These get a much longer timeout instead of
  // none at all, so a truly stuck/never-resolving call still eventually
  // surfaces as an error rather than hanging the caller forever.
  const INTERACTIVE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  const INTERACTIVE_CHANNELS = {
    'nova:context-menu:show': true,
    'nova:download': true,
    'nova:share': true,
    'nova:files:open': true,
    'nova:files:save': true,
    'nova:dialog:open': true,
    'nova:dialog:save': true,
    'nova:sysdialog:open': true,
    'nova:sysdialog:save': true,
    'nova:open-with': true,
    'nova:clock:alarm:dialog': true,
  };
  const pendingRequests = new Map();
  // Must exactly match BRIDGE_MARKER in app-sandbox.js's
  // buildIsolatedTransportScript(). This shim never touches IPC_MARKER or
  // console.log directly anymore — that channel now lives entirely inside
  // the isolated-world transport script (injected separately via
  // addContentScripts). BRIDGE_MARKER is used ONLY to claim this shim's
  // MessagePort at startup (see the handshake below) — once claimed, all
  // request/response traffic goes over the port itself, which needs no tag
  // because possession of the port is what proves a message is legitimate.
  // A tagged window.postMessage is forgeable by any main-world script; a
  // port reference isn't, since nothing outside this handshake ever gets one.
  const BRIDGE_MARKER = '__NOVA_BRIDGE__';

  // Set once the one-shot handshake below completes. Requests made before
  // this resolves are queued and flushed the instant the port arrives —
  // in practice this window is essentially zero since this script is
  // guaranteed to run before any other guest code (see
  // injectCapabilityShim's unconditional prepend) and the isolated
  // transport script's claim listener is armed by run_at: 'document_start'
  // before that.
  let hostPort = null;
  let pendingPortMessages = [];
  function sendOverPort(msg) {
    if (hostPort) {
      hostPort.postMessage(msg);
    } else {
      pendingPortMessages.push(msg);
    }
  }
  window.addEventListener('message', function claimHandshake(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__novaBridge !== BRIDGE_MARKER || data.kind !== 'claim-port-ack') return;
    window.removeEventListener('message', claimHandshake);
    const port = event.ports && event.ports[0];
    if (!port) return;
    hostPort = port;
    hostPort.onmessage = function(portEvent) { handleInboxMessage(portEvent.data); };
    hostPort.start();
    const queued = pendingPortMessages;
    pendingPortMessages = [];
    for (let i = 0; i < queued.length; i++) hostPort.postMessage(queued[i]);
  });
  // Ask the isolated transport script for a port. Sent exactly once; the
  // isolated script's handshake listener is single-use on its end too, so
  // a duplicate/replayed claim from anywhere else is a no-op.
  window.postMessage({ __novaBridge: BRIDGE_MARKER, kind: 'claim-port' }, window.location.origin);

  function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'shim_' + window.crypto.randomUUID();
    }
    return 'shim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
  }

  // Send a nova: IPC message and resolve on response. Rejects on timeout or
  // when the host returns an error.
  //
  // This posts the request to the isolated-world transport script rather
  // than touching console.log or window.__novaOutboxPull itself. Those now
  // live in a separate JS realm this main-world code cannot reach — which
  // is deliberate: it means nothing running in this document (including a
  // malicious app that has otherwise fully compromised this realm, e.g. by
  // patching Object.prototype or console.log) can forge, read, or tamper
  // with the actual privileged channel. The public contract of ipc() is
  // unchanged: same Promise, same resolve/reject shape, same timeouts —
  // only the transport underneath moved.
  //
  // Requests go out over hostPort (see the claim-port handshake above),
  // not window.postMessage — the port itself is what authenticates this
  // as a legitimate call; see the BRIDGE_MARKER comment above for why a
  // tagged window.postMessage wasn't sufficient on its own.
  function ipc(type, payload) {
    return new Promise(function(resolve, reject) {
      const id = generateId();
      const timeoutMs = INTERACTIVE_CHANNELS[type] ? INTERACTIVE_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
      const timer = setTimeout(function() {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new TypeError('IPC request timed out: ' + type));
        }
      }, timeoutMs);
      pendingRequests.set(id, { resolve: resolve, reject: reject, timer: timer });
      try {
        sendOverPort({ kind: 'request', type: type, payload: payload, requestId: id });
      } catch (e) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  // Responses (and pushed events) arrive via hostPort.onmessage — see the
  // claim-port handshake above. The isolated transport script drains
  // window.__novaInbox on its own poll loop and forwards each message over
  // the port. This shim no longer touches window.__novaInbox itself (it
  // lives in a different JS realm now), so there's nothing left to poll on
  // this side — just a listener, and one that trusts its input by
  // construction: only the isolated script ever held a reference to the
  // other end of this port, so nothing else could be the source.
  function handleInboxMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'nova:appearance:changed:event:response' && msg.result) {
      for (const callback of appearanceListeners.slice()) {
        try { callback(msg.result); } catch (error) { console.error('Appearance listener failed:', error); }
      }
      return;
    }

    if (msg.type === 'nova:nested-webview:event:response' && msg.result?.proxyId && msg.result?.eventName) {
      const proxy = window.__novaNestedWebviewProxies?.get(msg.result.proxyId);
      if (proxy) {
        const event = new Event(msg.result.eventName);
        for (const [key, value] of Object.entries(msg.result)) {
          if (key === 'proxyId' || key === 'eventName') continue;
          try { Object.defineProperty(event, key, { value: value, configurable: true }); } catch (_) {}
        }
        if (msg.result.eventName === 'newwindow' && msg.result.popupId) {
          const popupId = msg.result.popupId;
          const popup = {
            attach: nestedProxy => nestedProxy?.__attachPopup?.(popupId),
            discard: () => ipc('nova:nested-webview', { action: 'discard-popup', id: proxy.__nestedId, popupId })
          };
          try { Object.defineProperty(event, 'window', { value: popup, configurable: true }); } catch (_) {}
        }
        if (msg.result.eventName === 'permissionrequest') {
          const request = {
            url: msg.result.request?.url,
            allow: function() {},
            deny: function() {}
          };
          try { Object.defineProperty(event, 'request', { value: request, configurable: true }); } catch (_) {}
        }
        proxy.dispatchEvent(event);
      }
      return;
    }

    if (msg.type === 'nova:ipc:request:response' && msg.result && typeof msg.requestId === 'string') {
      const handler = ipcRequestHandlers.get(msg.result.endpoint);
      Promise.resolve()
        .then(function() {
          if (!handler) throw new Error('IPC endpoint is no longer registered');
          return handler({
            endpoint: msg.result.endpoint,
            sourceAppId: msg.result.sourceAppId,
            data: msg.result.data,
          });
        })
        .then(function(result) {
          return ipc('nova:ipc:reply', { callId: msg.requestId, result: result });
        })
        .catch(function(error) {
          return ipc('nova:ipc:reply', {
            callId: msg.requestId,
            error: error && error.message ? error.message : String(error),
          });
        })
        .catch(function(error) { console.error('App IPC reply failed:', error); });
      return;
    }

    if (msg.type === 'nova:ipc:broadcast:response' && msg.result && msg.result.action) {
      const listeners = ipcBroadcastListeners.get(msg.result.action);
      if (listeners) {
        for (const callback of Array.from(listeners)) {
          try { callback({ sourceAppId: msg.result.sourceAppId, data: msg.result.data }); }
          catch (error) { console.error('App IPC broadcast listener failed:', error); }
        }
      }
      return;
    }

    // Pushed events (unprompted, no requestId round-trip) — dispatched
    // to onEvent listeners registered for this event name.
    if (msg.type === 'nova:events:event:response' && msg.result && msg.result.event) {
      const listeners = eventListeners[msg.result.event] || [];
      for (let j = 0; j < listeners.length; j++) {
        try { listeners[j](msg.result.data); } catch (_) {}
      }
      // The v2 events facade (novaOS.events.on) keeps its own listener map
      // (declared by the embedded facade source below) — fan out to it too,
      // so v1 and v2 subscribers both receive every push independently.
      const v2EventListeners = novaOSEventListeners[msg.result.event] || [];
      for (let j = 0; j < v2EventListeners.length; j++) {
        try { v2EventListeners[j](msg.result.data); } catch (_) {}
      }
      return;
    }

    if (msg.type === 'nova:overlay:event:response' && msg.result) {
      for (let i = 0; i < overlayListeners.length; i++) {
        try { overlayListeners[i](msg.result); } catch (_) {}
      }
      return;
    }

    // Pushed WebSocket events (message/error/close) — also unprompted,
    // sent with a fresh requestId that was never registered in
    // pendingRequests, so without this branch they'd hit the
    // "!entry -> return" fallthrough below and silently vanish.
    // Dispatched to listeners registered per-wsId via window.nova.websocket()
    // and, independently, via the v2 net facade (novaOS.net.websocket) —
    // each surface only ever sees callbacks registered through itself.
    // Raw nova.ipc apps have no per-wsId registry entry; the host mirrors
    // their sockets' pushes onto the OS event bus under the same names
    // (net:websocket-gated, same-app filtered — see ALLOWED_EVENT_NAMES),
    // so they arrive here as ordinary nova:events:event pushes instead.
    if ((msg.type === 'nova:net:ws:message:response' || msg.type === 'nova:net:ws:error:response' || msg.type === 'nova:net:ws:close:response')
        && msg.result && msg.result.wsId) {
      const kind = msg.type === 'nova:net:ws:message:response' ? 'message'
        : msg.type === 'nova:net:ws:error:response' ? 'error' : 'close';
      const wsListeners = wsEventListeners[msg.result.wsId];
      if (wsListeners) {
        const cbs = wsListeners[kind] || [];
        for (let k = 0; k < cbs.length; k++) {
          try { cbs[k](msg.result); } catch (_) {}
        }
        if (kind === 'close') delete wsEventListeners[msg.result.wsId];
      }
      // v2 net facade listeners — same push, its own registry, so a socket
      // opened through novaOS.net.websocket delivers to facade callbacks
      // even when no v1 handle was ever created for that wsId.
      const v2WsListeners = novaOSWsListeners[msg.result.wsId];
      if (v2WsListeners) {
        const v2Cbs = v2WsListeners[kind] || [];
        for (let k = 0; k < v2Cbs.length; k++) {
          try { v2Cbs[k](msg.result); } catch (_) {}
        }
        if (kind === 'close') delete novaOSWsListeners[msg.result.wsId];
      }
      return;
    }

    // Pushed background wake calls (system:background scheduled wake) —
    // also unprompted, same shape as the events branch above. Dispatched
    // to listeners registered via window.nova.onBackgroundWake(). The
    // host only ever sends this to a sandbox it started specifically for
    // a wake cycle (see AppScheduler.wake in app-sandbox.js) — there's no
    // separate permission check needed here on the guest side, since the
    // host already gated the wake itself on system:background before
    // this sandbox was even created.
    if (msg.type === 'nova:background:wake:response') {
      for (let w = 0; w < backgroundWakeListeners.length; w++) {
        try { backgroundWakeListeners[w](msg.result || {}); } catch (_) {}
      }
      // v2 wake handlers (novaOS.background.onWake) — same push, fanned out
      // to the facade's own listener array (declared by the embedded facade
      // source below) independently of the v1 registrations.
      for (let w = 0; w < novaOSWakeListeners.length; w++) {
        try { novaOSWakeListeners[w](msg.result || {}); } catch (_) {}
      }
      return;
    }

    // Pushed fs watch events (novaOS.fs.watch) — dispatched to listeners
    // registered per-watcherId via the facade's callback.
    if (msg.type === 'nova:fs:changed:response' && msg.result && msg.result.watcherId) {
      const cbs = fsWatchListeners[msg.result.watcherId] || [];
      for (let k = 0; k < cbs.length; k++) {
        try { cbs[k](msg.result); } catch (error) { console.error('fs watch listener failed:', error); }
      }
      return;
    }

    // Pushed alarm fires (novaOS.alarms) — fanned out to every onAlarm
    // listener, like background wakes.
    if (msg.type === 'nova:background:alarm:response' && msg.result) {
      for (let w = 0; w < alarmListeners.length; w++) {
        try { alarmListeners[w](msg.result); } catch (error) { console.error('Alarm listener failed:', error); }
      }
      return;
    }

    // Pushed inbound shares (novaOS.share.onInbound) — delivered only to
    // apps the user explicitly picked in the share sheet.
    if (msg.type === 'nova:share:inbound:response' && msg.result) {
      for (let w = 0; w < shareInboundListeners.length; w++) {
        try { shareInboundListeners[w](msg.result); } catch (error) { console.error('Share inbound listener failed:', error); }
      }
      return;
    }

    // Pushed server messages (novaOS.push.onMessage) — the delivery ladder
    // already re-checked push:receive host-side before this push existed.
    if (msg.type === 'nova:push:message:response' && msg.result) {
      for (let w = 0; w < pushListeners.length; w++) {
        try { pushListeners[w](msg.result); } catch (error) { console.error('Push message listener failed:', error); }
      }
      return;
    }

    if (typeof msg.requestId !== 'string') return;
    const entry = pendingRequests.get(msg.requestId);
    if (!entry) return;
    pendingRequests.delete(msg.requestId);
    clearTimeout(entry.timer);
    if (msg.error) {
      entry.reject(Object.assign(new Error(msg.error.message || 'IPC error'), msg.error));
      return;
    }

    // Merge result fields onto the top level too, since some app code
    // (see createDefaultAppShell) reads handshake fields directly off
    // the response rather than through a result wrapper.
    const out = Object.assign({}, msg.result, { result: msg.result, type: msg.type });
    entry.resolve(out);

    // Ready-handshake fix: surface permissions on window for
    // late-loading scripts, and re-render the calendar once DOM is
    // ready, same as the old dedicated 'nova:ready:response' handler
    // used to do before nova:ready went through the normal ipc() path.
    if (msg.type === 'nova:ready:response' && msg.result) {
      try {
        window.__novaPermResponse = {
          permissions: msg.result.permissions || [],
          optionalPermissions: msg.result.optionalPermissions || [],
        };
      } catch (_) {}
      let renderFn = null;
      try { renderFn = (typeof renderCalendar === 'function') ? renderCalendar : null; } catch (_) {}
      if (renderFn) {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', function _rr() {
            document.removeEventListener('DOMContentLoaded', _rr);
            try { renderFn(); } catch (_) {}
          });
        } else {
          try { renderFn(); } catch (_) {}
        }
      }
    }
  }

  // Responses (and pushed events) arrive on hostPort.onmessage, wired up
  // in the claim-port-ack handshake above the moment the port is received —
  // no separate listener needed here. Replaces the old setInterval-based
  // drainInbox() poller (push-based now, via the isolated script's own
  // poll of window.__novaInbox forwarding over the port) and the tagged
  // window.postMessage listener this shim used before the MessageChannel
  // handoff (forgeable by any main-world script — see the BRIDGE_MARKER
  // comment above for why that mattered).

  // Download interceptor
  // <webview> tags can't hand a blob: URL to the host — blob URLs are
  // memory-backed and scoped to the browsing context that created them,
  // so window.parent has no way to dereference one even if it has the
  // string. What CAN cross the boundary is the blob's actual bytes.
  //
  // We override the native click() on <a download> elements pointing at
  // blob: URLs: read the blob back out with fetch() (same-context, so
  // this works), base64-encode it, and ship the bytes to the host over
  // the existing IPC bridge. The host does the real save-as. Apps using
  // the standard createObjectURL + <a download> + click() pattern need
  // no changes — this is transparent.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  // Captured here, before the network-permission override further down
  // replaces window.fetch with a version that routes everything through
  // nova:net:fetch. blob: URLs aren't network requests — routing them
  // through that bridge sends the literal string "blob:..." to the host
  // as if it were a fetchable resource, which always fails. This
  // interceptor needs the real, unpatched fetch to read blob bytes
  // in-context, so grab it now while it's still native.
  // Guarded: this shim's IIFE has no outer try/catch, and this line runs
  // unconditionally near the very top of the guest's first script — if
  // window.fetch isn't available yet at this exact point (confirmed
  // reproducible: a TypeError here throws with nothing to catch it,
  // which aborts the rest of this script, including the IPC bridge setup
  // that runs after it), the whole shim silently fails to initialize.
  // Falling back to a no-op means blob: downloads via <a download> won't
  // work until fetch exists, but everything else in the shim still loads.
  const nativeFetchForDownloads = (typeof window.fetch === 'function')
    ? window.fetch.bind(window)
    : function() { return Promise.reject(new TypeError('fetch unavailable at shim init time')); };
  HTMLAnchorElement.prototype.click = function() {
    const href = this.href || '';
    const filename = this.download;
    if (filename && href.indexOf('blob:') === 0) {
      nativeFetchForDownloads(href)
        .then(function(res) { return res.blob(); })
        .then(function(blob) {
          const reader = new FileReader();
          reader.onload = function() {
            // reader.result is a data URL: "data:<mime>;base64,<data>"
            const result = String(reader.result || '');
            const commaIdx = result.indexOf(',');
            const base64Data = commaIdx >= 0 ? result.slice(commaIdx + 1) : '';
            ipc('nova:download', {
              filename: filename,
              mimeType: blob.type || 'application/octet-stream',
              base64Data: base64Data
            }).catch(function(err) {
              console.error('Download interceptor: download failed', err);
            });
          };
          reader.onerror = function() {
            console.error('Download interceptor: failed to read blob for download');
          };
          reader.readAsDataURL(blob);
        })
        .catch(function(err) {
          console.error('Download interceptor: failed to fetch blob for download', err);
        });
      return; // suppress the native click — it would just navigate/no-op
    }
    return nativeAnchorClick.call(this);
  };

  // Registered onEvent callbacks, checked by the inbox poller whenever a
  // pushed 'nova:events:event' notification arrives (the host pushes
  // these unprompted, not in response to a specific ipc() call, so they
  // need their own dispatch rather than the requestId-keyed one above).
  const eventListeners = {}; // eventName -> [callback, ...]
  const overlayListeners = [];
  const appearanceListeners = [];
  const ipcRequestHandlers = new Map();
  const ipcBroadcastListeners = new Map();
  let appearanceSubscriptionPromise = null;
  const launchListeners = [];

  // Callbacks registered via window.nova.onBackgroundWake(). Plain array,
  // not keyed by name — there's exactly one wake channel per sandbox
  // instance (this whole sandbox exists only for the duration of one wake
  // cycle; see AppScheduler.wake), unlike eventListeners above which fans
  // out across many different named OS events in a long-lived window.
  const backgroundWakeListeners = [];

  // wsId -> { message: [cb,...], error: [cb,...], close: [cb,...] }
  // Populated by window.nova.websocket(); read by the inbox poller above.
  const wsEventListeners = {};

  // watcherId -> [callback, ...] — populated by novaOS.fs.watch(); the
  // pushed nova:fs:changed events fan out to the matching watcher's
  // callbacks. Same lifecycle as wsEventListeners above.
  const fsWatchListeners = {};

  // Callbacks registered via novaOS.alarms.onAlarm() — the host pushes
  // nova:background:alarm events (fire + queued-after-launch delivery).
  const alarmListeners = [];

  // Callbacks registered via novaOS.share.onInbound() — pushed
  // nova:share:inbound events (user-mediated share-target delivery).
  const shareInboundListeners = [];

  // Callbacks registered via novaOS.push.onMessage() — pushed
  // nova:push:message events (delivery-ladder output from the OS push
  // service: live, woken, and queued-after-launch deliveries all land
  // here as the same shape).
  const pushListeners = [];

  ipc.provide = function(endpoint, handler) {
    if (typeof handler !== 'function') return Promise.reject(new TypeError('handler must be a function'));
    if (ipcRequestHandlers.has(endpoint)) return Promise.reject(new TypeError('endpoint is already registered'));
    ipcRequestHandlers.set(endpoint, handler);
    return ipc('nova:ipc:register', { endpoint: endpoint }).then(function() {
      return function() {
        ipcRequestHandlers.delete(endpoint);
        return ipc('nova:ipc:unregister', { endpoint: endpoint });
      };
    }, function(error) {
      ipcRequestHandlers.delete(endpoint);
      throw error;
    });
  };
  ipc.call = function(targetAppId, endpoint, data) {
    return ipc('nova:ipc:invoke', { targetAppId: targetAppId, endpoint: endpoint, data: data });
  };
  ipc.broadcast = function(action, data) {
    return ipc('nova:ipc:broadcast', { action: action, data: data });
  };
  ipc.onBroadcast = function(action, callback) {
    if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
    let listeners = ipcBroadcastListeners.get(action);
    if (!listeners) {
      listeners = new Set();
      ipcBroadcastListeners.set(action, listeners);
    }
    listeners.add(callback);
    return ipc('nova:ipc:broadcast:subscribe', { action: action }).then(function() {
      return function() {
        listeners.delete(callback);
        if (listeners.size === 0) {
          ipcBroadcastListeners.delete(action);
          return ipc('nova:ipc:broadcast:unsubscribe', { action: action });
        }
      };
    }, function(error) {
      listeners.delete(callback);
      if (listeners.size === 0) ipcBroadcastListeners.delete(action);
      throw error;
    });
  };

  // Public API for apps that want to use the bridge directly.
  window.nova = {
    ipc: ipc,
    files: {
      open: function(options) { return ipc('nova:files:open', options || {}); },
      save: function(options) { return ipc('nova:files:save', options || {}); },
    },
    share: function(data) { return ipc('nova:share', data || {}); },
    data: {
      /* Data portability over this app's OWN namespace. export/import move
         targeted subsets (data:export); backup/restore move the whole
         namespace (data:backup). Envelopes are checksummed and pinned to
         the calling appId — restore/import refuse another app's envelope. */
      export: function(options) { return ipc('nova:data:export', options || {}); },
      import: function(envelope) { return ipc('nova:data:import', { envelope: envelope }); },
      backup: function() { return ipc('nova:data:backup', {}); },
      restore: function(envelope, options) {
        return ipc('nova:data:restore', Object.assign({ envelope: envelope }, options || {}));
      },
    },
    appearance: {
      get: function() { return ipc('nova:appearance:get', {}); },
      set: function(appearance) { return ipc('nova:appearance:set', { appearance: appearance || {} }); },
      onChange: function(callback) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback must be a function'));
        if (appearanceListeners.includes(callback)) return Promise.reject(new TypeError('callback is already subscribed'));
        appearanceListeners.push(callback);
        if (!appearanceSubscriptionPromise) {
          appearanceSubscriptionPromise = ipc('nova:appearance:subscribe', {}).catch(error => {
            appearanceSubscriptionPromise = null;
            throw error;
          });
        }
        return appearanceSubscriptionPromise.then(function(result) {
          try { callback(result.appearance); }
          catch (error) { console.error('Appearance listener failed:', error); }
          return function() {
            const index = appearanceListeners.indexOf(callback);
            if (index >= 0) appearanceListeners.splice(index, 1);
            if (appearanceListeners.length === 0) {
              appearanceSubscriptionPromise = null;
              ipc('nova:appearance:unsubscribe', {}).catch(error => console.error(error));
            }
          };
        }, function(error) {
          const index = appearanceListeners.indexOf(callback);
          if (index >= 0) appearanceListeners.splice(index, 1);
          throw error;
        });
      },
    },
    // Top-level app-facing surfaces, documented in NOVAAPP.md as
    // window.nova.overlay.* and window.nova.contextMenu.*. They must stay
    // siblings of the appearance object — a misplaced brace used to nest
    // them inside it, so both were undefined for every app (overlay.show
    // and onEvent threw "Cannot read properties of undefined").
    contextMenu: {
      show: function(x, y, items) {
        return ipc('nova:context-menu:show', { x: x, y: y, items: items });
      },
      hide: function() {
        return ipc('nova:context-menu:hide', {});
      },
    },
    overlay: {
      show: function(options) {
        return ipc('nova:overlay:show', options || {});
      },
      hide: function() {
        return ipc('nova:overlay:hide', {});
      },
      onEvent: function(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        overlayListeners.push(callback);
        return function() {
          const index = overlayListeners.indexOf(callback);
          if (index >= 0) overlayListeners.splice(index, 1);
        };
      },
    },
    app: {
      getInfo: function() { return ipc('nova:ready', {}); },
      launch: function(appId, options) {
        return ipc('nova:app:launch', { appId: appId, options: options || {} });
      },
      getLaunchOptions: function() {
        try { return Promise.resolve(JSON.parse(JSON.stringify(window.__NOVA_APP_OPTIONS__ || {}))); }
        catch (error) { return Promise.reject(error); }
      },
      onLaunch: function(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        launchListeners.push(callback);
        const options = window.__NOVA_APP_OPTIONS__ || {};
        queueMicrotask(() => {
          if (launchListeners.includes(callback)) {
            try { callback({ options: JSON.parse(JSON.stringify(options)), reason: 'launch' }); }
            catch (error) { console.error('App launch listener failed:', error); }
          }
        });
        return function() {
          const index = launchListeners.indexOf(callback);
          if (index >= 0) launchListeners.splice(index, 1);
        };
      },
      onStateChange: function(callback) {
        if (typeof callback !== 'function') throw new TypeError('callback must be a function');
        const sendState = () => {
          try {
            callback({
              visible: document.visibilityState === 'visible',
              focused: typeof document.hasFocus === 'function' && document.hasFocus(),
            });
          } catch (error) {
            console.error('App state listener failed:', error);
          }
        };
        const listener = () => sendState();
        document.addEventListener('visibilitychange', listener);
        window.addEventListener('focus', listener);
        window.addEventListener('blur', listener);
        sendState();
        return function() {
          document.removeEventListener('visibilitychange', listener);
          window.removeEventListener('focus', listener);
          window.removeEventListener('blur', listener);
        };
      },
    },
    home: {
      openDefaultAppsSettings: function() {
        return ipc('nova:home:openDefaultAppsSettings', {});
      },
      apps: {
        list: function() {
          return ipc('nova:home:apps:list', {});
        },
        launch: function(appId) {
          return ipc('nova:home:apps:launch', { appId: appId });
        },
      },
    },
    wallpaper: {
      set: function(key, value) {
        return ipc('nova:wallpaper:set', { key: key, value: value });
      }
    },
    requestPermission: function(permission, reason) {
      return ipc('nova:request-permission', { permission: permission, reason: reason });
    },
    openUrl: function(url) {
      return ipc('nova:open-url', { url: url });
    },
    openWith: function(fileId) {
      return ipc('nova:open-with', { fileId: fileId });
    },
    onEvent: function(eventName, callback) {
      if (!eventListeners[eventName]) eventListeners[eventName] = [];
      eventListeners[eventName].push(callback);
      // Subscribe ONCE per event name. The host holds a single
      // subscription per sandbox and pushes each occurrence to this
      // document, where the shim fans it out to every registered callback
      // (the eventListeners array above). Re-sending nova:events:subscribe
      // for each added listener made the host reject every call after the
      // first with ALREADY_SUBSCRIBED — the new listener never fired and
      // the returned promise rejected (an unhandled rejection in any app
      // that didn't .catch() it, since onEvent is addEventListener-shaped
      // and callers expect stacking listeners to work).
      if (eventListeners[eventName].length === 1) {
        return ipc('nova:events:subscribe', { event: eventName });
      }
      return Promise.resolve({ success: true, subscribed: eventName });
    },
    // system:background scheduled-wake support. The host only ever spins
    // up a sandbox for a wake cycle if the app holds system:background —
    // there's no separate permission call needed here, unlike most of the
    // rest of this API, since the wake happening at all IS the permission
    // check having already passed (see AppScheduler.wake). The callback
    // gets a bounded window (see wakeInfo.deadlineMs, matching the same
    // clock the host is timing the wake against) to do its work before the
    // host tears this sandbox down regardless — this is a brief scheduled
    // wake, not a way to stay alive; apps wanting to persist need
    // system:background:live instead, which is a different, bigger grant.
    onBackgroundWake: function(callback) {
      backgroundWakeListeners.push(callback);
    },
    // Lets a wake handler tell the host it finished early, so the host
    // doesn't have to sit through the full deadline before tearing the
    // sandbox down. Optional — if never called, the host just waits out
    // the deadline and tears down anyway.
    backgroundWakeDone: function() {
      return ipc('nova:background:wake-done', {});
    },
    // Opt this session into staying alive if the window closes (requires
    // system:background:live). Call with no args to enable, or
    // stayAliveInBackground(false) to change your mind before closing.
    // Session-only — call again next launch if you want it again.
    stayAliveInBackground: function(enabled) {
      return ipc('nova:background:stay-alive', { enabled: enabled !== false });
    },
    // Convenience wrapper around nova:net:websocket + ws:send/ws:close so
    // apps don't have to hand-roll requestId bookkeeping. Returns a promise
    // that resolves once the socket is open (mirrors host's onopen-only
    // response — see NOTE below) with a small handle object.
    //
    // NOTE: the host only ever resolves this ipc() call from the socket's
    // onopen handler. If the connection never opens (bad host, connection
    // refused, TLS failure before handshake), there is no host-side
    // reject path — the call will sit until the shim's own IPC timeout
    // fires and rejects with a generic "IPC request timed out" error
    // rather than a specific connection-failure reason. Callers should
    // treat that timeout as a real (if under-specific) connection failure,
    // not assume something is hung on the guest side.
    websocket: function(url, protocols) {
      return ipc('nova:net:websocket', { url: url, protocols: protocols }).then(function(res) {
        const wsId = res.wsId || (res.result && res.result.wsId);
        if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
        wsEventListeners[wsId] = { message: [], error: [], close: [] };
        return {
          wsId: wsId,
          readyState: res.readyState,
          onMessage: function(cb) { wsEventListeners[wsId].message.push(cb); },
          onError: function(cb) { wsEventListeners[wsId].error.push(cb); },
          onClose: function(cb) { wsEventListeners[wsId].close.push(cb); },
          send: function(data) { return ipc('nova:net:ws:send', { wsId: wsId, data: data }); },
          close: function(code, reason) { return ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }); },
        };
      });
    },
    // Camera/microphone can't be proxied through the IPC bridge like
    // geolocation coordinates — a MediaStream isn't serializable, and
    // nova:device:camera/microphone only check AppPermissionManager, they
    // don't (and can't) hand back a stream. So this wrapper does the
    // app-level check first, and only calls the real getUserMedia() here
    // in the guest's own document if that check passes. The browser-level
    // decision still happens separately, via this document's own
    // permissionrequest gate (see setupPermissionRequestGate's 'media'
    // branch in app-sandbox.js) when getUserMedia() itself is called.
    getUserMedia: function(constraints) {
      constraints = constraints || {};
      const needsCamera = !!constraints.video;
      const needsMic = !!constraints.audio;
      const checks = [];
      if (needsCamera) checks.push(ipc('nova:device:camera', {}));
      if (needsMic) checks.push(ipc('nova:device:microphone', {}));
      if (checks.length === 0) {
        return Promise.reject(new TypeError('getUserMedia requires at least one of video/audio in constraints'));
      }
      return Promise.all(checks).then(function() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          return Promise.reject(new TypeError('getUserMedia not available in this environment'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      });
      // Any PERMISSION_DENIED from the ipc() calls above rejects here
      // naturally (ipc() rejects on error responses), so callers see the
      // same app-level denial they'd get from any other nova:* call,
      // before ever reaching the browser's own permission prompt.
    },
    // Calendar/contacts read/write the SAME shared data the host
    // Calendar/Contacts apps use (not a per-app isolated store) — see the
    // handleCalendar*/handleContacts* comments in app-sandbox.js for why.
    calendar: {
      list: function() { return ipc('nova:calendar:read', {}); },
      save: function(event) { return ipc('nova:calendar:write', { event: event }); },
      remove: function(id) { return ipc('nova:calendar:delete', { id: id }); }
    },
    contacts: {
      list: function() { return ipc('nova:contacts:read', {}); },
      save: function(contact) { return ipc('nova:contacts:write', { contact: contact }); },
      remove: function(id) { return ipc('nova:contacts:delete', { id: id }); }
    },
    // list/uninstall are plain reads/writes on the app registry.
    // install fails closed on anything a human would normally need to
    // click through (untrusted signer, tampered contents, already
    // installed) — see the handleAppInstall comment in app-sandbox.js.
    apps: {
      list: function() { return ipc('nova:app:list', {}); },
      launch: function(appId, options) { return ipc('nova:app:launch', { appId: appId, options: options || {} }); },
      install: function(pkg) { return ipc('nova:app:install', { package: pkg }); },
      uninstall: function(appId) { return ipc('nova:app:uninstall', { appId: appId }); },
      // Sends the user to Settings -> Default Apps. category is an
      // optional hint (e.g. 'browser', 'texteditor') telling nook which
      // row to highlight — it does not change the default on the app's
      // own behalf. Meant to be called from a real button click; the host
      // rate-limits this call since a postMessage-based sandbox boundary
      // can't otherwise tell a click apart from a script loop.
      openDefaultAppsSettings: function(category) { return ipc('nova:app:openDefaultAppsSettings', { category: category || null }); }
    },
    // admin:* — requires both the per-app permission grant AND the
    // machine's local admin flag to be on (set in Settings). Granting an
    // app one of these permissions doesn't put the machine in admin mode
    // by itself.
    admin: {
      auditQuery: function(filters) { return ipc('nova:admin:audit', filters || {}); },
      systemGet: function() { return ipc('nova:admin:system', { action: 'get' }); },
      systemSet: function(settings) { return ipc('nova:admin:system', { action: 'set', settings: settings }); },
      usersList: function() { return ipc('nova:admin:users', { action: 'list' }); },
      usersRevoke: function(sessionId) { return ipc('nova:admin:users', { action: 'revoke', sessionId: sessionId }); },
      appsList: function() { return ipc('nova:admin:apps', {}); }
    },
    // mail:* reuses whatever account is connected in the host shell's
    // Email app (session-scoped) — there's no separate per-app mail
    // identity. Fails with UNAVAILABLE if nothing is connected.
    mail: {
      connect: function(account) { return ipc('nova:mail:session', { action: 'connect', account: account || {} }); },
      disconnect: function() { return ipc('nova:mail:session', { action: 'disconnect' }); },
      restore: function() { return ipc('nova:mail:session', { action: 'restore' }); },
      account: function() { return ipc('nova:mail:read', { action: 'account' }); },
      folders: function() { return ipc('nova:mail:read', { action: 'folders' }); },
      messages: function(opts) { return ipc('nova:mail:read', Object.assign({ action: 'messages' }, opts || {})); },
      message: function(uid, folder) { return ipc('nova:mail:read', { action: 'message', uid: uid, folder: folder }); },
      search: function(query, folder) { return ipc('nova:mail:read', { action: 'search', query: query, folder: folder }); },
      preview: function(html) { return ipc('nova:mail:write', { action: 'preview', html: html }); },
      markRead: function(uids, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'read', uids: uids, folder: folder }); },
      move: function(uids, dest, folder) { return ipc('nova:mail:write', { action: 'batch', op: 'move', uids: uids, dest: dest, folder: folder }); },
      send: function(msg) { return ipc('nova:mail:send', msg || {}); }, // msg: { to, cc, bcc, subject, text, html, smtpHost, smtpPort }
      remove: function(uids, folder) { return ipc('nova:mail:delete', { uids: uids, folder: folder }); },
      openLink: function(url) { return ipc('nova:email:open-link', { url: url }); }
    }
  };

  // Add a v2 facade without replacing or mutating the established v1 object.
  // Both API surfaces use the same secure IPC bridge and host-side services.
  ${buildNovaOSFacadeSource(budgets.httpBodyBytes)}

  // Self-triggered handshake — every app gets this automatically on load,
  // rather than needing to remember to call it. Runs the same
  // ready-handshake side effects (permissions surfaced on window,
  // calendar re-render) via the __novaInbox poller above once the
  // response arrives.
  ipc('nova:ready', {}).catch(function(e) {
    console.error('nova:ready handshake failed:', e);
  });

  // This guest page was loaded from window.location.origin + baseUrl + '/' +
  // app.entry (see loadAppContent below), where baseUrl is
  // '/api/apps/serve/<sandboxId>'. That means window.location.pathname
  // already starts with this sandbox's own serve prefix — capture it once,
  // here, before anything can reassign window.location, so novaFetchImpl
  // can recognize "this app fetching one of its own bundled files" (e.g.
  // Emscripten's glue code fetching its sibling module.wasm) as distinct
  // from a genuine outbound network request, without needing any IPC
  // round-trip or host-side lookup to tell the two apart.
  const ownSandboxPrefixMatch = /^(\\/api\\/apps\\/serve\\/[^/]+\\/)/.exec(window.location.pathname);
  const ownSandboxPrefix = ownSandboxPrefixMatch ? ownSandboxPrefixMatch[1] : null;

  // Override fetch — route through the IPC bridge.
  const novaFetchImpl = function(input, init) {
    init = init || {};
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);

    // Self-fetch exemption: a request the app is making for one of its own
    // registered files (e.g. Emscripten's glue code loading module.wasm via
    // plain fetch()) is not a network request — it's the same category of
    // same-origin asset load a <script src> or <img src> tag already makes
    // without any permission check. Without this, every app bundling
    // Emscripten/WASM output fails silently: the fetch gets routed through
    // nova:net:fetch, which requires a net:* permission grant for what is
    // actually just reading a file already inside this sandbox's own
    // package. Route those straight to the real fetch instead.
    if (ownSandboxPrefix) {
      let resolvedForSelfCheck;
      // window.location.href (full current URL, including path), not
      // window.location.origin (bare scheme+host) -- resolving a relative
      // URL like 'module.wasm' against just the origin drops the page's own
      // directory and produces '/module.wasm' at the server root instead of
      // '<ownSandboxPrefix>module.wasm', which silently failed this check
      // for every relative fetch (exactly the case Emscripten's glue makes).
      try { resolvedForSelfCheck = new URL(url, window.location.href); } catch { resolvedForSelfCheck = null; }
      if (
        resolvedForSelfCheck &&
        resolvedForSelfCheck.origin === window.location.origin &&
        resolvedForSelfCheck.pathname.indexOf(ownSandboxPrefix) === 0
      ) {
        return nativeFetchForDownloads(input, init);
      }
    }

    const method = (init.method || (input && input.method) || 'GET').toUpperCase();
    const headers = init.headers || (input && input.headers) || {};
    const headerObj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach(function(v, k) { headerObj[k] = v; });
    } else if (Array.isArray(headers)) {
      headers.forEach(function(pair) { headerObj[pair[0]] = pair[1]; });
    } else if (headers && typeof headers === 'object') {
      for (const k in headers) if (Object.prototype.hasOwnProperty.call(headers, k)) headerObj[k] = headers[k];
    }
    const body = init.body != null ? init.body : null;
    let bodyStr = null;
    if (typeof body === 'string') bodyStr = body;
    else if (body instanceof ArrayBuffer) bodyStr = new TextDecoder().decode(body);
    else if (body instanceof Uint8Array) bodyStr = new TextDecoder().decode(body);
    else if (body == null) bodyStr = null;
    else bodyStr = String(body);

    const bodyEncoding = init.bodyEncoding === 'base64' ? 'base64' : 'utf8';
    return ipc('nova:net:fetch', { url: url, method: method, headers: headerObj, body: bodyStr, bodyEncoding: bodyEncoding })
      .then(function(res) {
        if (!res || !res.success) throw new TypeError('Fetch failed');
        const responseInit = { status: res.status, statusText: res.statusText, headers: new Headers(res.headers || {}) };
        let responseBody = res.body || '';
        if (res.bodyEncoding === 'base64') {
          const binary = atob(responseBody);
          responseBody = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) responseBody[i] = binary.charCodeAt(i);
        }
        return new Response(responseBody, responseInit);
      });
  };

  // fetch/XMLHttpRequest/WebSocket are locked down with defineProperty
  // (writable: false, configurable: false) after both are defined below,
  // rather than plain 'window.fetch = ...' assignment. A plain assignment
  // is trivially reversible with 'delete window.fetch', since fetch isn't
  // a native own-property of window (it lives on Window.prototype) — the
  // delete just unshadows the real implementation underneath. Locking
  // these down doesn't change behavior for any app going through the
  // override normally; it only stops an app from un-shadowing the native
  // fetch/XHR/WebSocket to bypass nova:net:* permission checks entirely.

  // XMLHttpRequest-compatible bridge for common async requests. Callbacks set
  // through onload/onerror/onreadystatechange and addEventListener share the
  // same dispatch path. Binary/FormData bodies are encoded explicitly because
  // IPC payloads are JSON and cannot carry raw ArrayBuffers or Blobs.
  function NovaXHR() {
    const xhr = this;
    let method = 'GET', url = '', headers = {}, sent = false;
    let state = 0, aborted = false, timedOut = false, timer = null;
    let status = 0, statusText = '', responseText = '', responseBytes = null;
    let responseHeaders = {}, responseHeadersText = '';
    const listeners = Object.create(null);
    ['readystatechange', 'loadstart', 'load', 'error', 'timeout', 'abort', 'loadend', 'progress'].forEach(function(type) {
      listeners[type] = [];
    });

    function fire(type, event) {
      const ev = event || { type: type, target: xhr, currentTarget: xhr, lengthComputable: false, loaded: 0, total: 0 };
      const propertyHandler = xhr['on' + type];
      if (typeof propertyHandler === 'function') {
        try { propertyHandler.call(xhr, ev); } catch (e) { setTimeout(function() { throw e; }, 0); }
      }
      (listeners[type] || []).slice().forEach(function(handler) {
        try { handler.call(xhr, ev); } catch (e) { setTimeout(function() { throw e; }, 0); }
      });
    }

    function changeState(next) {
      state = next;
      fire('readystatechange');
    }

    function finishTimer() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
    }

    function bytesToBase64(bytes) {
      // Keep browser-to-host IPC and the matching server proxy within one
      // bounded binary-request size. Fail explicitly rather than truncating.
      if (bytes.length > __NOVA_MAX_BODY_BYTES__) throw new RangeError('XHR request body exceeds the ' + Math.round(__NOVA_MAX_BODY_BYTES__ / (1024 * 1024)) + ' MiB limit');
      let binary = '';
      // Chunking avoids argument-count and call-stack limits for large bodies.
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length));
        for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
      }
      return btoa(binary);
    }

    function safeHeaderValue(value) {
      return String(value).replace(/[\\r\\n]/g, '');
    }

    function setHeaderIfMissing(name, value) {
      const lower = name.toLowerCase();
      if (!Object.keys(headers).some(function(key) { return key.toLowerCase() === lower; })) headers[name] = value;
    }

    async function normalizeBody(value) {
      if (value == null) return { body: null, bodyEncoding: 'utf8' };
      if (typeof value === 'string') return { body: value, bodyEncoding: 'utf8' };
      if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) {
        setHeaderIfMissing('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
        return { body: value.toString(), bodyEncoding: 'utf8' };
      }
      if (typeof FormData !== 'undefined' && value instanceof FormData) {
        const boundary = '----NovaXHR' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        const parts = [];
        for (const [rawName, entryValue] of value.entries()) {
          const name = safeHeaderValue(rawName).replace(/"/g, '%22');
          if (typeof Blob !== 'undefined' && entryValue instanceof Blob) {
            const filename = safeHeaderValue(entryValue.name || 'blob').replace(/"/g, '%22');
            parts.push('--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + name + '"; filename="' + filename + '"\\r\\n');
            parts.push('Content-Type: ' + (entryValue.type || 'application/octet-stream') + '\\r\\n\\r\\n');
            parts.push(entryValue);
            parts.push('\\r\\n');
          } else {
            parts.push('--' + boundary + '\\r\\nContent-Disposition: form-data; name="' + name + '"\\r\\n\\r\\n' + String(entryValue) + '\\r\\n');
          }
        }
        parts.push('--' + boundary + '--\\r\\n');
        const multipart = new Blob(parts, { type: 'multipart/form-data; boundary=' + boundary });
        if (multipart.size > __NOVA_MAX_BODY_BYTES__) throw new RangeError('XHR request body exceeds the ' + Math.round(__NOVA_MAX_BODY_BYTES__ / (1024 * 1024)) + ' MiB limit');
        const multipartBytes = new Uint8Array(await multipart.arrayBuffer());
        setHeaderIfMissing('Content-Type', 'multipart/form-data; boundary=' + boundary);
        return { body: bytesToBase64(multipartBytes), bodyEncoding: 'base64' };
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        if (value.size > __NOVA_MAX_BODY_BYTES__) throw new RangeError('XHR request body exceeds the ' + Math.round(__NOVA_MAX_BODY_BYTES__ / (1024 * 1024)) + ' MiB limit');
        if (value.type) setHeaderIfMissing('Content-Type', value.type);
        return { body: bytesToBase64(new Uint8Array(await value.arrayBuffer())), bodyEncoding: 'base64' };
      }
      if (value instanceof ArrayBuffer) {
        return { body: bytesToBase64(new Uint8Array(value)), bodyEncoding: 'base64' };
      }
      if (ArrayBuffer.isView(value)) {
        return { body: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)), bodyEncoding: 'base64' };
      }
      throw new TypeError('Unsupported XMLHttpRequest body type');
    }

    Object.defineProperty(this, 'readyState', { get: function() { return state; }, configurable: true });
    Object.defineProperty(this, 'status', { get: function() { return status; }, configurable: true });
    Object.defineProperty(this, 'statusText', { get: function() { return statusText; }, configurable: true });
    Object.defineProperty(this, 'responseText', {
      get: function() {
        if (xhr.responseType !== '' && xhr.responseType !== 'text') throw new Error('responseText is unavailable when responseType is not text');
        return responseText;
      }, configurable: true
    });
    Object.defineProperty(this, 'response', {
      get: function() {
        if (state < 3) return null;
        if (xhr.responseType === 'json') {
          if (!responseText) return null;
          try { return JSON.parse(responseText); } catch { return null; }
        }
        if (xhr.responseType === 'arraybuffer') return responseBytes ? responseBytes.slice(0) : new ArrayBuffer(0);
        if (xhr.responseType === 'blob') return new Blob([responseBytes || new ArrayBuffer(0)], { type: responseHeaders['content-type'] || '' });
        return responseText;
      }, configurable: true
    });
    Object.defineProperty(this, 'responseURL', { get: function() { return url; }, configurable: true });
    Object.defineProperty(this, 'responseXML', { get: function() { return null; }, configurable: true });
    this.responseType = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.upload = { addEventListener: function() {}, removeEventListener: function() {} };

    this.open = function(m, u, async) {
      if (async === false) throw new Error('Synchronous XMLHttpRequest is not supported by the Nova bridge');
      method = (m || 'GET').toUpperCase();
      if (!ALLOWED_XHR_METHODS.has(method)) throw new TypeError('Unsupported XMLHttpRequest method');
      url = String(u || '');
      headers = {};
      status = 0;
      statusText = '';
      responseText = '';
      responseBytes = null;
      responseHeaders = {};
      responseHeadersText = '';
      aborted = false;
      timedOut = false;
      sent = false;
      finishTimer();
      changeState(1);
    };

    this.setRequestHeader = function(name, value) {
      if (state !== 1 || sent) throw new Error('XMLHttpRequest is not in the OPENED state');
      const key = String(name);
      const existing = Object.keys(headers).find(function(item) { return item.toLowerCase() === key.toLowerCase(); });
      if (existing) headers[existing] += ', ' + safeHeaderValue(value);
      else headers[key] = safeHeaderValue(value);
    };

    this.getAllResponseHeaders = function() { return state < 2 ? '' : responseHeadersText; };
    this.getResponseHeader = function(name) {
      if (state < 2 || !name) return null;
      return responseHeaders[String(name).toLowerCase()] || null;
    };
    this.overrideMimeType = function(mime) { xhr._overrideMimeType = String(mime || ''); };
    this.addEventListener = function(type, handler) {
      if (typeof handler === 'function' && listeners[type]) listeners[type].push(handler);
    };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };
    this.dispatchEvent = function(event) {
      if (!event || typeof event.type !== 'string') return true;
      fire(event.type, event);
      return !event.defaultPrevented;
    };

    this.abort = function() {
      if (state === 0 || state === 4) { aborted = true; finishTimer(); return; }
      aborted = true;
      finishTimer();
      changeState(0);
      fire('abort');
      fire('loadend');
    };

    this.send = function(value) {
      if (state !== 1 || sent) throw new Error('XMLHttpRequest must be opened before send and sent only once');
      sent = true;
      aborted = false;
      timedOut = false;
      fire('loadstart');
      if (Number(xhr.timeout) > 0) {
        timer = setTimeout(function() {
          if (state === 4 || aborted) return;
          timedOut = true;
          aborted = true;
          state = 4;
          fire('readystatechange');
          fire('timeout');
          fire('loadend');
        }, Number(xhr.timeout));
      }
      (async function() {
        try {
          const encodedBody = (method === 'GET' || method === 'HEAD')
            ? { body: null, bodyEncoding: 'utf8' }
            : await normalizeBody(value);
          if (aborted) return;
          const res = await novaFetchImpl(url, {
            method: method,
            headers: headers,
            body: encodedBody.body,
            bodyEncoding: encodedBody.bodyEncoding,
          });
          if (aborted) return;
          status = res.status;
          statusText = res.statusText;
          responseHeaders = {};
          const headerLines = [];
          res.headers.forEach(function(v, k) {
            const lower = k.toLowerCase();
            responseHeaders[lower] = v;
            headerLines.push(k + ': ' + v);
          });
          responseHeadersText = headerLines.join('\\r\\n');
          if (responseHeadersText) responseHeadersText += '\\r\\n';
          changeState(2);
          const data = await res.arrayBuffer();
          if (aborted) return;
          responseBytes = data;
          try { responseText = new TextDecoder().decode(data); } catch { responseText = ''; }
          changeState(3);
          changeState(4);
          finishTimer();
          fire('load');
          fire('loadend');
        } catch (err) {
          if (aborted || timedOut) return;
          finishTimer();
          status = 0;
          statusText = '';
          responseText = '';
          responseBytes = null;
          changeState(4);
          fire('error', { type: 'error', target: xhr, currentTarget: xhr, error: err });
          fire('loadend');
        }
      })();
    };
  }
  const ALLOWED_XHR_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  // Override WebSocket — route through the IPC bridge instead of letting
  // the guest open a raw socket unmediated. This closes the gap where
  // 'new WebSocket(...)' bypassed nova:net:websocket's permission check
  // entirely: the fetch/XHR overrides below only ever covered fetch()/XHR,
  // never the native WebSocket constructor, so an app with zero granted
  // permissions could still open a live socket to any host RELAXED_CSP_META's
  // connect-src allows. Reuses the same wsId/wsEventListeners plumbing the
  // nova.websocket() convenience wrapper already uses (see setupAPIBridge),
  // so host-side event delivery (nova:net:ws:message/error/close) needs no
  // changes — this just gives the *native* constructor the same routing the
  // wrapper already had.
  function NovaWebSocket(url, protocols) {
    const self = this;
    let wsId = null;
    let readyState = 0; // CONNECTING
    const listeners = { open: [], message: [], error: [], close: [] };
    const bufferedBeforeOpen = []; // sends attempted before the IPC round-trip resolves

    Object.defineProperty(this, 'readyState', { get: function() { return readyState; }, configurable: true });
    Object.defineProperty(this, 'url', { value: typeof url === 'string' ? url : String(url), configurable: true });

    this.addEventListener = function(type, handler) { if (listeners[type]) listeners[type].push(handler); };
    this.removeEventListener = function(type, handler) {
      if (listeners[type]) listeners[type] = listeners[type].filter(function(h) { return h !== handler; });
    };
    // onopen/onmessage/onerror/onclose property-style handlers, mirrored
    // into the same listener arrays as addEventListener for consistency.
    ['open', 'message', 'error', 'close'].forEach(function(evt) {
      let handler = null;
      Object.defineProperty(self, 'on' + evt, {
        get: function() { return handler; },
        set: function(fn) {
          if (handler) listeners[evt] = listeners[evt].filter(function(h) { return h !== handler; });
          handler = fn;
          if (typeof fn === 'function') listeners[evt].push(fn);
        },
        configurable: true
      });
    });

    this.send = function(data) {
      if (readyState !== 1) { bufferedBeforeOpen.push(data); return; }
      ipc('nova:net:ws:send', { wsId: wsId, data: data }).catch(function() { /* best-effort, matches native fire-and-forget semantics */ });
    };
    this.close = function(code, reason) {
      if (readyState === 2 || readyState === 3) return;
      readyState = 2; // CLOSING
      ipc('nova:net:ws:close', { wsId: wsId, code: code, reason: reason }).catch(function() { /* best-effort */ });
    };

    ipc('nova:net:websocket', { url: this.url, protocols: protocols })
      .then(function(res) {
        wsId = res.wsId || (res.result && res.result.wsId);
        if (!wsId) throw new Error('nova:net:websocket resolved without a wsId');
        readyState = 1; // OPEN
        wsEventListeners[wsId] = {
          message: [function(data) { listeners.message.forEach(function(h) { h.call(self, { data: data }); }); }],
          error: [function() { listeners.error.forEach(function(h) { h.call(self, {}); }); }],
          close: [function(info) {
            readyState = 3; // CLOSED
            listeners.close.forEach(function(h) { h.call(self, info || {}); });
            delete wsEventListeners[wsId];
          }]
        };
        bufferedBeforeOpen.splice(0).forEach(function(data) { self.send(data); });
        listeners.open.forEach(function(h) { h.call(self, {}); });
      })
      .catch(function() {
        readyState = 3; // CLOSED — connection never opened; host has no reject
        // path for this (see nova.websocket()'s NOTE above), so this only
        // fires once the shim's own IPC timeout elapses.
        listeners.error.forEach(function(h) { h.call(self, {}); });
        listeners.close.forEach(function(h) { h.call(self, {}); });
      });
  }
  NovaWebSocket.CONNECTING = 0;
  NovaWebSocket.OPEN = 1;
  NovaWebSocket.CLOSING = 2;
  NovaWebSocket.CLOSED = 3;

  // Lock down fetch/XHR/WebSocket so 'delete window.fetch' etc. can't
  // unshadow the native implementations underneath (fix #2). Plain
  // assignment (the old 'window.fetch = ...' / 'window.XMLHttpRequest = ...'
  // pattern) left these reversible with one line from guest code.
  [
    ['fetch', novaFetchImpl],
    ['XMLHttpRequest', NovaXHR],
    ['WebSocket', NovaWebSocket]
  ].forEach(function(pair) {
    Object.defineProperty(window, pair[0], { value: pair[1], writable: false, configurable: false });
  });

  // Fire-and-forget send: same port bridge as ipc(), but with no
  // pendingRequests entry since nothing here waits on a reply.
  function ipcFireAndForget(type, payload) {
    try {
      const id = generateId();
      sendOverPort({ kind: 'request', type: type, payload: payload, requestId: id });
    } catch { /* best-effort */ }
  }

  // Audit eval calls. This wrapper is now effectively dead code for direct
  // eval() — the CSP no longer includes 'unsafe-eval', so the browser
  // itself throws a CSP violation before this function body ever runs.
  // Left in place (harmless) in case CSP is ever relaxed again; if you're
  // reading this because eval() calls aren't being logged, check whether
  // 'unsafe-eval' is back in RELAXED_CSP_META first.
  // NOTE: this only ever wrapped window.eval — new Function(...) is a
  // separate code-execution path that was never audited here, and is now
  // blocked by the same CSP change rather than logged.
  const originalEval = window.eval;
  window.eval = function(code) {
    const preview = String(code).slice(0, 200);
    ipcFireAndForget('nova:audit:eval', { preview: preview });
    // Wrapping eval in a function makes this indirect eval regardless of
    // how it's called — direct eval's special-case only applies to a
    // bare eval(...) call, not to a function wrapper. Indirect eval
    // runs in global scope, which is what we want here since the audit
    // hook shouldn't capture the calling function's local scope.
    return (0, originalEval)(code);
  };

  // Override sendBeacon — fire-and-forget POST through the IPC bridge.
  // Returns true synchronously to match the native API contract; the actual
  // permission check happens host-side and the result is dropped.
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      try {
        const body = typeof data === 'string' ? data : (data && data.toString ? data.toString() : '');
        ipcFireAndForget('nova:net:fetch', { url: url, method: 'POST', headers: {}, body: body });
        return true;
      } catch {
        return false;
      }
    };
  }

  // Nested <webview> lockdown
  //
  // A <webview> tag the guest's OWN content creates is a second, independent
  // renderer process this guest would control directly — a much bigger
  // capability than anything else this shim gates, since none of the outer
  // sandbox's own webview attributes (nodeintegration, partition, sandbox
  // tokens) apply to a tag the guest instantiates itself. Blocked by
  // default; only mediated when the host baked in
  // __NOVA_NESTED_WEBVIEW_OPTED_IN__ = true for this package. Every operation
  // is still checked against the current sandbox:nested-webview grant.
  //
  // Three insertion paths are covered, since blocking only one leaves the
  // others wide open:
  //   1. document.createElement('webview') — the normal, scriptable path.
  //   2. innerHTML / outerHTML / insertAdjacentHTML — the HTML parser can
  //      create a <webview> without ever calling createElement.
  //   3. A MutationObserver backstop — catches anything that slips past
  //      1/2 (e.g. a future API, or a parser edge case), by removing any
  //      <webview> element the instant it's actually attached to the DOM.
  //
  // Historical nested-webview crash report; the delay mitigation is removed.
  // The implementation below routes permitted webviews through host siblings,
  // so the guest renderer never instantiates a second native webview.
  //
  // The old navigation delay was only a timing workaround and still created
  // a native guest inside the app's guest. The proxy below instead creates
  // permitted native webviews as siblings of the outer app webview.
  if (__NOVA_NESTED_WEBVIEW_OPTED_IN__) {
    const originalCreateElementForNav = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
      const el = originalCreateElementForNav.call(this, tagName, options);
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        const srcDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'src')
          || Object.getOwnPropertyDescriptor(Element.prototype, 'src');
        // Fall back to plain attribute get/set if this build's <webview>
        // doesn't expose src as an accessor property (still functionally
        // correct, just without the descriptor's own get/set semantics).
        const nativeGetSrc = srcDesc && srcDesc.get
          ? function() { return srcDesc.get.call(el); }
          : function() { return el.getAttribute('src'); };
        const nativeSetSrc = srcDesc && srcDesc.set
          ? function(v) { srcDesc.set.call(el, v); }
          : function(v) { el.setAttribute('src', v); };

        try {
          Object.defineProperty(el, 'src', {
            get: nativeGetSrc,
            set: function(value) { nativeSetSrc(value); },
            configurable: true,
          });
        } catch (e) {
          // If defineProperty fails for any reason (unexpected element
          // shape, frozen prototype, etc.), fail open to the original,
          // undelayed behavior rather than leaving .src unusable. Uses
          // console.warn directly (not the host-side log() helper — this
          // code runs inside the guest's own injected shim, a different
          // scope, where that helper doesn't exist).
          console.warn('Could not wrap nested webview src for nav delay:', e);
        }
      }
      return el;
    };
  }

  if (__NOVA_NESTED_WEBVIEW_OPTED_IN__) {
    const nativeCreateElement = Document.prototype.createElement;
    const nestedProxies = new Map();
    window.__novaNestedWebviewProxies = nestedProxies;
    let nestedSequence = 0;

    function scheduleNestedBounds(proxy) {
      if (proxy.__boundsScheduled) return;
      proxy.__boundsScheduled = true;
      requestAnimationFrame(function() {
        proxy.__boundsScheduled = false;
        if (!proxy.isConnected || !proxy.__hostReady) return;
        const rect = proxy.getBoundingClientRect();
        const style = getComputedStyle(proxy);
        const bounds = {
          left: Math.max(0, rect.left),
          top: Math.max(0, rect.top),
          width: Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)),
          height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top)),
          visible: !proxy.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          zIndex: style.zIndex === 'auto' ? 1 : Number(style.zIndex)
        };
        if (proxy.__lastBounds && Object.keys(bounds).every(key => proxy.__lastBounds[key] === bounds[key])) return;
        proxy.__lastBounds = bounds;
        ipc('nova:nested-webview', { action: 'bounds', id: proxy.__nestedId, bounds })
          .catch(error => console.error('Nested webview bounds update failed:', error));
      });
    }

    class NovaNestedWebview extends HTMLElement {
      constructor() {
        super();
        this.__nestedId = 'nvw_' + Date.now().toString(36) + '_' + (++nestedSequence).toString(36);
      }
      connectedCallback() {
        if (this.__created) return;
        if (!this.style.display) this.style.display = 'block';
        this.__created = true;
        nestedProxies.set(this.__nestedId, this);
        const attributes = {};
        for (const name of ['allowfullscreen', 'allowpopups', 'src', 'partition']) {
          const value = this.getAttribute(name);
          if (value !== null) attributes[name] = value;
        }
        if (attributes.src && __NOVA_PENDING_INITIAL_URL__) {
          attributes.src = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        this.__createPromise = ipc('nova:nested-webview', { action: 'create', id: this.__nestedId, attributes })
          .then(() => { this.__hostReady = true; scheduleNestedBounds(this); });
        this.__createPromise.catch(error => console.error('Nested webview creation failed:', error));
        this.__resizeObserver = new ResizeObserver(() => scheduleNestedBounds(this));
        this.__resizeObserver.observe(this);
        this.__mutationObserver = new MutationObserver(() => scheduleNestedBounds(this));
        this.__mutationObserver.observe(this, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
      disconnectedCallback() {
        this.__resizeObserver?.disconnect();
        this.__mutationObserver?.disconnect();
        if (!this.__created) return;
        this.__created = false;
        this.__hostReady = false;
        nestedProxies.delete(this.__nestedId);
        ipc('nova:nested-webview', { action: 'destroy', id: this.__nestedId }).catch(() => {});
      }
      setAttribute(name, value) {
        const key = String(name).toLowerCase();
        if (key === 'src' && __NOVA_PENDING_INITIAL_URL__) {
          value = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        super.setAttribute(name, value);
        if (this.__created && ['allowfullscreen', 'allowpopups', 'src', 'partition'].includes(key)) {
          ipc('nova:nested-webview', { action: 'attribute', id: this.__nestedId, name: key, value: String(value) })
            .catch(error => console.error('Nested webview attribute update failed:', error));
        }
        scheduleNestedBounds(this);
      }
      removeAttribute(name) {
        super.removeAttribute(name);
        const key = String(name).toLowerCase();
        if (this.__created && ['allowfullscreen', 'allowpopups', 'src', 'partition'].includes(key)) {
          ipc('nova:nested-webview', { action: 'attribute', id: this.__nestedId, name: key, remove: true })
            .catch(error => console.error('Nested webview attribute update failed:', error));
        }
        scheduleNestedBounds(this);
      }
      get src() { return this.getAttribute('src') || ''; }
      set src(value) { this.setAttribute('src', value); }
      getURL() { return this.src; }
      navigate(url) {
        super.setAttribute('src', String(url));
        return ipc('nova:nested-webview', {
          action: 'attribute', id: this.__nestedId, name: 'src', value: String(url)
        });
      }
      executeScript(details, callback) {
        const result = ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command: 'executeScript', details: details || {} });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      insertCSS(details, callback) {
        const result = ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command: 'insertCSS', details: details || {} });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      reload() { return this.__command('reload'); }
      back() { return this.__command('back'); }
      forward() { return this.__command('forward'); }
      stop() { return this.__command('stop'); }
      canGoBack() { return this.__queryCommand('canGoBack'); }
      canGoForward() { return this.__queryCommand('canGoForward'); }
      find(query, options) {
        return ipc('nova:nested-webview', {
          action: 'command', id: this.__nestedId, command: 'find',
          query, options: options || {}
        });
      }
      stopFinding(action) { return this.__valueCommand('stopFinding', action || 'clear'); }
      setUserAgentOverride(userAgent) { return this.__valueCommand('setUserAgentOverride', userAgent); }
      setZoom(value) { return this.__valueCommand('setZoom', value); }
      setZoomMode(value) { return this.__valueCommand('setZoomMode', value); }
      clearData(options, types, callback) {
        const result = ipc('nova:nested-webview', {
          action: 'command', id: this.__nestedId, command: 'clearData', types: types || []
        });
        if (typeof callback === 'function') result.then(callback, error => console.error(error));
        return result;
      }
      __command(command) {
        return ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command });
      }
      __queryCommand(command) {
        return this.__command(command).then(result => result?.value === true);
      }
      __attachPopup(popupId) {
        return Promise.resolve(this.__createPromise).then(() => ipc('nova:nested-webview', {
          action: 'attach-popup', id: this.__nestedId, popupId
        }));
      }
      __valueCommand(command, value) {
        return ipc('nova:nested-webview', { action: 'command', id: this.__nestedId, command, value });
      }
      /* Freeze the guest into a still frame (captured via capturePage) and
         hide the live surface, so the app's own DOM can composite above the
         frozen page. Guests always render above host DOM regardless of
         z-index, so this is the only way to layer under host pixels while
         keeping the page visible. */
      setOverlayActive(active) {
        return ipc('nova:nested-webview', { action: active === true ? 'freeze' : 'unfreeze', id: this.__nestedId });
      }
      /* Interactive annotation layer — a canvas the host injects INTO the
         guest document, because host DOM can never render above a guest. */
      setAnnotationLayer(options) {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'enable', options: options || {} });
      }
      updateAnnotationLayer(patch) {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'style', options: patch || {} });
      }
      setAnnotationActive(active) {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'active', active: active === true });
      }
      clearAnnotationLayer() {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'clear' });
      }
      undoAnnotationLayer() {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'undo' });
      }
      exportAnnotationLayer() {
        return ipc('nova:nested-webview', { action: 'annotation', id: this.__nestedId, command: 'export' });
      }
    }

    customElements.define('nova-nested-webview', NovaNestedWebview);
    const proxyStyle = nativeCreateElement.call(document, 'style');
    proxyStyle.textContent = 'nova-nested-webview{display:block;width:100%;height:100%;}nova-nested-webview[hidden]{display:none!important;}';
    document.documentElement.appendChild(proxyStyle);
    Document.prototype.createElement = function(tagName, options) {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        return nativeCreateElement.call(this, 'nova-nested-webview', options);
      }
      return nativeCreateElement.call(this, tagName, options);
    };
    window.addEventListener('resize', () => nestedProxies.forEach(scheduleNestedBounds));
    window.addEventListener('scroll', () => nestedProxies.forEach(scheduleNestedBounds), true);
    const boundsObserver = new MutationObserver(() => nestedProxies.forEach(scheduleNestedBounds));
    boundsObserver.observe(document.documentElement, { childList: true, subtree: true });

    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerHTMLDesc?.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: innerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            value = value.replace(/<webview(?=[\\s>])/gi, '<nova-nested-webview')
              .replace(/<\\/webview\\s*>/gi, '</nova-nested-webview>');
          }
          return innerHTMLDesc.set.call(this, value);
        },
        configurable: true
      });
    }
    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    function rewriteNestedWebviewMarkup(value) {
      return value.replace(/<webview(?=[\\s>])/gi, '<nova-nested-webview')
        .replace(/<\\/webview\\s*>/gi, '</nova-nested-webview>');
    }
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (typeof text === 'string' && /<webview[\\s>]/i.test(text)) {
        text = rewriteNestedWebviewMarkup(text);
      }
      return originalInsertAdjacentHTML.call(this, position, text);
    };
    const outerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'outerHTML');
    if (outerHTMLDesc?.set) {
      Object.defineProperty(Element.prototype, 'outerHTML', {
        get: outerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            value = rewriteNestedWebviewMarkup(value);
          }
          return outerHTMLDesc.set.call(this, value);
        },
        configurable: true
      });
    }
    function replaceNativeWebview(node) {
      const proxy = nativeCreateElement.call(document, 'nova-nested-webview');
      const attrs = Array.from(node.attributes || []);
      const src = node.getAttribute('src');
      node.removeAttribute('src');
      for (const attr of attrs) proxy.setAttribute(attr.name, attr.value);
      if (src) proxy.setAttribute('src', src);
      node.replaceWith(proxy);
    }
    const nativeWebviewObserver = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'WEBVIEW') {
            replaceNativeWebview(node);
          } else if (typeof node.querySelectorAll === 'function') {
            node.querySelectorAll('webview').forEach(replaceNativeWebview);
          }
        }
      }
    });
    nativeWebviewObserver.observe(document.documentElement, { childList: true, subtree: true });

    class NovaBrowserView extends EventTarget {
      constructor(element, pollingInterval) {
        super();
        this.element = element;
        this.url = '';
        this.title = '';
        this.loading = false;
        this.canGoBack = null;
        this.canGoForward = null;
        this._history = [];
        this._historyIndex = -1;
        this._historyMove = 0;
        this.destroyed = false;
        this._refreshing = false;
        this._pollingInterval = pollingInterval;
        this._lastStateError = null;
        this._onLoadStart = event => {
          this.loading = true;
          this._emit('navigation-start', this._navigationDetail(event));
        };
        this._onLoadRedirect = event => this._emit('navigation-redirect', this._navigationDetail(event));
        this._onLoadCommit = event => {
          if (event.isTopLevel === false) return;
          this._setUrl(event.url || '');
          this._emit('navigation-commit', this._navigationDetail(event));
        };
        this._onLoadStop = () => {
          this.loading = false;
          this._emit('navigation-complete', this._state());
          this.refreshState().catch(error => this._reportStateError(error));
        };
        this._onLoadError = event => {
          if (event.isTopLevel === false) return;
          this.loading = false;
          this._emit('navigation-error', this._navigationDetail(event));
        };
        this._onClose = event => this._emit('close', this._navigationDetail(event));
        this._onCrash = event => this._emit('crash', this._navigationDetail(event));
        this._onNewWindow = event => {
          const popup = event.window;
          this._emit('new-window', {
            url: event.targetUrl || '',
            disposition: event.windowOpenDisposition || '',
            width: event.initialWidth || null,
            height: event.initialHeight || null,
            window: popup ? {
              attach: browserView => {
                if (!browserView?.element) throw new TypeError('attach requires a Nova browser view');
                return popup.attach(browserView.element);
              },
              discard: () => popup.discard(),
            } : null,
          });
        };
        this._onPermissionRequest = event => {
          if (event.permission === 'download') {
            this._emit('download-request', {
              url: event.request?.url || event.url || '',
            });
          }
        };
        this._onAnnotationExport = event => {
          if (typeof event?.dataUrl === 'string' && event.dataUrl.startsWith('data:image/')) {
            this._emit('annotation-export', { dataUrl: event.dataUrl });
          }
        };
        this._onContextMenu = event => {
          const rect = element.getBoundingClientRect();
          const viewportWidth = Number(event.viewportWidth) || rect.width || 1;
          const viewportHeight = Number(event.viewportHeight) || rect.height || 1;
          const scaleX = rect.width / viewportWidth;
          const scaleY = rect.height / viewportHeight;
          this._emit('contextmenu', {
            clientX: rect.left + Number(event.clientX) * scaleX,
            clientY: rect.top + Number(event.clientY) * scaleY,
            linkUrl: event.linkUrl || '',
            linkText: event.linkText || '',
            imageUrl: event.imageUrl || '',
            imageAlt: event.imageAlt || '',
            selectedText: event.selectedText || '',
            pageUrl: event.pageUrl || '',
            pageTitle: event.pageTitle || '',
          });
        };
        element.addEventListener('loadstart', this._onLoadStart);
        element.addEventListener('loadredirect', this._onLoadRedirect);
        element.addEventListener('loadcommit', this._onLoadCommit);
        element.addEventListener('loadstop', this._onLoadStop);
        element.addEventListener('loadabort', this._onLoadError);
        element.addEventListener('loaderror', this._onLoadError);
        element.addEventListener('close', this._onClose);
        element.addEventListener('crashed', this._onCrash);
        element.addEventListener('newwindow', this._onNewWindow);
        element.addEventListener('permissionrequest', this._onPermissionRequest);
        element.addEventListener('contextmenu', this._onContextMenu);
        element.addEventListener('annotation-export', this._onAnnotationExport);
        if (pollingInterval > 0) {
          this._pollTimer = setInterval(() => {
            this.refreshState().catch(error => this._reportStateError(error));
          }, pollingInterval);
        }
      }
      _emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
      }
      _navigationDetail(event) {
        return {
          url: event.url || event.targetUrl || event.validatedURL || this.url,
          isTopLevel: event.isTopLevel !== false,
          reason: event.reason || '',
          errorCode: Number.isInteger(event.errorCode) ? event.errorCode : null,
          errorDescription: event.errorDescription || '',
        };
      }
      _state() {
        return {
          url: this.url,
          title: this.title,
          loading: this.loading,
          canGoBack: this.canGoBack,
          canGoForward: this.canGoForward,
        };
      }
      _setUrl(url) {
        if (typeof url !== 'string' || !url || url === 'about:blank') return;
        if (this._historyMove !== 0) {
          this._historyIndex = Math.max(0, Math.min(this._history.length - 1, this._historyIndex + this._historyMove));
          this._historyMove = 0;
          this._updateHistoryState();
        } else if (url !== this.url) {
          this._history.splice(this._historyIndex + 1);
          this._history.push(url);
          this._historyIndex = this._history.length - 1;
          this._updateHistoryState();
        }
        if (url === this.url) return;
        const previousUrl = this.url;
        this.url = url;
        this._emit('url-change', { url, previousUrl });
      }
      _updateHistoryState() {
        this.canGoBack = this._historyIndex > 0;
        this.canGoForward = this._historyIndex >= 0 && this._historyIndex < this._history.length - 1;
      }
      _reportStateError(error) {
        if (this.destroyed) return;
        const message = error?.message || String(error);
        if (message === this._lastStateError) return;
        this._lastStateError = message;
        this._emit('state-error', { error });
      }
      async refreshState() {
        if (this.destroyed || this._refreshing) return this._state();
        this._refreshing = true;
        try {
          const results = await this.element.executeScript({ code: '[location.href, document.title]' });
          const value = Array.isArray(results) && Array.isArray(results[0]) ? results[0] : results;
          if (Array.isArray(value)) {
            this._setUrl(typeof value[0] === 'string' ? value[0] : '');
            const title = typeof value[1] === 'string' ? value[1] : '';
            if (title !== this.title) {
              const previousTitle = this.title;
              this.title = title;
              this._emit('title-change', { title, previousTitle });
            }
          }
          this._lastStateError = null;
          this._emit('state-change', this._state());
          return this._state();
        } finally {
          this._refreshing = false;
        }
      }
      getState() { return this.refreshState(); }
      navigate(url) {
        if (this.destroyed) return Promise.reject(new Error('Browser view has been destroyed'));
        if (typeof url !== 'string' || !url.trim()) return Promise.reject(new TypeError('A URL is required'));
        if (__NOVA_PENDING_INITIAL_URL__) {
          url = __NOVA_PENDING_INITIAL_URL__;
          __NOVA_PENDING_INITIAL_URL__ = null;
        }
        return this.element.navigate(url);
      }
      back() {
        if (this.canGoBack) this._historyMove = -1;
        return this.element.back().catch(error => {
          this._historyMove = 0;
          throw error;
        });
      }
      forward() {
        if (this.canGoForward) this._historyMove = 1;
        return this.element.forward().catch(error => {
          this._historyMove = 0;
          throw error;
        });
      }
      reload() { return this.element.reload(); }
      stop() { return this.element.stop(); }
      find(query, options) { return this.element.find(query, options); }
      stopFinding(action) { return this.element.stopFinding(action); }
      clearData(types) { return this.element.clearData({}, types); }
      setZoom(zoom) { return this.element.setZoom(zoom); }
      setZoomMode(mode) { return this.element.setZoomMode(mode); }
      setUserAgent(userAgent) { return this.element.setUserAgentOverride(userAgent); }
      setOverlayActive(active) { return this.element.setOverlayActive(active === true); }
      setAnnotationLayer(options) { return this.element.setAnnotationLayer(options); }
      updateAnnotationLayer(patch) { return this.element.updateAnnotationLayer(patch); }
      setAnnotationActive(active) { return this.element.setAnnotationActive(active === true); }
      clearAnnotationLayer() { return this.element.clearAnnotationLayer(); }
      undoAnnotationLayer() { return this.element.undoAnnotationLayer(); }
      exportAnnotationLayer() { return this.element.exportAnnotationLayer(); }
      executeScript(code) {
        if (typeof code !== 'string' || !code.trim()) return Promise.reject(new TypeError('Script code is required'));
        return this.element.executeScript({ code });
      }
      on(type, listener) {
        this.addEventListener(type, listener);
        return () => this.removeEventListener(type, listener);
      }
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        clearInterval(this._pollTimer);
        this.element.removeEventListener('loadstart', this._onLoadStart);
        this.element.removeEventListener('loadredirect', this._onLoadRedirect);
        this.element.removeEventListener('loadcommit', this._onLoadCommit);
        this.element.removeEventListener('loadstop', this._onLoadStop);
        this.element.removeEventListener('loadabort', this._onLoadError);
        this.element.removeEventListener('loaderror', this._onLoadError);
        this.element.removeEventListener('close', this._onClose);
        this.element.removeEventListener('crashed', this._onCrash);
        this.element.removeEventListener('newwindow', this._onNewWindow);
        this.element.removeEventListener('permissionrequest', this._onPermissionRequest);
        this.element.removeEventListener('contextmenu', this._onContextMenu);
        this.element.removeEventListener('annotation-export', this._onAnnotationExport);
        this.element.remove();
        this._emit('destroy', {});
      }
    }

    window.nova.browser = Object.freeze({
      createView: async function(options) {
        if (!options || !(options.container instanceof Element)) {
          throw new TypeError('createView requires a container Element');
        }
        const pollingInterval = options.pollingInterval === undefined ? 1000 : Number(options.pollingInterval);
        if (!Number.isInteger(pollingInterval) || pollingInterval < 0 || pollingInterval > 10000
          || (pollingInterval > 0 && pollingInterval < 250)) {
          throw new RangeError('pollingInterval must be 0 or between 250 and 10000 milliseconds');
        }
        const element = document.createElement('webview');
        element.style.cssText = 'display:block;width:100%;height:100%;border:0;';
        options.container.appendChild(element);
        let browserView = null;
        try {
          await element.__createPromise;
          browserView = new NovaBrowserView(element, pollingInterval);
          if (typeof options.url === 'string' && options.url) await browserView.navigate(options.url);
          else if (__NOVA_PENDING_INITIAL_URL__) await browserView.navigate(__NOVA_PENDING_INITIAL_URL__);
          return browserView;
        } catch (error) {
          if (browserView) browserView.destroy();
          else element.remove();
          throw error;
        }
      },
      download: async function(options) {
        if (!options || typeof options.url !== 'string' || !options.url.trim()) {
          throw new TypeError('download requires a URL');
        }
        const response = await fetch(options.url);
        if (!response.ok) throw new Error('Download request failed with HTTP ' + response.status);
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error || new Error('Could not read downloaded data'));
          reader.readAsDataURL(blob);
        });
        if (typeof dataUrl !== 'string') throw new Error('Could not encode downloaded data');
        const separator = dataUrl.indexOf(',');
        if (separator < 0) throw new Error('Could not encode downloaded data');
        return window.nova.ipc('nova:download', {
          filename: options.filename || 'download',
          mimeType: blob.type || 'application/octet-stream',
          base64Data: dataUrl.slice(separator + 1),
        });
      },
    });
  }

  if (!__NOVA_NESTED_WEBVIEW_OPTED_IN__) {
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
      if (typeof tagName === 'string' && tagName.toLowerCase() === 'webview') {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'createElement' });
        // Return an inert, disconnected <span> rather than throwing — a
        // throw here would crash whatever app code called createElement
        // (often inside a try/catch-less render path), turning a security
        // block into an unrelated-looking app crash. An inert element that
        // silently does nothing when appended is a much smaller surprise.
        return originalCreateElement.call(this, 'span');
      }
      return originalCreateElement.call(this, tagName, options);
    };

    // Covers innerHTML/outerHTML — both funnel through the same setter,
    // which is what we patch here rather than trying to catch every
    // possible property name.
    const innerHTMLDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerHTMLDesc && innerHTMLDesc.set) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        get: innerHTMLDesc.get,
        set: function(value) {
          if (typeof value === 'string' && /<webview[\\s>]/i.test(value)) {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'innerHTML' });
            value = value.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
          }
          return innerHTMLDesc.set.call(this, value);
        },
        configurable: true,
      });
    }

    const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function(position, text) {
      if (typeof text === 'string' && /<webview[\\s>]/i.test(text)) {
        ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'insertAdjacentHTML' });
        text = text.replace(/<webview[\\s\\S]*?<\\/webview>/gi, '').replace(/<webview[^>]*\\/?>/gi, '');
      }
      return originalInsertAdjacentHTML.call(this, position, text);
    };

    // Backstop: if a <webview> still makes it into the live DOM through
    // some path the above didn't anticipate, rip it out immediately rather
    // than letting it sit there and load. Runs for the lifetime of the
    // document — cheap, since <webview> insertion is not a hot path.
    const nestedWebviewObserver = new MutationObserver(function(mutations) {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'WEBVIEW') {
            ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer' });
            node.remove();
            continue;
          }
          if (typeof node.querySelectorAll === 'function') {
            const nested = node.querySelectorAll('webview');
            if (nested.length) {
              ipcFireAndForget('nova:audit:blocked-nested-webview', { via: 'mutation-observer-descendant' });
              nested.forEach((n) => n.remove());
            }
          }
        }
      }
    });
    // documentElement always exists by the time this inline script runs
    // (it's injected right after <head>), so no readiness check needed.
    nestedWebviewObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
\x3C/script>`;
  }

  // CSP meta tag injected into app HTML. Allows inline scripts/styles (apps
  // need this) and eval (the audit hook catches abuse), but blocks all direct
  // network access via connect-src 'none' — forcing network through the IPC
  // bridge where permissions are enforced.
  // connect-src no longer carves out http(s)://localhost:* (fix #3). The
  // IPC bridge itself doesn't need it — it's console.log + executeScript,
  // not fetch/XHR/WebSocket — so this carve-out existed only as an
  // (unintentional) escape hatch. With fix #1/#2 closing the WebSocket
  // bypass and locking fetch/XHR/WebSocket against `delete window.fetch`-
  // style unshadowing, this line was the only thing that made either
  // bypass reach anything once triggered. Removing it doesn't change
  // behavior for any app going through nova.fetch()/nova.websocket() as
  // intended, since those never touch native connect-src at all (they're
  // IPC calls, not network requests initiated by this document).
  // CAVEAT: if any first-party app bundle currently does a direct
  // `fetch('http://localhost:...')` or `new WebSocket('ws://localhost:...')`
  // instead of going through nova.fetch()/nova.websocket(), it will break
  // silently (CSP violation, not a JS error) once this ships. That
  // couldn't be verified from this file alone — grep first-party app
  // source for direct localhost fetch/WebSocket calls before deploying,
  // and migrate any hits to the nova.* wrappers first.
  // 'wasm-unsafe-eval' added to script-src to allow WebAssembly.instantiate()/
  // .compile() for apps bundling compiled C/C++ (Emscripten) output. This is
  // deliberately NOT the same grant as 'unsafe-eval' (which stays removed,
  // see the eval-removal history below) — it permits WASM module
  // instantiation only, not eval()/new Function() on arbitrary strings. Must
  // be changed together with the identical server-sent header in
  // server/core/index.js (the /api/apps/serve/:sandboxId route) — that
  // header is authoritative for anything served through it and overrides
  // whatever's in this meta tag, so updating only one of the two leaves the
  // other still blocking (or, if done in the wrong direction, still
  // granting) WASM instantiation regardless of this change.
  // unsafe-eval was previously granted here on the theory that the runtime
  // audit hook (nova:audit:eval) was enough of a check. It wasn't — logging
  // after the fact doesn't stop the call. eval/new Function are blocked
  // outright now, and 'wasm-unsafe-eval' does not reopen that hole.
  const RELAXED_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\'; script-src \'self\' blob: \'unsafe-inline\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob:">';

  function buildRelaxedCspMeta(allowExternalFrames = false) {
    const frameSrc = allowExternalFrames ? '; frame-src http: https:' : '';
    return '<meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data: \'unsafe-inline\'; script-src \'self\' blob: \'unsafe-inline\' \'wasm-unsafe-eval\'; style-src \'self\' \'unsafe-inline\' blob: data:; img-src \'self\' blob: data: https:; font-src \'self\' blob: data:; connect-src \'self\' blob:' + frameSrc + '">';
  }

  // Prepend the capability shim as the very first bytes of the app's HTML,
  // unconditionally — not after a regex-matched <head> tag.
  //
  // The old version replaced the first /<head(\s[^>]*)?>/i match, which
  // means the insertion point depended on how the app's own (untrusted)
  // HTML happened to be written: a document with no <head> tag, a
  // malformed one the regex didn't match, or one wrapped in something
  // that shifted where the match landed, could all change where the shim
  // ended up relative to the app's own inline scripts — and script tags
  // execute in document order, so losing the "first" guarantee here would
  // let an app's own script run before the shim's, which is exactly the
  // race this rewrite is closing. Unconditional prepend removes that
  // dependency on the input entirely: whatever the app's HTML contains,
  // the shim is textually first, full stop. Browsers parse and execute a
  // leading <script> correctly even before a <head>/<html> tag appears
  // (they're implied), so this doesn't require well-formed input either.
  //
  // `app` is required to decide the nested-<webview> grant for THIS app —
  // see isNestedWebviewPermitted(). Passing no app is treated as no app
  // (fails closed to "not permitted"), it does not fall back to some
  // shared/cached shim from a previous call.
  //
  // One exception to "unconditional": a leading <!DOCTYPE ...>. Per the
  // HTML spec a doctype is only recognized when it's the very first thing
  // in the document — it's not executable and doesn't run any guest code,
  // so it doesn't reopen the script-ordering race this rewrite closed, but
  // splicing a <script> block before it does knock the parser out of
  // no-quirks mode (or worse, depending on how the host serves the file),
  // which is exactly the "whole app fails to load" failure this is fixing.
  // Matched narrowly (must be at offset 0, case-insensitive) rather than
  // searched for anywhere in the string, so this can't be tricked by an
  // app embedding a fake "<!DOCTYPE" later in the body.
  const LEADING_DOCTYPE_RE = /^\s*<!DOCTYPE\s+html\s*>/i;

  function deferPackagedScripts(html) {
    return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>/gi, tag => {
      if (tag.startsWith('<!--')) return tag;
      const attributes = tag.slice('<script'.length, -1);
      if (!/(?:^|\s)src\s*=/i.test(attributes)) return tag;

      // Packaged external scripts run only after HTML parsing, in document
      // order. Normalize async scripts too: they otherwise race their DOM
      // and sibling scripts, making startup timing dependent on download speed.
      const normalizedAttributes = attributes
        .replace(/(?:^|\s+)async(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/gi, '')
        .replace(/(?:^|\s+)defer(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/gi, '');
      return `<script${normalizedAttributes} defer>`;
    });
  }

  function injectCapabilityShim(html, app, launchOptions = {}) {
    if (typeof html !== 'string') return html;
    html = deferPackagedScripts(html);
    const nestedWebviewOptedIn = isNestedWebviewOptedIn(app);
    const allowExternalFrames = isExternalFramesPermitted(app);
    const initialUrl = isNestedWebviewPermitted(app)
      && typeof launchOptions.url === 'string'
      && canNestedWebviewNavigate(app, launchOptions.url)
      ? resolveAndClassifyUrl(launchOptions.url).url
      : null;
    const ledgerBudgets = {
      requestTimeoutMs: StorageLedger.getBudget(app?.id, 'requestTimeoutMs'),
      httpBodyBytes: StorageLedger.getBudget(app?.id, 'httpBodyBytes'),
    };
    const shim = buildCapabilityShim(nestedWebviewOptedIn, initialUrl, ledgerBudgets);
    const cspMeta = buildRelaxedCspMeta(allowExternalFrames);
    // Add transparent document-root styling through the same unconditional
    // prefix path as the capability shim. This works for fragments or HTML
    // that omit/mangle <head>, because the HTML parser creates implied roots.
    const transparentStyle = app?.transparent
      ? '<style id="novaapp-transparent-root">html,body{background:transparent;}</style>\n'
      : '';
    // This string is embedded in an executable HTML <script>. Replacement
    // strings must produce literal backslash-u sequences in the output; using
    // '\u003c' at runtime would merely replace '<' with itself and leave
    // a caller-controlled </script> able to terminate the script element.
    const safeOptions = JSON.stringify(launchOptions || {})
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    const launchOptionsShim = '<script>window.__NOVA_APP_OPTIONS__=' + safeOptions + ';<\/script>';
    const doctypeMatch = html.match(LEADING_DOCTYPE_RE);
    if (doctypeMatch) {
      const doctype = doctypeMatch[0];
      const rest = html.slice(doctype.length);
      return doctype + '\n' + transparentStyle + launchOptionsShim + '\n' + shim + '\n' + cspMeta + '\n' + rest;
    }
    return transparentStyle + launchOptionsShim + '\n' + shim + '\n' + cspMeta + '\n' + html;
  }

  // App loading

  // Load app content into a sandbox. For webapps (external URLs), validates
  // the protocol before assigning to webview.src — without this, a malicious
  // manifest could specify javascript: or file: URLs.
  async function loadAppContent(webview, app, state, launchOptions = {}) {
    if (app.type === 'webapp' && app.url) {
      const classified = resolveAndClassifyUrl(app.url);
      if (!classified.valid) {
        log('error', `Invalid webapp URL for ${app.name}: ${classified.error}`);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'error', message: `Rejected invalid webapp URL for ${app.name}: ${classified.error}`, data: { appId: app.id, url: app.url } });
        }
        showErrorPage(webview, app, `Invalid URL: ${classified.error}`);
        return;
      }
      webview.src = classified.url;
      return;
    }

    if (app.entry && app.files && app.files[app.entry]) {
      try {
        const sandboxId = webview.dataset.sandboxId;
        // Inject the capability shim into the entry HTML before registering.
        // Use UTF-8-safe base64 so non-ASCII content survives the round-trip.
        const shimmedFiles = Object.assign({}, app.files);
        const rawHtml = decodeBase64Utf8(shimmedFiles[app.entry]);
        const allowExternalFrames = isExternalFramesPermitted(app);
        shimmedFiles[app.entry] = encodeBase64Utf8(injectCapabilityShim(rawHtml, app, launchOptions));

        const regRes = await fetch('/api/apps/serve/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // appId requests the stable per-app serving alias (sandbox_<appId>,
          // no unique suffix) alongside this launch's own session path. Dropped
          // from the JSON entirely when the id isn't alias-eligible.
          body: JSON.stringify({ sandboxId, files: shimmedFiles, allowExternalFrames, appId: stableServeAppId(app.id) || undefined }),
        });
        if (!regRes.ok) throw new Error(`File registration failed: ${regRes.status}`);
        const { baseUrl } = await regRes.json();
        webview.src = window.location.origin + baseUrl + '/' + app.entry;
      } catch (error) {
        log('error', `Failed to load app content for ${app.name}:`, error);
        if (typeof EventLog !== 'undefined') {
          EventLog.log({ app: 'AppSandbox', category: 'apps', severity: 'error', message: `Failed to load content for ${app.name}: ${error?.message || error}`, data: { appId: app.id } });
        }
        showErrorPage(webview, app, 'Failed to load app content');
      }
    } else {
      createDefaultAppShell(webview, app, state);
    }
  }

  // Build the default app shell for apps without content. Uses
  // JSON.stringify for the app.id interpolation into the inline script —
  // escapeHtml is wrong for JS string context (it would insert HTML entities
  // literally inside a JS string).
  async function createDefaultAppShell(webview, app, state) {
    const safeAppId = JSON.stringify(app.id || '');
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        ${RELAXED_CSP_META}
        <title>${escapeHtml(app.name)}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 20px;
          }
          .app-container { text-align: center; max-width: 600px; }
          .app-icon { font-size: 64px; margin-bottom: 20px; }
          h1 { font-size: 32px; margin-bottom: 10px; }
          p { font-size: 16px; opacity: 0.9; margin-bottom: 30px; }
          .status {
            background: rgba(255,255,255,0.1);
            padding: 15px 25px;
            border-radius: 8px;
            font-size: 14px;
          }
          .api-status {
            margin-top: 20px;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="app-container">
          <div class="app-icon">${escapeHtml(app.icon || '📱')}</div>
          <h1>${escapeHtml(app.name)}</h1>
          <p>${escapeHtml(app.description || 'A AstroOS Application')}</p>
          <div class="status">
            <strong>Version:</strong> ${escapeHtml(app.version)}<br>
            <strong>Author:</strong> ${escapeHtml(app.author)}<br>
            <strong>Type:</strong> ${escapeHtml(app.type)}<br>
            <strong>Status:</strong> Running in Sandbox
          </div>
          <div class="api-status" id="apiStatus">
            Initializing API bridge...
          </div>
        </div>
        <script>
          // The capability shim (injected into <head> above) fires
          // nova:ready automatically on load. This script just listens
          // for the resulting bridge-ready signal and updates the status
          // indicator — it does NOT fire a second nova:ready (the old
          // version did, which raced the shim's own ready call and
          // produced a duplicate handshake on every launch).
          (function() {
            function markReady(ok) {
              var el = document.getElementById('apiStatus');
              if (el) el.textContent = ok ? 'API Bridge: Connected ✓' : 'API Bridge: Connection failed';
            }
            if (window.nova && window.nova.ipc) {
              // The shim already fired nova:ready; just listen for its
              // resolution via the shared __novaPermResponse surface the
              // shim populates when the ready response arrives.
              var checkReady = function() {
                if (window.__novaPermResponse) {
                  markReady(true);
                } else {
                  setTimeout(checkReady, 100);
                }
              };
              setTimeout(checkReady, 100);
            } else {
              markReady(false);
            }
          })();
        </script>
      </body>
      </html>
    `;

    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'index.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/index.html';
    } catch (error) {
      log('error', `Failed to create default shell for ${app.name}:`, error);
    }
  }

  // Show an error page in the sandbox when app content fails to load.
  async function showErrorPage(webview, app, message) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        ${RELAXED_CSP_META}
        <title>Error - ${escapeHtml(app.name)}</title>
        <style>
          body { font-family: sans-serif; padding: 40px; text-align: center; }
          .error { color: #e74c3c; font-size: 48px; margin-bottom: 20px; }
          h1 { color: #2c3e50; }
          p { color: #7f8c8d; }
        </style>
      </head>
      <body>
        <div class="error">⚠</div>
        <h1>Failed to Load Application</h1>
        <p><strong>${escapeHtml(app.name)}</strong></p>
        <p>${escapeHtml(message)}</p>
        <p><small>App ID: ${escapeHtml(app.id)}</small></p>
      </body>
      </html>
    `;
    try {
      const sandboxId = webview.dataset.sandboxId;
      const regRes = await fetch('/api/apps/serve/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId, files: { 'error.html': encodeBase64Utf8(html) } }),
      });
      if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);
      const { baseUrl } = await regRes.json();
      webview.src = window.location.origin + baseUrl + '/error.html';
    } catch (e) {
      log('error', `Could not show error page for ${app.name}:`, e);
    }
  }

  // Sandbox attribute sanitisation

  // Build a safe sandbox attribute string from an app's sandbox config.
  //
  // allow-same-origin is NOT included by default for third-party apps. Including
  // it lets the guest access its own cookies, localStorage, and sessionStorage
  // on the shared origin — increasing the blast radius of any XSS inside the
  // sandbox. The same-document <iframe> sandbox-escape also applies when
  // combined with allow-scripts.
  //
  // In a <webview>, the real isolation boundary is the separate renderer
  // process, so the DOM-level escape risk is lower than for a same-document
  // iframe. However, the IPC bridge depends on `window.location.origin` matching
  // between the parent and the webview. Without allow-same-origin the origin
  // becomes opaque and postMessage silently drops.
  //
  // Sandboxed apps must explicitly opt in via allowSameOrigin and hold the
  // separate sandbox:same-origin grant. Packages approved for unrestricted
  // host execution return before this function is needed.
  function sanitizeSandboxAttr(sandboxConfig, appId, fullyUnrestricted = false, app = null) {
    if (fullyUnrestricted) return '';
    const isExplicitOptIn = sandboxConfig && typeof sandboxConfig === 'object' && sandboxConfig.allowSameOrigin === true;
    const sameOriginPermitted = isExplicitOptIn
      && AppPermissionManager?.isGranted('sandbox:same-origin', appId);

    const tokens = new Set();
    if (sameOriginPermitted) {
      tokens.add('allow-same-origin');
    }

    // Parse the manifest's sandbox config into a token set so we can
    // match exact tokens rather than substring-contains (which would
    // wrongly accept e.g. "allow-scripts-foo" as "allow-scripts").
    //
    // allow-popups-to-escape-sandbox used to be granted purely from the
    // manifest's own self-declaration, with no permission check — a popup
    // that escapes the sandbox is a fully unrestricted browsing context,
    // so user consent is mandatory. But pinning the token to the grant
    // state AT SANDBOX CREATION was its own bug: an app that asked for
    // sandbox:escape-popups after launch — the documented
    // requestPermission-at-first-use pattern — got a webview whose sandbox
    // attribute was missing the token, so its popups silently STAYED
    // SANDBOXED (opaque 'null' origin). The window.opener.postMessage relay
    // from a provider callback page still ran — attach() preserves the
    // opener — but every message arrived with event.origin 'null', and
    // OAuth flows died with "popup closed before sign-in completed" and
    // nothing in any log. Consent now lives where the decision is actually
    // made: setupSandboxPopupHandler checks sandbox:escape-popups per popup
    // at newwindow time. The token here therefore only follows the
    // publisher's INTENT — a grant obtained mid-session applies to the very
    // next window.open(), and a revoked one stops applying immediately,
    // without ever rewriting this attribute.
    //
    // The manifest opt-in is the TOP-LEVEL allowPopupsToEscapeSandbox field
    // (see isEscapePopupsOptedIn above). Reading it from the sandbox object
    // instead is what originally broke the whole feature: NOVAAPP.md and
    // the studio both document the top-level location, so a compliant
    // manifest never satisfied that gate and the token was never added.
    // Direct callers that pass no `app` object keep the legacy opt-in
    // locations for compatibility: the in-sandbox-object flag, or the token
    // itself in a string-form config.
    const popupsOptedIn = app
      ? isEscapePopupsOptedIn(app)
      : (sandboxConfig && typeof sandboxConfig === 'object' && sandboxConfig.allowPopupsToEscapeSandbox === true)
        || (typeof sandboxConfig === 'string' && sandboxConfig.split(/\s+/).includes('allow-popups-to-escape-sandbox'));

    const requestedTokens = new Set();
    if (sandboxConfig && typeof sandboxConfig === 'object') {
      if (sandboxConfig.allowScripts === true) requestedTokens.add('allow-scripts');
      if (sandboxConfig.allowForms === true) requestedTokens.add('allow-forms');
      // allow-popups-to-escape-sandbox only decides whether an OPENED popup
      // inherits the sandbox; it cannot conjure popups that allow-popups
      // never unlocked. Opting in therefore implies allow-popups. The escape
      // token itself is NOT added here — it is added once at the final token
      // level below, so every config shape gets identical treatment.
      if (sandboxConfig.allowPopups === true || popupsOptedIn) requestedTokens.add('allow-popups');
      if (sandboxConfig.allowModals === true) requestedTokens.add('allow-modals');
    } else if (typeof sandboxConfig === 'string') {
      for (const tok of sandboxConfig.split(/\s+/)) {
        // The escape token is never forwarded as a plain token here — a
        // string mentioning it is treated as the opt-in instead (see
        // popupsOptedIn above) and the token itself is added once at the
        // final token level below. Consent for the escaped popups it
        // produces is enforced per popup in setupSandboxPopupHandler.
        if (tok && tok !== 'allow-popups-to-escape-sandbox') requestedTokens.add(tok);
      }
    }

    // Only forward tokens we explicitly recognize — a manifest that asks
    // for "allow-top-navigation" or other exotic tokens gets them dropped
    // rather than passed through uninspected.
    const KNOWN_TOKENS = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-modals'];
    for (const tok of KNOWN_TOKENS) {
      if (requestedTokens.has(tok)) tokens.add(tok);
    }

    // allow-downloads: without this token, Chromium silently drops any
    // download triggered inside the webview (blob URL + <a download>,
    // navigation to a Content-Disposition: attachment response, etc).
    // It's a per-click, user-gesture-gated action — the OS-native save
    // dialog is the actual security boundary, not this token — so it's
    // safe to include in the default set alongside the other baseline
    // interaction tokens rather than gating it behind a manifest
    // permission the user has to grant separately.
    if (tokens.size === 0) {
      tokens.add('allow-scripts');
      tokens.add('allow-forms');
      tokens.add('allow-popups');
      tokens.add('allow-modals');
      tokens.add('allow-downloads');
    } else if (!tokens.has('allow-downloads')) {
      tokens.add('allow-downloads');
    }

    // The escape opt-in is applied once, at the final token level, so it
    // covers every config shape — object, string, or NO sandbox config at
    // all. That last case is the common one for a compliant manifest:
    // allowPopupsToEscapeSandbox is a top-level field, so the publisher may
    // never declare a sandbox object and the default set above is what
    // runs. Without this block the object-branch-only handling would still
    // leave every config-less app unable to open escape popups.
    //
    // This deliberately does NOT consult the sandbox:escape-popups grant:
    // the attribute is the publisher's intent, not the consent decision —
    // consent is enforced per popup in setupSandboxPopupHandler, which sees
    // the LIVE grant state every time a popup is opened, including grants
    // that arrived after this webview was created.
    if (popupsOptedIn) {
      tokens.add('allow-popups');
      tokens.add('allow-popups-to-escape-sandbox');
    }

    const attr = Array.from(tokens).join(' ');
    log('debug', `sandbox attrs for ${appId || 'unknown'}: ${attr}`);
    return attr;
  }

  // Popup display path for sandboxed apps.
  //
  // The sandbox attribute alone never shows a popup. Chromium only spawns
  // the popup when the sandbox tokens permit it (allow-popups, plus
  // allow-popups-to-escape-sandbox for popups that leave the sandbox
  // behind), but the embedder is then responsible for giving the spawned
  // window a surface — attach() it into a webview we own, or discard() it.
  // With no newwindow handler on sandbox webviews, every spawned popup was
  // silently discarded, so even an app with the full sandbox:escape-popups
  // double gate (top-level allowPopupsToEscapeSandbox + user grant) got
  // literally nothing when it called window.open().
  //
  // The handler mirrors the Nova Browser's popup policy: permitted popups
  // attach into an OS-owned overlay card (title bar with the target URL and
  // a close button) over the app's own content, so window.close() inside
  // the popup keeps working via the preserved opener relationship. Whether
  // the popup content is sandboxed or escaped is Chromium's decision from
  // the opener's sandbox tokens — attach() is only the display surface, so
  // this single handler serves both the plain allow-popups case and the
  // sandbox:escape-popups case.
  function setupSandboxPopupHandler(webview, app, options = {}) {
    const { sandboxAttr = '', partitionId = '', state = null } = options;
    const sandboxTokens = new Set(
      typeof sandboxAttr === 'string' && sandboxAttr
        ? sandboxAttr.split(/\s+/).filter(Boolean)
        : []
    );
    // An unsandboxed guest (no sandbox attribute at all — the deliberate
    // fully-unrestricted hand-off) has no token restrictions, so popups are
    // permitted exactly as they would be for any unsandboxed page.
    const popupsPermitted = sandboxAttr === '' ? true : sandboxTokens.has('allow-popups');

    // Operator-facing one-liners. The popup path used to log nothing at info
    // level (decisions were debug-gated or silent), so a serial capture of a
    // failing OAuth flow showed pages loading but could not say WHY the relay
    // died — sandboxed spawn, missing grant, or popup closed mid-flow were
    // indistinguishable. Every decision below now leaves one line.
    const appId = app?.id || app?.name || 'unknown';
    const shortUrl = u => (typeof u === 'string' && u.length > 120 ? `${u.slice(0, 117)}...` : u);
    const logPopup = message => log('info', `popup: app=${appId} ${message}`);

    const openPopupOverlays = new Set();
    const closeOverlay = backdrop => {
      openPopupOverlays.delete(backdrop);
      try { backdrop.remove(); } catch (e) { log('debug', 'popup overlay removal failed', e); }
    };

    const onNewWindow = event => {
      const popupWindow = event?.window;
      const discard = () => { try { popupWindow?.discard?.(); } catch (e) { log('debug', 'popup discard failed', e); } };

      if (!popupsPermitted) {
        // The sandbox tokens already told the guest popups are blocked —
        // discard explicitly so no embedder default leaks a surface through.
        logPopup('blocked: sandbox attribute forbids popups');
        discard();
        return;
      }

      // Escape-capable popups are unsandboxed browsing contexts, so the
      // sandbox:escape-popups consent is checked HERE, per popup, instead of
      // only being baked into the sandbox attribute at creation time. The
      // old creation-time snapshot silently stranded apps that requested the
      // permission after launch: the attribute lacked the escape token, the
      // popup spawned sandboxed (opaque origin), and every postMessage relay
      // from a provider callback page arrived with event.origin 'null' and
      // was dropped — OAuth flows died as "popup closed before sign-in
      // completed". Checking at use time means a grant that arrives
      // mid-session applies to the very next window.open(), and a revoked
      // one stops applying immediately.
      //
      // Fail-closed: a missing manager or unexpected throw counts as
      // ungranted, same rule as isNestedWebviewPermitted.
      const escapeTokenInAttr = sandboxTokens.has('allow-popups-to-escape-sandbox');
      let escapeGranted = false;
      try {
        escapeGranted = escapeTokenInAttr
          && AppPermissionManager?.isGranted('sandbox:escape-popups', app?.id) === true;
      } catch (e) {
        log('debug', 'escape-popups grant check failed', e);
      }
      if (!escapeGranted && escapeTokenInAttr) {
        // The attribute let Chromium spawn this popup UNSANDBOXED already —
        // displaying it would hand out exactly what the consent gate exists
        // to guard, so the only safe outcome is a discard (the guest sees
        // the popup fail to open, which is what an ungranted popup means).
        logPopup(`discarded: escape token in attribute but sandbox:escape-popups not granted (fail-closed) url=${shortUrl(event?.targetUrl)}`);
        discard();
        return;
      }

      const url = typeof event.targetUrl === 'string' ? event.targetUrl : '';
      if (!url || url === 'about:blank' || url.startsWith('javascript:')) {
        // Nothing safe to display — same policy as the browser's newwindow
        // handler for un-navigable popup targets.
        logPopup(`discarded: un-navigable popup target url=${shortUrl(url)}`);
        discard();
        return;
      }

      const contentEl = state?.content;
      if (!contentEl || typeof contentEl.appendChild !== 'function') {
        logPopup('discarded: no app content element available to host the overlay');
        discard();
        return;
      }

      logPopup(escapeGranted
        ? `displayed unsandboxed (sandbox:escape-popups granted) url=${shortUrl(url)}`
        : `displayed SANDBOXED: attribute lacks allow-popups-to-escape-sandbox (app did not opt in) — this popup runs at an opaque origin, so provider relays arrive with event.origin 'null' and a receiving-side origin check will drop them url=${shortUrl(url)}`);

      let backdrop = null;
      try {
        const hostWidth = (typeof window !== 'undefined' && Number(window.innerWidth)) || 1024;
        const hostHeight = (typeof window !== 'undefined' && Number(window.innerHeight)) || 768;
        const popupWidth = Math.min(Math.max(Number(event.initialWidth) || 520, 360), Math.round(hostWidth * 0.75));
        const popupHeight = Math.min(Math.max(Number(event.initialHeight) || 620, 300), Math.round(hostHeight * 0.85));

        backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:absolute;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';

        const card = document.createElement('div');
        card.style.cssText = `width:${popupWidth}px;height:${popupHeight}px;background:var(--bg,#1e1e2e);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.08);`;

        const bar = document.createElement('div');
        bar.style.cssText = 'height:36px;min-height:36px;background:var(--bg2,#181825);display:flex;align-items:center;padding:0 10px;gap:8px;border-bottom:1px solid rgba(255,255,255,0.06);user-select:none;';
        const barTitle = document.createElement('span');
        barTitle.style.cssText = 'flex:1;font-size:12px;opacity:0.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        barTitle.textContent = url;
        const barClose = document.createElement('button');
        barClose.type = 'button';
        barClose.textContent = '✕';
        barClose.setAttribute('aria-label', 'Close popup');
        barClose.style.cssText = 'background:none;border:none;color:inherit;opacity:0.5;cursor:pointer;font-size:13px;padding:2px 6px;border-radius:4px;';
        bar.append(barTitle, barClose);

        const popupWebview = document.createElement('webview');
        popupWebview.style.cssText = 'flex:1;width:100%;border:none;';
        // The popup shares the app's own storage partition (OAuth sessions,
        // external checkouts) but nothing else: no node integration, no
        // remote module. No sandbox attribute is set here on purpose — the
        // popup's security context is already fixed by Chromium from the
        // opener's sandbox tokens, and attach() only supplies the surface.
        popupWebview.setAttribute('nodeintegration', 'false');
        popupWebview.setAttribute('enableremotemodule', 'false');
        popupWebview.setAttribute('partition', `persist:${partitionId}`);

        card.append(bar, popupWebview);
        backdrop.appendChild(card);

        // Track the last committed URL so the close line says WHERE the
        // popup died: still on a provider page (closed early — watchdog or
        // user) vs already back on the app callback (relay path reached).
        let lastPopupUrl = url;
        const trackPopupUrl = e => { if (typeof e?.url === 'string' && e.url) lastPopupUrl = e.url; };
        popupWebview.addEventListener('loadcommit', trackPopupUrl);
        popupWebview.addEventListener('did-navigate', trackPopupUrl);
        popupWebview.addEventListener('did-navigate-in-page', trackPopupUrl);

        const closePopup = source => () => {
          logPopup(`overlay closed (${source}) lastUrl=${shortUrl(lastPopupUrl)}`);
          closeOverlay(backdrop);
        };
        barClose.addEventListener('click', closePopup('titlebar'));
        popupWebview.addEventListener('close', closePopup('popup window.close'));

        // Same guest console mirror as createSandbox, scoped to this popup.
        // The relay half of an OAuth flow runs HERE — the provider's pages
        // and the app's callback.html are the popup's documents, so the
        // decisive probe lines ("callback fired, opener present/absent,
        // relay posted") surface only if this webview's console reaches
        // serial. Prefix distinguishes popup lines from app-window lines;
        // share the same throttle budget (see createSandbox).
        popupWebview.addEventListener('console-message', e => {
          if (!e || typeof e.message !== 'string' || !e.message) return;
          let level = typeof e.level === 'number'
            ? (['debug', 'info', 'warn', 'error'][e.level] || 'info')
            : (typeof e.level === 'string' ? e.level : 'info');
          if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') level = 'info';
          let srcLine = '';
          if (typeof e.sourceId === 'string' && e.sourceId) {
            const base = e.sourceId.split('/').pop();
            srcLine = ` [${base}${Number.isFinite(e.lineNumber) ? ':' + e.lineNumber : ''}]`;
          }
          log(level === 'debug' ? 'debug' : level, `popup console app=${appId}${srcLine} ${e.message}`);
        });

        openPopupOverlays.add(backdrop);
        contentEl.appendChild(backdrop);
        // attach() is what actually binds the spawned window into our
        // popupWebview — it can throw if the popup was already consumed, in
        // which case we tear the overlay back down and discard.
        popupWindow.attach(popupWebview);
      } catch (e) {
        log('warn', `Could not display popup for ${app?.name || app?.id || 'unknown app'}`, e);
        if (backdrop) closeOverlay(backdrop);
        discard();
      }
    };

    webview.addEventListener('newwindow', onNewWindow);
    return () => {
      webview.removeEventListener('newwindow', onNewWindow);
      for (const backdrop of [...openPopupOverlays]) closeOverlay(backdrop);
    };
  }

  // Sandbox creation

  // Create a sandboxed webview for app execution. The webview runs in a
  // separate renderer process — true process isolation. It cannot access
  // main page JS, DOM, or memory regardless of app content.
  function createSandbox(app, container, state, launchOptions = {}, forceSandbox = false) {
    const webview = document.createElement('webview');

    // nodeintegration=false means the app cannot require() Node.js modules
    // even if the preload script has access — defense in depth.
    webview.setAttribute('nodeintegration', 'false');
    webview.setAttribute('nodeintegrationsubframes', 'false');

    // Sandbox tracking id — unique per launch, used only to key
    // activeSandboxes/eventSubscriptions/etc. so concurrent or repeated
    // launches of the same app don't collide with each other. Uses
    // crypto.randomUUID for collision resistance — Date.now() alone can
    // collide if two sandboxes are created in the same millisecond.
    const sandboxId = generateSandboxId(app.id);
    const nestedWebviewOptedIn = isNestedWebviewOptedIn(app);

    // Isolated storage partition, keyed by app.id ONLY (not sandboxId).
    // The 'persist:' prefix makes a given partition NAME durable across
    // that partition's own lifetime — it does nothing to unify two
    // different partition names. Keying by app.id alone means every
    // launch of the same app resolves to the same on-disk partition.
    //
    // Multi-user: cookies and site storage are per-account — the name
    // gains the active owner (persist:u<uid>_app_<appId>), resolved from
    // the trusted host's user scope so apps never choose their own uid
    // dimension. Guests ride a volatile (non-persist) partition: an
    // ephemeral session leaves nothing behind.
    let partitionId;
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
      const owner = String(NovaUserScope.uid() || '');
      if (owner === 'guest') {
        partitionId = `guest_app_${app.id}`;
        webview.setAttribute('partition', partitionId);
      } else if (owner) {
        partitionId = `u${owner}_app_${app.id}`;
        webview.setAttribute('partition', `persist:${partitionId}`);
      } else {
        partitionId = `app_${app.id}`;
        webview.setAttribute('partition', `persist:${partitionId}`);
      }
    } else {
      partitionId = `app_${app.id}`;
      webview.setAttribute('partition', `persist:${partitionId}`);
    }

    // Guest console mirror. The serial mirror above carries every decision
    // THIS module makes, but a guest-side flow has a second half that used
    // to be invisible: the app's own console — the token exchange result,
    // a relay message arriving or never arriving, a state-mismatch branch.
    // A serial capture could show the full popup round-trip completing
    // (authorize → provider → callback → window.close) and still not say
    // whether the app accepted the code or died inside its own fetch.
    // The <webview> console-message event carries every guest console line
    // host-side, so route them through the same mirror. Levels map from
    // Chromium's numeric scheme (0=debug..3=error) when the embedder sends
    // numbers; debug stays console-only, matching this module's own rule
    // that debug never reaches serial. Guest noise shares serialMirror's
    // 40-lines/5s budget with OS-side lines by design — diagnostics must
    // never flood the channel they diagnose.
    webview.addEventListener('console-message', e => {
      if (!e || typeof e.message !== 'string' || !e.message) return;
      let level = typeof e.level === 'number'
        ? (['debug', 'info', 'warn', 'error'][e.level] || 'info')
        : (typeof e.level === 'string' ? e.level : 'info');
      if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error') level = 'info';
      let srcLine = '';
      if (typeof e.sourceId === 'string' && e.sourceId) {
        const base = e.sourceId.split('/').pop();
        srcLine = ` [${base}${Number.isFinite(e.lineNumber) ? ':' + e.lineNumber : ''}]`;
      }
      log(level === 'debug' ? 'debug' : level, `guest console app=${app?.id || app?.name || 'unknown'}${srcLine} ${e.message}`);
    });

    const sandboxAttr = sanitizeSandboxAttr(app.sandbox, app.id, isFullyUnrestricted(app) && !forceSandbox, app);
    if (sandboxAttr) {
      webview.setAttribute('sandbox', sandboxAttr);
    } else if (isFullyUnrestricted(app) && !forceSandbox) {
      // Deliberately no sandbox attribute: this is the exact hand-off from
      // UnrestrictedGate. Keep nodeintegration disabled and the isolated IPC
      // transport intact, so "unsandboxed" does not mean "uncontrolled".
      webview.removeAttribute('sandbox');
    }

    // Register the isolated-world IPC transport before any navigation
    // happens on this webview (loadAppContent, called below, is what
    // first sets webview.src). addContentScripts + run_at: 'document_start'
    // guarantees this runs before the guest's own <head> content —
    // including the main-world capability shim prepended into the app's
    // HTML — ever gets a chance to execute, and it runs in a separate JS
    // realm the guest's own scripts cannot reach (see
    // buildIsolatedTransportScript for why that matters).
    //
    // Scoped to THIS sandbox's own serving path and this app's own STABLE
    // per-app serving path, not the whole origin.
    // /api/apps/serve/register (server/core/index.js) always returns
    // baseUrl = `/api/apps/serve/${sandboxId}` — deterministic from the
    // sandboxId we already generated above, no need to wait on the async
    // registration call below to know it. The stable alias
    // `/api/apps/serve/sandbox_${app.id}` is equally deterministic (same app
    // id every launch), so pages that reach the app's own bundled files
    // through it — an OAuth provider redirecting back to the app's registered
    // callback.html, for example — get the same isolated transport as pages
    // loaded through the session path. Matching the bare origin would
    // register this transport against every app's served files on this
    // host (they all live under window.location.origin), so every
    // launched app's webview would get every other app's transport
    // script injected into it — scoping to our own two paths keeps this
    // sandbox's isolated IPC transport from leaking into any other
    // sandbox's webview. (The transport stays inert on any page whose main
    // world doesn't run this app's capability shim — it only relays for the
    // shim's one-time port claim — so an app navigating to another app's
    // stable path gains nothing.)
    // webapp-type apps (external URLs) don't get this at all: they
    // navigate to classified.url directly and were never given
    // window.nova capabilities in the first place.
    if (typeof webview.addContentScripts === 'function') {
      const transportMatches = [`${window.location.origin}/api/apps/serve/${sandboxId}/*`];
      // Same eligibility rule as the registration alias in loadAppContent:
      // only platform-shaped ids get a stable path at all.
      if (stableServeAppId(app.id)) {
        transportMatches.push(`${window.location.origin}/api/apps/serve/sandbox_${app.id}/*`);
      }
      try {
        webview.addContentScripts([{
          name: `nova-ipc-transport-${sandboxId}`,
          matches: transportMatches,
          js: { code: buildIsolatedTransportScript() },
          run_at: 'document_start',
          all_frames: false,
        }]);
      } catch (e) {
        log('warn', `Failed to register isolated IPC transport for ${app?.id || 'unknown app'}:`, e);
      }
    } else {
      log('warn', `webview.addContentScripts unavailable — IPC transport will not be isolated for ${app?.id || 'unknown app'}`);
    }

    webview.style.cssText = `
      width: 100%;
      height: 100%;
      border: none;
      background: ${app.transparent ? 'rgba(0,0,0,0)' : 'transparent'};
      display: flex;
      flex-direction: column;
    `;

    // Transparent NovaApps must not paint an opaque webview canvas over the
    // host window's glass backdrop.
    //
    // NW.js/Chromium's <webview> is a real embedder tag (not an <iframe>),
    // and unlike the top-level BrowserWindow "transparent" feature (which
    // is a documented, compositor-level NW.js feature — see
    // "Transparent Window" in the NW.js docs), there is no equivalent
    // documented guarantee that a nested <webview>'s own rendered surface
    // composites transparently against whatever sits behind it in the
    // embedder page. The `background: transparent` above only avoids the
    // webview element's own CSS box painting a color — it does not by
    // itself confirm the browser process is compositing the guest's
    // rendered surface with per-pixel alpha rather than flattening it to
    // opaque before handing it back to the embedder.
    //
    // `allowtransparency` is the older Chromium/WebKit iframe-family
    // attribute for exactly this (it predates <webview> but the tag
    // inherits from the same guest-view family) — setting it plus an
    // explicit zero-alpha rgba() (rather than the `transparent` keyword,
    // which some Chromium versions resolve differently for compositing
    // purposes than an explicit alpha channel of 0) is the standard
    // combination people reach for. Kept unconditional (not gated behind
    // `if (app.transparent)`) since the base cssText above already always
    // sets background:transparent regardless — there's no reason for this
    // to be conditional on the same flag when it isn't gating anything
    // additional.
    if (app.transparent) {
      webview.setAttribute('allowtransparency', 'true');
      webview.style.backgroundColor = 'rgba(0, 0, 0, 0)';
    }

    webview.dataset.sandboxId = sandboxId;
    webview.dataset.appId = app.id;

    // Collect per-sandbox teardown functions. Each setup function returns
    // a cleanup function; createSandbox stitches them into a single
    // sandbox.cleanup that destroy() runs. This replaces the previous
    // pattern where setupAPIBridge wrote sandbox.cleanup directly (so
    // error-handling and permission-gate listeners were never removed —
    // a real leak for backgrounded sandboxes whose webview element
    // survives in #background-app-host).
    const teardownFns = [];

    // Liveness heartbeat for the server-side app-serve registry. Its entries
    // expire after 30 minutes without access; an app that loads its bundle
    // once and then goes quiet (a long OAuth consent page in a popup, a
    // dashboard SPA that never navigates) would otherwise have its files
    // pruned mid-session and 404 on the next navigation — including the
    // OAuth redirect back to its callback URL. The heartbeat pins the entry
    // for as long as THIS sandbox exists; destroy() clears the timer via
    // cleanup and unregisters the files, so nothing outlives the sandbox.
    // Only apps with real bundled content register files with the server,
    // so only those bother beating.
    if (app.entry && app.files && app.files[app.entry]) {
      const serveHeartbeatTimer = setInterval(() => {
        fetch('/api/apps/serve/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sandboxId }),
        }).catch(() => {});
      }, APP_SERVE_HEARTBEAT_INTERVAL_MS);
      teardownFns.push(() => clearInterval(serveHeartbeatTimer));
    }

    const requestedFileIntent = launchOptions?.fileIntent;
    const requestedFileId = requestedFileIntent?.action === 'open'
      ? requestedFileIntent.file?.id
      : null;
    const requestedFile = typeof requestedFileId === 'string' ? FS.files.get(requestedFileId) : null;
    const dotIndex = typeof requestedFile?.name === 'string' ? requestedFile.name.lastIndexOf('.') : -1;
    const fileQuery = requestedFile ? {
      extension: dotIndex !== -1 ? requestedFile.name.slice(dotIndex).toLowerCase() : null,
      mimeType: typeof requestedFile.mimeType === 'string' ? requestedFile.mimeType : '',
    } : null;
    const openFile = requestedFile?.type === 'file'
      && typeof DefaultApps !== 'undefined'
      && DefaultApps.supportsFile(app.id, fileQuery)
      ? { id: requestedFile.id, node: requestedFile }
      : null;

    const sandboxRecord = {
      appId: app.id,
      iframe: webview,
      webview: webview,
      created: new Date().toISOString(),
      state: state,
      windowId: state?.id,
      wsConnections: new Map(),
      appIpcEndpoints: new Set(),
      ipcBroadcastActions: new Set(),
      nestedWebviewOptedIn,
      openFile,
      homeSurface: state?.homeSurface === true,
      homeLoadTimer: null,
      cleanup: null, // populated below after all setup runs
    };
    activeSandboxes.set(sandboxId, sandboxRecord);
    if (state?.content && getComputedStyle(state.content).position === 'static') {
      state.content.style.position = 'relative';
    }

    // Fullscreen support — toggle window maximise when the webview enters or
    // exits fullscreen so the app fills the screen.
    if (state && state.element) {
      // Capture the maximized state at the time of fullscreen entry,
      // not at sandbox creation — the previous version captured it once
      // at creation and then compared against the current state on exit,
      // so if the user manually maximized before entering fullscreen we
      // would wrongly unmaximize on exit.
      let maximizedForFullscreen = false;
      const fullscreenHandler = () => {
        if (document.fullscreenElement === webview) {
          maximizedForFullscreen = !!state.maximized;
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !state.maximized) {
            WM.toggleMaximize(state.id);
          }
        } else {
          if (typeof WM !== 'undefined' && WM.toggleMaximize && !maximizedForFullscreen && state.maximized) {
            WM.toggleMaximize(state.id);
          }
          maximizedForFullscreen = false;
        }
      };
      webview.addEventListener('fullscreenchange', fullscreenHandler, false);
      teardownFns.push(() => webview.removeEventListener('fullscreenchange', fullscreenHandler));
    }

    eventSubscriptions.set(sandboxId, new Map());

    teardownFns.push(setupAPIBridge(webview, app, sandboxId, sandboxRecord));
    teardownFns.push(setupErrorHandling(webview, app));
    teardownFns.push(setupPermissionRequestGate(webview, app));
    teardownFns.push(setupSandboxPopupHandler(webview, app, { sandboxAttr, partitionId, state }));

    // Compose all teardowns into the sandbox's cleanup function.
    sandboxRecord.cleanup = () => cleanupSandboxRecord(sandboxRecord, teardownFns);

    log('debug', `Created webview sandbox for ${app.name} (${sandboxId})`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Created sandbox for ${app.name}`, data: { appId: app.id, sandboxId } });
    }

    return webview;
  }

  function cleanupSandboxRecord(sandboxRecord, teardownFns = []) {
    if (!sandboxRecord) return;
    cancelAppIpcForSandbox(sandboxRecord.webview?.dataset?.sandboxId);
    sandboxRecord.appIpcEndpoints?.clear();
    sandboxRecord.ipcBroadcastActions?.clear();
    try { sandboxRecord.contextMenuCleanup?.(); } catch (e) { log('debug', 'context menu cleanup step threw', e); }
    sandboxRecord.contextMenuCleanup = null;
    try { sandboxRecord.overlayCleanup?.(); } catch (e) { log('debug', 'app overlay cleanup step threw', e); }
    sandboxRecord.overlayCleanup = null;
    try { window.NovaSystemWebview?.destroySandbox(sandboxRecord); }
    catch (e) { log('warn', 'system webview cleanup failed', e); }
    try { sandboxRecord.appearanceSubscription?.(); } catch (e) { log('debug', 'appearance unsubscribe failed', e); }
    sandboxRecord.appearanceSubscription = null;
    for (const fn of teardownFns) {
      try { fn(); } catch (e) { log('debug', 'sandbox cleanup step threw', e); }
    }
  }

  // Run a trusted first-party app directly in the host document, matching the
  // pre-NovaApp execution model used by legacy built-in apps. This is the
  // actual "fully unrestricted" tier: there is no guest webview, so the app
  // can see the same host APIs, DOM, WM, FS, Notify, ContextMenu, etc. that
  // its original .js implementation saw. Eligibility is ONLY established by
  // UnrestrictedGate immediately before this function is called.
  async function launchUnrestrictedHostApp(app, container, state, options = {}, reuseEntry = false) {
    const entryName = app?.unrestrictedEntry || app?.manifest?.unrestrictedEntry;
    container.innerHTML = '';
    container.style.padding = '0';
    container.style.overflow = 'hidden';

    if (!reuseEntry) {
      const encoded = entryName && app?.files?.[entryName];
      if (!encoded) throw new Error(`Trusted app ${app?.id || 'unknown'} has no unrestricted entry ${entryName || '(none)'}`);
      const source = decodeBase64Utf8(encoded);

      // Re-use a single marker so reopening an unrestricted app never leaves
      // stale copies of its entry script in the document.
      const scriptSelector = `script[data-nova-unrestricted-app=\"${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}\"]`;
      document.querySelectorAll(scriptSelector).forEach(node => node.remove());

      // Install the package-local stylesheet in the host document once.
      const styleMarker = `style[data-novaapp-style=\"${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}\"]`;
      if (!document.querySelector(styleMarker)) {
        const styleEncoded = app?.files?.['style.css'];
        if (styleEncoded) {
          try {
            const styleNode = document.createElement('style');
            styleNode.dataset.novaappStyle = String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
            styleNode.textContent = decodeBase64Utf8(styleEncoded);
            document.head.appendChild(styleNode);
          } catch (styleErr) {
            log('debug', `Unable to install packaged stylesheet for ${app.id}`, { error: styleErr?.message });
          }
        }
      }

      const script = document.createElement('script');
      script.type = 'text/javascript';
      script.dataset.novaUnrestrictedApp = String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
      script.textContent = source + `\n//# sourceURL=novaapp:${String(app.id).replace(/[^a-zA-Z0-9_.-]/g, '_')}/${String(entryName)}\n`;
      const previousUnrestrictedPackage = window.__novaUnrestrictedPackage;
      window.__novaUnrestrictedPackage = app;
      try {
        (document.body || document.documentElement).appendChild(script);
      } finally {
        if (previousUnrestrictedPackage === undefined) {
          delete window.__novaUnrestrictedPackage;
        } else {
          window.__novaUnrestrictedPackage = previousUnrestrictedPackage;
        }
      }
    }

    const registered = (typeof OS !== 'undefined' && OS?.apps?.[app.id]) ||
      (typeof AppRegistry !== 'undefined' && AppRegistry?.getApp?.(app.id)) || null;
    if (!registered || typeof registered.init !== 'function') {
      throw new Error(`Unrestricted app ${app.id} did not register an init() function`);
    }

    // Preserve the signed package identity/lifecycle metadata on the live
    // registered object. The legacy script predates .novaapp metadata and its
    // registerApp() config does not carry these fields.
    Object.assign(registered, {
      icon: app.icon || registered.icon,
      source: app.source,
      verified: app.verified === true,
      signer: app.signer || null,
      revoked: app.revoked === true,
      tampered: app.tampered === true,
      system: app.system === true,
      signature: app.signature || null,
      signing: app.signing || null,
      integrity: app.integrity || null,
      manifest: app.manifest || null,
      novabyte_app: app.novabyte_app,
      compiled_at: app.compiled_at,
      permissions: Array.isArray(app.permissions) ? app.permissions.slice() : (registered.permissions || []),
      optionalPermissions: Array.isArray(app.optionalPermissions) ? app.optionalPermissions.slice() : (registered.optionalPermissions || []),
      unrestrictedEntry: entryName,
      transparent: app.transparent === true,
      allowNestedWebview: app.allowNestedWebview === true,
    });

    await registered.init.call(registered, container, state, options);

    // Host-rendered apps have no webview or sandbox to tear down. The app's
    // own onClose()/state cleanup remains the authoritative lifecycle hook,
    // exactly as it was for the legacy .js app.
    return {
      success: true,
      unrestricted: true,
      appId: app.id,
      windowId: state?.id,
      hostRendered: true,
      iframe: null,
      webview: null,
      cleanup: () => {},
    };
  }

  // Public lifecycle

  function hasRootExecutionGrant(app) {
    return !rootRevocationReloadScheduled
      && (app?.permissions || []).includes('system:root')
      && typeof AppPermissionManager !== 'undefined'
      && AppPermissionManager.isGranted('system:root', app.id) === true
      && typeof OS !== 'undefined'
      && OS.settings?.get?.('devMode') === true
      && OS.settings?.get?.('rootAccessEnabled') === true;
  }

  async function launchRootApp(app, container, state, options) {
    const entryName = app.unrestrictedEntry || app.manifest?.unrestrictedEntry;
    if (typeof entryName !== 'string' || !app.files?.[entryName]) {
      if (typeof Notify !== 'undefined') Notify.show?.({
        title: 'Root app could not start',
        body: 'The package does not contain its declared unrestrictedEntry JavaScript file.',
        type: 'error',
        appName: app.name || 'System',
      });
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'AppSandbox',
          category: 'security',
          severity: 'error',
          message: `Root launch blocked for ${app.id}: unrestricted entry missing`,
          data: { appId: app.id, permission: 'system:root', action: 'root-launch-blocked' },
        });
      }
      return null;
    }
    const reuseEntry = installRootApiAudit(app);
    recordRootAudit(app, 'Root execution started');
    app.__rootAccessActive = true;
    try {
      const result = await launchUnrestrictedHostApp(app, container, state, options, reuseEntry);
      const rootRecord = rootExecutionApps.get(app.id);
      if (rootRecord) rootRecord.entryLoaded = true;
      return result;
    } catch (error) {
      console.error(`[RootAccess] Root app ${app.id} failed to start:`, error);
      if (typeof Notify !== 'undefined') Notify.show?.({
        title: 'Root app failed to start',
        body: error?.message || 'The OS will reload to clear partially executed root code.',
        type: 'error',
        appName: app.name || 'System',
      });
      reloadAfterRootRevocation(`Root app ${app.id} failed to start`);
      return null;
    }
  }

  async function launchHome(app, container) {
    if (!container) throw new Error('Home surface container is required');
    await ensureExecutionPartitionClean(app?.id);
    if (typeof DefaultApps === 'undefined'
      || !DefaultApps.getAppsForCategory('home').some(candidate => candidate.id === app?.id)) {
      throw new Error('App is not registered as an available Home app');
    }
    const state = {
      appId: app.id,
      content: container,
      element: null,
      homeSurface: true,
      cleanups: [],
    };
    const launchOptions = { homeSurface: true };
    if (hasRootExecutionGrant(app)) {
      return launchRootApp(app, container, state, launchOptions);
    }
    if (typeof UnrestrictedGate !== 'undefined' &&
        typeof UnrestrictedGate.checkUnrestrictedApp === 'function') {
      try {
        const verdict = await UnrestrictedGate.checkUnrestrictedApp(app);
        if (verdict.allowed) {
          app.__unrestrictedSandbox = true;
          log('debug', `Unrestricted Home execution granted for ${app.id}`);
          return await launchUnrestrictedHostApp(app, container, state, launchOptions);
        }
        log('debug', `Sandbox retained for Home app ${app.id}: ${verdict.reason}`);
      } catch (error) {
        app.__unrestrictedSandbox = false;
        log('warn', `Unrestricted Home check failed for ${app.id}; retaining sandbox`, {
          error: error?.message,
        });
      }
    }
    if (typeof app.entry !== 'string' || typeof app.files?.[app.entry] !== 'string') {
      throw new Error(`Home app ${app.id} is missing its packaged entry "${app.entry}"`);
    }

    container.replaceChildren();
    const webview = createSandbox(app, container, state, launchOptions, true);
    webview.style.cssText += 'position:fixed;inset:0;width:100vw;height:100vh;z-index:10;';
    webview.setAttribute('aria-label', `${app.name || app.id} Home`);
    container.appendChild(webview);

    const sandboxId = webview.dataset.sandboxId;
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) {
      webview.remove();
      throw new Error(`Home app sandbox ${sandboxId} was not registered`);
    }
    sandbox.homeSurface = true;
    sandbox.homeLoadTimer = setTimeout(() => {
      sandbox.homeLoadTimer = null;
      if (activeSandboxes.get(sandboxId) === sandbox) {
        loadAppContent(webview, app, state, launchOptions);
      }
    }, 250);

    return {
      success: true,
      appId: app.id,
      sandboxId,
      webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  // Launch an app in a sandboxed environment unless root access is active.
  async function launch(app, container, state, options = {}) {
    if (!container) {
      throw new Error('Container element is required');
    }

    if (hasRootExecutionGrant(app)) return launchRootApp(app, container, state, options);
    await ensureExecutionPartitionClean(app.id);

    // Re-run the package-level security gate at every launch. Never trust a
    // cached boolean supplied by the caller: the gate re-checks bundle
    // provenance, first-party membership, integrity, and required grants.
    app.__unrestrictedSandbox = false;
    if (typeof UnrestrictedGate !== 'undefined' && typeof UnrestrictedGate.checkUnrestrictedApp === 'function') {
      try {
        const verdict = await UnrestrictedGate.checkUnrestrictedApp(app);
        if (verdict.allowed) {
          app.__unrestrictedSandbox = true;
          log('debug', `Unrestricted execution granted for ${app.id}`);
          return await launchUnrestrictedHostApp(app, container, state, options);
        } else {
          log('debug', `Sandbox retained for ${app.id}: ${verdict.reason}`);
        }
      } catch (err) {
        app.__unrestrictedSandbox = false;
        log('warn', `Unrestricted sandbox check failed for ${app.id}; retaining sandbox`, { error: err?.message });
      }
    }

    // Trusted transparent system apps used to launch through a bespoke
    // sandboxed <iframe> path (launchTrustedTransparentSystemApp, removed)
    // instead of the normal <webview> flow below. That fork existed to keep
    // trusted apps isolated from the parent document, but createSandbox()
    // already isolates every app via a per-app storage partition plus the
    // `sandbox` webview attribute — a stronger boundary than an iframe's
    // same-origin restriction — so the fork bought no real isolation.
    //
    // What it did buy, by accident, was breaking transparency: Chromium
    // composites a sandboxed iframe (no allow-same-origin) as opaque
    // regardless of the guest document's own background:transparent rules,
    // while <webview> honors `allowtransparency` + an explicit zero-alpha
    // background. Signed/trusted transparent apps went through the iframe
    // path and rendered as solid white; unsigned ones went through
    // createSandbox() below and rendered correctly. Routing both through
    // the same path fixes that, and app.transparent (handled inside
    // createSandbox) still applies regardless of app.system/verified/signer.

    // Clear container — any previous webview (and its listeners) goes away.
    container.innerHTML = '';

    const webview = createSandbox(app, container, state, options);
    container.appendChild(webview);

    // NOTE on timing: createSandbox() calls webview.addContentScripts(...)
    // to register the isolated IPC transport script. NW.js's
    // addContentScripts has no Promise, callback, or completion event in
    // its public API (confirmed against docs.nwjs.io and multiple NW.js
    // issue threads) — there is no real way to await "registration done."
    // It's also not guaranteed instantaneous: nwjs/nw.js#7597 reports the
    // registered content script intermittently missing from a webview's
    // very first navigation, which is consistent with a registration race
    // against that navigation rather than a guaranteed-synchronous call.
    //
    // Previously this fired addContentScripts and set webview.src (via
    // loadAppContent, below) back-to-back on the same tick, with nothing
    // between them. If addContentScripts hadn't been processed by NW.js's
    // browser process yet when navigation began, the isolated transport
    // script could fail to attach for that load — and, per manual testing,
    // could produce a hard renderer failure rather than a clean fallback.
    // A short deliberate delay before navigation gives that registration
    // a real window to land first. This is a mitigation for an
    // undocumented timing gap in NW.js's own API, not a confirmed fix for
    // its root cause — if NW.js ever exposes a real completion signal for
    // addContentScripts, switch to that instead of this delay.
    const CONTENT_SCRIPT_REGISTRATION_DELAY_MS = 250;

    // loadAppContent is async (registers files with the server) — fire and
    // let errors surface in the webview via showErrorPage.
    setTimeout(() => {
      loadAppContent(webview, app, state, options || {});
    }, CONTENT_SCRIPT_REGISTRATION_DELAY_MS);

    log('debug', `Launched ${app.name} in sandbox`);

    const sandboxId = webview.dataset.sandboxId;
    return {
      success: true,
      sandboxId,
      appId: app.id,
      windowId: state?.id,
      iframe: webview, // backward-compat alias
      webview: webview,
      cleanup: () => destroy(sandboxId),
    };
  }

  function queueExecutionPartitionCleanup(appId) {
    if (!appId) return Promise.resolve();
    partitionCleanupRequired.add(appId);
    const prior = partitionCleanupPromises.get(appId) || Promise.resolve();
    const cleanup = prior.catch(() => {}).then(() => clearAppExecutionPartition(appId));
    partitionCleanupPromises.set(appId, cleanup);
    cleanup.then(() => {
      if (partitionCleanupPromises.get(appId) === cleanup) {
        partitionCleanupRequired.delete(appId);
        partitionCleanupPromises.delete(appId);
      }
    }, (error) => {
      // Keep the required marker after failure so the next launch retries and
      // fails closed instead of silently reusing dirty storage.
      log('error', `Required storage cleanup failed for ${appId}; future launch is blocked until retry succeeds`, error);
      if (partitionCleanupPromises.get(appId) === cleanup) partitionCleanupPromises.delete(appId);
    });
    return cleanup;
  }

  async function ensureExecutionPartitionClean(appId) {
    const pending = partitionCleanupPromises.get(appId);
    if (pending) {
      try { await pending; } catch { /* retry below; required marker remains set */ }
    }
    if (partitionCleanupRequired.has(appId)) {
      const activeSibling = [...activeSandboxes.values()].some(sandbox => sandbox.appId === appId);
      if (activeSibling) {
        throw new Error(`App storage cleanup for ${appId} is pending; close all existing windows before relaunching`);
      }
      await queueExecutionPartitionCleanup(appId);
    }
    if (partitionCleanupRequired.has(appId)) {
      throw new Error(`App storage cleanup has not succeeded for ${appId}; refusing to launch with a potentially dirty partition`);
    }
  }

  // Called by AppPermissionManager when a live app loses a sandbox capability.
  function handlePermissionRevoked(permission, appId) {
    if (!appId) return false;
    if (permission === 'sandbox:nested-webview') {
      for (const sandbox of activeSandboxes.values()) {
        if (sandbox.appId !== appId) continue;
        try { sandbox.overlayCleanup?.(); } catch (error) { log('warn', 'App overlay cleanup failed after permission revocation', error); }
      }
      try { window.NovaSystemWebview?.revokeApp(appId); }
      catch (error) { log('warn', 'System webview cleanup failed after permission revocation', error); }
      return true;
    }
    if (permission !== 'sandbox:same-origin') return false;
    partitionCleanupRequired.add(appId);
    const affected = [...activeSandboxes.entries()]
      .filter(([, sandbox]) => sandbox.appId === appId)
      .map(([sandboxId, sandbox]) => ({ sandboxId, windowId: sandbox.windowId }));
    for (const { sandboxId, windowId } of affected) {
      try {
        if (windowId && typeof WM !== 'undefined' && typeof WM.closeWindow === 'function') {
          WM.closeWindow(windowId);
        } else {
          destroy(sandboxId);
        }
      } catch (error) {
        log('warn', `Could not close ${appId} after sandbox:same-origin revocation`, error);
        destroy(sandboxId);
      }
    }
    if (![...activeSandboxes.values()].some(sandbox => sandbox.appId === appId)) {
      queueExecutionPartitionCleanup(appId).catch(() => {});
    }
    return true;
  }

  // Destroy a sandbox by ID. Tears down listeners, WebSockets, event
  // subscriptions, open dialogs, and unregisters app files from the serve
  // route. Safe to call multiple times — second call is a no-op.
  function destroy(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;
    // Reentrancy guard: a second caller (e.g. closeWindow racing with
    // uninstall) could otherwise see the same `sandbox` between our get
    // and our delete below, run cleanup twice, and double-close
    // WebSockets / double-remove the dialog overlay. Delete first, then
    // tear down — sandbox.cleanup is still callable via the local ref.
    activeSandboxes.delete(sandboxId);
    cancelAppIpcForSandbox(sandboxId);
    if (sandbox.homeLoadTimer) {
      clearTimeout(sandbox.homeLoadTimer);
      sandbox.homeLoadTimer = null;
    }

    // sandbox.cleanup (set up in createSandbox) does the actual teardown:
    // aborts the message listener, detaches OS event subs, closes WebSockets,
    // removes any open file dialog overlay, and detaches the error-handling
    // / permission-gate / fullscreen listeners.
    if (typeof sandbox.cleanup === 'function') {
      sandbox.cleanup();
    }

    // Remove the webview element from the DOM. Without this, a backgrounded
    // sandbox (whose webview lives in #background-app-host) would leak the
    // element and its renderer process forever, even after destroy().
    const webview = sandbox.webview;
    if (webview && webview.parentNode) {
      webview.parentNode.removeChild(webview);
    }

    // Unregister app files from the Express serve route. Best-effort —
    // failures here don't affect the sandbox teardown.
    fetch(`/api/apps/serve/unregister/${encodeURIComponent(sandboxId)}`, { method: 'DELETE' })
      .catch(() => {});

    // Same-origin gating (sanitizeSandboxAttr, above) only controls whether
    // the guest's raw cookies/localStorage/sessionStorage land on a real,
    // stable origin vs an opaque one — it does NOT stop those DOM storage
    // APIs from writing to disk. The persist:app_<appId> partition is a
    // separate Chromium mechanism, set unconditionally in createSandbox(),
    // so an opaque-origin (unpermissioned) app's raw storage writes still
    // survive relaunch under that same reused partition. That's the actual
    // gap sandbox:same-origin's wording ("cookies/localStorage/sessionStorage
    // on the shared origin") implies should NOT persist for these apps.
    //
    // nova:storage:* is unaffected by this — it's a completely separate,
    // host-shell-side IndexedDB, isolated by [appId, key], not by this
    // partition. Wiping the partition here never touches it.
    //
    // Only wipe for apps that weren't granted allow-same-origin at
    // creation. Best-effort: a failure here shouldn't block teardown.
    const appId = sandbox.appId;
    // Do not wipe the app-id partition while another window of the same app
    // is still running; all those windows share the same persisted partition.
    const anotherWindowUsesPartition = [...activeSandboxes.values()].some(entry => entry.appId === appId);
    const webviewHasSameOrigin = !!sandbox.webview
      && typeof sandbox.webview.getAttribute === 'function'
      && (sandbox.webview.getAttribute('sandbox') || '').split(/\s+/).includes('allow-same-origin');
    // The effective sandbox attribute is authoritative here. A permission
    // grant without the manifest flag does not add allow-same-origin, so its
    // partition still needs the normal cleanup when the final window closes.
    const mustClearPartition = partitionCleanupRequired.has(appId) || !webviewHasSameOrigin;
    if (appId && mustClearPartition && !anotherWindowUsesPartition) {
      queueExecutionPartitionCleanup(appId).catch(e => {
        log('error', 'destroy() — failed to clear storage partition for', appId, e);
      });
    }

    // activeSandboxes.delete(sandboxId) already ran at the top of this
    // function — that early delete is the reentrancy guard, see the
    // comment there for why.
    // A badge is a view of live state — a closed app has no live state.
    try {
      if (appBadgeState.delete(appId)) publishBadge(appId);
    } catch (_) { /* best-effort */ }
    // Same for fs watchers: no sandbox, nowhere to push events.
    try { stopFsWatchersForApp(appId); } catch (_) { /* best-effort */ }
    log('debug', `Destroyed sandbox: ${sandboxId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `Destroyed sandbox ${sandboxId}`, data: { appId: sandbox.appId, sandboxId } });
    }

    return true;
  }

  // Push a background-wake event into a specific sandbox's guest page.
  // Narrow, purpose-built wrapper around the internal respond() push
  // mechanism — not a general "send anything into any sandbox" API, since
  // that would let a caller forge arbitrary IPC responses. This only ever
  // sends the one wake payload shape AppScheduler produces, to a sandbox
  // that scheduler itself just created or already knows about.
  function dispatchBackgroundWake(sandboxId, payload) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    respond(sandbox.webview, 'nova:background:wake', generateRequestId(), payload || {});
    return true;
  }

  // Get active sandbox info by ID.
  function getSandbox(sandboxId) {
    return activeSandboxes.get(sandboxId) || null;
  }

  // Keep a sandbox's webview (and the process behind it) alive after its
  // window has been closed, for apps holding system:background:live.
  //
  // This does NOT touch activeSandboxes, the API bridge, or any of the
  // sandbox's live state (WebSocket connections, event subscriptions,
  // etc.) — none of that is torn down, unlike a real destroy(). All this
  // does is reparent the webview element out of the closing window's DOM
  // subtree (which is about to be removed) into the hidden
  // #background-app-host, so the element survives `state.element.remove()`
  // and keeps running invisibly.
  function detachToBackground(sandboxId) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox) return false;

    const host = document.getElementById('background-app-host');
    if (!host) {
      log('warn', `detachToBackground: #background-app-host not found, cannot keep ${sandboxId} alive`);
      return false;
    }

    const webview = sandbox.webview;
    if (webview && webview.parentNode !== host) {
      host.appendChild(webview);
    }

    sandbox.backgrounded = true;
    sandbox.backgroundedAt = new Date().toISOString();
    // Distinct from backgrounded/backgroundedAt: this never gets cleared
    // by reattachFromBackground(), so wm.js can tell "first time going to
    // background" (show the 'started running' toast) apart from "resuming
    // background mode after a reattach-then-close cycle" (skip the toast —
    // it never actually stopped).
    sandbox.everBackgrounded = true;
    // windowId no longer refers to a live window once the window is gone —
    // keep the old value around under a different key for diagnostics
    // (Inspector, EventLog) rather than silently dropping it.
    sandbox.lastWindowId = sandbox.windowId;
    sandbox.windowId = null;

    log('debug', `Detached sandbox ${sandboxId} to background host`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} kept alive in background`, data: { appId: sandbox.appId, sandboxId } });
    }
    return true;
  }

  // Fully stop a backgrounded sandbox — the Terminate action's actual
  // effect. This is just destroy(): once a sandbox is in the background
  // host rather than a window, ending it is identical to a normal
  // teardown, since there's no window to also close.
  function terminateBackground(sandboxId) {
    return destroy(sandboxId);
  }

  // Move a backgrounded sandbox's webview back into a freshly-created
  // window's content area, and clear its backgrounded state. This is the
  // counterpart to detachToBackground() — without it, reopening an app
  // that's currently alive in the background just launches a second,
  // independent sandbox via the normal launch() path, leaving the
  // original running invisibly with two instances of the same app now
  // open (one live in #background-app-host, one in the new window).
  //
  // The webview element itself, its IPC bridge (setupAPIBridge is keyed
  // to the webview/sandboxId, not to any particular window state), and
  // its in-page JS state all survive the move untouched — only the DOM
  // parent changes. What we do need to refresh is sandbox.state and
  // sandbox.windowId, since detachToBackground() nulled/staled those when
  // the original window closed, and closeWindow() (if this window closes
  // again later) reads the window's own state.appId, not the sandbox's,
  // so this mainly keeps AppSandbox's own bookkeeping (Inspector,
  // getAllSandboxes()) accurate rather than gating any security check.
  function reattachFromBackground(sandboxId, container, state) {
    const sandbox = activeSandboxes.get(sandboxId);
    if (!sandbox || !sandbox.webview) return false;
    if (!container) return false;

    container.innerHTML = '';
    container.appendChild(sandbox.webview);

    sandbox.backgrounded = false;
    sandbox.backgroundedAt = null;
    sandbox.state = state;
    sandbox.windowId = state?.id;
    // Deliberately NOT resetting wantsBackgroundLive here. The process
    // never stopped and its intent to stay alive was already established
    // this continuous session (via nova.stayAliveInBackground()) — that
    // doesn't need to be re-asked just because the user glanced at the
    // window and closed it again. Resetting it would force every
    // reattach-then-close cycle to silently drop back to foreground-only,
    // which is a worse failure mode than the one this whole feature
    // exists to prevent: an app the user believes is still running
    // quietly stops being kept alive with no signal that anything
    // changed. If an app wants OUT of background mode, it calls
    // nova.stayAliveInBackground(false) itself.

    log('debug', `Reattached sandbox ${sandboxId} from background host to window ${state?.id}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'AppSandbox', category: 'security', severity: 'info', message: `${sandbox.appId} reattached from background`, data: { appId: sandbox.appId, sandboxId, windowId: state?.id } });
    }
    return true;
  }

  // Get all active sandboxes as an array.
  function getAllSandboxes() {
    // Spread the map key in as `sandboxId` on each entry — callers like
    // WM.closeWindow() need to look up a sandbox by windowId/appId and then
    // act on that specific instance (detachToBackground/terminateBackground),
    // and both of those take a sandboxId string, not the object itself.
    return Array.from(activeSandboxes.entries()).map(([sandboxId, sandbox]) => ({ sandboxId, ...sandbox }));
  }

  // Clear the on-disk storage partitions for a given app id
  // (persist:app_<appId> and persist:app_<appId>_webcontent). This is a
  // separate Chromium storage partition from the host window's
  // localStorage/IndexedDB/OPFS, and from the app's FS/OPFS data
  // folder cleaned up elsewhere — none of those touch these partitions.
  //
  // Callers that fully remove an app's data (uninstall, "wipe all
  // data", factory reset) must call this too, or the app's cookies,
  // IndexedDB, cache, and nested-site browser data survive on disk.
  //
  // Safe to call even if the app was never launched (partition simply
  // doesn't exist yet, and gets created+immediately-cleared, which is
  // harmless).
  async function clearAppPartitionsByName(appId, partitionNames) {
    if (!appId) throw new Error('appId is required to clear app storage');

    // ClearData only works after a real same-origin navigation in the target
    // partition. Failure to register/navigate/clear is an error, never a
    // successful no-op: callers use the result to decide whether a new app
    // renderer may safely reuse the partition.
    const sandboxId = 'sandbox_clr_' + String(appId).replace(/[^\w.-]/g, '_') + '_' + Date.now();
    let baseUrl;
    const files = { 'index.html': encodeBase64Utf8('<!doctype html><html><body></body></html>') };
    const regRes = await fetch('/api/apps/serve/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sandboxId, files }),
    });
    if (!regRes.ok) throw new Error('Storage cleanup page registration failed: ' + regRes.status);
    ({ baseUrl } = await regRes.json());
    if (typeof baseUrl !== 'string' || !baseUrl) {
      await fetch('/api/apps/serve/unregister/' + encodeURIComponent(sandboxId), { method: 'DELETE' }).catch(() => {});
      throw new Error('Storage cleanup page registration returned no base URL');
    }

    const clearPartition = partitionName => new Promise((resolve, reject) => {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:' + partitionName);
      wv.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
      const clearTypes = { appcache: true, cache: true, cookies: true, fileSystems: true, indexedDB: true, localStorage: true, webSQL: true };
      let settled = false;
      let clearing = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        wv.removeEventListener('loadstop', onLoadStop);
        wv.removeEventListener('loadabort', onLoadAbort);
        try { wv.remove(); } catch { /* already removed */ }
        if (error) reject(error); else resolve();
      };
      const onLoadStop = () => {
        if (settled || clearing) return;
        clearing = true;
        try {
          wv.clearData({}, clearTypes, () => finish());
        } catch (error) {
          finish(new Error('clearData failed for partition ' + partitionName + ': ' + (error?.message || error)));
        }
      };
      const onLoadAbort = event => finish(new Error('Storage cleanup navigation failed for ' + partitionName + (event?.reason ? ': ' + event.reason : '')));
      const timeoutId = setTimeout(() => finish(new Error('Storage cleanup timed out for partition ' + partitionName)), CLEAR_PARTITION_TIMEOUT_MS);
      wv.addEventListener('loadstop', onLoadStop);
      wv.addEventListener('loadabort', onLoadAbort);
      document.body.appendChild(wv);
      wv.src = window.location.origin + baseUrl + '/index.html';
    });

    try {
      await Promise.all(partitionNames.map(clearPartition));
    } finally {
      // The temporary served page must not accumulate in the server registry.
      await fetch('/api/apps/serve/unregister/' + encodeURIComponent(sandboxId), { method: 'DELETE' }).catch(error => {
        log('warn', 'Could not unregister temporary storage-cleanup page', error);
      });
    }
  }

  /** Every partition name an app has ever ridden: legacy single-user and
   *  the active owner's scoped variants (guest partitions are volatile and
   *  need no clearing). */
  function appPartitionNames(appId) {
    const names = [
      `app_${appId}`,
      `app_${appId}_webcontent`,
    ];
    if (typeof NovaUserScope !== 'undefined' && NovaUserScope?.enabled?.()) {
      const owner = String(NovaUserScope.ownerUid() || '');
      if (owner) {
        names.push(`u${owner}_app_${appId}`, `u${owner}_app_${appId}_webcontent`);
      }
    }
    return names;
  }

  async function clearAppExecutionPartition(appId) {
    return clearAppPartitionsByName(appId, appPartitionNames(appId).slice(0, 2));
  }

  async function clearAppPartition(appId) {
    return clearAppPartitionsByName(appId, appPartitionNames(appId));
  }

  // Clear storage partitions for multiple apps in parallel. Used by
  // bulk operations (wipe all data, factory reset).
  function clearAppPartitions(appIds) {
    return Promise.all((appIds || []).map(clearAppPartition)).then(() => {});
  }

  // Public API

  return {
    createSandbox,
    launch,
    launchHome,
    destroy,
    handlePermissionRevoked,
    getSandbox,
    getAllSandboxes,
    getBadge,
    clearAppPartition,
    clearAppPartitions,
    // storageClear/clearAllStorage clear nova:storage (a separate,
    // host-shell-side IndexedDB keyed by [appId, key] — see storageClear
    // above) which clearAppPartition(s) never touches, since that only
    // wipes the webview's own persist:app_<appId> partition. Uninstall
    // and factory-reset callers need both: clearAppPartition(appId) for
    // the app and nested-site webview partitions, storageClear(appId) or clearAllStorage()
    // for this store.
    storageClear,
    clearAllStorage,
    // Storage ledger — per-app budgets, accounting, and shared-access audit
    // (the "logical UID" layer). Settings (trusted host tier) reads the
    // snapshot for its storage/privacy dashboard; uninstall/clear-data flows
    // call removeApp/resetForApp. Apps never see any of this over IPC.
    storageLedger: StorageLedger,
    storageLedgerSnapshot,
    macPolicy: MacPolicy,
    macPolicySnapshot,
    detachToBackground,
    terminateBackground,
    dispatchBackgroundWake,
    reattachFromBackground,
    getRootAuditLog: getRootAuditEntries,
    isRootExecutionApp,
    subscribeRootAudit(callback) {
      if (typeof callback !== 'function') throw new TypeError('Root audit subscriber must be a function');
      rootAuditSubscribers.add(callback);
      return () => rootAuditSubscribers.delete(callback);
    },
    reloadAfterRootRevocation,
    dispatchIsolatedProcessRequest,

    // Internal exports for testing and advanced consumers. Not covered by
    // stability guarantees — do not depend on these in production code.
    _internal: {
      escapeHtml,
      sanitizeSandboxAttr,
      injectCapabilityShim,
      encodeBase64Utf8,
      decodeBase64Utf8,
      generateRequestId,
      resolveAndClassifyUrl,
      resolveAndClassifyWebSocketUrl,
      isInternalHost,
      handlePermissionRevoked,
      GUEST_FORBIDDEN_IPC_APIS,
      appBadgeState,
      fsWatchers,
      fsWatchConfig,
      stopFsWatchersForApp,
      deliverShareTarget,
      normalizedShareTargetMimes,
      shareTargetMatches,
      deliverPushMessage,
      flushPushQueue,
      loadPushState,
      ensurePushConnection,
      cleanupSandboxRecord,
      clearAppPartitionsByName,
      ensureExecutionPartitionClean,
      partitionCleanupRequired,
      parsePositiveInt,
      validateStorageKey,
      handleAPICall,
      dispatchIsolatedProcessRequest,
      respond,
      normalizeFsSavePayload,
      normalizePickerAcceptList,
      pickerAcceptMatcher,
      looksLikeUtf8Text,
      setupAPIBridge,
      API_HANDLERS,
      buildCapabilityShim,
      buildNovaOSFacadeSource,
      deferPackagedScripts,
      buildIsolatedTransportScript,
      isNestedWebviewOptedIn,
      isNestedWebviewPermitted,
      isEscapePopupsOptedIn,
      setupSandboxPopupHandler,
      loadAppContent,
      stableServeAppId,
      RELAXED_CSP_META,
      // Test-only helpers for resetting module state between tests.
      _resetState() {
        activeSandboxes.clear();
        for (const pending of pendingAppIpcCalls.values()) {
          clearTimeout(pending.timer);
          pending.resolve({ error: 'App IPC state was reset' });
        }
        pendingAppIpcCalls.clear();
        appIpcRateLimits.clear();
        partitionCleanupPromises.clear();
        partitionCleanupRequired.clear();
        rootExecutionApps.clear();
        rootAuditSubscribers.clear();
        rootRevocationReloadScheduled = false;
        rootAuditEntries = null;
        if (rootAuditPersistTimer) rootAuditClearTimeout(rootAuditPersistTimer);
        rootAuditPersistTimer = null;
        eventSubscriptions.clear();
        openDialogs.clear();
        shareDialogs.clear();
        notifRateLimitLog.clear();
        crossAppLaunchRateLimits.clear();
        appearanceSetRateLimits.clear();
        storageDbPromise = null;
        _isolatedTransportScriptCache = null;
        StorageLedger.resetAll();
      },
      _activeSandboxes: activeSandboxes,
      _eventSubscriptions: eventSubscriptions,
      _openDialogs: openDialogs,
    },
  };
})();

// CommonJS export for Node.js test runners and bundlers that expect it.
// In the browser, the module attaches as a global `AppSandbox`.
if (typeof window !== 'undefined') {
  window.AppSandbox = AppSandbox;
  // Taskbar badge store (session-only, written by the nova:badge:*
  // handlers, read by the taskbar renderer in the launcher). Read-only
  // view on purpose — the only writers are the permission-gated handlers.
  // appBadgeState lives inside the AppSandbox closure, so go through its
  // public getter. Referencing the Map from here threw a ReferenceError
  // on every taskbar refresh.
  window.NovaAppBadges = Object.freeze({
    get: function(appId) {
      return AppSandbox.getBadge(appId);
    },
  });
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppSandbox;
}