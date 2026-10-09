/**
 * Project edit commands.
 *
 * Every edit is expressed as an immutable transform here and pushed through
 * `mutate` in the session, so undo/redo, autosave and the geometry caches all
 * see exactly one update per edit.
 */

import {
	createAutomationLane,
	createAutomationPoint,
	sortAutomationPoints
} from '#lib/model/automation';
import {
	copyPoint,
	createPoint,
	insertPointAt,
	offsetPoints,
	removePoint,
	reversePoints,
	splitPointsAt,
	transposePoints
} from '#lib/model/curve';
import {
	createMusicalStateKeyframe,
	frequencyForScaleRef,
	resolveMusicalState,
	resolveScale,
	scaleRefForFrequency
} from '#lib/model/musicalState';
import { clamp } from '#lib/model/pitch';
import { snapToNote } from '#lib/editor/snapping';
import {
	createCurve,
	createMarker,
	createTrack,
	duplicateCurve,
	duplicateTrack,
	findTrack,
	growDurationForContent,
	TRACK_COLORS
} from '#lib/model/project';
import { duplicateLanes } from '#lib/model/automation';
import { uid } from '#lib/model/ids';
import {
	createHarmonicComponents,
	createWavetable,
	refreshFrameSamples
} from '#lib/model/wavetable';
import type {
	AutomationLane,
	Curve,
	CurvePoint,
	EditorSettings,
	Id,
	Lfo,
	MusicalState,
	MusicalStateKeyframe,
	ParameterKey,
	PointInterpolation,
	Project,
	ScaleDefinition,
	SynthSettings,
	Track,
	WaveSource,
	Wavetable,
	WavetableFrame
} from '#lib/model/types';
import {
	activeTrack,
	isMasterSelected,
	MASTER_TRACK_ID,
	mutate,
	session,
	selectTrack,
	setStatus
} from './session.svelte';

// Transport-level edits live with the transport state; re-exported here so the
// UI has a single edit-command entry point.
export { setTempo, setTimeSignature } from './session.svelte';

/* ---------------------------------------------------------------- helpers */

function mapTracks(project: Project, trackId: Id, updater: (track: Track) => Track): Project {
	if (trackId === MASTER_TRACK_ID) return project;
	let changed = false;
	const tracks = project.tracks.map((track) => {
		if (track.id !== trackId) return track;
		const next = updater(track);
		if (next !== track) changed = true;
		return next;
	});
	return changed ? { ...project, tracks } : project;
}

function mapCurves(project: Project, trackId: Id, updater: (curve: Curve) => Curve): Project {
	return mapTracks(project, trackId, (track) => {
		let changed = false;
		const curves = track.curves.map((curve) => {
			const next = updater(curve);
			if (next !== curve) changed = true;
			return next;
		});
		return changed ? { ...track, curves } : track;
	});
}

function mapTrackLanes(
	project: Project,
	trackId: Id,
	updater: (lane: AutomationLane) => AutomationLane
): Project {
	if (trackId === MASTER_TRACK_ID) {
		let changed = false;
		const lanes = project.master.automationLanes.map((lane) => {
			const next = updater(lane);
			if (next !== lane) changed = true;
			return next;
		});
		return changed
			? { ...project, master: { ...project.master, automationLanes: lanes } }
			: project;
	}
	return mapTracks(project, trackId, (track) => {
		let changed = false;
		const lanes = track.automationLanes.map((lane) => {
			const next = updater(lane);
			if (next !== lane) changed = true;
			return next;
		});
		return changed ? { ...track, automationLanes: lanes } : track;
	});
}

function selectedCurvesOf(track: Track | null): Curve[] {
	if (!track) return [];
	return track.curves.filter((curve) => session.selectedCurveIds.includes(curve.id));
}

/* ----------------------------------------------------------------- tracks */

export function addTrack(name?: string, wave: WaveSource = 'saw'): string {
	const track: Track = createTrack(
		name ?? `Track ${session.project.tracks.length + 1}`,
		session.project.tracks.length,
		wave
	);
	mutate('Create track', (project) => ({
		...project,
		tracks: [...project.tracks, track],
		durationBeats: growDurationForContent(project)
	}));
	selectTrack(track.id);
	session.showOnboarding = false;
	return track.id;
}

