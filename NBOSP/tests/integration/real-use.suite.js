'use strict';
// NovaByte OS — real-use IPC + permission scenario suite.
//
// Where test_ipc_matrix.js proves the BRIDGE CONTRACT (every handler, every
// payload shape, every permission gate), this suite proves the flows an
// actual application lives through, end to end, on the real host modules
// (AppSandbox, AppPermissionManager, Notify, fake FS/IndexedDB):
//
//   R1   fresh boot → install → first-run permission prompts (real dialogs)
//   R2   denial → re-prompt → prompt-bomb rate limiting → reset
//   R3   multi-permission onboarding via requestAll (sequential dialogs)
//   R4   chat app: channels, tag updates, budgets, mute, user action taps
//   R5   mid-session revocation and revoke-all against a live session
//   R6   gallery app: scoped media reads, metadata, fs:access, ownership
//   R7   two apps talking: ipc register/invoke/reply/broadcast + abuse
//   R8   network: internal/external classification + websocket lifecycle
//   R9   settings/wallpaper/appearance + event domains
//   R10  permission lifecycle: expiry, recordAppUse, auto-grant, root
//   R11  install/uninstall via IPC: cleanup contract (storage + permissions)
//   R12  multi-app concurrency: independent budgets, isolation, unicode
//   R13  push delivery: register → live push → closed queue → OS-attributed
//        notification → wake request → flush-on-relaunch → revocation door
//
// The permission dialog is REAL here: AppPermissionManager builds its actual
// overlay into a clickable DOM stub and the suite clicks Allow/Deny exactly
// like a user would, so prompt sequencing, persistence, the prompt-bomb
// rate limiter and the root acknowledgement checkbox all run their
// production code paths. Notification action taps likewise go through the
// service's real toast buttons, not by calling internals directly.
//
// Usage: node tests/test_real_use.js [--filter R4] [--verbose]

const env = require('../helpers/env');
const {
  AppSandbox, AppPermissionManager: PM, Notify,
  makeApp, makeWebview, makeSandbox, call, grant, revoke, resetHost, registerActive,
  fetchCalls, state,
} = env;

const INTERNAL = AppSandbox._internal;
// The host page has both modules on window, so AppPermissionManager's live
// revocation callbacks (handlePermissionRevoked / reloadAfterRootRevocation)
// reach the sandbox. env.js only exports the module — mirror the real
// wiring here or mid-session revocation silently does nothing.
global.AppSandbox = AppSandbox;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }
const code = (r) => r?.error?.code ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════ rich clickable DOM ══════════════════════════
//
// The env.js stub document is inert (addEventListener is a no-op), which is
// fine for the matrix suite but means the permission dialog can never be
// answered. The real-use suite swaps in a DOM whose nodes CAPTURE listeners
// so tests can click Allow / Deny / the root checkbox and tap notification
// action buttons exactly like a user.

function makeRichNode(tag) {
  const handlers = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, children: [],
    textContent: '', value: '', className: '',
    disabled: false, checked: false, removed: false,
    append(...kids) { for (const k of kids) node.children.push(k); },
    appendChild(k) { node.children.push(k); return k; },
    replaceChildren(...kids) { node.children.length = 0; node.children.push(...kids); },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    removeEventListener() {},
    setAttribute(k, v) { (node.attrs ||= {})[k] = String(v); },
    removeAttribute(k) { if (node.attrs) delete node.attrs[k]; },
    remove() { node.removed = true; },
    focus() {}, select() {},
    classList: {
      add(...c) { node.classListStore = new Set([...(node.classListStore || []), ...c]); },
      remove(...c) { for (const x of c) node.classListStore?.delete(x); },
      toggle() {},
      contains(c) { return node.classListStore?.has(c) ?? false; },
    },
    __handlers: handlers,
    __fire(type, evt = {}) {
      for (const fn of handlers[type] || []) fn({ stopPropagation() {}, preventDefault() {}, ...evt });
    },
  };
  return node;
}

function findInTree(root, pred) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (pred(n)) return n;
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return null;
}
function findAllInTree(root, pred, out = []) {
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    if (pred(n)) out.push(n);
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return out;
}
const isButtonWithText = (n, text) => n?.tagName === 'BUTTON' && n.textContent === text;

let toastContainer = null;
function installRichDocument() {
  toastContainer = makeRichNode('div');
  toastContainer.id = 'toast-container';

  const body = makeRichNode('body');
  const head = makeRichNode('head');

  global.document = {
    readyState: 'complete',
    body, head,
    addEventListener() {},
    removeEventListener() {},
    cookie: '',
    getElementById(id) { return id === 'toast-container' ? toastContainer : null; },
    createElement(tag) { return makeRichNode(tag); },
    createTextNode(text) { const n = makeRichNode('#text'); n.textContent = text; return n; },
    createDocumentFragment() { return makeRichNode('#fragment'); },
    execCommand: () => true,
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  // Notify's createEl(tag, { className, textContent, role, style }) — style
  // may be a cssText string (toast actions) or a property object (panel).
  global.createEl = (tag, opts = {}) => {
    const n = makeRichNode(tag);
    if (opts.className != null) n.className = opts.className;
    if (opts.textContent != null) n.textContent = opts.textContent;
    if (opts.role != null) n.setAttribute('role', opts.role);
    if (opts.style != null) {
      if (typeof opts.style === 'string') n.style.cssText = opts.style;
      else Object.assign(n.style, opts.style);
    }
    if (typeof opts === 'object' && opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (['className', 'textContent', 'role', 'style'].includes(k)) continue;
        n.setAttribute(k, v);
      }
    }
    return n;
  };

  // Keep the original env stubs working for anything else that renders.
  const prevSvg = global.svgIcon;
  global.svgIcon = prevSvg || (() => '');
}

// ── permission dialog drivers ──

function openDialogOverlays() { return global.document.body.children.filter((n) => !n.removed); }

// Starts a bridge permission request and waits for the REAL dialog overlay
// to appear. Returns { promise, overlay } — overlay is null when no dialog
// was shown (auto-denied by the rate limiter / short-circuited).
async function requestPermissionViaBridge(appId, permission, opts = {}) {
  const app = state.AppRegistry.getApp(appId) || makeApp(appId);
  if (!state.AppRegistry.getApp(appId)) state.AppRegistry._apps.set(appId, app);
  const promise = call('nova:request-permission', {
    permission,
    reason: opts.reason,
    permanent: opts.permanent,
  }, { app });
  const deadline = Date.now() + 750;
  let overlay = null;
  while (Date.now() < deadline) {
    await sleep(10);
    overlay = openDialogOverlays().find((o) => findInTree(o, (n) => isButtonWithText(n, 'Allow') || isButtonWithText(n, 'Grant Root Access')));
    if (overlay) break;
  }
  return { promise, overlay };
}

async function clickAllow(overlay) {
  const btn = findInTree(overlay, (n) => isButtonWithText(n, 'Allow') || isButtonWithText(n, 'Grant Root Access'));
  if (!btn) throw new Error('Allow button not found in dialog');
  if (btn.disabled) throw new Error('Allow button is disabled (root acknowledgement missing?)');
  btn.__fire('click');
}
async function clickDeny(overlay) {
  const btn = findInTree(overlay, (n) => isButtonWithText(n, 'Deny'));
  if (!btn) throw new Error('Deny button not found in dialog');
  btn.__fire('click');
}
async function tickRootCheckbox(overlay) {
  const box = findInTree(overlay, (n) => n.tagName === 'INPUT');
  if (!box) throw new Error('root acknowledgement checkbox not found');
  box.checked = true;
  box.__fire('change');
}

// ── session helpers ──

// A persistent app session: registered in AppRegistry, an active sandbox and
// its own webview so nova:ipc:* and sandbox-scoped calls keep identity.
function session(appId, extra = {}) {
  const app = makeApp(appId, { name: extra.name || appId, manifest: extra.manifest, permissions: extra.permissions });
  state.AppRegistry._apps.set(appId, app);
  // Launched apps live in OS.apps — notification channel seeding and the
  // app:launch handlers read manifests from there.
  global.OS.apps[appId] = app;
  const webview = makeWebview(appId);
  const sandbox = makeSandbox(appId, { webview, ...extra.sandboxExtras });
  registerActive(sandbox);
  // createSandbox() seeds the per-sandbox event subscription map (line
  // "eventSubscriptions.set(sandboxId, new Map())"); mirror it so the
  // duplicate-subscription and unsubscribe paths run as in production.
  INTERNAL._eventSubscriptions.set(webview.dataset.sandboxId, new Map());
  return { app, webview, sandbox, id: appId };
}
function freshSessionId(prefix) {
  freshIdCounter += 1;
  return `${prefix}.r${freshIdCounter}`;
}
let freshIdCounter = 0;

const openedWindows = [];
function installWindowCapture() {
  global.WM.createWindow = (appId) => { openedWindows.push(appId); return null; };
  // Real WebSocket classes expose numeric readyState constants; the stub in
  // env.js doesn't, and handleNetWsSend compares against WebSocket.OPEN.
  global.WebSocket.OPEN = 1;
  global.WebSocket.CLOSED = 3;
  global.WebSocket.CONNECTING = 0;
  global.WebSocket.CLOSING = 2;
}

function scenarioReset() {
  resetHost();
  global.OS.apps = {};
  // boot.js stores the account name in settings (OS.username = sGet('username')).
  global.OS.settings.set('username', 'nova');
  global.OS.events = makeEmitter();
  toastContainer.children.length = 0;
  openedWindows.length = 0;
  fetchCalls.length = 0;
}

function makeEmitter() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, []).get(ev)).push(fn); },
    off(ev, fn) { const l = map.get(ev); if (l) { const i = l.indexOf(fn); if (i > -1) l.splice(i, 1); } },
    emit(ev, data) { for (const fn of [...(map.get(ev) || [])]) fn(data); },
  };
}

// ════════════════════════════════ R1 ════════════════════════════════════

