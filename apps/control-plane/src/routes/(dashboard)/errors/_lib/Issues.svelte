<script lang="ts">
	import type {
		AppErrorDetail,
		AppErrorEventView,
		AppErrorIssueView,
		AppErrorListView,
		AppErrorRange,
		AppErrorServiceView,
		AppErrorSort
	} from '@yoal/contracts';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BugIcon from '@lucide/svelte/icons/bug';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
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
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime } from '../../_lib/format.js';

	let {
		service,
		list,
		detail,
		filters,
		canManage
	}: {
		service: AppErrorServiceView | null;
		list: AppErrorListView | null;
		detail: AppErrorDetail | null;
		filters: {
			status: string;
			level: string;
			environment: string;
			release: string;
			target: string;
			q: string;
			range: AppErrorRange;
			sort: AppErrorSort;
			offset: number;
			before: number | null;
		};
		canManage: boolean;
	} = $props();

	const tabs = [
		{ id: 'unresolved', label: 'Unresolved' },
		{ id: 'resolved', label: 'Resolved' },
		{ id: 'ignored', label: 'Ignored' },
		{ id: 'all', label: 'All' }
	] as const;
	const levels = ['fatal', 'error', 'warning', 'info', 'debug'] as const;
	const ranges: Array<{ value: AppErrorRange; label: string }> = [
		{ value: 'all', label: 'All time' },
		{ value: '24h', label: 'Last 24 hours' },
		{ value: '7d', label: 'Last 7 days' },
		{ value: '30d', label: 'Last 30 days' }
	];
	const sorts: Array<{ value: AppErrorSort; label: string }> = [
		{ value: 'last_seen', label: 'Last seen' },
		{ value: 'first_seen', label: 'Newest first' },
		{ value: 'events', label: 'Most events' }
	];
	const maxHourly = $derived(Math.max(1, ...(detail?.hourly ?? [1])));
	const maxDaily = $derived(Math.max(1, ...(detail?.daily ?? [1])));
	const maxTrend = $derived(Math.max(1, ...(service?.daily ?? [1])));
	const maxNewTrend = $derived(Math.max(1, ...(service?.newDaily ?? [1])));
	let selectedIds = $state<string[]>([]);
	let selectedEventId = $state<string | null>(null);
	const selectedEvent: AppErrorEventView | null = $derived(
		detail ? (detail.events.find((event) => event.id === selectedEventId) ?? detail.events[0] ?? null) : null
	);
	const allSelected = $derived(
		Boolean(list?.issues.length) && selectedIds.length === list?.issues.length
	);
	const hasFilters = $derived(
		Boolean(filters.q || filters.level || filters.environment || filters.release || filters.target) ||
			filters.range !== 'all'
	);

	function href(
		next: {
			status?: string;
			target?: string | null;
			issue?: string | null;
			offset?: number | null;
		} = {}
	): string {
		const params = new URLSearchParams({ tab: 'issues', status: next.status ?? filters.status });
		const target = next.target === undefined ? filters.target : next.target;
		if (target) params.set('target', target);
		if (filters.level) params.set('level', filters.level);
		if (filters.environment) params.set('environment', filters.environment);
		if (filters.release) params.set('release', filters.release);
		if (filters.q) params.set('q', filters.q);
		if (filters.range !== 'all') params.set('range', filters.range);
		if (filters.sort !== 'last_seen') params.set('sort', filters.sort);
		if (next.offset) params.set('offset', String(next.offset));
		const issue = next.issue === undefined ? detail?.issue.id : next.issue;
		if (issue) params.set('issue', issue);
		return `?${params.toString()}`;
	}

	function targetLabel(issue: AppErrorIssueView): string {
		return `${issue.targetName ?? 'Unknown target'}${issue.projectSlug ? ` · ${issue.projectSlug}` : ''}`;
	}

	function clearHref(): string {
		return `?${new URLSearchParams({ tab: 'issues', status: filters.status }).toString()}`;
	}

	function toggleSelected(id: string) {
		selectedIds = selectedIds.includes(id)
			? selectedIds.filter((value) => value !== id)
			: [...selectedIds, id];
	}

	function toggleAll() {
		selectedIds = allSelected ? [] : (list?.issues.map((issue) => issue.id) ?? []);
	}

	async function setStatus(ids: string[], next: string) {
		await runAction('?/updateIssueStatus', { ids: ids.join(','), status: next });
		selectedIds = [];
	}

	function deleteSelected() {
		askConfirm({
			title: `Delete ${selectedIds.length} issue${selectedIds.length === 1 ? '' : 's'}?`,
			description: 'Their events and counts are deleted. If they happen again, they start over as new issues.',
			confirmLabel: 'Delete issues',
			tone: 'danger',
			action: '?/deleteIssues',
			fields: { ids: selectedIds.join(',') },
			onResult: (result) => {
				if (result.type === 'success') {
					selectedIds = [];
					void goto(href({ issue: null }));
				}
			}
		});
	}

	function removeIssue(issue: AppErrorIssueView) {
		askConfirm({
			title: 'Delete this issue?',
			description: 'Its events and counts are deleted. If it happens again, it starts over as a new issue.',
			confirmLabel: 'Delete issue',
			tone: 'danger',
			action: '?/deleteIssue',
			fields: { issueId: issue.id },
			onResult: (result) => {
				if (result.type === 'success') void goto(href({ issue: null }));
			}
		});
	}

	async function sendTest() {
		if (!filters.target) return;
		await runAction('?/testTarget', { targetId: filters.target });
	}

	function statusTone(value: string): 'danger' | 'success' | 'info' {
		if (value === 'unresolved') return 'danger';
		if (value === 'resolved') return 'success';
		return 'info';
	}

	function levelTone(value: string): 'danger' | 'warning' | 'success' | 'info' {
		if (value === 'fatal' || value === 'error') return 'danger';
		if (value === 'warning') return 'warning';
		if (value === 'info') return 'info';
		return 'success';
	}

	function stackText(): string {
		if (!selectedEvent) return '';
		return selectedEvent.exceptions
			.map((exception) => {
				const frames = exception.frames
					.map(
						(frame) =>
							`  at ${frame.fn} (${frame.file}${frame.line ? `:${frame.line}` : ''}${frame.column ? `:${frame.column}` : ''})`
					)
					.join('\n');
				return `${exception.type}: ${exception.value}${frames ? `\n${frames}` : ''}`;
			})
			.join('\n\n');
	}
