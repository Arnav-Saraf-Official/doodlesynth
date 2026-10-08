/**
 * Wavetable synthesis.
 *
 * A frame keeps an authoritative editable `source` and a generated `samples`
 * cache. The synth only ever sees normalized frame collections, so a table
 * authored in the Shape Editor and one authored in the Harmonic Editor are
 * interchangeable downstream.
 *
 * Every rendered component is band limited to Nyquist: a saw selected on H5
 * renders partials 5, 10, 15… only while they stay below the sample rate's
 * Nyquist, and it never creates editor columns the user cannot see.
 */

import { uid } from './ids';
import { clamp, lerp, shortestAngleDelta } from './pitch';
import type {
	FrameInterpolation,
	HarmonicComponent,
	HarmonicWaveform,
	Id,
	ShapePoint,
	Wavetable,
	WavetableFrame,
	WavetableFrameSource
} from './types';

export const SAMPLE_LENGTHS = [256, 512, 1024, 2048, 4096, 8192] as const;
export const HARMONIC_COUNTS = [8, 16, 32, 64, 128] as const;
export const HARMONIC_WAVEFORMS: HarmonicWaveform[] = ['sine', 'saw', 'square', 'triangle'];

export const DEFAULT_SAMPLE_LENGTH = 2048;
export const DEFAULT_HARMONIC_COUNT = 32;

/** Highest harmonic index representable without aliasing for a table length. */
export function maxHarmonic(sampleLength: number): number {
	return Math.max(1, Math.floor(sampleLength / 2) - 1);
}

/* ---------------------------------------------------------------- shape */

export function createShapePoint(phase: number, amplitude: number): ShapePoint {
	return { id: uid('sp'), phase, amplitude, interpolation: 'smooth' };
}

/** Default shape: one full sine cycle as editable points. */
export function createSineShape(points = 16): ShapePoint[] {
	return Array.from({ length: points + 1 }, (_, index) => {
		const phase = index / points;
		return createShapePoint(phase, Math.sin(phase * Math.PI * 2));
	});
}

/** Shape value at a phase in 0..1, interpolated across the cycle seam. */
export function shapeValueAt(points: ShapePoint[], phase: number): number {
	if (points.length === 0) return 0;
	if (points.length === 1) return points[0].amplitude;
	const wrapped = ((phase % 1) + 1) % 1;
	const sorted = [...points].sort((a, b) => a.phase - b.phase);

	let left = sorted.length - 1;
	for (let i = 0; i < sorted.length; i++) {
		if (sorted[i].phase <= wrapped) left = i;
	}
	const right = (left + 1) % sorted.length;
	const a = sorted[left];
	const b = sorted[right];
	const span = (right === 0 ? b.phase + 1 : b.phase) - a.phase;
	if (span <= 0) return a.amplitude;
	const u = clamp((wrapped - a.phase) / span, 0, 1);

	if (a.interpolation === 'bezier' && a.outHandle && b.inHandle) {
		const c1y = a.amplitude + a.outHandle.da;
		const c2y = b.amplitude + b.inHandle.da;
		const mt = 1 - u;
		return (
			mt * mt * mt * a.amplitude +
			3 * mt * mt * u * c1y +
			3 * mt * u * u * c2y +
			u * u * u * b.amplitude
		);
	}
	if (a.interpolation === 'smooth' || b.interpolation === 'smooth') {
		const before = sorted[(left - 1 + sorted.length) % sorted.length];
		const after = sorted[(right + 1) % sorted.length];
		const m0 = ((b.amplitude - before.amplitude) / 2) * 1;
		const m1 = ((after.amplitude - a.amplitude) / 2) * 1;
		const h00 = 2 * u * u * u - 3 * u * u + 1;
		const h10 = u * u * u - 2 * u * u + u;
		const h01 = -2 * u * u * u + 3 * u * u;
		const h11 = u * u * u - u * u;
		return h00 * a.amplitude + h10 * m0 + h01 * b.amplitude + h11 * m1;
	}
	return lerp(a.amplitude, b.amplitude, u);
}

export function renderShape(points: ShapePoint[], sampleLength: number): Float32Array {
	const samples = new Float32Array(sampleLength);
	for (let i = 0; i < sampleLength; i++) {
		samples[i] = shapeValueAt(points, i / sampleLength);
	}
	return samples;
}

/* ------------------------------------------------------------ harmonics */

export function createHarmonicComponents(count: number): HarmonicComponent[] {
	return Array.from({ length: count }, (_, index) => ({
		harmonic: index + 1,
		waveform: 'sine' as HarmonicWaveform,
		amplitude: index === 0 ? 1 : 0,
		phaseRadians: 0,
		enabled: index === 0
	}));
}

