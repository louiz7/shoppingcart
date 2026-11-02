import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getPlatformNavigation } from '$lib/server/platform-data';
import type { Actions, PageServerLoad } from './$types';

const OVERAGE_CENTS_PER_MINUTE = 50;

function assertRescovaAdmin(user: NonNullable<App.Locals['user']>): void {
	if (user.role !== 'admin' || !user.isRescovaAdminOrganization) {
		error(403, 'Diese Übersicht ist nur für die Rescova-Administration verfügbar.');
	}
}

function minutes(seconds: string): string {
	return (Number(seconds) / 60).toLocaleString('de-DE', {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2
	});
}

function monthLabel(month: string): string {
	return new Intl.DateTimeFormat('de-DE', {
		month: 'long', year: 'numeric', timeZone: 'Europe/Berlin'
	}).format(new Date(`${month}T12:00:00Z`));
}

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	assertRescovaAdmin(user);
	if (!/^\d+$/.test(params.id)) error(404, 'Organisation nicht gefunden.');

	const customerId = Number(params.id);
	const [organizationResult, monthlyResult, voiceResult] = await Promise.all([
		db.query<{
			id: number; name: string; email: string; is_active: boolean;
			account_count: string; active_account_count: string;
			total_seconds: string; call_count: string; connected_call_count: string;
		}>(
			`SELECT customer.id, customer.name, customer.email, customer.is_active,
			        COUNT(DISTINCT platform_user.id)::text AS account_count,
			        COUNT(DISTINCT platform_user.id) FILTER (WHERE platform_user.active)::text AS active_account_count,
			        COALESCE(calls.total_seconds, 0)::text AS total_seconds,
			        COALESCE(calls.call_count, 0)::text AS call_count,
			        COALESCE(calls.connected_call_count, 0)::text AS connected_call_count
			   FROM customers customer
			   LEFT JOIN platform_users platform_user ON platform_user.customer_id = customer.id
			   LEFT JOIN LATERAL (
			     SELECT COUNT(*) AS call_count,
			            COUNT(*) FILTER (WHERE attempt.connected_at IS NOT NULL) AS connected_call_count,
			            COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
			              WHERE attempt.connected_at IS NOT NULL AND attempt.ended_at IS NOT NULL
			                AND attempt.duration_source <> 'legacy_unknown'
			            ), 0) AS total_seconds
			       FROM call_attempts attempt
			      WHERE attempt.customer_id = customer.id
			   ) calls ON TRUE
			  WHERE customer.id = $1
			  GROUP BY customer.id, calls.total_seconds, calls.call_count, calls.connected_call_count`,
			[customerId]
		),
		db.query<{
			usage_month: string; call_count: string; connected_call_count: string; total_seconds: string;
			included_minutes: number | null;
		}>(
			`WITH organization_months AS (
			   SELECT month_start::date AS usage_month
			     FROM customers customer
			     CROSS JOIN LATERAL generate_series(
			       date_trunc('month', customer.created_at AT TIME ZONE 'Europe/Berlin'),
			       date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin'),
			       INTERVAL '1 month'
			     ) month_start
			    WHERE customer.id = $1
			 ), monthly_calls AS (
			   SELECT date_trunc('month', attempt.started_at AT TIME ZONE 'Europe/Berlin')::date AS usage_month,
			          COUNT(*) AS call_count,
			          COUNT(*) FILTER (WHERE attempt.connected_at IS NOT NULL) AS connected_call_count,
			          COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
			            WHERE attempt.connected_at IS NOT NULL AND attempt.ended_at IS NOT NULL
			              AND attempt.duration_source <> 'legacy_unknown'
			          ), 0) AS total_seconds
			     FROM call_attempts attempt
			    WHERE attempt.customer_id = $1
			    GROUP BY date_trunc('month', attempt.started_at AT TIME ZONE 'Europe/Berlin')::date
			 )
			 SELECT organization_months.usage_month::text,
			        COALESCE(monthly_calls.call_count, 0)::text AS call_count,
			        COALESCE(monthly_calls.connected_call_count, 0)::text AS connected_call_count,
			        COALESCE(monthly_calls.total_seconds, 0)::text AS total_seconds,
			        allowance.included_minutes
			   FROM organization_months
			   LEFT JOIN monthly_calls USING (usage_month)
			   LEFT JOIN LATERAL (
			     SELECT configured.included_minutes
			       FROM organization_minute_allowances configured
			      WHERE configured.customer_id = $1
			        AND configured.effective_month <= organization_months.usage_month
			      ORDER BY configured.effective_month DESC
			      LIMIT 1
			   ) allowance ON TRUE
			  ORDER BY organization_months.usage_month DESC`,
			[customerId]
		),
		db.query<{
			display_name: string; prompt_instructions: string; enabled: boolean;
		}>(
			`SELECT display_name, prompt_instructions, enabled
			   FROM organization_voice_config
			  WHERE customer_id = $1`,
			[customerId]
		)
	]);

	const row = organizationResult.rows[0];
	if (!row) error(404, 'Organisation nicht gefunden.');
	const currentMonth = new Intl.DateTimeFormat('sv-SE', {
		year: 'numeric', month: '2-digit', timeZone: 'Europe/Berlin'
	}).format(new Date());

	const monthlyUsage = monthlyResult.rows.map((month) => {
		const totalSeconds = Number(month.total_seconds);
		const overageSeconds = month.included_minutes === null
			? 0
			: Math.max(0, totalSeconds - month.included_minutes * 60);
		const overageMinutes = overageSeconds / 60;
		const overageRevenueCents = Math.round(overageMinutes * OVERAGE_CENTS_PER_MINUTE);
		return {
			month: month.usage_month.slice(0, 7),
			label: monthLabel(month.usage_month),
			minutes: minutes(month.total_seconds),
			calls: Number(month.call_count),
			connectedCalls: Number(month.connected_call_count),
			current: month.usage_month.slice(0, 7) === currentMonth,
			includedMinutes: month.included_minutes,
			overageMinutes: overageMinutes.toLocaleString('de-DE', { maximumFractionDigits: 2 }),
			overageRevenue: new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })
				.format(overageRevenueCents / 100),
			hasOverage: overageSeconds > 0
		};
	});
	const currentUsage = monthlyUsage.find((month) => month.current)!;

	return {
		...getPlatformNavigation(),
		organization: {
			id: row.id,
			name: row.name,
			email: row.email,
			active: row.is_active,
			accounts: Number(row.account_count),
			activeAccounts: Number(row.active_account_count),
			totalMinutes: minutes(row.total_seconds),
			calls: Number(row.call_count),
			connectedCalls: Number(row.connected_call_count)
		},
		voiceConfig: voiceResult.rows[0]
			? {
				configured: true,
				displayName: voiceResult.rows[0].display_name,
				promptInstructions: voiceResult.rows[0].prompt_instructions,
				enabled: voiceResult.rows[0].enabled
			}
			: {
				configured: false,
				displayName: row.name,
				promptInstructions: '',
				enabled: false
			},
		currentUsage,
		monthlyUsage,
		overagePrice: '0,50 €'
	};
};

