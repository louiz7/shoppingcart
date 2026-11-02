import { error, json } from '@sveltejs/kit';
import { getDebtorDetail } from '$lib/server/platform-data';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	const debtor = await getDebtorDetail(locals.user!.customerId, params.id);
	if (!debtor) error(404, 'Debitor nicht gefunden');

	return json(debtor);
};
