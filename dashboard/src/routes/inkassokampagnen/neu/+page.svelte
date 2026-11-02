<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import { missingImportHeaders } from '$lib/campaign-import';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	type Channel = 'Telefon' | 'SMS' | 'E-Mail';
	type PaymentOption = 'Ratenzahlung' | 'Sofortzahlungsrabatt';
	type Weekday = 'Mo' | 'Di' | 'Mi' | 'Do' | 'Fr' | 'Sa' | 'So';
	type ImportMode = 'file' | 'manual';
	type ManualContact = {
		id: string; name: string; phone: string; email: string;
		invoice: string; amount: string; dueDate: string; note: string;
	};
	type CampaignActionData = ActionData & { manualError?: boolean; manualContacts?: string };
	const actionData = form as CampaignActionData;

	function restoredContacts(): ManualContact[] {
		try {
			const parsed = JSON.parse(actionData?.manualContacts || '[]');
			return Array.isArray(parsed) ? parsed : [];
		} catch { return []; }
	}

	const weekdays: Weekday[] = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
	let campaignName = 'Inkassokampagne #1';
	const weekdayValue: Record<Weekday, number> = { So: 0, Mo: 1, Di: 2, Mi: 3, Do: 4, Fr: 5, Sa: 6 };
	const weekdayByValue = Object.fromEntries(Object.entries(weekdayValue).map(([label, value]) => [value, label])) as Record<number, Weekday>;
	let startTime = data.campaignDefaults.startTime;
	let endTime = data.campaignDefaults.endTime;
	let selectedChannels: Record<Channel, boolean> = {
		Telefon: true,
		SMS: false,
		'E-Mail': false
	};
	let selectedPaymentOptions: Record<PaymentOption, boolean> = {
		Ratenzahlung: false,
		Sofortzahlungsrabatt: false
	};
	let selectedDays: Weekday[] = data.campaignDefaults.weekdays.map((day) => weekdayByValue[day]).filter(Boolean);
	let maxAttempts = String(data.campaignDefaults.maxAttempts);
	let maxAttemptsPer24h = String(data.campaignDefaults.maxAttemptsPer24h);
	let maxAttemptsPer7d = String(data.campaignDefaults.maxAttemptsPer7d);
	let retryIntervalMinutes = String(data.campaignDefaults.retryIntervalMinutes);
	let maxInstallments = '4';
	let installmentFeePct = '10';
	let installmentMin = '300';
	let discount24h = '5';
	let discount7d = '2,5';
	let uploadInput: HTMLInputElement | undefined;
	let selectedFile: { name: string; size: string } | null = null;
	let uploadError = '';
	let importMode: ImportMode = actionData?.manualError ? 'manual' : 'file';
	let manualContacts: ManualContact[] = restoredContacts();
	let contactName = '';
	let contactPhone = '';
	let contactEmail = '';
	let contactInvoice = '';
	let contactAmount = '';
	let contactDueDate = '';
	let contactNote = '';
	let editingContactId: string | null = null;
	let manualContactError = '';
	let hideServerFileError = false;
	let isSubmitting = false;
	let submitError = '';

	function togglePaymentOption(option: PaymentOption) {
		selectedPaymentOptions = {
			...selectedPaymentOptions,
			[option]: !selectedPaymentOptions[option]
		};
	}

	function toggleDay(day: Weekday) {
		selectedDays = selectedDays.includes(day)
			? selectedDays.filter((selectedDay) => selectedDay !== day)
			: [...selectedDays, day];
	}

	function openFilePicker() {
		uploadInput?.click();
	}

	function switchImportMode(mode: ImportMode) {
		if (mode === importMode) return;
		if (mode === 'file' && manualContacts.length > 0 && !confirm('Manuell hinzugefügte Kontakte verwerfen?')) return;
		if (mode === 'manual' && selectedFile && !confirm('Ausgewählte Importdatei verwerfen?')) return;
		if (mode === 'file') {
			manualContacts = [];
			clearContactDraft();
		} else {
			selectedFile = null;
			uploadError = '';
			if (uploadInput) { uploadInput.value = ''; uploadInput.setCustomValidity(''); }
		}
		importMode = mode;
		submitError = '';
	}

	function clearContactDraft() {
		contactName = ''; contactPhone = ''; contactEmail = ''; contactInvoice = '';
		contactAmount = ''; contactDueDate = ''; contactNote = '';
		editingContactId = null; manualContactError = '';
	}

	function saveManualContact() {
		const name = contactName.trim().replace(/\s+/g, ' ');
		const phone = contactPhone.replace(/[\s()/-]/g, '').replace(/^00/, '+');
		const email = contactEmail.trim().toLowerCase();
		const invoice = contactInvoice.trim();
		const amount = Number(contactAmount.replace(/[€\s]/g, '').replace(/\./g, '').replace(',', '.'));
		if (name.length < 2 || !/^\+[1-9]\d{6,14}$/.test(phone) ||
			(email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || !invoice ||
			!Number.isFinite(amount) || amount <= 0 || !contactDueDate) {
			manualContactError = 'Bitte Name, internationale Telefonnummer, Rechnungsnummer, Betrag und Fälligkeit prüfen.';
			return;
		}
		if (manualContacts.some((contact) => contact.invoice.toLocaleLowerCase('de-DE') === invoice.toLocaleLowerCase('de-DE') && contact.id !== editingContactId)) {
			manualContactError = 'Diese Rechnungsnummer wurde bereits hinzugefügt.';
			return;
		}
		const contact: ManualContact = {
			id: editingContactId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
			name, phone, email, invoice, amount: contactAmount.trim(), dueDate: contactDueDate,
			note: contactNote.trim().slice(0, 5_000)
		};
		manualContacts = editingContactId
			? manualContacts.map((item) => item.id === editingContactId ? contact : item)
			: [...manualContacts, contact];
		clearContactDraft();
	}

	function editManualContact(contact: ManualContact) {
		editingContactId = contact.id;
		contactName = contact.name; contactPhone = contact.phone; contactEmail = contact.email;
		contactInvoice = contact.invoice; contactAmount = contact.amount;
		contactDueDate = contact.dueDate; contactNote = contact.note;
		manualContactError = '';
	}

	function removeManualContact(id: string) {
		manualContacts = manualContacts.filter((contact) => contact.id !== id);
		if (editingContactId === id) clearContactDraft();
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} KB`;
		return `${(bytes / (1024 * 1024)).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
	}

	async function readImportHeaders(file: File, extension: 'csv' | 'xlsx'): Promise<unknown[]> {
		if (extension === 'xlsx') {
			const { readSheet } = await import('read-excel-file/browser');
			const rows = await readSheet(file);
			return rows[0] || [];
		}
		const { parse } = await import('csv-parse/browser/esm/sync');
		const text = await file.text();
		const headerLine = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim().length > 0) || '';
		const commas = (headerLine.match(/,/g) || []).length;
		const semicolons = (headerLine.match(/;/g) || []).length;
		const rows = parse(headerLine, {
			bom: true,
			delimiter: semicolons > commas ? ';' : ',',
			skip_empty_lines: true,
			trim: true
		}) as unknown[][];
		return rows[0] || [];
	}

	async function handleFileSelection(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		selectedFile = null;
		uploadError = '';
		hideServerFileError = true;
		input.setCustomValidity('');

		if (!file) return;

		const extension = file.name.split('.').pop()?.toLowerCase();
		if (extension !== 'csv' && extension !== 'xlsx') {
			uploadError = 'Bitte wähle eine CSV- oder XLSX-Datei aus.';
			input.setCustomValidity(uploadError);
			input.value = '';
			return;
		}
		if (file.size > 10 * 1024 * 1024) {
			uploadError = 'Die Datei ist größer als 10 MB.';
			input.setCustomValidity(uploadError);
			input.value = '';
			return;
		}

		selectedFile = { name: file.name, size: formatFileSize(file.size) };
		try {
			const missingHeaders = missingImportHeaders(await readImportHeaders(file, extension));
			if (input.files?.[0] !== file) return;
			if (missingHeaders.length > 0) {
				uploadError = `Die Datei ist nicht korrekt formatiert. Fehlende Pflichtspalten: ${missingHeaders.join(', ')}.`;
				input.setCustomValidity(uploadError);
			}
		} catch {
			if (input.files?.[0] !== file) return;
			uploadError = 'Die Datei konnte nicht gelesen werden. Bitte prüfe das CSV- oder XLSX-Format.';
			input.setCustomValidity(uploadError);
		}
	}

	function handleStartClick(event: MouseEvent) {
		const button = event.currentTarget as HTMLButtonElement;
		const campaignForm = button.form;
		if (!campaignForm) return;
		if (importMode === 'manual' && manualContacts.length === 0) {
			event.preventDefault();
			manualContactError = 'Füge mindestens einen Kontakt hinzu, bevor du die Kampagne erstellst.';
			return;
		}
		if (campaignForm.checkValidity()) return;

		event.preventDefault();
		submitError = 'Bitte fülle alle Pflichtfelder aus und wähle eine gültige Importdatei.';
		campaignForm.reportValidity();
	}

	function handleSubmit(event: SubmitEvent) {
		if (importMode === 'manual' && manualContacts.length === 0) {
			event.preventDefault();
			manualContactError = 'Füge mindestens einen Kontakt hinzu, bevor du die Kampagne erstellst.';
			return;
		}
		submitError = '';
		isSubmitting = true;
	}

	function differsFromDefaults() {
		const selected = selectedDays.map((day) => weekdayValue[day]).sort().join(',');
		const defaults = [...data.campaignDefaults.weekdays].sort().join(',');
		return selected !== defaults || startTime !== data.campaignDefaults.startTime ||
			endTime !== data.campaignDefaults.endTime || Number(maxAttempts) !== data.campaignDefaults.maxAttempts ||
			Number(maxAttemptsPer24h) !== data.campaignDefaults.maxAttemptsPer24h ||
			Number(maxAttemptsPer7d) !== data.campaignDefaults.maxAttemptsPer7d ||
			Number(retryIntervalMinutes) !== data.campaignDefaults.retryIntervalMinutes;
	}
