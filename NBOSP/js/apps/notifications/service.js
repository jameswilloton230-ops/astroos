// Known, safe values for notif.icon / opts.icon. svgIcon() is an external
// global we don't control, so we validate the key here at the boundary
// before it ever reaches innerHTML, rather than trusting whatever string an
// app passed into show().
const KNOWN_ICONS = new Set(['bell', 'zap', 'x', 'info', 'error', 'warning', 'success']);

function safeIconKey(icon) {
  return KNOWN_ICONS.has(icon) ? icon : 'bell';
}

// ── Notification channels (v2) ───────────────────────────────────────────
// Android-style channels: an app declares named categories ("Messages",
// "Promos"), each with an importance the user can override. Importance is
// locked once created (Android parity) — a later ensureChannel() with a
// different importance is a no-op; only the user can change it, via
// channelOverrides. All three stores survive shell reloads: channels and
// overrides live in the registry (HKNU/shell/notifications/*), and queued
// notification actions ride the same hive area so they survive a reload
// too (the app drains them via nova:notifications:consumeActions on its
// next launch).
const CHANNEL_IMPORTANCES = new Set(['none', 'low', 'default', 'high']);
// How long a toast stays up per importance level. 'low' = 0 → panel-only,
// silent (Android low = no sound/snap); 'high' = 8s, the closest thing to
// heads-up this shell has.
const IMPORTANCE_DWELL_MS = { low: 0, default: 4000, high: 8000 };
const MAX_CHANNELS_PER_APP = 32;
const MAX_ACTIONS_PER_NOTIF = 3;
const MAX_PENDING_ACTIONS_PER_APP = 20;
// Shared bound for channel ids and tags — both are app-supplied keys that
// end up inside storage keys and IPC payloads.
const MAX_NOTIF_KEY_LEN = 64;

const CHANNELS_STORAGE_KEY = 'novaOS_notifChannels';
const CHANNEL_OVERRIDES_STORAGE_KEY = 'novaOS_notifChannelOverrides';
const PENDING_ACTIONS_STORAGE_KEY = 'novaOS_notifPendingActions';

function loadJsonStore(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function persistJsonStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Best-effort persistence — private-browsing mode or a full quota
    // degrades to in-memory-only state, same as Notify.persist() below.
  }
}

// Channel/action ids are app-supplied and end up in storage keys and IPC
// round-trips, so they get the same slug treatment the sandbox applies.
function slugOk(value, maxLen) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLen
    && /^[a-zA-Z0-9_-]+$/.test(value);
}

let channelDefs = null;
let channelOverrides = null;
// The pending-action queue rides RegistryPrefs (HKNU/shell/notifications/
// pendingActions — same home as channels + overrides); the legacy
// localStorage key is the adoption source and the fail-soft fallback, so a
// pre-registry install keeps its queued taps. The in-memory array hydrates
// lazily: this service can evaluate before the registry boots.
const pendingActionQueue = [];
let pendingQueueHydrated = false;

function ensurePendingQueueHydrated() {
  if (pendingQueueHydrated) return;
  pendingQueueHydrated = true;
  let stored = null;
  if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.notifPendingActions) {
    try { stored = RegistryPrefs.notifPendingActions(); } catch (_) { stored = null; }
  }
  if (stored === null) stored = loadJsonStore(PENDING_ACTIONS_STORAGE_KEY, []);
  if (Array.isArray(stored)) pendingActionQueue.push(...stored);
}

function persistPendingQueue() {
  if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setNotifPendingActions) {
    try { if (RegistryPrefs.setNotifPendingActions(pendingActionQueue)) return; } catch (_) { /* legacy below */ }
  }
  persistJsonStore(PENDING_ACTIONS_STORAGE_KEY, pendingActionQueue);
}

// Channels and overrides live in the registry through RegistryPrefs — but
// this service may evaluate before the registry boots, so the stores
// hydrate lazily on first use (the localStorage fallback keeps pre-registry
// values visible; RegistryPrefs adopts them into the hive on first access).
function ensureNotifStores() {
  if (channelDefs !== null && channelOverrides !== null) return;
  if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.notifChannels) {
    try {
      channelDefs = RegistryPrefs.notifChannels();
      channelOverrides = RegistryPrefs.notifChannelOverrides();
      return;
    } catch (_) { /* fall through to localStorage */ }
  }
  channelDefs = loadJsonStore(CHANNELS_STORAGE_KEY, {});
  channelOverrides = loadJsonStore(CHANNEL_OVERRIDES_STORAGE_KEY, {});
}

function persistChannels() {
  if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setNotifChannels) {
    try { RegistryPrefs.setNotifChannels(channelDefs); return; } catch (_) { /* legacy below */ }
  }
  persistJsonStore(CHANNELS_STORAGE_KEY, channelDefs);
}

