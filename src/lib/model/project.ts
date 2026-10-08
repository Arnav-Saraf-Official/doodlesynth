/**
 * Project construction and serialization.
 *
 * The project object is the authoritative state. Svelte components only ever
 * read it through the state layer, and mutation happens through commands.
 */

import { duplicateLanes, createAutomationLane } from './automation';
import { createPoint } from './curve';
import { uid } from './ids';
import { createMusicalStateKeyframe, resolveMusicalState, resolveScale } from './musicalState';
import { DEFAULT_TUNING, cloneTuning } from './tuning';
import { createBuiltInScales } from './scale';
import { createBuiltInWavetables, refreshFrameSamples, DEFAULT_SAMPLE_LENGTH } from './wavetable';
import type {
	Curve,
	EditorSettings,
	Envelope,
	Id,
	Marker,
	MasterTrack,
	MixerState,
	Project,
	SynthSettings,
	Track,
	Wavetable,
	WaveSource
} from './types';

export const PROJECT_VERSION = 1;

export const TRACK_COLORS = [
	'#4da3ff',
	'#3ecf8e',
	'#f2a33d',
	'#f2564f',
	'#c58bf5',
	'#4fd6d6',
	'#e26bc4',
	'#a8b34a'
];

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
	pitchMap: 'piano',
	frequencyProjection: 'logarithmic',
	showPianoOverlay: true,
	snapTime: '1/16',
	// continuous pitch is the point of the editor, so pitch snapping starts off
	snapPitch: 'none',
	customSnapTicks: 120,
	minFrequencyHz: 20,
	maxFrequencyHz: 10000
};

export function createDefaultEnvelope(): Envelope {
	return { attack: 0.01, decay: 0.04, sustain: 0.8, release: 0.1 };
}

export function createDefaultSynth(): SynthSettings {
	return {
		wave: 'saw',
		wavetablePosition: 0,
		pitchOffsetSemitones: 0,
		fineCents: 0,
		filter: { enabled: true, type: 'lowpass', cutoff: 12000, resonance: 1 },
		drive: 0,
		delay: { mix: 0, time: 0.25, feedback: 0.3 },
		reverb: { mix: 0 },
		attack: 0.01,
		release: 0.12
	};
}

export function createDefaultMixer(): MixerState {
	return { volumeDb: 0, pan: 0, mute: false, solo: false };
}

export function createCurve(
	startBeat = 0,
	startFrequency = 220,
	endBeat = 4,
	endFrequency = 440
): Curve {
	return {
		id: uid('curve'),
		name: 'Voice',
		points: [createPoint(startBeat, startFrequency), createPoint(endBeat, endFrequency)],
		envelope: createDefaultEnvelope(),
		gainDb: 0,
		pan: 0,
		muted: false
	};
}

export function createTrack(name: string, colorIndex = 0, wave: WaveSource = 'saw'): Track {
	const synth = createDefaultSynth();
	return {
		id: uid('track'),
		name,
		color: TRACK_COLORS[colorIndex % TRACK_COLORS.length],
		pitchRepresentation: 'absolute-hz',
		tuningFollow: 'master',
		synth: { ...synth, wave },
		mixer: createDefaultMixer(),
		lfos: [],
		curves: [],
		automationLanes: []
	};
}

export function createMasterTrack(): MasterTrack {
	const synth = createDefaultSynth();
	return {
		musicalState: [createMusicalStateKeyframe(0)],
		automationLanes: [],
		mixer: createDefaultMixer(),
		synth: {
			filter: { ...synth.filter },
			drive: synth.drive,
			delay: { ...synth.delay },
			reverb: { ...synth.reverb }
		}
	};
}

export function createDefaultProject(name = 'Untitled', withTrack = false): Project {
	const now = Date.now();
	const project: Project = {
		version: PROJECT_VERSION,
		id: uid('proj'),
		name,
		tempo: 128,
		timeSignature: { numerator: 4, denominator: 4 },
		durationBeats: 64,
		editorSettings: { ...DEFAULT_EDITOR_SETTINGS },
		tracks: [],
		master: createMasterTrack(),
		wavetables: createBuiltInWavetables(),
		scales: createBuiltInScales(),
		markers: [],
		loop: { enabled: false, start: 0, end: 16 },
		createdAt: now,
		updatedAt: now
	};
	if (withTrack) project.tracks.push(createTrack('Lead', 0));
	return project;
}

export function nextTrackColor(project: Project): string {
	return TRACK_COLORS[project.tracks.length % TRACK_COLORS.length];
}

export function findTrack(project: Project, id: Id): Track | undefined {
	return project.tracks.find((track) => track.id === id);
}

export function findCurve(track: Track, id: Id): Curve | undefined {
	return track.curves.find((curve) => curve.id === id);
}

export function duplicateCurve(curve: Curve, offsetBeats = 0): Curve {
	return {
		...curve,
		id: uid('curve'),
		name: `${curve.name} copy`,
		points: curve.points.map((point) => ({
			...point,
			id: uid('pt'),
			time: point.time + offsetBeats
		}))
	};
}

