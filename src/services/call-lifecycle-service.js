'use strict';

const db = require('../db');
const { computeCost } = require('../usage');

function bounded(value, max = 200) {
    const text = String(value || '').trim();
    return text ? text.slice(0, max) : null;
}

function eventTime(value) {
    if (!value) return new Date();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
}

function calculateVoiceSeconds({ connectedAt, endedAt, durationSource }) {
    if (!connectedAt || !endedAt || durationSource === 'legacy_unknown') return 0;
    const connectedMs = new Date(connectedAt).getTime();
    const endedMs = new Date(endedAt).getTime();
    if (!Number.isFinite(connectedMs) || !Number.isFinite(endedMs)) return 0;
    return Math.max(0, (endedMs - connectedMs) / 1000);
}

async function appendEvent(client, attempt, kind, result = null, reasonCode = null) {
    await client.query(
        `INSERT INTO events (
            customer_id, case_id, call_attempt_id, actor, channel, kind,
            result, decision, reason_code
         ) VALUES ($1, $2, $3, 'system', 'voice', $4, $5, 'allow', $6)`,
        [
            attempt.customer_id,
            attempt.case_id,
            attempt.id,
            kind,
            result ? JSON.stringify(result) : null,
            reasonCode,
        ],
    );
}

async function inTransaction(work) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function markConnected({ attemptId, roomName, sipCallId, at = new Date() }) {
    return inTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE call_attempts
                SET connected_at = COALESCE(connected_at, $2),
                    livekit_room = COALESCE($3, livekit_room),
                    sip_call_id = COALESCE($4, sip_call_id),
                    lifecycle_status = CASE
                        WHEN ended_at IS NULL THEN 'connected'
                        ELSE lifecycle_status
                    END,
                    duration_source = CASE
                        WHEN duration_source = 'legacy_unknown' THEN duration_source
                        ELSE 'livekit'
                    END
              WHERE id = $1
                AND connected_at IS NULL
                AND ended_at IS NULL
              RETURNING id, customer_id, case_id, connected_at, livekit_room, sip_call_id`,
            [attemptId, eventTime(at), roomName || null, sipCallId || null],
        );
        const attempt = rows[0];
        if (!attempt) return { changed: false };
        await appendEvent(client, attempt, 'call_connected', {
            connected_at: attempt.connected_at,
            room: attempt.livekit_room,
            sip_call_id: attempt.sip_call_id,
        });
        return { changed: true, attempt };
    });
}

async function markDialFailed({ attemptId, reason, sipStatusCode = null, at = new Date() }) {
    const safeReason = bounded(reason) || 'dial_failed';
    return inTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE call_attempts
                SET ended_at = COALESCE(ended_at, $2),
                    lifecycle_status = 'failed',
                    disconnect_reason = COALESCE(disconnect_reason, $3),
                    sip_status_code = COALESCE(sip_status_code, $4),
                    outcome = COALESCE(outcome, 'dial_failed'),
                    disposition = COALESCE(disposition, 'dial_failed')
              WHERE id = $1
                AND connected_at IS NULL
                AND ended_at IS NULL
              RETURNING id, customer_id, case_id, ended_at`,
            [attemptId, eventTime(at), safeReason, sipStatusCode],
        );
        const attempt = rows[0];
        if (!attempt) return { changed: false };
        await client.query(
            'UPDATE call_tokens SET revoked = TRUE WHERE call_attempt_id = $1 AND NOT revoked',
            [attempt.id],
        );
        await appendEvent(
            client,
            attempt,
            'call_failed',
            { ended_at: attempt.ended_at, sip_status_code: sipStatusCode },
            safeReason,
        );
        return { changed: true, attempt };
    });
}

