'use strict';

const db = require('../db');
const graph = require('./email-connectors/microsoft-graph');
const imap = require('./email-connectors/imap-smtp');
const { normalizeAddress, boundedHeader, plainText } = require('./email-utils');
const { loadShopifyContext, contextualDraft } = require('./shopify-context-service');
const { generateEmailDraft } = require('./openai-email-service');

const connectors = { microsoft_graph: graph, imap_smtp: imap };

function connectorFor(provider) {
    const connector = connectors[provider];
    if (!connector) throw new Error('unsupported_email_provider');
    return connector;
}

function isAutomatedMessage(message, accountAddress) {
    const from = normalizeAddress(message.from);
    if (!from || from === normalizeAddress(accountAddress)) return true;
    const headers = message.headers || {};
    const autoSubmitted = String(headers['auto-submitted'] || '').toLowerCase();
    const precedence = String(headers.precedence || '').toLowerCase();
    return (autoSubmitted && autoSubmitted !== 'no') ||
        ['bulk', 'junk', 'list'].includes(precedence) ||
        /^(mailer-daemon|postmaster)@/.test(from);
}

async function matchCase(client, customerId, fromAddress, subject) {
    const { rows: debtors } = await client.query(
        `SELECT id FROM debtors
          WHERE customer_id = $1 AND LOWER(TRIM(email)) = $2
          ORDER BY id LIMIT 3`,
        [customerId, fromAddress],
    );
    if (debtors.length !== 1) {
        return { debtorId: null, caseId: null, status: debtors.length > 1 ? 'ambiguous' : 'unmatched' };
    }
    const debtorId = debtors[0].id;
    const { rows: cases } = await client.query(
        `SELECT id, external_ref, invoice_number, file_number, sub_file_number
           FROM cases
          WHERE customer_id = $1 AND debtor_id = $2 AND amount_cents_outstanding > 0
          ORDER BY updated_at DESC, id DESC`,
        [customerId, debtorId],
    );
    if (cases.length === 1) return { debtorId, caseId: cases[0].id, status: 'matched' };
    const subjectLower = String(subject || '').toLowerCase();
    const explicit = cases.filter((row) => [row.external_ref, row.invoice_number, row.file_number, row.sub_file_number]
        .filter(Boolean).some((reference) => subjectLower.includes(String(reference).toLowerCase())));
    if (explicit.length === 1) return { debtorId, caseId: explicit[0].id, status: 'matched' };
    return { debtorId, caseId: null, status: cases.length ? 'ambiguous' : 'unmatched' };
}

