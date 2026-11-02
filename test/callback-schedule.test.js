'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseLocalCallback,
    validateCallbackSchedule,
    callbackExecutionBlockReason,
    resolveRelativeCallback,
} = require('../src/services/callback-schedule-service');

const config = {
    timezone: 'Europe/Berlin',
    weekdays: [1, 2, 3, 4, 5],
    start_time: '08:00',
    end_time: '20:00',
};

test('converts a confirmed Berlin callback to UTC', () => {
    const result = parseLocalCallback('2026-08-10', '15:30', 'Europe/Berlin');
    assert.equal(result.ok, true);
    assert.equal(result.at.toISOString(), '2026-08-10T13:30:00.000Z');
});

test('rejects invalid calendar values and DST gaps', () => {
    assert.equal(parseLocalCallback('2026-02-30', '12:00', 'Europe/Berlin').reason, 'invalid_callback_date');
    assert.equal(parseLocalCallback('2026-03-29', '02:30', 'Europe/Berlin').reason, 'ambiguous_or_nonexistent_callback_time');
    assert.equal(parseLocalCallback('2026-10-25', '02:30', 'Europe/Berlin').reason, 'ambiguous_or_nonexistent_callback_time');
});

test('blocks callbacks that are late or no longer inside an updated campaign window', () => {
    assert.equal(callbackExecutionBlockReason({
        scheduledAt: new Date('2026-08-10T10:00:00Z'),
        config,
        now: new Date('2026-08-10T10:16:00Z'),
    }), 'callback_missed');
    assert.equal(callbackExecutionBlockReason({
        scheduledAt: new Date('2026-08-10T18:00:00Z'),
        config: { ...config, end_time: '18:00' },
        now: new Date('2026-08-10T18:01:00Z'),
    }), 'callback_outside_updated_window');
    assert.equal(callbackExecutionBlockReason({
        scheduledAt: new Date('2026-08-10T10:00:00Z'),
        config,
        now: new Date('2026-08-10T10:10:00Z'),
    }), null);
});

test('rejects callbacks outside the campaign window', () => {
    const result = validateCallbackSchedule({
        localDate: '2026-08-10',
        localTime: '20:00',
        config,
        now: new Date('2026-08-07T10:00:00Z'),
    });
    assert.deepEqual(result, { ok: false, reason: 'outside_campaign_window' });
});

test('rejects callbacks that are too soon or too far away', () => {
    const now = new Date('2026-08-10T10:00:00Z');
    assert.equal(validateCallbackSchedule({
        localDate: '2026-08-10', localTime: '12:03', config, now,
    }).reason, 'callback_too_soon');
    assert.equal(validateCallbackSchedule({
        localDate: '2026-09-15', localTime: '12:00', config, now,
    }).reason, 'callback_too_far');
});

test('uses today for an unambiguous future clock time without another confirmation round', () => {
    const result = validateCallbackSchedule({
        localDate: '',
        localTime: '14:35',
        config,
        now: new Date('2026-08-07T12:28:00Z'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.localDate, '2026-08-07');
    assert.equal(result.at.toISOString(), '2026-08-07T12:35:00.000Z');
});

test('treats minute-precision input as five minutes ahead for the whole current minute', () => {
    const result = validateCallbackSchedule({
        localDate: '',
        localTime: '14:30',
        config,
        now: new Date('2026-08-07T12:25:36Z'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.at.toISOString(), '2026-08-07T12:30:00.000Z');
});

test('resolves relative callbacks from server time and rounds safely up', () => {
    const result = resolveRelativeCallback(
        5,
        'Europe/Berlin',
        new Date('2026-08-08T10:25:36Z'),
    );
    assert.deepEqual(result, {
        ok: true,
        localDate: '2026-08-08',
        localTime: '12:31',
    });
});

test('identifies a stale model-supplied date instead of calling it too soon', () => {
    const result = validateCallbackSchedule({
        localDate: '2025-06-18',
        localTime: '12:40',
        config,
        isDemo: true,
        now: new Date('2026-08-08T10:26:00Z'),
    });
    assert.deepEqual(result, { ok: false, reason: 'callback_date_in_past' });
});

test('asks for a date when a bare clock time is no longer safely today', () => {
    const result = validateCallbackSchedule({
        localDate: '',
        localTime: '14:35',
        config,
        now: new Date('2026-08-07T12:33:00Z'),
    });
    assert.deepEqual(result, { ok: false, reason: 'callback_date_required' });
});

test('demo callbacks still require a real future time but ignore campaign windows', () => {
    const result = validateCallbackSchedule({
        localDate: '2026-08-09',
        localTime: '03:00',
        config,
        isDemo: true,
        now: new Date('2026-08-07T10:00:00Z'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.at.toISOString(), '2026-08-09T01:00:00.000Z');
});
