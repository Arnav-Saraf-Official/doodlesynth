<script lang="ts">
	export interface Segment {
		value: string;
		label: string;
		title?: string;
		disabled?: boolean;
	}

	interface Props {
		value: string;
		segments: Segment[];
		ariaLabel: string;
		size?: 'sm' | 'md';
		onchange?: (value: string) => void;
	}

	let { value = $bindable(), segments, ariaLabel, size = 'md', onchange }: Props = $props();

	function select(next: string) {
		if (next === value) return;
		value = next;
		onchange?.(next);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		const enabled = segments.filter((segment) => !segment.disabled);
		const index = enabled.findIndex((segment) => segment.value === value);
		const direction = event.key === 'ArrowRight' ? 1 : -1;
		const next = enabled[(index + direction + enabled.length) % enabled.length];
		if (next) select(next.value);
	}
</script>

<div
	class="segmented"
	class:is-sm={size === 'sm'}
	role="radiogroup"
	tabindex="0"
	aria-label={ariaLabel}
	onkeydown={onKeydown}
>
	{#each segments as segment (segment.value)}
		<button
			type="button"
			class="segment"
			class:is-active={segment.value === value}
			role="radio"
			aria-checked={segment.value === value}
			disabled={segment.disabled}
			title={segment.title ?? segment.label}
			tabindex={segment.value === value ? 0 : -1}
			onclick={() => select(segment.value)}
		>
			{segment.label}
		</button>
	{/each}
</div>

<style>
	.segmented {
		display: inline-flex;
		padding: 2px;
		gap: 2px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		background: var(--color-bg-1);
	}

	.segment {
		border: none;
		background: transparent;
		color: var(--color-fg-2);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		height: 20px;
		padding: 0 var(--sp-3);
		border-radius: var(--r-1);
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out),
			transform 100ms var(--ease-out);
	}

	.is-sm .segment {
		height: 16px;
		padding: 0 var(--sp-2);
		font-size: 9px;
	}

	.segment:hover:not(:disabled):not(.is-active) {
		background: var(--color-bg-3);
		color: var(--color-fg-1);
	}

	.segment:active:not(:disabled) {
		transform: scale(0.97);
	}

	.segment.is-active {
		background: var(--color-bg-4);
		color: var(--color-fg-0);
	}

	.segment:disabled {
		opacity: 0.35;
		cursor: default;
	}
</style>
