'use strict';

const express = require('express');
const shopify = require('../src/recovery/shopify');

const CALLBACK = '/admin/integrations/shopify/callback';

function createOAuthRelay({ secret, shopDomain, webhooksEnabled = false }) {
    shopify.domain(shopDomain);
    if (!secret) throw new Error('Shopify relay credentials are missing');
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
        if (req.originalUrl.length > 8192) return res.sendStatus(414);
        next();
    });
    if (webhooksEnabled) {
        const webhookPath = /^\/webhooks\/recovery\/shopify\/(?:privacy|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/[a-f0-9]{64})$/;
        app.post(webhookPath, express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
            if (!Buffer.isBuffer(req.body) || req.get('x-shopify-shop-domain') !== shopDomain ||
                !shopify.signature(req.body, req.get('x-shopify-hmac-sha256'), secret)) return res.sendStatus(401);
            const headers = { 'Content-Type': 'application/json' };
            for (const name of ['x-shopify-hmac-sha256','x-shopify-shop-domain','x-shopify-topic','x-shopify-event-id','x-shopify-webhook-id']) {
                if (req.get(name)) headers[name] = req.get(name);
            }
            try {
                const result = await fetch(new URL(req.path, 'http://127.0.0.1:3110'), {
                    method: 'POST', body: req.body, headers, redirect: 'error', signal: AbortSignal.timeout(4000),
                });
                await result.arrayBuffer();
                return res.status(result.status).end();
            } catch { return res.sendStatus(502); }
        });
        app.use((error, req, res, next) => res.sendStatus(error.status === 413 ? 413 : 400));
    }
    app.use((req, res) => {
        let url;
        try { url = new URL(req.originalUrl, 'http://localhost'); }
        catch { return res.sendStatus(400); }
        if (url.pathname !== CALLBACK) return res.sendStatus(404);
        if (req.method !== 'GET') return res.sendStatus(405);
        const params = url.searchParams;
        const timestamp = Number(params.get('timestamp')) * 1000;
        if (!shopify.oauthHmac(params, secret) || params.get('shop') !== shopDomain || !params.get('code') ||
            !/^[a-f0-9]{64}$/.test(params.get('state') || '') || !Number.isFinite(timestamp) ||
            Math.abs(Date.now() - timestamp) > 600000) return res.sendStatus(401);
        // Keep the existing local session, tenant and one-use state checks as the authority.
        const target = new URL(CALLBACK, 'http://localhost:5173');
        target.search = url.search;
        return res.status(303).set('Location', target.href).end();
    });
    return app;
}

if (require.main === module) {
    require('dotenv').config();
    const webhooksEnabled = process.env.RECOVERY_SHOPIFY_WEBHOOK_RELAY_ENABLED === '1';
    createOAuthRelay({ secret: process.env.SHOPIFY_CLIENT_SECRET, shopDomain: process.env.RECOVERY_TEST_SHOP_DOMAIN, webhooksEnabled })
        .listen(3111, '127.0.0.1', () => console.log(`Recovery relay listening on 127.0.0.1:3111; Shopify webhooks ${webhooksEnabled ? 'enabled' : 'disabled'}; no public tunnel started.`));
}

module.exports = { createOAuthRelay, CALLBACK };
