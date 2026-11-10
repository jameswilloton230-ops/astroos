import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const { createServerEnv } = createRequire(import.meta.url)('../../scripts/startup.js');

describe('startup server environment', () => {
  const originalSecret = process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET;
    else process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET = originalSecret;
  });

  it('passes the generated system API secret to the server child', () => {
    const serverEnv = createServerEnv();
    expect(serverEnv.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(serverEnv.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET)
      .toBe(process.env.ASTROOS_SYSTEM_API_RATE_LIMIT_SECRET);
  });
});
