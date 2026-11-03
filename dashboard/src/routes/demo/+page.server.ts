import { demoRequest } from '$lib/server/demo';
import { env } from '$env/dynamic/private';
export const load = async () => {
    const unlockAvailable = env.RECOVERY_BROWSER_DEMO_ENABLED === '1' && Boolean(env.SHOPIFY_STOREFRONT_PASSWORD);
    try { return { demo: await demoRequest('/info'), unavailable: false, unlockAvailable }; }
    catch { return { demo: null, unavailable: true, unlockAvailable }; }
};