</script>

<svelte:head>
	<title>Neue Inkassokampagne · Rescova</title>
	<meta name="description" content="Neue Inkassokampagne in der Rescova Plattform anlegen" />
</svelte:head>

<div class="setup-shell">
	<Sidebar
		navigation={data.navigation}
		campaignNavigation={data.campaignNavigation}
		activeItem="Inkassokampagnen"
	/>

	<main class="workspace">
		<header class="topbar">
			<BackButton fallback="/inkassokampagnen" />
			<a class="breadcrumb-link type-page-heading" href="/inkassokampagnen">Inkassokampagnen</a>
			<span class="breadcrumb-arrow" aria-hidden="true">
				<img src="/figma/campaign-breadcrumb-arrow.svg" alt="" width="12" height="7" />
			</span>
			<h1 class="breadcrumb-current type-page-heading">Neue Inkassokampagne</h1>
		</header>

		<form class="setup-form" method="POST" enctype="multipart/form-data" onsubmit={handleSubmit}>
			{#each selectedDays as day}
				<input type="hidden" name="weekdays" value={weekdayValue[day]} />
			{/each}
			<input type="hidden" name="installmentsEnabled" value={selectedPaymentOptions.Ratenzahlung ? 'on' : 'off'} />
			<input type="hidden" name="discountEnabled" value={selectedPaymentOptions.Sofortzahlungsrabatt ? 'on' : 'off'} />
			<input type="hidden" name="importMode" value={importMode} />
			<input type="hidden" name="manualContacts" value={JSON.stringify(manualContacts)} />
			<section class="setup-step setup-step--import" aria-labelledby="import-heading">
				<div class="step-heading">
					<span class="step-number type-text-small-semi" aria-hidden="true">1</span>
					<h2 id="import-heading" class="type-heading">Debitorenliste Importieren</h2>
				</div>

				<div class="import-mode-tabs" role="tablist" aria-label="Kontakte hinzufügen">
					<button class:active={importMode === 'file'} class="import-mode-tab type-text-semi" type="button" role="tab" aria-selected={importMode === 'file'} onclick={() => switchImportMode('file')}>Datei importieren</button>
					<button class:active={importMode === 'manual'} class="import-mode-tab type-text-semi" type="button" role="tab" aria-selected={importMode === 'manual'} onclick={() => switchImportMode('manual')}>Manuell erfassen</button>
				</div>

				{#if importMode === 'file'}
				<div class="import-grid" role="tabpanel">
					{#if form?.fileError && !hideServerFileError}
						<div class="upload-server-error" role="alert">
							<strong class="type-text">Importdatei konnte nicht verarbeitet werden</strong>
							<span class="type-text">{form.error}</span>
						</div>
					{/if}
					<input
						bind:this={uploadInput}
						class="visually-hidden"
						name="debtors"
						type="file"
						accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
						required={importMode === 'file'}
						onchange={handleFileSelection}
					/>
					<button
						class:selected={!!selectedFile}
						class:error={!!uploadError || (!!form?.fileError && !hideServerFileError)}
						class="upload-trigger"
						type="button"
						onclick={openFilePicker}
					>
						<img class="upload-icon" src="/figma/campaign-upload.svg" alt="" width="24" height="24" />
						<span class="upload-copy">
							{#if uploadError}
								<strong class="type-text">Datei ist nicht korrekt formatiert</strong>
								{#if selectedFile}<span class="type-text">{selectedFile.name} · {selectedFile.size}</span>{/if}
								<small>{uploadError}</small>
							{:else if selectedFile}
								<strong class="type-text">Datei erfolgreich ausgewählt</strong>
								<span class="type-text">{selectedFile.name} · {selectedFile.size}</span>
								<small>Wird beim Starten der Kampagne importiert · Zum Ändern klicken</small>
							{:else}
								<span class="type-text">Debitorenliste als .csv oder .xlsx hochladen</span>
							{/if}
						</span>
					</button>
					<p class="visually-hidden" aria-live="polite">
						{selectedFile ? `${selectedFile.name} wurde erfolgreich ausgewählt.` : uploadError}
					</p>

					<div class="required-data">
						<p class="type-text">Folgende Informationen müssen in der Debitorenliste enthalten sein:</p>
						<div class="required-table" aria-label="Pflichtfelder der Debitorenliste">
							<span class="required-cell type-text">Vorname</span>
							<span class="required-cell type-text">Name</span>
							<span class="required-cell type-text">Rechnungsnummer</span>
							<span class="required-cell type-text">E-Mail-Adresse</span>
							<span class="required-cell type-text">Rechnungsbetrag</span>
							<span class="required-cell type-text">Telefonnummer</span>
							<span class="required-cell type-text">Fälligkeitsdatum</span>
							<span class="required-cell type-text">Aktenzeichen</span>
							<span class="required-cell type-text">unteraktennummer</span>
							<span class="required-cell type-text">Notiz</span>
						</div>
						<details class="csv-example">
							<summary class="type-text">
								<span class="csv-example-icon" aria-hidden="true">i</span>
								<span>Beispiel für eine korrekt formatierte CSV</span>
								<span class="csv-example-chevron" aria-hidden="true"></span>
							</summary>
							<div class="csv-example-content">
								<p>Die erste Zeile muss diese Spaltenüberschriften enthalten:</p>
								<div class="csv-preview" aria-label="Muster einer CSV-Datei">
									<code>Vorname;Name;Rechnungsnummer;E-Mail-Adresse;Rechnungsbetrag;Telefonnummer;Fälligkeitsdatum;Aktenzeichen;unteraktennummer;Notiz</code>
									<code>Max;Mustermann;RE-2026-00123;max.mustermann@beispiel.de;349,9;+49 151 23456789;15.08.2026;;;</code>
								</div>
								<a class="type-text" href="/mustervorlage-inkassokampagne.csv" download>CSV-Mustervorlage herunterladen</a>
								<p class="csv-example-note">Semikolon wird für deutsche Dezimalbeträge empfohlen. Bestehende Dateien mit einer gemeinsamen Spalte „Name“ werden weiterhin unterstützt. Telefonnummern bitte im internationalen Format und Fälligkeitsdaten als TT.MM.JJJJ oder JJJJ-MM-TT angeben.</p>
							</div>
						</details>
					</div>
				</div>
				{:else}
					<div class="manual-import" role="tabpanel">
						<section class="manual-entry-card" aria-labelledby="manual-entry-title">
							<div class="manual-entry-heading">
								<div><h3 id="manual-entry-title" class="type-text-semi">{editingContactId ? 'Kontakt bearbeiten' : 'Kontakt hinzufügen'}</h3><p class="type-text-small">Der Kontakt wird zunächst nur im Kampagnenentwurf gesammelt.</p></div>
								{#if editingContactId}<button class="manual-cancel type-text-small-semi" type="button" onclick={clearContactDraft}>Bearbeiten abbrechen</button>{/if}
							</div>
							{#if actionData?.manualError && form?.error}<p class="manual-message manual-message--error type-text" role="alert">{form.error}</p>{/if}
							{#if manualContactError}<p class="manual-message manual-message--error type-text" role="alert">{manualContactError}</p>{/if}
							<div class="manual-fields">
								<label class="type-text"><span>Name *</span><input bind:value={contactName} maxlength="200" autocomplete="name" placeholder="Max Mustermann" /></label>
								<label class="type-text"><span>Telefonnummer *</span><input bind:value={contactPhone} inputmode="tel" autocomplete="tel" placeholder="+4917612345678" /></label>
								<label class="type-text"><span>E-Mail <small>(optional)</small></span><input bind:value={contactEmail} type="email" maxlength="320" autocomplete="email" /></label>
								<label class="type-text"><span>Rechnungsnummer *</span><input bind:value={contactInvoice} maxlength="160" placeholder="RE-2026-001" /></label>
								<label class="type-text"><span>Offener Betrag *</span><input bind:value={contactAmount} inputmode="decimal" placeholder="349,90" /></label>
								<label class="type-text"><span>Fälligkeitsdatum *</span><input bind:value={contactDueDate} type="date" /></label>
								<label class="manual-note type-text"><span>Notiz <small>(optional)</small></span><textarea bind:value={contactNote} maxlength="5000" rows="2"></textarea></label>
							</div>
							<div class="manual-entry-actions"><span class="type-text-small">Maximal 250 Kontakte pro manueller Kampagne</span><button class="manual-add-button type-text-semi" type="button" onclick={saveManualContact}>{editingContactId ? 'Änderungen speichern' : 'Kontakt hinzufügen'}</button></div>
						</section>

						<aside class="manual-list-card" aria-labelledby="manual-list-title">
							<div class="manual-list-heading"><div><h3 id="manual-list-title" class="type-text-semi">Kampagnenkontakte</h3><p class="type-text-small">{manualContacts.length === 0 ? 'Noch keine Kontakte hinzugefügt' : `${manualContacts.length} ${manualContacts.length === 1 ? 'Kontakt' : 'Kontakte'} hinzugefügt`}</p></div><strong class="manual-count type-heading">{manualContacts.length}</strong></div>
							{#if manualContacts.length > 0}
								{@const latestContact = manualContacts[manualContacts.length - 1]}
								<div class="latest-contact">
									<span class="latest-label type-text-small-semi">Zuletzt hinzugefügt</span>
									<div class="manual-contact-summary"><span class="manual-avatar type-text-small-semi">{latestContact.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><span><strong class="type-text-semi">{latestContact.name}</strong><small>{latestContact.phone} · {latestContact.invoice}</small></span></div>
								</div>
								<details class="manual-all-contacts">
									<summary class="type-text-small-semi">Alle Kontakte anzeigen</summary>
									<div class="manual-contact-list">
										{#each manualContacts as contact, index}
											<div class="manual-contact-row"><span class="manual-row-index type-text-small">{index + 1}</span><span class="manual-row-copy"><strong class="type-text">{contact.name}</strong><small>{contact.invoice} · {contact.amount} €</small></span><button type="button" onclick={() => editManualContact(contact)}>Bearbeiten</button><button class="remove" type="button" onclick={() => removeManualContact(contact.id)}>Entfernen</button></div>
										{/each}
									</div>
								</details>
							{:else}
								<div class="manual-empty"><span aria-hidden="true">+</span><p class="type-text-small">Hinzugefügte Kontakte erscheinen hier kompakt als Liste.</p></div>
							{/if}
						</aside>
					</div>
				{/if}
			</section>

			<section class="setup-step setup-step--rules" aria-labelledby="rules-heading">
				<div class="step-heading">
					<span class="step-number type-text-small-semi" aria-hidden="true">2</span>
					<h2 id="rules-heading" class="type-heading">Kampagnen-Regelwerk festlegen</h2>
				</div>
				<p class:override-warning={differsFromDefaults()} class="defaults-note type-text">
					{differsFromDefaults()
						? 'Diese Kampagne weicht von den Organisations-Standardwerten ab. Die hier gespeicherten Werte gelten nur für diese Kampagne.'
						: 'Die Organisations-Standardwerte sind vorausgefüllt und werden beim Erstellen in diese Kampagne kopiert.'}
				</p>

				<div class="input-group campaign-name-group">
					<label class="type-text" for="campaign-name">Kampagnenname</label>
					<input id="campaign-name" name="campaignName" class="form-input type-text" bind:value={campaignName} required />
				</div>

				<div class="input-group">
					<p class="type-text">Kanalauswahl</p>
					<div class="channel-panel" aria-label="Kanalauswahl">
						{#each [
							{ label: 'Telefon' as Channel, icon: '/figma/icon_outbound.svg' },
							{ label: 'SMS' as Channel, icon: '/figma/campaign-send.svg' },
							{ label: 'E-Mail' as Channel, icon: '/figma/campaign-message.svg' }
						] as channel}
							<button
								class="selector-option"
								type="button"
								disabled={channel.label !== 'Telefon'}
								aria-pressed={selectedChannels[channel.label]}
							>
								{#if selectedChannels[channel.label]}
									<img class="selector-mark" src="/figma/campaign-selector-checked.svg" alt="" width="24" height="24" />
								{:else}
									<span class="selector-mark selector-mark--empty" aria-hidden="true"></span>
								{/if}
								<span class="selector-label">
									<img class="channel-icon" src={channel.icon} alt="" width="16" height="16" />
									<span class="type-text">{channel.label}{channel.label === 'Telefon' ? '' : ' · Coming soon'}</span>
								</span>
							</button>
						{/each}
					</div>
				</div>

				<div class="input-group settings-group">
					<p class="type-text">Kontakteinstellungen</p>
					<div class="settings-grid">
						<div class="settings-card attempts-card">
							<label class="type-text" for="contact-attempts">Kontaktversuche gesamt</label>
							<input id="contact-attempts" name="maxAttempts" class="form-input type-text" type="number" min={Math.max(Number(maxAttemptsPer24h), Number(maxAttemptsPer7d))} max="20" bind:value={maxAttempts} required />
						</div>
						<div class="settings-card limits-card">
							<label class="type-text"><span>Max. in 24 Stunden</span><input name="maxAttemptsPer24h" class="form-input type-text" type="number" min="1" max={Math.min(Number(maxAttempts), Number(maxAttemptsPer7d))} bind:value={maxAttemptsPer24h} required /></label>
							<label class="type-text"><span>Max. in 7 Tagen</span><input name="maxAttemptsPer7d" class="form-input type-text" type="number" min={Number(maxAttemptsPer24h)} max={Number(maxAttempts)} bind:value={maxAttemptsPer7d} required /></label>
						</div>
						<div class="settings-card retry-card">
							<label class="type-text">Pause zwischen Versuchen (Min.)<input name="retryIntervalMinutes" class="form-input type-text" type="number" min="1" max="10080" bind:value={retryIntervalMinutes} required /></label>
						</div>

						<div class="settings-card weekdays-card">
							<p class="type-text">Wochentage</p>
							<div class="weekday-list" aria-label="Ausgewählte Wochentage">
								{#each weekdays as day}
									<button
										class:active={selectedDays.includes(day)}
										class="weekday-button type-text"
										type="button"
										aria-pressed={selectedDays.includes(day)}
										onclick={() => toggleDay(day)}
									>
										{day}
									</button>
								{/each}
							</div>
						</div>

						<div class="settings-card time-card">
							<p class="type-text">Uhrzeit</p>
							<div class="time-range">
								<label class="time-input type-text">
									<input name="startTime" type="time" aria-label="Startzeit" bind:value={startTime} />
									<span>Uhr</span>
								</label>
								<span class="type-text">bis</span>
								<label class="time-input type-text">
									<input name="endTime" type="time" aria-label="Endzeit" bind:value={endTime} />
									<span>Uhr</span>
								</label>
							</div>
						</div>

						<div class="settings-card timezone-card">
							<p class="type-text">Zeitzone</p>
							<div class="timezone-input type-text"><span>Berlin, Deutschland</span><span>(MEZ)</span></div>
						</div>
					</div>
				</div>

				<div class="input-group repayment-group">
					<p class="type-text">Tilgungsoptionen</p>
					<div class="repayment-grid">
						<div class:active={selectedPaymentOptions.Ratenzahlung} class="repayment-card">
							<button
								class="selector-option"
								type="button"
								aria-pressed={selectedPaymentOptions.Ratenzahlung}
								onclick={() => togglePaymentOption('Ratenzahlung')}
							>
								{#if selectedPaymentOptions.Ratenzahlung}
									<img class="selector-mark" src="/figma/campaign-selector-checked.svg" alt="" width="24" height="24" />
								{:else}
									<span class="selector-mark selector-mark--empty" aria-hidden="true"></span>
								{/if}
								<span class="type-text">Ratenzahlung</span>
							</button>

							{#if selectedPaymentOptions.Ratenzahlung}
								<div class="repayment-fields">
									<label class="payment-field type-text">
										<span>Ratenanzahl (Max.)</span>
										<input name="maxInstallments" class="form-input type-text" bind:value={maxInstallments} aria-label="Maximale Ratenanzahl" />
									</label>
									<label class="payment-field type-text">
										<span>Gebühr</span>
										<input name="installmentFeePct" class="form-input type-text" bind:value={installmentFeePct} aria-label="Gebühr" />
									</label>
									<label class="payment-field type-text">
										<span>Min. Betrag</span>
										<input name="installmentMin" class="form-input type-text" bind:value={installmentMin} aria-label="Minimaler Betrag" />
									</label>
								</div>
							{/if}
						</div>

						<div class:active={selectedPaymentOptions.Sofortzahlungsrabatt} class="repayment-card">
							<button
								class="selector-option"
								type="button"
								aria-pressed={selectedPaymentOptions.Sofortzahlungsrabatt}
								onclick={() => togglePaymentOption('Sofortzahlungsrabatt')}
							>
								{#if selectedPaymentOptions.Sofortzahlungsrabatt}
									<img class="selector-mark" src="/figma/campaign-selector-checked.svg" alt="" width="24" height="24" />
								{:else}
									<span class="selector-mark selector-mark--empty" aria-hidden="true"></span>
								{/if}
								<span class="type-text">Sofortzahlungsrabatt</span>
							</button>

							{#if selectedPaymentOptions.Sofortzahlungsrabatt}
								<div class="repayment-fields">
									<label class="payment-field type-text">
										<span>Rabatt (24h)</span>
										<input name="discount24h" class="form-input type-text" bind:value={discount24h} aria-label="Rabatt innerhalb 24 Stunden" />
									</label>
									<label class="payment-field type-text">
										<span>Rabatt (7d)</span>
										<input name="discount7d" class="form-input type-text" bind:value={discount7d} aria-label="Rabatt innerhalb 7 Tagen" />
									</label>
								</div>
							{/if}
						</div>
					</div>
				</div>
			</section>

			<footer class="form-footer">
				<div class="submit-feedback" aria-live="polite">
					{#if submitError}
						<p class="form-error type-text">{submitError}</p>
					{:else if form?.error && !form.fileError}
						<p class="form-error type-text">{form.error}</p>
					{:else if isSubmitting}
						<p class="form-status type-text">Kampagne und Kontakte werden als Entwurf gespeichert …</p>
					{/if}
				</div>
				<button
					class="start-button type-text"
					type="submit"
					disabled={isSubmitting}
					aria-busy={isSubmitting}
					onclick={handleStartClick}
				>
					{isSubmitting ? 'Wird erstellt …' : 'Kampagne erstellen'}
				</button>
			</footer>
		</form>
	</main>
</div>

<style>
	.setup-shell {
		height: 100vh;
		height: 100dvh;
		overflow: hidden;
		padding-left: 240px;
		background: #fbfbf9;
	}

	.workspace {
		min-width: 0;
		height: 100vh;
		height: 100dvh;
		min-height: 0;
		overflow: auto;
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
		height: 6.75px;
		object-fit: contain;
		transform: rotate(-90deg);
	}

	.setup-form {
		display: flex;
		width: 100%;
		min-width: 1200px;
		min-height: calc(100vh - 57px);
		min-height: calc(100dvh - 57px);
		flex-direction: column;
		background: #fff;
	}

	.setup-step {
		width: 100%;
		padding: 24px;
		border-bottom: 1px solid #e1e1e1;
		background: #fff;
	}

	.setup-step--import {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.setup-step--rules {
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	.step-heading {
		display: flex;
		height: 24px;
		align-items: center;
		gap: 8px;
	}

	.step-heading h2,
	.input-group > p,
	.required-data > p,
	.settings-card > p,
	.timezone-card > p {
		margin: 0;
	}

	.step-heading h2 {
		color: #000;
	}

	.step-number {
		display: grid;
		width: 24px;
		height: 24px;
		flex: 0 0 24px;
		place-items: center;
		border: 1px solid #ff4c00;
		border-radius: 50%;
		background: rgb(255 76 0 / 0.1);
		color: #ff4c00;
	}

	.defaults-note { padding: 12px 16px; border: 1px solid #d7dee6; border-radius: 12px; background: #f7f8fa; color: rgb(0 0 0 / 0.65); }
	.defaults-note.override-warning { border-color: #d49a21; background: #fff8e8; color: #7a5100; }

	.import-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
		width: 100%;
	}

	.import-mode-tabs {
		display: inline-flex;
		align-self: flex-start;
		padding: 4px;
		border: 1px solid #e1e1e1;
		border-radius: 12px;
		background: #f6f6f4;
	}

	.import-mode-tab {
		min-width: 156px;
		height: 38px;
		padding: 0 16px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: rgb(0 0 0 / 0.58);
		cursor: pointer;
	}

	.import-mode-tab.active {
		background: #fff;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.1);
		color: #191919;
	}

	.manual-import {
		display: grid;
		grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.75fr);
		gap: 24px;
		align-items: start;
	}

	.manual-entry-card,
	.manual-list-card {
		border: 1px solid #e1e1e1;
		border-radius: 20px;
		background: #fff;
	}

	.manual-entry-card { padding: 20px; }
	.manual-entry-heading,
	.manual-list-heading,
	.manual-entry-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}

	.manual-entry-heading h3,
	.manual-entry-heading p,
	.manual-list-heading h3,
	.manual-list-heading p,
	.manual-message,
	.manual-empty p { margin: 0; }
	.manual-entry-heading p,
	.manual-list-heading p,
	.manual-entry-actions > span { margin-top: 3px; color: rgb(0 0 0 / 0.5); }
	.manual-cancel { border: 0; background: transparent; color: #a23a1b; cursor: pointer; }

	.manual-fields {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 15px;
		margin-top: 20px;
	}

	.manual-fields label {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 7px;
	}

	.manual-fields input,
	.manual-fields textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 10px 12px;
		border: 1px solid #d9ddd6;
		border-radius: 10px;
		background: #fff;
		font: inherit;
	}

	.manual-fields input { height: 42px; }
	.manual-fields input:focus,
	.manual-fields textarea:focus { border-color: #ff4c00; outline: 3px solid rgb(255 76 0 / 0.1); }
	.manual-fields small { color: rgb(0 0 0 / 0.45); }
	.manual-note { grid-column: 1 / -1; }
	.manual-entry-actions { margin-top: 18px; }
	.manual-add-button { min-height: 42px; padding: 0 18px; border: 0; border-radius: 10px; background: #191919; color: #fff; cursor: pointer; }
	.manual-message { margin-top: 14px; padding: 10px 12px; border-radius: 9px; }
	.manual-message--error { background: #fff0f0; color: #a51f1f; }

	.manual-list-card { overflow: hidden; }
	.manual-list-heading { padding: 18px 20px; border-bottom: 1px solid #e8ece6; }
	.manual-count { display: grid; min-width: 42px; height: 42px; place-items: center; border-radius: 12px; background: rgb(255 76 0 / 0.1); color: #ff4c00; }
	.latest-contact { padding: 17px 20px; }
	.latest-label { display: block; margin-bottom: 10px; color: rgb(0 0 0 / 0.48); text-transform: uppercase; letter-spacing: .05em; }
	.manual-contact-summary { display: flex; min-width: 0; align-items: center; gap: 11px; }
	.manual-contact-summary > span:last-child { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
	.manual-contact-summary strong,
	.manual-contact-summary small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.manual-contact-summary small { color: rgb(0 0 0 / 0.52); }
	.manual-avatar { display: grid; width: 38px; height: 38px; flex: 0 0 38px; place-items: center; border-radius: 50%; background: rgb(255 76 0 / 0.14); color: #dc4300; }
	.manual-all-contacts { border-top: 1px solid #e8ece6; }
	.manual-all-contacts summary { padding: 13px 20px; cursor: pointer; color: #ff4c00; }
	.manual-contact-list { max-height: 280px; overflow-y: auto; border-top: 1px solid #e8ece6; }
	.manual-contact-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto auto; align-items: center; gap: 9px; padding: 11px 14px; border-bottom: 1px solid #f0f0ee; }
	.manual-row-index { color: rgb(0 0 0 / 0.4); text-align: center; }
	.manual-row-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
	.manual-row-copy strong,
	.manual-row-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.manual-row-copy small { color: rgb(0 0 0 / 0.48); }
	.manual-contact-row button { padding: 5px; border: 0; background: transparent; color: #5c5c5c; cursor: pointer; font: inherit; font-size: 12px; }
	.manual-contact-row button.remove { color: #a51f1f; }
	.manual-empty { display: grid; min-height: 186px; padding: 24px; place-items: center; align-content: center; gap: 10px; color: rgb(0 0 0 / 0.48); text-align: center; }
	.manual-empty > span { display: grid; width: 42px; height: 42px; place-items: center; border: 1px dashed #c9c9c4; border-radius: 50%; font-size: 24px; }

	.upload-trigger {
		display: flex;
		height: 164px;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 1px dashed #ff4c00;
		border-radius: 24px;
		background: rgb(255 76 0 / 0.1);
		color: #ff4c00;
	}

	.upload-trigger.selected {
		border-style: solid;
		border-color: #238636;
		background: rgb(35 134 54 / 0.08);
		color: #176b2a;
	}

	.upload-trigger.error {
		height: auto;
		min-height: 164px;
		padding: 20px 24px;
		border-style: solid;
		border-color: #c62828;
		background: rgb(198 40 40 / 0.08);
		color: #a51f1f;
	}

	.upload-server-error {
		display: flex;
		grid-column: 1 / -1;
		flex-direction: column;
		gap: 6px;
		padding: 14px 16px;
		border: 1px solid #c62828;
		border-radius: 12px;
		background: rgb(198 40 40 / 0.08);
		color: #a51f1f;
	}

	.upload-copy {
		display: flex;
		max-width: calc(100% - 40px);
		min-width: 0;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		text-align: left;
	}

	.upload-copy span,
	.upload-copy small {
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.upload-copy small {
		font-size: 12px;
		opacity: 0.75;
	}

	.upload-trigger.error .upload-copy small {
		max-width: 100%;
		overflow: visible;
		line-height: 1.45;
		text-overflow: clip;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.upload-icon {
		display: block;
		width: 24px;
		height: 24px;
		flex: 0 0 24px;
		object-fit: contain;
		transform: rotate(-90deg);
	}

	.required-data {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 16px;
	}

	.required-data > p {
		color: #000;
	}

	.required-table {
		display: grid;
		height: 176px;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-template-rows: repeat(4, minmax(0, 1fr));
		overflow: hidden;
		border: 1px solid #e1e1e1;
		border-radius: 24px;
	}

	.required-cell {
		display: flex;
		min-width: 0;
		align-items: center;
		padding: 8px 16px;
		border-right: 1px solid #e1e1e1;
		border-bottom: 1px solid #e1e1e1;
		color: rgb(0 0 0 / 0.6);
		white-space: nowrap;
	}

	.required-cell:nth-child(2n) {
		border-right: 0;
	}

	.required-cell:last-child {
		grid-column: 1 / -1;
		border-right: 0;
		border-bottom: 0;
	}

	.csv-example {
		border: 1px solid #e1e1e1;
		border-radius: 14px;
		background: #fff;
	}

	.csv-example summary {
		display: flex;
		min-height: 44px;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		color: #4e4e4e;
		cursor: pointer;
		list-style: none;
	}

	.csv-example summary::-webkit-details-marker {
		display: none;
	}

	.csv-example summary:focus-visible {
		border-radius: 13px;
		outline: 2px solid #ff4c00;
		outline-offset: 2px;
	}

	.csv-example-icon {
		display: grid;
		width: 22px;
		height: 22px;
		flex: 0 0 22px;
		place-items: center;
		border: 1px solid #ff4c00;
		border-radius: 50%;
		color: #ff4c00;
		font-size: 13px;
		font-weight: 600;
	}

	.csv-example-chevron {
		width: 8px;
		height: 8px;
		margin-left: auto;
		border-right: 1.5px solid currentcolor;
		border-bottom: 1.5px solid currentcolor;
		transform: rotate(45deg);
		transition: transform 150ms ease;
	}

	.csv-example[open] .csv-example-chevron {
		transform: rotate(225deg);
	}

	.csv-example-content {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 10px;
		padding: 0 14px 14px;
		border-top: 1px solid #f0f0f0;
	}

	.csv-example-content p {
		margin: 12px 0 0;
		color: rgb(0 0 0 / 0.65);
		font-size: 13px;
		line-height: 1.45;
	}

	.csv-preview {
		display: flex;
		max-width: 100%;
		overflow-x: auto;
		flex-direction: column;
		gap: 6px;
		padding: 12px;
		border-radius: 10px;
		background: #f7f8fa;
		color: #2f3437;
		font-size: 12px;
		line-height: 1.5;
	}

	.csv-preview code {
		width: max-content;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		white-space: nowrap;
	}

	.csv-example-content .csv-example-note {
		margin-top: 0;
	}

	.input-group {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 16px;
	}

	.input-group > p,
	.input-group > label,
	.settings-card > p,
	.settings-card > label,
	.payment-field,
	.repayment-card > .selector-option {
		color: #000;
	}

	.campaign-name-group {
		width: 300px;
	}

	.form-input {
		display: block;
		width: 100%;
		height: 42px;
		min-width: 0;
		padding: 0 16px;
		border: 1px solid #d7dee6;
		border-radius: 12px;
		outline: 0;
		background: #fff;
		color: #4e4e4e;
		transition: border-color 150ms ease, box-shadow 150ms ease;
	}

	.form-input:focus {
		border-color: #ff4c00;
		box-shadow: 0 0 4px rgb(255 76 0 / 0.18), 0 0 12px rgb(255 76 0 / 0.16);
	}

	.channel-panel {
		display: flex;
		align-items: center;
		gap: 40px;
		padding: 20px 24px;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.selector-option {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0;
		background: transparent;
		text-align: left;
	}

	.selector-option:disabled {
		opacity: 0.42;
		cursor: not-allowed;
	}

	.selector-mark {
		display: block;
		width: 24px;
		height: 24px;
		flex: 0 0 24px;
	}

	.selector-mark--empty {
		border: 1px solid #ff4c00;
		border-radius: 35px;
	}

	.selector-label {
		display: flex;
		align-items: center;
		gap: 8px;
		white-space: nowrap;
	}

	.channel-icon {
		display: block;
		width: 16px;
		height: 16px;
		object-fit: contain;
	}

	.settings-group,
	.repayment-group {
		width: 100%;
	}

	.settings-grid,
	.repayment-grid {
		display: flex;
		width: 100%;
		align-items: flex-start;
		gap: 16px;
	}

	.settings-grid {
		flex-wrap: wrap;
	}

	.settings-card {
		display: flex;
		height: 128px;
		align-items: flex-start;
		justify-content: center;
		gap: 24px;
		padding: 24px;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.attempts-card {
		min-width: 220px;
		flex: 1 1 220px;
		flex-direction: column;
	}

	.limits-card { min-width: 300px; flex: 1 1 300px; }
	.limits-card label { display: grid; flex: 1; gap: 8px; }
	.limits-card label > span { min-height: 28px; }
	.retry-card { min-width: 250px; flex: 1 1 250px; flex-direction: column; }
	.retry-card label { display: grid; width: 100%; gap: 8px; }

	.attempts-card > label {
		white-space: nowrap;
	}

	.weekdays-card,
	.time-card,
	.timezone-card {
		width: max-content;
		flex: 0 0 auto;
		flex-direction: column;
	}

	.weekday-list,
	.time-range {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.weekday-button {
		display: grid;
		width: 37px;
		height: 42px;
		place-items: center;
		padding: 8px;
		border: 1px solid #d7dee6;
		border-radius: 12px;
		background: #fff;
		color: #4e4e4e;
	}

	.weekday-button.active {
		border-color: #ff4c00;
		background: rgb(255 76 0 / 0.1);
		color: #ff4c00;
	}

	.time-input,
	.timezone-input {
		display: flex;
		height: 42px;
		align-items: center;
		gap: 8px;
		padding: 0 16px;
		border: 1px solid #d7dee6;
		border-radius: 12px;
		background: #fff;
		color: #4e4e4e;
		white-space: nowrap;
	}

	.time-input input {
		width: 92px;
		min-width: 92px;
		flex: 0 0 92px;
		padding: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: inherit;
		font: inherit;
	}

	.time-input:focus-within {
		border-color: #ff4c00;
		box-shadow: 0 0 4px rgb(255 76 0 / 0.18), 0 0 12px rgb(255 76 0 / 0.16);
	}

	.repayment-card {
		display: flex;
		width: max-content;
		flex: 0 0 auto;
		flex-direction: column;
		align-items: flex-start;
		justify-content: center;
		gap: 24px;
		padding: 20px 24px;
		border: 1px solid #ebebeb;
		border-radius: 24px;
		background: #fff;
	}

	.repayment-fields {
		display: flex;
		align-items: center;
		gap: 24px;
	}

	.repayment-card.active .form-input {
		border-color: #ff4c00;
		box-shadow: 0 0 4px rgb(255 76 0 / 0.18), 0 0 12px rgb(255 76 0 / 0.16);
	}

	.payment-field {
		display: flex;
		width: 150px;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}

	.payment-field > span {
		width: 100%;
		white-space: nowrap;
	}

	.form-footer {
		display: flex;
		min-height: 91px;
		flex: 1 0 auto;
		align-items: center;
		padding: 24px 24px 28px;
		background: #fff;
		gap: 16px;
	}

	.submit-feedback {
		min-width: 0;
		flex: 1 1 auto;
	}

	.form-error {
		margin: 0;
		color: #a92500;
	}

	.form-status {
		margin: 0;
		color: #4e4e4e;
	}

	.start-button {
		display: grid;
		width: 168px;
		height: 38.5px;
		flex: 0 0 168px;
		place-items: center;
		border-radius: 10px;
		background: #ff4c00;
		box-shadow: 0 4px 0 #dd3d00;
		color: #fff;
	}

	.start-button:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
		white-space: nowrap;
	}

	@media (max-width: 780px) {
		.setup-shell {
			padding-left: 0;
		}

		.topbar {
			left: 0;
			min-width: 1200px;
		}
	}
</style>
