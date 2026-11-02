'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSipFailure } = require('../src/services/sip-error-service');

test('extracts SIP status from LiveKit error messages', () => {
    assert.deepEqual(
        parseSipFailure({
            code: 'permission_denied',
            message: 'twirp error unknown: unexpected status from INVITE response: sip status: 603: Decline',
        }),
        { sipStatusCode: 603, reason: 'sip_603_decline' },
    );
});

test('prefers explicit SIP status and preserves non-SIP errors', () => {
    assert.deepEqual(
        parseSipFailure({ sipStatusCode: 486, sipStatus: 'Busy Here' }),
        { sipStatusCode: 486, reason: 'sip_486_busy_here' },
    );
    assert.deepEqual(
        parseSipFailure({ code: 'permission_denied', message: 'request denied' }),
        { sipStatusCode: null, reason: 'permission_denied' },
    );
});
