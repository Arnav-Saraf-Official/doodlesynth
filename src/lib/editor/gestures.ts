/**
 * Gesture utilities.
 *
 * Pointer moves fire hundreds of times per second. A drag therefore writes to
 * a mutable preview object and repaints the canvas directly; the project model
 * is only touched once, on release. Nothing here allocates per frame.
 */

import type { CurvePoint } from '../model/types';

export interface PointerSample {
	x: number;
	y: number;
	time: number;
	/** ms */
	timestamp: number;
}

export type DragMode =
	| 'none'
	| 'draw'
	| 'move-point'
	| 'move-handle'
	| 'move-curve'
	| 'region'
	| 'pan'
	| 'split'
	| 'automation-point';

export interface DragPreview {
	mode: DragMode;
	/** curve id -> replacement point list during the drag */
	movedPoints: Map<string, CurvePoint[]>;
	/** point id -> { dt, df } handle delta being applied */
	handleDelta: Map<string, { dt: number; df: number }>;
	/** curve id -> beat/frequency translation */
	curveOffset: Map<string, { beats: number; ratio: number }>;
	/** freehand samples accumulated while drawing */
	drawSamples: PointerSample[];
	/** region rectangle in pixels */
	region: { x0: number; y0: number; x1: number; y1: number } | null;
	/** split preview: curve id and the beat under the cursor */
	splitAt: { curveId: string; time: number } | null;
	pointer: PointerSample;
}

export function createDragPreview(): DragPreview {
	return {
		mode: 'none',
		movedPoints: new Map(),
		handleDelta: new Map(),
		curveOffset: new Map(),
		drawSamples: [],
		region: null,
		splitAt: null,
		pointer: { x: 0, y: 0, time: 0, timestamp: 0 }
	};
}

export function resetDragPreview(preview: DragPreview): void {
	preview.mode = 'none';
	preview.movedPoints.clear();
	preview.handleDelta.clear();
	preview.curveOffset.clear();
	preview.drawSamples.length = 0;
	preview.region = null;
	preview.splitAt = null;
}

/** Rolling pointer history, used for release velocity. */
export class PointerTracker {
	private samples: PointerSample[] = [];

	add(sample: PointerSample): void {
		this.samples.push(sample);
		const cutoff = sample.timestamp - 120;
		while (this.samples.length > 2 && this.samples[0].timestamp < cutoff) this.samples.shift();
	}

	clear(): void {
		this.samples.length = 0;
	}

	/** Pixels per millisecond, using the trailing window. */
	velocity(): { vx: number; vy: number } {
		if (this.samples.length < 2) return { vx: 0, vy: 0 };
		const first = this.samples[0];
		const last = this.samples[this.samples.length - 1];
		const elapsed = Math.max(last.timestamp - first.timestamp, 1);
		return { vx: (last.x - first.x) / elapsed, vy: (last.y - first.y) / elapsed };
	}

	last(): PointerSample | null {
		return this.samples.length ? this.samples[this.samples.length - 1] : null;
	}
}

/**
 * Progressive resistance past a boundary. A hard stop reads as frozen; a
 * softening edge reads as responsive with nothing more to give.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
	return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Where a flicked element would come to rest, using Apple's exponential decay
 * form rather than the v²/2a textbook form.
 */
export function projectMomentum(velocity: number, decelerationRate = 0.998): number {
	return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Movement hysteresis before a drag commits to a direction. */
export const DRAG_THRESHOLD_PX = 3;

export function exceedsThreshold(
	origin: { x: number; y: number },
	current: { x: number; y: number },
	threshold = DRAG_THRESHOLD_PX
): boolean {
	return Math.hypot(current.x - origin.x, current.y - origin.y) >= threshold;
}

/** Modifier keys used across the editor. */
export interface Modifiers {
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	meta: boolean;
}

export function modifiersFrom(event: PointerEvent | MouseEvent | KeyboardEvent): Modifiers {
	return {
		shift: event.shiftKey,
		alt: event.altKey,
		ctrl: event.ctrlKey,
		meta: event.metaKey
	};
}

/** Cmd on macOS, Ctrl elsewhere: the standard "temporarily bypass snap" key. */
export function isBypassModifier(modifiers: Modifiers): boolean {
	return modifiers.ctrl || modifiers.meta;
}

export function isFineModifier(modifiers: Modifiers): boolean {
	return modifiers.alt;
}

export function isConstrainModifier(modifiers: Modifiers): boolean {
	return modifiers.shift;
}

/** Multiplier applied to drag deltas for fine and constrained movement. */
export function dragScale(modifiers: Modifiers): { pitch: number; time: number } {
	if (isFineModifier(modifiers)) return { pitch: 0.1, time: 0.5 };
	if (isConstrainModifier(modifiers)) return { pitch: 1, time: 1 };
	return { pitch: 1, time: 1 };
}
