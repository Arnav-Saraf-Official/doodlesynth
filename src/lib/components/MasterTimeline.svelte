<script lang="ts">
	/**
	 * Master page: one shared timeline over a stack of automation lanes.
	 *
	 * The MASTER row sits on top and holds master-mix automation; every track
	 * gets its own row below, so a track's lines only ever automate that track.
	 * Lines are added through each row's own target dropdown.
	 */
	import { createTransform } from '#lib/editor/transform';
	import { MASTER_TRACK_ID, seek, session } from '#lib/state/session.svelte';
	import AutomationTrackGroup from './AutomationTrackGroup.svelte';
	import TimelineRuler from './TimelineRuler.svelte';

	interface Props {
		snapBeats?: number;
	}

	let { snapBeats = 0 }: Props = $props();

	/** matches the lane gutter in AutomationLane so the ruler lines up with the lanes */
	const GUTTER = 148;

	const transform = $derived(createTransform(session.viewport));
	const beatsPerBar = $derived(
		(session.project.timeSignature.numerator * 4) / session.project.timeSignature.denominator
	);
	const laneWidth = $derived(Math.max(64, session.viewport.width - GUTTER));

	const groups = $derived([
		{ id: MASTER_TRACK_ID, name: 'MASTER', accent: '#c58bf5' },
		...session.project.tracks.map((track) => ({
			id: track.id,
			name: track.name,
			accent: track.color
		}))
	]);
</script>

<div class="master-timeline">
	<div class="timeline-row">
		<div class="timeline-gutter"><span class="label">Timeline</span></div>
		<div class="ruler" style="width:{laneWidth}px">
			<TimelineRuler
				{transform}
				playhead={session.playhead}
				tempo={session.project.tempo}
				markers={session.project.markers}
				loop={session.project.loop}
				{beatsPerBar}
				width={laneWidth}
				height={26}
				onScrub={(beat) => seek(beat)}
			/>
		</div>
	</div>

	<div class="rows">
		{#each groups as group (group.id)}
			<AutomationTrackGroup
				trackId={group.id}
				name={group.name}
				accent={group.accent}
				width={session.viewport.width}
				startBeat={session.viewport.startBeat}
				pixelsPerBeat={session.viewport.pixelsPerBeat}
				playhead={session.playhead}
				{snapBeats}
			/>
		{/each}
	</div>
</div>

<style>
	.master-timeline {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: var(--color-bg-0);
	}

	.timeline-row {
		display: flex;
		flex: none;
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
	}

	.timeline-gutter {
		display: flex;
		align-items: center;
		width: 148px;
		flex: none;
		padding: 0 var(--sp-3);
		border-right: 1px solid var(--color-line-0);
	}

	.ruler {
		flex: none;
		overflow: hidden;
	}

	.rows {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
</style>
