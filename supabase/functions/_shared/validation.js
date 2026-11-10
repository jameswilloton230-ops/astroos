// Shared, dependency-free validation helpers for the NovaByte publisher API.
//
// This module is intentionally pure: no Deno APIs, no fetch, no environment
// access. It runs identically inside the Edge Function and inside the Node
// test suite, which is what keeps the server-side rules covered by tests.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Catalog app IDs: lowercase alphanumerics plus dots, underscores, hyphens.
// Consecutive dots, leading dots, and trailing dots are rejected so IDs can
// never look like path traversal or empty path segments.
export const APP_ID_PATTERN = /^(?!\.)(?!.*\.\.)[a-z0-9][a-z0-9._-]{1,118}[a-z0-9_-]$/;

// Studio plugin and community template IDs: lowercase alphanumerics plus
// dots and hyphens, with the same anti-traversal rules as app IDs.
export const LISTING_ID_PATTERN = /^(?!\.)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,126}[a-z0-9-]$/;

// Strict semver: prerelease/build identifiers are dot-separated and non-empty
// ("1.0.0-alpha..1" and "1.0.0-" are rejected, unlike the previous lax rule).
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const ACTIVE_SUBMISSION_STATUSES = ['pending', 'changes_requested'];
export const WITHDRAWABLE_APP_STATUSES = ['pending', 'changes_requested', 'rejected', 'automated_rejected'];
export const WITHDRAWABLE_LISTING_STATUSES = ['pending', 'changes_requested', 'rejected'];
export const MAX_ACTIVE_SUBMISSIONS_PER_USER = 20;

const SCREENSHOT_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const SCREENSHOT_URL = /^https:\/\//i;
const SCREENSHOT_PATH = /^screenshots\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif)$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// ── Error type ─────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

// ── Scalars ────────────────────────────────────────────────────────────────

export function requiredText(value, label, maximum, minimum = 1) {
  if (typeof value !== 'string') throw new ValidationError(`${label} is required.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new ValidationError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return result;
}

export function assertSubmissionId(value, label = 'Submission ID') {
  const id = requiredText(value, label, 64);
  if (!UUID_PATTERN.test(id)) throw new ValidationError('Invalid submission ID.');
  return id;
}

export function assertAppId(value, label = 'App ID') {
  const appId = requiredText(value, label, 120, 2);
  if (!APP_ID_PATTERN.test(appId)) {
    throw new ValidationError('App ID may contain lowercase letters, digits, dots, underscores, and hyphens.');
  }
  return appId;
}

export function assertListingId(value, label = 'ID') {
  const id = requiredText(value, label, 128, 3);
  if (!LISTING_ID_PATTERN.test(id)) {
    throw new ValidationError(`${label} must use lowercase letters, digits, dots, and hyphens.`);
  }
  return id;
}

// ── Semantic versions ──────────────────────────────────────────────────────

export function parseVersion(version) {
  const match = VERSION_PATTERN.exec(version);
  if (!match) throw new ValidationError('Use a valid semantic version such as 1.2.3.');
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease || !b.prerelease) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const leftNumeric = /^\d+$/.test(a.prerelease[index]);
    const rightNumeric = /^\d+$/.test(b.prerelease[index]);
    if (leftNumeric && rightNumeric) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
  }
  return 0;
}

// ── Listing metadata ───────────────────────────────────────────────────────

export function validateLinks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!['website', 'source', 'support'].includes(key) || typeof raw !== 'string' || !raw.trim()) continue;
    let url;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new ValidationError(`${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== 'https:') throw new ValidationError(`${key} must use HTTPS.`);
    result[key] = url.href;
  }
  return result;
}

export function normalizeCategories(rawCategories) {
  const categories = [...new Set(rawCategories.map(item => {
    if (typeof item !== 'string') throw new ValidationError('Categories must be text values.');
    return item.toLowerCase().trim().replace(/[\s_]+/g, '-');
  }))];
  if (categories.some(item => !/^[a-z0-9-]{2,32}$/.test(item))) {
    throw new ValidationError('Categories may contain lowercase letters, numbers, and hyphens.');
  }
  return categories;
}

export function normalizeNewMetadata(value) {
  const name = requiredText(value.name, 'App name', 80, 2);
  const appId = assertAppId(value.appId);
  const author = requiredText(value.author, 'Publisher name', 80, 2);
  const version = requiredText(value.version, 'Version', 40);
  parseVersion(version);
  const description = requiredText(value.description, 'Description', 1000, 20);
  const changelog = requiredText(value.changelog, 'Release notes', 4000, 3);
  const rawCategories = Array.isArray(value.categories) ? value.categories : [];
  if (!rawCategories.length || rawCategories.length > 8) {
    throw new ValidationError('Add between one and eight valid categories.');
  }
  const categories = normalizeCategories(rawCategories);
  return { appId, name, author, version, description, categories, links: validateLinks(value.links), changelog };
}

