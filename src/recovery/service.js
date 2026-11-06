'use strict';

const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { db, transaction, event } = require('./store');
const policy = require('./policy');
const shopify = require('./shopify');
const telephony = require('./telephony');
const discounts = require('./discounts');
const agentProfile = require('./agent-profile');
const terms = require('./terms');
const { TwirpError } = require('livekit-server-sdk');

const hash = (text) => createHash('sha256').update(text).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

async function shopFor(customerId, shopId, executor = db, lock = false) {
    if (!uuid(shopId)) throw policy.problem('shop_not_found', 404);
    const { rows } = await executor.query(`SELECT s.*,EXISTS(SELECT 1 FROM recovery_terms_acceptances a
        WHERE a.customer_id=s.customer_id AND a.version=$3 AND a.document_hash=$4) AS terms_current
        FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE s.id=$1 AND s.customer_id=$2 AND c.is_active ${lock ? 'FOR UPDATE OF s' : ''}`, [shopId, customerId,terms.document.version,terms.hash]);
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
    const { rows: attempts } = await executor.query(`SELECT id,status,created_at,is_test FROM recovery_calls
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
        if (input.enabled && shop.mode === 'live' && !shop.terms_current) throw policy.problem('terms_acceptance_required',409);
        if (input.enabled && shop.mode === 'live' && !shop.webhooks_ready) throw policy.problem('webhooks_not_ready', 409);
        if (input.enabled && input.approval !== true && !shop.approved_at) throw policy.problem('explicit_merchant_approval_required');
        await client.query(`UPDATE recovery_shops SET brand=$3,brand_voice=$4,rules=$5,enabled=$6,
            campaign_started_at=CASE WHEN $6 AND mode='live' THEN COALESCE(campaign_started_at,NOW()) ELSE campaign_started_at END,
            approved_at=CASE WHEN $7 THEN NOW() ELSE approved_at END WHERE id=$1 AND customer_id=$2`,
        [shop.id, customerId, input.brand.trim(), input.brand_voice, JSON.stringify(nextRules), input.enabled, input.approval === true]);
        await event(client, shop.id, 'settings_saved', { enabled: input.enabled, rules: nextRules });
        return { saved: true };
    });
}

async function updateAgentProfile(customerId, shopId, input, userId) {
    const value = agentProfile.validate(input);
    if (!/^[1-9][0-9]*$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) throw policy.problem('admin_required', 403);
    return transaction(async (client) => {
        const actor = await client.query(`SELECT u.id FROM platform_users u JOIN customers c ON c.id=u.customer_id
            WHERE u.id=$1 AND u.customer_id=$2 AND u.role='admin' AND u.active AND c.is_active FOR SHARE OF u,c`,
        [userId,customerId]);
        if (!actor.rowCount) throw policy.problem('admin_required', 403);
        const shop = await shopFor(customerId, shopId, client, true);
        await client.query('UPDATE recovery_shops SET agent_profile=$3 WHERE id=$1 AND customer_id=$2',
            [shop.id,customerId,JSON.stringify(value)]);
        await event(client,shop.id,'agent_profile_saved',{ persona: value.persona,voice: value.voice,language: value.language });
        return { agentProfile: agentProfile.forShop({ ...shop,agent_profile: value }) };
    });
}

async function pauseShop(customerId, shopId, userId) {
    if (!/^[1-9][0-9]*$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) throw policy.problem('admin_required',403);
    await transaction(async client => {
        const actor=await client.query(`SELECT id FROM platform_users WHERE id=$1 AND customer_id=$2
            AND role='admin' AND active FOR SHARE`,[userId,customerId]);
        if (!actor.rowCount) throw policy.problem('admin_required',403);
        const shop=await shopFor(customerId,shopId,client,true);
        await client.query('UPDATE recovery_shops SET enabled=FALSE WHERE id=$1 AND customer_id=$2',[shop.id,customerId]);
        if (shop.enabled) await event(client,shop.id,'campaign_paused',{userId:Number(userId)});
    });
    await require('./webhooks').reconcileStops(shopId);
    return {paused:true};
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
    await client.query(`UPDATE recovery_checkouts c SET status='stopped' FROM recovery_contacts p
        WHERE c.shop_id=$1 AND c.external_id=$2 AND p.shop_id=c.shop_id AND p.contact_key=c.contact_key
        AND p.stopped_at IS NOT NULL AND c.completed_at IS NULL AND c.status!='converted'`, [shop.id,snapshot.id]);
}

async function syncShop(customerId, shopId) {
    const shop = await shopFor(customerId, shopId);
    if (shop.mode === 'simulation') return { simulated: true, imported: 0 };
    try {
        const nodes = await shopify.listCheckouts(shop);
        let imported = 0;
        const skippedReasons = {};
        await transaction(async (client) => {
            await shopFor(customerId, shopId, client, true);
            for (const node of nodes) {
                let snapshot;
                try { snapshot = shopify.normalizeCheckout(node, shop); }
                catch (error) {
                    // A single unsupported cart must not block the other verified carts.
                    if (!['unsupported_currency','mixed_cart_currency','invalid_checkout_host','cart_too_large','invalid_cart_items'].includes(error.code)) throw error;
                    skippedReasons[error.code] = (skippedReasons[error.code] || 0) + 1;
                    continue;
                }
                await upsertCheckout(client, shop, snapshot);
                imported++;
            }
            if (nodes.length !== imported) await event(client, shop.id, 'checkout_sync_skipped', { count: nodes.length-imported, reasons: skippedReasons });
            await client.query('UPDATE recovery_shops SET sync_at=NOW(),last_error=NULL WHERE id=$1', [shop.id]);
        });
        return { imported, skipped: nodes.length-imported, skippedReasons };
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

async function startCall(customerId, shopId, checkoutId, options = {}) {
    const ownerTest = options.ownerTest===true;
    let testNumber;
    if (ownerTest) {
        if (process.env.RECOVERY_OWNER_TEST_ENABLED!=='1' || process.env.RECOVERY_OWNER_TEST_SHOP_ID!==shopId) {
            throw policy.problem('owner_test_not_authorized',409);
        }
        try { testNumber=policy.phone(process.env.RECOVERY_OWNER_TEST_PHONE); }
        catch { throw policy.problem('owner_test_not_authorized',409); }
    }
    const refreshed = await refresh(customerId, shopId, checkoutId);
    const reservation = await transaction(async (client) => {
        // Shared with the restricted release receiver: pause and reservation must serialize.
        await client.query('SELECT pg_advisory_xact_lock(72632026029)');
        const guard = await client.query('SELECT paused_until>NOW() AS paused FROM recovery_deployment_guard WHERE id=1');
        if (guard.rowCount!==1 || guard.rows[0].paused) throw policy.problem('deployment_in_progress',503);
        const shop = await shopFor(customerId, shopId, client, true);
        const ctx = await state(client, shop, checkoutId, true);
        if (ownerTest && (shop.mode!=='live' || ctx.checkout.phone!==testNumber)) throw policy.problem('owner_test_not_authorized',409);
        const denied = policy.eligibility(ctx,new Date(),'call',ownerTest);
        if (denied) throw policy.problem(denied, 409);
        if (shop.mode === 'live' && !shop.webhooks_ready) throw policy.problem('webhooks_not_ready', 409);
        if (shop.mode === 'live' && (process.env.RECOVERY_LIVE_ENABLED !== '1' || !telephony.configured(shop.id))) {
            throw policy.problem('live_calls_disabled', 409);
        }
        // shortcut: one active call per shop in the pilot; widen with a tested budgeted scheduler.
        const busy = await client.query(`SELECT 1 FROM recovery_calls WHERE shop_id=$1 AND status IN ('reserved','dialing','connected','unknown') LIMIT 1`, [shop.id]);
        if (busy.rowCount) throw policy.problem('shop_busy', 409);
        const arm = ownerTest ? null : await enroll(client, ctx);
        if (arm === 'control') return { control: true };
        const id = randomUUID(), token = randomBytes(32).toString('hex'), room = `recovery-${id}`;
        await client.query(`INSERT INTO recovery_calls(id,shop_id,checkout_id,contact_key,room,token_hash,expires_at,status,is_test)
            VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '15 minutes',$7,$8)`,
        [id, shop.id, checkoutId, ctx.checkout.contact_key, room, hash(token), shop.mode === 'simulation' ? 'simulated' : 'reserved',ownerTest]);
        if (shop.mode === 'live') await event(client, shop.id, 'call_authorization', {
            source: policy.merchantManagedContacts(shop) ? 'merchant_managed' : 'individual_evidence', checkoutId,
        }, id);
        if (shop.mode === 'simulation') {
            await event(client, shop.id, 'simulation_call', { checkoutId, noExternalAction: true }, id);
            return { simulated: true, id };
        }
        return { id, room, token,shop_id:shop.id,number: ctx.checkout.phone,contactKey: ctx.checkout.contact_key };
    });
    if (reservation.control || reservation.simulated) return reservation;
    // The intent is durable before contacting the provider. Ambiguous failures never auto-retry.
    try {
        // Warm descriptive knowledge only for an authorized reservation, before dialing.
        await require('./knowledge').forCart(refreshed.shop,refreshed.checkout.snapshot.items,true);
        await refresh(customerId,shopId,checkoutId);
        const number = await transaction(async (client) => {
            const shop = await shopFor(customerId, shopId, client, true);
            const ctx = await state(client, shop, checkoutId, true);
            const denied = policy.eligibility(ctx, new Date(), 'action',ownerTest);
            if (denied) throw policy.problem(denied, 409);
            if (ctx.checkout.phone!==reservation.number || ctx.checkout.contact_key!==reservation.contactKey ||
                (ownerTest && ctx.checkout.phone!==testNumber)) throw policy.problem('call_authorization_changed',409);
            return ctx.checkout.phone;
        });
        await telephony.dial(reservation, number, reservation.token);
        const acknowledged = await db.query(`UPDATE recovery_calls SET dialed_at=COALESCE(dialed_at,NOW()),
            status=CASE WHEN status='reserved' THEN 'dialing' ELSE status END WHERE id=$1 RETURNING status`, [reservation.id]);
        const latest = await state(db, await shopFor(customerId, shopId), checkoutId);
        if (policy.eligibility(latest,new Date(),'action',ownerTest) || latest.checkout.phone!==reservation.number ||
            latest.checkout.contact_key!==reservation.contactKey) await telephony.hangup(reservation.room);
        await db.query(`UPDATE recovery_checkouts SET status='calling' WHERE id=$1 AND shop_id=$2 AND status='pending'
            AND EXISTS(SELECT 1 FROM recovery_calls WHERE id=$3 AND status IN ('dialing','connected'))`, [checkoutId, shopId, reservation.id]);
        return { id: reservation.id, status: acknowledged.rows[0].status };
    } catch {
        await db.query(`UPDATE recovery_calls SET status='unknown',outcome='provider_result_unconfirmed'
            WHERE id=$1 AND ended_at IS NULL AND status!='ended'`, [reservation.id]);
        throw policy.problem('call_result_unknown_do_not_retry', 502);
    }
}

async function stopContact(customerId, shopId, checkoutId, reason = 'merchant_stop', callId = null) {
    if (callId !== null && !uuid(callId)) throw policy.problem('invalid_call_token',401);
    const rooms = await transaction(async (client) => {
        const shop = await shopFor(customerId, shopId, client, true);
        const ctx = await state(client, shop, checkoutId, true);
        let contactKey = ctx.checkout.contact_key;
        if (callId !== null) {
            // A checkout phone can change during a call; opt-out belongs to the number actually called.
            const { rows } = await client.query(`SELECT contact_key FROM recovery_calls
                WHERE id=$1 AND shop_id=$2 AND checkout_id=$3`, [callId,shop.id,checkoutId]);
            if (!rows[0]) throw policy.problem('invalid_call_token',401);
            contactKey = rows[0].contact_key;
        }
        if (contactKey) await client.query(`UPDATE recovery_contacts SET stopped_at=COALESCE(stopped_at,NOW()),
            revoked_at=COALESCE(revoked_at,NOW()),stop_reason=COALESCE(stop_reason,$3) WHERE shop_id=$1 AND contact_key=$2`,
        [shop.id, contactKey, String(reason).slice(0, 100)]);
        await client.query(`UPDATE recovery_checkouts SET status='stopped' WHERE shop_id=$1 AND
            (contact_key=$2 OR ($4::boolean AND id=$3)) AND status!='converted'`, [shop.id, contactKey, checkoutId, callId === null]);
        await client.query(`UPDATE recovery_actions SET status='failed' WHERE status='pending' AND checkout_id IN
            (SELECT id FROM recovery_checkouts WHERE shop_id=$1 AND (contact_key=$2 OR id=$3))`, [shop.id, contactKey, checkoutId]);
        await event(client, shop.id, 'contact_stopped', { checkoutId, contactKey, reason: String(reason).slice(0, 100) }, callId);
        const { rows: active } = await client.query(`SELECT id FROM recovery_calls WHERE shop_id=$1 AND contact_key=$2
            AND status IN ('reserved','dialing','connected','unknown')`, [shop.id,contactKey]);
        return active.map((a) => `recovery-${a.id}`);
    });
    const results = await Promise.allSettled(rooms.map(telephony.hangup));
    return { stopped: true, hangupPending: results.some((r) => r.status === 'rejected') };
}

async function callContext(token, cleanup = false) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw policy.problem('invalid_call_token', 401);
    const { rows } = await db.query(`SELECT a.*,s.customer_id FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
        JOIN customers c ON c.id=s.customer_id WHERE a.token_hash=$1 AND
        ((a.expires_at>NOW() AND a.status IN ('reserved','dialing','connected') AND c.is_active
            AND a.outcome IS DISTINCT FROM 'voicemail' AND a.outcome IS DISTINCT FROM 'no_answer')
        OR ($2::boolean AND s.mode='live' AND a.status!='simulated'))`, [hash(token), cleanup]);
    if (!rows[0]) throw policy.problem('invalid_call_token', 401);
    return rows[0];
}

async function endCall(call) {
    const { rows } = await db.query(`SELECT a.* FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
        WHERE a.id=$1 AND a.shop_id=$2 AND a.checkout_id=$3 AND s.customer_id=$4
        AND s.mode='live' AND a.status!='simulated'`, [call.id,call.shop_id,call.checkout_id,call.customer_id]);
    const actual = rows[0];
    if (!actual || actual.room!==`recovery-${actual.id}`) throw policy.problem('invalid_call_token',401);
    if (actual.status==='ended' && actual.ended_at) return { ended: true };
    try { await telephony.hangup(actual.room); }
    catch (error) {
        if (!(error instanceof TwirpError && error.status===404 && error.code==='not_found')) throw error;
    }
    await transaction(async (client) => {
        await client.query(`UPDATE recovery_calls SET status='ended',ended_at=COALESCE(ended_at,NOW())
            WHERE id=$1 AND shop_id=$2 AND checkout_id=$3`, [actual.id,actual.shop_id,actual.checkout_id]);
        await client.query(`UPDATE recovery_checkouts SET status='contacted' WHERE id=$1 AND shop_id=$2 AND status='calling'`,
            [actual.checkout_id,actual.shop_id]);
        // Room deletion confirms cleanup, but supplies no SIP duration or billable cost.
        await event(client,actual.shop_id,'call_cleanup_confirmed',{ source: 'livekit_delete_room' },actual.id);
    });
    return { ended: true };
}

async function endUnreached(call, outcome) {
    if (!['voicemail','no_answer'].includes(outcome)) throw policy.problem('invalid_unreached_outcome');
    await transaction(async client => {
        await client.query('SELECT id FROM recovery_shops WHERE id=$1 AND customer_id=$2 FOR UPDATE',[call.shop_id,call.customer_id]);
        const { rows:[actual] }=await client.query(`SELECT a.* FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
            WHERE a.id=$1 AND a.shop_id=$2 AND a.checkout_id=$3 AND s.customer_id=$4
            AND s.mode='live' AND a.status!='simulated' FOR UPDATE OF a`,[call.id,call.shop_id,call.checkout_id,call.customer_id]);
        if (!actual || actual.room!==`recovery-${actual.id}`) throw policy.problem('invalid_call_token',401);
        if ((actual.ended_at && actual.outcome) || ['voicemail','no_answer'].includes(actual.outcome)) return;
        // Persist the terminal intent before the provider request; never pretend a failed hangup succeeded.
        await client.query(`UPDATE recovery_calls SET outcome=$2,summary=$3,status=CASE WHEN ended_at IS NULL THEN 'unknown' ELSE status END WHERE id=$1`,
        [actual.id,outcome,outcome==='voicemail' ? 'Mailbox erkannt; keine Nachricht hinterlassen.' : 'Kein persönliches Gespräch zustande gekommen; Anruf beendet.']);
        await event(client,actual.shop_id,'unreached_hangup_requested',{outcome},actual.id);
    });
    return endCall(call);
}

async function getContext(call) {
    // Legacy identity_verified records permission to continue this conversation, not verified personal identity.
    // startCall refreshed this snapshot before dialing. The opening can use its product data without another Shopify round trip.
    const ctx = call.identity_verified ? await refresh(call.customer_id, call.shop_id, call.checkout_id) :
        await require('./catalog').authorized(call,db,false,false);
    const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
    if (denied) throw policy.problem(denied, 409);
    const [knowledge,availableDiscounts] = await Promise.all([
        require('./knowledge').forCart(ctx.shop,ctx.checkout.snapshot.items),
        discounts.available(ctx.shop,ctx.checkout.subtotal_cents),
    ]);
    // Contact permission can change while Shopify is responding.
    await require('./catalog').authorized(call,db,false,Boolean(call.identity_verified));
    const cart = { currency: ctx.checkout.currency, subtotalCents: ctx.checkout.subtotal_cents, items: ctx.checkout.snapshot.items,
        shipping: 'unknown_until_checkout', taxes: 'unknown_until_checkout' };
    return { brand: ctx.shop.brand, brandVoice: ctx.shop.brand_voice, agentProfile: agentProfile.forShop(ctx.shop,cart), contactConfirmed: Boolean(call.identity_verified),
        supportEmail: ctx.checkout.snapshot.supportEmail || null,
        cart, verifiedAt: ctx.checkout.verified_at,
        maxDiscountPercent: policy.rules(ctx.shop.rules).maxDiscountPercent,
        availableDiscounts,knowledge };
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

async function dailySummary(customerId, asOf = new Date(), shopId = null) {
    if (!(asOf instanceof Date) || !Number.isFinite(+asOf)) throw policy.problem('invalid_summary_time');
    if (shopId!==null && !uuid(shopId)) throw policy.problem('shop_not_found',404);
    const { rows } = await db.query(`WITH shops AS (
        SELECT s.id,s.brand,s.domain,s.currency,s.enabled,COALESCE(s.rules->>'timezone','Europe/Berlin') AS timezone
        FROM recovery_shops s JOIN customers c ON c.id=s.customer_id
        WHERE s.customer_id=$1 AND c.is_active AND s.mode='live' AND ($3::uuid IS NULL OR s.id=$3)
    ), days AS (
        SELECT *,to_char($2::timestamptz AT TIME ZONE timezone,'YYYY-MM-DD') AS date,
            date_trunc('day',$2::timestamptz AT TIME ZONE timezone) AT TIME ZONE timezone AS starts_at,
            (date_trunc('day',$2::timestamptz AT TIME ZONE timezone)+INTERVAL '1 day') AT TIME ZONE timezone AS ends_at
        FROM shops
    ) SELECT d.id,d.brand,d.domain,d.enabled,d.timezone AS "timeZone",d.date,
        (SELECT count(*)::int FROM recovery_calls a WHERE a.shop_id=d.id AND a.status!='simulated'
            AND a.dialed_at>=d.starts_at AND a.dialed_at<d.ends_at) AS "callsToday",
        (SELECT count(*)::int FROM recovery_orders o WHERE o.shop_id=d.id AND o.paid AND NOT o.is_test AND o.currency=d.currency
            AND o.paid_at>=d.starts_at AND o.paid_at<d.ends_at AND EXISTS (
                SELECT 1 FROM recovery_checkouts checkout JOIN recovery_calls a ON a.checkout_id=checkout.id AND a.shop_id=checkout.shop_id
                WHERE checkout.shop_id=o.shop_id AND a.status!='simulated' AND NOT a.is_test AND a.connected_at IS NOT NULL AND a.outcome IS DISTINCT FROM 'voicemail' AND a.outcome IS DISTINCT FROM 'no_answer'
                    AND o.paid_at>a.connected_at AND o.paid_at<a.connected_at+INTERVAL '168 hours'
                    AND (o.recovery_checkout_id=checkout.id OR (o.checkout_token IS NOT NULL AND o.checkout_token=checkout.checkout_token) OR o.checkout_external_id=checkout.external_id)
            )) AS "confirmedCheckoutsToday"
        FROM days d ORDER BY d.brand,d.id`, [customerId, asOf.toISOString(),shopId]);
    return { asOf: asOf.toISOString(), shops: rows };
}

async function getOffer(call, percent, discountId) {
    if (!call.identity_verified) throw policy.problem('contact_confirmation_required', 409);
    const current = await refresh(call.customer_id, call.shop_id, call.checkout_id);
    const previous = await db.query(`SELECT data FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
    const selected = discountId ?? previous.rows[0]?.data.discountId;
    const approved = selected ? await discounts.verify(current.shop,selected,current.checkout.subtotal_cents) : null;
    if (discountId!==undefined && discountId!==null && !uuid(discountId)) throw policy.problem('discount_not_available',409);
    if (approved) percent = approved.percent;
    const reserved = await transaction(async (client) => {
        const shop = await shopFor(call.customer_id, call.shop_id, client, true);
        const ctx = await state(client, shop, call.checkout_id, true);
        const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
        if (denied) throw policy.problem(denied, 409);
        const snapshot = ctx.checkout.snapshot;
        if (!snapshot.items?.length || snapshot.items.some((i) => !i.available || !i.variantId ||
            i.currentPriceCents !== i.originalUnitCents) || snapshot.discountCodes?.length) throw policy.problem('cart_offer_needs_review', 409);
        if (percent && !approved && shop.mode === 'live') throw policy.problem('approved_discount_required',409);
        const amount = policy.offer(shop.rules, ctx.checkout.subtotal_cents, percent);
        if (approved) await discounts.assertApproved(client,shop,approved,ctx.checkout.subtotal_cents);
        const { rows } = await client.query(`SELECT * FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
        if (rows[0]) {
            if (shop.mode === 'live' && rows[0].data.percent && !approved) throw policy.problem('approved_discount_required',409);
            if (!['confirmed', 'simulated'].includes(rows[0].status) || new Date(rows[0].data.expiresAt) <= new Date() ||
                rows[0].data.cartHash !== policy.cartHash(snapshot) ||
                rows[0].data.percent > policy.rules(shop.rules).maxDiscountPercent ||
                (approved && (rows[0].data.discountId!==approved.id || rows[0].data.discountFingerprint!==approved.fingerprint))) throw policy.problem('offer_not_valid', 409);
            return { existing: true, data: rows[0].data };
        }
        const code = approved?.code || (percent ? `RC${randomBytes(8).toString('hex').toUpperCase()}` : null);
        const expiresAt = new Date(Math.min(Date.now() + policy.rules(shop.rules).offerHours * 3600000,
            approved?.expiresAt ? Date.parse(approved.expiresAt) : Infinity)).toISOString();
        const result = { ...amount, currency: ctx.checkout.currency, code, expiresAt, checkoutUrl: policy.checkoutUrl(snapshot.checkoutUrl, shop, code),
            cartHash: policy.cartHash(snapshot), simulated: shop.mode === 'simulation',
            ...(approved ? { discountId: approved.id,discountFingerprint: approved.fingerprint } : {}) };
        // Commit the code before Shopify is called: crashes/timeouts cannot create a second offer.
        const id = randomUUID();
        await client.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'offer',$3,$4)`,
        [id, call.checkout_id, 'pending', JSON.stringify(result)]);
        return { id, data: result };
    });
    if (reserved.existing) return reserved.data;
    try {
        await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
            if (denied) throw policy.problem(denied, 409);
            policy.offer(shop.rules, ctx.checkout.subtotal_cents, reserved.data.percent);
            if (approved) await discounts.assertApproved(client,shop,approved,ctx.checkout.subtotal_cents);
            if (reserved.data.cartHash !== policy.cartHash(ctx.checkout.snapshot)) throw policy.problem('cart_changed', 409);
        });
        return await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
            if (denied) throw policy.problem(denied, 409);
            if (approved) await discounts.assertApproved(client,shop,approved,ctx.checkout.subtotal_cents);
            if (reserved.data.cartHash !== policy.cartHash(ctx.checkout.snapshot)) throw policy.problem('cart_changed', 409);
            await client.query(`UPDATE recovery_actions SET status=$2 WHERE id=$1`, [reserved.id, reserved.data.simulated ? 'simulated' : 'confirmed']);
            await event(client, shop.id, 'offer_created', { percent, simulated: reserved.data.simulated }, call.id);
            return reserved.data;
        });
    } catch (error) {
        await db.query(`UPDATE recovery_actions SET status=$2 WHERE id=$1 AND status='pending'`, [reserved.id,approved ? 'failed' : 'unknown']);
        if (approved) throw error;
        throw policy.problem('offer_result_unknown_do_not_retry', 502);
    }
}

