<script lang="ts">
	import { browser } from '$app/env';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import CheckIcon from '@lucide/svelte/icons/check';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitCommitIcon from '@lucide/svelte/icons/git-commit-horizontal';
	import PackageIcon from '@lucide/svelte/icons/package';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { errorText } from '#lib/query.js';
	import PageHeader from '../../../../_lib/PageHeader.svelte';
	import Panel from '../../../../_lib/Panel.svelte';
	import { formatBytes, formatDate, formatDateTime, shortSha } from '../../../../_lib/format.js';
	import { artifactHref, getRun, pipelineKeys } from '../../../_lib/api.js';
	import JobGraph from '../../../_lib/JobGraph.svelte';
	import JobLogs from '../../../_lib/JobLogs.svelte';
	import StateBadge from '../../../_lib/StateBadge.svelte';
	import StateIcon from '../../../_lib/StateIcon.svelte';
	import { elapsed, EVENT_LABEL, runDuration, shortRef } from '../../../_lib/status.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const queryClient = useQueryClient();
	const key = $derived(pipelineKeys.run(data.repo, data.run.id));
	const query = createQuery(() => ({
		queryKey: key,
		queryFn: ({ signal }) => getRun(data.repo, data.run.id, signal),
		initialData: data.run,
		enabled: browser,
		refetchInterval: (q) => {
			const run = q.state.data;
			if (!run) return false;
			return run.status !== 'completed' || run.jobs.some((job) => job.status !== 'completed') ? 3_000 : false;
		}
	}));
	const run = $derived(query.data ?? data.run);
	const completed = $derived(run.status === 'completed');
	const hasFailed = $derived(
		run.jobs.some((job) => job.conclusion === 'failure' || job.conclusion === 'cancelled' || job.conclusion === 'timed_out')
	);

	let picked = $state<string | null>(page.url.searchParams.get('job'));
	const selected = $derived.by(() => {
		const jobs = run.jobs;
		return (
			jobs.find((job) => job.id === picked) ??
			jobs.find((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out') ??
			jobs.find((job) => job.status === 'in_progress') ??
			jobs.find((job) => job.status === 'waiting') ??
			jobs[0] ??
			null
		);
	});

	function select(id: string) {
		picked = id;
		const url = new URL(page.url.href);
		url.searchParams.set('job', id);
		try {
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?job` changes
			replaceState(url, page.state);
		} catch {
			// Router not ready yet; the selection still applies.
		}
	}

	const refresh = () => queryClient.invalidateQueries({ queryKey: pipelineKeys.repo(data.repo) });
	let busy = $state('');

	async function act(action: string, fields: Record<string, string> = {}) {
		busy = `${action}:${fields.jobId ?? ''}:${fields.decision ?? fields.failedOnly ?? ''}`;
		try {
			await runAction(action, fields);
			await refresh();
		} finally {
			busy = '';
		}
	}

	function cancel() {
		askConfirm({
			title: `Cancel run #${run.number}?`,
			description: 'Queued jobs are dropped. Running jobs stop and run their always() steps.',
			confirmLabel: 'Cancel run',
			tone: 'danger',
			action: '?/cancel',
			onResult: () => void refresh()
		});
	}

	function entries(record: Record<string, unknown> | null | undefined): Array<[string, string]> {
		return Object.entries(record ?? {}).map(([name, value]) => [
			name,
			typeof value === 'string' ? value : JSON.stringify(value)
		]);
	}
</script>

<svelte:head>
	<title>{run.title} #{run.number} · {data.repo} · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="{data.repo} · {run.workflowName}" title={run.title}>
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
				<StateBadge status={run.status} conclusion={run.conclusion} />
				<span class="font-mono">#{run.number}</span>
				<span>{EVENT_LABEL[run.event] ?? run.event}</span>
				<span class="inline-flex items-center gap-1 font-mono"
					><GitBranchIcon class="size-3" />{shortRef(run.ref)}</span
				>
				<span class="inline-flex items-center gap-1 font-mono" title={run.sha}
					><GitCommitIcon class="size-3" />{shortSha(run.sha, 7)}</span
				>
				{#if run.actor}<span>by {run.actor}</span>{/if}
				{#if run.trust === 'untrusted'}
					<Badge variant="warning" title="Fork pull request: no secrets, no deploys">untrusted</Badge>
				{/if}
				{#if run.attempt > 1}<span>attempt {run.attempt}</span>{/if}
				<span class="font-mono tabular-nums">{runDuration(run)}</span>
				<span title={formatDateTime(run.createdAt)}>{run.workflowPath}</span>
			</div>
		{/snippet}
		{#if !completed && data.can.cancel}
			<Button variant="outline" onclick={cancel}><SquareIcon />Cancel</Button>
		{/if}
		{#if completed && data.can.run}
			{#if hasFailed}
				<Button
					variant="outline"
					disabled={busy !== ''}
					onclick={() => act('?/rerun', { failedOnly: 'true' })}
				>
					{#if busy.endsWith(':true')}<Spinner />{:else}<RotateCcwIcon />{/if}
					Re-run failed
				</Button>
			{/if}
			<Button disabled={busy !== ''} onclick={() => act('?/rerun', { failedOnly: 'false' })}>
				{#if busy.endsWith(':false')}<Spinner />{:else}<RotateCcwIcon />{/if}
				Re-run all
			</Button>
		{/if}
	</PageHeader>

	{#if query.error}
		<Notice tone="warning">Live updates paused: {errorText(query.error)}</Notice>
	{/if}

	{#if run.error}
		<Notice tone="danger" title="This run could not start">
			<pre class="font-mono text-xs break-words whitespace-pre-wrap">{run.error}</pre>
		</Notice>
	{/if}

	{#if entries(run.inputs).length > 0}
		<dl class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
			{#each entries(run.inputs) as [name, value] (name)}
				<div class="flex gap-1.5">
					<dt class="text-muted-foreground">{name}</dt>
					<dd class="font-mono">{value}</dd>
				</div>
			{/each}
		</dl>
	{/if}

	{#if run.jobs.length > 0}
		<JobGraph jobs={run.jobs} selected={selected?.id ?? null} onselect={select} />
	{:else if !run.error}
		<p class="text-sm text-muted-foreground">No jobs yet.</p>
	{/if}

	{#if selected}
		{@const job = selected}
		<section class="space-y-4" aria-label="Job {job.name}">
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
				<StateIcon status={job.status} conclusion={job.conclusion} class="size-5" />
				<h2 class="text-lg font-semibold">{job.name}</h2>
				<StateBadge status={job.status} conclusion={job.conclusion} />
				<span class="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
					{#if job.nodeName ?? job.nodeId}<span>on <span class="font-mono">{job.nodeName ?? job.nodeId}</span></span>{/if}
					{#if job.environment}<span>environment <span class="font-mono">{job.environment}</span></span>{/if}
					{#if job.runtime && job.runtime !== 'runc'}<span>isolation <span class="font-mono">{job.runtime === 'runsc' ? 'gVisor' : job.runtime === 'kata' ? 'microVM' : job.runtime}</span></span>{/if}
					{#if job.attempt > 1}<span>attempt {job.attempt}</span>{/if}
					{#if job.startedAt}<span class="font-mono tabular-nums">{elapsed(job.startedAt, job.finishedAt)}</span>{/if}
				</span>
			</div>

			{#if job.status === 'queued'}
				<Notice tone="info">
					Waiting for a build node with labels:
					{#each job.runsOn as label (label)}<Badge variant="outline" class="ml-1 font-mono font-normal">{label}</Badge>{:else}
						any{/each}. Nodes need the Builder role.
				</Notice>
			{:else if job.status === 'waiting'}
				<Notice tone="warning" title="Waiting for approval">
					<p>
						This job deploys to <span class="font-mono">{job.environment ?? 'an environment'}</span>, which
						requires an owner or admin to approve it.
					</p>
					{#if data.can.approve}
						<div class="mt-3 flex gap-2">
							<Button
								size="sm"
								disabled={busy !== ''}
								onclick={() => act('?/approve', { jobId: job.id, decision: 'approve' })}
							>
								<CheckIcon />Approve
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={busy !== ''}
								onclick={() => act('?/approve', { jobId: job.id, decision: 'reject' })}
							>
								<XIcon />Reject
							</Button>
						</div>
					{/if}
				</Notice>
			{:else if job.status === 'pending'}
				<p class="text-sm text-muted-foreground">
					Waiting for {job.needs.join(', ') || 'earlier jobs'}.
				</p>
			{/if}

			{#if job.error}
				<Notice tone="danger">{job.error}</Notice>
			{/if}

			{#if job.matrix || entries(job.outputs).length > 0}
				<dl class="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
					{#each entries(job.matrix) as [name, value] (`m-${name}`)}
						<dt class="text-muted-foreground">matrix.{name}</dt>
						<dd class="truncate font-mono">{value}</dd>
					{/each}
					{#each entries(job.outputs) as [name, value] (`o-${name}`)}
						<dt class="text-muted-foreground">outputs.{name}</dt>
						<dd class="truncate font-mono" title={value}>{value}</dd>
					{/each}
				</dl>
			{/if}

			{#if job.status === 'in_progress' || job.status === 'completed'}
				<JobLogs repo={data.repo} runId={run.id} {job} />
			{/if}

			{#each job.steps.filter((step) => step.summary) as step (step.index)}
				<Panel title={`Summary · ${step.name}`} icon={PackageIcon}>
					<pre class="max-h-96 overflow-auto whitespace-pre-wrap text-sm">{step.summary}</pre>
				</Panel>
			{/each}
		</section>
	{/if}

	{#if run.artifacts.length > 0}
		<Panel title="Artifacts" icon={PackageIcon} flush count={run.artifacts.length}>
			<ul class="divide-y">
				{#each run.artifacts as artifact (artifact.id)}
					<li class="flex items-center gap-3 px-6 py-2.5 text-sm">
						<PackageIcon class="size-4 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1 truncate font-mono">{artifact.name}</span>
						<span class="hidden text-xs text-muted-foreground sm:inline">{formatBytes(artifact.size)}</span>
						<span class="hidden text-xs text-muted-foreground md:inline"
							>expires {formatDate(artifact.expiresAt)}</span
						>
						<Button
							variant="outline"
							size="sm"
							href={artifactHref(data.repo, run.id, artifact.id)}
							download={artifact.name}
							data-sveltekit-reload
						>
							<DownloadIcon />Download
						</Button>
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}
</div>
