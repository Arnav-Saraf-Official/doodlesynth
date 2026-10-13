import { describe, expect, test } from 'bun:test';
import { createStarterSound, SOUND_STARTERS } from './soundStarters';
import {
	createCurve,
	createDefaultProject,
	createTrack,
	deserializeProject,
	migrateProject,
	serializeProject
} from './project';
import { ensureSoundProfiles, reconcileSoundProfiles } from './soundProfile';
import { delayTimes } from '../audio/effects';
import { importVitalPreset } from './vitalImport';
import { createModEnvelope, envelopeValueAt, triggerBeatsFor } from './modEnvelope';

describe('starter sounds', () => {
	test('every starter creates independent, bounded, playable sources', () => {
		for (const starter of SOUND_STARTERS) {
			const first = createStarterSound(starter.id);
			const second = createStarterSound(starter.id);
			expect(first.id).not.toBe(second.id);
			expect(first.category).toBe(starter.category);
			expect(first.synth.oscillators!.some((osc) => osc.enabled && osc.level > 0)).toBe(true);
			expect(
				first.synth.oscillators!.reduce(
					(sum, osc) => sum + (osc.enabled ? osc.unison.voices : 0),
					0
				)
			).toBeLessThanOrEqual(16);
			first.synth.oscillators![0].level = 0;
			first.synth.effects![0].params.rate = 99;
			expect(second.synth.oscillators![0].level).toBe(1);
			expect(second.synth.effects![0].params.rate).not.toBe(99);
		}
	});
	test('favorites survive project serialization without requiring migration', () => {
		const project = createDefaultProject();
		const sound = createStarterSound('pad');
		sound.favorite = true;
		project.soundProfiles.push(sound);
		expect(
			deserializeProject(serializeProject(project)).soundProfiles.find(
				(entry) => entry.id === sound.id
			)?.favorite
		).toBe(true);
	});
});

describe('shared sound profiles', () => {
	test('migrates real legacy tracks without altering curves or collapsed lanes', () => {
		const project = createDefaultProject();
		const track = createTrack('Legacy');
		track.curves = [createCurve(1, 222, 3, 444)];
		track.automationLanes = [
			{ id: 'lane', enabled: true, target: 'volume', expanded: false, points: [] }
		];
		project.tracks = [track];
		project.version = 3;
		const migrated = migrateProject(project);
		expect(migrated.soundProfiles).toHaveLength(1);
		expect(migrated.tracks[0].soundProfileId).toBe(migrated.soundProfiles[0].id);
		expect(migrated.tracks[0].curves).toEqual(track.curves);
		expect(migrated.tracks[0].automationLanes[0].expanded).toBe(false);
		expect(migrated.tracks[0].synth.oscillators).toHaveLength(3);
		expect(migrateProject(migrated)).toBe(migrated);
	});
	test('shared patch resolves to both tracks while retaining each curve/mixer', () => {
		let project = ensureSoundProfiles({ ...createDefaultProject(), tracks: [createTrack('A')] });
		const second = {
			...createTrack('B'),
			soundProfileId: project.soundProfiles[0].id,
			curves: [createCurve()]
		};
		second.mixer.volumeDb = -12;
		project = {
			...project,
			tracks: [...project.tracks, second],
			soundProfiles: project.soundProfiles.map((profile) => ({
				...profile,
				name: 'Shared',
				synth: { ...profile.synth, outputDb: -9 }
			}))
		};
		const resolved = reconcileSoundProfiles(project);
		expect(resolved.tracks[0].synth).toBe(resolved.tracks[1].synth);
		expect(resolved.tracks[1].synth.outputDb).toBe(-9);
		expect(resolved.tracks[1].mixer.volumeDb).toBe(-12);
		expect(resolved.tracks[1].curves).toBe(second.curves);
	});
	test('serialization preserves sound links and regenerates editable waveform caches', () => {
		const project = createDefaultProject('Test', true);
		const copy = deserializeProject(serializeProject(project));
		expect(copy.soundProfiles[0].id).toBe(project.soundProfiles[0].id);
		expect(copy.tracks[0].soundProfileId).toBe(copy.soundProfiles[0].id);
		expect(copy.wavetables[0].frames[0].samples).toBeInstanceOf(Float32Array);
	});
});

