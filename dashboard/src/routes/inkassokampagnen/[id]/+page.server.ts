import { error, fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDebtCollectionCampaignDetail } from '$lib/server/platform-data';
import { db } from '$lib/server/db';
import { findOrCreateDebtor } from '$lib/server/debtors';

const CALLING_TEMPORARILY_DISABLED = true;

function parseAmount(value: FormDataEntryValue | null): number {
	const cleaned = String(value || '').replace(/[€\s]/g, '');
	return Number(cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned);
}

function parseInteger(form: FormData, name: string, min: number, max: number): number | null {
	const value = Number(String(form.get(name) || ''));
	return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseDecimal(form: FormData, name: string, min: number, max: number): number | null {
	const value = Number(String(form.get(name) || '').replace(',', '.').replace(/[€%\s]/g, ''));
	return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function normalizePhone(value: string): string | null {
	const normalized = value.replace(/[\s()/-]/g, '').replace(/^00/, '+');
	return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

function parseIsoDate(value: string): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return null;
	const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const campaign = await getDebtCollectionCampaignDetail(locals.user!.customerId, params.id);
	if (!campaign) error(404, 'Inkassokampagne nicht gefunden');
	return campaign;
};

export const actions: Actions = {
	addDebtor: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') {
			return fail(403, { error: 'Keine Schreibberechtigung.', addDebtorForm: true });
		}
		const form = await request.formData();
		const name = String(form.get('name') || '').trim().replace(/\s+/g, ' ').slice(0, 200);
		const phone = normalizePhone(String(form.get('phone') || ''));
		const email = String(form.get('email') || '').trim().toLowerCase().slice(0, 320);
		const invoice = String(form.get('invoice') || '').trim().slice(0, 160);
		const amount = parseAmount(form.get('amount'));
		const dueDate = parseIsoDate(String(form.get('dueDate') || ''));
		const note = String(form.get('note') || '').trim().slice(0, 5_000);
		const values = { name, phone: String(form.get('phone') || ''), email, invoice, amount: String(form.get('amount') || ''), dueDate, note };
		if (name.length < 2 || !phone || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ||
			!invoice || !Number.isFinite(amount) || amount <= 0 || !dueDate) {
			return fail(400, {
				error: 'Bitte Name, internationale Telefonnummer, Rechnungsnummer, Betrag und Fälligkeit prüfen.',
				addDebtorForm: true, debtorValues: values
			});
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const campaignResult = await client.query<{ status: string }>(
				`SELECT status FROM campaigns WHERE id = $1 AND customer_id = $2 FOR UPDATE`,
				[params.id, user.customerId]
			);
			const campaign = campaignResult.rows[0];
			if (!campaign) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Kampagne nicht gefunden.', addDebtorForm: true, debtorValues: values });
			}
			if (['completed', 'cancelled'].includes(campaign.status)) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Zu abgeschlossenen Kampagnen können keine Kontakte hinzugefügt werden.', addDebtorForm: true, debtorValues: values });
			}

			const debtorId = await findOrCreateDebtor(client, {
				customerId: user.customerId, name, phone, email: email || null
			});
			const cents = Math.round(amount * 100);
			const externalRef = `invoice-${invoice}`;
			let caseResult = await client.query<{
				id: number; debtor_id: number; original_amount_cents: number; amount_cents_outstanding: number;
			}>(
				`INSERT INTO cases (
					customer_id, debtor_id, external_ref, original_amount_cents,
					amount_cents_outstanding, invoice_number, due_date, note
				 ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
				 ON CONFLICT (customer_id, external_ref) DO NOTHING
				 RETURNING id, debtor_id, original_amount_cents, amount_cents_outstanding`,
				[user.customerId, debtorId, externalRef, cents, invoice, dueDate, note || null]
			);
			if (!caseResult.rows[0]) {
				caseResult = await client.query(
					`SELECT id, debtor_id, original_amount_cents, amount_cents_outstanding FROM cases
					  WHERE customer_id = $1 AND external_ref = $2 FOR UPDATE`,
					[user.customerId, externalRef]
				);
				const existing = caseResult.rows[0];
				if (!existing || existing.debtor_id !== debtorId || existing.original_amount_cents !== cents) {
					await client.query('ROLLBACK');
					return fail(409, {
						error: 'Diese Rechnungsnummer existiert bereits mit abweichendem Kontakt oder Betrag.',
						addDebtorForm: true, debtorValues: values
					});
				}
			}
			const caseId = caseResult.rows[0].id;
			const outstanding = caseResult.rows[0].amount_cents_outstanding;
			await client.query(
				`INSERT INTO case_state (case_id, state) VALUES ($1, 'CONTACTABLE')
				 ON CONFLICT (case_id) DO NOTHING`,
				[caseId]
			);
			const memberResult = await client.query<{ id: string }>(
				`INSERT INTO campaign_members (
					customer_id, campaign_id, case_id, status, next_contact_at
				 ) VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (campaign_id, case_id) DO NOTHING
				 RETURNING id::text`,
				[
					user.customerId, params.id, caseId,
					outstanding <= 0 ? 'resolved' : campaign.status === 'draft' ? 'pending' : 'scheduled',
					outstanding <= 0 || campaign.status === 'draft' ? null : new Date()
				]
			);
			const memberId = memberResult.rows[0]?.id;
			if (!memberId) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Dieser Kontakt gehört bereits zur Kampagne.', addDebtorForm: true, debtorValues: values });
			}
			if (campaign.status !== 'draft' && outstanding > 0) {
				await client.query(
					`INSERT INTO campaign_jobs (customer_id, campaign_id, member_id, attempt_number, scheduled_at)
					 VALUES ($1, $2, $3, 1, NOW())
					 ON CONFLICT (member_id, attempt_number) DO NOTHING`,
					[user.customerId, params.id, memberId]
				);
			}
			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, member_id, actor, kind, data)
				 VALUES ($1, $2, $3, $4, 'member_added_manually', $5)`,
				[user.customerId, params.id, memberId, `platform_user:${user.id}`, JSON.stringify({ debtor_id: debtorId, case_id: caseId })]
			);
			await client.query('COMMIT');
			return { addDebtorForm: true, addDebtorSuccess: `${name} wurde zur Kampagne hinzugefügt.` };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[campaign-add-debtor] failed', cause);
			return fail(500, { error: 'Kontakt konnte nicht hinzugefügt werden.', addDebtorForm: true, debtorValues: values });
		} finally {
			client.release();
		}
	},

	edit: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.', editForm: true });

		const form = await request.formData();
		const name = String(form.get('campaignName') || '').trim().slice(0, 200);
		const weekdays = [...new Set(form.getAll('weekdays').map(Number))]
			.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
			.sort((a, b) => a - b);
		const startTime = String(form.get('startTime') || '');
		const endTime = String(form.get('endTime') || '');
		const maxAttempts = parseInteger(form, 'maxAttempts', 1, 20);
		const maxAttemptsPer24h = parseInteger(form, 'maxAttemptsPer24h', 1, 20);
		const maxAttemptsPer7d = parseInteger(form, 'maxAttemptsPer7d', 1, 100);
		const retryIntervalMinutes = parseInteger(form, 'retryIntervalMinutes', 1, 10080);
		const installmentsEnabled = form.get('installmentsEnabled') === 'on';
		const maxInstallments = installmentsEnabled ? parseInteger(form, 'maxInstallments', 2, 24) : null;
		const installmentFeePct = installmentsEnabled ? parseDecimal(form, 'installmentFeePct', 0, 100) : 0;
		const installmentMin = installmentsEnabled ? parseDecimal(form, 'installmentMin', 0, 100_000_000) : 0;
		const discountEnabled = form.get('discountEnabled') === 'on';
		const discount24h = discountEnabled ? parseDecimal(form, 'discount24h', 0, 100) : 0;
		const discount7d = discountEnabled ? parseDecimal(form, 'discount7d', 0, 100) : 0;

		if (!name || weekdays.length === 0 || maxAttempts === null || maxAttemptsPer24h === null ||
			maxAttemptsPer7d === null || retryIntervalMinutes === null || maxAttemptsPer7d < maxAttemptsPer24h ||
			maxAttempts < maxAttemptsPer7d ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime >= endTime ||
			(installmentsEnabled && (maxInstallments === null || installmentFeePct === null || installmentMin === null)) ||
			(discountEnabled && (discount24h === null || discount7d === null))) {
			return fail(400, { error: 'Bitte prüfe die Kampagneneinstellungen.', editForm: true });
		}

		const policyResult = await db.query<{ max_discount_pct: string }>(
			`SELECT COALESCE(config->>'max_discount_pct', '20') AS max_discount_pct
			   FROM policy_config
			  WHERE customer_id = $1`,
			[user.customerId]
		);
		const configuredCeiling = Number(policyResult.rows[0]?.max_discount_pct ?? 20);
		const discountCeiling = Number.isFinite(configuredCeiling) ? configuredCeiling : 20;
		if (discountEnabled && Math.max(discount24h || 0, discount7d || 0) > discountCeiling) {
			return fail(400, {
				error: `Der Rabatt darf das Richtlinienlimit von ${discountCeiling} % nicht überschreiten.`,
				editForm: true
			});
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const currentResult = await client.query<{
				name: string; status: string; weekdays: number[]; start_time: string; end_time: string;
				max_contact_attempts: number; max_attempts_per_24h: number; max_attempts_per_7d: number;
				retry_interval_minutes: number; installments_enabled: boolean; max_installments: number | null;
				installment_fee_pct: string; installment_min_cents: number; discount_enabled: boolean;
				discount_24h_pct: string; discount_7d_pct: string;
			}>(
				`SELECT name, status, weekdays, start_time, end_time, max_contact_attempts,
				        max_attempts_per_24h, max_attempts_per_7d, retry_interval_minutes,
				        installments_enabled, max_installments, installment_fee_pct,
				        installment_min_cents, discount_enabled, discount_24h_pct, discount_7d_pct
				   FROM campaigns
				  WHERE id = $1 AND customer_id = $2
				  FOR UPDATE`,
				[params.id, user.customerId]
			);
			const current = currentResult.rows[0];
			if (!current) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Kampagne nicht gefunden.', editForm: true });
			}
			if (['completed', 'cancelled'].includes(current.status)) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Abgeschlossene Kampagnen können nicht mehr bearbeitet werden.', editForm: true });
			}

			const installmentMinCents = Math.round((installmentMin || 0) * 100);
			await client.query(
				`UPDATE campaigns
				    SET name = $1, weekdays = $2, start_time = $3, end_time = $4,
				        max_contact_attempts = $5, max_attempts_per_24h = $6,
				        max_attempts_per_7d = $7, retry_interval_minutes = $8,
				        installments_enabled = $9, max_installments = $10, installment_fee_pct = $11,
				        installment_min_cents = $12, discount_enabled = $13,
				        discount_24h_pct = $14, discount_7d_pct = $15, updated_at = NOW()
				  WHERE id = $16 AND customer_id = $17`,
				[
					name, weekdays, startTime, endTime, maxAttempts, maxAttemptsPer24h,
					maxAttemptsPer7d, retryIntervalMinutes, installmentsEnabled,
					maxInstallments, installmentFeePct, installmentMinCents, discountEnabled,
					discount24h, discount7d, params.id, user.customerId
				]
			);
			await client.query(
				`UPDATE campaign_jobs j
				    SET status = 'cancelled', completed_at = NOW(), last_error = 'attempt_limit_reduced'
				   FROM campaign_members cm
				  WHERE j.member_id = cm.id AND cm.campaign_id = $1 AND cm.customer_id = $2
				    AND j.status = 'pending' AND j.job_kind <> 'callback'
				    AND j.attempt_number > $3`,
				[params.id, user.customerId, maxAttempts]
			);
			await client.query(
				`UPDATE campaign_jobs j
				    SET scheduled_at = NOW(), locked_at = NULL, last_error = NULL
				   FROM campaign_members cm
				  WHERE j.member_id = cm.id AND cm.campaign_id = $1 AND cm.customer_id = $2
				    AND j.status = 'pending' AND j.job_kind <> 'callback'`,
				[params.id, user.customerId]
			);
			await client.query(
				`UPDATE campaign_members
				    SET status = 'failed', next_contact_at = NULL,
				        last_error = NULL, updated_at = NOW()
				  WHERE campaign_id = $1 AND customer_id = $2
				    AND status IN ('pending', 'scheduled') AND attempt_count >= $3
				    AND NOT EXISTS (
				        SELECT 1 FROM campaign_jobs callback
				         WHERE callback.member_id = campaign_members.id
				           AND callback.customer_id = campaign_members.customer_id
				           AND callback.job_kind = 'callback'
				           AND callback.status IN ('pending', 'processing')
				    )`,
				[params.id, user.customerId, maxAttempts]
			);
			await client.query(
				`UPDATE campaign_members cm
				    SET status = 'scheduled',
				        next_contact_at = (
				            SELECT MIN(j.scheduled_at) FROM campaign_jobs j
				             WHERE j.member_id = cm.id AND j.customer_id = cm.customer_id
				               AND j.status = 'pending'
				        ),
				        last_error = NULL, updated_at = NOW()
				  WHERE cm.campaign_id = $1 AND cm.customer_id = $2
				    AND EXISTS (
				        SELECT 1 FROM campaign_jobs j
				         WHERE j.member_id = cm.id AND j.customer_id = cm.customer_id
				           AND j.status = 'pending'
				    )
				    AND (
				        cm.attempt_count < $3 OR EXISTS (
				            SELECT 1 FROM campaign_jobs callback
				             WHERE callback.member_id = cm.id AND callback.customer_id = cm.customer_id
				               AND callback.job_kind = 'callback' AND callback.status = 'pending'
				        )
				    )`,
				[params.id, user.customerId, maxAttempts]
			);

			await client.query(
				`UPDATE plan_templates SET active = FALSE
				  WHERE campaign_id = $1 AND customer_id = $2
				    AND code IN ($3, $4, $5)`,
				[
					params.id, user.customerId, `campaign_${params.id}_rates`,
					`campaign_${params.id}_discount_24h`, `campaign_${params.id}_discount_7d`
				]
			);
			if (installmentsEnabled && maxInstallments) {
				await client.query(
					`INSERT INTO plan_templates (
						customer_id, campaign_id, code, name, min_amount_cents,
						max_installments, max_term_days, discount_pct, trigger_signal, params
					 ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'cannot_pay_in_full', $8)
					 ON CONFLICT (customer_id, code) DO UPDATE
					     SET campaign_id = EXCLUDED.campaign_id, name = EXCLUDED.name,
					         min_amount_cents = EXCLUDED.min_amount_cents,
					         max_installments = EXCLUDED.max_installments,
					         max_term_days = EXCLUDED.max_term_days,
					         trigger_signal = EXCLUDED.trigger_signal,
					         params = EXCLUDED.params, active = TRUE`,
					[
						user.customerId, params.id, `campaign_${params.id}_rates`,
						`Ratenzahlung in ${maxInstallments} Raten`, installmentMinCents,
						maxInstallments, maxInstallments * 31,
						JSON.stringify({ fee_pct: installmentFeePct })
					]
				);
			}
			if (discountEnabled) {
				for (const [suffix, days, discount] of [['24h', 1, discount24h], ['7d', 7, discount7d]] as const) {
					if (!discount) continue;
					await client.query(
						`INSERT INTO plan_templates (
							customer_id, campaign_id, code, name, max_installments,
							max_term_days, discount_pct, params
						 ) VALUES ($1, $2, $3, $4, 1, $5, $6, '{}'::jsonb)
						 ON CONFLICT (customer_id, code) DO UPDATE
						     SET campaign_id = EXCLUDED.campaign_id, name = EXCLUDED.name,
						         max_term_days = EXCLUDED.max_term_days,
						         discount_pct = EXCLUDED.discount_pct, active = TRUE`,
						[user.customerId, params.id, `campaign_${params.id}_discount_${suffix}`, `Sofortzahlungsrabatt ${suffix}`, days, discount]
					);
				}
			}

			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, actor, kind, data)
				 VALUES ($1, $2, $3, 'campaign_updated', $4)`,
				[
					user.customerId, params.id, `platform_user:${user.id}`,
					JSON.stringify({
						before: current,
						after: {
							name, weekdays, start_time: startTime, end_time: endTime,
							max_contact_attempts: maxAttempts, max_attempts_per_24h: maxAttemptsPer24h,
							max_attempts_per_7d: maxAttemptsPer7d, retry_interval_minutes: retryIntervalMinutes,
							installments_enabled: installmentsEnabled,
							max_installments: maxInstallments, installment_fee_pct: installmentFeePct,
							installment_min_cents: installmentMinCents, discount_enabled: discountEnabled,
							discount_24h_pct: discount24h, discount_7d_pct: discount7d
						}
					})
				]
			);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[campaign-edit] failed', cause);
			return fail(500, { error: 'Kampagne konnte nicht aktualisiert werden.', editForm: true });
		} finally {
			client.release();
		}

		redirect(303, `/inkassokampagnen/${params.id}`);
	},

	delete: async ({ params, locals }) => {
		const user = locals.user!;
		if (user.role === 'viewer') {
			return fail(403, { error: 'Keine Schreibberechtigung.', deleteForm: true });
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const campaignResult = await client.query(
				`SELECT id FROM campaigns
				  WHERE id = $1 AND customer_id = $2
				  FOR UPDATE`,
				[params.id, user.customerId]
			);
			if (!campaignResult.rowCount) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Kampagne nicht gefunden.', deleteForm: true });
			}

			const callbackResult = await client.query<{ pending_count: string }>(
				`SELECT COUNT(*) AS pending_count
				   FROM campaign_jobs
				  WHERE campaign_id = $1
				    AND customer_id = $2
				    AND job_kind = 'callback'
				    AND status = 'pending'`,
				[params.id, user.customerId]
			);
			const pendingCallbacks = Number(callbackResult.rows[0]?.pending_count || 0);
			if (pendingCallbacks > 0) {
				await client.query('ROLLBACK');
				return fail(409, {
					error: pendingCallbacks === 1
						? 'Diese Kampagne kann nicht gelöscht werden, weil noch ein vereinbarter Rückruf aussteht.'
						: `Diese Kampagne kann nicht gelöscht werden, weil noch ${pendingCallbacks} vereinbarte Rückrufe ausstehen.`,
					deleteForm: true
				});
			}

			const planResult = await client.query<{ pending_count: string }>(
				`SELECT COUNT(*) AS pending_count
				   FROM payment_plans pp
				   JOIN plan_templates pt ON pt.id = pp.template_id
				  WHERE pt.campaign_id = $1
				    AND pt.customer_id = $2
				    AND pp.customer_id = $2
				    AND pp.status = 'pending_approval'`,
				[params.id, user.customerId]
			);
			const pendingPlans = Number(planResult.rows[0]?.pending_count || 0);
			if (pendingPlans > 0) {
				await client.query('ROLLBACK');
				return fail(409, {
					error: pendingPlans === 1
						? 'Diese Kampagne kann nicht gelöscht werden, weil ein Zahlungsplan noch auf Bestätigung wartet. Bitte gib den Plan zuerst im Postfach frei.'
						: `Diese Kampagne kann nicht gelöscht werden, weil ${pendingPlans} Zahlungspläne noch auf Bestätigung warten. Bitte gib die Pläne zuerst im Postfach frei.`,
					deleteForm: true
				});
			}

			await client.query(
				'DELETE FROM campaigns WHERE id = $1 AND customer_id = $2',
				[params.id, user.customerId]
			);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[campaign-delete] failed', cause);
			return fail(500, {
				error: 'Kampagne konnte nicht gelöscht werden. Bitte versuche es erneut.',
				deleteForm: true
			});
		} finally {
			client.release();
		}

		redirect(303, '/inkassokampagnen');
	},

	status: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		const form = await request.formData();
		const status = String(form.get('status') || '');
		const callbacksConfirmed = form.get('confirmCallbacks') === 'true';
		if (!['active', 'paused'].includes(status)) return fail(400, { error: 'Ungültiger Kampagnenstatus.' });
		if (status === 'active' && CALLING_TEMPORARILY_DISABLED) {
			return fail(503, { error: 'Anrufe sind vorübergehend nicht verfügbar. Die Kampagne kann aktuell nicht gestartet oder fortgesetzt werden.' });
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const campaignResult = await client.query<{ status: string; is_demo: boolean; pause_reason: string | null }>(
				`SELECT status, is_demo, pause_reason FROM campaigns
				  WHERE id = $1 AND customer_id = $2
				  FOR UPDATE`,
				[params.id, user.customerId]
			);
			const campaign = campaignResult.rows[0];
			const previousStatus = campaign?.status;
			if (!previousStatus) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Kampagne nicht gefunden.' });
			}
			if (status === 'active') {
				const limitResult = await client.query<{ max_minutes: number | null; used_seconds: string }>(
					`WITH configured AS (
					   SELECT max_minutes FROM organization_monthly_call_limits
					    WHERE customer_id = $1
					      AND effective_month <= date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date
					    ORDER BY effective_month DESC LIMIT 1
					 )
					 SELECT configured.max_minutes,
					        COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - connected_at))) FILTER (
					          WHERE connected_at IS NOT NULL AND ended_at IS NOT NULL AND duration_source <> 'legacy_unknown'
					        ), 0)::text AS used_seconds
					   FROM configured LEFT JOIN call_attempts ON customer_id = $1
					    AND started_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'
					  GROUP BY configured.max_minutes`,
					[user.customerId]
				);
				const limit = limitResult.rows[0];
				if (limit?.max_minutes != null && Number(limit.used_seconds) >= limit.max_minutes * 60) {
					await client.query('ROLLBACK');
					return fail(409, { error: 'Das monatliche Minutenlimit ist erreicht. Erhöhe oder deaktiviere es unter Einstellungen.' });
				}
			}
			const validTransition =
				(status === 'active' && ['draft', 'paused'].includes(previousStatus)) ||
				(status === 'paused' && previousStatus === 'active');
			if (!validTransition) {
				await client.query('ROLLBACK');
				return fail(409, { error: 'Dieser Statuswechsel ist nicht möglich.' });
			}

			if (status === 'paused' && !callbacksConfirmed) {
				const callbackResult = await client.query<{ callback_count: string }>(
					`SELECT COUNT(*)::text AS callback_count
					   FROM campaign_jobs
					  WHERE campaign_id = $1 AND customer_id = $2
					    AND job_kind = 'callback' AND status IN ('pending', 'processing')`,
					[params.id, user.customerId]
				);
				const callbackCount = Number(callbackResult.rows[0]?.callback_count || 0);
				if (callbackCount > 0) {
					await client.query('ROLLBACK');
					return fail(409, {
						error: callbackCount === 1
							? 'In dieser Kampagne ist noch ein Rückruf offen.'
							: `In dieser Kampagne sind noch ${callbackCount} Rückrufe offen.`,
						pauseForm: true,
						callbackCount
					});
				}
			}

			if (previousStatus === 'draft' && status === 'active') {
				await client.query(
					`UPDATE campaign_members
					    SET status = 'scheduled', next_contact_at = NOW(), updated_at = NOW()
					  WHERE campaign_id = $1 AND customer_id = $2 AND status = 'pending'`,
					[params.id, user.customerId]
				);
				await client.query(
					`INSERT INTO campaign_jobs (
						customer_id, campaign_id, member_id, attempt_number, scheduled_at
					 )
					 SELECT cm.customer_id, cm.campaign_id, cm.id, 1, NOW()
					   FROM campaign_members cm
					  WHERE cm.campaign_id = $1 AND cm.customer_id = $2
					    AND cm.status = 'scheduled'
					 ON CONFLICT (member_id, attempt_number) DO NOTHING`,
					[params.id, user.customerId]
				);
			}
			if (previousStatus === 'paused' && status === 'active' && campaign.is_demo) {
				await client.query(
					`UPDATE campaign_jobs
					    SET scheduled_at = NOW(), locked_at = NULL, last_error = NULL
					  WHERE campaign_id = $1 AND customer_id = $2
					    AND status = 'pending' AND job_kind = 'campaign_attempt'`,
					[params.id, user.customerId]
				);
				await client.query(
					`UPDATE campaign_members cm
					    SET status = 'scheduled', next_contact_at = NOW(), last_error = NULL, updated_at = NOW()
					  WHERE cm.campaign_id = $1 AND cm.customer_id = $2
					    AND EXISTS (
					        SELECT 1 FROM campaign_jobs job
					         WHERE job.member_id = cm.id AND job.customer_id = cm.customer_id
					           AND job.status = 'pending' AND job.job_kind = 'campaign_attempt'
					    )`,
					[params.id, user.customerId]
				);
			}

			await client.query(
				`UPDATE campaigns
				    SET status = $1,
				        pause_reason = NULL, limit_pause_month = NULL,
				        started_at = CASE WHEN $1 = 'active' THEN COALESCE(started_at, NOW()) ELSE started_at END,
				        paused_at = CASE WHEN $1 = 'paused' THEN NOW() ELSE NULL END,
				        updated_at = NOW()
				  WHERE id = $2 AND customer_id = $3`,
				[status, params.id, user.customerId]
			);
			const eventKind = previousStatus === 'draft' ? 'campaign_started' : `campaign_${status}`;
			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, actor, kind, data)
				 VALUES ($1, $2, $3, $4, $5)`,
				[user.customerId, params.id, `platform_user:${user.id}`, eventKind, JSON.stringify({})]
			);
			await client.query('COMMIT');
			return {
				success: previousStatus === 'draft'
					? 'Kampagne gestartet. Anrufe beginnen automatisch innerhalb des festgelegten Zeitfensters.'
					: status === 'active' && campaign.is_demo
						? 'Demo-Kampagne fortgesetzt. Der erneute Anruf wird sofort gestartet.'
						: status === 'active' ? 'Kampagne fortgesetzt.' : 'Kampagne pausiert.'
			};
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[campaign-status] failed', cause);
			return fail(500, { error: 'Kampagnenstatus konnte nicht geändert werden.' });
		} finally {
			client.release();
		}
	},

	payment: async ({ params, locals, request }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Schreibberechtigung.' });
		const form = await request.formData();
		const caseId = Number(form.get('caseId'));
		const amount = parseAmount(form.get('amount'));
		const paidAt = String(form.get('paidAt') || '');
		const note = String(form.get('note') || '').trim().slice(0, 500);
		const paidDate = new Date(`${paidAt}T00:00:00Z`);
		const validPaidDate = !Number.isNaN(paidDate.getTime()) && paidDate.toISOString().slice(0, 10) === paidAt;
		if (!Number.isInteger(caseId) || !Number.isFinite(amount) || amount <= 0 || !validPaidDate) {
			return fail(400, { error: 'Bitte Kontakt, Betrag und Zahlungsdatum prüfen.' });
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const memberResult = await client.query<{ member_id: string; outstanding_cents: number }>(
				`SELECT cm.id::text AS member_id, c.amount_cents_outstanding AS outstanding_cents
				   FROM campaign_members cm
				   JOIN cases c ON c.id = cm.case_id AND c.customer_id = cm.customer_id
				  WHERE cm.campaign_id = $1 AND cm.case_id = $2
				    AND cm.customer_id = $3
				  FOR UPDATE OF cm, c`,
				[params.id, caseId, user.customerId]
			);
			if (!memberResult.rows[0]) {
				await client.query('ROLLBACK');
				return fail(404, { error: 'Kontakt gehört nicht zu dieser Kampagne.' });
			}
			const cents = Math.round(amount * 100);
			if (cents > memberResult.rows[0].outstanding_cents) {
				await client.query('ROLLBACK');
				return fail(400, { error: 'Der Betrag ist höher als die offene Forderung.' });
			}
			await client.query(
				`INSERT INTO payments (customer_id, campaign_id, case_id, amount_cents, paid_at, note, created_by)
				 VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
				[user.customerId, params.id, caseId, cents, paidAt, note || null, user.id]
			);
			await client.query(
				`UPDATE cases
				    SET amount_cents_outstanding = GREATEST(0, amount_cents_outstanding - $1),
				        updated_at = NOW()
				  WHERE id = $2 AND customer_id = $3`,
				[cents, caseId, user.customerId]
			);
			await client.query(
				`UPDATE campaign_members
				    SET status = CASE WHEN $2 THEN 'resolved' ELSE status END,
				        resolved_at = CASE WHEN $2 THEN NOW() ELSE resolved_at END,
				        updated_at = NOW()
				  WHERE id = $1`,
				[memberResult.rows[0].member_id, cents === memberResult.rows[0].outstanding_cents]
			);
			if (cents === memberResult.rows[0].outstanding_cents) {
				await client.query(
					`UPDATE campaign_jobs
					    SET status = 'cancelled', completed_at = NOW(), last_error = 'payment_recorded'
					  WHERE member_id = $1 AND status = 'pending'`,
					[memberResult.rows[0].member_id]
				);
				await client.query(
					`INSERT INTO case_state (case_id, state, substate, updated_at)
					 VALUES ($1, 'PAID', 'manual_payment', NOW())
					 ON CONFLICT (case_id) DO UPDATE
					     SET state = 'PAID', substate = 'manual_payment', updated_at = NOW()`,
					[caseId]
				);
				await client.query(
					`UPDATE platform_tasks
					    SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(),
					        assigned_to = COALESCE(assigned_to, $3)
					  WHERE customer_id = $1 AND case_id = $2
					    AND status IN ('open', 'in_progress')`,
					[user.customerId, caseId, user.id]
				);
			}
			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, member_id, actor, kind, data)
				 VALUES ($1, $2, $3, $4, 'payment_recorded', $5)`,
				[user.customerId, params.id, memberResult.rows[0].member_id,
					`platform_user:${user.id}`, JSON.stringify({ amount_cents: cents, paid_at: paidAt })]
			);
			await client.query(
				`UPDATE campaigns ca
				    SET status = 'completed', completed_at = NOW(), updated_at = NOW()
				  WHERE ca.id = $1 AND ca.customer_id = $2
				    AND ca.status IN ('active', 'paused')
				    AND NOT EXISTS (
				        SELECT 1 FROM campaign_members cm
				         WHERE cm.campaign_id = ca.id
				           AND cm.status IN ('pending', 'scheduled', 'contacting')
				    )`,
				[params.id, user.customerId]
			);
			await client.query('COMMIT');
			return { success: 'Zahlung wurde erfasst.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[manual-payment] failed', cause);
			return fail(500, { error: 'Zahlung konnte nicht gespeichert werden.' });
		} finally {
			client.release();
		}
	}
};
