'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const shop={id:'ab805a4c-330a-4fb0-bd7c-b2a69ea98cf0',customer_id:1080,domain:'desqup.myshopify.com',mode:'live'};
const load=()=>{delete require.cache[require.resolve('../src/recovery/zendesk')];return require('../src/recovery/zendesk');};
const article=(id,sectionId,title,body='<p>Public facts.</p>',extra={})=>({id,section_id:sectionId,title,body,
    draft:false,user_segment_id:null,locale:'de',outdated:false,updated_at:'2026-01-01T00:00:00Z',...extra});
const response=articles=>new Response(JSON.stringify({articles,next_page:null}),{headers:{'Content-Type':'application/json'}});

test('article links come only from verified product knowledge, never from caller-provided URLs',()=>{
    const kb=load(),article={id:'123',title:'Garantie',url:'https://support.deskspace.de/hc/de/articles/123'};
    const details={status:'loaded',supportKnowledge:{status:'loaded',source:'zendesk',productArticles:[article],shopArticles:[]}};
    assert.deepEqual(kb.articleLink(details,'123'),{articleId:'123',title:'Garantie',url:article.url});
    for(const id of ['https://evil.invalid','../123','0','9007199254740992',123]) assert.throws(()=>kb.articleLink(details,id),{code:'invalid_help_article'});
    assert.throws(()=>kb.articleLink(details,'124'),{code:'help_article_unavailable'});
    assert.throws(()=>kb.articleLink({status:'unavailable'},'123'),{code:'help_article_unavailable'});
    article.url='https://support.deskspace.de.evil.invalid/hc/de/articles/123';
    assert.throws(()=>kb.articleLink(details,'123'),{code:'help_article_unavailable'});
});

test('Zendesk only loads the configured live tenant, never another customer or the snowboard demo',async t=>{
    const fetch=t.mock.method(global,'fetch',async()=>{throw Error('must not fetch');});const kb=load();
    for(const s of [{...shop,customer_id:1},{...shop,id:'other'},{...shop,domain:'test-store-slzn5m7l.myshopify.com'},{...shop,mode:'demo'}]) {
        assert.equal((await kb.product(s,'PRO')).status,'not_configured');
    }
    assert.equal(fetch.mock.calls.length,0);
});

test('exact family matching preserves table context and public source metadata; concurrent reads share the cache',async t=>{
    const read=t.mock.method(global,'fetch',async(url,options)=>{
        assert.equal(url,'https://support.deskspace.de/api/v2/help_center/de/articles.json?per_page=100');
        assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,undefined);
        return response([article(1,28360741688595,'Produktdetails | DESKSPACE PRO PLUS','<table><tr><th>Breite</th><th>Höhe</th></tr><tr><td>120 cm</td><td>70 cm</td></tr></table><p>A &amp; B &#176;</p>'),
            article(2,28359213507475,'Produktdetails | DESKSPACE PRO'),article(3,57048348889235,'Anleitung | DESKSPACE PRO PLUS V3'),
            article(4,28279387698835,'Liefergebiete')]);
    });const kb=load();
    const [a,b]=await Promise.all([kb.product(shop,'PRO PLUS'),kb.product(shop,'DESKSPACE PRO PLUS')]);
    assert.deepEqual(a,b);assert.equal(read.mock.calls.length,1);
    assert.deepEqual(a.productArticles.map(a=>a.id),['1']);assert.equal(a.matchedProduct,'PRO PLUS');
    assert.match(a.productArticles[0].body,/Breite \| Höhe \|\n+120 cm \| 70 cm/);
    assert.match(a.productArticles[0].body,/A & B °/);assert.equal(a.productArticles[0].updatedAt,'2026-01-01T00:00:00Z');
    assert.equal(a.productArticles[0].url,'https://support.deskspace.de/hc/de/articles/1');
    assert.deepEqual(a.shopArticles.map(a=>a.id),['4']);
    assert.deepEqual((await kb.product(shop,'PRO PLUS V3')).productArticles.map(a=>a.id),['3']);
    assert.equal(read.mock.calls.length,1);
});

