'use strict';

const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { db, transaction, event } = require('./store');
const policy = require('./policy');
const shopify = require('./shopify');
const telephony = require('./telephony');

const hash = (text) => createHash('sha256').update(text).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function shopFor(customerId, shopId, executor = db, lock = false) {
    if (!uuid(shopId)) throw policy.problem('shop_not_found', 404);
    const { rows } = await executor.query(`SELECT s.* FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE s.id=$1 AND s.customer_id=$2 AND c.is_active ${lock ? 'FOR UPDATE OF s' : ''}`, [shopId, customerId]);
    if (!rows[0]) throw policy.problem('shop_not_found', 404);
    return rows[0];
}

async function state(executor, shop, checkoutId, lock = false) {
    if (!uuid(checkoutId)) throw policy.problem('checkout_not_found', 404);
    const { rows } = await executor.query(`SELECT * FROM recovery_checkouts WHERE id=$1 AND shop_id=$2
        ${lock ? 'FOR UPDATE' : ''}`, [checkoutId, shop.id]);
    const checkout = rows[0];
    if (!checkout) throw policy.problem('checkout_not_found', 404);
    const { rows: contacts } = await executor.query(`SELECT * FROM recovery_contacts WHERE shop_id=$1 AND contact_key=$2
        ${lock ? 'FOR UPDATE' : ''}`, [shop.id, checkout.contact_key]);
    const { rows: attempts } = await executor.query(`SELECT id,status,created_at FROM recovery_calls
        WHERE shop_id=$1 AND contact_key=$2 ORDER BY created_at DESC`, [shop.id, checkout.contact_key]);
    return { shop, checkout, contact: contacts[0], attempts,
        active: attempts.some((a) => ['reserved', 'dialing', 'connected', 'unknown'].includes(a.status)) };
}

async function saveSettings(customerId, shopId, input) {
    const nextRules = policy.rules(input.rules);
    if (typeof input.brand !== 'string' || !input.brand.trim() || input.brand.length > 100 ||
        typeof input.brand_voice !== 'string' || input.brand_voice.length > 2000 || typeof input.enabled !== 'boolean') {
        throw policy.problem('invalid_shop_settings');
    }
    return transaction(async (client) => {
        const shop = await shopFor(customerId, shopId, client, true);
        if (input.enabled && shop.mode === 'live' && !shop.webhooks_ready) throw policy.problem('webhooks_not_ready', 409);
        if (input.enabled && input.approval !== true && !shop.approved_at) throw policy.problem('explicit_merchant_approval_required');
        await client.query(`UPDATE recovery_shops SET brand=$3,brand_voice=$4,rules=$5,enabled=$6,
            approved_at=CASE WHEN $7 THEN NOW() ELSE approved_at END WHERE id=$1 AND customer_id=$2`,
        [shop.id, customerId, input.brand.trim(), input.brand_voice, JSON.stringify(nextRules), input.enabled, input.approval === true]);
        await event(client, shop.id, 'settings_saved', { enabled: input.enabled, rules: nextRules });
        return { saved: true };
    });
}

async function consent(customerId, shopId, checkoutId, input) {
    const consentAt = new Date(input.consentedAt), expiresAt = new Date(input.expiresAt);
    if (input.verified !== true || typeof input.evidence !== 'string' || input.evidence.trim().length < 20 || input.evidence.length > 2000 ||
        ![input.consentedAt,input.expiresAt].every((v) => typeof v === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(v)) ||
        !Number.isFinite(+consentAt) || !Number.isFinite(+expiresAt) || consentAt > new Date() || expiresAt <= new Date() ||
        expiresAt - consentAt > 366 * 86400000) throw policy.problem('invalid_consent_evidence');
    try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }); } catch { throw policy.problem('invalid_timezone'); }
    if (typeof input.timezone !== 'string') throw policy.problem('invalid_timezone');
    return transaction(async (client) => {
        const shop = await shopFor(customerId, shopId, client, true);
        const ctx = await state(client, shop, checkoutId, true);
        if (!ctx.contact || ctx.contact.stopped_at || ctx.contact.revoked_at) throw policy.problem('contact_stopped', 409);
        await client.query(`UPDATE recovery_contacts SET consented_at=$3,expires_at=$4,evidence=$5,timezone=$6,consent_checkout_id=$7
            WHERE shop_id=$1 AND contact_key=$2`, [shop.id, ctx.contact.contact_key, consentAt, expiresAt, input.evidence.trim(), input.timezone, checkoutId]);
        await event(client, shop.id, 'consent_recorded', { checkoutId, source: 'merchant_verified_evidence' });
        return { saved: true };
    });
}

