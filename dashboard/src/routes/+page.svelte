<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	const activeNav = 'Übersicht';
</script>

<svelte:head>
	<title>{activeNav} · Rescova</title>
	<meta name="description" content="Übersicht der Rescova Plattform" />
</svelte:head>

<div class="dashboard-shell">
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

		<div class="content">
			<section class="summary-grid" aria-label="Zusammenfassung">
				<article class="summary-card">
					<p class="type-text-semi">Aktive Debitoren Insgesamt</p>
					<strong class="type-text-big">{data.summary.activeDebtors}</strong>
				</article>
				<article class="summary-card">
					<p class="type-text-semi">Offene Forderungen</p>
					<strong class="type-text-big">{data.summary.openClaims}</strong>
				</article>
			</section>

			<section class="realized-section" aria-labelledby="realized-title">
				<h2 id="realized-title" class="type-heading">Realisierte Forderungen</h2>
				<div class="realized-grid">
					{#each data.realizedMetrics as metric}
						<article class="realized-card">
							<div class="metric-group">
								<p class="type-text-semi">{metric.label}</p>
								<div class="metric-value-row">
									<strong class="type-text-big">{metric.value}</strong>
									<span class:negative={metric.changeTone === 'negative'} class="change-pill type-text-small-semi">{metric.change}</span>
								</div>
							</div>
							<div class="metric-group">
								<p class="type-text-semi">Abschlussquote</p>
								<div class="metric-value-row">
									<strong class="type-text-big">{metric.completion}</strong>
									<span class:negative={metric.completionTone === 'negative'} class="change-pill type-text-small-semi">{metric.completionChange}</span>
								</div>
							</div>
						</article>
					{/each}
				</div>
			</section>

			<section class="overview-tasks" aria-labelledby="tasks-title">
				<div class="overview-tasks__header">
					<h2 id="tasks-title" class="type-heading">Offene Aufgaben <span aria-hidden="true">•</span> {data.recentTasks.length}</h2>
					<a class="overview-tasks__link type-text" href="/postfach">
						Alle Aufgaben
						<img src="/figma/arrow-right.svg" alt="" width="16" height="16" />
					</a>
				</div>

				<div class="overview-task-table">
					<div class="overview-task-table__header" aria-hidden="true">
						<span class="type-text-semi">Kontakt</span>
						<span class="type-text-semi">Ergebnis</span>
						<span class="type-text-semi">Betrag</span>
						<span></span>
					</div>

					{#each data.recentTasks as task}
						<a class="overview-task-row" href={`/postfach/${task.debtorId}`} aria-label={`Aufgabe von ${task.name} öffnen`}>
							<span class="overview-task-contact">
								<span class="overview-task-avatar type-text-small-semi">{task.initials}</span>
								<span class="overview-task-person">
									<strong class="type-text">{task.name}</strong>
									<span class="type-text-small">{task.time}</span>
								</span>
							</span>
							<span class:danger={task.tone === 'danger'} class="overview-task-result type-text-small-semi">{task.result}</span>
							<strong class="overview-task-amount type-text">{task.amount}</strong>
							<span class="overview-task-arrow"><img src="/figma/arrow-stroke.svg" alt="" width="14" height="7" /></span>
						</a>
					{/each}
				</div>
			</section>
		</div>
	</main>
</div>

<style>
	.dashboard-shell {
		min-height: 100vh;
		padding-left: 240px;
		background: #fbfbf9;
	}

	.workspace {
		min-height: 100vh;
		padding-top: 57px;
		background: #fafafa;
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

	.topbar h1,
	h2,
	p {
		margin: 0;
	}

	.topbar h1,
	.realized-section h2,
	.overview-tasks h2 {
		color: #000;
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 24px;
	}

	.summary-grid,
	.realized-grid {
		display: grid;
		gap: 16px;
	}

	.summary-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.summary-card,
	.realized-section,
	.realized-card,
	.overview-tasks {
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.summary-card {
		display: flex;
		min-height: 110px;
		flex-direction: column;
		gap: 16px;
		justify-content: center;
		padding: 24px;
	}

	.summary-card p,
	.metric-group p {
		color: rgb(0 0 0 / 0.4);
	}

	.summary-card strong,
	.metric-value-row strong {
		color: #000;
		white-space: nowrap;
	}

	.realized-section {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 16px;
		padding: 24px;
	}

	.realized-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}

	.realized-card {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 24px;
		padding: 24px;
	}

	.metric-group {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.metric-value-row {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 16px;
	}

	.change-pill {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px;
		border-radius: 20px;
		background: rgb(0 255 68 / 0.32);
		color: #00721e;
		white-space: nowrap;
	}

	.change-pill.negative {
		background: #fceaec;
		color: #ef5660;
	}

	.overview-tasks {
		padding: 24px;
	}

	.overview-tasks__header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding-bottom: 16px;
	}

	.overview-tasks h2 {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.overview-tasks__link {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		color: #1c4785;
		text-decoration: none;
	}

	.overview-tasks__link img {
		display: block;
		width: 16px;
		height: 16px;
		transform: rotate(-90deg);
	}

	.overview-task-table__header,
	.overview-task-row {
		display: grid;
		grid-template-columns: minmax(220px, 1.25fr) minmax(180px, 1fr) minmax(120px, 1fr) 24px;
		align-items: center;
		column-gap: 24px;
	}

	.overview-task-table__header {
		padding: 16px 0;
		border-bottom: 1px solid #e8ece6;
		color: rgb(0 0 0 / 0.6);
	}

	.overview-task-row {
		padding: 16px 0;
		border-bottom: 1px solid #e8ece6;
		color: #000;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.overview-task-row:last-child {
		border-bottom: 0;
	}

	.overview-task-row:hover {
		background: #fcfbfa;
	}

	.overview-task-contact {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.overview-task-avatar {
		display: grid;
		width: 37px;
		height: 37px;
		flex: 0 0 37px;
		place-items: center;
		border-radius: 50%;
		background: rgb(255 76 0 / 0.24);
		color: #ff4c00;
	}

	.overview-task-person {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.overview-task-person strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.overview-task-person span {
		color: rgb(0 0 0 / 0.5);
	}

	.overview-task-result {
		width: fit-content;
		padding: 8px 16px;
		border: 1px solid #9d7415;
		border-radius: 30px;
		background: #fff8e2;
		color: #9d7415;
		white-space: nowrap;
	}

	.overview-task-result.danger {
		border-color: #db4839;
		background: #ffe2e2;
		color: #db4839;
	}

	.overview-task-arrow {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
	}

	.overview-task-arrow img {
		display: block;
		width: 14px;
		height: 7px;
		transform: rotate(-90deg);
	}

	@media (max-width: 1100px) {
		.realized-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 780px) {
		.dashboard-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
		}

		.topbar,
		.content {
			padding-right: 18px;
			padding-left: 18px;
		}

		.content {
			padding-top: 18px;
			padding-bottom: 18px;
		}

		.summary-grid,
		.realized-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.overview-task-table__header,
		.overview-task-row {
			grid-template-columns: minmax(160px, 1fr) minmax(110px, auto) minmax(90px, auto) 16px;
			column-gap: 12px;
		}

		.overview-task-result {
			padding: 7px 10px;
		}

		.overview-task-arrow {
			width: 16px;
		}
	}
</style>
