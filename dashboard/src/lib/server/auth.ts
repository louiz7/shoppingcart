import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Cookies } from '@sveltejs/kit';
import { db } from './db';
import { env } from '$env/dynamic/private';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'rescova_session';
const SESSION_DAYS = 14;

export type PlatformUser = NonNullable<App.Locals['user']>;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	if (!/^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
	const [algorithm, version, saltHex, expectedHex] = stored.split('$');
	if (algorithm !== 'scrypt' || version !== 'v1' || !saltHex || !expectedHex) return false;

	const expected = Buffer.from(expectedHex, 'hex');
	const actual = (await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)) as Buffer;
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function recoveryDestination(user: { isRecoveryInternal: boolean }, requested?: string | null): string {
	const fallback = user.isRecoveryInternal ? '/recovery/organizations' : '/recovery';
	if (!requested || !requested.startsWith('/') || requested.startsWith('//') || /[\\\x00-\x20\x7f]/.test(requested)) return fallback;
	const path = new URL(requested, 'http://localhost').pathname;
	if (path === '/' || path === '/login' || path === '/register') return fallback;
	if (env.RECOVERY_ONLY === '1' && path !== '/recovery' && !path.startsWith('/recovery/') && path !== '/admin/integrations/shopify/callback') return fallback;
	return requested;
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: number, cookies: Cookies): Promise<void> {
	const token = randomBytes(32).toString('base64url');
	await db.query(
		`INSERT INTO platform_sessions (user_id, token_hash, expires_at)
		 VALUES ($1, $2, NOW() + ($3 || ' days')::interval)`,
		[userId, tokenHash(token), SESSION_DAYS]
	);
	cookies.set(COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_DAYS * 24 * 60 * 60
	});
}

export async function deleteSession(cookies: Cookies): Promise<void> {
	const token = cookies.get(COOKIE_NAME);
	if (token) {
		await db.query('DELETE FROM platform_sessions WHERE token_hash = $1', [tokenHash(token)]);
	}
	cookies.delete(COOKIE_NAME, { path: '/' });
}

export async function getSessionUser(cookies: Cookies): Promise<PlatformUser | null> {
	const token = cookies.get(COOKIE_NAME);
	if (!token) return null;

	const { rows } = await db.query<{
		id: string;
		customer_id: number;
		email: string;
		display_name: string;
		organization_name: string;
		role: PlatformUser['role'];
		email_automation_enabled: boolean;
		is_rescova_internal: boolean;
		last_seen_at: Date;
	}>(
		`SELECT u.id, u.customer_id, u.email, u.display_name, u.role,c.name AS organization_name,
		        c.email_automation_enabled, s.last_seen_at,
		        COALESCE((to_jsonb(c)->>'is_rescova_internal')::boolean,FALSE) AS is_rescova_internal
		   FROM platform_sessions s
		   JOIN platform_users u ON u.id = s.user_id
		   JOIN customers c ON c.id = u.customer_id
		  WHERE s.token_hash = $1
		    AND s.expires_at > NOW()
		    AND u.active
		    AND c.is_active`,
		[tokenHash(token)]
	);
	if (!rows[0]) {
		cookies.delete(COOKIE_NAME, { path: '/' });
		return null;
	}

	if (Date.now() - new Date(rows[0].last_seen_at).getTime() > 5 * 60 * 1000) {
		await db.query(
			'UPDATE platform_sessions SET last_seen_at = NOW() WHERE token_hash = $1',
			[tokenHash(token)]
		);
	}
	return {
		id: Number(rows[0].id),
		customerId: rows[0].customer_id,
		email: rows[0].email,
		displayName: rows[0].display_name,
		organizationName: rows[0].organization_name,
		role: rows[0].role,
		emailAutomationEnabled: rows[0].email_automation_enabled,
		isRescovaAdminOrganization: rows[0].is_rescova_internal && rows[0].role === 'admin',
		isRecoveryInternal: rows[0].is_rescova_internal && rows[0].role === 'admin'
	};
}
