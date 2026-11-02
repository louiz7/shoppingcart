<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;
	const activeNav = 'Organisationen';
</script>

<svelte:head>
	<title>Organisationen · Rescova</title>
	<meta name="description" content="Mandantenübergreifende Rescova Administration" />
</svelte:head>

<div class="admin-shell">
	<Sidebar navigation={data.navigation} campaignNavigation={data.campaignNavigation} activeItem={activeNav} />

	<main class="workspace">
		<header class="topbar">
			<BackButton />
			<div>
				<h1 class="type-page-heading">Organisationen</h1>
				<p class="type-text-small">Interne Rescova-Administration</p>
			</div>
		</header>

		<div class="content">
			<details class="create-card" open={Boolean(form?.createError)}>
				<summary class="type-text-semi">Neue Organisation anlegen</summary>
				<form method="POST" action="?/create" class="create-form">
					{#if form?.createError}<p class="form-error type-text" role="alert">{form.createError}</p>{/if}
					<div class="form-grid">
						<label class="type-text">Organisation
							<input name="organizationName" required minlength="2" maxlength="160" value={form?.organizationName || ''} autocomplete="organization" />
						</label>
						<label class="type-text">Organisations-E-Mail
							<input name="organizationEmail" type="email" required value={form?.organizationEmail || ''} autocomplete="email" />
						</label>
						<label class="type-text">Name des ersten Administrators
							<input name="adminName" required maxlength="120" value={form?.adminName || ''} autocomplete="name" />
						</label>
						<label class="type-text">Admin-E-Mail
							<input name="adminEmail" type="email" required value={form?.adminEmail || ''} autocomplete="username" />
						</label>
						<label class="type-text form-wide">Initiales Passwort
							<input name="password" type="password" required minlength="12" autocomplete="new-password" />
							<small class="type-text-small">Mindestens 12 Zeichen. Sicher an den Administrator übermitteln.</small>
						</label>
						<label class="addon-option type-text form-wide">
							<input name="emailAutomationEnabled" type="checkbox" checked={form?.emailAutomationEnabled || false} />
							<span><strong class="type-text-semi">E-Mail-Add-on aktivieren</strong><small class="type-text-small">Schaltet den E-Mail-Assistenten für diese Organisation frei.</small></span>
						</label>
					</div>
					<div class="form-actions"><button class="create-button type-text-semi" type="submit">Organisation anlegen</button></div>
				</form>
			</details>

			<section class="metrics" aria-label="Gesamtkennzahlen">
				<article class="metric-card">
					<p class="type-text-semi">Organisationen</p>
					<strong class="type-text-big">{data.summary.organizations}</strong>
					<small class="type-text-small">{data.summary.activeOrganizations} aktiv</small>
				</article>
				<article class="metric-card">
					<p class="type-text-semi">Accounts</p>
					<strong class="type-text-big">{data.summary.accounts}</strong>
					<small class="type-text-small">Über alle Organisationen</small>
				</article>
				<article class="metric-card">
					<p class="type-text-semi">Gesprächsminuten</p>
					<strong class="type-text-big">{data.summary.totalMinutes}</strong>
					<small class="type-text-small">Nur verbundene Gespräche</small>
				</article>
			</section>

			<section class="organization-card" aria-labelledby="organization-title">
				<div class="section-heading">
					<div>
						<h2 id="organization-title" class="type-heading">Alle Organisationen</h2>
						<p class="type-text-small">Nutzung und angelegte Plattform-Accounts</p>
					</div>
					<span class="count type-text-small-semi">{data.organizations.length}</span>
				</div>

				<div class="table-scroll">
					<table>
						<thead>
							<tr>
								<th>Organisation</th>
								<th>Status</th>
								<th>Accounts</th>
								<th>Minuten gesamt</th>
								<th>Letzte 30 Tage</th>
								<th>Anrufe</th>
								<th aria-label="Öffnen"></th>
							</tr>
						</thead>
						<tbody>
							{#each data.organizations as organization}
								<tr>
									<td>
										<a class="organization-link" href={`/admin/organisationen/${organization.id}`}>
											<strong class="type-text">{organization.name}</strong>
											<span class="organization-email type-text-small">{organization.email}</span>
										</a>
									</td>
									<td><span class:inactive={!organization.active} class="status type-text-small-semi">{organization.active ? 'Aktiv' : 'Inaktiv'}</span></td>
									<td><strong class="type-text">{organization.accounts}</strong><span class="secondary type-text-small">{organization.activeAccounts} aktiv</span></td>
									<td class="numeric type-text-semi">{organization.totalMinutes}</td>
									<td class="numeric type-text-semi">{organization.minutes30d}</td>
									<td class="numeric type-text-semi">{organization.calls}</td>
									<td><a class="open-link" href={`/admin/organisationen/${organization.id}`} aria-label={`${organization.name} öffnen`}><img src="/figma/arrow-right.svg" alt="" width="16" height="16" /></a></td>
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
	.admin-shell { min-height: 100vh; padding-left: 240px; background: #fbfbf9; }
	.workspace { min-width: 0; min-height: 100vh; padding-top: 72px; }
	.topbar { position: fixed; z-index: 9; inset: 0 0 auto 240px; display: flex; height: 72px; align-items: center; gap: 16px; padding: 0 24px; border-bottom: 1px solid #e1e1e1; background: #fff; }
	.topbar h1, .topbar p, h2, p { margin: 0; }
	.topbar p, .metric-card p, .metric-card small, .section-heading p, .organization-email, .secondary { color: rgb(0 0 0 / 0.48); }
	.content { display: flex; flex-direction: column; gap: 24px; padding: 24px; }
	.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
	.metric-card, .organization-card, .create-card { border: 1px solid #ebebeb; border-radius: 24px; background: #fff; }
	.create-card { overflow: hidden; }
	.create-card summary { padding: 20px 24px; cursor: pointer; list-style-position: inside; }
	.create-card[open] summary { border-bottom: 1px solid #ebebeb; }
	.create-form { padding: 24px; }
	.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
	.form-grid label { display: flex; flex-direction: column; gap: 8px; }
	.form-grid input { min-height: 44px; padding: 0 13px; border: 1px solid #d8d8d8; border-radius: 10px; background: #fff; font: inherit; }
	.form-grid input:focus { border-color: #161616; outline: 2px solid rgb(0 0 0 / 0.08); }
	.form-wide { grid-column: 1 / -1; }
	.form-wide small { color: rgb(0 0 0 / 0.5); }
	.form-grid .addon-option { flex-direction: row; align-items: center; gap: 12px; padding: 14px; border: 1px solid #e1e1e1; border-radius: 12px; cursor: pointer; }
	.form-grid .addon-option input { width: 18px; min-height: 18px; margin: 0; accent-color: #111; }
	.addon-option span { display: flex; flex-direction: column; gap: 3px; }
	.form-error { margin: 0 0 18px; padding: 12px 14px; border-radius: 10px; color: #9c1c1c; background: #fff0f0; }
	.form-actions { display: flex; justify-content: flex-end; margin-top: 20px; }
	.create-button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 10px; color: #fff; background: #111; cursor: pointer; }
	.create-button:hover { background: #303030; }
	.metric-card { display: flex; min-height: 128px; flex-direction: column; justify-content: center; gap: 8px; padding: 24px; }
	.organization-card { overflow: hidden; }
	.section-heading { display: flex; align-items: center; justify-content: space-between; padding: 24px; border-bottom: 1px solid #ebebeb; }
	.section-heading > div { display: flex; flex-direction: column; gap: 4px; }
	.count { min-width: 32px; padding: 6px 10px; border-radius: 999px; background: #f1f1ed; text-align: center; }
	.table-scroll { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; min-width: 900px; }
	th, td { padding: 16px 20px; border-bottom: 1px solid #efefef; text-align: left; vertical-align: middle; }
	th { color: rgb(0 0 0 / 0.48); font-size: 13px; font-weight: 600; }
	tbody tr:last-child td { border-bottom: 0; }
	tbody tr:hover { background: #fbfbf9; }
	td:first-child, td:nth-child(3), td:last-child { display: table-cell; }
	td:first-child strong, td:first-child span, td:nth-child(3) strong, td:nth-child(3) span, td:last-child strong, td:last-child span { display: block; }
	.organization-email, .secondary { margin-top: 3px; }
	.status { display: inline-flex; padding: 5px 9px; border-radius: 999px; color: #087443; background: #e9f8ef; }
	.status.inactive { color: #666; background: #eee; }
	.numeric { font-variant-numeric: tabular-nums; }
	.organization-link { color: inherit; text-decoration: none; }
	.organization-link:hover strong { text-decoration: underline; }
	.open-link { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; border-radius: 8px; }
	.open-link:hover { background: #f0f0f0; }
	@media (max-width: 900px) { .metrics, .form-grid { grid-template-columns: 1fr; } .form-wide { grid-column: auto; } }
	@media (max-width: 720px) { .admin-shell { padding-left: 0; } .workspace { padding-top: 64px; } .topbar { left: 0; height: 64px; } .content { padding: 16px; } }
</style>
