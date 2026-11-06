'use strict';

const { createGmailTransport, MAILBOX } = require('./gmail-alert-transport');
const { db } = require('./store');
const { problem } = require('./policy');

function config(env = process.env) {
    if (env.RECOVERY_CALL_ALERT_ENABLED !== '1') return null;
    const shopId = env.RECOVERY_CALL_ALERT_SHOP_ID;
    const since = env.RECOVERY_CALL_ALERT_START_AT;
    const to = env.RECOVERY_CALL_ALERT_TO;
    const gmailClientId=env.GMAIL_CLIENT_ID, gmailClientSecret=env.GMAIL_CLIENT_SECRET, gmailRefreshToken=env.GMAIL_REFRESH_TOKEN;
    let dashboard;
    try {
        dashboard = new URL('/recovery/admin', env.RECOVERY_DASHBOARD_URL);
        if (dashboard.protocol !== 'https:' || dashboard.username || dashboard.password || dashboard.port) throw Error();
    } catch { throw problem('call_alert_config_invalid',503); }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(shopId || '') ||
        typeof since !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(since) || !Number.isFinite(Date.parse(since)) ||
        to !== MAILBOX || !gmailClientId || !gmailClientSecret || !gmailRefreshToken) throw problem('call_alert_config_invalid',503);
    return { shopId, since, to, dashboard:dashboard.href, gmailClientId,gmailClientSecret,gmailRefreshToken };
}

function message(call, settings) {
    const brand = String(call.brand).replace(/[\r\n\x00-\x1f\x7f]/g,' ').slice(0,100);
    const time = new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'medium',timeZone:'Europe/Berlin'}).format(call.dialed_at);
    return {
        id:call.id,
        subject:`Rescova: ${call.is_test ? 'Testanruf' : 'Anruf'} gestartet – ${brand}`,
        text:`${brand}: Ein ${call.is_test ? 'Testanruf' : 'Anruf'} wurde gestartet.\nStart: ${time} (Europe/Berlin)\nAnruf-ID: ${call.id}\n\nDashboard: ${settings.dashboard}\n\nDies bestätigt den Anrufstart, noch kein verbundenes Gespräch oder einen Kauf.`,
    };
}

async function tick() {
    const settings = config();
    if (!settings) return { attempted:0 };
    await db.query(`UPDATE recovery_call_alerts SET status='unknown',last_error='worker_interrupted'
        WHERE status='sending' AND attempted_at<NOW()-INTERVAL '2 minutes'`);
    const pending=await db.query(`SELECT 1 FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
        JOIN customers c ON c.id=s.customer_id WHERE a.shop_id=$1 AND s.mode='live' AND c.is_active
        AND a.status!='simulated' AND a.dialed_at >= $2::timestamptz AND a.dialed_at<=NOW()
        AND a.dialed_at>NOW()-INTERVAL '24 hours'
        AND NOT EXISTS(SELECT 1 FROM recovery_call_alerts n WHERE n.call_id=a.id) LIMIT 1`,[settings.shopId,settings.since]);
    if(!pending.rowCount)return {attempted:0};
    const transport = createGmailTransport(settings);
    // Verify OAuth and mailbox before claiming any notification. Auth failures remain retryable.
    await transport.verifyMailbox();
    let attempted = 0;
    for (let i=0;i<10;i++) {
        // The durable unique claim prevents duplicates across polls, restarts and workers.
        // shortcut: ambiguous Gmail sends are not retried; investigate unknown receipts before resending.
        const {rows} = await db.query(`WITH candidate AS (
            SELECT a.id FROM recovery_calls a JOIN recovery_shops s ON s.id=a.shop_id
            JOIN customers c ON c.id=s.customer_id
            WHERE a.shop_id=$1 AND s.mode='live' AND c.is_active AND a.status!='simulated'
            AND a.dialed_at >= $2::timestamptz AND a.dialed_at<=NOW()
            AND a.dialed_at>NOW()-INTERVAL '24 hours'
            AND NOT EXISTS(SELECT 1 FROM recovery_call_alerts n WHERE n.call_id=a.id)
            ORDER BY a.dialed_at,a.id LIMIT 1
        ), claimed AS (
            INSERT INTO recovery_call_alerts(call_id,status) SELECT id,'sending' FROM candidate
            ON CONFLICT DO NOTHING RETURNING call_id
        ) SELECT a.id,a.dialed_at,a.is_test,s.brand FROM claimed n
            JOIN recovery_calls a ON a.id=n.call_id JOIN recovery_shops s ON s.id=a.shop_id`,
        [settings.shopId,settings.since]);
        if (!rows.length) break;
        const call=rows[0];attempted++;
        let status='unknown',error='gmail_result_unconfirmed';
        try {
            const receipt=await transport.send(message(call,settings));
            if (receipt.providerMessageId) {
                status='accepted';error=null;
            } else { status='failed';error='gmail_result_unconfirmed'; }
        } catch (failure) {
            // Never persist raw provider messages: these can contain credentials or addresses.
            if (failure.uncertain===false) {
                status='failed';error='gmail_rejected';
            }
        }
        await db.query(`UPDATE recovery_call_alerts SET status=$2,last_error=$3,
            accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE NULL END WHERE call_id=$1`,[call.id,status,error]);
    }
    return {attempted};
}

function startCallAlertWorker() {
    if (process.env.RECOVERY_CALL_ALERT_ENABLED !== '1') return null;
    let running=false;
    const timer=setInterval(async()=>{
        if(running)return;
        running=true;
        try{await tick();}catch{console.error('[recovery] call alert worker failed');}
        finally{running=false;}
    },5000);
    timer.unref();return timer;
}

module.exports={config,message,tick,startCallAlertWorker};
