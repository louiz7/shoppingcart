'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');

test('deployment pause serializes with new call reservations without ending existing calls',{
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async(t)=>{
    require('dotenv').config();
    const originalUrl=process.env.DATABASE_URL,url=new URL(originalUrl);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const schema=`recovery_deploy_${randomUUID().replaceAll('-','')}`;
    const {Client}=require('pg'),control=new Client({connectionString:originalUrl});
    await control.connect();
    await control.query(`CREATE SCHEMA ${schema}`);
    await control.query(`SET search_path TO ${schema},public`);
    await control.query(fs.readFileSync('migrations/029_recovery_deployment_guard.sql','utf8'));
    url.searchParams.set('options',`-c search_path=${schema},public`);
    url.searchParams.set('application_name',schema);
    process.env.DATABASE_URL=url.href;
    const {db,transaction}=require('../src/recovery/store'),service=require('../src/recovery/service');
    const policy=require('../src/recovery/policy'),shopify=require('../src/recovery/shopify'),telephony=require('../src/recovery/telephony');
    const tenantIds=[],previousLive=process.env.RECOVERY_LIVE_ENABLED;
    process.env.RECOVERY_LIVE_ENABLED='1';
    const dial=t.mock.method(telephony,'dial',async()=>({participantId:'synthetic'}));
    const hangup=t.mock.method(telephony,'hangup',async()=>{});
    t.mock.method(telephony,'configured',()=>true);
    t.mock.method(global,'fetch',async()=>{throw Error('External provider access forbidden');});
    t.mock.method(shopify,'refreshCheckout',async(shop,id)=>(await db.query('SELECT snapshot FROM recovery_checkouts WHERE shop_id=$1 AND external_id=$2',[shop.id,id])).rows[0].snapshot);
    t.after(async()=>{
        for(const id of tenantIds)await db.query('DELETE FROM customers WHERE id=$1',[id]);
        await db.pool.end();
        await control.query('ROLLBACK');
        await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();
        process.env.DATABASE_URL=originalUrl;
        if(previousLive===undefined)delete process.env.RECOVERY_LIVE_ENABLED;else process.env.RECOVERY_LIVE_ENABLED=previousLive;
    });
    async function fixture(){
        const id=randomUUID(),tenant=await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',[`Deployment ${id}`,`${id}@example.invalid`]);
        const customerId=tenant.rows[0].id;tenantIds.push(customerId);
        await require('./helpers/recovery-terms')(db,customerId);
        const rules=policy.rules({weekdays:[1,2,3,4,5,6,7],start:'00:00',end:'23:59'});
        const shop=(await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,enabled,approved_at,webhooks_ready,rules)
            VALUES($1,$2,$3,'Synthetic deploy','live',TRUE,NOW(),TRUE,$4) RETURNING *`,[id,customerId,`${id}.myshopify.com`,rules])).rows[0];
        const snapshot={id:'gid://shopify/AbandonedCheckout/123',updatedAt:new Date(Date.now()-7200000).toISOString(),completedAt:null,
            phone:'+4900000000001',currency:'EUR',subtotalCents:1000,discountCodes:[],checkoutUrl:`https://${shop.domain}/checkouts/synthetic`,items:[]};
        await transaction(client=>service.upsertCheckout(client,shop,snapshot));
        const checkout=(await db.query('SELECT id FROM recovery_checkouts WHERE shop_id=$1',[id])).rows[0];
        await service.consent(customerId,id,checkout.id,{verified:true,evidence:'Synthetic deployment-fence permission proof',
            consentedAt:new Date(Date.now()-86400000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),timezone:'Europe/Berlin'});
        await db.query("UPDATE recovery_contacts SET arm='treatment' WHERE shop_id=$1",[id]);
        return {customerId,shopId:id,checkoutId:checkout.id};
    }
    const f=await fixture();
    await control.query('BEGIN');
    await control.query('SELECT pg_advisory_xact_lock(72632026029)');
    await control.query("UPDATE recovery_deployment_guard SET paused_until=NOW()+INTERVAL '20 minutes' WHERE id=1");
    const pending=service.startCall(f.customerId,f.shopId,f.checkoutId).then(value=>({value}),error=>({error}));
    let waiting=false;
    for(let i=0;i<100;i++){
        const activity=await control.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",[schema]);
        if(activity.rowCount){waiting=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,true,'call reservation must wait for the same deployment lock');
    assert.equal(dial.mock.calls.length,0);
    await control.query('COMMIT');
    const result=await pending;
    assert.equal(result.error.code,'deployment_in_progress');assert.equal(result.error.status,503);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_calls WHERE shop_id=$1',[f.shopId])).rows[0].n,0);
    await control.query('UPDATE recovery_deployment_guard SET paused_until=NULL WHERE id=1');
    const started=await service.startCall(f.customerId,f.shopId,f.checkoutId);
    assert.equal(dial.mock.calls.length,1);assert.equal(started.status,'dialing');
    await control.query("UPDATE recovery_deployment_guard SET paused_until=NOW()+INTERVAL '20 minutes' WHERE id=1");
    await assert.rejects(service.startCall(f.customerId,f.shopId,f.checkoutId),error=>error.code==='deployment_in_progress' && error.status===503);
    assert.equal(hangup.mock.calls.length,0);
    assert.equal((await db.query('SELECT status FROM recovery_calls WHERE id=$1',[started.id])).rows[0].status,'dialing');
    assert.equal(dial.mock.calls.length,1);
    await control.query('DELETE FROM recovery_deployment_guard WHERE id=1');
    await assert.rejects(service.startCall(f.customerId,f.shopId,f.checkoutId),/deployment_in_progress/);
    await control.query("INSERT INTO recovery_deployment_guard(id,paused_until) VALUES(1,NOW()-INTERVAL '1 minute')");
    const expired=await fixture();
    assert.equal((await service.startCall(expired.customerId,expired.shopId,expired.checkoutId)).status,'dialing');
    assert.equal(dial.mock.calls.length,2);assert.equal(hangup.mock.calls.length,0);
});
