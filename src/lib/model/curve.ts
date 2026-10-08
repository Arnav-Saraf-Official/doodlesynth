/**
 * Curve mathematics: interpolation, flattening, simplification and edits.
 *
 * Pitch is interpolated in the log2(Hz) domain. That matches the default
 * logarithmic pitch display and means a glide between two frequencies is a
 * constant-rate musical movement rather than a constant-Hz ramp.
 */

import { uid } from './ids';
import { clamp } from './pitch';
import type { CurvePoint, Handle, PointInterpolation } from './types';

export interface FlattenedPoint {
	time: number;
	frequency: number;
}

export interface CurveBounds {
	startTime: number;
	endTime: number;
	minFrequency: number;
	maxFrequency: number;
}

export function log2f(hz: number): number {
	return Math.log2(Math.max(hz, 1e-6));
}

export function sortPoints(points: CurvePoint[]): CurvePoint[] {
	return [...points].sort((a, b) => a.time - b.time);
}

export function copyPoint(point: CurvePoint): CurvePoint {
	return {
		...point,
		inHandle: point.inHandle ? { ...point.inHandle } : undefined,
		outHandle: point.outHandle ? { ...point.outHandle } : undefined,
		scaleRef: point.scaleRef ? { ...point.scaleRef } : undefined
	};
}

/* ------------------------------------------------------------ interpolation */

function planeHandle(
	time: number,
	frequency: number,
	handle: Handle | undefined,
	fallbackTime: number,
	fallbackLog: number
): [number, number] {
	if (!handle) return [fallbackTime, fallbackLog];
	return [time + handle.dt, log2f(Math.max(frequency + handle.df, 1e-6))];
}

function cubic(a: number, b: number, c: number, d: number, t: number): number {
	const mt = 1 - t;
	return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
}

/** Solve x(u) = target for a cubic bezier's x component by bisection. */
function solveBezierU(x0: number, x1: number, x2: number, x3: number, target: number): number {
	if (target <= x0) return 0;
	if (target >= x3) return 1;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 28; i++) {
		const mid = (lo + hi) / 2;
		if (cubic(x0, x1, x2, x3, mid) < target) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

function catmullTangent(points: CurvePoint[], index: number): number {
	const previous = points[index - 1];
	const next = points[index + 1];
	const current = points[index];
	if (previous && next) {
		const dt = next.time - previous.time;
		if (dt <= 0) return 0;
		return (log2f(next.frequency) - log2f(previous.frequency)) / dt;
	}
	if (next) {
		const dt = next.time - current.time;
		return dt > 0 ? (log2f(next.frequency) - log2f(current.frequency)) / dt : 0;
	}
	if (previous) {
		const dt = current.time - previous.time;
		return dt > 0 ? (log2f(current.frequency) - log2f(previous.frequency)) / dt : 0;
	}
	return 0;
}

/** Interpolate the frequency of one segment at an absolute time. */
function sampleSegment(points: CurvePoint[], index: number, time: number): number {
	const a = points[index];
	const b = points[index + 1];
	const span = b.time - a.time;
	if (span <= 0) return b.frequency;

	const u = clamp((time - a.time) / span, 0, 1);
	const ay = log2f(a.frequency);
	const by = log2f(b.frequency);

	if (a.interpolation === 'bezier' || b.interpolation === 'bezier') {
		const c1 = planeHandle(a.time, a.frequency, a.outHandle, a.time + span / 3, ay);
		const c2 = planeHandle(b.time, b.frequency, b.inHandle, b.time - span / 3, by);
		// keep x monotonic so the curve stays a function of time
		const x1 = clamp(c1[0], a.time, b.time);
		const x2 = clamp(c2[0], a.time, b.time);
		const uu = solveBezierU(a.time, x1, x2, b.time, time);
		const y = cubic(ay, c1[1], c2[1], by, uu);
		return Math.pow(2, y);
	}

	if (a.interpolation === 'smooth' || b.interpolation === 'smooth') {
		const ma = catmullTangent(points, index);
		const mb = catmullTangent(points, index + 1);
		const h00 = 2 * u * u * u - 3 * u * u + 1;
		const h10 = u * u * u - 2 * u * u + u;
		const h01 = -2 * u * u * u + 3 * u * u;
		const h11 = u * u * u - u * u;
		const y = h00 * ay + h10 * (ma * span) + h01 * by + h11 * (mb * span);
		return Math.pow(2, y);
	}

	return Math.pow(2, ay + (by - ay) * u);
}

/**
 * Frequency of a curve at an absolute time. Clamps to the endpoints outside
 * the curve's time range, which is what the editor wants while dragging.
 */
export function sampleFrequencyAt(points: CurvePoint[], time: number): number {
	if (points.length === 0) return 440;
	if (points.length === 1) return points[0].frequency;
	if (time <= points[0].time) return points[0].frequency;
	const last = points[points.length - 1];
	if (time >= last.time) return last.frequency;

	let lo = 0;
	let hi = points.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (points[mid].time <= time) lo = mid;
		else hi = mid;
	}
	return sampleSegment(points, lo, time);
}