export function duplicateTrack(track: Track): Track {
	return {
		...track,
		id: uid('track'),
		name: `${track.name} copy`,
		mixer: { ...track.mixer, solo: false },
		synth: {
			...track.synth,
			filter: { ...track.synth.filter },
			delay: { ...track.synth.delay },
			reverb: { ...track.synth.reverb }
		},
		lfos: track.lfos.map((lfo) => ({ ...lfo, id: uid('lfo') })),
		curves: track.curves.map((curve) => duplicateCurve(curve)),
		automationLanes: duplicateLanes(track.automationLanes)
	};
}

export function createMarker(time: number, label: string): Marker {
	return { id: uid('marker'), time, label };
}

/** Last beat containing content, ignoring the nominal project duration. */
export function lastContentBeat(project: Project): number {
	let last = 0;
	for (const track of project.tracks) {
		for (const curve of track.curves) {
			for (const point of curve.points) last = Math.max(last, point.time);
		}
		for (const lane of track.automationLanes) {
			for (const point of lane.points) last = Math.max(last, point.time);
		}
	}
	for (const lane of project.master.automationLanes) {
		for (const point of lane.points) last = Math.max(last, point.time);
	}
	for (const frame of project.master.musicalState) last = Math.max(last, frame.time);
	for (const marker of project.markers) last = Math.max(last, marker.time);
	if (project.loop.enabled) last = Math.max(last, project.loop.end);
	return last;
}

/** Grow the project so content always has trailing room to draw into. */
export function growDurationForContent(project: Project, minimumBeats = 64): number {
	const last = lastContentBeat(project);
	return Math.max(minimumBeats, Math.ceil(last + 16));
}

export function totalCurveCount(project: Project): number {
	return project.tracks.reduce((sum, track) => sum + track.curves.length, 0);
}

export function totalPointCount(project: Project): number {
	return project.tracks.reduce(
		(sum, track) => sum + track.curves.reduce((inner, curve) => inner + curve.points.length, 0),
		0
	);
}

export function ensureAutomationLane(track: Track, target: string): Track {
	if (track.automationLanes.some((lane) => lane.target === target)) return track;
	return { ...track, automationLanes: [...track.automationLanes, createAutomationLane(target)] };
}

/** The musical state active at beat 0, used as the master header summary. */
export function projectRootState(project: Project) {
	const state = resolveMusicalState(project, 0);
	return { state, scale: resolveScale(project, state) };
}

/* --------------------------------------------------------- serialization */

interface SerializedFrame {
	id: string;
	position: number;
	source: unknown;
	interpolation: string;
}

/**
 * Frames carry a generated `samples` cache that is never authoritative, so it
 * is dropped on write and regenerated on read. That keeps project documents
 * small without ever losing an editable source representation.
 */
export function serializeProject(project: Project): string {
	const wavetables = project.wavetables.map((table) => ({
		...table,
		frames: table.frames.map((frame) => ({
			id: frame.id,
			position: frame.position,
			source: frame.source,
			interpolation: frame.interpolation
		}))
	}));
	return JSON.stringify({ ...project, wavetables });
}

export function deserializeProject(text: string): Project {
	const raw = JSON.parse(text) as Project & {
		wavetables: (Wavetable & { frames: SerializedFrame[] })[];
	};
	const project: Project = {
		...createDefaultProject(raw.name ?? 'Untitled'),
		...raw,
		editorSettings: {
			...DEFAULT_EDITOR_SETTINGS,
			...raw.editorSettings,
			// the editor's own view settings are re-read from preferences
			minFrequencyHz: raw.editorSettings?.minFrequencyHz ?? DEFAULT_EDITOR_SETTINGS.minFrequencyHz,
			maxFrequencyHz: raw.editorSettings?.maxFrequencyHz ?? DEFAULT_EDITOR_SETTINGS.maxFrequencyHz
		},
		wavetables: (raw.wavetables ?? []).map((table) => ({
			...table,
			sampleLength: table.sampleLength ?? DEFAULT_SAMPLE_LENGTH,
			frames: (table.frames ?? []).map((frame) =>
				refreshFrameSamples(
					{
						id: frame.id,
						position: frame.position,
						source: frame.source as never,
						samples: new Float32Array(table.sampleLength ?? DEFAULT_SAMPLE_LENGTH),
						interpolation: frame.interpolation as never
					},
					table.sampleLength ?? DEFAULT_SAMPLE_LENGTH
				)
			)
		})),
		master: raw.master ?? createMasterTrack(),
		scales: raw.scales?.length ? raw.scales : createBuiltInScales(),
		tracks: (raw.tracks ?? []).map((track) => ({
			...createTrack(track.name ?? 'Track', 0),
			...track
		}))
	};
	return project;
}

/** Fresh default tuning, cloned so callers never share a reference. */
export function defaultTuning() {
	return cloneTuning(DEFAULT_TUNING);
}