async function markHangupRequested({ attemptId, reason, at = new Date() }) {
    const safeReason = bounded(reason) || 'hangup_requested';
    return inTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE call_attempts
                SET hangup_requested_at = COALESCE(hangup_requested_at, $2)
              WHERE id = $1
                AND hangup_requested_at IS NULL
              RETURNING id, customer_id, case_id, hangup_requested_at`,
            [attemptId, eventTime(at)],
        );
        const attempt = rows[0];
        if (!attempt) return { changed: false };
        await appendEvent(client, attempt, 'call_hangup_requested', {
            requested_at: attempt.hangup_requested_at,
            reason: safeReason,
        });
        return { changed: true, attempt };
    });
}

async function markEnded({
    attemptId = null,
    roomName = null,
    reason,
    at = new Date(),
    durationSource = 'livekit',
}) {
    if (!attemptId && !roomName) throw new Error('attemptId or roomName is required');
    const safeReason = bounded(reason) || 'participant_left';
    return inTransaction(async (client) => {
        const { rows } = await client.query(
            `UPDATE call_attempts
                SET ended_at = $3,
                    lifecycle_status = CASE
                        WHEN connected_at IS NULL THEN 'failed'
                        ELSE 'ended'
                    END,
                    disconnect_reason = COALESCE(disconnect_reason, $4),
                    duration_source = CASE
                        WHEN $5 = 'legacy_unknown' THEN 'legacy_unknown'
                        ELSE duration_source
                    END,
                    outcome = CASE
                        WHEN connected_at IS NULL THEN COALESCE(outcome, 'dial_failed')
                        ELSE COALESCE(outcome, 'ended_without_outcome')
                    END,
                    disposition = CASE
                        WHEN connected_at IS NULL THEN COALESCE(disposition, 'dial_failed')
                        ELSE disposition
                    END
              WHERE (($1::bigint IS NOT NULL AND id = $1)
                  OR ($2::text IS NOT NULL AND livekit_room = $2))
                AND ended_at IS NULL
              RETURNING id, customer_id, case_id, campaign_id, campaign_member_id,
                        connected_at, ended_at, livekit_room, disposition`,
            [attemptId, roomName, eventTime(at), safeReason, durationSource],
        );
        const attempt = rows[0];
        if (!attempt) return { changed: false };
        await client.query(
            'UPDATE call_tokens SET revoked = TRUE WHERE call_attempt_id = $1 AND NOT revoked',
            [attempt.id],
        );
        await appendEvent(client, attempt, 'call_ended', {
            connected_at: attempt.connected_at,
            ended_at: attempt.ended_at,
            disconnect_reason: safeReason,
        }, safeReason);
        return { changed: true, attempt };
    });
}

async function getAttemptByRoom(roomName) {
    const { rows } = await db.query(
        `SELECT id, customer_id, case_id, campaign_id, campaign_member_id,
                connected_at, ended_at, livekit_room, disposition
           FROM call_attempts
          WHERE livekit_room = $1
          ORDER BY id DESC
          LIMIT 1`,
        [roomName],
    );
    return rows[0] || null;
}

/** Persist exactly one operational voice-usage row per call attempt. */
async function recordCallUsage(attemptId) {
    const { rows } = await db.query(
        `SELECT id, customer_id, connected_at, ended_at, duration_source
           FROM call_attempts
          WHERE id = $1 AND ended_at IS NOT NULL`,
        [attemptId],
    );
    const attempt = rows[0];
    if (!attempt) return { recorded: false, reason: 'attempt_not_ended' };

    const voiceSeconds = calculateVoiceSeconds({
        connectedAt: attempt.connected_at,
        endedAt: attempt.ended_at,
        durationSource: attempt.duration_source,
    });

    const result = await db.query(
        `INSERT INTO usage_events (
            customer_id, api_key_id, method, path, upstream_status,
            duration_ms, voice_seconds, cost_usd, error, call_id, source
         ) VALUES ($1, NULL, 'LIVEKIT', '/call-lifecycle/ended', 200,
                   $2, $3, $4, NULL, $5, 'livekit_call')
         ON CONFLICT (customer_id, source, call_id)
             WHERE call_id IS NOT NULL DO NOTHING`,
        [
            attempt.customer_id,
            Math.round(voiceSeconds * 1000),
            voiceSeconds,
            computeCost(voiceSeconds),
            `call_attempt:${attempt.id}`,
        ],
    );
    return { recorded: result.rowCount > 0, voiceSeconds };
}

module.exports = {
    markConnected,
    markDialFailed,
    markHangupRequested,
    markEnded,
    getAttemptByRoom,
    recordCallUsage,
    calculateVoiceSeconds,
};
