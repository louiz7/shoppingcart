'use strict';

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../src/policy/engine');

const policy = engine.mergePolicy({});

test('deny-by-default: unknown state and disallowed actions', () => {
    assert.equal(engine.isActionAllowed('BOGUS', 'CREATE_PLAN', policy).allow, false);
    assert.equal(engine.isActionAllowed('IN_PROGRESS', 'CREATE_PLAN', policy).allow, false);
    assert.equal(engine.isActionAllowed('VERIFIED', 'CREATE_PLAN', policy).allow, true);
});

test('plan creation is impossible before identity verification in every default state path', () => {
    for (const state of ['NEW', 'CONTACTABLE', 'IN_PROGRESS']) {
        assert.equal(engine.isActionAllowed(state, 'CREATE_PLAN', policy).allow, false, state);
        assert.equal(engine.isActionAllowed(state, 'GET_PLAN_OPTIONS', policy).allow, false, state);
    }
});

test('callbacks require verified context and use a non-terminal signal', () => {
    assert.equal(engine.isActionAllowed('IN_PROGRESS', 'SCHEDULE_CALLBACK', policy).allow, false);
    assert.equal(engine.isActionAllowed('VERIFIED', 'SCHEDULE_CALLBACK', policy).allow, true);
    assert.equal(engine.signalEffect('callback_requested', policy).schedule_callback, true);
    assert.equal(engine.signalEffect('callback_requested', policy).end_call, undefined);
});

test('customer overrides merge over defaults per section', () => {
    const p = engine.mergePolicy({ max_discount_pct: 5, frequency_caps: { max_attempts_per_day: 2 } });
    assert.equal(p.max_discount_pct, 5);
    assert.equal(p.frequency_caps.max_attempts_per_day, 2);
    assert.equal(p.frequency_caps.max_attempts_per_week, 3); // default preserved
});

test('call window respects hours and days in Europe/Berlin', () => {
    // 2026-07-22 is a Wednesday. 10:00 UTC = 12:00 Berlin (CEST) -> inside.
    assert.equal(engine.isWithinCallWindow(new Date('2026-07-22T10:00:00Z'), policy), true);
    // 20:00 UTC = 22:00 Berlin -> outside.
    assert.equal(engine.isWithinCallWindow(new Date('2026-07-22T20:00:00Z'), policy), false);
    // 2026-07-26 is a Sunday -> outside regardless of hour.
    assert.equal(engine.isWithinCallWindow(new Date('2026-07-26T10:00:00Z'), policy), false);
});

test('next call window starts later the same day instead of deferring a day', () => {
    // 06:30 UTC = 08:30 Berlin; default policy opens at 09:00 Berlin.
    const next = engine.nextCallWindowStart(new Date('2026-07-22T06:30:00Z'), policy);
    assert.equal(next.toISOString(), '2026-07-22T07:00:00.000Z');
});

test('next call window skips disallowed days', () => {
    // Sunday is excluded; the next default window opens Monday at 09:00 CEST.
    const next = engine.nextCallWindowStart(new Date('2026-07-26T10:00:00Z'), policy);
    assert.equal(next.toISOString(), '2026-07-27T07:00:00.000Z');
});

test('dial eligibility: dispute, suppression, caps, empty balance all block', () => {
    const base = {
        caseRow: { disputed: false, amount_cents_outstanding: 10000 },
        state: 'CONTACTABLE',
        suppressed: false,
        attempts: { today: 0, this_week: 0 },
        now: new Date('2026-07-22T10:00:00Z'),
        policy,
    };
    assert.equal(engine.eligibleForCall(base).allow, true);
    assert.equal(engine.eligibleForCall({ ...base, state: 'VERIFIED' }).allow, true);
    assert.equal(engine.eligibleForCall({ ...base, caseRow: { ...base.caseRow, disputed: true } }).reason_code, 'case_disputed');
    assert.equal(engine.eligibleForCall({ ...base, suppressed: true }).reason_code, 'suppressed');
    assert.equal(engine.eligibleForCall({ ...base, state: 'ESCALATED' }).reason_code, 'state_escalated_not_dialable');
    assert.equal(engine.eligibleForCall({ ...base, caseRow: { ...base.caseRow, amount_cents_outstanding: 0 } }).reason_code, 'nothing_outstanding');
    assert.equal(engine.eligibleForCall({ ...base, attempts: { today: 1, this_week: 1 } }).reason_code, 'daily_cap_reached');
    assert.equal(engine.eligibleForCall({ ...base, attempts: { today: 0, this_week: 3 } }).reason_code, 'weekly_cap_reached');
});

