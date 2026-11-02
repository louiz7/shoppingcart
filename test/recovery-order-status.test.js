'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('voice order status exposes only a proven original-checkout order and minimal state', {
    skip: process.env.RECOVERY_DB_TEST!=='1',timeout: 15000,
},async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55433'); assert.equal(url.pathname,'/shoppingcart');
    const { db } = require('../src/recovery/store');
    const shopify = require('../src/recovery/shopify');
    const hooks = require('../src/recovery/webhooks');
    const keys = ['SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_CREDENTIALS_KEY'];
    const previous = Object.fromEntries(keys.map((key) => [key,process.env[key]]));
    process.env.SHOPIFY_CLIENT_ID='synthetic-order-status-app'; process.env.SHOPIFY_CLIENT_SECRET='synthetic-order-status-secret';
    process.env.SHOPIFY_CREDENTIALS_KEY='33'.repeat(32);
    const customers = [];
    t.after(async () => {
        for (const id of customers) await db.query('DELETE FROM customers WHERE id=$1',[id]);
        for (const [key,value] of Object.entries(previous)) { if (value===undefined) delete process.env[key]; else process.env[key]=value; }
        await db.pool.end();
    });
    async function fixture() {
        const id = randomUUID(),checkoutId = randomUUID();
        const customerId = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',
            [`Synthetic orders ${id}`,`${id}@example.invalid`])).rows[0].id;
        customers.push(customerId);
        const encrypted = shopify.encryptToken({ ...shopify.offlineCredentials({ access_token: 'synthetic-order-token',
            refresh_token: 'synthetic-order-refresh',expires_in: 3600,refresh_token_expires_in: 86400 }),app_client_id:process.env.SHOPIFY_CLIENT_ID });
        const shop = (await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,credentials_encrypted)
            VALUES($1,$2,$3,'Synthetic shop','live',$4) RETURNING *`,[id,customerId,`${id}.myshopify.com`,encrypted])).rows[0];
        const checkout = (await db.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,checkout_token,currency,source_updated_at)
            VALUES($1,$2,'gid://shopify/AbandonedCheckout/123','original-token','EUR',NOW()) RETURNING *`,[checkoutId,id])).rows[0];
        return { shop,checkout };
    }
    const f = await fixture(),foreign = await fixture();
    let node = { id: 'gid://shopify/Order/111',test: false,displayFinancialStatus: 'PAID',displayFulfillmentStatus: 'FULFILLED',
        name: 'Must not disclose',fulfillments: [{trackingInfo: [{number: 'must-not-disclose'}]}] };
    const fetch = t.mock.method(global,'fetch',async (destination,options) => {
        assert.equal(destination,`https://${f.shop.domain}/admin/api/2026-10/graphql.json`);
        const request = JSON.parse(options.body);
        assert.deepEqual(request.variables,{ id: 'gid://shopify/Order/111' });
        assert.doesNotMatch(request.query,/customer\(|trackingInfo|fulfillments|\bname\b|\bmutation\b/);
        return Response.json({ data: { node } });
    });
    assert.deepEqual((await shopify.orderStatus(f.shop,f.checkout)).orders,[]);
    assert.equal(fetch.mock.calls.length,0);
    const payload = { id: 111,checkout_id: 123,checkout_token: 'original-token',currency: 'EUR',financial_status: 'paid',
        current_subtotal_price: '10.00',created_at: '2026-11-03T10:00:00Z',updated_at: '2026-11-03T10:00:00Z' };
    await hooks.ingestShopify(f.shop,'orders/paid',payload,randomUUID());
    await hooks.ingestShopify(f.shop,'orders/paid',{ ...payload,id: 999,checkout_id: 999,checkout_token: 'unrelated-token',
        created_at: '2026-11-03T11:00:00Z',updated_at: '2026-11-03T11:00:00Z' },randomUUID());
    await hooks.ingestShopify(foreign.shop,'orders/paid',{ ...payload,id: 888 },randomUUID());
    assert.deepEqual((await shopify.orderStatus(f.shop,f.checkout)).orders,[{ test: false,displayFinancialStatus: 'PAID',displayFulfillmentStatus: 'FULFILLED' }]);
    await assert.rejects(shopify.orderStatus(f.shop,foreign.checkout),/order_checkout_missing/);
    node = { ...node,id: 'gid://shopify/Order/999' };
    await assert.rejects(shopify.orderStatus(f.shop,f.checkout),/order_unverified/);
});
