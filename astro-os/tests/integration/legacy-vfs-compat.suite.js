'use strict';
// AstroOS — legacy vfs → fs compatibility suite.
//
// Old .novaapp packages predate the fs:* era: their manifests declare the
// vfs:* permission family (vfs:access/read/write/delete/metadata) and their
// code dials the nova:vfs:* channels (or bare vfs:* spellings). This suite
// drives those exact legacy names through the REAL app-sandbox dispatcher
// with the real permission manager and proves the translate-then-enforce
// contract:
//
//   L1  historical nova:vfs:* channels round-trip on app-owned paths
//       (write → read → mkdir → stat → list → rename → move → delete)
//   L2  bare vfs:* spellings resolve identically
//   L3  metadata spellings (vfs:metadata / the typo'd vfs:metedata) resolve
//       to the metadata channel nova:fs:stat
//   L4  enforcement parity — every gate a modern call hits, a legacy call
//       hits identically: shared reads/writes denied without fs:access,
//       other apps' private data unreachable, fs:access honored once
//       granted. No alias bypass.
//   L5  vfs:access stays UNKNOWN_API as a CHANNEL (it was only ever a
//       permission — AppRegistry translates the permission instead), and
//       unknown vfs:* names get UNKNOWN_API (no wildcard aliasing)
//   L6  response transparency contract: a legacy caller's response carries
//       the MODERN channel's type string (+ ':response', the normal host
//       response suffix) and the caller's requestId — the guest shim
//       matches responses by requestId, never by type — and the modern
//       channels themselves are untouched
//   L7  isolated-process dispatch resolves legacy names past the
//       ISOLATED_PROCESS_API_TYPES gate too
//
// Path convention note: raw /data/... paths are CALLER-RELATIVE — the
// sandbox injects the calling app's id segment (rewriteDataPath), so
// { path: '/data/notes/x.txt' } from app A lands in A's own
// /data/<appId>/notes/x.txt. RAW() below builds such caller-relative paths;
// EXP() builds the absolute path that comes back in responses.
//
// Usage: node tests/test_legacy_vfs_compat.js [--verbose]

const {
  AppSandbox, AppPermissionManager: PM,
  call, grant, revoke, resetHost, makeApp,
} = require('../helpers/env');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}

const APP_ID = 'com.legacy.vfsapp';
const OTHER_APP_ID = 'com.other.app';
const RAW = (p) => `/data/${p}`;                                  // caller-relative
const EXP = (p) => `/data/${APP_ID}/${p}`;                        // absolute on disk
const state = (require('../helpers/env').state || {});
const FS = () => state.FS;

