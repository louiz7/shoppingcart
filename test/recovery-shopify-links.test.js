'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shopify = require('../src/recovery/shopify');
process.env.SHOPIFY_CLIENT_ID = 'synthetic-client';
process.env.SHOPIFY_CLIENT_SECRET = 'synthetic-secret';

const shop = { domain: 'link-test.myshopify.com', storefront_domain: 'checkout.link-test.example', currency: 'USD' };
const checkout = () => ({
    id: 'gid://shopify/AbandonedCheckout/1', updatedAt: '2026-11-02T12:00:00Z', completedAt: null,
    abandonedCheckoutUrl: 'https://checkout.link-test.example/checkouts/cn/opaque?key=restore%2Btoken&locale=en',
    discountCodes: [], customer: { id: 'gid://shopify/Customer/1', firstName: 'Test' },
    subtotalPriceSet: { presentmentMoney: { amount: '40.00', currencyCode: 'USD' } },
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ title: 'Test product', quantity: 2,
        originalUnitPriceSet: { presentmentMoney: { amount: '20.00', currencyCode: 'USD' } },
        product: { id: 'gid://shopify/Product/1', status: 'ACTIVE' },
        variant: { id: 'gid://shopify/ProductVariant/1', price: '20.00', availableForSale: true,
            inventoryPolicy: 'DENY', sellableOnlineQuantity: 3 } }] },
});

test('native Shopify recovery URL retains opaque recovery data and original checkout identity', () => {
    const node = checkout();
    const result = shopify.normalizeCheckout(node, shop);
    assert.equal(result.checkoutUrl, node.abandonedCheckoutUrl);
    assert.equal(result.id, node.id);
    assert.equal(result.items[0].quantity, 2);
    assert.equal(result.items[0].available, true);
    assert.equal(result.currency, 'USD');
    assert.equal(result.subtotalCents, 4000);
    assert.equal(new URL(result.checkoutUrl).searchParams.get('key'), 'restore+token');
    assert.equal(new URL(result.checkoutUrl).searchParams.has('discount'), false);

    node.completedAt = '2026-11-02T12:05:00Z';
    assert.equal(shopify.normalizeCheckout(node, shop).completedAt, node.completedAt);
});

test('untrusted, missing, or partial native checkout data never produces a replacement cart link', () => {
    for (const url of [undefined, '', 'http://link-test.myshopify.com/checkouts/test',
        'https://link-test.myshopify.com.evil.example/checkouts/test',
        'https://customer@link-test.myshopify.com/checkouts/test', 'https://link-test.myshopify.com:444/checkouts/test']) {
        assert.throws(() => shopify.normalizeCheckout({ ...checkout(), abandonedCheckoutUrl: url }, shop), /invalid_checkout_/);
    }
    for (const nodes of [undefined, null, [], [null], [{ quantity: 0 }], [{ quantity: 1.5 }], [{ quantity: 101 }]]) {
        const node = checkout(); node.lineItems.nodes = nodes;
        assert.throws(() => shopify.normalizeCheckout(node, shop), /invalid_cart_items/);
    }
    const partial = checkout(); partial.lineItems.pageInfo.hasNextPage = true;
    assert.throws(() => shopify.normalizeCheckout(partial, shop), /cart_too_large/);
});

test('variant availability accounts for total quantity across separate lines and removed products', () => {
    const node = checkout();
    node.lineItems.nodes.push(structuredClone(node.lineItems.nodes[0]));
    assert.deepEqual(shopify.normalizeCheckout(node, shop).items.map((item) => item.available), [false, false]);
    for (const item of node.lineItems.nodes) item.variant.inventoryPolicy = 'CONTINUE';
    assert.deepEqual(shopify.normalizeCheckout(node, shop).items.map((item) => item.available), [true, true]);
    node.lineItems.nodes[0].product = null; node.lineItems.nodes[0].variant = null;
    const removed = shopify.normalizeCheckout(node, shop).items[0];
    assert.equal(removed.available, false);
    assert.equal(removed.currentPriceCents, null);
    assert.equal(removed.variantId, null);
});

