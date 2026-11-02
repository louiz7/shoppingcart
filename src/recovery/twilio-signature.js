'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

function twilioSignature(url, params, supplied, authToken = process.env.TWILIO_AUTH_TOKEN) {
    if (!authToken || typeof supplied !== 'string') return false;
    if (typeof url !== 'string' || !params || typeof params !== 'object' || Array.isArray(params)) return false;
    if (Object.values(params).some((value) => typeof value !== 'string')) return false;
    const value = url + Object.keys(params).sort().map((key) => key + params[key]).join('');
    const expected = createHmac('sha1', authToken).update(value).digest('base64');
    const a = Buffer.from(expected), b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { twilioSignature };
