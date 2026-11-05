<script lang="ts">
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDate, formatDateTime, formatRelative, plural } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	interface KeyFormResult {
		fieldErrors?: Record<string, string>;
		createdKey?: string;
		createdKeyName?: string;
		createdKeyScopes?: string[];
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as KeyFormResult | null);

	let createOpen = $state(false);
	let keyOpen = $state(false);
	let expiresIn = $state('90');
	const expiryOptions = [
		{ value: '30', label: '30 days' },
		{ value: '90', label: '90 days' },
		{ value: '365', label: '1 year' },
		{ value: 'never', label: 'Never' }
	];

	$effect(() => {
		if (result?.createdKey) keyOpen = true;
	});

	// --- scope picker ---------------------------------------------------------------------------

	const allScopes = $derived(
		data.scopeGroups.flatMap((group) => group.permissions.map((entry) => entry.permission))
	);
	/** Starts on the narrowest useful preset; least privilege is the default, not an afterthought. */
	let selected = $state<string[]>([]);
	let pickerReady = false;

	function openCreate() {
		if (!pickerReady) {
			selected = [
				...(data.presets.find((preset) => preset.id === 'deploy')?.permissions ?? allScopes)
			];
			pickerReady = true;
		}
		createOpen = true;
	}

	const sameSet = (a: readonly string[], b: readonly string[]) =>
		a.length === b.length && a.every((value) => b.includes(value));

	const activePreset = $derived(
		data.presets.find(
			(preset) => preset.permissions.length > 0 && sameSet(preset.permissions, selected)
		)
	);
	const destructiveSelected = $derived(
		data.scopeGroups
			.flatMap((group) => group.permissions)
			.filter((entry) => entry.destructive && selected.includes(entry.permission)).length
	);

	function toggle(permission: string, on: boolean) {
		selected = on
			? [...new Set([...selected, permission])]
			: selected.filter((value) => value !== permission);
	}

	function toggleGroup(group: (typeof data.scopeGroups)[number]) {
		const perms: string[] = group.permissions.map((entry) => entry.permission);
		const all = perms.every((permission) => selected.includes(permission));
		selected = all
			? selected.filter((value) => !perms.includes(value))
			: [...new Set([...selected, ...perms])];
	}

	// --- key list -------------------------------------------------------------------------------

	type Key = (typeof data.apiKeys)[number];
	const DAY = 86_400_000;

	function keyState(key: Key): string {
		if (!key.enabled) return 'disabled';
		if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return 'expired';
		return 'active';
	}

	function expiry(key: Key): { text: string; tone: 'muted' | 'warning' | 'danger' } {
		if (!key.expiresAt) return { text: 'Never', tone: 'muted' };
		const left = Date.parse(key.expiresAt) - Date.now();
		if (left <= 0) return { text: `Expired ${formatDate(key.expiresAt)}`, tone: 'danger' };
		const days = Math.ceil(left / DAY);
		if (days <= 14) return { text: `In ${days} ${plural(days, 'day')}`, tone: 'warning' };
		return { text: formatDate(key.expiresAt), tone: 'muted' };
	}

	function scopeSummary(key: Key): { label: string; title: string } {
		if (!key.scopes)
			return { label: 'Full role', title: 'Acts with your whole role (CLI browser login).' };
		const preset = data.presets.find(
			(entry) => entry.permissions.length > 0 && sameSet(entry.permissions, key.scopes!)
		);
		return {
			label: preset?.label ?? `${key.scopes.length} ${plural(key.scopes.length, 'scope')}`,
			title: key.scopes.join(', ')
		};
	}

	const soon = $derived(
		data.apiKeys.filter((key) => {
			if (!key.expiresAt || !key.enabled) return false;
			const left = Date.parse(key.expiresAt) - Date.now();
			return left > 0 && left <= 14 * DAY;
		}).length
	);

	function revoke(key: Key) {
		askConfirm({
			title: `Revoke ${key.name ?? 'this API key'}?`,
			description: 'Requests using it stop working immediately. This cannot be undone.',
			confirmLabel: 'Revoke key',
			tone: 'danger',
			action: '?/deleteKey',
			fields: { keyId: key.id }
		});
	}

	const curl = $derived(
		`curl -H "Authorization: Bearer $SKIFF_TOKEN" ${data.platform.origin}/api/v1/projects`
	);
</script>

