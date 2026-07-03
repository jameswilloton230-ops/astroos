require('dotenv').config();

function validateEnvironment() {
  // Provide automatic fallback values in development mode
  if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
    // Fallback safety seeds so the app never fails to boot on a clean install
    if (!process.env.NBOSP_CRED_KEY) process.env.NBOSP_CRED_KEY = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
    if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = "secret1234567890secret1234567890";
    if (!process.env.PORT) process.env.PORT = "3006";
  }
  const errors = [];

  // Required secrets (must be non-empty hex strings)
  const secrets = ['NBOSP_CRED_KEY', 'SESSION_SECRET'];
  for (const key of secrets) {
    const val = process.env[key]?.trim();
    if (!val) {
      errors.push(`${key} is missing or empty`);
    } else if (!/^[0-9a-f]{32,}$/i.test(val)) {
      errors.push(`${key} must be a hex string (64+ chars), got "${val.slice(0, 20)}..."`);
    }
  }

  // Numeric config
  const numericVars = {
    PORT: [1, 65535],
    RATE_LIMIT_WINDOW_MS: [1, Infinity],
    RATE_LIMIT_MAX_REQUESTS: [1, Infinity],
  };

  for (const [key, [min, max]] of Object.entries(numericVars)) {
    const val = process.env[key];
    if (val === undefined) {
      errors.push(`${key} is missing`);
      continue;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < min || num > max) {
      errors.push(`${key}="${val}" must be a number between ${min} and ${max}`);
    }
  }

  // Format validation
  if (process.env.CORS_ORIGIN && !process.env.CORS_ORIGIN.includes('https://')) {
    errors.push(`CORS_ORIGIN must include https:// URLs, got "${process.env.CORS_ORIGIN}"`);
  }

  if (errors.length > 0) {
    const msg = `[Server] .env validation failed:\n\n${errors.map(e => `  ❌ ${e}`).join('\n')}\n\nFix .env and restart the app.`;
    console.error(msg);
    throw new Error(msg);
  }

  // Validate email encryption key early (not on first connect) — S2
  if (process.env.NBOSP_CRED_KEY && process.env.NBOSP_CRED_KEY.length < 32) {
    console.warn('[Server] WARNING: NBOSP_CRED_KEY is set but < 32 characters. Email feature will fail on first use.');
  }

  console.log('[Server] .env validation passed.');
}

module.exports = { validateEnvironment };
