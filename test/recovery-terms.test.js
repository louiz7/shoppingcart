'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');

test('merchant terms require a current, explicit, tenant-bound admin acceptance',{skip:process.env.RECOVERY_DB_TEST!=='1'},async t=>{
    require('dotenv').config();const url=new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store'),terms=require('../src/recovery/terms'),service=require('../src/recovery/service');
    const tenants=[];
    t.after(async()=>{for(const id of tenants)await db.query('DELETE FROM customers WHERE id=$1',[id]);await db.pool.end();});
    t.mock.method(global,'fetch',async()=>{throw Error('No external requests in terms test');});
    async function fixture(){
        const customerId=(await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',['Synthetic terms '+randomUUID(),`${randomUUID()}@example.invalid`])).rows[0].id;
        tenants.push(customerId);
        const userId=(await db.query(`INSERT INTO platform_users(customer_id,email,display_name,password_hash,role)
            VALUES($1,$2,'Synthetic admin','not-a-real-password','admin') RETURNING id`,[customerId,`${randomUUID()}@example.invalid`])).rows[0].id;
        const shopId=randomUUID();
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,webhooks_ready)
            VALUES($1,$2,$3,'Synthetic','live',TRUE)`,[shopId,customerId,`${randomUUID()}.myshopify.com`]);
        return {customerId,userId,shopId};
    }
    const a=await fixture(),b=await fixture(),input={accepted:true,version:terms.document.version,hash:terms.hash};
    const settings={brand:'Synthetic',brand_voice:'Friendly',enabled:true,approval:true,rules:{}};
    assert.equal((await terms.status(a.customerId)).acceptedAt,null);
    await assert.rejects(service.saveSettings(a.customerId,a.shopId,settings),{code:'terms_acceptance_required'});
    await assert.rejects(terms.accept(a.customerId,b.userId,input),{code:'admin_required'});
    await assert.rejects(terms.accept(a.customerId,a.userId,{...input,accepted:'true'}),{code:'terms_acceptance_required'});
    await assert.rejects(terms.accept(a.customerId,a.userId,{...input,version:'old'}),{code:'terms_version_changed'});
    await assert.rejects(terms.accept(a.customerId,a.userId,{...input,hash:'0'.repeat(64)}),{code:'terms_version_changed'});
    await db.query("UPDATE platform_users SET role='viewer' WHERE id=$1",[a.userId]);
    await assert.rejects(terms.accept(a.customerId,a.userId,input),{code:'admin_required'});
    await db.query("UPDATE platform_users SET role='admin',active=FALSE WHERE id=$1",[a.userId]);
    await assert.rejects(terms.accept(a.customerId,a.userId,input),{code:'admin_required'});
    await db.query('UPDATE platform_users SET active=TRUE WHERE id=$1',[a.userId]);
    await db.query('UPDATE customers SET is_active=FALSE WHERE id=$1',[a.customerId]);
    await assert.rejects(terms.accept(a.customerId,a.userId,input),{code:'admin_required'});
    await db.query('UPDATE customers SET is_active=TRUE WHERE id=$1',[a.customerId]);
    const accepted=await terms.accept(a.customerId,a.userId,input);
    assert.ok(accepted.acceptedAt);assert.equal((await terms.status(b.customerId)).acceptedAt,null);
    assert.deepEqual(await terms.accept(a.customerId,a.userId,input),accepted);
    const {rows}=await db.query('SELECT * FROM recovery_terms_acceptances WHERE customer_id=$1',[a.customerId]);
    assert.equal(rows.length,1);assert.equal(rows[0].accepted_by,Number(a.userId));
    assert.equal(createHash('sha256').update(rows[0].document_text).digest('hex'),terms.hash);
    assert.deepEqual(JSON.parse(rows[0].document_text),terms.document);
    assert.equal((await service.shopFor(a.customerId,a.shopId)).terms_current,true);
    assert.equal((await service.saveSettings(a.customerId,a.shopId,settings)).saved,true);
    await db.query("UPDATE recovery_terms_acceptances SET document_hash=$2 WHERE customer_id=$1",[a.customerId,'0'.repeat(64)]);
    assert.equal((await service.shopFor(a.customerId,a.shopId)).terms_current,false);
    await assert.rejects(service.saveSettings(a.customerId,a.shopId,settings),{code:'terms_acceptance_required'});
    assert.equal((await service.saveSettings(a.customerId,a.shopId,{...settings,enabled:false})).saved,true);
    await db.query(`INSERT INTO recovery_terms_acceptances(id,customer_id,version,document_hash,document_text,actor_name,source,evidence)
        VALUES($1,$2,$3,$4,$5,'Synthetic recorder','external','Synthetic offline acceptance reported by operator')`,
        [randomUUID(),b.customerId,terms.document.version,terms.hash,JSON.stringify(terms.document)]);
    const external=await terms.status(b.customerId);
    assert.equal(external.source,'external');assert.ok(external.acceptedAt);
    assert.equal((await service.shopFor(b.customerId,b.shopId)).terms_current,true);
    assert.equal((await db.query('SELECT accepted_by FROM recovery_terms_acceptances WHERE customer_id=$1',[b.customerId])).rows[0].accepted_by,null);
    assert.equal((await service.shopFor(a.customerId,a.shopId)).terms_current,false);
});

test('a terms acceptance never replaces individual contact consent, including owner tests',()=>{
    const policy=require('../src/recovery/policy');
    const ctx={shop:{mode:'live',enabled:true,approved_at:new Date(),rules:{},terms_current:false},checkout:{},contact:{}};
    assert.equal(policy.eligibility(ctx,new Date(),'call',true),'terms_acceptance_required');
    ctx.shop.terms_current=true;
    assert.equal(policy.eligibility(ctx,new Date(),'call',true),'consent_missing');
});
