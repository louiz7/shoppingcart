'use strict';

const express = require('express');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { isIP } = require('node:net');
const { db, transaction } = require('./store');
const { problem } = require('./policy');
const { internal, handle } = require('./routes');
const derive = promisify(scrypt);

function credentials(input) {
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof input.password!=='string' || input.password.length<12 || input.password.length>128 ||
        typeof input.clientAddress!=='string' || !isIP(input.clientAddress)) throw problem('invalid_organization_registration',400);
    return { email,password:input.password,clientAddress:input.clientAddress };
}

async function verifyPassword(password, stored) {
    if (typeof stored!=='string' || !/^scrypt\$v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(stored)) return false;
    const [, , salt, expected] = stored.split('$');
    const actual = await derive(password,Buffer.from(salt,'hex'),64);
    return timingSafeEqual(actual,Buffer.from(expected,'hex'));
}

async function attempt(kind, address, email) {
    const allowed = await transaction(async (client) => {
        await client.query("DELETE FROM recovery_auth_attempts WHERE window_started_at<NOW()-INTERVAL '1 day'");
        for (const [subject, value, limit] of [['ip',address,kind==='login' ? 30 : 5],['email',email,kind==='login' ? 10 : 3]]) {
            const hash=createHash('sha256').update(value).digest('hex');
            const result=await client.query(`INSERT INTO recovery_auth_attempts(kind,subject_hash)
                VALUES($1,$2) ON CONFLICT(kind,subject_hash) DO UPDATE SET
                attempts=CASE WHEN recovery_auth_attempts.window_started_at<NOW()-INTERVAL '15 minutes' THEN 1
                    ELSE LEAST(recovery_auth_attempts.attempts+1,100000) END,
                window_started_at=CASE WHEN recovery_auth_attempts.window_started_at<NOW()-INTERVAL '15 minutes' THEN NOW()
                    ELSE recovery_auth_attempts.window_started_at END RETURNING attempts`,[`${kind}_${subject}`,hash]);
            if (result.rows[0].attempts>limit) return false;
        }
        return true;
    });
    if (!allowed) throw problem(kind==='login' ? 'login_rate_limited' : 'registration_rate_limited',429);
}

async function register(input) {
    const value=credentials(input);
    if (Object.keys(input).some((key)=>!['organizationName','displayName','email','password','clientAddress'].includes(key)) ||
        typeof input.organizationName!=='string' || input.organizationName.trim().length<2 || input.organizationName.trim().length>120 ||
        typeof input.displayName!=='string' || input.displayName.trim().length<2 || input.displayName.trim().length>120 ||
        /[\x00-\x1f\x7f]/.test(input.organizationName+input.displayName)) throw problem('invalid_organization_registration',400);
    await attempt('register',value.clientAddress,value.email);
    const salt=randomBytes(16), hash=await derive(value.password,salt,64);
    const stored=`scrypt$v1$${salt.toString('hex')}$${hash.toString('hex')}`;
    try {
        return await transaction(async (client)=>{
            const organization=await client.query(`INSERT INTO customers(name,email) VALUES($1,$2) RETURNING id`,[input.organizationName.trim(),value.email]);
            const result=await client.query(`INSERT INTO platform_users(customer_id,email,display_name,password_hash,role)
                VALUES($1,$2,$3,$4,'admin') RETURNING id`,[organization.rows[0].id,value.email,input.displayName.trim(),stored]);
            return { userId:Number(result.rows[0].id),customerId:organization.rows[0].id };
        });
    } catch (error) {
        if (error.code==='23505') throw problem('organization_registration_unavailable',409);
        throw error;
    }
}

