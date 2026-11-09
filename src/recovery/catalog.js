'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction, event } = require('./store');
const policy = require('./policy');
const shopify = require('./shopify');
const discounts = require('./discounts');

const PRODUCT = 'id title description status publishedAt requiresSellingPlan isGiftCard';
const VARIANT = 'id title price availableForSale inventoryPolicy sellableOnlineQuantity inventoryItem { tracked } requiresComponents';
const variantId = value => typeof value === 'string' && /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,19}$/.test(value);

function selection(items) {
    if (!Array.isArray(items) || !items.length || items.length > 10 || items.some(i => !i ||
        !variantId(i.variantId) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 10 ||
        Object.keys(i).some(k => !['variantId','quantity'].includes(k))) ||
        new Set(items.map(i => i.variantId)).size !== items.length) throw policy.problem('invalid_checkout_selection');
    return [...items].sort((a,b) => a.variantId.localeCompare(b.variantId));
}

function item(node, quantity = 1) {
    const p = node?.product;
    if (!variantId(node?.id) || p?.status !== 'ACTIVE' || !p.publishedAt || !Number.isFinite(Date.parse(p.publishedAt)) || Date.parse(p.publishedAt)>Date.now() ||
        p.requiresSellingPlan || p.isGiftCard || node.requiresComponents ||
        !node.availableForSale || !(node.inventoryItem?.tracked === false || node.inventoryPolicy === 'CONTINUE' || node.sellableOnlineQuantity >= quantity)) return null;
    return { productId: p.id, variantId: node.id, title: String(p.title || '').slice(0,200),
        variantTitle: String(node.title || '').slice(0,200), description: String(p.description || '').slice(0,2000),
        quantity, currentPriceCents: policy.cents(node.price), originalUnitCents: policy.cents(node.price), available: true };
}

function currency(data, shop) {
    if (!['EUR','USD'].includes(data.shop?.currencyCode) || data.shop.currencyCode !== shop.currency) {
        throw policy.problem('unsupported_shop_currency',409);
    }
    return data.shop.currencyCode;
}

async function search(shop, query, maxPriceCents = null) {
    if (typeof query !== 'string' || query.length > 100 || !query.trim() ||
        (maxPriceCents !== null && (!Number.isSafeInteger(maxPriceCents) || maxPriceCents < 1 || maxPriceCents > 2147483647))) {
        throw policy.problem('invalid_product_search');
    }
    const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0,6);
    if (!terms?.length) throw policy.problem('invalid_product_search');
    const filter = `status:active AND (${terms.map(t => `(title:${t}* OR product_type:${t}* OR tag:${t}*)`).join(' AND ')})`;
    const data = await shopify.graphql(shop, `query RecoveryProducts($query:String!) {
        products(first:8,query:$query) { nodes { ${PRODUCT} variants(first:10) { nodes { ${VARIANT} } } } }
        shop { currencyCode }
    }`,{query:filter});
    const products = data.products.nodes.flatMap(p => p.variants.nodes.map(v => item({...v,product:p}))).filter(Boolean)
        .filter(i => maxPriceCents === null || i.currentPriceCents <= maxPriceCents).slice(0,6);
    return { currency: currency(data,shop), products, verifiedAt: new Date().toISOString(),
        searchIsExhaustive: false, shipping: 'confirmed_at_checkout', taxes: 'confirmed_at_checkout' };
}

async function snapshot(shop, items) {
    const requested = selection(items);
    const data = await shopify.graphql(shop, `query RecoverySelectedProducts($ids:[ID!]!) {
        nodes(ids:$ids) { ... on ProductVariant { ${VARIANT} product { ${PRODUCT} } } }
        shop { currencyCode }
    }`,{ids:requested.map(i => i.variantId)});
    const lines = requested.map(i => item(data.nodes.find(n => n?.id === i.variantId),i.quantity));
    if (lines.some(i => !i)) throw policy.problem('selected_product_unavailable',409);
    const subtotalCents = lines.reduce((sum,i) => sum+i.currentPriceCents*i.quantity,0);
    if (!Number.isSafeInteger(subtotalCents) || subtotalCents > 2147483647) throw policy.problem('money_out_of_range');
    return { currency: currency(data,shop), subtotalCents, discountCodes: [], items: lines };
}

