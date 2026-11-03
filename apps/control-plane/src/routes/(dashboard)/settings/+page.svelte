<script lang="ts">
	import Building2Icon from '@lucide/svelte/icons/building-2';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Avatar from '#lib/components/ui/avatar/index.js';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import { formatDate, formatDateTime, shortId } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface SettingsFormResult {
		fieldErrors?: Record<string, string>;
		createdKey?: string;
		createdKeyName?: string;
		createdKeyScopes?: string[];
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as SettingsFormResult | null);

	let createOpen = $state(false);
	let keyOpen = $state(false);
	let expiresIn = $state('90');
	const expiryOptions = [
		{ value: '30', label: '30 days' },
		{ value: '90', label: '90 days' },
		{ value: '365', label: '365 days' },
		{ value: 'never', label: 'Never' }
	];

	$effect(() => {
		if (result?.createdKey) keyOpen = true;
	});

	function roleBadge(role: string): BadgeVariant {
		if (role === 'owner') return 'brand';
		if (role === 'admin') return 'info';
		return 'neutral';
	}

	function keyState(key: { enabled: boolean; expiresAt: string | null }): string {
		if (!key.enabled) return 'disabled';
		if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return 'expired';
		return 'active';
	}

	function initials(name: string): string {
		return (
			name
				.split(/\s+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0]?.toUpperCase() ?? '')
				.join('') || '?'
		);
	}

	function revoke(key: { id: string; name: string | null }) {
		askConfirm({
			title: `Revoke ${key.name ?? 'this API key'}?`,
			description: 'Requests using it stop working immediately. This cannot be undone.',
			confirmLabel: 'Revoke key',
			tone: 'danger',
			action: '?/deleteKey',
			fields: { keyId: key.id }
		});
	}
</script>

<svelte:head>
	<title>Organisation settings · Skiff</title>
</svelte:head>

