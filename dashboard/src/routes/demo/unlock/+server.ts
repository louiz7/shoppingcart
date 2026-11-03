import { randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, url }) => {
    if (request.headers.get('origin') !== url.origin) return new Response('Ungültige Anfrage.', { status: 403 });
    if (env.RECOVERY_BROWSER_DEMO_ENABLED !== '1' || !env.SHOPIFY_STOREFRONT_PASSWORD) {
        return new Response('Die automatische Entsperrung ist momentan nicht verfügbar.', { status: 503 });
    }
    // This visitor password is deliberately shared with demo users, never a merchant or admin credential.
    const password = env.SHOPIFY_STOREFRONT_PASSWORD.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    const nonce = randomBytes(18).toString('base64');
    return new Response(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Testshop entsperren</title><body><p>Der Testshop wird entsperrt. Kehre danach zur Demo zurück und wähle „Checkout öffnen“.</p><form method="post" action="https://test-store-slzn5m7l.myshopify.com/password"><input type="hidden" name="password" value="${password}"><button type="submit">Testshop entsperren</button></form><script nonce="${nonce}">document.querySelector('form').requestSubmit();</script></body></html>`, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://test-store-slzn5m7l.myshopify.com; base-uri 'none'; frame-ancestors 'none'`
        }
    });
};
