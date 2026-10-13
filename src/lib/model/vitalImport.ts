import { createDefaultSynth } from './project';
import { createSoundProfile } from './soundProfile';
import { createWavetable } from './wavetable';
import { uid } from './ids';
import type { HarmonicComponent, SoundProfile, Wavetable, WavetableFrame } from './types';

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
const bounded = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Vital Wave Source keyframes contain 2048 little-endian float32 samples in base64. */
function waveFrame(raw: Record<string, unknown>): WavetableFrame {
	if (typeof raw.wave_data !== 'string' || raw.wave_data.length > 12000)
		throw new Error('Invalid embedded Vital waveform');
	const bytes = Uint8Array.from(atob(raw.wave_data), (c) => c.charCodeAt(0));
	if (bytes.byteLength !== 2048 * 4)
		throw new Error('Expected a 2048-sample Vital Wave Source frame');
	const view = new DataView(bytes.buffer);
	const samples = new Float32Array(2048);
	for (let i = 0; i < samples.length; i++) {
		const value = view.getFloat32(i * 4, true);
		if (!Number.isFinite(value) || Math.abs(value) > 32) throw new Error('Invalid waveform sample');
		samples[i] = value;
	}
	// Independent Fourier projection; editable additive source, capped at engine partial budget.
	const components: HarmonicComponent[] = [];
	for (let n = 1; n <= 128; n++) {
		let re = 0,
			im = 0;
		for (let i = 0; i < samples.length; i++) {
			const angle = (Math.PI * 2 * n * i) / samples.length;
			re += samples[i] * Math.cos(angle);
			im += samples[i] * Math.sin(angle);
		}
		re *= 2 / samples.length;
		im *= 2 / samples.length;
		const amplitude = bounded(Math.hypot(re, im), 0, 1);
		components.push({
			harmonic: n,
			waveform: 'sine',
			amplitude,
			phaseRadians: (Math.atan2(re, im) + Math.PI * 2) % (Math.PI * 2),
			enabled: amplitude > 0.00001
		});
	}
	return {
		id: uid('frame'),
		position: bounded(typeof raw.position === 'number' ? raw.position / 256 : 0, 0, 1),
		interpolation: 'linear',
		source: { kind: 'harmonics', components },
		samples
	};
}

export interface VitalImportResult {
	profile: SoundProfile;
	wavetables: Wavetable[];
	warnings: string[];
}

