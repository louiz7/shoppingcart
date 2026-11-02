'use strict';

const { RoomServiceClient } = require('livekit-server-sdk');
const db = require('./db');
const policyEngine = require('./policy/engine');
const { nextCampaignAttemptAt } = require('./services/campaign-schedule-service');
const { placeCaseCall } = require('./services/case-call-service');
const callLifecycle = require('./services/call-lifecycle-service');
const { callbackExecutionBlockReason } = require('./services/callback-schedule-service');
const { enforceMonthlyCallLimit, resumeExpiredLimitPauses } = require('./services/monthly-call-limit-service');

const POLL_MS = parseInt(process.env.CAMPAIGN_SCHEDULER_POLL_MS || '5000', 10);
const LIVEKIT_URL = process.env.LIVEKIT_URL || '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const RECONCILE_MS = Math.max(10_000, parseInt(process.env.CALL_RECONCILE_INTERVAL_MS || '30000', 10));
const RECONCILE_GRACE_MS = Math.max(30_000, parseInt(process.env.CALL_RECONCILE_GRACE_MS || '60000', 10));
let timer = null;
let running = false;
let lastReconcileAt = 0;

async function claimJob() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        // Serialize the global capacity check across every backend replica.
        // The processing-job guard covers the short gap before placeCaseCall
        // creates its call_attempt row; the open-attempt guard then owns the
        // slot until LiveKit confirms that the call has ended.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('rescova:campaign-call-slot'))");
        await resumeExpiredLimitPauses(client);
        const { rows } = await client.query(
            `SELECT j.id, j.customer_id, j.campaign_id, j.member_id,
                    j.attempt_number, j.job_kind, j.scheduled_at
               FROM campaign_jobs j
               JOIN campaigns ca ON ca.id = j.campaign_id AND ca.customer_id = j.customer_id
               JOIN campaign_members cm ON cm.id = j.member_id
                                       AND cm.campaign_id = j.campaign_id
                                       AND cm.customer_id = j.customer_id
              WHERE j.status = 'pending'
                AND j.scheduled_at <= NOW()
                AND ca.status = 'active'
                AND cm.status IN ('pending', 'scheduled')
                AND (j.job_kind = 'callback' OR cm.attempt_count < ca.max_contact_attempts)
                AND NOT EXISTS (
                    SELECT 1
                      FROM campaign_jobs launching_job
                     WHERE launching_job.status = 'processing'
                )
                AND NOT EXISTS (
                    SELECT 1
                      FROM call_attempts active_campaign_call
                     WHERE active_campaign_call.campaign_id IS NOT NULL
                       AND active_campaign_call.ended_at IS NULL
                )
                AND NOT EXISTS (
                    SELECT 1
                      FROM call_attempts active_attempt
                     WHERE active_attempt.customer_id = j.customer_id
                       AND active_attempt.case_id = cm.case_id
                       AND active_attempt.ended_at IS NULL
                )
              ORDER BY CASE WHEN j.job_kind = 'callback' THEN 0 ELSE 1 END,
                       j.scheduled_at, j.id
              FOR UPDATE OF j SKIP LOCKED
              LIMIT 1`,
        );
        const job = rows[0];
        if (!job) {
            await client.query('COMMIT');
            return null;
        }
        await client.query(
            `UPDATE campaign_jobs SET status = 'processing', locked_at = NOW() WHERE id = $1`,
            [job.id],
        );
        await client.query(
            `UPDATE campaign_members SET status = 'contacting', updated_at = NOW() WHERE id = $1`,
            [job.member_id],
        );
        await client.query('COMMIT');
        return job;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function executeJob(job) {
    const limit = await enforceMonthlyCallLimit(job.customer_id);
    if (limit.reached) {
        await db.query(
            `UPDATE campaign_jobs
                SET status = 'pending', scheduled_at = NOW() + INTERVAL '1 hour',
                    locked_at = NULL, last_error = 'monthly_minute_limit_reached'
              WHERE id = $1`,
            [job.id],
        );
        await db.query(
            `UPDATE campaign_members
                SET status = 'scheduled', next_contact_at = NULL,
                    last_error = 'monthly_minute_limit_reached', updated_at = NOW()
              WHERE id = $1`,
            [job.member_id],
        );
        return;
    }
    const { rows: currentRows } = await db.query(
        `SELECT cm.status, cm.attempt_count, cm.case_id,
                ca.status AS campaign_status, ca.is_demo, ca.max_contact_attempts,
                ca.timezone, ca.weekdays, ca.start_time, ca.end_time,
                ca.max_attempts_per_24h, ca.max_attempts_per_7d, ca.retry_interval_minutes,
                c.amount_cents_outstanding, c.disputed, c.debtor_id, d.phone_e164,
                COALESCE(cs.state, 'NEW') AS case_state, cs.substate AS case_substate,
                ARRAY(
                    SELECT attempt.dial_started_at
                      FROM call_attempts attempt
                      JOIN cases attempted_case ON attempted_case.id = attempt.case_id
                     WHERE attempt.customer_id = cm.customer_id
                       AND attempted_case.customer_id = attempt.customer_id
                       AND attempted_case.debtor_id = c.debtor_id
                       AND attempt.dial_started_at > NOW() - INTERVAL '7 days'
                ) AS attempt_times,
                EXISTS (
                    SELECT 1 FROM suppression s
                     WHERE s.customer_id = cm.customer_id AND s.active
                       AND (s.expires_at IS NULL OR s.expires_at > NOW())
                       AND ((s.scope = 'debtor' AND s.debtor_id = c.debtor_id)
                         OR (s.scope = 'case' AND s.case_id = c.id)
                         OR (s.scope = 'number' AND s.phone_e164 = d.phone_e164))
                ) AS suppressed
           FROM campaign_members cm
           JOIN campaigns ca ON ca.id = cm.campaign_id AND ca.customer_id = cm.customer_id
           JOIN cases c ON c.id = cm.case_id AND c.customer_id = cm.customer_id
           JOIN debtors d ON d.id = c.debtor_id AND d.customer_id = cm.customer_id
           LEFT JOIN case_state cs ON cs.case_id = c.id
          WHERE cm.id = $1 AND cm.customer_id = $2`,
        [job.member_id, job.customer_id],
    );
    const current = currentRows[0];
    if (current?.campaign_status === 'paused' && current.status === 'contacting') {
        await db.query(
            `UPDATE campaign_jobs
                SET status = 'pending', scheduled_at = NOW() + INTERVAL '5 minutes',
                    locked_at = NULL, last_error = NULL
              WHERE id = $1`,
            [job.id],
        );
        await db.query(
            `UPDATE campaign_members SET status = 'scheduled', updated_at = NOW() WHERE id = $1`,
            [job.member_id],
        );
        return;
    }
    const isCallback = job.job_kind === 'callback';
    if (!current || current.status !== 'contacting' ||
        current.campaign_status !== 'active' || current.amount_cents_outstanding <= 0 ||
        (!isCallback && current.attempt_count >= current.max_contact_attempts)) {
        await db.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(), last_error = 'no_longer_eligible'
              WHERE id = $1`,
            [job.id],
        );
        if (current?.amount_cents_outstanding <= 0) {
            await db.query(
                `UPDATE campaign_members
                    SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()), updated_at = NOW()
                  WHERE id = $1`,
                [job.member_id],
            );
        }
        await completeCampaignIfDone(job.campaign_id, job.customer_id);
        return;
    }

    const gate = policyEngine.eligibleForCampaignCall({
        caseRow: current,
        state: current.case_state,
        substate: current.case_substate,
        suppressed: current.suppressed,
    });
    if (!gate.allow) {
        await db.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(), last_error = $2
              WHERE id = $1`,
            [job.id, gate.reason_code],
        );
        await db.query(
            `UPDATE campaign_members
                SET status = CASE
                        WHEN $2 IN ('case_disputed', 'suppressed') THEN 'suppressed'
                        WHEN $2 = 'nothing_outstanding' THEN 'resolved'
                        WHEN $2 = 'plan_pending_approval' THEN 'reached'
                        ELSE 'cancelled'
                    END,
                    resolved_at = CASE
                        WHEN $2 = 'nothing_outstanding' THEN NOW()
                        WHEN $2 = 'plan_pending_approval' THEN NULL
                        ELSE resolved_at
                    END,
                    reached_at = CASE WHEN $2 = 'plan_pending_approval' THEN COALESCE(reached_at, NOW()) ELSE reached_at END,
                    next_contact_at = NULL, last_error = $2, updated_at = NOW()
              WHERE id = $1`,
            [job.member_id, gate.reason_code],
        );
        await completeCampaignIfDone(job.campaign_id, job.customer_id);
        return;
    }

    if (isCallback) {
        const reason = callbackExecutionBlockReason({
            scheduledAt: job.scheduled_at,
            config: current,
            isDemo: current.is_demo,
        });
        if (reason) {
            await failCallback(job, current, reason);
            return;
        }
    }

    const now = new Date();
    if (!isCallback) {
        const schedule = nextCampaignAttemptAt({
            isDemo: current.is_demo,
            now,
            config: current,
            attemptTimes: current.attempt_times,
        });
        if (!schedule.next) throw new Error('campaign_has_no_eligible_time');
        if (schedule.next.getTime() > now.getTime()) {
            await db.query(
                `UPDATE campaign_jobs
                    SET status = 'pending', scheduled_at = $2, locked_at = NULL, last_error = $3
                  WHERE id = $1`,
                [job.id, schedule.next, schedule.reason],
            );
            await db.query(
                `UPDATE campaign_members
                    SET status = 'scheduled', next_contact_at = $2, last_error = $3, updated_at = NOW()
                  WHERE id = $1`,
                [job.member_id, schedule.next, schedule.reason],
            );
            return;
        }
    }

    try {
        await placeCaseCall({
            customerId: job.customer_id,
            caseId: current.case_id,
            phoneE164: current.phone_e164,
            campaignId: job.campaign_id,
            campaignMemberId: job.member_id,
            source: isCallback ? 'callback_scheduler' : 'campaign_scheduler',
            callPurpose: isCallback ? 'callback' : 'campaign',
        });
        await db.query(
            `UPDATE campaign_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
            [job.id],
        );
        await db.query(
            `UPDATE campaign_members
                SET attempt_count = attempt_count + 1, updated_at = NOW()
              WHERE id = $1`,
            [job.member_id],
        );
    } catch (error) {
        await db.query(
            `UPDATE campaign_jobs
                SET status = 'failed', completed_at = NOW(), last_error = $2
              WHERE id = $1`,
            [job.id, String(error.message || error).slice(0, 1000)],
        );
        await db.query(
            `UPDATE campaign_members
                SET attempt_count = attempt_count + 1, updated_at = NOW()
              WHERE id = $1`,
            [job.member_id],
        );
        if (isCallback) {
            await failCallback(job, current, 'callback_dial_failed');
            return;
        }
        await scheduleRetry(
            job.member_id,
            job.campaign_id,
            job.customer_id,
            job.attempt_number,
            Number.isInteger(error && error.callAttemptId) ? error.callAttemptId : null,
        );
    }
}

async function failCallback(job, current, reason) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE campaign_jobs
                SET status = 'failed', completed_at = NOW(), last_error = $2
              WHERE id = $1`,
            [job.id, reason],
        );
        await client.query(
            `UPDATE campaign_members
                SET status = 'reached', reached_at = COALESCE(reached_at, NOW()),
                    next_contact_at = NULL, last_error = $2, updated_at = NOW()
              WHERE id = $1`,
            [job.member_id, reason],
        );
        await client.query(
            `INSERT INTO platform_tasks (
                customer_id, campaign_id, case_id, kind, title, detail, priority
             )
             SELECT $1, $2, $3, 'callback_missed', 'Rückruf konnte nicht ausgeführt werden',
                    $4, 'high'
              WHERE NOT EXISTS (
                  SELECT 1 FROM platform_tasks
                   WHERE customer_id = $1 AND case_id = $3
                     AND kind = 'callback_missed'
                     AND status IN ('open', 'in_progress')
              )`,
            [
                job.customer_id,
                job.campaign_id,
                current.case_id,
                `Geplanter Rückruf: ${new Date(job.scheduled_at).toISOString()}; Grund: ${reason}`,
            ],
        );
        await client.query(
            `INSERT INTO events (
                customer_id, case_id, actor, channel, kind, result, decision, reason_code
             ) VALUES ($1, $2, 'system', 'voice', 'callback_missed', $3, 'deny', $4)`,
            [
                job.customer_id,
                current.case_id,
                JSON.stringify({ callback_at: new Date(job.scheduled_at).toISOString(), campaign_id: job.campaign_id }),
                reason,
            ],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    await completeCampaignIfDone(job.campaign_id, job.customer_id);
}

async function scheduleRetry(memberId, campaignId, customerId, previousAttempt, triggerCallAttemptId = null, executor = db) {
    const nextAttempt = Number(previousAttempt) + 1;
    const { rows } = await executor.query(
        `SELECT ca.status AS campaign_status, ca.is_demo, ca.max_contact_attempts,
                ca.timezone, ca.weekdays, ca.start_time, ca.end_time,
                ca.max_attempts_per_24h, ca.max_attempts_per_7d, ca.retry_interval_minutes,
                c.debtor_id, c.amount_cents_outstanding,
                COALESCE(cs.state, 'NEW') AS case_state,
                cs.substate AS case_substate,
                ARRAY(
                    SELECT attempt.dial_started_at
                      FROM call_attempts attempt
                      JOIN cases attempted_case ON attempted_case.id = attempt.case_id
                     WHERE attempt.customer_id = cm.customer_id
                       AND attempted_case.customer_id = attempt.customer_id
                       AND attempted_case.debtor_id = c.debtor_id
                       AND attempt.dial_started_at > NOW() - INTERVAL '7 days'
                ) AS attempt_times
           FROM campaign_members cm
           JOIN campaigns ca ON ca.id = cm.campaign_id AND ca.customer_id = cm.customer_id
           JOIN cases c ON c.id = cm.case_id AND c.customer_id = cm.customer_id
           LEFT JOIN case_state cs ON cs.case_id = c.id
          WHERE cm.id = $1 AND cm.campaign_id = $2 AND cm.customer_id = $3`,
        [memberId, campaignId, customerId],
    );
    const config = rows[0];
    const paid = config && (Number(config.amount_cents_outstanding) <= 0 || config.case_state === 'PAID');
    if (paid) {
        await executor.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(), last_error = 'nothing_outstanding'
              WHERE member_id = $1 AND customer_id = $2 AND status = 'pending'`,
            [memberId, customerId],
        );
        await executor.query(
            `UPDATE campaign_members
                SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()),
                    next_contact_at = NULL, updated_at = NOW()
              WHERE id = $1 AND customer_id = $2`,
            [memberId, customerId],
        );
        await completeCampaignIfDone(campaignId, customerId, executor);
        return;
    }
    const planPendingApproval = config?.case_state === 'PLAN_OFFERED' &&
        config?.case_substate === 'pending_human_approval';
    if (planPendingApproval) {
        await executor.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(), last_error = 'plan_pending_approval'
              WHERE member_id = $1 AND customer_id = $2 AND status = 'pending'`,
            [memberId, customerId],
        );
        await executor.query(
            `UPDATE campaign_members
                SET status = 'reached', reached_at = COALESCE(reached_at, NOW()),
                    resolved_at = NULL, next_contact_at = NULL,
                    last_error = 'plan_pending_approval', updated_at = NOW()
              WHERE id = $1 AND customer_id = $2`,
            [memberId, customerId],
        );
        await completeCampaignIfDone(campaignId, customerId, executor);
        return;
    }
    if (!config || !['active', 'paused'].includes(config.campaign_status) || nextAttempt > config.max_contact_attempts) {
        await executor.query(
            `UPDATE campaign_members
                SET status = 'failed', next_contact_at = NULL, updated_at = NOW()
              WHERE id = $1 AND customer_id = $2`,
            [memberId, customerId],
        );
        await completeCampaignIfDone(campaignId, customerId, executor);
        return;
    }
    const now = new Date();
    const notBefore = new Date(now.getTime() + Number(config.retry_interval_minutes) * 60_000);
    const schedule = nextCampaignAttemptAt({
        isDemo: config.is_demo,
        now,
        notBefore,
        config,
        attemptTimes: config.attempt_times,
    });
    if (!schedule.next) throw new Error('campaign_has_no_eligible_retry_time');
    await executor.query(
        `INSERT INTO campaign_jobs (
            customer_id, campaign_id, member_id, attempt_number, scheduled_at,
            trigger_call_attempt_id
         )
         SELECT $1, $2, $3, $4, $5, $6
           FROM campaign_members cm
           JOIN campaigns ca ON ca.id = cm.campaign_id
          WHERE cm.id = $3
            AND ca.status IN ('active', 'paused')
            AND $4 <= ca.max_contact_attempts
         ON CONFLICT DO NOTHING`,
        [customerId, campaignId, memberId, nextAttempt, schedule.next, triggerCallAttemptId],
    );
    await executor.query(
        `UPDATE campaign_members
            SET status = CASE WHEN EXISTS (
                    SELECT 1 FROM campaign_jobs j
                     WHERE j.member_id = $1 AND j.status = 'pending'
                ) THEN 'scheduled' ELSE 'failed' END,
                next_contact_at = (
                    SELECT MIN(j.scheduled_at) FROM campaign_jobs j
                     WHERE j.member_id = $1 AND j.status = 'pending'
                ),
                updated_at = NOW()
          WHERE id = $1`,
        [memberId],
    );
    await completeCampaignIfDone(campaignId, customerId, executor);
}

