'use strict';
// AstroOS — Recipe Box 2.1.0 compatibility suite.
//
// Drives the exact IPC sequence com.dirazcoder.recipebox runs at boot and
// in its headline features through the REAL app-sandbox dispatcher, with
// the real permission manager and a stubbed SystemDialogs:
//
//   B1  boot: ready handshake → storage get/set → state flush
//   B2  /data tree: mkdir files/backups + photos dirs, write, list, read
//   B3  notifications: manifest channels + createChannel + tagged post +
//       progress update + action consumption
//   B4  clipboard write, window title
//   B5  calendar facade path (nova.calendar.save → nova:calendar:write)
//   B6  import picker (nova:files:open, mixed accept) + backup restore
//   B7  photo picker (nova:sysdialog:open multiple + array accept) +
//       binary content decoding
//
// Usage: node tests/test_recipebox_compat.js [--verbose]

const fs = require('fs');
const os = require('os');
const path = require('path');

const env = require('../helpers/env');
const {
  AppPermissionManager: PM, Notify,
  call, grant, resetHost,
} = env;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}

const APP_ID = 'com.dirazcoder.recipebox';
const state = (env.state || {});

// Real temp files for the picker stubs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-compat-'));
const RECIPE = path.join(tmpDir, 'pancakes.recipe');
fs.writeFileSync(RECIPE, JSON.stringify({ name: 'Pancakes', ingredients: ['flour'] }));
const JPG = path.join(tmpDir, 'photo.jpg');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(64, 7)]);
fs.writeFileSync(JPG, JPEG_BYTES);
const BACKUP = path.join(tmpDir, 'recipebox-backup-2026-11-04.json');
fs.writeFileSync(BACKUP, JSON.stringify({ app: APP_ID, kind: 'recipebox-backup', recipes: [] }));

const dialogCalls = [];
global.window.SystemDialogs = {
  async open(opts) { dialogCalls.push(opts); return stubOpen(opts); },
  async save(opts) { dialogCalls.push(opts); return null; },
};
let stubOpen = async () => null;

