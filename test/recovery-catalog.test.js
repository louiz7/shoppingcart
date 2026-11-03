'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const catalog = require('../src/recovery/catalog');
const shopify = require('../src/recovery/shopify');
const variant = (id='2',price='80.00') => ({id:`gid://shopify/ProductVariant/${id}`,title:'Black / M',price,
    availableForSale:true,inventoryPolicy:'DENY',sellableOnlineQuantity:4,
    product:{id:'gid://shopify/Product/2',title:'Alternative',description:'Cotton, black.',status:'ACTIVE',
        publishedAt:'2026-01-01T00:00:00Z',requiresSellingPlan:false,isGiftCard:false}});

test('catalog searches are bounded, escaped, priced and exclude unavailable or unsupported products',async t => {
    const nodes=[variant(),variant('3','120.00'),variant('4'),variant('5'),variant('6')];
    nodes[2].availableForSale=false;nodes[3].product.requiresSellingPlan=true;nodes[4].product.publishedAt=null;
    const query=t.mock.method(shopify,'graphql',async()=>({shop:{currencyCode:'EUR'},
        products:{nodes:nodes.map(v=>({...v.product,variants:{nodes:[v]}}))}}));
    const result=await catalog.search({currency:'EUR'},'cotton OR status:draft',10000);
    assert.deepEqual(result.products.map(p=>p.variantId),['gid://shopify/ProductVariant/2']);
    assert.equal(result.searchIsExhaustive,false);
    assert.match(query.mock.calls[0].arguments[2].query,/^status:active AND/);
    assert.doesNotMatch(query.mock.calls[0].arguments[2].query,/status:draft/);
    for(const q of ['',':()','x'.repeat(101)])await assert.rejects(catalog.search({},q),/invalid_product_search/);
    await assert.rejects(catalog.search({currency:'USD'},'cotton'),/unsupported_shop_currency/);
});

test('selected variants are freshly validated and permalink has exactly the chosen items, no buyer data or implicit discount',async t=>{
    let nodes=[variant()];
    t.mock.method(shopify,'graphql',async()=>({nodes,shop:{currencyCode:'EUR'}}));
    const shop={domain:'synthetic.myshopify.com',currency:'EUR'},items=[{variantId:variant().id,quantity:2}];
    const cart=await catalog.snapshot(shop,items);
    assert.equal(cart.subtotalCents,16000);
    const link=new URL(catalog.permalink(shop,cart,'opaque-id'));
    assert.equal(link.pathname,'/cart/2:2');assert.equal(link.searchParams.get('attributes[rescova_recovery]'),'opaque-id');
    assert.deepEqual([...link.searchParams.keys()],['attributes[rescova_recovery]']);
    assert.equal(new URL(catalog.permalink(shop,cart,'opaque-id','TEN')).searchParams.get('discount'),'TEN');
    for(const bad of [[],[...items,...items],[{...items[0],quantity:0}],[{...items[0],quantity:11}],
        [{...items[0],variantId:'https://evil.example/2'}],[{...items[0],price:1}]])assert.throws(()=>catalog.selection(bad),/invalid_checkout_selection/);
    nodes[0].sellableOnlineQuantity=1;await assert.rejects(catalog.snapshot(shop,items),/selected_product_unavailable/);
    nodes[0].inventoryItem={tracked:false};assert.equal((await catalog.snapshot(shop,items)).items[0].available,true);
    nodes[0].requiresComponents=true;await assert.rejects(catalog.snapshot(shop,items),/selected_product_unavailable/);
    nodes=[];await assert.rejects(catalog.snapshot(shop,items),/selected_product_unavailable/);
});

