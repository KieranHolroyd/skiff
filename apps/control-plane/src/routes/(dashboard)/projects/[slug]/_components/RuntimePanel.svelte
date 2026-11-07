<script lang="ts">
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import type { ProjectView } from '@skiff/core';
	import type { NodeCapacityView, WorkloadSpec, WorkloadView } from '@skiff/contracts';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime, shortId } from '../../../_lib/format.js';

	let {
		project,
		spec,
		workload,
		capacity,
		can
	}: {
		project: ProjectView;
		spec: WorkloadSpec | null;
		workload: WorkloadView | null;
		capacity: NodeCapacityView[];
		can: {
			manageWorkload: boolean;
			viewCapacity: boolean;
		};
	} = $props();

	let editOpen = $state(false);

	let command = $state('');
	let image = $state('');
	let port = $state('3000');
	let memoryMb = $state('256');
	let cpus = $state('1');
	let healthPath = $state('/');
	let socketActivation = $state(true);
	let idleStopSeconds = $state('0');
	let dataEnabled = $state(false);
	let dataSizeMb = $state('256');

	const node = $derived(
		workload?.nodeId ? capacity.find((item) => item.nodeId === workload?.nodeId) : undefined
	);

	const memoryPct = $derived(
		workload && node && node.sliceMemoryMb > 0
			? Math.min(100, (workload.memoryMb / node.sliceMemoryMb) * 100)
			: 0
	);

	const runtimeLabel = $derived(
		project.runtime === 'process'
			? 'Process app'
			: project.runtime === 'container'
				? 'Container'
				: 'Static'
	);

	function openEditor() {
		command = spec?.command?.join(' ') ?? (project.runtime === 'process' ? 'bun run start' : '');
		image = spec?.image ?? '';
		port = String(spec?.port ?? 3000);
		memoryMb = String(spec?.memoryMb ?? 256);
		cpus = String(spec?.cpus ?? 1);
		healthPath = spec?.healthPath ?? '/';
		socketActivation = spec?.socketActivation ?? true;
		idleStopSeconds = String(spec?.idleStopSeconds ?? 0);
		dataEnabled = Boolean(spec?.data);
		dataSizeMb = String(spec?.data?.sizeMb ?? 256);
		editOpen = true;
	}

	function resetWorkload() {
		askConfirm({
			title: 'Stop the workload and reset its runtime?',
			description:
				'The running app is stopped on the next reconcile and the spec is cleared. Deployments and releases are kept, but the production pointer alone cannot serve a process/container app — it stays dark until you configure a runtime and deploy again.',
			confirmLabel: 'Reset runtime',
			tone: 'danger',
			action: '?/removeWorkload'
		});
	}
</script>