test('delay free / sync times including dotted and triplet fractions', () => {
	expect(delayTimes({ mix: 1, feedback: 0.5, time: 0.2, rightTime: 0.3 }, 120)).toEqual([0.2, 0.3]);
	expect(
		delayTimes(
			{ mix: 1, feedback: 0.5, time: 0.2, sync: true, beats: 0.75, rightBeats: 1 / 3 },
			120
		)
	).toEqual([0.375, 1 / 6]);
	expect(delayTimes({ mix: 1, feedback: 0.5, time: 900 }, 120)[0]).toBe(8);
});

test('pitch-change envelopes wait until steep transitions stabilize', () => {
	const curve = createCurve();
	const template = curve.points[0];
	curve.points = [
		[0, 220],
		[0.01, 440],
		[0.02, 880],
		[1, 880]
	].map(([time, frequency], index) => ({ ...template, id: String(index), time, frequency }));
	expect(triggerBeatsFor([curve], 'change')).toEqual([0.02]);
	expect(triggerBeatsFor([curve], 'start')).toEqual([0]);
	const envelope = { ...createModEnvelope('volume'), attackBeats: 1, decayBeats: 0 };
	expect(envelopeValueAt(envelope, 2)).toBe(0);
});

describe('Vital 1.x conversion', () => {
	test('validates format and bounds unison / envelope values', () => {
		expect(() => importVitalPreset('{}')).toThrow();
		expect(() =>
			importVitalPreset(JSON.stringify({ synth_version: '0.9', settings: { osc_1_on: 1 } }))
		).toThrow();
		const { profile, warnings } = importVitalPreset(
			JSON.stringify({
				synth_version: '1.0.8',
				preset_name: 'Patch',
				settings: {
					osc_1_on: 1,
					osc_1_unison_voices: 999,
					osc_1_level: 0.5,
					osc_1_tune: -0.3,
					env_1_attack: 0.5,
					sample_on: 1,
					modulations: [{ source: 'lfo_1', destination: 'filter_1_cutoff' }]
				}
			})
		);
		expect(profile.synth.oscillators?.[0].unison.voices).toBe(16);
		expect(profile.synth.oscillators?.[0].level).toBe(0.25);
		expect(profile.synth.oscillators?.[0].fineCents).toBe(-30);
		expect(profile.synth.envelope?.attack).toBe(0.0625);
		expect(warnings.some((w) => w.includes('Sample player omitted'))).toBe(true);
		expect(warnings.some((w) => w.includes('assignments omitted'))).toBe(true);
	});
	test('imports float32 Wave Source keyframes as editable harmonics', () => {
		const samples = new Float32Array(2048);
		for (let i = 0; i < samples.length; i++)
			samples[i] = Math.sin((Math.PI * 2 * i) / samples.length);
		const wave_data = Buffer.from(samples.buffer).toString('base64');
		const result = importVitalPreset(
			JSON.stringify({
				synth_version: '1.0.8',
				settings: {
					osc_1_on: 1,
					wavetables: [
						{
							name: 'Sine',
							groups: [
								{ components: [{ type: 'Wave Source', keyframes: [{ position: 0, wave_data }] }] }
							]
						}
					]
				}
			})
		);
		expect(result.wavetables).toHaveLength(1);
		const source = result.wavetables[0].frames[0].source;
		expect(source.kind).toBe('harmonics');
		if (source.kind === 'harmonics') {
			expect(source.components[0].amplitude).toBeCloseTo(1, 5);
			expect(source.components[0].phaseRadians).toBeCloseTo(0, 5);
		}
		expect(result.profile.synth.oscillators?.[0].wavetableId).toBe(result.wavetables[0].id);
	});
});
