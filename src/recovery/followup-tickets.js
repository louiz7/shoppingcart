'use strict';

const { randomUUID } = require('node:crypto');
const { db, transaction, event } = require('./store');
const { problem } = require('./policy');
const service = require('./service');

function validate(input) {
    if (!input || !['unresolved_question','shop_action_required','technical_failure','human_requested'].includes(input.reason) ||
        typeof input.summary !== 'string' || !input.summary.trim() || [...input.summary.trim()].length > 600 ||
        /[\x00-\x1f\x7f]/.test(input.summary) || typeof input.callbackRequested !== 'boolean') throw problem('invalid_followup_ticket',400);
    return { reason: input.reason, summary: input.summary.trim(), callbackRequested: input.callbackRequested };
}

async function create(call, input) {
    const value = validate(input);
    return transaction(async client => {
        const { shop } = await require('./catalog').authorized(call,client,true);
        await service.conversationEvidence(client,call,input.userEventId);
        if (shop.mode !== 'live') return { status:'simulated',callbackRequested:value.callbackRequested };
        const inserted = await client.query(`INSERT INTO recovery_followup_tickets(id,call_id,reason,summary,callback_requested)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(call_id) DO NOTHING RETURNING id,callback_requested`,
        [randomUUID(),call.id,value.reason,value.summary,value.callbackRequested]);
        // A later explicit callback request can upgrade the same ticket; retries never duplicate it.
        const ticket = inserted.rows[0] || (await client.query(`UPDATE recovery_followup_tickets
            SET callback_requested=callback_requested OR $2 WHERE call_id=$1 RETURNING id,callback_requested`,
        [call.id,value.callbackRequested])).rows[0];
        if (inserted.rowCount) await event(client,shop.id,'followup_ticket_created',{ ticketId:ticket.id,reason:value.reason },call.id);
        return { status:inserted.rowCount ? 'created' : 'existing',ticketId:ticket.id,callbackRequested:ticket.callback_requested };
    });
}

async function actor(customerId,userId,executor=db) {
    if (!Number.isSafeInteger(customerId) || customerId < 1 || !Number.isSafeInteger(userId) || userId < 1) throw problem('forbidden',403);
    const { rows:[user] } = await executor.query(`SELECT u.role,c.is_rescova_internal FROM platform_users u
        JOIN customers c ON c.id=u.customer_id WHERE u.id=$1 AND u.customer_id=$2 AND u.active AND c.is_active`,[userId,customerId]);
    if (!user) throw problem('forbidden',403);
    return { admin:user.role==='admin',internal:user.role==='admin' && user.is_rescova_internal };
}

async function list(customerId,userId) {
    const user = await actor(customerId,userId);
    const { rows } = await db.query(`SELECT t.id,t.reason,t.summary,t.callback_requested AS "callbackRequested",
        t.created_at AS "createdAt",t.resolved_at AS "resolvedAt",a.is_test AS "isTest",s.brand,
        o.name AS organization,
        CASE WHEN t.callback_requested AND p.stopped_at IS NULL AND p.revoked_at IS NULL AND p.expires_at>NOW()
            THEN NULLIF(p.phone,'') ELSE NULL END AS phone,
        (p.stopped_at IS NOT NULL OR p.revoked_at IS NOT NULL OR p.expires_at IS NULL OR p.expires_at<=NOW()) AS "contactBlocked"
        FROM recovery_followup_tickets t JOIN recovery_calls a ON a.id=t.call_id
        JOIN recovery_shops s ON s.id=a.shop_id JOIN customers o ON o.id=s.customer_id
        JOIN recovery_checkouts c ON c.id=a.checkout_id AND c.shop_id=s.id
        LEFT JOIN recovery_contacts p ON p.shop_id=s.id AND p.contact_key=a.contact_key
        WHERE ($2 OR s.customer_id=$1)
        ORDER BY (t.resolved_at IS NOT NULL),t.created_at DESC,t.id LIMIT 100`,[customerId,user.internal]);
    return { tickets:rows,canEdit:user.admin,internal:user.internal };
}

async function resolve(customerId,userId,ticketId) {
    if (!service.uuid(ticketId)) throw problem('ticket_not_found',404);
    return transaction(async client => {
        const user=await actor(customerId,userId,client);
        if (!user.admin) throw problem('forbidden',403);
        const result=await client.query(`UPDATE recovery_followup_tickets t
            SET resolved_at=COALESCE(t.resolved_at,NOW()),resolved_by=COALESCE(t.resolved_by,$3)
            FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
            WHERE t.id=$1 AND t.call_id=a.id AND ($4 OR s.customer_id=$2) RETURNING t.id`,[ticketId,customerId,userId,user.internal]);
        if (!result.rowCount) throw problem('ticket_not_found',404);
        return { resolved:true };
    });
}

module.exports={validate,create,list,resolve};
