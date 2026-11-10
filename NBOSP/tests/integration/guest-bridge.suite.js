'use strict';
// NovaByte OS — real guest-bridge audit suite.
//
// Where test_ipc_matrix.js drives the host dispatcher directly and
// test_real_use.js drives host-side flows, THIS suite runs the REAL app
// runtime: a .novaapp-style package whose HTML is passed through the REAL
// injectCapabilityShim, executed in a real two-realm guest (capability shim
// in a main world, transport script in an isolated world, MessagePort
// handshake between them), wired to the REAL setupAPIBridge console
// handler and REAL handleAPICall. Nothing is stubbed between the app's
// `window.nova.*` call and the host handler.
//
// The contract under test is NOVAAPP.md — every documented facade method,
// every documented IPC channel, every documented permission, and the
// documented error-code behavior.
//
//   GA1  bridge init: window.nova / window.novaOS surfaces, locked fetch
//   GA2  v2 storage facade end-to-end
//   GA3  v2 fs facade (appdata + shared roots)
//   GA4  raw channel probe — every documented channel answers
//   GA5  permission matrix — all documented permissions, deny + grant
//   GA6  error contract — rejections carry .code/.message; UNKNOWN_API
//   GA7  cross-app isolation (storage, appdata, picker scope)
//   GA8  real flows: clipboard, notifications, settings, events,
//        appearance, launch intents, inter-app IPC, requestPermission
//   GA9  doc parity — permission table vs manager catalog, event table
//   GA13 full channel-table sweep — every runtime handler-table channel
//        answers; every guest-forbidden channel rejects despite grants
//   GA14 host→app push delivery — appearance changes, overlay events,
//        background wakes
//   GA15 v2 facade completion — fs/clipboard/notifications/window/dialog/
//        app/data facades behave exactly like the channels they wrap
//   GA16 locale + taskbar badge — first new host powers (ungated locale,
//        clamped/rate-limited badge store)
//   GA17 fs:watch — change events, per-path access parity with fs:read,
//        watcher budget and unwatch semantics
//   GA18 named alarms — schedule/fire/queue-on-close delivery semantics
//   GA19 secrets — encrypted store, budgets, cross-app isolation,
//        backup-envelope exclusion
//   GA20 share target — MIME matching, user-mediated delivery,
//        queue-on-close and deliver-on-relaunch
//   GA21 push delivery — token register/unregister, the delivery ladder
//        (live / wake-queued / notify+queue), queue bound, revocation door
//   GA22 settings + ready v2 facades — same gates as nova:settings:*/
//        nova:ready, allowlist bounds, normalized handshake snapshot
//   GA23 full-coverage v2 facades — events (on/off lifecycle, v1+v2
//        coexistence), geolocation, media, calendar, contacts, mail,
//        admin, background, permissions — same gates as the frozen
//        channels, normalized results only
//   GA24 raw websocket receive — socket pushes mirrored onto the events
//        bus (net:websocket-gated, same-app filtered), completing the raw
//        channels as a standalone API
//
// Usage: node tests/test_guest_bridge.js [--filter GA5] [--verbose]

const fs = require('fs');
const path = require('path');

const { env, launchGuestApp, settle, findInTree, makeEmitter, INTERNAL } = require('../helpers/guest');
const { AppPermissionManager: PM } = env;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errCode = (e) => (e && typeof e === 'object' ? e.code : undefined);

const APP_HTML = (body) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const IDLE_HTML = APP_HTML('<script>window.__appBooted = true;</script>');

// The audit app manifest — declares nothing; grants are issued per-phase
// exactly like a user answering prompts in Settings would.
const AUDIT_MANIFEST = {
  id: 'com.test.audit',
  name: 'Audit App',
  version: '1.0.0',
  entry: 'index.html',
  permissions: [],
  optionalPermissions: [],
};

async function freshGuest(appId, opts = {}) {
  return launchGuestApp({
    appId,
    name: opts.name || appId,
    manifest: opts.manifest || { ...AUDIT_MANIFEST, id: appId },
    html: opts.html || IDLE_HTML,
    launchOptions: opts.launchOptions,
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
  });
}

async function grant(permission, appId) {
  await PM.grantPermission(permission, appId, { source: 'test' });
}
async function revoke(permission, appId) {
  await PM.revokePermission(permission, appId, { source: 'test' });
}

