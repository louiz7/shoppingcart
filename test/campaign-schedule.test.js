'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isWithinWindow, nextEligibleAt, nextCampaignAttemptAt } = require('../src/services/campaign-schedule-service');

const config = {
    timezone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
    start_time: '08:00',
    end_time: '20:00',
    max_attempts_per_24h: 2,
    max_attempts_per_7d: 4,
};

test('campaign window is the only scheduling window', () => {
    assert.equal(isWithinWindow(new Date('2026-08-05T06:30:00Z'), config), true);
    assert.equal(isWithinWindow(new Date('2026-08-05T18:00:00Z'), config), false);
});

test('an eligible due job can run immediately', () => {
    const now = new Date('2026-08-05T10:00:37Z');
    const result = nextEligibleAt({ now, config });
    assert.equal(result.next.toISOString(), now.toISOString());
    assert.equal(result.reason, null);
});

test('retry after closing time moves to next campaign opening', () => {
    const result = nextEligibleAt({
        now: new Date('2026-08-05T19:00:00Z'),
        notBefore: new Date('2026-08-05T20:00:00Z'),
        config,
    });
    assert.equal(result.next.toISOString(), '2026-08-06T06:00:00.000Z');
});

test('24 hour cap uses debtor-wide attempt timestamps', () => {
    const now = new Date('2026-08-05T10:00:00Z');
    const result = nextEligibleAt({
        now,
        config,
        attemptTimes: ['2026-08-05T09:00:00Z', '2026-08-05T08:00:00Z'],
    });
    assert.equal(result.reason, 'attempt_limit_24h');
    assert.equal(result.next.toISOString(), '2026-08-06T08:00:00.000Z');
});

test('demo campaign ignores windows and historical attempt caps', () => {
    const now = new Date('2026-08-09T01:00:00Z'); // Sunday, outside configured window
    const result = nextCampaignAttemptAt({
        isDemo: true,
        now,
        config,
        attemptTimes: Array.from({ length: 20 }, () => now),
    });
    assert.equal(result.next.toISOString(), now.toISOString());
    assert.equal(result.reason, null);
});

test('demo retry keeps its configured pause but ignores the next call window', () => {
    const now = new Date('2026-08-09T01:00:00Z');
    const notBefore = new Date('2026-08-09T02:00:00Z');
    const result = nextCampaignAttemptAt({ isDemo: true, now, notBefore, config });
    assert.equal(result.next.toISOString(), notBefore.toISOString());
});
