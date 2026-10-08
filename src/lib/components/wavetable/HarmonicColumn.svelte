<script lang="ts">
	/**
	 * One harmonic column.
	 *
	 * The control order is fixed and must not be rearranged: harmonic number,
	 * amplitude strip, phase knob, waveform selector, and the ratio label at
	 * the very bottom of the column.
	 */
	import { clamp } from '#lib/model/pitch';
	import type { HarmonicComponent, HarmonicWaveform } from '#lib/model/types';
	import Knob from '#lib/ui/Knob.svelte';

	interface Props {
		component: HarmonicComponent;
		selected: boolean;
		width: number;
		height: number;
		accent: string;
		onchange: (component: HarmonicComponent) => void;
		onselect: () => void;
	}

	let { component, selected, width, height, accent, onchange, onselect }: Props = $props();

	let strip = $state<HTMLElement | null>(null);
	let dragging = $state(false);
	let startY = 0;
	let startAmplitude = 0;
	let hovering = $state(false);

	const WAVEFORM_ORDER: HarmonicWaveform[] = ['sine', 'saw', 'square', 'triangle'];
	const WAVEFORM_SHORT: Record<HarmonicWaveform, string> = {
		sine: 'SIN',
		saw: 'SAW',
		square: 'SQR',
		triangle: 'TRI'
	};
	const WAVEFORM_LONG: Record<HarmonicWaveform, string> = {
		sine: 'Sine',
		saw: 'Saw',
		square: 'Square',
		triangle: 'Triangle'
	};

	const degrees = $derived((component.phaseRadians * 180) / Math.PI);
	const ratio = $derived(`${component.harmonic}/1`);
	const amplitudePercent = $derived(`${Math.round(component.amplitude * 100)}%`);

	function update(patch: Partial<HarmonicComponent>) {
		onchange({ ...component, ...patch });
	}

	function commitAmplitude(next: number) {
		update({ amplitude: clamp(next, 0, 1) });
	}

	function onStripPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		onselect();
		// double-click resets, matching the knob and every other precision control
		if (event.detail === 2) {
			commitAmplitude(0);
			return;
		}
		dragging = true;
		startY = event.clientY;
		startAmplitude = component.amplitude;
		strip?.setPointerCapture(event.pointerId);
	}

	function onStripPointerMove(event: PointerEvent) {
		if (!dragging || !strip) return;
		const travel = Math.max(strip.clientHeight, 40);
		const fine = event.shiftKey ? 0.1 : 1;
		const delta = ((startY - event.clientY) / travel) * fine;
		commitAmplitude(startAmplitude + delta);
	}

	function onStripPointerUp(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		strip?.releasePointerCapture(event.pointerId);
	}

	function cycleWaveform(direction: number) {
		const index = WAVEFORM_ORDER.indexOf(component.waveform);
		const next =
			WAVEFORM_ORDER[(index + direction + WAVEFORM_ORDER.length) % WAVEFORM_ORDER.length];
		update({ waveform: next });
	}

	function onWaveformKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
			event.preventDefault();
			cycleWaveform(1);
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
			event.preventDefault();
			cycleWaveform(-1);
		}
	}

	function toggleEnabled() {
		onselect();
		update({ enabled: !component.enabled });
	}
</script>

<div
	class="column"
	class:is-selected={selected}
	class:is-disabled={!component.enabled}
	style="--col-width: {width}px; --col-height: {height}px; --accent: {accent}"
	onpointerdown={() => onselect()}
	role="group"
	aria-label="Harmonic {component.harmonic}"