// The reasoning agent interprets intent; the worker supplies the actual committed user event.
async function conversationEvidence(client, call, userEventId) {
    if (!uuid(userEventId)) throw policy.problem('conversation_evidence_required', 409);
    const { rows } = await client.query(`SELECT data,created_at FROM recovery_events WHERE call_id=$1 AND shop_id=$2
        AND kind='user_transcript' AND created_at>NOW()-INTERVAL '2 minutes'
        ORDER BY created_at DESC LIMIT 1`, [call.id,call.shop_id]);
    if (rows[0]?.data.eventId !== userEventId) throw policy.problem('conversation_changed', 409);
    return rows[0];
}

async function authorizeLink(client, call, shop, ctx, discountProof, useDiscount, userEventId, preparedCheckoutId, preparedProof, article = null) {
    const { rows: calls } = await client.query(`SELECT id FROM recovery_calls WHERE id=$1 AND shop_id=$2
        AND checkout_id=$3 AND contact_key=$4 AND identity_verified AND expires_at>NOW()
        AND ended_at IS NULL AND status IN ('reserved','dialing','connected')`, [call.id, shop.id, call.checkout_id, ctx.checkout.contact_key]);
    if (!calls[0]) throw policy.problem('call_authorization_changed', 409);
    const consent = await conversationEvidence(client, call, userEventId);
    if(article) return {messageType:'help_article',targetKey:`article:${article.articleId}`,
        consentEvent:consent.data.eventId,articleId:article.articleId,articleTitle:article.title,articleUrl:article.url};
    if (preparedCheckoutId) return require('./catalog').authorizeProposal(client,call,shop,preparedCheckoutId,preparedProof,useDiscount,consent);
    if (!useDiscount) {
        const plain = new URL(policy.checkoutUrl(ctx.checkout.snapshot.checkoutUrl, shop));
        plain.searchParams.delete('discount');
        return { consentEvent: consent.data.eventId, offerId: null,
            cartHash: policy.cartHash(ctx.checkout.snapshot), checkoutUrl: plain.href };
    }
    const { rows: offers } = await client.query(`SELECT id,status,data,created_at FROM recovery_actions WHERE checkout_id=$1 AND kind='offer'`, [call.checkout_id]);
    const offer = offers[0]?.data;
    if (!offers[0] || !offer.code || !(offer.percent > 0)) throw policy.problem('valid_offer_required', 409);
    if (!(shop.mode === 'simulation' ? ['confirmed','simulated'] : ['confirmed']).includes(offers[0].status) ||
        !Number.isFinite(+new Date(offer.expiresAt)) ||
        new Date(offer.expiresAt) <= new Date() || offer.cartHash !== policy.cartHash(ctx.checkout.snapshot) ||
        offer.currency !== ctx.checkout.currency || offer.percent > policy.rules(shop.rules).maxDiscountPercent) throw policy.problem('valid_offer_required', 409);
    if (shop.mode === 'live' && !offer.discountId) throw policy.problem('approved_discount_required',409);
    policy.offer(shop.rules, ctx.checkout.subtotal_cents, offer.percent);
    if (offer.discountId) {
        await discounts.assertApproved(client,shop,discountProof,ctx.checkout.subtotal_cents);
        if (discountProof.id!==offer.discountId || discountProof.fingerprint!==offer.discountFingerprint ||
            discountProof.code!==offer.code || discountProof.percent!==offer.percent ||
            (discountProof.expiresAt!==null && new Date(offer.expiresAt)>new Date(discountProof.expiresAt))) throw policy.problem('valid_offer_required',409);
    }
    // Speech must precede the user's response and belong to the current confirmed offer.
    // Its meaning is interpreted by GPT Live; interrupted speech cannot establish an offer review.
    const { rows: reviews } = await client.query(`SELECT review.data FROM recovery_events review
        JOIN recovery_actions offer ON offer.id=$3
        JOIN recovery_events consent ON consent.call_id=$1 AND consent.kind='user_transcript' AND consent.data->>'eventId'=$4
        WHERE review.call_id=$1 AND review.shop_id=$2 AND review.kind='assistant_transcript'
        AND review.created_at >= offer.created_at AND review.created_at < consent.created_at
        ORDER BY review.created_at DESC LIMIT 1`, [call.id,shop.id,offers[0].id,consent.data.eventId]);
    if (!reviews[0] || reviews[0].data.interrupted === true) throw policy.problem('discount_review_required', 409);
    const agreementEvent = consent.data.eventId;
    return { consentEvent: consent.data.eventId, agreementEvent, offerId: offers[0].id,
        cartHash: offer.cartHash, checkoutUrl: policy.checkoutUrl(offer.checkoutUrl, shop) };
}

