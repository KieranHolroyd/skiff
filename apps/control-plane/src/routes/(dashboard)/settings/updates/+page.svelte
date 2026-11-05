<script lang="ts">
	import { browser } from '$app/env';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PackageIcon from '@lucide/svelte/icons/package';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ServerCogIcon from '@lucide/svelte/icons/server-cog';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type {
		SelfUpdateLog,
		SelfUpdateOutcome,
		SelfUpdatePhase,
		SelfUpdateStatus
	} from '@skiff/contracts';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import type { Tone } from '#lib/status.js';
	import { fetchJson } from '#lib/query.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime } from '../../_lib/format.js';
	import UpdateLog from './UpdateLog.svelte';
	import type { PageProps } from './$types';

	type StatusView = SelfUpdateStatus & { stale: boolean };
	interface Live {
		version: string;
		status: StatusView | null;
		pending: boolean;
		inFlight: boolean;
		log: SelfUpdateLog;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as { success?: string; message?: string } | null);

	const queryClient = useQueryClient();
	/** True from the moment an update is queued until the finished state has been loaded. */
	let following = $state(false);
	$effect(() => {
		if (data.inFlight) following = true;
	});

	// The control plane restarts near the end, so failed polls are expected for a few seconds:
	// no retries, keep the interval going, and say we are reconnecting.
	const poll = createQuery(() => ({
		queryKey: ['self-update-status'] as const,
		queryFn: ({ signal }) =>
			fetchJson<Live>('/settings/updates/status', { signal, cache: 'no-store' }),
		enabled: browser && following,
		refetchInterval: 1_000,
		staleTime: 0,
		retry: false
	}));

	$effect(() => {
		const next = poll.data;
		if (!following || !next) return;
		if (next.inFlight && next.version === data.comparison.current) return;
		void invalidateAll().then(() => {
			following = false;
			queryClient.removeQueries({ queryKey: ['self-update-status'] });
		});
	});

	/** Fresh state from the status endpoint while an update runs; null = use the page data. */
	const live = $derived(following ? (poll.data ?? null) : null);
	const reconnecting = $derived(following && poll.isError);
	let checking = $state(false);
	let requesting = $state(false);

	const view = $derived<Live>(
		live ?? {
			version: data.comparison.current,
			status: data.status,
			pending: data.pending,
			inFlight: data.inFlight,
			log: data.log
		}
	);
	const ready = $derived(data.availability === 'ready');
	const running = $derived(view.inFlight);
	const lastRun = $derived(view.status && !view.status.running ? view.status : null);
	/** Until the updater truncates and rewrites the file, a queued run has no log of its own. */
	const currentLog = $derived(
		view.pending && !view.status?.running
			? { lines: [], exists: false, truncated: false, updatedAt: null }
			: view.log
	);

	const steps: Array<{ phase: SelfUpdatePhase; label: string }> = [
		{ phase: 'queued', label: 'Queued' },
		{ phase: 'checking', label: 'Check' },
		{ phase: 'building', label: 'Build' },
		{ phase: 'canary', label: 'Test boot' },
		{ phase: 'swapping', label: 'Restart' },
		{ phase: 'verifying', label: 'Verify' }
	];
	const currentPhase = $derived<SelfUpdatePhase>(
		view.status?.running && !view.status.stale ? view.status.phase : 'queued'
	);
	const currentStep = $derived(
		currentPhase === 'rolling-back'
			? steps.length - 1
			: Math.max(
					0,
					steps.findIndex((step) => step.phase === currentPhase)
				)
	);

	const outcomes: Record<SelfUpdateOutcome, { label: string; tone: Tone }> = {
		updated: { label: 'Updated', tone: 'success' },
		'up-to-date': { label: 'Up to date', tone: 'neutral' },
		skipped: { label: 'Skipped', tone: 'warning' },
		'build-failed': { label: 'Build failed', tone: 'danger' },
		'canary-failed': { label: 'Test boot failed', tone: 'danger' },
		'rolled-back': { label: 'Rolled back', tone: 'warning' },
		error: { label: 'Failed', tone: 'danger' }
	};

	function confirmUpdate(event: MouseEvent) {
		const target = data.comparison.latest;
		const message = [
			target
				? `Update Skiff from ${data.comparison.current} to ${target}?`
				: 'Check GitHub and install the newest version?',
			'',
			'The new version is built and test-booted against a copy of your database first. The control plane then restarts: the dashboard and API are unavailable for a few seconds; deployed sites keep serving.',
			'If it fails its health checks, Skiff rolls back to the current version automatically.'
		].join('\n');
		if (!confirm(message)) event.preventDefault();
	}

	/** Preflight check ids from `evaluateUpgradePreflight`, in words. */
	const checkLabels: Record<string, string> = {
		version: 'Version',
		channel: 'Release channel',
		migrations: 'Database migrations',
		disk: 'Disk space',
		'data-dirs': 'Data directories',
		'backup-target': 'Backup target',
		'last-verified-backup': 'Last verified backup',
		'postgres-major': 'Managed Postgres versions'
	};
	const checkLook = {
		ok: { icon: CircleCheckIcon, tone: 'text-success', label: 'Passed' },
		warn: { icon: TriangleAlertIcon, tone: 'text-warning', label: 'Warning' },
		error: { icon: CircleXIcon, tone: 'text-destructive', label: 'Blocks the update' }
	} as const;
	const rank = { error: 0, warn: 1, ok: 2 } as const;
	// Problems first, so the reason an update is blocked is the first thing read.
	const sortedChecks = $derived(
		[...data.preflight.checks].sort((a, b) => rank[a.status] - rank[b.status])
	);
	const checkCounts = $derived({
		warn: data.preflight.checks.filter((check) => check.status === 'warn').length
	});

	const githubUrl = $derived(`https://github.com/${data.source.repo}/tree/${data.source.ref}`);
