#!/usr/bin/env node

/**
 * AstroOS App Builder
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
 * ── Signing (AOSP-style test keys) ──────────────────────────
 *
 * Generated packages are signed with the Astro System Ed25519 key
 * (signer identity "Astro System").
 *
 * Key selection follows the Android/AOSP model (see keys/README.md):
 *
 *   1. ASTROOS_SYSTEM_SIGNING_KEY_PATH — path to a JWK JSON file holding
 *      your OFFLINE release private key (never committed).
 *   2. ASTROOS_SYSTEM_SIGNING_KEY      — inline JWK JSON (same rule).
 *   3. Default: the PUBLIC test pair committed at
 *      astro-os/keys/test-system-key.json — AstroOS's equivalent of
 *      AOSP's platform test keys.
 *
 * A fresh clone or fork with no configuration therefore builds
 * TEST-SIGNED packages that verify as "Astro System" against the
 * trust-store anchor — exactly like an AOSP build signed with the
 * public platform test keys boots and works out of the box. Packages
 * built this way carry signing.tier "test" and the OS reports
 * systemSignatureTier() "test-keys".
 *
 * A configured env key is treated as the RELEASE key: packages carry
 * signing.tier "release" and the matching trust anchor must be rotated
 * on the serving side through ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK (the
 * server injects it into the page; see trust-store.js).
 *
 * The 2026-11-12 audit (F1) removed a committed development key whose
 * private half matched the trust anchor while the build still REQUIRED
 * an env key — producing unsigned, unverifiable packages for every
 * fresh clone, which broke forks. The AOSP-style committed test key
 * restores the working default without pretending the test key is a
 * secret: it is public on purpose, honestly labelled, and production
 * machines rotate per keys/README.md.
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
 * Priority (Android/AOSP model — see the header comment and
 * astro-os/keys/README.md):
 *   1. ASTROOS_SYSTEM_SIGNING_KEY_PATH — release private key file (JWK)
 *   2. ASTROOS_SYSTEM_SIGNING_KEY     — release private key inline JWK JSON
 *   3. The committed public test pair at keys/test-system-key.json
 * A supplied-but-malformed key is a hard error — a silently-wrong
 * signature would be worse than no signature. An empty-string env var
 * counts as unset, so a plain `node build-apps.mjs` in a fresh clone
 * still gets test-key signing.
 */
const DEFAULT_SIGNER = 'Astro System';
const TEST_KEY_PATH = path.join(projectRoot, 'keys', 'test-system-key.json');


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
 * Parses and validates an Ed25519 OKP private-key JWK.
 * @throws on malformed input — never silently.
 */
