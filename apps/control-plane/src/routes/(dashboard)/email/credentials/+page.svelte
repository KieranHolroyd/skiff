<script lang="ts">
	import { resolve } from '$app/paths';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { EmailCredentialSecret } from '@skiff/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import { formatDate, formatRelative } from '../../_lib/format.js';
	import NotSetUp from '../_lib/NotSetUp.svelte';
	import type { PageProps } from './$types';

	interface CreateFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		created?: EmailCredentialSecret;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as CreateFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});
	const area = $derived(data.emailArea);
	const canManage = $derived(area.can.credentials && area.enabled);

	let createOpen = $state(false);
	let secretOpen = $state(false);
	let secret = $state<EmailCredentialSecret | null>(null);
	let query = $state('');
	let matched = $state(0);

	$effect(() => {
		if (result?.created) {
			secret = result.created;
			secretOpen = true;
		}
	});
	$effect(() => {
		// Drop the password from memory once the dialog is closed.
		if (!secretOpen) secret = null;
	});

	type Row = PageProps['data']['credentials'][number];
	const columns: DataColumn<Row>[] = [
		{ id: 'name', header: 'Credential', value: (row) => row.name, cell: nameCell, class: 'pl-4' },
		{
			id: 'scope',
			header: 'Scope',
			value: (row) => row.projectSlug ?? '',
			cell: scopeCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'from',
			header: 'May send from',
			value: (row) => row.allowedFromDomains.join(' '),
			sortable: false,
			cell: fromCell,
			class: 'hidden lg:table-cell'
		},
		{
			id: 'used',
			header: 'Last used',
			value: (row) => row.lastUsedAt,
			searchable: false,
			descFirst: true,
			cell: usedCell,
			class: 'hidden text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'created',
			header: 'Created',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'hidden font-mono text-xs text-muted-foreground lg:table-cell'
		},
		{ id: 'actions', header: '', srHeader: 'Actions', cell: actionsCell, class: 'w-0 pr-4' }
	];

	function revoke(row: Row) {
		askConfirm({
			title: `Revoke ${row.name}?`,
			description:
				'SMTP logins with this username are refused from now on; apps using it can no longer send. This cannot be undone.',
			confirmLabel: 'Revoke',
			tone: 'danger',
			action: '?/revoke',
			fields: { id: row.id }
		});
	}
</script>

