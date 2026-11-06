<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolve } from '$app/paths';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDuration } from '../../_lib/format.js';
	import ConfigProgress from '../ConfigProgress.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const t = $derived(data.telemetry);
	const local = $derived(data.availability === 'local');
	const canChange = $derived(data.availability === 'ready' && !data.inFlight);
	/** Below this the store competes with workloads for memory on a typical node. */
	const SMALL_HOST = 2 * 1024 ** 3;
	const smallHost = $derived(t.host.totalMemoryBytes < SMALL_HOST);

	const state = $derived(
		!t.installed && !t.unitPresent
			? { label: 'Not installed', tone: 'neutral' as const }
			: t.available
				? { label: 'Running', tone: 'success' as const }
				: t.installed
					? { label: 'Unreachable', tone: 'danger' as const }
					: { label: 'Half installed', tone: 'warning' as const }
	);

	function install() {
		askConfirm({
			title: 'Install the telemetry store?',
			description: `Skiff downloads ClickHouse 26.8 LTS (about 240 MB, checksum-verified) and runs it on 127.0.0.1 only, capped at 1 GB of memory (typically 300–800 MB in use). This host has ${formatBytes(t.host.totalMemoryBytes)} of RAM. The dashboard restarts for a few seconds when it is ready.`,
			confirmLabel: 'Install',
			action: '?/install'
		});
	}

	function remove(purge: boolean) {
		askConfirm({
			title: purge ? 'Remove ClickHouse and delete its data?' : 'Remove the telemetry store?',
			description: purge
				? 'ClickHouse is stopped and uninstalled, and every stored traffic, database and storage sample is deleted. Daily Parquet archives already in R2 are kept. This cannot be undone.'
				: 'ClickHouse is stopped and uninstalled, freeing its memory. Stored telemetry stays on disk, so reinstalling picks up where it left off. Traffic charts and dashboards show “not installed” until then.',
			confirmLabel: purge ? 'Remove and delete' : 'Remove',
			tone: 'danger',
			typeToConfirm: purge ? 'delete' : undefined,
			action: '?/remove',
			fields: { purgeData: purge ? 'true' : 'false' }
		});
	}
</script>

<svelte:head><title>Telemetry · Settings · Skiff</title></svelte:head>

<SettingsHeader id="telemetry" />

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['telemetry']}
	/>

	<Panel
		title="Telemetry store"
		description="ClickHouse holds request buckets from the edge agents and samples from managed databases and storage. Traffic charts, the stats tabs and Dashboards read from it."
		icon={ActivityIcon}
	>
		{#snippet actions()}
			<StatusBadge status={state.label} tone={state.tone} />
		{/snippet}

		{#if !t.installed && !t.unitPresent}
			<EmptyState
				icon={FeatherIcon}
				title="Off, to keep this install light"
				description="Without it, Skiff runs as before but has no request history: traffic charts, database and storage stats and dashboards stay empty. Agents keep working and nothing else changes."
			>
				{#if local}
					<p class="text-sm text-muted-foreground">
						On a dev server run <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs"
							>bun run dev:clickhouse --background</code
						>, then restart
						<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">bun run dev</code>.
					</p>
				{:else}
					<Button onclick={install} disabled={!canChange}>
						<DownloadIcon />Install ClickHouse
					</Button>
				{/if}
			</EmptyState>

			<dl class="mt-6 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Download</dt>
					<dd>~240 MB, once (pinned ClickHouse 26.8 LTS)</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Memory</dt>
					<dd>300–800 MB typical, capped at 1 GB</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">This host</dt>
					<dd>
						{formatBytes(t.host.totalMemoryBytes)} RAM · {formatBytes(t.host.freeMemoryBytes)} free
					</dd>
				</div>
			</dl>
			{#if smallHost && !local}
				<Alert.Root variant="warning" class="mt-4">
					<TriangleAlertIcon />
					<Alert.Title>This host has under 2 GB of RAM</Alert.Title>
					<Alert.Description>
						ClickHouse would take a large share of it from your workloads. It still works, but
						consider a bigger node first.
					</Alert.Description>
				</Alert.Root>
			{/if}
		{:else}
			{#if t.error}
				<Alert.Root variant="destructive" class="mb-4">
					<TriangleAlertIcon />
					<Alert.Title>ClickHouse is not answering</Alert.Title>
					<Alert.Description>
						{t.error} Check <code>systemctl status skiff-clickhouse</code> on the server (docs/OPS.md
						§3.6).
					</Alert.Description>
				</Alert.Root>
			{:else if !t.installed}
				<Alert.Root variant="warning" class="mb-4">
					<TriangleAlertIcon />
					<Alert.Title>Installed, but this control plane is not connected</Alert.Title>
					<Alert.Description>
						The ClickHouse unit exists but the <code>SKIFF_CLICKHOUSE_*</code> settings are missing. Install
						again to repair it, or remove it.
					</Alert.Description>
				</Alert.Root>
			{/if}

			<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Version</dt>
					<dd class="font-mono">{t.stats?.version ?? '—'}</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Memory in use</dt>
					<dd>
						{t.stats ? formatBytes(t.stats.memoryBytes) : '—'}
						<span class="text-muted-foreground">of {formatBytes(t.host.totalMemoryBytes)} RAM</span>
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Stored</dt>
					<dd>
						{t.stats ? formatBytes(t.stats.bytesOnDisk) : '—'}
						<span class="text-muted-foreground"
							>{t.stats ? `· ${t.stats.rows.toLocaleString('en-GB')} rows` : ''}</span
						>
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Up for</dt>
					<dd>{t.stats ? formatDuration(t.stats.uptimeSeconds) : '—'}</dd>
				</div>
				<div class="space-y-1 sm:col-span-2">
					<dt class="text-xs text-muted-foreground">Retention</dt>
					<dd>
						{t.retention.minuteHours} h at 1-minute resolution, {t.retention.hourDays} days hourly
					</dd>
				</div>
				<div class="space-y-1 sm:col-span-2">
					<dt class="text-xs text-muted-foreground">Listening</dt>
					<dd class="font-mono">127.0.0.1:18123 (loopback only)</dd>
				</div>
			</dl>

			<div class="mt-6 flex flex-wrap items-center gap-2">
				<Button href={resolve('/(dashboard)/dashboards')} variant="outline" size="sm">
					<ChartAreaIcon />Open dashboards
				</Button>
				{#if local}
					<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
						<TerminalIcon class="size-3.5" />Dev server: stop it with
						<code class="font-mono">bun run dev:clickhouse --stop</code>
					</p>
				{:else}
					{#if !t.installed}
						<Button onclick={install} disabled={!canChange} size="sm">
							<DownloadIcon />Repair
						</Button>
					{/if}
					<Button onclick={() => remove(false)} disabled={!canChange} variant="outline" size="sm">
						<Trash2Icon />Remove
					</Button>
					<Button
						onclick={() => remove(true)}
						disabled={!canChange}
						variant="ghost"
						size="sm"
						class="text-destructive"
					>
						Remove and delete data
					</Button>
				{/if}
			</div>
		{/if}
	</Panel>

	{#if !local && data.availability !== 'ready'}
		<p class="text-sm text-muted-foreground">
			{#if data.availability === 'not-enabled'}
				Dashboard settings are not enabled on this host yet. Run <code
					>sudo skiff-update-self check</code
				>
				once, or use <code>sudo skiff-platform-config telemetry on</code>.
			{:else}
				This control plane is not an installed release; install ClickHouse with
				<code>sudo skiff-platform-config telemetry on</code> on the server.
			{/if}
		</p>
	{/if}
</div>
