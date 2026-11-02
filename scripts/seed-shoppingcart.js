'use strict';

require('dotenv').config();
const fs = require('node:fs');
const { randomUUID, randomBytes, scryptSync } = require('node:crypto');
const { db, transaction } = require('../src/recovery/store');
const { upsertCheckout } = require('../src/recovery/service');
const policy = require('../src/recovery/policy');

async function main() {
    const url = new URL(process.env.DATABASE_URL);
    if (url.hostname !== '127.0.0.1' || url.port !== '55433' || url.pathname !== '/shoppingcart') throw new Error('local_shoppingcart_database_required');
    const email = 'pilot@shoppingcart.local', password = randomBytes(18).toString('base64url');
    const salt = randomBytes(16), passwordHash = `scrypt$v1$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
    const result = await transaction(async (client) => {
        const { rows } = await client.query(`INSERT INTO customers(name,email) VALUES('Shoppingcart Pilot',$1)
            ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [email]);
        const customerId = rows[0].id;
        const exists = await client.query('SELECT id FROM platform_users WHERE email=$1', [email]);
        if (exists.rowCount && !fs.existsSync('.local/login.json')) throw new Error('existing_login_credentials_missing_use_password_reset');
        if (!exists.rowCount) await client.query(`INSERT INTO platform_users(customer_id,email,display_name,password_hash,role)
            VALUES($1,$2,'Pilot Admin',$3,'admin')`, [customerId, email, passwordHash]);
        let { rows: shops } = await client.query(`SELECT * FROM recovery_shops WHERE customer_id=$1 AND domain='afterhours-demo.myshopify.com'`, [customerId]);
        if (!shops[0]) {
            const inserted = await client.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,brand_voice,rules)
                VALUES($1,$2,'afterhours-demo.myshopify.com','AFTERHOURS','Locker und warm. Duzen, ohne Druck. Immer als KI vorstellen.',$3) RETURNING *`,
            [randomUUID(), customerId, JSON.stringify(policy.DEFAULT_RULES)]);
            shops = inserted.rows;
        }
        const shop = shops[0];
        for (const [index, titles, price] of [[1, ['Heavyweight Hoodie', 'Everyday Cap'], 11800], [2, ['Heavyweight Hoodie'], 8900], [3, ['Everyday Cap'], 2900]]) {
            await upsertCheckout(client, shop, {
                id: `gid://shopify/AbandonedCheckout/${900000 + index}`, updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
                completedAt: null, phone: `+49000000000${index}`, email: `synthetic-${index}@example.invalid`, customerId: `gid://shopify/Customer/${index}`,
                firstName: '', currency: 'EUR', subtotalCents: price,
                checkoutUrl: `https://${shop.domain}/checkouts/synthetic-${index}`, discountCodes: [],
                items: titles.map((title, i) => ({ title, variantTitle: title.includes('Hoodie') ? 'Washed Black / M' : 'Schwarz',
                    quantity: 1, originalUnitCents: title.includes('Hoodie') ? 8900 : 2900,
                    currentPriceCents: title.includes('Hoodie') ? 8900 : 2900, available: true,
                    variantId: `gid://shopify/ProductVariant/${index * 10 + i}`, description: 'Fiktive Produktdaten aus der Browserdemo.' })),
            });
        }
        return { created: !exists.rowCount };
    });
    fs.mkdirSync('.local', { recursive: true, mode: 0o700 });
    if (result.created) {
        fs.writeFileSync('.local/login.json', JSON.stringify({ email, password }), { mode: 0o600 });
        fs.writeFileSync('.local/login.txt', `Nur lokal: http://localhost:5173/login?next=/recovery\nE-Mail: ${email}\nPasswort: ${password}\n`, { mode: 0o600 });
    }
    console.log('Synthetic AFTERHOURS fixtures ready. Local login is in .local/login.txt. No contact permissions or outbound activation were seeded.');
}
main().catch((error) => { console.error(error.code || 'shoppingcart_seed_failed'); process.exitCode = 1; }).finally(() => db.pool.end());
