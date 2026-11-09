<script lang="ts">
	/**
	 * Jobs (plan 09): cron jobs and one-off commands for a process or container project. Everything
	 * is client-side over the REST API with TanStack Query; runs poll while one is going.
	 */
	import type { JobConcurrency, JobRunStatus, JobRunView, JobView } from '@yoal/contracts';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Badge, type BadgeVariant } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { errorText } from '#lib/query.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import Panel from '../../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative } from '../../../_lib/format.js';
	import ConfirmDialog, { confirmAction } from '../../../dashboards/_lib/ConfirmDialog.svelte';
	import {
		cancelRun,
		createJob,
		deleteJob,
		jobKeys,
		listJobs,
		listRuns,
		runActive,
		runCommand,
		runJob,
		runLogs,
		setPaused,
		updateJob,
		type JobInput
	} from './jobs-api.js';
	import { joinArgs, splitArgs } from './job-command.js';

	let {
		slug,
		deployed,
		can
	}: {
		slug: string;
		/** False before the first deploy: definitions can exist, runs cannot start yet. */
		deployed: boolean;
		can: { manage: boolean; run: boolean; readLogs: boolean };
	} = $props();

	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: jobKeys.all(slug) });

	const jobs = createQuery(() => ({
		queryKey: jobKeys.list(slug),
		queryFn: ({ signal }) => listJobs(slug, signal),
		refetchInterval: 30_000
	}));
	const runs = createQuery(() => ({
		queryKey: jobKeys.runs(slug),
		queryFn: ({ signal }) => listRuns(slug, signal),
		// Poll quickly while something is queued or running, slowly otherwise.
		refetchInterval: (query) => ((query.state.data ?? []).some((run) => runActive(run.status)) ? 2_000 : 30_000)
	}));

	let selectedId = $state<string | null>(null);
	const selected = $derived((runs.data ?? []).find((run) => run.id === selectedId) ?? null);
	const output = createQuery(() => ({
		queryKey: jobKeys.logs(slug, selectedId ?? ''),
		queryFn: ({ signal }) => runLogs(slug, selectedId!, signal),
		enabled: Boolean(selectedId) && can.readLogs,
		refetchInterval: selected && runActive(selected.status) ? 2_000 : false
	}));

	// ---------------------------------------------------------------- display

	const STATUS: Record<JobRunStatus, { label: string; variant: BadgeVariant }> = {
		queued: { label: 'Queued', variant: 'neutral' },
		running: { label: 'Running', variant: 'info' },
		succeeded: { label: 'Succeeded', variant: 'success' },
		failed: { label: 'Failed', variant: 'danger' },
		timeout: { label: 'Timed out', variant: 'danger' },
		cancelled: { label: 'Cancelled', variant: 'neutral' },
		skipped: { label: 'Skipped', variant: 'warning' }
	};

	function duration(ms: number | null): string {
		if (ms === null) return '—';
		if (ms < 1000) return `${ms} ms`;
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
		return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
	}

	// ---------------------------------------------------------------- actions

	async function act(work: () => Promise<unknown>, success: string) {
		try {
			await work();
			toast.success(success);
		} catch (error) {
			toast.error(errorText(error));
		} finally {
			void invalidate();
		}
	}

	async function start(job: JobView) {
		try {
			const run = await runJob(slug, job.name);
			selectedId = run.id;
			toast.success(`Started ${job.name}`);
		} catch (error) {
			toast.error(errorText(error));
		} finally {
			void invalidate();
		}
	}

	function remove(job: JobView) {
		confirmAction({
			title: `Delete job ${job.name}?`,
			description: 'Its schedule, run history and output are removed. A run in progress is stopped.',
			confirmLabel: 'Delete job',
			tone: 'danger',
			run: async () => {
				await deleteJob(slug, job.name);
				void invalidate();
				toast.success(`Deleted ${job.name}`);
			}
		});
	}

	function cancel(run: JobRunView) {
		confirmAction({
			title: 'Stop this run?',
			description: run.status === 'queued' ? 'It has not started yet; it is cancelled now.' : 'The node sends SIGTERM, then SIGKILL after 30 seconds.',
			confirmLabel: 'Stop run',
			tone: 'danger',
			run: async () => {
				await cancelRun(slug, run.id);
				void invalidate();
			}
		});
	}

	// ---------------------------------------------------------------- job form

	let formOpen = $state(false);
	let editing = $state<JobView | null>(null);
	let pending = $state(false);
	let formError = $state('');
	let form = $state({ name: '', command: '', scheduled: true, schedule: '0 3 * * *', timeoutMinutes: '10', concurrency: 'forbid' as JobConcurrency, maxRetries: '0' });
	const parsedCommand = $derived(splitArgs(form.command));

	function openForm(job: JobView | null) {
		editing = job;
		formError = '';
		form = job
			? {
					name: job.name,
					command: joinArgs(job.command),
					scheduled: job.schedule !== null,
					schedule: job.schedule ?? '0 3 * * *',
					timeoutMinutes: String(Math.max(1, Math.round(job.timeoutSeconds / 60))),
					concurrency: job.concurrency,
					maxRetries: String(job.maxRetries)
				}
			: { name: '', command: '', scheduled: true, schedule: '0 3 * * *', timeoutMinutes: '10', concurrency: 'forbid', maxRetries: '0' };
		formOpen = true;
	}

	async function saveJob(event: SubmitEvent) {
		event.preventDefault();
		if (parsedCommand.error || parsedCommand.args.length === 0) {
			formError = parsedCommand.error ?? 'Give the command to run.';
			return;
		}
		const input: JobInput = {
			command: parsedCommand.args,
			schedule: form.scheduled ? form.schedule.trim() : null,
			timeoutSeconds: Math.round(Number(form.timeoutMinutes) * 60),
			concurrency: form.concurrency,
			maxRetries: Number(form.maxRetries)
		};
		pending = true;
		formError = '';
		try {
			if (editing) await updateJob(slug, editing.name, input);
			else await createJob(slug, { name: form.name.trim(), ...input });
			toast.success(editing ? `Saved ${editing.name}` : `Created ${form.name.trim()}`);
			formOpen = false;
			void invalidate();
		} catch (error) {
			formError = errorText(error);
		} finally {
			pending = false;
		}
	}

	// ---------------------------------------------------------------- one-off

	let commandOpen = $state(false);
	let oneOff = $state({ command: '', timeoutMinutes: '10' });
	const parsedOneOff = $derived(splitArgs(oneOff.command));

	async function startCommand(event: SubmitEvent) {
		event.preventDefault();
		if (parsedOneOff.error || parsedOneOff.args.length === 0) {
			formError = parsedOneOff.error ?? 'Give the command to run.';
			return;
		}
		pending = true;
		formError = '';
		try {
			const run = await runCommand(slug, parsedOneOff.args, Math.round(Number(oneOff.timeoutMinutes) * 60));
			selectedId = run.id;
			commandOpen = false;
			toast.success('Command started');
			void invalidate();
		} catch (error) {
			formError = errorText(error);
		} finally {
			pending = false;
		}
	}
