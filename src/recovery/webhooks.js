'use strict';

const { randomUUID, timingSafeEqual } = require('node:crypto');
const express = require('express');
const { db, transaction, event } = require('./store');
const shopify = require('./shopify');
const policy = require('./policy');
const service = require('./service');
const telephony = require('./telephony');
const { twilioSignature } = require('./twilio-signature');

async function ingestShopify(shop, topic, payload, eventId) {
    return transaction(async (client) => {
        await client.query('SELECT id FROM recovery_shops WHERE id=$1 FOR UPDATE', [shop.id]);
        const inserted = await client.query(`INSERT INTO recovery_webhooks(shop_id,event_id) VALUES($1,$2)
            ON CONFLICT DO NOTHING RETURNING event_id`, [shop.id, eventId]);
        if (!inserted.rowCount) return { duplicate: true };
        if (topic === 'app/uninstalled' || topic === 'shop/redact') {
            await client.query('DELETE FROM recovery_followup_tickets t USING recovery_calls a WHERE t.call_id=a.id AND a.shop_id=$1',[shop.id]);
            await client.query(`DELETE FROM recovery_sms_links l USING recovery_actions a,recovery_checkouts c
                WHERE l.action_id=a.id AND a.checkout_id=c.id AND c.shop_id=$1`,[shop.id]);
            await client.query(`UPDATE recovery_shops SET enabled=FALSE,approved_at=NULL,credentials_encrypted=NULL,webhooks_ready=FALSE WHERE id=$1`, [shop.id]);
            if (topic === 'shop/redact') {
                await client.query(`UPDATE recovery_contacts SET phone='',evidence=NULL,consented_at=NULL,
                    stopped_at=NOW(),revoked_at=NOW(),stop_reason='privacy_redaction' WHERE shop_id=$1`, [shop.id]);
                await client.query(`UPDATE recovery_checkouts SET phone=NULL,email=NULL,snapshot='{}',status='stopped' WHERE shop_id=$1`, [shop.id]);
                await client.query(`UPDATE recovery_calls SET summary=NULL WHERE shop_id=$1`, [shop.id]);
                await client.query('DELETE FROM recovery_events WHERE shop_id=$1', [shop.id]);
                await client.query('DELETE FROM recovery_orders WHERE shop_id=$1', [shop.id]);
            }
        } else if (topic === 'customers/redact') {
            const customerId = `gid://shopify/Customer/${payload.customer?.id}`;
            await client.query(`DELETE FROM recovery_followup_tickets t USING recovery_calls a,recovery_checkouts c
                WHERE t.call_id=a.id AND a.checkout_id=c.id AND c.shop_id=$1 AND c.snapshot->>'customerId'=$2`,[shop.id,customerId]);
            await client.query(`DELETE FROM recovery_sms_links l USING recovery_actions a,recovery_checkouts c
                WHERE l.action_id=a.id AND a.checkout_id=c.id AND c.shop_id=$1 AND c.snapshot->>'customerId'=$2`,[shop.id,customerId]);
            // Preserve only non-reversible suppression hashes; remove identifying history.
            await client.query(`UPDATE recovery_contacts p SET phone='',evidence=NULL,consented_at=NULL,stopped_at=NOW(),
                revoked_at=NOW(),stop_reason='privacy_redaction' WHERE shop_id=$1 AND contact_key IN
                (SELECT contact_key FROM recovery_checkouts WHERE shop_id=$1 AND snapshot->>'customerId'=$2)`, [shop.id, customerId]);
            await client.query(`UPDATE recovery_calls SET summary=NULL WHERE shop_id=$1 AND checkout_id IN
                (SELECT id FROM recovery_checkouts WHERE shop_id=$1 AND snapshot->>'customerId'=$2)`, [shop.id, customerId]);
            await client.query(`DELETE FROM recovery_events WHERE shop_id=$1 AND call_id IN
                (SELECT a.id FROM recovery_calls a JOIN recovery_checkouts c ON c.id=a.checkout_id
                 WHERE c.shop_id=$1 AND c.snapshot->>'customerId'=$2)`, [shop.id, customerId]);
            await client.query(`UPDATE recovery_checkouts SET phone=NULL,email=NULL,snapshot='{}',status='stopped'
                WHERE shop_id=$1 AND snapshot->>'customerId'=$2`, [shop.id, customerId]);
            await client.query(`DELETE FROM recovery_orders WHERE shop_id=$1 AND external_id=ANY($2::text[])`,
            [shop.id, (payload.orders_to_redact || []).map(String)]);
        } else if (topic.startsWith('orders/')) {
            if (!payload.id || !Number.isFinite(Date.parse(payload.updated_at)) || !Number.isFinite(Date.parse(payload.created_at)) ||
                (payload.test !== undefined && typeof payload.test !== 'boolean')) throw policy.problem('invalid_order');
            const net = policy.cents(payload.current_subtotal_price ?? payload.subtotal_price ?? '0');
            const paid = ['paid', 'partially_refunded'].includes(payload.financial_status) && !payload.cancelled_at;
            let orderPhone = null;
            try { orderPhone = policy.phone(payload.phone || payload.shipping_address?.phone || payload.customer?.phone); } catch { /* Unknown identities cannot be attributed. */ }
            await client.query(`INSERT INTO recovery_orders(shop_id,external_id,checkout_token,checkout_external_id,phone,currency,paid,net_cents,source_updated_at,ordered_at,contact_key,paid_at,is_test)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$14) ON CONFLICT(shop_id,external_id) DO UPDATE SET
                is_test=recovery_orders.is_test OR EXCLUDED.is_test,
                paid=CASE WHEN recovery_orders.source_updated_at<=EXCLUDED.source_updated_at THEN EXCLUDED.paid ELSE recovery_orders.paid END,
                net_cents=CASE WHEN recovery_orders.source_updated_at<=EXCLUDED.source_updated_at THEN EXCLUDED.net_cents ELSE recovery_orders.net_cents END,
                source_updated_at=GREATEST(recovery_orders.source_updated_at,EXCLUDED.source_updated_at),
                paid_at=COALESCE(recovery_orders.paid_at,CASE WHEN NOT recovery_orders.paid OR $13='orders/paid' THEN EXCLUDED.paid_at END)`,
            [shop.id, String(payload.id), payload.checkout_token || null,
                payload.checkout_id ? `gid://shopify/AbandonedCheckout/${payload.checkout_id}` : null,
                orderPhone,
                payload.currency || shop.currency || 'EUR', paid,
                payload.cancelled_at ? 0 : net, payload.updated_at, payload.created_at,
                orderPhone ? policy.contactKey(shop.id, orderPhone) : null, paid ? payload.updated_at : null, topic, payload.test === true]);
            await require('./catalog').attributeOrder(client,shop,payload,orderPhone);
            // Keep exact checkout evidence after retention removes sensitive recovery tokens.
            await client.query(`UPDATE recovery_orders o SET recovery_checkout_id=c.id FROM recovery_checkouts c
                WHERE o.shop_id=$1 AND o.external_id=$2 AND o.recovery_checkout_id IS NULL AND c.shop_id=o.shop_id AND
                ((o.checkout_token IS NOT NULL AND o.checkout_token=c.checkout_token) OR o.checkout_external_id=c.external_id)`,[shop.id,String(payload.id)]);
            await require('./sms-links').attributeOrder(client,shop,payload);
            await client.query(`UPDATE recovery_checkouts c SET completed_at=COALESCE(c.completed_at,$2),status='converted'
                FROM recovery_orders o WHERE o.shop_id=$1 AND o.external_id=$3 AND c.shop_id=o.shop_id AND
                (o.recovery_checkout_id=c.id OR (o.checkout_token IS NOT NULL AND o.checkout_token=c.checkout_token) OR o.checkout_external_id=c.external_id OR
                (o.phone=c.phone AND o.ordered_at>=c.source_updated_at))`, [shop.id, payload.created_at, String(payload.id)]);
        } else if (topic === 'checkouts/delete') {
            await client.query(`UPDATE recovery_checkouts SET status='expired' WHERE shop_id=$1 AND external_id=$2 AND status!='converted'`,
            [shop.id, `gid://shopify/AbandonedCheckout/${payload.id}`]);
        } else if (['checkouts/create', 'checkouts/update'].includes(topic)) {
            // A webhook is a wake-up signal. Only the fresh Admin API snapshot authorizes contact.
            await client.query('UPDATE recovery_shops SET sync_at=NULL WHERE id=$1', [shop.id]);
        } else if (topic !== 'customers/data_request') throw policy.problem('unsupported_webhook');
        if (topic !== 'shop/redact') await event(client, shop.id, topic === 'customers/data_request' ? 'privacy_export_requested' : 'shopify_webhook',
            { topic, eventId, ...(topic === 'customers/data_request' ? { requestId: payload.data_request?.id } : {}) });
        return { received: true };
    });
}

