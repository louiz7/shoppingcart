'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { db, transaction, event } = require('./store');
const policy = require('./policy');
const shopify = require('./shopify');

const FIELDS = `id ... on DiscountCodeNode { codeDiscount { __typename ... on DiscountCodeBasic {
    status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer
    codes(first:2) { nodes { code } pageInfo { hasNextPage } }
    context { __typename }
    customerGets { value { __typename ... on DiscountPercentage { percentage } } items { __typename ... on AllDiscountItems { allItems } } }
    minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } }
    combinesWith { orderDiscounts productDiscounts shippingDiscounts productDiscountsWithTagsOnSameCartLine }
} } }`;

function view(row) {
    return { id: row.id, title: row.title, code: row.code, percent: row.percent,
        minSubtotalCents: row.min_subtotal_cents, expiresAt: new Date(row.expires_at).toISOString(),
        usageLimit: row.usage_limit, status: row.status, createdAt: new Date(row.created_at).toISOString() };
}

function fingerprint(row) {
    return createHash('sha256').update(JSON.stringify([row.id,row.shopify_id,row.code,row.percent,row.min_subtotal_cents,
        new Date(row.expires_at).toISOString(),row.usage_limit])).digest('hex');
}

function validate(shop, input) {
    const rules = policy.rules(shop.rules);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['requestId','title','code','percent','minSubtotalCents','validDays','usageLimit'].includes(key)) ||
        !require('./service').uuid(input.requestId) || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length>80 ||
        typeof input.code !== 'string' || !/^[A-Z0-9_-]{3,32}$/.test(input.code) ||
        !Number.isInteger(input.percent) || input.percent<1 || input.percent>rules.maxDiscountPercent ||
        !Number.isSafeInteger(input.minSubtotalCents) || input.minSubtotalCents<rules.minSubtotalCents || input.minSubtotalCents>2147483647 ||
        !Number.isInteger(input.validDays) || input.validDays<1 || input.validDays>30 ||
        !Number.isInteger(input.usageLimit) || input.usageLimit<1 || input.usageLimit>1000) throw policy.problem('invalid_discount_rules', 409);
    return { ...input, title: input.title.trim() };
}

function allowed(shop, row, subtotal = Infinity) {
    const rules = policy.rules(shop.rules);
    return row.percent<=rules.maxDiscountPercent && row.min_subtotal_cents>=rules.minSubtotalCents &&
        subtotal>=row.min_subtotal_cents && new Date(row.expires_at)>new Date();
}

function matches(shop, row, node) {
    const actual = node?.codeDiscount, minimum = actual?.minimumRequirement;
    if (!actual || node.id!==row.shopify_id || actual.__typename!=='DiscountCodeBasic' || actual.status!=='ACTIVE' ||
        !Number.isFinite(Date.parse(actual.startsAt)) || new Date(actual.startsAt)>new Date() ||
        !Number.isFinite(Date.parse(actual.endsAt)) || +new Date(actual.endsAt)!==+new Date(row.expires_at) ||
        actual.usageLimit!==row.usage_limit || !Number.isInteger(actual.asyncUsageCount) || actual.asyncUsageCount<0 || actual.asyncUsageCount>=row.usage_limit ||
        actual.appliesOncePerCustomer!==true || actual.context?.__typename!=='DiscountBuyerSelectionAll' ||
        actual.customerGets?.value?.__typename!=='DiscountPercentage' ||
        !Number.isFinite(actual.customerGets.value.percentage) ||
        Math.abs(actual.customerGets.value.percentage-row.percent/100)>1e-10 ||
        actual.customerGets?.items?.__typename!=='AllDiscountItems' || actual.customerGets.items.allItems!==true ||
        actual.combinesWith?.orderDiscounts!==false || actual.combinesWith?.productDiscounts!==false || actual.combinesWith?.shippingDiscounts!==false ||
        (actual.combinesWith.productDiscountsWithTagsOnSameCartLine || []).length ||
        actual.codes?.pageInfo?.hasNextPage!==false || !Array.isArray(actual.codes.nodes) || actual.codes.nodes.length!==1 || actual.codes.nodes[0].code!==row.code ||
        minimum?.__typename!=='DiscountMinimumSubtotal' || minimum.greaterThanOrEqualToSubtotal?.currencyCode!==shop.currency) return false;
    try { return policy.cents(minimum.greaterThanOrEqualToSubtotal.amount)===row.min_subtotal_cents; }
    catch { return false; }
}

async function inspect(shop, rows) {
    if (!rows.length) return [];
    if (rows.some((row) => !/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(row.shopify_id || ''))) throw policy.problem('discount_not_available', 409);
    const response = await shopify.graphql(shop, `query RecoveryApprovedDiscounts($ids:[ID!]!) { nodes(ids:$ids) { ${FIELDS} } }`,
        { ids: rows.map((row) => row.shopify_id) });
    return rows.filter((row) => matches(shop, row, response.nodes?.find((node) => node?.id===row.shopify_id)));
}

async function settings(customerId) {
    const shops = await db.query(`SELECT s.* FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE s.customer_id=$1 AND s.mode='live' AND c.is_active ORDER BY s.brand,s.id`, [customerId]);
    const rows = await db.query(`SELECT d.* FROM recovery_discounts d JOIN recovery_shops s ON s.id=d.shop_id
        JOIN customers c ON c.id=s.customer_id WHERE s.customer_id=$1 AND s.mode='live' AND c.is_active ORDER BY d.created_at DESC`, [customerId]);
    return { shops: shops.rows.map((shop) => ({ id: shop.id,brand: shop.brand,domain: shop.domain,currency: shop.currency,
        agentProfile: require('./agent-profile').forShop(shop),
        maxDiscountPercent: policy.rules(shop.rules).maxDiscountPercent,minSubtotalCents: policy.rules(shop.rules).minSubtotalCents,
        discounts: rows.rows.filter((row) => row.shop_id===shop.id).map(view) })) };
}

