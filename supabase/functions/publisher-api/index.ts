// NovaByte publisher-api — apps, Studio plugins, and community templates.
//
// Hardening changes in this revision (see the audit report for detail):
// - Every submission ID is UUID-validated before it reaches PostgREST.
// - Withdraw actions PATCH with a status guard, closing the race where a
//   concurrent publish could leave a live catalog app marked "withdrawn".
// - Reviewed-package uploads stream through readBoundedBody instead of
//   buffering request.arrayBuffer() on a client-controlled size.
// - Per-user active submission caps stop queue flooding and email bombs.
// - Failed submissions clean up their uploaded package from storage.
// - Malformed JSON bodies return 400 instead of a 500 "unexpected error".
// - The review queue degrades per-row (unknown owner email or a failed signed
//   URL no longer blanks the entire queue for the reviewer).
import {
  ADMIN_EMAIL,
  MAX_PACKAGE_BYTES,
  PUBLISHED_BUCKET,
  SUBMISSION_BUCKET,
  PublisherError,
  assertNoActiveSubmission,
  assertSubmissionQuota,
  corsHeaders,
  deleteSubmissionQuietly,
  downloadPublishedPackage,
  downloadSubmission,
  errorResponse,
  fetchWithTimeout,
  getAccountEmail,
  getUser,
  makeSignedDownloadUrl,
  patchStatusGuarded,
  publicPackageUrl,
  queryString,
  requireAdmin,
  requiredEnv,
  respond,
  rest,
  sendEmail,
  signAndVerifyPackage,
  storageRequest,
} from '../_shared/publisher.ts';
import {
  ACTIVE_SUBMISSION_STATUSES,
  WITHDRAWABLE_APP_STATUSES,
  assertSafePackageFiles,
  assertSubmissionId,
  compareVersions,
  escapeHtml,
  missingPackageScreenshots,
  normalizeNewMetadata,
  packageScreenshots,
  parseVersion,
  preserveSubmissionScreenshots,
  readBoundedBody,
  readJsonBody,
  requiredText,
} from '../_shared/validation.js';
import { runAutomatedReview } from '../_shared/automated-review.js';
import { MAX_TEMPLATE_UPLOAD_BYTES } from '../_shared/community-template.js';
import {
  myStudioPlugins,
  reviewStudioPlugin,
  studioPluginReviewQueue,
  submitStudioPlugin,
  uploadReviewedStudioPlugin,
  withdrawStudioPlugin,
} from './studio-plugins.ts';
import {
  communityTemplateReviewQueue,
  myCommunityTemplates,
  reviewCommunityTemplate,
  submitCommunityTemplate,
  uploadReviewedCommunityTemplate,
  withdrawCommunityTemplate,
} from './community-templates.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const STATIC_CATALOG_URL = Deno.env.get('PUBLIC_CATALOG_URL')
  || 'https://novabyteteam.github.io/novabyte-os/apps.json';

function imageDataUri(pkg: Record<string, any>, value: unknown) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(value)) return value;
  const encoded = pkg.files?.[value];
  if (typeof encoded !== 'string') return null;
  const extension = value.split('.').pop()?.toLowerCase();
  const mime = extension === 'svg' ? 'image/svg+xml'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'gif' ? 'image/gif'
    : extension === 'webp' ? 'image/webp'
    : extension === 'png' ? 'image/png'
    : null;
  return mime ? `data:${mime};base64,${encoded}` : null;
}

async function loadStaticAppIds() {
  let response: Response;
  try {
    response = await fetchWithTimeout(STATIC_CATALOG_URL, { cache: 'no-store' }, 10_000);
  } catch (error) {
    console.error('[publisher-api] Static catalog lookup failed:', error);
    throw new PublisherError('Could not confirm whether this app ID is already in use. Try again later.', 502);
  }
  if (!response.ok) throw new PublisherError('Could not confirm whether this app ID is already in use.', 502);
  const catalog: unknown = await response.json();
  if (!Array.isArray(catalog)) throw new PublisherError('The current app catalog is invalid.', 502);
  return new Set(catalog.flatMap(app => app && typeof app.id === 'string' ? [app.id] : []));
}

