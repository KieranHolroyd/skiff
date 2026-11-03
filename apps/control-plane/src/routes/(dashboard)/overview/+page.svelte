<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
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

	function nodeTone(status: string): string {
		switch (status) {
			case 'online':
				return 'bg-emerald-500';
			case 'draining':
				return 'bg-amber-500';
			case 'offline':
				return 'bg-muted-foreground/50';
			default:
				return 'bg-sky-500';
		}
	}

	function nodeBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		switch (status) {
			case 'online':
				return 'default';
			case 'offline':
				return 'destructive';
			case 'draining':
				return 'secondary';
			default:
				return 'outline';
		}
	}

	function deploymentTone(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'active') return 'default';
		if (status === 'failed') return 'destructive';
		if (status === 'pending') return 'secondary';
		return 'outline';
	}
</script>

<svelte:head>
	<title>Overview · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Fleet overview"
		description="One control plane for every project, deployment and node on {data.contentDomain}."
	>
		{#if data.can.createProject}
			<Button href={resolve('/(dashboard)/projects#new-project')} size="sm">New project</Button>
		{/if}
		{#if data.can.manageNodes}
			<Button href={resolve('/(dashboard)/nodes')} variant="outline" size="sm">Manage nodes</Button>
		{/if}
	</PageHeader>

	<section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Fleet summary">
		<Card.Root size="sm">
			<Card.Content class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Projects</p>
					<p class="text-2xl font-semibold tabular-nums">
						{data.status?.projects ?? data.projectCount}
					</p>
					<p class="text-xs text-muted-foreground">Soft-deleted projects excluded</p>
				</div>
				<span
					class="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
				>
					<FolderKanbanIcon class="size-4" aria-hidden="true" />
				</span>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Content class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
						Active deployments
					</p>
					<p class="text-2xl font-semibold tabular-nums">{activeDeployments}</p>
					<p class="text-xs text-muted-foreground">
						{data.status?.deployments.total ?? 0} deployments retained
					</p>
				</div>
				<span
					class="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
				>
					<RocketIcon class="size-4" aria-hidden="true" />
				</span>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Content class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Storage</p>
					<p class="text-2xl font-semibold tabular-nums">
						{formatBytes(data.status?.storageBytes)}
					</p>
					<p class="text-xs text-muted-foreground">Unique release artifacts</p>
				</div>
				<span
					class="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
				>
					<HardDriveIcon class="size-4" aria-hidden="true" />
				</span>
			</Card.Content>
		</Card.Root>

		<Card.Root size="sm">
			<Card.Content class="flex items-start justify-between gap-3">
				<div class="space-y-1">
					<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
						Nodes online
					</p>
					<p class="text-2xl font-semibold tabular-nums">
						{online}<span class="text-base font-normal text-muted-foreground"> / {totalNodes}</span>
					</p>
					<p class="text-xs text-muted-foreground">
						{#if data.nodesDenied}
							Visible to platform admins
						{:else if totalNodes === 0}
							No nodes enrolled yet
						{:else}
							{plural(data.nodes.length, 'node')} reporting
						{/if}
					</p>
				</div>
				<span
					class="grid size-8 place-items-center rounded-lg border bg-muted/40 text-muted-foreground"
				>
					<ServerIcon class="size-4" aria-hidden="true" />
				</span>
			</Card.Content>
		</Card.Root>
	</section>

	<div class="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
		<Card.Root>
			<Card.Header class="flex-row items-center justify-between gap-3 border-b pb-4">
				<div class="space-y-1">
					<Card.Title>Recent deployments</Card.Title>
					<Card.Description>Across every project in {data.org.name}.</Card.Description>
				</div>
				<Button href={resolve('/(dashboard)/deployments')} variant="ghost" size="sm">
					All deployments
					<ArrowRightIcon class="size-3.5" aria-hidden="true" />
				</Button>
			</Card.Header>
			<Card.Content class="p-0">
				{#if data.deployments.length === 0}
					<div class="p-4">
						<EmptyState
							title="No deployments yet"
							description="Deploy from the CLI or an MCP client. Every deployment gets a permanent preview URL."
						>
							<Button href={resolve('/(dashboard)/projects')} size="sm">Open projects</Button>
						</EmptyState>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<caption class="sr-only">Recent deployments</caption>
							<thead>
								<tr class="border-b text-left text-xs text-muted-foreground">
									<th class="px-4 py-2.5 font-medium">Project</th>
									<th class="px-4 py-2.5 font-medium">Commit</th>
									<th class="hidden px-4 py-2.5 font-medium sm:table-cell">Created</th>
									<th class="px-4 py-2.5 text-right font-medium">Status</th>
								</tr>
							</thead>
							<tbody>
								{#each data.deployments as deployment (deployment.id)}
									<tr class="border-b last:border-0 hover:bg-muted/35">
										<td class="px-4 py-3">
											<a
												href={resolve('/(dashboard)/projects/[slug]', {
													slug: deployment.projectSlug
												})}
												class="font-medium underline-offset-4 hover:underline"
												>{deployment.projectSlug}</a
											>
											<div class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
												<span class="font-mono">{deployment.shortId}</span>
												{#if deployment.isProduction}
													<Badge variant="outline" class="h-4 px-1.5 text-[10px]">production</Badge>
												{/if}
											</div>
										</td>
										<td
											class="px-4 py-3 font-mono text-xs text-muted-foreground"
											title={deployment.release.sha256}
										>
											{shortSha(deployment.release.sha256)}
										</td>
										<td
											class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
										>
											<time datetime={deployment.createdAt}
												>{formatDateTime(deployment.createdAt)}</time
											>
										</td>
										<td class="px-4 py-3 text-right">
											<div class="flex items-center justify-end gap-2">
												<Badge variant={deploymentTone(deployment.status)}
													>{deployment.status}</Badge
												>
												<a
													href={deployment.previewUrl}
													target="_blank"
													rel="external noreferrer"
													class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
													aria-label="Open preview for {deployment.projectSlug} {deployment.shortId}"
												>
													<ExternalLinkIcon class="size-3.5" aria-hidden="true" />
												</a>
											</div>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<Card.Root>
			<Card.Header class="flex-row items-center justify-between gap-3 border-b pb-4">
				<div class="space-y-1">
					<Card.Title>Nodes</Card.Title>
					<Card.Description>Heartbeats arrive about every 10 seconds.</Card.Description>
				</div>
				{#if data.can.manageNodes}
					<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">Inspect</Button>
				{/if}
			</Card.Header>
			<Card.Content class="p-0">
				{#if data.nodesDenied}
					<div class="px-4 py-6 text-sm text-muted-foreground">
						Node health is visible to platform admins. Ask an owner or admin if a node looks
						unavailable.
					</div>
				{:else if data.nodes.length === 0}
					<div class="p-4">
						<EmptyState
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
							<li class="px-4 py-3">
								<div class="flex items-start justify-between gap-3">
									<div class="min-w-0">
										<div class="flex items-center gap-2">
											<span
												class="size-1.5 shrink-0 rounded-full {nodeTone(node.status)}"
												aria-hidden="true"
											></span>
											<p class="truncate text-sm font-medium">{node.name}</p>
											<Badge variant="outline" class="capitalize">{node.mode}</Badge>
										</div>
										<p class="mt-1 truncate text-xs text-muted-foreground">
											{#if node.publicAddress}
												<span class="font-mono">{node.publicAddress}</span> ·
											{/if}
											agent {node.agentVersion ?? node.version ?? 'unknown'}
										</p>
									</div>
									<Badge variant={nodeBadgeVariant(node.status)}>{node.status}</Badge>
								</div>
								<p class="mt-2 text-xs text-muted-foreground">
									{#if node.lastHeartbeatAt}
										Last heartbeat <time datetime={node.lastHeartbeatAt}
											>{formatDateTime(node.lastHeartbeatAt)}</time
										>
									{:else}
										No heartbeat received yet
									{/if}
								</p>
								{#if node.stats}
									<details class="mt-2">
										<summary
											class="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
											>Reported stats</summary
										>
										<pre
											class="mt-1 max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed">{JSON.stringify(
												node.stats,
												null,
												2
											)}</pre>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>

	<Card.Root size="sm">
		<Card.Header class="flex-row items-center justify-between gap-3">
			<div class="space-y-1">
				<Card.Title>Projects</Card.Title>
				<Card.Description>Recently created sites in this organisation.</Card.Description>
			</div>
			<Button href={resolve('/(dashboard)/projects')} variant="ghost" size="sm">View all</Button>
		</Card.Header>
		<Card.Content>
			{#if data.projects.length === 0}
				<EmptyState
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
				<ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
					{#each data.projects as project (project.slug)}
						<li>
							<a
								href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
								class="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/40"
							>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{project.name}</p>
									<p class="truncate font-mono text-xs text-muted-foreground">
										{project.slug}.{data.contentDomain}
									</p>
								</div>
								<ArrowRightIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
