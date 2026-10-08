<script lang="ts">
	import type { WaveSource } from '#lib/model/types';
	import { addTrack, removeTrack, updateTrackMixer } from '#lib/state/actions';
	import {
		MASTER_TRACK_ID,
		isMasterSelected,
		selectTrack,
		session
	} from '#lib/state/session.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';

	let creating = $state(false);
	let draftName = $state('');
	let draftWave = $state<WaveSource>('saw');

	const WAVE_LABELS: Record<WaveSource, string> = {
		sine: 'Sine',
		triangle: 'Triangle',
		saw: 'Saw',
		square: 'Square',
		pulse: 'Pulse',
		'white-noise': 'White',
		wavetable: 'Table'
	};

	const tabs = $derived([
		{
			id: MASTER_TRACK_ID,
			name: 'Master',
			color: 'var(--color-fg-1)',
			wave: null as WaveSource | null,
			mute: session.project.master.mixer.mute,
			solo: false
		},
		...session.project.tracks.map((track) => ({
			id: track.id,
			name: track.name,
			color: track.color,
			wave: track.synth.wave,
			mute: track.mixer.mute,
			solo: track.mixer.solo
		}))
	]);

	function commitCreate() {
		const name = draftName.trim() || `Track ${session.project.tracks.length + 1}`;
		addTrack(name, draftWave);
		creating = false;
		draftName = '';
	}

	function cancelCreate() {
		creating = false;
		draftName = '';
	}
</script>

<div class="tabs" role="tablist" aria-label="Tracks">
	{#each tabs as tab (tab.id)}
		<div class="tab" class:is-active={session.selectedTrackId === tab.id}>
			<button
				type="button"
				class="tab-main"
				role="tab"
				aria-selected={session.selectedTrackId === tab.id}
				onclick={() => selectTrack(tab.id)}
				onkeydown={(event) => {
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						selectTrack(tab.id);
					}
				}}
			>
				<span class="dot" style="background:{tab.color}" aria-hidden="true"></span>
				<span class="name">{tab.name}</span>
				{#if tab.wave}
					<span class="wave num">{WAVE_LABELS[tab.wave]}</span>
				{/if}
			</button>

			{#if tab.id !== MASTER_TRACK_ID}
				<div class="flags">
					<button
						type="button"
						class="flag"
						class:is-on={tab.mute}
						aria-pressed={tab.mute}
						aria-label={`Mute ${tab.name}`}
						title={`Mute ${tab.name}`}
						onclick={() => updateTrackMixer(tab.id, { mute: !tab.mute })}
					>
						M
					</button>
					<button
						type="button"
						class="flag"
						class:is-solo={tab.solo}
						aria-pressed={tab.solo}
						aria-label={`Solo ${tab.name}`}
						title={`Solo ${tab.name}`}
						onclick={() => updateTrackMixer(tab.id, { solo: !tab.solo })}
					>
						S
					</button>
					<button
						type="button"
						class="close"
						aria-label={`Delete ${tab.name}`}
						title={`Delete ${tab.name}`}
						onclick={() => removeTrack(tab.id)}
					>
						<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
							<path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.3" fill="none" />
						</svg>
					</button>
				</div>
			{/if}
		</div>
	{/each}

	<div class="add">
		{#if creating}
			<div class="create" role="dialog" aria-label="New track">
				<input
					class="create-name num"
					placeholder="Lead"
					aria-label="Track name"
					bind:value={draftName}
					onkeydown={(event) => {
						if (event.key === 'Enter') commitCreate();
						if (event.key === 'Escape') cancelCreate();
					}}
				/>
				<select class="create-wave num" aria-label="Waveform" bind:value={draftWave}>
					<option value="sine">Sine</option>
					<option value="triangle">Triangle</option>
					<option value="saw">Saw</option>
					<option value="square">Square</option>
					<option value="pulse">Pulse</option>
					<option value="white-noise">White</option>
				</select>
				<IconButton label="Create track" variant="solid" size="sm" onclick={commitCreate}>
					Create
				</IconButton>
				<IconButton label="Cancel" size="sm" onclick={cancelCreate}>Cancel</IconButton>
			</div>
		{:else}
			<IconButton
				label="New track"
				onclick={() => {
					creating = true;
					draftName = `Track ${session.project.tracks.length + 1}`;
				}}
			>
				<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
					<path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.4" fill="none" />
				</svg>
				<span>Track</span>
			</IconButton>
		{/if}
	</div>

	<div class="spacer"></div>

	<div class="summary num">
		{isMasterSelected() ? 'MASTER' : 'TRACK'} · {session.project.tracks.length} tracks · {session
			.project.tempo} BPM
	</div>
</div>

<style>
	.tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		height: var(--h-tabs);
		padding: 0 var(--sp-2);
		background: var(--color-bg-1);
		border-top: 1px solid var(--color-line-0);
		overflow-x: auto;
		overflow-y: hidden;
	}

	.tab {
		display: flex;
		align-items: center;
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: var(--r-2) var(--r-2) 0 0;
		background: var(--color-bg-0);
		transition:
			background-color 130ms var(--ease-out),
			border-color 130ms var(--ease-out);
	}

	.tab:hover {
		background: var(--color-bg-2);
	}

	.tab.is-active {
		background: var(--color-bg-2);
		border-color: var(--color-line-1);
	}

	.tab-main {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		height: 100%;
		padding: 0 var(--sp-3);
		border: none;
		background: none;
		color: var(--color-fg-2);
		cursor: pointer;
		transition: color 130ms var(--ease-out);
	}

	.tab.is-active .tab-main {
		color: var(--color-fg-0);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}

	.name {
		font-size: 12px;
		max-width: 132px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.wave {
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--color-fg-3);
	}

	.flags {
		display: flex;
		align-items: center;
		gap: 1px;
		padding-right: var(--sp-2);
	}

	.flag {
		width: 18px;
		height: 18px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-3);
		font-size: 9px;
		font-weight: 700;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.flag:active {
		transform: scale(0.94);
	}

	.flag.is-on {
		background: color-mix(in oklab, var(--color-danger) 30%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-danger) 55%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.flag.is-solo {
		background: color-mix(in oklab, var(--color-warn) 30%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-warn) 55%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.close {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border: none;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-3);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 130ms var(--ease-out),
			color 130ms var(--ease-out);
	}

	.tab:hover .close,
	.tab:focus-within .close {
		opacity: 1;
	}

	.close:hover {
		color: var(--color-danger);
	}

	.add {
		display: flex;
		align-items: center;
		padding: 0 var(--sp-2);
	}

	.create {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
	}

	.create input,
	.create select {
		height: 24px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-0);
		padding: 0 var(--sp-2);
		font-size: 12px;
	}

	.create-name {
		width: 120px;
	}

	.spacer {
		flex: 1;
	}

	.summary {
		display: flex;
		align-items: center;
		padding-right: var(--sp-2);
		font-size: 10px;
		color: var(--color-fg-3);
		white-space: nowrap;
	}
</style>