async function main() {
  resetHost();
  // The real host lazily creates /data/<appId> on first use; the fake FS
  // needs the same seed (see test_real_use.js R6).
  state.FS.ensureAppDir(APP_ID);

  // ── B1: boot sequence ──────────────────────────────────────────────────
  console.log('B1 — boot: ready + storage');
  {
    const ready = await call('nova:ready', {}, { appId: APP_ID });
    check('nova:ready handshake', !ready.error && ready.result && ready.result.appId === APP_ID,
      JSON.stringify(ready.error || ready.result));

    const empty = await call('nova:storage:get', { key: 'recipes.v3' }, { appId: APP_ID });
    check('first-run storage read is null', !empty.error && empty.result.value === null,
      JSON.stringify(empty.error || empty.result));

    const recipes = JSON.stringify([{ id: 'r1', name: 'Pancakes', photos: [] }]);
    const set = await call('nova:storage:set', { key: 'recipes.v3', value: recipes }, { appId: APP_ID });
    check('state flush write', !set.error && set.result.success === true);

    const back = await call('nova:storage:get', { key: 'recipes.v3' }, { appId: APP_ID });
    check('state round-trip', back.result.value === recipes);
  }

  // ── B2: /data tree (fsMkdir shapes from js/core.js) ────────────────────
  console.log('B2 — /data tree');
  {
    const mk1 = await call('nova:fs:mkdir', { path: '/data/', name: 'files' }, { appId: APP_ID });
    const mk2 = await call('nova:fs:mkdir', { path: '/data/files/', name: 'backups' }, { appId: APP_ID });
    check('mkdir /data/files + /data/files/backups', !mk1.error && !mk2.error,
      JSON.stringify([mk1.error, mk2.error]));

    const wr = await call('nova:fs:write',
      { path: '/data/files/backups/recipebox-auto-2026-11-04.json', content: '{"recipes":[]}' },
      { appId: APP_ID });
    check('backup auto-write', !wr.error && wr.result.success === true, JSON.stringify(wr.error));

    const ls = await call('nova:fs:list', { path: '/data/files/backups/' }, { appId: APP_ID });
    const names = (ls.result && (ls.result.files || ls.result.children) || []).map(f => f.name);
    check('fs:list returns the backup file (app reads r.files||r.items)',
      !ls.error && names.includes('recipebox-auto-2026-11-04.json'), JSON.stringify(names));

    const rd = await call('nova:fs:read', { path: '/data/files/backups/recipebox-auto-2026-11-04.json' }, { appId: APP_ID });
    const data = rd.result && (rd.result.data !== undefined ? rd.result.data : rd.result.content);
    check('fs:read returns content (string or Buffer shape)',
      !rd.error && (data === '{"recipes":[]}'
        || (data && data.data && new TextDecoder().decode(new Uint8Array(data.data)) === '{"recipes":[]}')),
      JSON.stringify(rd.error || typeof data));

    const del = await call('nova:fs:delete', { path: '/data/files/backups/recipebox-auto-2026-11-04.json' }, { appId: APP_ID });
    check('fs:delete (no dead unlink fallback needed)', !del.error && del.result.success === true);
  }

  // ── B3: notifications ──────────────────────────────────────────────────
  console.log('B3 — notifications');
  {
    await grant('device:notifications', APP_ID);
    for (const c of [['timers', 'Cooking timers', 'high'], ['reminders', 'Meal reminders', 'default'],
      ['shopping', 'Shopping', 'default'], ['expiry', 'Expiry alerts', 'default']]) {
      const res = await call('nova:notifications:createChannel', { id: c[0], name: c[1], importance: c[2] }, { appId: APP_ID });
      check(`channel ${c[0]} registered`, !res.error && res.result.success === true, JSON.stringify(res.error));
    }
    const post = await call('nova:notifications:post', {
      channelId: 'timers', tag: 'rb-timer-t1', title: 'Cooking timer', body: '05:00 ⣿⣿⣿',
      actions: [{ id: 'snooze5', label: 'Snooze +5' }, { id: 'stop', label: 'Stop' }],
    }, { appId: APP_ID });
    check('tagged timer post with actions', !post.error && post.result.success === true, JSON.stringify(post.error));

    const upd = await call('nova:notifications:post', {
      channelId: 'timers', tag: 'rb-timer-t1', title: 'Cooking timer', body: '04:59 ⣿⣿⣿',
    }, { appId: APP_ID });
    check('progress tick re-post (update budget)', !upd.error && upd.result.updated === true,
      JSON.stringify(upd.error || upd.result));

    const consumed = await call('nova:notifications:consumeActions', {}, { appId: APP_ID });
    check('action pull queue', !consumed.error && Array.isArray(consumed.result.actions));

    const cancel = await call('nova:notifications:cancel', { tag: 'rb-timer-t1' }, { appId: APP_ID });
    check('timer cancel by tag', !cancel.error && cancel.result.success === true);
  }

  // ── B4: clipboard + title ──────────────────────────────────────────────
  console.log('B4 — clipboard + window title');
  {
    await grant('clipboard:write', APP_ID);
    const cp = await call('nova:clipboard:write', { text: '1.5 kg flour' }, { appId: APP_ID });
    check('shopping-list copy to clipboard', !cp.error && cp.result.success === true);
    const wt = await call('nova:window:setTitle', { title: 'Recipe Box — Pancakes · step 2/6' }, { appId: APP_ID });
    check('cook-mode window title', !wt.error && wt.result.success === true);
  }

  // ── B5: calendar facade ────────────────────────────────────────────────
  console.log('B5 — calendar (planner prep-ahead)');
  {
    await grant('calendar:write', APP_ID);
    // window.nova.calendar.save() maps to this exact call:
    const ev = await call('nova:calendar:write',
      { event: { title: 'Prep dough', date: '2026-11-06', allDay: true } }, { appId: APP_ID });
    check('planner event saved via facade channel', !ev.error && ev.result.success === true,
      JSON.stringify(ev.error));
  }

  // ── B6: import picker + backup restore (mixed accept) ──────────────────
  console.log('B6 — import / restore pickers');
  {
    stubOpen = async () => ({ path: RECIPE, name: 'pancakes.recipe', mimeType: 'application/octet-stream', size: 40 });
    const imp = await call('nova:files:open', {
      title: 'Import recipes',
      accept: ['.json', '.recipe', '.txt', '.csv', '.md', 'text/plain', 'application/json', 'text/markdown', 'text/csv'],
    }, { appId: APP_ID });
    check('import picker opens with mixed accept', !imp.error, JSON.stringify(imp.error));
    check('.recipe import content is readable text',
      imp.result && imp.result.file && imp.result.file.content === fs.readFileSync(RECIPE, 'utf8'),
      JSON.stringify(imp.result && imp.result.file && imp.result.file.content && imp.result.file.content.slice(0, 30)));

    stubOpen = async () => ({ path: BACKUP, name: 'recipebox-backup-2026-11-04.json', mimeType: 'application/json', size: 60 });
    const restore = await call('nova:files:open', {
      title: 'Import backup', accept: ['application/json', 'text/plain', '.json'],
    }, { appId: APP_ID });
    check('restore-backup picker accepts mixed list', !restore.error && restore.result.file.content.includes('recipebox-backup'),
      JSON.stringify(restore.error));
  }

  // ── B7: photo picker (multi + binary) ─────────────────────────────────
  console.log('B7 — photo picker');
  {
    stubOpen = async (opts) => (opts.multiple === true
      ? [{ path: JPG, name: 'photo.jpg', mimeType: 'image/jpeg', size: JPEG_BYTES.length }]
      : null);
    const res = await call('nova:sysdialog:open', {
      title: 'Choose photos', mode: 'open', multiple: true,
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    }, { appId: APP_ID });
    check('photo multi-pick succeeds', !res.error, JSON.stringify(res.error));
    const f = res.result && res.result.files && res.result.files[0];
    check('picked photo returns decodable base64',
      f && f.encoding === 'base64' && Buffer.from(f.content, 'base64').equals(JPEG_BYTES),
      JSON.stringify(f && f.encoding));
    check('accept filter reached the dialog', /\.jpg|image\/jpeg/.test(String(dialogCalls[dialogCalls.length - 1].accept || '')));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('failures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
