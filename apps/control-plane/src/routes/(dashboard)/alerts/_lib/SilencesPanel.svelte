<script lang="ts">
	/** Active, upcoming and (optionally) recently expired silences, with create and end-now. */
	import type { AlertSilenceView } from '@yoal/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { resolve } from '$app/paths';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TimerOffIcon from '@lucide/svelte/icons/timer-off';
	import DataTable, { type DataColumn } from '#lib/components/yoal/DataTable.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { errorText } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { confirmAction } from '../../dashboards/_lib/ConfirmDialog.svelte';
	import { expireSilence, keys, listSilences } from './api.js';
	import Labels from './Labels.svelte';

	let {
		canSilence,
		oncreate
	}: {
		canSilence: boolean;
		oncreate: () => void;
	} = $props();

	const queryClient = useQueryClient();
	let showExpired = $state(false);
	const silences = createQuery(() => ({
		queryKey: keys.silences(showExpired),
		queryFn: ({ signal }) => listSilences(showExpired, signal),
		refetchInterval: 60_000
	}));
	const rows = $derived(silences.data ?? []);

	const STATUS: Record<AlertSilenceView['status'], { label: string; variant: BadgeVariant }> = {
		active: { label: 'Active', variant: 'brand' },
		pending: { label: 'Scheduled', variant: 'info' },
		expired: { label: 'Expired', variant: 'neutral' }
	};
	const ORDER = { active: 0, pending: 1, expired: 2 } as const;

	function end(row: AlertSilenceView) {
		confirmAction({
			title: 'End this silence now?',
			description: `Notifications for ${row.ruleName ?? 'every rule'} resume from the next evaluation.`,
			confirmLabel: 'End silence',
			run: async () => {
				await expireSilence(row.id);
				void queryClient.invalidateQueries({ queryKey: keys.all });
				toast.success('Silence ended');
			}
		});
	}

	const columns = $derived<DataColumn<AlertSilenceView>[]>([
		{
			id: 'status',
			header: 'Status',
			value: (row) => ORDER[row.status],
			cell: statusCell,
			class: 'pl-4 w-0'
		},
		{
			id: 'scope',
			header: 'Silences',
			value: (row) =>
				`${row.ruleName ?? 'Every rule'} ${row.matchers.map((m) => `${m.label}=${m.value}`).join(' ')} ${row.comment}`,
			cell: scopeCell
		},
		{
			id: 'ends',
			header: 'Ends',
			value: (row) => row.endsAt,
			searchable: false,
			cell: endsCell,
			class: 'text-xs'
		},
		{
			id: 'author',
			header: 'Created by',
			value: (row) => row.createdByName ?? '',
			cell: authorCell,
			class: 'hidden text-xs text-muted-foreground md:table-cell'
		},
		...(canSilence
			? [{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }]
			: [])
	]);
</script>

{#snippet statusCell(row: AlertSilenceView)}
	<Badge variant={STATUS[row.status].variant}>{STATUS[row.status].label}</Badge>
{/snippet}
{#snippet scopeCell(row: AlertSilenceView)}
	<div class="min-w-0 space-y-1">
		{#if row.ruleId && row.ruleName}
			<a
				href={resolve('/(dashboard)/alerts/rules/[id]', { id: row.ruleId })}
				class="font-medium hover:underline">{row.ruleName}</a
			>
		{:else}
			<span class="font-medium">Every rule</span>
		{/if}
		{#if row.matchers.length}
			<Labels labels={Object.fromEntries(row.matchers.map((m) => [m.label, m.value]))} />
		{/if}
		{#if row.comment}<p class="max-w-md truncate text-xs text-muted-foreground" title={row.comment}>
				{row.comment}
			</p>{/if}
	</div>
{/snippet}
{#snippet endsCell(row: AlertSilenceView)}
	<span title={formatDateTime(row.endsAt)}>
		{#if row.status === 'pending'}
			starts {formatDateTime(row.startsAt)}<br /><span class="text-muted-foreground"
				>ends {formatDateTime(row.endsAt)}</span
			>
		{:else}
			{formatDateTime(row.endsAt)}
		{/if}
	</span>
{/snippet}
{#snippet authorCell(row: AlertSilenceView)}
	{row.createdByName ?? '—'}
	<span class="block" title={row.createdAt}>{formatRelative(row.createdAt)}</span>
{/snippet}
{#snippet actionsCell(row: AlertSilenceView)}
	{#if row.status !== 'expired'}
		<Button variant="ghost" size="sm" onclick={() => end(row)} aria-label="End silence"
			><TimerOffIcon /><span class="hidden sm:inline">End now</span></Button
		>
	{/if}
{/snippet}

<section class="space-y-3" aria-labelledby="silences-heading">
	<div class="flex flex-wrap items-center gap-3">
		<h2 id="silences-heading" class="mr-auto text-sm font-medium text-muted-foreground">
			Silences mute notifications for matching series; the alerts still show here.
		</h2>
		<label class="flex items-center gap-2 text-xs">
			<Switch bind:checked={showExpired} aria-label="Show expired silences" />
			Show expired (30 days)
		</label>
		{#if canSilence}
			<Button size="sm" onclick={oncreate}><PlusIcon />New silence</Button>
		{/if}
	</div>

	{#if silences.isPending}
		<div class="space-y-2"><Skeleton class="h-12" /><Skeleton class="h-12" /></div>
	{:else if silences.error}
		<Notice tone="danger" title="Could not load silences">{errorText(silences.error)}</Notice>
	{:else if rows.length === 0}
		<EmptyState
			compact
			icon={BellOffIcon}
			title={showExpired ? 'No silences in the last 30 days' : 'No active silences'}
			description="Silence a firing alert from the Active tab, or plan a maintenance window."
		>
			{#if canSilence}<Button variant="outline" onclick={oncreate}><PlusIcon />New silence</Button
				>{/if}
		</EmptyState>
	{:else}
		<Card.Root class="py-0">
			<DataTable
				{rows}
				{columns}
				rowId={(row) => row.id}
				sort={{ id: 'status', desc: false }}
				label="Silences"
				rowClass={(row) => (row.status === 'expired' ? 'opacity-60' : '')}
			/>
		</Card.Root>
	{/if}
</section>
