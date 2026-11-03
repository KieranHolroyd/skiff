<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LinkIcon from '@lucide/svelte/icons/link-2';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RadioTowerIcon from '@lucide/svelte/icons/radio-tower';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import SecretDialog from '#lib/components/skiff/SecretDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import AccessChip from '../../_lib/AccessChip.svelte';
	import AccessSelect from '../../_lib/AccessSelect.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import ProjectMark from '../../_lib/ProjectMark.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortId, shortSha } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		success?: string;
		fieldErrors?: Record<string, string>;
		shareUrl?: string;
		shareHost?: string;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	type Deployment = (typeof data.deployments)[number];

	let tab = $state(page.url.searchParams.get('tab') ?? 'deployments');

	// Share-link dialog
	let shareOpen = $state(false);
	let shareDeploymentId = $state('');
	let expiresAtIso = $state('');
	let shareSecretOpen = $state(false);
	const nowLocal = $derived(
		new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
	);

	// Access dialog
	let accessOpen = $state(false);
	let accessScope = $state<'production' | 'previews'>('production');
	let accessMode = $state('public');

	$effect(() => {
		if (result?.shareUrl) shareSecretOpen = true;
	});

	const activeDeployments = $derived(data.deployments.filter((d) => d.status === 'active'));
	const production = $derived(
		data.deployments.find((d) => d.id === data.project.productionDeploymentId)
	);
	const activeShares = $derived(data.shareLinks.filter((link) => shareState(link) === 'active'));

	function shareState(link: {
		revokedAt: string | null;
		expiresAt: string | null;
		redemptions: number;
		maxRedemptions: number | null;
	}): string {
		if (link.revokedAt) return 'revoked';
		if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return 'expired';
		if (link.maxRedemptions !== null && link.redemptions >= link.maxRedemptions) return 'used up';
		return 'active';
	}

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	function openShare(deploymentId = '') {
		shareDeploymentId = deploymentId;
		expiresAtIso = '';
		shareOpen = true;
	}

	function openAccess(scope: 'production' | 'previews') {
		accessScope = scope;
		accessMode =
			scope === 'production' ? data.project.productionAccess : data.project.previewAccess;
		accessOpen = true;
	}

	function promote(deployment: Deployment) {
		askConfirm({
			title: `Promote ${deployment.shortId} to production?`,
			description: `${displayUrl(data.project.productionUrl)} will serve this deployment. Code and config move together; you can roll back at any time.`,
			confirmLabel: 'Promote',
			action: '?/promote',
			fields: { deploymentId: deployment.id }
		});
	}

	function rollback() {
		askConfirm({
			title: 'Roll back production?',
			description:
				'Production moves back to the previous deployment. Code and config both move; nothing is deleted.',
			confirmLabel: 'Roll back',
			action: '?/rollback'
		});
	}

	function deleteDeployment(deployment: Deployment) {
		askConfirm({
			title: `Delete deployment ${deployment.shortId}?`,
			description: 'Its preview URL stops working on the next reconcile. This cannot be undone.',
			confirmLabel: 'Delete deployment',
			tone: 'danger',
			action: '?/deleteDeployment',
			fields: { deploymentId: deployment.id }
		});
	}

	function revokeShare(id: string) {
		askConfirm({
			title: 'Revoke this share link?',
			description: 'Anyone using it loses access, including sessions it already started.',
			confirmLabel: 'Revoke link',
			tone: 'danger',
			action: '?/revokeShare',
			fields: { shareId: id }
		});
	}

	function deleteProject() {
		askConfirm({
			title: `Delete ${data.project.name}?`,
			description: `The project moves to the trash and is kept for 7 days. ${displayUrl(data.project.productionUrl)} and every preview stop serving.`,
			confirmLabel: 'Delete project',
			tone: 'danger',
			typeToConfirm: data.project.slug,
			action: `${resolve('/(dashboard)/projects')}?/delete`,
			fields: { slug: data.project.slug },
			apply: false,
			onResult: async (outcome) => {
				if (outcome.type === 'success') await goto(resolve('/(dashboard)/projects'));
			}
		});
	}
</script>

