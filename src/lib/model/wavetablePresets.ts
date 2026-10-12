/**
 * Premade wavetable presets.
 *
 * Every preset is built from additive harmonic components rather than baked
 * samples, because harmonic frames interpolate numerically in the morph: a
 * table swept from 0 to 1 stays clean instead of crossfading two arbitrary
 * waveforms. The morph carries the sound design — kick and 808 move from
 * transient to sub, snare from crack to body, hats from bright to thin,
 * handpan from strike to the long tail.
 *
 * Randomness is seeded, so a preset is byte-identical every time it is built.
 */

import type { HarmonicComponent, Wavetable, WavetableFrame } from './types';
import { clamp } from './pitch';
import { createFrame, createWavetable } from './wavetable';

/** Deterministic mulberry32 PRNG so presets never change between builds. */
function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Amplitude for harmonic `n` from a spectral shape function. Everything is
 * clamped into 0..1 because the editor treats amplitude as a fraction of full
 * scale.
 */
function spectrum(
	count: number,
	amplitudeOf: (n: number, index: number) => number,
	phaseOf?: (n: number, index: number) => number
): HarmonicComponent[] {
	return Array.from({ length: count }, (_, index) => {
		const n = index + 1;
		const amplitude = clamp(amplitudeOf(n, index), 0, 1);
		return {
			harmonic: n,
			waveform: 'sine' as const,
			amplitude,
			phaseRadians: phaseOf ? clamp(phaseOf(n, index), 0, Math.PI * 2) : 0,
			enabled: amplitude > 1e-4
		};
	});
}

/** Seeded random-phase spectrum with a `tilt` falloff; odd partials get a
 *  metallic accent so noise frames still read as pitched metal, not static. */
function noisySpectrum(
	count: number,
	tilt: number,
	seed: number,
	oddAccent = 1
): HarmonicComponent[] {
	const random = rng(seed);
	return spectrum(
		count,
		(n) => {
			const wobble = 0.55 + 0.45 * random();
			const odd = n % 2 === 1 ? oddAccent : 1;
			return Math.pow(n, -tilt) * wobble * odd;
		},
		() => random() * Math.PI * 2
	);
}

function harmonicFrame(position: number, components: HarmonicComponent[]): WavetableFrame {
	return createFrame({ kind: 'harmonics', components }, position);
}

/* -------------------------------------------------------------- presets */

function handpan(): Wavetable {
	// Handpan partials cluster around the fundamental with a strong 2nd and
	// 4th (the "ding" and its octave/tone fields). The morph decays the upper
	// modes the way a struck shell settles into its lowest mode.
	const strike = spectrum(32, (n) => {
		const base: Record<number, number> = {
			1: 1,
			2: 0.62,
			3: 0.34,
			4: 0.4,
			5: 0.07,
			6: 0.24,
			7: 0.05,
			8: 0.16,
			9: 0.04,
			10: 0.11,
			11: 0.03,
			12: 0.08,
			13: 0.02,
			14: 0.05,
			15: 0.02,
			16: 0.04
		};
		if (base[n] !== undefined) return base[n];
		return 0.05 * Math.pow(0.82, n - 17);
	});
	const bloom = spectrum(32, (n) => {
		const base: Record<number, number> = { 1: 1, 2: 0.48, 3: 0.2, 4: 0.16, 6: 0.07, 8: 0.05 };
		if (base[n] !== undefined) return base[n];
		return 0.02 * Math.pow(0.8, n - 9);
	});
	const tail = spectrum(32, (n) => (n === 1 ? 1 : n === 2 ? 0.14 : n === 3 ? 0.05 : 0.008));
	return createWavetable('Handpan', [
		harmonicFrame(0, strike),
		harmonicFrame(0.5, bloom),
		harmonicFrame(1, tail)
	]);
}

function kick(): Wavetable {
	// Morph 1 → 0 is the classic pitch-drop story: a click-heavy transient
	// collapses into a pure sub. Automate wavetable position downward for the
	// familiar 909-style drop without any pitch automation.
	const click = spectrum(32, (n) => (n <= 8 ? 1 - (n - 1) * 0.1 : 0.34 * Math.pow(0.86, n - 9)));
	const punch = spectrum(32, (n) =>
		n === 1 ? 1 : n === 2 ? 0.22 : n === 3 ? 0.09 : n === 4 ? 0.04 : 0.012
	);
	const sub = spectrum(32, (n) => (n === 1 ? 1 : 0.002));
	return createWavetable('Kick', [
		harmonicFrame(0, click),
		harmonicFrame(0.45, punch),
		harmonicFrame(1, sub)
	]);
}

