import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_ID_PATTERN,
  LISTING_ID_PATTERN,
  UUID_PATTERN,
  ValidationError,
  assertAppId,
  assertListingId,
  assertSafePackageFiles,
  assertSubmissionId,
  compareVersions,
  escapeHtml,
  isSafePackagePath,
  missingPackageScreenshots,
  normalizeCategories,
  normalizeNewMetadata,
  packageScreenshots,
  parseVersion,
  preserveSubmissionScreenshots,
  readBoundedBody,
  readJsonBody,
  requiredText,
  screenshotReferences,
  toArrayBuffer,
  validateLinks,
} from '../validation.js';

// ── Submission IDs ──────────────────────────────────────────────────────────

test('accepts canonical UUIDs of either case and rejects look-alikes', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(assertSubmissionId(uuid), uuid);
  assert.equal(assertSubmissionId(uuid.toUpperCase()), uuid.toUpperCase());
  for (const bad of ['not-a-uuid', '123e4567e89b42d3a456426614174000', `${uuid}\`; DROP TABLE x`, '', null, 42, { id: uuid }]) {
    assert.throws(() => assertSubmissionId(bad), ValidationError);
  }
});

test('assertSubmissionId rejects filter-operator payloads before PostgREST sees them', () => {
  // These previously reached the database as eq.<value> filters; the UUID
  // guard must stop them at the door.
  for (const injection of [
    '123e4567-e89b-42d3-a456-426614174000,',
    '123e4567-e89b-42d3-a456-426614174000)&status=eq.published',
    '123e4567-e89b-42d3-a456-4266141740' + '00 or 1=1',
  ]) {
    assert.throws(() => assertSubmissionId(injection), /Invalid submission ID/);
  }
});

// ── Listing IDs ─────────────────────────────────────────────────────────────

test('app and listing IDs accept reverse-domain ids and reject traversal shapes', () => {
  for (const good of ['com.example.app', 'webapp_notes', 'a.b', 'org.novabyte.tools', 'tool-42', 'x.y-z']) {
    assert.equal(APP_ID_PATTERN.test(good), true, good);
  }
  for (const listingGood of ['com.example.plugin', 'tool-42', 'x.y-z']) {
    assert.equal(LISTING_ID_PATTERN.test(listingGood), true, listingGood);
  }
  // Underscores are valid for app IDs but not for plugin/template IDs
  // (matches the original catalog constraints).
  assert.equal(LISTING_ID_PATTERN.test('webapp_notes'), false);
  for (const bad of ['..', 'a..', '.a', 'a..b', 'com.', '-bad', 'Bad', 'a/b', 'a\\b', '', 'a b']) {
    assert.equal(APP_ID_PATTERN.test(bad), false, bad);
    assert.equal(LISTING_ID_PATTERN.test(bad), false, bad);
  }
  assert.equal(assertAppId('com.example.app'), 'com.example.app');
  assert.equal(assertListingId('com.example.plugin', 'Template ID'), 'com.example.plugin');
  assert.throws(() => assertAppId('a..'), /may contain/);
  assert.throws(() => assertListingId('a..', 'Template ID'), /Template ID must use/);
});

// ── Semver ──────────────────────────────────────────────────────────────────

test('compareVersions orders core, prerelease, and build metadata correctly', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('2.0.0', '1.999.999'), 1);
  // Prerelease sorts before release.
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  // Numeric identifiers compare numerically, not lexically.
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1);
  // Build metadata is ignored for precedence.
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0);
  for (const bad of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-', '1.0.0-alpha..1', 'not-a-version']) {
    assert.throws(() => parseVersion(bad), ValidationError, bad);
  }
});

// ── requiredText ────────────────────────────────────────────────────────────

test('requiredText trims, enforces bounds, and rejects non-strings', () => {
  assert.equal(requiredText('  hello  ', 'Label', 10), 'hello');
  assert.equal(requiredText('ab', 'Label', 10, 2), 'ab');
  assert.throws(() => requiredText('a', 'Label', 10, 2), /between 2 and 10/);
  assert.throws(() => requiredText('a'.repeat(11), 'Label', 10), /between 1 and 10/);
  assert.throws(() => requiredText(undefined, 'Label', 10), /required/);
  assert.throws(() => requiredText(42, 'Label', 10), /required/);
});

// ── Links ───────────────────────────────────────────────────────────────────

test('validateLinks keeps https website/source/support links and rejects unsafe schemes', () => {
  assert.deepEqual(
    validateLinks({
      website: 'https://example.com/',
      source: ' https://github.com/NovaByteTeam/novabyte-os ',
      evil: 'https://evil.example.com',
    }),
    { website: 'https://example.com/', source: 'https://github.com/NovaByteTeam/novabyte-os' },
  );
  // Unknown keys are ignored, but a known key with a bad URL is a hard error.
  assert.deepEqual(validateLinks(null), {});
  assert.deepEqual(validateLinks(['https://example.com']), {});
  assert.deepEqual(validateLinks({ tracking: 'https://x.example.com' }), {});
  assert.throws(() => validateLinks({ website: 'http://insecure.example.com' }), /must use HTTPS/);
  assert.throws(() => validateLinks({ support: 'ftp://example.com' }), /must use HTTPS/);
  assert.throws(() => validateLinks({ source: 'javascript:alert(1)' }), /must use HTTPS/);
  assert.throws(() => validateLinks({ website: 'not a url' }), /valid HTTPS URL/);
});

