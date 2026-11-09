<script lang="ts">
	/**
	 * One dashboard variable. Query variables run their query over the dashboard range (other
	 * variables substituted) and offer the distinct values of its first column; custom variables
	 * offer their comma-separated list; textboxes take free text.
	 */
	import type { DashboardVariable, QueryResult, QueryVariables } from '@yoal/contracts';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import { createPanelQuery } from './panel-query.svelte.js';
	import Popover from './Popover.svelte';
	import { labelValue, type Names } from './series.js';
	import type { ResolvedRange } from './time.js';
	import { ALL, customOptions } from './variables.js';

	let {
		variable,
		range,
		variables,
		names,
		onchange,
		onoptions
	}: {
		variable: DashboardVariable;
		range: ResolvedRange | null;
		/** Values of the other variables, for chained queries. */
		variables: QueryVariables;
		names?: Names;
		onchange: (current: string[]) => void;
		onoptions: (name: string, options: string[]) => void;
	} = $props();

	const data = createPanelQuery(() => ({
		query: variable.kind === 'query' ? variable.query : undefined,
		range,
		width: 1500,
		variables,
		enabled: variable.kind === 'query'
	}));

	const firstColumn = $derived((data.data as QueryResult | undefined)?.columns[0]?.name ?? '');
	const options = $derived.by(() => {
		if (variable.kind === 'custom') return customOptions(variable);
		const result = data.data as QueryResult | undefined;
		if (!result) return [];
		return [
			...new Set(
				result.rows
					.map((row) => row[0])
					.filter((value) => value !== null && value !== '')
					.map((value) => String(value))
			)
		];
	});

	$effect(() => {
		onoptions(variable.name, options);
	});

	const display = (value: string) =>
		value === ALL
			? 'All'
			: variable.kind === 'query'
				? labelValue(firstColumn, value, names)
				: value;

	const current = $derived(variable.current ?? []);
	const allSelected = $derived(
		current.includes(ALL) || (current.length === 0 && variable.includeAll)
	);
	const summary = $derived.by(() => {
		if (allSelected) return 'All';
		const picked = current.length > 0 ? current : options.slice(0, 1);
		if (picked.length === 0) return 'None';
		if (picked.length > 2) return `${display(picked[0]!)} +${picked.length - 1}`;
		return picked.map(display).join(', ');
	});

	let open = $state(false);
	let search = $state('');
	const filtered = $derived(
		search
			? options.filter((option) => display(option).toLowerCase().includes(search.toLowerCase()))
			: options
	);

	function choose(value: string) {
		if (!variable.multi || value === ALL) {
			onchange([value]);
			open = false;
			return;
		}
		const base = current.filter((item) => item !== ALL);
		const next = base.includes(value) ? base.filter((item) => item !== value) : [...base, value];
		onchange(next.length === 0 && variable.includeAll ? [ALL] : next);
	}

	const selected = (value: string) =>
		value === ALL
			? allSelected
			: !allSelected && (current.length > 0 ? current.includes(value) : options[0] === value);

	let text = $state('');
	$effect(() => {
		if (variable.kind === 'textbox') text = current[0] ?? '';
	});
	const label = $derived(variable.label || variable.name);
</script>

<div class="flex items-center">
	<span
		class="flex h-8 items-center rounded-l-lg border border-r-0 bg-muted/50 px-2.5 text-xs font-medium text-muted-foreground"
		>{label}</span
	>
	{#if variable.kind === 'textbox'}
		<Input
			class="h-8 w-44 rounded-l-none font-mono text-xs"
			aria-label={label}
			bind:value={text}
			onkeydown={(event) => event.key === 'Enter' && onchange([text])}
			onblur={() => text !== (current[0] ?? '') && onchange([text])}
		/>
	{:else}
		<Popover bind:open align="start" class="w-64 p-1.5">
			{#snippet trigger({ props })}
				<Button
					{...props}
					variant="outline"
					class="max-w-56 rounded-l-none font-normal"
					aria-label="{label}: {summary}"
				>
					<span class="truncate">{summary}</span>
					{#if data.isFetching}<Spinner class="size-3" />{:else}<ChevronDownIcon
							class="text-muted-foreground"
						/>{/if}
				</Button>
			{/snippet}
			{#if options.length > 8}
				<Input
					bind:value={search}
					placeholder="Search values"
					class="mb-1.5 h-7 text-xs"
					aria-label="Search {label}"
				/>
			{/if}
			{#if data.error}
				<p class="px-2 py-1.5 text-xs text-destructive">{errorText(data.error)}</p>
			{/if}
			<ul
				class="max-h-72 overflow-y-auto"
				role="listbox"
				aria-multiselectable={variable.multi}
				aria-label={label}
			>
				{#if variable.includeAll}
					<li>
						<button
							type="button"
							role="option"
							aria-selected={selected(ALL)}
							class="option"
							onclick={() => choose(ALL)}
						>
							<CheckIcon class="size-3.5 {selected(ALL) ? '' : 'invisible'}" />All
						</button>
					</li>
				{/if}
				{#each filtered as option (option)}
					<li>
						<button
							type="button"
							role="option"
							aria-selected={selected(option)}
							class="option"
							onclick={() => choose(option)}
						>
							<CheckIcon class="size-3.5 shrink-0 {selected(option) ? '' : 'invisible'}" />
							<span class="truncate">{display(option)}</span>
						</button>
					</li>
				{:else}
					{#if !data.isFetching}
						<li class="px-2 py-1.5 text-xs text-muted-foreground">No values</li>
					{/if}
				{/each}
			</ul>
		</Popover>
	{/if}
</div>

<style>
	.option {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.375rem;
		padding: 0.25rem 0.5rem;
		text-align: left;
		font-size: 0.8125rem;
	}
	.option:hover,
	.option:focus-visible {
		background: var(--color-muted);
		outline: none;
	}
</style>
