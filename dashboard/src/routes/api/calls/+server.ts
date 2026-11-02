import { json } from '@sveltejs/kit';
import { getCallListData } from '$lib/server/platform-data';

export const GET = async ({ locals }) => json(await getCallListData(locals.user!.customerId));
