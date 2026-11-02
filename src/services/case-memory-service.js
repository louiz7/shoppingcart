'use strict';

const policyEngine = require('../policy/engine');

const RECENT_CALL_LIMIT = 5;
const OPEN_TASK_LIMIT = 5;

function iso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function buildCaseMemory({ attemptStats = {}, conversationRows = [], taskRows = [], planRow = null, currency = 'EUR' }) {
    const recentConversations = conversationRows.map((row) => ({
        started_at: iso(row.started_at),
        ended_at: iso(row.ended_at),
        disposition: row.disposition || null,
        summary: row.summary || null,
    }));

    const openTasks = taskRows.map((row) => ({
        kind: row.kind,
        title: row.title,
        detail: row.detail || null,
        priority: row.priority,
        status: row.status,
        created_at: iso(row.created_at),
    }));

    const paymentPlan = planRow ? {
        status: planRow.status,
        installments: Number(planRow.installments),
        installment_amount: policyEngine.formatCents(planRow.installment_cents, currency),
        total_amount: policyEngine.formatCents(planRow.total_cents, currency),
        discount_pct: Number(planRow.discount_pct),
        first_due_date: String(planRow.first_due_date).slice(0, 10),
        created_at: iso(planRow.created_at),
    } : null;

    return {
        previous_attempt_count: Number(attemptStats.previous_attempt_count || 0),
        unreached_attempt_count: Number(attemptStats.unreached_attempt_count || 0),
        last_attempt_at: iso(attemptStats.last_attempt_at),
        last_reached_at: iso(attemptStats.last_reached_at),
        recent_conversations: recentConversations,
        open_tasks: openTasks,
        current_payment_plan: paymentPlan,
    };
}

async function loadCaseMemory(db, callCtx, currency) {
    const [attemptsResult, conversationsResult, tasksResult, planResult] = await Promise.all([
        db.query(
            `SELECT COUNT(*)::int AS previous_attempt_count,
                    COUNT(*) FILTER (
                        WHERE disposition IS NULL
                           OR disposition IN ('voicemail', 'dial_failed')
                    )::int AS unreached_attempt_count,
                    MAX(started_at) AS last_attempt_at,
                    MAX(started_at) FILTER (
                        WHERE disposition IS NOT NULL
                          AND disposition NOT IN ('voicemail', 'dial_failed')
                    ) AS last_reached_at
               FROM call_attempts
              WHERE customer_id = $1
                AND case_id = $2
                AND id <> $3`,
            [callCtx.customer_id, callCtx.case_id, callCtx.call_attempt_id],
        ),
        db.query(
            `SELECT ca.started_at, ca.ended_at, ca.disposition,
                    COALESCE(NULLIF(outcome_event.summary, ''), ca.outcome) AS summary
               FROM call_attempts ca
               LEFT JOIN LATERAL (
                    SELECT e.request->>'summary' AS summary
                      FROM events e
                     WHERE e.customer_id = ca.customer_id
                       AND e.case_id = ca.case_id
                       AND e.call_attempt_id = ca.id
                       AND e.kind = 'log_call_outcome'
                       AND e.decision = 'allow'
                     ORDER BY e.created_at DESC, e.id DESC
                     LIMIT 1
               ) outcome_event ON TRUE
              WHERE ca.customer_id = $1
                AND ca.case_id = $2
                AND ca.id <> $3
                AND ca.disposition IS NOT NULL
                AND ca.disposition NOT IN ('voicemail', 'dial_failed')
              ORDER BY ca.started_at DESC, ca.id DESC
              LIMIT $4`,
            [callCtx.customer_id, callCtx.case_id, callCtx.call_attempt_id, RECENT_CALL_LIMIT],
        ),
        db.query(
            `SELECT kind, title, detail, priority, status, created_at
               FROM platform_tasks
              WHERE customer_id = $1
                AND case_id = $2
                AND status IN ('open', 'in_progress')
              ORDER BY CASE priority
                           WHEN 'urgent' THEN 1
                           WHEN 'high' THEN 2
                           WHEN 'normal' THEN 3
                           ELSE 4
                       END,
                       created_at DESC
              LIMIT $3`,
            [callCtx.customer_id, callCtx.case_id, OPEN_TASK_LIMIT],
        ),
        db.query(
            `SELECT pp.status, pp.installments, pp.installment_cents, pp.total_cents,
                    pp.discount_pct, pp.first_due_date, pp.created_at
               FROM payment_plans pp
               JOIN cases c ON c.id = pp.case_id AND c.customer_id = pp.customer_id
              WHERE pp.customer_id = $1
                AND pp.case_id = $2
                AND NOT c.disputed
                AND pp.status IN ('pending_approval', 'approved', 'active')
              ORDER BY pp.created_at DESC, pp.id DESC
              LIMIT 1`,
            [callCtx.customer_id, callCtx.case_id],
        ),
    ]);

    return buildCaseMemory({
        attemptStats: attemptsResult.rows[0] || {},
        conversationRows: conversationsResult.rows,
        taskRows: tasksResult.rows,
        planRow: planResult.rows[0] || null,
        currency,
    });
}

module.exports = { buildCaseMemory, loadCaseMemory };