async function getOne(table: string, key: string, value: string) {
  const result = await rest(table, {
    query: queryString({ select: '*', [key]: `eq.${value}`, limit: '1' }),
  });
  return Array.isArray(result) ? result[0] || null : null;
}

async function submit(user: { id: string; email?: string }, body: Record<string, unknown>) {
  const id = assertSubmissionId(body.submissionId);
  const submission = body.submission as Record<string, unknown> | undefined;
  if (!submission || typeof submission !== 'object') throw new PublisherError('Submission details are required.');
  const packagePath = requiredText(submission.packagePath, 'Package upload', 160);
  if (packagePath !== `${user.id}/${id}.novaapp`) throw new PublisherError('The uploaded package does not belong to this account.');

  const type = submission.type === 'update' ? 'update' : submission.type === 'new' ? 'new' : null;
  if (!type) throw new PublisherError('Submission type must be new or update.');
  // Common identity fields, validated once here; full listing validation only
  // runs for new apps (updates keep the published listing metadata).
  const appId = requiredText(submission.appId, 'App ID', 120, 2);
  const version = requiredText(submission.version, 'Version', 40);
  parseVersion(version);
  const changelog = requiredText(submission.changelog, 'Release notes', 4000, 3);

  const existingOwner = await getOne('publisher_app_owners', 'app_id', appId);
  let publishedApp: Record<string, any> | null = null;
  let metadata: Record<string, unknown>;

  try {
    await assertSubmissionQuota('publisher_submissions', user.id);

    if (type === 'new') {
      if (existingOwner) throw new PublisherError('That app ID is already published.');
      const staticIds = await loadStaticAppIds();
      if (staticIds.has(appId)) throw new PublisherError('That app ID is already used in the public catalog.');
      await assertNoActiveSubmission(
        'publisher_submissions', 'app_id', appId, 'This app already has a submission awaiting review.',
      );
      const normalized = normalizeNewMetadata(submission);
      if (normalized.appId !== appId || normalized.version !== version || normalized.changelog !== changelog) {
        throw new PublisherError('App details changed during submission. Refresh and try again.');
      }
      metadata = {
        name: normalized.name,
        author: normalized.author,
        description: normalized.description,
        categories: normalized.categories,
        links: normalized.links,
      };
    } else {
      if (!existingOwner || existingOwner.owner_id !== user.id) {
        throw new PublisherError('You can submit updates only for apps you own.');
      }
      publishedApp = await getOne('publisher_catalog_apps', 'app_id', appId);
      if (!publishedApp) throw new PublisherError('This app is not currently published.');
      if (compareVersions(version, publishedApp.version) !== 1) {
        throw new PublisherError('An update must use a version newer than the currently published version.');
      }
      await assertNoActiveSubmission(
        'publisher_submissions', 'app_id', appId, 'This app already has an update awaiting review.',
      );
      // Optional listing description override: the portal sends the edited description on
      // updates (blank means keep the current one). Accept it with the same validation as
      // new submissions so the published listing actually reflects the new text.
      const submittedDescription = typeof submission.description === 'string' && submission.description.trim()
        ? requiredText(submission.description, 'Description', 1000, 20)
        : null;
      metadata = {
        name: publishedApp.name,
        author: publishedApp.author,
        description: submittedDescription ?? publishedApp.description,
        categories: publishedApp.categories,
        links: publishedApp.links,
      };
    }

    const { pkg } = await downloadSubmission(packagePath);
    if (pkg.novabyte_app !== true || !pkg.manifest || pkg.manifest.id !== appId) {
      throw new PublisherError('The package manifest ID does not match this submission.');
    }
    if (pkg.manifest.version !== version) throw new PublisherError('The package manifest version does not match this submission.');
    assertSafePackageFiles(pkg);
    if (type === 'update' && publishedApp) {
      const missingScreenshots = missingPackageScreenshots(pkg);
      if (missingScreenshots.length) {
        const previousPackage = await downloadPublishedPackage(`${appId}/${publishedApp.version}.novaapp`);
        for (const screenshot of missingScreenshots) {
          const image = previousPackage.pkg.files?.[screenshot];
          if (typeof image === 'string') pkg.files[screenshot] = image;
        }
      }
    }
    packageScreenshots(pkg);
    const submissionByteLength = new TextEncoder().encode(JSON.stringify(pkg)).byteLength;
    if (submissionByteLength > MAX_PACKAGE_BYTES) throw new PublisherError('The package exceeds the 25 MB upload limit.');

    const automatedReview = runAutomatedReview(pkg, { appId, version });
    // Failed checks still go to the human review queue (flagged via automated_review.passed).
    // Approval re-runs the checks on the reviewed package, so nothing failing publishes as-is.
    await rest('publisher_submissions', {
      method: 'POST',
      body: {
        id,
        owner_id: user.id,
        app_id: appId,
        type,
        version,
        metadata,
        changelog,
        package_path: packagePath,
        status: 'pending',
        automated_review: automatedReview,
      },
      prefer: 'return=minimal',
    });
    const findingsHtml = automatedReview.errors.map(finding => `<li>${escapeHtml(finding.message)}</li>`).join('');
    if (!automatedReview.passed) {
      // Best effort: tell the publisher what was flagged. The reviewer is emailed below regardless.
      await sendEmail(
        user.email || '',
        `NovaByte app flagged by automated checks: ${appId} v${version}`,
        `<p>Automated checks flagged issues. Your submission has still been sent for human review, but it can't be published until they're fixed.</p><ul>${findingsHtml}</ul><p>You can update your package and submit it again.</p>`,
      );
    }

    const notification = await sendEmail(
      ADMIN_EMAIL,
      `Automated checks ${automatedReview.passed ? 'passed' : 'FAILED'}: ${String(metadata.name)} v${version}`,
      `<p>${automatedReview.passed
        ? "Automated checks passed. A verified publisher's app is ready for human review."
        : 'Automated checks failed, but the submission was sent for your review anyway.'}</p>${automatedReview.passed ? '' : `<ul>${findingsHtml}</ul>`}<p><strong>${escapeHtml(metadata.name)}</strong> (${escapeHtml(appId)}) v${escapeHtml(version)}</p><p>Publisher account: ${escapeHtml(user.email || 'unknown')}</p><p>Type: ${escapeHtml(type)}</p><p>Changelog: ${escapeHtml(changelog)}</p><p>Open the NovaByte Publisher Portal and select Review Apps.</p>`,
    );
    return {
      submitted: true,
      automatedReview,
      notificationSent: notification.sent,
      notificationError: notification.sent ? undefined : notification.reason,
    };
  } catch (error) {
    // The client uploaded the package before calling submit; whatever made
    // this call fail, no database row references that file anymore.
    await deleteSubmissionQuietly(packagePath);
    throw error;
  }
}

