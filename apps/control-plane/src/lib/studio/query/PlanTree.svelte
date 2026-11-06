<script lang="ts">
	import Self from './PlanTree.svelte';

	/** A JSON plan (Postgres `EXPLAIN (FORMAT JSON)`, Mongo `explain`) as a collapsible tree. */
	let {
		value,
		name,
		depth = 0
	}: {
		value: unknown;
		name?: string;
		depth?: number;
	} = $props();

	const isArray = $derived(Array.isArray(value));
	const isObject = $derived(value !== null && typeof value === 'object');
	const entries = $derived<Array<[string, unknown]>>(
		isArray
			? (value as unknown[]).map((item, index) => [String(index), item])
			: isObject
				? Object.entries(value as Record<string, unknown>)
				: []
	);

	/** A one-line hint for a closed node: Postgres plan nodes show their type and relation. */
	const summary = $derived.by(() => {
		if (isArray) return `[${entries.length}]`;
		const record = value as Record<string, unknown>;
		const type = record['Node Type'] ?? record['stage'];
		const relation = record['Relation Name'] ?? record['indexName'];
		const cost = record['Total Cost'];
		return [
			type,
			relation ? `on ${String(relation)}` : '',
			cost !== undefined ? `cost ${String(cost)}` : ''
		]
			.filter(Boolean)
			.join(' ');
	});

	function scalar(item: unknown): string {
		return typeof item === 'string' ? item : JSON.stringify(item);
	}
</script>

{#if isObject}
	<details open={depth < 4} class="font-mono text-xs">
		<summary class="cursor-pointer rounded px-1 py-0.5 select-none hover:bg-muted">
			{#if name !== undefined}<span class="text-muted-foreground">{name}</span>{/if}
			{#if summary}<span class="ml-1">{summary}</span>{/if}
		</summary>
		<div class="ml-3 border-l pl-2">
			{#each entries as [key, item] (key)}
				<Self value={item} name={key} depth={depth + 1} />
			{/each}
		</div>
	</details>
{:else}
	<div class="px-1 py-0.5 font-mono text-xs">
		{#if name !== undefined}<span class="text-muted-foreground">{name}:</span>{/if}
		<span class="break-all">{scalar(value)}</span>
	</div>
{/if}
