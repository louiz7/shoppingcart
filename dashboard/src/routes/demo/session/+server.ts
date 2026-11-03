import { json } from '@sveltejs/kit';
import { demoRequest } from '$lib/server/demo';
import type { RequestHandler } from './$types';
const cookie = 'rescova_browser_demo';
export const POST: RequestHandler = async ({ request, url, cookies, getClientAddress }) => {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Ungültige Anfrage.' }, { status: 403 });
    if (Number(request.headers.get('content-length') || 0) > 128) return json({ error: 'Ungültige Anfrage.' }, { status: 413 });
    try {
        const raw = await request.text();
        if (raw.length > 128) return json({ error: 'Ungültige Anfrage.' }, { status: 413 });
        const { action } = JSON.parse(raw);
        if (action === 'start') {
            const previous = cookies.get(cookie);
            if (previous) await demoRequest('/end', { token: previous }).catch(() => {});
            const { browserToken, ...session } = await demoRequest('/start', { clientAddress: getClientAddress() });
            cookies.set(cookie, browserToken, { path: '/demo', httpOnly: true, secure: url.protocol === 'https:', sameSite: 'strict', maxAge: 600 });
            return json(session);
        }
        if (action === 'end') {
            const token = cookies.get(cookie);
            if (token) await demoRequest('/end', { token });
            cookies.delete(cookie, { path: '/demo' });
            return json({ ended: true });
        }
        return json({ error: 'Ungültige Anfrage.' }, { status: 400 });
    } catch (e) {
        const code = e instanceof Error ? e.message : '';
        return json({ error: code === 'demo_limit' ? 'Die Demo ist gerade ausgelastet oder dein Stundenlimit ist erreicht. Bitte später erneut versuchen.' : 'Die Demo konnte nicht gestartet werden. Bitte versuche es gleich noch einmal.' }, { status: code === 'demo_limit' ? 429 : 503 });
    }
};
export const GET: RequestHandler = async ({ cookies }) => {
    const token = cookies.get(cookie);
    if (!token) return json({ ended: true });
    try { return json(await demoRequest('/status', { token })); }
    catch { return json({ ended: true }); }
};
