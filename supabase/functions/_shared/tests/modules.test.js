// Smoke test: every Edge Function action module must load under the Deno shim
// and export the full action surface the site's client depends on. This
// catches broken imports and syntax errors across the TypeScript sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../tests/deno-shim.mjs';

let publisherApiHandler;
globalThis.Deno.serve = handler => {
  publisherApiHandler = handler;
};

const publisher = await import('../publisher.ts');
const validation = await import('../validation.js');
globalThis.Deno.env.set('SUPABASE_URL', 'https://example.test');
globalThis.Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
await import('../../publisher-api/index.ts');
const studioPlugins = await import('../../publisher-api/studio-plugins.ts');
const communityTemplates = await import('../../publisher-api/community-templates.ts');

test('publisher-api returns CORS headers for unauthenticated requests', async () => {
  const response = await publisherApiHandler(new Request(
    'https://example.test/functions/v1/publisher-api',
    {
      method: 'POST',
      headers: { Origin: 'https://novabyteteam.github.io' },
      body: '{}',
    },
  ));

  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await response.json(), {
    error: 'Sign in with a verified email to continue.',
  });
});

test('publisher.ts exports the shared infrastructure surface', () => {
  for (const name of [
    'ADMIN_EMAIL', 'MAX_PACKAGE_BYTES', 'PUBLISHED_BUCKET', 'SUBMISSION_BUCKET',
    'TRUSTED_SIGNING_PUBLIC_X', 'PublisherError', 'corsHeaders', 'respond',
    'errorResponse', 'requiredEnv', 'rest', 'queryString', 'getUser',
    'requireAdmin', 'encodePath', 'storageRequest', 'downloadSubmission',
    'downloadSubmissionBytes', 'downloadPublishedPackage', 'deleteSubmissionQuietly',
    'makeSignedDownloadUrl', 'sendEmail', 'getAccountEmail', 'escapeHtml',
    'publicPackageUrl', 'signAndVerifyPackage', 'signPackageWithJwk',
    'fetchWithTimeout', 'patchStatusGuarded', 'countActiveSubmissions',
    'assertSubmissionQuota', 'assertNoActiveSubmission',
  ]) {
    assert.ok(name in publisher, `publisher.ts must export ${name}`);
  }
});

test('validation.js exports the pure rule surface', () => {
  for (const name of [
    'UUID_PATTERN', 'APP_ID_PATTERN', 'LISTING_ID_PATTERN', 'VERSION_PATTERN',
    'ACTIVE_SUBMISSION_STATUSES', 'WITHDRAWABLE_APP_STATUSES',
    'WITHDRAWABLE_LISTING_STATUSES', 'MAX_ACTIVE_SUBMISSIONS_PER_USER',
    'ValidationError', 'requiredText', 'assertSubmissionId', 'assertAppId',
    'assertListingId', 'parseVersion', 'compareVersions', 'validateLinks',
    'normalizeCategories', 'normalizeNewMetadata', 'isSafePackagePath',
    'isCanonicalBase64', 'assertSafePackageFiles', 'screenshotReferences',
    'packageScreenshots', 'preserveSubmissionScreenshots', 'missingPackageScreenshots',
    'readBoundedBody', 'readJsonBody', 'escapeHtml', 'toArrayBuffer',
  ]) {
    assert.ok(name in validation, `validation.js must export ${name}`);
  }
});

test('studio-plugins.ts and community-templates.ts export every action handler', () => {
  for (const name of [
    'submitStudioPlugin', 'myStudioPlugins', 'studioPluginReviewQueue',
    'uploadReviewedStudioPlugin', 'reviewStudioPlugin', 'withdrawStudioPlugin',
  ]) {
    assert.equal(typeof studioPlugins[name], 'function', `studio-plugins.ts ${name}`);
  }
  for (const name of [
    'submitCommunityTemplate', 'myCommunityTemplates', 'communityTemplateReviewQueue',
    'uploadReviewedCommunityTemplate', 'reviewCommunityTemplate', 'withdrawCommunityTemplate',
  ]) {
    assert.equal(typeof communityTemplates[name], 'function', `community-templates.ts ${name}`);
  }
});
