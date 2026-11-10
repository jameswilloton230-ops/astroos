export const MAX_TEMPLATE_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_TEMPLATE_UPLOAD_BYTES = Math.ceil(MAX_TEMPLATE_JSON_BYTES / 3) * 4;
export const MAX_TEMPLATE_EXPANDED_BYTES = 2 * 1024 * 1024;
export const MAX_TEMPLATE_FILES = 500;
const MAX_TEMPLATE_DESCRIPTION_LENGTH = 240;
const MAX_TEMPLATE_ICON_LENGTH = 100;
export const NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY = 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY';

const TEMPLATE_KEYS = [
  'author',
  'category',
  'description',
  'files',
  'icon',
  'manifest',
  'name',
  'releaseVersion',
];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

export class CommunityTemplateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommunityTemplateError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateJsonKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) validateJsonKeys(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new CommunityTemplateError(`The template JSON contains a forbidden key: ${key}`);
    }
    validateJsonKeys(child);
  }
}

function requiredText(value, label, maximum, minimum = 1) {
  if (typeof value !== 'string') throw new CommunityTemplateError(`${label} must be a string.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new CommunityTemplateError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  if (result !== value) throw new CommunityTemplateError(`${label} must not start or end with whitespace.`);
  return result;
}

function validateFilePath(path) {
  if (typeof path !== 'string' || path.length > 240) {
    throw new CommunityTemplateError('Template file paths must be strings no longer than 240 characters.');
  }
  const segments = path.split('/');
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')
    || /^[a-zA-Z]:/.test(path) || segments.some(segment =>
      !segment || segment === '.' || segment === '..' || segment.includes(':')
      || segment.startsWith('.') || segment.toLowerCase() === 'node_modules'
      || FORBIDDEN_KEYS.has(segment.toLowerCase()))) {
    throw new CommunityTemplateError(`The template contains an unsafe or unsupported file path: ${path}`);
  }
  const basename = segments.at(-1).toLowerCase();
  if (basename === 'manifest.json' || basename === 'template.json') {
    throw new CommunityTemplateError(`The template file path collides with reserved metadata: ${path}`);
  }
  return path;
}

function compareVersions(left, right) {
  const parse = version => {
    const match = VERSION_PATTERN.exec(version);
    if (!match) throw new CommunityTemplateError('Template releaseVersion must be valid semantic versioning, such as 1.2.3.');
    return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || null };
  };
  const a = parse(left);
  const b = parse(right);
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

export function validateCommunityTemplate(value) {
  if (!isRecord(value)) throw new CommunityTemplateError('The template must be a JSON object.');
  validateJsonKeys(value);
  const keys = Object.keys(value).sort();
  if (keys.length !== TEMPLATE_KEYS.length || keys.some((key, index) => key !== TEMPLATE_KEYS[index])) {
    throw new CommunityTemplateError(`The template must contain exactly: ${TEMPLATE_KEYS.join(', ')}.`);
  }

  const template = {
    name: requiredText(value.name, 'Template name', 80),
    description: requiredText(value.description, 'Description', MAX_TEMPLATE_DESCRIPTION_LENGTH, 10),
    author: requiredText(value.author, 'Author', 80),
    releaseVersion: requiredText(value.releaseVersion, 'Release version', 40),
    category: requiredText(value.category, 'Category', 40),
    icon: requiredText(value.icon, 'Icon', MAX_TEMPLATE_ICON_LENGTH),
    manifest: value.manifest,
    files: value.files,
  };
  if (!VERSION_PATTERN.test(template.releaseVersion)) {
    throw new CommunityTemplateError('Template releaseVersion must be valid semantic versioning, such as 1.2.3.');
  }
  if (!isRecord(template.manifest)) throw new CommunityTemplateError('The template manifest must be a JSON object.');
  if (!isRecord(template.files)) throw new CommunityTemplateError('Template files must be an object mapping safe paths to text content.');

  const paths = new Set();
  let expandedBytes = 0;
  const fileEntries = Object.entries(template.files);
  if (!fileEntries.length || fileEntries.length > MAX_TEMPLATE_FILES) {
    throw new CommunityTemplateError(`A template must contain between 1 and ${MAX_TEMPLATE_FILES} files.`);
  }
  for (const [rawPath, contents] of fileEntries) {
    const path = validateFilePath(rawPath);
    const normalizedPath = path.normalize('NFC').toLowerCase();
    if (paths.has(normalizedPath)) throw new CommunityTemplateError(`The template contains a duplicate file path: ${path}`);
    paths.add(normalizedPath);
    if (typeof contents !== 'string') {
      throw new CommunityTemplateError(`Template file "${path}" must contain text, not binary data.`);
    }
    expandedBytes += encoder.encode(contents).byteLength;
    if (expandedBytes > MAX_TEMPLATE_EXPANDED_BYTES) {
      throw new CommunityTemplateError('Template files exceed the 2 MiB expanded-content limit.');
    }
  }
  return template;
}

export function parseCommunityTemplateJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new CommunityTemplateError('The template JSON must be between 1 byte and 4 MiB.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CommunityTemplateError('The template upload must be valid UTF-8 JSON.');
  }
  if (!isRecord(parsed)) throw new CommunityTemplateError('The template upload must be a JSON object.');
  validateJsonKeys(parsed);
  const allowed = ['format', 'template', 'version'];
  const keys = Object.keys(parsed).sort();
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new CommunityTemplateError('Use an unsigned JSON wrapper containing only format, version, and template.');
  }
  if (parsed.format !== 'novapack-studio-user-template' || parsed.version !== 1) {
    throw new CommunityTemplateError('The upload must use the novapack-studio-user-template format, version 1.');
  }
  return {
    format: parsed.format,
    version: parsed.version,
    template: validateCommunityTemplate(parsed.template),
  };
}

function decodeTemplateFile(encoded, path) {
  if (typeof encoded !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new CommunityTemplateError(`Template file "${path}" must contain canonical Base64 text.`);
  }
  let binary;
  try {
    binary = atob(encoded);
  } catch {
    throw new CommunityTemplateError(`Template file "${path}" contains invalid Base64.`);
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let canonical = '';
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  if (btoa(canonical) !== encoded) {
    throw new CommunityTemplateError(`Template file "${path}" contains non-canonical Base64.`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CommunityTemplateError(`Template file "${path}" is not valid UTF-8 text.`);
  }
}

export function parseStudioCommunityTemplateBundle(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new CommunityTemplateError('The .nbtemplate must be between 1 byte and 4 MiB.');
  }
  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CommunityTemplateError('The .nbtemplate must be valid UTF-8 JSON.');
  }
  if (!isRecord(bundle)) throw new CommunityTemplateError('The .nbtemplate must be a JSON object.');
  validateJsonKeys(bundle);
  const keys = Object.keys(bundle).sort();
  if (keys.length !== 3 || keys[0] !== 'format' || keys[1] !== 'template' || keys[2] !== 'version') {
    throw new CommunityTemplateError('Upload an unsigned Studio .nbtemplate containing format, version, and template.');
  }
  if (bundle.format !== 'novapack-studio-user-template' || bundle.version !== 1) {
    throw new CommunityTemplateError('The .nbtemplate must use the Studio template format, version 1.');
  }
  if (!isRecord(bundle.template) || !isRecord(bundle.template.files)) {
    throw new CommunityTemplateError('The .nbtemplate must contain a template and Base64 files map.');
  }
  const entries = Object.entries(bundle.template.files);
  if (!entries.length || entries.length > MAX_TEMPLATE_FILES) {
    throw new CommunityTemplateError(`A template must contain between 1 and ${MAX_TEMPLATE_FILES} files.`);
  }
  let expandedBytes = 0;
  const files = Object.create(null);
  for (const [path, encoded] of entries) {
    const text = decodeTemplateFile(encoded, path);
    expandedBytes += encoder.encode(text).byteLength;
    if (expandedBytes > MAX_TEMPLATE_EXPANDED_BYTES) {
      throw new CommunityTemplateError('Template files exceed the 2 MiB expanded-content limit.');
    }
    files[path] = text;
  }
  const template = validateCommunityTemplate({ ...bundle.template, files });
  return { format: bundle.format, version: bundle.version, template };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function decodeBase64Url(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CommunityTemplateError(`${label} must be unpadded Base64URL.`);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - value.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new CommunityTemplateError(`${label} is not valid Base64URL.`);
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let canonical = '';
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  canonical = btoa(canonical).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (canonical !== value) throw new CommunityTemplateError(`${label} is not canonical Base64URL.`);
  return bytes;
}

function describeBase64Problem(encoded, unpadded, padding) {
  const bad = /[^A-Za-z0-9+/_=-]/u.exec(encoded);
  if (bad) {
    const code = bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    return `contains an unexpected character (U+${code}) at position ${bad.index + 1}`;
  }
  if (!/^[A-Za-z0-9+/_-]*$/.test(unpadded) || !/^(?:|=|==)$/.test(padding)) {
    return 'has "=" padding somewhere other than the end';
  }
  if (unpadded.length % 4 === 1) return 'has an impossible length, so the data looks truncated';
  if (/[+/].*[-_]|[-_].*[+/]/.test(encoded)) return 'mixes standard (+ /) and URL-safe (- _) characters';
  if ((padding && encoded.length % 4 !== 0)
    || (padding.length === 1 && unpadded.length % 4 !== 3)
    || (padding.length === 2 && unpadded.length % 4 !== 2)) {
    return 'has padding that doesn\'t match its length';
  }
  return null;
}

function decodeSignedTemplateJson(bytes) {
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    } else {
      let evenNulls = 0;
      let oddNulls = 0;
      for (let index = 0; index < Math.min(bytes.length, 256); index++) {
        if (bytes[index] === 0) {
          if (index % 2) oddNulls++;
          else evenNulls++;
        }
      }
      if (oddNulls >= 4 && oddNulls > evenNulls * 2) {
        text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
      } else if (evenNulls >= 4 && evenNulls > oddNulls * 2) {
        text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
      } else {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      }
    }
  } catch {
    throw new CommunityTemplateError('The signed template must contain Base64 text or JSON.');
  }
  text = text.replace(/^\uFEFF/, '').trim();
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  let rawJsonProblem = 'expected a JSON object';
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const jsonBytes = encoder.encode(text.slice(jsonStart, jsonEnd + 1));
    if (jsonBytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
      throw new CommunityTemplateError('The signed template must be no larger than 4 MiB.');
    }
    try {
      if (isRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)))) {
        return jsonBytes;
      }
    } catch (error) {
      rawJsonProblem = error.message;
    }
  }

  // Base64 can't contain "{", so any brace means raw JSON was intended, even
  // with junk in front of it. Report the JSON failure instead of blaming the
  // encoding. A leading quote is the JSON-string-wrapped form, handled below.
  if (jsonStart !== -1 && !text.startsWith('"')) {
    if (jsonEnd <= jsonStart) rawJsonProblem = 'no closing "}" found';
    throw new CommunityTemplateError(`The signed template is not valid JSON: ${rawJsonProblem}`);
  }

  if (text.startsWith('"')) {
    try {
      const wrapped = JSON.parse(text);
      if (typeof wrapped === 'string') text = wrapped.trim();
    } catch {
      throw new CommunityTemplateError('The signed template must be UTF-8 JSON or Base64-encoded UTF-8 JSON.');
    }
    const wrappedJsonStart = text.indexOf('{');
    const wrappedJsonEnd = text.lastIndexOf('}');
    let wrappedJsonProblem = 'no closing "}" found';
    if (wrappedJsonStart !== -1 && wrappedJsonEnd > wrappedJsonStart) {
      const jsonBytes = encoder.encode(text.slice(wrappedJsonStart, wrappedJsonEnd + 1));
      if (jsonBytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
        throw new CommunityTemplateError('The signed template must be no larger than 4 MiB.');
      }
      try {
        if (isRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes)))) {
          return jsonBytes;
        }
        wrappedJsonProblem = 'expected a JSON object';
      } catch (error) {
        wrappedJsonProblem = error.message;
      }
    }
    if (wrappedJsonStart !== -1) {
      throw new CommunityTemplateError(`The quoted signed template is not valid JSON: ${wrappedJsonProblem}`);
    }
  }
  const dataUri = /^data:[^,]*;base64,/i.exec(text);
  const base64Prefix = /^base64:/i.exec(text);
  const encoded = (dataUri
    ? text.slice(dataUri[0].length)
    : base64Prefix ? text.slice(base64Prefix[0].length) : text).replace(/\s/g, '');
  const unpadded = encoded.replace(/=+$/, '');
  const padding = encoded.slice(unpadded.length);
  const base64Problem = describeBase64Problem(encoded, unpadded, padding);
  if (base64Problem) {
    throw new CommunityTemplateError(
      `The signed template must be UTF-8 JSON or Base64-encoded UTF-8 JSON. It isn't JSON, and as Base64 it ${base64Problem}.`,
    );
  }
  const normalized = unpadded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new CommunityTemplateError('The signed template must be UTF-8 JSON or Base64-encoded UTF-8 JSON.');
  }
  const decoded = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (decoded.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new CommunityTemplateError('The signed template must be no larger than 4 MiB when decoded.');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    throw new CommunityTemplateError('The Base64-encoded signed template must decode to UTF-8 JSON.');
  }
  return decoded;
}