function persistChannelOverrides() {
  if (typeof RegistryPrefs !== 'undefined' && RegistryPrefs.setNotifChannelOverrides) {
    try { RegistryPrefs.setNotifChannelOverrides(channelOverrides); return; } catch (_) { /* legacy below */ }
  }
  persistJsonStore(CHANNEL_OVERRIDES_STORAGE_KEY, channelOverrides);
}

// Register (or update) a channel. Returns { created, channel } or null when
// the definition is invalid or the per-app cap is hit.
function ensureChannelForApp(appId, def, { declaredBy = 'runtime' } = {}) {
  ensureNotifStores();
  if (!appId || !def || !slugOk(def.id, MAX_NOTIF_KEY_LEN)) return null;
  const name = typeof def.name === 'string' && def.name.trim()
    ? def.name.trim().slice(0, 60)
    : null;
  if (!name) return null;
  const description = typeof def.description === 'string' ? def.description.slice(0, 200) : '';
  // 'none' at creation would be a channel that drops everything; the only
  // path to 'none' is the user muting the channel, so map it to 'default'.
  const importance = def.importance !== 'none' && CHANNEL_IMPORTANCES.has(def.importance)
    ? def.importance
    : 'default';
  if (!channelDefs[appId]) channelDefs[appId] = {};
  const existing = channelDefs[appId][def.id];
  if (existing) {
    // Android parity: name/description stay updatable, importance is locked.
    existing.name = name;
    existing.description = description;
    persistChannels();
    return { created: false, channel: existing };
  }
  if (Object.keys(channelDefs[appId]).length >= MAX_CHANNELS_PER_APP) return null;
  const channel = { id: def.id, name, description, importance, declaredBy, createdAt: Date.now() };
  channelDefs[appId][def.id] = channel;
  persistChannels();
  return { created: true, channel };
}

// Seed channels declared statically in the app manifest under
// notifications.channels: [{ id, name, importance, description }]. Runs on
// every post/createChannel — ensureChannelForApp is idempotent and cheap.
function ensureDeclaredChannels(appId, manifest) {
  const declared = manifest?.notifications?.channels;
  if (!Array.isArray(declared)) return;
  for (const def of declared.slice(0, MAX_CHANNELS_PER_APP)) {
    if (def && typeof def === 'object') {
      ensureChannelForApp(appId, def, { declaredBy: 'manifest' });
    }
  }
}

// Resolve a channel with the user's override applied. Returns null for
// unknown channels; blocked:true when the user muted it (importance 'none'
// or enabled:false) and the notification should be silently dropped.
function getChannelForApp(appId, channelId) {
  ensureNotifStores();
  if (!appId || !slugOk(channelId, MAX_NOTIF_KEY_LEN)) return null;
  const def = channelDefs[appId]?.[channelId];
  if (!def) return null;
  const override = channelOverrides[`${appId}|${channelId}`] || null;
  const enabled = override ? override.enabled !== false : true;
  const importance = override && CHANNEL_IMPORTANCES.has(override.importance)
    ? override.importance
    : (CHANNEL_IMPORTANCES.has(def.importance) ? def.importance : 'default');
  return {
    ...def,
    declaredImportance: def.importance,
    enabled,
    importance,
    blocked: !enabled || importance === 'none',
  };
}

// Queue an action click for the app to consume. Android delivers action
// taps to a live component; here the host opens the app window and the app
// pulls the queued action on launch/resume — the same observable behavior
// without requiring a live sandbox at click time.
function queueActionForApp(notif, actionDef) {
  if (!notif || !notif.appId || !actionDef || !slugOk(actionDef.id, 40)) return;
  ensurePendingQueueHydrated();
  const entry = {
    appId: notif.appId,
    notifId: notif.id,
    tag: notif.tag || null,
    actionId: actionDef.id,
    label: actionDef.label || '',
    title: notif.title || '',
    clickedAt: Date.now(),
  };
  const others = pendingActionQueue.filter(pa => pa.appId !== notif.appId);
  const mine = pendingActionQueue.filter(pa => pa.appId === notif.appId);
  mine.push(entry);
  while (mine.length > MAX_PENDING_ACTIONS_PER_APP) mine.shift();
  pendingActionQueue.length = 0;
  pendingActionQueue.push(...others, ...mine);
  persistPendingQueue();
}

function consumeActionsForApp(appId) {
  if (!appId) return [];
  ensurePendingQueueHydrated();
  const mine = pendingActionQueue.filter(pa => pa && pa.appId === appId);
  if (!mine.length) return [];
  for (const pa of mine) {
    const i = pendingActionQueue.indexOf(pa);
    if (i > -1) pendingActionQueue.splice(i, 1);
  }
  persistPendingQueue();
  return mine;
}

