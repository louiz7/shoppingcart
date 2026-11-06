'use strict';
const {randomBytes,createHash}=require('node:crypto');
const {transaction}=require('./store');
const {problem,checkoutUrl}=require('./policy');
const hash=value=>createHash('sha256').update(value).digest('hex');
const enabled=()=>process.env.RECOVERY_SMS_LINK_TRACKING_ENABLED==='1';

async function create(client,actionId,callId) {
    if(!enabled()) return null;
    const base=new URL(process.env.RECOVERY_PUBLIC_URL);
    if(base.protocol!=='https:' || base.username || base.password || base.port) throw problem('sms_not_configured',503);
    const token=randomBytes(32).toString('hex');
    await client.query('INSERT INTO recovery_sms_links(action_id,call_id,token_hash) VALUES($1,$2,$3)',[actionId,callId,hash(token)]);
    return new URL('/r/'+token,base).href;
}

async function resolve(token,recordOpen=true) {
    if(typeof token!=='string' || token.length!==64 || !/^[a-f0-9]+$/.test(token)) throw problem('link_not_found',404);
    return transaction(async client=>{
        const {rows:[row]}=await client.query(`SELECT l.action_id,a.data,s.domain,s.storefront_domain FROM recovery_sms_links l
            JOIN recovery_actions a ON a.id=l.action_id JOIN recovery_checkouts c ON c.id=a.checkout_id
            JOIN recovery_calls call ON call.id=l.call_id AND call.checkout_id=c.id AND call.shop_id=c.shop_id
            JOIN recovery_shops s ON s.id=c.shop_id JOIN customers tenant ON tenant.id=s.customer_id
            JOIN recovery_contacts contact ON contact.shop_id=c.shop_id AND contact.contact_key=c.contact_key
            WHERE l.token_hash=$1 AND l.expires_at>NOW() AND a.kind='sms' AND a.status IN ('accepted','delivered')
            AND s.mode='live' AND tenant.is_active
            AND contact.stop_reason IS DISTINCT FROM 'privacy_redaction'
            AND a.data->>'messageType' IS DISTINCT FROM 'help_article' FOR UPDATE OF l`,[hash(token)]);
        if(!row) throw problem('link_not_found',404);
        const destination=checkoutUrl(row.data.checkoutUrl,row);
        if(recordOpen && enabled()) await client.query('UPDATE recovery_sms_links SET first_opened_at=COALESCE(first_opened_at,NOW()) WHERE action_id=$1',[row.action_id]);
        return destination;
    });
}

async function attributeOrder(client,shop,payload) {
    const attrs=Array.isArray(payload.note_attributes)?payload.note_attributes.filter(a=>a?.name==='rescova_recovery'):[];
    const proposal=attrs.length===1 && typeof attrs[0].value==='string'?attrs[0].value:null;
    await client.query(`UPDATE recovery_orders o SET sms_link_opened_at=proof.opened FROM (
        SELECT min(l.first_opened_at) AS opened FROM recovery_sms_links l
        JOIN recovery_actions sms ON sms.id=l.action_id JOIN recovery_calls call ON call.id=l.call_id
        JOIN recovery_checkouts c ON c.id=sms.checkout_id AND c.id=call.checkout_id AND c.shop_id=call.shop_id
        JOIN recovery_orders target ON target.shop_id=c.shop_id AND target.external_id=$2
        WHERE c.shop_id=$1 AND target.paid AND NOT target.is_test AND target.currency=c.currency
        AND NOT call.is_test AND call.status!='simulated' AND call.connected_at IS NOT NULL
        AND sms.status IN ('accepted','delivered') AND sms.kind='sms' AND l.first_opened_at>=sms.created_at
        AND target.ordered_at>l.first_opened_at AND target.paid_at>l.first_opened_at
        AND target.paid_at<call.connected_at+INTERVAL '7 days'
        AND ((sms.data->>'proposalId' IS NULL AND ((target.checkout_token IS NOT NULL AND target.checkout_token=c.checkout_token)
            OR target.checkout_external_id=c.external_id))
            OR (sms.data->>'proposalId'=$3 AND target.recovery_checkout_id=c.id))
        ) proof WHERE o.shop_id=$1 AND o.external_id=$2 AND o.sms_link_opened_at IS NULL AND proof.opened IS NOT NULL`,
    [shop.id,String(payload.id),proposal]);
}

function router() {
    const express=require('express'),{internal,handle}=require('./routes');
    const route=express.Router();route.use(internal);
    route.post('/resolve',handle(async(req,res)=>{
        if(typeof req.body?.recordOpen!=='boolean') throw problem('invalid_link_request');
        res.json({url:await resolve(req.body.token,req.body.recordOpen)});
    }));
    return route;
}
module.exports={create,resolve,attributeOrder,router,enabled};
