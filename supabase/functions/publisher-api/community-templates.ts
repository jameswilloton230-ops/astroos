// Community template submission, review, and publication actions.
//
// Hardening in this revision: UUID-validated submission IDs everywhere, a
// status-guarded withdraw (closes the publish race), a per-user active
// submission quota, and per-row fallbacks in the review queue.
import {
  ADMIN_EMAIL,
  PUBLISHED_BUCKET,
  SUBMISSION_BUCKET,
  PublisherError,
  assertNoActiveSubmission,
  assertSubmissionQuota,
  deleteSubmissionQuietly,
  downloadSubmissionBytes,
  escapeHtml,
  getAccountEmail,
  makeSignedDownloadUrl,
  patchStatusGuarded,
  publicPackageUrl,
  queryString,
  requireAdmin,
  rest,
  sendEmail,
  storageRequest,
} from '../_shared/publisher.ts';
import {
  ACTIVE_SUBMISSION_STATUSES,
  WITHDRAWABLE_LISTING_STATUSES,
  assertListingId,
  assertSubmissionId,
  requiredText,
  toArrayBuffer,
} from '../_shared/validation.js';
import {
  CommunityTemplateError,
  MAX_TEMPLATE_JSON_BYTES,
  MAX_TEMPLATE_UPLOAD_BYTES,
  canonicalJson,
  compareCommunityTemplateVersions,
  parseCommunityTemplateJson,
  parseSignedCommunityTemplateJson,
  parseStudioCommunityTemplateBundle,
} from '../_shared/community-template.js';

function parseSubmittedTemplate(bytes: Uint8Array, packagePath: string) {
  try {
    return packagePath.endsWith('.nbtemplate')
      ? parseStudioCommunityTemplateBundle(bytes).template
      : parseCommunityTemplateJson(bytes).template;
  } catch (error) {
    if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
    throw error;
  }
}

async function parseSignedTemplate(bytes: Uint8Array) {
  try {
    return await parseSignedCommunityTemplateJson(bytes);
  } catch (error) {
    if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
    throw error;
  }
}

function assertMatchesSubmittedTemplate(
  reviewed: Record<string, unknown>,
  submitted: Record<string, unknown>,
) {
  if (canonicalJson(reviewed) !== canonicalJson(submitted)) {
    throw new PublisherError('The signed .nbtemplate must contain the exact template submitted for review.');
  }
}

function metadataFor(template: Record<string, unknown>) {
  return {
    name: template.name,
    description: template.description,
    author: template.author,
    category: template.category,
    icon: template.icon,
  };
}

function matchMetadata(template: Record<string, unknown>, metadata: Record<string, unknown>) {
  for (const key of ['name', 'description', 'author', 'category', 'icon']) {
    if (template[key] !== metadata[key]) {
      throw new PublisherError(`The reviewed template ${key} must match the submitted listing details.`);
    }
  }
}

async function getRow(table: string, column: string, value: string) {
  const result = await rest(table, {
    query: queryString({ select: '*', [column]: `eq.${value}`, limit: '1' }),
  });
  return Array.isArray(result) ? result[0] || null : null;
}

async function getSubmission(id: string) {
  return getRow('publisher_template_submissions', 'id', id);
}

export async function submitCommunityTemplate(user: { id: string; email?: string }, body: Record<string, unknown>) {
  const id = assertSubmissionId(body.submissionId);
  const submission = body.submission as Record<string, unknown> | undefined;
  if (!submission || typeof submission !== 'object') throw new PublisherError('Submission details are required.');
  const templateId = assertListingId(submission.templateId, 'Template ID');
  const type = submission.type === 'update' ? 'update' : submission.type === 'new' ? 'new' : null;
  if (!type) throw new PublisherError('Submission type must be new or update.');
  const packagePath = requiredText(submission.packagePath, 'Template upload', 180);
  if (packagePath !== `${user.id}/${id}.nbtemplate`
    && packagePath !== `${user.id}/${id}.nbtemplate.json`) {
    throw new PublisherError('The uploaded template does not belong to this account.');
  }

  try {
    await assertSubmissionQuota('publisher_template_submissions', user.id);

    const owner = await getRow('publisher_template_owners', 'template_id', templateId);
    const existing = type === 'new' ? await getRow('publisher_catalog_templates', 'template_id', templateId) : null;
    if (type === 'new' && (owner || existing)) throw new PublisherError('That community template ID is already published.');
    if (type === 'update' && (!owner || owner.owner_id !== user.id)) {
      throw new PublisherError('You can submit updates only for community templates you own.');
    }
    const published = type === 'update' ? await getRow('publisher_catalog_templates', 'template_id', templateId) : null;
    if (type === 'update' && !published) throw new PublisherError('This community template is not currently published.');

    const bytes = await downloadSubmissionBytes(packagePath);
    if (bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) throw new PublisherError('The .nbtemplate must be no larger than 4 MiB.');
    const template = parseSubmittedTemplate(bytes, packagePath);
    if (type === 'update') {
      try {
        if (compareCommunityTemplateVersions(template.releaseVersion as string, published.version) <= 0) {
          throw new PublisherError('An update must use a releaseVersion newer than the currently published template.');
        }
      } catch (error) {
        if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
        throw error;
      }
    }
    await assertNoActiveSubmission(
      'publisher_template_submissions', 'template_id', templateId,
      'This community template already has a submission awaiting review.',
    );
    await rest('publisher_template_submissions', {
      method: 'POST',
      body: {
        id,
        owner_id: user.id,
        template_id: templateId,
        type,
        version: template.releaseVersion,
        metadata: metadataFor(template),
        package_path: packagePath,
        status: 'pending',
      },
      prefer: 'return=minimal',
    });
    const notification = await sendEmail(
      ADMIN_EMAIL,
      `Community template awaiting review: ${escapeHtml(String(template.name))} v${escapeHtml(String(template.releaseVersion))}`,
      `<p><strong>${escapeHtml(String(template.name))}</strong> (${escapeHtml(templateId)}) v${escapeHtml(String(template.releaseVersion))} is waiting for human review.</p><p>Publisher account: ${escapeHtml(user.email || 'unknown')}</p><p>Open the NovaByte Publisher Portal and select Review submissions.</p>`,
    );
    return {
      submitted: true,
      notificationSent: notification.sent,
      notificationError: notification.sent ? undefined : notification.reason,
    };
  } catch (error) {
    await deleteSubmissionQuietly(packagePath);
    throw error;
  }
}

