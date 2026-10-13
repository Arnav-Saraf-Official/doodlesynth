import { createDefaultSynth } from './project';
import { createSoundProfile } from './soundProfile';
import type { EffectKind, SoundProfile } from './types';

export const SOUND_STARTERS = [
	{
		id: 'sub',
		name: 'Round sub',
		category: 'Bass',
		description: 'Clean sine foundation with a little triangle body.'
	},
	{
		id: 'pad',
		name: 'Slow bloom',
		category: 'Pad',
		description: 'Soft layered saws, wide unison and a long release.'
	},
	{
		id: 'pluck',
		name: 'Glass pluck',
		category: 'Pluck',
		description: 'Short sine-and-triangle strike with a quiet octave shimmer.'
	},
	{
		id: 'lead',
		name: 'Wide lead',
		category: 'Lead',
		description: 'Detuned saws over a square core, with subtle distortion.'
	},
	{
		id: 'organ',
		name: 'Drawbar organ',
		category: 'Keys',
		description: 'Three sine drawbars at the fundamental, octave and fifth.'
	},
	{
		id: 'echo',
		name: 'Echo keys',
		category: 'Keys',
		description: 'Soft triangle keys with tempo-locked ping-pong repeats.'
	}
] as const;

export type SoundStarterId = (typeof SOUND_STARTERS)[number]['id'];

/** Original patches, created afresh so edits never alter another instance or the catalog. */
export function createStarterSound(id: SoundStarterId): SoundProfile {
	const starter = SOUND_STARTERS.find((entry) => entry.id === id);
	if (!starter) throw new Error('Unknown starter sound');
	const profile = createSoundProfile(starter.name, createDefaultSynth());
	profile.category = starter.category;
	const synth = profile.synth;
	const [a, b, c] = synth.oscillators!;
	synth.outputDb = -12;
	synth.filter.enabled = false;
	synth.envelope = { attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.25 };
	const effect = (kind: EffectKind, mix: number, params?: Record<string, number>) => {
		const module = synth.effects!.find((entry) => entry.kind === kind)!;
		module.enabled = true;
		module.mix = mix;
		if (params) module.params = { ...module.params, ...params };
	};
	if (id === 'sub') {
		a.wave = 'sine';
		b.enabled = true;
		b.wave = 'triangle';
		b.level = 0.2;
		synth.envelope = { attack: 0.008, decay: 0.15, sustain: 0.85, release: 0.12 };
	} else if (id === 'pad') {
		a.unison = { voices: 5, detuneCents: 14, phaseSpread: 0.15, stereoSpread: 0.85 };
		b.enabled = true;
		b.wave = 'triangle';
		b.transpose = 12;
		b.level = 0.25;
		synth.filter.enabled = true;
		synth.filter.cutoff = 2200;
		synth.envelope = { attack: 0.6, decay: 0.5, sustain: 0.8, release: 1.8 };
		effect('chorus', 0.18);
		effect('reverb', 0.22, { decay: 2.8 });
	} else if (id === 'pluck') {
		a.wave = 'sine';
		b.enabled = true;
		b.wave = 'triangle';
		b.level = 0.3;
		c.enabled = true;
		c.wave = 'sine';
		c.transpose = 12;
		c.level = 0.15;
		synth.envelope = { attack: 0.002, decay: 0.45, sustain: 0, release: 0.18 };
		effect('reverb', 0.15, { decay: 1.2 });
	} else if (id === 'lead') {
		a.unison = { voices: 3, detuneCents: 10, phaseSpread: 0.1, stereoSpread: 0.7 };
		b.enabled = true;
		b.wave = 'square';
		b.level = 0.25;
		synth.filter.enabled = true;
		synth.filter.cutoff = 5000;
		synth.envelope = { attack: 0.008, decay: 0.15, sustain: 0.8, release: 0.15 };
		effect('distortion', 0.12, { drive: 0.2 });
	} else if (id === 'organ') {
		a.wave = b.wave = c.wave = 'sine';
		b.enabled = c.enabled = true;
		b.transpose = 12;
		b.level = 0.45;
		c.transpose = 19;
		c.level = 0.25;
		synth.envelope = { attack: 0.008, decay: 0, sustain: 1, release: 0.08 };
	} else {
		a.wave = 'triangle';
		synth.envelope = { attack: 0.006, decay: 0.5, sustain: 0.15, release: 0.3 };
		synth.delay = {
			mix: 0.25,
			time: 0.25,
			feedback: 0.35,
			mode: 'ping-pong',
			sync: true,
			beats: 0.75,
			lowCut: 150,
			highCut: 5000,
			width: 1
		};
		effect('delay', 0.25);
		effect('reverb', 0.1, { decay: 1.2 });
	}
	// Keep the legacy inspector's primary source/envelope values in sync.
	synth.wave = a.wave;
	synth.unison = { ...a.unison };
	synth.attack = synth.envelope.attack;
	synth.release = synth.envelope.release;
	return profile;
}
