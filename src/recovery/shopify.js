'use strict';

const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const { decryptShopifyCredentials } = require('../services/shopify-crypto');
const { problem, cents, checkoutUrl } = require('./policy');

const VERSION = '2026-10';
const SCOPES = ['read_orders', 'read_products', 'read_customers', 'write_discounts'];
const FIELDS = `id name abandonedCheckoutUrl completedAt createdAt updatedAt discountCodes
    customer { id firstName phone email }
    shippingAddress { phone }
    subtotalPriceSet { presentmentMoney { amount currencyCode } }
    lineItems(first:20) { pageInfo { hasNextPage } nodes {
      title variantTitle quantity originalUnitPriceSet { presentmentMoney { amount currencyCode } }
      product { id title description status }
      variant { id title price availableForSale sellableOnlineQuantity inventoryPolicy }
    } }`;

function domain(value) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(value)) throw problem('invalid_shop_domain');
    return value;
}

function appConfig(shopDomain, expectedClientId) {
    domain(shopDomain);
    const customDomain = process.env.RECOVERY_SHOPIFY_CUSTOM_DOMAIN;
    if (customDomain) domain(customDomain);
    const custom = customDomain === shopDomain;
    const clientId = custom ? process.env.SHOPIFY_CUSTOM_CLIENT_ID : process.env.SHOPIFY_CLIENT_ID;
    const secret = custom ? process.env.SHOPIFY_CUSTOM_CLIENT_SECRET : process.env.SHOPIFY_CLIENT_SECRET;
    if (!clientId || !secret) throw problem('shopify_app_not_configured', 503);
    if (expectedClientId && expectedClientId !== clientId) throw problem('shopify_app_mismatch', 409);
    return { clientId, secret, custom };
}

function shopApp(shop, credentials = {}) {
    const app = appConfig(shop.domain);
    const stored = shop.shopify_app_client_id || credentials.app_client_id;
    if ((shop.shopify_app_client_id && credentials.app_client_id && shop.shopify_app_client_id !== credentials.app_client_id) ||
        (!stored && app.custom) || (stored && stored !== app.clientId)) throw problem('shopify_app_mismatch', 409);
    // Only pre-existing primary installations may lack the encrypted app binding.
    return app;
}

function signature(raw, supplied, secret = process.env.SHOPIFY_CLIENT_SECRET) {
    if (!secret || typeof supplied !== 'string') return false;
    const expected = createHmac('sha256', secret).update(raw).digest('base64');
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function oauthHmac(params, secret = process.env.SHOPIFY_CLIENT_SECRET) {
    const supplied = params.get('hmac');
    if (!secret || !supplied || !/^[a-f0-9]{64}$/i.test(supplied) ||
        [...params.keys()].some((key) => params.getAll(key).length !== 1)) return false;
    const message = [...params].filter(([key]) => !['hmac', 'signature'].includes(key))
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&');
    return timingSafeEqual(Buffer.from(supplied, 'hex'), createHmac('sha256', secret).update(message).digest());
}

function encryptToken(accessToken) {
    const { createCipheriv } = require('node:crypto');
    const raw = process.env.SHOPIFY_CREDENTIALS_KEY || process.env.EMAIL_CREDENTIALS_KEY || '';
    const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw problem('shopify_encryption_not_configured', 503);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('rescova-shopify-credentials:v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(typeof accessToken==='string' ? { access_token: accessToken } : accessToken)), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function offlineCredentials(response, now=Date.now()) {
    const token = (value) => typeof value==='string' && value.length>0 && value.length<=4096 && !/[\x00-\x20\x7f]/.test(value);
    if (!token(response?.access_token) || !token(response?.refresh_token) || !Number.isSafeInteger(response.expires_in) || response.expires_in<=0 ||
        !Number.isSafeInteger(response.refresh_token_expires_in) || response.refresh_token_expires_in<0 ||
        !Number.isSafeInteger(now+response.expires_in*1000) || !Number.isSafeInteger(now+response.refresh_token_expires_in*1000)) {
        throw problem('shopify_expiring_token_response_invalid',502);
    }
    return {access_token:response.access_token,refresh_token:response.refresh_token,
        expires_at:new Date(now+response.expires_in*1000).toISOString(),
        refresh_token_expires_at:new Date(now+response.refresh_token_expires_in*1000).toISOString(),
        ...(typeof response.scope==='string' ? {scope:response.scope} : {})};
}

async function tokenRequest(shopDomain, body, expectedClientId) {
    const app = appConfig(shopDomain, expectedClientId);
    let response;
    try {
        response=await fetch(`https://${shopDomain}/admin/oauth/access_token`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
            headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
                ...body,client_id:app.clientId,client_secret:app.secret}).toString()});
    } catch { throw problem('shopify_token_service_unavailable',503); }
    let payload;
    try { payload=await response.json(); } catch { throw problem('shopify_token_response_invalid',502); }
    if (!response.ok) {
        if (response.status===401 || (response.status===400 && ['invalid_subject_token','invalid_grant','invalid_request'].includes(payload?.error))) {
            throw problem('shopify_reauthorization_required',409);
        }
        if (response.status===403) throw problem('shopify_app_credentials_rejected',503);
        throw problem('shopify_token_service_unavailable',503);
    }
    return {...offlineCredentials(payload),app_client_id:app.clientId};
}

