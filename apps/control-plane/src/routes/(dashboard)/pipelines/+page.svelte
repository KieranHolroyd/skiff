<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ShieldAlertIcon from '@lucide/svelte/icons/shield-alert';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import DataTable, { type DataColumn } from '#lib/components/skiff/DataTable.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import GithubRepoPicker from '#lib/components/skiff/GithubRepoPicker.svelte';
	import type { GithubRepositoryView } from '@skiff/contracts';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from '../_lib/EmptyState.svelte';
	import PageHeader from '../_lib/PageHeader.svelte';
	import Panel from '../_lib/Panel.svelte';
	import { formatRelative, shortSha } from '../_lib/format.js';
	import SetupSteps from './_lib/SetupSteps.svelte';
	import StateBadge from './_lib/StateBadge.svelte';
	import StateIcon from './_lib/StateIcon.svelte';
	import { anyActive, EVENT_LABEL, runDuration, shortRef } from './_lib/status.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const result = $derived(
		form as { fieldErrors?: Record<string, string>; values?: Record<string, string> } | null
	);
	const errors = $derived(result?.fieldErrors ?? {});
	const values = $derived(result?.values ?? {});

	// Picking a GitHub repository fills these; typing still works (writable deriveds).
	let nameValue = $derived(values.name ?? '');
	let cloneValue = $derived(values.cloneUrl ?? '');
	let branchValue = $derived(values.defaultBranch ?? 'main');
	let providerValue = $derived(values.provider ?? 'github');
	let pickedFullName = $state('');

	function pick(repo: GithubRepositoryView) {
		pickedFullName = repo.fullName;
		cloneValue = repo.cloneUrl;
		branchValue = repo.defaultBranch;
		providerValue = 'github';
		if (!nameValue)
			nameValue = repo.name
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, '-')
				.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
				.slice(0, 100);
	}

	let createOpen = $state(page.url.searchParams.get('new') === '1');
	let query = $state('');
	let matched = $state(0);

	// Recent runs have no REST list across repositories, so refresh the page data while any runs.
	$effect(() => {
		if (!anyActive(data.recent)) return;
		const timer = setInterval(() => void invalidate('skiff:pipelines'), 5000);
		return () => clearInterval(timer);
	});

	type Row = PageProps['data']['repositories'][number];
	const columns: DataColumn<Row>[] = [
		{ id: 'name', header: 'Repository', value: (row) => row.name, cell: nameCell, class: 'pl-4' },
		{
			id: 'clone',
			header: 'Clone URL',
			value: (row) => row.cloneUrl,
			cell: cloneCell,
			class: 'hidden font-mono text-xs text-muted-foreground lg:table-cell'
		},
		{
			id: 'branch',
			header: 'Branch',
			value: (row) => row.defaultBranch,
			cell: branchCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'last',
			header: 'Last run',
			value: (row) => row.lastRun?.createdAt ?? '',
			searchable: false,
			descFirst: true,
			cell: lastCell,
			class: 'pr-4'
		}
	];
</script>

