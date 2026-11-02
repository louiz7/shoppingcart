'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('merchant daily summary counts evidenced outbound calls and checkout-linked paid orders', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/shoppingcart');
    const { db } = require('../src/recovery/store');
    const service = require('../src/recovery/service');
    const hooks = require('../src/recovery/webhooks');
    const tel = require('../src/recovery/telephony');
    const shopify = require('../src/recovery/shopify');
    const policy = require('../src/recovery/policy');
    const customers = [];
    const originalFetch = global.fetch;
    const flags = { RECOVERY_LIVE_ENABLED: process.env.RECOVERY_LIVE_ENABLED, INTERNAL_TOOL_SECRET: process.env.INTERNAL_TOOL_SECRET };
    t.mock.method(global, 'fetch', async () => { throw new Error('External provider requests forbidden'); });
    t.mock.method(tel, 'hangup', async () => {});
    t.mock.method(tel, 'configured', () => true);
    t.mock.method(shopify, 'refreshCheckout', async (shop, externalId) =>
        (await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2', [shop.id, externalId])).rows[0].snapshot);
    t.after(async () => {
        for (const id of customers) await db.query('DELETE FROM customers WHERE id=$1', [id]);
        for (const [key, value] of Object.entries(flags)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await db.pool.end();
    });
    async function tenant() {
        const id = randomUUID();
        const result = await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id', [`Summary ${id}`, `${id}@example.invalid`]);
        customers.push(result.rows[0].id);
        return result.rows[0].id;
    }
    async function shop(customerId, timezone = 'Europe/Berlin', mode = 'live') {
        const id = randomUUID();
        return (await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,rules,mode,currency,enabled,approved_at,webhooks_ready)
            VALUES($1,$2,$3,'Synthetic summary',$4,$5,'USD',TRUE,NOW(),TRUE) RETURNING *`,
        [id, customerId, `${id}.myshopify.com`, JSON.stringify(policy.rules({ timezone, weekdays: [1,2,3,4,5,6,7], start: '00:00', end: '23:59' })), mode])).rows[0];
    }
    async function checkout(s) {
        const id = randomUUID(), external = String(Math.floor(Math.random()*1e14)), number = `+49${parseInt(id.slice(0,8),16).toString().padStart(10,'0')}`;
        const key = policy.contactKey(s.id, number), token = randomUUID();
        await db.query(`INSERT INTO recovery_contacts(shop_id,contact_key,phone,consented_at,expires_at,evidence,arm,consent_checkout_id)
            VALUES($1,$2,$3,NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day','Synthetic contact permission','treatment',$4)
            ON CONFLICT(shop_id,contact_key) DO UPDATE SET consent_checkout_id=EXCLUDED.consent_checkout_id`, [s.id, key, number, id]);
        const snapshot = { id: `gid://shopify/AbandonedCheckout/${external}`, updatedAt: new Date(Date.now()-7200000).toISOString(),
            completedAt: null, phone: number, email: 'synthetic@example.invalid', currency: 'USD', subtotalCents: 1000,
            checkoutUrl: `https://${s.domain}/checkouts/${token}`, discountCodes: [], items: [] };
        await db.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,checkout_token,contact_key,phone,currency,source_updated_at,snapshot)
            VALUES($1,$2,$3,$4,$5,$6,'USD',$7,$8)`, [id, s.id, snapshot.id, token, key, number, snapshot.updatedAt, JSON.stringify(snapshot)]);
        return { id, external, token, key, number };
    }
    async function call(s, c, dialed, connected = null, status = 'ended') {
        const id = randomUUID();
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,dialed_at,connected_at)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes',$7,$8,$9)`,
        [id, s.id, c.id, c.key, `recovery-${id}`, randomUUID(), status, dialed, connected]);
        return { id, shop_id: s.id, checkout_id: c.id, customer_id: s.customer_id, identity_verified: false };
    }
    async function order(s, c, paidAt, options = {}) {
        const id = options.id || String(Math.floor(Math.random()*1e14));
        const payload = { id, checkout_token: c.token, checkout_id: c.external, phone: c.number,
            currency: 'USD', financial_status: 'paid', current_subtotal_price: '10.00',
            updated_at: paidAt, created_at: paidAt, ...options };
        await hooks.ingestShopify(s, 'orders/paid', payload, randomUUID());
        return payload;
    }
    const asOf = new Date('2026-11-02T12:00:00Z');

    await t.test('Shopify test payments never count as real conversions or contribution, including replayed edits', async () => {
        const s = await shop(await tenant()), c = await checkout(s), control = await checkout(s);
        const paidAt = new Date(Date.now()-9*86400000);
        const connectedAt = new Date(+paidAt-3600000);
        const a = await call(s, c, connectedAt, connectedAt);
        await db.query('UPDATE recovery_calls SET cost_cents=0 WHERE id=$1', [a.id]);
        await db.query(`UPDATE recovery_contacts SET enrolled_at=NOW()-INTERVAL '10 days',experiment_rules=$2,
            arm=CASE WHEN contact_key=$3 THEN 'control' ELSE 'treatment' END WHERE shop_id=$1`,
        [s.id, JSON.stringify(policy.rules()), control.key]);
        const payload = await order(s, c, paidAt.toISOString(), { test: true });
        assert.equal((await service.dailySummary(s.customer_id, new Date(+paidAt+1000))).shops[0].confirmedCheckoutsToday, 0);
        const report = (await service.dashboard(s.customer_id)).experiments[0];
        assert.equal(report.groups[0].contacts, 1); assert.equal(report.groups[1].contacts, 1);
        assert.equal(report.groups[0].conversions, 0); assert.equal(report.groups[0].netContributionCents, 0);
        assert.equal(report.incrementalContributionCents, 0);
        await hooks.ingestShopify(s, 'orders/updated', { ...payload, test: false,
            updated_at: new Date(+paidAt+300000).toISOString() }, randomUUID());
        assert.equal((await db.query('SELECT is_test FROM recovery_orders WHERE shop_id=$1', [s.id])).rows[0].is_test, true);
        assert.equal((await service.dailySummary(s.customer_id, new Date(+paidAt+1000))).shops[0].confirmedCheckoutsToday, 0);
        await assert.rejects(hooks.ingestShopify(s, 'orders/paid', { ...payload, id: 'invalid-test-order', test: 'true' }, randomUUID()), /invalid_order/);
    });

    await t.test('tenant, simulation, original checkout and actual payment evidence are required', async () => {
        const owner = await tenant(), outsider = await tenant();
        const s = await shop(owner), foreign = await shop(outsider), simulation = await shop(owner, 'Europe/Berlin', 'simulation');
        const c = await checkout(s);
        await call(s, c, '2026-11-01T23:00:00Z', '2026-11-01T23:05:00Z');
        await call(s, c, '2026-11-01T22:59:59Z', '2026-11-01T23:06:00Z');
        await call(s, c, '2026-11-02T23:00:00Z');
        await call(s, c, null);
        await call(s, c, '2026-11-02T01:00:00Z', null, 'simulated');
        const paid = await order(s, c, '2026-11-02T02:00:00Z');
        await hooks.ingestShopify(s, 'orders/paid', paid, randomUUID());
        await order(s, c, '2026-11-02T03:00:00Z', { checkout_id: null, checkout_token: null });
        const unconnected = await checkout(s); await call(s, unconnected, '2026-11-02T02:00:00Z');
        await order(s, unconnected, '2026-11-02T04:00:00Z');
        const tooLate = await checkout(s); await call(s, tooLate, '2026-10-26T01:00:00Z', '2026-10-26T01:00:00Z');
        await order(s, tooLate, '2026-11-02T01:00:00Z');
        const beforeCall = await checkout(s); await call(s, beforeCall, '2026-11-02T05:00:00Z', '2026-11-02T05:00:00Z');
        await order(s, beforeCall, '2026-11-02T04:00:00Z');
        const simulatedCall = await checkout(s); await call(s, simulatedCall, '2026-11-02T03:00:00Z', '2026-11-02T03:00:00Z', 'simulated');
        await order(s, simulatedCall, '2026-11-02T04:00:00Z');
        await order(s, c, '2026-11-02T06:00:00Z', { cancelled_at: '2026-11-02T06:00:00Z' });
        await order(s, c, '2026-11-02T06:00:00Z', { financial_status: 'pending' });
        await order(s, c, '2026-11-02T06:00:00Z', { currency: 'EUR' });
        const fc = await checkout(foreign); await call(foreign, fc, '2026-11-02T01:00:00Z', '2026-11-02T01:00:00Z');
        await order(foreign, fc, '2026-11-02T02:00:00Z');
        const sc = await checkout(simulation); await call(simulation, sc, '2026-11-02T01:00:00Z', '2026-11-02T01:00:00Z');
        await db.query('UPDATE recovery_shops SET enabled=FALSE WHERE id=$1', [s.id]);
        const summary = await service.dailySummary(owner, asOf);
        assert.deepEqual(summary, { asOf: asOf.toISOString(), shops: [{ id: s.id, brand: s.brand, domain: s.domain,
            timeZone: 'Europe/Berlin', date: '2026-11-02', callsToday: 3, confirmedCheckoutsToday: 1 }] });
        assert.equal((await service.dailySummary(outsider, asOf)).shops[0].confirmedCheckoutsToday, 1);
        await db.query('UPDATE customers SET is_active=FALSE WHERE id=$1', [outsider]);
        assert.deepEqual((await service.dailySummary(outsider, asOf)).shops, []);
    });

    await t.test('payment time survives edits, refunds and replays without fabricating legacy times', async () => {
        const s = await shop(await tenant()), c = await checkout(s);
        await call(s, c, '2026-11-02T01:00:00Z', '2026-11-02T01:01:00Z');
        const pending = { id: '123', checkout_token: c.token, checkout_id: c.external, currency: 'USD', financial_status: 'pending',
            current_subtotal_price: '10.00', updated_at: '2026-11-02T01:02:00Z', created_at: '2026-11-02T01:02:00Z' };
        await hooks.ingestShopify(s, 'orders/create', pending, randomUUID());
        assert.equal((await db.query('SELECT paid_at FROM recovery_orders WHERE shop_id=$1', [s.id])).rows[0].paid_at, null);
        const paid = { ...pending, financial_status: 'paid', updated_at: '2026-11-02T02:00:00Z' };
        await hooks.ingestShopify(s, 'orders/paid', paid, randomUUID());
        await hooks.ingestShopify(s, 'orders/updated', { ...paid, updated_at: '2026-11-03T02:00:00Z' }, randomUUID());
        assert.equal((await db.query('SELECT paid_at FROM recovery_orders WHERE shop_id=$1', [s.id])).rows[0].paid_at.toISOString(), '2026-11-02T02:00:00.000Z');
        assert.equal((await service.dailySummary(s.customer_id, asOf)).shops[0].confirmedCheckoutsToday, 1);
        await hooks.ingestShopify(s, 'orders/updated', { ...paid, financial_status: 'refunded', updated_at: '2026-11-04T02:00:00Z' }, randomUUID());
        await hooks.ingestShopify(s, 'orders/paid', paid, randomUUID());
        assert.equal((await service.dailySummary(s.customer_id, asOf)).shops[0].confirmedCheckoutsToday, 0);
        await db.query('UPDATE recovery_orders SET paid=TRUE,paid_at=NULL WHERE shop_id=$1', [s.id]);
        await hooks.ingestShopify(s, 'orders/updated', { ...paid, updated_at: '2026-11-05T02:00:00Z' }, randomUUID());
        assert.equal((await db.query('SELECT paid_at FROM recovery_orders WHERE shop_id=$1', [s.id])).rows[0].paid_at, null);
    });

    await t.test('day boundaries follow the shop timezone across 23-hour and 25-hour days', async () => {
        for (const [instant, start, end, date] of [
            ['2026-03-29T12:00:00Z', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z', '2026-03-29'],
            ['2026-10-25T12:00:00Z', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z', '2026-10-25'],
        ]) {
            const s = await shop(await tenant()), c = await checkout(s);
            await call(s, c, start, start);
            await call(s, c, new Date(Date.parse(start)-1));
            await call(s, c, new Date(Date.parse(end)-1));
            await call(s, c, end);
            await order(s, c, new Date(Date.parse(end)-1).toISOString());
            assert.deepEqual((await service.dailySummary(s.customer_id, new Date(instant))).shops[0], {
                id: s.id, brand: s.brand, domain: s.domain, timeZone: 'Europe/Berlin', date, callsToday: 2, confirmedCheckoutsToday: 1,
            });
        }
        const s = await shop(await tenant(), 'America/Los_Angeles'), c = await checkout(s);
        await call(s, c, '2026-11-01T07:00:00Z');
        assert.equal((await service.dailySummary(s.customer_id, new Date('2026-11-02T00:30:00Z'))).shops[0].date, '2026-11-01');
    });

    await t.test('trusted worker and signed lifecycle record connections once; dial acknowledgements preserve ended calls', async () => {
        const s = await shop(await tenant()), c = await checkout(s);
        const active = await call(s, c, null, null, 'reserved');
        const initial = await service.recordConnection(active);
        assert.equal(initial.identityRequired, true);
        const first = (await db.query('SELECT dialed_at,connected_at FROM recovery_calls WHERE id=$1', [active.id])).rows[0];
        await service.recordConnection(active);
        assert.deepEqual((await db.query('SELECT dialed_at,connected_at FROM recovery_calls WHERE id=$1', [active.id])).rows[0], first);
        const joined = { event: 'participant_joined', room: { name: `recovery-${active.id}` },
            participant: { kind: 3, attributes: { 'sip.callStatus': 'active' } }, createdAt: Math.floor(Date.now()/1000)-1 };
        await hooks.lifecycle(joined); await hooks.lifecycle(joined);
        assert.equal((await db.query('SELECT connected_at FROM recovery_calls WHERE id=$1', [active.id])).rows[0].connected_at.toISOString(), new Date(joined.createdAt*1000).toISOString());
        await db.query(`UPDATE recovery_calls SET status='ended',ended_at=NOW() WHERE id=$1`, [active.id]);
        const next = await checkout(s);
        process.env.RECOVERY_LIVE_ENABLED = '1';
        t.mock.method(tel, 'dial', async (reservation) => {
            await db.query(`UPDATE recovery_calls SET status='ended',ended_at=NOW() WHERE id=$1`, [reservation.id]);
            return { participantId: 'synthetic' };
        });
        const result = await service.startCall(s.customer_id, s.id, next.id);
        assert.equal(result.status, 'ended');
        const row = (await db.query('SELECT status,dialed_at FROM recovery_calls WHERE id=$1', [result.id])).rows[0];
        assert.equal(row.status, 'ended'); assert.ok(row.dialed_at);
        const ringing = await call(s, next, null, null, 'unknown');
        await hooks.lifecycle({ ...joined, room: { name: `recovery-${ringing.id}` }, participant: { kind: 3, attributes: { 'sip.callStatus': 'dialing' } } });
        const evidence = (await db.query('SELECT dialed_at,connected_at FROM recovery_calls WHERE id=$1', [ringing.id])).rows[0];
        assert.ok(evidence.dialed_at); assert.equal(evidence.connected_at, null);
    });

    await t.test('summary HTTP response exposes only daily metrics to the authenticated tenant', async () => {
        const express = require('express'), s = await shop(await tenant());
        process.env.INTERNAL_TOOL_SECRET = 'synthetic-summary-secret';
        const app = express(); app.use('/internal/recovery/admin', require('../src/recovery/routes').adminRouter);
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const endpoint = `http://127.0.0.1:${server.address().port}/internal/recovery/admin/summary`;
            assert.equal((await originalFetch(endpoint)).status, 401);
            const response = await originalFetch(endpoint, { headers: { 'x-internal-secret': 'synthetic-summary-secret', 'x-customer-id': String(s.customer_id) } });
            assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
            const body = await response.json();
            assert.deepEqual(Object.keys(body).sort(), ['asOf', 'shops']);
            assert.deepEqual(Object.keys(body.shops[0]).sort(), ['brand','callsToday','confirmedCheckoutsToday','date','domain','id','timeZone']);
        } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    });
});
