const APP_ID_PATTERN = /^(?:webapp_[a-z0-9._-]{1,112}|[a-z][a-z0-9]*(?:\.[a-z0-9]+)+)$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BINARY_EXTENSION_PATTERN = /\.(?:7z|apk|bin|class|dll|dylib|exe|jar|o|so|wasm|zip)$/i;
const MAX_FILES = 2000;
const MAX_FINDINGS = 100;

const MANUAL_REVIEW_CHECKS = [
  'Confirm the app does not contain ads, trackers, analytics, or third-party SDKs that phone home.',
  'Confirm its behavior and declared permissions match the listing and any permission rationale.',
  'Confirm data handling, background activity, and boot behavior follow the Store requirements.',
  'Check for review-detection logic, NovaByte system-dialog impersonation, and cryptocurrency mining.',
];

function lineNumberAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (source.charCodeAt(cursor) === 10) line++;
  }
  return line;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return utf8Decoder.decode(bytes);
}

function hasBinaryPayload(value) {
  const prefix = atob(value.slice(0, 16));
  const startsWith = (...bytes) => bytes.every((byte, index) => prefix.charCodeAt(index) === byte);
  return startsWith(0x4d, 0x5a)
    || startsWith(0x7f, 0x45, 0x4c, 0x46)
    || startsWith(0x50, 0x4b, 0x03, 0x04)
    || startsWith(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)
    || startsWith(0x52, 0x61, 0x72, 0x21)
    || startsWith(0x00, 0x61, 0x73, 0x6d)
    || startsWith(0xca, 0xfe, 0xba, 0xbe)
    || startsWith(0xfe, 0xed, 0xfa, 0xce)
    || startsWith(0xce, 0xfa, 0xed, 0xfe)
    || startsWith(0xfe, 0xed, 0xfa, 0xcf)
    || startsWith(0xcf, 0xfa, 0xed, 0xfe);
}

