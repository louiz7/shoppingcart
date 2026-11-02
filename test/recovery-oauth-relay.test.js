'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createOAuthRelay, CALLBACK } = require('../scripts/shoppingcart-oauth-relay');

test('OAuth-only relay preserves local authentication and rejects other traffic', async (t) => {
    const secret = 'synthetic-relay-test-secret', shopDomain = 'synthetic.myshopify.com';
    const server = createOAuthRelay({ secret, shopDomain }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signed = (overrides = {}) => {
        const params = new URLSearchParams({ code: 'synthetic-code', shop: shopDomain,
            state: 'a'.repeat(64), timestamp: String(Math.floor(Date.now()/1000)), ...overrides });
        const message = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('&');
        params.set('hmac', createHmac('sha256', secret).update(message).digest('hex'));
        return params;
    };
    const params = signed();
    const response = await fetch(`${base}${CALLBACK}?${params}`, { redirect: 'manual', headers: { Host: 'attacker.invalid' } });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `http://localhost:5173${CALLBACK}?${params}`);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    for (const query of [signed({ shop: 'other.myshopify.com' }), signed({ timestamp: '0' }), signed({ state: '' }),
        new URLSearchParams(`${params}&shop=${shopDomain}`), new URLSearchParams('hmac=bad')]) {
        assert.equal((await fetch(`${base}${CALLBACK}?${query}`, { redirect: 'manual' })).status, 401);
    }
    assert.equal((await fetch(`${base}${CALLBACK}?${params}`, { method: 'POST' })).status, 405);
    for (const path of ['/recovery', '/.env', '/internal/recovery', '/webhooks/recovery/shopify/privacy']) {
        assert.equal((await fetch(base+path)).status, 404);
    }
});

test('webhook relay forwards only signed test-shop payloads to the fixed local webhook endpoint', async (t) => {
    const secret = 'synthetic-webhook-test-secret', shopDomain = 'synthetic.myshopify.com';
    const originalFetch = global.fetch;
    const server = createOAuthRelay({ secret, shopDomain, webhooksEnabled: true }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = `/webhooks/recovery/shopify/00000000-0000-0000-0000-000000000001/${'a'.repeat(64)}`;
    const raw = JSON.stringify({ id: 123, shop_domain: shopDomain });
    const signature = createHmac('sha256', secret).update(raw).digest('base64');
    const headers = { 'Content-Type':'application/json', 'x-shopify-hmac-sha256':signature,
        'x-shopify-shop-domain':shopDomain, 'x-shopify-topic':'checkouts/update', 'x-shopify-event-id':'synthetic-event' };
    let backendStatus = 200;
    const upstream = t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(new URL(url).origin, 'http://127.0.0.1:3110');
        assert.ok([path,'/webhooks/recovery/shopify/privacy'].includes(new URL(url).pathname));
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
        assert.equal(options.body.toString(), raw);
        assert.equal(options.headers['x-shopify-hmac-sha256'], signature);
        assert.equal(options.headers['x-shopify-event-id'], 'synthetic-event');
        return Response.json({ received: backendStatus === 200 }, { status: backendStatus });
    });
    const send = (target = path, body = raw, extraHeaders = {}) => originalFetch(base+target,
        { method:'POST', body, headers:{ ...headers, ...extraHeaders }, redirect:'manual' });
    assert.equal((await send()).status, 200);
    assert.equal((await send('/webhooks/recovery/shopify/privacy')).status, 200);
    assert.equal(upstream.mock.calls.length, 2);
    assert.equal((await send(path, raw+' ')).status, 401);
    assert.equal((await send(path, raw, { 'x-shopify-shop-domain':'other.myshopify.com' })).status, 401);
    assert.equal((await send('/internal/recovery/admin')).status, 404);
    assert.equal((await send('/webhooks/livekit')).status, 404);
    assert.equal((await send('/webhooks/recovery/twilio')).status, 404);
    assert.equal((await send(path, 'x'.repeat(1024*1024+1))).status, 413);
    assert.equal(upstream.mock.calls.length, 2);
    backendStatus = 503;
    assert.equal((await send()).status, 503);
    upstream.mock.mockImplementation(async () => { throw new Error('synthetic timeout'); });
    assert.equal((await send()).status, 502);
});
