import { db } from './db';
import { getCampaignDefaults } from './campaign-defaults';

export type TaskCategory = 'Regelkonform' | 'Sonderfall' | 'Eskalation';
export type NavigationItem = {
	label: string;
	icon: string;
	href?: string;
	requiresEmailAutomation?: boolean;
};

const navigation: NavigationItem[] = [
	{ label: 'Übersicht', icon: '/figma/icon_overview.svg', href: '/' },
	{ label: 'Aufgaben', icon: '/figma/icon_inbox.svg', href: '/postfach' },
	{ label: 'Debitoren', icon: '/figma/icon_users.svg', href: '/debitoren' },
	{ label: 'Anrufliste', icon: '/figma/icon_phone.svg', href: '/anrufliste' },
	{
		label: 'E-Mail-Assistent', icon: '/figma/campaign-message.svg', href: '/admin/email',
		requiresEmailAutomation: true
	}
];
const campaignNavigation: NavigationItem[] = [
	{ label: 'Inkassokampagnen', icon: '/figma/icon_outbound.svg', href: '/inkassokampagnen' }
];

function base() {
	return { navigation, campaignNavigation };
}

export function getPlatformNavigation() {
	return base();
}

type CampaignScope = 'all' | 'unassigned' | string;

function normalizeCampaignScope(value?: string): CampaignScope {
	if (value === 'unassigned') return value;
	return value && /^\d+$/.test(value) ? value : 'all';
}

async function getCampaignFilters(customerId: number) {
	const { rows } = await db.query<{ id: string; name: string }>(
		`SELECT id::text, name
		   FROM campaigns
		  WHERE customer_id = $1
		    AND status <> 'cancelled'
		  ORDER BY created_at DESC`,
		[customerId]
	);
	return [
		{ id: 'all', label: 'Alle' },
		...rows.map((row) => ({ id: row.id, label: row.name })),
		{ id: 'unassigned', label: 'Ohne Kampagne' }
	];
}

function money(cents: number | string | null, currency = 'EUR'): string {
	return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(Number(cents || 0) / 100);
}

function initials(name: string): string {
	return name.split(/\s+/).map((part) => part[0] || '').join('').slice(0, 2).toUpperCase();
}