async function create(customerId, shopId, input) {
    const reserved = await transaction(async (client) => {
        const shop = await require('./service').shopFor(customerId, shopId, client, true);
        if (shop.mode!=='live') throw policy.problem('live_shop_required', 409);
        const value = validate(shop, input);
        const prior = await client.query('SELECT * FROM recovery_discounts WHERE shop_id=$1 AND request_id=$2', [shop.id, value.requestId]);
        if (prior.rows[0]) {
            const row = prior.rows[0];
            if (row.title!==value.title || row.code!==value.code || row.percent!==value.percent || row.min_subtotal_cents!==value.minSubtotalCents ||
                row.valid_days!==value.validDays || row.usage_limit!==value.usageLimit) throw policy.problem('discount_request_reused', 409);
            return { existing: true, row };
        }
        if ((await client.query('SELECT 1 FROM recovery_discounts WHERE shop_id=$1 AND code=$2', [shop.id, value.code])).rowCount) {
            throw policy.problem('discount_code_exists', 409);
        }
        const result = await client.query(`INSERT INTO recovery_discounts(id,shop_id,request_id,title,code,percent,min_subtotal_cents,valid_days,expires_at,usage_limit)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [randomUUID(),shop.id,value.requestId,value.title,value.code,value.percent,
            value.minSubtotalCents,value.validDays,new Date(Math.floor(Date.now()/1000)*1000+value.validDays*86400000),value.usageLimit]);
        return { shop, row: result.rows[0] };
    });
    if (reserved.existing) return { discount: view(reserved.row) };
    const { shop, row } = reserved;
    let rejected = false;
    try {
        const response = await shopify.graphql(shop, `mutation RecoveryMerchantDiscount($input:DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount:$input) { codeDiscountNode { id } userErrors { field code message } }
        }`, { input: { title: row.title,code: row.code,startsAt: new Date().toISOString(),endsAt: new Date(row.expires_at).toISOString(),
            context: { all: true }, customerGets: { value: { percentage: row.percent/100 }, items: { all: true } },
            minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: (row.min_subtotal_cents/100).toFixed(2) } },
            usageLimit: row.usage_limit,appliesOncePerCustomer: true,
            combinesWith: { orderDiscounts: false,productDiscounts: false,shippingDiscounts: false } } });
        const result = response.discountCodeBasicCreate;
        if (result?.userErrors?.length) { rejected = true; throw policy.problem('discount_creation_rejected', 409); }
        row.shopify_id = result?.codeDiscountNode?.id;
        if (!/^gid:\/\/shopify\/DiscountCodeNode\/\d+$/.test(row.shopify_id || '')) throw policy.problem('discount_creation_unconfirmed', 502);
        await db.query('UPDATE recovery_discounts SET shopify_id=$2 WHERE id=$1', [row.id,row.shopify_id]);
        if (!(await inspect(shop,[row])).length) throw policy.problem('discount_creation_unconfirmed', 502);
        await db.query(`UPDATE recovery_discounts SET status='confirmed' WHERE id=$1`, [row.id]);
        row.status = 'confirmed';
        await event(db,shop.id,'merchant_discount_created',{ discountId: row.id });
        return { discount: view(row) };
    } catch {
        await db.query('UPDATE recovery_discounts SET status=$2 WHERE id=$1', [row.id,rejected ? 'failed' : 'unknown']);
        throw policy.problem(rejected ? 'discount_creation_rejected' : 'discount_creation_unconfirmed_do_not_retry', rejected ? 409 : 502);
    }
}

async function verify(shop, id, subtotal = Infinity) {
    if (!require('./service').uuid(id)) throw policy.problem('discount_not_available', 409);
    const result = await db.query(`SELECT * FROM recovery_discounts WHERE shop_id=$1 AND id=$2 AND status='confirmed'`, [shop.id,id]);
    const row = result.rows[0];
    if (!row || !allowed(shop,row,subtotal) || !(await inspect(shop,[row])).length) throw policy.problem('discount_not_available', 409);
    return { ...view(row),fingerprint: fingerprint(row),verifiedAt: Date.now() };
}

async function assertApproved(client, shop, proof, subtotal) {
    const result = await client.query(`SELECT * FROM recovery_discounts WHERE shop_id=$1 AND id=$2 AND status='confirmed'`, [shop.id,proof?.id]);
    const row = result.rows[0];
    if (!row || !allowed(shop,row,subtotal) || Date.now()-proof.verifiedAt>30000 || fingerprint(row)!==proof.fingerprint) {
        throw policy.problem('discount_not_available',409);
    }
}

async function available(shop, subtotal) {
    // shortcut: inspect the latest 20 approved codes per call; add catalog pagination if merchants need larger catalogs.
    const result = await db.query(`SELECT * FROM recovery_discounts WHERE shop_id=$1 AND status='confirmed' AND expires_at>NOW() ORDER BY created_at DESC LIMIT 20`, [shop.id]);
    try { return (await inspect(shop,result.rows.filter((row) => allowed(shop,row,subtotal)))).map(view); }
    catch { return []; }
}

async function offerProof(call) {
    const result = await db.query(`SELECT data FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
    const id = result.rows[0]?.data.discountId;
    if (!id) return null;
    const shop = await require('./service').shopFor(call.customer_id,call.shop_id);
    const checkout = await require('./service').state(db,shop,call.checkout_id);
    return verify(shop,id,checkout.checkout.subtotal_cents);
}

module.exports = { settings,create,available,verify,assertApproved,offerProof };
