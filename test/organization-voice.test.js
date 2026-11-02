'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadOrganizationAgent } = require('../src/services/organization-voice-service');

test('loads one tenant-scoped organization persona', async () => {
    const calls = [];
    const executor = {
        async query(sql, values) {
            calls.push({ sql, values });
            return {
                rows: [{
                    display_name: 'BFI Inkasso',
                    prompt_instructions: 'Sprich ruhig.',
                }],
            };
        },
    };

    const agent = await loadOrganizationAgent(executor, 4);

    assert.deepEqual(calls[0].values, [4]);
    assert.match(calls[0].sql, /config\.customer_id = \$1/);
    assert.equal(agent.organizationName, 'BFI Inkasso');
    assert.match(agent.systemPrompt, /Sprich ruhig/);
});

test('missing or disabled organization voice configuration blocks calls', async () => {
    const executor = { query: async () => ({ rows: [] }) };

    await assert.rejects(
        loadOrganizationAgent(executor, 99),
        { code: 'organization_voice_not_configured' },
    );
});
