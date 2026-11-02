import { json } from '@sveltejs/kit';
import { getDebtors } from '$lib/server/platform-data';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals }) =>
	json(await getDebtors(locals.user!.customerId, url.searchParams.get('q') ?? ''));
