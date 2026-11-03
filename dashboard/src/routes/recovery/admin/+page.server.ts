import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import { recoveryRequest } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	if (locals.user?.role !== 'admin') error(403, 'Dieser Bereich erfordert Adminrechte.');
	setHeaders({ 'Cache-Control': 'no-store' });
	try { return { recovery: await recoveryRequest(locals.user!.customerId), loadError: null }; }
	catch { return { recovery: null, loadError: 'Recovery-API nicht erreichbar. Bitte den lokalen API-Prozess auf Port 3110 starten.' }; }
};

const action = (kind: string): Actions[string] => async ({ locals, request }) => {
	if (locals.user?.role !== 'admin') return fail(403, { error: 'Diese Aktion erfordert Händler-Adminrechte.' });
	const form = await request.formData();
	const shop = String(form.get('shopId') || '');
	const checkout = String(form.get('checkoutId') || '');
	try {
		let result;
		if (kind === 'connect') {
			result = await recoveryRequest(locals.user.customerId, '/oauth', { domain: String(form.get('domain') || '').trim().toLowerCase() });
		} else if (kind === 'settings') {
			const rules: Record<string, unknown> = {};
			for (const key of ['delayMinutes','maxAttempts','cooldownHours','expiryDays','holdoutPercent','maxDiscountPercent','minSubtotalCents','offerHours','contributionPercent','voiceCentsPerMinute']) rules[key] = Number(form.get(key));
			for (const key of ['start','end','timezone']) rules[key] = String(form.get(key));
			rules.weekdays = form.getAll('weekdays').map(Number);
			result = await recoveryRequest(locals.user.customerId, `/${shop}/settings`, {
				brand: String(form.get('brand')), brand_voice: String(form.get('brand_voice')),
				enabled: form.get('enabled') === 'on', approval: form.get('approval') === 'on', rules
			});
		} else if (kind === 'consent') {
			result = await recoveryRequest(locals.user.customerId, `/${shop}/checkouts/${checkout}/consent`, {
				evidence: String(form.get('evidence')), verified: form.get('verified') === 'on',
                consentedAt: new Date(String(form.get('consentedAt'))+'Z').toISOString(), expiresAt: new Date(String(form.get('expiresAt'))+'Z').toISOString(), timezone: String(form.get('timezone'))
			});
		} else {
			result = await recoveryRequest(locals.user.customerId, ['sync', 'webhooks'].includes(kind) ? `/${shop}/${kind}` : `/${shop}/checkouts/${checkout}/${kind}`, {});
		}
		if (kind === 'connect') redirect(303, result.url);
		return { success: result.control ? 'Kontrollgruppe: Es wird kein Anruf ausgelöst.' : result.simulated ? 'Simulation ausgeführt. Keine externe Aktion.' : 'Gespeichert.', error: null };
	} catch (error) {
		if (error && typeof error === 'object' && 'status' in error && 'location' in error) throw error;
		return fail(400, { error: error instanceof Error ? (error.message === 'terms_acceptance_required' ? 'Bitte zuerst unter Einstellungen die Nutzungsbedingungen für diese Organisation bestätigen.' : error.message) : 'Aktion fehlgeschlagen.', success: null });
	}
};

export const actions: Actions = { settings: action('settings'), connect: action('connect'), sync: action('sync'),
	webhooks: action('webhooks'), consent: action('consent'), stop: action('stop'), call: action('call') };
