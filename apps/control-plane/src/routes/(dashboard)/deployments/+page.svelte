<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PinIcon from '@lucide/svelte/icons/pin';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortSha } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let status = $state('all');
	let environment = $state('');
	let query = $state('');
	let matched = $state(0);

	type Row = PageProps['data']['deployments'][number];
	const columns: DataColumn<Row>[] = [
		{
			id: 'deployment',
			header: 'Deployment',
			// Search covers the project, short id, environment and message; sorting uses the same text.
			value: (row) =>
				`${row.projectSlug} ${row.shortId} ${row.environmentName} ${row.message ?? ''}`,
			cell: deploymentCell,
			class: 'pl-4'
		},
		{
			id: 'preview',
			header: 'Preview',
			value: (row) => displayUrl(row.previewUrl),
			cell: previewCell,
			class: 'hidden md:table-cell'
		},
		{
			id: 'release',
			header: 'Release',
			value: (row) => row.release.sizeBytes,
			searchable: false,
			descFirst: true,
			cell: releaseCell,
			class: 'hidden font-mono text-xs text-muted-foreground lg:table-cell'
		},
		{
			id: 'created',
			header: 'Created',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'hidden text-xs text-muted-foreground sm:table-cell'
		},
		{
			id: 'status',
			header: 'Status',
			value: (row) => row.status,
			searchable: false,
			cell: statusCell,
			class: 'pr-4 text-right'
		}
	];

	const projectLabel = $derived(
		data.projects.find((project) => project.slug === data.filter)?.name ?? 'All projects'
	);
	// Only environments present in the current deployment set are offered, production first.
	const environmentChoices = $derived.by(() => {
		const seen: Record<string, { slug: string; name: string; isProduction: boolean }> = {};
		for (const deployment of data.deployments) {
			const existing = seen[deployment.environmentSlug];
			if (existing) existing.isProduction ||= deployment.isProduction;
			else
				seen[deployment.environmentSlug] = {
					slug: deployment.environmentSlug,
					name: deployment.environmentName,
					isProduction: deployment.isProduction
				};
		}
		return Object.values(seen).sort((a, b) =>
			a.isProduction === b.isProduction ? a.name.localeCompare(b.name) : a.isProduction ? -1 : 1
		);
	});
	const environmentLabel = $derived(
		environmentChoices.find((choice) => choice.slug === environment)?.name ?? 'All environments'
	);
	// A project change can remove the selected environment from the set; fall back to All.
	$effect(() => {
		if (environment && !environmentChoices.some((choice) => choice.slug === environment)) {
			environment = '';
		}
	});
	const visible = $derived(
		data.deployments.filter((deployment) => {
			if (environment && deployment.environmentSlug !== environment) return false;
			if (status === 'production') return deployment.isProduction;
			if (status === 'all') return true;
			return deployment.status === status;
		})
	);

	let filterForm = $state<HTMLFormElement>();
	let projectFilter = $derived(data.filter ?? '');

	async function chooseProject(slug: string) {
		projectFilter = slug;
		await tick();
		filterForm?.requestSubmit();
	}
</script>

