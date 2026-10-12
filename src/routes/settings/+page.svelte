<script lang="ts">
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';
	import Panel from '#lib/ui/Panel.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import {
		deleteProject,
		listProjects,
		loadProject,
		mutate,
		replaceProject,
		saveNow,
		session
	} from '#lib/state/session.svelte';
	import { setTempo, setTimeSignature, updateEditorSettings } from '#lib/state/actions';
	import { PITCH_SNAP_OPTIONS, TIME_SNAP_OPTIONS } from '#lib/editor/snapping';
	import { createDefaultProject } from '#lib/model/project';
	import { clamp, formatTimecode, beatsToSeconds } from '#lib/model/pitch';
	import type {
		FrequencyProjection,
		PitchMap,
		ProjectSummary,
		SnapPitchMode,
		SnapTimeMode
	} from '#lib/model/types';

	let projects = $state<ProjectSummary[]>([]);
	let storageBusy = $state(false);
	let storageMessage = $state<string | null>(null);

	const project = $derived(session.project);
	const settings = $derived(project.editorSettings);
	const projectSeconds = $derived(beatsToSeconds(project.durationBeats, project.tempo));

	const snapTimeOptions = $derived(
		TIME_SNAP_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
	);
	const snapPitchOptions = $derived(
		PITCH_SNAP_OPTIONS.map((option) => ({ value: option.value, label: option.label }))
	);

	async function refreshProjectList() {
		projects = await listProjects();
	}

	$effect(() => {
		void refreshProjectList();
	});

	async function handleSave() {
		storageBusy = true;
		storageMessage = null;
		await saveNow();
		await refreshProjectList();
		storageBusy = false;
		storageMessage = session.saveState === 'saved' ? 'Project saved' : session.saveError;
	}

	async function handleOpen(id: string) {
		storageBusy = true;
		storageMessage = null;
		const opened = await loadProject(id);
		storageBusy = false;
		storageMessage = opened ? 'Project opened' : 'Could not open that project';
	}

	async function handleDelete(id: string) {
		if (!confirm('Delete this saved project? This cannot be undone.')) return;
		storageBusy = true;
		await deleteProject(id);
		await refreshProjectList();
		storageBusy = false;
		storageMessage = 'Project deleted';
	}

	function handleNewProject() {
		replaceProject(createDefaultProject('Untitled'), { resetHistory: true });
		storageMessage = 'Started a new project';
	}

	function renameProject(name: string) {
		mutate('Rename project', (current) => ({ ...current, name }), { coalesce: 'project-name' });
	}

	function setDuration(beats: number) {
		mutate(
			'Project length',
			(current) => ({ ...current, durationBeats: Math.max(1, Math.round(beats)) }),
			{ coalesce: 'project-length' }
		);
	}

	function formatSavedAt(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}
</script>

<svelte:head><title>Settings — Doodlesynth</title></svelte:head>

