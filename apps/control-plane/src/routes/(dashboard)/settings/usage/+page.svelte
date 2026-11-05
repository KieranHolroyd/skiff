<script lang="ts">
	import { resolve } from '$app/paths';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CalendarDaysIcon from '@lucide/svelte/icons/calendar-days';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import PackageIcon from '@lucide/svelte/icons/package';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import type { Component } from 'svelte';
	import type { QuotaField, QuotaUsageMetric, QuotaUsageMetricKey } from '@skiff/contracts';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDate, formatDateTime } from '../../_lib/format.js';
	import Sparkline from './Sparkline.svelte';
	import { inputValue, isUsageMetric, QUOTA_FIELDS, QUOTA_GROUPS } from './quota-fields.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const groupIcons: Record<string, Component<{ class?: string }>> = {
		apps: PackageIcon,
		compute: CpuIcon,
		databases: DatabaseIcon,
		storage: BoxesIcon,
		volumes: HardDriveIcon
	};

	let editing = $state(false);

	const metrics = $derived(data.view.metrics);
	const limits = $derived(data.quotas.base);
	const history = $derived(data.history.points);

	/** Format a metric or limit in the field's natural unit. */
	function show(field: QuotaField, value: number): string {
		if (field.endsWith('Bytes')) return formatBytes(value);
		if (field === 'workloadMemoryMb') return formatBytes(value * 1024 * 1024);
		return value.toLocaleString('en-GB');
	}

	function trend(field: QuotaUsageMetricKey) {
		return history.map((point) => ({ day: point.day, value: point.metrics[field].used }));
	}

	/** At the service's 80% warning line, amber; at the limit, red. */
	function tone(percent: number | null): 'ok' | 'warn' | 'over' {
		if (percent === null || percent < 80) return 'ok';
		return percent >= 100 ? 'over' : 'warn';
	}

	const meterTone = {
		ok: '',
		warn: '[&_[data-slot=progress-indicator]]:bg-warning',
		over: '[&_[data-slot=progress-indicator]]:bg-destructive'
	};

	const warnings = $derived([...data.view.warnings].sort((a, b) => b.percent - a.percent));
	const limitedCount = $derived(
		Object.values(metrics).filter((metric: QuotaUsageMetric) => metric.limit >= 0).length
	);

	const exportHref = $derived(resolve('/(dashboard)/settings/usage/export'));
	const newestFirst = $derived([...history].reverse());
</script>