function eightOhEight(): Wavetable {
	// A saturated sine: drive adds odd harmonics, and easing the morph toward
	// the pure end gives the long sine body every 808 ends in.
	const driven = spectrum(32, (n) => (n % 2 === 1 ? 1 / n : 0.015));
	const mild = spectrum(32, (n) => (n === 1 ? 1 : n === 3 ? 0.14 : n === 5 ? 0.05 : 0.008));
	const pure = spectrum(32, (n) => (n === 1 ? 1 : 0.002));
	return createWavetable('808', [
		harmonicFrame(0, driven),
		harmonicFrame(0.5, mild),
		harmonicFrame(1, pure)
	]);
}

function snare(): Wavetable {
	// Crack → rattle → shell body. The noisy frames use seeded random phases
	// so the snare stays a snare and not a buzzy tone, while the tail keeps
	// the two strong low modes of a struck shell.
	const crack = noisySpectrum(32, 0.7, 1337, 1.15);
	const rattle = noisySpectrum(32, 1.05, 4242, 1.25);
	const body = spectrum(32, (n) => {
		const tone: Record<number, number> = { 1: 1, 2: 0.55, 3: 0.32, 4: 0.12 };
		if (tone[n] !== undefined) return tone[n];
		return n > 10 ? 0.05 * Math.pow(0.9, n - 11) : 0.02;
	});
	return createWavetable('Snare', [
		harmonicFrame(0, crack),
		harmonicFrame(0.5, rattle),
		harmonicFrame(1, body)
	]);
}

function hiHat(): Wavetable {
	// Bright open hat → sealed thin tick. High tilt plus an odd-harmonic
	// accent approximates the metallic cluster of classic analog hats.
	const open = noisySpectrum(32, 0.42, 909, 1.3);
	const closed = spectrum(32, (n) => (n < 6 ? 0.05 : 0.62 * Math.pow(n / 6, -0.8)));
	const tick = spectrum(32, (n) => (n < 8 ? 0.03 : n > 20 ? 0.1 * Math.pow(0.94, n - 21) : 0.22));
	return createWavetable('Hi-Hat', [
		harmonicFrame(0, open),
		harmonicFrame(0.6, closed),
		harmonicFrame(1, tick)
	]);
}

function lush(): Wavetable {
	// A 64-partial pad: dense random phases up front thin into a soft, filtered
	// tail, so automating position reads as the pad opening and closing.
	const bright = noisySpectrum(64, 0.85, 7777, 1.08);
	const open = noisySpectrum(64, 1.15, 2468, 1.05);
	const soft = noisySpectrum(64, 1.5, 1357, 1.02);
	const closed = spectrum(64, (n) => (n <= 6 ? 1 / Math.pow(n, 0.6) : 0.02));
	return createWavetable('Lush', [
		harmonicFrame(0, bright),
		harmonicFrame(0.35, open),
		harmonicFrame(0.7, soft),
		harmonicFrame(1, closed)
	]);
}

export interface WavetablePreset {
	name: string;
	/** one-line description shown in the library picker */
	description: string;
	create: () => Wavetable;
}

export const WAVETABLE_PRESETS: WavetablePreset[] = [
	{
		name: 'Handpan',
		description: 'Bell-like strike that settles into a warm low mode',
		create: handpan
	},
	{
		name: 'Kick',
		description: 'Click transient down to pure sub — sweep the morph down for a pitch drop',
		create: kick
	},
	{
		name: '808',
		description: 'Saturated sine with drive at 0, long pure sub at 1',
		create: eightOhEight
	},
	{
		name: 'Snare',
		description: 'Noisy crack through rattle into shell body',
		create: snare
	},
	{
		name: 'Hi-Hat',
		description: 'Bright open metallic noise to a thin closed tick',
		create: hiHat
	},
	{
		name: 'Lush',
		description: 'Dense 64-partial pad that filters down as the morph rises',
		create: lush
	}
];

/** Fresh instances of every preset. They start as ordinary editable tables:
 *  a preset you added can always be renamed, edited or deleted. */
export function createPresetWavetables(): Wavetable[] {
	return WAVETABLE_PRESETS.map((preset) => preset.create());
}
