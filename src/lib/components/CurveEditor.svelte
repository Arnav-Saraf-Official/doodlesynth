<script lang="ts">
	/**
	 * The main curve editor.
	 *
	 * Rendering is split into a background canvas (grid, tuning targets,
	 * markers, loop) and a content canvas (curves, points, playhead, drag
	 * preview). Only the content canvas repaints during a gesture, and the
	 * project model is written once per gesture rather than once per pointer
	 * event, which is what keeps drawing responsive.
	 */
	import { flattenLane } from '#lib/model/automation';
	import { createPoint, simplifyPoints, type FlattenedPoint } from '#lib/model/curve';
	import { centsBetween, clamp, formatHz, hzToNoteName } from '#lib/model/pitch';
	import { createCurve, curveColorFor } from '#lib/model/project';
	import { findScale } from '#lib/model/scale';
	import { resolveMusicalState } from '#lib/model/musicalState';
	import { targetsForState } from '#lib/model/tuning';
	import type {
		Curve,
		CurvePoint,
		FrequencyProjection,
		PitchMap,
		PitchTarget,
		SnapPitchMode,
		Track
	} from '#lib/model/types';
	import { CurveGeometryCache, viewportKey } from '#lib/editor/curveSampling';
	import { hitTestCurves, hitTestHandles, hitTestPoints, pointPixel } from '#lib/editor/hitTesting';
	import { snapFrequency, snapTime, snapToNote } from '#lib/editor/snapping';
	import { createTransform, timeGridStep } from '#lib/editor/transform';
	import { panFrequency, resize, zoomFrequencyAt, zoomTimeAt } from '#lib/editor/viewport';
	import type { Modifiers } from '#lib/editor/gestures';
	import { modifiersFrom } from '#lib/editor/gestures';
	import {
		addCurveToTrack,
		addMarkerAt,
		addPointAt,
		attachPointToCurve,
		branchCurveAtPoint,
		deleteSelectedCurves,
		joinCurves,
		setCurvePoints,
		setLoop,
		splitCurve,
		updateCurve,
		updateEditorSettings
	} from '#lib/state/actions';
	import type { PointHit } from '#lib/editor/hitTesting';
	import {
		activeTrack,
		isMasterSelected,
		selectCurves,
		selectPoints,
		sealHistory,
		seek,
		session,
		setStatus,
		updateViewport
	} from '#lib/state/session.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import FrequencyRuler from './FrequencyRuler.svelte';
	import TimelineRuler from './TimelineRuler.svelte';

	const AXIS_WIDTH = 62;
	const RULER_HEIGHT = 26;
	const HANDLE_RADIUS_PX = 14;
	/** pixel length of a default tangent handle at the current zoom */
	const HANDLE_PIXELS = 34;
	const POINT_IDLE_RADIUS_PX = 12;
	const POINT_HIT_RADIUS_PX = 14;

	/* ------------------------------------------------------------ geometry */

	let cellWidth = $state(1200);
	let cellHeight = $state(600);
	let gridCanvas = $state<HTMLCanvasElement | null>(null);
	let contentCanvas = $state<HTMLCanvasElement | null>(null);

	const transform = $derived(createTransform(session.viewport));
	const settings = $derived(session.project.editorSettings);
	const beatsPerBar = $derived(
		(session.project.timeSignature.numerator * 4) / session.project.timeSignature.denominator
	);
	const track = $derived(activeTrack());
	const accent = $derived(track?.color ?? '#4da3ff');
	const geometryCache = new CurveGeometryCache();

	interface TargetSegment {
		from: number;
		to: number;
		targets: PitchTarget[];
	}

	/** Tuning targets are time dependent, so one segment per keyframe span. */
	const targetSegments = $derived.by<TargetSegment[]>(() => {
		const project = session.project;
		const window = transform.timeWindow();
		const frames = [...project.master.musicalState].sort((a, b) => a.time - b.time);
		if (frames.length === 0) return [];
		const options = {
			minFrequencyHz: project.editorSettings.minFrequencyHz,
			maxFrequencyHz: project.editorSettings.maxFrequencyHz
		};
		const segments: TargetSegment[] = [];
		for (let index = 0; index < frames.length; index++) {
			const from = Math.max(index === 0 ? window.from : frames[index].time, window.from);
			const to = Math.min(
				index + 1 < frames.length ? frames[index + 1].time : window.to,
				window.to
			);
			if (to <= from) continue;
			const scale = findScale(project.scales, frames[index].state.scaleId);
			segments.push({ from, to, targets: targetsForState(frames[index].state, scale, options) });
		}
		return segments;
	});

	const playheadTargets = $derived.by(() => {
		const project = session.project;
		const state = resolveMusicalState(project, session.playhead);
		return targetsForState(state, findScale(project.scales, state.scaleId), {
			minFrequencyHz: project.editorSettings.minFrequencyHz,
			maxFrequencyHz: project.editorSettings.maxFrequencyHz
		});
	});

	const rootLabel = $derived(
		['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][
			resolveMusicalState(session.project, session.playhead).rootPitchClass
		]
	);

	/* ------------------------------------------------------------- state */

	let cursor = $state<{ beat: number; frequency: number } | null>(null);
	let hoverPointId = $state<string | null>(null);
	let hoverCurveId = $state<string | null>(null);
	let measureReadout = $state<string | null>(null);
	let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
	let dragActive = $state(false);

	interface MenuItem {
		label: string;
		action: () => void;
		disabled?: boolean;
		separator?: boolean;
	}

	type DragMode = 'none' | 'draw' | 'point' | 'handle' | 'curve' | 'region' | 'pan' | 'measure';

	interface DragState {
		mode: DragMode;
		curveId: string | null;
		pointId: string | null;
		handle: 'in' | 'out' | null;
		startBeat: number;
		startFrequency: number;
		/** every curve's points at the moment the gesture started */
		basePoints: Map<string, CurvePoint[]>;
		/** live preview points per curve, written on every pointer move */
		movedPoints: Map<string, CurvePoint[]>;
		originPointer: { x: number; y: number };
		originStartBeat: number;
		originMin: number;
		originMax: number;
		drawSamples: FlattenedPoint[];
		region: { x0: number; y0: number; x1: number; y1: number } | null;
		measure: { fromBeat: number; fromHz: number } | null;
		joinFirst: string | null;
	}

	const drag: DragState = {
		mode: 'none',
		curveId: null,
		pointId: null,
		handle: null,
		startBeat: 0,
		startFrequency: 440,
		basePoints: new Map(),
		movedPoints: new Map(),
		originPointer: { x: 0, y: 0 },
		originStartBeat: 0,
		originMin: 0,
		originMax: 0,
		drawSamples: [],
		region: null,
		measure: null,
		joinFirst: null
	};

	/** Pointer position and pitch where the gesture began, for 1:1 tracking. */
	let grabBeat = 0;
	let grabFrequency = 440;

	/* ------------------------------------------------------ coordinate helpers */

	function localPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
		const canvas = contentCanvas;
		if (!canvas) return { x: 0, y: 0 };
		const rect = canvas.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function snappedEnabled(modifiers: Modifiers): boolean {
		return session.snapEnabled && !modifiers.ctrl && !modifiers.meta;
	}

	/** Picking radius for a control point. Deliberately generous: a precision
	 * editor should never make the user chase a 3px dot. */
	function pointHitRadius(): number {
		return POINT_HIT_RADIUS_PX;
	}

	/** Only the selected line's points are visible and grabbable. */
	function isCurveSelected(curve: Curve): boolean {
		return session.selectedCurveIds.includes(curve.id);
	}

	/** When the cursor misses every visible control point, grab the nearest one
	 * on the selected line inside a slightly wider catchment. Keeps a hurried
	 * click from falling through to region-select when the user meant a vertex. */
	function nearestHitPoint(current: Track | null, x: number, y: number): PointHit | null {
		if (!current) return null;
		const radius = pointHitRadius() * 1.5;
		let best: PointHit | null = null;
		let bestDistance = Infinity;
		for (const curve of current.curves) {
			if (!isCurveSelected(curve)) continue;
			for (let index = 0; index < curve.points.length; index++) {
				const point = curve.points[index];
				const pixel = pointPixel(point, transform);
				const distance = Math.hypot(pixel.x - x, pixel.y - y);
				if (distance <= radius && distance < bestDistance) {
					best = { curve, point, index, distance };
					bestDistance = distance;
				}
			}
		}
		return best;
	}

	/**
	 * Effective pitch snap for a gesture. Piano mode always lands on real
	 * note frequencies, even when the snap target reads "none": the only ways
	 * off the notes are an explicit detune gesture (Ctrl/Cmd held) or the
	 * global snap switch being off. Frequency mode keeps the user's choice.
	 */
	function effectivePitchSnap(): SnapPitchMode {
		if (settings.snapPitch !== 'none') return settings.snapPitch;
		return settings.pitchMap === 'piano' ? 'note' : 'none';
	}

	function snapBeat(beat: number, modifiers: Modifiers): number {
		if (!snappedEnabled(modifiers)) return beat;
		return snapTime(beat, {
			mode: settings.snapTime,
			timeSignature: session.project.timeSignature,
			customTicks: settings.customSnapTicks
		});
	}

	function snapHz(hz: number, beat: number, modifiers: Modifiers): number {
		if (!snappedEnabled(modifiers)) return hz;
		const mode = effectivePitchSnap();
		if (mode === 'none') return hz;
		const state = resolveMusicalState(session.project, beat);
		return snapFrequency(hz, {
			mode,
			targets: targetsForState(state, findScale(session.project.scales, state.scaleId), {
				minFrequencyHz: settings.minFrequencyHz,
				maxFrequencyHz: settings.maxFrequencyHz
			}),
			referenceHz: state.tuning.referenceFrequencyHz
		});
	}

	function clampHz(hz: number): number {
		return clamp(hz, 8, 22000);
	}

	/* ------------------------------------------------------------- drawing */

	let frameRequested = false;

	function scheduleContentDraw(): void {
		if (frameRequested) return;
		frameRequested = true;
		requestAnimationFrame(() => {
			frameRequested = false;
			drawContent();
		});
	}

	function prepareCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(1, cellWidth);
		const height = Math.max(1, cellHeight);
		if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
		}
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		return ctx;
	}

	function drawBackground(): void {
		const canvas = gridCanvas;
		if (!canvas) return;
		const ctx = prepareCanvas(canvas);
		if (!ctx) return;
		const width = cellWidth;
		const height = cellHeight;
		const window = transform.timeWindow();

		ctx.fillStyle = '#05070b';
		ctx.fillRect(0, 0, width, height);

		if (settings.pitchMap === 'piano') drawNoteLanes(ctx, width);
		else if (settings.showPianoOverlay) drawNoteLanes(ctx, width, 0.3);

		// one horizontal reference line per tuning target, per keyframe span
		for (const segment of targetSegments) {
			const x0 = Math.max(0, transform.timeToX(segment.from));
			const x1 = Math.min(width, transform.timeToX(segment.to));
			if (x1 <= x0) continue;
			for (const target of segment.targets) {
				const y = transform.frequencyToY(target.frequency);
				if (y < 0 || y > height) continue;
				const isTonic = target.degreeIndex === 0;
				ctx.strokeStyle = target.ji
					? isTonic
						? 'rgba(197, 139, 245, 0.36)'
						: 'rgba(197, 139, 245, 0.13)'
					: isTonic
						? 'rgba(77, 163, 255, 0.26)'
						: 'rgba(164, 173, 190, 0.09)';
				ctx.lineWidth = isTonic ? 1.2 : 1;
				ctx.beginPath();
				ctx.moveTo(x0, Math.round(y) + 0.5);
				ctx.lineTo(x1, Math.round(y) + 0.5);
				ctx.stroke();
			}
			if (segment.from > window.from) {
				const x = Math.round(transform.timeToX(segment.from)) + 0.5;
				ctx.strokeStyle = 'rgba(197, 139, 245, 0.5)';
				ctx.setLineDash([4, 3]);
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, height);
				ctx.stroke();
				ctx.setLineDash([]);
			}
		}

		// time grid: bars strongest, then the snap step, then its subdivisions
		const step = timeGridStep(transform.viewport.pixelsPerBeat, 58);
		const subdivision = step / 4;
		const startTick = Math.floor(window.from / subdivision) * subdivision;
		for (let beat = startTick; beat <= window.to + subdivision; beat += subdivision) {
			const x = Math.round(transform.timeToX(beat)) + 0.5;
			if (x < 0 || x > width) continue;
			const isBar = Math.abs(beat % beatsPerBar) < 1e-6;
			const isStep = Math.abs(beat / step - Math.round(beat / step)) < 1e-6;
			if (!isBar && !isStep && subdivision * transform.viewport.pixelsPerBeat < 6) continue;
			ctx.strokeStyle = isBar
				? 'rgba(59, 70, 88, 0.85)'
				: isStep
					? 'rgba(44, 52, 68, 0.65)'
					: 'rgba(33, 39, 52, 0.45)';
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
		}

		if (session.project.loop.enabled) {
			const x0 = transform.timeToX(session.project.loop.start);
			const x1 = transform.timeToX(session.project.loop.end);
			ctx.fillStyle = 'rgba(77, 163, 255, 0.06)';
			ctx.fillRect(x0, 0, Math.max(0, x1 - x0), height);
		}

		ctx.font = '10px ui-monospace, monospace';
		ctx.textBaseline = 'top';
		for (const marker of session.project.markers) {
			const x = Math.round(transform.timeToX(marker.time)) + 0.5;
			if (x < -40 || x > width + 40) continue;
			ctx.strokeStyle = 'rgba(232, 163, 61, 0.5)';
			ctx.setLineDash([2, 4]);
			ctx.beginPath();
			ctx.moveTo(x, 0);
			ctx.lineTo(x, height);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.fillStyle = 'rgba(232, 163, 61, 0.9)';
			ctx.fillText(marker.label, x + 4, 4);
		}

		if (isMasterSelected()) drawMusicalStateLane(ctx, width);
	}

	function drawNoteLanes(ctx: CanvasRenderingContext2D, width: number, alpha = 1): void {
		const window = transform.frequencyWindow();
		const area = transform.pitchAreaHeight;
		const semitonePixels = transform.pixelsPerOctave() / 12;
		if (semitonePixels < 5) return;

		const lowestMidi = Math.floor(Math.log2(window.min / 440) * 12 + 69);
		const highestMidi = Math.ceil(Math.log2(window.max / 440) * 12 + 69);

		// shade the five accidental lanes so octaves read at a glance
		ctx.fillStyle = `rgba(255, 255, 255, ${0.016 * alpha})`;
		for (let midi = lowestMidi; midi <= highestMidi; midi++) {
			const pitchClass = ((midi % 12) + 12) % 12;
			if (![1, 3, 6, 8, 10].includes(pitchClass)) continue;
			const y0 = transform.frequencyToY(440 * Math.pow(2, (midi - 69) / 12));
			const y1 = transform.frequencyToY(440 * Math.pow(2, (midi + 1 - 69) / 12));
			if (y1 < 0 || y0 > area) continue;
			ctx.fillRect(0, Math.min(y0, y1), width, Math.abs(y1 - y0));
		}

		ctx.lineWidth = 1;
		for (let midi = lowestMidi; midi <= highestMidi; midi++) {
			const y = Math.round(transform.frequencyToY(440 * Math.pow(2, (midi - 69) / 12))) + 0.5;
			if (y < 0 || y > area) continue;
			const pitchClass = ((midi % 12) + 12) % 12;
			ctx.strokeStyle =
				pitchClass === 0
					? `rgba(164, 173, 190, ${0.26 * alpha})`
					: `rgba(164, 173, 190, ${0.075 * alpha})`;
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(width, y);
			ctx.stroke();
		}
	}

	function drawMusicalStateLane(ctx: CanvasRenderingContext2D, width: number): void {
		ctx.fillStyle = 'rgba(197, 139, 245, 0.10)';
		ctx.fillRect(0, 0, width, 18);
		ctx.fillStyle = 'rgba(197, 139, 245, 0.85)';
		ctx.textBaseline = 'top';
		ctx.fillText('MUSICAL STATE', 6, 4);
		for (const frame of session.project.master.musicalState) {
			const x = transform.timeToX(frame.time);
			if (x < -20 || x > width + 20) continue;
			ctx.fillStyle = '#c58bf5';
			ctx.beginPath();
			ctx.moveTo(x, 3);
			ctx.lineTo(x + 5, 9);
			ctx.lineTo(x, 15);
			ctx.lineTo(x - 5, 9);
			ctx.closePath();
			ctx.fill();
		}
	}

	function toPixels(points: CurvePoint[]): { id: string; x: number; y: number }[] {
		return points.map((point) => {
			const pixel = pointPixel(point, transform);
			return { id: point.id, x: pixel.x, y: pixel.y };
		});
	}

	function strokePolyline(ctx: CanvasRenderingContext2D, points: { x: number; y: number }[]): void {
		if (points.length === 0) return;
		ctx.beginPath();
		ctx.moveTo(points[0].x, points[0].y);
		for (let index = 1; index < points.length; index++)
			ctx.lineTo(points[index].x, points[index].y);
		ctx.stroke();
	}

	function drawContent(): void {
		const canvas = contentCanvas;
		if (!canvas) return;
		const ctx = prepareCanvas(canvas);
		if (!ctx) return;
		const width = cellWidth;
		const height = cellHeight;

		geometryCache.begin(viewportKey(transform, session.revision));

		if (isMasterSelected()) {
			drawMasterLanes(ctx, width, height);
		} else if (track) {
			drawTrackCurves(ctx, track, width);
		}

		if (drag.mode === 'draw' && drag.drawSamples.length > 1) {
			ctx.strokeStyle = accent;
			ctx.globalAlpha = 0.9;
			ctx.lineWidth = 2;
			strokePolyline(
				ctx,
				drag.drawSamples.map((sample) => ({
					x: transform.timeToX(sample.time),
					y: transform.frequencyToY(sample.frequency)
				}))
			);
			ctx.globalAlpha = 1;
		}

		if (drag.mode === 'region' && drag.region) {
			const { x0, y0, x1, y1 } = drag.region;
			ctx.fillStyle = 'rgba(77, 163, 255, 0.10)';
			ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
			ctx.strokeStyle = 'rgba(77, 163, 255, 0.7)';
			ctx.setLineDash([3, 2]);
			ctx.strokeRect(
				Math.round(Math.min(x0, x1)) + 0.5,
				Math.round(Math.min(y0, y1)) + 0.5,
				Math.round(Math.abs(x1 - x0)),
				Math.round(Math.abs(y1 - y0))
			);
			ctx.setLineDash([]);
		}

		if (drag.mode === 'measure' && drag.measure && cursor) {
			ctx.strokeStyle = 'rgba(62, 207, 142, 0.9)';
			ctx.lineWidth = 1.5;
			ctx.setLineDash([3, 2]);
			ctx.beginPath();
			ctx.moveTo(
				transform.timeToX(drag.measure.fromBeat),
				transform.frequencyToY(drag.measure.fromHz)
			);
			ctx.lineTo(transform.timeToX(cursor.beat), transform.frequencyToY(cursor.frequency));
			ctx.stroke();
			ctx.setLineDash([]);
		}

		const playheadX = Math.round(transform.timeToX(session.playhead)) + 0.5;
		if (playheadX >= 0 && playheadX <= width) {
			ctx.strokeStyle = 'rgba(240, 243, 248, 0.9)';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(playheadX, 0);
			ctx.lineTo(playheadX, height);
			ctx.stroke();
		}
	}

	function drawTrackCurves(ctx: CanvasRenderingContext2D, track: Track, width: number): void {
		const selectedCurves = new Set(session.selectedCurveIds);
		const selectedPoints = new Set(session.selectedPointIds);

		for (const curve of track.curves) {
			const previewPoints = drag.movedPoints.get(curve.id);
			const pixels = previewPoints
				? toPixels(previewPoints)
				: geometryCache.get(curve, transform).points.map((point) => ({
						id: '',
						x: point.x,
						y: point.y
					}));
			if (pixels.length === 0) continue;

			const isSelected = selectedCurves.has(curve.id);
			const isHovered = hoverCurveId === curve.id;
			const color = curveColorFor(track, curve);

			ctx.save();
			if (curve.muted) ctx.globalAlpha = 0.35;

			if (isHovered && !isSelected) {
				ctx.strokeStyle = 'rgba(240, 243, 248, 0.16)';
				ctx.lineWidth = 6;
				strokePolyline(ctx, pixels);
			}

			ctx.strokeStyle = isSelected ? '#f0f3f8' : color;
			ctx.lineWidth = isSelected ? 2.6 : isHovered ? 2.2 : 1.7;
			ctx.lineJoin = 'round';
			ctx.lineCap = 'round';
			if (previewPoints) ctx.setLineDash([5, 3]);
			strokePolyline(ctx, pixels);
			ctx.setLineDash([]);
			ctx.restore();

			// control points belong to the selected line only, so a track with
			// several lines never turns into a field of indistinguishable dots
			if (!isSelected) continue;

			const first = pixels[0];
			const last = pixels[pixels.length - 1];
			ctx.fillStyle = '#f0f3f8';
			ctx.beginPath();
			ctx.arc(first.x, first.y, 2.6, 0, Math.PI * 2);
			ctx.arc(last.x, last.y, 2.6, 0, Math.PI * 2);
			ctx.fill();

			const rendered = previewPoints ?? curve.points;
			for (const point of rendered) {
				const pixel = pointPixel(point, transform);
				if (pixel.x < -20 || pixel.x > width + 20) continue;
				const isActive = selectedPoints.has(point.id);
				const isHoveredPoint = hoverPointId === point.id;
				ctx.beginPath();
				ctx.arc(pixel.x, pixel.y, isActive ? 4.4 : isHoveredPoint ? 4 : 3, 0, Math.PI * 2);
				ctx.fillStyle = isActive ? '#f0f3f8' : '#05070b';
				ctx.fill();
				ctx.strokeStyle = isActive ? '#4da3ff' : '#f0f3f8';
				ctx.lineWidth = 1.5;
				ctx.stroke();
				if (isActive) drawHandles(ctx, point, pixel);
			}
		}
	}

	function drawHandles(
		ctx: CanvasRenderingContext2D,
		point: CurvePoint,
		pixel: { x: number; y: number }
	): void {
		const handles: { handle: { dt: number; df: number } }[] = [];
		const handleBeats = HANDLE_PIXELS / Math.max(transform.viewport.pixelsPerBeat, 0.001);
		if (point.inHandle) handles.push({ handle: point.inHandle });
		else handles.push({ handle: { dt: -handleBeats, df: 0 } });
		if (point.outHandle) handles.push({ handle: point.outHandle });
		else handles.push({ handle: { dt: handleBeats, df: 0 } });

		for (const entry of handles) {
			const frequency = point.frequency + entry.handle.df;
			const handlePosition = {
				x: transform.timeToX(point.time + entry.handle.dt),
				y: transform.frequencyToY(frequency)
			};
			ctx.strokeStyle = 'rgba(240, 243, 248, 0.4)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(pixel.x, pixel.y);
			ctx.lineTo(handlePosition.x, handlePosition.y);
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(handlePosition.x, handlePosition.y, 3, 0, Math.PI * 2);
			ctx.fillStyle = '#4da3ff';
			ctx.fill();
		}
	}

	function drawMasterLanes(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		const lanes = session.project.master.automationLanes;
		if (lanes.length === 0) return;
		const window = transform.timeWindow();
		const laneHeight = Math.min(64, Math.max(28, (height - 24) / Math.max(lanes.length, 1)));
		ctx.font = '10px ui-monospace, monospace';
		ctx.textBaseline = 'top';

		lanes.forEach((lane, index) => {
			const top = 24 + index * laneHeight;
			if (top > height) return;
			ctx.fillStyle = 'rgba(22, 26, 35, 0.55)';
			ctx.fillRect(0, top, width, laneHeight - 2);
			ctx.fillStyle = 'rgba(164, 173, 190, 0.7)';
			ctx.fillText(lane.target, 6, top + 2);

			const samples = flattenLane(lane, window.from, window.to, Math.min(320, Math.round(width)));
			if (samples.length < 2) return;
			let min = Infinity;
			let max = -Infinity;
			for (const sample of samples) {
				min = Math.min(min, sample.value);
				max = Math.max(max, sample.value);
			}
			const span = max - min || 1;
			ctx.strokeStyle = lane.enabled ? accent : 'rgba(164, 173, 190, 0.35)';
			ctx.lineWidth = 1.6;
			ctx.beginPath();
			samples.forEach((sample, sampleIndex) => {
				const x = transform.timeToX(sample.time);
				const y = top + laneHeight - 6 - ((sample.value - min) / span) * (laneHeight - 20);
				if (sampleIndex === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			});
			ctx.stroke();
		});
	}

	/* ---------------------------------------------------------- interactions */

	function findCurveHit(x: number, y: number) {
		const current = track;
		if (!current) return null;
		const geometries = current.curves.map((curve) => ({
			curve,
			geometry: geometryCache.get(curve, transform)
		}));
		return hitTestCurves(geometries, x, y, 8);
	}

	/** Nearest line under the cursor other than `exceptCurveId`, for drop targets. */
	function findOtherCurveHit(x: number, y: number, exceptCurveId: string) {
		const current = track;
		if (!current) return null;
		const geometries = current.curves
			.filter((curve) => curve.id !== exceptCurveId)
			.map((curve) => ({ curve, geometry: geometryCache.get(curve, transform) }));
		return hitTestCurves(geometries, x, y, 8);
	}

	function beginGesture(x: number, y: number, beat: number, frequency: number): void {
		drag.originPointer = { x, y };
		drag.originStartBeat = session.viewport.startBeat;
		drag.originMin = session.viewport.minFrequencyHz;
		drag.originMax = session.viewport.maxFrequencyHz;
		drag.basePoints.clear();
		drag.movedPoints.clear();
		drag.drawSamples = [];
		drag.region = null;
		drag.measure = null;
		grabBeat = beat;
		grabFrequency = frequency;
	}

	function onPointerDown(event: PointerEvent) {
		const canvas = contentCanvas;
		if (!canvas) return;
		menu = null;
		const { x, y } = localPoint(event);
		const modifiers = modifiersFrom(event);
		const beat = transform.xToTime(x);
		const frequency = transform.yToFrequency(y);
		const current = track;

		const pointHit = current
			? hitTestPoints(current.curves, transform, x, y, pointHitRadius(), isCurveSelected)
			: null;
		const handleHit = current
			? hitTestHandles(
					current.curves,
					new Set(session.selectedPointIds),
					transform,
					x,
					y,
					HANDLE_RADIUS_PX
				)
			: null;
		canvas.setPointerCapture(event.pointerId);
		beginGesture(x, y, beat, frequency);

		// middle and right buttons always pan, whatever tool is active
		if (event.button === 1 || event.button === 2 || session.activeTool === 'pan') {
			drag.mode = 'pan';
			dragActive = true;
			return;
		}

		const tool = session.activeTool; // The pen tool always draws; select/point/eraser fall back to the nearest
		// control point so a slightly-off click still lands on a vertex.
		const nearestPoint = tool === 'draw' ? null : nearestHitPoint(current, x, y);
		const hit = pointHit ?? nearestPoint;

		if (handleHit && (tool === 'select' || tool === 'point')) {
			drag.mode = 'handle';
			drag.curveId = handleHit.curve.id;
			drag.pointId = handleHit.point.id;
			drag.handle = handleHit.handle;
			drag.basePoints.set(handleHit.curve.id, handleHit.curve.points);
			dragActive = true;
			return;
		}

		if (hit && current) {
			if (tool === 'eraser') {
				const next = hit.curve.points.filter((point: CurvePoint) => point.id !== hit.point.id);
				if (next.length >= 2) {
					setCurvePoints(current.id, hit.curve.id, next, 'Delete point');
				} else {
					setStatus('A curve keeps at least two points');
				}
				return;
			}
			if (tool === 'select' || tool === 'point' || tool === 'draw') {
				const already = session.selectedPointIds.includes(hit.point.id);
				const nextSelection = modifiers.shift
					? already
						? session.selectedPointIds.filter((id) => id !== hit.point.id)
						: [...session.selectedPointIds, hit.point.id]
					: already && session.selectedPointIds.length > 1
						? session.selectedPointIds
						: [hit.point.id];
				selectCurves([hit.curve.id]);
				selectPoints(nextSelection);
				drag.mode = 'point';
				drag.curveId = hit.curve.id;
				drag.pointId = hit.point.id;
				drag.startBeat = hit.point.time;
				drag.startFrequency = hit.point.frequency;
				for (const entry of current.curves) drag.basePoints.set(entry.id, entry.points);
				dragActive = true;
				return;
			}
		}

		const curveHit = findCurveHit(x, y);
		if (curveHit && current) {
			if (tool === 'eraser') {
				selectCurves([curveHit.curve.id]);
				deleteSelectedCurves();
				return;
			}
			if (tool === 'split') {
				splitCurve(current.id, curveHit.curve.id, snapBeat(curveHit.time, modifiers));
				setStatus('Curve split');
				return;
			}
			if (tool === 'join') {
				if (!drag.joinFirst) {
					drag.joinFirst = curveHit.curve.id;
					selectCurves([curveHit.curve.id]);
					setStatus('Select the adjacent curve to join');
				} else if (drag.joinFirst !== curveHit.curve.id) {
					joinCurves(current.id, drag.joinFirst, curveHit.curve.id);
					drag.joinFirst = null;
					setStatus('Curves joined');
				}
				return;
			}
			selectCurves(
				modifiers.shift
					? [...new Set([...session.selectedCurveIds, curveHit.curve.id])]
					: [curveHit.curve.id]
			);
			selectPoints([]);
			drag.mode = 'curve';
			drag.curveId = curveHit.curve.id;
			drag.startBeat = curveHit.time;
			drag.startFrequency = curveHit.frequency;
			for (const entry of current.curves) drag.basePoints.set(entry.id, entry.points);
			dragActive = true;
			return;
		}

		// empty space
		if (tool === 'draw') {
			if (!current) {
				setStatus('Select a track tab before drawing a voice path');
				return;
			}
			drag.mode = 'draw';
			drag.drawSamples = [
				{
					time: Math.max(0, snapBeat(beat, modifiers)),
					frequency: clampHz(snapHz(frequency, beat, modifiers))
				}
			];
			dragActive = true;
			scheduleContentDraw();
			return;
		}
		if (tool === 'measure') {
			drag.mode = 'measure';
			drag.measure = { fromBeat: beat, fromHz: frequency };
			dragActive = true;
			return;
		}
		if (tool === 'split' || tool === 'join') return;

		drag.mode = 'region';
		drag.region = { x0: x, y0: y, x1: x, y1: y };
		if (!modifiers.shift) {
			selectCurves([]);
			selectPoints([]);
		}
		dragActive = true;
	}

	function applyPointDrag(modifiers: Modifiers): void {
		const pointId = drag.pointId;
		const curveId = drag.curveId;
		const current = cursor;
		if (!pointId || !curveId || !current) return;
		const base = drag.basePoints.get(curveId);
		const grabbed = base?.find((point) => point.id === pointId);
		if (!grabbed) return;

		const rawBeat = grabbed.time + (current.beat - grabBeat);
		const snappedBeat = Math.max(0, snapBeat(rawBeat, modifiers));
		const rawFrequency = grabbed.frequency * (current.frequency / grabFrequency);
		const snappedFrequency = clampHz(snapHz(rawFrequency, snappedBeat, modifiers));
		const deltaBeats = snappedBeat - grabbed.time;
		const ratio = snappedFrequency / grabbed.frequency;

		const selection = new Set(
			session.selectedPointIds.length ? session.selectedPointIds : [pointId]
		);
		drag.movedPoints.set(
			curveId,
			(base ?? []).map((point) =>
				selection.has(point.id)
					? {
							...point,
							time: Math.max(0, point.time + deltaBeats),
							frequency: clampHz(point.frequency * ratio)
						}
					: point
			)
		);
	}

	function applyHandleDrag(): void {
		const pointId = drag.pointId;
		const curveId = drag.curveId;
		const current = cursor;
		if (!pointId || !curveId || !current) return;
		const base = drag.basePoints.get(curveId);
		const point = base?.find((entry) => entry.id === pointId);
		if (!point) return;
		const handle = { dt: current.beat - point.time, df: current.frequency - point.frequency };
		drag.movedPoints.set(
			curveId,
			(base ?? []).map((entry) =>
				entry.id === pointId
					? {
							...entry,
							interpolation: 'bezier' as const,
							inHandle: drag.handle === 'in' ? handle : entry.inHandle,
							outHandle: drag.handle === 'out' ? handle : entry.outHandle
						}
					: entry
			)
		);
	}

	function applyCurveDrag(modifiers: Modifiers): void {
		const current = cursor;
		if (!current) return;
		const rawBeat = drag.startBeat + (current.beat - grabBeat);
		const snappedBeat = Math.max(0, snapBeat(rawBeat, modifiers));
		const rawFrequency = drag.startFrequency * (current.frequency / grabFrequency);
		const snappedFrequency = clampHz(snapHz(rawFrequency, snappedBeat, modifiers));
		const deltaBeats = snappedBeat - drag.startBeat;
		const ratio = snappedFrequency / drag.startFrequency;

		const selection = new Set(
			session.selectedCurveIds.length ? session.selectedCurveIds : [drag.curveId ?? '']
		);
		for (const [curveId, points] of drag.basePoints) {
			if (!selection.has(curveId)) continue;
			drag.movedPoints.set(
				curveId,
				points.map((point) => ({
					...point,
					time: Math.max(0, point.time + deltaBeats),
					frequency: clampHz(point.frequency * ratio)
				}))
			);
		}
	}

	function onPointerMove(event: PointerEvent) {
		const canvas = contentCanvas;
		if (!canvas) return;
		const { x, y } = localPoint(event);
		const modifiers = modifiersFrom(event);
		const beat = transform.xToTime(x);
		const frequency = transform.yToFrequency(y);
		cursor = { beat, frequency };

		if (drag.mode === 'none') {
			const current = track;
			const pointHit = current
				? hitTestPoints(current.curves, transform, x, y, POINT_IDLE_RADIUS_PX, isCurveSelected)
				: null;
			const nextHoverPoint = pointHit?.point.id ?? null;
			if (nextHoverPoint !== hoverPointId) hoverPointId = nextHoverPoint;
			const curveHit = pointHit ? null : findCurveHit(x, y);
			const nextHoverCurve = curveHit?.curve.id ?? null;
			if (nextHoverCurve !== hoverCurveId) hoverCurveId = nextHoverCurve;
			if (current) scheduleContentDraw();
			return;
		}

		switch (drag.mode) {
			case 'pan': {
				const dx = x - drag.originPointer.x;
				const dy = y - drag.originPointer.y;
				updateViewport((viewport) => ({
					...viewport,
					startBeat: Math.max(0, drag.originStartBeat - dx / viewport.pixelsPerBeat)
				}));
				const span = drag.originMax - drag.originMin;
				const shift = (dy / Math.max(cellHeight, 1)) * span;
				updateViewport((viewport) => ({
					...viewport,
					minFrequencyHz: clamp(drag.originMin + shift, 8, 20000),
					maxFrequencyHz: clamp(drag.originMax + shift, 20, 24000)
				}));
				break;
			}
			case 'point':
				applyPointDrag(modifiers);
				break;
			case 'handle':
				applyHandleDrag();
				break;
			case 'curve':
				applyCurveDrag(modifiers);
				break;
			case 'draw':
				drag.drawSamples.push({ time: Math.max(0, beat), frequency: clampHz(frequency) });
				break;
			case 'region':
				if (drag.region) drag.region = { ...drag.region, x1: x, y1: y };
				break;
			case 'measure':
				if (drag.measure) {
					const beats = beat - drag.measure.fromBeat;
					const cents = centsBetween(drag.measure.fromHz, frequency);
					measureReadout = `${beats >= 0 ? '+' : '−'}${Math.abs(beats).toFixed(3)} bt · ${
						cents >= 0 ? '+' : '−'
					}${Math.abs(cents).toFixed(0)}¢`;
				}
				break;
		}
		scheduleContentDraw();
	}

	function onPointerUp(event: PointerEvent) {
		const canvas = contentCanvas;
		if (!canvas) return;
		canvas.releasePointerCapture(event.pointerId);
		const modifiers = modifiersFrom(event);
		const current = track;
		const { x, y } = localPoint(event);

		switch (drag.mode) {
			case 'point': {
				const points = drag.curveId ? drag.movedPoints.get(drag.curveId) : undefined;
				const movedPoint = points?.find((point) => point.id === drag.pointId);
				if (points && drag.curveId && current) {
					setCurvePoints(current.id, drag.curveId, points, 'Move point');
				}
				// dropping a point onto another line branches that line here and links
				// the two, so the junction follows this point from now on
				if (current && drag.curveId && drag.pointId && movedPoint) {
					const target = findOtherCurveHit(x, y, drag.curveId);
					if (target) {
						attachPointToCurve(current.id, target.curve.id, {
							curveId: drag.curveId,
							pointId: drag.pointId,
							time: movedPoint.time,
							frequency: movedPoint.frequency
						});
						setStatus('Linked the two lines at this point');
					}
				}
				break;
			}
			case 'handle': {
				const points = drag.curveId ? drag.movedPoints.get(drag.curveId) : undefined;
				if (points && drag.curveId && current) {
					setCurvePoints(current.id, drag.curveId, points, 'Adjust curvature');
				}
				break;
			}
			case 'curve': {
				if (current) {
					for (const [curveId, points] of drag.movedPoints) {
						setCurvePoints(current.id, curveId, points, 'Move curve');
					}
				}
				break;
			}
			case 'draw':
				commitDraw(modifiers);
				break;
			case 'region':
				commitRegion();
				break;
		}

		drag.mode = 'none';
		drag.curveId = null;
		drag.pointId = null;
		drag.handle = null;
		drag.region = null;
		drag.measure = null;
		drag.drawSamples = [];
		drag.movedPoints.clear();
		dragActive = false;
		measureReadout = null;
		sealHistory();
		scheduleContentDraw();
		drawBackground();
	}

	function commitDraw(modifiers: Modifiers): void {
		const current = track;
		if (!current || drag.drawSamples.length < 2) return;
		const logScale = Math.max(transform.pixelsPerOctave(), 4);
		let simplified = simplifyPoints(drag.drawSamples, 3, {
			timeScale: transform.viewport.pixelsPerBeat,
			logScale
		});
		if (simplified.length < 2) {
			simplified = [drag.drawSamples[0], drag.drawSamples[drag.drawSamples.length - 1]];
		}

		const points: CurvePoint[] = [];
		for (const sample of simplified) {
			const time = Math.max(0, snapBeat(sample.time, modifiers));
			const frequency = clampHz(snapHz(sample.frequency, time, modifiers));
			const previous = points[points.length - 1];
			if (previous && Math.abs(previous.time - time) < 1e-6) continue;
			points.push(createPoint(time, frequency, 'smooth'));
		}
		if (points.length < 2) {
			setStatus('Draw a longer gesture to create a voice path');
			return;
		}

		const curve: Curve = { ...createCurve(points[0].time, points[0].frequency), points };
		addCurveToTrack(current.id, curve);
		setStatus(`Created a ${points.length}-point voice path`);
	}

	function commitRegion(): void {
		const current = track;
		if (!current || !drag.region) return;
		const region = drag.region;
		const minX = Math.min(region.x0, region.x1);
		const maxX = Math.max(region.x0, region.x1);
		const minY = Math.min(region.y0, region.y1);
		const maxY = Math.max(region.y0, region.y1);

		const curveIds: string[] = [];
		const pointIds: string[] = [];
		for (const curve of current.curves) {
			for (const point of curve.points) {
				const pixel = pointPixel(point, transform);
				if (pixel.x >= minX && pixel.x <= maxX && pixel.y >= minY && pixel.y <= maxY) {
					if (!curveIds.includes(curve.id)) curveIds.push(curve.id);
					pointIds.push(point.id);
				}
			}
		}
		selectCurves(curveIds);
		selectPoints(pointIds);
		if (curveIds.length || pointIds.length) {
			setStatus(`${curveIds.length} curve(s), ${pointIds.length} point(s) selected`);
		}
	}

	function onDoubleClick(event: MouseEvent) {
		const current = track;
		if (!current) return;
		const { x, y } = localPoint(event);
		const modifiers = modifiersFrom(event);
		const pointHit = hitTestPoints(
			current.curves,
			transform,
			x,
			y,
			POINT_IDLE_RADIUS_PX + 1,
			isCurveSelected
		);
		if (pointHit) {
			const order = ['linear', 'smooth', 'bezier'] as const;
			const next = order[(order.indexOf(pointHit.point.interpolation) + 1) % order.length];
			setCurvePoints(
				current.id,
				pointHit.curve.id,
				pointHit.curve.points.map((point) =>
					point.id === pointHit.point.id ? { ...point, interpolation: next } : point
				),
				'Point interpolation'
			);
			setStatus(`Interpolation: ${next}`);
			return;
		}
		const curveHit = findCurveHit(x, y);
		if (curveHit) {
			addPointAt(current.id, curveHit.curve.id, snapBeat(curveHit.time, modifiers));
			return;
		}
		setStatus('Drag to draw a pitch trajectory, or press P for the pen tool');
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		const current = track;
		const { x, y } = localPoint(event);
		const modifiers = modifiersFrom(event);
		const beat = Math.max(0, transform.xToTime(x));
		const items: MenuItem[] = [];

		const pointHit = current
			? hitTestPoints(current.curves, transform, x, y, POINT_IDLE_RADIUS_PX + 1, isCurveSelected)
			: null;
		const curveHit = pointHit ? null : findCurveHit(x, y);

		if (pointHit && current) {
			selectCurves([pointHit.curve.id]);
			selectPoints([pointHit.point.id]);
			const curve = pointHit.curve;
			const point = pointHit.point;
			items.push(
				{
					label: 'Cycle interpolation',
					action: () => {
						const order = ['linear', 'smooth', 'bezier'] as const;
						const next = order[(order.indexOf(point.interpolation) + 1) % order.length];
						setCurvePoints(
							current.id,
							curve.id,
							curve.points.map((entry) =>
								entry.id === point.id ? { ...entry, interpolation: next } : entry
							),
							'Point interpolation'
						);
					}
				},
				{
					label: 'Branch from here',
					action: () => {
						branchCurveAtPoint(current.id, curve.id, point.id);
						setStatus('Branched a new voice from this point — both start in phase');
					}
				},
				{
					label: 'Delete point',
					action: () => {
						const next = curve.points.filter((entry) => entry.id !== point.id);
						if (next.length >= 2) setCurvePoints(current.id, curve.id, next, 'Delete point');
						else setStatus('A curve keeps at least two points');
					}
				}
			);
		} else if (curveHit && current) {
			selectCurves([curveHit.curve.id]);
			items.push(
				{
					label: 'Add point here',
					action: () =>
						addPointAt(current.id, curveHit.curve.id, snapBeat(curveHit.time, modifiers))
				},
				{
					label: 'Split curve here',
					action: () =>
						splitCurve(current.id, curveHit.curve.id, snapBeat(curveHit.time, modifiers))
				},
				{
					label: 'Reverse direction',
					action: () =>
						updateCurve(
							current.id,
							curveHit.curve.id,
							{
								points: [...curveHit.curve.points]
									.reverse()
									.map((point) => ({ ...point, time: point.time }))
							},
							'Reverse curve'
						)
				},
				{ label: 'Delete curve', separator: true, action: () => deleteSelectedCurves() }
			);
		} else {
			items.push(
				{ label: 'Set loop start here', action: () => setLoop({ start: beat, enabled: true }) },
				{ label: 'Set loop end here', action: () => setLoop({ end: beat, enabled: true }) },
				{
					label: 'Add marker here',
					action: () => addMarkerAt(beat, `Marker ${session.project.markers.length + 1}`)
				}
			);
		}

		menu = { x, y, items };
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const { x, y } = localPoint(event);
		const beat = transform.xToTime(x);
		const frequency = transform.yToFrequency(y);

		if (event.ctrlKey || event.metaKey) {
			updateViewport((viewport) =>
				event.shiftKey
					? zoomFrequencyAt(viewport, event.deltaY < 0 ? 1.15 : 1 / 1.15, frequency)
					: zoomTimeAt(viewport, event.deltaY < 0 ? 1.2 : 1 / 1.2, beat)
			);
			return;
		}
		if (event.altKey) {
			updateViewport((viewport) =>
				zoomFrequencyAt(viewport, event.deltaY < 0 ? 1.15 : 1 / 1.15, frequency)
			);
			return;
		}
		if (event.shiftKey) {
			updateViewport((viewport) => ({
				...viewport,
				startBeat: Math.max(0, viewport.startBeat + event.deltaY / viewport.pixelsPerBeat)
			}));
			return;
		}
		updateViewport((viewport) => panFrequency(viewport, event.deltaY / Math.max(cellHeight, 1)));
	}

	/* ----------------------------------------------------------- readouts */

	const cursorReadout = $derived.by(() => {
		if (!cursor) return null;
		const nearestNote = snapToNote(cursor.frequency, 440);
		const state = resolveMusicalState(session.project, cursor.beat);
		const targets = targetsForState(state, findScale(session.project.scales, state.scaleId), {
			minFrequencyHz: session.project.editorSettings.minFrequencyHz,
			maxFrequencyHz: session.project.editorSettings.maxFrequencyHz
		});
		let target: PitchTarget | null = null;
		let best = Infinity;
		for (const candidate of targets) {
			const distance = Math.abs(Math.log2(candidate.frequency / cursor.frequency));
			if (distance < best) {
				best = distance;
				target = candidate;
			}
		}
		return {
			beat: cursor.beat,
			seconds: (cursor.beat * 60) / session.project.tempo,
			hertz: cursor.frequency,
			note: hzToNoteName(cursor.frequency),
			cents: centsBetween(nearestNote, cursor.frequency),
			target
		};
	});

	const selectedPoint = $derived.by(() => {
		const current = track;
		if (!current || session.selectedPointIds.length !== 1) return null;
		const id = session.selectedPointIds[0];
		for (const curve of current.curves) {
			const point = curve.points.find((entry) => entry.id === id);
			if (point) return { curveId: curve.id, point };
		}
		return null;
	});

	function setSelectedPoint(patch: Partial<CurvePoint>): void {
		const current = track;
		const selected = selectedPoint;
		if (!current || !selected) return;
		setCurvePoints(
			current.id,
			selected.curveId,
			(current.curves.find((curve) => curve.id === selected.curveId)?.points ?? []).map((point) =>
				point.id === selected.point.id ? { ...point, ...patch } : point
			),
			'Edit point'
		);
	}

	/* -------------------------------------------------------------- effects */

	// the canvas cell owns the viewport size
	$effect(() => {
		const width = Math.round(cellWidth);
		const height = Math.round(cellHeight);
		if (width < 2 || height < 2) return;
		if (session.viewport.width === width && session.viewport.height === height) return;
		updateViewport((viewport) => ({ ...resize(viewport, width, height), rulerHeight: 0 }));
	});

	// Both draws read exactly what they need, so those reads are the effects'
	// dependencies; the background repaints far less often than the content
	// layer because it never reads selection or hover state.
	$effect(() => {
		drawBackground();
	});

	$effect(() => {
		drawContent();
	});
</script>

<div class="editor">
	<div class="corner label">{settings.pitchMap === 'piano' ? 'Note' : 'Hz'}</div>
	<div class="ruler-cell">
		<TimelineRuler
			{transform}
			playhead={session.playhead}
			tempo={session.project.tempo}
			markers={session.project.markers}
			loop={session.project.loop}
			{beatsPerBar}
			width={cellWidth}
			height={RULER_HEIGHT}
			onScrub={(beat) => seek(beat)}
		/>
	</div>
	<div class="axis-cell">
		<FrequencyRuler {transform} targets={playheadTargets} width={AXIS_WIDTH} height={cellHeight} />
	</div>
	<div
		class="canvas-cell"
		class:is-dragging={dragActive}
		bind:clientWidth={cellWidth}
		bind:clientHeight={cellHeight}
	>
		<canvas bind:this={gridCanvas} class="layer" style="width:{cellWidth}px;height:{cellHeight}px"
		></canvas>
		<canvas
			bind:this={contentCanvas}
			class="layer is-interactive"
			style="width:{cellWidth}px;height:{cellHeight}px"
			aria-label="Pitch curve editor. Drag to draw a voice path, click to select, double-click a curve to add a point."
			tabindex="0"
			onpointerdown={onPointerDown}
			onpointermove={onPointerMove}
			onpointerup={onPointerUp}
			onpointercancel={onPointerUp}
			onwheel={onWheel}
			ondblclick={onDoubleClick}
			oncontextmenu={onContextMenu}
		></canvas>

		{#if menu}
			<div class="menu" style="left:{menu.x}px; top:{menu.y}px" role="menu">
				{#each menu.items as item (item.label)}
					{#if item.separator}<div class="menu-sep"></div>{/if}
					<button
						type="button"
						role="menuitem"
						class="menu-item"
						disabled={item.disabled}
						onclick={() => {
							item.action();
							menu = null;
						}}
					>
						{item.label}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="context-bar">
		<div class="context-left">
			<SegmentedControl
				ariaLabel="Pitch map"
				size="sm"
				value={settings.pitchMap}
				segments={[
					{ value: 'piano', label: 'Piano' },
					{ value: 'frequency', label: 'Frequency' }
				]}
				onchange={(value) => updateEditorSettings({ pitchMap: value as PitchMap })}
			/>
			{#if settings.pitchMap === 'frequency'}
				<SegmentedControl
					ariaLabel="Frequency projection"
					size="sm"
					value={settings.frequencyProjection}
					segments={[
						{ value: 'logarithmic', label: 'Log' },
						{ value: 'linear-hz', label: 'Linear Hz' }
					]}
					onchange={(value) =>
						updateEditorSettings({ frequencyProjection: value as FrequencyProjection })}
				/>
				<label class="toggle">
					<input
						type="checkbox"
						checked={settings.showPianoOverlay}
						onchange={(event) =>
							updateEditorSettings({ showPianoOverlay: event.currentTarget.checked })}
					/>
					<span>Piano overlay</span>
				</label>
			{/if}
			<span class="hint"
				>Click a line to edit its points · drag a point onto another line to link them · Ctrl/Cmd
				detunes · Alt zooms pitch · Shift scrolls time · N snaps to note Hz · Root {rootLabel}</span
			>
		</div>

		<div class="context-right num">
			{#if measureReadout}
				<span class="measure">{measureReadout}</span>
			{/if}
			{#if cursorReadout}
				<span title="Cursor beat">bt {cursorReadout.beat.toFixed(3)}</span>
				<span title="Cursor time">{cursorReadout.seconds.toFixed(3)}s</span>
				<span title="Cursor frequency">{formatHz(cursorReadout.hertz)}</span>
				<span title="Nearest 12-TET note">
					{cursorReadout.note}{cursorReadout.cents >= 0 ? '+' : '−'}{Math.abs(
						cursorReadout.cents
					).toFixed(0)}¢
				</span>
				{#if cursorReadout.target}
					<span class="target" title="Nearest tuning target">
						{cursorReadout.target.ji
							? `JI ${cursorReadout.target.label}`
							: `scale ${cursorReadout.target.label}`}
						{cursorReadout.target.frequency.toFixed(2)} Hz
					</span>
				{/if}
			{/if}
			{#if selectedPoint}
				<span class="divider" aria-hidden="true"></span>
				<NumberField
					ariaLabel="Selected point beat"
					value={selectedPoint.point.time}
					min={0}
					step={0.25}
					decimals={4}
					width="80px"
					onchange={(value) => setSelectedPoint({ time: value })}
				/>
				<NumberField
					ariaLabel="Selected point frequency in Hz"
					value={selectedPoint.point.frequency}
					min={8}
					max={22000}
					step={1}
					decimals={4}
					unit="Hz"
					width="98px"
					onchange={(value) => setSelectedPoint({ frequency: value })}
				/>
			{/if}
		</div>
	</div>
</div>

<style>
	.editor {
		display: grid;
		grid-template-columns: 62px 1fr;
		grid-template-rows: 26px 1fr 28px;
		flex: 1;
		min-height: 0;
		background: var(--color-ed-0);
	}

	.corner {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-1);
		border-right: 1px solid var(--color-line-0);
		border-bottom: 1px solid var(--color-line-0);
		font-size: 9px;
	}

	.ruler-cell {
		overflow: hidden;
		border-bottom: 1px solid var(--color-line-0);
	}

	.axis-cell {
		overflow: hidden;
		min-height: 0;
	}

	.canvas-cell {
		position: relative;
		overflow: hidden;
		min-height: 0;
		min-width: 0;
	}

	.layer {
		display: block;
	}

	.is-interactive {
		position: absolute;
		inset: 0;
		touch-action: none;
		cursor: crosshair;
	}

	.menu {
		position: absolute;
		z-index: var(--z-menu);
		min-width: 190px;
		padding: 4px;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		background: var(--color-bg-2);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
		transform-origin: top left;
		animation: menu-in 140ms var(--ease-out);
	}

	@keyframes menu-in {
		from {
			opacity: 0;
			transform: scale(0.97);
		}
	}

	.menu-item {
		display: block;
		width: 100%;
		text-align: left;
		padding: 5px var(--sp-3);
		border: none;
		border-radius: var(--r-1);
		background: none;
		color: var(--color-fg-1);
		font-size: 12px;
		cursor: pointer;
		transition: background-color 120ms var(--ease-out);
	}

	.menu-item:hover:not(:disabled) {
		background: var(--color-bg-4);
		color: var(--color-fg-0);
	}

	.menu-item:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.menu-sep {
		height: 1px;
		margin: 4px 0;
		background: var(--color-line-0);
	}

	.context-bar {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-4);
		padding: 0 var(--sp-3);
		background: var(--color-bg-1);
		border-top: 1px solid var(--color-line-0);
		overflow: hidden;
	}

	.context-left,
	.context-right {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		white-space: nowrap;
	}

	.context-right {
		font-size: 11px;
		color: var(--color-fg-1);
		overflow: hidden;
	}

	.hint {
		font-size: 10px;
		color: var(--color-fg-3);
	}

	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10px;
		color: var(--color-fg-2);
		cursor: pointer;
	}

	.toggle input {
		accent-color: var(--color-accent);
	}

	.target {
		color: var(--color-ji);
	}

	.measure {
		color: var(--color-ok);
	}

	.divider {
		width: 1px;
		height: 16px;
		background: var(--color-line-1);
	}
</style>
