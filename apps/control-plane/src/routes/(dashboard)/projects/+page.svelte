<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import AccessChip from '../_lib/AccessChip.svelte';
	import AccessSelect from '../_lib/AccessSelect.svelte';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import ProjectMark from '../_lib/ProjectMark.svelte';
	import RowMenu from '../_lib/RowMenu.svelte';
	import { formatDate } from '../_lib/format.js';
	import type { PageProps } from './$types';

	interface ProjectFormResult {
		message?: string;
		suggestions?: string[];
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as ProjectFormResult | null);

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let slug = $state('');
	let productionAccess = $state('public');
	let previewAccess = $state('platform');

	const filtered = $derived(
		data.projects.filter((project) => {
			const q = query.trim().toLowerCase();
			return !q || project.name.toLowerCase().includes(q) || project.slug.includes(q);
		})
	);

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		toast.success('Copied to the clipboard.');
	}

	function confirmDelete(project: { name: string; slug: string }) {
		askConfirm({
			title: `Delete ${project.name}?`,
			description: `The project moves to the trash and is kept for 7 days. ${project.slug}.${data.contentDomain} stops serving.`,
			confirmLabel: 'Move to trash',
			tone: 'danger',
			action: '?/delete',
			fields: { slug: project.slug }
		});
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
			<Button onclick={() => (createOpen = true)}>
				<PlusIcon />
				New project
			</Button>
		{/if}
	</PageHeader>

	{#if data.projects.length === 0}
		<EmptyState
			icon={FolderKanbanIcon}
			title="No projects yet"
			description="Create one here, or ask your agent to deploy a site — the first deploy creates the project automatically."
		>
			{#if data.can.createProject}
				<Button onclick={() => (createOpen = true)}><PlusIcon />Create a project</Button>
			{/if}
		</EmptyState>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input placeholder="Search projects" bind:value={query} aria-label="Search projects" />
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{filtered.length}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{data.projects.length}
				{data.projects.length === 1 ? 'project' : 'projects'} in {data.org.name}
			</p>
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-card">
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Project</Table.Head>
						<Table.Head class="hidden md:table-cell">Production</Table.Head>
						<Table.Head class="hidden lg:table-cell">Access</Table.Head>
						<Table.Head class="hidden sm:table-cell">Created</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each filtered as project (project.slug)}
						{@const href = resolve('/(dashboard)/projects/[slug]', { slug: project.slug })}
						<Table.Row class="group">
							<Table.Cell class="pl-4">
								<div class="flex items-center gap-3">
									<ProjectMark slug={project.slug} name={project.name} />
									<div class="min-w-0">
										<a {href} class="font-medium underline-offset-4 group-hover:underline"
											>{project.name}</a
										>
										<p class="truncate font-mono text-[11px] text-muted-foreground">
											{project.slug}.{data.contentDomain}
										</p>
									</div>
								</div>
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								{#if project.productionDeploymentId}
									<StatusBadge status="online" tone="success" label="Live" />
								{:else}
									<StatusBadge status="inactive" label="Not deployed" />
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden lg:table-cell">
								<div class="flex flex-wrap gap-1.5">
									<AccessChip scope="Prod" mode={project.productionAccess} />
									<AccessChip scope="Preview" mode={project.previewAccess} />
								</div>
							</Table.Cell>
							<Table.Cell class="hidden font-mono text-xs text-muted-foreground sm:table-cell">
								<time datetime={project.createdAt}>{formatDate(project.createdAt)}</time>
							</Table.Cell>
							<Table.Cell class="pr-4">
								<RowMenu label="Actions for {project.name}">
									<DropdownMenu.Item onSelect={() => goto(href)}>
										<ArrowRightIcon />Open project
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onSelect={() => window.open(project.productionUrl, '_blank', 'noreferrer')}
									>
										<ArrowUpRightIcon />Visit site
									</DropdownMenu.Item>
									<DropdownMenu.Item onSelect={() => copy(project.productionUrl)}>
										<CopyIcon />Copy URL
									</DropdownMenu.Item>
									{#if data.can.deleteProject}
										<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onSelect={() => confirmDelete(project)}>
											<TrashIcon />Delete project
										</DropdownMenu.Item>
									{/if}
								</RowMenu>
							</Table.Cell>
						</Table.Row>
					{:else}
						<Table.Row>
							<Table.Cell colspan={5} class="py-10 text-center text-sm text-muted-foreground">
								No projects match “{query}”.
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>

{#if data.can.createProject}
	<FormDialog
		bind:open={createOpen}
		icon={FolderKanbanIcon}
		title="New project"
		description="Production defaults to public; previews to platform login. You can change both later."
		action="?/create"
		submitLabel="Create project"
	>
		<Field.Group>
			<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
				<Field.Label for="project-name">Name</Field.Label>
				<Input
					id="project-name"
					name="name"
					placeholder="Marketing site"
					maxlength={120}
					required
					aria-invalid={result?.fieldErrors?.name ? 'true' : undefined}
				/>
				{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error>{/if}
			</Field.Field>

			<Field.Field data-invalid={result?.fieldErrors?.slug ? true : undefined}>
				<Field.Label for="project-slug">
					Slug <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="project-slug"
						name="slug"
						bind:value={slug}
						placeholder="marketing-site"
						maxlength={40}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-[13px]"
						aria-invalid={result?.fieldErrors?.slug ? 'true' : undefined}
					/>
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">.{data.contentDomain}</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
				<Field.Description>Leave blank to derive it from the name. Slugs are globally unique.</Field.Description>
				{#if result?.fieldErrors?.slug}<Field.Error>{result.fieldErrors.slug}</Field.Error>{/if}
				{#if result?.suggestions?.length}
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="text-xs text-muted-foreground">Try:</span>
						{#each result.suggestions as suggestion (suggestion)}
							<Button
								type="button"
								variant="outline"
								size="xs"
								class="font-mono"
								onclick={() => (slug = suggestion)}>{suggestion}</Button
							>
						{/each}
					</div>
				{/if}
			</Field.Field>

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="production-access">Production access</Field.Label>
					<AccessSelect
						id="production-access"
						name="productionAccess"
						bind:value={productionAccess}
						invalid={Boolean(result?.fieldErrors?.productionAccess)}
					/>
				</Field.Field>
				<Field.Field>
					<Field.Label for="preview-access">Preview access</Field.Label>
					<AccessSelect
						id="preview-access"
						name="previewAccess"
						bind:value={previewAccess}
						invalid={Boolean(result?.fieldErrors?.previewAccess)}
					/>
				</Field.Field>
			</div>
			{#if productionAccess === 'password' || previewAccess === 'password'}
				<Field.Description>
					Set the project password from the project's Settings tab after it is created.
				</Field.Description>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}
