<script lang="ts">
	/**
	 * A panel's query: the Builder tab for everyone, the SQL tab (Monaco, ClickHouse SQL with
	 * macros) for callers allowed to run SQL. "Edit as SQL" starts from the SQL the builder last
	 * produced.
	 */
	import type { ObservabilitySchema, PanelQuery } from '@yoal/contracts';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import CodeXmlIcon from '@lucide/svelte/icons/code-xml';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import BuilderEditor from './BuilderEditor.svelte';
	import CodeEditor from './CodeEditor.svelte';
	import { defaultBuilder } from './panel.js';
	import { builderSqlToMacros } from './sql-convert.js';
	import Popover from './Popover.svelte';
	import type { ResolvedRange } from './time.js';

	let {
		query,
		schema,
		range,
		variableNames = [],
		lastSql = null,
		running = false,
		onchange,
		onrun,
		editorClass = 'h-56'
	}: {
		query: PanelQuery;
		schema: ObservabilitySchema | undefined;
		range: ResolvedRange | null;
		variableNames?: string[];
		/** The SQL the last run executed (`result.sql`). */
		lastSql?: string | null;
		running?: boolean;
		onchange: (query: PanelQuery) => void;
		onrun: () => void;
		editorClass?: string;
	} = $props();

	const canSql = $derived(schema?.canUseSql ?? false);
	let showSql = $state(false);
	let sqlText = $state('');
	let editor: CodeEditor | undefined = $state();

	$effect(() => {
		if (query.mode === 'sql' && query.sql !== sqlText) sqlText = query.sql;
	});

	function toSql() {
		if (!canSql) return;
		const dataset = schema?.datasets.find(
			(item) => query.mode === 'builder' && item.name === query.builder.dataset
		);
		const table = dataset?.tables.minute ?? schema?.tables[0]?.name ?? 'table';
		const sql =
			lastSql && query.mode === 'builder'
				? `-- Converted from the builder; the range follows the dashboard.\n${builderSqlToMacros(lastSql, query.builder)}`
				: `SELECT\n  $__timeInterval(bucket) AS time,\n  count() AS value\nFROM ${table}\nWHERE $__timeFilter(bucket)\nGROUP BY time\nORDER BY time`;
		sqlText = sql;
		onchange({ mode: 'sql', sql });
	}

	function toBuilder() {
		const dataset = schema?.datasets[0];
		onchange({ mode: 'builder', builder: defaultBuilder(dataset) });
	}

	function setSql(text: string) {
		sqlText = text;
		if (text.trim()) onchange({ mode: 'sql', sql: text });
	}

	export function insert(text: string) {
		editor?.insert(text);
	}

	const MACROS = [
		['$__timeFilter(col)', 'col >= range start AND col < range end'],
		['$__timeInterval(col)', 'col rounded down to the panel interval; use it as the time column'],
		['$__fromTime / $__toTime', 'Range start and end as DateTime'],
		['$__interval_s', 'Panel interval in seconds'],
		['$var or ${var}', 'Dashboard variable: strings are quoted, multi-value becomes a tuple for IN']
	];
</script>

<div class="flex min-h-0 flex-col gap-3">
	<div class="flex flex-wrap items-center gap-2">
		<div class="inline-flex rounded-lg bg-muted p-0.5" role="tablist" aria-label="Query mode">
			<button
				type="button"
				role="tab"
				aria-selected={query.mode === 'builder'}
				class="rounded-md px-3 py-1 text-xs font-medium {query.mode === 'builder'
					? 'bg-background shadow-xs'
					: 'text-muted-foreground hover:text-foreground'}"
				onclick={() => query.mode !== 'builder' && toBuilder()}
			>
				Builder
			</button>
			{#if canSql}
				<button
					type="button"
					role="tab"
					aria-selected={query.mode === 'sql'}
					class="rounded-md px-3 py-1 text-xs font-medium {query.mode === 'sql'
						? 'bg-background shadow-xs'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => query.mode !== 'sql' && toSql()}
				>
					SQL
				</button>
			{:else}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<span
								{...props}
								role="tab"
								aria-selected="false"
								aria-disabled="true"
								tabindex="0"
								class="cursor-not-allowed rounded-md px-3 py-1 text-xs font-medium text-muted-foreground/60"
								>SQL</span
							>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content
						>SQL queries are for platform admins: they read every organisation's data.</Tooltip.Content
					>
				</Tooltip.Root>
			{/if}
		</div>
		{#if query.mode === 'sql'}
			<Popover align="start" class="w-96">
				{#snippet trigger({ props })}
					<Button {...props} variant="ghost" size="sm"><CircleHelpIcon />Macros</Button>
				{/snippet}
				<p class="mb-2 text-sm font-medium">SQL macros</p>
				<dl class="space-y-1.5 text-xs">
					{#each MACROS as [name, doc] (name)}
						<div>
							<dt class="font-mono text-foreground">{name}</dt>
							<dd class="text-muted-foreground">{doc}</dd>
						</div>
					{/each}
				</dl>
				<p class="mt-2 text-xs text-muted-foreground">
					Time columns come back as epoch milliseconds. Runs read-only, with resource limits.
				</p>
			</Popover>
		{/if}
		<span class="ml-auto flex items-center gap-2">
			{#if query.mode === 'sql'}
				<span class="hidden text-xs text-muted-foreground sm:inline"
					><Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to run</span
				>
			{/if}
			<Button size="sm" onclick={onrun} disabled={running}>
				{#if running}<Spinner />{:else}<PlayIcon />{/if}
				Run
			</Button>
		</span>
	</div>

	{#if query.mode === 'builder'}
		<BuilderEditor
			builder={query.builder}
			{schema}
			{range}
			{variableNames}
			onchange={(builder) => onchange({ mode: 'builder', builder })}
		/>
		<div class="flex flex-wrap items-center gap-2 border-t pt-2">
			<button
				type="button"
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				aria-expanded={showSql}
				onclick={() => (showSql = !showSql)}
			>
				<ChevronRightIcon class="size-3.5 transition-transform {showSql ? 'rotate-90' : ''}" />
				View SQL
			</button>
			{#if canSql}
				<Button variant="ghost" size="xs" onclick={toSql}><CodeXmlIcon />Edit as SQL</Button>
			{/if}
		</div>
		{#if showSql}
			<pre
				class="max-h-48 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap">{lastSql ??
					'Run the query to see its SQL.'}</pre>
		{/if}
	{:else}
		<CodeEditor
			bind:this={editor}
			bind:value={() => sqlText, setSql}
			{schema}
			variables={variableNames}
			onrun={() => onrun()}
			class={editorClass}
		/>
	{/if}
</div>