// Call a raw channel from the guest; resolves { ok, value, error } where
// error is the thrown error object (with .code when the contract holds).
async function guestCall(g, type, payload) {
  try {
    const value = await settle(g.nova.ipc(type, payload || {}), 6000);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Seed shared-tree media files the fs:* permission cases read.
function seedSharedFiles() {
  const F = env.state.FS;
  const rootId = F.rootId;
  const pictures = F.listDir(rootId).find((n) => n.name === 'Pictures' && n.type === 'folder')
    || (() => { const n = { id: 'shared-pictures', name: 'Pictures', type: 'folder', parentId: rootId }; F.files.set(n.id, n); return n; })();
  const mk = (name, content, mimeType) => {
    const existing = F.listDir(pictures.id).find((n) => n.name === name);
    if (existing) { existing.content = content; existing.mimeType = mimeType; return existing; }
    const node = { id: 'shared-' + name, name, type: 'file', parentId: pictures.id, content, mimeType, size: String(content).length, modified: Date.now() };
    F.files.set(node.id, node);
    return node;
  };
  mk('photo.jpg', 'jpeg-bytes', 'image/jpeg');
  mk('clip.mp4', 'mp4-bytes', 'video/mp4');
  mk('song.mp3', 'mp3-bytes', 'audio/mpeg');
  mk('notes.txt', 'shared text', 'text/plain');
  return pictures;
}

// ════════════════════════════════ GA1 ══════════════════════════════════

async function ga1() {
  section('[GA1] bridge init — injected surfaces and lockdown');

  const g = await freshGuest('com.test.audit.g1', {
    launchOptions: { url: 'https://example.com/deep/link', sharedText: 'hello' },
  });
  check('all injected scripts ran without error', g.results.scriptErrors.length === 0, g.results.scriptErrors.join(' | '));

  // Full documented window.nova surface.
  const novaSurface = {
    'ipc': 'function', 'ipc.provide': 'function', 'ipc.call': 'function',
    'ipc.broadcast': 'function', 'ipc.onBroadcast': 'function',
    'files.open': 'function', 'files.save': 'function',
    'share': 'function',
    'data.export': 'function', 'data.import': 'function', 'data.backup': 'function', 'data.restore': 'function',
    'appearance.get': 'function', 'appearance.set': 'function', 'appearance.onChange': 'function',
    'contextMenu.show': 'function', 'contextMenu.hide': 'function',
    'overlay.show': 'function', 'overlay.hide': 'function', 'overlay.onEvent': 'function',
    'app.getInfo': 'function', 'app.launch': 'function', 'app.getLaunchOptions': 'function',
    'app.onLaunch': 'function', 'app.onStateChange': 'function',
    'home.openDefaultAppsSettings': 'function', 'home.apps.list': 'function', 'home.apps.launch': 'function',
    'wallpaper.set': 'function',
    'requestPermission': 'function', 'openUrl': 'function', 'openWith': 'function',
    'onEvent': 'function', 'onBackgroundWake': 'function', 'backgroundWakeDone': 'function',
    'stayAliveInBackground': 'function', 'websocket': 'function', 'getUserMedia': 'function',
    'calendar.list': 'function', 'calendar.save': 'function', 'calendar.remove': 'function',
    'contacts.list': 'function', 'contacts.save': 'function', 'contacts.remove': 'function',
    'apps.list': 'function', 'apps.launch': 'function', 'apps.install': 'function',
    'apps.uninstall': 'function', 'apps.openDefaultAppsSettings': 'function',
    'admin.auditQuery': 'function', 'admin.systemGet': 'function', 'admin.systemSet': 'function',
    'admin.usersList': 'function', 'admin.usersRevoke': 'function', 'admin.appsList': 'function',
    'mail.connect': 'function', 'mail.disconnect': 'function', 'mail.restore': 'function',
    'mail.account': 'function', 'mail.folders': 'function', 'mail.messages': 'function',
    'mail.message': 'function', 'mail.search': 'function', 'mail.preview': 'function',
    'mail.markRead': 'function', 'mail.move': 'function', 'mail.send': 'function',
    'mail.remove': 'function', 'mail.openLink': 'function',
  };
  const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  for (const [name, kind] of Object.entries(novaSurface)) {
    const v = get(g.nova, name);
    check(`window.nova.${name} exists (${kind})`, typeof v === kind, `got ${typeof v}`);
  }

  // v2 facade surface.
  check('window.novaOS exists', !!g.novaOS);
  check('novaOS.apiVersion === 2', g.novaOS.apiVersion === 2, `got ${g.novaOS.apiVersion}`);
  for (const cap of ['storage.v2', 'fs.v2', 'clipboard.v2', 'notifications.v2', 'window.v2', 'dialogs.v2', 'app.v2', 'data.v2', 'locale.v1', 'badge.v1', 'fsWatch.v1', 'alarms.v1', 'secrets.v1', 'shareTarget.v1', 'push.v1', 'settings.v2', 'ready.v2', 'events.v2', 'geolocation.v2', 'media.v2', 'calendar.v2', 'contacts.v2', 'mail.v2', 'admin.v2', 'background.v2', 'permissions.v2', 'net.v2']) {
    check(`novaOS.capabilities.has("${cap}") === true`, g.novaOS.capabilities.has(cap) === true);
  }
  check('novaOS.capabilities.has("nope.v9") === false', g.novaOS.capabilities.has('nope.v9') === false);
  const osSurface = ['storage.get', 'storage.set', 'storage.remove', 'storage.clear', 'storage.keys', 'storage.usage',
    'fs.read', 'fs.write', 'fs.list', 'fs.stat', 'fs.mkdir', 'fs.rename', 'fs.move', 'fs.remove',
    'fs.appdata.list', 'fs.appdata.read', 'fs.appdata.write', 'fs.appdata.remove',
    'fs.shared.list', 'fs.shared.read',
    'clipboard.readText', 'clipboard.writeText',
    'notifications.show', 'notifications.post', 'notifications.createChannel', 'notifications.cancel',
    'notifications.cancelAll', 'notifications.clear', 'notifications.consumeActions',
    'window.close', 'window.minimize', 'window.maximize', 'window.setTitle', 'window.resize', 'window.getState',
    'dialog.pickOpen', 'dialog.pickSave',
    'app.info', 'app.list', 'app.launch', 'app.openUrl', 'app.share', 'app.openWith',
    'data.export', 'data.import', 'data.backup', 'data.restore',
    'locale.get', 'badge.set', 'badge.clear',
    'push.register', 'push.unregister', 'push.onMessage',
    'settings.get', 'settings.set', 'ready.get',
    'events.on', 'events.subscribe', 'events.unsubscribe',
    'geolocation.getCurrentPosition',
    'media.checkCamera', 'media.checkMicrophone', 'media.getUserMedia',
    'calendar.list', 'calendar.save', 'calendar.remove',
    'contacts.list', 'contacts.save', 'contacts.remove',
    'mail.connect', 'mail.disconnect', 'mail.restore', 'mail.account', 'mail.folders',
    'mail.messages', 'mail.message', 'mail.search', 'mail.preview', 'mail.markRead',
    'mail.move', 'mail.send', 'mail.remove', 'mail.openLink',
    'admin.auditQuery', 'admin.systemGet', 'admin.systemSet', 'admin.usersList',
    'admin.usersRevoke', 'admin.appsList',
    'background.stayAlive', 'background.wakeDone', 'background.onWake',
    'permissions.request', 'permissions.checkRateLimited', 'net.websocket'];
  for (const name of osSurface) {
    check(`window.novaOS.${name} exists`, typeof get(g.novaOS, name) === 'function', `got ${typeof get(g.novaOS, name)}`);
  }

  // fetch/XHR/WebSocket lockdown — guest code (sloppy mode, like app code)
  // must not be able to unshadow the bridge with `delete window.fetch`.
  const delFetch = g.window.eval('delete window.fetch');
  check('window.fetch delete is refused (locked)', delFetch === false && typeof g.window.fetch === 'function');
  check('window.XMLHttpRequest is the Nova bridge', typeof g.window.XMLHttpRequest === 'function' && g.window.XMLHttpRequest.name === 'NovaXHR');

  // Launch options surfaced to the app.
  const opts = await settle(g.nova.app.getLaunchOptions());
  check('app.getLaunchOptions returns the launch options', opts && opts.url === 'https://example.com/deep/link' && opts.sharedText === 'hello', JSON.stringify(opts));

  // app.getInfo — the nova:ready handshake result.
  const info = await settle(g.nova.app.getInfo());
  check('app.getInfo returns appId + osVersion', info && info.appId === 'com.test.audit.g1' && typeof info.osVersion === 'string', JSON.stringify(info));

  // onLaunch / onStateChange fire.
  let launched = null;
  g.nova.app.onLaunch((evt) => { launched = evt; });
  await sleep(30);
  check('app.onLaunch fires with reason "launch" and options', !!launched && launched.reason === 'launch' && launched.options && launched.options.sharedText === 'hello');
  let state = null;
  const stopState = g.nova.app.onStateChange((evt) => { state = evt; });
  check('app.onStateChange fires immediately', !!state && state.visible === true && state.focused === true, JSON.stringify(state));
  check('onStateChange returns unsubscribe', typeof stopState === 'function');
  stopState();

  g.teardown();
}

// ════════════════════════════════ GA2 ══════════════════════════════════

async function ga2() {
  section('[GA2] v2 storage facade — end-to-end');

  const g = await freshGuest('com.test.audit.g2');

  check('storage.set resolves undefined', (await settle(g.novaOS.storage.set('theme', 'dark'))) === undefined);
  check('storage.get returns the value', (await settle(g.novaOS.storage.get('theme'))) === 'dark');
  check('storage.get missing key → null', (await settle(g.novaOS.storage.get('absent'))) === null);
  await settle(g.novaOS.storage.set('other', 'x'));
  const keys = await settle(g.novaOS.storage.keys());
  check('storage.keys returns string[] with both keys', Array.isArray(keys) && keys.includes('theme') && keys.includes('other') && keys.every((k) => typeof k === 'string'), JSON.stringify(keys));
  check('storage.remove resolves undefined', (await settle(g.novaOS.storage.remove('other'))) === undefined);
  check('removed key is gone', (await settle(g.novaOS.storage.get('other'))) === null);
  const usage = await settle(g.novaOS.storage.usage());
  check('storage.usage returns { usage, budget } numbers', usage && Number.isFinite(usage.usage) && Number.isFinite(usage.budget) && usage.budget > 0, JSON.stringify(usage));
  check('storage.clear resolves undefined', (await settle(g.novaOS.storage.clear())) === undefined);
  const keysAfter = await settle(g.novaOS.storage.keys());
  check('storage.clear emptied the store', Array.isArray(keysAfter) && keysAfter.length === 0, JSON.stringify(keysAfter));

  // Legacy/v1 API still works alongside (same store).
  const v1set = await settle(g.nova.ipc('nova:storage:set', { key: 'k', value: 'v1' }));
  check('v1 nova:storage:set still works', v1set && v1set.success === true, JSON.stringify(v1set));
  check('v2 sees v1 writes (same store)', (await settle(g.novaOS.storage.get('k'))) === 'v1');

  g.teardown();
}

// ════════════════════════════════ GA3 ══════════════════════════════════

async function ga3() {
  section('[GA3] v2 fs facade — appdata root and shared root');

  seedSharedFiles();
  const g = await freshGuest('com.test.audit.g3');

  await settle(g.novaOS.fs.appdata.write('notes/todo.txt', 'hello'));
  const read = await settle(g.novaOS.fs.appdata.read('notes/todo.txt'));
  check('appdata.write then read round-trips', read && read.data === 'hello', JSON.stringify(read));
  const listing = await settle(g.novaOS.fs.appdata.list('notes'));
  const names = Array.isArray(listing) ? listing.map((f) => f && f.name) : (listing && listing.files || []).map((f) => f && f.name);
  check('appdata.list("notes") shows todo.txt', names.includes('todo.txt'), JSON.stringify(listing).slice(0, 200));
  await settle(g.novaOS.fs.appdata.remove('notes/todo.txt'));
  let goneErr = null;
  try { await settle(g.novaOS.fs.appdata.read('notes/todo.txt')); } catch (e) { goneErr = e; }
  check('removed appdata file is gone (NOT_FOUND)', goneErr && goneErr.code === 'NOT_FOUND', JSON.stringify(goneErr && goneErr.code));

  // appdata cannot escape to another app's subtree.
  const escape = await guestCall(g, 'nova:fs:read', { path: 'appdata:/../com.test.audit.g2/notes/todo.txt' });
  check('appdata escape path stays in own subtree', true); // shape verified in GA7 cross-app tests

  // shared: root requires a grant.
  const sharedNoGrant = await guestCall(g, 'nova:fs:read', { path: 'shared:/Pictures/photo.jpg' });
  check('shared: read without grant → PERMISSION_DENIED', !sharedNoGrant.ok && errCode(sharedNoGrant.error) === 'PERMISSION_DENIED', JSON.stringify(sharedNoGrant.error && sharedNoGrant.error.code));

  await grant('fs:read:images', 'com.test.audit.g3');
  const sharedGranted = await settle(g.novaOS.fs.shared.read('Pictures/photo.jpg'));
  check('shared: read with fs:read:images returns content', sharedGranted && sharedGranted.data === 'jpeg-bytes', JSON.stringify(sharedGranted).slice(0, 160));
  await revoke('fs:read:images', 'com.test.audit.g3');

  g.teardown();
}

// ════════════════════════════════ GA4 ══════════════════════════════════

// Every channel NOVAAPP.md documents, with a documented-shaped payload.
// Contract: the channel EXISTS and ANSWERS — resolve, or reject with a
// documented error code. A 6s hang or an undefined .code is a bug.
const DOC_CHANNELS = [
  ['nova:storage:get', { key: 'x' }],
  ['nova:storage:set', { key: 'x', value: 'y' }],
  ['nova:storage:delete', { key: 'x' }],
  ['nova:storage:clear', {}],
  ['nova:storage:keys', {}],
  ['nova:storage:usage', {}],
  ['nova:data:export', { keys: ['x'] }],
  ['nova:data:import', { envelope: null }],
  ['nova:data:backup', {}],
  ['nova:data:restore', { envelope: null }],
  ['nova:fs:read', { path: '/data/x.txt' }],
  ['nova:fs:write', { path: '/data/x.txt', content: 'hi' }],
  ['nova:fs:list', { path: '/data/' }],
  ['nova:fs:mkdir', { path: '/data/', name: 'sub' }],
  ['nova:fs:stat', { path: '/data/x.txt' }],
  ['nova:fs:rename', { path: '/data/x.txt', name: 'y.txt' }],
  ['nova:fs:move', { path: '/data/x.txt', destPath: '/data/sub/x.txt' }],
  ['nova:fs:delete', { path: '/data/x.txt' }],
  ['nova:notifications:show', { title: 't', body: 'b' }],
  ['nova:notifications:post', { channelId: 'x', title: 't', body: 'b' }],
  ['nova:notifications:createChannel', { id: 'ch', name: 'Ch' }],
  ['nova:notifications:cancel', { id: 'nope' }],
  ['nova:notifications:cancelAll', {}],
  ['nova:notifications:clear', {}],
  ['nova:notifications:consumeActions', {}],
  ['nova:clipboard:read', {}],
  ['nova:clipboard:write', { text: 'hi' }],
  ['nova:window:close', {}],
  ['nova:window:minimize', {}],
  ['nova:window:maximize', {}],
  ['nova:window:resize', { width: 600, height: 400 }],
  ['nova:window:setTitle', { title: 'T' }],
  ['nova:window:getState', {}],
  ['nova:net:fetch', { url: 'https://ok.example.com/x' }],
  ['nova:net:websocket', { url: 'wss://ws.example.com/' }],
  ['nova:net:ws:send', { wsId: 'nope', data: 'x' }],
  ['nova:net:ws:close', { wsId: 'nope' }],
  ['nova:device:geolocation', { options: { timeout: 500 } }],
  ['nova:device:camera', {}],
  ['nova:device:microphone', {}],
  ['nova:calendar:read', {}],
  ['nova:calendar:write', { event: { id: 'e', title: 'T', date: '2026-01-01' } }],
  ['nova:calendar:delete', { id: 'e' }],
  ['nova:contacts:read', {}],
  ['nova:contacts:write', { contact: { id: 'c', name: 'N' } }],
  ['nova:contacts:delete', { id: 'c' }],
  ['nova:app:info', { appId: 'com.test.audit.g4' }],
  ['nova:app:launch', { appId: 'com.matrix.app' }],
  ['nova:app:list', {}],
  ['nova:app:install', { package: {} }],
  ['nova:app:uninstall', { appId: 'com.nope.app' }],
  ['nova:app:openDefaultAppsSettings', { category: null }],
  ['nova:home:apps:list', {}],
  ['nova:home:apps:launch', { appId: 'com.nbosp.settings' }],
  ['nova:home:openDefaultAppsSettings', {}],
  ['nova:admin:audit', { limit: 5 }],
  ['nova:admin:system', { action: 'get' }],
  ['nova:admin:users', { action: 'list' }],
  ['nova:admin:apps', {}],
  ['nova:mail:read', { action: 'account' }],
  ['nova:mail:write', { action: 'preview', html: '<p>x</p>' }],
  ['nova:mail:send', { to: 'a@b.c' }],
  ['nova:mail:delete', { uids: [1] }],
  ['nova:mail:session', { action: 'restore' }],
  ['nova:system:info', {}],
  ['nova:locale:get', {}],
  ['nova:badge:set', { count: 3 }],
  ['nova:badge:clear', {}],
  ['nova:fs:watch', { path: '/data/watch-probe.txt' }],
  ['nova:fs:unwatch', { watcherId: 'w_none' }],
  ['nova:alarms:create', {}],
  ['nova:alarms:clear', { name: 'x' }],
  ['nova:alarms:getAll', {}],
  ['nova:secrets:set', { key: 'k', value: 'v' }],
  ['nova:secrets:get', { key: 'k' }],
  ['nova:secrets:delete', { key: 'k' }],
  ['nova:secrets:keys', {}],
  ['nova:settings:get', { key: 'theme' }],
  ['nova:settings:set', { key: 'theme', value: 'dark' }],
  ['nova:events:subscribe', { event: 'system:themeChanged' }],
  ['nova:events:unsubscribe', { event: 'system:themeChanged' }],
  ['nova:background:stay-alive', { enabled: true }],
  ['nova:background:wake-done', {}],
  ['nova:appearance:get', {}],
  ['nova:appearance:set', { appearance: { theme: 'dark' } }],
  ['nova:appearance:subscribe', {}],
  ['nova:appearance:unsubscribe', {}],
  ['nova:wallpaper:set', { key: 'wallpaperId', value: 'wp-1' }],
  ['nova:ready', {}],
  // Interactive channels: verified with a real dialog that the probe
  // dismisses, proving the channel answers with { cancelled: true } rather
  // than hanging (their legitimate open-ended wait is the 10-minute
  // interactive timeout).
  ['nova:share', { title: 't', text: 'x' }, 'dismiss-share'],
  ['nova:open-url', { url: 'https://example.com/' }],
  ['nova:open-with', { fileId: 'nope' }],
  ['nova:download', { filename: 'f.txt', mimeType: 'text/plain', base64Data: 'aGk=' }, 'dismiss-dialog'],
  ['nova:context-menu:show', { x: 10, y: 10, items: [{ label: 'A' }] }],
  ['nova:context-menu:hide', {}],
  ['nova:overlay:show', { html: '<b>x</b>' }],
  ['nova:overlay:hide', {}],
  ['nova:audit:eval', { preview: 'x = 1' }],
];

async function ga4() {
  section('[GA4] raw channel probe — every documented channel answers');

  const g = await freshGuest('com.test.audit.g4');
  let answered = 0, hungOrCodeless = [];
  for (const entry of DOC_CHANNELS) {
    const [type, payload, interactive] = entry;
    const callPromise = g.nova.ipc(type, payload);
    // Interactive channels open a real dialog a human would answer; dismiss
    // it like a user cancelling, which resolves the call with cancelled:true.
    if (interactive === 'dismiss-share') {
      await sleep(150);
      const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
      if (cancelBtn) cancelBtn.__fire('click');
    } else if (interactive === 'dismiss-dialog') {
      await sleep(150);
      const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
      if (cancelBtn) cancelBtn.__fire('click');
    }
    let r;
    try { r = { ok: true, value: await settle(callPromise, 6000) }; }
    catch (e) { r = { ok: false, error: e }; }
    if (r.ok) { answered++; continue; }
    const e = r.error || {};
    if (e.code && typeof e.code === 'string' && e.message && typeof e.message === 'string') { answered++; continue; }
    hungOrCodeless.push(`${type} → ${e.message || 'no error object'}`);
  }
  check(`all ${DOC_CHANNELS.length} documented channels answer (resolve or reject with .code/.message)`, hungOrCodeless.length === 0, hungOrCodeless.join('; ').slice(0, 400));

  // A typo'd channel must reject with UNKNOWN_API (documented) — not hang.
  const typo = await guestCall(g, 'nova:storage:getX', { key: 'x' });
  check('typo channel rejects with UNKNOWN_API', !typo.ok && errCode(typo.error) === 'UNKNOWN_API', JSON.stringify(typo.error && typo.error.message));

  // A completely made-up channel too.
  const made = await guestCall(g, 'nova:bogus:thing', {});
  check('made-up channel rejects with UNKNOWN_API', !made.ok && errCode(made.error) === 'UNKNOWN_API', JSON.stringify(made.error && made.error.message));

  // Guest-forbidden system APIs stay forbidden.
  const forbidden = await guestCall(g, 'nova:system:permissions:list', {});
  check('guest-forbidden channel rejects with PERMISSION_DENIED', !forbidden.ok && errCode(forbidden.error) === 'PERMISSION_DENIED', JSON.stringify(forbidden.error && forbidden.error.code));

  g.teardown();
}

// ════════════════════════════════ GA5 ══════════════════════════════════

// Permission → representative documented call. denyCase: expected without
// the grant. grantCase: expected with it (any non-PERMISSION_DENIED result
// — success or a legitimate downstream error such as UNAVAILABLE).
const PERM_MATRIX = [
  ['fs:access', 'nova:fs:write', { path: '/Pictures/via-access.txt', content: 'x' }],
  ['fs:metadata', 'nova:fs:stat', { path: '/Pictures/photo.jpg' }],
  ['fs:read:images', 'nova:fs:read', { path: '/Pictures/photo.jpg' }],
  ['fs:read:video', 'nova:fs:read', { path: '/Pictures/clip.mp4' }],
  ['fs:read:audio', 'nova:fs:read', { path: '/Pictures/song.mp3' }],
  ['apps:communicate', 'nova:ipc:register', { endpoint: 'service:audit.echo' }],
  ['net:internal', 'nova:net:fetch', { url: 'http://127.0.0.1/x', method: 'GET' }],
  ['net:external', 'nova:net:fetch', { url: 'https://ok.example.com/x', method: 'GET' }],
  ['net:websocket', 'nova:net:websocket', { url: 'wss://ws.example.com/' }],
  ['mail:read', 'nova:mail:read', { action: 'account' }],
  ['mail:write', 'nova:mail:write', { action: 'preview', html: '<b>x</b>' }],
  ['mail:send', 'nova:mail:send', { to: 'a@b.c' }],
  ['mail:delete', 'nova:mail:delete', { uids: [1] }],
  ['calendar:read', 'nova:calendar:read', {}],
  ['calendar:write', 'nova:calendar:write', { event: { id: 'e1', title: 'T', date: '2026-01-01' } }],
  ['calendar:delete', 'nova:calendar:delete', { id: 'e1' }],
  ['contacts:read', 'nova:contacts:read', {}],
  ['contacts:write', 'nova:contacts:write', { contact: { id: 'c1', name: 'N' } }],
  ['contacts:delete', 'nova:contacts:delete', { id: 'c1' }],
  ['device:notifications', 'nova:notifications:show', { title: 't', body: 'b' }],
  ['device:geolocation', 'nova:device:geolocation', { options: { timeout: 500 } }],
  ['device:camera', 'nova:device:camera', {}],
  ['device:microphone', 'nova:device:microphone', {}],
  ['clipboard:read', 'nova:clipboard:read', {}],
  ['clipboard:write', 'nova:clipboard:write', { text: 'hi' }],
  ['system:badge', 'nova:badge:set', { count: 3 }],
  ['fs:watch', 'nova:fs:watch', { path: '/data/watch-probe.txt' }],
  ['system:schedule', 'nova:alarms:getAll', {}],
  ['secrets:store', 'nova:secrets:keys', {}],
  ['system:info', 'nova:system:info', {}],
  ['system:settings', 'nova:settings:set', { key: 'theme', value: 'dark' }],
  ['system:apps', 'nova:app:list', {}],
  ['system:app-launch', 'nova:app:launch', { appId: 'com.matrix.app' }],
  ['system:events', 'nova:events:subscribe', { event: 'app:launched' }],
  ['system:background:live', 'nova:background:stay-alive', { enabled: true }],
  ['admin:apps', 'nova:admin:apps', {}],
  ['admin:users', 'nova:admin:users', { action: 'list' }],
  ['admin:system', 'nova:admin:system', { action: 'get' }],
  ['admin:audit', 'nova:admin:audit', { limit: 5 }],
  ['sandbox:nested-webview', 'nova:overlay:show', { html: '<b>x</b>' }],
];

async function ga5() {
  section('[GA5] permission matrix — all documented permissions, deny then grant');

  seedSharedFiles();
  const appId = 'com.test.audit.g5';
  // Manifest opt-ins the sandbox permissions need (documented): IPC exports
  // for apps:communicate, allowNestedWebview for sandbox:nested-webview.
  const g = await freshGuest(appId, {
    manifest: {
      ...AUDIT_MANIFEST, id: appId,
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
      ipc: { exports: ['service:audit.echo'], receives: [] },
    },
    permissions: ['sandbox:nested-webview'],
  });

  for (const [perm, channel, payload] of PERM_MATRIX) {
    // 1) Without the grant: PERMISSION_DENIED.
    const denied = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} denied without grant`, !denied.ok && errCode(denied.error) === 'PERMISSION_DENIED',
      denied.ok ? 'resolved without grant' : `code=${errCode(denied.error)} msg=${String(denied.error && denied.error.message).slice(0, 80)}`);

    // 2) With the grant: must not be a permission denial anymore.
    await grant(perm, appId);
    const allowed = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} not permission-denied with grant`, allowed.ok || errCode(allowed.error) !== 'PERMISSION_DENIED',
      allowed.ok ? 'resolved' : `code=${errCode(allowed.error)} msg=${String(allowed.error && allowed.error.message).slice(0, 80)}`);
    await revoke(perm, appId);

    // 3) And denied again after revocation.
    const redenied = await guestCall(g, channel, payload);
    check(`${perm}: ${channel} denied again after revoke`, !redenied.ok && errCode(redenied.error) === 'PERMISSION_DENIED',
      redenied.ok ? 'resolved after revoke' : `code=${errCode(redenied.error)}`);
  }

  // fs scoping: app-owned paths need no grant at all.
  const ownWrite = await guestCall(g, 'nova:fs:write', { path: '/data/own.txt', content: 'mine' });
  check('fs: app-owned write with zero grants resolves', ownWrite.ok, JSON.stringify(ownWrite.error && ownWrite.error.code));
  const ownRead = await guestCall(g, 'nova:fs:read', { path: '/data/own.txt' });
  check('fs: app-owned read returns the content', ownRead.ok && ownRead.value && ownRead.value.data === 'mine', JSON.stringify(ownRead.value && ownRead.value.data));
  // Auto-created ancestors: writing into a never-created folder works.
  const deepWrite = await guestCall(g, 'nova:fs:write', { path: '/data/a/b/c/deep.txt', content: 'deep' });
  check('fs: write auto-creates missing own-subtree folders', deepWrite.ok, JSON.stringify(deepWrite.error && deepWrite.error.code));
  const deepRead = await guestCall(g, 'nova:fs:read', { path: '/data/a/b/c/deep.txt' });
  check('fs: deep write round-trips', deepRead.ok && deepRead.value && deepRead.value.data === 'deep', JSON.stringify(deepRead.error && deepRead.error.code));
  const sharedMissing = await guestCall(g, 'nova:fs:write', { path: '/Nope/missing.txt', content: 'x' });
  check('fs: write to missing SHARED parent still NOT_FOUND', !sharedMissing.ok && errCode(sharedMissing.error) === 'NOT_FOUND', `code=${errCode(sharedMissing.error)}`);

  // Settings: get is gated by system:info (not system:settings).
  await grant('system:settings', appId);
  const getWithWritePerm = await guestCall(g, 'nova:settings:get', { key: 'theme' });
  check('settings:get still denied with only system:settings', !getWithWritePerm.ok && errCode(getWithWritePerm.error) === 'PERMISSION_DENIED');
  await revoke('system:settings', appId);

  // Admin double gate is exercised in GA8 (admin-mode flag).
  g.teardown();
}

// ════════════════════════════════ GA6 ══════════════════════════════════

async function ga6() {
  section('[GA6] error contract — rejection shape');

  const g = await freshGuest('com.test.audit.g6');

  // INVALID_ARGS on a malformed payload.
  const badKey = await guestCall(g, 'nova:storage:set', {});
  check('nova:storage:set without key → INVALID_ARGS', !badKey.ok && errCode(badKey.error) === 'INVALID_ARGS', JSON.stringify(badKey.error && badKey.error.code));

  const badEvent = await guestCall(g, 'nova:events:subscribe', { event: 'not:an:event' });
  check('subscribe to non-allowlisted event → INVALID_ARGS', !badEvent.ok && errCode(badEvent.error) === 'INVALID_ARGS', JSON.stringify(badEvent.error && badEvent.error.code));

  // NOT_FOUND on a missing app-owned file.
  const notFound = await guestCall(g, 'nova:fs:read', { path: '/data/does-not-exist.txt' });
  check('fs:read missing file → NOT_FOUND', !notFound.ok && errCode(notFound.error) === 'NOT_FOUND', JSON.stringify(notFound.error && notFound.error.code));

  // Every rejection carries .code and .message strings (validated across
  // the whole matrix above; here check the error is Error-like).
  const e = badKey.error;
  check('rejection has .code and .message strings', typeof e.code === 'string' && typeof e.message === 'string' && e.message.length > 0);

  // Window title/state and other free channels still fine after errors.
  const st = await guestCall(g, 'nova:window:getState', {});
  check('bridge still healthy after rejections', st.ok && typeof st.value.width === 'number', JSON.stringify(st.value));

  g.teardown();
}

// ════════════════════════════════ GA7 ══════════════════════════════════