// Uninstall cleanup: an app's channels, overrides, and queued actions die
// with it (Android removes channels on uninstall too).
function dropNotificationAppState(appId) {
  if (!appId) return;
  ensureNotifStores();
  ensurePendingQueueHydrated();
  let changed = false;
  if (channelDefs[appId]) { delete channelDefs[appId]; changed = true; }
  for (const key of Object.keys(channelOverrides)) {
    if (key.startsWith(`${appId}|`)) { delete channelOverrides[key]; changed = true; }
  }
  const kept = pendingActionQueue.filter(pa => pa.appId !== appId);
  if (kept.length !== pendingActionQueue.length) {
    pendingActionQueue.length = 0;
    pendingActionQueue.push(...kept);
    changed = true;
  }
  if (changed) {
    persistChannels();
    persistChannelOverrides();
    persistPendingQueue();
  }
}

// Tap-through: clicking a notification (row body or toast body) opens the
// app that posted it — the single most basic notification behavior on
// Android, and the one thing the old toast/panel couldn't do at all.
function openNotificationApp(notif) {
  if (!notif || !notif.appId) return;
  try {
    if (typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
      WM.createWindow(notif.appId);
    }
  } catch (e) {
    // WM may be unavailable in headless contexts; a queued action (if any)
    // still reaches the app whenever it next runs.
  }
}

// Dispatch a clicked action button. Legacy actions (the old allowlist
// strings) keep their open-Settings/open-Store routing; app-declared v2
// actions open the app and queue {actionId} for the app to consume.
function handleNotificationActionClick(notif, actionDef) {
  if (actionDef && actionDef.legacy) {
    Notify.runAction(notif);
    return;
  }
  openNotificationApp(notif);
  queueActionForApp(notif, actionDef);
}

// Shared inline styles for the two "action" buttons (toast + panel row).
// Was duplicated as two near-identical cssText strings before.
const ACTION_BUTTON_STYLE = 'padding:6px 14px;font-size:12px;font-weight:600;border-radius:6px;background:rgba(88,166,255,0.2);color:#58a6ff;border:1px solid rgba(88,166,255,0.4);cursor:pointer;transition:all 0.15s;';

function wireActionButtonHover(btn) {
  btn.addEventListener('pointerenter', () => { btn.style.background = 'rgba(88,166,255,0.35)'; });
  btn.addEventListener('pointerleave', () => { btn.style.background = 'rgba(88,166,255,0.2)'; });
}

// Epoch-ms timestamp -> short "time ago" / "running for" string. Kept as a
// standalone function (rather than inline in renderPanel) so the date math
// lives in one place instead of being duplicated inline.
//
// This stays on Date.now() rather than Temporal: Temporal is ES2026 and
// needs either a native runtime that ships it or the @js-temporal/polyfill
// package, and this file has neither an import for that polyfill nor any
// build step that would add one. Introducing Temporal here without either
// would just replace working code with a ReferenceError. If Temporal (or
// its polyfill) gets added to this codebase's dependencies, this is the
// function to switch over.
function timeAgoLabel(timestampMs, { running } = {}) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestampMs) / 60000));

  if (running) {
    if (minutes < 1) return 'Running';
    if (minutes < 60) return `Running for ${minutes}m`;
    return `Running for ${Math.floor(minutes / 60)}h`;
  }
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// Shared by markAllRead() and togglePanel()'s "opening the panel marks
// everything read" step — both used to inline the same map() separately.
function markAllReadInPlace() {
  let changed = false;
  OS.notifications = OS.notifications.map(n => {
    if (n && !n.read) {
      changed = true;
      return { ...n, read: true };
    }
    return n;
  });
  if (changed) OS.notifUnread = 0;
  return changed;
}

function markReadInPlace(notifId) {
  let changed = false;
  OS.notifications = OS.notifications.map(n => {
    if (n && n.id === notifId && !n.read) {
      changed = true;
      return { ...n, read: true };
    }
    return n;
  });
  if (changed) OS.notifUnread = Math.max(0, OS.notifUnread - 1);
  return changed;
}

function dismissNotification(notifId) {
  const before = OS.notifications.length;
  OS.notifications = OS.notifications.filter(n => !(n.id === notifId && !n.pinned));
  if (OS.notifications.length === before) return false;
  OS.notifUnread = OS.notifications.filter(n => !n.read).length;
  return true;
}

