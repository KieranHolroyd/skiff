<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import { runAction } from '#lib/actions.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDate, formatRelative } from '../../_lib/format.js';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import type { PageProps } from './$types';

	interface CreateFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as CreateFormResult | null)?.fieldErrors ?? {});
	const area = $derived(data.emailArea);
	const canCreate = $derived(area.can.update && area.enabled);

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let matched = $state(0);

	type Row = PageProps['data']['domains'][number];
	const missing = (row: Row) =>
		row.records.filter((record) => record.required && !record.ok).length;
	const columns: DataColumn<Row>[] = [
		{ id: 'name', header: 'Domain', value: (row) => row.name, cell: nameCell, class: 'pl-4' },
		{ id: 'status', header: 'Status', value: (row) => row.status, cell: statusCell },
		{
			id: 'sending',
			header: 'Sending',
			value: (row) => (row.sending ? 'on' : 'off'),
			searchable: false,
			cell: sendingCell,
			class: 'hidden text-xs sm:table-cell'
		},
		{
			id: 'checked',
			header: 'Last checked',
			value: (row) => row.lastCheckedAt,
			searchable: false,
			descFirst: true,
			cell: checkedCell,
			class: 'hidden text-xs text-muted-foreground md:table-cell'
		},
		{
			id: 'created',
			header: 'Added',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'hidden font-mono text-xs text-muted-foreground lg:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];
</script>

<svelte:head>
	<title>Domains · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.domains"
		eyebrow="Email"
		title="Domains"
		description="Domains you send from. Each needs a DKIM record before mail can leave; SPF and DMARC are recommended for inbox placement."
	>
		{#if canCreate}
			<Button onclick={() => (createOpen = true)}><PlusIcon />Add domain</Button>
		{/if}
	</PageHeader>

	{#if !area.enabled}
		<Notice tone="warning" title="Email is switched off">
			Set <code class="font-mono">SKIFF_FEATURE_EMAIL=1</code> to add domains.
		</Notice>
	{:else if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} />
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Domains are not visible"
			description="This account does not have the email:read permission."
		/>
	{:else if data.domains.length === 0}
		<EmptyState
			icon={GlobeIcon}
			title="No sending domains yet"
			description="Add a domain you control, such as example.com or mail.example.com. Skiff generates its DKIM key and lists the records to publish; with Cloudflare connected it can create them for you."
		>
			{#if canCreate}
				<Button onclick={() => (createOpen = true)}><PlusIcon />Add domain</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input
					placeholder="Search domains"
					bind:value={query}
					aria-label="Search domains"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{data.domains.filter((domain) => domain.status === 'verified').length} verified of {data
					.domains.length}
			</p>
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Sending domains"
				rows={data.domains}
				{columns}
				rowId={(row) => row.id}
				search={query.trim()}
				sort={{ id: 'name', desc: false }}
				onmatch={(count) => (matched = count)}
			/>
		</div>
	{/if}
</div>

{#if canCreate}
	<FormDialog
		bind:open={createOpen}
		icon={GlobeIcon}
		title="Add domain"
		description="Skiff generates a DKIM key for it and checks its DNS. Mail can be sent from any address at the domain once it is verified."
		action="?/create"
		submitLabel="Add domain"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="domain-name">Domain</Field.Label>
				<Input
					id="domain-name"
					name="name"
					placeholder="example.com"
					required
					maxlength={253}
					autocapitalize="off"
					spellcheck="false"
					class="font-mono text-sm"
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description
					>A domain or subdomain you control, such as mail.example.com.</Field.Description
				>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
			<Field.Field orientation="horizontal">
				<Checkbox id="domain-sending" name="sending" checked />
				<Field.Content>
					<Field.Label for="domain-sending">Send from this domain</Field.Label>
					<Field.Description>Turn off to verify it now and start sending later.</Field.Description>
				</Field.Content>
			</Field.Field>
			<Field.Field orientation="horizontal">
				<Checkbox id="domain-auto-dns" name="autoDns" checked />
				<Field.Content>
					<Field.Label for="domain-auto-dns">Create records in Cloudflare when possible</Field.Label
					>
					<Field.Description>
						When the domain is in the platform's Cloudflare zone, Skiff publishes DKIM, SPF and
						DMARC itself. Otherwise you copy them from the next page.
					</Field.Description>
				</Field.Content>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet nameCell(row: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<GlobeIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/email/domains/[name]', { name: row.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline">{row.name}</a
			>
			{#if row.status !== 'verified' && missing(row) > 0}
				<p class="text-xs text-muted-foreground">
					{missing(row)} required {missing(row) === 1 ? 'record' : 'records'} missing
				</p>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet statusCell(row: Row)}
	<StatusBadge status={row.status} />
{/snippet}

{#snippet sendingCell(row: Row)}
	{row.sending ? 'On' : 'Off'}
{/snippet}

{#snippet checkedCell(row: Row)}
	{#if row.lastCheckedAt}
		<time datetime={row.lastCheckedAt}>{formatRelative(row.lastCheckedAt)}</time>
	{:else}
		Never
	{/if}
{/snippet}

{#snippet createdCell(row: Row)}
	<time datetime={row.createdAt}>{formatDate(row.createdAt)}</time>
{/snippet}

{#snippet actionsCell(row: Row)}
	<RowMenu label="Actions for {row.name}">
		<DropdownMenu.Item onSelect={() => void runAction('?/check', { name: row.name })}>
			<RefreshCwIcon />Check now
		</DropdownMenu.Item>
		<DropdownMenu.Separator />
		<DropdownMenu.Item
			onSelect={() => goto(resolve('/(dashboard)/email/domains/[name]', { name: row.name }))}
		>
			<ArrowRightIcon />Open domain
		</DropdownMenu.Item>
	</RowMenu>
{/snippet}
