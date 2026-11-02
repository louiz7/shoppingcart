import { json } from '@sveltejs/kit';
import { recoveryRequest } from '$lib/server/recovery';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request, url }) => {
	if (locals.user?.role !== 'admin' || request.headers.get('origin') !== url.origin) return json({ error: 'unauthorized' }, { status: 403 });
	if (Number(request.headers.get('content-length') || 0) > 64000) return json({ error: 'request_too_large' }, { status: 413 });
	try {
		const text = await request.text();
		if (text.length > 64000) return json({ error: 'request_too_large' }, { status: 413 });
		const result = await recoveryRequest(locals.user.customerId, '/demo', { sdp: JSON.parse(text).sdp });
		return json(result, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error) { return json({ error: error instanceof Error ? error.message : 'demo_unavailable' }, { status: 400 }); }
};
