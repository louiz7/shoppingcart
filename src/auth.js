'use strict';

const bcrypt = require('bcrypt');
const db = require('./db');

const PREFIX_LEN = 8;

/**
 * Extract the API key from the request.
 * Accepts either `Authorization: Bearer <key>` or `x-api-key: <key>`.
 */
function extractKey(req) {
    const auth = req.get('authorization');
    if (auth && auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    const headerKey = req.get('x-api-key');
    if (headerKey) return headerKey.trim();
    return null;
}

/**
 * Express middleware: authenticate the customer by API key.
 * On success, attaches `req.customer` and `req.apiKey`.
 */
async function authenticate(req, res, next) {
    const key = extractKey(req);
    if (!key) {
        return res.status(401).json({ error: 'missing_api_key' });
    }

    const prefix = key.slice(0, PREFIX_LEN);

    try {
        const { rows } = await db.query(
            `SELECT k.id           AS key_id,
                    k.key_hash,
                    k.is_active    AS key_active,
                    c.id           AS customer_id,
                    c.name,
                    c.email,
                    c.is_active    AS customer_active
               FROM api_keys k
               JOIN customers c ON c.id = k.customer_id
              WHERE k.key_prefix = $1`,
            [prefix],
        );

        if (rows.length === 0) {
            return res.status(401).json({ error: 'invalid_api_key' });
        }

        // There may be more than one row sharing a prefix in theory; check each.
        let match = null;
        for (const row of rows) {
            if (await bcrypt.compare(key, row.key_hash)) {
                match = row;
                break;
            }
        }

        if (!match) {
            return res.status(401).json({ error: 'invalid_api_key' });
        }
        if (!match.key_active || !match.customer_active) {
            return res.status(403).json({ error: 'key_or_customer_disabled' });
        }

        req.customer = {
            id: match.customer_id,
            name: match.name,
            email: match.email,
        };
        req.apiKey = { id: match.key_id };

        // Fire-and-forget last_used_at update.
        db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [match.key_id])
            .catch((err) => console.error('[auth] last_used_at update failed', err));

        return next();
    } catch (err) {
        console.error('[auth] error', err);
        return res.status(500).json({ error: 'auth_error' });
    }
}

module.exports = { authenticate };
