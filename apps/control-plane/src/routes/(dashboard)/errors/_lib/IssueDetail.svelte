<script lang="ts">
	/* Links are relative query strings built by `issuesHref`. */
	/* eslint svelte/no-navigation-without-resolve: ['error', { ignoreLinks: true, ignoreGoto: true }] */
	import type { AppErrorDetail, AppErrorServiceView } from '@yoal/contracts';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronUpIcon from '@lucide/svelte/icons/chevron-up';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import FingerprintIcon from '@lucide/svelte/icons/fingerprint';
	import LinkIcon from '@lucide/svelte/icons/link';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { toast } from 'svelte-sonner';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import RowMenu from '../../_lib/RowMenu.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import { formatDateTime, formatRelative, shortId } from '../../_lib/format.js';
	import Bars from './Bars.svelte';
	import StackTrace from './StackTrace.svelte';
	import {
		dayLabels,
		hourLabels,
		isNew,
		isRegressed,
		issuesHref,
		levelColor,
		levelTone,
		shortcutBlocked,
		statusTone,
		type IssueFilters
	} from './issue-ui.js';

	let {
		detail,
		service,
		filters,
		canManage
	}: {
		detail: AppErrorDetail;
		service: AppErrorServiceView;
		filters: IssueFilters;
		canManage: boolean;
	} = $props();

	const issue = $derived(detail.issue);
	const back = $derived(issuesHref(filters, { offset: filters.offset || null }));
	const target = $derived(service.targets.find((row) => row.id === issue.targetId));
	const regressed = $derived(isRegressed(issue));

	let span = $state<'24h' | '14d'>('24h');
	let eventIndex = $state(0);
	let pending = $state<string | null>(null);

	// A different issue starts on its newest event.
	$effect(() => {
		void issue.id;
		eventIndex = 0;
	});

	const event = $derived(detail.events[Math.min(eventIndex, detail.events.length - 1)] ?? null);
	const tags = $derived(event ? Object.entries(event.tags) : []);
	const contexts = $derived(event ? Object.entries(event.contexts) : []);
	const issueLink = $derived(`${page.url.origin}${page.url.pathname}?tab=issues&issue=${issue.id}`);

	const stats = $derived([
		{
			label: 'Events',
			value: issue.count.toLocaleString('en-GB'),
			caption: `${detail.events.length} stored for inspection`
		},
		{
			label: 'Last 24 hours',
			value: issue.count24h.toLocaleString('en-GB'),
			caption: `${detail.daily.reduce((sum, value) => sum + value, 0).toLocaleString('en-GB')} in 14 days`
		},
		{
			label: 'First seen',
			value: formatRelative(issue.firstSeenAt),
			caption: issue.firstRelease ? `in ${issue.firstRelease}` : formatDateTime(issue.firstSeenAt)
		},
		{
			label: 'Last seen',
			value: formatRelative(issue.lastSeenAt),
			caption: issue.lastRelease ? `in ${issue.lastRelease}` : formatDateTime(issue.lastSeenAt)
		}
	]);

	async function setStatus(status: 'resolved' | 'ignored' | 'unresolved') {
		if (pending || issue.status === status) return;
		pending = status;
		try {
			await runAction('?/updateIssueStatus', { ids: issue.id, status });
		} finally {
			pending = null;
		}
	}

	function remove() {
		askConfirm({
			title: 'Delete this issue?',
			description:
				'Its stored events and counts are deleted. If the error happens again it starts over as a new issue.',
			confirmLabel: 'Delete issue',
			tone: 'danger',
			action: '?/deleteIssue',
			fields: { issueId: issue.id },
			apply: false,
			onResult: (result) => {
				if (result.type === 'success') void goto(back, { refreshAll: true });
			}
		});
	}

	async function copy(value: string, what: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(`${what} copied.`);
		} catch {
			toast.error('Could not copy to the clipboard.');
		}
	}

	function step(by: number) {
		if (detail.events.length === 0) return;
		eventIndex = Math.min(detail.events.length - 1, Math.max(0, eventIndex + by));
	}

	function onkeydown(event: KeyboardEvent) {
		if (shortcutBlocked(event)) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			void goto(back, { reset: false });
		} else if (event.key === 'j') step(1);
		else if (event.key === 'k') step(-1);
		else if (canManage && event.key === 'r') void setStatus('resolved');
		else if (canManage && event.key === 'i') void setStatus('ignored');
		else if (canManage && event.key === 'u') void setStatus('unresolved');
	}
</script>

<svelte:window {onkeydown} />

