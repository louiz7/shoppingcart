<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import RecoveryShell from '$lib/components/RecoveryShell.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const shops = $derived(data.settings?.shops || []);
	const agentFeedback = $derived(form && 'agentValues' in form ? form : null);
	let selectedShop = $state(untrack(() => form?.values?.shopId || agentFeedback?.agentValues?.shopId || data.settings?.shops?.[0]?.id || ''));
	const shop = $derived(shops.find((item: any) => item.id === selectedShop) || shops[0]);
	let agentName = $state(untrack(() => agentFeedback?.agentValues?.name ?? data.settings?.shops?.[0]?.agentProfile?.name ?? 'Rescova'));
	let agentPersona = $state(untrack(() => agentFeedback?.agentValues?.persona ?? data.settings?.shops?.[0]?.agentProfile?.persona ?? 'assistant'));
	let agentVoice = $state(untrack(() => agentFeedback?.agentValues?.voice ?? data.settings?.shops?.[0]?.agentProfile?.voice ?? 'male'));
	let agentLanguage = $state(untrack(() => agentFeedback?.agentValues?.language ?? data.settings?.shops?.[0]?.agentProfile?.language ?? 'de'));
	let agentSubmitting = $state(false);
	let agentTransportError = $state('');
	const greeting = $derived(agentLanguage === 'en'
		? `Hi, I'm ${agentName.trim() || '…'}, the AI assistant ${agentPersona === 'founder' ? 'from the founding team at' : 'for'} ${shop?.brand || '…'}. You had something in your cart with us. Is there a product question I can help with?`
		: `Hey, hier ist ${agentName.trim() || '…'}, die KI-Assistenz ${agentPersona === 'founder' ? 'vom Gründerteam von' : 'von'} ${shop?.brand || '…'}. Du hattest etwas bei uns im Warenkorb. Ist noch eine Frage zu den Produkten offen, bei der ich helfen kann?`);
	let requestId = $state(untrack(() => form?.values?.requestId || data.requestId));
	let title = $state(untrack(() => form?.values?.title || ''));
	let code = $state(untrack(() => form?.values?.code || ''));
	let percent = $state<number | undefined>(untrack(() => form?.values ? Number(form.values.percent) : Math.min(data.settings?.shops?.[0]?.maxDiscountPercent || 10, 10)));
	let minimum = $state(untrack(() => form?.values?.minSubtotal || ((data.settings?.shops?.[0]?.minSubtotalCents || 0) / 100).toFixed(2).replace('.', ',')));
	let validDays = $state<number | undefined>(untrack(() => form?.values ? Number(form.values.validDays) : 7));
	let usageLimit = $state<number | undefined>(untrack(() => form?.values ? Number(form.values.usageLimit) : 100));
	let submitting = $state(false);
	let submitError = $state('');
	let discountUncertain = $state(untrack(() => !!form?.uncertain));
	const money = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: shop?.currency || 'EUR' }).format(cents / 100);
	const date = (value: string) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(value));
	const label = (discount: any) => discount.status === 'confirmed'
		? (Date.parse(discount.expiresAt) <= Date.now() ? 'Abgelaufen' : 'In Shopify erstellt')
		: ({ pending: 'Wird geprüft', unknown: 'Bestätigung ausstehend', failed: 'Nicht erstellt' } as Record<string, string>)[discount.status] || 'Status unbekannt';
	function changeShop() {
		const current = shops.find((item: any) => item.id === selectedShop) || shops[0];
		minimum = ((current?.minSubtotalCents || 0) / 100).toFixed(2).replace('.', ',');
		percent = Math.min(current?.maxDiscountPercent || 10, 10);
		requestId = crypto.randomUUID();
		agentName = current?.agentProfile?.name ?? 'Rescova';
		agentPersona = current?.agentProfile?.persona ?? 'assistant';
		agentVoice = current?.agentProfile?.voice ?? 'male';
		agentLanguage = current?.agentProfile?.language ?? 'de';
		agentTransportError = '';
	}
</script>

<svelte:head><title>Rescova · Einstellungen</title><meta name="description" content="Shopify-Rabattcodes für deine Recovery-Gespräche verwalten." /></svelte:head>

