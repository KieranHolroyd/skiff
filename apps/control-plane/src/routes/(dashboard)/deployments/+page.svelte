<script lang="ts">
	import { resolve } from '$app/paths';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatBytes, formatDateTime, shortSha } from '../_lib/format.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const selectClass =
		'h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

	function deploymentTone(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
		if (status === 'active') return 'default';
		if (status === 'failed') return 'destructive';
		if (status === 'pending') return 'secondary';
		return 'outline';
	}
</script>

<svelte:head>
	<title>Deployments · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Deployments"
		description="Every deployment has an immutable preview URL. Only the production pointer moves on promote or rollback."
	/>

	{#if data.filterMissing}
		<div
			class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
			role="status"
		>
			No project matches <span class="font-mono">{data.filter}</span>. It may have been deleted or
			renamed.
		</div>
	{/if}

	<Card.Root>
		<Card.Header class="flex-row flex-wrap items-end justify-between gap-3 border-b pb-4">
			<div class="space-y-1">
				<Card.Title>Recent deployments</Card.Title>
				<Card.Description
					>{data.deployments.length} deployments across {data.projects.length} projects.</Card.Description
				>
			</div>
			<form method="GET" class="flex items-end gap-2">
				<div class="space-y-1.5">
					<label for="project-filter" class="text-xs font-medium text-muted-foreground"
						>Project</label
					>
					<select id="project-filter" name="project" class={selectClass}>
						<option value="" selected={!data.filter}>All projects</option>
						{#each data.projects as project (project.slug)}
							<option value={project.slug} selected={data.filter === project.slug}
								>{project.name} ({project.slug})</option
							>
						{/each}
					</select>
				</div>
				<Button type="submit" variant="outline" size="sm">Apply</Button>
				{#if data.filter}
					<Button href={resolve('/(dashboard)/deployments')} variant="ghost" size="sm">Clear</Button
					>
				{/if}
			</form>
		</Card.Header>
		<Card.Content class="p-0">
			{#if data.deployments.length === 0}
				<div class="p-4">
					<EmptyState
						title={data.filter ? 'No deployments for this project' : 'No deployments yet'}
						description={data.projects.length === 0
							? 'Create a project and deploy from the CLI or an MCP client. The first deploy creates a preview immediately.'
							: 'Deploy from the CLI with `skif deploy ./dist --project <slug>`, or ask your agent to deploy a site.'}
					>
						<Button href={resolve('/(dashboard)/projects')} size="sm">
							<RocketIcon class="size-3.5" aria-hidden="true" />
							Open projects
						</Button>
					</EmptyState>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-sm">
						<caption class="sr-only">Recent deployments</caption>
						<thead>
							<tr class="border-b text-left text-xs text-muted-foreground">
								<th class="px-4 py-2.5 font-medium">Project / deployment</th>
								<th class="hidden px-4 py-2.5 font-medium md:table-cell">Preview</th>
								<th class="hidden px-4 py-2.5 font-medium lg:table-cell">Commit</th>
								<th class="hidden px-4 py-2.5 font-medium sm:table-cell">Created</th>
								<th class="px-4 py-2.5 text-right font-medium">Status</th>
							</tr>
						</thead>
						<tbody>
							{#each data.deployments as deployment (deployment.id)}
								<tr class="border-b last:border-0 hover:bg-muted/35">
									<td class="px-4 py-3">
										<div class="flex flex-wrap items-center gap-1.5">
											<a
												href={resolve('/(dashboard)/projects/[slug]', {
													slug: deployment.projectSlug
												})}
												class="font-medium underline-offset-4 hover:underline"
											>
												{deployment.projectSlug}
											</a>
											<span class="font-mono text-xs text-muted-foreground"
												>{deployment.shortId}</span
											>
											{#if deployment.isProduction}<Badge>production</Badge>{/if}
											{#if deployment.pinned}<Badge variant="outline">pinned</Badge>{/if}
										</div>
										{#if deployment.message}
											<p
												class="mt-1 max-w-md truncate text-xs text-muted-foreground"
												title={deployment.message}
											>
												{deployment.message}
											</p>
										{/if}
									</td>
									<td class="hidden px-4 py-3 md:table-cell">
										<a
											href={deployment.previewUrl}
											target="_blank"
											rel="external noreferrer"
											class="inline-flex max-w-72 items-center gap-1 truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
										>
											{deployment.previewUrl.replace('https://', '')}
											<ExternalLinkIcon class="size-3 shrink-0" aria-hidden="true" />
										</a>
									</td>
									<td
										class="hidden px-4 py-3 font-mono text-xs text-muted-foreground lg:table-cell"
										title={deployment.release.sha256}
									>
										{shortSha(deployment.release.sha256)}
										<span class="ml-1 text-[10px]"
											>· {formatBytes(deployment.release.sizeBytes)}</span
										>
									</td>
									<td
										class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
									>
										<time datetime={deployment.createdAt}
											>{formatDateTime(deployment.createdAt)}</time
										>
									</td>
									<td class="px-4 py-3 text-right">
										<Badge variant={deploymentTone(deployment.status)}>{deployment.status}</Badge>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
