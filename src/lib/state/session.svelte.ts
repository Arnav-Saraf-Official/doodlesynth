/**
 * The reactive view/controller layer.
 *
 * The authoritative editor state is `session.project`. Components read it and
 * never own it: every change goes through `mutate`, which produces a new
 * immutable project value, records a command for undo, and marks the document
 * dirty. Because the project is replaced rather than mutated in place, the
 * whole document is held as `$state.raw` and reactivity fires once per edit
 * regardless of project size.
 */

import { engine } from '#lib/audio/engine';
import { HistoryManager } from '#lib/history/history';
import { beatsToSeconds } from '#lib/model/pitch';
import {
	createDefaultProject,
	createTrack,
	growDurationForContent,
	nextTrackColor,
	reconcilePointLinks
} from '#lib/model/project';
import type { Curve, CurvePoint, Project, Track } from '#lib/model/types';
import { pointPixel } from '#lib/editor/hitTesting';
import { createTransform } from '#lib/editor/transform';
import { defaultViewport } from '#lib/editor/viewport';
import type { ViewportState } from '#lib/editor/transform';
import {
	createProjectStorage,
	lastProjectId,
	readPreference,
	writePreference
} from '#lib/persistence/projectStorage';

export type Tool =
	| 'select'
	| 'draw'
	| 'point'
	| 'eraser'
	| 'split'
	| 'join'
	| 'pan'
	| 'zoom'
	| 'automation'
	| 'measure';

export type SaveState = 'saved' | 'saving' | 'dirty' | 'error';

export interface Session {
	project: Project;
	/** 'master' or a track id */
	selectedTrackId: string;
	selectedCurveIds: string[];
	selectedPointIds: string[];
	activeTool: Tool;
	playhead: number;
	playing: boolean;
	loopEnabled: boolean;
	/** master snap switch; Ctrl/Cmd bypasses it for a single gesture */
	snapEnabled: boolean;
	viewport: ViewportState;
	/** bumped whenever the project body changes, invalidating geometry caches */
	revision: number;
	saveState: SaveState;
	saveError: string | null;
	statusMessage: string | null;
	initialized: boolean;
	showInspector: boolean;
	showOnboarding: boolean;
	/** automation panel: track ids whose lanes are shown; empty follows the active tab */
	automationTrackIds: string[];
	/** drag-resizable height of the automation lane list, in px */
	automationPanelHeight: number;
	/** clipboard for curve/point copy-paste */
	clipboard: { curves: Curve[]; atBeat: number } | null;
}

export const MASTER_TRACK_ID = 'master';

export const session = $state<Session>({
	project: createDefaultProject(),
	selectedTrackId: MASTER_TRACK_ID,
	selectedCurveIds: [],
	selectedPointIds: [],
	activeTool: 'draw',
	playhead: 0,
	playing: false,
	loopEnabled: false,
	snapEnabled: true,
	viewport: defaultViewport(),
	revision: 0,
	saveState: 'saved',
	saveError: null,
	statusMessage: null,
	initialized: false,
	showInspector: true,
	showOnboarding: false,
	automationTrackIds: [],
	automationPanelHeight: 200,
	clipboard: null
});

const history = new HistoryManager();
const storage = createProjectStorage();

/* --------------------------------------------------------------- mutation */

function applyProject(next: Project): void {
	// single choke point: keep branch junctions glued to their source point
	const reconciled = reconcilePointLinks(next);
	session.project = { ...reconciled, updatedAt: Date.now() };
	session.revision += 1;
	// the audio engine schedules from the live snapshot on its next tick
	engine.setProject(session.project);
}

export interface MutateOptions {
	/** commands sharing a key within the coalesce window merge into one entry */
	coalesce?: string;
	/** skip marking the document dirty, for view-only project edits */
	silent?: boolean;
}

/**
 * Apply an immutable project change. The updater must return the same object
 * when nothing changed so a no-op edit does not pollute the history.
 */
export function mutate(
	label: string,
	updater: (project: Project) => Project,
	options: MutateOptions = {}
): void {
	const before = session.project;
	const next = updater(before);
	if (next === before) return;
	applyProject(next);
	if (!options.silent) {
		session.saveState = 'dirty';
		scheduleAutosave();
	}
	history.push(
		{
			label,
			coalesceKey: options.coalesce,
			undo: () => applyProject(before),
			redo: () => applyProject(next)
		},
		Boolean(options.coalesce)
	);
}

export function replaceProject(project: Project, options: { resetHistory?: boolean } = {}): void {
	applyProject(project);
	if (options.resetHistory !== false) history.clear();
	session.selectedCurveIds = [];
	session.selectedPointIds = [];
	session.selectedTrackId = MASTER_TRACK_ID;
	session.saveState = 'dirty';
	scheduleAutosave();
}

