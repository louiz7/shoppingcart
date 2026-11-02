<script lang="ts">
	import type { ActionData } from './$types';
	export let form: ActionData;
</script>

<svelte:head>
	<title>Anmelden · Rescova</title>
</svelte:head>

<main class="login-page">
	<form method="POST" class="login-card">
		<img src="/figma/logo.svg" alt="Rescova" width="240" height="57" />
		<h1>Plattform anmelden</h1>
		<label>
			<span>E-Mail</span>
			<input name="email" type="email" autocomplete="username" value={form?.email ?? ''} required />
		</label>
		<label>
			<span>Passwort</span>
			<input name="password" type="password" autocomplete="current-password" required />
		</label>
		{#if form?.error}<p class="error">{form.error}</p>{/if}
		<button type="submit">Anmelden</button>
	</form>
</main>

<style>
	.login-page { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #fbfbf9; }
	.login-card { width: min(100%, 420px); display: flex; flex-direction: column; gap: 20px; padding: 32px; border: 1px solid #ebebeb; border-radius: 24px; background: white; }
	.login-card img { margin: -10px auto 0; }
	h1 { margin: 0; font-size: 24px; }
	label { display: flex; flex-direction: column; gap: 8px; }
	input { height: 44px; padding: 0 14px; border: 1px solid #d8d8d8; border-radius: 10px; font: inherit; }
	button { height: 44px; border: 0; border-radius: 10px; background: #ff4c00; color: white; font: inherit; cursor: pointer; }
	.error { margin: 0; color: #a92500; }
</style>
