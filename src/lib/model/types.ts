/**
 * Line Synth project model.
 *
 * This module is deliberately free of Svelte and of the DOM. The audio engine,
 * the renderer, persistence and tests all consume these types, so nothing here
 * may depend on a component.
 *
 * Coordinates are model coordinates only:
 *   time      -> beats (never seconds, never pixels)
 *   frequency -> Hz     (never MIDI note numbers)
 * Pixels exist exclusively inside `$lib/editor`.
 */

export type Id = string;

/* ------------------------------------------------------------------ pitch */

export type PitchRepresentation = 'absolute-hz' | 'scale-relative';

export interface Handle {
	/** delta time, beats */
	dt: number;
	/** delta frequency, Hz */
	df: number;
}

export type PointInterpolation = 'linear' | 'smooth' | 'bezier';

/**
 * A scale-relative anchor. Stored alongside `frequency` when a point is drawn
 * on a scale-relative track, so a later Musical State change can re-resolve the
 * pitch without guessing. Absolute-Hz points never carry this.
 */
export interface ScaleRef {
	degree: number;
	octave: number;
	cents: number;
}

export interface CurvePoint {
	id: Id;
	time: number;
	frequency: number;
	interpolation: PointInterpolation;
	inHandle?: Handle;
	outHandle?: Handle;
	scaleRef?: ScaleRef;
}

/* --------------------------------------------------------------- envelope */

export interface Envelope {
	/** seconds */
	attack: number;
	decay: number;
	sustain: number;
	release: number;
}

/* ------------------------------------------------------------------ curve */

/** A voice path: a piecewise pitch curve plus its level/envelope state. */
export interface Curve {
	id: Id;
	name: string;
	points: CurvePoint[];
	envelope: Envelope;
	gainDb: number;
	/** -1 .. 1 */
	pan: number;
	muted: boolean;
	/** overrides the track accent when set */
	color?: string;
}

/* ------------------------------------------------------------- automation */

export interface AutomationPoint {
	id: Id;
	time: number;
	value: number;
	interpolation: 'step' | 'linear' | 'smooth' | 'bezier';
}

export type AutomationInterpolation = AutomationPoint['interpolation'];

export interface AutomationLane {
	id: Id;
	/** key into the parameter registry, e.g. 'volume', 'filter.cutoff' */
	target: ParameterKey;
	points: AutomationPoint[];
	enabled: boolean;
	expanded?: boolean;
}

export type ParameterKey = string;

/* ------------------------------------------------------------------ scale */

export interface ScaleDegree {
	degree: number;
	label: string;
	/** cents above the root when the scale is a cents-based definition */
	cents?: number;
	/** exact rational interval, reduced by GCD */
	ratio?: { numerator: number; denominator: number };
	enabled: boolean;
}

export interface ScaleDefinition {
	id: Id;
	name: string;
	/** 0 = C .. 11 = B */
	rootPitchClass: number;
	degrees: ScaleDegree[];
	octaveRatio: number;
	builtIn?: boolean;
}

/* ----------------------------------------------------------------- tuning */

export type TuningMode = '12tet' | 'equal-n' | 'static-ji' | 'dynamic-ji';

export type JIAnchorMode =
	'master-root' | 'manual-chord-root' | 'lowest-active-voice' | 'reference-track' | 'fixed-global';

export interface Ratio {
	numerator: number;
	denominator: number;
}

export interface TuningDefinition {
	mode: TuningMode;
	referenceFrequencyHz: number;
	/** 0 = C .. 11 = B */
	referencePitchClass: number;
	divisionsPerOctave?: number;
	jiRatios?: Ratio[];
	jiAnchorMode?: JIAnchorMode;
	/** chord root used when the anchor is `manual-chord-root` */
	manualChordRootPitchClass?: number;
	jiPrimeLimit?: number;
}

/* --------------------------------------------------------- musical state */

export interface MusicalState {
	rootPitchClass: number;
	scaleId: Id;
	tuning: TuningDefinition;
	snapMode: 'none' | 'note' | 'scale' | 'ji';
	defaultPitchRepresentation: PitchRepresentation;
}

export interface MusicalStateKeyframe {
	id: Id;
	time: number;
	state: MusicalState;
}

export interface PitchTarget {
	/** absolute frequency in Hz */
	frequency: number;
	/** display label, e.g. 'E4' or '5/4' */
	label: string;
	/** 12-TET reference frequency for the same pitch class position */
	tetFrequency: number;
	/** deviation from the 12-TET reference, in cents */
	deviationCents: number;
	/** true when this target comes from a rational JI interval */
	ji: boolean;
	ratio?: Ratio;
	/** index into the scale's enabled degree list */
	degreeIndex: number;
	octave: number;
}

/* ------------------------------------------------------------- wavetables */

export interface ShapePoint {
	id: Id;
	/** 0 .. 1 phase through the cycle */
	phase: number;
	/** -1 .. 1 */
	amplitude: number;
	interpolation: PointInterpolation;
	inHandle?: { dp: number; da: number };
	outHandle?: { dp: number; da: number };
}

export type HarmonicWaveform = 'sine' | 'saw' | 'square' | 'triangle';

