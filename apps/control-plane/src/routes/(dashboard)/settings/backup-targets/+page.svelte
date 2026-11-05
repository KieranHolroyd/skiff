<script lang="ts">
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PlugZapIcon from '@lucide/svelte/icons/plug-zap';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import type { BackupTargetView } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let addOpen = $state(false);
	let kind = $state<'local' | 's3'>('s3');

	const platformTarget = $derived(data.targets.find((target) => target.orgId === null) ?? null);
	const orgTarget = $derived(data.targets.find((target) => target.orgId !== null) ?? null);
	/** The org's oldest target, then the platform default, then the built-in store (`resolveTarget`). */
	const effective = $derived(orgTarget ?? platformTarget);

	function openAdd() {
		kind = 's3';
		addOpen = true;
	}

	function location(target: BackupTargetView): string {
		if (target.kind === 'local') return target.path ?? '—';
		const where = target.endpoint ?? `AWS ${target.region ?? 'us-east-1'}`;
		const path = [target.bucket, target.pathPrefix].filter(Boolean).join('/');
		return `${where} · ${path}`;
	}

	let testing = $state<string | null>(null);

	async function test(target: BackupTargetView) {
		testing = target.id;
		await runAction('?/test', { id: target.id });
		testing = null;
	}

	function remove(target: BackupTargetView) {
		askConfirm({
			title: `Remove ${target.name}?`,
			description:
				target === effective
					? 'New backups fall back to the next target in line (the platform default, then the built-in object store). Backups already written there are not deleted.'
					: 'Backups already written there are not deleted; Skiff just stops using it.',
			confirmLabel: 'Remove target',
			tone: 'danger',
			action: '?/remove',
			fields: { id: target.id }
		});
	}
</script>