/** Index of the segment containing `time`, or -1. */
export function findSegmentIndex(points: CurvePoint[], time: number): number {
	if (points.length < 2) return -1;
	if (time < points[0].time || time > points[points.length - 1].time) return -1;
	let lo = 0;
	let hi = points.length - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (points[mid].time <= time) lo = mid;
		else hi = mid;
	}
	return lo;
}

/** Flatten a whole curve into a polyline, subdividing curved segments. */
export function flattenCurve(
	points: CurvePoint[],
	fromTime: number,
	toTime: number,
	subdivisions = 16
): FlattenedPoint[] {
	const out: FlattenedPoint[] = [];
	if (points.length === 0) return out;
	if (points.length === 1) {
		return [{ time: points[0].time, frequency: points[0].frequency }];
	}

	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (b.time < fromTime || a.time > toTime) continue;
		const curved =
			a.interpolation !== 'linear' || b.interpolation !== 'linear' || a.outHandle || b.inHandle;
		const steps = curved ? Math.max(2, subdivisions) : 2;
		if (out.length === 0) out.push({ time: a.time, frequency: a.frequency });
		for (let s = 1; s <= steps; s++) {
			const t = a.time + ((b.time - a.time) * s) / steps;
			out.push({ time: t, frequency: sampleSegment(points, i, t) });
		}
	}
	return out;
}

export function curveBounds(points: CurvePoint[]): CurveBounds {
	if (points.length === 0) {
		return { startTime: 0, endTime: 0, minFrequency: 20, maxFrequency: 20000 };
	}
	let minFrequency = Infinity;
	let maxFrequency = -Infinity;
	for (const point of points) {
		minFrequency = Math.min(minFrequency, point.frequency);
		maxFrequency = Math.max(maxFrequency, point.frequency);
	}
	return {
		startTime: points[0].time,
		endTime: points[points.length - 1].time,
		minFrequency,
		maxFrequency
	};
}

/* ------------------------------------------------------------ simplification */

/**
 * Ramer–Douglas–Peucker in a normalized (time, log2 Hz) plane.
 *
 * `timeScale` and `logScale` scale each axis into comparable units. Passing
 * the viewport's pixels-per-beat and pixels-per-octave makes the tolerance a
 * literal pixel tolerance, which is what a drawing gesture wants.
 */
