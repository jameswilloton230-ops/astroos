// Shared infrastructure for the NovaByte publisher-api Edge Function.
//
// Hardening notes (relative to the previous revision):
// - Every outbound fetch now has an abort timeout so a hung Supabase or
//   Resend connection can never pin an edge worker until the platform kills it.
// - Email delivery skips empty recipients instead of burning a provider call.
// - Database conflict errors are mapped using the violated constraint name
//   instead of assuming every 409 is a duplicate active submission.
// - Package signing is split into a pure, testable core (signPackageWithJwk)
//   plus a thin environment-reading wrapper, so the crypto path is covered by
//   the Node test suite.
import {
  ACTIVE_SUBMISSION_STATUSES,
  MAX_ACTIVE_SUBMISSIONS_PER_USER,
  ValidationError,
  escapeHtml,
} from './validation.js';

export const ADMIN_EMAIL = 'dirazmuhammad400@gmail.com';
export const SUBMISSION_BUCKET = 'publisher-submissions';
export const PUBLISHED_BUCKET = 'published-packages';
export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
export const TRUSTED_SIGNING_PUBLIC_X = 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY';
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

export { escapeHtml };

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

export class PublisherError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PublisherError';
    this.status = status;
  }
}

export function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

export function errorResponse(error: unknown) {
  if (error instanceof PublisherError) return respond({ error: error.message }, error.status);
  if (error instanceof ValidationError) return respond({ error: error.message }, error.status);
  if (error instanceof Error && error.name === 'TimeoutError') {
    return respond({ error: 'The publishing service timed out talking to a dependency. Please retry.' }, 504);
  }
  console.error('[publisher-api] Unexpected error:', error);
  return respond({ error: 'The publishing service encountered an unexpected error.' }, 500);
}

export function requiredEnv(name: string, value: string) {
  if (!value) throw new PublisherError(`The publisher service is missing its ${name} configuration.`, 503);
  return value;
}

export function getServiceKey() {
  return requiredEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
}

// fetch() with a hard abort deadline. AbortSignal.timeout is an AbortSignal,
// not a full init merge, so compose it with any caller-provided signal.
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}

async function readResponse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function rest(
  table: string,
  { method = 'GET', query = '', body, prefer = 'return=representation', timeoutMs }: {
    method?: string;
    query?: string;
    body?: unknown;
    prefer?: string;
    timeoutMs?: number;
  } = {},
) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`,
    {
      method,
      headers: {
        apikey: getServiceKey(),
        Authorization: `Bearer ${getServiceKey()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Prefer: prefer,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    timeoutMs,
  );
  const result = await readResponse(response);
  if (!response.ok) {
    console.error(`[publisher-api] Database request failed (${response.status}):`, result);
    if (['PGRST204', 'PGRST205', '42P01'].includes(result?.code)) {
      throw new PublisherError(
        'The Store database schema is missing or out of date. Apply the community templates migration with `supabase db push`, then retry.',
        503,
      );
    }
    if (response.status === 409 || result?.code === '23505') {
      const detail = String(result?.message || result?.details || '');
      if (detail.includes('publisher_one_active')) {
        throw new PublisherError('This listing already has a submission awaiting review.', 409);
      }
      if (detail.includes('publisher_app_owners')) {
        throw new PublisherError('That app ID is already owned by another publisher account.', 409);
      }
      throw new PublisherError('A database conflict occurred while saving. Refresh and try again.', 409);
    }
    throw new PublisherError('A database operation failed. Please retry or contact NovaByte support.', 502);
  }
  return result;
}

export function queryString(values: Record<string, string>) {
  return new URLSearchParams(values).toString();
}

// ── Submission quota helpers ───────────────────────────────────────────────

export async function countActiveSubmissions(table: string, ownerId: string) {
  const rows = await rest(table, {
    query: queryString({
      select: 'id',
      owner_id: `eq.${ownerId}`,
      status: `in.(${ACTIVE_SUBMISSION_STATUSES.join(',')})`,
      limit: String(MAX_ACTIVE_SUBMISSIONS_PER_USER + 1),
    }),
  });
  return Array.isArray(rows) ? rows.length : 0;
}

// Caps how many submissions one publisher can keep in the review queue.
// Without it, a single verified account could flood the reviewer inbox with
// notification emails and pin queue rendering.
export async function assertSubmissionQuota(table: string, ownerId: string) {
  const active = await countActiveSubmissions(table, ownerId);
  if (active >= MAX_ACTIVE_SUBMISSIONS_PER_USER) {
    throw new PublisherError(
      `You already have ${MAX_ACTIVE_SUBMISSIONS_PER_USER} submissions awaiting review. Withdraw or wait for them to be reviewed first.`,
      429,
    );
  }
}

