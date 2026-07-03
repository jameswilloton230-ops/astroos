'use strict';

// ============================================================================
// Typed errors
// ============================================================================

/**
 * Base class for all errors thrown by this module.
 * Uses ES2022 `Error.cause` for chaining.
 */
class WebAppManagerError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'WebAppManagerError';
  }
}

/**
 * Thrown when caller-supplied input fails validation at the boundary.
 * Carries `field` for programmatic handling.
 */
class ValidationError extends WebAppManagerError {
  constructor(message, { field, cause } = {}) {
    super(message, { cause });
    this.name = 'ValidationError';
    this.field = field ?? null;
  }
}

/**
 * Thrown when an app id does not match any stored app.
 */
class NotFoundError extends WebAppManagerError {
  constructor(message, { id, cause } = {}) {
    super(message, { cause });
    this.name = 'NotFoundError';
    this.id = id ?? null;
  }
}

/**
 * Thrown when localStorage is unavailable, denied, or over quota.
 * `persistent` is true when the failure is permanent (e.g. sandboxed context).
 */
class StorageError extends WebAppManagerError {
  constructor(message, { cause, persistent = false } = {}) {
    super(message, { cause });
    this.name = 'StorageError';
    this.persistent = Boolean(persistent);
  }
}

// ============================================================================
// JSDoc type definitions
// ============================================================================

/**
 * A stored web application.
 *
 * @typedef {Object} WebApp
 * @property {string} id                  Unique identifier.
 * @property {string} name                Human-readable name.
 * @property {string} url                  Launch URL (http or https).
 * @property {string|null} icon             Icon URL / emoji / SVG, or null.
 * @property {string} addedDate            ISO 8601 timestamp the app was added.
 * @property {number} launchCount          Number of times the app has been launched.
 * @property {string|null} lastLaunched    ISO 8601 timestamp of last launch, or null.
 */

/**
 * Input used to create a web app.
 *
 * @typedef {Object} WebAppInput
 * @property {string} name
 * @property {string} url
 * @property {string} icon
 */

/**
 * Aggregate statistics across all stored apps.
 *
 * @typedef {Object} WebAppStats
 * @property {number} totalApps
 * @property {number} totalLaunches
 * @property {Array<{name: string, launches: number, added: string}>} apps
 */

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'nova_web_apps';
const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 100;

const LIMITS = Object.freeze({
  MAX_APPS: 200,
  MAX_NAME_LENGTH: 100,
  MAX_URL_LENGTH: 2048,
  MAX_ICON_LENGTH: 2048,
});

const EVENT_ADD = 'app:added';
const EVENT_REMOVE = 'app:removed';

// ============================================================================
// Logger
// ============================================================================

const LOG_LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
});

let currentLogLevel = LOG_LEVELS.info;

function createLogger(scope) {
  const prefix = `[${scope}]`;

  const shouldLog = (level) => level >= currentLogLevel;

  return Object.freeze({
    /** @param {keyof typeof LOG_LEVELS} level */
    setLevel(level) {
      currentLogLevel = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    },
    debug(...args) { if (shouldLog(LOG_LEVELS.debug)) console.debug(prefix, ...args); },
    info(...args)  { if (shouldLog(LOG_LEVELS.info))  console.info(prefix, ...args); },
    warn(...args)  { if (shouldLog(LOG_LEVELS.warn))  console.warn(prefix, ...args); },
    error(...args) { if (shouldLog(LOG_LEVELS.error)) console.error(prefix, ...args); },
  });
}

const log = createLogger('WebAppManager');

// ============================================================================
// Internal state (module-level singleton)
// ============================================================================

const state = {
  /** @type {WebApp[]} */
  apps: [],
  initialized: false,
  storageAvailable: false,
  storagePersistentFailure: false,
  /** Debounced save timer id (null when no save is pending). */
  saveTimerId: null,
  /** Whether a save is currently scheduled. */
  savePending: false,
  /** EventTarget backing the public event API. */
  events: new EventTarget(),
  /** AbortController used to tear down global lifecycle listeners. */
  lifecycle: null,
};

// ============================================================================
// Storage detection & helpers
// ============================================================================

/**
 * Detect whether localStorage is available AND writable.
 * Performs a probe write/read/delete — feature-detection alone is not enough,
 * because some browsers expose the object but throw on access (sandboxed iframes,
 * private browsing in older Safari).
 *
 * @returns {boolean}
 */
