/**
 * Scale library. A scale is a data-model concept: Musical State keyframes,
 * snapping, the Piano Map and future playback all resolve pitches through it.
 */

import { centsToApproxRatio, ratioToCents, reduceRatio } from './pitch';
import type { Id, Ratio, ScaleDefinition, ScaleDegree, TuningDefinition } from './types';

function degree(index: number, label: string, cents: number, ratio?: Ratio): ScaleDegree {
	return {
		degree: index,
		label,
		cents: Math.round(cents * 1000) / 1000,
		ratio: ratio ? reduceRatio(ratio.numerator, ratio.denominator) : undefined,
		enabled: true
	};
}

function scale(id: Id, name: string, degrees: ScaleDegree[]): ScaleDefinition {
	return { id, name, rootPitchClass: 0, degrees, octaveRatio: 2, builtIn: true };
}

/** Interval above the root in cents, honouring an exact ratio when present. */
export function degreeIntervalCents(item: ScaleDegree): number {
	if (item.ratio) return ratioToCents(item.ratio.numerator, item.ratio.denominator);
	return item.cents ?? 0;
}

/** Multiplicative interval above the root, exact when a ratio is preferred. */
export function degreeIntervalFactor(item: ScaleDegree, preferRatio: boolean): number {
	if (preferRatio && item.ratio) return item.ratio.numerator / item.ratio.denominator;
	return Math.pow(2, (item.cents ?? 0) / 1200);
}

/**
 * Rotate a scale into one of its modes. Intervals are re-expressed relative to
 * the new root, and rational intervals are divided by the root's interval so
 * the ratio stays exact rather than drifting into a cents approximation.
 */
function mode(source: ScaleDefinition, modeIndex: number, name: string, id: Id): ScaleDefinition {
	const size = source.degrees.length;
	const rootDegree = source.degrees[modeIndex];
	const rootCents = degreeIntervalCents(rootDegree);
	const rootRatio = rootDegree.ratio;
	const degrees: ScaleDegree[] = [];

	for (let i = 0; i < size; i++) {
		const src = source.degrees[(i + modeIndex) % size];
		const wrapped = i + modeIndex >= size;
		let ratio: Ratio | undefined;
		if (src.ratio && rootRatio) {
			ratio = reduceRatio(
				src.ratio.numerator * rootRatio.denominator * (wrapped ? 2 : 1),
				src.ratio.denominator * rootRatio.numerator
			);
		}
		degrees.push(
			degree(i, `${i + 1}`, degreeIntervalCents(src) + (wrapped ? 1200 : 0) - rootCents, ratio)
		);
	}
	return scale(id, name, degrees);
}

const CHROMATIC_LABELS = ['1', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];

const MAJOR = scale(
	'scale-major',
	'Major',
	[
		[0, '1', { numerator: 1, denominator: 1 }],
		[203.91, '2', { numerator: 9, denominator: 8 }],
		[386.31, '3', { numerator: 5, denominator: 4 }],
		[498.04, '4', { numerator: 4, denominator: 3 }],
		[701.96, '5', { numerator: 3, denominator: 2 }],
		[884.36, '6', { numerator: 5, denominator: 3 }],
		[1088.27, '7', { numerator: 15, denominator: 8 }]
	].map(([cents, label, ratio], index) =>
		degree(index, label as string, cents as number, ratio as Ratio)
	)
);

