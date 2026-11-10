// NovaReg — AstroOS Registry Editor
//
// Dev-mode-only system app. Runs unrestricted in the OS page (same pattern
// as Console/devconsole), so it talks to window.NovaRegistry directly
// instead of going through the sandbox bridge. Sandboxed apps get the same
// store through nova:reg:* under the registry.* permission model; this
// editor is the trusted glass over it.
//
// regedit parity in this file: the pinned "(Default)" row, Ctrl+F search
// over keys/value names/data, favorites, rename (F2), copy path, a hex
// viewer for REG_BINARY, a dec/hex radix toggle for DWORD/QWORD, jump
// history, a Permissions dialog over the engine's ACLs, the write-audit
// panel, and hive snapshots (take/restore/delete — the engine already
// snapshots every boot).

// ── friendly names for well-known paths ────────────────────────────────
// The editor keeps raw paths everywhere (regedit parity); this catalog adds
// the plain-language layer on top: an info strip under the values header,
// plus tooltips in the tree and the find dialog. Paths outside the catalog
// still resolve: HKNA/<appId> and HKNU/software/<appId> take their display
// name from the installed-app inventory (HKNS/apps/installed), and
// HKNU/settings/<key> humanizes the camelCase setting name — so
// third-party config gets a friendly name too.
const KEY_INFO = [
  // ── hives ──
  { path: 'HKNS', label: 'System (machine)', description: 'Machine-wide configuration that applies to every user.' },
  { path: 'HKNU', label: 'Current user', description: 'Per-user preferences and shell state.' },
  { path: 'HKNA', label: 'Per-app config', description: 'One subtree per installed app — its supported config surface.' },
  { path: 'HKND', label: 'Developer scratch', description: 'Dev-only hive; wiped in production builds.' },
  // ── HKNS ──
  { path: 'HKNS/shell', label: 'Shell look & feel', description: 'Theme, accent color and wallpaper the desktop renders.' },
  { path: 'HKNS/shell/theme', label: 'Desktop theme' },
  { path: 'HKNS/shell/accentColor', label: 'Accent color' },
  { path: 'HKNS/shell/wallpaper', label: 'Desktop wallpaper' },
  { path: 'HKNS/system', label: 'System state', description: 'OS version, Developer Mode flag and boot machine state.' },
  { path: 'HKNS/system/devMode', label: 'Developer Mode' },
  { path: 'HKNS/system/osVersion', label: 'OS version' },
  { path: 'HKNS/system/boot', label: 'Boot machine state', description: 'Safe-mode and recovery flags consumed by the next boot (Windows: HKLM\\SYSTEM\\CurrentControlSet\\Control\\SafeBoot).' },
  { path: 'HKNS/system/boot/safeMode', label: 'Boot into safe mode next start' },
  { path: 'HKNS/system/boot/forceRecovery', label: 'Force recovery on next boot', description: 'Set by the boot watchdog when the machine hangs.' },
  { path: 'HKNS/system/boot/manualRecovery', label: 'Manual recovery requested', description: 'Set by Settings > Boot to Recovery.' },
  { path: 'HKNS/system/boot/showRecovery', label: 'Show recovery menu next boot' },
  { path: 'HKNS/system/boot/attempts', label: 'Recent boot attempts', description: 'Cleared automatically once subsystems come up cleanly.' },
  { path: 'HKNS/system/boot/timeoutFlag', label: 'Boot watchdog state' },
  { path: 'HKNS/system/boot/homeLaunchPending', label: 'Home app launch in progress', description: 'Handoff id; a stale id resets the default Home app.' },
  { path: 'HKNS/env', label: 'Environment', description: 'Where AstroOS keeps its data.' },
  { path: 'HKNS/env/novaRoot', label: 'Nova root' },
  { path: 'HKNS/settings', label: 'System settings', description: 'Machine-scoped settings mirrors (settings shim).' },
  { path: 'HKNS/security', label: 'Security & policy', description: 'Credentials, permission grants and machine policy.' },
  { path: 'HKNS/security/policy', label: 'Machine policy', description: 'Restrictions applied to every user.' },
  { path: 'HKNS/security/policy/prohibitWallpaperChange', label: 'Prohibit wallpaper changes' },
  { path: 'HKNS/security/appPermissions', label: 'App permission grants' },
  { path: 'HKNS/security/meta', label: 'Security bookkeeping' },
  { path: 'HKNS/security/meta/lastSweep', label: 'Last permission sweep', description: 'The unused-permission sweeper runs at most once a day.' },
  { path: 'HKNS/security/bootPassword', label: 'Boot password' },
  { path: 'HKNS/security/lockPin', label: 'Screen-lock PIN' },
  { path: 'HKNS/security/pinSalt', label: 'Lock PIN salt' },
  { path: 'HKNS/security/biometricCredentialId', label: 'Biometric credential' },
  { path: 'HKNS/security/rootAccessEnabled', label: 'Root access' },
  { path: 'HKNS/apps', label: 'Applications', description: 'Machine-scoped app services: inventory, alarms, push, store.' },
  { path: 'HKNS/apps/installed', label: 'Installed app inventory' },
  { path: 'HKNS/apps/alarms', label: 'Background alarm registry' },
  { path: 'HKNS/apps/push', label: 'Push tokens + replay queues' },
  { path: 'HKNS/apps/pushDeviceId', label: 'Push device id' },
  { path: 'HKNS/apps/store', label: 'App Store service' },
  { path: 'HKNS/apps/store/updateIntervalMinutes', label: 'Store update-check interval' },
  { path: 'HKNS/apps/store/lastNotifiedAt', label: 'Update notifications sent', description: 'Per-app record of which version the user was already told about.' },
  { path: 'HKNS/apps/webapps', label: 'Installed web apps', description: 'PWA/web-app package payload for the web-app manager.' },
  { path: 'HKNS/apps/builtin', label: 'Built-in app cache', description: 'AppRegistry records for the built-in apps.' },
  { path: 'HKNS/apps/share', label: 'Share service' },
  { path: 'HKNS/apps/share/inbound', label: 'Inbound share queue', description: 'Handoff entries waiting for a closed share target to reopen.' },
  // ── HKNU ──
  { path: 'HKNU/desktop', label: 'User desktop' },
  { path: 'HKNU/desktop/pins', label: 'Pinned desktop apps' },
  { path: 'HKNU/shell', label: 'User shell prefs' },
  { path: 'HKNU/shell/bags', label: 'Shell Bags', description: 'Explorer-\"Bags\"-style remembers: window placement and folder view state.' },
  { path: 'HKNU/shell/bags/windows', label: 'Window placement', description: 'Last on-screen geometry per app, restored on the next open.' },
  { path: 'HKNU/shell/bags/files', label: 'Files view state', description: 'View mode and sort order the Files app reopens with.' },
  { path: 'HKNU/shell/defaultApps', label: 'Default apps', description: 'File-type associations — which app opens what.' },
  { path: 'HKNU/shell/notifications', label: 'Notification channels' },
  { path: 'HKNU/shell/notifications/channels', label: 'Channel definitions' },
  { path: 'HKNU/shell/notifications/channelOverrides', label: 'Per-app channel overrides' },
  { path: 'HKNU/shell/shortcuts', label: 'Keyboard shortcuts' },
  { path: 'HKNU/settings', label: 'User settings', description: 'The Settings app store — mirrored live to OS.settings.' },
  { path: 'HKNU/apps', label: 'Per-user app state' },
  { path: 'HKNU/apps/disabled', label: 'Disabled apps' },
  { path: 'HKNU/apps/boot', label: 'Auto-start apps' },
  { path: 'HKNU/apps/showHidden', label: 'Show hidden apps' },
  { path: 'HKNU/legacy', label: 'Legacy settings snapshot', description: 'Forensic copy from the pre-registry era — safe to ignore.' },
  // ── HKND ──
  { path: 'HKND/_migration', label: 'Migration markers', description: 'One-time adoption guards — resetting one re-adopts legacy data.' },
  { path: 'HKND/_migration/registrySourceDone', label: 'Legacy settings adopted' },
  { path: 'HKND/_migration/sysStateDone', label: 'System state adopted' },
  { path: 'HKND/_migration/appConfig', label: 'App configs adopted' },
  { path: 'HKND/_migration/prefsDone', label: 'Registry prefs adopted' },
  { path: 'HKND/_migration/legacySettingsDone', label: 'Legacy snapshot written' },
  { path: 'HKND/_migration/bootFlags', label: 'Boot flags adopted' },
  { path: 'HKND/_migration/permsBootstrapped', label: 'Permissions seeded', description: 'First-boot normal-permission pre-grant already ran.' },
  { path: 'HKND/events', label: 'Events app config' },
  { path: 'HKND/events/filters', label: 'Events — saved filters' },
  { path: 'HKND/events/views', label: 'Events — saved views' },
  { path: 'HKND/events/alerts', label: 'Events — alert rules' },
  { path: 'HKND/events/sessions', label: 'Events — session history' },
  { path: 'HKND/console', label: 'Dev Console' },
  { path: 'HKND/console/history', label: 'Console command history' },
  { path: 'HKND/appmanager', label: 'App Manager' },
  { path: 'HKND/appmanager/log', label: 'App install log' },
  { path: 'HKND/com.astroos.permissions/logCutoff', label: 'Consent-log cutoff', description: 'Client-side timestamp hiding consent-log entries before it.' },
  { path: 'HKND/overlay', label: 'Debug overlay' },
  { path: 'HKND/overlay/position', label: 'Debug overlay position' },
  { path: 'HKND/com.astroos.novareg', label: 'NovaReg editor state', description: "This editor's favorites and jump history." },
];

