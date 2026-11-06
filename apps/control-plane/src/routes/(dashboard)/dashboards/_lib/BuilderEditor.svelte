<script lang="ts">
	/**
	 * The structured query builder: dataset, metrics (with aggregations that fit each field
	 * kind), group by, filters, time bucketing, order and limit. Every change is reported up as
	 * a new `BuilderSpec`; the caller runs it.
	 */
	import {
		builderIntervals,
		type BuilderMetric,
		type BuilderSpec,
		type MetricAggregation,
		type ObservabilityDataset,
		type ObservabilitySchema
	} from '@skiff/contracts';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import FilterRow from './FilterRow.svelte';
	import { AGG_LABELS, aggregationsFor, defaultBuilder, measureOf, metricColumn } from './panel.js';
	import type { ResolvedRange } from './time.js';

	let {
		builder,
		schema,
		range,
		variableNames = [],
		onchange
	}: {
		builder: BuilderSpec;
		schema: ObservabilitySchema | undefined;
		range: ResolvedRange | null;
		variableNames?: string[];
		onchange: (builder: BuilderSpec) => void;
	} = $props();

	const dataset = $derived(schema?.datasets.find((item) => item.name === builder.dataset));
	const update = (patch: Partial<BuilderSpec>) => onchange({ ...builder, ...patch });

	function setDataset(name: ObservabilityDataset) {
		const next = schema?.datasets.find((item) => item.name === name);
		onchange({
			...defaultBuilder(next),
			dataset: name,
			timeSeries: builder.timeSeries,
			interval: builder.interval
		});
	}

	function setMetric(index: number, patch: Partial<BuilderMetric>) {
		const metrics = builder.metrics.map((metric, at) => {
			if (at !== index) return metric;
			const next = { ...metric, ...patch };
			if (patch.field) {
				const allowed = aggregationsFor(measureOf(dataset, patch.field)?.kind ?? 'counter');
				if (!allowed.includes(next.agg)) next.agg = allowed[0]!;
			}
			if (next.alias === '') delete next.alias;
			return next;
		});
		update({ metrics });
	}

	function addMetric() {
		const used = new Set(builder.metrics.map((metric) => metric.field));
		const measure = dataset?.measures.find((item) => !used.has(item.name)) ?? dataset?.measures[0];
		if (!measure) return;
		update({
			metrics: [...builder.metrics, { field: measure.name, agg: aggregationsFor(measure.kind)[0]! }]
		});
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
		if (!field) return;
		update({ filters: [...builder.filters, { field, op: 'eq', value: '' }] });
	}

	/** Columns the result can be ordered by: metric aliases/fields and group-by dimensions. */
	const orderable = $derived([
		...builder.metrics.map((metric) => metricColumn(metric, dataset)),
		...builder.groupBy,
		...(builder.timeSeries ? ['time'] : [])
	]);
</script>