async function upsertCheckout(client, shop, snapshot, token = null) {
    let number = null, key = null;
    try { number = policy.phone(snapshot.phone); key = policy.contactKey(shop.id, number); } catch { /* Missing contact stays ineligible. */ }
    if (key) await client.query(`INSERT INTO recovery_contacts(shop_id,contact_key,phone) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`, [shop.id, key, number]);
    await client.query(`INSERT INTO recovery_checkouts(id,shop_id,external_id,checkout_token,contact_key,phone,email,
        currency,subtotal_cents,snapshot,source_updated_at,completed_at,status,verified_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $12::timestamptz IS NULL THEN 'pending' ELSE 'converted' END,NOW())
        ON CONFLICT(shop_id,external_id) DO UPDATE SET
          checkout_token=COALESCE(EXCLUDED.checkout_token,recovery_checkouts.checkout_token),
          contact_key=EXCLUDED.contact_key,phone=EXCLUDED.phone,email=EXCLUDED.email,currency=EXCLUDED.currency,
          subtotal_cents=EXCLUDED.subtotal_cents,snapshot=EXCLUDED.snapshot,source_updated_at=EXCLUDED.source_updated_at,
          completed_at=COALESCE(recovery_checkouts.completed_at,EXCLUDED.completed_at),verified_at=NOW(),
          status=CASE WHEN EXCLUDED.completed_at IS NOT NULL THEN 'converted' ELSE recovery_checkouts.status END
        WHERE recovery_checkouts.source_updated_at <= EXCLUDED.source_updated_at`,
    [randomUUID(), shop.id, snapshot.id, token, key, number, snapshot.email, snapshot.currency,
        snapshot.subtotalCents, JSON.stringify(snapshot), snapshot.updatedAt, snapshot.completedAt]);
    // A purchase webhook may precede checkout ingestion or be delivered out of order.
    await client.query(`UPDATE recovery_checkouts c SET completed_at=o.ordered_at,status='converted'
        FROM recovery_orders o WHERE c.shop_id=$1 AND o.shop_id=c.shop_id AND
        ((o.checkout_token IS NOT NULL AND o.checkout_token=c.checkout_token) OR
         (o.checkout_external_id=c.external_id) OR (o.phone=c.phone AND o.ordered_at >= c.source_updated_at))`, [shop.id]);
}

async function syncShop(customerId, shopId) {
    const shop = await shopFor(customerId, shopId);
    if (shop.mode === 'simulation') return { simulated: true, imported: 0 };
    try {
        const nodes = await shopify.listCheckouts(shop);
        await transaction(async (client) => {
            await shopFor(customerId, shopId, client, true);
            for (const node of nodes) await upsertCheckout(client, shop, shopify.normalizeCheckout(node, shop));
            await client.query('UPDATE recovery_shops SET sync_at=NOW(),last_error=NULL WHERE id=$1', [shop.id]);
        });
        return { imported: nodes.length };
    } catch (error) {
        await db.query('UPDATE recovery_shops SET last_error=$2 WHERE id=$1', [shop.id, error.code || 'sync_failed']);
        throw error;
    }
}

async function refresh(customerId, shopId, checkoutId) {
    const shop = await shopFor(customerId, shopId);
    const ctx = await state(db, shop, checkoutId);
    if (shop.mode === 'simulation') return ctx;
    const snapshot = await shopify.refreshCheckout(shop, ctx.checkout.external_id);
    await transaction(async (client) => {
        await shopFor(customerId, shopId, client, true);
        await upsertCheckout(client, shop, snapshot);
    });
    return state(db, shop, checkoutId);
}

async function enroll(client, ctx) {
    const arm = ctx.contact.arm || policy.assignment(ctx.shop.id, ctx.contact.contact_key, policy.rules(ctx.shop.rules).holdoutPercent);
    await client.query(`UPDATE recovery_contacts SET arm=COALESCE(arm,$3),enrolled_at=COALESCE(enrolled_at,NOW()),
        experiment_rules=COALESCE(experiment_rules,$4) WHERE shop_id=$1 AND contact_key=$2`,
    [ctx.shop.id, ctx.contact.contact_key, arm, JSON.stringify(policy.rules(ctx.shop.rules))]);
    await client.query('UPDATE recovery_checkouts SET arm=$3 WHERE id=$1 AND shop_id=$2', [ctx.checkout.id, ctx.shop.id, arm]);
    return arm;
}