function humanizeSettingName(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

// Resolve the friendly name for a key path. `resolveAppName` (optional) maps
// an app id to a display name; NovaReg passes the installed-inventory lookup.
// Specific resolvers win over generic inheritance: HKNA/<appId>,
// HKNU/software/<appId> and HKNU/settings/<key> resolve dynamically even
// though their parents are cataloged; everything else takes the longest
// matching catalog prefix, and a path below a catalog entry renders as
// "<entry label> → <rest>" so children inherit a sensible name.
function keyInfo(path, resolveAppName) {
  if (typeof path !== 'string' || !path) return null;
  const seg = path.split('/');
  if (seg[0] === 'HKNU' && seg[1] === 'software') {
    const appName = seg[2] && resolveAppName ? resolveAppName(seg[2]) : null;
    const root = !seg[2] ? 'App user data'
      : appName ? 'App user data — ' + appName
      : 'App user data (' + seg[2] + ')';
    const label = seg.length > 3 ? root + ' → ' + seg.slice(3).join(' / ') : root;
    return { label, description: "The app's user-scoped slice (the default registryScopes.write area)." };
  }
  if (seg[0] === 'HKNA' && seg[1]) {
    const appName = resolveAppName ? resolveAppName(seg[1]) : null;
    const root = appName ? 'App config — ' + appName : 'App config (' + seg[1] + ')';
    return {
      label: seg.length > 2 ? root + ' → ' + seg.slice(2).join(' / ') : root,
      description: "The app's own config subtree — persists across updates and is visible here to the user.",
    };
  }
  if (seg[0] === 'HKNU' && seg[1] === 'settings' && seg[2]) {
    return { label: humanizeSettingName(seg.slice(2).join(' ')), description: 'User setting (Settings app mirror).' };
  }
  let best = null;
  for (const entry of KEY_INFO) {
    if (path === entry.path || path.startsWith(entry.path + '/')) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  if (best) {
    if (best.path === path) return { label: best.label, description: best.description || '' };
    const rest = path.slice(best.path.length + 1);
    return { label: best.label + ' → ' + rest.split('/').join(' / '), description: best.description || '' };
  }
  return null;
}

registerApp({
  id: 'com.astroos.novareg',
  name: 'NovaReg',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJOb3ZhUmVnIGljb24iPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJkYiIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiM3ZGQzZmMiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIwLjU1IiBzdG9wLWNvbG9yPSIjMzhiZGY4Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzI1NjNlYiIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iZGJUb3AiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjYmFlNmZkIi8+CiAgICAgIDxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzdkZDNmYyIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ia2V5IiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iI2ZkZTY4YSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmNTllMGIiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8ZmlsdGVyIGlkPSJkcyIgeD0iLTMwJSIgeT0iLTMwJSIgd2lkdGg9IjE2MCUiIGhlaWdodD0iMTYwJSI+CiAgICAgIDxmZURyb3BTaGFkb3cgZHg9IjAiIGR5PSI2IiBzdGREZXZpYXRpb249IjgiIGZsb29kLWNvbG9yPSIjMDAwMDAwIiBmbG9vZC1vcGFjaXR5PSIwLjQ1Ii8+CiAgICA8L2ZpbHRlcj4KICA8L2RlZnM+CgogIDwhLS0gYmFja2dyb3VuZCAtLT4KICA8cmVjdCB4PSIxNiIgeT0iMTYiIHdpZHRoPSI0ODAiIGhlaWdodD0iNDgwIiByeD0iMTEyIiBmaWxsPSJ1cmwoI2JnKSIvPgoKICA8IS0tIGZhaW50IE4gbW9ub2dyYW0gLS0+CiAgPHRleHQgeD0iMjU2IiB5PSIzMzAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJBcmlhbCwgSGVsdmV0aWNhLCBzYW5zLXNlcmlmIgogICAgICAgIGZvbnQtc2l6ZT0iMzYwIiBmb250LXdlaWdodD0iODAwIiBmaWxsPSIjMzhiZGY4IiBvcGFjaXR5PSIwLjA3Ij5OPC90ZXh0PgoKICA8IS0tIHJlZ2lzdHJ5IGRhdGFiYXNlIGN5bGluZGVyIC0tPgogIDxnIGZpbHRlcj0idXJsKCNkcykiPgogICAgPHBhdGggZD0iTTExMCAxNjggdjE3NiBhMTIyIDQ0IDAgMCAwIDI0NCAwIHYtMTc2IHoiIGZpbGw9InVybCgjZGIpIi8+CiAgICA8cGF0aCBkPSJNMTEwIDI1MiBhMTIyIDQ0IDAgMCAwIDI0NCAwIiBmaWxsPSJub25lIiBzdHJva2U9IiMxZTNhOGEiIHN0cm9rZS13aWR0aD0iMTAiIG9wYWNpdHk9IjAuNDUiLz4KICAgIDxwYXRoIGQ9Ik0xMTAgMzIyIGExMjIgNDQgMCAwIDAgMjQ0IDAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzFlM2E4YSIgc3Ryb2tlLXdpZHRoPSIxMCIgb3BhY2l0eT0iMC40NSIvPgogICAgPGVsbGlwc2UgY3g9IjIzMiIgY3k9IjE2OCIgcng9IjEyMiIgcnk9IjQ0IiBmaWxsPSJ1cmwoI2RiVG9wKSIvPgogICAgPGVsbGlwc2UgY3g9IjIzMiIgY3k9IjE2OCIgcng9Ijg0IiByeT0iMjciIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzI1NjNlYiIgc3Ryb2tlLXdpZHRoPSI4IiBvcGFjaXR5PSIwLjU1Ii8+CiAgPC9nPgoKICA8IS0tIGtleSAtLT4KICA8ZyBmaWx0ZXI9InVybCgjZHMpIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMzAgMzQ0KSByb3RhdGUoLTQyKSI+CiAgICA8Y2lyY2xlIGN4PSIwIiBjeT0iMCIgcj0iMzQiIGZpbGw9Im5vbmUiIHN0cm9rZT0idXJsKCNrZXkpIiBzdHJva2Utd2lkdGg9IjI0Ii8+CiAgICA8cmVjdCB4PSIzNCIgeT0iLTEyIiB3aWR0aD0iMTUyIiBoZWlnaHQ9IjI0IiByeD0iMTIiIGZpbGw9InVybCgja2V5KSIvPgogICAgPHJlY3QgeD0iMTI4IiB5PSIxMCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjM2IiByeD0iNyIgZmlsbD0idXJsKCNrZXkpIi8+CiAgICA8cmVjdCB4PSIxNjQiIHk9IjEwIiB3aWR0aD0iMjIiIGhlaWdodD0iMjgiIHJ4PSI3IiBmaWxsPSJ1cmwoI2tleSkiLz4KICA8L2c+Cjwvc3ZnPgo=',
  description: 'Edit the AstroOS Registry',
  category: 'developer',
  version: '1.2.0',
  devOnly: true,
  defaultSize: [960, 600],
  minSize: [640, 420],

  init(content, state, options) {
    if (!window.NovaRegistry || typeof window.NovaRegistry.get !== 'function') {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:14px;text-align:center">AstroOS Registry engine not available.<br>This app requires AstroOS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use NovaReg.</div>';
      return;
    }

    const Reg = window.NovaRegistry;
    const SELF = 'com.astroos.novareg';
    const DEV_KEY = (name) => 'HKND/' + SELF + '/' + name;
    const ac = new AbortController();

    const HIVES = Reg.HIVES || ['HKNS', 'HKNU', 'HKNA', 'HKND'];
    const TYPES = Reg.VALUE_TYPES || ['REG_SZ', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_BOOL', 'REG_DWORD', 'REG_QWORD', 'REG_JSON', 'REG_BINARY'];
    const DEFAULT_NAME = Reg.DEFAULT_VALUE_NAME || '(default)';

    // Editor state — selectedPath is the KEY path highlighted in the tree
    // (a hive root at minimum); selectedValue is a value name in the table
    // (or DEFAULT_NAME for the pinned (Default) row).
    let selectedPath = 'HKNS';
    let selectedValue = null;
    let expanded = { HKNS: true };     // key path -> bool
    let treeCache = {};                // key path -> { keys: [...], values: {...} }
    let statusMessage = 'NovaReg ready.';
    let filterText = '';
    let auditVisible = false;
    let dwordRadix = 10;               // 10 | 16 — editor radix for DWORD/QWORD

    // Editor scratch state (favorites, jump history) lives in the HKND dev
    // hive so it survives restarts but never ships in prod builds.
    function devLoad(name, fallback) {
      try {
        const value = Reg.get(DEV_KEY(name));
        return value === undefined ? fallback : value;
      } catch (_) { return fallback; }
    }
    function devSave(name, value) {
      try { Reg.set(DEV_KEY(name), value, { type: 'REG_JSON', actor: SELF }); } catch (_) {}
    }
    let favorites = devLoad('favorites', []);   // [{ path }]
    let jumpHistory = devLoad('history', []);   // [path]

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);font-size:12px;box-sizing:border-box;overflow:hidden;';

    // ── helpers ────────────────────────────────────────────────────────
    const el = (tag, style, text) => {
      const node = document.createElement(tag);
      if (style) node.style.cssText = style;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    function setStatus(message) {
      statusMessage = message;
      const where = selectedPath + (selectedValue ? '  ·  value: ' + selectedValue : '');
      statusBar.textContent = where + '  —  ' + statusMessage;
    }

    function keyOf(path) { return path.split('/').slice(0, -1).join('/') || path.split('/')[0]; }
    function errorMessage(err) { return (err && err.message) ? err.message : String(err); }

    // Display names for HKNA/<appId> and HKNU/software/<appId> come from the
    // installed-app inventory (HKNS/apps/installed); cached until a registry
    // change invalidates it. Everything else resolves through the static
    // keyInfo catalog at the top of this file.
    let inventoryCache = null;
    function appDisplayName(appId) {
      if (!inventoryCache) {
        let installed = null;
        try { installed = Reg.get('HKNS/apps/installed'); } catch (_) { /* unreadable — fall through */ }
        inventoryCache = Array.isArray(installed) ? installed : [];
      }
      const hit = inventoryCache.find((app) => app && app.id === appId);
      return (hit && typeof hit.name === 'string' && hit.name) || null;
    }
    function infoOf(path) { return keyInfo(path, appDisplayName); }

    function rememberJump(path) {
      jumpHistory = jumpHistory.filter((p) => p !== path).concat([path]).slice(-20);
      devSave('history', jumpHistory);
      renderHistoryDatalist();
    }

    function pushFavorite(path) {
      if (favorites.some((f) => f.path === path)) return;
      favorites.push({ path });
      devSave('favorites', favorites);
      renderFavoritesMenu();
    }
    function removeFavorite(path) {
      favorites = favorites.filter((f) => f.path !== path);
      devSave('favorites', favorites);
      renderFavoritesMenu();
    }
    function isFavorite(path) { return favorites.some((f) => f.path === path); }

    // ── base64 ↔ hex for the REG_BINARY viewer ─────────────────────────
    function b64ToBytes(b64) {
      const clean = String(b64 || '').replace(/\s+/g, '');
      const bin = atob(clean);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytes;
    }
    function bytesToB64(bytes) {
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }
    function toHexGrid(bytes) {
      const rows = [];
      for (let i = 0; i < bytes.length; i += 16) {
        const slice = Array.from(bytes.slice(i, i + 16));
        const hex = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = slice.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
        rows.push(i.toString(16).padStart(8, '0') + '  ' + hex.padEnd(47) + '  ' + ascii);
      }
      return rows.join('\n');
    }
    function parseHexToB64(text) {
      const clean = text.replace(/0x/gi, ' ').replace(/[^0-9a-fA-F]/g, '');
      if (clean.length % 2 !== 0) throw new Error('hex input must have an even number of digits');
      const bytes = new Uint8Array(clean.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return bytesToB64(bytes);
    }

    // ── toolbar ────────────────────────────────────────────────────────
    const toolbar = el('div', 'display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--border-subtle,#2a2f3a);align-items:center;flex-shrink:0;flex-wrap:wrap;');

    const historyDatalist = el('datalist');
    historyDatalist.id = 'novareg-jump-history';
    function renderHistoryDatalist() {
      historyDatalist.textContent = '';
      for (const path of jumpHistory.slice().reverse()) {
        const opt = document.createElement('option');
        opt.value = path;
        historyDatalist.appendChild(opt);
      }
    }

    const jumpInput = el('input', 'flex:1;min-width:180px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;');
    jumpInput.placeholder = 'Jump to path — e.g. HKNS/shell/wallpaper';
    jumpInput.setAttribute('list', historyDatalist.id);
    const jumpBtn = el('button', btnStyle(true), 'Go');
    const filterInput = el('input', 'width:130px;padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-size:11px;box-sizing:border-box;');
    filterInput.placeholder = 'Filter keys…';

    function btnStyle(primary) {
      return 'padding:5px 10px;' + (primary
        ? 'background:var(--accent,#58a6ff);color:#fff;border:none;'
        : 'background:transparent;color:var(--text-muted,#9aa4b2);border:1px solid var(--border-subtle,#2a2f3a);') +
        'border-radius:4px;cursor:pointer;font-size:11px;flex-shrink:0;';
    }
    const newKeyBtn = el('button', btnStyle(false), '+ Key');
    const newValueBtn = el('button', btnStyle(false), '+ Value');
    const newLinkBtn = el('button', btnStyle(false), '+ Link');
    const renameBtn = el('button', btnStyle(false), 'Rename');
    const deleteBtn = el('button', btnStyle(false), 'Delete');
    const copyPathBtn = el('button', btnStyle(false), 'Copy Path');
    const findBtn = el('button', btnStyle(false), 'Find');
    const favBtn = el('button', btnStyle(false), '★ Fav');
    const permBtn = el('button', btnStyle(false), 'Permissions');
    const snapBtn = el('button', btnStyle(false), 'Snapshots');
    const auditBtn = el('button', btnStyle(false), 'Audit');
    const exportBtn = el('button', btnStyle(false), 'Export');
    const importBtn = el('button', btnStyle(false), 'Import');
    const importFile = el('input');
    importFile.type = 'file';
    importFile.accept = '.json,.nvreg,application/json,text/plain';
    importFile.style.display = 'none';

    toolbar.append(jumpInput, jumpBtn, filterInput, newKeyBtn, newValueBtn, newLinkBtn, renameBtn, deleteBtn, copyPathBtn, findBtn, favBtn, permBtn, snapBtn, auditBtn, exportBtn, importBtn, importFile, historyDatalist);

    // ── main split ─────────────────────────────────────────────────────
    const main = el('div', 'display:flex;flex:1;min-height:0;');
    const treePane = el('div', 'width:260px;flex-shrink:0;border-right:1px solid var(--border-subtle,#2a2f3a);overflow:auto;padding:6px;');
    const valuePane = el('div', 'flex:1;display:flex;flex-direction:column;min-width:0;');

    const valueHeader = el('div', 'padding:8px 10px;border-bottom:1px solid var(--border-subtle,#2a2f3a);color:var(--text-muted,#9aa4b2);font-weight:600;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    // Friendly-name strip — what the selected key IS, in plain language.
    const valueHeaderInfo = el('div', 'display:none;padding:2px 10px 7px;border-bottom:1px solid var(--border-subtle,#2a2f3a);flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    const valueTable = el('div', 'flex:1;overflow:auto;padding:4px 10px;');
    valuePane.append(valueHeader, valueHeaderInfo, valueTable);

    // Audit panel (bottom pane, toggleable).
    const auditPane = el('div', 'display:none;flex-direction:column;border-top:1px solid var(--border-subtle,#2a2f3a);height:180px;flex-shrink:0;');
    const auditHeader = el('div', 'display:flex;align-items:center;gap:8px;padding:4px 10px;color:var(--text-muted,#9aa4b2);font-weight:600;flex-shrink:0;');
    const auditTable = el('div', 'flex:1;overflow:auto;padding:2px 10px;font-family:monospace;font-size:10px;');
    auditHeader.appendChild(el('span', null, 'Write audit (newest first)'));
    const auditRefreshBtn = el('button', btnStyle(false), 'Refresh');
    auditHeader.appendChild(auditRefreshBtn);
    auditPane.append(auditHeader, auditTable);

    main.append(treePane, valuePane);

    // ── status bar ─────────────────────────────────────────────────────
    const statusBar = el('div', 'padding:6px 10px;border-top:1px solid var(--border-subtle,#2a2f3a);color:var(--text-muted,#9aa4b2);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;');

    content.append(toolbar, main, auditPane, statusBar);

    // ── tree rendering (lazy: children load on expand) ─────────────────
    function nodeLabel(path) { return path.split('/').pop(); }

    function makeKeyRow(path, depth) {
      const row = el('div', 'display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:4px;cursor:pointer;white-space:nowrap;');
      row.style.paddingLeft = (6 + depth * 14) + 'px';
      const listing = treeCache[path];
      const hasChildren = listing ? (listing.keys.length > 0 || !expanded[path]) : true;
      const isOpen = !!expanded[path];
      const caret = el('span', 'width:12px;display:inline-block;text-align:center;color:var(--text-muted,#9aa4b2);', hasChildren ? (isOpen ? '▾' : '▸') : '·');
      const label = el('span', 'font-family:monospace;', nodeLabel(path));
      row.append(caret, label);
      if (path === selectedPath) row.style.background = 'var(--accent-muted,rgba(88,166,255,0.15))';
      if (isFavorite(path)) {
        row.appendChild(el('span', 'color:#f5b301;margin-left:2px;', '★'));
      }
      const info = infoOf(path);
      row.title = info ? info.label + '\n' + path + (info.description ? '\n' + info.description : '') : path;
      row.addEventListener('click', () => {
        expanded[path] = !expanded[path];
        selectedPath = path;
        selectedValue = null;
        refresh().then(() => setStatus('Browsing ' + path));
      }, { signal: ac.signal });
      return row;
    }

    function renderTreeNode(path, depth, container) {
      container.appendChild(makeKeyRow(path, depth));
      if (!expanded[path]) return;
      const listing = treeCache[path];
      const keys = (listing ? listing.keys : []).filter((k) => !filterText || k.toLowerCase().includes(filterText));
      for (const child of keys) renderTreeNode(path + '/' + child, depth + 1, container);
    }

    function renderTree() {
      treePane.textContent = '';
      for (const hive of HIVES) {
        if (filterText && hive.toLowerCase().includes(filterText) === false && !expanded[hive]) continue;
        renderTreeNode(hive, 0, treePane);
      }
    }

    // ── value table ────────────────────────────────────────────────────
    function preview(data) {
      let text;
      try { text = typeof data === 'string' ? data : JSON.stringify(data); } catch (_) { text = String(data); }
      return text.length > 200 ? text.slice(0, 200) + '…' : text;
    }

    function makeValueRow(name, entry, isDefault) {
      const row = el('div', 'display:grid;grid-template-columns:1.1fr 0.9fr 2fr auto;gap:8px;padding:5px 6px;border-radius:4px;cursor:pointer;align-items:baseline;');
      if (selectedValue === name) row.style.background = 'var(--accent-muted,rgba(88,166,255,0.15))';
      const displayName = isDefault ? '(Default)' : name;
      const nameSpan = el('span', 'font-family:monospace;color:var(--text-primary);' + (isDefault ? 'font-weight:600;' : ''), displayName);
      const typeSpan = el('span', 'color:var(--text-muted,#9aa4b2);font-size:10px;', entry ? entry.type : 'REG_SZ');
      let dataText = entry ? preview(entry.data) : '(value not set)';
      if (entry && entry.type === 'REG_EXPAND_SZ') dataText += '  → ' + preview(Reg.expand(entry.data));
      const dataSpan = el('span', 'font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (entry ? 'var(--text-primary)' : 'var(--text-muted,#9aa4b2)') + ';', dataText);
      const modSpan = el('span', 'color:var(--text-muted,#9aa4b2);font-size:10px;', entry && entry.lastModified ? new Date(entry.lastModified).toLocaleTimeString() : '');
      row.append(nameSpan, typeSpan, dataSpan, modSpan);
      row.title = 'Double-click to edit · ' + selectedPath + '/' + name;
      row.addEventListener('click', () => { selectedValue = name; renderTree(); refreshValues(); setStatus('Selected ' + displayName); }, { signal: ac.signal });
      row.addEventListener('dblclick', () => openValueEditor(isDefault ? DEFAULT_NAME : name, entry, isDefault), { signal: ac.signal });
      return row;
    }

    function refreshValues() {
      const listing = treeCache[selectedPath];
      const values = listing ? listing.values : {};
      const names = Object.keys(values).filter((n) => n !== DEFAULT_NAME).sort();
      valueHeader.textContent = selectedPath + '  (' + names.length + ' value' + (names.length === 1 ? '' : 's') + (listing && listing.link ? ' · link → ' + listing.link : '') + ')';
      const info = infoOf(selectedPath);
      valueHeaderInfo.textContent = '';
      if (info) {
        valueHeaderInfo.style.display = 'block';
        valueHeaderInfo.appendChild(el('span', 'color:var(--accent,#58a6ff);font-weight:600;', info.label));
        if (info.description) valueHeaderInfo.appendChild(el('span', 'color:var(--text-muted,#9aa4b2);margin-left:8px;', info.description));
      } else {
        valueHeaderInfo.style.display = 'none';
      }
      valueTable.textContent = '';
      // The pinned (Default) row — every key owns one, regedit-style.
      valueTable.appendChild(makeValueRow(DEFAULT_NAME, values[DEFAULT_NAME] || null, true));
      if (!names.length) {
        valueTable.appendChild(el('div', 'color:var(--text-muted,#9aa4b2);padding:8px 0;', '(no other values in this key)'));
        return;
      }
      for (const name of names) valueTable.appendChild(makeValueRow(name, values[name], false));
    }

    // ── data refresh ───────────────────────────────────────────────────
    async function refresh() {
      // Ensure every expanded path (and the selection) has a cached listing.
      const wanted = new Set([selectedPath]);
      for (const path of Object.keys(expanded)) if (expanded[path]) wanted.add(path);
      for (const hive of HIVES) wanted.add(hive);
      for (const path of wanted) {
        try {
          treeCache[path] = Reg.list(path);
        } catch (err) {
          delete treeCache[path];
          statusMessage = 'list failed: ' + errorMessage(err);
        }
      }
      renderTree();
      refreshValues();
      setStatus(statusMessage);
      if (auditVisible) renderAudit();
    }

    // ── toolbar actions ────────────────────────────────────────────────
    function jump() {
      const raw = jumpInput.value.trim();
      if (!raw) return;
      try {
        const listing = Reg.list(raw);
        const normalized = listing ? listing.path : null;
        if (!normalized) { setStatus('No such key: ' + raw); return; }
        // Expand every ancestor so the tree shows the jump target.
        const parts = normalized.split('/');
        for (let i = 1; i <= parts.length; i++) expanded[parts.slice(0, i).join('/')] = true;
        selectedPath = normalized;
        selectedValue = null;
        rememberJump(normalized);
        refresh().then(() => setStatus('Jumped to ' + normalized));
      } catch (err) { setStatus(errorMessage(err)); }
    }
    jumpBtn.addEventListener('click', jump, { signal: ac.signal });
    jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(); }, { signal: ac.signal });
    filterInput.addEventListener('input', () => {
      filterText = filterInput.value.trim().toLowerCase();
      for (const hive of HIVES) expanded[hive] = true;
      renderTree();
    }, { signal: ac.signal });

    newKeyBtn.addEventListener('click', () => {
      openPromptDialog('New key under ' + selectedPath, 'Key name', (name) => {
        try {
          Reg.import(selectedPath, { keys: { [name]: { keys: {}, values: {} } }, values: {} }, { actor: SELF });
          expanded[selectedPath] = true;
          expanded[selectedPath + '/' + name] = true;
          refresh().then(() => setStatus('Created key ' + selectedPath + '/' + name));
        } catch (err) { setStatus(errorMessage(err)); }
      });
    }, { signal: ac.signal });

    newValueBtn.addEventListener('click', () => openValueEditor(null, null, false), { signal: ac.signal });

    newLinkBtn.addEventListener('click', () => {
      if (HIVES.includes(selectedPath)) { setStatus('A hive root cannot be a link.'); return; }
      openPromptDialog('New link under ' + selectedPath, 'Link name', (name) => {
        openPromptDialog('Link ' + selectedPath + '/' + name + ' → target path', 'Target (e.g. HKNU/desktop)', (target) => {
          try {
            Reg.setLink(selectedPath + '/' + name, target, { actor: SELF });
            expanded[selectedPath] = true;
            refresh().then(() => setStatus('Linked ' + selectedPath + '/' + name + ' → ' + target));
          } catch (err) { setStatus(errorMessage(err)); }
        });
      });
    }, { signal: ac.signal });

    renameBtn.addEventListener('click', () => {
      if (HIVES.includes(selectedPath) && !selectedValue) { setStatus('Cannot rename a hive root.'); return; }
      if (selectedValue) {
        if (selectedValue === DEFAULT_NAME) { setStatus('The (Default) row cannot be renamed.'); return; }
        openPromptDialog('Rename value "' + selectedValue + '"', 'New name', (name) => {
          try {
            const result = Reg.rename(selectedPath + '/' + selectedValue, name, { actor: SELF });
            selectedValue = name;
            refresh().then(() => setStatus('Renamed to ' + result.path));
          } catch (err) { setStatus(errorMessage(err)); }
        });
        return;
      }
      openPromptDialog('Rename key "' + selectedPath + '"', 'New name', (name) => {
        try {
          const result = Reg.rename(selectedPath, name, { actor: SELF });
          selectedPath = result.path;
          delete expanded[selectedPath];
          refresh().then(() => setStatus('Renamed key to ' + result.path));
        } catch (err) { setStatus(errorMessage(err)); }
      });
    }, { signal: ac.signal });

    copyPathBtn.addEventListener('click', async () => {
      const path = selectedPath + (selectedValue ? '/' + selectedValue : '');
      try {
        await navigator.clipboard.writeText(path);
        setStatus('Copied ' + path);
      } catch (err) { setStatus('Clipboard unavailable: ' + errorMessage(err)); }
    }, { signal: ac.signal });

    deleteBtn.addEventListener('click', () => {
      if (selectedValue) {
        const valuePath = selectedPath + '/' + selectedValue;
        if (!window.confirm('Delete value "' + selectedValue + '"?')) return;
        try {
          Reg.remove(valuePath, { recursive: false, actor: SELF });
          selectedValue = null;
          refresh().then(() => setStatus('Deleted ' + valuePath));
        } catch (err) { setStatus(errorMessage(err)); }
        return;
      }
      if (HIVES.includes(selectedPath)) { setStatus('Cannot delete a hive root.'); return; }
      if (!window.confirm('Delete key "' + selectedPath + '" and EVERYTHING under it?')) return;
      try {
        Reg.remove(selectedPath, { recursive: true, actor: SELF });
        const parent = keyOf(selectedPath);
        selectedPath = parent || selectedPath.split('/')[0];
        selectedValue = null;
        refresh().then(() => setStatus('Deleted key ' + selectedPath));
      } catch (err) { setStatus(errorMessage(err)); }
    }, { signal: ac.signal });

    favBtn.addEventListener('click', () => {
      if (isFavorite(selectedPath)) removeFavorite(selectedPath);
      else pushFavorite(selectedPath);
      renderTree();
      setStatus(isFavorite(selectedPath) ? 'Favorited ' + selectedPath : 'Removed favorite ' + selectedPath);
    }, { signal: ac.signal });

    // Favorites + Snapshots dropdowns share a tiny popover helper.
    function openPopover(anchor, build) {
      closePopovers();
      const pop = el('div', 'position:absolute;background:var(--bg-elevated,#161b22);border:1px solid var(--border-subtle,#2a2f3a);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.5);padding:6px;min-width:220px;max-height:260px;overflow:auto;z-index:20;');
      build(pop);
      content.style.position = 'relative';
      content.appendChild(pop);
      const rect = anchor.getBoundingClientRect();
      const hostRect = content.getBoundingClientRect();
      pop.style.top = Math.min(rect.bottom - hostRect.top + 4, hostRect.height - 80) + 'px';
      pop.style.left = Math.max(rect.left - hostRect.left, 4) + 'px';
      pop.__anchor = anchor;
      setTimeout(() => {
        document.addEventListener('click', function close(e) {
          if (pop.contains(e.target) || (pop.__anchor && pop.__anchor.contains(e.target))) {
            document.addEventListener('click', close, { once: true });
            return;
          }
          pop.remove();
        }, { once: true });
      }, 0);
      return pop;
    }
    function closePopovers() {
      content.querySelectorAll(':scope > div[style*="z-index:20"]').forEach((n) => n.remove());
    }

    function popoverItem(pop, label, onClick, danger) {
      const item = el('div', 'padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;color:' + (danger ? '#f85149' : 'var(--text-primary)') + ';', label);
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--accent-muted,rgba(88,166,255,0.15))'; }, { signal: ac.signal });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; }, { signal: ac.signal });
      item.addEventListener('click', () => { pop.remove(); onClick(); }, { signal: ac.signal });
      pop.appendChild(item);
      return item;
    }

    function renderFavoritesMenu() { /* rebuilt on open */ }
    favBtn.addEventListener('click', () => {
      openPopover(favBtn, (pop) => {
        if (!favorites.length) pop.appendChild(el('div', 'padding:5px 10px;color:var(--text-muted,#9aa4b2);', '(no favorites — press ★ Fav)'));
        for (const fav of favorites.slice().reverse()) {
          popoverItem(pop, '★ ' + fav.path, () => {
            jumpInput.value = fav.path;
            jump();
          });
        }
        if (favorites.some((f) => f.path === selectedPath)) {
          popoverItem(pop, 'Remove current from favorites', () => { removeFavorite(selectedPath); renderTree(); }, true);
        }
      });
    }, { signal: ac.signal });

    snapBtn.addEventListener('click', () => {
      const hive = selectedPath.split('/')[0];
      openPopover(snapBtn, (pop) => {
        popoverItem(pop, 'Take snapshot of ' + hive + '…', () => {
          openPromptDialog('Snapshot ' + hive, 'Label (optional)', (label) => {
            try {
              const snap = Reg.saveSnapshot(hive, label, { actor: SELF });
              setStatus('Snapshot ' + snap.id + ' saved for ' + hive);
            } catch (err) { setStatus(errorMessage(err)); }
          });
        });
        let snaps = [];
        try { snaps = Reg.snapshots(hive); } catch (_) { /* ignore */ }
        if (!snaps.length) pop.appendChild(el('div', 'padding:5px 10px;color:var(--text-muted,#9aa4b2);', '(no snapshots of ' + hive + ')'));
        for (const snap of snaps.slice().reverse()) {
          const row = el('div', 'display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:4px;');
          const label = el('span', 'flex:1;white-space:nowrap;', snap.label + ' · ' + new Date(snap.ts).toLocaleString() + ' · ' + Math.round(snap.bytes / 1024) + ' KB');
          const restoreB = el('button', btnStyle(false), 'Restore');
          const delB = el('button', btnStyle(false), '✕');
          restoreB.addEventListener('click', () => {
            pop.remove();
            if (!window.confirm('Restore ' + hive + ' from "' + snap.label + '"? Current hive contents are replaced.')) return;
            try {
              Reg.restoreSnapshot(hive, snap.id, { actor: SELF });
              refresh().then(() => setStatus('Restored ' + hive + ' from ' + snap.label));
            } catch (err) { setStatus(errorMessage(err)); }
          }, { signal: ac.signal });
          delB.addEventListener('click', () => {
            pop.remove();
            try { Reg.deleteSnapshot(hive, snap.id); setStatus('Snapshot deleted.'); }
            catch (err) { setStatus(errorMessage(err)); }
          }, { signal: ac.signal });
          row.append(label, restoreB, delB);
          pop.appendChild(row);
        }
      });
    }, { signal: ac.signal });

    // ── audit panel ────────────────────────────────────────────────────
    function renderAudit() {
      auditTable.textContent = '';
      let entries = [];
      try { entries = Reg.audit(150); } catch (_) { /* ignore */ }
      if (!entries.length) {
        auditTable.appendChild(el('div', 'color:var(--text-muted,#9aa4b2);padding:6px 0;', '(no writes recorded yet)'));
        return;
      }
      for (const entry of entries) {
        const row = el('div', 'display:grid;grid-template-columns:auto auto auto 1.4fr 1fr 1fr;gap:8px;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03);');
        row.append(
          el('span', 'color:var(--text-muted,#9aa4b2);', new Date(entry.ts).toLocaleTimeString()),
          el('span', 'color:var(--accent,#58a6ff);', entry.actor),
          el('span', 'color:#d2a8ff;', entry.action),
          el('span', 'color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', entry.path),
          el('span', 'color:var(--text-muted,#9aa4b2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', entry.before === null ? '—' : entry.before),
          el('span', 'color:#7ee787;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', entry.after === null ? '—' : entry.after),
        );
        row.title = entry.path + '\n' + (entry.before ?? '∅') + ' → ' + (entry.after ?? '∅');
        auditTable.appendChild(row);
      }
    }
    auditRefreshBtn.addEventListener('click', renderAudit, { signal: ac.signal });
    auditBtn.addEventListener('click', () => {
      auditVisible = !auditVisible;
      auditPane.style.display = auditVisible ? 'flex' : 'none';
      auditBtn.style.color = auditVisible ? 'var(--accent,#58a6ff)' : '';
      if (auditVisible) renderAudit();
    }, { signal: ac.signal });

    // ── find (Ctrl+F) ──────────────────────────────────────────────────
    function searchTree(rootPath, query, opts) {
      const results = [];
      const q = query.toLowerCase();
      const visit = (path, node) => {
        if (results.length >= 200 || !node) return;
        if (opts.keys && nodeLabel(path).toLowerCase().includes(q)) results.push({ path, kind: 'key' });
        for (const [name, entry] of Object.entries(node.values || {})) {
          if (results.length >= 200) return;
          const displayName = name === DEFAULT_NAME ? '(Default)' : name;
          if (opts.valueNames && displayName.toLowerCase().includes(q)) {
            results.push({ path: path + '/' + name, kind: 'value name' });
          }
          if (opts.data) {
            let text;
            try { text = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data); } catch (_) { text = ''; }
            if (text && text.toLowerCase().includes(q)) results.push({ path: path + '/' + name, kind: 'data' });
          }
        }
        for (const [name, child] of Object.entries(node.keys || {})) visit(path + '/' + name, child);
      };
      try { visit(rootPath, Reg.export(rootPath)); } catch (_) { /* unreadable subtree — skip */ }
      return results;
    }

    function openFindDialog() {
      const { back, box } = dialogShell('Find in Registry (Ctrl+F)');
      const query = el('input', fieldStyle());
      query.placeholder = 'Search text…';
      const scopeRow = el('div', 'display:flex;gap:14px;margin-top:8px;color:var(--text-muted,#9aa4b2);align-items:center;');
      const scopeSel = el('select', fieldStyle() + 'width:auto;');
      for (const opt of ['Current key subtree', 'All hives']) {
        const o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        scopeSel.appendChild(o);
      }
      const mkCheck = (label, checked) => {
        const wrap = el('label', 'display:flex;gap:4px;align-items:center;cursor:pointer;');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        wrap.append(cb, el('span', null, label));
        return { wrap, cb };
      };
      const keysC = mkCheck('Keys', true);
      const namesC = mkCheck('Value names', true);
      const dataC = mkCheck('Data', true);
      scopeRow.append(scopeSel, keysC.wrap, namesC.wrap, dataC.wrap);
      const resultsBox = el('div', 'margin-top:10px;max-height:220px;overflow:auto;border:1px solid var(--border-subtle,#2a2f3a);border-radius:4px;');
      const info = el('div', 'margin-top:6px;color:var(--text-muted,#9aa4b2);font-size:11px;min-height:14px;');
      const search = () => {
        const q = query.value.trim();
        resultsBox.textContent = '';
        if (!q) { info.textContent = 'Type a search text.'; return; }
        const opts = { keys: keysC.cb.checked, valueNames: namesC.cb.checked, data: dataC.cb.checked };
        const scopes = scopeSel.value === 'All hives' ? HIVES : [selectedPath];
        let results = [];
        for (const scope of scopes) results = results.concat(searchTree(scope, q, opts));
        info.textContent = results.length ? results.length + ' match(es)' + (results.length >= 200 ? ' (capped)' : '') : 'No matches.';
        for (const result of results) {
          const row = el('div', 'padding:4px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:8px;align-items:baseline;');
          row.appendChild(el('span', 'color:#d2a8ff;font-size:10px;width:70px;flex-shrink:0;', result.kind));
          row.appendChild(el('span', 'font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', result.path));
          const keyPath = result.kind === 'key' ? result.path : keyOf(result.path);
          const finfo = infoOf(keyPath);
          row.title = finfo ? finfo.label + (finfo.description ? ' — ' + finfo.description : '') : keyPath;
          row.addEventListener('click', () => {
            back.remove();
            jumpInput.value = result.kind === 'key' ? result.path : keyOf(result.path);
            jump();
            if (result.kind !== 'key') {
              selectedValue = result.path.split('/').pop();
              refreshValues();
            }
          }, { signal: ac.signal });
          resultsBox.appendChild(row);
        }
      };
      query.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); }, { signal: ac.signal });
      [keysC.cb, namesC.cb, dataC.cb, scopeSel].forEach((n) => n.addEventListener('change', search, { signal: ac.signal }));
      const runBtn = el('button', btnStyle(true), 'Search');
      runBtn.addEventListener('click', search, { signal: ac.signal });
      box.append(query, scopeRow, runBtn, resultsBox, info);
      content.appendChild(back);
      query.focus();
    }
    findBtn.addEventListener('click', openFindDialog, { signal: ac.signal });
    content.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openFindDialog();
      } else if (e.key === 'F2' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        renameBtn.click();
      }
    }, { signal: ac.signal });

    // ── permissions dialog (engine ACLs) ───────────────────────────────
    permBtn.addEventListener('click', () => {
      if (HIVES.includes(selectedPath)) { setStatus('ACLs apply to keys, not hive roots.'); return; }
      const { back, box } = dialogShell('Permissions — ' + selectedPath);

      let effective = null;
      try { effective = Reg.effectiveAcl(selectedPath); } catch (_) { /* ignore */ }
      const effWrap = el('div', 'font-size:11px;color:var(--text-muted,#9aa4b2);margin-bottom:8px;max-height:70px;overflow:auto;');
      const effTitle = el('div', 'font-weight:600;margin-bottom:4px;', 'Effective (inherited + own)');
      effWrap.appendChild(effTitle);
      if (effective && effective.entries.length) {
        if (effective.owner) effWrap.appendChild(el('div', null, 'Owner: ' + effective.owner));
        for (const entry of effective.entries) {
          effWrap.appendChild(el('div', null, entry.id + ' → ' + (entry.rights.join(', ') || 'none')));
        }
      } else {
        effWrap.appendChild(el('div', null, 'No ACL on this key chain — base hive rules only.'));
      }

      const current = Reg.getAcl(selectedPath);
      const ownerInput = el('input', fieldStyle());
      ownerInput.value = current?.owner || '';
      ownerInput.placeholder = 'Owner (optional)';
      const rowsWrap = el('div', 'display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:150px;overflow:auto;');
      const entryRows = [];

      function addEntryRow(entry) {
        const row = el('div', 'display:grid;grid-template-columns:1.4fr auto auto auto auto;gap:6px;align-items:center;');
        const id = el('input', fieldStyle());
        id.value = entry?.id || '';
        id.placeholder = 'app id or *';
        const mkCb = (label, checked) => {
          const wrap = el('label', 'display:flex;gap:3px;align-items:center;cursor:pointer;font-size:10px;color:var(--text-muted,#9aa4b2);');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = !!checked;
          wrap.append(cb, el('span', null, label));
          return { wrap, cb };
        };
        const read = mkCb('R', entry?.rights?.includes('read'));
        const write = mkCb('W', entry?.rights?.includes('write'));
        const inherit = mkCb('Inherit', entry ? entry.inherit !== false : true);
        const del = el('button', btnStyle(false), '✕');
        row.append(id, read.wrap, write.wrap, inherit.wrap, del);
        const record = { id, read: read.cb, write: write.cb, inherit: inherit.cb, row };
        del.addEventListener('click', () => { row.remove(); entryRows.splice(entryRows.indexOf(record), 1); }, { signal: ac.signal });
        rowsWrap.appendChild(row);
        entryRows.push(record);
      }
      for (const entry of current?.entries || []) addEntryRow(entry);

      const addRowBtn = el('button', btnStyle(false), '+ Entry');
      addRowBtn.addEventListener('click', () => addEntryRow(null), { signal: ac.signal });
      const errorLine = el('div', 'margin-top:6px;color:#f85149;font-size:11px;min-height:14px;');
      const clearBtn = el('button', btnStyle(false), 'Clear ACL');
      const { row: btnRow, save } = closeButtonRow(box);
      btnRow.prepend(clearBtn);
      clearBtn.addEventListener('click', () => {
        try {
          Reg.setAcl(selectedPath, null, { actor: SELF });
          back.remove();
          refresh().then(() => setStatus('ACL cleared on ' + selectedPath));
        } catch (err) { errorLine.textContent = errorMessage(err); }
      }, { signal: ac.signal });
      save.addEventListener('click', () => {
        const entries = entryRows.map((record) => {
          const rights = [];
          if (record.read.checked) rights.push('read');
          if (record.write.checked) rights.push('write');
          return { id: record.id.value.trim(), rights, inherit: record.inherit.checked };
        }).filter((entry) => entry.id);
        try {
          Reg.setAcl(selectedPath, { owner: ownerInput.value.trim() || null, entries }, { actor: SELF });
          back.remove();
          refresh().then(() => setStatus('ACL saved on ' + selectedPath + ' (' + entries.length + ' entries)'));
        } catch (err) { errorLine.textContent = errorMessage(err); }
      }, { signal: ac.signal });

      box.append(effWrap, ownerInput, rowsWrap, addRowBtn, errorLine, btnRow);
      content.appendChild(back);
    }, { signal: ac.signal });

    // ── export / import (JSON or .nvreg text via window.NovaRegFile) ───
    exportBtn.addEventListener('click', () => {
      try {
        const useText = typeof window.NovaRegFile === 'object' && window.NovaRegFile;
        const data = Reg.export(selectedPath);
        let blob;
        let ext;
        if (useText) {
          blob = new Blob([window.NovaRegFile.stringify(selectedPath, data)], { type: 'text/plain' });
          ext = 'nvreg';
        } else {
          blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          ext = 'json';
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'nova-registry-' + selectedPath.replace(/[\\/]/g, '-') + '.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setStatus('Exported ' + selectedPath + (useText ? ' (.nvreg)' : ' (json)'));
      } catch (err) { setStatus(errorMessage(err)); }
    }, { signal: ac.signal });

    importBtn.addEventListener('click', () => importFile.click(), { signal: ac.signal });
    importFile.addEventListener('change', () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result);
          const isNvreg = /\.nvreg$/i.test(file.name) || (!text.trim().startsWith('{') && typeof window.NovaRegFile === 'object');
          let data;
          if (isNvreg && window.NovaRegFile) data = window.NovaRegFile.parse(text).tree;
          else data = JSON.parse(text);
          // One-click safety net: snapshot the hive before merging anything.
          try { Reg.saveSnapshot(selectedPath.split('/')[0], 'before-import', { actor: SELF }); } catch (_) {}
          const result = Reg.import(selectedPath, data, { actor: SELF });
          expanded[selectedPath] = true;
          refresh().then(() => setStatus('Imported ' + result.merged + ' value(s) into ' + selectedPath + ' (pre-import snapshot taken)'));
        } catch (err) { setStatus('Import failed: ' + errorMessage(err)); }
      };
      reader.readAsText(file);
    }, { signal: ac.signal });

    // Live refresh — one debounced listener on the registry change event.
    let refreshTimer = null;
    OS.events.on('nova:reg:changed', () => {
      inventoryCache = null; // HKNA app display names may have changed
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { refresh(); }, 120);
    });
    state.cleanups.push(() => ac.abort());

    // ── dialogs (value editor + prompt) ────────────────────────────────
    function overlay() {
      const back = el('div', 'position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:30;');
      content.style.position = 'relative';
      return back;
    }

    function dialogShell(titleText) {
      const back = overlay();
      const box = el('div', 'background:var(--bg-elevated,#161b22);border:1px solid var(--border-subtle,#2a2f3a);border-radius:8px;padding:14px;min-width:360px;max-width:560px;box-shadow:0 12px 32px rgba(0,0,0,0.5);max-height:90%;overflow:auto;');
      box.appendChild(el('div', 'font-weight:600;margin-bottom:10px;color:var(--text-primary);', titleText));
      back.appendChild(box);
      return { back, box };
    }

    function fieldStyle() { return 'width:100%;padding:6px 8px;background:var(--bg-default,#0f1115);border:1px solid var(--border-subtle,#2a2f3a);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:11px;box-sizing:border-box;'; }

    function closeButtonRow(box, onCancel) {
      const row = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;');
      const cancel = el('button', btnStyle(false), 'Cancel');
      const save = el('button', btnStyle(true), 'Save');
      cancel.addEventListener('click', () => { backClose(box); onCancel && onCancel(); }, { signal: ac.signal });
      row.append(cancel, save);
      return { row, save };
    }
    function backClose(box) { if (box && box.parentNode) box.parentNode.remove(); }

    function openPromptDialog(titleText, labelText, onSubmit) {
      const { back, box } = dialogShell(titleText);
      const label = el('div', 'margin-bottom:6px;color:var(--text-muted,#9aa4b2);', labelText);
      const input = el('input', fieldStyle());
      input.placeholder = 'name (letters, digits, dash, dot)';
      box.append(label, input);
      const { row, save } = closeButtonRow(box);
      box.appendChild(row);
      const submit = () => {
        const name = input.value.trim();
        if (!name || /[\/\\]/.test(name) || name === '.' || name === '..') { input.style.borderColor = '#f85149'; return; }
        backClose(box);
        onSubmit(name);
      };
      save.addEventListener('click', submit, { signal: ac.signal });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); }, { signal: ac.signal });
      content.appendChild(back);
      input.focus();
    }

    function coerceForType(type, rawText) {
      switch (type) {
        case 'REG_SZ': case 'REG_EXPAND_SZ': return rawText;
        case 'REG_BOOL': return rawText === 'true';
        case 'REG_DWORD': case 'REG_QWORD': {
          const text = rawText.trim();
          const value = dwordRadix === 16 && /^[0-9a-fA-F]+$/.test(text) ? parseInt(text, 16) : Number(text);
          if (!Number.isFinite(value)) throw new Error('not a number');
          return value;
        }
        case 'REG_MULTI_SZ': return rawText.split('\n').filter((line, index, all) => !(line === '' && index === all.length - 1));
        case 'REG_JSON': return JSON.parse(rawText);
        case 'REG_BINARY': return rawText.replace(/\s+/g, '');
        default: return rawText;
      }
    }

    function openValueEditor(name, entry, isDefaultRow) {
      const isNew = !name;
      const title = isNew ? 'New value in ' + selectedPath : 'Edit ' + selectedPath + '/' + name;
      const { back, box } = dialogShell(title);

      const nameLabel = el('div', 'margin:6px 0 4px;color:var(--text-muted,#9aa4b2);', isDefaultRow ? 'Name — the key\'s default (unnamed) value' : 'Name');
      const nameInput = el('input', fieldStyle());
      nameInput.value = name === DEFAULT_NAME ? '' : (name || '');
      nameInput.disabled = !isNew;
      if (isDefaultRow) nameInput.value = DEFAULT_NAME;

      const typeLabel = el('div', 'margin:10px 0 4px;color:var(--text-muted,#9aa4b2);', 'Type');
      const typeSelect = el('select', fieldStyle());
      for (const t of TYPES) {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        typeSelect.appendChild(opt);
      }
      const dataLabel = el('div', 'margin:10px 0 4px;color:var(--text-muted,#9aa4b2);', 'Data');
      const dataInput = el('textarea', fieldStyle() + 'min-height:90px;resize:vertical;');
      const boolWrap = el('div');
      const boolSelect = el('select', fieldStyle());
      for (const b of ['false', 'true']) {
        const opt = document.createElement('option');
        opt.value = b; opt.textContent = b;
        boolSelect.appendChild(opt);
      }
      boolWrap.appendChild(boolSelect);

      // Radix toggle for DWORD/QWORD (regedit shows hex by default).
      const radixWrap = el('div', 'display:none;gap:8px;margin-top:6px;align-items:center;color:var(--text-muted,#9aa4b2);font-size:10px;');
      const decBtn = el('button', btnStyle(false), 'dec');
      const hexBtn = el('button', btnStyle(false), 'hex');
      radixWrap.append(el('span', null, 'Input radix:'), decBtn, hexBtn);
      const paintRadix = () => {
        decBtn.style.color = dwordRadix === 10 ? 'var(--accent,#58a6ff)' : '';
        hexBtn.style.color = dwordRadix === 16 ? 'var(--accent,#58a6ff)' : '';
      };
      decBtn.addEventListener('click', () => {
        const current = coerceForType(typeSelect.value, dataInput.value);
        dwordRadix = 10;
        if (Number.isFinite(current)) dataInput.value = String(current);
        paintRadix();
      }, { signal: ac.signal });
      hexBtn.addEventListener('click', () => {
        const current = coerceForType(typeSelect.value, dataInput.value);
        dwordRadix = 16;
        if (Number.isFinite(current)) dataInput.value = current.toString(16);
        paintRadix();
      }, { signal: ac.signal });

      // REG_MULTI_SZ: one string per line.
      const multiHint = el('div', 'display:none;color:var(--text-muted,#9aa4b2);font-size:10px;margin-top:4px;', 'One string per line.');
      // REG_EXPAND_SZ: live expanded preview.
      const expandHint = el('div', 'display:none;color:var(--text-muted,#9aa4b2);font-size:10px;margin-top:4px;white-space:pre-wrap;');
      const updateExpandHint = () => {
        if (typeSelect.value !== 'REG_EXPAND_SZ') { expandHint.style.display = 'none'; return; }
        expandHint.style.display = 'block';
        let expandedText;
        try { expandedText = Reg.expand(dataInput.value); } catch (_) { expandedText = dataInput.value; }
        expandHint.textContent = 'Expanded: ' + expandedText;
      };
      dataInput.addEventListener('input', () => { updateExpandHint(); }, { signal: ac.signal });

      // REG_BINARY: hex grid viewer + hex edit mode.
      const binWrap = el('div', 'display:none;flex-direction:column;gap:4px;');
      const hexGrid = el('pre', 'margin:0;padding:8px;background:var(--bg-default,#0f1115);border:1px solid var(--border-subtle,#2a2f3a);border-radius:4px;font-family:monospace;font-size:10px;color:#7ee787;max-height:140px;overflow:auto;white-space:pre;');
      const binEditBtn = el('button', btnStyle(false), 'Edit as hex');
      binEditBtn.addEventListener('click', () => {
        try {
          const bytes = b64ToBytes(dataInput.value.trim() || '');
          const hexOnly = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
          const edited = window.prompt('Hex bytes (spaces optional):', hexOnly);
          if (edited !== null) dataInput.value = parseHexToB64(edited);
          paintBinary();
        } catch (err) { window.alert('Hex parse failed: ' + errorMessage(err)); }
      }, { signal: ac.signal });
      function paintBinary() {
        try {
          const bytes = b64ToBytes(dataInput.value.trim() || '');
          hexGrid.textContent = bytes.length ? toHexGrid(bytes) : '(empty)';
        } catch (_) { hexGrid.textContent = '(invalid base64)'; }
      }
      dataInput.addEventListener('input', () => { if (typeSelect.value === 'REG_BINARY') paintBinary(); }, { signal: ac.signal });
      binWrap.append(hexGrid, binEditBtn);

      function syncEditorForType(type) {
        dataInput.style.display = type === 'REG_BOOL' ? 'none' : 'block';
        boolWrap.style.display = type === 'REG_BOOL' ? 'block' : 'none';
        radixWrap.style.display = (type === 'REG_DWORD' || type === 'REG_QWORD') ? 'flex' : 'none';
        multiHint.style.display = type === 'REG_MULTI_SZ' ? 'block' : 'none';
        binWrap.style.display = type === 'REG_BINARY' ? 'flex' : 'none';
        dataLabel.textContent = type === 'REG_JSON' ? 'Data (JSON)'
          : type === 'REG_BINARY' ? 'Data (base64)'
          : type === 'REG_MULTI_SZ' ? 'Data (one string per line)'
          : 'Data';
        if (type === 'REG_BINARY') paintBinary();
        updateExpandHint();
      }
      typeSelect.addEventListener('change', () => syncEditorForType(typeSelect.value), { signal: ac.signal });

      if (entry) {
        typeSelect.value = entry.type;
        if (entry.type === 'REG_BOOL') boolSelect.value = entry.data ? 'true' : 'false';
        else if (entry.type === 'REG_JSON') dataInput.value = JSON.stringify(entry.data, null, 2);
        else if (entry.type === 'REG_MULTI_SZ') dataInput.value = (entry.data || []).join('\n');
        else if (entry.type === 'REG_DWORD' || entry.type === 'REG_QWORD') {
          dwordRadix = 16;
          dataInput.value = Number(entry.data).toString(16);
        }
        else dataInput.value = String(entry.data);
      } else {
        typeSelect.value = 'REG_SZ';
      }
      paintRadix();
      syncEditorForType(typeSelect.value);

      const errorLine = el('div', 'margin-top:8px;color:#f85149;font-size:11px;min-height:14px;');
      box.append(nameLabel, nameInput, typeLabel, typeSelect, dataLabel, dataInput, boolWrap, radixWrap, multiHint, expandHint, binWrap, errorLine);

      const { row, save } = closeButtonRow(box);
      box.appendChild(row);
      save.addEventListener('click', () => {
        let valueName = (nameInput.value || '').trim();
        if (isDefaultRow && !valueName) valueName = DEFAULT_NAME;
        if (!valueName || /[\/\\]/.test(valueName) || valueName === '.' || valueName === '..') {
          errorLine.textContent = 'Invalid value name.'; return;
        }
        let value;
        try {
          value = typeSelect.value === 'REG_BOOL' ? (boolSelect.value === 'true') : coerceForType(typeSelect.value, dataInput.value);
        } catch (err) {
          errorLine.textContent = 'Invalid data for ' + typeSelect.value + ': ' + errorMessage(err); return;
        }
        try {
          Reg.set(selectedPath + '/' + valueName, value, { type: typeSelect.value, actor: SELF });
          // Live-apply mapped shell keys exactly like the sandbox handler
          // does for nova:reg:set — the settings:changed fan-out repaints
          // wallpaper/theme/accent/pins immediately.
          const settingsKey = Reg.SETTINGS_PATH_TO_KEY && Reg.SETTINGS_PATH_TO_KEY[selectedPath + '/' + valueName];
          if (settingsKey && typeof OS.settings?.set === 'function') {
            try { OS.settings.set(settingsKey, value); } catch (_) { /* non-fatal */ }
          }
          backClose(box);
          selectedValue = valueName;
          refresh().then(() => setStatus('Saved ' + selectedPath + '/' + valueName));
        } catch (err) {
          errorLine.textContent = errorMessage(err);
        }
      }, { signal: ac.signal });

      content.appendChild(back);
      if (isNew) nameInput.focus(); else dataInput.focus();
    }

    // ── go ─────────────────────────────────────────────────────────────
    renderHistoryDatalist();
    refresh();
  },
});