export async function assertNoActiveSubmission(table: string, column: string, id: string, message: string) {
  const active = await rest(table, {
    query: queryString({
      select: 'id',
      [column]: `eq.${id}`,
      status: `in.(${ACTIVE_SUBMISSION_STATUSES.join(',')})`,
      limit: '1',
    }),
  });
  if (Array.isArray(active) && active.length) throw new PublisherError(message);
}

// Runs a PATCH that must only affect rows still in `expectedStatuses`.
// Returns the patched row, or throws when zero rows matched — the guard that
// closes the withdraw-vs-publish race (a submission that was published or
// withdrawn concurrently must never be silently overwritten).
export async function patchStatusGuarded(
  table: string,
  id: string,
  expectedStatuses: string[],
  body: Record<string, unknown>,
) {
  const updated = await rest(table, {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}`, status: `in.(${expectedStatuses.join(',')})` }),
    body,
    prefer: 'return=representation',
  });
  if (!Array.isArray(updated) || updated.length === 0) {
    throw new PublisherError('This submission is no longer in the expected state. Refresh and try again.', 409);
  }
  return updated[0];
}

export async function getUser(request: Request) {
  const authorization = request.headers.get('Authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new PublisherError('Sign in with a verified email to continue.', 401);
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: requiredEnv('SUPABASE_ANON_KEY', ANON_KEY), Authorization: `Bearer ${token}` },
  });
  const user = await readResponse(response);
  if (!response.ok || !user?.id) throw new PublisherError('Your sign-in has expired. Sign in again.', 401);
  if (!user.email_confirmed_at && !user.confirmed_at) {
    throw new PublisherError('Verify your email before using the publisher portal.', 403);
  }
  return user;
}

export function requireAdmin(user: { email?: string }) {
  if (String(user.email || '').trim().toLowerCase() !== ADMIN_EMAIL) {
    throw new PublisherError('This action is restricted to the authorized NovaByte reviewer.', 403);
  }
}

export function encodePath(path: string) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export async function storageRequest(bucket: string, path: string, init: RequestInit = {}) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodePath(path)}`,
    {
      ...init,
      headers: {
        apikey: getServiceKey(),
        Authorization: `Bearer ${getServiceKey()}`,
        ...init.headers,
      },
    },
  );
  const result = await readResponse(response);
  if (!response.ok) {
    console.error(`[publisher-api] Storage request failed (${response.status}):`, result);
    throw new PublisherError('A package storage operation failed. Please retry.', 502);
  }
  return result;
}

function privateStorageUrl(path: string) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  return `${SUPABASE_URL}/storage/v1/object/${SUBMISSION_BUCKET}/${encodePath(path)}`;
}

function privateStorageHeaders() {
  return { apikey: getServiceKey(), Authorization: `Bearer ${getServiceKey()}` };
}

export async function downloadSubmissionBytes(path: string) {
  const response = await fetchWithTimeout(privateStorageUrl(path), { headers: privateStorageHeaders() });
  if (!response.ok) {
    const result = await readResponse(response);
    console.error('[publisher-api] Could not download private package:', result);
    throw new PublisherError('The submitted package is unavailable.', 404);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new PublisherError('The package exceeds the 25 MB limit.');
  return bytes;
}

export async function downloadSubmission(path: string) {
  const bytes = await downloadSubmissionBytes(path);
  let pkg: unknown;
  try {
    pkg = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublisherError('The uploaded file is not valid package JSON.');
  }
  return { pkg: pkg as Record<string, any>, byteLength: bytes.byteLength };
}

export async function downloadPublishedPackage(path: string) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/storage/v1/object/${PUBLISHED_BUCKET}/${encodePath(path)}`,
    { headers: privateStorageHeaders() },
  );
  if (!response.ok) {
    const result = await readResponse(response);
    console.error('[publisher-api] Could not download published package:', result);
    throw new PublisherError('The currently published package is unavailable.', 404);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new PublisherError('The published package exceeds the 25 MB limit.');
  let pkg: unknown;
  try {
    pkg = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublisherError('The currently published package is not valid package JSON.');
  }
  return { pkg: pkg as Record<string, any>, byteLength: bytes.byteLength };
}

// Best-effort cleanup for packages whose submission failed every validation
// step — without this, rejected uploads stay in the private bucket forever.
export async function deleteSubmissionQuietly(path: string | null | undefined) {
  if (!path) return;
  try {
    await storageRequest(SUBMISSION_BUCKET, path, { method: 'DELETE' });
  } catch (error) {
    console.warn('[publisher-api] Could not clean up a rejected upload:', error);
  }
}

export async function makeSignedDownloadUrl(path: string, fileName: string) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/storage/v1/object/sign/${SUBMISSION_BUCKET}/${encodePath(path)}`,
    {
      method: 'POST',
      headers: {
        ...privateStorageHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    },
  );
  const result = await readResponse(response);
  if (!response.ok || typeof result?.signedURL !== 'string') {
    console.error('[publisher-api] Could not create reviewer download link:', result);
    throw new PublisherError('Could not create the private package review link.', 502);
  }
  const signedUrl = new URL(`${SUPABASE_URL}/storage/v1${result.signedURL}`);
  signedUrl.searchParams.set('download', fileName);
  return signedUrl.toString();
}

