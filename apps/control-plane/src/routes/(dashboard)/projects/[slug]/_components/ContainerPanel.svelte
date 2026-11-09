<script lang="ts">
	import { browser } from '$app/env';
	import { createQuery } from '@tanstack/svelte-query';
	import type { ContainerInspect, ContainerStats, ContainerTarget } from '@yoal/contracts';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BoxIcon from '@lucide/svelte/icons/box';
	import CpuIcon from '@lucide/svelte/icons/cpu';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import LockIcon from '@lucide/svelte/icons/lock';
	import MemoryStickIcon from '@lucide/svelte/icons/memory-stick';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { errorText, fetchJson } from '#lib/query.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import {
		formatBytes,
		formatDateTime,
		formatDuration,
		formatRelative
	} from '../../../_lib/format.js';
	import ReplicaPicker from './ReplicaPicker.svelte';

	let {
		slug,
		cpus,
		replica = $bindable<number | null>(null),
		can,
		onOpen
	}: {
		slug: string;
		/** CPU limit from the workload, to scale the CPU reading. */
		cpus: number | null;
		replica?: number | null;
		can: { restart: boolean; files: boolean; exec: boolean };
		onOpen: (tab: 'shell' | 'files' | 'logs', path?: string) => void;
	} = $props();

	interface InspectResponse {
		targets: ContainerTarget[];
		container: ContainerInspect | null;
	}

	const query = createQuery(() => ({
		queryKey: ['container-inspect', slug, replica] as const,
		queryFn: ({ signal }) =>
			fetchJson<InspectResponse>(
				`/projects/${encodeURIComponent(slug)}/container/inspect${replica === null ? '' : `?replica=${replica}`}`,
				{ signal, cache: 'no-store' }
			),
		enabled: browser,
		refetchInterval: 3_000,
		staleTime: 0,
		retry: false
	}));

	const container = $derived(query.data?.container ?? null);
	const targets = $derived(query.data?.targets ?? []);

	/** Rates come from two consecutive samples of the node's raw counters. */
	let previous = $state<ContainerStats | null>(null);
	let rates = $state<{
		cpu: number | null;
		rx: number | null;
		tx: number | null;
		read: number | null;
		write: number | null;
	}>({
		cpu: null,
		rx: null,
		tx: null,
		read: null,
		write: null
	});
	$effect(() => {
		const current = container?.stats ?? null;
		if (!current) {
			previous = null;
			return;
		}
		const before = previous;
		if (before && before.sampledAt !== current.sampledAt) {
			const seconds = (Date.parse(current.sampledAt) - Date.parse(before.sampledAt)) / 1000;
			const rate = (a: number | null, b: number | null) =>
				a !== null && b !== null && seconds > 0 && b >= a ? (b - a) / seconds : null;
			const cpuRate = rate(before.cpuMicros, current.cpuMicros);
			rates = {
				cpu: cpuRate === null ? null : cpuRate / 10_000,
				rx: rate(before.netRxBytes, current.netRxBytes),
				tx: rate(before.netTxBytes, current.netTxBytes),
				read: rate(before.blockReadBytes, current.blockReadBytes),
				write: rate(before.blockWriteBytes, current.blockWriteBytes)
			};
		}
		if (!before || before.sampledAt !== current.sampledAt) previous = current;
	});

	const status = $derived.by(() => {
		if (!container) return 'unknown';
		if (!container.exists) return container.state.status;
		if (container.state.restarting) return 'restarting';
		if (container.state.paused) return 'paused';
		return container.state.running ? 'running' : container.state.status;
	});

	const uptime = $derived(
		container?.state.running && container.state.startedAt
			? Math.max(0, Math.floor((Date.now() - Date.parse(container.state.startedAt)) / 1000))
			: null
	);

	const memoryPct = $derived.by(() => {
		const stats = container?.stats;
		if (!stats?.memoryBytes || !stats.memoryLimitBytes) return null;
		return Math.min(100, (stats.memoryBytes / stats.memoryLimitBytes) * 100);
	});

	const cpuLimit = $derived(cpus && cpus > 0 ? cpus : null);

	function rate(value: number | null): string {
		return value === null ? '—' : `${formatBytes(value)}/s`;
	}

	function percent(value: number | null): string {
		if (value === null) return '—';
		return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
	}

	function cpuTime(micros: number): string {
		const seconds = micros / 1_000_000;
		if (seconds < 60) return `${seconds.toFixed(1)}s`;
		return formatDuration(Math.round(seconds));
	}

	function restart() {
		askConfirm({
			title: 'Restart the container?',
			description:
				'The node stops the container and starts it again from the same image and configuration. Open shells close, and requests fail for the few seconds it takes to come back.',
			confirmLabel: 'Restart',
			action: '?/restartContainer',
			onResult: () => {
				previous = null;
				void query.refetch();
			}
		});
	}