>
	<button
		type="button"
		class="harmonic-label num"
		aria-pressed={component.enabled}
		title="H{component.harmonic} — {component.enabled
			? 'enabled'
			: 'disabled'}. Activate to toggle."
		onclick={toggleEnabled}
	>
		H{component.harmonic}
	</button>

	<div
		class="amplitude-strip"
		bind:this={strip}
		role="slider"
		tabindex="0"
		aria-label="Harmonic {component.harmonic} amplitude"
		aria-valuemin={0}
		aria-valuemax={1}
		aria-valuenow={component.amplitude}
		aria-valuetext={`${Math.round(component.amplitude * 100)} percent`}
		title="H{component.harmonic} amplitude — drag, Shift for fine, double-click to reset"
		onpointerdown={onStripPointerDown}
		onpointermove={onStripPointerMove}
		onpointerup={onStripPointerUp}
		onpointercancel={onStripPointerUp}
		onpointerenter={() => (hovering = true)}
		onpointerleave={() => (hovering = false)}
		onkeydown={(event) => {
			if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
			event.preventDefault();
			const step = event.shiftKey ? 0.01 : 0.05;
			commitAmplitude(component.amplitude + (event.key === 'ArrowUp' ? step : -step));
		}}
	>
		<div class="amplitude-fill" style="height: {component.amplitude * 100}%"></div>
		<div class="amplitude-tick" style="bottom: {component.amplitude * 100}%"></div>
		{#if hovering || selected}
			<span class="amplitude-readout num">{amplitudePercent}</span>
		{/if}
	</div>

	<span class="amplitude-value num">{amplitudePercent}</span>

	<Knob
		value={degrees}
		min={0}
		max={360}
		step={1}
		defaultValue={0}
		arc={0.375}
		size={26}
		ariaLabel="Harmonic {component.harmonic} phase"
		format={(value) => `${Math.round(value)}°`}
		onchange={(value) => update({ phaseRadians: (value * Math.PI) / 180 })}
	/>

	<button
		type="button"
		class="waveform"
		aria-label="Harmonic {component.harmonic} waveform: {WAVEFORM_LONG[
			component.waveform
		]}. Activate to cycle through sine, saw, square and triangle."
		title="H{component.harmonic} waveform — {WAVEFORM_LONG[
			component.waveform
		]} (click to cycle, Shift+click to reverse)"
		onclick={(event) => cycleWaveform(event.shiftKey ? -1 : 1)}
		onkeydown={onWaveformKeydown}
	>
		<span class="waveform-tag num">{WAVEFORM_SHORT[component.waveform]}</span>
		<span class="waveform-dots" aria-hidden="true">
			{#each WAVEFORM_ORDER as waveform (waveform)}
				<i class:is-on={waveform === component.waveform}></i>
			{/each}
		</span>
	</button>

	<span class="ratio num" title="Harmonic ratio">{ratio}</span>
</div>

<style>
	.column {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		width: var(--col-width);
		height: var(--col-height);
		padding: 4px 3px 3px;
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: transparent;
		transition:
			background-color 140ms var(--ease-out),
			border-color 140ms var(--ease-out);
	}

	/* selection is never colour alone: border, inset ring and the numeric readout */
	.column.is-selected {
		border-color: color-mix(in oklab, var(--accent) 60%, var(--color-line-1));
		background: color-mix(in oklab, var(--accent) 10%, var(--color-bg-1));
	}

	.column.is-disabled {
		opacity: 0.45;
	}

	.harmonic-label {
		width: 100%;
		height: 15px;
		padding: 0;
		border: none;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-1);
		font-size: 9.5px;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out);
	}

	.harmonic-label:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.harmonic-label[aria-pressed='true'] {
		color: var(--color-fg-0);
	}

	.amplitude-strip {
		position: relative;
		flex: 1 1 auto;
		width: 14px;
		min-height: 34px;
		border: 1px solid var(--color-line-0);
		border-radius: 2px;
		background: var(--color-ed-0);
		cursor: ns-resize;
		overflow: hidden;
		touch-action: none;
	}

	.amplitude-strip:hover {
		border-color: var(--color-line-1);
	}

	.amplitude-fill {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		background: color-mix(in oklab, var(--accent) 55%, transparent);
		pointer-events: none;
	}

	.amplitude-tick {
		position: absolute;
		left: 0;
		right: 0;
		height: 1px;
		background: var(--color-fg-0);
		pointer-events: none;
	}

	.amplitude-readout {
		position: absolute;
		top: 1px;
		left: 50%;
		transform: translateX(-50%);
		font-size: 8.5px;
		color: var(--color-fg-0);
		background: color-mix(in oklab, var(--color-bg-0) 80%, transparent);
		padding: 0 1px;
		pointer-events: none;
	}

	.amplitude-value {
		font-size: 9px;
		color: var(--color-fg-2);
	}

	.waveform {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		width: 100%;
		height: 17px;
		padding: 0;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-1);
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			border-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			transform 100ms var(--ease-out);
	}

	.waveform:hover {
		background: var(--color-bg-3);
		border-color: var(--color-line-1);
		color: var(--color-fg-0);
	}

	.waveform:active {
		transform: scale(0.97);
	}

	.waveform-tag {
		font-size: 8.5px;
		letter-spacing: 0.02em;
	}

	.waveform-dots {
		display: flex;
		gap: 1.5px;
	}

	.waveform-dots i {
		width: 2px;
		height: 2px;
		border-radius: 50%;
		background: var(--color-fg-3);
	}

	.waveform-dots i.is-on {
		background: var(--accent);
	}

	.ratio {
		width: 100%;
		text-align: center;
		font-size: 9px;
		color: var(--color-fg-2);
		border-top: 1px solid var(--color-line-0);
		padding-top: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.column,
		.harmonic-label,
		.waveform {
			transition: none;
		}
	}
</style>
