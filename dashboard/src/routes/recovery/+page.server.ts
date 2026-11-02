import { recoveryRequest } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
	try {
		return { summary: await recoveryRequest(locals.user!.customerId, '/summary'), loadError: null };
	} catch {
		return { summary: null, loadError: 'Die heutigen Zahlen konnten nicht geladen werden.' };
	}
};
