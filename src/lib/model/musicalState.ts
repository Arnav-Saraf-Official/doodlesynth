/**
 * Musical State is the single source of truth for root, scale and tuning over
 * time. The Piano Map, the Frequency Map overlay, snapping, inspector readouts
 * and future playback all call these functions, so they cannot disagree.
 */

import { uid } from './ids';
import { centsBetween } from './pitch';
import { findScale } from './scale';
import { DEFAULT_TUNING, cloneTuning, nearestTarget, targetsForState } from './tuning';
import type {
	CurvePoint,
	EditorSettings,
	Id,
	MusicalState,
	MusicalStateKeyframe,
	PitchTarget,
	Project,
	ScaleDefinition,
	ScaleRef
} from './types';

export const DEFAULT_MUSICAL_STATE: MusicalState = {
	rootPitchClass: 0,
	scaleId: 'scale-major',
	tuning: cloneTuning(DEFAULT_TUNING),
	snapMode: 'scale',
	defaultPitchRepresentation: 'absolute-hz'
};

export function createMusicalStateKeyframe(
	time: number,
	state: Partial<MusicalState> = {}
): MusicalStateKeyframe {
	return {
		id: uid('ms'),
		time,
		state: { ...DEFAULT_MUSICAL_STATE, tuning: cloneTuning(DEFAULT_TUNING), ...state }
	};
}

/** Discrete, step-based resolution: the last keyframe at or before `beat`. */
export function resolveMusicalState(project: Project, beat: number): MusicalState {
	const frames = project.master.musicalState;
	if (frames.length === 0) return DEFAULT_MUSICAL_STATE;
	let active = frames[0];
	for (const frame of frames) {
		if (frame.time <= beat) active = frame;
		else break;
	}
	return active.state;
}

export function resolveScale(project: Project, state: MusicalState): ScaleDefinition {
	return findScale(project.scales, state.scaleId);
}

export interface ResolvedPitchContext {
	state: MusicalState;
	scale: ScaleDefinition;
	targets: PitchTarget[];
}

/**
 * Resolve everything pitch-related for a point in time. `beat` may be a single
 * playing position or a bucket start when rendering a range of keyframed state.
 */
export function resolvePitchContext(
	project: Project,
	settings: Pick<EditorSettings, 'minFrequencyHz' | 'maxFrequencyHz'>,
	beat: number
): ResolvedPitchContext {
	const state = resolveMusicalState(project, beat);
	const scale = resolveScale(project, state);
	const targets = targetsForState(state, scale, {
		minFrequencyHz: settings.minFrequencyHz,
		maxFrequencyHz: settings.maxFrequencyHz
	});
	return { state, scale, targets };
}

/**
 * Nearest scale-relative anchor for a frequency, so a scale-relative curve can
 * remember its musical relationship instead of a literal Hz value.
 */
export function scaleRefForFrequency(
	frequency: number,
	state: MusicalState,
	scale: ScaleDefinition
): ScaleRef | undefined {
	const targets = targetsForState(state, scale, {
		minFrequencyHz: frequency / 4,
		maxFrequencyHz: frequency * 4
	});
	const nearest = nearestTarget(frequency, targets);
	if (!nearest) return undefined;
	return {
		degree: nearest.target.degreeIndex,
		octave: nearest.target.octave,
		cents: Math.round(nearest.centsAway * 1000) / 1000
	};
}

/** Re-resolve a stored scale-relative anchor into a literal frequency. */
export function frequencyForScaleRef(
	ref: ScaleRef,
	state: MusicalState,
	scale: ScaleDefinition
): number | undefined {
	const targets = targetsForState(state, scale, {
		minFrequencyHz: 8,
		maxFrequencyHz: 40000
	});
	const match = targets.find(
		(target) => target.degreeIndex === ref.degree && target.octave === ref.octave
	);
	if (!match) return undefined;
	return match.frequency * Math.pow(2, ref.cents / 1200);
}

/**
 * Re-resolve every scale-relative point against the current state.
 *
 * Absolute-Hz points are returned untouched — scale changes must never rewrite
 * a literal curve. This is the invariant most of the tuning system rests on.
 */
export function retunePoints(
	points: CurvePoint[],
	state: MusicalState,
	scale: ScaleDefinition
): CurvePoint[] {
	let changed = false;
	const next = points.map((point) => {
		if (!point.scaleRef) return point;
		const frequency = frequencyForScaleRef(point.scaleRef, state, scale);
		if (frequency === undefined || Math.abs(frequency - point.frequency) < 1e-6) return point;
		changed = true;
		return { ...point, frequency };
	});
	return changed ? next : points;
}

/** Human-readable state summary for a keyframe or the transport readout. */
export function describeMusicalState(state: MusicalState, scale: ScaleDefinition): string {
	const root = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][
		state.rootPitchClass
	];
	return `${root} ${scale.name}`;
}

/** Deviation of a frequency from the nearest target, in cents. */
export function centsFromTarget(frequency: number, targets: PitchTarget[]): number {
	const nearest = nearestTarget(frequency, targets);
	return nearest ? nearest.centsAway : 0;
}

/** Scale degree label a frequency is closest to, for the cursor readout. */
export function degreeLabelAt(frequency: number, targets: PitchTarget[]): string {
	const nearest = nearestTarget(frequency, targets);
	if (!nearest) return '—';
	const { target } = nearest;
	if (target.ji && target.ratio) {
		return `${target.label} ${centsBetween(target.frequency, frequency) >= 0 ? '+' : '−'}${Math.abs(
			centsBetween(target.frequency, frequency)
		).toFixed(1)}¢`;
	}
	return target.label;
}

export function findMusicalStateKeyframe(
	frames: MusicalStateKeyframe[],
	id: Id
): MusicalStateKeyframe | undefined {
	return frames.find((frame) => frame.id === id);
}
