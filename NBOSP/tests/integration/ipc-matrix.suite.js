'use strict';
// NovaByte OS — full IPC + permission matrix suite.
//
// Drives EVERY handler in AppSandbox's API_HANDLERS table through the real
// dispatcher (handleAPICall) with the real AppPermissionManager and the real
// notifications service loaded, and asserts the guest-facing bridge contract:
//
//   P0  module sanity + dispatch-table invariants
//   P1  every handler: one response per request, echoed requestId, no crash
//       (malformed payloads: {} and null)
//   P2  guest-forbidden system APIs are rejected at dispatch
//   P3  permission matrix: every gated handler denied without its grant,
//       unblocked with it
//   P4  storage: CRUD, quotas, caps, isolation, adversarial keys
//   P5  notifications v2: channels, tag updates, actions, rate budgets
//   P6  clipboard: round-trip + history cap
//   P7  window: title/resize/getState clamps
//   P8  settings: readable/writable allowlists, wallpaper bypass
//   P9  app-to-app IPC: register/invoke/reply/broadcast, manifest gates
//   P10 network: fetch/websocket permission gates + protocol allowlists
//   P11 events: sensitive + domain-gated subscriptions
//   P12 stress: concurrency, budgets, payload bombs, injection attempts
//
// Usage: node tests/test_ipc_matrix.js [--filter P5] [--verbose]

const env = require('../helpers/env');
const {
  AppSandbox, AppPermissionManager: PM, Notify,
  makeApp, makeWebview, makeSandbox, call, grant, revoke, resetHost, registerActive,
  fetchCalls, state,
} = env;

const INTERNAL = AppSandbox._internal;
const API_HANDLERS = INTERNAL.API_HANDLERS;
const GUEST_FORBIDDEN = INTERNAL.GUEST_FORBIDDEN_IPC_APIS;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }

const code = (r) => r?.error?.code ?? null;

// ══════════════════════════════════ P0 ══════════════════════════════════

async function p0() {
  section('[P0] module sanity + dispatch invariants');
  check('sandbox module loaded', typeof AppSandbox.createSandbox === 'function');
  check('permission manager loaded', typeof PM.isGranted === 'function');
  check('notifications service loaded', typeof Notify.show === 'function');
  const handlerCount = Object.keys(API_HANDLERS).length;
  check('API_HANDLERS populated', handlerCount >= 90, `got ${handlerCount}`);

  // Every guest-forbidden type must be ABSENT from the handler table so the
  // dispatch-order PERMISSION_DENIED is the only possible outcome.
  const leaked = [...GUEST_FORBIDDEN].filter((t) => Object.prototype.hasOwnProperty.call(API_HANDLERS, t));
  check('guest-forbidden APIs never registered in handler table', leaked.length === 0, leaked.join(', '));

  const r = await call('nova:totally:made-up', {});
  check('unknown API → UNKNOWN_API', code(r) === 'UNKNOWN_API', code(r));
  check('requestId echoed on unknown API', r.requestId !== undefined && r.type === 'nova:totally:made-up:response');
}

// ══════════════════════════════════ P1 ══════════════════════════════════

// Handlers that respond asynchronously from a callback (they legitimately
// respond after handleAPICall resolves — the bridge allows late responses).
// For these, "no response within settle window" is acceptable.
const LATE_RESPONSE_OK = new Set(['nova:device:geolocation', 'nova:ipc:invoke']);

async function p1() {
  section('[P1] every handler: bridge contract under malformed input');
  const types = Object.keys(API_HANDLERS);
  const app = makeApp('com.probe.app');

  for (const payload of [{}, null, 42, 'str', [], true]) {
    for (const type of types) {
      const r = await call(type, payload, { app });
      const label = `${type} payload=${JSON.stringify(payload)}`;
      check(`${label}: single response`, code(r) !== 'DOUBLE_RESPONSE', code(r) || 'no code');
      check(`${label}: requestId echoed`, r.requestId !== undefined);
      check(`${label}: no uncaught crash`, code(r) !== 'NO_RESPONSE' || LATE_RESPONSE_OK.has(type), code(r));
    }
  }
}

// ══════════════════════════════════ P2 ══════════════════════════════════

async function p2() {
  section('[P2] guest-forbidden system APIs rejected at dispatch');
  for (const type of GUEST_FORBIDDEN) {
    const r = await call(type, {}, { app: makeApp('com.probe.app') });
    check(`${type} → PERMISSION_DENIED`, code(r) === 'PERMISSION_DENIED', code(r));
  }
}

// ══════════════════════════════════ P3 ══════════════════════════════════

