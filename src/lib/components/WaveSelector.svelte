<script lang="ts">
	/**
	 * DAW-style instrument selector.
	 *
	 * Options are grouped (BASIC / NOISE / USER) and the current selection is
	 * previewed as one real waveform cycle, drawn from the same synthesis code
	 * the engine will use for wavetables.
	 */
	import { findWavetable, renderWavetableAt } from '#lib/model/wavetable';
	import type { WaveSource } from '#lib/model/types';
	import { session } from '#lib/state/session.svelte';
	import Select from '#lib/ui/Select.svelte';

	interface Props {
		value: WaveSource;
		wavetableId?: string;
		/** wavetable morph position, 0..1 */
		position?: number;
		accent?: string;
		onChange: (wave: WaveSource, wavetableId?: string) => void;
	}

	let {
		value,
		wavetableId,
		position = 0,
		accent = 'var(--color-accent)',
		onChange
	}: Props = $props();

	const PREVIEW_WIDTH = 92;
	const PREVIEW_HEIGHT = 38;
	const PREVIEW_SAMPLES = 160;

	let canvas: HTMLCanvasElement | undefined = $state();

	const userTables = $derived(session.project.wavetables);

	const options = $derived.by(() => [
		{ value: 'wave:sine', label: 'Sine', group: 'BASIC' },
		{ value: 'wave:triangle', label: 'Triangle', group: 'BASIC' },
		{ value: 'wave:saw', label: 'Saw', group: 'BASIC' },
		{ value: 'wave:square', label: 'Square', group: 'BASIC' },
		{ value: 'wave:pulse', label: 'Pulse', group: 'BASIC' },
		{ value: 'wave:white-noise', label: 'White', group: 'NOISE' },
		...userTables.map((table) => ({
			value: `table:${table.id}`,
			label: `${table.favorite ? '★ ' : ''}${table.name}`,
			group: 'USER'
		}))
	]);

	const selectedKey = $derived(
		value === 'wavetable' && wavetableId ? `table:${wavetableId}` : `wave:${value}`
	);

	const activeTable = $derived(
		value === 'wavetable' ? findWavetable(session.project.wavetables, wavetableId) : undefined
	);

	/** One deterministic cycle of the selected source, normalized to -1..1. */
	const cycle = $derived.by(() => {
		const out = new Float32Array(PREVIEW_SAMPLES);
		const table = activeTable;
		if (table) {
			const samples = renderWavetableAt(table, position);
			for (let index = 0; index < PREVIEW_SAMPLES; index++) {
				const at = Math.floor((index / PREVIEW_SAMPLES) * samples.length) % samples.length;
				out[index] = samples[at];
			}
			return out;
		}
		for (let index = 0; index < PREVIEW_SAMPLES; index++) {
			const t = index / PREVIEW_SAMPLES;
			switch (value) {
				case 'triangle':
					out[index] = 2 * Math.abs(2 * (t - Math.floor(t + 0.5))) - 1;
					break;
				case 'saw':
					out[index] = 2 * (t - Math.floor(t + 0.5));
					break;
				case 'square':
					out[index] = t < 0.5 ? 1 : -1;
					break;
				case 'pulse':
					out[index] = t < 0.3 ? 1 : -1;
					break;
				case 'white-noise': {
					// deterministic so the preview does not flicker between renders
					const seed = Math.sin(index * 12.9898) * 43758.5453;
					out[index] = (seed - Math.floor(seed)) * 2 - 1;
					break;
				}
				case 'sine':
				default:
					out[index] = Math.sin(t * Math.PI * 2);
					break;
			}
		}
		return out;
	});

	/**
	 * Canvas strokeStyle cannot resolve a CSS custom property, so a `var(...)`
	 * accent has to be resolved to a concrete colour before it is used.
	 */
	function resolveColor(element: HTMLElement, value: string): string {
		const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
		if (!match) return value;
		const resolved = getComputedStyle(element).getPropertyValue(match[1]).trim();
		return resolved || '#4da3ff';
	}

	$effect(() => {
		const element = canvas;
		if (!element) return;
		const data = cycle;
		const color = resolveColor(element, accent);
		const context = element.getContext('2d');
		if (!context) return;

		const dpr = window.devicePixelRatio || 1;
		element.width = Math.round(PREVIEW_WIDTH * dpr);
		element.height = Math.round(PREVIEW_HEIGHT * dpr);
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);

		const middle = PREVIEW_HEIGHT / 2;
		context.strokeStyle = 'rgba(255,255,255,0.10)';
		context.lineWidth = 1;
		context.beginPath();
		context.moveTo(0, middle);
		context.lineTo(PREVIEW_WIDTH, middle);
		context.stroke();

		context.strokeStyle = color;
		context.lineWidth = 1.4;
		context.lineJoin = 'round';
		context.beginPath();
		const amplitude = middle - 3;
		for (let index = 0; index < data.length; index++) {
			const x = (index / (data.length - 1)) * PREVIEW_WIDTH;
			const y = middle - clampUnit(data[index]) * amplitude;
			if (index === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		}
		context.stroke();
	});

	function clampUnit(value_: number): number {
		return value_ < -1 ? -1 : value_ > 1 ? 1 : value_;
	}

	function handleChange(next: string) {
		if (next.startsWith('table:')) {
			onChange('wavetable', next.slice('table:'.length));
			return;
		}
		onChange(next.slice('wave:'.length) as WaveSource, undefined);
	}
</script>

<div class="wave-selector">
	<Select value={selectedKey} {options} ariaLabel="Oscillator source" onchange={handleChange} />
	<div class="preview" style="color:{accent}">
		<canvas bind:this={canvas} style="width:{PREVIEW_WIDTH}px;height:{PREVIEW_HEIGHT}px"></canvas>
		<span class="preview-caption">
			{#if activeTable}
				{activeTable.frames.length} frame{activeTable.frames.length === 1 ? '' : 's'}
			{:else}
				built-in
			{/if}
		</span>
	</div>
</div>

<style>
	.wave-selector {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
	}

	.preview {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1px;
		flex: none;
	}

	canvas {
		display: block;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-ed-1);
	}

	.preview-caption {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-fg-3);
	}
</style>
