'use strict';

/**
 * POST /v1/outbound-call
 *
 * Places a real outbound phone call as Evi, dialed via our own LiveKit SIP
 * trunk (not Deepslate's platform Agent-Task API).
 *
 * Public-facing: this backs the "enter your number, get called" widget on
 * the marketing site (rescova-website), so it's reachable cross-origin
 * (CORS, allow-listed via ALLOWED_ORIGINS) without an API key, and is rate
 * limited per IP and per target number to bound abuse/cost.
 *
 * Runs the SAME tool-driven negotiation agent (EVI_AGENT, see
 * src/routes/case-calls.js) as real customer cases, not a standalone scripted
 * persona — so the public demo genuinely exercises get_case_context, the
 * plan catalog, and the discount ladder instead of a hand-authored scene.
 * Each call auto-provisions an ephemeral demo case (fixed fictional invoice)
 * under DEMO_CUSTOMER_ID, pre-verified — there's no real identity to check
 * for an anonymous website visitor, so identity verification is skipped by
 * creating case_state directly as VERIFIED; the tool gateway's disclosure
 * gating still applies, it's just already open for this demo case.
 */

const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { EVI_AGENT } = require('../personas');
const { placeCaseCall, assertConfigured } = require('../services/case-call-service');
const { findOrCreateDebtor } = require('../services/debtor-service');

const router = express.Router();
const CALLING_TEMPORARILY_DISABLED = true;

const DEMO_CUSTOMER_ID = parseInt(process.env.DEMO_CUSTOMER_ID || '1', 10);
const DEMO_AMOUNT_CENTS = parseInt(process.env.OUTBOUND_CALL_DEMO_AMOUNT_CENTS || '41019', 10);

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rescova.de,https://www.rescova.de')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

const E164 = /^\+[1-9]\d{6,14}$/;

// --- CORS ---------------------------------------------------------------
// Scoped to this router only (not the whole app) — the rest of the API
// requires a Bearer API key and has no need to be reachable from a browser.
function cors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
}
router.use(cors);

// --- Rate limiting --------------------------------------------------------
// In-memory (single-process deployment) — bounds both cost (every request
// triggers a real, billed SIP call) and harassment risk (repeatedly calling
// the same number). Resets on process restart, which is acceptable here.
const IP_WINDOW_MS = parseInt(process.env.OUTBOUND_CALL_IP_WINDOW_MS || String(60 * 60 * 1000), 10); // 1h
const IP_MAX = parseInt(process.env.OUTBOUND_CALL_IP_MAX || '5', 10);
const NUMBER_COOLDOWN_MS = parseInt(process.env.OUTBOUND_CALL_NUMBER_COOLDOWN_MS || String(10 * 60 * 1000), 10); // 10min
const RATE_LIMIT_EXEMPT_NUMBERS = new Set(
    (process.env.OUTBOUND_CALL_RATE_LIMIT_EXEMPT_NUMBERS || '')
        .split(',')
        .map((number) => number.trim().replace(/[\s()-]/g, ''))
        .filter((number) => E164.test(number)),
);

const ipHits = new Map(); // ip -> timestamps[]
const numberLastCall = new Map(); // targetNumber -> timestamp

router.post('/', async (req, res) => {
    if (CALLING_TEMPORARILY_DISABLED) {
        return res.status(503).json({
            error: 'calling_temporarily_unavailable',
            message: 'Die Telefon-Demo ist vorübergehend pausiert.',
        });
    }

    try {
        assertConfigured();
    } catch {
        return res.status(503).json({ error: 'sip_trunk_not_configured' });
    }

    const rawTargetNumber = req.body && req.body.targetNumber;
    const targetNumber = typeof rawTargetNumber === 'string' ? rawTargetNumber.trim().replace(/[\s()-]/g, '') : rawTargetNumber;
    if (typeof targetNumber !== 'string' || !E164.test(targetNumber)) {
        return res.status(400).json({ error: 'invalid_target_number', message: 'Expected E.164 format, e.g. +4917612345678' });
    }

    const now = Date.now();
    const ip = req.ip;
    const isRateLimitExempt = RATE_LIMIT_EXEMPT_NUMBERS.has(targetNumber);

    if (!isRateLimitExempt) {
        const recentHits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
        if (recentHits.length >= IP_MAX) {
            return res.status(429).json({ error: 'rate_limited', message: 'Too many call requests from this network. Please try again later.' });
        }

        const lastCallToNumber = numberLastCall.get(targetNumber);
        if (lastCallToNumber && now - lastCallToNumber < NUMBER_COOLDOWN_MS) {
            return res.status(429).json({ error: 'rate_limited', message: 'This number was just called. Please wait a few minutes and try again.' });
        }

        recentHits.push(now);
        ipHits.set(ip, recentHits);
        numberLastCall.set(targetNumber, now);
    }

    try {
        // One demo debtor per phone number (idempotent); a fresh case per
        // call so the negotiation always starts clean (no stale plan/state
        // from a previous demo run against the same number).
        const debtorRef = `outbound-demo-${targetNumber}`;
        const debtor = await findOrCreateDebtor(db, {
            customerId: DEMO_CUSTOMER_ID,
            externalRef: debtorRef,
            name: 'James Bond',
            phoneE164: targetNumber,
        });
        const debtorId = debtor.id;

        const caseRef = `outbound-demo-${targetNumber}-${crypto.randomBytes(4).toString('hex')}`;
        const { rows: caseRows } = await db.query(
            `INSERT INTO cases (customer_id, debtor_id, external_ref, original_amount_cents, amount_cents_outstanding, invoice_number, due_date)
             VALUES ($1, $2, $3, $4, $4, $5, NOW() - INTERVAL '10 days')
             RETURNING id`,
            [DEMO_CUSTOMER_ID, debtorId, caseRef, DEMO_AMOUNT_CENTS, `DEMO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`],
        );
        const caseId = caseRows[0].id;

        // Skip identity verification for the public widget: there is no real
        // identity to check for an anonymous caller. Pre-verified still goes
        // through the same disclosure-gated tool, it's just already open.
        await db.query(`INSERT INTO case_state (case_id, state) VALUES ($1, 'VERIFIED')`, [caseId]);

        const call = await placeCaseCall({
            customerId: DEMO_CUSTOMER_ID,
            caseId,
            phoneE164: targetNumber,
            source: 'website_widget',
        });

        res.json({
            room: call.room,
            targetNumber,
            agent: EVI_AGENT.name,
            sipCallId: call.sipCallId,
            participantId: call.participantId,
        });
    } catch (err) {
        console.error('[outbound-call] failed', err);
        res.status(500).json({ error: 'outbound_call_failed', message: err.message });
    }
});

module.exports = router;
