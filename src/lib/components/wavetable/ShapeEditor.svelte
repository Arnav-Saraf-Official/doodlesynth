<script lang="ts">
	/**
	 * Shape Editor — the direct waveform drawing surface.
	 *
	 * One wrapped cycle: X is phase 0..1 (0°..360°), Y is amplitude -1..+1.
	 * Freehand strokes are sampled at pointer rate and then simplified before
	 * they are committed, so a stroke never emits one control point per event.
	 */
	import { uid } from '#lib/model/ids';
	import { clamp } from '#lib/model/pitch';
	import type { ShapePoint } from '#lib/model/types';
	import { renderShape } from '#lib/model/wavetable';
	import IconButton from '#lib/ui/IconButton.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';

	export type ShapeOperation =
		| 'normalize'
		| 'rms'
		| 'removeDc'
		| 'invert'
		| 'reverse'
		| 'mirrorHorizontal'
		| 'mirrorVertical'
		| 'phaseRotate';

	interface Props {
		points: ShapePoint[];
		sampleLength: number;
		accent?: string;
		onchange: (points: ShapePoint[]) => void;
		onOperation?: (operation: ShapeOperation) => void;
	}

	let {
		points,
		sampleLength,
		accent = 'var(--color-accent)',
		onchange,
		onOperation
	}: Props = $props();

	type Tool = 'draw' | 'point';

	let tool = $state<Tool>('draw');
	let snap = $state(false);
	let container = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let size = $state({ width: 0, height: 0 });

	/** live list during a drag; cleared when the next interaction starts */
	let working = $state<ShapePoint[] | null>(null);
	const current = $derived(working ?? points);

	let selectedId = $state<string | null>(null);
	let hoverId = $state<string | null>(null);

	let stroke: { phase: number; amplitude: number }[] | null = $state(null);
	let draggingPointId: string | null = null;
	let pointGrabOffset = { dp: 0, da: 0 };
	let handleDrag: { index: number; which: 'in' | 'out' } | null = null;

	const PADDING = { left: 12, right: 12, top: 14, bottom: 20 };
	const POINT_HIT_RADIUS = 9;
	const HANDLE_HIT_RADIUS = 9;

	const plotWidth = $derived(Math.max(size.width - PADDING.left - PADDING.right, 10));
	const plotHeight = $derived(Math.max(size.height - PADDING.top - PADDING.bottom, 10));

	function xOf(phase: number): number {
		return PADDING.left + phase * plotWidth;
	}

	function yOf(amplitude: number): number {
		return PADDING.top + (1 - (amplitude + 1) / 2) * plotHeight;
	}

	function phaseAt(x: number): number {
		const phase = (x - PADDING.left) / plotWidth;
		return snap ? Math.round(phase * 16) / 16 : phase;
	}

	function amplitudeAt(y: number): number {
		const amplitude = 1 - ((y - PADDING.top) / plotHeight) * 2;
		return snap ? Math.round(amplitude * 10) / 10 : amplitude;
	}

	function pointerPosition(event: PointerEvent): { x: number; y: number } {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	/* ------------------------------------------------------------ geometry */

	function sorted(list: ShapePoint[]): ShapePoint[] {
		return [...list].sort((a, b) => a.phase - b.phase);
	}

	function findPointAt(x: number, y: number): ShapePoint | null {
		for (const point of current) {
			if (Math.hypot(xOf(point.phase) - x, yOf(point.amplitude) - y) <= POINT_HIT_RADIUS) {
				return point;
			}
		}
		return null;
	}

	function findHandleAt(x: number, y: number): { index: number; which: 'in' | 'out' } | null {
		for (let index = 0; index < current.length; index++) {
			const point = current[index];
			if (point.id !== selectedId) continue;
			if (point.inHandle) {
				const hx = xOf(point.phase + point.inHandle.dp);
				const hy = yOf(point.amplitude + point.inHandle.da);
				if (Math.hypot(hx - x, hy - y) <= HANDLE_HIT_RADIUS) return { index, which: 'in' };
			}
			if (point.outHandle) {
				const hx = xOf(point.phase + point.outHandle.dp);
				const hy = yOf(point.amplitude + point.outHandle.da);
				if (Math.hypot(hx - x, hy - y) <= HANDLE_HIT_RADIUS) return { index, which: 'out' };
			}
		}
		return null;
	}

	/** Give the selected point grabbable handles so curvature is always reachable. */
	function ensureHandles(index: number): ShapePoint[] {
		const list = current.map((point, i) => {
			if (i !== index) return point;
			if (point.inHandle && point.outHandle) return point;
			return {
				...point,
				interpolation: 'bezier' as const,
				inHandle: point.inHandle ?? { dp: -0.06, da: 0 },
				outHandle: point.outHandle ?? { dp: 0.06, da: 0 }
			};
		});
		onchange(sorted(list));
		return list;
	}

	/* ------------------------------------------------- simplification */

	/**
	 * Ramer–Douglas–Peucker in normalized (phase, amplitude) space. Amplitude is
	 * halved so both axes contribute comparably at equal visual error.
	 */
	function simplify(
		samples: { phase: number; amplitude: number }[],
		tolerance = 0.006
	): { phase: number; amplitude: number }[] {
		if (samples.length <= 2) return [...samples];
		const keep = new Uint8Array(samples.length);
		keep[0] = 1;
		keep[samples.length - 1] = 1;
		const stack: [number, number][] = [[0, samples.length - 1]];
		const point = (index: number) => ({ x: samples[index].phase, y: samples[index].amplitude / 2 });

		while (stack.length) {
			const [first, last] = stack.pop()!;
			if (last <= first + 1) continue;
			const a = point(first);
			const b = point(last);
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const lengthSq = dx * dx + dy * dy;
			let maxDistance = -1;
			let maxIndex = -1;
			for (let i = first + 1; i < last; i++) {
				const p = point(i);
				let distance: number;
				if (lengthSq === 0) {
					distance = Math.hypot(p.x - a.x, p.y - a.y);
				} else {
					const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
					distance = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
				}
				if (distance > maxDistance) {
					maxDistance = distance;
					maxIndex = i;
				}
			}
			if (maxDistance > tolerance && maxIndex > 0) {
				keep[maxIndex] = 1;
				stack.push([first, maxIndex], [maxIndex, last]);
			}
		}
		return samples.filter((_, index) => keep[index] === 1);
	}

	function commitStroke(samples: { phase: number; amplitude: number }[]) {
		if (samples.length < 2) {
			working = null;
			stroke = null;
			return;
		}
		const reduced = simplify(samples);
		// a full-cycle stroke must close: the seam between the last and first
		// point has to line up or the generated table jumps once per cycle
		const closed = reduced[0].phase <= 0.01 && reduced[reduced.length - 1].phase >= 0.99;
		const created: ShapePoint[] = reduced.map((sample, index) => {
			const amplitude =
				closed && index === reduced.length - 1
					? reduced[0].amplitude
					: clamp(sample.amplitude, -1, 1);
			return {
				id: uid('sp'),
				phase: clamp(sample.phase, 0, 1),
				amplitude,
				interpolation: 'smooth'
			};
		});
		onchange(sorted(created));
		working = null;
		stroke = null;
		selectedId = null;
	}

	/* --------------------------------------------------------- interactions */

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		const { x, y } = pointerPosition(event);
		canvas?.setPointerCapture(event.pointerId);
		working = null;

		if (tool === 'draw') {
			const phase = clamp(phaseAt(x), 0, 1);
			const amplitude = clamp(amplitudeAt(y), -1, 1);
			stroke = [{ phase, amplitude }];
			return;
		}

		const handle = findHandleAt(x, y);
		if (handle) {
			handleDrag = handle;
			return;
		}

		const point = findPointAt(x, y);
		if (!point) {
			if (event.detail === 2) {
				const phase = clamp(phaseAt(x), 0, 1);
				const next = sorted([
					...current,
					{ id: uid('sp'), phase, amplitude: clamp(amplitudeAt(y), -1, 1), interpolation: 'smooth' }
				]);
				working = next;
				onchange(next);
			} else {
				selectedId = null;
			}
			return;
		}

		if (event.altKey) {
			const next = current.filter((entry) => entry.id !== point.id);
			if (next.length >= 2) {
				working = next;
				onchange(next);
			}
			selectedId = null;
			return;
		}

		selectedId = point.id;
		draggingPointId = point.id;
		// respect where the pointer grabbed the point rather than snapping to it
		pointGrabOffset = { dp: point.phase - phaseAt(x), da: point.amplitude - amplitudeAt(y) };
		if (!point.inHandle || !point.outHandle) {
			const index = current.findIndex((entry) => entry.id === point.id);
			if (index >= 0) {
				const withHandles = ensureHandles(index);
				working = withHandles;
			}
		}
	}

	function onPointerMove(event: PointerEvent) {
		const { x, y } = pointerPosition(event);

		if (tool === 'draw' && stroke) {
			const phase = clamp((x - PADDING.left) / plotWidth, 0, 1);
			const amplitude = clamp(amplitudeAt(y), -1, 1);
			const last = stroke[stroke.length - 1];
			// sample densely but never twice at the same pixel column
			if (
				!last ||
				Math.abs(last.phase - phase) > 0.0005 ||
				Math.abs(last.amplitude - amplitude) > 0.0005
			) {
				stroke.push({ phase, amplitude });
			}
			return;
		}

		if (handleDrag) {
			const point = current[handleDrag.index];
			if (!point) return;
			const dp = (x - PADDING.left) / plotWidth - point.phase;
			const da = amplitudeAt(y) - point.amplitude;
			const next = current.map((entry, index) =>
				index === handleDrag!.index
					? {
							...entry,
							interpolation: 'bezier' as const,
							inHandle: handleDrag!.which === 'in' ? { dp, da } : entry.inHandle,
							outHandle: handleDrag!.which === 'out' ? { dp, da } : entry.outHandle
						}
					: entry
			);
			working = next;
			onchange(next);
			return;
		}

		if (draggingPointId) {
			const phase = clamp(phaseAt(x) + pointGrabOffset.dp, 0, 1);
			const amplitude = clamp(amplitudeAt(y) + pointGrabOffset.da, -1, 1);
			const next = sorted(
				current.map((entry) =>
					entry.id === draggingPointId ? { ...entry, phase, amplitude } : entry
				)
			);
			working = next;
			onchange(next);
			return;
		}

		if (tool === 'point') {
			const hovered = findPointAt(x, y);
			hoverId = hovered ? hovered.id : null;
		}
	}

	function onPointerUp(event: PointerEvent) {
		canvas?.releasePointerCapture(event.pointerId);
		if (tool === 'draw' && stroke) commitStroke(stroke);
		draggingPointId = null;
		handleDrag = null;
	}

	function onContextMenu(event: MouseEvent) {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return;
		const point = findPointAt(event.clientX - rect.left, event.clientY - rect.top);
		if (!point) return;
		event.preventDefault();
		const next = current.filter((entry) => entry.id !== point.id);
		if (next.length >= 2) {
			working = next;
			onchange(next);
			selectedId = null;
		}
	}

	/* -------------------------------------------------------------- canvas */

	$effect(() => {
		if (!container) return;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (!rect) return;
			size = { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) };
		});
		observer.observe(container);
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!canvas || size.width <= 0 || size.height <= 0) return;
		const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(size.width * dpr));
		canvas.height = Math.max(1, Math.round(size.height * dpr));
		const context = canvas.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, size.width, size.height);
		draw(context);
	});

	function draw(context: CanvasRenderingContext2D) {
		const styles = getComputedStyle(canvas!);
		const read = (name: string, fallback: string) =>
			styles.getPropertyValue(name).trim() || fallback;
		const bg = read('--color-ed-0', '#05070b');
		const line = read('--color-line-0', '#212734');
		const faint = read('--color-line-1', '#2c3444');
		const fg = read('--color-fg-2', '#6d7688');
		const strong = read('--color-fg-0', '#e9edf4');

		context.fillStyle = bg;
		context.fillRect(0, 0, size.width, size.height);

		// amplitude guides
		context.strokeStyle = line;
		context.lineWidth = 1;
		for (const amplitude of [-1, -0.5, 0, 0.5, 1]) {
			const y = Math.round(yOf(amplitude)) + 0.5;
			context.beginPath();
			context.moveTo(PADDING.left, y);
			context.lineTo(PADDING.left + plotWidth, y);
			context.strokeStyle = amplitude === 0 ? faint : line;
			context.stroke();
		}

		// phase grid
		context.fillStyle = fg;
		context.font = '9px ui-monospace, monospace';
		context.textAlign = 'center';
		context.textBaseline = 'top';
		for (let index = 0; index <= 4; index++) {
			const phase = index / 4;
			const x = Math.round(xOf(phase)) + 0.5;
			context.strokeStyle = line;
			context.beginPath();
			context.moveTo(x, PADDING.top);
			context.lineTo(x, PADDING.top + plotHeight);
			context.stroke();
			context.fillText(`${index * 90}°`, xOf(phase), PADDING.top + plotHeight + 5);
		}

		context.textAlign = 'left';
		context.fillText('+1', 1, Math.max(PADDING.top - 8, 0));
		context.fillText('-1', 1, PADDING.top + plotHeight - 6);

		// committed curve, generated through the same code the table uses
		const resolution = Math.max(64, Math.min(Math.round(plotWidth), 2048));
		const table = renderShape(current, resolution);
		context.strokeStyle = accent;
		context.lineWidth = 1.8;
		context.lineJoin = 'round';
		context.beginPath();
		for (let index = 0; index <= resolution; index++) {
			const phase = index / resolution;
			const x = xOf(phase);
			const y = yOf(clamp(table[Math.min(index, table.length - 1)] ?? 0, -1, 1));
			if (index === 0) context.moveTo(x, y);
			else context.lineTo(x, y);
		}
		context.stroke();

		// live freehand preview
		if (stroke && stroke.length > 1) {
			context.strokeStyle = strong;
			context.lineWidth = 1.2;
			context.setLineDash([3, 3]);
			context.beginPath();
			stroke.forEach((sample, index) => {
				const x = xOf(sample.phase);
				const y = yOf(sample.amplitude);
				if (index === 0) context.moveTo(x, y);
				else context.lineTo(x, y);
			});
			context.stroke();
			context.setLineDash([]);
		}

		// control points
		for (const point of current) {
			const x = xOf(point.phase);
			const y = yOf(point.amplitude);
			const isSelected = point.id === selectedId;
			const isHovered = point.id === hoverId;

			if (isSelected && point.inHandle && point.outHandle) {
				context.strokeStyle = faint;
				context.lineWidth = 1;
				for (const handle of [point.inHandle, point.outHandle]) {
					const hx = xOf(point.phase + handle.dp);
					const hy = yOf(point.amplitude + handle.da);
					context.beginPath();
					context.moveTo(x, y);
					context.lineTo(hx, hy);
					context.stroke();
					context.fillStyle = strong;
					context.beginPath();
					context.arc(hx, hy, 3.2, 0, Math.PI * 2);
					context.fill();
				}
			}

			context.fillStyle = isSelected ? strong : accent;
			context.beginPath();
			context.arc(x, y, isSelected ? 5 : isHovered ? 4.2 : 3.4, 0, Math.PI * 2);
			context.fill();
			context.strokeStyle = bg;
			context.lineWidth = 1.2;
			context.stroke();
		}
	}

	const operations: { label: string; operation: ShapeOperation; title: string }[] = [
		{ label: 'Peak', operation: 'normalize', title: 'Peak normalize to full scale' },
		{ label: 'RMS', operation: 'rms', title: 'RMS normalize' },
		{ label: 'DC', operation: 'removeDc', title: 'Remove DC offset' },
		{ label: 'Inv', operation: 'invert', title: 'Invert amplitude' },
		{ label: 'Rev', operation: 'reverse', title: 'Reverse phase order' },
		{ label: 'MirH', operation: 'mirrorHorizontal', title: 'Mirror horizontally' },
		{ label: 'MirV', operation: 'mirrorVertical', title: 'Mirror vertically' },
		{ label: '90°', operation: 'phaseRotate', title: 'Rotate phase 90°' }
	];
