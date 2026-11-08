<script lang="ts">
	import { browser } from '$app/env';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { untrack } from 'svelte';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import CornerLeftUpIcon from '@lucide/svelte/icons/corner-left-up';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import {
		FRAMEWORK_PRESETS,
		frameworkIds,
		type FrameworkId,
		type GithubImportDetection,
		type GithubRepositoryList
	} from '@skiff/contracts';
	import GitHubMark from '#lib/components/skiff/GitHubMark.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const result = $derived(
		form as {
			message?: string;
			fieldErrors?: Record<string, string>;
			suggestions?: string[];
			values?: Record<string, string>;
		} | null
	);
	const errors = $derived(result?.fieldErrors ?? {});

	// ------------------------------------------------------------------ step 1: the repository list

	const client = useQueryClient();
	let filter = $state('');
	let refreshing = $state(false);

	const repos = createQuery(() => ({
		queryKey: ['github-repositories'] as const,
		queryFn: ({ signal }) =>
			fetchJson<GithubRepositoryList>('/api/v1/github/repositories', {
				signal,
				fallback: 'Could not list GitHub repositories'
			}),
		enabled: browser && data.connected && !data.repo,
		staleTime: 60_000,
		retry: false
	}));

	async function refresh() {
		refreshing = true;
		try {
			client.setQueryData(
				['github-repositories'],
				await fetchJson<GithubRepositoryList>('/api/v1/github/repositories?refresh=1')
			);
		} finally {
			refreshing = false;
		}
	}

	/** Most recently pushed first, as on GitHub's own "Recent" list. */
	const visible = $derived.by(() => {
		const list = (repos.data?.repositories ?? []).filter((repo) => !repo.archived);
		const needle = filter.trim().toLowerCase();
		return (needle ? list.filter((repo) => repo.fullName.toLowerCase().includes(needle)) : list)
			.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''))
			.slice(0, 100);
	});

	function importHref(fullName: string): string {
		return `${resolve('/(dashboard)/new/github')}?repo=${encodeURIComponent(fullName)}`;
	}

	// ------------------------------------------------------------- step 2: configure and deploy

	// The editable fields. A fresh detection (new root directory or branch) refills the build
	// settings; a refused submit keeps what was typed.
	const kept = untrack(() => result?.values);

	/** What the detection asks GitHub about; the form re-detects when one changes. */
	let rootDir = $state(kept?.rootDir ?? '.');
	let branch = $state(kept?.branch ?? '');

	// Picking another repository (same page, new `?repo=`) starts from its root again.
	let currentRepo = untrack(() => data.repo);
	$effect(() => {
		const repo = data.repo;
		untrack(() => {
			if (repo === currentRepo) return;
			currentRepo = repo;
			rootDir = '.';
			branch = '';
		});
	});

	const detection = createQuery(() => ({
		queryKey: ['github-detect', data.repo, branch, rootDir] as const,
		queryFn: ({ signal }) => {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-off query string, not state
			const params = new URLSearchParams({ repository: data.repo ?? '', rootDir });
			if (branch) params.set('branch', branch);
			return fetchJson<GithubImportDetection>(`/api/v1/github/detect?${params}`, {
				signal,
				fallback: 'Could not read the repository'
			});
		},
		enabled: browser && Boolean(data.repo),
		staleTime: 5 * 60_000,
		retry: false,
		placeholderData: (previous: GithubImportDetection | undefined) => previous
	}));

	let name = $state(kept?.name ?? '');
	let slug = $state(kept?.slug ?? '');
	let framework = $state<FrameworkId>((kept?.framework as FrameworkId) || 'other');
	let runtime = $state<'static' | 'process'>(kept?.runtime === 'process' ? 'process' : 'static');
	let buildCommand = $state(kept?.buildCommand ?? '');
	let outputDir = $state(kept?.outputDir ?? '');
	let command = $state(kept?.command ?? '');
	let engine = $state(kept?.engine ?? '');
	let port = $state(kept?.port ?? '');
	let envText = $state(kept?.env ?? '');
	let productionAccess = $state(kept?.productionAccess ?? 'public');
	let previewAccess = $state(kept?.previewAccess ?? 'platform');
	let pipelines = $state(true);
	let settingsOpen = $state(Boolean(kept));
	let pending = $state(false);
	/** The detection last applied to the fields, and the name it suggested. */
	let applied: string | null = kept ? 'kept' : null;
	let suggested = '';

	function applyPreset(id: FrameworkId) {
		const preset = FRAMEWORK_PRESETS[id];
		framework = id;
		runtime = preset.runtime;
		buildCommand = preset.buildCommand;
		outputDir = preset.outputDir;
		command = preset.command?.join(' ') ?? '';
		engine = preset.engine ?? '';
		port = preset.port ? String(preset.port) : '';
	}

	$effect(() => {
		const found = detection.data;
		if (!found) return;
		const key = `${found.repository.fullName}:${found.branch}:${found.rootDir}`;
		untrack(() => {
			if (applied === key) return;
			const restoring = applied === 'kept';
			applied = key;
			// After a refused submit the typed values stay; only later detections refill them.
			if (restoring) return;
			applyPreset(found.preset.id);
			// A name the person typed is kept; one Skiff suggested follows the root directory.
			if (!name || name === suggested) name = found.suggestedName;
			suggested = found.suggestedName;
			pipelines = found.workflows.length > 0;
		});
	});

	const found = $derived(detection.data);
	const detectedId = $derived(found?.preset.id ?? null);
	const parentDir = $derived(
		rootDir === '.' ? null : rootDir.split('/').slice(0, -1).join('/') || '.'
	);
	const slugPreview = $derived(
		slug ||
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-+|-+$/g, '')
				.slice(0, 40) ||
			'project'
	);

	const ENV_PLACEHOLDER = 'DATABASE_URL=postgres://…\nLOG_LEVEL=info';

	const steps = $derived([
		{
			title: 'Project',
			detail: `${slugPreview} · ${runtime === 'static' ? 'static files' : 'process app'}`
		},
		{
			title: 'Git source',
			detail: `${branch || found?.branch || '…'} · ${rootDir === '.' ? 'repository root' : rootDir}`
		},
		{ title: 'First build', detail: 'Queued now, promoted when it succeeds' },
		...(found && found.workflows.length > 0 && pipelines
			? [
					{
						title: 'Pipelines',
						detail: `${found.workflows.length} workflow${found.workflows.length === 1 ? '' : 's'} on push`
					}
				]
			: [])
	]);

	function enterDir(dir: string) {
		rootDir = rootDir === '.' ? dir : `${rootDir}/${dir}`;
	}

	function commitBranch(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value.trim();
		if (value && value !== branch) branch = value;
	}

	function commitRootDir(event: Event) {
		const value = (event.currentTarget as HTMLInputElement).value
			.trim()
			.replace(/^\.\/+/, '')
			.replace(/\/+$/, '');
		rootDir = value || '.';
	}
