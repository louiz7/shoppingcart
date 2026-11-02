<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import CampaignTabs from '$lib/components/CampaignTabs.svelte';
	import LiveRefresh from '$lib/components/LiveRefresh.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	const activeNav = 'Anrufliste';
</script>

{#snippet callRows(calls: typeof data.todayCalls)}
	<div class="call-list">
		{#each calls as call}
			<a class="call-row" href={`/postfach/${call.id.slice(1)}`} aria-label={`Anruf von ${call.name} um ${call.time} öffnen`}>
				<span class="call-row__details">
					<span class="call-time type-text">{call.time}</span>
					<img class="call-icon" src={call.icon} alt="" width="18" height="18" />
					<span class="call-person"><strong class="type-text">{call.name}</strong><span class="type-text">{call.id}</span></span>
					<span class="call-phone type-text">{call.phone}</span>
				</span>
				<span class="status-frame"><span class:yellow={call.outcomeTone === 'yellow'} class:gray={call.outcomeTone === 'gray'} class:blue={call.outcomeTone === 'blue'} class:red={call.outcomeTone === 'red'} class="status-pill type-text-small-semi">{call.outcome}</span></span>
				<span class="call-duration type-text">{call.duration ?? '–'}</span>
			</a>
		{/each}
	</div>
{/snippet}

<svelte:head>
	<title>Anrufliste · Rescova</title>
	<meta name="description" content="Anrufliste der Rescova Plattform" />
</svelte:head>

<div class="call-shell">
	<LiveRefresh />
	<Sidebar
		navigation={data.navigation}
		campaignNavigation={data.campaignNavigation}
		activeItem={activeNav}
	/>

	<main class="workspace">
		<header class="topbar">
			<BackButton />
			<h1 class="type-page-heading">{activeNav}</h1>
		</header>

		<div class="call-content">
			<CampaignTabs
				filters={data.campaignFilters}
				activeCampaign={data.activeCampaign}
				basePath="/anrufliste"
			/>

			<div class="metrics" aria-label="Anrufkennzahlen">
				{#each data.metrics as metric}
					<article class="metric-card">
						<p class="type-text-semi">{metric.label}</p>
						<strong class="type-text-big">{metric.value}</strong>
						<small class="metric-hint type-text-small">{metric.hint}</small>
					</article>
				{/each}
			</div>

			<section class="call-section" aria-labelledby="today-heading">
				<h2 id="today-heading" class="type-heading">Heute</h2>
				{@render callRows(data.todayCalls)}
			</section>

			<section class="call-section" aria-labelledby="yesterday-heading">
				<h2 id="yesterday-heading" class="type-heading">Gestern</h2>
				{@render callRows(data.yesterdayCalls)}
			</section>

			{#if data.olderCalls.length > 0}
				<details class="older-calls">
					<summary class="type-heading">
						<span>Ältere Anrufe</span>
						<span class="older-calls__count type-text">{data.olderCalls.length}</span>
						<img src="/figma/arrow-stroke.svg" alt="" width="14" height="7" />
					</summary>
					<div class="older-calls__content">
						{@render callRows(data.olderCalls)}
					</div>
				</details>
			{/if}
		</div>
	</main>
</div>

<style>
	.call-shell {
		min-height: 100vh;
		padding-left: 240px;
		background: #fbfbf9;
	}

	.workspace {
		min-width: 0;
		min-height: 100vh;
		padding-top: 57px;
		background: #fbfbf9;
	}

	.topbar {
		position: fixed;
		z-index: 9;
		top: 0;
		left: 240px;
		right: 0;
		display: flex;
		height: 57px;
		align-items: center;
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.topbar h1 {
		margin: 0;
		color: #000;
	}

	.call-content {
		display: flex;
		min-height: calc(100vh - 57px);
		min-width: 0;
		flex-direction: column;
		gap: 48px;
		padding: 24px;
		background: #fff;
	}

	.metrics {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
		gap: 16px;
		width: 100%;
	}

	.metric-card {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 10px;
		padding: 24px;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.metric-card p,
	.metric-card strong {
		margin: 0;
	}

	.metric-card p {
		color: rgb(0 0 0 / 0.4);
	}

	.metric-card strong {
		color: #000;
	}

	.metric-hint {
		color: rgb(0 0 0 / 0.5);
		line-height: 1.35;
	}

	.call-section {
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		gap: 16px;
	}

	.call-section h2 {
		margin: 0;
		color: #000;
		font-weight: 500;
		line-height: 1.05;
	}

	.older-calls {
		width: 100%;
	}

	.older-calls summary {
		display: flex;
		align-items: center;
		gap: 12px;
		color: #000;
		cursor: pointer;
		list-style: none;
	}

	.older-calls summary::-webkit-details-marker {
		display: none;
	}

	.older-calls summary img {
		margin-left: auto;
		transition: transform 160ms ease;
	}

	.older-calls[open] summary img {
		transform: rotate(180deg);
	}

	.older-calls__count {
		display: grid;
		min-width: 28px;
		height: 28px;
		place-items: center;
		padding: 0 8px;
		border-radius: 999px;
		background: #f0f0f0;
		color: rgb(0 0 0 / 0.6);
	}

	.older-calls__content {
		margin-top: 16px;
	}

	.call-list {
		width: 100%;
		overflow: hidden;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.call-row {
		display: flex;
		width: 100%;
		min-width: 706px;
		min-height: 58px;
		align-items: center;
		justify-content: space-between;
		padding: 20px 24px;
		border-bottom: 1px solid #ebebeb;
		background: #fff;
		color: #000;
		text-align: left;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.call-row:last-child {
		border-bottom: 0;
	}

	.call-row:hover {
		background: #fcfbfa;
	}

	.call-row__details {
		display: flex;
		align-items: center;
		gap: 32px;
		min-width: 0;
	}

	.call-time {
		width: 50px;
		flex: 0 0 50px;
		color: rgb(0 0 0 / 0.5);
	}

	.call-icon {
		display: block;
		width: 18px;
		height: 18px;
		aspect-ratio: 1 / 1;
		flex: 0 0 18px;
		object-fit: contain;
	}

	.call-person {
		display: flex;
		width: 280px;
		flex: 0 0 280px;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	.call-person strong {
		color: #000;
	}

	.call-person span {
		color: rgb(0 0 0 / 0.5);
	}

	.call-phone,
	.call-duration {
		color: rgb(0 0 0 / 0.7);
	}

	.call-phone {
		width: 200px;
		flex: 0 0 200px;
		white-space: nowrap;
	}

	.call-duration {
		width: 45px;
		flex: 0 0 45px;
		text-align: right;
	}

	.status-frame {
		display: flex;
		width: 160px;
		flex: 0 0 160px;
		align-items: center;
	}

	.status-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 16px;
		border: 1px solid currentColor;
		border-radius: 30px;
		white-space: nowrap;
	}

	.status-pill.yellow {
		color: #9d7415;
		background: #fff8e2;
	}

	.status-pill.gray {
		color: #616e6a;
		background: #f2f3f2;
	}

	.status-pill.blue {
		color: #1c4785;
		background: #e8f1ff;
	}

	.status-pill.red {
		color: #db4839;
		background: #ffe2e2;
	}

	@media (max-width: 780px) {
		.call-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

		.call-content {
			gap: 32px;
			padding: 18px;
		}
	}

	@media (max-width: 480px) {
		.metrics {
			grid-template-columns: 1fr;
		}

		.metric-card {
			border-radius: 24px;
		}
	}
</style>