<svelte:head>
	<title>SMTP credentials · Email · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.email.credentials"
		eyebrow="Email"
		title="SMTP credentials"
		description="Usernames and passwords for apps that send through SMTP submission on port 587. Each can be limited to one project and to some of your domains."
	>
		{#if canManage}
			<Button onclick={() => (createOpen = true)}><PlusIcon />New credential</Button>
		{/if}
	</PageHeader>

	{#if !area.configured}
		<NotSetUp platformAdmin={area.can.platform} compact />
	{/if}

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Credentials are not visible"
			description="This account does not have the email:read permission."
		/>
	{:else if data.credentials.length === 0}
		<EmptyState
			icon={KeyRoundIcon}
			title="No SMTP credentials"
			description="Create one for an app or service that speaks SMTP. The REST API and function bindings don't need one."
		>
			{#if canManage}
				<Button onclick={() => (createOpen = true)}><PlusIcon />New credential</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input
					placeholder="Search credentials"
					bind:value={query}
					aria-label="Search credentials"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				Host <span class="font-mono">{area.hostnames.submission}</span> · port 587 (STARTTLS)
			</p>
		</div>
		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="SMTP credentials"
				rows={data.credentials}
				{columns}
				rowId={(row) => row.id}
				search={query.trim()}
				sort={{ id: 'name', desc: false }}
				onmatch={(count) => (matched = count)}
			/>
		</div>
	{/if}

	{#if !area.can.credentials && !data.denied}
		<p class="text-xs text-muted-foreground">
			Creating and revoking credentials needs <code class="font-mono">email:credentials</code>.
		</p>
	{/if}
</div>

{#if canManage}
	<FormDialog
		bind:open={createOpen}
		icon={KeyRoundIcon}
		title="New SMTP credential"
		description="The password is shown once, right after this. Revoke and create a new one to rotate it."
		action="?/create"
		submitLabel="Create credential"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="credential-name">Name</Field.Label>
				<Input
					id="credential-name"
					name="name"
					placeholder="newsletter app"
					required
					maxlength={80}
					aria-invalid={errors.name ? 'true' : undefined}
				/>
				<Field.Description>For you: shown in this list and the audit log.</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
			{#if data.projects.length > 0}
				<Field.Field data-invalid={errors.project ? true : undefined}>
					<Field.Label for="credential-project">
						Project <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<NativeSelect.Root id="credential-project" name="project" value="" class="w-full">
						<NativeSelect.Option value="">Organisation-wide</NativeSelect.Option>
						{#each data.projects as project (project.slug)}
							<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					<Field.Description>Mail sent with it is logged against the project.</Field.Description>
					{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
				</Field.Field>
			{/if}
			<Field.Set>
				<Field.Legend variant="label">
					May send from <span class="font-normal text-muted-foreground">optional</span>
				</Field.Legend>
				{#if data.domains.length === 0}
					<Field.Description>
						No domains yet. Leave it open to allow every sending domain you add later.
					</Field.Description>
				{:else}
					<Field.Description
						>None ticked means any of the organisation's sending domains.</Field.Description
					>
					<Field.Group class="gap-2">
						{#each data.domains as domain (domain)}
							<Field.Field orientation="horizontal">
								<Checkbox id="credential-from-{domain}" name="allowedFromDomains" value={domain} />
								<Field.Label for="credential-from-{domain}" class="font-mono text-sm font-normal"
									>{domain}</Field.Label
								>
							</Field.Field>
						{/each}
					</Field.Group>
				{/if}
				{#if errors.allowedFromDomains}<Field.Error>{errors.allowedFromDomains}</Field.Error>{/if}
			</Field.Set>
		</Field.Group>
	</FormDialog>
{/if}

{#if secret}
	<SecretDialog
		bind:open={secretOpen}
		title="Password for {secret.name}"
		description="Configure your app with these SMTP settings."
		value={secret.password}
	>
		<DetailList>
			<dt>Host</dt>
			<dd><CopyValue value={secret.smtp.host} label="host" /></dd>
			<dt>Port</dt>
			<dd><CopyValue value={String(secret.smtp.port)} label="port" /></dd>
			<dt>Security</dt>
			<dd class="font-mono text-xs">{secret.smtp.secure === 'starttls' ? 'STARTTLS' : 'TLS'}</dd>
			<dt>Username</dt>
			<dd><CopyValue value={secret.username} label="username" /></dd>
		</DetailList>
	</SecretDialog>
{/if}

{#snippet nameCell(row: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<KeyRoundIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<p class="text-sm font-medium">{row.name}</p>
			<p class="font-mono text-xs text-muted-foreground">{row.username}</p>
		</div>
	</div>
{/snippet}

{#snippet scopeCell(row: Row)}
	{#if row.projectSlug}
		<Badge
			variant="outline"
			class="font-mono font-normal"
			href={resolve('/(dashboard)/projects/[slug]', { slug: row.projectSlug })}
		>
			<FolderKanbanIcon />{row.projectSlug}
		</Badge>
	{:else}
		<span class="text-xs text-muted-foreground">Organisation</span>
	{/if}
{/snippet}

{#snippet fromCell(row: Row)}
	{#if row.allowedFromDomains.length === 0}
		<span class="text-xs text-muted-foreground">Any sending domain</span>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each row.allowedFromDomains as domain (domain)}
				<Badge variant="secondary" class="font-mono font-normal">{domain}</Badge>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet usedCell(row: Row)}
	{#if row.lastUsedAt}
		<time datetime={row.lastUsedAt}>{formatRelative(row.lastUsedAt)}</time>
	{:else}
		Never
	{/if}
{/snippet}

{#snippet createdCell(row: Row)}
	<time datetime={row.createdAt}>{formatDate(row.createdAt)}</time>
{/snippet}

{#snippet actionsCell(row: Row)}
	{#if area.can.credentials}
		<Button variant="ghost" size="sm" onclick={() => revoke(row)} aria-label="Revoke {row.name}">
			<Trash2Icon />Revoke
		</Button>
	{/if}
{/snippet}
