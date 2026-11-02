import { error } from '@sveltejs/kit';
import { organizationOverview } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	if (locals.user?.role !== 'admin' || !locals.user.isRecoveryInternal) error(403, 'Dieser Bereich ist dem internen Rescova-Team vorbehalten.');
	setHeaders({ 'Cache-Control': 'no-store' });
	try { return { overview: await organizationOverview(locals.user.customerId, locals.user.id), loadError: null }; }
	catch { return { overview: null, loadError: 'Die Organisationsübersicht konnte nicht geladen werden.' }; }
};
