'use strict';

// Pilot configuration is deliberately fixed to the verified Deskspace tenant and public help center.
const DOMAIN = 'desqup.myshopify.com';
const ORIGIN = 'https://support.deskspace.de';
const sections = {
    'PRO':28359213507475, 'PRO PLUS':28360741688595, 'PRO PLUS V3':57048348889235,
    'CORNER':28360261958547, 'TITAN':30463674766483, 'MOVE':39130016850323,
    'MOVE PRO':43567999568403, 'MOTION':28361069197203, 'EXECUTIVE':48229420161555,
    'EXECUTIVE LITE':48229566241811, 'MONITORARM':49582080738067,
    'WRAP':37928700110099, 'SCHUBLADE':56098041461011, 'ROLLCONTAINER':56098037606419
};
const generalSections = new Set([28279387698835,28279395260051,28279399178771]);
let cache;

function configured(shop) {
    return shop.mode === 'live' && shop.domain === DOMAIN && shop.id === 'ab805a4c-330a-4fb0-bd7c-b2a69ea98cf0' && Number(shop.customer_id) === 1080;
}

function plainText(html) {
    // Text is only model evidence, never rendered as HTML. Preserve table rows and cell boundaries.
    return html.replace(/<!--[^]*?-->/g,' ').replace(/<(script|style|iframe)\b[^>]*>[^]*?<\/\1\s*>/gi,' ')
        .replace(/<\/(td|th)\s*>/gi,' | ').replace(/<\/?(?:p|div|h[1-6]|li|tr|br|table|ul|ol)\b[^>]*>/gi,'\n')
        .replace(/<[^>]*>/g,' ').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|deg|times|sup2);/gi,(_,entity)=>{
            const key=entity.toLowerCase();
            if(key.startsWith('#')) { const n=key[1]==='x'?parseInt(key.slice(2),16):Number(key.slice(1));return n>=32&&n<=0x10ffff?String.fromCodePoint(n):' '; }
            return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',deg:'°',times:'×',sup2:'²'}[key];
        }).replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

async function index() {
    if(cache && cache.until>Date.now()) return cache.promise;
    const entry={until:Date.now()+300000};
    entry.promise=(async()=>{
        // shortcut: the pilot has 94 articles; add bounded same-origin pagination before the catalog exceeds 100.
        const response=await fetch(ORIGIN+'/api/v2/help_center/de/articles.json?per_page=100',{
            redirect:'error',signal:AbortSignal.timeout(4000),headers:{Accept:'application/json'}
        });
        if(!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error('zendesk_unavailable');
        let size=0;const chunks=[];
        for await(const chunk of response.body) {size+=chunk.length;if(size>2000000)throw Error('zendesk_too_large');chunks.push(chunk);}
        const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!Array.isArray(data.articles)) throw Error('zendesk_invalid');
        const articles=data.articles.slice(0,100).filter(a=>Number.isSafeInteger(a.id) && a.id>0 && a.draft===false &&
            a.user_segment_id===null && (!a.user_segment_ids || Array.isArray(a.user_segment_ids)&&!a.user_segment_ids.length) &&
            a.locale==='de' && !a.outdated && typeof a.title==='string' && typeof a.body==='string' && a.body.length<=100000)
            .map(a=>({id:String(a.id),sectionId:a.section_id,title:plainText(a.title).slice(0,200),body:plainText(a.body),
                url:`${ORIGIN}/hc/de/articles/${a.id}`,updatedAt:a.updated_at,
                mediaNotRead:/<(?:img|iframe)\b|\.pdf(?:["'?<#]|$)/i.test(a.body)}));
        return {articles,partial:Boolean(data.next_page || data.articles.length>100 || articles.length!==data.articles.length),fetchedAt:new Date().toISOString()};
    })().catch(()=>{entry.until=Date.now()+15000;return {status:'unavailable'};});
    cache=entry;
    return entry.promise;
}

function bounded(articles,limit) {
    let remaining=limit;
    return articles.map(a=>{const body=a.body.slice(0,Math.max(0,remaining));remaining-=body.length;
        return {...a,body:body || undefined,truncated:body.length<a.body.length};});
}

async function product(shop,title) {
    if(!configured(shop)) return {status:'not_configured'};
    const name=String(title || '').normalize('NFKC').trim().toUpperCase().replace(/^DESKSPACE\s+/,'').replace(/\s+/g,' ');
    // Exact family names only: PRO PLUS, PRO PLUS V3, refurbished and bundles must never be conflated.
    const sectionId=Object.hasOwn(sections,name)?sections[name]:null;
    const data=await index();
    if(data.status==='unavailable')return data;
    const productArticles=data.articles.filter(a=>a.sectionId===sectionId)
        .filter(a=>!Object.keys(sections).some(other=>other!==name && a.title.toUpperCase().endsWith('DESKSPACE '+other)))
        .sort((a,b)=>Number(/Produktdetails|Maße|Technische Daten|Material/i.test(b.title))-Number(/Produktdetails|Maße|Technische Daten|Material/i.test(a.title)));
    return {status:'loaded',source:'zendesk',locale:'de',matchedProduct:sectionId?name:null,
        productMatch:sectionId?(productArticles.length?'exact_family':'no_articles'):'unmapped',
        productArticles:bounded(productArticles,16000),shopArticles:bounded(data.articles.filter(a=>generalSections.has(a.sectionId)),20000),
        partial:data.partial,fetchedAt:data.fetchedAt};
}

function summary(result) {
    if(result.status!=='loaded')return result;
    const summarize=articles=>articles.map((a,i)=>({...a,body:i<2?a.body?.slice(0,900):undefined,
        truncated:a.truncated || Boolean(a.body&&(i>=2 || a.body.length>900))}));
    return {...result,productArticles:summarize(result.productArticles),shopArticles:result.shopArticles.map(a=>({...a,body:undefined,truncated:true}))};
}

module.exports={product,summary};
