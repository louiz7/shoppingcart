import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

const VERSION = 'v1';
const AAD = Buffer.from('rescova-email-credentials:v1', 'utf8');

function key(): Buffer {
	const raw = String(env.EMAIL_CREDENTIALS_KEY || '').trim();
	const decoded = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
	if (decoded.length !== 32) throw new Error('EMAIL_CREDENTIALS_KEY must be 32 bytes encoded as hex or base64');
	return decoded;
}

export function encryptEmailCredentials(value: object): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(AAD);
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
		encrypted.toString('base64url')].join('.');
}

export function decryptEmailCredentials(payload: string): object {
	const [version, iv, tag, encrypted, extra] = String(payload || '').split('.');
	if (version !== VERSION || !iv || !tag || !encrypted || extra) throw new Error('invalid encrypted credential payload');
	const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
	decipher.setAAD(AAD);
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return JSON.parse(Buffer.concat([
		decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()
	]).toString('utf8'));
}