async function lifecycle(eventInput) {
    const room = eventInput.room?.name;
    if (!room?.startsWith('recovery-')) return false;
    const at = new Date(Number(eventInput.createdAt) * 1000);
    if (!Number.isFinite(+at)) throw policy.problem('invalid_lifecycle_timestamp');
    await transaction(async (client) => {
        const { rows } = await client.query(`SELECT a.*,s.rules FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
            WHERE a.room=$1 FOR UPDATE OF a`, [room]);
        const call = rows[0];
        if (!call) return;
        if (call.status === 'simulated') return;
        if (eventInput.event === 'participant_joined' && Number(eventInput.participant?.kind) === 3) {
            await client.query(`UPDATE recovery_calls SET dialed_at=LEAST(dialed_at,$2) WHERE id=$1`, [call.id, at]);
            if (eventInput.participant.attributes?.['sip.callStatus'] === 'active') {
                await client.query(`UPDATE recovery_calls SET connected_at=LEAST(connected_at,$2),
                    status=CASE WHEN ended_at IS NULL THEN 'connected' ELSE status END WHERE id=$1`, [call.id, at]);
            }
        }
        if ((['participant_left', 'participant_connection_aborted'].includes(eventInput.event) && Number(eventInput.participant?.kind) === 3) ||
            eventInput.event === 'room_finished') {
            // room_finished is a cleanup signal, never an authoritative billing timestamp.
            const fallback = eventInput.event === 'room_finished';
            const seconds = call.connected_at && !fallback && at>=call.connected_at ? (at - call.connected_at) / 1000 : null;
            await client.query(`UPDATE recovery_calls SET ended_at=COALESCE(ended_at,$2),status='ended',
                cost_cents=COALESCE(cost_cents,$3),confirmed_duration_seconds=COALESCE(confirmed_duration_seconds,$4) WHERE id=$1`,
            [call.id, at, seconds === null ? null : Math.ceil(seconds / 60 * policy.rules(call.rules).voiceCentsPerMinute),seconds]);
            await client.query(`UPDATE recovery_checkouts SET status='contacted' WHERE id=$1 AND status='calling'`, [call.checkout_id]);
        }
        await event(client, call.shop_id, 'call_lifecycle', { event: eventInput.event }, call.id);
    });
    return true;
}

