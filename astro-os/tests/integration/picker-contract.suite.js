'use strict';
// AstroOS — picker contract regression suite.
//
// Written against the real app-sandbox.js dispatcher with a stubbed
// SystemDialogs service, reproducing the exact IPC call shapes the Recipe
// Box 2.1.0 app (com.jameswilloton230-ops.recipebox) makes:
//
//   P1  nova:files:open   — accept may mix MIME types and .ext entries
//                            ('.json', 'text/plain', …). Rejecting extensions
//                            killed the app's Import and Restore-backup flows
//                            with INVALID_ARGS before the picker even opened.
//   P2  nova:sysdialog:open — multiple: true forwards to SystemDialogs
//                            (which has always supported multi-select) and
//                            returns a files array; accept takes the same
//                            mixed forms. Dropping both silently degraded the
//                            app's photo picker to a single unfiltered file.
//   P3  picked-file content — an unknown extension whose bytes are clean
//                            UTF-8 text ('.recipe' → application/octet-stream)
//                            is returned as text, not base64. Binary files
//                            keep encoding:'base64'.
//   P4  multi-select is capped (bridge memory ceiling).
//
// Usage: node tests/test_picker_contract.js [--verbose]

const fs = require('fs');
const os = require('os');
const path = require('path');

const env = require('../helpers/env');
const {
  AppSandbox, AppPermissionManager: PM,
  makeApp, makeWebview, makeSandbox, call, grant, resetHost,
} = env;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; if (process.env.VERBOSE) console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  FAIL ' + name + (extra ? ` — ${extra}` : '')); }
}

// ── stubbed SystemDialogs over real temp files ──────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-picker-test-'));
function writeTmp(name, data) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, data);
  return p;
}

// Realistic files: a JSON text file with an unknown extension, a fake JPEG
// (JFIF magic + NUL bytes), a plain .txt, and a latin-1 (non-UTF-8) file.
const recipeText = JSON.stringify({ name: 'Pancakes', ingredients: ['flour', 'milk'] });
const RECIPE_PATH = writeTmp('pancakes.recipe', recipeText);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(64, 7)]);
const JPEG_PATH = writeTmp('photo.jpg', JPEG_BYTES);
const JPEG2_PATH = writeTmp('photo2.jpg', JPEG_BYTES);
const TXT_PATH = writeTmp('notes.txt', 'just some notes');
const LATIN1_PATH = writeTmp('latin.recipe', Buffer.from([0x63, 0x61, 0x66, 0xE9, 0x20, 0x72, 0x65, 0x63]));

const dialogCalls = [];
function installSystemDialogs(handler) {
  global.window.SystemDialogs = {
    async open(opts) {
      dialogCalls.push({ mode: 'open', opts });
      return handler(opts);
    },
    async save(opts) {
      dialogCalls.push({ mode: 'save', opts });
      return null;
    },
  };
}
function clearDialogCalls() { dialogCalls.length = 0; }

const APP_ID = 'com.jameswilloton230-ops.recipebox';

