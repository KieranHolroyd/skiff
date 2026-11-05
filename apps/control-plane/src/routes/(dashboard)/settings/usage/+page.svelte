<script lang="ts">
	import { resolve } from '$app/paths';
	import ChartColumnIcon from '@lucide/svelte/icons/chart-column';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDate } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const cards = [
		'projects',
		'databases',
		'databaseStorageBytes',
		'storageInstances',
		'storageBytes',
		'storageObjects',
		'appVolumes',
		'appVolumeBytes',
		'jobs',
		'jobRunsPerDay',
		'buildsPerDay',
		'previews',
		'workloadMemoryMb',
		'egressBytes'
	] as const;

	function label(key: string): string {
		return key
			.replace(/([A-Z])/g, ' $1')
			.replace(/^./, (char) => char.toUpperCase())
			.replace('Per Day', '/day');
	}

	function value(used: number, unit: 'count' | 'bytes' | 'megabytes'): string {
		if (unit === 'bytes') return formatBytes(used);
		if (unit === 'megabytes') return `${used.toLocaleString('en-US')} MB`;
		return used.toLocaleString('en-US');
	}

	const exportHref = $derived(resolve('/(dashboard)/settings/usage/export'));
</script>

<svelte:head><title>Usage · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	{#if data.view.warnings.length > 0}
		<Alert.Root variant="destructive">
			<TriangleAlertIcon />
			<Alert.Title>Quota warning</Alert.Title>
			<Alert.Description>
				{#each data.view.warnings as warning (warning.metric)}
					<span class="mr-3 inline-block">
						{label(warning.metric)} at {warning.percent.toFixed(1)}%
					</span>
				{/each}
				New resources may be refused when a limit is reached.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
		{#each cards as key (key)}
			{@const metric = data.view.metrics[key]}
			<div class="rounded-lg border bg-card p-4">
				<div class="flex items-start justify-between gap-2">
					<p class="text-sm font-medium">{label(key)}</p>
					{#if metric.percent !== null}
						<Badge variant={metric.percent >= 95 ? 'destructive' : metric.percent >= 80 ? 'secondary' : 'outline'}>
							{metric.percent.toFixed(1)}%
						</Badge>
					{:else}
						<Badge variant="outline">unlimited</Badge>
					{/if}
				</div>
				<p class="mt-2 text-2xl font-semibold tabular-nums">{value(metric.used, metric.unit)}</p>
				<p class="text-xs text-muted-foreground">
					of {metric.limit < 0 ? 'unlimited' : value(metric.limit, metric.unit)}
				</p>
				<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						class="h-full rounded-full bg-brand"
						style={`width: ${Math.min(metric.percent ?? 0, 100)}%`}
					></div>
				</div>
			</div>
		{/each}
	</div>

	<Panel
		title="All metrics"
		icon={ChartColumnIcon}
		description="Actual sampled bytes for display; hard limits use the configured storage budget. Egress is a 30-day estimate."
		count={cards.length}
		flush
	>
		{#snippet actions()}
			<Button variant="outline" size="sm" href={exportHref}>
				<DownloadIcon />
				CSV
			</Button>
		{/snippet}
		<Table.Root>
			<Table.Header class="bg-muted/45">
				<Table.Row>
					<Table.Head class="pl-4">Metric</Table.Head>
					<Table.Head class="text-right">Used</Table.Head>
					<Table.Head class="text-right">Limit</Table.Head>
					<Table.Head class="pr-4 text-right">Used %</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each cards as key (key)}
					{@const metric = data.view.metrics[key]}
					<Table.Row>
						<Table.Cell class="pl-4 font-medium">{label(key)}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">{value(metric.used, metric.unit)}</Table.Cell>
						<Table.Cell class="text-right tabular-nums">
							{metric.limit < 0 ? 'unlimited' : value(metric.limit, metric.unit)}
						</Table.Cell>
						<Table.Cell class="pr-4 text-right tabular-nums">
							{metric.percent === null ? '—' : `${metric.percent.toFixed(1)}%`}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</Panel>

	<Panel
		title="30-day trend"
		icon={ChartColumnIcon}
		description="One snapshot per day, kept for showback. No billing is calculated from these numbers."
		count={data.history.points.length}
		flush
	>
		{#if data.history.points.length === 0}
			<div class="px-4 py-4">
				<EmptyState
					compact
					icon={ChartColumnIcon}
					title="No history yet"
					description="The first daily snapshot lands on the next maintenance sweep."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Day</Table.Head>
						<Table.Head class="text-right">Projects</Table.Head>
						<Table.Head class="text-right">Databases</Table.Head>
						<Table.Head class="text-right">Database bytes</Table.Head>
						<Table.Head class="pr-4 text-right">Egress (30d)</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.history.points as point (point.day)}
						<Table.Row>
							<Table.Cell class="pl-4">{formatDate(point.day)}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{point.metrics.projects.used}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">{point.metrics.databases.used}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{formatBytes(point.metrics.databaseStorageBytes.used)}
							</Table.Cell>
							<Table.Cell class="pr-4 text-right tabular-nums">
								{formatBytes(point.metrics.egressBytes.used)}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>
</div>
