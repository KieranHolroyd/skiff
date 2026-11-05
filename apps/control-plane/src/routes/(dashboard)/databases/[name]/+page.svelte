<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CableIcon from '@lucide/svelte/icons/cable';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import PuzzleIcon from '@lucide/svelte/icons/puzzle';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TableIcon from '@lucide/svelte/icons/table';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import UsersIcon from '@lucide/svelte/icons/users';
	import {
		databaseEnvNames,
		databaseExtensionAllowlist,
		type DatabaseCredentials
	} from '@skiff/contracts';
	import { notify, runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/skiff/DetailList.svelte';
	import FormDialog from '#lib/components/skiff/FormDialog.svelte';
	import MetricChart from '#lib/components/skiff/MetricChart.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import RangePicker from '../../_lib/service/RangePicker.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import { readTab, tabHref, type Stat } from '../../_lib/service/sections.js';
	import { formatBytes, formatDate, formatDateTime, formatDuration } from '../../_lib/format.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import DatabaseHeader from '../_lib/DatabaseHeader.svelte';
	import StorageMeter from '../_lib/StorageMeter.svelte';
	import { databaseChart, databaseTotals, storagePercent } from '../_lib/database-series.js';
	import { DATABASE_DEFAULT_TAB, DATABASE_TABS, type DatabaseTab } from '../_lib/database-tabs.js';
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
	const can = $derived(data.dbCan);
	const deleted = $derived(db.deletedAt !== null);
	const editable = $derived(can.update && !deleted);
	const nodeLabel = $derived(db.nodeName ?? db.nodeId);
	const hostPort = $derived(db.internalHost.process.split(':').at(-1) ?? '');
	const defaultEnvNames = $derived(
		databaseEnvNames('DATABASE', { pooler: db.pooler.enabled, tls: db.tls.enabled })
	);

	// --- sections ------------------------------------------------------------------------------

	let tab = $state<DatabaseTab>(
		readTab(page.url.searchParams.get('tab'), DATABASE_TABS, DATABASE_DEFAULT_TAB)
	);

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: DatabaseTab) {
		tab = next;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, next, DATABASE_DEFAULT_TAB), {});
	}

	// --- formatting ----------------------------------------------------------------------------

	const numberFormat = new Intl.NumberFormat('en-GB');
	const rateFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
	const rate = (value: number) => rateFormat.format(value);
	const count = (value: number) =>
		value >= 10_000 ? compactFormat.format(value) : rateFormat.format(value);

	function ago(iso: string | null): string {
		if (!iso) return 'never';
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return 'never';
		return `${formatDuration(Math.max(0, (Date.now() - ms) / 1000))} ago`;
	}

	/** Re-run page data after an inline form and toast the outcome. */
	const submitInline: SubmitFunction = () => {
		return async ({ result: outcome, update }) => {
			await update({ reset: false });
			notify(outcome);
		};
	};

	// --- credentials (D58): revealed on demand, audited, never in page data -------------------

	let credentials = $state<DatabaseCredentials | null>(null);
	let revealing = $state(false);

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success') {
			credentials =
				(outcome.data as { credentials?: DatabaseCredentials } | undefined)?.credentials ?? null;
		}
	}

	const maskUrl = (url: string, password: string) =>
		url.replace(`:${encodeURIComponent(password)}@`, ':••••••••@');

	/** Snippet picker, in the order people reach for them. */
	const SNIPPETS: Array<{ key: string; label: string; file: string }> = [
		{ key: 'psql', label: 'psql', file: 'shell' },
		{ key: 'direct', label: 'psql (direct)', file: 'shell' },
		{ key: 'nodePostgres', label: 'node-postgres', file: 'db.ts' },
		{ key: 'drizzle', label: 'Drizzle', file: 'db.ts' },
		{ key: 'prisma', label: 'Prisma', file: 'schema.prisma' },
		{ key: 'kysely', label: 'Kysely', file: 'db.ts' },
		{ key: 'django', label: 'Django', file: 'settings.py' },
		{ key: 'rails', label: 'Rails', file: 'database.yml' },
		{ key: 'pgx', label: 'Go (pgx)', file: 'main.go' },
		{ key: 'verifyFull', label: 'Verify TLS', file: 'shell' }
	];
	let snippet = $state('psql');
	const snippets = $derived(
		SNIPPETS.filter((item) => credentials?.connectionSnippets[item.key] !== undefined)
	);
	const activeSnippet = $derived(snippets.find((item) => item.key === snippet) ?? snippets[0]);

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

	const canAttach = $derived(can.attach && !deleted && data.projects.length > 0);

	// --- backups -------------------------------------------------------------------------------

	const backups = $derived(data.backups);
	const policy = $derived(db.backup);
	const lastGood = $derived(backups.find((backup) => backup.status === 'ok') ?? null);
	let restoreOpen = $state(false);
	let restoreBackupId = $state('');
	let restoreBackupName = $state('');
	let policyOpen = $state(false);
	let policyEnabled = $state(true);

	function openRestore(backupId: string) {
		restoreBackupId = backupId;
		restoreBackupName = `${db.name}-restored`;
		restoreOpen = true;
	}

	function openPolicy() {
		policyEnabled = policy?.enabled ?? true;
		policyOpen = true;
	}

	function deleteBackup(backupId: string) {
		askConfirm({
			title: `Delete backup ${backupId}?`,
			description:
				'The dump is removed from the object store. A restore of it is no longer possible.',
			confirmLabel: 'Delete backup',
			tone: 'danger',
			action: '?/delete-backup',
			fields: { backupId }
		});
	}

	// --- metrics -------------------------------------------------------------------------------

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
	const sizeBytes = $derived(totals.latestSizeBytes ?? db.sizeBytes);

	const overviewStats = $derived<Stat[]>([
		{
			label: 'Storage',
			icon: HardDriveIcon,
			value: sizeBytes === null ? '—' : formatBytes(sizeBytes),
			unit: `/ ${formatBytes(db.storageMb * 1024 * 1024)}`,
			meter: storagePercent(sizeBytes, db.storageMb),
			caption: 'Budget for alerts, not a hard quota'
		},
		{
			label: 'Connections',
			icon: UsersIcon,
			value:
				totals.latestConnections === null ? '—' : numberFormat.format(totals.latestConnections),
			unit: totals.maxConnections ? `/ ${numberFormat.format(totals.maxConnections)}` : undefined,
			caption: db.pooler.enabled ? 'PgBouncer pooling on' : 'Direct connections'
		},
		{
			label: 'Cache hit ratio',
			icon: GaugeIcon,
			value: totals.cacheHitRatio === null ? '—' : percent(totals.cacheHitRatio),
			caption: `Last ${data.range.label}`
		},
		{
			label: 'Last backup',
			icon: ArchiveIcon,
			value: lastGood ? ago(lastGood.finishedAt ?? lastGood.startedAt) : 'Never',
			caption: !policy
				? 'No schedule'
				: !policy.enabled
					? 'Schedule paused'
					: policy.nextBackupAt
						? `Next ${formatDateTime(policy.nextBackupAt)}`
						: 'Scheduled'
		}
	]);

	const metricStats = $derived<Stat[]>([
		{
			label: 'Transactions',
			value: compactFormat.format(totals.commits + totals.rollbacks),
			caption: `${numberFormat.format(totals.rollbacks)} rolled back`
		},
		{
			label: 'Peak connections',
			value: totals.maxConnections ? numberFormat.format(totals.maxConnections) : '—',
			caption: 'Configured maximum'
		},
		{
			label: 'Cache hit ratio',
			value: totals.cacheHitRatio === null ? '—' : percent(totals.cacheHitRatio),
			caption: 'Shared buffers vs disk'
		},
		{
			label: 'Deadlocks',
			value: numberFormat.format(totals.deadlocks),
			caption: totals.deadlocks > 0 ? 'Check slow queries' : 'None in this window'
		}
	]);

	// --- settings ------------------------------------------------------------------------------

	let resizeOpen = $state(false);

	function setPooler(next: boolean) {
		if (next === db.pooler.enabled) return;
		askConfirm({
			title: next ? 'Turn on the connection pooler?' : 'Turn off the connection pooler?',
			description: next
				? 'A PgBouncer sidecar starts next to Postgres in transaction-pooling mode. Attached apps restart and also receive DATABASE_POOL_URL.'
				: 'The PgBouncer sidecar stops. Attached apps restart without the DATABASE_POOL_* variables, so anything using them must switch to DATABASE_URL first.',
			confirmLabel: next ? 'Turn on' : 'Turn off',
			tone: next ? 'default' : 'danger',
			action: '?/update',
			fields: { pooler: next ? 'on' : '' }
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
	<DatabaseHeader {db} {can} active={tab} backups={backups.length} onselect={setTab} />

	{#if deleted}
		<Notice tone="warning" title="This database is in the trash">
			The container is stopped and its data is kept on {nodeLabel}. {purgeCountdown(db.purgeAt)}.
			Restore it from the buttons above to bring it back with its data.
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

	{#if tab === 'overview'}
		<!-- Overview ------------------------------------------------------------------------------ -->
		<StatStrip label="Database summary" stats={overviewStats} />

		<div class="grid items-start gap-5 xl:grid-cols-5">
			<Panel
				title="Connection"
				icon={CableIcon}
				description="Attached apps on {nodeLabel} receive these as environment variables at start-up."
				class="xl:col-span-3"
			>
				{#snippet actions()}
					{#if can.credentials && !deleted}
						{#if credentials}
							<Button variant="outline" size="sm" onclick={() => (credentials = null)}>
								<EyeOffIcon />Hide credentials
							</Button>
						{:else}
							<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
								{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
								Reveal credentials
							</Button>
						{/if}
					{/if}
				{/snippet}

				<DetailList>
					<dt>Database</dt>
					<dd><CopyValue value={db.databaseName} label="database name" /></dd>
					<dt>User</dt>
					<dd><CopyValue value={db.username} label="user" /></dd>
					<dt>Host · process apps</dt>
					<dd><CopyValue value={db.internalHost.process} label="host" /></dd>
					<dt>Host · container apps</dt>
					<dd><CopyValue value={db.internalHost.container} label="host" /></dd>
					{#if db.pooler.enabled}
						<dt>Pooled · process</dt>
						<dd><CopyValue value={db.pooler.host.process} label="pooler host" /></dd>
						<dt>Pooled · container</dt>
						<dd><CopyValue value={db.pooler.host.container} label="pooler host" /></dd>
					{/if}
					<dt>TLS</dt>
					<dd class="text-xs">
						{#if db.tls.enabled}
							<span class="inline-flex items-center gap-1 text-success">
								<ShieldCheckIcon class="size-3.5" />Required
								<span class="font-mono text-muted-foreground">sslmode={db.tls.mode}</span>
							</span>
						{:else}
							<span class="text-muted-foreground">Off</span>
						{/if}
					</dd>
					{#if credentials}
						<dt>Password</dt>
						<dd><CopyValue value={credentials.password} label="password" secret /></dd>
						<dt>Direct URL</dt>
						<dd>
							<CopyValue
								value={credentials.url}
								label="direct URL"
								display={maskUrl(credentials.url, credentials.password)}
								secret
							/>
						</dd>
						{#if credentials.poolerUrl}
							<dt>Pooled URL</dt>
							<dd>
								<CopyValue
									value={credentials.poolerUrl}
									label="pooled URL"
									display={maskUrl(credentials.poolerUrl, credentials.password)}
									secret
								/>
							</dd>
						{/if}
						{#if credentials.caPem}
							<dt>CA certificate</dt>
							<dd>
								<CopyValue
									value={credentials.caPem}
									label="CA certificate"
									display="PEM · public"
									secret
								/>
							</dd>
						{/if}
					{/if}
				</DetailList>

				{#if db.tls.error}
					<Notice tone="warning" title="TLS is not active" class="mt-4">{db.tls.error}</Notice>
				{/if}

				{#if credentials && activeSnippet}
					<div class="mt-4 space-y-2">
						<div class="flex items-center justify-between gap-3">
							<p class="text-sm font-medium">Connect from code</p>
							<NativeSelect.Root bind:value={snippet} size="sm" class="w-40" aria-label="Client">
								{#each snippets as item (item.key)}
									<NativeSelect.Option value={item.key}>{item.label}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
						</div>
						<CodeBlock
							label={activeSnippet.file}
							code={credentials.connectionSnippets[activeSnippet.key] ?? ''}
						/>
					</div>
				{/if}

				<div class="mt-4 space-y-2 rounded-lg border bg-muted/30 p-3">
					<p class="text-xs text-muted-foreground">
						An attached app receives these, with its prefix (default
						<code class="font-mono">DATABASE</code>):
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
								Listens on loopback on {nodeLabel} only. From elsewhere, tunnel:
								<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>
							{/if}
							{#if !can.credentials}
								Revealing the password needs <code class="font-mono">database:credentials</code>.
							{/if}
						</span>
					</span>
				{/snippet}
			</Panel>

			<Panel
				title="Attached projects"
				icon={PlugIcon}
				count={db.attachments.length}
				description="Apps run on the database's node. Attaching or detaching restarts the app."
				flush
				class="xl:col-span-2"
			>
				{#snippet actions()}
					{#if canAttach && db.attachments.length > 0}
						<Button size="sm" variant="outline" onclick={openAttach}><PlusIcon />Attach</Button>
					{/if}
				{/snippet}

				{#if result?.warning}
					<div class="px-4 pt-4"><Notice tone="warning">{result.warning}</Notice></div>
				{/if}

				{#if db.attachments.length === 0}
					<div class="p-4">
						<EmptyState
							icon={UnplugIcon}
							compact
							title="Not attached yet"
							description="Attach a process or container project to inject the connection env. Static projects can't use a database."
						>
							{#if canAttach}
								<Button size="sm" onclick={openAttach}><PlusIcon />Attach a project</Button>
							{/if}
						</EmptyState>
					</div>
				{:else}
					<ul class="divide-y">
						{#each db.attachments as attachment (attachment.projectId)}
							<li class="flex items-center gap-3 px-4 py-3">
								<span
									class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
								>
									<FolderKanbanIcon class="size-4" />
								</span>
								<div class="min-w-0 flex-1">
									<a
										href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
										class="font-mono text-sm font-medium underline-offset-4 hover:underline"
									>
										{attachment.projectSlug}
									</a>
									<p
										class="truncate font-mono text-xs text-muted-foreground"
										title={attachment.envNames.join(', ')}
									>
										{attachment.envPrefix}_URL +{attachment.envNames.length - 1} · since
										{formatDate(attachment.createdAt)}
									</p>
								</div>
								{#if can.attach}
									<Button
										variant="ghost-danger"
										size="icon-sm"
										aria-label="Detach from {attachment.projectSlug}"
										title="Detach"
										onclick={() => detach(attachment.projectSlug, attachment.envPrefix)}
									>
										<UnplugIcon />
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Panel>
		</div>
	{:else if tab === 'metrics'}
		<!-- Metrics ------------------------------------------------------------------------------- -->
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="text-base font-semibold">Last {data.range.label}</h2>
				<p class="text-sm text-muted-foreground">
					Sampled once a minute by the node's agent as a read-only monitor role.
				</p>
			</div>
			<RangePicker
				ranges={data.ranges}
				current={data.range.key}
				links={data.rangeLinks}
				tab="metrics"
			/>
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
			<StatStrip label="Metrics summary" stats={metricStats} />

			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Panel title="Size" description="On-disk size of the database.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						reference={{ label: 'budget', value: db.storageMb * 1024 * 1024 }}
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
	{:else if tab === 'backups'}
		<!-- Backups ------------------------------------------------------------------------------- -->
		{#if policy}
			<StatStrip
				label="Backup policy"
				stats={[
					{
						label: 'Schedule',
						icon: CalendarClockIcon,
						value: policy.enabled ? policy.schedule : 'Paused',
						unit: policy.enabled ? 'UTC' : undefined,
						caption: policy.nextBackupAt
							? `Next ${formatDateTime(policy.nextBackupAt)}`
							: 'Cron expression'
					},
					{
						label: 'Retention',
						icon: TimerIcon,
						value: String(policy.retentionDays),
						unit: policy.retentionDays === 1 ? 'day' : 'days',
						caption: 'Pinned backups are kept'
					},
					{
						label: 'Last backup',
						icon: ArchiveIcon,
						value: lastGood ? ago(lastGood.finishedAt ?? lastGood.startedAt) : 'Never',
						caption: lastGood?.sizeBytes ? formatBytes(lastGood.sizeBytes) : 'Logical dump'
					},
					{
						label: 'Verified restore',
						icon: ShieldCheckIcon,
						value: policy.lastVerifiedAt ? ago(policy.lastVerifiedAt) : 'Never',
						caption: policy.lastVerifiedAt
							? formatDateTime(policy.lastVerifiedAt)
							: 'An unrestored dump is not yet proven'
					}
				]}
			/>
			{#if policy.lastBackupError}
				<Notice tone="danger" title="The last backup failed">{policy.lastBackupError}</Notice>
			{/if}
		{/if}

		<Panel
			title="Backups"
			icon={ArchiveIcon}
			count={backups.length}
			description="Logical dumps streamed to the backup target. Restores always create a new database and verify it."
			flush
		>
			{#snippet actions()}
				{#if editable && policy}
					<Button size="sm" variant="outline" onclick={openPolicy}>
						<CalendarClockIcon />Schedule
					</Button>
				{/if}
			{/snippet}

			{#if policy?.pendingRestoreId}
				<div class="px-4 pt-4">
					<Notice tone="info"
						>A restore is in progress; new restores are available once it finishes.</Notice
					>
				</div>
			{/if}
			{#if backups.length === 0}
				<div class="p-4">
					<EmptyState
						icon={ArchiveIcon}
						compact
						title="No backups yet"
						description="Take one now from the header, or wait for the schedule. A dump that has never been restored is not yet proven."
					/>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Backup</Table.Head>
							<Table.Head>Status</Table.Head>
							<Table.Head class="text-right">Size</Table.Head>
							<Table.Head class="hidden sm:table-cell">Taken</Table.Head>
							<Table.Head class="hidden md:table-cell">Verified</Table.Head>
							<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each backups as backup (backup.id)}
							{@const restorable =
								backup.status === 'ok' && policy?.pendingRestoreId === null && !deleted}
							{@const removable =
								can.delete && backup.status !== 'pending' && backup.status !== 'running'}
							<Table.Row>
								<Table.Cell class="pl-4">
									<span class="font-mono text-xs">{backup.id}</span>
									<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
										<span class="capitalize">{backup.kind}</span>
										{#if backup.pinned}<Badge variant="outline" class="h-4 px-1.5 text-[10px]"
												>pinned</Badge
											>{/if}
									</div>
								</Table.Cell>
								<Table.Cell><StatusBadge status={backup.status} /></Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">
									{backup.sizeBytes === null ? '—' : formatBytes(backup.sizeBytes)}
								</Table.Cell>
								<Table.Cell class="hidden text-xs text-muted-foreground sm:table-cell">
									{formatDateTime(backup.finishedAt ?? backup.startedAt)}
								</Table.Cell>
								<Table.Cell class="hidden text-xs md:table-cell">
									{#if backup.verifiedAt}
										<span class="inline-flex items-center gap-1 text-success">
											<ShieldCheckIcon class="size-3.5" />{formatDate(backup.verifiedAt)}
										</span>
									{:else}
										<span class="text-muted-foreground">—</span>
									{/if}
								</Table.Cell>
								<Table.Cell class="pr-4">
									{#if (editable && restorable) || removable}
										<RowMenu label="Actions for backup {backup.id}">
											{#if editable && restorable}
												<DropdownMenu.Item onSelect={() => openRestore(backup.id)}>
													<RotateCcwIcon />Restore into new database…
												</DropdownMenu.Item>
											{/if}
											{#if removable}
												{#if editable && restorable}<DropdownMenu.Separator />{/if}
												<DropdownMenu.Item
													variant="destructive"
													onSelect={() => deleteBackup(backup.id)}
												>
													<TrashIcon />Delete backup
												</DropdownMenu.Item>
											{/if}
										</RowMenu>
									{/if}
								</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		</Panel>
	{:else if tab === 'insights'}
		<!-- Tables & queries ---------------------------------------------------------------------- -->
		<Panel
			title="Tables"
			icon={TableIcon}
			count={db.tables.length}
			description={db.statsAt
				? `Largest tables, from a snapshot taken ${ago(db.statsAt)}. Refreshed every five minutes.`
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
		</Panel>

		<Panel
			title="Slow queries"
			icon={TimerIcon}
			count={db.slowQueries.length || undefined}
			description={db.slowQueriesAt
				? `Top statements by total execution time, sampled ${ago(db.slowQueriesAt)}.`
				: 'Top statements by total execution time from pg_stat_statements.'}
			flush
		>
			{#if db.slowQueries.length === 0}
				<div class="p-4">
					<EmptyState
						icon={TimerIcon}
						compact
						title="No slow-query snapshot yet"
						description={db.extensions.includes('pg_stat_statements')
							? 'Run some queries; the node samples the top 50 every five minutes.'
							: 'Turn on pg_stat_statements under Settings → Extensions, then run some queries.'}
					>
						{#if editable && !db.extensions.includes('pg_stat_statements')}
							<Button size="sm" variant="outline" onclick={() => setTab('settings')}>
								<PuzzleIcon />Manage extensions
							</Button>
						{/if}
					</EmptyState>
				</div>
			{:else}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Query</Table.Head>
							<Table.Head class="text-right">Calls</Table.Head>
							<Table.Head class="text-right">Mean</Table.Head>
							<Table.Head class="text-right">Total</Table.Head>
							<Table.Head class="hidden pr-4 text-right md:table-cell">Rows</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each db.slowQueries as query (query.queryId)}
							<Table.Row>
								<Table.Cell class="max-w-md pl-4 whitespace-normal">
									<code class="line-clamp-2 font-mono text-xs" title={query.query}
										>{query.query}</code
									>
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
								<Table.Cell
									class="hidden pr-4 text-right font-mono text-xs tabular-nums md:table-cell"
								>
									{numberFormat.format(query.rows)}
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
	{:else if tab === 'settings'}
		<!-- Settings ------------------------------------------------------------------------------ -->
		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Panel
				title="Resources"
				icon={SlidersHorizontalIcon}
				description="Limits apply when the node restarts the container. The engine version can't change in place."
			>
				{#snippet actions()}
					{#if editable}
						<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>
							<PencilIcon />Resize
						</Button>
					{/if}
				{/snippet}
				<DetailList>
					<dt>Engine</dt>
					<dd class="text-xs">{db.engineLabel} {db.version}</dd>
					<dt>Node</dt>
					<dd class="font-mono text-xs">{nodeLabel}</dd>
					<dt>Memory</dt>
					<dd class="font-mono text-xs">{db.memoryMb} MB</dd>
					<dt>CPU</dt>
					<dd class="font-mono text-xs">{db.cpus} vCPU</dd>
					<dt>Storage</dt>
					<dd><StorageMeter sizeBytes={db.sizeBytes} storageMb={db.storageMb} /></dd>
					<dt>Updated</dt>
					<dd class="text-xs">
						<time datetime={db.updatedAt}>{formatDateTime(db.updatedAt)}</time>
					</dd>
				</DetailList>
			</Panel>

			<div class="space-y-5">
				<Panel
					title="Connection pooler"
					icon={LayersIcon}
					description="PgBouncer in transaction-pooling mode, next to Postgres on {nodeLabel}."
				>
					<div class="flex items-start justify-between gap-4">
						<div class="space-y-1">
							<label for="database-pooler" class="text-sm font-medium">
								{db.pooler.enabled ? 'Pooling is on' : 'Pooling is off'}
							</label>
							<p class="text-xs text-muted-foreground">
								{#if db.pooler.enabled}
									Apps also receive <code class="font-mono">DATABASE_POOL_URL</code>, served at
									<span class="font-mono">{db.pooler.host.process}</span>.
								{:else}
									Turn it on for apps that open many short-lived connections (serverless-style
									handlers, many workers).
								{/if}
							</p>
						</div>
						<Switch
							id="database-pooler"
							bind:checked={() => db.pooler.enabled, setPooler}
							disabled={!editable}
							aria-label="Connection pooler"
						/>
					</div>
				</Panel>

				<Panel
					title="Extensions"
					icon={PuzzleIcon}
					count={db.extensions.length || undefined}
					description="Allowlisted Postgres extensions the node installs on activation."
				>
					<form method="POST" action="?/extensions" use:enhance={submitInline} class="space-y-4">
						<div class="grid gap-2 sm:grid-cols-2">
							{#each databaseExtensionAllowlist as extension (extension)}
								<label
									class="flex items-center gap-2.5 rounded-md border px-3 py-2 font-mono text-xs transition-colors has-data-checked:border-primary/40 has-data-checked:bg-muted/40"
								>
									<Checkbox
										name="extensions"
										value={extension}
										checked={db.extensions.includes(extension)}
										disabled={!editable}
									/>
									{extension}
								</label>
							{/each}
						</div>
						<div class="flex flex-wrap items-center justify-between gap-3">
							<p class="text-xs text-muted-foreground">
								Unticking never drops an extension; run <code class="font-mono">DROP EXTENSION</code
								>
								yourself.
							</p>
							{#if editable}
								<Button size="sm" variant="outline" type="submit">Save extensions</Button>
							{/if}
						</div>
					</form>
				</Panel>
			</div>
		</div>

		{#if can.delete}
			<DangerZone>
				{#snippet description()}
					{#if deleted}
						In the trash. Restore brings it back with its data, or delete it permanently now.
					{:else if db.attachments.length > 0}
						Detach it from {db.attachments.map((item) => item.projectSlug).join(', ')} first. Deleted
						databases stay in the trash for 7 days with their data intact.
					{:else}
						Deleting stops the container and moves the database to the trash for 7 days. Its data
						stays on the node until it is purged.
					{/if}
				{/snippet}
				{#if deleted}
					<Button variant="outline" onclick={() => runAction('?/restore')}>
						<RotateCcwIcon />Restore
					</Button>
					<Button
						variant="destructive"
						onclick={() =>
							askConfirm({
								title: `Delete ${db.name} permanently?`,
								description:
									'Its node deletes the data directory and the database is gone for good. This cannot be undone.',
								confirmLabel: 'Delete permanently',
								tone: 'danger',
								typeToConfirm: db.name,
								action: '?/purge'
							})}
					>
						<TrashIcon />Delete permanently
					</Button>
				{:else}
					<Button
						variant="destructive"
						onclick={() =>
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
							})}
					>
						<TrashIcon />Delete database
					</Button>
				{/if}
			</DangerZone>
		{/if}
	{/if}
</div>

{#if can.attach && !deleted}
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

{#if editable}
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

	{#if policy}
		<FormDialog
			bind:open={policyOpen}
			icon={CalendarClockIcon}
			title="Backup schedule"
			description="When {db.name} is dumped and how long dumps are kept. Pinned backups are never pruned."
			action="?/backup-policy"
			submitLabel="Save schedule"
		>
			<Field.Group>
				<Field.Field orientation="horizontal">
					<Field.Content>
						<Field.Label for="policy-enabled">Scheduled backups</Field.Label>
						<Field.Description>Pause to stop new dumps; existing ones are kept.</Field.Description>
					</Field.Content>
					<Switch id="policy-enabled" name="enabled" bind:checked={policyEnabled} />
				</Field.Field>
				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field data-invalid={errors.schedule ? true : undefined}>
						<Field.Label for="policy-schedule">Cron schedule</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="policy-schedule"
								name="schedule"
								value={policy.schedule}
								spellcheck="false"
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end">
								<InputGroup.Text class="font-mono text-xs">UTC</InputGroup.Text>
							</InputGroup.Addon>
						</InputGroup.Root>
						<Field.Description class="font-mono text-xs"
							>0 3 * * * = daily at 03:00</Field.Description
						>
						{#if errors.schedule}<Field.Error>{errors.schedule}</Field.Error>{/if}
					</Field.Field>
					<Field.Field data-invalid={errors.retentionDays ? true : undefined}>
						<Field.Label for="policy-retention">Retention</Field.Label>
						<InputGroup.Root>
							<InputGroup.Input
								id="policy-retention"
								name="retentionDays"
								type="number"
								min={1}
								max={365}
								value={String(policy.retentionDays)}
								class="font-mono text-sm"
							/>
							<InputGroup.Addon align="inline-end">
								<InputGroup.Text class="font-mono text-xs">days</InputGroup.Text>
							</InputGroup.Addon>
						</InputGroup.Root>
						{#if errors.retentionDays}<Field.Error>{errors.retentionDays}</Field.Error>{/if}
					</Field.Field>
				</div>
			</Field.Group>
		</FormDialog>
	{/if}

	<FormDialog
		bind:open={resizeOpen}
		icon={SlidersHorizontalIcon}
		title="Resize {db.name}"
		description="More memory is admitted against {nodeLabel}'s workload slice. The database restarts with the new limits."
		action="?/update"
		submitLabel="Save resources"
	>
		<!-- The action reads a missing `pooler` as off; carry the current state through. -->
		<input type="hidden" name="pooler" value={db.pooler.enabled ? 'on' : ''} />
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
				<Field.Description
					>Drives the gauge and the 85% alert. It is not enforced on disk.</Field.Description
				>
				{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
