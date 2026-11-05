<script lang="ts">
	import { browser } from '$app/env';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { untrack } from 'svelte';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CircleArrowUpIcon from '@lucide/svelte/icons/circle-arrow-up';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import CodeIcon from '@lucide/svelte/icons/code';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import TimerIcon from '@lucide/svelte/icons/timer';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
	import type { SelfUpdateLog, SelfUpdateMethod, SelfUpdateStatus } from '@skiff/contracts';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import type { Tone } from '#lib/status.js';
	import { fetchJson } from '#lib/query.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import MethodPicker from './MethodPicker.svelte';
	import PreflightChecks from './PreflightChecks.svelte';
	import UpdateHistory from './UpdateHistory.svelte';
	import UpdateLog from './UpdateLog.svelte';
	import UpdateSteps from './UpdateSteps.svelte';
	import VersionHero from './VersionHero.svelte';
	import { formatElapsed, methodOption, updateSteps } from './update-ui.js';
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
	/**
	 * True from the moment an update is requested until its finished state has been loaded. It
	 * cannot rely on `data.inFlight` alone: systemd consumes the request file before the updater
	 * writes its status, so for a moment nothing on disk says a run is under way.
	 */
	let following = $state(false);
	/** The status `updatedAt` from before the request; a later one proves this run has started. */
	let baseline = $state<string | null>(null);
	/** The updater never picked the request up; stop waiting and point at the server. */
	let startTimedOut = $state(false);
	let checking = $state(false);
	let requesting = $state(false);
	let confirmOpen = $state(false);
	let updateForm = $state<HTMLFormElement | null>(null);

	let method = $state<SelfUpdateMethod>(untrack(() => data.defaultMethod));
	const chosen = $derived(methodOption(method));

	function beginFollowing(previousUpdatedAt: string | null) {
		baseline = previousUpdatedAt;
		startTimedOut = false;
		following = true;
	}

	function stopFollowing() {
		following = false;
		queryClient.removeQueries({ queryKey: ['self-update-status'] });
	}

	// The page was opened (or reloaded) while a run was already queued or running.
	$effect(() => {
		if (requesting || following || !data.inFlight) return;
		beginFollowing(data.status?.updatedAt ?? null);
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

	/** Fresh state from the status endpoint while an update runs; null = use the page data. */
	const live = $derived(following ? (poll.data ?? null) : null);
	const reconnecting = $derived(following && poll.isError);

	const view = $derived<Live>(
		live ?? {
			version: data.comparison.current,
			status: data.status,
			pending: data.pending,
			inFlight: data.inFlight,
			log: data.log
		}
	);
	/** The updater has written progress for this run, not just the previous run's last status. */
	const runObserved = $derived(
		Boolean(view.status && (view.status.running || view.status.updatedAt !== baseline))
	);
	const ready = $derived(data.availability === 'ready');
	/** Following but not observed yet means "queued": the trigger has fired, status is next. */
	const running = $derived(view.inFlight || (following && !runObserved));
	const lastRun = $derived(view.status && !view.status.running && !running ? view.status : null);
	/** Until the updater truncates and rewrites the file, a queued run has no log of its own. */
	const currentLog = $derived(
		(following && !runObserved) || (view.pending && !view.status?.running)
			? { lines: [], exists: false, truncated: false, updatedAt: null }
			: view.log
	);

	$effect(() => {
		const next = poll.data;
		if (!following || !next) return;
		const status = next.status;
		const observed = Boolean(status && (status.running || status.updatedAt !== baseline));
		// Keep following through the gap between the request being consumed and status being
		// written; the previous run's finished status does not mean this run is over.
		if (!observed && !next.inFlight) return;
		if (next.inFlight && next.version === data.comparison.current) return;
		void invalidateAll().then(stopFollowing);
	});

	// If nothing starts at all (for example the path unit was removed), do not sit on "Queued"
	// forever: reload once after a minute and tell the reader where to look.
	$effect(() => {
		if (!following || runObserved || view.inFlight) return;
		const timer = setTimeout(() => {
			startTimedOut = true;
			void invalidateAll().then(stopFollowing);
		}, 60_000);
		return () => clearTimeout(timer);
	});

	/** The run being shown, once the updater has reported on it. */
	const activeRun = $derived(view.status?.running && !view.status.stale ? view.status : null);
	const steps = $derived(updateSteps(activeRun?.method ?? method));
	const currentPhase = $derived(activeRun?.phase ?? 'queued');
	const rollingBack = $derived(currentPhase === 'rolling-back');
	const currentStep = $derived(
		rollingBack
			? steps.length - 1
			: Math.max(
					0,
					steps.findIndex((step) => step.phase === currentPhase)
				)
	);

	// A ticking clock for the elapsed time; only runs while an update does.
	let now = $state(Date.now());
	$effect(() => {
		if (!running) return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 1_000);
		return () => clearInterval(timer);
	});
	const elapsed = $derived(activeRun ? formatElapsed(now - Date.parse(activeRun.startedAt)) : null);

	const target = $derived(data.comparison.latest);
	const canInstall = $derived(ready && !running && (data.comparison.available || !data.latest.ok));

	const lastRunFailed = $derived(
		lastRun?.outcome === 'build-failed' ||
			lastRun?.outcome === 'canary-failed' ||
			lastRun?.outcome === 'error' ||
			lastRun?.outcome === 'rolled-back'
	);
	/** The last run tried this same version and failed: lead with that, not the offer. */
	const retrying = $derived(lastRunFailed && Boolean(target) && lastRun?.toVersion === target);

	/** The headline card: one state, picked in priority order. */
	const hero = $derived.by(
		(): {
			tone: Tone;
			icon: typeof CircleCheckIcon;
			spin?: boolean;
			eyebrow: string;
			title: string;
			description: string;
			target: string | null;
		} => {
			if (running && rollingBack && activeRun) {
				const back = activeRun.fromVersion;
				return {
					tone: 'warning',
					icon: RotateCcwIcon,
					eyebrow: 'Rolling back',
					title: back ? `Rolling back to v${back}` : 'Rolling back',
					description: `${activeRun.toVersion ? `v${activeRun.toVersion}` : 'The new version'} failed its health checks after switching over. Skiff is restoring the previous version on its own.`,
					target: null
				};
			}
			if (running) {
				const to = activeRun?.toVersion ?? target;
				return {
					tone: 'info',
					icon: LoaderCircleIcon,
					spin: true,
					eyebrow: activeRun ? 'Updating' : 'Queued',
					title: to ? `Updating to v${to}` : 'Installing the newest version',
					description: activeRun
						? `Started ${formatRelative(activeRun.startedAt)} via ${methodOption(activeRun.method).short}. You can leave this page; the update carries on.`
						: 'The request is with the server. systemd starts the updater in a moment.',
					target: to && to !== view.version ? to : null
				};
			}
			if (data.availability === 'unmanaged')
				return {
					tone: 'neutral',
					icon: CodeIcon,
					eyebrow: 'Development build',
					title: "This host can't update itself",
					description:
						"The control plane isn't running from an installed release (for example a development server). Hosts installed with install.sh update from here.",
					target: null
				};
			if (!data.latest.ok)
				return {
					tone: 'warning',
					icon: TriangleAlertIcon,
					eyebrow: 'Check failed',
					title: "Couldn't check for updates",
					description: ready
						? `${data.latest.error} The updater can still check with its own GitHub credentials.`
						: data.latest.error,
					target: null
				};
			if (data.comparison.available && retrying && lastRun)
				return {
					tone: 'warning',
					icon: TriangleAlertIcon,
					eyebrow: 'Last attempt failed',
					title: `v${target} didn't install`,
					description: `${lastRun.message} You're still on v${view.version}; fix the cause and try again.`,
					target
				};
			if (data.comparison.available)
				return {
					tone: 'info',
					icon: CircleArrowUpIcon,
					eyebrow: data.comparison.bump ? `${data.comparison.bump} update` : 'Update available',
					title: `Skiff v${target} is available`,
					description:
						'Test-booted against a copy of your data before anything switches over, and rolled back on its own if anything fails.',
					target
				};
			return {
				tone: 'success',
				icon: CircleCheckIcon,
				eyebrow: 'Up to date',
				title: "You're on the latest version",
				description: `v${view.version} is the newest release on ${data.source.repo}@${data.source.ref}.`,
				target: null
			};
		}
	);
</script>

<svelte:head><title>Updates · Settings · Skiff</title></svelte:head>

<SettingsHeader id="updates">
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
				{checking ? 'Checking…' : 'Check for updates'}
			</Button>
		</form>
	{/snippet}
</SettingsHeader>

<div class="space-y-6">
	<FormFeedback {result} />

	<VersionHero
		tone={hero.tone}
		icon={hero.icon}
		spin={hero.spin}
		eyebrow={hero.eyebrow}
		title={hero.title}
		description={hero.description}
		current={view.version}
		target={hero.target}
		bump={data.comparison.bump}
		latest={data.latest.ok ? data.latest.version : null}
		checkedAt={data.latest.checkedAt}
		source={data.source}
	/>

	{#if data.availability === 'not-enabled'}
		<Notice tone="warning" title="Dashboard updates aren't enabled on this host">
			Run <code>sudo skiff-update-self check</code> on the server once. It installs the small systemd
			trigger that lets this page start an update.
		</Notice>
	{/if}

	{#if startTimedOut && !running && !data.inFlight}
		<Notice tone="warning" title="The updater hasn't started">
			The request is queued on the server, but nothing has reported progress yet. Check
			<code>systemctl status skiff-update-self.path</code> and
			<code>journalctl -u skiff-update-self</code>.
		</Notice>
	{/if}

	{#if !running && view.status?.stale}
		<Notice tone="warning" title="The last update stopped reporting">
			It last reported “{view.status.message}” at {formatDateTime(view.status.updatedAt)} and probably
			crashed. Check <code>journalctl -u skiff-update-self</code> on the server. You can start a new update.
		</Notice>
	{/if}

	{#if running}
		<Panel
			title="Progress"
			icon={ActivityIcon}
			description={rollingBack
				? 'A check failed after the switch; restoring the previous version.'
				: 'Each step must pass before the next starts.'}
		>
			{#snippet actions()}
				{#if elapsed}
					<span
						class="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground tabular-nums"
						title="Time since the updater started"
					>
						<TimerIcon class="size-3.5" aria-hidden="true" />
						{elapsed}
					</span>
				{/if}
			{/snippet}

			<UpdateSteps {steps} current={currentStep} {rollingBack} />

			<div
				class="mt-5 flex items-start gap-3 rounded-lg border px-3.5 py-3 {rollingBack
					? 'border-warning/30 bg-warning/5'
					: 'bg-muted/30'}"
			>
				<span class="relative mt-1.5 flex size-2 shrink-0" aria-hidden="true">
					<span
						class="absolute size-full animate-ping rounded-full opacity-60 {rollingBack
							? 'bg-warning'
							: 'bg-info'}"
					></span>
					<span class="relative size-2 rounded-full {rollingBack ? 'bg-warning' : 'bg-info'}"
					></span>
				</span>
				<p class="min-w-0 text-sm text-pretty" aria-live="polite">
					{activeRun ? activeRun.message : 'Queued — systemd starts the updater in a moment.'}
				</p>
			</div>

			{#if reconnecting}
				<p class="mt-3 flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
					<WifiOffIcon class="size-3.5" aria-hidden="true" />
					The control plane is restarting; reconnecting…
				</p>
			{/if}

			{#snippet footer()}
				Building can take a few minutes. The dashboard restarts for a few seconds near the end;
				deployed sites keep serving.
			{/snippet}
		</Panel>

		<UpdateLog log={currentLog} running />
	{/if}

	{#if canInstall}
		<Panel
			title={target ? `Install v${target}` : 'Install the newest version'}
			icon={CircleArrowUpIcon}
			description="Nothing on this host changes until the new version has passed a test boot."
		>
			<form
				bind:this={updateForm}
				method="POST"
				action="?/update"
				class="space-y-6"
				use:enhance={() => {
					// Capture the pre-request status before the action runs, so the first new
					// timestamp proves the updater started this run rather than a previous one.
					const previous = data.status?.updatedAt ?? null;
					requesting = true;
					confirmOpen = false;
					return async ({ result, update }) => {
						await update();
						requesting = false;
						if (result.type === 'success') beginFollowing(previous);
					};
				}}
			>
				<MethodPicker bind:value={method} defaultMethod={data.defaultMethod} />

				<div class="space-y-3">
					<p class="text-xs font-medium text-muted-foreground">What happens</p>
					<UpdateSteps steps={steps.slice(1)} />
				</div>

				<div
					class="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between"
				>
					{#if data.preflight.ok}
						<p class="flex items-center gap-2 text-sm text-muted-foreground">
							<ShieldCheckIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
							Pre-update checks pass. Rolls back on its own if anything fails.
						</p>
					{:else}
						<p class="flex items-start gap-2 text-sm text-pretty">
							<CircleXIcon class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
							<span>
								A pre-update check is failing, so the updater would stop before changing anything.
								<a href="#preflight" class="font-medium underline underline-offset-4"
									>Review checks</a
								>
							</span>
						</p>
					{/if}
					<Button
						type="button"
						class="shrink-0"
						disabled={requesting}
						onclick={() => (confirmOpen = true)}
					>
						{#if requesting}
							<LoaderCircleIcon class="animate-spin" aria-hidden="true" />
						{:else}
							<CircleArrowUpIcon aria-hidden="true" />
						{/if}
						{target ? `Update to v${target}` : 'Check and install'}
					</Button>
				</div>
			</form>
		</Panel>

		<AlertDialog.Root bind:open={confirmOpen}>
			<AlertDialog.Content>
				<AlertDialog.Header>
					<AlertDialog.Media class="bg-info/10 text-info">
						<CircleArrowUpIcon />
					</AlertDialog.Media>
					<AlertDialog.Title>
						{target ? `Update Skiff to v${target}?` : 'Install the newest version?'}
					</AlertDialog.Title>
					<AlertDialog.Description>
						{target
							? 'The new version is test-booted against a copy of your database before anything switches over.'
							: 'The updater checks GitHub itself and installs the newest version, if there is one.'}
					</AlertDialog.Description>
				</AlertDialog.Header>

				<div class="space-y-3 text-sm">
					<div class="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
						{#if target}
							<span class="font-mono text-muted-foreground tabular-nums">v{view.version}</span>
							<ArrowRightIcon class="size-3.5 text-muted-foreground" aria-label="to" />
							<span class="font-mono font-semibold tabular-nums">v{target}</span>
						{/if}
						<span class="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
							<chosen.icon class="size-3.5" />
							{chosen.label}
						</span>
					</div>
					<ul class="space-y-1.5 text-muted-foreground">
						<li class="flex gap-2">
							<span class="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60"></span>
							The dashboard and API are unavailable for a few seconds; deployed sites keep serving.
						</li>
						<li class="flex gap-2">
							<span class="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60"></span>
							{method === 'build'
								? 'The source is compiled on this server, which needs disk space, memory and a few minutes.'
								: 'The release is verified against its signed manifest and checksum before anything runs.'}
						</li>
						<li class="flex gap-2">
							<span class="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground/60"></span>
							If health checks fail, Skiff rolls back to v{view.version} automatically.
						</li>
					</ul>
					{#if !data.preflight.ok}
						<Notice tone="danger" title="A pre-update check is failing">
							The updater will most likely stop before changing anything.
						</Notice>
					{/if}
				</div>

				<AlertDialog.Footer>
					<AlertDialog.Cancel disabled={requesting}>Cancel</AlertDialog.Cancel>
					<Button disabled={requesting} onclick={() => updateForm?.requestSubmit()}>
						{#if requesting}<LoaderCircleIcon class="animate-spin" aria-hidden="true" />{/if}
						Start update
					</Button>
				</AlertDialog.Footer>
			</AlertDialog.Content>
		</AlertDialog.Root>
	{/if}

	{#if !running}
		<PreflightChecks
			checks={data.preflight.checks}
			ok={data.preflight.ok}
			updateAvailable={data.comparison.available}
			description={data.preflight.versionChange === 'same'
				? 'Checked against the running version, so an update is ready to go when one ships.'
				: `Checked against v${data.preflight.targetVersion} before anything changes.`}
		/>

		{#if lastRun?.outcome || data.snapshots.length > 0}
			<UpdateHistory {lastRun} snapshots={data.snapshots} />
		{/if}

		{#if currentLog.exists}
			<UpdateLog log={currentLog} defaultOpen={lastRunFailed} />
		{/if}
	{/if}
</div>
