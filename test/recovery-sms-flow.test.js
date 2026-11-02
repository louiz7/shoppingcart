'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const telephony = require('../src/recovery/telephony');

test('Twilio SMS validates configuration and recipient before sending a single bounded request', async (t) => {
    const settings = { RECOVERY_LIVE_ENABLED: '1', RECOVERY_SMS_ENABLED: '1',
        TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'synthetic-test-token',
        TWILIO_SMS_FROM: '+4900000000002', RECOVERY_PUBLIC_URL: 'https://recovery.example.invalid' };
    const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
    Object.assign(process.env, settings);
    t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    const action = randomUUID(), number = '+4900000000001';
    const request = t.mock.method(global, 'fetch', async () => ({ ok: true,
        json: async () => ({ sid: `SM${'b'.repeat(32)}`, status: 'queued' }) }));
    process.env.RECOVERY_SMS_ENABLED = '0';
    await assert.rejects(telephony.sendSms(number, 'Synthetic checkout link', action), { code: 'sms_disabled', smsDispatched: false });
    process.env.RECOVERY_SMS_ENABLED = '1';
    for (const invalid of ['http://example.invalid', 'https://user:password@example.invalid', 'invalid']) {
        process.env.RECOVERY_PUBLIC_URL = invalid;
        await assert.rejects(telephony.sendSms(number, 'Synthetic checkout link', action), { code: 'sms_not_configured', smsDispatched: false });
    }
    process.env.RECOVERY_PUBLIC_URL = settings.RECOVERY_PUBLIC_URL;
    await assert.rejects(telephony.sendSms('00490000000001', 'Synthetic', action), { code: 'invalid_sms_request', smsDispatched: false });
    await assert.rejects(telephony.sendSms(number, 'Synthetic', 'not-an-action'), { code: 'invalid_sms_request', smsDispatched: false });
    assert.equal(request.mock.calls.length, 0);
    assert.deepEqual(await telephony.sendSms(number, 'Synthetic checkout link', action), { id: `SM${'b'.repeat(32)}`, status: 'queued' });
    assert.equal(request.mock.calls.length, 1);
    const [url, options] = request.mock.calls[0].arguments;
    assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${settings.TWILIO_ACCOUNT_SID}/Messages.json`);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(options.body.get('To'), number); assert.equal(options.body.get('From'), settings.TWILIO_SMS_FROM);
    assert.equal(options.body.get('Body'), 'Synthetic checkout link');
    assert.equal(options.body.get('StatusCallback'), `https://recovery.example.invalid/webhooks/recovery/twilio?action=${action}`);
    request.mock.mockImplementation(async () => { throw new Error('Synthetic ambiguous network timeout'); });
    await assert.rejects(telephony.sendSms(number, 'Synthetic', action), /ambiguous network timeout/);
    assert.equal(request.mock.calls.length, 2);
    request.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ sid: `SM${'b'.repeat(32)}` }) }));
    await assert.rejects(telephony.sendSms(number, 'Synthetic', action), /invalid_sms_acknowledgement/);
    assert.equal(request.mock.calls.length, 3);
});

