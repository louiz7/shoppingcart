import { getDashboardOverview } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => getDashboardOverview(locals.user!.customerId);
