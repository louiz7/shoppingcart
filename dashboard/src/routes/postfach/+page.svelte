<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	const activeNav = 'Aufgaben';
</script>

<svelte:head>
	<title>Aufgaben · Rescova</title>
	<meta name="description" content="Aufgaben der Rescova Plattform" />
</svelte:head>

<div class="aufgaben-shell">
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

		<div class="aufgaben-content">
			<section class="tasks-table" aria-label="Offene Aufgaben">
				<div class="tasks-table__header" aria-hidden="true">
					<span class="heading-contact type-text-semi">Kontakt</span>
					<span class="heading-result type-text-semi">Ergebnis</span>
					<span class="heading-amount type-text-semi">Betrag</span>
					<span class="heading-arrow"></span>
				</div>

				{#each data.recentTasks as task}
					<a class="task-row" href={`/postfach/${task.debtorId}`} aria-label={`Aufgabe von ${task.name} öffnen`}>
						<span class="task-contact">
							<span class="task-avatar type-text-small-semi">{task.initials}</span>
							<span class="task-person">
								<strong class="type-text">{task.name}</strong>
								<span class="type-text-small">{task.time}</span>
							</span>
						</span>
						<span class:danger={task.tone === 'danger'} class="task-result type-text-small-semi">{task.result}</span>
						<strong class="task-amount type-text">{task.amount}</strong>
						<span class="task-arrow"><img src="/figma/arrow-stroke.svg" alt="" width="14" height="7" /></span>
					</a>
				{/each}
			</section>
		</div>
	</main>
</div>

<style>
	.aufgaben-shell {
		min-height: 100vh;
		padding-left: 240px;
		background: #fbfbf9;
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
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.topbar h1 {
		margin: 0;
		color: #000;
	}

	.aufgaben-content {
		overflow-x: auto;
		padding: 0;
		background: #fff;
	}

	.tasks-table {
		width: 100%;
		min-width: 1200px;
		padding: 24px;
	}

	.task-row {
		display: grid;
		width: 100%;
		grid-template-columns: 200px 200px 200px 24px;
		align-items: center;
		justify-content: space-between;
	}

	.tasks-table__header {
		display: flex;
		padding-bottom: 8px;
		border-bottom: 1px solid #ebebeb;
		color: rgb(0 0 0 / 0.6);
		justify-content: space-between;
		align-items: center;
		align-self: stretch;
	}

	.tasks-table__header .heading-contact {
		width: 200px;
		color: rgb(0 0 0 / 0.6);
	}

	.tasks-table__header .heading-result,
	.tasks-table__header .heading-amount {
		width: 200px;
	}

	.tasks-table__header .heading-arrow {
		width: 24px;
	}

	.task-row {
		height: 69px;
		padding: 0;
		border-bottom: 1px solid #e8ece6;
		background: #fff;
		color: #000;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.task-row:last-child {
		border-bottom: 0;
	}

	.task-row:hover {
		background: #fcfbfa;
	}

	.task-contact {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 8px;
	}

	.task-avatar {
		display: grid;
		width: 37px;
		height: 37px;
		flex: 0 0 37px;
		place-items: center;
		border-radius: 50%;
		background: rgb(255 76 0 / 0.24);
		color: #ff4c00;
	}

	.task-person {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.task-person strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.task-person span {
		color: rgb(0 0 0 / 0.5);
	}

	.task-result {
		width: fit-content;
		padding: 8px 16px;
		border: 1px solid #9d7415;
		border-radius: 30px;
		background: #fff8e2;
		color: #9d7415;
		white-space: nowrap;
	}

	.task-result.danger {
		border-color: #db4839;
		background: #ffe2e2;
		color: #db4839;
	}

	.task-arrow {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
	}

	.task-arrow img {
		display: block;
		width: 14px;
		height: 7px;
		transform: rotate(-90deg);
	}

	@media (max-width: 780px) {
		.aufgaben-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

	}
</style>
