import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	encryptShopifyCredentials, normalizeShopDomain, requireDropsize, verifyShopifyHmac
} from '$lib/server/shopify';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals, fetch }) => {
	const user = locals.user!;
	const recoveryState = url.searchParams.get('state');
	if (user.role === 'admin' && recoveryState) {
		const pending = await db.query(`SELECT 1 FROM recovery_oauth_states WHERE state_hash=$1 AND customer_id=$2 AND expires_at>NOW()`,
			[createHash('sha256').update(recoveryState).digest('hex'), user.customerId]);
		if (pending.rowCount) {
			const base = new URL(env.RECOVERY_API_URL || 'http://127.0.0.1:3110');
			if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) error(503, 'Recovery Gateway muss lokal sein.');
			const result = await fetch(new URL('/integrations/recovery/shopify/callback' + url.search, base), { redirect: 'manual' });
			if (result.status !== 303) {
				const payload = await result.json().catch(() => ({}));
				const messages: Record<string, string> = {
					unsupported_shop_currency: 'Dieser Pilot unterstützt EUR und USD. Die bestätigte Shopwährung muss zur hinterlegten Währung passen.',
					shop_currency_changed: 'Die Shopwährung wurde geändert. Historische Beträge dürfen nicht als andere Währung umgedeutet werden. Bitte die bestehende Verbindung prüfen lassen.',
					shopify_scopes_missing: 'Der Shopify-App fehlen benötigte Berechtigungen: read_orders, read_products, read_customers, write_discounts. Bitte in der aktiven App-Version ergänzen und neu verbinden.',
					shopify_knowledge_scopes_missing: 'Die Basisverbindung besteht, aber Shopify hat die angeforderten Zusatzrechte noch nicht vollständig erteilt: read_legal_policies, read_metaobjects, read_metaobject_definitions. Bitte die aktive Version der tatsächlich verbundenen App im Shopify Dev Dashboard prüfen und danach erneut verbinden.',
					shopify_token_exchange_failed: 'Shopify konnte den Anmeldecode nicht bestätigen. Bitte die Verbindung erneut über Shopify verbinden starten.',
					invalid_oauth_state: 'Diese Shopify-Anmeldung wurde bereits verwendet oder ist abgelaufen. Bitte Shopify verbinden erneut starten.',
					expired_oauth: 'Die Shopify-Anmeldung ist abgelaufen. Bitte Shopify verbinden erneut starten.',
					invalid_oauth_signature: 'Die Shopify-Signatur ist ungültig. Bitte Shopify verbinden erneut starten.',
					shopify_query_failed: 'Shopify hat die Abfrage der Shopdaten abgelehnt. Bitte App-Berechtigungen prüfen.',
					shopify_unavailable: 'Die Shopify-API ist zurzeit nicht erreichbar. Bitte die Verbindung erneut starten.',
					shop_already_connected: 'Dieser Shopify-Shop ist bereits mit einem anderen Rescova-Mandanten verbunden.'
				};
				error(400, messages[payload.error] || 'Recovery-Shopify-Verbindung konnte nicht bestätigt werden.');
			}
			redirect(303, '/recovery');
		}
	}
	if (user.role !== 'admin' || !(await requireDropsize(user.customerId))) error(403, 'Shopify ist nur für Dropsize freigeschaltet.');
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const shop = normalizeShopDomain(url.searchParams.get('shop') || '');
	if (!code || !state || !shop || !env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) {
		error(400, 'Ungültige Shopify-Antwort.');
	}
	if (!verifyShopifyHmac(url, env.SHOPIFY_CLIENT_SECRET)) error(400, 'Shopify-Signatur ist ungültig.');

	const consumed = await db.query(
		`UPDATE shopify_oauth_states SET used_at = NOW()
		  WHERE state_hash = $1 AND customer_id = $2 AND user_id = $3 AND shop_domain = $4
		    AND used_at IS NULL AND expires_at > NOW()
		  RETURNING id`,
		[createHash('sha256').update(state).digest('hex'), user.customerId, user.id, shop]
	);
	if (!consumed.rowCount) error(400, 'Shopify-Verbindung ist abgelaufen oder wurde bereits verwendet.');

	const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code }),
		signal: AbortSignal.timeout(30_000)
	});
	if (!tokenResponse.ok) {
		console.error('[shopify-oauth] token exchange failed', tokenResponse.status);
		error(502, 'Shopify-Zugang konnte nicht bestätigt werden.');
	}
	const tokens = await tokenResponse.json();
	if (!tokens.access_token) error(502, 'Shopify hat keinen Zugriffstoken geliefert.');

	const shopResponse = await fetch(`https://${shop}/admin/api/2026-07/graphql.json`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': tokens.access_token },
		body: JSON.stringify({ query: 'query { shop { name } }' }),
		signal: AbortSignal.timeout(30_000)
	});
	if (!shopResponse.ok) error(502, 'Shopify-Shop konnte nicht geprüft werden.');
	const shopPayload = await shopResponse.json();
	const shopName = String(shopPayload.data?.shop?.name || shop).slice(0, 200);
	const scopes = String(tokens.scope || '').split(',').map((scope) => scope.trim()).filter(Boolean);
	if (!scopes.includes('read_customers') || !scopes.includes('read_orders')) {
		error(403, 'Shopify hat die benötigten Kunden- und Bestellrechte nicht erteilt.');
	}

	await db.query(
		`INSERT INTO shopify_connections (
			customer_id, shop_domain, shop_name, granted_scopes, credentials_encrypted,
			last_verified_at, created_by
		 ) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
		 ON CONFLICT (customer_id) DO UPDATE SET
			shop_domain = EXCLUDED.shop_domain, shop_name = EXCLUDED.shop_name,
			status = 'connected', granted_scopes = EXCLUDED.granted_scopes,
			credentials_encrypted = EXCLUDED.credentials_encrypted,
			last_verified_at = NOW(), last_error = NULL, updated_at = NOW()`,
		[user.customerId, shop, shopName, scopes,
			encryptShopifyCredentials({ access_token: tokens.access_token }), user.id]
	);
	redirect(303, '/admin/email?connected=shopify');
};
