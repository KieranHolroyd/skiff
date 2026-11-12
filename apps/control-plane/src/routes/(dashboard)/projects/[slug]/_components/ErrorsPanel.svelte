<script lang="ts">
	import type {
		AppErrorDetail,
		AppErrorIssueView,
		AppErrorListView,
		AppErrorRange,
		AppErrorSettingsView
	} from '@yoal/contracts';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BugIcon from '@lucide/svelte/icons/bug';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SendIcon from '@lucide/svelte/icons/send';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { goto } from '$app/navigation';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../../_lib/EmptyState.svelte';
	import { formatDateTime } from '../../../_lib/format.js';

	let {
		slug,
		origin,
		settings,
		list,
		detail,
		filters,
		can
	}: {
		slug: string;
		origin: string;
		settings: AppErrorSettingsView | null;
		list: AppErrorListView | null;
		detail: AppErrorDetail | null;
		filters: {
			status: string;
			environment: string;
			release: string;
			q: string;
			range: AppErrorRange;
			before: number | null;
		};
		can: { manageErrors: boolean };
	} = $props();

	const tabs = [
		{ id: 'unresolved', label: 'Unresolved' },
		{ id: 'resolved', label: 'Resolved' },
		{ id: 'ignored', label: 'Ignored' },
		{ id: 'all', label: 'All' }
	] as const;

	const ranges: Array<{ value: AppErrorRange; label: string }> = [
		{ value: 'all', label: 'All time' },
		{ value: '24h', label: 'Last 24 hours' },
		{ value: '7d', label: 'Last 7 days' },
		{ value: '30d', label: 'Last 30 days' }
	];

	const snippet = $derived(
		settings?.dsn
			? `<script src="${origin.replace(/\/$/, '')}/e.js" data-dsn="${settings.dsn}"><\/script>`
			: ''
	);
	const maxHourly = $derived(Math.max(1, ...(detail?.hourly ?? [1])));
	const maxDaily = $derived(Math.max(1, ...(detail?.daily ?? [1])));

	function href(next: { status?: string; issue?: string | null; before?: number | null } = {}): string {
		const params = new URLSearchParams({ tab: 'errors', status: next.status ?? filters.status });
		if (filters.environment) params.set('environment', filters.environment);
		if (filters.release) params.set('release', filters.release);
		if (filters.q) params.set('q', filters.q);
		if (filters.range !== 'all') params.set('range', filters.range);
		if (next.before) params.set('before', String(next.before));
		const issue = next.issue === undefined ? detail?.issue.id : next.issue;
		if (issue) params.set('issue', issue);
		return `?${params.toString()}`;
	}

	async function setStatus(ids: string[], next: string) {
		await runAction('?/updateAppErrorStatus', { ids: ids.join(','), status: next });
	}

	function removeIssue(issue: AppErrorIssueView) {
		askConfirm({
			title: 'Delete this issue?',
			description: 'Its events and counts are deleted. If it happens again, it starts over as a new issue.',
			confirmLabel: 'Delete issue',
			tone: 'danger',
			action: '?/deleteAppErrorIssue',
			fields: { issueId: issue.id },
			onResult: (result) => {
				if (result.type === 'success') void goto(href({ issue: null }));
			}
		});
	}

	function removeAll() {
		askConfirm({
			title: 'Delete every app error?',
			description: 'All issues, events and counts for this project are deleted. Error tracking stays on.',
			confirmLabel: 'Delete all errors',
			tone: 'danger',
			action: '?/deleteAllAppErrors'
		});
	}

	async function sendTest() {
		await runAction('?/testAppError');
	}

	async function enable() {
		await runAction('?/enableAppErrors');
	}

	function statusTone(value: string): 'danger' | 'success' | 'info' {
		if (value === 'unresolved') return 'danger';
		if (value === 'resolved') return 'success';
		return 'info';
	}
</script>

