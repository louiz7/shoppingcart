'use strict';

// Creates only the dedicated loopback database described in SHOPPINGCART_HANDOFF.md.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const url = new URL(process.env.DATABASE_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/shoppingcart' || url.username !== 'shoppingcart') {
    throw new Error('Refusing to initialize a database outside the dedicated local shoppingcart endpoint');
}
const root = path.resolve('.local');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const cluster = path.join(root, 'postgres');
const bin = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@15/bin';
const run = (command, args) => {
    const result = spawnSync(path.join(bin, command), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(`${command} failed; inspect .local/postgres.log (no credentials are printed)`);
};
if (!fs.existsSync(path.join(cluster, 'PG_VERSION'))) {
    const passwordFile = path.join(root, 'pg-password');
    fs.writeFileSync(passwordFile, decodeURIComponent(url.password), { mode: 0o600 });
    try { run('initdb', ['-D', cluster, '-U', 'shoppingcart', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']); }
    finally { fs.rmSync(passwordFile, { force: true }); }
}
const status = spawnSync(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { stdio: 'ignore' });
if (status.status !== 0) run('pg_ctl', ['start', '-D', cluster, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p 55433 -k ${root}`]);
const { Client } = require('pg');
async function main() {
    const admin = new Client({ connectionString: new URL('/postgres', url).href });
    await admin.connect();
    const result = await admin.query("SELECT 1 FROM pg_database WHERE datname='shoppingcart'");
    if (!result.rowCount) await admin.query('CREATE DATABASE shoppingcart');
    await admin.end();
    console.log('Local shoppingcart PostgreSQL ready on 127.0.0.1:55433');
}
main().catch(() => { console.error('Local database setup failed'); process.exitCode = 1; });
