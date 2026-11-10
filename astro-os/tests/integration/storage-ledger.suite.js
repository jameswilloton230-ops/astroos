'use strict';
// Storage ledger ("logical UID" layer) test suite.
//
// Loads the REAL app-sandbox.js over the shared env helpers and verifies:
//   S1  ledger unit behavior (budgets, clamps, accounting, audit ring, cleanup)
//   S2  nova:storage quota now flows through per-app budgets (25 MB → 256 MB default)
//   S3  nova:ipc payload cap is per-app (64 KB → 256 KB default)
//   S4  HTTP body cap is per-app host-side AND in the injected guest shim
//   S5  scoped fs roots (appdata: / shared: / media:) + shared-access audit
//   S6  uninstall / clear-data cleanup wipes ledger state
//
// Usage: node tests/test_storage_ledger.js [--verbose]

const env = require('../helpers/env');
const { AppSandbox, AppPermissionManager: PM, makeApp, makeWebview, makeSandbox, call, grant, resetHost, registerActive } = env;

// The host page has AppSandbox on window; mirror that wiring here so
// handleAppUninstall's `typeof AppSandbox` guards reach the real module.
global.AppSandbox = AppSandbox;

const INTERNAL = AppSandbox._internal;
const Ledger = AppSandbox.storageLedger;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log('\n' + title); }
const code = (r) => r?.error?.code ?? null;
const MB = 1024 * 1024;

// App ids WITHOUT dots so sanitizeAppIdSegment(appId) === appId and the
// fake FS /data/<id> ownership convention matches exactly.
const A = 'appA';
const B = 'appB';

