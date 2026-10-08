/**
 * Tuning resolution.
 *
 * Reference convention: `referenceFrequencyHz` is the frequency of
 * `referencePitchClass` in octave 4 (A4 = 440 Hz means pitch class 9). That
 * keeps the reference anchored to a real musical pitch instead of a floating
 * ratio, which matters once Musical State keyframes move the root.
 */

import { centsBetween, midiToHz, hzToMidi, reduceRatio } from './pitch';
import { degreeIntervalCents, equalDivisionDegrees } from './scale';
import type {
	MusicalState,
	PitchTarget,
	Ratio,
	ScaleDefinition,
	ScaleDegree,
	TuningDefinition,
	TuningMode
} from './types';

export const DEFAULT_TUNING: TuningDefinition = {
	mode: '12tet',
	referenceFrequencyHz: 440,
	referencePitchClass: 9,
	divisionsPerOctave: 12,
	jiAnchorMode: 'master-root',
	jiPrimeLimit: 5
};

export const TUNING_MODE_LABELS: Record<TuningMode, string> = {
	'12tet': '12-TET',
	'equal-n': 'Equal division',
	'static-ji': 'Static JI',
	'dynamic-ji': 'Dynamic JI'
};

export const JI_ANCHOR_LABELS: Record<string, string> = {
	'master-root': 'Master Root',
	'manual-chord-root': 'Manual Chord Root',
	'lowest-active-voice': 'Lowest Active Voice',
	'reference-track': 'Reference Track',
	'fixed-global': 'Fixed Global Reference'
};

export function cloneTuning(tuning: TuningDefinition): TuningDefinition {
	return {
		...tuning,
		jiRatios: tuning.jiRatios?.map((ratio) => ({ ...ratio }))
	};
}

/** MIDI number that the tuning's reference frequency corresponds to. */
export function referenceMidi(tuning: TuningDefinition): number {
	return 60 + tuning.referencePitchClass;
}

/** Frequency of an absolute MIDI pitch under this tuning's reference. */
export function midiToTunedHz(midi: number, tuning: TuningDefinition): number {
	return tuning.referenceFrequencyHz * Math.pow(2, (midi - referenceMidi(tuning)) / 12);
}

/** The 12-TET reference frequency used for cents-deviation readouts. */
export function tetFrequencyOf(hz: number, tuning: TuningDefinition): number {
	return midiToHz(
		Math.round(hzToMidi(hz, tuning.referenceFrequencyHz)),
		tuning.referenceFrequencyHz
	);
}

/**
 * Pitch class the ratio grid attaches to.
 *
 * Static JI always attaches to the master root. Dynamic JI attaches to its
 * explicit anchor, which is what makes its targets move when the harmonic
 * context moves.
 */
export function resolveAnchorPitchClass(
	tuning: TuningDefinition,
	scaleRootPitchClass: number
): number {
	if (tuning.mode !== 'dynamic-ji') return scaleRootPitchClass;
	switch (tuning.jiAnchorMode ?? 'master-root') {
		case 'manual-chord-root':
			return tuning.manualChordRootPitchClass ?? scaleRootPitchClass;
		case 'fixed-global':
		case 'master-root':
		case 'lowest-active-voice':
		case 'reference-track':
		default:
			// Automatic anchors are deliberately not implemented: a wrong
			// automatic retune is worse than asking for the harmonic context.
			return scaleRootPitchClass;
	}
}

/** Root frequency for a pitch class in a given octave. */
export function rootFrequency(
	pitchClass: number,
	octave: number,
	tuning: TuningDefinition
): number {
	return midiToTunedHz((octave + 1) * 12 + pitchClass, tuning);
}

function ratioForDegree(
	degree: ScaleDegree,
	index: number,
	tuning: TuningDefinition
): Ratio | undefined {
	const explicit = tuning.jiRatios?.[index];
	if (explicit) return reduceRatio(explicit.numerator, explicit.denominator);
	return degree.ratio;
}

