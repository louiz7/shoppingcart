import { createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { encryptEmailCredentials } from '$lib/server/email-crypto';
import { normalizeShopDomain, requireDropsize } from '$lib/server/shopify';
import { getPlatformNavigation } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

const MICROSOFT_SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';

type ShopifyDraftContext = {
	match_status?: string;
	fetched_at: string;
	customer?: { display_name?: string };
	order?: { name?: string; displayFinancialStatus?: string; displayFulfillmentStatus?: string };
};

function validEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validHost(value: string): boolean {
	return value.length > 2 && value.length <= 253 && !/[^a-zA-Z0-9.:-]/.test(value) &&
		value !== 'localhost' && !value.endsWith('.local');
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	if (user.role !== 'admin') error(403, 'Nur Administratoren dürfen E-Mail-Postfächer verwalten.');
	if (!user.emailAutomationEnabled) error(403, 'E-Mail-Automatisierung ist für diese Organisation nicht freigeschaltet.');
	const dropsize = await requireDropsize(user.customerId);
	const [accounts, drafts, shopify] = await Promise.all([
		db.query<{
			id: string; provider: string; email_address: string; display_name: string | null;
			status: string; automation_mode: string; last_synced_at: Date | null; last_error: string | null;
		}>(
			`SELECT id::text, provider, email_address, display_name, status, automation_mode,
			        last_synced_at, last_error
			   FROM email_accounts WHERE customer_id = $1 ORDER BY created_at`, [user.customerId]
		),
		db.query<{
			id: string; subject: string; body_text: string; category: string; status: string;
			from_address: string; source_subject: string; created_at: Date; shopify_context: ShopifyDraftContext | null;
		}>(
			`SELECT d.id::text, d.subject, d.body_text, d.category, d.status, d.shopify_context,
			        m.from_address, m.subject AS source_subject, d.created_at
			   FROM email_drafts d
			   JOIN email_messages m ON m.id = d.source_message_id AND m.customer_id = d.customer_id
			  WHERE d.customer_id = $1
			  ORDER BY d.created_at DESC LIMIT 30`, [user.customerId]
		),
		dropsize ? db.query<{
			shop_domain: string; shop_name: string | null; status: string;
			last_verified_at: Date | null; last_error: string | null;
		}>(
			`SELECT shop_domain, shop_name, status, last_verified_at, last_error
			   FROM shopify_connections WHERE customer_id = $1`, [user.customerId]
		) : Promise.resolve({ rows: [] })
	]);
	return {
		...getPlatformNavigation(),
		message: url.searchParams.get('connected') === 'microsoft' ? 'Microsoft-Postfach wurde verbunden.' :
			url.searchParams.get('connected') === 'shopify' ? 'Dropsize-Shopify-Shop wurde verbunden.' : null,
		shopifyEnabled: dropsize,
		shopify: shopify.rows[0] ? {
			domain: shopify.rows[0].shop_domain, name: shopify.rows[0].shop_name,
			status: shopify.rows[0].status,
			lastVerifiedAt: shopify.rows[0].last_verified_at?.toISOString() || null,
			lastError: shopify.rows[0].last_error
		} : null,
		accounts: accounts.rows.map((row) => ({
			id: row.id, provider: row.provider, email: row.email_address,
			displayName: row.display_name, status: row.status, automationMode: row.automation_mode,
			lastSyncedAt: row.last_synced_at?.toISOString() || null, lastError: row.last_error
		})),
		drafts: drafts.rows.map((row) => ({
			id: row.id, subject: row.subject, body: row.body_text, category: row.category,
			status: row.status, from: row.from_address, sourceSubject: row.source_subject,
			createdAt: row.created_at.toISOString(), shopifyContext: row.shopify_context
		}))
	};
};

export const actions: Actions = {
	connectShopify: async ({ request, locals, url }) => {
		const user = locals.user!;
		if (user.role !== 'admin' || !(await requireDropsize(user.customerId))) {
			return fail(403, { shopifyError: 'Shopify ist nur für Dropsize freigeschaltet.' });
		}
		if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
			return fail(503, { shopifyError: 'Shopify OAuth ist auf dem Server noch nicht konfiguriert.' });
		}
		const form = await request.formData();
		const shop = normalizeShopDomain(String(form.get('shop') || ''));
		if (!shop) return fail(400, { shopifyError: 'Bitte eine gültige .myshopify.com-Adresse eingeben.' });
		const state = randomBytes(32).toString('base64url');
		await db.query(
			`INSERT INTO shopify_oauth_states (state_hash, customer_id, user_id, shop_domain, expires_at)
			 VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')`,
			[createHash('sha256').update(state).digest('hex'), user.customerId, user.id, shop]
		);
		const redirectUri = env.SHOPIFY_REDIRECT_URI || `${url.origin}/admin/integrations/shopify/callback`;
		const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
		authorize.search = new URLSearchParams({
			client_id: env.SHOPIFY_CLIENT_ID, redirect_uri: redirectUri, state
		}).toString();
		redirect(303, authorize.toString());
	},
	disconnectShopify: async ({ locals }) => {
		const user = locals.user!;
		if (user.role !== 'admin' || !(await requireDropsize(user.customerId))) {
			return fail(403, { shopifyError: 'Shopify ist nur für Dropsize freigeschaltet.' });
		}
		await db.query('DELETE FROM shopify_connections WHERE customer_id = $1', [user.customerId]);
		return { shopifySuccess: 'Shopify-Verbindung wurde aus Rescova entfernt.' };
	},
	connectMicrosoft: async ({ locals, url }) => {
		const user = locals.user!;
		if (user.role !== 'admin') return fail(403, { error: 'Keine Administratorberechtigung.' });
		if (!user.emailAutomationEnabled) return fail(403, { error: 'E-Mail-Automatisierung ist nicht freigeschaltet.' });
		if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
			return fail(503, { error: 'Microsoft OAuth ist auf dem Server noch nicht konfiguriert.' });
		}
		const state = randomBytes(32).toString('base64url');
		await db.query(
			`INSERT INTO email_oauth_states (state_hash, customer_id, user_id, expires_at)
			 VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
			[createHash('sha256').update(state).digest('hex'), user.customerId, user.id]
		);
		const redirectUri = env.MICROSOFT_REDIRECT_URI || `${url.origin}/admin/email/microsoft/callback`;
		const authorize = new URL('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
		authorize.search = new URLSearchParams({
			client_id: env.MICROSOFT_CLIENT_ID,
			response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
			scope: MICROSOFT_SCOPES, state, prompt: 'select_account'
		}).toString();
		redirect(303, authorize.toString());
	},
	connectImap: async ({ request, locals }) => {
		const user = locals.user!;
		if (user.role !== 'admin') return fail(403, { imapError: 'Keine Administratorberechtigung.' });
		if (!user.emailAutomationEnabled) return fail(403, { imapError: 'E-Mail-Automatisierung ist nicht freigeschaltet.' });
		const form = await request.formData();
		const email = String(form.get('email') || '').trim().toLowerCase();
		const displayName = String(form.get('displayName') || '').trim().slice(0, 160);
		const username = String(form.get('username') || '').trim();
		const password = String(form.get('password') || '');
		const imapHost = String(form.get('imapHost') || '').trim().toLowerCase();
		const smtpHost = String(form.get('smtpHost') || '').trim().toLowerCase();
		const imapPort = Number(form.get('imapPort'));
		const smtpPort = Number(form.get('smtpPort'));
		if (!validEmail(email) || !username || password.length < 8 || !validHost(imapHost) || !validHost(smtpHost) ||
			!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535 ||
			!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
			return fail(400, { imapError: 'Bitte vollständige und gültige Postfachdaten eingeben.' });
		}
		try {
			await db.query(
				`INSERT INTO email_accounts (
					customer_id, provider, email_address, display_name, config,
					credentials_encrypted, created_by
				 ) VALUES ($1, 'imap_smtp', $2, $3, $4, $5, $6)
				 ON CONFLICT (customer_id, email_address) DO UPDATE SET
					provider = 'imap_smtp', display_name = EXCLUDED.display_name,
					config = EXCLUDED.config, credentials_encrypted = EXCLUDED.credentials_encrypted,
					status = 'pending', sync_cursor = NULL, last_error = NULL, updated_at = NOW()`,
				[user.customerId, email, displayName || null, JSON.stringify({
					imap_host: imapHost, imap_port: imapPort, imap_secure: form.get('imapSecure') === 'on',
					smtp_host: smtpHost, smtp_port: smtpPort, smtp_secure: form.get('smtpSecure') === 'on'
				}), encryptEmailCredentials({ username, password }), user.id]
			);
			return { imapSuccess: 'Postfach gespeichert. Die Verbindung wird im Hintergrund geprüft.' };
		} catch (cause) {
			console.error('[email-account] IMAP save failed', cause);
			return fail(500, { imapError: 'Postfach konnte nicht sicher gespeichert werden.' });
		}
	},
	disconnect: async ({ request, locals }) => {
		const user = locals.user!;
		if (user.role !== 'admin') return fail(403, { error: 'Keine Administratorberechtigung.' });
		if (!user.emailAutomationEnabled) return fail(403, { error: 'E-Mail-Automatisierung ist nicht freigeschaltet.' });
		const id = String((await request.formData()).get('accountId') || '');
		if (!/^\d+$/.test(id)) return fail(400, { error: 'Ungültiges Postfach.' });
		await db.query('DELETE FROM email_accounts WHERE id = $1 AND customer_id = $2', [id, user.customerId]);
		return { success: 'Postfach wurde getrennt und gespeicherte Zugangsdaten wurden gelöscht.' };
	},
	approveDraft: async ({ request, locals }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		if (!user.emailAutomationEnabled) return fail(403, { error: 'E-Mail-Automatisierung ist nicht freigeschaltet.' });
		const form = await request.formData();
		const draftId = String(form.get('draftId') || '');
		const subject = String(form.get('subject') || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
		const body = String(form.get('body') || '').trim().slice(0, 20_000);
		if (!/^\d+$/.test(draftId) || !subject || !body) return fail(400, { error: 'Entwurf ist unvollständig.' });
		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const { rows } = await client.query<{ source_message_id: string; email_account_id: string }>(
				`UPDATE email_drafts SET subject = $1, body_text = $2, status = 'approved',
				        approved_by = $3, approved_at = NOW(), updated_at = NOW()
				  WHERE id = $4 AND customer_id = $5 AND status IN ('pending_approval', 'failed')
				  RETURNING source_message_id::text, email_account_id::text`,
				[subject, body, user.id, draftId, user.customerId]
			);
			if (!rows[0]) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Der Entwurf wurde bereits bearbeitet.' });
			}
			await client.query(
				`INSERT INTO email_jobs (customer_id, email_account_id, email_message_id, kind)
				 VALUES ($1, $2, $3, 'send_draft')
				 ON CONFLICT (email_message_id, kind) DO UPDATE SET
					status = 'pending', scheduled_at = NOW(), locked_at = NULL,
					attempt_count = 0, last_error = NULL, completed_at = NULL
				 WHERE email_jobs.status = 'failed'`,
				[user.customerId, rows[0].email_account_id, rows[0].source_message_id]
			);
			await client.query('COMMIT');
			return { success: 'Antwort wurde freigegeben und wird sicher versendet.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[email-draft] approve failed', cause);
			return fail(500, { error: 'Entwurf konnte nicht freigegeben werden.' });
		} finally {
			client.release();
		}
	}
};
