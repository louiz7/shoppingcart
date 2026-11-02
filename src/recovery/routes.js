'use strict';

const express = require('express');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { db, event } = require('./store');
const service = require('./service');
const shopify = require('./shopify');
const policy = require('./policy');
const telephony = require('./telephony');

function internal(req, res, next) {
    const secret = process.env.INTERNAL_TOOL_SECRET;
    const supplied = req.get('x-internal-secret') || '';
    const expectedBytes = Buffer.from(secret || ''), suppliedBytes = Buffer.from(supplied);
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local || !secret || suppliedBytes.length !== expectedBytes.length ||
        !timingSafeEqual(suppliedBytes, expectedBytes)) return res.status(401).json({ error: 'unauthorized' });
    return next();
}

const handle = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await fn(req, res); }
    catch (error) {
        if (req.baseUrl === '/integrations/recovery/shopify' && req.path === '/callback') {
            console.warn('[recovery-oauth]', /^[a-z][a-z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'recovery_unavailable');
        }
        res.status(error.status || 500).json({ error: error.code || 'recovery_unavailable' });
    }
};

async function startOAuth(customerId, value) {
    const domain = shopify.domain(value);
    const redirectUri = process.env.RECOVERY_SHOPIFY_REDIRECT_URI || process.env.SHOPIFY_REDIRECT_URI;
    if (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET || !redirectUri) {
        throw policy.problem('shopify_app_not_configured', 503);
    }
    const token = randomBytes(32).toString('hex');
    await db.query(`INSERT INTO recovery_oauth_states(state_hash,customer_id,shop_domain,expires_at)
        VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes')`, [service.hash(token), customerId, domain]);
    const url = new URL(`https://${domain}/admin/oauth/authorize`);
    url.search = new URLSearchParams({ client_id: process.env.SHOPIFY_CLIENT_ID, scope: shopify.SCOPES.join(','),
        redirect_uri: redirectUri, state: token }).toString();
    return { url: url.href };
}

const oauthRouter = express.Router();
oauthRouter.get('/callback', handle(async (req, res) => {
    const params = new URL(req.originalUrl, 'http://localhost').searchParams;
    if (!shopify.oauthHmac(params)) throw policy.problem('invalid_oauth_signature', 401);
    const shopDomain = shopify.domain(params.get('shop'));
    const timestamp = Number(params.get('timestamp')) * 1000;
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 600000 || !params.get('code') || !params.get('state')) throw policy.problem('expired_oauth');
    const { rows } = await db.query(`DELETE FROM recovery_oauth_states WHERE state_hash=$1 AND shop_domain=$2
        AND expires_at>NOW() RETURNING customer_id`, [service.hash(params.get('state')), shopDomain]);
    if (!rows[0]) throw policy.problem('invalid_oauth_state', 401);
    const savedShop = await shopify.withTokenLock(shopDomain,async (client) => {
        const prior = await client.query('SELECT customer_id,currency FROM recovery_shops WHERE domain=$1 FOR UPDATE', [shopDomain]);
        if (prior.rows[0] && prior.rows[0].customer_id !== rows[0].customer_id) throw policy.problem('shop_already_connected', 409);
        const token=await shopify.exchangeAuthorizationCode(shopDomain,params.get('code'));
        const scopes=String(token.scope || '').split(',').map((scope)=>scope.trim());
        if (shopify.SCOPES.some((scope)=>!scopes.includes(scope))) throw policy.problem('shopify_scopes_missing',409);
        const shop={domain:shopDomain,mode:'live',credentials_encrypted:shopify.encryptToken(token)};
        const info=await shopify.graphql(shop,'query RecoveryShop { shop { name primaryDomain { host } currencyCode } }');
        if (!['EUR','USD'].includes(info.shop.currencyCode)) throw policy.problem('unsupported_shop_currency',409);
        if (prior.rows[0] && prior.rows[0].currency !== info.shop.currencyCode) throw policy.problem('shop_currency_changed', 409);
        const saved = await client.query(`INSERT INTO recovery_shops(id,customer_id,domain,storefront_domain,brand,mode,credentials_encrypted,scopes,currency)
            VALUES($1,$2,$3,$4,$5,'live',$6,$7,$8) ON CONFLICT(domain) DO UPDATE SET
            credentials_encrypted=EXCLUDED.credentials_encrypted,scopes=EXCLUDED.scopes,enabled=FALSE,approved_at=NULL,webhooks_ready=FALSE RETURNING *`,
        [randomUUID(), rows[0].customer_id, shopDomain, info.shop.primaryDomain.host, info.shop.name, shop.credentials_encrypted, scopes, info.shop.currencyCode]);
        return saved.rows[0];
    });
    try {
        await shopify.registerWebhooks(savedShop);
        await db.query('UPDATE recovery_shops SET webhooks_ready=TRUE,last_error=NULL WHERE id=$1', [savedShop.id]);
    } catch (error) {
        await db.query('UPDATE recovery_shops SET last_error=$2 WHERE id=$1', [savedShop.id, error.code || 'webhook_registration_failed']);
    }
    return res.redirect(303, new URL('/recovery', process.env.RECOVERY_DASHBOARD_URL || 'http://localhost:5173').href);
}));