{#if project.runtime === 'static'}
	<EmptyState
		icon={LayersIcon}
		title="Static project"
		description="Static projects serve files from a release and have no workload. Create a project with runtime “process” or “container” to run an app with a command, port, memory budget and environment variables."
	/>
{:else}
	<div class="space-y-5">
		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex items-start gap-3">
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
					>
						{#if project.runtime === 'container'}
							<BoxesIcon class="size-4" />
						{:else}
							<CpuIcon class="size-4" />
						{/if}
					</span>
					<div class="space-y-1">
						<Card.Title class="flex flex-wrap items-center gap-2">
							Runtime
							<Badge variant="outline">{runtimeLabel}</Badge>
							{#if workload}<StatusBadge status={workload.status} />{/if}
						</Card.Title>
						<Card.Description>
							{project.runtime === 'container'
								? 'A rootless Podman container in the node workload slice.'
								: 'A sandboxed systemd service in the node workload slice.'}
							Only the latest deployment is active — deploying to any environment restarts this workload
							on that release.
						</Card.Description>
					</div>
				</div>
				<Card.Action class="flex flex-wrap items-center justify-end gap-2 self-center">
					{#if can.manageWorkload}
						<Button variant="outline" size="sm" onclick={openEditor}><PencilIcon />Configure</Button
						>
					{/if}
					{#if can.manageWorkload && workload}
						<Button variant="ghost-danger" size="sm" onclick={resetWorkload}>
							<RotateCcwIcon />Reset
						</Button>
					{/if}
				</Card.Action>
			</Card.Header>
			<Card.Content class="py-4">
				{#if workload}
					<DetailList>
						<dt>Node</dt>
						<dd class="font-mono text-xs">
							{#if node}
								{node.name}
							{:else}
								{shortId(workload.nodeId ?? '', 12)}
							{/if}
						</dd>
						<dt>Upstream</dt>
						<dd class="truncate font-mono text-xs" title={workload.upstream ?? ''}>
							{workload.upstream ?? '—'}
						</dd>
						<dt>Memory / CPU</dt>
						<dd class="font-mono text-xs">{workload.memoryMb} MB · {workload.cpus} vCPU</dd>
						<dt>Deployment</dt>
						<dd class="truncate font-mono text-xs">{shortId(workload.deploymentId, 12)}</dd>
						<dt>Updated</dt>
						<dd class="text-sm">
							<time datetime={workload.updatedAt}>{formatDateTime(workload.updatedAt)}</time>
						</dd>
					</DetailList>
					{#if workload.message}
						<p class="mt-3 text-xs break-words text-muted-foreground">{workload.message}</p>
					{/if}
					<div class="mt-4 space-y-1.5">
						<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
							<span class="text-muted-foreground">Memory reservation</span>
							<span class="font-mono text-xs tabular-nums">
								{node
									? `${workload.memoryMb} MB of ${node.sliceMemoryMb} MB slice`
									: `${workload.memoryMb} MB`}
							</span>
						</div>
						{#if node}
							<Progress value={memoryPct} aria-label="Workload memory reservation" class="h-1.5" />
						{:else if can.viewCapacity}
							<p class="text-xs text-muted-foreground">
								The node is not reporting slice capacity right now.
							</p>
						{:else}
							<p class="text-xs text-muted-foreground">
								Slice capacity is only visible to platform admins.
							</p>
						{/if}
					</div>
				{:else}
					<div class="space-y-2">
						<p class="text-sm">
							{spec
								? 'Configuration saved. An existing workload picks it up on the next reconcile; otherwise it applies at the next deployment.'
								: project.runtime === 'container'
									? 'No runtime configured yet. Container projects need an image before they can deploy.'
									: 'No runtime configured yet. The deploy pipeline uses `bun run start` by default.'}
						</p>
						<p class="text-xs text-muted-foreground">
							Admission is checked against the target node's workload slice at deploy time.
						</p>
					</div>
				{/if}
			</Card.Content>
		</Card.Root>

		<div class="grid items-start gap-5 lg:grid-cols-2">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>Specification</Card.Title>
					<Card.Description>The public fields applied to the project workload.</Card.Description>
				</Card.Header>
				<Card.Content class="py-4">
					{#if spec}
						<DetailList>
							{#if project.runtime === 'process'}
								<dt>Command</dt>
								<dd class="truncate font-mono text-xs" title={spec.command?.join(' ') ?? ''}>
									{spec.command?.join(' ') ?? 'bun run start'}
								</dd>
								<dt>Socket activation</dt>
								<dd class="text-sm">{spec.socketActivation ? 'enabled' : 'disabled'}</dd>
								<dt>Scale to zero</dt>
								<dd class="text-sm">
									{spec.idleStopSeconds ? `after ${spec.idleStopSeconds}s idle` : 'always on'}
								</dd>
							{:else}
								<dt>Image</dt>
								<dd class="truncate font-mono text-xs" title={spec.image ?? ''}>
									{spec.image ?? 'not set'}
								</dd>
							{/if}
							<dt>Port</dt>
							<dd class="font-mono text-sm">{spec.port}</dd>
							<dt>Health check</dt>
							<dd class="font-mono text-sm">{spec.healthPath}</dd>
							<dt>Memory</dt>
							<dd class="font-mono text-sm">{spec.memoryMb} MB</dd>
							<dt>CPU</dt>
							<dd class="font-mono text-sm">{spec.cpus} vCPU</dd>
							<dt>Variables</dt>
							<dd class="text-sm">
								<span class="font-mono">{Object.keys(spec.env).length}</span> plain ·
								<span class="font-mono">{spec.secrets.length}</span> secret
								<span class="text-muted-foreground">(Variables tab)</span>
							</dd>
							<dt>Data volume</dt>
							<dd class="font-mono text-sm">
								{spec.data ? `${spec.data.sizeMb} MB` : 'none'}
							</dd>
						</DetailList>
					{:else}
						<p class="text-sm text-muted-foreground">
							No spec saved. Configure the runtime to choose a command or image, port and memory
							budget. Environment variables live on the Variables tab.
						</p>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title class="flex items-center gap-2">
						<ServerIcon class="size-4 text-muted-foreground" />
						Node capacity
					</Card.Title>
					<Card.Description>
						Admission reserves memory from each node's <code class="font-mono text-xs"
							>skiff-workloads.slice</code
						>.
					</Card.Description>
				</Card.Header>
				<Card.Content class="py-4">
					{#if !can.viewCapacity}
						<p class="text-sm text-muted-foreground">
							Fleet capacity is visible to platform admins. Placement still resolves automatically
							at deploy time.
						</p>
					{:else if capacity.length === 0}
						<p class="text-sm text-muted-foreground">
							No nodes report a workload slice yet. Enrol a node and set its slice budget.
						</p>
					{:else}
						<div class="space-y-4">
							{#each capacity as item (item.nodeId)}
								{@const used = item.sliceMemoryMb - item.freeMemoryMb}
								{@const pct = item.sliceMemoryMb > 0 ? (used / item.sliceMemoryMb) * 100 : 0}
								<div class="space-y-1.5">
									<div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
										<span class="inline-flex items-center gap-1.5">
											<ServerIcon class="size-3 text-muted-foreground" />
											<span class="font-medium">{item.name}</span>
											<Badge variant="secondary" class="capitalize">{item.mode}</Badge>
											{#if workload?.nodeId === item.nodeId}
												<Badge variant="brand">this workload</Badge>
											{/if}
										</span>
										<span class="font-mono text-xs text-muted-foreground tabular-nums"
											>{item.freeMemoryMb} MB free · {item.workloadCount} workloads</span
										>
									</div>
									<Progress
										value={Math.min(100, Math.max(0, pct))}
										aria-label="Reserved slice memory on {item.name}"
										class="h-1.5"
									/>
								</div>
							{/each}
						</div>
					{/if}
				</Card.Content>
			</Card.Root>
		</div>
	</div>
{/if}

{#if can.manageWorkload && project.runtime !== 'static'}
	<FormDialog
		bind:open={editOpen}
		icon={CpuIcon}
		title="Configure runtime"
		description="These values are validated and recorded as the project's workload spec. Admission runs at deploy time."
		action="?/saveWorkload"
		submitLabel="Save runtime"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-3">
				<Field.Field class="sm:col-span-2">
					<Field.Label for="workload-port">Port</Field.Label>
					<Input
						id="workload-port"
						name="port"
						type="number"
						min="1"
						max="65535"
						bind:value={port}
					/>
					<Field.Description>The app must listen on this port.</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="workload-health">Health path</Field.Label>
					<Input id="workload-health" name="healthPath" bind:value={healthPath} placeholder="/" />
				</Field.Field>
			</div>

			{#if project.runtime === 'process'}
				<Field.Field>
					<Field.Label for="workload-command">Command</Field.Label>
					<Input
						id="workload-command"
						name="command"
						bind:value={command}
						placeholder="bun run start"
						class="font-mono text-sm"
					/>
					<Field.Description>
						Split on spaces and run without a shell; quotes are not interpreted. Leave blank to use
						<code class="font-mono">bun run start</code>.
					</Field.Description>
				</Field.Field>
				<Field.Field orientation="horizontal" class="gap-2">
					<Checkbox
						id="workload-socket"
						name="socketActivation"
						value="1"
						bind:checked={socketActivation}
					/>
					<Field.Label for="workload-socket" class="font-normal">
						Pass the listen socket with socket activation (recommended)
					</Field.Label>
				</Field.Field>
				<Field.Field>
					<Field.Label for="workload-idle-stop">Scale to zero after (seconds idle)</Field.Label>
					<Input
						id="workload-idle-stop"
						name="idleStopSeconds"
						type="number"
						min="0"
						max="86400"
						bind:value={idleStopSeconds}
						disabled={!socketActivation}
					/>
					<Field.Description>
						0 keeps the app always on. Otherwise the app is stopped after this long without a request
						and the next request starts it again. Needs socket activation, and the app must listen on
						the inherited socket (fd 3), as FrankenPHP, Gunicorn, Puma or Node can.
					</Field.Description>
				</Field.Field>
			{:else}
				<Field.Field>
					<Field.Label for="workload-image">Container image</Field.Label>
					<Input
						id="workload-image"
						name="image"
						bind:value={image}
						placeholder="ghcr.io/acme/app:latest"
						required
						class="font-mono text-sm"
					/>
					<Field.Description>
						Pulled rootlessly on the node. Use a digest or immutable tag for reproducible deploys.
					</Field.Description>
				</Field.Field>
			{/if}

			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="workload-memory">Memory (MB)</Field.Label>
					<Input
						id="workload-memory"
						name="memoryMb"
						type="number"
						min="32"
						max="8192"
						bind:value={memoryMb}
					/>
					<Field.Description
						>Reserved in the node slice and enforced with MemoryMax.</Field.Description
					>
				</Field.Field>
				<Field.Field>
					<Field.Label for="workload-cpu">vCPU</Field.Label>
					<Input
						id="workload-cpu"
						name="cpus"
						type="number"
						min="0.1"
						max="8"
						step="0.1"
						bind:value={cpus}
					/>
					<Field.Description>A CPU quota, not a hard pin.</Field.Description>
				</Field.Field>
			</div>

			<Field.Field orientation="horizontal" class="gap-2">
				<Checkbox id="workload-data" name="dataEnabled" value="1" bind:checked={dataEnabled} />
				<Field.Label for="workload-data" class="font-normal">
					Mount a persistent data directory at <code class="font-mono">/data</code>
				</Field.Label>
			</Field.Field>
			{#if dataEnabled}
				<Field.Field>
					<Field.Label for="workload-data-size">Data size (MB)</Field.Label>
					<Input
						id="workload-data-size"
						name="dataSizeMb"
						type="number"
						min="32"
						max="65536"
						bind:value={dataSizeMb}
					/>
					<Field.Description>
						A per-project directory. SQLite files are the intended default for tier 2 apps.
					</Field.Description>
				</Field.Field>
			{/if}
		</Field.Group>
	</FormDialog>
{/if}