async function ingestMessage(account, message) {
    const from = normalizeAddress(message.from);
    if (!from || isAutomatedMessage(message, account.email_address)) return { ignored: true };
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const match = await matchCase(client, account.customer_id, from, message.subject);
        const providerThreadId = boundedHeader(
            message.providerThreadId || message.internetMessageId || message.providerMessageId, 500,
        );
        const rawReferences = message.headers?.references;
        const references = [message.headers?.['in-reply-to'],
            ...(Array.isArray(rawReferences) ? rawReferences : [rawReferences])]
            .map((value) => boundedHeader(value, 500)).filter(Boolean).slice(-20);
        let thread = null;
        if (references.length) {
            const { rows: referencedThreads } = await client.query(
                `SELECT t.id, t.case_id, t.match_status
                   FROM email_messages em
                   JOIN email_threads t ON t.id = em.thread_id AND t.customer_id = em.customer_id
                  WHERE em.customer_id = $1 AND em.email_account_id = $2
                    AND em.internet_message_id = ANY($3::text[])
                  ORDER BY em.created_at DESC LIMIT 1`,
                [account.customer_id, account.id, references],
            );
            thread = referencedThreads[0] || null;
            if (thread) {
                await client.query(
                    `UPDATE email_threads SET updated_at = NOW() WHERE id = $1 AND customer_id = $2`,
                    [thread.id, account.customer_id],
                );
            }
        }
        if (!thread) {
            const { rows: threadRows } = await client.query(
                `INSERT INTO email_threads (
                    customer_id, email_account_id, provider_thread_id, debtor_id, case_id, match_status
                 ) VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (email_account_id, provider_thread_id) DO UPDATE SET
                    debtor_id = COALESCE(email_threads.debtor_id, EXCLUDED.debtor_id),
                    case_id = COALESCE(email_threads.case_id, EXCLUDED.case_id),
                    match_status = CASE WHEN email_threads.case_id IS NOT NULL THEN 'matched' ELSE EXCLUDED.match_status END,
                    updated_at = NOW()
                 RETURNING id, case_id, match_status`,
                [account.customer_id, account.id, providerThreadId, match.debtorId, match.caseId, match.status],
            );
            thread = threadRows[0];
        }
        const { rows: messageRows } = await client.query(
            `INSERT INTO email_messages (
                customer_id, email_account_id, thread_id, provider_message_id,
                internet_message_id, direction, from_address, to_addresses,
                subject, body_text, headers, received_at
             ) VALUES ($1, $2, $3, $4, $5, 'inbound', $6, $7, $8, $9, $10, $11)
             ON CONFLICT (email_account_id, provider_message_id) DO NOTHING
             RETURNING id`,
            [
                account.customer_id, account.id, thread.id, boundedHeader(message.providerMessageId, 500),
                boundedHeader(message.internetMessageId, 500) || null, from,
                JSON.stringify((message.to || []).map(normalizeAddress).filter(Boolean).slice(0, 25)),
                boundedHeader(message.subject, 500), plainText(message.bodyText),
                JSON.stringify(message.headers || {}), message.receivedAt || new Date(),
            ],
        );
        if (!messageRows[0]) {
            await client.query('COMMIT');
            return { duplicate: true };
        }
        const messageId = messageRows[0].id;
        await client.query(
            `INSERT INTO email_jobs (customer_id, email_account_id, email_message_id, kind)
             VALUES ($1, $2, $3, 'classify') ON CONFLICT DO NOTHING`,
            [account.customer_id, account.id, messageId],
        );
        await client.query(
            `INSERT INTO events (
                customer_id, case_id, actor, channel, kind, result, decision
             ) VALUES ($1, $2, 'system', 'email', 'email_received', $3, 'allow')`,
            [account.customer_id, thread.case_id, JSON.stringify({
                email_account_id: account.id,
                email_message_id: messageId,
                match_status: thread.match_status,
                has_attachments: Boolean(message.hasAttachments),
            })],
        );
        await client.query('COMMIT');
        return { inserted: true, messageId };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function createDraft(job) {
    let shopifyContext = null;
    let shopifyError = null;
    const { rows: sourceRows } = await db.query(
        `SELECT m.from_address, m.subject, m.body_text, c.name AS organization_name
           FROM email_messages m
           JOIN customers c ON c.id = m.customer_id
          WHERE m.id = $1 AND m.customer_id = $2`,
        [job.email_message_id, job.customer_id],
    );
    if (sourceRows[0]) {
        try {
            shopifyContext = await loadShopifyContext(job.customer_id, sourceRows[0]);
        } catch (error) {
            shopifyError = String(error.message || error).slice(0, 300);
            console.error('[shopify-context] lookup failed', shopifyError);
        }
    }
    let generatedDraft = null;
    if (String(sourceRows[0]?.organization_name || '').trim().toLowerCase() === 'dropsize') {
        try {
            generatedDraft = await generateEmailDraft(sourceRows[0], shopifyContext);
        } catch (error) {
            console.error('[openai-email] generation failed; using safe fallback', String(error.message || error).slice(0, 400));
        }
    }
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT m.*, t.case_id, t.match_status, a.email_address, a.display_name
               FROM email_messages m
               JOIN email_threads t ON t.id = m.thread_id AND t.customer_id = m.customer_id
               JOIN email_accounts a ON a.id = m.email_account_id AND a.customer_id = m.customer_id
              WHERE m.id = $1 AND m.customer_id = $2
              FOR UPDATE OF m`,
            [job.email_message_id, job.customer_id],
        );
        const message = rows[0];
        if (!message) throw new Error('email_message_not_found');
        const matched = message.match_status === 'matched' && message.case_id;
        const shopifyBody = contextualDraft(shopifyContext);
        const fallbackBody = shopifyBody || (matched
            ? 'Vielen Dank für Ihre Nachricht. Wir haben Ihr Anliegen erhalten und prüfen es. Sie erhalten schnellstmöglich eine Rückmeldung.'
            : 'Vielen Dank für Ihre Nachricht. Damit wir Ihr Anliegen sicher zuordnen können, teilen Sie uns bitte Ihr Aktenzeichen oder Ihre Rechnungsnummer mit.');
        const body = generatedDraft?.body || fallbackBody;
        const llmGenerated = Boolean(generatedDraft);
        const category = llmGenerated ? 'llm_shopify_draft' : shopifyBody ? 'shopify_context_ready' :
            matched ? 'manual_review' : 'identity_required';
        await client.query(
            `INSERT INTO email_drafts (
                customer_id, email_account_id, thread_id, source_message_id,
                subject, body_text, category, shopify_context
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (source_message_id) DO NOTHING`,
            [job.customer_id, job.email_account_id, message.thread_id, message.id,
                boundedHeader(message.subject || 'Ihre Nachricht', 500), body, category,
                shopifyContext ? JSON.stringify(shopifyContext) : null],
        );
        if (shopifyError) {
            await client.query(
                `UPDATE shopify_connections SET last_error = $1, updated_at = NOW()
                  WHERE customer_id = $2`, [shopifyError, job.customer_id],
            );
        } else if (shopifyContext) {
            await client.query(
                `UPDATE shopify_connections SET last_error = NULL, last_verified_at = NOW(), updated_at = NOW()
                  WHERE customer_id = $1`, [job.customer_id],
            );
        }
        if (message.case_id) {
            await client.query(
                `INSERT INTO platform_tasks (
                    customer_id, case_id, kind, title, detail, priority
                 ) SELECT $1, $2, 'email_review', 'E-Mail-Antwort prüfen', $3, 'normal'
                  WHERE NOT EXISTS (
                    SELECT 1 FROM platform_tasks
                     WHERE customer_id = $1 AND case_id = $2 AND kind = 'email_review'
                       AND status IN ('open', 'in_progress')
                  )`,
                [job.customer_id, message.case_id, `Betreff: ${boundedHeader(message.subject, 300)}`],
            );
        }
        await client.query(
            `UPDATE email_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [job.id],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function sendDraft(job) {
    const { rows } = await db.query(
        `SELECT d.*, a.id AS account_id, a.provider, a.email_address, a.display_name, a.config,
                a.credentials_encrypted, a.customer_id,
                m.provider_message_id AS source_provider_message_id,
                m.internet_message_id, m.from_address, m.headers
           FROM email_drafts d
           JOIN email_accounts a ON a.id = d.email_account_id AND a.customer_id = d.customer_id
           JOIN email_messages m ON m.id = d.source_message_id AND m.customer_id = d.customer_id
          WHERE d.source_message_id = $1 AND d.customer_id = $2
            AND d.status IN ('approved', 'sending') AND a.status = 'connected'`,
        [job.email_message_id, job.customer_id],
    );
    const draft = rows[0];
    if (!draft) throw new Error('approved_email_draft_not_found');
    const account = { ...draft, id: draft.account_id };
    const connector = connectorFor(draft.provider);
    let preparedId = draft.provider_message_id;
    let preparedNow = false;
    if (!preparedId) {
        preparedId = await connector.prepareReply(account, draft, draft);
        preparedNow = true;
        await db.query(
            `UPDATE email_drafts
                SET status = 'sending', provider_message_id = $1, updated_at = NOW()
              WHERE id = $2 AND customer_id = $3`,
            [preparedId, draft.id, job.customer_id],
        );
    } else {
        await db.query(
            `UPDATE email_drafts SET status = 'sending', updated_at = NOW()
              WHERE id = $1 AND customer_id = $2`, [draft.id, job.customer_id],
        );
    }
    const sent = await connector.sendPrepared(account, draft, draft, preparedId, preparedNow);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE email_drafts SET status = 'sent', sent_at = NOW(), updated_at = NOW(),
                    provider_message_id = $2, last_error = NULL
              WHERE id = $1 AND customer_id = $3`,
            [draft.id, sent.providerMessageId, job.customer_id],
        );
        await client.query(
            `INSERT INTO email_messages (
                customer_id, email_account_id, thread_id, provider_message_id,
                internet_message_id, direction, from_address, to_addresses,
                subject, body_text, sent_at
             ) VALUES ($1, $2, $3, $4, $4, 'outbound', $5, $6, $7, $8, NOW())
             ON CONFLICT (email_account_id, provider_message_id) DO NOTHING`,
            [job.customer_id, draft.email_account_id, draft.thread_id, sent.providerMessageId,
                draft.email_address, JSON.stringify([draft.from_address]), draft.subject, draft.body_text],
        );
        await client.query(
            `UPDATE email_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [job.id],
        );
        await client.query(
            `INSERT INTO events (customer_id, case_id, actor, channel, kind, result, decision)
             SELECT $1, t.case_id, 'system', 'email', 'email_sent', $2, 'allow'
               FROM email_threads t WHERE t.id = $3 AND t.customer_id = $1`,
            [job.customer_id, JSON.stringify({ draft_id: draft.id, provider_message_id: sent.providerMessageId }), draft.thread_id],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    connectorFor, isAutomatedMessage, matchCase, ingestMessage, createDraft, sendDraft,
};