export function removeTrack(trackId: Id): void {
	mutate('Delete track', (project) => ({
		...project,
		tracks: project.tracks.filter((track) => track.id !== trackId)
	}));
	if (session.selectedTrackId === trackId) selectTrack(MASTER_TRACK_ID);
}

export function renameTrack(trackId: Id, name: string): void {
	mutate(
		'Rename track',
		(project) => mapTracks(project, trackId, (track) => ({ ...track, name })),
		{
			coalesce: `rename:${trackId}`
		}
	);
}

export function setTrackColor(trackId: Id, color: string): void {
	mutate('Track color', (project) => mapTracks(project, trackId, (track) => ({ ...track, color })));
}

export function duplicateTrackById(trackId: Id): void {
	mutate('Duplicate track', (project) => {
		const source = project.tracks.find((track) => track.id === trackId);
		if (!source) return project;
		const index = project.tracks.indexOf(source);
		const copy = duplicateTrack(source);
		const tracks = [...project.tracks];
		tracks.splice(index + 1, 0, copy);
		return { ...project, tracks };
	});
}

export function updateSynth(trackId: Id, patch: Partial<SynthSettings>): void {
	mutate(
		'Synth setting',
		(project) =>
			mapTracks(project, trackId, (track) => ({ ...track, synth: { ...track.synth, ...patch } })),
		{ coalesce: `synth:${trackId}` }
	);
}

export function updateTrackMixer(trackId: Id, patch: Partial<Track['mixer']>): void {
	if (trackId === MASTER_TRACK_ID) {
		mutate(
			'Master mixer',
			(project) => ({
				...project,
				master: { ...project.master, mixer: { ...project.master.mixer, ...patch } }
			}),
			{ coalesce: 'master-mixer' }
		);
		return;
	}
	mutate(
		'Mixer',
		(project) =>
			mapTracks(project, trackId, (track) => ({ ...track, mixer: { ...track.mixer, ...patch } })),
		{ coalesce: `mixer:${trackId}` }
	);
}

export function setTrackPitchRepresentation(
	trackId: Id,
	representation: Track['pitchRepresentation']
): void {
	mutate('Pitch interpretation', (project) =>
		mapTracks(project, trackId, (track) => {
			const curves =
				representation === 'scale-relative'
					? track.curves.map((curve) => ({
							...curve,
							points: curve.points.map((point) => ({
								...point,
								scaleRef:
									point.scaleRef ??
									scaleRefForFrequency(
										point.frequency,
										resolveMusicalState(project, point.time),
										resolveScale(project, resolveMusicalState(project, point.time))
									)
							}))
						}))
					: track.curves;
			return { ...track, pitchRepresentation: representation, curves };
		})
	);
}

export function setTrackTuningFollow(trackId: Id, follow: Track['tuningFollow']): void {
	mutate('Tuning follow', (project) =>
		mapTracks(project, trackId, (track) => ({ ...track, tuningFollow: follow }))
	);
}

export function addLfo(trackId: Id): void {
	const lfo: Lfo = {
		id: `lfo_${Math.random().toString(36).slice(2, 9)}`,
		name: `LFO ${(activeTrack()?.lfos.length ?? 0) + 1}`,
		enabled: true,
		wave: 'sine',
		rate: 2,
		sync: '1/4',
		phaseDegrees: 0,
		amount: 0.2,
		destination: 'wavetable.position'
	};
	mutate('Add LFO', (project) =>
		mapTracks(project, trackId, (track) => ({ ...track, lfos: [...track.lfos, lfo] }))
	);
}

export function updateLfo(trackId: Id, lfoId: Id, patch: Partial<Lfo>): void {
	mutate(
		'LFO setting',
		(project) =>
			mapTracks(project, trackId, (track) => ({
				...track,
				lfos: track.lfos.map((lfo) => (lfo.id === lfoId ? { ...lfo, ...patch } : lfo))
			})),
		{ coalesce: `lfo:${lfoId}` }
	);
}

export function removeLfo(trackId: Id, lfoId: Id): void {
	mutate('Remove LFO', (project) =>
		mapTracks(project, trackId, (track) => ({
			...track,
			lfos: track.lfos.filter((lfo) => lfo.id !== lfoId)
		}))
	);
}

/* ----------------------------------------------------------------- curves */

export function addCurveToTrack(trackId: Id, curve?: Curve): string {
	const created = curve ?? createCurve();
	mutate('Create curve', (project) =>
		mapTracks(project, trackId, (track) => ({ ...track, curves: [...track.curves, created] }))
	);
	session.selectedCurveIds = [created.id];
	return created.id;
}