function detectStorage() {
  try {
    if (typeof localStorage === 'undefined' || localStorage === null) {
      return false;
    }
    const probeKey = '__nova_probe__';
    localStorage.setItem(probeKey, '1');
    localStorage.removeItem(probeKey);
    return true;
  } catch (error) {
    if (isStorageSecurityError(error)) {
      log.warn('localStorage access denied (sandboxed context); using in-memory storage');
    } else {
      log.warn('localStorage probe failed; using in-memory storage:', error);
    }
    return false;
  }
}

/**
 * Cross-realm-safe check that an error is a storage access/security failure.
 * Uses `Error.isError` (ES2026) when available, falls back to `instanceof Error`.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isStorageSecurityError(error) {
  if (typeof Error !== 'undefined' && typeof Error.isError === 'function') {
    if (!Error.isError(error)) return false;
  } else if (!(error instanceof Error)) {
    return false;
  }
  return error.name === 'SecurityError' || error.name === 'QuotaExceededError';
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isStorageQuotaError(error) {
  return error instanceof Error && error.name === 'QuotaExceededError';
}

// ============================================================================
// Schema migration
// ============================================================================

/**
 * Migrate stored payload to the current schema.
 *
 * Supports two legacy shapes:
 *   - raw array (original v0 format)
 *   - versioned object ({ version, apps })
 *
 * Each stored app is normalised; invalid entries are dropped so a single
 * corrupt record cannot brick the entire list.
 *
 * @param {unknown} parsed
 * @returns {{ version: number, apps: WebApp[] }}
 */
function migrateStoredData(parsed) {
  if (Array.isArray(parsed)) {
    return { version: SCHEMA_VERSION, apps: parsed.map(normalizeStoredApp).filter(Boolean) };
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
    // Future: branch on parsed.version to apply incremental migrations.
    const apps = Array.isArray(parsed.apps) ? parsed.apps : [];
    return { version: SCHEMA_VERSION, apps: apps.map(normalizeStoredApp).filter(Boolean) };
  }
  return { version: SCHEMA_VERSION, apps: [] };
}

/**
 * Coerce a raw stored entry into a valid WebApp, or return null if unfixable.
 *
 * @param {unknown} raw
 * @returns {WebApp|null}
 */
function normalizeStoredApp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  const url = typeof raw.url === 'string' ? raw.url : null;
  const icon = typeof raw.icon === 'string' ? raw.icon : null;
  if (!id || !name || !url || !icon) return null;
  if (!isValidUrl(url)) return null;

  const launchCount = Number.isFinite(raw.launchCount)
    ? Math.max(0, Math.floor(raw.launchCount))
    : 0;

  const addedDate = typeof raw.addedDate === 'string'
    ? raw.addedDate
    : new Date(0).toISOString();

  const lastLaunched = typeof raw.lastLaunched === 'string' ? raw.lastLaunched : null;

  return { id, name, url, icon, addedDate, launchCount, lastLaunched };
}

// ============================================================================
// Storage I/O
// ============================================================================

/**
 * Read and migrate the stored payload.
 *
 * @returns {{ version: number, apps: WebApp[] }}
 */
function readFromStorage() {
  if (!state.storageAvailable) {
    return { version: SCHEMA_VERSION, apps: [] };
  }

  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    if (isStorageSecurityError(error)) {
      state.storagePersistentFailure = true;
      log.warn('localStorage read denied:', error);
      return { version: SCHEMA_VERSION, apps: [] };
    }
    throw new StorageError('Failed to read web apps from storage', { cause: error });
  }

  if (raw === null) return { version: SCHEMA_VERSION, apps: [] };

  try {
    return migrateStoredData(JSON.parse(raw));
  } catch (error) {
    // Corrupt JSON is unrecoverable; reset to empty list rather than crash.
    log.error('Stored web apps JSON is corrupt; resetting to empty list:', error);
    return { version: SCHEMA_VERSION, apps: [] };
  }
}

/**
 * Synchronously write the payload to localStorage.
 *
 * @param {{ version: number, apps: WebApp[] }} payload
 * @throws {StorageError}
 */
