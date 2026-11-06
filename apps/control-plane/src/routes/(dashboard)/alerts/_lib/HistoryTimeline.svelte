<script lang="ts">
	/**
	 * Alert history, newest first: state changes, notifications (with each channel's outcome),
	 * rule errors, acknowledgements, silences and, for platform admins, the built-in platform
	 * alerts. Kind filters narrow the list; "Load more" pages back with `before`.
	 */
	import type { AlertEventKind, AlertEventView } from '@skiff/contracts';
	import { createInfiniteQuery } from '@tanstack/svelte-query';
	import { resolve } from '$app/paths';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import CheckCheckIcon from '@lucide/svelte/icons/check-check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import SendIcon from '@lucide/svelte/icons/send';
	import ServerIcon from '@lucide/svelte/icons/server';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { errorText } from '#lib/query.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import { getHistory, keys } from './api.js';
	import Labels from './Labels.svelte';
	import StateBadge from './StateBadge.svelte';

	let {
		rule,
		platformAdmin = false,
		pageSize = 50
	}: {
		/** Only this rule's events (a rule's own page). */
		rule?: string;
		/** Platform admins also see the built-in platform alerts (`system`). */
		platformAdmin?: boolean;
		pageSize?: number;
	} = $props();

	const KIND_META: Record<AlertEventKind, { label: string; icon: typeof HistoryIcon }> = {
		state: { label: 'State changes', icon: ActivityIcon },
		notification: { label: 'Notifications', icon: SendIcon },
		error: { label: 'Errors', icon: CircleAlertIcon },
		ack: { label: 'Acknowledgements', icon: CheckCheckIcon },
		silence: { label: 'Silences', icon: BellOffIcon },
		system: { label: 'Platform alerts', icon: ServerIcon }
	};

	const available = $derived(
		(Object.keys(KIND_META) as AlertEventKind[]).filter(
			(kind) => kind !== 'system' || (platformAdmin && !rule)
		)
	);
	/** Empty means every kind. */
	let kinds = $state<AlertEventKind[]>([]);

	function toggle(kind: AlertEventKind) {
		kinds = kinds.includes(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind];
	}

	const history = createInfiniteQuery(() => ({
		queryKey: keys.history({ rule, kinds }),
		queryFn: ({ pageParam, signal }) =>
			getHistory({ rule, kinds, before: pageParam, limit: pageSize }, signal),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last: AlertEventView[]) =>
			last.length < pageSize ? undefined : last.at(-1)?.at,
		refetchInterval: 60_000
	}));

	const events = $derived(history.data?.pages.flat() ?? []);

	function deliveryEntries(event: AlertEventView): Array<[string, string]> {
		return Object.entries(event.delivery ?? {});
	}

	const TONE: Record<string, string> = {
		critical: 'text-destructive',
		warning: 'text-warning',
		info: 'text-muted-foreground'
	};
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
		<button type="button" onclick={() => (kinds = [])} aria-pressed={kinds.length === 0}>
			<Badge variant={kinds.length === 0 ? 'brand' : 'outline'}>All</Badge>
		</button>
		{#each available as kind (kind)}
			{@const on = kinds.includes(kind)}
			<button type="button" onclick={() => toggle(kind)} aria-pressed={on}>
				<Badge variant={on ? 'brand' : 'outline'}>{KIND_META[kind].label}</Badge>
			</button>
		{/each}
		{#if history.isFetching && !history.isPending}
			<Spinner class="size-3.5 text-muted-foreground" aria-label="Refreshing" />
		{/if}
	</div>

	{#if history.isPending}
		<div class="space-y-2">
			<Skeleton class="h-14" /><Skeleton class="h-14" /><Skeleton class="h-14" />
		</div>
	{:else if history.error}
		<Notice tone="danger" title="Could not load alert history">{errorText(history.error)}</Notice>
	{:else if events.length === 0}
		<EmptyState
			compact
			icon={HistoryIcon}
			title="Nothing here yet"
			description={kinds.length
				? 'No events of these kinds. Try another filter.'
				: 'State changes, notifications and silences appear here as rules evaluate.'}
		/>
	{:else}
		<ol class="relative space-y-0 border-l pl-5" aria-label="Alert history">
			{#each events as event (event.id)}
				{@const meta = KIND_META[event.kind]}
				<li class="relative pb-4 last:pb-0">
					<span
						class="absolute top-0.5 -left-[1.95rem] grid size-5 place-items-center rounded-full border bg-background {TONE[
							event.severity
						] ?? ''}"
						aria-hidden="true"
					>
						<meta.icon class="size-3" />
					</span>
					<div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
						<span class="text-sm font-medium">{event.title}</span>
						{#if event.kind === 'state' && event.to}
							<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
								{#if event.from}<StateBadge state={event.from} />→{/if}<StateBadge
									state={event.to}
								/>
							</span>
						{/if}
						{#if event.kind === 'system'}<Badge variant="neutral">Platform</Badge>{/if}
						<time
							class="ml-auto text-xs text-muted-foreground"
							datetime={event.at}
							title={formatDateTime(event.at)}>{formatRelative(event.at)}</time
						>
					</div>
					<div class="mt-1 space-y-1.5 text-xs text-muted-foreground">
						{#if event.ruleId && event.ruleName && !rule}
							<a
								href={resolve('/(dashboard)/alerts/rules/[id]', { id: event.ruleId })}
								class="font-medium text-foreground hover:underline">{event.ruleName}</a
							>
						{/if}
						{#if event.detail}<p class="break-words whitespace-pre-line">{event.detail}</p>{/if}
						{#if Object.keys(event.labels).length > 0}<Labels labels={event.labels} />{/if}
						{#if event.delivery}
							<ul class="flex flex-wrap gap-1.5" aria-label="Delivery">
								{#each deliveryEntries(event) as [channel, outcome] (channel)}
									<li>
										<Badge
											variant={outcome === 'ok' ? 'success' : 'danger'}
											title={outcome === 'ok' ? 'Delivered' : outcome}
										>
											{channel}: {outcome === 'ok' ? 'sent' : outcome}
										</Badge>
									</li>
								{:else}
									<li><Badge variant="neutral">No channels</Badge></li>
								{/each}
							</ul>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
		{#if history.hasNextPage}
			<div class="flex justify-center">
				<Button
					variant="outline"
					size="sm"
					disabled={history.isFetchingNextPage}
					onclick={() => history.fetchNextPage()}
				>
					{#if history.isFetchingNextPage}<Spinner />{/if}Load more
				</Button>
			</div>
		{/if}
	{/if}
</div>
