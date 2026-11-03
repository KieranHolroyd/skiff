<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import Panel from '../_lib/Panel.svelte';
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
				<ServerIcon aria-hidden="true" />
				Nodes
			</Button>
		{/if}
		{#if data.can.createProject}
			<Button href={resolve('/(dashboard)/projects#new-project')}>
				<PlusIcon aria-hidden="true" />
				New project
			</Button>
		{/if}
	</PageHeader>

	<section
		class="grid gap-px overflow-hidden rounded-xl border bg-border shadow-card sm:grid-cols-2 xl:grid-cols-4"
		aria-label="Fleet summary"
	>
		{#each stats as stat (stat.label)}
			{@const Icon = stat.icon}
			<div class="space-y-3 bg-card p-5">
				<div class="flex items-center justify-between gap-2">
					<p class="eyebrow">{stat.label}</p>
					<Icon class="size-4 text-muted-foreground/70" aria-hidden="true" />
				</div>
				<p class="text-[30px] leading-none font-semibold tracking-[-0.035em] tabular-nums">
					{stat.value}<span class="text-lg font-normal text-muted-foreground">{stat.suffix}</span>
				</p>
				<p class="text-xs text-muted-foreground">{stat.caption}</p>
			</div>
		{/each}
	</section>

	<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
		<Panel
			title="Recent deployments"
			description="Across every project in {data.org.name}."
			flush
		>
			{#snippet actions()}
				<Button href={resolve('/(dashboard)/deployments')} variant="ghost" size="sm">
					View all
					<ArrowRightIcon aria-hidden="true" />
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
				<ul class="divide-y">
					{#each data.deployments as deployment (deployment.id)}
						<li class="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
							<StatusDot status={deployment.status} />
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
									<a
										href={resolve('/(dashboard)/projects/[slug]', {
											slug: deployment.projectSlug
										})}
										class="truncate font-medium underline-offset-4 hover:underline"
										>{deployment.projectSlug}</a
									>
									<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span>
									{#if deployment.isProduction}
										<Badge variant="brand">production</Badge>
									{/if}
								</div>
								<p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
									<span title={deployment.release.sha256}>{shortSha(deployment.release.sha256)}</span>
									<span class="mx-1 opacity-50">·</span>
									<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time>
								</p>
							</div>
							<StatusBadge status={deployment.status} class="hidden sm:inline-flex" />
							<Button
								href={deployment.previewUrl}
								target="_blank"
								rel="external noreferrer"
								variant="ghost"
								size="icon-sm"
								aria-label="Open preview for {deployment.projectSlug} {deployment.shortId}"
								title="Open preview"
							>
								<ArrowUpRightIcon aria-hidden="true" />
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		<Panel title="Nodes" description="Heartbeats arrive about every 10 seconds." flush>
			{#snippet actions()}
				{#if data.can.manageNodes}
					<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">
						Inspect
						<ArrowRightIcon aria-hidden="true" />
					</Button>
				{/if}
			{/snippet}
			{#if data.nodesDenied}
				<p class="px-4 py-6 text-sm text-muted-foreground">
					Node health is visible to platform admins. Ask an owner or admin if a node looks
					unavailable.
				</p>
			{:else if data.nodes.length === 0}
				<div class="p-4">
					<EmptyState
						icon={ServerIcon}
						compact
						title="No nodes yet"
						description={data.can.manageNodes
							? 'Create a join token and enrol the machine that will run the agent.'
							: 'A platform admin needs to enrol the first node.'}
					>
						{#if data.can.manageNodes}
							<Button href={resolve('/(dashboard)/nodes')} size="sm">Join a node</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.nodes as node (node.id)}
						<li class="space-y-3 px-4 py-3.5">
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0">
									<div class="flex items-center gap-2">
										<StatusDot status={node.status} />
										<p class="truncate text-sm font-medium">{node.name}</p>
										<Badge variant="outline" class="font-mono text-[10.5px] uppercase">{node.mode}</Badge>
									</div>
									<p class="mt-1 truncate pl-4 font-mono text-[11px] text-muted-foreground">
										{#if node.publicAddress}{node.publicAddress} · {/if}agent {node.agentVersion ??
											node.version ??
											'unknown'}
									</p>
								</div>
								<StatusBadge status={node.status} />
							</div>
							<div class="pl-4">
								<NodeStats stats={node.stats} />
								<p class="mt-2 text-[11px] text-muted-foreground">
									{#if node.lastHeartbeatAt}
										Last heartbeat <time datetime={node.lastHeartbeatAt}
											>{formatDateTime(node.lastHeartbeatAt)}</time
										>
									{:else}
										No heartbeat received yet
									{/if}
								</p>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	</div>

	<Panel title="Projects" description="Recently created sites in this organisation.">
		{#snippet actions()}
			<Button href={resolve('/(dashboard)/projects')} variant="ghost" size="sm">
				View all
				<ArrowRightIcon aria-hidden="true" />
			</Button>
		{/snippet}
		{#if data.projects.length === 0}
			<EmptyState
				icon={FolderKanbanIcon}
				title="No projects yet"
				description="Ask your agent to deploy a site, or create a project and deploy with the CLI."
			>
				{#if data.can.createProject}
					<Button href={resolve('/(dashboard)/projects#new-project')} size="sm"
						>Create a project</Button
					>
				{/if}
			</EmptyState>
		{:else}
			<ul class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
				{#each data.projects as project (project.slug)}
					<li>
						<a
							href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
							class="group flex items-center gap-3 rounded-lg border bg-card p-3 transition-all outline-none hover:border-foreground/15 hover:shadow-sm focus-visible:ring-3 focus-visible:ring-ring/40"
						>
							<ProjectMark slug={project.slug} name={project.name} />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">{project.name}</p>
								<p class="truncate font-mono text-[11px] text-muted-foreground">
									{project.slug}.{data.contentDomain}
								</p>
							</div>
							<ArrowRightIcon
								class="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
								aria-hidden="true"
							/>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
</div>