function writeToStorage(payload) {
  if (!state.storageAvailable) return;

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch (error) {
    throw new StorageError('Failed to serialize web apps', { cause: error });
  }

  try {
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (error) {
    if (isStorageQuotaError(error)) {
      throw new StorageError('Storage quota exceeded', { cause: error });
    }
    if (isStorageSecurityError(error)) {
      state.storagePersistentFailure = true;
      throw new StorageError('Storage write denied', { cause: error, persistent: true });
    }
    throw new StorageError('Failed to write web apps to storage', { cause: error });
  }
}

/**
 * Schedule a debounced write. Multiple rapid mutations coalesce into one write.
 */
function scheduleSave() {
  if (!state.storageAvailable || state.storagePersistentFailure) return;
  if (state.saveTimerId !== null) return; // already pending
  state.savePending = true;
  state.saveTimerId = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

/**
 * Flush any pending save immediately. Safe to call from `pagehide`.
 * Errors are caught and logged so lifecycle handlers never throw.
 */
function flushSave() {
  if (state.saveTimerId !== null) {
    clearTimeout(state.saveTimerId);
    state.saveTimerId = null;
  }
  if (!state.savePending) return;
  state.savePending = false;

  const payload = { version: SCHEMA_VERSION, apps: state.apps };
  try {
    writeToStorage(payload);
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.persistent) {
        log.warn('Persistent storage failure; remaining in-memory only');
      } else if (/quota/i.test(error.message)) {
        log.error('Storage quota exceeded; latest changes were not persisted');
      } else {
        log.error('Failed to persist web apps:', error);
      }
    } else {
      // Programmer error — re-throw so it surfaces in dev tools.
      throw error;
    }
  }
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Assert that `value` is a string, optionally with a max length.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 * @throws {ValidationError}
 */
function assertString(value, label, { maxLength } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be a string`, { field: label });
  }
  if (maxLength !== undefined && value.length > maxLength) {
    throw new ValidationError(
      `${label} must be at most ${maxLength} characters`,
      { field: label },
    );
  }
  return value;
}

/**
 * Sanitise a string input: assert string, enforce max length, optionally trim.
 *
 * @param {unknown} value
 * @param {{ maxLength: number, label: string, trim?: boolean }} options
 * @returns {string}
 */
function sanitizeString(value, { maxLength, label, trim = true }) {
  const str = assertString(value, label, { maxLength });
  return trim ? str.trim() : str;
}

/**
 * Validate that a string is a safe http(s) URL.
 *
 * Rejects:
 *   - non-string / empty input
 *   - non-http(s) schemes (javascript:, data:, file:, …)
 *   - URLs containing embedded credentials (phishing vector)
 *   - URLs without a hostname
 *   - URLs exceeding MAX_URL_LENGTH
 *
 * @param {string} urlString
 * @returns {boolean}
 */
function isValidUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.length === 0) return false;
  if (urlString.length > LIMITS.MAX_URL_LENGTH) return false;

  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  if (!url.hostname) return false;
  return true;
}

/**
 * Validate and normalise the input for `addApp`.
 *
 * @param {unknown} input
 * @returns {{ name: string, url: string, icon: string }}
 * @throws {ValidationError}
 */
function validateAppInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('App input must be an object', { field: 'app' });
  }

  const name = sanitizeString(input.name, { maxLength: LIMITS.MAX_NAME_LENGTH, label: 'name' });
  if (name.length === 0) {
    throw new ValidationError('App name must not be empty', { field: 'name' });
  }

  const url = sanitizeString(input.url, { maxLength: LIMITS.MAX_URL_LENGTH, label: 'url' });
  if (!isValidUrl(url)) {
    throw new ValidationError(
      'Invalid URL — must be http:// or https://, without credentials',
      { field: 'url' },
    );
  }

  const icon = input.icon
    ? sanitizeString(input.icon, { maxLength: LIMITS.MAX_ICON_LENGTH, label: 'icon' })
    : null;

  return { name, url, icon };
}

// ============================================================================
// ID & timestamp generation
// ============================================================================

/**
 * Generate a collision-resistant id. Prefers `crypto.randomUUID` (CSPRNG);
 * falls back to time + Math.random for very old environments.
 *
 * @returns {string}
 */
function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-app-${crypto.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `web-app-${Date.now().toString(36)}-${random}`;
}

/**
 * Current timestamp as ISO 8601 (UTC).
 *
 * Uses `Date` rather than `Temporal` here because the value is persisted
 * alongside legacy records and must round-trip with existing readers.
 * The skill permits `Date` for legacy interop.
 *
 * @returns {string}
 */
function nowISO() {
  return new Date().toISOString();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialise the manager and load apps from storage.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
function initialize() {
  if (state.initialized) return;

  state.storageAvailable = detectStorage();

  try {
    const data = readFromStorage();
    state.apps = data.apps;
  } catch (error) {
    log.error('Failed to load web apps:', error);
    state.apps = [];
  }

  // Register lifecycle listeners so debounced writes survive page navigation.
  // AbortController.signal gives us clean teardown in `destroy()`.
  state.lifecycle = new AbortController();
  const { signal } = state.lifecycle;

  if (typeof window !== 'undefined') {
    const safeFlush = () => {
      try { flushSave(); } catch (error) { log.error('Failed to flush on lifecycle event:', error); }
    };
    // `pagehide` is the reliable unload signal in modern browsers (replaces `unload`).
    window.addEventListener('pagehide', safeFlush, { signal });
    // `visibilitychange` to `hidden` is the mobile/unload-equivalent.
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') safeFlush();
    }, { signal });
    // `beforeunload` is deprecated but still useful as a belt-and-braces signal.
    window.addEventListener('beforeunload', safeFlush, { signal });
  }

  state.initialized = true;
  log.info(`Loaded ${state.apps.length} web apps`);
}

/**
 * Add a new web app.
 *
 * @param {WebAppInput} app
 * @returns {WebApp} The added app (frozen deep copy).
 * @throws {ValidationError} If the input is invalid.
 * @throws {StorageError} If the app list is full.
 */
function addApp(app) {
  ensureInitialized();
  const { name, url, icon } = validateAppInput(app);

  if (state.apps.length >= LIMITS.MAX_APPS) {
    throw new StorageError(
      `Maximum number of web apps (${LIMITS.MAX_APPS}) reached`,
    );
  }

  /** @type {WebApp} */
  const newApp = {
    id: generateId(),
    name,
    url,
    icon,
    addedDate: nowISO(),
    launchCount: 0,
    lastLaunched: null,
  };

  state.apps.push(newApp);
  scheduleSave();
  emitEvent(EVENT_ADD, newApp);

  if (!newApp.icon) {
    try {
      const parsed = new URL(newApp.url);
      const hostname = parsed.hostname.replace(/^www\./, '');
      newApp.icon = `https://icons.duckduckgo.com/ico/${hostname}.ico`;
      scheduleSave();
      log.info(`Set DuckDuckGo favicon for ${newApp.name}: ${newApp.icon}`);
    } catch (err) {
      log.warn(`Favicon setup failed for ${newApp.name}:`, err);
    }
  }

  log.info(`Added web app: ${newApp.name}`);
  return freezeApp(newApp);
}