</script>

<svelte:head>
	<title>Deploy from GitHub · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader
		target="page.new-github"
		eyebrow="New project"
		title={data.repo ? `Deploy ${data.repo}` : 'Deploy from GitHub'}
		description={data.repo
			? 'Skiff read the repository and picked how to build it. Adjust anything, then deploy. Every push to the branch deploys again.'
			: 'Import a repository through Skiff’s GitHub App. Each push builds and deploys it, with a commit status and a GitHub deployment for every build.'}
	>
		{#if data.repo}
			<Button variant="outline" href={resolve('/(dashboard)/new/github')}>
				<ArrowLeftIcon />All repositories
			</Button>
		{:else}
			<Button variant="outline" href={resolve('/(dashboard)/new')}>
				<ArrowLeftIcon />Other ways to start
			</Button>
		{/if}
	</PageHeader>

	{#if !data.canImport}
		<Notice tone="warning" title="You cannot create projects here">
			Deploying a repository needs permission to create projects and builds. Ask an owner or admin.
		</Notice>
	{/if}

	{#if !data.app.configured}
		<EmptyState
			icon={GitHubMark}
			title="Connect GitHub first"
			description="A platform admin creates Skiff’s GitHub App once, in Settings → GitHub. After that, anyone who can create projects can deploy repositories from here."
		>
			<Button href={resolve('/(dashboard)/settings/github')}>
				<GitHubMark />Open Settings → GitHub
			</Button>
		</EmptyState>
	{:else if !data.connected}
		<EmptyState
			icon={GitHubMark}
			title="Install Skiff’s GitHub App"
			description="Install the App on your GitHub account or organisation and choose which repositories Skiff may build. They appear here right after."
		>
			{#if data.canInstall && data.app.installUrl}
				<!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL -->
				<Button href={data.app.installUrl}><GitHubMark />Install on GitHub</Button>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			{:else}
				<p class="text-sm text-muted-foreground">
					Ask an organisation owner or admin to install it.
				</p>
			{/if}
			<Button variant="outline" href={resolve('/(dashboard)/settings/github')}
				>Settings → GitHub</Button
			>
		</EmptyState>
	{:else if !data.repo}
		{@render repositoryList()}
	{:else}
		{@render configure(data.repo)}
	{/if}
</div>

{#snippet repositoryList()}
	<section
		class="overflow-hidden rounded-xl border bg-card shadow-xs"
		aria-labelledby="repos-heading"
	>
		<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
			<h2 id="repos-heading" class="flex items-center gap-2 text-sm font-semibold">
				<GitHubMark class="size-4" />Import a repository
			</h2>
			<div class="ml-auto flex w-full items-center gap-2 sm:w-auto">
				<InputGroup.Root class="w-full bg-background sm:w-72">
					<InputGroup.Input
						placeholder="Search repositories"
						bind:value={filter}
						aria-label="Search repositories"
					/>
					<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				</InputGroup.Root>
				<Button
					size="icon-sm"
					variant="ghost"
					onclick={refresh}
					disabled={refreshing}
					aria-label="Refresh the list"
				>
					{#if refreshing}<Spinner />{:else}<RefreshCwIcon />{/if}
				</Button>
			</div>
		</header>

		{#if repos.isPending}
			<ul class="divide-y">
				{#each [0, 1, 2, 3] as row (row)}
					<li class="flex items-center gap-3 px-4 py-3">
						<Skeleton class="size-5 rounded-full" />
						<Skeleton class="h-4 w-56" />
						<Skeleton class="ml-auto h-8 w-20" />
					</li>
				{/each}
			</ul>
		{:else if repos.isError}
			<p class="px-4 py-6 text-sm text-destructive">{errorText(repos.error)}</p>
		{:else}
			<ul class="max-h-[32rem] divide-y overflow-y-auto">
				{#each visible as repo (repo.id)}
					{@const existing = data.imported[repo.fullName.toLowerCase()]}
					<li class="flex items-center gap-3 px-4 py-3">
						<GitHubMark class="size-5 shrink-0 text-muted-foreground" />
						<div class="min-w-0 flex-1">
							<p class="flex items-center gap-1.5 text-sm font-medium">
								<span class="truncate">{repo.fullName}</span>
								{#if repo.private}<LockIcon
										class="size-3 shrink-0 text-muted-foreground"
										aria-label="private"
									/>{/if}
							</p>
							<p class="flex items-center gap-1 text-xs text-muted-foreground">
								<GitBranchIcon class="size-3" />{repo.defaultBranch}
								{#if repo.pushedAt}<span aria-hidden="true">·</span> pushed {formatRelative(
										repo.pushedAt
									)}{/if}
							</p>
						</div>
						{#if existing}
							<a
								href={resolve('/(dashboard)/projects/[slug]', { slug: existing })}
								class="hidden text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:inline"
								>Deploys {existing}</a
							>
						{/if}
						<!-- eslint-disable svelte/no-navigation-without-resolve -- resolved route plus a query string -->
						<Button
							size="sm"
							variant={existing ? 'outline' : 'default'}
							href={importHref(repo.fullName)}
							disabled={!data.canImport}>Import</Button
						>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</li>
				{:else}
					<li class="px-4 py-6 text-sm text-muted-foreground">
						{filter ? 'No repository matches.' : 'The App cannot see any repositories yet.'}
					</li>
				{/each}
			</ul>
			<footer class="border-t px-4 py-2.5 text-xs text-muted-foreground">
				{#if repos.data?.truncated}Showing the first 500 repositories.
				{/if}
				Missing a repository?
				{#if repos.data?.manageUrl}
					<!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL -->
					<a
						class="underline underline-offset-2 hover:text-foreground"
						href={repos.data.manageUrl}
						target="_blank"
						rel="noreferrer">Grant the GitHub App access</a
					>, then refresh.
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
				{/if}
				{#if repos.data?.error}<span class="text-destructive"> {repos.data.error}</span>{/if}
			</footer>
		{/if}
	</section>
{/snippet}

{#snippet configure(repository: string)}
	<div
		class="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
	>
		<form
			method="POST"
			action="?/import"
			class="min-w-0 space-y-6"
			aria-label="Configure {repository}"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
				};
			}}
		>
			<input type="hidden" name="repository" value={found?.repository.fullName ?? repository} />
			<input type="hidden" name="framework" value={framework} />

			{#if result?.message}
				<Notice tone="danger" title="Not deployed">{result.message}</Notice>
			{/if}

			<section class="space-y-4 rounded-xl border bg-card p-5 shadow-xs">
				<header class="flex items-start gap-3">
					<span
						class="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background"
					>
						<GitHubMark class="size-5" />
					</span>
					<div class="min-w-0 flex-1">
						<h2 class="flex items-center gap-1.5 font-semibold">
							<span class="truncate">{found?.repository.fullName ?? repository}</span>
							{#if found?.repository.private}<LockIcon
									class="size-3.5 text-muted-foreground"
									aria-label="private"
								/>{/if}
						</h2>
						{#if found}
							<!-- eslint-disable svelte/no-navigation-without-resolve -- external GitHub URL -->
							<a
								href={found.repository.htmlUrl}
								target="_blank"
								rel="noreferrer"
								class="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
								>View on GitHub<ArrowUpRightIcon class="size-3" /></a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
						{/if}
					</div>
					{#if detection.isFetching}<Spinner class="mt-1 size-4 text-muted-foreground" />{/if}
				</header>

				{#if detection.isError}
					<Notice tone="danger" title="Skiff could not read this repository">
						{errorText(detection.error)}
					</Notice>
				{/if}

				<Field.Group>
					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={errors.name ? true : undefined}>
							<Field.Label for="import-name">Project name</Field.Label>
							<Input
								id="import-name"
								name="name"
								bind:value={name}
								maxlength={120}
								required
								aria-invalid={errors.name ? 'true' : undefined}
							/>
							{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
						</Field.Field>
						<Field.Field data-invalid={errors.slug ? true : undefined}>
							<Field.Label for="import-slug">
								Slug <span class="font-normal text-muted-foreground">optional</span>
							</Field.Label>
							<Input
								id="import-slug"
								name="slug"
								bind:value={slug}
								placeholder={slugPreview}
								maxlength={40}
								autocapitalize="off"
								spellcheck="false"
								class="font-mono text-sm"
								aria-invalid={errors.slug ? 'true' : undefined}
							/>
							{#if errors.slug}<Field.Error>{errors.slug}</Field.Error>{/if}
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
					</div>

					<div class="grid gap-4 sm:grid-cols-2">
						<Field.Field data-invalid={errors.framework ? true : undefined}>
							<Field.Label for="import-framework">Framework preset</Field.Label>
							<NativeSelect.Root
								id="import-framework"
								value={framework}
								onchange={(event) =>
									applyPreset((event.currentTarget as HTMLSelectElement).value as FrameworkId)}
								class="w-full"
							>
								{#each frameworkIds as id (id)}
									<NativeSelect.Option value={id}
										>{FRAMEWORK_PRESETS[id].label}{id === detectedId
											? ' (detected)'
											: ''}</NativeSelect.Option
									>
								{/each}
							</NativeSelect.Root>
							<Field.Description>
								{#if found && framework === detectedId}
									<span class="inline-flex items-center gap-1"
										><SparklesIcon class="size-3" />Detected from {found.rootDir === '.'
											? 'the repository root'
											: found.rootDir}.</span
									>
								{:else}
									Sets the build command, output directory and runtime below.
								{/if}
							</Field.Description>
						</Field.Field>
						<Field.Field data-invalid={errors.branch ? true : undefined}>
							<Field.Label for="import-branch">Production branch</Field.Label>
							<Input
								id="import-branch"
								name="branch"
								value={branch || found?.branch || ''}
								onchange={commitBranch}
								placeholder={found?.repository.defaultBranch ?? 'main'}
								spellcheck="false"
								class="font-mono text-sm"
								aria-invalid={errors.branch ? 'true' : undefined}
							/>
							<Field.Description>Pushes here build and go live.</Field.Description>
						</Field.Field>
					</div>

					<Field.Field data-invalid={errors.rootDir ? true : undefined}>
						<Field.Label for="import-root">Root directory</Field.Label>
						<Input
							id="import-root"
							name="rootDir"
							value={rootDir}
							onchange={commitRootDir}
							spellcheck="false"
							class="font-mono text-sm"
							aria-invalid={errors.rootDir ? 'true' : undefined}
						/>
						{#if found && (found.directories.length > 0 || parentDir)}
							<div class="flex flex-wrap gap-1.5">
								{#if parentDir}
									<Button
										type="button"
										size="xs"
										variant="ghost"
										onclick={() => (rootDir = parentDir!)}
									>
										<CornerLeftUpIcon />Up
									</Button>
								{/if}
								{#each found.directories.slice(0, 12) as dir (dir)}
									<Button
										type="button"
										size="xs"
										variant="outline"
										class="font-mono"
										onclick={() => enterDir(dir)}><FolderIcon />{dir}</Button
									>
								{/each}
							</div>
						{/if}
						<Field.Description>
							For monorepos: the directory with the app. Skiff detects the framework again when it
							changes.
						</Field.Description>
						{#if errors.rootDir}<Field.Error>{errors.rootDir}</Field.Error>{/if}
					</Field.Field>
				</Field.Group>
			</section>

			<Collapsible.Root bind:open={settingsOpen} class="rounded-xl border bg-card shadow-xs">
				<Collapsible.Trigger
					class="flex w-full items-center gap-2 px-5 py-3.5 text-left text-sm font-semibold"
				>
					Build and output settings
					<span class="truncate font-mono text-xs font-normal text-muted-foreground">
						{buildCommand || '…'} → {outputDir || '…'}
					</span>
					<ChevronDownIcon
						class="ml-auto size-4 shrink-0 transition-transform {settingsOpen ? 'rotate-180' : ''}"
					/>
				</Collapsible.Trigger>
				<Collapsible.Content class="border-t px-5 py-4">
					<Field.Group>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field.Field>
								<Field.Label for="import-runtime">Runtime</Field.Label>
								<NativeSelect.Root
									id="import-runtime"
									name="runtime"
									bind:value={runtime}
									class="w-full"
								>
									<NativeSelect.Option value="static">Static files</NativeSelect.Option>
									<NativeSelect.Option value="process">Process app (Bun/Node)</NativeSelect.Option>
								</NativeSelect.Root>
								<Field.Description>
									{runtime === 'static'
										? 'The output directory is served by Caddy.'
										: 'The output directory is the release; the start command runs in it.'}
								</Field.Description>
							</Field.Field>
							<Field.Field data-invalid={errors.outputDir ? true : undefined}>
								<Field.Label for="import-output">Output directory</Field.Label>
								<Input
									id="import-output"
									name="outputDir"
									bind:value={outputDir}
									spellcheck="false"
									class="font-mono text-sm"
									aria-invalid={errors.outputDir ? 'true' : undefined}
								/>
								<Field.Description>Relative to the root directory.</Field.Description>
								{#if errors.outputDir}<Field.Error>{errors.outputDir}</Field.Error>{/if}
							</Field.Field>
						</div>
						<Field.Field data-invalid={errors.buildCommand ? true : undefined}>
							<Field.Label for="import-build">Build command</Field.Label>
							<Input
								id="import-build"
								name="buildCommand"
								bind:value={buildCommand}
								required
								spellcheck="false"
								class="font-mono text-sm"
								aria-invalid={errors.buildCommand ? 'true' : undefined}
							/>
							<Field.Description>
								Runs on a Builder node with Bun. Bun reads npm, Yarn and pnpm lockfiles.
							</Field.Description>
							{#if errors.buildCommand}<Field.Error>{errors.buildCommand}</Field.Error>{/if}
						</Field.Field>
						{#if runtime === 'process'}
							<div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem_7rem]">
								<Field.Field data-invalid={errors.command ? true : undefined}>
									<Field.Label for="import-command">
										Start command <span class="font-normal text-muted-foreground">optional</span>
									</Field.Label>
									<Input
										id="import-command"
										name="command"
										bind:value={command}
										placeholder={engine === 'node' ? 'npm start (package.json)' : 'bun run start'}
										spellcheck="false"
										class="font-mono text-sm"
										aria-invalid={errors.command ? 'true' : undefined}
									/>
									{#if errors.command}<Field.Error>{errors.command}</Field.Error>{/if}
								</Field.Field>
								<Field.Field>
									<Field.Label for="import-engine">Engine</Field.Label>
									<NativeSelect.Root
										id="import-engine"
										name="engine"
										bind:value={engine}
										class="w-full"
									>
										<NativeSelect.Option value="">Bun</NativeSelect.Option>
										<NativeSelect.Option value="node">Node.js</NativeSelect.Option>
									</NativeSelect.Root>
								</Field.Field>
								<Field.Field data-invalid={errors.port ? true : undefined}>
									<Field.Label for="import-port">Port</Field.Label>
									<Input
										id="import-port"
										name="port"
										type="number"
										min={1}
										max={65535}
										bind:value={port}
										placeholder="3000"
										class="font-mono text-sm"
									/>
								</Field.Field>
							</div>
							<Field.Field data-invalid={errors.env ? true : undefined}>
								<Field.Label for="import-env">
									Environment variables <span class="font-normal text-muted-foreground"
										>optional</span
									>
								</Field.Label>
								<Textarea
									id="import-env"
									name="env"
									bind:value={envText}
									rows={3}
									placeholder={ENV_PLACEHOLDER}
									spellcheck="false"
									class="font-mono text-xs"
								/>
								<Field.Description>
									One <code class="font-mono">NAME=value</code> per line. Add secrets on the project’s
									Variables tab afterwards.
								</Field.Description>
								{#if errors.env}<Field.Error>{errors.env}</Field.Error>{/if}
							</Field.Field>
						{/if}
						<div class="grid gap-4 sm:grid-cols-2">
							<Field.Field>
								<Field.Label for="import-prod-access">Production access</Field.Label>
								<NativeSelect.Root
									id="import-prod-access"
									name="productionAccess"
									bind:value={productionAccess}
									class="w-full"
								>
									<NativeSelect.Option value="public">Public</NativeSelect.Option>
									<NativeSelect.Option value="platform">Skiff login</NativeSelect.Option>
								</NativeSelect.Root>
							</Field.Field>
							<Field.Field>
								<Field.Label for="import-preview-access">Preview access</Field.Label>
								<NativeSelect.Root
									id="import-preview-access"
									name="previewAccess"
									bind:value={previewAccess}
									class="w-full"
								>
									<NativeSelect.Option value="platform">Skiff login</NativeSelect.Option>
									<NativeSelect.Option value="public">Public</NativeSelect.Option>
								</NativeSelect.Root>
							</Field.Field>
						</div>
					</Field.Group>
				</Collapsible.Content>
			</Collapsible.Root>

			{#if found && found.workflows.length > 0}
				<Field.Field orientation="horizontal" class="rounded-xl border bg-card p-4 shadow-xs">
					<Checkbox id="import-pipelines" name="pipelines" value="1" bind:checked={pipelines} />
					<div class="space-y-0.5">
						<Field.Label for="import-pipelines" class="flex items-center gap-1.5">
							<WorkflowIcon class="size-4 text-muted-foreground" />Run its workflows in Pipelines
						</Field.Label>
						<Field.Description>
							{found.workflows.length === 1
								? 'One workflow'
								: `${found.workflows.length} workflows`} in
							<code class="font-mono">.skiff/workflows</code>
							({found.workflows.slice(0, 3).join(', ')}{found.workflows.length > 3 ? ', …' : ''})
							run on push and pull request, delivered by the GitHub App.
						</Field.Description>
					</div>
				</Field.Field>
			{/if}

			<div class="flex flex-wrap items-center gap-3">
				<Button
					type="submit"
					size="lg"
					disabled={pending || !data.canImport || !buildCommand || (!found && !result)}
				>
					{#if pending}<Spinner />{:else}<RocketIcon />{/if}
					Deploy
				</Button>
				<Button
					variant="ghost"
					type="button"
					onclick={() => goto(resolve('/(dashboard)/new/github'))}>Cancel</Button
				>
			</div>
		</form>

		<aside class="space-y-4 lg:sticky lg:top-20">
			<div class="rounded-xl border bg-card p-5 shadow-xs">
				<h2 class="mb-3 text-sm font-semibold">What happens</h2>
				<ol class="space-y-3 text-sm">
					{#each steps as step, index (step.title)}
						<li class="flex gap-3">
							<span
								class="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-semibold text-muted-foreground tabular-nums"
								>{index + 1}</span
							>
							<span class="min-w-0">
								<span class="block font-medium">{step.title}</span>
								<span class="block truncate font-mono text-xs text-muted-foreground"
									>{step.detail}</span
								>
							</span>
						</li>
					{/each}
				</ol>
			</div>
			<div class="space-y-2 rounded-xl border border-dashed p-4 text-xs text-muted-foreground">
				<p class="flex items-center gap-1.5 font-medium text-foreground">
					<GitHubMark class="size-3.5" />Nothing to set up on GitHub
				</p>
				<p class="text-pretty">
					The GitHub App delivers pushes, Builders clone with a one-hour token, and every build
					reports a commit status and a GitHub deployment. No webhook or deploy key.
				</p>
				{#if found?.hasDockerfile}
					<p class="text-pretty">
						This repository has a Dockerfile. To run it as a container, build the image in a
						pipeline and deploy it to a container project.
					</p>
				{/if}
			</div>
			{#if detection.isPending && !result}
				<div class="flex items-center gap-2 text-xs text-muted-foreground">
					<Spinner class="size-3" />Reading {repository}…
				</div>
			{/if}
			{#if found}
				<p class="flex items-center gap-1 text-xs text-muted-foreground">
					<Badge variant="neutral">{found.preset.label}</Badge>
					detected
					<ArrowRightIcon class="size-3" />
					<span class="font-mono">{found.preset.outputDir}</span>
				</p>
			{/if}
		</aside>
	</div>
{/snippet}