const SEEDS: ScaleDefinition[] = [
	scale(
		'scale-chromatic',
		'Chromatic',
		CHROMATIC_LABELS.map((label, index) => degree(index, label, index * 100))
	),
	MAJOR,
	mode(MAJOR, 5, 'Natural Minor', 'scale-natural-minor'),
	scale('scale-harmonic-minor', 'Harmonic Minor', [
		degree(0, '1', 0, { numerator: 1, denominator: 1 }),
		degree(1, '2', 203.91, { numerator: 9, denominator: 8 }),
		degree(2, '3', 315.64, { numerator: 6, denominator: 5 }),
		degree(3, '4', 498.04, { numerator: 4, denominator: 3 }),
		degree(4, '5', 701.96, { numerator: 3, denominator: 2 }),
		degree(5, '6', 813.69, { numerator: 8, denominator: 5 }),
		degree(6, '7', 1088.27, { numerator: 15, denominator: 8 })
	]),
	scale('scale-melodic-minor', 'Melodic Minor', [
		degree(0, '1', 0, { numerator: 1, denominator: 1 }),
		degree(1, '2', 203.91, { numerator: 9, denominator: 8 }),
		degree(2, '3', 315.64, { numerator: 6, denominator: 5 }),
		degree(3, '4', 498.04, { numerator: 4, denominator: 3 }),
		degree(4, '5', 701.96, { numerator: 3, denominator: 2 }),
		degree(5, '6', 884.36, { numerator: 5, denominator: 3 }),
		degree(6, '7', 1088.27, { numerator: 15, denominator: 8 })
	]),
	scale('scale-major-pentatonic', 'Major Pentatonic', [
		degree(0, '1', 0, { numerator: 1, denominator: 1 }),
		degree(1, '2', 203.91, { numerator: 9, denominator: 8 }),
		degree(2, '3', 386.31, { numerator: 5, denominator: 4 }),
		degree(3, '5', 701.96, { numerator: 3, denominator: 2 }),
		degree(4, '6', 884.36, { numerator: 5, denominator: 3 })
	]),
	scale('scale-minor-pentatonic', 'Minor Pentatonic', [
		degree(0, '1', 0, { numerator: 1, denominator: 1 }),
		degree(1, '♭3', 315.64, { numerator: 6, denominator: 5 }),
		degree(2, '4', 498.04, { numerator: 4, denominator: 3 }),
		degree(3, '5', 701.96, { numerator: 3, denominator: 2 }),
		degree(4, '♭7', 1017.6, { numerator: 9, denominator: 5 })
	]),
	scale('scale-blues', 'Blues', [
		degree(0, '1', 0, { numerator: 1, denominator: 1 }),
		degree(1, '♭3', 315.64, { numerator: 6, denominator: 5 }),
		degree(2, '4', 498.04, { numerator: 4, denominator: 3 }),
		degree(3, '♭5', 600),
		degree(4, '5', 701.96, { numerator: 3, denominator: 2 }),
		degree(5, '♭7', 1017.6, { numerator: 9, denominator: 5 })
	]),
	mode(MAJOR, 1, 'Dorian', 'scale-dorian'),
	mode(MAJOR, 2, 'Phrygian', 'scale-phrygian'),
	mode(MAJOR, 3, 'Lydian', 'scale-lydian'),
	mode(MAJOR, 4, 'Mixolydian', 'scale-mixolydian'),
	mode(MAJOR, 6, 'Locrian', 'scale-locrian')
];

export function createBuiltInScales(): ScaleDefinition[] {
	return SEEDS.map((item) => ({
		...item,
		degrees: item.degrees.map((entry) => ({
			...entry,
			ratio: entry.ratio ? { ...entry.ratio } : undefined
		}))
	}));
}

export function findScale(scales: ScaleDefinition[], id: Id): ScaleDefinition {
	return scales.find((item) => item.id === id) ?? scales[0];
}

export function enabledDegrees(item: ScaleDefinition): ScaleDegree[] {
	return item.degrees.filter((entry) => entry.enabled);
}

/** New editable scale seeded with every 12-TET semitone. */
export function createEditableScale(name: string, rootPitchClass = 0): ScaleDefinition {
	return {
		id: `scale-${Math.random().toString(36).slice(2, 9)}`,
		name,
		rootPitchClass,
		octaveRatio: 2,
		degrees: CHROMATIC_LABELS.map((label, index) => ({
			degree: index,
			label,
			cents: index * 100,
			enabled: true
		}))
	};
}

/** N-EDO degree set, used by tuning modes that ignore the scale's cents. */
export function equalDivisionDegrees(divisions: number, count = 12): ScaleDegree[] {
	const safeDivisions = Math.max(1, Math.round(divisions));
	return Array.from({ length: count }, (_, index) =>
		degree(index, `${index + 1}`, (index * 1200) / safeDivisions)
	);
}

/**
 * Rational approximation of a cents value for the scale editor. Callers must
 * present this as approximate, never as an exact fraction.
 */
export function approximateRatioForCents(cents: number, maxDenominator = 64) {
	return centsToApproxRatio(cents, maxDenominator);
}

/** True when the tuning resolves scale degrees through rational intervals. */
export function scaleUsesRatios(tuning: TuningDefinition): boolean {
	return tuning.mode === 'static-ji' || tuning.mode === 'dynamic-ji';
}