export async function myCommunityTemplates(user: { id: string }) {
  const [owners, submissions] = await Promise.all([
    rest('publisher_template_owners', {
      query: queryString({ select: 'template_id,created_at', owner_id: `eq.${user.id}`, order: 'created_at.desc' }),
    }),
    rest('publisher_template_submissions', {
      query: queryString({
        select: 'id,template_id,type,version,metadata,status,review_note,created_at,reviewed_at',
        owner_id: `eq.${user.id}`,
        status: 'neq.withdrawn',
        order: 'created_at.desc',
      }),
    }),
  ]);
  const ids = Array.isArray(owners)
    ? owners.map(row => row.template_id).filter((value): value is string => typeof value === 'string')
    : [];
  const templates = ids.length
    ? await rest('publisher_catalog_templates', {
      query: queryString({ select: '*', template_id: `in.(${ids.join(',')})` }),
    })
    : [];
  return {
    templates: Array.isArray(templates) ? templates : [],
    submissions: Array.isArray(submissions) ? submissions : [],
  };
}

export async function communityTemplateReviewQueue(user: { email?: string }) {
  requireAdmin(user);
  const rows = await rest('publisher_template_submissions', {
    query: queryString({
      select: 'id,owner_id,template_id,type,version,metadata,status,created_at,package_path,review_package_path',
      status: `in.(${ACTIVE_SUBMISSION_STATUSES.join(',')})`,
      order: 'created_at.asc',
    }),
  });
  const submissions = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => ({
    ...row,
    owner_email: await getAccountEmail(row.owner_id).catch(error => {
      console.error('[publisher-api] Could not resolve owner email for template review queue:', error);
      return null;
    }),
    download_url: await makeSignedDownloadUrl(
      row.package_path,
      `${row.template_id}-${row.version}.nbtemplate`,
    ).catch(error => {
      console.error('[publisher-api] Could not create template review download link:', error);
      return null;
    }),
    has_reviewed_package: typeof row.review_package_path === 'string'
      && row.review_package_path.endsWith('.nbtemplate'),
  })));
  return { submissions };
}

