<script lang="ts">
	import Field from '#lib/ui/Field.svelte';
	import IconButton from '#lib/ui/IconButton.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';
	import Panel from '#lib/ui/Panel.svelte';
	import Select from '#lib/ui/Select.svelte';
	import { session } from '#lib/state/session.svelte';
	import {
		addScale,
		deleteScale,
		updateMusicalStateKeyframe,
		updateScale
	} from '#lib/state/actions';
	import {
		approximateRatioForCents,
		createEditableScale,
		degreeIntervalCents,
		findScale,
		scaleUsesRatios
	} from '#lib/model/scale';
	import { JI_ANCHOR_LABELS, TUNING_MODE_LABELS, resolveTargets } from '#lib/model/tuning';
	import { resolveMusicalState } from '#lib/model/musicalState';
	import {
		NOTE_NAMES,
		clamp,
		formatCents,
		formatHz,
		ratioToCents,
		reduceRatio
	} from '#lib/model/pitch';
	import type {
		JIAnchorMode,
		ScaleDefinition,
		ScaleDegree,
		TuningDefinition,
		TuningMode
	} from '#lib/model/types';

	let selectedId = $state<string | null>(null);
	/** degree keys whose rational ratio came from approximation, not exact editing */
	let approxErrors = $state<Record<string, number>>({});

	const scales = $derived(session.project.scales);
	const scale = $derived(findScale(scales, selectedId ?? scales[0]?.id ?? ''));
	const masterState = $derived(resolveMusicalState(session.project, 0));
	const firstKeyframe = $derived(session.project.master.musicalState[0] ?? null);
	const tuning = $derived<TuningDefinition>(masterState.tuning);
	const usesRatios = $derived(scaleUsesRatios(tuning));
	const targets = $derived(
		resolveTargets(tuning, scale, masterState.rootPitchClass, {
			minFrequencyHz: session.project.editorSettings.minFrequencyHz,
			maxFrequencyHz: session.project.editorSettings.maxFrequencyHz
		}).slice(0, 72)
	);
	const enabledCount = $derived(scale.degrees.filter((degree) => degree.enabled).length);

	const tuningModes = $derived(
		(Object.keys(TUNING_MODE_LABELS) as TuningMode[]).map((mode) => ({
			value: mode,
			label: TUNING_MODE_LABELS[mode]
		}))
	);
	const anchors = $derived(
		Object.keys(JI_ANCHOR_LABELS).map((anchor) => ({
			value: anchor,
			label: JI_ANCHOR_LABELS[anchor]
		}))
	);
	const roots = $derived(NOTE_NAMES.map((name, index) => ({ value: String(index), label: name })));

	function degreeKey(index: number): string {
		return `${scale.id}:${index}`;
	}

	function patchTuning(patch: Partial<TuningDefinition>) {
		const frame = firstKeyframe;
		if (!frame) return;
		updateMusicalStateKeyframe(frame.id, {
			state: { ...frame.state, tuning: { ...frame.state.tuning, ...patch } }
		});
	}

	/** The base note every ratio in the table is measured from. */
	function patchRoot(rootPitchClass: number) {
		const frame = firstKeyframe;
		if (!frame) return;
		updateMusicalStateKeyframe(frame.id, {
			state: { ...frame.state, rootPitchClass }
		});
	}

	function updateDegree(index: number, patch: Partial<ScaleDegree>) {
		updateScale(scale.id, {
			degrees: scale.degrees.map((degree, i) => (i === index ? { ...degree, ...patch } : degree))
		});
	}

	function renumber(degrees: ScaleDegree[]): ScaleDegree[] {
		return degrees.map((degree, index) => ({ ...degree, degree: index }));
	}

	function setRatio(index: number, numerator: number, denominator: number) {
		const key = degreeKey(index);
		try {
			const reduced = reduceRatio(numerator, denominator);
			if (approxErrors[key] !== undefined) {
				const next = { ...approxErrors };
				delete next[key];
				approxErrors = next;
			}
			updateDegree(index, {
				ratio: reduced,
				cents: Math.round(ratioToCents(reduced.numerator, reduced.denominator) * 1000) / 1000
			});
		} catch {
			// non-positive or non-finite terms are rejected; the field keeps its value
		}
	}

	function applyApproximation(index: number) {
		const key = degreeKey(index);
		const degree = scale.degrees[index];
		if (!degree) return;
		const { ratio, centsError } = approximateRatioForCents(degreeIntervalCents(degree), 64);
		approxErrors = { ...approxErrors, [key]: centsError };
		updateDegree(index, {
			ratio,
			cents: Math.round(ratioToCents(ratio.numerator, ratio.denominator) * 1000) / 1000
		});
	}

	function addDegree() {
		const last = scale.degrees[scale.degrees.length - 1];
		const cents = Math.min((last ? degreeIntervalCents(last) : 0) + 100, 1200);
		updateScale(scale.id, {
			degrees: [
				...scale.degrees,
				{ degree: scale.degrees.length, label: `${scale.degrees.length + 1}`, cents, enabled: true }
			]
		});
	}

	function removeDegree(index: number) {
		if (scale.degrees.length <= 2) return;
		updateScale(scale.id, { degrees: renumber(scale.degrees.filter((_, i) => i !== index)) });
	}

	function newScale() {
		const created = createEditableScale('New Scale', 0);
		addScale(created);
		selectedId = created.id;
	}

	function duplicateScale() {
		const copy: ScaleDefinition = {
			...scale,
			id: `scale_${Math.random().toString(36).slice(2, 9)}`,
			name: `${scale.name} copy`,
			builtIn: false,
			degrees: scale.degrees.map((degree) => ({
				...degree,
				ratio: degree.ratio ? { ...degree.ratio } : undefined
			}))
		};
		addScale(copy);
		selectedId = copy.id;
	}

	function removeScale() {
		if (scale.builtIn) return;
		deleteScale(scale.id);
		selectedId = null;
	}

	function numberFrom(event: Event): number {
		return Number((event.currentTarget as HTMLInputElement).value);
	}
