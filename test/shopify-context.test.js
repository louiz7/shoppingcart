'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderReferences, orderNameQuery, selectOrder, contextualDraft } = require('../src/services/shopify-context-service');

test('extracts common Shopify order references from email text', () => {
    assert.deepEqual(orderReferences('Frage zu Bestellung #1042', 'Bestellnummer: AB-77'), ['1042', 'ab-77']);
});

test('builds a Shopify order-name query from message references', () => {
    assert.equal(orderNameQuery(['1001', 'ab-77']), 'name:1001 OR name:ab-77');
});

test('selects an explicitly referenced order over the most recent order', () => {
    const orders = [{ name: '#1043' }, { name: '#1042' }];
    assert.deepEqual(selectOrder(orders, ['1042']), { order: orders[1], match: 'reference' });
});

test('never substitutes another order when an explicit reference is not found', () => {
    const orders = [{ name: '#1043' }, { name: '#1042' }];
    assert.deepEqual(selectOrder(orders, ['9999']), { order: null, match: 'reference_not_found' });
});

test('creates a grounded draft from matched Shopify status and tracking', () => {
    const body = contextualDraft({
        match_status: 'matched',
        order: {
            name: '#1042', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
            fulfillments: [{ trackingInfo: [{ company: 'DHL', number: '123', url: 'https://tracking.example/123' }] }],
        },
    });
    assert.match(body, /#1042/);
    assert.match(body, /bezahlt/);
    assert.match(body, /https:\/\/tracking\.example\/123/);
});
