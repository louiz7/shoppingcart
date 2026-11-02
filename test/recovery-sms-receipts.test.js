'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomUUID } = require('node:crypto');

test('Twilio signatures match the published vector and include every form field and the raw URL', (t) => {
    const original = process.env.TWILIO_AUTH_TOKEN;
    process.env.TWILIO_AUTH_TOKEN = '12345';
    t.after(() => { if (original === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = original; });
    const { twilioSignature } = require('../src/recovery/webhooks');
    const url = 'https://example.com/myapp.php?foo=1&bar=2';
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
    assert.equal(twilioSignature(url, params, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), true);
    assert.equal(twilioSignature(url + '&extra=1', params, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), false);
    assert.equal(twilioSignature(url, { ...params, Digits: '1235' }, 'L/OH5YylLD5NRKLltdqwSvS0BnU='), false);
    for (const body of [undefined, null, [], { MessageStatus: ['sent', 'delivered'] }]) {
        assert.equal(twilioSignature(url, body, 'invalid'), false);
    }
});

test('Twilio receipt handling authenticates callbacks and persists monotonic, SID-bound delivery evidence', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const databaseUrl = new URL(process.env.DATABASE_URL);
    assert.equal(databaseUrl.hostname, '127.0.0.1'); assert.equal(databaseUrl.port, '55433'); assert.equal(databaseUrl.pathname, '/shoppingcart');
    const { db } = require('../src/recovery/store');
    const { router } = require('../src/recovery/webhooks');
    const originals = Object.fromEntries(['RECOVERY_PUBLIC_URL', 'TWILIO_AUTH_TOKEN', 'TWILIO_ACCOUNT_SID'].map((key) => [key, process.env[key]]));
    Object.assign(process.env, { RECOVERY_PUBLIC_URL: 'https://sms-receipts.example.invalid', TWILIO_AUTH_TOKEN: 'synthetic-receipt-test-token', TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}` });
    const tenants = [];
    const app = require('express')(); app.use('/webhooks/recovery', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        for (const id of tenants) await db.query('DELETE FROM customers WHERE id=$1', [id]);
        await db.pool.end();
        for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    });
    const sid = `SM${'2'.repeat(32)}`, otherSid = `SM${'3'.repeat(32)}`;
    async function action(status = 'pending', providerId = null, kind = 'sms') {
        const shopId = randomUUID(), checkoutId = randomUUID(), actionId = randomUUID();
        const { rows } = await db.query(`INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id`, [`Receipt test ${shopId}`, `${randomUUID()}@example.invalid`]);
        tenants.push(rows[0].id);
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand) VALUES($1,$2,$3,'Receipt test')`, [shopId, rows[0].id, `${shopId}.myshopify.com`]);
        await db.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,source_updated_at) VALUES($1,$2,$3,NOW())`, [checkoutId, shopId, randomUUID()]);
        await db.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,provider_id) VALUES($1,$2,$3,$4,$5)`, [actionId, checkoutId, kind, status, providerId]);
        return actionId;
    }
    async function send(actionId, status, options = {}) {
        const path = options.path || `/webhooks/recovery/twilio?action=${actionId}`;
        const params = { AccountSid: process.env.TWILIO_ACCOUNT_SID, MessageSid: sid, MessageStatus: status,
            To: '+4900000000001', From: '+4900000000002', FutureProviderField: ' leading and trailing ', ...options.params };
        const signedUrl = options.signedUrl || process.env.RECOVERY_PUBLIC_URL + path;
        const signature = createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(signedUrl + Object.keys(params).sort().map((key) => key + params[key]).join('')).digest('base64');
        return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body: options.rawBody || new URLSearchParams(params),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature, 'X-Forwarded-Host': 'untrusted.example.invalid', ...options.headers } });
    }
    async function saved(id) { return (await db.query('SELECT status,provider_id FROM recovery_actions WHERE id=$1', [id])).rows[0]; }
    async function receipts(id) { return (await db.query('SELECT provider_id,status FROM recovery_sms_receipts WHERE action_id=$1', [id])).rows; }

    await t.test('early delivered receipt survives queued, duplicates and later acknowledgement', async () => {
        const id = await action();
        assert.equal((await send(id, 'delivered')).status, 200);
        assert.equal((await saved(id)).status, 'pending');
        assert.deepEqual(await receipts(id), [{ provider_id: sid, status: 'delivered' }]);
        assert.equal((await send(id, 'queued')).status, 200);
        assert.equal((await send(id, 'delivered')).status, 200);
        await db.query(`UPDATE recovery_actions SET provider_id=$2,status='unknown' WHERE id=$1`, [id, sid]);
        assert.equal((await send(id, 'sent')).status, 200);
        assert.equal((await saved(id)).status, 'delivered');
        assert.equal((await send(id, 'undelivered')).status, 200);
        assert.equal((await saved(id)).status, 'delivered');
    });
    await t.test('terminal failure stays failed when delayed intermediate callbacks arrive', async () => {
        const id = await action('accepted', sid);
        for (const status of ['undelivered', 'queued', 'sent', 'failed']) assert.equal((await send(id, status)).status, 200);
        assert.equal((await saved(id)).status, 'failed');
        assert.deepEqual(await receipts(id), [{ provider_id: sid, status: 'failed' }]);
    });
    await t.test('concurrent callbacks serialize and cannot replace confirmed delivery with acceptance', async () => {
        const id = await action('accepted', sid);
        const results = await Promise.all(['queued', 'delivered', 'sent', 'delivered'].map((status) => send(id, status)));
        assert.ok(results.every((response) => response.status === 200));
        assert.equal((await saved(id)).status, 'delivered');
        assert.deepEqual(await receipts(id), [{ provider_id: sid, status: 'delivered' }]);
    });
    await t.test('delivery evidence can correct local cancellation after a provider already accepted the SMS', async () => {
        const id = await action('failed', sid);
        assert.equal((await send(id, 'delivered')).status, 200);
        assert.equal((await saved(id)).status, 'delivered');
    });
    await t.test('known SID binding, unknown actions, offer actions and simulation never change unrelated state', async () => {
        const id = await action('accepted', sid);
        const offer = await action('confirmed', null, 'offer'), simulation = await action('simulated');
        assert.equal((await send(id, 'delivered', { params: { MessageSid: otherSid } })).status, 200);
        assert.equal((await send(randomUUID(), 'delivered')).status, 200);
        assert.equal((await send(offer, 'delivered')).status, 200);
        assert.equal((await send(simulation, 'delivered')).status, 200);
        assert.deepEqual(await saved(id), { status: 'accepted', provider_id: sid });
        for (const actionId of [id, offer, simulation]) assert.deepEqual(await receipts(actionId), []);
    });
    await t.test('invalid signatures, account, raw URL, duplicate form fields and action substitution fail closed', async () => {
        const id = await action(), other = await action();
        assert.equal((await send(id, 'delivered', { headers: { 'X-Twilio-Signature': 'invalid' } })).status, 401);
        assert.equal((await send(id, 'delivered', { params: { AccountSid: `AC${'4'.repeat(32)}` } })).status, 401);
        assert.equal((await send(id, 'delivered', { signedUrl: process.env.RECOVERY_PUBLIC_URL + `/webhooks/recovery/twilio?action=${other}` })).status, 401);
        assert.equal((await send(id, 'delivered', { signedUrl: 'https://untrusted.example.invalid/webhooks/recovery/twilio?action=' + id })).status, 401);
        assert.equal((await send(id, 'delivered', { path: `/webhooks/recovery/twilio?action=${id}&action=${other}` })).status, 400);
        assert.equal((await send(id, 'delivered', { rawBody: `AccountSid=${process.env.TWILIO_ACCOUNT_SID}&MessageSid=${sid}&MessageStatus=sent&MessageStatus=delivered` })).status, 401);
        assert.equal((await send(id, 'delivered', { params: { MessageSid: 'not-a-message-sid' } })).status, 400);
        assert.deepEqual(await receipts(id), []); assert.deepEqual(await receipts(other), []);
    });
    await t.test('unknown future statuses are acknowledged without fabricating delivery and config must use HTTPS', async () => {
        const id = await action('accepted', sid);
        for (const status of ['future_status', '__proto__', 'constructor']) assert.equal((await send(id, status)).status, 200);
        assert.deepEqual(await receipts(id), []); assert.equal((await saved(id)).status, 'accepted');
        process.env.RECOVERY_PUBLIC_URL = 'http://sms-receipts.example.invalid';
        try { assert.equal((await send(id, 'delivered')).status, 503); }
        finally { process.env.RECOVERY_PUBLIC_URL = 'https://sms-receipts.example.invalid'; }
    });
});
