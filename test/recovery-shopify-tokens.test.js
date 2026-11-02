'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const shopify=require('../src/recovery/shopify');

const response=()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,
    refresh_token_expires_in:7776000,scope:shopify.SCOPES.join(',')});

test('expiring offline token metadata uses provider lifetimes and rejects incomplete responses',()=>{
    const now=Date.parse('2026-11-02T12:00:00Z'),credentials=shopify.offlineCredentials(response(),now);
    assert.equal(credentials.expires_at,'2026-11-02T13:00:00.000Z');
    assert.equal(Date.parse(credentials.refresh_token_expires_at)-now,7776000*1000);
    for(const value of [{...response(),refresh_token:undefined},{...response(),expires_in:0},
        {...response(),expires_in:'3600'},{...response(),refresh_token_expires_in:-1}])assert.throws(()=>shopify.offlineCredentials(value),/shopify_expiring_token_response_invalid/);
});

test('offline Shopify migration, refresh and OAuth share durable per-shop serialization',{
    skip:process.env.RECOVERY_DB_TEST!=='1',timeout:30000,
},async(t)=>{
    require('dotenv').config();
    const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55433');assert.equal(url.pathname,'/shoppingcart');
    const {db}=require('../src/recovery/store'),{decryptShopifyCredentials}=require('../src/services/shopify-crypto');
    const keys=['SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_CREDENTIALS_KEY'];
    const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]])),customers=[];
    Object.assign(process.env,{SHOPIFY_CLIENT_ID:'synthetic-client',SHOPIFY_CLIENT_SECRET:'synthetic-secret',SHOPIFY_CREDENTIALS_KEY:'33'.repeat(32)});
    let handler;
    t.mock.method(global,'fetch',(...args)=>handler(...args));
    t.after(async()=>{for(const id of customers)await db.query('DELETE FROM customers WHERE id=$1',[id]);await db.pool.end();
        for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
    async function fixture(credentials='synthetic-legacy'){
        const id=randomUUID(),tenant=await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',[`Token ${id}`,`${id}@example.invalid`]);
        customers.push(tenant.rows[0].id);
        return (await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode,credentials_encrypted)
            VALUES($1,$2,$3,'Synthetic token shop','live',$4) RETURNING *`,[id,tenant.rows[0].id,`${id}.myshopify.com`,shopify.encryptToken(credentials)])).rows[0];
    }
    async function stored(shop){return decryptShopifyCredentials((await db.query('SELECT credentials_encrypted FROM recovery_shops WHERE id=$1',[shop.id])).rows[0].credentials_encrypted);}

    await t.test('concurrent legacy callers migrate once and persist the encrypted pair before GraphQL',async()=>{
        const shop=await fixture();let grants=0,queries=0;
        handler=async(url,options)=>{
            assert.equal(options.redirect,'error');
            if(url.endsWith('/admin/oauth/access_token')){
                grants++;const body=new URLSearchParams(options.body);
                assert.equal(body.get('grant_type'),'urn:ietf:params:oauth:grant-type:token-exchange');
                assert.equal(body.get('subject_token'),'synthetic-legacy');assert.equal(body.get('expiring'),'1');
                assert.equal(body.get('subject_token_type'),'urn:shopify:params:oauth:token-type:offline-access-token');
                assert.equal(body.get('requested_token_type'),'urn:shopify:params:oauth:token-type:offline-access-token');
                await new Promise(resolve=>setTimeout(resolve,20));return Response.json(response());
            }
            queries++;assert.equal(options.headers['X-Shopify-Access-Token'],'synthetic-access');
            assert.equal((await stored(shop)).refresh_token,'synthetic-refresh');return Response.json({data:{ok:true}});
        };
        await Promise.all([shopify.graphql(shop,'query A { shop { id } }'),shopify.graphql(shop,'query B { shop { id } }')]);
        assert.equal(grants,1);assert.equal(queries,2);
        const encrypted=(await db.query('SELECT credentials_encrypted FROM recovery_shops WHERE id=$1',[shop.id])).rows[0].credentials_encrypted;
        assert.doesNotMatch(encrypted,/synthetic-access|synthetic-refresh/);
    });

    await t.test('expired access refreshes once using the latest stored refresh token across stale callers',async()=>{
        const credentials=shopify.offlineCredentials(response());credentials.expires_at=new Date(Date.now()-1000).toISOString();
        const shop=await fixture(credentials);let grants=0;
        handler=async(url,options)=>{
            if(url.endsWith('/admin/oauth/access_token')){
                grants++;const body=new URLSearchParams(options.body);assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'synthetic-refresh');
                return Response.json({...response(),access_token:'refreshed-access',refresh_token:'rotated-refresh'});
            }
            assert.equal(options.headers['X-Shopify-Access-Token'],'refreshed-access');return Response.json({data:{ok:true}});
        };
        await Promise.all([shopify.graphql(shop,'query A { shop { id } }'),shopify.graphql(shop,'query B { shop { id } }')]);
        assert.equal(grants,1);assert.equal((await stored(shop)).refresh_token,'rotated-refresh');
    });

    await t.test('lost migration response preserves the original token for documented recovery',async()=>{
        const shop=await fixture();let grants=0;
        handler=async(url,options)=>{
            if(url.endsWith('/admin/oauth/access_token')){grants++;assert.equal(new URLSearchParams(options.body).get('subject_token'),'synthetic-legacy');
                if(grants===1)throw Error('synthetic secret must not leak');return Response.json(response());}
            return Response.json({data:{ok:true}});
        };
        await assert.rejects(shopify.graphql(shop,'query A { shop { id } }'),error=>error.code==='shopify_token_service_unavailable' && !error.message.includes('secret'));
        assert.equal((await stored(shop)).access_token,'synthetic-legacy');assert.equal(grants,1);
        assert.deepEqual(await shopify.graphql(shop,'query A { shop { id } }'),{ok:true});assert.equal(grants,2);
    });

    await t.test('terminal refresh errors stop further refresh requests until reauthorization',async()=>{
        const credentials=shopify.offlineCredentials(response());credentials.expires_at=new Date(Date.now()-1000).toISOString();
        const shop=await fixture(credentials);let requests=0;
        handler=async()=>{requests++;return Response.json({error:'invalid_request',error_description:'private provider data'},{status:401});};
        await assert.rejects(shopify.graphql(shop,'query A { shop { id } }'),/shopify_reauthorization_required/);
        await assert.rejects(shopify.graphql(shop,'query A { shop { id } }'),/shopify_reauthorization_required/);
        assert.equal(requests,1);assert.equal((await stored(shop)).reauthorization_required,true);
    });

    await t.test('foreign tenant, missing refresh token and ambiguous GraphQL mutations fail closed without retries',async()=>{
        const shop=await fixture(shopify.offlineCredentials(response()));let requests=0;
        handler=async()=>{requests++;throw Error('synthetic ambiguous mutation');};
        await assert.rejects(shopify.graphql({...shop,customer_id:shop.customer_id+99999},'query A { shop { id } }'),/shop_not_connected/);
        assert.equal(requests,0);
        await assert.rejects(shopify.graphql(shop,'mutation A { synthetic }'),/synthetic ambiguous mutation/);
        assert.equal(requests,1);
        const legacy=await fixture();requests=0;handler=async()=>{requests++;return Response.json({access_token:'incomplete'});};
        await assert.rejects(shopify.graphql(legacy,'mutation A { synthetic }'),/shopify_expiring_token_response_invalid/);
        assert.equal(requests,1);assert.equal((await stored(legacy)).access_token,'synthetic-legacy');
    });

    await t.test('authorization-code grants explicitly request expiring offline tokens',async()=>{
        handler=async(url,options)=>{assert.equal(url,'https://synthetic.myshopify.com/admin/oauth/access_token');
            const body=new URLSearchParams(options.body);assert.equal(body.get('code'),'synthetic-code');assert.equal(body.get('expiring'),'1');
            assert.equal(body.get('client_id'),'synthetic-client');return Response.json(response());};
        const credentials=await shopify.exchangeAuthorizationCode('synthetic.myshopify.com','synthetic-code');
        assert.equal(credentials.refresh_token,'synthetic-refresh');assert.ok(Date.parse(credentials.expires_at)>Date.now());
    });
});
