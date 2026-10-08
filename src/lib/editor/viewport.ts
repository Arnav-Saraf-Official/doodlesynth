/**
 * Viewport state and navigation.
 *
 * Horizontal time is effectively unbounded and is expressed as a scroll anchor
 * plus a zoom, never as a DOM element per beat. Vertical space is a frequency
 * window that can be zoomed and scrolled independently.
 */

import { clamp, hzToMidi, midiToHz } from '../model/pitch';
import type { EditorSettings } from '../model/types';
import type { ViewportState } from './transform';

export const MIN_PIXELS_PER_BEAT = 4;
export const MAX_PIXELS_PER_BEAT = 3200;

export function defaultViewport(): ViewportState {
	return {
		startBeat: 0,
		pixelsPerBeat: 48,
		minFrequencyHz: 20,
		maxFrequencyHz: 10000,
		width: 1200,
		height: 600,
		pitchMap: 'piano',
		projection: 'logarithmic',
		rulerHeight: 26
	};
}

export function viewportFromSettings(
	settings: EditorSettings,
	width: number,
	height: number
): ViewportState {
	return {
		...defaultViewport(),
		pitchMap: settings.pitchMap,
		projection: settings.frequencyProjection,
		minFrequencyHz: settings.minFrequencyHz,
		maxFrequencyHz: settings.maxFrequencyHz,
		width,
		height
	};
}

export function clampViewport(viewport: ViewportState): ViewportState {
	return {
		...viewport,
		pixelsPerBeat: clamp(viewport.pixelsPerBeat, MIN_PIXELS_PER_BEAT, MAX_PIXELS_PER_BEAT),
		startBeat: Math.max(0, viewport.startBeat),
		minFrequencyHz: clamp(viewport.minFrequencyHz, 10, 18000),
		maxFrequencyHz: clamp(viewport.maxFrequencyHz, 20, 24000)
	};
}

/** Zoom horizontally around a beat that must stay under the cursor. */
export function zoomTimeAt(
	viewport: ViewportState,
	factor: number,
	anchorBeat: number
): ViewportState {
	const next = clamp(viewport.pixelsPerBeat * factor, MIN_PIXELS_PER_BEAT, MAX_PIXELS_PER_BEAT);
	const ratio = next / viewport.pixelsPerBeat;
	const startBeat = anchorBeat - (anchorBeat - viewport.startBeat) / ratio;
	return clampViewport({ ...viewport, pixelsPerBeat: next, startBeat });
}

/**
 * The pitch axis is linear in its own domain, never in raw Hz: the Piano Map
 * is linear in MIDI, the Frequency Map is linear in log2 Hz or in Hz. Zooming
 * and panning have to happen in that same domain, or the pitch under the
 * cursor slides away as you zoom.
 */
interface PitchAxis {
	to(frequency: number): number;
	from(value: number): number;
	minSpan: number;
	maxSpan: number;
}

function pitchAxis(viewport: ViewportState): PitchAxis {
	if (viewport.pitchMap === 'piano') {
		// limits in semitones: one semitone of detail up to ten octaves of context
		return { to: (hz) => hzToMidi(hz), from: (midi) => midiToHz(midi), minSpan: 1, maxSpan: 120 };
	}
	if (viewport.projection === 'linear-hz') {
		return { to: (hz) => hz, from: (hz) => hz, minSpan: 0.5, maxSpan: 20000 };
	}
	// limits in octaves, matched to the Piano Map's semitone limits
	return {
		to: (hz) => Math.log2(Math.max(hz, 1e-6)),
		from: (value) => Math.pow(2, value),
		minSpan: 1 / 12,
		maxSpan: 10
	};
}

/** Zoom the pitch window around a frequency, in the active projection. */
export function zoomFrequencyAt(
	viewport: ViewportState,
	factor: number,
	anchorHz: number
): ViewportState {
	const axis = pitchAxis(viewport);
	const axisMin = axis.to(viewport.minFrequencyHz);
	const axisMax = axis.to(viewport.maxFrequencyHz);
	const span = Math.max(axisMax - axisMin, axis.minSpan);
	const nextSpan = clamp(span / factor, axis.minSpan, axis.maxSpan);
	const anchor = clamp(axis.to(anchorHz), axisMin, axisMax);
	// the anchor keeps its exact position in the visible window
	const ratio = (anchor - axisMin) / span;
	const min = anchor - ratio * nextSpan;
	return clampViewport({
		...viewport,
		minFrequencyHz: axis.from(min),
		maxFrequencyHz: axis.from(min + nextSpan)
	});
}

export function panBeats(viewport: ViewportState, beats: number): ViewportState {
	return clampViewport({ ...viewport, startBeat: viewport.startBeat + beats });
}

export function panFrequency(viewport: ViewportState, ratio: number): ViewportState {
	const axis = pitchAxis(viewport);
	const axisMin = axis.to(viewport.minFrequencyHz);
	const axisMax = axis.to(viewport.maxFrequencyHz);
	// a pan is a fraction of the visible axis span, so it feels even in every map
	const delta = Math.max(axisMax - axisMin, axis.minSpan) * ratio;
	return clampViewport({
		...viewport,
		minFrequencyHz: axis.from(axisMin + delta),
		maxFrequencyHz: axis.from(axisMax + delta)
	});
}

/** Reset the pitch window to the project's configured range. */
export function resetFrequencyRange(
	viewport: ViewportState,
	min: number,
	max: number
): ViewportState {
	return clampViewport({ ...viewport, minFrequencyHz: min, maxFrequencyHz: max });
}

/** Frame a time range with a little air on both sides. */
export function fitTimeRange(
	viewport: ViewportState,
	from: number,
	to: number,
	padding = 0.05
): ViewportState {
	const span = Math.max(to - from, 0.25);
	const padded = span * (1 + padding * 2);
	const pixelsPerBeat = clamp(viewport.width / padded, MIN_PIXELS_PER_BEAT, MAX_PIXELS_PER_BEAT);
	const startBeat = Math.max(0, from - span * padding);
	return clampViewport({ ...viewport, pixelsPerBeat, startBeat });
}

/** Frame a frequency range, preserving ratios in the logarithmic projections. */
export function fitFrequencyRange(
	viewport: ViewportState,
	min: number,
	max: number
): ViewportState {
	if (viewport.pitchMap === 'frequency' && viewport.projection === 'linear-hz') {
		const span = Math.max(max - min, 1);
		return clampViewport({
			...viewport,
			minFrequencyHz: Math.max(10, min - span * 0.08),
			maxFrequencyHz: max + span * 0.08
		});
	}
	const low = Math.max(min, 1e-3);
	const high = Math.max(max, low * 1.01);
	const factor = Math.pow(high / low, 0.06);
	return clampViewport({
		...viewport,
		minFrequencyHz: Math.max(low / factor, 10),
		maxFrequencyHz: Math.min(high * factor, 24000)
	});
}

export function resize(viewport: ViewportState, width: number, height: number): ViewportState {
	return { ...viewport, width, height };
}

/** Y position of the top of the pitch area, i.e. below the ruler. */
export function pitchAreaTop(viewport: ViewportState): number {
	return viewport.rulerHeight;
}

/** True when a pointer position is inside the pitch area. */
export function isInsidePitchArea(viewport: ViewportState, y: number): boolean {
	return y >= pitchAreaTop(viewport) && y <= viewport.height;
}