{#if !settings}
	<EmptyState
		icon={CircleAlertIcon}
		title="No access to app errors"
		description="Viewing this project's errors needs the project:read permission."
	/>
{:else if !settings.enabled}
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2"><BugIcon class="size-5" /> App errors</Card.Title>
			<Card.Description>
				Track exceptions from this project's app. Sentry SDKs work by changing one DSN, and a static
				site can use one script tag. No sampling setup, no performance data, no replays.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-wrap items-center gap-3">
			{#if can.manageErrors}
				<Button onclick={enable}><CircleAlertIcon />Turn on error tracking</Button>
			{:else}
				<p class="text-sm text-muted-foreground">A project updater can turn this on.</p>
			{/if}
			<p class="text-xs text-muted-foreground">
				Nothing is collected until you turn it on.
			</p>
		</Card.Content>
	</Card.Root>
{:else}
	<div class="space-y-5">
		<Card.Root>
			<Card.Header>
				<Card.Title class="flex items-center gap-2"><BugIcon class="size-5" /> App errors</Card.Title>
				<Card.Description>
					Sentry-compatible errors for this project. Only exceptions are collected; sessions,
					transactions, replays and profiles are discarded.
				</Card.Description>
			</Card.Header>
			<Card.Content class="space-y-4">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-sm font-medium">DSN</span>
					<code class="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{settings.dsn ?? '—'}</code>
					{#if settings.dsn}<CopyButton value={settings.dsn} label="Copy DSN" />{/if}
					{#if can.manageErrors}
						<Button variant="outline" size="sm" onclick={sendTest}><SendIcon />Send test error</Button>
					{/if}
				</div>
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-medium">Static site snippet</span>
						{#if snippet}<CopyButton value={snippet} label="Copy snippet" />{/if}
					</div>
					<pre class="overflow-x-auto rounded border bg-muted/50 p-3 text-xs">{snippet}</pre>
					<p class="text-xs text-muted-foreground">
						Already using Sentry? Replace the Sentry DSN with the one above; no other change.
					</p>
				</div>
				<div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
					<span>{settings.usage.accepted.toLocaleString()} accepted this month</span>
					<span>{settings.usage.dropped.toLocaleString()} dropped</span>
					<span>{settings.usage.ignored.toLocaleString()} ignored telemetry</span>
					<span>limit {settings.usage.limit.toLocaleString()}</span>
				</div>
			</Card.Content>
		</Card.Root>

		{#if can.manageErrors}
			<Card.Root>
				<Card.Header>
					<Card.Title class="text-base">Settings</Card.Title>
				</Card.Header>
				<Card.Content class="space-y-4">
					<form method="POST" action="?/updateAppErrorSettings" class="flex flex-wrap items-end gap-4">
						<label class="grid gap-1 text-sm">
							<span class="font-medium">Store sample rate</span>
							<Input name="sampleRate" type="number" min="0" max="1" step="0.05" value={settings.sampleRate} class="w-28" />
							<span class="text-xs text-muted-foreground">Counts stay exact; this only changes stored events.</span>
						</label>
						<label class="flex items-center gap-2 text-sm">
							<input type="checkbox" name="notify" value="true" checked={settings.notify} class="size-4" />
							<input type="hidden" name="notify" value="false" />
							<span>Notify on a new or regressed issue</span>
						</label>
						<Button type="submit" variant="outline"><CheckIcon />Save</Button>
					</form>
					<div class="flex flex-wrap gap-2">
						<Button variant="outline" size="sm" onclick={() => runAction('?/rotateAppErrorKey')}>
							<RefreshCwIcon />Rotate key
						</Button>
						<Button variant="outline" size="sm" onclick={() => runAction('?/disableAppErrors')}>
							<EyeOffIcon />Turn off
						</Button>
						<Button variant="outline" size="sm" onclick={removeAll}><TrashIcon />Delete all errors</Button>
					</div>
				</Card.Content>
			</Card.Root>
		{/if}

		{#if detail}
			<Card.Root>
				<Card.Header class="gap-3">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0 space-y-1">
							<a href={href({ issue: null })} class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
								<ArrowLeftIcon class="size-3.5" /> Back to issues
							</a>
							<Card.Title class="break-words text-base">{detail.issue.name}: {detail.issue.message}</Card.Title>
							<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								<Badge variant={statusTone(detail.issue.status)}>{detail.issue.status}</Badge>
								<span>{detail.issue.environment}</span>
								{#if detail.issue.lastRelease}<span class="font-mono">{detail.issue.lastRelease}</span>{/if}
								<span>{detail.issue.count.toLocaleString()} event{detail.issue.count === 1 ? '' : 's'}</span>
								<span>last seen {formatDateTime(detail.issue.lastSeenAt)}</span>
							</div>
						</div>
						{#if can.manageErrors}
							<div class="flex shrink-0 flex-wrap justify-end gap-2">
								{#if detail.issue.status !== 'resolved'}
									<Button size="sm" variant="outline" onclick={() => setStatus([detail.issue.id], 'resolved')}>
										<CheckIcon />Resolve
									</Button>
								{/if}
								{#if detail.issue.status !== 'ignored'}
									<Button size="sm" variant="outline" onclick={() => setStatus([detail.issue.id], 'ignored')}>
										<EyeOffIcon />Ignore
									</Button>
								{/if}
								<Button size="sm" variant="outline" onclick={() => setStatus([detail.issue.id], 'unresolved')}>
									<RotateCcwIcon />Reopen
								</Button>
								<Button size="sm" variant="outline" onclick={() => removeIssue(detail.issue)}>
									<TrashIcon />Delete
								</Button>
							</div>
						{/if}
					</div>
				</Card.Header>
				<Card.Content class="space-y-5">
					<div class="space-y-1">
						<div class="flex items-center justify-between text-xs text-muted-foreground">
							<span>Last 24 hours</span>
							<span>{detail.issue.count24h.toLocaleString()} events</span>
						</div>
						<div class="flex h-20 items-end gap-1">
							{#each detail.hourly as value}
								<div class="min-h-0.5 flex-1 rounded-sm bg-primary/60" style={`height: ${Math.max(2, (value / maxHourly) * 100)}%`} title={`${value} events`}></div>
							{/each}
						</div>
					</div>
					<div class="space-y-1">
						<div class="flex items-center justify-between text-xs text-muted-foreground">
							<span>Last 14 days</span>
							<span>{detail.daily.reduce((total, value) => total + value, 0).toLocaleString()} events</span>
						</div>
						<div class="flex h-10 items-end gap-1">
							{#each detail.daily as value}
								<div class="min-h-0.5 flex-1 rounded-sm bg-primary/30" style={`height: ${Math.max(2, (value / maxDaily) * 100)}%`} title={`${value} events`}></div>
							{/each}
						</div>
					</div>
					<div class="space-y-4">
						<div class="flex flex-wrap items-center justify-between gap-2">
							<p class="text-sm font-medium">Stored events</p>
							<p class="text-xs text-muted-foreground">
								{detail.events.length.toLocaleString()} of {detail.issue.count.toLocaleString()} shown; counts are exact and stored events are sampled.
							</p>
						</div>
						{#each detail.events as event}
							<div class="rounded border">
								<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
									<span>{formatDateTime(event.at)}</span>
									{#if event.release}<span class="font-mono">{event.release}</span>{/if}
									{#if event.environment}<span>{event.environment}</span>{/if}
									{#if event.method || event.path}<span class="font-mono">{event.method ?? ''} {event.path ?? ''}</span>{/if}
									{#each Object.entries(event.tags) as [key, value]}
										<Badge variant="info">{key}: {value}</Badge>
									{/each}
									{#each Object.entries(event.contexts) as [key, value]}
										<Badge variant="info">{key}: {value}</Badge>
									{/each}
								</div>
								<div class="space-y-3 p-3">
									{#each event.exceptions as exception}
										<div class="space-y-1">
											<p class="text-sm font-medium">{exception.type}: {exception.value}</p>
											<ul class="space-y-0.5 font-mono text-xs">
												{#each exception.frames as frame}
													<li class="{frame.inApp ? '' : 'text-muted-foreground'} break-all">
														{frame.fn} <span class="text-muted-foreground">{frame.file}{frame.line ? `:${frame.line}` : ''}{frame.column ? `:${frame.column}` : ''}</span>
													</li>
												{/each}
											</ul>
										</div>
									{/each}
									{#if event.extra}
										<pre class="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-xs">{JSON.stringify(event.extra, null, 2)}</pre>
									{/if}
								</div>
							</div>
						{/each}
						{#if detail.events.length === 0}
							<p class="text-sm text-muted-foreground">
								This issue only has counts; its stored events were sampled out or pruned.
							</p>
						{/if}
					</div>
				</Card.Content>
			</Card.Root>
		{:else}
			<form method="GET" class="flex flex-wrap items-end gap-2 rounded-lg border p-3">
				<input type="hidden" name="tab" value="errors" />
				<input type="hidden" name="status" value={filters.status} />
				<label class="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground">
					<span>Search</span>
					<Input name="q" value={filters.q} placeholder="Type, message, culprit or issue id" />
				</label>
				<label class="grid gap-1 text-xs text-muted-foreground">
					<span>Environment</span>
					<NativeSelect.Root name="environment" value={filters.environment} size="sm" class="w-40">
						<NativeSelect.Option value="">Any environment</NativeSelect.Option>
						{#each list?.environments ?? [] as environment (environment)}
							<NativeSelect.Option value={environment}>{environment}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</label>
				<label class="grid gap-1 text-xs text-muted-foreground">
					<span>Release</span>
					<NativeSelect.Root name="release" value={filters.release} size="sm" class="w-40">
						<NativeSelect.Option value="">Any release</NativeSelect.Option>
						{#each list?.releases ?? [] as release (release)}
							<NativeSelect.Option value={release}>{release}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</label>
				<label class="grid gap-1 text-xs text-muted-foreground">
					<span>Range</span>
					<NativeSelect.Root name="range" value={filters.range} size="sm" class="w-40">
						{#each ranges as range (range.value)}
							<NativeSelect.Option value={range.value}>{range.label}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</label>
				<Button type="submit" variant="outline" size="sm">Apply</Button>
			</form>
			<div class="flex flex-wrap items-center gap-1">
				{#each tabs as tab}
					<a
						href={href({ status: tab.id, issue: null })}
						class="rounded-md px-3 py-1.5 text-sm {filters.status === tab.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
					>
						{tab.label}
					</a>
				{/each}
				<span class="ms-auto text-xs text-muted-foreground">{list?.summary.events24h ?? 0} events in 24h</span>
			</div>
			{#if !list || list.issues.length === 0}
				<EmptyState
					icon={BugIcon}
					title="No errors here"
					description={filters.q || filters.environment || filters.release || filters.range !== 'all'
						? 'No issues match these filters. Clear them to see the whole project.'
						: 'Either everything works, or the DSN is not wired up. Send a test error to check the pipe.'}
				>
					{#if can.manageErrors}
						<Button variant="outline" onclick={sendTest}><SendIcon />Send test error</Button>
					{/if}
				</EmptyState>
			{:else}
				<div class="overflow-hidden rounded-lg border">
					{#each list.issues as issue}
						<a
							href={href({ issue: issue.id })}
							class="flex flex-wrap items-center gap-3 border-b px-4 py-3 text-sm last:border-b-0 hover:bg-muted/50"
						>
							<Badge variant={statusTone(issue.status)}>{issue.level}</Badge>
							<span class="min-w-0 flex-1">
								<span class="block truncate font-medium">{issue.name}: {issue.message}</span>
								<span class="block truncate text-xs text-muted-foreground">
									{issue.culprit ?? 'unknown location'} · {issue.environment}
									{#if issue.lastRelease}· {issue.lastRelease}{/if}
								</span>
							</span>
							<span class="text-xs text-muted-foreground">{issue.count.toLocaleString()}</span>
							<span class="w-28 text-end text-xs text-muted-foreground">{formatDateTime(issue.lastSeenAt)}</span>
						</a>
					{/each}
				</div>
				{#if list.nextBefore}
					<div class="flex justify-center">
						<a class="text-sm text-muted-foreground hover:underline" href={href({ before: list.nextBefore })}>
							Load older issues
						</a>
					</div>
				{/if}
			{/if}
		{/if}
	</div>
{/if}
