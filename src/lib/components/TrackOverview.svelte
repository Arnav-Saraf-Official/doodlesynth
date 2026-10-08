<script lang="ts">
	import type { WaveSource } from '#lib/model/types';
	import { addTrack, removeTrack, updateTrackMixer } from '#lib/state/actions';
	import { selectTrack, session } from '#lib/state/session.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';

	const WAVE_LABELS: Record<WaveSource, string> = {
		sine: 'Sine',
		triangle: 'Triangle',
		saw: 'Saw',
		square: 'Square',
		pulse: 'Pulse',
		'white-noise': 'White',
		wavetable: 'Table'
	};

	const rows = $derived(
		session.project.tracks.map((track) => ({
			id: track.id,
			name: track.name,
			color: track.color,
			wave: WAVE_LABELS[track.synth.wave],
			curves: track.curves.length,
			points: track.curves.reduce((sum, curve) => sum + curve.points.length, 0),
			volumeDb: track.mixer.volumeDb,
			pan: track.mixer.pan,
			mute: track.mixer.mute,
			solo: track.mixer.solo
		}))
	);

	function panLabel(pan: number): string {
		if (Math.abs(pan) < 0.01) return 'C';
		return pan < 0 ? `L${Math.round(-pan * 100)}` : `R${Math.round(pan * 100)}`;
	}
</script>

<section class="overview" aria-label="Tracks">
	<header class="head">
		<span class="label">Tracks</span>
		<span class="count num">{rows.length}</span>
		<div class="spacer"></div>
		<IconButton label="Add track" size="sm" onclick={() => addTrack(`Track ${rows.length + 1}`)}>
			<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
				<path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.4" fill="none" />
			</svg>
			<span>Track</span>
		</IconButton>
	</header>

	{#if rows.length === 0}
		<p class="empty">No tracks yet. Add one, then open it to draw a voice path.</p>
	{:else}
		<ul class="list">
			{#each rows as row (row.id)}
				<li class="row" class:is-muted={row.mute}>
					<button
						type="button"
						class="row-main"
						onclick={() => selectTrack(row.id)}
						aria-label={`Open ${row.name}`}
					>
						<span class="dot" style="background:{row.color}" aria-hidden="true"></span>
						<span class="name">{row.name}</span>
						<span class="meta num">{row.wave}</span>
						<span class="meta num">
							{row.curves}
							{row.curves === 1 ? 'curve' : 'curves'} · {row.points} pts
						</span>
					</button>
					<div class="values num">
						<span>{row.volumeDb >= 0 ? '+' : '−'}{Math.abs(row.volumeDb).toFixed(1)} dB</span>
						<span>{panLabel(row.pan)}</span>
					</div>
					<div class="flags">
						<button
							type="button"
							class="flag"
							class:is-on={row.mute}
							aria-pressed={row.mute}
							aria-label={`Mute ${row.name}`}
							title={`Mute ${row.name}`}
							onclick={() => updateTrackMixer(row.id, { mute: !row.mute })}
						>
							M
						</button>
						<button
							type="button"
							class="flag"
							class:is-solo={row.solo}
							aria-pressed={row.solo}
							aria-label={`Solo ${row.name}`}
							title={`Solo ${row.name}`}
							onclick={() => updateTrackMixer(row.id, { solo: !row.solo })}
						>
							S
						</button>
						<button
							type="button"
							class="close"
							aria-label={`Delete ${row.name}`}
							title={`Delete ${row.name}`}
							onclick={() => removeTrack(row.id)}
						>
							<svg viewBox="0 0 8 8" width="8" height="8" aria-hidden="true">
								<path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" stroke-width="1.3" fill="none" />
							</svg>
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.overview {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		background: var(--color-bg-0);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-3) var(--sp-4);
		border-bottom: 1px solid var(--color-line-0);
	}

	.count {
		font-size: 10px;
		color: var(--color-fg-3);
	}

	.spacer {
		flex: 1;
	}

	.empty {
		padding: var(--sp-5) var(--sp-4);
		font-size: 13px;
		color: var(--color-fg-2);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: var(--sp-2);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: 0 var(--sp-2) 0 0;
		border: 1px solid transparent;
		border-radius: var(--r-2);
		background: var(--color-bg-1);
		transition:
			background-color 130ms var(--ease-out),
			border-color 130ms var(--ease-out);
	}

	.row:hover {
		background: var(--color-bg-2);
		border-color: var(--color-line-1);
	}

	.row.is-muted .name {
		color: var(--color-fg-3);
		text-decoration: line-through;
	}

	.row-main {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		flex: 1;
		min-width: 0;
		height: 34px;
		padding-left: var(--sp-3);
		border: none;
		background: none;
		color: var(--color-fg-0);
		cursor: pointer;
		text-align: left;
	}

	.dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		flex: none;
	}

	.name {
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: color 130ms var(--ease-out);
	}

	.meta {
		font-size: 10px;
		color: var(--color-fg-3);
		white-space: nowrap;
	}

	.values {
		display: flex;
		gap: var(--sp-3);
		font-size: 10px;
		color: var(--color-fg-2);
	}

	.flags {
		display: flex;
		align-items: center;
		gap: 1px;
	}

	.flag {
		width: 20px;
		height: 20px;
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
		width: 20px;
		height: 20px;
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

	.row:hover .close,
	.row:focus-within .close {
		opacity: 1;
	}

	.close:hover {
		color: var(--color-danger);
	}
</style>
