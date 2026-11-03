import { demoRequest } from '$lib/server/demo';
export const load = async () => {
    try { return { demo: await demoRequest('/info'), unavailable: false }; }
    catch { return { demo: null, unavailable: true }; }
};