async function sendHelpArticle(call, variantId, articleId, userEventId) {
    return sendLink(call,false,userEventId,null,{variantId,articleId});
}

async function resolveHelpArticle(call, reference) {
    const details=await require('./catalog').productDetails(call,reference.variantId);
    return require('./zendesk').articleLink(details,reference.articleId);
}

async function sendLink(call, useDiscount = false, userEventId, preparedCheckoutId = null, helpReference = null) {
    if (preparedCheckoutId !== null && !uuid(preparedCheckoutId)) throw policy.problem('invalid_prepared_checkout');
    if (typeof useDiscount !== 'boolean') throw policy.problem('invalid_discount_selection');
    if (!call.identity_verified) throw policy.problem('contact_confirmation_required', 409);
    await refresh(call.customer_id, call.shop_id, call.checkout_id);
    const article = helpReference ? await resolveHelpArticle(call,helpReference) : null;
    const initialDiscountProof = useDiscount && !preparedCheckoutId ? await discounts.offerProof(call) : null;
    const preparedProof = preparedCheckoutId ? await require('./catalog').verifyProposal(call,preparedCheckoutId,useDiscount) : null;
    const action = await transaction(async (client) => {
        const shop = await shopFor(call.customer_id, call.shop_id, client, true);
        const ctx = await state(client, shop, call.checkout_id, true);
        const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
        if (denied) throw policy.problem(denied, 409);
        const authorization = preparedCheckoutId || article ? await authorizeLink(client,call,shop,ctx,null,useDiscount,userEventId,preparedCheckoutId,preparedProof,article) : null;
        const { rows: prior } = await client.query(`SELECT status FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'
            AND COALESCE(data->>'targetKey','original')=$2`, [call.checkout_id,authorization?.targetKey || 'original']);
        if (prior[0]) return { duplicate: true, status: prior[0].status };
        if (shop.mode === 'live') telephony.assertSmsReady(shop.id);
        const confirmed = authorization || await authorizeLink(client, call, shop, ctx, initialDiscountProof, useDiscount, userEventId);
        const count = await client.query(`SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE data->>'messageType'='help_article')::int AS help_count
            FROM recovery_actions WHERE checkout_id=$1 AND kind='sms'`,[call.checkout_id]);
        if (count.rows[0].n >= 3) throw policy.problem('sms_attempt_limit',409);
        // Reserve one of the existing three SMS slots for a checkout link.
        if(article && count.rows[0].help_count>=2) throw policy.problem('help_article_limit',409);
        const id = randomUUID();
        await client.query(`INSERT INTO recovery_actions(id,checkout_id,kind,status,data) VALUES($1,$2,'sms',$3,$4)`,
        [id, call.checkout_id, shop.mode === 'simulation' ? 'simulated' : 'pending', JSON.stringify(confirmed)]);
        const trackingUrl=shop.mode==='live' && !article ? await require('./sms-links').create(client,id,call.id) : null;
        return { id, authorization: confirmed, number: ctx.checkout.phone, trackingUrl,
            simulated: shop.mode === 'simulation' };
    });
    if (action.duplicate || action.simulated) return { status: action.status || 'simulated', duplicate: !!action.duplicate };
    let dispatched = false;
    try {
        const latestDiscountProof = useDiscount && !preparedCheckoutId ? await discounts.offerProof(call) : null;
        const latestPreparedProof = preparedCheckoutId ? await require('./catalog').verifyProposal(call,preparedCheckoutId,useDiscount) : null;
        const latestArticle = helpReference ? await resolveHelpArticle(call,helpReference) : null;
        const text = await transaction(async (client) => {
            const shop = await shopFor(call.customer_id, call.shop_id, client, true);
            const ctx = await state(client, shop, call.checkout_id, true);
            const denied = policy.eligibility(ctx, new Date(), 'action',call.is_test===true);
            if (denied) throw policy.problem(denied, 409);
            const authorization = await authorizeLink(client, call, shop, ctx, latestDiscountProof, useDiscount, userEventId, preparedCheckoutId, latestPreparedProof,latestArticle);
            if (ctx.checkout.phone !== action.number || Object.keys(action.authorization).some((key) =>
                authorization[key] !== action.authorization[key])) throw policy.problem('sms_authorization_changed', 409);
            return article ? `${shop.brand}: Hier ist der gewünschte Hilfeartikel: ${authorization.articleUrl}` :
                `${shop.brand}: Hier ist Ihr gewünschter Checkout-Link: ${action.trackingUrl || authorization.checkoutUrl}`;
        });
        dispatched = true;
        const sent = await telephony.sendSms(action.number, text, action.id, call.shop_id);
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
    if (!uuid(input.eventId) || !['user', 'assistant'].includes(input.role) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 ||
        (input.interrupted !== undefined && typeof input.interrupted !== 'boolean')) throw policy.problem('invalid_transcript');
    await event(db, call.shop_id, `${input.role}_transcript`, { text: input.text, eventId: input.eventId, interrupted: input.interrupted === true }, call.id, null, input.eventId);
    return { recorded: true };
}

async function confirmContact(call, userEventId) {
    return transaction(async (client) => {
        const shop = await shopFor(call.customer_id,call.shop_id,client,true);
        const ctx = await state(client,shop,call.checkout_id,true);
        const denied = policy.eligibility(ctx,new Date(),'action',call.is_test===true);
        if (denied) throw policy.problem(denied,409);
        await conversationEvidence(client, call, userEventId);
        const confirmed = await client.query(`UPDATE recovery_calls SET identity_verified=TRUE
            WHERE id=$1 AND shop_id=$2 AND checkout_id=$3 AND contact_key=$4
            AND expires_at>NOW() AND ended_at IS NULL AND status IN ('reserved','dialing','connected') RETURNING id`,
        [call.id,shop.id,ctx.checkout.id,ctx.checkout.contact_key]);
        if (!confirmed.rowCount) throw policy.problem('invalid_call_token',401);
        return { contactConfirmed: true };
    });
}

async function outcome(call, input) {
    if (!['interested', 'undecided', 'refused', 'wrong_person', 'voicemail', 'purchased_claimed', 'human_needed', 'no_answer'].includes(input.outcome) ||
        typeof input.summary !== 'string' || input.summary.length > 1000) throw policy.problem('invalid_outcome');
    if (input.outcome==='voicemail') return endUnreached(call,'voicemail');
    if (['refused', 'wrong_person'].includes(input.outcome)) await stopContact(call.customer_id, call.shop_id, call.checkout_id, input.outcome, call.id);
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
        EXISTS(SELECT 1 FROM recovery_orders o WHERE o.shop_id=p.shop_id AND o.contact_key=p.contact_key AND o.paid AND NOT o.is_test AND o.currency=s.currency
            AND o.ordered_at>=p.enrolled_at AND o.ordered_at<p.enrolled_at+INTERVAL '7 days') AS purchased,
        COALESCE((SELECT SUM(o.net_cents)*(p.experiment_rules->>'contributionPercent')::numeric/100
            FROM recovery_orders o WHERE o.shop_id=p.shop_id AND o.contact_key=p.contact_key AND o.paid AND NOT o.is_test AND o.currency=s.currency
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
            telephony: shops.some(shop => telephony.configured(shop.id)), sms: process.env.RECOVERY_SMS_ENABLED === '1', browserDemo: process.env.GPT_LIVE_DEMO_ENABLED === '1',
            testShopDomain: process.env.RECOVERY_TEST_SHOP_DOMAIN || '' },
    };
}

module.exports = { conversationEvidence, uuid, hash, shopFor, state, saveSettings, pauseShop, updateAgentProfile, consent, upsertCheckout, syncShop, refresh, startCall,
    stopContact, callContext, endCall, endUnreached, getContext, recordConnection, dailySummary, getOffer, sendLink, sendHelpArticle, recordTranscript, confirmContact, outcome, dashboard };
