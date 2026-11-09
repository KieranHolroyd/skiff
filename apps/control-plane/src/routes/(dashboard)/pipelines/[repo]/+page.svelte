<script lang="ts">
	import { browser } from '$app/env';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PlayIcon from '@lucide/svelte/icons/play';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import DataTable, { type DataColumn } from '#lib/components/yoal/DataTable.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText } from '#lib/query.js';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative, shortSha } from '../../_lib/format.js';
	import { listRuns, listTriggers, pipelineKeys } from '../_lib/api.js';
	import RepoTabs from '../_lib/RepoTabs.svelte';
	import SetupSteps from '../_lib/SetupSteps.svelte';
	import StateBadge from '../_lib/StateBadge.svelte';
	import { anyActive, EVENT_LABEL, runDuration, shortRef } from '../_lib/status.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const repo = $derived(data.repository.name);
	const queryClient = useQueryClient();

	const triggers = createQuery(() => ({
		queryKey: pipelineKeys.triggers(repo),
		queryFn: ({ signal }) => listTriggers(repo, signal),
		initialData: data.triggers,
		enabled: browser,
		refetchInterval: (query) =>
			(query.state.data ?? []).some((trigger) => trigger.status === 'resolving') ? 3_000 : false
	}));
	const resolving = $derived((triggers.data ?? []).some((trigger) => trigger.status === 'resolving'));

	const runs = createQuery(() => ({
		queryKey: pipelineKeys.runs(repo, data.filter.status, data.filter.workflow),
		queryFn: ({ signal }) => listRuns(repo, data.filter, signal),
		initialData: data.runs,
		enabled: browser,
		// Poll while a run is going (or a dispatch is still being read), stop once all are done.
		refetchInterval: (query) => (anyActive(query.state.data ?? []) || resolving ? 5_000 : false)
	}));
	const rows = $derived(runs.data ?? []);
	const problems = $derived((triggers.data ?? []).filter((trigger) => trigger.status !== 'resolved'));
	const filtered = $derived(Boolean(data.filter.status || data.filter.workflow));

	let dispatchOpen = $state(false);
	let inlineOpen = $state(false);

	function setFilter(key: 'status' | 'workflow', value: string) {
		const next = { ...data.filter, [key]: value };
		const params = new URLSearchParams();
		if (next.status) params.set('status', next.status);
		if (next.workflow) params.set('workflow', next.workflow);
		const href = resolve('/(dashboard)/pipelines/[repo]', { repo });
		const search = params.toString();
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolved route, only the query changes
		void goto(search ? `${href}?${search}` : href, { replace: true, reset: false });
	}

	type Row = (typeof rows)[number];
	const runHref = (run: Row) =>
		resolve('/(dashboard)/pipelines/[repo]/runs/[run]', { repo, run: String(run.number) });

	const columns: DataColumn<Row>[] = [
		{
			id: 'number',
			header: '#',
			value: (row) => row.number,
			descFirst: true,
			cell: numberCell,
			class: 'w-0 pl-4 font-mono text-xs tabular-nums'
		},
		{
			id: 'status',
			header: 'Status',
			value: (row) => (row.status === 'completed' ? (row.conclusion ?? 'completed') : row.status),
			cell: statusCell
		},
		{ id: 'title', header: 'Run', value: (row) => row.title, cell: titleCell },
		{
			id: 'event',
			header: 'Event',
			value: (row) => row.event,
			cell: eventCell,
			class: 'hidden text-xs text-muted-foreground lg:table-cell'
		},
		{
			id: 'ref',
			header: 'Ref',
			value: (row) => shortRef(row.ref),
			cell: refCell,
			class: 'hidden font-mono text-xs md:table-cell'
		},
		{
			id: 'actor',
			header: 'Actor',
			value: (row) => row.actor ?? '',
			cell: actorCell,
			class: 'hidden text-xs text-muted-foreground xl:table-cell'
		},
		{
			id: 'duration',
			header: 'Duration',
			value: (row) =>
				row.startedAt ? new Date(row.finishedAt ?? Date.now()).getTime() - new Date(row.startedAt).getTime() : -1,
			searchable: false,
			descFirst: true,
			cell: durationCell,
			class: 'hidden font-mono text-xs tabular-nums sm:table-cell'
		},
		{
			id: 'created',
			header: 'Created',
			value: (row) => row.createdAt,
			searchable: false,
			descFirst: true,
			cell: createdCell,
			class: 'pr-4 text-xs text-muted-foreground'
		}
	];
</script>