export function undo(): void {
	const label = history.undo();
	if (label) {
		session.revision += 1;
		session.saveState = 'dirty';
		setStatus(`Undo ${label}`);
		scheduleAutosave();
	}
}

export function redo(): void {
	const label = history.redo();
	if (label) {
		session.revision += 1;
		session.saveState = 'dirty';
		setStatus(`Redo ${label}`);
		scheduleAutosave();
	}
}

export function canUndo(): boolean {
	return history.canUndo();
}

export function canRedo(): boolean {
	return history.canRedo();
}

export function undoLabel(): string | null {
	return history.nextUndoLabel();
}

export function redoLabel(): string | null {
	return history.nextRedoLabel();
}

/** Force the next mutation to start a new history entry. */
export function sealHistory(): void {
	history.seal();
}

/* -------------------------------------------------------------- selection */

export function isMasterSelected(): boolean {
	return session.selectedTrackId === MASTER_TRACK_ID;
}

export function activeTrack(): Track | null {
	if (isMasterSelected()) return null;
	return session.project.tracks.find((track) => track.id === session.selectedTrackId) ?? null;
}

export function selectTrack(trackId: string): void {
	session.selectedTrackId = trackId;
	session.selectedCurveIds = [];
	session.selectedPointIds = [];
}

export function selectCurves(ids: string[]): void {
	session.selectedCurveIds = ids;
	session.selectedPointIds = session.selectedPointIds.filter((id) =>
		activeTrack()?.curves.some((curve) =>
			curve.points.some((point) => point.id === id && ids.includes(curve.id))
		)
	);
}

export function selectPoints(ids: string[]): void {
	session.selectedPointIds = ids;
}

export function clearSelection(): void {
	session.selectedCurveIds = [];
	session.selectedPointIds = [];
}

export function setTool(tool: Tool): void {
	session.activeTool = tool;
	if (tool !== 'point') session.selectedPointIds = [];
}

export function setStatus(message: string | null): void {
	session.statusMessage = message;
}

/* --------------------------------------------------------------- transport */

/**
 * Transport clock. Playback prefers the audio engine's clock; a visual rAF
 * clock remains as the fallback when no audio device is available. Nothing in
 * the model depends on which one is active.
 */
let transportHandle: number | null = null;
let transportStartedAt = 0;
let transportStartedBeat = 0;
/** true while the audio engine drives the playhead instead of the rAF clock */
let audioClock = false;

/** The engine reports the audio-clock beat on every scheduler tick. */
engine.onBeat = (beat) => {
	if (session.playing) session.playhead = beat;
};

function startVisualClock(): void {
	if (transportHandle !== null) return;
	transportStartedAt = performance.now();
	transportStartedBeat = session.playhead;
	const step = () => {
		if (!session.playing || audioClock) return;
		const elapsedSeconds = (performance.now() - transportStartedAt) / 1000;
		const beat = transportStartedBeat + (elapsedSeconds * session.project.tempo) / 60;
		if (session.loopEnabled && beat >= session.project.loop.end) {
			transportStartedAt = performance.now();
			transportStartedBeat = session.project.loop.start;
			session.playhead = session.project.loop.start;
		} else {
			session.playhead = beat;
		}
		transportHandle = requestAnimationFrame(step);
	};
	transportHandle = requestAnimationFrame(step);
}

function stopVisualClock(): void {
	if (transportHandle !== null) {
		cancelAnimationFrame(transportHandle);
		transportHandle = null;
	}
}

export function startTransport(): void {
	if (session.playing) return;
	session.playing = true;
	audioClock = false;
	transportStartedAt = performance.now();
	transportStartedBeat = session.playhead;
	engine.setProject(session.project);
	engine
		.play(session.playhead)
		.then((started) => {
			if (!session.playing) {
				if (started) engine.stop();
				return;
			}
			audioClock = started;
			if (started) stopVisualClock();
			else startVisualClock();
		})
		.catch(() => {
			if (session.playing) startVisualClock();
		});
}

export function stopTransport(): void {
	session.playing = false;
	audioClock = false;
	engine.stop();
	stopVisualClock();
}

export function toggleTransport(): void {
	if (session.playing) stopTransport();
	else startTransport();
}

export function seek(beat: number): void {
	session.playhead = Math.max(0, beat);
	transportStartedAt = performance.now();
	transportStartedBeat = session.playhead;
	// restart the audio graph at the new position when audible
	if (session.playing && audioClock) void engine.play(session.playhead);
}

