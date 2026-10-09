/**
 * Web Audio playback.
 *
 * The project stays the single source of truth: pitch curves are continuous
 * functions of beat, automation lanes are functions of beat, and the transport
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

import { sampleLane } from '#lib/model/automation';
import { curveBounds, sampleFrequencyAt } from '#lib/model/curve';
import { findParameter } from '#lib/model/parameters';
import { findWavetable, renderFrameSource, renderWavetableAt } from '#lib/model/wavetable';
import type {
	AutomationLane,
	Curve,
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

export interface EngineDebug {
	playing: boolean;
	contextState: string;
	audioTime: number;
	peak: number;
	voices: number;
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
	shaper: WaveShaperNode;
	gain: GainNode;
	panner: StereoPannerNode;
	delaySend: GainNode;
	reverbSend: GainNode;
}

interface Voice {
	curveId: string;
	trackId: string;
	source: AudioScheduledSourceNode;
	gain: GainNode;
	/** automation-controlled pitch rate, null for noise sources */
	pitch: AudioParam | null;
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
	delay: DelayNode;
	delayFeedback: GainNode;
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

	constructor(ctx: BaseAudioContext, project: Project, startBeat: number, startTime: number) {
		this.ctx = ctx;
		this.project = project;
		this.startBeat = startBeat;
		this.startTime = startTime;
		this.startSeconds = (startBeat * 60) / Math.max(project.tempo, 1);
		this.pulse = pulseWave(ctx);
		this.master = createMasterChain(ctx);
		this.master.limiter.connect(this.master.analyser);
		this.master.analyser.connect(ctx.destination);
		this.analyserData = new Float32Array(this.master.analyser.fftSize);
		if (project.tracks.some((track) => track.synth.wave === 'white-noise')) {
			this.noiseBuffer = whiteNoiseBuffer(ctx);
		}
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
				`${track.id}:${track.synth.wave}:${track.synth.wavetableId ?? ''}:${Number(
					track.synth.wavetablePosition.toFixed(2)
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

	private createVoice(track: Track, curve: Curve): Voice | null {
		const ctx = this.ctx;
		const synth = track.synth;
		const bounds = curveBounds(curve.points);
		const gain = ctx.createGain();
		gain.gain.value = 0;

		const key = `${track.id}:${curve.id}:${synth.wave}:${synth.wavetableId ?? ''}:${Number(
			synth.wavetablePosition.toFixed(2)
		)}`;

		let source: AudioScheduledSourceNode;
		let pitch: AudioParam | null = null;
		const phase = phaseFraction(curve);
		let startOffset = 0;

		if (synth.wave === 'white-noise') {
			if (!this.noiseBuffer) return null;
			const noise = ctx.createBufferSource();
			noise.buffer = this.noiseBuffer;
			noise.loop = true;
			source = noise;
		} else if (synth.wave === 'wavetable') {
			const table = this.tableFor(synth);
			if (!table) return null;
			const cycle = ctx.createBufferSource();
			cycle.buffer = tableCycle(ctx, table, synth.wavetablePosition);
			cycle.loop = true;
			pitch = cycle.playbackRate;
			// offset into the looping cycle is an exact phase shift
			if (phase > 0) startOffset = phase * cycle.buffer.duration;
			source = cycle;
		} else {
			const oscillator = ctx.createOscillator();
			if (phase > 0) oscillator.setPeriodicWave(phaseShiftedWave(ctx, synth.wave, phase));
			else if (synth.wave === 'pulse') oscillator.setPeriodicWave(this.pulse);
			else if (synth.wave === 'saw') oscillator.type = 'sawtooth';
			else oscillator.type = synth.wave;
			pitch = oscillator.frequency;
			source = oscillator;
		}

		source.connect(gain);
		try {
			if (startOffset > 0) (source as AudioBufferSourceNode).start(this.startTime, startOffset);
			else source.start(this.startTime);
		} catch {
			return null;
		}
		return {
			curveId: curve.id,
			trackId: track.id,
			source,
			gain,
			pitch,
			bounds,
			wave: synth.wave,
			wavetablePosition: synth.wavetablePosition,
			key
		};
	}

	private rebuildVoices(): void {
		for (const voice of this.voices) {
			try {
				voice.source.stop();
			} catch {
				// already stopped
			}
			voice.gain.disconnect();
			voice.source.disconnect();
		}
		this.voices.length = 0;
		this.tracks.clear();
		this.lastDrive.clear();

		let budget = MAX_VOICES;
		for (const track of this.project.tracks) {
			if (!this.audible(track) || budget <= 0) continue;
			const chain = createTrackChain(this.ctx, track, this.master);
			this.tracks.set(track.id, chain);
			for (const curve of track.curves) {
				if (budget <= 0) break;
				if (curve.points.length === 0 || curve.muted) continue;
				const voice = this.createVoice(track, curve);
				if (!voice) continue;
				voice.gain.connect(chain.input);
				this.voices.push(voice);
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

	/** Pitch of a voice in Hz at a context time, including track tune offsets. */
	private voicePitch(voice: Voice, time: number): number {
		const track = this.trackById(voice.trackId);
		const curve = this.curveOf(voice);
		if (!track || !curve) return 440;
		const beat = this.beatAtTime(time);
		const lanes = track.automationLanes;
		// pitch and tuning are automatable per track, on top of the static values
		const offset = this.laneValue(lanes, 'pitch.offset', track.synth.pitchOffsetSemitones, beat);
		const fine = this.laneValue(lanes, 'pitch.fine', track.synth.fineCents, beat);
		const cents = this.laneValue(lanes, 'tuning.cents', 0, beat);
		const ratio = this.laneValue(lanes, 'tuning.ratio', 1, beat);
		let hz = sampleFrequencyAt(curve.points, beat) * ratio;
		const semis = offset + (fine + cents) / 100;
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
		if (untilEnd < -Math.max(0, curve.envelope.release)) return 0;
		return dbToGain(curve.gainDb) * envelopeLevel(curve, sinceStart, untilEnd);
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
		const nowBeat = this.beatAtTime(from);
		const master = this.project.master;

		/* master bus */
		this.scheduleParam(
			this.master.gain.gain,
			(time) =>
				dbToGain(
					this.laneValue(
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
					this.laneValue(master.automationLanes, 'pan', master.mixer.pan, this.beatAtTime(time)),
					-1,
					1
				),
			from,
			to,
			{ cancel }
		);
		const masterFilter = master.synth.filter;
		if (masterFilter.enabled) {
			this.scheduleParam(
				this.master.filter.frequency,
				(time) =>
					clamp(
						this.laneValue(
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
						this.laneValue(
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
					this.laneValue(
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
					this.laneValue(
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
		this.master.delay.delayTime.value = clamp(master.synth.delay.time, 0.01, 2);
		this.master.delayFeedback.gain.value = clamp(master.synth.delay.feedback, 0, 0.95);
		// master drive is a curve, not a value: refresh when the amount moves
		const masterDrive = this.laneValue(
			master.automationLanes,
			'filter.drive',
			master.synth.drive,
			nowBeat
		);
		const lastMasterDrive = this.lastDrive.get('master') ?? -1;
		if (Math.abs(masterDrive - lastMasterDrive) > 0.005) {
			this.lastDrive.set('master', masterDrive);
			this.master.shaper.curve = driveCurve(clamp(masterDrive, 0, 1));
		}

		/* voices */
		for (const voice of this.voices) {
			this.scheduleParam(voice.gain.gain, (time) => this.voiceLevel(voice, time), from, to, {
				cancel
			});
			if (voice.pitch) {
				this.scheduleParam(
					voice.pitch,
					(time) =>
						voice.wave === 'wavetable' ? this.waveRate(voice, time) : this.voicePitch(voice, time),
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
			this.scheduleParam(
				chain.gain.gain,
				(time) =>
					dbToGain(this.laneValue(lanes, 'volume', track.mixer.volumeDb, this.beatAtTime(time))),
				from,
				to,
				{ cancel }
			);
			this.scheduleParam(
				chain.panner.pan,
				(time) =>
					clamp(this.laneValue(lanes, 'pan', track.mixer.pan, this.beatAtTime(time)), -1, 1),
				from,
				to,
				{ cancel }
			);
			if (synth.filter.enabled) {
				this.scheduleParam(
					chain.filter.frequency,
					(time) =>
						clamp(
							this.laneValue(lanes, 'filter.cutoff', synth.filter.cutoff, this.beatAtTime(time)),
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
							this.laneValue(
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
						this.laneValue(lanes, 'fx.delay.mix', synth.delay.mix, this.beatAtTime(time)),
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
						this.laneValue(lanes, 'fx.reverb.mix', synth.reverb.mix, this.beatAtTime(time)),
						0,
						1
					),
				from,
				to,
				{ cancel }
			);
			// drive is a curve, not a value: refresh it when the amount moved
			const drive = this.laneValue(lanes, 'filter.drive', synth.drive, nowBeat);
			const lastDrive = this.lastDrive.get(trackId) ?? -1;
			if (Math.abs(drive - lastDrive) > 0.005) {
				this.lastDrive.set(trackId, drive);
				chain.shaper.curve = driveCurve(clamp(drive, 0, 1));
			}
		}
	}

	/** Wavetable voices read a looping cycle buffer: rate = f * N / sampleRate. */
	private waveRate(voice: Voice, time: number): number {
		const track = this.trackById(voice.trackId);
		if (!track) return 1;
		const table = this.tableFor(track.synth);
		const length = table?.sampleLength ?? 2048;
		const hz = this.voicePitch(voice, time);
		return clamp((hz * length) / this.ctx.sampleRate, 0.0001, 1024);
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
			try {
				voice.source.stop();
			} catch {
				// already stopped
			}
			voice.source.disconnect();
			voice.gain.disconnect();
		}
		this.voices.length = 0;
		for (const chain of this.tracks.values()) disconnectTrack(chain);
		this.tracks.clear();
		disconnectMaster(this.master);
	}
}

/** One-cycle buffer for a wavetable morph position (Float32Array samples). */
function tableCycle(ctx: BaseAudioContext, table: Wavetable, position: number): AudioBuffer {
	const samples = renderWavetableAt(table, position);
	const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
	buffer.copyToChannel(ownedCopy(samples), 0);
	return buffer;
}

function createMasterChain(ctx: BaseAudioContext): MasterChain {
	const input = ctx.createGain();
	const filter = ctx.createBiquadFilter();
	filter.type = 'lowpass';
	filter.frequency.value = 18000;
	const shaper = ctx.createWaveShaper();
	shaper.curve = driveCurve(0);
	const dry = ctx.createGain();
	const delaySend = ctx.createGain();
	const delay = ctx.createDelay(2);
	delay.delayTime.value = 0.25;
	const delayFeedback = ctx.createGain();
	delayFeedback.gain.value = 0.3;
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

	input.connect(filter);
	filter.connect(shaper);
	shaper.connect(dry);
	dry.connect(gain);
	shaper.connect(delaySend);
	delaySend.connect(delay);
	delay.connect(delayFeedback);
	delayFeedback.connect(delay);
	delay.connect(delayReturn);
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
		delay,
		delayFeedback,
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

function createTrackChain(ctx: BaseAudioContext, track: Track, master: MasterChain): TrackChain {
	const synth = track.synth;
	const input = ctx.createGain();
	const filter = ctx.createBiquadFilter();
	filter.type = synth.filter.type;
	filter.frequency.value = synth.filter.cutoff;
	filter.Q.value = synth.filter.resonance;
	const shaper = ctx.createWaveShaper();
	shaper.curve = driveCurve(synth.drive);
	const gain = ctx.createGain();
	gain.gain.value = dbToGain(track.mixer.volumeDb);
	const panner = ctx.createStereoPanner();
	panner.pan.value = track.mixer.pan;
	const delaySend = ctx.createGain();
	delaySend.gain.value = 0;
	const reverbSend = ctx.createGain();
	reverbSend.gain.value = 0;

	input.connect(filter);
	filter.connect(shaper);
	shaper.connect(gain);
	gain.connect(panner);
	// dry path into the master input, sends into the shared master effects
	panner.connect(master.input);
	panner.connect(delaySend);
	panner.connect(reverbSend);
	delaySend.connect(master.delaySend);
	reverbSend.connect(master.reverbSend);

	return { input, filter, shaper, gain, panner, delaySend, reverbSend };
}

function disconnectTrack(chain: TrackChain): void {
	chain.input.disconnect();
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
	master.delayFeedback.disconnect();
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

	/** Snapshot used for scheduling. Called on every project mutation. */
	setProject(project: Project): void {
		this.project = project;
		if (this.graph && this.timer !== null) {
			// the graph re-reads the live snapshot: rebuild when structure changed
			this.graph.project = project;
			this.graph.maybeRebuild();
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
		const length = Math.max(1, Math.ceil(seconds * OFFLINE_SAMPLE_RATE));
		const OfflineCtor: typeof OfflineAudioContext =
			typeof OfflineAudioContext !== 'undefined'
				? OfflineAudioContext
				: ((globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
						.webkitOfflineAudioContext as typeof OfflineAudioContext);
		const ctx = new OfflineCtor(2, length, OFFLINE_SAMPLE_RATE);
		const graph = new PlaybackGraph(ctx, this.project, fromBeat, 0);
		graph.schedule(0, length / OFFLINE_SAMPLE_RATE, false);
		const rendered = await ctx.startRendering();
		const data = rendered.getChannelData(0);
		let peak = 0;
		let sum = 0;
		for (let i = 0; i < data.length; i++) {
			const value = data[i];
			const magnitude = Math.abs(value);
			if (magnitude > peak) peak = magnitude;
			sum += value * value;
		}
		graph.dispose();
		return { peak, rms: Math.sqrt(sum / data.length), length: data.length };
	}

	debugState(): EngineDebug {
		return {
			playing: this.timer !== null,
			contextState: this.ctx?.state ?? 'none',
			audioTime: this.ctx?.currentTime ?? 0,
			peak: this.graph ? this.graph.peak() : 0,
			voices: this.graph ? this.graph.voices.length : 0
		};
	}
}

export const engine = new SynthEngine();

/** Exported for tests: parameter defaults come from the shared registry. */
export function automationFallback(key: string): number {
	return findParameter(key).defaultValue;
}
