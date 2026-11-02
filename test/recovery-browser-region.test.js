'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('browser Live creation and delayed hangup stay in the configured project region', async (t) => {
    const storePath = require.resolve('../src/recovery/store');
    const previousStore = require.cache[storePath];
    require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: {
        transaction: async (fn) => fn({ query: async () => ({ rows: [{ id: 'synthetic-shop', requests: 0 }] }) }),
        event: async () => {},
    } };
    const previousEnv = { ...process.env };
    t.after(() => {
        process.env = previousEnv;
        if (previousStore) require.cache[storePath] = previousStore;
        else delete require.cache[storePath];
    });
    process.env.OPENAI_API_KEY = 'synthetic-offline-key';
    process.env.GPT_LIVE_DEMO_ENABLED = '1';
    const { browserDemo } = require('../src/recovery/browser-demo');
    let hangup;
    t.mock.method(global, 'setTimeout', (fn, ms) => {
        assert.equal(ms, 180000);
        hangup = fn;
        return { unref() {} };
    });
    const calls = [];
    t.mock.method(global, 'fetch', async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ session: { id: 'synthetic/session' }, transport: { sdp: 'synthetic-answer' } }) };
    });
    for (const override of [undefined, 'https://us.api.openai.com/v1/']) {
        if (override) process.env.OPENAI_BASE_URL = override;
        else delete process.env.OPENAI_BASE_URL;
        calls.length = 0;
        const base = override ? 'https://us.api.openai.com/v1' : 'https://eu.api.openai.com/v1';
        await browserDemo(1, 'v=0\r\nsynthetic-sdp');
        // Configuration changes during a session must not move its later hangup to another region.
        process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
        hangup();
        assert.deepEqual(calls.map(c => c.url), [`${base}/live/sessions`, `${base}/live/sessions/synthetic%2Fsession/hangup`]);
        assert.ok(calls.every(c => c.options.redirect === 'error'));
        assert.equal(JSON.parse(calls[0].options.body).session.store, false);
    }
});
