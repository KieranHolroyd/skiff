<script lang="ts">
	import type { TrafficReport } from '@skiff/core';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChartNoAxesCombinedIcon from '@lucide/svelte/icons/chart-no-axes-combined';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from './EmptyState.svelte';
	import Panel from './Panel.svelte';
	import TelemetryOff from './TelemetryOff.svelte';
	import TrafficChart from './TrafficChart.svelte';
	import { formatBytes } from './format.js';

	interface ProjectRef {
		name: string;
		slug: string;
	}

	interface RangeOption {
		key: string;
		label: string;
		shortLabel: string;
	}

	let {
		traffic,
		range,
		ranges,
		links,
		projectNames = {},
		variant = 'project'
	}: {
		traffic: {
			permitted: boolean;
			available: boolean;
			report: TrafficReport;
			reason?: string;
			installed?: boolean;
		};
		range: {
			key: string;
			label: string;
			interval: '1m' | '1h';
			from: string;
			to: string;
			windowSeconds: number;
		};
		ranges: ReadonlyArray<RangeOption>;
		links: Record<string, string>;
		projectNames?: Record<string, ProjectRef>;
		variant?: 'project' | 'overview';
	} = $props();

	const numberFormat = new Intl.NumberFormat('en-GB');
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});

	const report = $derived(traffic.report);
	const totals = $derived(report.totals);
	const windowSeconds = $derived(Math.max(1, range.windowSeconds));
	const perSecond = $derived(totals.requests / windowSeconds);
	const bytesPerSecond = $derived(totals.bytes / windowSeconds);
	const lastReported = $derived(
		`${new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			timeZone: 'UTC'
		}).format(new Date(Date.parse(range.to) + 60_000))} UTC`
	);
	const errorRate = $derived(totals.requests > 0 ? (totals.status5xx / totals.requests) * 100 : 0);

	const statuses = $derived([
		{ label: '2xx', value: totals.status2xx, tone: 'bg-success' },
		{ label: '3xx', value: totals.status3xx, tone: 'bg-info' },
		{ label: '4xx', value: totals.status4xx, tone: 'bg-warning' },
		{ label: '5xx', value: totals.status5xx, tone: 'bg-destructive' }
	]);

	const kpis = $derived([
		{
			label: 'Requests',
			value: compactCount(totals.requests),
			caption: `${perSecond.toFixed(perSecond < 10 ? 2 : 0)}/s average`,
			icon: ChartNoAxesCombinedIcon,
			title: `${numberFormat.format(totals.requests)} requests`
		},
		{
			label: 'Bandwidth',
			value: formatBytes(totals.bytes),
			caption: `${formatBytes(bytesPerSecond)}/s average`,
			icon: HardDriveIcon,
			title: `${numberFormat.format(totals.bytes)} bytes served`
		},
		{
			label: 'Server errors',
			value: `${errorRate.toFixed(errorRate < 10 ? 2 : 1)}%`,
			caption: `${compactCount(totals.status5xx)} 5xx · ${compactCount(totals.status4xx)} 4xx`,
			icon: TriangleAlertIcon,
			title: `${numberFormat.format(totals.status5xx)} 5xx of ${numberFormat.format(totals.requests)} requests`
		},
		{
			label: 'p95 latency',
			value: `${Math.round(totals.durationP95Ms)} ms`,
			caption: `p50 ${Math.round(totals.durationP50Ms)} ms`,
			icon: TimerIcon,
			title: 'Request-weighted latency estimate'
		}
	]);

	const topProjects = $derived(report.projects.slice(0, 8));
	const topHosts = $derived(report.hosts.slice(0, 8));

	function compactCount(value: number): string {
		if (!Number.isFinite(value)) return '0';
		return value >= 10_000 ? compactFormat.format(value) : numberFormat.format(value);
	}

	function pct(value: number, total: number): number {
		return total > 0 ? (value / total) * 100 : 0;
	}

	function pctLabel(value: number, total: number): string {
		const share = pct(value, total);
		return `${share.toFixed(share > 0 && share < 1 ? 2 : share < 10 ? 1 : 0)}%`;
	}

	/** Referrers come from user-controlled headers; only ever link to web URLs. */
	function safeHref(value: string): string | null {
		try {
			const url = new URL(value);
			return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
		} catch {
			return null;
		}
	}
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-xs font-medium text-muted-foreground">Traffic · last {range.label}</p>
			<p class="text-sm text-muted-foreground">
				Aggregated from request buckets the edge agents report to ClickHouse.
			</p>
		</div>
		<div class="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
			{#each ranges as option (option.key)}
				<Button
					href={links[option.key]}
					variant={option.key === range.key ? 'secondary' : 'ghost'}
					size="sm"
					class="h-7 px-2.5 text-xs"
				>
					{option.shortLabel}
				</Button>
			{/each}
		</div>
	</div>

	{#if !traffic.permitted}
		<EmptyState
			icon={ChartNoAxesCombinedIcon}
			title="Traffic metrics are not visible"
			description="This account does not have the metrics:read permission, so request stats are hidden."
		/>
	{:else if !traffic.available}
		<TelemetryOff
			installed={traffic.installed}
			reason={traffic.reason}
			subject="Request history"
			unaffected="Sites and deploys are unaffected."
		/>
	{:else if totals.requests === 0}
		<EmptyState
			icon={ChartNoAxesCombinedIcon}
			title="No traffic in the last {range.label}"
			description="Once an agent serves a request it reports a minute bucket here. Preview and custom-domain hosts are included."
		/>
	{:else}
		<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Traffic summary">
			{#each kpis as kpi (kpi.label)}
				<Card.Root class="gap-3">
					<Card.Header>
						<Card.Description class="text-xs font-medium text-muted-foreground"
							>{kpi.label}</Card.Description
						>
						<Card.Title
							class="text-2xl leading-none font-semibold tracking-tight tabular-nums"
							title={kpi.title}
						>
							{kpi.value}
						</Card.Title>
						<Card.Action>
							<span
								class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
							>
								<kpi.icon class="size-4" />
							</span>
						</Card.Action>
					</Card.Header>
					<Card.Footer class="text-xs text-muted-foreground">{kpi.caption}</Card.Footer>
				</Card.Root>
			{/each}
		</section>

		<Panel
			title="Requests over time"
			description="Requests per {range.interval === '1m'
				? 'minute'
				: 'hour'} · {numberFormat.format(totals.requests)} total · up to {lastReported}"
			icon={ChartNoAxesCombinedIcon}
		>
			<TrafficChart series={report.series} interval={range.interval} />
		</Panel>

		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Panel title="Response status" description="Share of requests by status class.">
				<div class="space-y-4">
					<div class="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
						{#each statuses as status (status.label)}
							{#if status.value > 0}
								<div
									class={status.tone}
									style="width: {pct(status.value, totals.requests)}%"
									title="{status.label}: {status.value}"
								></div>
							{/if}
						{/each}
					</div>
					<div class="grid gap-2 sm:grid-cols-2">
						{#each statuses as status (status.label)}
							<div class="flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5">
								<span class="flex items-center gap-2 text-xs">
									<span class="size-2 rounded-[2px] {status.tone}"></span>
									{status.label}
								</span>
								<span class="font-mono text-xs tabular-nums">
									{compactCount(status.value)}
									<span class="text-muted-foreground"
										>{pctLabel(status.value, totals.requests)}</span
									>
								</span>
							</div>
						{/each}
					</div>
				</div>
			</Panel>

			{#if variant === 'overview'}
				<Panel
					title="Top projects"
					description="Requests per project across the fleet."
					count={topProjects.length}
					flush
				>
					{#if topProjects.length === 0}
						<p class="p-4 text-sm text-muted-foreground">No project traffic in this range.</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Project</Table.Head>
									<Table.Head class="text-right">Requests</Table.Head>
									<Table.Head class="text-right">5xx</Table.Head>
									<Table.Head class="w-0 pr-4"><span class="sr-only">Open</span></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each topProjects as row (row.key)}
									{@const project = projectNames[row.key]}
									<Table.Row>
										<Table.Cell class="pl-4">
											{#if project}
												<a
													href="/projects/{project.slug}?tab=traffic"
													class="font-medium underline-offset-4 hover:underline"
												>
													{project.name}
												</a>
												<p class="font-mono text-xs text-muted-foreground">{project.slug}</p>
											{:else}
												<span class="font-mono text-xs">{row.key}</span>
											{/if}
										</Table.Cell>
										<Table.Cell class="text-right font-mono text-xs tabular-nums">
											{compactCount(row.requests)}
										</Table.Cell>
										<Table.Cell class="text-right">
											{#if row.status5xx > 0}
												<Badge variant="danger">{compactCount(row.status5xx)}</Badge>
											{:else}
												<span class="text-xs text-muted-foreground">0</span>
											{/if}
										</Table.Cell>
										<Table.Cell class="pr-4 text-right">
											{#if project}
												<Button
													href="/projects/{project.slug}?tab=traffic"
													variant="ghost"
													size="icon-sm"
													aria-label="Open traffic for {project.name}"
												>
													<ArrowUpRightIcon />
												</Button>
											{/if}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Panel>
			{:else}
				<Panel
					title="Top paths"
					description="Busiest request paths in this project."
					count={report.topPaths.length}
					flush
				>
					{#if report.topPaths.length === 0}
						<p class="p-4 text-sm text-muted-foreground">No path data in this range.</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Path</Table.Head>
									<Table.Head class="text-right">Requests</Table.Head>
									<Table.Head class="w-16 pr-4 text-right">Share</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each report.topPaths as row (row.key)}
									<Table.Row>
										<Table.Cell class="max-w-0 pl-4">
											<span class="block truncate font-mono text-xs" title={row.key}>{row.key}</span
											>
										</Table.Cell>
										<Table.Cell class="text-right font-mono text-xs tabular-nums">
											{compactCount(row.count)}
										</Table.Cell>
										<Table.Cell class="pr-4 text-right text-xs text-muted-foreground tabular-nums">
											{pctLabel(row.count, totals.requests)}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Panel>
			{/if}
		</div>

		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Panel
				title="Hosts"
				description="Production, previews and custom domains."
				count={report.hosts.length}
				flush
			>
				{#if report.hosts.length === 0}
					<p class="p-4 text-sm text-muted-foreground">No hosts reported traffic.</p>
				{:else}
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head class="pl-4">Host</Table.Head>
								<Table.Head class="text-right">Requests</Table.Head>
								<Table.Head class="hidden text-right sm:table-cell">5xx</Table.Head>
								<Table.Head class="pr-4 text-right">p95</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each topHosts as host (host.key)}
								<Table.Row>
									<Table.Cell class="max-w-0 pl-4">
										<span class="flex items-center gap-1.5">
											<GlobeIcon class="size-3 shrink-0 text-muted-foreground" />
											<span class="truncate font-mono text-xs" title={host.key}>{host.key}</span>
										</span>
									</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums">
										{compactCount(host.requests)}
									</Table.Cell>
									<Table.Cell class="hidden text-right sm:table-cell">
										{#if host.status5xx > 0}
											<Badge variant="danger">{compactCount(host.status5xx)}</Badge>
										{:else}
											<span class="text-xs text-muted-foreground">0</span>
										{/if}
									</Table.Cell>
									<Table.Cell class="pr-4 text-right font-mono text-xs tabular-nums">
										{Math.round(host.durationP95Ms)} ms
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				{/if}
			</Panel>

			{#if variant === 'overview'}
				<Panel
					title="Top paths"
					description="Busiest request paths across all projects."
					count={report.topPaths.length}
					flush
				>
					{#if report.topPaths.length === 0}
						<p class="p-4 text-sm text-muted-foreground">No path data in this range.</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Path</Table.Head>
									<Table.Head class="text-right">Requests</Table.Head>
									<Table.Head class="w-16 pr-4 text-right">Share</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each report.topPaths as row (row.key)}
									<Table.Row>
										<Table.Cell class="max-w-0 pl-4">
											<span class="block truncate font-mono text-xs" title={row.key}>{row.key}</span
											>
										</Table.Cell>
										<Table.Cell class="text-right font-mono text-xs tabular-nums">
											{compactCount(row.count)}
										</Table.Cell>
										<Table.Cell class="pr-4 text-right text-xs text-muted-foreground tabular-nums">
											{pctLabel(row.count, totals.requests)}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Panel>
			{:else}
				<Panel
					title="Top referrers"
					description="Where visitors arrived from."
					count={report.topReferrers.length}
					flush
				>
					{#if report.topReferrers.length === 0}
						<p class="p-4 text-sm text-muted-foreground">No referrer data in this range.</p>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									<Table.Head class="pl-4">Referrer</Table.Head>
									<Table.Head class="pr-4 text-right">Requests</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each report.topReferrers as row (row.key)}
									{@const href = safeHref(row.key)}
									<Table.Row>
										<Table.Cell class="max-w-0 pl-4">
											{#if href}
												<a
													{href}
													target="_blank"
													rel="external noreferrer nofollow"
													class="block truncate font-mono text-xs underline-offset-4 hover:underline"
													title={row.key}
												>
													{row.key}
												</a>
											{:else}
												<span class="block truncate font-mono text-xs" title={row.key}
													>{row.key}</span
												>
											{/if}
										</Table.Cell>
										<Table.Cell class="pr-4 text-right font-mono text-xs tabular-nums">
											{compactCount(row.count)}
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Panel>
			{/if}
		</div>
	{/if}
</div>
