'use strict';

const { randomBytes, randomUUID, createHash, createHmac } = require('node:crypto');
const { AccessToken, RoomServiceClient, AgentDispatchClient, TrackSource } = require('livekit-server-sdk');
const { db, transaction } = require('./store');
const policy = require('./policy');
const shopify = require('./shopify');
const catalog = require('./catalog');
const knowledge = require('./knowledge');
const discounts = require('./discounts');
const DOMAIN = 'test-store-slzn5m7l.myshopify.com';
const TTL = 300000;
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenValid = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
let cachedSource;

function enabled() {
    if (process.env.RECOVERY_BROWSER_DEMO_ENABLED !== '1') throw policy.problem('demo_disabled',503);
}
function clients() {
    if (!['LIVEKIT_URL','LIVEKIT_API_KEY','LIVEKIT_API_SECRET','LIVEKIT_AGENT_NAME'].every(k=>process.env[k])) throw policy.problem('demo_unavailable',503);
    const args=[process.env.LIVEKIT_URL.replace(/^wss:/,'https:'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET];
    return {rooms:new RoomServiceClient(...args),dispatch:new AgentDispatchClient(...args)};
}
async function source() {
    enabled();
    if (cachedSource && cachedSource.until>Date.now()) return cachedSource.promise;
    const entry={until:Date.now()+30000};
    entry.promise=(async()=>{
        const {rows:[shop]}=await db.query("SELECT s.* FROM recovery_shops s JOIN customers c ON c.id=s.customer_id WHERE s.domain=$1 AND s.mode='live' AND c.is_rescova_internal AND c.is_active",[DOMAIN]);
        if (!shop) throw policy.problem('demo_shop_unavailable',503);
        // Only cart lines are requested: no customer identity, address or recovery token enters a demo.
        const result=await shopify.graphql(shop,`query DemoCart {
            abandonedCheckouts(first:10,sortKey:CREATED_AT,reverse:true) { nodes {
                completedAt updatedAt lineItems(first:20) { nodes { quantity variant { id } } pageInfo { hasNextPage } }
            } }
        }`);
        const checkout=result.abandonedCheckouts.nodes.filter(c=>!c.completedAt).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt))[0];
        if (!checkout || checkout.lineItems.pageInfo.hasNextPage) throw policy.problem('demo_cart_unavailable',503);
        const cart=await catalog.snapshot(shop,checkout.lineItems.nodes.map(i=>({variantId:i.variant?.id,quantity:i.quantity})));
        const [details,availableDiscounts]=await Promise.all([knowledge.forCart(shop,cart.items,true),discounts.available(shop,cart.subtotalCents)]);
        const agentProfile=require('./agent-profile').forShop(shop);
        // Founder roleplay is confined to the explicitly labelled AI browser demo.
        if(agentProfile.persona==='founder') agentProfile.greeting=agentProfile.language==='de'
            ? `Hey, hier ist ${agentProfile.name}, Gründer von ${shop.brand}. Ich hab gesehen, dass du gerade bei uns im Shop unterwegs warst. Hast du noch Fragen zu den Produkten, bei denen ich dir helfen kann?`
            : `Hey, I'm ${agentProfile.name}, founder of ${shop.brand}. I saw you were just browsing our store. Do you have any questions about the products I can help with?`;
        return {shop,context:{brand:shop.brand,brandVoice:shop.brand_voice,agentProfile,
            contactConfirmed:false,cart,knowledge:details,availableDiscounts,maxDiscountPercent:policy.rules(shop.rules).maxDiscountPercent,
            verifiedAt:new Date().toISOString(),demo:true}};
    })().catch(error=>{if(cachedSource===entry) cachedSource=null;throw error;});
    cachedSource=entry;
    return entry.promise;
}
function publicView(row) {
    const s=row.data;
    return {brand:s.context?.brand,agentProfile:s.context?.agentProfile,cart:s.context?.cart,verifiedAt:s.context?.verifiedAt,
        expiresAt:row.expires_at,ended:Boolean(row.ended_at)||new Date(row.expires_at)<=new Date(),
        checkout:s.link || null,helpArticles:s.helpArticles || [],activity:s.activity || [],durationSeconds:TTL/1000};
}
async function info() { const {context}=await source();return {brand:context.brand,agentProfile:context.agentProfile,cart:context.cart,verifiedAt:context.verifiedAt,durationSeconds:TTL/1000}; }
async function start(address) {
    enabled();
    if (typeof address!=='string' || address.length>100 || !process.env.INTERNAL_TOOL_SECRET) throw policy.problem('invalid_demo_request');
    const clientHash=createHmac('sha256',process.env.INTERNAL_TOOL_SECRET).update(address).digest('hex');
    const id=randomUUID(),token=randomBytes(32).toString('hex'),browserToken=randomBytes(32).toString('hex'),room='recovery-demo-'+id;
    // Reserve before Shopify/network reads; quotas survive restarts and serialize concurrent starts.
    await transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(731944)');
        await client.query("DELETE FROM recovery_demo_sessions WHERE created_at<NOW()-INTERVAL '1 day'");
        const {rows:[q]}=await client.query(`SELECT count(*) FILTER (WHERE created_at>NOW()-INTERVAL '1 hour')::int AS total,
            count(*) FILTER (WHERE client_hash=$1 AND created_at>NOW()-INTERVAL '1 hour')::int AS personal,
            count(*) FILTER (WHERE ended_at IS NULL AND expires_at>NOW())::int AS active FROM recovery_demo_sessions`,[clientHash]);
        if(q.total>=20 || q.personal>=3 || q.active>=2) throw policy.problem('demo_limit',429);
        const {rows:[shop]}=await client.query("SELECT s.id FROM recovery_shops s JOIN customers c ON c.id=s.customer_id WHERE s.domain=$1 AND s.mode='live' AND c.is_rescova_internal AND c.is_active",[DOMAIN]);
        if(!shop) throw policy.problem('demo_shop_unavailable',503);
        await client.query('INSERT INTO recovery_demo_sessions(id,token_hash,browser_hash,client_hash,shop_id,room,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,hash(token),hash(browserToken),clientHash,shop.id,room,new Date(Date.now()+TTL)]);
    });
    try {
        const {context}=await source();
        const {rows:[row]}=await db.query('UPDATE recovery_demo_sessions SET data=$2 WHERE id=$1 RETURNING *',[id,{context,seq:0,known:context.cart.items.map(i=>i.variantId)}]);
        const {rooms,dispatch}=clients();
        await rooms.createRoom({name:room,emptyTimeout:30,maxParticipants:2,metadata:JSON.stringify({mode:'recovery_demo',call_token:token})});
        await dispatch.createDispatch(room,process.env.LIVEKIT_AGENT_NAME);
        const access=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:'demo-visitor',ttl:300});
        access.addGrant({room,roomJoin:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE],canSubscribe:true,canPublishData:false,canUpdateOwnMetadata:false});
        const timer=setTimeout(()=>end(browserToken,'browser_hash').catch(()=>{}),TTL);timer.unref();
        return {url:process.env.LIVEKIT_URL,token:await access.toJwt(),browserToken,...publicView(row)};
    } catch(error) {
        await db.query('UPDATE recovery_demo_sessions SET ended_at=NOW() WHERE id=$1',[id]);
        await clients().rooms.deleteRoom(room).catch(()=>{});
        throw error;
    }
}
async function find(token,column='token_hash',client=db,lock=false) {
    if (!tokenValid(token) || !['token_hash','browser_hash'].includes(column)) throw policy.problem('invalid_demo_session',401);
    const {rows:[row]}=await client.query(`SELECT * FROM recovery_demo_sessions WHERE ${column}=$1 ${lock?'FOR UPDATE':''}`,[hash(token)]);
    if(!row) throw policy.problem('invalid_demo_session',401);
    return row;
}
async function status(token) {return publicView(await find(token,'browser_hash'));}
async function end(token,column='token_hash') {
    const row=await find(token,column);
    await db.query('UPDATE recovery_demo_sessions SET ended_at=COALESCE(ended_at,NOW()) WHERE id=$1',[row.id]);
    await clients().rooms.deleteRoom(row.room).catch(error=>{if(error.status!==404 && error.code!=='not_found') throw error;});
    return {ended:true};
}
function consent(s,id) {if(!id || id!==s.userEvent) throw policy.problem('conversation_changed',409);}
function reviewed(s,after) {
    const review=s.userReview;
    if(!review || !(review.seq>after && s.userSeq>review.seq) || review.interrupted) throw policy.problem('checkout_review_required',409);
}
function link(shop,cart,code) {
    const path=catalog.selection(cart.items.map(i=>({variantId:i.variantId,quantity:i.quantity}))).map(i=>i.variantId.split('/').at(-1)+':'+i.quantity).join(',');
    const url=new URL('https://'+shop.domain+'/cart/'+path);
    if(code) url.searchParams.set('discount',code);
    return url.href;
}
async function tool(token,name,input={}) {
    if(name==='end') return end(token);
    enabled();
    return transaction(async client=>{
        const row=await find(token,'token_hash',client,true),s=row.data;
        if(row.ended_at || new Date(row.expires_at)<=new Date() || s.stopped) throw policy.problem('demo_ended',409);
        const {rows:[shop]}=await client.query("SELECT * FROM recovery_shops WHERE id=$1 AND domain=$2 AND mode='live'",[row.shop_id,DOMAIN]);
        if(!shop || !s.context) throw policy.problem('demo_unavailable',503);
        let result;
        if(name==='transcript') {
            if(!require('./service').uuid(input.eventId) || !['user','assistant'].includes(input.role)) throw policy.problem('invalid_transcript');
            if(s.lastEvent!==input.eventId){s.seq++;s.lastEvent=input.eventId;
                if(input.role==='user'){s.userEvent=input.eventId;s.userSeq=s.seq;
                    // Bind the review to the user's reply, not a later spoken acknowledgement.
                    s.userReview={seq:s.assistantSeq??0,interrupted:s.interrupted===true};}
                else{s.assistantSeq=s.seq;s.interrupted=input.interrupted===true;}}
            result={recorded:true}; // Only provenance/order, never transcript text or customer data.
        } else if(name==='latency') result={recorded:true};
        else if(name==='connected') result={brand:s.context.brand,brandVoice:s.context.brandVoice,agentProfile:s.context.agentProfile,demo:true};
        else if(name==='confirm_contact'){consent(s,input.userEventId);s.context.contactConfirmed=true;result={contactConfirmed:true};}
        else {
            if(!s.context.contactConfirmed && !['stop','outcome'].includes(name)) throw policy.problem('contact_confirmation_required',409);
            switch(name){
            case 'context': result=s.context;break;
            case 'search_products': result=await catalog.search(shop,input.query,input.maxPriceCents??null);s.known=[...new Set([...s.known,...result.products.map(i=>i.variantId)])].slice(-100);break;
            case 'product_details': if(!s.known.includes(input.variantId)) throw policy.problem('unknown_product');result=await knowledge.product(shop,input.variantId);break;
            case 'shop_policies': result=await knowledge.policies(shop);break;
            case 'send_help_article': {
                consent(s,input.userEventId);
                if(!s.known.includes(input.variantId)) throw policy.problem('unknown_product');
                const article=require('./zendesk').articleLink(await knowledge.product(shop,input.variantId),input.articleId);
                const prior=(s.helpArticles || []).some(a=>a.articleId===article.articleId);
                if(!prior){
                    if((s.helpArticles || []).length>=2) throw policy.problem('help_article_limit',409);
                    s.helpArticles=[...(s.helpArticles || []),article];
                }
                result={status:'shown_in_browser',simulated:true,smsSent:false,duplicate:prior,article,
                    instructions:'Der Hilfeartikel ist in der Browserdemo sichtbar. Keine SMS versendet.'};break;
            }
            case 'prepare_checkout': {
                catalog.selection(input.items);
                if(input.items.some(i=>!s.known.includes(i.variantId))) throw policy.problem('unknown_product');
                const cart=await catalog.snapshot(shop,input.items),proof=input.discountId?await discounts.verify(shop,input.discountId,cart.subtotalCents):null;
                s.proposal={id:randomUUID(),cart,proof,seq:s.seq};
                result={preparedCheckoutId:s.proposal.id,cart,offer:policy.offer(shop.rules,cart.subtotalCents,proof?.percent||0),originalCartUnchanged:true,purchaseCompleted:false};break;
            }
            case 'offer': {
                const proof=input.discountId?await discounts.verify(shop,input.discountId,s.context.cart.subtotalCents):null;
                if(input.percent && input.percent!==proof?.percent) throw policy.problem('discount_not_available',409);
                s.offer=proof?{proof,seq:s.seq}:null;
                result=policy.offer(shop.rules,s.context.cart.subtotalCents,proof?.percent||0);break;
            }
            case 'send_link': {
                consent(s,input.userEventId);
                if(typeof input.useDiscount!=='boolean') throw policy.problem('invalid_discount');
                let cart=s.context.cart,proof=null,seq=null;
                if(input.preparedCheckoutId){
                    if(s.proposal?.id!==input.preparedCheckoutId) throw policy.problem('prepared_checkout_changed',409);
                    cart=s.proposal.cart;reviewed(s,s.proposal.seq);proof=s.proposal.proof;seq=s.proposal.seq;
                }else if(s.offer){proof=s.offer.proof;seq=s.offer.seq;}
                if(input.useDiscount){if(!proof) throw policy.problem('valid_offer_required',409);reviewed(s,seq);
                    const fresh=await discounts.verify(shop,proof.id,cart.subtotalCents);if(fresh.fingerprint!==proof.fingerprint) throw policy.problem('valid_offer_required',409);}
                const freshCart=await catalog.snapshot(shop,cart.items.map(i=>({variantId:i.variantId,quantity:i.quantity})));
                if(policy.cartHash(freshCart)!==policy.cartHash(cart)) throw policy.problem('selected_product_changed',409);
                policy.offer(shop.rules,cart.subtotalCents,input.useDiscount?proof.percent:0);
                s.link={url:link(shop,cart,input.useDiscount?proof.code:null),discountPercent:input.useDiscount?proof.percent:0,cart};
                result={status:'shown_in_browser',simulated:true,smsSent:false,checkoutUrl:s.link.url,instructions:'Der Checkout-Link ist jetzt in der Browserdemo sichtbar. Keine SMS versendet; sage, dass der Link hier geöffnet werden kann.'};break;
            }
            case 'order_status':result={demo:true,purchaseCompleted:false,orders:[],instructions:'Die Demo verfolgt keine echten Käufe und bestätigt keine Bestellung oder Lieferung.'};break;
            case 'stop':s.stopped=true;result={stopped:true,simulated:true,instructions:'Nur diese Demo wurde gestoppt; kein echter Kundenkontakt verändert.'};break;
            case 'outcome':result={saved:true,simulated:true};break;
            default:throw policy.problem('unknown_demo_tool',404);
            }
        }
        if(!['transcript','latency','connected'].includes(name))s.activity=[...(s.activity||[]),{name,at:new Date().toISOString()}].slice(-12);
        await client.query('UPDATE recovery_demo_sessions SET data=$2 WHERE id=$1',[row.id,s]);
        return result;
    });
}
function router() {
    const r=require('express').Router(),{internal,handle}=require('./routes');
    r.use(internal);
    r.get('/info',handle(async(_req,res)=>res.json(await info())));
    r.post('/start',handle(async(req,res)=>res.json(await start(req.body.clientAddress))));
    r.post('/status',handle(async(req,res)=>res.json(await status(req.body.token))));
    r.post('/end',handle(async(req,res)=>res.json(await end(req.body.token,'browser_hash'))));
    r.post('/tools/:name',handle(async(req,res)=>res.json(await tool(req.get('x-call-token'),req.params.name,req.body))));
    return r;
}
module.exports={router,info,start,status,end,tool,link};
