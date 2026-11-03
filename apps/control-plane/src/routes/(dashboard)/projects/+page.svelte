<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import AccessChip from '../_lib/AccessChip.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
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

	function useSuggestion(slug: string) {
		const input = document.getElementById('project-slug');
		if (input instanceof HTMLInputElement) {
			input.value = slug;
			input.focus();
		}
	}
</script>

<svelte:head>
	<title>Projects · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		eyebrow="Operate"
		title="Projects"
		description="A project owns one global slug, its deployments and its production pointer. Sites are static in v1."
	>
		{#if data.can.createProject}
			<Button href="#new-project">
				<PlusIcon aria-hidden="true" />
				New project
			</Button>
		{/if}
	</PageHeader>

	<FormFeedback {result} />

	<div class="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
		<Panel
			title="All projects"
			count={data.projects.length}
			description="Active projects in {data.org.name}."
			flush
		>
			{#if data.projects.length === 0}
				<div class="p-4">
					<EmptyState
						icon={FolderKanbanIcon}
						title="No projects yet"
						description="Create one here, or ask your agent to deploy a site — the first deploy creates the project automatically."
					>
						{#if data.can.createProject}
							<Button href="#new-project" size="sm">Create a project</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<div class="overflow-x-auto">
					<table class="data-table">
						<caption class="sr-only">Projects in this organisation</caption>
						<thead>
							<tr>
								<th>Project</th>
								<th class="hidden lg:table-cell">Access</th>
								<th class="hidden sm:table-cell">Created</th>
								<th class="text-right"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each data.projects as project (project.slug)}
								<tr>
									<td>
										<div class="flex items-center gap-3">
											<ProjectMark slug={project.slug} name={project.name} />
											<div class="min-w-0">
												<a
													href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
													class="font-medium underline-offset-4 hover:underline">{project.name}</a
												>
												<p class="truncate font-mono text-[11px] text-muted-foreground">
													{project.slug}.{data.contentDomain}
												</p>
											</div>
										</div>
									</td>
									<td class="hidden lg:table-cell">
										<div class="flex flex-wrap gap-1.5">
											<AccessChip scope="Prod" mode={project.productionAccess} />
											<AccessChip scope="Preview" mode={project.previewAccess} />
										</div>
									</td>
									<td
										class="hidden font-mono text-xs whitespace-nowrap text-muted-foreground sm:table-cell"
									>
										<time datetime={project.createdAt}>{formatDate(project.createdAt)}</time>
									</td>
									<td>
										<div class="flex items-center justify-end gap-1">
											{#if data.can.deleteProject}
												<form method="POST" action="?/delete" use:enhance>
													<input type="hidden" name="slug" value={project.slug} />
													<Button
														type="submit"
														variant="ghost-danger"
														size="icon-sm"
														aria-label="Delete {project.name}"
														title="Move to trash"
														onclick={(event) => {
															if (
																!confirm(
																	`Move “${project.name}” to the trash? It is kept for 7 days.`
																)
															)
																event.preventDefault();
														}}
													>
														<TrashIcon aria-hidden="true" />
													</Button>
												</form>
											{/if}
											<Button
												href={resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
												variant="outline"
												size="sm"
											>
												Open
												<ArrowRightIcon aria-hidden="true" />
											</Button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Panel>

		<Panel
			id="new-project"
			class="scroll-mt-20 xl:sticky xl:top-20"
			icon={PlusIcon}
			title="New project"
			description={data.can.createProject
				? 'Production defaults to public; previews to platform login.'
				: 'Your role can inspect projects but cannot create them.'}
		>
			{#if !data.can.createProject}
				<p class="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
					Ask an owner, admin or deployer to create a project. You can still browse deployments and
					audit activity.
				</p>
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
							>Slug <span class="font-normal text-muted-foreground">optional</span></Label
						>
						<div
							class="flex h-8 items-center overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40 has-aria-invalid:border-destructive dark:bg-input/30"
						>
							<input
								id="project-slug"
								name="slug"
								value={result?.values?.slug ?? ''}
								placeholder="marketing-site"
								maxlength={40}
								autocapitalize="off"
								spellcheck="false"
								aria-invalid={result?.fieldErrors?.slug ? 'true' : undefined}
								aria-describedby="project-slug-hint"
								class="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground"
							/>
							<span
								class="flex h-full items-center border-l bg-muted/50 px-2 font-mono text-[11px] text-muted-foreground"
								>.{data.contentDomain}</span
							>
						</div>
						<p id="project-slug-hint" class="text-xs text-muted-foreground">
							Leave blank to derive it from the name. Slugs are globally unique.
						</p>
						{#if result?.fieldErrors?.slug}
							<p class="text-xs text-destructive">{result.fieldErrors.slug}</p>
						{/if}
						{#if result?.suggestions?.length}
							<div class="space-y-2 rounded-lg border bg-muted/30 p-2.5">
								<p class="text-xs text-muted-foreground">That slug is taken. Try one of these:</p>
								<div class="flex flex-wrap gap-1.5">
									{#each result.suggestions as suggestion (suggestion)}
										<Button
											type="button"
											variant="outline"
											size="xs"
											class="font-mono"
											onclick={() => useSuggestion(suggestion)}>{suggestion}</Button
										>
									{/each}
								</div>
							</div>
						{/if}
					</div>

					<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
						<div class="space-y-1.5">
							<Label for="production-access">Production access</Label>
							<select
								id="production-access"
								name="productionAccess"
								class="select-native"
								aria-invalid={result?.fieldErrors?.productionAccess ? 'true' : undefined}
							>
								<option
									value="public"
									selected={(result?.values?.productionAccess ?? 'public') === 'public'}
									>Public</option
								>
								<option value="password" selected={result?.values?.productionAccess === 'password'}
									>Password</option
								>
								<option value="platform" selected={result?.values?.productionAccess === 'platform'}
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
								class="select-native"
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

					<p class="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
						Password mode uses one project-wide secret. Reserved platform names are rejected.
					</p>

					<Button type="submit" class="w-full">
						<PlusIcon aria-hidden="true" />
						Create project
					</Button>
				</form>
			{/if}
		</Panel>
	</div>
</div>
