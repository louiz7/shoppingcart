'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const morgan = require('morgan');
const path = require('path');

const { authenticate } = require('./auth');
const dashboardRouter = require('./routes/dashboard');
const webhooksRouter = require('./routes/webhooks');
const livekitWebhookRouter = require('./routes/livekit-webhook');
const outboundCallRouter = require('./routes/outbound-call');
const pilotLeadRouter = require('./routes/pilot-lead');
const caseCallsRouter = require('./routes/case-calls');
const agentToolsRouter = require('./routes/agent-tools');
const { startCampaignScheduler } = require('./campaign-scheduler');
const { startEmailWorker } = require('./email-worker');
const recovery = require('./recovery/routes');
const recoveryWebhooks = require('./recovery/webhooks');
const { startRecoveryWorker } = require('./recovery/worker');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
// Bind to loopback by default so the backend is only reachable through nginx
// (which proxies to 127.0.0.1), never directly on the public IP. Override with
// BIND_HOST=0.0.0.0 only if you intentionally expose the port.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

// Behind nginx (see deploy/nginx.conf) — trust the one hop's X-Forwarded-For
// so req.ip reflects the real client, not the proxy. Needed for outbound-call's
// per-IP rate limiting to work correctly.
app.set('trust proxy', 1);

app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    skip: (req) => req.path.startsWith('/integrations/recovery/shopify/') || req.path.startsWith('/webhooks/recovery/shopify/'),
}));

// Static legacy UI. `extensions: ['html']` lets extensionless paths resolve
// to their corresponding HTML files.
app.use('/', express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// Health check (no auth).
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Inbound webhooks from Deepslate (auth via per-customer URL token).
app.use('/webhooks/deepslate', webhooksRouter);

// Inbound webhooks from LiveKit (auth via signed Authorization header).
app.use('/webhooks/livekit', livekitWebhookRouter);
app.use('/webhooks/recovery', recoveryWebhooks.router);
app.use('/integrations/recovery/shopify', recovery.oauthRouter);
app.use('/v1/recovery', authenticate, express.json({ limit: '16kb' }), recovery.merchantRouter());
app.use('/internal/recovery/admin', express.json({ limit: '16kb' }), recovery.adminRouter);
app.use('/internal/recovery/tools', express.json({ limit: '16kb' }), recovery.toolsRouter);

// Customer-facing usage API (auth via API key).
app.use('/dashboard', authenticate, express.json({ limit: '1mb' }), dashboardRouter);

// Places a real outbound phone call as the Evi agent via our own LiveKit SIP
// trunk. Public-facing (backs the rescova-website "call me" widget), no API
// key — CORS allow-listed and rate limited instead (see routes/outbound-call.js).
app.use('/v1/outbound-call', express.json({ limit: '4kb' }), outboundCallRouter);

// Public pilot-lead endpoint — forwards the marketing-site "Pilot besprechen"
// form submissions to a Telegram channel. No API key: CORS allow-listed and
// rate limited (see routes/pilot-lead.js).
app.use('/v1/pilot-lead', express.json({ limit: '4kb' }), pilotLeadRouter);

// The former public organisation-configuration endpoint is retired.
app.all('/v1/dashboard-config', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Case-driven outbound calls (the deterministic negotiation agent). Auth via
// API key; the policy engine gates every dial.
app.use('/v1/cases', authenticate, express.json({ limit: '64kb' }), caseCallsRouter);

// Tool Gateway for the Python agent worker. Internal-only: loopback socket +
// shared secret enforced inside the router; never exposed via nginx.
app.use('/internal/tools', express.json({ limit: '64kb' }), agentToolsRouter);

// Fallback 404.
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.originalUrl }));

const server = http.createServer(app);

server.listen(PORT, BIND_HOST, () => {
    console.log(`[rescova] listening on ${BIND_HOST}:${PORT}`);
});

startCampaignScheduler();
startEmailWorker();
startRecoveryWorker();
