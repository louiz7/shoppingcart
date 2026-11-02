<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;
	let defaultMaxAttempts = data.campaignDefaults.maxAttempts;
	let defaultMaxAttemptsPer24h = data.campaignDefaults.maxAttemptsPer24h;
	let defaultMaxAttemptsPer7d = data.campaignDefaults.maxAttemptsPer7d;

	function lowerDependentAttemptLimits(event: Event) {
		const nextTotal = Number((event.currentTarget as HTMLInputElement).value);
		if (!Number.isInteger(nextTotal) || nextTotal < 1 || nextTotal > 20) return;

		defaultMaxAttemptsPer7d = Math.min(defaultMaxAttemptsPer7d, nextTotal);
		defaultMaxAttemptsPer24h = Math.min(defaultMaxAttemptsPer24h, defaultMaxAttemptsPer7d);
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
		return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
	}
</script>

<svelte:head>
	<title>Einstellungen · Rescova</title>
</svelte:head>

<div class="admin-shell">
	<Sidebar navigation={data.navigation} campaignNavigation={data.campaignNavigation} activeItem="Einstellungen" />
	<main>
		<header><BackButton /><h1 class="type-page-heading">Organisation & Benutzer</h1></header>
		<div class="content">
			{#if data.organizationFilesEnabled}
				<section class="files-section">
					<div>
						<h2 class="type-heading">Dateien für Rescova</h2>
						<p class="section-note type-text">Hier könnt ihr uns beliebige Dateien bereitstellen. Die Dateien werden unverändert und nur innerhalb eurer Organisation gespeichert.</p>
					</div>
					<form method="POST" action="?/organizationFile" enctype="multipart/form-data" class="file-upload-form">
						<label class="type-text">Datei auswählen
							<input name="organizationFile" type="file" required />
						</label>
						<button class="type-text" type="submit">Datei hochladen</button>
						<small class="type-text-small">Alle Dateitypen · maximal 25 MB pro Datei</small>
					</form>
					{#if form?.fileUploadError}<p class="message error type-text">{form.fileUploadError}</p>{/if}
					{#if form?.fileUploadSuccess}<p class="message type-text">{form.fileUploadSuccess}</p>{/if}
					{#if data.organizationFiles.length > 0}
						<div class="file-list">
							{#each data.organizationFiles as file}
								<a class="file-row" href={`/admin/benutzer/dateien/${file.id}`}>
									<span><strong class="type-text">{file.name}</strong><small class="type-text-small">{file.uploadedBy} · {file.createdAt}</small></span>
									<small class="type-text-small">{formatFileSize(file.size)} · Herunterladen</small>
								</a>
							{/each}
						</div>
					{/if}
				</section>
			{/if}
			<section class:limit-reached={data.monthlyCallLimit.reached} class="limit-section">
				<div>
					<h2 class="type-heading">Monatliches Kostenlimit</h2>
					<p class="section-note type-text">Stoppt neue automatische Anrufe und pausiert aktive Kampagnen, sobald das Limit erreicht ist. Bereits laufende Gespräche werden nicht unterbrochen.</p>
				</div>
				<div class="limit-status type-text">
					<strong>{data.monthlyCallLimit.usedMinutes.toLocaleString('de-DE')} Min. verbraucht</strong>
					<span>{data.monthlyCallLimit.maxMinutes === null ? 'Kein Limit gesetzt' : `von ${data.monthlyCallLimit.maxMinutes.toLocaleString('de-DE')} Min.`}</span>
					{#if data.monthlyCallLimit.reached}<span class="limit-flag type-text-small-semi">Limit erreicht · Kampagnen pausiert</span>{/if}
				</div>
				<form method="POST" action="?/monthlyCallLimit" class="limit-form">
					<label class="type-text">Maximale Minuten pro Monat
						<input name="maxMinutes" type="number" min="1" max="10000000" step="1" value={data.monthlyCallLimit.maxMinutes ?? ''} placeholder="Leer = unbegrenzt" />
					</label>
					<button class="type-text" type="submit">Limit speichern</button>
				</form>
				{#if form?.limitError}<p class="message error type-text">{form.limitError}</p>{/if}
				{#if form?.limitSuccess}<p class="message type-text">{form.limitSuccess}</p>{/if}
			</section>
			<section class="defaults-section">
				<div>
					<h2 class="type-heading">Kampagnen-Standardwerte</h2>
					<p class="section-note type-text">Diese Werte werden in neue Kampagnen kopiert. Bestehende Kampagnen bleiben unverändert.</p>
				</div>
				<form method="POST" action="?/campaignDefaults" class="defaults-form">
					<fieldset>
						<legend class="type-text">Wochentage</legend>
						<div class="weekday-options">
							{#each [{ label: 'Mo', value: 1 }, { label: 'Di', value: 2 }, { label: 'Mi', value: 3 }, { label: 'Do', value: 4 }, { label: 'Fr', value: 5 }, { label: 'Sa', value: 6 }, { label: 'So', value: 0 }] as day}
								<label class="weekday"><input type="checkbox" name="weekdays" value={day.value} checked={data.campaignDefaults.weekdays.includes(day.value)} />{day.label}</label>
							{/each}
						</div>
					</fieldset>
					<label class="type-text">Startzeit<input name="startTime" type="time" value={data.campaignDefaults.startTime} required /></label>
					<label class="type-text">Endzeit<input name="endTime" type="time" value={data.campaignDefaults.endTime} required /></label>
					<fieldset class="contact-limits">
						<legend class="type-text">Kontaktversuche</legend>
						<p class="field-hint type-text-small">24 Stunden ≤ 7 Tage ≤ Gesamt</p>
						<div>
							<label class="type-text">Gesamt<input name="maxAttempts" type="number" min="1" max="20" bind:value={defaultMaxAttempts} oninput={lowerDependentAttemptLimits} required /></label>
							<label class="type-text">Max. in 24 Stunden<input name="maxAttemptsPer24h" type="number" min="1" max={Math.min(defaultMaxAttempts, defaultMaxAttemptsPer7d)} bind:value={defaultMaxAttemptsPer24h} required /></label>
							<label class="type-text">Max. in 7 Tagen<input name="maxAttemptsPer7d" type="number" min={defaultMaxAttemptsPer24h} max={defaultMaxAttempts} bind:value={defaultMaxAttemptsPer7d} required /></label>
						</div>
					</fieldset>
					<label class="type-text">Pause zwischen Versuchen (Minuten)<input name="retryIntervalMinutes" type="number" min="1" max="10080" value={data.campaignDefaults.retryIntervalMinutes} required /></label>
					<label class="type-text">Zeitzone<input value="Europe/Berlin" disabled /></label>
					<button class="type-text" type="submit">Standardwerte speichern</button>
				</form>
				{#if form?.settingsError}<p class="message error type-text">{form.settingsError}</p>{/if}
				{#if form?.settingsSuccess}<p class="message type-text">{form.settingsSuccess}</p>{/if}
			</section>

			<section>
				<h2 class="type-heading">Account anlegen oder Zugangsdaten ersetzen</h2>
				<form method="POST" action="?/user">
					<label class="type-text">Name<input name="displayName" required /></label>
					<label class="type-text">E-Mail<input name="email" type="email" required /></label>
					<label class="type-text">Rolle
						<select name="role">
							<option value="admin">Administrator</option>
							<option value="operator">Mitarbeiter</option>
							<option value="viewer">Nur lesen</option>
						</select>
					</label>
					<label class="type-text">Passwort<input name="password" type="password" minlength="12" autocomplete="new-password" required /></label>
					<button class="type-text" type="submit">Zugang speichern</button>
				</form>
				{#if form?.error}<p class="message error type-text">{form.error}</p>{/if}
				{#if form?.success}<p class="message type-text">{form.success}</p>{/if}
			</section>

			<section>
				<h2 class="type-heading">Bestehende Benutzer</h2>
				<div class="user-list">
					{#each data.users as user}
						<div class="user-row type-text">
							<span><strong>{user.displayName}</strong><small>{user.email}</small></span>
							<span>{user.role}</span>
							<span>{user.active ? 'Aktiv' : 'Deaktiviert'}</span>
							<span>{user.createdAt}</span>
						</div>
					{:else}
						<p class="type-text">Noch keine Benutzer vorhanden.</p>
					{/each}
				</div>
			</section>
		</div>
	</main>
</div>

<style>
	.admin-shell { min-height: 100vh; padding-left: 240px; background: #fbfbf9; }
	main { min-height: 100vh; padding-top: 57px; }
	header { position: fixed; z-index: 9; top: 0; right: 0; left: 240px; display: flex; height: 57px; align-items: center; padding: 0 24px; border-bottom: 1px solid #e1e1e1; background: #fff; }
	header h1, h2, p { margin: 0; }
	.content { display: grid; grid-template-columns: minmax(320px, 480px) 1fr; gap: 24px; padding: 24px; }
	.defaults-section, .limit-section, .files-section { grid-column: 1 / -1; }
	.files-section > div { display: grid; gap: 6px; }
	.file-upload-form { grid-template-columns: minmax(260px, 1fr) auto; align-items: end; }
	.file-upload-form small { grid-column: 1 / -1; color: rgb(0 0 0 / 0.5); }
	.file-upload-form input[type='file'] { height: auto; padding: 9px 12px; }
	.file-list { display: grid; border-top: 1px solid #ebebeb; }
	.file-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 13px 0; border-bottom: 1px solid #ebebeb; color: inherit; text-decoration: none; }
	.file-row > span { display: grid; min-width: 0; gap: 3px; }
	.file-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.file-row small { color: rgb(0 0 0 / 0.52); }
	.file-row:hover strong { text-decoration: underline; }
	.limit-section { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(220px, auto) minmax(300px, 420px); align-items: end; }
	.limit-section.limit-reached { border-color: #e5a122; background: #fffaf0; }
	.limit-status { display: grid; gap: 4px; }
	.limit-status span { color: rgb(0 0 0 / 0.58); }
	.limit-status .limit-flag { width: fit-content; margin-top: 5px; padding: 5px 9px; border-radius: 999px; background: #ffe8bd; color: #8a5200; }
	.limit-form { grid-template-columns: 1fr auto; align-items: end; }
	.defaults-section > div { display: grid; gap: 6px; }
	.section-note { color: rgb(0 0 0 / 0.58); }
	section { display: flex; flex-direction: column; gap: 20px; padding: 24px; border: 1px solid #ebebeb; border-radius: 24px; background: #fff; }
	form { display: grid; gap: 16px; }
	.defaults-form { grid-template-columns: repeat(4, minmax(150px, 1fr)); align-items: end; }
	.defaults-form fieldset { grid-column: 1 / -1; padding: 0; border: 0; }
	.contact-limits { display: grid; gap: 8px; }
	.contact-limits > div { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)); gap: 16px; }
	.field-hint { margin: 6px 0 0; color: rgb(0 0 0 / 0.5); }
	.weekday-options { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
	.weekday {
		position: relative;
		display: grid;
		width: 37px;
		height: 42px;
		place-items: center;
		gap: 0;
		padding: 8px;
		border: 1px solid #d7dee6;
		border-radius: 12px;
		background: #fff;
		color: #4e4e4e;
		cursor: pointer;
		transition: border-color 150ms ease, background-color 150ms ease, color 150ms ease;
	}
	.weekday:has(input:checked) {
		border-color: #ff4c00;
		background: rgb(255 76 0 / 0.1);
		color: #ff4c00;
	}
	.weekday:has(input:focus-visible) {
		outline: 2px solid #ff4c00;
		outline-offset: 2px;
	}
	.weekday input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		opacity: 0;
		pointer-events: none;
	}
	label { display: grid; gap: 8px; }
	input, select { height: 42px; padding: 0 12px; border: 1px solid #e1e1e1; border-radius: 10px; background: #fff; font: inherit; }
	button { width: fit-content; height: 39px; padding: 0 18px; border: 0; border-radius: 10px; background: #191919; color: #fff; cursor: pointer; }
	.message { color: #236b38; }
	.message.error { color: #b42318; }
	.user-list { display: grid; }
	.user-row { display: grid; grid-template-columns: minmax(180px, 1fr) 110px 90px 100px; gap: 16px; align-items: center; padding: 14px 0; border-bottom: 1px solid #ebebeb; }
	.user-row span:first-child { display: grid; gap: 3px; }
	.user-row small { color: rgb(0 0 0 / 0.55); }
	@media (max-width: 1100px) { .limit-section { grid-template-columns: 1fr 1fr; } .limit-section > div:first-child { grid-column: 1 / -1; } }
	@media (max-width: 1000px) { .defaults-form { grid-template-columns: repeat(2, minmax(150px, 1fr)); } }
	@media (max-width: 900px) { .content { grid-template-columns: 1fr; } }
	@media (max-width: 780px) { .admin-shell { padding-left: 0; } header { left: 0; } .user-row { grid-template-columns: 1fr 1fr; } }
	@media (max-width: 560px) { .defaults-form, .contact-limits > div, .limit-section, .limit-form, .file-upload-form { grid-template-columns: 1fr; } .limit-section > div:first-child { grid-column: auto; } .file-row { align-items: flex-start; flex-direction: column; gap: 5px; } }
</style>