const Notify = {
  _storageKey: 'novaOS_notifications',
  _loaded: false,

  loadPersisted() {
    if (Notify._loaded) return;
    Notify._loaded = true;
    try {
      const saved = JSON.parse(localStorage.getItem(Notify._storageKey) || '[]');
      if (Array.isArray(saved)) {
        OS.notifications = saved.slice(0, 100);
        OS.notifUnread = OS.notifications.filter(n => !n.read).length;
      }
    } catch (e) {
      OS.notifications = [];
      OS.notifUnread = 0;
    }
  },

  persist() {
    try {
      localStorage.setItem(Notify._storageKey, JSON.stringify(OS.notifications.slice(0, 100)));
    } catch (e) {
      // localStorage can throw in private-browsing mode or when the quota
      // is full — persistence is best-effort, so we just drop it here.
    }
  },

  markAllRead() {
    const changed = markAllReadInPlace();
    OS.notifUnread = 0;
    if (changed) Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  // Clears only notifications tagged with the given appId — used by the
  // nova:notifications:clear IPC handler so a sandboxed app can clear its
  // own notifications without touching other apps' or the system's.
  clearForApp(appId) {
    if (!appId) return;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => n && n.appId !== appId);
    if (OS.notifications.length === before) return;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  // Clears every notification regardless of source, except pinned entries.
  // Not exposed over the app IPC bridge — only for first-party system UI
  // (e.g. a "Clear all" button the user presses directly in the
  // notification panel). Pinned entries survive this on purpose: "Clear
  // All" is a way to tidy up past events, not a way to make a still-running
  // background app disappear from view — the only path that removes a
  // pinned entry is unpin(), via Terminate or the app's own exit.
  clearAll() {
    OS.notifications = OS.notifications.filter(n => n && n.pinned);
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
  },

  // ── v2: channels, tag updates, cancel, action queue ──────────────────
  // These delegate to the module-level helpers above; they exist on Notify
  // so the sandbox handlers and the future Settings channel UI have one
  // entry point each.

  ensureChannel(appId, def, opts) {
    return ensureChannelForApp(appId, def, opts);
  },

  ensureChannelsFromManifest(appId, manifest) {
    ensureDeclaredChannels(appId, manifest);
  },

  getChannel(appId, channelId) {
    return getChannelForApp(appId, channelId);
  },

  // Per-channel user overrides. The Settings wiring lands with the
  // permission-model work; the store is live now so no migration is needed
  // later. Pass null to clear an override.
  setChannelOverride(appId, channelId, override) {
    ensureNotifStores();
    if (!appId || !slugOk(channelId, MAX_NOTIF_KEY_LEN) || !channelDefs[appId]?.[channelId]) return false;
    const key = `${appId}|${channelId}`;
    if (override === null) {
      delete channelOverrides[key];
    } else {
      const clean = {};
      if (override && typeof override === 'object') {
        if (typeof override.enabled === 'boolean') clean.enabled = override.enabled;
        if (typeof override.importance === 'string' && CHANNEL_IMPORTANCES.has(override.importance)) clean.importance = override.importance;
      }
      channelOverrides[key] = clean;
    }
    persistChannelOverrides();
    return true;
  },

  listChannels(appId) {
    ensureNotifStores();
    if (!appId) return [];
    return Object.keys(channelDefs[appId] || {})
      .map(id => getChannelForApp(appId, id))
      .filter(Boolean);
  },

  // App ids that have registered at least one channel. Uninstalled apps are
  // wiped from channelDefs on uninstall, so everything listed here is live.
  // Used by the Settings > Notifications channel UI.
  listAppsWithChannels() {
    ensureNotifStores();
    return Object.keys(channelDefs)
      .filter(id => channelDefs[id] && Object.keys(channelDefs[id]).length > 0);
  },

  // Tag lookup for update-in-place — pinned entries are never tag targets
  // (they belong to the background-app pin lifecycle, not to app posts).
  findByTag(appId, tag) {
    Notify.loadPersisted();
    if (!appId || typeof tag !== 'string' || !tag) return null;
    return OS.notifications.find(n => n && !n.pinned && n.appId === appId && n.tag === tag) || null;
  },

  cancelByTag(appId, tag) {
    Notify.loadPersisted();
    if (!appId || typeof tag !== 'string' || !tag) return false;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => !(n && !n.pinned && n.appId === appId && n.tag === tag));
    if (OS.notifications.length === before) return false;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
    return true;
  },

  cancelById(appId, notifId) {
    Notify.loadPersisted();
    if (!appId || typeof notifId !== 'string' || !notifId) return false;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => !(n && !n.pinned && n.appId === appId && n.id === notifId));
    if (OS.notifications.length === before) return false;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
    return true;
  },

  consumePendingActions(appId) {
    return consumeActionsForApp(appId);
  },

  removeAllAppState(appId) {
    dropNotificationAppState(appId);
  },

  show(opts) {
    Notify.loadPersisted();
    const { title, body, type, appName, appId, category, icon, action, actionLabel, pinned, pinId, channelId, tag, actions, progress } = opts;

    // v2 channel gate — system callers (no appId) and pinned background-app
    // entries bypass channels entirely, exactly as before. App posts resolve
    // their channel (defaulting to 'general' for legacy callers) and drop
    // silently when the user muted it.
    let importance = 'default';
    if (appId && !pinned) {
      const chId = typeof channelId === 'string' && channelId ? channelId : 'general';
      const channel = getChannelForApp(appId, chId);
      if (channel) {
        if (channel.blocked) return null;
        importance = channel.importance;
      }
      // Unknown channel: fall through with default importance. The v2 IPC
      // handler rejects unknown channels before show() is ever reached;
      // this leniency only covers first-party callers.
    }

    // Update-in-place: a post carrying a tag that matches a live (unpinned,
    // undismissed) notification from the same app replaces it — same id,
    // same panel position. This is what makes progress bars and chat
    // previews possible without spamming the rate limiter.
    let target = null;
    if (!pinned && tag && appId) {
      target = OS.notifications.find(n => n && !n.pinned && n.appId === appId && n.tag === tag) || null;
    }

    // App-declared action buttons (max 3). A legacy string action from the
    // old allowlist is wrapped with legacy:true so clicks keep routing
    // through runAction()'s built-in switch; function actions stay
    // first-party-only and keep the single-button render below.
    let v2Actions = [];
    if (Array.isArray(actions)) {
      for (const a of actions.slice(0, MAX_ACTIONS_PER_NOTIF)) {
        if (a && slugOk(a.id, 40) && typeof a.label === 'string' && a.label.trim()) {
          v2Actions.push({ id: a.id, label: a.label.slice(0, 40) });
        }
      }
    } else if (target && actions === undefined && Array.isArray(target.actions)) {
      // Field-wise update semantics: a tag-update that omits actions keeps
      // the existing buttons — a progress ticker shouldn't have to re-list
      // them. Pass actions: [] explicitly to clear them.
      v2Actions = target.actions.filter(a => a && slugOk(a.id, 40) && typeof a.label === 'string');
    }
    if (!v2Actions.length && typeof action === 'string' && actionLabel) {
      v2Actions = [{ id: action, label: String(actionLabel).slice(0, 40), legacy: true }];
    }

    const id = target ? target.id : generateId();
    const notif = {
      id,
      title: title || '',
      body: body || '',
      type: type || 'info',
      appName: appName || 'System',
      appId: appId || null,
      category: category || (appId ? 'app' : 'system'),
      icon: safeIconKey(icon || 'bell'),
      timestamp: Date.now(),
      read: false,
      action: action || null,
      actionLabel: actionLabel || null,
      channelId: appId && !pinned ? (typeof channelId === 'string' && channelId ? channelId : 'general') : null,
      tag: tag || null,
      actions: v2Actions,
      // Same field-wise rule as actions: an update that omits progress
      // keeps the existing bar; an explicit null/absent-on-new-post clears.
      progress: progress !== undefined
        ? (progress && typeof progress === 'object' ? progress : null)
        : (target ? (target.progress || null) : null),
      // Pinned entries are for things that are still true right now (an app
      // is currently running in the background), not a one-off event — see
      // pinBackgroundApp()/unpin() below. `pinId` is a stable key so a
      // caller can look the entry up later and clear it without touching
      // regular notifications; plain one-off notifications never set this.
      pinned: !!pinned,
      pinId: pinned ? (pinId || `pin_${id}`) : null,
    };

    if (target) {
      Object.assign(target, notif);
      OS.notifUnread = OS.notifications.filter(n => n && !n.read).length;
    } else {
      OS.notifications.unshift(notif);
      if (OS.notifications.length > 100) {
        // Never let the 100-cap evict a pinned entry — it's reporting a
        // currently-true fact (a background app is alive), not a stale event,
        // so it doesn't age out just because unrelated notifications piled up.
        // Trim the oldest *unpinned* entry instead. Walk backward from the end
        // rather than cloning and reversing the whole array just to find one
        // index.
        let trimIndex = -1;
        for (let i = OS.notifications.length - 1; i >= 0; i--) {
          if (!OS.notifications[i].pinned) {
            trimIndex = i;
            break;
          }
        }
        if (trimIndex !== -1) OS.notifications.splice(trimIndex, 1);
      }
      OS.notifUnread++;
    }
    Notify.updateBadge();
    updateNotificationBadge();
    Notify.renderPanel();
    Notify.persist();

    // Channel importance drives toast behavior: 'low' lands in the panel
    // silently (dwell 0), 'high' lingers 8s (closest thing to heads-up),
    // 'default' gets the classic 4s. Entries with action buttons always get
    // the long dwell so the buttons are actually reachable. DND still wins.
    let dwellMs = IMPORTANCE_DWELL_MS[importance] ?? 4000;
    if ((v2Actions.length || notif.action) && dwellMs < 8000) dwellMs = 8000;
    if (!OS.dnd && dwellMs > 0) Notify.showToast(notif, { dwellMs });

    if (notif.type === 'error' && typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Notify', category: 'system', severity: 'error', message: `[${notif.appName}] ${notif.title}${notif.body ? ': ' + notif.body : ''}`, data: { appName: notif.appName, title: notif.title } });
    }

    return notif;
  },

  // ── Pinned background-app entries ──────────────────────────────────────
  // A pinned entry represents "this app is currently running in the
  // background," not a past event, so it behaves differently from a normal
  // notification in three ways: it sorts above everything else in the
  // panel, it survives clearAll()/the 100-item cap, and it can't be
  // dismissed by the user — only by the thing it describes actually ending
  // (see unpin(), called from the Terminate action or the app's own
  // natural exit). This mirrors how a foreground-service notification
  // behaves on Android, for the same reason: the cost is ongoing, so the
  // visibility should be too.

  /**
   * Create (or replace) the pinned "running in background" entry for an app.
   * @param {string} appId
   * @param {{ appName?: string, title?: string, body?: string, onTerminate?: () => void }} opts
   * @returns {object} the pinned notification object
   */
  pinBackgroundApp(appId, opts = {}) {
    Notify.loadPersisted();
    const pinId = `pin_bg_${appId}`;
    // Replace rather than duplicate if one already exists for this app.
    Notify.unpin(pinId, { silent: true });
    const notif = Notify.show({
      title: opts.title || `${opts.appName || appId} is running in the background`,
      body: opts.body || '',
      type: 'info',
      appName: opts.appName || appId,
      appId,
      category: 'background',
      icon: 'zap',
      pinned: true,
      pinId,
      action: () => {
        try { opts.onTerminate?.(); } finally { Notify.unpin(pinId); }
      },
      actionLabel: 'Terminate',
    });
    return notif;
  },

  /**
   * Remove a pinned entry by its pinId. This is the *only* way a pinned
   * entry goes away — normal dismiss/clear paths skip pinned rows entirely
   * (see clearAll() and renderPanel()'s missing close button on pinned
   * items). Call this once the thing it was reporting on has actually
   * ended (Terminate pressed, or the app exited on its own).
   */
  unpin(pinId, { silent = false } = {}) {
    if (!pinId) return;
    const before = OS.notifications.length;
    OS.notifications = OS.notifications.filter(n => !(n.pinned && n.pinId === pinId));
    if (OS.notifications.length === before) return;
    OS.notifUnread = OS.notifications.filter(n => !n.read).length;
    Notify.persist();
    if (!silent) {
      Notify.updateBadge();
      updateNotificationBadge();
      Notify.renderPanel();
    }
  },

  // Runs a notification's `action`. Function actions are called directly;
  // string actions go through the built-in allowlist (kept in sync with
  // ALLOWED_NOTIF_ACTIONS in app-sandbox.js). Shared by the toast and the
  // persistent panel so both surfaces behave the same way on click.
  runAction(notif) {
    try {
      if (typeof notif.action === 'function') {
        notif.action();
        return;
      }
      if (typeof notif.action === 'string') {
        switch (notif.action) {
          case 'settings':
          case 'open-settings':
          case 'openSettings':
            if (typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
              WM.createWindow('com.nbosp.settings');
            } else {
              console.warn('[Notify] Cannot open settings — WM.createWindow unavailable');
              if (typeof EventLog !== 'undefined') {
                EventLog.log({ app: 'Notify', category: 'system', severity: 'warn', message: 'Open settings action failed — WM unavailable', data: { action: notif.action, appName: notif.appName } });
              }
            }
            break;
          case 'open-store':
            if (typeof WM !== 'undefined' && typeof WM.createWindow === 'function') {
              WM.createWindow('com.nbosp.store');
            } else {
              console.warn('[Notify] Cannot open Store — WM.createWindow unavailable');
              if (typeof EventLog !== 'undefined') {
                EventLog.log({ app: 'Notify', category: 'system', severity: 'warn', message: 'Open Store action failed — WM unavailable', data: { action: notif.action, appName: notif.appName } });
              }
            }
            break;
          default:
            console.warn('[Notify] Unknown built-in action:', notif.action);
            if (typeof EventLog !== 'undefined') {
              EventLog.log({ app: 'Notify', category: 'system', severity: 'warn', message: `Unknown built-in action: ${notif.action}`, data: { action: notif.action, appName: notif.appName } });
            }
        }
      }
    } catch (err) {
      console.error('[Notify] Action error:', err);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({ app: 'Notify', category: 'system', severity: 'error', message: `Action failed: ${err?.message || err}`, data: { appName: notif.appName } });
      }
      Notify.show({ title: 'Action Failed', body: err?.message || 'An unknown error occurred.', type: 'error', appName: notif.appName || 'System' });
    }
  },

  showToast(notif, { dwellMs } = {}) {
    const container = document.getElementById('toast-container');
    // The container should always be in the page shell, but bail out
    // quietly instead of throwing if some layout variant doesn't have it —
    // a missing toast host shouldn't take down whatever called Notify.show().
    if (!container) {
      console.warn('[Notify] #toast-container not found, skipping toast for:', notif.title);
      return;
    }

    const toast = createEl('div', { className: `toast ${notif.type}`, role: 'alert' });
    const ac = new AbortController();

    const content = createEl('div', { className: 'toast-content' });
    const titleEl = createEl('div', { className: 'toast-title', textContent: notif.title });
    const bodyEl = createEl('div', { className: 'toast-body', textContent: notif.body });
    content.appendChild(titleEl);
    if (notif.body) content.appendChild(bodyEl);

    // Tapping the toast body opens the posting app. Progress lives only in
    // the panel — toasts stay text + buttons.
    content.addEventListener('click', () => {
      clearTimeout(timer);
      removeToast();
      openNotificationApp(notif);
    }, { signal: ac.signal });

    // v2: up to 3 app-declared action buttons. Legacy single string actions
    // (and first-party function actions, e.g. the pinned Terminate button)
    // render through the fallback below and route via runAction().
    const actionDefs = (Array.isArray(notif.actions) && notif.actions.length)
      ? notif.actions
      : (notif.action && notif.actionLabel ? [{ id: notif.action, label: notif.actionLabel, legacy: true }] : []);
    for (const a of actionDefs.slice(0, MAX_ACTIONS_PER_NOTIF)) {
      const actionBtn = createEl('button', { className: 'toast-action' });
      actionBtn.textContent = a.label;
      actionBtn.style.cssText = `margin-left:auto;${ACTION_BUTTON_STYLE}`;
      wireActionButtonHover(actionBtn);
      actionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        clearTimeout(timer);
        removeToast();
        handleNotificationActionClick(notif, a);
      }, { signal: ac.signal });
      content.appendChild(actionBtn);
    }

    const closeBtn = createEl('button', { className: 'toast-close', 'aria-label': 'Dismiss notification' });
    closeBtn.innerHTML = svgIcon('x', 14);

    toast.appendChild(content);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    // Toasts with an action get longer both on the initial timer and the
    // post-hover grace period, so a reader has time to notice the button
    // either way — the grace period isn't meant to be shorter than a plain
    // toast's full timer, just shorter than this toast's own initial one.
    // A channel-supplied dwellMs (v2 importance) overrides the default;
    // legacy callers get the original behavior unchanged.
    const hasAction = actionDefs.length > 0;
    const initialDelay = dwellMs ?? (hasAction ? 8000 : 4000);
    const hoverGraceDelay = hasAction ? 4000 : 2000;
    let timer = setTimeout(() => removeToast(), initialDelay);

    toast.addEventListener('pointerenter', () => clearTimeout(timer), { signal: ac.signal });
    toast.addEventListener('pointerleave', () => { timer = setTimeout(() => removeToast(), hoverGraceDelay); }, { signal: ac.signal });

    closeBtn.addEventListener('click', () => { clearTimeout(timer); removeToast(); }, { signal: ac.signal });

    function removeToast() {
      clearTimeout(timer);
      ac.abort();
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 300);
    }
  },

  updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (OS.notifUnread > 0) {
      badge.textContent = OS.notifUnread > 99 ? '99+' : String(OS.notifUnread);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  },

  renderPanel() {
    Notify.loadPersisted();
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (OS.notifications.length === 0) {
      const empty = createEl('div', { className: 'empty-state' });
      empty.appendChild(createEl('div', { className: 'text-muted', textContent: 'No notifications' }));
      list.replaceChildren(empty);
      return;
    }
    // Building nodes in a fragment and appending once avoids a reflow per
    // notification row. Pinned entries (currently-running background apps)
    // sort above everything else regardless of timestamp — they're
    // reporting an ongoing state, not a past event, so "most recent first"
    // doesn't apply to them the way it does to the rest of the list.
    const sorted = [...OS.notifications].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const frag = document.createDocumentFragment();
    for (const n of sorted.slice(0, 50)) {
      const item = createEl('div', {
        className: `notif-item${n.read ? ' read' : ''}${n.pinned ? ' notif-item-pinned' : ''}`,
        role: 'listitem',
      });
      const icon = createEl('div', { style: { width: '24px', height: '24px', color: n.pinned ? '#58a6ff' : 'var(--text-secondary)', flexShrink: '0' } });
      icon.innerHTML = svgIcon(n.pinned ? safeIconKey(n.icon || 'zap') : 'bell', 16);
      const content = createEl('div', { className: 'notif-item-content' });
      content.appendChild(createEl('div', { className: 'notif-item-title', textContent: n.title }));
      content.appendChild(createEl('div', { className: 'notif-item-body', textContent: n.body }));

      // v2 deterministic progress bar (determinate only; an indeterminate
      // progress renders a fixed 40% sliver since this panel has no CSS
      // animation contract to lean on).
      if (n.progress && typeof n.progress === 'object') {
        const bar = createEl('div');
        bar.style.cssText = 'height:4px;border-radius:2px;background:rgba(139,148,158,0.3);margin-top:6px;overflow:hidden;';
        const fill = createEl('div');
        const max = Math.max(1, Number(n.progress.max) || 100);
        const pct = n.progress.indeterminate
          ? 40
          : Math.max(0, Math.min(100, Math.round((Number(n.progress.value) / max) * 100)));
        fill.style.cssText = `height:100%;width:${pct}%;background:#58a6ff;border-radius:2px;`;
        bar.appendChild(fill);
        content.appendChild(bar);
      }

      content.appendChild(createEl('div', { className: 'notif-item-time', textContent: timeAgoLabel(n.timestamp, { running: n.pinned }) }));
      // Tapping the row body opens the posting app — the tap-through the
      // old panel was missing. The buttons below stopPropagation, so they
      // don't trigger this.
      content.addEventListener('click', () => openNotificationApp(n));
      item.appendChild(icon);
      item.appendChild(content);

      const actionDefs = (Array.isArray(n.actions) && n.actions.length)
        ? n.actions
        : (n.action && n.actionLabel ? [{ id: n.action, label: n.actionLabel, legacy: true }] : []);
      const controls = createEl('div', {
        className: 'notif-item-controls',
        style: 'display:flex;flex:1 1 100%;min-width:0;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:6px;margin-left:34px;',
      });
      for (let ai = 0; ai < actionDefs.length && ai < MAX_ACTIONS_PER_NOTIF; ai++) {
        const a = actionDefs[ai];
        const actionBtn = createEl('button', { className: 'notif-item-action' });
        actionBtn.textContent = a.label;
        actionBtn.style.cssText = `flex:0 1 auto;min-width:0;${ACTION_BUTTON_STYLE}`;
        wireActionButtonHover(actionBtn);
        actionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleNotificationActionClick(n, a);
        });
        controls.appendChild(actionBtn);
      }

      if (!n.read) {
        const markReadBtn = createEl('button', { className: 'notif-item-action', textContent: 'Mark read' });
        markReadBtn.style.cssText = `flex:0 1 auto;min-width:0;${ACTION_BUTTON_STYLE}`;
        wireActionButtonHover(markReadBtn);
        markReadBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const changed = markReadInPlace(n.id);
          if (changed) {
            Notify.persist();
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        });
        controls.appendChild(markReadBtn);
      }

      if (!n.pinned) {
        const dismissBtn = createEl('button', { className: 'notif-item-dismiss', 'aria-label': 'Dismiss notification' });
        dismissBtn.innerHTML = svgIcon('x', 14);
        dismissBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const changed = dismissNotification(n.id);
          if (changed) {
            Notify.persist();
            Notify.updateBadge();
            updateNotificationBadge();
            Notify.renderPanel();
          }
        });
        controls.appendChild(dismissBtn);
      }

      if (controls.childNodes.length) item.appendChild(controls);
      frag.appendChild(item);
    }
    list.replaceChildren(frag);
  },

  togglePanel() {
    Notify.loadPersisted();
    const panel = document.getElementById('notification-panel');
    if (!panel) return;
    const opening = !panel.classList.contains('active');
    panel.classList.toggle('active');
    if (typeof window.resetShellScroll === 'function') {
      window.resetShellScroll();
      requestAnimationFrame(window.resetShellScroll);
    }
    if (opening) {
      if (OS.notifications.length) {
        const changed = markAllReadInPlace();
        if (changed) Notify.persist();
      }
      Notify.updateBadge();
      updateNotificationBadge();
      Notify.renderPanel();
    }
  },
};

if (typeof Notify !== 'undefined') {
  window.Notify = Notify;
} else {
  console.warn('Notify object was not found in the local scope of app-notifications.js');
}