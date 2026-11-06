'use strict';

const { SipClient, RoomServiceClient, AgentDispatchClient } = require('livekit-server-sdk');
const { ParticipantInfo_Kind } = require('@livekit/protocol');
const { setTimeout: delay } = require('node:timers/promises');
const { problem, phone } = require('./policy');

// Only deployment configuration can assign numbers; callers supply the authenticated shop ID.
function routing(shopId) {
    let routes;
    try {
        routes = JSON.parse(process.env.RECOVERY_SHOP_TELEPHONY || '{}');
        if (!routes || typeof routes !== 'object' || Array.isArray(routes)) throw new Error();
        for (const [id,route] of Object.entries(routes)) {
            if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !route ||
                typeof route !== 'object' || Array.isArray(route) ||
                Object.keys(route).some(key=>!['trunkId','callerId','smsFrom','smsSenderIdDE'].includes(key)) ||
                !/^ST_[A-Za-z0-9_]+$/.test(route.trunkId || '') || phone(route.callerId)!==route.callerId ||
                (route.smsFrom !== undefined && phone(route.smsFrom)!==route.smsFrom) ||
                (route.smsSenderIdDE !== undefined && (typeof route.smsSenderIdDE!=='string' ||
                    route.smsSenderIdDE!==route.smsSenderIdDE.trim() || !/^[A-Za-z][A-Za-z0-9]{0,10}$/.test(route.smsSenderIdDE)))) throw new Error();
        }
    } catch { throw problem('shop_telephony_not_configured',503); }
    const route = Object.hasOwn(routes,shopId) ? routes[shopId] : null;
    return { trunkId:route?.trunkId || process.env.RECOVERY_SIP_TRUNK_ID,
        callerId:route?.callerId || process.env.RECOVERY_CALLER_ID,
        smsFrom:route?.smsFrom || process.env.TWILIO_SMS_FROM, smsSenderIdDE:route?.smsSenderIdDE };
}

function configured(shopId) {
    try {
        const route=routing(shopId);
        return ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_AGENT_NAME', 'OPENAI_API_KEY']
            .map(key=>process.env[key]).concat([route.trunkId,route.callerId])
            .every(value=>value && !/^(replace_|""$|''$)/.test(value));
    } catch { return false; }
}

function clients() {
    const url = process.env.LIVEKIT_URL?.replace(/^wss:/, 'https:');
    const args = [url, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET];
    return { rooms: new RoomServiceClient(...args), sip: new SipClient(...args), dispatch: new AgentDispatchClient(...args) };
}

async function dial(call, number, token) {
    if (process.env.RECOVERY_LIVE_ENABLED !== '1' || !configured(call.shop_id)) throw problem('live_calls_disabled', 409);
    const { rooms, sip, dispatch } = clients();
    const route = routing(call.shop_id);
    // Named dispatch keeps this worker out of existing Rescova campaigns.
    await rooms.createRoom({ name: call.room, emptyTimeout: 30, maxParticipants: 2,
        metadata: JSON.stringify({ mode: 'recovery', call_token: token }) });
    try {
        await dispatch.createDispatch(call.room, process.env.LIVEKIT_AGENT_NAME);
        // The detector must be listening before the SIP leg can deliver its first audio.
        const deadline = Date.now() + 30000;
        while (true) {
            const participants = await rooms.listParticipants(call.room);
            if (participants.some(p => p.kind === ParticipantInfo_Kind.AGENT &&
                p.attributes?.['recovery.amd_ready'] === call.id)) break;
            if (Date.now() >= deadline) throw problem('recovery_agent_not_ready', 503);
            await delay(200);
        }
        return await sip.createSipParticipant(route.trunkId, number, call.room, {
            participantIdentity: `buyer-${call.id}`, participantName: 'Shop customer',
            fromNumber: route.callerId, waitUntilAnswered: false,
        });
    } catch (error) {
        await rooms.deleteRoom(call.room).catch(() => {});
        throw error;
    }
}

async function hangup(room) {
    if (!room.startsWith('recovery-')) throw problem('invalid_recovery_room');
    await clients().rooms.deleteRoom(room);
}

function assertSmsReady(shopId) {
    const unavailable = (code, status) => Object.assign(problem(code, status), { smsDispatched: false });
    if (process.env.RECOVERY_LIVE_ENABLED !== '1' || process.env.RECOVERY_SMS_ENABLED !== '1') throw unavailable('sms_disabled', 409);
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
    let sender, senderIdDE, callback;
    try {
        const route = routing(shopId);
        sender = phone(route.smsFrom);
        senderIdDE = route.smsSenderIdDE;
        callback = new URL('/webhooks/recovery/twilio', process.env.RECOVERY_PUBLIC_URL);
        if (callback.protocol !== 'https:' || callback.username || callback.password || callback.port) throw new Error();
    } catch { throw unavailable('sms_not_configured', 503); }
    if (!/^AC[a-f0-9]{32}$/i.test(sid || '') || !token || /^(replace_|""$|''$)/.test(token)) throw unavailable('sms_not_configured', 503);
    return { sid, token, sender, senderIdDE, callback };
}

async function sendSms(number, text, actionId, shopId) {
    const { sid, token, sender, senderIdDE, callback } = assertSmsReady(shopId);
    try {
        if (phone(number) !== number || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actionId || '') ||
            typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error();
    } catch { throw Object.assign(problem('invalid_sms_request'), { smsDispatched: false }); }
    // Dynamic branded senders are enabled only for DE; other destinations keep their configured numeric sender.
    const from = number.startsWith('+49') && senderIdDE ? senderIdDE : sender;
    callback.searchParams.set('action', actionId);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: number, From: from, Body: text, StatusCallback: callback.href }),
    });
    if (!response.ok) throw problem('sms_provider_error', 502);
    const data = await response.json();
    if (!/^SM[a-f0-9]{32}$/i.test(data.sid || '') ||
        !['accepted','queued','sending','sent','delivered','undelivered','failed','canceled','scheduled'].includes(data.status)) {
        throw problem('invalid_sms_acknowledgement', 502);
    }
    return { id: data.sid, status: data.status };
}

module.exports = { configured, dial, hangup, assertSmsReady, sendSms };
