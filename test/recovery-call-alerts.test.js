'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const alerts=require('../src/recovery/call-alerts');
const env=()=>({RECOVERY_CALL_ALERT_ENABLED:'1',RECOVERY_CALL_ALERT_SHOP_ID:randomUUID(),
    RECOVERY_CALL_ALERT_START_AT:new Date(Date.now()-60000).toISOString(),
    RECOVERY_CALL_ALERT_TO:'louiz@rescova.de',RECOVERY_DASHBOARD_URL:'https://recovery.example.invalid',
    GMAIL_CLIENT_ID:'synthetic-client',GMAIL_CLIENT_SECRET:'synthetic-secret',GMAIL_REFRESH_TOKEN:'synthetic-refresh'});

test('call alerts require explicit configuration, owner recipient and Gmail OAuth',()=>{
    assert.equal(alerts.config({}),null);
    const e=env(),c=alerts.config(e);
    assert.equal(c.to,'louiz@rescova.de');
    for(const [key,value] of [
        ['RECOVERY_CALL_ALERT_TO','a@example.invalid,b@example.invalid'],
        ['RECOVERY_CALL_ALERT_TO','wrong@example.invalid'],
        ['RECOVERY_CALL_ALERT_SHOP_ID','*'],['RECOVERY_CALL_ALERT_START_AT','2026-11-06'],
        ['RECOVERY_DASHBOARD_URL','http://recovery.example.invalid'],
        ['RECOVERY_DASHBOARD_URL','https://secret@recovery.example.invalid'],
        ['GMAIL_REFRESH_TOKEN',''],
    ])assert.throws(()=>alerts.config({...e,[key]:value}),/call_alert_config_invalid/);
});

test('call alert content contains no customer data or claims about answer or purchase',()=>{
    const call={id:randomUUID(),brand:'Shop\r\nBcc: injected',dialed_at:new Date(),is_test:true,
        phone:'+49111111111',summary:'Private conversation',snapshot:{checkoutUrl:'https://private.invalid'}};
    const m=alerts.message(call,alerts.config(env()));
    assert.match(m.subject,/Testanruf/);assert.doesNotMatch(m.subject,/[\r\n]/);
    assert.match(m.text,/noch kein verbundenes Gespräch/);
    for(const secret of [call.phone,call.summary,call.snapshot.checkoutUrl])assert.ok(!JSON.stringify(m).includes(secret));
});

test('email alerts select confirmed calls, isolate shops and claim once across retries and concurrent workers',{
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async t=>{
    require('dotenv').config();const url=new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store');
    const e=env(),prior={};for(const [k,v] of Object.entries(e)){prior[k]=process.env[k];process.env[k]=v;}
    const customer=(await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',
        ['Synthetic alerts',randomUUID()+'@example.invalid'])).rows[0].id;
    t.after(async()=>{
        for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
        await db.query('DELETE FROM customers WHERE id=$1',[customer]);await db.pool.end();
    });

    const shop=e.RECOVERY_CALL_ALERT_SHOP_ID,other=randomUUID();
    const fixtures={};
    for(const id of [shop,other]){
        await db.query("INSERT INTO recovery_shops(id,customer_id,domain,brand,mode) VALUES($1,$2,$3,'Synthetic','live')",[id,customer,id+'.myshopify.com']);
        await db.query("INSERT INTO recovery_contacts(shop_id,contact_key,phone) VALUES($1,'key','+49111111111')",[id]);
        const checkout=randomUUID();fixtures[id]=checkout;
        await db.query("INSERT INTO recovery_checkouts(id,shop_id,external_id,contact_key,source_updated_at) VALUES($1,$2,$3,'key',NOW())",[checkout,id,randomUUID()]);
    }
    async function call(shopId=shop,dialed=new Date(),status='ended',isTest=false){
        const id=randomUUID();await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,
            expires_at,status,dialed_at,is_test) VALUES($1,$2,$3,'key',$4,$5,NOW()+INTERVAL '1 hour',$6,$7,$8)`,
        [id,shopId,fixtures[shopId],'recovery-'+id,randomUUID(),status,dialed,isTest]);return id;
    }
    const sent=[];let fail=false,reject=false,wrongMailbox=false;
    const transport=t.mock.method(global,'fetch',async(url,options)=>{
        assert.equal(options.redirect,'error');
        if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-access',expires_in:3600});
        if(url==='https://gmail.googleapis.com/gmail/v1/users/me/profile')return Response.json({emailAddress:wrongMailbox ? 'other@example.invalid' : 'louiz@rescova.de'});
        assert.equal(url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
        const mime=Buffer.from(JSON.parse(options.body).raw,'base64url').toString();sent.push(mime);
        if(fail)throw Error('SECRET provider response');
        if(reject)return Response.json({error:'SECRET'},{status:403});
        return Response.json({id:'gmail-'+sent.length,threadId:'thread-'+sent.length});
    });
    await call(other);await call(shop,null);await call(shop,new Date(Date.now()-120000));
    await call(shop,new Date(),'simulated');await call(shop,new Date(Date.now()+60000));
    const first=await call(),second=await call(shop,new Date(),'ended',true);
    await Promise.all([alerts.tick(),alerts.tick()]);await alerts.tick();
    assert.equal(sent.length,2);assert.equal(new Set(sent.map(m=>m.match(/Message-ID: (.*)/)[1])).size,2);
    const receipt=await db.query('SELECT call_id,status FROM recovery_call_alerts WHERE call_id=ANY($1::uuid[])',[[first,second]]);
    assert.equal(receipt.rowCount,2);assert.ok(receipt.rows.every(r=>r.status==='accepted'));
    assert.ok(sent.some(m=>Buffer.from(m.match(/Subject: =\?UTF-8\?B\?(.*?)\?=/)[1],'base64').toString().includes('Testanruf')));
    fail=true;const failed=await call();await alerts.tick();await alerts.tick();
    assert.equal(sent.length,3);
    const uncertain=(await db.query('SELECT status,last_error FROM recovery_call_alerts WHERE call_id=$1',[failed])).rows[0];
    assert.deepEqual(uncertain,{status:'unknown',last_error:'gmail_result_unconfirmed'});
    assert.equal((await db.query('SELECT status FROM recovery_calls WHERE id=$1',[failed])).rows[0].status,'ended');
    const interrupted=await call();await db.query("INSERT INTO recovery_call_alerts(call_id,status,attempted_at) VALUES($1,'sending',NOW()-INTERVAL '3 minutes')",[interrupted]);
    await alerts.tick();assert.equal(sent.length,3);
    assert.equal((await db.query('SELECT status FROM recovery_call_alerts WHERE call_id=$1',[interrupted])).rows[0].status,'unknown');
    fail=false;reject=true;const rejected=await call();await alerts.tick();await alerts.tick();
    assert.equal(sent.length,4);
    assert.deepEqual((await db.query('SELECT status,last_error FROM recovery_call_alerts WHERE call_id=$1',[rejected])).rows[0],
        {status:'failed',last_error:'gmail_rejected'});
    reject=false;wrongMailbox=true;const blocked=await call();
    await assert.rejects(alerts.tick(),/Gmail must be connected/);
    assert.equal((await db.query('SELECT 1 FROM recovery_call_alerts WHERE call_id=$1',[blocked])).rowCount,0);
    assert.equal(sent.length,4);
    const before=transport.mock.callCount();process.env.RECOVERY_CALL_ALERT_ENABLED='0';
    assert.deepEqual(await alerts.tick(),{attempted:0});assert.equal(transport.mock.callCount(),before);
});