export function componentsFromAmplitudes(amplitudes: number[]): HarmonicComponent[] {
	return amplitudes.map((amplitude, index) => ({
		harmonic: index + 1,
		waveform: 'sine' as HarmonicWaveform,
		amplitude: clamp(Math.abs(amplitude), 0, 1),
		phaseRadians: 0,
		enabled: amplitude !== 0
	}));
}

/**
 * Partial series for a component waveform, normalized so the fundamental has
 * amplitude 1. The component's own amplitude and phase are applied by the
 * caller, which is what keeps a "saw on H5" from becoming hidden H10/H15
 * columns in the editor.
 */
function partialSeries(waveform: HarmonicWaveform): { multiple: number; gain: number }[] {
	switch (waveform) {
		case 'saw': {
			const partials: { multiple: number; gain: number }[] = [];
			for (let k = 1; k <= 64; k++)
				partials.push({ multiple: k, gain: (k % 2 === 1 ? 1 : -1) / k });
			return partials;
		}
		case 'square': {
			const partials: { multiple: number; gain: number }[] = [];
			for (let k = 1; k <= 64; k += 2) partials.push({ multiple: k, gain: 1 / k });
			return partials;
		}
		case 'triangle': {
			const partials: { multiple: number; gain: number }[] = [];
			for (let k = 1; k <= 64; k += 2) {
				partials.push({ multiple: k, gain: ((k - 1) / 2) % 2 === 0 ? 1 / (k * k) : -1 / (k * k) });
			}
			return partials;
		}
		case 'sine':
		default:
			return [{ multiple: 1, gain: 1 }];
	}
}

/** Additive synthesis of a harmonic frame, band limited to Nyquist. */
export function renderHarmonics(
	components: HarmonicComponent[],
	sampleLength: number
): Float32Array {
	const samples = new Float32Array(sampleLength);
	const limit = maxHarmonic(sampleLength);

	for (const component of components) {
		if (!component.enabled || component.amplitude === 0) continue;
		const base = Math.max(1, Math.round(component.harmonic));
		for (const partial of partialSeries(component.waveform)) {
			const harmonic = base * partial.multiple;
			if (harmonic > limit) break;
			const gain = component.amplitude * partial.gain;
			const angleStep = (Math.PI * 2 * harmonic) / sampleLength;
			for (let i = 0; i < sampleLength; i++) {
				samples[i] += gain * Math.sin(angleStep * i + component.phaseRadians);
			}
		}
	}
	return samples;
}

/* ----------------------------------------------------------------- frames */

export function renderFrameSource(
	source: WavetableFrameSource,
	sampleLength: number
): Float32Array {
	return source.kind === 'shape'
		? renderShape(source.points, sampleLength)
		: renderHarmonics(source.components, sampleLength);
}

export function createFrame(
	source: WavetableFrameSource,
	position: number,
	interpolation: FrameInterpolation = 'linear'
): WavetableFrame {
	return {
		id: uid('frame'),
		position: clamp(position, 0, 1),
		source,
		samples: renderFrameSource(source, DEFAULT_SAMPLE_LENGTH),
		interpolation
	};
}

export function createSineFrame(position: number): WavetableFrame {
	return createFrame({ kind: 'shape', points: createSineShape() }, position);
}

export function createHarmonicFrame(
	position: number,
	count = DEFAULT_HARMONIC_COUNT
): WavetableFrame {
	return createFrame({ kind: 'harmonics', components: createHarmonicComponents(count) }, position);
}

/** Regenerate a frame's sample cache after its source or the table length changes. */
export function refreshFrameSamples(frame: WavetableFrame, sampleLength: number): WavetableFrame {
	const samples = renderFrameSource(frame.source, sampleLength);
	if (frame.samples.length === sampleLength) {
		const next = new Float32Array(samples);
		return { ...frame, samples: next };
	}
	return { ...frame, samples };
}

export function renderFrame(frame: WavetableFrame, sampleLength: number): Float32Array {
	return renderFrameSource(frame.source, sampleLength);
}

/* ------------------------------------------------------------- morphing */

function raisedCosine(t: number): number {
	return (1 - Math.cos(t * Math.PI)) / 2;
}

