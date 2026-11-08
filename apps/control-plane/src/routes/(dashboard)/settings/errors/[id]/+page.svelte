<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import ListIcon from '@lucide/svelte/icons/list';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import ScrollTextIcon from '@lucide/svelte/icons/scroll-text';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { toast } from 'svelte-sonner';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import Panel from '../../../_lib/Panel.svelte';
	import StatStrip from '../../../_lib/service/StatStrip.svelte';
	import type { Stat } from '../../../_lib/service/sections.js';
	import { formatDateTime, formatRelative } from '../../../_lib/format.js';
	import Bars from '../_lib/Bars.svelte';
	import { sourceDescription, sourceLabel, statusLabel, statusTone } from '../_lib/copy.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const issue = $derived(data.issue);
	let selectedId = $state<string | null>(null);
	const event = $derived(
		data.events.find((entry) => entry.id === selectedId) ?? data.events[0] ?? null
	);

	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;

	const stats = $derived.by((): Stat[] => [
		{ label: 'Events', value: issue.count.toLocaleString('en-GB'), icon: ZapIcon },
		{ label: 'Last 24 h', value: issue.count24h.toLocaleString('en-GB'), icon: ClockIcon },
		{
			label: 'First seen',
			value: formatRelative(issue.firstSeenAt),
			caption: issue.firstVersion ? `in ${issue.firstVersion}` : formatDateTime(issue.firstSeenAt),
			icon: CalendarIcon
		},
		{
			label: 'Last seen',
			value: formatRelative(issue.lastSeenAt),
			caption: issue.lastVersion ? `in ${issue.lastVersion}` : formatDateTime(issue.lastSeenAt),
			icon: CalendarIcon
		}
	]);

	const hourLabels = $derived.by(() => {
		const start = Math.floor(data.now / HOUR) * HOUR - 23 * HOUR;
		return data.hourly.map((_, index) =>
			new Date(start + index * HOUR).toLocaleTimeString('en-GB', {
				hour: '2-digit',
				minute: '2-digit'
			})
		);
	});
	const dayLabels = $derived.by(() => {
		const start = Math.floor(data.now / DAY) * DAY - 13 * DAY;
		return data.daily.map((_, index) =>
			new Date(start + index * DAY).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
		);
	});

	const contextEntries = $derived(
		event ? Object.entries(event.context).filter(([, value]) => value !== null && value !== '') : []
	);

	/** Our frames stand out; dependency and runtime frames are dimmed. */
	function frameClass(line: string): string {
		if (!/^\s*at /.test(line)) return 'font-semibold text-foreground';
		return /node_modules|node:|native|bun:|internal\//.test(line)
			? 'text-muted-foreground/60'
			: 'text-foreground';
	}

	function confirmDelete() {
		askConfirm({
			title: 'Delete this issue?',
			description:
				'Its events and counts go too. If the error happens again it starts a new issue.',
			confirmLabel: 'Delete',
			tone: 'danger',
			action: '?/delete',
			apply: false
		});
	}

	function eventSummary(entry: (typeof data.events)[number]): string {
		if (entry.method && entry.path) return `${entry.method} ${entry.path}`;
		if (entry.context.task) return String(entry.context.task);
		return entry.routeId ?? '—';
	}
</script>

<svelte:head><title>{issue.name} · Server errors · Skiff</title></svelte:head>

