import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getDebtorDetail } from '$lib/server/platform-data';
import type { PageServerLoad } from './$types';

const DEMO_ADMIN_EMAIL = 'milan@rescova.de';

export const load: PageServerLoad = async ({ params, locals }) => {
	const debtor = await getDebtorDetail(locals.user!.customerId, params.id);
	if (!debtor) error(404, 'Debitor nicht gefunden');

	const user = locals.user!;
	return {
		...debtor,
		canCreateDemo: user.role === 'admin' && user.email.toLowerCase() === DEMO_ADMIN_EMAIL,
		canRecordPayment: user.role !== 'viewer'
	};
};

export const actions: Actions = {
	recordPayment: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		const form = await request.formData();
		const caseId = Number(form.get('caseId'));
		if (!Number.isInteger(caseId)) return fail(400, { error: 'Ungültige Forderung.' });

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const caseResult = await client.query<{
				amount_cents_outstanding: number; currency: string;
			}>(
				`SELECT c.amount_cents_outstanding, c.currency
				   FROM cases c
				  WHERE c.id = $1 AND c.customer_id = $2 AND c.debtor_id = $3
				  FOR UPDATE`,
				[caseId, user.customerId, params.id]
			);
			const claim = caseResult.rows[0];
			if (!claim) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Forderung nicht gefunden.' });
			}
			if (claim.amount_cents_outstanding <= 0) {
				await client.query('ROLLBACK');
				return { success: 'Der Zahlungseingang wurde bereits erfasst.' };
			}

			const campaignResult = await client.query<{ campaign_id: string }>(
				`SELECT campaign_id::text
				   FROM campaign_members
				  WHERE customer_id = $1 AND case_id = $2
				  ORDER BY created_at DESC, id DESC
				  LIMIT 1`,
				[user.customerId, caseId]
			);
			const campaignId = campaignResult.rows[0]?.campaign_id || null;
			await client.query(
				`INSERT INTO payments (
				    customer_id, campaign_id, case_id, amount_cents, currency,
				    paid_at, note, created_by
				 ) VALUES ($1, $2, $3, $4, $5, NOW(), 'Manuell als eingegangen markiert', $6)`,
				[user.customerId, campaignId, caseId, claim.amount_cents_outstanding, claim.currency, user.id]
			);
			await client.query(
				`UPDATE cases
				    SET amount_cents_outstanding = 0, updated_at = NOW()
				  WHERE id = $1`,
				[caseId]
			);
			const eventResult = await client.query<{ id: string }>(
				`INSERT INTO events (
				    customer_id, case_id, actor, channel, kind, result, decision
				 ) VALUES ($1, $2, $3, 'platform', 'payment_received', $4, 'allow')
				 RETURNING id::text`,
				[
					user.customerId,
					caseId,
					`platform_user:${user.id}`,
					JSON.stringify({ amount_cents: claim.amount_cents_outstanding, currency: claim.currency })
				]
			);
			await client.query(
				`INSERT INTO case_state (case_id, state, substate, last_event_id, updated_at)
				 VALUES ($1, 'PAID', 'payment_confirmed', $2, NOW())
				 ON CONFLICT (case_id) DO UPDATE
				     SET state = 'PAID', substate = 'payment_confirmed',
				         last_event_id = $2, updated_at = NOW()`,
				[caseId, eventResult.rows[0].id]
			);
			await client.query(
				`UPDATE campaign_jobs job
				    SET status = 'cancelled', completed_at = NOW()
				  WHERE job.customer_id = $1 AND job.status = 'pending'
				    AND EXISTS (
				      SELECT 1 FROM campaign_members member
				       WHERE member.id = job.member_id AND member.case_id = $2
				    )`,
				[user.customerId, caseId]
			);
			await client.query(
				`UPDATE campaign_members
				    SET status = 'resolved', resolved_at = NOW(), next_contact_at = NULL, updated_at = NOW()
				  WHERE customer_id = $1 AND case_id = $2
				    AND status IN ('pending', 'scheduled', 'contacting', 'reached')`,
				[user.customerId, caseId]
			);
			await client.query(
				`UPDATE platform_tasks
				    SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(),
				        assigned_to = COALESCE(assigned_to, $3)
				  WHERE customer_id = $1 AND case_id = $2
				    AND status IN ('open', 'in_progress')`,
				[user.customerId, caseId, user.id]
			);
			await client.query('COMMIT');
			return { success: 'Zahlungseingang wurde erfasst und die Forderung geschlossen.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[payment-recording] failed', cause);
			return fail(500, { error: 'Zahlungseingang konnte nicht erfasst werden.' });
		} finally {
			client.release();
		}
	},

	createDemoCampaign: async ({ params, locals }) => {
		const user = locals.user!;
		if (user.role !== 'admin' || user.email.toLowerCase() !== DEMO_ADMIN_EMAIL) {
			return fail(403, { error: 'Diese Funktion ist nur für Rescova-Demos verfügbar.' });
		}
		const debtorId = Number(params.id);
		if (!Number.isInteger(debtorId)) return fail(400, { error: 'Ungültiger Debitor.' });

		const client = await db.connect();
		let campaignId: string;
		try {
			await client.query('BEGIN');
			const defaultsResult = await client.query<{
				weekdays: number[]; start_time: string; end_time: string; timezone: string;
				max_contact_attempts: number; max_attempts_per_24h: number;
				max_attempts_per_7d: number; retry_interval_minutes: number;
			}>(
				`SELECT weekdays, start_time, end_time, timezone, max_contact_attempts,
				        max_attempts_per_24h, max_attempts_per_7d, retry_interval_minutes
				   FROM organization_campaign_defaults WHERE customer_id = $1`,
				[user.customerId]
			);
			const defaults = defaultsResult.rows[0];
			if (!defaults) throw new Error('organization_campaign_defaults_missing');
			const sourceResult = await client.query<{
				name: string;
				currency: string;
				original_amount_cents: number;
			}>(
				`SELECT d.name, c.currency, c.original_amount_cents
				   FROM debtors d
				   JOIN cases c ON c.debtor_id = d.id AND c.customer_id = d.customer_id
				  WHERE d.id = $1 AND d.customer_id = $2
				  ORDER BY c.created_at DESC, c.id DESC
				  LIMIT 1
				  FOR SHARE OF d, c`,
				[debtorId, user.customerId]
			);
			const source = sourceResult.rows[0];
			if (!source) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Für diesen Debitor gibt es keine Forderung als Demo-Vorlage.' });
			}

			const campaignResult = await client.query<{ id: string }>(
				`INSERT INTO campaigns (
					customer_id, name, status, channels, weekdays, start_time, end_time,
					timezone, max_contact_attempts, max_attempts_per_24h, max_attempts_per_7d,
					retry_interval_minutes, is_demo, installments_enabled, max_installments,
					installment_fee_pct, installment_min_cents, discount_enabled,
					discount_24h_pct, discount_7d_pct, created_by
				 ) VALUES (
					$1, $2, 'draft', ARRAY['voice']::text[], $3, $4, $5, $6, $7, $8, $9, $10,
					TRUE, TRUE, 3, 0, 0, TRUE, 5, 5, $11
				 ) RETURNING id::text`,
				[user.customerId, `Demo · ${source.name}`, defaults.weekdays, defaults.start_time,
					defaults.end_time, defaults.timezone, defaults.max_contact_attempts,
					defaults.max_attempts_per_24h, defaults.max_attempts_per_7d,
					defaults.retry_interval_minutes, user.id]
			);
			campaignId = campaignResult.rows[0].id;
			await client.query(
				`UPDATE campaigns SET name = $1 WHERE id = $2 AND customer_id = $3`,
				[`Demo · ${source.name} #${campaignId}`, campaignId, user.customerId]
			);

			const caseResult = await client.query<{ id: number }>(
				`INSERT INTO cases (
					customer_id, debtor_id, external_ref, currency, original_amount_cents,
					amount_cents_outstanding, invoice_number, due_date
				 ) VALUES ($1, $2, $3, $4, $5, $5, $6, CURRENT_DATE - INTERVAL '14 days')
				 RETURNING id`,
				[
					user.customerId,
					debtorId,
					`demo-campaign-${campaignId}`,
					source.currency,
					source.original_amount_cents,
					`DEMO-${campaignId}`
				]
			);
			const caseId = caseResult.rows[0].id;
			await client.query(
				`INSERT INTO case_state (case_id, state, substate)
				 VALUES ($1, 'CONTACTABLE', 'demo')`,
				[caseId]
			);
			const memberResult = await client.query<{ id: string }>(
				`INSERT INTO campaign_members (
					customer_id, campaign_id, case_id, status, next_contact_at
				 ) VALUES ($1, $2, $3, 'pending', NULL)
				 RETURNING id::text`,
				[user.customerId, campaignId, caseId]
			);

			await client.query(
				`INSERT INTO plan_templates (
					customer_id, campaign_id, code, name, min_amount_cents,
					max_installments, max_term_days, discount_pct, trigger_signal, params
				 ) VALUES
					($1, $2, $3, 'Ratenzahlung in 3 Raten', 0, 3, 93, 0, 'cannot_pay_in_full', '{}'::jsonb),
					($1, $2, $4, 'Sofortzahlungsrabatt 24h', 0, 1, 1, 5, NULL, '{}'::jsonb),
					($1, $2, $5, 'Sofortzahlungsrabatt 7d', 0, 1, 7, 5, NULL, '{}'::jsonb)`,
				[
					user.customerId,
					campaignId,
					`campaign_${campaignId}_demo_rates`,
					`campaign_${campaignId}_demo_discount_24h`,
					`campaign_${campaignId}_demo_discount_7d`
				]
			);
			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, member_id, actor, kind, data)
				 VALUES ($1, $2, $3, $4, 'campaign_created', $5)`,
				[
					user.customerId,
					campaignId,
					memberResult.rows[0].id,
					`platform_user:${user.id}`,
					JSON.stringify({ demo: true, debtor_id: debtorId, case_id: caseId, contacts: 1 })
				]
			);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[demo-campaign-create] failed', cause);
			return fail(500, { error: 'Demo-Kampagne konnte nicht angelegt werden.' });
		} finally {
			client.release();
		}

		redirect(303, `/inkassokampagnen/${campaignId}`);
	},

	approvePlan: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		const form = await request.formData();
		const planId = Number(form.get('planId'));
		if (!Number.isInteger(planId)) return fail(400, { error: 'Ungültiger Zahlungsplan.' });

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const caseLockResult = await client.query<{ case_id: number }>(
				`SELECT c.id AS case_id
				   FROM cases c
				   JOIN payment_plans pp ON pp.case_id = c.id AND pp.customer_id = c.customer_id
				  WHERE pp.id = $1
				    AND pp.customer_id = $2
				    AND c.debtor_id = $3
				  FOR UPDATE OF c`,
				[planId, user.customerId, params.id]
			);
			const lockedCaseId = caseLockResult.rows[0]?.case_id;
			if (!lockedCaseId) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Zahlungsplan nicht gefunden.' });
			}
			const guardedCaseResult = await client.query<{ disputed: boolean; state: string }>(
				`SELECT c.disputed, COALESCE(cs.state, 'NEW') AS state
				   FROM cases c
				   LEFT JOIN case_state cs ON cs.case_id = c.id
				  WHERE c.id = $1 AND c.customer_id = $2`,
				[lockedCaseId, user.customerId]
			);
			const lockedCase = guardedCaseResult.rows[0];
			if (lockedCase.disputed || lockedCase.state === 'ESCALATED') {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Der Zahlungsplan kann nicht freigegeben werden, weil die Forderung bestritten wurde oder manuell geprüft wird.' });
			}
			const planResult = await client.query<{
				id: number; case_id: number; status: string;
			}>(
				`SELECT pp.id, pp.case_id, pp.status
				   FROM payment_plans pp
				  WHERE pp.id = $1
				    AND pp.customer_id = $2
				    AND pp.case_id = $3
				  FOR UPDATE`,
				[planId, user.customerId, lockedCaseId]
			);
			const plan = planResult.rows[0];
			if (!plan) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Zahlungsplan nicht gefunden.' });
			}
			if (plan.status === 'approved') {
				await client.query('ROLLBACK');
				return { success: 'Zahlungsplan ist bereits freigegeben.' };
			}
			if (plan.status !== 'pending_approval') {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Dieser Zahlungsplan kann nicht freigegeben werden.' });
			}

			await client.query(
				`UPDATE payment_plans
				    SET status = 'approved', approved_by = $2, approved_at = NOW()
				  WHERE id = $1`,
				[plan.id, user.id]
			);
			const eventResult = await client.query<{ id: string }>(
				`INSERT INTO events (
				    customer_id, case_id, actor, channel, kind, result, decision
				 ) VALUES ($1, $2, $3, 'platform', 'approve_payment_plan', $4, 'allow')
				 RETURNING id::text`,
				[
					user.customerId,
					plan.case_id,
					`platform_user:${user.id}`,
					JSON.stringify({ plan_id: plan.id, status: 'approved' })
				]
			);
			await client.query(
				`INSERT INTO case_state (case_id, state, substate, last_event_id, updated_at)
				 VALUES ($1, 'PLAN_ACTIVE', 'human_approved', $2, NOW())
				 ON CONFLICT (case_id) DO UPDATE
				     SET state = 'PLAN_ACTIVE',
				         substate = 'human_approved',
				         last_event_id = $2,
				         updated_at = NOW()`,
				[plan.case_id, eventResult.rows[0].id]
			);
			await client.query(
				`UPDATE platform_tasks
				    SET status = 'resolved', assigned_to = COALESCE(assigned_to, $3),
				        resolved_at = NOW(), updated_at = NOW()
				  WHERE customer_id = $1
				    AND case_id = $2
				    AND kind = 'plan_approval'
				    AND status IN ('open', 'in_progress')`,
				[user.customerId, plan.case_id, user.id]
			);
			await client.query('COMMIT');
			return { success: 'Zahlungsplan wurde freigegeben.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[payment-plan-approval] failed', cause);
			return fail(500, { error: 'Zahlungsplan konnte nicht freigegeben werden.' });
		} finally {
			client.release();
		}
	},

	resolveTasks: async ({ params, locals }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		const result = await db.query(
			`UPDATE platform_tasks t
			    SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(),
			        assigned_to = COALESCE(assigned_to, $3)
			  WHERE t.customer_id = $1
			    AND t.status IN ('open', 'in_progress')
			    AND t.kind <> 'plan_approval'
			    AND EXISTS (
			        SELECT 1 FROM cases c
			         WHERE c.id = t.case_id
			           AND c.customer_id = t.customer_id
			           AND c.debtor_id = $2
			    )`,
			[user.customerId, params.id, user.id]
		);
		if (!result.rowCount) return fail(404, { error: 'Keine offenen Aufgaben gefunden.' });
		return { success: 'Aufgaben wurden als erledigt markiert.' };
	}
};