async function completeCampaignIfDone(campaignId, customerId, executor = db) {
    await executor.query(
        `UPDATE campaigns ca
            SET status = 'completed', completed_at = NOW(), updated_at = NOW()
          WHERE ca.id = $1
            AND ca.customer_id = $2
            AND ca.status IN ('active', 'paused')
            AND NOT EXISTS (
                SELECT 1
                  FROM campaign_members cm
                 WHERE cm.campaign_id = ca.id
                   AND cm.status IN ('pending', 'scheduled', 'contacting')
            )`,
        [campaignId, customerId],
    );
}

async function reconcileEndedAttempts() {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return;
    const { rows: openAttempts } = await db.query(
        `SELECT id, livekit_room, disconnect_observed_at
           FROM call_attempts
          WHERE ended_at IS NULL
            AND livekit_room IS NOT NULL
          ORDER BY started_at
          LIMIT 100`,
    );
    if (openAttempts.length === 0) return;

    const rooms = new RoomServiceClient(
        LIVEKIT_URL.replace('wss://', 'https://'),
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
    );
    const activeRooms = await rooms.listRooms(openAttempts.map((attempt) => attempt.livekit_room));
    const activeNames = new Set(activeRooms.map((room) => room.name));

    for (const attempt of openAttempts) {
        let sipParticipantPresent = false;
        if (activeNames.has(attempt.livekit_room)) {
            try {
                const participants = await rooms.listParticipants(attempt.livekit_room);
                sipParticipantPresent = participants.some((participant) => Number(participant.kind) === 3);
            } catch (error) {
                // A room can disappear between listRooms and listParticipants.
                if (!String(error.message || error).toLowerCase().includes('not found')) throw error;
            }
        }
        if (sipParticipantPresent) {
            if (attempt.disconnect_observed_at) {
                await db.query(
                    `UPDATE call_attempts
                        SET disconnect_observed_at = NULL
                      WHERE id = $1 AND ended_at IS NULL`,
                    [attempt.id],
                );
            }
            continue;
        }

        if (!attempt.disconnect_observed_at) {
            await db.query(
                `UPDATE call_attempts
                    SET disconnect_observed_at = NOW()
                  WHERE id = $1 AND ended_at IS NULL AND disconnect_observed_at IS NULL`,
                [attempt.id],
            );
            continue;
        }
        const observedAt = new Date(attempt.disconnect_observed_at);
        if (Date.now() - observedAt.getTime() < RECONCILE_GRACE_MS) continue;

        // The precise disconnect instant was lost with the webhook. Close the
        // stale attempt for state-machine progress, but explicitly mark its
        // duration untrusted so it cannot inflate dashboard or usage totals.
        await callLifecycle.markEnded({
            attemptId: attempt.id,
            reason: 'reconciled_without_sip_participant',
            at: observedAt,
            durationSource: 'legacy_unknown',
        });
        await callLifecycle.recordCallUsage(attempt.id);
        await finalizeCampaignAttempt(attempt.livekit_room);
    }
}