export async function uploadReviewedCommunityTemplate(
  user: { email?: string },
  id: string,
  bytes: Uint8Array,
) {
  requireAdmin(user);
  if (!bytes.length || bytes.byteLength > MAX_TEMPLATE_UPLOAD_BYTES) {
    throw new PublisherError('The signed .nbtemplate must be between 1 byte and 5.34 MiB.');
  }
  const submission = await getSubmission(id);
  if (!submission || !ACTIVE_SUBMISSION_STATUSES.includes(submission.status)) {
    throw new PublisherError('This community template submission is no longer awaiting review.', 404);
  }
  const reviewed = await parseSignedTemplate(bytes);
  const signedBytes = reviewed.bytes;
  const template = reviewed.template;
  if (template.releaseVersion !== submission.version) {
    throw new PublisherError('The reviewed template releaseVersion must match the submitted version.');
  }
  matchMetadata(template, submission.metadata);
  const submittedBytes = await downloadSubmissionBytes(submission.package_path);
  const submittedTemplate = parseSubmittedTemplate(submittedBytes, submission.package_path);
  assertMatchesSubmittedTemplate(template, submittedTemplate);
  const reviewPath = `${id}/reviewed.nbtemplate`;
  await storageRequest(SUBMISSION_BUCKET, reviewPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': 'no-store',
    },
    body: toArrayBuffer(signedBytes),
  });
  await rest('publisher_template_submissions', {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}` }),
    body: { review_package_path: reviewPath },
    prefer: 'return=minimal',
  });
  return { uploaded: true };
}

async function publishCommunityTemplate(submission: Record<string, any>) {
  const reviewedBytes = await downloadSubmissionBytes(submission.review_package_path);
  if (reviewedBytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new PublisherError('The signed .nbtemplate exceeds the 4 MiB limit.');
  }
  const reviewed = await parseSignedTemplate(reviewedBytes);
  const template = reviewed.template;
  if (template.releaseVersion !== submission.version) {
    throw new PublisherError('The reviewed template no longer matches the submitted version.');
  }
  matchMetadata(template, submission.metadata);
  const submittedBytes = await downloadSubmissionBytes(submission.package_path);
  const submittedTemplate = parseSubmittedTemplate(submittedBytes, submission.package_path);
  assertMatchesSubmittedTemplate(template, submittedTemplate);

  const previous = await getRow('publisher_catalog_templates', 'template_id', submission.template_id);
  if (submission.type === 'new' && previous) {
    throw new PublisherError('This template ID was published while the submission was under review.');
  }
  if (submission.type === 'update') {
    if (!previous) throw new PublisherError('The community template is no longer published.');
    try {
      if (compareCommunityTemplateVersions(submission.version, previous.version) <= 0) {
        throw new PublisherError('The reviewed template version is no longer newer than the published version.');
      }
    } catch (error) {
      if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
      throw error;
    }
  }

  const path = `${submission.template_id}/${submission.version}.nbtemplate`;
  await storageRequest(PUBLISHED_BUCKET, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: toArrayBuffer(reviewedBytes),
  });
  const metadata = submission.metadata;
  const row = {
    template_id: submission.template_id,
    name: metadata.name,
    version: submission.version,
    author: metadata.author,
    description: metadata.description,
    category: metadata.category,
    file: publicPackageUrl(path),
    size: reviewedBytes.byteLength,
    published_at: new Date().toISOString(),
  };
  await rest('rpc/commit_publisher_template_publish', {
    method: 'POST',
    body: { p_submission_id: submission.id, p_template: row },
    prefer: 'return=minimal',
  });
  return row;
}

export async function reviewCommunityTemplate(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const id = assertSubmissionId(body.submissionId);
  const decision = body.decision;
  const note = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 2000) : '';
  if (!['publish', 'reject', 'request-changes'].includes(String(decision))) {
    throw new PublisherError('Choose publish, reject, or request-changes.');
  }
  if (decision !== 'publish' && !note) {
    throw new PublisherError('Add a reviewer note before requesting changes or rejecting.');
  }
  const submission = await getSubmission(id);
  if (!submission || !ACTIVE_SUBMISSION_STATUSES.includes(submission.status)) {
    throw new PublisherError('This community template submission is no longer awaiting review.', 404);
  }
  if (decision === 'publish') {
    if (!submission.review_package_path) {
      throw new PublisherError('Upload the exact inspected signed .nbtemplate before approving this submission.');
    }
    await publishCommunityTemplate(submission);
  } else {
    await patchStatusGuarded('publisher_template_submissions', id, ACTIVE_SUBMISSION_STATUSES, {
      status: decision === 'reject' ? 'rejected' : 'changes_requested',
      reviewed_at: new Date().toISOString(),
      review_note: note,
    });
  }
  const recipient = await getAccountEmail(submission.owner_id);
  const label = decision === 'publish' ? 'published' : decision === 'reject' ? 'rejected' : 'needs changes';
  const notification = await sendEmail(
    recipient,
    `NovaByte community template ${label}: ${escapeHtml(submission.template_id)} v${escapeHtml(submission.version)}`,
    `<p>Your submission for <strong>${escapeHtml(submission.template_id)}</strong> v${escapeHtml(submission.version)} was ${escapeHtml(label)}.</p>${note ? `<p>Reviewer note: ${escapeHtml(note)}</p>` : ''}${decision === 'publish' ? '<p>NovaByte reviewed and published your signed community template. It is now available in the Studio template catalog.</p>' : '<p>Sign in to My Community Templates to see the review status.</p>'}`,
  );
  return {
    reviewed: true,
    notificationSent: notification.sent,
    notificationError: notification.sent ? undefined : notification.reason,
  };
}

export async function withdrawCommunityTemplate(user: { id: string }, body: Record<string, unknown>) {
  const id = assertSubmissionId(body.submissionId);
  const submission = await getSubmission(id);
  if (!submission || submission.owner_id !== user.id) throw new PublisherError('Submission not found.', 404);
  if (!WITHDRAWABLE_LISTING_STATUSES.includes(submission.status)) {
    throw new PublisherError('This community template submission can no longer be withdrawn.');
  }
  // Status-guarded PATCH: a concurrent approval can no longer be overwritten
  // by a stale withdraw.
  await patchStatusGuarded('publisher_template_submissions', id, WITHDRAWABLE_LISTING_STATUSES, {
    status: 'withdrawn',
  });
  await deleteSubmissionQuietly(submission.package_path);
  if (submission.review_package_path) await deleteSubmissionQuietly(submission.review_package_path);
  return { withdrawn: true };
}
