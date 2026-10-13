/**
 * Modulation envelopes.
 *
 * An envelope is a beat-locked attack/decay shape that modulates one registry
 * parameter. What makes it musical is the trigger policy, and both triggers
 * are defined in terms of the curve data rather than a separate note list:
 *
 * - 'start' fires at the first point of every curve, so each voice path gets
 *   its own sweep from the moment it begins.
 * - 'change' fires where the pitch stabilizes after a near-vertical jump: the
 *   slope between two consecutive points is measured in octaves per beat, and
 *   when it exceeds the threshold the landing side of the jump becomes the
 *   trigger point. A glide never fires it; a hard step does.
 */

import { uid } from './ids';
import type { Curve, CurvePoint, ModEnvelope, ParameterKey } from './types';

/** Slope, in octaves of pitch change per beat, that counts as a hard step. */
export const CHANGE_OCTAVES_PER_BEAT = 12;

export function createModEnvelope(destination: ParameterKey): ModEnvelope {
	return {
		id: uid('env'),
		enabled: true,
		destination,
		trigger: 'start',
		attackBeats: 0.5,
		decayBeats: 2,
		amount: 0.5
	};
}

/** Envelope level 0..1 at a phase measured in beats since the last trigger. */
export function envelopeValueAt(envelope: ModEnvelope, phaseBeats: number): number {
	if (phaseBeats < 0) return 0;
	const attack = Math.max(0, envelope.attackBeats);
	const decay = Math.max(0, envelope.decayBeats);
	if (attack === 0 && decay === 0) return 0;
	if (phaseBeats < attack) return attack === 0 ? 1 : phaseBeats / attack;
	if (decay === 0) return 0;
	const t = (phaseBeats - attack) / decay;
	return t >= 1 ? 0 : 1 - t;
}

function slopeOctavesPerBeat(a: CurvePoint, b: CurvePoint): number {
	const dt = Math.max(1e-4, b.time - a.time);
	const fa = Math.max(1e-3, a.frequency);
	const fb = Math.max(1e-3, b.frequency);
	return Math.abs(Math.log2(fb / fa)) / dt;
}

/**
 * Beats at which an envelope retriggers. 'start' collects every curve start;
 * 'change' collects the landing point of every near-vertical jump — the beat
 * where the pitch arrives and becomes stable again.
 */
export function triggerBeatsFor(curves: Curve[], trigger: ModEnvelope['trigger']): number[] {
	const out: number[] = [];
	for (const curve of curves) {
		if (curve.muted || curve.points.length === 0) continue;
		const points = [...curve.points].sort((a, b) => a.time - b.time);
		if (trigger === 'start') {
			out.push(points[0].time);
			continue;
		}
		for (let index = 1; index < points.length; index++) {
			if (
				slopeOctavesPerBeat(points[index - 1], points[index]) >= CHANGE_OCTAVES_PER_BEAT &&
				index + 1 < points.length &&
				slopeOctavesPerBeat(points[index], points[index + 1]) <= 0.25
			) {
				out.push(points[index].time);
			}
		}
	}
	return out.sort((a, b) => a - b);
}

/** Latest trigger at or before `beat`, or -1 when none has fired yet. */
export function lastTriggerIndex(triggers: number[], beat: number): number {
	let low = 0;
	let high = triggers.length - 1;
	let found = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (triggers[mid] <= beat) {
			found = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return found;
}

/**
 * Apply an envelope's bipolar modulation (envelope level × amount) to a
 * parameter's base value. Each destination scales in its own natural domain:
 * frequency multiplies in octaves, dB adds decibels, ratios stay ratios.
 */
export function modulateParameter(key: string, base: number, mod: number): number {
	switch (key as ParameterKey) {
		case 'filter.cutoff':
			return base * Math.pow(2, mod * 6);
		case 'filter.resonance':
			return base + mod * 12;
		case 'volume':
			return base + mod * 24;
		case 'pan':
			return Math.max(-1, Math.min(1, base + mod));
		case 'filter.drive':
			return Math.max(0, Math.min(1, base + mod));
		case 'fx.delay.mix':
		case 'fx.reverb.mix':
			return Math.max(0, Math.min(1, base + mod));
		case 'pitch.offset':
			return base + mod * 12;
		case 'pitch.fine':
			return base + mod * 100;
		default:
			return base + mod;
	}
}
