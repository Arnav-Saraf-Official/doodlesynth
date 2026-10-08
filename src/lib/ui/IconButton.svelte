<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		active?: boolean;
		disabled?: boolean;
		variant?: 'ghost' | 'solid' | 'danger';
		size?: 'sm' | 'md';
		title?: string;
		onclick?: (event: MouseEvent) => void;
		children: Snippet;
	}

	let {
		label,
		active = false,
		disabled = false,
		variant = 'ghost',
		size = 'md',
		title,
		onclick,
		children
	}: Props = $props();

	const classes = $derived(
		[
			'icon-button',
			`is-${variant}`,
			`is-${size}`,
			active ? 'is-active' : '',
			disabled ? 'is-disabled' : ''
		]
			.filter(Boolean)
			.join(' ')
	);
</script>

<button
	type="button"
	class={classes}
	aria-label={label}
	aria-pressed={active}
	title={title ?? label}
	{disabled}
	onclick={(event) => onclick?.(event)}
>
	{@render children()}
</button>

<style>
	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sp-2);
		height: var(--h-control);
		min-width: var(--h-control);
		padding: 0 var(--sp-3);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		background: var(--color-bg-2);
		color: var(--color-fg-1);
		font-size: 12px;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			border-color 120ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.icon-button.is-sm {
		height: 22px;
		min-width: 22px;
		padding: 0 var(--sp-2);
	}

	.icon-button:hover:not(.is-disabled) {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
		border-color: var(--color-line-1);
	}

	/* feedback lands on press, not on release */
	.icon-button:active:not(.is-disabled) {
		transform: scale(0.97);
		background: var(--color-bg-4);
	}

	.icon-button.is-active {
		background: color-mix(in oklab, var(--color-accent) 22%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-accent) 55%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.icon-button.is-solid {
		background: color-mix(in oklab, var(--color-accent) 26%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-accent) 45%, var(--color-line-0));
		color: var(--color-fg-0);
	}

	.icon-button.is-danger {
		color: var(--color-danger);
	}

	.icon-button.is-danger:hover:not(.is-disabled) {
		background: color-mix(in oklab, var(--color-danger) 16%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-danger) 40%, var(--color-line-1));
	}

	.icon-button.is-disabled {
		opacity: 0.4;
		cursor: default;
	}

	@media (hover: none) {
		.icon-button:hover:not(.is-disabled) {
			background: var(--color-bg-2);
			color: var(--color-fg-1);
		}
	}
</style>
