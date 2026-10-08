<script lang="ts">
	/**
	 * Precision editing surface for the selected track or the master tab.
	 *
	 * The canvas remains the fast editing surface; this panel exists for exact
	 * numbers. Every field writes through the actions module so the change is
	 * one undo step, and nothing here owns project state.
	 */
	import {
		addLfo,
		duplicateTrackById,
		removeLfo,
		removeTrack,
		renameTrack,
		retuneTrackToCurrentScale,
		setCurvePoints,
		setTrackColor,
		setTrackPitchRepresentation,
		setTrackTuningFollow,
		updateCurve,
		updateLfo,
		updateSynth,
		updateTrackMixer
	} from '#lib/state/actions';
	import { activeTrack, isMasterSelected, mutate, session } from '#lib/state/session.svelte';
	import { resolveMusicalState, resolveScale } from '#lib/model/musicalState';
	import { JI_ANCHOR_LABELS, tuningLabel } from '#lib/model/tuning';
	import { formatParameterValue, parametersForScope } from '#lib/model/parameters';
	import { TRACK_COLORS } from '#lib/model/project';
	import {
		centsFromNearestNote,
		formatCents,
		formatDb,
		formatHz,
		hzToNoteName,
		NOTE_NAMES
	} from '#lib/model/pitch';
	import type {
		Curve,
		Lfo,
		LfoWaveform,
		MasterTrack,
		PitchRepresentation,
		WaveSource
	} from '#lib/model/types';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Field from '#lib/ui/Field.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';
	import Panel from '#lib/ui/Panel.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Slider from '#lib/ui/Slider.svelte';
	import WaveSelector from './WaveSelector.svelte';

	const project = $derived(session.project);
	const track = $derived(activeTrack());
	const master = $derived(project.master);
	const isMaster = $derived(isMasterSelected());
	const trackIndex = $derived(
		track ? project.tracks.findIndex((entry) => entry.id === track.id) + 1 : 0
	);

	const selectedCurve = $derived.by(() => {
		const current = track;
		if (!current || session.selectedCurveIds.length !== 1) return null;
		return current.curves.find((curve) => curve.id === session.selectedCurveIds[0]) ?? null;
	});

	const firstPoint = $derived(selectedCurve?.points[0] ?? null);
	const lastPoint = $derived(
		selectedCurve && selectedCurve.points.length > 0
			? selectedCurve.points[selectedCurve.points.length - 1]
			: null
	);

	const musicalState = $derived(resolveMusicalState(project, session.playhead));
	const musicalScale = $derived(resolveScale(project, musicalState));
	const musicalKeyframe = $derived.by(() => {
		const frames = [...project.master.musicalState].sort((a, b) => a.time - b.time);
		return frames.filter((frame) => frame.time <= session.playhead).pop() ?? null;
	});

	const destinationOptions = $derived(
		parametersForScope('track').map((parameter) => ({
			value: parameter.key,
			label: parameter.label
		}))
	);

	const lfoWaveOptions = [
		{ value: 'sine', label: 'Sine' },
		{ value: 'triangle', label: 'Triangle' },
		{ value: 'saw-up', label: 'Saw up' },
		{ value: 'saw-down', label: 'Saw down' },
		{ value: 'square', label: 'Square' }
	];

	const lfoSyncOptions = [
		{ value: 'free', label: 'Free' },
		{ value: '1/1', label: '1/1' },
		{ value: '1/2', label: '1/2' },
		{ value: '1/4', label: '1/4' },
		{ value: '1/8', label: '1/8' },
		{ value: '1/16', label: '1/16' }
	];

	const filterTypeOptions = [
		{ value: 'lowpass', label: 'Low pass' },
		{ value: 'highpass', label: 'High pass' },
		{ value: 'bandpass', label: 'Band pass' }
	];

	function cycleColor() {
		const current = track;
		if (!current) return;
		const index = TRACK_COLORS.indexOf(current.color);
		setTrackColor(current.id, TRACK_COLORS[(index + 1) % TRACK_COLORS.length]);
	}

	function patchEnvelope(patch: Partial<Curve['envelope']>) {
		const current = track;
		if (!current || !selectedCurve) return;
		updateCurve(
			current.id,
			selectedCurve.id,
			{ envelope: { ...selectedCurve.envelope, ...patch } },
			'Envelope'
		);
	}

	function setCurveEdge(edge: 'start' | 'end', time: number) {
		const current = track;
		if (!current || !selectedCurve || selectedCurve.points.length === 0) return;
		const points = [...selectedCurve.points];
		const index = edge === 'start' ? 0 : points.length - 1;
		points[index] = { ...points[index], time: Math.max(0, time) };
		setCurvePoints(current.id, selectedCurve.id, points, 'Curve range');
	}

	function patchMasterSynth(patch: Partial<MasterTrack['synth']>) {
		// no dedicated action exists for master synth settings yet, so this uses
		// the same low-level mutate path the actions themselves use
		mutate(
			'Master synth',
			(current) => ({
				...current,
				master: { ...current.master, synth: { ...current.master.synth, ...patch } }
			}),
			{ coalesce: 'master-synth' }
		);
	}

	function formatEnvelopeSeconds(seconds: number): string {
		return `${(seconds * 1000).toFixed(0)} ms`;
	}
