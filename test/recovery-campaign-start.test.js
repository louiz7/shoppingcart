'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('first live activation persists a stable start boundary without authorizing contacts',{skip:process.env.RECOVERY_DB_TEST!=='1'},async t=>{
    require('dotenv').config();const database=new URL(process.env.DATABASE_URL);
    assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55433');assert.equal(database.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store'),service=require('../src/recovery/service');
    t.mock.method(global,'fetch',async()=>{throw Error('External network forbidden');});
    const shopId=randomUUID(),customerId=(await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',['Synthetic campaign start',randomUUID()+'@example.invalid'])).rows[0].id;
    t.after(async()=>{await db.query('DELETE FROM customers WHERE id=$1',[customerId]);await db.pool.end();});
    await require('./helpers/recovery-terms')(db,customerId);
    await db.query("INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,webhooks_ready) VALUES($1,$2,$3,'Synthetic','live',true)",[shopId,customerId,shopId+'.myshopify.com']);
    const settings={brand:'Synthetic',brand_voice:'Friendly',enabled:false,approval:false,rules:{}};
    await service.saveSettings(customerId,shopId,settings);
    assert.equal((await service.shopFor(customerId,shopId)).campaign_started_at,null);
    await assert.rejects(service.saveSettings(customerId,shopId,{...settings,enabled:true}),/explicit_merchant_approval_required/);
    assert.equal((await service.shopFor(customerId,shopId)).campaign_started_at,null);
    const before=Date.now();
    await service.saveSettings(customerId,shopId,{...settings,enabled:true,approval:true});
    const first=(await service.shopFor(customerId,shopId)).campaign_started_at;
    assert.ok(+first>=before-100 && +first<=Date.now());
    await service.saveSettings(customerId,shopId,{...settings,enabled:true});
    await service.saveSettings(customerId,shopId,settings);
    await service.saveSettings(customerId,shopId,{...settings,enabled:true});
    assert.equal(+(await service.shopFor(customerId,shopId)).campaign_started_at,+first);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM recovery_contacts WHERE shop_id=$1',[shopId])).rows[0].n,0);
});