async function finalizeCampaignAttempt(roomName) {
    const { rows: attemptRows } = await db.query(
        `SELECT id
           FROM call_attempts
          WHERE livekit_room = $1
            AND campaign_member_id IS NOT NULL
            AND ended_at IS NOT NULL`,
        [roomName],
    );
    const callAttemptId = attemptRows[0]?.id;
    if (!callAttemptId) return;

    const lockClient = await db.pool.connect();
    try {
        await lockClient.query('BEGIN');
        // schedule_callback takes the matching transaction lock. Whichever
        // path starts second observes the first path's committed job/event.
        await lockClient.query('SELECT pg_advisory_xact_lock($1::bigint)', [callAttemptId]);
        await finalizeCampaignAttemptLocked(roomName, lockClient);
        await lockClient.query('COMMIT');
    } catch (error) {
        await lockClient.query('ROLLBACK');
        throw error;
    } finally {
        lockClient.release();
    }
}

async function finalizeCampaignAttemptLocked(roomName, client) {
    const { rows } = await client.query(
        `SELECT ca.id AS call_attempt_id, ca.campaign_id, ca.campaign_member_id,
                ca.customer_id, ca.disposition, c.amount_cents_outstanding,
                COALESCE(cs.state, 'NEW') AS case_state, cs.substate AS case_substate,
                EXISTS (
                    SELECT 1 FROM events callback_event
                     WHERE callback_event.call_attempt_id = ca.id
                       AND callback_event.customer_id = ca.customer_id
                       AND callback_event.kind = 'report_signal'
                       AND callback_event.request->>'signal' = 'callback_requested'
                ) AS callback_requested,
                COALESCE((
                    SELECT MAX(j.attempt_number)
                      FROM campaign_jobs j
                     WHERE j.member_id = cm.id
                ), cm.attempt_count) AS current_attempt_number
           FROM call_attempts ca
           JOIN campaign_members cm ON cm.id = ca.campaign_member_id
           JOIN cases c ON c.id = ca.case_id AND c.customer_id = ca.customer_id
           LEFT JOIN case_state cs ON cs.case_id = c.id
          WHERE ca.livekit_room = $1
            AND ca.campaign_member_id IS NOT NULL
            AND ca.ended_at IS NOT NULL`,
        [roomName],
    );
    const attempt = rows[0];
    if (!attempt) return;

    const paid = Number(attempt.amount_cents_outstanding) <= 0 || attempt.case_state === 'PAID';
    if (paid) {
        await client.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(), last_error = 'nothing_outstanding'
              WHERE member_id = $1 AND status = 'pending'`,
            [attempt.campaign_member_id],
        );
        await client.query(
            `UPDATE campaign_members
                SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW()),
                    next_contact_at = NULL, updated_at = NOW()
              WHERE id = $1`,
            [attempt.campaign_member_id],
        );
        await completeCampaignIfDone(attempt.campaign_id, attempt.customer_id, client);
        return;
    }

    const agreement = ['payment_promised', 'plan_agreed'].includes(attempt.disposition);
    const manualReview = ['paid_claimed', 'wrong_person', 'disputed', 'escalated'].includes(attempt.disposition);
    const planPendingApproval = attempt.case_state === 'PLAN_OFFERED' &&
        attempt.case_substate === 'pending_human_approval';
    if (agreement || manualReview || planPendingApproval) {
        await client.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(),
                    last_error = CASE WHEN $2 THEN 'plan_pending_approval' ELSE last_error END
              WHERE member_id = $1 AND status = 'pending'`,
            [attempt.campaign_member_id, planPendingApproval],
        );
        await client.query(
            `UPDATE campaign_members
                SET status = 'reached',
                    reached_at = COALESCE(reached_at, NOW()),
                    resolved_at = NULL,
                    next_contact_at = NULL,
                    last_error = CASE WHEN $2 THEN 'plan_pending_approval' ELSE last_error END,
                    updated_at = NOW()
              WHERE id = $1`,
            [attempt.campaign_member_id, planPendingApproval],
        );
        await completeCampaignIfDone(attempt.campaign_id, attempt.customer_id, client);
        return;
    }
    if (attempt.callback_requested) {
        const { rows: callbackRows } = await client.query(
            `SELECT scheduled_at
               FROM campaign_jobs
              WHERE member_id = $1
                AND customer_id = $2
                AND trigger_call_attempt_id = $3
                AND job_kind = 'callback'
                AND status = 'pending'
              LIMIT 1`,
            [attempt.campaign_member_id, attempt.customer_id, attempt.call_attempt_id],
        );
        if (callbackRows[0]) {
            await client.query(
                `UPDATE campaign_members
                    SET status = 'scheduled', reached_at = COALESCE(reached_at, NOW()),
                        next_contact_at = $2, last_error = NULL, updated_at = NOW()
                  WHERE id = $1`,
                [attempt.campaign_member_id, callbackRows[0].scheduled_at],
            );
            return;
        }
        await stopForIncompleteCallback(attempt, client);
        return;
    }
    if (attempt.disposition && !['voicemail', 'dial_failed'].includes(attempt.disposition)) {
        await client.query(
            'UPDATE campaign_members SET reached_at = COALESCE(reached_at, NOW()) WHERE id = $1',
            [attempt.campaign_member_id],
        );
    }
    await scheduleRetry(
        attempt.campaign_member_id,
        attempt.campaign_id,
        attempt.customer_id,
        attempt.current_attempt_number,
        attempt.call_attempt_id,
        client,
    );
}

