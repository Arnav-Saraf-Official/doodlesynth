/**
 * Navigation commands.
 *
 * Zooming is always anchored: horizontal zoom keeps the playhead under the
 * cursor's conceptual position, and pitch zoom keeps the centre frequency
 * fixed, so the view never jumps to a surprising place.
 */

import { curveBounds } from '#lib/model/curve';
import { clamp } from '#lib/model/pitch';
import { lastContentBeat } from '#lib/model/project';
import type { Curve } from '#lib/model/types';
import type { ViewportState } from '#lib/editor/transform';
import {
	fitFrequencyRange,
	fitTimeRange,
	panFrequency,
	resetFrequencyRange,
	zoomFrequencyAt,
	zoomTimeAt
} from '#lib/editor/viewport';
import { activeTrack, isMasterSelected, session, updateViewport } from './session.svelte';

export function zoomTime(factor: number, anchorBeat = session.playhead): void {
	updateViewport((viewport) => zoomTimeAt(viewport, factor, anchorBeat));
}

export function zoomPitch(factor: number): void {
	updateViewport((viewport) =>
		zoomFrequencyAt(viewport, factor, Math.sqrt(viewport.minFrequencyHz * viewport.maxFrequencyHz))
	);
}

export function panTime(beats: number): void {
	updateViewport((viewport) =>
		clampViewportStart({ ...viewport, startBeat: Math.max(0, viewport.startBeat + beats) })
	);
}

export function panPitch(ratio: number): void {
	updateViewport((viewport) => panFrequency(viewport, ratio));
}

export function zoomToProject(): void {
	const project = session.project;
	const end = Math.max(lastContentBeat(project), project.durationBeats, 8);
	updateViewport((viewport) =>
		resetFrequencyRange(
			fitTimeRange(viewport, 0, end, 0.02),
			project.editorSettings.minFrequencyHz,
			project.editorSettings.maxFrequencyHz
		)
	);
}

function selectedCurves(): Curve[] {
	if (isMasterSelected()) return [];
	const track = activeTrack();
	if (!track) return [];
	return track.curves.filter((curve) => session.selectedCurveIds.includes(curve.id));
}

export function zoomToSelection(): void {
	const curves = selectedCurves();
	if (curves.length === 0) {
		zoomToProject();
		return;
	}

	let start = Infinity;
	let end = -Infinity;
	let minFrequency = Infinity;
	let maxFrequency = -Infinity;
	for (const curve of curves) {
		const bounds = curveBounds(curve.points);
		start = Math.min(start, bounds.startTime);
		end = Math.max(end, bounds.endTime);
		minFrequency = Math.min(minFrequency, bounds.minFrequency);
		maxFrequency = Math.max(maxFrequency, bounds.maxFrequency);
	}
	if (!Number.isFinite(start)) return;
	// a single flat curve would otherwise zoom to an infinite pitch range
	if (maxFrequency / minFrequency < 1.02) {
		minFrequency /= 1.4;
		maxFrequency *= 1.4;
	}

	updateViewport((viewport) =>
		fitFrequencyRange(fitTimeRange(viewport, start, end, 0.12), minFrequency, maxFrequency)
	);
}

export function resetView(): void {
	updateViewport((viewport) =>
		resetFrequencyRange(
			{ ...viewport, startBeat: 0 },
			session.project.editorSettings.minFrequencyHz,
			session.project.editorSettings.maxFrequencyHz
		)
	);
}

export function goToStart(): void {
	updateViewport((viewport) => ({ ...viewport, startBeat: 0 }));
}

export function goToEnd(): void {
	updateViewport((viewport) => ({
		...viewport,
		startBeat: Math.max(
			0,
			lastContentBeat(session.project) - viewport.width / viewport.pixelsPerBeat / 2
		)
	}));
}

/** Keep the playhead visible while the transport runs. */
export function followPlayhead(): void {
	updateViewport((viewport) => {
		if (viewport.pixelsPerBeat <= 0) return viewport;
		const visibleBeats = viewport.width / viewport.pixelsPerBeat;
		const rightEdge = viewport.startBeat + visibleBeats;
		if (
			session.playhead > viewport.startBeat &&
			session.playhead < rightEdge - visibleBeats * 0.15
		) {
			return viewport;
		}
		return {
			...viewport,
			startBeat: Math.max(0, session.playhead - visibleBeats * 0.2)
		};
	});
}

function clampViewportStart(viewport: ViewportState): ViewportState {
	return { ...viewport, startBeat: Math.max(0, viewport.startBeat) };
}

/** Snap step in beats for the current editor settings, 0 when snapping is off. */
export function currentSnapStep(): number {
	if (!session.snapEnabled) return 0;
	const settings = session.project.editorSettings;
	if (settings.snapTime === 'none') return 0;
	const signature = session.project.timeSignature;
	switch (settings.snapTime) {
		case 'bar':
			return (signature.numerator * 4) / signature.denominator;
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
			return clamp(settings.customSnapTicks / 480, 0.001, 64);
		default:
			return 0;
	}
}

export { clampViewportStart };
