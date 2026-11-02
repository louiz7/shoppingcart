'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('cart recovery persists policy, isolation and exactly-once intents in local PostgreSQL', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/shoppingcart');
    const { db, transaction } = require('../src/recovery/store');
    const s = require('../src/recovery/service');
    const p = require('../src/recovery/policy');
    const shopify = require('../src/recovery/shopify');
    const tel = require('../src/recovery/telephony');
    const hooks = require('../src/recovery/webhooks');
    const tenantIds = [];
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('External network is forbidden in recovery integration tests'); };
    t.after(async () => {
        global.fetch = originalFetch;
        for (const id of tenantIds) await db.query('DELETE FROM customers WHERE id=$1', [id]);
        await db.pool.end();
    });
    const hangup = t.mock.method(tel, 'hangup', async () => {});
    const configured = t.mock.method(tel, 'configured', () => true);
    const dial = t.mock.method(tel, 'dial', async () => ({ participantId: 'test-only' }));
    const discount = t.mock.method(shopify, 'createDiscount', async () => 'test-discount');
    const sms = t.mock.method(tel, 'sendSms', async () => ({ id: `SM${'a'.repeat(32)}`, status: 'queued' }));
    t.mock.method(tel, 'assertSmsReady', () => {});

    async function fixture() {
        const shopId = randomUUID(), tenant = await db.query(`INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id`, [`Recovery test ${shopId}`, `${randomUUID()}@example.invalid`]);
        const customerId = tenant.rows[0].id; tenantIds.push(customerId);
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,rules) VALUES($1,$2,$3,'Test shop',$4)`,
        [shopId, customerId, `${shopId}.myshopify.com`, JSON.stringify(p.rules({ weekdays: [1,2,3,4,5,6,7], start: '00:00', end: '23:59' }))]);
        const shop = await s.shopFor(customerId, shopId);
        const snapshot = { id: 'gid://shopify/AbandonedCheckout/123', updatedAt: new Date(Date.now()-7200000).toISOString(),
            completedAt: null, phone: '+4900000000001', email: 'synthetic@example.invalid', currency: 'EUR', customerId: 'gid://shopify/Customer/1',
            subtotalCents: 11800, discountCodes: [], checkoutUrl: `https://${shop.domain}/checkouts/test`,
            items: [{ title: 'Hoodie', quantity: 1, variantId: 'gid://shopify/ProductVariant/1', originalUnitCents: 11800, currentPriceCents: 11800, available: true }] };
        await transaction((c) => s.upsertCheckout(c, shop, snapshot, 'checkout-token-123'));
        const { rows } = await db.query('SELECT id FROM recovery_checkouts WHERE shop_id=$1', [shopId]);
        const checkoutId = rows[0].id;
        return { customerId, shopId, checkoutId, snapshot, shop };
    }
    async function activate(f) {
        await s.saveSettings(f.customerId, f.shopId, { brand: 'Test', brand_voice: 'Freundlich.', enabled: true, approval: true, rules: f.shop.rules });
        await s.consent(f.customerId, f.shopId, f.checkoutId, { verified: true, evidence: 'Synthetic test-only callback consent evidence',
            consentedAt: new Date(Date.now()-86400000).toISOString(), expiresAt: new Date(Date.now()+86400000).toISOString(), timezone: 'Europe/Berlin' });
        await db.query(`UPDATE recovery_contacts SET arm='treatment' WHERE shop_id=$1`, [f.shopId]);
    }
    async function fakeCall(f) {
        const id = randomUUID();
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,identity_verified)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes','dialing',TRUE)`,
        [id, f.shopId, f.checkoutId, p.contactKey(f.shopId, f.snapshot.phone), `recovery-${id}`, randomUUID()]);
        return { id, shop_id: f.shopId, checkout_id: f.checkoutId, customer_id: f.customerId, identity_verified: true };
    }
    t.mock.method(shopify, 'refreshCheckout', async (shop, externalId) => {
        const r = await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2', [shop.id, externalId]);
        return r.rows[0].snapshot;
    });

    await t.test('no merchant activation, no consent, and foreign tenant all fail closed', async () => {
        const f = await fixture();
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /merchant_not_approved/);
        await s.saveSettings(f.customerId, f.shopId, { brand: 'Test', brand_voice: 'Friendly', enabled: true, approval: true, rules: f.shop.rules });
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /consent_missing/);
        await assert.rejects(s.shopFor(f.customerId+9999, f.shopId), /shop_not_found/);
        assert.equal((await s.dashboard(f.customerId+9999)).checkouts.length, 0);
        assert.equal(dial.mock.calls.length, 0);
    });

    await t.test('concurrent simulation reservations count once per contact and honor cooldown', async () => {
        const f = await fixture(); await activate(f);
        const results = await Promise.allSettled([s.startCall(f.customerId, f.shopId, f.checkoutId), s.startCall(f.customerId, f.shopId, f.checkoutId)]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_calls WHERE shop_id=$1', [f.shopId])).rows[0].n, 1);
        assert.equal(dial.mock.calls.length, 0);
    });

    await t.test('control contacts are enrolled but never dialed', async () => {
        const f = await fixture(); await activate(f);
        await db.query(`UPDATE recovery_contacts SET arm='control' WHERE shop_id=$1`, [f.shopId]);
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /control_group/);
        assert.equal(dial.mock.calls.length, 0);
    });

    await t.test('orders before checkout ingestion suppress calls and webhook replays cannot undo purchase', async () => {
        const f = await fixture(); await activate(f);
        const payload = { id: 9001, checkout_id: 123, checkout_token: 'checkout-token-123', currency: 'EUR', current_subtotal_price: '106.20',
            phone: f.snapshot.phone, financial_status: 'paid', created_at: new Date(Date.now()-100000).toISOString(), updated_at: new Date().toISOString() };
        await hooks.ingestShopify(f.shop, 'orders/paid', payload, 'event1');
        assert.deepEqual(await hooks.ingestShopify(f.shop, 'orders/paid', payload, 'event1'), { duplicate: true });
        await transaction((c) => s.upsertCheckout(c, f.shop, f.snapshot));
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /already_purchased/);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_orders WHERE shop_id=$1', [f.shopId])).rows[0].n, 1);
    });

    await t.test('spoken refusal persists contact-wide stop and cancels pending actions', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Nein danke, bitte nicht mehr anrufen.' });
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /contact_stopped/);
        await assert.rejects(s.getOffer(call, 10), /contact_stopped/);
        assert.ok(hangup.mock.calls.length > 0);
    });

    await t.test('product information stays hidden until identity confirmation is grounded in transcripts', async () => {
        const f = await fixture(); await activate(f); const call = { ...await fakeCall(f), identity_verified: false };
        const initial = await s.getContext(call);
        assert.equal(initial.cart, undefined); assert.equal(initial.identityRequired, true);
        await assert.rejects(s.getOffer(call, 10), /identity_required/);
        await assert.rejects(s.confirmIdentity(call), /identity_confirmation_required/);
        await s.recordTranscript(call, { role: 'assistant', eventId: randomUUID(), text: 'Spreche ich mit der Person, die den Rückruf erbeten hat?' });
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Ja, genau.' });
        assert.equal((await s.confirmIdentity(call)).identityVerified, true);
    });

    await t.test('offers are single-use intents and stale carts invalidate the existing quote', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        const a = await s.getOffer(call, 10), b = await s.getOffer(call, 10);
        assert.equal(a.code, b.code); assert.equal(a.merchandiseTotalCents, 10620);
        await assert.rejects(s.getOffer(call, 30), /discount_denied/);
        await db.query(`UPDATE recovery_checkouts SET snapshot=jsonb_set(snapshot,'{items,0,quantity}','2') WHERE id=$1`, [f.checkoutId]);
        await assert.rejects(s.getOffer(call, 10), /offer_not_valid/);
    });

    await t.test('ambiguous Shopify failure leaves a durable offer and cannot issue a second discount', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        const before = discount.mock.calls.length;
        discount.mock.mockImplementation(async () => { throw new Error('synthetic timeout after creation'); });
        await assert.rejects(s.getOffer(call, 10), /offer_result_unknown/);
        await assert.rejects(s.getOffer(call, 10), /offer_not_valid/);
        assert.equal(discount.mock.calls.length, before+1);
        assert.equal((await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1`, [f.checkoutId])).rows[0].status, 'unknown');
        discount.mock.mockImplementation(async () => 'test-discount');
    });

    await t.test('concurrent link requests send once and never claim delivery from provider acceptance', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        await s.getOffer(call, 10);
        await assert.rejects(s.sendLink(call), /explicit_sms_request_required/);
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte schick mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        const results = await Promise.all([s.sendLink(call), s.sendLink(call)]);
        assert.equal(sms.mock.calls.length, before+1);
        assert.equal(results.filter((r) => r.duplicate).length, 1);
        assert.equal(results.find((r) => !r.duplicate).delivered, false);
    });

    await t.test('SMS authorization is rechecked after reservation and before any provider dispatch', async () => {
        const changes = [
            { sql: `UPDATE recovery_actions SET data=jsonb_set(data,'{expiresAt}',to_jsonb((NOW()-INTERVAL '1 second')::text))
                WHERE checkout_id=NEW.checkout_id AND kind='offer';`, error: /valid_offer_required/ },
            { sql: `UPDATE recovery_checkouts SET snapshot=jsonb_set(snapshot,'{items,0,quantity}','2')
                WHERE id=NEW.checkout_id;`, error: /valid_offer_required/ },
            { sql: `UPDATE recovery_actions SET data=jsonb_set(data,'{checkoutUrl}',to_jsonb((data->>'checkoutUrl')||'&changed=1'))
                WHERE checkout_id=NEW.checkout_id AND kind='offer';`, error: /sms_authorization_changed/ },
            { sql: `INSERT INTO recovery_events(id,shop_id,call_id,kind,data,created_at)
                SELECT gen_random_uuid(),shop_id,id,'user_transcript',
                    jsonb_build_object('text','Bitte keine SMS senden.','eventId',gen_random_uuid()),clock_timestamp()
                FROM recovery_calls WHERE checkout_id=NEW.checkout_id;`, error: /explicit_sms_request_required/ },
        ];
        for (const change of changes) {
            const f = await fixture(); await activate(f); const call = await fakeCall(f);
            await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
            await s.getOffer(call, 10);
            await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte senden Sie mir den Link per SMS.' });
            const name = `recovery_sms_test_${randomUUID().replaceAll('-', '')}`;
            // Inject a change at the reservation boundary without contacting external providers.
            await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                ${change.sql} RETURN NEW; END $$`);
            try {
                await db.query(`CREATE TRIGGER ${name} AFTER INSERT ON recovery_actions FOR EACH ROW
                    WHEN (NEW.kind='sms' AND NEW.checkout_id='${f.checkoutId}') EXECUTE FUNCTION ${name}()`);
                const before = sms.mock.calls.length;
                await assert.rejects(s.sendLink(call), change.error);
                assert.equal(sms.mock.calls.length, before);
                assert.equal((await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`, [f.checkoutId])).rows[0].status, 'failed');
                assert.deepEqual(await s.sendLink(call), { status: 'failed', duplicate: true });
                assert.equal(sms.mock.calls.length, before);
            } finally { await db.query(`DROP FUNCTION ${name}() CASCADE`); }
        }
    });

    await t.test('a timeout after SMS dispatch remains unknown and is never automatically resent', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        await s.getOffer(call, 10);
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte senden Sie mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        sms.mock.mockImplementation(async () => { throw new Error('synthetic provider timeout'); });
        try {
            await assert.rejects(s.sendLink(call), /sms_result_unknown_do_not_retry/);
            assert.deepEqual(await s.sendLink(call), { status: 'unknown', duplicate: true });
            assert.equal(sms.mock.calls.length, before+1);
        } finally { sms.mock.mockImplementation(async () => ({ id: `SM${'a'.repeat(32)}`, status: 'queued' })); }
    });

    await t.test('signed lifecycle excludes ring time and ignores duplicate end timestamps', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        const start = Math.floor(Date.now()/1000)-120;
        await hooks.lifecycle({ event: 'participant_joined', room: { name: `recovery-${call.id}` }, participant: { kind: 3, attributes: { 'sip.callStatus': 'active' } }, createdAt: start });
        await hooks.lifecycle({ event: 'participant_left', room: { name: `recovery-${call.id}` }, participant: { kind: 3 }, createdAt: start+60 });
        await hooks.lifecycle({ event: 'room_finished', room: { name: `recovery-${call.id}` }, createdAt: start+120 });
        const row = (await db.query('SELECT * FROM recovery_calls WHERE id=$1', [call.id])).rows[0];
        assert.equal(row.status, 'ended'); assert.equal(row.cost_cents, 20);
        assert.equal(+row.ended_at, (start+60)*1000);
    });

    await t.test('a slow discount provider cannot block a spoken contact stop', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        let release, announce;
        const started = new Promise((resolve) => { announce = resolve; });
        const upstream = new Promise((resolve) => { release = resolve; });
        discount.mock.mockImplementation(async () => { announce(); return upstream; });
        const pending = s.getOffer(call, 10);
        // Register the rejection handler before allowing the in-flight request to settle.
        const rejected = assert.rejects(pending, /offer_result_unknown/);
        await started;
        await s.stopContact(f.customerId, f.shopId, f.checkoutId, 'test_stop_while_provider_busy');
        const contact = (await db.query('SELECT stopped_at FROM recovery_contacts WHERE shop_id=$1', [f.shopId])).rows[0];
        assert.ok(contact.stopped_at);
        release('created-but-never-disclosed');
        await rejected;
        assert.equal((await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1`, [f.checkoutId])).rows[0].status, 'failed');
        discount.mock.mockImplementation(async () => 'test-discount');
    });

    await t.test('USD carts retain their currency and costs from different currencies are never added together', async () => {
        const eur = await fixture(); await activate(eur); const eurCall = await fakeCall(eur);
        const usd = await fixture(); await activate(usd); const usdCall = await fakeCall(usd);
        await db.query(`UPDATE recovery_shops SET currency='USD' WHERE id=$1`, [usd.shopId]);
        await db.query(`UPDATE recovery_checkouts SET currency='USD',snapshot=jsonb_set(snapshot,'{currency}','"USD"') WHERE id=$1`, [usd.checkoutId]);
        assert.equal((await s.getContext(usdCall)).cart.currency, 'USD');
        assert.equal((await s.getOffer(usdCall, 10)).merchandiseTotalCents, 10620);
        const context = await s.state(db, await s.shopFor(usd.customerId, usd.shopId), usd.checkoutId);
        assert.equal(p.eligibility({ ...context, checkout: { ...context.checkout, currency: 'EUR' } }, new Date(), 'action'), 'unsupported_currency');
        await db.query(`UPDATE recovery_shops SET mode='live',enabled=FALSE WHERE id=ANY($1::uuid[])`, [[eur.shopId,usd.shopId]]);
        await db.query(`UPDATE recovery_calls SET status='ended',cost_cents=CASE WHEN id=$1 THEN 10 ELSE 20 END
            WHERE id=ANY($2::uuid[])`, [eurCall.id,[eurCall.id,usdCall.id]]);
        await db.query(`UPDATE recovery_shops SET customer_id=$2 WHERE id=$1`, [usd.shopId,eur.customerId]);
        const dashboard = await s.dashboard(eur.customerId);
        assert.equal(dashboard.costs.cents, null);
        assert.deepEqual(dashboard.costsByCurrency.map((c) => [c.currency,c.cents]).sort(), [['EUR',10],['USD',20]]);
        assert.equal(dashboard.experiments.find((e) => e.shopId === usd.shopId).currency, 'USD');
    });

    await t.test('retention removes identifying history without erasing cohort revenue or conversation costs', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await s.getOffer(call, 10);
        await s.recordTranscript(call, { role: 'assistant', eventId: randomUUID(), text: 'Synthetic customer details for retention test.' });
        const control = { ...f.snapshot, id: 'gid://shopify/AbandonedCheckout/124', phone: '+4900000000002' };
        await transaction((c) => s.upsertCheckout(c, f.shop, control));
        await db.query(`UPDATE recovery_shops SET mode='live',enabled=FALSE WHERE id=$1`, [f.shopId]);
        await db.query(`UPDATE recovery_contacts SET arm=CASE WHEN phone=$2 THEN 'treatment' ELSE 'control' END,
            enrolled_at=NOW()-INTERVAL '40 days',experiment_rules=$3 WHERE shop_id=$1`,
        [f.shopId, f.snapshot.phone, JSON.stringify(p.rules())]);
        const orderedAt = new Date(Date.now()-35*86400000).toISOString();
        for (const [id, snapshot, subtotal] of [[123, f.snapshot, '100.00'], [124, control, '40.00']]) {
            await hooks.ingestShopify(f.shop, 'orders/paid', { id, checkout_id: id, phone: snapshot.phone,
                currency: 'EUR', current_subtotal_price: subtotal, financial_status: 'paid',
                created_at: orderedAt, updated_at: orderedAt }, `retention-order-${id}`);
        }
        await db.query(`UPDATE recovery_checkouts SET source_updated_at=NOW()-INTERVAL '45 days' WHERE shop_id=$1`, [f.shopId]);
        await db.query(`UPDATE recovery_calls SET created_at=NOW()-INTERVAL '40 days',status='ended',cost_cents=20,
            summary='Synthetic identifying call summary' WHERE id=$1`, [call.id]);
        await db.query(`UPDATE recovery_events SET created_at=NOW()-INTERVAL '35 days' WHERE shop_id=$1`, [f.shopId]);
        const before = await s.dashboard(f.customerId);
        assert.equal(before.experiments[0].incrementalContributionCents, 2380);
        assert.equal(before.costs.cents, 20);
        const { purgeExpiredData } = require('../src/recovery/worker');
        await purgeExpiredData(f.shopId);
        const after = await s.dashboard(f.customerId);
        assert.deepEqual(after.experiments, before.experiments);
        assert.deepEqual(after.costs, before.costs);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_orders WHERE shop_id=$1 AND phone IS NOT NULL`, [f.shopId])).rows[0].n, 0);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_contacts WHERE shop_id=$1 AND phone<>''`, [f.shopId])).rows[0].n, 0);
        const retainedCall = (await db.query('SELECT summary,cost_cents FROM recovery_calls WHERE id=$1', [call.id])).rows[0];
        assert.deepEqual(retainedCall, { summary: null, cost_cents: 20 });
        assert.deepEqual((await db.query(`SELECT phone,email,checkout_token,snapshot FROM recovery_checkouts WHERE id=$1`, [f.checkoutId])).rows[0],
            { phone: null, email: null, checkout_token: null, snapshot: {} });
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_events WHERE shop_id=$1`, [f.shopId])).rows[0].n, 0);
        assert.equal((await db.query(`SELECT count(*)::int AS n FROM recovery_actions WHERE checkout_id=$1`, [f.checkoutId])).rows[0].n, 0);
        await purgeExpiredData(f.shopId);
        assert.deepEqual((await s.dashboard(f.customerId)).experiments, before.experiments);
    });

    await t.test('HTTP webhook handling verifies raw signatures and binds destinations to the actual shop', async () => {
        const express = require('express');
        const { createHmac } = require('node:crypto');
        const f = await fixture();
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        const app = express(); app.use('/webhooks/recovery', hooks.router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const raw = JSON.stringify({ id: 123, updated_at: new Date().toISOString() });
            const signature = createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET).update(raw).digest('base64');
            const base = `http://127.0.0.1:${server.address().port}/webhooks/recovery/shopify/`;
            const endpoint = `${f.shopId}/${shopify.webhookCapability(f.shopId)}`;
            const send = (path, body = raw, sig = signature) => originalFetch(base+path, { method:'POST', body, headers: {
                'Content-Type':'application/json', 'x-shopify-shop-domain': f.shop.domain,
                'x-shopify-topic': 'checkouts/update', 'x-shopify-event-id': 'signed-http-test', 'x-shopify-hmac-sha256': sig,
            } });
            assert.equal((await send(endpoint)).status, 200);
            assert.deepEqual(await (await send(endpoint)).json(), { duplicate: true });
            assert.equal((await send(endpoint, raw+' ')).status, 401);
            assert.equal((await send(`${f.shopId}/${'0'.repeat(64)}`)).status, 401);
            assert.equal((await send('privacy')).status, 401);
        } finally { await new Promise((resolve) => server.close(resolve)); }
    });
});