async function main() {
  // ── P1: nova:files:open accepts mixed MIME + extension lists ─────────────
  console.log('P1 — nova:files:open accept entries');
  {
    resetHost();
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: TXT_PATH, name: 'notes.txt', mimeType: 'text/plain', size: 15 }));

    // Exact payload shape Recipe Box's importer (js/importer.js) sends.
    const res = await call('nova:files:open', {
      title: 'Import recipes',
      accept: ['.json', '.recipe', '.txt', '.csv', '.md', 'text/plain', 'application/json', 'text/markdown', 'text/csv'],
    }, { appId: APP_ID });
    check('mixed accept list is accepted', !res.error, res.error ? `${res.error.code}: ${res.error.message}` : '');
    check('accept list reaches the dialog joined', dialogCalls.length === 1
      && /\.json/.test(dialogCalls[0].opts.accept || '')
      && /text\/plain/.test(dialogCalls[0].opts.accept || ''),
      JSON.stringify(dialogCalls[0]?.opts?.accept));

    // Backup-restore picker shape (js/settings.js).
    const res2 = await call('nova:files:open', {
      title: 'Import backup', accept: ['application/json', 'text/plain', '.json'],
    }, { appId: APP_ID });
    check('restore-backup accept list is accepted', !res2.error, res2.error ? `${res2.error.code}: ${res2.error.message}` : '');

    // Validation still rejects garbage entries and oversized lists.
    const bad = await call('nova:files:open', { accept: ['not a type'] }, { appId: APP_ID });
    check('garbage accept entry still rejected', bad.error && bad.error.code === 'INVALID_ARGS');
    const tooMany = await call('nova:files:open', { accept: Array.from({ length: 21 }, (_, i) => `.x${i}`) }, { appId: APP_ID });
    check('over-20 accept entries still rejected', tooMany.error && tooMany.error.code === 'INVALID_ARGS');
    const pureMime = await call('nova:files:open', { accept: ['text/plain', 'application/json'] }, { appId: APP_ID });
    check('pure MIME accept list unchanged', !pureMime.error);
  }

  // ── P2: nova:sysdialog:open multiple + array accept + files response ─────
  console.log('P2 — nova:sysdialog:open multiple / accept / response shape');
  {
    resetHost();
    clearDialogCalls();
    // Recipe Box photo picker shape (js/photos.js): multiple + array accept.
    installSystemDialogs(async (opts) => {
      if (opts.multiple !== true) return null; // bug repro: multiple must be forwarded
      return [
        { path: JPEG_PATH, name: 'photo.jpg', mimeType: 'image/jpeg', size: JPEG_BYTES.length },
        { path: JPEG2_PATH, name: 'photo2.jpg', mimeType: 'image/jpeg', size: JPEG_BYTES.length },
      ];
    });

    const res = await call('nova:sysdialog:open', {
      title: 'Choose photos',
      mode: 'open',
      multiple: true,
      accept: ['image/jpeg', 'image/png', 'image/webp'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    }, { appId: APP_ID });

    check('multiple pick resolves without error', !res.error, res.error ? `${res.error.code}: ${res.error.message}` : '');
    const result = res.result || {};
    const files = result.files;
    check('multiple pick returns a files array', Array.isArray(files) && files.length === 2, `files=${JSON.stringify(files && files.length)}`);
    check('file alias points at the first entry', result.file && files && result.file === files[0]);
    check('multiple: true is forwarded to SystemDialogs', dialogCalls.length === 1 && dialogCalls[0].opts.multiple === true,
      JSON.stringify(dialogCalls[0]?.opts));
    check('array accept is forwarded joined', /\.jpg|image\/jpeg/.test(String(dialogCalls[0]?.opts?.accept || '')),
      JSON.stringify(dialogCalls[0]?.opts?.accept));

    // Single-select response keeps its shape and gains files:[file].
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: TXT_PATH, name: 'notes.txt', mimeType: 'text/plain', size: 15 }));
    const single = await call('nova:sysdialog:open', { title: 'Open', accept: '.txt,text/plain' }, { appId: APP_ID });
    check('single pick still returns file', !single.error && single.result && single.result.file
      && single.result.file.name === 'notes.txt', JSON.stringify(single.error || single.result));
    check('single pick response includes files:[file]', Array.isArray(single.result.files)
      && single.result.files.length === 1 && single.result.files[0] === single.result.file);

    // String accept keeps working; bad array entries are rejected loudly.
    clearDialogCalls();
    installSystemDialogs(async () => null);
    const strAcc = await call('nova:sysdialog:open', { accept: 'image/jpeg' }, { appId: APP_ID });
    check('string accept still accepted', !strAcc.error && strAcc.result && strAcc.result.cancelled === true,
      JSON.stringify(strAcc.error || strAcc.result));
    const badArr = await call('nova:sysdialog:open', { accept: ['nope'] }, { appId: APP_ID });
    check('garbage array accept rejected with INVALID_ARGS', badArr.error && badArr.error.code === 'INVALID_ARGS',
      JSON.stringify(badArr.error));
  }

  // ── P3: picked-file content decoding (text vs base64) ────────────────────
  console.log('P3 — picked-file content: text vs base64');
  {
    resetHost();
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: RECIPE_PATH, name: 'pancakes.recipe', mimeType: 'application/octet-stream', size: recipeText.length }));

    const res = await call('nova:sysdialog:open', { title: 'Import recipe' }, { appId: APP_ID });
    check('unknown-ext UTF-8 text file reads without error', !res.error, JSON.stringify(res.error));
    const f = res.result && res.result.file;
    check('.recipe text file comes back as text (not base64)', f && f.content === recipeText,
      `content=${JSON.stringify(f && f.content && f.content.slice(0, 40))}`);
    check('.recipe text file has no base64 encoding marker', f && f.encoding === undefined, JSON.stringify(f && f.encoding));

    // Binary stays base64 with the encoding marker.
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: JPEG_PATH, name: 'photo.jpg', mimeType: 'image/jpeg', size: JPEG_BYTES.length }));
    const bin = await call('nova:sysdialog:open', { title: 'Photo' }, { appId: APP_ID });
    const bf = bin.result && bin.result.file;
    check('binary file stays base64', bf && bf.encoding === 'base64' && typeof bf.content === 'string'
      && Buffer.from(bf.content, 'base64').equals(JPEG_BYTES));

    // Non-UTF-8 text-ish bytes stay base64 (no lossy mojibake).
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: LATIN1_PATH, name: 'latin.recipe', mimeType: 'application/octet-stream', size: 8 }));
    const lat = await call('nova:sysdialog:open', { title: 'Latin' }, { appId: APP_ID });
    const lf = lat.result && lat.result.file;
    check('non-UTF-8 file stays base64 with marker', lf && lf.encoding === 'base64', JSON.stringify(lf && lf.encoding));

    // Same contract through nova:files:open (host-path branch).
    clearDialogCalls();
    installSystemDialogs(async () => ({ path: RECIPE_PATH, name: 'pancakes.recipe', mimeType: 'application/octet-stream', size: recipeText.length }));
    const viaFiles = await call('nova:files:open', { accept: ['.recipe'] }, { appId: APP_ID });
    const vf = viaFiles.result && viaFiles.result.file;
    check('nova:files:open returns .recipe as text too', !viaFiles.error && vf && vf.content === recipeText,
      JSON.stringify(viaFiles.error || (vf && vf.content && vf.content.slice(0, 30))));
  }

  // ── P4: multi-select file-count cap ──────────────────────────────────────
  console.log('P4 — multi-select cap');
  {
    resetHost();
    clearDialogCalls();
    installSystemDialogs(async (opts) => (opts.multiple === true
      ? Array.from({ length: 30 }, (_, i) => ({ path: TXT_PATH, name: `f${i}.txt`, mimeType: 'text/plain', size: 15 }))
      : null));
    const res = await call('nova:sysdialog:open', { multiple: true }, { appId: APP_ID });
    check('over-cap multi-select fails with LIMIT_REACHED', res.error && res.error.code === 'LIMIT_REACHED',
      JSON.stringify(res.error));
  }

  // ── P5: nova:dialog:open accept validation + matcher semantics ───────────
  console.log('P5 — nova:dialog:open accept contract');
  {
    resetHost();
    const matcher = AppSandbox._internal.pickerAcceptMatcher;
    check('matcher helper is exposed for tests', typeof matcher === 'function');

    // Extension + MIME semantics (mirrors SystemDialogs.acceptFilter).
    const m1 = matcher(['.txt', '.md', 'text/plain']);
    check('ext rules match by name suffix', m1 && m1('notes.txt', 'text/plain') === true
      && m1('notes.TXT', 'text/plain') === true);
    check('non-matching names are filtered out', m1 && m1('photo.jpg', 'image/jpeg') === false);
    check('octet-stream files pass MIME rules (cannot be ruled out)',
      m1 && m1('weird.recipe', 'application/octet-stream') === false === false
        && matcher(['text/plain'])('weird.recipe', 'application/octet-stream') === true);
    const m2 = matcher(['image/*']);
    check('type/* prefix rules match', m2 && m2('a.png', 'image/png') === true
      && m2('a.wav', 'audio/wav') === false);
    check('string accept form parses too', matcher('.txt,text/plain') !== null);
    check('empty/garbage accept yields no matcher (unfiltered)',
      matcher(undefined) === null && matcher([]) === null && matcher(',,,') === null);

    // Handler-level: invalid accept lists rejected before the dialog opens.
    const bad = await call('nova:dialog:open', { accept: ['not a type'] }, { appId: APP_ID });
    check('invalid dialog:open accept rejected with INVALID_ARGS',
      bad.error && bad.error.code === 'INVALID_ARGS', JSON.stringify(bad.error));
    const ok = await call('nova:dialog:open', { accept: ['.txt', '.md'] }, { appId: APP_ID });
    // The stub DOM cannot run the overlay to completion (the webview-hiding
    // loop needs element styles), so the meaningful contract here is that a
    // valid mixed list is NOT rejected with INVALID_ARGS like it would have
    // been under MIME-only validation.
    check('valid mixed dialog:open accept passes validation',
      !(ok.error && ok.error.code === 'INVALID_ARGS'), JSON.stringify(ok.error));
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
