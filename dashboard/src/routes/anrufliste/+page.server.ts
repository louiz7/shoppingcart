import { getCallListData } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) =>
	getCallListData(locals.user!.customerId, url.searchParams.get('campaign') || undefined);