async function withTokenLock(shopDomain, operation) {
    domain(shopDomain);
    return require('./store').transaction(async(client)=>{
        await client.query('SELECT pg_advisory_xact_lock(20261103,hashtext($1))',[shopDomain]);
        return operation(client);
    });
}

const exchangeAuthorizationCode = (shopDomain, code, clientId) => tokenRequest(shopDomain,{code,expiring:'1'},clientId);

function currentToken(credentials) {
    return !credentials.reauthorization_required && typeof credentials.access_token==='string' && typeof credentials.refresh_token==='string' &&
        Number.isFinite(Date.parse(credentials.expires_at)) && Date.parse(credentials.expires_at)>Date.now()+60000;
}

async function accessToken(shop) {
    if (!shop.id) {
        const credentials=decryptShopifyCredentials(shop.credentials_encrypted);
        shopApp(shop, credentials);
        if (!currentToken(credentials)) throw problem('shopify_reauthorization_required',409);
        return credentials.access_token;
    }
    const result=await withTokenLock(shop.domain,async(client)=>{
        const {rows}=await client.query(`SELECT s.credentials_encrypted,s.shopify_app_client_id FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
            WHERE s.id=$1 AND s.domain=$2 AND s.customer_id=$3 AND s.mode='live' AND c.is_active FOR UPDATE OF s`,[shop.id,shop.domain,shop.customer_id]);
        if (!rows[0]?.credentials_encrypted) throw problem('shop_not_connected',409);
        const credentials=decryptShopifyCredentials(rows[0].credentials_encrypted);
        const app = shopApp({...shop,shopify_app_client_id:rows[0].shopify_app_client_id},credentials);
        if (credentials.reauthorization_required) return {error:problem('shopify_reauthorization_required',409)};
        if (currentToken(credentials)) {
            if (!credentials.app_client_id || !rows[0].shopify_app_client_id) await client.query(
                'UPDATE recovery_shops SET credentials_encrypted=$2,shopify_app_client_id=$3 WHERE id=$1',
                [shop.id,encryptToken({...credentials,app_client_id:app.clientId}),app.clientId]);
            return {token:credentials.access_token};
        }
        let updated;
        try {
            if (credentials.refresh_token) {
                if (!Number.isFinite(Date.parse(credentials.refresh_token_expires_at)) || Date.parse(credentials.refresh_token_expires_at)<=Date.now()) {
                    throw problem('shopify_reauthorization_required',409);
                }
                updated=await tokenRequest(shop.domain,{grant_type:'refresh_token',refresh_token:credentials.refresh_token},app.clientId);
            } else if (credentials.access_token && !credentials.expires_at) {
                updated=await tokenRequest(shop.domain,{grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',
                    subject_token:credentials.access_token,subject_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',
                    requested_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',expiring:'1'},app.clientId);
            } else throw problem('shopify_reauthorization_required',409);
        } catch(error) {
            if (error.code!=='shopify_reauthorization_required') throw error;
            await client.query(`UPDATE recovery_shops SET credentials_encrypted=$2,last_error=$3 WHERE id=$1`,
                [shop.id,encryptToken({...credentials,reauthorization_required:true}),error.code]);
            return {error};
        }
        await client.query('UPDATE recovery_shops SET credentials_encrypted=$2,shopify_app_client_id=$3 WHERE id=$1',[shop.id,encryptToken(updated),app.clientId]);
        return {token:updated.access_token};
    });
    if (result.error) throw result.error;
    return result.token;
}

function webhookCapability(shopId) {
    const secret = process.env.SHOPIFY_CREDENTIALS_KEY;
    if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) throw problem('shopify_encryption_not_configured', 503);
    return createHmac('sha256', Buffer.from(secret, 'hex')).update(`recovery-hook-v1:${shopId}`).digest('hex');
}

async function registerWebhooks(shop) {
    const base = new URL(process.env.RECOVERY_PUBLIC_URL || 'http://localhost');
    if (base.protocol !== 'https:' || base.username || base.password) throw problem('public_https_webhook_url_required', 409);
    const endpoint = new URL(`/webhooks/recovery/shopify/${shop.id}/${webhookCapability(shop.id)}`, base).href;
    const data = await graphql(shop, `query RecoverySubscriptions { webhookSubscriptions(first:100) {
        nodes { topic uri } pageInfo { hasNextPage } } }`);
    if (data.webhookSubscriptions.pageInfo.hasNextPage) throw problem('webhook_registration_needs_review', 409);
    for (const topic of ['CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE', 'CHECKOUTS_DELETE', 'ORDERS_CREATE', 'ORDERS_PAID', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'APP_UNINSTALLED']) {
        if (data.webhookSubscriptions.nodes.some((s) => s.topic === topic && s.uri === endpoint)) continue;
        const result = await graphql(shop, `mutation RecoveryWebhook($topic:WebhookSubscriptionTopic!,$input:WebhookSubscriptionInput!) {
            webhookSubscriptionCreate(topic:$topic,webhookSubscription:$input) { webhookSubscription { id } userErrors { field } }
        }`, { topic, input: { uri: endpoint, format: 'JSON' } });
        if (result.webhookSubscriptionCreate.userErrors.length || !result.webhookSubscriptionCreate.webhookSubscription) {
            throw problem('webhook_registration_failed', 409);
        }
    }
}

async function graphql(shop, query, variables = {}) {
    domain(shop.domain);
    if (shop.mode !== 'live' || !shop.credentials_encrypted) throw problem('shop_not_connected', 409);
    const token = await accessToken(shop);
    const response = await fetch(`https://${shop.domain}/admin/api/${VERSION}/graphql.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw problem('shopify_unavailable', 502);
    const payload = await response.json();
    if (payload.errors?.some((error) => error.extensions?.code === 'ACCESS_DENIED' && error.path?.at(-1) === 'phone')) {
        throw problem('shopify_phone_access_required', 409);
    }
    if (payload.errors?.length || !payload.data) throw problem('shopify_query_failed', 502);
    return payload.data;
}

function normalizeCheckout(node, shop) {
    if (!node || !/^gid:\/\/shopify\/AbandonedCheckout\/\d+$/.test(node.id)) throw problem('checkout_unverified', 409);
    if (node.lineItems?.pageInfo?.hasNextPage) throw problem('cart_too_large', 409);
    const lines = node.lineItems?.nodes;
    if (!Array.isArray(lines) || !lines.length || lines.length > 20 || lines.some((item) =>
        !item || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)) {
        throw problem('invalid_cart_items', 409);
    }
    const money = node.subtotalPriceSet?.presentmentMoney;
    if (!money || !['EUR','USD'].includes(money.currencyCode) || money.currencyCode !== (shop.currency || 'EUR')) throw problem('unsupported_currency', 409);
    if (lines.some((item) => item.originalUnitPriceSet?.presentmentMoney?.currencyCode !== money.currencyCode)) {
        throw problem('mixed_cart_currency', 409);
    }
    const requiredQuantity = new Map();
    for (const item of lines) requiredQuantity.set(item.variant?.id,
        (requiredQuantity.get(item.variant?.id) || 0) + item.quantity);
    const items = lines.map((item) => ({
        title: String(item.title || '').slice(0, 200), variantTitle: String(item.variantTitle || '').slice(0, 200),
        quantity: item.quantity, originalUnitCents: cents(item.originalUnitPriceSet.presentmentMoney.amount),
        productId: item.product?.id || null, variantId: item.variant?.id || null,
        description: String(item.product?.description || '').slice(0, 2000),
        currentPriceCents: item.variant ? cents(item.variant.price) : null,
        available: Boolean(item.product?.status === 'ACTIVE' && item.variant?.availableForSale &&
            (item.variant.inventoryPolicy === 'CONTINUE' ||
                item.variant.sellableOnlineQuantity >= requiredQuantity.get(item.variant.id))),
    }));
    return {
        id: node.id, updatedAt: node.updatedAt, completedAt: node.completedAt,
        phone: node.shippingAddress?.phone || node.customer?.phone || null,
        email: node.customer?.email || null, customerId: node.customer?.id || null,
        firstName: String(node.customer?.firstName || '').slice(0, 80), currency: money.currencyCode,
        subtotalCents: cents(money.amount), checkoutUrl: checkoutUrl(node.abandonedCheckoutUrl, shop),
        discountCodes: node.discountCodes || [], items,
    };
}

async function listCheckouts(shop) {
    let after = null;
    const nodes = [];
    // Bound each sync; a partial import must not authorize calls on unseen data.
    for (let page = 0; page < 50; page++) {
        const data = await graphql(shop, `query RecoveryCheckouts($after:String,$query:String!) {
            abandonedCheckouts(first:10,after:$after,query:$query,sortKey:CREATED_AT) {
              nodes { ${FIELDS} } pageInfo { hasNextPage endCursor }
            } }`, { after, query: `updated_at:>='${new Date(Date.now() - 15 * 86400000).toISOString()}'` });
        nodes.push(...data.abandonedCheckouts.nodes);
        if (!data.abandonedCheckouts.pageInfo.hasNextPage) return nodes;
        after = data.abandonedCheckouts.pageInfo.endCursor;
    }
    throw problem('shopify_pagination_limit', 409);
}

async function refreshCheckout(shop, externalId) {
    if (typeof externalId !== 'string' || !/^gid:\/\/shopify\/AbandonedCheckout\/\d+$/.test(externalId)) throw problem('checkout_unverified', 409);
    const data = await graphql(shop, `query RecoveryCheckout($id:ID!) {
        node(id:$id) { ... on AbandonedCheckout { ${FIELDS} } }
        shop { currencyCode }
    }`, { id: externalId });
    if (!data.node || data.node.id !== externalId) throw problem('checkout_unverified', 409);
    if (!['EUR','USD'].includes(data.shop.currencyCode) || data.shop.currencyCode !== (shop.currency || 'EUR')) throw problem('unsupported_shop_currency', 409);
    return normalizeCheckout(data.node, shop);
}

async function createDiscount(shop, snapshot, code, percent, endsAt) {
    if (!snapshot.customerId) throw problem('discount_customer_missing', 409);
    const data = await graphql(shop, `mutation RecoveryDiscount($input:DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount:$input) { codeDiscountNode { id } userErrors { field code } }
    }`, { input: {
        title: `Rescova recovery ${code}`, code, startsAt: new Date().toISOString(), endsAt,
        context: { customers: { add: [snapshot.customerId] } },
        customerGets: { value: { percentage: percent / 100 }, items: {
            products: { productVariantsToAdd: snapshot.items.map((i) => i.variantId) },
        } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: false },
        minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: (snapshot.subtotalCents / 100).toFixed(2) } },
        usageLimit: 1, appliesOncePerCustomer: true,
    } });
    if (data.discountCodeBasicCreate.userErrors.length || !data.discountCodeBasicCreate.codeDiscountNode) {
        throw problem('shopify_discount_denied', 409);
    }
    return data.discountCodeBasicCreate.codeDiscountNode.id;
}

async function orderStatus(shop, checkout) {
    if (!checkout || checkout.shop_id!==shop.id || typeof checkout.id!=='string') throw problem('order_checkout_missing',409);
    const { rows } = await require('./store').db.query(`SELECT o.external_id FROM recovery_orders o
        JOIN recovery_checkouts c ON c.id=$2 AND c.shop_id=o.shop_id WHERE o.shop_id=$1 AND
        (o.recovery_checkout_id=c.id OR (o.checkout_token IS NOT NULL AND o.checkout_token=c.checkout_token) OR o.checkout_external_id=c.external_id)
        ORDER BY o.ordered_at DESC LIMIT 1`,[shop.id,checkout.id]);
    if (!rows.length) return { verifiedAt: new Date().toISOString(),orders: [] };
    if (!/^[0-9]+$/.test(rows[0].external_id)) throw problem('order_unverified',409);
    const id = `gid://shopify/Order/${rows[0].external_id}`;
    const data = await graphql(shop, `query RecoveryOrder($id:ID!) {
        node(id:$id) { ... on Order { id test displayFinancialStatus displayFulfillmentStatus } }
    }`,{ id });
    if (data.node?.id!==id) throw problem('order_unverified',409);
    return { verifiedAt: new Date().toISOString(),orders: [{ test: data.node.test,
        displayFinancialStatus: data.node.displayFinancialStatus,displayFulfillmentStatus: data.node.displayFulfillmentStatus }] };
}

module.exports = { VERSION, SCOPES, FIELDS, domain, appConfig, shopApp, signature, oauthHmac, encryptToken,
    graphql, normalizeCheckout, listCheckouts, refreshCheckout, createDiscount, orderStatus, webhookCapability, registerWebhooks,
    offlineCredentials,withTokenLock,exchangeAuthorizationCode };