<svelte:head>
	<title>Deployments · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.deployments"
		eyebrow="Operate"
		title="Deployments"
		description="Every deployment has an immutable preview URL. Only the production pointer moves on promote or rollback."
	/>

	{#if data.filterMissing}
		<Alert.Root variant="warning">
			<TriangleAlertIcon />
			<Alert.Description>
				No project matches <span class="font-mono">{data.filter}</span>. It may have been deleted or
				renamed.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex flex-wrap items-center gap-2">
			<form method="GET" bind:this={filterForm} class="contents">
				<input type="hidden" name="project" value={projectFilter} />
			</form>
			<Select.Root type="single" value={projectFilter} onValueChange={chooseProject}>
				<Select.Trigger class="w-56 bg-card" aria-label="Filter by project">
					<FolderKanbanIcon class="text-muted-foreground" />
					{projectLabel}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="All projects">All projects</Select.Item>
					<Select.Separator />
					{#each data.projects as project (project.slug)}
						<Select.Item value={project.slug} label={project.name}>
							{project.name}
							<span class="ml-auto font-mono text-xs text-muted-foreground">{project.slug}</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
			<ToggleGroup.Root
				type="single"
				variant="outline"
				size="sm"
				value={status}
				onValueChange={(value) => (status = value || 'all')}
				class="bg-card"
				aria-label="Filter by status"
			>
				<ToggleGroup.Item value="all" class="px-3">All</ToggleGroup.Item>
				<ToggleGroup.Item value="production" class="px-3">Production</ToggleGroup.Item>
				<ToggleGroup.Item value="active" class="px-3">Active</ToggleGroup.Item>
				<ToggleGroup.Item value="failed" class="px-3">Failed</ToggleGroup.Item>
			</ToggleGroup.Root>
			<Select.Root
				type="single"
				value={environment}
				onValueChange={(value) => (environment = value)}
			>
				<Select.Trigger class="w-48 bg-card" aria-label="Filter by environment">
					<LayersIcon class="text-muted-foreground" />
					{environmentLabel}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="" label="All environments">All environments</Select.Item>
					<Select.Separator />
					{#each environmentChoices as choice (choice.slug)}
						<Select.Item value={choice.slug} label={choice.name}>
							{choice.name}
							<span class="ml-auto font-mono text-xs text-muted-foreground">{choice.slug}</span>
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
		<div class="flex flex-wrap items-center gap-3">
			<InputGroup.Root class="w-64 bg-card">
				<InputGroup.Input
					placeholder="Search deployments"
					bind:value={query}
					aria-label="Search deployments"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{query.trim() ? matched : visible.length} of {data.deployments.length} recent deployments
			</p>
		</div>
	</div>

	{#if data.deployments.length === 0}
		<EmptyState
			icon={RocketIcon}
			title={data.filter ? 'No deployments for this project' : 'No deployments yet'}
			description={data.projects.length === 0
				? 'Create a project and deploy from the CLI or an MCP client. The first deploy creates a preview immediately.'
				: 'Deploy from the CLI with `skif deploy ./dist --project <slug>`, or ask your agent to deploy a site.'}
		>
			<Button href={resolve('/(dashboard)/projects')} size="sm">Open projects</Button>
		</EmptyState>
	{:else}
		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Deployments"
				rows={visible}
				{columns}
				rowId={(row) => row.id}
				search={query.trim()}
				sort={{ id: 'created', desc: true }}
				onmatch={(count) => (matched = count)}
			>
				{#snippet empty(search)}
					{search ? `No deployments match “${search}”.` : 'No deployments match this filter.'}
				{/snippet}
			</DataTable>
		</div>
	{/if}
</div>

{#snippet deploymentCell(deployment: Row)}
	<div class="flex flex-wrap items-center gap-1.5">
		<a
			href={resolve('/(dashboard)/projects/[slug]', { slug: deployment.projectSlug })}
			class="font-medium underline-offset-4 hover:underline">{deployment.projectSlug}</a
		>
		<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span>
		{#if deployment.isProduction}
			<Badge variant="brand">production</Badge>
		{:else}
			<Badge
				variant="outline"
				class="text-xs font-medium"
				title="Environment: {deployment.environmentSlug}">{deployment.environmentName}</Badge
			>
		{/if}
		{#if deployment.runtime !== 'static'}
			<span
				class="inline-flex items-center gap-1 text-xs text-muted-foreground"
				title="{deployment.runtime} runtime"
			>
				{#if deployment.runtime === 'container'}
					<BoxesIcon class="size-3" />
				{:else}
					<CpuIcon class="size-3" />
				{/if}
				<span class="capitalize">{deployment.runtime}</span>
			</span>
		{/if}
		{#if deployment.pinned}<Badge variant="outline"><PinIcon />pinned</Badge>{/if}
	</div>
	{#if deployment.message}
		<p class="max-w-md truncate text-xs text-muted-foreground" title={deployment.message}>
			{deployment.message}
		</p>
	{/if}
{/snippet}

{#snippet previewCell(deployment: Row)}
	<a
		href={deployment.previewUrl}
		target="_blank"
		rel="external noreferrer"
		class="inline-flex max-w-72 items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
	>
		<span class="truncate">{displayUrl(deployment.previewUrl)}</span>
		<ArrowUpRightIcon class="size-3 shrink-0" />
	</a>
{/snippet}

{#snippet releaseCell(deployment: Row)}
	<span title={deployment.release.sha256}>{shortSha(deployment.release.sha256)}</span>
	<span class="ml-1 text-xs opacity-75">{formatBytes(deployment.release.sizeBytes)}</span>
{/snippet}

{#snippet createdCell(deployment: Row)}
	<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time>
{/snippet}

{#snippet statusCell(deployment: Row)}
	<StatusBadge status={deployment.status} />
{/snippet}
