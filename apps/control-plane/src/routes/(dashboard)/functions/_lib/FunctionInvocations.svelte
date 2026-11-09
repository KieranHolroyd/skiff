<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { FunctionInvocationRow } from '@yoal/core';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { outcomeTone } from './invocations.js';

	/**
	 * Recent invocations from the host's tail worker (docs/FUNCTIONS.md §4.5, phase 3): one row per
	 * fetch, scheduled or queue event with its outcome, request line, console output and
	 * exceptions. Request headers, cookies and bodies are never recorded.
	 */
	let {
		invocations,
		canRead
	}: {
		invocations: Promise<{ available: boolean; rows: FunctionInvocationRow[] }>;
		canRead: boolean;
	} = $props();

	let outcome = $state<string>('all');
	let open = $state<Record<number, boolean>>({});
</script>

{#if !canRead}
	<EmptyState
		icon={ActivityIcon}
		title="Invocations need logs access"
		description="Invocation records carry console output, so they need the logs:read permission."
	/>
{:else}
	{#await invocations}
		<div class="space-y-2">
			{#each [0, 1, 2, 3] as index (index)}
				<Skeleton class="h-12 w-full" />
			{/each}
		</div>
	{:then result}
		{@const outcomes = [...new Set(result.rows.map((row) => row.outcome))].sort()}
		{@const rows =
			outcome === 'all' ? result.rows : result.rows.filter((row) => row.outcome === outcome)}
		{#if !result.available}
			<EmptyState
				icon={ActivityIcon}
				title="Telemetry is unavailable"
				description="Invocations are recorded in the ClickHouse telemetry store. Install or start it under Settings → Telemetry to see them."
			/>
		{:else if result.rows.length === 0}
			<EmptyState
				icon={ActivityIcon}
				title="No invocations in the last 7 days"
				description="Each host's tail worker records every request, cron run and queue batch here, with its outcome and console output. Records are kept for 30 days."
			/>
		{:else}
			<div class="space-y-3">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<div class="flex flex-wrap gap-1" role="group" aria-label="Filter by outcome">
						{#each ['all', ...outcomes] as value (value)}
							<button
								type="button"
								class="rounded-md border px-2.5 py-1 text-xs transition-colors {outcome === value
									? 'border-foreground/25 bg-muted font-medium'
									: 'text-muted-foreground hover:bg-muted/60'}"
								aria-pressed={outcome === value}
								onclick={() => (outcome = value)}
							>
								{value === 'all' ? 'All' : value}
								<span class="ml-1 font-mono opacity-70"
									>{value === 'all'
										? result.rows.length
										: result.rows.filter((row) => row.outcome === value).length}</span
								>
							</button>
						{/each}
					</div>
					<p class="text-xs text-muted-foreground">
						Newest {result.rows.length} of the last 7 days · kept 30 days
					</p>
				</div>

				<ul class="divide-y overflow-hidden rounded-xl border bg-card">
					{#each rows as row, index (`${row.at}-${index}`)}
						{@const expandable = row.logs.length > 0 || row.exceptions.length > 0}
						{@const tone = outcomeTone(row.outcome)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors {expandable
									? 'hover:bg-muted/40'
									: 'cursor-default'}"
								aria-expanded={expandable ? Boolean(open[index]) : undefined}
								disabled={!expandable}
								onclick={() => (open = { ...open, [index]: !open[index] })}
							>
								<ChevronRightIcon
									class="size-3.5 shrink-0 text-muted-foreground transition-transform {open[index]
										? 'rotate-90'
										: ''} {expandable ? '' : 'opacity-0'}"
								/>
								<Badge variant={tone} class="shrink-0 font-mono text-[11px]">{row.outcome}</Badge>
								<span class="min-w-0 flex-1 truncate font-mono text-xs">
									{#if row.request}
										<span class="text-muted-foreground">{row.request.method}</span>
										{row.request.url}
										{#if row.request.status !== undefined}
											<span
												class={row.request.status >= 500
													? 'text-destructive'
													: row.request.status >= 400
														? 'text-warning'
														: 'text-muted-foreground'}>{row.request.status}</span
											>
										{/if}
									{:else}
										<span class="text-muted-foreground"
											>{row.scriptName || 'scheduled or queue event'}</span
										>
									{/if}
								</span>
								{#if row.exceptions.length > 0}
									<span class="hidden text-xs text-destructive sm:inline"
										>{row.exceptions.length} exception{row.exceptions.length === 1 ? '' : 's'}</span
									>
								{:else if row.logs.length > 0}
									<span class="hidden text-xs text-muted-foreground sm:inline"
										>{row.logs.length} log line{row.logs.length === 1 ? '' : 's'}</span
									>
								{/if}
								<time
									class="shrink-0 text-xs text-muted-foreground"
									datetime={row.at}
									title={formatDateTime(row.at)}>{formatRelative(row.at)}</time
								>
							</button>
							{#if open[index]}
								<div class="space-y-2 border-t bg-muted/30 px-4 py-3 pl-11">
									{#each row.exceptions as exception, i (i)}
										<p class="font-mono text-xs break-words text-destructive">
											<span class="font-semibold">{exception.name}</span>: {exception.message}
										</p>
									{/each}
									{#if row.logs.length > 0}
										<pre
											class="overflow-x-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">{#each row.logs as line, i (i)}<span
													class={line.level === 'error'
														? 'text-destructive'
														: line.level === 'warn'
															? 'text-warning'
															: 'text-foreground'}
													><span class="text-muted-foreground select-none"
														>{line.level.padEnd(5)}</span
													> {line.message}
</span>{/each}</pre>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/await}
{/if}