</script>

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
						<Badge variant="info">{targetLabel(detail.issue)}</Badge>
						<Badge variant={levelTone(detail.issue.level)}>{detail.issue.level}</Badge>
						<Badge variant={statusTone(detail.issue.status)}>{detail.issue.status}</Badge>
						<span>{detail.issue.environment}</span>
						{#if detail.issue.lastRelease}<span class="font-mono">{detail.issue.lastRelease}</span>{/if}
						<span>{detail.issue.count.toLocaleString()} event{detail.issue.count === 1 ? '' : 's'}</span>
						<span>first seen {formatDateTime(detail.issue.firstSeenAt)}</span>
						<span>last seen {formatDateTime(detail.issue.lastSeenAt)}</span>
					</div>
				</div>
				{#if canManage}
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
			<div class="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
				<div class="space-y-4">
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

					{#if selectedEvent}
						<div class="space-y-3">
							<div class="flex flex-wrap items-center justify-between gap-2">
								<p class="text-sm font-medium">Exception</p>
								<CopyButton value={stackText()} label="Copy stack" />
							</div>
							{#each selectedEvent.exceptions as exception}
								<div class="rounded-lg border">
									<div class="border-b bg-muted/40 px-3 py-2">
										<p class="text-sm font-medium">{exception.type}: {exception.value}</p>
									</div>
									<ul class="divide-y font-mono text-xs">
										{#each exception.frames as frame}
											<li class="flex gap-3 px-3 py-1.5 {frame.inApp ? '' : 'text-muted-foreground'}">
												<span class="min-w-0 flex-1 break-all">{frame.fn}</span>
												<span class="shrink-0 break-all text-muted-foreground">
													{frame.file}{frame.line ? `:${frame.line}` : ''}{frame.column ? `:${frame.column}` : ''}
												</span>
											</li>
										{/each}
									</ul>
								</div>
							{/each}
							<div class="grid gap-3 sm:grid-cols-2">
								<div class="rounded-lg border p-3">
									<p class="mb-2 text-xs font-medium text-muted-foreground">Tags</p>
									<div class="flex flex-wrap gap-1">
										{#each Object.entries(selectedEvent.tags) as [key, value]}
											<Badge variant="info">{key}: {value}</Badge>
										{:else}
											<span class="text-xs text-muted-foreground">No tags</span>
										{/each}
									</div>
								</div>
								<div class="rounded-lg border p-3">
									<p class="mb-2 text-xs font-medium text-muted-foreground">Context</p>
									<div class="flex flex-wrap gap-1">
										{#each Object.entries(selectedEvent.contexts) as [key, value]}
											<Badge variant="info">{key}: {value}</Badge>
										{:else}
											<span class="text-xs text-muted-foreground">No context</span>
										{/each}
										{#if selectedEvent.method || selectedEvent.path}
											<Badge variant="info">{selectedEvent.method ?? ''} {selectedEvent.path ?? ''}</Badge>
										{/if}
										{#if selectedEvent.sdk}<Badge variant="info">{selectedEvent.sdk}</Badge>{/if}
									</div>
								</div>
							</div>
							{#if selectedEvent.extra}
								<div class="rounded-lg border p-3">
									<p class="mb-2 text-xs font-medium text-muted-foreground">Extra</p>
									<pre class="max-h-48 overflow-auto rounded bg-muted/50 p-2 text-xs">{JSON.stringify(selectedEvent.extra, null, 2)}</pre>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="space-y-2">
					<div class="flex items-center justify-between">
						<p class="text-sm font-medium">Occurrences</p>
						<span class="text-xs text-muted-foreground">
							{detail.events.length.toLocaleString()} of {detail.issue.count.toLocaleString()} stored
						</span>
					</div>
					{#if detail.events.length === 0}
						<p class="text-sm text-muted-foreground">
							This issue only has counts; its stored events were sampled out or pruned.
						</p>
					{:else}
						<div class="max-h-[32rem] space-y-1 overflow-auto rounded-lg border p-1">
							{#each detail.events as event}
								<button
									type="button"
									class="w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors {selectedEvent?.id === event.id ? 'bg-muted' : 'hover:bg-muted/60'}"
									onclick={() => (selectedEventId = event.id)}
								>
									<span class="flex items-center justify-between gap-2">
										<span>{formatDateTime(event.at)}</span>
										<span class="text-muted-foreground">{event.release ?? event.environment ?? ''}</span>
									</span>
									<span class="mt-0.5 block truncate text-muted-foreground">
										{event.method ?? ''} {event.path ?? ''}
									</span>
								</button>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</Card.Content>
	</Card.Root>
{:else}
	<div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
		<Card.Root>
			<Card.Content class="py-4">
				<p class="text-xs text-muted-foreground">Unresolved</p>
				<p class="text-2xl font-semibold">{service?.summary.unresolved.toLocaleString() ?? 0}</p>
				<p class="text-xs text-muted-foreground">{service?.summary.reporting24h ?? 0} of {service?.summary.targets ?? 0} targets active in 24h</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="py-4">
				<p class="text-xs text-muted-foreground">Events in 24h</p>
				<p class="text-2xl font-semibold">{service?.summary.events24h.toLocaleString() ?? 0}</p>
				<div class="mt-1 flex h-6 items-end gap-0.5">
					{#each service?.hourly ?? [] as value}
						<div class="min-h-0.5 flex-1 rounded-sm bg-primary/50" style={`height: ${Math.max(4, (value / Math.max(1, ...(service?.hourly ?? [1]))) * 100)}%`}></div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="py-4">
				<p class="text-xs text-muted-foreground">New issues in 24h</p>
				<p class="text-2xl font-semibold">{service?.summary.new24h.toLocaleString() ?? 0}</p>
				<p class="text-xs text-muted-foreground">{service?.summary.resolved.toLocaleString() ?? 0} resolved · {service?.summary.ignored.toLocaleString() ?? 0} ignored</p>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Content class="py-4">
				<p class="text-xs text-muted-foreground">14-day trend</p>
				<p class="text-2xl font-semibold">{service?.daily.reduce((total, value) => total + value, 0).toLocaleString() ?? 0}</p>
				<div class="mt-1 flex h-8 items-end gap-0.5">
					{#each service?.daily ?? [] as value}
						<div class="min-h-0.5 flex-1 rounded-sm bg-primary/50" style={`height: ${Math.max(4, (value / maxTrend) * 100)}%`} title={`${value} events`}></div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	</div>

	<div class="grid gap-3 lg:grid-cols-2">
		<Card.Root>
			<Card.Header class="pb-2">
				<Card.Title class="text-sm">Events, last 14 days</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="flex h-24 items-end gap-1">
					{#each service?.daily ?? [] as value}
						<div class="min-h-0.5 flex-1 rounded-sm bg-primary/60" style={`height: ${Math.max(2, (value / maxTrend) * 100)}%`} title={`${value} events`}></div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header class="pb-2">
				<Card.Title class="text-sm">New issues, last 14 days</Card.Title>
			</Card.Header>
			<Card.Content>
				<div class="flex h-24 items-end gap-1">
					{#each service?.newDaily ?? [] as value}
						<div class="min-h-0.5 flex-1 rounded-sm bg-primary/30" style={`height: ${Math.max(2, (value / maxNewTrend) * 100)}%`} title={`${value} new issues`}></div>
					{/each}
				</div>
			</Card.Content>
		</Card.Root>
	</div>

	<form method="GET" class="flex flex-wrap items-end gap-2 rounded-lg border p-3">
		<input type="hidden" name="tab" value="issues" />
		<input type="hidden" name="status" value={filters.status} />
		<label class="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground">
			<span>Search</span>
			<Input name="q" value={filters.q} placeholder="Type, message, culprit or issue id" />
		</label>
		<label class="grid gap-1 text-xs text-muted-foreground">
			<span>Target</span>
			<NativeSelect.Root name="target" value={filters.target} size="sm" class="w-44">
				<NativeSelect.Option value="">Every target</NativeSelect.Option>
				{#each service?.targets ?? [] as target (target.id)}
					<NativeSelect.Option value={target.id}>{target.name}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		<label class="grid gap-1 text-xs text-muted-foreground">
			<span>Level</span>
			<NativeSelect.Root name="level" value={filters.level} size="sm" class="w-32">
				<NativeSelect.Option value="">Any level</NativeSelect.Option>
				{#each levels as level (level)}
					<NativeSelect.Option value={level}>{level}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
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
			<NativeSelect.Root name="range" value={filters.range} size="sm" class="w-36">
				{#each ranges as range (range.value)}
					<NativeSelect.Option value={range.value}>{range.label}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		<label class="grid gap-1 text-xs text-muted-foreground">
			<span>Sort</span>
			<NativeSelect.Root name="sort" value={filters.sort} size="sm" class="w-36">
				{#each sorts as sort (sort.value)}
					<NativeSelect.Option value={sort.value}>{sort.label}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
		</label>
		<Button type="submit" variant="outline" size="sm">Apply</Button>
		{#if hasFilters}
			<a class="text-xs text-muted-foreground hover:underline" href={clearHref()}>Clear filters</a>
		{/if}
	</form>

	<div class="flex flex-wrap items-center gap-1">
		{#each tabs as tab}
			<a
				href={href({ status: tab.id, issue: null, offset: null })}
				class="rounded-md px-3 py-1.5 text-sm {filters.status === tab.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
			>
				{tab.label}
			</a>
		{/each}
		<span class="ms-auto text-xs text-muted-foreground">{list?.summary.events24h ?? 0} events in 24h</span>
	</div>

	{#if selectedIds.length > 0}
		<div class="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
			<span class="text-sm">{selectedIds.length} selected</span>
			<Button size="sm" variant="outline" onclick={() => setStatus(selectedIds, 'resolved')}><CheckIcon />Resolve</Button>
			<Button size="sm" variant="outline" onclick={() => setStatus(selectedIds, 'ignored')}><EyeOffIcon />Ignore</Button>
			<Button size="sm" variant="outline" onclick={() => setStatus(selectedIds, 'unresolved')}><RotateCcwIcon />Reopen</Button>
			<Button size="sm" variant="outline" onclick={deleteSelected}><TrashIcon />Delete</Button>
			<Button size="sm" variant="ghost" onclick={() => (selectedIds = [])}>Clear</Button>
		</div>
	{/if}

	{#if !list || list.issues.length === 0}
		<EmptyState
			icon={BugIcon}
			title="No errors here"
			description={hasFilters
				? 'No issues match these filters. Clear them to see every target.'
				: 'Either everything works, or no DSN is wired up yet. Send a test error from Targets to check the pipe.'}
		>
			{#if canManage && filters.target}
				<Button variant="outline" onclick={sendTest}><SendIcon />Send test error</Button>
			{:else}
				<a class="text-sm text-muted-foreground hover:underline" href="?tab=setup">Open setup</a>
			{/if}
		</EmptyState>
	{:else}
		<div class="overflow-hidden rounded-lg border">
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
						<th class="w-10 px-3 py-2">
							<input
								type="checkbox"
								checked={allSelected}
								onchange={toggleAll}
								aria-label="Select every issue on this page"
							/>
						</th>
						<th class="px-3 py-2 font-medium">Issue</th>
						<th class="hidden px-3 py-2 font-medium lg:table-cell">Target</th>
						<th class="hidden px-3 py-2 font-medium xl:table-cell">Culprit</th>
						<th class="px-3 py-2 text-right font-medium">Events</th>
						<th class="px-3 py-2 text-right font-medium">Last seen</th>
					</tr>
				</thead>
				<tbody>
					{#each list.issues as issue (issue.id)}
						<tr class="border-b last:border-b-0 hover:bg-muted/40">
							<td class="px-3 py-2">
								<input
									type="checkbox"
									checked={selectedIds.includes(issue.id)}
									onchange={() => toggleSelected(issue.id)}
									aria-label={`Select ${issue.name}`}
								/>
							</td>
							<td class="min-w-0 px-3 py-2">
								<a class="block min-w-0" href={href({ issue: issue.id })}>
									<span class="flex flex-wrap items-center gap-2">
										<Badge variant={levelTone(issue.level)}>{issue.level}</Badge>
										<span class="truncate font-medium">{issue.name}: {issue.message}</span>
									</span>
									<span class="mt-0.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
										<span>{issue.environment}</span>
										{#if issue.lastRelease}<span class="font-mono">{issue.lastRelease}</span>{/if}
										<span class="lg:hidden">{targetLabel(issue)}</span>
									</span>
								</a>
							</td>
							<td class="hidden px-3 py-2 text-xs text-muted-foreground lg:table-cell">{targetLabel(issue)}</td>
							<td class="hidden max-w-64 truncate px-3 py-2 text-xs text-muted-foreground xl:table-cell">{issue.culprit ?? 'unknown location'}</td>
							<td class="px-3 py-2 text-right text-xs">{issue.count.toLocaleString()}</td>
							<td class="px-3 py-2 text-right text-xs text-muted-foreground">{formatDateTime(issue.lastSeenAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<span class="text-xs text-muted-foreground">
				{list.issues.length} of {list.summary.unresolved + list.summary.resolved + list.summary.ignored} issues
			</span>
			<div class="flex gap-2">
				{#if filters.offset > 0}
					<a class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" href={href({ offset: Math.max(0, filters.offset - 50), issue: null })}>
						<ChevronLeftIcon class="size-4" />Newer
					</a>
				{/if}
				{#if list.nextOffset !== null}
					<a class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline" href={href({ offset: list.nextOffset, issue: null })}>
						Older<ChevronRightIcon class="size-4" />
					</a>
				{/if}
			</div>
		</div>
	{/if}
{/if}
