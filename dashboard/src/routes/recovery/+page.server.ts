import { recoveryRequest } from '$lib/server/recovery';
import { fail, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	try {
		return { summary: await recoveryRequest(locals.user!.customerId, '/summary'), loadError: null, canPause: locals.user?.role === 'admin' };
	} catch {
		return { summary: null, loadError: 'Die heutigen Zahlen konnten nicht geladen werden.', canPause: false };
	}
};

export const actions: Actions = {
	pause: async ({ locals, request }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: 'Nur Admins können Anrufe pausieren.' });
		const shopId = String((await request.formData()).get('shopId') || '');
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(shopId)) return fail(400, { error: 'Dieser Shop ist nicht verfügbar.' });
		try {
			await recoveryRequest(locals.user.customerId, `/shops/${shopId}/pause`, {}, locals.user.id);
			return { error: null, pausedShop: shopId };
		} catch {
			return fail(503, { error: 'Die Pause konnte nicht bestätigt werden. Bitte versuche es erneut.' });
		}
	}
};
