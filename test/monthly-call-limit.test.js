'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMonthlyLimitReached } = require('../src/services/monthly-call-limit-service');

test('monthly limit is disabled when no value is configured', () => {
    assert.equal(isMonthlyLimitReached(null, 999_999), false);
});

test('monthly limit blocks at the exact threshold, not before it', () => {
    assert.equal(isMonthlyLimitReached(500, 29_999), false);
    assert.equal(isMonthlyLimitReached(500, 30_000), true);
    assert.equal(isMonthlyLimitReached(500, 30_001), true);
});
