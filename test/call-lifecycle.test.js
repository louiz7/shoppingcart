'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateVoiceSeconds } = require('../src/services/call-lifecycle-service');

test('connected duration excludes ringing/setup time', () => {
    assert.equal(calculateVoiceSeconds({
        connectedAt: '2026-08-05T12:01:00.000Z',
        endedAt: '2026-08-05T12:02:20.000Z',
        durationSource: 'livekit',
    }), 80);
});

test('unanswered calls have zero connected duration', () => {
    assert.equal(calculateVoiceSeconds({
        connectedAt: null,
        endedAt: '2026-08-05T12:02:20.000Z',
        durationSource: 'livekit',
    }), 0);
});

test('legacy and fallback timestamps never become billable duration', () => {
    assert.equal(calculateVoiceSeconds({
        connectedAt: '2026-08-05T12:01:00.000Z',
        endedAt: '2026-08-06T12:01:00.000Z',
        durationSource: 'legacy_unknown',
    }), 0);
});

test('out-of-order timestamps cannot produce negative usage', () => {
    assert.equal(calculateVoiceSeconds({
        connectedAt: '2026-08-05T12:02:00.000Z',
        endedAt: '2026-08-05T12:01:00.000Z',
        durationSource: 'livekit',
    }), 0);
});