</script>

<div class="space-y-5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<ReplicaPicker {targets} bind:replica />
		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" onclick={() => onOpen('logs')}>
				<ScrollTextIcon />
				Logs
			</Button>
			{#if can.exec}
				<Button
					variant="outline"
					size="sm"
					onclick={() => onOpen('shell')}
					disabled={!container?.state.running}
				>
					<SquareTerminalIcon />
					Shell
				</Button>
			{/if}
			{#if can.files}
				<Button
					variant="outline"
					size="sm"
					onclick={() => onOpen('files')}
					disabled={!container?.state.running}
				>
					<FolderOpenIcon />
					Files
				</Button>
			{/if}
			{#if can.restart}
				<Button variant="outline" size="sm" onclick={restart} disabled={!container}>
					<RotateCcwIcon />
					Restart
				</Button>
			{/if}
		</div>
	</div>

	{#if query.isPending}
		<div class="grid gap-4 md:grid-cols-4">
			{#each [0, 1, 2, 3] as index (index)}
				<Skeleton class="h-24 rounded-xl" />
			{/each}
		</div>
		<Skeleton class="h-64 rounded-xl" />
	{:else if query.isError && !container}
		<EmptyState
			icon={TriangleAlertIcon}
			title="The container could not be inspected"
			description={errorText(query.error, 'The node did not answer.')}
		>
			<Button variant="outline" size="sm" onclick={() => query.refetch()}>Try again</Button>
		</EmptyState>
	{:else if container}
		{#if query.isError}
			<Alert.Root variant="warning">
				<TriangleAlertIcon />
				<Alert.Title>Showing the last reading</Alert.Title>
				<Alert.Description>{errorText(query.error, 'The node did not answer.')}</Alert.Description>
			</Alert.Root>
		{/if}
		{#if container.state.oomKilled || (container.stats?.oomKills ?? 0) > 0}
			<Alert.Root variant="destructive">
				<MemoryStickIcon />
				<Alert.Title>Out of memory</Alert.Title>
				<Alert.Description>
					The kernel killed a process in this container because it reached its memory limit{container
						.stats?.oomKills
						? ` (${container.stats.oomKills} time${container.stats.oomKills === 1 ? '' : 's'} since it started)`
						: ''}. Raise the memory budget under Runtime, or look for a leak.
				</Alert.Description>
			</Alert.Root>
		{/if}
		{#if !container.exists}
			<Alert.Root variant="warning">
				<TriangleAlertIcon />
				<Alert.Title>No container is running</Alert.Title>
				<Alert.Description>
					systemd reports the unit as {container.unit.activeState} ({container.unit.subState}) after
					{container.unit.restarts} restart{container.unit.restarts === 1 ? '' : 's'}. Check the
					logs for why it stopped.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="flex min-w-0 items-start gap-3">
						<span
							class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
						>
							<BoxIcon class="size-4" />
						</span>
						<div class="min-w-0 space-y-1">
							<Card.Title class="flex flex-wrap items-center gap-2">
								<span class="truncate font-mono text-sm">{container.name}</span>
								<StatusBadge {status} />
								{#if container.state.health}
									<Badge variant={container.state.health === 'healthy' ? 'success' : 'warning'}>
										{container.state.health}
									</Badge>
								{/if}
							</Card.Title>
							<Card.Description class="font-mono text-xs break-all">
								{container.image.name ?? 'image unknown'}
							</Card.Description>
						</div>
					</div>
					{#if uptime !== null}
						<div class="text-right text-xs text-muted-foreground">
							<div class="text-sm font-medium text-foreground tabular-nums">
								{formatDuration(uptime)}
							</div>
							up since {formatDateTime(container.state.startedAt)}
						</div>
					{/if}
				</div>
			</Card.Header>
			<Card.Content class="grid gap-x-8 py-2 md:grid-cols-2">
				<DetailList>
					<dt>Node</dt>
					<dd>
						{targets.find((target) => target.replica === replica)?.nodeName ??
							targets[0]?.nodeName ??
							'—'}
					</dd>
					<dt>Restarts</dt>
					<dd class="tabular-nums">{container.unit.restarts}</dd>
					<dt>Unit</dt>
					<dd class="font-mono text-xs">
						{container.unit.activeState} / {container.unit.subState}
					</dd>
					<dt>Last exit</dt>
					<dd class="tabular-nums">
						{#if container.state.finishedAt}
							code {container.state.exitCode ?? '—'} · {formatRelative(container.state.finishedAt)}
						{:else}
							—
						{/if}
					</dd>
				</DetailList>
				<DetailList>
					<dt>Image ID</dt>
					<dd class="truncate font-mono text-xs" title={container.image.id ?? ''}>
						{container.image.id ? container.image.id.slice(0, 12) : '—'}
					</dd>
					<dt>Digest</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						{#if container.image.digest}
							<span class="truncate" title={container.image.digest}
								>{container.image.digest.slice(0, 19)}…</span
							>
							<CopyButton
								value={container.image.digest}
								label="Copy digest"
								variant="ghost"
								iconOnly
							/>
						{:else}
							—
						{/if}
					</dd>
					<dt>User</dt>
					<dd class="font-mono text-xs">{container.config.user ?? 'image default'}</dd>
					<dt>Working dir</dt>
					<dd class="truncate font-mono text-xs">{container.config.workingDir ?? '/'}</dd>
				</DetailList>
				{#if container.state.error}
					<p class="col-span-full py-2 text-xs text-destructive">{container.state.error}</p>
				{/if}
			</Card.Content>
		</Card.Root>

		<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
			<Card.Root class="gap-2 py-4">
				<Card.Header class="px-4">
					<Card.Description class="flex items-center gap-1.5 text-xs"
						><CpuIcon class="size-3.5" />CPU</Card.Description
					>
					<Card.Title class="text-xl tabular-nums">{percent(rates.cpu)}</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-1.5 px-4 text-xs text-muted-foreground">
					{#if cpuLimit && rates.cpu !== null}
						<Progress value={Math.min(100, rates.cpu / cpuLimit)} class="h-1.5" />
						<p>
							of {cpuLimit} CPU{cpuLimit === 1 ? '' : 's'} · {cpuTime(
								container.stats?.cpuMicros ?? 0
							)} used
						</p>
					{:else}
						<p>
							{container.stats?.cpuMicros
								? `${cpuTime(container.stats.cpuMicros)} used`
								: 'Waiting for a second sample'}
						</p>
					{/if}
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-2 py-4">
				<Card.Header class="px-4">
					<Card.Description class="flex items-center gap-1.5 text-xs"
						><MemoryStickIcon class="size-3.5" />Memory</Card.Description
					>
					<Card.Title class="text-xl tabular-nums"
						>{formatBytes(container.stats?.memoryBytes ?? null)}</Card.Title
					>
				</Card.Header>
				<Card.Content class="space-y-1.5 px-4 text-xs text-muted-foreground">
					{#if memoryPct !== null}
						<Progress value={memoryPct} class="h-1.5" />
					{/if}
					<p>
						{container.stats?.memoryLimitBytes
							? `of ${formatBytes(container.stats.memoryLimitBytes)}`
							: 'no container limit'}
						{#if container.stats?.memoryPeakBytes}· peak {formatBytes(
								container.stats.memoryPeakBytes
							)}{/if}
					</p>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-2 py-4">
				<Card.Header class="px-4">
					<Card.Description class="flex items-center gap-1.5 text-xs"
						><NetworkIcon class="size-3.5" />Network</Card.Description
					>
					<Card.Title class="text-xl tabular-nums">↓ {rate(rates.rx)}</Card.Title>
				</Card.Header>
				<Card.Content class="px-4 text-xs text-muted-foreground">
					<p>↑ {rate(rates.tx)}</p>
					<p>
						{formatBytes(container.stats?.netRxBytes ?? null)} in · {formatBytes(
							container.stats?.netTxBytes ?? null
						)} out
					</p>
				</Card.Content>
			</Card.Root>
			<Card.Root class="gap-2 py-4">
				<Card.Header class="px-4">
					<Card.Description class="flex items-center gap-1.5 text-xs"
						><ActivityIcon class="size-3.5" />Processes</Card.Description
					>
					<Card.Title class="text-xl tabular-nums">
						{container.stats?.pids ?? container.processes.length}
						{#if container.stats?.pidsLimit}<span class="text-sm font-normal text-muted-foreground"
								>/ {container.stats.pidsLimit}</span
							>{/if}
					</Card.Title>
				</Card.Header>
				<Card.Content class="px-4 text-xs text-muted-foreground">
					<p class="flex items-center gap-1.5">
						<HardDriveIcon class="size-3" />read {rate(rates.read)} · write {rate(rates.write)}
					</p>
				</Card.Content>
			</Card.Root>
		</div>

		<Card.Root class="gap-0 py-0">
			<Card.Header class="border-b py-4">
				<Card.Title class="text-sm">Processes</Card.Title>
				<Card.Description
					>As the container sees them. CPU time is cumulative since each process started.</Card.Description
				>
			</Card.Header>
			{#if container.processes.length === 0}
				<p class="px-6 py-6 text-sm text-muted-foreground">No processes are running.</p>
			{:else}
				<div class="overflow-x-auto">
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="w-16 pl-6">PID</Table.Head>
								<Table.Head class="w-16">PPID</Table.Head>
								<Table.Head class="w-16">UID</Table.Head>
								<Table.Head class="w-12">State</Table.Head>
								<Table.Head class="w-24 text-right">CPU time</Table.Head>
								<Table.Head class="w-24 text-right">RSS</Table.Head>
								<Table.Head class="hidden w-32 lg:table-cell">Started</Table.Head>
								<Table.Head class="pr-6">Command</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each container.processes as process (process.pid)}
								<Table.Row>
									<Table.Cell class="pl-6 font-mono text-xs tabular-nums">{process.pid}</Table.Cell>
									<Table.Cell class="font-mono text-xs text-muted-foreground tabular-nums"
										>{process.ppid}</Table.Cell
									>
									<Table.Cell class="font-mono text-xs tabular-nums">{process.uid}</Table.Cell>
									<Table.Cell class="font-mono text-xs">{process.state}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums"
										>{cpuTime(process.cpuMicros)}</Table.Cell
									>
									<Table.Cell class="text-right font-mono text-xs tabular-nums"
										>{formatBytes(process.rssBytes)}</Table.Cell
									>
									<Table.Cell class="hidden text-xs text-muted-foreground lg:table-cell"
										>{formatRelative(process.startedAt)}</Table.Cell
									>
									<Table.Cell class="max-w-0 pr-6">
										<code class="block truncate font-mono text-xs" title={process.command}
											>{process.command}</code
										>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</Card.Root>

		<div class="grid gap-5 lg:grid-cols-2">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title class="text-sm">Configuration</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4 py-4">
					<DetailList>
						<dt>Entrypoint</dt>
						<dd class="font-mono text-xs break-all">
							{container.config.entrypoint.join(' ') || '—'}
						</dd>
						<dt>Command</dt>
						<dd class="font-mono text-xs break-all">{container.config.command.join(' ') || '—'}</dd>
						<dt>Hostname</dt>
						<dd class="font-mono text-xs">{container.config.hostname ?? '—'}</dd>
					</DetailList>
					<div class="space-y-2">
						<p class="text-xs font-medium text-muted-foreground">
							Environment · {container.config.envNames.length} variable{container.config.envNames
								.length === 1
								? ''
								: 's'}
						</p>
						<div class="flex flex-wrap gap-1">
							{#each container.config.envNames as name (name)}
								<Badge variant="outline" class="font-mono text-[11px]">{name}</Badge>
							{/each}
						</div>
						<p class="text-xs text-muted-foreground">
							Values stay on the node. Edit them under Variables, or read them from a shell.
						</p>
					</div>
					{#if Object.keys(container.config.labels).length > 0}
						<div class="space-y-2">
							<p class="text-xs font-medium text-muted-foreground">Image labels</p>
							<DetailList>
								{#each Object.entries(container.config.labels) as [key, value] (key)}
									<dt class="truncate font-mono text-xs" title={key}>{key}</dt>
									<dd class="truncate font-mono text-xs" title={value}>{value}</dd>
								{/each}
							</DetailList>
						</div>
					{/if}
				</Card.Content>
			</Card.Root>

			<div class="space-y-5">
				<Card.Root class="gap-0 py-0">
					<Card.Header class="border-b py-4">
						<Card.Title class="text-sm">Network</Card.Title>
					</Card.Header>
					<Card.Content class="py-2">
						<DetailList>
							{#each container.network.ports as port (port.container + port.host)}
								<dt class="font-mono text-xs">{port.container}</dt>
								<dd class="font-mono text-xs">{port.host}</dd>
							{/each}
							{#each container.network.networks as network (network.name)}
								<dt class="truncate font-mono text-xs" title={network.name}>{network.name}</dt>
								<dd class="font-mono text-xs">
									{network.ip ?? '—'}{network.aliases.length
										? ` · ${network.aliases.join(', ')}`
										: ''}
								</dd>
							{/each}
							{#if container.network.ports.length === 0 && container.network.networks.length === 0}
								<dt>Ports</dt>
								<dd>—</dd>
							{/if}
						</DetailList>
					</Card.Content>
				</Card.Root>

				<Card.Root class="gap-0 py-0">
					<Card.Header class="border-b py-4">
						<Card.Title class="text-sm">Mounts</Card.Title>
					</Card.Header>
					<Card.Content class="py-2">
						<ul class="divide-y text-sm">
							{#each container.mounts as mount (mount.destination)}
								<li class="flex items-center justify-between gap-3 py-2">
									<div class="min-w-0">
										{#if mount.browsable && can.files && container.state.running}
											<button
												type="button"
												class="truncate font-mono text-xs underline-offset-4 hover:underline"
												onclick={() => onOpen('files', mount.destination)}
											>
												{mount.destination}
											</button>
										{:else}
											<span class="truncate font-mono text-xs">{mount.destination}</span>
										{/if}
										<p class="text-xs text-muted-foreground">
											{mount.type}{mount.note === 'secrets'
												? ' · secret files, hidden'
												: mount.note === 'tmpfs'
													? ' · in memory'
													: ''}
										</p>
									</div>
									<Badge variant={mount.readOnly ? 'neutral' : 'outline'}
										>{mount.readOnly ? 'read-only' : 'read-write'}</Badge
									>
								</li>
							{/each}
						</ul>
					</Card.Content>
				</Card.Root>

				<Card.Root class="gap-0 py-0">
					<Card.Header class="border-b py-4">
						<Card.Title class="flex items-center gap-2 text-sm"
							><ShieldCheckIcon class="size-4" />Sandbox</Card.Title
						>
					</Card.Header>
					<Card.Content class="py-2">
						<DetailList>
							<dt>Root filesystem</dt>
							<dd class="flex items-center justify-end gap-1.5">
								{#if container.security.readOnlyRootfs}<LockIcon
										class="size-3"
									/>read-only{:else}writable{/if}
							</dd>
							<dt>Capabilities</dt>
							<dd class="font-mono text-xs">
								{container.security.capAdd.length ? `+${container.security.capAdd.join(' +')}` : ''}
								{container.security.capDrop.length
									? `dropped: ${container.security.capDrop.join(', ')}`
									: 'default'}
							</dd>
							<dt>New privileges</dt>
							<dd>{container.security.noNewPrivileges ? 'blocked' : 'allowed'}</dd>
						</DetailList>
					</Card.Content>
				</Card.Root>
			</div>
		</div>
	{/if}
</div>
