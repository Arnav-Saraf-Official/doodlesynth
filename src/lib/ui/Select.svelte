<script lang="ts">
	interface Option {
		value: string;
		label: string;
		group?: string;
		disabled?: boolean;
	}

	interface Props {
		value: string;
		options: Option[];
		label?: string;
		ariaLabel?: string;
		disabled?: boolean;
		width?: string;
		onchange?: (value: string) => void;
	}

	let {
		value = $bindable(),
		options,
		label,
		ariaLabel,
		disabled = false,
		width = '100%',
		onchange
	}: Props = $props();

	interface OptionGroup {
		group: string;
		items: Option[];
	}

	/** Group options in order, keeping ungrouped options under the empty key. */
	function groupOptions(list: Option[]): OptionGroup[] {
		const groups: OptionGroup[] = [];
		for (const option of list) {
			const name = option.group ?? '';
			let entry = groups.find((candidate) => candidate.group === name);
			if (!entry) {
				entry = { group: name, items: [] };
				groups.push(entry);
			}
			entry.items.push(option);
		}
		return groups;
	}

	const groups = $derived(groupOptions(options));

	function handleChange(event: Event) {
		value = (event.currentTarget as HTMLSelectElement).value;
		onchange?.(value);
	}
</script>

<label class="select-field" class:is-disabled={disabled} style="width:{width}">
	{#if label}
		<span class="select-label">{label}</span>
	{/if}
	<span class="select-shell">
		<select
			class="num"
			{disabled}
			{value}
			aria-label={ariaLabel ?? label ?? 'select'}
			onchange={handleChange}
		>
			{#each groups as group (group.group)}
				{#if group.group}
					<optgroup label={group.group}>
						{#each group.items as option (option.value)}
							<option value={option.value} disabled={option.disabled}>{option.label}</option>
						{/each}
					</optgroup>
				{:else}
					{#each group.items as option (option.value)}
						<option value={option.value} disabled={option.disabled}>{option.label}</option>
					{/each}
				{/if}
			{/each}
		</select>
		<svg class="chevron" viewBox="0 0 10 6" aria-hidden="true">
			<path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" />
		</svg>
	</span>
</label>

<style>
	.select-field {
		display: block;
		min-width: 0;
	}

	.select-label {
		display: block;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--color-fg-2);
		margin-bottom: 2px;
	}

	.select-shell {
		position: relative;
		display: block;
	}

	select {
		width: 100%;
		height: var(--h-row);
		padding: 0 20px 0 var(--sp-2);
		border: 1px solid var(--color-line-0);
		border-radius: var(--r-1);
		background: var(--color-bg-1);
		color: var(--color-fg-0);
		font-size: 12px;
		appearance: none;
		cursor: pointer;
		transition:
			border-color 120ms var(--ease-out),
			background-color 120ms var(--ease-out);
	}

	select:hover:not(:disabled) {
		border-color: var(--color-line-1);
		background: var(--color-bg-2);
	}

	select:focus-visible {
		border-color: var(--color-accent);
	}

	.chevron {
		position: absolute;
		right: 7px;
		top: 50%;
		transform: translateY(-50%);
		width: 10px;
		height: 6px;
		color: var(--color-fg-2);
		pointer-events: none;
	}

	.is-disabled {
		opacity: 0.45;
	}
</style>
