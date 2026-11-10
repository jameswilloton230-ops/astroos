// DEFAULT APPS SERVICE — default-apps.js
//
// Lets the user pick which app opens each type of file or link (Settings ->
// Default Apps), the same idea as Windows' Settings > Apps > Default apps
// or Android's Settings > Apps > Default apps > Browser app.
//
// Two sources feed the candidate list for each category:
//
//  1. CATEGORIES (static, below) — hardcoded {id, name, icon} entries for
//     the built-in apps (Browser, TextEdit, Music, Gallery, Email,
//     Calendar). This is the reliable path: it doesn't depend on OS.apps
//     carrying any particular property at any particular moment, so the
//     built-ins always show up as long as they're installed. Add a line
//     here for any new built-in that should be selectable as a default.
//
//  2. Live discovery — for everything NOT in the static table (namely
//     third-party .novaapp packages and web apps), we still scan OS.apps
//     for a `handles: { protocols, extensions, roles }` block on the app's
//     registerApp() config, the same manifest-declaration idea Android
//     uses with <intent-filter>. A .novaapp author declares:
//
//       registerApp({
//         id: 'com.someuser.tunes', name: 'Tunes', icon: 'music',
//         handles: { protocols: [], extensions: ['.mp3', '.flac'] },
//         ...
//       });
//
//     and it becomes a selectable Music Player option automatically, no
//     edit to this file required.
//
// getAppsForCategory() merges both, static entries first, deduped by id
// (a static entry always wins if somehow duplicated, since it's what we
// trust most).
//
// @module js/core/services/default-apps

// categoryId -> { name, apps: [{id, name, icon}] }
// `apps` here is ONLY the hardcoded built-in candidates — third-party
// apps are found dynamically in getAppsForCategory(), not listed here.
//
// Frozen (deep) because this is a flat-global-script architecture — any
// installed app has direct access to window.DefaultApps. Without freezing,
// a buggy or malicious app could do DefaultApps.CATEGORIES.browser.apps.push(...)
// and permanently corrupt the picker for every app in the session, not
// just its own. Same reasoning for ROUTES below.
const CATEGORIES = Object.freeze({
  browser: Object.freeze({
    name: 'Web Browser',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.browser', name: 'Browser', icon: 'globe' }),
    ]),
  }),
  texteditor: Object.freeze({
    name: 'Text Editor',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.textedit', name: 'TextEdit', icon: 'pen-tool' }),
    ]),
  }),
  music: Object.freeze({
    name: 'Music Player',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.music', name: 'Music', icon: 'music' }),
    ]),
  }),
  gallery: Object.freeze({
    name: 'Photo Viewer',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.gallery', name: 'Gallery', icon: 'image' }),
    ]),
  }),
  email: Object.freeze({
    name: 'Email',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.email', name: 'Email', icon: 'mail' }),
    ]),
  }),
  calendar: Object.freeze({
    name: 'Calendar',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.calendar', name: 'Calendar', icon: 'calendar' }),
    ]),
  }),
  home: Object.freeze({
    name: 'Home app',
    apps: Object.freeze([
      Object.freeze({ id: 'com.nbosp.launcher', name: 'Launcher', icon: 'home' }),
    ]),
  }),
});

