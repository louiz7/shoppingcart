'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const profile = require('../src/recovery/agent-profile');

test('agent profile allows bounded names and fixed choices with explicit AI templates', () => {
    assert.deepEqual(profile.validate({ ...profile.DEFAULT,name: ' Zoë-Marie ' }),{ ...profile.DEFAULT,name: 'Zoë-Marie' });
    for (const value of [null,[],{}, { ...profile.DEFAULT,voice: 'flitz' },{ ...profile.DEFAULT,language: 'fr' },
        { ...profile.DEFAULT,persona: 'human' },{ ...profile.DEFAULT,name: '<script>' },{ ...profile.DEFAULT,name: 'A\nB' },
        { ...profile.DEFAULT,name: 'A'.repeat(41) },{ ...profile.DEFAULT,greeting: 'Custom instruction' }]) {
        assert.throws(() => profile.validate(value),/invalid_agent_profile/);
    }
    for (const language of ['de','en']) for (const persona of ['assistant','founder']) {
        const result = profile.forShop({ brand: 'Synthetic shop',agent_profile: { ...profile.DEFAULT,language,persona } });
        assert.match(result.greeting,language==='de' ? /KI-Assistenz/ : /AI assistant/);
        assert.match(result.greeting,language==='de' ? /Rückruf/ : /callback/);
        assert.match(result.greeting,language==='de' ? /passt es gerade/ : /good time/);
        if (persona==='founder') assert.match(result.greeting,language==='de' ? /im Auftrag des Gründungsteams/ : /on behalf of the founding team/);
    }
    assert.equal(profile.forShop({ brand: 'Synthetic shop' }).voice,'male');
});

test('agent profiles persist only for a shop owner admin and stay isolated by tenant', {
    skip: process.env.RECOVERY_DB_TEST!=='1',timeout: 15000,
},async (t) => {
    require('dotenv').config();
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55433'); assert.equal(url.pathname,'/shoppingcart');
    const { db } = require('../src/recovery/store');
    const service = require('../src/recovery/service');
    const discounts = require('../src/recovery/discounts');
    const tenants = [];
    t.mock.method(global,'fetch',async () => { throw new Error('External requests forbidden'); });
    t.after(async () => {
        for (const id of tenants) await db.query('DELETE FROM customers WHERE id=$1',[id]);
        await db.pool.end();
    });
    async function fixture() {
        const shopId = randomUUID(),customerId = (await db.query('INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id',
            [`Synthetic profile ${shopId}`,`${shopId}@example.invalid`])).rows[0].id;
        tenants.push(customerId);
        const userId = (await db.query(`INSERT INTO platform_users(customer_id,email,display_name,password_hash,role)
            VALUES($1,$2,'Synthetic admin','not-a-real-password','admin') RETURNING id`,[customerId,`${shopId}@example.invalid`])).rows[0].id;
        await db.query(`INSERT INTO recovery_shops(id,customer_id,domain,brand,mode) VALUES($1,$2,$3,'Synthetic shop','live')`,
            [shopId,customerId,`${shopId}.myshopify.com`]);
        return { shopId,customerId,userId };
    }
    const f = await fixture(),other = await fixture(),value = { name: 'Alex',persona: 'founder',voice: 'female',language: 'en' };
    assert.deepEqual((await discounts.settings(f.customerId)).shops[0].agentProfile,profile.forShop({ brand: 'Synthetic shop' }));
    await assert.rejects(service.updateAgentProfile(f.customerId,f.shopId,value),/admin_required/);
    await assert.rejects(service.updateAgentProfile(f.customerId,f.shopId,value,other.userId),/admin_required/);
    await assert.rejects(service.updateAgentProfile(other.customerId,f.shopId,value,other.userId),/shop_not_found/);
    const saved = await service.updateAgentProfile(f.customerId,f.shopId,value,f.userId);
    assert.deepEqual(saved.agentProfile,profile.forShop({ brand: 'Synthetic shop',agent_profile: value }));
    assert.deepEqual((await discounts.settings(f.customerId)).shops[0].agentProfile,saved.agentProfile);
    assert.equal((await discounts.settings(other.customerId)).shops[0].agentProfile.persona,'assistant');
    await assert.rejects(db.query(`UPDATE recovery_shops SET agent_profile=jsonb_set(agent_profile,'{persona}','null') WHERE id=$1`,[f.shopId]),
        (error) => error.code==='23514');
    for (const change of ["role='viewer'","role='admin',active=FALSE"]) {
        await db.query(`UPDATE platform_users SET ${change} WHERE id=$1`,[f.userId]);
        await assert.rejects(service.updateAgentProfile(f.customerId,f.shopId,profile.DEFAULT,f.userId),/admin_required/);
    }
    assert.deepEqual((await discounts.settings(f.customerId)).shops[0].agentProfile,saved.agentProfile);
});
