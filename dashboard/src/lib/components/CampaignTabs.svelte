<script lang="ts">
	export let filters: { id: string; label: string }[] = [];
	export let activeCampaign = 'all';
	export let basePath: string;
	export let query = '';

	function href(filterId: string): string {
		const parameters = new URLSearchParams();
		if (filterId !== 'all') parameters.set('campaign', filterId);
		if (query.trim()) parameters.set('q', query.trim());
		const search = parameters.toString();
		return search ? `${basePath}?${search}` : basePath;
	}
</script>

<nav class="campaign-tabs" aria-label="Nach Kampagne filtern">
	{#each filters as filter}
		<a
			class:active={filter.id === activeCampaign}
			href={href(filter.id)}
			aria-current={filter.id === activeCampaign ? 'page' : undefined}
		>
			{filter.label}
		</a>
	{/each}
</nav>

<style>
	.campaign-tabs {
		display: flex;
		width: 100%;
		gap: 8px;
		overflow-x: auto;
		padding: 2px 0 6px;
		scrollbar-width: thin;
	}

	.campaign-tabs a {
		display: inline-flex;
		min-height: 42px;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		padding: 9px 18px;
		border: 1px solid #dedede;
		border-radius: 999px;
		background: #fff;
		color: rgb(0 0 0 / 0.65);
		font-size: 15px;
		font-weight: 500;
		line-height: 1.2;
		text-decoration: none;
		transition:
			border-color 140ms ease,
			background-color 140ms ease,
			color 140ms ease;
	}

	.campaign-tabs a:hover {
		border-color: #ff4c00;
		color: #ff4c00;
	}

	.campaign-tabs a.active {
		border-color: #ff4c00;
		background: #fff1eb;
		color: #d94000;
	}
</style>
