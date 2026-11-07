<script lang="ts">
	/*
	 * "Needs attention" links are built by the server load (it knows which tab each problem lives
	 * on); the resolver rule cannot follow a string from data, so link checks are relaxed here.
	 */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true }] */
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import CylinderIcon from '@lucide/svelte/icons/cylinder';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import InfoIcon from '@lucide/svelte/icons/info';
	import MemoryStickIcon from '@lucide/svelte/icons/memory-stick';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ServerIcon from '@lucide/svelte/icons/server';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import StatusDot from '#lib/components/skiff/StatusDot.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import NodeStats from '../_lib/NodeStats.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import TrafficDashboard from '../_lib/TrafficDashboard.svelte';
	import StatStrip from '../_lib/service/StatStrip.svelte';
	import type { Stat } from '../_lib/service/sections.js';
	import { formatBytes, formatDuration, formatRelative, plural, shortSha } from '../_lib/format.js';
	import type { ResourceSummary } from './resources.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const can = $derived({
		createDatabase: data.permissions.includes('database:create'),
		createStorage: data.permissions.includes('storage:create')
	});

	// --- headline numbers ---------------------------------------------------------------------

	const online = $derived(
		data.status?.nodes.online ?? data.nodes.filter((node) => node.status === 'online').length
	);
	const totalNodes = $derived(data.status?.nodes.total ?? data.nodes.length);
	const activeDeployments = $derived(data.status?.deployments.active ?? 0);
	const reservedPct = $derived(
		data.capacity && data.capacity.sliceMemoryMb > 0
			? (data.capacity.reservedMemoryMb / data.capacity.sliceMemoryMb) * 100
			: null
	);

	const stats = $derived.by((): Stat[] => [
		{
			label: 'Projects',
			value: String(data.status?.projects ?? data.projectCount),
			icon: FolderKanbanIcon,
			caption:
				data.projectCount === 0
					? 'Nothing deployed yet'
					: `${data.liveProjects} live in production${data.domains && data.domains.total > 0 ? ` · ${data.domains.live} custom ${plural(data.domains.live, 'domain')}` : ''}`
		},
		{
			label: 'Active deployments',
			value: String(activeDeployments),
			icon: RocketIcon,
			caption:
				data.builds.active > 0
					? `${data.builds.active} ${plural(data.builds.active, 'build')} running now`
					: `${data.status?.deployments.total ?? 0} kept · ${formatBytes(data.status?.storageBytes)} of releases`
		},
		{
			label: 'Databases',
			value: data.databases ? String(data.databases.total) : '—',
			icon: DatabaseIcon,
			caption: !data.databases
				? 'Needs database access'
				: data.databases.total === 0
					? 'None created'
					: `${data.databases.running} running · ${formatBytes(data.databases.bytes)}`
		},
		{
			label: 'Object storage',
			value: data.storage ? String(data.storage.total) : '—',
			icon: CylinderIcon,
			caption: !data.storage
				? 'Needs storage access'
				: data.storage.total === 0
					? 'None created'
					: `${formatBytes(data.storage.bytes)} in ${data.storage.objects.toLocaleString('en-GB')} ${plural(data.storage.objects, 'object')}`
		},
		{
			label: 'Nodes online',
			value: data.nodesDenied && !data.status ? '—' : String(online),
			unit: data.nodesDenied && !data.status ? undefined : `/ ${totalNodes}`,
			icon: ServerIcon,
			meter: reservedPct,
			caption: data.capacity
				? `${data.capacity.reservedMemoryMb.toLocaleString('en-GB')} of ${data.capacity.sliceMemoryMb.toLocaleString('en-GB')} MB reserved by ${data.capacity.workloads} ${plural(data.capacity.workloads, 'workload')}`
				: data.nodesDenied
					? 'Detail visible to platform admins'
					: totalNodes === 0
						? 'No nodes enrolled yet'
						: `${totalNodes - online} offline`
		}
	]);

	// --- server resources ---------------------------------------------------------------------

	/*
	 * Heartbeats land every ~10 s; poll a small endpoint rather than re-running the whole load.
	 * Whichever of the polled and page-loaded summaries is newer wins, so a navigation or an
	 * invalidate never shows older figures than the poll already had.
	 */
	const RESOURCE_POLL_MS = 10_000;
	let polled = $state<ResourceSummary | null>(null);
	const resources = $derived(
		polled && data.resources && Date.parse(polled.at) > Date.parse(data.resources.at)
			? polled
			: data.resources
	);
	const resourcesEnabled = $derived(data.resources !== null);
	$effect(() => {
		if (!resourcesEnabled) return;
		let stopped = false;
		const tick = async () => {
			if (stopped || document.hidden) return;
			try {
				const response = await fetch(resolve('/(dashboard)/overview/resources'), {
					headers: { accept: 'application/json' }
				});
				if (response.status === 401 || response.status === 403) {
					stopped = true;
					return;
				}
				if (response.ok) polled = (await response.json()) as ResourceSummary;
			} catch {
				// A missed poll is harmless; the next one catches up.
			}
		};
		const timer = setInterval(() => void tick(), RESOURCE_POLL_MS);
		const onVisible = () => {
			if (!document.hidden) void tick();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			stopped = true;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	const liveNodeStats = $derived(
		new Map((resources?.nodes ?? []).map((node) => [node.id, node.stats]))
	);

	const pctOf = (used: number | null, size: number | null) =>
		used !== null && size ? (used / size) * 100 : null;

	const resourceStats = $derived.by((): Stat[] => {
		const fleet = resources?.fleet;
		if (!fleet || fleet.reporting === 0) return [];
		const many = fleet.reporting > 1;
		const memPct = pctOf(fleet.memoryUsedBytes, fleet.memoryTotalBytes);
		const diskPct = pctOf(fleet.diskUsedBytes, fleet.diskTotalBytes);
		const hot = (spot: { name: string; pct: number } | null) =>
			spot ? `busiest: ${spot.name} at ${spot.pct.toFixed(0)}%` : null;
		return [
			{
				label: many ? 'CPU (fleet)' : 'CPU',
				value: fleet.cpuPercent === null ? '—' : `${fleet.cpuPercent.toFixed(0)}%`,
				icon: CpuIcon,
				meter: fleet.cpuPercent,
				caption:
					hot(fleet.busiest.cpu) ??
					(fleet.cpus !== null
						? `${fleet.cpus} logical ${plural(fleet.cpus, 'CPU')}`
						: 'Share of all cores in use')
			},
			{
				label: 'Memory',
				value: formatBytes(fleet.memoryUsedBytes),
				unit: fleet.memoryTotalBytes ? `/ ${formatBytes(fleet.memoryTotalBytes)}` : undefined,
				icon: MemoryStickIcon,
				meter: memPct,
				caption:
					hot(fleet.busiest.memory) ??
					(memPct !== null && fleet.memoryTotalBytes !== null && fleet.memoryUsedBytes !== null
						? `${memPct.toFixed(0)}% used · ${formatBytes(fleet.memoryTotalBytes - fleet.memoryUsedBytes)} available`
						: 'Not reported')
			},
			{
				label: 'Disk',
				value: formatBytes(fleet.diskUsedBytes),
				unit: fleet.diskTotalBytes ? `/ ${formatBytes(fleet.diskTotalBytes)}` : undefined,
				icon: HardDriveIcon,
				meter: diskPct,
				caption:
					hot(fleet.busiest.disk) ??
					(diskPct !== null && fleet.diskTotalBytes !== null && fleet.diskUsedBytes !== null
						? `${formatBytes(fleet.diskTotalBytes - fleet.diskUsedBytes)} free on the data volume`
						: 'Not reported')
			},
			{
				label: 'Load (1 min)',
				value: fleet.load1 === null ? '—' : fleet.load1.toFixed(2),
				unit: fleet.cpus !== null ? `/ ${fleet.cpus} ${plural(fleet.cpus, 'CPU')}` : undefined,
				icon: GaugeIcon,
				meter: fleet.load1 !== null && fleet.cpus ? (fleet.load1 / fleet.cpus) * 100 : null,
				caption:
					fleet.uptimeSeconds === null
						? undefined
						: many
							? `Last restart ${formatDuration(fleet.uptimeSeconds)} ago`
							: `Up ${formatDuration(fleet.uptimeSeconds)}`
			}
		];
	});

	// --- needs attention ----------------------------------------------------------------------

	const ATTENTION_PREVIEW = 5;
	let showAllAttention = $state(false);
	const attentionShown = $derived(
		showAllAttention ? data.attention : data.attention.slice(0, ATTENTION_PREVIEW)
	);
	const problems = $derived(data.attention.filter((item) => item.tone !== 'info').length);
	const toneLook = {
		danger: { icon: CircleXIcon, class: 'text-destructive', label: 'Problem' },
		warning: { icon: TriangleAlertIcon, class: 'text-warning', label: 'Warning' },
		info: { icon: InfoIcon, class: 'text-info', label: 'Note' }
	} as const;

	const healthLine = $derived.by(() => {
		const parts: string[] = [];
		if (totalNodes > 0)
			parts.push(`${online} of ${totalNodes} ${plural(totalNodes, 'node')} online`);
		if (data.liveProjects > 0)
			parts.push(`${data.liveProjects} ${plural(data.liveProjects, 'site')} live`);
		if (data.databases && data.databases.total > 0)
			parts.push(`${data.databases.running} of ${data.databases.total} databases running`);
		return parts.join(' · ');
	});

	// --- lists --------------------------------------------------------------------------------

	const meterTone = (pct: number) =>
		pct >= 85
			? '[&_[data-slot=progress-indicator]]:bg-destructive'
			: pct >= 70
				? '[&_[data-slot=progress-indicator]]:bg-warning'
				: '';

	const newProjectHref = $derived(`${resolve('/(dashboard)/projects')}?new=1`);
</script>

<svelte:head>
	<title>Overview · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.overview"
		eyebrow={data.org.name}
		title="Overview"
		description="Everything served on {data.contentDomain}, and anything that needs you."
	>
		{#if data.can.createProject}
			<Button href={newProjectHref}>
				<PlusIcon />
				New project
			</Button>
		{/if}
	</PageHeader>

	<!-- Health first: problems, or a calm line saying there are none. -->
	{#if data.attention.length === 0}
		<div
			class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-success/25 bg-success/5 px-4 py-3 text-sm"
			role="status"
		>
			<CircleCheckIcon class="size-4 shrink-0 text-success" />
			<span class="font-medium">All clear</span>
			<span class="text-muted-foreground">
				{healthLine || 'Nothing has failed in the last 24 hours.'}
			</span>
		</div>
	{:else}
		<Panel
			title="Needs attention"
			icon={problems > 0 ? TriangleAlertIcon : InfoIcon}
			count={data.attention.length}
			description={problems > 0
				? 'Problems first. Each one links to where it is fixed.'
				: 'Nothing is broken; these are waiting on something.'}
			flush
		>
			<ul class="divide-y">
				{#each attentionShown as item (item.id)}
					{@const look = toneLook[item.tone]}
					<li>
						<a
							href={item.href}
							class="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
						>
							<look.icon class="mt-0.5 size-4 shrink-0 {look.class}" aria-label={look.label} />
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-medium">{item.title}</span>
								{#if item.detail}
									<span class="line-clamp-2 text-sm text-muted-foreground">{item.detail}</span>
								{/if}
							</span>
							<ChevronRightIcon
								class="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
							/>
						</a>
					</li>
				{/each}
			</ul>
			{#if data.attention.length > ATTENTION_PREVIEW}
				<div class="border-t px-4 py-2">
					<Button
						variant="link"
						size="sm"
						class="h-auto p-0 text-xs"
						onclick={() => (showAllAttention = !showAllAttention)}
					>
						{showAllAttention
							? 'Show fewer'
							: `Show ${data.attention.length - ATTENTION_PREVIEW} more`}
					</Button>
				</div>
			{/if}
		</Panel>
	{/if}

	<StatStrip label="Fleet summary" {stats} />

	{#if resources}
		<section aria-labelledby="server-resources" class="space-y-2">
			<div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
				<h2 id="server-resources" class="text-sm font-medium">Server resources</h2>
				<p class="text-xs text-muted-foreground">
					{#if resources.fleet.reporting > 0}
						{resources.fleet.reporting === resources.fleet.online
							? resources.fleet.reporting === 1
								? 'From the node heartbeat'
								: `Across ${resources.fleet.reporting} online nodes`
							: `${resources.fleet.reporting} of ${resources.fleet.online} online nodes reporting`}
						· refreshes every {RESOURCE_POLL_MS / 1000}s
					{/if}
				</p>
			</div>
			{#if resourceStats.length > 0}
				<StatStrip label="Server resources" stats={resourceStats} />
			{:else}
				<p class="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
					{resources.fleet.online === 0
						? 'No node is online, so there are no live CPU, memory or disk figures.'
						: 'No online node has reported CPU, memory or disk figures yet. Agents send them with each heartbeat.'}
				</p>
			{/if}
		</section>
	{/if}

	<TrafficDashboard
		traffic={data.traffic}
		range={data.trafficRange}
		ranges={data.trafficRanges}
		links={data.trafficLinks}
		projectNames={data.projectNames}
		variant="overview"
	/>

	<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
		<Panel
			title="Recent activity"
			icon={RocketIcon}
			description="Deployments, plus builds that are running or failed."
			flush
		>
			{#snippet actions()}
				<Button href={resolve('/(dashboard)/deployments')} variant="ghost" size="sm">
					All deployments
					<ArrowRightIcon />
				</Button>
			{/snippet}
			{#if data.activity.length === 0}
				<div class="p-4">
					<EmptyState
						icon={RocketIcon}
						title="No deployments yet"
						description="Deploy from the CLI, an MCP client or a connected git repository. Every deployment gets a permanent preview URL."
					>
						<Button href={resolve('/(dashboard)/projects')} size="sm">Open projects</Button>
					</EmptyState>
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.activity as item (item.kind + (item.kind === 'deployment' ? item.deployment.id : item.build.id))}
						<li class="flex items-start gap-3 px-4 py-3">
							{#if item.kind === 'deployment'}
								{@const deployment = item.deployment}
								<span
									class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									aria-hidden="true"
								>
									<RocketIcon class="size-4" />
								</span>
								<div class="min-w-0 flex-1">
									<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
										<a
											href={resolve('/(dashboard)/projects/[slug]', {
												slug: deployment.projectSlug
											})}
											class="font-medium underline-offset-4 hover:underline"
											>{deployment.projectSlug}</a
										>
										<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span
										>
										{#if deployment.isProduction}
											<Badge variant="brand">production</Badge>
										{:else}
											<Badge variant="outline" class="font-normal"
												>{deployment.environmentName}</Badge
											>
										{/if}
									</p>
									<p class="truncate text-xs text-muted-foreground">
										{deployment.message ?? `Release ${shortSha(deployment.release.sha256)}`}
									</p>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<StatusBadge status={deployment.status} />
									<time
										datetime={deployment.createdAt}
										class="hidden w-14 text-right text-xs text-muted-foreground tabular-nums sm:block"
										>{formatRelative(deployment.createdAt)}</time
									>
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
								</div>
							{:else}
								{@const build = item.build}
								<span
									class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									aria-hidden="true"
								>
									<HammerIcon class="size-4" />
								</span>
								<div class="min-w-0 flex-1">
									<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
										<a
											href="{resolve('/(dashboard)/projects/[slug]', {
												slug: build.projectSlug
											})}?tab=builds"
											class="font-medium underline-offset-4 hover:underline">{build.projectSlug}</a
										>
										<span class="text-muted-foreground">build of</span>
										<span class="font-mono text-xs">{build.ref}</span>
										{#if build.commitSha}
											<span class="font-mono text-xs text-muted-foreground"
												>{shortSha(build.commitSha, 7)}</span
											>
										{/if}
									</p>
									<p
										class="truncate text-xs {build.status === 'failed'
											? 'text-destructive'
											: 'text-muted-foreground'}"
									>
										{build.status === 'failed' && build.error
											? build.error
											: (build.commitMessage ?? 'No commit message')}
									</p>
								</div>
								<div class="flex shrink-0 items-center gap-2">
									<StatusBadge status={build.status} />
									<time
										datetime={build.createdAt}
										class="hidden w-14 text-right text-xs text-muted-foreground tabular-nums sm:block"
										>{formatRelative(build.createdAt)}</time
									>
									<span class="size-8" aria-hidden="true"></span>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		<Panel
			title="Nodes"
			icon={ServerIcon}
			count={data.nodesDenied ? undefined : data.nodes.length}
			description="Heartbeats arrive about every 10 seconds."
			flush
		>
			{#snippet actions()}
				{#if data.can.manageNodes}
					<Button href={resolve('/(dashboard)/nodes')} variant="ghost" size="sm">
						Manage
						<ArrowRightIcon />
					</Button>
				{/if}
			{/snippet}
			{#if data.nodesDenied}
				<p class="px-4 py-4 text-sm text-muted-foreground">
					Node health is visible to platform admins. Ask one if a site looks unavailable.
				</p>
			{:else if data.nodes.length === 0}
				<div class="p-4">
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
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.nodes as node (node.id)}
						<li class="space-y-3 px-4 py-3">
							<div class="flex items-center gap-2">
								<StatusDot status={node.status} />
								<span class="truncate text-sm font-medium">{node.name}</span>
								<Badge variant="secondary" class="capitalize">{node.mode}</Badge>
								<span class="ml-auto shrink-0 text-xs text-muted-foreground">
									{node.lastHeartbeatAt
										? `seen ${formatRelative(node.lastHeartbeatAt)}`
										: 'never seen'}
								</span>
							</div>
							<NodeStats stats={liveNodeStats.get(node.id) ?? node.stats} />
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	</div>

	<div class="grid items-start gap-5 lg:grid-cols-2">
		<Panel title="Projects" icon={FolderKanbanIcon} count={data.projectCount} flush>
			{#snippet actions()}
				<Button href={resolve('/(dashboard)/projects')} variant="ghost" size="sm">
					View all
					<ArrowRightIcon />
				</Button>
			{/snippet}
			{#if data.projects.length === 0}
				<div class="p-4">
					<EmptyState
						icon={FolderKanbanIcon}
						compact
						title="No projects yet"
						description="Ask your agent to deploy a site, or create a project and deploy with the CLI."
					>
						{#if data.can.createProject}
							<Button href={newProjectHref} size="sm"><PlusIcon />Create a project</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.projects as project (project.slug)}
						<li>
							<a
								href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
								class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
							>
								<ProjectMark slug={project.slug} name={project.name} />
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{project.name}</span>
									<span class="block truncate font-mono text-xs text-muted-foreground">
										{project.slug}.{data.contentDomain}
									</span>
								</span>
								<span class="hidden text-xs text-muted-foreground capitalize sm:inline"
									>{project.runtime}</span
								>
								{#if project.productionDeploymentId}
									<Badge variant="success">Live</Badge>
								{:else}
									<Badge variant="outline" class="font-normal">Not deployed</Badge>
								{/if}
								<ChevronRightIcon class="size-4 shrink-0 text-muted-foreground" />
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>

		<Panel
			title="Data services"
			icon={DatabaseIcon}
			count={data.dataServices.length}
			description="Managed databases and object storage."
			flush
		>
			{#snippet actions()}
				{#if data.databases}
					<Button href={resolve('/(dashboard)/databases')} variant="ghost" size="sm">
						Databases
						<ArrowRightIcon />
					</Button>
				{/if}
				{#if data.storage}
					<Button href={resolve('/(dashboard)/storage')} variant="ghost" size="sm">
						Storage
						<ArrowRightIcon />
					</Button>
				{/if}
			{/snippet}
			{#if !data.databases && !data.storage}
				<p class="px-4 py-4 text-sm text-muted-foreground">
					Databases and storage are visible with database or storage access.
				</p>
			{:else if data.dataServices.length === 0}
				<div class="p-4">
					<EmptyState
						icon={DatabaseIcon}
						compact
						title="No data services yet"
						description="Create a PostgreSQL database or S3-compatible storage, then attach it to an app from the project's Data tab."
					>
						{#if can.createDatabase}
							<Button href={resolve('/(dashboard)/databases')} size="sm">
								<PlusIcon />New database
							</Button>
						{/if}
						{#if can.createStorage}
							<Button href={resolve('/(dashboard)/storage')} size="sm" variant="outline">
								<PlusIcon />New storage
							</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<ul class="divide-y">
					{#each data.dataServices as service (service.kind + service.name)}
						{@const pct =
							service.usedBytes !== null && service.budgetBytes > 0
								? Math.min(100, (service.usedBytes / service.budgetBytes) * 100)
								: null}
						<li>
							<a
								href={service.kind === 'database'
									? resolve('/(dashboard)/databases/[name]', { name: service.name })
									: resolve('/(dashboard)/storage/[name]', { name: service.name })}
								class="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50"
							>
								<span
									class="relative flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
									aria-hidden="true"
								>
									{#if service.kind === 'database'}
										<DatabaseIcon class="size-4" />
									{:else}
										<CylinderIcon class="size-4" />
									{/if}
								</span>
								<span class="min-w-0 flex-1 space-y-1">
									<span class="flex items-center gap-2">
										<span class="truncate font-mono text-sm font-medium">{service.name}</span>
										<StatusDot status={service.status} />
									</span>
									<span class="block truncate text-xs text-muted-foreground">
										{service.label}{service.nodeName
											? ` · ${service.nodeName}`
											: ''}{#if service.note}
											·
											<span class={service.noteTone === 'danger' ? 'text-destructive' : ''}
												>{service.note}</span
											>{/if}
									</span>
								</span>
								<span class="hidden w-28 shrink-0 space-y-1 sm:block">
									<span class="block text-right text-xs text-muted-foreground tabular-nums">
										{service.usedBytes === null
											? formatBytes(service.budgetBytes)
											: `${formatBytes(service.usedBytes)} / ${formatBytes(service.budgetBytes)}`}
									</span>
									{#if pct !== null}
										<Progress
											value={pct}
											class="h-1 {meterTone(pct)}"
											aria-label="{service.name}: {pct.toFixed(0)}% of its storage"
										/>
									{/if}
								</span>
								<ChevronRightIcon class="size-4 shrink-0 text-muted-foreground" />
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	</div>
</div>