</script>

<ConfirmDialog />

<div class="grid gap-5">
	{#if !deployed}
		<Alert.Root>
			<CircleAlertIcon />
			<Alert.Description>Deploy the app first. Jobs run against its current release, on its node.</Alert.Description>
		</Alert.Root>
	{/if}

	<Panel title="Jobs" icon={ClockIcon} count={jobs.data?.length} flush description="Commands on a schedule (UTC) or run by hand, in the app's sandbox with its env, secrets and volumes.">
		{#snippet actions()}
			{#if can.run}
				<Button
					variant="outline"
					size="sm"
					disabled={!deployed}
					onclick={() => {
						formError = '';
						commandOpen = true;
					}}><TerminalIcon />Run command</Button
				>
			{/if}
			{#if can.manage}
				<Button size="sm" onclick={() => openForm(null)}><PlusIcon />New job</Button>
			{/if}
		{/snippet}
		{#if jobs.isPending}
			<div class="space-y-2 p-4"><Skeleton class="h-8 w-full" /><Skeleton class="h-8 w-full" /></div>
		{:else if jobs.isError}
			<p class="p-4 text-sm text-destructive">{errorText(jobs.error)}</p>
		{:else if (jobs.data ?? []).length === 0}
			<div class="p-4">
				<EmptyState
					compact
					icon={ClockIcon}
					title="No jobs yet"
					description="A job is a command such as a nightly cleanup or a report, on a cron schedule or run when you ask. For a one-off migration, use Run command."
				/>
			</div>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Job</Table.Head>
						<Table.Head>Schedule</Table.Head>
						<Table.Head class="hidden lg:table-cell">Command</Table.Head>
						<Table.Head class="hidden md:table-cell">Last run</Table.Head>
						<Table.Head class="w-0 pr-4"><span class="sr-only">Actions</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each jobs.data ?? [] as job (job.id)}
						<Table.Row>
							<Table.Cell class="pl-4 font-medium">
								{job.name}
								{#if !job.enabled}<Badge variant="neutral" class="ml-1">Paused</Badge>{/if}
							</Table.Cell>
							<Table.Cell>
								{#if job.schedule}
									<code class="font-mono text-xs">{job.schedule}</code>
									<span class="block text-xs text-muted-foreground" title={job.nextRunAt ? formatDateTime(job.nextRunAt) : undefined}>
										{job.nextRunAt ? `next ${formatRelative(job.nextRunAt)}` : 'paused'}
									</span>
								{:else}
									<span class="text-muted-foreground">Manual</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="hidden max-w-xs lg:table-cell">
								<code class="block truncate font-mono text-xs" title={joinArgs(job.command)}>{joinArgs(job.command)}</code>
							</Table.Cell>
							<Table.Cell class="hidden md:table-cell">
								{#if job.lastRun}
									<button type="button" class="text-left" onclick={() => (selectedId = job.lastRun!.id)}>
										<Badge variant={STATUS[job.lastRun.status].variant}>{STATUS[job.lastRun.status].label}</Badge>
										<span class="block text-xs text-muted-foreground">{formatRelative(job.lastRun.createdAt)}</span>
									</button>
								{:else}
									<span class="text-muted-foreground">—</span>
								{/if}
							</Table.Cell>
							<Table.Cell class="pr-4">
								<div class="flex justify-end gap-1">
									{#if can.run}
										<Button variant="ghost" size="sm" disabled={!deployed} onclick={() => start(job)} aria-label="Run {job.name} now"><PlayIcon /><span class="hidden sm:inline">Run</span></Button>
									{/if}
									{#if can.manage}
										<Button variant="ghost" size="icon-sm" onclick={() => openForm(job)} aria-label="Edit {job.name}"><PencilIcon /></Button>
										{#if job.schedule}
											<Button
												variant="ghost"
												size="icon-sm"
												onclick={() => act(() => setPaused(slug, job.name, job.enabled), job.enabled ? `Paused ${job.name}` : `Resumed ${job.name}`)}
												aria-label={job.enabled ? `Pause ${job.name}` : `Resume ${job.name}`}
											>
												{#if job.enabled}<PauseIcon />{:else}<PlayIcon />{/if}
											</Button>
										{/if}
										<Button variant="ghost" size="icon-sm" onclick={() => remove(job)} aria-label="Delete {job.name}"><TrashIcon /></Button>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	<Panel title="Runs" icon={HistoryIcon} flush description="The newest runs, scheduled, manual and one-off. Pick one to see its output.">
		{#if runs.isPending}
			<div class="space-y-2 p-4"><Skeleton class="h-8 w-full" /></div>
		{:else if runs.isError}
			<p class="p-4 text-sm text-destructive">{errorText(runs.error)}</p>
		{:else if (runs.data ?? []).length === 0}
			<p class="p-4 text-sm text-muted-foreground">No runs yet.</p>
		{:else}
			<Table.Root>
				<Table.Header class="bg-muted/45">
					<Table.Row>
						<Table.Head class="pl-4">Status</Table.Head>
						<Table.Head>Job</Table.Head>
						<Table.Head class="hidden md:table-cell">Trigger</Table.Head>
						<Table.Head class="hidden sm:table-cell">Started</Table.Head>
						<Table.Head class="pr-4 text-right">Duration</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each runs.data ?? [] as run (run.id)}
						<Table.Row
							class="cursor-pointer {run.id === selectedId ? 'bg-muted/60' : ''}"
							onclick={() => (selectedId = run.id === selectedId ? null : run.id)}
						>
							<Table.Cell class="pl-4">
								<Badge variant={STATUS[run.status].variant}>{STATUS[run.status].label}</Badge>
								{#if run.status === 'failed' && run.exitCode !== null}<span class="ml-1 text-xs text-muted-foreground">exit {run.exitCode}</span>{/if}
							</Table.Cell>
							<Table.Cell>
								{#if run.jobName}{run.jobName}{:else}<code class="font-mono text-xs">{joinArgs(run.command)}</code>{/if}
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
								{run.trigger}{run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
							</Table.Cell>
							<Table.Cell class="hidden text-xs sm:table-cell" title={formatDateTime(run.startedAt ?? run.createdAt)}>
								{formatRelative(run.startedAt ?? run.createdAt)}
							</Table.Cell>
							<Table.Cell class="pr-4 text-right text-xs tabular-nums">{duration(run.durationMs)}</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>

	{#if selected}
		<Panel title={selected.jobName ? `${selected.jobName} · ${selected.id}` : selected.id} icon={TerminalIcon} flush>
			{#snippet actions()}
				{#if can.run && runActive(selected.status)}
					<Button variant="outline" size="sm" onclick={() => cancel(selected)} disabled={selected.cancelRequested}>
						<SquareIcon />{selected.cancelRequested ? 'Stopping…' : 'Stop'}
					</Button>
				{/if}
			{/snippet}
			<div class="grid gap-1 border-b px-4 py-3 text-sm">
				<code class="font-mono text-xs break-all">{joinArgs(selected.command)}</code>
				<p class="text-xs text-muted-foreground">
					{STATUS[selected.status].label}{selected.exitCode !== null ? ` (exit ${selected.exitCode})` : ''} · timeout {Math.round(selected.timeoutSeconds / 60)} min
					{#if selected.deploymentId}· deployment <code class="font-mono">{selected.deploymentId}</code>{/if}
				</p>
				{#if selected.error}<p class="text-xs text-destructive">{selected.error}</p>{/if}
			</div>
			{#if !can.readLogs}
				<p class="p-4 text-sm text-muted-foreground">Reading output needs the logs:read permission.</p>
			{:else if output.isPending && selected.status !== 'skipped'}
				<div class="p-4"><Skeleton class="h-16 w-full" /></div>
			{:else if output.isError}
				<p class="p-4 text-sm text-destructive">{errorText(output.error)}</p>
			{:else if (output.data?.events ?? []).length === 0}
				<p class="p-4 text-sm text-muted-foreground">{runActive(selected.status) ? 'Waiting for output…' : 'No output.'}</p>
			{:else}
				<pre class="max-h-96 overflow-auto bg-muted/30 p-4 font-mono text-xs leading-relaxed">{#each output.data?.events ?? [] as event (event.seq)}<span class={event.stream === 'stderr' || event.level === 'error' ? 'text-destructive' : ''}>{event.message}
</span>{/each}</pre>
			{/if}
		</Panel>
	{/if}
</div>

<Dialog.Root bind:open={formOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>{editing ? `Edit ${editing.name}` : 'New job'}</Dialog.Title>
			<Dialog.Description>The command runs as an argument list, not through a shell. Write <code>sh -c '…'</code> if you need one.</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-5" onsubmit={saveJob}>
			{#if formError}
				<Alert.Root variant="destructive"><CircleAlertIcon /><Alert.Description>{formError}</Alert.Description></Alert.Root>
			{/if}
			<Field.Group>
				{#if !editing}
					<Field.Field>
						<Field.Label for="job-name">Name</Field.Label>
						<Input id="job-name" bind:value={form.name} required maxlength={40} placeholder="nightly-tidy" autocomplete="off" />
						<Field.Description>Lowercase letters, digits and single hyphens.</Field.Description>
					</Field.Field>
				{/if}
				<Field.Field>
					<Field.Label for="job-command">Command</Field.Label>
					<Input id="job-command" bind:value={form.command} required class="font-mono" placeholder="bun scripts/tidy.ts --days 30" autocomplete="off" />
					<Field.Description>
						{#if parsedCommand.error}{parsedCommand.error}{:else if parsedCommand.args.length}{parsedCommand.args.length} argument{parsedCommand.args.length === 1 ? '' : 's'}: {parsedCommand.args.map((arg) => `[${arg}]`).join(' ')}{:else}Quote an argument that has spaces.{/if}
					</Field.Description>
				</Field.Field>
				<Field.Field orientation="horizontal">
					<Switch id="job-scheduled" bind:checked={form.scheduled} />
					<Field.Label for="job-scheduled">Run on a schedule</Field.Label>
				</Field.Field>
				{#if form.scheduled}
					<Field.Field>
						<Field.Label for="job-schedule">Cron (UTC)</Field.Label>
						<Input id="job-schedule" bind:value={form.schedule} required class="font-mono" placeholder="*/15 * * * *" autocomplete="off" />
						<Field.Description>Minute, hour, day of month, month, day of week, in UTC. Day of month and day of week must both match.</Field.Description>
					</Field.Field>
				{/if}
				<div class="grid gap-4 sm:grid-cols-3">
					<Field.Field>
						<Field.Label for="job-timeout">Timeout (min)</Field.Label>
						<Input id="job-timeout" type="number" min={1} max={1440} bind:value={form.timeoutMinutes} required />
					</Field.Field>
					<Field.Field>
						<Field.Label for="job-concurrency">If still running</Field.Label>
						<NativeSelect.Root id="job-concurrency" bind:value={form.concurrency}>
							<NativeSelect.Option value="forbid">Skip the new run</NativeSelect.Option>
							<NativeSelect.Option value="allow">Run both</NativeSelect.Option>
							<NativeSelect.Option value="replace">Stop the old run</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="job-retries">Retries</Field.Label>
						<Input id="job-retries" type="number" min={0} max={10} bind:value={form.maxRetries} required />
					</Field.Field>
				</div>
			</Field.Group>
			<Dialog.Footer>
				<Button variant="outline" type="button" disabled={pending} onclick={() => (formOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={pending}>{#if pending}<Spinner />{/if}{editing ? 'Save' : 'Create job'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={commandOpen}>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title>Run a command</Dialog.Title>
			<Dialog.Description>Runs once against the current release with production env, secrets and data. It is not saved as a job.</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-5" onsubmit={startCommand}>
			{#if formError}
				<Alert.Root variant="destructive"><CircleAlertIcon /><Alert.Description>{formError}</Alert.Description></Alert.Root>
			{/if}
			<Field.Group>
				<Field.Field>
					<Field.Label for="oneoff-command">Command</Field.Label>
					<Input id="oneoff-command" bind:value={oneOff.command} required class="font-mono" placeholder="bun run migrate" autocomplete="off" />
					<Field.Description>
						{#if parsedOneOff.error}{parsedOneOff.error}{:else if parsedOneOff.args.length}{parsedOneOff.args.map((arg) => `[${arg}]`).join(' ')}{:else}Quote an argument that has spaces.{/if}
					</Field.Description>
				</Field.Field>
				<Field.Field>
					<Field.Label for="oneoff-timeout">Timeout (min)</Field.Label>
					<Input id="oneoff-timeout" type="number" min={1} max={1440} bind:value={oneOff.timeoutMinutes} required class="w-32" />
				</Field.Field>
			</Field.Group>
			<Dialog.Footer>
				<Button variant="outline" type="button" disabled={pending} onclick={() => (commandOpen = false)}>Cancel</Button>
				<Button type="submit" disabled={pending}>{#if pending}<Spinner />{/if}Run</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