// ── Package file maps and screenshots ─────────────────────────────────────

export function isSafePackagePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 512
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}

// Storage uploads need a standalone ArrayBuffer. The bytes must be copied into
// the new buffer itself: copying into a view of the source leaves it zero-filled.
export function toArrayBuffer(bytes) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export function isCanonicalBase64(value) {
  return typeof value === 'string' && value.length > 0 && BASE64_PATTERN.test(value);
}

export function assertSafePackageFiles(pkg) {
  if (!pkg.files || typeof pkg.files !== 'object' || Array.isArray(pkg.files)) {
    throw new ValidationError('The package does not contain a valid file map.');
  }
  const entries = Object.entries(pkg.files);
  if (!entries.length) throw new ValidationError('The package contains no files.');
  for (const [path, encoded] of entries) {
    if (!isSafePackagePath(path) || !isCanonicalBase64(encoded)) {
      throw new ValidationError('The package contains an invalid file or unsafe path.');
    }
  }
  return entries;
}

export function screenshotReferences(pkg) {
  const screenshots = pkg.manifest?.screenshots;
  if (screenshots === undefined) return [];
  if (!Array.isArray(screenshots) || screenshots.length > 5) {
    throw new ValidationError('The package must contain no more than five valid screenshots.');
  }
  for (const screenshot of screenshots) {
    if (typeof screenshot !== 'string') {
      throw new ValidationError('The package contains an invalid screenshot reference.');
    }
  }
  return screenshots;
}

export function packageScreenshots(pkg) {
  const screenshots = screenshotReferences(pkg);
  for (const screenshot of screenshots) {
    if (SCREENSHOT_DATA_URL.test(screenshot) || SCREENSHOT_URL.test(screenshot)) continue;
    if (!SCREENSHOT_PATH.test(screenshot) || typeof pkg.files?.[screenshot] !== 'string') {
      throw new ValidationError(`The package is missing screenshot file "${screenshot}".`);
    }
  }
  return screenshots;
}

export function preserveSubmissionScreenshots(submittedPackage, reviewedPackage) {
  const submittedScreenshots = packageScreenshots(submittedPackage);
  const reviewedScreenshots = screenshotReferences(reviewedPackage);
  const screenshots = [...reviewedScreenshots];
  for (const screenshot of reviewedScreenshots) {
    if (SCREENSHOT_PATH.test(screenshot) && typeof reviewedPackage.files[screenshot] !== 'string') {
      const submittedImage = submittedPackage.files[screenshot];
      if (typeof submittedImage !== 'string') {
        throw new ValidationError(`The reviewed package is missing screenshot file "${screenshot}".`);
      }
      reviewedPackage.files[screenshot] = submittedImage;
    }
  }
  for (const screenshot of submittedScreenshots) {
    if (!screenshots.includes(screenshot)) screenshots.push(screenshot);
    if (SCREENSHOT_PATH.test(screenshot) && typeof reviewedPackage.files[screenshot] !== 'string') {
      reviewedPackage.files[screenshot] = submittedPackage.files[screenshot];
    }
  }
  packageScreenshots({ ...reviewedPackage, manifest: { ...reviewedPackage.manifest, screenshots } });
  reviewedPackage.manifest.screenshots = screenshots;
}

export function missingPackageScreenshots(pkg) {
  return screenshotReferences(pkg).filter(screenshot =>
    SCREENSHOT_PATH.test(screenshot) && typeof pkg.files[screenshot] !== 'string'
  );
}

// ── Request bodies ─────────────────────────────────────────────────────────

// Reads at most `maximumBytes` from a request body, cancelling the stream as
// soon as the limit is exceeded so a hostile client cannot stream forever.
export async function readBoundedBody(request, maximumBytes, label) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ValidationError(`${label} must be no larger than ${maximumBytes / (1024 * 1024)} MiB.`);
  }
  if (!request.body) throw new ValidationError(`${label} is required.`);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ValidationError(`${label} must be no larger than ${maximumBytes / (1024 * 1024)} MiB.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonBody(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    throw new ValidationError('The request body could not be read.', 400);
  }
  if (!text) throw new ValidationError('A JSON request body is required.', 400);
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('The request body must be valid JSON.', 400);
  }
}

// ── HTML escaping for notification emails ──────────────────────────────────

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