async function r1() {
  section('[R1] fresh boot → install → first-run permission prompts');
  scenarioReset();

  const chat = session(freshSessionId('com.chat.demo'), { permissions: ['clipboard:read'] });
  check('new app starts with zero grants', PM.getAppPermissions(chat.id).length === 0);

  // nova:ready handshake reflects the empty grant table and hides the
  // username from non-system apps.
  const ready = await call('nova:ready', {}, { app: chat.app, webview: chat.webview, sandbox: chat.sandbox });
  check('nova:ready succeeds', ready.result?.success === true, code(ready));
  check('ready lists no granted permissions', Array.isArray(ready.result?.permissions) && ready.result.permissions.length === 0);
  check('ready hides username from non-system apps', ready.result?.username === undefined);

  // First-run prompt for clipboard:read — real dialog, user clicks Allow.
  const first = await requestPermissionViaBridge(chat.id, 'clipboard:read', { reason: 'Share links with friends' });
  check('first-run request shows a dialog', !!first.overlay);
  const label = findInTree(first.overlay, (n) => n.textContent === 'Read clipboard');
  check('dialog shows the human-readable permission label', !!label);
  const askedBy = findInTree(first.overlay, (n) => typeof n.textContent === 'string' && n.textContent.includes(chat.id));
  check('dialog names the asking app', !!askedBy);

  await clickAllow(first.overlay);
  const firstRes = await first.promise;
  check('bridge returns granted:true after Allow', firstRes.result?.granted === true, JSON.stringify(firstRes.error || ''));
  check('grant persisted in the permission manager', PM.isGranted('clipboard:read', chat.id) === true);
  check('grant written to localStorage', JSON.stringify(state.ls.get('nova_app_permissions') || []).includes(chat.id));
  check('dialog removed after answering', first.overlay.removed === true);

  // Second request for the same permission must not prompt again.
  const second = await requestPermissionViaBridge(chat.id, 'clipboard:read');
  check('already-granted request does not re-prompt', !second.overlay);
  const secondRes = await second.promise;
  check('already-granted request returns granted:true', secondRes.result?.granted === true, code(secondRes));

  // Ready handshake now reports the grant.
  const ready2 = await call('nova:ready', {}, { app: chat.app, webview: chat.webview, sandbox: chat.sandbox });
  check('ready now reports the granted permission', ready2.result?.permissions?.includes('clipboard:read') === true);

  // The rate-limit status endpoint a well-behaved app checks first.
  const rl = await call('nova:permission-rate-limited', { permission: 'clipboard:read' }, { app: chat.app, webview: chat.webview, sandbox: chat.sandbox });
  check('rate-limit status reports not limited', rl.result?.limited === false, code(rl));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R2 ════════════════════════════════════

async function r2() {
  section('[R2] denial → re-prompt → prompt-bomb rate limiting → reset');
  scenarioReset();

  const pushy = session(freshSessionId('com.pushy.app'));
  const perm = 'device:geolocation';

  // Deny #1 — real dialog, real Deny click.
  const d1 = await requestPermissionViaBridge(pushy.id, perm);
  check('denial shows a dialog', !!d1.overlay);
  await clickDeny(d1.overlay);
  const r1res = await d1.promise;
  check('bridge returns granted:false after Deny', r1res.result?.granted === false, code(r1res));
  check('denial persisted (isDenied)', PM.isDenied(perm, pushy.id) === true);
  check('denial is not a grant', PM.isGranted(perm, pushy.id) === false);

  // A denied app still gets re-asked live (documented re-prompt behavior),
  // three times within the burst window.
  for (let i = 2; i <= 3; i++) {
    const d = await requestPermissionViaBridge(pushy.id, perm);
    check(`re-prompt #${i} still shows a dialog`, !!d.overlay);
    await clickDeny(d.overlay);
    const res = await d.promise;
    check(`re-prompt #${i} returns granted:false`, res.result?.granted === false, code(res));
  }

  // 4th request inside the window: prompt-bomb protection kicks in — auto
  // deny, NO dialog at all, and a security-log entry.
  const before = openDialogOverlays().length;
  const bomb = await requestPermissionViaBridge(pushy.id, perm);
  const bombRes = await Promise.race([bomb.promise, sleep(400).then(() => null)]);
  check('4th request inside window shows NO dialog', !bomb.overlay);
  check('4th request auto-denied', bombRes?.result?.granted === false, code(bombRes) || 'timeout');
  check('no dialog leaked into the DOM', openDialogOverlays().length === before);

  const limited = PM.isRateLimited(perm, pushy.id);
  check('isRateLimited reports cooldown', limited.limited === true && limited.retryAfterMs > 0, JSON.stringify(limited));
  const rateLimitedLog = state.FS && global.EventLog.entries.filter((e) => e.data?.action === 'rate-limited');
  check('rate-limited request written to the security log', (global.EventLog.entries.filter((e) => e.data?.action === 'rate-limited')).length > 0);

  // The rate-limit status endpoint mirrors the cooldown to the app.
  const rl = await call('nova:permission-rate-limited', { permission: perm }, { app: pushy.app, webview: pushy.webview, sandbox: pushy.sandbox });
  check('rate-limit status endpoint reports limited', rl.result?.limited === true, code(rl));

  // resetPermission (what Settings' "reset" does) clears denial + cooldown.
  await PM.resetPermission(perm, pushy.id);
  check('reset clears rate-limit state', PM.isRateLimited(perm, pushy.id).limited === false);
  check('reset clears denial record', PM.isDenied(perm, pushy.id) === false);
  const after = await requestPermissionViaBridge(pushy.id, perm);
  check('post-reset request prompts again', !!after.overlay);
  await clickDeny(after.overlay);
  await after.promise;

  PM.closeAllDialogs();
}

// ════════════════════════════════ R3 ════════════════════════════════════

async function r3() {
  section('[R3] onboarding: requestAll sequential dialogs with pager');
  scenarioReset();

  const onboard = session(freshSessionId('com.onboard.app'));

  // requestAll is what a launch-time onboarding flow drives. clipboard:read
  // is not yet granted, clipboard:write and device:notifications pending.
  // Drive it through the REAL requestPermission queue — dialogs appear one
  // at a time; the user grants everything.
  const perms = ['clipboard:read', 'clipboard:write', 'device:notifications'];
  const allPromise = PM.requestAll(perms, onboard.id, 'Onboard Demo');
  const grantedSet = [];

  for (let i = 0; i < perms.length; i++) {
    const deadline = Date.now() + 1000;
    let overlay = null;
    while (Date.now() < deadline && !overlay) {
      await sleep(10);
      overlay = openDialogOverlays().find((o) => findInTree(o, (n) => isButtonWithText(n, 'Allow')));
    }
    check(`onboarding dialog ${i + 1} appeared`, !!overlay);
    const pager = findInTree(overlay, (n) => typeof n.textContent === 'string' && /Permission \d+ of \d+/.test(n.textContent));
    check(`dialog ${i + 1} shows pager "Permission ${i + 1} of ${perms.length}"`,
      !!pager && pager.textContent === `Permission ${i + 1} of ${perms.length}`, pager?.textContent);
    await clickAllow(overlay);
    await sleep(30);
  }

  const allGranted = await allPromise;
  check('requestAll resolves true when everything allowed', allGranted === true);
  for (const p of perms) check(`requestAll granted ${p}`, PM.isGranted(p, onboard.id) === true);

  // Mixed onboarding: one deny must not block the remaining prompts, but
  // requestAll reports false overall (the app shows a "limited experience").
  const mixed = session(freshSessionId('com.mixed.app'));
  const mixedPerms = ['device:geolocation', 'device:notifications'];
  const mixedPromise = PM.requestAll(mixedPerms, mixed.id, 'Mixed Demo');
  const outcomes = [];
  for (let i = 0; i < mixedPerms.length; i++) {
    const deadline = Date.now() + 1000;
    let overlay = null;
    while (Date.now() < deadline && !overlay) {
      await sleep(10);
      overlay = openDialogOverlays().find((o) => findInTree(o, (n) => isButtonWithText(n, 'Allow')));
    }
    if (!overlay) break;
    outcomes.push(i === 0 ? await (clickDeny(overlay), sleep(30)) : await (clickAllow(overlay), sleep(30)));
  }
  const mixedResult = await mixedPromise;
  check('requestAll returns false when one permission denied', mixedResult === false);
  check('denied one stays denied', PM.isGranted('device:geolocation', mixed.id) === false);
  check('later prompts still ran and granted', PM.isGranted('device:notifications', mixed.id) === true);

  // requestAll skips already-granted and specialAccess permissions entirely
  // (fs:access can never be prompted for — the known dangerous legacy grant).
  const skip = session(freshSessionId('com.skip.app'));
  await PM.grantPermission('clipboard:write', skip.id);
  const skipPromise = PM.requestAll(['fs:access', 'clipboard:write'], skip.id, 'Skip Demo');
  await sleep(150);
  check('fs:access is never promptable and granted perms are skipped', openDialogOverlays().length === 0);
  check('requestAll with nothing pending resolves true', await skipPromise === true);

  PM.closeAllDialogs();
}

// ════════════════════════════════ R4 ════════════════════════════════════

async function r4() {
  section('[R4] chat app: channels, tag updates, budgets, mute, action taps');
  scenarioReset();

  const chat = session(freshSessionId('com.chat.app'), {
    manifest: {
      ipc: { exports: ['service:chat'], receives: ['chat.message'] },
      notifications: { channels: [{ id: 'declared', name: 'Declared in manifest', importance: 'high' }] },
    },
  });
  // Grant through the real prompt — Allow like a user.
  const gp = await requestPermissionViaBridge(chat.id, 'device:notifications');
  await clickAllow(gp.overlay);
  await gp.promise;
  check('device:notifications granted via dialog', PM.isGranted('device:notifications', chat.id) === true);

  const ctx = { app: chat.app, webview: chat.webview, sandbox: chat.sandbox };

  // Manifest-declared channels are seeded on first notification API use.
  const declared = await call('nova:notifications:createChannel', { id: 'messages', name: 'Messages', importance: 'high' }, ctx);
  check('createChannel succeeds', declared.result?.success === true && declared.result?.created === true, code(declared));
  check('manifest channel auto-seeded', Notify.listChannels(chat.id).some((c) => c.id === 'declared'));

  // Android parity: importance locked at creation — a re-create with a lower
  // importance is a no-op and the response reports the effective value.
  const reCreate = await call('nova:notifications:createChannel', { id: 'messages', name: 'Messages', importance: 'low' }, ctx);
  check('re-create reports created:false', reCreate.result?.created === false, code(reCreate));
  check('importance stays locked at high', reCreate.result?.channel?.importance === 'high', JSON.stringify(reCreate.result));

  // A chat message arrives — posted on the messages channel with actions.
  const post = await call('nova:notifications:post', {
    channelId: 'messages', tag: 'chat-42', title: 'Alice', body: 'Hey! Are we still on for tonight?',
    actions: [{ id: 'reply', label: 'Reply' }, { id: 'mark-read', label: 'Mark read' }],
  }, ctx);
  check('post succeeds', post.result?.success === true && post.result?.posted === true, code(post) || JSON.stringify(post.result));
  const notifId = post.result?.id;
  check('post returns a notification id', typeof notifId === 'string' && notifId.length > 0);

  // The toast rendered with REAL action buttons — find and click "Reply"
  // exactly like a user tap.
  const toastBtns = findAllInTree(toastContainer, (n) => n.className === 'toast-action');
  check('toast rendered with 2 action buttons', toastBtns.length === 2, `got ${toastBtns.length}`);
  const replyBtn = toastBtns.find((b) => b.textContent === 'Reply');
  check('Reply button exists', !!replyBtn);
  replyBtn.__fire('click', {});
  await sleep(20);
  check('tapping action opened the posting app', openedWindows.includes(chat.id), JSON.stringify(openedWindows));

  // The app drains the action queue on resume — the Android pull contract.
  const consumed = await call('nova:notifications:consumeActions', {}, ctx);
  check('consumeActions delivers the tapped action', consumed.result?.actions?.length === 1
    && consumed.result.actions[0].actionId === 'reply', JSON.stringify(consumed.result));
  const consumedAgain = await call('nova:notifications:consumeActions', {}, ctx);
  check('queue is drained (consume-once)', consumedAgain.result?.actions?.length === 0);

  // Progress ticker: the FIRST post under a tag creates (updated:false);
  // subsequent same-tag posts update in place (updated:true, same id).
  let last = null;
  for (const [pct, expectUpdate] of [[10, false], [25, true], [50, true], [75, true], [90, true]]) {
    last = await call('nova:notifications:post', {
      channelId: 'messages', tag: 'dl-1', title: 'Downloading', body: `${pct}%`,
      progress: { value: pct, max: 100 },
    }, ctx);
    check(`tag post at ${pct}% ${expectUpdate ? 'updates in place' : 'creates'}`, last.result?.updated === expectUpdate, code(last) || JSON.stringify(last.result));
  }
  const updatedNotif = Notify.findByTag(chat.id, 'dl-1');
  check('tag updates reused one notification', !!updatedNotif && updatedNotif.body === '90%' && updatedNotif.progress?.value === 90, JSON.stringify(updatedNotif && { body: updatedNotif.body, progress: updatedNotif.progress }));
  check('update kept a different id than the chat post', updatedNotif.id !== notifId);

  // Omitting fields on update keeps them (progress ticker shouldn't have to
  // re-list its buttons).
  const keep = await call('nova:notifications:post', { channelId: 'messages', tag: 'chat-42', title: 'Alice', body: '(edited)' }, ctx);
  check('tag update reports updated:true', keep.result?.updated === true, code(keep));
  const keptNotif = Notify.findByTag(chat.id, 'chat-42');
  check('omitted actions kept from previous post', (keptNotif?.actions || []).map((a) => a.id).join(',') === 'reply,mark-read', JSON.stringify(keptNotif?.actions));

  // Budgets: separate new-post (10/min) and tag-update (60/min) budgets.
  // Fill the update budget with same-tag posts…
  let updateLimited = null;
  for (let i = 0; i < 60; i++) {
    updateLimited = await call('nova:notifications:post', { channelId: 'messages', tag: 'dl-1', title: 'Downloading', body: `tick ${i}` }, ctx);
    if (code(updateLimited)) break;
  }
  check('61st tag update inside a minute is RATE_LIMITED', code(updateLimited) === 'RATE_LIMITED', code(updateLimited));
  // …while NEW posts still have their own budget left.
  const freshPost = await call('nova:notifications:post', { channelId: 'messages', title: 'Bob', body: 'separate budget' }, ctx);
  check('new-post budget unaffected by update budget', freshPost.result?.posted === true, code(freshPost));
  // …until the new-post budget (10/min) runs out too.
  let newLimited = null;
  for (let i = 0; i < 12; i++) {
    newLimited = await call('nova:notifications:post', { channelId: 'messages', title: `spam ${i}`, body: 'x' }, ctx);
    if (code(newLimited)) break;
  }
  check('11th NEW post inside a minute is RATE_LIMITED', code(newLimited) === 'RATE_LIMITED', code(newLimited));

  // User mutes the channel in Settings → posts become silent no-ops, not
  // errors (Android CHANNEL_MUTED contract).
  Notify.setChannelOverride(chat.id, 'messages', { enabled: false });
  const muted = await call('nova:notifications:post', { channelId: 'messages', title: 'Alice', body: 'while muted' }, ctx);
  check('muted channel: success with posted:false', muted.result?.success === true && muted.result?.posted === false && muted.result?.reason === 'CHANNEL_MUTED', JSON.stringify(muted.result));
  Notify.setChannelOverride(chat.id, 'messages', { enabled: true });

  // Unknown channel is an app bug → precise error, not a silent drop.
  const unknown = await call('nova:notifications:post', { channelId: 'nope', title: 'x', body: 'y' }, ctx);
  check('unknown channel rejected with INVALID_ARGS', code(unknown) === 'INVALID_ARGS', code(unknown));

  // Tap-through on the toast body opens the app too.
  openedWindows.length = 0;
  const bodyClick = findAllInTree(toastContainer, (n) => n.className === 'toast-content').pop();
  check('toast body exists for tap-through', !!bodyClick);
  bodyClick.__fire('click', {});
  await sleep(10);
  check('tapping the notification opens the app', openedWindows.includes(chat.id), JSON.stringify(openedWindows));

  // Housekeeping: cancel by tag, cancelAll.
  const cancelByTag = await call('nova:notifications:cancel', { tag: 'dl-1' }, ctx);
  check('cancel by tag removes the ticker', cancelByTag.result?.success === true && cancelByTag.result?.removed === true, JSON.stringify(cancelByTag.result));
  const cancelAll = await call('nova:notifications:cancelAll', {}, ctx);
  check('cancelAll clears the app’s notifications', cancelAll.result?.success === true);
  check('no notifications left for the app', !OS.notifications.some((n) => n.appId === chat.id));

  // Without the grant nothing in the v2 surface works.
  const outsider = session(freshSessionId('com.chat.outsider'));
  const octx = { app: outsider.app, webview: outsider.webview, sandbox: outsider.sandbox };
  const deniedPost = await call('nova:notifications:post', { channelId: 'general', title: 'x', body: 'y' }, octx);
  check('posting without the grant is PERMISSION_DENIED', code(deniedPost) === 'PERMISSION_DENIED', code(deniedPost));
  const deniedConsume = await call('nova:notifications:consumeActions', {}, octx);
  check('consuming actions without the grant is PERMISSION_DENIED', code(deniedConsume) === 'PERMISSION_DENIED', code(deniedConsume));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R5 ════════════════════════════════════

async function r5() {
  section('[R5] mid-session revocation against a live session');
  scenarioReset();

  const live = session(freshSessionId('com.live.app'));
  await PM.grantPermission('device:notifications', live.id);
  await PM.grantPermission('clipboard:read', live.id);
  await PM.grantPermission('sandbox:same-origin', live.id);
  const ctx = { app: live.app, webview: live.webview, sandbox: live.sandbox };

  // Session working normally…
  await call('nova:notifications:createChannel', { id: 'alerts', name: 'Alerts', importance: 'high' }, ctx);
  const pre = await call('nova:notifications:post', { channelId: 'alerts', title: 't', body: 'b' }, ctx);
  check('live session posts notifications', pre.result?.posted === true, code(pre));

  // …user revokes device:notifications in Settings mid-session.
  await PM.revokePermission('device:notifications', live.id);
  const postRevoke = await call('nova:notifications:post', { channelId: 'alerts', title: 't', body: 'b' }, ctx);
  check('post denied immediately after revocation', code(postRevoke) === 'PERMISSION_DENIED', code(postRevoke));
  const consumeRevoke = await call('nova:notifications:consumeActions', {}, ctx);
  check('action queue sealed after revocation', code(consumeRevoke) === 'PERMISSION_DENIED', code(consumeRevoke));
  check('channel creation denied too', code(await call('nova:notifications:createChannel', { id: 'x2', name: 'X', importance: 'low' }, ctx)) === 'PERMISSION_DENIED');
  check('unrelated grants untouched', PM.isGranted('clipboard:read', live.id) === true);

  // sandbox:same-origin revocation tears the live window down (the sandbox
  // capability can't stay attached to a running renderer).
  const closeCalls = [];
  const prevClose = global.WM.closeWindow;
  global.WM.closeWindow = (windowId) => { closeCalls.push(windowId); return true; };
  await PM.revokePermission('sandbox:same-origin', live.id);
  check('same-origin revocation closed the live window', closeCalls.includes(live.sandbox.windowId), JSON.stringify(closeCalls));
  global.WM.closeWindow = prevClose;

  // revokeAllPermissions — the Permissions app "Revoke all" button.
  await PM.grantPermission('clipboard:write', live.id);
  await PM.revokeAllPermissions(live.id);
  check('revoke-all wiped every grant', PM.getAppPermissions(live.id).length === 0);
  check('clipboard:read gone after revoke-all', PM.isGranted('clipboard:read', live.id) === false);
  check('rate-limit state wiped for the app', PM.isRateLimited('device:notifications', live.id).limited === false);

  PM.closeAllDialogs();
}

// ════════════════════════════════ R6 ════════════════════════════════════

async function r6() {
  section('[R6] gallery app: scoped media reads, metadata, fs:access, ownership');
  scenarioReset();

  // Shared tree: a gallery-style folder with mixed content.
  const fs = state.FS;
  const docs = await fs.createFolder(fs.rootId, 'Documents');
  const pics = await fs.createFolder(docs.id, 'Pictures');
  const img = await fs.createFile(pics.id, 'sunset.png', 'PNGDATA', 'image/png');
  const vid = await fs.createFile(pics.id, 'clip.mp4', 'MP4DATA', 'video/mp4');
  const note = await fs.createFile(docs.id, 'notes.txt', 'SECRET-NOTES', 'text/plain');

  const gallery = session(freshSessionId('com.gallery.app'));
  const victim = session(freshSessionId('com.victim.app'));
  fs.ensureAppDir(gallery.id); // the host lazily creates /data/<appId> on first use
  const victimDir = fs.ensureAppDir(victim.id);
  const victimSecret = await fs.createFile(victimDir.id, 'secret.txt', 'VICTIM-DATA', 'text/plain');

  const ctx = { app: gallery.app, webview: gallery.webview, sandbox: gallery.sandbox };

  // No grants at all: shared tree is invisible, own dir is not.
  const noGrantRead = await call('nova:fs:read', { path: '/Documents/Pictures/sunset.png' }, ctx);
  check('shared file unreadable without any grant', code(noGrantRead) === 'PERMISSION_DENIED', code(noGrantRead));
  const ownWrite = await call('nova:fs:write', { path: '/data/cache.txt', content: 'local' }, ctx);
  check('own /data write needs no grant', ownWrite.result?.success === true, code(ownWrite) || JSON.stringify(ownWrite.result));

  // Scoped media grant: images only.
  await PM.grantPermission('fs:read:images', gallery.id);
  global.window.NovaByteMediaStore = {
    query: ({ type }) => [img, vid]
      .filter(node => type === 'all' || type === (node.mimeType.startsWith('image/') ? 'image' : 'video'))
      .map(node => ({
        id: node.id,
        name: node.name,
        type: node.mimeType.startsWith('image/') ? 'image' : 'video',
        mimeType: node.mimeType,
        path: `media:${fs.getPath(node.id)}`,
      })),
  };
  const mediaQuery = await call('nova:media:query', { type: 'all' }, ctx);
  check(
    'MediaStore query returns only media metadata covered by the app grant',
    mediaQuery.result?.files?.map(file => file.name).join(',') === 'sunset.png',
    JSON.stringify(mediaQuery.result?.files)
  );
  const imgRead = await call('nova:fs:read', { path: '/Documents/Pictures/sunset.png' }, ctx);
  check('image readable with fs:read:images', imgRead.result?.success === true && imgRead.result?.data === 'PNGDATA', code(imgRead));
  const vidRead = await call('nova:fs:read', { path: '/Documents/Pictures/clip.mp4' }, ctx);
  check('video NOT readable on an images-only grant', code(vidRead) === 'PERMISSION_DENIED', code(vidRead));
  const noteRead = await call('nova:fs:read', { path: '/Documents/notes.txt' }, ctx);
  check('plain text NOT readable on a media grant', code(noteRead) === 'PERMISSION_DENIED', code(noteRead));
  const imgStat = await call('nova:fs:stat', { path: '/Documents/Pictures/sunset.png' }, ctx);
  check('metadata of a covered media type rides along', imgStat.result?.success === true, code(imgStat));
  const noteStat = await call('nova:fs:stat', { path: '/Documents/notes.txt' }, ctx);
  check('metadata of uncovered files still denied', code(noteStat) === 'PERMISSION_DENIED', code(noteStat));

  // Folder listing is filtered to what the app may see.
  const listPics = await call('nova:fs:read', { path: '/Documents/Pictures' }, ctx);
  const listedNames = (listPics.result?.children || []).map((f) => f.name).sort();
  check('listing shows only metadata-visible children', listedNames.join(',') === 'sunset.png', listedNames.join(','));
  delete global.window.NovaByteMediaStore;

  // Metadata grant widens stat/list but still not contents.
  await PM.grantPermission('fs:metadata', gallery.id);
  const noteStat2 = await call('nova:fs:stat', { path: '/Documents/notes.txt' }, ctx);
  check('fs:metadata unlocks stat of any shared file', noteStat2.result?.success === true, code(noteStat2));
  const noteRead2 = await call('nova:fs:read', { path: '/Documents/notes.txt' }, ctx);
  check('fs:metadata does NOT unlock contents', code(noteRead2) === 'PERMISSION_DENIED', code(noteRead2));
  const listDocs = await call('nova:fs:read', { path: '/Documents' }, ctx);
  check('listing now includes the text file', (listDocs.result?.children || []).some((f) => f.name === 'notes.txt'));

  // Mutating shared files without fs:access: needs user confirmation, and in
  // a headless host (no confirm()) fails closed with UNAVAILABLE — never a
  // silent write.
  const sharedWrite = await call('nova:fs:write', { path: '/Documents/notes.txt', content: 'EVIL' }, ctx);
  check('shared modify without fs:access is PERMISSION_DENIED', code(sharedWrite) === 'PERMISSION_DENIED', code(sharedWrite));
  const sharedDelete = await call('nova:fs:delete', { path: '/Documents/notes.txt' }, ctx);
  check('shared delete without fs:access fails closed', code(sharedDelete) === 'PERMISSION_DENIED' || code(sharedDelete) === 'UNAVAILABLE', code(sharedDelete));

  // A file picked through the dialog grants read access to exactly that
  // file — and even then, destructive ops still ask the user.
  gallery.sandbox.pickedFileIds = new Set([note.id]);
  const pickedRead = await call('nova:fs:read', { id: note.id }, ctx);
  check('user-picked file is readable', pickedRead.result?.data === 'SECRET-NOTES', code(pickedRead));
  const pickedDelete = await call('nova:fs:delete', { id: note.id }, ctx);
  check('picked file still needs confirmation to delete', code(pickedDelete) === 'UNAVAILABLE', code(pickedDelete));
  gallery.sandbox.pickedFileIds = new Set();

  // fs:access — the broad legacy grant — unlocks shared mutation directly.
  await PM.grantPermission('fs:access', gallery.id);
  const broadWrite = await call('nova:fs:write', { path: '/Documents/notes.txt', content: 'APPEND' }, ctx);
  check('fs:access allows shared writes without prompting', broadWrite.result?.success === true, code(broadWrite));
  const broadDelete = await call('nova:fs:delete', { path: '/Documents/notes.txt', permanent: true }, ctx);
  check('fs:access allows shared deletes', broadDelete.result?.success === true, code(broadDelete));
  check('file really gone from the shared tree', fs.getByPath('/Documents/notes.txt') === null);

  // fs:access is broad but NEVER crosses app-private boundaries.
  const byId = await call('nova:fs:read', { id: victimSecret.id }, ctx);
  check('another app’s private file not readable even by id with fs:access', code(byId) === 'NOT_FOUND' || code(byId) === 'PERMISSION_DENIED', code(byId));
  const byPath = await call('nova:fs:read', { path: `/data/${victim.id}/secret.txt` }, ctx);
  check('another app’s /data path is rewritten to the caller’s own dir', code(byPath) === 'NOT_FOUND', code(byPath));
  check('victim data intact', fs.files.get(victimSecret.id)?.content === 'VICTIM-DATA');

  // Path traversal in the shared tree stays inside the sandbox contract.
  const trav = await call('nova:fs:read', { path: '/../../etc/passwd' }, ctx);
  check('path traversal does not crash or leak', trav.error === undefined || trav.error.code === 'NOT_FOUND' || trav.error.code === 'PERMISSION_DENIED', code(trav));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R7 ════════════════════════════════════

async function r7() {
  section('[R7] two apps talking: register/invoke/reply/broadcast + abuse');
  scenarioReset();

  const A = session(freshSessionId('com.ipc.a'), {
    manifest: { ipc: { exports: ['service:echo'], receives: ['chat.message'] } },
  });
  const B = session(freshSessionId('com.ipc.b'), {
    manifest: { ipc: { exports: ['service:reverse'], receives: ['chat.message'] } },
  });
  await PM.grantPermission('apps:communicate', A.id);
  await PM.grantPermission('apps:communicate', B.id);

  const actx = { app: A.app, webview: A.webview, sandbox: A.sandbox };
  const bctx = { app: B.app, webview: B.webview, sandbox: B.sandbox };

  // Registration contract.
  const reg = await call('nova:ipc:register', { endpoint: 'service:echo' }, actx);
  check('register declared endpoint succeeds', reg.result?.success === true, code(reg));
  const regDup = await call('nova:ipc:register', { endpoint: 'service:echo' }, actx);
  check('duplicate register rejected', code(regDup) === 'ALREADY_REGISTERED', code(regDup));
  const regUndeclared = await call('nova:ipc:register', { endpoint: 'service:stealth' }, actx);
  check('registering an undeclared endpoint is PERMISSION_DENIED', code(regUndeclared) === 'PERMISSION_DENIED', code(regUndeclared));
  const regBad = await call('nova:ipc:register', { endpoint: 'evil:shell' }, actx);
  check('endpoint pattern enforced', code(regBad) === 'INVALID_ARGS', code(regBad));

  // Round trip: B invokes A; A replies; B gets the result. The callId is
  // carried on the request envelope as its requestId.
  const invokePromise = call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: { msg: 'hello' } }, bctx);
  await sleep(40);
  const req = A.webview.responses.find((m) => m.type === 'nova:ipc:request:response' || m.type?.startsWith('nova:ipc:request'));
  check('target sandbox received the request', !!req, JSON.stringify(A.webview.responses.map((m) => m.type)));
  const callId = req?.requestId;
  check('request carries the caller identity and payload', !!callId && req.result?.sourceAppId === B.id && req.result?.data?.msg === 'hello', JSON.stringify(req?.result || {}));
  const reply = await call('nova:ipc:reply', { callId, result: { echoed: 'hello' } }, actx);
  check('reply accepted from the target sandbox', reply.result?.success === true, code(reply));
  const invokeRes = await invokePromise;
  check('invoker received the round-trip result', invokeRes.result?.echoed === 'hello', JSON.stringify(invokeRes.result || invokeRes.error));

  // Manifest gate: B invoking an endpoint A doesn't export.
  const notFound = await call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:reverse', data: {} }, bctx);
  check('invoking an unexported endpoint is NOT_FOUND', code(notFound) === 'NOT_FOUND', code(notFound));

  // Target must also hold apps:communicate.
  const C = session(freshSessionId('com.ipc.c'), { manifest: { ipc: { exports: ['service:c'], receives: ['chat.message'] } } });
  const cctx = { app: C.app, webview: C.webview, sandbox: C.sandbox };
  const cDeniedReg = await call('nova:ipc:register', { endpoint: 'service:c' }, cctx);
  check('register without apps:communicate denied', code(cDeniedReg) === 'PERMISSION_DENIED', code(cDeniedReg));
  const uncommunicative = await call('nova:ipc:invoke', { targetAppId: C.id, endpoint: 'service:c', data: {} }, bctx);
  check('target without apps:communicate is rejected', code(uncommunicative) === 'PERMISSION_DENIED' || code(uncommunicative) === 'NOT_FOUND', code(uncommunicative));

  // Unregistered endpoint.
  await call('nova:ipc:unregister', { endpoint: 'service:echo' }, actx);
  const afterUnreg = await call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: {} }, bctx);
  check('unregistered endpoint no longer invocable', code(afterUnreg) === 'UNAVAILABLE', code(afterUnreg));
  await call('nova:ipc:register', { endpoint: 'service:echo' }, actx);

  // Payload discipline: oversize and non-serializable payloads rejected.
  // The default cap is the ledger budget ipcPayloadBytes (256 KB — see
  // StorageLedger.DEFAULT_BUDGETS in app-sandbox.js); 65 KB now forwards,
  // so the over-cap probe uses ~300 KB. The forwarded 65 KB request is fine
  // to leave pending — it times out host-side without affecting the spoof
  // checks below, which now match on payload, not on request order.
  const big = await call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: { blob: 'x'.repeat(300 * 1024) } }, bctx);
  check('256KB default payload cap enforced', code(big) === 'INVALID_ARGS', code(big));
  const cyclic = {};
  cyclic.self = cyclic;
  const cycRes = await call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: cyclic }, bctx);
  check('cyclic payload rejected cleanly', code(cycRes) === 'INVALID_ARGS', code(cycRes));

  // Spoof: another communicating app cannot answer calls addressed to a
  // different sandbox.
  await PM.grantPermission('apps:communicate', C.id);
  const spoofInvoke = call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: { msg: 'spoof-me' } }, bctx);
  await sleep(40);
  // Match the spoof request by its payload: A's response buffer may hold
  // earlier forwarded requests (e.g. a big-but-allowed payload still pending
  // its timeout), and only THIS callId must be probed.
  const spoofReq = [...A.webview.responses].reverse().find((m) => m.type?.startsWith('nova:ipc:request') && m.result?.data?.msg === 'spoof-me');
  const spoofCallId = spoofReq?.requestId;
  const spoofReply = await call('nova:ipc:reply', { callId: spoofCallId, result: { hacked: true } }, cctx);
  check('foreign sandbox cannot resolve a pending call', code(spoofReply) === 'NOT_FOUND', code(spoofReply));
  const realReply = await call('nova:ipc:reply', { callId: spoofCallId, result: { echoed: 'spoof-me' } }, actx);
  check('the real target still resolves it', realReply.result?.success === true, code(realReply));
  const spoofOutcome = await spoofInvoke;
  check('spoofed answer never reached the invoker', spoofOutcome.result?.echoed === 'spoof-me' && spoofOutcome.result?.hacked === undefined, JSON.stringify(spoofOutcome.result || spoofOutcome.error));

  // Rate limit: 20 invokes/min per app, enforced BEFORE endpoint resolution
  // (so a burst against a bogus endpoint still trips it without leaving 20
  // pending calls hanging on a live target).
  let limited = null;
  for (let i = 0; i < 25; i++) {
    limited = await call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:not-exported', data: { n: i } }, bctx);
    if (code(limited) === 'RATE_LIMITED') break;
  }
  check('21st invoke inside a minute is RATE_LIMITED', code(limited) === 'RATE_LIMITED', code(limited));

  // Broadcast pub/sub.
  const sub = await call('nova:ipc:broadcast:subscribe', { action: 'chat.message' }, actx);
  check('subscribe to declared action succeeds', sub.result?.success === true, code(sub));
  const subUndeclared = await call('nova:ipc:broadcast:subscribe', { action: 'chat.other' }, cctx);
  check('subscribe to undeclared action is PERMISSION_DENIED', code(subUndeclared) === 'PERMISSION_DENIED', code(subUndeclared));
  A.webview.responses.length = 0;
  const bcast = await call('nova:ipc:broadcast', { action: 'chat.message', data: { from: 'B' } }, bctx);
  check('broadcast reports delivery count', bcast.result?.delivered >= 1, JSON.stringify(bcast.result));
  const received = A.webview.responses.find((m) => m.type?.startsWith('nova:ipc:broadcast'));
  check('subscriber received the broadcast with source identity', !!received && received.result?.sourceAppId === B.id && received.result?.data?.from === 'B', JSON.stringify(received?.result));
  await call('nova:ipc:broadcast:unsubscribe', { action: 'chat.message' }, actx);
  A.webview.responses.length = 0;
  const bcast2 = await call('nova:ipc:broadcast', { action: 'chat.message', data: { from: 'B' } }, bctx);
  check('unsubscribed sandbox no longer receives', bcast2.result?.delivered === 0 && A.webview.responses.length === 0, JSON.stringify(bcast2.result));
  const noGrantBcast = await call('nova:ipc:broadcast', { action: 'chat.message', data: {} },
    (() => { const D = session(freshSessionId('com.ipc.d'), { manifest: { ipc: { receives: ['chat.message'] } } }); return { app: D.app, webview: D.webview, sandbox: D.sandbox }; })());
  check('broadcast without apps:communicate is PERMISSION_DENIED', code(noGrantBcast) === 'PERMISSION_DENIED', code(noGrantBcast));

  // Defense in depth: a mid-call revocation of the TARGET strips its ability
  // to complete the pending call.
  await PM.grantPermission('apps:communicate', A.id);
  const midInvoke = call('nova:ipc:invoke', { targetAppId: A.id, endpoint: 'service:echo', data: { msg: 'race' } }, bctx);
  await sleep(40);
  const midReq = A.webview.responses.find((m) => m.type?.startsWith('nova:ipc:request'));
  await PM.revokePermission('apps:communicate', A.id);
  const strippedReply = await call('nova:ipc:reply', { callId: midReq?.requestId, result: { late: true } }, actx);
  check('stripped target cannot resolve pending calls', code(strippedReply) === 'PERMISSION_DENIED', code(strippedReply));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R8 ════════════════════════════════════