async function main() {
  resetHost();
  FS().ensureAppDir(APP_ID);
  FS().ensureAppDir(OTHER_APP_ID);

  // ── L1: historical nova:vfs:* channels round-trip on app-owned paths ──
  console.log('L1 — historical nova:vfs:* channels (app-owned, zero grants)');
  {
    const w = await call('nova:vfs:write', { path: RAW('notes/legacy.txt'), content: 'hello from 2024' }, { appId: APP_ID });
    check('vfs:write creates app-owned file', !w.error && w.result?.success === true && w.result?.path === EXP('notes/legacy.txt'), JSON.stringify(w.error || w.result));

    const r = await call('nova:vfs:read', { path: RAW('notes/legacy.txt') }, { appId: APP_ID });
    check('vfs:read returns written content', !r.error && r.result?.data === 'hello from 2024', JSON.stringify(r.error || r.result));

    const cross = await call('nova:fs:read', { path: RAW('notes/legacy.txt') }, { appId: APP_ID });
    check('modern fs:read sees legacy write', !cross.error && cross.result?.data === 'hello from 2024', JSON.stringify(cross.error || cross.result));

    const w2 = await call('nova:fs:write', { path: RAW('notes/modern.txt'), content: 'modern' }, { appId: APP_ID });
    const r2 = await call('nova:vfs:read', { path: RAW('notes/modern.txt') }, { appId: APP_ID });
    check('legacy vfs:read sees modern write', !w2.error && !r2.error && r2.result?.data === 'modern', JSON.stringify(r2.error || r2.result));

    const m = await call('nova:vfs:mkdir', { path: RAW('notes'), name: 'docs' }, { appId: APP_ID });
    check('vfs:mkdir creates folder', !m.error && m.result?.success === true && m.result?.path === EXP('notes/docs'), JSON.stringify(m.error || m.result));

    const mv = await call('nova:vfs:move', { path: RAW('notes/legacy.txt'), destPath: RAW('notes/docs') }, { appId: APP_ID });
    check('vfs:move into own folder', !mv.error && mv.result?.success === true && mv.result?.path === EXP('notes/docs/legacy.txt'), JSON.stringify(mv.error || mv.result));

    const s = await call('nova:vfs:stat', { path: RAW('notes/docs/legacy.txt') }, { appId: APP_ID });
    check('vfs:stat returns stat block', !s.error && s.result?.success === true && s.result?.stat?.name === 'legacy.txt', JSON.stringify(s.error || s.result));

    const rn = await call('nova:vfs:rename', { path: RAW('notes/docs/legacy.txt'), name: 'renamed.txt' }, { appId: APP_ID });
    check('vfs:rename renames file', !rn.error && rn.result?.success === true && rn.result?.name === 'renamed.txt', JSON.stringify(rn.error || rn.result));

    const l = await call('nova:vfs:list', { path: RAW('notes/docs') }, { appId: APP_ID });
    check('vfs:list lists folder', !l.error && l.result?.success === true && l.result?.files?.some((c) => c.name === 'renamed.txt'), JSON.stringify(l.error || l.result));

    const d = await call('nova:vfs:delete', { path: RAW('notes/docs/renamed.txt') }, { appId: APP_ID });
    check('vfs:delete removes file', !d.error && d.result?.success === true, JSON.stringify(d.error || d.result));

    const gone = await call('nova:vfs:read', { path: RAW('notes/docs/renamed.txt') }, { appId: APP_ID });
    check('deleted file reads NOT_FOUND via legacy name', gone.error?.code === 'NOT_FOUND', JSON.stringify(gone.error || gone.result));
  }

  // ── L2: bare vfs:* spellings resolve identically ──
  console.log('L2 — bare vfs:* spellings');
  {
    const w = await call('vfs:write', { path: RAW('bare/b.txt'), content: 'bare' }, { appId: APP_ID });
    check('bare vfs:write works', !w.error && w.result?.success === true && w.result?.path === EXP('bare/b.txt'), JSON.stringify(w.error || w.result));

    const r = await call('vfs:read', { path: RAW('bare/b.txt') }, { appId: APP_ID });
    check('bare vfs:read works', !r.error && r.result?.data === 'bare', JSON.stringify(r.error || r.result));

    const s = await call('vfs:stat', { path: RAW('bare/b.txt') }, { appId: APP_ID });
    check('bare vfs:stat works', !s.error && s.result?.stat?.name === 'b.txt', JSON.stringify(s.error || s.result));

    const m = await call('vfs:mkdir', { path: RAW('bare'), name: 'sub' }, { appId: APP_ID });
    check('bare vfs:mkdir works', !m.error && m.result?.success === true && m.result?.path === EXP('bare/sub'), JSON.stringify(m.error || m.result));

    const l = await call('vfs:list', { path: RAW('bare') }, { appId: APP_ID });
    check('bare vfs:list works', !l.error && l.result?.success === true && Array.isArray(l.result?.files), JSON.stringify(l.error || l.result));

    const rn = await call('vfs:rename', { path: RAW('bare/b.txt'), name: 'b2.txt' }, { appId: APP_ID });
    check('bare vfs:rename works', !rn.error && rn.result?.name === 'b2.txt', JSON.stringify(rn.error || rn.result));

    const mv = await call('vfs:move', { path: RAW('bare/b2.txt'), destPath: RAW('bare/sub') }, { appId: APP_ID });
    check('bare vfs:move works', !mv.error && mv.result?.path === EXP('bare/sub/b2.txt'), JSON.stringify(mv.error || mv.result));

    const d = await call('vfs:delete', { path: RAW('bare/sub/b2.txt') }, { appId: APP_ID });
    check('bare vfs:delete works', !d.error && d.result?.success === true, JSON.stringify(d.error || d.result));
  }

  // ── L3: metadata spellings resolve to nova:fs:stat ──
  console.log('L3 — metadata spelling variants → nova:fs:stat');
  {
    const modern = await call('nova:fs:stat', { path: RAW('notes/modern.txt') }, { appId: APP_ID });
    check('modern stat baseline', !modern.error && modern.result?.stat?.name === 'modern.txt', JSON.stringify(modern.error || modern.result));
    for (const ch of ['vfs:metadata', 'vfs:metedata', 'nova:vfs:metadata', 'nova:vfs:metedata']) {
      const r = await call(ch, { path: RAW('notes/modern.txt') }, { appId: APP_ID });
      check(`${ch} resolves to stat`, !r.error && r.result?.success === true && r.result?.stat?.name === 'modern.txt',
        JSON.stringify(r.error || r.result));
    }
  }

  // ── L4: enforcement parity — the alias never bypasses a gate ──
  console.log('L4 — enforcement parity (shared tree, other-app data, grants)');
  {
    // Shared tree fixture: /Documents/pub.txt at the filesystem root.
    const docs = await FS().createFolder(FS().rootId, 'Documents');
    await FS().createFile(docs.id, 'pub.txt', 'public bytes');

    // a) shared read: legacy denied with the EXACT code+message modern gets.
    const legacyRead = await call('nova:vfs:read', { path: 'shared:Documents/pub.txt' }, { appId: APP_ID });
    const modernRead = await call('nova:fs:read', { path: 'shared:Documents/pub.txt' }, { appId: APP_ID });
    check('legacy shared read denied like modern', legacyRead.error?.code === 'PERMISSION_DENIED'
      && legacyRead.error?.message === modernRead.error?.message,
      JSON.stringify({ legacy: legacyRead.error, modern: modernRead.error }));

    // b) shared write: same parity.
    const legacyWrite = await call('nova:vfs:write', { path: 'shared:Documents/pub.txt', content: 'nope' }, { appId: APP_ID });
    const modernWrite = await call('nova:fs:write', { path: 'shared:Documents/pub.txt', content: 'nope' }, { appId: APP_ID });
    check('legacy shared write denied like modern', legacyWrite.error?.code === 'PERMISSION_DENIED'
      && legacyWrite.error?.message === modernWrite.error?.message,
      JSON.stringify({ legacy: legacyWrite.error, modern: modernWrite.error }));

    // c) another app's private data is unreachable through the alias.
    await call('nova:fs:write', { path: RAW('secret.txt'), content: 'private' }, { appId: OTHER_APP_ID });
    const legacyCross = await call('nova:vfs:read', { path: `/data/${OTHER_APP_ID}/secret.txt` }, { appId: APP_ID });
    const modernCross = await call('nova:fs:read', { path: `/data/${OTHER_APP_ID}/secret.txt` }, { appId: APP_ID });
    check('legacy cannot read other app data (same as modern)', legacyCross.error?.code === modernCross.error?.code,
      JSON.stringify({ legacy: legacyCross.error, modern: modernCross.error }));

    // d) once fs:access is granted, the legacy channel honors it — the old
    //    app works against the shared tree exactly like a modern app would.
    await grant('fs:access', APP_ID);
    const grantedRead = await call('nova:vfs:read', { path: 'shared:Documents/pub.txt' }, { appId: APP_ID });
    check('legacy shared read succeeds with fs:access', !grantedRead.error && grantedRead.result?.data === 'public bytes',
      JSON.stringify(grantedRead.error || grantedRead.result));
    const grantedWrite = await call('vfs:write', { path: 'shared:Documents/pub.txt', content: 'edited by legacy app' }, { appId: APP_ID });
    check('bare vfs:write edits shared file with fs:access', !grantedWrite.error && grantedWrite.result?.success === true,
      JSON.stringify(grantedWrite.error || grantedWrite.result));
    await revoke('fs:access', APP_ID);
    const revokedRead = await call('nova:vfs:read', { path: 'shared:Documents/pub.txt' }, { appId: APP_ID });
    check('revoking fs:access re-locks the legacy path', revokedRead.error?.code === 'PERMISSION_DENIED',
      JSON.stringify(revokedRead.error || revokedRead.result));
  }

  // ── L5: vfs:access is deliberately NOT a channel; no wildcard aliasing ──
  console.log('L5 — vfs:access channel and unknown names stay UNKNOWN_API');
  {
    const a = await call('vfs:access', {}, { appId: APP_ID });
    check('vfs:access channel is UNKNOWN_API (permission-only name)', a.error?.code === 'UNKNOWN_API', JSON.stringify(a.error || a.result));

    const n = await call('nova:vfs:unknown', { path: RAW('x') }, { appId: APP_ID });
    check('nova:vfs:unknown is UNKNOWN_API', n.error?.code === 'UNKNOWN_API', JSON.stringify(n.error || n.result));

    const w = await call('vfs:frobnicate', {}, { appId: APP_ID });
    check('vfs:frobnicate is UNKNOWN_API (no prefix wildcard)', w.error?.code === 'UNKNOWN_API', JSON.stringify(w.error || w.result));
  }

  // ── L6: response transparency contract + modern channels untouched ──
  console.log('L6 — response carries modern channel type + caller requestId');
  {
    const r = await call('nova:vfs:read', { path: RAW('notes/modern.txt') }, { appId: APP_ID, requestId: 'legacy-req-1' });
    check('legacy response type is the modern channel name', r.type === 'nova:fs:read:response', `got ${r.type}`);
    check('legacy response echoes caller requestId', r.requestId === 'legacy-req-1', `got ${r.requestId}`);

    const modern = await call('nova:fs:read', { path: RAW('notes/modern.txt') }, { appId: APP_ID });
    check('modern channel behavior unchanged', !modern.error && modern.result?.data === 'modern', JSON.stringify(modern.error || modern.result));

    // A legacy name aimed at a missing file reaches the handler (NOT_FOUND),
    // not the front door (UNKNOWN_API) — proof the rewrite happened.
    const missing = await call('vfs:stat', { path: RAW('nope/missing.txt') }, { appId: APP_ID });
    check('legacy name on missing file is NOT_FOUND, not UNKNOWN_API', missing.error?.code === 'NOT_FOUND', JSON.stringify(missing.error || missing.result));
  }

  // ── L7: isolated-process dispatch resolves legacy names too ──
  console.log('L7 — isolated-process gate resolves legacy names');
  {
    const AppRegistry = state.AppRegistry;
    AppRegistry._apps.set(APP_ID, makeApp(APP_ID));
    const res = await AppSandbox._internal.dispatchIsolatedProcessRequest({
      appId: APP_ID, type: 'nova:vfs:stat', payload: { path: RAW('notes/modern.txt') }, requestId: 'iso-1',
    });
    check('isolated process resolves nova:vfs:stat past the gate', !res.error && res.result?.stat?.name === 'modern.txt',
      JSON.stringify(res.error || res.result));

    const denied = await AppSandbox._internal.dispatchIsolatedProcessRequest({
      appId: APP_ID, type: 'vfs:access', payload: {}, requestId: 'iso-2',
    });
    check('isolated process vfs:access stays unavailable', denied.error?.code === 'UNAVAILABLE' && denied.type === 'vfs:access:response',
      JSON.stringify(denied.error || denied));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
