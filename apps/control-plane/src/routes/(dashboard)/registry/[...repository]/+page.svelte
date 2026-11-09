<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import PackageIcon from '@lucide/svelte/icons/package';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PinIcon from '@lucide/svelte/icons/pin';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import TagIcon from '@lucide/svelte/icons/tag';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import type { RegistryTagView } from '@yoal/contracts';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import { formatBytes, formatDateTime, formatRelative } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const repo = $derived(data.repository);
	const host = $derived(data.registry.host);
	const pullRef = (reference: string) =>
		reference.startsWith('sha256:')
			? `${host}/${repo.name}@${reference}`
			: `${host}/${repo.name}:${reference}`;

	/** Deployments per digest, so a tag row shows where its image runs. */
	const pinsByDigest = $derived(
		data.pins.reduce<Record<string, typeof data.pins>>((acc, pin) => {
			(acc[pin.digest] ??= []).push(pin);
			return acc;
		}, {})
	);
	const liveDigests = $derived(
		new Set(
			data.pins.filter((pin) => pin.status === 'active' || pin.production).map((pin) => pin.digest)
		)
	);

	let autoOpen = $state(false);
	let deployOpen = $state(false);
	let deployTag = $state<string>('');

	function openDeploy(tag: string) {
		deployTag = tag;
		deployOpen = true;
	}

	function untag(tag: RegistryTagView) {
		const pinned = tag.digest ? (pinsByDigest[tag.digest]?.length ?? 0) : 0;
		askConfirm({
			title: `Delete ${repo.name}:${tag.tag}?`,
			description:
				pinned > 0
					? `The tag goes; its image stays because ${pinned} ${pinned === 1 ? 'deployment pins' : 'deployments pin'} it. Running containers are not affected.`
					: 'The tag goes; its image stays while another tag points at it, then retention removes it. Running containers are not affected.',
			confirmLabel: 'Delete tag',
			tone: 'danger',
			action: '?/untag',
			fields: { tag: tag.tag }
		});
	}

	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success('Copied.');
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}

	// ---- CVE scan of one tag
	interface ScanResult {
		image: string;
		summary: {
			MaxSeverity?: string;
			Count?: number;
			CriticalCount?: number;
			HighCount?: number;
			MediumCount?: number;
			LowCount?: number;
		} | null;
		cves: { Id: string; Severity: string; Title: string }[];
	}
	let scanOpen = $state(false);
	let scanTag = $state('');
	let scan = $state<ScanResult | null>(null);
	let scanState = $state<'idle' | 'loading' | 'error'>('idle');
	let scanError = $state('');

	async function openScan(tag: string) {
		scanTag = tag;
		scan = null;
		scanError = '';
		scanState = 'loading';
		scanOpen = true;
		try {
			const response = await fetch(
				`/api/v1/registry/scan?repository=${encodeURIComponent(repo.name)}&reference=${encodeURIComponent(tag)}`,
				{ headers: { accept: 'application/json' } }
			);
			const body = (await response.json().catch(() => null)) as
				(ScanResult & { message?: string }) | null;
			if (!response.ok || !body)
				throw new Error(body?.message ?? `Request failed (${response.status}).`);
			scan = body;
			scanState = 'idle';
		} catch (cause) {
			scanError = (cause as Error).message;
			scanState = 'error';
		}
	}

	const severityTone = (severity: string | undefined) =>
		severity === 'CRITICAL' || severity === 'HIGH'
			? ('danger' as const)
			: severity === 'MEDIUM'
				? ('warning' as const)
				: ('neutral' as const);
</script>

<svelte:head><title>{repo.name} · Registry · Yoal</title></svelte:head>