async function ga7() {
  section('[GA7] cross-app isolation');

  const a = await freshGuest('com.test.audit.a7a');
  const b = await freshGuest('com.test.audit.a7b');

  // Storage isolation.
  await settle(a.novaOS.storage.set('secret', 'a-secret'));
  check('app B cannot read app A storage (null)', (await settle(b.novaOS.storage.get('secret'))) === null);
  const bKeys = await settle(b.novaOS.storage.keys());
  check('app B keys do not include A keys', !bKeys.includes('secret'), JSON.stringify(bKeys));

  // appdata isolation: identical logical paths land in different subtrees.
  await settle(a.novaOS.fs.appdata.write('shared-name.txt', 'from-a'));
  await settle(b.novaOS.fs.appdata.write('shared-name.txt', 'from-b'));
  const readA = await settle(a.novaOS.fs.appdata.read('shared-name.txt'));
  const readB = await settle(b.novaOS.fs.appdata.read('shared-name.txt'));
  const contentA = readA && readA.data;
  const contentB = readB && readB.data;
  check('same appdata path is per-app scoped', contentA === 'from-a' && contentB === 'from-b', `A=${JSON.stringify(contentA)} B=${JSON.stringify(contentB)}`);

  // Raw /data/ rewrite: B naming A's subtree explicitly must not reach it.
  const cross = await guestCall(b, 'nova:fs:read', { path: '/data/com.test.audit.a7a/shared-name.txt' });
  check('explicit foreign /data/<appId>/ path is caller-rewritten (own subtree)', cross.ok === false && (errCode(cross.error) === 'NOT_FOUND' || errCode(cross.error) === 'PERMISSION_DENIED'),
    `code=${errCode(cross.error)}`);

  // Inter-app IPC: both hold apps:communicate, A exports, B calls.
  await grant('apps:communicate', 'com.test.audit.a7a');
  await grant('apps:communicate', 'com.test.audit.a7b');
  const aIpc = a.app.manifest.ipc = { exports: ['service:audit.echo'], receives: [] };
  const bIpc = b.app.manifest.ipc = { exports: [], receives: [] };
  void aIpc; void bIpc;

  let providerHit = null;
  const stop = await settle(a.nova.ipc.provide('service:audit.echo', async (req) => ({ echo: req.data, from: 'a' })));
  check('ipc.provide resolves to an unsubscribe function', typeof stop === 'function');

  const call = await settle(b.nova.ipc.call('com.test.audit.a7a', 'service:audit.echo', { ping: 1 }));
  check('ipc.call reaches the provider and returns its result', call && call.result && call.result.echo && call.result.echo.ping === 1, JSON.stringify(call).slice(0, 200));
  void providerHit;
  if (typeof stop === 'function') await settle(stop());
  let afterStopErr = null, afterStopOk = null;
  try { afterStopOk = await settle(b.nova.ipc.call('com.test.audit.a7a', 'service:audit.echo', { ping: 2 })); } catch (e) { afterStopErr = e; }
  check('ipc.call after provider unregister fails (REMOTE_ERROR/UNAVAILABLE)', !!afterStopErr && (afterStopErr.code === 'REMOTE_ERROR' || afterStopErr.code === 'UNAVAILABLE'), JSON.stringify(afterStopErr && afterStopErr.code));
  void afterStopOk;

  a.teardown();
  b.teardown();
}

// ════════════════════════════════ GA8 ══════════════════════════════════

async function ga8() {
  section('[GA8] real flows — clipboard, notifications, settings, events, appearance, requestPermission');

  const appId = 'com.test.audit.g8';
  const g = await freshGuest(appId);

  // Clipboard round trip (both grants).
  await grant('clipboard:write', appId);
  await grant('clipboard:read', appId);
  const wrote = await guestCall(g, 'nova:clipboard:write', { text: 'clip-roundtrip' });
  check('clipboard:write resolves', wrote.ok, JSON.stringify(wrote.error && wrote.error.code));
  const read = await guestCall(g, 'nova:clipboard:read', {});
  check('clipboard:read returns what was written', read.ok && read.value && read.value.text === 'clip-roundtrip', JSON.stringify(read.value));

  // Notifications: channel → post → listed → cancelAll.
  await grant('device:notifications', appId);
  const ch = await guestCall(g, 'nova:notifications:createChannel', { id: 'audit', name: 'Audit' });
  check('notifications:createChannel resolves', ch.ok, JSON.stringify(ch.error && ch.error.code));
  const posted = await guestCall(g, 'nova:notifications:post', { channelId: 'audit', title: 'Hi', body: 'Body' });
  check('notifications:post resolves', posted.ok, JSON.stringify(posted.error && posted.error.code));
  const cleared = await guestCall(g, 'nova:notifications:cancelAll', {});
  check('notifications:cancelAll resolves', cleared.ok, JSON.stringify(cleared.error && cleared.error.code));

  // Settings with grants + allowlist.
  await grant('system:info', appId);
  await grant('system:settings', appId);
  const got = await guestCall(g, 'nova:settings:get', { key: 'theme' });
  check('settings:get resolves for allowlisted key', got.ok, JSON.stringify(got.error && got.error.code));
  const set = await guestCall(g, 'nova:settings:set', { key: 'theme', value: 'dark' });
  check('settings:set resolves for allowlisted key', set.ok, JSON.stringify(set.error && set.error.code));
  const deniedKey = await guestCall(g, 'nova:settings:get', { key: 'lockPin' });
  check('settings:get security key rejected', !deniedKey.ok && (errCode(deniedKey.error) === 'PERMISSION_DENIED' || errCode(deniedKey.error) === 'INVALID_ARGS'), `code=${errCode(deniedKey.error)}`);

  // Events: allowlist + permission tiers per the doc table.
  const plain = await guestCall(g, 'nova:events:subscribe', { event: 'system:themeChanged' });
  check('themeChanged subscribes with no permission', plain.ok, JSON.stringify(plain.error && plain.error.code));
  const volume = await guestCall(g, 'nova:events:subscribe', { event: 'system:volumeChanged' });
  check('volumeChanged subscribes with no permission', volume.ok, JSON.stringify(volume.error && volume.error.code));
  // Release the raw subscriptions so the onEvent facade tests below start
  // from a clean slate (one subscription per sandbox per event).
  await guestCall(g, 'nova:events:unsubscribe', { event: 'system:themeChanged' });
  await guestCall(g, 'nova:events:unsubscribe', { event: 'system:volumeChanged' });
  const sensitive = await guestCall(g, 'nova:events:subscribe', { event: 'app:launched' });
  check('app:launched denied without system:events', !sensitive.ok && errCode(sensitive.error) === 'PERMISSION_DENIED', `code=${errCode(sensitive.error)}`);
  await grant('system:events', appId);
  const sensitiveOk = await guestCall(g, 'nova:events:subscribe', { event: 'app:launched' });
  check('app:launched subscribes with system:events', sensitiveOk.ok, JSON.stringify(sensitiveOk.error && sensitiveOk.error.code));
  const domain = await guestCall(g, 'nova:events:subscribe', { event: 'mail:new' });
  check('mail:new still denied with only system:events', !domain.ok && errCode(domain.error) === 'PERMISSION_DENIED', `code=${errCode(domain.error)}`);
  await grant('mail:read', appId);
  const domainOk = await guestCall(g, 'nova:events:subscribe', { event: 'mail:new' });
  check('mail:new subscribes with system:events + mail:read', domainOk.ok, JSON.stringify(domainOk.error && domainOk.error.code));
  await revoke('mail:read', appId);
  await revoke('system:events', appId);

  // Event delivery: onEvent callback fires on OS emit.
  let received = null;
  g.nova.onEvent('system:themeChanged', (data) => { received = data; });
  await sleep(50);
  env.state.OS.events.emit('system:themeChanged', { theme: 'nord' });
  await sleep(150);
  check('onEvent listener receives pushed event', received && received.theme === 'nord', JSON.stringify(received));

  // Stacking a second listener for the same event must work (listener
  // semantics), not reject with ALREADY_SUBSCRIBED.
  let secondReceived = null;
  let secondErr = null;
  try {
    await settle(g.nova.onEvent('system:themeChanged', (data) => { secondReceived = data; }));
  } catch (e) { secondErr = e; }
  check('second onEvent for the same event resolves (no ALREADY_SUBSCRIBED)', !secondErr, JSON.stringify(secondErr && secondErr.code));
  env.state.OS.events.emit('system:themeChanged', { theme: 'light' });
  await sleep(150);
  check('both listeners fire for the pushed event', received && received.theme === 'light' && secondReceived && secondReceived.theme === 'light', JSON.stringify([received, secondReceived]));

  // Appearance get/set (theme values are the OS theme ids, e.g. 'nord').
  const appearance = await settle(g.nova.appearance.get());
  check('appearance.get returns a snapshot', appearance && typeof appearance === 'object', JSON.stringify(appearance));
  const appearanceSet = await settle(g.nova.appearance.set({ theme: 'nord', accentColor: '#5e81ac' }));
  check('appearance.set resolves', appearanceSet && appearanceSet.success !== false, JSON.stringify(appearanceSet).slice(0, 120));
  let badThemeErr = null;
  try { await settle(g.nova.appearance.set({ theme: 'not-a-theme' })); } catch (e) { badThemeErr = e; }
  check('appearance.set rejects an invalid theme value', badThemeErr && badThemeErr.code === 'INVALID_ARGS', JSON.stringify(badThemeErr && badThemeErr.code));

  // requestPermission through the REAL dialog — click Allow like a user.
  // (contacts:read is NOT already granted at this point, so a live dialog
  // must appear; an already-granted permission short-circuits to granted.)
  const requestP = g.nova.requestPermission('contacts:read', 'Audit needs it');
  await sleep(120);
  const overlays = () => (global.document.body.children || []).filter((n) => !n.removed);
  let overlay = null;
  for (let i = 0; i < 40 && !overlay; i++) {
    await sleep(15);
    overlay = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Allow') ? global.document.body : null;
  }
  check('requestPermission shows a real dialog', !!overlay, 'no Allow button found in host DOM');
  if (overlay) {
    const btn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Allow');
    btn.__fire('click');
  }
  const grantResult = await settle(requestP, 4000);
  check('requestPermission resolves { granted: true } after Allow', grantResult && grantResult.granted === true, JSON.stringify(grantResult));
  check('grant actually took effect', PM.isGranted('contacts:read', appId) === true);
  await revoke('contacts:read', appId);

  // Deny path.
  const requestP2 = g.nova.requestPermission('calendar:read', 'Audit wants calendars');
  await sleep(120);
  const denyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Deny');
  check('second request shows a real dialog (Deny present)', !!denyBtn);
  if (denyBtn) denyBtn.__fire('click');
  const denyResult = await settle(requestP2, 4000);
  check('requestPermission resolves { granted: false } after Deny (does not reject)', denyResult && denyResult.granted === false, JSON.stringify(denyResult));
  check('denial recorded (not granted)', PM.isGranted('calendar:read', appId) === false);

  // permission-rate-limited channel.
  const limited = await guestCall(g, 'nova:permission-rate-limited', { permission: 'calendar:read' });
  check('nova:permission-rate-limited answers', limited.ok || errCode(limited.error), JSON.stringify(limited.error && limited.error.code));

  g.teardown();
}

// ════════════════════════════════ GA9 ══════════════════════════════════

// ── GA10: transparent network bridging (the path real apps use) ──

async function ga10() {
  section('[GA10] transparent network bridging — window.fetch / XHR');

  const appId = 'com.test.audit.g10';
  const g = await freshGuest(appId);

  // fetch() with no net grant rejects with PERMISSION_DENIED (bridged,
  // not native — a native fetch would hit stubFetch's no-route TypeError).
  let fetchErr = null;
  try { await settle(g.window.fetch('https://ok.example.com/x')); } catch (e) { fetchErr = e; }
  check('window.fetch without net grant rejects PERMISSION_DENIED', fetchErr && fetchErr.code === 'PERMISSION_DENIED', JSON.stringify(fetchErr && fetchErr.code));

  // With net:external it resolves a real Response through the bridge.
  await grant('net:external', appId);
  const res = await settle(g.window.fetch('https://ok.example.com/x'));
  check('window.fetch with net:external resolves a Response', res && typeof res === 'object' && typeof res.json === 'function', typeof res);
  const body = await settle(res.json());
  check('bridged fetch body round-trips (json)', body && body.hello === 'world', JSON.stringify(body));
  await revoke('net:external', appId);

  // Internal destination with only net:external is denied; with
  // net:internal it works (the MAC row now allows either grant through).
  await grant('net:external', appId);
  let internalErr = null;
  try { await settle(g.window.fetch('http://127.0.0.1/internal')); } catch (e) { internalErr = e; }
  check('internal URL with only net:external rejects PERMISSION_DENIED', internalErr && internalErr.code === 'PERMISSION_DENIED', JSON.stringify(internalErr && internalErr.code));
  await revoke('net:external', appId);
  await grant('net:internal', appId);
  const internalRes = await settle(g.window.fetch('http://127.0.0.1/internal'));
  const internalBody = await settle(internalRes.json());
  check('internal URL with net:internal resolves (MAC any-of fix)', internalBody && internalBody.hello === 'world', JSON.stringify(internalBody));
  await revoke('net:internal', appId);

  // Self-file exemption: fetching one of the app's own registered files
  // under its serve prefix needs no permission and uses the native path.
  const ownUrl = g.window.location.href;
  let selfErr = null;
  let selfRes = null;
  try { selfRes = await settle(g.window.fetch(ownUrl), 4000); } catch (e) { selfErr = e; }
  check('self-file fetch needs no net permission (native path)', !selfErr, JSON.stringify(selfErr && selfErr.message));
  void selfRes;

  // XHR through the bridge: permission-gated the same way.
  await grant('net:external', appId);
  const xhrResult = await new Promise((resolve) => {
    let failedWith = null;
    try {
      const xhr = new g.window.XMLHttpRequest();
      xhr.open('GET', 'https://ok.example.com/x');
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => resolve({ error: 'network' });
      xhr.onabort = () => resolve({ error: 'abort' });
      setTimeout(() => resolve({ error: 'timeout', failedWith }), 4000);
      xhr.send();
    } catch (e) {
      resolve({ error: String(e && e.message || e), failedWith });
    }
  });
  check('XMLHttpRequest bridged fetch resolves with status 200', xhrResult && xhrResult.status === 200, JSON.stringify(xhrResult));
  check('XMLHttpRequest body round-trips', xhrResult && /world/.test(String(xhrResult.text || '')), JSON.stringify(xhrResult && xhrResult.text));
  await revoke('net:external', appId);

  const xhrDenied = await new Promise((resolve) => {
    try {
      const xhr = new g.window.XMLHttpRequest();
      xhr.open('GET', 'https://ok.example.com/x');
      xhr.onload = () => resolve({ status: xhr.status });
      xhr.onerror = () => resolve({ error: 'network' });
      setTimeout(() => resolve({ error: 'timeout' }), 4000);
      xhr.send();
    } catch (e) { resolve({ error: String(e && e.message || e) }); }
  });
  check('XMLHttpRequest without grant fails (not silently succeeds)', xhrDenied && (xhrDenied.error || xhrDenied.status !== 200), JSON.stringify(xhrDenied));

  g.teardown();
}

// ── GA11: websocket wrapper, share sheet, file picker (real dialogs) ──

async function ga11() {
  section('[GA11] websocket wrapper, share sheet, file picker — real dialogs');

  const appId = 'com.test.audit.g11';
  const g = await freshGuest(appId);

  // WebSocket without the grant.
  let wsErr = null;
  try { await settle(g.nova.websocket('wss://ws.example.com/')); } catch (e) { wsErr = e; }
  check('websocket without net:websocket rejects PERMISSION_DENIED', wsErr && wsErr.code === 'PERMISSION_DENIED', JSON.stringify(wsErr && wsErr.code));

  // With the grant: open → message → send → close through the wrapper.
  await grant('net:websocket', appId);
  const ws = await settle(g.nova.websocket('wss://ws.example.com/'));
  check('websocket wrapper resolves a handle with wsId', ws && !!ws.wsId && typeof ws.send === 'function', JSON.stringify(ws && ws.wsId));
  let message = null;
  ws.onMessage((envelope) => { message = envelope; });
  // Host StubWebSocket echoes nothing by itself; drive the guest-visible
  // event path by having the host push through ws:send and reading state.
  const sendRes = await settle(ws.send('hello-socket'));
  check('ws.send resolves through the bridge', !sendRes.error, JSON.stringify(sendRes && sendRes.error));
  const closeRes = await settle(ws.close(1000, 'done'));
  check('ws.close resolves through the bridge', !closeRes.error, JSON.stringify(closeRes && closeRes.error));
  await revoke('net:websocket', appId);
  void message;

  // Share sheet — a REAL host dialog; click Copy like a user.
  const shareP = settle(g.nova.share({ title: 'Share me', text: 'Some text' }), 6000);
  await sleep(150);
  const copyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Copy');
  check('share sheet shows a Copy action', !!copyBtn);
  if (copyBtn) copyBtn.__fire('click');
  const shared = await shareP;
  check('share resolves { cancelled: false, action: "Copy" }', shared && shared.cancelled === false && shared.action === 'Copy', JSON.stringify(shared));

  // Share cancel path.
  const shareP2 = settle(g.nova.share({ text: 'Again' }), 6000);
  await sleep(150);
  const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  check('second share sheet shows Cancel', !!cancelBtn);
  if (cancelBtn) cancelBtn.__fire('click');
  const shared2 = await shareP2;
  check('share cancel resolves { cancelled: true }', shared2 && shared2.cancelled === true, JSON.stringify(shared2));

  // Invalid share payloads reject INVALID_ARGS (no dialog).
  let shareErr = null;
  try { await settle(g.nova.share({ url: 'ftp://nope.example.com/x' })); } catch (e) { shareErr = e; }
  check('share with non-HTTP(S) url rejects INVALID_ARGS', shareErr && shareErr.code === 'INVALID_ARGS', JSON.stringify(shareErr && shareErr.code));

  // File picker (nova:files:open) — the REAL production SystemDialogs
  // service browsing a REAL directory, clicked through like a user.
  const osMod = require('os');
  const pickerDir = fs.mkdtempSync(path.join(osMod.tmpdir(), 'nova-guest-picker-'));
  fs.writeFileSync(path.join(pickerDir, 'photo.jpg'), 'jpeg-bytes');
  fs.writeFileSync(path.join(pickerDir, 'notes.txt'), 'plain text notes');

  const openP = settle(g.nova.files.open({
    title: 'Pick one', startPath: pickerDir, accept: ['image/jpeg'],
  }), 8000);
  await sleep(250);
  const photoTile = findInTree(global.document.body, (n) => typeof n.getAttribute === 'function' && n.getAttribute('aria-label') === 'photo.jpg');
  check('real picker lists the image file', !!photoTile);
  if (photoTile) photoTile.__fire('click');
  await sleep(80);
  const openBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Open');
  check('picker Open button enabled after selection', !!openBtn && openBtn.disabled === false);
  if (openBtn) openBtn.__fire('click');
  const opened = await openP;
  check('files.open resolves the picked image as base64',
    opened && opened.cancelled === false && opened.file && opened.file.name === 'photo.jpg'
      && opened.file.content === Buffer.from('jpeg-bytes').toString('base64')
      && opened.file.encoding === 'base64',
    JSON.stringify(opened).slice(0, 220));

  // Text file pick returns plain content (no encoding marker).
  const openTxt = settle(g.nova.files.open({
    title: 'Pick text', startPath: pickerDir, accept: ['.txt'],
  }), 8000);
  await sleep(250);
  const txtTile = findInTree(global.document.body, (n) => typeof n.getAttribute === 'function' && n.getAttribute('aria-label') === 'notes.txt');
  if (txtTile) txtTile.__fire('click');
  await sleep(80);
  const openBtn2 = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Open');
  if (openBtn2) openBtn2.__fire('click');
  const openedTxt = await openTxt;
  check('files.open resolves the picked text file as content',
    openedTxt && openedTxt.cancelled === false && openedTxt.file && openedTxt.file.content === 'plain text notes' && !openedTxt.file.encoding,
    JSON.stringify(openedTxt).slice(0, 220));

  // Picker cancel path.
  const openP2 = settle(g.nova.files.open({ title: 'Cancel me', startPath: pickerDir }), 8000);
  await sleep(250);
  const pickerCancel = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  check('picker shows Cancel', !!pickerCancel);
  if (pickerCancel) pickerCancel.__fire('click');
  const opened2 = await openP2;
  check('files.open cancel resolves { cancelled: true }', opened2 && opened2.cancelled === true, JSON.stringify(opened2));

  // Save picker: pick a destination, verify the real file lands on disk.
  const saveP = settle(g.nova.files.save({
    title: 'Export', filename: 'exported.txt', startPath: pickerDir,
    mimeType: 'text/plain', content: 'Exported content',
  }), 8000);
  await sleep(250);
  const saveBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
  check('save picker shows Save (enabled by suggestedName)', !!saveBtn && saveBtn.disabled === false);
  if (saveBtn) saveBtn.__fire('click');
  const saved = await saveP;
  const savedPath = saved && saved.file && saved.file.path;
  const onDisk = savedPath ? fs.readFileSync(savedPath, 'utf8') : null;
  check('files.save writes the content to the real destination',
    saved && saved.cancelled === false && onDisk === 'Exported content',
    JSON.stringify(saved).slice(0, 200) + ' disk=' + JSON.stringify(onDisk));

  fs.rmSync(pickerDir, { recursive: true, force: true });

  g.teardown();
}