async function startCall(customerId, shopId, checkoutId) {
    await refresh(customerId, shopId, checkoutId);
    const reservation = await transaction(async (client) => {
        const shop = await shopFor(customerId, shopId, client, true);
        const ctx = await state(client, shop, checkoutId, true);
        const denied = policy.eligibility(ctx);
        if (denied) throw policy.problem(denied, 409);
        if (shop.mode === 'live' && !shop.webhooks_ready) throw policy.problem('webhooks_not_ready', 409);
        if (shop.mode === 'live' && (process.env.RECOVERY_LIVE_ENABLED !== '1' || !telephony.configured())) {
            throw policy.problem('live_calls_disabled', 409);
        }
        // shortcut: one active call per shop in the pilot; widen with a tested budgeted scheduler.
        const busy = await client.query(`SELECT 1 FROM recovery_calls WHERE shop_id=$1 AND status IN ('reserved','dialing','connected','unknown') LIMIT 1`, [shop.id]);
        if (busy.rowCount) throw policy.problem('shop_busy', 409);
        const arm = await enroll(client, ctx);
        if (arm === 'control') return { control: true };
        const id = randomUUID(), token = randomBytes(32).toString('hex'), room = `recovery-${id}`;
        await client.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '15 minutes',$7)`,
        [id, shop.id, checkoutId, ctx.checkout.contact_key, room, hash(token), shop.mode === 'simulation' ? 'simulated' : 'reserved']);
        if (shop.mode === 'simulation') {
            await event(client, shop.id, 'simulation_call', { checkoutId, noExternalAction: true }, id);
            return { simulated: true, id };
        }
        return { id, room, token };
    });
    if (reservation.control || reservation.simulated) return reservation;
    // The intent is durable before contacting the provider. Ambiguous failures never auto-retry.
    try {
        const number = await transaction(async (client) => {
            const shop = await shopFor(customerId, shopId, client, true);
            const ctx = await state(client, shop, checkoutId, true);
            const denied = policy.eligibility(ctx, new Date(), 'action');
            if (denied) throw policy.problem(denied, 409);
            return ctx.checkout.phone;
        });
        await telephony.dial(reservation, number, reservation.token);
        const acknowledged = await db.query(`UPDATE recovery_calls SET dialed_at=COALESCE(dialed_at,NOW()),
            status=CASE WHEN status='reserved' THEN 'dialing' ELSE status END WHERE id=$1 RETURNING status`, [reservation.id]);
        const latest = await state(db, await shopFor(customerId, shopId), checkoutId);
        if (policy.eligibility(latest, new Date(), 'action')) await telephony.hangup(reservation.room);
        await db.query(`UPDATE recovery_checkouts SET status='calling' WHERE id=$1 AND shop_id=$2 AND status='pending'
            AND EXISTS(SELECT 1 FROM recovery_calls WHERE id=$3 AND status IN ('dialing','connected'))`, [checkoutId, shopId, reservation.id]);
        return { id: reservation.id, status: acknowledged.rows[0].status };
    } catch {
        await db.query(`UPDATE recovery_calls SET status='unknown',outcome='provider_result_unconfirmed'
            WHERE id=$1 AND ended_at IS NULL AND status!='ended'`, [reservation.id]);
        throw policy.problem('call_result_unknown_do_not_retry', 502);
    }
}

async function stopContact(customerId, shopId, checkoutId, reason = 'merchant_stop') {
    const rooms = await transaction(async (client) => {
        const shop = await shopFor(customerId, shopId, client, true);
        const ctx = await state(client, shop, checkoutId, true);
        if (ctx.contact) await client.query(`UPDATE recovery_contacts SET stopped_at=COALESCE(stopped_at,NOW()),
            revoked_at=COALESCE(revoked_at,NOW()),stop_reason=$3 WHERE shop_id=$1 AND contact_key=$2`,
        [shop.id, ctx.contact.contact_key, String(reason).slice(0, 100)]);
        await client.query(`UPDATE recovery_checkouts SET status='stopped' WHERE shop_id=$1 AND
            (contact_key=$2 OR id=$3) AND status!='converted'`, [shop.id, ctx.checkout.contact_key, checkoutId]);
        await client.query(`UPDATE recovery_actions SET status='failed' WHERE status='pending' AND checkout_id IN
            (SELECT id FROM recovery_checkouts WHERE shop_id=$1 AND (contact_key=$2 OR id=$3))`, [shop.id, ctx.checkout.contact_key, checkoutId]);
        await event(client, shop.id, 'contact_stopped', { checkoutId, reason: String(reason).slice(0, 100) });
        return ctx.attempts.filter((a) => ['reserved', 'dialing', 'connected', 'unknown'].includes(a.status)).map((a) => `recovery-${a.id}`);
    });
    const results = await Promise.allSettled(rooms.map(telephony.hangup));
    return { stopped: true, hangupPending: results.some((r) => r.status === 'rejected') };
}

async function callContext(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw policy.problem('invalid_call_token', 401);
    const { rows } = await db.query(`SELECT a.*,s.customer_id FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
        JOIN customers c ON c.id=s.customer_id WHERE a.token_hash=$1 AND a.expires_at>NOW()
        AND a.status IN ('reserved','dialing','connected') AND c.is_active`, [hash(token)]);
    if (!rows[0]) throw policy.problem('invalid_call_token', 401);
    return rows[0];
}

async function getContext(call) {
    if (!call.identity_verified) {
        const shop = await shopFor(call.customer_id, call.shop_id);
        const ctx = await state(db, shop, call.checkout_id);
        const denied = policy.eligibility(ctx, new Date(), 'action');
        if (denied) throw policy.problem(denied, 409);
        return { brand: shop.brand, brandVoice: shop.brand_voice, identityRequired: true };
    }
    const ctx = await refresh(call.customer_id, call.shop_id, call.checkout_id);
    const denied = policy.eligibility(ctx, new Date(), 'action');
    if (denied) throw policy.problem(denied, 409);
    return { brand: ctx.shop.brand, brandVoice: ctx.shop.brand_voice,
        cart: { currency: ctx.checkout.currency, subtotalCents: ctx.checkout.subtotal_cents, items: ctx.checkout.snapshot.items,
            shipping: 'unknown_until_checkout', taxes: 'unknown_until_checkout' }, verifiedAt: ctx.checkout.verified_at,
        maxDiscountPercent: policy.rules(ctx.shop.rules).maxDiscountPercent };
}

async function recordConnection(call) {
    // Only the trusted worker calls this endpoint after observing an active SIP participant.
    const result = await db.query(`UPDATE recovery_calls a SET connected_at=COALESCE(connected_at,NOW()),
        dialed_at=COALESCE(dialed_at,NOW()),status=CASE WHEN ended_at IS NULL THEN 'connected' ELSE status END
        FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE a.id=$1 AND a.shop_id=s.id AND s.id=$2 AND s.customer_id=$3 AND c.is_active
        AND s.mode='live' AND a.status!='simulated' RETURNING a.id`, [call.id, call.shop_id, call.customer_id]);
    if (!result.rowCount) throw policy.problem('invalid_call_connection', 409);
    return getContext(call);
}

async function dailySummary(customerId, asOf = new Date()) {
    if (!(asOf instanceof Date) || !Number.isFinite(+asOf)) throw policy.problem('invalid_summary_time');
    const { rows } = await db.query(`WITH shops AS (
        SELECT s.id,s.brand,s.domain,s.currency,COALESCE(s.rules->>'timezone','Europe/Berlin') AS timezone
        FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE s.customer_id=$1 AND c.is_active AND s.mode='live'
    ), days AS (
        SELECT *,to_char($2::timestamptz AT TIME ZONE timezone,'YYYY-MM-DD') AS date,
            date_trunc('day',$2::timestamptz AT TIME ZONE timezone) AT TIME ZONE timezone AS starts_at,
            (date_trunc('day',$2::timestamptz AT TIME ZONE timezone)+INTERVAL '1 day') AT TIME ZONE timezone AS ends_at
        FROM shops
    ) SELECT d.id,d.brand,d.domain,d.timezone AS "timeZone",d.date,
        (SELECT count(*)::int FROM recovery_calls a WHERE a.shop_id=d.id AND a.status!='simulated'
            AND a.dialed_at>=d.starts_at AND a.dialed_at<d.ends_at) AS "callsToday",
        (SELECT count(*)::int FROM recovery_orders o WHERE o.shop_id=d.id AND o.paid AND o.currency=d.currency
            AND o.paid_at>=d.starts_at AND o.paid_at<d.ends_at AND EXISTS (
                SELECT 1 FROM recovery_checkouts checkout JOIN recovery_calls a ON a.checkout_id=checkout.id AND a.shop_id=checkout.shop_id
                WHERE checkout.shop_id=o.shop_id AND a.status!='simulated' AND a.connected_at IS NOT NULL
                    AND o.paid_at>a.connected_at AND o.paid_at<a.connected_at+INTERVAL '168 hours'
                    AND ((o.checkout_token IS NOT NULL AND o.checkout_token=checkout.checkout_token) OR o.checkout_external_id=checkout.external_id)
            )) AS "confirmedCheckoutsToday"
        FROM days d ORDER BY d.brand,d.id`, [customerId, asOf.toISOString()]);
    return { asOf: asOf.toISOString(), shops: rows };
}

async function getOffer(call, percent) {
    if (!call.identity_verified) throw policy.problem('identity_required', 409);
    await refresh(call.customer_id, call.shop_id, call.checkout_id);
    const reserved = await transaction(async (client) => {
        const shop = await shopFor(call.customer_id, call.shop_id, client, true);
        const ctx = await state(client, shop, call.checkout_id, true);
        const denied = policy.eligibility(ctx, new Date(), 'action');
        if (denied) throw policy.problem(denied, 409);
        const snapshot = ctx.checkout.snapshot;
        if (!snapshot.items?.length || snapshot.items.some((i) => !i.available || !i.variantId ||
            i.currentPriceCents !== i.originalUnitCents) || snapshot.discountCodes?.length) throw policy.problem('cart_offer_needs_review', 409);
        const amount = policy.offer(shop.rules, ctx.checkout.subtotal_cents, percent);
        const { rows } = await client.query(`SELECT * FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
        if (rows[0]) {
            if (!['confirmed', 'simulated'].includes(rows[0].status) || new Date(rows[0].data.expiresAt) <= new Date() ||
                rows[0].data.cartHash !== policy.cartHash(snapshot) ||
                rows[0].data.percent > policy.rules(shop.rules).maxDiscountPercent) throw policy.problem('offer_not_valid', 409);
            return { existing: true, data: rows[0].data };
        }
        const code = percent ? `RC${randomBytes(8).toString('hex').toUpperCase()}` : null;
        const expiresAt = new Date(Date.now() + policy.rules(shop.rules).offerHours * 3600000).toISOString();
        const result = { ...amount, currency: ctx.checkout.currency, code, expiresAt, checkoutUrl: policy.checkoutUrl(snapshot.checkoutUrl, shop, code),
            cartHash: policy.cartHash(snapshot), simulated: shop.mode === 'simulation' };
        // Commit the code before Shopify is called: crashes/timeouts cannot create a second offer.
        const id = randomUUID();
        await client.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'offer',$3,$4)`,
        [id, call.checkout_id, 'pending', JSON.stringify(result)]);
        return { id, data: result };
    });
    if (reserved.existing) return reserved.data;
    try {
        const authorized = await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action');
            if (denied) throw policy.problem(denied, 409);
            policy.offer(shop.rules, ctx.checkout.subtotal_cents, reserved.data.percent);
            if (reserved.data.cartHash !== policy.cartHash(ctx.checkout.snapshot)) throw policy.problem('cart_changed', 409);
            return { shop, snapshot: ctx.checkout.snapshot };
        });
        if (reserved.data.percent && authorized.shop.mode === 'live') {
            await shopify.createDiscount(authorized.shop, authorized.snapshot, reserved.data.code, reserved.data.percent, reserved.data.expiresAt);
        }
        return await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action');
            if (denied) throw policy.problem(denied, 409);
            if (reserved.data.cartHash !== policy.cartHash(ctx.checkout.snapshot)) throw policy.problem('cart_changed', 409);
            await client.query(`UPDATE recovery_actions SET status=$2 WHERE id=$1`, [reserved.id, reserved.data.simulated ? 'simulated' : 'confirmed']);
            await event(client, shop.id, 'offer_created', { percent, simulated: reserved.data.simulated }, call.id);
            return reserved.data;
        });
    } catch {
        await db.query(`UPDATE recovery_actions SET status='unknown' WHERE id=$1 AND status='pending'`, [reserved.id]);
        throw policy.problem('offer_result_unknown_do_not_retry', 502);
    }
}

async function authorizeLink(client, call, shop, ctx) {
    const { rows: calls } = await client.query(`SELECT id FROM recovery_calls WHERE id=$1 AND shop_id=$2
        AND checkout_id=$3 AND contact_key=$4 AND identity_verified AND expires_at>NOW()
        AND status IN ('reserved','dialing','connected')`, [call.id, shop.id, call.checkout_id, ctx.checkout.contact_key]);
    if (!calls[0]) throw policy.problem('call_authorization_changed', 409);
    const { rows: transcripts } = await client.query(`SELECT data FROM recovery_events WHERE call_id=$1
        AND kind='user_transcript' AND created_at>NOW()-INTERVAL '2 minutes' ORDER BY created_at DESC LIMIT 1`, [call.id]);
    if (!policy.explicitSmsRequest(transcripts[0]?.data.text)) throw policy.problem('explicit_sms_request_required', 409);
    const { rows: offers } = await client.query(`SELECT id,status,data FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
    const offer = offers[0]?.data;
    if (!offers[0]) return { consentEvent: transcripts[0].data.eventId, offerId: null,
        cartHash: policy.cartHash(ctx.checkout.snapshot), checkoutUrl: policy.checkoutUrl(ctx.checkout.snapshot.checkoutUrl, shop) };
    if (!(shop.mode === 'simulation' ? ['confirmed','simulated'] : ['confirmed']).includes(offers[0].status) ||
        !Number.isFinite(+new Date(offer.expiresAt)) ||
        new Date(offer.expiresAt) <= new Date() || offer.cartHash !== policy.cartHash(ctx.checkout.snapshot) ||
        offer.currency !== ctx.checkout.currency || offer.percent > policy.rules(shop.rules).maxDiscountPercent) throw policy.problem('valid_offer_required', 409);
    policy.offer(shop.rules, ctx.checkout.subtotal_cents, offer.percent);
    return { consentEvent: transcripts[0].data.eventId, offerId: offers[0].id,
        cartHash: offer.cartHash, checkoutUrl: policy.checkoutUrl(offer.checkoutUrl, shop) };
}

