#!/usr/bin/env node

/**
 * NBOSP App Builder
 * ────────────────────────────────────────────────────────────
 * Repackages every app under js/apps/<id>/ into a single
 * js/apps/<id>.novaapp file.
 *
 * Every file in the app folder is bundled (manifest, html, js, css,
 * assets/, images, fonts, whatever's there), recursing into
 * subdirectories.
 *
 * The one exception is _package-meta.json — that's leftover metadata
 * from a previous build, not something the app loads at runtime, so
 * re-bundling it would embed a stale signature block inside the new
 * package.
 *
 * This script never deletes or modifies the source folder. It only
 * writes the .novaapp file alongside it.
 *
 * ── Signing ─────────────────────────────────────────────────
 *
 * Generated packages are signed using the Ed25519 private key stored at:
 *
 *   NBOSP/keys/test-system-key.json
 *
 * The signer identity is:
 *
 *   NovaByte System
 *
 * The package signing payload is signed using Ed25519, matching the
 * runtime package verifier.
 *
 * IMPORTANT:
 *
 * The bundled test-system-key.json contains a deliberately public
 * development/test private key. Anyone building upon NBOSP can use it
 * to test the System signing flow.
 *
 * Because the private key is intentionally distributed, signatures
 * produced with this key MUST NOT be considered proof of genuine
 * production System authorization.
 *
 * For actual System privilege protection, replace the test key with
 * your own privately-held Ed25519 key pair.
 *
 * Keep your private key outside the repository and commit ONLY the
 * corresponding public key to trust-store.js.
 *
 * You can also change DEFAULT_SIGNER if your fork uses a different
 * signer identity, but it must match the identity expected by the
 * package verification logic.
 *
 * Usage:
 *
 *   node build-apps.mjs [apps-dir] [app-directory ...]
 *
 * Defaults to js/apps relative to this script's location.
 */

import {
  readdir,
  readFile,
  writeFile,
  stat,
} from 'node:fs/promises';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHash,
  createPrivateKey,
  sign,
} from 'node:crypto';

const EXCLUDED_FILES = new Set([
  '_package-meta.json',
]);

const scriptDir = path.dirname(
  fileURLToPath(import.meta.url)
);

const projectRoot = scriptDir;

const appsDir = path.resolve(
  process.argv[2] ??
    path.join(projectRoot, 'js', 'apps')
);
const requestedApps = process.argv.slice(3);

/*
 * ── Signing configuration ─────────────────────────────────────────────
 *
 * This is the intentionally-public NBOSP development/test key.
 *
 * The matching private key is located at:
 *
 *   NBOSP/keys/test-system-key.json
 *
 * Anyone building upon NBOSP may use it for development and testing.
 *
 * For real System privilege protection, replace the test private key
 * with your own privately-held Ed25519 key and replace the public key
 * in trust-store.js with the corresponding public key.
 */
const DEFAULT_SIGNER = 'NovaByte System';

const TEST_SIGNING_KEY_PATH = path.join(
  projectRoot,
  'keys',
  'test-system-key.json'
);

/**
 * Recursively collects every file under `dir`.
 *
 * Paths returned by this function are relative to `baseDir` and always
 * use forward slashes so the package's file keys remain portable.
 */
async function collectFiles(dir, baseDir) {
  const entries = await readdir(dir, {
    withFileTypes: true,
  });

  const out = [];

  for (const entry of entries) {
    const fullPath = path.join(
      dir,
      entry.name
    );

    if (entry.isDirectory()) {
      out.push(
        ...(await collectFiles(
          fullPath,
          baseDir
        ))
      );

      continue;
    }

    if (EXCLUDED_FILES.has(entry.name)) {
      continue;
    }

    const relPath = path
      .relative(baseDir, fullPath)
      .split(path.sep)
      .join('/');

    out.push(relPath);
  }

  /*
   * Sorting makes the package deterministic with respect to filesystem
   * enumeration order.
   */
  return out.sort();
}

/**
 * Loads the Ed25519 private signing key from the test-key JSON file.
 *
 * The test key is intentionally distributed with NBOSP so developers
 * can immediately test package signing.
 *
 * Production forks should replace this with a private key that is NOT
 * committed to the repository.
 */
