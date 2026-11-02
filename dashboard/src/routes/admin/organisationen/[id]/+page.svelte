<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import LiveRefresh from '$lib/components/LiveRefresh.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;
</script>

<svelte:head>
	<title>{data.organization.name} · Organisationen · Rescova</title>
</svelte:head>

<div class="detail-shell">
	<LiveRefresh />
	<Sidebar navigation={data.navigation} campaignNavigation={data.campaignNavigation} activeItem="Organisationen" />
	<main class="workspace">
		<header class="topbar">
			<BackButton />
			<div>
				<h1 class="type-page-heading">{data.organization.name}</h1>
				<p class="type-text-small">{data.organization.email}</p>
			</div>
		</header>

		<div class="content">
			<a class="back-link type-text" href="/admin/organisationen">← Alle Organisationen</a>

			<section class="voice-card" aria-labelledby="voice-title">
				<div>
					<h2 id="voice-title" class="type-heading">Interne Agent-Konfiguration</h2>
					<p class="type-text-small">Nur für die Rescova-Administration sichtbar. Kunden können den System-Prompt weder sehen noch verändern. Feste Sicherheits- und Identitätsregeln werden serverseitig ergänzt.</p>
				</div>
				<form method="POST" action="?/setVoiceConfig" class="voice-form">
					<label class="type-text-small-semi" for="displayName">Gesprochener Organisationsname
						<input id="displayName" name="displayName" minlength="2" maxlength="160" required value={data.voiceConfig.displayName} />
					</label>
					<label class="type-text-small-semi" for="promptInstructions">Organisationsspezifische Zusatzanweisungen
						<textarea id="promptInstructions" name="promptInstructions" maxlength="10000" rows="7" placeholder="Optional: Tonalität, zulässige Formulierungen und besondere Gesprächshinweise">{data.voiceConfig.promptInstructions}</textarea>
					</label>
					<label class="voice-enabled type-text">
						<input type="checkbox" name="enabled" value="true" checked={data.voiceConfig.enabled} />
						<span><strong class="type-text-semi">Voice-Agent freigeben</strong><small class="type-text-small">Ohne Freigabe werden für diese Organisation keine Calls gestartet.</small></span>
					</label>
					<button class="type-text-semi" type="submit">Agent-Konfiguration speichern</button>
					{#if form?.voiceConfigError}<p class="form-message error type-text-small">{form.voiceConfigError}</p>{/if}
					{#if form?.voiceConfigSaved}<p class="form-message success type-text-small">Agent-Konfiguration gespeichert.</p>{/if}
				</form>
			</section>

			<section class="allowance-card" aria-labelledby="allowance-title">
				<div>
					<h2 id="allowance-title" class="type-heading">Monatliches Minutenkontingent</h2>
					<p class="type-text-small">Gilt ab dem aktuellen Monat. Overage wird mit {data.overagePrice} pro Minute berechnet.</p>
				</div>
				<form method="POST" action="?/setAllowance">
					<label for="includedMinutes" class="type-text-small-semi">Inklusive Minuten</label>
					<div class="allowance-input">
						<input id="includedMinutes" name="includedMinutes" type="number" min="0" max="10000000" step="1" required value={data.currentUsage.includedMinutes ?? ''} placeholder="z. B. 500" />
						<button class="type-text-semi" type="submit">Speichern</button>
					</div>
					{#if form?.allowanceError}<p class="form-message error type-text-small">{form.allowanceError}</p>{/if}
					{#if form?.allowanceSaved}<p class="form-message success type-text-small">Kontingent gespeichert.</p>{/if}
				</form>
			</section>

			<section class="metrics" aria-label="Organisationskennzahlen">
				<article class="metric-card"><p class="type-text-semi">Verbrauch aktueller Monat</p><strong class="type-text-big">{data.currentUsage.minutes} Min.</strong><small class="type-text-small">Live aktualisiert</small></article>
				<article class="metric-card"><p class="type-text-semi">Minutenkontingent</p><strong class="type-text-big">{data.currentUsage.includedMinutes === null ? 'Nicht gesetzt' : `${data.currentUsage.includedMinutes} Min.`}</strong><small class="type-text-small">Inklusive pro Monat</small></article>
				<article class:muted={!data.currentUsage.hasOverage} class="metric-card"><p class="type-text-semi">Overage-Minuten</p><strong class="type-text-big">{data.currentUsage.overageMinutes}</strong><small class="type-text-small">Über dem Kontingent</small></article>
				<article class:muted={!data.currentUsage.hasOverage} class="metric-card"><p class="type-text-semi">Overage-Umsatz</p><strong class="type-text-big">{data.currentUsage.overageRevenue}</strong><small class="type-text-small">{data.overagePrice} je Minute</small></article>
			</section>

			<section class="history-card" aria-labelledby="history-title">
				<div class="section-heading">
					<div><h2 id="history-title" class="type-heading">Monatshistorie</h2><p class="type-text-small">Aktueller Monat live · Aktualisierung alle 5 Sekunden</p></div>
					<span class:inactive={!data.organization.active} class="status type-text-small-semi">{data.organization.active ? 'Aktiv' : 'Inaktiv'}</span>
				</div>
				<div class="table-scroll">
					<table>
						<thead><tr><th>Abrechnungsmonat</th><th>Verbrauch</th><th>Kontingent</th><th>Overage</th><th>Overage-Umsatz</th><th>Status</th></tr></thead>
						<tbody>
							{#each data.monthlyUsage as month}
								<tr class:current-row={month.current}>
									<td><strong class="type-text">{month.label}</strong><span class="month-key type-text-small">{month.month}</span></td>
									<td class="numeric type-text-semi">{month.minutes}</td>
									<td class="numeric type-text">{month.includedMinutes === null ? 'Nicht gesetzt' : month.includedMinutes}</td>
									<td class:zero-value={!month.hasOverage} class="numeric type-text-semi">{month.overageMinutes}</td>
									<td class:zero-value={!month.hasOverage} class="numeric type-text-semi">{month.overageRevenue}</td>
									<td>{#if month.current}<span class="current-month type-text-small-semi">Laufend</span>{:else}<span class="closed-month type-text-small-semi">Abgeschlossen</span>{/if}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	</main>
</div>

<style>
	.detail-shell { min-height: 100vh; padding-left: 240px; background: #fbfbf9; }
	.workspace { min-width: 0; min-height: 100vh; padding-top: 72px; }
	.topbar { position: fixed; z-index: 9; inset: 0 0 auto 240px; display: flex; height: 72px; align-items: center; gap: 16px; padding: 0 24px; border-bottom: 1px solid #e1e1e1; background: #fff; }
	.topbar h1, .topbar p, h2, p { margin: 0; }
	.topbar p, .metric-card p, .metric-card small, .section-heading p, .month-key { color: rgb(0 0 0 / 0.48); }
	.content { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
	.back-link { width: fit-content; color: #1c4785; text-decoration: none; }
	.back-link:hover { text-decoration: underline; }
	.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
	.metric-card, .history-card, .allowance-card, .voice-card { border: 1px solid #ebebeb; border-radius: 24px; background: #fff; }
	.metric-card { display: flex; min-height: 120px; flex-direction: column; justify-content: center; gap: 8px; padding: 24px; }
	.metric-card.muted { background: #f7f7f5; color: rgb(0 0 0 / 0.35); }
	.allowance-card { display: flex; align-items: flex-end; justify-content: space-between; gap: 32px; padding: 24px; }
	.allowance-card > div { display: flex; flex-direction: column; gap: 6px; }
	.allowance-card p { color: rgb(0 0 0 / 0.48); }
	.allowance-card form { width: min(360px, 100%); }
	.allowance-card label { display: block; margin-bottom: 6px; }
	.allowance-input { display: flex; gap: 8px; }
	.allowance-input input { min-width: 0; flex: 1; height: 42px; padding: 0 12px; border: 1px solid #d8d8d8; border-radius: 10px; font: inherit; }
	.allowance-input button { height: 42px; padding: 0 16px; border: 0; border-radius: 10px; background: #000; color: #fff; cursor: pointer; }
	.voice-card { display: grid; grid-template-columns: minmax(260px, 0.7fr) minmax(420px, 1.3fr); gap: 32px; padding: 24px; }
	.voice-card > div { display: flex; flex-direction: column; gap: 6px; }
	.voice-card > div p { max-width: 540px; color: rgb(0 0 0 / 0.48); line-height: 1.5; }
	.voice-form { display: grid; gap: 16px; }
	.voice-form label:not(.voice-enabled) { display: grid; gap: 7px; }
	.voice-form input:not([type='checkbox']), .voice-form textarea { width: 100%; padding: 10px 12px; border: 1px solid #d8d8d8; border-radius: 10px; background: #fff; font: inherit; }
	.voice-form input:not([type='checkbox']) { height: 42px; }
	.voice-form textarea { min-height: 150px; resize: vertical; line-height: 1.45; }
	.voice-enabled { display: flex; align-items: flex-start; gap: 10px; }
	.voice-enabled input { width: 18px; height: 18px; margin-top: 2px; }
	.voice-enabled span { display: grid; gap: 3px; }
	.voice-enabled small { color: rgb(0 0 0 / 0.48); }
	.voice-form button { width: fit-content; height: 42px; padding: 0 16px; border: 0; border-radius: 10px; background: #000; color: #fff; cursor: pointer; }
	.form-message { margin-top: 7px; }
	.form-message.error { color: #a32626; }
	.form-message.success { color: #087443; }
	.history-card { overflow: hidden; }
	.section-heading { display: flex; align-items: center; justify-content: space-between; padding: 24px; border-bottom: 1px solid #ebebeb; }
	.section-heading > div { display: flex; flex-direction: column; gap: 4px; }
	.table-scroll { overflow-x: auto; }
	table { width: 100%; min-width: 720px; border-collapse: collapse; }
	th, td { padding: 16px 20px; border-bottom: 1px solid #efefef; text-align: left; vertical-align: middle; }
	th { color: rgb(0 0 0 / 0.48); font-size: 13px; font-weight: 600; }
	tbody tr:last-child td { border-bottom: 0; }
	.current-row { background: #fbfefc; }
	td:first-child strong, td:first-child span { display: block; }
	.month-key { margin-top: 3px; }
	.numeric { font-variant-numeric: tabular-nums; }
	.zero-value { color: rgb(0 0 0 / 0.28); }
	.status, .current-month, .closed-month { display: inline-flex; padding: 5px 9px; border-radius: 999px; }
	.status, .current-month { color: #087443; background: #e9f8ef; }
	.status.inactive, .closed-month { color: #666; background: #eee; }
	@media (max-width: 1100px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 900px) { .allowance-card { align-items: stretch; flex-direction: column; } .voice-card { grid-template-columns: 1fr; } }
	@media (max-width: 640px) { .metrics { grid-template-columns: 1fr; } }
	@media (max-width: 720px) { .detail-shell { padding-left: 0; } .workspace { padding-top: 64px; } .topbar { left: 0; height: 64px; } .content { padding: 16px; } }
</style>