function relativeTime(value: Date | string): string {
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
	if (seconds < 60) return `vor ${seconds} Sek.`;
	if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} Min.`;
	if (seconds < 86400) return `vor ${Math.floor(seconds / 3600)} Std.`;
	return `vor ${Math.floor(seconds / 86400)} Tagen`;
}

function taskCategory(kind: string, priority: string): TaskCategory {
	if (priority === 'urgent' || kind.includes('dispute') || kind.includes('escalat')) return 'Eskalation';
	if (priority === 'high') return 'Sonderfall';
	return 'Regelkonform';
}

const manualReviewReasonLabels: Record<string, string> = {
	dispute: 'Forderung bestritten',
	disputed: 'Forderung bestritten',
	already_paid: 'Zahlung bereits erfolgt',
	paid_claimed: 'Zahlung bereits erfolgt',
	wrong_person: 'Falsche Kontaktperson',
	do_not_call: 'Kein weiterer Kontakt gewünscht',
	hardship: 'Härtefall gemeldet',
	angry: 'Beschwerde gemeldet',
	requests_out_of_catalog_terms: 'Abweichende Zahlungskonditionen gewünscht',
	repeated_transcription_failure: 'Angaben konnten nicht sicher verstanden werden',
	cannot_pay_in_full: 'Vollständige Zahlung nicht möglich',
	callback_requested: 'Rückruf gewünscht',
	unspecified: 'Manuelle Klärung erforderlich'
};

function taskReason(kind: string, title: string): string {
	if (kind.startsWith('signal_')) {
		return manualReviewReasonLabels[kind.slice('signal_'.length)] || 'Manuelle Klärung erforderlich';
	}
	if (kind === 'human_escalation') {
		const reason = title.split(':').slice(1).join(':').trim();
		if (manualReviewReasonLabels[reason]) return manualReviewReasonLabels[reason];
		if (Object.values(manualReviewReasonLabels).includes(reason)) return reason;
		return 'Manuelle Klärung erforderlich';
	}
	return title;
}

async function getRecentTasks(customerId: number, campaignId?: string) {
	const { rows } = await db.query<{
		debtor_id: number; name: string; created_at: Date; title: string;
		priority: string; amount_cents_outstanding: number; kind: string;
	}>(
		`SELECT d.id AS debtor_id, d.name, t.created_at, t.title, t.priority, t.kind,
		        c.amount_cents_outstanding
		   FROM platform_tasks t
		   JOIN cases c ON c.id = t.case_id AND c.customer_id = t.customer_id
		   JOIN debtors d ON d.id = c.debtor_id AND d.customer_id = t.customer_id
		  WHERE t.customer_id = $1
		    AND t.status IN ('open', 'in_progress')
		    AND ($2::bigint IS NULL OR t.campaign_id = $2)
		  ORDER BY t.created_at DESC LIMIT 250`,
		[customerId, campaignId || null]
	);
	return rows.map((row) => ({
		debtorId: String(row.debtor_id),
		initials: initials(row.name),
		name: row.name,
		time: relativeTime(row.created_at),
		result: taskReason(row.kind, row.title),
		tone: row.priority === 'urgent' || row.priority === 'high' ? 'danger' as const : 'warning' as const,
		amount: money(row.amount_cents_outstanding)
	}));
}

export async function getDashboardOverview(customerId: number) {
	const [summaryResult, paymentsResult, tasksResult] = await Promise.all([
		db.query<{
			active_debtors: string;
			open_cents: string;
			total_cases: string;
		}>(
			`SELECT COUNT(DISTINCT c.debtor_id) FILTER (
			            WHERE COALESCE(cs.state, 'NEW') NOT IN ('PAID', 'STOPPED')
			        )::text AS active_debtors,
			        COALESCE(SUM(c.amount_cents_outstanding) FILTER (
			            WHERE COALESCE(cs.state, 'NEW') NOT IN ('PAID', 'STOPPED')
			        ), 0)::text AS open_cents,
			        COUNT(*)::text AS total_cases
			   FROM cases c
			   LEFT JOIN case_state cs ON cs.case_id = c.id
			  WHERE c.customer_id = $1`,
			[customerId]
		),
		db.query<{
			paid_7d: string; paid_30d: string; paid_ytd: string;
			cases_7d: string; cases_30d: string; cases_ytd: string;
		}>(
			`SELECT COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= NOW() - INTERVAL '7 days'), 0)::text AS paid_7d,
			        COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= NOW() - INTERVAL '30 days'), 0)::text AS paid_30d,
			        COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= DATE_TRUNC('year', NOW())), 0)::text AS paid_ytd,
			        COUNT(DISTINCT case_id) FILTER (WHERE paid_at >= NOW() - INTERVAL '7 days')::text AS cases_7d,
			        COUNT(DISTINCT case_id) FILTER (WHERE paid_at >= NOW() - INTERVAL '30 days')::text AS cases_30d,
			        COUNT(DISTINCT case_id) FILTER (WHERE paid_at >= DATE_TRUNC('year', NOW()))::text AS cases_ytd
			   FROM payments WHERE customer_id = $1`,
			[customerId]
		),
		getRecentTasks(customerId)
	]);
	const summary = summaryResult.rows[0];
	const paid = paymentsResult.rows[0];
	const recentTasks = tasksResult.slice(0, 8);
	const completion = (count: string | undefined) => {
		const total = Number(summary?.total_cases || 0);
		return `${total ? Math.round(Number(count || 0) / total * 100) : 0} %`;
	};

	return {
		...base(),
		summary: {
			activeDebtors: Number(summary?.active_debtors || 0).toLocaleString('de-DE'),
			openClaims: money(summary?.open_cents || 0)
		},
		realizedMetrics: [
			{ label: 'Letzte 7 Tage', value: money(paid?.paid_7d || 0), change: '–', changeTone: 'positive', completion: completion(paid?.cases_7d), completionChange: '–', completionTone: 'positive' },
			{ label: 'Seit Jahresbeginn (YTD)', value: money(paid?.paid_ytd || 0), change: '–', changeTone: 'positive', completion: completion(paid?.cases_ytd), completionChange: '–', completionTone: 'positive' },
			{ label: 'Letzte 30 Tage', value: money(paid?.paid_30d || 0), change: '–', changeTone: 'positive', completion: completion(paid?.cases_30d), completionChange: '–', completionTone: 'positive' }
		],
		recentTasks,
		filters: [
			{ label: 'Alle' }, { label: 'Regelkonform', icon: '/figma/tick-square.svg' },
			{ label: 'Sonderfall', icon: '/figma/danger-triangle.svg' },
			{ label: 'Eskalation', icon: '/figma/close-square.svg' }
		],
		tasks: await getTasks(customerId)
	};
}

export async function getInboxData(customerId: number, campaignId?: string) {
	return { navigation, campaignNavigation, recentTasks: await getRecentTasks(customerId, campaignId) };
}

export async function getTasks(customerId: number, category?: TaskCategory) {
	const { rows } = await db.query<{
		debtor_id: number; created_at: Date; amount_cents_outstanding: number;
		name: string; title: string; kind: string; priority: string;
	}>(
		`SELECT d.id AS debtor_id, t.created_at, c.amount_cents_outstanding,
		        d.name, t.title, t.kind, t.priority
		   FROM platform_tasks t
		   JOIN cases c ON c.id = t.case_id AND c.customer_id = t.customer_id
		   JOIN debtors d ON d.id = c.debtor_id AND d.customer_id = t.customer_id
		  WHERE t.customer_id = $1 AND t.status IN ('open', 'in_progress')
		  ORDER BY t.created_at DESC`,
		[customerId]
	);
	return rows
		.map((row) => {
			const taskCategoryValue = taskCategory(row.kind, row.priority);
			return {
				id: `#${row.debtor_id}`,
				date: new Date(row.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
				amount: money(row.amount_cents_outstanding),
				name: row.name,
				reason: taskReason(row.kind, row.title),
				suggestion: taskCategoryValue === 'Eskalation' ? 'Manuelle Prüfung' : 'Bearbeiten',
				category: taskCategoryValue,
				statusAsset: taskCategoryValue === 'Eskalation' ? '/figma/status-red.svg' :
					taskCategoryValue === 'Sonderfall' ? '/figma/status-orange.svg' : '/figma/status-green.svg'
			};
		})
		.filter((task) => !category || task.category === category);
}

