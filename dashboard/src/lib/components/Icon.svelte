<script lang="ts">
	export let name: string;
	export let size = 20;
	export let strokeWidth = 1.8;
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#if name === 'grid'}
		<rect x="3" y="3" width="7" height="7" rx="1" />
		<rect x="14" y="3" width="7" height="7" rx="1" />
		<rect x="3" y="14" width="7" height="7" rx="1" />
		<rect x="14" y="14" width="7" height="7" rx="1" />
	{:else if name === 'receipt'}
		<path d="M5 3.5h14v17l-3-1.8-4 1.8-4-1.8-3 1.8v-17Z" />
		<path d="M8 8h8M8 12h8M8 16h4" />
	{:else if name === 'phone'}
		<path d="M5.5 3.9 8.7 3l1.8 4.4-2.1 1.8c1.2 2.4 2.9 4.1 5.3 5.3l1.8-2.1 4.4 1.8-.9 3.2c-.2.7-.9 1.2-1.7 1.1C10 17.8 6.2 14 5.4 6.7c-.1-.8.4-1.5 1.1-1.8Z" />
	{:else if name === 'users'}
		<path d="M16 20v-1.7c0-1.8-1.7-3.3-3.9-3.3H7.9C5.7 15 4 16.5 4 18.3V20" />
		<circle cx="10" cy="8" r="3" />
		<path d="M16.2 5.1a3 3 0 0 1 0 5.8M20 20v-1.6c0-1.5-1.1-2.8-2.7-3.2" />
	{:else if name === 'chart'}
		<path d="M4 19V5M4 19h16" />
		<path d="m7 15 4-4 3 2 5-6" />
	{:else if name === 'settings'}
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.2 2.2-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3.2v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L6.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H5v-3.2h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.2-2.2.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V4h3.2v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.2 2.2-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2V14h-.2a1.7 1.7 0 0 0-1.5 1Z" />
	{:else if name === 'folder'}
		<path d="M3.5 6.5h6l1.8 2H20.5v10.2c0 1-.8 1.8-1.8 1.8H5.3c-1 0-1.8-.8-1.8-1.8V6.5Z" />
		<path d="M3.5 9h17" />
	{:else if name === 'sparkle'}
		<path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3Z" />
		<path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15ZM5 15l.5 1.5L7 17l-1.5.5L5 19l-.5-1.5L3 17l1.5-.5L5 15Z" />
	{:else if name === 'chevron-down'}
		<path d="m7 10 5 5 5-5" />
	{:else if name === 'chevron-right'}
		<path d="m9 18 6-6-6-6" />
	{:else if name === 'bell'}
		<path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'arrow-up'}
		<path d="m18 15-6-6-6 6" />
		<path d="M12 9v11" />
	{:else if name === 'arrow-down'}
		<path d="m6 9 6 6 6-6" />
		<path d="M12 15V4" />
	{:else if name === 'more'}
		<circle cx="5" cy="12" r=".8" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r=".8" fill="currentColor" stroke="none" />
		<circle cx="19" cy="12" r=".8" fill="currentColor" stroke="none" />
	{:else if name === 'clock'}
		<circle cx="12" cy="12" r="8.5" />
		<path d="M12 7v5l3.5 2" />
	{:else if name === 'alert'}
		<path d="M10.4 4.1 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.6 4.1a1.8 1.8 0 0 0-3.2 0Z" />
		<path d="M12 9v4M12 16.5v.1" />
	{:else if name === 'search'}
		<circle cx="10.8" cy="10.8" r="6.3" />
		<path d="m16 16 4 4" />
	{:else if name === 'close'}
		<path d="m6 6 12 12M18 6 6 18" />
	{:else if name === 'calendar'}
		<rect x="3.5" y="5.5" width="17" height="15" rx="2" />
		<path d="M7.5 3.5v4M16.5 3.5v4M3.5 10h17" />
	{:else if name === 'check'}
		<path d="m5 12 4.2 4.2L19 6.8" />
	{/if}
</svg>
