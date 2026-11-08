<script lang="ts">
	import { resolve } from '$app/paths';
	import BanIcon from '@lucide/svelte/icons/ban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { emailSuppressionReasons } from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import { formatDate } from '../../_lib/format.js';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import type { PageProps } from './$types';

	interface AddFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as AddFormResult | null)?.fieldErrors ?? {});
	const area = $derived(data.emailArea);
	const canEdit = $derived(area.can.update);

	let addOpen = $state(false);
	let query = $state('');
	let matched = $state(0);

	const REASONS: Record<string, string> = {
		bounce: 'Hard bounce',
		complaint: 'Complaint',
		manual: 'Added by hand',
		unsubscribe: 'Unsubscribed'
	};

	type Row = PageProps['data']['suppressions'][number];
	const columns: DataColumn<Row>[] = [
		{
			id: 'address',
			header: 'Address',
			value: (row) => row.address,
			cell: addressCell,
			class: 'pl-4 font-mono text-xs'
		},
		{ id: 'reason', header: 'Reason', value: (row) => row.reason, cell: reasonCell },
		{
			id: 'message',
			header: 'Message',
			value: (row) => row.messageId,
			sortable: false,
			cell: messageCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'created',
			header: 'Added',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'hidden text-xs text-muted-foreground sm:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];

	function remove(address: string) {
		askConfirm({
			title: `Remove ${address}?`,
			description:
				'Mail to this address is attempted again. If it bounced or complained before, sending to it again hurts your reputation unless the cause is fixed.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/remove',
			fields: { address }
		});
	}
</script>

<svelte:head>
	<title>Suppressions · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.suppressions"
		eyebrow="Email"
		title="Suppressions"
		description="Addresses Skiff never sends to for this organisation. Hard bounces, complaints and one-click unsubscribes are added automatically."
	>
		{#if canEdit}
			<Button onclick={() => (addOpen = true)}><PlusIcon />Add address</Button>
		{/if}
	</PageHeader>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} />
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Suppressions are not visible"
			description="This account does not have the email:read permission."
		/>
	{:else if data.suppressions.length === 0}
		<EmptyState
			icon={BanIcon}
			title="Nobody is suppressed"
			description="When a recipient hard-bounces, marks a message as spam or unsubscribes, they are listed here and later sends to them are dropped."
		>
			{#if canEdit}
				<Button variant="outline" onclick={() => (addOpen = true)}><PlusIcon />Add address</Button>
			{/if}
		</EmptyState>
	{:else}
		{#if data.truncated}
			<Notice tone="info" title="Showing the newest {data.limit.toLocaleString('en')}">
				Older entries still apply. Search below covers only the rows shown.
			</Notice>
		{/if}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input
					placeholder="Search addresses"
					bind:value={query}
					aria-label="Search addresses"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{data.suppressions.length.toLocaleString('en')}
				{data.suppressions.length === 1 ? 'address' : 'addresses'}
			</p>
		</div>
		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Suppressed addresses"
				rows={data.suppressions}
				{columns}
				rowId={(row) => row.address}
				search={query.trim()}
				sort={{ id: 'created', desc: true }}
				onmatch={(count) => (matched = count)}
			/>
		</div>
	{/if}
</div>

{#if canEdit}
	<FormDialog
		bind:open={addOpen}
		icon={BanIcon}
		title="Suppress an address"
		description="Sends to it are dropped (not refused) until it is removed. Messages to other recipients still go out."
		action="?/add"
		submitLabel="Suppress"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.address ? true : undefined}>
				<Field.Label for="suppress-address">Address</Field.Label>
				<Input
					id="suppress-address"
					name="address"
					type="email"
					placeholder="someone@example.com"
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.address ? 'true' : undefined}
				/>
				{#if errors.address}<Field.Error>{errors.address}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.reason ? true : undefined}>
				<Field.Label for="suppress-reason">Reason</Field.Label>
				<NativeSelect.Root id="suppress-reason" name="reason" value="manual" class="w-full">
					{#each emailSuppressionReasons as reason (reason)}
						<NativeSelect.Option value={reason}>{REASONS[reason] ?? reason}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				{#if errors.reason}<Field.Error>{errors.reason}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet addressCell(row: Row)}
	{row.address}
{/snippet}

{#snippet reasonCell(row: Row)}
	<Badge
		variant={row.reason === 'complaint' || row.reason === 'bounce' ? 'secondary' : 'outline'}
		class="font-normal"
	>
		{REASONS[row.reason] ?? row.reason}
	</Badge>
{/snippet}

{#snippet messageCell(row: Row)}
	{#if row.messageId}
		<a
			href={resolve('/(dashboard)/email/activity/[id]', { id: row.messageId })}
			class="underline-offset-4 hover:underline">{row.messageId}</a
		>
	{:else}
		<span class="text-muted-foreground">—</span>
	{/if}
{/snippet}

{#snippet createdCell(row: Row)}
	<time datetime={row.createdAt}>{formatDate(row.createdAt)}</time>
{/snippet}

{#snippet actionsCell(row: Row)}
	{#if canEdit}
		<Button
			variant="ghost"
			size="sm"
			onclick={() => remove(row.address)}
			aria-label="Remove {row.address}"
		>
			<Trash2Icon />Remove
		</Button>
	{/if}
{/snippet}
