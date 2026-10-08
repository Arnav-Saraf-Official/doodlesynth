<script lang="ts">
	import { clamp } from '#lib/model/pitch';

	interface Props {
		value: number;
		label?: string;
		/** accessible name when the field has no visible label */
		ariaLabel?: string;
		min?: number;
		max?: number;
		step?: number;
		/** digits shown when not focused */
		decimals?: number;
		unit?: string;
		disabled?: boolean;
		width?: string;
		onchange?: (value: number) => void;
	}

	let {
		value = $bindable(),
		label,
		ariaLabel,
		min = -Infinity,
		max = Infinity,
		step = 1,
		decimals = 2,
		unit = '',
		disabled = false,
		width = '72px',
		onchange
	}: Props = $props();

	let editing = $state(false);
	let draft = $state('');
	let dragging = $state(false);
	let startY = 0;
	let startValue = 0;

	const display = $derived(
		editing ? draft : Number.isFinite(value) ? value.toFixed(decimals) : '—'
	);

	function commit(next: number) {
		const clamped = clamp(next, min, max);
		if (clamped !== value) {
			value = clamped;
			onchange?.(clamped);
		}
	}

	function onPointerDown(event: PointerEvent) {
		if (disabled || editing) return;
		// only scrub from the body of the field, never while selecting text
		if ((event.target as HTMLElement).tagName === 'INPUT') return;
		dragging = true;
		startY = event.clientY;
		startValue = value;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (!dragging) return;
		const scale = event.shiftKey ? 0.1 : 1;
		const delta = (startY - event.clientY) * step * scale;
		commit(startValue + delta);
	}

	function onPointerUp(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
	}

	function beginEdit() {
		if (disabled) return;
		draft = value.toFixed(decimals);
		editing = true;
	}

	function endEdit() {
		editing = false;
		const parsed = Number.parseFloat(draft);
		if (Number.isFinite(parsed)) commit(parsed);
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			endEdit();
			(event.target as HTMLInputElement).blur();
		} else if (event.key === 'Escape') {
			editing = false;
			(event.target as HTMLInputElement).blur();
		} else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			const direction = event.key === 'ArrowUp' ? 1 : -1;
			const scale = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
			commit(value + direction * step * scale);
		}
	}
</script>

<label class="field" class:is-disabled={disabled} style="width:{width}">
	{#if label}
		<span class="field-label">{label}</span>
	{/if}
	<span
		class="field-body"
		class:is-dragging={dragging}
		role="presentation"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
	>
		<input
			class="num"
			type="text"
			inputmode="decimal"
			{disabled}
			value={display}
			aria-label={ariaLabel ?? label ?? 'value'}
			oninput={(event) => (draft = (event.currentTarget as HTMLInputElement).value)}
			onfocus={beginEdit}
			onblur={endEdit}
			onkeydown={onKeydown}
			ondblclick={beginEdit}
		/>
		{#if unit}<span class="unit">{unit}</span>{/if}
	</span>
</label>

<style>
	.field {
		display: block;
		min-width: 0;
	}

	.field-label {
		display: block;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-2);
		margin-bottom: 2px;
	}

	.field-body {
		display: flex;
		align-items: center;
		gap: 2px;
		height: var(--h-row);
		padding: 0 var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		cursor: ns-resize;
		transition:
			border-color 120ms var(--ease-out),
			background-color 120ms var(--ease-out);
	}

	.field-body:hover {
		border-color: var(--color-line-1);
	}

	.field-body.is-dragging {
		border-color: color-mix(in oklab, var(--color-accent) 60%, var(--color-line-1));
		background: var(--color-bg-2);
	}

	.field-body:focus-within {
		border-color: var(--color-accent);
	}

	input {
		width: 100%;
		min-width: 0;
		border: none;
		background: transparent;
		color: var(--color-fg-0);
		text-align: right;
		padding: 0;
		cursor: ns-resize;
	}

	input:focus {
		outline: none;
		cursor: text;
	}

	.unit {
		font-size: 10px;
		color: var(--color-fg-2);
		flex: none;
	}

	.is-disabled {
		opacity: 0.45;
	}
</style>
