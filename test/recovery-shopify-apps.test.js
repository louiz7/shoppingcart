'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const shopify = require('../src/recovery/shopify');

// Real local PostgreSQL; every Shopify response and provider action stays synthetic.
test('separate Shopify apps bind OAuth, refresh and webhooks to one exact shop and original client', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/shoppingcart');
    const { db } = require('../src/recovery/store');
    const { decryptShopifyCredentials } = require('../src/services/shopify-crypto');
    const { startOAuth, oauthRouter } = require('../src/recovery/routes');
    const hooks = require('../src/recovery/webhooks');
    const env = { SHOPIFY_CLIENT_ID: 'primary-client', SHOPIFY_CLIENT_SECRET: 'primary-secret',
        RECOVERY_SHOPIFY_CUSTOM_DOMAIN: 'custom-merchant.myshopify.com', SHOPIFY_CUSTOM_CLIENT_ID: 'custom-client',
        SHOPIFY_CUSTOM_CLIENT_SECRET: 'custom-secret', SHOPIFY_CREDENTIALS_KEY: '44'.repeat(32),
        RECOVERY_SHOPIFY_REDIRECT_URI: 'https://synthetic.example/admin/integrations/shopify/callback' };
    const prior = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
    const tenant = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id', ['Synthetic app isolation', `${randomUUID()}@example.invalid`])).rows[0].id;
    const other = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id', ['Synthetic other app tenant', `${randomUUID()}@example.invalid`])).rows[0].id;
    const nativeFetch = global.fetch; let handler = () => { throw Error('Unexpected provider request'); };
    t.mock.method(global, 'fetch', (...args) => handler(...args));
    const registration = t.mock.method(shopify, 'registerWebhooks', async () => {});
    const app = require('express')();
    app.use('/integrations/recovery/shopify', oauthRouter); app.use('/webhooks/recovery', hooks.router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        await new Promise(resolve => server.close(resolve));
        await db.query('DELETE FROM customers WHERE id=ANY($1::int[])', [[tenant, other]]); await db.pool.end();
        for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });
    const response = () => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600,
        refresh_token_expires_in: 86400, scope: shopify.SCOPES.join(',') });
    const sign = (params, secret) => {
        const message = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
        params.set('hmac', createHmac('sha256', secret).update(message).digest('hex')); return params;
    };
    const callback = (state, secret = env.SHOPIFY_CUSTOM_CLIENT_SECRET) => {
        const params = sign(new URLSearchParams({ state, code: 'synthetic-code', shop: env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN,
            timestamp: String(Math.floor(Date.now() / 1000)) }), secret);
        return nativeFetch(`${base}/integrations/recovery/shopify/callback?${params}`, { redirect: 'manual' });
    };
    let customShop;

    await t.test('only the exact configured domain selects custom credentials, with no incomplete-config fallback', () => {
        assert.equal(shopify.appConfig(env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN).clientId, 'custom-client');
        for (const domain of ['primary-store.myshopify.com', 'custom-merchant-extra.myshopify.com']) assert.equal(shopify.appConfig(domain).clientId, 'primary-client');
        assert.throws(() => shopify.appConfig('https://custom-merchant.myshopify.com'), /invalid_shop_domain/);
        delete process.env.SHOPIFY_CUSTOM_CLIENT_SECRET;
        assert.throws(() => shopify.appConfig(env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN), /shopify_app_not_configured/);
        assert.equal(shopify.appConfig('primary-store.myshopify.com').clientId, 'primary-client');
        process.env.SHOPIFY_CUSTOM_CLIENT_SECRET = env.SHOPIFY_CUSTOM_CLIENT_SECRET;
        assert.throws(() => shopify.shopApp({ domain: env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN }, { access_token: 'legacy-primary' }), /shopify_app_mismatch/);
    });

    await t.test('OAuth state binds client ID; other app HMAC, changed identity and duplicate parameters cannot consume it', async () => {
        const authorization = new URL((await startOAuth(tenant, env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN)).url);
        const state = authorization.searchParams.get('state'); assert.equal(authorization.searchParams.get('client_id'), 'custom-client');
        const duplicate = new URLSearchParams({ state, code: 'synthetic-code', shop: env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN,
            timestamp: String(Math.floor(Date.now() / 1000)) });
        duplicate.append('shop', env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN);
        assert.equal((await nativeFetch(`${base}/integrations/recovery/shopify/callback?${sign(duplicate, env.SHOPIFY_CUSTOM_CLIENT_SECRET)}`, { redirect: 'manual' })).status, 401);
        assert.equal((await callback(state, env.SHOPIFY_CLIENT_SECRET)).status, 401);
        const hash = require('../src/recovery/service').hash(state);
        assert.equal((await db.query('SELECT app_client_id FROM recovery_oauth_states WHERE state_hash=$1', [hash])).rows[0].app_client_id, 'custom-client');
        await db.query('UPDATE recovery_oauth_states SET app_client_id=$2 WHERE state_hash=$1', [hash, 'wrong-client']);
        assert.equal((await callback(state)).status, 401);
        await db.query('UPDATE recovery_oauth_states SET app_client_id=$2 WHERE state_hash=$1', [hash, 'custom-client']);
        let tokens = 0;
        handler = async (url, options) => {
            if (url.endsWith('/admin/oauth/access_token')) {
                tokens++; const body = new URLSearchParams(options.body);
                assert.equal(body.get('client_id'), 'custom-client'); assert.equal(body.get('client_secret'), 'custom-secret');
                assert.equal(body.get('expiring'), '1'); return Response.json(response());
            }
            return Response.json({ data: { shop: { name: 'Synthetic merchant', primaryDomain: { host: 'custom.example.invalid' }, currencyCode: 'EUR' } } });
        };
        assert.equal((await callback(state)).status, 303); assert.equal(tokens, 1);
        customShop = (await db.query('SELECT * FROM recovery_shops WHERE domain=$1', [env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN])).rows[0];
        assert.equal(customShop.customer_id, tenant); assert.equal(customShop.enabled, false);
        assert.equal(customShop.shopify_app_client_id, 'custom-client'); assert.equal(decryptShopifyCredentials(customShop.credentials_encrypted).app_client_id, 'custom-client');
        assert.equal(registration.mock.calls.length, 1); assert.equal((await callback(state)).status, 401); assert.equal(tokens, 1);
        const foreign = new URL((await startOAuth(other, customShop.domain)).url).searchParams.get('state');
        assert.equal((await callback(foreign)).status, 409); assert.equal(tokens, 1);
    });

    await t.test('refresh uses the original custom app; changed domain mapping and conflicting encrypted identity fail before any request', async () => {
        const expired = { ...shopify.offlineCredentials(response()), app_client_id: 'custom-client', expires_at: new Date(Date.now() - 1000).toISOString() };
        await db.query('UPDATE recovery_shops SET credentials_encrypted=$2 WHERE id=$1', [customShop.id, shopify.encryptToken(expired)]);
        let requests = 0;
        handler = async (url, options) => {
            requests++;
            if (url.endsWith('/admin/oauth/access_token')) {
                const body = new URLSearchParams(options.body); assert.equal(body.get('client_id'), 'custom-client');
                assert.equal(body.get('client_secret'), 'custom-secret'); assert.equal(body.get('grant_type'), 'refresh_token');
                return Response.json(response());
            }
            return Response.json({ data: { ok: true } });
        };
        assert.deepEqual(await shopify.graphql(customShop, 'query A { shop { id } }'), { ok: true }); assert.equal(requests, 2);
        delete process.env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN;
        await assert.rejects(shopify.graphql(customShop, 'query A { shop { id } }'), /shopify_app_mismatch/); assert.equal(requests, 2);
        process.env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN = env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN;
        await db.query('UPDATE recovery_shops SET credentials_encrypted=$2 WHERE id=$1', [customShop.id, shopify.encryptToken({ ...expired, app_client_id: 'primary-client' })]);
        await assert.rejects(shopify.graphql(customShop, 'query A { shop { id } }'), /shopify_app_mismatch/); assert.equal(requests, 2);
        await db.query('UPDATE recovery_shops SET credentials_encrypted=$2 WHERE id=$1', [customShop.id, shopify.encryptToken(expired)]);
    });

    await t.test('webhooks accept only the exact shop app secret, including privacy events after uninstall clears tokens', async () => {
        const send = (topic, secret, privacy = false, domain = customShop.domain) => {
            const raw = JSON.stringify({ shop_domain: domain, id: 123 });
            const path = privacy ? 'privacy' : `${customShop.id}/${shopify.webhookCapability(customShop.id)}`;
            return nativeFetch(`${base}/webhooks/recovery/shopify/${path}`, { method: 'POST', body: raw, headers: {
                'Content-Type': 'application/json', 'x-shopify-shop-domain': domain, 'x-shopify-topic': topic,
                'x-shopify-event-id': randomUUID(), 'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'),
            } });
        };
        assert.equal((await send('checkouts/update', 'primary-secret')).status, 401);
        assert.equal((await send('checkouts/update', 'custom-secret')).status, 200);
        assert.equal((await send('checkouts/update', 'custom-secret', false, 'foreign.myshopify.com')).status, 404);
        assert.equal((await send('app/uninstalled', 'custom-secret')).status, 200);
        const removed = (await db.query('SELECT credentials_encrypted,shopify_app_client_id FROM recovery_shops WHERE id=$1', [customShop.id])).rows[0];
        assert.equal(removed.credentials_encrypted, null); assert.equal(removed.shopify_app_client_id, 'custom-client');
        assert.equal((await send('customers/data_request', 'primary-secret', true)).status, 401);
        assert.equal((await send('customers/data_request', 'custom-secret', true)).status, 200);
    });
});