<div class="space-y-6">
	<div class="space-y-4 border-b pb-5">
		<Button variant="ghost" size="sm" class="-ml-2" href={resolve('/(dashboard)/settings/errors')}>
			<ArrowLeftIcon />Server errors
		</Button>
		<div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
			<div class="min-w-0 flex-1 basis-96 space-y-2">
				<div class="flex flex-wrap items-center gap-2">
					<h2 class="text-lg leading-tight font-semibold tracking-tight">{issue.name}</h2>
					<Badge variant={statusTone[issue.status]}>{statusLabel[issue.status]}</Badge>
					<Badge variant="outline" title={sourceDescription[issue.source]}
						>{sourceLabel[issue.source]}</Badge
					>
				</div>
				<p class="text-sm break-words whitespace-pre-wrap text-muted-foreground">{issue.message}</p>
				{#if issue.culprit}
					<p class="font-mono text-xs break-all text-muted-foreground/80">{issue.culprit}</p>
				{/if}
				<p class="flex items-center gap-1 font-mono text-xs text-muted-foreground">
					{issue.id}<CopyButton value={issue.id} label="Copy issue id" iconOnly variant="ghost" />
				</p>
			</div>
			{#if data.canChange}
				<form
					method="POST"
					action="?/status"
					class="flex shrink-0 flex-wrap items-center gap-2"
					use:enhance={() => {
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success')
								toast.success(String((result.data as { success?: unknown })?.success ?? 'Updated'));
							else if (result.type === 'failure')
								toast.error(
									String((result.data as { message?: unknown })?.message ?? 'Could not update')
								);
						};
					}}
				>
					{#if issue.status !== 'resolved'}
						<Button type="submit" name="status" value="resolved">
							<CircleCheckIcon />Resolve
						</Button>
					{/if}
					{#if issue.status !== 'ignored'}
						<Button type="submit" variant="outline" name="status" value="ignored">
							<EyeOffIcon />Ignore
						</Button>
					{/if}
					{#if issue.status !== 'unresolved'}
						<Button type="submit" variant="outline" name="status" value="unresolved">
							<RotateCcwIcon />Reopen
						</Button>
					{/if}
					<Button type="button" variant="ghost" class="text-destructive" onclick={confirmDelete}>
						<Trash2Icon />Delete
					</Button>
				</form>
			{/if}
		</div>
	</div>

	{#if issue.status === 'resolved' && issue.resolvedAt}
		<Notice tone="success" title="Resolved">
			{issue.resolvedBy
				? `By ${data.users[issue.resolvedBy] ?? issue.resolvedBy}, `
				: ''}{formatDateTime(issue.resolvedAt)}. If it happens again it reopens and raises an alert.
		</Notice>
	{:else if issue.status === 'ignored'}
		<Notice tone="info" title="Ignored">
			New events are still counted, but this issue stays out of the unresolved list and raises no
			alerts.
		</Notice>
	{:else if issue.regressedAt}
		<Notice tone="warning" title="Regressed">
			It was marked resolved and happened again {formatRelative(issue.regressedAt)} ({formatDateTime(
				issue.regressedAt
			)}).
		</Notice>
	{/if}

	<StatStrip label="Issue summary" {stats} />

	<div class="grid gap-4 lg:grid-cols-2">
		<div class="rounded-xl border bg-card px-4 py-3 shadow-xs">
			<p class="mb-2 text-xs text-muted-foreground">Per hour, last 24 hours</p>
			<Bars values={data.hourly} labels={hourLabels} height="h-14" />
		</div>
		<div class="rounded-xl border bg-card px-4 py-3 shadow-xs">
			<p class="mb-2 text-xs text-muted-foreground">Per day, last 14 days</p>
			<Bars values={data.daily} labels={dayLabels} height="h-14" />
		</div>
	</div>

	{#if event}
		<Panel
			title={event.id === data.events[0]?.id ? 'Latest event' : 'Event'}
			description={`${formatDateTime(event.at)}${event.version ? ` · Skiff ${event.version}` : ''}`}
			icon={ScrollTextIcon}
		>
			<div class="space-y-4">
				<dl class="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
					{#if event.method || event.path}
						<div class="min-w-0">
							<dt class="text-xs text-muted-foreground">Request</dt>
							<dd class="truncate font-mono text-xs">{event.method ?? ''} {event.path ?? ''}</dd>
						</div>
					{/if}
					{#if event.routeId}
						<div class="min-w-0">
							<dt class="text-xs text-muted-foreground">Route</dt>
							<dd class="truncate font-mono text-xs">{event.routeId}</dd>
						</div>
					{/if}
					{#if event.status}
						<div>
							<dt class="text-xs text-muted-foreground">Status</dt>
							<dd class="font-mono text-xs">{event.status}</dd>
						</div>
					{/if}
					{#if event.userId}
						<div class="min-w-0">
							<dt class="text-xs text-muted-foreground">User</dt>
							<dd class="truncate text-xs">{data.users[event.userId] ?? event.userId}</dd>
						</div>
					{/if}
					{#if event.orgId}
						<div class="min-w-0">
							<dt class="text-xs text-muted-foreground">Organisation</dt>
							<dd class="truncate font-mono text-xs">{event.orgId}</dd>
						</div>
					{/if}
					{#each contextEntries as [key, value] (key)}
						<div class="min-w-0">
							<dt class="text-xs text-muted-foreground">{key}</dt>
							<dd class="truncate font-mono text-xs">{String(value)}</dd>
						</div>
					{/each}
				</dl>

				{#if event.message !== issue.message}
					<p class="text-sm break-words whitespace-pre-wrap">{event.message}</p>
				{/if}

				{#if event.stack}
					<div class="overflow-hidden rounded-md border bg-muted/50">
						<div class="flex items-center justify-between gap-2 border-b bg-muted px-3 py-1.5">
							<span class="text-xs text-muted-foreground">Stack trace</span>
							<CopyButton value={event.stack} label="Copy stack trace" variant="ghost" />
						</div>
						<pre
							class="max-h-[28rem] overflow-auto p-3 font-mono text-xs leading-relaxed">{#each event.stack.split('\n') as line, index (index)}<span
									class="block {frameClass(line)}">{line}</span
								>{/each}</pre>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">
						{issue.source === 'response'
							? 'A bare 5xx response has no stack trace: the handler answered with this status itself.'
							: 'No stack trace was captured for this event.'}
					</p>
				{/if}
			</div>
		</Panel>
	{/if}

	<Panel
		title="Recent events"
		description="The newest 50 are kept; busy issues store at most one event a second, but every event is counted."
		icon={ListIcon}
		count={data.events.length}
		flush
	>
		{#if data.events.length === 0}
			<p class="px-6 py-4 text-sm text-muted-foreground">
				No stored events (they go after 30 days).
			</p>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>When</Table.Head>
						<Table.Head>Where</Table.Head>
						<Table.Head class="hidden md:table-cell">User</Table.Head>
						<Table.Head class="hidden text-right sm:table-cell">Version</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.events as entry (entry.id)}
						<Table.Row data-state={entry.id === event?.id ? 'selected' : undefined}>
							<Table.Cell class="whitespace-nowrap">
								<button
									type="button"
									class="text-left hover:underline"
									onclick={() => (selectedId = entry.id)}
								>
									<span title={formatDateTime(entry.at)}>{formatRelative(entry.at)}</span>
								</button>
							</Table.Cell>
							<Table.Cell class="max-w-0 min-w-48">
								<span class="block truncate font-mono text-xs">{eventSummary(entry)}</span>
							</Table.Cell>
							<Table.Cell class="hidden text-xs text-muted-foreground md:table-cell">
								{entry.userId ? (data.users[entry.userId] ?? entry.userId) : '—'}
							</Table.Cell>
							<Table.Cell
								class="hidden text-right font-mono text-xs text-muted-foreground sm:table-cell"
							>
								{entry.version ?? '—'}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Panel>
</div>
