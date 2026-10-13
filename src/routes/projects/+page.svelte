<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import IconButton from '#lib/ui/IconButton.svelte';
	import {
		createDefaultProject,
		deserializeProject,
		PROJECT_VERSION,
		serializeProject
	} from '#lib/model/project';
	import { uid } from '#lib/model/ids';
	import type { ProjectSummary } from '#lib/model/types';
	import {
		deleteProject,
		getProject,
		initSession,
		listProjects,
		loadProject,
		replaceProject,
		saveNow,
		session
	} from '#lib/state/session.svelte';

	let projects = $state<ProjectSummary[]>([]);
	let ready = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);
	let importInput: HTMLInputElement;

	const currentId = $derived(session.project.id);

	onMount(() => {
		void prepare();
	});

	async function prepare() {
		await initSession();
		// the freshly opened project may not be persisted yet; save so the
		// dashboard never shows a stale list missing the project on screen
		if (session.saveState !== 'saved') await saveNow();
		await refresh();
		ready = true;
	}

	async function refresh() {
		projects = await listProjects();
	}

	function formatWhen(timestamp: number): string {
		const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
		if (seconds < 60) return 'just now';
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes} min ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours} h ago`;
		return new Date(timestamp).toLocaleDateString();
	}

	function nextUntitledName(): string {
		const names = new Set(projects.map((entry) => entry.name));
		if (!names.has('Untitled')) return 'Untitled';
		for (let index = 2; index < 1000; index++) {
			const candidate = `Untitled ${index}`;
			if (!names.has(candidate)) return candidate;
		}
		return `Untitled ${Date.now()}`;
	}

	function handleImportClick() {
		importInput.click();
	}

	function isImportableProject(value: unknown): boolean {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
		const candidate = value as Record<string, unknown>;
		return (
			typeof candidate.id === 'string' &&
			typeof candidate.name === 'string' &&
			typeof candidate.version === 'number' &&
			candidate.version >= 1 &&
			candidate.version <= PROJECT_VERSION &&
			typeof candidate.tempo === 'number' &&
			Array.isArray(candidate.tracks) &&
			(candidate.wavetables === undefined || Array.isArray(candidate.wavetables))
		);
	}

	async function handleImportFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;

		busy = true;
		message = null;
		try {
			const text = await file.text();
			const document: unknown = JSON.parse(text);
			if (!isImportableProject(document)) {
				throw new Error('This is not a supported Doodlesynth project file');
			}
			const imported = deserializeProject(text);
			replaceProject(
				{ ...imported, id: uid('proj'), updatedAt: Date.now() },
				{ resetHistory: true }
			);
			session.viewport = {
				...session.viewport,
				startBeat: 0,
				minFrequencyHz: imported.editorSettings.minFrequencyHz,
				maxFrequencyHz: imported.editorSettings.maxFrequencyHz,
				pitchMap: imported.editorSettings.pitchMap,
				projection: imported.editorSettings.frequencyProjection
			};
			await saveNow();
			if (session.saveState === 'error')
				throw new Error(session.saveError ?? 'Could not save project');
			await refresh();

			message = `Imported “${imported.name}”`;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not import project';
		} finally {
			busy = false;
		}
	}

	async function handleExport(entry: ProjectSummary) {
		busy = true;
		message = null;
		try {
			const project = entry.id === currentId ? session.project : await getProject(entry.id);
			if (!project) throw new Error('Could not load that project');

			const blob = new Blob([serializeProject(project)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			const filename =
				entry.name
					.trim()
					.replace(/[^a-z0-9_-]+/gi, '-')
					.replace(/^-|-$/g, '') || 'project';
			link.href = url;
			link.download = `${filename}.doodlesynth.json`;
			document.body.append(link);
			link.click();
			link.remove();
			URL.revokeObjectURL(url);
			message = `Exported “${entry.name}”`;
		} catch (error) {
			message = error instanceof Error ? error.message : 'Could not export project';
		} finally {
			busy = false;
		}
	}

	async function handleNew() {
		busy = true;
		message = null;
		const project = createDefaultProject(nextUntitledName());
		replaceProject(project, { resetHistory: true });
		await saveNow();
		busy = false;
		await goto('/');
	}

	async function handleOpen(id: string) {
		busy = true;
		message = null;
		const opened = await loadProject(id);
		busy = false;
		if (opened) {
			await goto('/');
		} else {
			message = 'Could not open that project';
		}
	}

	async function handleDelete(entry: ProjectSummary) {
		if (!confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
		busy = true;
		await deleteProject(entry.id);
		if (entry.id === currentId) {
			// the editor is still holding the deleted document in memory;
			// swap in a blank one so autosave does not resurrect it
			replaceProject(createDefaultProject('Untitled'), { resetHistory: true });
			await saveNow();
		}
		await refresh();
		busy = false;
		message = 'Project deleted';
	}
</script>

<svelte:head><title>Projects — Doodlesynth</title></svelte:head>

<div class="page">
	<header class="topbar">
		<div class="topbar-inner">
			<a class="brand" href="/">Doodlesynth</a>
			<nav aria-label="Primary">
				<a href="/">Editor</a>
				<a class="is-current" href="/projects" aria-current="page">Projects</a>
				<a href="/sounds">Sounds</a>
				<a href="/tuning">Tuning</a>
				<a href="/settings">Settings</a>
				<a href="/help">Help</a>
			</nav>
		</div>
	</header>

	<main>
		<div class="content">
			<header class="hero">
				<div class="hero-text">
					<p class="label">Dashboard</p>
					<h1>Projects</h1>
					<p class="blurb">
						Every project lives in this browser. Start a new one, or pick up one you left open.
					</p>
				</div>
				<div class="hero-action">
					<input
						bind:this={importInput}
						class="file-input"
						type="file"
						accept=".json,application/json"
						aria-label="Choose a project file to import"
						disabled={busy}
						onchange={handleImportFile}
					/>
					<IconButton label="Import a project" disabled={busy} onclick={handleImportClick}
						>Import project</IconButton
					>
					<IconButton
						label="Start a new project"
						variant="solid"
						disabled={busy}
						onclick={handleNew}>New project</IconButton
					>
					{#if session.saveState === 'error' && session.saveError}
						<span class="num error">{session.saveError}</span>
					{:else if message}
						<span class="num message">{message}</span>
					{/if}
				</div>
			</header>

			{#if !ready}
				<p class="empty num">Loading projects…</p>
			{:else if projects.length === 0}
				<div class="empty-state">
					<p class="empty-title">No projects yet</p>
					<p class="empty-body">
						Edits autosave into this browser as you work. Create your first project to start drawing
						pitch curves.
					</p>
					<IconButton
						label="Start a new project"
						variant="solid"
						disabled={busy}
						onclick={handleNew}>New project</IconButton
					>
				</div>
			{:else}
				<div class="grid">
					{#each projects as entry (entry.id)}
						{@const isCurrent = entry.id === currentId}
						<article class="card" class:is-current={isCurrent}>
							<div class="card-head">
								<button
									class="card-name"
									disabled={busy}
									aria-label={`Open ${entry.name}`}
									onclick={() => void handleOpen(entry.id)}>{entry.name}</button
								>
								{#if isCurrent}<span class="badge">Open</span>{/if}
							</div>
							<p class="card-meta num">
								{entry.trackCount}
								{entry.trackCount === 1 ? 'track' : 'tracks'} · {formatWhen(entry.updatedAt)}
							</p>
							<div class="card-actions" role="group" aria-label={`Actions for ${entry.name}`}>
								<IconButton
									label={`Open ${entry.name}`}
									size="sm"
									disabled={busy}
									onclick={() => void handleOpen(entry.id)}
								>
									Open
								</IconButton>
								<IconButton
									label={`Export ${entry.name}`}
									size="sm"
									disabled={busy}
									onclick={() => void handleExport(entry)}
								>
									Export
								</IconButton>
								<IconButton
									label={`Delete ${entry.name}`}
									size="sm"
									variant="danger"
									disabled={busy}
									onclick={() => void handleDelete(entry)}
								>
									Delete
								</IconButton>
							</div>
						</article>
					{/each}
				</div>
			{/if}

			<p class="note">
				Projects are stored locally in this browser: IndexedDB when available, otherwise
				localStorage. Nothing is uploaded, so clearing site data removes them.
			</p>
		</div>
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
		height: var(--h-topbar);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		flex: none;
	}

	.topbar-inner {
		display: flex;
		align-items: center;
		gap: var(--sp-5);
		width: 100%;
		max-width: 1040px;
		padding: 0 var(--sp-5);
		margin: 0 auto;
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
		margin-left: auto;
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
	}

	.content {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		width: 100%;
		max-width: 1040px;
		margin: 0 auto;
		padding: var(--sp-5) var(--sp-5) var(--sp-6);
	}

	.hero {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--sp-5);
		padding: var(--sp-2) 0 var(--sp-3);
	}

	.hero-text {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
	}

	.label {
		margin: 0;
		font-size: 10.5px;
		font-weight: 600;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--color-fg-3);
	}

	.hero h1 {
		margin: 0;
		font-size: 26px;
		line-height: 1.1;
		letter-spacing: -0.02em;
		color: var(--color-fg-0);
	}

	.blurb {
		margin: 0;
		max-width: 62ch;
		font-size: 13px;
		line-height: 1.55;
		color: var(--color-fg-1);
	}

	.file-input {
		display: none;
	}

	.hero-action {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding-bottom: 2px;
		flex: none;
	}

	.message {
		color: var(--color-fg-2);
	}

	.error {
		color: var(--color-danger);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: var(--sp-4);
	}

	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-3) var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-3);
		background: var(--color-bg-1);
		cursor: pointer;
		transition:
			border-color 140ms var(--ease-out),
			background-color 140ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.card:hover {
		border-color: var(--color-line-1);
		background: var(--color-bg-2);
	}

	.card:active {
		transform: scale(0.98);
	}

	.card.is-current {
		border-color: color-mix(in oklab, var(--color-accent) 55%, var(--color-line-0));
	}

	.card-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}

	/* the title stretches over the whole card so clicking anywhere opens it,
	   while keyboard focus stays on one real button */
	.card-name::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--r-3);
	}

	.card-name:disabled {
		cursor: default;
	}

	.card-name {
		flex: 1;
		min-width: 0;
		padding: 0;
		border: none;
		background: none;
		font: inherit;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-fg-0);
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.badge {
		flex: none;
		padding: 1px 7px;
		border-radius: 999px;
		background: color-mix(in oklab, var(--color-accent) 22%, var(--color-bg-1));
		color: var(--color-fg-0);
		font-size: 10px;
		letter-spacing: 0.02em;
	}

	.card-meta {
		margin: 0;
		font-size: 11px;
		color: var(--color-fg-2);
	}

	.card-actions {
		position: relative;
		z-index: 1;
		display: flex;
		gap: var(--sp-1);
		padding-top: var(--sp-1);
		border-top: 1px solid var(--color-line-0);
		margin-top: auto;
	}

	.empty {
		margin: 0;
		padding: var(--sp-6) 0;
		font-size: 12px;
		color: var(--color-fg-2);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--sp-3);
		padding: var(--sp-6);
		border: 1px dashed var(--color-line-1);
		border-radius: var(--r-3);
		background: var(--color-bg-1);
	}

	.empty-title {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--color-fg-0);
	}

	.empty-body {
		margin: 0;
		max-width: 52ch;
		font-size: 12px;
		line-height: 1.6;
		color: var(--color-fg-1);
	}

	.note {
		margin: var(--sp-2) 0 0;
		font-size: 11px;
		line-height: 1.55;
		color: var(--color-fg-3);
		max-width: 82ch;
	}

	@media (max-width: 720px) {
		.topbar-inner {
			padding: 0 var(--sp-3);
		}

		.content {
			padding: var(--sp-4) var(--sp-3) var(--sp-5);
		}

		.hero {
			flex-direction: column;
			align-items: flex-start;
		}

		.hero h1 {
			font-size: 22px;
		}
	}
</style>