async function sendLink(call) {
    if (!call.identity_verified) throw policy.problem('identity_required', 409);
    await refresh(call.customer_id, call.shop_id, call.checkout_id);
    const action = await transaction(async (client) => {
        const shop = await shopFor(call.customer_id, call.shop_id, client, true);
        const ctx = await state(client, shop, call.checkout_id, true);
        const denied = policy.eligibility(ctx, new Date(), 'action');
        if (denied) throw policy.problem(denied, 409);
        const { rows: prior } = await client.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`, [call.checkout_id]);
        if (prior[0]) return { duplicate: true, status: prior[0].status };
        if (shop.mode === 'live') telephony.assertSmsReady();
        const authorization = await authorizeLink(client, call, shop, ctx);
        const id = randomUUID();
        await client.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'sms',$3,$4)`,
        [id, call.checkout_id, shop.mode === 'simulation' ? 'simulated' : 'pending', JSON.stringify(authorization)]);
        return { id, authorization, number: ctx.checkout.phone,
            simulated: shop.mode === 'simulation' };
    });
    if (action.duplicate || action.simulated) return { status: action.status || 'simulated', duplicate: !!action.duplicate };
    let dispatched = false;
    try {
        const text = await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action');
            if (denied) throw policy.problem(denied, 409);
            const authorization = await authorizeLink(client, call, shop, ctx);
            if (ctx.checkout.phone !== action.number || Object.keys(action.authorization).some((key) =>
                authorization[key] !== action.authorization[key])) throw policy.problem('sms_authorization_changed', 409);
            return `${shop.brand}: Hier ist Ihr gewünschter Checkout-Link: ${authorization.checkoutUrl}`;
        });
        dispatched = true;
        const sent = await telephony.sendSms(action.number, text, action.id);
        const status = await transaction(async (client) => {
            const { rows } = await client.query('SELECT status,provider_id FROM recovery_actions WHERE id=$1 FOR UPDATE', [action.id]);
            const { rows: receipts } = await client.query(`SELECT status FROM recovery_sms_receipts WHERE action_id=$1 AND provider_id=$2`, [action.id, sent.id]);
            const acknowledged = sent.status === 'delivered' ? 'delivered' :
                ['failed','undelivered','canceled'].includes(sent.status) ? 'failed' : 'accepted';
            // A local stop can mark the intent failed while Twilio is accepting an already dispatched SMS.
            const status = rows[0].provider_id && ['delivered','failed'].includes(rows[0].status)
                ? rows[0].status : receipts[0]?.status || acknowledged;
            await client.query('UPDATE recovery_actions SET status=$2,provider_id=$3 WHERE id=$1', [action.id, status, sent.id]);
            return status;
        });
        return { status, delivered: status === 'delivered' };
    } catch (error) {
        if (error.smsDispatched === false) dispatched = false;
        await db.query(`UPDATE recovery_actions SET status=$2 WHERE id=$1 AND status='pending'`, [action.id, dispatched ? 'unknown' : 'failed']);
        if (!dispatched) throw error;
        throw policy.problem('sms_result_unknown_do_not_retry', 502);
    }
}

