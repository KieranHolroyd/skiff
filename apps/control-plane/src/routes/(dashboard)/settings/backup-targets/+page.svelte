<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let kind = $state<'local' | 's3'>('s3');
	const result = $derived(form as { message?: string; success?: string; credentials?: unknown } | null);
</script>

<svelte:head><title>Backup targets · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	{#if result?.message}
		<div class="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
			{result.message}
		</div>
	{/if}
	{#if result?.success}
		<div class="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm">
			{result.success}
		</div>
	{/if}
	{#if result?.credentials}
		{@const credentials = result.credentials as { accessKeyId: string; secretAccessKey: string; note: string }}
		<div class="rounded-md border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
			<p class="font-medium">Copy these now — they are shown once.</p>
			<p class="mt-1 font-mono">Access key: {credentials.accessKeyId}</p>
			<p class="font-mono">Secret key: {credentials.secretAccessKey}</p>
			<p class="mt-1 text-muted-foreground">{credentials.note}</p>
		</div>
	{/if}

	<Panel
		title="Where backups are written"
		description="A local directory or any S3-compatible bucket. An org target overrides the platform default; with neither, backups keep using the platform object store."
		icon={DatabaseBackupIcon}
		count={data.targets.length}
	>
		{#if data.targets.length === 0}
			<EmptyState
				compact
				icon={ArchiveIcon}
				title="No targets yet"
				description="Backups currently use the platform object store. Add a target to move them."
			/>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Name</Table.Head>
						<Table.Head>Kind</Table.Head>
						<Table.Head>Scope</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="hidden md:table-cell">Location</Table.Head>
						<Table.Head class="text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.targets as target (target.id)}
						<Table.Row>
							<Table.Cell>
								<p class="font-medium">{target.name}</p>
								<p class="font-mono text-xs text-muted-foreground">{target.id}</p>
								{#if target.writeOnly}
									<p class="text-xs text-muted-foreground">write-only: retention needs a privileged key</p>
								{/if}
								{#if target.lastError}
									<p class="text-xs text-destructive">{target.lastError}</p>
								{/if}
							</Table.Cell>
							<Table.Cell>
								<span class="inline-flex items-center gap-1">
									{#if target.kind === 'local'}<HardDriveIcon class="size-3.5" />{:else}<CloudIcon class="size-3.5" />{/if}
									{target.kind}
								</span>
							</Table.Cell>
							<Table.Cell>{target.orgId === null ? 'platform' : 'org'}</Table.Cell>
							<Table.Cell><StatusBadge status={target.status} /></Table.Cell>
							<Table.Cell class="hidden max-w-64 truncate font-mono text-xs md:table-cell">
								{target.kind === 'local' ? target.path : `${target.endpoint ?? 'aws'} ${target.bucket}/${target.pathPrefix}`}
								<p class="text-muted-foreground">checked {formatDateTime(target.lastCheckedAt)}</p>
							</Table.Cell>
							<Table.Cell class="text-right">
								{#if data.canEdit}
									<form method="POST" action="?/test" class="inline">
										<input type="hidden" name="id" value={target.id} />
										<Button type="submit" variant="outline" size="sm">Test</Button>
									</form>
									<form method="POST" action="?/remove" class="ml-2 inline">
										<input type="hidden" name="id" value={target.id} />
										<Button type="submit" variant="ghost" size="sm">Remove</Button>
									</form>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	{#if data.canEdit}
		<Panel title="Add a target" description="Credentials are sealed with the org key and shown once." icon={ArchiveIcon}>
			<form method="POST" action="?/add" class="grid gap-3">
				<div class="flex flex-wrap gap-3">
					<label class="text-sm">
						<span class="text-muted-foreground">Kind</span>
						<select name="kind" bind:value={kind} class="ml-2 rounded-md border bg-background px-2 py-1">
							<option value="s3">S3-compatible</option>
							<option value="local">Local directory</option>
						</select>
					</label>
					<label class="text-sm">
						<span class="text-muted-foreground">Name</span>
						<input name="name" required minlength="3" maxlength="40" class="ml-2 rounded-md border bg-background px-2 py-1" />
					</label>
					<label class="text-sm">
						<span class="text-muted-foreground">Write-only</span>
						<input type="checkbox" name="writeOnly" class="ml-2" />
					</label>
					{#if data.canPlatform}
						<label class="text-sm">
							<span class="text-muted-foreground">Platform default</span>
							<input type="checkbox" name="platform" class="ml-2" />
						</label>
					{/if}
				</div>
				{#if kind === 'local'}
					<label class="text-sm">
						<span class="text-muted-foreground">Directory</span>
						<input name="path" required placeholder="/var/lib/skiff/backups" class="ml-2 w-80 rounded-md border bg-background px-2 py-1" />
					</label>
				{:else}
					<div class="flex flex-wrap gap-3">
						<label class="text-sm">Endpoint <input name="endpoint" placeholder="https://s3.internal:9000" class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
						<label class="text-sm">Bucket <input name="bucket" required class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
						<label class="text-sm">Region <input name="region" placeholder="us-east-1" class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
						<label class="text-sm">Prefix <input name="pathPrefix" placeholder="skiff/backups" class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
					</div>
					<div class="flex flex-wrap gap-3">
						<label class="text-sm">Access key <input name="accessKeyId" required class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
						<label class="text-sm">Secret key <input name="secretAccessKey" type="password" required class="ml-2 rounded-md border bg-background px-2 py-1" /></label>
						<label class="text-sm">Object lock <input type="checkbox" name="objectLock" class="ml-2" /></label>
					</div>
				{/if}
				<div>
					<Button type="submit">Add target</Button>
				</div>
			</form>
		</Panel>
	{/if}
</div>
