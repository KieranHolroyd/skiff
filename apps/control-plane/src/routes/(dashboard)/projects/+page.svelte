<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import { formatDate } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		success?: string;
		suggestions?: string[];
		fieldErrors?: Record<string, string>;
		values?: {
			name?: string;
			slug?: string;
			productionAccess?: string;
			previewAccess?: string;
		};
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	const selectClass =
		'h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30';

	function useSuggestion(slug: string) {
		const input = document.getElementById('project-slug');
		if (input instanceof HTMLInputElement) {
			input.value = slug;
			input.focus();
		}
	}

	function accessLabel(value: string): string {
		return value === 'platform' ? 'platform login' : value;
	}
</script>

<svelte:head>
	<title>Projects · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		title="Projects"
		description="A project owns one global slug, its deployments and its production pointer. Sites are static in v1."
	>
		{#if data.can.createProject}
			<Button href="#new-project" size="sm">
				<PlusIcon class="size-3.5" aria-hidden="true" />
				New project
			</Button>
		{/if}
	</PageHeader>

	{#if result?.success}
		<div
			class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
			role="status"
		>
			{result.success}
		</div>
	{/if}
	{#if result?.message}
		<div
			class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
			role="alert"
		>
			{result.message}
		</div>
	{/if}

	<div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
		<Card.Root>
			<Card.Header class="border-b pb-4">
				<Card.Title>All projects</Card.Title>
				<Card.Description
					>{data.projects.length} active {data.projects.length === 1 ? 'project' : 'projects'} in {data
						.org.name}.</Card.Description
				>
			</Card.Header>
			<Card.Content class="p-0">
				{#if data.projects.length === 0}
					<div class="p-4">
						<EmptyState
							title="No projects yet"
							description="Create one on the right, or ask your agent to deploy a site — the first deploy creates the project automatically."
						>
							<Button href="#new-project" size="sm">Create a project</Button>
						</EmptyState>
					</div>
				{:else}
					<div class="overflow-x-auto">
						<table class="w-full text-sm">
							<caption class="sr-only">Projects in this organisation</caption>
							<thead>
								<tr class="border-b text-left text-xs text-muted-foreground">
									<th class="px-4 py-2.5 font-medium">Project</th>
									<th class="hidden px-4 py-2.5 font-medium lg:table-cell">Access</th>
									<th class="hidden px-4 py-2.5 font-medium sm:table-cell">Created</th>
									<th class="px-4 py-2.5 text-right font-medium"
										><span class="sr-only">Actions</span></th
									>
								</tr>
							</thead>
							<tbody>
								{#each data.projects as project (project.slug)}
									<tr class="border-b last:border-0 hover:bg-muted/35">
										<td class="px-4 py-3">
											<a
												href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
												class="font-medium underline-offset-4 hover:underline">{project.name}</a
											>
											<p class="mt-0.5 font-mono text-xs text-muted-foreground">
												{project.slug}.{data.contentDomain}
											</p>
										</td>
										<td class="hidden px-4 py-3 lg:table-cell">
											<div class="flex flex-wrap gap-1.5">
												<Badge variant="outline"
													>prod: {accessLabel(project.productionAccess)}</Badge
												>
												<Badge variant="secondary"
													>preview: {accessLabel(project.previewAccess)}</Badge
												>
											</div>
										</td>
										<td
											class="hidden px-4 py-3 text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
										>
											<time datetime={project.createdAt}>{formatDate(project.createdAt)}</time>
										</td>
										<td class="px-4 py-3">
											<div class="flex items-center justify-end gap-1">
												<Button
													href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
													variant="ghost"
													size="xs"
												>
													Open
													<ArrowRightIcon class="size-3.5" aria-hidden="true" />
												</Button>
												{#if data.can.deleteProject}
													<form method="POST" action="?/delete" use:enhance>
														<input type="hidden" name="slug" value={project.slug} />
														<Button
															type="submit"
															variant="ghost"
															size="xs"
															class="text-destructive hover:bg-destructive/10 hover:text-destructive"
															onclick={(event) => {
																if (
																	!confirm(
																		`Move “${project.name}” to the trash? It is kept for 7 days.`
																	)
																)
																	event.preventDefault();
															}}
														>
															Delete
														</Button>
													</form>
												{/if}
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

		<Card.Root id="new-project" class="scroll-mt-24">
			<Card.Header class="border-b pb-4">
				<Card.Title>New project</Card.Title>
				<Card.Description>
					{data.can.createProject
						? 'Production defaults to public; previews default to platform login.'
						: 'Your role can inspect projects but cannot create them.'}
				</Card.Description>
			</Card.Header>
			<Card.Content>
				{#if !data.can.createProject}
					<div class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
						Ask an owner, admin or deployer to create a project. You can still browse deployments
						and audit activity.
					</div>
				{:else}
					<form method="POST" action="?/create" use:enhance class="space-y-4">
						<div class="space-y-1.5">
							<Label for="project-name">Name</Label>
							<Input
								id="project-name"
								name="name"
								value={result?.values?.name ?? ''}
								placeholder="Marketing site"
								maxlength={120}
								required
								aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
							/>
							{#if result?.fieldErrors?.name}
								<p class="text-xs text-destructive">{result.fieldErrors.name}</p>
							{/if}
						</div>

						<div class="space-y-1.5">
							<Label for="project-slug"
								>Slug <span class="font-normal text-muted-foreground">(optional)</span></Label
							>
							<Input
								id="project-slug"
								name="slug"
								value={result?.values?.slug ?? ''}
								placeholder="marketing-site"
								maxlength={40}
								autocapitalize="off"
								spellcheck="false"
								aria-invalid={result?.fieldErrors?.slug ? 'true' : undefined}
							/>
							<p class="text-xs text-muted-foreground">
								Leave blank to derive it from the name. The slug becomes <span class="font-mono"
									>&lt;slug&gt;.{data.contentDomain}</span
								>.
							</p>
							{#if result?.fieldErrors?.slug}
								<p class="text-xs text-destructive">{result.fieldErrors.slug}</p>
							{/if}
							{#if result?.suggestions?.length}
								<div class="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
									<p class="text-xs text-muted-foreground">
										That slug is unavailable. Try one of these:
									</p>
									<div class="flex flex-wrap gap-1.5">
										{#each result.suggestions as suggestion (suggestion)}
											<Button
												type="button"
												variant="outline"
												size="xs"
												onclick={() => useSuggestion(suggestion)}>{suggestion}</Button
											>
										{/each}
									</div>
								</div>
							{/if}
						</div>

						<div class="grid gap-3 sm:grid-cols-2">
							<div class="space-y-1.5">
								<Label for="production-access">Production access</Label>
								<select
									id="production-access"
									name="productionAccess"
									class={selectClass}
									aria-invalid={result?.fieldErrors?.productionAccess ? 'true' : undefined}
								>
									<option
										value="public"
										selected={(result?.values?.productionAccess ?? 'public') === 'public'}
										>Public</option
									>
									<option
										value="password"
										selected={result?.values?.productionAccess === 'password'}>Password</option
									>
									<option
										value="platform"
										selected={result?.values?.productionAccess === 'platform'}
										>Platform login</option
									>
								</select>
								{#if result?.fieldErrors?.productionAccess}
									<p class="text-xs text-destructive">{result.fieldErrors.productionAccess}</p>
								{/if}
							</div>
							<div class="space-y-1.5">
								<Label for="preview-access">Preview access</Label>
								<select
									id="preview-access"
									name="previewAccess"
									class={selectClass}
									aria-invalid={result?.fieldErrors?.previewAccess ? 'true' : undefined}
								>
									<option
										value="platform"
										selected={(result?.values?.previewAccess ?? 'platform') === 'platform'}
										>Platform login</option
									>
									<option value="public" selected={result?.values?.previewAccess === 'public'}
										>Public</option
									>
									<option value="password" selected={result?.values?.previewAccess === 'password'}
										>Password</option
									>
								</select>
								{#if result?.fieldErrors?.previewAccess}
									<p class="text-xs text-destructive">{result.fieldErrors.previewAccess}</p>
								{/if}
							</div>
						</div>

						<p class="text-xs text-muted-foreground">
							Password mode uses one project-wide secret. New slugs are globally unique — reserved
							platform names are rejected.
						</p>

						<Button type="submit" class="w-full">
							<PlusIcon class="size-4" aria-hidden="true" />
							Create project
						</Button>
					</form>
				{/if}
			</Card.Content>
		</Card.Root>
	</div>
</div>
