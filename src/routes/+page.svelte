<script lang="ts">
	import { onMount } from 'svelte';
	import CurveEditor from '#lib/components/CurveEditor.svelte';
	import AutomationPanel from '#lib/components/AutomationPanel.svelte';
	import TopBar from '#lib/components/TopBar.svelte';
	import TrackInspector from '#lib/components/TrackInspector.svelte';
	import TrackMixer from '#lib/components/TrackMixer.svelte';
	import TrackOverview from '#lib/components/TrackOverview.svelte';
	import TrackTabs from '#lib/components/TrackTabs.svelte';
	import {
		copySelection,
		deleteSelectedCurves,
		deleteSelectedPoints,
		duplicateSelection,
		nudgeSelectedPoints,
		pasteClipboard,
		snapSelectionToNotes,
		updateEditorSettings
	} from '#lib/state/actions';
	import {
		currentSnapStep,
		goToEnd,
		goToStart,
		zoomToProject,
		zoomToSelection
	} from '#lib/state/navigation';
	import {
		activeTrack,
		initSession,
		isMasterSelected,
		MASTER_TRACK_ID,
		redo,
		selectTrack,
		session,
		setStatus,
		setTool,
		toggleTransport,
		undo,
		type Tool
	} from '#lib/state/session.svelte';
	import { createTrackAndSelect } from '#lib/state/session.svelte';
	import { dispatchShortcut, isEditableTarget } from '#lib/ui/shortcuts';
	import IconButton from '#lib/ui/IconButton.svelte';

	interface ToolDefinition {
		tool: Tool;
		label: string;
		keys: string;
		icon: string;
	}

	const TOOLS: ToolDefinition[] = [
		{ tool: 'select', label: 'Select', keys: 'A', icon: 'M3 2l8 4-3.4 1.2L6.6 11z' },
		{ tool: 'draw', label: 'Draw', keys: 'P', icon: 'M2 11l1-3 6-6 3 3-6 6z' },
		{ tool: 'point', label: 'Point edit', keys: '', icon: 'M6.5 3v7M3 6.5h7' },
		{ tool: 'eraser', label: 'Eraser', keys: 'E', icon: 'M2 9l7-7 3 3-7 7H2z' },
		{ tool: 'split', label: 'Split', keys: 'S', icon: 'M7 1v4M7 9v4M4 5.5h6' },
		{ tool: 'join', label: 'Join', keys: '', icon: 'M2 7h4M8 7h4M6.5 4.5v5' },
		{ tool: 'pan', label: 'Pan', keys: 'H', icon: 'M7 1v12M1 7h12' },
		{
			tool: 'zoom',
			label: 'Zoom',
			keys: '',
			icon: 'M3 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0zM9.5 9.5L13 13'
		},
		{ tool: 'automation', label: 'Automation', keys: '', icon: 'M1 10c3 0 3-6 6-6s3 6 6 6' },
		{ tool: 'measure', label: 'Measure', keys: '', icon: 'M1 9l5-6M2 4h4M8 4h4M2 9h4' }
	];

	const track = $derived(activeTrack());
	const automationTrackId = $derived(session.selectedTrackId);
	const automationAccent = $derived(track?.color ?? '#4da3ff');

	onMount(() => {
		void initSession();
	});

	/* ------------------------------------------------------------- shortcuts */

	function nudge(direction: 'left' | 'right' | 'up' | 'down', event: KeyboardEvent) {
		const pixels = 8;
		const zoomStep = pixels / Math.max(session.viewport.pixelsPerBeat, 0.001);
		const snapStep = currentSnapStep();
		const baseBeat = snapStep > 0 ? snapStep : zoomStep;
		const beatScale = event.shiftKey ? 4 : event.altKey ? 0.25 : 1;
		const centScale = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
		const cents = 10 * centScale;
		const key = `nudge-${direction}`;
		if (direction === 'left') nudgeSelectedPoints(-baseBeat * beatScale, 0, key);
		else if (direction === 'right') nudgeSelectedPoints(baseBeat * beatScale, 0, key);
		else if (direction === 'up') nudgeSelectedPoints(0, cents, key);
		else nudgeSelectedPoints(0, -cents, key);
	}

	function cycleTrack(direction: 1 | -1) {
		const ids = [MASTER_TRACK_ID, ...session.project.tracks.map((entry) => entry.id)];
		const index = ids.indexOf(session.selectedTrackId);
		const next = ids[(index + direction + ids.length) % ids.length];
		selectTrack(next);
	}

	const handlers: Record<string, () => void> = {
		play: () => toggleTransport(),
		stop: () => {
			if (session.playing) toggleTransport();
			goToStart();
		},
		home: goToStart,
		end: goToEnd,
		'tool-select': () => setTool('select'),
		'tool-draw': () => setTool('draw'),
		'tool-erase': () => setTool('eraser'),
		'tool-split': () => setTool('split'),
		'tool-pan': () => setTool('pan'),
		undo: () => undo(),
		redo: () => redo(),
		copy: () => copySelection(),
		paste: () => pasteClipboard(),
		duplicate: () => duplicateSelection(),
		delete: () => {
			if (session.selectedPointIds.length) deleteSelectedPoints();
			else deleteSelectedCurves();
		},
		cancel: () => {
			setStatus(null);
			session.activeTool = 'select';
		},
		'snap-toggle': () => {
			session.snapEnabled = !session.snapEnabled;
			setStatus(session.snapEnabled ? 'Snap on' : 'Snap off');
		},
		'snap-note': () => snapSelectionToNotes(),
		'zoom-selection': () => zoomToSelection(),
		'zoom-project': () => zoomToProject(),
		'pitch-map': () =>
			updateEditorSettings({
				pitchMap: session.project.editorSettings.pitchMap === 'piano' ? 'frequency' : 'piano'
			}),
		inspector: () => (session.showInspector = !session.showInspector),
		'next-track': () => cycleTrack(1),
		'previous-track': () => cycleTrack(-1),
		'new-track': () => createTrackAndSelect()
	};

	function onKeydown(event: KeyboardEvent) {
		if (isEditableTarget(event.target)) return;

		// arrow keys nudge selected points rather than dispatching a handler
		if (
			(event.key === 'ArrowUp' ||
				event.key === 'ArrowDown' ||
				event.key === 'ArrowLeft' ||
				event.key === 'ArrowRight') &&
			session.selectedPointIds.length > 0
		) {
			event.preventDefault();
			nudge(
				event.key === 'ArrowLeft'
					? 'left'
					: event.key === 'ArrowRight'
						? 'right'
						: event.key === 'ArrowUp'
							? 'up'
							: 'down',
				event
			);
			return;
		}

		dispatchShortcut(event, handlers);
	}

	// transient status message
	$effect(() => {
		const message = session.statusMessage;
		if (!message) return;
		const handle = setTimeout(() => setStatus(null), 2600);
		return () => clearTimeout(handle);
	});

	$effect(() => {
		window.addEventListener('keydown', onKeydown);
		return () => window.removeEventListener('keydown', onKeydown);
	});

	const snapBeats = $derived(currentSnapStep());
