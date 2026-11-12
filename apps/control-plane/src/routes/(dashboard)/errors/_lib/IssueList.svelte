<script lang="ts">
	/* Filter links are built from the current query string by `issuesHref`. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import type { AppErrorIssueView, AppErrorListView, AppErrorServiceView } from '@yoal/contracts';
	import { untrack } from 'svelte';
	import BugIcon from '@lucide/svelte/icons/bug';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleCheckBigIcon from '@lucide/svelte/icons/circle-check-big';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FilterXIcon from '@lucide/svelte/icons/filter-x';
	import RadarIcon from '@lucide/svelte/icons/radar';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SendIcon from '@lucide/svelte/icons/send';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import XIcon from '@lucide/svelte/icons/x';
	import { goto } from '$app/navigation';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import Bars from './Bars.svelte';
	import {
		activeFilters,
		compactNumber,
		dayLabels,
		isNew,
		isRegressed,
		issuesHref,
		levelColor,
		shortcutBlocked,
		type IssueFilters
	} from './issue-ui.js';

	let {
		service,
		list,
		filters,
		canManage
	}: {
		service: AppErrorServiceView;
		list: AppErrorListView | null;
		filters: IssueFilters;
		canManage: boolean;
	} = $props();

	const PAGE = 50;
	const levels = ['fatal', 'error', 'warning', 'info', 'debug'] as const;
	const ranges = [
		{ value: '24h', label: '24h' },
		{ value: '7d', label: '7d' },
		{ value: '30d', label: '30d' },
		{ value: 'all', label: 'All' }
	] as const;
	const sorts = [
		{ value: 'last_seen', label: 'Last seen' },
		{ value: 'first_seen', label: 'First seen' },
		{ value: 'events', label: 'Most events' }
	] as const;

	const issues = $derived(list?.issues ?? []);
	const summary = $derived(
		list?.summary ?? { unresolved: 0, resolved: 0, ignored: 0, events24h: 0 }
	);
	const statuses = $derived([
		{ id: 'unresolved', label: 'Unresolved', count: summary.unresolved },
		{ id: 'resolved', label: 'Resolved', count: summary.resolved },
		{ id: 'ignored', label: 'Ignored', count: summary.ignored },
		{ id: 'all', label: 'All', count: summary.unresolved + summary.resolved + summary.ignored }
	]);
	const targetName = (id: string) => service.targets.find((target) => target.id === id)?.name;
	const chips = $derived(activeFilters(filters, targetName));
	const narrowed = $derived(chips.length > 0);
	const statusTotal = $derived(statuses.find((status) => status.id === filters.status)?.count ?? 0);
	const everReported = $derived(service.targets.some((target) => target.lastSeenAt !== null));
	const days = $derived(dayLabels(service.daily.length));
	const showTarget = $derived(service.targets.length > 1 && !filters.target);
	const clearAll = $derived(
		issuesHref(filters, {
			q: null,
			target: null,
			level: null,
			environment: null,
			release: null,
			range: null
		})
	);

	const stats = $derived([
		{
			label: 'Unresolved',
			value: service.summary.unresolved.toLocaleString('en-GB'),
			caption: `${service.summary.new24h.toLocaleString('en-GB')} new in the last 24h`
		},
		{
			label: 'Events, 24h',
			value: service.summary.events24h.toLocaleString('en-GB'),
			caption: `${service.daily.reduce((sum, value) => sum + value, 0).toLocaleString('en-GB')} in 14 days`
		},
		{
			label: 'Reporting',
			value: String(service.summary.reporting24h),
			unit: ` / ${service.summary.targets}`,
			caption: 'targets sent an event in 24h'
		},
		{
			label: 'Resolved',
			value: service.summary.resolved.toLocaleString('en-GB'),
			caption: `${service.summary.ignored.toLocaleString('en-GB')} ignored`
		}
	]);

	// Selection and keyboard focus. A selection only ever names issues on the current page.
	let selected = $state<string[]>([]);
	let focused = $state(-1);
	let pending = $state<string | null>(null);
	let rows = $state<HTMLAnchorElement[]>([]);
	let search = $state<HTMLInputElement | null>(null);
	let form = $state<HTMLFormElement | null>(null);

	$effect(() => {
		const ids = new Set(issues.map((issue) => issue.id));
		untrack(() => {
			if (selected.some((id) => !ids.has(id))) selected = selected.filter((id) => ids.has(id));
			if (focused >= issues.length) focused = issues.length - 1;
		});
	});

	const allSelected = $derived(issues.length > 0 && selected.length === issues.length);
	const someSelected = $derived(selected.length > 0 && !allSelected);

	function toggle(id: string) {
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}

	function toggleAll() {
		selected = allSelected ? [] : issues.map((issue) => issue.id);
	}

	async function setStatus(ids: string[], status: 'resolved' | 'ignored' | 'unresolved') {
		if (ids.length === 0 || pending) return;
		pending = status;
		try {
			await runAction('?/updateIssueStatus', { ids: ids.join(','), status });
			selected = selected.filter((id) => !ids.includes(id));
		} finally {
			pending = null;
		}
	}

	function deleteIssues(ids: string[]) {
		askConfirm({
			title: `Delete ${ids.length} issue${ids.length === 1 ? '' : 's'}?`,
			description:
				'Their stored events and counts are deleted. If the error happens again it starts over as a new issue.',
			confirmLabel: ids.length === 1 ? 'Delete issue' : 'Delete issues',
			tone: 'danger',
			action: '?/deleteIssues',
			fields: { ids: ids.join(',') },
			onResult: (result) => {
				if (result.type === 'success') selected = selected.filter((id) => !ids.includes(id));
			}
		});
	}

	async function sendTest() {
		const target = service.targets.find((row) => row.id === filters.target) ?? service.targets[0];
		if (!target || pending) return;
		pending = 'test';
		try {
			await runAction('?/testTarget', { targetId: target.id });
		} finally {
			pending = null;
		}
	}

	function submit() {
		form?.requestSubmit();
	}

	function move(step: number) {
		if (issues.length === 0) return;
		focused = Math.min(issues.length - 1, Math.max(0, focused + step));
		rows[focused]?.focus();
		rows[focused]?.scrollIntoView({ block: 'nearest' });
	}

	/** The issues a shortcut acts on: the selection, else the focused row. */
	function targets(): string[] {
		if (selected.length > 0) return selected;
		const issue = issues[focused];
		return issue ? [issue.id] : [];
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && selected.length > 0 && !shortcutBlocked(event)) {
			selected = [];
			return;
		}
		if (shortcutBlocked(event)) return;
		const key = event.key;
		if (key === '/') {
			event.preventDefault();
			search?.focus();
			search?.select();
		} else if (key === 'j' || key === 'ArrowDown') {
			if (key === 'ArrowDown' && focused < 0) return;
			event.preventDefault();
			move(1);
		} else if (key === 'k' || key === 'ArrowUp') {
			if (key === 'ArrowUp' && focused < 0) return;
			event.preventDefault();
			move(-1);
		} else if (key === 'x' && issues[focused]) {
			toggle(issues[focused].id);
		} else if (key === 'o' && issues[focused]) {
			void goto(issuesHref(filters, { issue: issues[focused].id }));
		} else if (canManage && key === 'r') {
			void setStatus(targets(), 'resolved');
		} else if (canManage && key === 'i') {
			void setStatus(targets(), 'ignored');
		} else if (canManage && key === 'u') {
			void setStatus(targets(), 'unresolved');
		}
	}

	function target(issue: AppErrorIssueView): string {
		return issue.targetName ?? 'Unknown target';
	}
