import { randomUUID } from 'node:crypto';
import { fail, redirect, type Actions } from '@sveltejs/kit';
import { recoveryRequest } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	try {
		return { settings: await recoveryRequest(locals.user!.customerId, '/settings'), requestId: randomUUID(),
			canEdit: locals.user?.role === 'admin', loadError: null };
	} catch {
		return { settings: null, requestId: randomUUID(), canEdit: locals.user?.role === 'admin',
			loadError: 'Die Shopify-Einstellungen konnten nicht geladen werden.' };
	}
};

export const actions: Actions = {
	agentProfile: async ({ locals, request }) => {
		const feedback = { error: undefined, success: undefined, values: undefined, uncertain: false };
		if (locals.user?.role !== 'admin') return fail(403, { ...feedback, agentError: 'Nur Händler-Admins können den Agenten anpassen.', agentSuccess: undefined, agentValues: undefined });
		const input = await request.formData();
		const shopId = String(input.get('shopId') || '');
		const profile = { name: String(input.get('name') || '').trim(), persona: String(input.get('persona') || ''),
			voice: String(input.get('voice') || ''), language: String(input.get('language') || '') };
		const agentValues = { shopId, ...profile };
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(shopId) ||
			[...profile.name].length < 1 || [...profile.name].length > 40 || !/^[\p{L}][\p{L}\p{M} '\u2019-]*$/u.test(profile.name) ||
			!['founder', 'assistant'].includes(profile.persona) || !['male', 'female'].includes(profile.voice) || !['de', 'en'].includes(profile.language)) {
			return fail(400, { ...feedback, agentError: 'Bitte prüfe den Namen und die ausgewählten Optionen. Namen dürfen 1–40 Zeichen lang sein und Buchstaben, Leerzeichen, Apostrophe oder Bindestriche enthalten.', agentSuccess: undefined, agentValues });
		}
		try {
			const result = await recoveryRequest(locals.user.customerId, `/shops/${shopId}/agent-profile`, profile, locals.user.id);
			return { ...feedback, agentSuccess: 'Dein Agent wurde gespeichert. Die Einstellungen gelten für neue Gespräche.', agentError: undefined,
				agentValues: { shopId, ...result.agentProfile } };
		} catch (error) {
			const code = error instanceof Error ? error.message : '';
			return fail(code === 'admin_required' ? 403 : 400, { ...feedback, agentValues, agentSuccess: undefined,
				agentError: code === 'invalid_agent_profile' ? 'Bitte prüfe den Namen und die ausgewählten Optionen.'
					: code === 'admin_required' ? 'Nur Händler-Admins können den Agenten anpassen.'
						: 'Die Einstellungen konnten nicht bestätigt werden. Bitte lade den aktuellen Stand neu oder speichere erneut.' });
		}
	},
	connect: async ({ locals, request }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: undefined, success: undefined, values: undefined, uncertain: false,
			connectError: 'Nur Händler-Admins können Shopify-Shops verbinden.', connectDomain: '' });
		const form = await request.formData();
		const domain = String(form.get('domain') || '').trim().toLowerCase();
		if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.myshopify\.com$/.test(domain)) return fail(400, {
			error: undefined, success: undefined, values: undefined, uncertain: false,
			connectError: 'Bitte gib die vollständige .myshopify.com-Adresse deines Shops ein.', connectDomain: domain });
		let target;
		try {
			const result = await recoveryRequest(locals.user.customerId, '/oauth', { domain });
			target = new URL(result.url);
			if (target.origin !== `https://${domain}` || target.username || target.password || target.pathname !== '/admin/oauth/authorize') throw new Error('invalid_oauth_destination');
		}
		catch { return fail(400, { error: undefined, success: undefined, values: undefined, uncertain: false,
			connectError: 'Die Shopify-Verbindung konnte nicht gestartet werden. Bitte versuche es erneut.', connectDomain: domain }); }
		redirect(303, target.href);
	},
	createDiscount: async ({ locals, request }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: 'Nur Händler-Admins können Rabattcodes anlegen.', values: undefined, uncertain: false });
		const input = await request.formData();
		const text = (key: string) => String(input.get(key) || '').trim();
		const values = { shopId: text('shopId'), requestId: text('requestId'), title: text('title'), code: text('code').toUpperCase(),
			percent: text('percent'), minSubtotal: text('minSubtotal'), validDays: text('validDays'), usageLimit: text('usageLimit') };
		const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
		const amount = /^(\d{1,8})(?:[,.](\d{1,2}))?$/.exec(values.minSubtotal);
		const minSubtotalCents = amount ? Number(amount[1]) * 100 + Number((amount[2] || '').padEnd(2, '0')) : NaN;
		const percent = Number(values.percent), validDays = values.validDays === '' ? null : Number(values.validDays), usageLimit = values.usageLimit === '' ? null : Number(values.usageLimit);
		if (!uuid.test(values.shopId) || !uuid.test(values.requestId) || !values.title || values.title.length > 80 ||
			!(/^[A-Z0-9_-]{3,32}$/).test(values.code) || !Number.isInteger(percent) || percent < 1 || percent > 100 ||
			!Number.isSafeInteger(minSubtotalCents) || minSubtotalCents > 2147483647 ||
			(validDays !== null && (!Number.isInteger(validDays) || validDays < 1 || !(new Date(Date.now() + validDays * 86400000).getUTCFullYear() <= 9999))) ||
			(usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 2147483647))) {
			return fail(400, { error: 'Bitte prüfe die Felder und die angegebenen Grenzen.', values, uncertain: false });
		}
		try {
			const result = await recoveryRequest(locals.user.customerId, `/${values.shopId}/discounts`, {
				requestId: values.requestId, title: values.title, code: values.code, percent, minSubtotalCents, validDays, usageLimit
			});
			if (result.discount?.status !== 'confirmed') return fail(409, {
				values: result.discount?.status === 'failed' ? { ...values, requestId: randomUUID() } : values, uncertain: result.discount?.status !== 'failed',
				error: result.discount?.status === 'failed' ? 'Shopify hat diesen Rabattcode nicht angelegt. Bitte prüfe deine Angaben.' :
					'Die Erstellung ist noch nicht bestätigt. Prüfe den Status unten, bevor du einen weiteren Code anlegst.' });
			return { success: `Der Code ${result.discount.code} wurde in Shopify angelegt.`, values: undefined, uncertain: false };
		} catch (error) {
			const code = error instanceof Error ? error.message : '';
			const messages: Record<string, string> = {
				discount_denied: 'Der Rabatt überschreitet die erlaubten Shop-Regeln.',
				invalid_discount: 'Bitte prüfe die Rabattangaben und die Shop-Regeln.',
				invalid_discount_rules: 'Bitte prüfe die Rabattangaben und gegebenenfalls die ausdrücklich gespeicherten Shop-Grenzen.',
				discount_request_reused: 'Diese Anfrage gehört bereits zu einem anderen Entwurf. Lade die Einstellungen neu.',
				live_shop_required: 'Rabattcodes können nur für einen verbundenen Shopify-Shop angelegt werden.',
				discount_creation_rejected: 'Shopify hat diesen Rabattcode nicht angelegt. Bitte prüfe deine Angaben und den Code.',
				shop_not_found: 'Dieser Shop steht für dein Konto nicht zur Verfügung.',
				discount_code_exists: 'Dieser Rabattcode ist bereits vorhanden. Bitte wähle einen anderen Code.',
			};
			const message = Object.hasOwn(messages, code) ? messages[code] : null;
			return fail(400, { values: message ? { ...values, requestId: randomUUID() } : values, uncertain: !message, error: message ||
				'Keine Bestätigung von Shopify erhalten. Bitte prüfe den Status unten, bevor du erneut einen Code anlegst.' });
		}
	}
};
