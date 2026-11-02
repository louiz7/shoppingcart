'use strict';

const db = require('./db');

const PRICE_PER_MINUTE = parseFloat(process.env.PRICE_PER_MINUTE || '0.15');

function computeCost(voiceSeconds) {
    return (voiceSeconds / 60) * PRICE_PER_MINUTE;
}

async function logUsage(event) {
    try {
        await db.query(
            `INSERT INTO usage_events
                (customer_id, api_key_id, method, path,
                 upstream_status, duration_ms, voice_seconds, cost_usd,
                 error, call_id, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (customer_id, source, call_id)
                 WHERE call_id IS NOT NULL DO NOTHING`,
            [
                event.customerId,
                event.apiKeyId || null,
                event.method,
                event.path,
                event.upstreamStatus || null,
                event.durationMs,
                event.voiceSeconds || 0,
                event.costUsd || 0,
                event.error || null,
                event.callId || null,
                event.source || 'rest',
            ],
        );
    } catch (err) {
        // Never fail the user request because of logging.
        console.error('[usage] failed to log event', err);
    }
}

module.exports = {
    computeCost,
    logUsage,
    PRICE_PER_MINUTE,
};
