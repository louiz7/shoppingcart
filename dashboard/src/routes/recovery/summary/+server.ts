import { json } from '@sveltejs/kit';
import { recoveryRequest } from '$lib/server/recovery';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	const headers = { 'Cache-Control': 'no-store' };
	try {
		return json(await recoveryRequest(locals.user!.customerId, '/summary'), { headers });
	} catch {
		return json({ error: 'summary_unavailable' }, { status: 503, headers });
	}
};