/** Set a curve's points wholesale. Used by every drag commit. */
export function setCurvePoints(
	trackId: Id,
	curveId: Id,
	points: CurvePoint[],
	label = 'Move point',
	coalesce?: string
): void {
	mutate(
		label,
		(project) =>
			mapCurves(project, trackId, (curve) => (curve.id === curveId ? { ...curve, points } : curve)),
		{ coalesce }
	);
}

export function updateCurve(
	trackId: Id,
	curveId: Id,
	patch: Partial<Curve>,
	label = 'Curve setting'
): void {
	mutate(
		label,
		(project) =>
			mapCurves(project, trackId, (curve) =>
				curve.id === curveId ? { ...curve, ...patch } : curve
			),
		{ coalesce: `curve:${curveId}` }
	);
}

export function addPointAt(trackId: Id, curveId: Id, time: number): void {
	mutate('Add point', (project) =>
		mapCurves(project, trackId, (curve) =>
			curve.id === curveId ? { ...curve, points: insertPointAt(curve.points, time).points } : curve
		)
	);
}

export function deleteSelectedPoints(): void {
	const track = activeTrack();
	if (!track) return;
	const pointIds = new Set(session.selectedPointIds);
	if (pointIds.size === 0) return;
	mutate('Delete points', (project) =>
		mapCurves(project, track.id, (curve) => {
			let points = curve.points;
			for (const id of pointIds) points = removePoint(points, id);
			return points === curve.points ? curve : { ...curve, points };
		})
	);
	session.selectedPointIds = [];
}

export function deleteSelectedCurves(): void {
	const track = activeTrack();
	if (!track) return;
	const ids = new Set(session.selectedCurveIds);
	if (ids.size === 0) return;
	mutate('Delete curves', (project) =>
		mapTracks(project, track.id, (entry) => ({
			...entry,
			curves: entry.curves.filter((curve) => !ids.has(curve.id))
		}))
	);
	session.selectedCurveIds = [];
	session.selectedPointIds = [];
}

export function setPointInterpolation(interpolation: PointInterpolation): void {
	const track = activeTrack();
	if (!track) return;
	const pointIds = new Set(session.selectedPointIds);
	if (pointIds.size === 0) return;
	mutate('Point interpolation', (project) =>
		mapCurves(project, track.id, (curve) => ({
			...curve,
			points: curve.points.map((point) =>
				pointIds.has(point.id) ? { ...point, interpolation } : point
			)
		}))
	);
}

export function splitCurve(trackId: Id, curveId: Id, time: number): void {
	mutate('Split curve', (project) =>
		mapTracks(project, trackId, (track) => {
			const index = track.curves.findIndex((curve) => curve.id === curveId);
			if (index < 0) return track;
			const source = track.curves[index];
			if (source.points.length < 2) return track;
			const [left, right] = splitPointsAt(source.points, time);
			const first: Curve = { ...source, points: left };
			const second: Curve = {
				...source,
				id: `curve_${Math.random().toString(36).slice(2, 9)}`,
				name: `${source.name} B`,
				points: right
			};
			const curves = [...track.curves];
			curves.splice(index, 1, first, second);
			return { ...track, curves };
		})
	);
}

export function joinCurves(trackId: Id, firstId: Id, secondId: Id): void {
	mutate('Join curves', (project) =>
		mapTracks(project, trackId, (track) => {
			const first = track.curves.find((curve) => curve.id === firstId);
			const second = track.curves.find((curve) => curve.id === secondId);
			if (!first || !second) return track;
			const [head, tail] =
				first.points[first.points.length - 1].time <= second.points[0].time
					? [first, second]
					: [second, first];
			const joined: Curve = {
				...head,
				points: [...head.points, ...tail.points.map((point) => copyPoint(point))].map(
					(point, index) => ({
						...point,
						id: `${point.id}_${index}`
					})
				)
			};
			return {
				...track,
				curves: track.curves
					.filter((curve) => curve.id !== first.id && curve.id !== second.id)
					.concat(joined)
			};
		})
	);
}

export function copySelection(): void {
	const track = activeTrack();
	if (!track) return;
	const curves = selectedCurvesOf(track);
	if (curves.length === 0) return;
	session.clipboard = {
		curves: curves.map((curve) => ({ ...curve, points: curve.points.map(copyPoint) })),
		atBeat: session.playhead
	};
}

