/**
 * Curve geometry in pixel space.
 *
 * Flattening is the expensive part of rendering and hit testing, so results
 * are cached against the viewport key that produced them. The cache is
 * invalidated by curve edits, zoom changes and projection changes — never by
 * anything else.
 */

import { flattenCurve } from '../model/curve';
import type { Curve, CurvePoint } from '../model/types';
import type { Transform } from './transform';

export interface PixelPoint {
	x: number;
	y: number;
	time: number;
	frequency: number;
}

export interface CurveGeometry {
	curveId: string;
	points: PixelPoint[];
	/** index into the source curve's point list for each pixel point, when known */
	keys: number[];
}

export interface ViewportKey {
	startBeat: number;
	pixelsPerBeat: number;
	minFrequencyHz: number;
	maxFrequencyHz: number;
	width: number;
	height: number;
	pitchMap: string;
	projection: string;
	/** bump on any curve edit */
	revision: number;
}

export function viewportKey(transform: Transform, revision: number): ViewportKey {
	const { viewport } = transform;
	return {
		startBeat: viewport.startBeat,
		pixelsPerBeat: viewport.pixelsPerBeat,
		minFrequencyHz: viewport.minFrequencyHz,
		maxFrequencyHz: viewport.maxFrequencyHz,
		width: viewport.width,
		height: viewport.height,
		pitchMap: viewport.pitchMap,
		projection: viewport.projection,
		revision
	};
}

function keyString(key: ViewportKey): string {
	return [
		key.startBeat.toFixed(4),
		key.pixelsPerBeat.toFixed(4),
		key.minFrequencyHz.toFixed(4),
		key.maxFrequencyHz.toFixed(4),
		key.width,
		key.height,
		key.pitchMap,
		key.projection,
		key.revision
	].join('|');
}

/** Subdivisions per curved segment, scaled to how big the segment is on screen. */
export function subdivisionsFor(points: CurvePoint[], transform: Transform, base = 12): number {
	if (points.length < 2) return 1;
	const { from, to } = transform.timeWindow();
	const visible = points.filter((point, index) => {
		const next = points[index + 1];
		return point.time <= to && (!next || next.time >= from);
	});
	const span = Math.max(visible.length - 1, 1);
	const pixels = Math.min(transform.viewport.width, 2048);
	return Math.max(base, Math.min(96, Math.round(pixels / span / 3)));
}

export function buildCurveGeometry(
	curve: Curve,
	transform: Transform,
	subdivisions?: number
): CurveGeometry {
	const { from, to } = transform.timeWindow();
	const steps = subdivisions ?? subdivisionsFor(curve.points, transform);
	const flattened = flattenCurve(curve.points, from - 1, to + 1, steps);
	const points: PixelPoint[] = flattened.map((point) => ({
		x: transform.timeToX(point.time),
		y: transform.frequencyToY(point.frequency) + transform.viewport.rulerHeight,
		time: point.time,
		frequency: point.frequency
	}));
	return { curveId: curve.id, points, keys: [] };
}

export class CurveGeometryCache {
	private cache = new Map<string, CurveGeometry>();
	private key = '';
	private hits = 0;
	private misses = 0;

	begin(key: ViewportKey): void {
		const next = keyString(key);
		if (next !== this.key) {
			this.cache.clear();
			this.key = next;
		}
	}

	get(curve: Curve, transform: Transform): CurveGeometry {
		const existing = this.cache.get(curve.id);
		if (existing) {
			this.hits += 1;
			return existing;
		}
		this.misses += 1;
		const geometry = buildCurveGeometry(curve, transform);
		this.cache.set(curve.id, geometry);
		return geometry;
	}

	delete(curveId: string): void {
		this.cache.delete(curveId);
	}

	clear(): void {
		this.cache.clear();
	}

	stats(): { hits: number; misses: number; size: number } {
		return { hits: this.hits, misses: this.misses, size: this.cache.size };
	}
}

/** Squared distance from a point to a polyline, plus the closest segment index. */
export function distanceToPolyline(
	x: number,
	y: number,
	points: PixelPoint[]
): { distance: number; index: number } {
	if (points.length === 0) return { distance: Infinity, index: -1 };
	if (points.length === 1) {
		return { distance: Math.hypot(x - points[0].x, y - points[0].y), index: 0 };
	}
	let best = Infinity;
	let bestIndex = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSq = dx * dx + dy * dy;
		let t = 0;
		if (lengthSq > 0) {
			t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSq;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
		}
		const distance = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
		if (distance < best) {
			best = distance;
			bestIndex = i;
		}
	}
	return { distance: best, index: bestIndex };
}

/** Linear interpolation of the curve time at the closest polyline position. */
export function timeAtDistance(
	x: number,
	y: number,
	points: PixelPoint[]
): { distance: number; time: number; frequency: number } {
	if (points.length === 0) return { distance: Infinity, time: 0, frequency: 440 };
	let best = Infinity;
	let bestTime = points[0].time;
	let bestFrequency = points[0].frequency;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const lengthSq = dx * dx + dy * dy;
		let t = 0;
		if (lengthSq > 0) {
			t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSq;
			t = t < 0 ? 0 : t > 1 ? 1 : t;
		}
		const distance = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
		if (distance < best) {
			best = distance;
			bestTime = a.time + (b.time - a.time) * t;
			bestFrequency = a.frequency + (b.frequency - a.frequency) * t;
		}
	}
	return { distance: best, time: bestTime, frequency: bestFrequency };
}
