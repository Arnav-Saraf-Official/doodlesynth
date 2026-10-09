<script lang="ts">
	/**
	 * One track's automation lanes plus its own add-lane control. The panel
	 * renders one group per track in scope so a single header row never has to
	 * guess which track a new lane belongs to.
	 */
	import { parametersForScope } from '#lib/model/parameters';
	import type { AutomationLane, AutomationPoint } from '#lib/model/types';
	import {
		addAutomationLane,
		addAutomationPoint,
		removeAutomationLane,
		removeAutomationPoint,
		setLaneEnabled,
		setLaneExpanded,
		setLanePoints,
		updateTrackMixer
	} from '#lib/state/actions';
	import { MASTER_TRACK_ID, session } from '#lib/state/session.svelte';
	import AutomationLaneRow from './AutomationLane.svelte';

	interface Props {
		trackId: string;
		name: string;
		accent: string;
		width: number;
		startBeat: number;
		pixelsPerBeat: number;
		playhead: number;
		snapBeats?: number;
		height?: number;
	}

	let {
		trackId,
		name,
		accent,
		width,
		startBeat,
		pixelsPerBeat,
		playhead,
		snapBeats = 0,
		height = 44
	}: Props = $props();

	let pendingTarget = $state('');

	const lanes = $derived<AutomationLane[]>(
		trackId === MASTER_TRACK_ID
			? session.project.master.automationLanes
			: (session.project.tracks.find((track) => track.id === trackId)?.automationLanes ?? [])
	);

	const available = $derived(
		parametersForScope(trackId === MASTER_TRACK_ID ? 'master' : 'track').filter(
			(parameter) => !lanes.some((lane) => lane.target === parameter.key)
		)
	);

	const selectedTarget = $derived(
		available.some((parameter) => parameter.key === pendingTarget)
			? pendingTarget
			: (available[0]?.key ?? '')
	);

	const mixer = $derived(
		trackId === MASTER_TRACK_ID
			? undefined
			: session.project.tracks.find((track) => track.id === trackId)?.mixer
	);

	function addLane() {
		if (!selectedTarget) return;
		addAutomationLane(selectedTarget, trackId);
		pendingTarget = '';
	}

	/* ------------------------------------------------------- lane resizing */

	/** a lane never gets taller than this, so a drag stops adding dead space */
	const MAX_LANE_HEIGHT = 240;
	/** below this a lane becomes unreadable, so the region scrolls instead */
	const MIN_LANE_HEIGHT = 22;
	/** the group can always shrink to this, leaving room to scroll its lanes */
	const MIN_REGION = 64;
	/** the collapsed single-row peek height */
	const COLLAPSED_HEIGHT = 20;

	let resizing = $state(false);
	let resizeStartY = 0;
	let resizeStartRegion = 0;

	const laneCount = $derived(lanes.length);
	/** lane region height: the user's drag, else one default lane per line */
	const region = $derived(session.automationLaneHeights[trackId] ?? laneCount * height);
	const laneHeight = $derived(
		laneCount === 0
			? height
			: Math.min(MAX_LANE_HEIGHT, Math.max(MIN_LANE_HEIGHT, Math.round(region / laneCount)))
	);
	/** the lane list is exactly as tall as its lanes; a shorter region scrolls it */
	const listHeight = $derived(laneCount * laneHeight);

	function onResizeDown(event: PointerEvent) {
		resizing = true;
		resizeStartY = event.clientY;
		resizeStartRegion = listHeight;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onResizeMove(event: PointerEvent) {
		if (!resizing) return;
		const delta = event.clientY - resizeStartY;
		const max = Math.max(laneCount * MAX_LANE_HEIGHT, MIN_REGION);
		const next = Math.round(Math.min(Math.max(resizeStartRegion + delta, MIN_REGION), max));
		session.automationLaneHeights = { ...session.automationLaneHeights, [trackId]: next };
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

<div class="group">
	<div class="group-head">
		<span class="group-name" title={name}>
			<span class="dot" style="background:{accent}"></span>
			{name}
		</span>
		{#if mixer}
			<button
				type="button"
				class="flag"
				class:is-on={mixer.mute}
				aria-pressed={mixer.mute}
				aria-label={`Mute ${name}`}
				title={`Mute ${name}`}
				onclick={() => updateTrackMixer(trackId, { mute: !mixer.mute })}
			>
				M
			</button>
			<button
				type="button"
				class="flag is-solo"
				class:is-on={mixer.solo}
				aria-pressed={mixer.solo}
				aria-label={`Solo ${name}`}
				title={`Solo ${name}`}
				onclick={() => updateTrackMixer(trackId, { solo: !mixer.solo })}
			>
				S
			</button>
		{/if}
		{#if available.length > 0}
			<select
				class="lane-select num"
				aria-label={`Parameter to automate on ${name}`}
				value={selectedTarget}
				onchange={(event) => (pendingTarget = (event.currentTarget as HTMLSelectElement).value)}
			>
				{#each available as parameter (parameter.key)}
					<option value={parameter.key}>{parameter.label}</option>
				{/each}
			</select>
			<button type="button" class="add-button" onclick={addLane}>Add lane</button>
		{:else}
			<span class="all-added">All parameters automated</span>
		{/if}
	</div>

	{#if lanes.length === 0}
		<p class="empty">
			No automation yet. Add a lane to draw volume, filter, or wavetable position over time.
		</p>
	{:else}
		<div class="lane-list" style="max-height:{region}px">
			{#each lanes as lane (lane.id)}
				<AutomationLaneRow
					{lane}
					{accent}
					height={lane.expanded === false ? COLLAPSED_HEIGHT : laneHeight}
					collapsed={lane.expanded === false}
					{width}
					{playhead}
					{startBeat}
					{pixelsPerBeat}
					{snapBeats}
					onaddPoint={(time, value) => addAutomationPoint(lane.id, time, value, trackId)}
					onmovePoint={(points: AutomationPoint[]) =>
						setLanePoints(lane.id, points, 'Move automation point', trackId)}
					onremovePoint={(pointId) => removeAutomationPoint(lane.id, pointId, trackId)}
					onToggleEnabled={(enabled) => setLaneEnabled(lane.id, enabled, trackId)}
					onToggleCollapsed={() => setLaneExpanded(lane.id, lane.expanded === false, trackId)}
					onRemove={() => removeAutomationLane(lane.id, trackId)}
				/>
			{/each}
		</div>
		<div
			class="group-resize"
			class:is-active={resizing}
			role="separator"
			aria-orientation="horizontal"
			aria-label={`Resize ${name} automation lanes`}
			title="Drag to resize lanes"
			onpointerdown={onResizeDown}
			onpointermove={onResizeMove}
			onpointerup={onResizeUp}
			onpointercancel={onResizeUp}
		></div>
	{/if}
</div>

<style>
	.group {
		border-bottom: 1px solid var(--color-line-0);
	}

	.group-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: 24px;
		padding: 0 var(--sp-3);
		background: var(--color-bg-1);
	}

	.group-name {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-2);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 2px;
		flex: none;
	}

	.lane-select {
		height: 20px;
		max-width: 150px;
		padding: 0 var(--sp-1);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-1);
		font-size: 11px;
	}

	.add-button {
		height: 20px;
		padding: 0 var(--sp-3);
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-1);
		font-size: 11px;
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out),
			transform 100ms var(--ease-out);
	}

	.add-button:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.add-button:active {
		transform: scale(0.97);
	}

	.all-added {
		font-size: 11px;
		color: var(--color-fg-3);
	}

	.flag {
		width: 18px;
		height: 18px;
		padding: 0;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-2);
		font-size: 10px;
		font-weight: 700;
		line-height: 1;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			border-color 120ms var(--ease-out);
	}

	.flag:hover {
		color: var(--color-fg-0);
	}

	.flag.is-on {
		background: color-mix(in oklab, var(--color-warn, #f2a33d) 45%, var(--color-bg-2));
		border-color: var(--color-warn, #f2a33d);
		color: var(--color-fg-0);
	}

	.flag.is-solo.is-on {
		background: color-mix(in oklab, var(--color-accent) 45%, var(--color-bg-2));
		border-color: var(--color-accent);
	}

	.empty {
		margin: 0;
		padding: var(--sp-2) var(--sp-3) var(--sp-3);
		font-size: 11px;
		color: var(--color-fg-2);
		max-width: 52ch;
	}

	.lane-list {
		overflow-y: auto;
		overflow-x: hidden;
	}

	.group-resize {
		position: relative;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
	}

	.group-resize::after {
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

	.group-resize:hover::after,
	.group-resize.is-active::after {
		background: var(--color-accent);
	}
</style>