async function loadSigningKey() {
  let raw;

  try {
    raw = await readFile(
      TEST_SIGNING_KEY_PATH,
      'utf8'
    );
  } catch (err) {
    throw new Error(
      `Unable to read signing key at ${TEST_SIGNING_KEY_PATH}: ${err.message}`
    );
  }

  let jwk;

  try {
    jwk = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Signing key is not valid JSON: ${err.message}`
    );
  }

  if (!jwk || typeof jwk !== 'object') {
    throw new Error(
      'Signing key must contain a JWK object.'
    );
  }

  if (
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519'
  ) {
    throw new Error(
      'Signing key must be an Ed25519 OKP JWK.'
    );
  }

  if (
    typeof jwk.x !== 'string' ||
    !jwk.x
  ) {
    throw new Error(
      'Signing key does not contain an Ed25519 public `x` value.'
    );
  }

  if (
    typeof jwk.d !== 'string' ||
    !jwk.d
  ) {
    throw new Error(
      'Signing key does not contain an Ed25519 private `d` value.'
    );
  }

  return createPrivateKey({
    key: jwk,
    format: 'jwk',
  });
}

/**
 * Creates the exact deterministic byte representation that is signed.
 *
 * IMPORTANT:
 *
 * The `signing` field is deliberately excluded because it contains
 * the signature itself. Including it would create a circular signing
 * dependency.
 *
 * The verifier MUST construct this same payload before verification.
 */
function createSigningPayload(pkg) {
  return JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at,
  });
}

/**
 * Signs the canonical payload using Ed25519.
 */
function signPackage(pkg, privateKey) {
  const payload = createSigningPayload(pkg);
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey);

  return {
    method: 'ed25519',
    signer: DEFAULT_SIGNER,
    signature: signature.toString('hex'),
  };
}

function computePackageIntegrity(pkg) {
  const hash = (data) => createHash('sha512').update(data).digest('hex');
  const payloadHash = hash(createSigningPayload(pkg));
  const fileHashes = Object.fromEntries(
    Object.entries(pkg.files).map(([file, encoded]) => [
      file,
      hash(Buffer.from(encoded, 'base64')),
    ])
  );
  return { method: 'sha512', payloadHash, fileHashes };
}

function computePackageCacheKey(pkg) {
  return createHash('sha256')
    .update(JSON.stringify({ manifest: pkg.manifest, files: pkg.files }))
    .digest('hex');
}

async function updatePackageCacheKeys(builtPackages) {
  const manifestPath = path.join(appsDir, 'novaapp-manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`Cannot update NovaApp cache keys in ${manifestPath}: ${error.message}`);
  }
  if (!Array.isArray(manifest)) {
    throw new Error(`Cannot update NovaApp cache keys: ${manifestPath} must contain an array`);
  }

  let changed = false;
  const manifestIds = new Set(manifest.map(bundle => bundle?.id));
  for (const bundle of manifest) {
    const cacheKey = builtPackages.get(bundle?.id);
    if (cacheKey && bundle.cacheKey !== cacheKey) {
      bundle.cacheKey = cacheKey;
      changed = true;
    }
  }
  for (const [id, cacheKey] of builtPackages) {
    if (manifestIds.has(id)) continue;
    manifest.push({
      id,
      file: `js/apps/${id}.novaapp`,
      cacheKey,
    });
    changed = true;
  }
  if (changed) {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

/**
 * Builds one application package in memory.
 */
async function packageApp(appDir) {
  const manifestRaw = await readFile(
    path.join(appDir, 'manifest.json'),
    'utf8'
  );

  const manifest = JSON.parse(
    manifestRaw
  );

  const relPaths = await collectFiles(
    appDir,
    appDir
  );

  const files = {};

  for (const relPath of relPaths) {
    const buf = await readFile(
      path.join(appDir, relPath)
    );

    files[relPath] = buf.toString(
      'base64'
    );
  }

  // Preserve a manifest-declared alternate entry from the existing package
  // only when that entry has no source copy in the app directory.
  if (manifest.unrestrictedEntry && !files[manifest.unrestrictedEntry]) {
    const appId = manifest.id ?? path.basename(appDir);
    const existingPackagePath = path.join(appsDir, `${appId}.novaapp`);
    let existingPackage;
    try {
      existingPackage = JSON.parse(await readFile(existingPackagePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Cannot preserve manifest unrestrictedEntry "${manifest.unrestrictedEntry}" from ${existingPackagePath}: ${err.message}`
      );
    }
    const bundledEntry = existingPackage.files?.[manifest.unrestrictedEntry];
    if (typeof bundledEntry !== 'string') {
      throw new Error(
        `Manifest unrestrictedEntry "${manifest.unrestrictedEntry}" is missing from both ${appDir} and ${existingPackagePath}`
      );
    }
    files[manifest.unrestrictedEntry] = bundledEntry;
  }

  return {
    novabyte_app: true,
    compiled_at: Date.now(),
    manifest,
    files,

    /*
     * Filled after the package has been assembled and before it is
     * written to disk.
     */
    signing: {
      method: 'none',
    },

    integrity: {
      method: 'none',
    },
  };
}

