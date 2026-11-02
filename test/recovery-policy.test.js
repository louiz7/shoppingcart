'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

test('Shopify pagination uses a supported checkout sort key and forwards cursors', async (t) => {
    const shopify = require('../src/recovery/shopify');
process.env.SHOPIFY_CLIENT_ID = 'synthetic-client';
process.env.SHOPIFY_CLIENT_SECRET = 'synthetic-secret';
    const previousKey = process.env.SHOPIFY_CREDENTIALS_KEY;
    process.env.SHOPIFY_CREDENTIALS_KEY = '11'.repeat(32);
    t.after(() => {
        if (previousKey === undefined) delete process.env.SHOPIFY_CREDENTIALS_KEY;
        else process.env.SHOPIFY_CREDENTIALS_KEY = previousKey;
    });
    let requests = 0;
    t.mock.method(global, 'fetch', async (url, options) => {
        assert.equal(url, 'https://synthetic.myshopify.com/admin/api/2026-10/graphql.json');
        const request = JSON.parse(options.body);
        const sort = /sortKey:([A-Z_]+)/.exec(request.query)?.[1];
        assert.ok(['CHECKOUT_ID','CREATED_AT','CUSTOMER_NAME','ID','RELEVANCE','TOTAL_PRICE'].includes(sort));
        assert.equal(request.variables.after, requests ? 'next-page' : null);
        requests++;
        return Response.json({ data: { abandonedCheckouts: { nodes: [{ id: String(requests) }],
            pageInfo: { hasNextPage: requests === 1, endCursor: 'next-page' } } } });
    });
    const rows = await shopify.listCheckouts({ domain: 'synthetic.myshopify.com', mode: 'live',
        credentials_encrypted: shopify.encryptToken(shopify.offlineCredentials({access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,refresh_token_expires_in:86400})) });
    assert.deepEqual(rows, [{ id: '1' }, { id: '2' }]);
});

test('Shopify checkout normalization accepts USD and rejects mixed or unsupported currencies', () => {
    const { normalizeCheckout } = require('../src/recovery/shopify');
    const node = {
        id: 'gid://shopify/AbandonedCheckout/1', updatedAt: new Date().toISOString(), completedAt: null,
        abandonedCheckoutUrl: 'https://usd-test.myshopify.com/checkouts/test',
        subtotalPriceSet: { presentmentMoney: { amount: '118.00', currencyCode: 'USD' } },
        lineItems: { nodes: [{ title: 'Test product', quantity: 1,
            originalUnitPriceSet: { presentmentMoney: { amount: '118.00', currencyCode: 'USD' } },
            product: { id: 'gid://shopify/Product/1', status: 'ACTIVE' },
            variant: { id: 'gid://shopify/ProductVariant/1', price: '118.00', availableForSale: true,
                inventoryPolicy: 'CONTINUE', sellableOnlineQuantity: 0 } }] },
    };
    const shop = { domain: 'usd-test.myshopify.com', currency: 'USD' };
    const cart = normalizeCheckout(node, shop);
    assert.equal(cart.currency, 'USD'); assert.equal(cart.subtotalCents, 11800);
    assert.throws(() => normalizeCheckout(node, { ...shop, currency: 'EUR' }), /unsupported_currency/);
    node.lineItems.nodes[0].originalUnitPriceSet.presentmentMoney.currencyCode = 'EUR';
    assert.throws(() => normalizeCheckout(node, shop), /mixed_cart_currency/);
    node.subtotalPriceSet.presentmentMoney.currencyCode = 'JPY';
    assert.throws(() => normalizeCheckout(node, shop), /unsupported_currency/);
});
const p = require('../src/recovery/policy');
const shopify = require('../src/recovery/shopify');

const NOW = new Date('2026-11-02T12:00:00Z');
const context = () => ({ shop: { enabled: true, approved_at: NOW, rules: {} }, checkout: {
    id: 'checkout1', phone: '+491234567890', currency: 'EUR', status: 'pending', source_updated_at: '2026-11-02T09:00:00Z',
}, contact: { consent_checkout_id: 'checkout1', phone: '+491234567890', timezone: 'Europe/Berlin', consented_at: '2026-11-01', expires_at: '2026-12-01', evidence: 'Verified checkout callback consent' }, attempts: [] });

test('call policy fails closed for approval, consent, purchase, stop, and control group', () => {
    assert.equal(p.eligibility(context(), NOW), null);
    const cases = [
        ['merchant_not_approved', (c) => c.shop.enabled = false],
        ['consent_missing', (c) => c.contact.evidence = null],
        ['consent_missing', (c) => c.contact.expires_at = undefined],
        ['consent_missing', (c) => c.contact.revoked_at = NOW],
        ['consent_phone_mismatch', (c) => c.checkout.phone = '+49111111111'],
        ['consent_checkout_mismatch', (c) => c.checkout.id = 'another-checkout'],
        ['already_purchased', (c) => c.checkout.completed_at = NOW],
        ['contact_stopped', (c) => c.contact.stopped_at = NOW],
        ['control_group', (c) => c.contact.arm = 'control'],
        ['abandonment_delay', (c) => c.checkout.source_updated_at = NOW],
        ['checkout_expired', (c) => c.checkout.source_updated_at = '2026-10-01'],
        ['contact_busy', (c) => c.active = true],
        ['attempt_limit', (c) => c.attempts = [{ created_at: NOW }, { created_at: NOW }]],
        ['contact_cooldown', (c) => c.attempts = [{ created_at: NOW }]],
    ];
    for (const [expected, mutate] of cases) { const c = context(); mutate(c); assert.equal(p.eligibility(c, NOW), expected); }
});

