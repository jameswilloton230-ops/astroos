// Cache the array allocation outside the function to eliminate garbage collection overhead on invocation
const _saltBuffer = new Uint8Array(16);

// Fully optimized PIN salt generator (removes intermediate mappings and string allocations)
function getPinSalt() {
  let salt = OS.settings.get('pinSalt');
  if (salt) return salt;

  crypto.getRandomValues(_saltBuffer);
  
  // High-performance string construction via bitwise logic instead of Array.from + mapping + padStart + join
  let hex = '';
  for (let i = 0; i < 16; i++) {
    const val = _saltBuffer[i];
    hex += (val < 16 ? '0' : '') + val.toString(16);
  }
  
  OS.settings.set('pinSalt', hex);
  return hex;
}

const OS = {
  version: '3.0.2',
  securityPatch: '2026-06-03',  // NovaByte security patch date — globally readable
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
    _handlers: Object.create(null), // Optimizes key-lookup speed by preventing prototype chain inheritance checks
    
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
      
      // Traditional fast lookup index removal (avoids generating a new array like .filter() does)
      const idx = handlers.indexOf(fn);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    },
    
    emit(event, data) {
      const handlers = this._handlers[event];
      if (handlers === undefined) return;
      
      // Standard indexed loop avoids creating ES6 implicit Iterator objects, protecting memory allocation rates
      const len = handlers.length;
      for (let i = 0; i < len; i++) {
        try { 
          handlers[i](data); 
        } catch (e) { 
          /* silent */ 
        }
      }
    }
  },

  settings: {
    _cache: {},
    
    get(key) { 
      // Direct bracket verification avoids the prototype traversal cost of the 'in' keyword
      return this._cache[key] !== undefined ? this._cache[key] : this.defaults[key]; 
    },
    
    set(key, value) {
      this._cache[key] = value;
      OS.workers.fs.call('putSetting', key, value).catch(() => { });
      OS.events.emit('settings:changed', { key, value });
    },
    
    async load() {
      try {
        const all = await OS.workers.fs.call('getAllSettings');
        this._cache = all || {};
      } catch (e) { 
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
    },
    
    applySafeModeDefaults() {
      // Safe Mode behaves like a clean default session without persisting changes.
      this._cache = {};
    }
  },

  logger: {
    debug() { },
    info() { },
    warn() { },
    error() { }
  }
};

window.OS = OS; // Expose OS globally for external scripts

/* Exposed to Global Scope for Flat-Module Architecture */
window.getPinSalt = getPinSalt;