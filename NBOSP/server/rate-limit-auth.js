'use strict';

const crypto = require('crypto');

const SYSTEM_APP_HEADER = 'x-nova-system-app';
const SYSTEM_TIME_HEADER = 'x-nova-system-time';
const SYSTEM_SIGNATURE_HEADER = 'x-nova-system-signature';
const SIGNATURE_MAX_AGE_MS = 30_000;

function isTrustedSystemAppRequest(req) {
    const secret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    if (!secret) return false;

    const appId = req.get(SYSTEM_APP_HEADER);
    const timestamp = req.get(SYSTEM_TIME_HEADER);
    const signature = req.get(SYSTEM_SIGNATURE_HEADER);
    if (
        !appId ||
        !/^\d{13}$/.test(timestamp || '') ||
        !/^[a-f\d]{64}$/i.test(signature || '')
    ) {
        return false;
    }

    const requestTime = Number(timestamp);
    if (!Number.isSafeInteger(requestTime) || Math.abs(Date.now() - requestTime) > SIGNATURE_MAX_AGE_MS) {
        return false;
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}`)
        .digest();
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

module.exports = { isTrustedSystemAppRequest };