<div class="space-y-5">
	<div class="grid items-start gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"
					><Building2Icon class="size-4 text-muted-foreground" />Organisation</Card.Title
				>
				<Card.Description>Tenant boundary for every project and deployment.</Card.Description>
			</Card.Header>
			<Card.Content>
				<dl class="kv">
					<dt>Name</dt>
					<dd class="font-medium">{data.org.name}</dd>
					<dt>Slug</dt>
					<dd class="font-mono text-[12.5px]">{data.org.slug ?? '—'}</dd>
					<dt>Your role</dt>
					<dd><Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge></dd>
					<dt>Created</dt>
					<dd class="text-[13px]">{formatDateTime(data.org.createdAt)}</dd>
					<dt>Org ID</dt>
					<dd class="flex items-center justify-end gap-1">
						<span class="truncate font-mono text-[12px]" title={data.org.id}
							>{shortId(data.org.id, 16)}</span
						>
						<CopyButton value={data.org.id} label="Copy org ID" iconOnly />
					</dd>
				</dl>
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2">
					<UsersIcon class="size-4 text-muted-foreground" />Members
					<Badge variant="neutral" class="font-mono">{data.members.length}</Badge>
				</Card.Title>
				<Card.Description
					>Roles are enforced identically by the dashboard, API, CLI and MCP.</Card.Description
				>
			</Card.Header>
			<Card.Content>
				{#if data.members.length === 0}
					<EmptyState
						icon={UsersIcon}
						compact
						title="No members loaded"
						description="The auth tables may still be initialising on first boot."
					/>
				{:else}
					<Item.Group class="gap-1">
						{#each data.members as member (member.userId)}
							<Item.Root size="sm" class="px-0">
								<Item.Media>
									<Avatar.Root class="size-8">
										<Avatar.Fallback class="text-[11px] font-semibold"
											>{initials(member.name)}</Avatar.Fallback
										>
									</Avatar.Root>
								</Item.Media>
								<Item.Content class="min-w-0">
									<Item.Title class="truncate">{member.name}</Item.Title>
									<Item.Description class="truncate"
										>{member.email ?? 'Email hidden'}</Item.Description
									>
								</Item.Content>
								<Item.Actions>
									<span class="hidden text-xs text-muted-foreground sm:inline"
										>joined {formatDate(member.joinedAt)}</span
									>
									<Badge variant={roleBadge(member.role)} class="capitalize">{member.role}</Badge>
								</Item.Actions>
							</Item.Root>
						{/each}
					</Item.Group>
				{/if}
			</Card.Content>
			{#if !data.canSeeEmails}
				<Card.Footer class="text-xs text-muted-foreground">
					Member emails are visible to owners and admins only.
				</Card.Footer>
			{/if}
		</Card.Root>
	</div>

	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<Card.Title class="flex items-center gap-2">
				<KeyRoundIcon class="size-4 text-muted-foreground" />API keys
				{#if data.canReadKeys}<Badge variant="neutral" class="font-mono"
						>{data.apiKeys.length}</Badge
					>{/if}
			</Card.Title>
			<Card.Description>
				Headless access for CI, scripts and the CLI. A key's permissions are always a subset of your
				current role.
			</Card.Description>
			{#if data.canCreateKey}
				<Card.Action class="self-center">
					<Button onclick={() => (createOpen = true)}><PlusIcon />Create API key</Button>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content class="px-0">
			{#if data.apiKeysError}
				<div class="border-b p-4">
					<Alert.Root variant="warning">
						<TriangleAlertIcon />
						<Alert.Description>{data.apiKeysError}</Alert.Description>
					</Alert.Root>
				</div>
			{/if}
			{#if !data.canReadKeys}
				<p class="p-4 text-sm text-muted-foreground">Your role cannot list API keys.</p>
			{:else if data.apiKeys.length === 0}
				<div class="p-4">
					<EmptyState
						icon={KeyRoundIcon}
						compact
						title="No API keys"
						description="Create a key for the CLI or CI. Prefer narrow scopes and a short expiry."
					/>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Key</Table.Head>
							<Table.Head class="hidden md:table-cell">Created</Table.Head>
							<Table.Head class="hidden md:table-cell">Expires</Table.Head>
							<Table.Head class="hidden lg:table-cell">Last used</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.apiKeys as key (key.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<p class="font-medium">{key.name ?? 'Unnamed key'}</p>
									<p class="font-mono text-[11px] text-muted-foreground">
										{key.start ?? key.prefix ?? key.id}
									</p>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell"
									>{formatDate(key.createdAt)}</Table.Cell
								>
								<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
									{key.expiresAt ? formatDate(key.expiresAt) : 'Never'}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
									{key.lastRequest ? formatDateTime(key.lastRequest) : 'Never'}
								</Table.Cell>
								<Table.Cell><StatusBadge status={keyState(key)} /></Table.Cell>
								<Table.Cell class="pr-4">
									{#if data.canRevokeKey}
										<Button variant="ghost-danger" size="sm" onclick={() => revoke(key)}
											>Revoke</Button
										>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Card.Content>
		{#if data.canReadKeys && data.apiKeys.length > 0}
			<Card.Footer class="py-3 text-xs text-muted-foreground">
				Keys are user-owned. Their scopes are intersected with your current role on every request.
			</Card.Footer>
		{/if}
	</Card.Root>
</div>

{#if data.canCreateKey}
	<FormDialog
		bind:open={createOpen}
		icon={KeyRoundIcon}
		title="Create API key"
		description="The full key is shown once. Revoking a key or narrowing your role takes effect immediately."
		action="?/createKey"
		submitLabel="Create key"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-[1fr_10rem]">
				<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
					<Field.Label for="key-name">Name</Field.Label>
					<Input
						id="key-name"
						name="name"
						maxlength={64}
						placeholder="CI deploy key"
						required
						aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
					/>
					{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
				</Field.Field>
				<Field.Field>
					<Field.Label for="key-expiry">Expires after</Field.Label>
					<Select.Root type="single" name="expiresIn" bind:value={expiresIn}>
						<Select.Trigger id="key-expiry" class="w-full">
							{expiryOptions.find((option) => option.value === expiresIn)?.label}
						</Select.Trigger>
						<Select.Content>
							{#each expiryOptions as option (option.value)}
								<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
				</Field.Field>
			</div>

			<Field.Set>
				<Field.Legend variant="label">Scopes</Field.Legend>
				<Field.Description>
					Everything you hold is selected. Uncheck what this key does not need — it can never exceed
					your role.
				</Field.Description>
				<div
					class="grid max-h-72 gap-x-6 gap-y-4 overflow-y-auto rounded-lg border bg-muted/25 p-4 sm:grid-cols-2"
				>
					{#each data.scopeGroups as group (group.resource)}
						<div class="space-y-2">
							<p class="eyebrow">{group.resource}</p>
							{#each group.permissions as permission (permission)}
								<Field.Field orientation="horizontal" class="gap-2">
									<Checkbox id="scope-{permission}" name="permissions" value={permission} checked />
									<Field.Label for="scope-{permission}" class="font-mono text-xs font-normal">
										{permission.split(':')[1] ?? permission}
									</Field.Label>
								</Field.Field>
							{/each}
						</div>
					{/each}
				</div>
				{#if result?.fieldErrors?.permissions}<Field.Error
						>{result.fieldErrors.permissions}</Field.Error
					>{/if}
			</Field.Set>
		</Field.Group>
	</FormDialog>
{/if}

{#if result?.createdKey}
	<SecretDialog
		bind:open={keyOpen}
		title="{result.createdKeyName ?? 'API key'} created"
		description="Use it as a Bearer token or with skif login --token."
		value={result.createdKey}
	>
		{#if result.createdKeyScopes?.length}
			<div class="space-y-1.5">
				<p class="eyebrow">Scopes granted</p>
				<div class="flex flex-wrap gap-1">
					{#each result.createdKeyScopes as scope (scope)}
						<Badge variant="outline" class="font-mono text-[11px]">{scope}</Badge>
					{/each}
				</div>
			</div>
		{/if}
	</SecretDialog>
{/if}
