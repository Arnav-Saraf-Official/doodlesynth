<script lang="ts">
	import { sampleLane } from '#lib/model/automation';
	import {
		denormalizeParameterValue,
		findParameter,
		formatParameterValue,
		normalizeParameterValue
	} from '#lib/model/parameters';
	import type { AutomationLane, AutomationPoint } from '#lib/model/types';
	import IconButton from '#lib/ui/IconButton.svelte';

	interface Props {
		lane: AutomationLane;
		/** the lane's accent colour, used for its curve */
		accent: string;
		height?: number;
		width: number;
		playhead: number;
		startBeat: number;
		pixelsPerBeat: number;
		snapBeats?: number;
		collapsed?: boolean;
		onaddPoint: (time: number, value: number) => void;
		onmovePoint: (points: AutomationPoint[]) => void;
		onremovePoint: (pointId: string) => void;
		onToggleEnabled?: (enabled: boolean) => void;
		onToggleCollapsed?: () => void;
		onRemove?: () => void;
	}

	let {
		lane,
		accent,
		height = 44,
		width,
		playhead,
		startBeat,
		pixelsPerBeat,
		snapBeats = 0,
		collapsed = false,
		onaddPoint,
		onmovePoint,
		onremovePoint,
		onToggleEnabled,
		onToggleCollapsed,
		onRemove
	}: Props = $props();

	const GUTTER = 148;
	const POINT_HIT = 7;

	let canvas = $state<HTMLCanvasElement | null>(null);
	let dragPoints = $state<AutomationPoint[] | null>(null);
	let draggingId = $state<string | null>(null);
	let hoverId = $state<string | null>(null);

	let idCounter = 0;
	function localId(): string {
		idCounter += 1;
		return `ap_${Date.now().toString(36)}${idCounter.toString(36)}`;
	}

	const definition = $derived(findParameter(lane.target));
	const canvasWidth = $derived(Math.max(64, width - GUTTER));
	const points = $derived(dragPoints ?? lane.points);
	const currentValue = $derived(sampleLane(lane, playhead));

	function toX(time: number): number {
		return (time - startBeat) * pixelsPerBeat;
	}

	function toTime(x: number): number {
		return startBeat + x / Math.max(pixelsPerBeat, 1e-6);
	}

	function toY(value: number): number {
		return height * (1 - normalizeParameterValue(lane.target, value));
	}

	function toValue(y: number): number {
		const normalized = 1 - y / Math.max(height, 1);
		return denormalizeParameterValue(lane.target, Math.min(1, Math.max(0, normalized)));
	}

	function snap(time: number): number {
		if (snapBeats <= 0) return Math.max(0, time);
		return Math.max(0, Math.round(time / snapBeats) * snapBeats);
	}

	/** Hit test in canvas pixel space, y measured from the top of the lane. */
	function pointAt(x: number, y: number): AutomationPoint | null {
		let best: AutomationPoint | null = null;
		let bestDistance = POINT_HIT;
		for (const point of points) {
			const distance = Math.hypot(toX(point.time) - x, toY(point.value) - y);
			if (distance <= bestDistance) {
				bestDistance = distance;
				best = point;
			}
		}
		return best;
	}

	function pointerPosition(event: PointerEvent): { x: number; y: number } {
		const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function handlePointerDown(event: PointerEvent) {
		const { x, y } = pointerPosition(event);
		const existing = pointAt(x, y);

		if (event.altKey && existing) {
			event.preventDefault();
			onremovePoint(existing.id);
			return;
		}

		(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId);
		const bypass = event.ctrlKey || event.metaKey;
		const rawTime = Math.max(0, toTime(x));
		const value = toValue(y);

		if (existing) {
			draggingId = existing.id;
			dragPoints = points.map((point) => ({ ...point }));
			return;
		}

		const created: AutomationPoint = {
			id: localId(),
			time: bypass ? rawTime : snap(rawTime),
			value,
			interpolation: 'linear'
		};
		const next = [...points.map((point) => ({ ...point })), created].sort(
			(a, b) => a.time - b.time
		);
		draggingId = created.id;
		dragPoints = next;
		onmovePoint(next);
	}

	function handlePointerMove(event: PointerEvent) {
		const { x, y } = pointerPosition(event);
		if (!draggingId) {
			const hovered = pointAt(x, y);
			hoverId = hovered?.id ?? null;
			return;
		}
		const bypass = event.ctrlKey || event.metaKey;
		const rawTime = Math.max(0, toTime(x));
		const time = bypass || snapBeats <= 0 ? rawTime : Math.round(rawTime / snapBeats) * snapBeats;
		const value = toValue(y);
		const next = (dragPoints ?? points)
			.map((point) => (point.id === draggingId ? { ...point, time, value } : point))
			.sort((a, b) => a.time - b.time);
		dragPoints = next;
		onmovePoint(next);
	}

	function handlePointerUp(event: PointerEvent) {
		if (draggingId) {
			const canvasEl = event.currentTarget as HTMLCanvasElement;
			if (canvasEl.hasPointerCapture(event.pointerId)) {
				canvasEl.releasePointerCapture(event.pointerId);
			}
			draggingId = null;
			dragPoints = null;
		}
	}

	function handleDoubleClick(event: MouseEvent) {
		const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		onaddPoint(snap(Math.max(0, toTime(x))), toValue(y));
	}

	function handleContextMenu(event: MouseEvent) {
		event.preventDefault();
		const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
		const hit = pointAt(event.clientX - rect.left, event.clientY - rect.top);
		if (hit) onremovePoint(hit.id);
	}

	/**
	 * Values along the visible time window, densified only where the
	 * interpolation is actually curved.
	 */
	function samplePolyline(): { x: number; y: number }[] {
		const out: { x: number; y: number }[] = [];
		const visible = points.filter((point, index) => {
			const next = points[index + 1];
			const previous = points[index - 1];
			const from = toTime(0);
			const to = toTime(canvasWidth);
			return (
				(point.time >= from && point.time <= to) ||
				(next !== undefined && point.time < from && next.time > from) ||
				(previous !== undefined && point.time > to && previous.time < to)
			);
		});
		if (visible.length === 0) {
			const value = points.length ? points[0].value : definition.defaultValue;
			return [
				{ x: 0, y: toY(value) },
				{ x: canvasWidth, y: toY(value) }
			];
		}
		out.push({ x: toX(visible[0].time), y: toY(visible[0].value) });
		for (let index = 0; index < visible.length - 1; index++) {
			const a = visible[index];
			const b = visible[index + 1];
			const curved = a.interpolation === 'smooth' || a.interpolation === 'bezier';
			const steps = curved
				? Math.max(2, Math.min(48, Math.round(Math.abs(toX(b.time) - toX(a.time)) / 6)))
				: 1;
			for (let step = 1; step <= steps; step++) {
				const time = a.time + ((b.time - a.time) * step) / steps;
				const value = step === steps ? b.value : sampleLane(lane, time);
				out.push({ x: toX(time), y: toY(value) });
			}
		}
		// extend flat to both edges so the lane reads as continuous
		const first = out[0];
		const last = out[out.length - 1];
		if (first.x > 0) out.unshift({ x: 0, y: first.y });
		if (last.x < canvasWidth) out.push({ x: canvasWidth, y: last.y });
		return out;
	}

	$effect(() => {
		const element = canvas;
		if (!element) return;

		const dpr = window.devicePixelRatio || 1;
		const cssWidth = canvasWidth;
		const cssHeight = height;
		if (
			element.width !== Math.round(cssWidth * dpr) ||
			element.height !== Math.round(cssHeight * dpr)
		) {
			element.width = Math.round(cssWidth * dpr);
			element.height = Math.round(cssHeight * dpr);
		}
		element.style.width = `${cssWidth}px`;
		element.style.height = `${cssHeight}px`;

		const context = element.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.clearRect(0, 0, cssWidth, cssHeight);

		const disabled = !lane.enabled;

		// background
		context.fillStyle = '#0b0e14';
		context.fillRect(0, 0, cssWidth, cssHeight);

		// faint centre guide and the parameter's default value
		context.strokeStyle = 'rgba(255,255,255,0.055)';
		context.lineWidth = 1;
		context.beginPath();
		context.moveTo(0, Math.round(cssHeight / 2) + 0.5);
		context.lineTo(cssWidth, Math.round(cssHeight / 2) + 0.5);
		context.stroke();

		context.setLineDash([3, 3]);
		context.strokeStyle = 'rgba(255,255,255,0.09)';
		context.beginPath();
		const defaultY = Math.round(toY(definition.defaultValue)) + 0.5;
		context.moveTo(0, defaultY);
		context.lineTo(cssWidth, defaultY);
		context.stroke();
		context.setLineDash([]);

		// grid at each bar of the passed snap step and each whole beat
		const beatStep = pixelsPerBeat >= 40 ? 1 : pixelsPerBeat >= 12 ? 4 : 16;
		context.strokeStyle = 'rgba(255,255,255,0.04)';
		const firstBeat = Math.ceil(startBeat / beatStep) * beatStep;
		for (let beat = firstBeat; toX(beat) < cssWidth; beat += beatStep) {
			const x = Math.round(toX(beat)) + 0.5;
			context.beginPath();
			context.moveTo(x, 0);
			context.lineTo(x, cssHeight);
			context.stroke();
		}

		// the lane curve
		const polyline = samplePolyline();
		if (polyline.length > 1) {
			context.beginPath();
			context.moveTo(polyline[0].x, polyline[0].y);
			for (let index = 1; index < polyline.length; index++) {
				context.lineTo(polyline[index].x, polyline[index].y);
			}
			context.strokeStyle = disabled ? 'rgba(255,255,255,0.2)' : accent;
			context.lineWidth = 1.6;
			context.lineJoin = 'round';
			context.stroke();

			// soft fill under the curve so the lane reads at a glance
			const fill = context.createLinearGradient(0, 0, 0, cssHeight);
			fill.addColorStop(0, disabled ? 'rgba(255,255,255,0.03)' : `${accent}26`);
			fill.addColorStop(1, 'rgba(0,0,0,0)');
			context.lineTo(cssWidth, cssHeight);
			context.lineTo(0, cssHeight);
			context.closePath();
			context.fillStyle = fill;
			context.fill();
		}

		// control points
		for (const point of points) {
			const x = toX(point.time);
			if (x < -6 || x > cssWidth + 6) continue;
			const y = toY(point.value);
			const active = point.id === draggingId || point.id === hoverId;
			const size = active ? 4.5 : 3.5;
			context.fillStyle = disabled ? 'rgba(255,255,255,0.35)' : active ? '#ffffff' : accent;
			context.fillRect(x - size, y - size, size * 2, size * 2);
			context.strokeStyle = '#05070b';
			context.lineWidth = 1;
			context.strokeRect(x - size, y - size, size * 2, size * 2);
		}

		// playhead
		const playheadX = Math.round(toX(playhead)) + 0.5;
		if (playheadX >= 0 && playheadX <= cssWidth) {
			context.strokeStyle = 'rgba(255,255,255,0.85)';
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(playheadX, 0);
			context.lineTo(playheadX, cssHeight);
			context.stroke();
		}
	});
</script>

<div class="lane" class:is-disabled={!lane.enabled} style="height:{height}px">
	<div class="lane-gutter" class:is-collapsed={collapsed} style="width:{GUTTER}px">
		<span class="lane-name" title={definition.key}>{definition.label}</span>
		<span class="num lane-value">{formatParameterValue(lane.target, currentValue)}</span>
		<div class="lane-actions">
			{#if onToggleCollapsed}
				<IconButton
					label={`${collapsed ? 'Expand' : 'Collapse'} ${definition.label} lane`}
					size="sm"
					onclick={() => onToggleCollapsed?.()}
				>
					<span class="glyph">{collapsed ? '▸' : '▾'}</span>
				</IconButton>
			{/if}
			{#if onToggleEnabled}
				<IconButton
					label={lane.enabled
						? `Disable ${definition.label} automation`
						: `Enable ${definition.label} automation`}
					active={lane.enabled}
					size="sm"
					onclick={() => onToggleEnabled?.(!lane.enabled)}
				>
					<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
						<circle cx="5" cy="5" r="3.4" fill="currentColor" />
					</svg>
				</IconButton>
			{/if}
			{#if onRemove}
				<IconButton
					label={`Remove ${definition.label} lane`}
					size="sm"
					variant="danger"
					onclick={onRemove}
				>
					<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
						<path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.4" fill="none" />
					</svg>
				</IconButton>
			{/if}
		</div>
	</div>

	<canvas
		bind:this={canvas}
		class="lane-canvas"
		aria-label={`${definition.label} automation, ${points.length} point${points.length === 1 ? '' : 's'}`}
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		ondblclick={handleDoubleClick}
		oncontextmenu={handleContextMenu}
	></canvas>
</div>

<style>
	.lane {
		display: flex;
		align-items: stretch;
		border-bottom: 1px solid var(--color-line-0);
		min-width: 0;
	}

	.is-disabled .lane-name,
	.is-disabled .lane-value {
		opacity: 0.5;
	}

	.lane-gutter {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
		align-content: center;
		gap: 0 var(--sp-2);
		padding: 3px var(--sp-3) 3px var(--sp-4);
		width: 148px;
		box-sizing: border-box;
		border-right: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		flex: none;
		overflow: hidden;
	}

	.lane-name {
		align-self: center;
		font-size: 11px;
		color: var(--color-fg-1);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.lane-value {
		align-self: center;
		justify-self: end;
		color: var(--color-fg-0);
	}

	.lane-actions {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 2px;
	}

	/* a collapsed lane shrinks to a single informative row */
	.lane-gutter.is-collapsed {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		grid-template-rows: none;
	}

	.lane-gutter.is-collapsed .lane-name {
		flex: 1 1 auto;
		min-width: 0;
	}

	.lane-gutter.is-collapsed .lane-actions {
		flex: none;
	}

	.glyph {
		font-size: 9px;
		line-height: 1;
	}

	.lane-canvas {
		display: block;
		flex: 1 1 auto;
		min-width: 0;
		cursor: crosshair;
		touch-action: none;
	}
</style>
