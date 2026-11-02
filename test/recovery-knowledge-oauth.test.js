'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHmac}=require('node:crypto');

test('OAuth reports an ungranted knowledge upgrade without discarding the valid basic connection',{
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async t=>{
    require('dotenv').config();
    const database=new URL(process.env.DATABASE_URL);
    assert.equal(database.hostname,'127.0.0.1');assert.equal(database.port,'55433');assert.equal(database.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store'),shopify=require('../src/recovery/shopify');
    const {startOAuth,oauthRouter}=require('../src/recovery/routes');
    const extra=['read_legal_policies','read_metaobjects','read_metaobject_definitions'];
    const env={SHOPIFY_CLIENT_ID:'synthetic-knowledge-client',SHOPIFY_CLIENT_SECRET:'synthetic-knowledge-secret',
        SHOPIFY_CREDENTIALS_KEY:'55'.repeat(32),RECOVERY_SHOPIFY_CUSTOM_DOMAIN:'',
        SHOPIFY_KNOWLEDGE_SCOPES:extra.join(','),RECOVERY_SHOPIFY_REDIRECT_URI:'https://example.invalid/callback'};
    const before=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
    const domain=`${randomUUID()}.myshopify.com`;
    const tenant=(await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',['Synthetic OAuth knowledge',`${randomUUID()}@example.invalid`])).rows[0].id;
    let scopes=shopify.SCOPES;
    t.mock.method(shopify,'exchangeAuthorizationCode',async()=>({...shopify.offlineCredentials({access_token:'synthetic-access',
        refresh_token:'synthetic-refresh',expires_in:3600,refresh_token_expires_in:86400,scope:scopes.join(',')}),app_client_id:env.SHOPIFY_CLIENT_ID}));
    t.mock.method(shopify,'graphql',async()=>({shop:{name:'Synthetic',primaryDomain:{host:'example.invalid'},currencyCode:'EUR'}}));
    t.mock.method(shopify,'registerWebhooks',async()=>{});
    const nativeFetch=global.fetch;
    t.mock.method(global,'fetch',async()=>{throw Error('External network forbidden');});
    const app=require('express')();app.use('/integrations/recovery/shopify',oauthRouter);
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    t.after(async()=>{
        await new Promise(r=>server.close(r));await db.query('DELETE FROM customers WHERE id=$1',[tenant]);await db.pool.end();
        for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    });
    async function callback(){
        const url=new URL((await startOAuth(tenant,domain)).url);
        assert.ok(extra.every(s=>url.searchParams.get('scope').split(',').includes(s)));
        const params=new URLSearchParams({shop:domain,code:'synthetic-code',state:url.searchParams.get('state'),timestamp:String(Math.floor(Date.now()/1000))});
        const signed=[...params].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('&');
        params.set('hmac',createHmac('sha256',env.SHOPIFY_CLIENT_SECRET).update(signed).digest('hex'));
        return nativeFetch(`http://127.0.0.1:${server.address().port}/integrations/recovery/shopify/callback?${params}`,{redirect:'manual'});
    }
    for(const granted of [shopify.SCOPES,[...shopify.SCOPES,...extra.slice(0,2)]]){
        scopes=granted;const result=await callback();
        assert.equal(result.status,409);assert.equal(result.headers.get('location'),null);
        assert.deepEqual(await result.json(),{error:'shopify_knowledge_scopes_missing'});
        const saved=(await db.query('SELECT * FROM recovery_shops WHERE domain=$1',[domain])).rows[0];
        assert.deepEqual(saved.scopes,granted);assert.ok(saved.credentials_encrypted);assert.equal(saved.enabled,false);
    }
    scopes=[...shopify.SCOPES,...extra];const success=await callback();
    assert.equal(success.status,303);assert.equal(new URL(success.headers.get('location')).pathname,'/recovery');
    assert.deepEqual((await db.query('SELECT scopes FROM recovery_shops WHERE domain=$1',[domain])).rows[0].scopes,scopes);
});
