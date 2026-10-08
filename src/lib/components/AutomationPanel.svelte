<script lang="ts">
	import { parametersForScope } from '#lib/model/parameters';
	import type { AutomationLane, AutomationPoint } from '#lib/model/types';
	import {
		addAutomationLane,
		addAutomationPoint,
		removeAutomationLane,
		removeAutomationPoint,
		setLaneEnabled,
		setLaneExpanded,
		setLanePoints
	} from '#lib/state/actions';
	import { MASTER_TRACK_ID, session } from '#lib/state/session.svelte';
	import AutomationLaneRow from './AutomationLane.svelte';

	interface Props {
		trackId: string;
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
		accent,
		width,
		startBeat,
		pixelsPerBeat,
		playhead,
		snapBeats = 0,
		height = 44
	}: Props = $props();

	let expanded = $state(true);
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

	function addLane() {
		if (!selectedTarget) return;
		addAutomationLane(selectedTarget, trackId);
		pendingTarget = '';
		expanded = true;
	}

	function handleAddPoint(laneId: string, time: number, value: number) {
		addAutomationPoint(laneId, time, value, trackId);
	}

	function handleMovePoints(laneId: string, points: AutomationPoint[]) {
		setLanePoints(laneId, points, 'Move automation point', trackId);
	}
</script>

<section class="automation" style="width:{width}px">
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
			<span class="count">{lanes.length}</span>
		</button>

		{#if expanded}
			<div class="head-actions">
				{#if available.length > 0}
					<select
						class="lane-select num"
						aria-label="Parameter to automate"
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
		{/if}
	</header>

	{#if expanded}
		{#if lanes.length === 0}
			<p class="empty">
				No automation yet. Add a lane to draw volume, filter, or wavetable position over time.
			</p>
		{:else}
			<div class="lane-list">
				{#each lanes as lane (lane.id)}
					<AutomationLaneRow
						{lane}
						{accent}
						height={lane.expanded === false ? 20 : height}
						collapsed={lane.expanded === false}
						{width}
						{playhead}
						{startBeat}
						{pixelsPerBeat}
						{snapBeats}
						onaddPoint={(time, value) => handleAddPoint(lane.id, time, value)}
						onmovePoint={(points) => handleMovePoints(lane.id, points)}
						onremovePoint={(pointId) => removeAutomationPoint(lane.id, pointId, trackId)}
						onToggleEnabled={(enabled) => setLaneEnabled(lane.id, enabled, trackId)}
						onToggleCollapsed={() => setLaneExpanded(lane.id, lane.expanded === false, trackId)}
						onRemove={() => removeAutomationLane(lane.id, trackId)}
					/>
				{/each}
			</div>
		{/if}
	{/if}
</section>

<style>
	.automation {
		border-top: 1px solid var(--color-line-0);
		background: var(--color-bg-0);
		flex: none;
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

	.empty {
		margin: 0;
		padding: var(--sp-3) var(--sp-3) var(--sp-4);
		font-size: 11px;
		color: var(--color-fg-2);
		max-width: 52ch;
	}
</style>
