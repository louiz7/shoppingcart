'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const knowledge = require('../src/recovery/knowledge');
const shopify = require('../src/recovery/shopify');
const id = 'gid://shopify/ProductVariant/1';
const shop = (scopes=[]) => ({id:randomUUID(),customer_id:1,domain:'synthetic.myshopify.com',mode:'live',scopes});
const field = (key,value,type='single_line_text_field',access='PUBLIC_READ') => ({namespace:'custom',key,type,value,
    definition:{name:key,access:{storefront:access}}});
const node = () => ({id,title:'M / Black',selectedOptions:[{name:'Size',value:'M'}],
    metafields:{nodes:[field('care','Wash at 30°C')]},inventoryItem:{requiresShipping:true,measurement:{weight:{value:0.4,unit:'KILOGRAMS'}}},
    product:{id:'gid://shopify/Product/1',title:'Shirt',description:'A cotton shirt.',vendor:'Example',status:'ACTIVE',
        publishedAt:'2026-01-01T00:00:00Z',options:[{name:'Size',values:['M','L']}],
        metafields:{nodes:[field('material','100% cotton'),field('supplier_cost','PRIVATE','number_decimal','NONE'),
            {...field('undefined_field','PRIVATE'),definition:null}]}}});

test('product knowledge exposes public product/variant evidence, caches concurrent reads and stays tenant scoped',async t=>{
    const query=t.mock.method(shopify,'graphql',async()=>({node:node()}));
    const s=shop();
    const [a,b]=await Promise.all([knowledge.product(s,id),knowledge.product(s,id)]);
    assert.deepEqual(a,b);assert.equal(query.mock.calls.length,1);
    assert.equal(a.status,'loaded');assert.equal(a.weight.value,0.4);
    assert.deepEqual(a.attributes.map(a=>[a.owner,a.value]),[['product','100% cotton'],['variant','Wash at 30°C']]);
    assert.doesNotMatch(JSON.stringify(a),/PRIVATE|supplier_cost|undefined_field/);
    await knowledge.product({...s,id:randomUUID()},id);assert.equal(query.mock.calls.length,2);
    await knowledge.product({...s,customer_id:2},id);assert.equal(query.mock.calls.length,3);
    await knowledge.product({...s,scopes:['read_metaobjects']},id);assert.equal(query.mock.calls.length,4);
    await assert.rejects(knowledge.product(s,'https://evil.example/1'),/invalid_product_variant/);
    assert.equal(query.mock.calls.length,4);
});

test('private, draft, deleted and mismatched products are never usable evidence',async t=>{
    let value=node(); t.mock.method(shopify,'graphql',async()=>({node:value}));
    for(const alter of [()=>{value.product.status='DRAFT';},()=>{value.product.publishedAt=null;},
        ()=>{value.product.publishedAt='2999-01-01';},()=>{value.id='gid://shopify/ProductVariant/999';},()=>{value=null;}]) {
        value=node();alter();assert.equal((await knowledge.product(shop(),id)).status,'not_public');
    }
});

test('metaobjects resolve only explicit public references, public definitions and active entries',async t=>{
    const n=node();
    n.product.metafields.nodes.push(field('details',JSON.stringify(['gid://shopify/Metaobject/1','gid://shopify/Metaobject/2',
        'gid://shopify/Metaobject/3']),'list.metaobject_reference'));
    n.product.metafields.nodes.push(field('private_reference','gid://shopify/Metaobject/4','metaobject_reference','NONE'));
    const query=t.mock.method(shopify,'graphql',async(_s,q,args)=>{
        if(q.includes('RecoveryProductKnowledge'))return {node:n};
        assert.deepEqual(args.ids,['gid://shopify/Metaobject/1','gid://shopify/Metaobject/2','gid://shopify/Metaobject/3']);
        return {nodes:[
            {id:args.ids[0],definition:{access:{storefront:'PUBLIC_READ'}},capabilities:{publishable:{status:'ACTIVE'}},
                fields:[field('dimensions','{"value":12,"unit":"cm"}','dimension'),field('nested','gid://shopify/Metaobject/9','metaobject_reference')]},
            {id:args.ids[1],definition:{access:{storefront:'NONE'}},fields:[field('secret','SECRET')]},
            {id:args.ids[2],definition:{access:{storefront:'PUBLIC_READ'}},capabilities:{publishable:{status:'DRAFT'}},fields:[field('draft','DRAFT')]},
        ]};
    });
    const missing=await knowledge.product(shop(),id);
    assert.equal(missing.referenceStatus,'missing_scope');assert.deepEqual(missing.missingScopes,['read_metaobjects','read_metaobject_definitions']);
    assert.equal(query.mock.calls.length,1);
    const loaded=await knowledge.product(shop(['read_metaobjects','read_metaobject_definitions']),id);
    assert.equal(loaded.referenceStatus,'loaded');assert.ok(loaded.attributes.some(a=>a.key==='dimensions'));
    assert.doesNotMatch(JSON.stringify(loaded),/SECRET|DRAFT|Metaobject\/9|private_reference/);
    assert.equal(query.mock.calls.length,3);
});