const router = express.Router();
router.post(['/shopify/:shopId/:capability', '/shopify/privacy'], express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body)) return res.status(401).json({ error: 'invalid_signature' });
        const domain = shopify.domain(req.get('x-shopify-shop-domain'));
        const privacy = req.path === '/shopify/privacy';
        if (!privacy) {
            if (!service.uuid(req.params.shopId)) throw policy.problem('shop_not_found', 404);
            const expected = Buffer.from(shopify.webhookCapability(req.params.shopId));
            const actual = Buffer.from(req.params.capability || '');
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'invalid_webhook_destination' });
        }
        const { rows } = await db.query(`SELECT * FROM recovery_shops WHERE domain=$1 AND mode='live'
            AND ($2::uuid IS NULL OR id=$2)`, [domain, privacy ? null : req.params.shopId]);
        if (!rows[0]) return res.status(404).json({ error: 'shop_not_found' });
        const credentials = rows[0].credentials_encrypted ? require('../services/shopify-crypto').decryptShopifyCredentials(rows[0].credentials_encrypted) : {};
        const app = shopify.shopApp(rows[0], credentials);
        if (!shopify.signature(req.body, req.get('x-shopify-hmac-sha256'), app.secret)) return res.status(401).json({ error: 'invalid_signature' });
        const payload = JSON.parse(req.body.toString());
        const topic = req.get('x-shopify-topic') || '';
        if (privacy && (!['customers/redact', 'customers/data_request', 'shop/redact'].includes(topic) || payload.shop_domain !== domain)) {
            return res.status(401).json({ error: 'invalid_privacy_shop' });
        }
        const eventId = req.get('x-shopify-event-id') || req.get('x-shopify-webhook-id');
        if (!eventId || eventId.length > 150) throw policy.problem('invalid_event_id');
        const result = await ingestShopify(rows[0], topic, payload, eventId);
        // Orders and uninstall stop any in-progress automation as soon as the durable state is committed.
        await reconcileStops(rows[0].id);
        return res.json(result);
    } catch (error) { return res.status(error.status || 500).json({ error: error.code || 'webhook_processing_failed' }); }
});

