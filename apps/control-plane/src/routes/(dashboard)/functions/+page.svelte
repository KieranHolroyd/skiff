<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import SearchIcon from '@lucide/svelte/icons/search';
	import Settings2Icon from '@lucide/svelte/icons/settings-2';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { WORKERD_MAX_COMPATIBILITY_DATE, WORKERD_PINNED_VERSION } from '@yoal/contracts';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import DataTable, { type DataColumn } from '#lib/components/yoal/DataTable.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import CodeBlock from '../_lib/CodeBlock.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import Sparkline from '../dashboards/_lib/viz/Sparkline.svelte';
	import { displayUrl, formatDateTime, formatRelative } from '../_lib/format.js';
	import {
		COMPATIBILITY_LAG_WARN_DAYS,
		compatibilityLagDays,
		functionAttention,
		functionStatus,
		type Attention
	} from '../_lib/function-view.js';
	import { purgeCountdown } from '../_lib/operations/copy.js';
	import { compactCount, formatRate, type FunctionMetrics } from './_lib/function-metrics.js';
	import type { FunctionListItem } from './+page.server.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Row = FunctionListItem;
	type Filter = 'all' | 'running' | 'idle' | 'issues' | 'undeployed';

	let query = $state('');
	let filter = $state<Filter>('all');
	let trashOpen = $state(false);

	/** Streamed per-row request metrics; null until the telemetry reads settle. */
	let metrics = $state<Record<string, FunctionMetrics> | null>(null);
	$effect(() => {
		const pending = data.metrics;
		metrics = null;
		let live = true;
		void pending.then(
			(value) => {
				if (live) metrics = value;
			},
			() => {
				if (live) metrics = {};
			}
		);
		return () => {
			live = false;
		};
	});

	const items = $derived(data.items);
	const issuesOf = (row: Row): Attention[] =>
		functionAttention(row).filter((issue) => issue.kind !== 'not-deployed');
	const counts = $derived({
		all: items.length,
		running: items.filter((row) => row.workload?.status === 'running').length,
		idle: items.filter((row) => functionStatus(row.workload, row.view).status === 'idle').length,
		issues: items.filter((row) => issuesOf(row).length > 0).length,
		undeployed: items.filter((row) => row.lastDeploy === null).length
	});
	const failing = $derived(items.filter((row) => row.workload?.status === 'failed').length);
	const reservedMb = $derived(items.reduce((sum, row) => sum + (row.workload?.memoryMb ?? 0), 0));
	/**
	 * Rebuilt when metrics arrive too, so a sort on requests, errors or p95 re-reads the values
	 * instead of keeping the order it computed while they were pending.
	 */
	const rows = $derived.by(() => {
		void metrics;
		return items.filter((row) =>
			filter === 'running'
				? row.workload?.status === 'running'
				: filter === 'idle'
					? functionStatus(row.workload, row.view).status === 'idle'
					: filter === 'issues'
						? issuesOf(row).length > 0
						: filter === 'undeployed'
							? row.lastDeploy === null
							: true
		);
	});

	const filters: Array<{ id: Filter; label: string }> = [
		{ id: 'all', label: 'All' },
		{ id: 'running', label: 'Running' },
		{ id: 'idle', label: 'Idle' },
		{ id: 'issues', label: 'Needs attention' },
		{ id: 'undeployed', label: 'Not deployed' }
	];

	const QUICKSTART =
		'npm create cloudflare@latest my-function -- --type hello-world\ncd my-function\nyoal wrangler dev\nyoal deploy';
	const newHref = resolve('/(dashboard)/functions/new');
	const functionHref = (slug: string) => resolve('/(dashboard)/functions/[slug]', { slug });
	function openSection(slug: string, tab: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route plus ?tab
		void goto(`${functionHref(slug)}?tab=${tab}`);
	}
	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	/** Short chip text for the row; the full sentence is the tooltip. */
	function chip(issue: Attention, row: Row): string {
		switch (issue.kind) {
			case 'failed':
				return 'Host failed';
			case 'missing-secret':
				return `${row.missingSecrets.length} ${row.missingSecrets.length === 1 ? 'secret' : 'secrets'} missing`;
			case 'compat-behind':
				return 'Compatibility date behind';
			case 'older-pin':
				return 'Older workerd pin';
			default:
				return issue.message;
		}
	}

	const metric = (row: Row) => metrics?.[row.slug];
	const columns: DataColumn<Row>[] = [
		{
			id: 'name',
			header: 'Function',
			value: (row) => `${row.name} ${row.slug}`,
			cell: nameCell,
			class: 'pl-4 whitespace-normal'
		},
		{
			id: 'status',
			header: 'Status',
			value: (row) => row.workload?.status ?? 'not deployed',
			searchable: false,
			cell: statusCell,
			class: 'hidden sm:table-cell'
		},
		{
			id: 'requests',
			header: 'Requests · 24h',
			value: (row) => metric(row)?.requests ?? -1,
			searchable: false,
			descFirst: true,
			cell: requestsCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'errors',
			header: 'Errors',
			value: (row) => metric(row)?.errorRate ?? -1,
			searchable: false,
			descFirst: true,
			cell: errorsCell,
			class: 'hidden lg:table-cell'
		},
		{
			id: 'p95',
			header: 'p95',
			value: (row) => metric(row)?.p95Ms ?? -1,
			searchable: false,
			descFirst: true,
			cell: p95Cell,
			class: 'hidden xl:table-cell'
		},
		{
			id: 'deployed',
			header: 'Last deploy',
			value: (row) => row.lastDeploy?.createdAt ?? '',
			searchable: false,
			descFirst: true,
			cell: deployedCell,
			class: 'hidden sm:table-cell'
		},
		{
			id: 'compat',
			header: 'Compatibility',
			value: (row) => row.view?.compatibilityDate ?? '',
			cell: compatCell,
			class: 'hidden lg:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];
</script>

<svelte:head>
	<title>Functions · Yoal</title>
</svelte:head>

<div class="space-y-5">
	<header
		data-yoal-target="page.functions"
		class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
	>
		<div class="space-y-1">
			<h1 class="flex items-center gap-2 text-2xl font-semibold tracking-tight">
				<ZapIcon class="size-5 text-brand" />Functions
			</h1>
			<p class="max-w-2xl text-sm text-muted-foreground">
				Workers-compatible code on workerd. Each function has its own URL and a host that starts on
				the first request.
			</p>
		</div>
		{#if data.enabled && data.can.createProject}
			<Button href={newHref}><PlusIcon />Create function</Button>
		{/if}
	</header>

	{#if page.url.searchParams.has('deleted')}
		<Notice tone="success">
			Function moved to the trash. Restore it from <strong>Recently deleted</strong> below within
			{data.policies.trashDays} days.
		</Notice>
	{/if}

	{#if !data.enabled}
		<div class="rounded-xl border border-dashed px-6 py-12 text-center">
			<ZapIcon class="mx-auto size-6 text-muted-foreground" />
			<h2 class="mt-3 font-semibold">Functions are switched off</h2>
			<p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
				They stay off until a node passes the phase-1 checks. A platform operator turns them on and
				restarts the control plane.
			</p>
			<code class="mt-4 inline-block rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs"
				>YOAL_FEATURE_FUNCTIONS=1</code
			>
		</div>
	{:else if data.denied}
		<div
			class="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground"
		>
			Your role cannot list functions in this organisation.
		</div>
	{:else if items.length === 0}
		{@render getStarted()}
	{:else}
		<!-- Fleet facts: one quiet line, not a dashboard. -->
		<div
			class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm"
		>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span>
					<span class="font-semibold tabular-nums">{items.length}</span>
					<span class="text-muted-foreground">{items.length === 1 ? 'function' : 'functions'}</span>
				</span>
				<span class="inline-flex items-center gap-1.5">
					<span class="size-2 rounded-full bg-success"></span>
					<span class="tabular-nums">{counts.running}</span>
					<span class="text-muted-foreground">running</span>
				</span>
				{#if failing > 0}
					<span class="inline-flex items-center gap-1.5 text-destructive">
						<span class="size-2 rounded-full bg-destructive"></span>
						<span class="tabular-nums">{failing}</span> failing
					</span>
				{/if}
				{#if counts.idle > 0}
					<span class="inline-flex items-center gap-1.5">
						<span class="size-2 rounded-full bg-muted-foreground/50"></span>
						<span class="tabular-nums">{counts.idle}</span>
						<span class="text-muted-foreground">idle</span>
					</span>
				{/if}
				<span class="text-muted-foreground">
					<span class="text-foreground tabular-nums">{reservedMb}</span> MB reserved
				</span>
			</div>
			<span class="font-mono text-xs text-muted-foreground"
				>workerd {WORKERD_PINNED_VERSION} · compat ≤ {WORKERD_MAX_COMPATIBILITY_DATE}</span
			>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<InputGroup.Root class="w-full bg-card sm:w-72">
				<InputGroup.Input
					placeholder="Search functions"
					bind:value={query}
					aria-label="Search functions"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
			</InputGroup.Root>
			<div class="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
				{#each filters as option (option.id)}
					{@const count = counts[option.id]}
					{#if option.id === 'all' || count > 0}
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors {filter ===
							option.id
								? 'border-foreground/25 bg-muted font-medium'
								: 'text-muted-foreground hover:bg-muted/60'}"
							aria-pressed={filter === option.id}
							onclick={() => (filter = option.id)}
						>
							{option.label}
							<span
								class="font-mono tabular-nums {option.id === 'issues' && count > 0
									? 'text-warning'
									: 'opacity-70'}">{count}</span
							>
						</button>
					{/if}
				{/each}
			</div>
			{#if !data.metricsPermitted}
				<span class="ml-auto text-xs text-muted-foreground"
					>Request metrics need the metrics:read permission.</span
				>
			{/if}
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Functions"
				{rows}
				{columns}
				rowId={(row) => row.slug}
				search={query.trim()}
				sort={{ id: 'deployed', desc: true }}
			>
				{#snippet empty()}
					<div class="px-4 py-10 text-center text-sm text-muted-foreground">
						No functions match {query.trim() ? 'this search' : 'this filter'}.
					</div>
				{/snippet}
			</DataTable>
		</div>
	{/if}

	{#if data.trash.length > 0}
		<Collapsible.Root bind:open={trashOpen}>
			<Collapsible.Trigger
				class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
			>
				<Trash2Icon class="size-4" />
				Recently deleted
				<span class="font-mono text-xs tabular-nums">{data.trash.length}</span>
				<ChevronDownIcon class="size-4 transition-transform {trashOpen ? 'rotate-180' : ''}" />
			</Collapsible.Trigger>
			<Collapsible.Content>
				<ul class="mt-3 divide-y rounded-xl border bg-card">
					{#each data.trash as item (item.slug)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div class="min-w-0">
								<p class="text-sm font-medium">{item.name}</p>
								<p class="font-mono text-xs text-muted-foreground">
									{item.slug} · {purgeCountdown(item.purgeAt)}
								</p>
							</div>
							{#if data.can.updateProject}
								<Button
									size="sm"
									variant="outline"
									onclick={() => runAction('?/restore', { slug: item.slug })}
									><RotateCcwIcon />Restore</Button
								>
							{/if}
						</li>
					{/each}
				</ul>
			</Collapsible.Content>
		</Collapsible.Root>
	{/if}
</div>

{#snippet getStarted()}
	<div class="overflow-hidden rounded-xl border bg-card">
		<div class="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
			<div class="space-y-5 p-6 lg:p-8">
				<span
					class="flex size-10 items-center justify-center rounded-lg bg-brand/10 text-brand"
					aria-hidden="true"><ZapIcon class="size-5" /></span
				>
				<div class="space-y-2">
					<h2 class="text-lg font-semibold tracking-tight">Deploy your first function</h2>
					<p class="text-sm text-muted-foreground">
						Write ordinary Workers code, run it locally with <code class="font-mono text-xs"
							>wrangler dev</code
						>, and deploy the same bundle here. Hosts start on the first request and stop when idle.
					</p>
				</div>
				<ol class="space-y-3 text-sm">
					{#each [{ n: 1, title: 'Create a function', body: 'Pick a name, placement and who may call it.' }, { n: 2, title: 'Develop locally', body: 'yoal wrangler dev runs the same workerd runtime on your machine.' }, { n: 3, title: 'Deploy', body: 'yoal deploy bundles with Wrangler and ships it. Every deploy gets a preview URL.' }] as step (step.n)}
						<li class="flex gap-3">
							<span
								class="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs"
								>{step.n}</span
							>
							<span>
								<span class="font-medium">{step.title}</span>
								<span class="block text-muted-foreground">{step.body}</span>
							</span>
						</li>
					{/each}
				</ol>
				{#if data.can.createProject}
					<Button href={newHref}><PlusIcon />Create function</Button>
				{/if}
			</div>
			<div class="border-t bg-muted/30 p-6 lg:border-t-0 lg:border-l lg:p-8">
				<CodeBlock label="terminal" code={QUICKSTART} />
				<p class="mt-3 font-mono text-xs text-muted-foreground">
					workerd {WORKERD_PINNED_VERSION} · compatibility dates up to {WORKERD_MAX_COMPATIBILITY_DATE}
				</p>
			</div>
		</div>
	</div>
{/snippet}

{#snippet nameCell(row: Row)}
	{@const issues = issuesOf(row)}
	<div class="flex min-w-0 items-start gap-3">
		<span
			class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand"
			aria-hidden="true"
		>
			<ZapIcon class="size-4" />
		</span>
		<div class="min-w-0 space-y-0.5">
			<a
				href={functionHref(row.slug)}
				class="block truncate text-sm font-medium underline-offset-4 hover:underline">{row.name}</a
			>
			<a
				href={row.productionUrl}
				target="_blank"
				rel="external noreferrer"
				class="inline-flex max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
				>{displayUrl(row.productionUrl)}<ArrowUpRightIcon class="size-3 shrink-0" /></a
			>
			{#if issues.length > 0}
				<div class="flex flex-wrap gap-1 pt-1">
					{#each issues as issue (issue.kind)}
						<Badge
							variant={issue.tone === 'danger'
								? 'danger'
								: issue.tone === 'warning'
									? 'warning'
									: 'neutral'}
							title={issue.message}>{chip(issue, row)}</Badge
						>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet statusCell(row: Row)}
	{@const status = functionStatus(row.workload, row.view)}
	<span title={status.hint}>
		<StatusBadge status={status.status} label={status.label} tone={status.tone} />
	</span>
	{#if row.workload && (row.workload.nodeName || row.workload.replicas > 1)}
		<p class="mt-0.5 font-mono text-xs text-muted-foreground">
			{row.workload.nodeName ?? ''}{row.workload.nodeName && row.workload.replicas > 1
				? ' · '
				: ''}{row.workload.replicas > 1 ? `×${row.workload.replicas}` : ''}
		</p>
	{/if}
{/snippet}

{#snippet requestsCell(row: Row)}
	{#if !row.lastDeploy || !data.metricsPermitted}
		<span class="text-xs text-muted-foreground">—</span>
	{:else if metrics === null}
		<Skeleton class="h-6 w-32" />
	{:else}
		{@const m = metric(row)}
		{#if !m}
			<span class="text-xs text-muted-foreground" title="Telemetry is unavailable">—</span>
		{:else}
			<div class="flex items-center gap-2">
				<div class="w-20">
					{#if m.series.length > 1 && m.requests > 0}
						<Sparkline values={m.series} color="var(--color-chart-1)" height={24} />
					{:else}
						<div class="h-px w-full bg-border"></div>
					{/if}
				</div>
				<span class="font-mono text-xs tabular-nums">{compactCount(m.requests)}</span>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet errorsCell(row: Row)}
	{@const rate = metric(row)?.errorRate ?? null}
	<span
		class="font-mono text-xs tabular-nums {rate !== null && rate >= 0.01
			? 'text-destructive'
			: rate !== null && rate > 0
				? 'text-warning'
				: 'text-muted-foreground'}">{formatRate(rate)}</span
	>
{/snippet}

{#snippet p95Cell(row: Row)}
	{@const ms = metric(row)?.p95Ms ?? null}
	<span class="font-mono text-xs text-muted-foreground tabular-nums"
		>{ms === null ? '—' : `${Math.round(ms)} ms`}</span
	>
{/snippet}

{#snippet deployedCell(row: Row)}
	{#if row.lastDeploy}
		<time
			datetime={row.lastDeploy.createdAt}
			title={formatDateTime(row.lastDeploy.createdAt)}
			class="text-xs">{formatRelative(row.lastDeploy.createdAt)}</time
		>
		<p class="font-mono text-xs text-muted-foreground">
			{row.lastDeploy.shortId}{row.lastDeploy.isProduction ? ' · production' : ''}
		</p>
	{:else}
		<span class="text-xs text-muted-foreground">Never</span>
	{/if}
{/snippet}

{#snippet compatCell(row: Row)}
	{#if row.view}
		{@const lag = compatibilityLagDays(row.view.compatibilityDate)}
		<span
			class="font-mono text-xs {lag > COMPATIBILITY_LAG_WARN_DAYS ? 'text-warning' : ''}"
			title={lag > 0 ? `${lag} days behind the pinned workerd` : 'Current'}
			>{row.view.compatibilityDate}</span
		>
	{:else}
		<span class="text-xs text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet actionsCell(row: Row)}
	<RowMenu label="Actions for {row.name}">
		<DropdownMenu.Item onSelect={() => goto(functionHref(row.slug))}>
			<ZapIcon />Open function
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => window.open(row.productionUrl, '_blank', 'noreferrer')}>
			<ArrowUpRightIcon />Visit URL
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => copy(row.productionUrl)}>
			<CopyIcon />Copy URL
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={() => openSection(row.slug, 'deployments')}>
			<RocketIcon />Deployments
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => openSection(row.slug, 'logs')}>
			<ScrollTextIcon />Logs
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => openSection(row.slug, 'variables')}>
			<KeyRoundIcon />Variables & secrets
		</DropdownMenu.Item>
		<DropdownMenu.Item onSelect={() => openSection(row.slug, 'settings')}>
			<Settings2Icon />Settings
		</DropdownMenu.Item>
	</RowMenu>
{/snippet}
