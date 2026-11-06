<script lang="ts">
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import LayoutTemplateIcon from '@lucide/svelte/icons/layout-template';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { runtimeInfo, type RuntimeTier } from '../_lib/runtime.js';
	import TemplateTile from './_lib/TemplateTile.svelte';
	import { categoryLabels } from './_lib/icons.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');
	let category = $state<string | null>(null);

	const categories = $derived([...new Set(data.templates.map((template) => template.category))]);
	const filtered = $derived(
		data.templates.filter((template) => {
			if (category && template.category !== category) return false;
			const needle = query.trim().toLowerCase();
			if (!needle) return true;
			return `${template.name} ${template.summary} ${template.category}`
				.toLowerCase()
				.includes(needle);
		})
	);
	/** One template gets the whole row; it reads as a feature rather than a lonely tile. */
	const featured = $derived(data.templates.length === 1);

	/** Every template run creates the same four things (D92); the plan fills in the details. */
	const creates = ['Project', 'Secrets', 'Workload', 'First deployment'];

	/** Project runtimes; functions are their own product under /functions (D110). */
	const tiers: RuntimeTier[] = ['static', 'process', 'container'];
	const blanks = $derived(
		tiers.map((runtime) => ({
			runtime,
			title: runtimeInfo(runtime).label,
			description: runtimeInfo(runtime).description,
			icon: runtimeInfo(runtime).icon
		}))
	);

	function blankHref(runtime: string): string {
		return `${resolve('/(dashboard)/projects')}?new=1&runtime=${runtime}`;
	}
</script>

<svelte:head>
	<title>New project · Skiff</title>
</svelte:head>

