import { getDebtorDirectory } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, locals }) =>
	getDebtorDirectory(
		locals.user!.customerId,
		url.searchParams.get('q') ?? '',
		url.searchParams.get('campaign') || undefined
	);