export function pasteClipboard(): void {
	const track = activeTrack();
	const clipboard = session.clipboard;
	if (!track || !clipboard || clipboard.curves.length === 0) return;
	const created = clipboard.curves.map((curve) =>
		duplicateCurve(curve, session.playhead - clipboard.atBeat)
	);
	mutate('Paste', (project) =>
		mapTracks(project, track.id, (entry) => ({
			...entry,
			curves: [...entry.curves, ...created],
			automationLanes: entry.automationLanes
		}))
	);
	session.selectedCurveIds = created.map((curve) => curve.id);
}

export function duplicateSelection(): void {
	const track = activeTrack();
	if (!track) return;
	const curves = selectedCurvesOf(track);
	if (curves.length === 0) return;
	const created = curves.map((curve) => duplicateCurve(curve, 0.5));
	mutate('Duplicate', (project) =>
		mapTracks(project, track.id, (entry) => ({ ...entry, curves: [...entry.curves, ...created] }))
	);
	session.selectedCurveIds = created.map((curve) => curve.id);
}

export interface TransformOptions {
	timeScale?: number;
	pitchScale?: number;
	pitchOffsetSemitones?: number;
	pitchOffsetHz?: number;
	anchor?: 'start' | 'playhead';
}

export function transformSelection(options: TransformOptions): void {
	const track = activeTrack();
	if (!track) return;
	const ids = new Set(session.selectedCurveIds);
	if (ids.size === 0) return;
	const timeScale = options.timeScale ?? 1;
	const pitchScale = options.pitchScale ?? 1;

	mutate('Transform', (project) =>
		mapCurves(project, track.id, (curve) => {
			if (!ids.has(curve.id)) return curve;
			const anchor =
				options.anchor === 'playhead' ? session.playhead : (curve.points[0]?.time ?? 0);
			let points = curve.points.map((point) => ({
				...copyPoint(point),
				time: anchor + (point.time - anchor) * timeScale,
				frequency: point.frequency * pitchScale
			}));
			if (options.pitchOffsetSemitones) {
				points = transposePoints(points, options.pitchOffsetSemitones);
			}
			if (options.pitchOffsetHz) {
				points = points.map((point) => ({
					...point,
					frequency: Math.max(10, point.frequency + options.pitchOffsetHz!)
				}));
			}
			return { ...curve, points };
		})
	);
}

export function reverseSelection(): void {
	const track = activeTrack();
	if (!track) return;
	const ids = new Set(session.selectedCurveIds);
	mutate('Reverse', (project) =>
		mapCurves(project, track.id, (curve) =>
			ids.has(curve.id) ? { ...curve, points: reversePoints(curve.points) } : curve
		)
	);
}

export function quantizeSelection(step: number): void {
	const track = activeTrack();
	if (!track || step <= 0) return;
	const ids = new Set(session.selectedCurveIds);
	mutate('Quantize', (project) =>
		mapCurves(project, track.id, (curve) =>
			ids.has(curve.id)
				? {
						...curve,
						points: curve.points.map((point) => ({
							...point,
							time: Math.round(point.time / step) * step
						}))
					}
				: curve
		)
	);
}

export function nudgeSelectedPoints(deltaBeats: number, cents: number, coalesceKey: string): void {
	const track = activeTrack();
	if (!track) return;
	const pointIds = new Set(session.selectedPointIds);
	if (pointIds.size === 0) return;
	const ratio = Math.pow(2, cents / 1200);
	mutate(
		'Nudge points',
		(project) =>
			mapCurves(project, track.id, (curve) => {
				let changed = false;
				const points = curve.points.map((point) => {
					if (!pointIds.has(point.id)) return point;
					changed = true;
					return {
						...point,
						time: Math.max(0, point.time + deltaBeats),
						frequency: clamp(point.frequency * ratio, 10, 20000)
					};
				});
				return changed ? { ...curve, points } : curve;
			}),
		{ coalesce: coalesceKey }
	);
}

/* ------------------------------------------------------------- snapping */

/**
 * One-shot "make it exact": snap every selected point to the nearest real
 * note frequency at the Musical State active on its beat. Gesture snapping
 * alone never rewrites stored data; this command is the deliberate path.
 */
