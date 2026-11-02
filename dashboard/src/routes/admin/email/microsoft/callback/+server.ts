import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { encryptEmailCredentials } from '$lib/server/email-crypto';
import type { RequestHandler } from './$types';

const SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';

export const GET: RequestHandler = async ({ url, locals, fetch }) => {
	const user = locals.user!;
	if (user.role !== 'admin') error(403, 'Keine Administratorberechtigung.');
	if (!user.emailAutomationEnabled) error(403, 'E-Mail-Automatisierung ist für diese Organisation nicht freigeschaltet.');
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!code || !state || url.searchParams.get('error')) error(400, 'Microsoft-Verbindung wurde abgebrochen.');
	const consumed = await db.query(
		`UPDATE email_oauth_states SET used_at = NOW()
		  WHERE state_hash = $1 AND customer_id = $2 AND user_id = $3
		    AND used_at IS NULL AND expires_at > NOW()
		  RETURNING id`,
		[createHash('sha256').update(state).digest('hex'), user.customerId, user.id]
	);
	if (!consumed.rowCount) error(400, 'Microsoft-Verbindung ist abgelaufen oder wurde bereits verwendet.');
	const redirectUri = env.MICROSOFT_REDIRECT_URI || `${url.origin}/admin/email/microsoft/callback`;
	const tokenResponse = await fetch('https://login.microsoftonline.com/organizations/oauth2/v2.0/token', {
		method: 'POST',
		body: new URLSearchParams({
			client_id: env.MICROSOFT_CLIENT_ID || '', client_secret: env.MICROSOFT_CLIENT_SECRET || '',
			code, redirect_uri: redirectUri, grant_type: 'authorization_code', scope: SCOPES
		}),
		signal: AbortSignal.timeout(30_000)
	});
	if (!tokenResponse.ok) {
		console.error('[email-oauth] Microsoft token exchange failed', tokenResponse.status);
		error(502, 'Microsoft-Zugang konnte nicht bestätigt werden. Bitte erneut verbinden.');
	}
	const tokens = await tokenResponse.json();
	if (!tokens.access_token || !tokens.refresh_token) error(502, 'Microsoft hat keine dauerhafte Freigabe erteilt.');
	const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
		headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30_000)
	});
	if (!profileResponse.ok) error(502, 'Microsoft-Postfach konnte nicht gelesen werden.');
	const profile = await profileResponse.json();
	const email = String(profile.mail || profile.userPrincipalName || '').trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) error(502, 'Microsoft-Postfach hat keine gültige Adresse.');
	await db.query(
		`INSERT INTO email_accounts (
			customer_id, provider, email_address, display_name, status, config,
			credentials_encrypted, created_by
		 ) VALUES ($1, 'microsoft_graph', $2, $3, 'pending', $4, $5, $6)
		 ON CONFLICT (customer_id, email_address) DO UPDATE SET
			provider = 'microsoft_graph', display_name = EXCLUDED.display_name,
			status = 'pending', config = EXCLUDED.config,
			credentials_encrypted = EXCLUDED.credentials_encrypted,
			sync_cursor = NULL, last_error = NULL, updated_at = NOW()`,
		[user.customerId, email, String(profile.displayName || '').slice(0, 160) || null,
			JSON.stringify({ tenant_id: 'organizations', microsoft_user_id: String(profile.id) }),
			encryptEmailCredentials({
				access_token: tokens.access_token, refresh_token: tokens.refresh_token,
				expires_at: Date.now() + Number(tokens.expires_in || 3600) * 1000
			}), user.id]
	);
	redirect(303, '/admin/email?connected=microsoft');
};