</script>

<svelte:head><title>Updates · Settings · Skiff</title></svelte:head>

<div class="space-y-6">
	<FormFeedback {result} />

	<Panel
		title="Version"
		description="Skiff updates itself from the VERSION file on GitHub, compared by semantic versioning."
		icon={PackageIcon}
	>
		{#snippet actions()}
			<form
				method="POST"
				action="?/check"
				use:enhance={() => {
					checking = true;
					return async ({ update }) => {
						await update();
						checking = false;
					};
				}}
			>
				<Button type="submit" variant="outline" size="sm" disabled={checking || running}>
					<RefreshCwIcon class={checking ? 'animate-spin' : ''} aria-hidden="true" />
					Check for updates
				</Button>
			</form>
		{/snippet}

		<dl class="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-3">
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Running</dt>
				<dd class="font-mono text-base font-medium">v{view.version}</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Latest</dt>
				<dd class="flex items-center gap-2">
					{#if data.latest.ok}
						<span class="font-mono text-base font-medium">v{data.latest.version}</span>
						{#if data.comparison.available}
							<StatusBadge
								status="available"
								label={data.comparison.bump ? `${data.comparison.bump} update` : 'update'}
								tone="brand"
							/>
						{/if}
					{:else}
						<span class="text-muted-foreground">Unknown</span>
					{/if}
				</dd>
			</div>
			<div class="space-y-1">
				<dt class="text-xs text-muted-foreground">Source</dt>
				<dd>
					<a
						href={githubUrl}
						target="_blank"
						rel="external noreferrer"
						class="inline-flex items-center gap-1.5 font-mono text-sm underline-offset-4 hover:underline"
					>
						<GitBranchIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
						{data.source.repo}@{data.source.ref}
					</a>
				</dd>
			</div>
		</dl>

		<div class="mt-4 space-y-3">
			{#if !data.latest.ok}
				<Notice tone="warning" title="Couldn't check for updates">
					{data.latest.error}
					{#if ready}The updater can still check with its own GitHub credentials.{/if}
				</Notice>
			{/if}

			{#if data.availability === 'unmanaged'}
				<Notice tone="info" title="Not an installed release">
					This control plane isn't running from an installed release (for example a development
					server), so it can't update itself. Hosts installed with <code>install.sh</code> can.
				</Notice>
			{:else if data.availability === 'not-enabled'}
				<Notice tone="warning" title="Dashboard updates aren't enabled on this host">
					Run <code>sudo skiff-update-self check</code> on the server once. It installs the small systemd
					trigger that lets this page start an update.
				</Notice>
			{:else if !running && data.latest.ok && !data.comparison.available}
				<Notice tone="success">You're on the latest version.</Notice>
			{/if}

			{#if ready && !running && data.comparison.available && !data.preflight.ok}
				<Notice tone="danger" title="This update would be refused">
					A pre-update check below is failing. Fix it first, or the updater stops before changing
					anything.
				</Notice>
			{/if}

			{#if ready && !running && (data.comparison.available || !data.latest.ok)}
				<form
					method="POST"
					action="?/update"
					class="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-3"
					use:enhance={() => {
						requesting = true;
						return async ({ update }) => {
							await update();
							requesting = false;
						};
					}}
				>
					<Button type="submit" disabled={requesting} onclick={confirmUpdate}>
						{#if requesting}
							<LoaderCircleIcon class="animate-spin" aria-hidden="true" />
						{:else}
							<CircleArrowUpIcon aria-hidden="true" />
						{/if}
						{data.comparison.latest
							? `Update to v${data.comparison.latest}`
							: 'Check and install updates'}
					</Button>
					<p class="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
						Built and test-booted before anything changes. The dashboard restarts for a few seconds;
						sites keep serving. Rolls back automatically on failure.
					</p>
				</form>
			{/if}
		</div>
	</Panel>

	{#if running}
		<Panel
			title="Update in progress"
			description={view.status?.toVersion
				? `${view.status.fromVersion ?? 'Current'} → ${view.status.toVersion}`
				: 'Waiting for the updater to start'}
			icon={LoaderCircleIcon}
		>
			<ol class="flex flex-wrap gap-x-1 gap-y-2" aria-label="Update progress">
				{#each steps as step, index (step.phase)}
					{@const done = index < currentStep}
					{@const active = index === currentStep}
					<li
						class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium {active
							? currentPhase === 'rolling-back'
								? 'bg-warning/10 text-warning'
								: 'bg-brand/10 text-brand'
							: done
								? 'text-foreground'
								: 'text-muted-foreground'}"
						aria-current={active ? 'step' : undefined}
					>
						<span
							class="size-1.5 rounded-full {active
								? 'animate-pulse bg-current'
								: done
									? 'bg-success'
									: 'bg-muted-foreground/40'}"
							aria-hidden="true"
						></span>
						{active && currentPhase === 'rolling-back' ? 'Rolling back' : step.label}
					</li>
				{/each}
			</ol>
			<p class="mt-3 text-sm text-pretty" aria-live="polite">
				{view.status?.running
					? view.status.message
					: 'Queued — systemd starts the updater in a moment.'}
			</p>
			{#if reconnecting}
				<p class="mt-2 text-xs text-muted-foreground" aria-live="polite">
					The control plane is restarting; reconnecting…
				</p>
			{/if}
			{#snippet footer()}
				Started {formatDateTime(view.status?.running ? view.status.startedAt : null)}. Building can
				take a few minutes. You can leave this page; the update carries on.
			{/snippet}
		</Panel>

		<UpdateLog log={currentLog} running />
	{:else if view.status?.stale}
		<Notice tone="warning" title="The last update stopped reporting">
			It last reported “{view.status.message}” at {formatDateTime(view.status.updatedAt)} and probably
			crashed. Check <code>journalctl -u skiff-update-self</code> on the server. You can start a new update.
		</Notice>
	{/if}

	{#if !running}
		<Panel
			title="Pre-update checks"
			description={data.preflight.versionChange === 'same'
				? 'Checked against the running version. They run again automatically before every update.'
				: `Checked against v${data.preflight.targetVersion} before anything changes. The updater runs them again on the exact release it downloads.`}
			icon={ShieldCheckIcon}
		>
			{#snippet actions()}
				<StatusBadge
					status={data.preflight.ok ? 'ready' : 'blocked'}
					label={data.preflight.ok
						? checkCounts.warn > 0
							? `Ready · ${checkCounts.warn} to review`
							: 'Ready'
						: 'Blocked'}
					tone={data.preflight.ok ? (checkCounts.warn > 0 ? 'warning' : 'success') : 'danger'}
				/>
			{/snippet}

			<ul class="-my-1 divide-y">
				{#each sortedChecks as check (check.id + check.message)}
					{@const look = checkLook[check.status]}
					<li class="flex items-start gap-3 py-2.5">
						<look.icon class="mt-0.5 size-4 shrink-0 {look.tone}" aria-label={look.label} />
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium">{checkLabels[check.id] ?? check.id}</p>
							<p class="text-sm text-pretty text-muted-foreground">{check.message}</p>
						</div>
					</li>
				{/each}
			</ul>

			{#if data.snapshots.length > 0}
				<div class="mt-4 space-y-2 border-t pt-4">
					<p class="text-xs font-medium text-muted-foreground">Rollback points</p>
					<ul class="space-y-1.5">
						{#each data.snapshots.slice(0, 3) as snapshot (snapshot.dir)}
							<li class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
								<ArchiveIcon class="size-3.5 text-muted-foreground" aria-hidden="true" />
								<span>Before v{snapshot.targetVersion}</span>
								<span class="text-muted-foreground">{formatDateTime(snapshot.createdAt)}</span>
								{#if snapshot.pinned}<Badge variant="secondary">Pinned</Badge>{/if}
								{#if snapshot.hasControlDb}
									<Badge variant="outline" class="font-normal">Includes control database</Badge>
								{/if}
							</li>
						{/each}
					</ul>
					{#if data.snapshots.length > 3}
						<p class="text-xs text-muted-foreground">
							and {data.snapshots.length - 3} older on the server
						</p>
					{/if}
				</div>
			{/if}

			{#snippet footer()}
				If the new version fails its health check after restarting, Skiff rolls back on its own.
				Restoring data or the app key from a rollback point is always a manual step on the server.
			{/snippet}
		</Panel>
	{/if}

	{#if lastRun?.outcome}
		{@const outcome = outcomes[lastRun.outcome]}
		<Panel title="Last update" icon={ServerCogIcon}>
			{#snippet actions()}
				<StatusBadge status={lastRun.outcome ?? 'done'} label={outcome.label} tone={outcome.tone} />
			{/snippet}
			<p class="text-sm text-pretty">{lastRun.message}</p>
			{#snippet footer()}
				{lastRun.trigger === 'dashboard'
					? 'Started from the dashboard'
					: 'Started from the command line'}, finished {formatDateTime(
					lastRun.finishedAt ?? lastRun.updatedAt
				)}. Roll back on the server with <code>sudo skiff-update-self rollback</code>.
			{/snippet}
		</Panel>
	{/if}

	{#if !running && currentLog.exists}
		<UpdateLog log={currentLog} />
	{/if}
</div>
