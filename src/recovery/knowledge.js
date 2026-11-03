'use strict';

const shopify = require('./shopify');
const { problem } = require('./policy');
const zendesk = require('./zendesk');

// Descriptive knowledge only: prices, inventory and checkout actions keep their fresh validations.
const cache = new Map();
const REFERENCE_SCOPES = ['read_metaobjects','read_metaobject_definitions'];
const OPTIONAL_SCOPES = ['read_legal_policies',...REFERENCE_SCOPES];

function oauthScopes(domain) {
    const custom = shopify.appConfig(domain).custom;
    const extra = (process.env[custom ? 'SHOPIFY_CUSTOM_KNOWLEDGE_SCOPES' : 'SHOPIFY_KNOWLEDGE_SCOPES'] || '')
        .split(',').map(s=>s.trim()).filter(Boolean);
    if (extra.some(s=>!OPTIONAL_SCOPES.includes(s))) throw problem('invalid_knowledge_scopes',503);
    return [...new Set([...shopify.SCOPES,...extra])];
}
const META = `metafields(first:40) { pageInfo { hasNextPage } nodes {
    namespace key type value definition { name access { storefront } }
} }`;
const PRODUCT_QUERY = `query RecoveryProductKnowledge($id:ID!) {
    node(id:$id) { ... on ProductVariant {
        id title sku selectedOptions { name value } ${META}
        inventoryItem { requiresShipping measurement { weight { value unit } } }
        product { id title description vendor productType onlineStoreUrl status publishedAt updatedAt
            category { fullName } options { name values } ${META}
        }
    } }
}`;
const scalarTypes = new Set(['single_line_text_field','multi_line_text_field','boolean','number_integer','number_decimal',
    'dimension','weight','volume','rating','money','color','date','date_time','url','link','json']);
const gid = (value, kind) => typeof value === 'string' && new RegExp(`^gid://shopify/${kind}/[1-9]\\d{0,19}$`).test(value);
const text = (value, limit) => String(value || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);
const cacheKey = (shop,resource) => JSON.stringify([shop.customer_id,shop.id,shop.domain,shop.mode,shop.shopify_app_client_id,shop.scopes,resource]);

function cachedResult(shop, resource) {
    const entry = cache.get(cacheKey(shop,resource));
    return entry?.until>Date.now() && entry.result ? entry.result : {status:'not_loaded'};
}

function fieldValue(field) {
    if (typeof field.value !== 'string' || field.value.length > 16000) return null;
    if (field.type === 'rich_text_field') {
        try {
            let visits = 0;
            const walk = (node, depth = 0) => {
                if (!node || depth > 12 || ++visits > 1000) return '';
                if (node.type === 'text') return text(node.value,2000);
                return Array.isArray(node.children) ? node.children.map(n=>walk(n,depth+1)).join(' ') : '';
            };
            return text(walk(JSON.parse(field.value)),2000) || null;
        } catch { return null; }
    }
    if (scalarTypes.has(field.type) || (field.type?.startsWith('list.') && scalarTypes.has(field.type.slice(5)))) {
        return text(field.value,2000) || null;
    }
    return null;
}

function publicFields(connection) {
    return (connection?.nodes || []).filter(f=>f.definition?.access?.storefront === 'PUBLIC_READ');
}

async function cached(shop, resource, read) {
    const key = cacheKey(shop,resource);
    const old = cache.get(key);
    if (old && old.until > Date.now()) return old.value;
    // shortcut: bounded process-local five-minute knowledge cache; move to shared storage if API replicas are introduced.
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    const entry = { until: Date.now()+300000 };
    entry.value = Promise.resolve().then(read).then(value=>({...value,verifiedAt:new Date().toISOString()})).catch(()=>{
        entry.until = Date.now()+15000;
        return {status:'unavailable',retryable:true};
    }).then(value=>(entry.result=value));
    cache.set(key,entry);
    return entry.value;
}

