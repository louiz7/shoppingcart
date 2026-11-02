'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('merchant approved Shopify discounts persist consent, exactly-once creation and fresh usage checks', {
    skip: process.env.RECOVERY_DB_TEST!=='1',timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55433'); assert.equal(url.pathname,'/shoppingcart');
    const { db,transaction } = require('../src/recovery/store');
    const service = require('../src/recovery/service');
    const discounts = require('../src/recovery/discounts');
    const policy = require('../src/recovery/policy');
    const shopify = require('../src/recovery/shopify');
    const tel = require('../src/recovery/telephony');
    const tenants = [], remote = new Map();
    let serial = 1, mutationCount = 0, mutationFailure = null, readHook = null;
    t.mock.method(global,'fetch',async () => { throw new Error('External requests forbidden'); });
    t.mock.method(tel,'assertSmsReady',() => {});
    t.mock.method(tel,'hangup',async () => {});
    const sms = t.mock.method(tel,'sendSms',async () => ({ id: `SM${'a'.repeat(32)}`,status: 'queued' }));
    const adHoc = t.mock.method(shopify,'createDiscount',async () => { throw new Error('Unapproved ad hoc discount forbidden'); });
    t.mock.method(shopify,'refreshCheckout',async (shop,id) =>
        (await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[shop.id,id])).rows[0].snapshot);
    const graphql = t.mock.method(shopify,'graphql',async (shop,query,variables) => {
        if (query.includes('mutation RecoveryMerchantDiscount')) {
            mutationCount++;
            if (mutationFailure) return mutationFailure();
            const value = variables.input,id = `gid://shopify/DiscountCodeNode/${serial++}`;
            assert.equal(value.context.all,true); assert.equal(value.appliesOncePerCustomer,true);
            assert.equal(value.customerGets.items.all,true);
            assert.deepEqual(value.combinesWith,{ orderDiscounts: false,productDiscounts: false,shippingDiscounts: false });
            const node = { id,codeDiscount: { __typename: 'DiscountCodeBasic',status: 'ACTIVE',startsAt: value.startsAt,endsAt: value.endsAt,
                usageLimit: value.usageLimit,asyncUsageCount: 0,appliesOncePerCustomer: true,
                codes: { nodes: [{ code: value.code }],pageInfo: { hasNextPage: false } },context: { __typename: 'DiscountBuyerSelectionAll' },
                customerGets: { value: { __typename: 'DiscountPercentage',percentage: value.customerGets.value.percentage },
                    items: { __typename: 'AllDiscountItems',allItems: true } },
                minimumRequirement: { __typename: 'DiscountMinimumSubtotal',greaterThanOrEqualToSubtotal: {
                    amount: value.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal,currencyCode: shop.currency } },
                combinesWith: { ...value.combinesWith,productDiscountsWithTagsOnSameCartLine: [] } } };
            remote.set(id,{ shopId: shop.id,node });
            return { discountCodeBasicCreate: { codeDiscountNode: { id },userErrors: [] } };
        }
        assert.ok(query.includes('query RecoveryApprovedDiscounts'));
        if (readHook) await readHook();
        return { nodes: variables.ids.map((id) => remote.get(id)?.shopId===shop.id ? remote.get(id).node : null) };
    });
    t.after(async () => {
        for (const id of tenants) await db.query('DELETE FROM customers WHERE id=$1',[id]);
        await db.pool.end();
    });
    async function fixture() {
        const shopId = randomUUID(),customerId = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',
            [`Discounts ${shopId}`,`${shopId}@example.invalid`])).rows[0].id;
        tenants.push(customerId);
        const shop = (await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,currency,rules,enabled,approved_at)
            VALUES($1,$2,$3,'Synthetic shop','live','USD',$4,TRUE,NOW()) RETURNING *`,
        [shopId,customerId,`${shopId}.myshopify.com`,JSON.stringify(policy.rules())])).rows[0];
        const input = { requestId: randomUUID(),title: 'Welcome back',code: 'RETURN10',percent: 10,minSubtotalCents: 5000,validDays: 7,usageLimit: 100 };
        return { shop,shopId,customerId,input };
    }
    async function caller(f) {
        const id = randomUUID(),snapshot = { id: `gid://shopify/AbandonedCheckout/${serial++}`,updatedAt: new Date(Date.now()-7200000).toISOString(),
            completedAt: null,phone: '+4900000000001',email: 'synthetic@example.invalid',currency: 'USD',subtotalCents: 10000,discountCodes: [],
            checkoutUrl: `https://${f.shop.domain}/checkouts/synthetic`,items: [{ title: 'Synthetic item',quantity: 1,
                variantId: 'gid://shopify/ProductVariant/1',originalUnitCents: 10000,currentPriceCents: 10000,available: true }] };
        await transaction((client) => service.upsertCheckout(client,f.shop,snapshot));
        const checkoutId = (await db.query('SELECT id FROM recovery_checkouts WHERE shop_id=$1',[f.shopId])).rows[0].id;
        await service.consent(f.customerId,f.shopId,checkoutId,{ verified: true,evidence: 'Synthetic test-only contact permission',timezone: 'Europe/Berlin',
            consentedAt: new Date(Date.now()-86400000).toISOString(),expiresAt: new Date(Date.now()+86400000).toISOString() });
        await db.query(`UPDATE recovery_contacts SET arm='treatment' WHERE shop_id=$1`,[f.shopId]);
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,identity_verified)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes','connected',TRUE)`,
        [id,f.shopId,checkoutId,policy.contactKey(f.shopId,snapshot.phone),`recovery-${id}`,randomUUID()]);
        return { id,shop_id: f.shopId,checkout_id: checkoutId,customer_id: f.customerId,identity_verified: true };
    }

    await t.test('merchant validation and tenant isolation reject requests before Shopify is called',async () => {
        const f = await fixture(),other = await fixture(),before = mutationCount;
        for (const change of [{percent: 11},{percent: 0},{code: 'lowercase'},{title: ''},{minSubtotalCents: 4999},
            {usageLimit: 1001},{validDays: 31},{requestId: 'bad'},{unexpected: true}]) {
            await assert.rejects(discounts.create(f.customerId,f.shopId,{ ...f.input,...change }),/invalid_discount_rules/);
        }
        await assert.rejects(discounts.create(other.customerId,f.shopId,f.input),/shop_not_found/);
        assert.equal(mutationCount,before);
        assert.deepEqual((await discounts.settings(other.customerId)).shops[0].discounts,[]);
    });
    await t.test('concurrent approvals create one global percentage code and replays cannot change it',async () => {
        const f = await fixture(),before = mutationCount;
        const result = await Promise.all([discounts.create(f.customerId,f.shopId,f.input),discounts.create(f.customerId,f.shopId,f.input)]);
        assert.equal(mutationCount,before+1); assert.equal(result[0].discount.id,result[1].discount.id);
        const replay = await discounts.create(f.customerId,f.shopId,f.input);
        assert.equal(replay.discount.status,'confirmed'); assert.equal(replay.discount.code,'RETURN10');
        await assert.rejects(discounts.create(f.customerId,f.shopId,{ ...f.input,percent: 5 }),/discount_request_reused/);
        await assert.rejects(discounts.create(f.customerId,f.shopId,{ ...f.input,requestId: randomUUID() }),/discount_code_exists/);
        const settings = await discounts.settings(f.customerId);
        assert.deepEqual(Object.keys(settings.shops[0]).sort(),['agentProfile','brand','currency','discounts','domain','id','maxDiscountPercent','minSubtotalCents']);
        assert.deepEqual(settings.shops[0].discounts,[replay.discount]);
    });
    await t.test('ambiguous and explicit failures stay durable and never issue a second Shopify creation',async () => {
        const f = await fixture(),before = mutationCount;
        mutationFailure = () => { throw new Error('Synthetic timeout after mutation'); };
        try { await assert.rejects(discounts.create(f.customerId,f.shopId,f.input),/unconfirmed_do_not_retry/); }
        finally { mutationFailure = null; }
        assert.equal((await discounts.create(f.customerId,f.shopId,f.input)).discount.status,'unknown');
        assert.equal(mutationCount,before+1);
        assert.deepEqual(await discounts.available(f.shop,10000),[]);
        const rejected = await fixture(); mutationFailure = () => ({ discountCodeBasicCreate: { userErrors: [{ code: 'TAKEN' }] } });
        try { await assert.rejects(discounts.create(rejected.customerId,rejected.shopId,rejected.input),/discount_creation_rejected/); }
        finally { mutationFailure = null; }
        assert.equal((await discounts.create(rejected.customerId,rejected.shopId,rejected.input)).discount.status,'failed');
    });
    await t.test('identity-gated agent context and selected offer derive percent and code from the approved catalog',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        const profile = { name: 'Alex',persona: 'founder',voice: 'female',language: 'en' };
        await db.query('UPDATE recovery_shops SET agent_profile=$2 WHERE id=$1',[f.shopId,JSON.stringify(profile)]);
        const anonymous = await service.getContext({ ...call,identity_verified: false }),identified = await service.getContext(call);
        assert.equal(anonymous.availableDiscounts,undefined);
        assert.deepEqual(anonymous.agentProfile,require('../src/recovery/agent-profile').forShop({ ...f.shop,agent_profile: profile }));
        assert.deepEqual(identified.agentProfile,anonymous.agentProfile);
        assert.deepEqual(identified.availableDiscounts,[approved]);
        await assert.rejects(service.getOffer(call,10),/approved_discount_required/);
        const offer = await service.getOffer(call,0,approved.id);
        assert.equal(offer.percent,10); assert.equal(offer.discountId,approved.id); assert.equal(offer.code,'RETURN10');
        assert.equal(new URL(offer.checkoutUrl).searchParams.get('discount'),'RETURN10');
        assert.deepEqual(await service.getOffer(call,99,approved.id),offer);
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        assert.deepEqual(await service.sendLink(call),{status: 'accepted',delivered: false});
        assert.equal(sms.mock.calls.length,before+1); assert.equal(adHoc.mock.calls.length,0);
    });
    await t.test('Shopify deactivation or edits fail closed before offering or sending a catalog code',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const row = (await db.query('SELECT shopify_id FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        const data = remote.get(row.shopify_id),original = structuredClone(data.node),before = sms.mock.calls.length;
        for (const change of [
            (d) => { d.status='EXPIRED'; },(d) => { d.customerGets.value.percentage=0.3; },
            (d) => { d.codes.nodes[0].code='CHANGED'; },(d) => { d.asyncUsageCount=d.usageLimit; },
            (d) => { d.combinesWith.orderDiscounts=true; },(d) => { d.appliesOncePerCustomer=false; },
            (d) => { d.minimumRequirement.greaterThanOrEqualToSubtotal.amount='99.00'; },
            (d) => { d.endsAt=new Date(Date.now()-1000).toISOString(); },(d) => { d.context.__typename='DiscountCustomers'; },
        ]) {
            data.node=structuredClone(original); change(data.node.codeDiscount);
            await assert.rejects(service.getOffer(call,0,approved.id),/discount_not_available/);
            await assert.rejects(service.sendLink(call),/discount_not_available/);
        }
        data.node=original;
        await db.query(`UPDATE recovery_shops SET rules=jsonb_set(rules,'{maxDiscountPercent}','5') WHERE id=$1`,[f.shopId]);
        await assert.rejects(service.sendLink(call),/discount_not_available/);
        assert.equal(sms.mock.calls.length,before);
    });
    await t.test('remote reads do not hold the merchant/contact lock and policy is rechecked afterwards',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        let entered,release;
        const started = new Promise((resolve) => { entered=resolve; }),waiting = new Promise((resolve) => { release=resolve; });
        readHook = async () => { entered(); await waiting; };
        const pending = service.sendLink(call); await started;
        try {
            const stopped = await Promise.race([service.stopContact(f.customerId,f.shopId,call.checkout_id),
                new Promise((_,reject) => { const timer=setTimeout(() => reject(new Error('Contact stop blocked by Shopify read')),1000); timer.unref(); })]);
            assert.equal(stopped.stopped,true);
        } finally { readHook=null; release(); }
        await assert.rejects(pending,/contact_stopped|consent_missing/);
    });
    await t.test('a code deactivated after SMS reservation fails before dispatch and is never resent',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const row = (await db.query('SELECT shopify_id FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        let reads = 0; const before = sms.mock.calls.length;
        readHook = async () => { if (++reads===2) remote.get(row.shopify_id).node.codeDiscount.status='EXPIRED'; };
        try { await assert.rejects(service.sendLink(call),/discount_not_available/); }
        finally { readHook=null; }
        const saved = (await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`,[call.checkout_id])).rows[0];
        assert.equal(saved.status,'failed'); assert.equal(sms.mock.calls.length,before);
        await assert.rejects(service.sendLink(call),/discount_not_available/);
        assert.equal(sms.mock.calls.length,before);
    });
    assert.ok(graphql.mock.calls.length>0);
});
