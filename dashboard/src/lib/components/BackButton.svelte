<script lang="ts">
	export let fallback = '/';
	export let label = 'Zurück';

	function goBack(event: MouseEvent) {
		if (window.history.length <= 1) return;
		event.preventDefault();
		window.history.back();
	}
</script>

<a class="back-button" href={fallback} aria-label={label} title={label} onclick={goBack}>
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M15 5l-7 7 7 7M8 12h10" />
	</svg>
</a>

<style>
	.back-button {
		display: grid;
		width: 32px;
		height: 32px;
		flex: 0 0 32px;
		margin-right: 12px;
		place-items: center;
		border: 1px solid #e1e1e1;
		border-radius: 10px;
		background: #fff;
		color: #191919;
		text-decoration: none;
		transition: border-color 140ms ease, background-color 140ms ease;
	}

	.back-button:hover {
		border-color: #c8c8c8;
		background: #f6f6f6;
	}

	svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.8;
	}
</style>
