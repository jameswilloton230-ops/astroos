'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// ── Inline env parser ─────────────────────────────────────────────────────────
// Replaces dotenv.parse — we only need this one function, and inlining it avoids
// the module-resolution quirk where NW.js fails to find packages required from
// a scripts/ subdirectory.

function parseDotenv(content) {
  const env = {};
  for (const raw of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    // Strip matching outer quotes and unescape \" and \\ inside double-quoted values
    if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function parseEnvFile(filePath) {
  try {
    return parseDotenv(await fs.promises.readFile(filePath, 'utf8'));
  } catch (_) { return null; }
}

/**
 * Write env object to filePath atomically (temp → rename).
 * All values are double-quoted so spaces, $, #, and special chars survive a
 * round-trip through parseDotenv.
 */
async function atomicWriteEnv(filePath, env) {
  const tempPath = filePath + '.tmp';
  const content  = Object.entries(env)
    .map(([k, v]) => {
      const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${k}="${escaped}"`;
    })
    .join('\n') + '\n';

  await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });

  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EACCES') {
      // Windows can't atomically overwrite an existing file
      await fs.promises.unlink(filePath);
      await fs.promises.rename(tempPath, filePath);
    } else {
      // Clean up before re-throwing so we don't orphan .tmp files
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      throw err;
    }
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

const parsePort        = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535; };
const parsePositiveInt = v => { const n = Number(v); return Number.isInteger(n) && n >= 1; };
const parseCorsOrigin  = v => {
  if (!v) return false;
  const urls = v.split(',').map(u => u.trim()).filter(Boolean);
  try { return urls.length > 0 && urls.every(u => new URL(u).protocol === 'https:'); }
  catch (_) { return false; }
};

const SCHEMA = {
  PORT:                    v => parsePort(v)        ? null : 'must be integer 1–65535',
  RATE_LIMIT_WINDOW_MS:    v => parsePositiveInt(v) ? null : 'must be a positive integer',
  RATE_LIMIT_MAX_REQUESTS: v => parsePositiveInt(v) ? null : 'must be a positive integer',
  CORS_ORIGIN:             v => parseCorsOrigin(v)  ? null : 'must be comma-separated https:// URLs',
  // Log length only — never print secret values
  SESSION_SECRET: v => v && v.length >= 128 ? null : `must be 128+ char hex string (got length ${v ? v.length : 0})`,
  NBOSP_CRED_KEY: v => v && v.length >= 64  ? null : `must be 64+ char hex string (got length ${v ? v.length : 0})`,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load .env (bootstrapping from .env.example if absent), generate any missing
 * secrets, validate the schema, and merge into process.env.
 *
 * @param {string} appDir  Directory that contains .env / .env.example
 */
async function ensureEnv(appDir) {
  const envPath     = path.join(appDir, '.env');
  const examplePath = path.join(appDir, '.env.example');

  // 1. Load .env, or fall back to .env.example
  let env = await parseEnvFile(envPath);
  if (!env || Object.keys(env).length === 0) {
    console.log('[NovaByte] No .env found — bootstrapping from .env.example...');
    const example = await parseEnvFile(examplePath);
    if (!example || Object.keys(example).length === 0) {
      throw new Error('[NovaByte] FATAL: .env and .env.example are both missing or empty.');
    }
    env = { ...example };
  }

  // 2. Generate missing secrets
  const SECRETS = { SESSION_SECRET: 64, NBOSP_CRED_KEY: 32 };
  const missing  = {};
  for (const [key, byteLen] of Object.entries(SECRETS)) {
    if (!(env[key] || '').trim()) {
      console.log(`[NovaByte] Generating missing ${key}...`);
      missing[key] = crypto.randomBytes(byteLen).toString('hex');
    }
  }
  if (Object.keys(missing).length > 0) {
    Object.assign(env, missing);
    await atomicWriteEnv(envPath, env);
    console.log('[NovaByte] .env updated with generated secrets (atomic write).');
  }

  // 3. Schema validation
  const errors = Object.entries(SCHEMA)
    .map(([key, validate]) => {
      const err = validate(env[key] || '');
      return err ? `  ${key}: ${err}` : null;
    })
    .filter(Boolean);

  if (errors.length > 0) {
    throw new Error(`[NovaByte] .env validation failed:\n${errors.join('\n')}\n\nFix .env and restart.`);
  }

  Object.assign(process.env, env);
  console.log('[NovaByte] .env loaded, validated, and applied.');
}

module.exports = { ensureEnv };