<svelte:head>
	<title>API keys · Settings · Skiff</title>
</svelte:head>

<SettingsHeader id="api-keys">
	{#snippet actions()}
		{#if data.canCreateKey}
			<Button onclick={openCreate}><PlusIcon />Create API key</Button>
		{/if}
	{/snippet}
</SettingsHeader>

{#if data.apiKeysError}
	<Alert.Root variant="warning">
		<TriangleAlertIcon />
		<Alert.Description>{data.apiKeysError}</Alert.Description>
	</Alert.Root>
{/if}

{#if soon > 0}
	<Alert.Root variant="warning">
		<TriangleAlertIcon />
		<Alert.Title
			>{soon}
			{plural(soon, 'key')}
			{soon === 1 ? 'expires' : 'expire'} within two weeks</Alert.Title
		>
		<Alert.Description
			>Create a replacement and update the pipeline before it stops working; keys cannot be
			extended.</Alert.Description
		>
	</Alert.Root>
{/if}

<Panel
	title="Your keys"
	icon={KeyRoundIcon}
	count={data.canReadKeys ? data.apiKeys.length : undefined}
	flush
>
	{#if !data.canReadKeys}
		<p class="p-4 text-sm text-muted-foreground">
			Your role can create keys but not list them. Keep the key safe when it is shown.
		</p>
	{:else if data.apiKeys.length === 0}
		<div class="p-4">
			<EmptyState
				icon={KeyRoundIcon}
				compact
				title="No API keys yet"
				description="Create one for CI or a script. Start from a narrow preset and a short expiry."
			>
				{#if data.canCreateKey}
					<Button size="sm" onclick={openCreate}><PlusIcon />Create API key</Button>
				{/if}
			</EmptyState>
		</div>
	{:else}
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">Key</Table.Head>
					<Table.Head class="hidden sm:table-cell">Access</Table.Head>
					<Table.Head class="hidden md:table-cell">Expires</Table.Head>
					<Table.Head class="hidden lg:table-cell">Last used</Table.Head>
					<Table.Head>Status</Table.Head>
					<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.apiKeys as key (key.id)}
					{@const ends = expiry(key)}
					{@const scope = scopeSummary(key)}
					<Table.Row>
						<Table.Cell class="pl-4">
							<div class="flex items-center gap-3">
								<span
									class="hidden size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground sm:flex"
								>
									<KeyRoundIcon class="size-3.5" />
								</span>
								<div class="min-w-0">
									<p class="truncate font-medium">{key.name ?? 'Unnamed key'}</p>
									<p class="font-mono text-xs text-muted-foreground">
										{key.start ?? key.prefix ?? key.id}…
										<span class="font-sans">· created {formatDate(key.createdAt)}</span>
									</p>
								</div>
							</div>
						</Table.Cell>
						<Table.Cell class="hidden sm:table-cell">
							<Badge
								variant={key.scopes ? 'outline' : 'secondary'}
								class="font-normal"
								title={scope.title}>{scope.label}</Badge
							>
						</Table.Cell>
						<Table.Cell
							class="hidden text-xs md:table-cell {ends.tone === 'warning'
								? 'font-medium text-warning'
								: ends.tone === 'danger'
									? 'text-destructive'
									: 'text-muted-foreground'}"
						>
							{ends.text}
						</Table.Cell>
						<Table.Cell
							class="hidden text-xs text-muted-foreground lg:table-cell"
							title={key.lastRequest ? formatDateTime(key.lastRequest) : undefined}
						>
							{key.lastRequest ? formatRelative(key.lastRequest) : 'Never used'}
						</Table.Cell>
						<Table.Cell><StatusBadge status={keyState(key)} /></Table.Cell>
						<Table.Cell class="pr-4">
							{#if data.canRevokeKey}
								<Button variant="ghost-danger" size="sm" onclick={() => revoke(key)}>Revoke</Button>
							{/if}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{/if}
	{#snippet footer()}
		Keys belong to you, not the organisation. Their scopes are intersected with your current role on
		every request, so narrowing your role narrows every key.
	{/snippet}
</Panel>

<Panel title="Using a key" icon={TerminalIcon}>
	<div class="grid gap-4 lg:grid-cols-2">
		<div class="space-y-2">
			<p class="text-sm font-medium">CLI</p>
			<div
				class="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3 font-mono text-xs"
			>
				<span class="text-muted-foreground select-none">$</span>
				<span class="min-w-0 flex-1 truncate">skif login --token $SKIFF_TOKEN</span>
				<CopyButton value="skif login --token $SKIFF_TOKEN" label="Copy command" iconOnly />
			</div>
			<p class="text-xs text-muted-foreground">
				Or run <code>skif login</code> on a machine with a browser; it creates a key for you.
			</p>
		</div>
		<div class="space-y-2">
			<p class="text-sm font-medium">HTTP API</p>
			<div
				class="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3 font-mono text-xs"
			>
				<span class="text-muted-foreground select-none">$</span>
				<span class="min-w-0 flex-1 truncate" title={curl}>{curl}</span>
				<CopyButton value={curl} label="Copy request" iconOnly />
			</div>
			<p class="text-xs text-muted-foreground">
				Send it as a Bearer token. Every request is recorded in the audit log against the key.
			</p>
		</div>
	</div>
</Panel>

{#if data.canCreateKey}
	<FormDialog
		bind:open={createOpen}
		icon={KeyRoundIcon}
		title="Create API key"
		description="The full key is shown once. Revoking it, or narrowing your role, takes effect immediately."
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
						placeholder="GitHub Actions deploy"
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
				<div class="flex flex-wrap items-baseline justify-between gap-2">
					<Field.Legend variant="label" class="mb-0">Access</Field.Legend>
					<span class="text-xs text-muted-foreground tabular-nums">
						{selected.length} of {allScopes.length} scopes
						{#if destructiveSelected > 0}
							· <span class="text-destructive">{destructiveSelected} destructive</span>
						{/if}
					</span>
				</div>
				<div class="grid gap-2 sm:grid-cols-3" role="group" aria-label="Presets">
					{#each data.presets as preset (preset.id)}
						{@const on = activePreset?.id === preset.id}
						<button
							type="button"
							disabled={preset.permissions.length === 0}
							onclick={() => (selected = [...preset.permissions])}
							aria-pressed={on}
							class="rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-50 aria-pressed:border-brand/50 aria-pressed:bg-brand/5 aria-pressed:ring-2 aria-pressed:ring-brand/15"
						>
							<span class="block text-sm font-medium">{preset.label}</span>
							<span class="block text-xs text-muted-foreground">{preset.description}</span>
						</button>
					{/each}
				</div>
				<div
					class="grid max-h-72 gap-x-6 gap-y-4 overflow-y-auto rounded-lg border bg-muted/25 p-4 sm:grid-cols-2"
				>
					{#each data.scopeGroups as group (group.resource)}
						{@const count = group.permissions.filter((entry) =>
							selected.includes(entry.permission)
						).length}
						<div class="space-y-2">
							<button
								type="button"
								onclick={() => toggleGroup(group)}
								class="flex w-full items-center justify-between gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"
								title={count === group.permissions.length
									? 'Clear this group'
									: 'Select this group'}
							>
								{group.label}
								<span class="font-normal tabular-nums">{count}/{group.permissions.length}</span>
							</button>
							{#each group.permissions as entry (entry.permission)}
								<Field.Field orientation="horizontal" class="gap-2">
									<Checkbox
										id="scope-{entry.permission}"
										name="permissions"
										value={entry.permission}
										checked={selected.includes(entry.permission)}
										onCheckedChange={(on) => toggle(entry.permission, on === true)}
									/>
									<Field.Label
										for="scope-{entry.permission}"
										class="font-mono text-xs font-normal {entry.destructive
											? 'text-destructive'
											: ''}"
									>
										{entry.permission.split(':')[1] ?? entry.permission}
									</Field.Label>
								</Field.Field>
							{/each}
						</div>
					{/each}
				</div>
				{#if result?.fieldErrors?.permissions}<Field.Error
						>{result.fieldErrors.permissions}</Field.Error
					>{:else}<Field.Description>
						A key can never exceed your role. Red scopes delete things or remove people.
					</Field.Description>{/if}
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
				<p class="text-xs font-medium text-muted-foreground">Scopes granted</p>
				<div class="flex flex-wrap gap-1">
					{#each result.createdKeyScopes as scope (scope)}
						<Badge variant="outline" class="font-mono text-xs">{scope}</Badge>
					{/each}
				</div>
			</div>
		{/if}
	</SecretDialog>
{/if}
