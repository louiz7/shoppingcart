'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/recovery/server');

test('dedicated Ecom server keeps legacy and internal unauthenticated routes closed', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        const health = await fetch(`${origin}/healthz`);
        assert.equal(health.status, 200);
        assert.equal(health.headers.get('x-powered-by'), null);
        for (const path of ['/v1/outbound-call', '/v1/pilot-lead', '/dashboard', '/internal/tools', '/index.html']) {
            assert.equal((await fetch(origin + path)).status, 404, path);
        }
        assert.equal((await fetch(`${origin}/internal/recovery/organizations/overview`)).status, 401);
        const invalid = await fetch(`${origin}/webhooks/livekit`, { method: 'POST',
            headers: { 'Content-Type': 'application/webhook+json' }, body: '{}' });
        assert.ok([401, 503].includes(invalid.status));
    } finally { await new Promise((resolve) => server.close(resolve)); }
});
