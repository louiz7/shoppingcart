<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import BackButton from '$lib/components/BackButton.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	const providerLabel = (provider: string) => provider === 'microsoft_graph' ? 'Microsoft 365' : 'IMAP / SMTP';
	const statusLabel = (status: string) => ({ pending: 'Wird geprüft', connected: 'Verbunden', error: 'Fehler', disabled: 'Deaktiviert' }[status] || status);
	const draftStatusLabel = (status: string) => ({ pending_approval: 'Freigabe ausstehend', approved: 'Freigegeben', sending: 'Wird versendet', sent: 'Versendet', rejected: 'Abgelehnt', failed: 'Versand fehlgeschlagen' }[status] || status);
</script>

<svelte:head><title>E-Mail-Automatisierung · Rescova</title></svelte:head>

<div class="admin-shell">
	<Sidebar navigation={data.navigation} campaignNavigation={data.campaignNavigation} activeItem="E-Mail-Assistent" />
	<main>
		<header><BackButton /><h1 class="type-page-heading">E-Mail-Automatisierung</h1></header>
		<div class="content">
			{#if data.message}<p class="notice success type-text">{data.message}</p>{/if}
			{#if form?.error}<p class="notice error type-text">{form.error}</p>{/if}
			{#if form?.success}<p class="notice success type-text">{form.success}</p>{/if}

			{#if data.shopifyEnabled}
				<section>
					<div>
						<h2 class="type-heading">Dropsize Shopify-Kontext</h2>
						<p class="muted type-text-small">Kunden- und Bestelldaten werden beim Erstellen eines E-Mail-Entwurfs live aus Shopify gelesen.</p>
					</div>
					{#if data.shopify}
						<div class="shopify-connection">
							<div><strong class="type-text">{data.shopify.name || data.shopify.domain}</strong><span class="muted type-text-small">{data.shopify.domain} · {data.shopify.status === 'connected' ? 'Verbunden' : 'Fehler'}</span></div>
							<form method="POST" action="?/disconnectShopify"><button class="danger type-text-small" type="submit">Trennen</button></form>
						</div>
						{#if data.shopify.lastError}<p class="notice error type-text">{data.shopify.lastError}</p>{/if}
					{:else}
						<form method="POST" action="?/connectShopify" class="shopify-form">
							<label class="type-text">Shopify-Shop<input name="shop" placeholder="dropsize.myshopify.com" required /></label>
							<button type="submit" class="primary type-text">Shopify verbinden</button>
						</form>
					{/if}
					{#if form?.shopifyError}<p class="notice error type-text">{form.shopifyError}</p>{/if}
					{#if form?.shopifySuccess}<p class="notice success type-text">{form.shopifySuccess}</p>{/if}
				</section>
			{/if}

			<section class="intro">
				<div>
					<h2 class="type-heading">Postfach verbinden</h2>
					<p class="type-text">Neue Verbindungen starten sicher im Entwurfsmodus. Keine Antwort wird ohne Freigabe versendet.</p>
				</div>
				<form method="POST" action="?/connectMicrosoft">
					<button type="submit" class="primary type-text">Microsoft 365 verbinden</button>
				</form>
			</section>

			<section>
				<div>
					<h2 class="type-heading">Anderes Postfach über IMAP / SMTP</h2>
					<p class="muted type-text-small">Zugangsdaten werden verschlüsselt gespeichert und ausschließlich für dieses Postfach verwendet.</p>
				</div>
				<form method="POST" action="?/connectImap" class="connection-form">
					<label class="type-text">E-Mail-Adresse<input name="email" type="email" required /></label>
					<label class="type-text">Absendername<input name="displayName" maxlength="160" /></label>
					<label class="type-text">Benutzername<input name="username" autocomplete="username" required /></label>
					<label class="type-text">Passwort / App-Passwort<input name="password" type="password" minlength="8" autocomplete="new-password" required /></label>
					<label class="type-text">IMAP-Server<input name="imapHost" placeholder="imap.example.de" required /></label>
					<label class="type-text">IMAP-Port<input name="imapPort" type="number" min="1" max="65535" value="993" required /></label>
					<label class="checkbox type-text"><input name="imapSecure" type="checkbox" checked />IMAP über TLS</label>
					<span></span>
					<label class="type-text">SMTP-Server<input name="smtpHost" placeholder="smtp.example.de" required /></label>
					<label class="type-text">SMTP-Port<input name="smtpPort" type="number" min="1" max="65535" value="587" required /></label>
					<label class="checkbox type-text"><input name="smtpSecure" type="checkbox" />Direktes TLS (typisch Port 465)</label>
					<span></span>
					<button type="submit" class="primary type-text">Postfach prüfen und speichern</button>
				</form>
				{#if form?.imapError}<p class="notice error type-text">{form.imapError}</p>{/if}
				{#if form?.imapSuccess}<p class="notice success type-text">{form.imapSuccess}</p>{/if}
			</section>

			<section>
				<h2 class="type-heading">Verbundene Postfächer</h2>
				<div class="account-list">
					{#each data.accounts as account}
						<article class="account-row">
							<div><strong class="type-text">{account.displayName || account.email}</strong><span class="muted type-text-small">{account.email} · {providerLabel(account.provider)}</span></div>
							<span class:error-status={account.status === 'error'} class="status type-text-small">{statusLabel(account.status)}</span>
							<div class="sync type-text-small">{account.lastSyncedAt ? `Letzter Abruf ${new Date(account.lastSyncedAt).toLocaleString('de-DE')}` : 'Noch nicht synchronisiert'}{#if account.lastError}<small>{account.lastError}</small>{/if}</div>
							<form method="POST" action="?/disconnect"><input type="hidden" name="accountId" value={account.id} /><button class="danger type-text-small" type="submit">Trennen</button></form>
						</article>
					{:else}<p class="muted type-text">Noch kein Postfach verbunden.</p>{/each}
				</div>
			</section>

			<section>
				<div><h2 class="type-heading">E-Mail-Entwürfe</h2><p class="muted type-text-small">Antworten werden erst nach deiner Freigabe versendet.</p></div>
				<div class="draft-list">
					{#each data.drafts as draft}
						<article class="draft">
							<div class="draft-meta type-text-small"><span>Von {draft.from}</span><span>{new Date(draft.createdAt).toLocaleString('de-DE')}</span><span>{draftStatusLabel(draft.status)}</span></div>
							<strong class="type-text">{draft.sourceSubject || '(Kein Betreff)'}</strong>
							{#if draft.shopifyContext?.match_status === 'matched' && draft.shopifyContext.order}
								<div class="context-card type-text-small">
									<strong>Shopify-Kontext · {draft.shopifyContext.order.name}</strong>
									<span>{draft.shopifyContext.customer?.display_name || draft.from} · Zahlung: {draft.shopifyContext.order.displayFinancialStatus} · Versand: {draft.shopifyContext.order.displayFulfillmentStatus}</span>
									<span>Live abgerufen: {new Date(draft.shopifyContext.fetched_at).toLocaleString('de-DE')}</span>
								</div>
							{/if}
							{#if draft.status === 'pending_approval' || draft.status === 'failed'}
								<form method="POST" action="?/approveDraft">
									<input type="hidden" name="draftId" value={draft.id} />
									<label class="type-text">Betreff<input name="subject" value={draft.subject} required /></label>
									<label class="type-text">Antwort<textarea name="body" rows="6" required>{draft.body}</textarea></label>
									<button class="primary type-text" type="submit">{draft.status === 'failed' ? 'Erneut versenden' : 'Prüfen und versenden'}</button>
								</form>
							{:else}<p class="type-text">{draft.body}</p>{/if}
						</article>
					{:else}<p class="muted type-text">Noch keine Entwürfe vorhanden.</p>{/each}
				</div>
			</section>
		</div>
	</main>
</div>

<style>
	.admin-shell { min-height: 100vh; padding-left: 240px; background: #fbfbf9; }
	main { min-height: 100vh; padding-top: 57px; }
	header { position: fixed; z-index: 9; top: 0; right: 0; left: 240px; display: flex; height: 57px; align-items: center; gap: 12px; padding: 0 24px; border-bottom: 1px solid #e1e1e1; background: #fff; }
	header h1, h2, p { margin: 0; }
	.content { display: grid; gap: 24px; padding: 24px; }
	section { display: grid; gap: 20px; padding: 24px; border: 1px solid #ebebeb; border-radius: 24px; background: #fff; }
	.intro { grid-template-columns: 1fr auto; align-items: center; }
	.intro > div, section > div:first-child { display: grid; gap: 6px; }
	.connection-form { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 16px; }
	.shopify-form { display: flex; align-items: end; gap: 12px; }
	.shopify-form label { width: min(480px, 100%); }
	.shopify-connection { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
	.shopify-connection > div { display: grid; gap: 3px; }
	label { display: grid; gap: 8px; }
	input, textarea { width: 100%; border: 1px solid #ddd; border-radius: 10px; background: #fff; font: inherit; }
	input { height: 42px; padding: 0 12px; }
	textarea { padding: 12px; resize: vertical; }
	.checkbox { display: flex; flex-direction: row; align-items: center; }
	.checkbox input { width: 18px; height: 18px; }
	button { width: fit-content; min-height: 39px; padding: 0 18px; border: 0; border-radius: 10px; cursor: pointer; }
	.primary { background: #191919; color: #fff; }
	.danger { border: 1px solid #f1c7c3; background: #fff7f6; color: #b42318; }
	.notice { padding: 12px 16px; border-radius: 12px; }
	.notice.success { background: #eef8f1; color: #236b38; }
	.notice.error { background: #fff1f0; color: #b42318; }
	.muted { color: rgb(0 0 0 / 0.58); }
	.account-list, .draft-list { display: grid; }
	.account-row { display: grid; grid-template-columns: minmax(220px, 1fr) 120px minmax(220px, 1fr) auto; gap: 18px; align-items: center; padding: 16px 0; border-bottom: 1px solid #eee; }
	.account-row > div:first-child, .sync { display: grid; gap: 3px; }
	.sync small, .error-status { color: #b42318; }
	.status { width: fit-content; padding: 5px 9px; border-radius: 999px; background: #f2f2f2; }
	.draft { display: grid; gap: 12px; padding: 18px 0; border-bottom: 1px solid #eee; }
	.draft form { display: grid; gap: 14px; }
	.draft-meta { display: flex; flex-wrap: wrap; gap: 14px; color: rgb(0 0 0 / 0.58); }
	.context-card { display: grid; gap: 4px; padding: 12px; border-radius: 10px; background: #f1f8f3; color: #245c33; }
	@media (max-width: 900px) { .account-row { grid-template-columns: 1fr 1fr; } }
	@media (max-width: 780px) { .admin-shell { padding-left: 0; } header { left: 0; } .connection-form, .intro { grid-template-columns: 1fr; } .shopify-form { align-items: stretch; flex-direction: column; } }
</style>
