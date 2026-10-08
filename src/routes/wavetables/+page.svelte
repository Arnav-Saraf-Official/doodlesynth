<script lang="ts">
	/**
	 * Wavetable library and authoring page.
	 *
	 * The Shape Editor and the Harmonic Editor are two ways of constructing the
	 * same frame, so they share one frame list and one asset. Switching modes
	 * never converts anything: conversion is an explicit command because it can
	 * be lossy.
	 */
	import { midiToName, midiToHz } from '#lib/model/pitch';
	import type {
		HarmonicComponent,
		ShapePoint,
		Wavetable,
		WavetableFrame,
		WavetableFrameSource
	} from '#lib/model/types';
	import {
		SAMPLE_LENGTHS,
		analyzeFrameToHarmonics,
		convertFrameToShape,
		createHarmonicComponents,
		createSineShape,
		maxHarmonic,
		refreshFrameSamples,
		removeDc,
		renderFrame,
		renderWavetableAt,
		reverseSamples,
		rotatePhase,
		peakNormalize,
		rmsNormalize,
		invertSamples
	} from '#lib/model/wavetable';
	import {
		addWavetableFrame,
		createAndAddWavetable,
		deleteWavetable,
		duplicateWavetableById,
		removeWavetableFrame,
		setWavetableFramePosition,
		toggleWavetableFavorite,
		updateWavetable,
		updateWavetableFrame
	} from '#lib/state/actions';
	import { saveNow, session, setStatus } from '#lib/state/session.svelte';
	import { engine } from '#lib/audio/engine';
	import IconButton from '#lib/ui/IconButton.svelte';
	import NumberField from '#lib/ui/NumberField.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Slider from '#lib/ui/Slider.svelte';
	import HarmonicEditor from '#lib/components/wavetable/HarmonicEditor.svelte';
	import ShapeEditor from '#lib/components/wavetable/ShapeEditor.svelte';

	let selectedTableId = $state<string | null>(null);
	let selectedFrameId = $state<string | null>(null);
	let editorMode = $state<'shape' | 'harmonics'>('harmonics');
	let search = $state('');
	let morph = $state(0);
	let previewNote = $state(45); // A2
	let previewSeconds = $state(1.5);
	/** how many cycles of the wave the preview canvas shows */
	let previewRepeats = $state(1);
	let lfoRate = $state(0.6);
	let lfoRunning = $state(false);
	let previewPlaying = $state(false);

	const tables = $derived(session.project.wavetables);
	const filtered = $derived.by(() => {
		const query = search.trim().toLowerCase();
		const list = query
			? tables.filter((table) => table.name.toLowerCase().includes(query))
			: tables;
		return [...list].sort((a, b) => Number(b.favorite ?? false) - Number(a.favorite ?? false));
	});

	const table = $derived<Wavetable | null>(
		tables.find((entry) => entry.id === selectedTableId) ?? tables[0] ?? null
	);
	const frames = $derived(table ? [...table.frames].sort((a, b) => a.position - b.position) : []);
	const frame = $derived<WavetableFrame | null>(
		frames.find((entry) => entry.id === selectedFrameId) ?? frames[0] ?? null
	);

	// The editors emit on every pointer move. Committing straight away would
	// re-render them from the project mid-gesture, so the draft holds the live
	// value and the project is updated once the gesture settles.
	let draftSource = $state<WavetableFrameSource | null>(null);
	let draftFrameId: string | null = null;
	let commitHandle: ReturnType<typeof setTimeout> | null = null;

	const activeSource = $derived<WavetableFrameSource | null>(
		frame && draftSource && draftFrameId === frame.id ? draftSource : (frame?.source ?? null)
	);

	function queueSource(source: WavetableFrameSource): void {
		draftSource = source;
		draftFrameId = frame?.id ?? null;
		if (commitHandle) clearTimeout(commitHandle);
		commitHandle = setTimeout(flushSource, 180);
	}

	function flushSource(): void {
		const id = draftFrameId;
		const source = draftSource;
		commitHandle = null;
		if (!table || !id || !source) return;
		updateWavetableFrame(table.id, id, (entry) => ({ ...entry, source }), 'Edit wavetable frame');
	}

	$effect(() => {
		if (frame && draftFrameId && draftFrameId !== frame.id) {
			draftSource = null;
			draftFrameId = null;
		}
		if (!selectedTableId && tables.length) selectedTableId = tables[0].id;
		if (table && !frames.some((entry) => entry.id === selectedFrameId)) {
			selectedFrameId = frames[0]?.id ?? null;
		}
	});

	/* ------------------------------------------------------------- preview */

	let morphCanvas = $state<HTMLCanvasElement | null>(null);

	const previewSamples = $derived.by(() => {
		if (!table) return null;
		const source = activeSource;
		if (!source) return null;
		// the preview renders the draft so it tracks the gesture immediately
		return renderWavetableAt(
			{
				...table,
				frames: frames.map((entry) => (entry.id === frame?.id ? { ...entry, source } : entry))
			},
			morph
		);
	});

	function drawMorph() {
		const canvas = morphCanvas;
		if (!canvas || !previewSamples) return;
		const dpr = window.devicePixelRatio || 1;
		const width = canvas.clientWidth || 320;
		const height = canvas.clientHeight || 90;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);
		ctx.fillStyle = '#05070b';
		ctx.fillRect(0, 0, width, height);

		ctx.strokeStyle = 'rgba(164, 173, 190, 0.18)';
		ctx.beginPath();
		ctx.moveTo(0, height / 2);
		ctx.lineTo(width, height / 2);
		ctx.stroke();

		ctx.strokeStyle = '#4da3ff';
		ctx.lineWidth = 1.6;
		ctx.beginPath();
		const samples = previewSamples;
		const cycles = Math.max(1, previewRepeats);
		for (let x = 0; x < width; x++) {
			const phase = ((x / width) * cycles) % 1;
			const index = Math.min(samples.length - 1, Math.floor(phase * samples.length));
			const y = height / 2 - samples[index] * (height / 2 - 4);
			if (x === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.stroke();
	}

	// drawMorph reads the samples, the morph position and the repeat count,
	// which makes those the effect's dependencies
	$effect(() => {
		drawMorph();
	});

	/** Audible preview of exactly what the canvas shows at the chosen note. */
	async function playPreview(): Promise<void> {
		if (!previewSamples || previewPlaying) return;
		previewPlaying = true;
		try {
			await engine.previewCycle(previewSamples, previewFrequency, previewSeconds);
		} catch {
			// no audio device: stay silent rather than breaking the page
		}
		// the tone runs for `previewSeconds`; hold the pressed state that long
		setTimeout(() => (previewPlaying = false), Math.max(200, previewSeconds * 1000));
	}

	// morph LFO preview: animates the position, nothing is played
	$effect(() => {
		if (!lfoRunning) return;
		let frameHandle = 0;
		const started = performance.now();
		const step = () => {
			if (!lfoRunning) return;
			const elapsed = (performance.now() - started) / 1000;
			morph = (Math.sin(elapsed * Math.PI * 2 * lfoRate) + 1) / 2;
			frameHandle = requestAnimationFrame(step);
		};
		frameHandle = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frameHandle);
	});

	/* -------------------------------------------------------------- library */

	function createTable() {
		const id = createAndAddWavetable(`Table ${tables.length + 1}`, 2048);
		selectedTableId = id;
		setStatus('Wavetable created');
	}

	function duplicateTable() {
		if (!table) return;
		duplicateWavetableById(table.id);
		setStatus('Wavetable duplicated');
	}

	function removeTable() {
		if (!table || table.builtIn) return;
		deleteWavetable(table.id);
		selectedTableId = null;
	}

	function renameTable(name: string) {
		if (!table) return;
		updateWavetable(table.id, { name }, 'Rename wavetable');
	}

	/* ----------------------------------------------------------- frame strip */

	let strip = $state<HTMLDivElement | null>(null);
	let draggingFrameId = $state<string | null>(null);

	function positionFromClientX(clientX: number): number {
		const element = strip;
		if (!element) return 0;
		const rect = element.getBoundingClientRect();
		return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
	}

	function onFramePointerDown(event: PointerEvent, frameId: string) {
		if (!table) return;
		draggingFrameId = frameId;
		selectedFrameId = frameId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onFramePointerMove(event: PointerEvent) {
		if (!draggingFrameId || !table) return;
		setWavetableFramePosition(table.id, draggingFrameId, positionFromClientX(event.clientX));
	}

	function onFramePointerUp(event: PointerEvent) {
		if (!draggingFrameId) return;
		draggingFrameId = null;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function addFrame() {
		if (!table || !frame) return;
		const source: WavetableFrameSource =
			frame.source.kind === 'shape'
				? { kind: 'shape', points: frame.source.points.map((point) => ({ ...point })) }
				: {
						kind: 'harmonics',
						components: frame.source.components.map((component) => ({ ...component }))
					};
		const position = Math.min(1, frame.position + 0.25);
		const created: WavetableFrame = {
			id: `frame_${Math.random().toString(36).slice(2, 9)}`,
			position,
			source,
			samples: new Float32Array(table.sampleLength),
			interpolation: 'smooth'
		};
		addWavetableFrame(table.id, created);
		selectedFrameId = created.id;
	}

	/* --------------------------------------------------------- utilities */

	function applyToSamples(transform: (samples: Float32Array) => Float32Array, label: string): void {
		if (!table || !frame) return;
		const samples = transform(renderFrame(frame, table.sampleLength));
		const points: ShapePoint[] = [];
		const resolution = 128;
		for (let index = 0; index < resolution; index++) {
			const phase = index / resolution;
			points.push({
				id: `sp_${index}_${Math.random().toString(36).slice(2, 6)}`,
				phase,
				amplitude: samples[Math.floor(phase * samples.length)] ?? 0,
				interpolation: 'smooth'
			});
		}
		queueSource({ kind: 'shape', points });
		editorMode = 'shape';
		setStatus(`${label} applied to ${table.name}`);
	}

	/* --------------------------------------------------------- conversions */

	function convertToShape(): void {
		if (!table || !frame) return;
		const converted = convertFrameToShape(frame, 128);
		updateWavetableFrame(table.id, frame.id, () => converted, 'Convert to shape');
		setStatus('Harmonics → shape (IFFT): 128 editable points');
	}

	function analyzeToHarmonics(): void {
		if (!table || !frame) return;
		const count = Math.min(64, Math.max(8, maxHarmonic(table.sampleLength)));
		const analyzed = analyzeFrameToHarmonics(frame, count, table.sampleLength);
		updateWavetableFrame(table.id, frame.id, () => analyzed, 'Analyze to harmonics');
		setStatus(`Shape → harmonics (FFT): ${count} partials — approximate`);
	}

	/**
	 * The two surfaces are views of one frame: switching converts the source
	 * with an FFT (shape → harmonics) or an IFFT (harmonics → shape), so the
	 * user never sits on a blocked "convert first" screen.
	 */
	function setEditorMode(next: 'shape' | 'harmonics'): void {
		if (next === editorMode) return;
		flushSource();
		// flushSource commits through mutate; re-read the live project for fresh ids
		const freshTable = session.project.wavetables.find((entry) => entry.id === table?.id);
		const freshFrame = freshTable?.frames.find((entry) => entry.id === frame?.id);
		if (freshTable && freshFrame) {
			const isShape = freshFrame.source.kind === 'shape';
			if (next === 'harmonics' && isShape) analyzeFor(freshTable.sampleLength, freshFrame);
			else if (next === 'shape' && !isShape) shapeFor(freshFrame);
		}
		editorMode = next;
	}

	function analyzeFor(sampleLength: number, target: WavetableFrame): void {
		if (!table) return;
		const count = Math.min(64, Math.max(8, maxHarmonic(sampleLength)));
		const analyzed = analyzeFrameToHarmonics(target, count, sampleLength);
		updateWavetableFrame(table.id, target.id, () => analyzed, 'Shape to harmonics');
		setStatus(`Shape → harmonics (FFT): ${count} partials — approximate`);
	}

	function shapeFor(target: WavetableFrame): void {
		if (!table) return;
		const converted = convertFrameToShape(target, 128);
		updateWavetableFrame(table.id, target.id, () => converted, 'Harmonics to shape');
		setStatus('Harmonics → shape (IFFT): 128 editable points');
	}

	const harmonicComponents = $derived<HarmonicComponent[]>(
		activeSource?.kind === 'harmonics' ? activeSource.components : createHarmonicComponents(32)
	);
	const shapePoints = $derived<ShapePoint[]>(
		activeSource?.kind === 'shape' ? activeSource.points : createSineShape(24)
	);

	const previewFrequency = $derived(midiToHz(previewNote));
	const nyquistNote = $derived(
		table
			? `Nyquist limit for this table is harmonic ${Math.floor(table.sampleLength / 2) - 1}`
			: ''
	);
</script>

<svelte:head>
	<title>Wavetables — Line Synth</title>
	<meta
		name="description"
		content="Author wavetables by drawing a waveform shape or by editing an additive harmonic spectrum."
	/>
</svelte:head>

<div class="page">
	<header class="page-header">
		<a class="logo" href="/" aria-label="Back to the Line Synth editor">
			<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
				<path
					d="M2 13c3 0 3-8 6-8s3 8 6 8"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
				/>
			</svg>
			<span>Wavetables</span>
		</a>
		<nav class="page-nav" aria-label="Sections">
			<a href="/">Editor</a>
			<a href="/tuning">Tuning</a>
			<a href="/settings">Settings</a>
			<a href="/help">Help</a>
		</nav>
		<div class="spacer"></div>
		<IconButton label="Save now" onclick={() => void saveNow()}>
			<span class="num" data-state={session.saveState}>
				{session.saveState === 'saved'
					? 'Saved'
					: session.saveState === 'saving'
						? 'Saving…'
						: 'Unsaved'}
			</span>
		</IconButton>
	</header>

	<div class="body">
		<aside class="library" aria-label="Wavetable library">
			<div class="library-head">
				<span class="label">Library</span>
				<IconButton label="New wavetable" size="sm" onclick={createTable}>New</IconButton>
			</div>
			<input
				class="search num"
				type="search"
				placeholder="Search tables"
				aria-label="Search wavetables"
				bind:value={search}
			/>
			<ul class="table-list">
				{#each filtered as entry (entry.id)}
					<li>
						<button
							type="button"
							class="table-row"
							class:is-active={entry.id === table?.id}
							aria-current={entry.id === table?.id}
							onclick={() => {
								selectedTableId = entry.id;
								selectedFrameId = null;
							}}
						>
							<span class="table-name">{entry.name}</span>
							<span class="table-meta num">
								{entry.frames.length} frames · {entry.sampleLength}
							</span>
							{#if entry.builtIn}<span class="badge num">PRESET</span>{/if}
							{#if entry.favorite}<span class="badge is-fav num">★</span>{/if}
						</button>
					</li>
				{:else}
					<li class="empty">No tables match “{search}”.</li>
				{/each}
			</ul>
		</aside>

		<main class="workspace">
			{#if table}
				<div class="table-header">
					<input
						class="table-title"
						aria-label="Wavetable name"
						value={table.name}
						onchange={(event) => renameTable(event.currentTarget.value)}
					/>
					<SegmentedControl
						ariaLabel="Authoring surface"
						value={editorMode}
						segments={[
							{ value: 'shape', label: 'Shape editor' },
							{ value: 'harmonics', label: 'Harmonic editor' }
						]}
						onchange={(value) => setEditorMode(value as 'shape' | 'harmonics')}
					/>
					<div class="spacer"></div>
					<IconButton
						label="Favorite wavetable"
						active={table.favorite ?? false}
						onclick={() => toggleWavetableFavorite(table.id)}
					>
						★
					</IconButton>
					<IconButton label="Duplicate wavetable" onclick={duplicateTable}>Duplicate</IconButton>
					<IconButton
						label={table.builtIn ? 'Built-in presets cannot be deleted' : 'Delete wavetable'}
						variant="danger"
						disabled={table.builtIn}
						onclick={removeTable}
					>
						Delete
					</IconButton>
				</div>

				<div class="preview-strip" aria-label="Wavetable preview">
					<button
						type="button"
						class="play"
						aria-label="Play wavetable preview"
						disabled={!previewSamples}
						onclick={playPreview}
					>
						<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
							<path d="M2 1.5v7l6-3.5z" fill="currentColor" />
						</svg>
						<span>{previewPlaying ? 'Playing…' : 'Play'}</span>
					</button>
					<Select
						ariaLabel="Preview note"
						width="100px"
						value={String(previewNote)}
						options={Array.from({ length: 48 }, (_, index) => {
							const midi = 24 + index;
							return { value: String(midi), label: midiToName(midi) };
						})}
						onchange={(value) => (previewNote = Number(value))}
					/>
					<NumberField
						ariaLabel="Preview duration in seconds"
						value={previewSeconds}
						min={0.1}
						max={8}
						step={0.1}
						decimals={1}
						unit="s"
						width="74px"
						onchange={(value) => (previewSeconds = value)}
					/>
					<Select
						ariaLabel="Waveform repeats"
						width="92px"
						value={String(previewRepeats)}
						options={[
							{ value: '1', label: '1 repeat' },
							{ value: '2', label: '2 repeats' },
							{ value: '4', label: '4 repeats' }
						]}
						onchange={(value) => (previewRepeats = Number(value))}
					/>
					<label class="slider-row morph-row">
						<span class="label">Morph</span>
						<Slider
							ariaLabel="Wavetable morph position"
							min={0}
							max={1}
							step={0.001}
							value={morph}
							onchange={(value) => (morph = value)}
						/>
						<span class="num">{(morph * 100).toFixed(0)}%</span>
					</label>
					<IconButton
						label={lfoRunning ? 'Stop morph LFO' : 'Start morph LFO'}
						active={lfoRunning}
						onclick={() => (lfoRunning = !lfoRunning)}
					>
						{lfoRunning ? 'Stop LFO' : 'Run LFO'}
					</IconButton>
					<div class="preview-canvas">
						<canvas bind:this={morphCanvas} aria-label="Morphed waveform preview"></canvas>
					</div>
					<span class="preview-caption num">
						{`${midiToName(previewNote)} · ${previewFrequency.toFixed(1)} Hz · ×${previewRepeats}`}
					</span>
				</div>

				<div class="surface">
					{#if !frame}
						<p class="empty">This table has no frames. Add one to start editing.</p>
					{:else if editorMode === 'shape'}
						{#if activeSource?.kind === 'shape'}
							<ShapeEditor
								points={shapePoints}
								sampleLength={table.sampleLength}
								accent="#4da3ff"
								onchange={(points) => queueSource({ kind: 'shape', points })}
								onOperation={(operation) => {
									if (operation === 'normalize')
										applyToSamples((s) => peakNormalize(s), 'Peak normalize');
									else if (operation === 'rms')
										applyToSamples((s) => rmsNormalize(s), 'RMS normalize');
									else if (operation === 'removeDc')
										applyToSamples((s) => removeDc(s), 'DC removal');
									else if (operation === 'invert')
										applyToSamples((s) => invertSamples(s), 'Invert');
									else if (operation === 'reverse')
										applyToSamples((s) => reverseSamples(s), 'Reverse');
									else if (operation === 'mirrorHorizontal')
										applyToSamples((s) => reverseSamples(s), 'Mirror horizontally');
									else if (operation === 'mirrorVertical')
										applyToSamples((s) => invertSamples(s), 'Mirror vertically');
									else applyToSamples((s) => rotatePhase(s, 0.25), 'Phase rotate');
								}}
							/>
						{:else}
							<div class="convert">
								<p>
									This frame is authored from harmonics. Converting it to a shape draws one cycle of
									the same audio and is exact, but editing then continues in shape points.
								</p>
								<IconButton
									label="Convert this frame to a shape frame"
									variant="solid"
									onclick={convertToShape}
								>
									Convert Harmonics → Shape
								</IconButton>
							</div>
						{/if}
					{:else}
						{#if activeSource?.kind === 'harmonics'}
							<HarmonicEditor
								components={harmonicComponents}
								count={harmonicComponents.length}
								sampleLength={table.sampleLength}
								accent="#4da3ff"
								onchange={(components) => queueSource({ kind: 'harmonics', components })}
								oncountchange={(count) =>
									queueSource({ kind: 'harmonics', components: createHarmonicComponents(count) })}
							/>
						{:else}
							<div class="convert">
								<p>
									This frame is authored as a drawn shape. Analysis into harmonics is approximate:
									it projects the rendered cycle onto harmonic sine components.
								</p>
								<IconButton
									label="Analyze this frame into harmonic components"
									variant="solid"
									onclick={analyzeToHarmonics}
								>
									Analyze Shape → Harmonics
								</IconButton>
							</div>
						{/if}
					{/if}
				</div>

				<section class="frame-strip-section" aria-label="Frame strip">
					<div class="strip-head">
						<span class="label">Frame strip</span>
						<div class="spacer"></div>
						<IconButton label="Add frame" size="sm" onclick={addFrame}>Add</IconButton>
						<IconButton label="Duplicate selected frame" size="sm" onclick={addFrame}>
							Duplicate
						</IconButton>
						<IconButton
							label={frames.length > 1
								? 'Delete selected frame'
								: 'A table keeps at least one frame'}
							size="sm"
							variant="danger"
							disabled={frames.length <= 1 || !frame}
							onclick={() => {
								if (table && frame) removeWavetableFrame(table.id, frame.id);
							}}
						>
							Delete
						</IconButton>
					</div>

					<div
						class="strip"
						bind:this={strip}
						role="listbox"
						aria-label="Wavetable frames"
						tabindex="0"
					>
						<div class="strip-track" aria-hidden="true"></div>
						{#each frames as entry, index (entry.id)}
							<button
								type="button"
								class="frame-handle"
								class:is-active={entry.id === frame?.id}
								role="option"
								aria-selected={entry.id === frame?.id}
								aria-label={`Frame ${index + 1} at ${(entry.position * 100).toFixed(0)} percent`}
								style="left:{entry.position * 100}%"
								onpointerdown={(event) => onFramePointerDown(event, entry.id)}
								onpointermove={onFramePointerMove}
								onpointerup={onFramePointerUp}
								onpointercancel={onFramePointerUp}
								onkeydown={(event) => {
									if (event.key === 'ArrowLeft')
										setWavetableFramePosition(table.id, entry.id, entry.position - 0.01);
									if (event.key === 'ArrowRight')
										setWavetableFramePosition(table.id, entry.id, entry.position + 0.01);
								}}
							>
								<span class="frame-index num">{index}</span>
							</button>
						{/each}
					</div>

					<div class="frame-fields">
						<NumberField
							label="Position"
							value={frame ? frame.position : 0}
							min={0}
							max={1}
							step={0.01}
							decimals={3}
							width="86px"
							disabled={!frame}
							onchange={(value) => {
								if (table && frame) setWavetableFramePosition(table.id, frame.id, value);
							}}
						/>
						<Select
							label="Interpolation"
							ariaLabel="Frame interpolation"
							width="128px"
							value={frame?.interpolation ?? 'smooth'}
							options={[
								{ value: 'step', label: 'Step' },
								{ value: 'linear', label: 'Linear' },
								{ value: 'smooth', label: 'Smooth' }
							]}
							onchange={(value) => {
								if (!table || !frame) return;
								updateWavetableFrame(
									table.id,
									frame.id,
									(entry) => ({
										...entry,
										interpolation: value as WavetableFrame['interpolation']
									}),
									'Frame interpolation'
								);
							}}
						/>
						<Select
							label="Table length"
							ariaLabel="Samples per frame"
							width="118px"
							value={String(table.sampleLength)}
							options={SAMPLE_LENGTHS.map((length) => ({
								value: String(length),
								label: `${length} samples`
							}))}
							onchange={(value) => {
								const sampleLength = Number(value);
								const refreshed = table.frames.map((entry) =>
									refreshFrameSamples(entry, sampleLength)
								);
								updateWavetable(table.id, { sampleLength, frames: refreshed }, 'Table length');
							}}
						/>
						<Select
							label="Default morph"
							ariaLabel="Default frame interpolation"
							width="126px"
							value={table.defaultInterpolation}
							options={[
								{ value: 'linear', label: 'Linear' },
								{ value: 'smooth', label: 'Smooth' }
							]}
							onchange={(value) =>
								updateWavetable(
									table.id,
									{ defaultInterpolation: value as Wavetable['defaultInterpolation'] },
									'Default morph'
								)}
						/>
						<span class="hint num">{nyquistNote}</span>
					</div>
				</section>
			{:else}
				<p class="empty">No wavetables yet. Create one to start designing sound.</p>
			{/if}
		</main>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.page-header {
		display: flex;
		align-items: center;
		gap: var(--sp-4);
		height: var(--h-topbar);
		padding: 0 var(--sp-3);
		background: var(--color-bg-1);
		border-bottom: 1px solid var(--color-line-0);
	}

	.logo {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		color: var(--color-fg-0);
		text-decoration: none;
		font-size: 12px;
		font-weight: 650;
	}

	.logo svg {
		color: var(--color-accent);
	}

	.page-nav {
		display: flex;
		gap: 2px;
	}

	.page-nav a {
		color: var(--color-fg-2);
		text-decoration: none;
		font-size: 11px;
		padding: 3px var(--sp-2);
		border-radius: var(--r-1);
	}

	.page-nav a:hover {
		background: var(--color-bg-3);
		color: var(--color-fg-0);
	}

	.spacer {
		flex: 1;
	}

	.body {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.library {
		width: 244px;
		flex: none;
		display: flex;
		flex-direction: column;
		gap: var(--sp-2);
		padding: var(--sp-3);
		border-right: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		overflow: hidden;
	}

	.library-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.search {
		height: var(--h-row);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-0);
		color: var(--color-fg-0);
		padding: 0 var(--sp-2);
		font-size: 11px;
	}

	.table-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
	}

	.table-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--sp-2);
		width: 100%;
		text-align: left;
		padding: var(--sp-2);
		border: 1px solid transparent;
		border-radius: var(--r-2);
		background: none;
		color: var(--color-fg-1);
		cursor: pointer;
		transition:
			background-color 120ms var(--ease-out),
			border-color 120ms var(--ease-out);
	}

	.table-row:hover {
		background: var(--color-bg-2);
	}

	.table-row.is-active {
		background: var(--color-bg-3);
		border-color: var(--color-line-1);
		color: var(--color-fg-0);
	}

	.table-name {
		font-size: 12px;
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.table-meta {
		font-size: 10px;
		color: var(--color-fg-3);
		width: 100%;
	}

	.badge {
		font-size: 9px;
		padding: 0 4px;
		border-radius: var(--r-1);
		background: var(--color-bg-4);
		color: var(--color-fg-2);
	}

	.badge.is-fav {
		color: var(--color-warn);
	}

	.workspace {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.table-header {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
	}

	.table-title {
		width: 220px;
		height: var(--h-control);
		border: 1px solid transparent;
		border-radius: var(--r-1);
		background: transparent;
		color: var(--color-fg-0);
		font-size: 14px;
		font-weight: 600;
		padding: 0 var(--sp-2);
	}

	.table-title:hover {
		border-color: var(--color-line-0);
	}

	.surface {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}

	.convert {
		display: grid;
		gap: var(--sp-4);
		place-items: center;
		padding: var(--sp-6);
		text-align: center;
		color: var(--color-fg-1);
		max-width: 520px;
		margin: 0 auto;
	}

	.convert p {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
	}

	.frame-strip-section {
		border-top: 1px solid var(--color-line-0);
		padding: var(--sp-3);
		background: var(--color-bg-1);
	}

	.strip-head {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		margin-bottom: var(--sp-2);
	}

	.strip {
		position: relative;
		height: 44px;
		margin: 0 var(--sp-4) var(--sp-3);
	}

	.strip-track {
		position: absolute;
		inset: 20px 0 auto 0;
		height: 3px;
		border-radius: 2px;
		background: var(--color-line-1);
	}

	.frame-handle {
		position: absolute;
		top: 6px;
		transform: translateX(-50%);
		width: 20px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 1px solid var(--color-line-1);
		border-radius: var(--r-2);
		background: var(--color-bg-2);
		color: var(--color-fg-2);
		cursor: grab;
		touch-action: none;
		transition:
			background-color 120ms var(--ease-out),
			border-color 120ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.frame-handle:active {
		cursor: grabbing;
		transform: translateX(-50%) scale(0.96);
	}

	.frame-handle.is-active {
		background: color-mix(in oklab, var(--color-accent) 26%, var(--color-bg-2));
		border-color: color-mix(in oklab, var(--color-accent) 55%, var(--color-line-1));
		color: var(--color-fg-0);
	}

	.frame-index {
		font-size: 10px;
	}

	.frame-fields {
		display: flex;
		align-items: flex-end;
		gap: var(--sp-3);
		flex-wrap: wrap;
	}

	.hint {
		font-size: 10px;
		color: var(--color-fg-3);
	}

	.preview-strip {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
		padding: var(--sp-2) var(--sp-3);
		border-bottom: 1px solid var(--color-line-0);
		background: var(--color-bg-1);
		flex-wrap: wrap;
	}

	.play {
		display: flex;
		align-items: center;
		gap: 6px;
		height: var(--h-control);
		padding: 0 var(--sp-3);
		border: 1px solid color-mix(in oklab, var(--color-accent) 55%, var(--color-line-1));
		border-radius: var(--r-2);
		background: color-mix(in oklab, var(--color-accent) 22%, var(--color-bg-2));
		color: var(--color-fg-0);
		font-size: 11px;
		cursor: pointer;
		transition:
			background-color 130ms var(--ease-out),
			transform 120ms var(--ease-out);
	}

	.play:hover {
		background: color-mix(in oklab, var(--color-accent) 34%, var(--color-bg-2));
	}

	.play:active {
		transform: scale(0.97);
	}

	.play:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.preview-canvas {
		position: relative;
		flex: 1;
		min-width: 180px;
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-2);
		background: var(--color-ed-0);
		overflow: hidden;
	}

	.preview-canvas canvas {
		display: block;
		width: 100%;
		height: 44px;
	}

	.preview-caption {
		font-size: 10px;
		color: var(--color-fg-2);
		white-space: nowrap;
	}

	.slider-row {
		display: flex;
		align-items: center;
		gap: var(--sp-3);
	}

	.slider-row .label {
		width: 108px;
	}

	.slider-row .num {
		width: 62px;
		text-align: right;
	}

	.morph-row {
		flex: 1;
		min-width: 200px;
	}

	.morph-row .label {
		width: auto;
	}

	.empty {
		padding: var(--sp-5);
		color: var(--color-fg-2);
		font-size: 12px;
	}

	@media (max-width: 1200px) {
		.library {
			width: 196px;
		}
	}
</style>
