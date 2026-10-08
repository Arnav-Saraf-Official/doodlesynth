<script lang="ts">
	/**
	 * Timeline ruler.
	 *
	 * Tick density adapts to zoom and only visible ticks are drawn, so the
	 * ruler never becomes thousands of labels. Also hosts markers, the loop
	 * region and the playhead scrub handle.
	 */
	import { timeGridStep } from '#lib/editor/transform';
	import type { Transform } from '#lib/editor/transform';
	import { formatTimecode } from '#lib/model/pitch';

	interface Props {
		transform: Transform;
		playhead: number;
		tempo: number;
		markers: { id: string; time: number; label: string }[];
		loop: { enabled: boolean; start: number; end: number };
		beatsPerBar: number;
		width: number;
		height: number;
		onScrub?: (beat: number) => void;
	}

	let { transform, playhead, tempo, markers, loop, beatsPerBar, width, height, onScrub }: Props =
		$props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let dragging = $state(false);

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

		const { from, to } = transform.timeWindow();

		// loop region
		if (loop.enabled) {
			ctx.fillStyle = 'rgba(77, 163, 255, 0.14)';
			const x0 = transform.timeToX(loop.start);
			const x1 = transform.timeToX(loop.end);
			ctx.fillRect(x0, 0, Math.max(2, x1 - x0), height);
			ctx.strokeStyle = 'rgba(77, 163, 255, 0.7)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x0 + 0.5, 0);
			ctx.lineTo(x0 + 0.5, height);
			ctx.moveTo(x1 - 0.5, 0);
			ctx.lineTo(x1 - 0.5, height);
			ctx.stroke();
		}

		const step = timeGridStep(transform.viewport.pixelsPerBeat, 64);
		const startTick = Math.floor(from / step) * step;

		ctx.textBaseline = 'middle';
		ctx.font = '10px ui-monospace, monospace';

		for (let beat = startTick; beat <= to + step; beat += step) {
			const x = Math.round(transform.timeToX(beat)) + 0.5;
			if (x < -4 || x > width + 4) continue;
			const isBar = Math.abs(beat % beatsPerBar) < 1e-6;
			ctx.strokeStyle = isBar ? '#3b4658' : '#2c3444';
			ctx.beginPath();
			ctx.moveTo(x, isBar ? 6 : 13);
			ctx.lineTo(x, height);
			ctx.stroke();

			const label = isBar ? `${Math.round(beat / beatsPerBar) + 1}` : `${beat}`;
			ctx.fillStyle = isBar ? '#a4adbe' : '#6d7688';
			ctx.fillText(label, x + 3, isBar ? 10 : 16);
		}

		// markers
		for (const marker of markers) {
			const x = Math.round(transform.timeToX(marker.time)) + 0.5;
			if (x < -60 || x > width + 60) continue;
			ctx.strokeStyle = '#e8a33d';
			ctx.setLineDash([3, 3]);
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = '#e8a33d';
			ctx.beginPath();
			ctx.moveTo(x - 4, 0);
			ctx.lineTo(x + 4, 0);
			ctx.lineTo(x, 5);
			ctx.closePath();
			ctx.fill();
			ctx.fillText(marker.label, x + 5, 20);
		}

		// playhead
		const px = Math.round(transform.timeToX(playhead)) + 0.5;
		if (px >= -8 && px <= width + 8) {
			ctx.strokeStyle = '#f0f3f8';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(px, 0);
			ctx.lineTo(px, height);
			ctx.stroke();
			ctx.fillStyle = '#f0f3f8';
			ctx.beginPath();
			ctx.moveTo(px - 5, 0);
			ctx.lineTo(px + 5, 0);
			ctx.lineTo(px, 7);
			ctx.closePath();
			ctx.fill();
		}

		// hover timecode when scrubbing
		if (dragging) {
			const seconds = (playhead * 60) / tempo;
			ctx.fillStyle = '#0a0c10';
			const text = formatTimecode(seconds);
			const textWidth = ctx.measureText(text).width + 10;
			const boxX = Math.min(Math.max(px - textWidth / 2, 2), width - textWidth - 2);
			ctx.fillRect(boxX, height - 15, textWidth, 13);
			ctx.fillStyle = '#e9edf4';
			ctx.fillText(text, boxX + 5, height - 8);
		}
	}

	function beatFromEvent(event: PointerEvent): number {
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		return Math.max(0, transform.xToTime(event.clientX - rect.left));
	}

	function onPointerDown(event: PointerEvent) {
		if (!onScrub) return;
		dragging = true;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		onScrub(beatFromEvent(event));
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging || !onScrub) return;
		onScrub(beatFromEvent(event));
	}

	function onPointerUp(event: PointerEvent) {
		dragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	// drawing reads every value it depends on, so those reads are the effect's
	// dependencies and no manual dependency list is needed
	$effect(() => {
		draw();
	});
</script>

<canvas
	bind:this={canvas}
	class="ruler"
	style="width:{width}px; height:{height}px"
	aria-label="Timeline ruler. Use the arrow keys or the transport to move the playhead."
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
></canvas>

<style>
	.ruler {
		display: block;
		cursor: ew-resize;
		touch-action: none;
		background: var(--color-bg-1);
	}
</style>