async function stopForIncompleteCallback(attempt, transactionClient = null) {
    const client = transactionClient || await db.pool.connect();
    const managesTransaction = !transactionClient;
    try {
        if (managesTransaction) await client.query('BEGIN');
        await client.query(
            `UPDATE campaign_jobs
                SET status = 'cancelled', completed_at = NOW(),
                    last_error = 'callback_time_not_scheduled'
              WHERE member_id = $1
                AND customer_id = $2
                AND status = 'pending'`,
            [attempt.campaign_member_id, attempt.customer_id],
        );
        await client.query(
            `UPDATE campaign_members
                SET status = 'reached', reached_at = COALESCE(reached_at, NOW()),
                    next_contact_at = NULL,
                    last_error = 'callback_time_not_scheduled', updated_at = NOW()
              WHERE id = $1 AND customer_id = $2`,
            [attempt.campaign_member_id, attempt.customer_id],
        );
        await client.query(
            `INSERT INTO platform_tasks (
                customer_id, campaign_id, case_id, kind, title, detail, priority
             )
             SELECT $1, $2, ca.case_id, 'callback_follow_up',
                    'Rückrufzeit muss geklärt werden',
                    'Ein Rückruf wurde gewünscht, aber kein verbindlicher Termin gespeichert.',
                    'high'
               FROM call_attempts ca
              WHERE ca.id = $3 AND ca.customer_id = $1
                AND NOT EXISTS (
                    SELECT 1 FROM platform_tasks task
                     WHERE task.customer_id = $1
                       AND task.case_id = ca.case_id
                       AND task.kind = 'callback_follow_up'
                       AND task.status IN ('open', 'in_progress')
                )`,
            [attempt.customer_id, attempt.campaign_id, attempt.call_attempt_id],
        );
        if (managesTransaction) await client.query('COMMIT');
    } catch (error) {
        if (managesTransaction) await client.query('ROLLBACK');
        throw error;
    } finally {
        if (managesTransaction) client.release();
    }
    await completeCampaignIfDone(
        attempt.campaign_id,
        attempt.customer_id,
        transactionClient || db,
    );
}

