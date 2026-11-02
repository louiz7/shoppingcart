'use strict';

const { SipClient, RoomServiceClient, AgentDispatchClient } = require('livekit-server-sdk');
const { problem, phone } = require('./policy');

function configured() {
    return ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'RECOVERY_SIP_TRUNK_ID', 'RECOVERY_CALLER_ID',
        'LIVEKIT_AGENT_NAME', 'OPENAI_API_KEY'].every((key) => {
        const value = process.env[key];
        return value && !/^(replace_|""$|''$)/.test(value);
    });
}

function clients() {
    const url = process.env.LIVEKIT_URL?.replace(/^wss:/, 'https:');
    const args = [url, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET];
    return { rooms: new RoomServiceClient(...args), sip: new SipClient(...args), dispatch: new AgentDispatchClient(...args) };
}

async function dial(call, number, token) {
    if (process.env.RECOVERY_LIVE_ENABLED !== '1' || !configured()) throw problem('live_calls_disabled', 409);
    const { rooms, sip, dispatch } = clients();
    // Named dispatch keeps this worker out of existing Rescova campaigns.
    await rooms.createRoom({ name: call.room, emptyTimeout: 30, maxParticipants: 2,
        metadata: JSON.stringify({ mode: 'recovery', call_token: token }) });
    try {
        await dispatch.createDispatch(call.room, process.env.LIVEKIT_AGENT_NAME);
        return await sip.createSipParticipant(process.env.RECOVERY_SIP_TRUNK_ID, number, call.room, {
            participantIdentity: `buyer-${call.id}`, participantName: 'Shop customer',
            fromNumber: process.env.RECOVERY_CALLER_ID, waitUntilAnswered: false,
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

function assertSmsReady() {
    const unavailable = (code, status) => Object.assign(problem(code, status), { smsDispatched: false });
    if (process.env.RECOVERY_LIVE_ENABLED !== '1' || process.env.RECOVERY_SMS_ENABLED !== '1') throw unavailable('sms_disabled', 409);
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
    let sender, callback;
    try {
        sender = phone(process.env.TWILIO_SMS_FROM);
        callback = new URL('/webhooks/recovery/twilio', process.env.RECOVERY_PUBLIC_URL);
        if (callback.protocol !== 'https:' || callback.username || callback.password || callback.port) throw new Error();
    } catch { throw unavailable('sms_not_configured', 503); }
    if (!/^AC[a-f0-9]{32}$/i.test(sid || '') || !token || /^(replace_|""$|''$)/.test(token)) throw unavailable('sms_not_configured', 503);
    return { sid, token, sender, callback };
}

async function sendSms(number, text, actionId) {
    const { sid, token, sender, callback } = assertSmsReady();
    try {
        if (phone(number) !== number || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(actionId || '') ||
            typeof text !== 'string' || !text.trim() || text.length > 1600) throw new Error();
    } catch { throw Object.assign(problem('invalid_sms_request'), { smsDispatched: false }); }
    callback.searchParams.set('action', actionId);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: number, From: sender, Body: text, StatusCallback: callback.href }),
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