export interface HarmonicComponent {
	harmonic: number;
	waveform: HarmonicWaveform;
	/** 0 .. 1 */
	amplitude: number;
	/** 0 .. 2π */
	phaseRadians: number;
	enabled: boolean;
}

export type WavetableFrameSource =
	{ kind: 'shape'; points: ShapePoint[] } | { kind: 'harmonics'; components: HarmonicComponent[] };

export type FrameInterpolation = 'step' | 'linear' | 'smooth';

export interface WavetableFrame {
	id: Id;
	/** 0 .. 1 position along the morph axis */
	position: number;
	source: WavetableFrameSource;
	/** generated cache — never authoritative */
	samples: Float32Array;
	interpolation: FrameInterpolation;
}

export interface Wavetable {
	id: Id;
	name: string;
	/** samples per frame: 256 .. 8192 */
	sampleLength: number;
	defaultInterpolation: 'linear' | 'smooth';
	frames: WavetableFrame[];
	favorite?: boolean;
	builtIn?: boolean;
}

/* ------------------------------------------------------------- instruments */

export type WaveSource =
	'sine' | 'triangle' | 'saw' | 'square' | 'pulse' | 'white-noise' | 'wavetable';

export interface SynthSettings {
	wave: WaveSource;
	wavetableId?: Id;
	/** 0 .. 1 morph position through the wavetable frames */
	wavetablePosition: number;
	pitchOffsetSemitones: number;
	fineCents: number;
	filter: {
		enabled: boolean;
		type: 'lowpass' | 'highpass' | 'bandpass';
		cutoff: number;
		resonance: number;
	};
	drive: number;
	delay: { mix: number; time: number; feedback: number };
	reverb: { mix: number };
	attack: number;
	release: number;
}

export type LfoWaveform = 'sine' | 'triangle' | 'saw-up' | 'saw-down' | 'square';

export interface Lfo {
	id: Id;
	name: string;
	enabled: boolean;
	wave: LfoWaveform;
	/** Hz when unsynced */
	rate: number;
	sync: 'free' | '1/1' | '1/2' | '1/4' | '1/8' | '1/16';
	phaseDegrees: number;
	/** 0 .. 1 */
	amount: number;
	destination: ParameterKey;
}

export interface MixerState {
	volumeDb: number;
	/** -1 .. 1 */
	pan: number;
	mute: boolean;
	solo: boolean;
}

/* ------------------------------------------------------------------ track */

export interface Track {
	id: Id;
	name: string;
	/** one of the --track-N accents */
	color: string;
	pitchRepresentation: PitchRepresentation;
	tuningFollow: 'master' | 'track';
	tuningOverride?: TuningDefinition;
	synth: SynthSettings;
	mixer: MixerState;
	lfos: Lfo[];
	curves: Curve[];
	automationLanes: AutomationLane[];
}

export interface MasterTrack {
	musicalState: MusicalStateKeyframe[];
	automationLanes: AutomationLane[];
	mixer: MixerState;
	synth: Pick<SynthSettings, 'filter' | 'drive' | 'delay' | 'reverb'>;
}

/* --------------------------------------------------------- editor / misc */

export type PitchMap = 'piano' | 'frequency';
export type FrequencyProjection = 'logarithmic' | 'linear-hz';

export type SnapTimeMode =
	| 'none'
	| 'bar'
	| 'beat'
	| '1/2'
	| '1/4'
	| '1/8'
	| '1/16'
	| '1/32'
	| 'triplet'
	| 'dotted'
	| 'custom';

export type SnapPitchMode = 'none' | 'note' | 'scale' | 'ji' | 'octave';

export interface EditorSettings {
	pitchMap: PitchMap;
	frequencyProjection: FrequencyProjection;
	showPianoOverlay: boolean;
	snapTime: SnapTimeMode;
	snapPitch: SnapPitchMode;
	customSnapTicks: number;
	minFrequencyHz: number;
	maxFrequencyHz: number;
}

export interface Marker {
	id: Id;
	time: number;
	label: string;
	color?: string;
}

export interface TimeSignature {
	numerator: number;
	denominator: number;
}

export interface LoopRegion {
	enabled: boolean;
	start: number;
	end: number;
}

export interface Project {
	version: number;
	id: Id;
	name: string;
	tempo: number;
	timeSignature: TimeSignature;
	durationBeats: number;
	editorSettings: EditorSettings;
	tracks: Track[];
	master: MasterTrack;
	wavetables: Wavetable[];
	scales: ScaleDefinition[];
	markers: Marker[];
	loop: LoopRegion;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectSummary {
	id: Id;
	name: string;
	updatedAt: number;
	trackCount: number;
}

/* ------------------------------------------------------- parameter targets */

export interface ParameterDefinition {
	key: ParameterKey;
	label: string;
	group: 'mix' | 'filter' | 'fx' | 'pitch' | 'modulation' | 'source';
	min: number;
	max: number;
	defaultValue: number;
	unit: '' | 'Hz' | 'dB' | '%' | 's' | 'st' | '¢';
	/** how the automation lane draws and interpolates its vertical axis */
	scale: 'linear' | 'logarithmic';
	scope: 'master' | 'track' | 'both';
}
