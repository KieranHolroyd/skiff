<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ListIcon from '@lucide/svelte/icons/list';
	import {
		isTerminalOperation,
		itemStatuses,
		itemVerdicts,
		operationActions,
		type OperationView
	} from '@skiff/contracts';
	import { toast } from 'svelte-sonner';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import Panel from '../../../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime } from '../../../../_lib/format.js';
	import { streamOperation } from '../../../../_lib/operations/client.js';
	import {
		actionLabel,
		categoryLabel,
		itemStatusTone,
		operationDuration,
		operationStatusLabel,
		operationStatusTone,
		reasonLabel
	} from '../../../../_lib/operations/copy.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Fresher than page data while the stream is open. */
	let live = $state<OperationView | null>(null);
	const operation = $derived(live?.id === data.operation.id ? live : data.operation);
	const info = $derived(operationActions[operation.action]);
	const prune = $derived(operation.kind === 'prune');
	const running = $derived(!isTerminalOperation(operation.status));

	// Stream only while something is happening; a plan waiting for review is static.
	const streamId = $derived(
		!isTerminalOperation(data.operation.status) && data.operation.status !== 'planned'
			? data.operation.id
			: null
	);
	$effect(() => {
		const id = streamId;
		if (!id) return;
		live = null;
		let lastRefresh = Date.now();
		return streamOperation(
			id,
			{
				onProgress: (next) => {
					live = next;
					// Item rows come from the page load; refresh them every couple of seconds.
					if (Date.now() - lastRefresh > 2_000) {
						lastRefresh = Date.now();
						void invalidateAll();
					}
				},
				onDone: (next) => {
					live = next;
					void invalidateAll();
				},
				onError: (message) => toast.error(message)
			},
			{ items: false }
		);
	});

	function filterHref(next: { status?: string; verdict?: string; after?: number }) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder, not state
		const params = new URLSearchParams();
		const status = next.status ?? data.filters.status;
		const verdict = next.verdict ?? data.filters.verdict;
		if (status) params.set('status', status);
		if (verdict) params.set('verdict', verdict);
		if (next.after) params.set('after', String(next.after));
		const query = params.toString();
		return `${page.url.pathname}${query ? `?${query}` : ''}`;
	}

	function setFilter(key: 'status' | 'verdict', value: string) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query changes
		void goto(filterHref({ [key]: value }), { reset: false });
	}

	function confirmCancel() {
		askConfirm({
			title: operation.status === 'planned' ? 'Discard this plan?' : 'Cancel this operation?',
			description:
				operation.status === 'planned'
					? 'Nothing has been changed. You can plan it again later.'
					: 'It stops after the current item. Items already done stay done.',
			confirmLabel: operation.status === 'planned' ? 'Discard plan' : 'Cancel operation',
			tone: 'danger',
			action: '?/cancel'
		});
	}

	function confirmApply() {
		askConfirm({
			title: `${info.verb} ${operation.total} ${operation.total === 1 ? 'item' : 'items'}?`,
			description: info.reversible
				? `${info.label}. Each item is checked again before it changes.`
				: `${info.label}. Each item is checked again first. This cannot be undone.`,
			confirmLabel: info.verb,
			tone: info.destructive ? 'danger' : 'default',
			action: '?/apply',
			typeToConfirm: info.reversible ? undefined : String(operation.total)
		});
	}
</script>

<svelte:head><title>{actionLabel(operation.action)} · Maintenance · Skiff</title></svelte:head>

