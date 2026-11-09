<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CloudIcon from '@lucide/svelte/icons/cloud';
	import DatabaseBackupIcon from '@lucide/svelte/icons/database-backup';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import LifeBuoyIcon from '@lucide/svelte/icons/life-buoy';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SettingsIcon from '@lucide/svelte/icons/settings-2';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime, formatDuration } from '../../_lib/format.js';
	import ConfigProgress from '../ConfigProgress.svelte';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import { backupStatus } from '../_lib/backup-status.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	const fieldErrors = $derived(
		(form as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? {}
	);

	let configureOpen = $state(false);
	let refreshing = $state(false);

	/** Installed host (root helper) or a dev server (local settings file). */
	const canEdit = $derived(data.availability === 'ready' || data.availability === 'local');
	const local = $derived(data.availability === 'local');
	const ready = $derived(canEdit && !data.inFlight);
	const health = $derived(data.health);
	const configured = $derived(data.r2.configured);
	const savedSecret = $derived(data.r2.secretsSet.includes('R2_SECRET_ACCESS_KEY'));

	/** One headline state for the panel (the settings nav shows the same one). */
	const overall = $derived(backupStatus({ configured, local, health }));

	async function refresh() {
		refreshing = true;
		// Clears the one-minute cache of the R2 replication check, then reloads the page data.
		await runAction('?/refresh', {}, { toast: false });
		refreshing = false;
	}

	function turnOff() {
		askConfirm({
			title: 'Turn off backups?',
			description:
				'Litestream stops and the monthly restore drill is disabled. Existing backups in R2 are kept, but new changes are no longer copied off this server.',
			confirmLabel: 'Turn off',
			tone: 'danger',
			action: '?/disable'
		});
	}

	function removeCredentials() {
		askConfirm({
			title: 'Remove the R2 credentials?',
			description:
				'Backups stop and the keys are deleted from /etc/yoal/yoal.env. Backups already in R2 are not deleted. The dashboard restarts for a few seconds.',
			confirmLabel: 'Remove',
			tone: 'danger',
			action: '?/removeR2'
		});
	}

	function startDrill() {
		askConfirm({
			title: 'Run a restore drill now?',
			description:
				'Yoal restores the latest backup from R2 into a scratch directory and checks it matches the live database row for row. The dashboard and API pause for a few seconds while it compares; deployed sites keep serving.',
			confirmLabel: 'Run drill',
			action: '?/drill'
		});
	}

	const snapshotKinds: Record<string, string> = {
		'pre-upgrade': 'Before upgrade',
		'pre-update': 'Before update',
		'pre-restore': 'Before restore',
		'pre-install': 'Before install',
		other: 'Snapshot'
	};
</script>

<svelte:head><title>Backups · Settings · Yoal</title></svelte:head>

<SettingsHeader id="backups" />

