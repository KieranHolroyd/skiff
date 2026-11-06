<script lang="ts">
	/**
	 * A duration as an amount and a unit (sec/min/hours/days), stored in seconds. Starts on the
	 * largest unit that divides the value exactly, so 300 shows as "5 min".
	 */
	import { untrack } from 'svelte';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { DURATION_UNITS, splitDuration } from './rules.js';

	let {
		value = $bindable(0),
		label,
		help,
		error,
		units = ['min', 'hours'],
		id
	}: {
		/** Seconds. */
		value?: number;
		label: string;
		help?: string;
		error?: string;
		/** Unit labels to offer, from `DURATION_UNITS`. */
		units?: string[];
		id: string;
	} = $props();

	const offered = $derived(DURATION_UNITS.filter((unit) => units.includes(unit.label)));
	const initial = untrack(() =>
		splitDuration(
			value,
			DURATION_UNITS.filter((unit) => units.includes(unit.label))
		)
	);
	let amount = $state(String(initial.amount));
	let unitLabel = $state(initial.unit.label);

	function commit() {
		const unit = offered.find((item) => item.label === unitLabel) ?? offered[0]!;
		const number = Number(amount);
		value = Number.isFinite(number) && number >= 0 ? Math.round(number * unit.seconds) : 0;
	}
</script>

<div class="space-y-1">
	<label for={id} class="block text-sm font-medium">{label}</label>
	<div class="flex items-center gap-1.5">
		<Input
			{id}
			type="number"
			min="0"
			step="any"
			inputmode="decimal"
			class="h-8 w-24 tabular-nums"
			bind:value={() => amount, (next) => ((amount = String(next ?? '')), commit())}
			aria-invalid={error ? true : undefined}
			aria-describedby={help || error ? `${id}-help` : undefined}
		/>
		<NativeSelect.Root
			bind:value={() => unitLabel, (next) => ((unitLabel = next ?? unitLabel), commit())}
			aria-label="{label} unit"
		>
			{#each offered as unit (unit.label)}
				<NativeSelect.Option value={unit.label}>{unit.label}</NativeSelect.Option>
			{/each}
		</NativeSelect.Root>
	</div>
	{#if error}
		<p id="{id}-help" class="text-xs text-destructive">{error}</p>
	{:else if help}
		<p id="{id}-help" class="text-xs text-muted-foreground">{help}</p>
	{/if}
</div>
