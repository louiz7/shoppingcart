'use strict';

function normalizeDebtorName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
}

function normalizeDebtorPhone(value) {
    return String(value || '').trim().replace(/[\s()/-]/g, '').replace(/^00/, '+');
}

async function findOrCreateDebtor(q, { customerId, externalRef, name, phoneE164, email = null }) {
    const normalizedPhone = normalizeDebtorPhone(phoneE164);
    const inserted = await q.query(
        `INSERT INTO debtors (customer_id, external_ref, name, phone_e164, email)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [customerId, externalRef, name, normalizedPhone, email],
    );
    if (inserted.rows[0]) return inserted.rows[0];

    const normalizedName = normalizeDebtorName(name);
    const existing = await q.query(
        `SELECT id
           FROM debtors
          WHERE customer_id = $1
            AND (
              (lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = $2
               AND regexp_replace(phone_e164, '[^0-9+]', '', 'g') = $3)
              OR external_ref = $4
            )
          ORDER BY CASE
                     WHEN lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = $2
                      AND regexp_replace(phone_e164, '[^0-9+]', '', 'g') = $3
                     THEN 0 ELSE 1
                   END,
                   id
          LIMIT 1`,
        [customerId, normalizedName, normalizedPhone, externalRef],
    );
    const debtor = existing.rows[0];
    if (!debtor) throw new Error('debtor_identity_conflict');

    await q.query(
        `UPDATE debtors
            SET name = $2, phone_e164 = $3, email = COALESCE($4, email)
          WHERE id = $1 AND customer_id = $5`,
        [debtor.id, name, normalizedPhone, email, customerId],
    );
    return debtor;
}

module.exports = { findOrCreateDebtor, normalizeDebtorName, normalizeDebtorPhone };
