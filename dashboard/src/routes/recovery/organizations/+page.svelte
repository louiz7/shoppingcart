<script lang="ts">
	import RecoveryShell from '$lib/components/RecoveryShell.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const overview = $derived(data.overview);
	const number = (value: number) => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value);
	const money = (cents: number, currency: string) => new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100);
	const stamp = $derived(overview?.asOf ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(overview.asOf)) : null);
	function organizationMetrics(organization: any) {
		const revenues = new Map<string, number>();
		let calls = 0, minutes = 0, unknown = 0;
		for (const shop of organization.shops) {
			calls += shop.calls; minutes += shop.connectedMinutes; unknown += shop.unknownDurationCalls;
			revenues.set(shop.currency, (revenues.get(shop.currency) || 0) + shop.attributedRevenueCents);
		}
		return { calls, minutes, unknown, revenues: [...revenues].sort(([a], [b]) => a.localeCompare(b)) };
	}
</script>

<svelte:head><title>Organisationen · Rescova</title><meta name="description" content="Interner Überblick über Organisationen, Shops und bestätigte Recovery-Ergebnisse." /></svelte:head>

<RecoveryShell active="organizations">
	<div class="title-row"><div><h1>Organisationen</h1><p>Shops und Recovery-Ergebnisse im Überblick.</p></div><a class="refresh" href="/recovery/organizations">Aktualisieren</a></div>
	{#if !overview}<div class="notice" role="alert"><p>{data.loadError}</p><a href="/recovery/organizations">Erneut versuchen</a></div>
	{:else}
		<!-- Four equal cells divide1088px; phone uses2 ×2. -->
		<section class="totals" aria-label="Organisationsüberblick"><div><span>Organisationen</span><strong>{number(overview.totals.organizations)}</strong></div><div><span>Verbundene Shops</span><strong>{number(overview.totals.shops)}</strong></div><div><span>Gestartete Anrufe</span><strong>{number(overview.totals.calls)}</strong></div><div><span>Bestätigte Minuten</span><strong>{number(overview.totals.connectedMinutes)}</strong></div></section>
		<section class="revenue" aria-labelledby="revenue-heading"><div><h2 id="revenue-heading">Zugeordneter Warenwert</h2><p>Bezahlter Warenwert nach verbundenen Gesprächen. Keine Schätzung zusätzlicher Verkäufe.</p></div><div class="revenue-values">{#if overview.totals.attributedRevenue.length}{#each overview.totals.attributedRevenue as row}<p><strong class:positive={row.amountCents > 0}>{money(row.amountCents, row.currency)}</strong><span>{row.orders} bestätigte Bestellungen · {row.currency}</span></p>{/each}{:else}<p class="no-revenue">Noch kein zugeordneter Warenwert.</p>{/if}</div></section>
		<div class="evidence"><p>Gesamter gespeicherter Zeitraum{stamp ? ` · Stand ${stamp}` : ''}</p><p>{overview.totals.unknownDurationCalls ? `${number(overview.totals.unknownDurationCalls)} Anrufe ohne bestätigte Dauer sind aus den Minuten ausgeschlossen.` : 'Anrufminuten enthalten ausschließlich bestätigte Gesprächsdauer.'}</p></div>
		<section class="organizations" aria-label="Organisationen und Shops">
			{#if !overview.organizations.length}<div class="empty"><h2>Noch keine Organisation angelegt</h2><p>Organisationen und ihre verbundenen Shops erscheinen hier nach der Einrichtung.</p></div>{/if}
			{#each overview.organizations as organization}
				{@const totals = organizationMetrics(organization)}
				<article class="organization"><header><div><h2>{organization.name}</h2><p>{organization.isInternal ? 'Rescova intern' : 'Händlerorganisation'} · {organization.active ? 'Aktiv' : 'Deaktiviert'}</p></div><span>{organization.shops.length} {organization.shops.length === 1 ? 'Shop' : 'Shops'}</span></header>
					<div class="organization-totals"><span>{number(totals.calls)} Anrufe</span><span>{number(totals.minutes)} Minuten{totals.unknown ? ` · ${number(totals.unknown)} Dauer offen` : ''}</span>{#each totals.revenues as [currency, cents]}<span>{money(cents, currency)} {currency}</span>{/each}</div>
					{#if organization.shops.length}<div class="shop-table"><div class="table-head"><span>Shop</span><span>Anrufe</span><span>Minuten</span><span>Zugeordneter Warenwert</span></div>{#each organization.shops as shop}<div class="shop-row"><div class="identity"><h3>{shop.brand}</h3><p>{shop.domain}</p><span class="shop-status">{shop.enabled ? 'Recovery freigegeben' : 'Recovery deaktiviert'}</span></div><div class="numeric"><span class="mobile-label">Anrufe</span><strong>{number(shop.calls)}</strong></div><div class="numeric"><span class="mobile-label">Minuten</span><strong>{number(shop.connectedMinutes)}</strong>{#if shop.unknownDurationCalls}<small>{number(shop.unknownDurationCalls)} Dauer offen</small>{/if}</div><div class="numeric revenue-cell"><span class="mobile-label">Zugeordneter Warenwert</span><strong>{money(shop.attributedRevenueCents, shop.currency)}</strong><small>{shop.confirmedOrders} Bestellungen · {shop.currency}</small></div></div>{/each}</div>{:else}<p class="no-shops">Noch kein Shopify-Shop verbunden.</p>{/if}
				</article>
			{/each}
		</section>
	{/if}
</RecoveryShell>

<style>
	h1{font-size:24px;line-height:1.3;font-weight:600;letter-spacing:-.6px;margin:0}h2{font-size:16px;line-height:1.5;font-weight:500;margin:0}h3{font-size:14px;font-weight:500;margin:0}.title-row{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:28px}.title-row p{color:var(--muted);margin:8px 0 0}.refresh{min-height:44px;display:inline-flex;align-items:center;padding:10px 16px;border:1px solid var(--control);border-radius:6px;text-decoration:none;color:var(--text);font-size:13px;background:var(--surface)}.refresh:hover{border-color:var(--text)}
	.totals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden}.totals>div{padding:24px}.totals>div+div{border-left:1px solid var(--border)}.totals span{display:block;color:var(--muted);font-size:13px}.totals strong{display:block;margin-top:12px;font-size:30px;line-height:1.2;font-weight:400;font-variant-numeric:tabular-nums;letter-spacing:-.6px}
	.revenue{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;padding:28px 0 16px;align-items:start}.revenue>div>p{color:var(--muted);max-width:600px;margin:8px 0 0;font-size:13px;line-height:1.6}.revenue-values{text-align:right}.revenue-values>p{margin:0 0 12px}.revenue-values strong{display:block;font-size:20px;font-weight:400;font-variant-numeric:tabular-nums;color:var(--text)}.revenue-values strong.positive{color:var(--accent)}.revenue-values span{display:block;color:var(--muted);font-size:13px;margin-top:4px}.revenue-values .no-revenue{color:var(--muted);font-size:13px}.evidence{border-bottom:1px solid var(--border);padding-bottom:24px;margin-bottom:28px}.evidence p{margin:0 0 4px;color:var(--muted);font-size:13px}
	.organizations{display:flex;flex-direction:column;gap:24px}.organization{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}.organization>header{padding:24px 28px 16px;display:flex;align-items:baseline;justify-content:space-between;gap:20px}.organization>header p{font-size:13px;color:var(--muted);margin:6px 0 0}.organization>header>span{color:var(--muted);font-size:13px;flex:none}.shop-table{padding:0 28px 8px}.table-head,.shop-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,.6fr) minmax(0,.8fr) minmax(0,1.3fr);gap:24px;align-items:start}.table-head{padding:8px 0;color:var(--muted);font-size:13px}.table-head span:not(:first-child){text-align:right}.shop-row{padding:20px 0;border-top:1px solid var(--border)}.identity{min-width:0}.identity p{font-size:13px;color:var(--muted);margin:4px 0;overflow-wrap:anywhere}.shop-status{font-size:13px;color:var(--muted)}.numeric{text-align:right;font-variant-numeric:tabular-nums}.numeric strong{font-size:14px;font-weight:400;display:block}.numeric small{font-size:13px;color:var(--muted);display:block;margin-top:4px}.mobile-label{display:none}.no-shops{color:var(--muted);font-size:13px;padding:8px 28px 24px;margin:0}.notice,.empty{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:24px}.notice p,.empty p{color:var(--muted);margin:0 0 8px}.notice a{color:var(--text);text-underline-offset:3px}
	.organization-totals{display:flex;gap:20px;flex-wrap:wrap;padding:0 28px 16px;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums}.organization-totals span{white-space:nowrap}
	a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
	@media(max-width:768px){.totals>div{padding:20px}.table-head,.shop-row{gap:16px;grid-template-columns:minmax(0,1.4fr) minmax(0,.6fr) minmax(0,.8fr) minmax(0,1.2fr)}.organization>header{padding:20px 24px 16px}.shop-table{padding-inline:24px}.revenue{gap:24px}}
	@media(max-width:540px){.title-row{align-items:flex-start;gap:16px;flex-wrap:wrap}.totals{grid-template-columns:repeat(2,minmax(0,1fr))}.totals>div:nth-child(3){border-left:0;border-top:1px solid var(--border)}.totals>div:nth-child(4){border-top:1px solid var(--border)}.totals strong{font-size:28px}.revenue{grid-template-columns:1fr;gap:16px}.revenue-values{text-align:left}.organization>header{padding:20px}.shop-table{padding:0 20px 4px}.table-head{display:none}.shop-row{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.identity{grid-column:1/-1}.mobile-label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}.numeric{text-align:left}.revenue-cell{grid-column:1/-1;text-align:right}.revenue-cell .mobile-label{float:left;margin:0}.organization-totals{padding-inline:20px;gap:8px 16px}.no-shops{padding-inline:20px}}
</style>
