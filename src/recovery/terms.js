'use strict';

const {createHash,randomUUID}=require('node:crypto');
const {db,transaction}=require('./store');
const {problem}=require('./policy');
const document=require('./terms-document.json');
const documentText=JSON.stringify(document);
const hash=createHash('sha256').update(documentText).digest('hex');

async function status(customerId,executor=db) {
    const {rows}=await executor.query(`SELECT a.accepted_at,a.actor_name,a.source FROM recovery_terms_acceptances a
        JOIN customers c ON c.id=a.customer_id WHERE a.customer_id=$1 AND a.version=$2 AND a.document_hash=$3 AND c.is_active`,
    [customerId,document.version,hash]);
    return {version:document.version,hash,acceptedAt:rows[0]?.accepted_at || null,acceptedBy:rows[0]?.actor_name || null,source:rows[0]?.source || null};
}

async function accept(customerId,userId,input) {
    if(!/^[1-9]\d*$/.test(String(userId)) || !Number.isSafeInteger(Number(userId))) throw problem('admin_required',403);
    if(input?.accepted!==true) throw problem('terms_acceptance_required',409);
    if(input.version!==document.version || input.hash!==hash) throw problem('terms_version_changed',409);
    return transaction(async client=>{
        const {rows:[actor]}=await client.query(`SELECT u.id,u.email,u.display_name FROM platform_users u JOIN customers c ON c.id=u.customer_id
            WHERE u.id=$1 AND u.customer_id=$2 AND u.role='admin' AND u.active AND c.is_active FOR SHARE OF u,c`,[userId,customerId]);
        if(!actor) throw problem('admin_required',403);
        await client.query(`INSERT INTO recovery_terms_acceptances(id,customer_id,version,document_hash,document_text,accepted_by,actor_email,actor_name)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(customer_id,version,document_hash) DO NOTHING`,
        [randomUUID(),customerId,document.version,hash,documentText,actor.id,actor.email,actor.display_name]);
        return status(customerId,client);
    });
}

module.exports={document,hash,status,accept};
