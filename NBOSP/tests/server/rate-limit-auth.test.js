import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import rateLimitAuth from '../../server/rate-limit-auth.js';

const { isTrustedSystemAppRequest } = rateLimitAuth;

const SECRET = 'test-rate-limit-secret';
const APP_ID = 'com.nbosp.email';

function makeRequest({ appId = APP_ID, timestamp = String(Date.now()), secret = SECRET } = {}) {
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}`)
        .digest('hex');
    const headers = {
        'x-nova-system-app': appId,
        'x-nova-system-time': timestamp,
        'x-nova-system-signature': signature,
    };
    return { get: (name) => headers[name.toLowerCase()] };
}

describe('system-app rate-limit authentication', () => {
    afterEach(() => {
        delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    });

    it('accepts a fresh signature from the current server launch', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        expect(isTrustedSystemAppRequest(makeRequest())).toBe(true);
    });

    it('rejects unsigned or forged app-id headers', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const forged = makeRequest({ secret: 'attacker-controlled' });
        expect(isTrustedSystemAppRequest(forged)).toBe(false);
    });

    it('rejects expired signatures', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const expired = makeRequest({ timestamp: String(Date.now() - 60_000) });
        expect(isTrustedSystemAppRequest(expired)).toBe(false);
    });

    it('does not trust a marker when the launch secret is unavailable', () => {
        expect(isTrustedSystemAppRequest(makeRequest())).toBe(false);
    });
});
