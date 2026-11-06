import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
const open: RequestHandler = async ({ params, request }) => {
    if (!params.token || !/^[a-f0-9]{64}$/.test(params.token)) return new Response('Link nicht verfügbar.', {status:404,headers});
    try {
        const base = new URL(env.RECOVERY_API_URL || 'http://127.0.0.1:3110');
        if (base.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('invalid_gateway');
        const purpose = (request.headers.get('sec-purpose') || request.headers.get('purpose') || '').toLowerCase();
        const response = await fetch(new URL('/internal/recovery/links/resolve',base), {
            method:'POST', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(10000),
            headers:{'Content-Type':'application/json','x-internal-secret':env.INTERNAL_TOOL_SECRET || ''},
            body:JSON.stringify({token:params.token,recordOpen:request.method==='GET' && !purpose.includes('prefetch') && !purpose.includes('preview')})
        });
        if (!response.ok) return new Response('Dieser Checkout-Link ist nicht mehr verfügbar.', {status:response.status===404?404:503,headers});
        const destination = new URL((await response.json()).url);
        if (destination.protocol!=='https:' || destination.username || destination.password || destination.port) throw new Error('invalid_destination');
        return new Response(null,{status:302,headers:{...headers,Location:destination.href}});
    } catch { return new Response('Der Checkout konnte gerade nicht geöffnet werden. Bitte versuche es erneut.', {status:503,headers}); }
};
export const GET = open;
export const HEAD = open;
