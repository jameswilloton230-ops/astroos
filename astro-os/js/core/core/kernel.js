// Generates (and caches on disk via settings) a random salt used for PIN hashing elsewhere.
// This only produces the salt — the actual hash + compare has to live wherever lockPin
// is checked, since this file never touches lockPin directly.
function getPinSalt() {
  const cached = OS.settings.get('pinSalt');
  if (cached) return cached;

  // 16 bytes, runs once until a salt is cached — no need to hoist this buffer to
  // module scope, the perf win doesn't exist at this call frequency and the shared
  // buffer just becomes something to reason about for no benefit.
  const saltBuffer = new Uint8Array(16);
  crypto.getRandomValues(saltBuffer);
  const hex = saltBuffer.toHex();

  OS.settings.set('pinSalt', hex);
  return hex;
}

function isLinuxRuntime() {
  return typeof process !== 'undefined' && process.platform === 'linux';
}

function nativeSettingsPath() {
  return require('path').join(require('os').homedir(), '.config', 'novabyte', 'settings.json');
}

function writeNativeSettings(settings) {
  const fs = require('fs');
  const path = nativeSettingsPath();
  fs.mkdirSync(require('path').dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, path);
}

const OS = {
  version: '3.0.2',
  securityPatch: '2026-11-12',  // AstroOS security patch date — globally readable
  username: 'user',
  workers: {},
  windows: new Map(),
  windowZCounter: 100,
  focusedWindowId: null,
  apps: {},
  clipboard: null,
  notifications: [],
  notifUnread: 0,
  dnd: false,
  volume: 80,
  idleTimer: null,
  idleTimeout: 600000,
  isLocked: false,
  lockPin: null,
  wrongPinCount: 0,
  lockoutUntil: 0,

  // Virtual desktops
  workspaces: [{ id: 1, name: 'Workspace 1', windows: [] }],
  currentWorkspace: 1,
  maxWorkspaces: 6,

  // Clipboard manager
  clipboardHistory: [],
  maxClipboardItems: 30,

  events: {
    _handlers: Object.create(null), // no prototype chain to walk on lookup

    on(event, fn) {
      const handlers = this._handlers[event];
      if (handlers === undefined) {
        this._handlers[event] = [fn];
      } else {
        handlers.push(fn);
      }
    },

    off(event, fn) {
      const handlers = this._handlers[event];
      if (handlers === undefined) return;

      const idx = handlers.indexOf(fn);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    },

    emit(event, data) {
      const handlers = this._handlers[event];
      if (handlers === undefined) return;

      // Snapshot before iterating. If a handler calls off() on itself (or on a
      // later handler) mid-emit, splicing the live array would shift indices
      // and skip whoever was next in line.
      const snapshot = handlers.slice();
      for (let i = 0; i < snapshot.length; i++) {
        try {
          snapshot[i](data);
        } catch (err) {
          // Previously swallowed entirely — a throwing handler left zero trace
          // anywhere. Route it through the logger so it's at least visible.
          OS.logger.error(`Unhandled error in "${event}" listener`, err);
        }
      }
    }
  },

  settings: {
    _cache: {},

    get(key) {
      const val = this._cache[key] !== undefined ? this._cache[key] : this.defaults[key];
      // Return a deep clone, never the live cached reference. Callers (e.g. desktop
      // icon drag/swap) mutate the returned object in place and then pass that same
      // object to set(). Since set() just assigns this._cache[key] = value, handing
      // back a live reference makes that assignment a no-op — the mutation already
      // happened directly on the cache before set() (and its persist call +
      // settings:changed event) ever ran, causing one write of a two-step swap to
      // be lost/raced. Cloning here guarantees every get() is a fresh,
      // independently mutable snapshot, so set() always assigns a genuinely new
      // object.
      if (val !== null && typeof val === 'object') {
        try {
          return structuredClone(val);
        } catch {
          // structuredClone throws on non-cloneable values (functions, etc).
          // Shouldn't happen for a settings cache that's meant to hold plain
          // JSON-shaped data, but this keeps a corrupted entry from taking
          // down every settings read.
          return JSON.parse(JSON.stringify(val));
        }
      }
      return val;
    },

    set(key, value) {
      if ((key === 'wallpaperId' || key === 'customWallpaper' || key === 'customWallpaperName')
        && this.get('prohibitWallpaperChange') === true) {
        return false;
      }
      this._cache[key] = value;
      if (isLinuxRuntime()) {
        try {
          writeNativeSettings(this._cache);
        } catch (err) {
          OS.logger.error(`Failed to persist setting "${key}" to the Linux filesystem`, err);
        }
      } else {
        OS.workers.fs.call('putSetting', key, value).catch((err) => {
          OS.logger.error(`Failed to persist setting "${key}"`, err);
        });
      }
      OS.events.emit('settings:changed', { key, value });
    },

    async load() {
      if (isLinuxRuntime()) {
        const fs = require('fs');
        const path = nativeSettingsPath();
        try {
          this._cache = JSON.parse(fs.readFileSync(path, 'utf8'));
          if (!this._cache || typeof this._cache !== 'object' || Array.isArray(this._cache)) {
            throw new Error('Settings file must contain a JSON object');
          }
          return;
        } catch (error) {
          if (error.code !== 'ENOENT') {
            OS.logger.error('Failed to read Linux settings file', error);
            throw error;
          }
        }
        try {
          this._cache = OS.workers.fs
            ? await OS.workers.fs.call('getAllSettings')
            : {};
          writeNativeSettings(this._cache || {});
          this._cache = this._cache || {};
        } catch (err) {
          OS.logger.error('Failed to migrate legacy settings to the Linux filesystem', err);
          this._cache = {};
        }
        return;
      }
      try {
        const all = await OS.workers.fs.call('getAllSettings');
        this._cache = all || {};
      } catch (err) {
        OS.logger.error('Failed to load settings, falling back to defaults', err);
        this._cache = {};
      }
    },

    defaults: {
      theme: 'nova-dark',
      clockFormat: '12h',
      dateFormat: 'MM/DD/YYYY',
      fontSize: '14',
      accentColor: '#58a6ff',
      taskbarStyle: 'windows',
      wallpaper: 'stock-blue',
      windowRadius: '12',
      animSpeed: '1',
      iconSize: '72',
      autoLock: '10',
      searchEngine: 'brave',
      proxyUrl: '',
      username: 'user',
      pinnedApps: [],
      region: 'en-US',
      keyboardLayout: 'us',
      timezone: (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC',
    },

    applySafeModeDefaults() {
      // Safe Mode behaves like a clean default session without persisting changes.
      this._cache = {};
    }
  },

  logger: {
    // Were no-op stubs before, which meant errors (including the ones now
    // surfaced from events.emit and settings.set above) had nowhere to go.
    // Wiring these to console is the minimum bar for "observable when it
    // fails in production" — swap for a real telemetry sink later if needed.
    debug(...args) { console.debug('[OS]', ...args); },
    info(...args) { console.info('[OS]', ...args); },
    warn(...args) { console.warn('[OS]', ...args); },
    error(...args) { console.error('[OS]', ...args); }
  }
};

window.OS = OS; // Expose OS globally for external scripts

/* Exposed to Global Scope for Flat-Module Architecture */
window.getPinSalt = getPinSalt;