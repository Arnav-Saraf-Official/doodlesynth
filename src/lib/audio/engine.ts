/**
 * Web Audio playback.
 *
 * The project stays the single source of truth: pitch curves are continuous
 *	functions of beat, automation lanes are	functions of beat, and the transport
 * supplies the beat-to-time mapping. This module turns that data into scheduled
 * AudioParam ramps with a small rolling lookahead, so live playback, editing
 * while playing and the offline render used by tests all read the same values.
 *
 * Design notes:
 * - One voice per curve, so gaps between curves are silent and overlapping
 *   curves on one track play together.
 * - Frequency is phase continuous: every ramp just changes the rate of an
 *   oscillator or a looping buffer, never restarts it, so edits cannot click.
 * - Everything is created lazily from a user gesture (play or preview), which
 *   is what the browser autoplay policy requires.
 */

import { createDelay, createEffectRack, type DelayModule, type EffectRack } from './effects';
import { oscillatorFromSynth } from '#lib/model/soundProfile';
import { sampleLane } from '#lib/model/automation';
import { curveBounds, sampleFrequencyAt } from '#lib/model/curve';
import {
	envelopeValueAt,
	lastTriggerIndex,
	modulateParameter,
	triggerBeatsFor
} from '#lib/model/modEnvelope';
import { findParameter } from '#lib/model/parameters';
import { findWavetable, renderFrameSource, renderWavetableAt } from '#lib/model/wavetable';
import type {
	AutomationLane,
	Curve,
	ModEnvelope,
	OscillatorSettings,
	SoundProfile,
	Project,
	SynthSettings,
	Track,
	Wavetable,
	WavetableFrameSource
} from '#lib/model/types';

/** how far ahead the scheduler writes ramps, in seconds */
const LOOKAHEAD_SECONDS = 0.15;
/** how often the scheduler refreshes, in milliseconds */
const TICK_MS = 25;
/** length of one scheduled ramp segment, in seconds */
const RAMP_CHUNK_SECONDS = 0.05;
const OFFLINE_SAMPLE_RATE = 48000;
/** voices above this count are dropped when a track has too many curves */
const MAX_VOICES = 64;
const MAX_UNISON_VOICES = 16;
export const MAX_SOURCE_NODES = 256;

export interface EngineDebug {
	playing: boolean;
	contextState: string;
	audioTime: number;
	peak: number;
	voices: number;
	sources: number;
}

export interface RenderResult {
	peak: number;
	rms: number;
	length: number;
}

