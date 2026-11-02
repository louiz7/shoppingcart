<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	let { active, children }: { active: 'overview' | 'settings' | 'organizations'; children: Snippet } = $props();
	const organizationName = $derived(page.data.user?.organizationName);
	const internal = $derived(page.data.user?.isRecoveryInternal === true && page.data.user?.role === 'admin');
</script>

<div class="recovery-shell" data-app>
	<header class="app-header">
		<div class="header-inner">
			<div class="brand-block"><a href="/recovery" class="wordmark" aria-label="Rescova Tagesüberblick">
				<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.5 8.5A8 8 0 0 0 5 6.7M4.5 15.5A8 8 0 0 0 19 17.3M5 2.8v4.4h4.4M19 21.2v-4.4h-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>
				rescova<span>.</span>
			</a>{#if organizationName}<span class="organization-name" title={organizationName}>{organizationName}</span>{/if}</div>
			<nav aria-label="Hauptnavigation">
				<a href="/recovery" aria-current={active === 'overview' ? 'page' : undefined}>Übersicht</a>
				<a href="/recovery/settings" aria-current={active === 'settings' ? 'page' : undefined}>Einstellungen</a>
				{#if internal}<a href="/recovery/organizations" aria-current={active === 'organizations' ? 'page' : undefined}>Organisationen</a>{/if}
			</nav>
			<form method="POST" action="/logout"><button class="logout">Abmelden</button></form>
		</div>
	</header>
	<main class="app-main">{@render children()}</main>
	<footer><span>Persönliche Gespräche. Zurück zum Warenkorb.</span><a href="mailto:support@rescova.de">Support kontaktieren <span aria-hidden="true">↗</span></a></footer>
</div>

<style>
	:global(html:has(.recovery-shell)),:global(body:has(.recovery-shell)){background:#090909}
	.recovery-shell{--ground:#090909;--surface:#111;--raised:#1a1a1a;--text:#f1f3f1;--muted:#a4aaa6;--border:#292929;--control:#454545;--accent:#b5e8c3;--negative:#ff8c93;color-scheme:dark;min-height:100svh;background:var(--ground);color:var(--text);font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.5;display:flex;flex-direction:column}
	.recovery-shell :global(*){box-sizing:border-box}
	.header-inner,.app-main,footer{width:min(1184px,calc(100% - 48px));margin-inline:auto}
	.header-inner{min-height:88px;display:flex;align-items:center;gap:56px;padding-inline:32px}
	.wordmark{display:inline-flex;align-items:center;gap:9px;text-decoration:none;color:var(--text);font-size:23px;font-weight:600;letter-spacing:-.8px;flex:none}
	.wordmark svg{width:23px;height:23px;margin-right:2px;color:var(--accent)}.wordmark span{margin-left:-8px;color:var(--accent)}
	.brand-block{display:flex;flex-direction:column;justify-content:center;gap:2px;padding-block:12px;min-width:0;flex:none}.organization-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}
	nav{display:flex;align-self:stretch;gap:28px}nav a{display:flex;align-items:center;position:relative;min-height:44px;color:var(--muted);text-decoration:none;font-size:13px}nav a[aria-current='page']{color:var(--text);font-weight:500}nav a[aria-current='page']::after{content:'';height:2px;background:var(--text);position:absolute;inset:auto 0 12px}nav a:hover{color:var(--text)}
	.header-inner form{margin-left:auto}.logout{min-height:44px;border:0;background:none;color:var(--muted);padding:8px 0 8px 16px;font:inherit;font-size:13px;cursor:pointer}.logout:hover{color:var(--text)}
	.app-main{padding:32px;background:var(--surface);border:1px solid transparent;border-radius:16px}footer{padding:24px 32px 32px;font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:16px}footer a{color:var(--muted);text-decoration:none}footer a:hover{color:var(--text);text-decoration:underline;text-underline-offset:4px}footer a span{margin-left:6px}
	a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
	@media(max-width:768px){.header-inner,.app-main,footer{width:calc(100% - 32px)}.header-inner{gap:32px;padding-inline:24px}.app-main{padding:24px}footer{padding-inline:24px}}
	@media(max-width:640px){.header-inner{min-height:0;display:grid;grid-template-columns:1fr auto;gap:0;padding-inline:4px}.brand-block{min-height:76px}.header-inner form{grid-column:2;grid-row:1}nav{grid-column:1/-1;grid-row:2;gap:24px;margin-bottom:16px}nav a{min-height:44px}.app-main{padding:20px}.organization-name{max-width:190px}footer{padding:20px 4px 28px;flex-direction:column;gap:4px}footer a{display:inline-flex;align-items:center;min-height:44px}}
</style>
