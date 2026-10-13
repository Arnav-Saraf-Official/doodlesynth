<script lang="ts">
	import { onMount } from 'svelte';
	import { engine } from '#lib/audio/engine';
	import { uid } from '#lib/model/ids';
	import { midiToHz, midiToName } from '#lib/model/pitch';
	import { createDefaultEnvelope, createDefaultSynth } from '#lib/model/project';
	import { createModEnvelope, envelopeValueAt } from '#lib/model/modEnvelope';
	import { createSoundProfile, EFFECT_CONTROLS } from '#lib/model/soundProfile';
	import { importVitalPreset } from '#lib/model/vitalImport';
	import {
		createStarterSound,
		SOUND_STARTERS,
		type SoundStarterId
	} from '#lib/model/soundStarters';
	import {
		createWavetable,
		createHarmonicFrame,
		renderWavetableAt,
		createHarmonicComponents
	} from '#lib/model/wavetable';
	import type {
		DelaySettings,
		Envelope,
		Lfo,
		ModEnvelope,
		OscillatorSettings,
		SoundEffect,
		SoundProfile,
		SynthSettings,
		WavetableFrameSource
	} from '#lib/model/types';
	import {
		addSoundProfile,
		deleteSoundProfile,
		selectTrackSound,
		updateSoundProfile,
		addWavetable,
		updateWavetableFrame
	} from '#lib/state/actions';
	import {
		activeTrack,
		canRedo,
		canUndo,
		initSession,
		mutate,
		redo,
		saveNow,
		session,
		undo
	} from '#lib/state/session.svelte';
	import { isEditableTarget } from '#lib/ui/shortcuts';
	import SoundControl from '#lib/components/SoundControl.svelte';
	import SoundAnalyzer from '#lib/components/SoundAnalyzer.svelte';
	import EqPanel from '#lib/components/EqPanel.svelte';
	import WaveSelector from '#lib/components/WaveSelector.svelte';
	import FrameThumb from '#lib/components/wavetable/FrameThumb.svelte';
	import ShapeEditor from '#lib/components/wavetable/ShapeEditor.svelte';
	import HarmonicEditor from '#lib/components/wavetable/HarmonicEditor.svelte';

	let selectedId = $state<string | null>(null);
	let tab = $state('Voice');
	let search = $state('');
	let category = $state('');
	let favoritesOnly = $state(false);
	let starterId = $state<SoundStarterId>('sub');
	let auditionTimer: ReturnType<typeof setTimeout> | undefined;
	let auditionRequest = 0;
	let ready = $state(false);
	let message = $state('');
	let importing = $state(false);
	let fileInput: HTMLInputElement | undefined = $state();
	let note = $state(48);
	let playingNote = $state<number | null>(null);
	let selectedFrame = $state(0);
	let tableOsc = $state(0);
	let editorMode = $state('harmonics');
	let draggedEffect = $state<string | null>(null);
	const sound = $derived(
		session.project.soundProfiles.find((profile) => profile.id === selectedId) ??
			session.project.soundProfiles[0]
	);
	const synth = $derived(sound?.synth);
	const envelope = $derived(synth?.envelope ?? createDefaultEnvelope());
	const track = $derived(activeTrack());
	const usedBy = $derived(
		session.project.tracks.filter((entry) => entry.soundProfileId === sound?.id)
	);
	const categories = $derived(
		[...new Set(session.project.soundProfiles.map((profile) => profile.category))].sort()
	);
	const starter = $derived(SOUND_STARTERS.find((entry) => entry.id === starterId)!);
	const filtered = $derived(
		session.project.soundProfiles.filter(
			(profile) =>
				`${profile.name} ${profile.category}`.toLowerCase().includes(search.trim().toLowerCase()) &&
				(!category || profile.category === category) &&
				(!favoritesOnly || profile.favorite)
		)
	);
	const oscillator = $derived(synth?.oscillators?.[tableOsc]);
	const table = $derived(
		session.project.wavetables.find((entry) => entry.id === oscillator?.wavetableId)
	);
	const frame = $derived(table?.frames[selectedFrame] ?? table?.frames[0]);
	const destinations = [
		{ value: 'filter.cutoff', label: 'Filter 1 cutoff' },
		{ value: 'filter.resonance', label: 'Filter 1 resonance' },
		{ value: 'pitch.offset', label: 'Pitch offset' },
		{ value: 'pitch.fine', label: 'Fine tune' },
		{ value: 'volume', label: 'Output volume' },
		{ value: 'pan', label: 'Output pan' },
		{ value: 'filter.drive', label: 'Drive' },
		{ value: 'fx.delay.mix', label: 'Delay mix' },
		{ value: 'fx.reverb.mix', label: 'Reverb mix' },
		{ value: 'wavetable.position', label: 'Wavetable position · all oscillators' }
	];
	const colors = ['var(--color-accent)', 'var(--color-ok)', 'var(--color-ji)'];

	onMount(() => {
		void initSession().then(() => {
			selectedId =
				new URLSearchParams(location.search).get('sound') ?? activeTrack()?.soundProfileId ?? null;
			if (!session.project.soundProfiles.length) selectedId = addSoundProfile();
			ready = true;
		});
		return stopAudition;
	});
	function patch(patch_: Partial<SoundProfile>) {
		if (sound) updateSoundProfile(sound.id, patch_);
	}
	function patchSynth(patch_: Partial<SynthSettings>) {
		if (synth) patch({ synth: { ...synth, ...patch_ } });
	}
	function patchOsc(index: number, patch_: Partial<OscillatorSettings>) {
		if (!synth?.oscillators) return;
		const oscillators = synth.oscillators.map((entry, i) =>
			i === index ? { ...entry, ...patch_ } : entry
		);
		const primary = oscillators[0];
		patchSynth({
			oscillators,
			wave: primary.wave,
			wavetableId: primary.wavetableId,
			wavetablePosition: primary.wavetablePosition,
			unison: primary.unison
		});
	}
	function patchEnv(patch_: Partial<Envelope>) {
		patchSynth({ envelope: { ...envelope, ...patch_ } });
	}
	function patchDelay(patch_: Partial<DelaySettings>) {
		if (synth) patchSynth({ delay: { ...synth.delay, ...patch_ } });
	}
	function patchEffect(id: string, patch_: Partial<SoundEffect>) {
		patchSynth({
			effects: synth?.effects?.map((effect) =>
				effect.id === id ? { ...effect, ...patch_ } : effect
			)
		});
	}
	function moveEffect(id: string, to: number) {
		if (!synth?.effects) return;
		const effects = [...synth.effects];
		const from = effects.findIndex((effect) => effect.id === id);
		if (from < 0 || to < 0 || to >= effects.length) return;
		effects.splice(to, 0, effects.splice(from, 1)[0]);
		patchSynth({ effects });
	}
	function patchMod(id: string, patch_: Partial<ModEnvelope>) {
		patch({
			modEnvelopes: sound.modEnvelopes.map((env) => (env.id === id ? { ...env, ...patch_ } : env))
		});
	}
	function patchLfo(id: string, patch_: Partial<Lfo>) {
		patch({ lfos: sound.lfos.map((lfo) => (lfo.id === id ? { ...lfo, ...patch_ } : lfo)) });
	}
	function newLfo() {
		patch({
			lfos: [
				...sound.lfos,
				{
					id: uid('lfo'),
					name: `LFO ${sound.lfos.length + 1}`,
					enabled: true,
					wave: 'sine',
					rate: 1,
					sync: '1/4',
					phaseDegrees: 0,
					amount: 0.2,
					destination: 'filter.cutoff'
				}
			]
		});
	}
	function resetFilters() {
		search = '';
		category = '';
		favoritesOnly = false;
	}
	function newSound() {
		stopAudition();
		resetFilters();
		selectedId = addSoundProfile(`Sound ${session.project.soundProfiles.length + 1}`);
	}
	function addStarter() {
		stopAudition();
		resetFilters();
		const profile = createStarterSound(starterId);
		selectedId = addSoundProfile(profile.name, profile);
		message = `Added ${profile.name}. Existing tracks are unchanged; use Load into a track when ready.`;
	}
	function duplicate() {
		if (sound) {
			stopAudition();
			resetFilters();
			selectedId = addSoundProfile(`${sound.name} copy`, sound);
		}
	}
	function initialize() {
		if (
			sound &&
			confirm(
				'Initialize this shared sound? All linked tracks will use the initialized patch. Undo can restore it.'
			)
		) {
			stopAudition();
			const fresh = createSoundProfile(sound.name, createDefaultSynth());
			patch({ synth: fresh.synth, lfos: [], modEnvelopes: [], importWarnings: [] });
		}
	}
	async function audition(midi: number) {
		if (!sound) return;
		stopAudition();
		const request = auditionRequest;
		note = midi;
		playingNote = midi;
		try {
			await engine.previewSound(sound, midiToHz(midi), 1.5);
			if (request !== auditionRequest) return;
			// The highlight represents the held note, not its release/effect tail.
			auditionTimer = setTimeout(() => {
				playingNote = null;
			}, 1500);
		} catch (error) {
			if (request !== auditionRequest) return;
			playingNote = null;
			message = error instanceof Error ? error.message : 'Could not start audio';
		}
	}
	function stopAudition() {
		auditionRequest++;
		clearTimeout(auditionTimer);
		engine.stopPreviewSound();
		playingNote = null;
	}
	function keys(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			if (event.shiftKey) redo();
			else undo();
		} else if (event.key === 'Escape') stopAudition();
		else if (event.key === ' ' && !event.repeat) {
			event.preventDefault();
			void audition(note);
		}
	}
	async function importFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		importing = true;
		message = 'Reading preset…';
		try {
			if (file.size > 16 * 1024 * 1024) throw new Error('Preset exceeds 16 MB');
			const result = importVitalPreset(await file.text());
			mutate('Import Vital sound', (project) => ({
				...project,
				soundProfiles: [...project.soundProfiles, result.profile],
				wavetables: [...project.wavetables, ...result.wavetables]
			}));
			stopAudition();
			resetFilters();
			selectedId = result.profile.id;
			message = `Imported ${result.profile.name}. Review conversion notes below.`;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Import failed';
		} finally {
			importing = false;
			input.value = '';
		}
	}
	function editTable(index: number) {
		tableOsc = index;
		selectedFrame = 0;
		tab = 'Wavetable';
	}
	function createTable() {
		const table_ = createWavetable(`Sound table ${session.project.wavetables.length + 1}`, [
			createHarmonicFrame(0)
		]);
		addWavetable(table_);
		patchOsc(tableOsc, { wave: 'wavetable', wavetableId: table_.id });
		selectedFrame = 0;
	}
	function editSource(source: WavetableFrameSource) {
		if (table && frame)
			updateWavetableFrame(
				table.id,
				frame.id,
				(entry) => ({ ...entry, source }),
				'Edit sound wavetable'
			);
	}
	function envelopePath() {
		const total = Math.max(0.01, envelope.attack + envelope.decay + 0.5 + envelope.release);
		const x1 = (envelope.attack / total) * 280,
			x2 = ((envelope.attack + envelope.decay) / total) * 280,
			x3 = ((envelope.attack + envelope.decay + 0.5) / total) * 280;
		return `M 0 84 L ${x1} 8 L ${x2} ${84 - envelope.sustain * 76} L ${x3} ${84 - envelope.sustain * 76} L 280 84`;
	}
	function modPath(env: ModEnvelope) {
		const total = Math.max(0.01, env.attackBeats + env.decayBeats);
		return Array.from(
			{ length: 33 },
			(_, i) => `${(i * 280) / 32},${84 - envelopeValueAt(env, (i / 32) * total) * 76}`
		).join(' ');
	}
	function lfoPath(lfo: Lfo) {
		return Array.from({ length: 65 }, (_, i) => {
			const p = i / 64;
			const y =
				lfo.wave === 'triangle'
					? 1 - 4 * Math.abs(p - 0.5)
					: lfo.wave === 'square'
						? p < 0.5
							? 1
							: -1
						: lfo.wave === 'saw-up'
							? p * 2 - 1
							: lfo.wave === 'saw-down'
								? 1 - p * 2
								: Math.sin(p * Math.PI * 2);
			return `${p * 280},${46 - y * 36}`;
		}).join(' ');
	}