async function myApps(user: { id: string }) {
  const [owners, submissions] = await Promise.all([
    rest('publisher_app_owners', {
      query: queryString({ select: 'app_id,created_at', owner_id: `eq.${user.id}`, order: 'created_at.desc' }),
    }),
    rest('publisher_submissions', {
      query: queryString({
        select: 'id,app_id,type,version,metadata,changelog,status,review_note,automated_review,created_at,reviewed_at',
        owner_id: `eq.${user.id}`,
        status: 'neq.withdrawn',
        order: 'created_at.desc',
      }),
    }),
  ]);
  const ids = Array.isArray(owners) ? owners.map(row => row.app_id).filter((id): id is string => typeof id === 'string') : [];
  const apps = ids.length
    ? await rest('publisher_catalog_apps', {
      query: queryString({ select: '*', app_id: `in.(${ids.join(',')})` }),
    })
    : [];
  return { apps: Array.isArray(apps) ? apps : [], submissions: Array.isArray(submissions) ? submissions : [] };
}

async function reviewQueue(user: { email?: string }) {
  requireAdmin(user);
  const rows = await rest('publisher_submissions', {
    query: queryString({
      select: 'id,owner_id,app_id,type,version,metadata,changelog,status,automated_review,safety_rating,created_at,package_path,review_package_path',
      status: `in.(${ACTIVE_SUBMISSION_STATUSES.join(',')})`,
      order: 'created_at.asc',
    }),
  });
  // Per-row fallbacks: one account whose email lookup fails (or one bad
  // storage path) must not blank the whole reviewer queue.
  const submissions = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => ({
    ...row,
    owner_email: await getAccountEmail(row.owner_id).catch(error => {
      console.error('[publisher-api] Could not resolve owner email for review queue:', error);
      return null;
    }),
    download_url: await makeSignedDownloadUrl(
      row.package_path,
      `${row.app_id}-${row.version}.novaapp`,
    ).catch(error => {
      console.error('[publisher-api] Could not create review download link:', error);
      return null;
    }),
    has_reviewed_package: Boolean(row.review_package_path),
  })));
  return { submissions };
}