/** Blend two sample buffers. `smooth` uses a raised cosine for a softer seam. */
export function blendSamples(
	a: Float32Array,
	b: Float32Array,
	t: number,
	smooth: boolean
): Float32Array {
	const out = new Float32Array(a.length);
	const amount = smooth ? raisedCosine(clamp(t, 0, 1)) : clamp(t, 0, 1);
	for (let i = 0; i < a.length; i++) {
		out[i] = a[i] + (b[i] - a[i]) * amount;
	}
	return out;
}

/** Harmonic components interpolate numerically; phase takes the short way round. */
export function interpolateComponents(
	a: HarmonicComponent[],
	b: HarmonicComponent[],
	t: number
): HarmonicComponent[] {
	const byHarmonic = new Map<number, HarmonicComponent>();
	for (const component of a) byHarmonic.set(component.harmonic, component);
	for (const component of b) {
		if (!byHarmonic.has(component.harmonic)) {
			byHarmonic.set(component.harmonic, {
				...component,
				amplitude: 0,
				enabled: true,
				phaseRadians: component.phaseRadians
			});
		}
	}
	const out: HarmonicComponent[] = [];
	for (const [harmonic, left] of [...byHarmonic.entries()].sort((x, y) => x[0] - y[0])) {
		const right =
			b.find((component) => component.harmonic === harmonic) ??
			({ ...left, amplitude: 0, enabled: true } as HarmonicComponent);
		out.push({
			harmonic,
			// waveform is a discrete choice and is never interpolated; mismatched
			// waveforms are crossfaded by the caller instead
			waveform: t < 0.5 ? left.waveform : right.waveform,
			amplitude: lerp(left.amplitude, right.amplitude, t),
			phaseRadians:
				left.phaseRadians + shortestAngleDelta(left.phaseRadians, right.phaseRadians) * t,
			enabled: left.enabled || right.enabled
		});
	}
	return out;
}

function resample(samples: Float32Array, length: number): Float32Array {
	if (samples.length === length) return samples;
	const out = new Float32Array(length);
	const ratio = samples.length / length;
	for (let i = 0; i < length; i++) {
		const source = i * ratio;
		const index = Math.floor(source);
		const frac = source - index;
		const a = samples[index % samples.length];
		const b = samples[(index + 1) % samples.length];
		out[i] = a + (b - a) * frac;
	}
	return out;
}

/**
 * Samples for a morph position across the frame list.
 *
 * Harmonic frames interpolate their components so amplitudes stay numeric and
 * phases stay angular; every other pair crossfades in the sample domain.
 */
export function renderWavetableAt(table: Wavetable, position: number): Float32Array {
	const frames = [...table.frames].sort((a, b) => a.position - b.position);
	const sampleLength = table.sampleLength;
	if (frames.length === 0) return new Float32Array(sampleLength);
	if (frames.length === 1) return renderFrame(frames[0], sampleLength);

	const clamped = clamp(position, 0, 1);
	if (clamped <= frames[0].position) return renderFrame(frames[0], sampleLength);
	const last = frames[frames.length - 1];
	if (clamped >= last.position) return renderFrame(last, sampleLength);

	let index = 0;
	for (let i = 0; i < frames.length - 1; i++) {
		if (frames[i].position <= clamped && frames[i + 1].position >= clamped) {
			index = i;
			break;
		}
	}
	const a = frames[index];
	const b = frames[index + 1];
	const span = b.position - a.position;
	const t = span <= 0 ? 0 : (clamped - a.position) / span;

	const interpolation: FrameInterpolation =
		a.interpolation === b.interpolation ? a.interpolation : table.defaultInterpolation;
	if (interpolation === 'step') return renderFrame(a, sampleLength);

	const smooth = interpolation === 'smooth';
	const sourceA = a.source;
	const sourceB = b.source;
	if (sourceA.kind === 'harmonics' && sourceB.kind === 'harmonics') {
		const mixed = interpolateComponents(sourceA.components, sourceB.components, t);
		const mixedSamples = renderHarmonics(mixed, sampleLength);
		// mismatched waveforms are crossfaded, never interpolated
		const waveformMismatch = sourceA.components.some((component) => {
			const other = sourceB.components.find(
				(candidate) => candidate.harmonic === component.harmonic
			);
			return Boolean(other && other.waveform !== component.waveform && component.enabled);
		});
		if (!waveformMismatch) return mixedSamples;
		// Discrete sources are crossfaded rather than interpolated
		return blendSamples(renderFrame(a, sampleLength), renderFrame(b, sampleLength), t, smooth);
	}

	return blendSamples(
		resample(renderFrame(a, sampleLength), sampleLength),
		resample(renderFrame(b, sampleLength), sampleLength),
		t,
		smooth
	);
}

