<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		open?: boolean;
		actions?: Snippet;
		children: Snippet;
	}

	let { title, open = $bindable(true), actions, children }: Props = $props();
</script>

<section class="panel" class:is-open={open}>
	<header>
		<button type="button" class="panel-toggle" aria-expanded={open} onclick={() => (open = !open)}>
			<svg class="chevron" viewBox="0 0 8 8" aria-hidden="true">
				<path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" />
			</svg>
			<span>{title}</span>
		</button>
		{#if actions}
			<div class="panel-actions">{@render actions()}</div>
		{/if}
	</header>
	{#if open}
		<div class="panel-body">{@render children()}</div>
	{/if}
</section>

<style>
	.panel {
		border-bottom: 1px solid var(--color-line-0);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		min-height: 26px;
		padding: 0 var(--sp-3) 0 var(--sp-2);
	}

	.panel-toggle {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg-2);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color 130ms var(--ease-out);
	}

	.panel-toggle:hover {
		color: var(--color-fg-0);
	}

	.chevron {
		width: 8px;
		height: 8px;
		color: var(--color-fg-3);
		transform: rotate(-90deg);
		transition: transform 170ms var(--ease-out);
	}

	.is-open .chevron {
		transform: rotate(0deg);
	}

	.panel-body {
		padding: 0 var(--sp-3) var(--sp-3);
	}

	.panel-actions {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}
</style>
