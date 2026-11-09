<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import FileUpIcon from '@lucide/svelte/icons/file-up';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import PlayIcon from '@lucide/svelte/icons/play';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import {
		BLUEPRINT_FILE_NAMES,
		isTerminalOperation,
		type BlueprintApplyView,
		type BlueprintPlanAction,
		type BlueprintPlanView,
		type ItemStatus
	} from '@yoal/contracts';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatRelative } from '../../_lib/format.js';
	import { streamOperation } from '../../_lib/operations/client.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const example = `apiVersion: yoal/v1
name: shop
projects:
  shop-api:
    runtime: process
    command: [bun, run, start]
    port: 3000
    healthPath: /health
    env: { LOG_LEVEL: info }
databases:
  shop-db:
    engine: postgres
storage:
  shop-assets:
    buckets:
      uploads: {}
attachments:
  - { project: shop-api, database: shop-db }
  - { project: shop-api, storage: shop-assets, grants: [{ bucket: uploads }] }
`;

	let documentText = $state('');
	let prune = $state(false);
	let planning = $state(false);
	let plan = $state<BlueprintPlanView | null>(null);
	let problem = $state<{ message: string; issues: string[] } | null>(null);
	let showUpToDate = $state(false);
	let confirmName = $state('');
	let applying = $state(false);
	let progress = $state<{ done: number; total: number } | null>(null);
	let run = $state<BlueprintApplyView | null>(null);
	/** Live per-resource status while a run streams. */
	const statuses = new SvelteMap<string, ItemStatus>();
	let closeStream: (() => void) | null = null;

	const changing = $derived(
		plan ? plan.resources.filter((resource) => resource.action !== 'noop') : []
	);
	const upToDate = $derived(
		plan ? plan.resources.filter((resource) => resource.action === 'noop') : []
	);
	const shown = $derived(showUpToDate && plan ? plan.resources : changing);
	const deletes = $derived(plan?.summary.delete ?? 0);
	const canApplyPlan = $derived(
		Boolean(plan) &&
			changing.length > 0 &&
			!applying &&
			!run &&
			data.canApply &&
			(deletes === 0 || confirmName.trim() === plan?.stack)
	);

	const actionTone: Record<BlueprintPlanAction, 'success' | 'warning' | 'danger' | 'neutral'> = {
		create: 'success',
		update: 'warning',
		delete: 'danger',
		noop: 'neutral'
	};

	onDestroy(() => closeStream?.());

	/** Mutations are same-origin JSON fetches with the session cookie (the CSRF check expects that). */
	async function call<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const json = (await response.json().catch(() => null)) as
			| (Record<string, unknown> & {
					message?: string;
					issues?: Array<{ path?: unknown[]; message?: string }>;
			  })
			| null;
		if (!response.ok) {
			const issues = (json?.issues ?? []).map(
				(issue) =>
					`${Array.isArray(issue.path) && issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message ?? ''}`
			);
			throw Object.assign(new Error(json?.message ?? `The request failed (${response.status}).`), {
				issues
			});
		}
		return json as T;
	}

	function fail(error: unknown) {
		const issues = (error as { issues?: string[] }).issues ?? [];
		problem = {
			message: error instanceof Error ? error.message : 'That did not work.',
			issues: issues.length > 1 ? issues : []
		};
	}

	async function makePlan() {
		if (!documentText.trim()) return;
		planning = true;
		problem = null;
		plan = null;
		run = null;
		progress = null;
		confirmName = '';
		statuses.clear();
		try {
			plan = (
				await call<{ plan: BlueprintPlanView }>('/api/v1/blueprints/plan', {
					document: documentText,
					prune
				})
			).plan;
		} catch (error) {
			fail(error);
		} finally {
			planning = false;
		}
	}

	async function apply() {
		if (!plan) return;
		applying = true;
		problem = null;
		try {
			const started = (
				await call<{ run: BlueprintApplyView }>('/api/v1/blueprints/apply', {
					planHash: plan.planHash,
					...(deletes > 0 ? { confirm: confirmName.trim() } : {})
				})
			).run;
			progress = { done: started.done, total: started.total };
			if (isTerminalOperation(started.status)) {
				run = started;
				applying = false;
				await invalidateAll();
				return;
			}
			closeStream = streamOperation(
				started.operationId,
				{
					onProgress: (operation) => (progress = { done: operation.done, total: operation.total }),
					onItems: (items) => {
						for (const item of items) statuses.set(item.targetId, item.status);
					},
					onDone: async () => {
						await finish(started.operationId);
					},
					onError: async (message) => {
						problem = { message, issues: [] };
						await finish(started.operationId);
					}
				},
				{ untilDone: true }
			);
		} catch (error) {
			fail(error);
			applying = false;
		}
	}

	async function finish(operationId: string) {
		try {
			const response = await fetch(`/api/v1/blueprints/apply/${encodeURIComponent(operationId)}`, {
				credentials: 'same-origin',
				headers: { accept: 'application/json' }
			});
			if (response.ok) run = ((await response.json()) as { run: BlueprintApplyView }).run;
		} finally {
			applying = false;
			await invalidateAll();
		}
	}

	async function loadFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		documentText = await file.text();
		input.value = '';
		plan = null;
	}

	function statusOf(key: string): ItemStatus | undefined {
		return run?.resources.find((resource) => resource.key === key)?.status ?? statuses.get(key);
	}
	function detailOf(key: string): string | null {
		const resource = run?.resources.find((entry) => entry.key === key);
		return resource?.error ?? (resource?.status === 'skipped' ? resource.reason : null) ?? null;
	}
</script>

<svelte:head>
	<title>Apply a blueprint · Yoal</title>
</svelte:head>

<div class="space-y-8">
	<PageHeader
		target="page.new-blueprint"
		eyebrow="New"
		title="Apply a blueprint"
		description="Describe a stack in one file: projects, environments, domains, workload settings, databases, storage buckets, brokers and how they attach. Plan shows exactly what would change; apply runs it, and applying the same file again changes nothing."
	>
		<Button variant="outline" href={resolve('/(dashboard)/new')}>Back to templates</Button>
	</PageHeader>

	{#if !data.enabled}
		<Notice tone="warning" title="Blueprints are turned off on this platform">
			An operator turns them on with <code>YOAL_FEATURE_BLUEPRINTS=1</code> in the control plane's environment.
		</Notice>
	{:else}
		<Panel
			title="Blueprint"
			icon={ScrollTextIcon}
			description={`YAML or JSON with apiVersion: yoal/v1. The CLI looks for ${BLUEPRINT_FILE_NAMES[0]}. Secrets are names only; create their values first.`}
		>
			{#snippet actions()}
				<Button variant="ghost" size="sm" onclick={() => (documentText = example)}
					>Insert an example</Button
				>
				<Label
					class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted"
				>
					<FileUpIcon class="size-4" />Open a file
					<input type="file" accept=".yaml,.yml,.json" class="sr-only" onchange={loadFile} />
				</Label>
			{/snippet}
			<div class="space-y-4">
				<Textarea
					bind:value={documentText}
					rows={18}
					spellcheck={false}
					class="font-mono text-xs"
					placeholder={'apiVersion: yoal/v1\nname: my-stack\nprojects:\n  my-site: {}'}
					aria-label="Blueprint document"
				/>
				<div class="flex flex-wrap items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						<Checkbox id="prune" bind:checked={prune} />
						<Label for="prune" class="text-sm font-normal">
							Prune: delete resources this stack manages that the file no longer lists
						</Label>
					</div>
					<Button onclick={makePlan} disabled={planning || !documentText.trim()}>
						{#if planning}<Spinner />{:else}<ListChecksIcon />{/if}
						Plan
					</Button>
				</div>
			</div>
		</Panel>

		{#if problem}
			<Notice tone="danger" title={problem.message}>
				{#if problem.issues.length}
					<ul class="mt-1 list-disc space-y-0.5 pl-5 font-mono text-xs">
						{#each problem.issues as issue (issue)}<li>{issue}</li>{/each}
					</ul>
				{/if}
			</Notice>
		{/if}

		{#if plan}
			<Panel title={`Plan for "${plan.stack}"`} icon={ListChecksIcon} flush>
				{#snippet actions()}
					<div class="flex flex-wrap items-center gap-1.5">
						{#if plan}
							<Badge variant="success">{plan.summary.create} create</Badge>
							<Badge variant="warning">{plan.summary.update} update</Badge>
							{#if plan.summary.delete}<Badge variant="destructive"
									>{plan.summary.delete} delete</Badge
								>{/if}
							<Badge variant="neutral">{plan.summary.noop} up to date</Badge>
						{/if}
					</div>
				{/snippet}
				<div class="divide-y">
					{#if shown.length === 0}
						<p class="p-4 text-sm text-muted-foreground">
							Everything in this file is already up to date. There is nothing to apply.
						</p>
					{/if}
					{#each shown as resource (resource.key)}
						{@const status = statusOf(resource.key)}
						{@const detail = detailOf(resource.key)}
						<div class="space-y-1 px-4 py-3">
							<div class="flex flex-wrap items-center gap-2">
								<Badge variant={actionTone[resource.action]}>{resource.action}</Badge>
								<span class="font-mono text-sm break-all">{resource.key}</span>
								{#if status && status !== 'pending'}
									<StatusBadge {status} class="ml-auto" />
								{:else if applying}
									<span class="ml-auto"><Spinner class="size-3.5" /></span>
								{/if}
							</div>
							{#if resource.reason && resource.action !== 'noop'}
								<p class="text-xs text-muted-foreground">{resource.reason}</p>
							{/if}
							{#if resource.changes.length}
								<ul class="space-y-0.5 font-mono text-xs text-muted-foreground">
									{#each resource.changes as change (change.path)}
										<li>
											{change.path}:
											<span class="line-through opacity-70">{change.from ?? '–'}</span>
											→ <span class="text-foreground">{change.to ?? '–'}</span>
										</li>
									{/each}
								</ul>
							{/if}
							{#if detail}<p class="text-xs text-destructive">{detail}</p>{/if}
						</div>
					{/each}
				</div>
				{#snippet footer()}
					<div class="flex w-full flex-wrap items-center justify-between gap-3">
						{#if upToDate.length}
							<Button variant="ghost" size="sm" onclick={() => (showUpToDate = !showUpToDate)}>
								{showUpToDate ? 'Hide' : 'Show'}
								{upToDate.length} up to date
							</Button>
						{:else}
							<span></span>
						{/if}
						{#if changing.length && !run}
							<div class="flex flex-wrap items-center gap-2">
								{#if deletes > 0}
									<Input
										bind:value={confirmName}
										placeholder={`Type ${plan?.stack} to delete ${deletes}`}
										class="h-8 w-56"
										aria-label="Type the stack name to confirm"
									/>
								{/if}
								<Button onclick={apply} disabled={!canApplyPlan}>
									{#if applying}<Spinner />{:else}<PlayIcon />{/if}
									Apply {changing.length} change{changing.length === 1 ? '' : 's'}
								</Button>
							</div>
						{/if}
					</div>
				{/snippet}
			</Panel>

			{#each plan.warnings as warning (warning)}
				<Notice tone="info">{warning}</Notice>
			{/each}

			{#if !data.canApply && changing.length}
				<Notice tone="info"
					>Your role can plan but not apply. Ask an owner or admin to apply it.</Notice
				>
			{/if}

			{#if progress && (applying || run)}
				<div class="space-y-2">
					<div class="flex items-center justify-between text-sm">
						<span>{run ? 'Finished' : 'Applying…'}</span>
						<span class="text-muted-foreground">{progress.done}/{progress.total}</span>
					</div>
					<Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} />
				</div>
			{/if}

			{#if run}
				<Notice
					tone={run.status === 'succeeded'
						? 'success'
						: run.status === 'partial'
							? 'warning'
							: 'danger'}
					title={run.status === 'succeeded'
						? `Applied "${run.stack}"`
						: `The run ${run.status === 'partial' ? 'stopped partway' : run.status}`}
				>
					{#if run.error}
						Stopped at {run.error}. Later steps were skipped and nothing was rolled back; fix the
						cause and plan again.
					{:else}
						Every step finished. Planning the same file again shows everything up to date.
					{/if}
					<a
						class="underline underline-offset-4"
						href={resolve('/(dashboard)/settings/maintenance/operations/[id]', {
							id: run.operationId
						})}>Operation details</a
					>
				</Notice>
			{/if}
		{/if}

		{#if data.stacks.length}
			<Panel title="Applied stacks" count={data.stacks.length} flush>
				<ul class="divide-y">
					{#each data.stacks as stack (stack.name)}
						<li class="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
							<span class="font-medium">{stack.name}</span>
							{#if stack.lastStatus}<StatusBadge status={stack.lastStatus} />{/if}
							<span class="text-muted-foreground">{stack.managed.length} resources</span>
							<span class="ml-auto text-xs text-muted-foreground">
								{stack.appliedAt
									? `applied ${formatRelative(stack.appliedAt)}`
									: 'never applied cleanly'}
							</span>
						</li>
					{/each}
				</ul>
			</Panel>
		{/if}
	{/if}
</div>