</script>

<svelte:head
	><title>Sound designer · Doodlesynth</title><meta
		name="description"
		content="Design shared three-oscillator sounds, modulation and stereo effects."
	/></svelte:head
>
<svelte:window onkeydown={keys} />
<div class="sound-designer">
	<header class="app-header">
		<a class="brand" href="/">Doodlesynth <span>/ sound designer</span></a>
		<nav aria-label="Sections">
			<a href="/">Editor</a><a href="/projects">Projects</a><a href="/tuning">Tuning</a><a
				href="/help">Help</a
			>
		</nav>
		<div class="history">
			<button disabled={!canUndo()} onclick={undo}>Undo</button><button
				disabled={!canRedo()}
				onclick={redo}>Redo</button
			><button onclick={() => void saveNow()}
				>{session.saveState === 'saved' ? 'Saved' : 'Save project'}</button
			>
		</div>
	</header>
	{#if !ready}<p class="loading" role="status">
			Loading your sound library…
		</p>{:else if sound && synth}
		<div class="preset-header">
			<div class="preset-title">
				<span class="eyebrow">{sound.category} / shared sound</span><input
					class="sound-name"
					aria-label="Sound name"
					value={sound.name}
					onchange={(event) =>
						patch({ name: event.currentTarget.value.slice(0, 120) || 'Untitled sound' })}
				/>
			</div>
			<button
				aria-label="Favorite sound"
				aria-pressed={sound.favorite ?? false}
				onclick={() => patch({ favorite: !sound.favorite })}
				>{sound.favorite ? '★ Favorite' : '☆ Favorite'}</button
			>
			<button onclick={duplicate}>Save as copy</button><button onclick={initialize}
				>Initialize</button
			><button disabled={importing} onclick={() => fileInput?.click()}
				>{importing ? 'Importing…' : 'Import .vital'}</button
			><input
				class="file-input"
				{@attach (element) => {
					fileInput = element;
					return () => {
						fileInput = undefined;
					};
				}}
				type="file"
				accept=".vital,application/json"
				aria-label="Import Vital preset"
				onchange={importFile}
			/><SoundAnalyzer />
			<div class="output-control">
				<SoundControl
					label="Output"
					value={synth.outputDb ?? -6}
					min={-36}
					max={6}
					step={0.5}
					unit=" dB"
					onchange={(value) => patchSynth({ outputDb: value })}
				/>
			</div>
		</div>
		<div class="designer-body">
			<aside class="sound-library" aria-label="Sound library">
				<div class="section-heading">
					<h2>Sounds</h2>
					<button onclick={newSound}>+ New</button>
				</div>
				<input
					class="search"
					aria-label="Search sounds"
					placeholder="Search sounds…"
					bind:value={search}
				/>
				<div class="library-filters">
					<select aria-label="Filter sound category" bind:value={category}>
						<option value="">All categories</option>
						{#each categories as entry (entry)}<option value={entry}>{entry}</option>{/each}
					</select>
					<button
						aria-label="Show favorite sounds"
						aria-pressed={favoritesOnly}
						onclick={() => (favoritesOnly = !favoritesOnly)}>★ Favorites</button
					>
				</div>
				<details class="starter-picker">
					<summary>Start from a sound</summary>
					<label class="select-label"
						>Starter sound
						<select aria-label="Starter sound" bind:value={starterId}>
							{#each SOUND_STARTERS as entry (entry.id)}<option value={entry.id}
									>{entry.category} · {entry.name}</option
								>{/each}
						</select>
					</label>
					<p class="muted">{starter.description}</p>
					<button onclick={addStarter}>Add starter sound</button>
					<p class="muted">Creates a new editable sound. Your tracks stay unchanged.</p>
				</details>
				<div class="sound-list">
					{#each filtered as profile (profile.id)}<button
							class:selected={sound.id === profile.id}
							class="sound-card"
							onclick={() => {
								selectedId = profile.id;
								stopAudition();
							}}
							><span class="sound-icon" aria-hidden="true">{profile.favorite ? '★' : '∿'}</span
							><span
								><strong>{profile.name}</strong><small
									>{profile.category} · {session.project.tracks.filter(
										(entry) => entry.soundProfileId === profile.id
									).length} tracks</small
								></span
							></button
						>{:else}
						<p class="muted" role="status">No sounds match these filters.</p>
						<button onclick={resetFilters}>Clear filters</button>
					{/each}
				</div>
				<div class="library-footer">
					<label class="select-label"
						>Sound category
						<input
							aria-label="Sound category"
							value={sound.category}
							maxlength="40"
							onchange={(event) => patch({ category: event.currentTarget.value.trim() || 'User' })}
						/>
					</label>
					<p>
						{usedBy.length
							? `Used by ${usedBy.map((entry) => entry.name).join(', ')}`
							: 'Not assigned to a track yet.'}
					</p>
					<button
						class="primary"
						disabled={!track}
						onclick={() => {
							if (track) {
								selectTrackSound(track.id, sound.id);
								message = `Loaded into ${track.name}`;
							}
						}}>{track ? `Load into ${track.name}` : 'Select a track in the editor'}</button
					><button
						disabled={usedBy.length > 0}
						onclick={() => {
							if (confirm(`Delete ${sound.name}?`) && deleteSoundProfile(sound.id))
								selectedId = null;
						}}>Delete sound</button
					><a href="/wavetables">Wavetable asset library →</a>
				</div>
			</aside>
			<main class="sound-main">
				<div class="tabs" role="group" aria-label="Sound design pages">
					{#each ['Voice', 'Effects', 'Matrix', 'Advanced', 'Wavetable'] as page (page)}<button
							class:active={tab === page}
							aria-pressed={tab === page}
							onclick={() => (tab = page)}>{page}</button
						>{/each}<span class="tab-meta"
						>{synth.oscillators?.filter((osc) => osc.enabled).length ?? 1} oscillators · {synth.effects?.filter(
							(effect) => effect.enabled
						).length ?? 0} effects</span
					>
				</div>
				<div class="main-content">
					{#if tab === 'Voice'}
						<div class="oscillators">
							{#each synth.oscillators ?? [] as osc, index (index)}
								{@const wt = session.project.wavetables.find(
									(entry) => entry.id === osc.wavetableId
								)}
								<section
									class="module oscillator"
									class:inactive={!osc.enabled}
									style={`--module-accent:${colors[index]}`}
								>
									<div class="module-head">
										<h2><span class="module-number">0{index + 1}</span> Oscillator {index + 1}</h2>
										<button
											class:powered={osc.enabled}
											aria-pressed={osc.enabled}
											aria-label={`Oscillator ${index + 1} power`}
											onclick={() => patchOsc(index, { enabled: !osc.enabled })}
											>{osc.enabled ? 'On' : 'Off'}</button
										>
									</div>
									<div class="source-row">
										<WaveSelector
											value={osc.wave}
											wavetableId={osc.wavetableId}
											position={osc.wavetablePosition}
											accent={colors[index]}
											onChange={(wave, wavetableId) => patchOsc(index, { wave, wavetableId })}
										/><button
											onclick={() => editTable(index)}
											title="Edit this oscillator’s wavetable">Edit table</button
										>
									</div>
									<fieldset disabled={!osc.enabled}>
										<div class="wave-visual">
											{#if osc.wave === 'wavetable' && wt}<FrameThumb
													samples={renderWavetableAt(wt, osc.wavetablePosition)}
													width={400}
													height={66}
													accent={colors[index]}
												/>{:else}<svg viewBox="0 0 400 66" aria-label={`${osc.wave} oscillator`}
													><path
														d={osc.wave === 'sine'
															? 'M0 33 Q50 -25 100 33 T200 33 T300 33 T400 33'
															: osc.wave === 'square'
																? 'M0 56 V10 H100 V56 H200 V10 H300 V56 H400'
																: osc.wave === 'triangle'
																	? 'M0 33 L50 8 L150 58 L250 8 L350 58 L400 33'
																	: 'M0 33 L100 8 V58 L200 8 V58 L300 8 V58 L400 8'}
													/></svg
												>{/if}
										</div>
										<div class="controls-grid">
											<SoundControl
												label="Position"
												value={osc.wavetablePosition}
												onchange={(value) => patchOsc(index, { wavetablePosition: value })}
											/><SoundControl
												label="Level"
												value={osc.level}
												onchange={(value) => patchOsc(index, { level: value })}
											/><SoundControl
												label="Pan"
												value={osc.pan}
												min={-1}
												max={1}
												onchange={(value) => patchOsc(index, { pan: value })}
											/><SoundControl
												label="Transpose"
												value={osc.transpose}
												min={-48}
												max={48}
												step={1}
												unit=" st"
												onchange={(value) => patchOsc(index, { transpose: value })}
											/><SoundControl
												label="Fine"
												value={osc.fineCents}
												min={-100}
												max={100}
												step={1}
												unit=" ¢"
												onchange={(value) => patchOsc(index, { fineCents: value })}
											/><SoundControl
												label="Unison"
												value={osc.unison.voices}
												min={1}
												max={16}
												step={1}
												unit=" voices"
												onchange={(value) =>
													patchOsc(index, { unison: { ...osc.unison, voices: value } })}
											/><SoundControl
												label="Detune"
												value={osc.unison.detuneCents}
												min={0}
												max={100}
												step={1}
												unit=" ¢"
												onchange={(value) =>
													patchOsc(index, { unison: { ...osc.unison, detuneCents: value } })}
											/><label class="select-label"
												>Routing<select
													value={osc.routing}
													onchange={(event) =>
														patchOsc(index, {
															routing: event.currentTarget.value as OscillatorSettings['routing']
														})}
													><option value="filter1">Filter 1</option><option value="filter2"
														>Filter 2</option
													><option value="direct">Direct → effects</option></select
												></label
											>
										</div>
									</fieldset>
								</section>{/each}
						</div>
						<section class="module noise">
							<div class="module-head">
								<h2>Noise source</h2>
								<button
									class:powered={synth.noise?.enabled}
									aria-pressed={synth.noise?.enabled ?? false}
									onclick={() =>
										patchSynth({
											noise: {
												enabled: !synth.noise?.enabled,
												level: synth.noise?.level ?? 0.15,
												pan: synth.noise?.pan ?? 0
											}
										})}>{synth.noise?.enabled ? 'On' : 'Off'}</button
								>
							</div>
							<div class="controls-grid">
								<SoundControl
									label="White noise level"
									value={synth.noise?.level ?? 0.15}
									onchange={(value) =>
										patchSynth({
											noise: {
												enabled: synth.noise?.enabled ?? false,
												level: value,
												pan: synth.noise?.pan ?? 0
											}
										})}
								/><SoundControl
									label="Pan"
									value={synth.noise?.pan ?? 0}
									min={-1}
									max={1}
									onchange={(value) =>
										patchSynth({
											noise: {
												enabled: synth.noise?.enabled ?? false,
												level: synth.noise?.level ?? 0.15,
												pan: value
											}
										})}
								/>
								<p class="muted">Generated noise → effects. Sample playback is not implemented.</p>
							</div>
						</section>
						<div class="filters">
							{#each [synth.filter, synth.filter2 ?? synth.filter] as filter, index (index)}<section
									class="module"
								>
									<div class="module-head">
										<h2>Filter {index + 1}</h2>
										<span class="muted">Independent source routing</span>
									</div>
									<EqPanel
										{filter}
										ariaLabel={`Sound filter ${index + 1}`}
										onchange={(patch_) =>
											patchSynth(
												index === 0
													? { filter: { ...filter, ...patch_ } }
													: { filter2: { ...filter, ...patch_ } }
											)}
									/>
									<div class="controls-grid">
										<SoundControl
											label="Cutoff"
											value={filter.cutoff}
											min={20}
											max={20000}
											step={1}
											unit=" Hz"
											onchange={(value) =>
												patchSynth(
													index === 0
														? { filter: { ...filter, cutoff: value } }
														: { filter2: { ...filter, cutoff: value } }
												)}
										/><SoundControl
											label="Resonance"
											value={filter.resonance}
											min={0}
											max={30}
											step={0.1}
											onchange={(value) =>
												patchSynth(
													index === 0
														? { filter: { ...filter, resonance: value } }
														: { filter2: { ...filter, resonance: value } }
												)}
										/><SoundControl
											label="Band gain"
											value={filter.gainDb ?? 0}
											min={-24}
											max={24}
											step={0.5}
											unit=" dB"
											onchange={(value) =>
												patchSynth(
													index === 0
														? { filter: { ...filter, gainDb: value } }
														: { filter2: { ...filter, gainDb: value } }
												)}
										/>
									</div>
								</section>{/each}
						</div>
					{:else if tab === 'Effects'}
						<div class="page-intro">
							<h1>Effects rack</h1>
							<p>
								Signal flows top to bottom. Drag the numbered handle or use the arrows to change
								processing order.
							</p>
						</div>
						{#each synth.effects ?? [] as effect, index (effect.id)}<section
								class="module effect"
								class:inactive={!effect.enabled}
							>
								<div class="module-head">
									<button
										class="drag-handle"
										draggable="true"
										aria-label={`Drag ${effect.kind} effect`}
										ondragstart={(event) => {
											draggedEffect = effect.id;
											event.dataTransfer?.setData('text/plain', effect.id);
										}}
										ondragend={() => (draggedEffect = null)}
										>{String(index + 1).padStart(2, '0')} ⠿</button
									>
									<h2>{effect.kind === 'eq' ? 'Equalizer' : effect.kind}</h2>
									<button
										disabled={index === 0}
										aria-label={`Move ${effect.kind} up`}
										onclick={() => moveEffect(effect.id, index - 1)}>↑</button
									><button
										disabled={index === (synth.effects?.length ?? 0) - 1}
										aria-label={`Move ${effect.kind} down`}
										onclick={() => moveEffect(effect.id, index + 1)}>↓</button
									><button
										class:powered={effect.enabled}
										aria-pressed={effect.enabled}
										aria-label={`${effect.kind} power`}
										onclick={() => patchEffect(effect.id, { enabled: !effect.enabled })}
										>{effect.enabled ? 'On' : 'Off'}</button
									>
								</div>
								<button
									class="drop-slot"
									aria-label={`Move dragged effect before ${effect.kind}`}
									ondragover={(event) => event.preventDefault()}
									ondrop={(event) => {
										event.preventDefault();
										const id = draggedEffect ?? event.dataTransfer?.getData('text/plain');
										if (id) moveEffect(id, index);
										draggedEffect = null;
									}}>Drop effect here to reorder</button
								>
								<fieldset disabled={!effect.enabled}>
									<div class="controls-grid">
										<SoundControl
											label="Mix"
											value={effect.mix}
											onchange={(value) => patchEffect(effect.id, { mix: value })}
										/>{#each EFFECT_CONTROLS[effect.kind] as control (control.key)}<SoundControl
												label={control.label}
												value={effect.params[control.key] ?? control.value}
												min={control.min}
												max={control.max}
												step={control.step}
												onchange={(value) =>
													patchEffect(effect.id, {
														params: { ...effect.params, [control.key]: value }
													})}
											/>{/each}
									</div>
									{#if effect.kind === 'delay'}<div
											class="delay-visual"
											aria-label="Delay echo timing and decay"
										>
											<span>INPUT</span>{#each [1, 2, 3, 4, 5, 6] as echo (echo)}<i
													style={`height:${Math.max(4, Math.pow(synth.delay.feedback, echo - 1) * 42)}px`}
													class:right={synth.delay.mode === 'ping-pong' && echo % 2 === 0}
												></i>{/each}<small
												>{synth.delay.mode === 'ping-pong'
													? 'L → R → L → R'
													: (synth.delay.mode ?? 'stereo')}</small
											>
										</div>
										<div class="controls-grid">
											<label class="select-label"
												>Mode<select
													value={synth.delay.mode ?? 'stereo'}
													onchange={(event) =>
														patchDelay({
															mode: event.currentTarget.value as DelaySettings['mode']
														})}
													><option value="mono">Mono</option><option value="stereo">Stereo</option
													><option value="ping-pong">Ping-pong (PiPo)</option></select
												></label
											><label class="select-label"
												>Timing<select
													value={synth.delay.sync ? 'sync' : 'free'}
													onchange={(event) =>
														patchDelay({ sync: event.currentTarget.value === 'sync' })}
													><option value="free">Free · seconds</option><option value="sync"
														>Tempo sync · beats</option
													></select
												></label
											>{#if synth.delay.sync}<SoundControl
													label="Left / ping-pong"
													value={synth.delay.beats ?? 0.5}
													min={0.125}
													max={4}
													step={0.125}
													unit=" beats"
													onchange={(value) => patchDelay({ beats: value })}
												/><SoundControl
													label="Right · stereo"
													value={synth.delay.rightBeats ?? 0.5}
													min={0.125}
													max={4}
													step={0.125}
													unit=" beats"
													onchange={(value) => patchDelay({ rightBeats: value })}
												/>{:else}<SoundControl
													label="Left / ping-pong"
													value={synth.delay.time}
													min={0.01}
													max={4}
													step={0.01}
													unit=" s"
													onchange={(value) => patchDelay({ time: value })}
												/><SoundControl
													label="Right · stereo"
													value={synth.delay.rightTime ?? synth.delay.time}
													min={0.01}
													max={4}
													step={0.01}
													unit=" s"
													onchange={(value) => patchDelay({ rightTime: value })}
												/>{/if}<SoundControl
												label="Feedback"
												value={synth.delay.feedback}
												max={0.95}
												onchange={(value) => patchDelay({ feedback: value })}
											/><SoundControl
												label="Low cut"
												value={synth.delay.lowCut ?? 20}
												min={20}
												max={8000}
												step={10}
												unit=" Hz"
												onchange={(value) => patchDelay({ lowCut: value })}
											/><SoundControl
												label="High cut"
												value={synth.delay.highCut ?? 12000}
												min={100}
												max={20000}
												step={100}
												unit=" Hz"
												onchange={(value) => patchDelay({ highCut: value })}
											/><SoundControl
												label="Stereo width"
												value={synth.delay.width ?? 1}
												onchange={(value) => patchDelay({ width: value })}
											/>
										</div>
										<p class="muted">
											Sync supports straight, dotted and triplet timings through fractional beats.
											Feedback is capped at 95%. Filters shape successive repeats.
										</p>{:else if effect.kind === 'compressor'}<p class="muted">
											Single-band downward compressor. Not multiband / OTT.
										</p>{:else if effect.kind === 'distortion'}<p class="muted">
											Tanh saturation · 2× waveshaper oversampling.
										</p>{/if}
								</fieldset>
							</section>{/each}
					{:else if tab === 'Matrix'}
						<div class="page-intro">
							<h1>Modulation matrix</h1>
							<p>
								Audit and edit the connections that make this sound move. All connections below are
								used by playback.
							</p>
						</div>
						<div class="section-heading">
							<h2>Envelope assignments</h2>
							<button
								onclick={() =>
									patch({
										modEnvelopes: [...sound.modEnvelopes, createModEnvelope('filter.cutoff')]
									})}>+ Envelope</button
							>
						</div>
						{#each sound.modEnvelopes as env (env.id)}<section class="module matrix-row">
								<label class="check"
									><input
										type="checkbox"
										checked={env.enabled}
										onchange={(event) => patchMod(env.id, { enabled: event.currentTarget.checked })}
									/>Envelope</label
								><label class="select-label"
									>Trigger<select
										value={env.trigger}
										onchange={(event) =>
											patchMod(env.id, {
												trigger: event.currentTarget.value as ModEnvelope['trigger']
											})}
										><option value="start">Curve start</option><option value="change"
											>Pitch stabilization</option
										></select
									></label
								><label class="select-label"
									>Destination<select
										value={env.destination}
										onchange={(event) =>
											patchMod(env.id, { destination: event.currentTarget.value })}
										>{#each destinations as d (d.value)}<option value={d.value}>{d.label}</option
											>{/each}</select
									></label
								><SoundControl
									label="Depth"
									value={env.amount}
									min={-1}
									max={1}
									onchange={(value) => patchMod(env.id, { amount: value })}
								/><button
									aria-label="Remove envelope assignment"
									onclick={() =>
										patch({
											modEnvelopes: sound.modEnvelopes.filter((entry) => entry.id !== env.id)
										})}>Remove</button
								>
							</section>{/each}
						<div class="section-heading">
							<h2>LFO assignments</h2>
							<button onclick={newLfo}>+ LFO</button>
						</div>
						{#each sound.lfos as lfo (lfo.id)}<section class="module matrix-row">
								<label class="check"
									><input
										type="checkbox"
										checked={lfo.enabled}
										onchange={(event) => patchLfo(lfo.id, { enabled: event.currentTarget.checked })}
									/>{lfo.name}</label
								><label class="select-label"
									>Destination<select
										value={lfo.destination}
										onchange={(event) =>
											patchLfo(lfo.id, { destination: event.currentTarget.value })}
										>{#each destinations as d (d.value)}<option value={d.value}>{d.label}</option
											>{/each}</select
									></label
								><SoundControl
									label="Depth"
									value={lfo.amount}
									onchange={(value) => patchLfo(lfo.id, { amount: value })}
								/><button
									aria-label={`Remove ${lfo.name}`}
									onclick={() => patch({ lfos: sound.lfos.filter((entry) => entry.id !== lfo.id) })}
									>Remove</button
								>
							</section>{/each}{#if !sound.modEnvelopes.length && !sound.lfos.length}<p
								class="muted"
							>
								No modulation connections yet. Add an envelope or LFO to begin.
							</p>{/if}
					{:else if tab === 'Advanced'}
						<div class="page-intro">
							<h1>Voicing & phase</h1>
							<p>
								Unison is per oscillator, not musical polyphony. Copies are normalized by 1 / voice
								count to bound their summed peak.
							</p>
						</div>
						{#each synth.oscillators ?? [] as osc, index (index)}<section
								class="module"
								style={`--module-accent:${colors[index]}`}
							>
								<div class="module-head">
									<h2>Oscillator {index + 1}</h2>
									<span class="muted">{osc.enabled ? 'Active' : 'Disabled'}</span>
								</div>
								<div class="controls-grid">
									<SoundControl
										label="Start phase"
										value={osc.phase}
										onchange={(value) => patchOsc(index, { phase: value })}
									/><SoundControl
										label="Phase randomization"
										value={osc.phaseRandomization}
										onchange={(value) => patchOsc(index, { phaseRandomization: value })}
									/><SoundControl
										label="Unison phase spread"
										value={osc.unison.phaseSpread}
										onchange={(value) =>
											patchOsc(index, { unison: { ...osc.unison, phaseSpread: value } })}
									/><SoundControl
										label="Unison stereo spread"
										value={osc.unison.stereoSpread ?? 0}
										onchange={(value) =>
											patchOsc(index, { unison: { ...osc.unison, stereoSpread: value } })}
									/>
								</div>
							</section>{/each}
						<section class="module">
							<h2>Engine limits</h2>
							<p>
								16 unison voices per oscillator · 64 admitted curves · 256 source nodes maximum.
								Notes that cannot fit their complete stack are omitted.
							</p>
							<p class="muted">
								Wavetable playback uses 128 Fourier partials and 65 morph positions. Phase
								randomization is deterministic per curve; explicit phase spread can intentionally
								cause cancellation at zero detune.
							</p>
							<p class="muted">
								Spectral warping, inter-oscillator FM, sample playback, macros, MPE and
								Vital-quality oversampling are not implemented.
							</p>
						</section>
					{:else if tab === 'Wavetable'}
						<div class="page-intro">
							<h1>Wavetable source editor</h1>
							<p>
								Wavetables are oscillator assets, not complete sounds. Asset edits affect every
								oscillator that uses the table.
							</p>
						</div>
						<div class="table-toolbar">
							<label class="select-label"
								>Oscillator<select
									value={tableOsc}
									onchange={(event) => {
										tableOsc = Number(event.currentTarget.value);
										selectedFrame = 0;
									}}
									><option value="0">Oscillator 1</option><option value="1">Oscillator 2</option
									><option value="2">Oscillator 3</option></select
								></label
							><label class="select-label"
								>Wavetable<select
									value={table?.id ?? ''}
									onchange={(event) => {
										patchOsc(tableOsc, {
											wave: 'wavetable',
											wavetableId: event.currentTarget.value
										});
										selectedFrame = 0;
									}}
									><option value="" disabled>Choose a table</option
									>{#each session.project.wavetables as wt (wt.id)}<option value={wt.id}
											>{wt.name}</option
										>{/each}</select
								></label
							><button onclick={createTable}>+ New table</button><a href="/wavetables"
								>Full asset tools →</a
							>
						</div>
						{#if table && frame}<div class="frame-strip">
								{#each table.frames as entry, index (entry.id)}<button
										class:active={entry.id === frame.id}
										onclick={() => (selectedFrame = index)}
										aria-label={`Edit frame ${index + 1}`}
										><FrameThumb samples={entry.samples} width={64} height={28} /><span
											>Frame {index + 1}</span
										></button
									>{/each}
							</div>
							<div class="table-toolbar">
								<button
									class:active={editorMode === 'harmonics'}
									onclick={() => (editorMode = 'harmonics')}>Harmonics</button
								><button
									class:active={editorMode === 'shape'}
									onclick={() => (editorMode = 'shape')}>Draw waveform</button
								>
							</div>
							<div class="table-editor">
								{#key frame.id + editorMode}{#if editorMode === 'harmonics' && frame.source.kind === 'harmonics'}<HarmonicEditor
											components={frame.source.components}
											count={Math.max(8, frame.source.components.length)}
											sampleLength={table.sampleLength}
											accent="var(--color-accent)"
											onchange={(components) => editSource({ kind: 'harmonics', components })}
											oncountchange={(count) => {
												const source = frame.source;
												if (source.kind === 'harmonics')
													editSource({
														kind: 'harmonics',
														components: createHarmonicComponents(count).map(
															(component) =>
																source.components.find(
																	(entry) => entry.harmonic === component.harmonic
																) ?? component
														)
													});
											}}
										/>{:else if editorMode === 'shape' && frame.source.kind === 'shape'}<ShapeEditor
											points={frame.source.points}
											sampleLength={table.sampleLength}
											accent="var(--color-accent)"
											onchange={(points) => editSource({ kind: 'shape', points })}
										/>{:else}<p class="muted">
											This frame uses {frame.source.kind}. Use its matching editor or the full asset
											tools for explicit conversion.
										</p>{/if}{/key}
							</div>{:else}<p class="muted">
								Choose or create a wavetable for this oscillator.
							</p>{/if}
					{/if}
					{#if sound.importWarnings?.length}<details class="import-notes">
							<summary>Vital conversion notes · {sound.importWarnings.length}</summary>
							<ul>
								{#each sound.importWarnings as warning, index (index)}<li>{warning}</li>{/each}
							</ul>
						</details>{/if}
				</div>
			</main>
			<aside class="modulators" aria-label="Sound modulation">
				<section class="module amplitude">
					<div class="module-head">
						<h2>ENV 1 <span>Amplitude</span></h2>
						<button
							onclick={() =>
								patchSynth({ envelope: synth.envelope ? undefined : createDefaultEnvelope() })}
							>{synth.envelope ? 'Patch ADSR' : 'Curve ADSR'}</button
						>
					</div>
					<svg class="mod-graph" viewBox="0 0 280 92" aria-label="Amplitude envelope"
						><path d={envelopePath()} /></svg
					>
					<div class="controls-grid">
						<SoundControl
							label="Attack"
							value={envelope.attack}
							max={4}
							step={0.01}
							unit=" s"
							onchange={(value) => patchEnv({ attack: value })}
						/><SoundControl
							label="Decay"
							value={envelope.decay}
							max={4}
							step={0.01}
							unit=" s"
							onchange={(value) => patchEnv({ decay: value })}
						/><SoundControl
							label="Sustain"
							value={envelope.sustain}
							onchange={(value) => patchEnv({ sustain: value })}
						/><SoundControl
							label="Release"
							value={envelope.release}
							max={4}
							step={0.01}
							unit=" s"
							onchange={(value) => patchEnv({ release: value })}
						/>
					</div>
					<p class="muted">
						{synth.envelope
							? 'Patch envelope applies to all voices.'
							: 'Existing curves retain their individual ADSR. Adjust a control to enable patch ADSR.'}
					</p>
				</section>
				<div class="section-heading">
					<h2>Modulation envelopes</h2>
					<button
						onclick={() =>
							patch({ modEnvelopes: [...sound.modEnvelopes, createModEnvelope('filter.cutoff')] })}
						>+</button
					>
				</div>
				{#each sound.modEnvelopes as env, index (env.id)}<section class="module mod-envelope">
						<div class="module-head">
							<h2>ENV {index + 2}</h2>
							<span class="muted">{env.destination}</span>
						</div>
						<svg
							class="mod-graph"
							viewBox="0 0 280 92"
							aria-label="Attack decay modulation envelope"><polyline points={modPath(env)} /></svg
						>
						<div class="controls-grid">
							<SoundControl
								label="Attack"
								value={env.attackBeats}
								max={8}
								step={0.125}
								unit=" beats"
								onchange={(value) => patchMod(env.id, { attackBeats: value })}
							/><SoundControl
								label="Decay"
								value={env.decayBeats}
								max={16}
								step={0.125}
								unit=" beats"
								onchange={(value) => patchMod(env.id, { decayBeats: value })}
							/>
						</div>
						<button onclick={() => (tab = 'Matrix')}>Edit connection →</button>
					</section>{/each}
				<div class="section-heading">
					<h2>LFOs</h2>
					<button onclick={newLfo}>+</button>
				</div>
				{#each sound.lfos as lfo (lfo.id)}<section class="module lfo">
						<div class="module-head">
							<h2>{lfo.name}</h2>
							<span class="muted">{lfo.destination}</span>
						</div>
						<svg class="mod-graph" viewBox="0 0 280 92" aria-label={`${lfo.wave} LFO shape`}
							><polyline points={lfoPath(lfo)} /></svg
						>
						<div class="controls-grid">
							<label class="select-label"
								>Wave<select
									value={lfo.wave}
									onchange={(event) =>
										patchLfo(lfo.id, { wave: event.currentTarget.value as Lfo['wave'] })}
									>{#each ['sine', 'triangle', 'square', 'saw-up', 'saw-down'] as wave (wave)}<option
											>{wave}</option
										>{/each}</select
								></label
							><label class="select-label"
								>Sync<select
									value={lfo.sync}
									onchange={(event) =>
										patchLfo(lfo.id, { sync: event.currentTarget.value as Lfo['sync'] })}
									>{#each ['free', '1/1', '1/2', '1/4', '1/8', '1/16'] as sync (sync)}<option
											>{sync}</option
										>{/each}</select
								></label
							><SoundControl
								label="Rate"
								value={lfo.rate}
								min={0.05}
								max={20}
								step={0.05}
								unit=" Hz"
								onchange={(value) => patchLfo(lfo.id, { rate: value })}
							/><SoundControl
								label="Amount"
								value={lfo.amount}
								onchange={(value) => patchLfo(lfo.id, { amount: value })}
							/>
						</div>
					</section>{/each}
			</aside>
		</div>
		<footer class="performance">
			<div class="audition-info">
				<strong>Audition</strong><span>{midiToName(note)} · {session.project.tempo} BPM</span
				><button onclick={stopAudition}>Stop</button>
			</div>
			<div class="keyboard" role="group" aria-label="Audition keyboard">
				{#each Array.from({ length: 25 }, (_, i) => i + 48) as midi (midi)}<button
						class:black={[1, 3, 6, 8, 10].includes(midi % 12)}
						class:held={playingNote === midi}
						aria-label={`Audition ${midiToName(midi)}`}
						onclick={() => void audition(midi)}
						><span>{midi % 12 === 0 ? midiToName(midi) : ''}</span></button
					>{/each}
			</div>
			<p>Space: audition · Esc: stop<br />Same patch engine as editor playback</p>
		</footer>
	{/if}
	<div class="status" role="status">
		{message ||
			session.statusMessage ||
			'Design a sound. Load it into a track. Draw what it plays.'}
	</div>
</div>

<style>
	.sound-designer {
		height: 100dvh;
		display: flex;
		flex-direction: column;
		--sound-muted: #a4adbe;
	}
	button,
	input,
	select {
		font: inherit;
	}
	button {
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		background: var(--color-bg-2);
		color: var(--color-fg-1);
		padding: 7px 10px;
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out),
			transform 130ms var(--ease-out);
	}
	button:hover:not(:disabled) {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}
	button:active:not(:disabled) {
		transform: scale(0.97);
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	input:not([type='checkbox']),
	select {
		min-width: 0;
		padding: 7px 9px;
		background: var(--color-ed-1);
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		color: var(--color-fg-0);
	}
	input[type='checkbox'] {
		accent-color: var(--color-accent);
	}
	a {
		color: var(--color-accent);
		text-decoration: none;
	}
	a:hover {
		text-decoration: underline;
	}
	h1,
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: 12px;
		font-weight: 650;
	}
	h1 {
		font-size: 21px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.app-header {
		display: flex;
		align-items: center;
		gap: 28px;
		min-height: 48px;
		padding: 8px 18px;
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
	}
	.brand {
		font-weight: 650;
		color: var(--color-fg-0);
	}
	.brand span {
		color: var(--sound-muted);
		font-weight: 400;
	}
	nav,
	.history {
		display: flex;
		gap: 14px;
		align-items: center;
	}
	nav a {
		color: var(--color-fg-1);
		font-size: 12px;
	}
	.history {
		margin-left: auto;
		gap: 6px;
	}
	.preset-header {
		min-height: 82px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		border-bottom: 1px solid var(--color-line-1);
		background: var(--color-bg-1);
	}
	.preset-title {
		margin-right: auto;
		min-width: 160px;
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.eyebrow {
		font: 10px var(--font-mono);
		color: var(--color-accent);
		text-transform: uppercase;
		letter-spacing: 0.09em;
	}
	.sound-name {
		font-size: 20px !important;
		font-weight: 600 !important;
		max-width: 330px;
		padding: 0 !important;
		border-color: transparent !important;
		background: transparent !important;
	}
	.file-input {
		display: none;
	}
	.output-control {
		width: 130px;
		margin-left: 14px;
	}
	.designer-body {
		display: grid;
		grid-template-columns: 210px minmax(0, 1fr) 300px;
		flex: 1;
		min-height: 0;
	}
	.library-filters {
		display: flex;
		gap: var(--sp-2);
		margin-bottom: var(--sp-2);
	}
	.library-filters select {
		min-width: 0;
		flex: 1;
	}
	.library-filters button[aria-pressed='true'] {
		color: var(--color-accent);
	}
	.starter-picker {
		margin-bottom: var(--sp-3);
		padding: var(--sp-2);
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
	}
	.starter-picker summary {
		cursor: pointer;
		font-size: 12px;
	}
	.starter-picker .select-label,
	.starter-picker button {
		margin-top: var(--sp-2);
	}
	.sound-library {
		display: flex;
		flex-direction: column;
		padding: 14px 10px;
		border-right: 1px solid var(--color-line-1);
		background: var(--color-bg-1);
		min-height: 0;
	}
	.section-heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 8px 0;
	}
	.search {
		width: 100%;
		margin: 8px 0 12px;
	}
	.sound-list {
		overflow: auto;
		flex: 1;
	}
	.sound-card {
		display: flex;
		align-items: center;
		gap: 10px;
		text-align: left;
		width: 100%;
		margin-bottom: 4px;
		background: transparent;
		border-color: transparent;
	}
	.sound-card.selected {
		background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-2));
		border-color: var(--color-accent-dim);
	}
	.sound-icon {
		font-size: 25px;
		color: var(--color-accent);
	}
	.sound-card strong,
	.sound-card small {
		display: block;
	}
	.sound-card strong {
		color: var(--color-fg-0);
		font-size: 12px;
	}
	.sound-card small {
		font-size: 10px;
		color: var(--sound-muted);
		margin-top: 4px;
	}
	.library-footer {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 14px;
		font-size: 11px;
		color: var(--sound-muted);
	}
	.primary {
		background: color-mix(in oklab, var(--color-accent) 20%, var(--color-bg-2));
		color: var(--color-fg-0);
		border-color: var(--color-accent-dim);
	}
	.sound-main {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.tabs {
		display: flex;
		align-items: center;
		min-height: 48px;
		border-bottom: 1px solid var(--color-line-1);
		padding: 0 16px;
		gap: 4px;
		background: var(--color-bg-1);
	}
	.tabs button {
		background: none;
		border-color: transparent;
		min-height: 42px;
		padding: 10px 16px;
		border-radius: 0;
	}
	.tabs button.active {
		color: var(--color-accent);
		border-bottom-color: var(--color-accent);
	}
	.tab-meta {
		font: 10px var(--font-mono);
		color: var(--sound-muted);
		margin-left: auto;
	}
	.main-content {
		padding: 14px;
		overflow: auto;
		flex: 1;
	}
	.module {
		border: 1px solid var(--color-line-1);
		background: var(--color-bg-1);
		border-radius: var(--r-3);
		padding: 14px;
		margin-bottom: 12px;
		min-width: 0;
	}
	.module-head {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-bottom: 12px;
	}
	.module-head h2 {
		margin-right: auto;
	}
	.module-head h2 span:not(.module-number) {
		color: var(--sound-muted);
		font-weight: 400;
	}
	.module-number {
		color: var(--module-accent);
		font: 11px var(--font-mono);
		margin-right: 9px;
	}
	.powered {
		color: var(--module-accent, var(--color-accent));
		border-color: var(--module-accent, var(--color-accent-dim));
		background: var(--color-bg-3);
	}
	.inactive {
		border-color: var(--color-line-0);
	}
	.inactive fieldset {
		opacity: 0.5;
	}
	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}
	.source-row {
		display: flex;
		gap: 12px;
		align-items: center;
		margin-bottom: 8px;
	}
	.source-row :global(.wave-selector) {
		flex: 1;
		min-width: 0;
	}
	.wave-visual {
		border: 1px solid var(--color-line-0);
		background: var(--color-ed-0);
		overflow: hidden;
		height: 78px;
		display: flex;
		justify-content: center;
		align-items: center;
		border-radius: var(--r-2);
		margin: 10px 0 16px;
	}
	.wave-visual svg {
		height: 66px;
		width: 100%;
	}
	.wave-visual path {
		fill: none;
		stroke: var(--module-accent);
		stroke-width: 1.5;
	}
	.controls-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 18px 16px;
	}
	.select-label {
		display: flex;
		flex-direction: column;
		gap: 7px;
		color: var(--sound-muted);
		font-size: 12px;
		min-width: 0;
	}
	.select-label select {
		width: 100%;
		font-size: 11px;
	}
	.filters {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.filters .controls-grid {
		grid-template-columns: repeat(3, minmax(0, 1fr));
		margin-top: 12px;
	}
	.muted {
		color: var(--sound-muted);
		font-size: 11px;
		line-height: 1.6;
		margin-top: 8px;
	}
	.page-intro {
		margin: 4px 0 20px;
	}
	.page-intro p {
		color: var(--sound-muted);
		font-size: 12px;
		margin-top: 6px;
	}
	.effect h2 {
		text-transform: capitalize;
	}
	.drop-slot {
		display: block;
		width: 100%;
		min-height: 18px;
		padding: 2px;
		font-size: 10px;
		color: var(--sound-muted);
		border-style: dashed;
		margin-bottom: 14px;
	}
	.drag-handle {
		cursor: grab;
		font: 12px var(--font-mono);
	}
	.delay-visual {
		height: 70px;
		display: flex;
		align-items: end;
		gap: 24px;
		padding: 12px;
		margin: 14px 0;
		border: 1px solid var(--color-line-0);
		background: var(--color-ed-0);
		font: 10px var(--font-mono);
		color: var(--sound-muted);
	}
	.delay-visual i {
		width: 3px;
		background: var(--color-accent);
	}
	.delay-visual i.right {
		background: var(--color-ji);
	}
	.delay-visual small {
		margin-left: auto;
	}
	.matrix-row {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
	}
	.matrix-row .select-label {
		flex: 1;
		min-width: 130px;
	}
	.matrix-row :global(.control) {
		min-width: 120px;
	}
	.check {
		display: flex;
		gap: 6px;
		font-size: 12px;
	}
	.modulators {
		overflow: auto;
		border-left: 1px solid var(--color-line-1);
		padding: 14px 10px;
		background: var(--color-bg-1);
	}
	.modulators .module {
		background: var(--color-bg-0);
		padding: 12px;
	}
	.modulators .controls-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.mod-graph {
		display: block;
		width: 100%;
		height: 92px;
		background: var(--color-ed-0);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		margin: 12px 0;
	}
	.mod-graph path,
	.mod-graph polyline {
		fill: none;
		stroke: var(--color-accent);
		stroke-width: 1.8;
	}
	.mod-envelope .mod-graph polyline {
		stroke: var(--color-warn);
	}
	.lfo .mod-graph polyline {
		stroke: var(--color-ji);
	}
	.mod-envelope button {
		margin-top: 12px;
	}
	.table-toolbar {
		display: flex;
		align-items: end;
		flex-wrap: wrap;
		gap: 12px;
		margin-bottom: 16px;
	}
	.table-toolbar .select-label {
		min-width: 160px;
	}
	.table-editor {
		height: 470px;
		min-width: 0;
		border: 1px solid var(--color-line-1);
	}
	.frame-strip {
		display: flex;
		overflow: auto;
		gap: 6px;
		margin: 12px 0;
	}
	.frame-strip span {
		display: block;
		font-size: 10px;
		margin-top: 5px;
	}
	.frame-strip .active,
	.table-toolbar .active {
		border-color: var(--color-accent);
	}
	.import-notes {
		margin-top: 18px;
		padding: 12px;
		background: var(--color-bg-2);
		border: 1px solid var(--color-warn);
		border-radius: var(--r-2);
		color: var(--color-fg-1);
		font-size: 12px;
	}
	.import-notes summary {
		cursor: pointer;
		color: var(--color-warn);
	}
	.import-notes li {
		margin: 8px 0;
	}
	.performance {
		display: flex;
		align-items: center;
		gap: 18px;
		min-height: 106px;
		border-top: 1px solid var(--color-line-1);
		background: var(--color-bg-1);
		padding: 12px 20px;
	}
	.audition-info {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 130px;
	}
	.audition-info span,
	.performance p {
		font: 10px var(--font-mono);
		color: var(--sound-muted);
	}
	.keyboard {
		display: flex;
		align-items: start;
		flex: 1;
		height: 76px;
	}
	.keyboard button {
		flex: 1;
		min-width: 15px;
		border-radius: 0 0 3px 3px;
		background: #ced5e0;
		color: #162031;
		height: 76px;
		padding: 0;
		border-color: #151a23;
		position: relative;
	}
	.keyboard button.black {
		background: var(--color-ed-0);
		height: 50px;
		color: var(--color-fg-0);
	}
	.keyboard button.held {
		background: var(--color-accent);
	}
	.keyboard span {
		position: absolute;
		bottom: 4px;
		left: 4px;
		font: 9px var(--font-mono);
	}
	.status {
		min-height: 25px;
		border-top: 1px solid var(--color-line-0);
		padding: 4px 18px;
		color: var(--sound-muted);
		font: 10px var(--font-mono);
	}
	.loading {
		padding: 30px;
	}
	@media (min-width: 1800px) {
		.oscillators {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 12px;
		}
		.oscillators .controls-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (max-width: 1200px) {
		.designer-body {
			grid-template-columns: 170px minmax(0, 1fr) 260px;
		}
		.controls-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.filters {
			grid-template-columns: 1fr;
		}
		.tab-meta {
			display: none;
		}
		nav {
			display: none;
		}
		.preset-header :global(.analyzer) {
			display: none;
		}
	}
	@media (max-width: 850px) {
		.designer-body {
			display: flex;
			flex-direction: column;
			overflow: auto;
		}
		.sound-library {
			border-right: 0;
			flex: none;
		}
		.sound-list {
			display: flex;
			overflow: auto;
		}
		.sound-card {
			min-width: 180px;
		}
		.library-footer {
			flex-direction: row;
			flex-wrap: wrap;
		}
		.sound-main {
			flex: none;
		}
		.main-content {
			overflow: visible;
		}
		.modulators {
			overflow: visible;
			border-left: 0;
		}
		.preset-header {
			flex-wrap: wrap;
		}
		.performance {
			flex-wrap: wrap;
		}
		.keyboard {
			min-width: 240px;
		}
		.performance p {
			display: none;
		}
		.tabs {
			overflow: auto;
		}
		.brand span {
			display: none;
		}
		.sound-name {
			max-width: 250px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		button {
			transition: none;
		}
	}
</style>
