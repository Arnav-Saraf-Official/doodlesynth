<script lang="ts">
	import { clamp } from '#lib/model/pitch';

	interface Props {
		value: number;
		min?: number;
		max?: number;
		step?: number;
		defaultValue?: number;
		ariaLabel: string;
		/** 0..1 arc drawn to the right of the knob, e.g. 0.25 for 90° */
		arc?: number;
		size?: number;
		disabled?: boolean;
		format?: (value: number) => string;
		onchange?: (value: number) => void;
	}

	let {
		value = $bindable(),
		min = 0,
		max = 1,
		step = 0.01,
		defaultValue = min,
		ariaLabel,
		arc = 0.375,
		size = 26,
		disabled = false,
		format,
		onchange
	}: Props = $props();

	let dragging = $state(false);
	let startY = 0;
	let startValue = 0;

	const normalized = $derived(clamp((value - min) / (max - min || 1), 0, 1));
	const startAngle = -135;
	const sweep = 270;
	const angle = $derived(startAngle + normalized * sweep);
	const readout = $derived(format ? format(value) : value.toFixed(2));

	function commit(next: number) {
		const quantized = Math.round(next / step) * step;
		const clamped = clamp(Number(quantized.toFixed(6)), min, max);
		if (clamped !== value) {
			value = clamped;
			onchange?.(clamped);
		}
	}

	function onPointerDown(event: PointerEvent) {
		if (disabled) return;
		if (event.detail === 2) {
			commit(defaultValue);
			return;
		}
		dragging = true;
		startY = event.clientY;
		startValue = value;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		const fine = event.shiftKey ? 0.15 : 1;
		const delta = ((startY - event.clientY) / 120) * (max - min) * fine;
		commit(startValue + delta);
	}

	function onPointerUp(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function onWheel(event: WheelEvent) {
		if (disabled) return;
		event.preventDefault();
		const fine = event.shiftKey ? 0.1 : 1;
		commit(value - Math.sign(event.deltaY) * step * 2 * fine);
	}

	function onKeydown(event: KeyboardEvent) {
		const direction =
			event.key === 'ArrowUp' || event.key === 'ArrowRight'
				? 1
				: event.key === 'ArrowDown' || event.key === 'ArrowLeft'
					? -1
					: 0;
		if (!direction) return;
		event.preventDefault();
		commit(value + direction * step * (event.shiftKey ? 10 : 1));
	}

	const radius = 10;
	const circumference = 2 * Math.PI * radius;
	const arcLength = $derived(circumference * arc);
</script>

<div
	class="knob"
	class:is-dragging={dragging}
	class:is-disabled={disabled}
	role="slider"
	tabindex={disabled ? -1 : 0}
	aria-label={ariaLabel}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={value}
	aria-valuetext={readout}
	title={`${ariaLabel} — ${readout}`}
	style="--knob-size: {size}px"
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onwheel={onWheel}
	onkeydown={onKeydown}
	ondblclick={(event) => {
		event.preventDefault();
		commit(defaultValue);
	}}
>
	<svg viewBox="0 0 26 26" aria-hidden="true">
		<circle class="track" cx="13" cy="13" r={radius} />
		<circle class="arc" cx="13" cy="13" r={radius} stroke-dasharray="{arcLength} {circumference}" />
		<line class="pointer" x1="13" y1="13" x2="13" y2="5.5" transform="rotate({angle} 13 13)" />
	</svg>
</div>

<style>
	.knob {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--knob-size);
		height: var(--knob-size);
		cursor: ns-resize;
		touch-action: none;
		color: var(--color-fg-1);
		border-radius: 50%;
		transition:
			color 120ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	svg {
		width: 100%;
		height: 100%;
		/* rotate so the arc starts at the lower left like a hardware knob */
		transform: rotate(135deg);
		overflow: visible;
	}

	.track {
		fill: var(--color-bg-1);
		stroke: var(--color-line-1);
		stroke-width: 2;
	}

	.arc {
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
	}

	.pointer {
		stroke: var(--color-fg-0);
		stroke-width: 1.6;
		stroke-linecap: round;
	}

	.knob:hover {
		color: var(--color-accent);
	}

	.knob.is-dragging {
		transform: scale(1.04);
		color: var(--color-accent);
	}

	.knob.is-disabled {
		opacity: 0.4;
		cursor: default;
	}
</style>
