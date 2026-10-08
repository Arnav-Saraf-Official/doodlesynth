<script lang="ts">
	interface Props {
		value: number;
		min?: number;
		max?: number;
		step?: number;
		orientation?: 'horizontal' | 'vertical';
		ariaLabel: string;
		disabled?: boolean;
		length?: string;
		onchange?: (value: number) => void;
	}

	let {
		value = $bindable(),
		min = 0,
		max = 1,
		step = 0.01,
		orientation = 'horizontal',
		ariaLabel,
		disabled = false,
		length,
		onchange
	}: Props = $props();

	function onInput(event: Event) {
		value = Number((event.currentTarget as HTMLInputElement).value);
	}

	function onChange() {
		onchange?.(value);
	}
</script>

<input
	class="slider"
	class:is-vertical={orientation === 'vertical'}
	type="range"
	{min}
	{max}
	{step}
	{disabled}
	value={String(value)}
	aria-label={ariaLabel}
	aria-orientation={orientation}
	style={length ? `--slider-length: ${length}` : undefined}
	oninput={onInput}
	onchange={onChange}
/>

<style>
	.slider {
		--track: var(--color-line-1);
		--fill: var(--color-accent);
		appearance: none;
		background: transparent;
		width: var(--slider-length, 100%);
		height: 18px;
		cursor: pointer;
		margin: 0;
	}

	.slider::-webkit-slider-runnable-track {
		height: 3px;
		border-radius: 2px;
		background: var(--track);
	}
	.slider::-moz-range-track {
		height: 3px;
		border-radius: 2px;
		background: var(--track);
	}

	.slider::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4.5px;
		border-radius: 50%;
		background: var(--color-fg-0);
		border: 1px solid var(--color-bg-0);
		transition: transform 120ms var(--ease-out);
	}
	.slider::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border: 1px solid var(--color-bg-0);
		border-radius: 50%;
		background: var(--color-fg-0);
	}

	.slider:active::-webkit-slider-thumb {
		transform: scale(1.12);
	}

	.slider:disabled {
		opacity: 0.4;
		cursor: default;
	}

	/* Vertical sliders reuse the native range input through writing-mode so
	   keyboard and pointer behaviour stay native. */
	.is-vertical {
		writing-mode: vertical-lr;
		direction: rtl;
		width: 18px;
		height: var(--slider-length, 96px);
	}

	.is-vertical::-webkit-slider-runnable-track {
		width: 3px;
		height: 100%;
	}
	.is-vertical::-moz-range-track {
		width: 3px;
	}

	.is-vertical::-webkit-slider-thumb {
		margin-top: 0;
		margin-left: -4.5px;
	}
</style>