<RecoveryShell active="settings">
	<div class="scope-row">
		{#if shops.length > 1}<label class="shop-choice">Shop<select form="discount-form" name="shopId" bind:value={selectedShop} onchange={changeShop} disabled={submitting || agentSubmitting || discountUncertain || !!form?.uncertain || !!submitError} aria-label="Shop auswählen">{#each shops as item}<option value={item.id}>{item.brand}</option>{/each}</select></label>
		{:else}<p class="shop-name">{shop?.brand || 'Dein Shop'}</p>{/if}
		<p class="shop-domain">{shop?.domain || ''}</p>
	</div>
	<div class="page-title"><h1>Einstellungen</h1><p>Dein Agent und passende Angebote für deinen Shop.</p></div>
	{#if data.loadError}
		<div class="notice" role="alert"><p>{data.loadError}</p><a href="/recovery/settings">Erneut laden</a></div>
	{:else if !shop}
		<div class="empty"><h2>Dein erster Shop</h2><p>Verbinde Shopify mit deiner Organisation. Anrufe bleiben bis zur gesonderten Freigabe deaktiviert.</p></div>
	{:else}
		<section class="settings-row agent-row" aria-labelledby="agent-heading">
			<div class="section-copy"><h2 id="agent-heading">Dein Agent</h2><p>Name, Rolle, Stimme und Sprache für deine nächsten Gespräche.</p><p class="limits">Der Agent stellt sich immer als KI vor. Die Rolle bestimmt, in wessen Auftrag er spricht.</p></div>
			<form id="agent-profile-form" class="settings-panel" method="POST" action="?/agentProfile" aria-busy={agentSubmitting}
				use:enhance={() => {
					agentSubmitting = true; agentTransportError = '';
					return async ({ result, update }) => {
						try {
							if (result.type === 'error') agentTransportError = 'Die Einstellungen konnten nicht bestätigt werden. Bitte lade den aktuellen Stand neu oder speichere erneut.';
							else await update({ reset: false });
						} finally { agentSubmitting = false; }
					};
				}}>
				<input type="hidden" name="shopId" value={shop.id} />
				<fieldset disabled={!data.canEdit || agentSubmitting || submitting}>
					<div class="field-pair"><div class="field"><label for="agent-name">Name des Agenten</label><input id="agent-name" name="name" maxlength="40" bind:value={agentName} required autocomplete="off" aria-describedby="agent-name-hint" /><p id="agent-name-hint" class="field-hint">1–40 Zeichen. Keine Anweisungen oder Rollenbeschreibungen.</p></div><div class="field"><label for="agent-persona">Rolle</label><select id="agent-persona" name="persona" bind:value={agentPersona}><option value="assistant">KI-Assistenz des Shops</option><option value="founder">KI im Auftrag des Gründungsteams</option></select></div></div>
					<div class="field-pair"><div class="field"><label for="agent-voice">Stimme</label><select id="agent-voice" name="voice" bind:value={agentVoice}><option value="male">Männlich</option><option value="female">Weiblich</option></select></div><div class="field"><label for="agent-language">Sprache</label><select id="agent-language" name="language" bind:value={agentLanguage}><option value="de">Deutsch</option><option value="en">Englisch</option></select></div></div>
					<div class="greeting-preview" aria-label="Vorschau des Gesprächseinstiegs"><span class="preview-label">Gesprächseinstieg · Vorschau</span><p lang={agentLanguage}>{greeting}</p></div>
					<div class="form-footer"><p>Für deine nächsten Gespräche.</p><button class="primary secondary" type="submit">{agentSubmitting ? 'Speichere …' : 'Agent speichern'}</button></div>
				</fieldset>
				{#if !data.canEdit}<p class="form-message">Nur Händler-Admins können den Agenten anpassen.</p>{/if}
				{#if agentFeedback?.agentSuccess}<p class="form-message success" role="status">{agentFeedback.agentSuccess}</p>{/if}
				{#if agentFeedback?.agentError || agentTransportError}<p class="form-message" role="alert">{agentTransportError || agentFeedback?.agentError}</p>{/if}
			</form>
		</section>
		<section class="settings-row" aria-labelledby="discount-heading">
			<div class="section-copy">
				<h2 id="discount-heading">Rabattcode anlegen</h2>
				<p>Lege ein Angebot direkt in Shopify an. Dein Agent kann es nach Prüfung der Shop-Regeln im Gespräch anbieten.</p>
				<p class="limits">Erlaubt sind bis zu {shop.maxDiscountPercent} % Rabatt ab {money(shop.minSubtotalCents)} Warenwert.</p>
				<div class="preview" aria-label="Vorschau des Rabattentwurfs">
					<span class="preview-label">Dein Angebot · Entwurf</span>
					<p class="preview-offer">{percent ?? '—'}<span>% Rabatt</span></p>
					<p class="preview-code">{code.trim().toUpperCase() || 'Dein Rabattcode'}</p>
					<p class="preview-terms">Ab {minimum || '—'} {shop.currency} · {validDays ?? '—'} Tage gültig</p>
				</div>
			</div>
			<form id="discount-form" class="settings-panel" method="POST" action="?/createDiscount" aria-busy={submitting}
				use:enhance={() => {
					submitting = true; submitError = '';
					return async ({ result, update }) => {
						try {
							if (result.type === 'error') submitError = 'Keine Bestätigung erhalten. Bitte lade den Status neu, bevor du einen weiteren Code anlegst.';
							else {
								await update({ reset: false });
								discountUncertain = !!form?.uncertain;
								if (result.type === 'success') { title = ''; code = ''; requestId = crypto.randomUUID(); }
								else if (result.type === 'failure' && form?.values?.requestId) requestId = form.values.requestId;
							}
						} finally { submitting = false; }
					};
				}}>
				{#if shops.length <= 1}<input type="hidden" name="shopId" value={shop.id} />{/if}
				<input type="hidden" name="requestId" value={requestId} />
				<fieldset disabled={!data.canEdit || submitting || agentSubmitting || discountUncertain || !!form?.uncertain || !!submitError}>
					<div class="field-pair identity-fields">
					<div class="field"><label for="title">Angebotsname</label><input id="title" name="title" maxlength="80" bind:value={title} required autocomplete="off" /><p class="field-hint">Der interne Name in Shopify.</p></div>
					<div class="field"><label for="code">Rabattcode</label><input id="code" class="code-input" name="code" minlength="3" maxlength="32" pattern={'[A-Za-z0-9_\\-]{3,32}'} bind:value={code} required autocomplete="off" aria-describedby="code-hint" /><p id="code-hint" class="field-hint">3–32 Zeichen: Buchstaben, Zahlen, Bindestrich oder Unterstrich.</p></div>
					</div>
					<div class="field-pair">
						<div class="field"><label for="percent">Rabatt in %</label><input id="percent" type="number" name="percent" min="1" max={shop.maxDiscountPercent} step="1" bind:value={percent} required /></div>
						<div class="field"><label for="minimum">Mindestbestellwert ({shop.currency})</label><input id="minimum" name="minSubtotal" inputmode="decimal" pattern={'[0-9]+([,.][0-9]{1,2})?'} bind:value={minimum} required /></div>
					</div>
					<div class="field-pair">
						<div class="field"><label for="days">Gültigkeit in Tagen</label><input id="days" type="number" name="validDays" min="1" max="30" step="1" bind:value={validDays} required /></div>
						<div class="field"><label for="usage">Maximale Einlösungen</label><input id="usage" type="number" name="usageLimit" min="1" max="1000" step="1" bind:value={usageLimit} required /></div>
					</div>
					<div class="form-footer"><p>Der Code wird in deinem Shopify-Shop erstellt.</p><button class="primary" type="submit">{submitting ? 'Wird in Shopify angelegt …' : 'In Shopify anlegen'}</button></div>
				</fieldset>
				{#if !data.canEdit}<p class="form-message">Nur Händler-Admins können Rabattcodes anlegen.</p>{/if}
				{#if form?.success}<p class="form-message success" role="status">{form.success}</p>{/if}
				{#if form?.error || submitError || discountUncertain}<div class="form-message" role="alert"><p>{submitError || form?.error || 'Die Erstellung ist noch nicht bestätigt. Bitte prüfe den aktuellen Status.'}</p>{#if form?.uncertain || submitError || discountUncertain}<a href="/recovery/settings">Status aktualisieren</a>{/if}</div>{/if}
			</form>
		</section>
		<section class="settings-row catalogue-row" aria-labelledby="catalogue-heading">
			<div class="section-copy"><h2 id="catalogue-heading">Angebote für den Agenten</h2><p>Hier angelegte Codes werden vor jedem Angebot mit Shopify abgeglichen. Verfügbarkeit, Gültigkeit und Rabattgrenzen müssen weiterhin passen.</p></div>
			<div class="catalogue settings-panel">
				{#if !shop.discounts?.length}<div class="catalogue-empty"><h3>Noch kein Rabattcode angelegt</h3><p>Dein erstes Angebot erscheint hier, sobald du es in Shopify anlegst.</p></div>
				{:else}{#each shop.discounts as discount}<article class="discount-row"><div class="discount-title"><h3>{discount.title}</h3><span class="status" class:confirmed={discount.status === 'confirmed' && Date.parse(discount.expiresAt) > Date.now()}>{label(discount)}</span></div><div class="discount-details"><p class="discount-code">{discount.code}</p><p>{discount.percent} % ab {money(discount.minSubtotalCents)}</p></div><p class="discount-meta">{discount.expiresAt ? `Gültig bis ${date(discount.expiresAt)}` : 'Gültigkeit noch nicht bestätigt'} · Max. {discount.usageLimit} Einlösungen</p></article>{/each}{/if}
			</div>
		</section>
	{/if}
	{#if !data.loadError}
		<section class="settings-row connect-row" aria-labelledby="connect-heading"><div class="section-copy"><h2 id="connect-heading">{shop ? 'Weiteren Shop verbinden' : 'Shopify verbinden'}</h2><p>Jeder Shop gehört zu deiner Organisation. Die erforderlichen Zugriffsrechte bestätigst du direkt bei Shopify.</p></div><form class="settings-panel" method="POST" action="?/connect"><div class="field"><label for="domain">Shop-Adresse</label><input id="domain" name="domain" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="80" placeholder="dein-shop.myshopify.com" value={form && 'connectDomain' in form ? form.connectDomain : ''} disabled={!data.canEdit} required aria-describedby="domain-hint" /><p id="domain-hint" class="field-hint">Die vollständige Adresse mit .myshopify.com.</p></div>{#if form && 'connectError' in form && form.connectError}<p class="form-message" role="alert">{form.connectError}</p>{/if}<div class="form-footer"><p>Du wirst zur sicheren Shopify-Anmeldung weitergeleitet.</p><button class="primary" type="submit" disabled={!data.canEdit}>Shopify verbinden</button></div>{#if !data.canEdit}<p class="field-hint">Nur Händler-Admins können Shops verbinden.</p>{/if}</form></section>
	{/if}
</RecoveryShell>

<style>
	.scope-row{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:24px}.scope-row p{margin:0}.shop-name{font-weight:500}.shop-domain{font-size:13px;color:var(--muted);overflow-wrap:anywhere}.shop-choice{display:flex;align-items:center;gap:12px;font-size:13px}.shop-choice select{height:40px;padding:0 32px 0 12px;background:var(--surface);border:1px solid var(--control);border-radius:6px;color:var(--text);max-width:100%;font:inherit}
	.page-title{margin-bottom:36px}h1{font-size:24px;line-height:1.3;letter-spacing:-.6px;font-weight:600;margin:0}.page-title p{margin:8px 0 0;color:var(--muted)}h2{font-size:16px;line-height:1.5;font-weight:500;margin:0 0 8px}.section-copy>p{color:var(--muted);margin:0 0 16px;max-width:300px;line-height:1.7}.section-copy .limits{font-size:13px}
	/* 312px label + 48px gutter + 728px panel = 1088px canvas. */
	.settings-row{display:grid;grid-template-columns:minmax(0,312px) minmax(0,1fr);gap:48px;align-items:start;padding-bottom:36px}.settings-row+.settings-row{border-top:1px solid var(--border);padding-top:36px}.section-copy{padding-top:4px}.settings-panel{min-width:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:28px;margin:0}
	.empty+.connect-row{padding-top:32px}.connect-row .form-message{margin:0 0 20px;padding-top:0;border-top:0}
	.field select{width:100%;min-width:0;min-height:42px;border:1px solid var(--control);border-radius:6px;background:var(--surface);padding:10px 32px 10px 12px;color:var(--text);font:inherit}.field select:disabled{background:var(--raised);color:var(--muted)}.greeting-preview{border-top:1px solid var(--border);padding-top:16px;margin-bottom:20px}.greeting-preview p{margin:8px 0 0;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.primary.secondary{background:var(--surface);color:var(--text);border-color:var(--control)}.primary.secondary:hover:not(:disabled){background:var(--raised)}.agent-row .field:first-child .field-hint{margin-bottom:0}
	.preview{border-top:1px solid var(--border);padding-top:20px;margin-top:24px;max-width:276px}.preview-label{font-size:12px;color:var(--muted)}.preview-offer{font-size:30px;line-height:1.2;font-weight:400;letter-spacing:-.6px;margin:12px 0;color:var(--accent);font-variant-numeric:tabular-nums}.preview-offer span{font-size:14px;color:var(--text);letter-spacing:0;margin-left:6px}.preview-code{font-size:14px;overflow-wrap:anywhere;margin:0 0 6px;font-weight:500}.preview-terms{font-size:13px;color:var(--muted);margin:0;font-variant-numeric:tabular-nums}
	fieldset{margin:0;padding:0;border:0;min-width:0}.field{min-width:0;margin-bottom:20px}.field label{display:block;margin-bottom:8px;font-size:13px;font-weight:500}.field input{width:100%;min-width:0;min-height:42px;border:1px solid var(--control);border-radius:6px;background:var(--surface);padding:10px 12px;color:var(--text);font:inherit;font-variant-numeric:tabular-nums}.field input:disabled{background:var(--raised);color:var(--muted)}.code-input{text-transform:uppercase}.field-hint{font-size:12px;color:var(--muted);margin:6px 0 0;line-height:1.5}.field-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.form-footer{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--border);padding-top:20px}.form-footer p{font-size:12px;color:var(--muted);margin:0;max-width:180px}.primary{min-height:44px;background:var(--text);color:var(--surface);padding:10px 16px;border:1px solid var(--text);border-radius:6px;cursor:pointer;font:inherit;font-size:13px;white-space:nowrap}.primary:hover:not(:disabled){background:#303d34}.primary:disabled{cursor:default;background:#e5eae5;color:#525f55;border-color:var(--control)}.form-message{padding-top:16px;margin:16px 0 0;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}.form-message p{margin:0 0 8px}.form-message.success{color:var(--accent)}.form-message a,.notice a{color:var(--text);text-underline-offset:3px}
	.catalogue{padding:0 28px}.catalogue-empty{padding:28px 0}.catalogue h3{margin:0;font-size:14px;font-weight:500}.catalogue-empty p{color:var(--muted);font-size:13px;margin:8px 0 0;line-height:1.6}.discount-row{padding:20px 0}.discount-row+.discount-row{border-top:1px solid var(--border)}.discount-title,.discount-details{display:flex;justify-content:space-between;align-items:baseline;gap:16px}.discount-title h3{overflow-wrap:anywhere;min-width:0}.status{font-size:11px;color:var(--muted);white-space:nowrap;flex:none}.status.confirmed{color:var(--accent)}.discount-details{margin-top:12px}.discount-details p{font-size:13px;margin:0;font-variant-numeric:tabular-nums}.discount-code{font-weight:500;overflow-wrap:anywhere;min-width:0}.discount-details p:last-child{text-align:right;flex:none}.discount-meta{font-size:12px;color:var(--muted);margin:8px 0 0;font-variant-numeric:tabular-nums}.notice,.empty{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px}.notice p,.empty p{margin:0 0 8px;color:var(--muted)}.empty p{max-width:550px}
	a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
	@media(max-width:900px){.agent-row .field-pair:first-child{grid-template-columns:1fr;gap:0}.settings-row{grid-template-columns:minmax(0,240px) minmax(0,1fr);gap:28px}.settings-panel{padding:24px}.catalogue{padding:0 24px}.form-footer{align-items:flex-start;flex-direction:column;gap:12px}.form-footer p{max-width:none}}
	@media(max-width:640px){.settings-row{grid-template-columns:1fr;gap:24px;padding-bottom:28px}.settings-row+.settings-row{padding-top:28px}.section-copy>p{max-width:none}.preview{max-width:none;margin-top:20px;padding-top:16px}.preview-offer{font-size:28px}.preview-terms{margin-bottom:0}.settings-panel{padding:20px}.catalogue{padding:0 20px}.field-pair{gap:16px}.identity-fields{grid-template-columns:1fr}.page-title{margin-bottom:28px}.discount-title{flex-direction:column;gap:4px}.discount-details{gap:12px}.form-footer{align-items:stretch}.primary{width:100%}.scope-row{flex-direction:column;gap:4px}.field label{font-size:13px}}
</style>
