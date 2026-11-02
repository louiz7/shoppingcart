<script lang="ts">
	import { tick } from 'svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import LiveRefresh from '$lib/components/LiveRefresh.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;
	type CampaignActionData = ActionData & {
		editForm?: boolean;
		deleteForm?: boolean;
		pauseForm?: boolean;
		addDebtorForm?: boolean;
		addDebtorSuccess?: string;
		debtorValues?: { name?: string; phone?: string; email?: string; invoice?: string; amount?: string; dueDate?: string; note?: string };
		callbackCount?: number;
	};
	const editAction = form as CampaignActionData;
	const weekdayOptions = [
		{ label: 'Mo', value: 1 }, { label: 'Di', value: 2 }, { label: 'Mi', value: 3 },
		{ label: 'Do', value: 4 }, { label: 'Fr', value: 5 }, { label: 'Sa', value: 6 },
		{ label: 'So', value: 0 }
	];
	let paymentDate = new Date().toISOString().slice(0, 10);
	let showDeleteConfirmation = Boolean(editAction?.deleteForm);
	let showEditDialog = Boolean(editAction?.editForm);
	let showPauseConfirmation = Boolean(editAction?.pauseForm);
	let deleteConfirmButton: HTMLButtonElement;
	let pauseConfirmButton: HTMLButtonElement;
	let editName = data.editableConfiguration.name;
	let editWeekdays = [...data.editableConfiguration.weekdays];
	let editStartTime = data.editableConfiguration.startTime;
	let editEndTime = data.editableConfiguration.endTime;
	let editMaxAttempts = data.editableConfiguration.maxAttempts;
	let editMaxAttemptsPer24h = data.editableConfiguration.maxAttemptsPer24h;
	let editMaxAttemptsPer7d = data.editableConfiguration.maxAttemptsPer7d;
	let editRetryIntervalMinutes = data.editableConfiguration.retryIntervalMinutes;
	let editInstallmentsEnabled = data.editableConfiguration.installmentsEnabled;
	let editMaxInstallments = data.editableConfiguration.maxInstallments;
	let editInstallmentFeePct = data.editableConfiguration.installmentFeePct;
	let editInstallmentMin = data.editableConfiguration.installmentMin;
	let editDiscountEnabled = data.editableConfiguration.discountEnabled;
	let editDiscount24h = data.editableConfiguration.discount24h;
	let editDiscount7d = data.editableConfiguration.discount7d;

	async function openDeleteConfirmation() {
		showDeleteConfirmation = true;
		await tick();
		deleteConfirmButton?.focus();
	}

	function closeDeleteConfirmation() {
		showDeleteConfirmation = false;
	}

	async function openPauseConfirmation() {
		showPauseConfirmation = true;
		await tick();
		pauseConfirmButton?.focus();
	}

	function closePauseConfirmation() {
		showPauseConfirmation = false;
	}

	function openEditDialog() {
		editName = data.editableConfiguration.name;
		editWeekdays = [...data.editableConfiguration.weekdays];
		editStartTime = data.editableConfiguration.startTime;
		editEndTime = data.editableConfiguration.endTime;
		editMaxAttempts = data.editableConfiguration.maxAttempts;
		editMaxAttemptsPer24h = data.editableConfiguration.maxAttemptsPer24h;
		editMaxAttemptsPer7d = data.editableConfiguration.maxAttemptsPer7d;
		editRetryIntervalMinutes = data.editableConfiguration.retryIntervalMinutes;
		editInstallmentsEnabled = data.editableConfiguration.installmentsEnabled;
		editMaxInstallments = data.editableConfiguration.maxInstallments;
		editInstallmentFeePct = data.editableConfiguration.installmentFeePct;
		editInstallmentMin = data.editableConfiguration.installmentMin;
		editDiscountEnabled = data.editableConfiguration.discountEnabled;
		editDiscount24h = data.editableConfiguration.discount24h;
		editDiscount7d = data.editableConfiguration.discount7d;
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
	}

	function toggleEditWeekday(day: number) {
		editWeekdays = editWeekdays.includes(day)
			? editWeekdays.filter((selectedDay) => selectedDay !== day)
			: [...editWeekdays, day];
	}

	function handleKeydown(event: KeyboardEvent) {
		if (showDeleteConfirmation && event.key === 'Escape') closeDeleteConfirmation();
		if (showPauseConfirmation && event.key === 'Escape') closePauseConfirmation();
		if (showEditDialog && event.key === 'Escape') closeEditDialog();
	}

	function editDiffersFromDefaults() {
		return [...editWeekdays].sort().join(',') !== [...data.organizationDefaults.weekdays].sort().join(',') ||
			editStartTime !== data.organizationDefaults.startTime || editEndTime !== data.organizationDefaults.endTime ||
			Number(editMaxAttempts) !== data.organizationDefaults.maxAttempts ||
			Number(editMaxAttemptsPer24h) !== data.organizationDefaults.maxAttemptsPer24h ||
			Number(editMaxAttemptsPer7d) !== data.organizationDefaults.maxAttemptsPer7d ||
			Number(editRetryIntervalMinutes) !== data.organizationDefaults.retryIntervalMinutes;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<svelte:head>
	<title>{data.campaign.name} · Rescova</title>
	<meta name="description" content={`Übersicht der ${data.campaign.name} in der Rescova Plattform`} />
</svelte:head>

<div class="campaign-detail-shell">
	<LiveRefresh />
	<Sidebar
		navigation={data.navigation}
		campaignNavigation={data.campaignNavigation}
		activeItem="Inkassokampagnen"
	/>

	<main class="workspace">
		<header class="topbar" aria-label="Navigationspfad">
			<BackButton fallback="/inkassokampagnen" />
			<a class="breadcrumb-link type-page-heading" href="/inkassokampagnen">Inkassokampagnen</a>
			<span class="breadcrumb-arrow" aria-hidden="true">
				<img src="/figma/breadcrumb-arrow.svg" alt="" width="12" height="7" />
			</span>
			<h1 class="breadcrumb-current type-page-heading">{data.campaign.name}</h1>
		</header>

		<div class="campaign-detail-content">
			<div class="campaign-detail-content__inner">
				<section class="performance-card" aria-label="Anrufauswertung">
					<div class="performance-grid">
						{#each data.performance as metric}
							<article class="performance-metric">
								<div class="metric-copy">
									<strong class="metric-number type-text-big">{metric.value}</strong>
									<span class="metric-label type-text-semi">{metric.label}</span>
									{#if metric.rate}
										<span class="metric-rate type-text-semi">{metric.rate}</span>
									{:else}
										<span class="metric-rate metric-rate--empty" aria-hidden="true"></span>
									{/if}
								</div>
								<div class="metric-strip" aria-hidden="true">
									<span class="metric-strip__fill" style:background-color={metric.barColor}></span>
								</div>
							</article>
						{/each}
					</div>
				</section>

				<section class="configuration-card" aria-labelledby="configuration-title">
					<header class="configuration-card__header">
						<h2 id="configuration-title" class="type-heading">Konfiguration</h2>
						<div class="configuration-card__actions">
							{#if data.campaign.statusCode !== 'draft'}
								<span class="campaign-state type-text">
									<span class="campaign-state__dot" aria-hidden="true">
										<img src="/figma/campaign-status-active.svg" alt="" width="14" height="14" />
									</span>
									{data.campaign.status}
								</span>
							{/if}
							{#if data.campaign.statusCode !== 'completed' && data.campaign.statusCode !== 'cancelled'}
								<button class="raised-button raised-button--edit type-text" type="button" onclick={openEditDialog}>
									Kampagne bearbeiten
								</button>
							{/if}
							{#if data.campaign.statusCode === 'draft'}
								<button class="raised-button raised-button--start type-text" type="button" disabled aria-describedby="calling-paused-note">
									Kampagne starten
								</button>
							{:else if data.campaign.statusCode === 'active' && data.pendingCallbackCount > 0}
								<button class="raised-button raised-button--dark type-text" type="button" onclick={openPauseConfirmation}>
									Kampagne pausieren
								</button>
							{:else if data.campaign.statusCode === 'active'}
								<form method="POST" action="?/status">
									<input type="hidden" name="status" value="paused" />
									<button class="raised-button raised-button--dark type-text" type="submit">
										Kampagne pausieren
									</button>
								</form>
							{:else if data.campaign.statusCode === 'paused' && !data.campaign.minuteLimitReached}
								<button class="raised-button raised-button--dark type-text" type="button" disabled aria-describedby="calling-paused-note">
									Kampagne fortsetzen
								</button>
							{/if}
							<button
								class="raised-button raised-button--danger type-text"
								type="button"
								onclick={openDeleteConfirmation}
							>
								Kampagne löschen
							</button>
						</div>
					</header>
					<p id="calling-paused-note" class="calling-paused-note type-text">Anrufe sind vorübergehend nicht verfügbar. Kampagnen können aktuell nicht gestartet oder fortgesetzt werden.</p>
					{#if data.campaign.minuteLimitReached}
						<p class="limit-note type-text">Das monatliche Minutenlimit ist erreicht. Automatische Anrufe sind pausiert. Ein Organisations-Admin kann das Limit unter Einstellungen erhöhen oder deaktivieren.</p>
					{/if}
					{#if data.campaign.isDemo}
						<p class="demo-mode-note type-text">
							Demo-Modus: Diese Kampagne kann jederzeit gestartet werden. Zeitfenster und historische Kontaktlimits werden nicht angewendet. Nach dem Pausieren startet „Kampagne fortsetzen“ einen offenen Versuch sofort erneut.
						</p>
					{/if}

					<div class="configuration-grid">
						<div class="configuration-section configuration-section--channels">
							<span class="configuration-label type-text-small-semi">Kanäle</span>
							<span class="configuration-value type-text">{data.configuration.channels}</span>
						</div>
						<div class="configuration-section configuration-section--schedule">
							<div>
								<span class="configuration-label type-text-small-semi">Wochentage</span>
								<span class="configuration-value type-text">{data.configuration.weekdays}</span>
							</div>
							<div>
								<span class="configuration-label type-text-small-semi">Uhrzeit</span>
								<span class="configuration-value type-text">{data.configuration.time}</span>
							</div>
							<div>
								<span class="configuration-label type-text-small-semi">Zeitzone</span>
								<span class="configuration-value type-text">{data.configuration.timezone}</span>
							</div>
						</div>
						<div class="configuration-section configuration-section--attempts">
							<span class="configuration-label type-text-small-semi">Kontaktversuche</span>
							<div class="attempt-limits type-text">
								<span><strong>{data.configuration.attempts.total}</strong> gesamt</span>
								<span><strong>{data.configuration.attempts.per24h}</strong> in 24h</span>
								<span><strong>{data.configuration.attempts.per7d}</strong> in 7 Tagen</span>
								<span><strong>{data.configuration.attempts.retryMinutes} Min.</strong> Pause</span>
							</div>
						</div>
						<div class="configuration-section configuration-section--payment">
							<div>
								<span class="configuration-label type-text-small-semi">Ratenzahlung</span>
								<span class="configuration-value type-text">{data.configuration.installments}</span>
							</div>
							<div>
								<span class="configuration-label type-text-small-semi">Sofortzahlungsrabatt</span>
								<span class="configuration-value type-text">{data.configuration.discount}</span>
							</div>
						</div>
					</div>
				</section>

				<section class="payment-card" aria-labelledby="payment-title">
					<h2 id="payment-title" class="type-heading">Zahlung manuell erfassen</h2>
					<form method="POST" action="?/payment" class="payment-form">
						<label class="type-text">
							<span>Kontakt</span>
							<select name="caseId" required>
								<option value="">Kontakt auswählen</option>
								{#each data.contacts as contact}
									<option value={contact.caseId}>{contact.name} · #{contact.id}</option>
								{/each}
							</select>
						</label>
						<label class="type-text">
							<span>Betrag</span>
							<input name="amount" inputmode="decimal" placeholder="0,00" required />
						</label>
						<label class="type-text">
							<span>Zahlungsdatum</span>
							<input name="paidAt" type="date" bind:value={paymentDate} required />
						</label>
						<label class="type-text payment-note">
							<span>Notiz</span>
							<input name="note" maxlength="500" placeholder="Optional" />
						</label>
						<button class="raised-button raised-button--dark type-text" type="submit">Zahlung speichern</button>
					</form>
					{#if form?.error && !editAction?.editForm && !editAction?.deleteForm && !editAction?.addDebtorForm}<p class="form-message form-message--error type-text">{form.error}</p>{/if}
					{#if form?.success}<p class="form-message type-text">{form.success}</p>{/if}
				</section>

				<section class="contacts-section" aria-labelledby="contacts-title">
					<div class="campaign-tabs" role="tablist" aria-label="Kampagnendaten">
						<button class="campaign-tab campaign-tab--active" type="button" role="tab" aria-selected="true">
							<img src="/figma/campaign-users-active.svg" alt="" width="19" height="19" />
							<span id="contacts-title" class="type-text-semi">Kontakte</span>
						</button>
						<a class="campaign-tab" href={`/anrufliste?campaign=${data.campaign.id}`}>
							<img class="campaign-tab__phone-icon" src="/figma/icon_phone.svg" alt="" width="17" height="17" />
							<span class="type-text">Anrufliste</span>
						</a>
						<a class="campaign-tab" href={`/postfach?campaign=${data.campaign.id}`}>
							<img src="/figma/icon_folder.svg" alt="" width="19" height="19" />
							<span class="type-text">Aufgaben</span>
						</a>
						<span class="campaign-tabs__fill" aria-hidden="true"></span>
					</div>

					<div class="contact-table" role="tabpanel" aria-labelledby="contacts-title">
						<div class="contact-table__header" aria-hidden="true">
							<span class="contact-cell contact-cell--person type-text-semi">Kontakt</span>
							<span class="contact-cell contact-cell--phone type-text-semi">Telefonnummer</span>
							<span class="contact-cell contact-cell--status type-text-semi">Status</span>
							<span class="contact-cell contact-cell--attempts type-text-semi">Kontaktversuche</span>
							<span class="contact-cell contact-cell--arrow"></span>
						</div>

						{#each data.contacts as contact}
							<a class="contact-row" href={`/postfach/${contact.debtorId}`} aria-label={`Kontakt ${contact.name} öffnen`}>
								<span class="contact-cell contact-cell--person contact-person">
									<span class="contact-avatar type-text-small-semi">{contact.initials}</span>
									<span class="contact-name type-text">{contact.name}</span>
									<span class="contact-id type-text">#{contact.id}</span>
								</span>
								<span class="contact-cell contact-cell--phone type-text">{contact.phone}</span>
								<span class="contact-cell contact-cell--status type-text">{contact.status}</span>
								<span class="contact-cell contact-cell--attempts type-text">{contact.attempts}</span>
								<span class="contact-cell contact-cell--arrow contact-arrow">
									<img src="/figma/campaign-row-arrow.svg" alt="" width="14" height="7" />
								</span>
							</a>
						{/each}
					</div>

					{#if data.campaign.statusCode !== 'completed' && data.campaign.statusCode !== 'cancelled'}
						<details class="manual-contact-card" open={Boolean(editAction?.addDebtorForm)}>
							<summary class="type-text-semi">Kontakt manuell hinzufügen</summary>
							<form method="POST" action="?/addDebtor" class="manual-contact-form">
								{#if editAction?.addDebtorForm && form?.error}<p class="manual-form-message manual-form-message--error type-text" role="alert">{form.error}</p>{/if}
								{#if editAction?.addDebtorSuccess}<p class="manual-form-message type-text" role="status">{editAction.addDebtorSuccess}</p>{/if}
								<label class="type-text"><span>Name</span><input name="name" required minlength="2" maxlength="200" autocomplete="name" value={editAction?.debtorValues?.name || ''} /></label>
								<label class="type-text"><span>Telefonnummer</span><input name="phone" required inputmode="tel" placeholder="+4917612345678" autocomplete="tel" value={editAction?.debtorValues?.phone || ''} /></label>
								<label class="type-text"><span>E-Mail <small>(optional)</small></span><input name="email" type="email" maxlength="320" autocomplete="email" value={editAction?.debtorValues?.email || ''} /></label>
								<label class="type-text"><span>Rechnungsnummer</span><input name="invoice" required maxlength="160" value={editAction?.debtorValues?.invoice || ''} /></label>
								<label class="type-text"><span>Offener Betrag</span><input name="amount" required inputmode="decimal" placeholder="0,00" value={editAction?.debtorValues?.amount || ''} /></label>
								<label class="type-text"><span>Fälligkeitsdatum</span><input name="dueDate" required type="date" value={editAction?.debtorValues?.dueDate || ''} /></label>
								<label class="manual-contact-note type-text"><span>Notiz <small>(optional)</small></span><textarea name="note" maxlength="5000" rows="3">{editAction?.debtorValues?.note || ''}</textarea></label>
								<div class="manual-contact-actions"><button class="raised-button raised-button--dark type-text" type="submit">Zur Kampagne hinzufügen</button></div>
							</form>
						</details>
					{/if}
				</section>
			</div>
		</div>
	</main>
</div>

{#if showEditDialog}
	<div class="edit-dialog-layer">
		<button class="edit-dialog-backdrop" type="button" aria-label="Bearbeiten abbrechen" onclick={closeEditDialog}></button>
		<div class="edit-dialog" role="dialog" aria-modal="true" aria-labelledby="edit-dialog-title">
			<header class="edit-dialog__header">
				<div>
					<h2 id="edit-dialog-title" class="type-heading">Kampagne bearbeiten</h2>
					<p class="type-text-small">Kontakte und Importdatei bleiben unverändert.</p>
				</div>
				<button class="edit-dialog__close type-heading" type="button" aria-label="Dialog schließen" onclick={closeEditDialog}>×</button>
			</header>

			<form method="POST" action="?/edit" class="edit-form">
				<p class:warning={editDiffersFromDefaults()} class="edit-default-note edit-field--wide type-text-small">
					{editDiffersFromDefaults()
						? 'Diese Werte überschreiben die Organisations-Standardwerte ausschließlich für diese Kampagne.'
						: 'Diese Kampagne entspricht den aktuellen Organisations-Standardwerten.'}
				</p>
				<label class="edit-field edit-field--wide type-text">
					<span>Kampagnenname</span>
					<input name="campaignName" bind:value={editName} maxlength="200" required />
				</label>

				<fieldset class="edit-fieldset edit-field--wide">
					<legend class="type-text">Wochentage</legend>
					<div class="edit-weekdays">
						{#each weekdayOptions as day}
							<button
								class:active={editWeekdays.includes(day.value)}
								class="edit-weekday type-text"
								type="button"
								aria-pressed={editWeekdays.includes(day.value)}
								onclick={() => toggleEditWeekday(day.value)}
							>{day.label}</button>
						{/each}
					</div>
					{#each editWeekdays as day}<input type="hidden" name="weekdays" value={day} />{/each}
				</fieldset>

				<label class="edit-field type-text">
					<span>Startzeit</span>
					<input name="startTime" type="time" bind:value={editStartTime} required />
				</label>
				<label class="edit-field type-text">
					<span>Endzeit</span>
					<input name="endTime" type="time" bind:value={editEndTime} required />
				</label>
				<label class="edit-field type-text">
					<span>Kontaktversuche</span>
					<input name="maxAttempts" type="number" min={Math.max(Number(editMaxAttemptsPer24h), Number(editMaxAttemptsPer7d))} max="20" bind:value={editMaxAttempts} required />
				</label>
				<label class="edit-field type-text">
					<span>Max. in 24 Stunden</span>
					<input name="maxAttemptsPer24h" type="number" min="1" max={Math.min(Number(editMaxAttempts), Number(editMaxAttemptsPer7d))} bind:value={editMaxAttemptsPer24h} required />
				</label>
				<label class="edit-field type-text">
					<span>Max. in 7 Tagen</span>
					<input name="maxAttemptsPer7d" type="number" min={Number(editMaxAttemptsPer24h)} max={Number(editMaxAttempts)} bind:value={editMaxAttemptsPer7d} required />
				</label>
				<label class="edit-field type-text">
					<span>Pause zwischen Versuchen (Min.)</span>
					<input name="retryIntervalMinutes" type="number" min="1" max="10080" bind:value={editRetryIntervalMinutes} required />
				</label>

				<section class="edit-option edit-field--wide">
					<label class="edit-option__toggle type-text-semi">
						<input name="installmentsEnabled" type="checkbox" bind:checked={editInstallmentsEnabled} />
						<span>Ratenzahlung erlauben</span>
					</label>
					{#if editInstallmentsEnabled}
						<div class="edit-option__fields">
							<label class="edit-field type-text">
								<span>Maximale Raten</span>
								<input name="maxInstallments" type="number" min="2" max="24" bind:value={editMaxInstallments} required />
							</label>
							<label class="edit-field type-text">
								<span>Gebühr in %</span>
								<input name="installmentFeePct" inputmode="decimal" bind:value={editInstallmentFeePct} required />
							</label>
							<label class="edit-field type-text">
								<span>Mindestbetrag in €</span>
								<input name="installmentMin" inputmode="decimal" bind:value={editInstallmentMin} required />
							</label>
						</div>
					{/if}
				</section>

				<section class="edit-option edit-field--wide">
					<label class="edit-option__toggle type-text-semi">
						<input name="discountEnabled" type="checkbox" bind:checked={editDiscountEnabled} />
						<span>Sofortzahlungsrabatt erlauben</span>
					</label>
					{#if editDiscountEnabled}
						<div class="edit-option__fields edit-option__fields--discount">
							<label class="edit-field type-text">
								<span>Rabatt innerhalb 24h</span>
								<input name="discount24h" inputmode="decimal" bind:value={editDiscount24h} required />
							</label>
							<label class="edit-field type-text">
								<span>Rabatt innerhalb 7 Tagen</span>
								<input name="discount7d" inputmode="decimal" bind:value={editDiscount7d} required />
							</label>
						</div>
					{/if}
				</section>

				{#if editAction?.editForm && form?.error}
					<p class="edit-error edit-field--wide type-text" role="alert">{form.error}</p>
				{/if}

				<footer class="edit-dialog__actions edit-field--wide">
					<button class="dialog-button dialog-button--cancel type-text" type="button" onclick={closeEditDialog}>Abbrechen</button>
					<button class="dialog-button dialog-button--save type-text" type="submit">Änderungen speichern</button>
				</footer>
			</form>
		</div>
	</div>
{/if}

{#if showPauseConfirmation}
	<div class="delete-dialog-layer">
		<button
			class="delete-dialog-backdrop"
			type="button"
			aria-label="Pausieren abbrechen"
			onclick={closePauseConfirmation}
		></button>
		<div
			class="delete-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="pause-dialog-title"
			aria-describedby="pause-dialog-description"
		>
			<div class="pause-dialog__icon" aria-hidden="true">!</div>
			<div class="delete-dialog__copy">
				<h2 id="pause-dialog-title" class="type-heading">Trotz offener Rückrufe pausieren?</h2>
				<p id="pause-dialog-description" class="type-text">
					In dieser Kampagne {((editAction?.callbackCount ?? data.pendingCallbackCount) === 1) ? 'ist ein vereinbarter Rückruf' : `sind ${editAction?.callbackCount ?? data.pendingCallbackCount} vereinbarte Rückrufe`} offen. Während der Pause werden sie nicht ausgeführt und können ihren vereinbarten Zeitpunkt verpassen.
				</p>
				{#if editAction?.pauseForm && form?.error}
					<p class="delete-dialog__error type-text" role="alert">{form.error}</p>
				{/if}
			</div>
			<div class="delete-dialog__actions">
				<button class="dialog-button dialog-button--cancel type-text" type="button" onclick={closePauseConfirmation}>
					Nicht pausieren
				</button>
				<form method="POST" action="?/status">
					<input type="hidden" name="status" value="paused" />
					<input type="hidden" name="confirmCallbacks" value="true" />
					<button
						class="dialog-button dialog-button--confirm type-text"
						type="submit"
						bind:this={pauseConfirmButton}
					>
						Trotzdem pausieren
					</button>
				</form>
			</div>
		</div>
	</div>
{/if}

{#if showDeleteConfirmation}
	<div class="delete-dialog-layer">
		<button
			class="delete-dialog-backdrop"
			type="button"
			aria-label="Löschen abbrechen"
			onclick={closeDeleteConfirmation}
		></button>
		<div
			class="delete-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="delete-dialog-title"
			aria-describedby="delete-dialog-description"
		>
			<div class="delete-dialog__icon" aria-hidden="true">!</div>
			<div class="delete-dialog__copy">
				<h2 id="delete-dialog-title" class="type-heading">Kampagne wirklich löschen?</h2>
				<p id="delete-dialog-description" class="type-text">
					„{data.campaign.name}“ wird dauerhaft gelöscht. Die zugehörigen Debitoren und Fälle bleiben erhalten.
				</p>
				{#if editAction?.deleteForm && form?.error}
					<p class="delete-dialog__error type-text" role="alert">{form.error}</p>
				{/if}
			</div>
			<div class="delete-dialog__actions">
				<button class="dialog-button dialog-button--cancel type-text" type="button" onclick={closeDeleteConfirmation}>
					Abbrechen
				</button>
				<form method="POST" action="?/delete">
					<button
						class="dialog-button dialog-button--confirm type-text"
						type="submit"
						bind:this={deleteConfirmButton}
					>
						Endgültig löschen
					</button>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.campaign-detail-shell {
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
		gap: 8px;
		padding: 0 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.breadcrumb-link,
	.breadcrumb-current {
		margin: 0;
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

	.campaign-detail-content {
		min-width: 0;
		overflow-x: auto;
		padding: 24px;
		background: #fff;
	}

	.campaign-detail-content__inner {
		display: flex;
		width: 100%;
		min-width: 1152px;
		flex-direction: column;
		gap: 24px;
	}

	.performance-card,
	.configuration-card,
	.payment-card {
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.payment-card {
		padding: 24px;
	}

	.payment-card h2 {
		margin: 0 0 20px;
	}

	.payment-form {
		display: grid;
		grid-template-columns: 1.4fr 1fr 1fr 1.4fr auto;
		gap: 12px;
		align-items: end;
	}

	.payment-form label {
		display: flex;
		flex-direction: column;
		gap: 7px;
	}

	.payment-form input,
	.payment-form select {
		height: 39px;
		padding: 0 12px;
		border: 1px solid #d7dee6;
		border-radius: 10px;
		background: #fff;
		font: inherit;
	}

	.form-message {
		margin: 14px 0 0;
		color: #00721e;
	}

	.form-message--error {
		color: #a92500;
	}

	.performance-card {
		height: 312px;
		padding: 23px;
		overflow: hidden;
	}

	.performance-grid {
		display: grid;
		height: 264px;
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}

	.performance-metric {
		display: flex;
		min-width: 0;
		height: 264px;
		flex-direction: column;
		gap: 24px;
		padding: 24px 0;
	}

	.metric-copy {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.metric-number,
	.metric-label,
	.metric-rate,
	.configuration-label,
	.configuration-value,
	.contact-cell {
		margin: 0;
	}

	.metric-number {
		color: #000;
	}

	.metric-label,
	.metric-rate {
		color: rgb(0 0 0 / 0.4);
	}

	.metric-rate {
		display: block;
		min-height: 14px;
	}

	.metric-rate--empty {
		width: 25px;
	}

	.metric-strip {
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		align-items: center;
	}

	.metric-strip__fill {
		display: block;
		width: 100%;
		height: 10px;
	}

	.configuration-card {
		display: flex;
		min-height: 180.5px;
		flex-direction: column;
		gap: 24px;
		padding: 23px;
		overflow: hidden;
	}

	.configuration-card__header,
	.configuration-card__actions,
	.campaign-state,
	.raised-button {
		display: flex;
		align-items: center;
	}

	.raised-button:disabled {
		cursor: not-allowed;
		opacity: 0.48;
	}

	.configuration-card__header {
		height: 42.5px;
		justify-content: space-between;
		gap: 24px;
	}

	.configuration-card__header h2 {
		margin: 0;
		color: #000;
	}

	.demo-mode-note, .limit-note, .calling-paused-note {
		margin: 0;
		padding: 11px 14px;
		border-radius: 10px;
	}

	.demo-mode-note {
		border: 1px solid #ffb38f;
		background: #fff4ee;
		color: #8a330d;
	}

	.calling-paused-note {
		border: 1px solid #e1e1e1;
		background: #f6f6f4;
		color: rgb(0 0 0 / 0.62);
	}

	.limit-note { border: 1px solid #e5a122; background: #fff8e8; color: #704400; }

	.configuration-card__actions {
		gap: 24px;
	}

	.campaign-state {
		width: 55px;
		gap: 12px;
		color: #000;
		white-space: nowrap;
	}

	.campaign-state__dot {
		position: relative;
		display: block;
		width: 8px;
		height: 8px;
		flex: 0 0 8px;
	}

	.campaign-state__dot img {
		position: absolute;
		top: -3px;
		left: -3px;
		display: block;
		width: 14px;
		height: 14px;
	}

	.raised-button {
		height: 38.5px;
		justify-content: center;
		margin-bottom: 4px;
		padding: 0 16px;
		border-radius: 10px;
		white-space: nowrap;
	}

	.raised-button--dark {
		width: 189px;
		background: #191919;
		box-shadow: 0 4px 0 #626262;
		color: #fff;
	}

	.raised-button--start {
		min-width: 180px;
		background: #ff4c00;
		box-shadow: 0 4px 0 #dd3d00;
		color: #fff;
	}

	.raised-button--edit {
		border: 1px solid #d9d9d9;
		background: #fff;
		box-shadow: 0 4px 0 #d9d9d9;
		color: #191919;
	}

	.raised-button--edit:hover {
		background: #f7f7f5;
	}

	.raised-button--danger {
		border: 1px solid #b42318;
		background: #fff;
		color: #b42318;
	}

	.raised-button--danger:hover {
		background: #fff4f2;
	}

	.delete-dialog-layer,
	.edit-dialog-layer {
		position: fixed;
		z-index: 100;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 24px;
	}

	.delete-dialog-backdrop,
	.edit-dialog-backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		padding: 0;
		background: rgb(16 24 20 / 0.48);
		backdrop-filter: blur(2px);
	}

	.edit-dialog {
		position: relative;
		z-index: 1;
		width: min(100%, 760px);
		max-height: calc(100vh - 48px);
		max-height: calc(100dvh - 48px);
		overflow-y: auto;
		border: 1px solid #ebebeb;
		border-radius: 20px;
		background: #fff;
		box-shadow: 0 24px 64px rgb(16 24 20 / 0.2);
	}

	.edit-dialog__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 20px;
		padding: 24px;
		border-bottom: 1px solid #ebebeb;
	}

	.edit-dialog__header h2,
	.edit-dialog__header p {
		margin: 0;
	}

	.edit-dialog__header p {
		margin-top: 6px;
		color: rgb(0 0 0 / 0.55);
	}

	.edit-dialog__close {
		width: 36px;
		height: 36px;
		padding: 0;
		border-radius: 10px;
		background: #f6f6f4;
		color: #191919;
	}

	.edit-form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 18px;
		padding: 24px;
	}

	.edit-field {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 8px;
	}

	.edit-field--wide {
		grid-column: 1 / -1;
	}

	.edit-default-note { margin: 0; padding: 11px 13px; border: 1px solid #d7dee6; border-radius: 10px; background: #f7f8fa; color: rgb(0 0 0 / 0.62); }
	.edit-default-note.warning { border-color: #d49a21; background: #fff8e8; color: #7a5100; }

	.edit-field input:not([type='checkbox']) {
		width: 100%;
		height: 42px;
		padding: 0 12px;
		border: 1px solid #d7dee6;
		border-radius: 10px;
		background: #fff;
		font: inherit;
	}

	.edit-fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.edit-fieldset legend {
		margin-bottom: 8px;
	}

	.edit-weekdays {
		display: flex;
		gap: 8px;
	}

	.edit-weekday {
		width: 44px;
		height: 40px;
		border: 1px solid #d9d9d9;
		border-radius: 10px;
		background: #fff;
		color: #191919;
	}

	.edit-weekday.active {
		border-color: #ff4c00;
		background: #fff2ed;
		color: #d94300;
	}

	.edit-option {
		display: flex;
		flex-direction: column;
		gap: 16px;
		padding: 16px;
		border: 1px solid #ebebeb;
		border-radius: 14px;
		background: #fcfbfa;
	}

	.edit-option__toggle {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.edit-option__toggle input {
		width: 18px;
		height: 18px;
		accent-color: #ff4c00;
	}

	.edit-option__fields {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 14px;
	}

	.edit-option__fields--discount {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.edit-dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 4px;
	}

	.dialog-button--save {
		background: #ff4c00;
		color: #fff;
	}

	.dialog-button--save:hover {
		background: #dd3d00;
	}

	.edit-error {
		margin: 0;
		padding: 12px 14px;
		border-radius: 10px;
		background: #fff0ed;
		color: #a92500;
	}

	.delete-dialog {
		position: relative;
		z-index: 1;
		display: flex;
		width: min(100%, 440px);
		flex-direction: column;
		gap: 20px;
		padding: 24px;
		border: 1px solid #ebebeb;
		border-radius: 20px;
		background: #fff;
		box-shadow: 0 24px 64px rgb(16 24 20 / 0.2);
	}

	.delete-dialog__icon {
		display: grid;
		width: 40px;
		height: 40px;
		place-items: center;
		border-radius: 50%;
		background: #fff0ed;
		color: #b42318;
		font-size: 20px;
		font-weight: 600;
	}

	.pause-dialog__icon {
		display: grid;
		width: 40px;
		height: 40px;
		place-items: center;
		border-radius: 50%;
		background: #fff8e8;
		color: #8a5a00;
		font-size: 20px;
		font-weight: 600;
	}

	.delete-dialog__copy {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.delete-dialog__copy h2,
	.delete-dialog__copy p {
		margin: 0;
	}

	.delete-dialog__copy p {
		color: rgb(0 0 0 / 0.62);
		line-height: 1.5;
	}

	.delete-dialog__copy .delete-dialog__error {
		padding: 12px 14px;
		border-radius: 10px;
		background: #fff0ed;
		color: #a92500;
	}

	.delete-dialog__actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
	}

	.dialog-button {
		height: 40px;
		padding: 0 16px;
		border-radius: 10px;
	}

	.dialog-button--cancel {
		border: 1px solid #d9d9d9;
		background: #fff;
		color: #191919;
	}

	.dialog-button--cancel:hover {
		background: #f7f7f5;
	}

	.dialog-button--confirm {
		background: #b42318;
		color: #fff;
	}

	.dialog-button--confirm:hover {
		background: #921d14;
	}

	.configuration-grid {
		display: grid;
		grid-template-columns: 110px minmax(340px, 1.15fr) minmax(260px, 0.85fr) minmax(300px, 1fr);
		align-items: flex-start;
		align-self: stretch;
		border-radius: 24px;
	}

	.configuration-section {
		display: flex;
		min-width: 0;
		padding: 16px 22px;
		align-items: flex-start;
		align-self: stretch;
	}

	.configuration-section--channels,
	.configuration-section--attempts {
		flex-direction: column;
		gap: 8px;
	}

	.configuration-section--channels {
		min-width: 0;
	}

	.configuration-section--attempts {
		min-width: 0;
	}

	.configuration-section + .configuration-section {
		border-left: 1px solid #ebebeb;
	}

	.configuration-label {
		color: #999;
		white-space: nowrap;
	}

	.configuration-value {
		color: rgb(0 0 0 / 0.7);
		line-height: 1.4;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.configuration-section--schedule,
	.configuration-section--payment {
		gap: 24px;
	}

	.configuration-section--schedule {
		min-width: 0;
	}

	.configuration-section--payment {
		min-width: 0;
		gap: 16px;
	}

	.configuration-section--schedule > div,
	.configuration-section--payment > div {
		display: flex;
		min-width: 0;
		flex: 1 1 0;
		flex-direction: column;
		gap: 8px;
	}

	.attempt-limits {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 7px 12px;
		width: 100%;
		color: rgb(0 0 0 / 0.7);
	}

	.attempt-limits span {
		min-width: 0;
		white-space: nowrap;
	}

	.attempt-limits strong {
		color: #191919;
		font-weight: 600;
	}

	.contacts-section {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.campaign-tabs {
		display: flex;
		height: 40px;
		align-items: stretch;
		border-bottom: 1px solid #ebebeb;
	}

	.campaign-tab {
		position: relative;
		display: flex;
		height: 40px;
		align-items: center;
		gap: 8px;
		padding: 0 32px;
		background: transparent;
		color: #000;
		text-decoration: none;
		white-space: nowrap;
	}

	.campaign-tab img {
		display: block;
		width: 19px;
		height: 19px;
		object-fit: contain;
	}

	.campaign-tab .campaign-tab__phone-icon {
		width: 17px;
		height: 17px;
	}

	.campaign-tab--active {
		color: #ff4c00;
	}

	.campaign-tab--active::after {
		position: absolute;
		bottom: -1px;
		left: 0;
		width: 100%;
		height: 1px;
		background: #ff4c00;
		content: '';
	}

	.campaign-tabs__fill {
		flex: 1 1 auto;
	}

	.contact-table {
		padding: 0 24px;
	}

	.manual-contact-card {
		margin: 0 24px;
		border: 1px solid #e8ece6;
		border-radius: 16px;
		background: #fff;
	}

	.manual-contact-card summary {
		padding: 18px 20px;
		cursor: pointer;
	}

	.manual-contact-card[open] summary {
		border-bottom: 1px solid #e8ece6;
	}

	.manual-contact-form {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 16px;
		padding: 20px;
	}

	.manual-contact-form label {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 7px;
	}

	.manual-contact-form input,
	.manual-contact-form textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 11px 12px;
		border: 1px solid #d9ddd6;
		border-radius: 10px;
		background: #fff;
		font: inherit;
	}

	.manual-contact-form small { color: rgb(0 0 0 / 0.5); }
	.manual-contact-note, .manual-contact-actions, .manual-form-message { grid-column: 1 / -1; }
	.manual-contact-actions { display: flex; justify-content: flex-end; }
	.manual-form-message { margin: 0; color: #22734d; }
	.manual-form-message--error { color: #b12f2f; }

	.contact-table__header,
	.contact-row {
		display: grid;
		grid-template-columns: 250px 160px 110px 116px 24px;
		align-items: center;
		justify-content: space-between;
	}

	.contact-table__header {
		height: 32px;
		padding-bottom: 8px;
		border-bottom: 1px solid #ebebeb;
		color: rgb(0 0 0 / 0.7);
	}

	.contact-row {
		width: 100%;
		height: 69px;
		padding: 0;
		border-bottom: 1px solid #e8ece6;
		background: #fff;
		color: rgb(0 0 0 / 0.7);
		text-align: left;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.contact-row:hover {
		background: #fcfbfa;
	}

	.contact-row:last-child {
		border-bottom: 0;
	}

	.contact-cell {
		min-width: 0;
		white-space: nowrap;
	}

	.contact-cell--person {
		width: 250px;
	}

	.contact-cell--phone {
		width: 160px;
	}

	.contact-cell--status {
		width: 110px;
	}

	.contact-cell--attempts {
		width: 116px;
	}

	.contact-cell--arrow {
		width: 24px;
	}

	.contact-person {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.contact-avatar {
		display: grid;
		width: 37px;
		height: 37px;
		flex: 0 0 37px;
		place-items: center;
		border-radius: 50%;
		background: rgb(255 76 0 / 0.24);
		color: #ff4c00;
	}

	.contact-name {
		overflow: hidden;
		color: #000;
		text-overflow: ellipsis;
	}

	.contact-id {
		color: rgb(0 0 0 / 0.7);
	}

	.contact-arrow {
		display: grid;
		height: 24px;
		place-items: center;
	}

	.contact-arrow img {
		display: block;
		width: 14px;
		height: 7px;
		transform: rotate(-90deg);
	}

	@media (max-width: 780px) {
		.campaign-detail-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			padding-right: 18px;
			padding-left: 18px;
		}

		.campaign-detail-content {
			padding: 18px;
		}

		.edit-form,
		.edit-option__fields,
		.edit-option__fields--discount {
			grid-template-columns: 1fr;
		}

		.edit-weekdays {
			flex-wrap: wrap;
		}

		.manual-contact-form { grid-template-columns: 1fr; }
	}
</style>