<svelte:head><title>Backup targets · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	<Panel
		title="Backup targets"
		icon={DatabaseBackupIcon}
		count={data.targets.length}
		description="Where database backups are written: a local directory or any S3-compatible bucket."
		flush
	>
		{#snippet actions()}
			{#if data.canEdit && data.targets.length > 0}
				<Button size="sm" onclick={openAdd}><PlusIcon />Add target</Button>
			{/if}
		{/snippet}

		{#if data.targets.length === 0}
			<div class="p-4">
				<EmptyState
					icon={DatabaseBackupIcon}
					compact
					title="Using the built-in object store"
					description="Backups go to the platform object store. Add a target to write them to your own bucket or a directory instead."
				>
					{#if data.canEdit}
						<Button size="sm" onclick={openAdd}><PlusIcon />Add a target</Button>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Target</Table.Head>
						<Table.Head class="hidden md:table-cell">Location</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.targets as target (target.id)}
						{@const Icon = target.kind === 'local' ? FolderIcon : CloudIcon}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-3">
									<span
										class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									>
										<Icon class="size-4" />
									</span>
									<div class="min-w-0 space-y-0.5">
										<p class="flex flex-wrap items-center gap-1.5">
											<span class="font-mono text-sm font-medium">{target.name}</span>
											{#if target === effective}
												<Badge variant="success">In use</Badge>
											{/if}
											<Badge variant="outline">
												{target.orgId === null ? 'Platform default' : 'Organisation'}
											</Badge>
										</p>
										<p class="text-xs text-muted-foreground">
											{target.kind === 'local' ? 'Local directory' : 'S3-compatible'}
											{#if target.writeOnly}· write-only key{/if}
											{#if target.objectLock}
												· <LockIcon class="inline size-3 align-[-1px]" /> object lock
											{/if}
										</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden max-w-80 md:table-cell">
								<p class="truncate font-mono text-xs" title={location(target)}>
									{location(target)}
								</p>
							</Table.Cell>
							<Table.Cell>
								<StatusBadge
									status={target.status}
									label={target.status === 'ok'
										? 'Reachable'
										: target.status === 'failed'
											? 'Failing'
											: 'Untested'}
								/>
								<p class="mt-1 text-xs text-muted-foreground">
									{target.lastCheckedAt
										? `Checked ${formatDateTime(target.lastCheckedAt)}`
										: 'Never checked'}
								</p>
								{#if target.lastError}
									<p class="mt-0.5 max-w-64 text-xs text-destructive" title={target.lastError}>
										{target.lastError}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="pr-4">
								{#if data.canEdit}
									<div class="flex items-center justify-end gap-1">
										<Button
											size="sm"
											variant="outline"
											onclick={() => test(target)}
											disabled={testing !== null}
										>
											<PlugZapIcon />{testing === target.id ? 'Testing…' : 'Test'}
										</Button>
										<RowMenu label="Actions for {target.name}">
											<DropdownMenu.Item variant="destructive" onSelect={() => remove(target)}>
												<TrashIcon />Remove target
											</DropdownMenu.Item>
										</RowMenu>
									</div>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}

		{#snippet footer()}
			<span>
				Precedence: an organisation target, then the platform default, then the built-in object
				store. Credentials are sealed with the org key and never shown again.
			</span>
		{/snippet}
	</Panel>
</div>

{#if data.canEdit}
	<FormDialog
		bind:open={addOpen}
		icon={DatabaseBackupIcon}
		title="Add a backup target"
		description="Test it after adding: Skiff checks it can reach the location, then write, list and delete a probe object."
		action="?/add"
		submitLabel="Add target"
		size="lg"
	>
		<input type="hidden" name="kind" value={kind} />
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="target-name">Name</Field.Label>
					<Input
						id="target-name"
						name="name"
						placeholder="offsite-r2"
						required
						minlength={3}
						maxlength={40}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label>Kind</Field.Label>
					<ToggleGroup.Root
						type="single"
						variant="outline"
						value={kind}
						onValueChange={(value) => value && (kind = value as 'local' | 's3')}
						class="w-full"
						aria-label="Target kind"
					>
						<ToggleGroup.Item value="s3" class="flex-1"><CloudIcon />S3-compatible</ToggleGroup.Item
						>
						<ToggleGroup.Item value="local" class="flex-1"
							><FolderIcon />Local directory</ToggleGroup.Item
						>
					</ToggleGroup.Root>
				</Field.Field>
			</div>

			{#if kind === 'local'}
				<Field.Field>
					<Field.Label for="target-path">Directory</Field.Label>
					<Input
						id="target-path"
						name="path"
						required
						placeholder="/var/lib/skiff/backups"
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description>
						An absolute path on the control-plane host that the <code class="font-mono">skiff</code>
						user can write to. Prefer a separate disk or mount.
					</Field.Description>
				</Field.Field>
			{:else}
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field class="sm:col-span-2">
						<Field.Label for="target-endpoint">
							Endpoint <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<Input
							id="target-endpoint"
							name="endpoint"
							type="url"
							placeholder="https://<account>.r2.cloudflarestorage.com"
							spellcheck="false"
							class="font-mono text-sm"
						/>
						<Field.Description>Leave blank for AWS S3.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="target-bucket">Bucket</Field.Label>
						<Input
							id="target-bucket"
							name="bucket"
							required
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="target-region">
							Region <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<Input
							id="target-region"
							name="region"
							placeholder="us-east-1"
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field class="sm:col-span-2">
						<Field.Label for="target-prefix">
							Path prefix <span class="font-normal text-muted-foreground">optional</span>
						</Field.Label>
						<Input
							id="target-prefix"
							name="pathPrefix"
							placeholder="skiff/backups"
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="target-key">Access key ID</Field.Label>
						<Input
							id="target-key"
							name="accessKeyId"
							required
							autocomplete="off"
							spellcheck="false"
							class="font-mono text-sm"
						/>
					</Field.Field>
					<Field.Field>
						<Field.Label for="target-secret">Secret access key</Field.Label>
						<Input
							id="target-secret"
							name="secretAccessKey"
							type="password"
							required
							autocomplete="new-password"
							class="font-mono text-sm"
						/>
					</Field.Field>
				</div>
			{/if}

			<Field.Set>
				<Field.Legend variant="label">Options</Field.Legend>
				<Field.Group class="gap-3">
					<Field.Field orientation="horizontal">
						<Checkbox id="target-write-only" name="writeOnly" />
						<Field.Content>
							<Field.Label for="target-write-only">Write-only credentials</Field.Label>
							<Field.Description>
								The key can't delete, so the test expects delete to be denied and retention pruning
								needs a privileged key.
							</Field.Description>
						</Field.Content>
					</Field.Field>
					{#if kind === 's3'}
						<Field.Field orientation="horizontal">
							<Checkbox id="target-object-lock" name="objectLock" />
							<Field.Content>
								<Field.Label for="target-object-lock">Bucket uses object lock</Field.Label>
								<Field.Description
									>The bucket enforces S3 object lock on what Skiff writes.</Field.Description
								>
							</Field.Content>
						</Field.Field>
					{/if}
					{#if data.canPlatform}
						<Field.Field orientation="horizontal">
							<Checkbox id="target-platform" name="platform" />
							<Field.Content>
								<Field.Label for="target-platform">Platform default</Field.Label>
								<Field.Description>
									Used by every organisation that has no target of its own.
								</Field.Description>
							</Field.Content>
						</Field.Field>
					{/if}
				</Field.Group>
			</Field.Set>
		</Field.Group>
	</FormDialog>
{/if}
