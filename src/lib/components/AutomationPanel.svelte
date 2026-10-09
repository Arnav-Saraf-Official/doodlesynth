<script lang="ts">
	/**
	 * Automation lanes for one or more tracks.
	 *
	 * The header owns the lane scope (which tracks are shown, or All) and the
	 * top edge is a drag handle that resizes how much vertical room the lane
	 * list gets; the list scrolls once it outgrows that.
	 */
	import { MASTER_TRACK_ID, session } from '#lib/state/session.svelte';
	import AutomationTrackGroup from './AutomationTrackGroup.svelte';

	interface Props {
		trackId: string;
		width: number;
		startBeat: number;
		pixelsPerBeat: number;
		playhead: number;
		snapBeats?: number;
	}

	let { trackId, width, startBeat, pixelsPerBeat, playhead, snapBeats = 0 }: Props = $props();

	let expanded = $state(true);
	let scopeOpen = $state(false);
	let resizing = $state(false);
	let resizeStartY = 0;
	let resizeStartHeight = 200;

	const allIds = $derived([MASTER_TRACK_ID, ...session.project.tracks.map((track) => track.id)]);

	/** valid ids whose lanes are shown; falls back to the active tab's track */
	const scopeTracks = $derived.by(() => {
		const selected = session.automationTrackIds.length ? session.automationTrackIds : [trackId];
		const valid = selected.filter(
			(id) => id === MASTER_TRACK_ID || session.project.tracks.some((track) => track.id === id)
		);
		return valid.length ? valid : [trackId];
	});

	const laneCount = $derived(
		scopeTracks.reduce((sum, id) => {
			const lanes =
				id === MASTER_TRACK_ID
					? session.project.master.automationLanes
					: (session.project.tracks.find((track) => track.id === id)?.automationLanes ?? []);
			return sum + lanes.length;
		}, 0)
	);

	function trackName(id: string): string {
		if (id === MASTER_TRACK_ID) return 'Master';
		return session.project.tracks.find((track) => track.id === id)?.name ?? 'Track';
	}

	function trackColor(id: string): string {
		if (id === MASTER_TRACK_ID) return '#c58bf5';
		return session.project.tracks.find((track) => track.id === id)?.color ?? '#4da3ff';
	}

	function inScope(id: string): boolean {
		return session.automationTrackIds.length
			? session.automationTrackIds.includes(id)
			: id === trackId;
	}

	const allSelected = $derived(allIds.every((id) => inScope(id)));

	const scopeLabel = $derived.by(() => {
		const selected = session.automationTrackIds;
		if (selected.length === 0) return 'This track';
		if (allIds.every((id) => selected.includes(id))) return 'All tracks';
		if (selected.length === 1) return trackName(selected[0]);
		return `${selected.length} tracks`;
	});

	function toggleAll(checked: boolean) {
		session.automationTrackIds = checked ? [...allIds] : [];
	}

	function toggleTrack(id: string) {
		const selected = session.automationTrackIds.length
			? [...session.automationTrackIds]
			: [trackId];
		const index = selected.indexOf(id);
		if (index >= 0) selected.splice(index, 1);
		else selected.push(id);
		session.automationTrackIds = selected;
	}

	function onResizeDown(event: PointerEvent) {
		resizing = true;
		resizeStartY = event.clientY;
		resizeStartHeight = session.automationPanelHeight;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onResizeMove(event: PointerEvent) {
		if (!resizing) return;
		const next = resizeStartHeight - (event.clientY - resizeStartY);
		session.automationPanelHeight = Math.round(Math.min(Math.max(next, 60), 640));
	}

	function onResizeUp(event: PointerEvent) {
		resizing = false;
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		} catch {
			// capture may already be released
		}
	}
</script>