export const actions: Actions = {
	setVoiceConfig: async ({ locals, params, request }) => {
		const user = locals.user!;
		assertRescovaAdmin(user);
		if (!/^\d+$/.test(params.id)) error(404, 'Organisation nicht gefunden.');

		const form = await request.formData();
		const rawDisplayName = String(form.get('displayName') || '').trim();
		const displayName = rawDisplayName.replace(/ +/g, ' ');
		const promptInstructions = String(form.get('promptInstructions') || '').trim();
		const enabled = form.get('enabled') === 'true';
		if (/[\u0000-\u001f\u007f]/.test(rawDisplayName) || /rescova/i.test(displayName) ||
			displayName.length < 2 || displayName.length > 160 ||
			!/^[\p{L}\p{N} .,&+'()\/-]+$/u.test(displayName)) {
			return fail(400, { voiceConfigError: 'Bitte einen gültigen Kundennamen mit 2 bis 160 Zeichen eingeben. Der Plattformname darf nicht verwendet werden.' });
		}
		if (promptInstructions.length > 10_000) {
			return fail(400, { voiceConfigError: 'Die Zusatzanweisungen dürfen höchstens 10.000 Zeichen enthalten.' });
		}
		if (/rescova/i.test(promptInstructions)) {
			return fail(400, { voiceConfigError: 'Der Plattformname darf in hörbaren Agent-Anweisungen nicht verwendet werden.' });
		}

		const saved = await db.query(
			`INSERT INTO organization_voice_config (
				customer_id, display_name, prompt_instructions, enabled, updated_by
			 )
			 SELECT customer.id, $2, $3, $4, $5
			   FROM customers customer
			  WHERE customer.id = $1
			 ON CONFLICT (customer_id) DO UPDATE SET
				display_name = EXCLUDED.display_name,
				prompt_instructions = EXCLUDED.prompt_instructions,
				enabled = EXCLUDED.enabled,
				updated_by = EXCLUDED.updated_by,
				updated_at = NOW()
			 RETURNING customer_id`,
			[Number(params.id), displayName, promptInstructions, enabled, user.id]
		);
		if (!saved.rows[0]) error(404, 'Organisation nicht gefunden.');
		return { voiceConfigSaved: true };
	},
	setAllowance: async ({ locals, params, request }) => {
		const user = locals.user!;
		assertRescovaAdmin(user);
		if (!/^\d+$/.test(params.id)) error(404, 'Organisation nicht gefunden.');

		const form = await request.formData();
		const rawMinutes = String(form.get('includedMinutes') || '').trim();
		if (!/^\d+$/.test(rawMinutes)) {
			return fail(400, { allowanceError: 'Bitte eine ganze, nicht negative Minutenzahl eingeben.' });
		}
		const includedMinutes = Number(rawMinutes);
		if (!Number.isSafeInteger(includedMinutes) || includedMinutes > 10_000_000) {
			return fail(400, { allowanceError: 'Das Kontingent ist außerhalb des erlaubten Bereichs.' });
		}

		const customerId = Number(params.id);
		const saved = await db.query(
			`INSERT INTO organization_minute_allowances (
			   customer_id, effective_month, included_minutes, updated_by
			 )
			 SELECT customer.id,
			        date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date,
			        $2, $3
			   FROM customers customer
			  WHERE customer.id = $1
			 ON CONFLICT (customer_id, effective_month) DO UPDATE SET
			   included_minutes = EXCLUDED.included_minutes,
			   updated_by = EXCLUDED.updated_by,
			   updated_at = NOW()
			 RETURNING included_minutes`,
			[customerId, includedMinutes, user.id]
		);
		if (!saved.rows[0]) error(404, 'Organisation nicht gefunden.');
		return { allowanceSaved: true };
	}
};
