<script lang="ts">
	/**
	 * Harmonic Editor — a spectral control surface, not another waveform painter.
	 *
	 * Layout: a fixed left utility gutter (H1 is deliberately left-biased; there
	 * are no harmonic columns below it, so a centred layout would waste half the
	 * editing surface) beside a horizontally scrollable, zoomable grid of
	 * HarmonicColumn components. Off-screen columns are never rendered, so 128
	 * harmonics stay responsive.
	 */
	import { clamp } from '#lib/model/pitch';
	import type { HarmonicComponent, HarmonicWaveform } from '#lib/model/types';
	import { HARMONIC_COUNTS, maxHarmonic, renderHarmonics } from '#lib/model/wavetable';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Slider from '#lib/ui/Slider.svelte';
	import HarmonicColumn from './HarmonicColumn.svelte';

	interface Props {
		components: HarmonicComponent[];
		count: number;
		sampleLength: number;
		accent?: string;
		onchange: (components: HarmonicComponent[]) => void;
		oncountchange: (count: number) => void;
	}

	let {
		components,
		count,
		sampleLength,
		accent = 'var(--color-accent)',
		onchange,
		oncountchange
	}: Props = $props();

	type UtilityOperation =
		| 'clear-all'
		| 'normalize'
		| 'randomize-amplitudes'
		| 'randomize-phases'
		| 'reset-phases'
		| 'keep-odd'
		| 'keep-even'
		| 'spectral-tilt'
		| 'exponential-rolloff';

	const DESTRUCTIVE: UtilityOperation[] = ['clear-all', 'keep-odd', 'keep-even'];

	let colWidth = $state(54);
	let scrollLeft = $state(0);
	let viewportWidth = $state(0);
	let grid = $state<HTMLDivElement | null>(null);
	let selected = $state<number[]>([]);
	let armed = $state<UtilityOperation | null>(null);
	let clipboard = $state<HarmonicComponent[] | null>(null);
	let modifierDown = false;
	let disarmTimer: ReturnType<typeof setTimeout> | null = null;

	let waveformCanvas = $state<HTMLCanvasElement | null>(null);
	let waveWidth = $state(0);
	let waveHeight = $state(0);
	let spectrumCanvas = $state<HTMLCanvasElement | null>(null);
	let spectrumWidth = $state(0);
	let spectrumHeight = $state(0);

	const GRID_HEIGHT = 226;
	const PREVIEW_PEAK_LENGTH = 2048;

	/** Preview rate is capped because 128 harmonics cannot alias below Hz 1024. */
	const previewLength = $derived(Math.min(sampleLength, PREVIEW_PEAK_LENGTH));

	/** Always a full, ordered set: a missing harmonic shows as a disabled default. */
	const normalized = $derived.by(() => {
		const byHarmonic = new Map(components.map((component) => [component.harmonic, component]));
		const out: HarmonicComponent[] = [];
		for (let harmonic = 1; harmonic <= count; harmonic++) {
			out.push(
				byHarmonic.get(harmonic) ?? {
					harmonic,
					waveform: 'sine' as HarmonicWaveform,
					amplitude: 0,
					phaseRadians: 0,
					enabled: false
				}
			);
		}
		return out;
	});

	const waveform = $derived(renderHarmonics(normalized, previewLength));

	const firstVisible = $derived(Math.max(0, Math.floor(scrollLeft / colWidth) - 1));
	const lastVisible = $derived(
		Math.min(count - 1, Math.ceil((scrollLeft + Math.max(viewportWidth, colWidth)) / colWidth) + 1)
	);
	const visibleIndices = $derived.by(() => {
		const out: number[] = [];
		for (let index = firstVisible; index <= lastVisible; index++) out.push(index);
		return out;
	});
	const totalWidth = $derived(count * colWidth);

	const nyquistHarmonic = $derived(maxHarmonic(sampleLength));

	/* ------------------------------------------------------------ emission */

	function emit(next: HarmonicComponent[]) {
		onchange(next);
	}

	function replaceAt(harmonic: number, component: HarmonicComponent) {
		emit(normalized.map((entry) => (entry.harmonic === harmonic ? component : entry)));
	}

	function selectHarmonic(harmonic: number) {
		if (modifierDown) {
			selected = selected.includes(harmonic)
				? selected.filter((entry) => entry !== harmonic)
				: [...selected, harmonic];
		} else {
			selected = [harmonic];
		}
	}

	/* ------------------------------------------------------------ utilities */

	function disarm() {
		armed = null;
		if (disarmTimer) clearTimeout(disarmTimer);
		disarmTimer = null;
	}

	function applyUtility(operation: UtilityOperation) {
		switch (operation) {
			case 'clear-all':
				emit(
					normalized.map((component, index) => ({
						...component,
						amplitude: index === 0 ? 1 : 0,
						phaseRadians: 0,
						enabled: index === 0
					}))
				);
				break;
			case 'normalize': {
				const peak = normalized.reduce(
					(max, component) => (component.enabled ? Math.max(max, component.amplitude) : max),
					0
				);
				if (peak <= 0) break;
				emit(
					normalized.map((component) => ({
						...component,
						amplitude: component.enabled
							? clamp(component.amplitude / peak, 0, 1)
							: component.amplitude
					}))
				);
				break;
			}
			case 'randomize-amplitudes':
				emit(
					normalized.map((component) => ({
						...component,
						amplitude: Math.random(),
						enabled: true
					}))
				);
				break;
			case 'randomize-phases':
				emit(
					normalized.map((component) => ({
						...component,
						phaseRadians: Math.random() * Math.PI * 2
					}))
				);
				break;
			case 'reset-phases':
				emit(normalized.map((component) => ({ ...component, phaseRadians: 0 })));
				break;
			case 'keep-odd':
				emit(
					normalized.map((component) => ({
						...component,
						enabled: component.harmonic % 2 === 1 && component.amplitude > 0
					}))
				);
				break;
			case 'keep-even':
				emit(
					normalized.map((component) => ({
						...component,
						enabled: component.harmonic % 2 === 0 && component.amplitude > 0
					}))
				);
				break;
			case 'spectral-tilt':
				emit(
					normalized.map((component, index) => ({
						...component,
						amplitude: clamp(component.amplitude * (1 / (index + 1)), 0, 1)
					}))
				);
				break;
			case 'exponential-rolloff':
				emit(
					normalized.map((component, index) => ({
						...component,
						amplitude: clamp(component.amplitude * Math.pow(0.7, index), 0, 1)
					}))
				);
				break;
		}
	}

	function requestUtility(operation: UtilityOperation) {
		if (DESTRUCTIVE.includes(operation) && armed !== operation) {
			armed = operation;
			if (disarmTimer) clearTimeout(disarmTimer);
			disarmTimer = setTimeout(() => (armed = null), 5000);
			return;
		}
		disarm();
		applyUtility(operation);
	}

	function copySpectrum() {
		clipboard = normalized.map((component) => ({ ...component }));
	}

	function pasteSpectrum() {
		if (!clipboard) return;
		const source = clipboard;
		emit(
			normalized.map((component) => {
				const match = source[component.harmonic - 1];
				return match
					? {
							...component,
							waveform: match.waveform,
							amplitude: match.amplitude,
							phaseRadians: match.phaseRadians,
							enabled: match.enabled
						}
					: component;
			})
		);
	}

	const UTILITIES: { operation: UtilityOperation; label: string; title: string }[] = [
		{
			operation: 'normalize',
			label: 'Normalize',
			title: 'Scale amplitudes so the loudest harmonic is at full scale'
		},
		{ operation: 'randomize-amplitudes', label: 'Rand amp', title: 'Randomize every amplitude' },
		{ operation: 'randomize-phases', label: 'Rand phase', title: 'Randomize every phase' },
		{ operation: 'reset-phases', label: 'Phase 0', title: 'Reset every phase to zero' },
		{ operation: 'spectral-tilt', label: 'Tilt', title: 'Apply a 1/h spectral tilt' },
		{ operation: 'exponential-rolloff', label: 'Rolloff', title: 'Apply an exponential rolloff' },
		{
			operation: 'keep-odd',
			label: 'Odd',
			title: 'Keep only odd harmonics (removes enabled even harmonics)'
		},
		{
			operation: 'keep-even',
			label: 'Even',
			title: 'Keep only even harmonics (removes enabled odd harmonics)'
		},
		{ operation: 'clear-all', label: 'Clear', title: 'Clear every harmonic except H1' }
	];

	/* ------------------------------------------------------------- canvases */

	function deviceRatio(): number {
		return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
	}

	$effect(() => {
		if (!grid) return;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (rect) viewportWidth = Math.max(rect.width, 1);
		});
		observer.observe(grid);
		return () => observer.disconnect();
	});

	$effect(() => {
		const canvas = waveformCanvas;
		if (!canvas || waveWidth <= 0 || waveHeight <= 0) return;
		const dpr = deviceRatio();
		canvas.width = Math.max(1, Math.round(waveWidth * dpr));
		canvas.height = Math.max(1, Math.round(waveHeight * dpr));
		const context = canvas.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawWaveform(context, waveWidth, waveHeight);
	});

	$effect(() => {
		const canvas = spectrumCanvas;
		if (!canvas || spectrumWidth <= 0 || spectrumHeight <= 0) return;
		const dpr = deviceRatio();
		canvas.width = Math.max(1, Math.round(spectrumWidth * dpr));
		canvas.height = Math.max(1, Math.round(spectrumHeight * dpr));
		const context = canvas.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		drawSpectrum(context, spectrumWidth, spectrumHeight);
	});

	function themeValue(name: string, fallback: string): string {
		const probe = waveformCanvas ?? spectrumCanvas;
		if (!probe) return fallback;
		const styles = getComputedStyle(probe);
		return styles.getPropertyValue(name).trim() || fallback;
	}

	function drawWaveform(context: CanvasRenderingContext2D, width: number, height: number) {
		const bg = themeValue('--color-ed-0', '#05070b');
		const line = themeValue('--color-line-0', '#212734');
		const fg = themeValue('--color-fg-2', '#6d7688');

		context.fillStyle = bg;
		context.fillRect(0, 0, width, height);

		context.strokeStyle = line;
		context.lineWidth = 1;
		const zero = Math.round(height / 2) + 0.5;
		context.beginPath();
		context.moveTo(0, zero);
		context.lineTo(width, zero);
		context.stroke();

		const samples = waveform;
		if (samples.length === 0) return;
		let peak = 0;
		for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
		const scale = peak > 0 ? (height / 2 - 4) / peak : 0;

		context.strokeStyle = accent;
		context.lineWidth = 1.6;
		context.lineJoin = 'round';
		context.beginPath();
		const columns = Math.max(Math.round(width), 2);
		for (let x = 0; x <= columns; x++) {
			const sample =
				samples[Math.min(samples.length - 1, Math.floor((x / columns) * samples.length))];
			const y = height / 2 - sample * scale;
			if (x === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		}
		context.stroke();

		context.fillStyle = fg;
		context.font = '9px ui-monospace, monospace';
		context.textBaseline = 'top';
		context.fillText('TIME DOMAIN · 1 CYCLE', 6, 4);
	}

	function drawSpectrum(context: CanvasRenderingContext2D, width: number, height: number) {
		const bg = themeValue('--color-ed-0', '#05070b');
		const line = themeValue('--color-line-0', '#212734');
		const fg = themeValue('--color-fg-2', '#6d7688');

		context.fillStyle = bg;
		context.fillRect(0, 0, width, height);

		const labelSpace = 14;
		const plotHeight = Math.max(height - labelSpace, 10);
		const barWidth = width / Math.max(count, 1);

		context.font = '8px ui-monospace, monospace';
		context.textAlign = 'center';
		context.textBaseline = 'bottom';

		// resolved once: getComputedStyle per bar would dominate the draw
		const waveformColors: Record<HarmonicWaveform, string> = {
			sine: accent,
			saw: themeValue('--color-warn', '#e8a33d'),
			square: themeValue('--color-danger', '#f2564f'),
			triangle: themeValue('--color-ji', '#c58bf5')
		};

		for (const component of normalized) {
			const x = (component.harmonic - 1) * barWidth;
			const barHeight = component.enabled ? clamp(component.amplitude, 0, 1) * (plotHeight - 4) : 0;
			if (barHeight > 0) {
				context.fillStyle = waveformColors[component.waveform];
				context.fillRect(x + 0.5, plotHeight - barHeight, Math.max(barWidth - 1, 1), barHeight);
			} else {
				context.fillStyle = line;
				context.fillRect(x + 0.5, plotHeight - 1, Math.max(barWidth - 1, 1), 1);
			}
		}

		// label a readable subset only, never every column
		const labelStep = Math.max(1, Math.ceil(28 / Math.max(barWidth, 1)));
		context.fillStyle = fg;
		for (const component of normalized) {
			if (component.harmonic !== 1 && component.harmonic % labelStep !== 0) continue;
			context.fillText(
				`H${component.harmonic}`,
				(component.harmonic - 1) * barWidth + barWidth / 2,
				height - 3
			);
		}
	}
</script>

<div class="harmonic-editor" style="--accent: {accent}">
	<div class="body">
		<aside class="gutter">
			<span class="label">Harmonics</span>
			<Select
				value={String(count)}
				ariaLabel="Harmonic count"
				options={HARMONIC_COUNTS.map((value) => ({
					value: String(value),
					label: `${value}${value === 128 ? ' (advanced)' : ''}`
				}))}
				onchange={(value) => oncountchange(Number(value))}
			/>

			<span class="label">Column width</span>
			<Slider
				value={colWidth}
				min={40}
				max={84}
				step={2}
				ariaLabel="Harmonic column width"
				onchange={(value) => (colWidth = value)}
			/>

			<span class="selection num">
				{selected.length === 0
					? 'no harmonic selected'
					: selected.length === 1
						? `H${selected[0]} selected`
						: `${selected.length} selected`}
			</span>

			<div class="utility-grid">
				{#each UTILITIES as utility (utility.operation)}
					<IconButton
						size="sm"
						variant={armed === utility.operation ? 'danger' : 'ghost'}
						active={armed === utility.operation}
						label={utility.title}
						title={utility.title}
						onclick={() => requestUtility(utility.operation)}
					>
						{armed === utility.operation ? `Confirm ${utility.label}` : utility.label}
					</IconButton>
				{/each}
			</div>

			{#if armed}
				<p class="warning" role="alert">
					<strong>{armed.replace('-', ' ')}</strong> rewrites the spectrum of the active frame.
					Project undo (Ctrl/Cmd+Z) can reverse it afterwards.
					<button type="button" onclick={disarm}>cancel</button>
				</p>
			{/if}

			<div class="clipboard-row">
				<IconButton
					size="sm"
					label="Copy spectrum"
					title="Copy the current spectrum"
					onclick={copySpectrum}
				>
					Copy
				</IconButton>
				<IconButton
					size="sm"
					label="Paste spectrum"
					title="Paste the copied spectrum onto this frame"
					disabled={!clipboard}
					onclick={pasteSpectrum}
				>
					Paste
				</IconButton>
			</div>

			<p class="note num">
				H1 is the fundamental. Each column renders its own periodic source at n×f0 and never creates
				hidden columns.
			</p>
		</aside>

		<div class="grid-column">
			<div
				class="grid-shell"
				bind:this={grid}
				onscroll={(event) => (scrollLeft = event.currentTarget.scrollLeft)}
			>
				<div
					class="grid-track"
					style="width: {totalWidth}px; height: {GRID_HEIGHT}px"
					onpointerdowncapture={(event) => {
						modifierDown = event.shiftKey || event.metaKey || event.ctrlKey;
					}}
					onpointerup={() => (modifierDown = false)}
					role="group"
					aria-label="Harmonic columns, {count} harmonics"
				>
					{#each visibleIndices as index (index)}
						<div class="grid-cell" style="left: {index * colWidth}px; width: {colWidth}px">
							<HarmonicColumn
								component={normalized[index]}
								selected={selected.includes(index + 1)}
								width={colWidth - 2}
								height={GRID_HEIGHT - 4}
								{accent}
								onselect={() => selectHarmonic(index + 1)}
								onchange={(next) => replaceAt(index + 1, next)}
							/>
						</div>
					{/each}
				</div>
			</div>

			<div class="spectrum-shell">
				<canvas
					bind:this={spectrumCanvas}
					bind:clientWidth={spectrumWidth}
					bind:clientHeight={spectrumHeight}
					style="width: 100%; height: 76px"
					aria-label="Harmonic spectrum, {count} harmonics"
				></canvas>
			</div>
		</div>
	</div>

	<div class="wave-shell">
		<canvas
			bind:this={waveformCanvas}
			bind:clientWidth={waveWidth}
			bind:clientHeight={waveHeight}
			style="width: 100%; height: 104px"
			aria-label="Combined waveform preview"
		></canvas>
		<span class="caption num">
			preview rate {previewLength} · table {sampleLength} · table Nyquist H{nyquistHarmonic} · every component
			is band limited before it is summed
		</span>
	</div>
</div>

<style>
	.harmonic-editor {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		background: var(--color-bg-0);
	}

	.body {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
	}

	/* H1 sits at the left edge of the grid, so the gutter never eats the
	   editing surface that H2..H128 actually need */
	.gutter {
		display: flex;
		flex-direction: column;
		gap: 3px;
		flex: 0 0 22%;
		min-width: 168px;
		max-width: 300px;
		padding: var(--sp-3);
		border-right: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		overflow-y: auto;
	}

	.gutter :global(.select-field),
	.gutter :global(.slider) {
		max-width: 100%;
	}

	.gutter .label {
		margin-top: var(--sp-2);
	}

	.selection {
		margin-top: var(--sp-2);
		font-size: 10.5px;
		color: var(--color-fg-1);
	}

	.utility-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		margin-top: var(--sp-2);
	}

	.warning {
		margin: var(--sp-3) 0 0;
		padding: var(--sp-2) var(--sp-3);
		border: 1px solid color-mix(in oklab, var(--color-danger) 45%, var(--color-line-1));
		border-radius: var(--r-1);
		background: color-mix(in oklab, var(--color-danger) 12%, var(--color-bg-1));
		color: var(--color-fg-0);
		font-size: 10.5px;
		line-height: 1.4;
	}

	.warning strong {
		text-transform: capitalize;
	}

	.warning button {
		display: block;
		margin-top: var(--sp-1);
		border: none;
		background: none;
		padding: 0;
		color: var(--color-accent);
		font-size: 10.5px;
		cursor: pointer;
		text-decoration: underline;
	}

	.clipboard-row {
		display: flex;
		gap: 2px;
		margin-top: var(--sp-3);
	}

	.note {
		margin: var(--sp-3) 0 0;
		font-size: 9.5px;
		line-height: 1.5;
		color: var(--color-fg-3);
	}

	.grid-column {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
	}

	.grid-shell {
		position: relative;
		flex: 0 0 auto;
		overflow-x: auto;
		overflow-y: hidden;
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-ed-0);
	}

	/* the scroll container measures `totalWidth`, so only visible columns exist in
	   the DOM while the scrollbar still reflects all 128 harmonics */
	.grid-track {
		position: relative;
	}

	.grid-cell {
		position: absolute;
		top: 2px;
	}

	.spectrum-shell {
		flex: 0 0 auto;
		background: var(--color-ed-0);
	}

	.wave-shell {
		position: relative;
		flex: 0 0 auto;
		border-top: 1px solid var(--color-line-0);
		background: var(--color-ed-0);
	}

	.caption {
		position: absolute;
		right: var(--sp-3);
		bottom: 3px;
		font-size: 9px;
		color: var(--color-fg-3);
		pointer-events: none;
	}

	canvas {
		display: block;
	}
</style>