export function runAutomatedReview(pkg, { appId, version, now = new Date().toISOString() }) {
  const errors = [];
  const warnings = [];
  const findingsCapped = () => errors.length + warnings.length >= MAX_FINDINGS;
  const add = (target, finding) => {
    if (errors.length + warnings.length < MAX_FINDINGS) target.push(finding);
  };
  const error = (code, message, file = null, line = null) =>
    add(errors, { code, message, file, line });
  const warning = (code, message, file = null, line = null) =>
    add(warnings, { code, message, file, line });

  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    error('invalid_package', 'Package root must be a JSON object.');
  } else {
    const manifest = pkg.manifest;
    const files = pkg.files;
    if (pkg.novabyte_app !== true) error('invalid_package_marker', 'Package is missing novabyte_app: true.');
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      error('invalid_manifest', 'Manifest must be a JSON object.');
    } else {
      for (const field of ['id', 'name', 'version', 'entry']) {
        if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
          error('missing_manifest_field', `Manifest field "${field}" is required.`);
        }
      }
      if (typeof manifest.id === 'string') {
        if (!APP_ID_PATTERN.test(manifest.id)) {
          error('invalid_manifest_id', 'Manifest ID must use reverse-domain format (or the webapp_ prefix).');
        } else if (manifest.id !== appId) {
          error('manifest_id_mismatch', 'Manifest ID does not match the submitted app ID.');
        }
      }
      if (typeof manifest.version === 'string' && manifest.version !== version) {
        error('manifest_version_mismatch', 'Manifest version does not match the submitted version.');
      }
      if (manifest.permissions !== undefined
        && (!Array.isArray(manifest.permissions)
          || manifest.permissions.some(permission => typeof permission !== 'string'))) {
        error('invalid_permissions', 'Manifest permissions must be an array of strings.');
      }
      if (Array.isArray(manifest.optionalPermissions) && manifest.optionalPermissions.includes('system:root')) {
        error('optional_root_permission', 'system:root must be required, not listed as optional.');
      }
      // permissionReasons is mandatory for store submissions: every declared
      // permission (required and optional) must carry a non-empty reason — the
      // text the OS shows in its grant dialogs. Enforcement happens at
      // submission time only, so listings published before this rule are not
      // re-validated (they stay up) until their next update. Key matching
      // mirrors the OS package validator (app-package.js): a reason keyed by a
      // legacy vfs:* alias counts for its fs:* equivalent, values must be
      // non-empty strings within the OS display cap.
      const declaredPermissions = [
        ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
        ...(Array.isArray(manifest.optionalPermissions) ? manifest.optionalPermissions : []),
      ].filter(permission => typeof permission === 'string' && permission.trim());
      if (declaredPermissions.length) {
        const LEGACY_PERMISSION_ALIASES = {
          'vfs:access': 'fs:access',
          'vfs:read': 'fs:access',
          'vfs:write': 'fs:access',
          'vfs:delete': 'fs:access',
          'vfs:metadata': 'fs:metadata',
        };
        const REASON_CAP = 500;
        const reasons = manifest.permissionReasons;
        if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
          const unique = [...new Set(declaredPermissions)];
          error('missing_permission_reasons',
            'Every declared permission needs a reason: add a permissionReasons object to the manifest mapping each permission to a short human-readable justification'
            + ` (missing for: ${unique.slice(0, 10).join(', ')}${unique.length > 10 ? ', …' : ''}).`);
        } else {
          const hasReason = permission => Object.entries(reasons).some(([key, value]) => {
            const canonical = Object.prototype.hasOwnProperty.call(LEGACY_PERMISSION_ALIASES, key)
              ? LEGACY_PERMISSION_ALIASES[key]
              : key;
            return (key === permission || canonical === permission)
              && typeof value === 'string' && Boolean(value.trim());
          });
          for (const permission of new Set(declaredPermissions)) {
            if (!hasReason(permission)) {
              error('missing_permission_reason',
                `Permission "${permission}" has no entry in permissionReasons; every declared permission needs a short human-readable reason.`);
            }
          }
          for (const [key, value] of Object.entries(reasons)) {
            if (typeof value !== 'string' || !value.trim()) {
              error('invalid_permission_reason', `permissionReasons["${key}"] must be a non-empty string.`);
            } else if (value.trim().length > REASON_CAP) {
              error('overlong_permission_reason',
                `permissionReasons["${key}"] exceeds the ${REASON_CAP}-character limit for permission reasons.`);
            }
          }
        }
      }
    }

    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      error('invalid_file_map', 'Package files must be an object mapping safe paths to base64 data.');
    } else {
      const entries = Object.entries(files);
      if (!entries.length) error('empty_file_map', 'Package must contain at least one file.');
      if (entries.length > MAX_FILES) error('too_many_files', `Package cannot contain more than ${MAX_FILES} files.`);

      for (const [path, encoded] of entries.slice(0, MAX_FILES)) {
        if (findingsCapped()) break;
        if (!path || path.startsWith('/') || path.includes('\\')
          || path.split('/').some(part => !part || part === '.' || part === '..')) {
          error('unsafe_file_path', 'Package contains an unsafe file path.', path);
          continue;
        }
        if (typeof encoded !== 'string' || !encoded || !BASE64_PATTERN.test(encoded)) {
          error('invalid_file_data', 'Package file data must be valid base64.', path);
          continue;
        }
        if (BINARY_EXTENSION_PATTERN.test(path) || hasBinaryPayload(encoded)) {
          error('binary_file', 'Store packages may contain web assets only, not bundled binaries or executables.', path);
          continue;
        }
        if (!/\.(?:html?|[cm]?js|svg|css)$/i.test(path)) continue;

        let source;
        try {
          source = decodeBase64(encoded);
        } catch {
          error('invalid_text_encoding', 'Could not decode this source file as UTF-8.', path);
          continue;
        }
        const checks = [
          ['dynamic_code', /\beval\s*\(|\bnew\s+Function\s*\(/g,
            'Potential dynamic code execution detected; review eval or new Function usage.'],
          ['string_timer', /\b(?:setTimeout|setInterval)\s*\(\s*(['"`])/g,
            'Timer appears to execute a string instead of a function.'],
          ['remote_script', /(?:<script\b[^>]*\bsrc\s*=\s*|\.src\s*=\s*)['"`](?:https?:)?\/\//gi,
            'HTML loads a remote script; dependencies must be bundled in the package.'],
          ['remote_module', /\bimport\s*(?:\(\s*|(?:[^'"]+\s+from\s*)?)(['"`])(?:https?:)?\/\//g,
            'JavaScript imports a remote module; dependencies must be bundled in the package.'],
          ['remote_css_import', /@import\s+(?:url\(\s*)?['"]?(?:https?:)?\/\//gi,
            'Stylesheet imports a remote resource; dependencies must be bundled in the package.'],
        ];
        for (const [code, pattern, message] of checks) {
          for (const match of source.matchAll(pattern)) {
            if (findingsCapped()) break;
            error(code, message, path, lineNumberAt(source, match.index));
          }
          if (findingsCapped()) break;
        }

        if (/\.(?:js|mjs|cjs)$/i.test(path)) {
          const lines = source.split(/\r?\n/);
          if (lines.some(line => line.length > 1000)) {
            warning('minified_source', 'Long single-line source may be minified or obfuscated; inspect it manually.', path);
          }
          const escapedCharacters = (source.match(/\\x[0-9a-f]{2}|\\u[0-9a-f]{4}/gi) || []).length;
          if (escapedCharacters > 20) {
            warning('obfuscated_source', 'Large numbers of escaped characters may indicate obfuscation; inspect it manually.', path);
          }
        }

        const domains = new Set();
        for (const match of source.matchAll(/https?:\/\/([^/'"`\s)]+)/gi)) {
          const host = match[1].toLowerCase().replace(/:\d+$/, '');
          if (host && !['localhost', '127.0.0.1'].includes(host)) domains.add(host);
        }
        if (domains.size) {
          warning('network_reference', `Review outbound network references: ${[...domains].slice(0, 10).join(', ')}.`, path);
        }
      }

      const entry = pkg.manifest?.entry;
      if (typeof entry === 'string' && !Object.hasOwn(files, entry)) {
        error('missing_entry', `Manifest entry "${entry}" is not included in package files.`, entry);
      }
      const unrestrictedEntry = pkg.manifest?.unrestrictedEntry;
      if (unrestrictedEntry !== undefined) {
        if (typeof unrestrictedEntry !== 'string'
          || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9_./-]+\.js$/i.test(unrestrictedEntry)
          || !Object.hasOwn(files, unrestrictedEntry)) {
          error('invalid_unrestricted_entry', 'Manifest unrestrictedEntry must refer to a packaged file.', String(unrestrictedEntry));
        }
      }
    }

    if (Array.isArray(pkg.manifest?.permissions) && pkg.manifest.permissions.includes('system:root')) {
      warning('root_permission', 'system:root requires a compelling justification and careful human review.');
    }
    if (Array.isArray(pkg.manifest?.permissions) && pkg.manifest.permissions.length) {
      warning('permission_rationale', 'Verify every requested permission is necessary and has a clear human-readable justification.');
    }
  }

  return {
    version: 1,
    checked_at: now,
    passed: errors.length === 0,
    errors,
    warnings,
    manual_checks: MANUAL_REVIEW_CHECKS,
  };
}
