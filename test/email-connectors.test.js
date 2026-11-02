'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { encryptCredentials, decryptCredentials } = require('../src/services/email-crypto');
const { normalizeAddress, plainText, assertPublicMailHost, boundedHeader } = require('../src/services/email-utils');
const graph = require('../src/services/email-connectors/microsoft-graph');

const TEST_KEY = '0'.repeat(64);

function response(status, payload = null) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload || {}),
    };
}

function graphAccount() {
    process.env.EMAIL_CREDENTIALS_KEY = TEST_KEY;
    return {
        id: 17,
        customer_id: 4,
        created_at: new Date('2026-08-08T08:00:00.000Z'),
        last_synced_at: new Date('2026-08-08T09:00:00.000Z'),
        config: { tenant_id: 'organizations' },
        credentials_encrypted: encryptCredentials({
            access_token: 'valid-token', expires_at: Date.now() + 3_600_000,
        }),
    };
}

test('email credentials round-trip and reject tampering', () => {
    const previous = process.env.EMAIL_CREDENTIALS_KEY;
    process.env.EMAIL_CREDENTIALS_KEY = TEST_KEY;
    try {
        const encrypted = encryptCredentials({ username: 'mail@example.com', password: 'secret' });
        assert.notEqual(encrypted.includes('secret'), true);
        assert.deepEqual(decryptCredentials(encrypted), {
            username: 'mail@example.com', password: 'secret',
        });
        const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
        assert.throws(() => decryptCredentials(tampered));
    } finally {
        if (previous === undefined) delete process.env.EMAIL_CREDENTIALS_KEY;
        else process.env.EMAIL_CREDENTIALS_KEY = previous;
    }
});

test('email input utilities normalize and constrain untrusted values', async () => {
    assert.equal(normalizeAddress('Person <MAIL@Example.COM>'), 'mail@example.com');
    assert.equal(normalizeAddress('not-an-address'), '');
    assert.equal(plainText('<p>Hello &amp; welcome</p><script>bad()</script>'), 'Hello & welcome');
    assert.equal(boundedHeader('safe\r\nBcc: attacker@example.com'), 'safe Bcc: attacker@example.com');
    await assert.rejects(assertPublicMailHost('localhost'), /invalid_mail_host/);
    await assert.rejects(assertPublicMailHost('127.0.0.1'), /private_mail_host_denied/);
});

test('Microsoft Graph sync follows pagination and overlaps its cursor', async () => {
    const previousFetch = global.fetch;
    const requested = [];
    const pages = [
        response(200, {
            value: [{
                id: 'm1', conversationId: 'c1', internetMessageId: '<m1@example.com>',
                subject: 'Hallo', body: { contentType: 'text', content: 'Text' },
                from: { emailAddress: { address: 'sender@example.com' } }, toRecipients: [],
                receivedDateTime: '2026-08-08T09:01:00.000Z', internetMessageHeaders: [],
            }],
            '@odata.nextLink': 'https://graph.microsoft.com/next-page',
        }),
        response(200, {
            value: [{
                id: 'm2', conversationId: 'c2', subject: 'Zweite',
                bodyPreview: 'Vorschau', from: { emailAddress: { address: 'two@example.com' } },
                toRecipients: [], receivedDateTime: '2026-08-08T09:02:00.000Z',
            }],
        }),
    ];
    global.fetch = async (url) => {
        requested.push(String(url));
        return pages.shift();
    };
    try {
        const messages = await graph.sync(graphAccount());
        assert.equal(messages.length, 2);
        assert.equal(messages[0].from, 'sender@example.com');
        assert.match(requested[0], /receivedDateTime\+gt\+2026-08-08T08%3A58%3A00\.000Z/);
        assert.equal(requested[1], 'https://graph.microsoft.com/next-page');
    } finally {
        global.fetch = previousFetch;
    }
});

test('Microsoft Graph prepares a reply once and sends the stored draft', async () => {
    const previousFetch = global.fetch;
    const calls = [];
    const responses = [response(200, { id: 'graph-draft-1' }), response(204), response(202)];
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method || 'GET', body: options.body });
        return responses.shift();
    };
    try {
        const account = graphAccount();
        const prepared = await graph.prepareReply(
            account, { source_provider_message_id: 'source-1' }, { body_text: 'Antwort' },
        );
        assert.equal(prepared, 'graph-draft-1');
        const sent = await graph.sendPrepared(account, {}, {}, prepared);
        assert.equal(sent.providerMessageId, 'graph-sent:graph-draft-1');
        assert.deepEqual(calls.map((call) => call.method), ['POST', 'PATCH', 'POST']);
        assert.match(calls[0].url, /source-1\/createReply$/);
        assert.match(calls[1].body, /Antwort/);
    } finally {
        global.fetch = previousFetch;
    }
});

test('Microsoft Graph only treats a missing draft as an already-completed retry', async () => {
    const previousFetch = global.fetch;
    global.fetch = async () => response(404, { error: 'not found' });
    try {
        const account = graphAccount();
        await assert.rejects(
            graph.sendPrepared(account, {}, {}, 'new-draft', true),
            /microsoft_graph_404/,
        );
        const retried = await graph.sendPrepared(account, {}, {}, 'previously-sent-draft', false);
        assert.equal(retried.providerMessageId, 'graph-sent:previously-sent-draft');
    } finally {
        global.fetch = previousFetch;
    }
});