async function tick() {
    if (running) return;
    running = true;
    try {
        const now = Date.now();
        if (now - lastReconcileAt >= RECONCILE_MS) {
            lastReconcileAt = now;
            await reconcileEndedAttempts();
        }
        const job = await claimJob();
        if (job) await executeJob(job);
    } catch (error) {
        console.error('[campaign-scheduler] tick failed', error);
    } finally {
        running = false;
    }
}

function startCampaignScheduler() {
    if (process.env.CAMPAIGN_SCHEDULER_ENABLED === '0' || timer) return;
    void db.query(
        `WITH stale AS (
            UPDATE campaign_jobs
               SET status = 'pending', locked_at = NULL
             WHERE status = 'processing'
               AND locked_at < NOW() - INTERVAL '10 minutes'
             RETURNING member_id
         )
         UPDATE campaign_members
            SET status = 'scheduled', updated_at = NOW()
          WHERE id IN (SELECT member_id FROM stale)
            AND status = 'contacting'`,
    ).catch((error) => console.error('[campaign-scheduler] stale-job recovery failed', error));
    timer = setInterval(tick, POLL_MS);
    timer.unref();
    void tick();
    console.log(`[campaign-scheduler] started (poll=${POLL_MS}ms)`);
}

module.exports = { startCampaignScheduler, finalizeCampaignAttempt, tick };
