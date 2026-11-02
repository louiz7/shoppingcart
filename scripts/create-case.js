'use strict';

/**
 * Seed a test debtor + case so an end-to-end case call can be placed.
 * Business rules come from scripts/seed-demo-policy.js — run that first.
 *
 * Usage:
 *   node scripts/create-case.js <customerId> "<Debtor Name>" <phoneE164> <amountCents> [invoiceNumber]
 *
 * Example:
 *   node scripts/create-case.js 1 "Max Mustermann" +4917612345678 24900 RE-2026-001
 *
 * Prints the case id — dial it with:
 *   curl -X POST https://<host>/v1/cases/<id>/call -H "Authorization: Bearer dlh_<key>"
 */

require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/db');
const { findOrCreateDebtor } = require('../src/services/debtor-service');

async function main() {
    const [customerIdArg, name, phone, amountArg, invoiceNumber] = process.argv.slice(2);
    const customerId = parseInt(customerIdArg, 10);
    const amountCents = parseInt(amountArg, 10);
    if (!customerId || !name || !phone || !amountCents) {
        console.error('Usage: node scripts/create-case.js <customerId> "<Debtor Name>" <phoneE164> <amountCents> [invoiceNumber]');
        process.exit(1);
    }

    // Business rules (policy config + plan templates) are seeded separately:
    // node scripts/seed-demo-policy.js <customerId>
    const { rows: tplCount } = await db.query(
        'SELECT COUNT(*)::int AS n FROM plan_templates WHERE customer_id = $1 AND active',
        [customerId],
    );
    if (tplCount[0].n === 0) {
        console.warn('WARNING: no active plan templates for this customer — the agent will have nothing to offer.');
        console.warn('Run first:  node scripts/seed-demo-policy.js ' + customerId);
    }

    const ref = crypto.randomBytes(4).toString('hex');
    const debtor = await findOrCreateDebtor(db, {
        customerId,
        externalRef: `debtor-${ref}`,
        name,
        phoneE164: phone,
    });
    const debtorId = debtor.id;
    await db.query(
        `UPDATE debtors
            SET verification_fields = verification_fields || $2::jsonb
          WHERE id = $1 AND customer_id = $3`,
        [debtorId, JSON.stringify({ dob: '1980-04-12', postcode: '10115' }), customerId],
    );

    const { rows: caseRows } = await db.query(
        `INSERT INTO cases (customer_id, debtor_id, external_ref, original_amount_cents,
                            amount_cents_outstanding, invoice_number, due_date)
         VALUES ($1, $2, $3, $4, $4, $5, NOW() - INTERVAL '30 days') RETURNING id`,
        [customerId, debtorId, `case-${ref}`, amountCents, invoiceNumber || `RE-${ref}`],
    );
    const caseId = caseRows[0].id;

    await db.query(
        `INSERT INTO case_state (case_id, state) VALUES ($1, 'CONTACTABLE')`,
        [caseId],
    );

    console.log(`debtor id:  ${debtorId}`);
    console.log(`case id:    ${caseId}`);
    console.log('verification (test data): dob=1980-04-12, postcode=10115');
    console.log(`dial with:  POST /v1/cases/${caseId}/call  (API-key auth)`);

    await db.pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