<section class="automation" style="width:{width}px">
	<div
		class="resize-handle"
		class:is-active={resizing}
		role="separator"
		aria-orientation="horizontal"
		aria-label="Resize automation lanes"
		title="Drag to resize"
		onpointerdown={onResizeDown}
		onpointermove={onResizeMove}
		onpointerup={onResizeUp}
		onpointercancel={onResizeUp}
	></div>

	<header class="automation-head" style="height:26px">
		<button
			type="button"
			class="disclosure"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<svg class="chevron" class:is-open={expanded} viewBox="0 0 8 8" aria-hidden="true">
				<path d="M2.5 1l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3" />
			</svg>
			<span>Automation</span>
			<span class="count">{laneCount}</span>
		</button>

		<div class="head-actions">
			<div class="scope">
				<button
					type="button"
					class="scope-button"
					aria-haspopup="listbox"
					aria-expanded={scopeOpen}
					onclick={() => (scopeOpen = !scopeOpen)}
				>
					<span class="scope-label">{scopeLabel}</span>
					<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
						<path d="M1 3l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" />
					</svg>
				</button>

				{#if scopeOpen}
					<button
						type="button"
						class="scope-backdrop"
						aria-label="Close track selection"
						onclick={() => (scopeOpen = false)}
					></button>
					<div class="scope-menu" role="listbox" aria-multiselectable="true" aria-label="Tracks">
						<label class="scope-item is-all">
							<input
								type="checkbox"
								checked={allSelected}
								onchange={(event) => toggleAll(event.currentTarget.checked)}
							/>
							<span>All tracks</span>
						</label>
						<div class="scope-sep"></div>
						{#each allIds as id (id)}
							<label class="scope-item">
								<input type="checkbox" checked={inScope(id)} onchange={() => toggleTrack(id)} />
								<span class="dot" style="background:{trackColor(id)}"></span>
								<span class="scope-name">{trackName(id)}</span>
							</label>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</header>

	{#if expanded}
		<div class="lane-scroll" style="max-height:{session.automationPanelHeight}px">
			{#each scopeTracks as id (id)}
				<AutomationTrackGroup
					trackId={id}
					name={trackName(id)}
					accent={trackColor(id)}
					{width}
					{startBeat}
					{pixelsPerBeat}
					{playhead}
					{snapBeats}
				/>
			{/each}
		</div>
	{/if}
</section>

<style>
	.automation {
		position: relative;
		border-top: 1px solid var(--color-line-0);
		background: var(--color-bg-0);
		flex: none;
	}

	.resize-handle {
		position: absolute;
		top: -3px;
		left: 0;
		right: 0;
		height: 7px;
		cursor: ns-resize;
		z-index: 2;
		touch-action: none;
	}

	.resize-handle::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 3px;
		width: 42px;
		height: 2px;
		border-radius: 2px;
		background: var(--color-line-1);
		transform: translateX(-50%);
		transition: background-color 130ms var(--ease-out);
	}

	.resize-handle:hover::after,
	.resize-handle.is-active::after {
		background: var(--color-accent);
	}

	.automation-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-3);
		padding: 0 var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
	}

	.disclosure {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		background: none;
		border: none;
		padding: 0;
		color: var(--color-fg-2);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		cursor: pointer;
		transition: color 130ms var(--ease-out);
	}

	.disclosure:hover {
		color: var(--color-fg-0);
	}

	.chevron {
		width: 8px;
		height: 8px;
		transition: transform 170ms var(--ease-out);
	}

	.chevron.is-open {
		transform: rotate(90deg);
	}

	.count {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--color-fg-3);
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.scope {
		position: relative;
	}

	.scope-button {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: 20px;
		max-width: 180px;
		padding: 0 var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-1);
		font-size: 11px;
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out);
	}

	.scope-button:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.scope-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.scope-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-menu);
		background: transparent;
		border: none;
		cursor: default;
	}

	.scope-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: calc(var(--z-menu) + 1);
		min-width: 180px;
		max-height: 260px;
		overflow-y: auto;
		padding: 4px;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		background: var(--color-bg-2);
		box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
	}

	.scope-item {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: 4px 6px;
		border-radius: var(--r-1);
		font-size: 11px;
		color: var(--color-fg-1);
		cursor: pointer;
	}

	.scope-item:hover {
		background: var(--color-bg-4);
		color: var(--color-fg-0);
	}

	.scope-item.is-all {
		font-weight: 600;
		color: var(--color-fg-0);
	}

	.scope-item input {
		margin: 0;
		accent-color: var(--color-accent);
	}

	.scope-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.scope-sep {
		height: 1px;
		margin: 4px 0;
		background: var(--color-line-0);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		flex: none;
	}

	.lane-scroll {
		overflow-y: auto;
		overflow-x: hidden;
	}
</style>