export function setTempo(bpm: number): void {
	mutate('Tempo', (project) => ({ ...project, tempo: Math.min(Math.max(bpm, 20), 400) }), {
		coalesce: 'tempo'
	});
}

export function setTimeSignature(numerator: number, denominator: number): void {
	mutate('Time signature', (project) => ({
		...project,
		timeSignature: { numerator, denominator }
	}));
}

export function currentSeconds(): number {
	return beatsToSeconds(session.playhead, session.project.tempo);
}

/* ---------------------------------------------------------------- viewport */

export function setViewport(next: ViewportState): void {
	session.viewport = next;
}

export function updateViewport(updater: (viewport: ViewportState) => ViewportState): void {
	session.viewport = updater(session.viewport);
}

export function setPlayheadFromPointer(beat: number): void {
	seek(beat);
}

/* ------------------------------------------------------------ persistence */

let autosaveHandle: ReturnType<typeof setTimeout> | null = null;

export function scheduleAutosave(delay = 900): void {
	if (autosaveHandle) clearTimeout(autosaveHandle);
	autosaveHandle = setTimeout(() => {
		void saveNow();
	}, delay);
}

export async function saveNow(): Promise<void> {
	if (session.saveState === 'saving') return;
	session.saveState = 'saving';
	try {
		await storage.save(session.project);
		session.saveState = 'saved';
		session.saveError = null;
	} catch (error) {
		session.saveState = 'error';
		session.saveError = error instanceof Error ? error.message : 'Could not save project';
	}
}

export async function loadProject(id: string): Promise<boolean> {
	try {
		const project = await storage.load(id);
		if (!project) return false;
		replaceProject(project, { resetHistory: true });
		session.viewport = {
			...session.viewport,
			startBeat: 0,
			minFrequencyHz: project.editorSettings.minFrequencyHz,
			maxFrequencyHz: project.editorSettings.maxFrequencyHz,
			pitchMap: project.editorSettings.pitchMap,
			projection: project.editorSettings.frequencyProjection
		};
		session.saveState = 'saved';
		return true;
	} catch (error) {
		session.saveState = 'error';
		session.saveError = error instanceof Error ? error.message : 'Could not open project';
		return false;
	}
}

export function listProjects() {
	return storage.list();
}

export function deleteProject(id: string) {
	return storage.delete(id);
}

/* ------------------------------------------------------------------- init */

const PREF_VIEWPORT = 'viewport';
const PREF_TOOL = 'tool';

export async function initSession(): Promise<void> {
	if (session.initialized) return;
	session.initialized = true;

	const storedViewport = readPreference<Partial<ViewportState> | null>(PREF_VIEWPORT, null);
	if (storedViewport) session.viewport = { ...session.viewport, ...storedViewport };
	session.activeTool = readPreference<Tool>(PREF_TOOL, 'draw');
	session.loopEnabled = false;

	const id = lastProjectId();
	let loaded = false;
	if (id) loaded = await loadProject(id);
	if (!loaded) {
		const project = createDefaultProject('Untitled');
		replaceProject(project, { resetHistory: true });
		// first run: guide the user straight into the defining action
		session.showOnboarding = project.tracks.length === 0;
		session.saveState = 'saved';
	}
	session.initialized = true;
}

export function persistPreferences(): void {
	writePreference(PREF_VIEWPORT, {
		pixelsPerBeat: session.viewport.pixelsPerBeat,
		startBeat: session.viewport.startBeat,
		minFrequencyHz: session.viewport.minFrequencyHz,
		maxFrequencyHz: session.viewport.maxFrequencyHz,
		pitchMap: session.viewport.pitchMap,
		projection: session.viewport.projection
	});
	writePreference(PREF_TOOL, session.activeTool);
}

/* --------------------------------------------------------------- helpers */

export function createTrackAndSelect(name?: string): string {
	const track = createTrack(
		name ?? `Track ${session.project.tracks.length + 1}`,
		session.project.tracks.length
	);
	track.color = nextTrackColor(session.project);
	mutate('Create track', (project) => ({
		...project,
		tracks: [...project.tracks, track],
		durationBeats: growDurationForContent(project)
	}));
	selectTrack(track.id);
	session.showOnboarding = false;
	return track.id;
}

/**
 * Debug/test handle: the CDP verification harnesses drive the real engine and
 * session through it (offline render peak, live playhead, snapshot snaps).
 * Non-enumerable so it stays out of console dumps and app code.
 */
Object.defineProperty(globalThis, '__linesynth', {
	value: {
		engine,
		session,
		/** model point → canvas pixel, used by the verification harnesses */
		toPixel: (point: { time: number; frequency: number }) =>
			pointPixel(point as CurvePoint, createTransform(session.viewport))
	},
	configurable: true
});
