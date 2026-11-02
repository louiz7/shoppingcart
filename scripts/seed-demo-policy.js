'use strict';

/**
 * Seed the demo business logic for a customer: policy config + the concrete
 * payment-plan/discount catalog the agent may offer. In production our
 * clients will configure this themselves; for the demo we set it here.
 *
 * Idempotent: re-running updates the demo values in place.
 *
 * Usage:  node scripts/seed-demo-policy.js <customerId>
 */

require('dotenv').config();
const db = require('../src/db');

// Demo policy: wide call window and generous frequency caps so repeated demo
// calls are never blocked by contact governance; 15% discount ceiling.
const DEMO_POLICY = {
    creditor_display_name: 'Musterfirma GmbH',
    max_discount_pct: 15,
    call_window: { start_hour: 8, end_hour: 22, days: [0, 1, 2, 3, 4, 5, 6] },
    frequency_caps: { max_attempts_per_day: 10, max_attempts_per_week: 50 },
};

// The complete, closed catalog of what the agent may agree to — anything not
// in this list (5 rates, custom deadlines, other discounts) is structurally
// impossible: no template row -> never offered -> create_payment_plan has no
// option token for it.
//
// Installment plans exist in EXACTLY 2, 3, or 4 monthly rates. min_amount
// demonstrates per-template gating: more rates require a larger balance. Only
// full_payment is offered upfront — every installment/discount option (rates_*
// and the pay-today/pay-this-week incentives) unlocks only after the debtor
// reports they cannot pay in full (report_signal 'cannot_pay_in_full'): Evi
// always tries a straight full payment first.
const DEMO_TEMPLATES = [
    { code: 'full_payment', name: 'Vollständige Zahlung innerhalb von 7 Tagen',     installments: 1, term_days: 7,   discount: 0,  trigger: null, min_amount: 0 },
    { code: 'rates_2',      name: 'Ratenzahlung in 2 Monatsraten',                  installments: 2, term_days: 60,  discount: 0,  trigger: 'cannot_pay_in_full', min_amount: 5000 },
    { code: 'rates_3',      name: 'Ratenzahlung in 3 Monatsraten',                  installments: 3, term_days: 90,  discount: 0,  trigger: 'cannot_pay_in_full', min_amount: 10000 },
    { code: 'rates_4',      name: 'Ratenzahlung in 4 Monatsraten',                  installments: 4, term_days: 120, discount: 0,  trigger: 'cannot_pay_in_full', min_amount: 20000 },
    { code: 'pay_today_10', name: 'Sofortzahlung heute mit 10% Nachlass',           installments: 1, term_days: 0,   discount: 10, trigger: 'cannot_pay_in_full', min_amount: 0 },
    { code: 'pay_week_5',   name: 'Zahlung innerhalb von 7 Tagen mit 5% Nachlass',  installments: 1, term_days: 7,   discount: 5,  trigger: 'cannot_pay_in_full', min_amount: 0 },
];

async function main() {
    const customerId = parseInt(process.argv[2], 10);
    if (!customerId) {
        console.error('Usage: node scripts/seed-demo-policy.js <customerId>');
        process.exit(1);
    }

    const { rows } = await db.query('SELECT name FROM customers WHERE id = $1', [customerId]);
    if (rows.length === 0) {
        console.error(`customer ${customerId} not found — run: npm run seed -- "Name" email`);
        process.exit(1);
    }

    await db.query(
        `INSERT INTO policy_config (customer_id, config)
         VALUES ($1, $2)
         ON CONFLICT (customer_id) DO UPDATE
            SET config = $2, version = policy_config.version + 1, updated_at = NOW()`,
        [customerId, JSON.stringify(DEMO_POLICY)],
    );

    // The seeded set is the ENTIRE catalog: deactivate anything else first so
    // re-seeding always leaves exactly these offers possible.
    await db.query(
        'UPDATE plan_templates SET active = FALSE WHERE customer_id = $1 AND code <> ALL($2)',
        [customerId, DEMO_TEMPLATES.map((t) => t.code)],
    );
    for (const t of DEMO_TEMPLATES) {
        await db.query(
            `INSERT INTO plan_templates
                (customer_id, code, name, max_installments, max_term_days, discount_pct, trigger_signal, min_amount_cents)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (customer_id, code) DO UPDATE
                SET name = $3, max_installments = $4, max_term_days = $5,
                    discount_pct = $6, trigger_signal = $7, min_amount_cents = $8, active = TRUE`,
            [customerId, t.code, t.name, t.installments, t.term_days, t.discount, t.trigger, t.min_amount],
        );
    }

    console.log(`policy config seeded for customer ${customerId} ("${rows[0].name}"):`);
    console.log(`  creditor name:   ${DEMO_POLICY.creditor_display_name}`);
    console.log(`  discount ceiling: ${DEMO_POLICY.max_discount_pct}%`);
    console.log(`  call window:     ${DEMO_POLICY.call_window.start_hour}-${DEMO_POLICY.call_window.end_hour} Uhr, all days (demo)`);
    console.log('plan templates (closed catalog — nothing else can be agreed):');
    for (const t of DEMO_TEMPLATES) {
        const gate = t.trigger ? ` [unlocked by signal: ${t.trigger}]` : '';
        const min = t.min_amount ? ` [from ${(t.min_amount / 100).toFixed(0)} EUR]` : '';
        console.log(`  - ${t.name} (${t.installments}x, ${t.discount}% Nachlass)${min}${gate}`);
    }

    await db.pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
