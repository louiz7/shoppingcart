'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
    console.error('[db] unexpected pg pool error', err);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
};
