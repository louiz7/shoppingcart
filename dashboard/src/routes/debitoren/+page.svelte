<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import CampaignTabs from '$lib/components/CampaignTabs.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	let activeNav = 'Debitoren';

	function initials(name: string): string {
		return name
			.split(/\s+/)
			.map((part) => part.charAt(0))
			.join('')
			.slice(0, 2)
			.toUpperCase();
	}
</script>

<svelte:head>
	<title>Debitoren · Rescova</title>
	<meta name="description" content="Debitorenverzeichnis der Rescova Plattform" />
</svelte:head>

<div class="debtor-shell">
	<Sidebar
		navigation={data.navigation}
		campaignNavigation={data.campaignNavigation}
		activeItem={activeNav}
		onItemSelect={(label) => (activeNav = label)}
	/>

	<main class="workspace">
		<header class="topbar">
			<BackButton />
			<h1 class="type-page-heading">{activeNav}</h1>
		</header>

		<div class="debtor-content">
			<div class="campaign-filter">
				<CampaignTabs
					filters={data.campaignFilters}
					activeCampaign={data.activeCampaign}
					basePath="/debitoren"
					query={data.query}
				/>
			</div>

			<div class="directory-table" aria-label="Debitorenverzeichnis">
				<div class="directory-table__inner">
					<div class="directory-table__header">
						<span class="cell-contact type-text-semi">Kontakt</span>
						<span class="cell-birthdate type-text-semi">Geburtsdatum</span>
						<span class="cell-phone type-text-semi">Telefonnummer</span>
						<span class="cell-address type-text-semi">Adresse</span>
						<span class="heading-arrow" aria-hidden="true"></span>
					</div>

					{#each data.debtors as debtor}
						<a
							class="directory-table__row"
							href={`/postfach/${debtor.id}`}
							aria-label={`Debitor ${debtor.name} öffnen`}
						>
							<span class="cell-contact contact">
								<span class="contact__avatar type-text-small-semi" aria-hidden="true">{initials(debtor.name)}</span>
								<strong class="contact__name type-text">{debtor.name}</strong>
								<span class="contact__id type-text-small">#{debtor.id}</span>
							</span>
							<span class:confirmed={debtor.confirmedBirthdate} class="cell-birthdate type-text">{debtor.birthdate}</span>
							<span class="cell-phone type-text">{debtor.phone}</span>
							<span class="cell-address type-text">{debtor.address}</span>
							<span class="cell-arrow"><img src="/figma/arrow-stroke.svg" alt="" width="16" height="9" /></span>
						</a>
					{/each}
				</div>
			</div>
		</div>
	</main>
</div>

<style>
	.debtor-shell {
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
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.topbar h1 {
		margin: 0;
		color: #000;
	}

	.debtor-content {
		min-width: 0;
		padding: 0;
	}

	.campaign-filter {
		padding: 24px 24px 0;
	}

	.directory-table {
		width: 100%;
		overflow-x: auto;
		padding: 24px;
		background: #fff;
	}

	.directory-table__inner {
		min-width: 1152px;
	}

	.directory-table__row {
		display: grid;
		grid-template-columns: 250px 120px 160px 250px 24px;
		align-items: center;
		justify-content: space-between;
	}

	.directory-table__header {
		display: flex;
		padding-bottom: 8px;
		border-bottom: 1px solid #ebebeb;
		color: rgb(0 0 0 / 0.6);
		justify-content: space-between;
		align-items: center;
		align-self: stretch;
	}

	.directory-table__header .cell-contact {
		width: 250px;
		color: rgb(0 0 0 / 0.6);
	}

	.directory-table__header .cell-birthdate {
		width: 120px;
		color: rgb(0 0 0 / 0.6);
	}

	.directory-table__header .cell-phone {
		width: 160px;
		color: rgb(0 0 0 / 0.6);
	}

	.directory-table__header .cell-address {
		width: 250px;
		color: rgb(0 0 0 / 0.6);
	}

	.directory-table__header .heading-arrow {
		width: 24px;
	}

	.directory-table__row {
		height: 69px;
		border-bottom: 1px solid #e8ece6;
		background: #fff;
		color: #000;
		text-align: left;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.directory-table__row:hover {
		background: #fcfbfa;
	}

	.cell-contact {
		min-width: 0;
	}

	.contact {
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	.contact__avatar {
		display: grid;
		width: 37px;
		height: 37px;
		flex: 0 0 37px;
		place-items: center;
		border-radius: 50%;
		background: rgb(255 76 0 / 0.24);
		color: #ff4c00;
	}

	.contact__name {
		overflow: hidden;
		color: #000;
		text-overflow: ellipsis;
	}

	.contact__id {
		color: rgb(0 0 0 / 0.5);
	}

	.cell-birthdate,
	.cell-phone,
	.cell-address {
		color: #000;
		white-space: nowrap;
	}

	.cell-arrow {
		display: grid;
		width: 24px;
		height: 24px;
		place-items: center;
	}

	.cell-arrow img {
		display: block;
		width: 16px;
		height: 9px;
		transform: rotate(-90deg);
	}

	@media (max-width: 780px) {
		.debtor-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

		.campaign-filter {
			padding: 18px 18px 0;
		}

	}
</style>
