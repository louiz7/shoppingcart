'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const nativeFetch=global.fetch;

test('link resolver requires the internal secret even from loopback',async()=>{
    const express=require('express'),app=express(),previous=process.env.INTERNAL_TOOL_SECRET;
    process.env.INTERNAL_TOOL_SECRET='synthetic-link-resolver-secret';
    app.use('/links',express.json(),require('../src/recovery/sms-links').router());
    const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
    try {
        for(const secret of ['', 'wrong']){
            const response=await nativeFetch(`http://127.0.0.1:${server.address().port}/links/resolve`,{method:'POST',headers:{'Content-Type':'application/json','x-internal-secret':secret},body:JSON.stringify({token:'a'.repeat(64),recordOpen:true})});
            assert.equal(response.status,401);
        }
    } finally {
        await new Promise(resolve=>server.close(resolve));
        if(previous===undefined)delete process.env.INTERNAL_TOOL_SECRET;else process.env.INTERNAL_TOOL_SECRET=previous;
    }
});

test('tracked checkout links preserve targets and attribute only opened, subsequently paid orders', {skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000},async t=>{
    require('dotenv').config();const url=new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    process.env.RECOVERY_PUBLIC_URL='https://recovery.example.invalid';
    process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED='1';
    const {db}=require('../src/recovery/store'),links=require('../src/recovery/sms-links'),hooks=require('../src/recovery/webhooks'),org=require('../src/recovery/organizations');
    const policy=require('../src/recovery/policy'),tenants=[];
    t.mock.method(global,'fetch',async()=>{throw Error('External network forbidden');});
    t.after(async()=>{for(const id of tenants)await db.query('DELETE FROM customers WHERE id=$1',[id]);await db.pool.end();});
    async function fixture({callTest=false}={}){
        const shopId=randomUUID(),checkoutId=randomUUID(),callId=randomUUID(),actionId=randomUUID();
        const customerId=(await db.query('INSERT INTO customers(name,email,is_rescova_internal) VALUES($1,$2,true) RETURNING id',['Synthetic link test '+shopId,randomUUID()+'@example.invalid'])).rows[0].id;tenants.push(customerId);
        const userId=(await db.query("INSERT INTO platform_users(customer_id,email,display_name,password_hash,role) VALUES($1,$2,'Synthetic','unused','admin') RETURNING id",[customerId,randomUUID()+'@example.invalid'])).rows[0].id;
        const shop={id:shopId,domain:shopId+'.myshopify.com',currency:'EUR'};
        await db.query("INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,currency) VALUES($1,$2,$3,'Synthetic','live','EUR')",[shopId,customerId,shop.domain]);
        const phone='+4900000000001',key=policy.contactKey(shopId,phone),external=String(Math.floor(Math.random()*1e14));
        await db.query('INSERT INTO recovery_contacts(shop_id,contact_key,phone) VALUES($1,$2,$3)',[shopId,key,phone]);
        await db.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,contact_key,phone,currency,source_updated_at,checkout_token,snapshot)
            VALUES($1,$2,$3,$4,$5,'EUR',NOW()-INTERVAL '1 hour',$6,$7)`,[checkoutId,shopId,'gid://shopify/AbandonedCheckout/'+external,key,phone,'checkout-'+external,{customerId:'gid://shopify/Customer/123'}]);
        await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,connected_at,is_test)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes','ended',NOW()-INTERVAL '1 minute',$7)`,[callId,shopId,checkoutId,key,'recovery-'+callId,randomUUID(),callTest]);
        const target=`https://${shop.domain}/checkouts/opaque?key=synthetic&discount=EXTRA10`;
        await db.query("INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'sms','accepted',$3)",[actionId,checkoutId,{checkoutUrl:target}]);
        const link=await links.create(db,actionId,callId),token=new URL(link).pathname.split('/').at(-1);
        return {shop,checkoutId,callId,actionId,customerId,userId,external,phone,target,link,token};
    }
    function payload(f,extra={}){const at=new Date(Date.now()+1000).toISOString();return {id:randomUUID(),checkout_id:f.external,checkout_token:'checkout-'+f.external,phone:f.phone,currency:'EUR',financial_status:'paid',current_subtotal_price:'100.00',created_at:at,updated_at:at,...extra};}
    async function count(f){return (await org.overview(f.customerId,Number(f.userId))).organizations.find(o=>o.id===f.customerId).shops[0].smsLinkOrders;}
    await t.test('random hashed capability, preserved discount, no counting HEAD/prefetch and idempotent opens',async()=>{
        const f=await fixture();assert.equal(new URL(f.link).hostname,'recovery.example.invalid');
        const row=(await db.query('SELECT * FROM recovery_sms_links WHERE action_id=$1',[f.actionId])).rows[0];
        assert.equal(row.token_hash,createHash('sha256').update(f.token).digest('hex'));assert.notEqual(row.token_hash,f.token);
        assert.equal(await links.resolve(f.token,false),f.target);
        assert.equal((await db.query('SELECT first_opened_at FROM recovery_sms_links WHERE action_id=$1',[f.actionId])).rows[0].first_opened_at,null);
        await Promise.all([links.resolve(f.token),links.resolve(f.token)]);
        const first=(await db.query('SELECT first_opened_at FROM recovery_sms_links WHERE action_id=$1',[f.actionId])).rows[0].first_opened_at;
        await links.resolve(f.token);assert.equal(+(await db.query('SELECT first_opened_at FROM recovery_sms_links WHERE action_id=$1',[f.actionId])).rows[0].first_opened_at,+first);
        assert.equal(await count(f),0);
        for(const token of ['bad','a'.repeat(64),f.token+'\n'])await assert.rejects(links.resolve(token),/link_not_found/);
    });
    await t.test('a paid order counts once, survives SMS retention, and a refund removes it from the metric',async()=>{
        const f=await fixture();await links.resolve(f.token);const order=payload(f);
        await hooks.ingestShopify(f.shop,'orders/paid',order,randomUUID());await hooks.ingestShopify(f.shop,'orders/paid',order,randomUUID());
        assert.equal(await count(f),1);
        await db.query('DELETE FROM recovery_actions WHERE id=$1',[f.actionId]);assert.equal(await count(f),1);
        await hooks.ingestShopify(f.shop,'orders/updated',{...order,financial_status:'refunded',current_subtotal_price:'0.00',updated_at:new Date(Date.now()+2000).toISOString()},randomUUID());
        assert.equal(await count(f),0);
    });
    await t.test('paused tracking keeps existing links working without recording new opens',async()=>{
        const f=await fixture();delete process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED;
        try {
            assert.equal(await links.resolve(f.token),f.target);
            assert.equal((await db.query('SELECT first_opened_at FROM recovery_sms_links WHERE action_id=$1',[f.actionId])).rows[0].first_opened_at,null);
            assert.equal(await links.create(db,randomUUID(),f.callId),null);
            assert.equal((await org.overview(f.customerId,Number(f.userId))).smsLinkTrackingEnabled,false);
        } finally {process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED='1';}
    });
    await t.test('unopened, unpaid, already paid, test and wrong-checkout orders do not count',async()=>{
        for(const kind of ['unopened','unpaid','already_paid','existing_order_later_update','expired_window','test_order','test_call','wrong_checkout']){
            const f=await fixture({callTest:kind==='test_call'});
            if(kind!=='unopened')await links.resolve(f.token);
            const extra=kind==='unpaid'?{financial_status:'pending'}:kind==='test_order'?{test:true}:kind==='wrong_checkout'?{checkout_id:'foreign',checkout_token:'foreign'}:kind==='already_paid'?{updated_at:new Date(Date.now()-2000).toISOString()}:{};
            if(kind==='existing_order_later_update')extra.created_at=new Date(Date.now()-2000).toISOString();
            if(kind==='expired_window')await db.query("UPDATE recovery_calls SET connected_at=NOW()-INTERVAL '8 days' WHERE id=$1",[f.callId]);
            await hooks.ingestShopify(f.shop,'orders/paid',payload(f,extra),randomUUID());assert.equal(await count(f),0,kind);
        }
    });
    await t.test('cross-shop call links neither resolve nor attribute orders',async()=>{
        const a=await fixture(),b=await fixture();
        await links.resolve(a.token);
        await db.query('UPDATE recovery_sms_links SET call_id=$2 WHERE action_id=$1',[a.actionId,b.callId]);
        await assert.rejects(links.resolve(a.token),/link_not_found/);
        await hooks.ingestShopify(a.shop,'orders/paid',payload(a),randomUUID());
        assert.equal(await count(a),0);assert.equal(await count(b),0);
    });
    await t.test('expired, failed, foreign-host and privacy-redacted links never redirect or record an opening',async()=>{
        for(const kind of ['expired','failed','foreign','redacted','uninstalled']){
            const f=await fixture();
            if(kind==='expired')await db.query('UPDATE recovery_sms_links SET expires_at=NOW() WHERE action_id=$1',[f.actionId]);
            if(kind==='failed')await db.query("UPDATE recovery_actions SET status='failed' WHERE id=$1",[f.actionId]);
            if(kind==='foreign')await db.query("UPDATE recovery_actions SET data=jsonb_set(data,'{checkoutUrl}','\"https://foreign.invalid/\"') WHERE id=$1",[f.actionId]);
            if(kind==='redacted')await hooks.ingestShopify(f.shop,'customers/redact',{customer:{id:123}},randomUUID());
            if(kind==='uninstalled')await hooks.ingestShopify(f.shop,'app/uninstalled',{},randomUUID());
            await assert.rejects(links.resolve(f.token),kind==='foreign'?/invalid_checkout_host/:/link_not_found/);
        }
    });
    await t.test('prepared carts require the opened link to match the ordered proposal',async()=>{
        const f=await fixture(),proposalA=randomUUID(),proposalB=randomUUID(),actionB=randomUUID();
        const item={variantId:'gid://shopify/ProductVariant/9',quantity:1};
        for(const id of [proposalA,proposalB])await db.query("INSERT INTO recovery_events(id,shop_id,call_id,kind,data) VALUES($1,$2,$3,'checkout_prepared',$4)",[id,f.shop.id,f.callId,{snapshot:{items:[item]}}]);
        await db.query("UPDATE recovery_actions SET data=data||$2::jsonb WHERE id=$1",[f.actionId,JSON.stringify({proposalId:proposalA,targetKey:proposalA})]);
        await db.query("INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'sms','accepted',$3)",[actionB,f.checkoutId,{proposalId:proposalB,targetKey:proposalB,checkoutUrl:f.target}]);
        const tokenB=new URL(await links.create(db,actionB,f.callId)).pathname.split('/').at(-1);
        await links.resolve(f.token);
        const order=payload(f,{checkout_id:'new-checkout',checkout_token:'new-token',note_attributes:[{name:'rescova_recovery',value:proposalB}],line_items:[{variant_id:9,quantity:1}]});
        await hooks.ingestShopify(f.shop,'orders/paid',order,randomUUID());assert.equal(await count(f),0);
        await links.resolve(tokenB);
        await hooks.ingestShopify(f.shop,'orders/paid',{...order,id:randomUUID(),updated_at:new Date(Date.now()+2000).toISOString()},randomUUID());assert.equal(await count(f),1);
    });
});