test('alternative checkout complete path, corrections, discounts, SMS dedupe and exact paid attribution',{
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async t=>{
    require('dotenv').config();
    const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const {db,transaction}=require('../src/recovery/store'),service=require('../src/recovery/service'),policy=require('../src/recovery/policy');
    const discounts=require('../src/recovery/discounts'),telephony=require('../src/recovery/telephony'),hooks=require('../src/recovery/webhooks');
    const tenants=[];let nodes=[variant(),variant('3','60.00')];
    t.mock.method(global,'fetch',async()=>{throw Error('Network forbidden');});
    t.mock.method(shopify,'graphql',async(_shop,_query,args)=>({nodes:nodes.filter(v=>args.ids.includes(v.id)),shop:{currencyCode:'EUR'}}));
    t.mock.method(shopify,'refreshCheckout',async(shop,id)=>(await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[shop.id,id])).rows[0].snapshot);
    t.mock.method(telephony,'assertSmsReady',()=>{});
    const send=t.mock.method(telephony,'sendSms',async()=>({id:`SM${'a'.repeat(32)}`,status:'queued'}));
    const discountId=randomUUID(),proof={id:discountId,code:'APPROVED10',percent:10,fingerprint:'synthetic-fingerprint',expiresAt:new Date(Date.now()+3600000).toISOString()};
    t.mock.method(discounts,'verify',async(_shop,id)=>{assert.equal(id,discountId);return {...proof,verifiedAt:Date.now()};});
    t.mock.method(discounts,'assertApproved',async(_client,_shop,value)=>assert.equal(value.id,discountId));
    t.after(async()=>{for(const id of tenants)await db.query('DELETE FROM customers WHERE id=$1',[id]);await db.pool.end();});
    const items=[{variantId:variant().id,quantity:1}];
    async function fixture(){
        const shopId=randomUUID(),customerId=(await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',[`Catalog test ${shopId}`,`${shopId}@example.invalid`])).rows[0].id;
        tenants.push(customerId);
        await require('./helpers/recovery-terms')(db,customerId);
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,currency) VALUES($1,$2,$3,'Test','EUR')`,[shopId,customerId,`${shopId}.myshopify.com`]);
        const shop=await service.shopFor(customerId,shopId),snapshot={id:'gid://shopify/AbandonedCheckout/123',updatedAt:new Date(Date.now()-7200000).toISOString(),
            completedAt:null,phone:'+4900000000001',currency:'EUR',subtotalCents:10000,discountCodes:[],checkoutUrl:`https://${shop.domain}/checkouts/original`,
            items:[{...items[0],variantId:'gid://shopify/ProductVariant/1',title:'Original',currentPriceCents:10000,originalUnitCents:10000,available:true}]};
        await transaction(c=>service.upsertCheckout(c,shop,snapshot));
        const checkoutId=(await db.query('SELECT id FROM recovery_checkouts WHERE shop_id=$1',[shopId])).rows[0].id;
        await service.saveSettings(customerId,shopId,{brand:'Test',brand_voice:'Friendly',enabled:true,approval:true,rules:shop.rules});
        await service.consent(customerId,shopId,checkoutId,{verified:true,evidence:'Synthetic owner consent for isolated test',timezone:'Europe/Berlin',consentedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()});
        await db.query("UPDATE recovery_shops SET mode='live',webhooks_ready=TRUE WHERE id=$1",[shopId]);
        const id=randomUUID();
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,identity_verified,connected_at,dialed_at)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '15 minutes','connected',TRUE,NOW(),NOW())`,[id,shopId,checkoutId,policy.contactKey(shopId,snapshot.phone),`recovery-${id}`,randomUUID()]);
        return {shop:await service.shopFor(customerId,shopId),snapshot,call:{id,shop_id:shopId,checkout_id:checkoutId,customer_id:customerId,identity_verified:true}};
    }
    async function user(call,text='Ja, das nehme ich. Schick mir den Link per SMS.'){
        const id=randomUUID();await service.recordTranscript(call,{eventId:id,role:'user',text});return id;
    }
    async function review(call,text='Ein schwarzes Shirt in M für 80 Euro, statt des alten Artikels. Soll ich dir diesen Checkout per SMS senden?'){
        await service.recordTranscript(call,{eventId:randomUUID(),role:'assistant',text});return user(call);
    }
    await t.test('a non-expiring discount still produces a finite checkout proposal',async()=>{
        const previous=proof.expiresAt;proof.expiresAt=null;
        try {
            const f=await fixture(),prepared=await catalog.prepareCheckout(f.call,items,discountId);
            assert.ok(Date.parse(prepared.expiresAt)>Date.now());
            assert.ok(Date.parse(prepared.expiresAt)<=Date.now()+30*60000);
            const verified=await catalog.verifyProposal(f.call,prepared.preparedCheckoutId,true);
            assert.equal(verified.discount.expiresAt,null);
        } finally {proof.expiresAt=previous;}
    });
    await t.test('knowledge tools use the call tenant and reject revoked permission even during a lookup',async sub=>{
        const knowledge=require('../src/recovery/knowledge'),f=await fixture(),other=await fixture();
        const read=sub.mock.method(knowledge,'product',async(s,id)=>{
            assert.equal(s.id,f.shop.id);assert.equal(id,variant().id);
            return {status:'loaded',attributes:[{label:'Material',value:'Cotton'}]};
        });
        const policies=sub.mock.method(knowledge,'policies',async s=>{assert.equal(s.id,f.shop.id);return {status:'missing_scope'};});
        assert.equal((await catalog.productDetails(f.call,variant().id)).attributes[0].value,'Cotton');
        assert.equal((await catalog.shopPolicies(f.call)).status,'missing_scope');assert.equal(policies.mock.calls.length,1);
        await assert.rejects(catalog.productDetails({...f.call,shop_id:other.shop.id},variant().id),/shop_not_found/);
        await db.query('UPDATE recovery_calls SET identity_verified=FALSE WHERE id=$1',[f.call.id]);
        await assert.rejects(catalog.productDetails(f.call,variant().id),/call_authorization_changed/);
        assert.equal(read.mock.calls.length,1);
        await db.query('UPDATE recovery_calls SET identity_verified=TRUE WHERE id=$1',[f.call.id]);
        read.mock.mockImplementation(async()=>{
            await db.query('UPDATE recovery_contacts SET stopped_at=NOW() WHERE shop_id=$1',[f.shop.id]);
            return {status:'loaded',attributes:[{value:'Must not be returned after opt-out'}]};
        });
        await assert.rejects(catalog.productDetails(f.call,variant().id),/contact_stopped/);
        await assert.rejects(catalog.shopPolicies(f.call),/contact_stopped/);
        assert.equal(policies.mock.calls.length,1);
    });
    await t.test('new product sends once and original checkout is unchanged; paid webhook credits original recovery',async()=>{
        const f=await fixture(),before=send.mock.calls.length,p=await catalog.prepareCheckout(f.call,items);
        assert.equal(p.cart.subtotalCents,8000);assert.equal(p.originalCartUnchanged,true);
        assert.equal((await catalog.prepareCheckout(f.call,items)).preparedCheckoutId,p.preparedCheckoutId);
        const consent=await review(f.call);
        const results=await Promise.all([service.sendLink(f.call,false,consent,p.preparedCheckoutId),service.sendLink(f.call,false,consent,p.preparedCheckoutId)]);
        assert.equal(results.filter(r=>r.duplicate).length,1);assert.equal(send.mock.calls.length,before+1);
        const link=new URL(send.mock.calls.at(-1).arguments[1].split(' ').at(-1));assert.equal(link.pathname,'/cart/2:1');assert.equal(link.searchParams.has('discount'),false);
        assert.deepEqual((await db.query('SELECT snapshot FROM recovery_checkouts WHERE id=$1',[f.call.checkout_id])).rows[0].snapshot,f.snapshot);
        const payload={id:'501',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),currency:'EUR',current_subtotal_price:'80.00',financial_status:'paid',phone:f.snapshot.phone,
            checkout_id:'999',checkout_token:'new-checkout',line_items:[{variant_id:2,quantity:1}],note_attributes:[{name:'rescova_recovery',value:p.preparedCheckoutId}]};
        await hooks.ingestShopify(f.shop,'orders/paid',payload,randomUUID());
        assert.equal((await db.query('SELECT recovery_checkout_id FROM recovery_orders WHERE shop_id=$1',[f.shop.id])).rows[0].recovery_checkout_id,f.call.checkout_id);
        assert.equal((await service.dailySummary(f.call.customer_id)).shops[0].confirmedCheckoutsToday,1);
    });
    await t.test('review, current user message, current proposal and same-call ownership are required',async()=>{
        const f=await fixture(),other=await fixture(),p=await catalog.prepareCheckout(f.call,items),before=send.mock.calls.length;
        await assert.rejects(service.sendLink(f.call,false,await user(f.call),p.preparedCheckoutId),/checkout_review_required/);
        const consent=await review(f.call);
        await assert.rejects(service.sendLink(other.call,false,await review(other.call),p.preparedCheckoutId),/prepared_checkout_changed/);
        await user(f.call,'Moment, doch lieber eine andere Größe.');
        await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/conversation_changed/);
        await catalog.prepareCheckout(f.call,[{variantId:variant('3').id,quantity:1}]);
        await assert.rejects(service.sendLink(f.call,false,await user(f.call),p.preparedCheckoutId),/prepared_checkout_changed/);
        assert.equal(send.mock.calls.length,before);
    });
    await t.test('price/inventory changes and contact stop block dispatch',async()=>{
        const f=await fixture(),p=await catalog.prepareCheckout(f.call,items),consent=await review(f.call),before=send.mock.calls.length;
        nodes[0].price='81.00';await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/selected_product_changed/);
        nodes[0].price='80.00';nodes[0].availableForSale=false;await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/selected_product_unavailable/);
        nodes[0].availableForSale=true;await db.query('UPDATE recovery_contacts SET stopped_at=NOW() WHERE shop_id=$1',[f.shop.id]);
        await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/contact_stopped/);assert.equal(send.mock.calls.length,before);
    });
    await t.test('discount needs its own newly reviewed proposal; no carry-over from the original cart',async()=>{
        const f=await fixture(),plain=await catalog.prepareCheckout(f.call,items),consent=await review(f.call);
        await assert.rejects(service.sendLink(f.call,true,consent,plain.preparedCheckoutId),/valid_offer_required/);
        const discounted=await catalog.prepareCheckout(f.call,items,discountId);
        assert.equal(discounted.offer.merchandiseTotalCents,7200);
        await assert.rejects(service.sendLink(f.call,true,consent,discounted.preparedCheckoutId),/checkout_review_required/);
        await service.sendLink(f.call,true,await review(f.call,'Mit 10 Prozent sind es 72 Euro. Soll ich dir diesen Checkout mit Rabatt per SMS schicken?'),discounted.preparedCheckoutId);
        assert.equal(new URL(send.mock.calls.at(-1).arguments[1].split(' ').at(-1)).searchParams.get('discount'),'APPROVED10');
    });
    await t.test('changed selected product can be sent after an earlier original link; no duplicate on retry',async()=>{
        const f=await fixture(),before=send.mock.calls.length;
        await service.sendLink(f.call,false,await user(f.call));
        const p=await catalog.prepareCheckout(f.call,items),consent=await review(f.call);
        await service.sendLink(f.call,false,consent,p.preparedCheckoutId);
        await service.sendLink(f.call,false,consent,p.preparedCheckoutId);
        assert.equal(send.mock.calls.length,before+2);
    });
    await t.test('correction during final product validation prevents a queued SMS from leaving',async()=>{
        const f=await fixture(),p=await catalog.prepareCheckout(f.call,items),consent=await review(f.call),before=send.mock.calls.length;
        let requests=0;
        const query=t.mock.method(shopify,'graphql',async(_shop,_query,args)=>{
            if(++requests===2)await user(f.call,'Warte, doch keinen Link schicken.');
            return {nodes:nodes.filter(v=>args.ids.includes(v.id)),shop:{currencyCode:'EUR'}};
        });
        try {await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/conversation_changed/);}
        finally {query.mock.restore();}
        assert.equal(send.mock.calls.length,before);
        assert.equal((await db.query("SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'",[f.call.checkout_id])).rows[0].status,'failed');
    });
    await t.test('ambiguous dispatch is never retried and identical plain links dedupe across proposal variants',async()=>{
        const f=await fixture(),p=await catalog.prepareCheckout(f.call,items),consent=await review(f.call),before=send.mock.calls.length;
        send.mock.mockImplementation(async()=>{throw Error('Synthetic network timeout');});
        try {
            await assert.rejects(service.sendLink(f.call,false,consent,p.preparedCheckoutId),/sms_result_unknown_do_not_retry/);
            assert.deepEqual(await service.sendLink(f.call,false,consent,p.preparedCheckoutId),{status:'unknown',duplicate:true});
            const discounted=await catalog.prepareCheckout(f.call,items,discountId);
            assert.deepEqual(await service.sendLink(f.call,false,await review(f.call),discounted.preparedCheckoutId),{status:'unknown',duplicate:true});
            assert.equal(send.mock.calls.length,before+1);
        } finally {send.mock.mockImplementation(async()=>({id:`SM${'a'.repeat(32)}`,status:'queued'}));}
    });
    await t.test('untrusted cross-shop, wrong recipient and unsent attributes do not earn credit',async()=>{
        const f=await fixture(),other=await fixture(),p=await catalog.prepareCheckout(f.call,items);
        const base={id:'777',created_at:new Date().toISOString(),updated_at:new Date().toISOString(),currency:'EUR',current_subtotal_price:'80.00',financial_status:'paid',phone:f.snapshot.phone,
            line_items:[{variant_id:2,quantity:1}],note_attributes:[{name:'rescova_recovery',value:p.preparedCheckoutId}]};
        await hooks.ingestShopify(other.shop,'orders/paid',base,randomUUID());
        await hooks.ingestShopify(f.shop,'orders/paid',{...base,phone:'+4900000000009'},randomUUID());
        assert.equal((await db.query('SELECT count(*)::int n FROM recovery_orders WHERE shop_id=ANY($1::uuid[]) AND recovery_checkout_id IS NOT NULL',[[f.shop.id,other.shop.id]])).rows[0].n,0);
    });
});
