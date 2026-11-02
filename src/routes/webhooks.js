'use strict';

/**
 * Receives Deepslate Call Event Hooks (call_started / call_concluded).
 *
 * Customers configure their Assistant/Agent's call_event_hooks in Deepslate
 * to POST to:
 *
 *     https://<our-host>/webhooks/deepslate/call-events/<webhook_token>
 *
 * The token identifies which of our customers the call belongs to.
 * On call_concluded we compute (endedAt - startedAt) and write a billing row.
 * Idempotent on (customer_id, source='webhook', call_id).
 */

const express = require('express');
const db = require('../db');
const { computeCost, logUsage } = require('../usage');

const router = express.Router();

router.post('/call-events/:token', express.json({ limit: '25mb' }), async (req, res) => {
    const { token } = req.params;
    const body = req.body || {};

    try {
        const { rows } = await db.query(
            `SELECT id FROM customers WHERE webhook_token = $1 AND is_active = TRUE`,
            [token],
        );
        if (rows.length === 0) {
            // 200 anyway so Deepslate doesn't retry forever for bad URLs.
            return res.status(200).json({ ok: false, reason: 'unknown_token' });
        }
        const customerId = rows[0].id;
        const type = body.type;
        const callId = body.callId || null;

        if (type === 'call_started') {
            // Nothing to bill yet; just ack. (Could insert a marker row.)
            return res.status(200).json({ ok: true });
        }

        if (type === 'call_concluded') {
            const startedAt = Number(body.startedAt) || null;
            const endedAt = Number(body.endedAt) || null;
            const durationMs =
                startedAt && endedAt && endedAt > startedAt ? endedAt - startedAt : 0;
            const voiceSeconds = durationMs / 1000;

            await logUsage({
                customerId,
                apiKeyId: null,
                method: 'WEBHOOK',
                path: '/webhooks/deepslate/call_concluded',
                upstreamStatus: 200,
                durationMs,
                voiceSeconds,
                costUsd: computeCost(voiceSeconds),
                error: null,
                callId,
                source: 'webhook',
            });
            return res.status(200).json({ ok: true });
        }

        // Unknown event type — ack so Deepslate doesn't retry.
        return res.status(200).json({ ok: true, ignored: true });
    } catch (err) {
        console.error('[webhook] error', err);
        // 500 -> Deepslate will retry per its backoff schedule.
        return res.status(500).json({ ok: false });
    }
});

module.exports = router;
