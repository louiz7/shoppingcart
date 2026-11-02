'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCaseMemory } = require('../src/services/case-memory-service');

test('buildCaseMemory separates attempts from reached conversations', () => {
    const memory = buildCaseMemory({
        currency: 'EUR',
        attemptStats: {
            previous_attempt_count: 7,
            unreached_attempt_count: 6,
            last_attempt_at: new Date('2026-07-31T12:00:00Z'),
            last_reached_at: new Date('2026-07-31T10:00:00Z'),
        },
        conversationRows: [
            {
                started_at: new Date('2026-07-31T10:00:00Z'),
                ended_at: new Date('2026-07-31T10:03:00Z'),
                disposition: 'no_agreement',
                summary: 'Kunde möchte die Rechnung zunächst prüfen.',
            },
        ],
        taskRows: [
            {
                kind: 'human_escalation',
                title: 'Manuelle Prüfung',
                detail: 'Unterlagen prüfen',
                priority: 'high',
                status: 'open',
                created_at: new Date('2026-07-31T10:03:00Z'),
            },
        ],
        planRow: {
            status: 'pending_approval',
            installments: 3,
            installment_cents: 3334,
            total_cents: 10000,
            discount_pct: '0.00',
            first_due_date: '2026-08-07',
            created_at: new Date('2026-07-31T10:02:00Z'),
        },
    });

    assert.equal(memory.previous_attempt_count, 7);
    assert.equal(memory.unreached_attempt_count, 6);
    assert.equal(memory.last_attempt_at, '2026-07-31T12:00:00.000Z');
    assert.equal(memory.last_reached_at, '2026-07-31T10:00:00.000Z');
    assert.equal(memory.recent_conversations[0].disposition, 'no_agreement');
    assert.equal(memory.open_tasks[0].priority, 'high');
    assert.deepEqual(memory.current_payment_plan, {
        status: 'pending_approval',
        installments: 3,
        installment_amount: '33,34 EUR',
        total_amount: '100,00 EUR',
        discount_pct: 0,
        first_due_date: '2026-08-07',
        created_at: '2026-07-31T10:02:00.000Z',
    });
});

test('buildCaseMemory returns an explicit empty memory', () => {
    assert.deepEqual(buildCaseMemory({}), {
        previous_attempt_count: 0,
        unreached_attempt_count: 0,
        last_attempt_at: null,
        last_reached_at: null,
        recent_conversations: [],
        open_tasks: [],
        current_payment_plan: null,
    });
});

test('unreached attempts never create conversation context', () => {
    const memory = buildCaseMemory({
        attemptStats: {
            previous_attempt_count: 2,
            unreached_attempt_count: 2,
            last_attempt_at: new Date('2026-07-31T12:00:00Z'),
            last_reached_at: null,
        },
        conversationRows: [],
    });

    assert.equal(memory.previous_attempt_count, 2);
    assert.equal(memory.unreached_attempt_count, 2);
    assert.equal(memory.last_reached_at, null);
    assert.deepEqual(memory.recent_conversations, []);
});
