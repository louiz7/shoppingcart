'use strict';

/**
 * Create a customer + their first API key. The plaintext key is printed ONCE.
 *
 *   node scripts/create-customer.js "Acme Inc" billing@acme.com
 */
require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../src/db');

function generateKey() {
    // 32 bytes of randomness, url-safe.
    const raw = crypto.randomBytes(32).toString('base64url');
    return `dlh_${raw}`;
}

async function main() {
    const [, , name, email, label] = process.argv;
    if (!name || !email) {
        console.error('Usage: node scripts/create-customer.js "<name>" <email> [label]');
        process.exit(1);
    }

    const customer = await db.query(
        `INSERT INTO customers (name, email, webhook_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name, email, webhook_token`,
        [name, email, crypto.randomBytes(24).toString('base64url')],
    );

    const key = generateKey();
    const prefix = key.slice(0, 8);
    const hash = await bcrypt.hash(key, 12);

    await db.query(
        `INSERT INTO api_keys (customer_id, key_prefix, key_hash, label)
         VALUES ($1, $2, $3, $4)`,
        [customer.rows[0].id, prefix, hash, label || 'default'],
    );

    console.log('Customer:', customer.rows[0]);
    console.log('API key (store this now, it will not be shown again):');
    console.log('  ' + key);
    console.log('Call-event webhook URL to register in Deepslate:');
    console.log(`  https://<your-host>/webhooks/deepslate/call-events/${customer.rows[0].webhook_token}`);

    await db.pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
