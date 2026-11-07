<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import XIcon from '@lucide/svelte/icons/x';
	import { EMAIL_ACTIVE_DEFAULT_LIMITS } from '@skiff/contracts';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDate, formatRelative } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface FormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as FormResult | null)?.fieldErrors ?? {});
	const pending = $derived(data.requests.filter((request) => request.status === 'pending'));
	const decided = $derived(data.requests.filter((request) => request.status !== 'pending'));
	const fmt = (value: number) => value.toLocaleString('en');

	type Row = PageProps['data']['requests'][number];

	let approving = $state<Row | null>(null);
	let denying = $state<Row | null>(null);
	let approveOpen = $state(false);
	let denyOpen = $state(false);

	function approve(row: Row) {
		approving = row;
		approveOpen = true;
	}

	function deny(row: Row) {
		denying = row;
		denyOpen = true;
	}

	const orgLabel = (row: Row) => row.orgName ?? row.orgId;

	const columns: DataColumn<Row>[] = [
		{ id: 'org', header: 'Organisation', value: orgLabel, cell: orgCell, class: 'pl-4' },
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: statusCell },
		{
			id: 'volume',
			header: 'Asked for',
			value: (row) => row.expectedDailyVolume,
			searchable: false,
			cell: volumeCell,
			class: 'hidden font-mono text-xs tabular-nums md:table-cell'
		},
		{
			id: 'decided',
			header: 'Decided',
			value: (row) => row.decidedAt,
			searchable: false,
			descFirst: true,
			cell: decidedCell,
			class: 'pr-4 text-xs text-muted-foreground'
		}
	];
</script>

