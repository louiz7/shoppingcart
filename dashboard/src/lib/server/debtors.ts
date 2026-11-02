import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export function normalizeDebtorName(value: string): string {
	return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-DE');
}

function normalizeDebtorPhone(value: string): string {
	return value.trim().replace(/[\s()/-]/g, '').replace(/^00/, '+');
}

export async function findOrCreateDebtor(
	client: PoolClient,
	input: { customerId: number; name: string; phone: string; email: string | null }
): Promise<number> {
	const normalizedName = normalizeDebtorName(input.name);
	const normalizedPhone = normalizeDebtorPhone(input.phone);
	const externalRef = `campaign-contact-${createHash('sha256')
		.update(`${normalizedName}|${normalizedPhone}`)
		.digest('hex')
		.slice(0, 24)}`;
	const inserted = await client.query<{ id: number }>(
		`INSERT INTO debtors (customer_id, external_ref, name, phone_e164, email)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT DO NOTHING
		 RETURNING id`,
		[input.customerId, externalRef, input.name, normalizedPhone, input.email]
	);
	if (inserted.rows[0]) return inserted.rows[0].id;

	const existing = await client.query<{ id: number }>(
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
		[input.customerId, normalizedName, normalizedPhone, externalRef]
	);
	const debtorId = existing.rows[0]?.id;
	if (!debtorId) throw new Error('debtor_identity_conflict');

	await client.query(
		`UPDATE debtors
		    SET name = $2,
		        phone_e164 = $3,
		        email = COALESCE($4, email)
		  WHERE id = $1 AND customer_id = $5`,
		[debtorId, input.name, normalizedPhone, input.email, input.customerId]
	);
	return debtorId;
}