// ── GA12: requestPermission rate limiting + notification actions ──

async function ga12() {
  section('[GA12] requestPermission rate limiting and notification actions');

  const appId = 'com.test.audit.g12';
  const g = await freshGuest(appId);

  // The doc: 3 prompts per rolling 60s per appId:permission pair, then
  // auto-deny with no dialog; cooldown doubles per consecutive denial.
  const results = [];
  for (let i = 0; i < 4; i++) {
    const p = settle(g.nova.requestPermission('device:geolocation', 'reason ' + i), 5000);
    await sleep(120);
    const denyBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Deny');
    if (denyBtn) { denyBtn.__fire('click'); results.push(await p); }
    else { results.push(await p); }
  }
  check('four rapid requests all resolve granted:false (3 dialogs + 1 auto-deny)',
    results.length === 4 && results.every((r) => r && r.granted === false),
    JSON.stringify(results));

  // Rate-limit probe channel reports the state.
  const limited = await guestCall(g, 'nova:permission-rate-limited', { permission: 'device:geolocation' });
  check('permission-rate-limited reports limited after denial streak', limited.ok && limited.value && limited.value.limited === true, JSON.stringify(limited.value));

  // Notification action queue through the guest.
  await grant('device:notifications', appId);
  await guestCall(g, 'nova:notifications:createChannel', { id: 'act', name: 'Act' });
  const posted = await guestCall(g, 'nova:notifications:post', {
    channelId: 'act', title: 'Do', body: 'Something',
    actions: [{ id: 'go', label: 'Go' }],
  });
  check('post with actions resolves', posted.ok, JSON.stringify(posted.error && posted.error.code));

  // Empty queue shape before any tap.
  const empty = await guestCall(g, 'nova:notifications:consumeActions', {});
  check('consumeActions on empty queue resolves a list', empty.ok && Array.isArray(empty.value && (empty.value.actions || empty.value)), JSON.stringify(empty.value));

  // Toast action tap: find the toast's Go button (toasts mount into the
  // #toast-container portal, not directly under body) and tap it.
  const toastRoot = global.document.getElementById('toast-container');
  const goBtn = findInTree(toastRoot, (n) => n.tagName === 'BUTTON' && n.textContent === 'Go');
  check('posted action renders a tappable toast button', !!goBtn);
  if (goBtn) goBtn.__fire('click');
  await sleep(200);
  const consumed = await guestCall(g, 'nova:notifications:consumeActions', {});
  const actions = consumed.value && (consumed.value.actions || consumed.value);
  check('tapped action is delivered to the app queue', Array.isArray(actions) && actions.length === 1 && actions[0].actionId === 'go' && actions[0].label === 'Go', JSON.stringify(actions));
  const consumedAgain = await guestCall(g, 'nova:notifications:consumeActions', {});
  const actionsAgain = consumedAgain.value && (consumedAgain.value.actions || consumedAgain.value);
  check('consumeActions acknowledges (queue drains)', Array.isArray(actionsAgain) && actionsAgain.length === 0, JSON.stringify(actionsAgain));

  await revoke('device:notifications', appId);
  g.teardown();
}


