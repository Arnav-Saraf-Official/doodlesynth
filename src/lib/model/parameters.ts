/**
 * Parameter registry.
 *
 * Automation is generic: adding a parameter is a data entry here, not a new
 * curve editor. Lanes, LFO destinations and inspector controls all read this
 * table so their ranges and units can never drift apart.
 */

import { clamp } from './pitch';
import type { ParameterDefinition, ParameterKey } from './types';

export const PARAMETERS: ParameterDefinition[] = [
	{
		key: 'volume',
		label: 'Volume',
		group: 'mix',
		min: -60,
		max: 6,
		defaultValue: 0,
		unit: 'dB',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'pan',
		label: 'Pan',
		group: 'mix',
		min: -1,
		max: 1,
		defaultValue: 0,
		unit: '',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'filter.cutoff',
		label: 'Filter Cutoff',
		group: 'filter',
		min: 20,
		max: 18000,
		defaultValue: 12000,
		unit: 'Hz',
		scale: 'logarithmic',
		scope: 'both'
	},
	{
		key: 'filter.resonance',
		label: 'Resonance',
		group: 'filter',
		min: 0,
		max: 30,
		defaultValue: 1,
		unit: '',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'filter.drive',
		label: 'Drive',
		group: 'fx',
		min: 0,
		max: 1,
		defaultValue: 0,
		unit: '%',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'wavetable.position',
		label: 'WT Position',
		group: 'source',
		min: 0,
		max: 1,
		defaultValue: 0,
		unit: '%',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'pitch.offset',
		label: 'Pitch Offset',
		group: 'pitch',
		min: -48,
		max: 48,
		defaultValue: 0,
		unit: 'st',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'pitch.fine',
		label: 'Fine Tune',
		group: 'pitch',
		min: -100,
		max: 100,
		defaultValue: 0,
		unit: '¢',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'tuning.ratio',
		label: 'Tuning Ratio',
		group: 'tuning',
		min: 0.25,
		max: 4,
		defaultValue: 1,
		unit: 'x',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'tuning.cents',
		label: 'Tuning Cents',
		group: 'tuning',
		min: -1200,
		max: 1200,
		defaultValue: 0,
		unit: '¢',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'fx.delay.mix',
		label: 'Delay Mix',
		group: 'fx',
		min: 0,
		max: 1,
		defaultValue: 0,
		unit: '%',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'fx.reverb.mix',
		label: 'Reverb Mix',
		group: 'fx',
		min: 0,
		max: 1,
		defaultValue: 0,
		unit: '%',
		scale: 'linear',
		scope: 'both'
	},
	{
		key: 'lfo1.amount',
		label: 'LFO 1 Amount',
		group: 'modulation',
		min: 0,
		max: 1,
		defaultValue: 0,
		unit: '%',
		scale: 'linear',
		scope: 'track'
	},
	{
		key: 'lfo1.rate',
		label: 'LFO 1 Rate',
		group: 'modulation',
		min: 0.01,
		max: 40,
		defaultValue: 2,
		unit: 'Hz',
		scale: 'logarithmic',
		scope: 'track'
	}
];

const REGISTRY = new Map(PARAMETERS.map((parameter) => [parameter.key, parameter]));

export function findParameter(key: ParameterKey): ParameterDefinition {
	return (
		REGISTRY.get(key) ?? {
			key,
			label: key,
			group: 'fx',
			min: 0,
			max: 1,
			defaultValue: 0,
			unit: '',
			scale: 'linear',
			scope: 'both'
		}
	);
}

export function parametersForScope(scope: 'master' | 'track'): ParameterDefinition[] {
	return PARAMETERS.filter((parameter) => parameter.scope === scope || parameter.scope === 'both');
}

/** Map a value onto 0..1 for lane drawing, honouring logarithmic parameters. */
export function normalizeParameterValue(key: ParameterKey, value: number): number {
	const definition = findParameter(key);
	const clamped = clamp(value, definition.min, definition.max);
	if (definition.scale === 'logarithmic') {
		const min = Math.log(Math.max(definition.min, 1e-4));
		const max = Math.log(definition.max);
		return (Math.log(Math.max(clamped, 1e-4)) - min) / (max - min);
	}
	return (clamped - definition.min) / (definition.max - definition.min || 1);
}

export function denormalizeParameterValue(key: ParameterKey, normalized: number): number {
	const definition = findParameter(key);
	const t = clamp(normalized, 0, 1);
	if (definition.scale === 'logarithmic') {
		const min = Math.log(Math.max(definition.min, 1e-4));
		const max = Math.log(definition.max);
		return Math.exp(min + t * (max - min));
	}
	return definition.min + t * (definition.max - definition.min);
}

export function clampParameterValue(key: ParameterKey, value: number): number {
	const definition = findParameter(key);
	return clamp(value, definition.min, definition.max);
}

export function formatParameterValue(key: ParameterKey, value: number): string {
	const definition = findParameter(key);
	switch (definition.unit) {
		case 'Hz':
			return value >= 1000 ? `${(value / 1000).toFixed(2)} kHz` : `${value.toFixed(1)} Hz`;
		case 'dB':
			return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)} dB`;
		case '%':
			return `${Math.round(value * 100)}%`;
		case 'st':
			return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} st`;
		case '¢':
			return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}¢`;
		case 's':
			return `${(value * 1000).toFixed(0)} ms`;
		default:
			return value.toFixed(2);
	}
}
