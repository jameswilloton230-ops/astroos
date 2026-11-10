'use strict';

require('dotenv').config();

function validateEnvironment() {
  const errors = [];

  // Required secrets (must be non-empty hex strings)
  const secrets = ['NBOSP_CRED_KEY', 'SESSION_SECRET'];
  for (const key of secrets) {
    const val = (process.env[key] || '').trim();
    if (!val) {
      errors.push(`${key} is missing or empty`);
    } else if (!/^[0-9a-f]{32,}$/i.test(val)) {
      errors.push(`${key} must be a valid hex string (at least 32 characters), got "${val.slice(0, 20)}..."`);
    }
  }

  // Numeric configuration validation
  const numericVars = {
    PORT:                    [1, 65535],
    RATE_LIMIT_WINDOW_MS:    [1, 86_400_000],
    RATE_LIMIT_MAX_REQUESTS: [1, 1_000_000],
  };

  for (const [key, [min, max]] of Object.entries(numericVars)) {
    const val = process.env[key];
    if (val === undefined) {
      errors.push(`${key} is missing`);
      continue;
    }
    const num = parseInt(val, 10);
    if (!Number.isInteger(num) || num < min || num > max) {
      errors.push(`${key}="${val}" must be an integer between ${min} and ${max}`);
    }
  }

  // Format validation for CORS origins
  if (process.env.CORS_ORIGIN) {
    const origins = process.env.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
    const invalid = origins.filter(u => !u.startsWith('https://') && !u.startsWith('http://localhost'));
    if (invalid.length > 0) {
      errors.push(`CORS_ORIGIN contains invalid origins: ${invalid.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    const msg = `[Server] Environment validation failed:\n\n${errors.map(e => `  - ${e}`).join('\n')}\n`;
    throw new Error(msg);
  }
}

module.exports = { validateEnvironment };