</script>

<svelte:window {onkeydown} />

{#snippet levelEdge(level: string)}
	<span class="w-1 shrink-0 self-stretch {levelColor(level)}" aria-hidden="true"></span>
{/snippet}

<div class="space-y-4">
	<StatStrip label="Errors overview" {stats} />

	<Card.Root class="gap-0 py-0">
		<Card.Content class="grid gap-6 py-4 md:grid-cols-[2fr_1fr]">
			<Bars title="Events, last 14 days" values={service.daily} labels={days} height="h-14" />
			<Bars
				title="New issues, last 14 days"
				values={service.newDaily}
				labels={days}
				unit="new issues"
				tone="muted"
				height="h-14"
			/>
		</Card.Content>
	</Card.Root>

	<section class="space-y-3" aria-label="Issues">
		<div class="flex flex-wrap items-center gap-2">
			<nav
				class="flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border bg-muted/30 p-0.5"
				aria-label="Issue status"
			>
				{#each statuses as status (status.id)}
					<Button
						href={issuesHref(filters, { status: status.id })}
						variant={filters.status === status.id ? 'secondary' : 'ghost'}
						size="sm"
						class="h-7 gap-1.5 px-2.5 text-xs {filters.status === status.id ? 'shadow-xs' : ''}"
						aria-current={filters.status === status.id ? 'page' : undefined}
						data-sveltekit-noscroll
					>
						{status.label}
						<span class="text-muted-foreground tabular-nums">{compactNumber(status.count)}</span>
					</Button>
				{/each}
			</nav>
			<div
				class="ms-auto flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5"
				role="group"
				aria-label="Last seen within"
			>
				{#each ranges as range (range.value)}
					<Button
						href={issuesHref(filters, { range: range.value })}
						variant={filters.range === range.value ? 'secondary' : 'ghost'}
						size="sm"
						class="h-7 px-2.5 text-xs {filters.range === range.value ? 'shadow-xs' : ''}"
						aria-current={filters.range === range.value ? 'true' : undefined}
						data-sveltekit-noscroll
					>
						{range.label}
					</Button>
				{/each}
			</div>
		</div>

		<form
			bind:this={form}
			method="GET"
			class="flex flex-wrap items-center gap-2"
			data-sveltekit-keepfocus
			data-sveltekit-noscroll
		>
			<input type="hidden" name="tab" value="issues" />
			{#if filters.status !== 'unresolved'}<input
					type="hidden"
					name="status"
					value={filters.status}
				/>{/if}
			{#if filters.range !== 'all'}<input type="hidden" name="range" value={filters.range} />{/if}
			<InputGroup.Root class="min-w-56 flex-1">
				<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
				<InputGroup.Input
					bind:ref={search}
					name="q"
					value={filters.q}
					placeholder="Search issues"
					title="Matches the error type, message, culprit or an issue id"
					aria-label="Search issues"
					autocomplete="off"
					spellcheck="false"
				/>
				<InputGroup.Addon align="inline-end" class="hidden sm:flex"><Kbd>/</Kbd></InputGroup.Addon>
			</InputGroup.Root>
			{#if service.targets.length > 1}
				<NativeSelect.Root
					name="target"
					value={filters.target}
					size="sm"
					class="w-40"
					aria-label="Target"
					onchange={submit}
				>
					<NativeSelect.Option value="">All targets</NativeSelect.Option>
					{#each service.targets as row (row.id)}
						<NativeSelect.Option value={row.id}>{row.name}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			{:else if filters.target}
				<input type="hidden" name="target" value={filters.target} />
			{/if}
			<NativeSelect.Root
				name="level"
				value={filters.level}
				size="sm"
				class="w-32"
				aria-label="Level"
				onchange={submit}
			>
				<NativeSelect.Option value="">Any level</NativeSelect.Option>
				{#each levels as level (level)}
					<NativeSelect.Option value={level}>{level}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			{#if (list?.environments.length ?? 0) > 0 || filters.environment}
				<NativeSelect.Root
					name="environment"
					value={filters.environment}
					size="sm"
					class="w-40"
					aria-label="Environment"
					onchange={submit}
				>
					<NativeSelect.Option value="">Any environment</NativeSelect.Option>
					{#each list?.environments ?? [] as environment (environment)}
						<NativeSelect.Option value={environment}>{environment}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			{/if}
			{#if (list?.releases.length ?? 0) > 0 || filters.release}
				<NativeSelect.Root
					name="release"
					value={filters.release}
					size="sm"
					class="w-40"
					aria-label="Release"
					onchange={submit}
				>
					<NativeSelect.Option value="">Any release</NativeSelect.Option>
					{#each list?.releases ?? [] as release (release)}
						<NativeSelect.Option value={release}>{release}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
			{/if}
			<NativeSelect.Root
				name="sort"
				value={filters.sort}
				size="sm"
				class="w-36"
				aria-label="Sort"
				onchange={submit}
			>
				{#each sorts as sort (sort.value)}
					<NativeSelect.Option value={sort.value}>{sort.label}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<button type="submit" class="sr-only">Search</button>
		</form>

		{#if narrowed}
			<div class="flex flex-wrap items-center gap-1.5 text-xs">
				{#each chips as chip (chip.key)}
					<a
						href={issuesHref(filters, { [chip.key]: null })}
						class="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 pr-1.5 pl-2.5 hover:bg-muted"
						aria-label="Remove {chip.label} filter"
						data-sveltekit-noscroll
					>
						<span class="text-muted-foreground">{chip.label}</span>
						<span class="max-w-48 truncate font-medium">{chip.value}</span>
						<XIcon class="size-3 text-muted-foreground" />
					</a>
				{/each}
				<a
					href={clearAll}
					class="px-1.5 text-muted-foreground hover:text-foreground hover:underline"
					data-sveltekit-noscroll
				>
					Clear all
				</a>
			</div>
		{/if}

		{#if issues.length === 0}
			{#if narrowed}
				<EmptyState
					icon={FilterXIcon}
					title="No issues match"
					description="Nothing in this view fits every filter. Remove one, or clear them all."
				>
					<Button variant="outline" href={clearAll}><FilterXIcon />Clear filters</Button>
				</EmptyState>
			{:else if !everReported}
				<EmptyState
					icon={RadarIcon}
					title="Waiting for the first error"
					description="No target has reported yet. Finish the setup, or send a test error through the real ingest path to see what an issue looks like."
				>
					<Button href="?tab=setup"><RocketIcon />Open setup</Button>
					{#if canManage && service.targets.length > 0}
						<Button variant="outline" onclick={sendTest} disabled={pending !== null}>
							{#if pending === 'test'}<Spinner />{:else}<SendIcon />{/if}Send test error
						</Button>
					{/if}
				</EmptyState>
			{:else if filters.status === 'unresolved'}
				<EmptyState
					icon={CircleCheckBigIcon}
					title="Nothing unresolved"
					description="Every error reported so far is resolved or ignored. New ones and regressions land here."
				>
					<Button variant="outline" href={issuesHref(filters, { status: 'resolved' })}
						>View resolved</Button
					>
				</EmptyState>
			{:else}
				<EmptyState
					icon={BugIcon}
					title="No {filters.status === 'all' ? '' : filters.status} issues"
					compact
				/>
			{/if}
		{:else}
			<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
				<div
					class="flex items-center border-b bg-muted/40 text-xs font-medium text-muted-foreground"
				>
					<span class="w-1 shrink-0"></span>
					<div class="flex items-center px-3 py-2">
						<Checkbox
							checked={allSelected}
							indeterminate={someSelected}
							onCheckedChange={toggleAll}
							aria-label="Select every issue on this page"
						/>
					</div>
					<span class="flex-1 py-2">Issue</span>
					<span class="hidden w-24 py-2 pr-3 text-right sm:block">Events</span>
					<span class="w-24 py-2 pr-4 text-right">Last seen</span>
				</div>
				<ul>
					{#each issues as issue, index (issue.id)}
						{@const checked = selected.includes(issue.id)}
						<li
							class="group relative flex items-stretch border-b transition-colors last:border-b-0 {checked
								? 'bg-primary/5'
								: 'hover:bg-muted/40'} {focused === index ? 'bg-muted/50' : ''}"
							onfocusin={() => (focused = index)}
						>
							{@render levelEdge(issue.level)}
							<div class="flex items-start px-3 pt-3">
								<Checkbox
									{checked}
									onCheckedChange={() => toggle(issue.id)}
									aria-label="Select {issue.name}"
								/>
							</div>
							<a
								bind:this={rows[index]}
								href={issuesHref(filters, { issue: issue.id, offset: filters.offset || null })}
								class="min-w-0 flex-1 py-2.5 pr-3 outline-none focus-visible:underline"
							>
								<span class="flex min-w-0 items-center gap-2">
									<span class="shrink-0 font-semibold">{issue.name}</span>
									{#if isRegressed(issue)}
										<Badge variant="warning" class="h-4 shrink-0 px-1.5 text-[10px] uppercase"
											>Regressed</Badge
										>
									{:else if isNew(issue)}
										<Badge variant="info" class="h-4 shrink-0 px-1.5 text-[10px] uppercase"
											>New</Badge
										>
									{/if}
									{#if issue.status !== 'unresolved' && filters.status === 'all'}
										<Badge variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] uppercase"
											>{issue.status}</Badge
										>
									{/if}
								</span>
								<span class="mt-0.5 block truncate text-sm text-muted-foreground"
									>{issue.message}</span
								>
								<span
									class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
								>
									{#if issue.culprit}<span class="max-w-full truncate font-mono"
											>{issue.culprit}</span
										>{/if}
									{#if showTarget}<span class="text-foreground/80">{target(issue)}</span>{/if}
									<span>{issue.environment}</span>
									{#if issue.lastRelease}<span class="max-w-40 truncate font-mono"
											>{issue.lastRelease}</span
										>{/if}
									<span class="sm:hidden">{compactNumber(issue.count)} events</span>
								</span>
							</a>
							<div class="hidden w-24 flex-col items-end justify-center pr-3 sm:flex">
								<span class="text-sm font-medium tabular-nums">{compactNumber(issue.count)}</span>
								<span
									class="text-xs text-muted-foreground tabular-nums"
									title="Events in the last 24 hours"
								>
									{issue.count24h > 0 ? `${compactNumber(issue.count24h)} today` : 'none today'}
								</span>
							</div>
							<div class="flex w-24 flex-col items-end justify-center pr-4">
								<span class="text-sm tabular-nums" title={formatDateTime(issue.lastSeenAt)}
									>{formatRelative(issue.lastSeenAt)}</span
								>
								<span
									class="text-xs text-muted-foreground"
									title="First seen {formatDateTime(issue.firstSeenAt)}"
								>
									{formatRelative(issue.firstSeenAt).replace(' ago', ' old')}
								</span>
							</div>
							{#if canManage}
								<div
									class="absolute inset-y-0 right-0 hidden items-center gap-0.5 bg-gradient-to-l from-card via-card to-transparent pr-3 pl-10 group-focus-within:flex group-hover:flex"
								>
									{#if issue.status !== 'resolved'}
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label="Resolve"
											title="Resolve (r)"
											onclick={() => setStatus([issue.id], 'resolved')}
										>
											<CheckIcon />
										</Button>
									{/if}
									{#if issue.status !== 'ignored'}
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label="Ignore"
											title="Ignore (i)"
											onclick={() => setStatus([issue.id], 'ignored')}
										>
											<EyeOffIcon />
										</Button>
									{/if}
									{#if issue.status !== 'unresolved'}
										<Button
											size="icon-sm"
											variant="ghost"
											aria-label="Reopen"
											title="Reopen (u)"
											onclick={() => setStatus([issue.id], 'unresolved')}
										>
											<RotateCcwIcon />
										</Button>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>

			<div class="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
				<span class="tabular-nums">
					{filters.offset + 1}–{filters.offset + issues.length}{#if !narrowed}&nbsp;of {statusTotal.toLocaleString(
							'en-GB'
						)}{/if}
				</span>
				<span class="hidden items-center gap-1.5 lg:flex">
					<Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>x</Kbd> select <Kbd>o</Kbd> open
					{#if canManage}<Kbd>r</Kbd> resolve <Kbd>i</Kbd> ignore{/if}
				</span>
				<div class="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						href={filters.offset > 0
							? issuesHref(filters, { offset: Math.max(0, filters.offset - PAGE) || null })
							: undefined}
						disabled={filters.offset === 0}
						aria-label="Previous page"
					>
						<ChevronLeftIcon />Previous
					</Button>
					<Button
						size="sm"
						variant="outline"
						href={list?.nextOffset != null
							? issuesHref(filters, { offset: list.nextOffset })
							: undefined}
						disabled={list?.nextOffset == null}
						aria-label="Next page"
					>
						Next<ChevronRightIcon />
					</Button>
				</div>
			</div>
		{/if}
	</section>
</div>

{#if canManage && selected.length > 0}
	<div class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
		<div
			class="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-xl border bg-popover px-3 py-2 text-sm shadow-lg"
			role="region"
			aria-label="Bulk actions"
		>
			<span class="pr-1 font-medium tabular-nums">{selected.length} selected</span>
			<span class="text-muted-foreground" aria-hidden="true">·</span>
			{#if filters.status !== 'resolved'}
				<Button
					size="sm"
					onclick={() => setStatus(selected, 'resolved')}
					disabled={pending !== null}
				>
					{#if pending === 'resolved'}<Spinner />{:else}<CheckIcon />{/if}Resolve
				</Button>
			{/if}
			{#if filters.status !== 'ignored'}
				<Button
					size="sm"
					variant="outline"
					onclick={() => setStatus(selected, 'ignored')}
					disabled={pending !== null}
				>
					{#if pending === 'ignored'}<Spinner />{:else}<EyeOffIcon />{/if}Ignore
				</Button>
			{/if}
			{#if filters.status !== 'unresolved'}
				<Button
					size="sm"
					variant="outline"
					onclick={() => setStatus(selected, 'unresolved')}
					disabled={pending !== null}
				>
					{#if pending === 'unresolved'}<Spinner />{:else}<RotateCcwIcon />{/if}Reopen
				</Button>
			{/if}
			<Button
				size="sm"
				variant="outline"
				class="text-destructive hover:bg-destructive/10 hover:text-destructive"
				onclick={() => deleteIssues(selected)}
				disabled={pending !== null}
			>
				<TrashIcon />Delete
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Clear selection (Esc)"
				onclick={() => (selected = [])}
			>
				<XIcon />
			</Button>
		</div>
	</div>
{/if}
