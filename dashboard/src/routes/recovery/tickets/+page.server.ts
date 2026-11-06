import { fail, type Actions } from '@sveltejs/kit';
import { recoveryRequest } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	try {
		const result = await recoveryRequest(locals.user!.customerId, '/tickets', undefined, locals.user!.id);
		return { result, loadError: null };
	} catch {
		return { result: null, loadError: 'Die Tickets konnten nicht geladen werden. Bitte versuche es erneut.' };
	}
};

export const actions: Actions = {
	resolve: async ({ locals, request }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: 'Nur Admins können Tickets abschließen.' });
		const id = String((await request.formData()).get('ticketId') || '');
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return fail(400, { error: 'Dieses Ticket ist nicht verfügbar.' });
		try {
			await recoveryRequest(locals.user.customerId, `/tickets/${id}/resolve`, {}, locals.user.id);
			return { error: null };
		} catch {
			return fail(400, { error: 'Das Ticket konnte nicht abgeschlossen werden. Bitte lade den aktuellen Stand neu.' });
		}
	}
};