test('unmapped versions, bundles and refurbished products never inherit family specifications',async t=>{
    t.mock.method(global,'fetch',async()=>response([article(1,28360741688595,'Produktdetails | DESKSPACE PRO PLUS'),article(2,28279387698835,'Lieferung')]));
    const kb=load();
    for(const title of ['PRO PLUS – Neues Modell','MOVE PRO – Refurbished','Titan Packages','WOBBLE','constructor']) {
        const a=await kb.product(shop,title);assert.equal(a.productMatch,'unmapped');assert.deepEqual(a.productArticles,[]);assert.equal(a.shopArticles.length,1);
    }
});

test('private, draft, outdated, non-German and malformed articles stay out of model evidence',async t=>{
    t.mock.method(global,'fetch',async()=>response([
        article(1,28359213507475,'Public'),article(2,28359213507475,'SECRET',{},{draft:true}),
        article(3,28359213507475,'SECRET','hidden',{user_segment_id:9}),
        article(4,28359213507475,'SECRET','hidden',{user_segment_ids:[9]}),
        article(5,28359213507475,'SECRET','old',{outdated:true}),
        article(6,28359213507475,'SECRET','english',{locale:'en-us'}),
        article('bad',28359213507475,'SECRET'),
        article(8,28359213507475,'SECRET','missing',{user_segment_id:undefined})
    ]));const a=await load().product(shop,'PRO');assert.deepEqual(a.productArticles.map(a=>a.id),['1']);
    assert.doesNotMatch(JSON.stringify(a),/SECRET|hidden/);assert.equal(a.partial,true);
});

test('mislabeled section content does not cross product families',async t=>{
    t.mock.method(global,'fetch',async()=>response([article(1,48229566241811,'Garantie | DESKSPACE EXECUTIVE'),
        article(2,48229566241811,'Maße | DESKSPACE EXECUTIVE LITE')]));
    const a=await load().product(shop,'EXECUTIVE LITE');assert.deepEqual(a.productArticles.map(a=>a.id),['2']);
});

test('context summaries signal missing detail; scripts and media are not treated as inspected facts',async t=>{
    t.mock.method(global,'fetch',async()=>response([article(1,28359213507475,'Details','<script>SECRET</script><p>'+('a'.repeat(20000))+'</p><img src="https://other.invalid/img"><a href="x.pdf">Anleitung</a>')]));
    const kb=load(),full=await kb.product(shop,'PRO'),summary=kb.summary(full);
    assert.equal(full.productArticles[0].body.length,16000);assert.equal(full.productArticles[0].truncated,true);
    assert.equal(full.productArticles[0].mediaNotRead,true);assert.equal(summary.productArticles[0].body.length,900);
    assert.equal(summary.productArticles[0].truncated,true);assert.doesNotMatch(JSON.stringify(full),/SECRET|other.invalid/);
});

test('errors fail visibly without leaking provider messages and without retrying every turn',async t=>{
    const read=t.mock.method(global,'fetch',async()=>{throw Error('SECRET_PROVIDER_DETAIL');});const kb=load();
    assert.deepEqual(await kb.product(shop,'PRO'),{status:'unavailable'});await kb.product(shop,'MOVE');assert.equal(read.mock.calls.length,1);
});

test('oversized or malformed responses are bounded; pagination is explicit rather than followed blindly',async t=>{
    let value=new Response('x'.repeat(2000001),{headers:{'Content-Type':'application/json'}});
    t.mock.method(global,'fetch',async()=>value);
    assert.deepEqual(await load().product(shop,'PRO'),{status:'unavailable'});
    value=new Response(JSON.stringify({articles:[article(1,28359213507475,'Data')],next_page:'http://127.0.0.1/private'}),{headers:{'Content-Type':'application/json'}});
    assert.equal((await load().product(shop,'PRO')).partial,true);
});
