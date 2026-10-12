<script lang="ts">
	/**
	 * Graph-based filter/EQ surface.
	 *
	 * Draws the exact magnitude response of the configured biquad (RBJ
	 * cookbook coefficients evaluated on a log frequency axis) rather than a
	 * decorative approximation, so what you see is what the audio graph does.
	 * Drag the handle: X is cutoff on a log scale, Y is resonance.
	 */
	import type { FilterType } from '#lib/model/types';

	interface FilterState {
		enabled: boolean;
		type: FilterType;
		cutoff: number;
		resonance: number;
	}

	interface Props {
		filter: FilterState;
		accent?: string;
		ariaLabel?: string;
		onchange: (patch: Partial<FilterState>) => void;
	}

	let {
		filter,
		accent = 'var(--color-accent)',
		ariaLabel = 'Filter response',
		onchange
	}: Props = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let width = $state(320);
	let height = $state(120);
	let dragging = $state(false);
	let focused = $state(false);

	const MIN_HZ = 20;
	const MAX_HZ = 20000;
	const PAD = { left: 10, right: 10, top: 12, bottom: 14 };
	/** vertical span in dB drawn top to bottom */
	const DB_RANGE = 30;

	const plotWidth = $derived(Math.max(width - PAD.left - PAD.right, 10));
	const plotHeight = $derived(Math.max(height - PAD.top - PAD.bottom, 10));

	const TYPE_CHIPS: { value: FilterType; label: string; title: string }[] = [
		{ value: 'lowpass', label: 'LP', title: 'Low pass' },
		{ value: 'highpass', label: 'HP', title: 'High pass' },
		{ value: 'bandpass', label: 'BP', title: 'Band pass' },
		{ value: 'notch', label: 'N', title: 'Notch' },
		{ value: 'peaking', label: 'PK', title: 'Peaking' },
		{ value: 'lowshelf', label: 'LS', title: 'Low shelf' },
		{ value: 'highshelf', label: 'HS', title: 'High shelf' },
		{ value: 'allpass', label: 'AP', title: 'All pass' }
	];

	/* ------------------------------------------------------- math */

	function coefficients(
		type: FilterType,
		f0: number,
		q: number,
		sampleRate: number
	): { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number } {
		const w0 = (2 * Math.PI * f0) / sampleRate;
		const cos = Math.cos(w0);
		const sin = Math.sin(w0);
		const alpha = sin / (2 * Math.max(0.0001, q));
		switch (type) {
			case 'highpass':
				return {
					b0: (1 + cos) / 2,
					b1: -(1 + cos),
					b2: (1 + cos) / 2,
					a0: 1 + alpha,
					a1: -2 * cos,
					a2: 1 - alpha
				};
			case 'bandpass':
				return { b0: alpha, b1: 0, b2: -alpha, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
			case 'notch':
				return { b0: 1, b1: -2 * cos, b2: 1, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha };
			case 'peaking': {
				const a = Math.pow(10, 0.05); // fixed +14 dB boost: resonance drives depth
				return {
					b0: 1 + alpha * a,
					b1: -2 * cos,
					b2: 1 - alpha * a,
					a0: 1 + alpha / a,
					a1: -2 * cos,
					a2: 1 - alpha / a
				};
			}
			case 'lowshelf': {
				const a = Math.pow(10, 0.05);
				const twoRootAAlpha = 2 * Math.sqrt(a) * alpha;
				return {
					b0: a * (a + 1 - (a - 1) * cos + twoRootAAlpha),
					b1: 2 * a * (a - 1 - (a + 1) * cos),
					b2: a * (a + 1 - (a - 1) * cos - twoRootAAlpha),
					a0: a + 1 + (a - 1) * cos + twoRootAAlpha,
					a1: -2 * (a - 1 + (a + 1) * cos),
					a2: a + 1 + (a - 1) * cos - twoRootAAlpha
				};
			}
			case 'highshelf': {
				const a = Math.pow(10, 0.05);
				const twoRootAAlpha = 2 * Math.sqrt(a) * alpha;
				return {
					b0: a * (a + 1 + (a - 1) * cos + twoRootAAlpha),
					b1: -2 * a * (a - 1 + (a + 1) * cos),
					b2: a * (a + 1 + (a - 1) * cos - twoRootAAlpha),
					a0: a + 1 - (a - 1) * cos + twoRootAAlpha,
					a1: 2 * (a - 1 - (a + 1) * cos),
					a2: a + 1 - (a - 1) * cos - twoRootAAlpha
				};
			}
			case 'allpass':
			case 'lowpass':
			default:
				return {
					b0: (1 - cos) / 2,
					b1: 1 - cos,
					b2: (1 - cos) / 2,
					a0: 1 + alpha,
					a1: -2 * cos,
					a2: 1 - alpha
				};
		}
	}

	function magnitudeDb(
		type: FilterType,
		f0: number,
		q: number,
		freq: number,
		sampleRate: number
	): number {
		const { b0, b1, b2, a0, a1, a2 } = coefficients(type, f0, q, sampleRate);
		const w = (2 * Math.PI * freq) / sampleRate;
		const cosW = Math.cos(w);
		const sinW = Math.sin(w);
		const cos2 = Math.cos(2 * w);
		const sin2 = Math.sin(2 * w);
		const reNum = b0 + b1 * cosW + b2 * cos2;
		const imNum = b1 * sinW + b2 * sin2;
		const reDen = a0 + a1 * cosW + a2 * cos2;
		const imDen = a1 * sinW + a2 * sin2;
		const num = Math.hypot(reNum, imNum);
		const den = Math.hypot(reDen, imDen);
		return 20 * Math.log10(Math.max(1e-6, num / Math.max(1e-6, den)));
	}

	/* --------------------------------------------------- geometry */

	function freqToX(freq: number): number {
		const t = Math.log(freq / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
		return PAD.left + t * plotWidth;
	}

	function xToFreq(x: number): number {
		const t = Math.min(1, Math.max(0, (x - PAD.left) / plotWidth));
		return MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, t);
	}

	function dbToY(db: number): number {
		const clamped = Math.min(DB_RANGE / 2, Math.max(-DB_RANGE / 2, db));
		return PAD.top + ((DB_RANGE / 2 - clamped) / DB_RANGE) * plotHeight;
	}

	function resonanceToY(resonance: number): number {
		// square root so the low-Q region (where most work happens) gets space
		const t = Math.min(1, Math.max(0, resonance / 30));
		return PAD.top + (1 - Math.sqrt(t)) * plotHeight;
	}

	function yToResonance(y: number): number {
		const t = Math.min(1, Math.max(0, 1 - (y - PAD.top) / plotHeight));
		return Math.round(t * t * 30 * 100) / 100;
	}

	function themeValue(name: string, fallback: string): string {
		if (!canvas) return fallback;
		return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
	}

	function resolveAccent(): string {
		return accent.startsWith('var(')
			? themeValue(accent.slice(4, accent.length - 1), '#4da3ff')
			: accent;
	}

	/* ------------------------------------------------------ drawing */

	$effect(() => {
		const element = canvas;
		if (!element) return;
		const dpr = window.devicePixelRatio || 1;
		element.width = Math.max(1, Math.round(width * dpr));
		element.height = Math.max(1, Math.round(height * dpr));
		const context = element.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);

		const bg = themeValue('--color-ed-0', '#05070b');
		const line = themeValue('--color-line-0', '#212734');
		const lineStrong = themeValue('--color-line-1', '#2c3446');
		const fg = themeValue('--color-fg-3', '#5b6478');
		const accentColor = resolveAccent();
		const sampleRate = 48000;

		context.fillStyle = bg;
		context.fillRect(0, 0, width, height);

		// frequency gridlines
		context.strokeStyle = line;
		context.lineWidth = 1;
		context.font = '8px ui-monospace, monospace';
		context.fillStyle = fg;
		context.textAlign = 'center';
		for (const freq of [50, 100, 500, 1000, 5000, 10000]) {
			const x = Math.round(freqToX(freq)) + 0.5;
			context.beginPath();
			context.moveTo(x, PAD.top);
			context.lineTo(x, PAD.top + plotHeight);
			context.stroke();
			context.fillText(freq >= 1000 ? `${freq / 1000}k` : String(freq), x, height - 3);
		}
		// dB gridlines
		for (const db of [-12, 0, 12]) {
			const y = Math.round(dbToY(db)) + 0.5;
			context.strokeStyle = db === 0 ? lineStrong : line;
			context.beginPath();
			context.moveTo(PAD.left, y);
			context.lineTo(PAD.left + plotWidth, y);
			context.stroke();
			if (db !== 0) context.fillText(`${db > 0 ? '+' : ''}${db}`, PAD.left + 8, y - 2);
		}

		const bypassed = !filter.enabled;
		const q = Math.max(0.0001, filter.resonance);

		// response curve
		context.strokeStyle = bypassed ? fg : accentColor;
		context.lineWidth = 1.8;
		context.beginPath();
		const columns = Math.max(2, Math.round(plotWidth));
		for (let index = 0; index <= columns; index++) {
			const freq = xToFreq(PAD.left + (index / columns) * plotWidth);
			const db = bypassed ? 0 : magnitudeDb(filter.type, filter.cutoff, q, freq, sampleRate);
			const x = PAD.left + (index / columns) * plotWidth;
			const y = dbToY(db);
			if (index === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		}
		context.stroke();

		// handle at the cutoff
		const handleX = freqToX(filter.cutoff);
		const handleDb = bypassed
			? 0
			: magnitudeDb(filter.type, filter.cutoff, q, filter.cutoff, sampleRate);
		const handleY = dragging || focused ? resonanceToY(filter.resonance) : dbToY(handleDb);
		context.strokeStyle = bypassed ? fg : accentColor;
		context.globalAlpha = 0.45;
		context.lineWidth = 1;
		context.beginPath();
		context.moveTo(Math.round(handleX) + 0.5, PAD.top);
		context.lineTo(Math.round(handleX) + 0.5, PAD.top + plotHeight);
		context.stroke();
		context.globalAlpha = 1;

		context.fillStyle = bypassed ? fg : accentColor;
		context.beginPath();
		context.arc(handleX, handleY, dragging ? 5.5 : 4.5, 0, Math.PI * 2);
		context.fill();

		if (bypassed) {
			context.fillStyle = fg;
			context.font = '9px ui-monospace, monospace';
			context.textAlign = 'right';
			context.fillText('BYPASS', width - PAD.right, PAD.top + 10);
		}
	});

	/* ---------------------------------------------------- pointer */

	function applyFromPointer(event: PointerEvent): void {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return;
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		const cutoff = Math.round(xToFreq(x));
		const resonance = yToResonance(y);
		onchange({ cutoff: Math.min(MAX_HZ, Math.max(MIN_HZ, cutoff)), resonance });
	}

	function onPointerDown(event: PointerEvent): void {
		if (!filter.enabled) return;
		dragging = true;
		canvas?.setPointerCapture(event.pointerId);
		applyFromPointer(event);
	}

	function onPointerMove(event: PointerEvent): void {
		if (!dragging) return;
		applyFromPointer(event);
	}

	function onPointerUp(event: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		canvas?.releasePointerCapture(event.pointerId);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (!filter.enabled) return;
		const step = event.shiftKey ? 10 : 1;
		if (event.key === 'ArrowLeft') {
			event.preventDefault();
			onchange({ cutoff: Math.max(MIN_HZ, Math.round(filter.cutoff / Math.pow(1.04, step))) });
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			onchange({ cutoff: Math.min(MAX_HZ, Math.round(filter.cutoff * Math.pow(1.04, step))) });
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			onchange({ resonance: Math.min(30, filter.resonance + 0.25 * step) });
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			onchange({ resonance: Math.max(0.0001, filter.resonance - 0.25 * step) });
		}
	}
</script>

<div class="eq-panel">
	<div class="chips" role="group" aria-label="Filter type">
		{#each TYPE_CHIPS as chip (chip.value)}
			<button
				type="button"
				class="chip"
				class:is-active={filter.type === chip.value}
				disabled={!filter.enabled}
				title={chip.title}
				aria-label={`${chip.title} filter`}
				aria-pressed={filter.type === chip.value}
				onclick={() => onchange({ type: chip.value })}
			>
				{chip.label}
			</button>
		{/each}
		<button
			type="button"
			class="chip is-power"
			class:is-on={filter.enabled}
			title={filter.enabled ? 'Bypass filter' : 'Enable filter'}
			aria-label={filter.enabled ? 'Bypass filter' : 'Enable filter'}
			aria-pressed={filter.enabled}
			onclick={() => onchange({ enabled: !filter.enabled })}
		>
			{filter.enabled ? 'On' : 'Off'}
		</button>
	</div>
	<div class="canvas-shell">
		<canvas
			bind:this={canvas}
			bind:clientWidth={width}
			bind:clientHeight={height}
			tabindex="0"
			role="slider"
			aria-label={`${ariaLabel}: cutoff ${Math.round(filter.cutoff)} hertz, resonance ${filter.resonance.toFixed(2)}`}
			aria-valuemin={MIN_HZ}
			aria-valuemax={MAX_HZ}
			aria-valuenow={Math.round(filter.cutoff)}
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onkeydown={onKeydown}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		></canvas>
	</div>
	<p class="readout num">
		{filter.enabled
			? `${filter.type} · ${filter.cutoff >= 1000 ? `${(filter.cutoff / 1000).toFixed(1)} kHz` : `${filter.cutoff} Hz`} · Q ${filter.resonance.toFixed(2)}`
			: 'bypassed'}
		<span class="hint">— drag to tune, arrows nudge, Shift for larger steps</span>
	</p>
</div>

<style>
	.eq-panel {
		display: flex;
		flex-direction: column;
		gap: var(--sp-1);
	}

	.chips {
		display: flex;
		gap: 2px;
	}

	.chip {
		min-width: 26px;
		height: 18px;
		padding: 0 5px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-2);
		font-size: 9.5px;
		font-family: ui-monospace, monospace;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			border-color 120ms var(--ease-out);
	}

	.chip:hover:not(:disabled) {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.chip.is-active {
		background: color-mix(in oklab, var(--color-accent) 24%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-accent) 55%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.chip:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.chip.is-power {
		margin-left: auto;
	}

	.chip.is-power.is-on {
		background: color-mix(in oklab, var(--color-ok, #3ecf8e) 22%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-ok, #3ecf8e) 50%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.canvas-shell {
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		overflow: hidden;
		background: var(--color-ed-0);
	}

	canvas {
		display: block;
		width: 100%;
		height: 108px;
		cursor: crosshair;
		touch-action: none;
	}

	canvas:focus-visible {
		outline: 1px solid var(--color-accent);
		outline-offset: -1px;
	}

	.readout {
		margin: 0;
		font-size: 9.5px;
		color: var(--color-fg-2);
	}

	.hint {
		margin-left: var(--sp-2);
		color: var(--color-fg-3);
	}
</style>