export function snapSelectionToNotes(): void {
	const track = activeTrack();
	if (!track) return;
	const pointIds = new Set(session.selectedPointIds);
	if (pointIds.size === 0) {
		setStatus('Select points first, then press N to snap them to note Hz');
		return;
	}
	let snapped = 0;
	mutate(
		'Snap to notes',
		(project) =>
			mapCurves(project, track.id, (curve) => {
				let changed = false;
				const points = curve.points.map((point) => {
					if (!pointIds.has(point.id)) return point;
					const state = resolveMusicalState(project, point.time);
					const frequency = snapToNote(point.frequency, state.tuning.referenceFrequencyHz);
					if (Math.abs(frequency - point.frequency) < 1e-9) return point;
					changed = true;
					snapped += 1;
					return { ...point, frequency };
				});
				return changed ? { ...curve, points } : curve;
			}),
		{ coalesce: 'snap-notes' }
	);
	setStatus(
		snapped > 0
			? `Snapped ${snapped} ${snapped === 1 ? 'point' : 'points'} to note Hz`
			: 'Selected points are already on note frequencies'
	);
}

/**
 * Branch a line at one of its control points: a new, independent voice is born
 * at that exact point and follows the source's remaining shape, so the two
 * lines share a start and can be edited apart. The branch copies the parent's
 * phase setting, so with the default (no randomization) both voices begin in
 * phase instead of cancelling each other.
 */
export function branchCurveAtPoint(trackId: Id, curveId: Id, pointId: Id): string | null {
	let createdId: string | null = null;
	mutate('Branch curve', (project) =>
		mapTracks(project, trackId, (track) => {
			const index = track.curves.findIndex((curve) => curve.id === curveId);
			if (index < 0) return track;
			const source = track.curves[index];
			const pointIndex = source.points.findIndex((point) => point.id === pointId);
			if (pointIndex < 0) return track;

			const originPointId = source.points[pointIndex].id;
			const tail = source.points
				.slice(pointIndex)
				.map((point) => ({ ...copyPoint(point), id: uid('pt') }));
			if (tail.length < 2) {
				const last = tail[0];
				tail.push({ ...last, id: uid('pt'), time: last.time + 1 });
			}
			// the branch start stays glued to the fork point until it is deleted
			tail[0] = { ...tail[0], link: { curveId: source.id, pointId: originPointId } };

			const branchId = uid('curve');
			const branch: Curve = {
				...source,
				id: branchId,
				name: `${source.name} branch`,
				color: unusedPaletteColor(track, source.color ?? track.color),
				points: tail
			};
			const curves = [...track.curves];
			curves.splice(index + 1, 0, branch);
			createdId = branchId;
			return { ...track, curves };
		})
	);
	if (createdId) session.selectedCurveIds = [createdId];
	return createdId;
}

/**
 * Drag-a-point-onto-another-line: drop a new junction point on the target curve
 * at the origin point's position and link it, so the two lines stay joined.
 * Returns the new point id, or null when nothing was added.
 */
export function attachPointToCurve(
	trackId: Id,
	targetCurveId: Id,
	origin: { curveId: Id; pointId: Id; time: number; frequency: number }
): string | null {
	let createdId: string | null = null;
	mutate('Link to curve', (project) =>
		mapCurves(project, trackId, (curve) => {
			if (curve.id !== targetCurveId) return curve;
			if (curve.points.some((point) => point.link?.pointId === origin.pointId)) return curve;
			const point: CurvePoint = {
				...createPoint(origin.time, origin.frequency, 'smooth'),
				link: { curveId: origin.curveId, pointId: origin.pointId }
			};
			createdId = point.id;
			const points = [...curve.points, point].sort((a, b) => a.time - b.time);
			return { ...curve, points };
		})
	);
	return createdId;
}

/** First palette entry no line in the track uses yet, else the next one over. */
function unusedPaletteColor(track: Track, fallback: string): string {
	const used = new Set<string>([track.color]);
	for (const curve of track.curves) if (curve.color) used.add(curve.color);
	const free = TRACK_COLORS.find((color) => !used.has(color));
	if (free) return free;
	const index = TRACK_COLORS.indexOf(fallback);
	return TRACK_COLORS[(index + 1 + TRACK_COLORS.length) % TRACK_COLORS.length];
}

/** Split a curve into evenly spaced beats, used by the pen tool release. */
export function offsetCurvePoints(curve: Curve, beats: number, ratio: number): CurvePoint[] {
	return offsetPoints(curve.points, beats, ratio);
}

