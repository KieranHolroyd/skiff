<script lang="ts">
	/** One builder filter: field, operator and value, with value suggestions for dimensions. */
	import {
		filterOperators,
		type BuilderFilter,
		type DatasetInfo,
		type FilterOperator,
		type QueryResult
	} from '@skiff/contracts';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { createPanelQuery } from './panel-query.svelte.js';
	import { labelValue, type Names } from './series.js';
	import type { ResolvedRange } from './time.js';

	let {
		filter,
		dataset,
		range,
		names,
		variableNames,
		onchange,
		onremove
	}: {
		filter: BuilderFilter;
		dataset: DatasetInfo | undefined;
		range: ResolvedRange | null;
		names?: Names;
		variableNames: string[];
		onchange: (filter: BuilderFilter) => void;
		onremove: () => void;
	} = $props();

	const OP_LABELS: Record<FilterOperator, string> = {
		eq: '=',
		neq: '≠',
		in: 'in',
		nin: 'not in',
		contains: 'contains',
		gt: '>',
		gte: '≥',
		lt: '<',
		lte: '≤'
	};

	const isDimension = $derived(
		dataset?.dimensions.some((dimension) => dimension.name === filter.field) ?? false
	);
	const list = $derived(filter.op === 'in' || filter.op === 'nin');
	const text = $derived(
		Array.isArray(filter.value) ? filter.value.join(', ') : String(filter.value ?? '')
	);

	const suggestions = createPanelQuery(() => ({
		query:
			dataset && isDimension
				? {
						mode: 'builder',
						builder: {
							dataset: dataset.name,
							metrics: [],
							groupBy: [filter.field],
							filters: [],
							timeSeries: false,
							interval: 'auto',
							limit: 200
						}
					}
				: undefined,
		range,
		width: 600,
		variables: {}
	}));
	const values = $derived(
		((suggestions.data as QueryResult | undefined)?.rows ?? [])
			.map((row) => row[0])
			.filter((value) => value !== null && value !== '')
			.map((value) => String(value))
	);
	const listId = `filter-values-${Math.random().toString(36).slice(2, 8)}`;

	function setValue(raw: string) {
		if (list) {
			onchange({
				...filter,
				value: raw
					.split(',')
					.map((item) => item.trim())
					.filter(Boolean)
			});
			return;
		}
		const numeric =
			!isDimension &&
			raw.trim() !== '' &&
			!raw.trim().startsWith('$') &&
			Number.isFinite(Number(raw));
		onchange({ ...filter, value: numeric ? Number(raw) : raw });
	}

	function setOp(op: FilterOperator) {
		const toList = op === 'in' || op === 'nin';
		const value = toList
			? Array.isArray(filter.value)
				? filter.value
				: String(filter.value ?? '')
						.split(',')
						.map((item) => item.trim())
						.filter(Boolean)
			: Array.isArray(filter.value)
				? (filter.value[0] ?? '')
				: filter.value;
		onchange({ ...filter, op, value });
	}
</script>

<div class="flex flex-wrap items-center gap-1.5">
	<NativeSelect.Root
		size="sm"
		value={filter.field}
		aria-label="Filter field"
		onchange={(event) => onchange({ ...filter, field: event.currentTarget.value })}
	>
		{#each dataset?.dimensions ?? [] as dimension (dimension.name)}
			<NativeSelect.Option value={dimension.name}>{dimension.label}</NativeSelect.Option>
		{/each}
	</NativeSelect.Root>
	<NativeSelect.Root
		size="sm"
		value={filter.op}
		aria-label="Operator"
		onchange={(event) => setOp(event.currentTarget.value as FilterOperator)}
	>
		{#each filterOperators as op (op)}
			<NativeSelect.Option value={op}>{OP_LABELS[op]}</NativeSelect.Option>
		{/each}
	</NativeSelect.Root>
	<Input
		class="h-7 w-48 font-mono text-xs"
		value={text}
		list={listId}
		placeholder={list ? 'a, b, $var' : 'value or $var'}
		aria-label="Filter value"
		onchange={(event) => setValue(event.currentTarget.value)}
	/>
	<datalist id={listId}>
		{#each variableNames as name (name)}<option value="${name}"></option>{/each}
		{#each values as value (value)}<option {value}>{labelValue(filter.field, value, names)}</option
			>{/each}
	</datalist>
	<Button variant="ghost" size="icon-sm" aria-label="Remove filter" onclick={onremove}
		><XIcon /></Button
	>
</div>