test('public redirect has no cache/referrer leak and excludes HEAD and declared preview requests',async()=>{
    const fs=require('node:fs'),vm=require('node:vm'),ts=require('../dashboard/node_modules/typescript');
    const file='dashboard/src/routes/r/[token]/+server.ts';
    const output=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const module={exports:{}},calls=[];let destination='https://shop.example.invalid/checkouts/opaque?discount=EXTRA10';
    vm.runInNewContext(output,{module,exports:module.exports,URL,Response,AbortSignal,
        require:name=>{assert.equal(name,'$env/dynamic/private');return {env:{RECOVERY_API_URL:'http://127.0.0.1:3110',INTERNAL_TOOL_SECRET:'synthetic'}};},
        fetch:async(url,options)=>{calls.push({url:String(url),options});return {ok:true,json:async()=>({url:destination})};}},{filename:file});
    const handlers=module.exports;
    for(const [method,headers,recordOpen]of [['GET',{},true],['HEAD',{},false],['GET',{'sec-purpose':'prefetch'},false],['GET',{'purpose':'preview'},false]]){
        const response=await handlers[method]({params:{token:'a'.repeat(64)},request:new Request('https://recovery.example.invalid/r/'+'a'.repeat(64),{method,headers})});
        assert.equal(response.status,302);assert.equal(response.headers.get('location'),destination);
        assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
        assert.match(response.headers.get('x-robots-tag'),/noindex/);
        const call=calls.at(-1);assert.equal(call.url,'http://127.0.0.1:3110/internal/recovery/links/resolve');
        assert.equal(JSON.parse(call.options.body).recordOpen,recordOpen);assert.equal(call.options.redirect,'error');
    }
    const before=calls.length;
    const bad=await handlers.GET({params:{token:'bad'},request:new Request('https://recovery.example.invalid/r/bad')});assert.equal(bad.status,404);assert.equal(calls.length,before);
    destination='javascript:alert(1)';const unsafe=await handlers.GET({params:{token:'a'.repeat(64)},request:new Request('https://recovery.example.invalid/r/'+'a'.repeat(64))});assert.equal(unsafe.status,503);
});