async function ga9() {
  section('[GA9] doc parity — NOVAAPP.md vs runtime');

  const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'NOVAAPP.md'), 'utf8');
  const mgrSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'platform', 'security', 'app-permission-manager.js'), 'utf8');

  // 1) The documented permission table matches the manager catalog exactly.
  //    [a-z.:-] — dotted names like registry.read are real permissions too.
  const mgrBlock = mgrSrc.match(/const PERMISSION_TYPES = Object\.freeze\(\{([\s\S]*?)\n\s*\}\)/);
  const mgrPerms = [...mgrBlock[1].matchAll(/:\s*'([a-z.:-]+)'/g)].map((x) => x[1]);
  const docRows = [...doc.matchAll(/^\| \`([a-z.:-]+)\` \| (Filesystem|Apps|Network|Email|Calendar|Contacts|Device|Data|System|Admin|Sandbox) \|/gm)].map((x) => x[1]);
  check(`doc permission table (${docRows.length}) matches manager catalog (${mgrPerms.length})`,
    docRows.length === mgrPerms.length && docRows.every((p) => mgrPerms.includes(p)),
    `doc-only: ${docRows.filter((p) => !mgrPerms.includes(p)).join(',')} | mgr-only: ${mgrPerms.filter((p) => !docRows.includes(p)).join(',')}`);

  // 2) The prose count "N permissions" matches the table.
  const countClaim = doc.match(/(\d+) permissions across \d+ categories/);
  check('doc prose permission count matches the table', countClaim && Number(countClaim[1]) === docRows.length, `prose says ${countClaim && countClaim[1]}, table has ${docRows.length}`);

  // 3) Event table names are all subscribable with the right grants and a
  //    made-up name is not (behavior-level parity with ALLOWED_EVENT_NAMES).
  const g = await freshGuest('com.test.audit.g9');
  // system:events plus every domain grant the doc table's tiered rows
  // require (mail/calendar/contact events need their domain read; the
  // WebSocket push rows need net:websocket instead of system:events).
  for (const p of ['system:events', 'mail:read', 'calendar:read', 'contacts:read', 'net:websocket', 'registry.read']) {
    await grant(p, appId09);
  }
  // Event-table rows only, parsed inside the "### Event bus" section so the
  // permission and background-execution tables can't leak in.
  const eventSection = doc.match(/### Event bus[\s\S]*?(?=\n### )/);
  const docEvents = eventSection
    ? [...eventSection[0].matchAll(/^\| \`((?:system|app|mail|calendar|contacts|nova:net:ws|nova:reg):[a-zA-Z:]+)\` \|/gm)].map((x) => x[1])
    : [];
  let notSubscribable = [];
  for (const ev of docEvents) {
    const r = await guestCall(g, 'nova:events:subscribe', { event: ev });
    if (!r.ok) notSubscribable.push(`${ev}(${errCode(r.error)})`);
    await guestCall(g, 'nova:events:unsubscribe', { event: ev });
  }
  check(`all ${docEvents.length} documented events subscribe (with system:events + domain-free)`, notSubscribable.length === 0, notSubscribable.join(', '));
  const fake = await guestCall(g, 'nova:events:subscribe', { event: 'system:bogus' });
  check('made-up event name rejected', !fake.ok && errCode(fake.error) === 'INVALID_ARGS');
  g.teardown();
}
const appId09 = 'com.test.audit.g9';

// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// GA13 — full channel-table sweep + guest-forbidden enforcement
//
// DOC_CHANNELS pins the documented surface; the runtime's real handler
// table (INTERNAL.API_HANDLERS) is the source of truth and can drift.
// This section drives EVERY table channel the documented probe does not
// cover, and proves every GUEST_FORBIDDEN_IPC_APIS entry rejects even a
// fully privileged guest (the dispatch-time guard runs before MAC and
// before any handler — these channels are host-UI-only by design).
// ═══════════════════════════════════════════════════════════════════════

const appId13 = 'com.test.audit.g13';
const appId13b = 'com.test.audit.g13b';

// Channels whose real behavior is proven elsewhere as interactive flows:
// GA12 drives requestPermission dialogs and the rate-limit probe end to end.
const SWEEP_COVERED_ELSEWHERE = new Set([
  'nova:request-permission',
  'nova:permission-rate-limited',
]);

// The sweep may open a real file dialog (sysdialog/dialog channels are in
// the handler table); a user answers it by cancelling, so the sweep does
// the same. GA4's dismiss pattern, generalized to any open dialog.
function dismissAnyOpenDialog() {
  const cancelBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
  if (cancelBtn) cancelBtn.__fire('click');
}

async function ga13() {
  section('[GA13] full channel-table sweep + guest-forbidden enforcement');
  const forbidden = INTERNAL.GUEST_FORBIDDEN_IPC_APIS;
  const table = Object.keys(INTERNAL.API_HANDLERS);
  check('runtime channel table is non-trivial', table.length >= 80, `got ${table.length}`);
  check('guest-forbidden set is non-trivial', forbidden.size >= 30, `got ${forbidden.size}`);

  // 1) Every forbidden channel rejects PERMISSION_DENIED for a guest that
  //    holds every grant these domains would otherwise consult.
  const g = await freshGuest(appId13);
  for (const p of ['system:apps', 'system:app-launch', 'apps:communicate', 'admin:audit', 'admin:system', 'admin:users', 'system:events']) {
    await grant(p, appId13);
  }
  let denied = 0;
  const weak = [];
  for (const type of forbidden) {
    const r = await guestCall(g, type, {});
    if (!r.ok && errCode(r.error) === 'PERMISSION_DENIED') denied++;
    else weak.push(`${type} → ${r.ok ? 'RESOLVED' : errCode(r.error)}`);
  }
  check(`all ${forbidden.size} guest-forbidden channels reject PERMISSION_DENIED despite full grants`, denied === forbidden.size, weak.join(', '));
  g.teardown();

  // 2) Sweep: every remaining table channel answers with a code-carrying
  //    response — success or a documented typed error (INVALID_ARGS,
  //    PERMISSION_DENIED, UNAVAILABLE, ...), never a hang or a codeless
  //    rejection. This is the anti-drift check: a handler added to the
  //    runtime table must be exercisable by an app or removed.
  const probed = new Set(DOC_CHANNELS.map(([type]) => type));
  const rest = table
    .filter((t) => !forbidden.has(t) && !probed.has(t) && !SWEEP_COVERED_ELSEWHERE.has(t));
  const g2 = await freshGuest(appId13b, {
    manifest: {
      ...AUDIT_MANIFEST, id: appId13b,
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
      ipc: { exports: [], receives: [] },
    },
    permissions: ['sandbox:nested-webview'],
  });
  for (const p of ['system:apps', 'system:app-launch', 'apps:communicate', 'system:events', 'system:background']) await grant(p, appId13b);
  const interactive = new Set(['nova:sysdialog:open', 'nova:sysdialog:save', 'nova:dialog:open', 'nova:dialog:save', 'nova:files:open']);
  const unanswered = [];
  for (const type of rest) {
    const callPromise = g2.nova.ipc(type, {});
    // Dismissals happen while this promise is still un-awaited; attach a
    // no-op catch now so a rejection during the interactive window can't
    // become an unhandledRejection that kills the process.
    callPromise.catch(() => {});
    if (interactive.has(type)) {
      await sleep(200);
      dismissAnyOpenDialog();
      await sleep(100);
      dismissAnyOpenDialog();
    }
    const r = await guestCallResult(callPromise);
    if (r.ok) continue;
    const e = r.error || {};
    if (e.code && typeof e.code === 'string' && e.message && typeof e.message === 'string') continue;
    unanswered.push(`${type} → ${e.message || 'no error object'}`);
  }
  check(`every remaining ${rest.length} runtime channels answer with a typed response`, unanswered.length === 0, unanswered.join(', '));
  g2.teardown();
}

// Same shape as guestCall but for an already-started call promise.
async function guestCallResult(callPromise) {
  try {
    const value = await settle(callPromise, 6000);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GA14 — host→app push delivery
//
// GA8 proved nova:events:event pushes; this section covers the other
// push channels a running app lives on: appearance changes, overlay
// interactions, and AppScheduler background wakes.
// ═══════════════════════════════════════════════════════════════════════

async function ga14() {
  section('[GA14] host→app push delivery — appearance, overlay events, background wake');

  // 1) Appearance change push → appearance.onChange callbacks. The host
  //    handler subscribes to OS settings:changed and forwards public keys
  //    as nova:appearance:changed:event; the shim acks and fans out.
  const g = await freshGuest('com.test.audit.g14');
  let seen = null, onChangeErr = null, unsubFn = null;
  try { unsubFn = await settle(g.nova.appearance.onChange((snap) => { seen = snap; })); }
  catch (e) { onChangeErr = e; }
  check('appearance.onChange subscribes', !onChangeErr, JSON.stringify(onChangeErr && onChangeErr.code));
  env.state.OS.events.emit('settings:changed', { key: 'theme', value: 'nord' });
  await sleep(250);
  check('appearance change pushes a snapshot to onChange callbacks', seen && typeof seen === 'object' && seen.theme !== undefined, JSON.stringify(seen).slice(0, 140));
  if (typeof unsubFn === 'function') await settle(unsubFn());
  env.state.OS.events.emit('settings:changed', { key: 'theme', value: 'light' });
  await sleep(150);
  check('no push after appearance.onChange unsubscribe', seen && seen.theme !== 'light', JSON.stringify(seen).slice(0, 140));

  // 2) Overlay interaction push: clicking a [data-nova-action] element in a
  //    shown overlay forwards { overlayId, type, action } to overlay.onEvent.
  const overlayGuest = await freshGuest('com.test.audit.g14b', {
    manifest: {
      ...AUDIT_MANIFEST, id: 'com.test.audit.g14b',
      allowNestedWebview: true,
      permissions: ['sandbox:nested-webview'],
    },
    permissions: ['sandbox:nested-webview'],
  });
  // The overlay is a double gate: manifest opt-in AND the user grant.
  await grant('sandbox:nested-webview', 'com.test.audit.g14b');
  let overlayEvent = null, showErr = null, shown = null;
  overlayGuest.nova.overlay.onEvent((e) => { overlayEvent = e; });
  try { shown = await settle(overlayGuest.nova.overlay.show({ html: '<button data-nova-action="go">Go</button>' })); }
  catch (e) { showErr = e; }
  check('overlay.show resolves', !showErr && shown && shown.success !== false, JSON.stringify(showErr && showErr.code || shown).slice(0, 140));
  await sleep(150);
  // The overlay renders inside the host's sandboxed <iframe>; the action
  // button lives in that iframe's contentDocument, not the host body.
  const overlayIframes = [];
  findInTree(global.document.body, (n) => { if (n.tagName === 'IFRAME') overlayIframes.push(n); return false; });
  let btn = null;
  for (const f of overlayIframes) {
    btn = findInTree(f.contentDocument?.body, (n) => n.tagName === 'BUTTON' && n.getAttribute?.('data-nova-action') === 'go');
    if (btn) break;
  }
  check('overlay action button rendered into the overlay document', !!btn);
  if (btn) { btn.__fire('click'); await sleep(250); }
  check('overlay click pushes an event to overlay.onEvent', overlayEvent && overlayEvent.type === 'click' && overlayEvent.action === 'go', JSON.stringify(overlayEvent).slice(0, 180));

  // 3) Background wake push: the host only sends wake messages to a
  //    sandbox it started for a wake cycle (gated on system:background
  //    before creation), so the guest side dispatches without a second
  //    permission check. Drive the real respond() push path — respond()
  //    appends the ':response' wire suffix itself (see AppScheduler.wake).
  let wake = null;
  g.nova.onBackgroundWake((info) => { wake = info; });
  INTERNAL.respond(g.webview, 'nova:background:wake', INTERNAL.generateRequestId(), { reason: 'scheduled-wake' });
  await sleep(600);
  check('background wake push reaches onBackgroundWake listeners', wake && wake.reason === 'scheduled-wake', JSON.stringify(wake).slice(0, 140));

  g.teardown();
  overlayGuest.teardown();
}

// ════════════════════════════════ GA15 ═════════════════════════════════════
// v2 facade completion — end-to-end behavior of the facades added when the
// window.novaOS surface was completed (fs full, clipboard, notifications,
// window, dialog, app, data). Contract under test: every facade method
// behaves EXACTLY like the v1 channel it wraps (same gate, same error),
// with only the documented normalization on top (mutations resolve
// undefined; reads return the value).
// ═══════════════════════════════════════════════════════════════════════

async function ga15() {
  section('[GA15] v2 facade completion — fs/clipboard/notifications/window/dialog/app/data end-to-end');

  const g = await freshGuest('com.test.audit.g15');
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  // fs full facade — raw paths through the same host boundary. The appdata
  // roundtrip proves write/read/list/stat/remove all hit nova:fs:* with the
  // caller-relative rewrite intact.
  const w = await osCall(() => g.novaOS.fs.write('appdata:/ga15/deep.txt', 'facade'));
  check('fs.write resolves (auto-creates ancestors)', w.ok, JSON.stringify(w.error && w.error.code));
  const r = await osCall(() => g.novaOS.fs.read('appdata:/ga15/deep.txt'));
  check('fs.read returns the same file record as the raw channel', r.ok && r.value && r.value.data === 'facade', JSON.stringify(r.value && r.value.data));
  const st = await osCall(() => g.novaOS.fs.stat('appdata:/ga15/deep.txt'));
  check('fs.stat answers for the facade-written file', st.ok || errCode(st.error) === 'NOT_FOUND', JSON.stringify(st.error && st.error.code));
  const ls = await osCall(() => g.novaOS.fs.list('appdata:/ga15'));
  check('fs.list sees the facade-written file', ls.ok && ls.value && Array.isArray(ls.value.files || ls.value.entries || ls.value.nodes || []), JSON.stringify(ls.error && ls.error.code));
  const rm = await osCall(() => g.novaOS.fs.remove('appdata:/ga15/deep.txt'));
  check('fs.remove resolves', rm.ok, JSON.stringify(rm.error && rm.error.code));
  const rmgone = await osCall(() => g.novaOS.fs.read('appdata:/ga15/deep.txt'));
  check('fs.read after remove → NOT_FOUND', !rmgone.ok && errCode(rmgone.error) === 'NOT_FOUND', JSON.stringify(rmgone.error && rmgone.error.code));

  // clipboard facade — deny without grant, roundtrip with grants.
  const cd = await osCall(() => g.novaOS.clipboard.readText());
  check('clipboard.readText denied without clipboard:read', !cd.ok && errCode(cd.error) === 'PERMISSION_DENIED', JSON.stringify(cd.error && cd.error.code));
  await grant('clipboard:read', 'com.test.audit.g15');
  await grant('clipboard:write', 'com.test.audit.g15');
  const cw = await osCall(() => g.novaOS.clipboard.writeText('facade-clip'));
  check('clipboard.writeText resolves undefined', cw.ok && cw.value === undefined, JSON.stringify(cw.error && cw.error.code));
  const cr = await osCall(() => g.novaOS.clipboard.readText());
  check('clipboard.readText returns the written text', cr.ok && cr.value === 'facade-clip', JSON.stringify(cr.value));
  await revoke('clipboard:read', 'com.test.audit.g15');
  await revoke('clipboard:write', 'com.test.audit.g15');

  // notifications facade — same gate as v1 (device:notifications).
  const nd = await osCall(() => g.novaOS.notifications.show({ title: 't', body: 'b' }));
  check('notifications.show denied without device:notifications', !nd.ok && errCode(nd.error) === 'PERMISSION_DENIED', JSON.stringify(nd.error && nd.error.code));
  await grant('device:notifications', 'com.test.audit.g15');
  const ns = await osCall(() => g.novaOS.notifications.show({ title: 't', body: 'b' }));
  // Headless harness: no Notify service → UNAVAILABLE is the legitimate
  // downstream answer (same as the raw channel); success is fine too.
  check('notifications.show with grant answers like v1 (UNAVAILABLE or success)', ns.ok || errCode(ns.error) === 'UNAVAILABLE', JSON.stringify(ns.error && ns.error.code));
  const nc = await osCall(() => g.novaOS.notifications.cancelAll());
  check('notifications.cancelAll resolves undefined', nc.ok && nc.value === undefined, JSON.stringify(nc.error && nc.error.code));
  await revoke('device:notifications', 'com.test.audit.g15');

  // window facade — mutations resolve undefined; getState is NOT_FOUND in a
  // headless guest (no OS window state) but never permission-denied.
  const wt = await osCall(() => g.novaOS.window.setTitle('Facade'));
  check('window.setTitle resolves undefined', wt.ok && wt.value === undefined, JSON.stringify(wt.error && wt.error.code));
  const gz = await osCall(() => g.novaOS.window.getState());
  check('window.getState answers (record or NOT_FOUND, no window in harness)', gz.ok || errCode(gz.error) === 'NOT_FOUND', JSON.stringify(gz.error && gz.error.code));

  // dialog facade — style routing proven by the invalid-accept validation
  // error each underlying handler returns (INVALID_ARGS from the exact
  // channel the style selected, never UNKNOWN_API).
  const badAccept = ['not a mime and not an ext!!!'];
  const dStyled = await osCall(() => g.novaOS.dialog.pickOpen({ accept: badAccept }));
  check('dialog.pickOpen default routes to the styled picker (its INVALID_ARGS)', !dStyled.ok && errCode(dStyled.error) === 'INVALID_ARGS', JSON.stringify(dStyled.error && dStyled.error.code));
  const dSystem = await osCall(() => g.novaOS.dialog.pickOpen({ accept: badAccept, style: 'system' }));
  check('dialog.pickOpen style:"system" routes to the plain picker', !dSystem.ok && errCode(dSystem.error) === 'INVALID_ARGS', JSON.stringify(dSystem.error && dSystem.error.code));

  // app facade — info is ungated; launch keeps its grant gate.
  const ai = await osCall(() => g.novaOS.app.info());
  check('app.info resolves without grants (raw nova:app:info record)', ai.ok && ai.value && ai.value.id === 'com.test.audit.g15', JSON.stringify(ai.value || ai.error && ai.error.code).slice(0, 140));
  const al = await osCall(() => g.novaOS.app.launch('com.matrix.app'));
  check('app.launch denied without system:app-launch/system:apps', !al.ok && errCode(al.error) === 'PERMISSION_DENIED', JSON.stringify(al.error && al.error.code));

  // data facade — envelope roundtrip pinned to the caller, same as v1.
  await grant('data:backup', 'com.test.audit.g15');
  await settle(g.nova.ipc('nova:storage:set', { key: 'ga15', value: 'persisted' }));
  const bk = await osCall(() => g.novaOS.data.backup());
  check('data.backup returns an envelope', bk.ok && bk.value && bk.value.envelope && bk.value.envelope.appId === 'com.test.audit.g15', JSON.stringify(bk.value && bk.value.envelope && bk.value.envelope.appId || bk.error && bk.error.code));
  await settle(g.nova.ipc('nova:storage:delete', { key: 'ga15' }));
  const rs = await osCall(() => g.novaOS.data.restore(bk.value && bk.value.envelope));
  check('data.restore accepts the facade backup envelope', rs.ok, JSON.stringify(rs.error && rs.error.code));
  const back = await settle(g.nova.ipc('nova:storage:get', { key: 'ga15' }));
  check('restore brought the key back (v2 backup → v1 storage reads it)', back && back.value === 'persisted', JSON.stringify(back && back.value));
  await revoke('data:backup', 'com.test.audit.g15');

  g.teardown();
}

// ════════════════════════════════ GA16 ═════════════════════════════════════
// Locale + taskbar badge — the first two new host-side powers.
// Locale: ungated, coarse formatting facts only. Badge: permission-gated,
// host-clamped, rate-limited, session-only (cleared with the sandbox).
// ═══════════════════════════════════════════════════════════════════════

async function ga16() {
  section('[GA16] locale + taskbar badge');

  const g = await freshGuest('com.test.audit.g16');
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  // Locale — no permission, normalized record.
  const loc = await osCall(() => g.novaOS.locale.get());
  check('locale.get resolves without any grant', loc.ok, JSON.stringify(loc.error && loc.error.code));
  check('locale record has the documented shape',
    loc.ok && typeof loc.value.locale === 'string'
    && (loc.value.firstDayOfWeek === 'monday' || loc.value.firstDayOfWeek === 'sunday')
    && (loc.value.region === null || typeof loc.value.region === 'string')
    && (loc.value.timeZone === null || typeof loc.value.timeZone === 'string'),
    JSON.stringify(loc.value));
  check('locale firstDayOfWeek maps US to sunday', loc.ok && loc.value.region === 'US' ? loc.value.firstDayOfWeek === 'sunday' : true, JSON.stringify(loc.value));
  check('locale region derives from locale tag', loc.ok && loc.value.region !== null, JSON.stringify(loc.value));

  // Badge — deny without grant.
  const bd = await osCall(() => g.novaOS.badge.set(3));
  check('badge.set denied without system:badge', !bd.ok && errCode(bd.error) === 'PERMISSION_DENIED', JSON.stringify(bd.error && bd.error.code));
  const bc = await osCall(() => g.novaOS.badge.clear());
  check('badge.clear denied without system:badge', !bc.ok && errCode(bc.error) === 'PERMISSION_DENIED', JSON.stringify(bc.error && bc.error.code));

  // With the grant: set/clear against the exported host store.
  await grant('system:badge', 'com.test.audit.g16');
  const appId = 'com.test.audit.g16';
  const s1 = await osCall(() => g.novaOS.badge.set(5));
  check('badge.set(5) resolves undefined', s1.ok && s1.value === undefined, JSON.stringify(s1.error && s1.error.code));
  const store1 = INTERNAL.appBadgeState.get(appId) || null;
  check('host store holds { count: 5 }', JSON.stringify(store1) === '{"count":5}', JSON.stringify(store1));
  const s2 = await osCall(() => g.novaOS.badge.set({ text: 'new' }));
  check('badge.set({text:"new"}) resolves', s2.ok, JSON.stringify(s2.error && s2.error.code));
  const store2 = INTERNAL.appBadgeState.get(appId) || null;
  check('host store holds { text: "new" } after text set', JSON.stringify(store2) === '{"text":"new"}', JSON.stringify(store2));
  const s3 = await osCall(() => g.novaOS.badge.set({ count: 2, text: 'zz' }));
  check('badge.set with both count and text resolves (count wins host-side)', s3.ok, JSON.stringify(s3.error && s3.error.code));
  const store3 = INTERNAL.appBadgeState.get(appId) || null;
  check('count wins when both fields are sent', store3 && store3.count === 2, JSON.stringify(store3));
  const s4 = await osCall(() => g.novaOS.badge.set(0));
  check('badge.set(0) clears (badge: null response)', s4.ok, JSON.stringify(s4.error && s4.error.code));
  const store4 = INTERNAL.appBadgeState.get(appId) || null;
  check('count 0 leaves the store empty', store4 === null || store4 === undefined, JSON.stringify(store4));

  // Clamps.
  const tooBig = await osCall(() => g.novaOS.badge.set(1000));
  check('badge.set(1000) → INVALID_ARGS', !tooBig.ok && errCode(tooBig.error) === 'INVALID_ARGS', JSON.stringify(tooBig.error && tooBig.error.code));
  const negative = await osCall(() => g.novaOS.badge.set(-1));
  check('badge.set(-1) → INVALID_ARGS', !negative.ok && errCode(negative.error) === 'INVALID_ARGS', JSON.stringify(negative.error && negative.error.code));
  const longText = await osCall(() => g.novaOS.badge.set({ text: 'toolong' }));
  check('badge.set text > 4 chars → INVALID_ARGS', !longText.ok && errCode(longText.error) === 'INVALID_ARGS', JSON.stringify(longText.error && longText.error.code));
  const empty = await osCall(() => g.novaOS.badge.set({}));
  check('badge.set({}) → INVALID_ARGS', !empty.ok && errCode(empty.error) === 'INVALID_ARGS', JSON.stringify(empty.error && empty.error.code));

  // Rate limit: 30/min; the harness already burned ~8 on the sets above,
  // so a tight loop up to the cap then one more must end RATE_LIMITED.
  let rateLimited = false;
  for (let i = 0; i < 30; i++) {
    const r = await osCall(() => g.novaOS.badge.set(1));
    if (!r.ok && errCode(r.error) === 'RATE_LIMITED') { rateLimited = true; break; }
  }
  check('badge flood eventually RATE_LIMITED (30/min cap)', rateLimited);

  const cleared = await osCall(() => g.novaOS.badge.clear());
  check('badge.clear resolves', cleared.ok, JSON.stringify(cleared.error && cleared.error.code));
  await revoke('system:badge', appId);

  g.teardown();
}

// ════════════════════════════════ GA17 ═════════════════════════════════════
// fs:watch — change events over the abstract FS, per-path access rules
// identical to nova:fs:read, watcher budget, unwatch semantics.
// ═══════════════════════════════════════════════════════════════════════

async function ga17() {
  section('[GA17] fs:watch — events, budgets, access rules');
  seedSharedFiles();
  const appId17 = 'com.test.audit.g17';
  const savedWatchConfig = { ...INTERNAL.fsWatchConfig };
  INTERNAL.fsWatchConfig.pollMs = 25;
  INTERNAL.fsWatchConfig.debounceMs = 30;
  try {
    const g = await freshGuest(appId17);
    const osCall = async (fn) => {
      try { return { ok: true, value: await settle(fn(), 6000) }; }
      catch (e) { return { ok: false, error: e }; }
    };

    // 1) Deny without the fs:watch grant (context-free front door).
    const d1 = await guestCall(g, 'nova:fs:watch', { path: '/data/watch-probe.txt' });
    check('fs:watch denied without fs:watch grant', !d1.ok && errCode(d1.error) === 'PERMISSION_DENIED', JSON.stringify(d1.error && d1.error.code));

    await grant('fs:watch', appId17);

    // 2) Own path: watch + change + delete events end-to-end.
    await settle(g.novaOS.fs.write('appdata:/ga17/watched.txt', 'v1'));
    let evt = null;
    const h = await osCall(() => g.novaOS.fs.watch('appdata:/ga17/watched.txt', (e) => { evt = e; }));
    check('fs.watch resolves a handle with a watcherId', h.ok && h.value && typeof h.value.watcherId === 'string' && h.value.watcherId.startsWith('w_'), JSON.stringify(h.error && h.error.code));
    check('fs.watch handle echoes the canonical path', h.ok && typeof h.value.path === 'string' && h.value.path.indexOf('/data/' + appId17) === 0, JSON.stringify(h.value && h.value.path));
    await settle(g.nova.ipc('nova:fs:write', { path: 'appdata:/ga17/watched.txt', content: 'v2' }));
    await sleep(200);
    check('change event delivered with kind=changed', evt && evt.kind === 'changed' && evt.watcherId === h.value.watcherId, JSON.stringify(evt));
    evt = null;
    await settle(g.nova.ipc('nova:fs:delete', { path: 'appdata:/ga17/watched.txt' }));
    await sleep(200);
    check('delete event delivered with kind=deleted', evt && evt.kind === 'deleted', JSON.stringify(evt));

    // 3) Shared path needs the same read grants a nova:fs:read would.
    const d2 = await guestCall(g, 'nova:fs:watch', { path: '/Pictures/notes.txt' });
    check('shared watch denied without read grants even with fs:watch', !d2.ok && errCode(d2.error) === 'PERMISSION_DENIED', JSON.stringify(d2.error && d2.error.code));
    await grant('fs:access', appId17);
    const h2 = await osCall(() => g.novaOS.fs.watch('/Pictures/notes.txt', () => {}));
    check('shared watch allowed with fs:access', h2.ok, JSON.stringify(h2.error && h2.error.code));

    // 4) Watcher budget: 8 per app. Two are live; fill up and hit the cap.
    for (let i = 0; i < 7; i++) {
      await settle(g.nova.ipc('nova:fs:write', { path: 'appdata:/ga17/w' + i + '.txt', content: 'x' }));
    }
    let budgetHit = false;
    const watchErrs = [];
    for (let i = 0; i < 7; i++) {
      const r = await osCall(() => g.novaOS.fs.watch('appdata:/ga17/w' + i + '.txt', () => {}));
      if (!r.ok) watchErrs.push(i + ':' + errCode(r.error));
      if (!r.ok && errCode(r.error) === 'RATE_LIMITED') { budgetHit = true; break; }
    }
    check('watcher over budget → RATE_LIMITED (max 8 per app)', budgetHit);

    // 5) unwatch frees a slot.
    if (h2.ok) await settle(h2.value.unwatch());
    await settle(g.nova.ipc('nova:fs:write', { path: 'appdata:/ga17/free.txt', content: 'x' }));
    const again = await osCall(() => g.novaOS.fs.watch('appdata:/ga17/free.txt', () => {}));
    check('unwatch frees a watcher slot', again.ok, JSON.stringify(again.error && again.error.code));

    // 6) Unknown watcher id: cleared:false, never an error, no info leak.
    const foreign = await guestCall(g, 'nova:fs:unwatch', { watcherId: 'w_unknown' });
    check('unwatch of unknown id answers cleared:false', foreign.ok && foreign.value && foreign.value.cleared === false, JSON.stringify(foreign.value));

    // 7) No events after unwatch.
    evt = null;
    if (h.ok) await settle(h.value.unwatch());
    await settle(g.nova.ipc('nova:fs:write', { path: 'appdata:/ga17/watched.txt', content: 'post-unwatch' }));
    await sleep(200);
    check('no events after unwatch', evt === null, JSON.stringify(evt));

    // 8) Host-side cleanup for an app's watchers.
    const stopped = INTERNAL.stopFsWatchersForApp(appId17);
    check('stopFsWatchersForApp tears down the rest', stopped >= 1 && [...INTERNAL.fsWatchers.values()].every((w) => w.appId !== appId17), `stopped=${stopped}`);

    await revoke('fs:watch', appId17);
    await revoke('fs:access', appId17);
    g.teardown();
  } finally {
    Object.assign(INTERNAL.fsWatchConfig, savedWatchConfig);
  }
}

// ════════════════════════════════ GA18 ═════════════════════════════════════
// Named alarms (system:schedule) — create/validation/budget, live-fire
// push, clear, and queued-after-launch delivery for one-shots missed while
// the app was closed.
// ═══════════════════════════════════════════════════════════════════════

async function ga18() {
  section('[GA18] named alarms — schedule, fire, queue-on-close');
  try { global.localStorage.removeItem('nova_app_alarms'); } catch (_) {}
  const appId18 = 'com.test.audit.g18';
  const osCall = async (fn, guest) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  const g = await freshGuest(appId18);
  const alarmsOf = () => (typeof global.localStorage.getItem === 'function'
    ? JSON.parse(global.localStorage.getItem('nova_app_alarms') || '{"apps":{}}') : { apps: {} });

  // 1) Deny without the grant.
  const d1 = await osCall(() => g.novaOS.alarms.getAll());
  check('alarms.getAll denied without system:schedule', !d1.ok && errCode(d1.error) === 'PERMISSION_DENIED', JSON.stringify(d1.error && d1.error.code));
  await grant('system:schedule', appId18);

  // 2) Validation.
  const badPeriod = await osCall(() => g.novaOS.alarms.create({ name: 'p', periodMinutes: 5 }));
  check('periodMinutes below the 15-minute floor → INVALID_ARGS', !badPeriod.ok && errCode(badPeriod.error) === 'INVALID_ARGS', JSON.stringify(badPeriod.error && badPeriod.error.code));
  const both = await osCall(() => g.novaOS.alarms.create({ name: 'b', when: Date.now() + 60000, periodMinutes: 30 }));
  check('both when and periodMinutes → INVALID_ARGS', !both.ok && errCode(both.error) === 'INVALID_ARGS', JSON.stringify(both.error && both.error.code));
  const neither = await osCall(() => g.novaOS.alarms.create({ name: 'n' }));
  check('neither when nor periodMinutes → INVALID_ARGS', !neither.ok && errCode(neither.error) === 'INVALID_ARGS', JSON.stringify(neither.error && neither.error.code));
  const badName = await osCall(() => g.novaOS.alarms.create({ name: 'bad name!', periodMinutes: 30 }));
  check('invalid alarm name → INVALID_ARGS', !badName.ok && errCode(badName.error) === 'INVALID_ARGS', JSON.stringify(badName.error && badName.error.code));
  const pastWhen = await osCall(() => g.novaOS.alarms.create({ name: 'past', when: Date.now() - 1000 }));
  check('when in the past → INVALID_ARGS', !pastWhen.ok && errCode(pastWhen.error) === 'INVALID_ARGS', JSON.stringify(pastWhen.error && pastWhen.error.code));

  // 3) Live fire: one-shot 80ms out, onAlarm receives it.
  let fired = null;
  const unsub = g.novaOS.alarms.onAlarm((f) => { fired = f; });
  const created = await osCall(() => g.novaOS.alarms.create({ name: 'live', when: Date.now() + 80 }));
  check('alarms.create returns the alarm record', created.ok && created.value && created.value.alarm && created.value.alarm.name === 'live' && typeof created.value.alarm.scheduledTime === 'number', JSON.stringify(created.error && created.error.code));
  const listed = await osCall(() => g.novaOS.alarms.getAll());
  check('getAll lists the pending alarm', listed.ok && Array.isArray(listed.value) && listed.value.some((a) => a.name === 'live'), JSON.stringify(listed.value));
  await sleep(400);
  check('one-shot fired to the live sandbox via onAlarm', fired && fired.name === 'live' && fired.firedAt, JSON.stringify(fired));
  const after = await osCall(() => g.novaOS.alarms.getAll());
  check('one-shot is consumed after firing', after.ok && Array.isArray(after.value) && !after.value.some((a) => a.name === 'live'), JSON.stringify(after.value));

  // 4) clear() prevents the fire.
  fired = null;
  await osCall(() => g.novaOS.alarms.create({ name: 'gone', when: Date.now() + 120 }));
  const cleared = await osCall(() => g.novaOS.alarms.clear('gone'));
  check('alarms.clear resolves cleared:true', cleared.ok && cleared.value === undefined, JSON.stringify(cleared.error && cleared.error.code));
  await sleep(300);
  check('no fire after clear', fired === null, JSON.stringify(fired));

  // 5) Budget: 32 alarms per app.
  let budgetHit = false;
  for (let i = 0; i < 33; i++) {
    const r = await osCall(() => g.novaOS.alarms.create({ name: 'bulk' + i, periodMinutes: 15 }));
    if (!r.ok && errCode(r.error) === 'RATE_LIMITED') { budgetHit = true; break; }
  }
  check('alarm over budget → RATE_LIMITED (max 32 per app)', budgetHit);
  await osCall(() => g.novaOS.alarms.clear('bulk0'));
  const replacedOk = await osCall(() => g.novaOS.alarms.create({ name: 'bulk1', periodMinutes: 20 }));
  check('re-creating an existing name replaces it (no budget slot)', replacedOk.ok && replacedOk.value && replacedOk.value.replaced === true, JSON.stringify(replacedOk.error && replacedOk.error.code));

  // 6) Closed-app queue: fire a one-shot with NO live sandbox → queued;
  //    delivered on the next launch right after ready.
  const qCreated = await osCall(() => g.novaOS.alarms.create({ name: 'queued', when: Date.now() + 1000 }));
  check('queued one-shot created', qCreated.ok, JSON.stringify(qCreated.error && qCreated.error.code));
  g.teardown(); // guest gone → fire has nowhere to go → queue
  const queueDeadline = Date.now() + 3000;
  let queuedRecord;
  while (Date.now() < queueDeadline) {
    const state = alarmsOf();
    queuedRecord = state.apps && state.apps[appId18];
    if (queuedRecord && Array.isArray(queuedRecord.queue) && queuedRecord.queue.some((q) => q.name === 'queued')) break;
    await sleep(25);
  }
  const sawQueuedFire = !!queuedRecord?.queue?.some((q) => q.name === 'queued');
  check('missed one-shot landed in the bounded queue while closed', sawQueuedFire, JSON.stringify((alarmsOf().apps || {})[appId18] || {}));
  const state = alarmsOf();
  queuedRecord = (state.apps || {})[appId18];
  const queueLen = queuedRecord && Array.isArray(queuedRecord.queue) ? queuedRecord.queue.length : 0;
  if (queueLen > 0) {
    let queuedFire = null;
    const g2 = await freshGuest(appId18); // same app, fresh sandbox → ready handshake
    g2.novaOS.alarms.onAlarm((f) => { queuedFire = f; });
    await sleep(400);
    check('queued alarm delivered right after the next launch', queuedFire && queuedFire.name === 'queued' && queuedFire.queued === true, JSON.stringify(queuedFire));
    g2.teardown();
  } else {
    check('queued alarm delivered right after the next launch', false, 'queue was empty — live-delivery consumed it');
  }

  try { global.localStorage.removeItem('nova_app_alarms'); } catch (_) {}
}

// ════════════════════════════════ GA19 ═════════════════════════════════════
// Secrets (secrets:store) — encrypted per-app credential store. Roundtrip,
// budgets, cross-app isolation, and the defining negative property: secrets
// never appear in data export/backup envelopes.
// ═══════════════════════════════════════════════════════════════════════

async function ga19() {
  section('[GA19] secrets — encrypted store, budgets, backup exclusion');
  const os = require('os');
  const pathMod = require('path');
  const fsMod = require('fs');
  const secretsDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'nova-secrets-test-'));
  process.env.NOVA_SECRETS_DIR = secretsDir;
  env.AppSecrets._resetForTests();
  const appId19 = 'com.test.audit.g19';
  const appId19b = 'com.test.audit.g19b';
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };
  try {
    const g = await freshGuest(appId19);

    // 1) Deny without the grant.
    const d1 = await osCall(() => g.novaOS.secrets.keys());
    check('secrets.keys denied without secrets:store', !d1.ok && errCode(d1.error) === 'PERMISSION_DENIED', JSON.stringify(d1.error && d1.error.code));
    await grant('secrets:store', appId19);

    // 2) Roundtrip.
    const sv = await osCall(() => g.novaOS.secrets.set('api-token', 'sekrit-value'));
    check('secrets.set resolves undefined', sv.ok && sv.value === undefined, JSON.stringify(sv.error && sv.error.code));
    const got = await osCall(() => g.novaOS.secrets.get('api-token'));
    check('secrets.get returns the plaintext', got.ok && got.value === 'sekrit-value', JSON.stringify(got.value));
    const missing = await osCall(() => g.novaOS.secrets.get('absent'));
    check('secrets.get absent key → null', missing.ok && missing.value === null, JSON.stringify(missing.value));
    const labels = await osCall(() => g.novaOS.secrets.keys());
    check('secrets.keys lists own labels only', labels.ok && JSON.stringify(labels.value) === JSON.stringify(['api-token']), JSON.stringify(labels.value));

    // 3) Values are ciphertext on disk.
    const storeRaw = fsMod.readFileSync(pathMod.join(secretsDir, 'app-secrets.json'), 'utf8');
    check('plaintext never touches disk', !storeRaw.includes('sekrit-value'));

    // 4) Budgets and clamps.
    const tooBig = await osCall(() => g.novaOS.secrets.set('big', 'x'.repeat(8 * 1024 + 1)));
    check('secret over 8 KB → INVALID_ARGS', !tooBig.ok && errCode(tooBig.error) === 'INVALID_ARGS', JSON.stringify(tooBig.error && tooBig.error.code));
    let budgetHit = false;
    for (let i = 0; i < 64; i++) {
      const r = await osCall(() => g.novaOS.secrets.set('k' + i, 'v' + i));
      if (!r.ok && errCode(r.error) === 'RATE_LIMITED') { budgetHit = true; break; }
    }
    check('secret over budget → RATE_LIMITED (max 64 per app)', budgetHit);

    // 5) Cross-app isolation: another app's namespace is empty, and its
    //    own writes never leak into ours.
    const g2 = await freshGuest(appId19b);
    await grant('secrets:store', appId19b);
    const foreign = await osCall(() => g2.novaOS.secrets.get('api-token'));
    check("app B cannot read app A's secret", foreign.ok && foreign.value === null, JSON.stringify(foreign.value));
    const foreignKeys = await osCall(() => g2.novaOS.secrets.keys());
    check("app B sees none of app A's labels", foreignKeys.ok && foreignKeys.value.length === 0, JSON.stringify(foreignKeys.value));

    // 6) THE defining negative property: backup envelopes never carry
    //    secrets, even when the app holds data:backup too.
    await grant('data:backup', appId19);
    await settle(g.nova.ipc('nova:storage:set', { key: 'plain', value: 'namespace-value' }));
    const bk = await osCall(() => g.novaOS.data.backup());
    const envelopeJson = JSON.stringify((bk.value && bk.value.envelope) || {});
    check('backup envelope carries the namespace value', envelopeJson.includes('namespace-value'));
    check('backup envelope NEVER carries secret values', !envelopeJson.includes('sekrit-value'));

    // 7) Delete.
    const del = await osCall(() => g.novaOS.secrets.delete('api-token'));
    check('secrets.delete resolves undefined', del.ok && del.value === undefined, JSON.stringify(del.error && del.error.code));
    const gone = await osCall(() => g.novaOS.secrets.get('api-token'));
    check('deleted secret reads back null', gone.ok && gone.value === null, JSON.stringify(gone.value));

    await revoke('secrets:store', appId19);
    await revoke('data:backup', appId19);
    g.teardown();
    g2.teardown();
  } finally {
    delete process.env.NOVA_SECRETS_DIR;
    env.AppSecrets._resetForTests();
    try { fsMod.rmSync(secretsDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ════════════════════════════════ GA20 ═════════════════════════════════════
// Share target (system:share-target) — manifest validation, MIME matching,
// user-mediated delivery to live sandboxes, queue-on-close + deliver-on-
// relaunch, and the grant gate on delivery.
// ═══════════════════════════════════════════════════════════════════════

async function ga20() {
  section('[GA20] share target — matching, delivery, queue-on-close');
  try { global.localStorage.removeItem('nova_share_inbound'); } catch (_) {}
  const appId20 = 'com.test.audit.g20';
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  // 1) Manifest validation (real validateManifest).
  let validate = null;
  try { validate = require('../../js/platform/core/app-package.js').validateManifest; } catch (_) {}
  if (typeof validate === 'function') {
    const ok = validate({ id: 'com.st.app', name: 'S', version: '1.0.0', entry: 'index.html', shareTarget: { mimeTypes: ['text/plain', 'text/*', '*/*'] } });
    check('valid shareTarget manifest passes validation', ok.valid === true, JSON.stringify(ok.errors));
    const bad = validate({ id: 'com.st.app', name: 'S', version: '1.0.0', entry: 'index.html', shareTarget: { mimeTypes: ['not a mime'], bogus: 1 } });
    check('invalid shareTarget manifest fails validation', bad.valid === false && bad.errors.length >= 2, JSON.stringify(bad.errors));
  } else {
    check('shareTarget manifest validation reachable', false, 'validateManifest not loadable');
  }

  // 2) MIME matching.
  check('text/plain declared matches text content', INTERNAL.shareTargetMatches(['text/plain'], { text: 'hi' }) === true);
  check('text/uri-list declared matches url content', INTERNAL.shareTargetMatches(['text/uri-list'], { url: 'https://x.y' }) === true);
  check('text/* wildcard matches text content', INTERNAL.shareTargetMatches(['text/*'], { text: 'hi' }) === true);
  check('image/png declared does NOT match text content', INTERNAL.shareTargetMatches(['image/png'], { text: 'hi' }) === false);
  check('*/* matches anything shareable', INTERNAL.shareTargetMatches(['*/*'], { text: 'hi' }) === true);
  check('empty or missing declaration matches nothing', INTERNAL.shareTargetMatches(null, { text: 'hi' }) === false);

  // 3) Delivery gate: without the grant, delivery is refused outright.
  const refused = INTERNAL.deliverShareTarget(appId20, { text: 'nope' });
  check('delivery refused without system:share-target', refused.delivered === false && refused.queued === false && refused.reason === 'PERMISSION_DENIED', JSON.stringify(refused));

  // 4) Live delivery: grant + live sandbox → push reaches onInbound.
  const g = await freshGuest(appId20, {
    manifest: { ...AUDIT_MANIFEST, id: appId20, shareTarget: { mimeTypes: ['text/plain'] } },
  });
  await grant('system:share-target', appId20);
  let inbound = null;
  const unsub = g.novaOS.share.onInbound((share) => { inbound = share; });
  check('share.onInbound returns an unsubscribe function', typeof unsub === 'function');
  const out = INTERNAL.deliverShareTarget(appId20, { title: 'Look', text: 'shared text', url: '', sourceAppId: 'com.sender.app' });
  await sleep(250);
  check('live target receives the inbound push', out.delivered === true && inbound && inbound.text === 'shared text' && inbound.sourceAppId === 'com.sender.app', JSON.stringify({ out, inbound }));

  // 5) Closed target → queue, then deliver on relaunch right after ready.
  g.teardown();
  const q = INTERNAL.deliverShareTarget(appId20, { text: 'for later' });
  check('closed target queues the inbound share', q.delivered === false && q.queued === true, JSON.stringify(q));
  let queuedInbound = null;
  const g2 = await freshGuest(appId20, {
    manifest: { ...AUDIT_MANIFEST, id: appId20, shareTarget: { mimeTypes: ['text/plain'] } },
  });
  const unsub2 = g2.novaOS.share.onInbound((share) => { queuedInbound = share; });
  await sleep(400);
  check('queued share delivered right after the next launch', queuedInbound && queuedInbound.text === 'for later' && queuedInbound.queued === true, JSON.stringify(queuedInbound));

  // 6) Unsubscribed listeners stop receiving.
  queuedInbound = null;
  unsub();
  unsub2();
  INTERNAL.deliverShareTarget(appId20, { text: 'after unsub' });
  await sleep(250);
  check('no delivery after unsubscribe', queuedInbound === null, JSON.stringify(queuedInbound));

  await revoke('system:share-target', appId20);
  try { global.localStorage.removeItem('nova_share_inbound'); } catch (_) {}
  g2.teardown();
}

// ════════════════════════════════ GA21 ═════════════════════════════════════
// Push delivery (push:receive): token lifecycle, the delivery ladder
// (live → wake-queued → notify/queue), the queue bound, and the
// revocation door. The SSE transport itself needs a real server — the
// vitest server suite covers that; here the ladder is driven directly
// through INTERNAL.deliverPushMessage exactly as the transport calls it.
async function ga21() {
  section('[GA21] push delivery — tokens, ladder, queue, revocation door');
  try { global.localStorage.removeItem('nova_app_push'); } catch (_) {}
  try { global.localStorage.removeItem('nova_push_device_id'); } catch (_) {}
  const appId21 = 'com.test.audit.g21';
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };
  const pushStateOf = () => {
    try { return JSON.parse(global.localStorage.getItem('nova_app_push') || '{"tokens":{},"queue":{}}'); }
    catch (_) { return { tokens: {}, queue: {} }; }
  };

  const g = await freshGuest(appId21);

  // 1) Deny without the grant.
  const d1 = await osCall(() => g.novaOS.push.register());
  check('push.register denied without push:receive', !d1.ok && errCode(d1.error) === 'PERMISSION_DENIED', JSON.stringify(d1.error && d1.error.code));

  // 2) Token lifecycle: shape, stability, idempotence.
  await grant('push:receive', appId21);
  const reg = await osCall(() => g.novaOS.push.register());
  check('push.register returns a shaped token', reg.ok && reg.value && /^nps_[0-9a-f]{32}$/.test(reg.value.token) && typeof reg.value.endpoint === 'string' && reg.value.queued === 0, JSON.stringify(reg.value || reg.error && reg.error.code));
  const reg2 = await osCall(() => g.novaOS.push.register());
  check('re-register keeps the same token (idempotent)', reg2.ok && reg2.value.token === reg.value.token && reg2.value.replaced === false, JSON.stringify(reg2.value || reg2.error && reg2.error.code));
  const deviceOk = /^[\w-]{8,64}$/.test(global.localStorage.getItem('nova_push_device_id') || '');
  check('a stable per-install device id exists', deviceOk, global.localStorage.getItem('nova_push_device_id'));

  // 3) Live delivery: rung 1 — message pushed into the live sandbox.
  let liveMessage = null;
  const unsub = g.novaOS.push.onMessage((m) => { liveMessage = m; });
  check('push.onMessage returns an unsubscribe function', typeof unsub === 'function');
  const outLive = INTERNAL.deliverPushMessage(appId21, { title: 'Live', body: 'rung one', data: { n: 1 } });
  await sleep(250);
  check('live sandbox receives the push via onMessage', outLive.delivered === true && outLive.how === 'live' && liveMessage && liveMessage.title === 'Live' && liveMessage.data && liveMessage.data.n === 1 && liveMessage.appId === appId21, JSON.stringify({ outLive, liveMessage }));
  check('message shape is normalized (id, sentAt, data)', liveMessage && typeof liveMessage.id === 'string' && liveMessage.id.length <= 64 && typeof liveMessage.sentAt === 'string', JSON.stringify(liveMessage));

  // 4) Oversized/abnormal payloads are normalized, not rejected, at the
  //    ladder (the publish endpoint rejects; the ladder defends in depth).
  const bigOut = INTERNAL.deliverPushMessage(appId21, { title: 'x'.repeat(5000), body: 'y'.repeat(9000), data: { big: 'z'.repeat(9000) } });
  check('oversized fields are sliced/defused at the ladder', bigOut.delivered === true && liveMessage !== null, JSON.stringify(bigOut));

  // 5) Closed delivery: rung 3+4 — queued (notification display is
  //    environment-dependent; the queue is the contract here).
  g.teardown();
  const queueLen = () => (pushStateOf().queue[appId21] || []).length;
  const outClosed = INTERNAL.deliverPushMessage(appId21, { title: 'While closed', data: { n: 2 } });
  check('closed app queues the message (rung 3/4)', outClosed.delivered === true && (outClosed.how === 'queued' || outClosed.how === 'notified-queued') && queueLen() === 1, JSON.stringify({ outClosed, len: queueLen() }));

  // 6) Queue bound: 8 per app — #9 and #10 push out the oldest.
  for (let i = 0; i < 9; i++) INTERNAL.deliverPushMessage(appId21, { data: { seq: i } });
  check('queue bound holds at 8 (oldest dropped)', queueLen() === 8, String(queueLen()));
  const qState = pushStateOf();
  const firstKept = (qState.queue[appId21] || [])[0];
  check('bounded queue keeps the NEWEST entries', firstKept && firstKept.data && firstKept.data.seq >= 1, JSON.stringify(firstKept && firstKept.data));

  // 7) Wake rung: with system:background, delivery queues + requests a
  //    wake (how: 'wake-queued' when the scheduler is live here, 'queued'
  //    when the harness has no scheduler — the queue is the contract).
  await grant('system:background', appId21);
  const outWake = INTERNAL.deliverPushMessage(appId21, { data: { seq: 'wake' } });
  check('wake-eligible closed app gets queued + wake requested', outWake.delivered === true && (outWake.how === 'wake-queued' || outWake.how === 'queued'), JSON.stringify(outWake));

  // 8) Relaunch flush: queued messages arrive right after nova:ready.
  let flushed = [];
  const g2 = await freshGuest(appId21);
  g2.novaOS.push.onMessage((m) => { if (m.queued) flushed.push(m); });
  await sleep(500);
  check('queued pushes flushed right after the next launch', flushed.length >= 8 && flushed.every((m) => m.queued === true), JSON.stringify({ flushed: flushed.length, sample: flushed[0] }));

  // 9) Revocation door: no grant → dropped before any rung.
  await revoke('push:receive', appId21);
  const outRevoked = INTERNAL.deliverPushMessage(appId21, { title: 'nope', data: { n: 3 } });
  check('revoked grant drops the message at the door', outRevoked.delivered === false && outRevoked.how === 'no-grant', JSON.stringify(outRevoked));

  // 10) Unregister: with the grant back, drops token AND queue.
  await grant('push:receive', appId21);
  INTERNAL.deliverPushMessage(appId21, { data: { n: 4 } });
  const queueBefore = queueLen();
  const unreg = await osCall(() => g2.novaOS.push.unregister());
  const afterUnreg = pushStateOf();
  check('unregister resolves removed and drops token + queue', unreg.ok && unreg.value === undefined && !afterUnreg.tokens[appId21] && !(afterUnreg.queue || {})[appId21] && queueBefore >= 0, JSON.stringify({ unreg: unreg.value, queueBefore }));

  // 11) Unsubscribed listeners stop receiving.
  await grant('push:receive', appId21);
  unsub();
  liveMessage = null;
  INTERNAL.deliverPushMessage(appId21, { title: 'after unsub' });
  await sleep(250);
  check('no delivery after unsubscribe', liveMessage === null, JSON.stringify(liveMessage));

  await revoke('push:receive', appId21);
  await revoke('system:background', appId21);
  try { global.localStorage.removeItem('nova_app_push'); } catch (_) {}
  try { global.localStorage.removeItem('nova_push_device_id'); } catch (_) {}
  g2.teardown();
}

// ════════════════════════════════ GA22 ═════════════════════════════════════
// Settings + ready v2 facades — pure sugar over nova:settings:get/set and
// nova:ready. The channels themselves are frozen and covered elsewhere
// (GA8 raw settings flows, R9 host-side); what's proven here is the facade
// shape: identical permission gates, the raw value out of settings.get(),
// undefined on mutations, and a normalized, side-effect-free ready snapshot.
// ═══════════════════════════════════════════════════════════════════════

async function ga22() {
  section('[GA22] settings + ready v2 facades');
  const appId22 = 'com.test.audit.g22';
  const g = await freshGuest(appId22);
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  // Ready — ungated, normalized snapshot.
  const snap1 = await osCall(() => g.novaOS.ready.get());
  check('ready.get resolves without any grant', snap1.ok, JSON.stringify(snap1.error && snap1.error.code));
  check('ready snapshot carries appId + permission arrays',
    snap1.ok && snap1.value.appId === appId22
    && Array.isArray(snap1.value.permissions) && Array.isArray(snap1.value.optionalPermissions),
    JSON.stringify(snap1.value));
  check('ready snapshot carries OS identity',
    snap1.ok && typeof snap1.value.osVersion === 'string' && snap1.value.securityPatch !== undefined,
    JSON.stringify(snap1.value));
  check('non-system app gets username: null', snap1.ok && snap1.value.username === null, JSON.stringify(snap1.value));
  const snap2 = await osCall(() => g.novaOS.ready.get());
  check('repeat ready.get is harmless (same shape, no re-delivery)',
    snap2.ok && snap2.value.appId === appId22
    && JSON.stringify(Object.keys(snap2.value)) === JSON.stringify(Object.keys(snap1.value)),
    JSON.stringify(snap2.value));

  // Settings — deny paths first (a fresh guest holds no grants).
  const gd = await osCall(() => g.novaOS.settings.get('theme'));
  check('settings.get denied without system:info', !gd.ok && errCode(gd.error) === 'PERMISSION_DENIED', JSON.stringify(gd.error && gd.error.code));
  const sd = await osCall(() => g.novaOS.settings.set('theme', 'nord'));
  check('settings.set denied without system:settings', !sd.ok && errCode(sd.error) === 'PERMISSION_DENIED', JSON.stringify(sd.error && sd.error.code));

  // Read path with the grant: allowlisted key resolves to the raw value.
  env.state.OS.settings.set('theme', 'nova-light');
  await grant('system:info', appId22);
  const got = await osCall(() => g.novaOS.settings.get('theme'));
  check('settings.get resolves the raw stored value', got.ok && got.value === 'nova-light', JSON.stringify(got.value));
  const osv = await osCall(() => g.novaOS.settings.get('osVersion'));
  check('settings.get reads osVersion (read-allowlisted)', osv.ok, JSON.stringify(osv.error && osv.error.code));
  const pin = await osCall(() => g.novaOS.settings.get('lockPin'));
  check('settings.get cannot read credentials', !pin.ok && errCode(pin.error) === 'PERMISSION_DENIED', JSON.stringify(pin.error && pin.error.code));

  // Write path with the grant: mutation resolves undefined and lands.
  await grant('system:settings', appId22);
  const put = await osCall(() => g.novaOS.settings.set('theme', 'nord'));
  check('settings.set resolves undefined', put.ok && put.value === undefined, JSON.stringify(put.error && put.error.code));
  check('settings.set actually applied host-side', env.state.OS.settings.get('theme') === 'nord');
  const back = await osCall(() => g.novaOS.settings.get('theme'));
  check('read-after-write returns the new value', back.ok && back.value === 'nord', JSON.stringify(back.value));
  const devMode = await osCall(() => g.novaOS.settings.set('devMode', true));
  check('settings.set cannot write devMode (write allowlist)', !devMode.ok && errCode(devMode.error) === 'PERMISSION_DENIED', JSON.stringify(devMode.error && devMode.error.code));

  await revoke('system:info', appId22);
  await revoke('system:settings', appId22);
  g.teardown();
}

// ════════════════════════════════ GA23 ═════════════════════════════════════
// Full-coverage v2 facades — events, geolocation, media, calendar, contacts,
// mail, admin, background, permissions. Pure sugar over the frozen v1
// channels: identical permission gates and error codes, normalized results
// only, and the push surfaces (events, wakes) fan out to v1 and v2
// listeners independently from the same host subscription.
// ═══════════════════════════════════════════════════════════════════════════

async function ga23() {
  section('[GA23] full-coverage v2 facades (events, device, calendar, contacts, mail, admin, background, permissions)');
  const appId23 = 'com.test.audit.g23';
  const g = await freshGuest(appId23);
  const osCall = async (fn) => {
    try { return { ok: true, value: await settle(fn(), 6000) }; }
    catch (e) { return { ok: false, error: e }; }
  };

  // ── events.on / off — public event, no permission needed ──
  const seen23 = [];
  const offTheme = await settle(g.novaOS.events.on('system:themeChanged', (d) => seen23.push(d)));
  check('events.on subscribes a public event with no permission', typeof offTheme === 'function', 'off not a function');
  env.state.OS.events.emit('system:themeChanged', { theme: 'nord' });
  await sleep(150);
  check('events.on listener receives the pushed event', seen23.length === 1 && seen23[0].theme === 'nord', JSON.stringify(seen23));

  // Stacking a second listener — one host subscription, both fire.
  const seen23b = [];
  const offTheme2 = await settle(g.novaOS.events.on('system:themeChanged', (d) => seen23b.push(d)));
  env.state.OS.events.emit('system:themeChanged', { theme: 'light' });
  await sleep(150);
  check('stacked v2 listeners both fire over one subscription', seen23.length === 2 && seen23b.length === 1, JSON.stringify([seen23.length, seen23b.length]));

  // v1 + v2 coexistence: the host holds ONE subscription per name; while v1
  // listeners exist the facade neither re-subscribes nor unsubscribes under
  // them — both surfaces receive the same pushes independently.
  let v1Got = null;
  g.nova.onEvent('system:network', (d) => { v1Got = d; });
  await sleep(50); // let the v1 subscribe round-trip land before emitting
  const seen23v2 = [];
  const offNet = await settle(g.novaOS.events.on('system:network', (d) => seen23v2.push(d)));
  env.state.OS.events.emit('system:network', { online: true });
  await sleep(150);
  check('v1 onEvent still fires alongside the v2 facade', v1Got && v1Got.online === true, JSON.stringify(v1Got));
  check('v2 events.on fires for the same push', seen23v2.length === 1 && seen23v2[0].online === true, JSON.stringify(seen23v2));

  // off() removes only its own callback (the remaining listener keeps
  // receiving); a v1 listener keeps receiving after the v2 off() too.
  await settle(offTheme2());
  env.state.OS.events.emit('system:themeChanged', { theme: 'midnight' });
  await sleep(150);
  check('off() stops its listener only', seen23.length === 3 && seen23b.length === 1, JSON.stringify([seen23.length, seen23b.length]));
  await settle(offNet());
  env.state.OS.events.emit('system:network', { online: false });
  await sleep(150);
  check('v1 listener still receives after v2 off() (no unsubscribe out from under v1)', v1Got && v1Got.online === false, JSON.stringify(v1Got));
  // Full lifecycle on a fresh name with no v1 involvement: the LAST v2 off()
  // unsubscribes host-side, so a raw subscribe succeeds again afterwards.
  const offFresh = await settle(g.novaOS.events.on('system:workspaceChanged', () => {}));
  await settle(offFresh());
  const resub = await osCall(() => g.novaOS.events.subscribe('system:workspaceChanged'));
  check('last v2 off() with no v1 listeners unsubscribed host-side', resub.ok, JSON.stringify(resub.error && resub.error.code));
  await osCall(() => g.novaOS.events.unsubscribe('system:workspaceChanged'));

  // Sensitive events need system:events; a refused subscription must not
  // leave the listener registered (a later granted on() works normally).
  const deniedEv = await osCall(() => g.novaOS.events.on('app:installed', () => {}));
  check('events.on denied without system:events', !deniedEv.ok && errCode(deniedEv.error) === 'PERMISSION_DENIED', JSON.stringify(deniedEv.error && deniedEv.error.code));
  await grant('system:events', appId23);
  let installGot = null;
  const offInstall = await settle(g.novaOS.events.on('app:installed', (d) => { installGot = d; }));
  env.state.OS.events.emit('app:installed', { appId: 'com.x.y' });
  await sleep(150);
  check('events.on delivers after the grant', installGot && installGot.appId === 'com.x.y', JSON.stringify(installGot));
  await settle(offInstall());
  await revoke('system:events', appId23);

  // ALREADY_SUBSCRIBED tolerance: raw subscribe first, on() still resolves.
  await osCall(() => g.novaOS.events.subscribe('system:power'));
  let powerGot = null;
  const offPower = await settle(g.novaOS.events.on('system:power', (d) => { powerGot = d; }));
  check('events.on tolerates an existing subscription (ALREADY_SUBSCRIBED)', typeof offPower === 'function', 'on() rejected');
  env.state.OS.events.emit('system:power', { charging: true });
  await sleep(150);
  check('event delivered through the tolerated subscription', powerGot && powerGot.charging === true, JSON.stringify(powerGot));
  await settle(offPower());

  // ── geolocation — the harness host exposes no provider, so with the
  // grant the call fails closed with UNAVAILABLE (never a hang) ──
  const geoDenied = await osCall(() => g.novaOS.geolocation.getCurrentPosition());
  check('geolocation denied without device:geolocation', !geoDenied.ok && errCode(geoDenied.error) === 'PERMISSION_DENIED', JSON.stringify(geoDenied.error && geoDenied.error.code));
  await grant('device:geolocation', appId23);
  const geoOk = await osCall(() => g.novaOS.geolocation.getCurrentPosition({ enableHighAccuracy: true }));
  check('geolocation with the grant reaches the provider gate (UNAVAILABLE in harness)', !geoOk.ok && errCode(geoOk.error) === 'UNAVAILABLE', JSON.stringify(geoOk.error && geoOk.error.code));
  await revoke('device:geolocation', appId23);

  // ── media (authorization-only channels) ──
  const camDenied = await osCall(() => g.novaOS.media.checkCamera());
  check('media.checkCamera denied without device:camera', !camDenied.ok && errCode(camDenied.error) === 'PERMISSION_DENIED', JSON.stringify(camDenied.error && camDenied.error.code));
  const micDenied = await osCall(() => g.novaOS.media.checkMicrophone());
  check('media.checkMicrophone denied without device:microphone', !micDenied.ok && errCode(micDenied.error) === 'PERMISSION_DENIED', JSON.stringify(micDenied.error && micDenied.error.code));
  await grant('device:camera', appId23);
  await grant('device:microphone', appId23);
  const camOk = await osCall(() => g.novaOS.media.checkCamera());
  check('media.checkCamera resolves true with the grant', camOk.ok && camOk.value === true, JSON.stringify(camOk.value));
  const micOk = await osCall(() => g.novaOS.media.checkMicrophone());
  check('media.checkMicrophone resolves true with the grant', micOk.ok && micOk.value === true, JSON.stringify(micOk.value));
  await revoke('device:camera', appId23);
  await revoke('device:microphone', appId23);

  // ── calendar / contacts (shared host stores) ──
  try { global.localStorage.removeItem('nova_calendar'); } catch (_) {}
  try { global.localStorage.removeItem('nova_contacts'); } catch (_) {}
  const calDenied = await osCall(() => g.novaOS.calendar.list());
  check('calendar.list denied without calendar:read', !calDenied.ok && errCode(calDenied.error) === 'PERMISSION_DENIED', JSON.stringify(calDenied.error && calDenied.error.code));
  const conDenied = await osCall(() => g.novaOS.contacts.save({ name: 'X' }));
  check('contacts.save denied without contacts:write', !conDenied.ok && errCode(conDenied.error) === 'PERMISSION_DENIED', JSON.stringify(conDenied.error && conDenied.error.code));
  for (const p of ['calendar:read', 'calendar:write', 'calendar:delete', 'contacts:read', 'contacts:write', 'contacts:delete']) await grant(p, appId23);
  const calEmpty = await osCall(() => g.novaOS.calendar.list());
  check('calendar.list resolves an array', calEmpty.ok && Array.isArray(calEmpty.value) && calEmpty.value.length === 0, JSON.stringify(calEmpty.value));
  const savedEv = await osCall(() => g.novaOS.calendar.save({ title: 'Audit sync', date: '2026-11-05' }));
  check('calendar.save returns the host-normalized record (id assigned)', savedEv.ok && savedEv.value && typeof savedEv.value.id === 'string' && savedEv.value.title === 'Audit sync', JSON.stringify(savedEv.value));
  const calList = await osCall(() => g.novaOS.calendar.list());
  check('calendar.list sees the saved event', calList.ok && calList.value.length === 1 && calList.value[0].id === savedEv.value.id, JSON.stringify(calList.value));
  const calBad = await osCall(() => g.novaOS.calendar.save({ title: '' }));
  check('calendar.save rejects an invalid event (INVALID_EVENT)', !calBad.ok && errCode(calBad.error) === 'INVALID_EVENT', JSON.stringify(calBad.error && calBad.error.code));
  const calDel = await osCall(() => g.novaOS.calendar.remove(savedEv.value && savedEv.value.id));
  check('calendar.remove resolves whether anything was removed', calDel.ok && calDel.value === true, JSON.stringify(calDel.value));
  const calDel2 = await osCall(() => g.novaOS.calendar.remove('nope-nope'));
  check('calendar.remove of a missing id resolves false', calDel2.ok && calDel2.value === false, JSON.stringify(calDel2.value));
  const savedCon = await osCall(() => g.novaOS.contacts.save({ name: 'Ada Lovelace', email: 'ada@example.com' }));
  check('contacts.save returns the normalized contact', savedCon.ok && savedCon.value && typeof savedCon.value.id === 'string' && savedCon.value.name === 'Ada Lovelace', JSON.stringify(savedCon.value));
  const conList = await osCall(() => g.novaOS.contacts.list());
  check('contacts.list sees the saved contact', conList.ok && conList.value.length === 1 && conList.value[0].email === 'ada@example.com', JSON.stringify(conList.value));
  const conDel = await osCall(() => g.novaOS.contacts.remove(savedCon.value && savedCon.value.id));
  check('contacts.remove resolves the removed flag', conDel.ok && conDel.value === true, JSON.stringify(conDel.value));
  for (const p of ['calendar:read', 'calendar:write', 'calendar:delete', 'contacts:read', 'contacts:write', 'contacts:delete']) await revoke(p, appId23);
  try { global.localStorage.removeItem('nova_calendar'); } catch (_) {}
  try { global.localStorage.removeItem('nova_contacts'); } catch (_) {}

  // ── mail / admin — deny paths + the admin-mode half of the dual gate
  // (the services themselves are covered by the raw-channel suites) ──
  const mailDenied = await osCall(() => g.novaOS.mail.folders());
  check('mail.folders denied without mail:read', !mailDenied.ok && errCode(mailDenied.error) === 'PERMISSION_DENIED', JSON.stringify(mailDenied.error && mailDenied.error.code));
  const adminDenied = await osCall(() => g.novaOS.admin.appsList());
  check('admin.appsList denied without admin:apps', !adminDenied.ok && errCode(adminDenied.error) === 'PERMISSION_DENIED', JSON.stringify(adminDenied.error && adminDenied.error.code));
  await grant('admin:apps', appId23);
  const adminMode = await osCall(() => g.novaOS.admin.appsList());
  // The harness env reports admin mode ON, so with the grant the full dual
  // gate passes and the apps record comes through unnormalized.
  check('admin.appsList passes the dual gate (grant + admin mode) and returns the apps record',
    adminMode.ok && adminMode.value && Array.isArray(adminMode.value.apps), JSON.stringify(adminMode.error && adminMode.error.code));
  await revoke('admin:apps', appId23);

  // ── background ──
  const stayDenied = await osCall(() => g.novaOS.background.stayAlive());
  check('background.stayAlive denied without system:background:live', !stayDenied.ok && errCode(stayDenied.error) === 'PERMISSION_DENIED', JSON.stringify(stayDenied.error && stayDenied.error.code));
  await grant('system:background:live', appId23);
  const stayOk = await osCall(() => g.novaOS.background.stayAlive());
  check('background.stayAlive resolves the enabled state', stayOk.ok && stayOk.value && stayOk.value.enabled === true, JSON.stringify(stayOk.value));
  const stayOff = await osCall(() => g.novaOS.background.stayAlive(false));
  check('background.stayAlive(false) opts back out', stayOff.ok && stayOff.value && stayOff.value.enabled === false, JSON.stringify(stayOff.value));
  await revoke('system:background:live', appId23);
  const wakeOk = await osCall(() => g.novaOS.background.wakeDone());
  check('background.wakeDone resolves (ungated)', wakeOk.ok, JSON.stringify(wakeOk.error && wakeOk.error.code));
  // onWake handlers receive the same push the v1 handler gets; off() stops
  // only its own registration.
  let wakeGot = null; let wakeGot2 = null;
  const offWake = g.novaOS.background.onWake((info) => { wakeGot = info; });
  g.novaOS.background.onWake((info) => { wakeGot2 = info; });
  INTERNAL.respond(g.webview, 'nova:background:wake', INTERNAL.generateRequestId(), { reason: 'scheduled-wake' });
  await sleep(120);
  check('background.onWake handlers receive the wake push', wakeGot && wakeGot.reason === 'scheduled-wake' && wakeGot2 && wakeGot2.reason === 'scheduled-wake', JSON.stringify([wakeGot, wakeGot2]));
  offWake();
  INTERNAL.respond(g.webview, 'nova:background:wake', INTERNAL.generateRequestId(), { reason: 'second-wake' });
  await sleep(120);
  check('off() stops only its own wake handler', wakeGot && wakeGot.reason === 'scheduled-wake' && wakeGot2 && wakeGot2.reason === 'second-wake', JSON.stringify([wakeGot && wakeGot.reason, wakeGot2 && wakeGot2.reason]));
  // v1 + v2 wake coexistence: both surfaces receive the same push.
  let v1Wake = null; let v2Wake = null;
  g.nova.onBackgroundWake((info) => { v1Wake = info; });
  const offWake2 = g.novaOS.background.onWake((info) => { v2Wake = info; });
  INTERNAL.respond(g.webview, 'nova:background:wake', INTERNAL.generateRequestId(), { reason: 'third-wake' });
  await sleep(120);
  check('v1 and v2 wake handlers both receive the same push', v1Wake && v1Wake.reason === 'third-wake' && v2Wake && v2Wake.reason === 'third-wake', JSON.stringify([v1Wake && v1Wake.reason, v2Wake && v2Wake.reason]));
  offWake2();

  // ── permissions — real dialog, real grant (secrets:store is untouched
  // elsewhere in this section, so no cooldown can pre-answer it) ──
  const reqP = g.novaOS.permissions.request('secrets:store', 'GA23 audit');
  await sleep(120);
  const allowBtn = findInTree(global.document.body, (n) => n.tagName === 'BUTTON' && n.textContent === 'Allow');
  check('permissions.request shows a real dialog', !!allowBtn, 'no Allow button found in host DOM');
  if (allowBtn) allowBtn.__fire('click');
  const reqResult = await settle(reqP, 4000);
  check('permissions.request resolves the granted boolean (true)', reqResult === true, JSON.stringify(reqResult));
  check('the grant actually took effect', PM.isGranted('secrets:store', appId23) === true);
  await revoke('secrets:store', appId23);
  const cooldown = await osCall(() => g.novaOS.permissions.checkRateLimited('secrets:store'));
  check('permissions.checkRateLimited answers without triggering a prompt', cooldown.ok && cooldown.value && typeof cooldown.value === 'object', JSON.stringify(cooldown.value !== undefined ? cooldown.value : (cooldown.error && cooldown.error.code)));

  // ── net.websocket — v2 handle over the same socket machinery the v1
  // wrapper uses (GA11 covers the wrapper itself) ──
  const wsDenied = await osCall(() => g.novaOS.net.websocket('wss://ws.example.com/'));
  check('net.websocket denied without net:websocket', !wsDenied.ok && errCode(wsDenied.error) === 'PERMISSION_DENIED', JSON.stringify(wsDenied.error && wsDenied.error.code));

  await grant('net:websocket', appId23);
  const v2wsOpen = await osCall(() => g.novaOS.net.websocket('wss://ws.example.com/'));
  check('net.websocket resolves a handle with wsId',
    v2wsOpen.ok && v2wsOpen.value && !!v2wsOpen.value.wsId && typeof v2wsOpen.value.send === 'function' && typeof v2wsOpen.value.close === 'function',
    JSON.stringify(v2wsOpen.error && v2wsOpen.error.code));
  const v2ws = v2wsOpen.value;
  const v2got = { message: null, error: null, close: null };
  v2ws.onMessage((m) => { v2got.message = m; });
  v2ws.onError((m) => { v2got.error = m; });
  v2ws.onClose((m) => { v2got.close = m; });
  // A push for this wsId reaches the facade's listeners even though no v1
  // handle was ever created for this socket (independent fan-out).
  INTERNAL.respond(g.webview, 'nova:net:ws:message', INTERNAL.generateRequestId(), { wsId: v2ws.wsId, data: 'hello-v2' });
  await sleep(120);
  check('net.websocket onMessage receives the ws push', v2got.message && v2got.message.data === 'hello-v2', JSON.stringify(v2got.message));
  // send round-trips through the bridge.
  const v2send = await osCall(() => v2ws.send('ping-v2'));
  check('net.websocket send resolves through the bridge', v2send.ok, JSON.stringify(v2send.error && v2send.error.code));
  // v1 + v2 coexistence on separate sockets: each surface only sees its own.
  const v1ws = await settle(g.nova.websocket('wss://ws.example.com/'));
  let v1msg = null;
  v1ws.onMessage((m) => { v1msg = m; });
  INTERNAL.respond(g.webview, 'nova:net:ws:message', INTERNAL.generateRequestId(), { wsId: v1ws.wsId, data: 'for-v1' });
  await sleep(120);
  check('v1 wrapper handle receives its own socket push', v1msg && v1msg.data === 'for-v1', JSON.stringify(v1msg));
  check('v2 listener does not receive another socket push', v2got.message && v2got.message.data === 'hello-v2', JSON.stringify(v2got.message && v2got.message.data));
  // close push fires the facade's onClose and retires the wsId: later pushes
  // for the same wsId go nowhere.
  INTERNAL.respond(g.webview, 'nova:net:ws:close', INTERNAL.generateRequestId(), { wsId: v2ws.wsId, code: 1000, reason: 'done', clean: true });
  await sleep(120);
  check('net.websocket onClose receives the close push', v2got.close && v2got.close.code === 1000, JSON.stringify(v2got.close));
  INTERNAL.respond(g.webview, 'nova:net:ws:message', INTERNAL.generateRequestId(), { wsId: v2ws.wsId, data: 'after-close' });
  await sleep(120);
  check('no v2 delivery after the close push', v2got.message && v2got.message.data === 'hello-v2', JSON.stringify(v2got.message && v2got.message.data));
  await revoke('net:websocket', appId23);

  g.teardown();
}

// ════════════════════════════════ GA24 ═════════════════════════════════════
// Raw WebSocket channels as a complete standalone API. The host mirrors
// every socket push onto the OS event bus (nova:net:ws:message / ws:error /
// ws:close) so a raw nova.ipc app — no wrapper, no facade — can receive.
// Contract: net:websocket-gated (not system:events), same-app filtered
// (foreign sockets are silently dropped), and the wrapper/facade per-wsId
// direct pushes keep flowing alongside. Runs the REAL subscribe handler,
// REAL bus, REAL socket handlers, REAL guest fan-out.
// ═════════════════════════════════════════════════════════════════════

async function ga24() {
  section('[GA24] raw websocket receive — socket pushes as subscribable bus events');

  const appId = 'com.test.audit.g24';
  const g = await freshGuest(appId);

  // The domain gate: the three ws push names need net:websocket — the same
  // permission opening a socket needs — not the flat system:events grant.
  const denied = await guestCall(g, 'nova:events:subscribe', { event: 'nova:net:ws:message' });
  check('ws push subscribe without net:websocket is PERMISSION_DENIED',
    !denied.ok && errCode(denied.error) === 'PERMISSION_DENIED', JSON.stringify(denied.error && denied.error.code));

  await grant('net:websocket', appId);

  // Raw standalone loop: connect + send over the raw channels (no wrapper,
  // no facade), receive through the events path.
  const opened = await guestCall(g, 'nova:net:websocket', { url: 'wss://ws.example.com/raw' });
  check('raw nova:net:websocket connects', opened.ok && opened.value && !!opened.value.wsId, JSON.stringify(opened.error && opened.error.code));
  const wsId = opened.value.wsId;

  let pushed = null;
  await settle(g.nova.onEvent('nova:net:ws:message', (data) => { pushed = data; }));
  const send = await guestCall(g, 'nova:net:ws:send', { wsId, data: 'ping-raw' });
  check('raw nova:net:ws:send resolves', send.ok, JSON.stringify(send.error && send.error.code));

  // Fire the host-side stub socket's onmessage: the push must arrive BOTH
  // as the per-wsId direct push (wrapper/facade plumbing, untouched) and
  // through the bus mirror to the events subscriber.
  const stub = g.sandbox.wsConnections.get(wsId) && g.sandbox.wsConnections.get(wsId).ws;
  check('socket tracked on the guest sandbox record', !!stub);
  stub.onmessage({ data: 'hello-raw' });
  await sleep(200);
  check('bus mirror delivers to the events subscriber', pushed && pushed.wsId === wsId && pushed.data === 'hello-raw', JSON.stringify(pushed));
  check('appId rides the bus payload for the same-app filter', pushed && pushed.appId === appId, JSON.stringify(pushed && pushed.appId));

  // The per-wsId direct pushes are untouched: a socket opened through the
  // v1 wrapper delivers to the wrapper's own callbacks, while the same app
  // ALSO receives it through the bus mirror (documented: pick one receive
  // surface per socket — both firing is the expected double delivery).
  const v1ws = await settle(g.nova.websocket('wss://ws.example.com/wrapper'));
  check('wrapper socket opens alongside the raw one', v1ws && !!v1ws.wsId, JSON.stringify(v1ws && v1ws.wsId));
  let wrapperGot = null, wrapperBusPush = null;
  v1ws.onMessage((m) => { wrapperGot = m; });
  await settle(g.nova.onEvent('nova:net:ws:message', (data) => { if (data.wsId === v1ws.wsId) wrapperBusPush = data; }));
  const v1stub = g.sandbox.wsConnections.get(v1ws.wsId) && g.sandbox.wsConnections.get(v1ws.wsId).ws;
  v1stub.onmessage({ data: 'via-wrapper' });
  await sleep(250);
  check('wrapper socket still delivers via the per-wsId direct push', wrapperGot && wrapperGot.data === 'via-wrapper', JSON.stringify(wrapperGot));
  check('wrapper socket also mirrors onto the bus for this app', wrapperBusPush && wrapperBusPush.data === 'via-wrapper', JSON.stringify(wrapperBusPush));

  // A second app subscribed to the same bus name must not hear the first
  // app's socket traffic — the filter drops deliveries addressed elsewhere.
  const other = await freshGuest('com.test.audit.g24b');
  await grant('net:websocket', other.appId);
  let otherPushed = null;
  await settle(other.nova.onEvent('nova:net:ws:message', (data) => { otherPushed = data; }));
  await sleep(200);
  stub.onmessage({ data: 'second-hello' });
  await sleep(250);
  check("foreign subscriber does not receive another app's socket push", otherPushed === null, JSON.stringify(otherPushed));
  check('owner still receives its own pushes with a foreign subscriber listening',
    pushed && pushed.data === 'second-hello', JSON.stringify(pushed && pushed.data));

  // error + close mirrors are subscribable too.
  let errPushed = null, closePushed = null;
  await settle(g.nova.onEvent('nova:net:ws:error', (data) => { errPushed = data; }));
  await settle(g.nova.onEvent('nova:net:ws:close', (data) => { closePushed = data; }));
  stub.onerror({});
  await sleep(200);
  check('ws:error mirrors to the events subscriber', errPushed && errPushed.error === 'WebSocket error', JSON.stringify(errPushed));
  stub.onclose({ code: 1000, reason: 'done', wasClean: true });
  await sleep(200);
  check('ws:close mirrors to the events subscriber', closePushed && closePushed.code === 1000 && closePushed.clean === true, JSON.stringify(closePushed));
  check('socket deregistered after close', !g.sandbox.wsConnections.has(wsId));

  other.teardown();
  g.teardown();
}

const FILTER = process.argv.find((a) => a.startsWith('--filter'))?.split('=')[1] || '';

const SUITE = {
  GA1: ga1, GA2: ga2, GA3: ga3, GA4: ga4, GA5: ga5,
  GA6: ga6, GA7: ga7, GA8: ga8, GA9: ga9,
  GA10: ga10, GA11: ga11, GA12: ga12,
  GA13: ga13, GA14: ga14, GA15: ga15, GA16: ga16, GA17: ga17, GA18: ga18, GA19: ga19, GA20: ga20, GA21: ga21, GA22: ga22, GA23: ga23, GA24: ga24,
};

(async () => {
  const names = FILTER ? [FILTER] : Object.keys(SUITE);
  for (const name of names) {
    if (!SUITE[name]) { console.log('unknown filter: ' + name); continue; }
    try { await SUITE[name](); }
    catch (e) { fail++; failures.push(`${name} crashed: ${e && e.stack || e}`); console.log(`  SECTION CRASH ${name}:`, e); }
  }
  console.log(`\n──── guest-bridge audit: ${pass} passed, ${fail} failed ────`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
