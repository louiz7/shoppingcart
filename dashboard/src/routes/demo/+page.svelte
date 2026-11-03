<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { Room } from 'livekit-client';
    import type { PageProps } from './$types';
    let { data }: PageProps = $props();
    let phase = $state('idle'), error = $state(''), agentState = $state('connecting');
    let session = $state<any>(null), muted = $state(false), seconds = $state(300);
    let room: Room | null = null, poll: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setInterval> | undefined;
    let audioHost: HTMLDivElement, generation = 0;
    const demo = $derived(session || data.demo);
    const money = (n: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: demo?.cart?.currency || 'USD' }).format(n / 100);
    const activityLabels: Record<string, string> = { confirm_contact: 'Gespräch gestartet', context: 'Warenkorb geladen', search_products: 'Alternativen geprüft', product_details: 'Produktdetails geprüft', shop_policies: 'Shoprichtlinien geprüft', prepare_checkout: 'Neuen Warenkorb vorbereitet', offer: 'Rabatt geprüft', send_link: 'Checkout-Link bereitgestellt', stop: 'Kontaktstopp simuliert', outcome: 'Gespräch abgeschlossen', order_status: 'Bestellstatus geprüft' };
    const statusText = $derived(phase === 'connecting' ? 'Verbindung wird aufgebaut' : phase === 'connected' ? (({ speaking: 'Agent spricht', thinking: 'Agent prüft dein Anliegen', listening: 'Agent hört zu' } as Record<string,string>)[agentState] || 'Agent wird verbunden') : phase === 'ended' ? 'Gespräch beendet' : 'Bereit für dein Gespräch');
    async function stop(send = true) {
        generation++;
        clearTimeout(poll); clearInterval(tick);
        const current = room; room = null;
        await current?.disconnect();
        audioHost?.replaceChildren();
        phase = 'ended'; muted = false;
        if (send) await fetch('/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'end' }), keepalive: true }).catch(() => {});
    }
    async function refresh(run: number) {
        if (run !== generation || phase !== 'connected') return;
        try {
            const response = await fetch('/demo/session', { cache: 'no-store' });
            const value = await response.json();
            if (run !== generation) return;
            session = { ...session, ...value };
            if (value.ended) { await stop(false); return; }
        } catch { /* Voice continues through a transient dashboard network failure. */ }
        if (run === generation) poll = setTimeout(() => refresh(run), 2000);
    }
    async function start() {
        error = ''; phase = 'connecting'; session = null;
        const run = ++generation;
        try {
            // Permission is requested before allocating a paid agent session.
            const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
            mic.getTracks().forEach(t => t.stop());
            const { Room, RoomEvent, Track } = await import('livekit-client');
            const response = await fetch('/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error);
            if (run !== generation) return;
            session = value;
            const current = new Room(); room = current;
            current.on(RoomEvent.TrackSubscribed, track => { if (track.kind === Track.Kind.Audio) audioHost.appendChild(track.attach()); });
            current.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(el => el.remove()));
            current.on(RoomEvent.ParticipantAttributesChanged, (attrs) => { if (attrs['lk.agent.state']) agentState = attrs['lk.agent.state']; });
            current.on(RoomEvent.Disconnected, () => { if (room === current) void stop(); });
            await current.connect(value.url, value.token);
            await current.startAudio();
            await current.localParticipant.setMicrophoneEnabled(true);
            if (run !== generation) { await current.disconnect(); return; }
            phase = 'connected';
            tick = setInterval(() => { seconds = Math.max(0, Math.ceil((Date.parse(value.expiresAt) - Date.now()) / 1000)); if (!seconds) void stop(); }, 1000);
            void refresh(run);
        } catch (e) {
            await stop();
            error = e instanceof DOMException && ['NotAllowedError','NotFoundError'].includes(e.name) ? 'Bitte erlaube den Mikrofonzugriff und prüfe, ob ein Mikrofon angeschlossen ist.' : e instanceof Error ? e.message : 'Die Verbindung ist fehlgeschlagen.';
        }
    }
    async function toggleMute() { if (room) { try { await room.localParticipant.setMicrophoneEnabled(muted); muted = !muted; } catch { error = 'Das Mikrofon konnte nicht umgeschaltet werden.'; } } }
    onDestroy(() => { void stop(); });
</script>

<!-- Same-origin form POSTs need Origin; external requests still send no referrer. -->
<svelte:head><meta name="referrer" content="same-origin" /><title>Rescova · Agent ausprobieren</title><meta name="robots" content="noindex,nofollow" /><meta name="description" content="Sprich mit dem aktuellen Rescova-Agenten über einen echten Testwarenkorb." /></svelte:head>
<main class="demo-page">
    <header><a class="wordmark" href="/demo" aria-label="Rescova Demo">rescova<span>.</span></a><a class="login" href="/login">Zum Dashboard <span aria-hidden="true">↗</span></a></header>
    <div class="intro"><div><p class="eyebrow">Rescova / KI-Demo</p><h1>Ausprobieren.<br /><span>Einfach sprechen.</span></h1></div><p>Du bist der Kunde. Unser Agent hilft dir weiter — mit den Produkten aus dem aktuellen Testwarenkorb.</p></div>
    <div class="workspace">
        <section class="conversation" aria-labelledby="conversation-title">
            <div class="section-top"><h2 id="conversation-title">Dein Gespräch</h2><span>{phase === 'connected' ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Bis zu 5 Minuten'}</span></div>
            <div class="voice-area">
                <div class="voice-mark" class:speaking={phase === 'connected' && agentState === 'speaking'} aria-hidden="true">{#each [25,48,74,100,66,42,22] as height, i}<i style={`--height:${height}px;--delay:${i * 95}ms`}></i>{/each}</div>
                <p class="agent-name">{demo?.agentProfile?.name || 'Jake'}</p><p class="agent-description">KI-Demo · {demo?.agentProfile?.persona === 'founder' ? 'Gründerrolle' : 'Shop-Beratung'}{demo?.brand ? ` bei ${demo.brand}` : ''}</p>
                <p class="status" role="status"><span class:live={phase === 'connected'}></span>{statusText}</p>
                <div class="controls">{#if phase === 'connected'}<button class="secondary" onclick={toggleMute}>{muted ? 'Mikrofon an' : 'Stummschalten'}</button><button class="primary" onclick={() => stop()}>Gespräch beenden</button>{:else}<button class="primary" disabled={phase === 'connecting' || data.unavailable} onclick={start}>{phase === 'connecting' ? 'Verbinde …' : phase === 'ended' ? 'Noch einmal sprechen' : 'Gespräch starten'}<span aria-hidden="true">↗</span></button>{/if}</div>
                {#if data.unavailable}<p class="error" role="alert">Der Testwarenkorb ist gerade nicht verfügbar. Bitte lade die Seite später neu.</p>{/if}
                {#if error}<p class="error" role="alert">{error}</p>{/if}
            </div>
        </section>
        <aside class="cart-panel">
            <div class="section-top"><h2>Dein Testwarenkorb</h2><span>Shopify</span></div>
            {#if demo?.cart}<div class="cart-items">{#each demo.cart.items as item}<article class="cart-item"><div class="item-quantity">{item.quantity}<span>×</span></div><div><h3>{item.title}</h3>{#if item.variantTitle && item.variantTitle !== 'Default Title'}<p>{item.variantTitle}</p>{/if}</div><strong>{money(item.currentPriceCents * item.quantity)}</strong></article>{/each}</div><div class="total"><span>Warenwert</span><strong>{money(demo.cart.subtotalCents)}</strong></div><p class="fine">Versand und Steuern werden im Checkout bestätigt. Produktdaten werden beim Start aus Shopify geladen.</p>{:else}<p class="fine">Warenkorb momentan nicht verfügbar.</p>{/if}
            <div class="link-panel"><h2>Dein nächster Schritt</h2>{#if session?.checkout}<p>{session.checkout.discountPercent ? `${session.checkout.discountPercent} % Rabatt sind im Link hinterlegt.` : 'Dein Link ist ohne zusätzlichen Rabatt vorbereitet.'}</p>{#if data.unlockAvailable}<form action="/demo/unlock" method="POST" target="_blank" rel="noopener"><button class="checkout" type="submit">1. Testshop entsperren <span aria-hidden="true">↗</span></button></form>{/if}<a class="checkout" href={session.checkout.url} target="_blank" rel="noopener noreferrer">{data.unlockAvailable ? '2. Checkout öffnen' : 'Testcheckout öffnen'} <span aria-hidden="true">↗</span></a><p class="fine">{data.unlockAvailable ? 'Nur im Testshop: einmal entsperren, dann hierher zurückkehren und den Checkout öffnen.' : 'Der Testshop verlangt ein Besucherpasswort.'} In freigeschalteten Live-Shops führt der Link direkt zum Checkout.</p>{:else}<p>Wenn du im Gespräch einen Checkout-Link möchtest, erscheint er hier.</p>{/if}</div>
            {#if session?.activity?.length}<div class="activity"><h2>Im Gespräch</h2>{#each session.activity.slice(-3) as item}<p><span aria-hidden="true">✓</span>{activityLabels[item.name] || 'Anliegen bearbeitet'}</p>{/each}</div>{/if}
        </aside>
    </div>
    <footer><p>Echter Agent. Echte Produktdaten. Simulierter Kontakt.</p><p>Keine echten SMS oder Kundenanrufe; Checkout-Links erscheinen hier im Browser.</p></footer>
    <div bind:this={audioHost} class="audio-host"></div>
</main>

<style>
    :global(body){margin:0;background:#101112;color:#ededeb}.demo-page{max-width:1200px;margin:auto;padding:32px 40px 24px;min-height:100svh;box-sizing:border-box;font-family:Inter,system-ui,sans-serif}header{display:flex;align-items:center;justify-content:space-between}.wordmark{color:#f3f3f0;font-weight:650;letter-spacing:-2px;font-size:30px;text-decoration:none}.wordmark span{color:#a4bcae}.login{color:#aaaead;font-size:13px;text-decoration:none}.login span{margin-left:12px}.intro{display:flex;justify-content:space-between;align-items:flex-end;gap:48px;margin:58px 0 32px}.eyebrow{color:#9daba5;font-size:12px;margin:0 0 16px}h1{font-size:32px;line-height:1.1;letter-spacing:-1.8px;font-weight:500;margin:0}h1 span{color:#a2a5a3}.intro>p{font-size:14px;line-height:1.7;color:#a5a8a7;max-width:295px;margin:0 0 4px}.workspace{display:grid;grid-template-columns:1.35fr 1fr;border:1px solid #323534;border-radius:12px;overflow:hidden;background:#181a1b}.conversation{min-width:0;border-right:1px solid #323534}.section-top{padding:22px 26px;display:flex;align-items:center;justify-content:space-between;gap:12px}.section-top h2,h2{font-size:13px;font-weight:500;margin:0}.section-top>span{font-size:12px;color:#929995;font-variant-numeric:tabular-nums}.voice-area{padding:30px 24px 32px;text-align:center}.voice-mark{height:100px;display:flex;align-items:center;justify-content:center;gap:7px;margin:0 0 27px}.voice-mark i{display:block;width:10px;height:var(--height);background:#b7c9c0;border-radius:8px;transform:scaleY(.7)}.voice-mark.speaking i{animation:voice .65s ease-in-out infinite alternate;animation-delay:var(--delay)}@keyframes voice{from{transform:scaleY(.25)}to{transform:scaleY(1)}}.agent-name{font-size:24px;font-weight:500;margin:0 0 8px;letter-spacing:-.5px}.agent-description{color:#979e9a;font-size:13px;margin:0}.status{display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:#b7beba;margin:26px 0 20px}.status>span{width:6px;height:6px;border-radius:50%;background:#6d7570}.status>span.live{background:#add2b8}.controls{display:flex;gap:10px;justify-content:center}button{font:inherit;font-size:13px;cursor:pointer;border-radius:6px;min-height:44px;padding:12px 18px}.primary{background:#ededeb;border:1px solid #ededeb;color:#171918;display:flex;align-items:center;justify-content:center;gap:30px}.secondary{background:transparent;border:1px solid #555b57;color:#d6dad7}button:disabled{opacity:.5;cursor:wait}button:focus-visible,a:focus-visible{outline:2px solid #c7dfd1;outline-offset:4px}.primary:hover:not(:disabled){background:#d5ddd8}.cart-panel{min-width:0}.cart-items{padding:2px 26px}.cart-item{display:grid;grid-template-columns:32px 1fr auto;align-items:center;gap:12px;padding:20px 0;border-bottom:1px solid #2c302e}.item-quantity{color:#b8bfba;font-size:16px}.item-quantity span{font-size:12px;margin-left:4px;color:#737c76}.cart-item h3{font-size:13px;line-height:1.5;margin:0;font-weight:400;overflow-wrap:anywhere}.cart-item p{font-size:12px;color:#939b95;margin:5px 0 0}.cart-item strong{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums}.total{display:flex;justify-content:space-between;gap:12px;padding:22px 26px 8px;font-size:13px}.total strong{font-size:20px;font-weight:500;letter-spacing:-.5px;font-variant-numeric:tabular-nums}.fine{color:#929a94;font-size:12px;line-height:1.6;margin:8px 26px 22px}.link-panel{border-top:1px solid #323534;padding:22px 26px}.link-panel>p{font-size:13px;color:#a4ada6;line-height:1.7;max-width:290px}.link-panel .fine{margin:12px 0 0;font-size:12px}.checkout{font-size:13px;color:#d9eee1;display:flex;justify-content:space-between;margin-top:18px;text-decoration:none;padding-bottom:10px;border-bottom:1px solid #6b7e71}.link-panel button.checkout{width:100%;background:transparent;border:0;border-bottom:1px solid #6b7e71;border-radius:0;padding:0 0 10px;min-height:44px;align-items:center;text-align:left}.activity{padding:0 26px 20px}.activity p{font-size:12px;color:#a8b5ac;display:flex;gap:10px}footer{display:flex;justify-content:space-between;gap:40px;margin-top:24px}footer p{color:#8c948e;font-size:12px;line-height:1.7;margin:0}footer p:first-child{white-space:nowrap;color:#b4bcb6}footer p:last-child{max-width:560px}.error{max-width:400px;margin:18px auto 0;font-size:12px;color:#f0b8a9;line-height:1.6}.audio-host{display:none}@media(max-width:800px){.demo-page{padding:24px}.intro{margin:40px 0 26px;gap:24px}h1{font-size:32px}.intro>p{font-size:12px;max-width:220px}.workspace{grid-template-columns:1fr 1fr}.section-top,.link-panel{padding-left:20px;padding-right:20px}.cart-items{padding:2px 20px}.cart-item{grid-template-columns:24px 1fr;gap:8px}.cart-item strong{grid-column:2}.total{padding-left:20px;padding-right:20px}.fine{margin-left:20px;margin-right:20px}footer{display:block}footer p+p{margin-top:8px}}@media(max-width:560px){.demo-page{padding:22px 16px}.intro{display:block;margin-top:36px}.intro>p{max-width:310px;margin-top:18px}.workspace{grid-template-columns:1fr}.conversation{border-right:0;border-bottom:1px solid #323534}.voice-area{padding:20px 16px 28px}.voice-mark{height:80px}.cart-item{grid-template-columns:24px 1fr auto}.cart-item strong{grid-column:auto}.controls{flex-wrap:wrap}h1{font-size:28px}.section-top{padding-top:20px;padding-bottom:20px}}@media(prefers-reduced-motion:reduce){.voice-mark.speaking i{animation:none}}
</style>