// ── Categories ──────────────────────────────────────────────────────────────

test('normalizeCategories lowercases, slugifies, and dedupes', () => {
  assert.deepEqual(normalizeCategories(['Productivity', ' productIVITY ', 'file_manager', 'dev-tools']),
    ['productivity', 'file-manager', 'dev-tools']);
  assert.throws(() => normalizeCategories(['ok', 42]), /text values/);
  assert.throws(() => normalizeCategories(['a'.repeat(33)]), /lowercase letters, numbers/);
  assert.throws(() => normalizeCategories(['bad_category!']), /lowercase letters, numbers/);
});

// ── New listing metadata ────────────────────────────────────────────────────

test('normalizeNewMetadata validates a full listing and rejects malformed ones', () => {
  const valid = {
    appId: 'com.example.app',
    name: 'Example App',
    author: 'Example Publisher',
    version: '1.2.3',
    description: 'A description that is long enough.',
    categories: ['utilities'],
    links: { website: 'https://example.com' },
    changelog: 'First release.',
  };
  const normalized = normalizeNewMetadata(valid);
  assert.equal(normalized.appId, 'com.example.app');
  assert.equal(normalized.links.website, 'https://example.com/');

  assert.throws(() => normalizeNewMetadata({ ...valid, name: 'x' }), /App name/);
  assert.throws(() => normalizeNewMetadata({ ...valid, appId: 'a..b' }), /App ID/);
  assert.throws(() => normalizeNewMetadata({ ...valid, version: 'banana' }), /semantic version/);
  assert.throws(() => normalizeNewMetadata({ ...valid, description: 'too short' }), /Description/);
  assert.throws(() => normalizeNewMetadata({ ...valid, categories: [] }), /one and eight/);
  assert.throws(() => normalizeNewMetadata({ ...valid, changelog: 'no' }), /Release notes/);
});

// ── Package file maps ───────────────────────────────────────────────────────

test('isSafePackagePath blocks traversal, absolute, and control-character paths', () => {
  for (const good of ['index.html', 'assets/app.js', 'screenshots/a.b.png', 'a/b/c/d.txt']) {
    assert.equal(isSafePackagePath(good), true, good);
  }
  for (const bad of [
    '../escape', 'a/../../escape', '/absolute', 'a//b', 'a/./b', 'a/b/..',
    'back\\slash', '', 'a\0b', 'a/'.repeat(300) + 'x',
  ]) {
    assert.equal(isSafePackagePath(bad), false, bad);
  }
});

test('assertSafePackageFiles rejects non-base64 payloads and non-object file maps', () => {
  const pkg = { files: { 'index.html': 'PCFET0NUWVBFIGh0bWw+' } };
  assert.equal(assertSafePackageFiles(pkg).length, 1);
  assert.throws(() => assertSafePackageFiles({ files: {} }), /no files/);
  assert.throws(() => assertSafePackageFiles({ files: [] }), /valid file map/);
  assert.throws(() => assertSafePackageFiles({ files: null }), /valid file map/);
  assert.throws(() => assertSafePackageFiles({ files: { '../evil': 'AAAA' } }), /unsafe path/);
  assert.throws(() => assertSafePackageFiles({ files: { 'ok.txt': 'not base64!' } }), /invalid file/);
  assert.throws(() => assertSafePackageFiles({ files: { 'ok.txt': '' } }), /invalid file/);
});

// ── Screenshots ─────────────────────────────────────────────────────────────

test('screenshot validation enforces the five-screenshot and packaged-file rules', () => {
  const base64Png = 'iVBORw0KGgo=';
  const pkg = {
    manifest: { screenshots: ['screenshots/a.png'] },
    files: { 'screenshots/a.png': base64Png },
  };
  assert.deepEqual(packageScreenshots(pkg), ['screenshots/a.png']);
  assert.deepEqual(packageScreenshots({ manifest: {}, files: {} }), []);

  // Data-URI and https screenshots do not need packaged files.
  assert.deepEqual(
    screenshotReferences({ manifest: { screenshots: ['https://example.com/a.png', `data:image/png;base64,${base64Png}`] }, files: {} }),
    ['https://example.com/a.png', `data:image/png;base64,${base64Png}`],
  );

  assert.throws(() => screenshotReferences({ manifest: { screenshots: ['a', 'b', 'c', 'd', 'e', 'f'] }, files: {} }), /no more than five/);
  assert.throws(() => screenshotReferences({ manifest: { screenshots: [42] }, files: {} }), /invalid screenshot/);
  assert.throws(() => packageScreenshots({ manifest: { screenshots: ['screenshots/missing.png'] }, files: {} }), /missing screenshot file/);
  assert.throws(() => packageScreenshots({ manifest: { screenshots: ['screenshots/../escape.png'] }, files: {} }), /missing screenshot file/);
});