async function authorized(call, client = db, lock = false, conversationRequired = true) {
    const service = require('./service');
    const shop = await service.shopFor(call.customer_id,call.shop_id,client,lock);
    const ctx = await service.state(client,shop,call.checkout_id,lock);
    const denied = policy.eligibility(ctx,new Date(),'action',call.is_test === true);
    if (denied) throw policy.problem(denied,409);
    const result = await client.query(`SELECT 1 FROM recovery_calls WHERE id=$1 AND shop_id=$2 AND checkout_id=$3
        AND contact_key=$4 AND (NOT $5 OR identity_verified) AND expires_at>NOW() AND ended_at IS NULL
        AND status IN ('reserved','dialing','connected') AND outcome IS DISTINCT FROM 'voicemail'
        AND outcome IS DISTINCT FROM 'no_answer' AND outcome IS DISTINCT FROM 'technical_failure'`,[call.id,shop.id,call.checkout_id,ctx.checkout.contact_key,conversationRequired]);
    if (!result.rowCount) throw policy.problem('call_authorization_changed',409);
    return ctx;
}

async function searchProducts(call, query, maxPriceCents) {
    const ctx = await authorized(call);
    const result = await search(ctx.shop,query,maxPriceCents);
    await authorized(call);
    return result;
}

async function productDetails(call, variantId) {
    const ctx = await authorized(call);
    const result = await require('./knowledge').product(ctx.shop,variantId);
    await authorized(call);
    return result;
}

async function shopPolicies(call) {
    const ctx = await authorized(call);
    const result = await require('./knowledge').policies(ctx.shop);
    await authorized(call);
    return result;
}

function view(proposal) {
    return { preparedCheckoutId: proposal.id, cart: proposal.data.snapshot, offer: proposal.data.offer,
        expiresAt: proposal.data.expiresAt, originalCartUnchanged: true, purchaseCompleted: false };
}

async function prepareCheckout(call, items, discountId = null) {
    const service = require('./service');
    selection(items);
    if (discountId !== null && !service.uuid(discountId)) throw policy.problem('discount_not_available',409);
    const ctx = await authorized(call);
    const cart = await snapshot(ctx.shop,items);
    const proof = discountId ? await discounts.verify(ctx.shop,discountId,cart.subtotalCents) : null;
    const offer = policy.offer(ctx.shop.rules,cart.subtotalCents,proof?.percent || 0);
    const targetKey = service.hash(JSON.stringify([policy.cartHash(cart),proof?.fingerprint || null]));
    return transaction(async client => {
        const current = await authorized(call,client,true);
        if (proof) await discounts.assertApproved(client,current.shop,proof,cart.subtotalCents);
        policy.offer(current.shop.rules,cart.subtotalCents,offer.percent);
        const prior = await client.query(`SELECT id,data FROM recovery_events WHERE call_id=$1 AND shop_id=$2
            AND kind='checkout_prepared' ORDER BY created_at DESC LIMIT 1`,[call.id,call.shop_id]);
        if (prior.rows[0]?.data.targetKey === targetKey && new Date(prior.rows[0].data.expiresAt)>new Date()) return view(prior.rows[0]);
        const id = randomUUID(), data = { targetKey, snapshot: cart, offer, discount: proof,
            expiresAt: new Date(Math.min(Date.now()+30*60000,proof?.expiresAt ? Date.parse(proof.expiresAt) : Infinity)).toISOString() };
        await event(client,call.shop_id,'checkout_prepared',data,call.id,null,id);
        return view({id,data});
    });
}

async function proposal(client, call, id) {
    if (!require('./service').uuid(id)) throw policy.problem('invalid_prepared_checkout');
    const result = await client.query(`SELECT id,data,created_at FROM recovery_events WHERE call_id=$1 AND shop_id=$2
        AND kind='checkout_prepared' ORDER BY created_at DESC LIMIT 1`,[call.id,call.shop_id]);
    const row = result.rows[0];
    if (!row || row.id !== id || new Date(row.data.expiresAt) <= new Date()) throw policy.problem('prepared_checkout_changed',409);
    return row;
}

async function verifyProposal(call, id, useDiscount) {
    const ctx = await authorized(call), row = await proposal(db,call,id);
    const current = await snapshot(ctx.shop,row.data.snapshot.items.map(({variantId,quantity}) => ({variantId,quantity})));
    if (policy.cartHash(current) !== policy.cartHash(row.data.snapshot)) throw policy.problem('selected_product_changed',409);
    if (useDiscount && !row.data.discount) throw policy.problem('valid_offer_required',409);
    const proof = useDiscount ? await discounts.verify(ctx.shop,row.data.discount.id,current.subtotalCents) : null;
    if (proof && proof.fingerprint !== row.data.discount.fingerprint) throw policy.problem('valid_offer_required',409);
    return { id, cartHash: policy.cartHash(current), discount: proof, verifiedAt: Date.now() };
}

