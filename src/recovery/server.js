'use strict';

// Dedicated Ecom entrypoint: legacy Rescova APIs and workers are not mounted.
require('dotenv').config();
const http = require('node:http');
const express = require('express');
const { WebhookReceiver } = require('livekit-server-sdk');
const routes = require('./routes');
const webhooks = require('./webhooks');

function createApp() {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback');
    app.use((_req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' });
        next();
    });
    app.get('/healthz', (_req, res) => res.json({ ok: true }));
    app.use('/webhooks/recovery', webhooks.router);
    const receiver = process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET
        ? new WebhookReceiver(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET) : null;
    app.post('/webhooks/livekit', express.raw({ type: 'application/webhook+json', limit: '1mb', inflate: false }), async (req, res) => {
        if (!receiver) return res.sendStatus(503);
        let event;
        try {
            if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
            event = await receiver.receive(req.body.toString('utf8'), req.get('authorization'));
        } catch { return res.sendStatus(401); }
        if (!/^recovery-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.room?.name || '')) return res.sendStatus(200);
        try { await webhooks.lifecycle(event); return res.sendStatus(200); }
        catch { return res.sendStatus(500); }
    });
    app.use('/integrations/recovery/shopify', routes.oauthRouter);
    app.use('/internal/recovery/links', express.json({ limit: '1kb' }), require('./sms-links').router());
    app.use('/internal/recovery/demo', express.json({ limit: '16kb' }), require('./public-demo').router());
    app.use('/internal/recovery/admin', express.json({ limit: '16kb' }), routes.adminRouter);
    app.use('/internal/recovery/tools', express.json({ limit: '16kb' }), routes.toolsRouter);
    app.use('/internal/recovery/organizations', express.json({ limit: '4kb' }), require('./organizations').router);
    app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
    app.use((error, _req, res, _next) => res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_request' }));
    return app;
}

if (require.main === module) {
    const server = http.createServer(createApp());
    server.requestTimeout = 65000;
    server.listen(Number(process.env.PORT || 3610), '127.0.0.1', () => console.log('[ecom] API ready on loopback'));
    require('./worker').startRecoveryWorker();
    require('./call-alerts').startCallAlertWorker();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        server.close(async () => { await require('../db').pool.end(); process.exit(0); });
        setTimeout(() => process.exit(1), 10000).unref();
    });
}

module.exports = { createApp };
