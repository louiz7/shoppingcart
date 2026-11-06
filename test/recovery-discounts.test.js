'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

test('merchant approved Shopify discounts persist consent, exactly-once creation and fresh usage checks', {
    skip: process.env.RECOVERY_DB_TEST!=='1',timeout: 30000,
}, async (t) => {
    require('dotenv').config();
    process.env.RECOVERY_PUBLIC_URL='https://recovery.example.invalid';
    process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED='1';
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
            // Shopify DiscountContextInput.all uses DiscountBuyerSelection; DiscountItemsInput.all remains Boolean.
            assert.equal(value.context.all,'ALL'); assert.equal(value.appliesOncePerCustomer,true);
            assert.equal(value.customerGets.items.all,true);
            assert.deepEqual(value.combinesWith,{ orderDiscounts: false,productDiscounts: false,shippingDiscounts: false });
            const node = { id,codeDiscount: { __typename: 'DiscountCodeBasic',status: 'ACTIVE',startsAt: value.startsAt,endsAt: value.endsAt,
                usageLimit: value.usageLimit,asyncUsageCount: 0,appliesOncePerCustomer: true,
                codes: { nodes: [{ code: value.code }],pageInfo: { hasNextPage: false } },context: { __typename: 'DiscountBuyerSelectionAll' },
                customerGets: { value: { __typename: 'DiscountPercentage',percentage: value.customerGets.value.percentage },
                    items: { __typename: 'AllDiscountItems',allItems: true } },
                minimumRequirement: value.minimumRequirement ? { __typename: 'DiscountMinimumSubtotal',greaterThanOrEqualToSubtotal: {
                    amount: value.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal,currencyCode: shop.currency } } : null,
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
        await require('./helpers/recovery-terms')(db,customerId);
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

    async function sendLink(call, useDiscount) {
        const { rows } = await db.query(`SELECT data FROM recovery_events WHERE call_id=$1 AND kind='user_transcript'
            ORDER BY created_at DESC LIMIT 1`,[call.id]);
        return service.sendLink(call,useDiscount,rows[0]?.data.eventId);
    }

    await t.test('merchant validation and tenant isolation reject requests before Shopify is called',async () => {
        const f = await fixture(),other = await fixture(),before = mutationCount;
        for (const change of [{percent: 101},{percent: 0},{code: 'lowercase'},{title: ''},{minSubtotalCents: -1},
            {usageLimit: 2147483648},{usageLimit: 0},{usageLimit: undefined},{usageLimit: ''},{validDays: undefined},{validDays: ''},{validDays: 0},{validDays: 0.5},{validDays: 2147483647},{requestId: 'bad'},{unexpected: true}]) {
            await assert.rejects(discounts.create(f.customerId,f.shopId,{ ...f.input,...change }),/invalid_discount_rules/);
        }
        await assert.rejects(discounts.create(other.customerId,f.shopId,f.input),/shop_not_found/);
        assert.equal(mutationCount,before);
        assert.deepEqual((await discounts.settings(other.customerId)).shops[0].discounts,[]);
    });
    await t.test('zero minimum creates EXTRA10 without a Shopify minimum and is usable below 50',async () => {
        const f = await fixture();
        await db.query('UPDATE recovery_shops SET rules=$2 WHERE id=$1',[f.shopId,{}]);
        f.shop.rules = {};
        const input = { ...f.input,title: 'Black Month',code: 'EXTRA10',minSubtotalCents: 0 };
        const approved = (await discounts.create(f.customerId,f.shopId,input)).discount;
        assert.equal(approved.status,'confirmed'); assert.equal(approved.minSubtotalCents,0);
        const mutation = graphql.mock.calls.find(c => c.arguments[2]?.input?.code === 'EXTRA10');
        assert.equal(Object.hasOwn(mutation.arguments[2].input,'minimumRequirement'),false);
        assert.equal((await discounts.verify(f.shop,approved.id,100)).code,'EXTRA10');
        assert.deepEqual((await discounts.available(f.shop,100)).map(d=>d.id),[approved.id]);
        assert.equal((await discounts.settings(f.customerId)).shops[0].discounts[0].code,'EXTRA10');
        const call = await caller(f);
        const offer = await service.getOffer(call,0,approved.id);
        assert.equal(offer.percent,10);
        const row = (await db.query('SELECT * FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        const actual = remote.get(row.shopify_id).node.codeDiscount;
        for (const minimum of [undefined,{__typename:'DiscountMinimumQuantity'},
            {__typename:'DiscountMinimumSubtotal',greaterThanOrEqualToSubtotal:{amount:'1.00',currencyCode:'USD'}}]) {
            actual.minimumRequirement = minimum;
            await assert.rejects(discounts.verify(f.shop,approved.id,10000),/discount_not_available/);
        }
        actual.minimumRequirement = {__typename:'DiscountMinimumSubtotal',greaterThanOrEqualToSubtotal:{amount:'0.00',currencyCode:'USD'}};
        assert.equal((await discounts.verify(f.shop,approved.id,100)).code,'EXTRA10');
    });
    await t.test('unlimited codes stay verified and yield bounded offers and discount links',async () => {
        const f=await fixture(),input={...f.input,minSubtotalCents:0,validDays:null,usageLimit:null};
        const approved=(await discounts.create(f.customerId,f.shopId,input)).discount;
        assert.equal(approved.expiresAt,null); assert.equal(approved.usageLimit,null); assert.equal(approved.status,'confirmed');
        const row=(await db.query('SELECT * FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        assert.equal(row.valid_days,null); assert.equal(row.expires_at,null); assert.equal(row.usage_limit,null);
        const actual=remote.get(row.shopify_id).node.codeDiscount;
        assert.equal(actual.endsAt,null); assert.equal(actual.usageLimit,null);
        actual.asyncUsageCount=100000;
        assert.equal((await discounts.available(f.shop,100))[0].id,approved.id);
        const original=structuredClone(actual);
        for(const change of [d=>{d.endsAt=undefined;},d=>{d.endsAt=new Date(Date.now()+86400000).toISOString();},
            d=>{d.usageLimit=100001;},d=>{d.usageLimit=undefined;},d=>{d.asyncUsageCount=-1;}]) {
            change(actual);await assert.rejects(discounts.verify(f.shop,approved.id,100),/discount_not_available/);
            Object.assign(actual,structuredClone(original));
        }
        assert.deepEqual((await discounts.create(f.customerId,f.shopId,input)).discount,approved);
        await assert.rejects(discounts.create(f.customerId,f.shopId,{...input,validDays:7}),/discount_request_reused/);
        const call=await caller(f),offer=await service.getOffer(call,0,approved.id);
        assert.ok(Date.parse(offer.expiresAt)>Date.now());assert.ok(Date.parse(offer.expiresAt)<=Date.now()+86400000);
        await service.recordTranscript(call,{role:'assistant',eventId:randomUUID(),text:'Du bekommst mit RETURN10 zehn Prozent Rabatt.'});
        await service.recordTranscript(call,{role:'user',eventId:randomUUID(),text:'Ja, gerne. Schick mir den Link mit diesem Rabatt.'});
        const before=sms.mock.calls.length;
        assert.equal((await sendLink(call,true)).status,'accepted');
        assert.equal(new URL(await require('../src/recovery/sms-links').resolve(new URL(sms.mock.calls[before].arguments[1].split(' ').at(-1)).pathname.split('/').at(-1),false)).searchParams.get('discount'),'RETURN10');
    });
    await t.test('merchant terms can exceed old defaults while explicit shop limits remain binding',async () => {
        const f = await fixture();
        const approved = (await discounts.create(f.customerId,f.shopId,{...f.input,percent:40,minSubtotalCents:0,validDays:365,usageLimit:5000})).discount;
        assert.equal(approved.percent,40); assert.equal(approved.usageLimit,5000);
        assert.equal((await discounts.verify(f.shop,approved.id,100)).percent,40);
        const before = mutationCount;
        await db.query('UPDATE recovery_shops SET rules=$2 WHERE id=$1',[f.shopId,{maxDiscountPercent:10,minSubtotalCents:5000}]);
        for (const change of [{percent:11},{minSubtotalCents:0}]) {
            await assert.rejects(discounts.create(f.customerId,f.shopId,{...f.input,requestId:randomUUID(),...change}),/invalid_discount_rules/);
        }
        assert.equal(mutationCount,before);
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
    await t.test('startup context and selected offer derive percent and code from the approved catalog',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        const profile = { name: 'Alex',persona: 'founder',voice: 'female',language: 'en' };
        await db.query('UPDATE recovery_shops SET agent_profile=$2 WHERE id=$1',[f.shopId,JSON.stringify(profile)]);
        const anonymous = await service.getContext({ ...call,identity_verified: false }),identified = await service.getContext(call);
        assert.deepEqual(anonymous.availableDiscounts,[approved]);
        assert.equal(anonymous.contactConfirmed,false);
        assert.deepEqual(anonymous.agentProfile,require('../src/recovery/agent-profile').forShop({ ...f.shop,agent_profile: profile }));
        assert.deepEqual(identified.agentProfile,anonymous.agentProfile);
        assert.deepEqual(identified.availableDiscounts,[approved]);
        await assert.rejects(service.getOffer(call,10),/approved_discount_required/);
        const offer = await service.getOffer(call,0,approved.id);
        assert.equal(offer.percent,10); assert.equal(offer.discountId,approved.id); assert.equal(offer.code,'RETURN10');
        assert.equal(new URL(offer.checkoutUrl).searchParams.get('discount'),'RETURN10');
        assert.deepEqual(await service.getOffer(call,99,approved.id),offer);
        await service.recordTranscript(call,{ role: 'assistant',eventId: randomUUID(),text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Ja, gerne.' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        delete process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED;
        try {assert.deepEqual(await sendLink(call, true),{status: 'accepted',delivered: false});}
        finally {process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED='1';}
        assert.equal(sms.mock.calls.length,before+1); assert.equal(adHoc.mock.calls.length,0);
        const direct=new URL(sms.mock.calls[before].arguments[1].split(' ').at(-1));
        assert.equal(direct.hostname,new URL(offer.checkoutUrl).hostname);
        assert.equal(direct.searchParams.get('discount'),'RETURN10');
    });
    await t.test('an available or merely prepared discount is never added to the default SMS link',async () => {
        for (const prepared of [false,true]) {
            const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
            if (prepared) await service.getOffer(call,0,approved.id);
            await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
            const before = sms.mock.calls.length;
            if (prepared) await assert.rejects(sendLink(call,true),/discount_review_required/);
            await sendLink(call);
            const link = new URL(await require('../src/recovery/sms-links').resolve(new URL(sms.mock.calls[before].arguments[1].split(' ').at(-1)).pathname.split('/').at(-1),false));
            assert.equal(link.searchParams.has('discount'),false);
        }
    });
    await t.test('discount agreement is scoped to the current call and follows the validated offer',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.recordTranscript(call,{ role: 'assistant',eventId: randomUUID(),text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Ja, gerne.' });
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const before = sms.mock.calls.length;
        await assert.rejects(sendLink(call,true),/discount_review_required/);
        assert.equal(sms.mock.calls.length,before);
        assert.equal((await db.query("SELECT count(*)::int AS n FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'",[call.checkout_id])).rows[0].n,0);
    });
    await t.test('interrupted offer speech cannot authorize a discounted SMS',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role:'assistant',eventId:randomUUID(),text:'Mit zehn Prozent Rabatt ...',interrupted:true });
        await service.recordTranscript(call,{ role:'user',eventId:randomUUID(),text:'Schick mir den Link.' });
        const before = sms.mock.calls.length;
        await assert.rejects(sendLink(call,true),/discount_review_required/);
        assert.equal(sms.mock.calls.length,before);
    });
    await t.test('Shopify deactivation or edits fail closed before offering or sending a catalog code',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'assistant',eventId: randomUUID(),text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Ja, gerne.' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const row = (await db.query('SELECT shopify_id FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        const data = remote.get(row.shopify_id),original = structuredClone(data.node),before = sms.mock.calls.length;
        for (const change of [
            (d) => { d.status='EXPIRED'; },(d) => { d.customerGets.value.percentage=0.3; },
            (d) => { d.codes.nodes[0].code='CHANGED'; },(d) => { d.asyncUsageCount=d.usageLimit; },
            (d) => { d.combinesWith.orderDiscounts=true; },(d) => { d.appliesOncePerCustomer=false; },
            (d) => { d.minimumRequirement.greaterThanOrEqualToSubtotal.amount='99.00'; },
            (d) => { d.minimumRequirement=null; },
            (d) => { d.endsAt=new Date(Date.now()-1000).toISOString(); },(d) => { d.context.__typename='DiscountCustomers'; },
        ]) {
            data.node=structuredClone(original); change(data.node.codeDiscount);
            await assert.rejects(service.getOffer(call,0,approved.id),/discount_not_available/);
            await assert.rejects(sendLink(call, true),/discount_not_available/);
        }
        data.node=original;
        await db.query(`UPDATE recovery_shops SET rules=jsonb_set(rules,'{maxDiscountPercent}','5') WHERE id=$1`,[f.shopId]);
        await assert.rejects(sendLink(call, true),/discount_not_available/);
        assert.equal(sms.mock.calls.length,before);
    });
    await t.test('remote reads do not hold the merchant/contact lock and policy is rechecked afterwards',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'assistant',eventId: randomUUID(),text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Ja, gerne.' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        let entered,release;
        const started = new Promise((resolve) => { entered=resolve; }),waiting = new Promise((resolve) => { release=resolve; });
        readHook = async () => { entered(); await waiting; };
        const pending = sendLink(call, true); await started;
        try {
            const stopped = await Promise.race([service.stopContact(f.customerId,f.shopId,call.checkout_id),
                new Promise((_,reject) => { const timer=setTimeout(() => reject(new Error('Contact stop blocked by Shopify read')),1000); timer.unref(); })]);
            assert.equal(stopped.stopped,true);
        } finally { readHook=null; release(); }
        await assert.rejects(pending,/contact_stopped|consent_missing/);
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
                FROM recovery_calls WHERE checkout_id=NEW.checkout_id;`, error: /conversation_changed/ },
            { sql: `INSERT INTO recovery_events(id,shop_id,call_id,kind,data,created_at)
                SELECT gen_random_uuid(),shop_id,id,'user_transcript',
                    jsonb_build_object('text','Bitte senden Sie mir den Link per SMS, aber ohne Rabatt.','eventId',gen_random_uuid()),clock_timestamp()
                FROM recovery_calls WHERE checkout_id=NEW.checkout_id;`, error: /conversation_changed/ },
        ];
        for (const change of changes) {
            const f = await fixture(),approved=(await discounts.create(f.customerId,f.shopId,f.input)).discount,call=await caller(f);
            const checkoutId=call.checkout_id;
            await service.getOffer(call,0,approved.id);
            await service.recordTranscript(call, { role: 'assistant', eventId: randomUUID(), text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
            await service.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Ja, gerne.' });
            await service.recordTranscript(call, { role: 'user', eventId: randomUUID(), text: 'Bitte senden Sie mir den Link per SMS.' });
            const name = `recovery_sms_test_${randomUUID().replaceAll('-', '')}`;
            // Inject a change at the reservation boundary without contacting external providers.
            await db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
                ${change.sql} RETURN NEW; END $$`);
            try {
                await db.query(`CREATE TRIGGER ${name} AFTER INSERT ON recovery_actions FOR EACH ROW
                    WHEN (NEW.kind='sms' AND NEW.checkout_id='${checkoutId}') EXECUTE FUNCTION ${name}()`);
                const before = sms.mock.calls.length;
                await assert.rejects(sendLink(call, true), change.error);
                assert.equal(sms.mock.calls.length, before);
                assert.equal((await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`, [checkoutId])).rows[0].status, 'failed');
                assert.deepEqual(await sendLink(call, true), { status: 'failed', duplicate: true });
                assert.equal(sms.mock.calls.length, before);
            } finally { await db.query(`DROP FUNCTION ${name}() CASCADE`); }
        }
    });

    await t.test('a code deactivated after SMS reservation fails before dispatch and is never resent',async () => {
        const f = await fixture(),approved = (await discounts.create(f.customerId,f.shopId,f.input)).discount,call = await caller(f);
        await service.getOffer(call,0,approved.id);
        await service.recordTranscript(call,{ role: 'assistant',eventId: randomUUID(),text: 'Bist du mit 10 Prozent Rabatt einverstanden?' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Ja, gerne.' });
        await service.recordTranscript(call,{ role: 'user',eventId: randomUUID(),text: 'Bitte senden Sie mir den Link per SMS.' });
        const row = (await db.query('SELECT shopify_id FROM recovery_discounts WHERE id=$1',[approved.id])).rows[0];
        let reads = 0; const before = sms.mock.calls.length;
        readHook = async () => { if (++reads===2) remote.get(row.shopify_id).node.codeDiscount.status='EXPIRED'; };
        try { await assert.rejects(sendLink(call, true),/discount_not_available/); }
        finally { readHook=null; }
        const saved = (await db.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`,[call.checkout_id])).rows[0];
        assert.equal(saved.status,'failed'); assert.equal(sms.mock.calls.length,before);
        await assert.rejects(sendLink(call, true),/discount_not_available/);
        assert.equal(sms.mock.calls.length,before);
    });
    assert.ok(graphql.mock.calls.length>0);
});
