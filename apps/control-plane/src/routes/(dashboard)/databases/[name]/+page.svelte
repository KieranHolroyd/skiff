<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CableIcon from '@lucide/svelte/icons/cable';
	import CloudUploadIcon from '@lucide/svelte/icons/cloud-upload';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TableIcon from '@lucide/svelte/icons/table';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { databaseEnvNames, databaseExtensionAllowlist, type DatabaseCredentials } from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import MetricChart from '#lib/components/skiff/MetricChart.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import PageHeader from '../../_lib/PageHeader.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDate, formatDateTime, formatDuration } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import StorageMeter from '../_lib/StorageMeter.svelte';
	import { databaseChart, databaseTotals } from '../_lib/database-series.js';
	import type { PageProps } from './$types';

	interface DatabaseFormResult {
		message?: string;
		success?: string;
		warning?: string | null;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as DatabaseFormResult | null);
	const errors = $derived(result?.fieldErrors ?? {});

	const db = $derived(data.database);
	const deleted = $derived(db.deletedAt !== null);
	const nodeLabel = $derived(db.nodeName ?? db.nodeId);
	const hostPort = $derived(db.internalHost.process.split(':').at(-1) ?? '');
	const defaultEnvNames = $derived([
		...databaseEnvNames('DATABASE'),
		...(db.pooler.enabled ? ['DATABASE_POOL_URL', 'DATABASE_POOL_HOST', 'DATABASE_POOL_PORT'] : [])
	]);

	// --- credentials (D58): revealed on demand, audited, never in page data -------------------

	let credentials = $state<DatabaseCredentials | null>(null);
	let revealing = $state(false);
	let showPassword = $state(false);

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success') {
			credentials =
				(outcome.data as { credentials?: DatabaseCredentials } | undefined)?.credentials ?? null;
			showPassword = false;
		}
	}

	function hide() {
		credentials = null;
		showPassword = false;
	}

	function restart(target: 'database' | 'pooler') {
		askConfirm({
			title: target === 'pooler' ? `Restart the pooler for ${db.name}?` : `Restart ${db.name}?`,
			description:
				target === 'pooler'
					? 'Only PgBouncer restarts. Postgres and its existing connections are untouched; apps reconnect through the pooler in a few seconds.'
					: 'The database container and its pooler restart. Attached apps lose their connections briefly and reconnect when the database is back.',
			confirmLabel: 'Restart',
			tone: 'danger',
			action: '?/restart',
			fields: { target }
		});
	}

	function rotate(role: 'owner' | 'monitor') {
		askConfirm({
			title: `Rotate the ${role} password?`,
			description:
				'The node runs ALTER ROLE and verifies the new password before Skiff swaps the stored secret. Attached apps restart with the new value; a failed rotation leaves the old one working.',
			confirmLabel: 'Rotate',
			tone: 'danger',
			action: '?/rotate',
			fields: { role }
		});
	}

	const mask = (value: string) => '•'.repeat(Math.min(24, Math.max(12, value.length)));
	const maskedUrl = $derived(
		credentials
			? credentials.url.replace(`:${encodeURIComponent(credentials.password)}@`, ':••••••••@')
			: ''
	);

	// --- attachments ---------------------------------------------------------------------------

	let attachOpen = $state(false);
	let attachPrefix = $state('DATABASE');

	function openAttach() {
		attachPrefix = 'DATABASE';
		attachOpen = true;
	}

	function detach(slug: string, prefix: string) {
		askConfirm({
			title: `Detach ${db.name} from ${slug}?`,
			description: `${slug} restarts without ${prefix}_URL and the other ${prefix}_* variables. The database and its data are untouched.`,
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detach',
			fields: { project: slug }
		});
	}

	// --- backups -------------------------------------------------------------------------------

	const backups = $derived(data.backups);
	const backupPolicy = $derived(db.backup);
	let restoreOpen = $state(false);
	let restoreBackupId = $state('');
	let restoreBackupName = $state('');

	function openRestore(backupId: string) {
		restoreBackupId = backupId;
		restoreBackupName = `${db.name}-restored`;
		restoreOpen = true;
	}

	function deleteBackup(backupId: string) {
		askConfirm({
			title: `Delete backup ${backupId}?`,
			description: 'The dump is removed from the object store. A restore of it is no longer possible.',
			confirmLabel: 'Delete backup',
			tone: 'danger',
			action: '?/delete-backup',
			fields: { backupId }
		});
	}

	// --- metrics -------------------------------------------------------------------------------

	const numberFormat = new Intl.NumberFormat('en-GB');
	const rateFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});

	const windowFrom = $derived(Date.parse(data.range.from));
	const windowTo = $derived(Date.parse(data.range.to) + 60_000);
	const chart = $derived(
		databaseChart(data.metrics, data.range.interval, { from: windowFrom, to: windowTo })
	);
	const totals = $derived(databaseTotals(data.metrics));
	const chartBuckets = $derived(chart.buckets);
	const maxConnections = $derived(
		chartBuckets.reduce((top, bucket) => Math.max(top, bucket.maxConnections), 0)
	);
	const ratePer = $derived(
		chart.span > 1 ? `per minute · ${chart.spanLabel} averages` : 'per minute'
	);

	const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
	const rate = (value: number) => rateFormat.format(value);
	const count = (value: number) =>
		value >= 10_000 ? compactFormat.format(value) : rateFormat.format(value);

	const kpis = $derived([
		{
			label: 'Size',
			value: formatBytes(totals.latestSizeBytes ?? db.sizeBytes),
			caption: `of ${formatBytes(db.storageMb * 1024 * 1024)} budget`
		},
		{
			label: 'Connections',
			value:
				totals.latestConnections === null ? '—' : numberFormat.format(totals.latestConnections),
			caption: totals.maxConnections
				? `of ${numberFormat.format(totals.maxConnections)} max`
				: 'latest'
		},
		{
			label: 'Transactions',
			value: compactFormat.format(totals.commits + totals.rollbacks),
			caption: `${numberFormat.format(totals.rollbacks)} rolled back`
		},
		{
			label: 'Cache hit ratio',
			value: totals.cacheHitRatio === null ? '—' : percent(totals.cacheHitRatio),
			caption:
				totals.deadlocks > 0 ? `${numberFormat.format(totals.deadlocks)} deadlocks` : 'buffer cache'
		}
	]);

	// --- tables / misc -------------------------------------------------------------------------

	function ago(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return 'never';
		return `${formatDuration(Math.max(0, (Date.now() - ms) / 1000))} ago`;
	}

	// --- settings and danger zone --------------------------------------------------------------

	let resizeOpen = $state(false);

	function deleteDatabase() {
		askConfirm({
			title: `Delete ${db.name}?`,
			description:
				db.attachments.length > 0
					? `It is attached to ${db.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first; the delete will be refused until then.`
					: 'The container stops and the database moves to the trash for 7 days. Its data stays on the node, so a restore is lossless.',
			confirmLabel: 'Move to trash',
			tone: 'danger',
			typeToConfirm: db.name,
			action: '?/delete'
		});
	}

	function restore() {
		void runAction('?/restore');
	}

	function purge() {
		askConfirm({
			title: `Delete ${db.name} permanently?`,
			description:
				'Its node deletes the data directory and the database is gone for good. This cannot be undone.',
			confirmLabel: 'Delete permanently',
			tone: 'danger',
			typeToConfirm: db.name,
			action: '?/purge'
		});
	}

	const created = $derived(page.url.searchParams.get('created') === '1');
	function dismissCreated() {
		const href = resolve('/(dashboard)/databases/[name]', { name: db.name });
		void goto(href, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>{db.name} · Databases · Skiff</title>
</svelte:head>

<div class="space-y-6">
	<PageHeader eyebrow="Database" title={db.name} target="page.database">
		{#snippet meta()}
			<div class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				{#if deleted}
					<StatusBadge status="deleted" />
				{:else}
					<StatusBadge status={db.status} />
				{/if}
				<Badge variant="outline">{db.engineLabel} {db.version}</Badge>
				<span class="font-mono text-xs">on {nodeLabel}</span>
				<span aria-hidden="true">·</span>
				<span class="text-xs">
					Created <time datetime={db.createdAt}>{formatDate(db.createdAt)}</time>
				</span>
			</div>
		{/snippet}
		<Button
			variant="outline"
			href={resolve('/(dashboard)/databases/[name]/logs', { name: db.name })}
		>
			<TerminalIcon />
			Logs
		</Button>
	</PageHeader>

	{#if deleted}
		<Notice tone="warning" title="This database is in the trash">
			The container is stopped and its data is kept on {nodeLabel}.
			{purgeCountdown(db.purgeAt)}.
			{#if data.dbCan.delete}
				<span class="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
					<Button size="sm" variant="destructive" onclick={purge}>
						<TrashIcon />Delete permanently
					</Button>
				</span>
			{/if}
		</Notice>
	{:else}
		{#if created}
			<Notice tone="success" title="Database created">
				{nodeLabel} pulls the {db.engineLabel}
				{db.version} image and initialises the cluster; the first start can take a minute.
				<Button variant="link" size="sm" class="h-auto p-0" onclick={dismissCreated}>Dismiss</Button
				>
			</Notice>
		{/if}
		{#if db.message}
			<Notice tone={db.status === 'failed' ? 'danger' : 'warning'}>{db.message}</Notice>
		{/if}
	{/if}

	<div class="grid items-start gap-5 xl:grid-cols-2">
		<!-- Connection ------------------------------------------------------------------------ -->
		<Panel
			title="Connection"
			icon={CableIcon}
			description="Attached apps on {nodeLabel} receive these as environment variables at start-up."
		>
			{#snippet actions()}
				{#if data.dbCan.credentials && !deleted}
					{#if credentials}
						<Button variant="outline" size="sm" onclick={hide}><EyeOffIcon />Hide</Button>
					{:else}
						<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
							{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
							Reveal credentials
						</Button>
					{/if}
					<Button variant="ghost" size="sm" onclick={() => rotate('owner')}>
						<RotateCcwIcon />Rotate
					</Button>
				{/if}
			{/snippet}

			<DetailList>
				<dt>Database</dt>
				<dd class="font-mono text-xs">{db.databaseName}</dd>
				<dt>User</dt>
				<dd class="font-mono text-xs">{db.username}</dd>
				<dt>Process apps</dt>
				<dd class="flex items-center justify-end gap-1 font-mono text-xs">
					<span class="truncate">{db.internalHost.process}</span>
					<CopyButton value={db.internalHost.process} label="Copy host" iconOnly />
				</dd>
				<dt>Container apps</dt>
				<dd class="flex items-center justify-end gap-1 font-mono text-xs">
					<span class="truncate">{db.internalHost.container}</span>
					<CopyButton value={db.internalHost.container} label="Copy host" iconOnly />
				</dd>
				{#if db.pooler.enabled}
					<dt>Pooled (process)</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate">{db.pooler.host.process}</span>
						<CopyButton value={db.pooler.host.process} label="Copy pooler host" iconOnly />
					</dd>
					<dt>Pooled (container)</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate">{db.pooler.host.container}</span>
						<CopyButton value={db.pooler.host.container} label="Copy pooler host" iconOnly />
					</dd>
				{/if}
				{#if credentials}
					<dt>Password</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate">
							{showPassword ? credentials.password : mask(credentials.password)}
						</span>
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label={showPassword ? 'Hide password' : 'Show password'}
							onclick={() => (showPassword = !showPassword)}
						>
							{#if showPassword}<EyeOffIcon />{:else}<EyeIcon />{/if}
						</Button>
						<CopyButton value={credentials.password} label="Copy password" iconOnly />
					</dd>
					<dt>URL</dt>
					<dd class="flex items-center justify-end gap-1 font-mono text-xs">
						<span class="truncate" title="Copy to see the full URL">
							{showPassword ? credentials.url : maskedUrl}
						</span>
						<CopyButton value={credentials.url} label="Copy URL" iconOnly />
					</dd>
				{/if}
			</DetailList>

			<div class="mt-4 space-y-1.5">
				<p class="text-xs text-muted-foreground">
					Env vars an attached app receives (with its prefix, default <code class="font-mono"
						>DATABASE</code
					>):
				</p>
				<div class="flex flex-wrap gap-1.5">
					{#each defaultEnvNames as name (name)}
						<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
					{/each}
				</div>
			</div>

			{#snippet footer()}
				<span class="flex items-start gap-2">
					<TerminalIcon class="mt-0.5 size-3.5 shrink-0" />
					<span>
						{#if credentials}
							{credentials.note}
						{:else}
							Listens on loopback on node “{nodeLabel}” only, never on a public or WireGuard
							address. From elsewhere, tunnel:
							<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>.
						{/if}
						{#if !data.dbCan.credentials}
							Revealing the password needs the <code class="font-mono">database:credentials</code>
							permission.
						{/if}
					</span>
				</span>
			{/snippet}
		</Panel>

		<!-- Attachments ----------------------------------------------------------------------- -->
		<Panel
			title="Attached projects"
			icon={PlugIcon}
			count={db.attachments.length}
			description="Apps run on the database's node (D56). Attaching or detaching restarts the app; no redeploy needed."
			flush
		>
			{#snippet actions()}
				{#if data.dbCan.attach && !deleted && data.projects.length > 0}
					<Button size="sm" variant="outline" onclick={openAttach}><PlusIcon />Attach</Button>
				{/if}
			{/snippet}

			{#if result?.warning}
				<div class="px-4 pt-4">
					<Notice tone="warning">{result.warning}</Notice>
				</div>
			{/if}

			{#if db.attachments.length === 0}
				<div class="p-4">
					<EmptyState
						icon={UnplugIcon}
						compact
						title="Not attached"
						description="Attach a process or container project to inject the connection env. Static projects can't use a database."
					>
						{#if data.dbCan.attach && !deleted && data.projects.length > 0}
							<Button size="sm" onclick={openAttach}><PlusIcon />Attach a project</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Project</Table.Head>
							<Table.Head>Env</Table.Head>
							<Table.Head class="hidden sm:table-cell">Attached</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each db.attachments as attachment (attachment.projectId)}
							<Table.Row>
								<Table.Cell class="pl-4">
									<a
										href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
										class="inline-flex items-center gap-1.5 font-mono text-xs font-medium underline-offset-4 hover:underline"
									>
										<FolderKanbanIcon class="size-3.5 text-muted-foreground" />
										{attachment.projectSlug}
									</a>
								</Table.Cell>
								<Table.Cell>
									<span class="font-mono text-xs" title={attachment.envNames.join(', ')}>
										{attachment.envPrefix}_URL
										<span class="text-muted-foreground">+{attachment.envNames.length - 1}</span>
									</span>
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
									<time datetime={attachment.createdAt}>{formatDate(attachment.createdAt)}</time>
								</Table.Cell>
								<Table.Cell class="pr-4 text-right">
									{#if data.dbCan.attach}
										<Button
											variant="ghost-danger"
											size="icon-sm"
											aria-label="Detach from {attachment.projectSlug}"
											onclick={() => detach(attachment.projectSlug, attachment.envPrefix)}
										>
											<UnplugIcon />
										</Button>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>
	</div>

	<!-- Backups --------------------------------------------------------------------------------- -->
	<Panel
		title="Backups"
		description="Logical dumps streamed to the platform object store. Restores always create a new database and verify it."
	>
		{#snippet actions()}
			{#if data.dbCan.update && !deleted}
				<form method="POST" action="?/backup">
					<Button size="sm" variant="outline" type="submit"><CloudUploadIcon />Back up now</Button>
				</form>
			{/if}
		{/snippet}
		{#if backupPolicy}
			<div class="flex flex-wrap items-center gap-3 border-b px-4 py-3 text-xs text-muted-foreground">
				<span>
					{backupPolicy.enabled ? 'Scheduled' : 'Paused'} · <span class="font-mono">{backupPolicy.schedule}</span> UTC
					· {backupPolicy.retentionDays}-day retention
				</span>
				{#if backupPolicy.nextBackupAt}
					<span>Next {formatDateTime(backupPolicy.nextBackupAt)}</span>
				{/if}
				<span>
					Last verified restore:
					{backupPolicy.lastVerifiedAt ? formatDateTime(backupPolicy.lastVerifiedAt) : 'never'}
				</span>
				{#if backupPolicy.lastBackupError}
					<span class="text-destructive">{backupPolicy.lastBackupError}</span>
				{/if}
			</div>
		{/if}
		{#if backups.length === 0}
			<div class="p-4">
				<EmptyState
					icon={ArchiveIcon}
					compact
					title="No backups yet"
					description="Take one now, or wait for the daily schedule. A dump that has never been restored is not yet proven."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Backup</Table.Head>
						<Table.Head>Status</Table.Head>
						<Table.Head>Size</Table.Head>
						<Table.Head class="hidden sm:table-cell">Created</Table.Head>
						<Table.Head class="hidden md:table-cell">Verified</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each backups as backup (backup.id)}
						<Table.Row>
							<Table.Cell class="pl-4">
								<span class="font-mono text-xs">{backup.id}</span>
								<div class="text-xs text-muted-foreground">
									{backup.kind}{backup.pinned ? ' · pinned' : ''}
								</div>
							</Table.Cell>
							<Table.Cell><StatusBadge status={backup.status} /></Table.Cell>
							<Table.Cell class="text-xs tabular-nums">
								{backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
								{formatDateTime(backup.finishedAt ?? backup.startedAt)}
							</Table.Cell>
							<Table.Cell class="hidden text-xs md:table-cell">
								{backup.verifiedAt ? formatDateTime(backup.verifiedAt) : '—'}
							</Table.Cell>
							<Table.Cell class="pr-4 text-right">
								{#if backup.status === 'ok' && backupPolicy?.pendingRestoreId === null}
									<Button
										size="sm"
										variant="ghost"
										disabled={deleted}
										onclick={() => openRestore(backup.id)}
									>
										<RotateCcwIcon />Restore
									</Button>
								{/if}
								{#if data.dbCan.delete && backup.status !== 'pending' && backup.status !== 'running'}
									<Button
										variant="ghost-danger"
										size="icon-sm"
										aria-label="Delete backup {backup.id}"
										onclick={() => deleteBackup(backup.id)}
									>
										<TrashIcon />
									</Button>
								{/if}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if data.dbCan.update && !deleted && backupPolicy}
			<form method="POST" action="?/backup-policy" class="flex flex-wrap items-end gap-3 border-t px-4 py-3">
				<label class="flex items-center gap-2 text-xs">
					<input type="checkbox" name="enabled" checked={backupPolicy.enabled} />
					Scheduled
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Cron (UTC)</span>
					<input
						name="schedule"
						value={backupPolicy.schedule}
						class="h-8 w-40 rounded-md border bg-background px-2 font-mono text-xs"
					/>
				</label>
				<label class="flex flex-col gap-1 text-xs">
					<span class="text-muted-foreground">Retention days</span>
					<input
						name="retentionDays"
						type="number"
						min="1"
						max="365"
						value={backupPolicy.retentionDays}
						class="h-8 w-24 rounded-md border bg-background px-2 font-mono text-xs"
					/>
				</label>
				<Button size="sm" variant="outline" type="submit">Save policy</Button>
			</form>
		{/if}
	</Panel>

	<!-- Metrics --------------------------------------------------------------------------------- -->
	<section class="space-y-4" aria-labelledby="database-metrics">
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 id="database-metrics" class="text-xs font-medium text-muted-foreground">
					Metrics · last {data.range.label}
				</h2>
				<p class="text-sm text-muted-foreground">
					Sampled once a minute by the node's agent as a read-only monitor role.
				</p>
			</div>
			<div class="flex items-center gap-1 rounded-lg border bg-muted/30 p-1">
				{#each data.ranges as option (option.key)}
					<Button
						href={data.rangeLinks[option.key]}
						variant={option.key === data.range.key ? 'secondary' : 'ghost'}
						size="sm"
						class="h-7 px-2.5 text-xs"
					>
						{option.shortLabel}
					</Button>
				{/each}
			</div>
		</div>

		{#if !data.telemetryAvailable}
			<EmptyState
				icon={ActivityIcon}
				title="Telemetry is not running"
				description="DuckDB is unavailable on this control plane, so database samples cannot be stored or charted. The database itself is unaffected."
			/>
		{:else if data.metrics.length === 0}
			<EmptyState
				icon={ActivityIcon}
				title="No stats in the last {data.range.label}"
				description={deleted
					? 'The database is stopped, so its node is not sampling it.'
					: 'Stats arrive about a minute after the database starts.'}
			/>
		{:else}
			<section class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Database summary">
				{#each kpis as kpi (kpi.label)}
					<Card.Root class="gap-3">
						<Card.Header>
							<Card.Description class="text-xs font-medium text-muted-foreground"
								>{kpi.label}</Card.Description
							>
							<Card.Title class="text-2xl leading-none font-semibold tracking-tight tabular-nums">
								{kpi.value}
							</Card.Title>
						</Card.Header>
						<Card.Footer class="text-xs text-muted-foreground">{kpi.caption}</Card.Footer>
					</Card.Root>
				{/each}
			</section>

			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Panel title="Size" description="On-disk size of the database.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						series={[
							{
								label: 'size',
								color: 'var(--color-chart-1)',
								values: chartBuckets.map((bucket) => bucket.sizeBytes),
								fill: true
							}
						]}
						label="Database size over time"
					/>
				</Panel>
				<Panel
					title="Connections"
					description="Active and idle backends{chart.span > 1
						? `, ${chart.spanLabel} averages`
						: ''}."
				>
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={rate}
						reference={maxConnections > 0 ? { label: 'max', value: maxConnections } : null}
						series={[
							{
								label: 'active',
								color: 'var(--color-chart-1)',
								values: chartBuckets.map((bucket) => bucket.connectionsActive)
							},
							{
								label: 'idle',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.connectionsIdle)
							}
						]}
						label="Active and idle connections over time"
					/>
				</Panel>
				<Panel title="Transactions" description="Commits and rollbacks {ratePer}.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'commit',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.commitPerMinute),
								fill: true
							},
							{
								label: 'rollback',
								color: 'var(--color-destructive)',
								values: chartBuckets.map((bucket) => bucket.rollbackPerMinute)
							}
						]}
						label="Transactions per minute over time"
					/>
				</Panel>
				<Panel
					title="Cache hit ratio"
					description="Blocks served from shared buffers instead of disk."
				>
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={percent}
						max={1}
						series={[
							{
								label: 'hit ratio',
								color: 'var(--color-chart-3)',
								values: chartBuckets.map((bucket) => bucket.cacheHitRatio)
							}
						]}
						label="Cache hit ratio over time"
					/>
				</Panel>
				<Panel
					title="Rows written"
					description="Rows inserted, updated and deleted {ratePer}."
					class="xl:col-span-2"
				>
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'rows',
								color: 'var(--color-chart-4)',
								values: chartBuckets.map((bucket) => bucket.rowsWrittenPerMinute),
								fill: true
							}
						]}
						label="Rows written per minute over time"
					/>
				</Panel>
			</div>
		{/if}
	</section>

	<!-- Tables ---------------------------------------------------------------------------------- -->
	<Panel
		title="Tables"
		icon={TableIcon}
		count={db.tables.length}
		description={db.statsAt
			? `Largest tables, from a snapshot taken ${ago(db.statsAt)} (refreshed every five minutes).`
			: 'Largest tables, refreshed every five minutes once the database runs.'}
		flush
	>
		{#if db.tables.length === 0}
			<div class="p-4">
				<EmptyState
					icon={TableIcon}
					compact
					title={db.statsAt ? 'No tables yet' : 'No snapshot yet'}
					description={db.statsAt
						? 'Create tables from your app or a migration and they show up here.'
						: 'The agent sends the first table snapshot a few minutes after the database starts.'}
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Table</Table.Head>
						<Table.Head class="text-right">Rows (est.)</Table.Head>
						<Table.Head class="text-right">Size</Table.Head>
						<Table.Head class="hidden text-right md:table-cell">Seq scans</Table.Head>
						<Table.Head class="hidden text-right md:table-cell">Index scans</Table.Head>
						<Table.Head class="hidden pr-4 lg:table-cell">Last autovacuum</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each db.tables as table (`${table.schema}.${table.name}`)}
						<Table.Row>
							<Table.Cell class="max-w-72 truncate pl-4 font-mono text-xs">
								<span class="text-muted-foreground">{table.schema}.</span>{table.name}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{numberFormat.format(table.rows)}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{formatBytes(table.totalBytes)}
							</Table.Cell>
							<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">
								{numberFormat.format(table.seqScans)}
							</Table.Cell>
							<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">
								{numberFormat.format(table.idxScans)}
							</Table.Cell>
							<Table.Cell class="hidden pr-4 text-xs text-muted-foreground lg:table-cell">
								<time
									datetime={table.lastAutovacuum ?? undefined}
									title={formatDateTime(table.lastAutovacuum)}>{ago(table.lastAutovacuum)}</time
								>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#snippet footer()}
			<span class="flex items-center gap-2">
				<TerminalIcon class="size-3.5" />
				A SQL console is planned. Until then, connect with psql over an SSH tunnel.
			</span>
		{/snippet}
	</Panel>

	<!-- Extensions + slow queries ---------------------------------------------------------------- -->
	<Panel
		title="Extensions & slow queries"
		description="Allowlisted Postgres extensions and the top statements by total execution time from pg_stat_statements."
	>
		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
			{#if db.extensions.length === 0}
				<span class="text-xs text-muted-foreground">No extensions requested.</span>
			{:else}
				{#each db.extensions as extension (extension)}
					<Badge variant="outline" class="font-mono text-xs">{extension}</Badge>
				{/each}
			{/if}
			{#if db.slowQueriesAt}
				<span class="ml-auto text-xs text-muted-foreground">
					Queries sampled {ago(db.slowQueriesAt)}
				</span>
			{/if}
		</div>
		{#if db.slowQueries.length === 0}
			<div class="p-4">
				<EmptyState
					icon={TerminalIcon}
					compact
					title="No slow-query snapshot yet"
					description="Enable pg_stat_statements and run some queries; the node samples the top 50 every five minutes."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">Query</Table.Head>
						<Table.Head class="text-right">Calls</Table.Head>
						<Table.Head class="text-right">Mean</Table.Head>
						<Table.Head class="text-right">Total</Table.Head>
						<Table.Head class="hidden text-right md:table-cell">Rows</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each db.slowQueries as query (query.queryId)}
						<Table.Row>
							<Table.Cell class="max-w-md pl-4">
								<code class="line-clamp-2 font-mono text-xs">{query.query}</code>
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{numberFormat.format(query.calls)}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{formatDuration(query.meanMs / 1000)}
							</Table.Cell>
							<Table.Cell class="text-right font-mono text-xs tabular-nums">
								{formatDuration(query.totalMs / 1000)}
							</Table.Cell>
							<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">
								{numberFormat.format(query.rows)}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#if data.dbCan.update && !deleted}
			<form method="POST" action="?/extensions" class="flex flex-wrap items-end gap-3 border-t px-4 py-3">
				<div class="flex flex-wrap gap-3">
					{#each databaseExtensionAllowlist as extension (extension)}
						<label class="flex items-center gap-1.5 font-mono text-xs">
							<input
								type="checkbox"
								name="extensions"
								value={extension}
								checked={db.extensions.includes(extension)}
							/>
							{extension}
						</label>
					{/each}
				</div>
				<Button size="sm" variant="outline" type="submit">Save extensions</Button>
			</form>
		{/if}
		{#snippet footer()}
			<span>Removing an extension here never drops it; the database keeps the objects until you run DROP EXTENSION.</span>
		{/snippet}
	</Panel>

	<!-- Settings + danger zone ------------------------------------------------------------------ -->
	<div class="grid items-start gap-5 xl:grid-cols-2">
		<Panel
			title="Resources"
			icon={SlidersHorizontalIcon}
			description="Limits apply when the node restarts the container. The engine version can't change in place."
		>
			{#snippet actions()}
				{#if data.dbCan.update && !deleted}
					<Button variant="outline" size="sm" onclick={() => restart('database')}>
						<RotateCcwIcon />Restart
					</Button>
					<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>
						<PencilIcon />Resize
					</Button>
				{/if}
			{/snippet}
			<DetailList>
				<dt>Memory</dt>
				<dd class="font-mono text-xs">{db.memoryMb} MB</dd>
				<dt>CPU</dt>
				<dd class="font-mono text-xs">{db.cpus} vCPU</dd>
				<dt>Storage</dt>
				<dd><StorageMeter sizeBytes={db.sizeBytes} storageMb={db.storageMb} /></dd>
				<dt>Pooler</dt>
				<dd class="flex items-center justify-end gap-2 text-xs">
					<span>{db.pooler.enabled ? `PgBouncer on ${db.pooler.host.process}` : 'disabled'}</span>
					{#if db.pooler.enabled && data.dbCan.update && !deleted}
						<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={() => restart('pooler')}>
							Restart
						</Button>
					{/if}
				</dd>
				<dt>Updated</dt>
				<dd class="text-xs">
					<time datetime={db.updatedAt}>{formatDateTime(db.updatedAt)}</time>
				</dd>
			</DetailList>
		</Panel>

		{#if data.dbCan.delete}
			<Card.Root class="border-destructive/30">
				<Card.Header>
					<Card.Title class="text-destructive">Danger zone</Card.Title>
					<Card.Description>
						{#if deleted}
							In the trash. Restore brings it back with its data, or delete it permanently now.
						{:else if db.attachments.length > 0}
							Detach it from {db.attachments.map((item) => item.projectSlug).join(', ')} before deleting.
							Deleted databases stay in the trash for 7 days with their data intact.
						{:else}
							Deleting stops the container and moves the database to the trash for 7 days. Its data
							stays on the node until it is purged.
						{/if}
					</Card.Description>
					<Card.Action class="flex flex-wrap gap-2 self-center">
						{#if deleted}
							<Button variant="outline" onclick={restore}><RotateCcwIcon />Restore</Button>
							<Button variant="destructive" onclick={purge}><TrashIcon />Delete permanently</Button>
						{:else}
							<Button variant="destructive" onclick={deleteDatabase}>
								<TrashIcon />Delete database
							</Button>
						{/if}
					</Card.Action>
				</Card.Header>
			</Card.Root>
		{/if}
	</div>
</div>

{#if data.dbCan.attach && !deleted}
	<FormDialog
		bind:open={attachOpen}
		icon={PlugIcon}
		title="Attach {db.name}"
		description="The project's next start gets the connection env. A project with a database is placed on {nodeLabel}."
		action="?/attach"
		submitLabel="Attach"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.project ? true : undefined}>
				<Field.Label for="attach-project">Project</Field.Label>
				<NativeSelect.Root id="attach-project" name="project" class="w-full" required>
					{#each data.projects as project (project.slug)}
						<NativeSelect.Option value={project.slug}>
							{project.name} ({project.runtime})
						</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.envPrefix ? true : undefined}>
				<Field.Label for="attach-prefix">Env prefix</Field.Label>
				<Input
					id="attach-prefix"
					name="envPrefix"
					bind:value={attachPrefix}
					maxlength={64}
					autocapitalize="characters"
					spellcheck="false"
					class="font-mono text-sm uppercase"
					aria-invalid={errors.envPrefix ? 'true' : undefined}
				/>
				<Field.Description class="font-mono text-xs">
					{databaseEnvNames((attachPrefix || 'DATABASE').toUpperCase()).join(' ')}
				</Field.Description>
				{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}

{#if data.dbCan.update && !deleted}
	<FormDialog
		bind:open={restoreOpen}
		icon={RotateCcwIcon}
		title="Restore backup"
		description="Restore {restoreBackupId} into a brand-new database. The source stays untouched and the new instance gets fresh credentials."
		action="?/restore-backup"
		submitLabel="Restore into new database"
	>
		<input type="hidden" name="backupId" value={restoreBackupId} />
		<Field.Group>
			<Field.Field data-invalid={errors.name ? true : undefined}>
				<Field.Label for="restore-name">New database name</Field.Label>
				<Input
					id="restore-name"
					name="name"
					bind:value={restoreBackupName}
					maxlength={40}
					spellcheck="false"
					class="font-mono text-sm"
				/>
				<Field.Description>
					The node runs pg_restore and a verification query before the database reports ready.
				</Field.Description>
				{#if errors.name}<Field.Error>{errors.name}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={resizeOpen}
		icon={SlidersHorizontalIcon}
		title="Resize {db.name}"
		description="More memory is admitted against {nodeLabel}'s workload slice. The database restarts with the new limits."
		action="?/update"
		submitLabel="Save resources"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
					<Field.Label for="resize-memory">Memory</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="resize-memory"
							name="memoryMb"
							type="number"
							min={data.engine.minMemoryMb}
							max={16384}
							step={1}
							value={String(db.memoryMb)}
							class="font-mono text-sm"
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
				</Field.Field>
				<Field.Field data-invalid={errors.cpus ? true : undefined}>
					<Field.Label for="resize-cpus">CPUs</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input
							id="resize-cpus"
							name="cpus"
							type="number"
							min={0.1}
							max={8}
							step={0.1}
							value={String(db.cpus)}
							class="font-mono text-sm"
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text>
						</InputGroup.Addon>
					</InputGroup.Root>
					{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
				</Field.Field>
			</div>
			<Field.Field data-invalid={errors.storageMb ? true : undefined}>
				<Field.Label for="resize-storage">Storage budget</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-storage"
						name="storageMb"
						type="number"
						min={256}
						max={1048576}
						step={1}
						value={String(db.storageMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end">
						<InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text>
					</InputGroup.Addon>
				</InputGroup.Root>
				<Field.Description>
					Drives the gauge and the 85% alert. It is not enforced on disk.
				</Field.Description>
				{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
			</Field.Field>
			<Field.Field>
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" name="pooler" checked={db.pooler.enabled} />
					PgBouncer sidecar (transaction pooling; injects <code class="font-mono text-xs"
						>DATABASE_POOL_URL</code
					>)
				</label>
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
