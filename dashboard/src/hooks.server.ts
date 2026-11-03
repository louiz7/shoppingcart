import { error, redirect, type Handle } from '@sveltejs/kit';
import { getSessionUser, recoveryDestination } from '$lib/server/auth';
import { env } from '$env/dynamic/private';

const PUBLIC_PATHS = new Set(['/login', '/register']);

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	if (['/demo', '/demo/session', '/demo/unlock'].includes(path)) {
		event.locals.user = null;
		const response = await resolve(event);
		response.headers.set('Cache-Control', 'no-store');
		if (!response.headers.has('Content-Security-Policy')) response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
		return response;
	}
	if ((event.request.method === 'GET' || event.request.method === 'HEAD') &&
		(path.startsWith('/_app/') || path.startsWith('/figma/') || ['/favicon.ico','/robots.txt'].includes(path))) return resolve(event);
	if (env.RECOVERY_ONLY === '1' && path !== '/' && !PUBLIC_PATHS.has(path) && path !== '/logout' &&
		path !== '/recovery' && !path.startsWith('/recovery/') && path !== '/admin/integrations/shopify/callback') error(404, 'Nicht gefunden.');
	event.locals.user = await getSessionUser(event.cookies);

	if (!event.locals.user && !PUBLIC_PATHS.has(event.url.pathname)) {
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	if (event.locals.user && (PUBLIC_PATHS.has(path) || (env.RECOVERY_ONLY === '1' && path === '/'))) {
		redirect(303, recoveryDestination(event.locals.user));
	}

	return resolve(event);
};