export function simplifyPoints(
	points: FlattenedPoint[],
	tolerance: number,
	options: { timeScale?: number; logScale?: number } = {}
): FlattenedPoint[] {
	const timeScale = options.timeScale ?? 1;
	const logScale = options.logScale ?? 1;
	if (points.length <= 2) return [...points];
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;

	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [first, last] = stack.pop()!;
		if (last <= first + 1) continue;
		const ax = points[first].time * timeScale;
		const ay = log2f(points[first].frequency) * logScale;
		const bx = points[last].time * timeScale;
		const by = log2f(points[last].frequency) * logScale;
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSq = dx * dx + dy * dy;

		let maxDistSq = -1;
		let maxIndex = -1;
		for (let i = first + 1; i < last; i++) {
			const px = points[i].time * timeScale;
			const py = log2f(points[i].frequency) * logScale;
			let distSq: number;
			if (lengthSq === 0) {
				distSq = (px - ax) ** 2 + (py - ay) ** 2;
			} else {
				const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
				distSq = (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
			}
			if (distSq > maxDistSq) {
				maxDistSq = distSq;
				maxIndex = i;
			}
		}

		if (maxDistSq > tolerance * tolerance && maxIndex > 0) {
			keep[maxIndex] = 1;
			stack.push([first, maxIndex], [maxIndex, last]);
		}
	}

	return points.filter((_, index) => keep[index] === 1);
}

/* ----------------------------------------------------------------- edits */

export function createPoint(
	time: number,
	frequency: number,
	interpolation: PointInterpolation = 'smooth'
): CurvePoint {
	return { id: uid('pt'), time, frequency, interpolation };
}

/** Insert a point on the curve at `time`, preserving the existing shape. */
export function insertPointAt(
	points: CurvePoint[],
	time: number
): {
	points: CurvePoint[];
	point: CurvePoint;
	index: number;
} {
	const frequency = sampleFrequencyAt(points, time);
	let interpolation: PointInterpolation = 'smooth';
	const segment = findSegmentIndex(points, time);
	if (segment >= 0) interpolation = points[segment].interpolation;
	const point = createPoint(time, frequency, interpolation);
	const next = sortPoints([...points, point]);
	return { points: next, point, index: next.findIndex((p) => p.id === point.id) };
}

export function removePoint(points: CurvePoint[], id: string): CurvePoint[] {
	const next = points.filter((point) => point.id !== id);
	if (next.length < 2) return points;
	return next;
}

/** Split a curve at a time, producing two curves that share a new endpoint. */
export function splitPointsAt(points: CurvePoint[], time: number): [CurvePoint[], CurvePoint[]] {
	const clampedTime = clamp(time, points[0].time, points[points.length - 1].time);
	const frequency = sampleFrequencyAt(points, clampedTime);
	const before = points.filter((point) => point.time < clampedTime);
	const after = points.filter((point) => point.time > clampedTime);
	const seam: CurvePoint = createPoint(clampedTime, frequency, 'smooth');
	const left = sortPoints([...before, { ...seam, id: uid('pt') }]);
	const right = sortPoints([{ ...seam, id: uid('pt') }, ...after]);
	return [left, right];
}

/** Move a point in time and pitch, keeping the list ordered. */
export function movePoint(
	points: CurvePoint[],
	id: string,
	time: number,
	frequency: number
): CurvePoint[] {
	return sortPoints(
		points.map((point) => (point.id === id ? { ...point, time, frequency } : point))
	);
}

/** Reverse a curve in time while keeping its pitch contour mirrored. */
export function reversePoints(points: CurvePoint[]): CurvePoint[] {
	if (points.length < 2) return [...points];
	const start = points[0].time;
	const end = points[points.length - 1].time;
	return [...points].reverse().map((point) => ({
		...point,
		time: start + (end - point.time),
		inHandle: point.outHandle,
		outHandle: point.inHandle
	}));
}

/** Repeat the whole path shifted in time. */
export function offsetPoints(points: CurvePoint[], beats: number, ratio = 1): CurvePoint[] {
	return points.map((point) => ({
		...copyPoint(point),
		id: uid('pt'),
		time: point.time + beats,
		frequency: point.frequency * ratio
	}));
}

/** Transpose by semitones (a pure frequency ratio). */
export function transposePoints(
	points: CurvePoint[],
	semitones: number,
	anchorHz?: number
): CurvePoint[] {
	const factor = Math.pow(2, semitones / 12);
	return points.map((point) => {
		const base = anchorHz ?? point.frequency;
		return { ...copyPoint(point), frequency: base + (point.frequency - base) * factor };
	});
}
