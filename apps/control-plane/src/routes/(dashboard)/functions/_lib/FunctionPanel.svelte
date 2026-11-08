<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import type { ProjectView } from '@skiff/core';
	import {
		WORKERD_MAX_COMPATIBILITY_DATE,
		WORKERD_PINNED_VERSION,
		type FunctionView,
		type NodeCapacityView,
		type WorkloadSpec,
		type WorkloadView
	} from '@skiff/contracts';
	import CableIcon from '@lucide/svelte/icons/cable';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import FunctionQuickstart from './FunctionQuickstart.svelte';
	import FunctionTriggers from './FunctionTriggers.svelte';
	import type { FunctionEventTriggersData } from './event-triggers.server.js';
	import { formatDateTime, formatRelative, shortId } from '../../_lib/format.js';
	import {
		COMPATIBILITY_LAG_WARN_DAYS,
		bindingInfo,
		bindingMatrix,
		functionStatus,
		statefulBindings,
		compatibilityLagDays,
		formatIdleStop,
		groupBindings,
		isDefaultIdleStop
	} from '../../_lib/function-view.js';

	/**
	 * The Bindings & triggers section of a function (docs/FUNCTIONS.md §4.11). Read-only by design: the
	 * function's `wrangler.jsonc` is the configuration (FN8), so changing a binding or the
	 * compatibility date is a deploy, and a rollback restores both with the code (D17).
	 */
	let {
		project,
		view,
		spec,
		workload,
		capacity,
		cronNext,
		eventTriggers,
		fieldErrors,
		can
	}: {
		project: ProjectView;
		view: FunctionView | null;
		spec: WorkloadSpec | null;
		workload: WorkloadView | null;
		capacity: NodeCapacityView[];
		/** Next fire time per cron expression, computed on the server (UTC). */
		cronNext: Record<string, string | null>;
		/** Event rules publishing into the queues this function consumes (D122). */
		eventTriggers: FunctionEventTriggersData;
		fieldErrors?: Record<string, string>;
		can: { manageWorkload: boolean; viewCapacity: boolean };
	} = $props();

	const node = $derived(
		workload?.nodeId ? capacity.find((item) => item.nodeId === workload?.nodeId) : undefined
	);
	const memoryMb = $derived(workload?.memoryMb ?? spec?.memoryMb ?? null);
	const cpus = $derived(workload?.cpus ?? spec?.cpus ?? null);
	const memoryPct = $derived(
		memoryMb && node && node.sliceMemoryMb > 0
			? Math.min(100, (memoryMb / node.sliceMemoryMb) * 100)
			: 0
	);
	const lagDays = $derived(view ? compatibilityLagDays(view.compatibilityDate) : 0);
	const groups = $derived(groupBindings(view?.bindings ?? []));
	const matrix = $derived(bindingMatrix(view));
	const workerdDrift = $derived(view !== null && view.workerdVersion !== WORKERD_PINNED_VERSION);
	const hostStatus = $derived(functionStatus(workload, view));
	const pinned = $derived(statefulBindings(view));
	const replicas = $derived(spec?.replicas ?? workload?.replicas ?? 1);

	let matrixOpen = $state(false);

	function resetWorkload() {
		askConfirm({
			title: 'Stop the function and clear its runtime?',
			description:
				'The workerd host is stopped on the next reconcile and the resolved spec is cleared. Deployments are kept; the next deploy brings it back.',
			confirmLabel: 'Stop and clear',
			tone: 'danger',
			action: '?/removeWorkload'
		});
	}
</script>

