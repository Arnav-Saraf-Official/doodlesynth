/**
 * Snapping.
 *
 * Pitch snapping is time dependent: it resolves targets through the Musical
 * State active at the editing position, so the same gesture snaps differently
 * before and after a scale-change keyframe. Snapping only decides where an
 * editing gesture lands; it never rewrites existing curve data.
 */

import { hzToMidi, midiToHz, clamp } from '../model/pitch';
import type { PitchTarget, SnapPitchMode, SnapTimeMode, TimeSignature } from '../model/types';

export interface TimeSnapOption {
	value: SnapTimeMode;
	label: string;
	short: string;
}

export const TIME_SNAP_OPTIONS: TimeSnapOption[] = [
	{ value: 'none', label: 'None', short: 'OFF' },
	{ value: 'bar', label: 'Bar', short: '1 BAR' },
	{ value: 'beat', label: 'Beat', short: '1/4' },
	{ value: '1/2', label: '1/2 note', short: '1/2' },
	{ value: '1/4', label: '1/4 note', short: '1/4' },
	{ value: '1/8', label: '1/8 note', short: '1/8' },
	{ value: '1/16', label: '1/16 note', short: '1/16' },
	{ value: '1/32', label: '1/32 note', short: '1/32' },
	{ value: 'triplet', label: 'Triplet', short: '1/3' },
	{ value: 'dotted', label: 'Dotted', short: 'dotted' },
	{ value: 'custom', label: 'Custom ticks', short: 'custom' }
];

export const PITCH_SNAP_OPTIONS: { value: SnapPitchMode; label: string }[] = [
	{ value: 'none', label: 'None' },
	{ value: 'note', label: 'Nearest 12-TET note' },
	{ value: 'scale', label: 'Scale notes' },
	{ value: 'ji', label: 'JI scale targets' },
	{ value: 'octave', label: 'Octave' }
];

/** Step in beats for a time snap mode. */
export function timeSnapStep(
	mode: SnapTimeMode,
	timeSignature: TimeSignature,
	customTicks: number,
	ticksPerBeat = 480
): number {
	switch (mode) {
		case 'none':
			return 0;
		case 'bar':
			return (timeSignature.numerator * 4) / timeSignature.denominator;
		case 'beat':
		case '1/4':
			return 1;
		case '1/2':
			return 2;
		case '1/8':
			return 0.5;
		case '1/16':
			return 0.25;
		case '1/32':
			return 0.125;
		case 'triplet':
			return 1 / 3;
		case 'dotted':
			return 0.375;
		case 'custom':
			return customTicks / ticksPerBeat;
		default:
			return 0;
	}
}

export interface SnapTimeOptions {
	mode: SnapTimeMode;
	timeSignature: TimeSignature;
	customTicks?: number;
	ticksPerBeat?: number;
	/** Ctrl/Cmd held: snapping is bypassed for this gesture */
	bypass?: boolean;
}

export function snapTime(time: number, options: SnapTimeOptions): number {
	if (options.bypass || options.mode === 'none') return time;
	const step = timeSnapStep(
		options.mode,
		options.timeSignature,
		options.customTicks ?? 120,
		options.ticksPerBeat ?? 480
	);
	if (step <= 0) return time;
	return Math.round(time / step) * step;
}

export interface SnapFrequencyOptions {
	mode: SnapPitchMode;
	targets: PitchTarget[];
	referenceHz: number;
	bypass?: boolean;
}

/** Nearest 12-TET note frequency. */
export function snapToNote(hz: number, referenceHz: number): number {
	return midiToHz(Math.round(hzToMidi(hz, referenceHz)), referenceHz);
}

/** Nearest octave of the reference pitch. */
export function snapToOctave(hz: number, referenceHz: number): number {
	if (hz <= 0) return referenceHz;
	const octaves = Math.round(Math.log2(hz / referenceHz));
	return referenceHz * Math.pow(2, octaves);
}

function nearestTargetBy(
	hz: number,
	targets: PitchTarget[],
	filter: (target: PitchTarget) => boolean
): number | null {
	let best: number | null = null;
	let bestDistance = Infinity;
	for (const target of targets) {
		if (!filter(target)) continue;
		const distance = Math.abs(Math.log2(target.frequency / hz));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = target.frequency;
		}
	}
	return best;
}

export function snapFrequency(hz: number, options: SnapFrequencyOptions): number {
	if (options.bypass || options.mode === 'none') return hz;
	switch (options.mode) {
		case 'note':
			return snapToNote(hz, options.referenceHz);
		case 'octave':
			return snapToOctave(hz, options.referenceHz);
		case 'scale':
			return (
				nearestTargetBy(hz, options.targets, () => true) ?? snapToNote(hz, options.referenceHz)
			);
		case 'ji': {
			const ji = nearestTargetBy(hz, options.targets, (target) => target.ji);
			if (ji !== null) return ji;
			return nearestTargetBy(hz, options.targets, () => true) ?? hz;
		}
		default:
			return hz;
	}
}

/** Snap a pitch-reset target so octave snapping stays inside the project range. */
export function clampFrequency(hz: number, min: number, max: number): number {
	return clamp(hz, min, max);
}
