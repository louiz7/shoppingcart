import { fail, redirect, type Actions } from '@sveltejs/kit';
import { createSession, recoveryDestination } from '$lib/server/auth';
import { authenticateOrganization } from '$lib/server/recovery';

export const actions: Actions = {
	default: async ({ request, cookies, url, getClientAddress }) => {
		const form = await request.formData();
		const email = String(form.get('email') || '').trim().toLowerCase();
		const password = String(form.get('password') || '');
		if (!email || !password) return fail(400, { error: 'E-Mail und Passwort sind erforderlich.', email });

		let user;
		try { user = await authenticateOrganization({ email, password, clientAddress: getClientAddress() }); }
		catch (error) {
			const limited = error instanceof Error && error.message === 'login_rate_limited';
			return fail(limited ? 429 : 400, { error: limited
				? 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.'
				: 'E-Mail oder Passwort ist ungültig oder die Anmeldung ist derzeit nicht erreichbar.', email });
		}
		await createSession(Number(user.userId), cookies);
		redirect(303, recoveryDestination(user, url.searchParams.get('next')));
	}
};
