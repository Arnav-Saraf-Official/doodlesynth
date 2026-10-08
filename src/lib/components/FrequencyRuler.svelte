<script lang="ts">
	/**
	 * Frequency / note axis.
	 *
	 * In Piano Map mode this draws note lanes and octave bands with an
	 * optional keyboard sidebar. In Frequency Map mode it draws honest Hz
	 * ticks in the active projection, plus JI and scale target markers so the
	 * difference between 12-TET and the active tuning is visible.
	 */
	import { frequencyTicks } from '#lib/editor/transform';
	import type { Transform } from '#lib/editor/transform';
	import { hzToMidi, midiToHz, midiToName, NOTE_NAMES } from '#lib/model/pitch';
	import type { PitchTarget } from '#lib/model/types';

	interface Props {
		transform: Transform;
		targets: PitchTarget[];
		width: number;
		height: number;
	}

	let { transform, targets, width, height }: Props = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);

	const isPiano = $derived(transform.viewport.pitchMap === 'piano');

	function draw() {
		if (!canvas) return;
		const dpr = window.devicePixelRatio || 1;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		canvas.width = Math.max(1, Math.round(width * dpr));
		canvas.height = Math.max(1, Math.round(height * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		ctx.fillStyle = '#10131a';
		ctx.fillRect(0, 0, width, height);
		ctx.font = '10px ui-monospace, monospace';
		ctx.textBaseline = 'middle';

		if (isPiano) {
			// keyboard sidebar: white keys full width, black keys shorter
			const from = Math.ceil(hzToMidi(transform.frequencyWindow().min));
			const to = Math.floor(hzToMidi(transform.frequencyWindow().max));
			for (let note = from; note <= to; note++) {
				const pitchClass = ((note % 12) + 12) % 12;
				const isBlack = [1, 3, 6, 8, 10].includes(pitchClass);
				const y = transform.frequencyToY(midiToHz(note));
				const nextY = transform.frequencyToY(midiToHz(note + 1));
				const rowHeight = Math.abs(nextY - y);
				if (rowHeight < 3) continue;
				ctx.fillStyle = isBlack ? '#0b0e14' : '#161a23';
				ctx.fillRect(
					isBlack ? width * 0.4 : 0,
					Math.min(y, nextY),
					isBlack ? width * 0.6 : width,
					rowHeight
				);
				ctx.strokeStyle = '#212734';
				ctx.beginPath();
				ctx.moveTo(0, Math.round(Math.min(y, nextY)) + 0.5);
				ctx.lineTo(width, Math.round(Math.min(y, nextY)) + 0.5);
				ctx.stroke();

				const name = midiToName(note);
				ctx.fillStyle = isBlack ? '#6d7688' : '#a4adbe';
				ctx.fillText(name, isBlack ? 6 : width - 34, Math.min(y, nextY) + rowHeight / 2);
			}
		} else {
			// Hz ticks, honest to the active projection
			for (const hz of frequencyTicks(transform, 26, 60)) {
				const y = Math.round(transform.frequencyToY(hz)) + 0.5;
				if (y < 0 || y > height) continue;
				ctx.strokeStyle = '#2c3444';
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(width * 0.35, y);
				ctx.stroke();
				ctx.fillStyle = '#a4adbe';
				const label =
					hz >= 1000
						? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k`
						: `${hz.toFixed(hz < 100 ? 0 : 0)}`;
				ctx.fillText(label, 4, y);
			}
		}

		// tuning targets: 12-TET references stay subtle, JI targets get the
		// dedicated marker style so they are never confused with note guides
		for (const target of targets) {
			const y = Math.round(transform.frequencyToY(target.frequency)) + 0.5;
			if (y < 0 || y > height) continue;
			const isTonic = target.degreeIndex === 0;
			if (target.ji) {
				ctx.strokeStyle = isTonic ? '#c58bf5' : 'rgba(197, 139, 245, 0.55)';
				ctx.lineWidth = isTonic ? 2 : 1;
				ctx.beginPath();
				ctx.moveTo(width - 12, y);
				ctx.lineTo(width, y);
				ctx.stroke();
				// deviation from the 12-TET reference, in pixels
				const tetY = transform.frequencyToY(target.tetFrequency);
				if (Math.abs(tetY - y) > 1.5) {
					ctx.strokeStyle = 'rgba(197, 139, 245, 0.5)';
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.moveTo(width - 6, y);
					ctx.lineTo(width - 6, tetY);
					ctx.stroke();
				}
			} else if (isTonic) {
				ctx.strokeStyle = 'rgba(77, 163, 255, 0.8)';
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.moveTo(width - 12, y);
				ctx.lineTo(width, y);
				ctx.stroke();
			}
		}
	}

	// the draw call reads every value it depends on, so those reads become the
	// effect's dependencies
	$effect(() => {
		draw();
	});

	/** Root of the Musical State that is active where the axis is drawn. */
	const rootLabel = $derived.by(() => {
		const tonic = targets.find((target) => target.degreeIndex === 0);
		if (!tonic) return null;
		const pitchClass = ((hzToMidi(tonic.frequency) % 12) + 12) % 12;
		return `${NOTE_NAMES[Math.round(pitchClass)]} root`;
	});
</script>

<div class="axis" style="width:{width}px; height:{height}px">
	<canvas bind:this={canvas} style="width:{width}px; height:{height}px"></canvas>
	{#if rootLabel}
		<span class="badge num" title="Active root of the Musical State at the playhead">
			{rootLabel}
		</span>
	{/if}
</div>

<style>
	.axis {
		position: relative;
		background: var(--color-bg-1);
		border-right: 1px solid var(--color-line-0);
	}

	canvas {
		display: block;
	}

	.badge {
		position: absolute;
		top: 2px;
		left: 2px;
		padding: 1px 4px;
		border-radius: var(--r-1);
		background: color-mix(in oklab, var(--color-accent) 22%, var(--color-bg-1));
		color: var(--color-fg-0);
		font-size: 9px;
		pointer-events: none;
	}
</style>