/* ------------------------------------------------------------- utilities */

export function peakNormalize(samples: Float32Array, target = 1): Float32Array {
	let peak = 0;
	for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
	if (peak === 0) return samples;
	const gain = target / peak;
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
	return out;
}

export function rmsNormalize(samples: Float32Array, target = 0.3): Float32Array {
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	const rms = Math.sqrt(sum / samples.length);
	if (rms === 0) return samples;
	const gain = target / rms;
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
	return out;
}

export function removeDc(samples: Float32Array): Float32Array {
	let sum = 0;
	for (const sample of samples) sum += sample;
	const mean = sum / samples.length;
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
	return out;
}

export function reverseSamples(samples: Float32Array): Float32Array {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[samples.length - 1 - i];
	return out;
}

export function invertSamples(samples: Float32Array): Float32Array {
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = -samples[i];
	return out;
}

/** Rotate phase by a fraction of the cycle, e.g. 0.25 for 90°. */
export function rotatePhase(samples: Float32Array, fraction: number): Float32Array {
	const length = samples.length;
	const offset = ((Math.round(fraction * length) % length) + length) % length;
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) out[i] = samples[(i + offset) % length];
	return out;
}

/* ------------------------------------------------------------ conversion */

/**
 * Harmonics to shape is deterministic because it simply renders the frame.
 * The result is an approximation of the spectrum, not the spectrum itself.
 */
export function convertFrameToShape(frame: WavetableFrame, pointCount = 64): WavetableFrame {
	const samples = renderFrame(frame, 1024);
	const points: ShapePoint[] = [];
	for (let i = 0; i < pointCount; i++) {
		const phase = i / pointCount;
		points.push({
			id: uid('sp'),
			phase,
			amplitude: samples[Math.floor(phase * 1024)],
			interpolation: 'smooth'
		});
	}
	return {
		...frame,
		source: { kind: 'shape', points },
		samples: renderShape(points, frame.samples.length || DEFAULT_SAMPLE_LENGTH)
	};
}

/**
 * Naive DFT analysis of a shape frame. This is an approximation and the UI
 * must label it as such.
 */
export function analyzeFrameToHarmonics(
	frame: WavetableFrame,
	count = DEFAULT_HARMONIC_COUNT,
	sampleLength = 2048
): WavetableFrame {
	const samples = renderFrame(frame, sampleLength);
	const components: HarmonicComponent[] = [];
	const base = Math.max(2, count * 2);
	for (let n = 1; n <= count; n++) {
		let real = 0;
		let imaginary = 0;
		for (let i = 0; i < base; i++) {
			const angle = (Math.PI * 2 * n * i) / base;
			const sample = samples[Math.floor((i / base) * sampleLength)];
			real += sample * Math.cos(angle);
			imaginary += sample * Math.sin(angle);
		}
		// projection of the frame onto this harmonic, expressed as a sine with
		// amplitude and phase so it round-trips back through the additive renderer
		const re = (2 * real) / base;
		const im = (2 * imaginary) / base;
		const magnitude = Math.min(1, Math.hypot(re, im));
		const phase = Math.atan2(re, -im);
		components.push({
			harmonic: n,
			waveform: 'sine',
			amplitude: Number.isFinite(magnitude) ? magnitude : 0,
			phaseRadians: Number.isFinite(phase) ? (phase + Math.PI * 2) % (Math.PI * 2) : 0,
			enabled: magnitude > 1e-4
		});
	}
	return {
		...frame,
		source: { kind: 'harmonics', components },
		samples: renderHarmonics(components, frame.samples.length || sampleLength)
	};
}

/* ------------------------------------------------------------- wavetables */

export function createWavetable(
	name: string,
	frames: WavetableFrame[],
	sampleLength = DEFAULT_SAMPLE_LENGTH
): Wavetable {
	const normalized = frames
		.map((frame) => refreshFrameSamples(frame, sampleLength))
		.sort((a, b) => a.position - b.position);
	return {
		id: uid('wt'),
		name,
		sampleLength,
		defaultInterpolation: 'smooth',
		frames: normalized
	};
}

export function duplicateWavetable(table: Wavetable, name?: string): Wavetable {
	return {
		...table,
		id: uid('wt'),
		name: name ?? `${table.name} copy`,
		builtIn: false,
		frames: table.frames.map((frame) => ({
			...frame,
			id: uid('frame'),
			samples: new Float32Array(frame.samples)
		}))
	};
}

