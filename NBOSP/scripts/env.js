'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { getRuntimeDataDir } = require('./runtime-data-dir');

function parseDotenv(content) {
  const env = {};
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('export ')) {
      line = line.slice(7).trim();
    }

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!key) continue;

    let val = line.slice(eq + 1).trim();

    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1)
        .replace(/\\\\/g, '\0')
        .replace(/\\"/g, '"')
        .replace(/\0/g, '\\');
    } else if (val.length >= 2 && val.startsWith("'") && val.endsWith("'")) {
      val = val.slice(1, -1);
    }

    env[key] = val;
  }
  return env;
}

async function parseEnvFile(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return parseDotenv(content);
  } catch (_) {
    return null;
  }
}

async function atomicWriteEnv(filePath, env) {
  const rand = crypto.randomBytes(4).toString('hex');
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${rand}.tmp`;

  const content = Object.entries(env)
    .map(([k, v]) => {
      const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${k}="${escaped}"`;
    })
    .join('\n') + '\n';

  try {
    await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    throw err;
  }

  try {
    await fs.promises.rename(tempPath, filePath);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EACCES' || err.code === 'EPERM') {
      try {
        await fs.promises.unlink(filePath);
        await fs.promises.rename(tempPath, filePath);
      } catch (innerErr) {
        try { await fs.promises.unlink(tempPath); } catch (_) {}
        throw innerErr;
      }
    } else {
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      throw err;
    }
  }
}

const parsePort        = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 65535; };
const parsePositiveInt = v => { const n = Number(v); return Number.isInteger(n) && n >= 1; };
const parseCorsOrigin  = v => {
  if (!v) return false;
  const urls = v.split(',').map(u => u.trim()).filter(Boolean);
  try {
    return urls.length > 0 && urls.every(u => new URL(u).protocol === 'https:');
  } catch (_) {
    return false;
  }
};

const SCHEMA = {
  PORT:                    v => parsePort(v)        ? null : 'must be integer 1–65535',
  RATE_LIMIT_WINDOW_MS:    v => parsePositiveInt(v) ? null : 'must be a positive integer',
  RATE_LIMIT_MAX_REQUESTS: v => parsePositiveInt(v) ? null : 'must be a positive integer',
  CORS_ORIGIN:             v => parseCorsOrigin(v)  ? null : 'must be comma-separated https:// URLs',
  SESSION_SECRET:          v => v && v.length >= 128 ? null : `must be 128+ char hex string (got length ${v ? v.length : 0})`,
  NBOSP_CRED_KEY:          v => v && v.length >= 64  ? null : `must be 64+ char hex string (got length ${v ? v.length : 0})`,
};

/**
 * Load .env, generate missing secrets, validate schema, and merge into process.env.
 *
 * @param {string} appDir
 */
async function ensureEnv(appDir) {
  const dataDir     = getRuntimeDataDir(appDir);
  const envPath     = path.join(dataDir, '.env');
  const examplePath = path.join(appDir, '.env.example');

  let env = await parseEnvFile(envPath);
  if (!env || Object.keys(env).length === 0) {
    console.log('[NovaByte] No .env found — bootstrapping from .env.example...');
    const example = await parseEnvFile(examplePath);
    if (!example || Object.keys(example).length === 0) {
      throw new Error('[NovaByte] FATAL: .env and .env.example are both missing or empty.');
    }
    env = { ...example };
  }
  if (process.platform === 'linux' && env.NODE_EXTRA_CA_CERTS && !path.isAbsolute(env.NODE_EXTRA_CA_CERTS)) {
    env.NODE_EXTRA_CA_CERTS = path.join(dataDir, env.NODE_EXTRA_CA_CERTS);
  }

  const SECRETS = { SESSION_SECRET: 64, NBOSP_CRED_KEY: 32 };
  const missing = {};
  for (const [key, byteLen] of Object.entries(SECRETS)) {
    if (!(env[key] || '').trim()) {
      console.log(`[NovaByte] Generating missing ${key}...`);
      missing[key] = crypto.randomBytes(byteLen).toString('hex');
    }
  }

  if (Object.keys(missing).length > 0) {
    Object.assign(env, missing);
    await fs.promises.mkdir(dataDir, { recursive: true });
    await atomicWriteEnv(envPath, env);
    console.log('[NovaByte] .env updated with generated secrets (atomic write).');
  }

  const errors = Object.entries(SCHEMA)
    .map(([key, validate]) => {
      const err = validate(env[key] || '');
      return err ? `  ${key}: ${err}` : null;
    })
    .filter(Boolean);

  if (errors.length > 0) {
    throw new Error(`[NovaByte] .env validation failed:\n${errors.join('\n')}\n\nFix .env and restart.`);
  }

  const inheritedNodeEnv = process.env.NODE_ENV;
  Object.assign(process.env, env);
  if (inheritedNodeEnv) process.env.NODE_ENV = inheritedNodeEnv;
  console.log('[NovaByte] .env loaded, validated, and applied.');
}

module.exports = { ensureEnv };