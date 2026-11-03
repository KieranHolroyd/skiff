<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ServerIcon from '@lucide/svelte/icons/server';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import { formatBytes, formatDateTime, plural, shortSha } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const online = $derived(
		data.status?.nodes.online ?? data.nodes.filter((node) => node.status === 'online').length
	);
	const totalNodes = $derived(data.status?.nodes.total ?? data.nodes.length);
	const activeDeployments = $derived(
		data.status?.deployments.active ?? data.deployments.filter((d) => d.status === 'active').length
	);

	const stats = $derived([
		{
			label: 'Projects',
			value: String(data.status?.projects ?? data.projectCount),
			suffix: '',
			caption: 'Soft-deleted projects excluded',
			icon: FolderKanbanIcon
		},
		{
			label: 'Active deployments',
			value: String(activeDeployments),
			suffix: '',
			caption: `${data.status?.deployments.total ?? 0} retained in total`,
			icon: RocketIcon
		},
		{
			label: 'Artifact storage',
			value: formatBytes(data.status?.storageBytes),
			suffix: '',
			caption: 'Unique, content-addressed releases',
			icon: HardDriveIcon
		},
		{
			label: 'Nodes online',
			value: String(online),
			suffix: ` / ${totalNodes}`,
			caption: data.nodesDenied
				? 'Visible to platform admins'
				: totalNodes === 0
					? 'No nodes enrolled yet'
					: `${data.nodes.length} ${plural(data.nodes.length, 'node')} reporting`,
			icon: ServerIcon
		}
	]);
</script>

<svelte:head>
	<title>Overview · Skiff</title>
</svelte:head>

