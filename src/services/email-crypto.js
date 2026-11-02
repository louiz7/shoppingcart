'use strict';

const crypto = require('crypto');

const VERSION = 'v1';
const AAD = Buffer.from('rescova-email-credentials:v1', 'utf8');

function credentialKey() {
    const raw = String(process.env.EMAIL_CREDENTIALS_KEY || '').trim();
    let key;
    if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
    else {
        try { key = Buffer.from(raw, 'base64'); } catch { key = Buffer.alloc(0); }
    }
    if (key.length !== 32) {
        throw new Error('EMAIL_CREDENTIALS_KEY must be 32 bytes encoded as hex or base64');
    }
    return key;
}

function encryptCredentials(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(value), 'utf8'),
        cipher.final(),
    ]);
    return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
        ciphertext.toString('base64url')].join('.');
}

function decryptCredentials(payload) {
    const [version, ivValue, tagValue, ciphertextValue, extra] = String(payload || '').split('.');
    if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue || extra) {
        throw new Error('invalid encrypted credential payload');
    }
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm', credentialKey(), Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
}

module.exports = { encryptCredentials, decryptCredentials };
