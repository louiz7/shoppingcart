import { document } from '$lib/server/recovery-terms';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ setHeaders }) => {
    setHeaders({ 'Cache-Control': 'no-store' });
    return { document };
};
