'use strict';

const db = require('./db');
const emailService = require('./services/email-service');

const POLL_MS = Math.max(15_000, Number(process.env.EMAIL_POLL_INTERVAL_MS || 60_000));
const JOB_RETRY_LIMIT = 5;
let timer = null;
let running = false;

async function pollAccount(account) {
    const connector = emailService.connectorFor(account.provider);
    const syncStartedAt = new Date();
    try {
        if (account.status === 'pending') await connector.verify(account);
        const result = await connector.sync(account);
        const messages = Array.isArray(result) ? result : result.messages;
        for (const message of messages) await emailService.ingestMessage(account, message);
        await db.query(
            `UPDATE email_accounts
                SET status = 'connected', sync_cursor = COALESCE($1, sync_cursor),
                    last_synced_at = $2, last_error = NULL, updated_at = NOW()
              WHERE id = $3 AND customer_id = $4 AND status <> 'disabled'`,
            [Array.isArray(result) ? null : result.cursor, syncStartedAt, account.id, account.customer_id],
        );
    } catch (error) {
        await db.query(
            `UPDATE email_accounts SET status = 'error', last_error = $1, updated_at = NOW()
              WHERE id = $2 AND customer_id = $3`,
            [String(error.message || error).slice(0, 500), account.id, account.customer_id],
        );
    }
}

async function claimJob() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT id, customer_id, email_account_id, email_message_id, kind, attempt_count
               FROM email_jobs
              WHERE status = 'pending' AND scheduled_at <= NOW()
              ORDER BY scheduled_at, id
              FOR UPDATE SKIP LOCKED LIMIT 1`,
        );
        if (!rows[0]) {
            await client.query('COMMIT');
            return null;
        }
        await client.query(
            `UPDATE email_jobs SET status = 'processing', locked_at = NOW(), attempt_count = attempt_count + 1
              WHERE id = $1`, [rows[0].id],
        );
        await client.query('COMMIT');
        return { ...rows[0], attempt_count: Number(rows[0].attempt_count) + 1 };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function processJob(job) {
    try {
        if (job.kind === 'classify') await emailService.createDraft(job);
        else if (job.kind === 'send_draft') await emailService.sendDraft(job);
        else throw new Error('unsupported_email_job');
    } catch (error) {
        const final = job.attempt_count >= JOB_RETRY_LIMIT;
        await db.query(
            `UPDATE email_jobs
                SET status = $2, locked_at = NULL, last_error = $3,
                    scheduled_at = CASE WHEN $2 = 'pending'
                        THEN NOW() + (POWER(2, LEAST(attempt_count, 8)) || ' minutes')::interval
                        ELSE scheduled_at END,
                    completed_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE NULL END
              WHERE id = $1`,
            [job.id, final ? 'failed' : 'pending', String(error.message || error).slice(0, 500)],
        );
        if (job.kind === 'send_draft') {
            await db.query(
                `UPDATE email_drafts SET status = $1, last_error = $2, updated_at = NOW()
                  WHERE source_message_id = $3 AND customer_id = $4`,
                [final ? 'failed' : 'approved', String(error.message || error).slice(0, 500),
                    job.email_message_id, job.customer_id],
            );
        }
    }
}

async function tick() {
    if (running) return;
    running = true;
    try {
        const { rows: accounts } = await db.query(
            `SELECT a.* FROM email_accounts a
              JOIN customers c ON c.id = a.customer_id AND c.email_automation_enabled
              WHERE a.status IN ('pending', 'connected', 'error') AND a.automation_mode <> 'disabled'
                AND (a.last_synced_at IS NULL OR a.last_synced_at < NOW() - ($1 || ' milliseconds')::interval)
              ORDER BY a.last_synced_at NULLS FIRST LIMIT 20`, [POLL_MS],
        );
        for (const account of accounts) await pollAccount(account);
        for (let count = 0; count < 10; count += 1) {
            const job = await claimJob();
            if (!job) break;
            await processJob(job);
        }
    } catch (error) {
        console.error('[email-worker] tick failed', error);
    } finally {
        running = false;
    }
}

function startEmailWorker() {
    if (process.env.EMAIL_WORKER_ENABLED === '0' || timer) return;
    void db.query(
        `UPDATE email_jobs SET status = 'pending', locked_at = NULL
          WHERE status = 'processing' AND locked_at < NOW() - INTERVAL '15 minutes'`,
    ).catch((error) => console.error('[email-worker] stale recovery failed', error));
    timer = setInterval(tick, POLL_MS);
    timer.unref();
    void tick();
    console.log(`[email-worker] started (poll=${POLL_MS}ms)`);
}

module.exports = { startEmailWorker, tick, pollAccount, claimJob, processJob };