// [type, perms[], payload, opts] — perms: ANY-of list that unblocks the
// handler. perm:null means the handler is not permission-gated at all.
const MATRIX = [
  // fs rows: /data/<app>/ paths are always rewritten to the CALLER's own dir
  // (and other apps' private nodes fail closed even by id), so denial is
  // exercised against the SHARED tree (/Documents), which is exactly what
  // fs:access/fs:metadata/media grants gate.
  ['nova:fs:write', ['fs:access'], { path: '/Documents/a.txt', content: 'x' }],
  ['nova:fs:delete', ['fs:access'], { path: '/Documents/a.txt' }],
  ['nova:fs:mkdir', ['fs:access'], { path: '/Documents', name: 'newdir' }],
  ['nova:fs:rename', ['fs:access'], { path: '/Documents/a.txt', name: 'b.txt' }],
  ['nova:fs:move', ['fs:access'], { path: '/Documents/a.txt', destPath: '/Documents' }],
  ['nova:fs:watch', ['fs:watch'], { path: '/data/watch-probe.txt' }],
  ['nova:fs:unwatch', null, { watcherId: 'w_none' }],
  ['nova:alarms:create', ['system:schedule'], { name: 'mx', periodMinutes: 15 }],
  ['nova:alarms:clear', ['system:schedule'], { name: 'mx' }],
  ['nova:alarms:getAll', ['system:schedule'], {}],
  ['nova:secrets:set', ['secrets:store'], { key: 'mx', value: 'v' }],
  ['nova:secrets:get', ['secrets:store'], { key: 'mx' }],
  ['nova:secrets:delete', ['secrets:store'], { key: 'mx' }],
  ['nova:secrets:keys', ['secrets:store'], {}],
  ['nova:push:register', ['push:receive'], {}],
  ['nova:push:unregister', ['push:receive'], {}],
  ['nova:fs:stat', ['fs:metadata', 'fs:access'], { path: '/Documents/a.txt' }],
  ['nova:fs:read', ['fs:access', 'fs:metadata', 'fs:read:images'], { path: '/Documents/a.txt' }],
  ['nova:media:query', ['fs:metadata', 'fs:access', 'fs:read:images'], { type: 'image' }],

  ['nova:notifications:show', ['device:notifications'], { title: 't', body: 'b' }],
  ['nova:notifications:clear', ['device:notifications'], {}],
  ['nova:notifications:post', ['device:notifications'], { title: 't', text: 'b' }],
  ['nova:notifications:createChannel', ['device:notifications'], { id: 'c1', name: 'C', importance: 'default' }],
  ['nova:notifications:cancel', ['device:notifications'], { tag: 'x' }],
  ['nova:notifications:cancelAll', ['device:notifications'], {}],
  ['nova:notifications:consumeActions', ['device:notifications'], {}],

  ['nova:background:stay-alive', ['system:background:live'], { enabled: true }],

  ['nova:settings:get', ['system:info'], { key: 'username' }],
  ['nova:settings:set', ['system:settings'], { key: 'theme', value: 'dark' }],
  // NovaByte Registry rows: reads gate on registry.read, writes on
  // registry.write. Paths stay inside HKNA/com.matrix.app/... so the
  // P3 denied-rewrite (app id swapped) keeps every caller inside its OWN
  // subtree — the denial is the MAC front door, never the per-hive rule.
  ['nova:reg:get', ['registry.read'], { path: 'HKNA/com.matrix.app/volume' }],
  ['nova:reg:list', ['registry.read'], { path: 'HKNA/com.matrix.app' }],
  ['nova:reg:export', ['registry.read'], { path: 'HKNA/com.matrix.app' }],
  ['nova:reg:set', ['registry.write'], { path: 'HKNA/com.matrix.app/volume', value: 80 }],
  ['nova:reg:delete', ['registry.write'], { path: 'HKNA/com.matrix.app/volume' }],
  ['nova:reg:import', ['registry.write'], { path: 'HKNA/com.matrix.app', data: { keys: {}, values: {} } }],
  ['nova:clipboard:read', ['clipboard:read'], {}],
  ['nova:clipboard:write', ['clipboard:write'], { text: 'x' }],
  // Locale is ungated (advisory) — no matrix row on purpose; P1 fuzzes it.
  ['nova:badge:set', ['system:badge'], { count: 3 }],
  ['nova:badge:clear', ['system:badge'], {}],

  ['nova:app:launch', ['system:app-launch', 'system:apps'], { appId: 'com.other.app' }],
  // Home-surface rows are context-dependent (Home-caller + always-launchable
  // Settings/App Manager), so they are advisory: the handler is the boundary.
  ['nova:home:apps:launch', null, { appId: 'com.nbosp.settings' }, { sandbox: { homeSurface: true } }],
  ['nova:app:list', ['system:apps'], {}],
  ['nova:app:install', ['system:apps'], {}],
  ['nova:app:uninstall', ['system:apps'], {}],
  ['nova:app:openDefaultAppsSettings', ['system:apps'], {}],
  ['nova:home:openDefaultAppsSettings', null, {}, { sandbox: { homeSurface: true } }],

  ['nova:admin:audit', ['admin:audit'], {}],
  ['nova:admin:system', ['admin:system'], {}],
  ['nova:admin:users', ['admin:users'], {}],
  ['nova:admin:apps', ['admin:apps'], {}],

  ['nova:mail:read', ['mail:read'], {}],
  ['nova:mail:write', ['mail:write'], {}],
  ['nova:mail:session', ['mail:write'], { action: 'connect' }],
  ['nova:mail:send', ['mail:send'], {}],
  ['nova:mail:delete', ['mail:delete'], {}],

  ['nova:net:fetch', ['net:internal', 'net:external'], { url: 'https://ok.example.com/x' }],
  ['nova:net:websocket', ['net:websocket'], { url: 'wss://ok.example.com/x' }],

  ['nova:device:geolocation', ['device:geolocation'], {}],
  ['nova:device:camera', ['device:camera'], {}],
  ['nova:device:microphone', ['device:microphone'], {}],

  ['nova:calendar:read', ['calendar:read'], {}],
  ['nova:calendar:write', ['calendar:write'], {}],
  ['nova:calendar:delete', ['calendar:delete'], {}],
  ['nova:contacts:read', ['contacts:read'], {}],
  ['nova:contacts:write', ['contacts:write'], {}],
  ['nova:contacts:delete', ['contacts:delete'], {}],

  ['nova:system:info', ['system:info'], {}],

  ['nova:nested-webview', ['sandbox:nested-webview'], {}, { sandbox: { nestedWebviewOptedIn: true } }],

  ['nova:ipc:register', ['apps:communicate'], { endpoint: 'service:echo' }],
  ['nova:ipc:unregister', ['apps:communicate'], { endpoint: 'service:echo' }],
  ['nova:ipc:invoke', ['apps:communicate'], { targetAppId: 'com.other.app', endpoint: 'service:echo', data: {} }],
  ['nova:ipc:reply', ['apps:communicate'], { callId: 'x', result: null }],
  ['nova:ipc:broadcast:subscribe', ['apps:communicate'], { action: 'chat.message' }],
  ['nova:ipc:broadcast', ['apps:communicate'], { action: 'chat.message', data: {} }],

  // Not permission-gated — listed to assert they never deny.
  ['nova:wallpaper:set', null, { key: 'wallpaperId', value: 'wp1' }],
  ['nova:storage:get', null, { key: 'k' }],
  ['nova:storage:set', null, { key: 'k', value: 'v' }],
  ['nova:storage:delete', null, { key: 'k' }],
  ['nova:storage:clear', null, {}],
  ['nova:storage:keys', null, {}],
  ['nova:data:export', ['data:export'], { keys: ['k'] }],
  ['nova:data:import', ['data:export'], { envelope: null }],
  ['nova:data:backup', ['data:backup'], {}],
  ['nova:data:restore', ['data:backup'], { envelope: null }],
  ['nova:window:close', null, {}],
  ['nova:window:minimize', null, {}],
  ['nova:window:maximize', null, {}],
  ['nova:window:setTitle', null, { title: 'T' }],
  ['nova:window:resize', null, { width: 400, height: 300 }],
  ['nova:window:getState', null, {}],
  ['nova:ready', null, {}],
  ['nova:app:info', null, {}],
  ['nova:home:apps:list', null, {}, { sandbox: { homeSurface: true } }],
  ['nova:request-permission', null, { permission: 'clipboard:read' }],
  ['nova:permission-rate-limited', null, { permission: 'clipboard:read' }],
  ['nova:events:unsubscribe', null, { event: 'app:launched' }],
  ['nova:background:wake-done', null, {}],
  ['nova:net:ws:close', null, { id: 'nope' }],
  ['nova:net:ws:send', null, { id: 'nope', data: 'x' }],
];