/**
 * Re-resolve every scale-relative point against the current Musical State.
 * Absolute-Hz points are untouched: this is the only operation allowed to
 * rewrite stored frequencies from the scale.
 */
export function retuneTrackToCurrentScale(trackId: Id): void {
	mutate('Retune to scale', (project) => {
		const track = findTrack(project, trackId);
		if (!track || track.pitchRepresentation !== 'scale-relative') return project;
		return mapCurves(project, trackId, (curve) => ({
			...curve,
			points: curve.points.map((point) => {
				if (!point.scaleRef) return point;
				const state = resolveMusicalState(project, point.time);
				const frequency = frequencyForScaleRef(point.scaleRef, state, resolveScale(project, state));
				return frequency === undefined ? point : { ...point, frequency };
			})
		}));
	});
}

/* -------------------------------------------------- musical state (master) */

export function setMusicalStateAtPlayhead(patch: Partial<MusicalState>): void {
	const beat = session.playhead;
	mutate('Musical state', (project) => {
		const frames = [...project.master.musicalState].sort((a, b) => a.time - b.time);
		const active = frames.filter((frame) => frame.time <= beat).pop();
		if (active && Math.abs(active.time - beat) < 0.001) {
			return {
				...project,
				master: {
					...project.master,
					musicalState: project.master.musicalState.map((frame) =>
						frame.id === active.id ? { ...frame, state: { ...frame.state, ...patch } } : frame
					)
				}
			};
		}
		const created = createMusicalStateKeyframe(beat, {
			...(active?.state ?? {}),
			...patch
		});
		return {
			...project,
			master: {
				...project.master,
				musicalState: [...project.master.musicalState, created].sort((a, b) => a.time - b.time)
			}
		};
	});
}

export function addMusicalStateKeyframe(time: number): void {
	mutate('Add musical keyframe', (project) => {
		const state = resolveMusicalState(project, time);
		const frame = createMusicalStateKeyframe(time, state);
		return {
			...project,
			master: {
				...project.master,
				musicalState: [...project.master.musicalState, frame].sort((a, b) => a.time - b.time)
			}
		};
	});
}

export function updateMusicalStateKeyframe(id: Id, patch: Partial<MusicalStateKeyframe>): void {
	mutate('Musical keyframe', (project) => ({
		...project,
		master: {
			...project.master,
			musicalState: project.master.musicalState.map((frame) =>
				frame.id === id
					? {
							...frame,
							...patch,
							state: patch.state ? { ...frame.state, ...patch.state } : frame.state
						}
					: frame
			)
		}
	}));
}

export function removeMusicalStateKeyframe(id: Id): void {
	mutate('Delete musical keyframe', (project) => ({
		...project,
		master: {
			...project.master,
			musicalState: project.master.musicalState.filter((frame) => frame.id !== id)
		}
	}));
}

/* -------------------------------------------------------------- automation */

export function addAutomationLane(target: ParameterKey, trackId = session.selectedTrackId): void {
	mutate('Add automation lane', (project) => {
		if (trackId === MASTER_TRACK_ID) {
			if (project.master.automationLanes.some((lane) => lane.target === target)) return project;
			return {
				...project,
				master: {
					...project.master,
					automationLanes: [...project.master.automationLanes, createAutomationLane(target)]
				}
			};
		}
		return mapTracks(project, trackId, (track) =>
			track.automationLanes.some((lane) => lane.target === target)
				? track
				: { ...track, automationLanes: [...track.automationLanes, createAutomationLane(target)] }
		);
	});
}

export function removeAutomationLane(laneId: Id, trackId = session.selectedTrackId): void {
	mutate('Remove automation lane', (project) => {
		if (trackId === MASTER_TRACK_ID) {
			return {
				...project,
				master: {
					...project.master,
					automationLanes: project.master.automationLanes.filter((lane) => lane.id !== laneId)
				}
			};
		}
		return mapTracks(project, trackId, (track) => ({
			...track,
			automationLanes: track.automationLanes.filter((lane) => lane.id !== laneId)
		}));
	});
}

export function setLaneEnabled(
	laneId: Id,
	enabled: boolean,
	trackId = session.selectedTrackId
): void {
	mutate('Automation lane', (project) =>
		mapTrackLanes(project, trackId, (lane) => (lane.id === laneId ? { ...lane, enabled } : lane))
	);
}

