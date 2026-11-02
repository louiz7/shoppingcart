'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID,createHash } = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

test('organizations isolate registrations, sessions, internal statistics and authoritative durations', {
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async(t)=>{
    require('dotenv').config();
    const url=new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store');
    const org=require('../src/recovery/organizations'),policy=require('../src/recovery/policy'),hooks=require('../src/recovery/webhooks');
    const ids=[],subjects=[],addresses=[];
    const password='Synthetic test password 927!';
    const env={RECOVERY_ONLY:'1'};
    const typescript=require('../dashboard/node_modules/typescript');
    function moduleAt(path,imports){
        const output=typescript.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:typescript.ModuleKind.CommonJS,target:typescript.ScriptTarget.ES2022}}).outputText;
        const module={exports:{}};
        vm.runInNewContext(output,{module,exports:module.exports,Buffer,process,URL,Date,
            require:(name)=>Object.hasOwn(imports,name)?imports[name]:require(name)},{filename:path});
        return module.exports;
    }
    const auth=moduleAt('dashboard/src/lib/server/auth.ts',{'./db':{db},'$env/dynamic/private':{env}});
    const previousSecret=process.env.INTERNAL_TOOL_SECRET;
    process.env.INTERNAL_TOOL_SECRET='synthetic-organization-test-secret';
    t.after(async()=>{
        for(const id of ids)await db.query('DELETE FROM customers WHERE id=$1',[id]);
        for(const value of [...subjects,...addresses])await db.query('DELETE FROM recovery_auth_attempts WHERE subject_hash=$1',[createHash('sha256').update(value).digest('hex')]);
        if(previousSecret===undefined)delete process.env.INTERNAL_TOOL_SECRET;else process.env.INTERNAL_TOOL_SECRET=previousSecret;
        await db.pool.end();
    });
    const prefix=randomUUID().slice(0,4);
    function registration(){
        const email=`organization-${randomUUID()}@example.invalid`,clientAddress=`2001:db8:${prefix}::${addresses.length+1}`;
        subjects.push(email);addresses.push(clientAddress);
        return {organizationName:`Synthetic Recovery ${randomUUID()}`,displayName:'Synthetic Owner',email,password,clientAddress};
    }
    async function account(){const input=registration(),result=await org.register(input);ids.push(result.customerId);return {...result,input};}
    function cookies(){const values=new Map();return {values,options:null,get:(key)=>values.get(key),set(key,value,options){values.set(key,value);this.options=options;},delete:(key)=>values.delete(key)};}
    async function shop(owner,currency){const id=randomUUID();await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,currency,mode)
        VALUES($1,$2,$3,'Synthetic overview shop',$4,'live')`,[id,owner.customerId,`${id}.myshopify.com`,currency]);return id;}
    async function checkout(shopId,currency){const id=randomUUID(),external=`gid://shopify/AbandonedCheckout/${Math.floor(Math.random()*1e14)}`,phone='+4900000000007',key=policy.contactKey(shopId,phone);
        await db.query(`INSERT INTO recovery_contacts(shop_id,contact_key,phone) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[shopId,key,phone]);
        await db.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,contact_key,currency,source_updated_at) VALUES($1,$2,$3,$4,$5,NOW()-INTERVAL '2 hours')`,[id,shopId,external,key,currency]);
        return {id,external,key};}
    async function call(shopId,checkout,status='ended',isTest=false){const id=randomUUID();await db.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,dialed_at,connected_at,is_test)
        VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '1 hour',$7,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour',$8)`,[id,shopId,checkout.id,checkout.key,`recovery-${id}`,randomUUID(),status,isTest]);return id;}
    async function order(shopId,checkout,currency,amount,isTest=false){await db.query(`INSERT INTO recovery_orders(shop_id,external_id,checkout_external_id,currency,paid,net_cents,source_updated_at,ordered_at,paid_at,is_test)
        VALUES($1,$2,$3,$4,TRUE,$5,NOW(),NOW(),NOW(),$6)`,[shopId,randomUUID(),checkout.external,currency,amount,isTest]);}

    await t.test('public owners receive new organizations and cannot select internal privileges',async()=>{
        const input=registration();
        for(const extra of [{is_rescova_internal:true},{customerId:1},{role:'admin'}])await assert.rejects(org.register({...input,...extra}),/invalid_organization_registration/);
        await assert.rejects(org.register({...input,password:'short'}),/invalid_organization_registration/);
        const owner=await account();
        const row=(await db.query('SELECT u.password_hash,u.role,c.is_rescova_internal FROM platform_users u JOIN customers c ON c.id=u.customer_id WHERE u.id=$1',[owner.userId])).rows[0];
        assert.equal(row.role,'admin');assert.equal(row.is_rescova_internal,false);assert.notEqual(row.password_hash,password);
        assert.equal(await org.verifyPassword(password,row.password_hash),true);assert.equal(await org.verifyPassword('wrong',row.password_hash),false);
        await assert.rejects(org.register(owner.input),/organization_registration_unavailable/);
        await assert.rejects(org.register({...owner.input,email:owner.input.email.toUpperCase()}),/organization_registration_unavailable/);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM customers WHERE email=$1',[owner.input.email])).rows[0].n,1);
        assert.equal((await org.login({...owner.input,email:owner.input.email.toUpperCase()})).isRecoveryInternal,false);
        await assert.rejects(org.overview(owner.customerId,owner.userId),/forbidden/);
        const claim={...registration(),email:'milan@rescova.de'};
        subjects.push(claim.email);
        if((await db.query('SELECT 1 FROM platform_users WHERE LOWER(email)=$1',[claim.email])).rowCount) {
            await assert.rejects(org.register(claim),/organization_registration_unavailable/);
        } else {
            const claimed=await org.register(claim);ids.push(claimed.customerId);
            assert.equal((await org.login(claim)).isRecoveryInternal,false);
            const jar=cookies();await auth.createSession(claimed.userId,jar);
            const user=await auth.getSessionUser(jar);assert.equal(user.isRescovaAdminOrganization,false);assert.equal(user.isRecoveryInternal,false);
        }
    });

    await t.test('IP and email throttles persist in PostgreSQL rather than process memory',async()=>{
        const owner=await account();
        for(let i=0;i<9;i++)await assert.rejects(org.login({...owner.input,password:'wrong password'}),/invalid_login/);
        await assert.rejects(org.login({...owner.input,password:'wrong password'}),/invalid_login/);
        await assert.rejects(org.login(owner.input),/login_rate_limited/);
        const row=(await db.query(`SELECT attempts FROM recovery_auth_attempts WHERE kind='login_email' AND subject_hash=$1`,[createHash('sha256').update(owner.input.email).digest('hex')])).rows[0];
        assert.equal(row.attempts,11);
        const input=registration();
        for(let i=0;i<5;i++){const attempt={...input,organizationName:`Synthetic rate ${randomUUID()}`,email:`ip-${randomUUID()}@example.invalid`};subjects.push(attempt.email);const result=await org.register(attempt);ids.push(result.customerId);}
        await assert.rejects(org.register({...input,email:`ip-last-${randomUUID()}@example.invalid`}),/registration_rate_limited/);
    });

    await t.test('session cookies bind active user and organization; email names never confer internal rights',async()=>{
        const owner=await account(),jar=cookies();
        await auth.createSession(owner.userId,jar);
        assert.equal(jar.options.httpOnly,true);assert.equal(jar.options.sameSite,'lax');assert.equal(jar.options.path,'/');
        const stored=(await db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1',[owner.userId])).rows[0].token_hash;
        assert.notEqual(stored,jar.get('rescova_session'));
        let user=await auth.getSessionUser(jar);assert.equal(user.customerId,owner.customerId);assert.equal(user.organizationName,owner.input.organizationName);
        assert.equal(user.isRecoveryInternal,false);assert.equal(user.isRescovaAdminOrganization,false);
        assert.doesNotMatch(fs.readFileSync('dashboard/src/lib/server/auth.ts','utf8'),/milan@rescova\.de/);
        await db.query('UPDATE customers SET is_rescova_internal=TRUE WHERE id=$1',[owner.customerId]);
        user=await auth.getSessionUser(jar);assert.equal(user.isRecoveryInternal,true);assert.equal(user.isRescovaAdminOrganization,true);
        await db.query(`UPDATE platform_users SET role='viewer' WHERE id=$1`,[owner.userId]);
        assert.equal((await auth.getSessionUser(jar)).isRecoveryInternal,false);
        await assert.rejects(org.overview(owner.customerId,owner.userId),/forbidden/);
        await db.query('UPDATE customers SET is_active=FALSE WHERE id=$1',[owner.customerId]);
        assert.equal(await auth.getSessionUser(jar),null);assert.equal(jar.get('rescova_session'),undefined);
        assert.equal(auth.recoveryDestination({isRecoveryInternal:true}),'/recovery/organizations');
        for(const unsafe of ['https://evil.example','//evil.example','/\\evil.example','/campaigns','/'])assert.equal(auth.recoveryDestination({isRecoveryInternal:false},unsafe),'/recovery');
        assert.equal(auth.recoveryDestination({isRecoveryInternal:false},'/recovery/settings'),'/recovery/settings');
    });

    await t.test('internal overview deduplicates exact checkout revenue and separates currencies and unknown durations',async()=>{
        const internal=await account(),a=await account(),b=await account();
        await db.query('UPDATE customers SET is_rescova_internal=TRUE WHERE id=$1',[internal.customerId]);
        await assert.rejects(org.overview(a.customerId,internal.userId),/forbidden/);
        const eur=await shop(a,'EUR'),usd=await shop(a,'USD'),other=await shop(b,'USD');
        const ec=await checkout(eur,'EUR'),uc=await checkout(usd,'USD'),oc=await checkout(other,'USD');
        const known=await call(eur,ec);await call(eur,ec);await call(eur,ec,'simulated');await call(usd,uc);await call(other,oc,'ended',true);
        await order(eur,ec,'EUR',1000);await order(eur,ec,'EUR',9000,true);await order(usd,uc,'USD',2200);await order(other,oc,'USD',3300);
        const at=Math.floor(Date.now()/1000)-3600;
        await hooks.lifecycle({event:'participant_joined',room:{name:`recovery-${known}`},participant:{kind:3,attributes:{'sip.callStatus':'active'}},createdAt:at});
        await hooks.lifecycle({event:'participant_left',room:{name:`recovery-${known}`},participant:{kind:3},createdAt:at+60});
        await hooks.lifecycle({event:'room_finished',room:{name:`recovery-${known}`},createdAt:at+120});
        await hooks.lifecycle({event:'participant_left',room:{name:`recovery-${known}`},participant:{kind:3},createdAt:at+180});
        assert.equal(Number((await db.query('SELECT confirmed_duration_seconds FROM recovery_calls WHERE id=$1',[known])).rows[0].confirmed_duration_seconds),60);
        const summary=await org.overview(internal.customerId,internal.userId),group=summary.organizations.find(value=>value.id===a.customerId);
        assert.equal(group.shops.length,2);
        const euro=group.shops.find(value=>value.id===eur),dollar=group.shops.find(value=>value.id===usd);
        assert.equal(euro.calls,2);assert.equal(euro.connectedMinutes,1);assert.equal(euro.unknownDurationCalls,1);assert.equal(euro.attributedRevenueCents,1000);assert.equal(euro.confirmedOrders,1);
        assert.equal(dollar.attributedRevenueCents,2200);assert.equal(dollar.unknownDurationCalls,1);
        assert.equal(summary.organizations.find(value=>value.id===b.customerId).shops[0].attributedRevenueCents,0);
        assert.deepEqual(summary.totals.attributedRevenue.map(value=>value.currency),['EUR','USD']);
        assert.doesNotMatch(JSON.stringify(summary),/password_hash|phone|credentials_encrypted|token_hash|synthetic@example/);
        const token=randomUUID();await db.query('UPDATE recovery_checkouts SET checkout_token=$2 WHERE id=$1',[uc.id,token]);
        await hooks.ingestShopify({id:usd,currency:'USD'},'orders/paid',{id:'token-only-proof',checkout_token:token,currency:'USD',financial_status:'paid',
            current_subtotal_price:'15.00',created_at:new Date().toISOString(),updated_at:new Date().toISOString()},randomUUID());
        await db.query('UPDATE recovery_orders SET checkout_token=NULL WHERE shop_id=$1',[usd]);
        await db.query('UPDATE recovery_checkouts SET checkout_token=NULL WHERE id=$1',[uc.id]);
        const retained=(await org.overview(internal.customerId,internal.userId)).organizations.find(value=>value.id===a.customerId).shops.find(value=>value.id===usd);
        assert.equal(retained.attributedRevenueCents,3700);assert.equal(retained.confirmedOrders,2);
    });

    await t.test('organization router requires loopback secret and a database-bound internal actor',async()=>{
        const express=require('express'),owner=await account();const app=express();app.use('/internal/recovery/organizations',express.json({limit:'4kb'}),org.router);
        const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
        try{const base=`http://127.0.0.1:${server.address().port}/internal/recovery/organizations`;
            assert.equal((await fetch(`${base}/overview`)).status,401);
            const response=await fetch(`${base}/overview`,{headers:{'x-internal-secret':process.env.INTERNAL_TOOL_SECRET,'x-customer-id':String(owner.customerId),'x-user-id':String(owner.userId)}});
            assert.equal(response.status,403);assert.equal(response.headers.get('cache-control'),'no-store');
        }finally{await new Promise(resolve=>server.close(resolve));}
    });

    await t.test('recovery-only hooks block legacy routes while keeping framework assets and signup reachable',async()=>{
        const kit={redirect:(status,location)=>{throw {status,location};},error:(status,message)=>{throw {status,message};}};
        const hooks=moduleAt('dashboard/src/hooks.server.ts',{'@sveltejs/kit':kit,'$lib/server/auth':{getSessionUser:async()=>null,recoveryDestination:auth.recoveryDestination},'$env/dynamic/private':{env}});
        const event=(path)=>({url:new URL(`http://localhost${path}`),request:{method:'GET'},locals:{},cookies:cookies()});
        for(const path of ['/campaigns','/admin/organizations','/email'])await assert.rejects(hooks.handle({event:event(path),resolve:()=>true}),error=>error.status===404);
        for(const path of ['/register','/login','/_app/immutable/code.js','/figma/logo.svg'])assert.equal(await hooks.handle({event:event(path),resolve:()=>true}),true);
        await assert.rejects(hooks.handle({event:event('/recovery'),resolve:()=>true}),error=>error.status===303 && error.location.startsWith('/login?next='));
    });
});
