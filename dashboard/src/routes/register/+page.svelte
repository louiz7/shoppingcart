<script lang="ts">
	import RecoveryAuthFrame from '$lib/components/RecoveryAuthFrame.svelte';
	import type { PageProps } from './$types';
	let { form }: PageProps = $props();
</script>

<svelte:head><title>Organisation anlegen · Rescova</title><meta name="description" content="Erstelle deine Rescova-Organisation und verbinde deine Shopify-Shops." /></svelte:head>

<RecoveryAuthFrame title="Organisation anlegen" description="Ein gemeinsamer Zugang für deine Shopify-Shops.">
	<form method="POST">
		<div class="auth-field-pair">
		<div class="auth-field"><label for="organization">Organisation</label><input id="organization" name="organizationName" autocomplete="organization" minlength="2" maxlength="120" value={form?.organizationName ?? ''} required /></div>
		<div class="auth-field"><label for="owner">Dein Name</label><input id="owner" name="displayName" autocomplete="name" minlength="2" maxlength="120" value={form?.displayName ?? ''} required /></div>
		</div>
		<div class="auth-field"><label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" value={form?.email ?? ''} required /></div>
		<div class="auth-field"><label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" aria-describedby="password-hint" required /><p id="password-hint" class="auth-hint">12–128 Zeichen.</p></div>
		{#if form?.error}<p class="auth-error" role="alert">{form.error}</p>{/if}
		<button class="auth-submit" type="submit">Organisation anlegen</button>
	</form>
	<p class="auth-link">Du hast schon ein Konto? <a href="/login">Anmelden</a></p>
</RecoveryAuthFrame>

<style>
	.auth-field-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.auth-field-pair .auth-field{min-width:0}
	@media(max-width:480px){.auth-field-pair{grid-template-columns:1fr;gap:0}}
</style>
