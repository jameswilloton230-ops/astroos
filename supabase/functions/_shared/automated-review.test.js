import assert from 'node:assert/strict';
import test from 'node:test';
import { runAutomatedReview } from './automated-review.js';

function packageWithFiles(files, manifest = {}) {
  return {
    novabyte_app: true,
    manifest: {
      id: 'com.example.test',
      name: 'Test App',
      version: '1.0.0',
      entry: 'index.html',
      ...manifest,
    },
    files: Object.fromEntries(Object.entries(files).map(([path, value]) => [
      path,
      Buffer.from(value).toString('base64'),
    ])),
  };
}

function review(pkg) {
  return runAutomatedReview(pkg, {
    appId: 'com.example.test',
    version: '1.0.0',
    now: '2026-10-19T00:00:00.000Z',
  });
}

test('passes structurally valid web app packages and records a human review checklist', () => {
  const report = review(packageWithFiles({
    'index.html': '<!doctype html><h1>Test</h1>',
    'app.js': 'document.querySelector("h1");',
  }));

  assert.equal(report.passed, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.manual_checks.length > 0, true);
  assert.equal(report.checked_at, '2026-10-19T00:00:00.000Z');
});

test('blocks dynamic code execution, remote scripts, and packaged binaries', () => {
  const pkg = packageWithFiles({
    'index.html': '<script src="https://cdn.example.com/app.js"></script>',
    'app.js': 'eval("alert(1)");',
    'payload.exe': 'not really an executable',
  });
  pkg.files['assets/not-an-exe.txt'] = Buffer.from([0x7f, 0x45, 0x4c, 0x46]).toString('base64');
  const report = review(pkg);

  assert.equal(report.passed, false);
  assert.deepEqual(
    new Set(report.errors.map(finding => finding.code)),
    new Set(['remote_script', 'dynamic_code', 'binary_file']),
  );
  assert.equal(report.errors.filter(finding => finding.code === 'binary_file').length, 2);
});

test('blocks unsafe package paths, missing entries, and mismatched versions', () => {
  const pkg = packageWithFiles({ '../outside.html': '<p>bad</p>' }, { version: '2.0.0' });
  const report = review(pkg);

  assert.equal(report.passed, false);
  assert.deepEqual(
    new Set(report.errors.map(finding => finding.code)),
    new Set(['manifest_version_mismatch', 'unsafe_file_path', 'missing_entry']),
  );
});

test('surfaces root, permission, and network concerns as human-review warnings', () => {
  const pkg = packageWithFiles({
    'index.html': '<script>fetch("https://api.example.com/data")</script>',
  }, {
    permissions: ['system:root'],
    permissionReasons: { 'system:root': 'Needs raw block-device access to verify disk images.' },
    unrestrictedEntry: 'root.js',
  });
  pkg.files['root.js'] = Buffer.from('/* privileged */').toString('base64');
  const report = review(pkg);

  assert.equal(report.passed, true);
  assert.deepEqual(
    new Set(report.warnings.map(finding => finding.code)),
    new Set(['network_reference', 'root_permission', 'permission_rationale']),
  );
});

test('rejects packages that declare permissions without permissionReasons', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>Test</h1>',
  }, {
    permissions: ['fs:access', 'notification:post'],
  }));

  assert.equal(report.passed, false);
  const missing = report.errors.filter(finding => finding.code === 'missing_permission_reasons');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /fs:access, notification:post/);
});

test('requires a reason for every declared permission, including optional ones', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>Test</h1>',
  }, {
    permissions: ['fs:access', 'notification:post'],
    optionalPermissions: ['network:fetch', 'fs:access'],
    permissionReasons: { 'fs:access': 'Saves documents the user picks.' },
  }));

  assert.equal(report.passed, false);
  const missing = report.errors.filter(finding => finding.code === 'missing_permission_reason');
  assert.deepEqual(
    new Set(missing.map(finding => finding.message)),
    new Set([
      'Permission "notification:post" has no entry in permissionReasons; every declared permission needs a short human-readable reason.',
      'Permission "network:fetch" has no entry in permissionReasons; every declared permission needs a short human-readable reason.',
    ]),
  );
  assert.equal(report.errors.some(finding => finding.message.includes('"fs:access"')), false);
});

