import { parse } from 'csv-parse/sync';
import { readSheet } from 'read-excel-file/node';
import { fail, redirect, type Actions } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDebtCollectionCampaignData } from '$lib/server/platform-data';
import { db } from '$lib/server/db';
import { findOrCreateDebtor } from '$lib/server/debtors';
import { getCampaignDefaults } from '$lib/server/campaign-defaults';
import {
	importField,
	importPersonName,
	missingImportHeaders,
	normalizeImportHeader,
	type ImportRow
} from '$lib/campaign-import';

function normalizePhone(value: string): string | null {
	const normalized = value.replace(/[\s()/-]/g, '').replace(/^00/, '+');
	return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

function amountCents(value: string): number | null {
	const cleaned = value.replace(/[€\s]/g, '');
	const normalized = cleaned.includes(',')
		? cleaned.replace(/\./g, '').replace(',', '.')
		: cleaned;
	const amount = Number(normalized);
	return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function isoDate(value: string): string | null {
	const trimmed = value.trim();
	const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
	const germanMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
	const year = Number(isoMatch?.[1] || germanMatch?.[3]);
	const month = Number(isoMatch?.[2] || germanMatch?.[2]);
	const day = Number(isoMatch?.[3] || germanMatch?.[1]);
	if (!year || !month || !day) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function csvDelimiter(buffer: Buffer): ',' | ';' {
	const header = buffer.toString('utf8')
		.replace(/^\uFEFF/, '')
		.split(/\r?\n/)
		.find((line) => line.trim().length > 0) ?? '';
	const commas = (header.match(/,/g) || []).length;
	const semicolons = (header.match(/;/g) || []).length;
	return semicolons > commas ? ';' : ',';
}

async function parseUpload(file: File): Promise<ImportRow[]> {
	if (file.size > 10 * 1024 * 1024) throw new Error('Die Datei darf höchstens 10 MB groß sein.');
	const buffer = Buffer.from(await file.arrayBuffer());

	if (file.name.toLowerCase().endsWith('.csv')) {
		const records = parse(buffer, {
			columns: (headers: string[]) => headers.map(normalizeImportHeader),
			bom: true,
			skip_empty_lines: true,
			trim: true,
			delimiter: csvDelimiter(buffer),
			max_record_size: 100_000
		}) as ImportRow[];
		return records;
	}
	if (file.name.toLowerCase().endsWith('.xlsx')) {
		const sheet = await readSheet(buffer);
		if (sheet.length < 2) return [];
		const headers = sheet[0].map(normalizeImportHeader);
		return sheet.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => {
			const value = cells[index];
			return [header, value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '')];
		})));
	}
	throw new Error('Nur CSV- und XLSX-Dateien werden unterstützt.');
}

