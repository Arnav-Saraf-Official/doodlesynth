/**
 * Generic automation. One engine powers volume, filter, pan, wavetable
 * position, LFO amount and any parameter added to the registry later.
 */

import { uid } from './ids';
import { clamp, lerp } from './pitch';
import { findParameter, normalizeParameterValue } from './parameters';
import type {
	AutomationInterpolation,
	AutomationLane,
	AutomationPoint,
	ParameterKey
} from './types';

export function sortAutomationPoints(points: AutomationPoint[]): AutomationPoint[] {
	return [...points].sort((a, b) => a.time - b.time);
}

export function createAutomationLane(target: ParameterKey): AutomationLane {
	return {
		id: uid('lane'),
		target,
		points: [],
		enabled: true,
		expanded: false
	};
}

export function createAutomationPoint(
	time: number,
	value: number,
	interpolation: AutomationInterpolation = 'linear'
): AutomationPoint {
	return { id: uid('ap'), time, value, interpolation };
}

/** Insert a point, keeping the lane ordered. */
export function insertAutomationPoint(
	lane: AutomationLane,
	time: number,
	value: number
): { lane: AutomationLane; point: AutomationPoint } {
	const point = createAutomationPoint(time, value);
	return {
		lane: { ...lane, points: sortAutomationPoints([...lane.points, point]) },
		point
	};
}

export function removeAutomationPoint(lane: AutomationLane, id: string): AutomationLane {
	return { ...lane, points: lane.points.filter((point) => point.id !== id) };
}

function hermite(
	p0: AutomationPoint,
	p1: AutomationPoint,
	previous: AutomationPoint | undefined,
	next: AutomationPoint | undefined,
	time: number
): number {
	const span = p1.time - p0.time;
	if (span <= 0) return p1.value;
	const u = clamp((time - p0.time) / span, 0, 1);
	// Catmull-Rom tangents, converted from value-per-beat into the segment's
	// own parameter so the hermite is scale independent.
	const m0 = previous
		? ((p1.value - previous.value) / (p1.time - previous.time)) * span
		: p1.value - p0.value;
	const m1 = next ? ((next.value - p0.value) / (next.time - p0.time)) * span : p1.value - p0.value;
	const h00 = 2 * u * u * u - 3 * u * u + 1;
	const h10 = u * u * u - 2 * u * u + u;
	const h01 = -2 * u * u * u + 3 * u * u;
	const h11 = u * u * u - u * u;
	return h00 * p0.value + h10 * m0 + h01 * p1.value + h11 * m1;
}

/** Lane value at a time. Empty lanes fall back to the parameter default. */
export function sampleLane(lane: AutomationLane, time: number): number {
	const fallback = findParameter(lane.target).defaultValue;
	if (lane.points.length === 0) return fallback;
	if (lane.points.length === 1) return lane.points[0].value;

	const points = lane.points;
	if (time <= points[0].time) return points[0].value;
	const last = points[points.length - 1];
	if (time >= last.time) return last.value;

	let index = 0;
	for (let i = 0; i < points.length - 1; i++) {
		if (points[i].time <= time && points[i + 1].time >= time) {
			index = i;
			break;
		}
	}
	const p0 = points[index];
	const p1 = points[index + 1];
	if (p0.interpolation === 'step') return p0.value;
	if (p0.interpolation === 'linear') {
		const span = p1.time - p0.time;
		return span <= 0 ? p1.value : lerp(p0.value, p1.value, (time - p0.time) / span);
	}
	// 'smooth' and 'bezier' share the same hermite until handle data exists
	return hermite(p0, p1, points[index - 1], points[index + 2], time);
}

/** Value of a lane at a time, or the provided fallback when the lane is absent. */
export function evaluateLanes(
	lanes: AutomationLane[],
	target: ParameterKey,
	time: number,
	fallback: number
): number {
	const lane = lanes.find((entry) => entry.target === target && entry.enabled);
	if (!lane) return fallback;
	return sampleLane(lane, time);
}

export function laneValueRange(lane: AutomationLane): { min: number; max: number } {
	const definition = findParameter(lane.target);
	if (lane.points.length === 0) {
		return { min: definition.min, max: definition.max };
	}
	let min = Infinity;
	let max = -Infinity;
	for (const point of lane.points) {
		min = Math.min(min, point.value);
		max = Math.max(max, point.value);
	}
	return { min: Math.min(min, definition.min), max: Math.max(max, definition.max) };
}

/** 0..1 vertical position for a lane value, used by the lane renderer. */
export function laneNormalizedValue(lane: AutomationLane, value: number): number {
	return normalizeParameterValue(lane.target, value);
}

/** Shape a lane as a flattened polyline for rendering. */
export function flattenLane(
	lane: AutomationLane,
	fromTime: number,
	toTime: number,
	steps = 64
): { time: number; value: number }[] {
	if (lane.points.length === 0) return [];
	const samples: { time: number; value: number }[] = [];
	const resolution = Math.max(steps, lane.points.length * 4);
	for (let i = 0; i <= resolution; i++) {
		const time = lerp(fromTime, toTime, i / resolution);
		samples.push({ time, value: sampleLane(lane, time) });
	}
	return samples;
}

/** Duplicate every lane, remapping ids so the copy is independently editable. */
export function duplicateLanes(lanes: AutomationLane[]): AutomationLane[] {
	return lanes.map((lane) => ({
		...lane,
		id: uid('lane'),
		points: lane.points.map((point) => ({ ...point, id: uid('ap') }))
	}));
}