async function hostedAppsForReview(user: { email?: string }) {
  requireAdmin(user);
  const apps = await rest('publisher_catalog_apps', {
    query: queryString({
      select: 'app_id,name,version,author,published_at',
      order: 'published_at.desc',
    }),
  });
  return { apps: Array.isArray(apps) ? apps : [] };
}

async function publishSubmission(submission: Record<string, any>) {
  const metadata = submission.metadata || {};
  const packagePath = submission.review_package_path || submission.package_path;
  const { pkg, byteLength } = await downloadSubmission(packagePath);
  if (pkg.novabyte_app !== true || pkg.manifest?.id !== submission.app_id || pkg.manifest?.version !== submission.version) {
    throw new PublisherError('The package no longer matches the reviewed app ID and version.');
  }

  pkg.manifest = {
    ...pkg.manifest,
    id: submission.app_id,
    name: metadata.name,
    author: metadata.author,
    description: metadata.description,
    version: submission.version,
    categories: metadata.categories,
    links: metadata.links,
    releaseNotes: submission.changelog,
  };
  const signedPackage = await signAndVerifyPackage(pkg);
  const previous = await getOne('publisher_catalog_apps', 'app_id', submission.app_id);
  if (submission.type === 'new') {
    if (previous) throw new PublisherError('This app ID was published by another account while this submission was under review.');
    if ((await loadStaticAppIds()).has(submission.app_id)) {
      throw new PublisherError('This app ID was added to the public catalog while the submission was under review.');
    }
  }
  if (submission.type === 'update') {
    if (!previous) throw new PublisherError('The app is no longer published.');
    if (compareVersions(submission.version, previous.version) !== 1) {
      throw new PublisherError('The submitted update is no longer newer than the published version.');
    }
  }

  const path = `${submission.app_id}/${submission.version}.novaapp`;
  const packageBody = JSON.stringify(signedPackage);
  if (new TextEncoder().encode(packageBody).byteLength > MAX_PACKAGE_BYTES) {
    throw new PublisherError('The signed package exceeds the 25 MB publishing limit.');
  }
  await storageRequest(PUBLISHED_BUCKET, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: packageBody,
  });

  const date = new Date().toISOString().slice(0, 10);
  const versionHistory = [
    ...(Array.isArray(previous?.version_history) ? previous.version_history : []),
    { version: submission.version, date, notes: submission.changelog },
  ].slice(-50);
  const appRow = {
    app_id: submission.app_id,
    name: metadata.name,
    version: submission.version,
    author: metadata.author,
    description: metadata.description,
    categories: metadata.categories,
    icon: imageDataUri(signedPackage, signedPackage.manifest.icon),
    file: publicPackageUrl(path),
    size: `${Math.max(1, Math.round(byteLength / 1024))} KB`,
    screenshots: Array.isArray(signedPackage.manifest.screenshots)
      ? signedPackage.manifest.screenshots.filter((item: unknown) => typeof item === 'string')
      : [],
    links: metadata.links || {},
    release_notes: submission.changelog,
    version_history: versionHistory,
    published_at: new Date().toISOString(),
  };
  await rest('rpc/commit_publisher_publish', {
    method: 'POST',
    body: { p_submission_id: submission.id, p_app: appRow },
    prefer: 'return=minimal',
  });
  return appRow;
}