test('rejects empty, non-string, and overlong permission reasons', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>Test</h1>',
  }, {
    permissions: ['fs:access', 'network:fetch', 'clipboard:read'],
    permissionReasons: {
      'fs:access': '   ',
      'network:fetch': 42,
      'clipboard:read': 'x'.repeat(501),
    },
  }));

  assert.equal(report.passed, false);
  assert.deepEqual(
    new Set(report.errors.map(finding => finding.code)),
    new Set(['missing_permission_reason', 'invalid_permission_reason', 'overlong_permission_reason']),
  );
  assert.equal(report.errors.filter(finding => finding.code === 'invalid_permission_reason').length, 2);
});

test('accepts legacy vfs:* reason keys for fs:* permissions', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>Test</h1>',
  }, {
    permissions: ['fs:access', 'fs:metadata'],
    permissionReasons: {
      'vfs:read': 'Opens documents the user picks.',
      'vfs:metadata': 'Shows file sizes in the open dialog.',
    },
  }));

  assert.equal(report.passed, true);
  assert.equal(report.errors.some(finding => finding.code.startsWith('missing_permission')), false);
  assert.equal(report.errors.some(finding => finding.code.startsWith('invalid_permission')), false);
});

test('does not require permissionReasons when no permissions are declared', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>Test</h1>',
  }));

  assert.equal(report.passed, true);
  assert.equal(report.errors.some(finding => finding.code.includes('permission_reason')), false);
});

test('rejects source files that are not valid UTF-8 instead of silently repairing them', () => {
  // 0xff 0xfe cannot appear in valid UTF-8; the fatal decoder must flag it.
  const pkg = packageWithFiles({
    'index.html': '<h1>ok</h1>',
  });
  pkg.files['broken.js'] = Buffer.concat([
    Buffer.from('const x = '),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(';\n'),
  ]).toString('base64');
  const report = review(pkg);
  assert.equal(report.passed, false);
  assert.ok(report.errors.some(finding => finding.code === 'invalid_text_encoding' && finding.file === 'broken.js'));
});

test('caps total findings so hostile packages cannot pin the reviewer with regex loops', () => {
  // 300 files × 50 eval matches each = 15,000 candidate findings; the review
  // must stop at the cap and return quickly.
  const files = { 'index.html': '<h1>ok</h1>' };
  const evalBomb = 'eval(1);\n'.repeat(50);
  for (let i = 0; i < 300; i++) files[`src/f${i}.js`] = evalBomb;
  const report = review(packageWithFiles(files));
  assert.equal(report.passed, false);
  assert.ok(report.errors.length <= 100, `expected a cap, got ${report.errors.length}`);
  assert.ok(report.warnings.length + report.errors.length <= 100);
});

test('flags timer-string execution and remote css imports', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>ok</h1>',
    'app.js': 'setTimeout("doEvil()", 100);',
    'style.css': '@import url(//evil.example.com/x.css);\nbody { color: red; }',
  }));
  assert.equal(report.passed, false);
  assert.deepEqual(
    new Set(report.errors.map(finding => finding.code)),
    new Set(['string_timer', 'remote_css_import']),
  );
});

test('validates unrestrictedEntry against packaged files', () => {
  const ok = review(packageWithFiles({
    'index.html': '<h1>ok</h1>',
    'root.js': '/* privileged */',
  }, { unrestrictedEntry: 'root.js' }));
  assert.equal(ok.passed, true);

  const missing = review(packageWithFiles({
    'index.html': '<h1>ok</h1>',
  }, { unrestrictedEntry: 'ghost.js' }));
  assert.equal(missing.passed, false);
  assert.ok(missing.errors.some(finding => finding.code === 'invalid_unrestricted_entry'));

  const traversal = review(packageWithFiles({
    'index.html': '<h1>ok</h1>',
  }, { unrestrictedEntry: '../outside.js' }));
  assert.equal(traversal.passed, false);
  assert.ok(traversal.errors.some(finding => finding.code === 'invalid_unrestricted_entry'));
});

test('blocks backslash and dot-segment file paths', () => {
  const report = review(packageWithFiles({
    'index.html': '<h1>ok</h1>',
    '..\\..\\windows\\evil.js': 'x',
    'a/./b.js': 'x',
    'a//b.js': 'x',
  }));
  assert.equal(report.passed, false);
  assert.equal(report.errors.filter(finding => finding.code === 'unsafe_file_path').length, 3);
});
