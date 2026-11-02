<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	let profile = $derived({ ...data.profile, id: `#${data.profile.id}` });
</script>

<svelte:head>
	<title>{profile.name} · Rescova</title>
	<meta name="description" content={`Detailansicht für ${profile.name}`} />
</svelte:head>

<div class="detail-shell">
	<Sidebar
		navigation={data.navigation}
		campaignNavigation={data.campaignNavigation}
		activeItem="Aufgaben"
	/>

	<main class="workspace">
		<header class="topbar" aria-label="Navigationspfad">
			<BackButton fallback="/postfach" />
			<a class="breadcrumb-link type-page-heading" href="/postfach">Aufgaben</a>
			<span class="breadcrumb-arrow" aria-hidden="true">
				<img src="/figma/breadcrumb-arrow.svg" alt="" width="12" height="7" />
			</span>
			<span class="breadcrumb-current type-page-heading">{profile.name}</span>
		</header>

		<section class="detail-top" aria-label="Debitorendetails">
			<div class="person-heading">
				<div class="person-heading__identity">
					<h1 class="type-heading">{profile.name}</h1>
					<span class="type-text-small">{profile.id}</span>
				</div>
				{#if data.canCreateDemo}
					<form method="POST" action="?/createDemoCampaign">
						<button class="raised-button raised-button--dark type-text" type="submit">
							Demo-Kampagne anlegen
						</button>
					</form>
				{/if}
			</div>
			{#if data.canCreateDemo}
				<p class="demo-hint type-text-small">
					Eine Demo-Kampagne erstellt eine frische Forderung mit eigener Anrufhistorie. Frühere Vereinbarungen bleiben erhalten.
				</p>
			{/if}

			<div class="detail-panels">
				<section class="data-panel" aria-labelledby="person-data-title">
					<h2 id="person-data-title" class="type-text-semi">Personendaten</h2>
					<div class="data-panel__content">
						<p class="data-field type-text"><span>Geburtsdatum:</span><strong class="type-text">{profile.birthdate}</strong></p>
						<p class="data-field type-text"><span>Adresse:</span><strong class="type-text">{profile.address}</strong></p>
						<p class="data-field type-text"><span>Telefonnummer:</span><strong class="type-text">{profile.phone}</strong></p>
						<p class="data-field type-text"><span>Email:</span><strong class="type-text">{profile.email}</strong></p>
					</div>
				</section>

				<section class="data-panel" aria-labelledby="contract-data-title">
					<h2 id="contract-data-title" class="type-text-semi">Forderungsübersicht</h2>
					<div class="data-panel__content">
						<p class="data-field type-text"><span>Offener Gesamtbetrag:</span><strong class="type-text">{profile.amount}</strong></p>
						<p class="data-field type-text"><span>Forderungen:</span><strong class="type-text">{data.claims.length}</strong></p>
						<p class="data-field type-text"><span>Mandant:</span><strong class="type-text">{profile.client}</strong></p>
						<p class="data-field type-text"><span>Nächste Fälligkeit:</span><strong class="type-text">{profile.dueDate}</strong></p>
					</div>
				</section>
			</div>

			<section class="claims-section" aria-labelledby="claims-title">
				<div class="claims-heading">
					<h2 id="claims-title" class="type-text-semi">Einzelne Forderungen</h2>
					<span class="type-text-small">{data.claims.length} {data.claims.length === 1 ? 'Forderung' : 'Forderungen'}</span>
				</div>
				<div class="claims-list">
					{#each data.claims as claim}
						<details class="claim-card" open={data.claims.length === 1}>
							<summary>
								<span class="claim-primary">
									<strong class="type-text">{claim.invoice}</strong>
									<span class="type-text-small">
										Forderung #{claim.id} · {claim.activityCount} {claim.activityCount === 1 ? 'Meilenstein' : 'Meilensteine'}
									</span>
								</span>
								<strong class="claim-amount type-text">{claim.outstandingAmount}</strong>
								<span
									class:claim-success={claim.tone === 'success'}
									class:claim-warning={claim.tone === 'warning'}
									class:claim-danger={claim.tone === 'danger'}
									class="claim-status type-text-small-semi"
								>{claim.status}</span>
								<span class="claim-chevron" aria-hidden="true">⌄</span>
							</summary>
							<div class="claim-card__body">
								<div class="claim-details">
									<div><span class="type-text-small">Ursprünglicher Betrag</span><strong class="type-text">{claim.originalAmount}</strong></div>
									<div><span class="type-text-small">Offener Betrag</span><strong class="type-text">{claim.outstandingAmount}</strong></div>
									<div><span class="type-text-small">Fällig am</span><strong class="type-text">{claim.dueDate}</strong></div>
									<div><span class="type-text-small">Kampagne</span><strong class="type-text">{claim.campaigns}</strong></div>
									{#if claim.fileNumber !== '–'}<div><span class="type-text-small">Aktenzeichen</span><strong class="type-text">{claim.fileNumber}</strong></div>{/if}
									{#if claim.subFileNumber !== '–'}<div><span class="type-text-small">Unteraktennummer</span><strong class="type-text">{claim.subFileNumber}</strong></div>{/if}
								</div>
								{#if claim.note}<p class="type-text-small"><strong>Notiz:</strong> {claim.note}</p>{/if}
								{#if data.canRecordPayment && claim.tone !== 'success'}
									<form method="POST" action="?/recordPayment" class="payment-action">
										<input type="hidden" name="caseId" value={claim.id} />
										<span class="type-text-small">Der gesamte offene Betrag von {claim.outstandingAmount} wird als bezahlt verbucht.</span>
										<button class="raised-button raised-button--primary type-text" type="submit">Zahlung eingegangen</button>
									</form>
								{/if}

								<section class="claim-activities" aria-label={`Aktivitäten für ${claim.invoice}`}>
									<h3 class="type-text-semi">Aktivitätenverlauf</h3>
								{#if claim.activities.length > 0}
									<div class="claim-timeline">
										{#each claim.activities as entry}
											<div class="claim-activity type-text">
												<img
													class="timeline-dot"
													src={entry.tone === 'reached'
														? '/figma/detail-timeline-dot-reached.svg'
														: '/figma/detail-timeline-dot-missed.svg'}
													alt=""
													width="16"
													height="16"
												/>
												<span class="timeline-time type-text-small">{entry.time}</span>
												<span class="timeline-status">
													<img class="timeline-icon" src={entry.icon} alt="" width="16" height="16" />
													<span class:missed={entry.tone === 'missed'} class:reached={entry.tone === 'reached'}>{entry.label}</span>
												</span>
											</div>
										{/each}
									</div>
								{:else}
									<p class="empty-activity type-text-small">Für diese Forderung gibt es noch keine Aktivitäten.</p>
								{/if}

								{#if claim.summary}
									<section class="claim-summary" aria-label={`Evi-Zusammenfassung für ${claim.invoice}`}>
										<header class="summary-heading-group">
											<img src="/figma/detail-evi-spark.svg" alt="" width="15" height="15" />
											<h3 class="type-text-semi">Evi’s Zusammenfassung</h3>
										</header>
										<div class="claim-summary__content">
											<p class="type-text"><span>Ergebnis:</span><strong>{claim.summary.outcome}</strong></p>
											<p class="type-text">{claim.summary.text}</p>
										</div>
									</section>
								{/if}

								{#if claim.proposal}
									<section class="review-block claim-proposal" aria-labelledby={`proposal-title-${claim.id}`}>
										<div class="review-heading">
											<img src="/figma/detail-evi-spark.svg" alt="" width="15" height="15" />
											<h3 id={`proposal-title-${claim.id}`} class="type-text-semi">Vereinbarte Lösung</h3>
											<span
												class:approved={claim.proposal.statusCode === 'approved'}
												class="approval-status type-text-small-semi"
											>{claim.proposal.status}</span>
										</div>

										<div class="proposal-card">
											<div><span class="type-text-small">Lösung</span><strong class="type-text">{claim.proposal.solution}</strong></div>
											<div><span class="type-text-small">Raten</span><strong class="type-text">{claim.proposal.installments}</strong></div>
											<div><span class="type-text-small">Monatsrate</span><strong class="type-text">{claim.proposal.monthlyRate}</strong></div>
											<div><span class="type-text-small">Erste Rate</span><strong class="type-text">{claim.proposal.firstInstallment}</strong></div>
										</div>

										{#if claim.proposal.statusCode === 'pending_approval' && claim.proposal.id}
											<form method="POST" action="?/approvePlan" class="approval-action">
												<input type="hidden" name="planId" value={claim.proposal.id} />
												<p class="type-text-small">Die Vereinbarung wird erst nach menschlicher Prüfung verbindlich freigegeben.</p>
												<button class="raised-button raised-button--primary type-text" type="submit">Plan final freigeben</button>
											</form>
										{/if}
									</section>
								{/if}
								</section>
							</div>
						</details>
					{/each}
				</div>
			</section>
		</section>

		{#if data.openTaskCount > 0 || form?.error || form?.success}
			<section class="case-actions">
				<div class="review-card">
					{#if data.openTaskCount > 0}
						<form method="POST" action="?/resolveTasks" class="action-row">
							<button class="raised-button raised-button--primary type-text" type="submit">
								{data.openTaskCount} {data.openTaskCount === 1 ? 'Aufgabe' : 'Aufgaben'} erledigen
							</button>
						</form>
					{/if}
					{#if form?.error}<p class="form-message form-message--error type-text">{form.error}</p>{/if}
					{#if form?.success}<p class="form-message type-text">{form.success}</p>{/if}
				</div>
			</section>
		{/if}
	</main>
</div>

<style>
	.detail-shell {
		min-height: 100vh;
		padding-left: 240px;
		background: #fff;
	}

	.workspace {
		min-width: 0;
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
		gap: 8px;
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.breadcrumb-link,
	.breadcrumb-current {
		white-space: nowrap;
	}

	.breadcrumb-link {
		color: rgb(0 0 0 / 0.7);
		text-decoration: none;
	}

	.breadcrumb-current {
		color: #000;
	}

	.breadcrumb-arrow {
		display: grid;
		width: 18px;
		height: 18px;
		place-items: center;
	}

	.breadcrumb-arrow img {
		display: block;
		width: 12px;
		height: 7px;
		transform: rotate(-90deg);
	}

	.detail-top {
		padding: 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.person-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 8px;
	}

	.person-heading__identity {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 10px;
	}

	.person-heading h1,
	.person-heading span {
		margin: 0;
	}

	.person-heading h1 {
		color: #000;
	}

	.person-heading span {
		width: 80px;
		color: rgb(0 0 0 / 0.5);
	}

	.demo-hint {
		margin: 0 0 24px;
		color: rgb(0 0 0 / 0.55);
	}

	.detail-panels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 32px;
	}

	.data-panel {
		overflow: hidden;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.data-panel:first-child {
		border-radius: 24px;
	}

	.data-panel h2 {
		margin: 0;
		padding: 16px 24px;
		border-bottom: 1px solid #ebebeb;
		background: #fcfbfa;
		color: #000;
	}

	.data-panel__content {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 24px;
		color: rgb(0 0 0 / 0.7);
	}

	.data-panel__content p {
		margin: 0;
	}

	.data-field {
		display: inline-flex;
		align-items: baseline;
		gap: 4px;
	}

	.data-panel__content strong {
		color: #000;
	}

	.claims-section {
		margin-top: 24px;
	}

	.claims-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 12px;
	}

	.claims-heading h2,
	.claims-heading span {
		margin: 0;
	}

	.claims-heading span {
		color: rgb(0 0 0 / 0.5);
	}

	.claims-list {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.claim-card {
		overflow: hidden;
		border: 1px solid #ebebeb;
		border-radius: 16px;
		background: #fff;
	}

	.claim-card summary {
		display: grid;
		grid-template-columns: minmax(160px, 1fr) minmax(110px, auto) minmax(120px, auto) 20px;
		align-items: center;
		gap: 20px;
		padding: 16px 20px;
		cursor: pointer;
		list-style: none;
	}

	.claim-card summary::-webkit-details-marker {
		display: none;
	}

	.claim-primary,
	.claim-details div {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}

	.claim-primary span,
	.claim-details span {
		color: rgb(0 0 0 / 0.5);
	}

	.claim-amount {
		text-align: right;
		white-space: nowrap;
	}

	.claim-status {
		justify-self: end;
		padding: 6px 10px;
		border-radius: 999px;
		background: #fff2ed;
		color: #c43a00;
		white-space: nowrap;
	}

	.claim-status.claim-success {
		background: #eaf7ed;
		color: #236b38;
	}

	.claim-status.claim-warning {
		background: #fff8e2;
		color: #9d7415;
	}

	.claim-status.claim-danger {
		background: #fff0f1;
		color: #b42318;
	}

	.claim-chevron {
		font-size: 20px;
		line-height: 1;
		transition: transform 140ms ease;
	}

	.claim-card[open] .claim-chevron {
		transform: rotate(180deg);
	}

	.claim-details {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 16px;
		padding: 16px 20px;
		border-top: 1px solid #ebebeb;
		background: #fcfbfa;
	}

	.claim-card__body {
		display: flex;
		flex-direction: column;
		background: #fcfbfa;
	}

	.payment-action {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 16px;
		padding: 16px 20px;
		border-top: 1px solid #ebebeb;
	}

	.payment-action span {
		color: rgb(0 0 0 / 0.55);
	}

	.claim-activities {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 20px;
		border-top: 1px solid #ebebeb;
	}

	.claim-activities > h3 {
		margin: 0;
	}

	.claim-timeline {
		display: flex;
		flex-direction: column;
	}

	.claim-activity {
		position: relative;
		display: grid;
		grid-template-columns: 16px 120px minmax(0, 1fr);
		align-items: center;
		gap: 16px;
		min-height: 44px;
	}

	.claim-activity:not(:last-child)::after {
		position: absolute;
		top: 30px;
		bottom: -14px;
		left: 7px;
		width: 1px;
		background: #d8d8d8;
		content: '';
	}

	.empty-activity {
		margin: 0;
		color: rgb(0 0 0 / 0.5);
	}

	.claim-summary {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px;
		border: 1px solid #ebebeb;
		border-radius: 16px;
		background: #fff;
	}

	.claim-summary__content {
		display: grid;
		grid-template-columns: minmax(160px, 0.35fr) minmax(0, 1fr);
		gap: 20px;
		color: rgb(0 0 0 / 0.7);
	}

	.claim-summary__content p {
		margin: 0;
		line-height: 1.5;
	}

	.claim-summary__content p:first-child {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.claim-summary__content strong {
		color: #000;
	}

	.timeline-dot,
	.timeline-icon {
		display: block;
		width: 16px;
		height: 16px;
		flex: 0 0 16px;
		object-fit: contain;
	}

	.timeline-time {
		width: 100px;
		color: rgb(0 0 0 / 0.5);
	}

	.timeline-status {
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	.timeline-status .missed {
		color: #ef5660;
	}

	.timeline-status .reached {
		color: #00721e;
	}

	.case-actions {
		padding: 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.review-card {
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		gap: 32px;
		margin: 0;
		padding: 24px;
		overflow: hidden;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #f6f6f6;
	}

	.review-block {
		display: flex;
		width: 100%;
		min-width: 0;
		flex-direction: column;
		gap: 16px;
	}

	.claim-proposal {
		padding: 18px;
		border: 1px solid #ebebeb;
		border-radius: 16px;
		background: #fff;
	}

	.review-heading,
	.summary-heading-group {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.review-heading img,
	.summary-heading-group img {
		display: block;
		width: 15px;
		height: 15px;
		flex: 0 0 15px;
	}

	.review-heading h3,
	.summary-heading-group h3 {
		width: 260px;
		margin: 0;
		color: #000;
	}

	.approval-status {
		margin-left: auto;
		padding: 6px 10px;
		border: 1px solid #d08a00;
		border-radius: 999px;
		background: #fff8e2;
		color: #9d7415;
		white-space: nowrap;
	}

	.approval-status.approved {
		border-color: #4f8a5b;
		background: #eaf7ed;
		color: #236b38;
	}

	.action-row {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.raised-button {
		display: inline-flex;
		height: 38.5px;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 0 16px;
		border: 1px solid #e1e1e1;
		border-radius: 10px;
		background: #fff;
		box-shadow: 0 5px 0 #e1e1e1;
		color: #000;
		transition: translate 120ms ease, box-shadow 120ms ease;
	}

	.raised-button:active {
		translate: 0 3px;
		box-shadow: 0 2px 0 #e1e1e1;
	}

	.raised-button--primary {
		border-color: #ff4c00;
		background: #ff4c00;
		box-shadow: 0 5px 0 #dd3d00;
		color: #fff;
	}

	.raised-button--primary:active { box-shadow: 0 2px 0 #dd3d00; }

	.raised-button--dark {
		border-color: #111;
		background: #111;
		box-shadow: 0 5px 0 #d7d7d7;
		color: #fff;
	}

	.raised-button--dark:active { box-shadow: 0 2px 0 #d7d7d7; }

	.form-message { margin: 0; color: #236b38; }
	.form-message--error { color: #b42318; }

	.approval-action {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 16px;
	}

	.approval-action p {
		max-width: 360px;
		margin: 0;
		color: rgb(0 0 0 / 0.55);
	}

	:global(.detail-shell .navigation-item) {
		border-radius: 10px;
	}

	.proposal-card {
		display: grid;
		grid-template-columns: repeat(4, 130px);
		justify-content: space-between;
		gap: 16px;
		padding: 20px 24px;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.proposal-card div {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.proposal-card span {
		color: rgb(0 0 0 / 0.5);
		white-space: nowrap;
	}

	.proposal-card strong {
		color: #000;
		white-space: nowrap;
	}

	@media (max-width: 900px) {
		.detail-panels {
			grid-template-columns: 1fr;
		}

		.review-card {
			width: 100%;
			margin-left: 0;
		}

		.proposal-card {
			grid-template-columns: repeat(2, minmax(130px, 1fr));
		}

		.claim-details {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 780px) {
		.detail-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

		.detail-top,
		.case-actions {
			padding: 18px;
		}
	}

	@media (max-width: 560px) {
		.person-heading {
			align-items: flex-start;
			flex-direction: column;
			gap: 4px;
		}

		.claim-activities {
			padding: 16px;
		}

		.claim-activity {
			grid-template-columns: 16px minmax(0, 1fr);
			gap: 4px 12px;
			padding: 6px 0;
		}

		.claim-activity .timeline-time,
		.claim-activity .timeline-status {
			grid-column: 2;
		}

		.claim-activity .timeline-time {
			width: auto;
		}

		.claim-activity .timeline-dot {
			grid-column: 1;
			grid-row: 1 / span 2;
		}

		.claim-summary__content {
			grid-template-columns: 1fr;
			gap: 12px;
		}

		.proposal-card {
			grid-template-columns: 1fr;
		}

		.action-row {
			flex-wrap: wrap;
		}

		.approval-action {
			align-items: flex-start;
			flex-direction: column;
		}

		.payment-action {
			align-items: flex-start;
			flex-direction: column;
		}

		.claim-card summary {
			grid-template-columns: minmax(0, 1fr) 20px;
			gap: 10px;
		}

		.claim-amount,
		.claim-status {
			justify-self: start;
			text-align: left;
		}

		.claim-chevron {
			grid-column: 2;
			grid-row: 1 / span 3;
			align-self: center;
		}

		.claim-details {
			grid-template-columns: 1fr;
		}
	}
</style>