async function buildOne(
  appDirName,
  privateKey
) {
  const appDir = path.join(
    appsDir,
    appDirName
  );

  const manifestPath = path.join(
    appDir,
    'manifest.json'
  );

  try {
    await stat(manifestPath);
  } catch {
    console.log(
      `- skip ${appDirName}: no manifest.json, not an app dir`
    );

    return null;
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const pkg = await packageApp(
    appDir
  );

  const appId =
    pkg.manifest.id ??
    appDirName;

  /*
   * Sign the package before writing it.
   *
   * `signing` itself is excluded from the signing payload, so the
   * signature does not end up signing itself.
   */
  pkg.signing = signPackage(
    pkg,
    privateKey
  );
  pkg.signature = pkg.signing.signature;
  pkg.integrity = computePackageIntegrity(pkg);
  const cacheKey = computePackageCacheKey(pkg);

  const outPath = path.join(
    appsDir,
    `${appId}.novaapp`
  );

  const fileCount =
    Object.keys(pkg.files).length;

  await writeFile(
    outPath,
    JSON.stringify(pkg, null, 2)
  );

  console.log(
    `✓ ${appDirName} -> ${path.relative(
      appsDir,
      outPath
    )} (${fileCount} file${
      fileCount === 1 ? '' : 's'
    }, signed as ${pkg.signing.signer}, source untouched)`
  );
  return { id: appId, cacheKey };
}

async function main() {
  const entries = await readdir(
    appsDir,
    {
      withFileTypes: true,
    }
  );

  const availableDirs = entries
    .filter(
      (entry) => entry.isDirectory()
    )
    .map(
      (entry) => entry.name
    );
  const missingApps = requestedApps.filter(
    (name) => !availableDirs.includes(name)
  );
  if (missingApps.length > 0) {
    throw new Error(
      `App directory not found: ${missingApps.join(', ')}`
    );
  }
  const dirs = requestedApps.length > 0
    ? availableDirs.filter((name) => requestedApps.includes(name))
    : availableDirs;

  if (dirs.length === 0) {
    console.log(
      `No app directories found in ${appsDir}`
    );

    return;
  }

  console.log(
    `Loading signing key: ${path.relative(
      projectRoot,
      TEST_SIGNING_KEY_PATH
    )}`
  );

  console.log(
    `Signer: ${DEFAULT_SIGNER}`
  );

  console.log(
    'Signature: Ed25519'
  );

  console.log(
    `Building ${dirs.length} app(s) from ${appsDir}\n`
  );

  const privateKey =
    await loadSigningKey();

  const builtPackages = new Map();
  for (const dirName of dirs) {
    const built = await buildOne(
      dirName,
      privateKey
    );
    if (built) builtPackages.set(built.id, built.cacheKey);
  }
  await updatePackageCacheKeys(builtPackages);
}

main().catch((err) => {
  console.error(
    'Build failed:',
    err
  );

  process.exitCode = 1;
});