export function importVitalPreset(text: string): VitalImportResult {
	if (text.length > 16 * 1024 * 1024) throw new Error('Preset exceeds the 16 MB import limit');
	const raw = object(JSON.parse(text));
	const settings = object(raw.settings);
	if (!Object.keys(settings).length || typeof raw.synth_version !== 'string')
		throw new Error('Not a standard .vital JSON preset');
	if (!/^1\./.test(raw.synth_version)) throw new Error('Only Vital 1.x presets are supported');
	const number = (key: string, fallback: number) => {
		const value = settings[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
	};
	const warnings: string[] = [
		'Converted patch: Web Audio is not Vital’s DSP. Filters, effects, modulation timing and wavetable interpolation can sound different.'
	];
	const profile = createSoundProfile(
		typeof raw.preset_name === 'string' ? raw.preset_name.slice(0, 120) : 'Imported Vital sound',
		createDefaultSynth()
	);
	profile.category =
		typeof raw.preset_style === 'string' ? raw.preset_style.slice(0, 60) : 'Imported';
	const tables: Wavetable[] = [];
	const rawTables = Array.isArray(settings.wavetables) ? settings.wavetables : [];
	profile.synth.oscillators = profile.synth.oscillators!.map((osc, index) => {
		const prefix = `osc_${index + 1}_`;
		const tableRaw = object(rawTables[index]);
		const groups = Array.isArray(tableRaw.groups) ? tableRaw.groups : [];
		const components = groups
			.flatMap((group) => {
				const c = object(group).components;
				return Array.isArray(c) ? c : [];
			})
			.map(object);
		const source = components.find((component) => component.type === 'Wave Source');
		let table: Wavetable | undefined;
		if (
			source &&
			Array.isArray(source.keyframes) &&
			source.keyframes.length > 0 &&
			source.keyframes.length <= 64
		) {
			table = createWavetable(
				typeof tableRaw.name === 'string'
					? tableRaw.name.slice(0, 120)
					: `Vital oscillator ${index + 1}`,
				source.keyframes.map((frame) => waveFrame(object(frame))),
				2048
			);
			tables.push(table);
			if (groups.length !== 1 || components.length !== 1)
				warnings.push(
					`Oscillator ${index + 1}: imported the first Wave Source only; extra groups/modifiers are not rendered.`
				);
			warnings.push(
				`Oscillator ${index + 1}: embedded frames reduced to 128 partials with time-domain interpolation.`
			);
		} else if (number(prefix + 'on', index === 0 ? 1 : 0))
			warnings.push(
				`Oscillator ${index + 1}: unsupported/missing wavetable source; substituted saw.`
			);
		if (number(prefix + 'spectral_morph_type', 0) || number(prefix + 'distortion_type', 0))
			warnings.push(
				`Oscillator ${index + 1}: spectral warping / phase distortion / FM is not imported.`
			);
		const detuneRange = number(prefix + 'detune_range', 2);
		warnings.push(
			`Oscillator ${index + 1}: unison detune distribution and blend are approximated.`
		);
		const destination = number(prefix + 'destination', index === 1 ? 1 : index === 2 ? 3 : 0);
		if (destination === 2 || destination >= 4)
			warnings.push(
				`Oscillator ${index + 1}: dual-filter/effect destination approximated as direct.`
			);
		return {
			...osc,
			enabled: number(prefix + 'on', index === 0 ? 1 : 0) > 0,
			wave: table ? 'wavetable' : 'saw',
			wavetableId: table?.id,
			wavetablePosition: bounded(number(prefix + 'wave_frame', 0) / 256, 0, 1),
			transpose: bounded(number(prefix + 'transpose', 0), -48, 48),
			fineCents: bounded(number(prefix + 'tune', 0) * 100, -100, 100),
			level: bounded(number(prefix + 'level', Math.SQRT1_2) ** 2, 0, 1),
			pan: bounded(number(prefix + 'pan', 0), -1, 1),
			phase: bounded(number(prefix + 'phase', 0.5), 0, 1),
			phaseRandomization: bounded(number(prefix + 'random_phase', 1), 0, 1),
			unison: {
				voices: bounded(Math.round(number(prefix + 'unison_voices', 1)), 1, 16),
				detuneCents: bounded(
					(number(prefix + 'unison_detune', Math.sqrt(20)) ** 2 / 100) * detuneRange * 100,
					0,
					100
				),
				phaseSpread: 0,
				stereoSpread: bounded(number(prefix + 'stereo_spread', 1), 0, 1)
			},
			routing: destination === 0 ? 'filter1' : destination === 1 ? 'filter2' : 'direct'
		};
	});
	profile.synth.filter = {
		enabled: number('filter_1_on', 0) > 0,
		type: 'lowpass',
		cutoff: bounded(440 * 2 ** ((number('filter_1_cutoff', 60) - 69) / 12), 20, 20000),
		resonance: bounded(number('filter_1_resonance', 0.5) * 20, 0, 30)
	};
	profile.synth.filter2 = {
		enabled: number('filter_2_on', 0) > 0,
		type: 'lowpass',
		cutoff: bounded(440 * 2 ** ((number('filter_2_cutoff', 60) - 69) / 12), 20, 20000),
		resonance: bounded(number('filter_2_resonance', 0.5) * 20, 0, 30)
	};
	if (profile.synth.filter.enabled || profile.synth.filter2.enabled)
		warnings.push(
			'Voice filters approximated as Web Audio low-pass; Vital model/blend/drive/keytracking are not imported.'
		);
	profile.synth.envelope = {
		attack: bounded(number('env_1_attack', 0.1495) ** 4, 0, 32),
		decay: bounded(number('env_1_decay', 1) ** 4, 0, 32),
		sustain: bounded(number('env_1_sustain', 1), 0, 1),
		release: bounded(number('env_1_release', 0.5476) ** 4, 0, 32)
	};
	if (
		number('env_1_delay', 0) ||
		number('env_1_hold', 0) ||
		number('env_1_attack_power', 0) ||
		number('env_1_decay_power', -2) ||
		number('env_1_release_power', -2)
	)
		warnings.push('Amplitude envelope delay/hold/curvature omitted; ADSR stage times imported.');
	const activeMods = Array.isArray(settings.modulations)
		? settings.modulations.filter((mod) => object(mod).source && object(mod).destination)
		: [];
	if (activeMods.length)
		warnings.push(
			`${activeMods.length} Vital modulation assignments omitted (custom LFOs, random, macros and remapping are not compatible).`
		);
	if (number('sample_on', 0))
		warnings.push('Sample player omitted; no sample or noise substitution was made.');
	profile.synth.delay = {
		mix: bounded(number('delay_dry_wet', 0.3334), 0, 1),
		time: bounded(2 ** -number('delay_frequency', 2), 0.005, 8),
		rightTime: bounded(2 ** -number('delay_aux_frequency', 2), 0.005, 8),
		feedback: bounded(number('delay_feedback', 0.5), 0, 0.95),
		mode:
			number('delay_style', 0) >= 2
				? 'ping-pong'
				: number('delay_style', 0) === 1
					? 'stereo'
					: 'mono',
		sync: false,
		lowCut: 20,
		highCut: 12000,
		width: 1
	};
	if (number('delay_on', 0) && number('delay_sync', 1))
		warnings.push(
			'Tempo-synced Vital delay converted to its stored free-time frequency; choose beat sync manually.'
		);
	profile.synth.effects = profile.synth.effects!.map((effect) => {
		const enabled = number(`${effect.kind}_on`, 0) > 0;
		if (enabled && !['delay', 'distortion', 'reverb', 'eq'].includes(effect.kind))
			warnings.push(
				`${effect.kind}: effect omitted; Vital controls differ from this implementation.`
			);
		const supported = ['delay', 'distortion', 'reverb', 'eq'].includes(effect.kind);
		const mix =
			effect.kind === 'delay'
				? profile.synth.delay.mix
				: effect.kind === 'reverb'
					? bounded(number('reverb_dry_wet', 0.25), 0, 1)
					: effect.kind === 'distortion'
						? bounded(number('distortion_mix', 1), 0, 1)
						: 1;
		const params = { ...effect.params };
		if (effect.kind === 'distortion') {
			params.drive = bounded(number('distortion_drive', 0) / 36, 0, 1);
			if (enabled) warnings.push('Distortion approximated as tanh saturation.');
		}
		if (effect.kind === 'reverb') {
			params.decay = bounded(2 ** number('reverb_decay_time', 0), 0.1, 8);
			if (enabled) warnings.push('Reverb approximated as a stereo convolution tail.');
		}
		if (effect.kind === 'eq') {
			params.low = bounded(number('eq_low_gain', 0), -18, 18);
			params.mid = bounded(number('eq_band_gain', 0), -18, 18);
			params.high = bounded(number('eq_high_gain', 0), -18, 18);
			params.frequency = bounded(440 * 2 ** ((number('eq_band_cutoff', 80) - 69) / 12), 100, 10000);
			if (enabled) warnings.push('EQ outer frequencies/modes/Q approximated.');
		}
		return { ...effect, enabled: enabled && supported, mix, params };
	});
	if (number('effect_chain_order', 0))
		warnings.push('Vital effect order omitted; default rack order used.');
	warnings.push(
		'Global output gain, glide, MPE, velocity, oversampling and advanced oscillator settings are not imported.'
	);
	profile.importWarnings = warnings;
	return { profile, wavetables: tables, warnings };
}
