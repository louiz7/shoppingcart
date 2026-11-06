'use strict';

const { db } = require('./store');
const service = require('./service');
const { reconcileStops } = require('./webhooks');

async function tick() {
    await reconcileStops();
    const { rows: shops } = await db.query(`SELECT id,customer_id,campaign_started_at FROM recovery_shops WHERE enabled AND approved_at IS NOT NULL AND mode='live'`);
    for (const shop of shops) {
        try {
            await service.syncShop(shop.customer_id, shop.id);
            const { rows } = await db.query(`SELECT c.id FROM recovery_checkouts c JOIN recovery_contacts p
                ON p.shop_id=c.shop_id AND p.contact_key=c.contact_key
                WHERE c.shop_id=$1 AND c.status='pending' AND c.completed_at IS NULL
                AND ($2::timestamptz IS NULL OR c.source_updated_at >= $2)
                AND p.consented_at IS NOT NULL AND p.expires_at>NOW() AND p.stopped_at IS NULL
                AND p.revoked_at IS NULL AND p.consent_checkout_id=c.id AND p.arm IS DISTINCT FROM 'control'
                ORDER BY c.last_evaluated_at NULLS FIRST,c.source_updated_at LIMIT 25`, [shop.id,shop.campaign_started_at]);
            for (const checkout of rows) {
                try { await service.startCall(shop.customer_id, shop.id, checkout.id); }
                catch (error) { if (!error.status) throw error; }
                finally { await db.query('UPDATE recovery_checkouts SET last_evaluated_at=NOW() WHERE id=$1 AND shop_id=$2', [checkout.id, shop.id]); }
            }
        } catch (error) {
            await db.query('UPDATE recovery_shops SET last_error=$2 WHERE id=$1', [shop.id, error.code || 'worker_failed']);
        }
    }
    await purgeExpiredData();
}

async function purgeExpiredData(shopId = null) {
    await db.query(`DELETE FROM recovery_followup_tickets t USING recovery_calls a
        WHERE t.call_id=a.id AND t.created_at<NOW()-INTERVAL '30 days'
        AND ($1::uuid IS NULL OR a.shop_id=$1)`, [shopId]);
    // Transcripts and customer evidence expire; suppression hashes remain until uninstall.
    await db.query(`DELETE FROM recovery_events WHERE created_at<NOW()-INTERVAL '30 days'
        AND ($1::uuid IS NULL OR shop_id=$1)`, [shopId]);
    await db.query(`DELETE FROM recovery_webhooks WHERE received_at<NOW()-INTERVAL '30 days'
        AND ($1::uuid IS NULL OR shop_id=$1)`, [shopId]);
    await db.query(`DELETE FROM recovery_oauth_states WHERE expires_at<NOW()
        AND ($1::uuid IS NULL OR shop_domain=(SELECT domain FROM recovery_shops WHERE id=$1))`, [shopId]);
    await db.query(`UPDATE recovery_checkouts c SET status='expired' FROM recovery_shops s WHERE s.id=c.shop_id
        AND c.status='pending' AND c.source_updated_at<NOW()-make_interval(days=>COALESCE((s.rules->>'expiryDays')::int,7))
        AND ($1::uuid IS NULL OR c.shop_id=$1)`, [shopId]);
    // Preserve pseudonymous financial attribution; cascading checkout deletion would erase call costs.
    await db.query(`DELETE FROM recovery_actions WHERE checkout_id IN
        (SELECT id FROM recovery_checkouts WHERE source_updated_at<NOW()-INTERVAL '30 days'
            AND ($1::uuid IS NULL OR shop_id=$1))`, [shopId]);
    await db.query(`UPDATE recovery_calls SET summary=NULL WHERE created_at<NOW()-INTERVAL '30 days'
        AND ($1::uuid IS NULL OR shop_id=$1)`, [shopId]);
    await db.query(`UPDATE recovery_checkouts SET phone=NULL,email=NULL,checkout_token=NULL,snapshot='{}'
        WHERE source_updated_at<NOW()-INTERVAL '30 days' AND ($1::uuid IS NULL OR shop_id=$1)`, [shopId]);
    await db.query(`UPDATE recovery_orders SET phone=NULL,checkout_token=NULL WHERE ordered_at<NOW()-INTERVAL '30 days'
        AND ($1::uuid IS NULL OR shop_id=$1)`, [shopId]);
    await db.query(`UPDATE recovery_contacts SET phone='',evidence=NULL,consented_at=NULL,stopped_at=COALESCE(stopped_at,NOW()),
        revoked_at=COALESCE(revoked_at,NOW()),stop_reason=COALESCE(stop_reason,'retention_expired')
        WHERE ($1::uuid IS NULL OR shop_id=$1) AND (expires_at<NOW()-INTERVAL '30 days' OR NOT EXISTS
        (SELECT 1 FROM recovery_checkouts c WHERE c.shop_id=recovery_contacts.shop_id
            AND c.contact_key=recovery_contacts.contact_key AND c.source_updated_at>=NOW()-INTERVAL '30 days'))`, [shopId]);
}

function startRecoveryWorker() {
    if (process.env.RECOVERY_WORKER_ENABLED !== '1') return null;
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try { await tick(); } catch { console.error('[recovery] worker tick failed'); }
        finally { running = false; }
    }, 30000);
    timer.unref();
    return timer;
}

module.exports = { tick, purgeExpiredData, startRecoveryWorker };