test('campaign dial safety has no hidden time or frequency policy', () => {
    const result = engine.eligibleForCampaignCall({
        caseRow: { disputed: false, amount_cents_outstanding: 10000 },
        state: 'CONTACTABLE',
        suppressed: false,
    });
    assert.equal(result.allow, true);
});

test('pending plan approval blocks new calls without blocking an unconfirmed offer', () => {
    const base = {
        caseRow: { disputed: false, amount_cents_outstanding: 10000 },
        state: 'PLAN_OFFERED',
        suppressed: false,
    };
    assert.equal(engine.eligibleForCampaignCall(base).allow, true);
    assert.deepEqual(
        engine.eligibleForCampaignCall({ ...base, substate: 'pending_human_approval' }),
        { allow: false, reason_code: 'plan_pending_approval' },
    );
});

test('signal-gated templates are hidden until the signal is reported', () => {
    const discount = { active: true, min_amount_cents: 0, trigger_signal: 'cannot_pay_in_full' };
    assert.equal(engine.templateEligible(discount, 10000, new Set()), false);
    assert.equal(engine.templateEligible(discount, 10000, new Set(['cannot_pay_in_full'])), true);
    const plain = { active: true, min_amount_cents: 0, trigger_signal: null };
    assert.equal(engine.templateEligible(plain, 10000, new Set()), true);
    assert.equal(engine.templateEligible({ ...plain, min_amount_cents: 20000 }, 10000, new Set()), false);
    assert.equal(engine.templateEligible({ ...plain, active: false }, 10000, new Set()), false);
});

test('plan terms: exact integer math and pay-today discount', () => {
    const tpl = { max_installments: 1, max_term_days: 0, discount_pct: 10 };
    const terms = engine.computePlanTerms(tpl, 24900, policy, new Date('2026-07-22T10:00:00Z'));
    assert.equal(terms.total_cents, 22410); // 249,00 - 10% = 224,10
    assert.equal(terms.installment_cents, 22410);
    assert.equal(terms.first_due_date, '2026-07-22'); // today
});

test('plan terms: installments split with ceil rounding', () => {
    const tpl = { max_installments: 3, max_term_days: 90, discount_pct: 0 };
    const terms = engine.computePlanTerms(tpl, 10000, policy, new Date('2026-07-22T10:00:00Z'));
    assert.equal(terms.total_cents, 10000);
    assert.equal(terms.installment_cents, 3334); // ceil(10000/3)
});

test('plan terms: configured installment fee is applied deterministically', () => {
    const tpl = {
        max_installments: 4,
        max_term_days: 120,
        discount_pct: '0.00',
        params: { fee_pct: 10 },
    };
    const terms = engine.computePlanTerms(tpl, 10000, policy, new Date('2026-07-22T10:00:00Z'));
    assert.equal(terms.total_cents, 11000);
    assert.equal(terms.installment_cents, 2750);
    assert.equal(terms.fee_pct, 10);
});

test('template discount above the customer ceiling is rejected', () => {
    const tpl = { max_installments: 1, max_term_days: 0, discount_pct: 50 };
    assert.throws(
        () => engine.computePlanTerms(tpl, 10000, policy, new Date()),
        (err) => err.code === 'discount_exceeds_ceiling',
    );
    const lax = engine.mergePolicy({ max_discount_pct: 60 });
    assert.equal(engine.computePlanTerms(tpl, 10000, lax, new Date()).total_cents, 5000);
});

test('escalation keyword watchdog matches case-insensitively', () => {
    assert.equal(engine.matchEscalationKeyword('Ich rufe meinen ANWALT an!', policy), 'anwalt');
    assert.equal(engine.matchEscalationKeyword('alles gut', policy), null);
});

test('unknown signals have no effect', () => {
    assert.equal(engine.signalEffect('made_up_signal', policy), null);
    assert.equal(engine.signalEffect('cannot_pay_in_full', policy).unlocks_templates, true);
    assert.equal(engine.signalEffect('dispute', policy).escalate, true);
});

test('cent formatting is German-style', () => {
    assert.equal(engine.formatCents(22410, 'EUR'), '224,10 EUR');
    assert.equal(engine.formatCents(5, 'EUR'), '0,05 EUR');
});