test('optional knowledge scopes are explicit, allowlisted and independent for each app',t=>{
    t.mock.method(shopify,'appConfig',domain=>({custom:domain==='custom.myshopify.com'}));
    const keys=['SHOPIFY_KNOWLEDGE_SCOPES','SHOPIFY_CUSTOM_KNOWLEDGE_SCOPES'];
    const before=keys.map(k=>process.env[k]);
    t.after(()=>keys.forEach((k,i)=>{if(before[i]===undefined)delete process.env[k];else process.env[k]=before[i];}));
    delete process.env.SHOPIFY_KNOWLEDGE_SCOPES;delete process.env.SHOPIFY_CUSTOM_KNOWLEDGE_SCOPES;
    assert.deepEqual(knowledge.oauthScopes('primary.myshopify.com'),shopify.SCOPES);
    process.env.SHOPIFY_KNOWLEDGE_SCOPES='read_legal_policies, read_metaobjects, read_metaobject_definitions';
    assert.deepEqual(knowledge.oauthScopes('primary.myshopify.com'),[...shopify.SCOPES,'read_legal_policies','read_metaobjects','read_metaobject_definitions']);
    assert.deepEqual(knowledge.oauthScopes('custom.myshopify.com'),shopify.SCOPES);
    process.env.SHOPIFY_CUSTOM_KNOWLEDGE_SCOPES='write_orders';
    assert.throws(()=>knowledge.oauthScopes('custom.myshopify.com'),/invalid_knowledge_scopes/);
});

test('bounded rich text, pagination and provider failures remain explicit, without leaking errors',async t=>{
    const n=node();n.product.description='x'.repeat(14000);
    n.product.metafields.pageInfo={hasNextPage:true};
    n.product.metafields.nodes.push(field('care_rich',JSON.stringify({type:'root',children:[{type:'paragraph',children:[{type:'text',value:'Air dry.'}]}]}),'rich_text_field'));
    n.product.metafields.nodes.push(field('invalid','{','rich_text_field'));
    n.product.metafields.nodes.push(field('long','x'.repeat(20000)));
    let fail=false;
    const query=t.mock.method(shopify,'graphql',async()=>{if(fail)throw Error('SECRET_TOKEN');return {node:n};});
    const a=await knowledge.product(shop(),id);
    assert.equal(a.description.length,12000);assert.equal(a.descriptionTruncated,true);assert.equal(a.partial,true);
    assert.ok(a.attributes.some(a=>a.value==='Air dry.'));assert.ok(!a.attributes.some(a=>['custom.invalid','custom.long'].includes(a.key)));
    fail=true;const s=shop(),bad=await knowledge.product(s,id);
    assert.deepEqual(bad,{status:'unavailable',retryable:true});await knowledge.product(s,id);
    assert.equal(query.mock.calls.length,2);
});

test('policies require scope, preserve conditions and separate general rules from delivery promises',async t=>{
    const query=t.mock.method(shopify,'graphql',async()=>({shop:{shopPolicies:[{title:'Refunds',type:'REFUND_POLICY',
        body:'<p>Returns within 30 days.</p><p>Only unused items.</p>',url:'https://synthetic.myshopify.com/policies/refund-policy'}]}}));
    assert.equal((await knowledge.policies(shop())).status,'missing_scope');assert.equal(query.mock.calls.length,0);
    const s=shop(['read_legal_policies']),a=await knowledge.policies(s);
    assert.match(a.policies[0].body,/30 days.*Only unused/);assert.equal(a.deliveryDate,'not_confirmed');
    assert.equal(a.exactShippingCost,'confirmed_at_checkout');await knowledge.policies(s);assert.equal(query.mock.calls.length,1);
});

test('cart context preloads bounded unique variants and exposes a path to all remaining details',async t=>{
    t.mock.method(shopify,'graphql',async(_s,_q,args)=>({node:{...node(),id:args.id,product:{...node().product,description:'x'.repeat(4000)}}}));
    const items=Array.from({length:6},(_,i)=>({variantId:`gid://shopify/ProductVariant/${i+1}`}));
    const a=await knowledge.forCart(shop(),[...items,items[0]],true);
    assert.equal(a.products.length,4);assert.deepEqual(a.additionalVariantIds,items.slice(4).map(i=>i.variantId));
    assert.equal(a.products[0].description.length,2000);assert.equal(a.products[0].moreDetailsAvailable,true);
});

test('conversation context never waits for optional Shopify knowledge or issues background requests',async t=>{
    const read=t.mock.method(shopify,'graphql',async()=>{throw Error('Should not fetch');});
    const a=await knowledge.forCart(shop(['read_legal_policies']),[{variantId:id}]);
    assert.equal(a.products[0].status,'not_loaded');assert.equal(a.policies.status,'not_loaded');
    assert.equal(read.mock.calls.length,0);
});