<svelte:head>
	<title>Pipelines · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.pipelines"
		eyebrow="Workloads"
		title="Pipelines"
		description="GitHub Actions–style workflows from .skiff/workflows, run on your build nodes on push, pull request or by hand."
	>
		{#if data.can.manage && !data.denied}
			<Button onclick={() => (createOpen = true)}><PlusIcon />Add repository</Button>
		{/if}
	</PageHeader>

	{#if data.denied}
		<EmptyState
			icon={ShieldAlertIcon}
			title="Pipelines are not visible"
			description="This account does not have the build:read permission."
		/>
	{:else if data.repositories.length === 0}
		<EmptyState
			icon={WorkflowIcon}
			title="No repositories yet"
			description="Connect a repository and Skiff runs its workflows on every push and pull request."
		>
			{#if data.can.manage}
				<Button onclick={() => (createOpen = true)}><PlusIcon />Add repository</Button>
			{/if}
		</EmptyState>
		<Panel title="Getting started" icon={WorkflowIcon}>
			<SetupSteps
				hasRepository={false}
				webhookUrl="{data.origin}/api/webhooks/pipelines/<repository id>"
			/>
		</Panel>
	{:else}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<InputGroup.Root class="max-w-xs bg-card">
				<InputGroup.Input
					placeholder="Search repositories"
					bind:value={query}
					aria-label="Search repositories"
				/>
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				{#if query}
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">{matched}</InputGroup.Text>
					</InputGroup.Addon>
				{/if}
			</InputGroup.Root>
			<p class="text-sm text-muted-foreground">
				{data.repositories.length}
				{data.repositories.length === 1 ? 'repository' : 'repositories'}
			</p>
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Repositories"
				rows={data.repositories}
				{columns}
				rowId={(row) => row.id}
				search={query.trim()}
				sort={{ id: 'name', desc: false }}
				onmatch={(count) => (matched = count)}
			/>
		</div>

		<Panel title="Recent runs" icon={HistoryIcon} flush count={data.recent.length}>
			{#if data.recent.length === 0}
				<p class="px-6 pb-4 text-sm text-muted-foreground">
					No runs yet. Push to a connected repository or run a workflow by hand.
				</p>
			{:else}
				<ul class="divide-y">
					{#each data.recent as run (run.id)}
						<li>
							<a
								href={resolve('/(dashboard)/pipelines/[repo]/runs/[run]', {
									repo: run.repository,
									run: String(run.number)
								})}
								class="flex items-center gap-3 px-6 py-2.5 hover:bg-muted/50"
							>
								<StateIcon status={run.status} conclusion={run.conclusion} />
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{run.title}</span>
									<span class="block truncate text-xs text-muted-foreground">
										<span class="font-mono">{run.repository}</span> · {run.workflowName} #{run.number}
										· {EVENT_LABEL[run.event] ?? run.event} on
										<span class="font-mono">{shortRef(run.ref)}</span>
										<span class="font-mono">{shortSha(run.sha, 7)}</span>
									</span>
								</span>
								<span class="hidden text-right text-xs text-muted-foreground sm:block">
									<span class="block">{formatRelative(run.createdAt)}</span>
									<span class="block font-mono tabular-nums">{runDuration(run)}</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{/if}
</div>

{#if data.can.manage}
	<FormDialog
		bind:open={createOpen}
		icon={WorkflowIcon}
		title="Add repository"
		description="Skiff reads workflows from .skiff/workflows at each commit. Nodes with the Builder role run the jobs."
		action="?/create"
		submitLabel="Add repository"
		size="lg"
	>
		<Field.Group>
			<GithubRepoPicker onpick={pick} selected={pickedFullName} />
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.name ? true : undefined}>
					<Field.Label for="repo-name">Name</Field.Label>
					<Input
						id="repo-name"
						name="name"
						placeholder="api"
						required
						maxlength={100}
						autocapitalize="off"
						spellcheck="false"
						class="font-mono text-sm"
						bind:value={nameValue}
						aria-invalid={errors.name ? 'true' : undefined}
					/>
					<Field.Description>Lowercase letters, digits, dots, dashes, underscores.</Field.Description>
					{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.provider ? true : undefined}>
					<Field.Label for="repo-provider">Provider</Field.Label>
					<NativeSelect.Root
						id="repo-provider"
						name="provider"
						bind:value={providerValue}
						class="w-full"
					>
						<NativeSelect.Option value="github">GitHub</NativeSelect.Option>
						<NativeSelect.Option value="generic">Other git host</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
			</div>
			<Field.Field data-invalid={errors.cloneUrl ? true : undefined}>
				<Field.Label for="repo-clone">Clone URL</Field.Label>
				<Input
					id="repo-clone"
					name="cloneUrl"
					placeholder="https://github.com/acme/api.git"
					required
					spellcheck="false"
					class="font-mono text-sm"
					bind:value={cloneValue}
					aria-invalid={errors.cloneUrl ? 'true' : undefined}
				/>
				{#if errors.cloneUrl}<Field.Error>{errors.cloneUrl}</Field.Error>{/if}
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.defaultBranch ? true : undefined}>
					<Field.Label for="repo-branch">Default branch</Field.Label>
					<Input
						id="repo-branch"
						name="defaultBranch"
						placeholder="main"
						spellcheck="false"
						class="font-mono text-sm"
						bind:value={branchValue}
						aria-invalid={errors.defaultBranch ? 'true' : undefined}
					/>
					{#if errors.defaultBranch}<Field.Error>{errors.defaultBranch}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.webhookSecret ? true : undefined}>
					<Field.Label for="repo-secret">
						Webhook secret <span class="font-normal text-muted-foreground">optional</span>
					</Field.Label>
					<Input
						id="repo-secret"
						name="webhookSecret"
						type="password"
						autocomplete="new-password"
						minlength={16}
						class="font-mono text-sm"
						aria-invalid={errors.webhookSecret ? 'true' : undefined}
					/>
					<Field.Description
						>{pickedFullName
							? 'Not needed: the GitHub App delivers this repository’s events.'
							: 'At least 16 characters. Paste the same into GitHub. Not needed for repositories the GitHub App covers.'}</Field.Description
					>
					{#if errors.webhookSecret}<Field.Error>{errors.webhookSecret}</Field.Error>{/if}
				</Field.Field>
			</div>
			<Field.Field data-invalid={errors.defaultImage ? true : undefined}>
				<Field.Label for="repo-image">
					Default image <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Input
					id="repo-image"
					name="defaultImage"
					placeholder="docker.io/library/node:24-bookworm"
					spellcheck="false"
					class="font-mono text-sm"
					value={values.defaultImage ?? ''}
					aria-invalid={errors.defaultImage ? 'true' : undefined}
				/>
				<Field.Description>For jobs without <code class="font-mono">container:</code>.</Field.Description>
				{#if errors.defaultImage}<Field.Error>{errors.defaultImage}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet nameCell(item: Row)}
	<div class="flex items-center gap-3">
		<span
			class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
		>
			<WorkflowIcon class="size-4" />
		</span>
		<div class="min-w-0">
			<a
				href={resolve('/(dashboard)/pipelines/[repo]', { repo: item.name })}
				class="font-mono text-sm font-medium underline-offset-4 group-hover:underline">{item.name}</a
			>
			<p class="text-xs text-muted-foreground">
				{item.provider === 'github' ? 'GitHub' : 'Git'}{item.enabled ? '' : ' · disabled'}
			</p>
		</div>
	</div>
{/snippet}

{#snippet cloneCell(item: Row)}
	<span class="block max-w-xs truncate">{item.cloneUrl}</span>
{/snippet}

{#snippet branchCell(item: Row)}
	<span class="inline-flex items-center gap-1"
		><GitBranchIcon class="size-3 text-muted-foreground" />{item.defaultBranch}</span
	>
{/snippet}

{#snippet lastCell(item: Row)}
	{#if item.lastRun}
		{@const run = item.lastRun}
		<a
			href={resolve('/(dashboard)/pipelines/[repo]/runs/[run]', {
				repo: item.name,
				run: String(run.number)
			})}
			class="flex items-center gap-2"
		>
			<StateBadge status={run.status} conclusion={run.conclusion} />
			<span class="hidden min-w-0 text-xs text-muted-foreground sm:block">
				<span class="block truncate">{run.workflowName} #{run.number}</span>
				<span class="block">{formatRelative(run.createdAt)}</span>
			</span>
		</a>
	{:else}
		<span class="text-xs text-muted-foreground">No runs yet</span>
	{/if}
{/snippet}