<svelte:head><title>Usage · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div class="space-y-1">
			<h2 class="text-base font-semibold">Usage and limits</h2>
			<p class="max-w-2xl text-sm text-muted-foreground">
				What this organisation is using against its limits. Measured {formatDateTime(data.view.at)};
				{limitedCount === 0
					? 'no limits are set, so nothing is refused.'
					: `${limitedCount} of ${Object.keys(metrics).length} meters have a limit.`}
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" href={exportHref} download>
				<DownloadIcon />
				Export CSV
			</Button>
			{#if data.canSetQuotas}
				<Button size="sm" onclick={() => (editing = true)}>
					<SlidersHorizontalIcon />
					Edit limits
				</Button>
			{/if}
		</div>
	</div>

	{#if warnings.length > 0}
		<Notice
			tone={warnings.some((warning) => warning.percent >= 100) ? 'danger' : 'warning'}
			title={warnings.length === 1
				? `${QUOTA_FIELDS[warnings[0]!.metric].label} is close to its limit`
				: `${warnings.length} limits are nearly reached`}
		>
			<p>
				{#each warnings as warning, index (warning.metric)}
					<span class="font-medium">{QUOTA_FIELDS[warning.metric].label}</span>
					<span class="tabular-nums">{warning.percent.toFixed(0)}%</span>{index <
					warnings.length - 1
						? ', '
						: '. '}
				{/each}
				Requests that would go over a limit are refused{data.canSetQuotas
					? '; raise it under Edit limits.'
					: '; ask a platform admin to raise it.'}
			</p>
		</Notice>
	{/if}

	<div class="grid items-start gap-4 lg:grid-cols-2">
		{#each QUOTA_GROUPS as group (group.id)}
			<Panel title={group.title} icon={groupIcons[group.id]} flush>
				<ul class="divide-y">
					{#each group.fields as field (field)}
						{@const meta = QUOTA_FIELDS[field]}
						{#if isUsageMetric(field, metrics)}
							{@const metric = metrics[field]}
							{@const state = tone(metric.percent)}
							<li
								class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_7.5rem]"
							>
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{meta.label}</p>
									{#if meta.period || meta.hint}
										<p class="truncate text-xs text-muted-foreground">
											{[meta.period ? `In the ${meta.period}` : null, meta.hint]
												.filter(Boolean)
												.join(' · ')}
										</p>
									{/if}
								</div>
								<Sparkline
									class="hidden sm:block"
									points={trend(field)}
									format={(value) => show(field, value)}
									label="{meta.label}, last {history.length} days"
								/>
								<div class="text-right">
									<p class="text-sm tabular-nums">
										<span class="font-semibold">{show(field, metric.used)}</span>
										{#if metric.limit >= 0}
											<span class="text-muted-foreground">/ {show(field, metric.limit)}</span>
										{/if}
									</p>
									{#if metric.percent === null}
										<p class="text-xs text-muted-foreground">No limit</p>
									{:else}
										<p
											class="text-xs tabular-nums {state === 'over'
												? 'font-medium text-destructive'
												: state === 'warn'
													? 'font-medium text-warning'
													: 'text-muted-foreground'}"
										>
											{metric.percent.toFixed(metric.percent < 10 ? 1 : 0)}% used
										</p>
									{/if}
								</div>
								{#if metric.percent !== null}
									<Progress
										value={Math.min(100, metric.percent)}
										class="col-span-full h-1 {meterTone[state]}"
										aria-label="{meta.label}: {metric.percent.toFixed(0)}% of the limit"
									/>
								{/if}
							</li>
						{:else}
							<li class="flex items-center justify-between gap-4 px-4 py-3">
								<div class="min-w-0">
									<p class="truncate text-sm font-medium">{meta.label}</p>
									<p class="truncate text-xs text-muted-foreground">
										{meta.hint ?? 'A limit on each request, not a running total'}
									</p>
								</div>
								<p class="text-right text-sm tabular-nums">
									{#if limits[field] >= 0}
										<span class="font-semibold">{show(field, limits[field])}</span>
									{:else}
										<span class="text-muted-foreground">No limit</span>
									{/if}
								</p>
							</li>
						{/if}
					{/each}
				</ul>
			</Panel>
		{/each}
	</div>

	<Panel
		title="Daily snapshots"
		icon={CalendarDaysIcon}
		description="One reading a day for the last 30 days, kept for showback. Nothing is billed from these numbers."
		count={history.length}
		flush
	>
		{#if history.length === 0}
			<div class="p-4">
				<EmptyState
					compact
					icon={CalendarDaysIcon}
					title="No snapshots yet"
					description="The first one is taken on the next maintenance sweep; the trend lines above fill in from then."
				/>
			</div>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<Table.Root>
					<Table.Header class="sticky top-0 bg-muted/80 backdrop-blur">
						<Table.Row>
							<Table.Head class="pl-4">Day</Table.Head>
							<Table.Head class="text-right">Projects</Table.Head>
							<Table.Head class="text-right">Builds</Table.Head>
							<Table.Head class="text-right">Memory</Table.Head>
							<Table.Head class="text-right">Databases</Table.Head>
							<Table.Head class="text-right">Storage</Table.Head>
							<Table.Head class="pr-4 text-right">Egress (30d)</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each newestFirst as point (point.day)}
							<Table.Row>
								<Table.Cell class="pl-4">{formatDate(point.day)}</Table.Cell>
								<Table.Cell class="text-right tabular-nums">
									{point.metrics.projects.used}
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">
									{point.metrics.buildsPerDay.used}
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">
									{show('workloadMemoryMb', point.metrics.workloadMemoryMb.used)}
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">
									{point.metrics.databases.used}
									<span class="text-muted-foreground">
										· {formatBytes(point.metrics.databaseStorageBytes.used)}
									</span>
								</Table.Cell>
								<Table.Cell class="text-right tabular-nums">
									{formatBytes(point.metrics.storageBytes.used)}
								</Table.Cell>
								<Table.Cell class="pr-4 text-right tabular-nums">
									{formatBytes(point.metrics.egressBytes.used)}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</div>
		{/if}
		{#snippet footer()}
			Export CSV downloads the current reading of every metric, with its limit.
		{/snippet}
	</Panel>
</div>

{#if data.canSetQuotas}
	<FormDialog
		bind:open={editing}
		title="Edit limits"
		description="Limits for this organisation. Leave a field blank for no limit. Projects can override these through the API."
		icon={SlidersHorizontalIcon}
		action="?/quotas"
		submitLabel="Save limits"
		size="lg"
	>
		<div class="-mx-6 max-h-[60vh] space-y-6 overflow-y-auto px-6">
			{#each QUOTA_GROUPS as group (group.id)}
				<Field.Set>
					<Field.Legend variant="label">{group.title}</Field.Legend>
					<div class="grid gap-x-4 gap-y-3 sm:grid-cols-2">
						{#each group.fields as field (field)}
							{@const meta = QUOTA_FIELDS[field]}
							<Field.Field>
								<Field.Label for="quota-{field}">
									{meta.label}
									{#if meta.period}<span class="font-normal text-muted-foreground"
											>/ {meta.period.replace('last ', '')}</span
										>{/if}
								</Field.Label>
								<InputGroup.Root>
									<InputGroup.Input
										id="quota-{field}"
										name={field}
										type="number"
										min="0"
										step={meta.inputUnit ? 'any' : '1'}
										inputmode="decimal"
										placeholder="No limit"
										value={inputValue(field, limits[field])}
									/>
									{#if meta.inputUnit}
										<InputGroup.Addon align="inline-end">
											<InputGroup.Text>{meta.inputUnit}</InputGroup.Text>
										</InputGroup.Addon>
									{:else if field === 'workloadMemoryMb'}
										<InputGroup.Addon align="inline-end">
											<InputGroup.Text>MB</InputGroup.Text>
										</InputGroup.Addon>
									{/if}
								</InputGroup.Root>
							</Field.Field>
						{/each}
					</div>
				</Field.Set>
			{/each}
		</div>
	</FormDialog>
{/if}