</script>

<svelte:head><title>Tuning — Doodlesynth</title></svelte:head>

<div class="page">
	<header class="topbar">
		<a class="brand" href="/">Doodlesynth</a>
		<nav>
			<a href="/">Editor</a>
			<a href="/projects">Projects</a>
			<a href="/wavetables">Wavetables</a>
			<a class="is-current" href="/tuning">Tuning</a>
			<a href="/settings">Settings</a>
			<a href="/help">Help</a>
		</nav>
	</header>

	<main>
		<aside class="sidebar">
			<div class="sidebar-head">
				<span class="label">Scale library</span>
				<div class="sidebar-actions">
					<IconButton label="New scale" size="sm" onclick={newScale}>+</IconButton>
					<IconButton label="Duplicate scale" size="sm" onclick={duplicateScale}>⧉</IconButton>
					<IconButton
						label="Delete scale"
						size="sm"
						variant="danger"
						disabled={scale.builtIn}
						onclick={removeScale}
					>
						×
					</IconButton>
				</div>
			</div>
			<ul class="scale-list">
				{#each scales as entry (entry.id)}
					<li>
						<button
							type="button"
							class="scale-row"
							class:is-selected={entry.id === scale.id}
							aria-current={entry.id === scale.id}
							onclick={() => (selectedId = entry.id)}
						>
							<span class="scale-name">{entry.name}</span>
							<span class="scale-meta num">
								{entry.degrees.filter((degree) => degree.enabled).length} deg
								{#if entry.builtIn}<em class="badge">built-in</em>{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		</aside>

		<section class="content">
			<Panel title="Tuning">
				<div class="row-3">
					<Select
						label="Mode"
						ariaLabel="Tuning mode"
						value={tuning.mode}
						options={tuningModes}
						onchange={(value) => patchTuning({ mode: value as TuningMode })}
					/>
					<NumberField
						label="Reference"
						value={tuning.referenceFrequencyHz}
						min={100}
						max={1000}
						step={1}
						decimals={2}
						unit="Hz"
						width="88px"
						onchange={(value) => patchTuning({ referenceFrequencyHz: clamp(value, 100, 1000) })}
					/>
					<Select
						label="Reference class"
						ariaLabel="Reference pitch class"
						value={String(tuning.referencePitchClass)}
						options={roots}
						onchange={(value) => patchTuning({ referencePitchClass: Number(value) })}
					/>
				</div>
				<div class="row-3">
					<NumberField
						label="Divisions per octave"
						value={tuning.divisionsPerOctave ?? 12}
						min={2}
						max={96}
						step={1}
						decimals={0}
						disabled={tuning.mode !== 'equal-n'}
						onchange={(value) => patchTuning({ divisionsPerOctave: Math.round(value) })}
					/>
					<Select
						label="JI anchor"
						ariaLabel="JI anchor"
						value={tuning.jiAnchorMode ?? 'master-root'}
						options={anchors}
						disabled={tuning.mode !== 'dynamic-ji'}
						onchange={(value) => patchTuning({ jiAnchorMode: value as JIAnchorMode })}
					/>
					<NumberField
						label="Prime limit"
						value={tuning.jiPrimeLimit ?? 5}
						min={2}
						max={31}
						step={1}
						decimals={0}
						disabled={!usesRatios}
						onchange={(value) => patchTuning({ jiPrimeLimit: Math.round(value) })}
					/>
				</div>
				<div class="row-3">
					<Select
						label="Chord root (manual anchor)"
						ariaLabel="Manual chord root"
						value={String(tuning.manualChordRootPitchClass ?? masterState.rootPitchClass)}
						options={roots}
						disabled={tuning.mode !== 'dynamic-ji' ||
							(tuning.jiAnchorMode ?? 'master-root') !== 'manual-chord-root'}
						onchange={(value) => patchTuning({ manualChordRootPitchClass: Number(value) })}
					/>
					<Select
						label="Base note"
						ariaLabel="Base note all ratios attach to"
						value={String(masterState.rootPitchClass)}
						options={roots}
						onchange={(value) => patchRoot(Number(value))}
					/>
					<Field label="Snap policy" hint="Pitch snap mode is edited in Settings">
						<span class="num readout">{masterState.snapMode}</span>
					</Field>
				</div>
				<p class="note">
					<b>Ratios attach to the base note:</b> with a tuning and a base note selected, every note resolves
					as base × ratio, so the whole set stays in proportion. Static JI keeps the anchor on the master
					root; Dynamic JI lets it follow the root or a manual chord root, so the same ratios re-fit the
					chord as the harmony moves (Alosynth-style re-anchoring). Absolute-Hz curves are never rewritten
					by these settings. Only points drawn on a scale-relative track re-resolve their pitch when the
					root, scale or anchor changes.
				</p>
			</Panel>

			<Panel title="Scale">
				<div class="row-3">
					<label class="text-field">
						<span class="label">Name</span>
						<input
							class="num"
							value={scale.name}
							aria-label="Scale name"
							onchange={(event) =>
								updateScale(scale.id, { name: (event.currentTarget as HTMLInputElement).value })}
						/>
					</label>
					<Select
						label="Scale root"
						ariaLabel="Scale root"
						value={String(scale.rootPitchClass)}
						options={roots}
						onchange={(value) => updateScale(scale.id, { rootPitchClass: Number(value) })}
					/>
					<NumberField
						label="Octave ratio"
						value={scale.octaveRatio}
						min={1}
						max={4}
						step={1}
						decimals={0}
						onchange={(value) => updateScale(scale.id, { octaveRatio: value })}
					/>
				</div>
				<p class="note num">
					{enabledCount} enabled degrees · ratio column is exact · cents follow the ratio
				</p>
			</Panel>

			<Panel title="Note ratios — relative to the base note">
				{#snippet actions()}
					<IconButton label="Add degree" size="sm" onclick={addDegree}>+ degree</IconButton>
				{/snippet}
				<div class="matrix-scroll">
					<table class="matrix">
						<thead>
							<tr>
								<th scope="col" class="sticky-col">Degree</th>
								{#each scale.degrees as degree, index (index)}
									<th scope="col">
										<div class="col-head">
											<span class="num">{degree.label}</span>
											<button
												type="button"
												class="mini"
												aria-label={`Remove degree ${degree.label}`}
												disabled={scale.degrees.length <= 2}
												onclick={() => removeDegree(index)}
											>
												×
											</button>
										</div>
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							<tr>
								<th scope="row" class="sticky-col">Enabled</th>
								{#each scale.degrees as degree, index (index)}
									<td>
										<input
											type="checkbox"
											checked={degree.enabled}
											aria-label={`Degree ${degree.label} enabled`}
											onchange={(event) =>
												updateDegree(index, {
													enabled: (event.currentTarget as HTMLInputElement).checked
												})}
										/>
									</td>
								{/each}
							</tr>
							<tr>
								<th scope="row" class="sticky-col">Ratio</th>
								{#each scale.degrees as degree, index (index)}
									<td>
										<div class="ratio-cell">
											<input
												class="num tiny"
												inputmode="numeric"
												aria-label={`Degree ${degree.label} ratio numerator`}
												value={String(degree.ratio?.numerator ?? 1)}
												onchange={(event) =>
													setRatio(index, numberFrom(event), degree.ratio?.denominator ?? 1)}
											/>
											<span class="slash">/</span>
											<input
												class="num tiny"
												inputmode="numeric"
												aria-label={`Degree ${degree.label} ratio denominator`}
												value={String(degree.ratio?.denominator ?? 1)}
												onchange={(event) =>
													setRatio(index, degree.ratio?.numerator ?? 1, numberFrom(event))}
											/>
										</div>
										{#if approxErrors[degreeKey(index)] !== undefined}
											<button
												type="button"
												class="approx"
												title="Approximate rational value, not an exact fraction"
												onclick={() => applyApproximation(index)}
											>
												≈ {formatCents(approxErrors[degreeKey(index)] ?? 0, 2)}
											</button>
										{:else}
											<button
												type="button"
												class="approx is-idle"
												title="Find an approximate rational value for these cents"
												onclick={() => applyApproximation(index)}
											>
												≈
											</button>
										{/if}
									</td>
								{/each}
							</tr>
							<tr>
								<th scope="row" class="sticky-col">Cents</th>
								{#each scale.degrees as degree, index (index)}
									<td>
										<input
											class="num tiny wide"
											inputmode="decimal"
											aria-label={`Degree ${degree.label} cents`}
											value={(degree.cents ?? 0).toFixed(2)}
											onchange={(event) =>
												updateDegree(index, {
													cents: clamp(numberFrom(event), 0, 2400)
												})}
										/>
									</td>
								{/each}
							</tr>
							<tr>
								<th scope="row" class="sticky-col">Interval</th>
								{#each scale.degrees as degree, index (index)}
									<td class="num muted">{formatCents(degreeIntervalCents(degree), 1)}</td>
								{/each}
							</tr>
						</tbody>
					</table>
				</div>
				<p class="note">
					Each column is one note's exact ratio from the base note (1/1). Editing a cents value
					leaves the ratio alone until you ask for an approximation. An approximation is always
					marked <span class="num">≈</span> because it is not the exact fraction.
				</p>
			</Panel>

			<Panel title="Resolved targets" open={false}>
				<div class="targets">
					{#each targets as target, index (index)}
						<div class="target">
							<span class="num freq">{formatHz(target.frequency, 2)}</span>
							<span class="num label-cell">{target.label}</span>
							<span class="num muted">TET {formatHz(target.tetFrequency, 2)}</span>
							<span class="num dev" class:is-ji={target.ji}
								>{formatCents(target.deviationCents, 2)}</span
							>
						</div>
					{/each}
					{#if targets.length === 0}
						<p class="note">No targets inside the current frequency range.</p>
					{/if}
				</div>
			</Panel>
		</section>
	</main>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--color-bg-0);
	}

	.topbar {
		display: flex;
		align-items: center;
		gap: var(--sp-5);
		height: var(--h-topbar);
		padding: 0 var(--sp-5);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		flex: none;
	}

	.brand {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--color-fg-0);
		text-decoration: none;
	}

	nav {
		display: flex;
		gap: var(--sp-1);
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
		display: grid;
		grid-template-columns: 230px minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}

	.sidebar {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
	}

	.sidebar-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--sp-2);
		padding: var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
	}

	.sidebar-actions {
		display: flex;
		gap: var(--sp-1);
	}

	.scale-list {
		list-style: none;
		margin: 0;
		padding: var(--sp-1);
		overflow-y: auto;
	}

	.scale-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--sp-3);
		width: 100%;
		padding: 5px var(--sp-2);
		border: none;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-1);
		text-align: left;
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			color 130ms var(--ease-out);
	}

	.scale-row:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.scale-row.is-selected {
		background: color-mix(in oklab, var(--color-accent) 22%, var(--color-bg-1));
		color: var(--color-fg-0);
	}

	.scale-name {
		font-size: 12px;
	}

	.scale-meta {
		color: var(--color-fg-2);
		flex: none;
	}

	.badge {
		margin-left: 6px;
		padding: 1px 4px;
		border-radius: var(--r-1);
		background: var(--color-bg-3);
		font-size: 9px;
		font-style: normal;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.content {
		overflow-y: auto;
		padding-bottom: var(--sp-6);
	}

	.row-3 {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--sp-4);
		align-items: end;
		margin-bottom: var(--sp-3);
	}

	.text-field {
		display: block;
		min-width: 0;
	}

	.text-field input {
		width: 100%;
		height: var(--h-row);
		padding: 0 var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-0);
	}

	.note {
		margin: var(--sp-3) 0 0;
		font-size: 11px;
		line-height: 1.5;
		color: var(--color-fg-2);
		max-width: 76ch;
	}

	.matrix-scroll {
		overflow-x: auto;
		padding-bottom: var(--sp-2);
	}

	.matrix {
		border-collapse: separate;
		border-spacing: 0;
		min-width: 100%;
	}

	.matrix th,
	.matrix td {
		padding: var(--sp-2);
		border-bottom: 1px solid var(--color-line-0);
		text-align: center;
		vertical-align: middle;
	}

	.matrix thead th {
		position: sticky;
		top: 0;
		background: var(--color-bg-1);
		font-size: 11px;
		color: var(--color-fg-1);
		font-weight: 500;
	}

	.matrix tbody th {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-2);
		text-align: left;
		white-space: nowrap;
	}

	.sticky-col {
		position: sticky;
		left: 0;
		z-index: 1;
		background: var(--color-bg-1);
		text-align: left;
	}

	.col-head {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
	}

	.mini {
		border: none;
		background: transparent;
		color: var(--color-fg-3);
		cursor: pointer;
		font-size: 12px;
		line-height: 1;
		padding: 0 2px;
		border-radius: var(--r-1);
		transition: color 120ms var(--ease-out);
	}

	.mini:hover:not(:disabled) {
		color: var(--color-danger);
	}

	.mini:disabled {
		opacity: 0.3;
		cursor: default;
	}

	.ratio-cell {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1px;
	}

	.tiny {
		width: 26px;
		height: 20px;
		padding: 0 2px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-0);
		text-align: center;
	}

	.slash {
		color: var(--color-fg-3);
		font-size: 10px;
	}

	.tiny.wide {
		width: 60px;
		margin: 0 auto;
	}

	.approx {
		margin-top: 2px;
		border: none;
		background: transparent;
		color: var(--color-warn);
		font-size: 9px;
		letter-spacing: 0.03em;
		cursor: pointer;
		padding: 0;
		font-family: var(--font-mono);
	}

	.approx.is-idle {
		color: var(--color-fg-3);
	}

	.approx:hover {
		color: var(--color-fg-0);
	}

	.readout {
		color: var(--color-fg-0);
	}

	.targets {
		max-height: 320px;
		overflow-y: auto;
	}

	.target {
		display: grid;
		grid-template-columns: 110px 70px 130px 80px;
		gap: var(--sp-3);
		padding: 3px var(--sp-1);
		border-bottom: 1px solid var(--color-line-0);
	}

	.freq {
		color: var(--color-fg-0);
	}

	.label-cell {
		color: var(--color-accent);
	}

	.muted {
		color: var(--color-fg-2);
	}

	.dev {
		color: var(--color-fg-2);
	}

	.dev.is-ji {
		color: var(--color-ji);
	}
</style>