export async function getDebtors(customerId: number, query = '', requestedCampaign?: string) {
	const pattern = `%${query.trim()}%`;
	const campaignScope = normalizeCampaignScope(requestedCampaign);
	const campaignId = campaignScope !== 'all' && campaignScope !== 'unassigned' ? campaignScope : null;
	const unassigned = campaignScope === 'unassigned';
	const { rows } = await db.query<{
		id: number; name: string; phone_e164: string; email: string | null;
		verification_fields: Record<string, string>; amount_cents_outstanding: string;
		due_date: string | null; invoice_number: string | null; customer_name: string;
	}>(
		`SELECT d.id, d.name, d.phone_e164, d.email, d.verification_fields,
		        COALESCE(SUM(c.amount_cents_outstanding), 0)::text AS amount_cents_outstanding,
		        MIN(c.due_date) FILTER (WHERE c.amount_cents_outstanding > 0)::text AS due_date,
		        MAX(c.invoice_number) AS invoice_number,
		        cust.name AS customer_name
		   FROM debtors d
		   JOIN customers cust ON cust.id = d.customer_id
		   LEFT JOIN cases c ON c.debtor_id = d.id AND c.customer_id = d.customer_id
		  WHERE d.customer_id = $1
		    AND ($2 = '%%' OR d.id::text = $3 OR d.name ILIKE $2 OR d.phone_e164 ILIKE $2 OR d.email ILIKE $2 OR d.external_ref ILIKE $2)
		    AND (
		      ($4::bigint IS NULL AND NOT $5::boolean)
		      OR ($4::bigint IS NOT NULL AND EXISTS (
		        SELECT 1
		          FROM cases scoped_case
		          JOIN campaign_members scoped_member
		            ON scoped_member.case_id = scoped_case.id
		           AND scoped_member.customer_id = scoped_case.customer_id
		         WHERE scoped_case.debtor_id = d.id
		           AND scoped_case.customer_id = d.customer_id
		           AND scoped_member.campaign_id = $4
		      ))
		      OR ($5::boolean AND NOT EXISTS (
		        SELECT 1
		          FROM cases scoped_case
		          JOIN campaign_members scoped_member
		            ON scoped_member.case_id = scoped_case.id
		           AND scoped_member.customer_id = scoped_case.customer_id
		         WHERE scoped_case.debtor_id = d.id
		           AND scoped_case.customer_id = d.customer_id
		      ))
		    )
		  GROUP BY d.id, cust.name
		  ORDER BY d.created_at DESC`,
		[customerId, pattern, query.trim(), campaignId, unassigned]
	);
	return rows.map((row) => ({
		id: String(row.id),
		name: row.name,
		birthdate: row.verification_fields?.dob
			? new Date(`${row.verification_fields.dob}T00:00:00Z`).toLocaleDateString('de-DE')
			: '–',
		phone: row.phone_e164,
		address: row.verification_fields?.address || '–',
		email: row.email || '–',
		amount: money(row.amount_cents_outstanding),
		dueDate: row.due_date ? new Date(row.due_date).toLocaleDateString('de-DE') : '–',
		client: row.customer_name,
		invoice: row.invoice_number || '–',
		confirmedBirthdate: Boolean(row.verification_fields?.dob)
	}));
}

export async function getDebtorDirectory(customerId: number, query = '', requestedCampaign?: string) {
	const activeCampaign = normalizeCampaignScope(requestedCampaign);
	const [debtors, campaignFilters] = await Promise.all([
		getDebtors(customerId, query, activeCampaign),
		getCampaignFilters(customerId)
	]);
	return { ...base(), query, debtors, campaignFilters, activeCampaign };
}

function callTone(outcome: string): 'yellow' | 'gray' | 'blue' | 'red' {
	if (outcome.includes('disput') || outcome.includes('wrong') || outcome.includes('escalat')) return 'red';
	if (outcome.includes('voicemail') || outcome.includes('no_answer') || outcome.includes('dial_failed') ||
		outcome === 'not_completed' || outcome === 'call_timeout' || outcome === 'ended_without_outcome') return 'gray';
	if (outcome.includes('callback')) return 'blue';
	return 'yellow';
}

const outcomeLabels: Record<string, string> = {
	payment_promised: 'Zahlung zugesagt',
	plan_agreed: 'Ratenplan vereinbart',
	paid_claimed: 'Zahlung bereits erfolgt',
	refused: 'Zahlung abgelehnt',
	no_agreement: 'Keine Vereinbarung',
	callback_scheduled: 'Rückruf vereinbart',
	wrong_person: 'Falsche Kontaktperson',
	disputed: 'Forderung bestritten',
	escalated: 'Eskalation',
	voicemail: 'Mailbox erreicht',
	no_answer: 'Nicht erreicht',
	hung_up: 'Gespräch beendet',
	dial_failed: 'Anruf fehlgeschlagen',
	call_timeout: 'Ohne Gesprächsergebnis',
	ended_without_outcome: 'Ohne Gesprächsergebnis',
	other: 'Sonstiges',
	not_completed: 'Nicht abgeschlossen'
};

function outcomeLabel(value: string | null | undefined): string {
	if (!value) return 'Ohne Gesprächsergebnis';
	return outcomeLabels[value] || 'Anruf abgeschlossen';
}

function durationLabel(seconds: number): string {
	const rounded = Math.max(0, Math.round(seconds));
	if (rounded < 60) return `${rounded} Sek.`;
	const minutes = Math.floor(rounded / 60);
	const remainingSeconds = rounded % 60;
	return remainingSeconds > 0
		? `${minutes} Min. ${remainingSeconds} Sek.`
		: `${minutes} Min.`;
}

const PLATFORM_TIMEZONE = 'Europe/Berlin';

function calendarDay(value: Date | string | number): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: PLATFORM_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(value));
	const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