<div class="space-y-6">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div class="space-y-1.5">
			<a
				href={resolve('/(dashboard)/settings/maintenance')}
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				<ArrowLeftIcon class="size-3" />Maintenance
			</a>
			<h2 class="flex flex-wrap items-center gap-2 text-lg font-semibold">
				{actionLabel(operation.action)}
				<StatusBadge
					status={operation.status}
					label={operationStatusLabel(operation.status)}
					tone={operationStatusTone(operation.status)}
				/>
			</h2>
			<p class="font-mono text-xs text-muted-foreground">
				{operation.id}{operation.scope ? ` · ${operation.scope} scope` : ''}
			</p>
		</div>
		<div class="flex flex-wrap gap-2">
			{#if data.canApply && operation.status === 'planned'}
				<Button variant={info.destructive ? 'destructive' : 'default'} onclick={confirmApply}>
					{info.verb}
					{operation.total}
					{operation.total === 1 ? 'item' : 'items'}
				</Button>
			{/if}
			{#if data.canCancel && running}
				<Button variant="outline" onclick={confirmCancel}>
					{operation.status === 'planned' ? 'Discard plan' : 'Cancel'}
				</Button>
			{/if}
		</div>
	</div>

	{#if operation.status === 'applying' || operation.status === 'planning' || operation.status === 'queued'}
		<div class="space-y-1.5">
			<div class="flex justify-between text-xs text-muted-foreground tabular-nums">
				<span>{operation.phase ?? (operation.status === 'applying' ? 'Running' : 'Planning')}</span>
				<span>{operation.done} / {operation.total}</span>
			</div>
			<Progress value={operation.done} max={Math.max(operation.total, 1)} aria-label="Progress" />
		</div>
	{/if}

	<div class="grid gap-6 lg:grid-cols-2">
		<DetailList>
			<dt>Items</dt>
			<dd class="font-mono tabular-nums">{operation.total} to run</dd>
			<dt>Succeeded</dt>
			<dd class="font-mono tabular-nums">{operation.summary.statuses.succeeded}</dd>
			<dt>Skipped</dt>
			<dd class="font-mono tabular-nums">{operation.summary.statuses.skipped}</dd>
			<dt>Failed</dt>
			<dd class="font-mono tabular-nums {operation.failed ? 'text-destructive' : ''}">
				{operation.summary.statuses.failed}
			</dd>
			{#if prune}
				<dt>Freed</dt>
				<dd class="font-mono tabular-nums">{formatBytes(operation.summary.freedBytes)}</dd>
			{/if}
		</DetailList>
		<DetailList>
			<dt>By</dt>
			<dd>
				{data.mine ? 'You' : (data.actor ?? '—')}
				{#if operation.actor.type !== 'user'}
					<span class="text-xs text-muted-foreground">({operation.actor.type})</span>
				{/if}
			</dd>
			<dt>Created</dt>
			<dd class="font-mono text-xs">{formatDateTime(operation.createdAt)}</dd>
			<dt>Started</dt>
			<dd class="font-mono text-xs">{formatDateTime(operation.startedAt)}</dd>
			<dt>Finished</dt>
			<dd class="font-mono text-xs">{formatDateTime(operation.finishedAt)}</dd>
			{#if operation.planExpiresAt}
				<dt>Plan expires</dt>
				<dd class="font-mono text-xs">{formatDateTime(operation.planExpiresAt)}</dd>
			{/if}
			<dt>Duration</dt>
			<dd class="font-mono text-xs">{operationDuration(operation)}</dd>
		</DetailList>
	</div>

	{#if operation.status === 'failed' && operation.phase}
		<p class="text-sm text-destructive">{operation.phase}</p>
	{/if}

	<Panel title="Items" icon={ListIcon} flush>
		{#snippet actions()}
			<NativeSelect.Root
				value={data.filters.status}
				onchange={(event) => setFilter('status', event.currentTarget.value)}
				aria-label="Filter by status"
				class="h-7 text-xs"
			>
				<NativeSelect.Option value="">Any status</NativeSelect.Option>
				{#each itemStatuses as status (status)}
					<NativeSelect.Option value={status}>{status}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<NativeSelect.Root
				value={data.filters.verdict}
				onchange={(event) => setFilter('verdict', event.currentTarget.value)}
				aria-label="Filter by verdict"
				class="h-7 text-xs"
			>
				<NativeSelect.Option value="">Any verdict</NativeSelect.Option>
				{#each itemVerdicts as verdict (verdict)}
					<NativeSelect.Option value={verdict}>{verdict}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		{/snippet}
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="w-0 pl-4">#</Table.Head>
					<Table.Head>Item</Table.Head>
					{#if prune}<Table.Head class="hidden md:table-cell">Category</Table.Head>{/if}
					<Table.Head>Plan</Table.Head>
					<Table.Head>Status</Table.Head>
					{#if prune}<Table.Head class="hidden text-right sm:table-cell">Size</Table.Head>{/if}
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.items as item (item.seq)}
					<Table.Row>
						<Table.Cell class="pl-4 font-mono text-xs text-muted-foreground">{item.seq}</Table.Cell>
						<Table.Cell class="max-w-md">
							<p class="truncate font-mono text-xs">{item.label ?? item.targetId}</p>
							{#if item.flags.length}
								<p class="text-xs text-muted-foreground">
									{item.flags.join(', ').replace(/_/g, ' ')}
								</p>
							{/if}
							{#if item.error}
								<p class="text-xs whitespace-normal text-destructive">{item.error}</p>
							{/if}
						</Table.Cell>
						{#if prune}
							<Table.Cell class="hidden text-xs md:table-cell"
								>{categoryLabel(item.category)}</Table.Cell
							>
						{/if}
						<Table.Cell class="text-xs">
							<span
								class={item.verdict === 'blocked'
									? 'text-destructive'
									: item.verdict === 'skip'
										? 'text-muted-foreground'
										: ''}>{item.verdict}</span
							>
							{#if item.reason}
								<p class="text-muted-foreground">{reasonLabel(item.reason)}</p>
							{/if}
						</Table.Cell>
						<Table.Cell>
							<StatusBadge status={item.status} tone={itemStatusTone(item.status)} />
						</Table.Cell>
						{#if prune}
							<Table.Cell class="hidden text-right font-mono text-xs sm:table-cell">
								{item.bytes ? formatBytes(item.bytes) : '—'}
							</Table.Cell>
						{/if}
					</Table.Row>
				{:else}
					<Table.Row>
						<Table.Cell colspan={6} class="py-8 text-center text-sm text-muted-foreground">
							{data.filters.status || data.filters.verdict
								? 'No items match these filters.'
								: 'No items yet.'}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
		{#if data.filters.after > 0 || data.hasMore}
			<div class="flex justify-between border-t px-4 py-2">
				{#if data.filters.after > 0}
					<Button variant="ghost" size="sm" href={filterHref({ after: 0 })}>First page</Button>
				{:else}
					<span></span>
				{/if}
				{#if data.hasMore}
					<Button variant="ghost" size="sm" href={filterHref({ after: data.cursor })}
						>Next page</Button
					>
				{/if}
			</div>
		{/if}
	</Panel>
</div>
