'use strict';

/**
 * POST /v1/pilot-lead
 *
 * Backs the "Pilot besprechen" form in the marketing-site modal
 * (website/src/components/PilotModal.astro). When a visitor submits their
 * name, company and phone number, we forward the lead to a Telegram channel
 * via the Bot API so the team gets an instant notification.
 *
 * Public-facing (no API key): reachable cross-origin (CORS, allow-listed via
 * ALLOWED_ORIGINS, same list as /v1/outbound-call) and rate limited per IP to
 * bound spam. The Telegram bot token and target chat live only in the server
 * environment — they never reach the browser.
 */

const express = require('express');
const axios = require('axios');

const router = express.Router();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://rescova.de,https://www.rescova.de')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

// --- CORS ---------------------------------------------------------------
// Scoped to this router only, mirroring /v1/outbound-call — the rest of the
// API requires a Bearer API key and has no need to be browser-reachable.
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
// In-memory (single-process deployment) — bounds form-spam. Resets on process
// restart, which is acceptable here.
const IP_WINDOW_MS = parseInt(process.env.PILOT_LEAD_IP_WINDOW_MS || String(60 * 60 * 1000), 10); // 1h
const IP_MAX = parseInt(process.env.PILOT_LEAD_IP_MAX || '10', 10);

const ipHits = new Map(); // ip -> timestamps[]

// Trim a submitted field to a bounded string; anything non-string becomes ''.
function field(value, max = 200) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// Escape for Telegram HTML parse_mode (only these three are special).
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

router.post('/', async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.status(503).json({ error: 'telegram_not_configured' });
    }

    const firstName = field(req.body && req.body.firstName);
    const lastName = field(req.body && req.body.lastName);
    const company = field(req.body && req.body.company);
    const phone = field(req.body && req.body.phone);

    if (!firstName || !lastName || !company || !phone) {
        return res.status(400).json({
            error: 'missing_fields',
            message: 'firstName, lastName, company and phone are all required.',
        });
    }

    const now = Date.now();
    const ip = req.ip;
    const recentHits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
    if (recentHits.length >= IP_MAX) {
        return res.status(429).json({
            error: 'rate_limited',
            message: 'Too many submissions from this network. Please try again later.',
        });
    }
    recentHits.push(now);
    ipHits.set(ip, recentHits);

    const text = [
        '🚀 <b>Neue Pilot-Anfrage</b>',
        '',
        `<b>Name:</b> ${escapeHtml(`${firstName} ${lastName}`)}`,
        `<b>Unternehmen:</b> ${escapeHtml(company)}`,
        `<b>Telefon:</b> ${escapeHtml(phone)}`,
    ].join('\n');

    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true },
            { timeout: 10000 },
        );
        res.json({ ok: true });
    } catch (err) {
        // Log Telegram's own error payload when present — it's far more useful
        // than the bare axios message for diagnosing token/chat_id problems.
        const detail = err.response && err.response.data ? err.response.data : err.message;
        console.error('[pilot-lead] telegram send failed', detail);
        res.status(502).json({ error: 'telegram_send_failed' });
    }
});

module.exports = router;