async function r8() {
  section('[R8] network: internal/external classification + websocket lifecycle');
  scenarioReset();

  const surfer = session(freshSessionId('com.surfer.app'));
  const ctx = { app: surfer.app, webview: surfer.webview, sandbox: surfer.sandbox };

  // External only.
  await PM.grantPermission('net:external', surfer.id);
  const ext = await call('nova:net:fetch', { url: 'https://ok.example.com/feed' }, ctx);
  check('external fetch with net:external succeeds', ext.result != null && !ext.error, code(ext));
  const internalDenied = await call('nova:net:fetch', { url: 'http://127.0.0.1:3003/api/data' }, ctx);
  check('internal URL requires net:internal even with net:external', code(internalDenied) === 'PERMISSION_DENIED', code(internalDenied));

  // Internal grant opens host-service URLs (proxied through the local service).
  await PM.grantPermission('net:internal', surfer.id);
  const internal = await call('nova:net:fetch', { url: 'http://127.0.0.1:3003/api/data' }, ctx);
  check('internal fetch with net:internal succeeds', internal.result != null && !internal.error, code(internal));

  // Dangerous schemes never resolve into a fetch.
  for (const url of ['file:///etc/passwd', 'ftp://host/x', '//protocol-relative.example/x']) {
    const r = await call('nova:net:fetch', { url }, ctx);
    check(`disallowed URL rejected: ${url}`, code(r) === 'INVALID_ARGS' || code(r) === 'PERMISSION_DENIED', code(r));
  }

  // WebSocket lifecycle against the stub: open → send → close.
  const deniedWs = await call('nova:net:websocket', { url: 'wss://ok.example.com/rt' }, { ...ctx });
  check('websocket without net:websocket is PERMISSION_DENIED', code(deniedWs) === 'PERMISSION_DENIED', code(deniedWs));
  await PM.grantPermission('net:websocket', surfer.id);
  const ws = await call('nova:net:websocket', { url: 'wss://ok.example.com/rt' }, ctx);
  check('websocket opens with net:websocket', ws.result?.success === true && !!ws.result?.wsId, JSON.stringify(ws.result) || code(ws));
  const wsId = ws.result?.wsId;
  check('connection tracked on the sandbox', surfer.sandbox.wsConnections.has(wsId));
  const send = await call('nova:net:ws:send', { wsId, data: 'ping' }, ctx);
  check('ws:send accepted', send.result?.success === true, code(send));
  const conn = surfer.sandbox.wsConnections.get(wsId)?.ws;
  check('payload reached the socket', conn && conn.sent.includes('ping'), JSON.stringify(conn?.sent));
  // Closing fires an async onclose event back to the same webview, so the
  // success response races the close event — assert on the socket state
  // instead, which is the thing that matters.
  const close = await call('nova:net:ws:close', { wsId }, ctx);
  await sleep(30);
  check('ws:close accepted', close.error === undefined || code(close) === 'DOUBLE_RESPONSE', JSON.stringify(close.error));
  check('socket deregistered after close', !surfer.sandbox.wsConnections.has(wsId));
  check('socket actually closed', conn.readyState === 3);

  // Raw-channel receive: the host mirrors socket pushes onto the event bus
  // (net:websocket-gated, same-app filtered), so the raw channels form a
  // complete standalone API — subscribe, then hear your own sockets only.
  const rawSub = await call('nova:events:subscribe', { event: 'nova:net:ws:message' }, ctx);
  check('raw ws push event subscribable with net:websocket', rawSub.result?.success === true, code(rawSub));
  const ws2 = await call('nova:net:websocket', { url: 'wss://ok.example.com/rt2' }, ctx);
  check('second raw socket opens', ws2.result?.success === true && !!ws2.result?.wsId, code(ws2));
  const wsId2 = ws2.result.wsId;
  const conn2 = surfer.sandbox.wsConnections.get(wsId2)?.ws;
  surfer.webview.responses.length = 0;
  conn2.onmessage({ data: 'mirror-me' });
  await sleep(15);
  const mirrored = surfer.webview.responses.find((m) => m.type === 'nova:events:event:response' && m.result?.event === 'nova:net:ws:message');
  check('socket push mirrored to the events subscriber',
    !!mirrored && mirrored.result.data?.wsId === wsId2 && mirrored.result.data?.data === 'mirror-me', JSON.stringify(mirrored?.result));
  const directWsPush = surfer.webview.responses.find((m) => m.type === 'nova:net:ws:message:response');
  check('per-wsId direct push still flows alongside', !!directWsPush && directWsPush.result.data === 'mirror-me', JSON.stringify(directWsPush?.result));

  // Cross-app: a second app subscribed to the same bus name hears nothing —
  // the payload carries the owning appId and delivery filters on it.
  const eavesdropper = session(freshSessionId('com.eaves.app'));
  await PM.grantPermission('net:websocket', eavesdropper.id);
  const eavesSub = await call('nova:events:subscribe', { event: 'nova:net:ws:message' },
    { app: eavesdropper.app, webview: eavesdropper.webview, sandbox: eavesdropper.sandbox });
  check('eavesdropper subscribes with its own net:websocket', eavesSub.result?.success === true, code(eavesSub));
  eavesdropper.webview.responses.length = 0;
  surfer.webview.responses.length = 0;
  conn2.onmessage({ data: 'private' });
  await sleep(15);
  check("foreign app does not receive another app's socket pushes",
    !eavesdropper.webview.responses.some((m) => m.type === 'nova:events:event:response'),
    JSON.stringify(eavesdropper.webview.responses.map((m) => m.type)));
  check('owner still receives its own mirrored push',
    surfer.webview.responses.some((m) => m.type === 'nova:events:event:response' && m.result?.data?.data === 'private'));

  await call('nova:net:ws:close', { wsId: wsId2 }, ctx);
  await sleep(30);
  check('second socket deregistered after close', !surfer.sandbox.wsConnections.has(wsId2));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R9 ════════════════════════════════════

async function r9() {
  section('[R9] settings/wallpaper/appearance + event domains');
  scenarioReset();

  const app = session(freshSessionId('com.tweaker.app'));
  const ctx = { app: app.app, webview: app.webview, sandbox: app.sandbox };

  // system:info gates both nova:system:info and settings:get.
  const noInfo = await call('nova:system:info', {}, ctx);
  check('system:info without grant denied', code(noInfo) === 'PERMISSION_DENIED', code(noInfo));
  await PM.grantPermission('system:info', app.id);
  const info = await call('nova:system:info', {}, ctx);
  check('system:info returns OS identity', info.result?.success === true && !!info.result?.os?.version, JSON.stringify(info.result)?.slice(0, 80));
  check('system:info does not leak beyond its shape', info.result?.os?.username === 'nova' && info.result?.os?.version === '3.0.2', JSON.stringify(info.result?.os));
  const getTheme = await call('nova:settings:get', { key: 'username' }, ctx);
  check('settings:get allowlisted key works with system:info', getTheme.result?.value === 'nova', code(getTheme));
  const getSecret = await call('nova:settings:get', { key: 'wifiPassword' }, ctx);
  check('settings:get non-allowlisted key denied', code(getSecret) === 'PERMISSION_DENIED', code(getSecret));

  await PM.grantPermission('system:settings', app.id);
  const setTheme = await call('nova:settings:set', { key: 'theme', value: 'nord' }, ctx);
  check('settings:set writable key works', setTheme.result?.success === true, code(setTheme));
  check('setting actually applied', OS.settings.get('theme') === 'nord');
  const setDev = await call('nova:settings:set', { key: 'rootAccessEnabled', value: true }, ctx);
  check('apps cannot self-enable root mode', code(setDev) === 'PERMISSION_DENIED' || OS.settings.get('rootAccessEnabled') !== true, code(setDev) || 'rootAccessEnabled set!');

  const wp = await call('nova:wallpaper:set', { key: 'wallpaperId', value: 'wp-nova-1' }, ctx);
  check('wallpaper:set accepted (ungated by design)', wp.result?.success === true, code(wp));
  const wpEvil = await call('nova:wallpaper:set', { key: 'localStorage', value: '{}' }, ctx);
  check('wallpaper:set key allowlist enforced', code(wpEvil) === 'INVALID_ARGS', code(wpEvil));

  // Appearance subscription — real event bus, filtered to public keys.
  OS.settings.set('theme', 'nord');
  const sub = await call('nova:appearance:subscribe', {}, ctx);
  check('appearance subscribe succeeds', sub.result?.success === true && sub.result?.appearance?.theme === 'nord', JSON.stringify(sub.result));
  app.webview.responses.length = 0;
  OS.events.emit('settings:changed', { key: 'theme' });
  await sleep(15);
  const appearanceEvent = app.webview.responses.find((m) => m.type?.startsWith('nova:appearance:changed'));
  check('public appearance change delivered', !!appearanceEvent && appearanceEvent.result?.theme === 'nord', JSON.stringify(appearanceEvent?.result));
  app.webview.responses.length = 0;
  OS.events.emit('settings:changed', { key: 'wifiPassword' });
  await sleep(15);
  check('sensitive settings change NOT delivered', app.webview.responses.length === 0);
  const dupSub = await call('nova:appearance:subscribe', {}, ctx);
  check('double subscribe rejected', code(dupSub) === 'ALREADY_SUBSCRIBED', code(dupSub));
  await call('nova:appearance:unsubscribe', {}, ctx);
  app.webview.responses.length = 0;
  OS.events.emit('settings:changed', { key: 'theme' });
  await sleep(15);
  check('unsubscribed app gets no more appearance events', app.webview.responses.length === 0);

  // Events: public names need no grant, sensitive need system:events,
  // domain events need the domain permission on top.
  const pub = await call('nova:events:subscribe', { event: 'system:volumeChanged' }, ctx);
  check('public event subscribable without grants', pub.result?.success === true, code(pub));
  app.webview.responses.length = 0;
  OS.events.emit('system:volumeChanged', { level: 42 });
  await sleep(15);
  check('public event delivered', app.webview.responses.some((m) => m.type?.startsWith('nova:events:event')));

  const sensitiveNoGrant = await call('nova:events:subscribe', { event: 'app:launched' }, ctx);
  check('sensitive event without system:events denied', code(sensitiveNoGrant) === 'PERMISSION_DENIED', code(sensitiveNoGrant));
  await PM.grantPermission('system:events', app.id);
  const sensitive = await call('nova:events:subscribe', { event: 'app:launched' }, ctx);
  check('sensitive event subscribable with system:events', sensitive.result?.success === true, code(sensitive));

  const domain = await call('nova:events:subscribe', { event: 'mail:new' }, ctx);
  check('domain event without mail:read denied', code(domain) === 'PERMISSION_DENIED', code(domain));
  await PM.grantPermission('mail:read', app.id);
  const domain2 = await call('nova:events:subscribe', { event: 'mail:new' }, ctx);
  check('domain event with mail:read subscribable', domain2.result?.success === true, code(domain2));

  const notAllowed = await call('nova:events:subscribe', { event: 'settings:changed' }, ctx);
  check('internal channels not subscribable', code(notAllowed) === 'INVALID_ARGS', code(notAllowed));
  const dupEvent = await call('nova:events:subscribe', { event: 'system:volumeChanged' }, ctx);
  check('duplicate subscription rejected', code(dupEvent) === 'ALREADY_SUBSCRIBED', code(dupEvent));

  await call('nova:events:unsubscribe', { event: 'system:volumeChanged' }, ctx);
  app.webview.responses.length = 0;
  OS.events.emit('system:volumeChanged', { level: 10 });
  await sleep(15);
  check('events:unsubscribe stops delivery', app.webview.responses.length === 0);

  PM.closeAllDialogs();
}

// ════════════════════════════════ R10 ═══════════════════════════════════

async function r10() {
  section('[R10] permission lifecycle: expiry, recordAppUse, auto-grant, root');
  scenarioReset();

  const app = session(freshSessionId('com.lifecycle.app'));

  // Session-scoped (permanent:false) grant gets a ~24h expiry.
  const temp = await requestPermissionViaBridge(app.id, 'clipboard:write', { permanent: false });
  await clickAllow(temp.overlay);
  await temp.promise;
  const tempGrant = PM.getAppPermissions(app.id).find((g) => g.permission === 'clipboard:write');
  check('temporary grant carries an expiresAt', !!tempGrant?.expiresAt, JSON.stringify(tempGrant));
  const hours = tempGrant ? (Date.parse(tempGrant.expiresAt) - Date.now()) / 3600000 : 0;
  check('expiry ≈ 24h out', hours > 23 && hours < 25, `${hours.toFixed(2)}h`);

  // A day passes → the grant is dead on first check, and the dead record is
  // pruned, not just reported.
  const stored = JSON.parse(state.ls.get('nova_app_permissions') || '[]');
  const rec = stored.find((g) => g.appId === app.id && g.permission === 'clipboard:write');
  rec.expiresAt = new Date(Date.now() - 1000).toISOString();
  state.ls.set('nova_app_permissions', JSON.stringify(stored));
  PM.initialize();
  check('expired grant is no longer granted', PM.isGranted('clipboard:write', app.id) === false);
  check('expired grant pruned from storage', !JSON.parse(state.ls.get('nova_app_permissions')).some((g) => g.appId === app.id && g.permission === 'clipboard:write'));

  // recordAppUse resets the 30-day sweep clock for the app's grants.
  await PM.grantPermission('device:notifications', app.id);
  const before = PM.getAppPermissions(app.id).find((g) => g.permission === 'device:notifications')?.lastUsed;
  await sleep(10);
  await PM.recordAppUse(app.id);
  const after = PM.getAppPermissions(app.id).find((g) => g.permission === 'device:notifications')?.lastUsed;
  check('recordAppUse refreshed lastUsed', after !== before, `${before} → ${after}`);

  // Low-risk auto-grant policy (install-time): low risk granted, high risk
  // never, and a prior user denial always wins.
  check('low-risk auto-grant grants net:external', await PM.autoGrantLowRisk('net:external', app.id) === true && PM.isGranted('net:external', app.id));
  check('auto-grant refuses high-risk permissions', await PM.autoGrantLowRisk('device:camera', app.id) === false && !PM.isGranted('device:camera', app.id));
  await PM.revokePermission('clipboard:write', app.id);
  check('auto-grant respects a prior denial', await PM.autoGrantLowRisk('clipboard:write', app.id) === false);

  // Corrupted grant storage recovers instead of poisoning the session.
  state.ls.set('nova_app_permissions', '{definitely not json');
  PM.initialize();
  check('corrupted grant store recovers without throwing', typeof PM.isGranted('net:external', app.id) === 'boolean');

  // Malformed entries are dropped, valid ones survive.
  const junk = [
    { appId: app.id, permission: 'clipboard:read', granted: 'yes' },           // bad granted
    { appId: app.id, permission: 'contacts:read', grantedAt: 'not-a-date', granted: true }, // bad date
    { appId: app.id, permission: 'system:apps', granted: true, grantedAt: new Date().toISOString() }, // valid
  ];
  state.ls.set('nova_app_permissions', JSON.stringify(junk));
  PM.initialize();
  check('valid grant survives re-init', PM.isGranted('system:apps', app.id) === true);
  check('malformed grants rejected', PM.isGranted('clipboard:read', app.id) === false && PM.isGranted('contacts:read', app.id) === false);

  // Root: off by default, never grantable through the generic API, and the
  // real prompt makes the user acknowledge the risk explicitly.
  check('root not granted without dev mode', PM.isGranted('system:root', app.id) === false);
  let rootThrow = null;
  try { await PM.grantPermission('system:root', app.id); } catch (e) { rootThrow = e; }
  check('grantPermission refuses system:root', !!rootThrow, rootThrow?.message);

  const rootRequest = await requestPermissionViaBridge(app.id, 'system:root');
  check('root request without dev mode short-circuits (no dialog)', !rootRequest.overlay);
  const rootDenied = await rootRequest.promise;
  check('root request denied while dev mode off', rootDenied.result?.granted === false, code(rootDenied));

  OS.settings.set('devMode', true);
  OS.settings.set('rootAccessEnabled', true);
  const rootRequest2 = await requestPermissionViaBridge(app.id, 'system:root');
  check('root dialog appears with dev mode on', !!rootRequest2.overlay);
  const grantBtn = findInTree(rootRequest2.overlay, (n) => isButtonWithText(n, 'Grant Root Access'));
  check('root Allow disabled until acknowledgement', grantBtn?.disabled === true);
  await tickRootCheckbox(rootRequest2.overlay);
  check('checkbox enables the Allow button', grantBtn?.disabled === false);
  await clickAllow(rootRequest2.overlay);
  const rootRes = await rootRequest2.promise;
  check('root granted after explicit acknowledgement', rootRes.result?.granted === true, code(rootRes));
  check('root grant active', PM.isGranted('system:root', app.id) === true);

  await PM.revokePermission('system:root', app.id);
  check('root revocation sticks', PM.isGranted('system:root', app.id) === false);

  PM.closeAllDialogs();
}

// ════════════════════════════════ R11 ═══════════════════════════════════

async function r11() {
  section('[R11] install/uninstall via IPC: the cleanup contract');
  scenarioReset();

  const store = session(freshSessionId('com.store.app'), { name: 'Test Store' });
  await PM.grantPermission('system:apps', store.id);
  const sctx = { app: store.app, webview: store.webview, sandbox: store.sandbox };

  // Fake signing stack so the full install ladder runs.
  global.AppPackage = {
    verifyIntegrity: async () => true,
    verifyAgainstTrustStore: async (pkg, list) => (pkg.manifest?.id === 'com.bad.actor'
      ? { trusted: false, signer: null } : { trusted: true, signer: 'NovaByte Test' }),
  };
  global.TrustStore = { list: () => [], isRevoked: () => false };
  // The real AppRegistry.registerApp keeps APP_REGISTRY (the array the
  // uninstall handler scans) and OS.apps in sync — mirror that here.
  state.AppRegistry.registerApp = (data) => {
    const app = makeApp(data.id, { name: data.name, manifest: data.manifest, ...data });
    state.AppRegistry._apps.set(data.id, app);
    if (!global.APP_REGISTRY.some((a) => a.id === data.id)) global.APP_REGISTRY.push(app);
    global.OS.apps[data.id] = app;
    return app;
  };
  state.AppRegistry.uninstallApp = async (id) => {
    state.AppRegistry._apps.delete(id);
    const i = global.APP_REGISTRY.findIndex((a) => a.id === id);
    if (i > -1) global.APP_REGISTRY.splice(i, 1);
    return true;
  };

  const pkg = (id, name) => ({
    manifest: {
      id, name, version: '1.0.0',
      permissions: ['device:notifications', 'clipboard:read'],
      notifications: { channels: [{ id: 'news', name: 'News', importance: 'default' }] },
    },
    files: { 'index.html': 'PGh0bWw+' },
    integrity: { algorithm: 'sha256' },
    signature: { keyId: 'test' },
  });

  // Gate ladder first.
  const noPkg = await call('nova:app:install', {}, sctx);
  check('install without package rejected', code(noPkg) === 'INVALID_ARGS', code(noPkg));
  const badPkg = await call('nova:app:install', { package: { manifest: { id: 'x' } } }, sctx);
  check('install missing manifest fields rejected', code(badPkg) === 'INVALID_PACKAGE', code(badPkg));
  const noIntegrity = await call('nova:app:install', { package: { manifest: { id: 'com.fresh.game', name: 'Game', version: '1' } } }, sctx);
  check('unsigned/unverified package refused', code(noIntegrity) === 'UNVERIFIED', code(noIntegrity));
  const untrusted = await call('nova:app:install', { package: pkg('com.bad.actor', 'Bad Actor') }, sctx);
  check('untrusted signer refused', code(untrusted) === 'UNTRUSTED', code(untrusted));

  // Happy path.
  const target = 'com.fresh.game';
  const installed = await call('nova:app:install', { package: pkg(target, 'Fresh Game') }, sctx);
  check('signed trusted package installs', installed.result?.success === true && installed.result?.id === target, code(installed) || JSON.stringify(installed.result));
  check('registered in the app registry', state.AppRegistry.getApp(target)?.id === target);
  const dupInstall = await call('nova:app:install', { package: pkg(target, 'Fresh Game') }, sctx);
  check('duplicate install refused', code(dupInstall) === 'ALREADY_INSTALLED', code(dupInstall));

  // The new app lives a little: first-run prompts, storage, channels.
  const targetApp = state.AppRegistry.getApp(target);
  const twebview = makeWebview(target);
  const tsandbox = makeSandbox(target, { webview: twebview });
  registerActive(tsandbox);
  const tctx = { app: targetApp, webview: twebview, sandbox: tsandbox };
  const p1 = await requestPermissionViaBridge(target, 'device:notifications');
  await clickAllow(p1.overlay);
  await p1.promise;
  const p2 = await requestPermissionViaBridge(target, 'clipboard:read');
  await clickDeny(p2.overlay);
  await p2.promise;
  await call('nova:notifications:createChannel', { id: 'news', name: 'News', importance: 'default' }, tctx);
  await call('nova:storage:set', { key: 'progress', value: 'level-9' }, tctx);
  await call('nova:storage:set', { key: 'skins', value: ['gold', 'neon'] }, tctx);
  check('target has grants before uninstall', PM.getAppPermissions(target).length === 2, JSON.stringify(PM.getAppPermissions(target).map((g) => g.permission)));
  check('target has channels before uninstall', Notify.listChannels(target).length === 1);
  const keysPre = await call('nova:storage:keys', {}, tctx);
  check('target has storage before uninstall', (keysPre.result?.keys || []).length === 2, JSON.stringify(keysPre.result));
  check('manifest channel seeded for the target', Notify.getChannel(target, 'news') != null);

  // Uninstall from the store app.
  const unInst = await call('nova:app:uninstall', { appId: target }, sctx);
  check('uninstall succeeds', unInst.result?.success === true, code(unInst) || JSON.stringify(unInst.result));
  check('registry entry removed', state.AppRegistry.getApp(target) === null && !global.APP_REGISTRY.some((a) => a.id === target));

  // ── cleanup contract (Android parity) ──
  // 1. Permissions are reset on uninstall: a reinstall must start from a
  //    clean slate, not silently inherit the previous install's grants.
  const permsAfter = PM.getAppPermissions(target);
  check('BUG probe — permissions reset on uninstall', permsAfter.length === 0, `left: ${JSON.stringify(permsAfter.map((g) => `${g.permission}:${g.granted}`))}`);
  // 2. nova:storage key-value data dies with the app (every manual uninstall
  //    path wipes it; the IPC path must too).
  const keysPost = await call('nova:storage:keys', {}, tctx);
  check('BUG probe — nova:storage wiped on uninstall', (keysPost.result?.keys || []).length === 0, `left: ${JSON.stringify(keysPost.result?.keys)}`);
  // 3. Channels + overrides + queued actions die with the app.
  check('notification channels removed on uninstall', Notify.listChannels(target).length === 0 && Notify.getChannel(target, 'news') === null);

  // Edge guards.
  const selfUninstall = await call('nova:app:uninstall', { appId: store.id }, sctx);
  check('app cannot uninstall itself', code(selfUninstall) === 'INVALID_ARGS', code(selfUninstall));
  const missing = await call('nova:app:uninstall', {}, sctx);
  check('uninstall requires appId', code(missing) === 'INVALID_ARGS', code(missing));
  const ghost = await call('nova:app:uninstall', { appId: 'com.ghost.app' }, sctx);
  check('uninstalling unknown app is NOT_FOUND', code(ghost) === 'NOT_FOUND', code(ghost));
  const builtin = session('com.builtin.sysapp', { name: 'Built-in' });
  global.APP_REGISTRY.push({ id: builtin.id, name: builtin.id, source: 'builtin' });
  const builtinRes = await call('nova:app:uninstall', { appId: builtin.id }, sctx);
  check('built-in app not uninstallable', code(builtinRes) === 'NOT_UNINSTALLABLE', code(builtinRes));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R12 ═══════════════════════════════════

async function r12() {
  section('[R12] multi-app concurrency: budgets, isolation, unicode');
  scenarioReset();

  const a = session(freshSessionId('com.multi.a'));
  const b = session(freshSessionId('com.multi.b'));
  const c = session(freshSessionId('com.multi.c'));
  const ctxOf = (s) => ({ app: s.app, webview: s.webview, sandbox: s.sandbox });
  for (const s of [a, b, c]) {
    await PM.grantPermission('device:notifications', s.id);
    // v2 posts require an existing channel — each app creates its own.
    await call('nova:notifications:createChannel', { id: 'general', name: 'General', importance: 'default' }, ctxOf(s));
  }

  // Concurrent posts across three apps — each app has its own budget.
  const results = await Promise.all([
    Promise.all(Array.from({ length: 8 }, (_, i) => call('nova:notifications:post', { channelId: 'general', title: `A${i}`, body: 'x' }, ctxOf(a)))),
    Promise.all(Array.from({ length: 8 }, (_, i) => call('nova:notifications:post', { channelId: 'general', title: `B${i}`, body: 'x' }, ctxOf(b)))),
    Promise.all(Array.from({ length: 8 }, (_, i) => call('nova:notifications:post', { channelId: 'general', title: `C${i}`, body: 'x' }, ctxOf(c)))),
  ]);
  const allPosted = results.every((set) => set.every((r) => r.result?.posted === true));
  check('3 apps × 8 concurrent posts all land (independent budgets)', allPosted,
    JSON.stringify(results.map((set) => set.map((r) => code(r)))));
  check('panel holds all 24', OS.notifications.filter((n) => n.appId?.startsWith('com.multi.')).length === 24);

  // One app exhausting its budget never throttles the others.
  let aLimited = null;
  for (let i = 0; i < 12; i++) {
    aLimited = await call('nova:notifications:post', { channelId: 'general', title: `flood${i}`, body: 'x' }, ctxOf(a));
    if (code(aLimited)) break;
  }
  check('app A exhausts its own budget', code(aLimited) === 'RATE_LIMITED', code(aLimited));
  const bStill = await call('nova:notifications:post', { channelId: 'general', title: 'B-after', body: 'x' }, ctxOf(b));
  check('app B unaffected by A’s exhausted budget', bStill.result?.posted === true, code(bStill));

  // Storage isolation + concurrency: same key names, different apps.
  const sctxA = ctxOf(a);
  const sctxB = ctxOf(b);
  await Promise.all(Array.from({ length: 50 }, (_, i) => call('nova:storage:set', { key: `row-${i}`, value: `A${i}` }, sctxA)));
  await Promise.all(Array.from({ length: 50 }, (_, i) => call('nova:storage:set', { key: `row-${i}`, value: `B${i}` }, sctxB)));
  const aRow = await call('nova:storage:get', { key: 'row-7' }, sctxA);
  const bRow = await call('nova:storage:get', { key: 'row-7' }, sctxB);
  check('same key names stay isolated per app', aRow.result?.value === 'A7' && bRow.result?.value === 'B7', `${aRow.result?.value} vs ${bRow.result?.value}`);

  // Value cap and unicode round-trips.
  const huge = await call('nova:storage:set', { key: 'huge', value: 'x'.repeat(5 * 1024 * 1024 + 1) }, sctxA);
  check('5MB value cap enforced', !!huge.error, code(huge));
  const unicode = { emoji: '🚀📧🎉', rtl: 'مرحبا بالعالم', cjk: '绕过审核的邮件', mixed: 'naïve-日本語- Vulcan: 🖖' };
  await call('nova:storage:set', { key: 'unicode', value: unicode }, sctxA);
  const uniBack = await call('nova:storage:get', { key: 'unicode' }, sctxA);
  check('unicode object round-trips through storage', JSON.stringify(uniBack.result?.value) === JSON.stringify(unicode), JSON.stringify(uniBack.result?.value)?.slice(0, 60));
  const uniNotif = await call('nova:notifications:post', { channelId: 'general', title: unicode.emoji, text: unicode.rtl }, ctxOf(c));
  check('unicode reaches the notification panel', uniNotif.result?.posted === true && OS.notifications[0].title === unicode.emoji, JSON.stringify(OS.notifications[0]?.title));

  // Clipboard is the shared ambient channel: B writes, A reads.
  await PM.grantPermission('clipboard:write', b.id);
  await PM.grantPermission('clipboard:read', a.id);
  const wrote = await call('nova:clipboard:write', { text: 'copied-🔐-secret' }, ctxOf(b));
  check('clipboard write succeeds', wrote.result?.success === true, code(wrote));
  const read = await call('nova:clipboard:read', {}, sctxA);
  check('clipboard read sees the other app’s write', read.result?.text === 'copied-🔐-secret', JSON.stringify(read.result));

  // History cap at 30.
  for (let i = 0; i < 35; i++) await call('nova:clipboard:write', { text: `h${i}` }, ctxOf(b));
  check('clipboard history capped at 30', (OS.clipboardHistory || []).length <= 30, String((OS.clipboardHistory || []).length));

  PM.closeAllDialogs();
}

// ════════════════════════════════ R13 ═══════════════════════════════════

async function r13() {
  section('[R13] push delivery: the whole ladder over a chat app lifetime');
  scenarioReset();

  const appId = freshSessionId('com.push.chat');
  const chat = session(appId, { permissions: ['push:receive'] });
  // Manifest declaration ≠ grant — mirror the user answering the prompt.
  await PM.grantPermission('push:receive', appId, { source: 'test' });
  const ctx = { app: chat.app, webview: chat.webview, sandbox: chat.sandbox };
  const pushState = () => JSON.parse(state.ls.get('nova_app_push') || '{"tokens":{},"queue":{}}');
  const queueLen = () => (pushState().queue[appId] || []).length;
  const pushesTo = (wv) => wv.responses.filter((r) => r.type === 'nova:push:message:response');

  // The SSE transport would open against the stub server here; the ladder
  // below is what a transport frame feeds, so it's driven directly — the
  // vitest server suite covers the wire protocol end-to-end.
  const fetchLenBefore = fetchCalls.length;

  // 1) Register: a stable shaped token + publish endpoint, first-grant flow.
  const reg = await call('nova:push:register', {}, ctx);
  check('register succeeds on a granted app', reg.result?.success === true, code(reg));
  check('token has the publish shape', /^nps_[0-9a-f]{32}$/.test(reg.result?.token || ''), JSON.stringify(reg.result));
  check('endpoint names the publish route', typeof reg.result?.endpoint === 'string' && reg.result.endpoint.endsWith('/api/push/publish'), JSON.stringify(reg.result?.endpoint));
  const token = reg.result?.token;
  const subscribeCall = fetchCalls.slice(fetchLenBefore).find((call) => call.url === '/api/push/subscribe');
  let subscriptionBody = null;
  try { subscriptionBody = JSON.parse(subscribeCall?.opts?.body || 'null'); } catch (_) { /* checked below */ }
  check('register subscribes its token without waiting for the SSE stream', reg.result?.subscribed === true
    && subscriptionBody?.subscriptions?.some((entry) => entry.token === token && entry.appId === appId), JSON.stringify({ result: reg.result, subscriptionBody }));
  const regAgain = await call('nova:push:register', {}, ctx);
  check('re-register keeps the same token', regAgain.result?.token === token, JSON.stringify(regAgain.result));
  check('re-register confirms the server subscription', regAgain.result?.subscribed === true, JSON.stringify(regAgain.result));
  const originalFetch = global.fetch;
  global.fetch = (url, options) => String(url) === '/api/push/subscribe'
    ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
    : originalFetch(url, options);
  let unavailable;
  try { unavailable = await call('nova:push:register', {}, ctx); }
  finally { global.fetch = originalFetch; }
  check('register reports an unconfirmed subscription instead of masking server failure', unavailable.result?.subscribed === false, JSON.stringify(unavailable.result));
  const retry = await call('nova:push:register', {}, ctx);
  check('register can retry the server subscription', retry.result?.subscribed === true, JSON.stringify(retry.result));

  // 2) Rung 1 — live sandbox: the message lands as a pushed event, intact.
  const outLive = INTERNAL.deliverPushMessage(appId, { title: 'Ada', body: 'picture this', data: { conversationId: 'c-42' } });
  await sleep(30);
  check('live delivery reports how:live', outLive.delivered === true && outLive.how === 'live', JSON.stringify(outLive));
  const live = pushesTo(chat.webview)[0];
  check('live push arrives with the full normalized shape', live && live.result.title === 'Ada' && live.result.body === 'picture this' && live.result.data.conversationId === 'c-42' && live.result.appId === appId && typeof live.result.id === 'string', JSON.stringify(live && live.result));
  check('nothing queued on live delivery', queueLen() === 0, String(queueLen()));

  // 3) The revocation door: a revoked app's messages are dropped before
  //    any rung — nothing pushed, nothing queued, nothing displayed.
  await PM.revokePermission('push:receive', appId, { source: 'test' });
  const outRevoked = INTERNAL.deliverPushMessage(appId, { title: 'sneaky', data: {} });
  check('revoked grant drops the message', outRevoked.delivered === false && outRevoked.how === 'no-grant', JSON.stringify(outRevoked));
  check('revoked drop left no queue and no push', queueLen() === 0 && pushesTo(chat.webview).length === 1, JSON.stringify({ queue: queueLen(), pushes: pushesTo(chat.webview).length }));
  await PM.grantPermission('push:receive', appId, { source: 'test' });

  // 4) Rung 2 — closed + system:background: queue + wake request. The
  //    scheduler is stubbed at its real requestWake contract; the queue is
  //    the durable half either way.
  await PM.grantPermission('system:background', appId, { source: 'test' });
  const wakeCalls = [];
  const hadScheduler = typeof global.AppScheduler !== 'undefined';
  global.AppScheduler = { requestWake: (id) => { wakeCalls.push(id); return true; } };
  chat.sandbox && INTERNAL._activeSandboxes.delete(chat.webview.dataset.sandboxId); // app "closed"
  const outWake = INTERNAL.deliverPushMessage(appId, { title: 'While closed', data: { seq: 'wake' } });
  check('closed wake-eligible app queues + requests a wake', outWake.delivered === true && outWake.how === 'wake-queued' && queueLen() === 1, JSON.stringify({ outWake, len: queueLen() }));
  check('the wake was requested for the right app', wakeCalls.length === 1 && wakeCalls[0] === appId, JSON.stringify(wakeCalls));
  if (!hadScheduler) delete global.AppScheduler;
  await PM.revokePermission('system:background', appId, { source: 'test' });

  // 5) Rung 3+4 — closed, not wakeable: OS shows the notification with the
  //    app's own name/id attribution, and the data part queues behind it.
  const outNotified = INTERNAL.deliverPushMessage(appId, { title: 'While closed', body: 'os shows this', data: { seq: 'queue' } });
  check('closed non-wakeable app gets notified-queued', outNotified.delivered === true && outNotified.how === 'notified-queued' && queueLen() === 2, JSON.stringify({ outNotified, len: queueLen() }));
  check('OS notification is attributed to the app', global.OS.notifications.some((n) => n.appId === appId && n.title === 'While closed'), JSON.stringify(global.OS.notifications.map((n) => ({ appId: n.appId, title: n.title }))));

  // 6) Budget: the same per-app notification rate limit as self-posted
  //    notifications caps the display rung (10/min); the queue keeps
  //    working past it.
  for (let i = 0; i < 14; i++) INTERNAL.deliverPushMessage(appId, { title: `flood${i}`, data: { seq: i } });
  const displayedFlood = global.OS.notifications.filter((n) => n.appId === appId && /^flood/.test(n.title)).length;
  check('display rung respects the notification budget', displayedFlood <= 10, String(displayedFlood));
  check('queue keeps accepting while display is throttled', queueLen() === 8, String(queueLen()));

  // 7) Relaunch: nova:ready flushes the bounded queue, in order, flagged.
  const wv3 = makeWebview(appId);
  const sb3 = makeSandbox(appId, { webview: wv3 });
  INTERNAL._activeSandboxes.set(wv3.dataset.sandboxId, sb3);
  INTERNAL._eventSubscriptions.set(wv3.dataset.sandboxId, new Map());
  await INTERNAL.handleAPICall('nova:ready', {}, 'req-ready-push', chat.app, wv3, sb3);
  await sleep(50);
  const flushed = pushesTo(wv3);
  // The 14-flood burst above replaced the two earlier entries — the bound
  // keeps the NEWEST 8, so the flush must be exactly floods 6..13 in order.
  check('queued pushes flush right after nova:ready', flushed.length === 8, String(flushed.length));
  check('flushed pushes carry queued:true and keep order', flushed.every((r) => r.result.queued === true) && flushed[0].result.data.seq === 6 && flushed[7].result.data.seq === 13, JSON.stringify(flushed.map((r) => r.result.data && r.result.data.seq)));
  check('queue drains empty after the flush', queueLen() === 0, String(queueLen()));

  // 8) Unregister tears the whole surface down for this app.
  const fetchLenBeforeUnregister = fetchCalls.length;
  const unreg = await INTERNAL.handleAPICall('nova:push:unregister', {}, 'req-unreg', chat.app, wv3, sb3);
  await sleep(25);
  check('unregister resolves and clears token + queue', !pushState().tokens[appId] && !pushState().queue[appId], JSON.stringify(unreg));
  const unsubscribeCall = fetchCalls.slice(fetchLenBeforeUnregister).find((call) => call.url === '/api/push/subscribe');
  let unsubscribeBody = null;
  try { unsubscribeBody = JSON.parse(unsubscribeCall?.opts?.body || 'null'); } catch (_) { /* checked below */ }
  check('unregister synchronizes the removed token to the server', Array.isArray(unsubscribeBody?.subscriptions)
    && !unsubscribeBody.subscriptions.some((entry) => entry.token === token), JSON.stringify(unsubscribeBody));

  PM.closeAllDialogs();
}

const SCENARIOS = [
  ['R1', r1], ['R2', r2], ['R3', r3], ['R4', r4], ['R5', r5], ['R6', r6],
  ['R7', r7], ['R8', r8], ['R9', r9], ['R10', r10], ['R11', r11], ['R12', r12], ['R13', r13],
];

(async () => {
  installRichDocument();
  installWindowCapture();
  // The permission manager's console noise is expected; keep the runner tidy.
  const origWarn = console.warn;
  console.warn = (...args) => {
    const s = String(args[0] ?? '');
    if (s.includes('[AppPermissionManager]') || s.includes('[Notify]')) return;
    origWarn(...args);
  };

  const filter = (() => {
    const i = process.argv.indexOf('--filter');
    return i > -1 ? process.argv[i + 1] : null;
  })();

  for (const [name, fn] of SCENARIOS) {
    if (filter && !name.startsWith(filter)) continue;
    try {
      await fn();
    } catch (e) {
      fail++;
      failures.push(`${name} crashed: ${e?.stack || e}`);
      console.log(`  CRASH ${name}: ${e?.message}`);
      PM.closeAllDialogs();
    }
  }

  console.warn = origWarn;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})();