<div class="space-y-10">
	<PageHeader
		target="page.new"
		eyebrow="Projects"
		title="Start something new"
		description="Pick a template and Skiff creates the project, stores its credentials and deploys it in one step. Or start from a blank runtime."
	/>

	<section class="space-y-4" aria-labelledby="templates-heading">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 id="templates-heading" class="flex items-center gap-2 text-base font-semibold">
					<LayoutTemplateIcon class="size-4 text-muted-foreground" />Templates
				</h2>
				<p class="text-sm text-muted-foreground">
					First-party and reviewed. Each one is a plain form over the same API you can script.
				</p>
			</div>
			{#if data.templates.length > 4}
				<div class="flex flex-wrap items-center gap-2">
					{#if categories.length > 1}
						<div class="flex gap-1" role="group" aria-label="Category">
							<button
								type="button"
								class="rounded-full border px-2.5 py-1 text-xs transition-colors {category === null
									? 'border-foreground/30 bg-muted font-medium'
									: 'text-muted-foreground hover:bg-muted/60'}"
								aria-pressed={category === null}
								onclick={() => (category = null)}>All</button
							>
							{#each categories as value (value)}
								<button
									type="button"
									class="rounded-full border px-2.5 py-1 text-xs transition-colors {category ===
									value
										? 'border-foreground/30 bg-muted font-medium'
										: 'text-muted-foreground hover:bg-muted/60'}"
									aria-pressed={category === value}
									onclick={() => (category = value)}>{categoryLabels[value] ?? value}</button
								>
							{/each}
						</div>
					{/if}
					<InputGroup.Root class="w-56 bg-card">
						<InputGroup.Input
							placeholder="Search templates"
							bind:value={query}
							aria-label="Search templates"
						/>
						<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
					</InputGroup.Root>
				</div>
			{/if}
		</div>

		{#if data.templates.length === 0}
			<EmptyState
				icon={LayoutTemplateIcon}
				title="No templates available"
				description="Your role cannot read the template catalog."
				compact
			/>
		{:else if filtered.length === 0}
			<EmptyState
				icon={SearchIcon}
				title="No templates match"
				description="Try a different search."
				compact
			/>
		{:else}
			<ul class="grid gap-4 {featured ? '' : 'md:grid-cols-2 xl:grid-cols-3'}">
				{#each filtered as template (template.id)}
					{@const href = resolve('/(dashboard)/new/[template]', { template: template.id })}
					<li
						class="group relative overflow-hidden rounded-2xl border bg-card shadow-xs transition-all hover:border-foreground/20 hover:shadow-md has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
					>
						<div
							class="relative grid gap-6 p-5 sm:p-6 {featured
								? 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-10'
								: ''}"
						>
							<div class="flex flex-col gap-4">
								<div class="flex items-start gap-4">
									<TemplateTile
										id={template.id}
										icon={template.icon}
										size={featured ? 'lg' : 'md'}
									/>
									<div class="min-w-0 space-y-1">
										<div class="flex flex-wrap items-center gap-2">
											<h3 class="font-semibold tracking-tight {featured ? 'text-lg' : ''}">
												<a
													{href}
													class="outline-none after:absolute after:inset-0 after:content-['']"
													>{template.name}</a
												>
											</h3>
											<Badge variant="neutral"
												>{categoryLabels[template.category] ?? template.category}</Badge
											>
										</div>
										<p class="text-sm text-pretty text-muted-foreground">{template.summary}</p>
									</div>
								</div>

								<div class="flex flex-wrap items-center gap-1.5" aria-label="Creates">
									{#each creates as item, index (item)}
										<span
											class="inline-flex h-6 items-center rounded-md border bg-background/60 px-2 text-xs text-muted-foreground"
											>{item}</span
										>
										{#if index < creates.length - 1}
											<ArrowRightIcon class="size-3 text-muted-foreground/50" aria-hidden="true" />
										{/if}
									{/each}
								</div>

								<div class="mt-auto flex flex-wrap items-center gap-3 pt-1">
									<span
										class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground shadow-xs transition-colors group-hover:bg-primary/90"
										aria-hidden="true"
									>
										Configure<ArrowRightIcon
											class="size-4 transition-transform group-hover:translate-x-0.5"
										/>
									</span>
									{#if template.docsUrl}
										<!-- eslint-disable svelte/no-navigation-without-resolve -- external documentation link -->
										<a
											href={template.docsUrl}
											target="_blank"
											rel="noreferrer"
											class="relative z-10 inline-flex items-center gap-0.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
											>Docs<ArrowUpRightIcon class="size-3.5" /></a
										>
										<!-- eslint-enable svelte/no-navigation-without-resolve -->
									{/if}
									<span class="ml-auto font-mono text-xs text-muted-foreground"
										>v{template.version}</span
									>
								</div>
							</div>

							{#if template.highlights?.length}
								<ul
									class="space-y-2.5 text-sm {featured ? 'lg:border-l lg:pl-10' : 'border-t pt-4'}"
								>
									{#each template.highlights as highlight (highlight)}
										<li class="flex gap-2.5">
											<span
												class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
											>
												<CheckIcon class="size-2.5" strokeWidth={3} />
											</span>
											<span class="text-pretty text-muted-foreground">{highlight}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.can.createProject}
		<section class="space-y-4" aria-labelledby="blank-heading">
			<div>
				<h2 id="blank-heading" class="text-base font-semibold">Or start from a blank runtime</h2>
				<p class="text-sm text-muted-foreground">
					Creates an empty project; deploy to it from the CLI, a git build or a zip.
				</p>
			</div>
			<ul class="grid gap-3 sm:grid-cols-3">
				{#each blanks as blank (blank.runtime)}
					<li>
						<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved route plus a query string -->
						<a
							href={blankHref(blank.runtime)}
							class="group flex h-full items-start gap-3 rounded-xl border border-dashed p-4 transition-all hover:border-solid hover:border-foreground/20 hover:bg-card hover:shadow-xs focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
						>
							<span
								class="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground transition-colors group-hover:text-foreground"
							>
								<blank.icon class="size-4" />
							</span>
							<span class="min-w-0 flex-1 space-y-0.5">
								<span class="flex items-center gap-1 text-sm font-medium">
									{blank.title}
									<ArrowRightIcon
										class="size-3.5 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
									/>
								</span>
								<span class="block text-xs text-pretty text-muted-foreground"
									>{blank.description}</span
								>
							</span>
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
