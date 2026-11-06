<script lang="ts">
	/** The row of variable pickers above the panels. Owns each query variable's loaded options. */
	import type { DashboardVariable, QueryVariables } from '@skiff/contracts';
	import type { Names } from './series.js';
	import type { ResolvedRange } from './time.js';
	import VariablePicker from './VariablePicker.svelte';

	let {
		variables,
		values,
		range,
		names,
		options = $bindable({}),
		onchange
	}: {
		variables: DashboardVariable[];
		values: QueryVariables;
		range: ResolvedRange | null;
		names?: Names;
		options?: Record<string, string[]>;
		onchange: (name: string, current: string[]) => void;
	} = $props();

	function others(name: string): QueryVariables {
		return Object.fromEntries(Object.entries(values).filter(([key]) => key !== name));
	}

	function report(name: string, list: string[]) {
		const previous = options[name];
		if (
			previous &&
			previous.length === list.length &&
			previous.every((item, index) => item === list[index])
		)
			return;
		options = { ...options, [name]: list };
	}
</script>

{#if variables.length > 0}
	<div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Dashboard variables">
		{#each variables as variable (variable.name)}
			<VariablePicker
				{variable}
				{range}
				variables={others(variable.name)}
				{names}
				onchange={(current) => onchange(variable.name, current)}
				onoptions={report}
			/>
		{/each}
	</div>
{/if}
