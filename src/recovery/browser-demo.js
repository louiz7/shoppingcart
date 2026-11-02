'use strict';

const { ECOM_DEMO_INSTRUCTIONS } = require('./demo-prompt');
const { transaction, event } = require('./store');
const { problem } = require('./policy');

async function browserDemo(customerId, sdp) {
    if (process.env.GPT_LIVE_DEMO_ENABLED !== '1' || !process.env.OPENAI_API_KEY) throw problem('browser_demo_disabled', 409);
    if (typeof sdp !== 'string' || sdp.length < 16 || sdp.length > 60000 || !/^v=0\r?\n/.test(sdp)) throw problem('invalid_sdp');
    await transaction(async (client) => {
        // Tenant-wide persistent limit, including concurrent requests and failed upstream attempts.
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
        const { rows } = await client.query(`SELECT s.id,(SELECT COUNT(*) FROM recovery_events e JOIN recovery_shops x ON x.id=e.shop_id
            WHERE x.customer_id=$1 AND e.kind='browser_demo_reserved' AND e.created_at>NOW()-INTERVAL '1 hour') AS requests
            FROM recovery_shops s WHERE s.customer_id=$1 ORDER BY s.created_at LIMIT 1`, [customerId]);
        if (!rows[0]) throw problem('connect_or_seed_shop_first', 409);
        if (Number(rows[0].requests) >= 3) throw problem('demo_hourly_limit', 429);
        await event(client, rows[0].id, 'browser_demo_reserved');
    });
    const response = await fetch('https://api.openai.com/v1/live/sessions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { model: 'gpt-live-1', instructions: ECOM_DEMO_INSTRUCTIONS,
            audio: { output: { voice: 'flitz' } }, store: false,
            client: { data_channel: { allowed_client_events: [], allowed_server_events: [] } },
        }, transport: { type: 'webrtc', sdp } }),
    });
    if (!response.ok) throw problem('gpt_live_demo_unavailable', 502);
    const payload = await response.json();
    if (typeof payload.session?.id !== 'string' || typeof payload.transport?.sdp !== 'string') throw problem('invalid_live_response', 502);
    const sessionId = payload.session.id;
    const timer = setTimeout(() => {
        fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/hangup`, {
            method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(10000),
        }).catch(() => {});
    }, 180000);
    timer.unref();
    return { session: { id: sessionId }, transport: { type: 'webrtc', sdp: payload.transport.sdp } };
}

module.exports = { browserDemo };