<div class="space-y-6">
	<ConfigProgress
		status={data.status}
		pending={data.pending}
		inFlight={data.inFlight}
		availability={data.availability}
		restartPending={data.restartPending}
		sections={['backups', 'restore-drill']}
	/>

	<Panel title="Database backups" description={overall.detail} icon={DatabaseBackupIcon}>
		{#snippet actions()}
			<StatusBadge status={overall.label} tone={overall.tone} />
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={refresh}
				disabled={refreshing}
				aria-label="Refresh backup status"
			>
				<RefreshCwIcon class={refreshing ? 'animate-spin' : ''} />
			</Button>
		{/snippet}

		{#if !configured}
			<EmptyState
				icon={CloudIcon}
				title="Back up to Cloudflare R2"
				description="Litestream copies every change to the platform database to an R2 bucket within about a second, and a monthly drill proves the backup restores. R2 has no egress fees; the free tier covers most installs."
			>
				{#if canEdit}
					<Button onclick={() => (configureOpen = true)} disabled={!ready}>
						<CloudIcon />Set up R2 backups
					</Button>
				{/if}
			</EmptyState>
		{:else}
			<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Destination</dt>
					<dd class="font-mono text-sm break-all">
						r2://{data.r2.values.R2_BUCKET}/yoal/sqlite
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Latest backup</dt>
					<dd>
						{#if !health.enabled}
							<span class="text-muted-foreground">Off</span>
						{:else if health.replication?.ok}
							{health.replication.lagSeconds !== null && health.replication.lagSeconds < 60
								? 'Just now'
								: `${formatDuration(health.replication.lagSeconds ?? 0)} ago`}
						{:else if health.replication}
							<span class="text-destructive">{health.replication.error}</span>
						{:else}
							<span class="text-muted-foreground">Unknown</span>
						{/if}
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Last restore drill</dt>
					<dd class="flex flex-wrap items-center gap-2">
						{#if health.drillRunning}
							<StatusBadge status="pending" label="Running" />
						{:else if health.drill}
							<StatusBadge
								status={health.drill.ok ? 'ok' : 'failed'}
								label={health.drill.ok ? 'Passed' : 'Failed'}
							/>
							<span class="text-xs text-muted-foreground">{formatDateTime(health.drill.at)}</span>
						{:else}
							<span class="text-muted-foreground">Never run</span>
						{/if}
					</dd>
				</div>
				<div class="space-y-1">
					<dt class="text-xs text-muted-foreground">Next drill</dt>
					<dd class="text-sm">
						{health.enabled && health.drillTimer?.next
							? formatDateTime(health.drillTimer.next)
							: '—'}
					</dd>
				</div>
			</dl>

			{#if health.drill && !health.drill.ok}
				<Alert.Root variant="destructive" class="mt-4">
					<TriangleAlertIcon />
					<Alert.Title>The last restore drill failed: {health.drill.reason}</Alert.Title>
					<Alert.Description>
						Do not assume the backup is usable. The run directory under <code
							>/var/lib/yoal/drill</code
						> keeps both fingerprints; see docs/OPS.md §8.3.
					</Alert.Description>
				</Alert.Root>
			{/if}
			{#if health.enabled && !health.litestream}
				<p class="mt-4 text-xs text-muted-foreground">
					systemd could not be queried from the control plane, so the service state is unknown.
				</p>
			{/if}
		{/if}

		{#snippet footer()}
			{#if configured && canEdit}
				<div class="flex w-full flex-wrap items-center gap-2">
					{#if local}
						<span class="text-muted-foreground">
							Credentials saved locally. Litestream and the restore drill run only on an installed
							server.
						</span>
					{:else if health.enabled}
						<Button
							variant="outline"
							size="sm"
							onclick={startDrill}
							disabled={!ready || health.drillRunning}
						>
							<FlaskConicalIcon />Run restore drill
						</Button>
					{:else}
						<Button size="sm" onclick={() => runAction('?/enable')} disabled={!ready}>
							<DatabaseBackupIcon />Turn on backups
						</Button>
					{/if}
					<Button
						variant="outline"
						size="sm"
						onclick={() => (configureOpen = true)}
						disabled={!ready}
					>
						<SettingsIcon />Edit R2 settings
					</Button>
					<span class="flex-1"></span>
					{#if health.enabled && !local}
						<Button variant="ghost-danger" size="sm" onclick={turnOff} disabled={!ready}
							>Turn off</Button
						>
					{:else if !data.artifactsInR2}
						<Button variant="ghost-danger" size="sm" onclick={removeCredentials} disabled={!ready}
							>Remove credentials</Button
						>
					{/if}
				</div>
			{:else}
				Litestream → R2 (continuous, about 1 s behind), a full snapshot daily, 30-day retention.
			{/if}
		{/snippet}
	</Panel>

	<div class="grid items-start gap-6 lg:grid-cols-2">
		<Panel
			title="Download a copy"
			icon={DownloadIcon}
			description="A consistent snapshot of the platform database, taken now."
		>
			<p class="text-sm text-muted-foreground">
				Users, sessions, projects and the audit log, as one SQLite file. Secrets inside stay
				encrypted with the master key, which is not included (nor is <code
					>/etc/yoal/yoal.env</code
				>). Store it somewhere safe; downloads are recorded in the audit log.
			</p>
			<form method="POST" action="/settings/backups/download" class="mt-4">
				<Button type="submit" variant="outline"><DownloadIcon />Download database</Button>
			</form>
		</Panel>

		<Panel
			title="Disaster recovery"
			icon={LifeBuoyIcon}
			description="What a full restore needs besides the R2 backup."
		>
			<ul class="list-disc space-y-1.5 pl-5 text-sm">
				<li>
					<code>/etc/yoal/master.key</code> — without it, encrypted secrets cannot be read even if the
					database restores.
				</li>
				<li>
					<code>/etc/yoal/yoal.env</code> — it holds the R2 keys the restore needs to reach the backup.
				</li>
				<li>
					Export both as one passphrase-encrypted recovery kit with
					<code>sudo yoal-recovery-kit export --include-env</code>, copy it off the server, and
					keep the passphrase apart from the file.
					<code>yoal-recovery-kit verify &lt;file&gt;</code> checks a kit matches this server.
				</li>
			</ul>
			<Collapsible.Root class="mt-3">
				<Collapsible.Trigger
					class="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
				>
					Restore commands
				</Collapsible.Trigger>
				<Collapsible.Content>
					<pre
						class="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">sudo yoal-restore --yes        # this server, latest backup
sudo yoal-restore-drill        # prove a restore, change nothing
sudo yoal-restore --yes --recovery-kit kit.age   # fresh server: key + env from the kit first</pre>
				</Collapsible.Content>
			</Collapsible.Root>
		</Panel>
	</div>

	<Panel
		title="Local snapshots"
		icon={ArchiveIcon}
		count={data.snapshots.length}
		flush
		description="Taken automatically before every install, update and restore, kept on this server."
	>
		{#if data.snapshots.length === 0}
			<div class="p-4">
				<EmptyState
					icon={ArchiveIcon}
					compact
					title="No snapshots yet"
					description="One is taken before the next update or restore."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="pl-4">File</Table.Head>
						<Table.Head>Taken</Table.Head>
						<Table.Head class="hidden sm:table-cell">Reason</Table.Head>
						<Table.Head class="pr-4 text-right">Size</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.snapshots as snapshot (snapshot.name)}
						<Table.Row>
							<Table.Cell class="pl-4 font-mono text-xs">{snapshot.name}</Table.Cell>
							<Table.Cell class="text-xs text-muted-foreground"
								>{formatDateTime(snapshot.createdAt)}</Table.Cell
							>
							<Table.Cell class="hidden text-xs sm:table-cell"
								>{snapshotKinds[snapshot.kind]}</Table.Cell
							>
							<Table.Cell class="pr-4 text-right font-mono text-xs tabular-nums"
								>{formatBytes(snapshot.bytes)}</Table.Cell
							>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
		{#snippet footer()}
			In <code>/var/lib/yoal/backups</code>. These protect against a bad update, not against losing
			the server.
		{/snippet}
	</Panel>
</div>

<FormDialog
	bind:open={configureOpen}
	icon={CloudIcon}
	title={configured ? 'Edit R2 settings' : 'Set up R2 backups'}
	description="Create an R2 API token with Object Read & Write on one bucket (Cloudflare → R2 → Manage API tokens). Yoal tests the credentials before saving, then turns on backups."
	action="?/saveR2"
	submitLabel={configured ? 'Test and save' : 'Test and turn on'}
	size="lg"
>
	<Field.Group>
		<div class="grid gap-4 sm:grid-cols-2">
			<Field.Field data-invalid={fieldErrors.accountId ? true : undefined} class="sm:col-span-2">
				<Field.Label for="r2-account">Account ID</Field.Label>
				<Input
					id="r2-account"
					name="accountId"
					required
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					value={data.r2.values.R2_ACCOUNT_ID ?? ''}
					placeholder="32-character hex ID from the R2 overview page"
					aria-invalid={fieldErrors.accountId ? 'true' : undefined}
				/>
				{#if fieldErrors.accountId}<Field.Error>{fieldErrors.accountId}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.bucket ? true : undefined}>
				<Field.Label for="r2-bucket">Bucket</Field.Label>
				<Input
					id="r2-bucket"
					name="bucket"
					required
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					value={data.r2.values.R2_BUCKET ?? ''}
					placeholder="yoal-backups"
					aria-invalid={fieldErrors.bucket ? 'true' : undefined}
				/>
				{#if fieldErrors.bucket}<Field.Error>{fieldErrors.bucket}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={fieldErrors.accessKeyId ? true : undefined}>
				<Field.Label for="r2-key">Access key ID</Field.Label>
				<Input
					id="r2-key"
					name="accessKeyId"
					required
					autocomplete="off"
					spellcheck={false}
					class="font-mono"
					value={data.r2.values.R2_ACCESS_KEY_ID ?? ''}
					aria-invalid={fieldErrors.accessKeyId ? 'true' : undefined}
				/>
				{#if fieldErrors.accessKeyId}<Field.Error>{fieldErrors.accessKeyId}</Field.Error>{/if}
			</Field.Field>
			<Field.Field
				data-invalid={fieldErrors.secretAccessKey ? true : undefined}
				class="sm:col-span-2"
			>
				<Field.Label for="r2-secret">Secret access key</Field.Label>
				<Input
					id="r2-secret"
					name="secretAccessKey"
					type="password"
					autocomplete="new-password"
					class="font-mono"
					required={!savedSecret}
					placeholder={savedSecret ? 'Saved — leave blank to keep it' : ''}
					aria-invalid={fieldErrors.secretAccessKey ? 'true' : undefined}
				/>
				{#if fieldErrors.secretAccessKey}<Field.Error>{fieldErrors.secretAccessKey}</Field.Error>
				{:else}<Field.Description
						>Stored only in /etc/yoal/yoal.env on the server; never shown again.</Field.Description
					>{/if}
			</Field.Field>
		</div>
		<Collapsible.Root
			open={Boolean(
				data.r2.values.R2_ENDPOINT &&
				!data.r2.values.R2_ENDPOINT.endsWith('.r2.cloudflarestorage.com')
			)}
		>
			<Collapsible.Trigger
				class="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
			>
				Advanced: custom endpoint
			</Collapsible.Trigger>
			<Collapsible.Content>
				<Field.Field data-invalid={fieldErrors.endpoint ? true : undefined} class="mt-3">
					<Field.Label for="r2-endpoint">S3 endpoint</Field.Label>
					<Input
						id="r2-endpoint"
						name="endpoint"
						autocomplete="off"
						spellcheck={false}
						class="font-mono"
						value={data.r2.values.R2_ENDPOINT ?? ''}
						placeholder="https://<account>.r2.cloudflarestorage.com"
						aria-invalid={fieldErrors.endpoint ? 'true' : undefined}
					/>
					{#if fieldErrors.endpoint}<Field.Error>{fieldErrors.endpoint}</Field.Error>
					{:else}<Field.Description
							>Leave blank for R2. Use a jurisdiction endpoint (e.g. <code>.eu.</code>) if your
							bucket needs one.</Field.Description
						>{/if}
				</Field.Field>
			</Collapsible.Content>
		</Collapsible.Root>
		{#if data.artifactsInR2}
			<Alert.Root variant="warning">
				<TriangleAlertIcon />
				<Alert.Description>
					Release artifacts are stored in this bucket too, so the bucket cannot be changed here.
					Rotating the keys is fine.
				</Alert.Description>
			</Alert.Root>
		{/if}
	</Field.Group>
</FormDialog>
