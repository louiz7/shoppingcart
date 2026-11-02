'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, createHash } = require('node:crypto');
const { AccessToken } = require('livekit-server-sdk');
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
    assert.equal((await fetch(`${base}/webhooks/recovery/twilio?action=00000000-0000-0000-0000-000000000001`, { method: 'POST' })).status, 404);
    for (const path of ['/recovery', '/.env', '/internal/recovery', '/webhooks/recovery/shopify/privacy']) {
        assert.equal((await fetch(base+path)).status, 404);
    }
});

test('Twilio relay requires separate enablement and valid HTTPS/account configuration', () => {
    const options = { secret: 'synthetic-shopify-secret', shopDomain: 'synthetic.myshopify.com', twilioWebhooksEnabled: true,
        publicUrl: 'https://relay.example.invalid', twilioAuthToken: 'synthetic-twilio-token', twilioAccountSid: `AC${'1'.repeat(32)}` };
    for (const publicUrl of [undefined, 'not-a-url', 'http://relay.example.invalid', 'https://user:password@relay.example.invalid',
        'https://relay.example.invalid/path', 'https://relay.example.invalid?target=elsewhere', 'https://relay.example.invalid/#fragment']) {
        assert.throws(() => createOAuthRelay({ ...options, publicUrl }), /public HTTPS origin/);
    }
    assert.throws(() => createOAuthRelay({ ...options, twilioAuthToken: '' }), /credentials/);
    assert.throws(() => createOAuthRelay({ ...options, twilioAccountSid: 'invalid' }), /credentials/);
    assert.doesNotThrow(() => createOAuthRelay({ ...options, twilioWebhooksEnabled: false, publicUrl: undefined, twilioAuthToken: undefined }));
});

test('Twilio relay preserves signed raw callbacks and rejects alternate paths, accounts and payloads', async (t) => {
    const twilioAuthToken = 'synthetic-twilio-relay-token', twilioAccountSid = `AC${'1'.repeat(32)}`;
    const publicUrl = 'https://relay.example.invalid';
    const originalFetch = global.fetch;
    const server = createOAuthRelay({ secret: 'synthetic-shopify-secret', shopDomain: 'synthetic.myshopify.com',
        twilioWebhooksEnabled: true, publicUrl, twilioAuthToken, twilioAccountSid }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = '/webhooks/recovery/twilio?action=00000000-0000-0000-0000-000000000001';
    const params = { AccountSid: twilioAccountSid, MessageSid: `SM${'2'.repeat(32)}`, MessageStatus: 'delivered',
        From: '+4900000000001', To: '+4900000000002', FutureField: ' spaces + & umlaut ä ' };
    const raw = new URLSearchParams(params).toString().replaceAll('+', '%20');
    const sign = (target = path, fields = params, origin = publicUrl) => createHmac('sha1', twilioAuthToken)
        .update(origin + target + Object.keys(fields).sort().map((key) => key + fields[key]).join('')).digest('base64');
    let backendStatus = 200;
    const upstream = t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:3110' + path);
        assert.equal(options.body.toString(), raw);
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
        assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded; charset=UTF-8');
        assert.equal(options.headers['X-Twilio-Signature'], sign());
        assert.equal(options.signal instanceof AbortSignal, true);
        assert.equal(options.headers.Host, undefined); assert.equal(options.headers['X-Forwarded-Host'], undefined);
        return new Response(null, { status: backendStatus });
    });
    const send = (options = {}) => originalFetch(base + (options.path || path), { method: options.method || 'POST',
        body: options.method === 'GET' ? undefined : options.body ?? raw, redirect: 'manual', headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Twilio-Signature': options.signature || sign(),
            Host: 'attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'http', ...options.headers,
        } });
    assert.equal((await send()).status, 200); assert.equal(upstream.mock.calls.length, 1);
    assert.equal((await send({ signature: 'invalid' })).status, 401);
    assert.equal((await send({ signature: sign(path, params, 'https://attacker.invalid') })).status, 401);
    assert.equal((await send({ path: path.replace('000001', '000002') })).status, 401);
    const wrongAccount = { ...params, AccountSid: `AC${'3'.repeat(32)}` };
    assert.equal((await send({ body: new URLSearchParams(wrongAccount).toString(), signature: sign(path, wrongAccount) })).status, 401);
    assert.equal((await send({ body: raw + '&FutureField=duplicate' })).status, 400);
    assert.equal((await send({ body: raw.replace('delivered', 'sent') })).status, 401);
    assert.equal((await send({ path: path + '&action=00000000-0000-0000-0000-000000000002' })).status, 400);
    assert.equal((await send({ path: path + '&extra=1' })).status, 400);
    assert.equal((await send({ path: '/webhooks/recovery/twilio/?action=00000000-0000-0000-0000-000000000001' })).status, 400);
    assert.equal((await send({ path: '/webhooks/recovery/twilio?action=invalid' })).status, 400);
    assert.equal((await send({ body: 'x'.repeat(8193) })).status, 413);
    assert.equal((await send({ headers: { 'Content-Type': 'application/json' } })).status, 400);
    assert.equal((await send({ headers: { 'Content-Encoding': 'gzip' } })).status, 400);
    for (const target of ['/internal/recovery', '/webhooks/livekit', '/webhooks/recovery/twilio/extra']) {
        assert.equal((await send({ path: target })).status, 404);
    }
    assert.equal((await send({ method: 'GET' })).status, 404);
    assert.equal(upstream.mock.calls.length, 1);
    backendStatus = 503; assert.equal((await send()).status, 503);
    upstream.mock.mockImplementation(async () => { throw new Error('synthetic backend timeout'); });
    assert.equal((await send()).status, 502);
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


