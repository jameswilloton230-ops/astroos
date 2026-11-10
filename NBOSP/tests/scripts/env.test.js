import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ensureEnv } = require('../../scripts/env.js');

const tempDirs = [];
const envSnapshot = { ...process.env };

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-env-'));
  tempDirs.push(dir);
  return dir;
}

const SECRET_OK = 'f'.repeat(128);
const CRED_OK = 'e'.repeat(64);
const VALID_EXAMPLE = [
  'PORT=3003',
  'RATE_LIMIT_WINDOW_MS=900000',
  'RATE_LIMIT_MAX_REQUESTS=100',
  'CORS_ORIGIN=https://localhost:3003',
  `SESSION_SECRET=${SECRET_OK}`,
  `NBOSP_CRED_KEY=${CRED_OK}`,
].join('\n');

describe('scripts/env.js — ensureEnv bootstrapping', () => {
  it('bootstraps .env from .env.example and generates missing secrets', async () => {
    const appDir = tmp();
    const dataDir = tmp();
    process.env.NBOSP_DATA_DIR = dataDir; // ensureEnv reads the data dir from here
    fs.writeFileSync(path.join(appDir, '.env.example'),
      'PORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://localhost:3003\n');
    await ensureEnv(appDir);

    const envPath = path.join(dataDir, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    const raw = fs.readFileSync(envPath, 'utf8');
    expect(raw).toContain('PORT="3003"');
    const sessionSecret = raw.match(/SESSION_SECRET="([0-9a-f]+)"/)?.[1];
    expect(sessionSecret?.length).toBe(128);
    const credKey = raw.match(/NBOSP_CRED_KEY="([0-9a-f]+)"/)?.[1];
    expect(credKey?.length).toBe(64);
    expect(process.env.SESSION_SECRET).toBe(sessionSecret);
    expect(process.env.NBOSP_CRED_KEY).toBe(credKey);
  });

  it('does not rewrite .env when secrets already exist', async () => {
    const appDir = tmp();
    const dataDir = tmp();
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.NBOSP_DATA_DIR = dataDir;
    const envPath = path.join(dataDir, '.env');
    fs.writeFileSync(envPath, VALID_EXAMPLE + '\n');
    const before = fs.statSync(envPath).mtimeMs;
    await ensureEnv(appDir);
    expect(fs.statSync(envPath).mtimeMs).toBe(before);
    expect(process.env.PORT).toBe('3003');
  });

  it('throws a FATAL error when both .env and .env.example are missing', async () => {
    const appDir = tmp();
    process.env.NBOSP_DATA_DIR = tmp();
    await expect(ensureEnv(appDir)).rejects.toThrow('FATAL: .env and .env.example are both missing or empty');
  });

  it('rejects values that fail the schema', async () => {
    const appDir = tmp();
    process.env.NBOSP_DATA_DIR = tmp();
    fs.writeFileSync(path.join(appDir, '.env.example'),
      'PORT=99999\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://x.com\n'
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await expect(ensureEnv(appDir)).rejects.toThrow('PORT: must be integer 1–65535');
  });

  it('rejects short secrets with the expected length in the message', async () => {
    const appDir = tmp();
    process.env.NBOSP_DATA_DIR = tmp();
    fs.writeFileSync(path.join(appDir, '.env.example'),
      `PORT=3003\nSESSION_SECRET=tooshort\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await expect(ensureEnv(appDir)).rejects.toThrow('SESSION_SECRET: must be 128+ char hex string (got length 8)');
  });

  it('rejects CORS origins that are not comma-separated https URLs', async () => {
    const appDir = tmp();
    const dataDir = tmp();
    process.env.NBOSP_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(appDir, '.env.example'),
      `PORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=http://insecure.com,https://ok.com\n`
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await expect(ensureEnv(appDir)).rejects.toThrow('CORS_ORIGIN: must be comma-separated https:// URLs');

    const appDir2 = tmp();
    fs.writeFileSync(path.join(appDir2, '.env.example'),
      `PORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://a.com, https://b.com\n`
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await expect(ensureEnv(appDir2)).resolves.toBeUndefined();
    expect(process.env.CORS_ORIGIN).toBe('https://a.com, https://b.com');
  });
});

describe('scripts/env.js — dotenv parsing details', () => {
  it('understands export prefixes, quoted values and escapes', async () => {
    const appDir = tmp();
    const dataDir = tmp();
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.NBOSP_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, '.env'), [
      '# a comment line',
      '',
      'export PORT=3003',
      'RATE_LIMIT_WINDOW_MS=900000',
      'RATE_LIMIT_MAX_REQUESTS=100',
      'CORS_ORIGIN=https://localhost:3003',
      `SESSION_SECRET="${SECRET_OK}"`,
      `NBOSP_CRED_KEY='${CRED_OK}'`,
      'QUOTED_BACKSLASH="a\\\\b\\"c"', // parsed backslash escapes inside double quotes
    ].join('\n'));
    await ensureEnv(appDir);
    expect(process.env.PORT).toBe('3003');
    expect(process.env.SESSION_SECRET).toBe(SECRET_OK);
    expect(process.env.NBOSP_CRED_KEY).toBe(CRED_OK);
    expect(process.env.QUOTED_BACKSLASH).toBe('a\\b"c');
  });

  it('absolutises a relative NODE_EXTRA_CA_CERTS on linux (platform behaviour)', async () => {
    if (process.platform !== 'linux') return; // the rule only applies on linux
    const appDir = tmp();
    const dataDir = tmp();
    process.env.NBOSP_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(appDir, '.env.example'),
      `PORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://x.com\nNODE_EXTRA_CA_CERTS=my-ca.pem\n`
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await ensureEnv(appDir);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(path.join(dataDir, 'my-ca.pem'));

    const appDir2 = tmp();
    fs.writeFileSync(path.join(appDir2, '.env.example'),
      `PORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://x.com\nNODE_EXTRA_CA_CERTS=/already/absolute/ca.pem\n`
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await ensureEnv(appDir2);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe('/already/absolute/ca.pem');
  });

  it('preserves an inherited NODE_ENV across the env merge', async () => {
    const appDir = tmp();
    process.env.NBOSP_DATA_DIR = tmp();
    process.env.NODE_ENV = 'test';
    fs.writeFileSync(path.join(appDir, '.env.example'),
      `NODE_ENV=production\nPORT=3003\nRATE_LIMIT_WINDOW_MS=900000\nRATE_LIMIT_MAX_REQUESTS=100\nCORS_ORIGIN=https://x.com\n`
      + `SESSION_SECRET=${SECRET_OK}\nNBOSP_CRED_KEY=${CRED_OK}\n`);
    await ensureEnv(appDir);
    expect(process.env.NODE_ENV).toBe('test');
  });
});
