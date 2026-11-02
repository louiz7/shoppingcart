'use strict';

const db = require('../db');

const LIMIT_REASON = 'monthly_minute_limit_reached';

function isMonthlyLimitReached(maxMinutes, usedSeconds) {
    return maxMinutes !== null && maxMinutes !== undefined && Number(usedSeconds) >= Number(maxMinutes) * 60;
}

async function resumeExpiredLimitPauses(executor = db) {
    const { rows } = await executor.query(
        `UPDATE campaigns
            SET status = 'active', pause_reason = NULL, limit_pause_month = NULL,
                paused_at = NULL, updated_at = NOW()
          WHERE status = 'paused'
            AND pause_reason = $1
            AND limit_pause_month < date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date
        RETURNING id, customer_id`,
        [LIMIT_REASON],
    );
    if (rows.length) {
        await executor.query(
            `UPDATE campaign_jobs
                SET scheduled_at = NOW(), locked_at = NULL, last_error = NULL
              WHERE status = 'pending' AND last_error = $1
                AND campaign_id = ANY($2::bigint[])`,
            [LIMIT_REASON, rows.map((row) => row.id)],
        );
        await executor.query(
            `UPDATE campaign_members member
                SET next_contact_at = pending.next_at, last_error = NULL, updated_at = NOW()
               FROM (
                 SELECT member_id, MIN(scheduled_at) AS next_at
                   FROM campaign_jobs
                  WHERE status = 'pending' AND campaign_id = ANY($1::bigint[])
                  GROUP BY member_id
               ) pending
              WHERE member.id = pending.member_id`,
            [rows.map((row) => row.id)],
        );
    }
    return rows;
}

async function getCurrentLimitState(customerId, executor = db) {
    const { rows } = await executor.query(
        `WITH current_period AS (
           SELECT date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date AS month_start,
                  (date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin') + INTERVAL '1 month')
                    AT TIME ZONE 'Europe/Berlin' AS month_end,
                  date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')
                    AT TIME ZONE 'Europe/Berlin' AS month_begin
         ), configured AS (
           SELECT limit_config.max_minutes
             FROM organization_monthly_call_limits limit_config, current_period
            WHERE limit_config.customer_id = $1
              AND limit_config.effective_month <= current_period.month_start
            ORDER BY limit_config.effective_month DESC
            LIMIT 1
         )
         SELECT configured.max_minutes,
                COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
                  WHERE attempt.connected_at IS NOT NULL AND attempt.ended_at IS NOT NULL
                    AND attempt.duration_source <> 'legacy_unknown'
                ), 0)::text AS used_seconds
           FROM configured
           CROSS JOIN current_period
           LEFT JOIN call_attempts attempt
             ON attempt.customer_id = $1
            AND attempt.started_at >= current_period.month_begin
            AND attempt.started_at < current_period.month_end
          GROUP BY configured.max_minutes`,
        [customerId],
    );
    if (!rows[0] || rows[0].max_minutes === null) {
        return { limited: false, reached: false, maxMinutes: null, usedSeconds: 0 };
    }
    const maxMinutes = Number(rows[0].max_minutes);
    const usedSeconds = Number(rows[0].used_seconds);
    return { limited: true, reached: isMonthlyLimitReached(maxMinutes, usedSeconds), maxMinutes, usedSeconds };
}

async function enforceMonthlyCallLimit(customerId, executor = db) {
    const state = await getCurrentLimitState(customerId, executor);
    if (!state.reached) return state;

    const { rows } = await executor.query(
        `UPDATE campaigns
            SET status = 'paused', pause_reason = $2,
                limit_pause_month = date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date,
                paused_at = NOW(), updated_at = NOW()
          WHERE customer_id = $1 AND status = 'active'
        RETURNING id`,
        [customerId, LIMIT_REASON],
    );
    for (const campaign of rows) {
        await executor.query(
            `INSERT INTO campaign_events (customer_id, campaign_id, actor, kind, data)
             VALUES ($1, $2, 'system', 'campaign_paused_monthly_minute_limit', $3)`,
            [customerId, campaign.id, JSON.stringify({ max_minutes: state.maxMinutes, used_seconds: state.usedSeconds })],
        );
    }
    return { ...state, pausedCampaignIds: rows.map((row) => row.id) };
}

module.exports = { LIMIT_REASON, isMonthlyLimitReached, getCurrentLimitState, enforceMonthlyCallLimit, resumeExpiredLimitPauses };