<div class="space-y-8">
	<PageHeader
		eyebrow={data.org.name}
		title="Overview"
		description="Every project, deployment and node served on {data.contentDomain}."
	>
		{#if data.can.manageNodes}
			<Button href={resolve('/(dashboard)/nodes')} variant="outline">
				<ServerIcon />
				Nodes
			</Button>
		{/if}
		{#if data.can.createProject}
			<Button href="{resolve('/(dashboard)/projects')}?new=1">
				<PlusIcon />
				New project
			</Button>
		{/if}
	</PageHeader>

	<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fleet summary">
		{#each stats as stat (stat.label)}
			<Card.Root class="gap-3">
				<Card.Header>
					<Card.Description class="eyebrow">{stat.label}</Card.Description>
					<Card.Title
						class="text-[30px] leading-none font-semibold tracking-[-0.035em] tabular-nums"
					>
						{stat.value}<span class="text-lg font-normal text-muted-foreground">{stat.suffix}</span>
					</Card.Title>
					<Card.Action>
						<span
							class="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
						>
							<stat.icon class="size-4" />
						</span>
					</Card.Action>
				</Card.Header>
				<Card.Footer class="text-xs text-muted-foreground">{stat.caption}</Card.Footer>
			</Card.Root>
		{/each}
	</section>

	<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
		<Panel title="Recent deployments" description="Across every project in {data.org.name}." flush>
			{#snippet actions()}
				<Button href={resolve('/(dashboard)/deployments')} variant="ghost" size="sm">
					View all
					<ArrowRightIcon />
				</Button>
			{/snippet}
			{#if data.deployments.length === 0}
				<div class="p-4">
					<EmptyState
						icon={RocketIcon}
						title="No deployments yet"
						description="Deploy from the CLI or an MCP client. Every deployment gets a permanent preview URL."
					>
						<Button href={resolve('/(dashboard)/projects')} size="sm">Open projects</Button>
					</EmptyState>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Deployment</Table.Head>
							<Table.Head class="hidden sm:table-cell">Created</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Open</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each data.deployments as deployment (deployment.id)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-2">
										<a
											href={resolve('/(dashboard)/projects/[slug]', {
												slug: deployment.projectSlug
											})}
											class="font-medium underline-offset-4 hover:underline"
											>{deployment.projectSlug}</a
										>
										<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span
										>
										{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
									</div>
									<p
										class="font-mono text-[11px] text-muted-foreground"
										title={deployment.release.sha256}
									>
										{shortSha(deployment.release.sha256)}
									</p>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
									<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time
									>
								</Table.Cell>
								<Table.Cell><StatusBadge status={deployment.status} /></Table.Cell>
								<Table.Cell class="pr-4">
									<Button
										href={deployment.previewUrl}
										target="_blank"
										rel="external noreferrer"
										variant="ghost"
										size="icon-sm"
										aria-label="Open preview for {deployment.projectSlug} {deployment.shortId}"
									>
										<ArrowUpRightIcon />
									</Button>
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>

		<Panel title="Nodes" description="Heartbeats arrive about every 10 seconds.">
			{#snippet actions()}
				{#if data.can.manageNodes}
					<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">
						Inspect
						<ArrowRightIcon />
					</Button>
				{/if}
			{/snippet}
			{#if data.nodesDenied}
				<p class="text-sm text-muted-foreground">
					Node health is visible to platform admins. Ask an owner or admin if a node looks
					unavailable.
				</p>
			{:else if data.nodes.length === 0}
				<EmptyState
					icon={ServerIcon}
					compact
					title="No nodes yet"
					description={data.can.manageNodes
						? 'Add the machine that will run the agent.'
						: 'A platform admin needs to enrol the first node.'}
				>
					{#if data.can.manageNodes}
						<Button href={resolve('/(dashboard)/nodes')} size="sm">Add a node</Button>
					{/if}
				</EmptyState>
			{:else}
				<div class="space-y-3">
					{#each data.nodes as node (node.id)}
						<div class="space-y-3 rounded-lg border p-3">
							<div class="flex items-start gap-3">
								<Item.Media variant="icon" class="relative">
									<ServerIcon />
									<StatusDot status={node.status} class="absolute -top-1 -right-1" />
								</Item.Media>
								<Item.Content>
									<Item.Title>
										{node.name}
										<Badge variant="outline" class="font-mono text-[10px] uppercase"
											>{node.mode}</Badge
										>
									</Item.Title>
									<Item.Description class="font-mono text-[11px]">
										agent {node.agentVersion ?? node.version ?? 'unknown'}
									</Item.Description>
								</Item.Content>
								<Item.Actions><StatusBadge status={node.status} /></Item.Actions>
							</div>
							<NodeStats stats={node.stats} />
							<p class="text-[11px] text-muted-foreground">
								{#if node.lastHeartbeatAt}
									Last heartbeat <time datetime={node.lastHeartbeatAt}
										>{formatDateTime(node.lastHeartbeatAt)}</time
									>
								{:else}
									No heartbeat received yet
								{/if}
							</p>
						</div>
					{/each}
				</div>
			{/if}
		</Panel>
	</div>

	<Panel title="Projects" description="Recently created sites in this organisation.">
		{#snippet actions()}
			<Button href={resolve('/(dashboard)/projects')} variant="ghost" size="sm">
				View all
				<ArrowRightIcon />
			</Button>
		{/snippet}
		{#if data.projects.length === 0}
			<EmptyState
				icon={FolderKanbanIcon}
				title="No projects yet"
				description="Ask your agent to deploy a site, or create a project and deploy with the CLI."
			>
				{#if data.can.createProject}
					<Button href="{resolve('/(dashboard)/projects')}?new=1" size="sm">Create a project</Button
					>
				{/if}
			</EmptyState>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each data.projects as project (project.slug)}
					<Item.Root variant="outline" class="transition-colors hover:bg-muted/40">
						{#snippet child({ props })}
							<a href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })} {...props}>
								<Item.Media><ProjectMark slug={project.slug} name={project.name} /></Item.Media>
								<Item.Content class="min-w-0">
									<Item.Title class="w-full truncate">{project.name}</Item.Title>
									<Item.Description class="truncate font-mono text-[11px]">
										{project.slug}.{data.contentDomain}
									</Item.Description>
								</Item.Content>
								<Item.Actions><ArrowRightIcon class="size-4 text-muted-foreground" /></Item.Actions>
							</a>
						{/snippet}
					</Item.Root>
				{/each}
			</div>
		{/if}
	</Panel>
</div>