// Extensions/protocols/MIME types routed to each category — used by
// getCategoryFor()/resolveHandler() to decide *which* category a file or
// link belongs to, AND by the live-discovery half of getAppsForCategory()
// to check a third-party app's `handles` block for overlap. Kept separate
// from CATEGORIES.apps on purpose: which built-in apps fill a slot and
// which files or app roles fall into that slot are different questions.
const ROUTES = Object.freeze({
  browser:    Object.freeze({ protocols: Object.freeze(['http', 'https']), extensions: Object.freeze(['.html', '.htm']), mimeTypes: Object.freeze(['text/html']) }),
  texteditor: Object.freeze({ protocols: Object.freeze([]),                extensions: Object.freeze(['.txt', '.md', '.json', '.js', '.css', '.log']), mimeTypes: Object.freeze(['text/plain', 'text/markdown', 'application/json', 'text/javascript', 'application/javascript', 'text/css']) }),
  music:      Object.freeze({ protocols: Object.freeze([]),                extensions: Object.freeze(['.mp3', '.wav', '.ogg', '.flac', '.m4a']), mimeTypes: Object.freeze(['audio/*']) }),
  gallery:    Object.freeze({ protocols: Object.freeze([]),                extensions: Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']), mimeTypes: Object.freeze(['image/*']) }),
  email:      Object.freeze({ protocols: Object.freeze(['mailto']),        extensions: Object.freeze([]), mimeTypes: Object.freeze([]) }),
  calendar:   Object.freeze({ protocols: Object.freeze(['webcal']),        extensions: Object.freeze(['.ics']), mimeTypes: Object.freeze(['text/calendar', 'application/ics']) }),
  home:       Object.freeze({ protocols: Object.freeze([]),                extensions: Object.freeze([]), mimeTypes: Object.freeze([]), roles: Object.freeze(['home']) }),
});

const SETTINGS_KEY = 'defaultApps';

// Precomputed once at load instead of rebuilt on every _dynamicCandidates()
// call — the ROUTES table never changes at runtime (it's frozen above), so
// there's no reason to re-derive these Sets on every scan of OS.apps.
const ROUTE_PROTOCOL_SETS = new Map(
  Object.entries(ROUTES).map(([categoryId, route]) => [categoryId, new Set(route.protocols)])
);
const ROUTE_EXTENSION_SETS = new Map(
  Object.entries(ROUTES).map(([categoryId, route]) => [categoryId, new Set(route.extensions)]) // already lowercase in ROUTES
);
const ROUTE_MIME_SETS = new Map(
  Object.entries(ROUTES).map(([categoryId, route]) => [categoryId, new Set(route.mimeTypes)])
);
const STATIC_IDS_BY_CATEGORY = new Map(
  Object.entries(CATEGORIES).map(([categoryId, category]) => [categoryId, new Set(category.apps.map(a => a.id))])
);

// All valid app ids across every category's static candidate list — used
// to sanity-check a chosen appId is at least a real built-in id shape, not
// a typo or injected garbage. (Third-party ids are still allowed; this
// only rules out empty/non-string values, see _isPlausibleAppId below.)
function isPlausibleAppId(appId) {
  return typeof appId === 'string' && appId.length > 0 && appId.length <= 200;
}

function hasCategory(categoryId) {
  return typeof categoryId === 'string'
    && Object.prototype.hasOwnProperty.call(CATEGORIES, categoryId);
}

function normalizeProtocol(protocol) {
  if (typeof protocol !== 'string') return null;
  const normalized = protocol.trim().toLowerCase().replace(/:$/, '');
  return /^[a-z][a-z0-9+.-]*$/.test(normalized) ? normalized : null;
}

function normalizeExtension(extension) {
  if (typeof extension !== 'string') return null;
  const normalized = extension.trim().toLowerCase();
  return /^\.[a-z0-9][a-z0-9._+-]*$/.test(normalized) ? normalized : null;
}

function normalizeMimeType(mimeType) {
  if (typeof mimeType !== 'string') return null;
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(normalized) ? normalized : null;
}

function mimeTypeMatches(routeType, mimeType) {
  return routeType.endsWith('/*')
    ? mimeType.startsWith(routeType.slice(0, -1))
    : routeType === mimeType;
}

function mimeTypesOverlap(routeType, appType) {
  return mimeTypeMatches(routeType, appType) || mimeTypeMatches(appType, routeType);
}

function queryMatchesTypes(query, extensions, mimeTypes) {
  const extension = normalizeExtension(query?.extension);
  const mimeType = normalizeMimeType(query?.mimeType);
  return (!!extension && extensions.some(value => normalizeExtension(value) === extension))
    || (!!mimeType && mimeTypes.some(value => {
      const appMimeType = normalizeMimeType(value);
      return appMimeType && mimeTypeMatches(appMimeType, mimeType);
    }));
}

const DefaultApps = {

  CATEGORIES,
  ROUTES,

  // ── Candidate apps ────────────────────────────────────────────────────

  /**
   * Static built-in candidates for a category, filtered to only those
   * currently installed (checked against OS.apps so an uninstalled
   * built-in doesn't show up as a choice). If OS.apps isn't available yet,
   * returns the full static list rather than an empty one — better to
   * over-show briefly during early boot than to flash "no app available".
   * @param {string} categoryId
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  _staticCandidates(categoryId) {
    if (!hasCategory(categoryId)) return [];
    const category = CATEGORIES[categoryId];
    const hasOSApps = typeof OS !== 'undefined' && OS.apps && typeof OS.apps === 'object';
    // .slice() here (and below) so callers get a fresh, mutable array —
    // the source arrays are frozen, so handing one out directly would let
    // a caller's .push()/.sort() throw or silently no-op depending on
    // strict mode, instead of just working like a normal array.
    if (!hasOSApps) return category.apps.slice();
    return category.apps.filter(a => !!OS.apps[a.id]);
  },

  /**
   * Dynamic candidates for a category: any currently-registered app whose
   * `handles` block overlaps the category's protocols/extensions/MIME types, skipping
   * ids already covered by the static table above (built-ins are only ever
   * sourced from CATEGORIES, never from this scan, even if their
   * registerApp() config also happens to carry a `handles` block).
   * @param {string} categoryId
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  _dynamicCandidates(categoryId) {
    if (typeof OS === 'undefined' || !OS.apps) return [];
    const protoSet = ROUTE_PROTOCOL_SETS.get(categoryId);
    const extSet = ROUTE_EXTENSION_SETS.get(categoryId);
    const mimeSet = ROUTE_MIME_SETS.get(categoryId);
    const roleSet = new Set(ROUTES[categoryId]?.roles || []);
    if (!protoSet || !extSet || !mimeSet) return [];

    const staticIds = STATIC_IDS_BY_CATEGORY.get(categoryId) || new Set();

    const matches = [];
    for (const [id, config] of Object.entries(OS.apps)) {
      if (staticIds.has(id)) continue; // built-ins come from CATEGORIES, not here
      const handles = config && config.handles;
      if (!handles) continue;
      const appProtos = Array.isArray(handles.protocols) ? handles.protocols : [];
      const appExts = Array.isArray(handles.extensions) ? handles.extensions : [];
      const appMimeTypes = Array.isArray(handles.mimeTypes) ? handles.mimeTypes : [];
      const appRoles = Array.isArray(handles.roles) ? handles.roles : [];
      const overlaps = appRoles.some(role => typeof role === 'string' && roleSet.has(role.trim().toLowerCase()))
        || appProtos.some(p => protoSet.has(normalizeProtocol(p)))
        || appExts.some(e => extSet.has(normalizeExtension(e)))
        || appMimeTypes.some(m => {
          const appMimeType = normalizeMimeType(m);
          return appMimeType && [...mimeSet].some(routeMimeType => mimeTypesOverlap(routeMimeType, appMimeType));
        });
      if (overlaps && isPlausibleAppId(id)) {
        matches.push({ id, name: typeof config.name === 'string' && config.name.trim() ? config.name : id, icon: config.icon || null });
      }
    }
    return matches;
  },

  /**
   * Full candidate list for a category: static built-ins first, then any
   * third-party/.novaapp apps discovered via their `handles` declaration,
   * deduped by id (static wins on a collision).
   * @param {string} categoryId - a key of DefaultApps.CATEGORIES
   * @returns {Array<{id: string, name: string, icon: string}>}
   */
  getAppsForCategory(categoryId) {
    const staticList = this._staticCandidates(categoryId);
    const dynamicList = this._dynamicCandidates(categoryId);
    const seen = new Set(staticList.map(a => a.id));
    const merged = staticList.slice();
    for (const app of dynamicList) {
      if (seen.has(app.id)) continue;
      seen.add(app.id);
      merged.push(app);
    }
    return merged;
  },

  /**
   * Installed apps that declare support for this file type, including
   * built-in handlers represented by the category routes.
   * @param {{extension?: string, mimeType?: string}} query
   * @returns {Array<{id: string, name: string, icon: string|null}>}
   */
  getAppsForFile(query = {}) {
    if (!query || typeof query !== 'object' || typeof OS === 'undefined' || !OS.apps) return [];
    const extension = normalizeExtension(query.extension);
    const mimeType = normalizeMimeType(query.mimeType);
    if (!extension && !mimeType) return [];

    const matches = [];
    const seen = new Set();
    for (const [categoryId, route] of Object.entries(ROUTES)) {
      const routeMatches = (!!extension && route.extensions.includes(extension))
        || (!!mimeType && route.mimeTypes.some(routeType => mimeTypeMatches(routeType, mimeType)));
      if (!routeMatches) continue;
      for (const candidate of this._staticCandidates(categoryId)) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        matches.push(candidate);
      }
    }

    for (const [id, config] of Object.entries(OS.apps)) {
      if (seen.has(id) || !isPlausibleAppId(id)) continue;
      const handles = config?.handles;
      if (!handles || !queryMatchesTypes(
        query,
        Array.isArray(handles.extensions) ? handles.extensions : [],
        Array.isArray(handles.mimeTypes) ? handles.mimeTypes : []
      )) continue;
      seen.add(id);
      matches.push({
        id,
        name: typeof config.name === 'string' && config.name.trim() ? config.name : id,
        icon: config.icon || null,
      });
    }
    return matches;
  },

  supportsFile(appId, query = {}) {
    return this.getAppsForFile(query).some(app => app.id === appId);
  },

  /**
   * Which category (if any) a file extension, protocol, or MIME type belongs to.
   * @param {{extension?: string, protocol?: string, mimeType?: string}} query
   * @returns {string|null}
   */
  getCategoryFor(query = {}) {
    if (!query || typeof query !== 'object') return null;
    const ext = normalizeExtension(query.extension);
    const protocol = normalizeProtocol(query.protocol);
    const mimeType = normalizeMimeType(query.mimeType);
    for (const [categoryId, route] of Object.entries(ROUTES)) {
      if ((protocol && route.protocols.includes(protocol))
        || (ext && route.extensions.includes(ext))
        || (mimeType && route.mimeTypes.some(routeMimeType => mimeTypeMatches(routeMimeType, mimeType)))) return categoryId;
    }
    return null;
  },

  // ── User preference ───────────────────────────────────────────────────

  /**
   * @returns {Object<string,string>} categoryId -> appId map, as persisted.
   */
  _getMap() {
    if (typeof OS === 'undefined' || !OS.settings) return {};
    let stored;
    try {
      stored = OS.settings.get(SETTINGS_KEY);
    } catch (err) {
      console.error('DefaultApps: OS.settings.get threw, falling back to empty map', err);
      return {};
    }
    // Guard against a corrupted/legacy value (e.g. an array, a string, or
    // null stored under this key by an old buggy version). Without this,
    // setDefault() below would write categoryId/appId onto whatever that
    // value is — which "works" on an array by accident and throws on a
    // primitive — instead of cleanly recovering to a fresh object.
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    return stored;
  },

  /**
   * The user's chosen default app id for a category, or null if they've
   * never set one (caller should fall back to a hardcoded default in that
   * case — see resolveHandler()).
   * @param {string} categoryId
   * @returns {string|null}
   */
  getDefault(categoryId) {
    if (!hasCategory(categoryId)) return null;
    const chosen = this._getMap()[categoryId];
    if (!isPlausibleAppId(chosen)) return null;
    return this.getAppsForCategory(categoryId).some(app => app.id === chosen) ? chosen : null;
  },

  getDefaultForFile(query = {}) {
    const map = this._getMap();
    const candidates = this.getAppsForFile(query);
    const extension = normalizeExtension(query?.extension);
    const mimeType = normalizeMimeType(query?.mimeType);
    const keys = [
      extension ? `extension:${extension}` : null,
      mimeType ? `mime:${mimeType}` : null,
    ].filter(Boolean);
    for (const key of keys) {
      const chosen = map[key];
      if (isPlausibleAppId(chosen) && candidates.some(app => app.id === chosen)) return chosen;
    }
    return null;
  },

  setDefaultForFile(query, appId) {
    if (typeof OS === 'undefined' || !OS.settings || !query || typeof query !== 'object') return false;
    const extension = normalizeExtension(query.extension);
    const mimeType = normalizeMimeType(query.mimeType);
    const key = extension ? `extension:${extension}` : mimeType ? `mime:${mimeType}` : null;
    if (!key) return false;
    if (appId !== null && (!isPlausibleAppId(appId) || !this.supportsFile(appId, query))) {
      console.warn(`DefaultApps.setDefaultForFile: app "${appId}" does not support this file type`);
      return false;
    }
    const map = { ...this._getMap() };
    if (appId === null) delete map[key];
    else map[key] = appId;
    if (OS.settings.set(SETTINGS_KEY, map) === false) return false;
    return true;
  },

  _supportsQuery(categoryId, appId, query) {
    const staticIds = STATIC_IDS_BY_CATEGORY.get(categoryId);
    if (staticIds?.has(appId)) return true;
    const app = typeof OS !== 'undefined' ? OS.apps?.[appId] : null;
    const handles = app?.handles;
    if (!handles || typeof handles !== 'object') return false;

    const protocols = Array.isArray(handles.protocols) ? handles.protocols : [];
    const extensions = Array.isArray(handles.extensions) ? handles.extensions : [];
    const mimeTypes = Array.isArray(handles.mimeTypes) ? handles.mimeTypes : [];
    if (typeof query?.protocol === 'string' && query.protocol.trim()) {
      const protocol = normalizeProtocol(query.protocol);
      return !!protocol && protocols.some(value => normalizeProtocol(value) === protocol);
    }

    const extension = normalizeExtension(query?.extension);
    const mimeType = normalizeMimeType(query?.mimeType);
    return !!extension && extensions.some(value => normalizeExtension(value) === extension)
      || !!mimeType && mimeTypes.some(value => {
        const appMimeType = normalizeMimeType(value);
        return appMimeType && mimeTypeMatches(appMimeType, mimeType);
      });
  },

  /**
   * Persist the user's choice. Emits the normal 'settings:changed' event
   * (via OS.settings.set) so anything caching a resolved handler — none of
   * the built-in apps do today, but a future one might — can invalidate.
   *
   * Validates categoryId/appId against current candidates. Passing null
   * clears the explicit choice and restores the system fallback.
   * @param {string} categoryId
   * @param {string|null} appId
   * @returns {boolean} true if the write happened
   */
  setDefault(categoryId, appId) {
    if (typeof OS === 'undefined' || !OS.settings) return false;
    if (!hasCategory(categoryId)) {
      console.warn(`DefaultApps.setDefault: unknown category "${categoryId}"`);
      return false;
    }
    if (appId !== null && !isPlausibleAppId(appId)) {
      console.warn(`DefaultApps.setDefault: invalid appId for category "${categoryId}"`);
      return false;
    }
    if (appId !== null && !this.getAppsForCategory(categoryId).some(app => app.id === appId)) {
      console.warn(`DefaultApps.setDefault: app "${appId}" does not support category "${categoryId}"`);
      return false;
    }
    const map = { ...this._getMap() };
    if (appId === null) delete map[categoryId];
    else map[categoryId] = appId;
    if (OS.settings.set(SETTINGS_KEY, map) === false) return false;
    return true;
  },

  clearDefaultsForApp(appId) {
    if (typeof OS === 'undefined' || !OS.settings || !isPlausibleAppId(appId)) return false;
    const map = { ...this._getMap() };
    let changed = false;
    for (const [key, value] of Object.entries(map)) {
      if (value === appId) {
        delete map[key];
        changed = true;
      }
    }
    if (!changed) return true;
    return OS.settings.set(SETTINGS_KEY, map) !== false;
  },

  /**
   * Resolve which app should open a given file/link, honoring the user's
   * choice first and falling back to `fallbackAppId` (the pre-existing
   * hardcoded behavior) if they never picked one, or picked an app that's
   * since been uninstalled.
   * @param {{extension?: string, protocol?: string, mimeType?: string}} query
   * @param {string} fallbackAppId
   * @returns {string} an app id
   */
  resolveHandler(query, fallbackAppId) {
    const fileDefault = this.getDefaultForFile(query);
    if (fileDefault) return fileDefault;
    const categoryId = this.getCategoryFor(query);
    if (!categoryId) return fallbackAppId;

    const chosen = this.getDefault(categoryId);
    return chosen && this._supportsQuery(categoryId, chosen, query) ? chosen : fallbackAppId;
  },
};

window.DefaultApps = DefaultApps;