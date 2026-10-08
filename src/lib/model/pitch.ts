/**
 * Pitch mathematics. Everything here is pure and Hz-based; MIDI note numbers
 * are derived for display and snapping only, never stored.
 */

import type { Ratio } from './types';

export const A4_HZ = 440;
export const A4_MIDI = 69;

export const NOTE_NAMES = [
	'C',
	'C#',
	'D',
	'D#',
	'E',
	'F',
	'F#',
	'G',
	'G#',
	'A',
	'A#',
	'B'
] as const;

export function midiToHz(midi: number, referenceHz = A4_HZ): number {
	return referenceHz * Math.pow(2, (midi - A4_MIDI) / 12);
}

export function hzToMidi(hz: number, referenceHz = A4_HZ): number {
	return A4_MIDI + 12 * Math.log2(hz / referenceHz);
}

export function pitchClassOfMidi(midi: number): number {
	return ((Math.round(midi) % 12) + 12) % 12;
}

export function midiToName(midi: number): string {
	const rounded = Math.round(midi);
	const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
	const octave = Math.floor(rounded / 12) - 1;
	return `${name}${octave}`;
}

/** 'F#5' for a frequency, using the round-to-nearest note. */
export function hzToNoteName(hz: number, referenceHz = A4_HZ): string {
	return midiToName(hzToMidi(hz, referenceHz));
}

/**
 * Signed cents between two frequencies. Positive means `b` is sharper than `a`.
 */
export function centsBetween(a: number, b: number): number {
	if (a <= 0 || b <= 0) return 0;
	return 1200 * Math.log2(b / a);
}

/** Cents from the nearest 12-TET note, e.g. `+18` for F#5 + 18¢. */
export function centsFromNearestNote(hz: number, referenceHz = A4_HZ): number {
	if (hz <= 0) return 0;
	return centsBetween(midiToHz(Math.round(hzToMidi(hz, referenceHz)), referenceHz), hz);
}

export function ratioToCents(numerator: number, denominator: number): number {
	if (numerator <= 0 || denominator <= 0) return 0;
	return 1200 * Math.log2(numerator / denominator);
}

export function centsToRatioFloat(cents: number): number {
	return Math.pow(2, cents / 1200);
}

export function gcd(a: number, b: number): number {
	a = Math.abs(Math.round(a));
	b = Math.abs(Math.round(b));
	while (b) {
		const t = b;
		b = a % b;
		a = t;
	}
	return a || 1;
}

/** Reduce a rational interval by GCD. Rejects non-positive terms. */
export function reduceRatio(numerator: number, denominator: number): Ratio {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
		throw new Error('ratio terms must be finite');
	}
	const n = Math.round(numerator);
	const d = Math.round(denominator);
	if (n <= 0 || d <= 0) throw new Error('ratio terms must be positive integers');
	const g = gcd(n, d);
	return { numerator: n / g, denominator: d / g };
}

/**
 * Continued-fraction rational approximation of a cents value.
 * Always approximate: exact-ratio mode must never present this as exact.
 */
export function centsToApproxRatio(
	cents: number,
	maxDenominator = 64
): { ratio: Ratio; centsError: number } {
	const target = centsToRatioFloat(cents);
	let best = { numerator: 1, denominator: 1, error: Infinity };
	let lowerN = 0;
	let lowerD = 1;
	let upperN = 1;
	let upperD = 0;

	for (let i = 0; i < 40; i++) {
		const mediantN = lowerN + upperN;
		const mediantD = lowerD + upperD;
		if (mediantD > maxDenominator) break;
		const value = mediantN / mediantD;
		const error = Math.abs(value - target);
		if (error < best.error) best = { numerator: mediantN, denominator: mediantD, error };
		if (value < target) {
			lowerN = mediantN;
			lowerD = mediantD;
		} else if (value > target) {
			upperN = mediantN;
			upperD = mediantD;
		} else {
			break;
		}
	}

	const ratio = reduceRatio(best.numerator, best.denominator);
	return { ratio, centsError: centsBetween(ratio.numerator / ratio.denominator, target) };
}

/** Largest prime factor, used to bound JI ratio complexity. */
export function primeLimitOf(numerator: number, denominator: number): number {
	const factor = (value: number) => {
		let n = Math.abs(Math.round(value));
		let largest = 1;
		for (let p = 2; p * p <= n; p++) {
			while (n % p === 0) {
				largest = p;
				n /= p;
			}
		}
		return Math.max(largest, n);
	};
	return Math.max(factor(numerator), factor(denominator));
}

/** Shortest signed difference between two angles, in radians. */
export function shortestAngleDelta(from: number, to: number): number {
	const twoPi = Math.PI * 2;
	let delta = (to - from) % twoPi;
	if (delta > Math.PI) delta -= twoPi;
	if (delta < -Math.PI) delta += twoPi;
	return delta;
}

export function clamp(value: number, min: number, max: number): number {
	return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Format a frequency for a precision readout. */
export function formatHz(hz: number, decimals = 2): string {
	return `${hz.toFixed(decimals)} Hz`;
}

export function formatCents(cents: number, decimals = 1): string {
	const sign = cents >= 0 ? '+' : '−';
	return `${sign}${Math.abs(cents).toFixed(decimals)}¢`;
}

export function formatDb(db: number, decimals = 1): string {
	return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(decimals)} dB`;
}

export function dbToGain(db: number): number {
	return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
	return 20 * Math.log10(Math.max(gain, 1e-6));
}

/** beats -> seconds at a tempo. */
export function beatsToSeconds(beats: number, tempo: number): number {
	return (beats * 60) / tempo;
}

export function secondsToBeats(seconds: number, tempo: number): number {
	return (seconds * tempo) / 60;
}

/** mm:ss.mmm transport readout. */
export function formatTimecode(seconds: number, withMillis = true): string {
	const clamped = Math.max(0, seconds);
	const minutes = Math.floor(clamped / 60);
	const secs = Math.floor(clamped % 60);
	const ms = Math.floor((clamped % 1) * 1000);
	const base = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
	return withMillis ? `${base}.${String(ms).padStart(3, '0')}` : base;
}
