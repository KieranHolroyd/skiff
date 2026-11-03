<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import FilterIcon from '@lucide/svelte/icons/list-filter';
	import PinIcon from '@lucide/svelte/icons/pin';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import XIcon from '@lucide/svelte/icons/x';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import { displayUrl, formatBytes, formatDateTime, shortSha } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
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
		<Notice tone="warning">
			No project matches <span class="font-mono">{data.filter}</span>. It may have been deleted or
			renamed.
		</Notice>
	{/if}

	<Panel
		title="Recent deployments"
		count={data.deployments.length}
		description="Across {data.projects.length} {data.projects.length === 1 ? 'project' : 'projects'}."
		flush
	>
		{#snippet actions()}
			<form method="GET" class="flex items-center gap-2">
				<label for="project-filter" class="sr-only">Filter by project</label>
				<div class="relative">
					<FilterIcon
						class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						aria-hidden="true"
					/>
					<select
						id="project-filter"
						name="project"
						class="select-native w-56 pl-8"
						onchange={(event) => event.currentTarget.form?.requestSubmit()}
					>
						<option value="" selected={!data.filter}>All projects</option>
						{#each data.projects as project (project.slug)}
							<option value={project.slug} selected={data.filter === project.slug}
								>{project.name} ({project.slug})</option
							>
						{/each}
					</select>
				</div>
				<noscript><Button type="submit" variant="outline">Apply</Button></noscript>
				{#if data.filter}
					<Button
						href={resolve('/(dashboard)/deployments')}
						variant="ghost"
						size="icon"
						aria-label="Clear filter"
						title="Clear filter"
					>
						<XIcon aria-hidden="true" />
					</Button>
				{/if}
			</form>
		{/snippet}

		{#if data.deployments.length === 0}
			<div class="p-4">
				<EmptyState
					icon={RocketIcon}
					title={data.filter ? 'No deployments for this project' : 'No deployments yet'}
					description={data.projects.length === 0
						? 'Create a project and deploy from the CLI or an MCP client. The first deploy creates a preview immediately.'
						: 'Deploy from the CLI with `skif deploy ./dist --project <slug>`, or ask your agent to deploy a site.'}
				>
					<Button href={resolve('/(dashboard)/projects')} size="sm">Open projects</Button>
				</EmptyState>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="data-table">
					<caption class="sr-only">Recent deployments</caption>
					<thead>
						<tr>
							<th>Deployment</th>
							<th class="hidden md:table-cell">Preview</th>
							<th class="hidden lg:table-cell">Release</th>
							<th class="hidden sm:table-cell">Created</th>
							<th class="text-right">Status</th>
						</tr>
					</thead>
					<tbody>
						{#each data.deployments as deployment (deployment.id)}
							<tr>
								<td>
									<div class="flex flex-wrap items-center gap-1.5">
										<a
											href={resolve('/(dashboard)/projects/[slug]', {
												slug: deployment.projectSlug
											})}
											class="font-medium underline-offset-4 hover:underline"
										>
											{deployment.projectSlug}
										</a>
										<span class="font-mono text-xs text-muted-foreground">{deployment.shortId}</span>
										{#if deployment.isProduction}<Badge variant="brand">production</Badge>{/if}
										{#if deployment.pinned}<Badge variant="outline"
												><PinIcon aria-hidden="true" />pinned</Badge
											>{/if}
									</div>
									{#if deployment.message}
										<p
											class="mt-0.5 max-w-md truncate text-xs text-muted-foreground"
											title={deployment.message}
										>
											{deployment.message}
										</p>
									{/if}
								</td>
								<td class="hidden md:table-cell">
									<a
										href={deployment.previewUrl}
										target="_blank"
										rel="external noreferrer"
										class="inline-flex max-w-72 items-center gap-1 font-mono text-[11.5px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
									>
										<span class="truncate">{displayUrl(deployment.previewUrl)}</span>
										<ArrowUpRightIcon class="size-3 shrink-0" aria-hidden="true" />
									</a>
								</td>
								<td class="hidden font-mono text-xs text-muted-foreground lg:table-cell">
									<span title={deployment.release.sha256}>{shortSha(deployment.release.sha256)}</span>
									<span class="ml-1 text-[11px] opacity-75">{formatBytes(deployment.release.sizeBytes)}</span>
								</td>
								<td class="hidden text-xs whitespace-nowrap text-muted-foreground sm:table-cell">
									<time datetime={deployment.createdAt}>{formatDateTime(deployment.createdAt)}</time>
								</td>
								<td class="text-right">
									<StatusBadge status={deployment.status} />
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</Panel>
</div>
