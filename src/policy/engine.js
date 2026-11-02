'use strict';

/**
 * Case-Policy Engine — pure functions only, no I/O.
 *
 * Deterministic policy enforcement: given case state, the customer's policy
 * config, and a requested action, decide allow/deny with a reason code.
 * The Tool Gateway (routes/agent-tools.js) does all DB loading and calls in
 * here; the LLM never sees or influences these decisions directly.
 *
 * Customer overrides live in policy_config.config (JSONB) and are merged
 * shallowly per top-level section over these defaults.
 */

const DEFAULT_POLICY = {
    timezone: 'Europe/Berlin',

    // When we may place outbound calls. days: 0=Sun .. 6=Sat.
    call_window: { start_hour: 9, end_hour: 20, days: [1, 2, 3, 4, 5, 6] },

    // Contact governance.
    frequency_caps: { max_attempts_per_day: 1, max_attempts_per_week: 3 },

    // Hard ceiling for any template discount — re-checked at plan creation,
    // so a misconfigured template can never exceed the client's risk limit.
    max_discount_pct: 20,

    // What the agent may disclose before verify_identity succeeds.
    disclosure_before_verify: ['debtor_name', 'creditor_name'],

    verification: { fields: ['dob', 'postcode'], required_matches: 1, max_attempts_per_call: 3 },

    // Which tools may run in which case state. Deny-by-default: an action
    // missing from a state's list is refused.
    allowed_actions_by_state: {
        NEW: ['GET_CASE_CONTEXT', 'REPORT_SIGNAL', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        CONTACTABLE: ['GET_CASE_CONTEXT', 'REPORT_SIGNAL', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        IN_PROGRESS: ['GET_CASE_CONTEXT', 'VERIFY_IDENTITY', 'REPORT_SIGNAL', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        VERIFIED: ['GET_CASE_CONTEXT', 'REPORT_SIGNAL', 'SCHEDULE_CALLBACK', 'GET_PLAN_OPTIONS', 'CREATE_PLAN', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        PLAN_OFFERED: ['GET_CASE_CONTEXT', 'REPORT_SIGNAL', 'GET_PLAN_OPTIONS', 'CREATE_PLAN', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        PLAN_ACTIVE: ['GET_CASE_CONTEXT', 'REPORT_SIGNAL', 'LOG_CALL_OUTCOME', 'ESCALATE_TO_HUMAN', 'MARK_DISPUTED'],
        PAID: ['GET_CASE_CONTEXT', 'LOG_CALL_OUTCOME'],
        ESCALATED: ['GET_CASE_CONTEXT', 'LOG_CALL_OUTCOME'],
        STOPPED: ['LOG_CALL_OUTCOME'],
    },

    // What each report_signal value does — decided HERE, not by the model.
    // unlocks_templates: makes trigger_signal-gated plan_templates eligible
    // for the rest of this call attempt.
    signal_effects: {
        dispute: { escalate: true, mark_disputed: true, end_call: true },
        already_paid: { escalate: true, end_call: true },
        wrong_person: { escalate: true, suppress_number: true, end_call: true },
        do_not_call: { suppress_debtor: true, end_call: true },
        hardship: { escalate: true, end_call: true },
        angry: { escalate: true, end_call: true },
        cannot_pay_in_full: { unlocks_templates: true },
        callback_requested: { schedule_callback: true },
    },

    // Non-LLM transcript watchdog: hard triggers scanned deterministically.
    escalation_keywords: ['anwalt', 'rechtsanwalt', 'inkasso beschwerde', 'verbraucherzentrale', 'schon bezahlt', 'bereits bezahlt'],
};

const CASE_STATES = ['NEW', 'CONTACTABLE', 'IN_PROGRESS', 'VERIFIED', 'PLAN_OFFERED', 'PLAN_ACTIVE', 'PAID', 'ESCALATED', 'STOPPED'];

const DIALABLE_STATES = ['NEW', 'CONTACTABLE', 'IN_PROGRESS', 'VERIFIED', 'PLAN_OFFERED'];

const DISPOSITIONS = [
    'payment_promised', 'plan_agreed', 'paid_claimed', 'refused', 'no_agreement',
    'callback_scheduled', 'wrong_person', 'disputed', 'escalated', 'voicemail',
    'hung_up', 'other',
];

/** Merge a customer's policy_config.config over the defaults (per section). */
function mergePolicy(config) {
    const cfg = config && typeof config === 'object' ? config : {};
    const merged = { ...DEFAULT_POLICY };
    for (const key of Object.keys(cfg)) {
        const base = DEFAULT_POLICY[key];
        if (base && typeof base === 'object' && !Array.isArray(base) && cfg[key] && typeof cfg[key] === 'object' && !Array.isArray(cfg[key])) {
            merged[key] = { ...base, ...cfg[key] };
        } else {
            merged[key] = cfg[key];
        }
    }
    return merged;
}

function isActionAllowed(state, action, policy) {
    const allowed = (policy.allowed_actions_by_state || {})[state];
    if (!allowed) return { allow: false, reason_code: 'unknown_state' };
    if (!allowed.includes(action)) return { allow: false, reason_code: `action_not_allowed_in_${state}` };
    return { allow: true, reason_code: null };
}

function hourInTz(date, tz) {
    return parseInt(
        new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(date),
        10,
    );
}

function dayInTz(date, tz) {
    const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(date);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

function isWithinCallWindow(now, policy) {
    const tz = policy.timezone || 'Europe/Berlin';
    const w = policy.call_window;
    if (!w.days.includes(dayInTz(now, tz))) return false;
    const hour = hourInTz(now, tz);
    return hour >= w.start_hour && hour < w.end_hour;
}

/**
 * Find the next minute allowed by the policy window. Iterating real instants
 * keeps timezone and DST handling with Intl instead of duplicating it here.
 */
function nextCallWindowStart(now, policy) {
    const candidate = new Date(now.getTime());
    candidate.setUTCSeconds(0, 0);
    if (candidate <= now) candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

    const searchDeadline = now.getTime() + 8 * 24 * 60 * 60 * 1000;
    while (candidate.getTime() <= searchDeadline) {
        if (isWithinCallWindow(candidate, policy)) return candidate;
        candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    }
    return null;
}

function signalEffect(signal, policy) {
    return (policy.signal_effects || {})[signal] || null;
}

/**
 * Dial-time eligibility. `attempts` = { today, this_week } counts of prior
 * call_attempts; `suppressed` = boolean from the suppression table.
 */
function eligibleForCampaignCall({ caseRow, state, substate = null, suppressed }) {
    if (caseRow.disputed) return { allow: false, reason_code: 'case_disputed' };
    if (suppressed) return { allow: false, reason_code: 'suppressed' };
    if (state === 'PLAN_OFFERED' && substate === 'pending_human_approval') {
        return { allow: false, reason_code: 'plan_pending_approval' };
    }
    if (!DIALABLE_STATES.includes(state)) return { allow: false, reason_code: `state_${state.toLowerCase()}_not_dialable` };
    if (caseRow.amount_cents_outstanding <= 0) return { allow: false, reason_code: 'nothing_outstanding' };
    return { allow: true, reason_code: null };
}

function eligibleForCall({ caseRow, state, substate = null, suppressed, attempts, now, policy }) {
    const safety = eligibleForCampaignCall({ caseRow, state, substate, suppressed });
    if (!safety.allow) return safety;
    if (!isWithinCallWindow(now, policy)) return { allow: false, reason_code: 'outside_call_window' };
    const caps = policy.frequency_caps;
    if (attempts.today >= caps.max_attempts_per_day) return { allow: false, reason_code: 'daily_cap_reached' };
    if (attempts.this_week >= caps.max_attempts_per_week) return { allow: false, reason_code: 'weekly_cap_reached' };
    return { allow: true, reason_code: null };
}

/**
 * Is this plan template eligible for this case right now?
 * `reportedSignals` = Set of signals reported via report_signal in the
 * CURRENT call attempt (loaded from the events table by the gateway).
 */
function templateEligible(template, outstandingCents, reportedSignals) {
    if (!template.active) return false;
    if (outstandingCents < template.min_amount_cents) return false;
    if (template.trigger_signal && !reportedSignals.has(template.trigger_signal)) return false;
    return true;
}

/**
 * Compute concrete plan terms from a template — the ONLY place plan math
 * happens. Throws if the template's discount exceeds the customer's ceiling.
 */
function computePlanTerms(template, outstandingCents, policy, today) {
    const discountPct = Number(template.discount_pct);
    const feePct = Number((template.params && template.params.fee_pct) || 0);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > policy.max_discount_pct) {
        const err = new Error('template_discount_exceeds_policy_ceiling');
        err.code = 'discount_exceeds_ceiling';
        throw err;
    }
    if (!Number.isFinite(feePct) || feePct < 0 || feePct > 100) {
        const err = new Error('template_fee_is_invalid');
        err.code = 'invalid_fee';
        throw err;
    }
    const totalCents = Math.round(outstandingCents * (100 - discountPct + feePct) / 100);
    const installments = template.max_installments;
    const installmentCents = Math.ceil(totalCents / installments);
    const firstDue = new Date(today.getTime());
    firstDue.setDate(firstDue.getDate() + (template.max_term_days === 0 ? 0 : Math.min(7, template.max_term_days)));
    return {
        installments,
        installment_cents: installmentCents,
        total_cents: totalCents,
        discount_pct: discountPct,
        fee_pct: feePct,
        first_due_date: firstDue.toISOString().slice(0, 10),
    };
}

/** Deterministic transcript watchdog: does this text hit a hard trigger? */
function matchEscalationKeyword(text, policy) {
    const t = String(text || '').toLowerCase();
    for (const kw of policy.escalation_keywords || []) {
        if (t.includes(kw)) return kw;
    }
    return null;
}

function formatCents(cents, currency) {
    const value = (cents / 100).toFixed(2).replace('.', ',');
    return `${value} ${currency || 'EUR'}`;
}

module.exports = {
    DEFAULT_POLICY,
    CASE_STATES,
    DIALABLE_STATES,
    DISPOSITIONS,
    mergePolicy,
    isActionAllowed,
    isWithinCallWindow,
    nextCallWindowStart,
    signalEffect,
    eligibleForCall,
    eligibleForCampaignCall,
    templateEligible,
    computePlanTerms,
    matchEscalationKeyword,
    formatCents,
};