test('native checkout SMS needs no discount and remains bound to the verified caller', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const database = new URL(process.env.DATABASE_URL);
    assert.equal(database.hostname, '127.0.0.1'); assert.equal(database.port, '55433'); assert.equal(database.pathname, '/shoppingcart');
    const { db, transaction } = require('../src/recovery/store');
    const service = require('../src/recovery/service');
    const policy = require('../src/recovery/policy');
    const shopify = require('../src/recovery/shopify');
    const tenants = [];
    t.mock.method(global, 'fetch', async () => { throw new Error('External network forbidden'); });
    const ready = t.mock.method(telephony, 'assertSmsReady', () => {});
    const send = t.mock.method(telephony, 'sendSms', async () => ({ id: `SM${'c'.repeat(32)}`, status: 'queued' }));
    t.mock.method(telephony, 'hangup', async () => {});
    t.mock.method(shopify, 'refreshCheckout', async (shop, id) =>
        (await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2', [shop.id, id])).rows[0].snapshot);
    t.after(async () => {
        for (const tenant of tenants) await db.query('DELETE FROM customers WHERE id=$1', [tenant]);
        await db.pool.end();
    });

    async function fixture() {
        const shopId = randomUUID();
        const customerId = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',
            [`SMS test ${shopId}`, `${shopId}@example.invalid`])).rows[0].id;
        tenants.push(customerId);
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,currency) VALUES($1,$2,$3,'Test shop','USD')`,
            [shopId, customerId, `${shopId}.myshopify.com`]);
        const shop = await service.shopFor(customerId, shopId);
        const snapshot = { id: 'gid://shopify/AbandonedCheckout/123', updatedAt: new Date(Date.now()-7200000).toISOString(),
            completedAt: null, phone: '+4900000000001', email: 'synthetic@example.invalid', currency: 'USD',
            subtotalCents: 11800, discountCodes: [], checkoutUrl: `https://${shop.domain}/checkouts/opaque-original?key=synthetic`,
            items: [{ title: 'Hoodie', quantity: 1, variantId: 'gid://shopify/ProductVariant/1', originalUnitCents: 11800, currentPriceCents: 11800, available: true }] };
        await transaction((client) => service.upsertCheckout(client, shop, snapshot));
        const checkoutId = (await db.query('SELECT id FROM recovery_checkouts WHERE shop_id=$1', [shopId])).rows[0].id;
        await service.saveSettings(customerId, shopId, { brand: 'Test shop', brand_voice: 'Friendly', enabled: true, approval: true, rules: shop.rules });
        await service.consent(customerId, shopId, checkoutId, { verified: true, evidence: 'Synthetic test-only contact permission', timezone: 'Europe/Berlin',
            consentedAt: new Date(Date.now()-86400000).toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString() });
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [shopId]);
        await db.query(`UPDATE recovery_contacts SET arm='treatment' WHERE shop_id=$1`, [shopId]);
        const call = { id: randomUUID(), shop_id: shopId, checkout_id: checkoutId, customer_id: customerId, identity_verified: true };
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,identity_verified)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes','connected',TRUE)`,
            [call.id, shopId, checkoutId, policy.contactKey(shopId, snapshot.phone), `recovery-${call.id}`, randomUUID()]);
        await service.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte senden Sie mir den Link per SMS.' });
        return { call, snapshot, customerId, shopId, checkoutId };
    }

    await t.test('original opaque checkout URL is sent once without creating an offer', async () => {
        const f = await fixture(), before = send.mock.calls.length;
        assert.deepEqual(await service.sendLink(f.call), { status: 'accepted', delivered: false });
        assert.deepEqual(await service.sendLink(f.call), { status: 'accepted', duplicate: true });
        assert.equal(send.mock.calls.length, before+1);
        assert.equal(send.mock.calls[before].arguments[0], f.snapshot.phone);
        assert.equal(send.mock.calls[before].arguments[1], `Test shop: Hier ist Ihr gewünschter Checkout-Link: ${f.snapshot.checkoutUrl}`);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [f.checkoutId])).rows[0].n, 0);
    });
    await t.test('disabled or missing SMS configuration reserves no intent', async () => {
        const f = await fixture(), before = send.mock.calls.length;
        ready.mock.mockImplementation(() => { throw policy.problem('sms_disabled', 409); });
        try { await assert.rejects(service.sendLink(f.call), /sms_disabled/); }
        finally { ready.mock.mockImplementation(() => {}); }
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`, [f.checkoutId])).rows[0].n, 0);
        assert.equal(send.mock.calls.length, before);
        assert.equal((await service.sendLink(f.call)).status, 'accepted');
    });
    await t.test('cached identity cannot authorize a changed contact or ended call', async () => {
        const f = await fixture(), before = send.mock.calls.length;
        await db.query(`UPDATE recovery_calls SET status='ended' WHERE id=$1`, [f.call.id]);
        await assert.rejects(service.sendLink(f.call), /call_authorization_changed/);
        await db.query(`UPDATE recovery_calls SET status='connected',identity_verified=FALSE WHERE id=$1`, [f.call.id]);
        await assert.rejects(service.sendLink(f.call), /call_authorization_changed/);
        const otherPhone = '+4900000000009', otherContact = policy.contactKey(f.shopId, otherPhone);
        await db.query('INSERT INTO recovery_contacts(shop_id,contact_key,phone) VALUES($1,$2,$3)', [f.shopId, otherContact, otherPhone]);
        await db.query('UPDATE recovery_calls SET identity_verified=TRUE,contact_key=$2 WHERE id=$1', [f.call.id, otherContact]);
        await assert.rejects(service.sendLink(f.call), /call_authorization_changed/);
        assert.equal(send.mock.calls.length, before);
    });
    await t.test('unconfirmed or simulated discounts are not sent through a live checkout SMS', async () => {
        const f = await fixture(), before = send.mock.calls.length;
        await db.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'offer','unknown','{}')`, [randomUUID(), f.checkoutId]);
        await assert.rejects(service.sendLink(f.call), /valid_offer_required/);
        await db.query(`UPDATE recovery_actions SET status='simulated',data=$2 WHERE checkout_id=$1 AND kind='offer'`, [f.checkoutId,
            JSON.stringify({ ...policy.offer({}, 11800, 10), currency: 'USD', expiresAt: new Date(Date.now()+3600000).toISOString(),
                cartHash: policy.cartHash(f.snapshot), checkoutUrl: `${f.snapshot.checkoutUrl}&discount=FAKE` })]);
        await assert.rejects(service.sendLink(f.call), /valid_offer_required/);
        assert.equal(send.mock.calls.length, before);
    });
    await t.test('receipt before acknowledgement and immediate delivery survive persistence', async () => {
        const f = await fixture(), providerId = `SM${'d'.repeat(32)}`;
        send.mock.mockImplementation(async (number, text, action) => {
            await db.query(`INSERT INTO recovery_sms_receipts(action_id,provider_id,status) VALUES($1,$2,'delivered')`, [action, providerId]);
            return { id: providerId, status: 'queued' };
        });
        try { assert.deepEqual(await service.sendLink(f.call), { status: 'delivered', delivered: true }); }
        finally { send.mock.mockImplementation(async () => ({ id: `SM${'c'.repeat(32)}`, status: 'queued' })); }
        const direct = await fixture();
        send.mock.mockImplementation(async () => ({ id: providerId, status: 'delivered' }));
        try { assert.deepEqual(await service.sendLink(direct.call), { status: 'delivered', delivered: true }); }
        finally { send.mock.mockImplementation(async () => ({ id: `SM${'c'.repeat(32)}`, status: 'queued' })); }
    });
});