/**
 * Remove a web app by id.
 *
 * @param {string} appId
 * @returns {boolean} `true` if an app was removed, `false` if not found.
 * @throws {ValidationError} If `appId` is not a string.
 */
function removeApp(appId) {
  ensureInitialized();
  assertString(appId, 'appId');

  const index = state.apps.findIndex((app) => app.id === appId);
  if (index === -1) return false;

  const [removed] = state.apps.splice(index, 1);
  scheduleSave();
  emitEvent(EVENT_REMOVE, removed);

  log.info(`Removed web app: ${removed.name}`);
  return true;
}

/**
 * Return a frozen deep copy of every stored app.
 * Callers cannot mutate internal state through the returned value.
 *
 * @returns {WebApp[]}
 */
function getAllApps() {
  ensureInitialized();
  return state.apps.map((app) => freezeApp(app));
}

/**
 * Return a frozen deep copy of the app with the given id, or `null`.
 *
 * @param {string} appId
 * @returns {WebApp|null}
 */
function getApp(appId) {
  ensureInitialized();
  if (typeof appId !== 'string') return null;
  const app = state.apps.find((a) => a.id === appId);
  return app ? freezeApp(app) : null;
}

/**
 * Record a launch for the given app.
 *
 * @param {string} appId
 * @returns {WebApp} The updated app (frozen deep copy).
 * @throws {ValidationError} If `appId` is not a string.
 * @throws {NotFoundError} If the app does not exist.
 */
function launchApp(appId) {
  ensureInitialized();
  assertString(appId, 'appId');

  const app = state.apps.find((a) => a.id === appId);
  if (!app) {
    throw new NotFoundError(`Web app not found: ${appId}`, { id: appId });
  }

  app.launchCount = (app.launchCount || 0) + 1;
  app.lastLaunched = nowISO();
  scheduleSave();

  log.info(`Launch recorded for: ${app.name}`);
  return freezeApp(app);
}

/**
 * Register a callback for app-added events.
 *
 * Multiple callbacks may be registered; each registration returns an
 * unsubscribe function. (Backward compatible: the previous single-callback
 * API still works because callers historically ignored the return value.)
 *
 * @param {(app: WebApp) => void} callback
 * @returns {() => void} Unsubscribe function.
 * @throws {ValidationError} If `callback` is not a function.
 */
function onAdd(callback) {
  return subscribe(EVENT_ADD, callback);
}

