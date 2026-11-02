'use strict';

const db = require('../db');
const { randomUUID } = require('node:crypto');

async function transaction(fn) {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally { client.release(); }
}

async function event(executor, shopId, kind, data = {}, callId = null, durationMs = null, id = randomUUID()) {
    return executor.query(`INSERT INTO recovery_events (id,shop_id,call_id,kind,data,duration_ms)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [id, shopId, callId, kind, JSON.stringify(data), durationMs]);
}

module.exports = { db, transaction, event };