async function login(input) {
    // Existing accounts may have shorter passwords; new registrations require twelve characters.
    if (!input || typeof input.email!=='string' || typeof input.password!=='string' ||
        !input.password.length || input.password.length>128 || typeof input.clientAddress!=='string' || !isIP(input.clientAddress)) {
        throw problem('invalid_login',400);
    }
    const email=input.email.trim().toLowerCase();
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw problem('invalid_login',400);
    await attempt('login',input.clientAddress,email);
    const result=await db.query(`SELECT u.id,u.customer_id,u.password_hash,u.role,c.is_rescova_internal FROM platform_users u
        JOIN customers c ON c.id=u.customer_id WHERE LOWER(u.email)=$1 AND u.active AND c.is_active`,[email]);
    const user=result.rows[0];
    const dummy=`scrypt$v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    const valid=await verifyPassword(input.password,user?.password_hash || dummy);
    if (!user || !valid) throw problem('invalid_login',400);
    return { userId:Number(user.id),customerId:user.customer_id,isRecoveryInternal:user.is_rescova_internal && user.role==='admin' };
}

async function overview(customerId,userId) {
    if (!Number.isSafeInteger(customerId) || customerId<1 || !Number.isSafeInteger(userId) || userId<1) throw problem('forbidden',403);
    const actor=await db.query(`SELECT u.id FROM platform_users u JOIN customers c ON c.id=u.customer_id
        WHERE u.id=$1 AND u.customer_id=$2 AND u.role='admin' AND u.active AND c.is_active AND c.is_rescova_internal`,[userId,customerId]);
    if (!actor.rowCount) throw problem('forbidden',403);
    const organizations=await db.query('SELECT id,name,is_active,is_rescova_internal FROM customers ORDER BY name,id');
    const shops=await db.query(`SELECT s.id,s.customer_id,s.brand,s.domain,s.currency,s.enabled,
        (SELECT count(*)::int FROM recovery_calls a WHERE a.shop_id=s.id AND a.status!='simulated' AND a.dialed_at IS NOT NULL) AS calls,
        (SELECT COALESCE(sum(a.confirmed_duration_seconds),0)::float8/60 FROM recovery_calls a
            WHERE a.shop_id=s.id AND a.status!='simulated' AND a.dialed_at IS NOT NULL) AS minutes,
        (SELECT count(*)::int FROM recovery_calls a WHERE a.shop_id=s.id AND a.status!='simulated' AND a.dialed_at IS NOT NULL
            AND a.confirmed_duration_seconds IS NULL) AS unknown_duration,
        (SELECT COALESCE(sum(o.net_cents),0)::float8 FROM recovery_orders o WHERE o.shop_id=s.id AND o.paid AND NOT o.is_test
            AND o.currency=s.currency AND EXISTS(SELECT 1 FROM recovery_checkouts checkout JOIN recovery_calls a ON a.checkout_id=checkout.id
                AND a.shop_id=checkout.shop_id WHERE checkout.shop_id=o.shop_id AND a.status!='simulated' AND NOT a.is_test
                AND a.connected_at IS NOT NULL AND o.paid_at>a.connected_at AND o.paid_at<a.connected_at+INTERVAL '168 hours'
                AND (o.recovery_checkout_id=checkout.id OR (o.checkout_token IS NOT NULL AND o.checkout_token=checkout.checkout_token) OR o.checkout_external_id=checkout.external_id))) AS revenue,
        (SELECT count(*)::int FROM recovery_orders o WHERE o.shop_id=s.id AND o.paid AND NOT o.is_test AND o.currency=s.currency
            AND EXISTS(SELECT 1 FROM recovery_checkouts checkout JOIN recovery_calls a ON a.checkout_id=checkout.id AND a.shop_id=checkout.shop_id
                WHERE checkout.shop_id=o.shop_id AND a.status!='simulated' AND NOT a.is_test AND a.connected_at IS NOT NULL
                AND o.paid_at>a.connected_at AND o.paid_at<a.connected_at+INTERVAL '168 hours'
                AND (o.recovery_checkout_id=checkout.id OR (o.checkout_token IS NOT NULL AND o.checkout_token=checkout.checkout_token) OR o.checkout_external_id=checkout.external_id))) AS orders
        FROM recovery_shops s WHERE s.mode='live' ORDER BY s.brand,s.id`);
    const groups=organizations.rows.map((org)=>({id:org.id,name:org.name,isInternal:org.is_rescova_internal,active:org.is_active,
        shops:shops.rows.filter((shop)=>shop.customer_id===org.id).map((shop)=>({id:shop.id,brand:shop.brand,domain:shop.domain,
            currency:shop.currency,enabled:shop.enabled,calls:shop.calls,connectedMinutes:shop.minutes,unknownDurationCalls:shop.unknown_duration,
            attributedRevenueCents:shop.revenue,confirmedOrders:shop.orders}))}));
    const totals={organizations:groups.length,shops:shops.rowCount,calls:0,connectedMinutes:0,unknownDurationCalls:0,
        attributedRevenue:['EUR','USD'].map((currency)=>({currency,amountCents:0,orders:0}))};
    for (const org of groups) for (const shop of org.shops) {
        totals.calls+=shop.calls;totals.connectedMinutes+=shop.connectedMinutes;totals.unknownDurationCalls+=shop.unknownDurationCalls;
        const money=totals.attributedRevenue.find((value)=>value.currency===shop.currency);
        money.amountCents+=shop.attributedRevenueCents;money.orders+=shop.confirmedOrders;
    }
    return {asOf:new Date().toISOString(),totals,organizations:groups};
}

const router=express.Router();
router.use(internal);
router.post('/register',handle(async(req,res)=>res.status(201).json(await register(req.body))));
router.post('/login',handle(async(req,res)=>res.json(await login(req.body))));
router.get('/overview',handle(async(req,res)=>res.json(await overview(Number(req.get('x-customer-id')),Number(req.get('x-user-id'))))));

module.exports={router,register,login,overview,verifyPassword};
