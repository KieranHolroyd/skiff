<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import { emailEventKinds } from '@skiff/contracts';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import { activitySearch, messageStatusTone } from '../_lib/email-ui.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const area = $derived(data.emailArea);
	const filtered = $derived(data.filters.q !== '' || data.filters.status !== '');

	let q = $state('');
	let status = $state('');
	$effect.pre(() => {
		q = data.filters.q;
		status = data.filters.status;
	});

	const base = resolve('/(dashboard)/email/activity');
	function apply(next: { q?: string; status?: string; before?: string }) {
		const search = activitySearch({
			q: next.q ?? q.trim(),
			status: (next.status ?? status) as typeof data.filters.status,
			before: next.before
		});
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only the query changes
		void goto(`${base}${search}`, { reset: next.before !== undefined });
	}

	type Row = PageProps['data']['messages'][number];
	const recipients = (row: Row) => row.recipients.map((recipient) => recipient.address);
	const columns: DataColumn<Row>[] = [
		{
			id: 'subject',
			header: 'Message',
			value: (row) => row.subject,
			sortable: false,
			cell: subjectCell,
			class: 'pl-4'
		},
		{
			id: 'status',
			header: 'Status',
			value: (row) => row.status,
			sortable: false,
			cell: statusCell
		},
		{
			id: 'from',
			header: 'From',
			value: (row) => row.from,
			sortable: false,
			cell: fromCell,
			class: 'hidden font-mono text-xs lg:table-cell'
		},
		{
			id: 'source',
			header: 'Via',
			value: (row) => row.source,
			sortable: false,
			cell: sourceCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'created',
			header: 'Sent',
			value: (row) => row.createdAt,
			sortable: false,
			cell: createdCell,
			class: 'pr-4 text-xs text-muted-foreground'
		}
	];
	const SOURCE: Record<string, string> = { api: 'API', smtp: 'SMTP', binding: 'Function' };
</script>

<svelte:head>
	<title>Activity · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.activity"
		eyebrow="Email"
		title="Activity"
		description="Every message with its latest status per recipient, newest first. Kept for 30 days."
	/>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} />
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Activity is not visible"
			description="This account does not have the email:read permission."
		/>
	{:else}
		<form
			class="flex flex-wrap items-center gap-3"
			onsubmit={(event) => {
				event.preventDefault();
				apply({});
			}}
		>
			<InputGroup.Root class="max-w-sm bg-card">
				<InputGroup.Input
					name="q"
					type="search"
					placeholder="Recipient address or message id"
					bind:value={q}
					aria-label="Search by recipient address or message id"
					autocapitalize="off"
					spellcheck="false"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
			</InputGroup.Root>
			<NativeSelect.Root
				name="status"
				bind:value={status}
				onchange={(event) => apply({ status: event.currentTarget.value })}
				aria-label="Filter by status"
			>
				<NativeSelect.Option value="">Any status</NativeSelect.Option>
				{#each emailEventKinds as kind (kind)}
					<NativeSelect.Option value={kind}
						>{kind.charAt(0).toUpperCase() + kind.slice(1)}</NativeSelect.Option
					>
				{/each}
			</NativeSelect.Root>
			<Button type="submit" variant="outline">Search</Button>
			{#if filtered}
				<Button variant="ghost" onclick={() => apply({ q: '', status: '' })}><XIcon />Clear</Button>
			{/if}
		</form>

		{#if data.messages.length === 0}
			<EmptyState
				icon={ActivityIcon}
				title={filtered
					? 'No matching messages'
					: data.filters.before
						? 'No older messages'
						: 'Nothing sent yet'}
				description={filtered
					? 'The search matches a whole recipient address. Try another address or status.'
					: 'Messages show here once they are accepted, with each recipient’s delivery status.'}
			/>
		{:else}
			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<DataTable label="Email messages" rows={data.messages} {columns} rowId={(row) => row.id} />
			</div>
		{/if}

		{#if data.filters.before || data.older}
			<div class="flex items-center justify-between gap-3">
				{#if data.filters.before}
					<Button variant="outline" size="sm" onclick={() => apply({ before: '' })}>
						<ChevronLeftIcon />Newest
					</Button>
				{:else}
					<span></span>
				{/if}
				{#if data.older}
					<Button variant="outline" size="sm" onclick={() => apply({ before: data.older ?? '' })}>
						Older<ChevronRightIcon />
					</Button>
				{/if}
			</div>
		{/if}
	{/if}
</div>

{#snippet subjectCell(row: Row)}
	<div class="max-w-md min-w-0">
		<a
			href={resolve('/(dashboard)/email/activity/[id]', { id: row.id })}
			class="block truncate text-sm font-medium underline-offset-4 group-hover:underline"
			>{row.subject || '(no subject)'}</a
		>
		<p class="truncate font-mono text-xs text-muted-foreground" title={recipients(row).join(', ')}>
			{recipients(row).slice(0, 3).join(', ')}{row.recipients.length > 3
				? ` +${row.recipients.length - 3}`
				: ''}
		</p>
	</div>
{/snippet}

{#snippet statusCell(row: Row)}
	<StatusBadge status={row.status} tone={messageStatusTone(row.status)} />
{/snippet}

{#snippet fromCell(row: Row)}
	<span class="block max-w-56 truncate" title={row.from}>{row.from}</span>
{/snippet}

{#snippet sourceCell(row: Row)}
	<Badge variant="outline" class="font-normal">{SOURCE[row.source] ?? row.source}</Badge>
{/snippet}

{#snippet createdCell(row: Row)}
	<time datetime={row.createdAt} title={formatDateTime(row.createdAt)}
		>{formatRelative(row.createdAt)}</time
	>
{/snippet}