router.post('/twilio', express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 100 }), async (req, res) => {
    try {
        if (!process.env.RECOVERY_PUBLIC_URL || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return res.sendStatus(503);
        const base = new URL(process.env.RECOVERY_PUBLIC_URL);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return res.sendStatus(503);
        // Sign the exact public request target, never a client-controlled Host or forwarded header.
        if (!req.originalUrl.startsWith('/webhooks/recovery/twilio?')) return res.sendStatus(400);
        const url = base.origin + req.originalUrl;
        if (!twilioSignature(url, req.body, req.get('x-twilio-signature'))) return res.sendStatus(401);
        const query = new URL(url).searchParams;
        if (query.getAll('action').length !== 1 || [...query.keys()].some((key) => key !== 'action') || !service.uuid(query.get('action'))) return res.sendStatus(400);
        if (req.body.AccountSid !== process.env.TWILIO_ACCOUNT_SID) return res.sendStatus(401);
        if (!/^SM[a-f0-9]{32}$/i.test(req.body.MessageSid || '')) return res.sendStatus(400);
        const statuses = { delivered: 'delivered', failed: 'failed', undelivered: 'failed', canceled: 'failed',
            accepted: 'accepted', scheduled: 'accepted', sending: 'accepted', sent: 'accepted', queued: 'accepted' };
        const status = Object.hasOwn(statuses, req.body.MessageStatus) ? statuses[req.body.MessageStatus] : null;
        if (status) {
            await transaction(async (client) => {
                // Serialize early receipts with the provider acknowledgement before reading either state.
                const { rows } = await client.query(`SELECT id,status,provider_id FROM recovery_actions WHERE id=$1 AND kind='sms' FOR UPDATE`, [query.get('action')]);
                const action = rows[0];
                if (!action || action.status === 'simulated' || (action.provider_id && action.provider_id !== req.body.MessageSid)) return;
                await client.query(`INSERT INTO recovery_sms_receipts(action_id,provider_id,status)
                    VALUES($1,$2,$3)
                    ON CONFLICT(action_id,provider_id) DO UPDATE SET status=CASE WHEN recovery_sms_receipts.status
                    IN ('delivered','failed') THEN recovery_sms_receipts.status ELSE EXCLUDED.status END`,
                [action.id, req.body.MessageSid, status]);
                await client.query(`UPDATE recovery_actions SET status=(SELECT status FROM recovery_sms_receipts WHERE action_id=$1 AND provider_id=$2)
                    WHERE id=$1 AND provider_id=$2 AND (status IN ('pending','accepted','unknown') OR
                    (status='failed' AND EXISTS(SELECT 1 FROM recovery_sms_receipts WHERE action_id=$1 AND provider_id=$2 AND status='delivered')))`,
                [action.id, req.body.MessageSid]);
            });
        }
        return res.sendStatus(200);
    } catch { return res.sendStatus(500); }
});

async function reconcileStops(shopId = null) {
    const { rows } = await db.query(`SELECT a.id,a.room FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
        JOIN customers tenant ON tenant.id=s.customer_id
        JOIN recovery_contacts p ON p.shop_id=a.shop_id AND p.contact_key=a.contact_key
        JOIN recovery_checkouts c ON c.id=a.checkout_id
        WHERE ($1::uuid IS NULL OR a.shop_id=$1) AND a.status IN ('reserved','dialing','connected','unknown')
        AND (NOT tenant.is_active OR NOT s.enabled OR p.stopped_at IS NOT NULL OR c.completed_at IS NOT NULL OR a.expires_at<NOW()) LIMIT 50`, [shopId]);
    await Promise.all(rows.map(async (row) => {
        try { await telephony.hangup(row.room); }
        catch { /* Retain the durable stop and retry cleanup on the next worker tick. */ }
    }));
}

module.exports = { router, ingestShopify, lifecycle, reconcileStops, twilioSignature };
