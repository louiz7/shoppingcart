<script lang="ts">
	import type { Snippet } from 'svelte';
	let { title, description, children }: { title: string; description: string; children: Snippet } = $props();
</script>

<main class="auth-frame" data-app>
	<div class="auth-column">
		<a class="auth-wordmark" href="/login" aria-label="Rescova Anmeldung"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.5 8.5A8 8 0 0 0 5 6.7M4.5 15.5A8 8 0 0 0 19 17.3M5 2.8v4.4h4.4M19 21.2v-4.4h-4.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>rescova<span>.</span></a>
		<section class="auth-panel"><h1>{title}</h1><p class="auth-description">{description}</p>{@render children()}</section>
		<p class="auth-signoff">Persönliche Gespräche. Zurück zum Warenkorb.<br /><a href="/terms">Nutzungsbedingungen</a></p>
	</div>
</main>

<style>
	.auth-frame{position:relative;isolation:isolate}
	.auth-frame::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;background:url('/images/graphite-ambient.jpg') center / 100% 100% no-repeat;opacity:.48}

	:global(html:has(.auth-frame)),:global(body:has(.auth-frame)){background:#090909}
	.auth-frame{--text:#f1f3f1;--muted:#a4aaa6;--border:#292929;--control:#454545;--accent:#b5e8c3;color-scheme:dark;background:#090909;color:var(--text);min-height:100svh;padding:64px 20px 40px;display:flex;justify-content:center;font-family:Inter,system-ui,sans-serif;font-size:14px;line-height:1.5}
	.auth-frame :global(*){box-sizing:border-box}.auth-column{width:min(100%,460px)}
	.auth-wordmark{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:600;letter-spacing:-.8px;color:var(--text);text-decoration:none;width:fit-content;margin:0 0 28px}.auth-wordmark svg{height:26px;width:26px;color:var(--accent)}.auth-wordmark span{color:var(--accent);margin-left:-9px}
	.auth-panel{background:#111;border:1px solid var(--border);border-radius:8px;padding:32px}h1{font-size:24px;letter-spacing:-.6px;line-height:1.3;font-weight:600;margin:0}.auth-description{margin:10px 0 28px;color:var(--muted);line-height:1.65}
	.auth-frame :global(form){margin:0}.auth-frame :global(.auth-field){display:flex;flex-direction:column;margin-bottom:20px;gap:8px}.auth-frame :global(label){font-size:13px;font-weight:500}.auth-frame :global(input){width:100%;height:44px;border:1px solid var(--control);border-radius:6px;padding:10px 12px;background:#1a1a1a;color:var(--text);font:inherit}.auth-frame :global(.auth-hint){font-size:12px;color:var(--muted);margin:0;line-height:1.5}.auth-frame :global(.auth-submit){min-height:44px;width:100%;margin-top:4px;background:var(--text);color:#111;border:1px solid var(--text);border-radius:6px;padding:10px 16px;font:inherit;font-size:13px;cursor:pointer}.auth-frame :global(.auth-submit:hover){background:#d9e1db}.auth-frame :global(.auth-error){font-size:13px;color:#ff8c93;border-left:2px solid #ff8c93;padding-left:12px;margin:0 0 20px;line-height:1.6}.auth-frame :global(.auth-link){border-top:1px solid var(--border);padding-top:20px;margin:24px 0 0;color:var(--muted);font-size:13px}.auth-frame :global(.auth-link a){color:var(--text);font-weight:500;text-underline-offset:3px}.auth-signoff a{display:inline-block;color:inherit;text-underline-offset:4px;padding-top:8px}.auth-signoff{font-size:12px;color:var(--muted);margin:20px 0 0}
	a:focus-visible,.auth-frame :global(input:focus-visible),.auth-frame :global(button:focus-visible),.auth-frame :global(.auth-link a:focus-visible){outline:2px solid var(--accent);outline-offset:3px}
	@media(max-width:480px){.auth-frame{padding-top:32px}.auth-panel{padding:24px}.auth-wordmark{margin-bottom:24px}.auth-description{margin-bottom:24px}}
</style>
