import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';

const VERSION = 'v1';
const AAD = Buffer.from('rescova-shopify-credentials:v1', 'utf8');

function key(): Buffer {
	const raw = String(env.SHOPIFY_CREDENTIALS_KEY || env.EMAIL_CREDENTIALS_KEY || '').trim();
	const decoded = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
	if (decoded.length !== 32) throw new Error('SHOPIFY_CREDENTIALS_KEY must be 32 bytes encoded as hex or base64');
	return decoded;
}

export function encryptShopifyCredentials(value: object): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key(), iv);
	cipher.setAAD(AAD);
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
	return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
		encrypted.toString('base64url')].join('.');
}

export function normalizeShopDomain(value: string): string | null {
	const normalized = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	const domain = normalized.includes('.') ? normalized : `${normalized}.myshopify.com`;
	return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) ? domain : null;
}

export async function requireDropsize(customerId: number): Promise<boolean> {
	const result = await db.query(
		`SELECT 1 FROM customers WHERE id = $1 AND LOWER(TRIM(name)) = 'dropsize' AND is_active`,
		[customerId]
	);
	return Boolean(result.rowCount);
}

export function verifyShopifyHmac(url: URL, secret: string): boolean {
	const supplied = url.searchParams.get('hmac');
	if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
	const message = [...url.searchParams.entries()]
		.filter(([key]) => key !== 'hmac' && key !== 'signature')
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`)
		.join('&');
	const expected = createHmac('sha256', secret).update(message).digest('hex');
	const actualBuffer = Buffer.from(supplied, 'hex');
	const expectedBuffer = Buffer.from(expected, 'hex');
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