test('LiveKit relay is separately gated, verifies SDK signatures and forwards recovery rooms only', async (t) => {
    const baseOptions = { secret: 'synthetic-shopify-secret', shopDomain: 'synthetic.myshopify.com' };
    assert.throws(() => createOAuthRelay({ ...baseOptions, livekitWebhooksEnabled: true }), /LiveKit relay credentials/);
    const apiKey = 'synthetic-api-key', apiSecret = 'synthetic-livekit-secret-with-enough-entropy';
    const originalFetch = global.fetch;
    const server = createOAuthRelay({ ...baseOptions, livekitWebhooksEnabled: true,
        livekitApiKey: apiKey, livekitApiSecret: apiSecret }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const payload = { event: 'room_finished', id: 'synthetic-event', createdAt: String(Math.floor(Date.now()/1000)),
        room: { name: 'recovery-00000000-0000-0000-0000-000000000001' } };
    const raw = JSON.stringify(payload);
    const sign = async (body, key = apiKey, secret = apiSecret, ttl = 60) => {
        const token = new AccessToken(key, secret, { ttl });
        token.sha256 = createHash('sha256').update(body).digest('base64');
        return token.toJwt();
    };
    const token = await sign(raw);
    let status = 200;
    const upstream = t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(String(url), 'http://127.0.0.1:3110/webhooks/livekit');
        assert.equal(options.body.toString(), raw); assert.equal(options.headers.Authorization, token);
        assert.equal(options.headers['Content-Type'], 'application/webhook+json');
        assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
        return new Response(null, { status });
    });
    const send = (body = raw, auth = token, path = '/webhooks/livekit', headers = {}) => originalFetch(base+path,
        { method: 'POST', body, headers: { 'Content-Type': 'application/webhook+json', Authorization: auth, ...headers } });
    assert.equal((await send()).status, 200);
    assert.equal((await send(raw+' ')).status, 401);
    assert.equal((await send(raw, 'invalid')).status, 401);
    assert.equal((await send(raw, await sign(raw, 'wrong-project', apiSecret))).status, 401);
    assert.equal((await send(raw, await sign(raw, apiKey, 'wrong-secret'))).status, 401);
    assert.equal((await send(raw, await sign(raw, apiKey, apiSecret, -600))).status, 401);
    for (const name of ['existing-production-room', 'recovery-invalid']) {
        const other = JSON.stringify({ ...payload, room: { name } });
        assert.equal((await send(other, await sign(other))).status, 200);
    }
    assert.equal(upstream.mock.calls.length, 1);
    assert.equal((await send(raw, token, '/webhooks/livekit?target=elsewhere')).status, 400);
    assert.equal((await send(raw, token, '/webhooks/livekit', { 'Content-Type': 'application/json' })).status, 400);
    assert.equal((await send('x'.repeat(1024*1024+1))).status, 413);
    assert.equal((await send(raw, token, '/webhooks/livekit', { 'Content-Encoding': 'gzip' })).status, 400);
    status = 503; assert.equal((await send()).status, 503);
    upstream.mock.mockImplementation(async () => { throw new Error('synthetic upstream timeout'); });
    assert.equal((await send()).status, 502);
    const disabled = createOAuthRelay(baseOptions).listen(0, '127.0.0.1');
    await new Promise((resolve) => disabled.once('listening', resolve));
    try { assert.equal((await originalFetch(`http://127.0.0.1:${disabled.address().port}/webhooks/livekit`, { method: 'POST', body: raw })).status, 404); }
    finally { await new Promise((resolve) => disabled.close(resolve)); }
});
