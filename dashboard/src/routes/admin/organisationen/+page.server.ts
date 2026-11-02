import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { error, fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getPlatformNavigation } from '$lib/server/platform-data';
import type { Actions, PageServerLoad } from './$types';

const scrypt = promisify(scryptCallback);

function assertRescovaAdmin(user: NonNullable<App.Locals['user']>): void {
	if (user.role !== 'admin' || !user.isRescovaAdminOrganization) {
		error(403, 'Diese Übersicht ist nur für die Rescova-Administration verfügbar.');
	}
}

async function passwordHash(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = await scrypt(password, salt, 64) as Buffer;
	return `scrypt$v1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function validEmail(value: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

type OrganizationRow = {
	id: number;
	name: string;
	email: string;
	is_active: boolean;
	created_at: Date;
	account_count: string;
	active_account_count: string;
	call_count: string;
	total_seconds: string;
	seconds_30d: string;
};

function minutes(seconds: string): string {
	return (Number(seconds) / 60).toLocaleString('de-DE', {
		minimumFractionDigits: 0,
		maximumFractionDigits: 2
	});
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	assertRescovaAdmin(user);

	const { rows } = await db.query<OrganizationRow>(
		`SELECT customer.id,
		        customer.name,
		        customer.email,
		        customer.is_active,
		        customer.created_at,
		        COALESCE(accounts.account_count, 0)::text AS account_count,
		        COALESCE(accounts.active_account_count, 0)::text AS active_account_count,
		        COALESCE(calls.call_count, 0)::text AS call_count,
		        COALESCE(calls.total_seconds, 0)::text AS total_seconds,
		        COALESCE(calls.seconds_30d, 0)::text AS seconds_30d
		   FROM customers customer
		   LEFT JOIN LATERAL (
		     SELECT COUNT(*) AS account_count,
		            COUNT(*) FILTER (WHERE platform_user.active) AS active_account_count
		       FROM platform_users platform_user
		      WHERE platform_user.customer_id = customer.id
		   ) accounts ON TRUE
		   LEFT JOIN LATERAL (
		     SELECT COUNT(*) AS call_count,
		            COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
		              WHERE attempt.connected_at IS NOT NULL
		                AND attempt.ended_at IS NOT NULL
		                AND attempt.duration_source <> 'legacy_unknown'
		            ), 0) AS total_seconds,
		            COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
		              WHERE attempt.connected_at IS NOT NULL
		                AND attempt.ended_at IS NOT NULL
		                AND attempt.duration_source <> 'legacy_unknown'
		                AND attempt.started_at >= NOW() - INTERVAL '30 days'
		            ), 0) AS seconds_30d
		       FROM call_attempts attempt
		      WHERE attempt.customer_id = customer.id
		   ) calls ON TRUE
		  ORDER BY customer.name ASC, customer.id ASC`
	);

	const organizations = rows.map((row) => ({
		id: row.id,
		name: row.name,
		email: row.email,
		active: row.is_active,
		createdAt: row.created_at.toISOString(),
		accounts: Number(row.account_count),
		activeAccounts: Number(row.active_account_count),
		calls: Number(row.call_count),
		totalMinutes: minutes(row.total_seconds),
		minutes30d: minutes(row.seconds_30d),
		totalSeconds: Number(row.total_seconds)
	}));

	return {
		...getPlatformNavigation(),
		summary: {
			organizations: organizations.length,
			activeOrganizations: organizations.filter((organization) => organization.active).length,
			accounts: organizations.reduce((sum, organization) => sum + organization.accounts, 0),
			totalMinutes: minutes(String(organizations.reduce((sum, organization) => sum + organization.totalSeconds, 0)))
		},
		organizations
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const user = locals.user!;
		assertRescovaAdmin(user);
		const form = await request.formData();
		const organizationName = String(form.get('organizationName') || '').trim().slice(0, 160);
		const organizationEmail = String(form.get('organizationEmail') || '').trim().toLowerCase();
		const adminName = String(form.get('adminName') || '').trim().slice(0, 120);
		const adminEmail = String(form.get('adminEmail') || '').trim().toLowerCase();
		const password = String(form.get('password') || '');
		const emailAutomationEnabled = form.get('emailAutomationEnabled') === 'on';
		const values = { organizationName, organizationEmail, adminName, adminEmail, emailAutomationEnabled };

		if (organizationName.length < 2 || !validEmail(organizationEmail) || !adminName ||
			!validEmail(adminEmail) || password.length < 12) {
			return fail(400, {
				createError: 'Bitte alle Felder gültig ausfüllen. Das Passwort muss mindestens 12 Zeichen haben.',
				...values
			});
		}

		const client = await db.connect();
		let organizationId: number;
		try {
			await client.query('BEGIN');
			const organization = await client.query<{ id: number }>(
				`INSERT INTO customers (name, email, webhook_token, email_automation_enabled)
				 VALUES ($1, $2, $3, $4)
				 RETURNING id`,
				[organizationName, organizationEmail, randomBytes(24).toString('base64url'), emailAutomationEnabled]
			);
			organizationId = organization.rows[0].id;
			await client.query(
				`INSERT INTO platform_users (customer_id, email, display_name, password_hash, role)
				 VALUES ($1, $2, $3, $4, 'admin')`,
				[organizationId, adminEmail, adminName, await passwordHash(password)]
			);
			await client.query(
				`INSERT INTO events (customer_id, actor, channel, kind, request, result, decision)
				 VALUES ($1, $2, 'platform', 'organization_created', $3, $4, 'allow')`,
				[
					organizationId,
					`platform_user:${user.id}`,
					JSON.stringify({
						organization_name: organizationName,
						organization_email: organizationEmail,
						email_automation_enabled: emailAutomationEnabled
					}),
					JSON.stringify({ initial_admin_email: adminEmail })
				]
			);
			await client.query('COMMIT');
		} catch (cause) {
			await client.query('ROLLBACK');
			const code = typeof cause === 'object' && cause && 'code' in cause ? String(cause.code) : '';
			if (code === '23505') {
				return fail(409, {
					createError: 'Die Organisations- oder Admin-E-Mail-Adresse wird bereits verwendet.',
					...values
				});
			}
			console.error('[organization-create] failed', cause);
			return fail(500, { createError: 'Organisation konnte nicht angelegt werden.', ...values });
		} finally {
			client.release();
		}

		redirect(303, `/admin/organisationen/${organizationId!}`);
	}
};
