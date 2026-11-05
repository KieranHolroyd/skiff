<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ServerIcon from '@lucide/svelte/icons/server';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Item from '#lib/components/ui/item/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import TrafficDashboard from '../_lib/TrafficDashboard.svelte';
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
	const slicePct = $derived(
		data.v2.capacity && data.v2.capacity.sliceMemoryMb > 0
			? (data.v2.capacity.reservedMemoryMb / data.v2.capacity.sliceMemoryMb) * 100
			: 0
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
		target="page.overview"
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
					<Card.Description class="text-xs font-medium text-muted-foreground"
						>{stat.label}</Card.Description
					>
					<Card.Title class="text-3xl leading-none font-semibold tracking-tight tabular-nums">
						{stat.value}<span class="text-lg font-normal text-muted-foreground">{stat.suffix}</span>
					</Card.Title>
					<Card.Action>
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
						>
							<stat.icon class="size-4" />
						</span>
					</Card.Action>
				</Card.Header>
				<Card.Footer class="text-xs text-muted-foreground">{stat.caption}</Card.Footer>
			</Card.Root>
		{/each}
	</section>

	<Panel
		title="Runtime & delivery"
		description="Workload slice, custom domains and git builds across the fleet."
		icon={LayersIcon}
	>
		{#snippet actions()}
			{#if data.can.manageNodes}
				<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">
					Nodes
					<ArrowRightIcon />
				</Button>
			{/if}
			<Button href={resolve('/(dashboard)/projects')} variant="ghost" size="sm">
				Projects
				<ArrowRightIcon />
			</Button>
		{/snippet}
		<div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
			<div class="space-y-2">
				<p class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<CpuIcon class="size-3.5 text-muted-foreground" />
					Workload slice
				</p>
				{#if data.v2.capacity}
					<p class="text-2xl font-semibold tracking-tight tabular-nums">
						{data.v2.capacity.reservedMemoryMb}<span
							class="text-sm font-normal text-muted-foreground"
						>
							/ {data.v2.capacity.sliceMemoryMb} MB</span
						>
					</p>
					<Progress
						value={Math.min(100, Math.max(0, slicePct))}
						aria-label="Reserved workload slice memory"
						class="h-1.5"
					/>
					<p class="text-xs text-muted-foreground">
						{data.v2.capacity.freeMemoryMb} MB free · {data.v2.capacity.nodes}
						{plural(data.v2.capacity.nodes, 'node')}
					</p>
				{:else}
					<p class="text-2xl font-semibold text-muted-foreground tabular-nums">—</p>
					<p class="text-xs text-muted-foreground">
						{data.can.viewCapacity
							? 'No workload slice reported yet.'
							: 'Visible to platform admins.'}
					</p>
				{/if}
			</div>

			<div class="space-y-2">
				<p class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<ServerIcon class="size-3.5 text-muted-foreground" />
					Workloads placed
				</p>
				{#if data.v2.capacity}
					<p class="text-2xl font-semibold tracking-tight tabular-nums">
						{data.v2.capacity.workloads}
					</p>
					<p class="text-xs text-muted-foreground">
						{data.v2.capacity.workloads === 0
							? 'No workloads placed.'
							: `Scheduled on ${data.v2.capacity.nodes} ${plural(data.v2.capacity.nodes, 'node')}.`}
					</p>
				{:else}
					<p class="text-2xl font-semibold text-muted-foreground tabular-nums">—</p>
					<p class="text-xs text-muted-foreground">
						{data.can.viewCapacity ? 'No workloads placed.' : 'Visible to platform admins.'}
					</p>
				{/if}
			</div>

			<div class="space-y-2">
				<p class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<GlobeIcon class="size-3.5 text-muted-foreground" />
					Custom domains
				</p>
				{#if data.v2.domains}
					<p class="text-2xl font-semibold tracking-tight tabular-nums">
						{data.v2.domains.verified}<span class="text-sm font-normal text-muted-foreground">
							/ {data.v2.domains.total}</span
						>
					</p>
					<p class="text-xs text-muted-foreground">
						{data.v2.domains.total === 0
							? 'No custom domains attached.'
							: 'Verified or active · org-wide'}
					</p>
				{:else}
					<p class="text-2xl font-semibold text-muted-foreground tabular-nums">—</p>
					<p class="text-xs text-muted-foreground">Visible with domain access.</p>
				{/if}
			</div>

			<div class="space-y-2">
				<p class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					<HammerIcon class="size-3.5 text-muted-foreground" />
					Active builds
				</p>
				{#if data.v2.builds.readable}
					<p class="text-2xl font-semibold tracking-tight tabular-nums">
						{data.v2.builds.active}
					</p>
					<p class="text-xs text-muted-foreground">
						{data.v2.builds.active === 0
							? 'Nothing queued or building.'
							: 'Queued or building across visible projects.'}
					</p>
				{:else}
					<p class="text-2xl font-semibold text-muted-foreground tabular-nums">—</p>
					<p class="text-xs text-muted-foreground">Visible with build access.</p>
				{/if}
			</div>
		</div>
	</Panel>

	<TrafficDashboard
		traffic={data.traffic}
		range={data.trafficRange}
		ranges={data.trafficRanges}
		links={data.trafficLinks}
		projectNames={data.projectNames}
		variant="overview"
	/>

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
										class="font-mono text-xs text-muted-foreground"
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
										<Badge variant="secondary" class="capitalize">{node.mode}</Badge>
									</Item.Title>
									<Item.Description class="font-mono text-xs">
										agent {node.agentVersion ?? node.version ?? 'unknown'}
									</Item.Description>
								</Item.Content>
								<Item.Actions><StatusBadge status={node.status} /></Item.Actions>
							</div>
							<NodeStats stats={node.stats} />
							<p class="text-xs text-muted-foreground">
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
									<Item.Description class="truncate font-mono text-xs">
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
