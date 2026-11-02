'use strict';

const crypto = require('crypto');

const VERSION = 'v1';
const AAD = Buffer.from('rescova-shopify-credentials:v1', 'utf8');

function key() {
    const raw = String(process.env.SHOPIFY_CREDENTIALS_KEY || process.env.EMAIL_CREDENTIALS_KEY || '').trim();
    const decoded = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (decoded.length !== 32) throw new Error('SHOPIFY_CREDENTIALS_KEY must be 32 bytes encoded as hex or base64');
    return decoded;
}

function decryptShopifyCredentials(payload) {
    const [version, iv, tag, encrypted, extra] = String(payload || '').split('.');
    if (version !== VERSION || !iv || !tag || !encrypted || extra) throw new Error('invalid Shopify credential payload');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final(),
    ]).toString('utf8'));
}

module.exports = { decryptShopifyCredentials };
