<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import RecoveryShell from '$lib/components/RecoveryShell.svelte';
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
	let pending = $state<string | null>(null);
	let refreshing = $state(false);
	const labels: Record<string, string> = { unresolved_question: 'Offene Produktfrage', shop_action_required: 'Shop muss prüfen', technical_failure: 'Technisches Problem', human_requested: 'Persönlicher Kontakt gewünscht' };
	const date = (value: string) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(value));
	async function refresh() { refreshing = true; try { await invalidateAll(); } finally { refreshing = false; } }
	onMount(() => {
		const timer = setInterval(() => { if (!document.hidden && !pending && !refreshing) void refresh(); }, 30000);
		return () => clearInterval(timer);
	});
</script>

<svelte:head><title>Tickets · Rescova</title></svelte:head>

<RecoveryShell active="tickets">
	<header class="heading">
		<div><p class="eyebrow">PERSÖNLICH ÜBERNEHMEN</p><h1>Tickets</h1><p class="intro">Ausnahmefälle aus Gesprächen, bei denen ein Mensch weiterhelfen muss.</p></div>
		<button class="refresh" onclick={refresh} disabled={refreshing}>{refreshing ? 'Lädt …' : 'Aktualisieren'}</button>
	</header>
	{#if data.loadError}<p class="error" role="alert">{data.loadError}</p>{/if}
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if data.result}
		{#if data.result.tickets.length === 0}
			<div class="empty"><span class="empty-mark" aria-hidden="true">✓</span><h2>Aktuell liegt nichts an.</h2><p>Wenn im Gespräch ein Anliegen offenbleibt, erscheint hier die kurze Zusammenfassung.</p></div>
		{:else}
			<p class="note">Rückrufe nur bei ausdrücklichem Wunsch. Tickets lösen keine automatische Kontaktaufnahme aus. Angezeigt werden bis zu 100 aktuelle Tickets.</p>
			<ul class="tickets">
				{#each data.result.tickets as ticket (ticket.id)}
					<li class:resolved={ticket.resolvedAt}>
						<div class="details">
							<div class="meta"><span>{ticket.brand}{data.result.internal ? ` · ${ticket.organization}` : ''}</span><time datetime={ticket.createdAt}>{date(ticket.createdAt)}</time>{#if ticket.isTest}<span>Testgespräch</span>{/if}</div>
							<h2>{labels[ticket.reason] || 'Offenes Anliegen'}</h2>
							<p class="summary">{ticket.summary}</p>
							<div class="followup">
								{#if ticket.contactBlocked}<span>Kontakt gesperrt · nur intern prüfen</span>
								{:else if ticket.callbackRequested}<span class="callback">Rückruf gewünscht</span>{#if ticket.phone}<a href={`tel:${ticket.phone}`}>{ticket.phone}</a>{/if}
								{:else}<span>Intern prüfen · kein Rückruf angefragt</span>{/if}
							</div>
						</div>
						{#if ticket.resolvedAt}<span class="done">Erledigt</span>
						{:else if data.result.canEdit}
							<form method="POST" action="?/resolve" use:enhance={() => { pending = ticket.id; return async ({ update }) => { try { await update(); } finally { pending = null; } }; }}>
								<input type="hidden" name="ticketId" value={ticket.id} /><button disabled={pending !== null}>{pending === ticket.id ? 'Speichert …' : 'Als erledigt markieren'}</button>
							</form>
						{:else}<span class="done">Offen</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</RecoveryShell>

<style>
	.heading{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:36px}.eyebrow{color:var(--muted);font-size:10px;letter-spacing:.12em;margin:0 0 12px}h1{font-size:30px;line-height:1.2;font-weight:500;letter-spacing:-.8px;margin:0 0 12px}.intro,.note{color:var(--muted);margin:0;max-width:65ch}.note{font-size:12px;margin-bottom:24px}
	button{font:inherit;font-size:12px;min-height:44px;padding:10px 16px;background:var(--raised);color:var(--text);border:1px solid var(--control);border-radius:8px;cursor:pointer;white-space:nowrap}button:hover{border-color:var(--muted)}button:disabled{opacity:.55;cursor:wait}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.refresh{background:transparent}
	.tickets{list-style:none;padding:0;margin:0}.tickets li{border-top:1px solid var(--border);padding:28px 0;display:flex;align-items:flex-start;justify-content:space-between;gap:32px}.details{min-width:0;flex:1}.meta{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:11px;color:var(--muted);margin-bottom:12px}.meta span{overflow-wrap:anywhere}h2{font-size:16px;line-height:1.4;font-weight:500;margin:0 0 8px}.summary{margin:0;max-width:75ch;overflow-wrap:anywhere}.followup{display:flex;gap:8px 16px;flex-wrap:wrap;margin-top:16px;color:var(--muted);font-size:12px}.followup a,.callback{color:var(--accent)}.done{color:var(--muted);font-size:12px;padding-top:12px}.resolved .summary{color:var(--muted)}.error{color:var(--negative);padding:16px 0}.empty{padding:64px 24px 80px;text-align:center}.empty-mark{display:inline-grid;place-items:center;width:40px;height:40px;border:1px solid var(--border);border-radius:50%;color:var(--accent);margin-bottom:20px}.empty p{color:var(--muted);max-width:45ch;margin:12px auto 0}
	@media(max-width:640px){.heading{align-items:flex-start;flex-direction:column;gap:20px;margin-bottom:28px}h1{font-size:26px}.tickets li{flex-direction:column;gap:20px;padding:24px 0}.empty{padding:36px 0 48px}.done{padding:0}}
</style>