</script>

<div class="shape-editor">
	<div class="toolbar">
		<SegmentedControl
			value={tool}
			size="sm"
			ariaLabel="Shape tool"
			segments={[
				{ value: 'draw', label: 'Draw', title: 'Freehand draw (simplified on release)' },
				{ value: 'point', label: 'Point', title: 'Edit control points and tangents' }
			]}
			onchange={(value) => {
				tool = value as Tool;
				working = null;
				stroke = null;
			}}
		/>

		<label class="snap">
			<input type="checkbox" bind:checked={snap} />
			<span>Snap</span>
		</label>

		<span class="spacer"></span>

		<div class="operations">
			{#each operations as item (item.operation)}
				<IconButton
					size="sm"
					label={item.title}
					title={item.title}
					disabled={!onOperation}
					onclick={() => onOperation?.(item.operation)}
				>
					{item.label}
				</IconButton>
			{/each}
		</div>
	</div>

	<div class="canvas-shell" bind:this={container}>
		<canvas
			bind:this={canvas}
			style="width: {size.width}px; height: {size.height}px"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			oncontextmenu={onContextMenu}
			aria-label="Waveform shape editor. {current.length} control points."
		></canvas>
		<span class="hint num">
			{sampleLength} samples · {current.length} points
		</span>
	</div>
</div>

<style>
	.shape-editor {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
	}

	.spacer {
		flex: 1 1 auto;
	}

	.snap {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		font-size: 11px;
		color: var(--color-fg-2);
		cursor: pointer;
	}

	.snap input {
		accent-color: var(--color-accent);
	}

	.operations {
		display: flex;
		gap: 2px;
		flex-wrap: wrap;
	}

	.canvas-shell {
		position: relative;
		flex: 1 1 auto;
		min-height: 160px;
		overflow: hidden;
		background: var(--color-ed-0);
	}

	canvas {
		display: block;
		touch-action: none;
		cursor: crosshair;
	}

	.hint {
		position: absolute;
		right: var(--sp-3);
		bottom: 3px;
		font-size: 9.5px;
		color: var(--color-fg-3);
		pointer-events: none;
	}
</style>