function permalink(shop, cart, id, code) {
    // Cart attributes are required for exact recovery attribution; the newer /buy links do not support them yet.
    const url = new URL(`https://${shopify.domain(shop.domain)}/cart/${selection(cart.items.map(({variantId,quantity}) => ({variantId,quantity})))
        .map(i => `${i.variantId.split('/').at(-1)}:${i.quantity}`).join(',')}`);
    url.searchParams.set('attributes[rescova_recovery]',id);
    if (code) url.searchParams.set('discount',code);
    return policy.checkoutUrl(url.href,shop);
}

async function authorizeProposal(client, call, shop, id, proof, useDiscount, consent) {
    const row = await proposal(client,call,id), cart = row.data.snapshot;
    if (!proof || proof.id !== id || Date.now()-proof.verifiedAt > 30000 || proof.cartHash !== policy.cartHash(cart)) {
        throw policy.problem('selected_product_changed',409);
    }
    const review = await client.query(`SELECT speech.data FROM recovery_events speech
        JOIN recovery_events prepared ON prepared.id=$3
        JOIN recovery_events consent ON consent.call_id=$1 AND consent.kind='user_transcript' AND consent.data->>'eventId'=$4
        WHERE speech.call_id=$1 AND speech.shop_id=$2 AND speech.kind='assistant_transcript'
        AND speech.created_at>=prepared.created_at AND speech.created_at<consent.created_at
        ORDER BY speech.created_at DESC LIMIT 1`,[call.id,shop.id,id,consent.data.eventId]);
    if (!review.rows[0] || review.rows[0].data.interrupted) throw policy.problem('checkout_review_required',409);
    if (useDiscount) {
        await discounts.assertApproved(client,shop,proof.discount,cart.subtotalCents);
        if (proof.discount.fingerprint !== row.data.discount?.fingerprint) throw policy.problem('valid_offer_required',409);
    }
    policy.offer(shop.rules,cart.subtotalCents,useDiscount ? row.data.offer.percent : 0);
    return { proposalId: id, targetKey: require('./service').hash(JSON.stringify([proof.cartHash,useDiscount ? proof.discount.fingerprint : null])),
        consentEvent: consent.data.eventId, selectionAgreementEvent: consent.data.eventId,
        ...(useDiscount ? {agreementEvent:consent.data.eventId} : {}), offerId: null,
        cartHash: proof.cartHash, checkoutUrl: permalink(shop,cart,id,useDiscount ? proof.discount.code : null) };
}

async function attributeOrder(client, shop, payload, phone) {
    const attrs = Array.isArray(payload.note_attributes) ? payload.note_attributes.filter(a => a?.name === 'rescova_recovery') : [];
    if (attrs.length !== 1 || !require('./service').uuid(attrs[0].value) || !phone) return;
    const result = await client.query(`SELECT c.id,e.data FROM recovery_events e JOIN recovery_calls a ON a.id=e.call_id
        JOIN recovery_checkouts c ON c.id=a.checkout_id AND c.shop_id=e.shop_id
        JOIN recovery_actions sms ON sms.checkout_id=c.id AND sms.kind='sms' AND sms.data->>'proposalId'=e.id::text
        WHERE e.id=$1 AND e.shop_id=$2 AND e.kind='checkout_prepared' AND c.phone=$3 AND c.currency=$4
        AND sms.status IN ('accepted','delivered') AND a.connected_at IS NOT NULL AND a.outcome IS DISTINCT FROM 'voicemail' AND a.outcome IS DISTINCT FROM 'no_answer' AND a.outcome IS DISTINCT FROM 'technical_failure'
        AND $5::timestamptz>=sms.created_at AND $5::timestamptz<a.connected_at+INTERVAL '7 days'`,
    [attrs[0].value,shop.id,phone,payload.currency,payload.created_at]);
    const row = result.rows[0];
    if (!row || !Array.isArray(payload.line_items) || !row.data.snapshot.items.every(item => payload.line_items.some(line =>
        String(line.variant_id) === item.variantId.split('/').at(-1) && line.quantity >= item.quantity))) return;
    await client.query(`UPDATE recovery_orders SET recovery_checkout_id=$3 WHERE shop_id=$1 AND external_id=$2
        AND recovery_checkout_id IS NULL`,[shop.id,String(payload.id),row.id]);
}

module.exports = { search, snapshot, selection, permalink, authorized, searchProducts, productDetails, shopPolicies, prepareCheckout, verifyProposal, authorizeProposal, attributeOrder };
