<script lang="ts">
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ChartAreaIcon from '@lucide/svelte/icons/chart-area';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FeatherIcon from '@lucide/svelte/icons/feather';
	import MemoryStickIcon from '@lucide/svelte/icons/memory-stick';
	import RotateCwIcon from '@lucide/svelte/icons/rotate-cw';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { resolve } from '$app/paths';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
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

	const badge = $derived(
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
			description: `Yoal downloads ClickHouse 26.8 LTS (about 240 MB, checksum-verified) and runs it on 127.0.0.1 only, with a ${t.memory.defaultMb} MiB memory ceiling (typically 300–800 MB in use; adjustable afterwards). This host has ${formatBytes(t.host.totalMemoryBytes)} of RAM. The dashboard restarts for a few seconds when it is ready.`,
			confirmLabel: 'Install',
			action: '?/install'
		});
	}

	const MIB = 1024 ** 2;
	const ceilingMb = $derived(t.memory.configuredMb ?? t.memory.defaultMb);
	/** The unit's hard limit (MemoryMax) is 4/3 of the ceiling. */
	const hardLimitMb = (mb: number) => Math.ceil((mb * 4) / 3);
	/** Leave the host three quarters of its RAM for everything else (matches the server check). */
	const maxForHostMb = $derived(
		Math.min(t.memory.maxMb, Math.floor(((t.host.totalMemoryBytes * 0.75) / MIB) * 0.75))
	);
	let memoryMb = $state<number | null>(null);
	$effect(() => {
		memoryMb = ceilingMb;
	});
	const memoryValid = $derived(
		memoryMb !== null &&
			Number.isInteger(memoryMb) &&
			memoryMb >= t.memory.minMb &&
			memoryMb <= maxForHostMb
	);
	const memoryChanged = $derived(memoryMb !== ceilingMb);
	/** ClickHouse refuses work once it reaches this share of its ceiling. */
	const nearCeiling = $derived(t.stats ? t.stats.memoryBytes > ceilingMb * MIB * 0.9 : false);

	function applyMemory(reset = false) {
		const mb = reset ? t.memory.defaultMb : memoryMb!;
		askConfirm({
			title: `Restart ClickHouse with a ${mb} MiB memory ceiling?`,
			description: `ClickHouse refuses queries and inserts past ${mb} MiB, and systemd stops it at ${hardLimitMb(mb)} MiB. Per-query limits scale with it (writer ${Math.floor((mb * 2) / 3)} MiB, ad-hoc SQL ${Math.floor(mb / 3)} MiB). ClickHouse restarts and telemetry pauses for a few seconds; if it does not come back, the previous ceiling is restored.`,
			confirmLabel: 'Restart with new ceiling',
			action: '?/memory',
			fields: reset ? { reset: 'true' } : { memoryMb: String(mb) }
		});
	}

	function restart() {
		askConfirm({
			title: 'Restart ClickHouse?',
			description:
				'Its configuration is unchanged. Telemetry pauses for a few seconds; agents re-send any minute that is missed.',
			confirmLabel: 'Restart',
			action: '?/restart'
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

<svelte:head><title>Telemetry · Settings · Yoal</title></svelte:head>

<SettingsHeader id="telemetry" />

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['telemetry', 'telemetry-memory', 'telemetry-restart']}
	/>

	<Panel
		title="Telemetry store"
		description="ClickHouse holds request buckets from the edge agents and samples from managed databases and storage. Traffic charts, the stats tabs and Dashboards read from it."
		icon={ActivityIcon}
	>
		{#snippet actions()}
			<StatusBadge status={badge.label} tone={badge.tone} />
		{/snippet}

		{#if !t.installed && !t.unitPresent}
			<EmptyState
				icon={FeatherIcon}
				title="Off, to keep this install light"
				description="Without it, Yoal runs as before but has no request history: traffic charts, database and storage stats and dashboards stay empty. Agents keep working and nothing else changes."
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
					<dd>300–800 MB typical, {t.memory.defaultMb} MiB ceiling by default (adjustable)</dd>
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
						<p>
							{t.error} Check <code>systemctl status yoal-clickhouse</code> on the server (docs/OPS.md
							§3.6).
						</p>
						{#if /MEMORY_LIMIT_EXCEEDED|memory limit exceeded/i.test(t.error)}
							<p>
								It hit its {ceilingMb} MiB memory ceiling. Raise it under Memory below, which also restarts
								it.
							</p>
						{/if}
						{#if !local}
							<Button
								onclick={restart}
								disabled={!canChange}
								size="sm"
								variant="outline"
								class="mt-2"
							>
								<RotateCwIcon />Restart ClickHouse
							</Button>
						{/if}
					</Alert.Description>
				</Alert.Root>
			{:else if !t.installed}
				<Alert.Root variant="warning" class="mb-4">
					<TriangleAlertIcon />
					<Alert.Title>Installed, but this control plane is not connected</Alert.Title>
					<Alert.Description>
						The ClickHouse unit exists but the <code>YOAL_CLICKHOUSE_*</code> settings are missing. Install
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
						<span class={nearCeiling ? 'text-destructive' : ''}
							>{t.stats ? formatBytes(t.stats.memoryBytes) : '—'}</span
						>
						<span class="text-muted-foreground"
							>of {ceilingMb} MiB ceiling · {formatBytes(t.host.totalMemoryBytes)} RAM</span
						>
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
					{#if t.unitPresent}
						<Button onclick={restart} disabled={!canChange} variant="outline" size="sm">
							<RotateCwIcon />Restart
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

	{#if t.installed || t.unitPresent}
		<Panel
			title="Memory"
			description="ClickHouse refuses queries and inserts once it reaches this ceiling (MEMORY_LIMIT_EXCEEDED). Per-query limits and the merge budget scale with it, and systemd stops the process at 4/3 of it."
			icon={MemoryStickIcon}
		>
			<div class="flex flex-wrap items-end gap-3">
				<Field.Field class="w-48">
					<Field.Label for="telemetry-memory">Memory ceiling (MiB)</Field.Label>
					<Input
						id="telemetry-memory"
						type="number"
						min={t.memory.minMb}
						max={maxForHostMb}
						step={64}
						bind:value={memoryMb}
						disabled={local}
					/>
				</Field.Field>
				{#if !local}
					<Button
						onclick={() => applyMemory()}
						disabled={!canChange || !memoryValid || !memoryChanged}
						size="sm"
					>
						Apply and restart
					</Button>
					{#if t.memory.configuredMb !== null}
						<Button
							onclick={() => applyMemory(true)}
							disabled={!canChange}
							variant="ghost"
							size="sm"
						>
							Reset to {t.memory.defaultMb} MiB
						</Button>
					{/if}
				{/if}
			</div>
			<p class="mt-3 text-xs text-muted-foreground">
				{#if memoryValid && memoryMb !== null}
					Hard limit {hardLimitMb(memoryMb)} MiB · writer queries {Math.floor((memoryMb * 2) / 3)} MiB
					· ad-hoc SQL {Math.floor(memoryMb / 3)} MiB.
				{:else}
					Between {t.memory.minMb} and {maxForHostMb} MiB on this host ({formatBytes(
						t.host.totalMemoryBytes
					)} RAM).
				{/if}
				{t.memory.configuredMb === null
					? `Using the default (${t.memory.defaultMb} MiB).`
					: `Set in /etc/yoal/yoal.env as YOAL_CLICKHOUSE_MEMORY_MB.`}
				{#if local}
					Dev server: <code class="font-mono">bun run dev:clickhouse --memory &lt;MiB&gt;</code>.
				{/if}
			</p>
		</Panel>
	{/if}

	{#if !local && data.availability !== 'ready'}
		<p class="text-sm text-muted-foreground">
			{#if data.availability === 'not-enabled'}
				Dashboard settings are not enabled on this host yet. Run <code
					>sudo yoal-update-self check</code
				>
				once, or use <code>sudo yoal-platform-config telemetry on</code>.
			{:else}
				This control plane is not an installed release; install ClickHouse with
				<code>sudo yoal-platform-config telemetry on</code> on the server.
			{/if}
		</p>
	{/if}
</div>
