'use strict';

/**
 * Apply every .sql file in ./migrations in alphabetical order.
 * Idempotent: each migration uses CREATE ... IF NOT EXISTS.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

async function main() {
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
        const sql = fs.readFileSync(path.join(dir, file), 'utf8');
        process.stdout.write(`-> applying ${file} ... `);
        await db.query(sql);
        console.log('ok');
    }

    await db.pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