function intValue(form: FormData, name: string, min: number, max: number): number | null {
	const value = Number(String(form.get(name) || ''));
	return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function decimalValue(form: FormData, name: string, min: number, max: number): number | null {
	const value = Number(String(form.get(name) || '').replace(',', '.').replace(/[€%\s]/g, ''));
	return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export const load: PageServerLoad = async ({ locals }) => ({
	...(await getDebtCollectionCampaignData(locals.user!.customerId)),
	campaignDefaults: await getCampaignDefaults(locals.user!.customerId)
});

export const actions = {
	default: async ({ request, locals }) => {
		const user = locals.user!;
		if (user.role === 'viewer') return fail(403, { error: 'Keine Berechtigung zum Erstellen von Kampagnen.', fileError: false });

		const form = await request.formData();
		const name = String(form.get('campaignName') || '').trim().slice(0, 200);
		const importMode = String(form.get('importMode') || 'file');
		const upload = form.get('debtors');
		const manualContactsJson = String(form.get('manualContacts') || '');
		const manualState = importMode === 'manual' ? manualContactsJson : undefined;
		const maxAttempts = intValue(form, 'maxAttempts', 1, 20);
		const maxAttemptsPer24h = intValue(form, 'maxAttemptsPer24h', 1, 20);
		const maxAttemptsPer7d = intValue(form, 'maxAttemptsPer7d', 1, 100);
		const retryIntervalMinutes = intValue(form, 'retryIntervalMinutes', 1, 10080);
		const weekdays = form.getAll('weekdays').map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
		const startTime = String(form.get('startTime') || '');
		const endTime = String(form.get('endTime') || '');
		const installmentsEnabled = form.get('installmentsEnabled') === 'on';
		const maxInstallments = installmentsEnabled ? intValue(form, 'maxInstallments', 2, 24) : null;
		const installmentFeePct = installmentsEnabled ? decimalValue(form, 'installmentFeePct', 0, 100) : 0;
		const installmentMin = installmentsEnabled ? decimalValue(form, 'installmentMin', 0, 100_000_000) : 0;
		const discountEnabled = form.get('discountEnabled') === 'on';
		const discount24h = discountEnabled ? decimalValue(form, 'discount24h', 0, 100) : 0;
		const discount7d = discountEnabled ? decimalValue(form, 'discount7d', 0, 100) : 0;

		const hasUpload = upload instanceof File && upload.size > 0;
		if (!name || !['file', 'manual'].includes(importMode) || (importMode === 'file' && !hasUpload) || maxAttempts === null ||
			maxAttemptsPer24h === null || maxAttemptsPer7d === null || retryIntervalMinutes === null ||
			maxAttemptsPer7d < maxAttemptsPer24h || maxAttempts < maxAttemptsPer7d ||
			weekdays.length === 0 || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) ||
			startTime >= endTime || (installmentsEnabled && (maxInstallments === null || installmentFeePct === null || installmentMin === null)) ||
			(discountEnabled && (discount24h === null || discount7d === null))) {
			return fail(400, {
				error: 'Bitte prüfe alle Kampagneneinstellungen und die erfassten Kontakte.',
				fileError: importMode === 'file', manualError: importMode === 'manual', manualContacts: manualState
			});
		}

		let rawRows: ImportRow[];
		if (importMode === 'file') {
			try {
				rawRows = await parseUpload(upload as File);
			} catch (error) {
				return fail(400, {
					error: error instanceof Error ? error.message : 'Datei konnte nicht gelesen werden.',
					fileError: true, manualContacts: manualState
				});
			}
		} else {
			try {
				const contacts = JSON.parse(manualContactsJson) as unknown;
				if (!Array.isArray(contacts) || contacts.length < 1 || contacts.length > 250) throw new Error('invalid_manual_contacts');
				rawRows = contacts.map((contact) => {
					if (!contact || typeof contact !== 'object') throw new Error('invalid_manual_contact');
					const value = contact as Record<string, unknown>;
					return {
						name: String(value.name || '').slice(0, 200),
						rechnungsnummer: String(value.invoice || '').slice(0, 160),
						'e-mail-adresse': String(value.email || '').slice(0, 320),
						rechnungsbetrag: String(value.amount || '').slice(0, 40),
						telefonnummer: String(value.phone || '').slice(0, 40),
						'fälligkeitsdatum': String(value.dueDate || '').slice(0, 20),
						notiz: String(value.note || '').slice(0, 5_000)
					};
				});
			} catch {
				return fail(400, {
					error: 'Bitte füge mindestens einen gültigen Kontakt hinzu. Maximal sind 250 Kontakte möglich.',
					manualError: true, manualContacts: manualState
				});
			}
		}
		if (rawRows.length === 0 || rawRows.length > 10_000) {
			return fail(400, {
				error: importMode === 'file'
					? 'Die CSV-Datei muss zwischen 1 und 10.000 Datenzeilen enthalten.'
					: 'Bitte füge mindestens einen Kontakt hinzu.',
				fileError: importMode === 'file', manualError: importMode === 'manual', manualContacts: manualState
			});
		}
		const missing = missingImportHeaders(Object.keys(rawRows[0]));
		if (missing.length > 0) {
			return fail(400, {
				error: `Die CSV-Datei ist nicht korrekt formatiert. Fehlende Pflichtspalten: ${missing.join(', ')}.`,
				fileError: importMode === 'file', manualError: importMode === 'manual', manualContacts: manualState
			});
		}

		const validRows: {
			name: string; invoice: string; email: string; amount: number; phone: string; dueDate: string;
			fileNumber: string; subFileNumber: string; note: string;
		}[] = [];
		const errors: { row: number; message: string }[] = [];
		const seenInvoices = new Set<string>();
		rawRows.forEach((row, index) => {
			const sourceRow = index + (importMode === 'file' ? 2 : 1);
			const person = importPersonName(row);
			const parsed = {
				name: person.name,
				invoice: importField(row, 'invoice'),
				email: importField(row, 'email').toLowerCase(),
				amount: amountCents(importField(row, 'amount')),
				phone: normalizePhone(importField(row, 'phone')),
				dueDate: isoDate(importField(row, 'dueDate')),
				fileNumber: importField(row, 'fileNumber'),
				subFileNumber: importField(row, 'subFileNumber'),
				note: importField(row, 'note').slice(0, 5_000)
			};
			const rowErrors = [
				person.split && !person.firstName ? 'Vorname fehlt' : null,
				person.split && !person.lastName ? 'Nachname fehlt' : null,
				!person.split && !parsed.name ? 'Vor- und Nachname fehlt' : null,
				!parsed.invoice ? 'Rechnungsnummer fehlt' : null,
				(importMode === 'file' || parsed.email) && !parsed.email.includes('@') ? 'E-Mail-Adresse ist ungültig' : null,
				parsed.amount === null ? 'Rechnungsbetrag ist ungültig' : null,
				!parsed.phone ? 'Telefonnummer muss im internationalen Format vorliegen, z. B. +4917612345678' : null,
				!parsed.dueDate ? 'Fälligkeitsdatum muss TT.MM.JJJJ oder JJJJ-MM-TT entsprechen' : null
			].filter((message): message is string => Boolean(message));
			if (rowErrors.length > 0) {
				errors.push({ row: sourceRow, message: rowErrors.join('; ') });
			} else if (seenInvoices.has(parsed.invoice)) {
				errors.push({ row: sourceRow, message: 'Rechnungsnummer ist doppelt.' });
			} else {
				seenInvoices.add(parsed.invoice);
				validRows.push(parsed as typeof validRows[number]);
			}
		});
		if (errors.length > 0) {
			return fail(400, {
				error: `${importMode === 'file' ? 'Die CSV-Datei ist nicht korrekt formatiert.' : 'Die manuellen Kontakte sind nicht vollständig.'} ${errors.slice(0, 5).map((item) => `${importMode === 'file' ? 'Zeile' : 'Kontakt'} ${item.row}: ${item.message}`).join(' · ')}`,
				fileError: importMode === 'file', manualError: importMode === 'manual', manualContacts: manualState
			});
		}

		const policyResult = await db.query<{ max_discount_pct: string }>(
			`SELECT COALESCE(config->>'max_discount_pct', '20') AS max_discount_pct
			   FROM policy_config
			  WHERE customer_id = $1`,
			[user.customerId]
		);
		const configuredDiscountCeiling = Number(policyResult.rows[0]?.max_discount_pct ?? 20);
		const policyDiscountCeiling = Number.isFinite(configuredDiscountCeiling) ? configuredDiscountCeiling : 20;
		if (discountEnabled && Math.max(discount24h || 0, discount7d || 0) > policyDiscountCeiling) {
			return fail(400, {
				error: `Der Rabatt darf das Richtlinienlimit von ${policyDiscountCeiling} % nicht überschreiten.`,
				fileError: false, manualError: importMode === 'manual', manualContacts: manualState
			});
		}

		const client = await db.connect();
		let campaignId: string;
		try {
			await client.query('BEGIN');
			const campaignResult = await client.query<{ id: string }>(
				`INSERT INTO campaigns (
					customer_id, name, status, channels, weekdays, start_time, end_time, started_at,
					max_contact_attempts, max_attempts_per_24h, max_attempts_per_7d,
					retry_interval_minutes, installments_enabled, max_installments,
					installment_fee_pct, installment_min_cents, discount_enabled,
					discount_24h_pct, discount_7d_pct, created_by
				 ) VALUES ($1, $2, 'draft', ARRAY['voice']::text[], $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
				 RETURNING id::text`,
				[
					user.customerId, name, weekdays, startTime, endTime, maxAttempts,
					maxAttemptsPer24h, maxAttemptsPer7d, retryIntervalMinutes,
					installmentsEnabled, maxInstallments, installmentFeePct,
					Math.round((installmentMin || 0) * 100), discountEnabled,
					discount24h, discount7d, user.id
				]
			);
			campaignId = campaignResult.rows[0].id;
			const importResult = await client.query<{ id: string }>(
				`INSERT INTO campaign_imports (
					customer_id, campaign_id, filename, status, total_rows, imported_rows,
					rejected_rows, errors, created_by, completed_at
				 ) VALUES ($1, $2, $3, 'completed', $4, $4, 0, '[]'::jsonb, $5, NOW())
				 RETURNING id::text`,
				[user.customerId, campaignId, importMode === 'file' ? (upload as File).name.slice(0, 255) : 'Manuelle Erfassung', validRows.length, user.id]
			);

			for (const row of validRows) {
				const debtorId = await findOrCreateDebtor(client, {
					customerId: user.customerId,
					name: row.name,
					phone: row.phone,
					email: row.email
				});
				const caseRef = `invoice-${row.invoice}`;
				const caseResult = await client.query<{
					id: number; original_amount_cents: number; amount_cents_outstanding: number;
				}>(
					`INSERT INTO cases (
						customer_id, debtor_id, external_ref, original_amount_cents,
						amount_cents_outstanding, invoice_number, due_date, file_number,
						sub_file_number, note
					 ) VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9)
					 ON CONFLICT (customer_id, external_ref) DO UPDATE
					     SET debtor_id = EXCLUDED.debtor_id,
					         invoice_number = EXCLUDED.invoice_number,
					         due_date = EXCLUDED.due_date,
					         file_number = EXCLUDED.file_number,
					         sub_file_number = EXCLUDED.sub_file_number,
					         note = EXCLUDED.note,
					         updated_at = NOW()
					 RETURNING id, original_amount_cents, amount_cents_outstanding`,
					[
						user.customerId, debtorId, caseRef, row.amount, row.invoice, row.dueDate,
						row.fileNumber || null, row.subFileNumber || null, row.note || null
					]
				);
				if (caseResult.rows[0].original_amount_cents !== row.amount) {
					await client.query('ROLLBACK');
					return fail(409, {
						error: `Die Rechnungsnummer ${row.invoice} existiert bereits mit einem anderen Betrag.`,
						fileError: false, manualError: importMode === 'manual', manualContacts: manualState
					});
				}
				await client.query(
					`INSERT INTO case_state (case_id, state) VALUES ($1, 'CONTACTABLE')
					 ON CONFLICT (case_id) DO NOTHING`,
					[caseResult.rows[0].id]
				);
				await client.query(
					`INSERT INTO campaign_members (
						customer_id, campaign_id, case_id, status, next_contact_at
					 ) VALUES ($1, $2, $3, $4, NULL)
					 ON CONFLICT (campaign_id, case_id) DO UPDATE
					     SET status = EXCLUDED.status, next_contact_at = EXCLUDED.next_contact_at, updated_at = NOW()
					`,
					[
						user.customerId,
						campaignId,
						caseResult.rows[0].id,
						caseResult.rows[0].amount_cents_outstanding > 0 ? 'pending' : 'resolved'
					]
				);
			}

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
					         params = EXCLUDED.params, active = TRUE`,
					[
						user.customerId, campaignId, `campaign_${campaignId}_rates`,
						`Ratenzahlung in ${maxInstallments} Raten`,
						Math.round((installmentMin || 0) * 100), maxInstallments,
						maxInstallments * 31,
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
						[user.customerId, campaignId, `campaign_${campaignId}_discount_${suffix}`, `Sofortzahlungsrabatt ${suffix}`, days, discount]
					);
				}
			}
			await client.query(
				`INSERT INTO campaign_events (customer_id, campaign_id, actor, kind, data)
				 VALUES ($1, $2, $3, 'campaign_created', $4)`,
				[user.customerId, campaignId, `platform_user:${user.id}`, JSON.stringify({ import_id: importResult.rows[0].id, contacts: validRows.length })]
			);
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			console.error('[campaign-create] failed', error);
			return fail(500, {
				error: 'Kampagne konnte nicht erstellt werden.', fileError: false,
				manualError: importMode === 'manual', manualContacts: manualState
			});
		} finally {
			client.release();
		}

		redirect(303, `/inkassokampagnen/${campaignId}`);
	}
} satisfies Actions;
