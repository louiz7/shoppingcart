'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDebtorName, normalizeDebtorPhone } = require('../src/services/debtor-service');

test('debtor identity ignores casing and repeated whitespace in names', () => {
    assert.equal(normalizeDebtorName('  MAX   Mustermann '), 'max mustermann');
    assert.equal(normalizeDebtorName('Max Mustermann'), 'max mustermann');
});

test('debtor identity normalizes common E.164 formatting', () => {
    assert.equal(normalizeDebtorPhone('+49 (176) 123-45678'), '+4917612345678');
    assert.equal(normalizeDebtorPhone('0049/176/12345678'), '+4917612345678');
});
