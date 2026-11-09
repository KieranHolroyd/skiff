<script lang="ts">
	/**
	 * The query builder cut down to what an alert evaluates: a dataset, exactly one metric (the
	 * value compared with the threshold), group-by dimensions (one series each) and filters. No
	 * time bucketing, ordering or extra metrics. Filters reuse the dashboards' `FilterRow`.
	 */
	import type {
		BuilderSpec,
		MetricAggregation,
		ObservabilityDataset,
		ObservabilitySchema
	} from '@yoal/contracts';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import FilterRow from '../../dashboards/_lib/FilterRow.svelte';
	import { AGG_LABELS, aggregationsFor, measureOf } from '../../dashboards/_lib/panel.js';
	import type { ResolvedRange } from '../../dashboards/_lib/time.js';

	let {
		builder,
		schema,
		variableNames = [],
		error,
		onchange
	}: {
		builder: BuilderSpec;
		schema: ObservabilitySchema | undefined;
		variableNames?: string[];
		error?: string;
		onchange: (builder: BuilderSpec) => void;
	} = $props();

	const dataset = $derived(schema?.datasets.find((item) => item.name === builder.dataset));
	const metric = $derived(builder.metrics[0]);
	const measure = $derived(metric ? measureOf(dataset, metric.field) : undefined);
	/** Filter value suggestions read the last day. */
	const range: ResolvedRange = { from: Date.now() - 86_400_000, to: Date.now() };

	const update = (patch: Partial<BuilderSpec>) =>
		onchange({ ...builder, ...patch, timeSeries: false });

	function setDataset(name: ObservabilityDataset) {
		const next = schema?.datasets.find((item) => item.name === name);
		const first = next?.measures[0];
		onchange({
			dataset: name,
			metrics: first ? [{ field: first.name, agg: aggregationsFor(first.kind)[0]! }] : [],
			groupBy: [],
			filters: [],
			timeSeries: false,
			interval: 'auto'
		});
	}

	function setField(field: string) {
		const kind = measureOf(dataset, field)?.kind ?? 'counter';
		const allowed = aggregationsFor(kind);
		const agg = metric && allowed.includes(metric.agg) ? metric.agg : allowed[0]!;
		update({ metrics: [{ field, agg }] });
	}

	function setAgg(agg: MetricAggregation) {
		if (metric) update({ metrics: [{ field: metric.field, agg }] });
	}

	function toggleGroup(name: string) {
		const has = builder.groupBy.includes(name);
		if (!has && builder.groupBy.length >= 4) return;
		update({
			groupBy: has ? builder.groupBy.filter((item) => item !== name) : [...builder.groupBy, name]
		});
	}

	function addFilter() {
		const field = dataset?.dimensions[0]?.name ?? dataset?.measures[0]?.name;
		if (field) update({ filters: [...builder.filters, { field, op: 'eq', value: '' }] });
	}
</script>

<div class="grid gap-4 text-sm">
	<div class="flex flex-wrap items-end gap-3">
		<label class="space-y-1">
			<span class="block text-xs font-medium text-muted-foreground">Dataset</span>
			<NativeSelect.Root
				value={builder.dataset}
				aria-label="Dataset"
				onchange={(event) => setDataset(event.currentTarget.value as ObservabilityDataset)}
			>
				{#each schema?.datasets ?? [] as item (item.name)}
					<NativeSelect.Option value={item.name}>{item.label}</NativeSelect.Option>
				{:else}
					<NativeSelect.Option value={builder.dataset}>{builder.dataset}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		<label class="space-y-1">
			<span class="block text-xs font-medium text-muted-foreground">Metric</span>
			<NativeSelect.Root
				value={metric?.field ?? ''}
				aria-label="Metric"
				aria-invalid={error ? true : undefined}
				onchange={(event) => setField(event.currentTarget.value)}
			>
				{#if !metric}<NativeSelect.Option value="">Pick a metric</NativeSelect.Option>{/if}
				{#each dataset?.measures ?? [] as item (item.name)}
					<NativeSelect.Option value={item.name}>{item.label}</NativeSelect.Option>
				{:else}
					{#if metric}<NativeSelect.Option value={metric.field}>{metric.field}</NativeSelect.Option
						>{/if}
				{/each}
			</NativeSelect.Root>
		</label>
		{#if metric}
			{#if measure?.kind === 'derived'}
				<Badge variant="neutral" class="mb-1.5">derived</Badge>
			{:else}
				<label class="space-y-1">
					<span class="block text-xs font-medium text-muted-foreground">Aggregation</span>
					<NativeSelect.Root
						value={metric.agg}
						aria-label="Aggregation"
						onchange={(event) => setAgg(event.currentTarget.value as MetricAggregation)}
					>
						{#each aggregationsFor(measure?.kind ?? 'counter') as agg (agg)}
							<NativeSelect.Option value={agg}>{AGG_LABELS[agg]}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</label>
			{/if}
		{/if}
	</div>
	{#if measure?.description || dataset?.description}
		<p class="-mt-2 text-xs text-muted-foreground">
			{measure?.description ?? dataset?.description}
		</p>
	{/if}
	{#if error}<p class="-mt-2 text-xs text-destructive" role="alert">{error}</p>{/if}

	<fieldset>
		<legend class="mb-1 text-xs font-medium text-muted-foreground">Group by</legend>
		<p class="mb-1.5 text-xs text-muted-foreground">
			Each combination is its own series and alerts on its own. None compares one total.
		</p>
		<div class="flex flex-wrap gap-1.5">
			{#each dataset?.dimensions ?? [] as dimension (dimension.name)}
				{@const on = builder.groupBy.includes(dimension.name)}
				<button
					type="button"
					aria-pressed={on}
					class="rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {on
						? 'border-brand/50 bg-brand/10 text-foreground'
						: 'text-muted-foreground hover:bg-muted'}"
					onclick={() => toggleGroup(dimension.name)}
				>
					{dimension.label}
				</button>
			{/each}
		</div>
	</fieldset>

	<fieldset class="space-y-1.5">
		<legend class="mb-1.5 text-xs font-medium text-muted-foreground">Filters</legend>
		{#each builder.filters as filter, index (index)}
			<FilterRow
				{filter}
				{dataset}
				{range}
				names={schema?.names}
				{variableNames}
				onchange={(next) =>
					update({ filters: builder.filters.map((item, at) => (at === index ? next : item)) })}
				onremove={() => update({ filters: builder.filters.filter((_, at) => at !== index) })}
			/>
		{/each}
		<Button variant="outline" size="sm" onclick={addFilter} disabled={builder.filters.length >= 20}
			><PlusIcon />Filter</Button
		>
	</fieldset>
</div>
