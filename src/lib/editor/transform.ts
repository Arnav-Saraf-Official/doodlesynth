/**
 * The only place where model coordinates become pixels.
 *
 * Time is linear in beats. Frequency is not linear in Hz: the Piano Map is
 * linear in MIDI note number, while the Frequency Map is logarithmic by
 * default and can switch to a raw linear-Hz projection. All three are exposed
 * through the same transform so hit testing and rendering cannot disagree.
 */

import { hzToMidi, midiToHz } from '../model/pitch';
import type { FrequencyProjection, PitchMap } from '../model/types';

export interface ViewportState {
	/** beats at the left edge of the editor canvas */
	startBeat: number;
	/** horizontal zoom */
	pixelsPerBeat: number;
	/** bottom of the visible frequency band */
	minFrequencyHz: number;
	/** top of the visible frequency band */
	maxFrequencyHz: number;
	/** canvas size in CSS pixels */
	width: number;
	height: number;
	pitchMap: PitchMap;
	projection: FrequencyProjection;
	/** horizontal ruler height, excluded from the pitch area */
	rulerHeight: number;
}

export interface TimeWindow {
	from: number;
	to: number;
}

export interface FrequencyWindow {
	min: number;
	max: number;
}

export interface Transform {
	readonly viewport: ViewportState;
	readonly pitchAreaHeight: number;
	timeToX(time: number): number;
	xToTime(x: number): number;
	frequencyToY(hz: number): number;
	yToFrequency(y: number): number;
	timeWindow(): TimeWindow;
	frequencyWindow(): FrequencyWindow;
	/** how many CSS pixels one octave occupies, for label density decisions */
	pixelsPerOctave(): number;
}

export function pitchAreaHeight(viewport: ViewportState): number {
	return Math.max(1, viewport.height - viewport.rulerHeight);
}

function midiWindow(viewport: ViewportState): { min: number; max: number } {
	return {
		min: hzToMidi(viewport.minFrequencyHz),
		max: hzToMidi(viewport.maxFrequencyHz)
	};
}

export function createTransform(viewport: ViewportState): Transform {
	const area = pitchAreaHeight(viewport);
	const midi = midiWindow(viewport);
	const logMin = Math.log2(Math.max(viewport.minFrequencyHz, 1e-6));
	const logMax = Math.log2(Math.max(viewport.maxFrequencyHz, 1e-6));
	const hzSpan = Math.max(viewport.maxFrequencyHz - viewport.minFrequencyHz, 1e-6);
	const midiSpan = Math.max(midi.max - midi.min, 1e-6);
	const logSpan = Math.max(logMax - logMin, 1e-6);

	const frequencyToY = (hz: number): number => {
		if (viewport.pitchMap === 'piano') {
			return area * (1 - (hzToMidi(hz) - midi.min) / midiSpan);
		}
		if (viewport.projection === 'linear-hz') {
			return area * (1 - (hz - viewport.minFrequencyHz) / hzSpan);
		}
		return area * (1 - (Math.log2(Math.max(hz, 1e-6)) - logMin) / logSpan);
	};

	const yToFrequency = (y: number): number => {
		const t = 1 - y / area;
		if (viewport.pitchMap === 'piano') {
			return midiToHz(midi.min + t * midiSpan);
		}
		if (viewport.projection === 'linear-hz') {
			return viewport.minFrequencyHz + t * hzSpan;
		}
		return Math.pow(2, logMin + t * logSpan);
	};

	return {
		viewport,
		pitchAreaHeight: area,
		timeToX: (time) => (time - viewport.startBeat) * viewport.pixelsPerBeat,
		xToTime: (x) => viewport.startBeat + x / viewport.pixelsPerBeat,
		frequencyToY,
		yToFrequency,
		timeWindow: () => ({
			from: viewport.startBeat,
			to: viewport.startBeat + viewport.width / viewport.pixelsPerBeat
		}),
		frequencyWindow: () => ({
			min: viewport.minFrequencyHz,
			max: viewport.maxFrequencyHz
		}),
		pixelsPerOctave: () => {
			if (viewport.pitchMap === 'piano') return (area / midiSpan) * 12;
			const octaveSpan = Math.log2(2);
			return (area / logSpan) * octaveSpan;
		}
	};
}

/* --------------------------------------------------------------- grid steps */

const BEAT_STEPS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

/** Smallest beat step whose on-screen spacing clears `minPixels`. */
export function timeGridStep(pixelsPerBeat: number, minPixels = 56): number {
	for (const step of BEAT_STEPS) {
		if (step * pixelsPerBeat >= minPixels) return step;
	}
	return BEAT_STEPS[BEAT_STEPS.length - 1];
}

/** Subdivisions drawn between labelled ticks. */
export function timeSubdivisionStep(step: number): number {
	return step / 4;
}

/** Frequency ticks chosen so labels never collide. */
export function frequencyTicks(
	transform: Transform,
	minSpacingPixels = 34,
	maxTicks = 40
): number[] {
	const { min, max } = transform.frequencyWindow();
	if (transform.viewport.pitchMap === 'piano') {
		// one tick per semitone, thinned by spacing
		const from = Math.ceil(hzToMidi(min));
		const to = Math.floor(hzToMidi(max));
		const step = Math.max(
			1,
			Math.ceil(minSpacingPixels / Math.max(transform.pixelsPerOctave() / 12, 0.5))
		);
		const ticks: number[] = [];
		for (let note = to; note >= from; note -= step) ticks.push(midiToHz(note));
		return ticks.slice(0, maxTicks);
	}

	const ticks: number[] = [];
	if (transform.viewport.projection === 'linear-hz') {
		const rawStep = (max - min) / maxTicks;
		const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rawStep, 1e-6))));
		const step = Math.max(magnitude, Math.ceil(rawStep / magnitude) * magnitude);
		for (let hz = Math.ceil(min / step) * step; hz <= max; hz += step) ticks.push(hz);
		return ticks;
	}

	// decade-ish log ticks: 1, 2, 5 within each power of ten
	const bases = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
	for (let decade = -1; decade <= 5 && ticks.length < maxTicks; decade++) {
		const power = Math.pow(10, decade);
		for (const base of bases) {
			const hz = base * power;
			if (hz < min || hz > max) continue;
			const y = transform.frequencyToY(hz);
			const previous = ticks[ticks.length - 1];
			if (
				previous !== undefined &&
				Math.abs(transform.frequencyToY(previous) - y) < minSpacingPixels
			) {
				continue;
			}
			ticks.push(hz);
		}
	}
	return ticks;
}