async function p3() {
  section('[P3] permission matrix (denied without grant, unblocked with)');

  // Seed the SHARED tree: /Documents/a.txt is outside every app's /data
  // prefix, so it's the node fs permission gates actually apply to.
  const fs = state.FS;
  const docs = await fs.createFolder(fs.rootId, 'Documents');
  await fs.createFile(docs.id, 'a.txt', 'shared-content');

  for (const [type, perms, payload, opts = {}] of MATRIX) {
    const appId = 'com.matrix.app';
    const app = AppRegistry.getApp(appId) || makeApp(appId);
    AppRegistry._apps.set(appId, app);

    // fs rows mutate the shared fixture (a granted delete REALLY deletes) —
    // re-seed /Documents/a.txt before every fs row so rows stay independent.
    if (type.startsWith('nova:fs:')) {
      const docsDir = fs.getByPath('/Documents') || await fs.createFolder(fs.rootId, 'Documents');
      if (!fs.getByPath('/Documents/a.txt')) await fs.createFile(docsDir.id, 'a.txt', 'shared-content');
    }

    if (perms === null) {
      // Not permission-gated: assert the plain app is never denied.
      const r = await call(type, payload, {
        app,
        sandbox: makeSandbox(appId, { webview: makeWebview(appId), ...(opts.sandbox || {}) }),
      });
      check(`${type}: not permission-gated (no PERMISSION_DENIED)`, code(r) !== 'PERMISSION_DENIED', code(r));
      continue;
    }

    // Denied case — fresh app id with zero grants.
    const deniedAppId = appId + '.denied';
    const deniedApp = makeApp(deniedAppId, { manifest: app.manifest });
    AppRegistry._apps.set(deniedAppId, deniedApp);
    const deniedPayload = opts.denyOriginal
      ? payload
      : JSON.parse(JSON.stringify(payload).replaceAll('com.matrix.app', deniedAppId));
    const rd = await call(type, deniedPayload, {
      app: deniedApp,
      sandbox: makeSandbox(deniedAppId, { webview: makeWebview(deniedAppId), ...(opts.sandbox || {}) }),
    });
    check(`${type}: denied without grant`, code(rd) === 'PERMISSION_DENIED', code(rd));

    // Granted case — grant every listed perm (any-of semantics still holds).
    for (const p of perms) await grant(p, appId);
    const rg = await call(type, payload, {
      app,
      sandbox: makeSandbox(appId, { webview: makeWebview(appId), ...(opts.sandbox || {}) }),
    });
    check(`${type}: unblocked with ${perms.join('|')}`, code(rg) !== 'PERMISSION_DENIED', code(rg));
    for (const p of perms) await revoke(p, appId);
    AppRegistry._apps.delete(deniedAppId);
  }
}

// ══════════════════════════════════ P4 ══════════════════════════════════