async function product(shop, variantId) {
    if (!gid(variantId,'ProductVariant')) throw problem('invalid_product_variant');
    if (shop.mode !== 'live') return {status:'not_connected'};
    return cached(shop,variantId,async()=>{
        const data = await shopify.graphql(shop,PRODUCT_QUERY,{id:variantId});
        const v = data.node, p = v?.product;
        if (v?.id !== variantId || p?.status !== 'ACTIVE' || !p.publishedAt ||
            !Number.isFinite(Date.parse(p.publishedAt)) || Date.parse(p.publishedAt)>Date.now()) return {status:'not_public'};
        const fields = [...publicFields(p.metafields).map(f=>({...f,owner:'product'})),
            ...publicFields(v.metafields).map(f=>({...f,owner:'variant'}))];
        const attributes = fields.flatMap(f=>{
            const value = fieldValue(f);
            return value ? [{owner:f.owner,key:`${f.namespace}.${f.key}`,label:text(f.definition.name,120),value,
                truncated:f.value.length>2000}] : [];
        });
        const references = [];
        let referencesTruncated = false;
        for (const f of fields.filter(f=>['metaobject_reference','list.metaobject_reference'].includes(f.type))) {
            if (typeof f.value !== 'string' || f.value.length>16000) continue;
            try {
                const ids = f.type === 'metaobject_reference' ? [f.value] : JSON.parse(f.value);
                if (Array.isArray(ids) && ids.length>20) referencesTruncated = true;
                if (Array.isArray(ids)) for (const id of ids.slice(0,20)) if (gid(id,'Metaobject')) {
                    if (references.length<20) references.push({id,owner:f.owner,label:text(f.definition.name,120)});
                    else referencesTruncated = true;
                }
            } catch { /* Malformed optional content is not product evidence. */ }
        }
        const ids = [...new Set(references.map(r=>r.id))].slice(0,20);
        let referenceStatus = ids.length ? 'missing_scope' : 'none';
        const missingReferenceScopes = REFERENCE_SCOPES.filter(s=>!shop.scopes?.includes(s));
        if (ids.length && !missingReferenceScopes.length) {
            try {
                const resolved = await shopify.graphql(shop,`query RecoveryKnowledgeReferences($ids:[ID!]!) {
                    nodes(ids:$ids) { ... on Metaobject { id
                        definition { access { storefront } }
                        capabilities { publishable { status } }
                        fields { key type value }
                    } }
                }`,{ids});
                for (const node of resolved.nodes || []) {
                    if (!node || !ids.includes(node.id) || node.definition?.access?.storefront !== 'PUBLIC_READ' ||
                        (node.capabilities?.publishable && node.capabilities.publishable.status !== 'ACTIVE')) continue;
                    for (const ref of references.filter(r=>r.id===node.id)) for (const field of (node.fields || []).slice(0,30)) {
                        const value = fieldValue(field);
                        if (value) attributes.push({owner:ref.owner,label:ref.label,key:text(field.key,120),value,
                            truncated:field.value.length>2000});
                    }
                }
                referenceStatus = referencesTruncated || references.length>20 ||
                    (resolved.nodes || []).some(n=>n?.fields?.length>30) ? 'partial' : 'loaded';
            } catch { referenceStatus = 'unavailable'; }
        }
        // Bound model context independently of Shopify pagination and reference fan-out.
        let used = 0;
        const bounded = attributes.filter(a=>{ used += a.value.length+a.label.length+100; return used<=16000; });
        const supportKnowledge=await zendesk.product(shop,p.title);
        return {status:'loaded',source:'shopify',productId:p.id,variantId:v.id,title:text(p.title,200),
            variantTitle:text(v.title,200),description:text(p.description,12000),descriptionTruncated:(p.description || '').length>12000,
            vendor:text(p.vendor,200),productType:text(p.productType,200),category:text(p.category?.fullName,300),
            productUrl:p.onlineStoreUrl || null,updatedAt:p.updatedAt,sku:text(v.sku,150),
            selectedOptions:(v.selectedOptions || []).slice(0,3).map(o=>({name:text(o.name,100),value:text(o.value,200)})),
            options:(p.options || []).slice(0,3).map(o=>({name:text(o.name,100),values:(o.values || []).slice(0,100).map(v=>text(v,200))})),
            shippingRequired:v.inventoryItem?.requiresShipping ?? null,weight:v.inventoryItem?.measurement?.weight || null,
            attributes:bounded,referenceStatus,
            partial:Boolean(p.metafields?.pageInfo?.hasNextPage || v.metafields?.pageInfo?.hasNextPage || used>16000 ||
                referencesTruncated || fields.some(f=>typeof f.value !== 'string' || f.value.length>16000)),
            missingScopes:ids.length ? missingReferenceScopes : [],supportKnowledge};
    });
}

async function policies(shop) {
    if (shop.mode !== 'live') return {status:'not_connected'};
    if (!shop.scopes?.includes('read_legal_policies')) return {status:'missing_scope',missingScopes:['read_legal_policies']};
    return cached(shop,'policies',async()=>{
        const data = await shopify.graphql(shop,`query RecoveryShopPolicies {
            shop { name contactEmail shopPolicies { title type body url updatedAt } }
        }`);
        return {status:'loaded',source:'shopify',policies:(data.shop.shopPolicies || []).slice(0,10).map(p=>({
            title:text(p.title,200),type:p.type,body:text(p.body,20000),url:p.url,updatedAt:p.updatedAt,
            truncated:p.body.length>20000})),
            exactShippingCost:'confirmed_at_checkout',deliveryDate:'not_confirmed'};
    });
}

function summary(product) {
    if (product.status !== 'loaded') return product;
    const supportKnowledge=zendesk.summary(product.supportKnowledge || {status:'not_configured'});
    return {...product,supportKnowledge,description:product.description.slice(0,2000),
        options:product.options.map(o=>({...o,values:o.values.slice(0,10)})),
        attributes:product.attributes.slice(0,12).map(a=>({...a,value:a.value.slice(0,500),truncated:a.truncated || a.value.length>500})),
        moreDetailsAvailable:product.description.length>2000 || product.attributes.length>12 ||
            product.attributes.some(a=>a.value.length>500) || product.options.some(o=>o.values.length>10) ||
            [...(supportKnowledge.productArticles || []),...(supportKnowledge.shopArticles || [])].some(a=>a.truncated)};
}

async function forCart(shop, items, preload = false) {
    const ids = [...new Set((items || []).map(i=>i.variantId).filter(id=>gid(id,'ProductVariant')))];
    const products = [];
    // Preload the first four lines; other variants remain accessible through get_product_details.
    for (let i=0;i<Math.min(ids.length,4);i+=2) {
        products.push(...await Promise.all(ids.slice(i,i+2).map(async id=>({variantId:id,
            ...summary(preload ? await product(shop,id) : cachedResult(shop,id))}))));
    }
    // During conversation, context reads never wait for optional knowledge requests.
    const shopPolicies = preload || !shop.scopes?.includes('read_legal_policies') ? await policies(shop) : cachedResult(shop,'policies');
    return {products,additionalVariantIds:ids.slice(4),policies:{...shopPolicies,
        policies:shopPolicies.policies?.map(p=>({...p,body:p.body.length<=4000 ? p.body : undefined,
            moreDetailsAvailable:p.body.length>4000}))}};
}

module.exports = { product, policies, forCart, oauthScopes };