export function setLaneExpanded(
	laneId: Id,
	expanded: boolean,
	trackId = session.selectedTrackId
): void {
	mutate(
		'Automation lane',
		(project) =>
			mapTrackLanes(project, trackId, (lane) =>
				lane.id === laneId ? { ...lane, expanded } : lane
			),
		{ silent: true }
	);
}

export function addAutomationPoint(
	laneId: Id,
	time: number,
	value: number,
	trackId = session.selectedTrackId
): void {
	mutate('Add automation point', (project) =>
		mapTrackLanes(project, trackId, (lane) =>
			lane.id === laneId
				? {
						...lane,
						points: sortAutomationPoints([...lane.points, createAutomationPoint(time, value)])
					}
				: lane
		)
	);
}

export function setLanePoints(
	laneId: Id,
	points: AutomationLane['points'],
	label = 'Move automation point',
	trackId = session.selectedTrackId
): void {
	mutate(
		label,
		(project) =>
			mapTrackLanes(project, trackId, (lane) => (lane.id === laneId ? { ...lane, points } : lane)),
		{ coalesce: `lane:${laneId}` }
	);
}

export function removeAutomationPoint(
	laneId: Id,
	pointId: Id,
	trackId = session.selectedTrackId
): void {
	mutate('Delete automation point', (project) =>
		mapTrackLanes(project, trackId, (lane) =>
			lane.id === laneId
				? { ...lane, points: lane.points.filter((point) => point.id !== pointId) }
				: lane
		)
	);
}

/* ------------------------------------------------------------- wavetables */

export function addWavetable(table: Wavetable): void {
	mutate('Create wavetable', (project) => ({
		...project,
		wavetables: [...project.wavetables, table]
	}));
}

export function createAndAddWavetable(name: string, sampleLength = 2048): string {
	const frame: WavetableFrame = {
		id: `frame_${Math.random().toString(36).slice(2, 9)}`,
		position: 0,
		source: { kind: 'harmonics', components: createHarmonicComponents(32) },
		samples: new Float32Array(sampleLength),
		interpolation: 'smooth'
	};
	const table = createWavetable(name, [frame], sampleLength);
	mutate('Create wavetable', (project) => ({
		...project,
		wavetables: [...project.wavetables, table]
	}));
	return table.id;
}

export function updateWavetable(
	id: Id,
	patch: Partial<Wavetable>,
	label = 'Wavetable setting'
): void {
	mutate(
		label,
		(project) => ({
			...project,
			wavetables: project.wavetables.map((table) =>
				table.id === id ? { ...table, ...patch } : table
			)
		}),
		{ coalesce: `wt:${id}` }
	);
}

export function deleteWavetable(id: Id): void {
	mutate('Delete wavetable', (project) => ({
		...project,
		wavetables: project.wavetables.filter((table) => table.id !== id),
		tracks: project.tracks.map((track) =>
			track.synth.wavetableId === id
				? { ...track, synth: { ...track.synth, wavetableId: undefined, wave: 'sine' } }
				: track
		)
	}));
}

export function duplicateWavetableById(id: Id): void {
	mutate('Duplicate wavetable', (project) => {
		const source = project.wavetables.find((table) => table.id === id);
		if (!source) return project;
		const copy = {
			...source,
			id: `wt_${Math.random().toString(36).slice(2, 9)}`,
			name: `${source.name} copy`,
			builtIn: false
		};
		return { ...project, wavetables: [...project.wavetables, copy] };
	});
}

export function toggleWavetableFavorite(id: Id): void {
	mutate('Favorite wavetable', (project) => ({
		...project,
		wavetables: project.wavetables.map((table) =>
			table.id === id ? { ...table, favorite: !table.favorite } : table
		)
	}));
}

export function updateWavetableFrame(
	tableId: Id,
	frameId: Id,
	updater: (frame: WavetableFrame) => WavetableFrame,
	label = 'Edit frame'
): void {
	mutate(
		label,
		(project) => ({
			...project,
			wavetables: project.wavetables.map((table) =>
				table.id === tableId
					? {
							...table,
							frames: table.frames.map((frame) =>
								frame.id === frameId
									? refreshFrameSamples(updater(frame), table.sampleLength)
									: frame
							)
						}
					: table
			)
		}),
		{ coalesce: `frame:${frameId}` }
	);
}