/** Interval multiplier for a scale degree under this tuning. */
function intervalFactorFor(
	degree: ScaleDegree,
	index: number,
	tuning: TuningDefinition
): { factor: number; ratio?: Ratio } {
	if (tuning.mode === 'equal-n') {
		const divisions = Math.max(1, tuning.divisionsPerOctave ?? 12);
		return { factor: Math.pow(2, (index * 1200) / divisions / 1200) };
	}
	if (tuning.mode === 'static-ji' || tuning.mode === 'dynamic-ji') {
		const ratio = ratioForDegree(degree, index, tuning);
		if (ratio) return { factor: ratio.numerator / ratio.denominator, ratio };
		return { factor: Math.pow(2, degreeIntervalCents(degree) / 1200) };
	}
	return { factor: Math.pow(2, degreeIntervalCents(degree) / 1200) };
}

/** Degrees a tuning resolves, which is not always the scale's own list. */
export function degreesForTuning(scale: ScaleDefinition, tuning: TuningDefinition): ScaleDegree[] {
	if (tuning.mode === 'equal-n') {
		return equalDivisionDegrees(
			tuning.divisionsPerOctave ?? 12,
			Math.max(scale.degrees.length, tuning.divisionsPerOctave ?? 12)
		);
	}
	return scale.degrees.filter((degree) => degree.enabled);
}

export interface ResolveTargetsOptions {
	minFrequencyHz: number;
	maxFrequencyHz: number;
	minOctave?: number;
	maxOctave?: number;
}

/**
 * Every tuning target inside the visible frequency window. This single
 * function feeds the Piano Map, the Frequency Map overlay, snapping and
 * inspector readouts so they can never disagree.
 */
export function resolveTargets(
	tuning: TuningDefinition,
	scale: ScaleDefinition,
	scaleRootPitchClass: number,
	options: ResolveTargetsOptions
): PitchTarget[] {
	const anchor = resolveAnchorPitchClass(tuning, scaleRootPitchClass);
	const degrees = degreesForTuning(scale, tuning);
	const targets: PitchTarget[] = [];
	const minOctave = options.minOctave ?? -1;
	const maxOctave = options.maxOctave ?? 9;

	for (let octave = minOctave; octave <= maxOctave; octave++) {
		const octaveRootHz = rootFrequency(anchor, octave, tuning);
		for (let index = 0; index < degrees.length; index++) {
			const degree = degrees[index];
			const { factor, ratio } = intervalFactorFor(degree, index, tuning);
			const frequency = octaveRootHz * factor;
			if (frequency < options.minFrequencyHz || frequency > options.maxFrequencyHz) continue;
			const tetFrequency = tetFrequencyOf(frequency, tuning);
			targets.push({
				frequency,
				label: ratio ? `${ratio.numerator}/${ratio.denominator}` : degree.label,
				tetFrequency,
				deviationCents: centsBetween(tetFrequency, frequency),
				ji: Boolean(ratio),
				ratio,
				degreeIndex: index,
				octave
			});
		}
	}

	targets.sort((a, b) => a.frequency - b.frequency);
	return targets;
}

/** Tuning targets for an already-resolved Musical State. */
export function targetsForState(
	state: MusicalState,
	scale: ScaleDefinition,
	options: ResolveTargetsOptions
): PitchTarget[] {
	return resolveTargets(state.tuning, scale, state.rootPitchClass ?? scale.rootPitchClass, options);
}

/** Best-matching target for a frequency, for snapping and cursor readouts. */
export function nearestTarget(
	frequency: number,
	targets: PitchTarget[]
): { target: PitchTarget; centsAway: number } | null {
	if (targets.length === 0) return null;
	let best: PitchTarget | null = null;
	let bestDistance = Infinity;
	for (const target of targets) {
		const distance = Math.abs(Math.log2(target.frequency / frequency));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = target;
		}
	}
	return best ? { target: best, centsAway: centsBetween(frequency, best.frequency) } : null;
}

/** Compact label for a tuning, used in headers and the cursor readout. */
export function tuningLabel(tuning: TuningDefinition): string {
	if (tuning.mode === 'equal-n') return `${tuning.divisionsPerOctave ?? 12}-EDO`;
	return TUNING_MODE_LABELS[tuning.mode];
}