function dbToGain(db: number): number {
	return Math.pow(10, db / 20);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Curve envelope level at `secondsSinceStart` with a release tail after the end. */
function envelopeLevel(curve: Curve, secondsSinceStart: number, secondsUntilEnd: number): number {
	const { attack, decay, sustain, release } = curve.envelope;
	let level: number;
	if (attack > 0 && secondsSinceStart < attack) {
		level = secondsSinceStart / attack;
	} else if (decay > 0 && secondsSinceStart < attack + decay) {
		const progress = (secondsSinceStart - attack) / decay;
		level = 1 + (sustain - 1) * clamp(progress, 0, 1);
	} else {
		level = sustain;
	}
	if (release > 0 && secondsUntilEnd < release) {
		level *= clamp(secondsUntilEnd / release, 0, 1);
	} else if (release <= 0 && secondsUntilEnd < 0) {
		level = 0;
	}
	return Math.max(0, level);
}

/** Pulse wave as harmonic coefficients, duty cycle 25%. */
function pulseWave(ctx: BaseAudioContext): PeriodicWave {
	const harmonics = 64;
	const real = new Float32Array(harmonics + 1);
	const imag = new Float32Array(harmonics + 1);
	const duty = 0.25;
	for (let n = 1; n <= harmonics; n++) {
		// Fourier series of a rectangular pulse train, sine coefficients
		imag[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
	}
	return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Base Fourier coefficients (sine series) for a built-in wave shape. */
function waveCoefficients(wave: SynthSettings['wave'], harmonics = 64) {
	const real = new Float32Array(harmonics + 1);
	const imag = new Float32Array(harmonics + 1);
	const duty = 0.25;
	for (let n = 1; n <= harmonics; n++) {
		if (wave === 'sine') {
			imag[n] = n === 1 ? 1 : 0;
		} else if (wave === 'saw') {
			imag[n] = (2 / (n * Math.PI)) * (n % 2 === 1 ? 1 : -1);
		} else if (wave === 'square') {
			imag[n] = n % 2 === 1 ? 4 / (n * Math.PI) : 0;
		} else if (wave === 'triangle') {
			if (n % 2 === 1) {
				const sign = ((n - 1) / 2) % 2 === 0 ? 1 : -1;
				imag[n] = (8 / (Math.PI * Math.PI)) * (sign / (n * n));
			}
		} else if (wave === 'pulse') {
			imag[n] = (2 / (n * Math.PI)) * Math.sin(Math.PI * n * duty);
		}
	}
	return { real, imag };
}

/** A built-in wave rotated by `phase` (0..1 of a cycle), preserving its shape. */
function phaseShiftedWave(
	ctx: BaseAudioContext,
	wave: SynthSettings['wave'],
	phase: number
): PeriodicWave {
	const { real, imag } = waveCoefficients(wave);
	const shiftedReal = new Float32Array(real.length);
	const shiftedImag = new Float32Array(imag.length);
	for (let n = 1; n < imag.length; n++) {
		const delta = 2 * Math.PI * n * phase;
		shiftedReal[n] = imag[n] * Math.sin(delta);
		shiftedImag[n] = imag[n] * Math.cos(delta);
	}
	return ctx.createPeriodicWave(shiftedReal, shiftedImag, { disableNormalization: false });
}

/**
 * Deterministic initial phase fraction for a voice. Zero randomization (the
 * default) returns 0, so every voice starts at phase 0 and voices that begin
 * together — a branched line especially — reinforce rather than cancel.
 */
function phaseFraction(curve: Curve): number {
	const amount = clamp(curve.phaseRandomization ?? 0, 0, 1);
	if (amount <= 0) return 0;
	// FNV-1a over the curve id: stable across rebuilds so the phase never jitters
	let hash = 2166136261;
	for (let i = 0; i < curve.id.length; i++) {
		hash ^= curve.id.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	const random = ((hash >>> 0) % 100000) / 100000;
	return random * amount;
}

function whiteNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
	const length = Math.floor(ctx.sampleRate * 2);
	const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	let seed = 0x9e3779b9;
	for (let i = 0; i < length; i++) {
		// xorshift so noise is deterministic between the live and offline render
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
	}
	return buffer;
}

function reverbImpulse(ctx: BaseAudioContext): AudioBuffer {
	const seconds = 1.6;
	const length = Math.floor(ctx.sampleRate * seconds);
	const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
	let seed = 0x85ebca6b;
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			seed ^= seed << 13;
			seed ^= seed >>> 17;
			seed ^= seed << 5;
			const decay = Math.pow(1 - i / length, 2.6);
			data[i] = (((seed >>> 0) / 0xffffffff) * 2 - 1) * decay;
		}
	}
	return buffer;
}

/** tanh drive curve; amount 0 is a clean passthrough. */
function driveCurve(amount: number) {
	const size = 1024;
	const curve = new Float32Array(size);
	const drive = 1 + amount * 12;
	for (let i = 0; i < size; i++) {
		const x = (i / (size - 1)) * 2 - 1;
		curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
	}
	return curve;
}

/** Web Audio wants ArrayBuffer-backed views; model samples are ArrayBufferLike. */
function ownedCopy(samples: Float32Array): Float32Array<ArrayBuffer> {
	const owned = new Float32Array(samples.length);
	owned.set(samples);
	return owned;
}

/* ------------------------------------------------------------- graph parts */

interface TrackChain {
	input: GainNode;
	filter: BiquadFilterNode;
	filter2: BiquadFilterNode;
	filterInput: GainNode;
	filter2Input: GainNode;
	rack: EffectRack;
	shaper: WaveShaperNode;
	gain: GainNode;
	panner: StereoPannerNode;
	delaySend: GainNode;
	reverbSend: GainNode;
}

/** One oscillator of a (possibly unison-stacked) voice. */
interface VoiceSource {
	node: AudioScheduledSourceNode;
	/** automation-controlled pitch rate, null for noise sources */
	pitch: AudioParam | null;
	/** unison detune multiplier applied to the voice pitch */
	ratio: number;
	level: GainNode;
	panner: StereoPannerNode;
}

interface Voice {
	curveId: string;
	trackId: string;
	oscillatorIndex: number;
	oscillator: OscillatorSettings;
	sources: VoiceSource[];
	gain: GainNode;
	bounds: { startTime: number; endTime: number };
	wave: SynthSettings['wave'];
	wavetablePosition: number;
	key: string;
}

interface MasterChain {
	input: GainNode;
	filter: BiquadFilterNode;
	shaper: WaveShaperNode;
	dry: GainNode;
	delaySend: GainNode;
	delayModule: DelayModule;
	delayReturn: GainNode;
	reverbSend: GainNode;
	convolver: ConvolverNode;
	reverbReturn: GainNode;
	gain: GainNode;
	panner: StereoPannerNode;
	limiter: DynamicsCompressorNode;
	analyser: AnalyserNode;
}

/**
 * Builds the whole graph on any context (live or offline) and schedules it.
 * The live engine owns one of these while playing; the offline renderer builds
 * a throwaway one and renders it in a single pass.
 */
class PlaybackGraph {
	/** refreshed by the engine on every mutation; the graph re-reads it for scheduling */
	project: Project;
	readonly ctx: BaseAudioContext;
	readonly startTime: number;
	readonly startBeat: number;
	readonly startSeconds: number;
	readonly master: MasterChain;
	readonly tracks = new Map<string, TrackChain>();
	readonly voices: Voice[] = [];
	private readonly noiseBuffer: AudioBuffer | null = null;
	private readonly pulse: PeriodicWave;
	private readonly analyserData: Float32Array<ArrayBuffer> | null;
	private structureKey = '';
	private lastDrive = new Map<string, number>();
	private lastFilterType = new Map<string, string>();
	private tableWaves = new Map<string, PeriodicWave>();
	/** envelope runtimes, recomputed once per schedule window */
	private modEnv = new Map<string, { envelope: ModEnvelope; triggers: number[] }[]>();

	constructor(ctx: BaseAudioContext, project: Project, startBeat: number, startTime: number) {
		this.ctx = ctx;
		this.project = project;
		this.startBeat = startBeat;
		this.startTime = startTime;
		this.startSeconds = (startBeat * 60) / Math.max(project.tempo, 1);
		this.pulse = pulseWave(ctx);
		this.master = createMasterChain(ctx, project);
		this.master.limiter.connect(this.master.analyser);
		this.master.analyser.connect(ctx.destination);
		this.analyserData = new Float32Array(this.master.analyser.fftSize);
		this.noiseBuffer = whiteNoiseBuffer(ctx);
		this.rebuildVoices();
		this.structureKey = this.computeStructureKey();
	}

	/* -------------------------------------------------------- time mapping */

	/** Seconds per beat at the project tempo. */
	get secondsPerBeat(): number {
		return 60 / Math.max(this.project.tempo, 1);
	}

	/** Beat for a context time, honouring the loop when one is enabled. */
	beatAtTime(time: number): number {
		const raw = this.startBeat + (time - this.startTime) / this.secondsPerBeat;
		const loop = this.project.loop;
		const span = loop.end - loop.start;
		if (loop.enabled && span > 0 && raw >= loop.end) {
			return loop.start + ((raw - loop.start) % span);
		}
		return raw;
	}

	/** Context time when the playhead crosses the loop end, or null. */
	private nextWrapTime(fromTime: number): number | null {
		const loop = this.project.loop;
		const span = loop.end - loop.start;
		if (!loop.enabled || span <= 0) return null;
		const beat = this.beatAtTime(fromTime);
		if (beat >= loop.end) return null;
		return fromTime + (loop.end - beat) * this.secondsPerBeat;
	}

	/* ------------------------------------------------------------ structure */

	private audible(track: Track): boolean {
		if (track.mixer.mute) return false;
		const anySolo = this.project.tracks.some((entry) => entry.mixer.solo);
		return !anySolo || track.mixer.solo;
	}

	private computeStructureKey(): string {
		const parts: string[] = [];
		for (const track of this.project.tracks) {
			if (!this.audible(track)) continue;
			const curves = track.curves
				.filter((curve) => curve.points.length > 0 && !curve.muted)
				.map((curve) => `${curve.id}:${Number((curve.phaseRandomization ?? 0).toFixed(3))}`);
			if (curves.length === 0) continue;
			parts.push(
				JSON.stringify([
					track.synth.oscillators,
					track.synth.noise,
					track.synth.effects,
					track.synth.filter.enabled,
					track.synth.filter2,
					track.synth.delay.mode,
					track.synth.outputDb
				])
			);
			if (
				track.synth.wave === 'wavetable' ||
				track.synth.oscillators?.some((osc) => osc.wave === 'wavetable')
			)
				parts.push(
					JSON.stringify(
						this.project.wavetables.map((table) => table.frames.map((frame) => frame.source))
					)
				);
			const unison = track.synth.unison;
			parts.push(
				`${track.id}:${track.synth.wave}:${track.synth.wavetableId ?? ''}:${Number(
					track.synth.wavetablePosition.toFixed(2)
				)}:${unison?.voices ?? 1}:${Number((unison?.detuneCents ?? 0).toFixed(1))}:${Number(
					(unison?.phaseSpread ?? 0).toFixed(2)
				)}:${curves.join(',')}`
			);
		}
		return parts.join('|');
	}

	private tableFor(synth: SynthSettings) {
		return (
			findWavetable(this.project.wavetables, synth.wavetableId) ??
			this.project.wavetables[0] ??
			null
		);
	}
	private tableWave(table: Wavetable, position: number, phase: number): PeriodicWave {
		const quantized = Math.round(clamp(position, 0, 1) * 64) / 64;
		const key = `${table.id}:${quantized}:${phase}`;
		const cached = this.tableWaves.get(key);
		if (cached) return cached;
		const samples = renderWavetableAt(table, quantized);
		const real = new Float32Array(129),
			imag = new Float32Array(129);
		for (let n = 1; n < real.length; n++) {
			let r = 0,
				im = 0;
			for (let index = 0; index < samples.length; index++) {
				const angle = (2 * Math.PI * n * index) / samples.length;
				r += samples[index] * Math.cos(angle);
				im += samples[index] * Math.sin(angle);
			}
			r *= 2 / samples.length;
			im *= 2 / samples.length;
			const rotation = 2 * Math.PI * n * phase;
			real[n] = r * Math.cos(rotation) + im * Math.sin(rotation);
			imag[n] = im * Math.cos(rotation) - r * Math.sin(rotation);
		}
		const wave = this.ctx.createPeriodicWave(real, imag, { disableNormalization: true });
		if (this.tableWaves.size > 256) this.tableWaves.clear();
		this.tableWaves.set(key, wave);
		return wave;
	}

	private createVoice(
		track: Track,
		curve: Curve,
		oscillator: OscillatorSettings,
		oscillatorIndex: number
	): Voice | null {
		const ctx = this.ctx;
		const synth = {
			...track.synth,
			wave: oscillator.wave,
			wavetableId: oscillator.wavetableId,
			wavetablePosition: oscillator.wavetablePosition,
			unison: oscillator.unison
		};
		const bounds = curveBounds(curve.points);
		const gain = ctx.createGain();
		gain.gain.value = 0;

		// white noise is already decorrelated per cycle; stacking it adds nothing
		const unison = synth.unison;
		const voiceCount =
			synth.wave === 'white-noise'
				? 1
				: clamp(Math.round(unison?.voices ?? 1), 1, MAX_UNISON_VOICES);
		const detuneCents = clamp(unison?.detuneCents ?? 0, 0, 100);
		const phaseSpread = clamp(unison?.phaseSpread ?? 0, 0, 1);

		const key = `${track.id}:${curve.id}:${synth.wave}:${synth.wavetableId ?? ''}:${Number(
			synth.wavetablePosition.toFixed(2)
		)}:${voiceCount}`;

		const sources: VoiceSource[] = [];
		const basePhase =
			(phaseFraction({
				...curve,
				id: `${curve.id}:${oscillatorIndex}`,
				phaseRandomization: Math.max(curve.phaseRandomization ?? 0, oscillator.phaseRandomization)
			}) +
				oscillator.phase) %
			1;
		for (let index = 0; index < voiceCount; index++) {
			// spread voices evenly across ±detuneCents, centred on the pitch
			const offset = voiceCount === 1 ? 0 : (index / (voiceCount - 1)) * 2 - 1;
			const ratio = Math.pow(2, (offset * detuneCents) / 1200);
			const phase =
				voiceCount === 1 ? basePhase : (basePhase + (index / voiceCount) * phaseSpread) % 1;

			let node: AudioScheduledSourceNode;
			let pitch: AudioParam | null = null;
			const startOffset = 0;

			if (synth.wave === 'white-noise') {
				if (!this.noiseBuffer) return null;
				const noise = ctx.createBufferSource();
				noise.buffer = this.noiseBuffer;
				noise.loop = true;
				node = noise;
			} else if (synth.wave === 'wavetable') {
				const table = this.tableFor(synth);
				if (!table) return null;
				const cycle = ctx.createOscillator();
				cycle.setPeriodicWave(this.tableWave(table, synth.wavetablePosition, phase));
				pitch = cycle.frequency;
				node = cycle;
			} else {
				const oscillator = ctx.createOscillator();
				if (phase > 0) oscillator.setPeriodicWave(phaseShiftedWave(ctx, synth.wave, phase));
				else if (synth.wave === 'pulse') oscillator.setPeriodicWave(this.pulse);
				else if (synth.wave === 'saw') oscillator.type = 'sawtooth';
				else oscillator.type = synth.wave;
				pitch = oscillator.frequency;
				node = oscillator;
			}

			const level = ctx.createGain();
			// Peak-safe normalization: identical in-phase copies equal one voice, not N voices.
			level.gain.value = clamp(oscillator.level, 0, 1) / voiceCount;
			const panner = ctx.createStereoPanner();
			panner.pan.value = clamp(oscillator.pan + offset * (unison.stereoSpread ?? 0), -1, 1);
			node.connect(level).connect(panner).connect(gain);
			try {
				const start = Math.max(this.startTime, ctx.currentTime);
				if (startOffset > 0) (node as AudioBufferSourceNode).start(start, startOffset);
				else node.start(start);
			} catch {
				return null;
			}
			sources.push({ node, pitch, ratio, level, panner });
		}

		return {
			curveId: curve.id,
			trackId: track.id,
			oscillatorIndex,
			oscillator,
			sources,
			gain,
			bounds,
			wave: synth.wave,
			wavetablePosition: synth.wavetablePosition,
			key
		};
	}

	private rebuildVoices(): void {
		for (const voice of this.voices) {
			for (const source of voice.sources) {
				try {
					source.node.stop();
				} catch {
					// already stopped
				}
				source.node.disconnect();
				source.level.disconnect();
				source.panner.disconnect();
			}
			voice.gain.disconnect();
		}
		this.voices.length = 0;
		for (const chain of this.tracks.values()) disconnectTrack(chain);
		this.tracks.clear();
		this.lastDrive.clear();
		this.lastFilterType.clear();
		this.tableWaves.clear();

		let budget = MAX_VOICES;
		let sourceBudget = MAX_SOURCE_NODES;
		for (const track of this.project.tracks) {
			if (!this.audible(track) || budget <= 0) continue;
			const chain = createTrackChain(this.ctx, track, this.master, this.project.tempo);
			this.tracks.set(track.id, chain);
			for (const curve of track.curves) {
				if (budget <= 0) break;
				if (curve.points.length === 0 || curve.muted) continue;
				const oscillators = track.synth.oscillators ?? [oscillatorFromSynth(track.synth)];
				const noise = track.synth.noise;
				const layers = [...oscillators];
				if (noise?.enabled)
					layers.push({
						...oscillatorFromSynth(track.synth),
						wave: 'white-noise',
						level: noise.level,
						pan: noise.pan,
						routing: 'direct'
					});
				const needed = layers
					.filter((osc) => osc.enabled)
					.reduce(
						(sum, osc) =>
							sum +
							(osc.wave === 'white-noise'
								? 1
								: clamp(Math.round(osc.unison.voices), 1, MAX_UNISON_VOICES)),
						0
					);
				// Admit whole notes only; never create a partial unison stack on exhaustion.
				if (needed > sourceBudget) continue;
				for (let index = 0; index < layers.length; index++) {
					const osc = layers[index];
					if (!osc.enabled) continue;
					const voice = this.createVoice(track, curve, osc, index);
					if (!voice) continue;
					voice.gain.connect(
						osc.routing === 'filter1'
							? chain.filterInput
							: osc.routing === 'filter2'
								? chain.filter2Input
								: chain.input
					);
					this.voices.push(voice);
					sourceBudget -= voice.sources.length;
				}
				budget -= 1;
			}
		}
	}

	/** Structural changes (new curve, wave change) need fresh sources. */
	maybeRebuild(): void {
		const key = this.computeStructureKey();
		if (key === this.structureKey) return;
		this.structureKey = key;
		this.rebuildVoices();
	}

	/* ------------------------------------------------------------ sampling */

	private trackById(id: string): Track | undefined {
		return this.project.tracks.find((track) => track.id === id);
	}

	/**
	 * The biquad type is discrete, so it is applied out of band rather than
	 * scheduled. A disabled filter is forced fully transparent — otherwise a
	 * filter that was last heard at 300 Hz keeps cutting after it is switched
	 * off, which was the master-bus bug.
	 */
	private syncFilterType(
		chain: BiquadFilterNode,
		key: string,
		type: BiquadFilterType,
		enabled: boolean
	): void {
		const desired: BiquadFilterType = enabled ? type : 'allpass';
		if (this.lastFilterType.get(key) !== desired) {
			this.lastFilterType.set(key, desired);
			chain.type = desired;
		}
		if (enabled) return;
		const now = this.ctx.currentTime;
		chain.frequency.cancelScheduledValues(now);
		chain.Q.cancelScheduledValues(now);
		chain.frequency.value = 20000;
		chain.Q.value = 0.0001;
	}

	private curveOf(voice: Voice): Curve | undefined {
		return this.trackById(voice.trackId)?.curves.find((curve) => curve.id === voice.curveId);
	}

	private laneValue(
		lanes: AutomationLane[],
		target: string,
		fallback: number,
		beat: number
	): number {
		const lane = lanes.find((entry) => entry.target === target && entry.enabled);
		if (!lane || lane.points.length === 0) return fallback;
		return sampleLane(lane, beat);
	}

	/**
	 * Recompute envelope runtimes once per schedule window: trigger detection
	 * walks curve points, which is far too cheap to do per audio sample but
	 * still worth hoisting out of the sampler closures.
	 */
	private refreshModEnvelopes(): void {
		this.modEnv.clear();
		const build = (envelopes: ModEnvelope[] | undefined, curves: Curve[]) => {
			const list = (envelopes ?? []).filter((envelope) => envelope.enabled);
			return list.map((envelope) => {
				const triggers = triggerBeatsFor(curves, envelope.trigger);
				triggers.sort((a, b) => a - b);
				return { envelope, triggers };
			});
		};
		const master = build(
			this.project.master.modEnvelopes,
			this.project.tracks.flatMap((track) => track.curves)
		);
		if (master.length) this.modEnv.set('master', master);
		for (const track of this.project.tracks) {
			const list = build(track.modEnvelopes, track.curves);
			if (list.length) this.modEnv.set(track.id, list);
		}
	}

	/** Automation value with every enabled envelope for `scopeId` folded in. */
	private envelopedValue(
		scopeId: string,
		lanes: AutomationLane[],
		key: string,
		fallback: number,
		beat: number
	): number {
		const base = this.laneValue(lanes, key, fallback, beat);
		const runtimes = this.modEnv.get(scopeId);
		let mod = 0;
		const track = this.trackById(scopeId);
		for (const lfo of track?.lfos ?? []) {
			if (!lfo.enabled || lfo.destination !== key) continue;
			const rate =
				lfo.sync === 'free'
					? lfo.rate
					: 1 /
						((Number(lfo.sync.split('/')[0]) / Number(lfo.sync.split('/')[1])) *
							4 *
							this.secondsPerBeat);
			const phase = (((beat * this.secondsPerBeat * rate + lfo.phaseDegrees / 360) % 1) + 1) % 1;
			const value =
				lfo.wave === 'triangle'
					? 1 - 4 * Math.abs(phase - 0.5)
					: lfo.wave === 'square'
						? phase < 0.5
							? 1
							: -1
						: lfo.wave === 'saw-up'
							? phase * 2 - 1
							: lfo.wave === 'saw-down'
								? 1 - phase * 2
								: Math.sin(phase * Math.PI * 2);
			mod += value * lfo.amount;
		}
		for (const runtime of runtimes ?? []) {
			if (runtime.envelope.destination !== key) continue;
			const index = lastTriggerIndex(runtime.triggers, beat);
			if (index < 0) continue;
			const level = envelopeValueAt(runtime.envelope, beat - runtime.triggers[index]);
			if (level > 0) mod += level * runtime.envelope.amount;
		}
		if (mod === 0) return base;
		return modulateParameter(key, base, mod);
	}

	/** Pitch of a voice in Hz at a context time, including track tune offsets. */
	private voicePitch(voice: Voice, time: number): number {
		const track = this.trackById(voice.trackId);
		const curve = this.curveOf(voice);
		if (!track || !curve) return 440;
		const beat = this.beatAtTime(time);
		const lanes = track.automationLanes;
		// pitch and tuning are automatable per track, on top of the static values
		const offset = this.envelopedValue(
			track.id,
			lanes,
			'pitch.offset',
			track.synth.pitchOffsetSemitones,
			beat
		);
		const fine = this.envelopedValue(track.id, lanes, 'pitch.fine', track.synth.fineCents, beat);
		const cents = this.laneValue(lanes, 'tuning.cents', 0, beat);
		const ratio = this.laneValue(lanes, 'tuning.ratio', 1, beat);
		let hz = sampleFrequencyAt(curve.points, beat) * ratio;
		const semis =
			offset + voice.oscillator.transpose + (fine + cents + voice.oscillator.fineCents) / 100;
		if (semis !== 0) hz *= Math.pow(2, semis / 12);
		return clamp(hz, 0.01, 20000);
	}

	/** Level of a voice's envelope at a context time. */
	private voiceLevel(voice: Voice, time: number): number {
		const curve = this.curveOf(voice);
		const track = this.trackById(voice.trackId);
		if (!curve || !track || curve.muted || !this.audible(track)) return 0;
		const beat = this.beatAtTime(time);
		if (beat < voice.bounds.startTime) return 0;
		const sinceStart = (beat - voice.bounds.startTime) * this.secondsPerBeat;
		const untilEnd = (voice.bounds.endTime - beat) * this.secondsPerBeat;
		// the release tail may ring past the last point; everything else stops
		if (untilEnd < -Math.max(0, track.synth.envelope?.release ?? curve.envelope.release)) return 0;
		const patchEnvelope = track.synth.envelope;
		const envelopeCurve = patchEnvelope ? { ...curve, envelope: patchEnvelope } : curve;
		return dbToGain(curve.gainDb) * envelopeLevel(envelopeCurve, sinceStart, untilEnd);
	}

	/* ----------------------------------------------------------- scheduling */

	private scheduleParam(
		param: AudioParam,
		sampler: (time: number) => number,
		from: number,
		to: number,
		options: { cancel?: boolean } = {}
	): void {
		if (to <= from) return;
		if (options.cancel !== false) param.cancelScheduledValues(from);
		param.setValueAtTime(sampler(from), from);
		let cursor = from;
		let guard = 0;
		while (cursor < to - 1e-4 && guard++ < 64) {
			const next = Math.min(to, cursor + RAMP_CHUNK_SECONDS);
			param.linearRampToValueAtTime(sampler(next), next);
			cursor = next;
		}
	}

	/** Schedule every automatable parameter for [from, to]. */
	schedule(from: number, to: number, cancel = true): void {
		if (to <= from) return;
		this.refreshModEnvelopes();
		const nowBeat = this.beatAtTime(from);
		const master = this.project.master;

		/* master bus */
		this.scheduleParam(
			this.master.gain.gain,
			(time) =>
				dbToGain(
					this.envelopedValue(
						'master',
						master.automationLanes,
						'volume',
						master.mixer.volumeDb,
						this.beatAtTime(time)
					)
				),
			from,
			to,
			{ cancel }
		);
		this.scheduleParam(
			this.master.panner.pan,
			(time) =>
				clamp(
					this.envelopedValue(
						'master',
						master.automationLanes,
						'pan',
						master.mixer.pan,
						this.beatAtTime(time)
					),
					-1,
					1
				),
			from,
			to,
			{ cancel }
		);
		const masterFilter = master.synth.filter;
		this.master.filter.gain.value = masterFilter.gainDb ?? 0;
		this.syncFilterType(this.master.filter, 'master', masterFilter.type, masterFilter.enabled);
		this.master.input.disconnect();
		if (masterFilter.enabled) this.master.input.connect(this.master.filter);
		else this.master.input.connect(this.master.shaper);
		if (masterFilter.enabled) {
			this.scheduleParam(
				this.master.filter.frequency,
				(time) =>
					clamp(
						this.envelopedValue(
							'master',
							master.automationLanes,
							'filter.cutoff',
							masterFilter.cutoff,
							this.beatAtTime(time)
						),
						20,
						20000
					),
				from,
				to,
				{ cancel }
			);
			this.scheduleParam(
				this.master.filter.Q,
				(time) =>
					clamp(
						this.envelopedValue(
							'master',
							master.automationLanes,
							'filter.resonance',
							masterFilter.resonance,
							this.beatAtTime(time)
						),
						0.0001,
						30
					),
				from,
				to,
				{ cancel }
			);
		}
		this.scheduleParam(
			this.master.delaySend.gain,
			(time) =>
				clamp(
					this.envelopedValue(
						'master',
						master.automationLanes,
						'fx.delay.mix',
						master.synth.delay.mix,
						this.beatAtTime(time)
					),
					0,
					1
				),
			from,
			to,
			{ cancel }
		);
		this.scheduleParam(
			this.master.reverbSend.gain,
			(time) =>
				clamp(
					this.envelopedValue(
						'master',
						master.automationLanes,
						'fx.reverb.mix',
						master.synth.reverb.mix,
						this.beatAtTime(time)
					),
					0,
					1
				),
			from,
			to,
			{ cancel }
		);
		// master delay time / feedback are plain settings, not lanes
		this.master.delayModule.update(master.synth.delay, this.project.tempo, 1);
		// master drive is a curve, not a value: refresh when the amount moves
		const masterDrive = this.envelopedValue(
			'master',
			master.automationLanes,
			'filter.drive',
			master.synth.drive,
			nowBeat
		);
		const lastMasterDrive = this.lastDrive.get('master') ?? -1;
		if (Math.abs(masterDrive - lastMasterDrive) > 0.005) {
			this.lastDrive.set('master', masterDrive);
			this.master.shaper.curve = masterDrive <= 0 ? null : driveCurve(clamp(masterDrive, 0, 1));
		}

		/* voices */
		for (const voice of this.voices) {
			this.scheduleParam(voice.gain.gain, (time) => this.voiceLevel(voice, time), from, to, {
				cancel
			});
			if (voice.wave === 'wavetable') {
				const track = this.trackById(voice.trackId);
				const table = this.tableFor({
					...(track?.synth ?? this.project.tracks[0].synth),
					wavetableId: voice.oscillator.wavetableId
				});
				const position = track
					? clamp(
							this.envelopedValue(
								track.id,
								track.automationLanes,
								'wavetable.position',
								voice.oscillator.wavetablePosition,
								nowBeat
							),
							0,
							1
						)
					: voice.oscillator.wavetablePosition;
				if (table && Math.round(position * 64) !== Math.round(voice.wavetablePosition * 64)) {
					voice.wavetablePosition = position;
					for (let index = 0; index < voice.sources.length; index++) {
						const phase =
							(phaseFraction({
								...this.curveOf(voice)!,
								id: `${voice.curveId}:${voice.oscillatorIndex}`,
								phaseRandomization: voice.oscillator.phaseRandomization
							}) +
								voice.oscillator.phase +
								(index / voice.sources.length) * voice.oscillator.unison.phaseSpread) %
							1;
						(voice.sources[index].node as OscillatorNode).setPeriodicWave(
							this.tableWave(table, position, phase)
						);
					}
				}
			}
			for (const source of voice.sources) {
				if (!source.pitch) continue;
				this.scheduleParam(
					source.pitch,
					(time) => this.voicePitch(voice, time) * source.ratio,
					from,
					to,
					{ cancel }
				);
			}
		}

		/* per track chains */
		for (const [trackId, chain] of this.tracks) {
			const track = this.trackById(trackId);
			if (!track) continue;
			const synth = track.synth;
			const lanes = track.automationLanes;
			this.syncFilterType(chain.filter, trackId, synth.filter.type, synth.filter.enabled);
			chain.filter.gain.value = synth.filter.gainDb ?? 0;
			const filter2 = synth.filter2;
			if (filter2) {
				chain.filter2.type = filter2.type;
				chain.filter2.frequency.value = clamp(filter2.cutoff, 20, 20000);
				chain.filter2.Q.value = clamp(filter2.resonance, 0, 30);
				chain.filter2.gain.value = filter2.gainDb ?? 0;
			}
			const delayMix = this.envelopedValue(
				trackId,
				lanes,
				'fx.delay.mix',
				synth.effects?.find((effect) => effect.kind === 'delay')?.mix ?? 0,
				nowBeat
			);
			chain.rack.delay?.update(synth.delay, this.project.tempo, delayMix);
			if (chain.rack.reverb) {
				const mix = clamp(
					this.envelopedValue(
						trackId,
						lanes,
						'fx.reverb.mix',
						synth.effects?.find((effect) => effect.kind === 'reverb')?.mix ?? 0,
						nowBeat
					),
					0,
					1
				);
				chain.rack.reverb.wet.gain.value = mix;
				chain.rack.reverb.dry.gain.value = 1 - mix;
			}
			this.scheduleParam(
				chain.gain.gain,
				(time) =>
					dbToGain(
						this.envelopedValue(
							trackId,
							lanes,
							'volume',
							track.mixer.volumeDb + (synth.outputDb ?? 0),
							this.beatAtTime(time)
						)
					),
				from,
				to,
				{ cancel }
			);
			this.scheduleParam(
				chain.panner.pan,
				(time) =>
					clamp(
						this.envelopedValue(trackId, lanes, 'pan', track.mixer.pan, this.beatAtTime(time)),
						-1,
						1
					),
				from,
				to,
				{ cancel }
			);
			if (synth.filter.enabled) {
				this.scheduleParam(
					chain.filter.frequency,
					(time) =>
						clamp(
							this.envelopedValue(
								trackId,
								lanes,
								'filter.cutoff',
								synth.filter.cutoff,
								this.beatAtTime(time)
							),
							20,
							20000
						),
					from,
					to,
					{ cancel }
				);
				this.scheduleParam(
					chain.filter.Q,
					(time) =>
						clamp(
							this.envelopedValue(
								trackId,
								lanes,
								'filter.resonance',
								synth.filter.resonance,
								this.beatAtTime(time)
							),
							0.0001,
							30
						),
					from,
					to,
					{ cancel }
				);
			}
			this.scheduleParam(
				chain.delaySend.gain,
				(time) =>
					clamp(
						this.envelopedValue(trackId, lanes, 'fx.delay.mix', 0, this.beatAtTime(time)),
						0,
						1
					),
				from,
				to,
				{ cancel }
			);
			this.scheduleParam(
				chain.reverbSend.gain,
				(time) =>
					clamp(
						this.envelopedValue(trackId, lanes, 'fx.reverb.mix', 0, this.beatAtTime(time)),
						0,
						1
					),
				from,
				to,
				{ cancel }
			);
			// drive is a curve, not a value: refresh it when the amount moved
			const drive = this.envelopedValue(trackId, lanes, 'filter.drive', synth.drive, nowBeat);
			const lastDrive = this.lastDrive.get(trackId) ?? -1;
			if (Math.abs(drive - lastDrive) > 0.005) {
				this.lastDrive.set(trackId, drive);
				chain.shaper.curve = drive <= 0 ? null : driveCurve(clamp(drive, 0, 1));
			}
		}
	}

	peak(): number {
		const analyser = this.master.analyser;
		const data = this.analyserData;
		if (!data) return 0;
		analyser.getFloatTimeDomainData(data);
		let peak = 0;
		for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
		return peak;
	}

	dispose(): void {
		for (const voice of this.voices) {
			for (const source of voice.sources) {
				try {
					source.node.stop();
				} catch {
					// already stopped
				}
				source.node.disconnect();
				source.level.disconnect();
				source.panner.disconnect();
			}
			voice.gain.disconnect();
		}
		this.voices.length = 0;
		for (const chain of this.tracks.values()) disconnectTrack(chain);
		this.tracks.clear();
		disconnectMaster(this.master);
	}
}

function createMasterChain(ctx: BaseAudioContext, project: Project): MasterChain {
	const input = ctx.createGain();
	const filter = ctx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = 18000;
	const shaper = ctx.createWaveShaper();
	shaper.curve = null;
	const dry = ctx.createGain();
	const delaySend = ctx.createGain();
	const delayModule = createDelay(ctx, { ...project.master.synth.delay, mix: 1 }, project.tempo);
	const delayReturn = ctx.createGain();
	const reverbSend = ctx.createGain();
	const convolver = ctx.createConvolver();
	convolver.buffer = reverbImpulse(ctx);
	const reverbReturn = ctx.createGain();
	const gain = ctx.createGain();
	gain.gain.value = 0.9;
	const panner = ctx.createStereoPanner();
	const limiter = ctx.createDynamicsCompressor();
	limiter.threshold.value = -6;
	limiter.knee.value = 6;
	limiter.ratio.value = 12;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.2;
	const analyser = ctx.createAnalyser();
	analyser.fftSize = 2048;

	filter.connect(shaper);
	if (project.master.synth.filter.enabled) input.connect(filter);
	else input.connect(shaper);
	shaper.connect(dry);
	dry.connect(gain);
	shaper.connect(delaySend);
	delaySend.connect(delayModule.input);
	delayModule.output.connect(delayReturn);
	delayReturn.connect(gain);
	shaper.connect(reverbSend);
	reverbSend.connect(convolver);
	convolver.connect(reverbReturn);
	reverbReturn.connect(gain);
	gain.connect(panner);
	panner.connect(limiter);

	return {
		input,
		filter,
		shaper,
		dry,
		delaySend,
		delayModule,
		delayReturn,
		reverbSend,
		convolver,
		reverbReturn,
		gain,
		panner,
		limiter,
		analyser
	};
}

function createTrackChain(
	ctx: BaseAudioContext,
	track: Track,
	master: MasterChain,
	tempo: number
): TrackChain {
	const synth = track.synth;
	const input = ctx.createGain();
	const filterInput = ctx.createGain();
	const filter2Input = ctx.createGain();
	const filter2 = ctx.createBiquadFilter();
	const legacyEffects = [];
	if (synth.delay.mix > 0)
		legacyEffects.push({
			id: 'legacy-delay',
			kind: 'delay' as const,
			enabled: true,
			mix: synth.delay.mix,
			params: {}
		});
	if (synth.reverb.mix > 0)
		legacyEffects.push({
			id: 'legacy-reverb',
			kind: 'reverb' as const,
			enabled: true,
			mix: synth.reverb.mix,
			params: { decay: 1.6, preDelay: 0, damping: 12000 }
		});
	const rack = createEffectRack(ctx, synth.effects ?? legacyEffects, synth.delay, tempo);
	const filter = ctx.createBiquadFilter();
	filter.type = synth.filter.type;
	filter.frequency.value = synth.filter.cutoff;
	filter.Q.value = synth.filter.resonance;
	const shaper = ctx.createWaveShaper();
	shaper.curve = synth.drive > 0 ? driveCurve(synth.drive) : null;
	const gain = ctx.createGain();
	gain.gain.value = dbToGain(track.mixer.volumeDb);
	const panner = ctx.createStereoPanner();
	panner.pan.value = track.mixer.pan;
	const delaySend = ctx.createGain();
	delaySend.gain.value = 0;
	const reverbSend = ctx.createGain();
	reverbSend.gain.value = 0;

	// Real bypass paths: disabled filters do not process the source at all.
	if (synth.filter.enabled) filterInput.connect(filter).connect(input);
	else filterInput.connect(input);
	if (synth.filter2?.enabled) filter2Input.connect(filter2).connect(input);
	else filter2Input.connect(input);
	input.connect(shaper).connect(rack.input);
	rack.output.connect(gain);
	gain.connect(panner);
	// dry path into the master input, sends into the shared master effects
	panner.connect(master.input);
	panner.connect(delaySend);
	panner.connect(reverbSend);
	// Patch effects are independent insert racks, never shared master sends.

	return {
		input,
		filter,
		filter2,
		filterInput,
		filter2Input,
		rack,
		shaper,
		gain,
		panner,
		delaySend,
		reverbSend
	};
}

function disconnectTrack(chain: TrackChain): void {
	chain.input.disconnect();
	chain.filterInput.disconnect();
	chain.filter2Input.disconnect();
	chain.filter2.disconnect();
	chain.rack.dispose();
	chain.filter.disconnect();
	chain.shaper.disconnect();
	chain.gain.disconnect();
	chain.panner.disconnect();
	chain.delaySend.disconnect();
	chain.reverbSend.disconnect();
}

function disconnectMaster(master: MasterChain): void {
	master.input.disconnect();
	master.filter.disconnect();
	master.shaper.disconnect();
	master.dry.disconnect();
	master.delaySend.disconnect();
	master.delayModule.dispose();
	master.delayReturn.disconnect();
	master.reverbSend.disconnect();
	master.convolver.disconnect();
	master.reverbReturn.disconnect();
	master.gain.disconnect();
	master.panner.disconnect();
	master.limiter.disconnect();
	master.analyser.disconnect();
}

/* ---------------------------------------------------------------- engine */

class SynthEngine {
	private project: Project | null = null;
	private ctx: AudioContext | null = null;
	private graph: PlaybackGraph | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private scheduledUntil = 0;
	private wantPlay = false;
	private audition: PlaybackGraph | null = null;
	private auditionRequest = 0;
	private auditionTimer: ReturnType<typeof setInterval> | null = null;
	private auditionTimeout: ReturnType<typeof setTimeout> | null = null;

	/** Snapshot used for scheduling. Called on every project mutation. */
	setProject(project: Project): void {
		this.project = project;
		if (this.graph && this.timer !== null) {
			// the graph re-reads the live snapshot: rebuild when structure changed
			this.graph.project = project;
			this.graph.maybeRebuild();
			if (this.ctx) this.scheduledUntil = this.ctx.currentTime;
		}
	}

	isPlaying(): boolean {
		return this.timer !== null;
	}

	/** Audio clock in beats while playing, so the transport can follow it. */
	currentBeat(): number | null {
		if (!this.graph || !this.ctx || this.timer === null) return null;
		return this.graph.beatAtTime(this.ctx.currentTime);
	}

	private async context(): Promise<AudioContext> {
		if (!this.ctx) this.ctx = new AudioContext();
		if (this.ctx.state === 'suspended') await this.ctx.resume();
		return this.ctx;
	}

	/**
	 * Start playback from `fromBeat`. Resolves true when the audio clock is
	 * driving the transport, false when audio could not start (no device, no
	 * gesture, suspended context) so the caller can fall back to a visual clock.
	 */
	async play(fromBeat: number): Promise<boolean> {
		this.wantPlay = true;
		if (!this.project) return false;
		try {
			const ctx = await this.context();
			this.stopGraph();
			if (!this.wantPlay || ctx.state !== 'running') return false;
			this.graph = new PlaybackGraph(ctx, this.project, fromBeat, ctx.currentTime);
			this.scheduledUntil = ctx.currentTime;
			this.tick();
			this.timer = setInterval(() => this.tick(), TICK_MS);
			return true;
		} catch {
			// AudioContext unavailable: the transport falls back to its rAF clock
			return false;
		}
	}

	stop(): void {
		this.wantPlay = false;
		this.stopGraph();
	}

	private stopGraph(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
		if (this.graph) {
			// short fade so stopping mid-wave never clicks
			const gain = this.graph.master.gain.gain;
			const now = this.graph.ctx.currentTime;
			try {
				gain.cancelScheduledValues(now);
				gain.setValueAtTime(gain.value, now);
				gain.linearRampToValueAtTime(0, now + 0.02);
			} catch {
				// context is closing
			}
			const graph = this.graph;
			this.graph = null;
			setTimeout(() => graph.dispose(), 60);
		}
	}

	private tick(): void {
		const graph = this.graph;
		const ctx = this.ctx;
		if (!graph || !ctx || !this.project) return;
		graph.maybeRebuild();
		const now = ctx.currentTime;
		const from = Math.max(this.scheduledUntil, now - 0.01);
		const to = now + LOOKAHEAD_SECONDS;
		if (to > from) graph.schedule(from, to);
		this.scheduledUntil = to;

		// keep the transport on the audio clock, loop aware
		const beat = graph.beatAtTime(now);
		if (this.onBeat) this.onBeat(beat);
	}

	/** transport hook: receives the audio-clock beat on every tick */
	onBeat: ((beat: number) => void) | null = null;

	/* ------------------------------------------------------------ previews */

	/** Audition uses the same graph, layers, modulation and rack as timeline playback. */
	async previewSound(profile: SoundProfile, frequency: number, seconds = 1.5): Promise<void> {
		if (!this.project) throw new Error('No project loaded');
		this.stopPreviewSound();
		const request = this.auditionRequest;
		const ctx = await this.context();
		if (request !== this.auditionRequest) return;
		const durationBeats = seconds / (60 / this.project.tempo);
		const curve: Curve = {
			id: 'audition',
			name: 'Audition',
			points: [
				{ id: 'a', time: 0, frequency, interpolation: 'linear' },
				{ id: 'b', time: durationBeats, frequency, interpolation: 'linear' }
			],
			envelope: profile.synth.envelope ?? {
				attack: profile.synth.attack,
				decay: 0.04,
				sustain: 0.8,
				release: profile.synth.release
			},
			gainDb: 0,
			pan: 0,
			muted: false
		};
		const track: Track = {
			id: 'audition',
			name: profile.name,
			color: '#4da3ff',
			pitchRepresentation: 'absolute-hz',
			tuningFollow: 'master',
			synth: profile.synth,
			lfos: profile.lfos,
			modEnvelopes: profile.modEnvelopes,
			curves: [curve],
			automationLanes: [],
			mixer: { volumeDb: 0, pan: 0, mute: false, solo: false }
		};
		const project: Project = {
			...this.project,
			tracks: [track],
			loop: { ...this.project.loop, enabled: false },
			master: {
				...this.project.master,
				synth: {
					...this.project.master.synth,
					filter: { ...this.project.master.synth.filter, enabled: false },
					drive: 0,
					delay: { ...this.project.master.synth.delay, mix: 0 },
					reverb: { mix: 0 }
				},
				automationLanes: [],
				modEnvelopes: [],
				mixer: { volumeDb: 0, pan: 0, mute: false, solo: false }
			}
		};
		const graph = new PlaybackGraph(ctx, project, 0, ctx.currentTime);
		this.audition = graph;
		const schedule = () => graph.schedule(ctx.currentTime, ctx.currentTime + LOOKAHEAD_SECONDS);
		schedule();
		this.auditionTimer = setInterval(schedule, TICK_MS);
		this.auditionTimeout = setTimeout(
			() => this.stopPreviewSound(),
			(seconds + Math.max(profile.synth.envelope?.release ?? 0.1, 0.1) + 3) * 1000
		);
	}

	stopPreviewSound(): void {
		this.auditionRequest++;
		if (this.auditionTimer) clearInterval(this.auditionTimer);
		if (this.auditionTimeout) clearTimeout(this.auditionTimeout);
		this.auditionTimer = this.auditionTimeout = null;
		this.audition?.dispose();
		this.audition = null;
	}

	analysis(spectrum = false): number[] {
		const graph = this.audition ?? this.graph;
		if (!graph) return [];
		const data = new Float32Array(
			spectrum ? graph.master.analyser.frequencyBinCount : graph.master.analyser.fftSize
		);
		if (spectrum) graph.master.analyser.getFloatFrequencyData(data);
		else graph.master.analyser.getFloatTimeDomainData(data);
		return Array.from(data);
	}

	async previewTone(frequency: number, seconds = 1.2): Promise<void> {
		const ctx = await this.context();
		const oscillator = ctx.createOscillator();
		oscillator.type = 'sine';
		oscillator.frequency.value = clamp(frequency, 1, 20000);
		const gain = ctx.createGain();
		gain.gain.value = 0;
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(0.25, now + 0.01);
		gain.gain.setValueAtTime(0.25, now + Math.max(seconds - 0.08, 0.02));
		gain.gain.linearRampToValueAtTime(0, now + seconds);
		oscillator.connect(gain).connect(this.previewDestination(ctx));
		oscillator.start(now);
		oscillator.stop(now + seconds + 0.02);
		oscillator.onended = () => gain.disconnect();
	}

	async previewWavetable(
		source: WavetableFrameSource,
		sampleLength: number,
		frequency: number,
		seconds = 1.4
	): Promise<void> {
		await this.previewCycle(renderFrameSource(source, sampleLength), frequency, seconds);
	}

	/** Play one rendered wavetable cycle as a looping tone. */
	async previewCycle(samples: Float32Array, frequency: number, seconds = 1.4): Promise<void> {
		if (samples.length === 0) return;
		const ctx = await this.context();
		const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
		buffer.copyToChannel(ownedCopy(samples), 0);
		const player = ctx.createBufferSource();
		player.buffer = buffer;
		player.loop = true;
		player.playbackRate.value = clamp((frequency * samples.length) / ctx.sampleRate, 0.0001, 1024);
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0, now);
		gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
		gain.gain.setValueAtTime(0.3, now + Math.max(seconds - 0.1, 0.02));
		gain.gain.linearRampToValueAtTime(0, now + seconds);
		player.connect(gain).connect(this.previewDestination(ctx));
		player.start(now);
		player.stop(now + seconds + 0.02);
		player.onended = () => gain.disconnect();
	}

	/** previews reuse the master chain when one exists, otherwise the raw output */
	private previewDestination(ctx: BaseAudioContext): AudioNode {
		if (this.graph) return this.graph.master.input;
		return ctx.destination;
	}

	/* -------------------------------------------------------- offline proof */

	/**
	 * Render `seconds` of the project from `fromBeat` without a sound card and
	 * report the level. This is the deterministic proof that the project makes
	 * sound: a silent render means the graph is broken.
	 */
	async renderOffline(fromBeat: number, seconds: number): Promise<RenderResult> {
		if (!this.project) throw new Error('engine has no project');
		const rendered = await this.renderOfflineBuffer(fromBeat, seconds);
		const data = rendered.getChannelData(0);
		let peak = 0,
			sum = 0;
		for (const value of data) {
			peak = Math.max(peak, Math.abs(value));
			sum += value * value;
		}
		return { peak, rms: Math.sqrt(sum / data.length), length: data.length };
	}

	async renderOfflineBuffer(fromBeat: number, seconds: number): Promise<AudioBuffer> {
		if (!this.project) throw new Error('engine has no project');
		const length = Math.max(1, Math.ceil(seconds * OFFLINE_SAMPLE_RATE));
		const OfflineCtor: typeof OfflineAudioContext =
			typeof OfflineAudioContext !== 'undefined'
				? OfflineAudioContext
				: ((globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
						.webkitOfflineAudioContext as typeof OfflineAudioContext);
		const ctx = new OfflineCtor(2, length, OFFLINE_SAMPLE_RATE);
		const graph = new PlaybackGraph(ctx, this.project, fromBeat, 0);
		for (let time = 0; time < seconds; time += LOOKAHEAD_SECONDS)
			graph.schedule(time, Math.min(seconds, time + LOOKAHEAD_SECONDS), false);
		const rendered = await ctx.startRendering();
		graph.dispose();
		return rendered;
	}

	debugState(): EngineDebug {
		return {
			playing: this.timer !== null,
			contextState: this.ctx?.state ?? 'none',
			audioTime: this.ctx?.currentTime ?? 0,
			peak: this.graph ? this.graph.peak() : 0,
			voices: this.graph ? new Set(this.graph.voices.map((voice) => voice.curveId)).size : 0,
			sources: this.graph
				? this.graph.voices.reduce((count, voice) => count + voice.sources.length, 0)
				: 0
		};
	}
}

export const engine = new SynthEngine();

/** Exported for tests: parameter defaults come from the shared registry. */
export function automationFallback(key: string): number {
	return findParameter(key).defaultValue;
}