function validateSignedTemplateContent(value) {
  if (!isRecord(value)) throw new CommunityTemplateError('The signed template must contain a template object.');
  const keys = Object.keys(value).sort();
  if (keys.length !== TEMPLATE_KEYS.length || keys.some((key, index) => key !== TEMPLATE_KEYS[index])) {
    throw new CommunityTemplateError(`The signed template must contain exactly: ${TEMPLATE_KEYS.join(', ')}.`);
  }
  if (!isRecord(value.files)) throw new CommunityTemplateError('Template files must be a Base64 file map.');
  const entries = Object.entries(value.files);
  if (!entries.length || entries.length > MAX_TEMPLATE_FILES) {
    throw new CommunityTemplateError(`A template must contain between 1 and ${MAX_TEMPLATE_FILES} files.`);
  }
  const files = Object.create(null);
  for (const [path, encoded] of entries) {
    files[path] = decodeTemplateFile(encoded, path);
  }
  return validateCommunityTemplate({ ...value, files });
}

export async function parseSignedCommunityTemplateJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_TEMPLATE_UPLOAD_BYTES) {
    throw new CommunityTemplateError('The signed template must be between 1 byte and 5.34 MiB.');
  }
  const jsonBytes = decodeSignedTemplateJson(bytes);
  let bundle;
  try {
    bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes));
  } catch {
    throw new CommunityTemplateError('The signed template must be valid UTF-8 JSON.');
  }
  if (!isRecord(bundle)) throw new CommunityTemplateError('The signed template must be a JSON object.');
  validateJsonKeys(bundle);
  const bundleKeys = Object.keys(bundle).sort();
  const allowedBundleKeys = ['format', 'signature', 'template', 'version'];
  if (bundleKeys.length !== allowedBundleKeys.length
    || bundleKeys.some((key, index) => key !== allowedBundleKeys[index])) {
    throw new CommunityTemplateError('Upload the complete signed .nbtemplate bundle.');
  }
  if (bundle.format !== 'novapack-studio-user-template' || bundle.version !== 1) {
    throw new CommunityTemplateError('The signed bundle must use the Studio template format, version 1.');
  }
  const signature = bundle.signature;
  if (!isRecord(signature)
    || Object.keys(signature).sort().join(',') !== 'algorithm,publicKey,signature'
    || signature.algorithm !== 'Ed25519'
    || signature.publicKey !== NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY) {
    throw new CommunityTemplateError('The template must be signed with NovaByte Trusted Signing.');
  }
  const signatureBytes = decodeBase64Url(signature.signature, 'Template signature');
  if (signatureBytes.byteLength !== 64) {
    throw new CommunityTemplateError('The template signature must be a 64-byte Ed25519 signature.');
  }
  const template = validateSignedTemplateContent(bundle.template);
  const publicKeyBytes = decodeBase64Url(NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY, 'NovaByte signing public key');
  if (publicKeyBytes.byteLength !== 32) {
    throw new CommunityTemplateError('The pinned NovaByte signing key is invalid.');
  }
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch (error) {
    throw new CommunityTemplateError(`Could not load the NovaByte template verification key: ${error.message}`);
  }
  const payload = encoder.encode(canonicalJson({
    format: bundle.format,
    version: bundle.version,
    template: bundle.template,
  }));
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signatureBytes, payload)) {
    throw new CommunityTemplateError('The signed template failed NovaByte signature verification.');
  }
  return {
    bundle,
    template,
    bytes: jsonBytes,
  };
}

export function encodeCommunityTemplateFiles(template) {
  const files = Object.fromEntries(Object.entries(template.files).map(([path, content]) => {
    const bytes = encoder.encode(content);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return [path, btoa(binary)];
  }));
  return { ...template, files };
}

export function compareCommunityTemplateVersions(left, right) {
  return compareVersions(left, right);
}