<div class="space-y-6">
	<div>
		<Button
			variant="ghost"
			size="sm"
			href={resolve('/(dashboard)/registry')}
			class="-ml-2 text-muted-foreground"
		>
			<ArrowLeftIcon />Registry
		</Button>
	</div>

	<PageHeader title={repo.name} description="Repository in {host}.">
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2">
				<code class="rounded-md bg-muted px-2 py-1 font-mono text-xs"
					>docker pull {pullRef(repo.lastTag ?? 'latest')}</code
				>
				<CopyButton
					value="docker pull {pullRef(repo.lastTag ?? 'latest')}"
					label="Copy pull command"
					iconOnly
					size="icon-sm"
					variant="ghost"
				/>
			</div>
		{/snippet}
		{#if data.canDeploy && data.tags.length > 0}
			<Button onclick={() => openDeploy(repo.lastTag ?? data.tags[0]!.tag)}
				><RocketIcon />Deploy</Button
			>
		{/if}
	</PageHeader>

	<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
		<div class="min-w-0 space-y-6">
			<Panel title="Tags" icon={TagIcon} count={data.tags.length} flush>
				{#if data.tagsError}
					<p class="p-4 text-sm text-destructive">Could not read the tags: {data.tagsError}</p>
				{:else if data.tags.length === 0}
					<div class="p-4">
						<EmptyState
							icon={TagIcon}
							compact
							title="No tags"
							description="Push {host}/{repo.name}:<tag> to add one. Deployed digests stay even without a tag."
						/>
					</div>
				{:else}
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-4">Tag</Table.Head>
								<Table.Head>Digest</Table.Head>
								<Table.Head class="hidden md:table-cell">Deployed to</Table.Head>
								<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.tags as tag (tag.tag)}
								{@const pins = tag.digest ? (pinsByDigest[tag.digest] ?? []) : []}
								<Table.Row>
									<Table.Cell class="pl-4">
										<div class="flex items-center gap-2">
											<span class="font-mono text-sm font-medium">{tag.tag}</span>
											{#if tag.tag === repo.lastTag}
												<Badge variant="secondary" class="font-normal">latest push</Badge>
											{/if}
											{#if tag.digest && liveDigests.has(tag.digest)}
												<Badge variant="success" class="font-normal">running</Badge>
											{/if}
										</div>
									</Table.Cell>
									<Table.Cell
										class="font-mono text-xs text-muted-foreground"
										title={tag.digest ?? undefined}
									>
										{tag.digest ? `${tag.digest.slice(0, 19)}…` : '—'}
									</Table.Cell>
									<Table.Cell class="hidden md:table-cell">
										{#if pins.length === 0}
											<span class="text-xs text-muted-foreground">—</span>
										{:else}
											<div class="flex flex-wrap gap-1">
												{#each [...new Set(pins.map((pin) => pin.projectSlug ?? '?'))] as slug (slug)}
													<Badge variant="outline" class="font-mono font-normal">{slug}</Badge>
												{/each}
											</div>
										{/if}
									</Table.Cell>
									<Table.Cell class="pr-4">
										<div class="flex justify-end">
											<RowMenu label="Actions for {tag.tag}">
												{#if data.canDeploy}
													<DropdownMenu.Item onSelect={() => openDeploy(tag.tag)}>
														<RocketIcon />Deploy to a project…
													</DropdownMenu.Item>
												{/if}
												<DropdownMenu.Item onSelect={() => copy(pullRef(tag.tag))}>
													<CopyIcon />Copy image reference
												</DropdownMenu.Item>
												{#if tag.digest}
													{@const digest = tag.digest}
													<DropdownMenu.Item onSelect={() => copy(pullRef(digest))}>
														<PinIcon />Copy pinned reference
													</DropdownMenu.Item>
												{/if}
												{#if data.registry.cveScanning}
													<DropdownMenu.Item onSelect={() => openScan(tag.tag)}>
														<ScanSearchIcon />Scan for vulnerabilities
													</DropdownMenu.Item>
												{/if}
												{#if data.canDeleteTags}
													<DropdownMenu.Separator />
													<DropdownMenu.Item variant="destructive" onSelect={() => untag(tag)}>
														<TrashIcon />Delete tag
													</DropdownMenu.Item>
												{/if}
											</RowMenu>
										</div>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
				{#snippet footer()}
					<span>
						Retention keeps the newest {data.registry.keepTags} tags, plus every digest a deployment pins.
					</span>
				{/snippet}
			</Panel>

			<Panel
				title="Deployments using this image"
				icon={PinIcon}
				count={data.pins.length}
				description="Each deployment pins the digest it ran, so a rollback can always pull it."
				flush
			>
				{#if data.pins.length === 0}
					<div class="p-4">
						<EmptyState
							icon={PinIcon}
							compact
							title="Not deployed yet"
							description="Deploy a tag to a container project, or turn on deploy on push."
						/>
					</div>
				{:else}
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-4">Deployment</Table.Head>
								<Table.Head>Status</Table.Head>
								<Table.Head class="hidden md:table-cell">Digest</Table.Head>
								<Table.Head class="pr-4 text-right">Created</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each data.pins.slice(0, 50) as pin (pin.deploymentId)}
								<Table.Row>
									<Table.Cell class="pl-4">
										{#if pin.projectSlug}
											<a
												href={resolve('/(dashboard)/projects/[slug]/deployments/[id]', {
													slug: pin.projectSlug,
													id: pin.deploymentId
												})}
												class="font-mono text-sm underline-offset-4 hover:underline"
											>
												{pin.projectSlug}
												<span class="text-muted-foreground">· {pin.shortId}</span>
											</a>
										{:else}
											<span class="font-mono text-sm text-muted-foreground">{pin.shortId}</span>
										{/if}
									</Table.Cell>
									<Table.Cell>
										<div class="flex flex-wrap items-center gap-1">
											<StatusBadge status={pin.status} />
											{#if pin.production}<Badge variant="info" class="font-normal"
													>production</Badge
												>{/if}
										</div>
									</Table.Cell>
									<Table.Cell
										class="hidden font-mono text-xs text-muted-foreground md:table-cell"
										title={pin.digest}
									>
										{pin.digest.slice(7, 19)}
									</Table.Cell>
									<Table.Cell class="pr-4 text-right text-xs text-muted-foreground">
										{formatRelative(pin.createdAt)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Panel>
		</div>

		<div class="space-y-6">
			<Panel title="Details" icon={PackageIcon}>
				<DetailList>
					<dt>Size</dt>
					<dd class="font-mono text-xs">
						{repo.bytes > 0 ? formatBytes(repo.bytes) : 'not sampled yet'}
					</dd>
					<dt>Pushes</dt>
					<dd class="font-mono text-xs">{repo.pushes}</dd>
					<dt>Last push</dt>
					<dd class="text-xs">
						{#if repo.lastPushAt}
							<span class="font-mono">{repo.lastTag}</span>
							<span class="text-muted-foreground">· {formatDateTime(repo.lastPushAt)}</span>
						{:else}
							—
						{/if}
					</dd>
					<dt>Project</dt>
					<dd class="font-mono text-xs">
						{#if repo.projectSlug}
							<a
								href={resolve('/(dashboard)/projects/[slug]', { slug: repo.projectSlug })}
								class="underline-offset-4 hover:underline"
							>
								{repo.projectSlug}
							</a>
						{:else}
							—
						{/if}
					</dd>
					<dt>Created</dt>
					<dd class="text-xs">{formatDateTime(repo.createdAt)}</dd>
				</DetailList>
			</Panel>

			<Panel title="Deploy on push" icon={RocketIcon}>
				{#snippet actions()}
					{#if data.canAutoDeploy}
						<Button size="sm" variant="outline" onclick={() => (autoOpen = true)}>
							<PencilIcon />{repo.deploy?.project ? 'Change' : 'Set up'}
						</Button>
					{/if}
				{/snippet}
				{#if repo.deploy?.project}
					<p class="text-sm">
						Every push of <span class="font-mono">:{repo.deploy.tag}</span> deploys to
						<a
							href={resolve('/(dashboard)/projects/[slug]', { slug: repo.deploy.project })}
							class="font-mono underline-offset-4 hover:underline">{repo.deploy.project}</a
						>, pinned to the pushed digest.
					</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						Off. Link a tag to a container project and each push of it deploys there.
					</p>
				{/if}
			</Panel>
		</div>
	</div>
</div>

{#if data.canDeploy}
	<FormDialog
		bind:open={deployOpen}
		icon={RocketIcon}
		title="Deploy {repo.name}:{deployTag}"
		description="Sets the container project's image and deploys it, pinned to the tag's current digest. The rest of its settings are kept."
		action="?/deploy"
		submitLabel="Deploy"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="deploy-tag">Tag</Field.Label>
					<NativeSelect.Root id="deploy-tag" name="tag" bind:value={deployTag}>
						{#each data.tags as tag (tag.tag)}
							<NativeSelect.Option value={tag.tag}>{tag.tag}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="deploy-project">Project</Field.Label>
					<NativeSelect.Root
						id="deploy-project"
						name="project"
						value={repo.deploy?.project ?? repo.projectSlug ?? ''}
						required
					>
						<NativeSelect.Option value="">Choose a project</NativeSelect.Option>
						{#each data.containerProjects as project (project.slug)}
							<NativeSelect.Option value={project.slug}
								>{project.name} ({project.slug})</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
					{#if data.containerProjects.length === 0}
						<Field.Description>No container projects yet.</Field.Description>
					{/if}
				</Field.Field>
			</div>
			<Field.Field orientation="horizontal">
				<Checkbox id="deploy-promote" name="promote" checked={true} />
				<Field.Content>
					<Field.Label for="deploy-promote">Promote to production</Field.Label>
					<Field.Description>Off: the deployment gets a preview URL only.</Field.Description>
				</Field.Content>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.canAutoDeploy}
	<FormDialog
		bind:open={autoOpen}
		icon={RocketIcon}
		title="Deploy {repo.name} on push"
		description="Every push of the tag deploys to the container project, pinned to the pushed digest."
		action="?/autodeploy"
		submitLabel="Save"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="auto-project">Project</Field.Label>
					<NativeSelect.Root
						id="auto-project"
						name="project"
						value={repo.deploy?.project ?? ''}
						required
					>
						<NativeSelect.Option value="">Choose a project</NativeSelect.Option>
						{#each data.containerProjects as project (project.slug)}
							<NativeSelect.Option value={project.slug}
								>{project.name} ({project.slug})</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
					{#if data.containerProjects.length === 0}
						<Field.Description>No container projects yet.</Field.Description>
					{/if}
				</Field.Field>
				<Field.Field>
					<Field.Label for="auto-tag">Tag</Field.Label>
					<Input
						id="auto-tag"
						name="tag"
						value={repo.deploy?.tag ?? 'latest'}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
					/>
				</Field.Field>
			</div>
		</Field.Group>
		{#if repo.deploy?.project}
			<Button
				type="submit"
				name="off"
				value="1"
				variant="outline"
				formnovalidate
				class="justify-self-start"
			>
				Turn off
			</Button>
		{/if}
	</FormDialog>
{/if}

<Dialog.Root bind:open={scanOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ScanSearchIcon class="size-4 text-muted-foreground" />Vulnerabilities in {repo.name}:{scanTag}
			</Dialog.Title>
			<Dialog.Description>From the registry's Trivy scan, most severe first.</Dialog.Description>
		</Dialog.Header>
		{#if scanState === 'loading'}
			<p class="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Scanning…</p>
		{:else if scanState === 'error'}
			<p class="text-sm text-destructive">{scanError}</p>
		{:else if scan}
			{#if !scan.summary}
				<p class="text-sm text-muted-foreground">
					No scan result yet. Trivy may still be downloading its database.
				</p>
			{:else}
				<div class="flex flex-wrap items-center gap-2 text-sm">
					<StatusBadge
						status={scan.summary.MaxSeverity ?? 'none'}
						label="max {(scan.summary.MaxSeverity ?? 'none').toLowerCase()}"
						tone={severityTone(scan.summary.MaxSeverity)}
					/>
					<span class="text-muted-foreground tabular-nums">
						{scan.summary.Count ?? 0} total · {scan.summary.CriticalCount ?? 0} critical · {scan
							.summary.HighCount ?? 0}
						high · {scan.summary.MediumCount ?? 0} medium · {scan.summary.LowCount ?? 0} low
					</span>
				</div>
			{/if}
			{#if scan.cves.length > 0}
				<ul class="max-h-80 divide-y overflow-y-auto rounded-md border">
					{#each scan.cves.slice(0, 50) as cve (cve.Id)}
						<li class="flex items-start gap-3 px-3 py-2">
							<StatusBadge
								status={cve.Severity}
								label={cve.Severity.toLowerCase()}
								tone={severityTone(cve.Severity)}
							/>
							<div class="min-w-0">
								<p class="font-mono text-xs">{cve.Id}</p>
								<p class="truncate text-xs text-muted-foreground" title={cve.Title}>{cve.Title}</p>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