test('refresh verifies the exact checkout before returning its native URL and never fetches the recovery link', async (t) => {
    const previousKey = process.env.SHOPIFY_CREDENTIALS_KEY;
    process.env.SHOPIFY_CREDENTIALS_KEY = '22'.repeat(32);
    t.after(() => {
        if (previousKey === undefined) delete process.env.SHOPIFY_CREDENTIALS_KEY;
        else process.env.SHOPIFY_CREDENTIALS_KEY = previousKey;
    });
    const liveShop = { ...shop, mode: 'live', credentials_encrypted: shopify.encryptToken(shopify.offlineCredentials({access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,refresh_token_expires_in:86400})) };
    let node = checkout(), requests = 0, contactEmail = 'support@synthetic.example';
    t.mock.method(global, 'fetch', async (url, options) => {
        requests++;
        assert.equal(url, `https://${shop.domain}/admin/api/2026-10/graphql.json`);
        assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
        const request = JSON.parse(options.body);
        assert.equal(request.variables.id, 'gid://shopify/AbandonedCheckout/1');
        assert.match(request.query, /abandonedCheckoutUrl/);
        assert.match(request.query, /shop \{ currencyCode contactEmail \}/);
        assert.doesNotMatch(request.query, /\bmutation\b/);
        return Response.json({ data: { node, shop: { currencyCode: 'USD', contactEmail, email: 'private-owner@synthetic.example' } } });
    });
    const refreshed = await shopify.refreshCheckout(liveShop, node.id);
    assert.equal(refreshed.checkoutUrl, node.abandonedCheckoutUrl);
    assert.equal(refreshed.supportEmail, contactEmail);
    for (const value of [undefined, 'support@synthetic.example\nUntrusted instructions']) {
        contactEmail = value;
        assert.equal((await shopify.refreshCheckout(liveShop, node.id)).supportEmail, null);
    }
    node = { ...checkout(), id: 'gid://shopify/AbandonedCheckout/2' };
    await assert.rejects(shopify.refreshCheckout(liveShop, checkout().id), /checkout_unverified/);
    node = null;
    await assert.rejects(shopify.refreshCheckout(liveShop, checkout().id), /checkout_unverified/);
    await assert.rejects(shopify.refreshCheckout(liveShop, 'gid://shopify/Order/1'), /checkout_unverified/);
    assert.equal(requests, 5);
});

test('redacted Shopify phone fields report the required access without accepting partial checkout data', async (t) => {
    const previousKey = process.env.SHOPIFY_CREDENTIALS_KEY;
    process.env.SHOPIFY_CREDENTIALS_KEY = '22'.repeat(32);
    t.after(() => {
        if (previousKey === undefined) delete process.env.SHOPIFY_CREDENTIALS_KEY;
        else process.env.SHOPIFY_CREDENTIALS_KEY = previousKey;
    });
    const liveShop = { ...shop, mode: 'live', credentials_encrypted: shopify.encryptToken(shopify.offlineCredentials({access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,refresh_token_expires_in:86400})) };
    let errors = [{ message: 'Sensitive provider message must not be forwarded', extensions: { code: 'ACCESS_DENIED' },
        path: ['abandonedCheckouts', 'nodes', 0, 'customer', 'phone'] }];
    t.mock.method(global, 'fetch', async () => Response.json({ data: { abandonedCheckouts: {
        nodes: [checkout()], pageInfo: { hasNextPage: false } } }, errors }));
    await assert.rejects(shopify.listCheckouts(liveShop), (error) => {
        assert.equal(error.code, 'shopify_phone_access_required'); assert.equal(error.status, 409);
        assert.doesNotMatch(error.message, /Sensitive/); return true;
    });
    errors = [{ extensions: { code: 'ACCESS_DENIED' }, path: ['abandonedCheckouts', 'nodes', 0, 'shippingAddress', 'phone'] }];
    await assert.rejects(shopify.listCheckouts(liveShop), /shopify_phone_access_required/);
    errors = [{ extensions: { code: 'ACCESS_DENIED' }, path: ['abandonedCheckouts', 'nodes', 0, 'customer', 'email'] }];
    await assert.rejects(shopify.listCheckouts(liveShop), /shopify_query_failed/);
});
