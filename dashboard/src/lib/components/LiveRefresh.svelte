<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';

	export let intervalMs = 5000;

	onMount(() => {
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') void invalidateAll();
		}, intervalMs);
		return () => window.clearInterval(timer);
	});
</script>
