import { redirect } from '@sveltejs/kit';
import { deleteSession } from '$lib/server/auth';

export const POST = async ({ cookies }) => {
	await deleteSession(cookies);
	redirect(303, '/login');
};