<div class="grid gap-4 text-sm">
	<div class="flex flex-wrap items-end gap-4">
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
		<label class="flex h-8 items-center gap-2">
			<Switch
				checked={builder.timeSeries}
				onCheckedChange={(checked) => update({ timeSeries: checked })}
				aria-label="Time series"
			/>
			<span class="text-xs">Time series</span>
		</label>
		{#if builder.timeSeries}
			<label class="space-y-1">
				<span class="block text-xs font-medium text-muted-foreground">Interval</span>
				<NativeSelect.Root
					value={builder.interval}
					aria-label="Interval"
					onchange={(event) =>
						update({ interval: event.currentTarget.value as BuilderSpec['interval'] })}
				>
					{#each builderIntervals as interval (interval)}
						<NativeSelect.Option value={interval}>{interval}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			</label>
		{/if}
		{#if dataset?.description}
			<p class="min-w-48 flex-1 self-center text-xs text-muted-foreground">{dataset.description}</p>
		{/if}
	</div>

	<fieldset class="space-y-1.5">
		<legend class="mb-1.5 text-xs font-medium text-muted-foreground">Metrics</legend>
		{#each builder.metrics as metric, index (index)}
			{@const measure = measureOf(dataset, metric.field)}
			<div class="flex flex-wrap items-center gap-1.5">
				<NativeSelect.Root
					size="sm"
					value={metric.field}
					aria-label="Metric field"
					onchange={(event) => setMetric(index, { field: event.currentTarget.value })}
				>
					{#each dataset?.measures ?? [] as item (item.name)}
						<NativeSelect.Option value={item.name}>{item.label} · {item.kind}</NativeSelect.Option>
					{:else}
						<NativeSelect.Option value={metric.field}>{metric.field}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				{#if measure?.kind !== 'derived'}
					<NativeSelect.Root
						size="sm"
						value={metric.agg}
						aria-label="Aggregation"
						onchange={(event) =>
							setMetric(index, { agg: event.currentTarget.value as MetricAggregation })}
					>
						{#each aggregationsFor(measure?.kind ?? 'counter') as agg (agg)}
							<NativeSelect.Option value={agg}>{AGG_LABELS[agg]}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				{:else}
					<Badge variant="neutral">derived</Badge>
				{/if}
				<Input
					class="h-7 w-36 font-mono text-xs"
					placeholder="alias"
					value={metric.alias ?? ''}
					aria-label="Alias"
					onchange={(event) =>
						setMetric(index, { alias: event.currentTarget.value.trim().toLowerCase() })}
				/>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Remove metric"
					onclick={() => update({ metrics: builder.metrics.filter((_, at) => at !== index) })}
				>
					<XIcon />
				</Button>
				{#if measure?.description}<span class="text-xs text-muted-foreground"
						>{measure.description}</span
					>{/if}
			</div>
		{:else}
			<p class="text-xs text-muted-foreground">
				No metrics: the query lists the distinct group-by values.
			</p>
		{/each}
		<Button variant="outline" size="sm" onclick={addMetric} disabled={builder.metrics.length >= 12}
			><PlusIcon />Metric</Button
		>
	</fieldset>

	<fieldset>
		<legend class="mb-1.5 text-xs font-medium text-muted-foreground">Group by</legend>
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

	<div class="flex flex-wrap items-end gap-3">
		<label class="space-y-1">
			<span class="block text-xs font-medium text-muted-foreground">Order by</span>
			<NativeSelect.Root
				size="sm"
				value={builder.orderBy?.field ?? ''}
				aria-label="Order by"
				onchange={(event) => {
					const field = event.currentTarget.value;
					update({ orderBy: field ? { field, dir: builder.orderBy?.dir ?? 'desc' } : undefined });
				}}
			>
				<NativeSelect.Option value="">Default</NativeSelect.Option>
				{#each orderable as field (field)}
					<NativeSelect.Option value={field}>{field}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		{#if builder.orderBy}
			<NativeSelect.Root
				size="sm"
				value={builder.orderBy.dir}
				aria-label="Direction"
				onchange={(event) =>
					update({
						orderBy: {
							field: builder.orderBy!.field,
							dir: event.currentTarget.value as 'asc' | 'desc'
						}
					})}
			>
				<NativeSelect.Option value="desc">Descending</NativeSelect.Option>
				<NativeSelect.Option value="asc">Ascending</NativeSelect.Option>
			</NativeSelect.Root>
		{/if}
		<label class="space-y-1">
			<span class="block text-xs font-medium text-muted-foreground">Limit</span>
			<Input
				type="number"
				min="1"
				max="10000"
				class="h-7 w-24 text-xs"
				value={builder.limit ?? ''}
				placeholder="none"
				aria-label="Limit"
				onchange={(event) => {
					const limit = Number(event.currentTarget.value);
					update({
						limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10_000) : undefined
					});
				}}
			/>
		</label>
	</div>
</div>