function parseEd25519PrivateJwk(raw, origin) {
  let jwk;

  try {
    jwk = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Signing key from ${origin} is not valid JSON: ${err.message}`
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

  return jwk;
}

/**
 * Loads the Ed25519 private signing key.
 *
 * Priority:
 *   1. ASTROOS_SYSTEM_SIGNING_KEY_PATH — path to a JWK JSON file holding
 *      the operator's OFFLINE release key (keep the file outside this
 *      repository).
 *   2. ASTROOS_SYSTEM_SIGNING_KEY     — inline JWK JSON string (release).
 *   3. The committed AOSP-style public test pair at
 *      astro-os/keys/test-system-key.json — the default every fresh clone
 *      and fork signs with, so default builds verify as
 *      'Astro System' everywhere.
 *
 * Returns { key, tier, origin } — tier is 'release' for env-supplied
 * keys and 'test' for the committed test pair. A key that IS supplied
 * but malformed is a hard error — a silently-wrong signature would be
 * worse than no signature.
 */
async function loadSigningKey() {
  const keyPath = process.env.ASTROOS_SYSTEM_SIGNING_KEY_PATH;
  const keyInline = process.env.ASTROOS_SYSTEM_SIGNING_KEY;

  let raw = null;
  let origin = '';
  let tier = 'test';

  if (typeof keyPath === 'string' && keyPath.length > 0) {
    origin = keyPath;
    tier = 'release';
    try {
      raw = await readFile(keyPath, 'utf8');
    } catch (err) {
      throw new Error(
        `Unable to read signing key at ${keyPath}: ${err.message}`
      );
    }
  } else if (typeof keyInline === 'string' && keyInline.trim().length > 0) {
    origin = 'ASTROOS_SYSTEM_SIGNING_KEY (inline)';
    tier = 'release';
    raw = keyInline;
  } else {
    origin = TEST_KEY_PATH;
    try {
      raw = await readFile(TEST_KEY_PATH, 'utf8');
    } catch (err) {
      throw new Error(
        `Default test signing key missing at ${TEST_KEY_PATH}: ${err.message}. ` +
        'Restore astro-os/keys/test-system-key.json (see keys/README.md) or set ' +
        'ASTROOS_SYSTEM_SIGNING_KEY_PATH / ASTROOS_SYSTEM_SIGNING_KEY.'
      );
    }
  }

  const jwk = parseEd25519PrivateJwk(raw, origin);

  return {
    key: createPrivateKey({
      key: jwk,
      format: 'jwk',
    }),
    tier,
    origin,
  };
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
 * Signs the canonical payload using Ed25519. `tier` records HOW the
 * build was signed — 'test' (the committed AOSP-style public test key)
 * or 'release' (an env-supplied offline key) — so downstream surfaces
 * can label test-key builds honestly, the way Android tags
 * ro.build.tags=test-keys. The tier lives INSIDE pkg.signing, which is
 * excluded from createSigningPayload(), so it cannot affect the
 * signature bytes.
 */
function signPackage(pkg, privateKey, tier) {
  const payload = createSigningPayload(pkg);
  const signature = sign(null, Buffer.from(payload, 'utf8'), privateKey);

  return {
    method: 'ed25519',
    signer: DEFAULT_SIGNER,
    tier: tier === 'release' ? 'release' : 'test',
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

  /* The runtime SystemServiceLoader rejects a bundle entry without
   * systemService: true — the production build (build.mjs) stamps it from
   * each package manifest. Dev builds used to write bare
   * { id, file, cacheKey } entries, so every system service failed the
   * loader's entry validation and dev machines booted without the
   * session/lock-screen/tray services. Stamp the same flag here so a
   * dev manifest and a production manifest are interchangeable. */
  let changed = false;
  const manifestIds = new Set(manifest.map(bundle => bundle?.id));
  for (const bundle of manifest) {
    const built = builtPackages.get(bundle?.id);
    if (built) {
      if (bundle.cacheKey !== built.cacheKey) {
        bundle.cacheKey = built.cacheKey;
        changed = true;
      }
      if (built.systemService === true && bundle.systemService !== true) {
        bundle.systemService = true;
        changed = true;
      }
    }
  }
  for (const [id, built] of builtPackages) {
    if (manifestIds.has(id)) continue;
    manifest.push({
      id,
      file: `js/apps/${id}.novaapp`,
      cacheKey: built.cacheKey,
      ...(built.systemService === true ? { systemService: true } : {}),
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
  signing
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
   * Sign the package before writing it. Every build signs now — default
   * builds with the committed AOSP-style test pair (tier 'test'), env-
   * configured builds with the operator's offline release key (tier
   * 'release'). `signing` itself is excluded from the signing payload,
   * so the signature does not end up signing itself.
   */
  pkg.signing = signPackage(
    pkg,
    signing.key,
    signing.tier
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
    }, ${`signed as ${pkg.signing.signer} (${signing.tier === 'release' ? 'release key' : 'TEST KEY'})`}, source untouched)`
  );
  return { id: appId, cacheKey, systemService: manifest.systemService === true };
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

  const signing =
    await loadSigningKey();

  if (signing.tier === 'release') {
    console.log(
      `Signing key: RELEASE key from ${signing.origin}`
    );
    console.log(
      `Signer: ${DEFAULT_SIGNER} (tier: release)`
    );
    console.log(
      'Signature: Ed25519'
    );
    console.log(
      'Rotate the runtime anchor to match: set ASTROOS_SYSTEM_SIGNING_PUBLIC_JWK'
    );
    console.log(
      'for the server so trust-store.js verifies against this key (see keys/README.md).'
    );
  } else {
    console.log(
      'Signing key: AOSP-style PUBLIC test key (astro-os/keys/test-system-key.json)'
    );
    console.log(
      `Signer: ${DEFAULT_SIGNER} (tier: test — build reports test-keys)`
    );
    console.log(
      'Signature: Ed25519'
    );
  }

  console.log(
    `Building ${dirs.length} app(s) from ${appsDir}\n`
  );

  const builtPackages = new Map();
  for (const dirName of dirs) {
    const built = await buildOne(
      dirName,
      signing
    );
    if (built) builtPackages.set(built.id, built);
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