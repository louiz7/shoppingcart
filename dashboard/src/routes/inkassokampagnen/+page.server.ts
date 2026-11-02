import { getDebtCollectionCampaignData } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => getDebtCollectionCampaignData(locals.user!.customerId);
