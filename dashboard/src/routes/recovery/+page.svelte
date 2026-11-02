<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let selectedShop = $state('');
	let refreshing = $state(false);
	let refreshFailed = $state(false);
	const shops = $derived(data.summary?.shops || []);
	const shop = $derived(shops.find((item: any) => item.id === selectedShop) || shops[0]);
	const zone = $derived(shop?.timeZone || 'Europe/Berlin');
	const failed = $derived(!!data.loadError || refreshFailed);
	const number = (value: number) => new Intl.NumberFormat('de-DE').format(value);
	const day = $derived(shop?.date
		? new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(shop.date + 'T12:00:00Z'))
		: new Intl.DateTimeFormat('de-DE', { dateStyle: 'full', timeZone: zone }).format(new Date()));
	const updated = $derived(data.summary?.asOf
		? new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(data.summary.asOf))
		: null);
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try { await invalidateAll(); refreshFailed = false; }
		catch { refreshFailed = true; }
		finally { refreshing = false; }
	}
	onMount(() => {
		const timer = setInterval(() => { void refresh(); }, 30_000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head>
	<title>Rescova · Tagesüberblick</title>
	<meta name="description" content="Deine heutigen Recovery-Anrufe und bestätigten Abschlüsse." />
</svelte:head>

<div class="daily-app" data-app>
	<header class="topbar">
		<div class="topbar-inner">
			<a href="/recovery" class="wordmark" aria-label="Rescova Tagesüberblick">
				<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.5 8.5A8 8 0 0 0 5 6.7M4.5 15.5A8 8 0 0 0 19 17.3M5 2.8v4.4h4.4M19 21.2v-4.4h-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
				rescova<span>.</span>
			</a>
			<form method="POST" action="/logout"><button class="logout">Abmelden</button></form>
		</div>
	</header>
	<main>
		<div class="scope-row">
			{#if shops.length > 1}
				<label class="shop-choice">Shop<select bind:value={selectedShop} aria-label="Shop auswählen"><option value="">{shops[0].brand}</option>{#each shops.slice(1) as item}<option value={item.id}>{item.brand}</option>{/each}</select></label>
			{:else}
				<p class="shop-name">{shop?.brand || 'Dein Shop'}</p>
			{/if}
			<p class="shop-domain">{shop?.domain || ''}</p>
		</div>
		<div class="title-row">
			<div><h1>Heute im Überblick</h1><p class="date">{day}</p></div>
			<button class="refresh" onclick={refresh} disabled={refreshing} aria-label="Heutige Zahlen aktualisieren">
				<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M15.5 6.5A6.3 6.3 0 1 0 16 12M15.5 2.8v4.4h-4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
				{refreshing ? 'Aktualisiere …' : 'Aktualisieren'}
			</button>
		</div>
		<!-- Two equal columns: 2 × (canvas / 2) = full canvas; phone keeps one shared edge. -->
		<section class="metrics" aria-label="Heutige Recovery-Ergebnisse" aria-busy={refreshing}>
			<article class="metric">
				<h2>Anrufe heute</h2>
				<p class="figure" class:missing={failed}>{failed ? '—' : number(shop?.callsToday ?? 0)}</p>
				<p class="definition">Tatsächlich gestartete Anrufe</p>
			</article>
			<article class="metric">
				<h2>Bestätigte Abschlüsse</h2>
				<p class="figure" class:missing={failed} class:positive={!failed && shop?.confirmedCheckoutsToday > 0}>{failed ? '—' : number(shop?.confirmedCheckoutsToday ?? 0)}</p>
				<p class="definition">Nach verbundenem Gespräch bezahlt</p>
			</article>
			{#if failed}<div class="metric-error" role="alert"><span>{data.loadError || 'Die Aktualisierung ist fehlgeschlagen.'}</span><button onclick={refresh} disabled={refreshing}>Erneut versuchen</button></div>{/if}
		</section>
		<div class="freshness"><span>{updated ? `Stand ${updated} Uhr` : 'Noch kein Datenstand'} · {zone}</span><span>Aktualisiert sich automatisch</span></div>
		<p class="attribution">Abschlüsse werden heute gezählt, wenn Shopify die Zahlung für den ursprünglichen Warenkorb nach einem verbundenen Gespräch innerhalb von 7 Tagen bestätigt.</p>
	</main>
	<footer>Persönliche Gespräche. Zurück zum Warenkorb.</footer>
</div>

<style>
	.daily-app{--ground:#f5f7f5;--surface:#fff;--text:#17211b;--muted:#5e6861;--border:#e4e9e5;--control:#cbd3cd;--accent:#28623c;min-height:100svh;background:var(--ground);color:var(--text);font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.5;display:flex;flex-direction:column}
	.daily-app :global(*){box-sizing:border-box}
	.topbar{border-bottom:1px solid var(--border)}
	.topbar-inner,main,footer{width:min(1088px,calc(100% - 80px));margin-inline:auto}
	.topbar-inner{min-height:72px;display:flex;align-items:center;justify-content:space-between}
	.wordmark{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--text);font-size:23px;font-weight:600;letter-spacing:-.8px}
	.wordmark svg{width:23px;height:23px;margin-right:2px}.wordmark span{margin-left:-8px;color:var(--accent)}
	button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:wait}
	.logout{min-height:44px;border:0;background:transparent;color:var(--muted);padding:8px 0 8px 16px;font-size:13px}
	main{padding-block:48px 32px}
	.scope-row{display:flex;align-items:baseline;gap:12px;margin-bottom:24px;flex-wrap:wrap}.scope-row p{margin:0}.shop-name{font-weight:500}.shop-domain{font-size:12px;color:var(--muted)}
	.shop-choice{display:flex;align-items:center;gap:12px;font-size:13px}.shop-choice select{height:40px;padding:0 32px 0 12px;background:var(--surface);border:1px solid var(--control);border-radius:6px;color:var(--text);max-width:100%}
	.title-row{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:24px}h1{font-size:24px;line-height:1.3;letter-spacing:-.6px;font-weight:600;margin:0}.date{margin:8px 0 0;color:var(--muted);font-size:14px}
	.refresh{height:44px;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--text);color:var(--surface);border:1px solid var(--text);border-radius:6px;flex:none;font-size:13px;min-width:146px}.refresh svg{width:17px;height:17px}.refresh:hover:not(:disabled){background:#303d34}.refresh:disabled{color:#d2dad4}
	.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden}.metric{padding:28px 32px}.metric+.metric{border-left:1px solid var(--border)}h2{margin:0;font-size:14px;font-weight:500;color:var(--muted)}.figure{font-size:40px;line-height:1.2;font-weight:400;font-variant-numeric:tabular-nums;letter-spacing:-1px;margin:16px 0 8px}.figure.positive{color:var(--accent)}.figure.missing{font-size:24px;line-height:48px;color:var(--muted);letter-spacing:0}.definition{margin:0;color:var(--muted);font-size:13px}
	.freshness{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:16px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.attribution{max-width:760px;color:var(--muted);font-size:12px;line-height:1.7;margin:24px 0 0}.metric-error{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid var(--border);padding:16px 32px;font-size:13px;color:var(--muted)}.metric-error button{min-height:44px;color:var(--text);background:none;border:0;text-decoration:underline;font-size:13px;flex:none}
	footer{margin-top:auto;padding-block:24px;font-size:12px;color:var(--muted)}
	a:focus-visible,button:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
	@media(max-width:768px){.topbar-inner,main,footer{width:calc(100% - 40px)}main{padding-top:32px}.metric{padding:24px}.shop-domain{overflow-wrap:anywhere}}
	@media(max-width:480px){.topbar-inner{min-height:64px}.scope-row{margin-bottom:24px;gap:4px;flex-direction:column}.title-row{align-items:flex-start;gap:16px;flex-wrap:wrap}.refresh{min-width:0;min-height:44px}h1{font-size:22px}.date{font-size:13px}.metrics{grid-template-columns:1fr}.metric{padding:24px}.metric+.metric{border-left:0;border-top:1px solid var(--border)}.figure{font-size:36px}.metric-error{padding:16px 24px;flex-direction:column;align-items:flex-start;gap:0}.freshness{font-size:12px}.freshness span:last-child{display:none}footer{padding-block:20px}}
</style>
