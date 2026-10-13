<script lang="ts">
	import { PITCH_SNAP_OPTIONS, TIME_SNAP_OPTIONS } from '#lib/editor/snapping';
	import type { SnapPitchMode, SnapTimeMode } from '#lib/model/types';
	import { updateEditorSettings } from '#lib/state/actions';
	import { zoomTime, zoomToProject, zoomToSelection } from '#lib/state/navigation';
	import {
		canRedo,
		canUndo,
		redo,
		redoLabel,
		session,
		undo,
		undoLabel
	} from '#lib/state/session.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import Transport from './Transport.svelte';

	const saveLabel = $derived(
		session.saveState === 'saved'
			? 'Saved'
			: session.saveState === 'saving'
				? 'Saving…'
				: session.saveState === 'error'
					? 'Save failed'
					: 'Unsaved'
	);

	const timeSnapOptions = TIME_SNAP_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label
	}));
	const pitchSnapOptions = PITCH_SNAP_OPTIONS.map((option) => ({
		value: option.value,
		label: option.label
	}));

	function setProjectName(event: Event) {
		const name = (event.currentTarget as HTMLInputElement).value;
		session.project = { ...session.project, name };
	}
</script>

<header class="topbar">
	<div class="identity">
		<a class="logo" href="/" aria-label="Doodlesynth editor">
			<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
				<path
					d="M2 13c3 0 3-8 6-8s3 8 6 8"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
				<circle cx="8" cy="5" r="1.4" fill="currentColor" />
			</svg>
			<span>Doodlesynth</span>
		</a>
		<nav class="nav" aria-label="Sections">
			<a href="/projects">Projects</a>
			<a href="/sounds">Sounds</a>
			<a href="/tuning">Tuning</a>
			<a href="/settings">Settings</a>
			<a href="/help">Help</a>
		</nav>
	</div>

	<div class="project">
		<input
			class="project-name"
			aria-label="Project name"
			value={session.project.name}
			onchange={setProjectName}
		/>
		<span
			class="save"
			class:is-error={session.saveState === 'error'}
			data-state={session.saveState}
		>
			<span class="save-dot" aria-hidden="true"></span>
			{saveLabel}
		</span>
	</div>

	<div class="history">
		<IconButton
			label={undoLabel() ? `Undo ${undoLabel()}` : 'Undo'}
			disabled={!canUndo()}
			onclick={undo}
		>
			<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
				<path
					d="M5 3L2 6l3 3M2 6h5.5a2.5 2.5 0 0 1 0 5H6"
					fill="none"
					stroke="currentColor"
					stroke-width="1.4"
					stroke-linecap="round"
				/>
			</svg>
		</IconButton>
		<IconButton
			label={redoLabel() ? `Redo ${redoLabel()}` : 'Redo'}
			disabled={!canRedo()}
			onclick={redo}
		>
			<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
				<path
					d="M7 3l3 3-3 3M10 6H4.5a2.5 2.5 0 0 0 0 5H6"
					fill="none"
					stroke="currentColor"
					stroke-width="1.4"
					stroke-linecap="round"
				/>
			</svg>
		</IconButton>
	</div>

	<Transport />

	<div class="snap">
		<IconButton
			label="Snap (G)"
			active={session.snapEnabled}
			onclick={() => (session.snapEnabled = !session.snapEnabled)}
		>
			<span class="num">SNAP</span>
		</IconButton>
		<select
			class="num compact-select"
			aria-label="Time snap"
			value={session.project.editorSettings.snapTime}
			onchange={(event) =>
				updateEditorSettings({
					snapTime: (event.currentTarget as HTMLSelectElement).value as SnapTimeMode
				})}
		>
			{#each timeSnapOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
		<select
			class="num compact-select"
			aria-label="Pitch snap"
			value={session.project.editorSettings.snapPitch}
			onchange={(event) =>
				updateEditorSettings({
					snapPitch: (event.currentTarget as HTMLSelectElement).value as SnapPitchMode
				})}
		>
			{#each pitchSnapOptions as option (option.value)}
				<option value={option.value}>{option.label}</option>
			{/each}
		</select>
	</div>

	<div class="zoom" role="group" aria-label="Zoom">
		<IconButton label="Zoom out" onclick={() => zoomTime(1 / 1.4)}>
			<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
				<path d="M1 5h8" stroke="currentColor" stroke-width="1.5" fill="none" />
			</svg>
		</IconButton>
		<IconButton label="Zoom in" onclick={() => zoomTime(1.4)}>
			<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
				<path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.5" fill="none" />
			</svg>
		</IconButton>
		<IconButton label="Zoom to selection (Z)" onclick={zoomToSelection}>
			<span class="num">SEL</span>
		</IconButton>
		<IconButton label="Zoom to project (Shift+Z)" onclick={zoomToProject}>
			<span class="num">ALL</span>
		</IconButton>
	</div>
</header>

<style>
	.topbar {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
		height: var(--h-topbar);
		padding: 0 var(--sp-3);
		background: var(--color-bg-1);
		border-bottom: 1px solid var(--color-line-0);
		flex: none;
		/* floating chrome: content scrolls beneath a translucent layer */
		backdrop-filter: blur(14px) saturate(140%);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
	}

	.logo {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		color: var(--color-accent);
		text-decoration: none;
		font-size: 12px;
		font-weight: 650;
		letter-spacing: 0.01em;
	}

	.logo span {
		color: var(--color-fg-0);
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.nav a {
		color: var(--color-fg-2);
		text-decoration: none;
		font-size: 11px;
		padding: 3px var(--sp-2);
		border-radius: var(--r-1);
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out);
	}

	.nav a:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.project {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		min-width: 0;
	}

	.project-name {
		width: 168px;
		height: var(--h-row);
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-0);
		font-size: 12px;
		padding: 0 var(--sp-2);
		transition:
			border-color 130ms var(--ease-out),
			background-color 130ms var(--ease-out);
	}

	.project-name:hover {
		border-color: var(--color-line-0);
	}

	.save {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10px;
		color: var(--color-fg-3);
		white-space: nowrap;
	}

	.save-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-fg-3);
	}

	.save[data-state='saved'] .save-dot {
		background: var(--color-ok);
	}

	.save[data-state='dirty'] .save-dot,
	.save[data-state='saving'] .save-dot {
		background: var(--color-warn);
	}

	.save[data-state='error'] .save-dot,
	.save.is-error {
		background: transparent;
		color: var(--color-danger);
	}

	.save[data-state='error'] .save-dot {
		background: var(--color-danger);
	}

	.history {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}

	.snap {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}

	.compact-select {
		height: var(--h-control);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-1);
		font-size: 11px;
		padding: 0 var(--sp-1);
		cursor: pointer;
	}

	.zoom {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		margin-left: auto;
	}

	.num {
		font-size: 10px;
		letter-spacing: 0.04em;
	}

	@media (max-width: 1420px) {
		.nav {
			display: none;
		}
	}
</style>
