<script lang="ts">
	import { formatTimecode } from '#lib/model/pitch';
	import { setLoop } from '#lib/state/actions';
	import {
		currentSeconds,
		seek,
		session,
		setTempo,
		setTimeSignature,
		stopTransport,
		toggleTransport
	} from '#lib/state/session.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';

	const timecode = $derived(formatTimecode(currentSeconds()));

	function onTempo(value: number) {
		setTempo(value);
	}
</script>

<div class="transport">
	<div class="buttons" role="group" aria-label="Transport">
		<IconButton
			label={session.playing ? 'Pause' : 'Play'}
			active={session.playing}
			onclick={toggleTransport}
		>
			{#if session.playing}
				<svg viewBox="0 0 10 12" aria-hidden="true" width="10" height="12">
					<rect x="0" y="0" width="3.4" height="12" fill="currentColor" />
					<rect x="6.6" y="0" width="3.4" height="12" fill="currentColor" />
				</svg>
			{:else}
				<svg viewBox="0 0 10 12" aria-hidden="true" width="10" height="12">
					<path d="M0 0l10 6-10 6z" fill="currentColor" />
				</svg>
			{/if}
		</IconButton>
		<IconButton
			label="Stop and return to loop start"
			onclick={() => {
				stopTransport();
				seek(session.loopEnabled ? session.project.loop.start : 0);
			}}
		>
			<svg viewBox="0 0 10 10" aria-hidden="true" width="10" height="10">
				<rect x="0" y="0" width="10" height="10" fill="currentColor" />
			</svg>
		</IconButton>
		<IconButton
			label="Loop region"
			active={session.loopEnabled}
			onclick={() => {
				session.loopEnabled = !session.loopEnabled;
				setLoop({ enabled: session.loopEnabled });
			}}
		>
			<svg viewBox="0 0 14 12" aria-hidden="true" width="14" height="12">
				<path
					d="M3 2h6a2.5 2.5 0 0 1 0 5H5a2.5 2.5 0 0 0 0 5h6"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			</svg>
		</IconButton>
	</div>

	<div class="readout">
		<span class="time num">{timecode}</span>
		<span class="beats num">{session.playhead.toFixed(3)} bt</span>
	</div>

	<div class="tempo">
		<NumberField
			label="BPM"
			value={session.project.tempo}
			min={20}
			max={400}
			step={1}
			decimals={1}
			width="76px"
			onchange={onTempo}
		/>
		<div class="signature">
			<span class="signature-label">Time</span>
			<div class="signature-fields">
				<NumberField
					label=""
					value={session.project.timeSignature.numerator}
					min={1}
					max={32}
					step={1}
					decimals={0}
					width="52px"
					onchange={(value) =>
						setTimeSignature(Math.round(value), session.project.timeSignature.denominator)}
				/>
				<span class="slash">/</span>
				<NumberField
					label=""
					value={session.project.timeSignature.denominator}
					min={1}
					max={32}
					step={1}
					decimals={0}
					width="52px"
					onchange={(value) =>
						setTimeSignature(session.project.timeSignature.numerator, Math.round(value))}
				/>
			</div>
		</div>
	</div>
</div>

<style>
	.transport {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
	}

	.buttons {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
	}

	.readout {
		display: flex;
		flex-direction: column;
		line-height: 1.2;
		min-width: 92px;
	}

	.time {
		font-size: 13px;
		color: var(--color-fg-0);
	}

	.beats {
		font-size: 10px;
		color: var(--color-fg-2);
	}

	.tempo {
		display: flex;
		align-items: flex-end;
		gap: var(--sp-3);
	}

	.signature {
		display: flex;
		flex-direction: column;
	}

	.signature-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-2);
		margin-bottom: 2px;
	}

	.signature-fields {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.slash {
		color: var(--color-fg-2);
		font-size: 11px;
	}
</style>