async function main() {

async function ensureAppDataDir(appId) {
  const FS = env.state.FS;
  const data = FS.getByPath('/data');
  if (!FS.listDir(data.id).find((n) => n.name === appId)) {
    await FS.createFolder(data.id, appId); // fake-fs folder ops are async
  }
}

async function writeOwn(appId, relPath, content) {
  await ensureAppDataDir(appId);
  // Raw /data/... paths are CALLER-RELATIVE (the host injects the caller's
  // own id segment), so the app-owned form is '/data/' + relPath.
  return call('nova:fs:write', { path: '/data/' + relPath, content }, { appId });
}

// ══════════════════════════ S1: ledger unit behavior ══════════════════════════

section('S1: ledger unit behavior');

resetHost();
Ledger.resetAll();

const D = Ledger.DEFAULT_BUDGETS;
check('default storage quota raised to 256 MB', D.storageQuotaBytes === 256 * MB, String(D.storageQuotaBytes));
check('default IPC payload raised to 256 KB', D.ipcPayloadBytes === 256 * 1024, String(D.ipcPayloadBytes));
check('default HTTP body raised to 16 MiB', D.httpBodyBytes === 16 * MB, String(D.httpBodyBytes));
check('default request timeout raised to 60 s', D.requestTimeoutMs === 60000, String(D.requestTimeoutMs));
check('unknown app gets defaults', Ledger.getBudget('never-seen-app', 'storageQuotaBytes') === D.storageQuotaBytes);
check('unknown budget key returns null', Ledger.getBudget(A, 'nope') === null);

let threw = false;
try { Ledger.setBudget(A, 'nope', 100); } catch (e) { threw = true; }
check('setBudget rejects unknown key', threw);

const clampedLow = Ledger.setBudget(A, 'storageQuotaBytes', 500);
check('budget clamped up to minimum (1 MB)', clampedLow === MB, String(clampedLow));
const clampedHigh = Ledger.setBudget(A, 'storageQuotaBytes', 99 * 1024 * MB);
check('budget clamped down to maximum (2 GB)', clampedHigh === 2 * 1024 * MB, String(clampedHigh));
check('override wins over default', Ledger.getBudget(A, 'storageQuotaBytes') === 2 * 1024 * MB);
check('other apps unaffected by override', Ledger.getBudget(B, 'storageQuotaBytes') === D.storageQuotaBytes);

Ledger.noteRequest(A);
Ledger.noteBytes(A, { written: 100, read: 40 });
Ledger.noteBytes(A, { written: 60 });
let stats = Ledger.getAppStats(A);
check('request counter', stats.requestCount === 1, String(stats.requestCount));
check('bytesWritten accumulates', stats.bytesWritten === 160, String(stats.bytesWritten));
check('bytesRead accumulates', stats.bytesRead === 40, String(stats.bytesRead));

Ledger.recordAccess({ appId: A, kind: 'shared-file-read', detail: '/Downloads/a.txt' });
Ledger.recordAccess({ appId: B, kind: 'shared-file-write', detail: '/Downloads/b.txt' });
Ledger.recordAccess({ appId: A, kind: 'picked-file-read', detail: '/Documents/c.txt' });
Ledger.noteRequest(B); // recordAccess alone does not create app records
check('audit: newest first', Ledger.listAccess(null, 1)[0].kind === 'picked-file-read');
check('audit: filter by app', Ledger.listAccess(A, 10).length === 2);
check('audit: cap respected', Ledger.listAccess(null, 2).length === 2);
check('audit: rejects empty entries', Ledger.recordAccess({ kind: 'x' }) === false && Ledger.recordAccess(null) === false);

// resetForApp keeps budget overrides (configuration), zeroes counters.
Ledger.resetForApp(A);
stats = Ledger.getAppStats(A);
check('resetForApp zeroes counters', stats.bytesWritten === 0 && stats.bytesRead === 0 && stats.requestCount === 0);
check('resetForApp keeps budget override', stats.budgets.storageQuotaBytes === 2 * 1024 * MB);

// removeApp wipes the record + audit entries for that app.
Ledger.removeApp(A);
check('removeApp drops the record', Ledger.getAppStats(A) === null);
check('removeApp drops audit entries', Ledger.listAccess(A, 100).length === 0);
check('removeApp keeps other apps', Ledger.getAppStats(B) !== null);

// ══════════════════════════ S2: storage quota via budgets ══════════════════════════

section('S2: nova:storage quota flows through per-app budgets');

resetHost();
Ledger.resetAll();

// Legacy cap was 25 MB — write 6 × ~5 MB = ~30 MB under the 256 MB default.
const bigValue = 'x'.repeat(5 * MB - 1024);
let raisedOk = true;
for (let i = 0; i < 6; i++) {
  const r = await call('nova:storage:set', { key: 'big' + i, value: bigValue }, { appId: A });
  if (code(r) !== null) { raisedOk = false; break; }
}
check('30 MB total stored under raised default (legacy 25 MB would reject)', raisedOk);

const usageR = await call('nova:storage:usage', {}, { appId: A });
check('nova:storage:usage returns usage', usageR.result?.success === true && usageR.result.usage >= 6 * (5 * MB - 1024), JSON.stringify(usageR.result));
check('nova:storage:usage returns 256 MB budget', usageR.result?.budget === 256 * MB);

// Enforcement: lower app B's budget to the 1 MB floor (B has no stored data).
Ledger.setBudget(B, 'storageQuotaBytes', 1024 * 1024);
const fitR = await call('nova:storage:set', { key: 'fits', value: 'z'.repeat(900 * 1024) }, { appId: B });
check('under-budget write accepted', code(fitR) === null, code(fitR));
const overR = await call('nova:storage:set', { key: 'toomuch', value: 'y'.repeat(2 * MB) }, { appId: B });
check('over-budget write rejected STORAGE_FULL', code(overR) === 'STORAGE_FULL', code(overR));

const statsA = Ledger.getAppStats(A);
check('storage bandwidth accounting (written ≈ 6 × 5 MB)', statsA.bytesWritten >= 6 * (5 * MB - 1024), String(statsA.bytesWritten));
check('request accounting counted', statsA.requestCount >= 6, String(statsA.requestCount));
const reqBefore = Ledger.getAppStats(B).requestCount;
await call('nova:storage:delete', { key: 'fits' }, { appId: B });
check('delete ticks request counter', Ledger.getAppStats(B).requestCount === reqBefore + 1);

// ══════════════════════════ S3: per-app IPC payload budget ══════════════════════════

section('S3: nova:ipc payload cap is per-app');

resetHost();
Ledger.resetAll();

// Target app acting as an IPC endpoint.
const targetApp = makeApp('ipcTarget', { manifest: { ipc: { exports: ['service:echo'], receives: [] } } });
env.state.OS.apps['ipcTarget'] = targetApp;
env.state.AppRegistry._apps.set('ipcTarget', targetApp);
await grant('apps:communicate', 'ipcTarget');
await grant('apps:communicate', A);
const targetWv = makeWebview('ipcTarget');
const targetSandbox = makeSandbox('ipcTarget', { webview: targetWv });
targetSandbox.appIpcEndpoints = new Set(['service:echo']);
registerActive(targetSandbox);

// 70 KB payload: over the legacy 64 KB cap, under the 256 KB default.
const midPayload = { data: { blob: 'm'.repeat(70 * 1024) } };
const invokePromise = call('nova:ipc:invoke', { targetAppId: 'ipcTarget', endpoint: 'service:echo', ...midPayload }, { appId: A });
await new Promise((r) => setTimeout(r, 60));
// respond() types are '<channel>:response', so the forwarded request arrives
// as nova:ipc:request:response with the callId in requestId.
const forwarded = targetWv.responses.find((m) => m.type === 'nova:ipc:request:response');
check('70 KB payload forwarded (legacy 64 KB would reject)', !!forwarded, forwarded ? 'forwarded' : 'not forwarded');
if (forwarded) {
  await call('nova:ipc:reply', { callId: forwarded.requestId, result: { echo: true } }, { appId: 'ipcTarget', sandbox: targetSandbox, webview: targetWv });
  const done = await invokePromise;
  check('invoke completed after reply', done.result?.echo === true, JSON.stringify(done.result ?? done.error));
} else {
  await invokePromise.catch(() => {});
}

// Lower the budget to the 1 KB floor; a 2 KB payload must bounce.
Ledger.setBudget(A, 'ipcPayloadBytes', 1024);
const overIpc = await call('nova:ipc:invoke', { targetAppId: 'ipcTarget', endpoint: 'service:echo', data: { blob: 'm'.repeat(2 * 1024) } }, { appId: A });
check('over-budget IPC payload rejected', code(overIpc) === 'INVALID_ARGS', code(overIpc));
check('error names the 1 KB limit', (overIpc.error?.message || '').includes('1 KB'), overIpc.error?.message || '');
const overBroadcast = await call('nova:ipc:broadcast', { action: 'chat.message', data: { blob: 'm'.repeat(2 * 1024) } }, { appId: A });
check('broadcast payload also budget-capped', code(overBroadcast) === 'INVALID_ARGS', code(overBroadcast));

// ══════════════════════════ S4: HTTP body budget (host + guest shim) ══════════════════════════

section('S4: HTTP body cap is per-app host-side and in the guest shim');

resetHost();
Ledger.resetAll();
await grant('net:external', A);

// 7 MB base64 body: over the legacy 6 MiB cap, under the 16 MiB default.
const sevenMB = Buffer.alloc(7 * MB, 7).toString('base64');
const fetchOk = await call('nova:net:fetch', { url: 'https://example.com/upload', method: 'POST', body: sevenMB, bodyEncoding: 'base64' }, { appId: A });
check('7 MB body passes (legacy 6 MiB would reject)', code(fetchOk) !== 'PAYLOAD_TOO_LARGE', code(fetchOk) || 'ok');

Ledger.setBudget(A, 'httpBodyBytes', 64 * 1024);
const fetchBig = await call('nova:net:fetch', { url: 'https://example.com/upload', method: 'POST', body: sevenMB, bodyEncoding: 'base64' }, { appId: A });
check('over-budget body rejected PAYLOAD_TOO_LARGE', code(fetchBig) === 'PAYLOAD_TOO_LARGE', code(fetchBig));
const fetchSmall = await call('nova:net:fetch', { url: 'https://example.com/upload', method: 'POST', body: 'a'.repeat(1024), bodyEncoding: 'base64' }, { appId: A });
check('under-budget body passes', code(fetchSmall) !== 'PAYLOAD_TOO_LARGE', code(fetchSmall) || 'ok');

// Guest shim constants: defaults without a budget, per-app values with one.
const defaultShim = INTERNAL.buildCapabilityShim(false, null);
check('default shim bakes 30000 ms timeout', defaultShim.includes('const REQUEST_TIMEOUT_MS = 30000;'));
check('default shim bakes 6 MiB body cap', defaultShim.includes('__NOVA_MAX_BODY_BYTES__ = ' + (6 * MB) + ';'));
const customShim = INTERNAL.buildCapabilityShim(false, null, { requestTimeoutMs: 120000, httpBodyBytes: 32 * MB });
check('custom shim bakes raised timeout', customShim.includes('const REQUEST_TIMEOUT_MS = 120000;'));
check('custom shim bakes raised body cap', customShim.includes('__NOVA_MAX_BODY_BYTES__ = ' + (32 * MB) + ';'));
const shimClamped = INTERNAL.buildCapabilityShim(false, null, { requestTimeoutMs: 1, httpBodyBytes: -5 });
check('shim falls back to defaults on junk budgets', shimClamped.includes('const REQUEST_TIMEOUT_MS = 30000;') && shimClamped.includes('__NOVA_MAX_BODY_BYTES__ = ' + (6 * MB) + ';'));

// injectCapabilityShim pulls the budget from the ledger for the real app.
Ledger.setBudget(B, 'requestTimeoutMs', 90000);
const injected = INTERNAL.injectCapabilityShim('<html><head></head><body></body></html>', makeApp(B, { manifest: {} }));
check('injected shim carries the app budget (90 s)', injected.includes('const REQUEST_TIMEOUT_MS = 90000;'));

// ══════════════════════════ S5: scoped roots + access audit ══════════════════════════

section('S5: scoped fs roots (appdata: / shared:) + shared-access audit');

resetHost();
Ledger.resetAll();

await ensureAppDataDir(A);
await ensureAppDataDir(B);

// appdata: write + read round-trip, verified in the real VFS path.
// The host does not auto-create intermediate folders — mkdir notes/ first.
const mkNotes = await call('nova:fs:mkdir', { path: 'appdata:/', name: 'notes' }, { appId: A });
check('appdata: mkdir works (notes/)', code(mkNotes) === null && !!env.state.FS.getByPath('/data/appA/notes'), code(mkNotes) || 'ok');
const wApp = await call('nova:fs:write', { path: 'appdata:/notes/todo.txt', content: 'hello ledger' }, { appId: A });
check('appdata: write succeeds', code(wApp) === null, code(wApp) || 'ok');
const vApp = env.state.FS.getByPath('/data/appA/notes/todo.txt');
check('appdata: landed in the app own subtree', !!vApp && vApp.content === 'hello ledger');
const rApp = await call('nova:fs:read', { path: 'appdata:/notes/todo.txt' }, { appId: A });
check('appdata: read back', rApp.result?.data === 'hello ledger', JSON.stringify(rApp.result || rApp.error));

// appdata: of app B must resolve to B own (empty) subtree — never A.
const rForeign = await call('nova:fs:read', { path: 'appdata:/notes/todo.txt' }, { appId: B });
check('appdata: is caller-scoped (B cannot see A file)', code(rForeign) === 'NOT_FOUND', code(rForeign));
const rRawForeign = await call('nova:fs:read', { path: '/data/appA/notes/todo.txt' }, { appId: B });
check('raw foreign /data path still unreachable', code(rRawForeign) === 'NOT_FOUND', code(rRawForeign));

// mkdir via appdata: scheme (root level).
const mk = await call('nova:fs:mkdir', { path: 'appdata:/', name: 'cache' }, { appId: A });
check('appdata: mkdir works (cache/)', code(mk) === null && !!env.state.FS.getByPath('/data/appA/cache'), code(mk) || 'ok');

// Shared tree: file in /Downloads readable only with a grant, audited.
const FS = env.state.FS;
let downloads = FS.listDir(FS.getByPath('/').id).find((n) => n.name === 'Downloads');
if (!downloads) downloads = await FS.createFolder(FS.getByPath('/').id, 'Downloads');
await FS.createFile(downloads.id, 'report.txt', 'shared contents', 'text/plain');

const noGrant = await call('nova:fs:read', { path: 'shared:/Downloads/report.txt' }, { appId: A });
check('shared read without grant denied', code(noGrant) === 'PERMISSION_DENIED', code(noGrant));

await grant('fs:access', A);
const withGrant = await call('nova:fs:read', { path: 'shared:/Downloads/report.txt' }, { appId: A });
check('shared read with fs:access allowed', withGrant.result?.data === 'shared contents', code(withGrant) || 'ok');
const audit = Ledger.listAccess(A, 10);
check('shared read audited', audit.some((e) => e.kind === 'shared-file-read' && e.detail === '/Downloads/report.txt'), JSON.stringify(audit));

// Owner reads are NOT audited but DO tick accounting.
const before = Ledger.getAppStats(A);
await call('nova:fs:read', { path: 'appdata:/notes/todo.txt' }, { appId: A });
const after = Ledger.getAppStats(A);
check('owner read not audited', Ledger.listAccess(A, 10).length === audit.length);
check('owner read ticks bytesRead', after.bytesRead >= before.bytesRead + 'hello ledger'.length, `${before.bytesRead} -> ${after.bytesRead}`);

// shared: refuses to reach into /data.
const sneaky = await call('nova:fs:read', { path: 'shared:/data/appA/notes/todo.txt' }, { appId: A });
check('shared: cannot address /data', code(sneaky) === 'NOT_FOUND', code(sneaky));

// Shared write (fs:access) is audited too.
const wShared = await call('nova:fs:write', { path: 'shared:/Downloads/report.txt', content: 'appA was here' }, { appId: A });
check('shared write with fs:access ok', code(wShared) === null, code(wShared) || 'ok');
check('shared write audited', Ledger.listAccess(A, 10).some((e) => e.kind === 'shared-file-write' && e.detail === '/Downloads/report.txt'));

// ══════════════════════════ S6: uninstall / clear-data cleanup ══════════════════════════

section('S6: uninstall clears ledger state');

resetHost();
Ledger.resetAll();

await writeOwn(A, 'persist.dat', 'data');
await call('nova:storage:set', { key: 'k', value: 'v' }, { appId: A });
Ledger.setBudget(A, 'ipcPayloadBytes', 8 * 1024);
Ledger.recordAccess({ appId: A, kind: 'shared-file-read', detail: '/Downloads/x' });
check('precondition: ledger record exists', Ledger.getAppStats(A) !== null);

const cleaner = 'cleanerApp';
await grant('system:apps', cleaner);
env.state.OS.apps[A] = makeApp(A, { source: 'file', system: false, verified: false, signer: null });
global.APP_REGISTRY.push(env.state.OS.apps[A]);
// The env AppRegistry stub has no uninstall flow — mirror test_real_use.js
// and stub it as accepting (the ledger cleanup is what's under test here).
env.state.AppRegistry.uninstallApp = () => true;

const un = await call('nova:app:uninstall', { appId: A }, { appId: cleaner });
check('uninstall succeeded', code(un) === null && un.result?.success === true, code(un) || JSON.stringify(un.result));
check('ledger record removed on uninstall', Ledger.getAppStats(A) === null);
check('audit entries for app removed', Ledger.listAccess(A, 100).length === 0);

// clear-data path keeps the record but resets counters (app stays installed).
await writeOwn(B, 'f.txt', 'abc');
Ledger.setBudget(B, 'httpBodyBytes', 32 * MB);
Ledger.noteRequest(B);
Ledger.resetForApp(B);
const statsB = Ledger.getAppStats(B);
check('resetForApp: counters zeroed, record kept', statsB.requestCount === 0 && statsB.bytesWritten === 0);
check('resetForApp: budget override kept', statsB.budgets.httpBodyBytes === 32 * MB);

// ══════════════════════════ summary ══════════════════════════

console.log(`\n${'═'.repeat(60)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);

}

main().catch((e) => {
  console.error('Suite crashed:', e);
  process.exit(1);
});
