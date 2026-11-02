'use strict';

/**
 * Receives signed LiveKit call-lifecycle webhooks.
 *
 * Configure this URL in the LiveKit project settings (Webhooks):
 *     https://<our-host>/webhooks/livekit
 *
 * `participant_left` for the SIP participant is authoritative for the end of
 * connected duration. `room_finished` can arrive only after an empty timeout,
 * so it is a safety net and never creates billable duration by itself.
 */

const express = require('express');
const { WebhookReceiver } = require('livekit-server-sdk');
const { finalizeCampaignAttempt } = require('../campaign-scheduler');
const callLifecycle = require('../services/call-lifecycle-service');

const router = express.Router();

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

const receiver =
    LIVEKIT_API_KEY && LIVEKIT_API_SECRET
        ? new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        : null;

function eventDate(event) {
    const seconds = Number(event.createdAt);
    return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

function isSipParticipant(participant) {
    // ParticipantInfo.Kind.SIP = 3. Avoid importing a transitive protocol enum
    // solely for this comparison.
    return participant && Number(participant.kind) === 3;
}

async function finalizeEndedRoom(roomName) {
    const attempt = await callLifecycle.getAttemptByRoom(roomName);
    if (!attempt || !attempt.ended_at) return;
    await callLifecycle.recordCallUsage(attempt.id);
    await finalizeCampaignAttempt(roomName);
}

async function handleLifecycleEvent(event) {
    if (event.room?.name?.startsWith('recovery-')) {
        await require('../recovery/webhooks').lifecycle(event);
        return { ok: true, handled: 'recovery' };
    }
    if (
        (event.event === 'participant_left' || event.event === 'participant_connection_aborted')
        && event.room
        && isSipParticipant(event.participant)
    ) {
        const disconnectCode = event.participant.disconnectReason;
        await callLifecycle.markEnded({
            roomName: event.room.name,
            reason: `${event.event}:${disconnectCode}`,
            at: eventDate(event),
        });
        await finalizeEndedRoom(event.room.name);
        return { ok: true, handled: event.event };
    }

    if (
        event.event === 'participant_joined'
        && event.room
        && isSipParticipant(event.participant)
        && event.participant.attributes?.['sip.callStatus'] === 'active'
    ) {
        // A SIP participant can enter the room while the remote phone is
        // still ringing. Only an explicit active status is an answer signal.
        const attempt = await callLifecycle.getAttemptByRoom(event.room.name);
        if (attempt) {
            await callLifecycle.markConnected({
                attemptId: attempt.id,
                roomName: event.room.name,
                sipCallId: event.participant.attributes?.['sip.callID'] || null,
                at: eventDate(event),
            });
        }
        return { ok: true, handled: event.event };
    }

    if (event.event === 'room_finished' && event.room) {
        // Fallback only. The empty-room timeout means this timestamp is not
        // trustworthy as connected duration, so exclude it from usage and
        // dashboard duration instead of overcounting.
        await callLifecycle.markEnded({
            roomName: event.room.name,
            reason: 'room_finished_fallback',
            at: eventDate(event),
            durationSource: 'legacy_unknown',
        });
        await finalizeEndedRoom(event.room.name);
        return { ok: true, handled: event.event };
    }

    return { ok: true, ignored: event.event };
}

// LiveKit posts raw JSON with Content-Type application/webhook+json; the
// receiver needs the raw body string to verify the signature.
router.post(
    '/',
    express.raw({ type: 'application/webhook+json', limit: '1mb' }),
    async (req, res) => {
        if (!receiver) {
            return res.status(503).json({ error: 'livekit_not_configured' });
        }

        let event;
        try {
            const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
            event = await receiver.receive(raw, req.get('Authorization'));
        } catch (err) {
            console.error('[livekit-webhook] signature verification failed', err);
            return res.status(401).json({ error: 'invalid_signature' });
        }

        try {
            return res.status(200).json(await handleLifecycleEvent(event));
        } catch (err) {
            // Returning 500 is intentional: lifecycle and usage writes are
            // durable requirements, and LiveKit should retry the signed event.
            console.error('[livekit-webhook] lifecycle handling failed', err);
            return res.status(500).json({ ok: false });
        }
    },
);

module.exports = router;
module.exports.handleLifecycleEvent = handleLifecycleEvent;
