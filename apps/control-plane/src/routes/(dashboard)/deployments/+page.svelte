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
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Select from '#lib/components/ui/select/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortSha } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let status = $state('all');
	let environment = $state('');

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
		<p class="text-sm text-muted-foreground">
			{visible.length} of {data.deployments.length} recent deployments
		</p>
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
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Deployment</Table.Head>
						<Table.Head class="hidden md:table-cell">Preview</Table.Head>
						<Table.Head class="hidden lg:table-cell">Release</Table.Head>
						<Table.Head class="hidden sm:table-cell">Created</Table.Head>
						<Table.Head class="pr-4 text-right">Status</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each visible as deployment (deployment.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<div class="flex flex-wrap items-center gap-1.5">
									<a
										href={resolve('/(dashboard)/projects/[slug]', { slug: deployment.projectSlug })}
										class="font-medium underline-offset-4 hover:underline"
										>{deployment.projectSlug}</a
									>
									<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span>
									{#if deployment.isProduction}
										<Badge variant="brand">production</Badge>
									{:else}
										<Badge
											variant="outline"
											class="text-xs font-medium"
											title="Environment: {deployment.environmentSlug}"
											>{deployment.environmentName}</Badge
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
									<p
										class="max-w-md truncate text-xs text-muted-foreground"
										title={deployment.message}
									>
										{deployment.message}
									</p>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								<a
									href={deployment.previewUrl}
									target="_blank"
									rel="external noreferrer"
									class="inline-flex max-w-72 items-center gap-1 font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>
									<span class="truncate">{displayUrl(deployment.previewUrl)}</span>
									<ArrowUpRightIcon class="size-3 shrink-0" />
								</a>
							</Table.Cell>
							<Table.Cell class="hidden font-mono text-xs text-muted-foreground lg:table-cell">
								<span title={deployment.release.sha256}>{shortSha(deployment.release.sha256)}</span>
								<span class="ml-1 text-xs opacity-75"
									>{formatBytes(deployment.release.sizeBytes)}</span
								>
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
								<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time>
							</Table.Cell>
							<Table.Cell class="pr-4 text-right"
								><StatusBadge status={deployment.status} /></Table.Cell
							>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={5} class="py-10 text-center text-sm text-muted-foreground">
								No deployments match this filter.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>
