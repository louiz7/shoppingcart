'use strict';

const crypto = require('crypto');
const { SipClient, RoomServiceClient } = require('livekit-server-sdk');
const db = require('../db');
const callLifecycle = require('./call-lifecycle-service');
const { parseSipFailure } = require('./sip-error-service');
const { loadOrganizationAgent } = require('./organization-voice-service');

const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LIVEKIT_SIP_TRUNK_ID = process.env.LIVEKIT_SIP_TRUNK_ID || '';
const SIP_CALLER_ID = process.env.SIP_CALLER_ID || '';
const CALL_TOKEN_TTL_MIN = parseInt(process.env.CALL_TOKEN_TTL_MIN || '60', 10);

function assertConfigured() {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET
        || !LIVEKIT_SIP_TRUNK_ID || !SIP_CALLER_ID) {
        const error = new Error('LiveKit SIP trunk is not configured');
        error.code = 'sip_trunk_not_configured';
        throw error;
    }
    if (!/^\+[1-9]\d{6,14}$/.test(SIP_CALLER_ID)) {
        const error = new Error('SIP caller ID must be a valid E.164 number');
        error.code = 'sip_trunk_not_configured';
        throw error;
    }
}

async function placeCaseCall({
    customerId,
    caseId,
    phoneE164,
    campaignId = null,
    campaignMemberId = null,
    source = 'case_api',
    callPurpose = 'campaign',
}) {
    assertConfigured();
    const organizationAgent = await loadOrganizationAgent(db, customerId);

    const { rows: attemptRows } = await db.query(
        `INSERT INTO call_attempts (
            customer_id, case_id, campaign_id, campaign_member_id,
            dial_started_at, lifecycle_status, duration_source
         ) VALUES ($1, $2, $3, $4, NOW(), 'dialing', 'livekit')
         RETURNING id`,
        [customerId, caseId, campaignId, campaignMemberId],
    );
    const attemptId = attemptRows[0].id;
    const callToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(callToken).digest('hex');
    await db.query(
        `INSERT INTO call_tokens (customer_id, case_id, call_attempt_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)`,
        [customerId, caseId, attemptId, tokenHash, CALL_TOKEN_TTL_MIN],
    );

    const httpUrl = LIVEKIT_URL.replace('wss://', 'https://');
    const sip = new SipClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const rooms = new RoomServiceClient(httpUrl, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const roomName = `dlh-${customerId}-${crypto.randomBytes(6).toString('hex')}`;
    const metadata = JSON.stringify({
        mode: 'case',
        call_purpose: callPurpose,
        call_token: callToken,
        organization_name: organizationAgent.organizationName,
        system_prompt: organizationAgent.systemPrompt,
        greeting: organizationAgent.greeting,
        hosted_voice_id: organizationAgent.hostedVoiceId,
        temperature: organizationAgent.temperature,
    });

    try {
        await rooms.createRoom({ name: roomName, metadata });
        // Persist the room before dialing so signed participant webhooks can
        // resolve the attempt even if they arrive before the blocking
        // createSipParticipant call returns.
        await db.query(
            'UPDATE call_attempts SET livekit_room = $1 WHERE id = $2',
            [roomName, attemptId],
        );
        const participant = await sip.createSipParticipant(
            LIVEKIT_SIP_TRUNK_ID,
            phoneE164,
            roomName,
            {
                participantIdentity: `sip-${crypto.randomBytes(4).toString('hex')}`,
                participantName: 'Evi Case Call',
                fromNumber: SIP_CALLER_ID,
                // Return only after a person or voicemail answers. The agent
                // independently waits for sip.callStatus=active before it
                // starts its session, preventing greetings during ringback.
                waitUntilAnswered: true,
            },
        );
        // waitUntilAnswered only returns successfully after the SIP leg has
        // answered (a human or voicemail). This is the authoritative start of
        // connected duration; room creation and ringing are deliberately not
        // counted as conversation time.
        await callLifecycle.markConnected({
            attemptId,
            roomName,
            sipCallId: participant.sipCallId,
        });
        await db.query(
            `INSERT INTO events (
                customer_id, case_id, call_attempt_id, actor, channel, kind, result, decision
             ) VALUES ($1, $2, $3, 'system', 'voice', 'dial_attempt', $4, 'allow')`,
            [customerId, caseId, attemptId, JSON.stringify({
                room: roomName,
                sip_call_id: participant.sipCallId,
                source,
                campaign_id: campaignId,
            })],
        );
        return {
            callAttemptId: attemptId,
            room: roomName,
            sipCallId: participant.sipCallId,
            participantId: participant.participantId,
        };
    } catch (error) {
        const { sipStatusCode, reason } = parseSipFailure(error);
        await callLifecycle.markDialFailed({
            attemptId,
            reason,
            sipStatusCode,
        });
        await db.query(
            `INSERT INTO events (
                customer_id, case_id, call_attempt_id, actor, channel, kind, result, decision, reason_code
             ) VALUES ($1, $2, $3, 'system', 'voice', 'dial_attempt', $4, 'deny', 'provider_error')`,
            [customerId, caseId, attemptId, JSON.stringify({ message: error.message, source })],
        );
        // A room may already exist when SIP setup or the post-answer database
        // update fails. Best-effort cleanup prevents empty rooms from lingering
        // and later inflating room-based metrics.
        await rooms.deleteRoom(roomName).catch((cleanupError) => {
            console.error('[case-call-service] failed to clean up room', cleanupError);
        });
        // Let the campaign scheduler bind its retry to this exact call. This
        // prevents a simultaneous LiveKit disconnect webhook from creating a
        // second retry for the same failed dial.
        if (error && typeof error === 'object') error.callAttemptId = attemptId;
        throw error;
    }
}

module.exports = { placeCaseCall, assertConfigured };
