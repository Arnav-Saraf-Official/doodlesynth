<script lang="ts">
	import Panel from '#lib/ui/Panel.svelte';
	import { shortcutsByGroup } from '#lib/ui/shortcuts';

	const groups = shortcutsByGroup();

	const concepts = [
		{
			title: 'A voice is a curve, not a note',
			body: 'The primitive is a voice path: a piecewise curve through editable control points. Time runs across, frequency runs up, and the curve can pass through any frequency in range. Nothing forces you onto a semitone.'
		},
		{
			title: 'Beats, never seconds',
			body: 'Positions are stored in beats. Tempo converts beats to seconds at play time, so changing the tempo changes how long the music lasts without moving a single point.'
		},
		{
			title: 'Hz, never MIDI note numbers',
			body: 'Pitch is stored as a frequency in hertz. Note names, cents and scale degrees are derived for display and snapping. Drawing between C5 and C#5 can settle on 552.17 Hz with no resistance.'
		},
		{
			title: 'Piano Map vs Frequency Map',
			body: 'Piano Map is the composition view: octave bands, note lanes, active scale degrees, root emphasis. Frequency Map is the precision view: raw Hz labels with a logarithmic or linear-Hz projection and an optional reference-only piano overlay. Both project the same continuous data, so switching maps never changes a curve.'
		},
		{
			title: 'Static JI vs Dynamic JI',
			body: 'In Static JI every scale degree resolves to a rational interval from the master root, so 5/4 is always a major third above it. In Dynamic JI the same ratios attach to an explicit intonation anchor instead, so when the harmonic context moves the ratio targets move with it while an absolute-Hz voice stays exactly where it was drawn.'
		},
		{
			title: 'Absolute Hz vs scale-relative',
			body: 'A track is either literal or scale-relative. Absolute-Hz points are never rewritten by root, scale or tuning changes. Scale-relative points remember their degree, octave and cent offset, so they re-resolve when the Musical State changes.'
		},
		{
			title: 'Snapping only decides where a gesture lands',
			body: 'Snap never rewrites existing curve data, and moving the playhead across a scale-change keyframe never retunes anything. Only the explicit Retune to Current Scale command rewrites scale-relative pitches.'
		},
		{
			title: 'Undo is per edit',
			body: 'Every operation is a command with an undo and a redo, and a continuous drag commits once on release rather than once per pointer move. Undo is available for essentially every editing operation.'
		}
	];
</script>

<svelte:head><title>Help — Doodlesynth</title></svelte:head>