async function p4() {
  section('[P4] storage: CRUD, quotas, caps, isolation, adversarial keys');
  const app = makeApp('com.storage.app');
  AppRegistry._apps.set(app.id, app);

  let r = await call('nova:storage:set', { key: 'greeting', value: 'hello' }, { app });
  check('storage:set ok', r.result?.success === true, code(r));
  r = await call('nova:storage:get', { key: 'greeting' }, { app });
  check('storage:get round-trip', r.result?.value === 'hello', code(r));

  await call('nova:storage:set', { key: 'obj', value: { a: 1, nested: { b: [1, 2, 3] } } }, { app });
  r = await call('nova:storage:get', { key: 'obj' }, { app });
  check('object value round-trips', r.result?.value?.a === 1 && r.result?.value?.nested?.b?.length === 3);

  r = await call('nova:storage:keys', {}, { app });
  check('storage:keys lists both', Array.isArray(r.result?.keys) && r.result.keys.includes('greeting') && r.result.keys.includes('obj'), JSON.stringify(r.result?.keys));

  r = await call('nova:storage:set', { key: 'bad/key', value: 'x' }, { app });
  check('slash in key rejected', code(r) === 'INVALID_ARGS', code(r));
  r = await call('nova:storage:set', { key: '', value: 'x' }, { app });
  check('empty key rejected', code(r) === 'INVALID_ARGS', code(r));
  r = await call('nova:storage:set', { key: '..', value: 'x' }, { app });
  // '..' matches the key charset (dot is literal in the class) — must be
  // accepted as inert data, exactly like '__proto__' below: IDB keys are
  // opaque tuples, not paths.
  check('dotdot key accepted as inert data', r.result?.success === true, code(r));

  // __proto__ matches /^[\w\-. ]+$/ — it must be storable as DATA without
  // corrupting anything (real IDB treats it as an opaque key).
  r = await call('nova:storage:set', { key: '__proto__', value: { polluted: true } }, { app });
  check('__proto__ key accepted as inert data', r.result?.success === true, code(r));
  r = await call('nova:storage:get', { key: '__proto__' }, { app });
  check('__proto__ key round-trips', r.result?.value?.polluted === true);
  check('Object.prototype not polluted', ({}).polluted === undefined);

  r = await call('nova:storage:set', { key: 'big', value: 'x'.repeat(5 * 1024 * 1024 + 1) }, { app });
  check('value > 5MB rejected STORAGE_FULL', code(r) === 'STORAGE_FULL', code(r));
  r = await call('nova:storage:set', { key: 'big', value: 'x'.repeat(1024 * 1024) }, { app });
  check('1MB value accepted', r.result?.success === true, code(r));

  // Per-app quota: 25MB. Overwriting the same key must NOT double-count.
  for (let i = 0; i < 6; i++) {
    r = await call('nova:storage:set', { key: 'big', value: 'y'.repeat(5 * 1024 * 1024) }, { app });
    if (code(r)) break;
  }
  check('overwriting same key does not exhaust 25MB quota', r.result?.success === true, code(r));

  // Cross-app isolation.
  const other = makeApp('com.storage.other');
  AppRegistry._apps.set(other.id, other);
  r = await call('nova:storage:get', { key: 'greeting' }, { app: other });
  check('other app cannot read first app key', r.result?.value === null, JSON.stringify(r.result?.value));

  r = await call('nova:storage:delete', { key: 'greeting' }, { app });
  check('storage:delete ok', r.result?.success === true, code(r));
  r = await call('nova:storage:get', { key: 'greeting' }, { app });
  check('deleted key reads null', r.result?.value === null);
  r = await call('nova:storage:clear', {}, { app });
  check('storage:clear ok', r.result?.success === true, code(r));
  r = await call('nova:storage:keys', {}, { app });
  check('clear wipes all keys', Array.isArray(r.result?.keys) && r.result.keys.length === 0, JSON.stringify(r.result?.keys));

  // Payload bombs.
  r = await call('nova:storage:set', { key: 'k', value: { deep: JSON.parse('{"a":'.repeat(0) + '{"a":1}') } }, { app });
  check('object value accepted', r.result?.success === true, code(r));
  const cyclic = {}; cyclic.self = cyclic;
  r = await call('nova:storage:set', { key: 'k', value: cyclic }, { app });
  check('cyclic value rejected gracefully', code(r) === 'STORAGE_FULL' || code(r) === 'INVALID_ARGS', code(r));
}

// ══════════════════════════════════ P5 ══════════════════════════════════