<svelte:head>
	<title>{repo} · Pipelines · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Pipelines" title={repo} bordered={false}>
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span class="font-mono">{data.repository.cloneUrl}</span>
				<Badge variant="outline" class="font-mono font-normal"
					><GitBranchIcon />{data.repository.defaultBranch}</Badge
				>
				{#if !data.repository.enabled}<Badge variant="neutral">Disabled</Badge>{/if}
			</div>
		{/snippet}
		{#if data.can.run && data.repository.enabled}
			<Button onclick={() => (dispatchOpen = true)}><PlayIcon />Run workflow</Button>
		{/if}
	</PageHeader>

	<RepoTabs {repo} current="runs" />

	{#if !data.repository.enabled}
		<Notice tone="warning" title="This repository is disabled">
			Webhooks and schedules are ignored until it is enabled again in Settings.
		</Notice>
	{/if}

	{#if problems.length > 0}
		<Panel title="Triggers" icon={CircleAlertIcon} flush description="Pushes and dispatches that have not become runs.">
			<ul class="divide-y">
				{#each problems as trigger (trigger.id)}
					<li class="flex items-start gap-3 px-6 py-2.5 text-sm">
						{#if trigger.status === 'resolving'}
							<LoaderCircleIcon class="mt-0.5 size-4 shrink-0 animate-spin text-info" />
						{:else}
							<CircleAlertIcon class="mt-0.5 size-4 shrink-0 text-destructive" />
						{/if}
						<div class="min-w-0 flex-1">
							<p>
								{EVENT_LABEL[trigger.event] ?? trigger.event} on
								<span class="font-mono">{shortRef(trigger.ref)}</span>
								<span class="text-muted-foreground">
									· {trigger.status === 'resolving' ? 'reading workflows on a build node' : 'failed'}</span
								>
							</p>
							{#if trigger.error}
								<p class="font-mono text-xs break-words whitespace-pre-wrap text-destructive">
									{trigger.error}
								</p>
							{/if}
						</div>
						<time class="shrink-0 text-xs text-muted-foreground" datetime={trigger.createdAt}
							>{formatRelative(trigger.createdAt)}</time
						>
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}

	{#if rows.length === 0 && !filtered}
		<Panel title="Set up" icon={WorkflowIcon} description="No runs yet. Three steps to the first one.">
			<SetupSteps
				hasRepository
				webhookUrl={data.webhookUrl}
				defaultBranch={data.repository.defaultBranch}
				viaGithubApp={data.coverage
					? data.coverage.status === 'covered'
					: Boolean(data.repository.githubAppInstallationId)}
				viaForge={data.repository.provider !== 'github' && data.repository.gitProvider?.delivered
					? (data.repository.gitProvider.via ?? 'the forge')
					: null}
				forgeMissing={data.forgeCoverage?.status === 'not-hooked'
					? { name: data.forgeCoverage.connectionName ?? 'the forge', error: data.forgeCoverage.error, canCreate: data.can.manage }
					: null}
				coverage={data.coverage?.status ?? null}
				manageUrl={data.coverage?.manageUrl ?? null}
				owner={data.coverage?.fullName?.split('/')[0] ?? null}
			/>
		</Panel>
	{:else}
		<div class="flex flex-wrap items-center gap-3">
			<NativeSelect.Root
				value={data.filter.status}
				onchange={(event) => setFilter('status', event.currentTarget.value)}
				aria-label="Filter by status"
				class="w-40 bg-card"
			>
				<NativeSelect.Option value="">All statuses</NativeSelect.Option>
				<NativeSelect.Option value="queued">Queued</NativeSelect.Option>
				<NativeSelect.Option value="in_progress">In progress</NativeSelect.Option>
				<NativeSelect.Option value="completed">Completed</NativeSelect.Option>
			</NativeSelect.Root>
			<NativeSelect.Root
				value={data.filter.workflow}
				onchange={(event) => setFilter('workflow', event.currentTarget.value)}
				aria-label="Filter by workflow"
				class="w-56 bg-card"
			>
				<NativeSelect.Option value="">All workflows</NativeSelect.Option>
				{#each data.workflows as workflow (workflow.path)}
					<NativeSelect.Option value={workflow.path}>{workflow.name}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<p class="ml-auto text-sm text-muted-foreground">
				{#if runs.error}
					<span class="text-destructive">{errorText(runs.error)}</span>
				{:else}
					{rows.length}
					{rows.length === 1 ? 'run' : 'runs'}
				{/if}
			</p>
		</div>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			<DataTable
				label="Runs of {repo}"
				{rows}
				{columns}
				rowId={(row) => row.id}
				sort={{ id: 'number', desc: true }}
			>
				{#snippet empty(_search: string)}
					No runs match these filters.
				{/snippet}
			</DataTable>
		</div>
	{/if}
</div>

{#if data.can.run}
	<FormDialog
		bind:open={dispatchOpen}
		icon={PlayIcon}
		title="Run workflow"
		description="Runs a workflow from the repository at a branch, tag or commit."
		action="?/dispatch"
		submitLabel="Run"
		size="lg"
		onsuccess={() => void queryClient.invalidateQueries({ queryKey: pipelineKeys.repo(repo) })}
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="dispatch-workflow">Workflow</Field.Label>
					<Input
						id="dispatch-workflow"
						name="workflow"
						placeholder="ci.yml"
						list="dispatch-workflows"
						disabled={inlineOpen}
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<datalist id="dispatch-workflows">
						{#each data.workflows as workflow (workflow.path)}
							<option value={workflow.path}>{workflow.name}</option>
						{/each}
					</datalist>
					<Field.Description>A file in .yoal/workflows, by name or path.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="dispatch-ref">Ref</Field.Label>
					<Input
						id="dispatch-ref"
						name="ref"
						placeholder={data.repository.defaultBranch}
						spellcheck="false"
						class="font-mono text-sm"
					/>
					<Field.Description>Branch, tag or SHA. Defaults to {data.repository.defaultBranch}.</Field.Description>
				</Field.Field>
			</div>
			<Field.Field>
				<Field.Label for="dispatch-inputs">
					Inputs <span class="font-normal text-muted-foreground">optional</span>
				</Field.Label>
				<Textarea
					id="dispatch-inputs"
					name="inputs"
					rows={3}
					placeholder={'promote=true\nenvironment=staging'}
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>One <code class="font-mono">key=value</code> per line.</Field.Description>
			</Field.Field>
			<Collapsible.Root bind:open={inlineOpen}>
				<Collapsible.Trigger
					class="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
				>
					<ChevronRightIcon class="size-4 transition-transform {inlineOpen ? 'rotate-90' : ''}" />
					Inline YAML instead
				</Collapsible.Trigger>
				<Collapsible.Content class="pt-3">
					<Field.Field>
						<Field.Label for="dispatch-yaml" class="sr-only">Workflow YAML</Field.Label>
						<Textarea
							id="dispatch-yaml"
							name="workflowText"
							rows={10}
							disabled={!inlineOpen}
							placeholder={'name: one-off\non: workflow_dispatch\njobs:\n  run:\n    runs-on: [linux]\n    steps:\n      - uses: actions/checkout@v4\n      - run: bun test'}
							spellcheck="false"
							class="font-mono text-xs"
						/>
						<Field.Description>Runs this YAML against the ref instead of a file in the repository.</Field.Description>
					</Field.Field>
				</Collapsible.Content>
			</Collapsible.Root>
		</Field.Group>
	</FormDialog>
{/if}

{#snippet numberCell(run: Row)}
	<a href={runHref(run)} class="text-muted-foreground hover:text-foreground">#{run.number}</a>
{/snippet}

{#snippet statusCell(run: Row)}
	<StateBadge status={run.status} conclusion={run.conclusion} />
{/snippet}

{#snippet titleCell(run: Row)}
	<div class="min-w-0 max-w-md">
		<a href={runHref(run)} class="block truncate font-medium underline-offset-4 hover:underline"
			>{run.title}</a
		>
		<p class="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
			{run.workflowName}
			{#if run.trust === 'untrusted'}<Badge variant="warning">untrusted</Badge>{/if}
			{#if run.attempt > 1}<span>· attempt {run.attempt}</span>{/if}
		</p>
	</div>
{/snippet}

{#snippet eventCell(run: Row)}
	{EVENT_LABEL[run.event] ?? run.event}
{/snippet}

{#snippet refCell(run: Row)}
	<span class="block">{shortRef(run.ref)}</span>
	<span class="block text-muted-foreground">{shortSha(run.sha, 7)}</span>
{/snippet}

{#snippet actorCell(run: Row)}
	{run.actor ?? '—'}
{/snippet}

{#snippet durationCell(run: Row)}
	{runDuration(run)}
{/snippet}

{#snippet createdCell(run: Row)}
	<time datetime={run.createdAt} title={formatDateTime(run.createdAt)}>{formatRelative(run.createdAt)}</time>
{/snippet}