<svelte:head>
	<title>{data.project.name} · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Project" title={data.project.name}>
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2">
				<a
					href={data.project.productionUrl}
					target="_blank"
					rel="external noreferrer"
					class="inline-flex items-center gap-1 font-mono text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					{displayUrl(data.project.productionUrl)}
					<ArrowUpRightIcon class="size-3.5" />
				</a>
				<AccessChip scope="Prod" mode={data.project.productionAccess} />
				<AccessChip scope="Preview" mode={data.project.previewAccess} />
			</div>
		{/snippet}
		<Button href={data.project.productionUrl} target="_blank" rel="external noreferrer">
			<ArrowUpRightIcon />
			Visit site
		</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="icon" aria-label="More project actions">
						<EllipsisIcon />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-56">
				<DropdownMenu.Item onSelect={() => copy(data.project.productionUrl)}>
					<CopyIcon />Copy production URL
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={() => copy(data.project.id)}>
					<CopyIcon />Copy project ID
				</DropdownMenu.Item>
				{#if data.can.createShare}
					<DropdownMenu.Item onSelect={() => openShare()}>
						<LinkIcon />Create share link
					</DropdownMenu.Item>
				{/if}
				{#if data.can.update}
					<DropdownMenu.Item onSelect={() => openAccess('production')}>
						<KeyRoundIcon />Change access
					</DropdownMenu.Item>
				{/if}
				{#if data.can.deleteProject}
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={deleteProject}>
						<TrashIcon />Delete project
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</PageHeader>

	<Card.Root class="relative overflow-hidden py-0">
		<div class="absolute inset-y-0 left-0 w-1 bg-brand" aria-hidden="true"></div>
		<Card.Content class="flex flex-wrap items-center gap-x-5 gap-y-4 py-5 pl-7">
			<div class="hidden sm:block">
				<ProjectMark slug={data.project.slug} name={data.project.name} size="lg" />
			</div>
			<div class="min-w-0 flex-1 basis-64 space-y-1">
				<p class="eyebrow flex items-center gap-1.5 text-brand-soft-foreground">
					<RadioTowerIcon class="size-3" />
					Live in production
				</p>
				{#if production}
					<div class="flex flex-wrap items-center gap-2">
						<span class="font-mono text-lg font-semibold tracking-tight">{production.shortId}</span>
						<StatusBadge status={production.status} />
						{#if production.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
					</div>
					<p class="truncate text-[13px] text-muted-foreground">
						{#if production.message}{production.message} ·
						{/if}<span class="font-mono text-xs">{shortSha(production.release.sha256)}</span>
						· {formatBytes(production.release.sizeBytes)} · deployed
						<time datetime={production.createdAt}>{formatDateTime(production.createdAt)}</time>
					</p>
				{:else}
					<p class="text-lg font-semibold tracking-tight">Nothing in production yet</p>
					<p class="text-[13px] text-muted-foreground">
						Promote a deployment to serve it at {displayUrl(data.project.productionUrl)}.
					</p>
				{/if}
			</div>
			{#if data.can.rollback && data.project.productionDeploymentId}
				<Button variant="outline" onclick={rollback}>
					<RotateCcwIcon />
					Roll back
				</Button>
			{/if}
		</Card.Content>
	</Card.Root>

	<Tabs.Root bind:value={tab} class="gap-5">
		<Tabs.List variant="line" class="w-full justify-start border-b">
			<Tabs.Trigger value="deployments" class="flex-none">
				<RocketIcon />Deployments
				<Badge variant="neutral" class="h-4 px-1.5 font-mono text-[10px]"
					>{data.deployments.length}</Badge
				>
			</Tabs.Trigger>
			<Tabs.Trigger value="shares" class="flex-none">
				<LinkIcon />Share links
				<Badge variant="neutral" class="h-4 px-1.5 font-mono text-[10px]"
					>{activeShares.length}</Badge
				>
			</Tabs.Trigger>
			<Tabs.Trigger value="settings" class="flex-none"><KeyRoundIcon />Settings</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="deployments">
			{#if data.deployments.length === 0}
				<EmptyState
					icon={RocketIcon}
					title="No deployments yet"
					description="Deployments come from the CLI, MCP clients or the REST API. Every deploy gets an immutable preview URL."
				>
					<code class="rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs"
						><span class="text-muted-foreground select-none">$ </span>skif deploy ./dist --project {data
							.project.slug}</code
					>
				</EmptyState>
			{:else}
				<div class="overflow-hidden rounded-xl border bg-card shadow-card">
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-4">Deployment</Table.Head>
								<Table.Head class="hidden md:table-cell">Release</Table.Head>
								<Table.Head class="hidden lg:table-cell">Created</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.deployments as deployment (deployment.id)}
								<Table.Row
									class={deployment.isProduction ? 'bg-brand-soft/35 hover:bg-brand-soft/50' : ''}
								>
									<Table.Cell class="pl-4 whitespace-normal">
										<div class="flex flex-wrap items-center gap-1.5">
											<span class="font-mono text-[13px] font-medium">{deployment.shortId}</span>
											<StatusBadge status={deployment.status} />
											{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
											{#if deployment.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
										</div>
										<a
											href={deployment.previewUrl}
											target="_blank"
											rel="external noreferrer"
											class="mt-0.5 inline-flex max-w-full items-center gap-1 truncate font-mono text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
										>
											{displayUrl(deployment.previewUrl)}
											<ArrowUpRightIcon class="size-3 shrink-0" />
										</a>
										{#if deployment.message}
											<p
												class="max-w-xl truncate text-xs text-muted-foreground"
												title={deployment.message}
											>
												{deployment.message}
											</p>
										{/if}
									</Table.Cell>
									<Table.Cell class="hidden font-mono text-xs text-muted-foreground md:table-cell">
										<span title={deployment.release.sha256}
											>{shortSha(deployment.release.sha256)}</span
										>
										<p class="text-[11px] opacity-80">
											{formatBytes(deployment.release.sizeBytes)}
										</p>
									</Table.Cell>
									<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell">
										<time datetime={deployment.createdAt}
											>{formatDateTime(deployment.createdAt)}</time
										>
									</Table.Cell>
									<Table.Cell class="pr-4">
										<div class="flex items-center justify-end gap-1">
											{#if data.can.promote && !deployment.isProduction && deployment.status === 'active'}
												<Button variant="outline" size="sm" onclick={() => promote(deployment)}>
													<ArrowUpIcon />Promote
												</Button>
											{/if}
											<RowMenu label="Actions for {deployment.shortId}">
												<DropdownMenu.Item
													onSelect={() =>
														window.open(deployment.previewUrl, '_blank', 'noreferrer')}
												>
													<ArrowUpRightIcon />Open preview
												</DropdownMenu.Item>
												<DropdownMenu.Item onSelect={() => copy(deployment.previewUrl)}>
													<CopyIcon />Copy preview URL
												</DropdownMenu.Item>
												{#if data.can.createShare}
													<DropdownMenu.Item onSelect={() => openShare(deployment.id)}>
														<LinkIcon />Share this deployment
													</DropdownMenu.Item>
												{/if}
												{#if data.can.promote}
													<DropdownMenu.Item
														onSelect={() =>
															runAction('?/pin', {
																deploymentId: deployment.id,
																pinned: deployment.pinned ? 'false' : 'true'
															})}
													>
														{#if deployment.pinned}<PinOffIcon />Unpin{:else}<PinIcon />Pin (keep
															forever){/if}
													</DropdownMenu.Item>
												{/if}
												{#if data.can.deleteDeployment}
													<DropdownMenu.Separator />
													<DropdownMenu.Item
														variant="destructive"
														onSelect={() => deleteDeployment(deployment)}
													>
														<TrashIcon />Delete deployment
													</DropdownMenu.Item>
												{/if}
											</RowMenu>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
				<p class="mt-3 text-xs text-muted-foreground">
					{activeDeployments.length} active · the last 10 unpinned deployments are retained.
				</p>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="shares">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>Share links</Card.Title>
					<Card.Description>
						Time- and usage-limited access to protected sites. A visit is a redemption, not a page
						load.
					</Card.Description>
					{#if data.can.createShare}
						<Card.Action class="self-center">
							<Button onclick={() => openShare()}><PlusIcon />Create link</Button>
						</Card.Action>
					{/if}
				</Card.Header>
				<Card.Content class="px-0">
					{#if data.shareLinks.length === 0}
						<div class="p-4">
							<EmptyState
								icon={LinkIcon}
								compact
								title="No share links"
								description="Create a link when someone outside the org needs temporary access to a protected site."
							/>
						</div>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Link</Table.Head>
									<Table.Head class="hidden sm:table-cell">Redemptions</Table.Head>
									<Table.Head class="hidden md:table-cell">Expires</Table.Head>
									<Table.Head>Status</Table.Head>
									<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each data.shareLinks as link (link.id)}
									{@const state = shareState(link)}
									<Table.Row class={state === 'active' ? '' : 'text-muted-foreground'}>
										<Table.Cell class="pl-4">
											<p class="font-mono text-[13px]">{link.host}</p>
											{#if link.note}<p class="text-xs text-muted-foreground">{link.note}</p>{/if}
										</Table.Cell>
										<Table.Cell class="hidden font-mono text-xs tabular-nums sm:table-cell">
											{link.redemptions}{link.maxRedemptions !== null
												? ` / ${link.maxRedemptions}`
												: ''}
										</Table.Cell>
										<Table.Cell class="hidden text-xs md:table-cell">
											{#if link.expiresAt}
												<time datetime={link.expiresAt}>{formatDateTime(link.expiresAt)}</time>
											{:else}
												Never
											{/if}
										</Table.Cell>
										<Table.Cell><StatusBadge status={state} /></Table.Cell>
										<Table.Cell class="pr-4">
											{#if data.can.revokeShare && !link.revokedAt}
												<Button
													variant="ghost-danger"
													size="sm"
													onclick={() => revokeShare(link.id)}
												>
													Revoke
												</Button>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
				<Card.Footer class="py-3 text-xs text-muted-foreground">
					Sessions last one hour by default. Revocation reaches agents in seconds.
				</Card.Footer>
			</Card.Root>
		</Tabs.Content>

		<Tabs.Content value="settings" class="grid items-start gap-5 lg:grid-cols-2">
			<Card.Root>
				<Card.Header>
					<Card.Title>Access</Card.Title>
					<Card.Description>Production and previews are protected separately.</Card.Description>
				</Card.Header>
				<Card.Content>
					<Item.Group class="gap-2">
						{#each [{ scope: 'production', label: 'Production', mode: data.project.productionAccess, hint: displayUrl(data.project.productionUrl) }, { scope: 'previews', label: 'Previews', mode: data.project.previewAccess, hint: `${data.project.slug}--<id>.${data.contentDomain}` }] as row (row.scope)}
							<Item.Root variant="outline">
								<Item.Content>
									<Item.Title>{row.label}</Item.Title>
									<Item.Description class="font-mono text-[11px]">{row.hint}</Item.Description>
								</Item.Content>
								<Item.Actions>
									<AccessChip mode={row.mode} />
									{#if data.can.update}
										<Button
											variant="outline"
											size="sm"
											onclick={() => openAccess(row.scope as 'production' | 'previews')}
											>Change</Button
										>
									{/if}
								</Item.Actions>
							</Item.Root>
						{/each}
					</Item.Group>
				</Card.Content>
				<Card.Footer class="text-xs text-muted-foreground">
					Protected sites set <code class="mx-1 font-mono">X-Robots-Tag: noindex</code> and never receive
					platform session cookies.
				</Card.Footer>
			</Card.Root>

			<Card.Root>
				<Card.Header>
					<Card.Title>Details</Card.Title>
				</Card.Header>
				<Card.Content>
					<dl class="kv">
						<dt>Production</dt>
						<dd class="font-mono text-[13px]">{production?.shortId ?? 'not deployed'}</dd>
						<dt>Runtime</dt>
						<dd class="capitalize">{data.project.runtime}</dd>
						<dt>Placement</dt>
						<dd class="font-mono text-[13px]">{data.project.placement}</dd>
						<dt>Created</dt>
						<dd class="text-[13px]">
							<time datetime={data.project.createdAt}>{formatDateTime(data.project.createdAt)}</time
							>
						</dd>
						<dt>Project ID</dt>
						<dd class="flex items-center justify-end gap-1">
							<span class="truncate font-mono text-[12px]" title={data.project.id}
								>{shortId(data.project.id, 14)}</span
							>
							<CopyButton value={data.project.id} label="Copy project ID" iconOnly />
						</dd>
					</dl>
				</Card.Content>
			</Card.Root>

			{#if data.can.deleteProject}
				<Card.Root class="border-destructive/30 lg:col-span-2">
					<Card.Header>
						<Card.Title class="text-destructive">Danger zone</Card.Title>
						<Card.Description>
							Deleting moves the project to the trash for 7 days. Its production site and every
							preview stop serving immediately.
						</Card.Description>
						<Card.Action class="self-center">
							<Button variant="destructive" onclick={deleteProject}
								><TrashIcon />Delete project</Button
							>
						</Card.Action>
					</Card.Header>
				</Card.Root>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>

{#if data.can.createShare}
	<FormDialog
		bind:open={shareOpen}
		icon={LinkIcon}
		title="Create share link"
		description="Grant someone outside the org temporary access to a protected site."
		action="?/createShare"
		submitLabel="Create link"
	>
		<Field.Group>
			<Field.Field>
				<Field.Label for="share-deployment">Deployment</Field.Label>
				<NativeSelect.Root
					id="share-deployment"
					name="deploymentId"
					bind:value={shareDeploymentId}
					class="w-full"
				>
					<NativeSelect.Option value="">Production site</NativeSelect.Option>
					{#each data.deployments as deployment (deployment.id)}
						<NativeSelect.Option value={deployment.id}
							>{deployment.shortId}{deployment.isProduction
								? ' (production)'
								: ''}</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="share-expires">
						Expires <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="share-expires"
						name="expiresAtLocal"
						type="datetime-local"
						min={nowLocal}
						oninput={(event) => {
							const value = event.currentTarget.value;
							expiresAtIso = value ? new Date(value).toISOString() : '';
						}}
					/>
					<input type="hidden" name="expiresAt" value={expiresAtIso} />
				</Field.Field>
				<Field.Field>
					<Field.Label for="share-max">
						Max visits <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="share-max"
						name="maxRedemptions"
						type="number"
						min="1"
						step="1"
						placeholder="Unlimited"
					/>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="share-note"
					>Note <span class="font-normal text-muted-foreground">optional</span></Field.Label
				>
				<Input id="share-note" name="note" maxlength={500} placeholder="Design review with Alex" />
				<Field.Description
					>Only shown to your org, to remember who the link is for.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if result?.shareUrl}
	<SecretDialog
		bind:open={shareSecretOpen}
		title="Share link ready"
		description="Anyone with this link can open {result.shareHost} within the limits you set."
		value={result.shareUrl}
	/>
{/if}

{#if data.can.update}
	<FormDialog
		bind:open={accessOpen}
		icon={KeyRoundIcon}
		title="Change {accessScope === 'production' ? 'production' : 'preview'} access"
		description="Agents converge within seconds of saving."
		action="?/setAccess"
		submitLabel="Save access"
	>
		<input type="hidden" name="scope" value={accessScope} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="access-mode">Who can view</Field.Label>
				<AccessSelect id="access-mode" name="mode" bind:value={accessMode} />
			</Field.Field>
			{#if accessMode === 'password'}
				<Field.Field data-invalid={result?.fieldErrors?.password ? true : undefined}>
					<Field.Label for="access-password">Project password</Field.Label>
					<Input
						id="access-password"
						name="password"
						type="password"
						autocomplete="new-password"
						minlength={8}
						required
						aria-invalid={result?.fieldErrors?.password ? 'true' : undefined}
					/>
					<Field.Description
						>At least 8 characters. One secret for the whole project.</Field.Description
					>
					{#if result?.fieldErrors?.password}<Field.Error>{result.fieldErrors.password}</Field.Error
						>{/if}
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}
