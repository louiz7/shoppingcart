import { json } from '@sveltejs/kit';
import { getDashboardOverview } from '$lib/server/platform-data';

export const GET = async ({ locals }) => json(await getDashboardOverview(locals.user!.customerId));
