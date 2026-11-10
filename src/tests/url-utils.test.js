import test from 'node:test';
import assert from 'node:assert/strict';
import { packageDownloadUrl, safeHttpsUrl } from '../url-utils.js';

const baseUrl = 'https://novabyteteam.github.io/novabyte-os/';

test('safeHttpsUrl accepts absolute and same-site relative HTTPS URLs', () => {
  assert.equal(
    safeHttpsUrl('https://cdn.example.com/app.novaapp', baseUrl),
    'https://cdn.example.com/app.novaapp',
  );
  assert.equal(
    safeHttpsUrl('apps/example.novaapp', baseUrl),
    'https://novabyteteam.github.io/novabyte-os/apps/example.novaapp',
  );
});

test('safeHttpsUrl rejects blank, malformed, credentialed, and non-HTTPS URLs', () => {
  for (const value of ['', '  ', 'http://[', 'http://example.com/file', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com/file']) {
    assert.equal(safeHttpsUrl(value, baseUrl), null, value);
  }
  assert.equal(safeHttpsUrl('/relative', 'not a base URL'), null);
});

test('packageDownloadUrl adds a download name only to storage object links', () => {
  assert.equal(
    packageDownloadUrl(
      'https://project.supabase.co/storage/v1/object/public/packages/app.novaapp?cache=1',
      'com.example-1.0.novaapp',
      baseUrl,
    ),
    'https://project.supabase.co/storage/v1/object/public/packages/app.novaapp?cache=1&download=com.example-1.0.novaapp',
  );
  assert.equal(
    packageDownloadUrl('apps/app.novaapp', 'app.novaapp', baseUrl),
    'https://novabyteteam.github.io/novabyte-os/apps/app.novaapp',
  );
  assert.equal(packageDownloadUrl('javascript:alert(1)', 'x', baseUrl), null);
});
