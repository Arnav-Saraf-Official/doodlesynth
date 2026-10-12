<script lang="ts">
	/**
	 * MIDI mode: a piano-roll view over the same curve data.
	 *
	 * Nothing new is stored. Every horizontal segment between two curve points
	 * whose pitch is (nearly) constant renders as a note block; sloped segments
	 * render as ramps, so switching back to the curve editor shows exactly the
	 * continuous data you know. Notes are created, moved and resized by
	 * writing the underlying control points through the normal actions, which
	 * keeps undo, tuning and automation working untouched.
	 */
	import { clamp, hzToMidi, midiToHz } from '#lib/model/pitch';
	import { createCurve, curveColorFor } from '#lib/model/project';
	import type { CurvePoint } from '#lib/model/types';
	import { createTransform, timeGridStep } from '#lib/editor/transform';
	import { resize, zoomFrequencyAt, zoomTimeAt } from '#lib/editor/viewport';
	import { addCurveToTrack, deleteSelectedCurves, setCurvePoints } from '#lib/state/actions';
	import {
		activeTrack,
		selectCurves,
		session,
		setStatus,
		updateViewport
	} from '#lib/state/session.svelte';

	interface Props {
		/** length of a new note in beats, chosen in the MIDI bar */
		noteBeats: number;
	}

	let { noteBeats }: Props = $props();

	const RULER_HEIGHT = 26;
	/** frequency ratio above which a segment counts as a ramp, not a note */
	const RAMP_RATIO = 1.02;
	const EDGE_PX = 7;
	const MIN_NOTE_BEATS = 0.125;

	let root = $state<HTMLDivElement | null>(null);
	let canvas = $state<HTMLCanvasElement | null>(null);
	let cellWidth = $state(1000);
	let cellHeight = $state(500);
	let cursor = $state<'default' | 'pointer' | 'ew-resize'>('default');

	const track = $derived(activeTrack());
	const viewport = $derived({ ...session.viewport, rulerHeight: RULER_HEIGHT });
	const transform = $derived(createTransform(viewport));

	interface NoteSegment {
		curveId: string;
		color: string;
		selected: boolean;
		/** point indexes inside the curve */
		a: number;
		b: number;
		ramp: boolean;
		freqA: number;
		freqB: number;
		timeA: number;
		timeB: number;
	}

	const segments = $derived.by<NoteSegment[]>(() => {
		if (!track) return [];
		const out: NoteSegment[] = [];
		for (const curve of track.curves) {
			if (curve.muted || curve.points.length < 2) continue;
			const points = [...curve.points].sort((x, y) => x.time - y.time);
			const color = curveColorFor(track, curve);
			const selected = session.selectedCurveIds.includes(curve.id);
			for (let index = 0; index < points.length - 1; index++) {
				const a = points[index];
				const b = points[index + 1];
				if (b.time - a.time <= 0) continue;
				const ratio =
					Math.max(a.frequency, b.frequency) / Math.max(1e-6, Math.min(a.frequency, b.frequency));
				out.push({
					curveId: curve.id,
					color,
					selected,
					a: index,
					b: index + 1,
					ramp: ratio > RAMP_RATIO,
					freqA: a.frequency,
					freqB: b.frequency,
					timeA: a.time,
					timeB: b.time
				});
			}
		}
		return out;
	});

	/* --------------------------------------------------------- geometry */

	function laneHeight(): number {
		return Math.max(3, transform.pixelsPerOctave() / 12 - 1);
	}

	function xToBeat(x: number): number {
		return Math.max(0, transform.xToTime(x));
	}

	function snapBeat(beat: number): number {
		const step = Math.max(MIN_NOTE_BEATS, timeGridStep(viewport.pixelsPerBeat) / 4);
		return Math.round(beat / step) * step;
	}

	/** the transform is ruler-relative, the canvas is not: offset by the ruler */
	function midiAt(y: number): number {
		return Math.round(hzToMidi(transform.yToFrequency(y - RULER_HEIGHT)));
	}

	/* ------------------------------------------------------------- drag */

	type DragState =
		| {
				kind: 'move';
				curveId: string;
				segments: NoteSegment[];
				time0: number;
				midi0: number;
				beatDelta: number;
				midiDelta: number;
				moved: boolean;
				bypassSnap: boolean;
		  }
		| {
				kind: 'resize';
				curveId: string;
				index: number;
				time0: number;
				newTime: number;
				moved: boolean;
		  }
		| null;

	let drag = $state<DragState>(null);

	function pointsOf(curveId: string): CurvePoint[] | null {
		const curve = track?.curves.find((entry) => entry.id === curveId);
		return curve ? [...curve.points].sort((x, y) => x.time - y.time) : null;
	}

	/** Preview points during a drag; the project is written once on release. */
	const preview = $derived.by<CurvePoint[] | null>(() => {
		const current = drag;
		if (!current) return null;
		const points = pointsOf(current.curveId);
		if (!points) return null;
		if (current.kind === 'resize') {
			return points.map((point, index) =>
				index === current.index ? { ...point, time: Math.max(0, current.newTime) } : point
			);
		}
		return points.map((point, index) => {
			const edge = index === 0 || index === points.length - 1;
			if (!edge) return point;
			return {
				...point,
				time: Math.max(0, point.time + current.beatDelta),
				frequency: midiToHz(
					clamp(Math.round(hzToMidi(point.frequency)) + current.midiDelta, -30, 150)
				)
			};
		});
	});

	function segmentAt(
		x: number,
		y: number
	): { segment: NoteSegment; edge: 'a' | 'b' | 'body' } | null {
		const lane = laneHeight() + 2;
		for (let index = segments.length - 1; index >= 0; index--) {
			const segment = segments[index];
			const x1 = transform.timeToX(segment.timeA);
			const x2 = transform.timeToX(segment.timeB);
			const yA = RULER_HEIGHT + transform.frequencyToY(segment.freqA);
			const yB = RULER_HEIGHT + transform.frequencyToY(segment.freqB);
			if (segment.ramp) {
				// ramps are hit along their line
				const steps = Math.max(2, Math.ceil((x2 - x1) / 4));
				for (let step = 0; step <= steps; step++) {
					const t = step / steps;
					const px = x1 + (x2 - x1) * t;
					const py = yA + (yB - yA) * t;
					if (Math.hypot(px - x, py - y) <= 6) return { segment, edge: 'body' };
				}
				continue;
			}
			const top = Math.min(yA, yB);
			if (x >= x1 - 2 && x <= x2 + 2 && y >= top - 2 && y <= top + lane + 2) {
				if (Math.abs(x - x1) <= EDGE_PX) return { segment, edge: 'a' };
				if (Math.abs(x - x2) <= EDGE_PX) return { segment, edge: 'b' };
				return { segment, edge: 'body' };
			}
		}
		return null;
	}

	function localPointer(event: PointerEvent): { x: number; y: number } {
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function onPointerDown(event: PointerEvent): void {
		if (event.button !== 0 || !track) return;
		const { x, y } = localPointer(event);
		const hit = segmentAt(x, y);
		if (!hit) return;
		const { segment, edge } = hit;
		canvas?.setPointerCapture(event.pointerId);
		if (edge === 'body' && !segment.ramp) {
			drag = {
				kind: 'move',
				curveId: segment.curveId,
				segments,
				time0: xToBeat(x),
				midi0: midiAt(y),
				beatDelta: 0,
				midiDelta: 0,
				moved: false,
				bypassSnap: event.shiftKey
			};
		} else {
			drag = {
				kind: 'resize',
				curveId: segment.curveId,
				index: edge === 'a' ? segment.a : segment.b,
				time0: xToBeat(x),
				newTime: edge === 'a' ? segment.timeA : segment.timeB,
				moved: false
			};
		}
	}

	function onPointerMove(event: PointerEvent): void {
		const { x, y } = localPointer(event);
		if (!drag) {
			const hit = segmentAt(x, y);
			cursor = !hit
				? 'default'
				: hit.edge === 'body' && !hit.segment.ramp
					? 'pointer'
					: 'ew-resize';
			return;
		}
		const beat = xToBeat(x);
		const midi = midiAt(y);
		if (drag.kind === 'move') {
			const rawBeat = beat - drag.time0;
			drag.beatDelta = drag.bypassSnap
				? Math.max(-drag.time0, rawBeat)
				: Math.max(-drag.time0, snapBeat(rawBeat));
			drag.midiDelta = midi - drag.midi0;
			drag.moved = drag.moved || Math.abs(rawBeat) > 0.01 || drag.midiDelta !== 0;
		} else {
			const step = Math.max(MIN_NOTE_BEATS, timeGridStep(viewport.pixelsPerBeat) / 4);
			drag.newTime = Math.max(0, Math.round(beat / step) * step);
			drag.moved = drag.moved || Math.abs(beat - drag.time0) > 0.01;
		}
	}

	function onPointerUp(event: PointerEvent): void {
		if (!drag || !track) return;
		canvas?.releasePointerCapture(event.pointerId);
		const current = drag;
		drag = null;
		if (!current.moved) {
			selectCurves([current.curveId]);
			return;
		}
		const points = pointsOf(current.curveId);
		if (!points) return;
		let next: CurvePoint[];
		if (current.kind === 'resize') {
			next = points.map((point, index) =>
				index === current.index ? { ...point, time: Math.max(0, current.newTime) } : point
			);
		} else {
			const shift = (frequency: number) =>
				midiToHz(clamp(Math.round(hzToMidi(frequency)) + current.midiDelta, -30, 150));
			next = points.map((point, index) => {
				const edge = index === 0 || index === points.length - 1;
				if (!edge) return point;
				return {
					...point,
					time: Math.max(0, point.time + current.beatDelta),
					frequency: shift(point.frequency)
				};
			});
		}
		setCurvePoints(
			track.id,
			current.curveId,
			next,
			current.kind === 'move' ? 'Move note' : 'Resize note'
		);
	}

	/* ------------------------------------------------------ interaction */

	function onDoubleClick(event: MouseEvent): void {
		if (!track) return;
		const rect = canvas?.getBoundingClientRect();
		if (!rect) return;
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		if (segmentAt(x, y)) return;
		const start = snapBeat(xToBeat(x));
		const midi = midiAt(y);
		const frequency = midiToHz(midi);
		const end = start + Math.max(MIN_NOTE_BEATS, noteBeats);
		const curve = createCurve(start, frequency, end, frequency);
		curve.name = `Note ${midiName(midi)}`;
		addCurveToTrack(track.id, curve);
		selectCurves([curve.id]);
		setStatus(`Note added · ${noteBeats} beats`);
	}

	function onKeydown(event: KeyboardEvent): void {
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			deleteSelectedCurves();
		}
	}

	function onWheel(event: WheelEvent): void {
		event.preventDefault();
		const rect = canvas?.getBoundingClientRect();
		const anchorBeat = rect ? xToBeat(event.clientX - rect.left) : session.playhead;
		if (event.shiftKey) {
			updateViewport((v) => zoomTimeAt(v, event.deltaY > 0 ? 1.12 : 1 / 1.12, anchorBeat));
			return;
		}
		const y = rect ? event.clientY - rect.top : RULER_HEIGHT;
		const anchorHz = transform.yToFrequency(Math.max(0, y - RULER_HEIGHT));
		updateViewport((v) => zoomFrequencyAt(v, event.deltaY > 0 ? 1.1 : 1 / 1.1, anchorHz));
	}

	/* ------------------------------------------------------------ render */

	$effect(() => {
		if (!root) return;
		const observer = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (!rect) return;
			const width = Math.max(1, rect.width);
			const height = Math.max(1, rect.height);
			cellWidth = width;
			cellHeight = height;
			updateViewport((v) => resize(v, width, height));
		});
		observer.observe(root);
		return () => observer.disconnect();
	});

	$effect(() => {
		const element = canvas;
		if (!element) return;
		const dpr = window.devicePixelRatio || 1;
		element.width = Math.max(1, Math.round(cellWidth * dpr));
		element.height = Math.max(1, Math.round(cellHeight * dpr));
		const context = element.getContext('2d');
		if (!context) return;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		draw(context, cellWidth, cellHeight);
	});

	function themeValue(context: CanvasRenderingContext2D, name: string, fallback: string): string {
		return getComputedStyle(context.canvas).getPropertyValue(name).trim() || fallback;
	}

	function draw(context: CanvasRenderingContext2D, width: number, height: number): void {
		const bg = themeValue(context, '--color-ed-0', '#05070b');
		const line = themeValue(context, '--color-line-0', '#212734');
		const lineStrong = themeValue(context, '--color-line-1', '#2c3446');
		const fg = themeValue(context, '--color-fg-3', '#5b6478');
		const ruler = themeValue(context, '--color-bg-1', '#0c0f16');
		const accent = track?.color ?? '#4da3ff';

		context.fillStyle = bg;
		context.fillRect(0, 0, width, height);

		const lane = laneHeight();
		const freq = transform.frequencyWindow();
		const minMidi = Math.floor(hzToMidi(freq.min));
		const maxMidi = Math.ceil(hzToMidi(freq.max));

		/* note lanes */
		const showNames = lane >= 11;
		context.font = '9px ui-monospace, monospace';
		context.textBaseline = 'middle';
		for (let midi = minMidi; midi <= maxMidi; midi++) {
			const y = RULER_HEIGHT + transform.frequencyToY(midiToHz(midi));
			if (y < -lane || y > height + lane) continue;
			const isC = midi % 12 === 0;
			context.strokeStyle = isC ? lineStrong : line;
			context.lineWidth = 1;
			context.beginPath();
			context.moveTo(0, Math.round(y + lane / 2) + 0.5);
			context.lineTo(width, Math.round(y + lane / 2) + 0.5);
			context.stroke();
			if (showNames || isC) {
				context.fillStyle = fg;
				context.textAlign = 'left';
				context.fillText(midiName(midi), 3, y + lane / 2);
			}
		}

		/* beat grid + ruler */
		context.fillStyle = ruler;
		context.fillRect(0, 0, width, RULER_HEIGHT);
		context.strokeStyle = line;
		context.beginPath();
		context.moveTo(0, RULER_HEIGHT - 0.5);
		context.lineTo(width, RULER_HEIGHT - 0.5);
		context.stroke();
		const step = Math.max(0.25, timeGridStep(viewport.pixelsPerBeat));
		const beatsPerBar = Math.round(
			(session.project.timeSignature.numerator * 4) / session.project.timeSignature.denominator
		);
		const window = transform.timeWindow();
		context.textBaseline = 'alphabetic';
		for (let beat = Math.floor(window.from / step) * step; beat <= window.to; beat += step) {
			const x = Math.round(transform.timeToX(beat)) + 0.5;
			const bar = Math.abs(beat / beatsPerBar - Math.round(beat / beatsPerBar)) < 1e-6;
			context.strokeStyle = bar ? lineStrong : line;
			context.beginPath();
			context.moveTo(x, bar ? 0 : RULER_HEIGHT - 8);
			context.lineTo(x, height);
			context.stroke();
			if (bar || step >= 1) {
				context.fillStyle = fg;
				context.textAlign = 'left';
				context.fillText(String(Math.round(beat)), x + 3, 11);
			}
		}

		/* notes (with drag preview applied) */
		const previewPoints = preview;
		const previewCurveId = drag?.curveId ?? null;
		for (const segment of segments) {
			let { freqA, freqB, timeA, timeB } = segment;
			if (previewPoints && segment.curveId === previewCurveId) {
				const a = previewPoints[segment.a];
				const b = previewPoints[segment.b];
				if (a && b) {
					freqA = a.frequency;
					freqB = b.frequency;
					timeA = a.time;
					timeB = b.time;
				}
			}
			const x1 = transform.timeToX(timeA);
			const x2 = transform.timeToX(timeB);
			const yA = RULER_HEIGHT + transform.frequencyToY(freqA);
			const yB = RULER_HEIGHT + transform.frequencyToY(freqB);
			const active = previewPoints && segment.curveId === previewCurveId;

			if (segment.ramp) {
				context.strokeStyle = segment.color;
				context.globalAlpha = active ? 1 : 0.8;
				context.lineWidth = 2;
				context.lineCap = 'round';
				context.beginPath();
				context.moveTo(x1, yA);
				context.lineTo(x2, yB);
				context.stroke();
				context.globalAlpha = 1;
				context.fillStyle = segment.color;
				context.fillRect(x1 - 2.5, yA - 2.5, 5, 5);
				context.fillRect(x2 - 2.5, yB - 2.5, 5, 5);
				continue;
			}

			const y = Math.min(yA, yB);
			const h = Math.max(4, lane);
			context.fillStyle = segment.color;
			context.globalAlpha = active ? 0.95 : segment.selected ? 0.85 : 0.6;
			roundRect(context, x1, y, Math.max(4, x2 - x1), h, Math.min(4, h / 2));
			context.fill();
			context.globalAlpha = 1;
			if (segment.selected) {
				context.strokeStyle = segment.color;
				context.lineWidth = 1;
				roundRect(context, x1 + 0.5, y + 0.5, Math.max(4, x2 - x1) - 1, h - 1, Math.min(4, h / 2));
				context.stroke();
			}
		}

		/* playhead */
		const playX = Math.round(transform.timeToX(session.playhead)) + 0.5;
		context.strokeStyle = accent;
		context.lineWidth = 1;
		context.globalAlpha = 0.9;
		context.beginPath();
		context.moveTo(playX, 0);
		context.lineTo(playX, height);
		context.stroke();
		context.globalAlpha = 1;
	}

	function roundRect(
		context: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number
	): void {
		context.beginPath();
		context.moveTo(x + radius, y);
		context.arcTo(x + width, y, x + width, y + height, radius);
		context.arcTo(x + width, y + height, x, y + height, radius);
		context.arcTo(x, y + height, x, y, radius);
		context.arcTo(x, y, x + width, y, radius);
		context.closePath();
	}

	const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
	function midiName(midi: number): string {
		const clamped = Math.round(midi);
		return `${NOTE_NAMES[((clamped % 12) + 12) % 12]}${Math.floor(clamped / 12) - 1}`;
	}
</script>

<div class="midi-editor" bind:this={root} role="application" aria-label="MIDI note editor">
	<canvas
		bind:this={canvas}
		tabindex="0"
		style="cursor: {cursor}"
		ondblclick={onDoubleClick}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onkeydown={onKeydown}
		onwheel={onWheel}
		aria-label="Piano roll. Double-click to add a note, drag to move, drag edges to resize, Delete removes the selected note."
	></canvas>
</div>

<style>
	.midi-editor {
		position: relative;
		flex: 1;
		min-height: 0;
		background: var(--color-ed-0);
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	canvas:focus-visible {
		outline: 1px solid var(--color-accent);
		outline-offset: -1px;
	}
</style>
