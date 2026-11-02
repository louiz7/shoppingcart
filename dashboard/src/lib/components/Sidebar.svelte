<script lang="ts">
	import { page } from '$app/state';

	type NavigationItem = {
		label: string;
		icon: string;
		href?: string;
		requiresEmailAutomation?: boolean;
	};

	type Props = {
		navigation: NavigationItem[];
		campaignNavigation: NavigationItem[];
		activeItem: string;
		onItemSelect?: (label: string) => void;
	};

	let {
		navigation,
		campaignNavigation,
		activeItem,
		onItemSelect
	}: Props = $props();

	function isDisabled(item: NavigationItem): boolean {
		return Boolean(item.requiresEmailAutomation &&
			(!page.data.user?.emailAutomationEnabled || page.data.user?.role !== 'admin'));
	}
</script>

<aside class="sidebar" aria-label="Hauptnavigation">
	<img class="brand" src="/figma/logo.svg" alt="Rescova" width="240" height="57" />

	<nav class="navigation">
		<a class="navigation-item type-text" href="/recovery"><span class="nav-icon" aria-hidden="true">◫</span><span>Cart Recovery</span></a>
		<div class="navigation-group">
			{#each navigation as item}
				{#if isDisabled(item)}
					<span
						class="navigation-item disabled type-text"
						aria-disabled="true"
						title="Als Zusatzservice verfügbar"
					>
						<img class="nav-icon" src={item.icon} alt="" width="19" height="19" />
						<span>{item.label}</span>
						<span class="addon-label">Add-on</span>
					</span>
				{:else if item.href}
					<a
						class:active={activeItem === item.label}
						class="navigation-item type-text"
						href={item.href}
						aria-current={activeItem === item.label ? 'page' : undefined}
					>
						<img class="nav-icon" src={item.icon} alt="" width="19" height="19" />
						<span>{item.label}</span>
					</a>
				{:else}
					<button
						class:active={activeItem === item.label}
						class="navigation-item type-text"
						type="button"
						aria-pressed={activeItem === item.label}
						onclick={() => onItemSelect?.(item.label)}
					>
						<img class="nav-icon" src={item.icon} alt="" width="19" height="19" />
						<span>{item.label}</span>
					</button>
				{/if}
			{/each}
		</div>

		{#if campaignNavigation.length > 0}
			<div class="navigation-group">
				{#each campaignNavigation as item}
					{#if item.href}
						<a
							class:active={activeItem === item.label}
							class="navigation-item type-text"
							href={item.href}
							aria-current={activeItem === item.label ? 'page' : undefined}
						>
							<img class="nav-icon" src={item.icon} alt="" width="19" height="19" />
							<span>{item.label}</span>
						</a>
					{:else}
						<button
							class:active={activeItem === item.label}
							class="navigation-item type-text"
							type="button"
							aria-pressed={activeItem === item.label}
							onclick={() => onItemSelect?.(item.label)}
						>
							<img class="nav-icon" src={item.icon} alt="" width="19" height="19" />
							<span>{item.label}</span>
						</button>
					{/if}
				{/each}
			</div>
		{/if}
	</nav>

	{#if page.data.user?.role === 'admin'}
		<div class="admin-navigation">
			{#if page.data.user.isRescovaAdminOrganization}
				<a
					class:active={activeItem === 'Organisationen'}
					class="navigation-item type-text"
					href="/admin/organisationen"
					aria-current={activeItem === 'Organisationen' ? 'page' : undefined}
				>
					<img class="nav-icon" src="/figma/icon_overview.svg" alt="" width="19" height="19" />
					<span>Organisationen</span>
				</a>
			{/if}
			<a
				class:active={activeItem === 'Einstellungen'}
				class="navigation-item type-text"
				href="/admin/benutzer"
				aria-current={activeItem === 'Einstellungen' ? 'page' : undefined}
			>
				<img class="nav-icon" src="/figma/icon_users.svg" alt="" width="19" height="19" />
				<span>Einstellungen</span>
			</a>
		</div>
	{/if}

	<form method="POST" action="/logout" class="logout-form">
		<button type="submit" class="logout-button type-text">Abmelden</button>
	</form>
</aside>

<style>
	.sidebar {
		position: fixed;
		z-index: 10;
		inset: 0 auto 0 0;
		display: flex;
		width: 240px;
		overflow-y: auto;
		flex-direction: column;
		gap: 24px;
		padding: 0 16px;
		border-right: 1px solid #ebebeb;
		background: #fff;
	}

	.brand {
		display: block;
		width: 240px;
		height: 57px;
		flex: 0 0 auto;
		margin: 0 -16px;
	}

	.navigation,
	.navigation-group {
		display: flex;
		flex-direction: column;
	}

	.navigation {
		gap: 24px;
	}

	.navigation-group {
		gap: 8px;
	}

	.navigation-item {
		display: flex;
		width: 100%;
		height: 35px;
		align-items: center;
		gap: 8px;
		padding: 8px 16px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: #000;
		text-align: left;
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	button.navigation-item {
		cursor: pointer;
	}

	.navigation-item:hover,
	.navigation-item.active {
		background: #F0F0F0;
	}

	.navigation-item.disabled {
		color: rgb(0 0 0 / 0.35);
		cursor: not-allowed;
	}

	.navigation-item.disabled .nav-icon {
		opacity: 0.35;
	}

	.navigation-item.disabled:hover {
		background: transparent;
	}

	.addon-label {
		margin-left: auto;
		padding: 2px 5px;
		border-radius: 5px;
		background: #f2f2f2;
		font-size: 10px;
		line-height: 1.2;
	}

	.logout-form {
		padding-bottom: 16px;
	}

	.admin-navigation {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: auto;
	}

	.logout-button {
		width: 100%;
		height: 35px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: rgb(0 0 0 / 0.65);
		cursor: pointer;
	}

	.logout-button:hover {
		background: #f0f0f0;
	}

	.nav-icon {
		display: block;
		width: 19px;
		height: 19px;
		flex: 0 0 19px;
		object-fit: contain;
	}

	@media (max-width: 780px) {
		.sidebar {
			display: none;
		}
	}
</style>
