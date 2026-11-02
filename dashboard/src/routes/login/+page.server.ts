import { fail, redirect, type Actions } from '@sveltejs/kit';
import { createSession, verifyPassword } from '$lib/server/auth';
import { db } from '$lib/server/db';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const failedLogins = new Map<string, number[]>();

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') || '').trim().toLowerCase();
		const password = String(form.get('password') || '');
		if (!email || !password) return fail(400, { error: 'E-Mail und Passwort sind erforderlich.', email });

		const now = Date.now();
		const key = `${getClientAddress()}:${email}`;
		const failures = (failedLogins.get(key) || []).filter((timestamp) => now - timestamp < LOGIN_WINDOW_MS);
		if (failures.length >= LOGIN_MAX_FAILURES) {
			failedLogins.set(key, failures);
			return fail(429, { error: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.', email });
		}

		const { rows } = await db.query<{ id: string; password_hash: string }>(
			`SELECT u.id, u.password_hash
			   FROM platform_users u
			   JOIN customers c ON c.id = u.customer_id
			  WHERE LOWER(u.email) = $1 AND u.active AND c.is_active`,
			[email]
		);
		const user = rows[0];
		if (!user || !(await verifyPassword(password, user.password_hash))) {
			failures.push(now);
			failedLogins.set(key, failures);
			return fail(400, { error: 'E-Mail oder Passwort ist ungültig.', email });
		}

		failedLogins.delete(key);
		await createSession(Number(user.id), cookies);
		const requested = url.searchParams.get('next');
		const next = requested?.startsWith('/') && !requested.startsWith('//') ? requested : '/';
		redirect(303, next);
	}
};