function shiftedCalendarDay(value: Date | string | number, days: number): string {
	const [year, month, day] = calendarDay(value).split('-').map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const signalLabels: Record<string, string> = {
	dispute: 'Forderung bestritten',
	already_paid: 'Zahlung bereits erfolgt',
	wrong_person: 'Falsche Kontaktperson',
	do_not_call: 'Kontakt untersagt',
	hardship: 'Härtefall gemeldet',
	angry: 'Beschwerde erkannt',
	cannot_pay_in_full: 'Ratenzahlung angefragt',
	callback_requested: 'Rückruf gewünscht'
};
const criticalSignals = new Set(['dispute', 'wrong_person', 'do_not_call', 'hardship', 'angry', 'already_paid']);

function eventLabel(event: {
	kind: string;
	disposition: string | null;
	request: Record<string, unknown> | null;
	result?: Record<string, unknown> | null;
	decision: string | null;
}): string {
	if (event.kind === 'log_call_outcome') return outcomeLabel(event.disposition);
	if (event.kind === 'report_signal') {
		const signal = typeof event.request?.signal === 'string' ? event.request.signal : '';
		return signalLabels[signal] || 'Gesprächshinweis erfasst';
	}
	if (event.kind === 'schedule_callback') {
		const callbackAt = typeof event.result?.callback_at === 'string' ? new Date(event.result.callback_at) : null;
		const callbackTimezone = typeof event.result?.timezone === 'string'
			? event.result.timezone
			: PLATFORM_TIMEZONE;
		return callbackAt && !Number.isNaN(callbackAt.getTime())
			? `Rückruf vereinbart: ${callbackAt.toLocaleString('de-DE', {
				day: '2-digit', month: '2-digit', year: 'numeric',
				hour: '2-digit', minute: '2-digit', timeZone: callbackTimezone
			})} Uhr`
			: 'Rückruf vereinbart';
	}
	const labels: Record<string, string> = {
		payment_received: 'Zahlung eingegangen',
		get_case_context: 'Falldaten geprüft',
		verify_identity: 'Identität geprüft',
		get_plan_options: 'Zahlungsoptionen geprüft',
		create_payment_plan: 'Ratenplan vereinbart',
		approve_payment_plan: 'Zahlungsplan freigegeben',
		send_payment_link: 'Zahlungslink vorbereitet',
		escalate_to_human: 'Eskalation',
		mark_disputed: 'Forderung bestritten',
		callback_missed: 'Rückruf konnte nicht ausgeführt werden',
		end_call: 'Gespräch beendet',
		dial_attempt: event.decision === 'deny' ? 'Anruf nicht möglich' : 'Anruf gestartet',
		plan_template_skipped: 'Zahlungsoption nicht verfügbar'
	};
	return labels[event.kind] || 'Fallaktivität aktualisiert';
}

function eventTone(event: {
	kind: string;
	request: Record<string, unknown> | null;
	decision: string | null;
}): 'reached' | 'missed' {
	const signal = typeof event.request?.signal === 'string' ? event.request.signal : '';
	return event.decision === 'deny' ||
		event.kind === 'callback_missed' ||
		event.kind === 'escalate_to_human' ||
		event.kind === 'mark_disputed' ||
		(event.kind === 'report_signal' && criticalSignals.has(signal))
		? 'missed'
		: 'reached';
}

export async function getCallListData(customerId: number, requestedCampaign?: string) {
	const activeCampaign = normalizeCampaignScope(requestedCampaign);
	const campaignId = activeCampaign !== 'all' && activeCampaign !== 'unassigned' ? activeCampaign : null;
	const unassigned = activeCampaign === 'unassigned';
	const [{ rows }, metricsResult, campaignFilters] = await Promise.all([
		db.query<{
				started_at: Date; connected_at: Date | null; ended_at: Date | null;
				duration_source: string; outcome: string | null; disposition: string | null;
				debtor_id: number; name: string; phone_e164: string;
			}>(
				`SELECT ca.started_at, ca.connected_at, ca.ended_at, ca.duration_source,
				        ca.outcome, ca.disposition,
			        d.id AS debtor_id, d.name, d.phone_e164
			   FROM call_attempts ca
			   JOIN cases c ON c.id = ca.case_id AND c.customer_id = ca.customer_id
			   JOIN debtors d ON d.id = c.debtor_id AND d.customer_id = ca.customer_id
			  WHERE ca.customer_id = $1
			    AND (
			      ($2::bigint IS NULL AND NOT $3::boolean)
			      OR ($2::bigint IS NOT NULL AND ca.campaign_id = $2)
			      OR ($3::boolean AND ca.campaign_id IS NULL)
			    )
			  ORDER BY ca.started_at DESC LIMIT 250`,
			[customerId, campaignId, unassigned]
		),
		db.query<{
			total: string; active_cases: string; connected_calls: string;
			average_seconds: string; total_minutes: string;
		}>(
			`SELECT COUNT(*)::text AS total,
			        (SELECT COUNT(*)::text
			           FROM cases c
			           LEFT JOIN case_state cs ON cs.case_id = c.id
			          WHERE c.customer_id = $1
			            AND c.amount_cents_outstanding > 0
			            AND COALESCE(cs.state, 'NEW') NOT IN ('PAID', 'STOPPED')
			            AND (
			              ($2::bigint IS NULL AND NOT $3::boolean)
			              OR ($2::bigint IS NOT NULL AND EXISTS (
			                SELECT 1 FROM campaign_members cm
			                 WHERE cm.case_id = c.id AND cm.campaign_id = $2
			                   AND cm.customer_id = c.customer_id
			              ))
			              OR ($3::boolean AND NOT EXISTS (
			                SELECT 1 FROM campaign_members cm
			                 WHERE cm.case_id = c.id
			                   AND cm.customer_id = c.customer_id
			              ))
			            )) AS active_cases,
			        COUNT(*) FILTER (WHERE connected_at IS NOT NULL)::text AS connected_calls,
			        COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - connected_at))) FILTER (
				          WHERE connected_at IS NOT NULL AND ended_at IS NOT NULL
				            AND duration_source <> 'legacy_unknown'
				        ), 0)::int::text AS average_seconds,
				        COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - connected_at))) FILTER (
				          WHERE connected_at IS NOT NULL AND ended_at IS NOT NULL
				            AND duration_source <> 'legacy_unknown'
				        ) / 60, 0)::int::text AS total_minutes
			   FROM call_attempts
			  WHERE customer_id = $1
			    AND (
			      ($2::bigint IS NULL AND NOT $3::boolean)
			      OR ($2::bigint IS NOT NULL AND campaign_id = $2)
			      OR ($3::boolean AND campaign_id IS NULL)
			    )`,
			[customerId, campaignId, unassigned]
		),
		getCampaignFilters(customerId)
	]);
	const mapped = rows.map((row) => {
		const outcomeCode = row.disposition || row.outcome || (row.ended_at ? null : 'not_completed');
		const durationSeconds = row.connected_at && row.ended_at && row.duration_source !== 'legacy_unknown'
			? Math.max(0, Math.round((new Date(row.ended_at).getTime() - new Date(row.connected_at).getTime()) / 1000))
			: null;
		return {
			time: new Date(row.started_at).toLocaleTimeString('de-DE', {
				hour: '2-digit', minute: '2-digit', timeZone: PLATFORM_TIMEZONE
			}),
			icon: '/figma/icon_outbound2.svg',
			name: row.name,
			id: `#${row.debtor_id}`,
			phone: row.phone_e164,
			duration: durationSeconds === null ? undefined : `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`,
			outcome: outcomeLabel(outcomeCode),
			outcomeTone: callTone(outcomeCode || '')
		};
	});
	const today = calendarDay(Date.now());
	const yesterday = shiftedCalendarDay(Date.now(), -1);
	const metric = metricsResult.rows[0];
	const totalCalls = Number(metric.total);
	const connectedCalls = Number(metric.connected_calls);
	const connectionRate = totalCalls > 0 ? Math.round(connectedCalls / totalCalls * 100) : 0;
	return {
		...base(),
		campaignFilters,
		activeCampaign,
		metrics: [
			{ label: 'Anrufversuche gesamt', value: metric.total, hint: 'Alle gestarteten Wählversuche' },
			{
				label: 'Verbundene Gespräche',
				value: `${metric.connected_calls} · ${connectionRate} %`,
				hint: 'Anteil an allen Anrufversuchen'
			},
			{ label: 'Aktive Fälle', value: metric.active_cases, hint: 'Noch offene Forderungen' },
			{
				label: 'Ø Gesprächsdauer',
				value: durationLabel(Number(metric.average_seconds)),
				hint: 'Nur verbundene Gespräche'
			},
			{
				label: 'Gesprächsminuten gesamt',
				value: Number(metric.total_minutes).toLocaleString('de-DE'),
				hint: 'Nur verbundene Gespräche'
			}
		],
		todayCalls: mapped.filter((_, index) => calendarDay(rows[index].started_at) === today),
		yesterdayCalls: mapped.filter((_, index) => calendarDay(rows[index].started_at) === yesterday),
		olderCalls: mapped.filter((_, index) => {
			const day = calendarDay(rows[index].started_at);
			return day !== today && day !== yesterday;
		})
	};
}

const statusLabels: Record<string, string> = {
	draft: 'Entwurf', active: 'Aktiv', paused: 'Pausiert', completed: 'Beendet', cancelled: 'Abgebrochen',
	pending: 'Warteschlange', scheduled: 'Geplant', contacting: 'Wird angerufen', reached: 'Erreicht',
	resolved: 'Bezahlt', failed: 'Nicht erreicht', suppressed: 'Gesperrt', cancelled_member: 'Abgebrochen'
};

export async function getDebtCollectionCampaignData(customerId: number) {
	const { rows } = await db.query<{
		id: string; name: string; status: string; pause_reason: string | null; contacts: string; attempted: string;
		reached: string; received_cents: string;
	}>(
		`SELECT ca.id::text, ca.name, ca.status, ca.pause_reason,
		        COUNT(cm.id)::text AS contacts,
		        COUNT(cm.id) FILTER (WHERE cm.attempt_count > 0)::text AS attempted,
		        COUNT(cm.id) FILTER (WHERE cm.reached_at IS NOT NULL)::text AS reached,
		        COALESCE((SELECT SUM(p.amount_cents) FROM payments p
		                  WHERE p.customer_id = ca.customer_id AND p.campaign_id = ca.id), 0)::text AS received_cents
		   FROM campaigns ca
		   LEFT JOIN campaign_members cm ON cm.campaign_id = ca.id AND cm.customer_id = ca.customer_id
		  WHERE ca.customer_id = $1
		  GROUP BY ca.id
		  ORDER BY ca.created_at DESC`,
		[customerId]
	);
	return {
		...base(),
		campaigns: rows.map((row) => {
			const contacts = Number(row.contacts);
			const attempted = Number(row.attempted);
			const reached = Number(row.reached);
			return {
				id: row.id,
				name: row.name,
				contacts: contacts.toLocaleString('de-DE'),
				progress: `${contacts ? Math.round(attempted / contacts * 100) : 0} %`,
				reached: `${contacts ? Math.round(reached / contacts * 100) : 0} %`,
				received: money(row.received_cents),
				status: row.pause_reason === 'monthly_minute_limit_reached'
					? 'Minutenlimit erreicht'
					: statusLabels[row.status] || row.status,
				minuteLimitReached: row.pause_reason === 'monthly_minute_limit_reached'
			};
		})
	};
}

const weekdayLabels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

export async function getDebtCollectionCampaignDetail(customerId: number, id: string) {
	const { rows } = await db.query<{
		id: string; name: string; status: string; channels: string[]; weekdays: number[];
		is_demo: boolean;
		pause_reason: string | null;
		start_time: string; end_time: string; timezone: string; max_contact_attempts: number;
		max_attempts_per_24h: number; max_attempts_per_7d: number; retry_interval_minutes: number;
		installments_enabled: boolean; max_installments: number | null; installment_fee_pct: string;
		installment_min_cents: number; discount_enabled: boolean; discount_24h_pct: string;
		discount_7d_pct: string;
	}>('SELECT * FROM campaigns WHERE id = $1 AND customer_id = $2', [id, customerId]);
	const campaignRow = rows[0];
	if (!campaignRow) return undefined;

	const [membersResult, callsResult, paymentsResult, organizationDefaults] = await Promise.all([
			db.query<{
			id: string; case_id: number; debtor_id: number; name: string; phone_e164: string;
			status: string; attempt_count: number; reached_at: Date | null;
			amount_cents_outstanding: number; case_state: string;
			latest_disposition: string | null; latest_disconnect_reason: string | null;
			latest_sip_status_code: number | null; plan_status: string | null; callback_at: Date | null;
		}>(
			`SELECT cm.id::text, c.id AS case_id, d.id AS debtor_id, d.name, d.phone_e164,
			        cm.status, cm.attempt_count, cm.reached_at, c.amount_cents_outstanding,
			        COALESCE(cs.state, 'NEW') AS case_state,
			        latest_call.disposition AS latest_disposition,
			        latest_call.disconnect_reason AS latest_disconnect_reason,
			        latest_call.sip_status_code AS latest_sip_status_code,
			        latest_plan.status AS plan_status,
			        pending_callback.scheduled_at AS callback_at
			   FROM campaign_members cm
			   JOIN cases c ON c.id = cm.case_id AND c.customer_id = cm.customer_id
			   JOIN debtors d ON d.id = c.debtor_id AND d.customer_id = cm.customer_id
			   LEFT JOIN case_state cs ON cs.case_id = c.id
			   LEFT JOIN LATERAL (
			       SELECT ca.disposition, ca.disconnect_reason, ca.sip_status_code
			         FROM call_attempts ca
			        WHERE ca.campaign_member_id = cm.id
			          AND ca.customer_id = cm.customer_id
			          AND ca.disposition IS NOT NULL
			        ORDER BY ca.started_at DESC, ca.id DESC
			        LIMIT 1
			   ) latest_call ON TRUE
			   LEFT JOIN LATERAL (
			       SELECT pp.status
			         FROM payment_plans pp
			        WHERE pp.case_id = c.id
			          AND pp.customer_id = cm.customer_id
			          AND pp.status <> 'superseded'
			        ORDER BY pp.created_at DESC, pp.id DESC
			        LIMIT 1
			   ) latest_plan ON TRUE
			   LEFT JOIN LATERAL (
			       SELECT job.scheduled_at
			         FROM campaign_jobs job
			        WHERE job.member_id = cm.id
			          AND job.customer_id = cm.customer_id
			          AND job.job_kind = 'callback'
			          AND job.status = 'pending'
			        ORDER BY job.scheduled_at, job.id
			        LIMIT 1
			   ) pending_callback ON TRUE
			  WHERE cm.campaign_id = $1 AND cm.customer_id = $2
			  ORDER BY cm.created_at`,
			[id, customerId]
		),
		db.query<{ total: string; connected: string; voicemail: string; human: string; solutions: string }>(
				`SELECT COUNT(*)::text AS total,
				        COUNT(*) FILTER (WHERE connected_at IS NOT NULL)::text AS connected,
				        COUNT(*) FILTER (WHERE disposition = 'voicemail')::text AS voicemail,
				        COUNT(*) FILTER (
				          WHERE connected_at IS NOT NULL
				            AND disposition NOT IN ('voicemail', 'dial_failed', 'no_answer')
				            AND disposition IS NOT NULL
				        )::text AS human,
			        COUNT(*) FILTER (WHERE disposition IN ('payment_promised', 'plan_agreed'))::text AS solutions
			   FROM call_attempts WHERE campaign_id = $1 AND customer_id = $2`,
			[id, customerId]
		),
		db.query<{ received: string }>(
			'SELECT COALESCE(SUM(amount_cents), 0)::text AS received FROM payments WHERE campaign_id = $1 AND customer_id = $2',
			[id, customerId]
		),
		getCampaignDefaults(customerId)
	]);
	const members = membersResult.rows;
	const call = callsResult.rows[0];
	const totalContacts = members.length;
	const attempted = members.filter((member) => member.attempt_count > 0).length;
	const reached = members.filter((member) => member.reached_at).length;
	const pct = (value: number, total = totalContacts) => `${total ? Math.round(value / total * 100) : 0} %`;
	const totalCalls = Number(call.total);
	const campaign = {
		id: campaignRow.id,
		name: campaignRow.name,
		contacts: totalContacts.toLocaleString('de-DE'),
		progress: pct(attempted),
		reached: pct(reached),
		received: money(paymentsResult.rows[0].received),
		status: campaignRow.pause_reason === 'monthly_minute_limit_reached'
			? 'Minutenlimit erreicht'
			: statusLabels[campaignRow.status] || campaignRow.status,
		statusCode: campaignRow.status,
		minuteLimitReached: campaignRow.pause_reason === 'monthly_minute_limit_reached',
		isDemo: campaignRow.is_demo
	};
	return {
		...base(),
		campaign,
		pendingCallbackCount: members.filter((member) => member.callback_at).length,
		performance: [
			{ label: 'Ausgelöste Anrufe', value: call.total, barColor: 'rgb(255 76 0 / 0.1)' },
			{ label: 'verbundene Anrufe', value: call.connected, rate: pct(Number(call.connected), totalCalls), barColor: 'rgb(255 76 0 / 0.3)' },
			{ label: 'Anrufbeantworter', value: call.voicemail, rate: pct(Number(call.voicemail), totalCalls), barColor: 'rgb(255 76 0 / 0.5)' },
			{ label: 'menschliche Antworten', value: call.human, rate: pct(Number(call.human), totalCalls), barColor: 'rgb(255 76 0 / 0.7)' },
			{ label: 'Zahlungslösungen', value: call.solutions, rate: pct(Number(call.solutions), totalCalls), barColor: '#ff4c00' }
		],
		configuration: {
			channels: 'Telefon',
			weekdays: campaignRow.weekdays.map((day) => weekdayLabels[day]).join(', '),
			time: `${campaignRow.start_time.slice(0, 5)} bis ${campaignRow.end_time.slice(0, 5)} Uhr`,
			timezone: campaignRow.timezone,
			attempts: {
				total: campaignRow.max_contact_attempts,
				per24h: campaignRow.max_attempts_per_24h,
				per7d: campaignRow.max_attempts_per_7d,
				retryMinutes: campaignRow.retry_interval_minutes
			},
			installments: campaignRow.installments_enabled
				? `${campaignRow.max_installments} Raten, ${campaignRow.installment_fee_pct} %, ${money(campaignRow.installment_min_cents)}`
				: 'Deaktiviert',
			discount: campaignRow.discount_enabled
				? `${campaignRow.discount_24h_pct} % (24h), ${campaignRow.discount_7d_pct} % (7d)`
				: 'Deaktiviert'
		},
		editableConfiguration: {
			name: campaignRow.name,
			weekdays: campaignRow.weekdays,
			startTime: campaignRow.start_time.slice(0, 5),
			endTime: campaignRow.end_time.slice(0, 5),
			maxAttempts: campaignRow.max_contact_attempts,
			maxAttemptsPer24h: campaignRow.max_attempts_per_24h,
			maxAttemptsPer7d: campaignRow.max_attempts_per_7d,
			retryIntervalMinutes: campaignRow.retry_interval_minutes,
			installmentsEnabled: campaignRow.installments_enabled,
			maxInstallments: campaignRow.max_installments ?? 4,
			installmentFeePct: campaignRow.installment_fee_pct,
			installmentMin: campaignRow.installment_min_cents / 100,
			discountEnabled: campaignRow.discount_enabled,
			discount24h: campaignRow.discount_24h_pct,
			discount7d: campaignRow.discount_7d_pct
		},
		organizationDefaults,
		contacts: members.map((member) => ({
			caseId: String(member.case_id),
			debtorId: String(member.debtor_id),
			initials: initials(member.name),
			name: member.name,
			id: String(member.debtor_id).padStart(4, '0'),
			phone: member.phone_e164,
			status: member.case_state === 'PAID' || Number(member.amount_cents_outstanding) <= 0
				? 'Bezahlt'
				: member.plan_status === 'pending_approval'
					? 'Plan wartet auf Freigabe'
					: member.plan_status === 'approved' || member.case_state === 'PLAN_ACTIVE'
						? 'Zahlungsplan aktiv'
						: member.callback_at
							? `Rückruf am ${new Date(member.callback_at).toLocaleString('de-DE', {
								day: '2-digit', month: '2-digit',
								hour: '2-digit', minute: '2-digit', timeZone: campaignRow.timezone
							})} Uhr`
						: member.latest_disposition === 'dial_failed'
							? member.latest_sip_status_code === 603 || member.latest_disconnect_reason?.startsWith('sip_603')
								? 'Anruf vom Ziel abgewiesen (603) · erneut geplant'
								: 'Anruf nicht zugestellt · erneut geplant'
						: member.latest_disposition === 'payment_promised'
							? 'Zahlung zugesagt'
							: member.latest_disposition === 'plan_agreed'
								? 'Zahlungsplan vereinbart'
								: member.status === 'scheduled' && member.attempt_count > 0
									? 'Wird erneut angerufen'
									: member.status === 'resolved'
										? 'Erreicht'
										: statusLabels[member.status] || member.status,
			attempts: String(member.attempt_count)
		}))
	};
}

export async function getDebtorDetail(customerId: number, id: string) {
	const debtors = await getDebtors(customerId, id);
	const profile = debtors.find((debtor) => debtor.id === id);
	if (!profile) return undefined;
	const [eventsResult, planResult, tasksResult, claimsResult] = await Promise.all([
		db.query<{
				id: string; created_at: Date; kind: string; disposition: string | null;
				request: Record<string, unknown> | null; result: Record<string, unknown> | null; started_at: Date | null;
				connected_at: Date | null; ended_at: Date | null; duration_source: string | null;
			decision: string | null; case_id: string; invoice_number: string | null;
		}>(
				`SELECT id, created_at, kind, request, result, decision, case_id, invoice_number,
				        disposition, started_at, connected_at, ended_at, duration_source
			   FROM (
			     SELECT e.id::text, e.created_at, e.kind, e.request, e.result, e.decision,
			            c.id::text AS case_id, c.invoice_number,
				            ca.disposition, ca.started_at, ca.connected_at, ca.ended_at,
				            ca.duration_source,
			            ROW_NUMBER() OVER (
			              PARTITION BY c.id ORDER BY e.created_at DESC, e.id DESC
			            ) AS event_rank
			       FROM events e
			       JOIN cases c ON c.id = e.case_id
			       LEFT JOIN call_attempts ca ON ca.id = e.call_attempt_id
			      WHERE c.debtor_id = $1 AND e.customer_id = $2
			        AND (
			          e.kind IN (
			            'dial_attempt', 'create_payment_plan', 'approve_payment_plan',
			            'escalate_to_human', 'mark_disputed', 'schedule_callback',
			            'callback_missed', 'log_call_outcome', 'end_call', 'payment_received'
			          )
			          OR (
			            e.kind = 'report_signal'
			            AND e.request->>'signal' IN (
			              'dispute', 'already_paid', 'wrong_person',
			              'do_not_call', 'hardship', 'angry'
			            )
			          )
			        )
			   ) ranked
			  WHERE event_rank <= 100
			  ORDER BY created_at DESC`,
			[id, customerId]
		),
		db.query<{
			id: string; installments: number; installment_cents: number;
			first_due_date: string; discount_pct: string; status: string;
			case_id: string; invoice_number: string | null;
		}>(
			`SELECT DISTINCT ON (pp.case_id)
			        pp.id::text, pp.installments, pp.installment_cents,
			        pp.first_due_date::text, pp.discount_pct::text, pp.status,
			        c.id::text AS case_id, c.invoice_number
			   FROM payment_plans pp JOIN cases c ON c.id = pp.case_id
			  WHERE c.debtor_id = $1 AND pp.customer_id = $2
			    AND NOT c.disputed
			    AND pp.status <> 'superseded'
			  ORDER BY pp.case_id, pp.created_at DESC, pp.id DESC`,
			[id, customerId]
		),
		db.query<{ count: string }>(
			`SELECT COUNT(*)::text AS count
			   FROM platform_tasks t
			   JOIN cases c ON c.id = t.case_id AND c.customer_id = t.customer_id
			  WHERE c.debtor_id = $1 AND t.customer_id = $2
			    AND t.status IN ('open', 'in_progress')
			    AND t.kind <> 'plan_approval'`,
			[id, customerId]
		),
		db.query<{
			id: string; external_ref: string; invoice_number: string | null;
			original_amount_cents: number; amount_cents_outstanding: number; currency: string;
			due_date: string | null; disputed: boolean; state: string; campaign_names: string[];
			file_number: string | null; sub_file_number: string | null; note: string | null;
		}>(
			`SELECT c.id::text, c.external_ref, c.invoice_number, c.file_number,
			        c.sub_file_number, c.note,
			        c.original_amount_cents, c.amount_cents_outstanding, c.currency,
			        c.due_date::text, c.disputed, COALESCE(cs.state, 'NEW') AS state,
			        COALESCE(
			          array_agg(DISTINCT campaign.name ORDER BY campaign.name)
			            FILTER (WHERE campaign.id IS NOT NULL),
			          ARRAY[]::text[]
			        ) AS campaign_names
			   FROM cases c
			   LEFT JOIN case_state cs ON cs.case_id = c.id
			   LEFT JOIN campaign_members cm
			     ON cm.case_id = c.id AND cm.customer_id = c.customer_id
			   LEFT JOIN campaigns campaign
			     ON campaign.id = cm.campaign_id AND campaign.customer_id = c.customer_id
			  WHERE c.debtor_id = $1 AND c.customer_id = $2
			  GROUP BY c.id, cs.state
			  ORDER BY (c.amount_cents_outstanding > 0) DESC,
			           c.due_date NULLS LAST, c.created_at DESC`,
			[id, customerId]
		)
	]);
	const plansByCase = new Map(planResult.rows.map((plan) => [plan.case_id, plan]));
	const baseClaims = claimsResult.rows.map((claim) => {
			let status = 'Offen';
			let tone: 'open' | 'success' | 'warning' | 'danger' = 'open';
			if (claim.amount_cents_outstanding <= 0 || claim.state === 'PAID') {
				status = 'Bezahlt';
				tone = 'success';
			} else if (claim.disputed) {
				status = 'Bestritten';
				tone = 'danger';
			} else if (claim.state === 'ESCALATED') {
				status = 'In manueller Prüfung';
				tone = 'warning';
			} else if (claim.state === 'PLAN_OFFERED') {
				status = 'Zahlungsplan in Prüfung';
				tone = 'warning';
			} else if (claim.state === 'PLAN_ACTIVE') {
				status = 'Zahlungsplan aktiv';
				tone = 'success';
			} else if (claim.state === 'STOPPED') {
				status = 'Gestoppt';
				tone = 'warning';
			}
			return {
				id: claim.id,
				reference: claim.external_ref,
				invoice: claim.invoice_number || '–',
				fileNumber: claim.file_number || '–',
				subFileNumber: claim.sub_file_number || '–',
				note: claim.note || '',
				originalAmount: money(claim.original_amount_cents, claim.currency),
				outstandingAmount: money(claim.amount_cents_outstanding, claim.currency),
				dueDate: claim.due_date ? new Date(claim.due_date).toLocaleDateString('de-DE') : '–',
				campaigns: claim.campaign_names.length > 0 ? claim.campaign_names.join(', ') : 'Ohne Kampagne',
				status,
				tone
			};
		});
	const claims = baseClaims.map((claim) => {
		const claimEvents = eventsResult.rows.filter((event) => event.case_id === claim.id);
		const outcomeEvent = claimEvents.find((event) => event.kind === 'log_call_outcome');
		const plan = plansByCase.get(claim.id);
		const startEvent = claimEvents.find((event) => event.kind === 'dial_attempt');
		const agreementEvent = claimEvents.find((event) =>
			event.kind === 'create_payment_plan' ||
			(event.kind === 'log_call_outcome' && ['plan_agreed', 'payment_promised'].includes(event.disposition || ''))
		);
		const approvalEvent = claimEvents.find((event) => event.kind === 'approve_payment_plan');
		const escalationEvent = claimEvents.find((event) =>
			event.kind === 'escalate_to_human' ||
			event.kind === 'mark_disputed' ||
			event.kind === 'report_signal'
		);
		const callbackEvent = claimEvents.find((event) =>
			event.kind === 'schedule_callback' || event.kind === 'callback_missed'
		);
		const endEvent = claimEvents.find((event) => event.kind === 'log_call_outcome') ||
			claimEvents.find((event) => event.kind === 'end_call');
		const milestones = [
			startEvent ? { event: startEvent, label: eventLabel(startEvent) } : null,
			agreementEvent ? { event: agreementEvent, label: 'Vereinbarung getroffen' } : null,
			plan && (approvalEvent || agreementEvent) ? {
				event: approvalEvent || agreementEvent!,
				label: plan.status === 'approved'
					? 'Zahlungsplan freigegeben'
					: plan.status === 'pending_approval'
						? 'Zahlungsplan wartet auf Freigabe'
						: `Zahlungsplan: ${plan.status}`
			} : null,
			callbackEvent ? { event: callbackEvent, label: eventLabel(callbackEvent) } : null,
			escalationEvent ? { event: escalationEvent, label: eventLabel(escalationEvent) } : null,
			endEvent ? { event: endEvent, label: endEvent.kind === 'log_call_outcome' ? eventLabel(endEvent) : 'Gespräch beendet' } : null
		].filter((milestone): milestone is { event: (typeof claimEvents)[number]; label: string } => Boolean(milestone))
			.sort((a, b) => new Date(a.event.created_at).getTime() - new Date(b.event.created_at).getTime())
			.slice(-5);
		return {
			...claim,
			activityCount: milestones.length,
			activities: milestones.map(({ event, label }) => {
				const tone = eventTone(event);
				return {
					time: new Date(event.created_at).toLocaleString('de-DE', {
						day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
					}),
					icon: tone === 'reached' ? '/figma/icon_outbound2.svg' : '/figma/icon_declined.svg',
					label,
					tone
				};
			}),
			summary: outcomeEvent ? {
				outcome: outcomeLabel(outcomeEvent.disposition),
				text: String(outcomeEvent.request?.summary || 'Keine Gesprächszusammenfassung vorhanden.'),
				recordingDuration: outcomeEvent.connected_at && outcomeEvent.ended_at && outcomeEvent.duration_source !== 'legacy_unknown'
					? `${Math.max(0, Math.round((new Date(outcomeEvent.ended_at).getTime() - new Date(outcomeEvent.connected_at).getTime()) / 1000))} Sek.`
					: '–'
			} : null,
			proposal: plan ? {
				id: plan.id,
				solution: plan.installments === 1
					? Number(plan.discount_pct) > 0
						? `Einmalzahlung mit ${Number(plan.discount_pct).toLocaleString('de-DE')} % Nachlass`
						: 'Einmalzahlung'
					: 'Ratenplan',
				installments: String(plan.installments),
				monthlyRate: money(plan.installment_cents),
				firstInstallment: new Date(plan.first_due_date).toLocaleDateString('de-DE'),
				statusCode: plan.status,
				status: plan.status === 'approved'
					? 'Freigegeben'
					: plan.status === 'pending_approval'
						? 'Freigabe ausstehend'
						: plan.status
			} : null
		};
	});
	return {
		...base(),
		profile,
		claims,
		openTaskCount: Number(tasksResult.rows[0].count)
	};
}
