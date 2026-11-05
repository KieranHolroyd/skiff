<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CogIcon from '@lucide/svelte/icons/cog';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import type { GithubRunnerPoolView, WorkloadSpec, WorkloadView } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import Panel from '../../../_lib/Panel.svelte';
	import { formatDate } from '../../../_lib/format.js';

	/**
	 * Worker settings (plan 21): ingress and replicas for any process/container project, and the
	 * GitHub runner pool for runner projects. Kept apart from the Runtime form so neither form can
	 * drop the other's fields.
	 */
	let {
		spec,
		workload,
		pool,
		canManage
	}: {
		spec: WorkloadSpec | null;
		workload: WorkloadView | null;
		pool: Promise<GithubRunnerPoolView | null>;
		canManage: boolean;
	} = $props();

	const runner = $derived(spec?.runner ?? null);
	let ingress = $state<'http' | 'none'>('http');
	let replicas = $state(1);
	let labels = $state('');
	let saving = $state(false);

	$effect(() => {
		ingress = spec?.ingress ?? 'http';
		replicas = spec?.replicas ?? 1;
		labels = spec?.runner?.labels.join(', ') ?? '';
	});

	async function save() {
		saving = true;
		try {
			const result = await runAction('?/saveWorker', {
				ingress,
				replicas: String(replicas),
				labels
			});
			if (result.type === 'success') await invalidateAll();
		} finally {
			saving = false;
		}
	}

	const runnerTone = (status: string, busy: boolean) =>
		busy ? 'running' : status === 'online' ? 'idle' : status === 'offline' ? 'stopped' : 'unknown';
</script>

{#if spec}
	<Panel
		title={runner ? 'GitHub Actions runners' : 'Worker'}
		icon={runner ? WorkflowIcon : CogIcon}
		description={runner
			? 'Ephemeral self-hosted runners. Each takes one job, then a fresh runner replaces it with a new registration.'
			: 'Background workers have no public route and no port: queue consumers, bots and other long-running jobs.'}
	>
		<div class="space-y-5">
			{#if workload?.message?.startsWith('Runner: ')}
				<Alert.Root variant="destructive">
					<CircleAlertIcon />
					<Alert.Title>Runners cannot register</Alert.Title>
					<Alert.Description>{workload.message.slice('Runner: '.length)}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if runner}
				{#await pool}
					<div class="space-y-2">
						<Skeleton class="h-5 w-48" />
						<Skeleton class="h-16 w-full" />
					</div>
				{:then view}
					{#if view}
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<span class="text-muted-foreground">Serving</span>
							<span class="font-mono">{view.target}</span>
							<Badge variant="secondary"
								>{view.scope === 'repo' ? 'repository' : 'organisation'}</Badge
							>
							<Badge variant="outline">{view.auth === 'pat' ? 'access token' : 'GitHub App'}</Badge>
						</div>
						<div class="flex flex-wrap gap-1.5">
							{#each view.labels as label (label)}
								<Badge variant="outline" class="font-mono">{label}</Badge>
							{/each}
						</div>
						{#if view.error}
							<p class="text-sm text-muted-foreground">GitHub status unavailable: {view.error}</p>
						{/if}
						{#if view.runners.length === 0}
							<p class="text-sm text-muted-foreground">
								No runner has registered yet. Runners register when the deployment starts on its
								node.
							</p>
						{:else}
							<ul class="divide-y rounded-md border text-sm">
								{#each view.runners as item (item.name)}
									<li class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
										<span class="font-mono text-xs">{item.name}</span>
										<span class="flex items-center gap-3 text-xs text-muted-foreground">
											<span>since {formatDate(item.registeredAt)}</span>
											<StatusBadge
												status={runnerTone(item.status, item.busy)}
												label={item.busy ? 'busy' : item.status}
											/>
										</span>
									</li>
								{/each}
							</ul>
						{/if}
					{/if}
				{/await}
			{/if}

			{#if canManage}
				<div class="grid gap-4 sm:grid-cols-3">
					{#if !runner}
						<Field.Field>
							<Field.Label for="worker-ingress">Traffic</Field.Label>
							<NativeSelect.Root id="worker-ingress" bind:value={ingress} class="w-full">
								<NativeSelect.Option value="http"
									>HTTP app (route + health check)</NativeSelect.Option
								>
								<NativeSelect.Option value="none">Worker (no route)</NativeSelect.Option>
							</NativeSelect.Root>
						</Field.Field>
					{/if}
					<Field.Field>
						<Field.Label for="worker-replicas">{runner ? 'Runners' : 'Copies'}</Field.Label>
						<Input
							id="worker-replicas"
							type="number"
							min={1}
							max={20}
							bind:value={replicas}
							disabled={ingress !== 'none'}
						/>
						<Field.Description>
							{ingress === 'none'
								? `Reserves ${(spec.memoryMb * replicas).toLocaleString()} MB on the node.`
								: 'HTTP apps run one copy.'}
						</Field.Description>
					</Field.Field>
					{#if runner}
						<Field.Field class="sm:col-span-2">
							<Field.Label for="worker-labels">Extra labels</Field.Label>
							<Input
								id="worker-labels"
								bind:value={labels}
								placeholder="gpu, X64"
								class="font-mono"
							/>
							<Field.Description>self-hosted and linux are always added.</Field.Description>
						</Field.Field>
					{/if}
				</div>
				<div class="flex justify-end">
					<Button onclick={save} disabled={saving}>Save worker settings</Button>
				</div>
			{/if}
		</div>
	</Panel>
{/if}
