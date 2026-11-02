<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import LiveRefresh from '$lib/components/LiveRefresh.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	const activeNav = 'Inkassokampagnen';
</script>

<svelte:head>
	<title>{activeNav} · Rescova</title>
	<meta name="description" content="Übersicht der Inkassokampagnen in der Rescova Plattform" />
</svelte:head>

<div class="campaign-shell">
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
			<a class="campaign-create type-text" href="/inkassokampagnen/neu">
				<span>Neue Kampagne erstellen</span>
			</a>
		</header>

		<div class="campaign-content">
			<div class="campaign-content__inner">
				<section class="campaign-overview" aria-labelledby="campaign-overview-heading">
					<h2 id="campaign-overview-heading" class="type-heading">Kampagnenübersicht</h2>

					<div class="campaign-table" aria-label="Kampagnenübersicht">
						<div class="campaign-table__row campaign-table__header" aria-hidden="true">
							<span class="type-text">Kampagnenname</span>
							<span class="type-text">Kontakte</span>
							<span class="type-text">Fortschritt</span>
							<span class="type-text">Erreicht</span>
							<span class="type-text">Eingegangen</span>
							<span class="type-text">Status</span>
							<span class="table-arrow" aria-hidden="true"></span>
						</div>

						{#each data.campaigns as campaign}
							<a
								class="campaign-table__row campaign-table__item"
								href={`/inkassokampagnen/${campaign.id}`}
								aria-label={`${campaign.name} öffnen`}
							>
								<span class="type-text">{campaign.name}</span>
								<span class="type-text">{campaign.contacts}</span>
								<span class="type-text">{campaign.progress}</span>
								<span class="type-text">{campaign.reached}</span>
								<span class="type-text">{campaign.received}</span>
								<span class:limit-status={campaign.minuteLimitReached} class="campaign-status type-text-small-semi">{campaign.status}</span>
								<span class="table-arrow"><img src="/figma/arrow-stroke.svg" alt="" width="14" height="7" /></span>
							</a>
						{/each}
					</div>
				</section>
			</div>
		</div>
	</main>
</div>

<style>
	.campaign-shell {
		min-height: 100vh;
		padding-left: 240px;
		background: #fff;
	}

	.workspace {
		min-width: 0;
		min-height: 100vh;
		padding-top: 57px;
		background: #fff;
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
		justify-content: space-between;
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.topbar h1,
	.campaign-overview h2 {
		margin: 0;
		color: #000;
	}

	.campaign-create {
		position: relative;
		display: block;
		width: 223px;
		height: 42.5px;
		flex: 0 0 223px;
		padding: 0;
		border-radius: 12px;
		background: #dd3d00;
		color: #fff;
		isolation: isolate;
		text-decoration: none;
	}

	.campaign-create::before {
		position: absolute;
		z-index: 0;
		top: 0;
		left: 0;
		width: 100%;
		height: 38.5px;
		border-radius: 10px;
		background: #ff4c00;
		content: '';
	}

	.campaign-create span {
		position: relative;
		z-index: 1;
		display: grid;
		height: 38.5px;
		place-items: center;
		white-space: nowrap;
	}

	.campaign-content {
		min-width: 0;
		min-height: calc(100vh - 57px);
		overflow-x: auto;
		padding: 24px;
		background: #fff;
	}

	.campaign-content__inner {
		display: flex;
		width: 100%;
		min-width: 1152px;
		flex-direction: column;
	}

	.campaign-overview {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.campaign-table {
		position: relative;
		width: 100%;
		min-height: 132px;
		overflow: hidden;
		border-radius: 24px;
		background: #fff;
	}

	.campaign-table::after {
		position: absolute;
		z-index: 2;
		inset: 0;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		pointer-events: none;
		content: '';
	}

	.campaign-table__row {
		display: grid;
		grid-template-columns: 200px repeat(5, 117px) 24px;
		align-items: center;
		justify-content: space-between;
		padding: 0 24px;
		color: #000;
		text-align: left;
	}

	.campaign-table__header {
		height: 64px;
		border-bottom: 1px solid #ebebeb;
		background: #fcfbfa;
	}

	.campaign-table__item {
		width: 100%;
		height: 68px;
		padding-top: 0;
		padding-bottom: 0;
		border: 0;
		background: #fff;
		color: #000;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.campaign-table__item:not(:last-child) {
		border-bottom: 1px solid #ebebeb;
	}

	.campaign-table__item:hover {
		background: #fcfbfa;
	}

	.campaign-status {
		display: grid;
		width: 63px;
		height: 28px;
		place-items: center;
		border: 1px solid #00721e;
		border-radius: 30px;
		background: rgb(0 114 30 / 0.05);
		color: #00721e;
		white-space: nowrap;
	}
	.campaign-status.limit-status { width: auto; padding-inline: 9px; background: #ffe8bd; color: #8a5200; }

	.table-arrow {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
	}

	.table-arrow img {
		display: block;
		width: 14px;
		height: 7px;
		transform: rotate(-90deg);
	}

	@media (max-width: 780px) {
		.campaign-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

		.campaign-content {
			padding: 18px;
		}
	}
</style>
