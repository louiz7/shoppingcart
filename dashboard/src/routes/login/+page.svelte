<script lang="ts">
	import RecoveryAuthFrame from '$lib/components/RecoveryAuthFrame.svelte';
	import type { PageProps } from './$types';
	let { form }: PageProps = $props();
</script>

<svelte:head><title>Anmelden · Rescova</title><meta name="description" content="Melde dich bei deiner Rescova-Organisation an." /></svelte:head>

<RecoveryAuthFrame title="Anmelden" description="Deine Organisation. Deine Shops. Dein Überblick.">
	<form method="POST">
		<div class="auth-field"><label for="email">E-Mail</label><input id="email" name="email" type="email" autocomplete="username" maxlength="254" value={form?.email ?? ''} required /></div>
		<div class="auth-field"><label for="password">Passwort</label><input id="password" name="password" type="password" autocomplete="current-password" required /></div>
		{#if form?.error}<p class="auth-error" role="alert">{form.error}</p>{/if}
		<button class="auth-submit" type="submit">Anmelden</button>
	</form>
	<p class="auth-link">Noch kein Konto? <a href="/register">Organisation anlegen</a></p>
</RecoveryAuthFrame>