async function recordTranscript(call, input) {
    if (!uuid(input.eventId) || !['user', 'assistant'].includes(input.role) || typeof input.text !== 'string' || input.text.length > 4000) throw policy.problem('invalid_transcript');
    await event(db, call.shop_id, `${input.role}_transcript`, { text: input.text, eventId: input.eventId }, call.id, null, input.eventId);
    if (input.role === 'user' && policy.stopSignal(input.text)) return stopContact(call.customer_id, call.shop_id, call.checkout_id, 'spoken_opt_out');
    return { recorded: true };
}

async function confirmIdentity(call) {
    const { rows } = await db.query(`SELECT kind,data FROM recovery_events WHERE call_id=$1
        AND kind IN ('user_transcript','assistant_transcript') AND created_at>NOW()-INTERVAL '2 minutes'
        ORDER BY created_at DESC LIMIT 2`, [call.id]);
    if (rows[0]?.kind !== 'user_transcript' || rows[1]?.kind !== 'assistant_transcript' ||
        !/\b(ja|genau|richtig|am apparat|bin ich)\b/i.test(rows[0].data.text) ||
        /\b(nein|nicht|falsch)\b/i.test(rows[0].data.text) ||
        !/(person|rückruf|spreche ich)/i.test(rows[1].data.text)) throw policy.problem('identity_confirmation_required', 409);
    await db.query('UPDATE recovery_calls SET identity_verified=TRUE WHERE id=$1', [call.id]);
    return { identityVerified: true };
}

