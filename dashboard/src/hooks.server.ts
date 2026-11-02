import { redirect, type Handle } from '@sveltejs/kit';
import { getSessionUser } from '$lib/server/auth';

const PUBLIC_PATHS = new Set(['/login']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = await getSessionUser(event.cookies);

	if (!event.locals.user && !PUBLIC_PATHS.has(event.url.pathname)) {
		redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	if (event.locals.user && event.url.pathname === '/login') {
		redirect(303, '/');
	}

	return resolve(event);
};
