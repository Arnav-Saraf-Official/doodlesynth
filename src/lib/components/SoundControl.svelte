<script lang="ts">
	let {
		label,
		value,
		min = 0,
		max = 1,
		step = 0.01,
		unit = '',
		onchange
	}: {
		label: string;
		value: number;
		min?: number;
		max?: number;
		step?: number;
		unit?: string;
		onchange: (value: number) => void;
	} = $props();
	const display = $derived(
		step >= 1 ? value.toFixed(0) : step >= 0.1 ? value.toFixed(1) : value.toFixed(2)
	);
</script>

<label class="control">
	<span>{label}<output>{display}{unit}</output></span>
	<input
		type="range"
		{min}
		{max}
		{step}
		{value}
		oninput={(event) => onchange(Number(event.currentTarget.value))}
	/>
</label>

<style>
	.control {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		color: var(--color-fg-1);
		font-size: 12px;
	}
	span {
		display: flex;
		justify-content: space-between;
		gap: 6px;
	}
	output {
		color: var(--color-fg-0);
		font: 11px var(--font-mono);
		white-space: nowrap;
	}
	input {
		width: 100%;
		height: 20px;
		margin: 0;
		accent-color: var(--module-accent, var(--color-accent));
		cursor: pointer;
	}
</style>