<div class="page">
	<header class="topbar">
		<a class="brand" href="/">Doodlesynth</a>
		<nav>
			<a href="/">Editor</a>
			<a href="/projects">Projects</a>
			<a href="/wavetables">Wavetables</a>
			<a href="/tuning">Tuning</a>
			<a class="is-current" href="/settings">Settings</a>
			<a href="/help">Help</a>
		</nav>
	</header>

	<main>
		<Panel title="Project">
			<div class="grid-3">
				<label class="text-field">
					<span class="label">Project name</span>
					<input
						class="num"
						value={project.name}
						aria-label="Project name"
						onchange={(event) => renameProject((event.currentTarget as HTMLInputElement).value)}
					/>
				</label>
				<NumberField
					label="Tempo"
					value={project.tempo}
					min={20}
					max={400}
					step={1}
					decimals={0}
					unit="BPM"
					width="92px"
					onchange={(value) => setTempo(clamp(value, 20, 400))}
				/>
				<div class="pair">
					<NumberField
						label="Time signature"
						value={project.timeSignature.numerator}
						min={1}
						max={32}
						step={1}
						decimals={0}
						width="54px"
						onchange={(value) =>
							setTimeSignature(Math.round(value), project.timeSignature.denominator)}
					/>
					<span class="slash">/</span>
					<Select
						ariaLabel="Time signature denominator"
						value={String(project.timeSignature.denominator)}
						options={[
							{ value: '2', label: '2' },
							{ value: '4', label: '4' },
							{ value: '8', label: '8' },
							{ value: '16', label: '16' }
						]}
						width="64px"
						onchange={(value) => setTimeSignature(project.timeSignature.numerator, Number(value))}
					/>
				</div>
			</div>
			<div class="grid-3">
				<NumberField
					label="Project length"
					value={project.durationBeats}
					min={1}
					max={4096}
					step={4}
					decimals={0}
					unit="beats"
					onchange={setDuration}
				/>
				<Field label="Length in time">
					<span class="num readout">{formatTimecode(projectSeconds)}</span>
				</Field>
				<Field label="Schema version">
					<span class="num readout">v{project.version}</span>
				</Field>
			</div>
			<p class="note num">
				project id {project.id} · {project.tracks.length} tracks · updated
				{formatSavedAt(project.updatedAt)}
			</p>
		</Panel>

		<Panel title="Editor defaults">
			<div class="grid-2">
				<Field
					label="Pitch map"
					hint="Piano Map is composition oriented, Frequency Map is precision oriented"
				>
					<SegmentedControl
						ariaLabel="Pitch map"
						value={settings.pitchMap}
						segments={[
							{ value: 'piano', label: 'Piano' },
							{ value: 'frequency', label: 'Frequency' }
						]}
						onchange={(value) => updateEditorSettings({ pitchMap: value as PitchMap })}
					/>
				</Field>
				<Field label="Frequency projection">
					<SegmentedControl
						ariaLabel="Frequency projection"
						value={settings.frequencyProjection}
						segments={[
							{ value: 'logarithmic', label: 'Logarithmic' },
							{ value: 'linear-hz', label: 'Linear Hz' }
						]}
						onchange={(value) =>
							updateEditorSettings({ frequencyProjection: value as FrequencyProjection })}
					/>
				</Field>
			</div>

			<div class="grid-2">
				<label class="toggle">
					<input
						type="checkbox"
						checked={settings.showPianoOverlay}
						onchange={(event) =>
							updateEditorSettings({
								showPianoOverlay: (event.currentTarget as HTMLInputElement).checked
							})}
					/>
					<span>Piano / scale overlay on the Frequency Map</span>
				</label>
				<Field label="Overlay behaviour">
					<span class="num readout">reference only, raw Hz stays authoritative</span>
				</Field>
			</div>

			<div class="grid-3">
				<Select
					label="Time snap"
					ariaLabel="Time snap"
					value={settings.snapTime}
					options={snapTimeOptions}
					onchange={(value) => updateEditorSettings({ snapTime: value as SnapTimeMode })}
				/>
				<NumberField
					label="Custom snap"
					value={settings.customSnapTicks}
					min={1}
					max={960}
					step={1}
					decimals={0}
					unit="ticks"
					disabled={settings.snapTime !== 'custom'}
					onchange={(value) => updateEditorSettings({ customSnapTicks: Math.round(value) })}
				/>
				<Select
					label="Pitch snap"
					ariaLabel="Pitch snap"
					value={settings.snapPitch}
					options={snapPitchOptions}
					onchange={(value) => updateEditorSettings({ snapPitch: value as SnapPitchMode })}
				/>
			</div>

			<div class="grid-2">
				<NumberField
					label="Minimum frequency"
					value={settings.minFrequencyHz}
					min={10}
					max={500}
					step={1}
					decimals={0}
					unit="Hz"
					onchange={(value) =>
						updateEditorSettings({ minFrequencyHz: clamp(value, 10, settings.maxFrequencyHz - 1) })}
				/>
				<NumberField
					label="Maximum frequency"
					value={settings.maxFrequencyHz}
					min={500}
					max={24000}
					step={100}
					decimals={0}
					unit="Hz"
					onchange={(value) =>
						updateEditorSettings({
							maxFrequencyHz: clamp(value, settings.minFrequencyHz + 1, 24000)
						})}
				/>
			</div>

			<p class="note">
				<strong>Logarithmic</strong> puts equal pitch ratios at equal vertical distances, so 250 Hz
				to 500 Hz occupies the same height as 2 kHz to 4 kHz. That is what makes a 20 Hz – 10 kHz
				workspace editable. <strong>Linear Hz</strong> is visually honest about absolute spacing: the
				same 250 Hz step at 2 kHz looks much smaller than it does at 250 Hz. Use it when exact frequency
				spacing matters more than musical interval shape.
			</p>
		</Panel>

		<Panel title="Storage and local data">
			<div class="storage-head">
				<IconButton
					label="Save project now"
					variant="solid"
					disabled={storageBusy}
					onclick={handleSave}
				>
					Save now
				</IconButton>
				<IconButton label="Start a new project" disabled={storageBusy} onclick={handleNewProject}>
					New project
				</IconButton>
				<span class="num state" class:is-error={session.saveState === 'error'}>
					{session.saveState === 'saved'
						? 'Saved'
						: session.saveState === 'saving'
							? 'Saving…'
							: session.saveState === 'error'
								? 'Could not save'
								: 'Unsaved changes'}
				</span>
				{#if storageMessage}<span class="num message">{storageMessage}</span>{/if}
			</div>
			{#if session.saveError}
				<p class="note error">{session.saveError}</p>
			{/if}

			<div class="saved-list">
				{#each projects as entry (entry.id)}
					<div class="saved-row" class:is-current={entry.id === project.id}>
						<span class="saved-name">{entry.name}</span>
						<span class="num muted">{entry.trackCount} tracks</span>
						<span class="num muted">{formatSavedAt(entry.updatedAt)}</span>
						<div class="saved-actions">
							<IconButton
								label={`Open ${entry.name}`}
								size="sm"
								disabled={storageBusy}
								onclick={() => handleOpen(entry.id)}
							>
								Open
							</IconButton>
							<IconButton
								label={`Delete ${entry.name}`}
								size="sm"
								variant="danger"
								disabled={storageBusy}
								onclick={() => handleDelete(entry.id)}
							>
								Delete
							</IconButton>
						</div>
					</div>
				{:else}
					<p class="note">No saved projects yet. Edits autosave after a short idle period.</p>
				{/each}
			</div>
			<p class="note">
				Projects live in this browser only: IndexedDB when available, otherwise localStorage.
				Wavetable frames store their editable source, so the generated sample cache is rebuilt on
				load rather than persisted.
			</p>
		</Panel>
	</main>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
		background: var(--color-bg-0);
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: var(--sp-5);
		height: var(--h-topbar);
		padding: 0 var(--sp-5);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		flex: none;
	}

	.brand {
		font-size: 13px;
		font-weight: 600;
		color: var(--color-fg-0);
		text-decoration: none;
	}

	nav {
		display: flex;
		gap: var(--sp-1);
	}

	nav a {
		padding: 4px 10px;
		border-radius: var(--r-1);
		color: var(--color-fg-2);
		font-size: 12px;
		text-decoration: none;
		transition:
			background-color 140ms var(--ease-out),
			color 140ms var(--ease-out);
	}

	nav a:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	nav a.is-current {
		background: color-mix(in oklab, var(--color-accent) 20%, var(--color-bg-1));
		color: var(--color-fg-0);
	}

	main {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		max-width: 900px;
		width: 100%;
		padding-bottom: var(--sp-6);
	}

	.grid-3 {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--sp-4);
		align-items: end;
		margin-bottom: var(--sp-3);
	}

	.grid-2 {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--sp-4);
		align-items: center;
		margin-bottom: var(--sp-3);
	}

	.pair {
		display: flex;
		align-items: flex-end;
		gap: var(--sp-1);
	}

	.slash {
		padding-bottom: 6px;
		color: var(--color-fg-3);
	}

	.text-field {
		display: block;
		min-width: 0;
	}

	.text-field input {
		width: 100%;
		height: var(--h-row);
		padding: 0 var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-0);
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		font-size: 11px;
		color: var(--color-fg-1);
		cursor: pointer;
	}

	.toggle input {
		width: 14px;
		height: 14px;
		accent-color: var(--color-accent);
		cursor: pointer;
	}

	.readout {
		color: var(--color-fg-0);
	}

	.note {
		margin: var(--sp-3) 0 0;
		font-size: 11px;
		line-height: 1.55;
		color: var(--color-fg-2);
		max-width: 82ch;
	}

	.note.error {
		color: var(--color-danger);
	}

	.note strong {
		color: var(--color-fg-1);
		font-weight: 600;
	}

	.storage-head {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		margin-bottom: var(--sp-3);
	}

	.state {
		color: var(--color-ok);
	}

	.state.is-error {
		color: var(--color-danger);
	}

	.message {
		color: var(--color-fg-2);
	}

	.saved-list {
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		overflow: hidden;
	}

	.saved-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 80px 170px auto;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
	}

	.saved-row:last-child {
		border-bottom: none;
	}

	.saved-row.is-current {
		background: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg-1));
	}

	.saved-name {
		font-size: 12px;
		color: var(--color-fg-0);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.muted {
		color: var(--color-fg-2);
	}

	.saved-actions {
		display: flex;
		gap: var(--sp-1);
	}
</style>