{#snippet pairs(entries: Array<[string, string]>, empty: string)}
	{#if entries.length === 0}
		<p class="text-xs text-muted-foreground">{empty}</p>
	{:else}
		<dl class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-xs">
			{#each entries as [key, value] (key)}
				<dt class="truncate text-muted-foreground">{key}</dt>
				<dd class="min-w-0 font-mono break-all">{value}</dd>
			{/each}
		</dl>
	{/if}
{/snippet}

<article class="space-y-5" aria-labelledby="issue-title">
	<a
		href={back}
		class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
		data-sveltekit-noscroll
	>
		<ArrowLeftIcon class="size-4" />Issues
		<Kbd class="ms-1 hidden sm:inline-flex">Esc</Kbd>
	</a>

	<header class="flex flex-wrap items-start justify-between gap-4">
		<div class="flex min-w-0 flex-1 gap-3">
			<span
				class="mt-1 w-1 shrink-0 self-stretch rounded-full {levelColor(issue.level)}"
				aria-hidden="true"
			></span>
			<div class="min-w-0 space-y-1.5">
				<div class="flex flex-wrap items-center gap-1.5">
					<Badge variant={levelTone(issue.level)} class="capitalize">{issue.level}</Badge>
					<Badge variant={statusTone(issue.status)} class="capitalize">{issue.status}</Badge>
					{#if regressed}<Badge variant="warning">Regressed</Badge>{:else if isNew(issue)}<Badge
							variant="info">New</Badge
						>{/if}
					<span class="text-xs text-muted-foreground">
						{#if target}
							<a
								href={issuesHref(filters, { target: target.id })}
								class="hover:text-foreground hover:underline">{target.name}</a
							>
						{:else}
							{issue.targetName ?? 'Unknown target'}
						{/if}
						<span aria-hidden="true">·</span>
						{issue.environment}
						{#if issue.platform && issue.platform !== 'other'}
							<span aria-hidden="true">·</span>
							{issue.platform}
						{/if}
					</span>
				</div>
				<h2 id="issue-title" class="text-xl font-semibold tracking-tight break-words">
					{issue.name}
				</h2>
				<p class="text-sm break-words text-muted-foreground">{issue.message}</p>
				{#if issue.culprit}<p class="font-mono text-xs break-all text-muted-foreground">
						{issue.culprit}
					</p>{/if}
			</div>
		</div>
		<div class="flex shrink-0 flex-wrap items-center gap-2">
			{#if canManage}
				{#if issue.status === 'unresolved'}
					<Button
						onclick={() => setStatus('resolved')}
						disabled={pending !== null}
						title="Resolve (r)"
					>
						{#if pending === 'resolved'}<Spinner />{:else}<CheckIcon />{/if}Resolve
					</Button>
					<Button
						variant="outline"
						onclick={() => setStatus('ignored')}
						disabled={pending !== null}
						title="Ignore (i)"
					>
						{#if pending === 'ignored'}<Spinner />{:else}<EyeOffIcon />{/if}Ignore
					</Button>
				{:else}
					<Button
						variant="outline"
						onclick={() => setStatus('unresolved')}
						disabled={pending !== null}
						title="Reopen (u)"
					>
						{#if pending === 'unresolved'}<Spinner />{:else}<RotateCcwIcon />{/if}Reopen
					</Button>
				{/if}
			{/if}
			<RowMenu label="More actions for this issue">
				<DropdownMenu.Item onSelect={() => copy(issueLink, 'Link')}
					><LinkIcon />Copy link</DropdownMenu.Item
				>
				<DropdownMenu.Item onSelect={() => copy(issue.id, 'Issue id')}
					><FingerprintIcon />Copy issue id</DropdownMenu.Item
				>
				{#if canManage}
					{#if issue.status === 'resolved'}
						<DropdownMenu.Item onSelect={() => setStatus('ignored')}
							><EyeOffIcon />Ignore</DropdownMenu.Item
						>
					{:else if issue.status === 'ignored'}
						<DropdownMenu.Item onSelect={() => setStatus('resolved')}
							><CheckIcon />Resolve</DropdownMenu.Item
						>
					{/if}
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={remove}
						><TrashIcon />Delete issue</DropdownMenu.Item
					>
				{/if}
			</RowMenu>
		</div>
	</header>

	{#if regressed && issue.regressedAt}
		<Notice tone="warning" title="Regressed {formatRelative(issue.regressedAt)}">
			This was resolved, then happened again{issue.lastRelease ? ` in ${issue.lastRelease}` : ''}.
			Resolve it once the fix ships; another event reopens it again.
		</Notice>
	{:else if issue.status === 'resolved'}
		<Notice
			tone="success"
			title="Resolved{issue.resolvedAt ? ` ${formatRelative(issue.resolvedAt)}` : ''}"
		>
			If it happens again it reopens and is flagged as a regression.
		</Notice>
	{:else if issue.status === 'ignored'}
		<Notice tone="info" title="Ignored">
			New events are still counted, but the issue stays out of the Unresolved list and sends no
			notifications.
		</Notice>
	{/if}

	<StatStrip label="Issue summary" {stats} />

	<div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
		<div class="min-w-0 space-y-5">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="flex flex-row items-center justify-between gap-2 border-b py-3">
					<Card.Title class="text-sm">Activity</Card.Title>
					<div
						class="flex items-center gap-0.5 rounded-lg border bg-muted/30 p-0.5"
						role="group"
						aria-label="Activity window"
					>
						{#each ['24h', '14d'] as const as option (option)}
							<Button
								size="sm"
								variant={span === option ? 'secondary' : 'ghost'}
								class="h-6 px-2 text-xs"
								aria-pressed={span === option}
								onclick={() => (span = option)}
							>
								{option}
							</Button>
						{/each}
					</div>
				</Card.Header>
				<Card.Content class="py-4">
					{#if span === '24h'}
						<Bars
							title="Last 24 hours"
							values={detail.hourly}
							labels={hourLabels(detail.hourly.length)}
							tone="danger"
							height="h-20"
						/>
					{:else}
						<Bars
							title="Last 14 days"
							values={detail.daily}
							labels={dayLabels(detail.daily.length)}
							tone="danger"
							height="h-20"
						/>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="gap-0 py-0">
				<Card.Header
					class="flex flex-row flex-wrap items-center justify-between gap-2 border-b py-3"
				>
					<div class="min-w-0">
						<Card.Title class="text-sm">
							{eventIndex === 0
								? 'Latest event'
								: `Event ${eventIndex + 1} of ${detail.events.length}`}
						</Card.Title>
						{#if event}
							<p class="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
								<span title={formatDateTime(event.at)}>{formatRelative(event.at)}</span>
								<span aria-hidden="true">·</span>
								<span class="font-mono">{shortId(event.eventId, 12)}</span>
								<CopyButton
									value={event.eventId}
									label="Copy event id"
									iconOnly
									variant="ghost"
									size="icon-xs"
								/>
							</p>
						{/if}
					</div>
					{#if detail.events.length > 1}
						<div class="flex items-center gap-1">
							<Button
								size="icon-sm"
								variant="outline"
								aria-label="Newer event (k)"
								title="Newer (k)"
								disabled={eventIndex === 0}
								onclick={() => step(-1)}
							>
								<ChevronUpIcon />
							</Button>
							<Button
								size="icon-sm"
								variant="outline"
								aria-label="Older event (j)"
								title="Older (j)"
								disabled={eventIndex >= detail.events.length - 1}
								onclick={() => step(1)}
							>
								<ChevronDownIcon />
							</Button>
						</div>
					{/if}
				</Card.Header>
				<Card.Content class="space-y-5 py-4">
					{#if !event}
						<p class="text-sm text-muted-foreground">
							Only counts are kept for this issue: its stored events were sampled out or pruned by
							retention. The next event that is stored shows up here.
						</p>
					{:else}
						{#if event.method || event.path || event.release || event.userId}
							<div class="flex flex-wrap gap-x-5 gap-y-1 text-xs">
								{#if event.method || event.path}
									<span
										><span class="text-muted-foreground">Request</span>
										<span class="font-mono">{event.method ?? ''} {event.path ?? ''}</span></span
									>
								{/if}
								{#if event.release}<span
										><span class="text-muted-foreground">Release</span>
										<span class="font-mono">{event.release}</span></span
									>{/if}
								{#if event.environment}<span
										><span class="text-muted-foreground">Environment</span>
										{event.environment}</span
									>{/if}
								{#if event.userId}<span
										><span class="text-muted-foreground">User</span>
										<span class="font-mono">{event.userId}</span></span
									>{/if}
							</div>
						{/if}

						{#if event.exceptions.length > 0}
							<StackTrace exceptions={event.exceptions} />
						{:else}
							<div class="rounded-lg border bg-muted/30 px-3 py-2 text-sm">{event.message}</div>
						{/if}

						<div class="grid gap-5 sm:grid-cols-2">
							<section class="space-y-2">
								<h3 class="text-sm font-medium">Tags</h3>
								{@render pairs(tags, 'No tags on this event.')}
							</section>
							<section class="space-y-2">
								<h3 class="text-sm font-medium">Context</h3>
								{@render pairs(
									[
										...contexts,
										...(event.sdk ? [['sdk', event.sdk] as [string, string]] : []),
										...(event.platform ? [['platform', event.platform] as [string, string]] : [])
									],
									'No browser, OS or runtime context.'
								)}
							</section>
						</div>

						{#if event.extra}
							<section class="space-y-2">
								<h3 class="text-sm font-medium">Extra</h3>
								<CodeBlock code={JSON.stringify(event.extra, null, 2)} label="extra.json" />
							</section>
						{/if}
					{/if}
				</Card.Content>
			</Card.Root>
		</div>

		<aside class="space-y-5">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="flex flex-row items-center justify-between border-b py-3">
					<Card.Title class="text-sm">Occurrences</Card.Title>
					<span class="text-xs text-muted-foreground tabular-nums">
						{detail.events.length} of {issue.count.toLocaleString('en-GB')}
					</span>
				</Card.Header>
				<Card.Content class="px-0">
					{#if detail.events.length === 0}
						<p class="px-4 py-3 text-xs text-muted-foreground">No stored events.</p>
					{:else}
						<ol class="max-h-[28rem] overflow-y-auto p-1">
							{#each detail.events as row, index (row.id)}
								<li>
									<button
										type="button"
										class="w-full rounded-md px-3 py-2 text-left text-xs transition-colors {index ===
										eventIndex
											? 'bg-muted'
											: 'hover:bg-muted/50'}"
										aria-current={index === eventIndex ? 'true' : undefined}
										onclick={() => (eventIndex = index)}
									>
										<span class="flex items-center justify-between gap-2">
											<span class="font-medium" title={formatDateTime(row.at)}
												>{formatRelative(row.at)}</span
											>
											<span class="truncate font-mono text-muted-foreground"
												>{row.release ?? row.environment ?? ''}</span
											>
										</span>
										{#if row.method || row.path}
											<span class="mt-0.5 block truncate font-mono text-muted-foreground"
												>{row.method ?? ''} {row.path ?? ''}</span
											>
										{/if}
									</button>
								</li>
							{/each}
						</ol>
					{/if}
				</Card.Content>
			</Card.Root>

			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-3"
					><Card.Title class="text-sm">Details</Card.Title></Card.Header
				>
				<Card.Content class="py-3">
					<dl class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs">
						<dt class="text-muted-foreground">Issue id</dt>
						<dd class="flex min-w-0 items-center justify-end gap-0.5 font-mono">
							<span class="truncate">{issue.id}</span>
							<CopyButton
								value={issue.id}
								label="Copy issue id"
								iconOnly
								variant="ghost"
								size="icon-xs"
							/>
						</dd>
						<dt class="text-muted-foreground">Target</dt>
						<dd class="truncate text-right">
							{#if issue.projectSlug}
								<a href="/projects/{issue.projectSlug}" class="hover:underline"
									>{issue.targetName ?? issue.projectSlug}</a
								>
							{:else}
								{issue.targetName ?? '—'}
							{/if}
						</dd>
						<dt class="text-muted-foreground">First release</dt>
						<dd class="truncate text-right font-mono">{issue.firstRelease ?? '—'}</dd>
						<dt class="text-muted-foreground">Last release</dt>
						<dd class="truncate text-right font-mono">{issue.lastRelease ?? '—'}</dd>
						<dt class="text-muted-foreground">First seen</dt>
						<dd class="text-right">{formatDateTime(issue.firstSeenAt)}</dd>
						<dt class="text-muted-foreground">Last seen</dt>
						<dd class="text-right">{formatDateTime(issue.lastSeenAt)}</dd>
						{#if issue.resolvedAt}
							<dt class="text-muted-foreground">Resolved</dt>
							<dd class="text-right">{formatDateTime(issue.resolvedAt)}</dd>
						{/if}
					</dl>
				</Card.Content>
			</Card.Root>

			<p class="hidden flex-wrap items-center gap-1.5 text-xs text-muted-foreground lg:flex">
				<Kbd>j</Kbd><Kbd>k</Kbd> events
				{#if canManage}<Kbd>r</Kbd> resolve <Kbd>i</Kbd> ignore <Kbd>u</Kbd> reopen{/if}
			</p>
		</aside>
	</div>
</article>
