import { createHash, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { error, fail, type Actions } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getPlatformNavigation } from '$lib/server/platform-data';
import { getCampaignDefaults } from '$lib/server/campaign-defaults';
import type { PageServerLoad } from './$types';

const scrypt = promisify(scryptCallback);
const roles = new Set(['admin', 'operator', 'viewer']);
const MAX_ORGANIZATION_FILE_SIZE = 25 * 1024 * 1024;

function isBfiOrganization(name: string): boolean {
	return /^bfi(?:\s+inkasso)?(?:\s|$)/i.test(name.trim());
}

function safeFilename(name: string): string {
	const filename = name.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
	return (filename || 'datei').slice(0, 255);
}

async function passwordHash(password: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = await scrypt(password, salt, 64) as Buffer;
	return `scrypt$v1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	if (user.role !== 'admin') error(403, 'Nur Administratoren dürfen Benutzer verwalten.');
	const [{ rows }, campaignDefaults, limitResult, organizationResult] = await Promise.all([db.query<{
		id: string; email: string; display_name: string; role: string; active: boolean; created_at: Date;
	}>(
		`SELECT id::text, email, display_name, role, active, created_at
		   FROM platform_users
		  WHERE customer_id = $1
		  ORDER BY created_at`,
		[user.customerId]
	), getCampaignDefaults(user.customerId), db.query<{
		max_minutes: number | null; used_seconds: string;
	}>(
		`WITH configured AS (
		   SELECT max_minutes FROM organization_monthly_call_limits
		    WHERE customer_id = $1
		      AND effective_month <= date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date
		    ORDER BY effective_month DESC LIMIT 1
		 )
		 SELECT configured.max_minutes,
		        COALESCE(SUM(EXTRACT(EPOCH FROM (attempt.ended_at - attempt.connected_at))) FILTER (
		          WHERE attempt.connected_at IS NOT NULL AND attempt.ended_at IS NOT NULL
		            AND attempt.duration_source <> 'legacy_unknown'
		        ), 0)::text AS used_seconds
		   FROM configured
		   LEFT JOIN call_attempts attempt ON attempt.customer_id = $1
		    AND attempt.started_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'
		  GROUP BY configured.max_minutes`,
		[user.customerId]
	), db.query<{ name: string }>('SELECT name FROM customers WHERE id = $1', [user.customerId])]);
	const limit = limitResult.rows[0];
	const organizationName = organizationResult.rows[0]?.name || '';
	const organizationFilesEnabled = isBfiOrganization(organizationName);
	const organizationFiles = organizationFilesEnabled
		? (await db.query<{
			id: string; original_filename: string; content_type: string; size_bytes: number;
			created_at: Date; uploaded_by_name: string | null;
		}>(
			`SELECT file.id::text, file.original_filename, file.content_type, file.size_bytes,
			        file.created_at, uploader.display_name AS uploaded_by_name
			   FROM organization_files file
			   LEFT JOIN platform_users uploader ON uploader.id = file.uploaded_by
			  WHERE file.customer_id = $1
			  ORDER BY file.created_at DESC`,
			[user.customerId]
		)).rows.map((file) => ({
			id: file.id,
			name: file.original_filename,
			contentType: file.content_type,
			size: file.size_bytes,
			uploadedBy: file.uploaded_by_name || 'Ehemaliger Benutzer',
			createdAt: new Date(file.created_at).toLocaleString('de-DE')
		}))
		: [];
	return {
		...getPlatformNavigation(),
		organizationFilesEnabled,
		organizationFiles,
		campaignDefaults,
		monthlyCallLimit: {
			maxMinutes: limit?.max_minutes ?? null,
			usedMinutes: Math.round((Number(limit?.used_seconds || 0) / 60) * 100) / 100,
			reached: limit?.max_minutes != null && Number(limit.used_seconds) >= limit.max_minutes * 60
		},
		users: rows.map((row) => ({
			id: row.id,
			email: row.email,
			displayName: row.display_name,
			role: row.role,
			active: row.active,
			createdAt: new Date(row.created_at).toLocaleDateString('de-DE')
		}))
	};
};

export const actions: Actions = {
	organizationFile: async ({ request, locals }) => {
		const admin = locals.user!;
		if (admin.role !== 'admin') return fail(403, { fileUploadError: 'Keine Administratorberechtigung.' });

		const organization = await db.query<{ name: string }>('SELECT name FROM customers WHERE id = $1', [admin.customerId]);
		if (!isBfiOrganization(organization.rows[0]?.name || '')) {
			return fail(403, { fileUploadError: 'Der Datei-Upload ist für diese Organisation nicht freigeschaltet.' });
		}

		const form = await request.formData();
		const upload = form.get('organizationFile');
		if (!(upload instanceof File) || upload.size === 0) {
			return fail(400, { fileUploadError: 'Bitte eine Datei auswählen.' });
		}
		if (upload.size > MAX_ORGANIZATION_FILE_SIZE) {
			return fail(413, { fileUploadError: 'Die Datei darf höchstens 25 MB groß sein.' });
		}

		try {
			const content = Buffer.from(await upload.arrayBuffer());
			await db.query(
				`INSERT INTO organization_files (
					customer_id, uploaded_by, original_filename, content_type, size_bytes, sha256, content
				 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[
					admin.customerId,
					admin.id,
					safeFilename(upload.name),
					String(upload.type || 'application/octet-stream').slice(0, 255),
					content.length,
					createHash('sha256').update(content).digest('hex'),
					content
				]
			);
			return { fileUploadSuccess: `${safeFilename(upload.name)} wurde gespeichert.` };
		} catch (cause) {
			console.error('[organization-file] upload failed', cause);
			return fail(500, { fileUploadError: 'Die Datei konnte nicht gespeichert werden.' });
		}
	},
	monthlyCallLimit: async ({ request, locals }) => {
		const admin = locals.user!;
		if (admin.role !== 'admin') return fail(403, { limitError: 'Keine Administratorberechtigung.' });
		const form = await request.formData();
		const raw = String(form.get('maxMinutes') || '').trim();
		const maxMinutes = raw === '' ? null : Number(raw);
		if (maxMinutes !== null && (!Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 10_000_000)) {
			return fail(400, { limitError: 'Bitte eine ganze Minutenzahl zwischen 1 und 10.000.000 eingeben.' });
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO organization_monthly_call_limits (customer_id, effective_month, max_minutes, updated_by)
				 VALUES ($1, date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date, $2, $3)
				 ON CONFLICT (customer_id, effective_month) DO UPDATE SET
				   max_minutes = EXCLUDED.max_minutes, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
				[admin.customerId, maxMinutes, admin.id]
			);
			const usage = await client.query<{ used_seconds: string }>(
				`SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (ended_at - connected_at))) FILTER (
				          WHERE connected_at IS NOT NULL AND ended_at IS NOT NULL AND duration_source <> 'legacy_unknown'
				        ), 0)::text AS used_seconds
				   FROM call_attempts
				  WHERE customer_id = $1
				    AND started_at >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'`,
				[admin.customerId]
			);
			const reached = maxMinutes !== null && Number(usage.rows[0]?.used_seconds || 0) >= maxMinutes * 60;
			if (reached) {
				await client.query(
					`UPDATE campaigns SET status = 'paused', pause_reason = 'monthly_minute_limit_reached',
					        limit_pause_month = date_trunc('month', NOW() AT TIME ZONE 'Europe/Berlin')::date,
					        paused_at = NOW(), updated_at = NOW()
					  WHERE customer_id = $1 AND status = 'active'`,
					[admin.customerId]
				);
			} else {
				const resumed = await client.query<{ id: string }>(
					`UPDATE campaigns SET status = 'active', pause_reason = NULL, limit_pause_month = NULL,
					        paused_at = NULL, updated_at = NOW()
					  WHERE customer_id = $1 AND status = 'paused'
					    AND pause_reason = 'monthly_minute_limit_reached'
					RETURNING id::text`,
					[admin.customerId]
				);
				if (resumed.rows.length) {
					const campaignIds = resumed.rows.map((row) => row.id);
					await client.query(
						`UPDATE campaign_jobs SET scheduled_at = NOW(), locked_at = NULL, last_error = NULL
						  WHERE status = 'pending' AND last_error = 'monthly_minute_limit_reached'
						    AND campaign_id = ANY($1::bigint[])`,
						[campaignIds]
					);
					await client.query(
						`UPDATE campaign_members member
						    SET next_contact_at = pending.next_at, last_error = NULL, updated_at = NOW()
						   FROM (SELECT member_id, MIN(scheduled_at) AS next_at FROM campaign_jobs
						          WHERE status = 'pending' AND campaign_id = ANY($1::bigint[]) GROUP BY member_id) pending
						  WHERE member.id = pending.member_id`,
						[campaignIds]
					);
				}
			}
			await client.query('COMMIT');
			return { limitSuccess: maxMinutes === null ? 'Monatliches Kostenlimit deaktiviert.' : 'Monatliches Kostenlimit gespeichert.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[monthly-call-limit] save failed', cause);
			return fail(500, { limitError: 'Monatliches Kostenlimit konnte nicht gespeichert werden.' });
		} finally {
			client.release();
		}
	},
	user: async ({ request, locals }) => {
		const admin = locals.user!;
		if (admin.role !== 'admin') return fail(403, { error: 'Keine Administratorberechtigung.' });
		const form = await request.formData();
		const email = String(form.get('email') || '').trim().toLowerCase();
		const displayName = String(form.get('displayName') || '').trim().slice(0, 120);
		const role = String(form.get('role') || '');
		const password = String(form.get('password') || '');
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !displayName || !roles.has(role) || password.length < 12) {
			return fail(400, {
				error: 'Bitte gültige Daten und ein Passwort mit mindestens 12 Zeichen eingeben.',
				email,
				displayName,
				role
			});
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const saved = await client.query<{ id: string }>(
				`INSERT INTO platform_users (customer_id, email, display_name, password_hash, role)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (customer_id, email) DO UPDATE
				     SET display_name = EXCLUDED.display_name,
				         password_hash = EXCLUDED.password_hash,
				         role = EXCLUDED.role,
				         active = TRUE,
				         updated_at = NOW()
				 RETURNING id::text`,
				[admin.customerId, email, displayName, await passwordHash(password), role]
			);
			await client.query('DELETE FROM platform_sessions WHERE user_id = $1', [saved.rows[0].id]);
			await client.query('COMMIT');
			return { success: 'Benutzer und Zugangsdaten wurden gespeichert.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[platform-users] save failed', cause);
			return fail(500, { error: 'Benutzer konnte nicht gespeichert werden.', email, displayName, role });
		} finally {
			client.release();
		}
	},
	campaignDefaults: async ({ request, locals }) => {
		const admin = locals.user!;
		if (admin.role !== 'admin') return fail(403, { settingsError: 'Keine Administratorberechtigung.' });
		const form = await request.formData();
		const weekdays = [...new Set(form.getAll('weekdays').map(Number))]
			.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
			.sort((a, b) => a - b);
		const startTime = String(form.get('startTime') || '');
		const endTime = String(form.get('endTime') || '');
		const integer = (name: string, min: number, max: number) => {
			const value = Number(form.get(name));
			return Number.isInteger(value) && value >= min && value <= max ? value : null;
		};
		const maxAttempts = integer('maxAttempts', 1, 20);
		const maxAttemptsPer24h = integer('maxAttemptsPer24h', 1, 20);
		const maxAttemptsPer7d = integer('maxAttemptsPer7d', 1, 100);
		const retryIntervalMinutes = integer('retryIntervalMinutes', 1, 10080);
		if (weekdays.length === 0 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(startTime) ||
			!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(endTime) || startTime >= endTime ||
			maxAttempts === null || maxAttemptsPer24h === null || maxAttemptsPer7d === null ||
			retryIntervalMinutes === null || maxAttemptsPer7d < maxAttemptsPer24h ||
			maxAttempts < maxAttemptsPer7d) {
			return fail(400, { settingsError: 'Es muss gelten: Versuche in 24h ≤ Versuche in 7 Tagen ≤ Kontaktversuche gesamt.' });
		}

		const client = await db.connect();
		try {
			await client.query('BEGIN');
			const before = await client.query(
				'SELECT * FROM organization_campaign_defaults WHERE customer_id = $1 FOR UPDATE',
				[admin.customerId]
			);
			const saved = await client.query(
				`INSERT INTO organization_campaign_defaults (
					customer_id, timezone, weekdays, start_time, end_time, max_contact_attempts,
					max_attempts_per_24h, max_attempts_per_7d, retry_interval_minutes, updated_by
				 ) VALUES ($1, 'Europe/Berlin', $2, $3, $4, $5, $6, $7, $8, $9)
				 ON CONFLICT (customer_id) DO UPDATE SET
					weekdays = EXCLUDED.weekdays, start_time = EXCLUDED.start_time,
					end_time = EXCLUDED.end_time, max_contact_attempts = EXCLUDED.max_contact_attempts,
					max_attempts_per_24h = EXCLUDED.max_attempts_per_24h,
					max_attempts_per_7d = EXCLUDED.max_attempts_per_7d,
					retry_interval_minutes = EXCLUDED.retry_interval_minutes,
					updated_by = EXCLUDED.updated_by, updated_at = NOW()
				 RETURNING *`,
				[admin.customerId, weekdays, startTime, endTime, maxAttempts, maxAttemptsPer24h,
					maxAttemptsPer7d, retryIntervalMinutes, admin.id]
			);
			await client.query(
				`INSERT INTO events (customer_id, actor, channel, kind, request, result, decision)
				 VALUES ($1, $2, 'platform', 'organization_campaign_defaults_updated', $3, $4, 'allow')`,
				[admin.customerId, `platform_user:${admin.id}`, JSON.stringify(before.rows[0] || null), JSON.stringify(saved.rows[0])]
			);
			await client.query('COMMIT');
			return { settingsSuccess: 'Kampagnen-Standardwerte wurden gespeichert.' };
		} catch (cause) {
			await client.query('ROLLBACK');
			console.error('[campaign-defaults] save failed', cause);
			return fail(500, { settingsError: 'Standardwerte konnten nicht gespeichert werden.' });
		} finally {
			client.release();
		}
	}
};
