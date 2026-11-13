import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const { createServerEnv, getMainWindowOptions } = createRequire(import.meta.url)('../../scripts/startup.js');

describe('startup server environment', () => {
  const originalSecret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    else process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = originalSecret;
  });

  it('passes the generated system API secret to the server child', () => {
    const serverEnv = createServerEnv();
    expect(serverEnv.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(serverEnv.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET)
      .toBe(process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET);
  });

  it('opens the kiosk NovaByte window fullscreen, frameless, and non-resizable', () => {
    expect(getMainWindowOptions(true)).toMatchObject({
      title: 'NovaByte',
      fullscreen: true,
      kiosk: true,
      frame: false,
      resizable: false,
    });
  });

  it('keeps regular development windows windowed and framed', () => {
    expect(getMainWindowOptions(false)).toMatchObject({
      title: 'NovaByte',
      fullscreen: false,
      kiosk: false,
      frame: true,
      resizable: true,
    });
  });
});
