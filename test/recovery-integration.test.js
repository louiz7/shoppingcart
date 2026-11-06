'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('cart recovery persists policy, isolation and exactly-once intents in local PostgreSQL', {
    skip: process.env.RECOVERY_DB_TEST !== '1', timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    process.env.RECOVERY_PUBLIC_URL='https://recovery.example.invalid';
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55433'); assert.equal(url.pathname, '/shoppingcart');
    const { db, transaction } = require('../src/recovery/store');
    const s = require('../src/recovery/service');
    const p = require('../src/recovery/policy');
    const shopify = require('../src/recovery/shopify');
    const tel = require('../src/recovery/telephony');
    const hooks = require('../src/recovery/webhooks');
    process.env.SHOPIFY_CLIENT_ID = 'synthetic-client';
    process.env.SHOPIFY_CLIENT_SECRET = 'synthetic-secret';
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
        await require('./helpers/recovery-terms')(db,customerId);
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,rules) VALUES($1,$2,$3,'Test shop',$4)`,
        [shopId, customerId, `${shopId}.myshopify.com`, JSON.stringify(p.rules({ maxDiscountPercent: 10, weekdays: [1,2,3,4,5,6,7], start: '00:00', end: '23:59' }))]);
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
    const refreshCheckout = t.mock.method(shopify, 'refreshCheckout', async (shop, externalId) => {
        const r = await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2', [shop.id, externalId]);
        return r.rows[0].snapshot;
    });

    async function sendLink(call, useDiscount) {
        const { rows } = await db.query(`SELECT data FROM recovery_events WHERE call_id=$1 AND kind='user_transcript'
            ORDER BY created_at DESC LIMIT 1`,[call.id]);
        return s.sendLink(call,useDiscount,rows[0]?.data.eventId);
    }

    await t.test('an undecided service conversation does not suppress a contact',async()=>{
        const f=await fixture();await activate(f);const call=await fakeCall(f);
        await s.outcome(call,{outcome:'undecided',summary:'Only browsing, no refusal or opt-out.'});
        const {rows:[contact]}=await db.query('SELECT stopped_at,revoked_at FROM recovery_contacts WHERE shop_id=$1',[f.shopId]);
        assert.equal(contact.stopped_at,null);assert.equal(contact.revoked_at,null);
        assert.equal((await db.query('SELECT outcome FROM recovery_calls WHERE id=$1',[call.id])).rows[0].outcome,'undecided');
    });

    await t.test('unsupported carts cannot abort other valid imports or acquire contact permission', async t => {
        const f=await fixture();
        await db.query("UPDATE recovery_shops SET mode='live' WHERE id=$1",[f.shopId]);
        const node={id:'gid://shopify/AbandonedCheckout/999',updatedAt:new Date().toISOString(),completedAt:null,
            abandonedCheckoutUrl:`https://${f.shop.domain}/checkouts/synthetic`,
            customer:{phone:'+4900000000002'},subtotalPriceSet:{presentmentMoney:{currencyCode:'EUR',amount:'100.00'}},
            lineItems:{nodes:[{title:'Synthetic',quantity:1,originalUnitPriceSet:{presentmentMoney:{currencyCode:'EUR',amount:'100.00'}},
                product:{id:'gid://shopify/Product/1',status:'ACTIVE'},variant:{id:'gid://shopify/ProductVariant/1',price:'100.00',availableForSale:true,inventoryPolicy:'CONTINUE'}}]}};
        const foreign={...node,id:'gid://shopify/AbandonedCheckout/998',subtotalPriceSet:{presentmentMoney:{currencyCode:'CHF',amount:'100.00'}}};
        const unsafe={...node,id:'gid://shopify/AbandonedCheckout/997',abandonedCheckoutUrl:'https://foreign.invalid/checkouts/synthetic'};
        const list=t.mock.method(shopify,'listCheckouts',async()=>[foreign,node,unsafe]);
        assert.deepEqual(await s.syncShop(f.customerId,f.shopId),{imported:1,skipped:2,skippedReasons:{unsupported_currency:1,invalid_checkout_host:1}});
        const rows=await db.query('SELECT external_id,currency FROM recovery_checkouts WHERE shop_id=$1 ORDER BY external_id',[f.shopId]);
        assert.equal(rows.rowCount,2);assert.ok(rows.rows.every(r=>r.currency==='EUR'));
        assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_contacts WHERE shop_id=$1 AND consented_at IS NOT NULL',[f.shopId])).rows[0].n,0);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM recovery_events WHERE shop_id=$1 AND kind='checkout_sync_skipped'",[f.shopId])).rows[0].n,1);
        list.mock.mockImplementation(async()=>[{...node,id:'not-a-checkout'}]);
        await assert.rejects(s.syncShop(f.customerId,f.shopId),/checkout_unverified/);
        list.mock.mockImplementation(async()=>{throw p.problem('shopify_unavailable',502);});
        await assert.rejects(s.syncShop(f.customerId,f.shopId),/shopify_unavailable/);
    });

    await t.test('post-tool speech timing validates attribution and persists separately from API latency', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f),token='d'.repeat(64);
        await db.query('UPDATE recovery_calls SET token_hash=$2 WHERE id=$1',[call.id,s.hash(token)]);
        const express=require('express'),app=express();app.use(express.json());
        app.use('/internal/recovery/tools',require('../src/recovery/routes').toolsRouter);
        const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        const previous=process.env.INTERNAL_TOOL_SECRET;process.env.INTERNAL_TOOL_SECRET='synthetic-latency-secret';
        try {
            const send = body => originalFetch(`http://127.0.0.1:${server.address().port}/internal/recovery/tools/latency`,{
                method:'POST',headers:{'Content-Type':'application/json','x-internal-secret':process.env.INTERNAL_TOOL_SECRET,'x-call-token':token},body:JSON.stringify(body)});
            assert.equal((await send({kind:'tool_result_to_speech_latency',tool:'offer',ms:3800})).status,200);
            for(const body of [{kind:'tool_result_to_speech_latency',tool:'arbitrary',ms:1},
                {kind:'tool_result_to_speech_latency',tool:'offer',ms:-1}])assert.equal((await send(body)).status,400);
            const {rows}=await db.query("SELECT duration_ms,data FROM recovery_events WHERE call_id=$1 AND kind='tool_result_to_speech_latency'",[call.id]);
            assert.equal(rows.length,1);assert.equal(rows[0].duration_ms,3800);assert.equal(rows[0].data.tool,'offer');
        } finally {
            await new Promise(resolve=>server.close(resolve));
            if(previous===undefined)delete process.env.INTERNAL_TOOL_SECRET;else process.env.INTERNAL_TOOL_SECRET=previous;
        }
    });

    await t.test('expired or deactivated calls can only close their own real room, never run more shop actions', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        const token = 'b'.repeat(64);
        await db.query("UPDATE recovery_shops SET mode='live' WHERE id=$1", [f.shopId]);
        await db.query('UPDATE recovery_calls SET token_hash=$2 WHERE id=$1', [call.id, s.hash(token)]);
        await db.query('UPDATE customers SET is_active=FALSE WHERE id=$1', [f.customerId]);
        const before = hangup.mock.calls.length;
        await hooks.reconcileStops(f.shopId);
        assert.equal(hangup.mock.calls.length, before+1);
        assert.equal(hangup.mock.calls.at(-1).arguments[0], `recovery-${call.id}`);
        await db.query("UPDATE recovery_calls SET expires_at=NOW()-INTERVAL '1 minute',status='ended' WHERE id=$1", [call.id]);
        const express = require('express');
        const app = express(); app.use(express.json());
        app.use('/internal/recovery/tools', require('../src/recovery/routes').toolsRouter);
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const priorSecret = process.env.INTERNAL_TOOL_SECRET;
        process.env.INTERNAL_TOOL_SECRET = 'synthetic-cleanup-only-gateway-secret';
        const send = (name, callToken = token, secret = process.env.INTERNAL_TOOL_SECRET) => originalFetch(
            `http://127.0.0.1:${server.address().port}/internal/recovery/tools/${name}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-secret': secret, 'x-call-token': callToken }, body: '{}',
            });
        try {
            const ended = await send('end');
            assert.equal(ended.status, 200); assert.deepEqual(await ended.json(), { ended: true });
            assert.equal(hangup.mock.calls.at(-1).arguments[0], `recovery-${call.id}`);
            for (const name of ['context','connected','confirm_contact','offer','send_link','order_status','product_details','shop_policies']) {
                assert.equal((await send(name)).status, 401);
            }
            assert.equal((await send('end', 'c'.repeat(64))).status, 401);
            assert.equal((await send('end', token, 'wrong-secret')).status, 401);
            await db.query("UPDATE recovery_calls SET status='simulated' WHERE id=$1", [call.id]);
            assert.equal((await send('end')).status, 401);
        } finally {
            await new Promise((resolve) => server.close(resolve));
            if (priorSecret === undefined) delete process.env.INTERNAL_TOOL_SECRET; else process.env.INTERNAL_TOOL_SECRET = priorSecret;
        }
    });

    await t.test('confirmed room cleanup releases the real call without inventing SIP costs',async () => {
        const f=await fixture(); await activate(f); const call=await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`,[f.shopId]);
        await db.query(`UPDATE recovery_checkouts SET status='calling' WHERE id=$1`,[f.checkoutId]);
        const before=hangup.mock.calls.length;
        assert.deepEqual(await s.endCall(call),{ended:true});
        const ended=(await db.query('SELECT status,ended_at,cost_cents FROM recovery_calls WHERE id=$1',[call.id])).rows[0];
        assert.equal(ended.status,'ended'); assert.ok(ended.ended_at); assert.equal(ended.cost_cents,null);
        assert.equal((await db.query('SELECT status FROM recovery_checkouts WHERE id=$1',[f.checkoutId])).rows[0].status,'contacted');
        assert.deepEqual(await s.endCall(call),{ended:true}); assert.equal(hangup.mock.calls.length,before+1);
        assert.deepEqual((await db.query('SELECT status,ended_at,cost_cents FROM recovery_calls WHERE id=$1',[call.id])).rows[0],ended);
    });

    await t.test('failed cleanup stays unconfirmed and only an exact SDK missing-room response counts as absence',async () => {
        const { TwirpError }=require('livekit-server-sdk');
        const f=await fixture(); await activate(f); const call=await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`,[f.shopId]);
        await db.query(`UPDATE recovery_checkouts SET status='calling' WHERE id=$1`,[f.checkoutId]);
        const timeout=new Error('Synthetic provider timeout');
        hangup.mock.mockImplementation(async()=>{throw timeout;});
        try {
            await assert.rejects(s.endCall(call),timeout);
            assert.deepEqual((await db.query('SELECT status,ended_at,cost_cents FROM recovery_calls WHERE id=$1',[call.id])).rows[0],
                {status:'dialing',ended_at:null,cost_cents:null});
            assert.equal((await db.query('SELECT status FROM recovery_checkouts WHERE id=$1',[f.checkoutId])).rows[0].status,'calling');
            hangup.mock.mockImplementation(async()=>{throw Object.assign(new Error('Untrusted generic not-found'),{status:404,code:'not_found'});});
            await assert.rejects(s.endCall(call),/Untrusted generic/);
            hangup.mock.mockImplementation(async()=>{throw new TwirpError('Not Found','Synthetic room absent',404,'not_found');});
            assert.deepEqual(await s.endCall(call),{ended:true});
            assert.equal((await db.query('SELECT status FROM recovery_calls WHERE id=$1',[call.id])).rows[0].status,'ended');
        } finally {hangup.mock.mockImplementation(async()=>{});}
    });

    await t.test('manual owner tests require trusted process configuration and preserve ordinary policy and experiments',async () => {
        const f=await fixture(); await activate(f);
        const keys=['RECOVERY_OWNER_TEST_ENABLED','RECOVERY_OWNER_TEST_SHOP_ID','RECOVERY_OWNER_TEST_PHONE','RECOVERY_LIVE_ENABLED'];
        const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
        const before=dial.mock.calls.length,reads=shopify.refreshCheckout.mock.calls.length;
        try {
            process.env.RECOVERY_OWNER_TEST_ENABLED='0';
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/owner_test_not_authorized/);
            assert.equal(shopify.refreshCheckout.mock.calls.length,reads);
            process.env.RECOVERY_OWNER_TEST_ENABLED='1';process.env.RECOVERY_OWNER_TEST_SHOP_ID=randomUUID();
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/owner_test_not_authorized/);
            assert.equal(shopify.refreshCheckout.mock.calls.length,reads);
            process.env.RECOVERY_OWNER_TEST_SHOP_ID=f.shopId;process.env.RECOVERY_OWNER_TEST_PHONE='+4900000000009';process.env.RECOVERY_LIVE_ENABLED='1';
            await db.query(`UPDATE recovery_shops SET mode='live',webhooks_ready=TRUE WHERE id=$1`,[f.shopId]);
            await db.query(`UPDATE recovery_checkouts SET source_updated_at=NOW(),snapshot=jsonb_set(snapshot,'{updatedAt}',to_jsonb(NOW()::text)) WHERE id=$1`,[f.checkoutId]);
            await db.query(`UPDATE recovery_contacts SET arm=NULL WHERE shop_id=$1`,[f.shopId]);
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/owner_test_not_authorized/);
            assert.equal(dial.mock.calls.length,before);
            process.env.RECOVERY_OWNER_TEST_PHONE=f.snapshot.phone;
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId),/abandonment_delay/);
            const result=await s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true});
            assert.equal(dial.mock.calls.length,before+1);
            assert.equal(dial.mock.calls[before].arguments[0].shop_id,f.shopId);
            const call=(await db.query('SELECT * FROM recovery_calls WHERE id=$1',[result.id])).rows[0];
            assert.equal(call.is_test,true);
            assert.deepEqual((await db.query('SELECT arm,enrolled_at FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows[0],{arm:null,enrolled_at:null});
            assert.equal((await db.query('SELECT arm FROM recovery_checkouts WHERE id=$1',[f.checkoutId])).rows[0].arm,null);
            assert.equal((await s.getContext({...call,customer_id:f.customerId})).contactConfirmed,false);
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/contact_busy/);
            await s.endCall({...call,customer_id:f.customerId});
            const retry=await s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true});
            assert.equal(dial.mock.calls.length,before+2);
            await s.endCall({...((await db.query('SELECT * FROM recovery_calls WHERE id=$1',[retry.id])).rows[0]),customer_id:f.customerId});
            const third=await s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true});
            assert.equal(dial.mock.calls.length,before+3);
            await s.endCall({...((await db.query('SELECT * FROM recovery_calls WHERE id=$1',[third.id])).rows[0]),customer_id:f.customerId});
            assert.equal((await db.query('SELECT COUNT(*)::int n FROM recovery_calls WHERE shop_id=$1 AND is_test',[f.shopId])).rows[0].n,3);
            process.env.RECOVERY_OWNER_TEST_ENABLED='0';
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/owner_test_not_authorized/);
            await db.query('UPDATE recovery_calls SET connected_at=NOW() WHERE id=$1',[call.id]);
            await hooks.ingestShopify(await s.shopFor(f.customerId,f.shopId),'orders/paid',{
                id:'owner-test-order',checkout_token:'checkout-token-123',checkout_id:123,currency:'EUR',financial_status:'paid',current_subtotal_price:'118.00',
                created_at:new Date(Date.now()+1000).toISOString(),updated_at:new Date(Date.now()+1000).toISOString(),
            },randomUUID());
            assert.equal((await s.dailySummary(f.customerId)).shops[0].confirmedCheckoutsToday,0);
        } finally {
            for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
            dial.mock.resetCalls();
        }
    });

    await t.test('manual owner test rechecks the fresh authorized phone before dialing',async () => {
        const f=await fixture();await activate(f);
        const keys=['RECOVERY_OWNER_TEST_ENABLED','RECOVERY_OWNER_TEST_SHOP_ID','RECOVERY_OWNER_TEST_PHONE','RECOVERY_LIVE_ENABLED'];
        const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
        const before=dial.mock.calls.length;
        let reads=0;
        try {
            Object.assign(process.env,{RECOVERY_OWNER_TEST_ENABLED:'1',RECOVERY_OWNER_TEST_SHOP_ID:f.shopId,RECOVERY_OWNER_TEST_PHONE:f.snapshot.phone,RECOVERY_LIVE_ENABLED:'1'});
            await db.query(`UPDATE recovery_shops SET mode='live',webhooks_ready=TRUE WHERE id=$1`,[f.shopId]);
            shopify.refreshCheckout.mock.mockImplementation(async()=>{
                if(++reads===1)return f.snapshot;
                const phone='+4900000000009',key=p.contactKey(f.shopId,phone);
                await db.query(`INSERT INTO recovery_contacts(shop_id,contact_key,phone,consented_at,expires_at,evidence,consent_checkout_id)
                    VALUES($1,$2,$3,NOW(),NOW()+INTERVAL '1 day','Synthetic secondary contact evidence',$4)`,[f.shopId,key,phone,f.checkoutId]);
                return {...f.snapshot,phone};
            });
            await assert.rejects(s.startCall(f.customerId,f.shopId,f.checkoutId,{ownerTest:true}),/call_result_unknown_do_not_retry/);
            assert.equal(reads,2);assert.equal(dial.mock.calls.length,before);
        } finally {
            shopify.refreshCheckout.mock.mockImplementation(async(shop,id)=>(await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[shop.id,id])).rows[0].snapshot);
            for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
            dial.mock.resetCalls();
        }
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
        await s.stopContact(call.customer_id,call.shop_id,call.checkout_id,'spoken_opt_out');
        await assert.rejects(s.startCall(f.customerId, f.shopId, f.checkoutId), /contact_stopped/);
        await assert.rejects(s.getOffer(call, 10), /contact_stopped/);
        assert.ok(hangup.mock.calls.length > 0);
    });

    await t.test('blocklist survives new carts, phone formatting, imports and retention without crossing shops', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        const pending = randomUUID();
        await db.query("INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'sms','pending','{}')",[pending,f.checkoutId]);
        await s.stopContact(f.customerId,f.shopId,f.checkoutId,'spoken_opt_out',call.id);
        const before = (await db.query('SELECT stopped_at,stop_reason FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows[0];
        await s.stopContact(f.customerId,f.shopId,f.checkoutId,'merchant_stop');
        await db.query("UPDATE recovery_calls SET status='ended',ended_at=NOW() WHERE id=$1",[call.id]);
        assert.deepEqual((await db.query('SELECT stopped_at,stop_reason FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows[0],before);
        assert.equal((await db.query('SELECT status FROM recovery_actions WHERE id=$1',[pending])).rows[0].status,'failed');
        await db.query("UPDATE recovery_checkouts SET source_updated_at=NOW()-INTERVAL '40 days' WHERE shop_id=$1",[f.shopId]);
        await require('../src/recovery/worker').purgeExpiredData(f.shopId);
        assert.equal((await db.query('SELECT phone FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows[0].phone,'');
        const next = {...f.snapshot,id:'gid://shopify/AbandonedCheckout/987',phone:'+49 (000) 000-00001',email:'different@example.invalid'};
        await transaction(c=>s.upsertCheckout(c,f.shop,next));
        await transaction(c=>s.upsertCheckout(c,f.shop,next));
        const saved=(await db.query('SELECT id,status,phone FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[f.shopId,next.id])).rows[0];
        assert.equal(saved.status,'stopped');assert.equal(saved.phone,f.snapshot.phone);
        assert.equal((await db.query('SELECT count(*)::int n FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows[0].n,1);
        await assert.rejects(s.consent(f.customerId,f.shopId,saved.id,{verified:true,evidence:'New checkout cannot override a prior contact opt out',
            consentedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),timezone:'Europe/Berlin'}),/contact_stopped/);
        await assert.rejects(s.startCall(f.customerId,f.shopId,saved.id),/contact_stopped/);
        const laterCall=await fakeCall({...f,checkoutId:saved.id});
        await assert.rejects(s.sendLink(laterCall,false,randomUUID()),/contact_stopped/);
        const other=await fixture();await activate(other);
        const otherState=await s.state(db,await s.shopFor(other.customerId,other.shopId),other.checkoutId);
        assert.equal(otherState.contact.stopped_at,null);
        assert.equal(p.eligibility(otherState,new Date(),'action'),null);
    });

    for (const viaOutcome of [false,true]) await t.test(`spoken stop follows the called number after checkout phone changes (outcome=${viaOutcome})`, async () => {
        const f=await fixture();await activate(f);const call=await fakeCall(f);
        const originalKey=p.contactKey(f.shopId,f.snapshot.phone);
        const changed={...f.snapshot,phone:'+4900000000002',updatedAt:new Date().toISOString()};
        await transaction(c=>s.upsertCheckout(c,f.shop,changed));
        const other=await fixture();const otherCall=await fakeCall(other);
        await assert.rejects(s.stopContact(f.customerId,f.shopId,f.checkoutId,'agent_stop',otherCall.id),/invalid_call_token/);
        const before=hangup.mock.calls.length;
        if(viaOutcome) await s.outcome(call,{outcome:'refused',summary:'Do not contact me again.'});
        else await s.stopContact(f.customerId,f.shopId,f.checkoutId,'agent_stop',call.id);
        const contacts=(await db.query('SELECT contact_key,stopped_at FROM recovery_contacts WHERE shop_id=$1',[f.shopId])).rows;
        assert.ok(contacts.find(c=>c.contact_key===originalKey).stopped_at);
        assert.equal(contacts.find(c=>c.contact_key!==originalKey).stopped_at,null);
        assert.equal((await db.query('SELECT status FROM recovery_checkouts WHERE id=$1',[f.checkoutId])).rows[0].status,'pending');
        assert.equal(hangup.mock.calls.length,before+1);
        assert.equal(hangup.mock.calls.at(-1).arguments[0],`recovery-${call.id}`);
        await transaction(c=>s.upsertCheckout(c,f.shop,{...f.snapshot,id:'gid://shopify/AbandonedCheckout/988'}));
        const next=(await db.query('SELECT id,status FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[f.shopId,'gid://shopify/AbandonedCheckout/988'])).rows[0];
        assert.equal(next.status,'stopped');
        await assert.rejects(s.startCall(f.customerId,f.shopId,next.id),/contact_stopped/);
    });

    await t.test('verified startup cart needs no Shopify reload while actions still require conversation permission', async () => {
        const f = await fixture(); await activate(f); const call = { ...await fakeCall(f), identity_verified: false };
        await db.query('UPDATE recovery_calls SET identity_verified=FALSE WHERE id=$1',[call.id]);
        await db.query(`UPDATE recovery_checkouts SET snapshot=jsonb_set(snapshot,'{supportEmail}','"support@example.invalid"') WHERE id=$1`,[f.checkoutId]);
        const before = refreshCheckout.mock.calls.length;
        const initial = await s.getContext(call);
        assert.deepEqual(initial.cart.items,f.snapshot.items); assert.equal(initial.contactConfirmed,false);
        assert.equal(initial.supportEmail,'support@example.invalid');
        assert.equal(refreshCheckout.mock.calls.length,before);
        for (const privateValue of [f.snapshot.phone,f.snapshot.email,f.snapshot.checkoutUrl,f.snapshot.customerId]) {
            assert.equal(JSON.stringify(initial).includes(privateValue),false);
        }
        await assert.rejects(s.getContext({...call,customer_id:-1}),/shop_not_found/);
        await assert.rejects(s.getContext({...call,id:randomUUID()}),/call_authorization_changed/);
        await assert.rejects(require('../src/recovery/catalog').authorized(call),/call_authorization_changed/);
        await assert.rejects(s.sendLink(call,false,randomUUID()),/contact_confirmation_required/);
        await assert.rejects(s.getOffer(call, 10), /contact_confirmation_required/);
        await assert.rejects(s.confirmContact(call), /conversation_evidence_required/);
        await s.recordTranscript(call, { role: 'assistant',eventId: randomUUID(),text: 'Passt es gerade kurz?' });
        await s.recordTranscript(call, { role: 'user',eventId: randomUUID(),text: 'Ja, aber später.' });
        await assert.rejects(s.confirmContact(call), /conversation_evidence_required/);
        assert.equal((await db.query('SELECT identity_verified FROM recovery_calls WHERE id=$1',[call.id])).rows[0].identity_verified,false);
        await s.recordTranscript(call, { role: 'assistant', eventId: randomUUID(), text: 'Hallo, hier ist Rescova, die KI-Assistenz von Test. Passt es gerade kurz?' });
        const userEventId = randomUUID();
        await s.recordTranscript(call, { role: 'user', eventId: userEventId, text: 'Mich interessiert, ob das auch auf Reisen taugt.' });
        await assert.rejects(s.confirmContact(call,randomUUID()),/conversation_changed/);
        assert.equal((await s.confirmContact(call,userEventId)).contactConfirmed, true);
        assert.equal((await db.query('SELECT identity_verified FROM recovery_calls WHERE id=$1',[call.id])).rows[0].identity_verified,true);
        assert.equal((await s.getContext({ ...call,identity_verified:true })).supportEmail,'support@example.invalid');
    });

    await t.test('startup context rejects ended, expired and opted-out calls', async () => {
        const f=await fixture();await activate(f);const call={...await fakeCall(f),identity_verified:false};
        await db.query('UPDATE recovery_calls SET identity_verified=FALSE,expires_at=NOW() WHERE id=$1',[call.id]);
        await assert.rejects(s.getContext(call),/call_authorization_changed/);
        await db.query("UPDATE recovery_calls SET expires_at=NOW()+INTERVAL '10 minutes',ended_at=NOW() WHERE id=$1",[call.id]);
        await assert.rejects(s.getContext(call),/call_authorization_changed/);
        await db.query('UPDATE recovery_calls SET ended_at=NULL WHERE id=$1',[call.id]);
        await s.stopContact(f.customerId,f.shopId,f.checkoutId);
        await assert.rejects(s.getContext(call),/contact_stopped/);
    });

    await t.test('offers are single-use intents and stale carts invalidate the existing quote', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        const a = await s.getOffer(call, 10), b = await s.getOffer(call, 10);
        assert.equal(a.code, b.code); assert.equal(a.merchandiseTotalCents, 10620);
        await assert.rejects(s.getOffer(call, 30), /discount_denied/);
        await db.query(`UPDATE recovery_checkouts SET snapshot=jsonb_set(snapshot,'{items,0,quantity}','2') WHERE id=$1`, [f.checkoutId]);
        await assert.rejects(s.getOffer(call, 10), /offer_not_valid/);
    });

    await t.test('live calls cannot invent a discount when the merchant has not approved any codes', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live',rules='{}'::jsonb WHERE id=$1`, [f.shopId]);
        const before = discount.mock.calls.length;
        for (const percent of [10,100]) await assert.rejects(s.getOffer(call,percent),/approved_discount_required/);
        assert.equal(discount.mock.calls.length,before);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_actions WHERE checkout_id=$1',[f.checkoutId])).rows[0].n,0);
        await db.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'offer','confirmed',$3)`,
            [randomUUID(),f.checkoutId,{percent:10,code:'LEGACY10'}]);
        await assert.rejects(s.getOffer(call,0),/approved_discount_required/);
    });

    await t.test('concurrent link requests send once and never claim delivery from provider acceptance', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        await s.getOffer(call, 0);
        await assert.rejects(sendLink(call), /conversation_evidence_required/);
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte schick mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        const results = await Promise.all([sendLink(call), sendLink(call)]);
        assert.equal(sms.mock.calls.length, before+1);
        assert.equal(results.filter((r) => r.duplicate).length, 1);
        assert.equal(results.find((r) => !r.duplicate).delivered, false);
    });

    await t.test('a timeout after SMS dispatch remains unknown and is never automatically resent', async () => {
        const f = await fixture(); await activate(f); const call = await fakeCall(f);
        await db.query(`UPDATE recovery_shops SET mode='live' WHERE id=$1`, [f.shopId]);
        await s.getOffer(call, 0);
        await s.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte senden Sie mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        sms.mock.mockImplementation(async () => { throw new Error('synthetic provider timeout'); });
        try {
            await assert.rejects(sendLink(call), /sms_result_unknown_do_not_retry/);
            assert.deepEqual(await sendLink(call), { status: 'unknown', duplicate: true });
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