async function p5() {
  section('[P5] notifications v2 over IPC');
  const app = makeApp('com.notif.app');
  AppRegistry._apps.set(app.id, app);
  await grant('device:notifications', app.id);

  let r = await call('nova:notifications:createChannel', { id: 'msgs', name: 'Messages', importance: 'high' }, { app });
  check('createChannel ok', r.result?.success === true || r.result?.created === true, JSON.stringify(r.result) + ' / ' + code(r));

  r = await call('nova:notifications:post', { channelId: 'msgs', tag: 'chat:alice', title: 'Alice', body: 'hi', actions: [{ id: 'reply', label: 'Reply' }] }, { app });
  check('post to channel ok', r.result?.success === true && r.result?.posted !== false, JSON.stringify(r.result) + ' / ' + code(r));

  r = await call('nova:notifications:post', { channelId: 'msgs', tag: 'chat:alice', title: 'Alice', body: 'updated', progress: { value: 42, max: 100 } }, { app });
  check('same-tag post updates in place', r.result?.success === true && state.OS.notifications.length === 1, JSON.stringify(r.result) + ' / ' + code(r));
  check('progress attached', state.OS.notifications[0]?.progress?.value === 42);

  // Rate budgets: 10 new posts/min, separate 60/min update budget.
  let limited = null;
  for (let i = 0; i < 14; i++) {
    const rr = await call('nova:notifications:post', { channelId: 'msgs', tag: `new:${i}`, title: `t${i}`, body: 'x' }, { app });
    if (code(rr) === 'RATE_LIMITED') { limited = i; break; }
  }
  check('new-post budget enforced (10/min)', limited !== null && limited <= 10, `limited at ${limited}`);

  let updateLimited = null;
  for (let i = 0; i < 65; i++) {
    const rr = await call('nova:notifications:post', { channelId: 'msgs', tag: 'chat:alice', title: 'Alice', body: `tick ${i}` }, { app });
    if (code(rr) === 'RATE_LIMITED') { updateLimited = i; break; }
  }
  check('tag-update budget separate (~60/min)', updateLimited === null || updateLimited >= 55, `limited at ${updateLimited}`);

  // Unknown + muted channels.
  r = await call('nova:notifications:post', { channelId: 'nope', title: 'x', body: 'y' }, { app });
  check('unknown channel rejected', code(r) === 'INVALID_ARGS' || r.result?.posted === false, code(r) + ' ' + JSON.stringify(r.result));
  Notify.setChannelOverride(app.id, 'msgs', { enabled: false });
  r = await call('nova:notifications:post', { channelId: 'msgs', tag: 'mutedtest', title: 'x', body: 'y' }, { app });
  check('muted channel → posted:false / CHANNEL_MUTED', r.result?.posted === false || code(r) === 'CHANNEL_MUTED', code(r) + ' ' + JSON.stringify(r.result));
  Notify.setChannelOverride(app.id, 'msgs', null);

  // Actions round trip.
  r = await call('nova:notifications:consumeActions', {}, { app });
  check('consumeActions responds with queue', r.result !== undefined && code(r) === null, code(r));

  r = await call('nova:notifications:cancel', { tag: 'chat:alice' }, { app });
  check('cancel by tag ok', r.result?.success === true || r.result?.cancelled === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:notifications:cancelAll', {}, { app });
  check('cancelAll ok', r.result?.success === true || r.result?.cancelled !== false, JSON.stringify(r.result) + ' / ' + code(r));
}

// ══════════════════════════════════ P6 ══════════════════════════════════

async function p6() {
  section('[P6] clipboard');
  const app = makeApp('com.clip.app');
  AppRegistry._apps.set(app.id, app);
  await grant('clipboard:write', app.id);
  await grant('clipboard:read', app.id);

  let r = await call('nova:clipboard:write', { text: 'secret-1' }, { app });
  check('clipboard:write ok', r.result?.success === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:clipboard:read', {}, { app });
  check('clipboard:read returns last write', r.result?.text === 'secret-1' || r.result?.value === 'secret-1' || r.result?.content === 'secret-1', JSON.stringify(r.result));

  for (let i = 0; i < 40; i++) await call('nova:clipboard:write', { text: `entry-${i}` }, { app });
  check('history capped at 30', state.OS.clipboardHistory.length <= 30, String(state.OS.clipboardHistory.length));

  await revoke('clipboard:read', app.id);
  r = await call('nova:clipboard:read', {}, { app });
  check('read denied after revoke', code(r) === 'PERMISSION_DENIED', code(r));
}

// ══════════════════════════════════ P7 ══════════════════════════════════

async function p7() {
  section('[P7] window handlers');
  const app = makeApp('com.win.app');
  AppRegistry._apps.set(app.id, app);
  const sandbox = makeSandbox(app.id);

  let r = await call('nova:window:setTitle', { title: 'My Title' }, { app, sandbox });
  check('setTitle ok', r.result?.success === true || code(r) === null, JSON.stringify(r.result) + ' / ' + code(r));

  r = await call('nova:window:resize', { width: 400, height: 300 }, { app, sandbox });
  check('resize ok', code(r) === null || code(r) === 'INVALID_ARGS', code(r));

  r = await call('nova:window:resize', { width: 10, height: 10 }, { app, sandbox });
  check('resize below minimum clamped or rejected', code(r) === null || code(r) === 'INVALID_ARGS', code(r));

  r = await call('nova:window:resize', { width: NaN, height: Infinity }, { app, sandbox });
  check('NaN/Infinity resize rejected or clamped', code(r) === 'INVALID_ARGS' || code(r) === null, code(r));

  r = await call('nova:window:getState', {}, { app, sandbox });
  check('getState returns state object', r.result && typeof r.result === 'object' && code(r) === null, code(r) + ' ' + JSON.stringify(r.result));

  r = await call('nova:window:setTitle', { title: 'x'.repeat(5000) }, { app, sandbox });
  check('huge title rejected or truncated, single response', code(r) !== 'DOUBLE_RESPONSE');

  for (const t of ['nova:window:minimize', 'nova:window:maximize', 'nova:window:close']) {
    r = await call(t, {}, { app, sandbox });
    check(`${t} responds once`, code(r) !== 'DOUBLE_RESPONSE' && code(r) !== 'NO_RESPONSE', code(r));
  }
}

// ══════════════════════════════════ P8 ══════════════════════════════════

async function p8() {
  section('[P8] settings allowlists + wallpaper bypass');
  const app = makeApp('com.set.app');
  AppRegistry._apps.set(app.id, app);

  let r = await call('nova:settings:set', { key: 'theme', value: 'dark' }, { app });
  check('settings:set denied without system:settings', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('system:settings', app.id);
  r = await call('nova:settings:set', { key: 'theme', value: 'dark' }, { app });
  check('settings:set ok with grant', r.result?.success === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:settings:set', { key: 'devMode', value: true }, { app });
  check('devMode not writable by apps', code(r) === 'PERMISSION_DENIED', code(r));
  r = await call('nova:settings:set', { key: 'osVersion', value: '9.9' }, { app });
  check('osVersion not writable by apps', code(r) === 'PERMISSION_DENIED', code(r));
  r = await call('nova:settings:set', { key: 'definitelyNotAKey', value: 1 }, { app });
  check('unknown key not writable', code(r) === 'PERMISSION_DENIED', code(r));

  r = await call('nova:settings:get', { key: 'theme' }, { app });
  check('settings:get denied without system:info', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('system:info', app.id);
  r = await call('nova:settings:get', { key: 'theme' }, { app });
  check('settings:get ok with grant', r.result?.success === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:settings:get', { key: 'definitelyNotAKey' }, { app });
  check('unknown key not readable', code(r) === 'PERMISSION_DENIED', code(r));

  const noPermApp = makeApp('com.set.noperm');
  AppRegistry._apps.set(noPermApp.id, noPermApp);
  r = await call('nova:wallpaper:set', { key: 'wallpaperId', value: 'wp1' }, { app: noPermApp });
  check('wallpaper bypass needs no grant', r.result?.success === true || code(r) === 'POLICY_BLOCKED', JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:wallpaper:set', { key: 'notWallpaper', value: 'x' }, { app: noPermApp });
  check('wallpaper:set non-wallpaper key rejected', code(r) === 'INVALID_ARGS', code(r));

  // Policy block: host rejects wallpaper changes.
  state.OS.settings.set = () => false;
  r = await call('nova:wallpaper:set', { key: 'wallpaperId', value: 'wp2' }, { app: noPermApp });
  check('policy-blocked wallpaper → POLICY_BLOCKED', code(r) === 'POLICY_BLOCKED', code(r));
  state.OS.settings.set = function (k, v) { this._m.set(k, v); return true; };
}

// ══════════════════════════════════ P9 ══════════════════════════════════

async function p9() {
  section('[P9] app-to-app IPC');
  const a = makeApp('com.ipc.a');
  const b = makeApp('com.ipc.b');
  AppRegistry._apps.set(a.id, a);
  AppRegistry._apps.set(b.id, b);
  await grant('apps:communicate', a.id);
  await grant('apps:communicate', b.id);

  // Register endpoint on B (must be an active sandbox).
  const sb = makeSandbox(b.id, { webview: makeWebview(b.id) });
  registerActive(sb);
  let r = await call('nova:ipc:register', { endpoint: 'service:echo' }, { app: b, sandbox: sb, webview: sb.webview });
  check('register declared endpoint ok', r.result?.success === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:ipc:register', { endpoint: 'service:echo' }, { app: b, sandbox: sb, webview: sb.webview });
  check('double register → ALREADY_REGISTERED', code(r) === 'ALREADY_REGISTERED', code(r));
  r = await call('nova:ipc:register', { endpoint: 'service:notmine' }, { app: b, sandbox: sb, webview: sb.webview });
  check('undeclared endpoint denied', code(r) === 'PERMISSION_DENIED', code(r));
  r = await call('nova:ipc:register', { endpoint: 'evil' }, { app: b, sandbox: sb, webview: sb.webview });
  check('bad endpoint pattern rejected', code(r) === 'INVALID_ARGS', code(r));

  // A invokes B's endpoint; B replies through nova:ipc:reply.
  const wvB = sb.webview;
  const invokePromise = call('nova:ipc:invoke', { targetAppId: b.id, endpoint: 'service:echo', data: { ping: 1 } }, { app: a });
  await new Promise((res) => setTimeout(res, 60));
  // respond() types are '<type>:response', so the forwarded request arrives
  // as nova:ipc:request:response with the callId in requestId.
  const fwd = wvB.responses.find((m) => m.type === 'nova:ipc:request:response');
  check('invoke forwarded to target sandbox', !!fwd, JSON.stringify(wvB.responses.map((m) => m.type)));
  if (fwd) {
    await call('nova:ipc:reply', { callId: fwd.requestId, result: { pong: 2 } }, { app: b, sandbox: sb, webview: sb.webview, requestId: 'reply-1' });
  }
  r = await invokePromise;
  check('invoke returns target result', r.result?.pong === 2, JSON.stringify(r.result) + ' / ' + code(r));

  // Reply spoofing: reply to a dead callId.
  r = await call('nova:ipc:reply', { callId: 'deadbeef', result: {} }, { app: b, sandbox: sb, webview: sb.webview });
  check('reply to unknown callId → NOT_FOUND', code(r) === 'NOT_FOUND', code(r));

  // Invoke endpoint the target never declared.
  r = await call('nova:ipc:invoke', { targetAppId: b.id, endpoint: 'service:notmine', data: {} }, { app: a });
  check('invoke undeclared endpoint rejected', code(r) === 'NOT_FOUND' || code(r) === 'UNAVAILABLE' || code(r) === 'PERMISSION_DENIED', code(r));

  // Target without apps:communicate.
  const c = makeApp('com.ipc.c');
  AppRegistry._apps.set(c.id, c);
  r = await call('nova:ipc:invoke', { targetAppId: c.id, endpoint: 'service:echo', data: {} }, { app: a });
  check('invoke target without apps:communicate denied', code(r) === 'PERMISSION_DENIED', code(r));

  // Oversized IPC payload. The default cap is the ledger budget
  // ipcPayloadBytes (256 KB — see StorageLedger.DEFAULT_BUDGETS in
  // app-sandbox.js), so 70 KB now forwards and ~300 KB is what gets rejected.
  r = await call('nova:ipc:invoke', { targetAppId: b.id, endpoint: 'service:echo', data: { blob: 'x'.repeat(300 * 1024) } }, { app: a });
  check('IPC payload > 256KB default budget rejected', code(r) === 'INVALID_ARGS' || code(r) === 'UNAVAILABLE', code(r));

  // Broadcast: B subscribes to declared action, A broadcasts.
  r = await call('nova:ipc:broadcast:subscribe', { action: 'chat.message' }, { app: b, sandbox: sb, webview: sb.webview });
  check('broadcast:subscribe declared action ok', r.result?.success === true, JSON.stringify(r.result) + ' / ' + code(r));
  r = await call('nova:ipc:broadcast:subscribe', { action: 'undeclared.action' }, { app: b, sandbox: sb, webview: sb.webview });
  check('broadcast:subscribe undeclared denied', code(r) === 'PERMISSION_DENIED', code(r));
  r = await call('nova:ipc:broadcast', { action: 'chat.message', data: { hi: true } }, { app: a });
  check('broadcast responds ok', code(r) === null || r.result?.success === true || r.result?.delivered !== undefined, JSON.stringify(r.result) + ' / ' + code(r));
}

// ══════════════════════════════════ P10 ═════════════════════════════════

async function p10() {
  section('[P10] network gates');
  const app = makeApp('com.net.app');
  AppRegistry._apps.set(app.id, app);

  let r = await call('nova:net:fetch', { url: 'https://ok.example.com/x' }, { app });
  check('external fetch denied without net:external', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('net:external', app.id);
  r = await call('nova:net:fetch', { url: 'https://ok.example.com/x' }, { app });
  check('external fetch ok with grant', r.result?.success === true || r.result?.status === 200, JSON.stringify(r.result).slice(0, 120) + ' / ' + code(r));
  check('fetch stub actually called', fetchCalls.length === 1, String(fetchCalls.length));

  r = await call('nova:net:fetch', { url: 'file:///etc/passwd' }, { app });
  check('file: protocol rejected', code(r) === 'INVALID_ARGS' || code(r) === 'PERMISSION_DENIED', code(r));

  r = await call('nova:net:fetch', { url: 'http://127.0.0.1:3003/x' }, { app });
  check('internal host needs net:internal', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('net:internal', app.id);
  r = await call('nova:net:fetch', { url: 'http://127.0.0.1:3003/x' }, { app });
  check('internal host ok with net:internal', code(r) !== 'PERMISSION_DENIED', code(r));

  r = await call('nova:net:websocket', { url: 'wss://ok.example.com/ws' }, { app: makeApp('com.net.app2') });
  check('websocket denied without grant', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('net:websocket', 'com.net.app2');
  r = await call('nova:net:websocket', { url: 'wss://ok.example.com/ws' }, { app: makeApp('com.net.app2') });
  check('websocket ok with grant', code(r) !== 'PERMISSION_DENIED', code(r));
}

// ══════════════════════════════════ P11 ═════════════════════════════════

async function p11() {
  section('[P11] events subscriptions');
  const app = makeApp('com.ev.app');
  AppRegistry._apps.set(app.id, app);
  const sandbox = makeSandbox(app.id);

  let r = await call('nova:events:subscribe', { event: 'some.custom.event' }, { app, sandbox });
  check('non-sensitive subscribe without grant allowed', code(r) !== 'PERMISSION_DENIED', code(r));

  r = await call('nova:events:subscribe', { event: 'app:launched' }, { app, sandbox });
  check('sensitive subscribe denied without system:events', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('system:events', app.id);
  r = await call('nova:events:subscribe', { event: 'app:launched' }, { app, sandbox });
  check('sensitive subscribe ok with grant', code(r) !== 'PERMISSION_DENIED', code(r));

  r = await call('nova:events:subscribe', { event: 'mail:new' }, { app, sandbox });
  check('domain event (mail:new) needs mail:read too', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('mail:read', app.id);
  r = await call('nova:events:subscribe', { event: 'mail:new' }, { app, sandbox });
  check('domain event ok with both grants', code(r) !== 'PERMISSION_DENIED', code(r));

  // WebSocket push events — the raw nova:net:websocket data plane made
  // subscribable. Gated on net:websocket (the connect permission), NOT
  // system:events; delivery is same-app filtered in the subscribe handler.
  r = await call('nova:events:subscribe', { event: 'nova:net:ws:message' }, { app, sandbox });
  check('ws push event needs net:websocket', code(r) === 'PERMISSION_DENIED', code(r));
  await grant('net:websocket', app.id);
  r = await call('nova:events:subscribe', { event: 'nova:net:ws:message' }, { app, sandbox });
  check('ws push event subscribable with net:websocket', code(r) !== 'PERMISSION_DENIED', code(r));
  r = await call('nova:events:subscribe', { event: 'nova:net:ws:error' }, { app, sandbox });
  check('ws error event subscribable with net:websocket', code(r) !== 'PERMISSION_DENIED', code(r));
  r = await call('nova:events:subscribe', { event: 'nova:net:ws:close' }, { app, sandbox });
  check('ws close event subscribable with net:websocket', code(r) !== 'PERMISSION_DENIED', code(r));

  r = await call('nova:events:subscribe', { event: 'x' }, { app, sandbox });
  check('subscribing same event twice tolerated', code(r) !== 'DOUBLE_RESPONSE', code(r));

  r = await call('nova:events:unsubscribe', { event: 'mail:new' }, { app, sandbox });
  check('unsubscribe ok', code(r) === null || r.result?.success === true, code(r));
  r = await call('nova:events:unsubscribe', { event: 'never:subscribed' }, { app, sandbox });
  check('unsubscribe unknown tolerated', code(r) !== 'DOUBLE_RESPONSE' && code(r) !== 'NO_RESPONSE', code(r));
}

// ══════════════════════════════════ P12 ═════════════════════════════════

async function p12() {
  section('[P12] stress + adversarial');
  resetHost();
  const app = makeApp('com.stress.app');
  AppRegistry._apps.set(app.id, app);

  // 200 concurrent storage writes across two apps.
  const apps2 = [app, makeApp('com.stress.app2')];
  apps2.forEach((a) => AppRegistry._apps.set(a.id, a));
  const jobs = [];
  for (let i = 0; i < 200; i++) {
    const a = apps2[i % 2];
    jobs.push(call('nova:storage:set', { key: `k${i}`, value: `v${i}` }, { app: a }));
  }
  const results = await Promise.all(jobs);
  const bad = results.filter((r) => r.result?.success !== true);
  check('200 concurrent storage:set all succeed', bad.length === 0, JSON.stringify(bad.slice(0, 2).map((r) => r.error)));
  const dbl = results.filter((r) => code(r) === 'DOUBLE_RESPONSE');
  check('no double responses under concurrency', dbl.length === 0, String(dbl.length));

  // 40 concurrent posts: exactly 10 accepted (per-minute budget).
  await grant('device:notifications', app.id);
  await call('nova:notifications:createChannel', { id: 'general', name: 'General', importance: 'default' }, { app });
  const postJobs = [];
  for (let i = 0; i < 40; i++) {
    postJobs.push(call('nova:notifications:post', { channelId: 'general', tag: `p:${i}`, title: `t${i}`, body: 'x' }, { app }));
  }
  const postResults = await Promise.all(postJobs);
  const rateLimited = postResults.filter((r) => code(r) === 'RATE_LIMITED').length;
  const posted = postResults.filter((r) => r.result?.posted !== false && code(r) === null).length;
  check('concurrent post burst: rate limiter engages', rateLimited > 0 && posted <= 10, `posted=${posted} limited=${rateLimited}`);
  check('no double responses under notification burst', postResults.every((r) => code(r) !== 'DOUBLE_RESPONSE'));

  // Deep-nested payload through settings:set (validate key first → denied, no crash).
  let deep = { v: 1 };
  for (let i = 0; i < 500; i++) deep = { w: deep };
  const rDeep = await call('nova:settings:set', { key: 'theme', value: deep }, { app: makeApp('com.stress.app3') });
  check('deep-nested value no crash, single response', code(rDeep) !== 'DOUBLE_RESPONSE' && code(rDeep) !== 'NO_RESPONSE', code(rDeep));

  // 2MB title through notifications:show.
  const rBig = await call('nova:notifications:show', { title: 'x'.repeat(2 * 1024 * 1024), body: 'b' }, { app });
  check('2MB notification title rejected gracefully', code(rBig) === 'INVALID_ARGS' || code(rBig) === 'RATE_LIMITED' || code(rBig) === null, code(rBig));

  // requestId reuse across different types.
  const r1 = await call('nova:storage:set', { key: 'a', value: 1 }, { app, requestId: 'dup-1' });
  const r2 = await call('nova:storage:keys', {}, { app, requestId: 'dup-1' });
  check('requestId reuse: both answered correctly', r1.result?.success === true && Array.isArray(r2.result?.keys));

  // Emoji + RTL text in notification fields.
  const rEmoji = await call('nova:notifications:show', { title: '🚀🎉 '.repeat(50), body: 'مرحبا שלום 你好' }, { app: makeApp('com.stress.app4') });
  check('emoji/RTL notification single response', code(rEmoji) !== 'DOUBLE_RESPONSE' && code(rEmoji) !== 'NO_RESPONSE', code(rEmoji));

  // Permission-rate-limited probe for an ungrantable permission value.
  const rPerm = await call('nova:permission-rate-limited', { permission: 'device:notifications' }, { app });
  check('permission-rate-limited responds', code(rPerm) !== 'DOUBLE_RESPONSE' && code(rPerm) !== 'NO_RESPONSE', code(rPerm));
}

// ══════════════════════════════════ main ════════════════════════════════

const FILTER = process.argv.find((a) => a.startsWith('--filter'))?.split('=')[1] || '';
const PHASES = [
  ['P0', p0], ['P1', p1], ['P2', p2], ['P3', p3],
  ['P4', p4], ['P5', p5], ['P6', p6], ['P7', p7],
  ['P8', p8], ['P9', p9], ['P10', p10], ['P11', p11], ['P12', p12],
];

(async () => {
  for (const [name, fn] of PHASES) {
    if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase().replace(/^--filter=/i, ''))) continue;
    resetHost();
    try {
      await fn();
    } catch (e) {
      fail++;
      console.log(`  FAIL phase ${name} crashed: ${e.stack || e}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