test('missingPackageScreenshots reports only packaged-path screenshots absent from files', () => {
  const pkg = {
    manifest: { screenshots: ['screenshots/kept.png', 'screenshots/gone.png', 'https://ok.example/s.png'] },
    files: { 'screenshots/kept.png': 'AAAA' },
  };
  assert.deepEqual(missingPackageScreenshots(pkg), ['screenshots/gone.png']);
});

test('preserveSubmissionScreenshots backfills reviewed packages from the submission', () => {
  const submitted = {
    manifest: { screenshots: ['screenshots/a.png'] },
    files: { 'index.html': 'PGgxPmhpPC9oMT4=', 'screenshots/a.png': 'QUFBQQ==' },
  };
  // Reviewed package keeps the screenshot reference but ships no image data
  // (screenshots are stripped before review uploads).
  const reviewed = {
    manifest: { screenshots: ['screenshots/a.png'] },
    files: { 'index.html': 'PGgxPmhpPC9oMT4=' },
  };
  preserveSubmissionScreenshots(submitted, reviewed);
  assert.equal(reviewed.files['screenshots/a.png'], 'QUFBQQ==');
  assert.deepEqual(reviewed.manifest.screenshots, ['screenshots/a.png']);

  // Submitted screenshots missing from the reviewed list are merged in so the
  // published listing does not lose images.
  const reviewedFresh = {
    manifest: { screenshots: [] },
    files: { 'index.html': 'PGgxPmhpPC9oMT4=' },
  };
  preserveSubmissionScreenshots(submitted, reviewedFresh);
  assert.deepEqual(reviewedFresh.manifest.screenshots, ['screenshots/a.png']);
  assert.equal(reviewedFresh.files['screenshots/a.png'], 'QUFBQQ==');

  // A reviewed package referencing a screenshot that exists nowhere fails.
  const broken = {
    manifest: { screenshots: ['screenshots/ghost.png'] },
    files: {},
  };
  assert.throws(() => preserveSubmissionScreenshots(submitted, broken), /missing screenshot file/);
});

// ── Request bodies ──────────────────────────────────────────────────────────

test('readBoundedBody enforces the byte cap on real streamed bodies', async () => {
  const makeRequest = bytes => new Request('https://api.example/', {
    method: 'POST',
    body: bytes,
    headers: { 'content-length': String(bytes.byteLength) },
  });

  const ok = await readBoundedBody(makeRequest(new Uint8Array(1024).fill(65)), 2048, 'Payload');
  assert.equal(ok.byteLength, 1024);

  // Streams 8 KB in 1 KB chunks past a 4 KB cap — the reader must be cancelled.
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(1024).fill(66));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    () => readBoundedBody(new Request('https://api.example/', { method: 'POST', body: stream, duplex: 'half' }), 4096, 'Payload'),
    /no larger than/,
  );
  assert.equal(cancelled, true, 'the stream should be cancelled once the cap is exceeded');

  // A missing content-length header is fine: the streamed size decides.
  const small = new Uint8Array(10);
  const noHeader = await readBoundedBody(new Request('https://api.example/', {
    method: 'POST',
    body: small,
    duplex: 'half',
  }), 4096, 'Payload');
  assert.equal(noHeader.byteLength, 10);

  await assert.rejects(
    () => readBoundedBody(new Request('https://api.example/', { method: 'POST' }), 10, 'Payload'),
    /is required/,
  );
});

test('readJsonBody returns parsed JSON and maps malformed bodies to validation errors', async () => {
  const json = await readJsonBody(new Request('https://api.example/', {
    method: 'POST',
    body: JSON.stringify({ action: 'my-apps' }),
  }));
  assert.deepEqual(json, { action: 'my-apps' });

  await assert.rejects(() => readJsonBody(new Request('https://api.example/', {
    method: 'POST',
    body: '{invalid json',
  })), /valid JSON/);
  await assert.rejects(() => readJsonBody(new Request('https://api.example/', { method: 'POST', body: '' })), /JSON request body/);
});

// ── escapeHtml ──────────────────────────────────────────────────────────────

test('escapeHtml neutralizes every HTML-significant character including quotes', () => {
  assert.equal(
    escapeHtml(`<img src=x onerror="a('b')">&`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
  );
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('toArrayBuffer copies the bytes into the new buffer, not a zero-filled one', () => {
  const source = new Uint8Array([123, 34, 102, 125]);
  const buffer = toArrayBuffer(source);
  assert.deepEqual([...new Uint8Array(buffer)], [123, 34, 102, 125]);
  source[0] = 0;
  assert.equal(new Uint8Array(buffer)[0], 123, 'must be an independent copy');
  const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
  assert.deepEqual([...new Uint8Array(toArrayBuffer(view))], [2, 3, 4]);
});
