<script lang="ts">
	import { resolve } from '$app/paths';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import MailCheckIcon from '@lucide/svelte/icons/mail-check';
	import MailPlusIcon from '@lucide/svelte/icons/mail-plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import { EMAIL_SANDBOX_ADDRESS_LIMITS, EMAIL_SANDBOX_LIMITS } from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DataTable, { type DataColumn } from '#lib/components/yoal/DataTable.svelte';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDate, formatRelative } from '../../_lib/format.js';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import RequestAccessDialog from '../_lib/RequestAccessDialog.svelte';
	import type { PageProps } from './$types';

	interface FormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		values?: Record<string, unknown>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as FormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});
	const area = $derived(data.emailArea);
	const org = $derived(data.emailOrg);
	const canEdit = $derived(area.can.update && area.enabled);
	const request = $derived(data.request);
	const fmt = (value: number) => value.toLocaleString('en');

	let addOpen = $state(false);
	let requestOpen = $state(false);
	let resending = $state<string | null>(null);

	type Row = PageProps['data']['addresses'][number];
	const columns: DataColumn<Row>[] = [
		{
			id: 'address',
			header: 'Address',
			value: (row) => row.address,
			cell: addressCell,
			class: 'pl-4 font-mono text-xs'
		},
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: statusCell },
		{
			id: 'when',
			header: 'Verified or link expires',
			value: (row) => row.verifiedAt ?? row.expiresAt,
			searchable: false,
			cell: whenCell,
			class: 'hidden text-xs text-muted-foreground sm:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];

	function remove(address: string) {
		askConfirm({
			title: `Remove ${address}?`,
			description:
				'While the organisation is in the sandbox, sends to this address are refused again. Adding it back needs a new confirmation from its owner.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/remove',
			fields: { address }
		});
	}

	async function resend(address: string) {
		resending = address;
		await runAction('?/resend', { address });
		resending = null;
	}

	const expired = (row: Row) => row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now();
</script>

<svelte:head>
	<title>Sandbox · Email · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.sandbox"
		eyebrow="Email"
		title="Sandbox"
		description="While an organisation is in the sandbox it can only send to its own verified domains and to addresses whose owners confirmed them. Request production access to send to anyone."
	>
		{#if canEdit && !data.denied}
			<Button onclick={() => (addOpen = true)}><MailPlusIcon />Add recipient</Button>
		{/if}
	</PageHeader>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} />
	{/if}

	{#if data.denied || !org}
		<EmptyState
			icon={ShieldAlertIcon}
			title="The sandbox is not visible"
			description="This account does not have the email:read permission."
		/>
	{:else}
		<Panel title="Production access" icon={RocketIcon}>
			{#snippet actions()}
				<StatusBadge
					status={org.state}
					label={org.state === 'sandbox' ? 'Sandbox' : org.state === 'active' ? 'Active' : 'Paused'}
					tone={org.state === 'sandbox' ? 'warning' : org.state === 'active' ? 'success' : 'danger'}
				/>
			{/snippet}
			{#if org.state === 'active'}
				<p class="text-sm">
					This organisation is out of the sandbox: it sends to any recipient, up to {fmt(
						org.perDay
					)}
					messages a day and {fmt(org.perSecond)} a second.
				</p>
				{#if request?.status === 'approved' && request.decidedAt}
					<p class="mt-2 text-xs text-muted-foreground">
						Approved {formatRelative(request.decidedAt)}{request.note ? `: ${request.note}` : '.'}
					</p>
				{/if}
			{:else if org.state === 'paused'}
				<Notice tone="danger" title="Sending is paused">
					{org.pausedReason ?? 'Paused by a platform admin.'} A platform admin resumes it once the cause
					is fixed; production access can't be requested meanwhile.
				</Notice>
			{:else if request?.status === 'pending'}
				<div class="space-y-3">
					<p class="flex items-center gap-2 text-sm">
						<ClockIcon class="size-4 text-muted-foreground" />
						Waiting for a platform admin. You get an email with the answer.
					</p>
					<DetailList>
						<dt>Sent</dt>
						<dd class="text-xs">
							<time datetime={request.createdAt}>{formatDate(request.createdAt)}</time>
						</dd>
						<dt>Expected volume</dt>
						<dd class="font-mono text-xs tabular-nums">{fmt(request.expectedDailyVolume)} a day</dd>
						{#if request.website}
							<dt>Website</dt>
							<dd class="truncate font-mono text-xs">{request.website}</dd>
						{/if}
						<dt>Use case</dt>
						<dd class="text-xs whitespace-pre-line">{request.useCase}</dd>
					</DetailList>
				</div>
			{:else}
				<div class="space-y-3 text-sm">
					{#if request?.status === 'denied'}
						<Notice tone="warning" title="The last request was declined">
							{request.note ?? 'No reason was given.'} Address it, then ask again.
						</Notice>
					{/if}
					<p>
						The sandbox allows {fmt(EMAIL_SANDBOX_LIMITS.perDay)} messages a day, {EMAIL_SANDBOX_LIMITS.perSecond}
						a second, to verified recipients only. Once test mail lands in the inbox with DKIM, SPF and
						DMARC passing, ask a platform admin to move the organisation out.
					</p>
					{#if data.canRequest && canEdit}
						<Button onclick={() => (requestOpen = true)}
							><RocketIcon />Request production access</Button
						>
					{:else}
						<p class="text-muted-foreground">
							An organisation owner or admin requests production access.
						</p>
					{/if}
				</div>
			{/if}
		</Panel>

		<Panel
			title="Verified recipients"
			icon={MailCheckIcon}
			count={data.addresses.length}
			description={org.state === 'sandbox'
				? 'Besides your own verified domains, these are the only addresses the sandbox lets you send to.'
				: 'Not needed outside the sandbox; the list is kept in case the organisation returns to it.'}
			flush
		>
			{#if data.addresses.length === 0}
				<EmptyState
					compact
					icon={FlaskConicalIcon}
					title="No recipients yet"
					description="Add a mailbox you can read, such as a personal Gmail address. Its owner gets a link and must confirm before mail reaches it."
				>
					{#if canEdit}
						<Button variant="outline" onclick={() => (addOpen = true)}
							><MailPlusIcon />Add recipient</Button
						>
					{/if}
				</EmptyState>
			{:else}
				<DataTable
					label="Sandbox recipients"
					rows={data.addresses}
					{columns}
					rowId={(row) => row.id}
					sort={{ id: 'address', desc: false }}
				/>
			{/if}
			{#snippet footer()}
				Up to {EMAIL_SANDBOX_ADDRESS_LIMITS.maxAddresses} recipients, {EMAIL_SANDBOX_ADDRESS_LIMITS.maxPending}
				of them waiting at once. Links expire after {EMAIL_SANDBOX_ADDRESS_LIMITS.linkTtlSeconds /
					3600} hours. Sending from a domain also needs it verified on the
				<a href={resolve('/(dashboard)/email/domains')} class="underline underline-offset-4"
					>Domains</a
				> page.
			{/snippet}
		</Panel>
	{/if}
</div>

{#if canEdit}
	<FormDialog
		bind:open={addOpen}
		icon={MailPlusIcon}
		title="Add a sandbox recipient"
		description="Yoal emails the address a link. Mail can go to it once its owner confirms."
		action="?/add"
		submitLabel="Send link"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.address ? true : undefined}>
				<Field.Label for="sandbox-address">Address</Field.Label>
				<Input
					id="sandbox-address"
					name="address"
					type="email"
					placeholder="you@gmail.com"
					required
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.address ? 'true' : undefined}
				/>
				{#if errors.address}<Field.Error>{errors.address}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if canEdit && data.canRequest}
	<RequestAccessDialog bind:open={requestOpen} {errors} values={result?.values} />
{/if}

{#snippet addressCell(row: Row)}
	{row.address}
{/snippet}

{#snippet statusCell(row: Row)}
	{#if row.status === 'verified'}
		<StatusBadge status="verified" tone="success" />
	{:else if expired(row)}
		<StatusBadge status="expired" label="Link expired" tone="danger" />
	{:else}
		<StatusBadge status="pending" label="Waiting for confirmation" tone="warning" />
	{/if}
{/snippet}

{#snippet whenCell(row: Row)}
	{#if row.verifiedAt}
		<time datetime={row.verifiedAt}>Verified {formatDate(row.verifiedAt)}</time>
	{:else if row.expiresAt}
		<time datetime={row.expiresAt}
			>{expired(row) ? 'Expired' : 'Expires'} {formatRelative(row.expiresAt)}</time
		>
	{:else}
		—
	{/if}
{/snippet}

{#snippet actionsCell(row: Row)}
	{#if canEdit}
		<span class="flex justify-end gap-1">
			{#if row.status === 'pending'}
				<Button
					variant="ghost"
					size="sm"
					disabled={resending === row.address}
					onclick={() => resend(row.address)}
					aria-label="Send a new link to {row.address}"
				>
					<RefreshCwIcon />Resend
				</Button>
			{/if}
			<Button
				variant="ghost"
				size="sm"
				onclick={() => remove(row.address)}
				aria-label="Remove {row.address}"
			>
				<Trash2Icon />Remove
			</Button>
		</span>
	{/if}
{/snippet}
