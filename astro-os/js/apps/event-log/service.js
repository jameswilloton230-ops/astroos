// EVENT LOG SERVICE — event-log.js
//
// Central, structured event/log store for the OS. Every other subsystem
// (permission manager, package installer, console output from any app)
// funnels here so the Events devtool app can show one filterable timeline
// instead of a dev having to open Console + Inspector + Permissions
// separately and reconstruct the sequence by hand.
//
// Two ways entries get in:
//  1. Passive capture — console.log/warn/error are wrapped. Any code in the
//     OS (including third-party/web apps) that logs normally is captured
//     for free, no call-site changes required. Severity is inferred from
//     which console method was used; the source app is inferred from a
//     leading "[Something]" tag when present (existing convention across
//     the codebase — see AppPermissionManager, AppPackage, etc.), else
//     attributed to 'system'.
//  2. Explicit structured entries — EventLog.log({...}) for call sites that
//     already have real appId/permission/etc. data worth keeping intact
//     instead of re-parsing it back out of a string later.
//
// Ring-buffered in memory (no unbounded growth on a long dev session) and
// persisted to localStorage the same way Notify does, so history survives
// a reload.

const EventLog = {
  _storageKey: 'novaOS_eventlog',
  _loaded: false,
  _maxEntries: 500,
  _entries: [],
  _subscribers: new Set(),
  _consolePatched: false,

  // Matches a leading "[Something]" tag, e.g. "[AppPermissionManager] Denied ..."
  _TAG_RE: /^\[([^\]]+)\]\s*/,

  loadPersisted() {
    if (EventLog._loaded) return;
    EventLog._loaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem(EventLog._storageKey) || '[]');
      if (Array.isArray(saved)) EventLog._entries = saved.slice(0, EventLog._maxEntries);
    } catch (e) {
      EventLog._entries = [];
    }
  },

  persist() {
    try {
      localStorage.setItem(EventLog._storageKey, JSON.stringify(EventLog._entries.slice(0, EventLog._maxEntries)));
    } catch (e) {
      // Storage can be full or unavailable (sandboxed context) — the in-memory
      // ring buffer still works for this session, just won't survive reload.
    }
  },

  // Known categories, in the order they should appear in filter UIs. 'category'
  // is a coarse subsystem grouping (distinct from 'app', which is the specific
  // module/appId string) so the Events app can offer a small, stable filter
  // list instead of one entry per app name.
  _CATEGORIES: ['window', 'filesystem', 'security', 'permissions', 'packages', 'network', 'apps', 'server', 'system'],

  // Structured entry point. Call sites with real data (appId, permission,
  // etc.) should use this directly rather than relying on console parsing.
  //   EventLog.log({ app: 'AppPermissionManager', severity: 'info',
  //                  category: 'permissions',
  //                  message: 'Denied fs:write → com.example.app',
  //                  data: { appId, permission } })
  log(opts) {
    EventLog.loadPersisted();
    const entry = {
      id: (typeof generateId === 'function') ? generateId() : String(Date.now()) + Math.random().toString(36).slice(2),
      timestamp: Date.now(),
      app: opts.app || 'system',
      category: opts.category || 'system', // coarse grouping, see _CATEGORIES
      severity: opts.severity || 'info', // 'info' | 'warn' | 'error'
      message: opts.message || '',
      data: opts.data || null,
    };
    EventLog._entries.unshift(entry);
    if (EventLog._entries.length > EventLog._maxEntries) EventLog._entries.length = EventLog._maxEntries;
    EventLog.persist();
    for (const fn of EventLog._subscribers) {
      try { fn(entry); } catch (e) { /* one bad subscriber shouldn't break the rest */ }
    }
    return entry;
  },

  // Entry point for events arriving from outside the browser runtime (the
  // Node-side server process — security routes, email, proxies). These can't
  // call EventLog.log() directly since they don't share this window, so the
  // SSE bridge client (see server-events-bridge.js) forwards them here.
  // Always tagged category:'server' regardless of what the sender passed,
  // so the origin is visually unambiguous in the Events app even if a
  // future sender gets the category wrong.
  ingestRemote(opts) {
    return EventLog.log({ ...opts, category: 'server' });
  },

  getCategories() {
    return EventLog._CATEGORIES.slice();
  },

  getAll() {
    EventLog.loadPersisted();
    return EventLog._entries.slice();
  },

  clear() {
    EventLog._entries = [];
    EventLog.persist();
  },

  // Live-update hook for the Events app. Returns an unsubscribe function.
  subscribe(fn) {
    EventLog._subscribers.add(fn);
    return () => EventLog._subscribers.delete(fn);
  },

  // Wraps console.log/warn/error once, globally, so every existing
  // console call across the codebase (and any app running in-OS) is
  // captured passively. Idempotent — safe to call more than once.
  patchConsole() {
    if (EventLog._consolePatched) return;
    EventLog._consolePatched = true;

    const methods = [['log', 'info'], ['warn', 'warn'], ['error', 'error']];
    for (const [method, severity] of methods) {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        try {
          const first = args[0];
          let app = 'system';
          let rest = args;
          if (typeof first === 'string') {
            const m = first.match(EventLog._TAG_RE);
            if (m) {
              app = m[1];
              rest = [first.slice(m[0].length), ...args.slice(1)];
            } else {
              rest = args;
            }
          }
          const message = rest.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
          }).join(' ').trim();
          if (!message) return;
          EventLog.log({ app, severity, message });
        } catch (e) {
          // Never let log capture itself throw and break the original call.
        }
      };
    }
  },
};

EventLog.patchConsole();

// ── EXPOSE TO GLOBAL RUNTIME SCOPE ───────────────────────────────────────────
if (typeof EventLog !== 'undefined') {
  window.EventLog = EventLog;
} else {
  console.warn('EventLog object was not found in the local scope of event-log.js');
}