<div class="page">
	<header class="topbar">
		<div class="topbar-inner">
			<a class="brand" href="/">Doodlesynth</a>
			<nav aria-label="Primary">
				<a href="/">Editor</a>
				<a href="/wavetables">Wavetables</a>
				<a href="/tuning">Tuning</a>
				<a href="/settings">Settings</a>
				<a class="is-current" href="/help" aria-current="page">Help</a>
			</nav>
		</div>
	</header>

	<main>
		<div class="content">
			<header class="hero">
				<p class="label">Reference</p>
				<h1>Help</h1>
				<p class="blurb">
					Doodlesynth draws continuous pitch curves instead of entering MIDI notes. Below are the
					keys the editor listens for, the vocabulary it uses, and where each surface lives.
				</p>
			</header>

			<Panel title="Shortcuts">
				<div class="groups">
					{#each groups as group (group.group)}
						<section class="group">
							<h3 class="label">{group.group}</h3>
							<dl>
								{#each group.items as shortcut (shortcut.id)}
									<div class="shortcut">
										<dt><kbd class="num">{shortcut.label}</kbd></dt>
										<dd>{shortcut.description}</dd>
									</div>
								{/each}
							</dl>
						</section>
					{/each}
				</div>
				<p class="note">
					Modifier conventions in the editor: hold Ctrl / Cmd to bypass snapping for one gesture,
					Shift to constrain movement, and Alt / Option for fine adjustment. Arrow keys nudge the
					selected points; Shift makes the nudge larger and Alt makes it finer.
				</p>
			</Panel>

			<Panel title="Concepts">
				<dl class="concepts">
					{#each concepts as concept (concept.title)}
						<div class="concept">
							<dt>{concept.title}</dt>
							<dd>{concept.body}</dd>
						</div>
					{/each}
				</dl>
			</Panel>

			<Panel title="Where things live" open={false}>
				<dl class="concepts">
					<div class="concept">
						<dt>Master track</dt>
						<dd>
							The Musical State lane holds the root, scale, tuning, reference and snap policy
							keyframes. Below it, ordinary automation lanes hold volume, filter, resonance,
							wavetable position and other registry parameters.
						</dd>
					</div>
					<div class="concept">
						<dt>Tuning</dt>
						<dd>
							The <a href="/tuning">Tuning</a> page sets the tuning mode, the base note every ratio attaches
							to and dynamic re-anchoring for the current chord, plus the exact rational interval of each
							note and every resolved target with its 12-TET reference and cent deviation.
						</dd>
					</div>
					<div class="concept">
						<dt>Wavetables</dt>
						<dd>
							The <a href="/wavetables">Wavetables</a> page authors tables frame by frame, either by drawing
							a waveform shape or by building an additive spectrum column by column. Both modes edit the
							same asset, and a track's wavetable position automates which frame the oscillator reads.
						</dd>
					</div>
					<div class="concept">
						<dt>Local only</dt>
						<dd>
							There is no account and no server. Projects autosave into this browser's storage; the <a
								href="/settings">Settings</a
							> page lists saved projects and can save or open them explicitly.
						</dd>
					</div>
				</dl>
			</Panel>

			<footer class="credits">
				<p>
					Copyright 2026 Doodlesynth -
					<a href="https://arnavsaraf.pages.dev" target="_blank" rel="noopener noreferrer"
						>Arnav Saraf</a
					>
				</p>
			</footer>
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

	/* the chrome lines up with the content column so the page reads as one grid */
	.topbar-inner {
		display: flex;
		align-items: center;
		gap: var(--sp-5);
		width: 100%;
		max-width: 920px;
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

	/* one centered column with real gutters, so nothing hugs the viewport edge */
	.content {
		display: flex;
		flex-direction: column;
		gap: var(--sp-4);
		width: 100%;
		max-width: 920px;
		margin: 0 auto;
		padding: var(--sp-5) var(--sp-5) var(--sp-6);
	}

	.hero {
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-2) 0 var(--sp-3);
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
		max-width: 68ch;
		font-size: 13px;
		line-height: 1.55;
		color: var(--color-fg-1);
	}

	/* panels read as cards on this reference page */
	main :global(.panel) {
		background: var(--color-bg-1);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-3);
		overflow: hidden;
	}

	main :global(.panel-body) {
		padding: var(--sp-2) var(--sp-4) var(--sp-4);
	}

	main :global(.panel header) {
		padding: 0 var(--sp-4) 0 var(--sp-3);
	}

	.groups {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: var(--sp-4) var(--sp-5);
	}

	.group h3 {
		margin: 0 0 var(--sp-2);
	}

	dl {
		margin: 0;
	}

	.shortcut {
		display: grid;
		grid-template-columns: 84px minmax(0, 1fr);
		gap: var(--sp-3);
		align-items: baseline;
		padding: 3px 0;
		border-bottom: 1px solid var(--color-line-0);
	}

	.shortcut:last-child {
		border-bottom: none;
	}

	kbd {
		display: inline-block;
		min-width: 30px;
		padding: 2px 6px;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-1);
		background: var(--color-bg-2);
		color: var(--color-fg-0);
		font-size: 10.5px;
		text-align: center;
		box-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
	}

	dd {
		margin: 0;
		font-size: 11.5px;
		color: var(--color-fg-1);
	}

	.concepts {
		max-width: 82ch;
	}

	.concept {
		padding: var(--sp-3) 0;
		border-bottom: 1px solid var(--color-line-0);
	}

	.concept:first-child {
		padding-top: var(--sp-1);
	}

	.concept:last-child {
		padding-bottom: 0;
		border-bottom: none;
	}

	.concept dt {
		font-size: 12px;
		font-weight: 600;
		color: var(--color-fg-0);
		margin-bottom: 3px;
	}

	.concept dd {
		font-size: 12px;
		line-height: 1.6;
		color: var(--color-fg-1);
	}

	.concept a {
		color: var(--color-accent);
		text-decoration: none;
		border-bottom: 1px solid color-mix(in oklab, var(--color-accent) 45%, transparent);
	}

	.concept a:hover {
		color: var(--color-fg-0);
	}

	.note {
		margin: var(--sp-4) 0 0;
		padding-top: var(--sp-3);
		border-top: 1px solid var(--color-line-0);
		font-size: 11px;
		line-height: 1.55;
		color: var(--color-fg-2);
		max-width: 82ch;
	}

	.credits {
		padding-top: var(--sp-1);
	}

	.credits p {
		margin: 0;
		font-size: 11px;
		letter-spacing: 0.01em;
		color: var(--color-fg-3);
	}

	.credits a {
		color: var(--color-accent);
		text-decoration: none;
		border-bottom: 1px solid color-mix(in oklab, var(--color-accent) 45%, transparent);
	}

	.credits a:hover {
		color: var(--color-fg-0);
	}

	@media (max-width: 720px) {
		.topbar-inner {
			padding: 0 var(--sp-3);
		}

		.content {
			padding: var(--sp-4) var(--sp-3) var(--sp-5);
		}

		.hero h1 {
			font-size: 22px;
		}
	}
</style>
