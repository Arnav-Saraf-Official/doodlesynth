import { uid } from './ids';
import type {
	EffectKind,
	OscillatorSettings,
	Project,
	SoundEffect,
	SoundProfile,
	SynthSettings,
	Track
} from './types';

export function oscillatorFromSynth(synth: SynthSettings, enabled = true): OscillatorSettings {
	return {
		enabled,
		wave: synth.wave,
		wavetableId: synth.wavetableId,
		wavetablePosition: synth.wavetablePosition,
		transpose: 0,
		fineCents: 0,
		level: 1,
		pan: 0,
		phase: 0,
		phaseRandomization: 0,
		unison: { ...synth.unison, stereoSpread: 0.7 },
		routing: 'filter1'
	};
}

export const EFFECT_CONTROLS: Record<
	EffectKind,
	{ key: string; label: string; min: number; max: number; step: number; value: number }[]
> = {
	chorus: [
		{ key: 'rate', label: 'Rate · Hz', min: 0.05, max: 10, step: 0.05, value: 0.6 },
		{ key: 'depth', label: 'Depth · ms', min: 0, max: 12, step: 0.1, value: 4 },
		{ key: 'time', label: 'Delay · ms', min: 5, max: 40, step: 1, value: 18 }
	],
	compressor: [
		{ key: 'threshold', label: 'Threshold · dB', min: -60, max: 0, step: 1, value: -24 },
		{ key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, value: 4 },
		{ key: 'attack', label: 'Attack · ms', min: 1, max: 100, step: 1, value: 10 },
		{ key: 'release', label: 'Release · ms', min: 10, max: 1000, step: 10, value: 150 }
	],
	delay: [],
	distortion: [{ key: 'drive', label: 'Drive', min: 0, max: 1, step: 0.01, value: 0.3 }],
	eq: [
		{ key: 'low', label: 'Low · dB', min: -18, max: 18, step: 0.5, value: 0 },
		{ key: 'mid', label: 'Mid · dB', min: -18, max: 18, step: 0.5, value: 0 },
		{ key: 'high', label: 'High · dB', min: -18, max: 18, step: 0.5, value: 0 },
		{ key: 'frequency', label: 'Mid · Hz', min: 100, max: 10000, step: 10, value: 1000 }
	],
	filter: [
		{ key: 'cutoff', label: 'Cutoff · Hz', min: 20, max: 20000, step: 10, value: 6000 },
		{ key: 'resonance', label: 'Resonance · dB', min: 0, max: 20, step: 0.1, value: 1 }
	],
	flanger: [
		{ key: 'rate', label: 'Rate · Hz', min: 0.05, max: 10, step: 0.05, value: 0.25 },
		{ key: 'depth', label: 'Depth · ms', min: 0, max: 5, step: 0.1, value: 1 },
		{ key: 'feedback', label: 'Feedback', min: 0, max: 0.9, step: 0.01, value: 0.4 }
	],
	phaser: [
		{ key: 'rate', label: 'Rate · Hz', min: 0.05, max: 10, step: 0.05, value: 0.4 },
		{ key: 'frequency', label: 'Center · Hz', min: 100, max: 8000, step: 10, value: 1000 },
		{ key: 'depth', label: 'Depth · Hz', min: 0, max: 900, step: 10, value: 600 }
	],
	reverb: [
		{ key: 'decay', label: 'Decay · s', min: 0.1, max: 8, step: 0.1, value: 1.6 },
		{ key: 'preDelay', label: 'Pre-delay · ms', min: 0, max: 250, step: 1, value: 10 },
		{ key: 'damping', label: 'High cut · Hz', min: 500, max: 20000, step: 100, value: 7000 }
	]
};

export function createSoundEffect(kind: EffectKind): SoundEffect {
	return {
		id: uid('fx'),
		kind,
		enabled: false,
		mix: kind === 'compressor' || kind === 'eq' || kind === 'filter' ? 1 : 0.3,
		params: Object.fromEntries(EFFECT_CONTROLS[kind].map((c) => [c.key, c.value]))
	};
}

export function createSoundProfile(
	name: string,
	synth: SynthSettings,
	track?: Track
): SoundProfile {
	return {
		id: uid('sound'),
		name,
		category: 'User',
		synth: {
			...synth,
			oscillators: synth.oscillators ?? [
				oscillatorFromSynth(synth),
				oscillatorFromSynth(synth, false),
				oscillatorFromSynth(synth, false)
			],
			noise: synth.noise ?? { enabled: false, level: 0.15, pan: 0 },
			filter2: synth.filter2 ?? { ...synth.filter, enabled: false },
			effects:
				synth.effects ??
				(
					[
						'chorus',
						'compressor',
						'distortion',
						'eq',
						'filter',
						'flanger',
						'phaser',
						'delay',
						'reverb'
					] as EffectKind[]
				).map((kind) => {
					const effect = createSoundEffect(kind);
					if (kind === 'delay') {
						effect.enabled = synth.delay.mix > 0;
						effect.mix = synth.delay.mix;
					}
					if (kind === 'reverb') {
						effect.enabled = synth.reverb.mix > 0;
						effect.mix = synth.reverb.mix;
					}
					return effect;
				}),
			outputDb: synth.outputDb ?? (track ? 0 : -6)
		},
		lfos: track?.lfos ?? [],
		modEnvelopes: track?.modEnvelopes ?? []
	};
}

/** Resolve shared profiles at the mutation boundary, preserving curves and track automation. */
export function reconcileSoundProfiles(project: Project): Project {
	let changed = false;
	const tracks = project.tracks.map((track) => {
		const profile = project.soundProfiles?.find((sound) => sound.id === track.soundProfileId);
		if (
			!profile ||
			(track.synth === profile.synth &&
				track.lfos === profile.lfos &&
				track.modEnvelopes === profile.modEnvelopes)
		)
			return track;
		changed = true;
		return {
			...track,
			synth: profile.synth,
			lfos: profile.lfos,
			modEnvelopes: profile.modEnvelopes
		};
	});
	return changed ? { ...project, tracks } : project;
}

export function ensureSoundProfiles(project: Project): Project {
	const soundProfiles = [...(project.soundProfiles ?? [])];
	let changed = !project.soundProfiles;
	const tracks = project.tracks.map((track) => {
		if (soundProfiles.some((sound) => sound.id === track.soundProfileId)) return track;
		const sound = createSoundProfile(`${track.name} sound`, track.synth, track);
		soundProfiles.push(sound);
		changed = true;
		return {
			...track,
			soundProfileId: sound.id,
			synth: sound.synth,
			lfos: sound.lfos,
			modEnvelopes: sound.modEnvelopes
		};
	});
	return reconcileSoundProfiles(changed ? { ...project, soundProfiles, tracks } : project);
}
