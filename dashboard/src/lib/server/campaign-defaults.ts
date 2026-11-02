import { db } from '$lib/server/db';

export type CampaignDefaults = {
	timezone: string;
	weekdays: number[];
	startTime: string;
	endTime: string;
	maxAttempts: number;
	maxAttemptsPer24h: number;
	maxAttemptsPer7d: number;
	retryIntervalMinutes: number;
};

export async function getCampaignDefaults(customerId: number): Promise<CampaignDefaults> {
	const { rows } = await db.query<{
		timezone: string; weekdays: number[]; start_time: string; end_time: string;
		max_contact_attempts: number; max_attempts_per_24h: number;
		max_attempts_per_7d: number; retry_interval_minutes: number;
	}>(
		`SELECT timezone, weekdays, start_time, end_time, max_contact_attempts,
		        max_attempts_per_24h, max_attempts_per_7d, retry_interval_minutes
		   FROM organization_campaign_defaults
		  WHERE customer_id = $1`,
		[customerId]
	);
	const row = rows[0];
	return {
		timezone: row?.timezone || 'Europe/Berlin',
		weekdays: row?.weekdays || [1, 2, 3, 4, 5],
		startTime: row?.start_time?.slice(0, 5) || '09:00',
		endTime: row?.end_time?.slice(0, 5) || '20:00',
		maxAttempts: row?.max_contact_attempts || 6,
		maxAttemptsPer24h: row?.max_attempts_per_24h || 1,
		maxAttemptsPer7d: row?.max_attempts_per_7d || 3,
		retryIntervalMinutes: row?.retry_interval_minutes || 60
	};
}
