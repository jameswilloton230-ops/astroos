/**
 * AstroOS — App Permission Manager
 *
 * Android-style permission system with sequential prompt queue,
 * persistent grants, and automatic 30-day unused-app expiry.
 *
 * @module js/platform/security/app-permission-manager
 */

const AppPermissionManager = (() => {
  'use strict';

  // Permission catalogue

  const PERMISSION_TYPES = Object.freeze({
    FS_ACCESS         : 'fs:access',
    FS_METADATA       : 'fs:metadata',
    // Change notifications for paths the app could already read. 'low':
    // purely reactive — it cannot read anything a plain read could not, it
    // only learns WHEN a readable path changes. The handler still enforces
    // the exact nova:fs:read per-path rules; this grant is the context-free
    // front door on top.
    FS_WATCH          : 'fs:watch',
    FS_READ_IMAGES    : 'fs:read:images',
    FS_READ_VIDEO     : 'fs:read:video',
    FS_READ_AUDIO     : 'fs:read:audio',
    NET_INTERNAL      : 'net:internal',   NET_EXTERNAL      : 'net:external',
    NET_WEBSOCKET     : 'net:websocket',
    MAIL_READ         : 'mail:read',      MAIL_WRITE        : 'mail:write',
    MAIL_SEND         : 'mail:send',      MAIL_DELETE       : 'mail:delete',
    CALENDAR_READ     : 'calendar:read',  CALENDAR_WRITE    : 'calendar:write',
    CALENDAR_DELETE   : 'calendar:delete',
    CONTACTS_READ     : 'contacts:read',  CONTACTS_WRITE    : 'contacts:write',
    CONTACTS_DELETE   : 'contacts:delete',
    DEVICE_NOTIFICATIONS: 'device:notifications',
    DEVICE_GEOLOCATION: 'device:geolocation',
    DEVICE_CAMERA     : 'device:camera',
    DEVICE_MICROPHONE : 'device:microphone',
    // Clipboard is a shared, ambient, cross-app channel, not a file.
    CLIPBOARD_READ    : 'clipboard:read',  CLIPBOARD_WRITE   : 'clipboard:write',
    // Data portability — export/backup of the app's OWN storage namespace.
    // 'low' on purpose: both grants only ever touch the caller's own
    // key/value namespace (strictly caller-scoped, like clipboard:write);
    // restore/import pin the envelope's appId to the caller, so no grant
    // here can read another app's data or smuggle data across apps.
    DATA_EXPORT       : 'data:export',     DATA_BACKUP       : 'data:backup',
    // Encrypted per-app credential store (AES-256-GCM at rest, separate
    // from nova:storage so backup envelopes can never carry credentials).
    // 'medium': the app can read back what it stored — the risk is the
    // app's own credentials, not other apps' or the user's data. The OS
    // never exposes one app's secrets to another, and the Settings
    // dashboard shows counts only, never values.
    SECRETS_STORE     : 'secrets:store',
    SYSTEM_INFO       : 'system:info',    SYSTEM_SETTINGS   : 'system:settings',
    SYSTEM_APPS       : 'system:apps',    SYSTEM_APP_LAUNCH : 'system:app-launch',
    APPS_COMMUNICATE  : 'apps:communicate',
    SYSTEM_ROOT       : 'system:root',
    SYSTEM_EVENTS     : 'system:events',
    // Background execution is split into two independent grants on purpose:
    // SYSTEM_BACKGROUND covers scheduled wake-ups (the app doesn't need to be
    // open at all for the host to run it briefly), while
    // SYSTEM_BACKGROUND_LIVE covers staying alive as a running process after
    // the user closes its window — a strictly bigger ask, since the process
    // keeps consuming resources indefinitely rather than waking briefly.
    // Neither implies device:notifications — an app with either background
    // grant still can't call nova:notifications:show without that grant too.
    // SYSTEM_AUTOSTART is a third, separate thing again: launching the app
    // at OS boot/login with no user action at all in that session, which is
    // a bigger trust ask than either background tier and must be granted
    // explicitly rather than folded into SYSTEM_BACKGROUND.
    SYSTEM_BACKGROUND      : 'system:background',
    SYSTEM_BACKGROUND_LIVE : 'system:background:live',
    SYSTEM_AUTOSTART       : 'system:autostart',
    // Taskbar badge — a count or short label on the app's own taskbar icon.
    // 'low': purely presentational, scoped to the app's own icon, host-clamped
    // (0-999 / 4 chars) and rate-limited; it can't touch other apps' icons
    // or any user data.
    SYSTEM_BADGE           : 'system:badge',
    // Named alarms — the app may schedule its own wake-prompt times (one-shot
    // or periodic with a 15-minute floor). 'medium': alarms persist host-side
    // and fire pushes into the app's live sandbox, so an app can schedule
    // future activity without being open — but unlike system:background it
    // can NEVER launch itself: a fire while fully closed queues a bounded
    // push for the next launch and nothing runs in between.
    SYSTEM_SCHEDULE        : 'system:schedule',
    // Inbound share target — the app may be OFFERED as a destination in the
    // share sheet (outbound nova:share), and receives a push when the user
    // picks it. 'medium': delivery is strictly user-mediated (the pick IS
    // the consent), but the app receives other apps' content, which is a
    // real data-inflow surface; the manifest must also declare a
    // shareTarget with the MIME types it accepts.
    SYSTEM_SHARE_TARGET    : 'system:share-target',
    // Push delivery — the app's own backend may send it messages through the
    // OS push service, and the OS may display a notification on the app's
    // behalf while it is fully closed. 'medium': content flows in from the
    // internet addressed to this app (a real data-inflow surface), but the
    // OS holds the one server connection — apps never open their own listen
    // socket — and every message passes through the delivery ladder, which
    // drops anything for a revoked or disabled app before it can run code.
    // Notification display while closed is bounded by the same per-app
    // notification rate limit as apps posting their own.
    PUSH_RECEIVE           : 'push:receive',
    ADMIN_APPS        : 'admin:apps',     ADMIN_USERS       : 'admin:users',
    ADMIN_SYSTEM      : 'admin:system',   ADMIN_AUDIT       : 'admin:audit',
    // Lets a .novaapp's own guest content instantiate a nested <webview>
    // tag (a second, separate renderer process the app controls directly —
    // e.g. an in-app browser feature). This is NOT about the outer sandbox
    // webview app-sandbox.js already creates for every app (that one isn't
    // gated by permission at all, it's how apps run). This is specifically
    // for app HTML that wants to create its OWN <webview> inside that
    // sandbox. Any app that falls back to sandbox execution must opt in and
    // hold this grant; trusted apps approved for host execution do not use
    // the sandbox path.
    SANDBOX_NESTED_WEBVIEW : 'sandbox:nested-webview',
    // Lets a sandboxed .novaapp receive allow-same-origin, giving the guest
    // access to its own cookies, localStorage, and sessionStorage on the
    // shared origin. The sandbox path requires BOTH allowSameOrigin: true in
    // the manifest and this separate grant before adding the token.
    SANDBOX_SAME_ORIGIN : 'sandbox:same-origin',
    // Same double-gate pattern as SANDBOX_SAME_ORIGIN just above: a
    // sandboxed app needs BOTH allowPopupsToEscapeSandbox: true in the
    // manifest AND this grant before sanitizeSandboxAttr() adds
    // allow-popups-to-escape-sandbox to the sandbox attribute. Previously
    // the manifest flag alone was enough —
    // a popup that escapes the sandbox is a fully unrestricted browsing
    // context, comparable risk to allow-same-origin, with none of the same
    // gating. See app-sandbox.js.
    SANDBOX_ESCAPE_POPUPS : 'sandbox:escape-popups',
    // AstroOS Registry — the typed hierarchical config store the OS reads
    // at boot. read is 'low' (config facts; the HKNS/security subtree is
    // still blocked without registry.system), write is 'medium' (the app may
    // persist config into its OWN HKNA/<appId>/ subtree — quota'd, visible
    // to the user in the NovaReg editor), system is 'critical' (read/write
    // everywhere INCLUDING the system and security keys the OS itself runs
    // on — effectively root for configuration).
    REGISTRY_READ    : 'registry.read',
    REGISTRY_WRITE   : 'registry.write',
    REGISTRY_SYSTEM  : 'registry.system',
  });

  const PERMISSION_CATEGORIES = Object.freeze({
    'fs:access'         : { category: 'filesystem', risk: 'critical', label: 'Manage all files', specialAccess: true },
    'fs:metadata'       : { category: 'filesystem', risk: 'medium',   label: 'Read shared file metadata' },
    // See FS_WATCH above — reactive-only, never grants new read access.
    'fs:watch'          : { category: 'filesystem', risk: 'low',      label: 'Get notified when your files change' },
    'fs:read:images'    : { category: 'filesystem', risk: 'medium',   label: 'Read shared images' },
    'fs:read:video'     : { category: 'filesystem', risk: 'medium',   label: 'Read shared videos' },
    'fs:read:audio'     : { category: 'filesystem', risk: 'medium',   label: 'Read shared audio' },
    'apps:communicate'  : { category: 'apps',       risk: 'high',     label: 'Communicate with other apps' },
    'net:internal'      : { category: 'network',    risk: 'high',     label: 'Internal network' },
    'net:external'      : { category: 'network',    risk: 'low',      label: 'Public internet access' },
    'net:websocket'     : { category: 'network',    risk: 'low',      label: 'Public WebSocket connections' },
    'mail:read'         : { category: 'email',      risk: 'high',     label: 'Read emails' },
    'mail:write'        : { category: 'email',      risk: 'critical', label: 'Compose emails' },
    'mail:send'         : { category: 'email',      risk: 'critical', label: 'Send emails' },
    'mail:delete'       : { category: 'email',      risk: 'critical', label: 'Delete emails' },
    'calendar:read'     : { category: 'calendar',   risk: 'medium',   label: 'Read calendar' },
    'calendar:write'    : { category: 'calendar',   risk: 'high',     label: 'Edit calendar' },
    'calendar:delete'   : { category: 'calendar',   risk: 'high',     label: 'Delete calendar events' },
    'contacts:read'     : { category: 'contacts',   risk: 'medium',   label: 'Read contacts' },
    'contacts:write'    : { category: 'contacts',   risk: 'high',     label: 'Edit contacts' },
    'contacts:delete'   : { category: 'contacts',   risk: 'high',     label: 'Delete contacts' },
    'device:notifications': { category: 'device',   risk: 'low',      label: 'Send notifications' },
    'device:geolocation': { category: 'device',     risk: 'high',     label: 'Access location' },
    'device:camera'     : { category: 'device',     risk: 'critical', label: 'Access camera' },
    'device:microphone' : { category: 'device',     risk: 'critical', label: 'Access microphone' },
    // 'high', matching mail:read/device:geolocation rather than filesystem
    // 'medium' — the clipboard is a shared, ambient, cross-app channel that
    // can contain whatever any other app (or the user) copied moments ago,
    // not scoped to this app's own data the way most 'medium' grants are.
    // See handleClipboardRead/Write in app-sandbox.js for the full rationale.
    'clipboard:read'    : { category: 'device',     risk: 'high',     label: 'Read clipboard' },
    'clipboard:write'   : { category: 'device',     risk: 'low',      label: 'Write clipboard' },
    // Data portability. 'low' because the entire surface is caller-scoped:
    // export/backup serialize the app's own key/value namespace, and
    // restore/import refuse any envelope whose appId doesn't match the
    // caller (no cross-app channel) and verify a checksum before writing.
    // The worst a bad envelope can destroy is the app's own data — the
    // same blast radius as the app calling nova:storage:clear itself.
    'data:export'       : { category: 'data',       risk: 'low',      label: 'Export this app\u2019s data' },
    'data:backup'       : { category: 'data',       risk: 'low',      label: 'Back up and restore this app\u2019s data' },
    // See SECRETS_STORE above — app-scoped encrypted credentials, counts
    // only in Settings, never in export/backup envelopes.
    'secrets:store'     : { category: 'data',       risk: 'medium',   label: 'Securely store passwords and tokens' },
    // 'medium', not 'low' — this gates both nova:system:info (OS version,
    // security patch level, username, uptime) and handleSettingsGet's
    // SETTINGS_READABLE_KEYS allowlist (username, region, timezone,
    // devMode, browserPartitionId, and 24 other real settings values — see
    // app-sandbox.js). That's substantive personal/system data, not just
    // inert metadata; closer in shape to filesystem read or calendar:read (both
    // 'medium') than to device:notifications (both 'low',
    // and genuinely lower-stakes: filenames only, or send-only with no
    // data exposure).
    'system:info'       : { category: 'system',     risk: 'medium',   label: 'System information' },
    'system:settings'   : { category: 'system',     risk: 'medium',   label: 'System settings' },
    'system:apps'       : { category: 'system',     risk: 'medium',   label: 'Manage apps' },
    'system:app-launch' : { category: 'system',     risk: 'low',      label: 'Launch installed apps' },
    'system:root'       : { category: 'system',     risk: 'critical', label: 'Unrestricted OS access (Root)' },
    'system:events'     : { category: 'system',     risk: 'medium',   label: 'System events' },
    'system:background' : { category: 'system',     risk: 'medium',   label: 'Run scheduled background tasks' },
    'system:background:live': { category: 'system', risk: 'high',     label: 'Keep running after you close it' },
    'system:autostart'  : { category: 'system',     risk: 'high',     label: 'Start automatically when AstroOS starts' },
    // Presentational only — see the SYSTEM_BADGE rationale above.
    'system:badge'      : { category: 'system',     risk: 'low',      label: 'Show a badge on the taskbar' },
    // See SYSTEM_SCHEDULE above — scheduling, never self-launching.
    'system:schedule'   : { category: 'system',     risk: 'medium',   label: 'Schedule named alarms' },
    // See SYSTEM_SHARE_TARGET above — user-mediated inbound content.
    'system:share-target': { category: 'system',    risk: 'medium',   label: 'Receive shared content' },
    // See PUSH_RECEIVE above — OS-mediated inbound content from the app's
    // own backend, never a third party's.
    'push:receive'      : { category: 'system',     risk: 'medium',   label: 'Receive push messages from its own server' },
    'admin:apps'        : { category: 'admin',      risk: 'high',     label: 'Manage apps (admin)' },
    'admin:users'       : { category: 'admin',      risk: 'critical', label: 'Manage users' },
    'admin:system'      : { category: 'admin',      risk: 'critical', label: 'System administration' },
    'admin:audit'       : { category: 'admin',      risk: 'high',     label: 'Audit logs' },
    // 'critical' because a nested <webview> is a second, independent
    // renderer process the app's own guest code controls directly — it can
    // navigate anywhere, load arbitrary remote content, and (depending on
    // whatever attributes the app sets on ITS webview) potentially run with
    // its own node integration / partition, none of which the outer
    // sandbox's own webview attrs constrain. Never auto-granted, never
    // implied by any other permission.
    'sandbox:nested-webview': { category: 'sandbox', risk: 'critical', label: 'Embed live web content (nested browser view)' },
    // 'high', not 'critical': unlike nested-webview (a whole second
    // uncontained renderer), this only widens what an existing XSS inside
    // the guest can reach — shared cookies/localStorage/sessionStorage on
    // the origin — rather than handing the guest a fresh escape surface.
    // Still a real privilege step up from the sandboxed default, so it's
    // not 'medium' either. See sanitizeSandboxAttr() in app-sandbox.js for
    // the actual gate this backs.
    'sandbox:same-origin': { category: 'sandbox', risk: 'high', label: 'Access shared cookies & storage' },
    // 'high', same as sandbox:same-origin just above — a popup that escapes
    // the sandbox is a fully unrestricted browsing context, which the
    // comment on SANDBOX_ESCAPE_POPUPS above already calls "comparable risk
    // to allow-same-origin." See sanitizeSandboxAttr() in app-sandbox.js for
    // the actual gate this backs.
    'sandbox:escape-popups': { category: 'sandbox', risk: 'high', label: 'Open unrestricted popup windows' },
    // See REGISTRY_* above — reads are config facts ('low'), writes land in
    // the app's own quota'd namespace ('medium'), full-store access includes
    // the keys the OS boots from ('critical'). Per-hive rules are enforced
    // by the nova:reg:* handlers in app-sandbox.js.
    'registry.read'     : { category: 'system', risk: 'low',      label: 'Read the AstroOS Registry' },
    'registry.write'    : { category: 'system', risk: 'medium',   label: 'Store settings in the AstroOS Registry' },
    'registry.system'   : { category: 'system', risk: 'critical', label: 'Full Registry access, including system keys' },
  });

  // Legacy vfs:* permission names from the pre-fs era. Mirrors
  // LEGACY_PERMISSION_ALIASES in app-registry.js (which translates at install
  // time) — this copy covers the runtime path: an app calling
  // nova:request-permission with a vfs:* name bypasses the registry entirely.
  const LEGACY_PERMISSION_ALIASES = Object.freeze({
    'vfs:access':   'fs:access',
    'vfs:read':     'fs:access',
    'vfs:write':    'fs:access',
    'vfs:delete':   'fs:access',
    'vfs:metadata': 'fs:metadata',
  });

  const STORAGE_KEY = 'nova_app_permissions';
  const SWEEP_KEY   = 'nova_perm_last_sweep';
  const UNUSED_DAYS = 30;
  const MS_PER_DAY  = 86_400_000;

  // Rate limiting for requestPermission(). Denied grants no longer
  // short-circuit the dialog (see requestPermission()), so an app could
  // otherwise call requestPermission() in a tight loop and re-show the live
  // dialog every time — a prompt-bombing DoS that also pressures the user
  // into eventually clicking Allow just to make it stop. This tracks, per
  // `${appId}:${permission}`, recent request timestamps and the current
  // cooldown, which backs off further on each consecutive denial. Once an
  // app hits the burst cap within the window, further requests are
  // auto-denied with no dialog shown until the cooldown clears.
  const RATE_WINDOW_MS       = 60_000;
  const RATE_MAX_BURST       = 3;
  const RATE_BASE_COOLDOWN_MS = 5_000;
  const RATE_MAX_COOLDOWN_MS  = 15 * 60_000;
  const RATE_MAX_DENIAL_STREAK = 20; // caps the exponent so backoff math never runs away

  // Manifest-declared permission reasons ("permissionReasons"). A .novaapp
  // manifest may carry a map of permission -> reason text:
  //   "permissionReasons": { "system:root": "Needed to manage system services" }
  // The launch-gate prompts and every runtime request-permission dialog show
  // this declaration so the user can make an informed choice. When neither
  // the call site nor the manifest declares a reason, the dialog renders an
  // explicit "no reason declared" block instead of showing nothing at all.
  // Keys are normalized at install time by app-registry.js (legacy vfs:*
  // names translated, unknown keys stripped); values are capped here so a
  // pathological manifest can't blow out the dialog layout.
  const MAX_REASON_LENGTH = 500;

  // Returns the display-ready reason text, or null when there is nothing
  // usable. Non-strings, whitespace-only strings and the empty result of a
  // length cap are all normalized away so callers can branch on null.
  function normalizeReasonText(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > MAX_REASON_LENGTH ? trimmed.slice(0, MAX_REASON_LENGTH) : trimmed;
  }

  // Reads one permission's reason out of a permissionReasons-style map.
  // Exact key first; then any key whose legacy vfs:* alias canonicalizes to
  // the permission — needed because maps reached through raw manifests (the
  // OS.apps fallback below) never went through app-registry.js's install-time
  // key normalization. Own-property lookups only, so prototype names like
  // 'constructor' can't masquerade as reasons.
  function lookupDeclaredReason(map, permission) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    if (Object.prototype.hasOwnProperty.call(map, permission)) return map[permission];
    for (const [key, value] of Object.entries(map)) {
      const canonical = Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, key)
        ? LEGACY_PERMISSION_ALIASES[key]
        : key;
      if (canonical === permission) return value;
    }
    return null;
  }

  // Resolution order for the text a permission dialog displays:
  //   1. runtimeReason — the calling app's own words for THIS prompt (the
  //      nova:request-permission payload's reason field), the most specific
  //      description of what is happening right now.
  //   2. The manifest's permissionReasons[permission] declaration — the
  //      developer's standing explanation, written at build time. App
  //      records carry it flattened (app-registry.js normalization), with
  //      the raw manifest as a fallback path for records that predate the
  //      flattening.
  //   3. The OS.apps entry for the app — several real launch paths (the App
  //      Manager's package hydration and the nova-app-launcher config
  //      builder) put the app into OS.apps WITHOUT registering it in
  //      AppRegistry, so getApp() returns null exactly at the first-launch
  //      gate where the reason matters most. Both config builders keep the
  //      raw manifest on the entry, and the permission gate itself reads its
  //      permission lists from that same entry, so it is a reliable source.
  //   4. null — the dialog then renders the "no reason declared" fallback.
  function resolvePermissionReason(permission, appId, runtimeReason) {
    // Translate legacy vfs:* names before lookup so the helper is correct
    // standalone (Settings surfaces can call it directly), not just when
    // reached through requestPermission() — which translates first anyway,
    // making this idempotent on the runtime path.
    permission = LEGACY_PERMISSION_ALIASES[permission] ?? permission;
    const fromCall = normalizeReasonText(runtimeReason);
    if (fromCall) return fromCall;
    try {
      const record = typeof AppRegistry !== 'undefined' ? AppRegistry.getApp?.(appId) : null;
      const osEntry = typeof OS !== 'undefined' ? OS?.apps?.[appId] : null;
      const declared = lookupDeclaredReason(record?.permissionReasons, permission)
        ?? lookupDeclaredReason(record?.manifest?.permissionReasons, permission)
        ?? lookupDeclaredReason(osEntry?.permissionReasons, permission)
        ?? lookupDeclaredReason(osEntry?.manifest?.permissionReasons, permission);
      return normalizeReasonText(declared);
    } catch {
      // A hostile or half-initialized AppRegistry must never break the
      // permission prompt itself — worst case the dialog shows the
      // no-reason-declared fallback.
      return null;
    }
  }

  let permissionGrants = new Map(); // key: `${appId}:${permission}`
  const consentLog      = [];
  const rateLimitState  = new Map(); // key: `${appId}:${permission}` -> { attempts, cooldownUntil, denialStreak }

  // Tracks every open dialog's teardown function so a caller (or a future
  // "close all dialogs" action) can force-resolve them instead of leaving
  // requestPermission() awaiting forever if the dialog is torn down some
  // other way (e.g. the host shell clears document.body during a route
  // change while a prompt is still up).
  const openDialogs = new Set();

  function makeAppScopedKey(appId, permission) {
    return `${appId}:${permission}`;
  }

  // Building keys as `${appId}:${permission}` only stays collision-free if
  // appId itself never contains a colon — otherwise app "a" and app "a:b"
  // could shadow each other's keys. Guard here so a malformed appId fails
  // loudly instead of silently corrupting someone else's grants.
  function assertValidAppId(appId) {
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new TypeError(`Invalid appId: expected non-empty string, got ${typeof appId}`);
    }
    if (appId.includes(':')) {
      throw new TypeError(`Invalid appId "${appId}": appId must not contain ":"`);
    }
  }

  // Integrity check
  //
  // Simple structural validation — no HMAC, no cross-session key dependency.
  // The user owns this machine; HMAC against localStorage tampering is
  // security theatre here and was silently nuking all grants on every
  // restart because the renderer partition wiped localStorage (and with it
  // the key). This only guards against corrupted/malformed data crashing
  // later code, not against a hostile local user.

  function isValidGrant(grant) {
    if (!grant || typeof grant !== 'object') return false;
    if (typeof grant.appId !== 'string' || grant.appId.length === 0) return false;
    if (typeof grant.permission !== 'string' || grant.permission.length === 0) return false;
    if (typeof grant.granted !== 'boolean') return false;
    if (typeof grant.grantedAt !== 'string' || Number.isNaN(Date.parse(grant.grantedAt))) return false;
    if (grant.lastUsed != null && (typeof grant.lastUsed !== 'string' || Number.isNaN(Date.parse(grant.lastUsed)))) return false;
    if (grant.expiresAt != null && (typeof grant.expiresAt !== 'string' || Number.isNaN(Date.parse(grant.expiresAt)))) return false;
    return true;
  }

  // Storage

  function getLocalStorage() {
    try {
      // Accessing localStorage itself can throw (Safari private mode,
      // sandboxed iframes without allow-same-origin, some Cross-Origin
      // policies), not just reading/writing from it.
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  // Grants persist in the AstroOS Registry (HKNS/security/appPermissions
  // via RegistrySystemState); the localStorage key is the pre-registry
  // adoption source and the fail-soft fallback when no engine is up.
  function registryState() {
    return typeof window !== 'undefined' && window ? window.RegistrySystemState : null;
  }

  function persistGrants() {
    const grants = [...permissionGrants.values()];
    const state = registryState();
    if (state && typeof state.setAppPermissions === 'function') {
      try {
        state.setAppPermissions(grants);
        return;
      } catch (error) {
        console.error('[AppPermissionManager] registry save failed:', error);
      }
    }
    const storage = getLocalStorage();
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(grants));
    } catch (e) {
      if (e.name === 'SecurityError') return;
      if (e.name === 'QuotaExceededError') {
        console.error('[AppPermissionManager] save failed: localStorage quota exceeded');
        return;
      }
      console.error('[AppPermissionManager] save failed:', e);
    }
  }

  async function saveToStorage() {
    persistGrants();
  }

  // 30-day unused-app expiry sweep

  async function sweepExpiredGrants() {
    const now       = Date.now();
    const threshold = now - UNUSED_DAYS * MS_PER_DAY;

    // Group by appId so we notify once per app, not once per permission.
    const expiredApps = new Map(); // appId -> [permission, ...]

    for (const [key, grant] of permissionGrants) {
      // Never sweep denial records — they must persist to avoid re-prompting.
      if (grant.granted === false) continue;
      // A live root app executes in the host page and cannot be downgraded
      // when an inactivity timer expires. Root access therefore requires an
      // explicit user revocation rather than the ordinary unused-app sweep.
      if (grant.permission === PERMISSION_TYPES.SYSTEM_ROOT) continue;
      const lastUse = Date.parse(grant.lastUsed ?? grant.grantedAt);
      if (Number.isNaN(lastUse) || lastUse < threshold) {
        permissionGrants.delete(key);
        const list = expiredApps.get(grant.appId) ?? [];
        list.push(grant.permission);
        expiredApps.set(grant.appId, list);
      }
    }

    if (expiredApps.size === 0) return;

    await saveToStorage();

    if (typeof Notify !== 'undefined') {
      for (const [appId, perms] of expiredApps) {
        const appName = typeof AppRegistry !== 'undefined'
          ? (AppRegistry.getApp(appId)?.name ?? appId)
          : appId;
        Notify.show({
          title  : 'Permissions removed',
          body   : `${appName} hasn't been used in ${UNUSED_DAYS} days. ${perms.length} permission${perms.length > 1 ? 's' : ''} removed to protect your privacy.`,
          type   : 'info',
          appName: 'Privacy',
          icon   : 'shield',
        });
      }
    }

    console.log(`[AppPermissionManager] Swept ${expiredApps.size} unused app(s)`);
  }

  // Run the sweep at most once per day, deferred so it doesn't block init.
  // The last-sweep stamp is registry-backed (HKNS/security/meta/lastSweep);
  // the legacy localStorage key is the fallback when no engine is up.
  function scheduleSweep() {
    const runSoon = () => setTimeout(() => {
      sweepExpiredGrants().catch(e => console.error('[AppPermissionManager] sweep failed:', e));
    }, 5000);

    // Registry-backed stamp when the engine is up.
    if (typeof window !== 'undefined' && window.NovaRegistry && typeof RegistrySystemState !== 'undefined') {
      try {
        const last = RegistrySystemState.permLastSweep() || 0;
        if (Date.now() - last >= MS_PER_DAY) {
          RegistrySystemState.setPermLastSweep(Date.now());
          runSoon();
        }
        return;
      } catch (e) { /* fall back to the legacy channel */ }
    }

    const storage = getLocalStorage();
    if (!storage) return;
    const legacyLast = Number.parseInt(storage.getItem(SWEEP_KEY) ?? '0', 10);
    if (!Number.isNaN(legacyLast) && Date.now() - legacyLast < MS_PER_DAY) return;
    storage.setItem(SWEEP_KEY, String(Date.now()));
    runSoon();
  }

  // Initialization

  function initialize() {
    // Registry-first hydration (HKNS/security/appPermissions); the legacy
    // localStorage key is the pre-registry adoption source and fallback.
    let raw = null;
    const state = registryState();
    if (state && typeof state.appPermissions === 'function') {
      try {
        const fromRegistry = state.appPermissions();
        if (Array.isArray(fromRegistry) && fromRegistry.length > 0) raw = JSON.stringify(fromRegistry);
      } catch (_) { /* fall through to localStorage */ }
    }
    const storage = getLocalStorage();
    if (raw === null) {
      if (!storage) {
        console.warn('[AppPermissionManager] localStorage unavailable — in-memory only');
        return;
      }
      try { raw = storage.getItem(STORAGE_KEY); } catch (_) { raw = null; }
    }

    try {
      if (raw) {
        const parsed = JSON.parse(raw);
        const grants = Array.isArray(parsed) ? parsed : [];
        const normalized = [];
        let migratedLegacyIds = false;
        let rejected = 0;
        for (const grant of grants) {
          if (!isValidGrant(grant)) { rejected++; continue; }
          const legacyId = grant.appId;
          const canonicalId = window.NovaAppIdAliases?.canonicalize(legacyId) || legacyId;
          migratedLegacyIds ||= canonicalId !== legacyId;
          normalized.push({
            grant: canonicalId === legacyId ? grant : { ...grant, appId: canonicalId },
            isLegacy: canonicalId !== legacyId,
          });
        }
        normalized.sort((a, b) => Number(b.isLegacy) - Number(a.isLegacy));
        for (const { grant } of normalized) {
          permissionGrants.set(makeAppScopedKey(grant.appId, grant.permission), grant);
        }
        if (migratedLegacyIds) {
          try {
            persistGrants();
          } catch (error) {
            console.error('[AppPermissionManager] failed migrating legacy app IDs:', error);
          }
        }
        if (rejected > 0) {
          console.warn(`[AppPermissionManager] Discarded ${rejected} malformed grant(s)`);
        }
      }

      scheduleSweep();
      console.log('[AppPermissionManager] Initialized —', permissionGrants.size, 'grant(s) loaded');
    } catch (e) {
      if (e.name === 'SecurityError') {
        console.warn('[AppPermissionManager] localStorage denied (sandboxed) — in-memory only');
      } else if (e instanceof SyntaxError) {
        console.error('[AppPermissionManager] stored grants corrupted (invalid JSON) — starting fresh:', e);
      } else {
        console.error('[AppPermissionManager] initialize failed:', e);
      }
      permissionGrants = new Map();
    }
  }

  // Record app use (resets the 30-day clock)

  async function recordAppUse(appId) {
    assertValidAppId(appId);
    let dirty = false;
    const nowIso = new Date().toISOString();
    for (const grant of permissionGrants.values()) {
      if (grant.appId === appId) {
        grant.lastUsed = nowIso;
        dirty = true;
      }
    }
    if (dirty) await saveToStorage();
  }

  // Core permission checks

  // The trusted, system-signed Settings app (com.astroos.settings, verified
  // Astro System signer - see unrestricted-gate.js, the single identity
  // authority) is exempt from the grant table entirely, same principle as
  // the gate's own nova:system:* calls: a Settings app that manages every
  // other app's permissions "asking permission" to be a settings app is
  // incoherent. Every host-side isGranted() check (notifications, storage,
  // events, filesystem, system:info, system:apps, and the rest) passes for it, so
  // it ships with an empty permissions array and never prompts at all.
  // Identity is re-checked live on every call - a revoked or tampered
  // package loses this immediately, exactly like the gate's call-time
  // re-check.
  function isUnrestrictedSettingsApp(appId) {
    return typeof UnrestrictedGate !== 'undefined' &&
      typeof UnrestrictedGate.isTrustedSettingsAppById === 'function' &&
      UnrestrictedGate.isTrustedSettingsAppById(appId);
  }

  function isRootModeEnabled() {
    return typeof OS !== 'undefined'
      && OS.settings?.get?.('devMode') === true
      && OS.settings?.get?.('rootAccessEnabled') === true;
  }

  function isGranted(permission, appId) {
    if (isUnrestrictedSettingsApp(appId)) return true;
    if (permission === PERMISSION_TYPES.SYSTEM_ROOT && !isRootModeEnabled()) return false;
    const grant = permissionGrants.get(makeAppScopedKey(appId, permission));
    if (!grant) return false;
    if (grant.expiresAt && Date.parse(grant.expiresAt) < Date.now()) {
      permissionGrants.delete(makeAppScopedKey(appId, permission));
      // Detached: isGranted() stays synchronous for callers that need it
      // (e.g. render paths checking many permissions in a loop); the write
      // to storage happens in the background and any failure is logged
      // rather than thrown into an unrelated caller's stack.
      saveToStorage().catch(e => console.error('[AppPermissionManager] expiry save failed:', e));
      return false;
    }
    return grant.granted === true;
  }

  function isDenied(permission, appId) {
    if (isUnrestrictedSettingsApp(appId)) return false;
    const grant = permissionGrants.get(makeAppScopedKey(appId, permission));
    return grant?.granted === false;
  }

  async function resetPermission(permission, appId) {
    permissionGrants.delete(makeAppScopedKey(appId, permission));
    rateLimitState.delete(makeAppScopedKey(appId, permission));
    await saveToStorage();
    console.log(`[AppPermissionManager] Reset ${permission} → ${appId}`);
    if (permission === PERMISSION_TYPES.SYSTEM_ROOT && typeof AppSandbox !== 'undefined') {
      AppSandbox.reloadAfterRootRevocation?.(`Root permission for ${appId} was reset`);
    }
  }

  // Lets callers (e.g. the Permissions app) check/display cooldown status
  // without triggering a request.
  function isRateLimited(permission, appId) {
    const state = rateLimitState.get(makeAppScopedKey(appId, permission));
    if (!state) return { limited: false };
    const remaining = state.cooldownUntil - Date.now();
    return remaining > 0 ? { limited: true, retryAfterMs: remaining } : { limited: false };
  }

  // Rate-limit gate, called at the top of requestPermission(). Returns
  // { allowed: true } if this call may show a live dialog, or
  // { allowed: false, retryAfterMs } if it must be auto-denied silently
  // because the caller is bursting requests for this key.
  function checkRateLimit(permission, appId) {
    const key   = makeAppScopedKey(appId, permission);
    const now   = Date.now();
    const state = rateLimitState.get(key) ?? { attempts: [], cooldownUntil: 0, denialStreak: 0 };

    if (now < state.cooldownUntil) {
      rateLimitState.set(key, state);
      return { allowed: false, retryAfterMs: state.cooldownUntil - now };
    }

    state.attempts = state.attempts.filter(t => now - t < RATE_WINDOW_MS);
    state.attempts.push(now);

    if (state.attempts.length > RATE_MAX_BURST) {
      // Exponential backoff keyed off consecutive denials, so a
      // persistently pushy app gets throttled harder over time rather than
      // a flat delay. denialStreak is capped before exponentiation so the
      // math can't produce an absurd intermediate value even though
      // RATE_MAX_COOLDOWN_MS would clamp the end result anyway.
      const streak  = Math.min(state.denialStreak, RATE_MAX_DENIAL_STREAK);
      const backoff = Math.min(RATE_BASE_COOLDOWN_MS * 2 ** streak, RATE_MAX_COOLDOWN_MS);
      state.cooldownUntil = now + backoff;
      state.attempts = [];
      rateLimitState.set(key, state);
      return { allowed: false, retryAfterMs: backoff };
    }

    rateLimitState.set(key, state);
    return { allowed: true };
  }

  function recordRateLimitOutcome(permission, appId, granted) {
    const key   = makeAppScopedKey(appId, permission);
    const state = rateLimitState.get(key) ?? { attempts: [], cooldownUntil: 0, denialStreak: 0 };
    state.denialStreak = granted ? 0 : state.denialStreak + 1;
    rateLimitState.set(key, state);
  }

  // Single permission request

  async function requestPermission(permission, appId, options = {}) {
    // Translate legacy vfs:* names before any lookup — an app calling
    // nova:request-permission with a vfs:* name bypasses the registry
    // translation that happens at install time, so without this the dialog
    // shows a blank label and falls through to 'low' risk.
    permission = LEGACY_PERMISSION_ALIASES[permission] ?? permission;
    assertValidAppId(appId);
    if (PERMISSION_CATEGORIES[permission]?.specialAccess) return false;
    if (permission === PERMISSION_TYPES.SYSTEM_ROOT && !isRootModeEnabled()) return false;
    if (isGranted(permission, appId)) return true;

    // Previously denied grants no longer short-circuit here — every call
    // to requestPermission() shows the live dialog again, so the user gets
    // a fresh real-time choice each time an app asks. The persisted denial
    // record from persistDenial() is only used by isDenied() for callers
    // that want to check status without prompting.
    //
    // That re-prompt-every-time behavior is exactly what makes
    // prompt-bombing possible, so it's gated by the rate limiter above:
    // bursts beyond RATE_MAX_BURST within RATE_WINDOW_MS get auto-denied
    // (no dialog shown at all) with exponential backoff on repeat offenders.
    const gate = checkRateLimit(permission, appId);
    if (!gate.allowed) {
      console.warn(`[AppPermissionManager] Rate-limited ${permission} → ${appId} (retry in ${Math.ceil(gate.retryAfterMs / 1000)}s)`);
      if (typeof EventLog !== 'undefined') {
        EventLog.log({
          app: 'Permissions', category: 'permissions', severity: 'warn',
          message: `Rate-limited permission request ${permission} → ${appId}`,
          data: { appId, permission, action: 'rate-limited', retryAfterMs: gate.retryAfterMs },
        });
      }
      return false;
    }

    const appName = options.appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;
    const riskLevel = PERMISSION_CATEGORIES[permission]?.risk ?? 'low';
    const permanent = permission === PERMISSION_TYPES.SYSTEM_ROOT || options.permanent !== false;

    // What the dialog displays: the calling app's reason for THIS prompt if
    // it passed one (nova:request-permission), otherwise the manifest's
    // permissionReasons declaration for this permission, otherwise null —
    // the dialog renders the explicit no-reason-declared fallback for that
    // case. The same effective reason is stored on the grant so the
    // Settings/Permissions surfaces show why the app asked, not just that
    // it did.
    const effectiveReason = resolvePermissionReason(permission, appId, options.reason);

    const granted = await showPermissionDialog({
      permission, appId, appName, riskLevel,
      reason   : effectiveReason,
      permanent,
      current  : options.current ?? 1,
      total    : options.total ?? 1,
    });

    if (granted) {
      await persistGrant(permission, appId, {
        permanent,
        reason   : effectiveReason,
      });
    } else {
      await persistDenial(permission, appId);
    }
    recordRateLimitOutcome(permission, appId, granted);
    return granted;
  }

  // Sequential multi-permission queue

  async function requestAll(permissions, appId, appName) {
    if (!permissions?.length) return true;

    // Only skip permissions already granted — previously denied ones still
    // get a live re-prompt via requestPermission() below.
    const pending = permissions.filter(p =>
      !PERMISSION_CATEGORIES[p]?.specialAccess && !isGranted(p, appId)
    );
    if (!pending.length) return true;

    const resolvedName = appName
      ?? (typeof AppRegistry !== 'undefined' ? AppRegistry.getApp(appId)?.name : null)
      ?? appId;

    let allGranted = true;
    for (const [i, permission] of pending.entries()) {
      const granted = await requestPermission(permission, appId, {
        appName: resolvedName,
        current: i + 1,
        total  : pending.length,
      });
      if (!granted) allGranted = false;
    }
    return allGranted;
  }

  // Grant / revoke

  async function persistGrant(permission, appId, options = {}) {
    const key   = makeAppScopedKey(appId, permission);
    const nowIso = new Date().toISOString();
    const grant = {
      appId,
      permission,
      granted   : true,
      grantedAt : nowIso,
      grantedBy : options.grantedBy || 'user',
      permanent : options.permanent !== false,
      expiresAt : options.permanent === false
        ? new Date(Date.now() + MS_PER_DAY).toISOString()
        : null,
      reason    : options.reason ?? null,
      lastUsed  : nowIso,
    };
    permissionGrants.set(key, grant);
    await saveToStorage();
    consentLog.push({ ...grant, timestamp: nowIso });
    console.log(`[AppPermissionManager] Granted ${permission} → ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'info', message: `Granted ${permission} → ${appId}`, data: { appId, permission, action: 'grant' } });
    }
  }

  async function persistDenial(permission, appId) {
    const key   = makeAppScopedKey(appId, permission);
    const nowIso = new Date().toISOString();
    const grant = {
      appId,
      permission,
      granted   : false,
      grantedAt : nowIso,
      grantedBy : 'user',
      permanent : true,
      expiresAt : null,
      reason    : 'User denied',
      lastUsed  : nowIso,
    };
    permissionGrants.set(key, grant);
    await saveToStorage();
    console.log(`[AppPermissionManager] Denied ${permission} → ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'warn', message: `Denied ${permission} → ${appId}`, data: { appId, permission, action: 'deny' } });
    }
  }

  async function grantPermission(permission, appId, options = {}) {
    assertValidAppId(appId);
    if (permission === PERMISSION_TYPES.SYSTEM_ROOT) {
      throw new Error('Root access must be granted through its explicit confirmation prompt');
    }
    await persistGrant(permission, appId, options);
  }

  async function autoGrantLowRisk(permission, appId) {
    assertValidAppId(appId);
    if (PERMISSION_CATEGORIES[permission]?.risk !== 'low' || isDenied(permission, appId)) return false;
    if (isGranted(permission, appId)) return true;
    await persistGrant(permission, appId, {
      permanent: true,
      reason: 'Low-risk permission auto-granted by system policy',
      grantedBy: 'system-policy',
    });
    return true;
  }

  async function revokePermission(permission, appId) {
    assertValidAppId(appId);
    // Keep an explicit denial so launch-time low-risk auto-grants cannot
    // silently undo the user's choice. resetPermission() clears it to pending.
    await persistDenial(permission, appId);
    if (typeof AppSandbox !== 'undefined') {
      if (permission === PERMISSION_TYPES.SYSTEM_ROOT) {
        AppSandbox.reloadAfterRootRevocation?.(`Root permission for ${appId} was revoked`);
      }
      // Active guest contexts cannot retroactively lose security capabilities.
      AppSandbox.handlePermissionRevoked?.(permission, appId);
    }
  }

  async function revokeAllPermissions(appId) {
    assertValidAppId(appId);
    const rootGrantExists = permissionGrants.has(makeAppScopedKey(appId, PERMISSION_TYPES.SYSTEM_ROOT));
    const sameOriginGrantExists = permissionGrants.has(makeAppScopedKey(appId, PERMISSION_TYPES.SANDBOX_SAME_ORIGIN));
    const nestedWebviewGrantExists = permissionGrants.has(makeAppScopedKey(appId, PERMISSION_TYPES.SANDBOX_NESTED_WEBVIEW));
    const prefix = makeAppScopedKey(appId, '');
    let count = 0;
    for (const key of permissionGrants.keys()) {
      if (key.startsWith(prefix)) { permissionGrants.delete(key); count++; }
    }
    for (const key of rateLimitState.keys()) {
      if (key.startsWith(prefix)) rateLimitState.delete(key);
    }
    await saveToStorage();
    if (typeof AppSandbox !== 'undefined') {
      if (rootGrantExists) {
        AppSandbox.reloadAfterRootRevocation?.(`All permissions for ${appId} were revoked`);
      }
      if (sameOriginGrantExists) {
        AppSandbox.handlePermissionRevoked?.(PERMISSION_TYPES.SANDBOX_SAME_ORIGIN, appId);
      }
      if (nestedWebviewGrantExists) {
        AppSandbox.handlePermissionRevoked?.(PERMISSION_TYPES.SANDBOX_NESTED_WEBVIEW, appId);
      }
    }
    console.log(`[AppPermissionManager] Revoked all permissions for ${appId}`);
    if (typeof EventLog !== 'undefined') {
      EventLog.log({ app: 'Permissions', category: 'permissions', severity: 'info', message: `Revoked all ${count} permission(s) for ${appId}`, data: { appId, count, action: 'revoke-all' } });
    }
  }

  // Queries

  function getAppPermissions(appId) {
    return [...permissionGrants.values()].filter(g => g.appId === appId);
  }

  function getConsentLog() {
    return [...consentLog];
  }

  function getStats() {
    const grants = [...permissionGrants.values()];
    const byCategory = new Map();
    const byRisk = new Map();
    for (const g of grants) {
      const meta = PERMISSION_CATEGORIES[g.permission];
      const cat  = meta?.category ?? 'other';
      const risk = meta?.risk ?? 'low';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      byRisk.set(risk, (byRisk.get(risk) ?? 0) + 1);
    }
    return {
      totalGrants: grants.length,
      byCategory : Object.fromEntries(byCategory),
      byRisk     : Object.fromEntries(byRisk),
    };
  }

  // Dialog UI
  //
  // Built with DOM APIs rather than innerHTML template strings. appName and
  // reason both ultimately come from an app's own manifest/call site —
  // untrusted third-party input per the sandboxing model this file is part
  // of — so every piece of dynamic text is set via textContent, never
  // parsed as markup.

  const RISK_COLORS = Object.freeze({
    low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149',
  });

  const RISK_ICONS = Object.freeze({
    low: '✅', medium: '🛡', high: '🔒', critical: '⚠',
  });

  function ensureDialogStylesInjected() {
    if (document.getElementById('_apm_styles')) return;
    const style = document.createElement('style');
    style.id = '_apm_styles';
    style.textContent = '@keyframes _apm_fadein{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}';
    document.head.appendChild(style);
  }

  function el(tag, { style, text, attrs } = {}) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text != null) node.textContent = text;
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  }

  function buildPagerRow(current, total) {
    const row = el('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;',
    });
    row.append(el('span', {
      style: 'font-size:11px;color:#8b949e;letter-spacing:.05em;text-transform:uppercase;',
      text : `Permission ${current} of ${total}`,
    }));
    const dots = el('div', { style: 'display:flex;gap:4px;' });
    for (let i = 0; i < total; i++) {
      dots.append(el('div', {
        style: `width:6px;height:6px;border-radius:50%;background:${i < current ? '#58a6ff' : 'rgba(255,255,255,0.15)'}`,
      }));
    }
    row.append(dots);
    return row;
  }

  function buildHeaderRow({ label, appName, riskColor, riskIcon }) {
    const row = el('div', {
      style: 'display:flex;align-items:center;gap:12px;margin-bottom:18px;',
    });
    row.append(el('div', {
      style: `width:44px;height:44px;border-radius:10px;flex-shrink:0;background:${riskColor}1a;display:flex;align-items:center;justify-content:center;font-size:22px;`,
      text : riskIcon,
    }));

    const textCol = el('div');
    textCol.append(el('h3', {
      style: 'color:#e6edf3;font-size:15px;margin:0 0 2px;',
      text : label,
    }));
    const requestedBy = el('p', { style: 'color:#8b949e;font-size:12px;margin:0;' });
    requestedBy.append(document.createTextNode('Requested by '));
    requestedBy.append(el('strong', { style: 'color:#c9d1d9', text: appName }));
    textCol.append(requestedBy);
    row.append(textCol);
    return row;
  }

  function buildReasonBlock(reason, riskColor) {
    return el('p', {
      style: `color:#8b949e;font-size:13px;margin:0 0 14px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:3px solid ${riskColor}40;`,
      text : reason,
    });
  }

  // Shown when neither the request call site nor the manifest's
  // permissionReasons declared a reason for this permission. Visually
  // quieter than buildReasonBlock (dimmer text, no risk-color accent) so
  // the absence reads as information, not as a rendering gap.
  function buildNoReasonBlock() {
    return el('p', {
      style: 'color:#6e7681;font-size:12px;font-style:italic;margin:0 0 14px;padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:8px;border-left:3px solid rgba(255,255,255,0.12);',
      text : 'This app declared no reason why it needs this permission.',
    });
  }

  function buildRiskRow({ riskLevel, riskColor, category }) {
    const row = el('div', {
      style: 'display:flex;align-items:center;gap:8px;margin-bottom:18px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;',
    });
    row.append(el('span', {
      style: 'font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.05em;',
      text : 'Risk',
    }));
    row.append(el('span', {
      style: `font-size:12px;font-weight:600;color:${riskColor};`,
      text : riskLevel.toUpperCase(),
    }));
    row.append(el('span', { style: 'color:rgba(255,255,255,0.15);margin:0 2px;', text: '·' }));
    row.append(el('span', { style: 'font-size:12px;color:#8b949e;', text: category }));
    return row;
  }

  function buildButtonRow() {
    const row = el('div', { style: 'display:flex;gap:10px;' });
    const denyBtn = el('button', {
      style: 'flex:1;padding:11px 16px;border:1px solid rgba(255,255,255,0.12);border-radius:9px;background:transparent;color:#8b949e;font-size:14px;cursor:pointer;transition:border-color .15s,color .15s;',
      text : 'Deny',
      attrs: { type: 'button', 'data-action': 'deny' },
    });
    const grantBtn = el('button', {
      style: 'flex:1;padding:11px 16px;border:none;border-radius:9px;background:#58a6ff;color:#0d1117;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;',
      text : 'Allow',
      attrs: { type: 'button', 'data-action': 'grant' },
    });
    row.append(denyBtn, grantBtn);
    return { row, denyBtn, grantBtn };
  }

  function showPermissionDialog(opts) {
    if (typeof document === 'undefined' || !document.body) {
      console.warn(`[AppPermissionManager] Permission dialog unavailable for ${opts?.permission}; denying request`);
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const { permission, appName, riskLevel, reason, current, total } = opts;
      const riskColor = RISK_COLORS[riskLevel] ?? RISK_COLORS.low;
      const riskIcon  = RISK_ICONS[riskLevel] ?? RISK_ICONS.low;
      const meta      = PERMISSION_CATEGORIES[permission];
      const label     = meta?.label ?? permission;
      const category  = meta?.category ?? 'general';
      const isRootRequest = permission === PERMISSION_TYPES.SYSTEM_ROOT;

      ensureDialogStylesInjected();

      const overlay = el('div', {
        style: 'position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:100000;backdrop-filter:blur(6px);animation:_apm_fadein 0.15s ease;',
      });

      const card = el('div', {
        style: `background:#0e121c;border:1px solid ${isRootRequest ? '#f85149' : 'rgba(255,255,255,0.1)'};border-radius:14px;padding:24px;max-width:460px;width:90%;box-shadow:0 32px 80px rgba(0,0,0,0.7);animation:_apm_fadein 0.18s ease;`,
      });

      if (total > 1) card.append(buildPagerRow(current, total));
      card.append(buildHeaderRow({ label, appName, riskColor, riskIcon }));
      // Always a reason block: the declared reason when there is one, the
      // explicit fallback otherwise — a silent gap would leave users
      // guessing whether the developer simply never said why.
      card.append(reason ? buildReasonBlock(reason, riskColor) : buildNoReasonBlock());
      card.append(buildRiskRow({ riskLevel, riskColor, category }));

      const { row: buttonRow, denyBtn, grantBtn } = buildButtonRow();
      if (isRootRequest) {
        const warning = el('div', {
          style: 'border:1px solid rgba(248,81,73,.45);background:rgba(248,81,73,.09);border-radius:10px;padding:14px;margin:0 0 16px;',
        });
        warning.append(
          el('strong', {
            style: 'display:block;color:#ff7b72;font-size:14px;margin-bottom:8px;',
            text: 'This app will run inside the OS, not in its sandbox.',
          }),
          el('p', {
            style: 'color:#e6edf3;font-size:12px;line-height:1.55;margin:0 0 12px;',
            text: `${appName} may read or change OS data, manipulate system UI, and access host-page APIs. Root API calls are recorded, but direct JavaScript and browser activity cannot be completely observed.`,
          })
        );
        const acknowledgement = el('label', {
          style: 'display:flex;align-items:flex-start;gap:9px;color:#e6edf3;font-size:12px;line-height:1.45;cursor:pointer;',
        });
        const checkbox = el('input', { attrs: { type: 'checkbox' } });
        checkbox.style.cssText = 'margin:2px 0 0;flex:none;';
        acknowledgement.append(checkbox, document.createTextNode('I understand this app can access and change the OS outside its sandbox.'));
        warning.appendChild(acknowledgement);
        grantBtn.disabled = true;
        grantBtn.textContent = 'Grant Root Access';
        grantBtn.style.cssText = 'flex:1;padding:11px 16px;border:none;border-radius:9px;background:#b42318;color:#fff;font-size:14px;font-weight:700;opacity:.65;cursor:not-allowed;';
        checkbox.addEventListener('change', () => {
          grantBtn.disabled = !checkbox.checked;
          grantBtn.style.opacity = checkbox.checked ? '1' : '.65';
          grantBtn.style.cursor = checkbox.checked ? 'pointer' : 'not-allowed';
        });
        card.append(warning);
      }
      card.append(buttonRow);
      overlay.append(card);
      document.body.append(overlay);

      const controller = new AbortController();
      let settled = false;

      function settle(result) {
        if (settled) return;
        settled = true;
        controller.abort();
        openDialogs.delete(forceClose);
        try {
          overlay.remove();
        } catch {
          // overlay already detached (e.g. host shell cleared the DOM) — fine
        }
        resolve(result);
      }

      // Registered so an external caller (or a future host-shell teardown
      // path) can force this dialog closed instead of leaving
      // requestPermission() — and anything awaiting it, like requestAll() —
      // hung forever if the overlay disappears from under us some other way.
      function forceClose() {
        settle(false);
      }
      openDialogs.add(forceClose);

      denyBtn.addEventListener('click', () => settle(false), { signal: controller.signal });
      grantBtn.addEventListener('click', () => settle(true), { signal: controller.signal });

      denyBtn.addEventListener('mouseenter', () => {
        denyBtn.style.borderColor = '#58a6ff';
        denyBtn.style.color = '#58a6ff';
      }, { signal: controller.signal });
      denyBtn.addEventListener('mouseleave', () => {
        denyBtn.style.borderColor = 'rgba(255,255,255,0.12)';
        denyBtn.style.color = '#8b949e';
      }, { signal: controller.signal });
      grantBtn.addEventListener('mouseenter', () => {
        grantBtn.style.background = isRootRequest ? '#da3633' : '#79b8ff';
      }, { signal: controller.signal });
      grantBtn.addEventListener('mouseleave', () => {
        grantBtn.style.background = isRootRequest ? '#b42318' : '#58a6ff';
      }, { signal: controller.signal });

      // Keyboard: Enter = grant, Escape = deny. Bound to document (not the
      // dialog) to match the original behavior of working regardless of
      // focus, but torn down via the same AbortController as every other
      // listener here — the previous version's version of this handler
      // was the one listener that didn't get cleaned up on a mouse-click
      // dismissal, since it removed itself only from inside its own
      // Enter/Escape branches.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !grantBtn.disabled) { e.preventDefault(); settle(true); }
        if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      }, { signal: controller.signal });
    });
  }

  // Force-closes every currently open permission dialog, resolving each as
  // a denial. Exists so a host-level teardown (route change, logout, app
  // force-quit) can guarantee no dialog — and nothing awaiting it — is left
  // hanging, without needing to know about this module's internals.
  function closeAllDialogs() {
    for (const forceClose of [...openDialogs]) forceClose();
  }

  // Public API

  return {
    initialize,
    isGranted,
    isDenied,
    isRateLimited,
    resetPermission,
    requestPermission,
    requestAll,
    grantPermission,
    autoGrantLowRisk,
    revokePermission,
    revokeAllPermissions,
    recordAppUse,
    getAppPermissions,
    getConsentLog,
    getStats,
    closeAllDialogs,
    resolvePermissionReason,
    PERMISSION_TYPES,
    PERMISSION_CATEGORIES,
    LEGACY_PERMISSION_ALIASES,
    MAX_REASON_LENGTH,
  };
})();

window.AppPermissionManager = AppPermissionManager;

// Auto-initialize
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AppPermissionManager.initialize());
  } else {
    AppPermissionManager.initialize();
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = AppPermissionManager;