'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * GET /dashboard/usage
 * Authenticated as a customer (via API key). Returns aggregated + recent usage.
 *
 * Query params:
 *   from   ISO date (default: 30 days ago)
 *   to     ISO date (default: now)
 *   limit  number of recent events to include (default 50, max 500)
 */
router.get('/usage', async (req, res) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from
        ? new Date(req.query.from)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({ error: 'invalid_date_range' });
    }

    try {
        const summary = await db.query(
            `SELECT COUNT(*)::int                         AS total_calls,
                    COALESCE(SUM(voice_seconds), 0)::float AS total_seconds,
                    COALESCE(SUM(cost_usd), 0)::float      AS total_cost_usd,
                    COUNT(*) FILTER (WHERE upstream_status >= 400)::int AS error_count
               FROM usage_events
              WHERE customer_id = $1
                AND created_at BETWEEN $2 AND $3`,
            [req.customer.id, from, to],
        );

        const daily = await db.query(
            `SELECT date_trunc('day', created_at) AS day,
                    COUNT(*)::int                  AS calls,
                    COALESCE(SUM(voice_seconds), 0)::float AS seconds,
                    COALESCE(SUM(cost_usd), 0)::float      AS cost_usd
               FROM usage_events
              WHERE customer_id = $1
                AND created_at BETWEEN $2 AND $3
              GROUP BY day
              ORDER BY day ASC`,
            [req.customer.id, from, to],
        );

        const recent = await db.query(
            `SELECT created_at, method, path, upstream_status,
                    duration_ms, voice_seconds, cost_usd, error
               FROM usage_events
              WHERE customer_id = $1
              ORDER BY created_at DESC
              LIMIT $2`,
            [req.customer.id, limit],
        );

        res.json({
            customer: { id: req.customer.id, name: req.customer.name, email: req.customer.email },
            range: { from, to },
            summary: summary.rows[0],
            daily: daily.rows,
            recent: recent.rows,
        });
    } catch (err) {
        console.error('[dashboard] error', err);
        res.status(500).json({ error: 'dashboard_error' });
    }
});

module.exports = router;