<div class="space-y-5">
	<Card.Root class="gap-0 py-0">
		<Card.Header class="border-b py-4">
			<div class="flex items-start gap-3">
				<span
					class="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand"
				>
					<ZapIcon class="size-4" />
				</span>
				<div class="space-y-1">
					<Card.Title class="flex flex-wrap items-center gap-2">
						Runtime
						<Badge variant="outline">Function</Badge>
						{#if workload}<StatusBadge
								status={hostStatus.status}
								label={hostStatus.label}
								tone={hostStatus.tone}
							/>{/if}
					</Card.Title>
					<Card.Description>
						{hostStatus.status === 'idle'
							? hostStatus.hint
							: 'Workers-compatible code on a pinned, socket-activated workerd host.'} The function's
						<code class="font-mono text-xs">wrangler.jsonc</code> is the configuration: deploy to change
						it, roll back to restore it.
					</Card.Description>
				</div>
			</div>
			{#if can.manageWorkload && workload}
				<Card.Action class="self-center">
					<Button variant="ghost-danger" size="sm" onclick={resetWorkload}>
						<RotateCcwIcon />Reset
					</Button>
				</Card.Action>
			{/if}
		</Card.Header>
		<Card.Content class="py-4">
			{#if view}
				<div class="grid gap-x-8 gap-y-0 lg:grid-cols-2">
					<DetailList>
						<dt>Entry module</dt>
						<dd class="truncate font-mono text-xs" title={view.main}>
							{view.main}
							<span class="text-muted-foreground">
								· {view.moduleCount}
								{view.moduleCount === 1 ? 'module' : 'modules'}</span
							>
						</dd>
						<dt>Compatibility</dt>
						<dd class="font-mono text-xs">
							{view.compatibilityDate}
							{#if lagDays > COMPATIBILITY_LAG_WARN_DAYS}
								<span
									class="ml-1 font-sans text-muted-foreground"
									title="The pinned workerd supports dates up to {WORKERD_MAX_COMPATIBILITY_DATE}"
									>({lagDays} days behind)</span
								>
							{/if}
						</dd>
						<dt>Flags</dt>
						<dd class="flex flex-wrap justify-end gap-1">
							{#each view.compatibilityFlags as flag (flag)}
								<Badge variant="neutral" class="font-mono text-[11px]">{flag}</Badge>
							{:else}
								<span class="text-xs text-muted-foreground">none</span>
							{/each}
						</dd>
						<dt>workerd</dt>
						<dd class="font-mono text-xs">
							{view.workerdVersion}
							{#if workerdDrift}
								<Badge
									variant="warning"
									class="ml-1"
									title="This deployment was resolved against a different pinned build. The next deploy picks up {WORKERD_PINNED_VERSION}."
									>older pin</Badge
								>
							{/if}
						</dd>
					</DetailList>
					<DetailList>
						<dt>Idle stop</dt>
						<dd class="text-sm">
							{formatIdleStop(view.idleStopSeconds)}
							{#if isDefaultIdleStop(view.idleStopSeconds)}
								<span class="text-xs text-muted-foreground">(default)</span>
							{/if}
						</dd>
						<dt>Memory / CPU</dt>
						<dd class="font-mono text-xs">
							{memoryMb ?? '—'} MB · {cpus ?? '—'} vCPU
						</dd>
						<dt>Replicas</dt>
						<dd class="text-xs">
							<span class="font-mono">{replicas}</span>
							{#if pinned.length > 0}
								<span class="text-muted-foreground"
									>· one host ({pinned.map((binding) => binding.name).join(', ')} keep state)</span
								>
							{/if}
						</dd>
						<dt>Node</dt>
						<dd class="font-mono text-xs">
							{#if node}{node.name}{:else if workload?.nodeId}{shortId(
									workload.nodeId,
									12
								)}{:else}—{/if}
						</dd>
						<dt>Deployment</dt>
						<dd class="font-mono text-xs">
							{view.deploymentId ? shortId(view.deploymentId, 12) : 'not deployed'}
							{#if workload}
								<span class="font-sans text-muted-foreground">
									· <time datetime={workload.updatedAt} title={formatDateTime(workload.updatedAt)}
										>{formatRelative(workload.updatedAt)}</time
									></span
								>
							{/if}
						</dd>
					</DetailList>
				</div>
				{#if workload?.message}
					<p class="mt-3 text-xs break-words text-muted-foreground">{workload.message}</p>
				{/if}
				{#if memoryMb}
					<div class="mt-4 space-y-1.5">
						<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
							<span class="text-muted-foreground">
								Memory reservation{replicas > 1 ? ` · ${replicas} replicas` : ''}
								<span class="hidden sm:inline">· held while idle</span>
							</span>
							<span class="font-mono tabular-nums">
								{node ? `${memoryMb} MB of ${node.sliceMemoryMb} MB slice` : `${memoryMb} MB`}
							</span>
						</div>
						{#if node}
							<Progress value={memoryPct} aria-label="Function memory reservation" class="h-1.5" />
						{:else if !can.viewCapacity}
							<p class="text-xs text-muted-foreground">
								Slice capacity is only visible to platform admins.
							</p>
						{/if}
					</div>
				{/if}
			{:else}
				<p class="text-sm">
					Nothing deployed yet. Run <code class="font-mono text-xs">skif deploy</code> in the Wrangler
					project; the control plane validates the bundle, resolves the bindings and starts a workerd
					host on the next reconcile.
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					Pinned workerd {WORKERD_PINNED_VERSION} · compatibility dates up to {WORKERD_MAX_COMPATIBILITY_DATE}
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	{#if !view}
		<FunctionQuickstart slug={project.slug} />
	{:else}
		<div class="grid items-start gap-5 lg:grid-cols-2">
			<Card.Root class="gap-0 py-0 lg:col-span-2">
				<Card.Header class="border-b py-4">
					<Card.Title class="flex items-center gap-2">
						<CableIcon class="size-4 text-muted-foreground" />
						Bindings
						<Badge variant="neutral" class="tabular-nums">{view.bindings.length}</Badge>
					</Card.Title>
					<Card.Description>
						What <code class="font-mono text-xs">env</code> exposes to the Worker. A function can
						reach only these; global <code class="font-mono text-xs">fetch()</code> is limited to public
						addresses. Secret values never appear here.
					</Card.Description>
				</Card.Header>
				<Card.Content class="px-0 py-0">
					{#if view.bindings.length === 0}
						<p class="px-6 py-4 text-sm text-muted-foreground">
							No bindings. Declare <code class="font-mono text-xs">vars</code>, secrets, same-bundle
							services or Skiff apps in the manifest to add them.
						</p>
					{:else}
						<Table.Root>
							<Table.Header class="bg-muted/45">
								<Table.Row>
									<Table.Head class="pl-6">Name</Table.Head>
									<Table.Head>Type</Table.Head>
									<Table.Head class="hidden sm:table-cell">Target</Table.Head>
									<Table.Head class="hidden pr-6 md:table-cell">Backed by</Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each groups as group (group.group)}
									<Table.Row class="hover:bg-transparent">
										<Table.Cell
											colspan={4}
											class="bg-muted/20 py-1.5 pl-6 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
											>{group.label}</Table.Cell
										>
									</Table.Row>
									{#each group.items as binding (binding.name)}
										{@const info = bindingInfo(binding.type)}
										<Table.Row>
											<Table.Cell class="pl-6 font-mono text-xs font-medium"
												>{binding.name}</Table.Cell
											>
											<Table.Cell><Badge variant="outline">{info.label}</Badge></Table.Cell>
											<Table.Cell
												class="hidden max-w-64 truncate font-mono text-xs text-muted-foreground sm:table-cell"
												title={binding.summary}>{binding.summary}</Table.Cell
											>
											<Table.Cell class="hidden pr-6 text-xs text-muted-foreground md:table-cell"
												>{info.backing}</Table.Cell
											>
										</Table.Row>
									{/each}
								{/each}
							</Table.Body>
						</Table.Root>
					{/if}
				</Card.Content>
			</Card.Root>

			<div class="lg:col-span-2">
				<FunctionTriggers {project} {view} {cronNext} events={eventTriggers} {fieldErrors} />
			</div>

			<Card.Root class="gap-0 py-0 lg:col-span-2">
				<Card.Header class="border-b py-4">
					<Card.Title class="flex items-center gap-2">
						<FolderOpenIcon class="size-4 text-muted-foreground" />
						Static assets
					</Card.Title>
					<Card.Description>
						Caddy serves matching files first and falls through to the function on a miss.
					</Card.Description>
				</Card.Header>
				<Card.Content class="py-4">
					{#if view.assets}
						<DetailList>
							<dt>Directory</dt>
							<dd class="font-mono text-xs">{view.assets.directory}/</dd>
							<dt>Function first</dt>
							<dd class="flex flex-wrap justify-end gap-1">
								{#each view.assets.runWorkerFirst as glob (glob)}
									<Badge
										variant={glob.startsWith('!') ? 'neutral' : 'outline'}
										class="font-mono text-[11px]">{glob}</Badge
									>
								{:else}
									<span class="text-xs text-muted-foreground">no paths</span>
								{/each}
							</dd>
						</DetailList>
					{:else}
						<p class="text-sm text-muted-foreground">
							No assets directory. Every request goes to the function. Add
							<code class="font-mono text-xs">assets.directory</code> to serve files without waking it.
						</p>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	{/if}

	<Collapsible.Root bind:open={matrixOpen}>
		<Card.Root class="gap-0 py-0">
			<Collapsible.Trigger class="w-full text-left">
				<Card.Header class="py-4 {matrixOpen ? 'border-b' : ''}">
					<Card.Title class="flex items-center gap-2">
						<TableIcon class="size-4 text-muted-foreground" />
						What you can bind
					</Card.Title>
					<Card.Description>
						Every Workers binding Skiff serves, where it goes in wrangler.jsonc and what backs it.
						Bindings marked <span class="font-medium">one host</span> keep state on the node, so a function
						using them cannot scale out yet.
					</Card.Description>
					<Card.Action class="self-center">
						<ChevronDownIcon
							class="size-4 text-muted-foreground transition-transform {matrixOpen
								? 'rotate-180'
								: ''}"
						/>
					</Card.Action>
				</Card.Header>
			</Collapsible.Trigger>
			<Collapsible.Content>
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="pl-6">Binding</Table.Head>
							<Table.Head class="hidden md:table-cell">wrangler.jsonc</Table.Head>
							<Table.Head class="hidden lg:table-cell">Backed by</Table.Head>
							<Table.Head class="pr-6 text-right">Status</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each matrix as row (row.type)}
							<Table.Row>
								<Table.Cell class="pl-6 whitespace-normal">
									<span class="text-sm">{row.label}</span>
									{#if row.stateful}
										<Badge
											variant="neutral"
											class="ml-1 text-[10px]"
											title="Keeps state on one host">one host</Badge
										>
									{/if}
									{#if row.needs}
										<p class="text-xs text-muted-foreground">Needs: {row.needs}</p>
									{/if}
								</Table.Cell>
								<Table.Cell class="hidden font-mono text-xs text-muted-foreground md:table-cell"
									>{row.wrangler}</Table.Cell
								>
								<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell"
									>{row.backing}</Table.Cell
								>
								<Table.Cell class="pr-6 text-right">
									{#if row.used > 0}
										<Badge variant="brand">in use · {row.used}</Badge>
									{:else if row.available}
										<Badge variant="success">available</Badge>
									{:else}
										<Badge variant="neutral">not in this build</Badge>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Collapsible.Content>
		</Card.Root>
	</Collapsible.Root>
</div>