async function review(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const id = assertSubmissionId(body.submissionId);
  const decision = body.decision;
  const note = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 2000) : '';
  if (!['publish', 'reject', 'request-changes'].includes(String(decision))) {
    throw new PublisherError('Choose publish, reject, or request-changes.');
  }
  if (decision !== 'publish' && !note) throw new PublisherError('Add a reviewer note before requesting changes or rejecting.');
  // Optional for reject/request-changes, required to publish.
  const safetyRating = body.safetyRating === undefined || body.safetyRating === null
    ? null
    : Number(body.safetyRating);
  if (safetyRating !== null && (!Number.isInteger(safetyRating) || safetyRating < 1 || safetyRating > 100)) {
    throw new PublisherError('The safety confidence rating must be a whole number from 1 to 100.');
  }
  if (decision === 'publish' && safetyRating === null) {
    throw new PublisherError('Set a safety confidence rating before publishing.');
  }
  const submission = await getOne('publisher_submissions', 'id', id);
  if (!submission || !ACTIVE_SUBMISSION_STATUSES.includes(submission.status)) {
    throw new PublisherError('This submission is no longer awaiting review.', 404);
  }
  if (decision === 'publish') {
    if (!submission.review_package_path) {
      throw new PublisherError('Upload the inspected .novaapp package before approving this submission.');
    }
    // Saved before publishing so a failed publish doesn't lose the reviewer's rating.
    await rest('publisher_submissions', {
      method: 'PATCH',
      query: queryString({ id: `eq.${id}` }),
      body: { safety_rating: safetyRating },
      prefer: 'return=minimal',
    });
    await publishSubmission(submission);
  } else {
    await patchStatusGuarded('publisher_submissions', id, ACTIVE_SUBMISSION_STATUSES, {
      status: decision === 'reject' ? 'rejected' : 'changes_requested',
      reviewed_at: new Date().toISOString(),
      review_note: note,
      ...(safetyRating !== null ? { safety_rating: safetyRating } : {}),
    });
  }
  const recipient = await getAccountEmail(submission.owner_id);
  const label = decision === 'publish' ? 'published' : decision === 'reject' ? 'rejected' : 'needs changes';
  const notification = await sendEmail(
    recipient,
    `NovaByte app ${label}: ${submission.app_id} v${submission.version}`,
    `<p>Your submission for <strong>${escapeHtml(submission.app_id)}</strong> v${escapeHtml(submission.version)} was ${escapeHtml(label)}.</p>${note ? `<p>Reviewer note: ${escapeHtml(note)}</p>` : ''}${decision === 'publish' ? '<p>Your app is now available in the NovaByte catalog.</p>' : '<p>Sign in to My Apps to see the review status.</p>'}`,
  );
  return { reviewed: true, notificationSent: notification.sent, notificationError: notification.sent ? undefined : notification.reason };
}