/** Soft saw shape: a hyperbolic-tangent ramp keeps the discontinuity finite. */
function sawShape(softness = 0.15): ShapePoint[] {
	const points: ShapePoint[] = [];
	const resolution = 96;
	for (let i = 0; i <= resolution; i++) {
		const phase = i / resolution;
		const ramp = phase * 2 - 1;
		const softened = Math.tanh(ramp / softness) * 0.65;
		points.push({ id: uid('sp'), phase, amplitude: softened, interpolation: 'smooth' });
	}
	return points;
}

function pulseShape(duty: number): ShapePoint[] {
	return [
		{ id: uid('sp'), phase: 0, amplitude: -1, interpolation: 'linear' },
		{ id: uid('sp'), phase: 0.0001, amplitude: 1, interpolation: 'linear' },
		{ id: uid('sp'), phase: duty, amplitude: 1, interpolation: 'linear' },
		{ id: uid('sp'), phase: duty + 0.0001, amplitude: -1, interpolation: 'linear' },
		{ id: uid('sp'), phase: 1, amplitude: -1, interpolation: 'linear' }
	];
}

/**
 * Dense decaying spectrum for presets: Vital-style tables carry dozens of
 * partials rather than a handful, so morphs stay rich across the whole range.
 */
function spectrumFrame(count: number, tilt: number, seed: number): HarmonicComponent[] {
	return Array.from({ length: count }, (_, index) => {
		const n = index + 1;
		const wobble = 0.7 + 0.3 * Math.abs(Math.sin(n * seed));
		const amplitude = clamp(Math.pow(n, -tilt) * wobble, 0, 1);
		return {
			harmonic: n,
			waveform: 'sine' as HarmonicWaveform,
			amplitude,
			phaseRadians: 0,
			enabled: amplitude > 1e-3
		};
	});
}

/** Built-in preset tables shipped with the library. */
export function createBuiltInWavetables(): Wavetable[] {
	const warmMotion = createWavetable('Warm Motion', [
		createFrame({ kind: 'harmonics', components: spectrumFrame(24, 1.5, 1.7) }, 0),
		createFrame({ kind: 'harmonics', components: spectrumFrame(32, 1.1, 2.3) }, 0.5),
		createFrame({ kind: 'harmonics', components: spectrumFrame(48, 0.75, 3.1) }, 1)
	]);

	const metallicSweep = createWavetable('Metallic Sweep', [
		createFrame({ kind: 'shape', points: createSineShape(24) }, 0),
		createFrame(
			{
				kind: 'harmonics',
				components: Array.from({ length: 36 }, (_, index) => {
					const n = 1 + index * 2; // odd partials, inharmonic-ish phases
					const amplitude = clamp(0.8 / Math.pow(n, 0.9), 0, 1);
					return {
						harmonic: n,
						waveform: 'sine' as HarmonicWaveform,
						amplitude,
						phaseRadians: (n * 0.53) % (Math.PI * 2),
						enabled: amplitude > 1e-3
					};
				})
			},
			0.6
		),
		createFrame(
			{
				kind: 'harmonics',
				components: Array.from({ length: 32 }, (_, index) => ({
					harmonic: index + 1,
					waveform: (index % 3 === 0 ? 'saw' : 'sine') as HarmonicWaveform,
					amplitude: clamp(0.9 / (index + 1), 0, 1),
					phaseRadians: (index * 0.7) % (Math.PI * 2),
					enabled: true
				}))
			},
			1
		)
	]);

	const pulseMorph = createWavetable('Pulse Morph', [
		createFrame({ kind: 'shape', points: createSineShape(20) }, 0),
		createFrame({ kind: 'shape', points: sawShape() }, 0.33),
		createFrame({ kind: 'shape', points: pulseShape(0.5) }, 0.66),
		createFrame({ kind: 'shape', points: pulseShape(0.12) }, 1)
	]);

	return [warmMotion, metallicSweep, pulseMorph].map((table) => ({ ...table, builtIn: true }));
}

export function findWavetable(tables: Wavetable[], id: Id | undefined): Wavetable | undefined {
	if (!id) return undefined;
	return tables.find((table) => table.id === id);
}

/** Frequency-domain magnitudes for a spectrum preview. */
export function spectrumOf(
	components: HarmonicComponent[],
	count: number
): { harmonic: number; amplitude: number }[] {
	const out: { harmonic: number; amplitude: number }[] = [];
	for (let n = 1; n <= count; n++) {
		const component = components.find((entry) => entry.harmonic === n);
		out.push({ harmonic: n, amplitude: component?.amplitude ?? 0 });
	}
	return out;
}

export type { WavetableFrameSource };
