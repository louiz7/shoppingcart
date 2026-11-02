import pg from 'pg';
import { env } from '$env/dynamic/private';

const { Pool } = pg;

export const db = new Pool({
	connectionString: env.DATABASE_URL,
	max: 10,
	idleTimeoutMillis: 30_000
});

db.on('error', (error) => {
	console.error('[dashboard-db] unexpected pool error', error);
});