test('call windows honor contact timezone and daylight saving time', () => {
    assert.equal(p.inWindow(p.rules(), 'Europe/Berlin', new Date('2026-07-06T08:00:00Z')), true);
    assert.equal(p.inWindow(p.rules(), 'Europe/Berlin', new Date('2026-11-02T08:00:00Z')), false);
    assert.equal(p.inWindow(p.rules(), 'Europe/Berlin', new Date('2026-11-02T17:00:00Z')), false);
    assert.equal(p.inWindow(p.rules(), 'Europe/Berlin', new Date('2026-11-01T12:00:00Z')), false);
});

test('trusted owner tests bypass timing gates but preserve customer cooldowns and attempt limits', () => {
    const fresh=context(); fresh.checkout.source_updated_at=NOW;
    assert.equal(p.eligibility(fresh,NOW),'abandonment_delay');
    assert.equal(p.eligibility(fresh,NOW,'call',true),null);
    const late=new Date('2026-11-02T22:00:00Z');
    assert.equal(p.eligibility(context(),late),'outside_call_window');
    assert.equal(p.eligibility(context(),late,'call',true),null);
    const retry=context();retry.attempts=[{created_at:NOW,is_test:true}];
    assert.equal(p.eligibility(retry,NOW,'call',true),null);
    assert.equal(p.eligibility(retry,NOW,'call'), 'contact_cooldown');
    retry.attempts.push({created_at:NOW,is_test:true});
    assert.equal(p.eligibility(retry,NOW,'call',true),null);
    assert.equal(p.eligibility(retry,NOW,'call'),'attempt_limit');
    retry.attempts.push({created_at:NOW,is_test:false});
    assert.equal(p.eligibility(retry,NOW,'call',true),'contact_cooldown');
    for (const [error,change] of [
        ['consent_missing',(c)=>{c.contact.evidence=null;}],['already_purchased',(c)=>{c.checkout.completed_at=NOW;}],
        ['contact_stopped',(c)=>{c.contact.stopped_at=NOW;}],['checkout_expired',(c)=>{c.checkout.source_updated_at='2026-10-01';}],
        ['control_group',(c)=>{c.contact.arm='control';}],['contact_busy',(c)=>{c.active=true;}],
        ['attempt_limit',(c)=>{c.attempts=[{created_at:NOW},{created_at:NOW}];}],
        ['contact_cooldown',(c)=>{c.attempts=[{created_at:NOW}];}],
    ]) {const c=context();change(c);assert.equal(p.eligibility(c,NOW,'call',true),error);}
});

test('integer money and discount ceilings cannot be changed by a model request', () => {
    assert.equal(p.cents('118.00'), 11800);
    assert.equal(p.cents('0.01'), 1);
    for (const invalid of ['1e9', '-5', 'NaN', '1.001', '12,00']) assert.throws(() => p.cents(invalid));
    assert.equal(p.offer({}, 11800, 10).merchandiseTotalCents, 10620);
    assert.throws(() => p.offer({}, 11800, 11), /discount_denied/);
    assert.throws(() => p.offer({}, 11800, 9.9), /discount_denied/);
    assert.throws(() => p.offer({}, 100, 10), /minimum_subtotal/);
    assert.throws(() => p.rules({ maxAttempts: 100 }), /invalid_maxAttempts/);
    assert.throws(() => p.rules(JSON.parse('{"__proto__":{"enabled":true}}')), /unknown_rule/);
});

test('checkout URLs and shop domains reject credential leakage and external destinations', () => {
    const shop = { domain: 'test-shop.myshopify.com', storefront_domain: 'test-shop.example' };
    assert.equal(new URL(p.checkoutUrl('https://test-shop.example/checkouts/test?a=1', shop, 'ABC')).searchParams.get('discount'), 'ABC');
    for (const url of ['javascript:alert(1)', 'https://evil.example/checkout', 'http://test-shop.example/checkout', 'https://secret@test-shop.example', 'https://test-shop.example:444']) assert.throws(() => p.checkoutUrl(url, shop));
    for (const domain of ['localhost', '127.0.0.1', 'valid.myshopify.com.evil.com', 'https://valid.myshopify.com']) assert.throws(() => shopify.domain(domain));
});

test('holdout allocation is stable per shop/contact and has both groups', () => {
    const a = p.contactKey('shop1', '+491234567890');
    assert.notEqual(a, p.contactKey('shop2', '+491234567890'));
    assert.equal(p.assignment('shop1', a, 20), p.assignment('shop1', a, 20));
    const groups = Array.from({ length: 1000 }, (_, i) => p.assignment('shop1', String(i), 20));
    assert.ok(groups.filter((g) => g === 'control').length > 100);
    assert.ok(groups.filter((g) => g === 'control').length < 300);
});

test('webhook verification is over the raw body and rejects tampering', () => {
    const raw = Buffer.from('{"a":1}'), secret = 'test-signing-secret';
    const signature = createHmac('sha256', secret).update(raw).digest('base64');
    assert.equal(shopify.signature(raw, signature, secret), true);
    assert.equal(shopify.signature(Buffer.from('{ "a":1 }'), signature, secret), false);
    assert.equal(shopify.signature(raw, 'invalid', secret), false);
    assert.equal(shopify.signature(raw, signature, ''), false);
});

test('incremental contribution subtracts baseline and costs, requires both groups', () => {
    const report = p.experimentReport([{ arm: 'treatment', purchased: true, contribution_cents: 4000 },
        { arm: 'treatment', purchased: false }, { arm: 'control', purchased: true, contribution_cents: 1000 }], 200);
    assert.equal(report.incrementalContributionCents, 1800);
    assert.equal(p.experimentReport([]).incrementalContributionCents, null);
});
