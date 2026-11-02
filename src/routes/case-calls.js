'use strict';

/**
 * POST /v1/cases/:caseId/call — dial a debtor for a specific case.
 *
 * Customer-facing (API-key auth). Deterministic dial-time gate: the policy
 * engine checks state, dispute, suppression, call window, and frequency caps
 * BEFORE any call is placed. On allow:
 *   1. create a call_attempts row
 *   2. mint a short-lived single-case call token (SHA-256 at rest) — the
 *      token, not the case_id, is what authorizes every mid-call tool call
 *   3. create a LiveKit room whose metadata carries ONLY non-sensitive
 *      routing (persona + call token). Case PII is fetched live by the agent
 *      via get_case_context, never baked into metadata.
 *   4. dial the debtor's number into the room via the SIP trunk
 */

const express = require('express');
const db = require('../db');
const policyEngine = require('../policy/engine');
const { nextEligibleAt } = require('../services/campaign-schedule-service');
const { placeCaseCall, assertConfigured } = require('../services/case-call-service');

const router = express.Router();

router.post('/:caseId/call', async (req, res) => {
    try {
        assertConfigured();
    } catch {
        return res.status(503).json({ error: 'sip_trunk_not_configured' });
    }

    const caseId = parseInt(req.params.caseId, 10);
    if (!Number.isInteger(caseId)) {
        return res.status(400).json({ error: 'invalid_case_id' });
    }

    try {
        const { rows } = await db.query(
            `SELECT c.*, d.phone_e164, d.id AS debtor_id,
                    COALESCE(s.state, 'NEW') AS state, s.substate,
                    defaults.timezone, defaults.weekdays, defaults.start_time, defaults.end_time,
                    defaults.max_attempts_per_24h, defaults.max_attempts_per_7d,
                    EXISTS (
                        SELECT 1 FROM suppression sup
                         WHERE sup.customer_id = c.customer_id AND sup.active
                           AND (sup.expires_at IS NULL OR sup.expires_at > NOW())
                           AND (   (sup.scope = 'debtor' AND sup.debtor_id = c.debtor_id)
                                OR (sup.scope = 'case'   AND sup.case_id = c.id)
                                OR (sup.scope = 'number' AND sup.phone_e164 = d.phone_e164))
                    ) AS suppressed,
                    ARRAY(
                        SELECT attempt.dial_started_at
                          FROM call_attempts attempt
                          JOIN cases attempted_case ON attempted_case.id = attempt.case_id
                         WHERE attempt.customer_id = c.customer_id
                           AND attempted_case.customer_id = attempt.customer_id
                           AND attempted_case.debtor_id = c.debtor_id
                           AND attempt.dial_started_at > NOW() - INTERVAL '7 days'
                    ) AS attempt_times
               FROM cases c
               JOIN debtors d ON d.id = c.debtor_id
               LEFT JOIN case_state s ON s.case_id = c.id
               JOIN organization_campaign_defaults defaults ON defaults.customer_id = c.customer_id
              WHERE c.id = $1 AND c.customer_id = $2`,
            [caseId, req.customer.id],
        );
        if (rows.length === 0) {
            return res.status(404).json({ error: 'case_not_found' });
        }
        const row = rows[0];
        const gate = policyEngine.eligibleForCampaignCall({
            caseRow: row,
            state: row.state,
            substate: row.substate,
            suppressed: row.suppressed,
        });
        if (!gate.allow) {
            await db.query(
                `INSERT INTO events (customer_id, case_id, actor, channel, kind, decision, reason_code)
                 VALUES ($1, $2, 'policy', 'voice', 'dial_attempt', 'deny', $3)`,
                [req.customer.id, caseId, gate.reason_code],
            );
            return res.status(409).json({ error: 'not_dialable', reason: gate.reason_code });
        }
        const now = new Date();
        const schedule = nextEligibleAt({ now, config: row, attemptTimes: row.attempt_times });
        if (!schedule.next || schedule.next.getTime() > now.getTime()) {
            const reason = schedule.reason || 'outside_organization_call_window';
            await db.query(
                `INSERT INTO events (customer_id, case_id, actor, channel, kind, decision, reason_code)
                 VALUES ($1, $2, 'policy', 'voice', 'dial_attempt', 'deny', $3)`,
                [req.customer.id, caseId, reason],
            );
            return res.status(409).json({
                error: 'not_dialable',
                reason,
                next_eligible_at: schedule.next?.toISOString() || null,
            });
        }

        const call = await placeCaseCall({
            customerId: req.customer.id,
            caseId,
            phoneE164: row.phone_e164,
            source: 'case_api',
        });
        res.json({
            call_attempt_id: call.callAttemptId,
            room: call.room,
            sipCallId: call.sipCallId,
        });
    } catch (err) {
        console.error('[case-calls] dial failed', err);
        res.status(500).json({ error: 'dial_failed', message: err.message });
    }
});

module.exports = router;
