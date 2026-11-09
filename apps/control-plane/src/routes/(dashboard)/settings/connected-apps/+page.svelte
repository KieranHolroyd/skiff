<script lang="ts">
	import PlugIcon from '@lucide/svelte/icons/plug';
	import UsersIcon from '@lucide/svelte/icons/users';
	import { resolve } from '$app/paths';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDate, formatDateTime, formatRelative, plural } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type App = (typeof data.mine)[number];

	function label(app: App): string {
		return app.name ?? (app.registration === 'metadata-document' ? displayHost(app.clientId) : 'Unnamed client');
	}

	function displayHost(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}

	function revoke(app: App, owner?: string) {
		askConfirm({
			title: `Disconnect ${label(app)}?`,
			description: owner
				? `${owner} will have to approve it again before it can call Yoal. Its tokens stop working on the next request.`
				: 'Its tokens stop working on the next request, and it has to ask for your approval again to reconnect.',
			confirmLabel: 'Disconnect',
			tone: 'danger',
			action: '?/revoke',
			fields: { grantId: app.id }
		});
	}
</script>

<svelte:head>
	<title>Connected apps · Settings · Yoal</title>
</svelte:head>

<SettingsHeader id="connected-apps" />

{#snippet client(app: App)}
	<div class="flex items-center gap-3">
		<span
			class="hidden size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground sm:flex"
		>
			<PlugIcon class="size-3.5" />
		</span>
		<div class="min-w-0">
			<p class="truncate font-medium">{label(app)}</p>
			<p class="truncate font-mono text-xs text-muted-foreground" title={app.clientId}>
				{app.clientId}
			</p>
			<p class="text-xs text-muted-foreground">
				{app.registration === 'metadata-document' ? 'Metadata document' : 'Registered client'}
				· approved {formatDate(app.createdAt)}
			</p>
		</div>
	</div>
{/snippet}

{#snippet access(app: App)}
	<details class="group text-xs">
		<summary class="cursor-pointer list-none text-muted-foreground hover:text-foreground">
			<Badge variant="outline" class="font-normal">
				{app.permissions.length}
				{plural(app.permissions.length, 'permission')}
			</Badge>
			{#if app.destructive > 0}
				<Badge variant="outline" class="border-destructive/40 font-normal text-destructive">
					{app.destructive} destructive
				</Badge>
			{/if}
		</summary>
		<div class="mt-2 flex max-w-md flex-wrap gap-1">
			{#each app.permissions as scope (scope)}
				<Badge variant="secondary" class="font-mono text-[0.7rem] font-normal">{scope}</Badge>
			{/each}
			{#each app.identityScopes as scope (scope)}
				<Badge variant="outline" class="font-mono text-[0.7rem] font-normal text-muted-foreground"
					>{scope}</Badge
				>
			{/each}
		</div>
	</details>
{/snippet}

{#snippet lastUsed(app: App)}
	<span title={app.lastUsedAt ? formatDateTime(app.lastUsedAt) : undefined}>
		{app.lastUsedAt ? formatRelative(app.lastUsedAt) : 'Not used yet'}
	</span>
{/snippet}

<Panel title="Your connected apps" icon={PlugIcon} count={data.mine.length} flush>
	{#if data.mine.length === 0}
		<div class="p-4">
			<EmptyState
				icon={PlugIcon}
				compact
				title="No connected apps"
				description="When you approve an MCP client or agent on the consent screen, it appears here."
			>
				<Button size="sm" variant="outline" href={resolve('/(dashboard)/docs/[...slug]', { slug: 'clients/mcp' })}
					>Connect an MCP client</Button
				>
			</EmptyState>
		</div>
	{:else}
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">App</Table.Head>
					<Table.Head class="hidden sm:table-cell">Access</Table.Head>
					<Table.Head class="hidden lg:table-cell">Last used</Table.Head>
					<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each data.mine as app (app.id)}
					<Table.Row>
						<Table.Cell class="max-w-0 pl-4 sm:max-w-none">{@render client(app)}</Table.Cell>
						<Table.Cell class="hidden align-top sm:table-cell">{@render access(app)}</Table.Cell>
						<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
							{@render lastUsed(app)}
						</Table.Cell>
						<Table.Cell class="pr-4">
							<Button variant="ghost-danger" size="sm" onclick={() => revoke(app)}>Disconnect</Button>
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{/if}
	{#snippet footer()}
		An app can never do more than your role allows: its permissions are intersected with your
		current role on every call. Disconnecting ends its access straight away.
	{/snippet}
</Panel>

{#if data.canManageOrg}
	<Panel title="Other members’ connected apps" icon={UsersIcon} count={data.others.length} flush>
		{#if data.others.length === 0}
			<p class="p-4 text-sm text-muted-foreground">
				Nobody else in this organisation has connected an app.
			</p>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">App</Table.Head>
						<Table.Head class="hidden md:table-cell">Member</Table.Head>
						<Table.Head class="hidden sm:table-cell">Access</Table.Head>
						<Table.Head class="hidden lg:table-cell">Last used</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.others as app (app.id)}
						{@const owner = app.user.name ?? app.user.email ?? 'The member'}
						<Table.Row>
							<Table.Cell class="max-w-0 pl-4 sm:max-w-none">{@render client(app)}</Table.Cell>
							<Table.Cell class="hidden text-sm md:table-cell">
								<p class="truncate">{app.user.name ?? app.user.email}</p>
								<p class="truncate text-xs text-muted-foreground">
									{app.user.email}{app.user.role ? ` · ${app.user.role}` : ''}
								</p>
							</Table.Cell>
							<Table.Cell class="hidden align-top sm:table-cell">{@render access(app)}</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
								{@render lastUsed(app)}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if app.canRevoke}
									<Button variant="ghost-danger" size="sm" onclick={() => revoke(app, owner)}
										>Disconnect</Button
									>
								{:else}
									<span class="text-xs text-muted-foreground" title="Only an owner can disconnect an owner’s apps"
										>Owner only</span
									>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#snippet footer()}
			Owners and admins see every member’s approved apps and can disconnect them; only an owner can
			disconnect an owner’s. Removing someone from the organisation also ends their apps’ access.
		{/snippet}
	</Panel>
{/if}