<svelte:head>
	<title>Access requests · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.requests"
		eyebrow="Email · Platform"
		title="Production access requests"
		description="Organisations in the sandbox ask here to send to anyone. Approving moves the organisation to Active with the limits you pick; denying keeps it in the sandbox. The requester is emailed either way."
	/>

	{#if pending.length === 0}
		<EmptyState
			icon={InboxIcon}
			title="Nothing waiting"
			description="New requests show up here, and every platform admin gets a notification when one arrives."
		/>
	{:else}
		{#each pending as row (row.id)}
			<Panel title={orgLabel(row)} icon={RocketIcon}>
				{#snippet actions()}
					<StatusBadge status="pending" label="Waiting" tone="warning" />
				{/snippet}
				<DetailList>
					<dt>Requested</dt>
					<dd class="text-xs">
						<time datetime={row.createdAt}>{formatDate(row.createdAt)}</time>
						by <span class="font-mono">{row.requestedBy.email ?? row.requestedBy.id}</span>
					</dd>
					<dt>Expected volume</dt>
					<dd class="font-mono text-xs tabular-nums">{fmt(row.expectedDailyVolume)} a day</dd>
					{#if row.website}
						<dt>Website</dt>
						<dd class="truncate font-mono text-xs">
							<a
								href={row.website}
								target="_blank"
								rel="noreferrer noopener"
								class="underline underline-offset-4">{row.website}</a
							>
						</dd>
					{/if}
					<dt>Use case</dt>
					<dd class="text-xs whitespace-pre-line">{row.useCase}</dd>
				</DetailList>
				{#if data.canDecide}
					<div class="mt-4 flex flex-wrap gap-2">
						<Button onclick={() => approve(row)}><CheckIcon />Approve</Button>
						<Button variant="outline" onclick={() => deny(row)}><XIcon />Deny</Button>
					</div>
				{:else}
					<p class="mt-4 text-xs text-muted-foreground">
						Deciding needs a platform admin's own dashboard session.
					</p>
				{/if}
			</Panel>
		{/each}
	{/if}

	<Panel title="Decided" icon={HistoryIcon} count={decided.length} flush>
		{#if decided.length === 0}
			<EmptyState compact icon={HistoryIcon} title="No decisions yet" />
		{:else}
			<DataTable
				label="Decided access requests"
				rows={decided}
				{columns}
				rowId={(row) => row.id}
				sort={{ id: 'decided', desc: true }}
			/>
		{/if}
	</Panel>
</div>

{#if data.canDecide}
	<FormDialog
		bind:open={approveOpen}
		icon={CheckIcon}
		title={approving ? `Approve ${orgLabel(approving)}?` : 'Approve'}
		description="The organisation leaves the sandbox at once and can send to any recipient within these limits. Change them later in Settings → Email."
		action="?/approve"
		submitLabel="Approve"
	>
		<input type="hidden" name="id" value={approving?.id ?? ''} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.perDay ? true : undefined}>
					<Field.Label for="approve-per-day">Messages a day</Field.Label>
					<Input
						id="approve-per-day"
						name="perDay"
						type="number"
						min="1"
						step="1"
						placeholder={String(EMAIL_ACTIVE_DEFAULT_LIMITS.perDay)}
						class="font-mono"
						aria-invalid={errors.perDay ? 'true' : undefined}
					/>
					{#if errors.perDay}<Field.Error>{errors.perDay}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.perSecond ? true : undefined}>
					<Field.Label for="approve-per-second">Messages a second</Field.Label>
					<Input
						id="approve-per-second"
						name="perSecond"
						type="number"
						min="1"
						step="1"
						placeholder={String(EMAIL_ACTIVE_DEFAULT_LIMITS.perSecond)}
						class="font-mono"
						aria-invalid={errors.perSecond ? 'true' : undefined}
					/>
					{#if errors.perSecond}<Field.Error>{errors.perSecond}</Field.Error>{/if}
				</Field.Field>
			</div>
			<Field.Description>
				Leave blank for the defaults ({fmt(EMAIL_ACTIVE_DEFAULT_LIMITS.perDay)} a day, {EMAIL_ACTIVE_DEFAULT_LIMITS.perSecond}
				a second){approving
					? `; they asked for about ${fmt(approving.expectedDailyVolume)} a day`
					: ''}.
			</Field.Description>
			<Field.Field>
				<Field.Label for="approve-note">Note to the requester (optional)</Field.Label>
				<Textarea id="approve-note" name="note" rows={3} maxlength={1000} />
			</Field.Field>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={denyOpen}
		icon={XIcon}
		title={denying ? `Deny ${orgLabel(denying)}?` : 'Deny'}
		description="The organisation stays in the sandbox and can ask again. The requester is emailed your reason."
		action="?/deny"
		submitLabel="Deny"
		submitVariant="destructive"
	>
		<input type="hidden" name="id" value={denying?.id ?? ''} />
		<Field.Group>
			<Field.Field data-invalid={errors.note ? true : undefined}>
				<Field.Label for="deny-note">Reason</Field.Label>
				<Textarea
					id="deny-note"
					name="note"
					rows={4}
					required
					maxlength={1000}
					placeholder="Test mail from example.com still fails DMARC. Fix the DKIM record, then ask again."
					aria-invalid={errors.note ? 'true' : undefined}
				/>
				{#if errors.note}<Field.Error>{errors.note}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet orgCell(row: Row)}
	<span class="font-medium">{orgLabel(row)}</span>
	<span class="block text-xs text-muted-foreground"
		>{row.requestedBy.email ?? row.requestedBy.id}</span
	>
{/snippet}

{#snippet statusCell(row: Row)}
	{#if row.status === 'approved'}
		<StatusBadge status="approved" label="Approved" tone="success" />
	{:else}
		<StatusBadge status="denied" label="Denied" tone="danger" />
	{/if}
{/snippet}

{#snippet volumeCell(row: Row)}
	{fmt(row.expectedDailyVolume)} a day
	{#if row.status === 'approved' && row.perDay}
		<span class="block text-muted-foreground">granted {fmt(row.perDay)}, {row.perSecond}/s</span>
	{/if}
{/snippet}

{#snippet decidedCell(row: Row)}
	{#if row.decidedAt}
		<time datetime={row.decidedAt} title={formatDate(row.decidedAt)}
			>{formatRelative(row.decidedAt)}</time
		>
	{/if}
	{#if row.note}
		<span class="block whitespace-pre-line">{row.note}</span>
	{/if}
{/snippet}
