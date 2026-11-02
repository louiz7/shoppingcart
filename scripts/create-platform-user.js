'use strict';

require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/db');

function usage() {
    console.error('Usage: node scripts/create-platform-user.js <customer-id> <email> <display-name> [role]');
    console.error('Set PLATFORM_USER_PASSWORD or enter it interactively through your shell environment.');
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, 64);
    return `scrypt$v1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function main() {
    const customerId = Number(process.argv[2]);
    const email = String(process.argv[3] || '').trim().toLowerCase();
    const displayName = String(process.argv[4] || '').trim();
    const role = String(process.argv[5] || 'admin');
    const password = process.env.PLATFORM_USER_PASSWORD || '';

    if (!Number.isInteger(customerId) || !email || !displayName || !password) {
        usage();
        process.exitCode = 2;
        return;
    }
    if (!['admin', 'operator', 'viewer'].includes(role)) throw new Error('Invalid role');
    if (password.length < 12) throw new Error('Password must contain at least 12 characters');

    const { rows } = await db.query(
        `INSERT INTO platform_users (customer_id, email, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (customer_id, email) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 password_hash = EXCLUDED.password_hash,
                 role = EXCLUDED.role,
                 active = TRUE,
                 updated_at = NOW()
         RETURNING id, customer_id, email, display_name, role`,
        [customerId, email, displayName, hashPassword(password), role],
    );
    await db.query('DELETE FROM platform_sessions WHERE user_id = $1', [rows[0].id]);
    console.log(JSON.stringify(rows[0], null, 2));
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => db.pool.end());