export type EmailResult =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'invalid_recipient' | 'provider_rejected' | 'network_error' };

export async function sendEmail(to: string, subject: string, html: string): Promise<EmailResult> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('PUBLISHER_NOTIFICATION_FROM');
  if (!apiKey || !from) {
    console.error('[publisher-api] Email not sent: RESEND_API_KEY or PUBLISHER_NOTIFICATION_FROM is not configured.');
    return { sent: false, reason: 'not_configured' };
  }
  if (!to || !to.includes('@')) {
    console.error('[publisher-api] Email not sent: missing or invalid recipient address.');
    return { sent: false, reason: 'invalid_recipient' };
  }
  try {
    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!response.ok) {
      console.error(`[publisher-api] Email delivery failed (${response.status}):`, await response.text());
      return { sent: false, reason: 'provider_rejected' };
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.error('[publisher-api] Email delivery timed out.');
      return { sent: false, reason: 'network_error' };
    }
    console.error('[publisher-api] Email delivery request failed:', error);
    return { sent: false, reason: 'network_error' };
  }
  return { sent: true };
}

export async function getAccountEmail(userId: string) {
  requiredEnv('SUPABASE_URL', SUPABASE_URL);
  const response = await fetchWithTimeout(
    `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
    { headers: privateStorageHeaders() },
  );
  const result = await readResponse(response);
  if (!response.ok || typeof result?.email !== 'string') {
    console.error('[publisher-api] Could not read publisher email:', result);
    throw new PublisherError('Could not load the publisher account email.', 502);
  }
  return result.email as string;
}

export function publicPackageUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${PUBLISHED_BUCKET}/${encodePath(path)}`;
}

// ── Package signing ────────────────────────────────────────────────────────
//
// The pure core: signs the canonical package payload with a caller-supplied
// Ed25519 private JWK whose public half must equal `expectedPublicX`. Returns
// the package with integrity hashes and a hex signature attached. Exposed for
// tests; production code goes through signAndVerifyPackage below.

export function signingPayload(pkg: Record<string, any>) {
  return JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at,
  });
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function computeIntegrity(pkg: Record<string, any>) {
  const payload = new TextEncoder().encode(signingPayload(pkg));
  const payloadHash = await crypto.subtle.digest('SHA-512', payload);
  const fileHashes: Record<string, string> = {};
  for (const [path, encoded] of Object.entries(pkg.files)) {
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new PublisherError(`The package contains an invalid encoded file: ${path}`);
    }
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-512', bytes);
    fileHashes[path] = toHex(new Uint8Array(digest));
  }
  return {
    method: 'sha512',
    payloadHash: toHex(new Uint8Array(payloadHash)),
    fileHashes,
  };
}

export async function signPackageWithJwk(
  pkg: Record<string, any>,
  privateJwk: JsonWebKey,
  expectedPublicX: string,
) {
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || !privateJwk.d || privateJwk.x !== expectedPublicX) {
    throw new PublisherError('The configured signing key does not match the trusted NovaByte signing identity.', 503);
  }

  pkg.signing = { method: 'ed25519' };
  pkg.signer = 'NovaByte Trusted Signing';
  delete pkg.signature;
  pkg.integrity = await computeIntegrity(pkg);

  const payload = new TextEncoder().encode(signingPayload(pkg));
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, payload));
  const publicKey = await crypto.subtle.importKey('jwk', {
    kty: 'OKP',
    crv: 'Ed25519',
    x: expectedPublicX,
  }, { name: 'Ed25519' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, payload)) {
    throw new PublisherError('The signing key failed its self-check; the package was not published.', 503);
  }
  pkg.signature = toHex(signature);
  return pkg;
}

export async function signAndVerifyPackage(pkg: Record<string, any>) {
  const privateKeyText = Deno.env.get('NOVABYTE_SIGNING_PRIVATE_JWK');
  if (!privateKeyText) {
    throw new PublisherError('NovaByte trusted signing is not configured. Publishing is disabled until the signing key is installed securely.', 503);
  }
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(privateKeyText);
  } catch {
    throw new PublisherError('The trusted signing key configuration is invalid.', 503);
  }
  return signPackageWithJwk(pkg, privateJwk, TRUSTED_SIGNING_PUBLIC_X);
}
