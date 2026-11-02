import { fail, redirect, type Actions } from '@sveltejs/kit';
import { createSession } from '$lib/server/auth';
import { registerOrganization } from '$lib/server/recovery';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store' });
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		const organizationName = String(form.get('organizationName') || '').trim();
		const displayName = String(form.get('displayName') || '').trim();
		const email = String(form.get('email') || '').trim().toLowerCase();
		const password = String(form.get('password') || '');
		const values = { organizationName, displayName, email };
		if (organizationName.length < 2 || organizationName.length > 120 || displayName.length < 2 || displayName.length > 120 ||
			email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
			return fail(400, { error: 'Bitte prüfe deine Angaben. Das Passwort muss 12 bis 128 Zeichen lang sein.', ...values });
		}
		let created;
		try { created = await registerOrganization({ organizationName, displayName, email, password, clientAddress: getClientAddress() }); }
		catch (error) {
			const code = error instanceof Error ? error.message : '';
			return fail(code === 'registration_rate_limited' ? 429 : 400, { ...values, error: code === 'registration_rate_limited'
				? 'Zu viele Registrierungen. Bitte versuche es später erneut.'
				: code === 'invalid_organization_registration' ? 'Bitte prüfe die Angaben und die Passwortlänge.'
					: 'Die Organisation konnte nicht angelegt werden. Prüfe deine Angaben oder melde dich mit einem bestehenden Konto an.' });
		}
		try { await createSession(Number(created.userId), cookies); }
		catch { return fail(503, { ...values, error: 'Deine Organisation wurde angelegt. Bitte melde dich an, um fortzufahren.' }); }
		redirect(303, '/recovery');
	}
};