</script>

<svelte:head>
	<title>{session.project.name} — Doodlesynth</title>
	<meta
		name="description"
		content="Doodlesynth is a static, client-side instrument for drawing continuous pitch curves instead of entering MIDI notes."
	/>
</svelte:head>

<div class="app">
	<TopBar />

	<div class="tool-strip">
		<div class="tools" role="toolbar" aria-label="Editor tools">
			{#each TOOLS as entry (entry.tool)}
				<IconButton
					label={entry.keys ? `${entry.label} (${entry.keys})` : entry.label}
					active={session.activeTool === entry.tool}
					onclick={() => setTool(entry.tool)}
				>
					<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
						<path
							d={entry.icon}
							fill="none"
							stroke="currentColor"
							stroke-width="1.3"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
					<span class="tool-label">{entry.label}</span>
				</IconButton>
			{/each}
		</div>

		<div class="tool-strip-right">
			<TrackMixer trackId={session.selectedTrackId} accent={automationAccent} compact={true} />
			<IconButton
				label="Toggle inspector (I)"
				active={session.showInspector}
				onclick={() => (session.showInspector = !session.showInspector)}
			>
				<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
					<path d="M2 2h10v10H2zM9 2v10" fill="none" stroke="currentColor" stroke-width="1.3" />
				</svg>
			</IconButton>
		</div>
	</div>

	<div class="main">
		<div class="editor-column">
			{#if isMasterSelected()}
				<!-- Master: tracks and effect automation only, no pitch curve editor -->
				<TrackOverview />
				<AutomationPanel
					trackId={MASTER_TRACK_ID}
					width={session.viewport.width}
					startBeat={session.viewport.startBeat}
					pixelsPerBeat={session.viewport.pixelsPerBeat}
					playhead={session.playhead}
					{snapBeats}
				/>
			{:else}
				<CurveEditor />
				<AutomationPanel
					trackId={automationTrackId}
					width={session.viewport.width}
					startBeat={session.viewport.startBeat}
					pixelsPerBeat={session.viewport.pixelsPerBeat}
					playhead={session.playhead}
					{snapBeats}
				/>
			{/if}
		</div>
		{#if session.showInspector}
			<TrackInspector />
		{/if}
	</div>

	<TrackTabs />

	{#if session.showOnboarding && session.project.tracks.length === 0}
		<div class="onboarding" role="dialog" aria-label="Start creating">
			<div class="onboarding-card">
				<p class="label">Doodlesynth</p>
				<h1>Draw a curve to create a voice</h1>
				<p class="blurb">
					A voice is a curve through continuous frequency, not a row of MIDI notes. Create a track,
					pick a waveform, then drag across the editor to draw the pitch trajectory you want to
					hear.
				</p>
				<div class="onboarding-actions">
					<IconButton
						label="Create the first track"
						variant="solid"
						onclick={() => {
							createTrackAndSelect('Lead');
							setTool('draw');
						}}
					>
						Create Track
					</IconButton>
					<IconButton
						label="Dismiss and explore the empty editor"
						onclick={() => (session.showOnboarding = false)}
					>
						Explore first
					</IconButton>
				</div>
			</div>
		</div>
	{/if}

	{#if session.statusMessage}
		<div class="status num" role="status">{session.statusMessage}</div>
	{/if}

	{#if session.saveState === 'error'}
		<div class="save-error" role="alert">
			<span>{session.saveError ?? 'Could not save project'}</span>
		</div>
	{/if}
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.tool-strip {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-4);
		padding: 3px var(--sp-3);
		background: var(--color-bg-1);
		border-bottom: 1px solid var(--color-line-0);
		flex: none;
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}

	.tool-label {
		font-size: 11px;
	}

	.tool-strip-right {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.main {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.editor-column {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.onboarding {
		position: fixed;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(5, 7, 11, 0.72);
		backdrop-filter: blur(6px);
		z-index: var(--z-modal);
		animation: onboarding-in 220ms var(--ease-out);
	}

	@keyframes onboarding-in {
		from {
			opacity: 0;
		}
	}

	.onboarding-card {
		width: min(520px, 84vw);
		padding: var(--sp-6);
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-3);
		background: var(--color-bg-1);
		text-align: left;
	}

	.onboarding-card h1 {
		margin: var(--sp-2) 0 var(--sp-3);
		font-size: 22px;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--color-fg-0);
	}

	.blurb {
		margin: 0 0 var(--sp-5);
		font-size: 13px;
		line-height: 1.5;
		color: var(--color-fg-1);
	}

	.onboarding-actions {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.status {
		position: fixed;
		bottom: 56px;
		left: 50%;
		transform: translateX(-50%);
		padding: 5px var(--sp-4);
		border: 1px solid var(--color-line-1);
		border-radius: 999px;
		background: var(--color-bg-2);
		color: var(--color-fg-0);
		font-size: 11px;
		z-index: var(--z-menu);
		animation: status-in 160ms var(--ease-out);
	}

	@keyframes status-in {
		from {
			opacity: 0;
			transform: translate(-50%, 6px);
		}
	}

	.save-error {
		position: fixed;
		bottom: var(--sp-4);
		right: var(--sp-4);
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-3) var(--sp-4);
		border: 1px solid color-mix(in oklab, var(--color-danger) 50%, var(--color-line-1));
		border-radius: var(--r-2);
		background: color-mix(in oklab, var(--color-danger) 14%, var(--color-bg-2));
		color: var(--color-fg-0);
		font-size: 12px;
		z-index: var(--z-menu);
	}

	@media (max-width: 1320px) {
		.tool-label {
			display: none;
		}
	}
</style>