async function outcome(call, input) {
    if (!['interested', 'refused', 'wrong_person', 'voicemail', 'purchased_claimed', 'human_needed', 'no_answer'].includes(input.outcome) ||
        typeof input.summary !== 'string' || input.summary.length > 1000) throw policy.problem('invalid_outcome');
    if (['refused', 'wrong_person'].includes(input.outcome)) await stopContact(call.customer_id, call.shop_id, call.checkout_id, input.outcome);
    await db.query(`UPDATE recovery_calls SET outcome=$2,summary=$3 WHERE id=$1`, [call.id, input.outcome, input.summary]);
    return { recorded: true, purchaseConfirmed: false };
}

async function dashboard(customerId) {
    const { rows: shops } = await db.query(`SELECT id,domain,brand,brand_voice,mode,enabled,approved_at,rules,sync_at,last_error,webhooks_ready,currency
        FROM recovery_shops WHERE customer_id=$1 ORDER BY created_at`, [customerId]);
    const { rows: checkouts } = await db.query(`SELECT c.id,c.shop_id,c.external_id,c.status,c.arm,c.subtotal_cents,c.currency,
        c.source_updated_at,c.completed_at,c.snapshot->'items' AS items,RIGHT(c.phone,4) AS phone_suffix,
        p.consented_at,p.expires_at,p.stopped_at,p.evidence IS NOT NULL AS has_evidence,
        (SELECT COUNT(*)::int FROM recovery_calls a WHERE a.shop_id=c.shop_id AND a.contact_key=c.contact_key) AS attempts
        FROM recovery_checkouts c JOIN recovery_shops s ON s.id=c.shop_id
        LEFT JOIN recovery_contacts p ON p.shop_id=c.shop_id AND p.contact_key=c.contact_key
        WHERE s.customer_id=$1 ORDER BY c.created_at DESC LIMIT 100`, [customerId]);
    const { rows: calls } = await db.query(`SELECT a.id,a.checkout_id,a.shop_id,a.status,a.outcome,a.summary,a.cost_cents,a.created_at,s.currency
        FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id WHERE s.customer_id=$1 ORDER BY a.created_at DESC LIMIT 50`, [customerId]);
    const { rows: latency } = await db.query(`SELECT e.kind,COUNT(*)::int AS samples,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms) AS p50,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms) AS p95
        FROM recovery_events e JOIN recovery_shops s ON s.id=e.shop_id
        WHERE s.customer_id=$1 AND duration_ms IS NOT NULL AND s.mode='live' AND e.created_at>NOW()-INTERVAL '7 days'
        GROUP BY e.kind`, [customerId]);
    const { rows: experiment } = await db.query(`SELECT p.arm,s.id AS shop_id,
        EXISTS(SELECT 1 FROM recovery_orders o WHERE o.shop_id=p.shop_id AND o.contact_key=p.contact_key AND o.paid AND o.currency=s.currency
            AND o.ordered_at>=p.enrolled_at AND o.ordered_at<p.enrolled_at+INTERVAL '7 days') AS purchased,
        COALESCE((SELECT SUM(o.net_cents)*(p.experiment_rules->>'contributionPercent')::numeric/100
            FROM recovery_orders o WHERE o.shop_id=p.shop_id AND o.contact_key=p.contact_key AND o.paid AND o.currency=s.currency
            AND o.ordered_at>=p.enrolled_at AND o.ordered_at<p.enrolled_at+INTERVAL '7 days'),0) AS contribution_cents,
        (SELECT COALESCE(SUM(a.cost_cents),0) FROM recovery_calls a WHERE a.shop_id=p.shop_id AND a.contact_key=p.contact_key) AS costs_cents,
        (SELECT COUNT(*) FROM recovery_calls a WHERE a.shop_id=p.shop_id AND a.contact_key=p.contact_key AND a.cost_cents IS NULL) AS unknown_costs
        FROM recovery_contacts p JOIN recovery_shops s ON s.id=p.shop_id WHERE s.customer_id=$1 AND s.mode='live'
        AND p.enrolled_at<NOW()-INTERVAL '7 days'`, [customerId]);
    const { rows: cost } = await db.query(`SELECT s.currency,COALESCE(SUM(a.cost_cents),0)::int AS cents,
        COUNT(*) FILTER(WHERE a.cost_cents IS NULL AND a.status='ended')::int AS missing
        FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id WHERE s.customer_id=$1 AND s.mode='live'
        GROUP BY s.currency`, [customerId]);
    return { shops: shops.map((s) => ({ ...s, rules: policy.rules(s.rules) })), checkouts, calls, latency,
        experiments: shops.filter((s) => s.mode === 'live').map((s) => {
            const cohort = experiment.filter((e) => e.shop_id === s.id);
            const report = policy.experimentReport(cohort, cohort.reduce((sum, e) => sum + Number(e.costs_cents), 0));
            if (cohort.some((e) => Number(e.unknown_costs) > 0)) report.incrementalContributionCents = null;
            return { shopId: s.id, currency: s.currency, ...report };
        }),
        costs: cost.length === 1 ? cost[0] : { cents: cost.length ? null : 0, missing: cost.reduce((n,c) => n+c.missing,0), currency: null },
        costsByCurrency: cost, liveEnabled: process.env.RECOVERY_LIVE_ENABLED === '1',
        configured: { shopify: !!process.env.SHOPIFY_CLIENT_ID && !!process.env.SHOPIFY_CLIENT_SECRET,
            telephony: telephony.configured(), sms: process.env.RECOVERY_SMS_ENABLED === '1', browserDemo: process.env.GPT_LIVE_DEMO_ENABLED === '1',
            testShopDomain: process.env.RECOVERY_TEST_SHOP_DOMAIN || '' },
    };
}

module.exports = { uuid, hash, shopFor, state, saveSettings, consent, upsertCheckout, syncShop, refresh, startCall,
    stopContact, callContext, getContext, recordConnection, dailySummary, getOffer, sendLink, recordTranscript, confirmIdentity, outcome, dashboard };
