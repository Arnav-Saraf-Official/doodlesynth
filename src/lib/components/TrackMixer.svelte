<script lang="ts">
	import { formatDb } from '#lib/model/pitch';
	import type { MixerState } from '#lib/model/types';
	import { updateTrackMixer } from '#lib/state/actions';
	import { MASTER_TRACK_ID, session } from '#lib/state/session.svelte';

	interface Props {
		trackId: string;
		accent: string;
		compact?: boolean;
		/** hide the M/S buttons where the surrounding chrome already provides them */
		showMuteSolo?: boolean;
	}

	let { trackId, accent, compact = false, showMuteSolo = true }: Props = $props();

	const mixer = $derived<MixerState>(
		trackId === MASTER_TRACK_ID
			? session.project.master.mixer
			: (session.project.tracks.find((track) => track.id === trackId)?.mixer ?? {
					volumeDb: 0,
					pan: 0,
					mute: false,
					solo: false
				})
	);

	const panLabel = $derived(
		mixer.pan === 0 ? 'C' : `${mixer.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(mixer.pan) * 100)}`
	);

	function patch(next: Partial<MixerState>) {
		updateTrackMixer(trackId, next);
	}
</script>

<div class="mixer" class:is-compact={compact} style="--track-accent: {accent}">
	{#if showMuteSolo}
		<div class="buttons">
			<button
				type="button"
				class="ms"
				class:is-on={mixer.mute}
				aria-pressed={mixer.mute}
				aria-label={`Mute ${mixer.mute ? 'on' : 'off'}`}
				title="Mute"
				onclick={() => patch({ mute: !mixer.mute })}
			>
				M
			</button>
			<button
				type="button"
				class="ms"
				class:is-solo={mixer.solo}
				aria-pressed={mixer.solo}
				aria-label={`Solo ${mixer.solo ? 'on' : 'off'}`}
				title="Solo"
				onclick={() => patch({ solo: !mixer.solo })}
			>
				S
			</button>
		</div>
	{/if}

	<label class="strip">
		<span class="strip-label">VOL</span>
		<input
			class="range"
			type="range"
			min="-60"
			max="6"
			step="0.5"
			value={String(mixer.volumeDb)}
			aria-label="Track volume in decibels"
			oninput={(event) => patch({ volumeDb: Number(event.currentTarget.value) })}
		/>
		<span class="num readout">{formatDb(mixer.volumeDb)}</span>
	</label>

	<label class="strip">
		<span class="strip-label">PAN</span>
		<input
			class="range"
			type="range"
			min="-1"
			max="1"
			step="0.01"
			value={String(mixer.pan)}
			aria-label="Track pan"
			oninput={(event) => patch({ pan: Number(event.currentTarget.value) })}
			ondblclick={() => patch({ pan: 0 })}
		/>
		<span class="num readout pan">{panLabel}</span>
	</label>
</div>

<style>
	.mixer {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: 0 var(--sp-2);
		height: 30px;
		border-left: 1px solid var(--color-line-0);
	}

	.is-compact {
		height: 26px;
		gap: var(--sp-2);
	}

	.buttons {
		display: flex;
		gap: 2px;
	}

	.ms {
		width: 20px;
		height: 20px;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-2);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			color 120ms var(--ease-out),
			border-color 120ms var(--ease-out),
			transform 100ms var(--ease-out);
	}

	.ms:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.ms:active {
		transform: scale(0.97);
	}

	/* state is carried by fill and border as well as colour */
	.ms.is-on {
		background: var(--color-danger);
		border-color: color-mix(in oklab, var(--color-danger) 60%, white);
		color: #14060a;
	}

	.ms.is-solo {
		background: var(--color-warn);
		border-color: color-mix(in oklab, var(--color-warn) 60%, white);
		color: #1a1103;
	}

	.strip {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		min-width: 0;
	}

	.strip-label {
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.07em;
		color: var(--color-fg-3);
	}

	.range {
		appearance: none;
		width: 84px;
		height: 16px;
		background: transparent;
		cursor: pointer;
		margin: 0;
	}

	.is-compact .range {
		width: 64px;
	}

	.range::-webkit-slider-runnable-track {
		height: 3px;
		border-radius: 2px;
		background: var(--color-line-1);
	}

	.range::-moz-range-track {
		height: 3px;
		border-radius: 2px;
		background: var(--color-line-1);
	}

	.range::-webkit-slider-thumb {
		appearance: none;
		width: 10px;
		height: 10px;
		margin-top: -3.5px;
		border-radius: 50%;
		/* the thumb carries the track's identity accent */
		background: var(--track-accent, var(--color-fg-0));
		border: 1px solid var(--color-bg-0);
		transition: transform 120ms var(--ease-out);
	}

	.range::-moz-range-thumb {
		width: 10px;
		height: 10px;
		border: 1px solid var(--color-bg-0);
		border-radius: 50%;
		background: var(--track-accent, var(--color-fg-0));
	}

	.range:active::-webkit-slider-thumb {
		transform: scale(1.15);
	}

	.readout {
		color: var(--color-fg-1);
		min-width: 46px;
		text-align: right;
	}

	.pan {
		min-width: 26px;
	}
</style>