function merchantRouter() {
    const router = express.Router();
    router.get('/', handle(async (req, res) => res.json(await service.dashboard(req.customer.id))));
    router.get('/summary', handle(async (req, res) => res.json(await service.dailySummary(req.customer.id))));
    router.get('/settings', handle(async (req, res) => res.json(await require('./discounts').settings(req.customer.id))));
    router.post('/:shopId/discounts', handle(async (req, res) => res.json(await require('./discounts').create(req.customer.id,req.params.shopId,req.body))));
    router.post('/oauth', handle(async (req, res) => res.json(await startOAuth(req.customer.id, req.body.domain))));
    router.post('/demo', handle(async (req, res) => res.json(await require('./browser-demo').browserDemo(req.customer.id, req.body.sdp))));
    router.post('/:shopId/settings', handle(async (req, res) => res.json(await service.saveSettings(req.customer.id, req.params.shopId, req.body))));
    router.post('/:shopId/sync', handle(async (req, res) => res.json(await service.syncShop(req.customer.id, req.params.shopId))));
    router.post('/:shopId/webhooks', handle(async (req, res) => {
        const shop = await service.shopFor(req.customer.id, req.params.shopId);
        await shopify.registerWebhooks(shop);
        await db.query('UPDATE recovery_shops SET webhooks_ready=TRUE,last_error=NULL WHERE id=$1', [shop.id]);
        res.json({ registered: true });
    }));
    router.post('/:shopId/checkouts/:checkoutId/consent', handle(async (req, res) => res.json(await service.consent(req.customer.id, req.params.shopId, req.params.checkoutId, req.body))));
    router.post('/:shopId/checkouts/:checkoutId/stop', handle(async (req, res) => res.json(await service.stopContact(req.customer.id, req.params.shopId, req.params.checkoutId))));
    router.post('/:shopId/checkouts/:checkoutId/call', handle(async (req, res) => res.json(await service.startCall(req.customer.id, req.params.shopId, req.params.checkoutId))));
    return router;
}

const adminRouter = express.Router();
adminRouter.use(internal, (req, res, next) => {
    const id = Number(req.get('x-customer-id'));
    if (!Number.isSafeInteger(id) || id < 1) return res.status(401).json({ error: 'unauthorized' });
    req.customer = { id };
    return next();
}, merchantRouter());

const toolsRouter = express.Router();
toolsRouter.use((req, res, next) => req.method === 'POST' ? next() : res.sendStatus(405));
toolsRouter.use(internal, handle(async (req, res) => {
    const name = req.path.slice(1);
    // Expiry/deactivation must block new actions while still allowing this room to be closed.
    const call = await service.callContext(req.get('x-call-token'), name === 'end');
    const started = performance.now();
    let result;
    switch (name) {
    case 'context': result = await service.getContext(call); break;
    case 'connected': result = await service.recordConnection(call); break;
    case 'confirm_identity': result = await service.confirmIdentity(call); break;
    case 'offer': result = await service.getOffer(call, req.body.percent, req.body.discountId); break;
    case 'send_link': result = await service.sendLink(call); break;
    case 'transcript': result = await service.recordTranscript(call, req.body); break;
    case 'stop': result = await service.stopContact(call.customer_id, call.shop_id, call.checkout_id, 'agent_stop'); break;
    case 'outcome': result = await service.outcome(call, req.body); break;
    case 'order_status': {
        if (!call.identity_verified) throw policy.problem('identity_required', 409);
        const shop = await service.shopFor(call.customer_id, call.shop_id);
        const ctx = await service.state(db, shop, call.checkout_id);
        if (ctx.contact.stopped_at || !shop.enabled) throw policy.problem('contact_stopped', 409);
        result = await shopify.orderStatus(shop, ctx.checkout.snapshot.customerId);
        break;
    }
    case 'end': result = await service.endCall(call); break;
    case 'latency':
        if (!['response_latency', 'playout_latency'].includes(req.body.kind) || !Number.isInteger(req.body.ms) || req.body.ms < 0 || req.body.ms > 120000) throw policy.problem('invalid_latency');
        await event(db, call.shop_id, req.body.kind, { source: 'livekit_playout' }, call.id, req.body.ms);
        result = { recorded: true };
        break;
    default: throw policy.problem('unknown_tool', 404);
    }
    if (!['transcript', 'latency'].includes(name)) await event(db, call.shop_id, 'tool_latency', { tool: name }, call.id, Math.round(performance.now() - started));
    return res.json(result);
}));

module.exports = { internal, handle, merchantRouter, adminRouter, toolsRouter, oauthRouter, startOAuth };