/**
 * Register a callback for app-removed events.
 *
 * @param {(app: WebApp) => void} callback
 * @returns {() => void} Unsubscribe function.
 * @throws {ValidationError} If `callback` is not a function.
 */
function onRemove(callback) {
  return subscribe(EVENT_REMOVE, callback);
}

/**
 * Return aggregate statistics across all stored apps.
 * The returned object contains no references to internal state.
 *
 * @returns {WebAppStats}
 */
function getStats() {
  ensureInitialized();
  const totalLaunches = state.apps.reduce(
    (sum, app) => sum + (app.launchCount || 0),
    0,
  );
  return {
    totalApps: state.apps.length,
    totalLaunches,
    apps: state.apps.map((app) => ({
      name: app.name,
      launches: app.launchCount || 0,
      added: app.addedDate,
    })),
  };
}

/**
 * Flush any pending debounced save. Call this when you need to guarantee
 * persistence (e.g. before a programmatic navigation that bypasses `pagehide`).
 */
function flush() {
  flushSave();
}

/**
 * Tear down the manager: flush pending writes and remove global listeners.
 * Useful for tests and hot-reload scenarios. After `destroy()`, the manager
 * can be re-initialised by calling `initialize()` again.
 */
function destroy() {
  flushSave();
  if (state.lifecycle) {
    state.lifecycle.abort();
    state.lifecycle = null;
  }
  state.apps = [];
  state.initialized = false;
  state.savePending = false;
  state.saveTimerId = null;
}

/**
 * Set the minimum log level. One of: 'debug' | 'info' | 'warn' | 'error' | 'silent'.
 * @param {'debug'|'info'|'warn'|'error'|'silent'} level
 */
function setLogLevel(level) {
  log.setLevel(level);
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Lazy-initialise on first use. This guards against consumers that import the
 * module but forget to call `initialize()` — the auto-init block at the bottom
 * of the file handles the legacy script-tag case.
 */
function ensureInitialized() {
  if (!state.initialized) {
    initialize();
  }
}

/**
 * Emit a frozen copy of the app to all subscribers.
 *
 * @param {string} type
 * @param {WebApp} app
 */
function emitEvent(type, app) {
  state.events.dispatchEvent(
    new CustomEvent(type, { detail: freezeApp(app) }),
  );
}

/**
 * Subscribe to an internal event type.
 *
 * @param {string} type
 * @param {(app: WebApp) => void} callback
 * @returns {() => void}
 * @throws {ValidationError} If `callback` is not a function.
 */
function subscribe(type, callback) {
  if (typeof callback !== 'function') {
    throw new ValidationError('Callback must be a function', { field: 'callback' });
  }
  const handler = (event) => callback(/** @type {CustomEvent<WebApp>} */ (event).detail);
  state.events.addEventListener(type, handler);
  return () => state.events.removeEventListener(type, handler);
}

/**
 * Return a frozen deep copy of an app. `structuredClone` ensures nested
 * values (future-proofing for arrays/objects on the app shape) are isolated;
 * `Object.freeze` enforces immutability at the boundary.
 *
 * @param {WebApp} app
 * @returns {WebApp}
 */
function freezeApp(app) {
  return Object.freeze(structuredClone(app));
}

// ============================================================================
// Exports
// ============================================================================

const WebAppManager = Object.freeze({
  initialize,
  addApp,
  removeApp,
  getAllApps,
  getApp,
  launchApp,
  onAdd,
  onRemove,
  getStats,
  isValidUrl,
  // New additive APIs:
  flush,
  destroy,
  setLogLevel,
});

export default WebAppManager;
export {
  WebAppManager,
  WebAppManagerError,
  ValidationError,
  NotFoundError,
  StorageError,
  initialize,
  addApp,
  removeApp,
  getAllApps,
  getApp,
  launchApp,
  onAdd,
  onRemove,
  getStats,
  isValidUrl,
  flush,
  destroy,
  setLogLevel,
};

// ============================================================================
// Backward compatibility & auto-initialization
// ============================================================================

// Expose as a global for legacy consumers loaded via <script src="...">.
// Modern consumers should use the named exports instead.
if (typeof globalThis !== 'undefined') {
  globalThis.WebAppManager = WebAppManager;
}

// Preserve the original auto-init behaviour: initialise on DOMContentLoaded
// (or immediately if the DOM is already interactive). Errors are logged but
// never thrown — module import must not crash the host page.
if (typeof document !== 'undefined') {
  const safeInit = () => {
    try { initialize(); } catch (error) { log.error('Auto-init failed:', error); }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit, { once: true });
  } else {
    safeInit();
  }
}