export function addWavetableFrame(tableId: Id, frame: WavetableFrame): void {
	mutate('Add frame', (project) => ({
		...project,
		wavetables: project.wavetables.map((table) =>
			table.id === tableId
				? {
						...table,
						frames: [...table.frames, refreshFrameSamples(frame, table.sampleLength)].sort(
							(a, b) => a.position - b.position
						)
					}
				: table
		)
	}));
}

export function removeWavetableFrame(tableId: Id, frameId: Id): void {
	mutate('Delete frame', (project) => ({
		...project,
		wavetables: project.wavetables.map((table) =>
			table.id === tableId && table.frames.length > 1
				? { ...table, frames: table.frames.filter((frame) => frame.id !== frameId) }
				: table
		)
	}));
}

export function setWavetableFramePosition(tableId: Id, frameId: Id, position: number): void {
	mutate(
		'Move frame',
		(project) => ({
			...project,
			wavetables: project.wavetables.map((table) =>
				table.id === tableId
					? {
							...table,
							frames: table.frames
								.map((frame) =>
									frame.id === frameId ? { ...frame, position: clamp(position, 0, 1) } : frame
								)
								.sort((a, b) => a.position - b.position)
						}
					: table
			)
		}),
		{ coalesce: `framePos:${frameId}` }
	);
}

/* ----------------------------------------------------------------- scales */

export function addScale(scale: ScaleDefinition): void {
	mutate('Create scale', (project) => ({ ...project, scales: [...project.scales, scale] }));
}

export function updateScale(id: Id, patch: Partial<ScaleDefinition>, label = 'Edit scale'): void {
	mutate(
		label,
		(project) => ({
			...project,
			scales: project.scales.map((scale) => (scale.id === id ? { ...scale, ...patch } : scale))
		}),
		{ coalesce: `scale:${id}` }
	);
}

export function deleteScale(id: Id): void {
	mutate('Delete scale', (project) => ({
		...project,
		scales: project.scales.filter((scale) => scale.id !== id)
	}));
}

/* ---------------------------------------------------------------- markers */

export function addMarkerAt(time: number, label: string): void {
	mutate('Add marker', (project) => ({
		...project,
		markers: [...project.markers, createMarker(time, label)].sort((a, b) => a.time - b.time)
	}));
}

export function removeMarker(id: Id): void {
	mutate('Delete marker', (project) => ({
		...project,
		markers: project.markers.filter((marker) => marker.id !== id)
	}));
}

export function moveMarker(id: Id, time: number): void {
	mutate(
		'Move marker',
		(project) => ({
			...project,
			markers: project.markers
				.map((marker) => (marker.id === id ? { ...marker, time: Math.max(0, time) } : marker))
				.sort((a, b) => a.time - b.time)
		}),
		{ coalesce: `marker:${id}` }
	);
}

/* ------------------------------------------------------------------- loop */

export function setLoop(patch: Partial<Project['loop']>): void {
	mutate('Loop region', (project) => ({ ...project, loop: { ...project.loop, ...patch } }), {
		coalesce: 'loop'
	});
}

/* -------------------------------------------------------- editor settings */

export function updateEditorSettings(patch: Partial<EditorSettings>): void {
	mutate(
		'Editor settings',
		(project) => ({ ...project, editorSettings: { ...project.editorSettings, ...patch } }),
		{ silent: true, coalesce: 'editor-settings' }
	);
	// the viewport mirrors the settings that affect how the model is projected
	if (patch.pitchMap) session.viewport = { ...session.viewport, pitchMap: patch.pitchMap };
	if (patch.frequencyProjection)
		session.viewport = { ...session.viewport, projection: patch.frequencyProjection };
	if (patch.minFrequencyHz !== undefined)
		session.viewport = { ...session.viewport, minFrequencyHz: patch.minFrequencyHz };
	if (patch.maxFrequencyHz !== undefined)
		session.viewport = { ...session.viewport, maxFrequencyHz: patch.maxFrequencyHz };
}

export function duplicateAutomationLanesOf(trackId: Id): void {
	mutate('Copy automation', (project) =>
		mapTracks(project, trackId, (track) => ({
			...track,
			automationLanes: duplicateLanes(track.automationLanes)
		}))
	);
}

/** Track used by editor gestures, resolving the selection once per action. */
export function selectedTrackOrNull(): Track | null {
	return isMasterSelected() ? null : activeTrack();
}
