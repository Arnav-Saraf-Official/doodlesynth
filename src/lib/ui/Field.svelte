<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		hint?: string;
		/** stack the control under the label instead of beside it */
		stacked?: boolean;
		children: Snippet;
	}

	let { label, hint, stacked = false, children }: Props = $props();
</script>

<div class="field" class:is-stacked={stacked}>
	<span class="field-label" title={hint ?? label}>{label}</span>
	<div class="field-control">{@render children()}</div>
</div>

<style>
	.field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		min-height: var(--h-row);
	}

	.is-stacked {
		display: block;
	}

	.field-label {
		font-size: 11px;
		color: var(--color-fg-2);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.field-control {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}

	.is-stacked .field-control {
		margin-top: 3px;
	}
</style>
