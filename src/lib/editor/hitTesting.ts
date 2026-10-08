/**
 * Hit testing.
 *
 * All coordinates are canvas pixels with y measured from the top of the pitch
 * area (the editor subtracts the ruler height before calling in). Thresholds
 * are generous: a precision editor should never make the user chase a target.
 */

import { log2f } from '../model/curve';
import type { Curve, CurvePoint } from '../model/types';
import {
	distanceToPolyline,
	timeAtDistance,
	type CurveGeometry,
	type PixelPoint
} from './curveSampling';
import type { Transform } from './transform';

export const POINT_HIT_RADIUS = 7;
export const CURVE_HIT_TOLERANCE = 7;
export const HANDLE_HIT_RADIUS = 8;

export interface PointHit {
	curve: Curve;
	point: CurvePoint;
	index: number;
	distance: number;
}

export interface CurveHit {
	curve: Curve;
	time: number;
	frequency: number;
	distance: number;
}

export interface HandleHit {
	curve: Curve;
	point: CurvePoint;
	handle: 'in' | 'out';
}

export function pointPixel(point: CurvePoint, transform: Transform): { x: number; y: number } {
	return { x: transform.timeToX(point.time), y: transform.frequencyToY(point.frequency) };
}

/** Pixel position of a tangent handle, in the same (time, log2 Hz) plane. */
export function handlePixel(
	point: CurvePoint,
	handle: { dt: number; df: number },
	transform: Transform
): { x: number; y: number } {
	const frequency = point.frequency + handle.df;
	const deltaLog = log2f(frequency) - log2f(point.frequency);
	const handleFrequency = point.frequency * Math.pow(2, deltaLog);
	return {
		x: transform.timeToX(point.time + handle.dt),
		y: transform.frequencyToY(handleFrequency)
	};
}

/** Nearest control point across the given curves. */
export function hitTestPoints(
	curves: Curve[],
	transform: Transform,
	x: number,
	y: number,
	radius = POINT_HIT_RADIUS,
	visibleOnly?: (curve: Curve) => boolean
): PointHit | null {
	let best: PointHit | null = null;
	for (const curve of curves) {
		if (visibleOnly && !visibleOnly(curve)) continue;
		for (let index = 0; index < curve.points.length; index++) {
			const point = curve.points[index];
			const pixel = pointPixel(point, transform);
			const distance = Math.hypot(pixel.x - x, pixel.y - y);
			if (distance <= radius && (!best || distance < best.distance)) {
				best = { curve, point, index, distance };
			}
		}
	}
	return best;
}

/** Nearest tangent handle. Only rendered for selected points, so only those are tested. */
export function hitTestHandles(
	curves: Curve[],
	selectedPointIds: Set<string>,
	transform: Transform,
	x: number,
	y: number,
	radius = HANDLE_HIT_RADIUS
): HandleHit | null {
	let best: HandleHit | null = null;
	let bestDistance = Infinity;
	for (const curve of curves) {
		for (const point of curve.points) {
			if (!selectedPointIds.has(point.id)) continue;
			if (point.inHandle) {
				const pixel = handlePixel(point, point.inHandle, transform);
				const distance = Math.hypot(pixel.x - x, pixel.y - y);
				if (distance <= radius && distance < bestDistance) {
					bestDistance = distance;
					best = { curve, point, handle: 'in' };
				}
			}
			if (point.outHandle) {
				const pixel = handlePixel(point, point.outHandle, transform);
				const distance = Math.hypot(pixel.x - x, pixel.y - y);
				if (distance <= radius && distance < bestDistance) {
					bestDistance = distance;
					best = { curve, point, handle: 'out' };
				}
			}
		}
	}
	return best;
}

/** Nearest curve, using cached flattened geometry. */
export function hitTestCurves(
	geometries: { curve: Curve; geometry: CurveGeometry }[],
	x: number,
	y: number,
	tolerance = CURVE_HIT_TOLERANCE
): CurveHit | null {
	let best: CurveHit | null = null;
	let bestDistance = Infinity;
	for (const { curve, geometry } of geometries) {
		const result = timeAtDistance(x, y, geometry.points);
		if (result.distance <= tolerance && result.distance < bestDistance) {
			bestDistance = result.distance;
			best = { curve, time: result.time, frequency: result.frequency, distance: result.distance };
		}
	}
	return best;
}

/** Distance from a pixel to a curve's geometry, for hover previews. */
export function distanceToCurve(x: number, y: number, points: PixelPoint[]): number {
	return distanceToPolyline(x, y, points).distance;
}

/** Curves whose bounding box intersects the given model-space window. */
export function curvesInWindow(
	curves: Curve[],
	fromTime: number,
	toTime: number,
	minFrequency: number,
	maxFrequency: number
): Curve[] {
	return curves.filter((curve) => {
		if (curve.points.length === 0) return false;
		let minT = Infinity;
		let maxT = -Infinity;
		let minF = Infinity;
		let maxF = -Infinity;
		for (const point of curve.points) {
			minT = Math.min(minT, point.time);
			maxT = Math.max(maxT, point.time);
			minF = Math.min(minF, point.frequency);
			maxF = Math.max(maxF, point.frequency);
		}
		return maxT >= fromTime && minT <= toTime && maxF >= minFrequency && minF <= maxFrequency;
	});
}

/** Points of a region selection. */
export function pointsInRegion(
	curve: Curve,
	transform: Transform,
	region: { x0: number; y0: number; x1: number; y1: number }
): CurvePoint[] {
	const minX = Math.min(region.x0, region.x1);
	const maxX = Math.max(region.x0, region.x1);
	const minY = Math.min(region.y0, region.y1);
	const maxY = Math.max(region.y0, region.y1);
	return curve.points.filter((point) => {
		const pixel = pointPixel(point, transform);
		return pixel.x >= minX && pixel.x <= maxX && pixel.y >= minY && pixel.y <= maxY;
	});
}

/** Endpoints of two curves that could be joined, if they are close enough. */
export function joinableEndpoints(
	first: Curve,
	second: Curve,
	transform: Transform,
	tolerance = 16
): boolean {
	if (first.points.length === 0 || second.points.length === 0) return false;
	const a = first.points[first.points.length - 1];
	const b = second.points[0];
	const pa = pointPixel(a, transform);
	const pb = pointPixel(b, transform);
	return Math.hypot(pa.x - pb.x, pa.y - pb.y) <= tolerance;
}