async function removePublishedApp(appId: string) {
  const matching = await rest('publisher_catalog_apps', {
    query: queryString({ select: 'app_id', app_id: `eq.${appId}` }),
  });
  if (!Array.isArray(matching) || !matching.length) throw new PublisherError('This app is not currently published.', 404);

  const listResponse = await fetchWithTimeout(`${SUPABASE_URL}/storage/v1/object/list/${PUBLISHED_BUCKET}`, {
    method: 'POST',
    headers: {
      apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix: `${appId}/`, limit: 1000 }),
  });
  const objects = await listResponse.json();
  if (!listResponse.ok) {
    console.error('[publisher-api] Could not list packages for removal:', objects);
    throw new PublisherError('Could not remove the published packages. The catalog entry remains available.', 502);
  }
  const paths = Array.isArray(objects)
    ? objects.filter(item => typeof item?.name === 'string').map(item => `${appId}/${item.name}`)
    : [];
  if (paths.length) {
    const response = await fetchWithTimeout(`${SUPABASE_URL}/storage/v1/object/${PUBLISHED_BUCKET}`, {
      method: 'DELETE',
      headers: {
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!response.ok) {
      console.error('[publisher-api] Could not delete published packages:', await response.text());
      throw new PublisherError('Could not remove the published packages. The catalog entry remains available.', 502);
    }
  }
  await rest('publisher_catalog_apps', { method: 'DELETE', query: queryString({ app_id: `eq.${appId}` }), prefer: 'return=minimal' });
  return { deleted: true };
}

async function deletePublishedApp(user: { id: string }, body: Record<string, unknown>) {
  const appId = requiredText(body.appId, 'App ID', 120);
  const owner = await getOne('publisher_app_owners', 'app_id', appId);
  if (!owner || owner.owner_id !== user.id) throw new PublisherError('You can remove only apps published from your account.', 403);
  return removePublishedApp(appId);
}

async function dehostPublishedApp(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const appId = requiredText(body.appId, 'App ID', 120);
  return removePublishedApp(appId);
}

async function withdraw(user: { id: string }, body: Record<string, unknown>) {
  const id = assertSubmissionId(body.submissionId);
  const submission = await getOne('publisher_submissions', 'id', id);
  if (!submission || submission.owner_id !== user.id) throw new PublisherError('Submission not found.', 404);
  if (!WITHDRAWABLE_APP_STATUSES.includes(submission.status)) {
    throw new PublisherError('This submission can no longer be withdrawn.');
  }
  // Status-guarded PATCH: if a reviewer published (or another tab withdrew)
  // between the read above and this write, zero rows match and we abort
  // instead of leaving a live catalog app marked "withdrawn".
  await patchStatusGuarded('publisher_submissions', id, WITHDRAWABLE_APP_STATUSES, {
    status: 'withdrawn',
  });
  await deleteSubmissionQuietly(submission.package_path);
  if (submission.review_package_path) await deleteSubmissionQuietly(submission.review_package_path);
  return { withdrawn: true };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

  try {
    requiredEnv('SUPABASE_URL', SUPABASE_URL);
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
    const user = await getUser(request);
    const url = new URL(request.url);
    if (url.searchParams.get('action') === 'upload-reviewed-package') {
      requireAdmin(user);
      const id = assertSubmissionId(url.searchParams.get('submissionId'));
      const submission = await getOne('publisher_submissions', 'id', id);
      if (!submission || !ACTIVE_SUBMISSION_STATUSES.includes(submission.status)) {
        throw new PublisherError('This submission is no longer awaiting review.', 404);
      }
      const bytes = await readBoundedBody(request, MAX_PACKAGE_BYTES, 'The reviewed package');
      if (!bytes.length) throw new PublisherError('The reviewed package must be between 1 byte and 25 MB.');
      let pkg: Record<string, any>;
      try {
        pkg = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new PublisherError('The reviewed file is not valid .novaapp package JSON.');
      }
      if (
        !pkg ||
        pkg.novabyte_app !== true ||
        pkg.manifest?.id !== submission.app_id ||
        pkg.manifest?.version !== submission.version ||
        !pkg.files ||
        typeof pkg.files !== 'object' ||
        Array.isArray(pkg.files)
      ) {
        throw new PublisherError('The reviewed package must match the submission app ID and version and contain package files.');
      }
      const { pkg: submittedPackage } = await downloadSubmission(submission.package_path);
      preserveSubmissionScreenshots(submittedPackage, pkg);
      const reviewedBytes = new TextEncoder().encode(JSON.stringify(pkg));
      if (reviewedBytes.byteLength > MAX_PACKAGE_BYTES) {
        throw new PublisherError('The reviewed package with preserved screenshots exceeds the 25 MB limit.');
      }
      const automatedReview = runAutomatedReview(pkg, {
        appId: submission.app_id,
        version: submission.version,
      });
      if (!automatedReview.passed) {
        throw new PublisherError(
          `The reviewed package failed automated checks: ${automatedReview.errors.map(finding => finding.message).join(' ')}`,
        );
      }
      const reviewPath = `${id}/reviewed.novaapp`;
      await storageRequest(SUBMISSION_BUCKET, reviewPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upsert': 'true',
          'cache-control': 'no-store',
        },
        body: reviewedBytes,
      });
      await rest('publisher_submissions', {
        method: 'PATCH',
        query: queryString({ id: `eq.${id}` }),
        body: { review_package_path: reviewPath },
        prefer: 'return=minimal',
      });
      return respond({ uploaded: true });
    }
    if (url.searchParams.get('action') === 'upload-reviewed-plugin') {
      const bytes = await readBoundedBody(request, MAX_PACKAGE_BYTES, 'The reviewed .nbplugin');
      return respond(await uploadReviewedStudioPlugin(
        user,
        assertSubmissionId(url.searchParams.get('submissionId')),
        bytes,
      ));
    }
    if (url.searchParams.get('action') === 'upload-reviewed-template') {
      requireAdmin(user);
      const bytes = await readBoundedBody(request, MAX_TEMPLATE_UPLOAD_BYTES, 'The signed .nbtemplate');
      return respond(await uploadReviewedCommunityTemplate(
        user,
        assertSubmissionId(url.searchParams.get('submissionId')),
        bytes,
      ));
    }
    const body = await readJsonBody(request);
    const action = (body as Record<string, unknown>)?.action;
    if (typeof action !== 'string') throw new PublisherError('Choose a publisher action.');

    if (action === 'submit') return respond(await submit(user, body));
    if (action === 'submit-plugin') return respond(await submitStudioPlugin(user, body));
    if (action === 'submit-template') return respond(await submitCommunityTemplate(user, body));
    if (action === 'my-apps') return respond(await myApps(user));
    if (action === 'my-plugins') return respond(await myStudioPlugins(user));
    if (action === 'my-templates') return respond(await myCommunityTemplates(user));
    if (action === 'review-list') return respond(await reviewQueue(user));
    if (action === 'plugin-review-list') return respond(await studioPluginReviewQueue(user));
    if (action === 'template-review-list') return respond(await communityTemplateReviewQueue(user));
    if (action === 'hosted-apps') return respond(await hostedAppsForReview(user));
    if (action === 'review') return respond(await review(user, body));
    if (action === 'review-plugin') return respond(await reviewStudioPlugin(user, body));
    if (action === 'review-template') return respond(await reviewCommunityTemplate(user, body));
    if (action === 'delete-app') return respond(await deletePublishedApp(user, body));
    if (action === 'dehost-app') return respond(await dehostPublishedApp(user, body));
    if (action === 'withdraw') return respond(await withdraw(user, body));
    if (action === 'withdraw-plugin') return respond(await withdrawStudioPlugin(user, body));
    if (action === 'withdraw-template') return respond(await withdrawCommunityTemplate(user, body));
    throw new PublisherError('Unknown publisher action.', 404);
  } catch (error) {
    return errorResponse(error);
  }
});