</script>

<aside class="inspector" aria-label={isMaster ? 'Master inspector' : 'Track inspector'}>
	<header class="inspector-header">
		{#if track}
			<button
				type="button"
				class="swatch"
				style="background:{track.color}"
				aria-label="Track colour, click to cycle"
				title="Track colour — click to cycle"
				onclick={cycleColor}
			></button>
			<input
				class="name num"
				value={track.name}
				aria-label="Track name"
				spellcheck="false"
				oninput={(event) => renameTrack(track.id, event.currentTarget.value)}
			/>
			<span class="index num">{trackIndex}/{project.tracks.length}</span>
			<IconButton label="Duplicate track" size="sm" onclick={() => duplicateTrackById(track.id)}>
				<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
					<rect x="1" y="3" width="7" height="7" rx="1" fill="none" stroke="currentColor" />
					<path d="M4 1h6a1 1 0 011 1v6" fill="none" stroke="currentColor" />
				</svg>
			</IconButton>
			<IconButton
				label="Delete track"
				size="sm"
				variant="danger"
				onclick={() => removeTrack(track.id)}
			>
				<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
					<path d="M2 3h8M4.5 3V2h3v1M3 3l.6 7h4.8L9 3" fill="none" stroke="currentColor" />
				</svg>
			</IconButton>
		{:else}
			<span class="swatch is-master" aria-hidden="true">M</span>
			<span class="master-name">Master</span>
			<span class="index">project</span>
		{/if}
	</header>

	<div class="inspector-body">
		{#if track}
			{#if selectedCurve && firstPoint && lastPoint}
				<Panel title="Voice">
					<Field label="Name" stacked>
						<input
							class="name"
							value={selectedCurve.name}
							aria-label="Curve name"
							spellcheck="false"
							oninput={(event) =>
								updateCurve(
									track.id,
									selectedCurve.id,
									{ name: event.currentTarget.value },
									'Curve name'
								)}
						/>
					</Field>

					<div class="grid-2">
						<NumberField
							label="Start beat"
							value={firstPoint.time}
							min={0}
							step={0.25}
							decimals={3}
							onchange={(value) => setCurveEdge('start', value)}
						/>
						<NumberField
							label="End beat"
							value={lastPoint.time}
							min={0}
							step={0.25}
							decimals={3}
							onchange={(value) => setCurveEdge('end', value)}
						/>
					</div>

					<div class="readouts">
						<span class="readout">
							<span class="readout-key">Points</span>
							<span class="num">{selectedCurve.points.length}</span>
						</span>
						<span class="readout">
							<span class="readout-key">Start Hz</span>
							<span class="num">{formatHz(firstPoint.frequency)}</span>
						</span>
						<span class="readout">
							<span class="readout-key">Start note</span>
							<span class="num"
								>{hzToNoteName(firstPoint.frequency)}
								{formatCents(centsFromNearestNote(firstPoint.frequency))}</span
							>
						</span>
						<span class="readout">
							<span class="readout-key">End Hz</span>
							<span class="num">{formatHz(lastPoint.frequency)}</span>
						</span>
						<span class="readout">
							<span class="readout-key">End note</span>
							<span class="num"
								>{hzToNoteName(lastPoint.frequency)}
								{formatCents(centsFromNearestNote(lastPoint.frequency))}</span
							>
						</span>
					</div>

					<Field label="Envelope" stacked>
						<div class="grid-2">
							<NumberField
								label="Attack"
								value={selectedCurve.envelope.attack}
								min={0}
								max={10}
								step={0.005}
								decimals={3}
								unit="s"
								onchange={(value) => patchEnvelope({ attack: value })}
							/>
							<NumberField
								label="Decay"
								value={selectedCurve.envelope.decay}
								min={0}
								max={10}
								step={0.005}
								decimals={3}
								unit="s"
								onchange={(value) => patchEnvelope({ decay: value })}
							/>
							<NumberField
								label="Sustain"
								value={selectedCurve.envelope.sustain}
								min={0}
								max={1}
								step={0.01}
								decimals={2}
								onchange={(value) => patchEnvelope({ sustain: value })}
							/>
							<NumberField
								label="Release"
								value={selectedCurve.envelope.release}
								min={0}
								max={10}
								step={0.005}
								decimals={3}
								unit="s"
								onchange={(value) => patchEnvelope({ release: value })}
							/>
						</div>
					</Field>

					<Field label="Gain">
						<Slider
							value={selectedCurve.gainDb}
							min={-60}
							max={12}
							step={0.5}
							ariaLabel="Voice gain"
							onchange={(value) =>
								updateCurve(track.id, selectedCurve.id, { gainDb: value }, 'Voice gain')}
						/>
						<span class="value num">{formatDb(selectedCurve.gainDb)}</span>
					</Field>
					<Field label="Pan">
						<Slider
							value={selectedCurve.pan}
							min={-1}
							max={1}
							step={0.01}
							ariaLabel="Voice pan"
							onchange={(value) =>
								updateCurve(track.id, selectedCurve.id, { pan: value }, 'Voice pan')}
						/>
						<span class="value num">{Math.round(selectedCurve.pan * 100)}%</span>
					</Field>
				</Panel>
			{:else}
				<div class="empty">
					<p>Select a single curve to edit its voice, range and envelope.</p>
					<p class="dim">
						{track.curves.length} curve{track.curves.length === 1 ? '' : 's'} on this track
					</p>
				</div>
			{/if}

			<Panel title="Source">
				<Field label="Wave" stacked>
					<WaveSelector
						value={track.synth.wave}
						wavetableId={track.synth.wavetableId}
						position={track.synth.wavetablePosition}
						accent={track.color}
						onChange={(wave: WaveSource, wavetableId?: string) =>
							updateSynth(track.id, { wave, wavetableId })}
					/>
				</Field>
				<Field label="WT position">
					<Slider
						value={track.synth.wavetablePosition}
						min={0}
						max={1}
						step={0.001}
						ariaLabel="Wavetable position"
						disabled={track.synth.wave !== 'wavetable'}
						onchange={(value) => updateSynth(track.id, { wavetablePosition: value })}
					/>
					<span class="value num"
						>{formatParameterValue('wavetable.position', track.synth.wavetablePosition)}</span
					>
				</Field>
				{#if track.synth.wave === 'wavetable' && track.synth.wavetableId}
					{@const table = project.wavetables.find((entry) => entry.id === track.synth.wavetableId)}
					<p class="note">
						{table
							? `${table.name} — ${table.frames.length} frames @ ${table.sampleLength} samples`
							: 'Table missing'}
					</p>
				{/if}
				<p class="note dim">
					Live playback arrives in a later phase; drawing and shaping are fully functional.
				</p>
			</Panel>

			<Panel title="Pitch">
				<div class="grid-2">
					<NumberField
						label="Offset"
						value={track.synth.pitchOffsetSemitones}
						min={-48}
						max={48}
						step={1}
						decimals={2}
						unit="st"
						onchange={(value) => updateSynth(track.id, { pitchOffsetSemitones: value })}
					/>
					<NumberField
						label="Fine"
						value={track.synth.fineCents}
						min={-100}
						max={100}
						step={1}
						decimals={1}
						unit="¢"
						onchange={(value) => updateSynth(track.id, { fineCents: value })}
					/>
				</div>

				<Field label="Interpretation" stacked>
					<SegmentedControl
						value={track.pitchRepresentation}
						segments={[
							{ value: 'absolute-hz', label: 'Absolute Hz' },
							{ value: 'scale-relative', label: 'Scale-relative' }
						]}
						ariaLabel="Pitch interpretation"
						onchange={(value) =>
							setTrackPitchRepresentation(track.id, value as PitchRepresentation)}
					/>
				</Field>
				<p class="note">
					{#if track.pitchRepresentation === 'absolute-hz'}
						Absolute-Hz curves are literal. Scale, root and tuning changes never rewrite them.
					{:else}
						Scale-relative curves are re-resolved from Musical State at each point's time.
					{/if}
				</p>
				<div class="row-end">
					<IconButton
						label="Retune to current scale"
						disabled={track.pitchRepresentation !== 'scale-relative'}
						onclick={() => retuneTrackToCurrentScale(track.id)}
					>
						Retune to Current Scale
					</IconButton>
				</div>

				<Field label="Tuning follow" stacked>
					<SegmentedControl
						value={track.tuningFollow}
						segments={[
							{ value: 'master', label: 'Master' },
							{ value: 'track', label: 'Track override' }
						]}
						ariaLabel="Tuning follow"
						onchange={(value) => setTrackTuningFollow(track.id, value as 'master' | 'track')}
					/>
				</Field>
			</Panel>

			<Panel title="Amplitude">
				<Field label="Gain">
					<Slider
						value={track.mixer.volumeDb}
						min={-60}
						max={12}
						step={0.5}
						ariaLabel="Track gain"
						onchange={(value) => updateTrackMixer(track.id, { volumeDb: value })}
					/>
					<span class="value num">{formatDb(track.mixer.volumeDb)}</span>
				</Field>
				<Field label="Pan">
					<Slider
						value={track.mixer.pan}
						min={-1}
						max={1}
						step={0.01}
						ariaLabel="Track pan"
						onchange={(value) => updateTrackMixer(track.id, { pan: value })}
					/>
					<span class="value num">{Math.round(track.mixer.pan * 100)}%</span>
				</Field>
				<Field label="Amp env" stacked>
					<div class="grid-2">
						<NumberField
							label="Attack"
							value={track.synth.attack}
							min={0}
							max={10}
							step={0.005}
							decimals={3}
							unit="s"
							onchange={(value) => updateSynth(track.id, { attack: value })}
						/>
						<NumberField
							label="Release"
							value={track.synth.release}
							min={0}
							max={10}
							step={0.005}
							decimals={3}
							unit="s"
							onchange={(value) => updateSynth(track.id, { release: value })}
						/>
					</div>
				</Field>
				<p class="note dim">
					Attack {formatEnvelopeSeconds(track.synth.attack)} · release {formatEnvelopeSeconds(
						track.synth.release
					)}
				</p>
			</Panel>
		{:else}
			<Panel title="Mixer">
				<Field label="Volume">
					<Slider
						value={master.mixer.volumeDb}
						min={-60}
						max={12}
						step={0.5}
						ariaLabel="Master volume"
						onchange={(value) => updateTrackMixer('master', { volumeDb: value })}
					/>
					<span class="value num">{formatDb(master.mixer.volumeDb)}</span>
				</Field>
				<Field label="Pan">
					<Slider
						value={master.mixer.pan}
						min={-1}
						max={1}
						step={0.01}
						ariaLabel="Master pan"
						onchange={(value) => updateTrackMixer('master', { pan: value })}
					/>
					<span class="value num">{Math.round(master.mixer.pan * 100)}%</span>
				</Field>
			</Panel>

			<Panel title="Master FX">
				<Field label="Filter" stacked>
					<div class="grid-2">
						<Select
							value={master.synth.filter.type}
							options={filterTypeOptions}
							ariaLabel="Master filter type"
							onchange={(value) =>
								patchMasterSynth({
									filter: {
										...master.synth.filter,
										type: value as 'lowpass' | 'highpass' | 'bandpass'
									}
								})}
						/>
						<NumberField
							label="Cutoff"
							value={master.synth.filter.cutoff}
							min={20}
							max={20000}
							step={10}
							decimals={0}
							unit="Hz"
							onchange={(value) =>
								patchMasterSynth({ filter: { ...master.synth.filter, cutoff: value } })}
						/>
						<NumberField
							label="Resonance"
							value={master.synth.filter.resonance}
							min={0}
							max={30}
							step={0.1}
							decimals={2}
							onchange={(value) =>
								patchMasterSynth({ filter: { ...master.synth.filter, resonance: value } })}
						/>
						<NumberField
							label="Drive"
							value={master.synth.drive}
							min={0}
							max={1}
							step={0.01}
							decimals={2}
							onchange={(value) => patchMasterSynth({ drive: value })}
						/>
					</div>
				</Field>
				<Field label="Delay" stacked>
					<div class="grid-3">
						<NumberField
							label="Mix"
							value={master.synth.delay.mix}
							min={0}
							max={1}
							step={0.01}
							decimals={2}
							onchange={(value) =>
								patchMasterSynth({ delay: { ...master.synth.delay, mix: value } })}
						/>
						<NumberField
							label="Time"
							value={master.synth.delay.time}
							min={0}
							max={2}
							step={0.01}
							decimals={2}
							unit="s"
							onchange={(value) =>
								patchMasterSynth({ delay: { ...master.synth.delay, time: value } })}
						/>
						<NumberField
							label="Fbk"
							value={master.synth.delay.feedback}
							min={0}
							max={0.95}
							step={0.01}
							decimals={2}
							onchange={(value) =>
								patchMasterSynth({ delay: { ...master.synth.delay, feedback: value } })}
						/>
					</div>
				</Field>
				<Field label="Reverb">
					<Slider
						value={master.synth.reverb.mix}
						min={0}
						max={1}
						step={0.01}
						ariaLabel="Master reverb mix"
						onchange={(value) => patchMasterSynth({ reverb: { mix: value } })}
					/>
					<span class="value num"
						>{formatParameterValue('fx.reverb.mix', master.synth.reverb.mix)}</span
					>
				</Field>
			</Panel>

			<Panel title="Musical state">
				<p class="note">
					Active keyframe evaluated at beat {session.playhead.toFixed(3)}. Musical State is
					step-based: a keyframe holds until the next one.
				</p>
				<dl class="state-list">
					<div>
						<dt>Keyframe</dt>
						<dd class="num">
							{musicalKeyframe ? `beat ${musicalKeyframe.time.toFixed(3)}` : 'default'}
						</dd>
					</div>
					<div>
						<dt>Root</dt>
						<dd class="num">{NOTE_NAMES[musicalState.rootPitchClass]}</dd>
					</div>
					<div>
						<dt>Scale</dt>
						<dd class="num">{musicalScale.name}</dd>
					</div>
					<div>
						<dt>Tuning</dt>
						<dd class="num">{tuningLabel(musicalState.tuning)}</dd>
					</div>
					<div>
						<dt>Reference</dt>
						<dd class="num">{formatHz(musicalState.tuning.referenceFrequencyHz)}</dd>
					</div>
					<div>
						<dt>JI anchor</dt>
						<dd class="num">
							{musicalState.tuning.jiAnchorMode
								? JI_ANCHOR_LABELS[musicalState.tuning.jiAnchorMode]
								: 'Master Root'}
						</dd>
					</div>
					<div>
						<dt>Snap</dt>
						<dd class="num">{musicalState.snapMode}</dd>
					</div>
					<div>
						<dt>Pitch mode</dt>
						<dd class="num">{musicalState.defaultPitchRepresentation}</dd>
					</div>
				</dl>
			</Panel>
		{/if}

		{#if track}
			<Panel title="Filter">
				<Field label="Enabled">
					<SegmentedControl
						value={track.synth.filter.enabled ? 'on' : 'off'}
						segments={[
							{ value: 'on', label: 'On' },
							{ value: 'off', label: 'Off' }
						]}
						ariaLabel="Filter enabled"
						onchange={(value) =>
							updateSynth(track.id, { filter: { ...track.synth.filter, enabled: value === 'on' } })}
					/>
				</Field>
				<Field label="Type" stacked>
					<Select
						value={track.synth.filter.type}
						options={filterTypeOptions}
						ariaLabel="Filter type"
						onchange={(value) =>
							updateSynth(track.id, {
								filter: {
									...track.synth.filter,
									type: value as 'lowpass' | 'highpass' | 'bandpass'
								}
							})}
					/>
				</Field>
				<Field label="Cutoff">
					<Slider
						value={track.synth.filter.cutoff}
						min={20}
						max={18000}
						step={1}
						ariaLabel="Filter cutoff"
						onchange={(value) =>
							updateSynth(track.id, { filter: { ...track.synth.filter, cutoff: value } })}
					/>
				</Field>
				<Field label="Cutoff Hz">
					<NumberField
						value={track.synth.filter.cutoff}
						min={20}
						max={18000}
						step={10}
						decimals={0}
						unit="Hz"
						onchange={(value) =>
							updateSynth(track.id, { filter: { ...track.synth.filter, cutoff: value } })}
					/>
				</Field>
				<Field label="Resonance">
					<Slider
						value={track.synth.filter.resonance}
						min={0}
						max={30}
						step={0.1}
						ariaLabel="Filter resonance"
						onchange={(value) =>
							updateSynth(track.id, { filter: { ...track.synth.filter, resonance: value } })}
					/>
					<span class="value num">{track.synth.filter.resonance.toFixed(2)}</span>
				</Field>
			</Panel>

			<Panel title="Modulation">
				{#if track.lfos.length === 0}
					<p class="note dim">No LFOs. Add one to modulate wavetable position, filter or pitch.</p>
				{/if}
				{#each track.lfos as lfo (lfo.id)}
					<div class="lfo">
						<div class="lfo-head">
							<IconButton
								label={`${lfo.enabled ? 'Disable' : 'Enable'} ${lfo.name}`}
								size="sm"
								active={lfo.enabled}
								onclick={() => updateLfo(track.id, lfo.id, { enabled: !lfo.enabled })}
							>
								{lfo.enabled ? 'On' : 'Off'}
							</IconButton>
							<span class="lfo-name">{lfo.name}</span>
							<IconButton
								label={`Remove ${lfo.name}`}
								size="sm"
								variant="danger"
								onclick={() => removeLfo(track.id, lfo.id)}
							>
								<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
									<path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" />
								</svg>
							</IconButton>
						</div>
						<div class="grid-2">
							<Select
								label="Wave"
								value={lfo.wave}
								options={lfoWaveOptions}
								ariaLabel={`${lfo.name} waveform`}
								onchange={(value) => updateLfo(track.id, lfo.id, { wave: value as LfoWaveform })}
							/>
							<Select
								label="Sync"
								value={lfo.sync}
								options={lfoSyncOptions}
								ariaLabel={`${lfo.name} sync`}
								onchange={(value) => updateLfo(track.id, lfo.id, { sync: value as Lfo['sync'] })}
							/>
							<NumberField
								label="Rate"
								value={lfo.rate}
								min={0.01}
								max={40}
								step={0.01}
								decimals={2}
								unit="Hz"
								disabled={lfo.sync !== 'free'}
								onchange={(value) => updateLfo(track.id, lfo.id, { rate: value })}
							/>
							<NumberField
								label="Phase"
								value={lfo.phaseDegrees}
								min={0}
								max={360}
								step={1}
								decimals={0}
								unit="°"
								onchange={(value) => updateLfo(track.id, lfo.id, { phaseDegrees: value })}
							/>
						</div>
						<Field label="Amount">
							<Slider
								value={lfo.amount}
								min={0}
								max={1}
								step={0.01}
								ariaLabel={`${lfo.name} amount`}
								onchange={(value) => updateLfo(track.id, lfo.id, { amount: value })}
							/>
							<span class="value num">{Math.round(lfo.amount * 100)}%</span>
						</Field>
						<Select
							label="Destination"
							value={lfo.destination}
							options={destinationOptions}
							ariaLabel={`${lfo.name} destination`}
							onchange={(value) => updateLfo(track.id, lfo.id, { destination: value })}
						/>
					</div>
				{/each}
				<div class="row-end">
					<IconButton label="Add LFO" onclick={() => addLfo(track.id)}>Add LFO</IconButton>
				</div>
			</Panel>

			<Panel title="FX">
				<Field label="Drive">
					<Slider
						value={track.synth.drive}
						min={0}
						max={1}
						step={0.01}
						ariaLabel="Drive"
						onchange={(value) => updateSynth(track.id, { drive: value })}
					/>
					<span class="value num">{Math.round(track.synth.drive * 100)}%</span>
				</Field>
				<Field label="Delay mix">
					<Slider
						value={track.synth.delay.mix}
						min={0}
						max={1}
						step={0.01}
						ariaLabel="Delay mix"
						onchange={(value) =>
							updateSynth(track.id, { delay: { ...track.synth.delay, mix: value } })}
					/>
					<span class="value num">{Math.round(track.synth.delay.mix * 100)}%</span>
				</Field>
				<div class="grid-2">
					<NumberField
						label="Time"
						value={track.synth.delay.time}
						min={0}
						max={2}
						step={0.01}
						decimals={2}
						unit="s"
						onchange={(value) =>
							updateSynth(track.id, { delay: { ...track.synth.delay, time: value } })}
					/>
					<NumberField
						label="Feedback"
						value={track.synth.delay.feedback}
						min={0}
						max={0.95}
						step={0.01}
						decimals={2}
						onchange={(value) =>
							updateSynth(track.id, { delay: { ...track.synth.delay, feedback: value } })}
					/>
				</div>
				<Field label="Reverb">
					<Slider
						value={track.synth.reverb.mix}
						min={0}
						max={1}
						step={0.01}
						ariaLabel="Reverb mix"
						onchange={(value) => updateSynth(track.id, { reverb: { mix: value } })}
					/>
					<span class="value num">{Math.round(track.synth.reverb.mix * 100)}%</span>
				</Field>
			</Panel>

			<Panel title="Mixer">
				<Field label="Volume">
					<Slider
						value={track.mixer.volumeDb}
						min={-60}
						max={12}
						step={0.5}
						ariaLabel="Track volume"
						onchange={(value) => updateTrackMixer(track.id, { volumeDb: value })}
					/>
					<span class="value num">{formatDb(track.mixer.volumeDb)}</span>
				</Field>
				<Field label="Pan">
					<Slider
						value={track.mixer.pan}
						min={-1}
						max={1}
						step={0.01}
						ariaLabel="Track pan position"
						onchange={(value) => updateTrackMixer(track.id, { pan: value })}
					/>
					<span class="value num">{Math.round(track.mixer.pan * 100)}%</span>
				</Field>
				<div class="row">
					<IconButton
						label={`${track.mixer.mute ? 'Unmute' : 'Mute'} ${track.name}`}
						active={track.mixer.mute}
						onclick={() => updateTrackMixer(track.id, { mute: !track.mixer.mute })}
					>
						Mute
					</IconButton>
					<IconButton
						label={`${track.mixer.solo ? 'Unsolo' : 'Solo'} ${track.name}`}
						active={track.mixer.solo}
						onclick={() => updateTrackMixer(track.id, { solo: !track.mixer.solo })}
					>
						Solo
					</IconButton>
				</div>
			</Panel>
		{/if}
	</div>
</aside>

<style>
	.inspector {
		display: flex;
		flex-direction: column;
		width: 268px;
		flex: none;
		min-height: 0;
		background: var(--color-bg-1);
		border-left: 1px solid var(--color-line-0);
	}

	.inspector-header {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: var(--h-topbar);
		padding: 0 var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
		flex: none;
	}

	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 3px;
		border: 1px solid var(--color-line-2);
		padding: 0;
		cursor: pointer;
		flex: none;
		transition:
			transform 120ms var(--ease-out),
			border-color 120ms var(--ease-out);
	}

	.swatch:hover {
		border-color: var(--color-fg-1);
	}

	.swatch:active {
		transform: scale(0.94);
	}

	.swatch.is-master {
		display: grid;
		place-items: center;
		background: var(--color-bg-3);
		color: var(--color-fg-1);
		font-size: 9px;
		font-weight: 700;
		border-radius: 3px;
	}

	.master-name {
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}

	.name {
		flex: 1;
		min-width: 0;
		height: var(--h-row);
		padding: 0 var(--sp-2);
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-0);
		font-size: 12px;
	}

	.name:hover {
		border-color: var(--color-line-0);
		background: var(--color-bg-0);
	}

	.name:focus {
		outline: none;
		border-color: var(--color-accent);
		background: var(--color-bg-0);
	}

	.index {
		font-size: 10px;
		color: var(--color-fg-3);
		flex: none;
	}

	.inspector-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.grid-2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--sp-3);
	}

	.grid-3 {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		gap: var(--sp-2);
	}

	.readouts {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--sp-2) 0;
	}

	.readout {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-3);
	}

	.readout-key {
		font-size: 11px;
		color: var(--color-fg-2);
	}

	.value {
		flex: none;
		min-width: 54px;
		text-align: right;
		color: var(--color-fg-1);
	}

	.row {
		display: flex;
		gap: var(--sp-2);
		margin-top: var(--sp-2);
	}

	.row-end {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--sp-2);
	}

	.note {
		margin: var(--sp-2) 0 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--color-fg-1);
	}

	.note.dim {
		color: var(--color-fg-3);
	}

	.empty {
		padding: var(--sp-3);
		color: var(--color-fg-2);
	}

	.empty p {
		margin: 0 0 var(--sp-2);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.empty .dim {
		color: var(--color-fg-3);
	}

	.lfo {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-2) 0 var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
	}

	.lfo-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.lfo-name {
		flex: 1;
		font-size: 11px;
		color: var(--color-fg-1);
	}

	.state-list {
		margin: var(--sp-2) 0 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.state-list > div {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-3);
	}

	.state-list dt {
		font-size: 11px;
		color: var(--color-fg-2);
	}

	.state-list dd {
		margin: 0;
		color: var(--color-fg-0);
	}
</style>
