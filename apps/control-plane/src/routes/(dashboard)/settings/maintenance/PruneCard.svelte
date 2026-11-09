<script lang="ts">
	import { resolve } from '$app/paths';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import InfoIcon from '@lucide/svelte/icons/info';
	import ScanSearchIcon from '@lucide/svelte/icons/scan-search';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import {
		isTerminalOperation,
		pruneCategoryInfo,
		type OperationItemView,
		type OperationView,
		type PruneCategory,
		type PruneScope
	} from '@yoal/contracts';
	import { toast } from 'svelte-sonner';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import StatusBadge from '#lib/components/yoal/StatusBadge.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Progress } from '#lib/components/ui/progress/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatDateTime } from '../../_lib/format.js';
	import {
		applyOperation,
		cancelOperation,
		createOperation,
		errorMessage,
		listItems,
		streamOperation
	} from '../../_lib/operations/client.js';
	import {
		operationStatusLabel,
		operationStatusTone,
		reasonLabel
	} from '../../_lib/operations/copy.js';

	/** Scan → review → prune, with live progress (docs/OPERATIONS.md §5.3). */
	let {
		canPrunePlatform,
		active,
		onsettled
	}: {
		canPrunePlatform: boolean;
		active: OperationView | null;
		onsettled: () => Promise<void> | void;
	} = $props();

	const ITEM_PAGE = 50;

	let scope = $state<PruneScope>('org');
	const available = $derived(
		pruneCategoryInfo.filter((info) => scope === 'platform' || info.scope === 'org')
	);
	const chosen = new SvelteSet<PruneCategory>(
		pruneCategoryInfo.filter((info) => info.scope === 'org').map((info) => info.id)
	);
	/** Blank means each category uses its retention policy (Settings → Retention & defaults). */
	let olderThanInput = $state<string | number>('');
	let keepTagsInput = $state<string | number>('');

	function optionalNumber(value: string | number, min: number, max: number): number | undefined {
		if (value === '') return undefined;
		const number = Number(value);
		return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
	}

	let operation = $state<OperationView | null>(untrack(() => active));
	let starting = $state(false);
	let confirmOpen = $state(false);
	let applying = $state(false);
	const include = new SvelteSet<PruneCategory>();
	let skipped = $state<OperationItemView[]>([]);
	let expanded = $state<PruneCategory | null>(null);
	let pages = $state<
		Partial<
			Record<
				PruneCategory,
				{ items: OperationItemView[]; cursor: number; hasMore: boolean; loading: boolean }
			>
		>
	>({});
	let closeStream: (() => void) | null = null;

	const stage = $derived.by(() => {
		if (!operation) return 'idle' as const;
		if (operation.status === 'queued' || operation.status === 'planning')
			return 'scanning' as const;
		if (operation.status === 'planned') return 'planned' as const;
		if (operation.status === 'applying') return 'applying' as const;
		return 'done' as const;
	});

	/** Categories this operation looked at, in run order. */
	const scanned = $derived.by(() => {
		if (!operation) return [];
		const wanted = operation.params.categories;
		return pruneCategoryInfo.filter((info) =>
			wanted?.length
				? wanted.includes(info.id)
				: operation!.scope === 'platform' || info.scope === 'org'
		);
	});
	const stats = (id: PruneCategory) =>
		operation?.summary.categories?.[id] ?? {
			planned: 0,
			bytes: 0,
			succeeded: 0,
			failed: 0,
			skipped: 0
		};
	const selectedCount = $derived(
		scanned
			.filter((info) => include.has(info.id))
			.reduce((sum, info) => sum + stats(info.id).planned, 0)
	);
	const selectedBytes = $derived(
		scanned
			.filter((info) => include.has(info.id))
			.reduce((sum, info) => sum + stats(info.id).bytes, 0)
	);
	/** While applying, show the categories that run (all with items, after a reload). */
	const running = $derived(
		scanned.filter(
			(info) => stats(info.id).planned > 0 && (include.size === 0 || include.has(info.id))
		)
	);

	function setScope(value: string) {
		if (value !== 'org' && value !== 'platform') return;
		scope = value;
		chosen.clear();
		for (const info of pruneCategoryInfo)
			if (value === 'platform' || info.scope === 'org') chosen.add(info.id);
	}

	function follow(untilDone: boolean) {
		const current = operation;
		if (!current) return;
		closeStream?.();
		closeStream = streamOperation(
			current.id,
			{
				onProgress: (next) => (operation = next),
				onDone: (next) => {
					operation = next;
					closeStream = null;
					if (next.status === 'planned') void preparePlan(next);
					else void onsettled();
				},
				onError: (message) => {
					closeStream = null;
					toast.error(message);
				}
			},
			{ untilDone, items: false }
		);
	}

	async function preparePlan(next: OperationView) {
		include.clear();
		for (const [id, entry] of Object.entries(next.summary.categories ?? {}))
			if (entry && entry.planned > 0) include.add(id as PruneCategory);
		pages = {};
		expanded = null;
		try {
			skipped = (await listItems(next.id, { verdict: 'skip', limit: ITEM_PAGE })).items;
		} catch {
			skipped = [];
		}
		void onsettled();
	}

	async function scan() {
		if (starting) return;
		starting = true;
		const picked = available.filter((info) => chosen.has(info.id)).map((info) => info.id);
		const olderThanDays = optionalNumber(olderThanInput, 1, 3650);
		const keepTags = optionalNumber(keepTagsInput, 0, 1000);
		try {
			operation = await createOperation({
				action: 'prune',
				scope,
				categories: picked.length === available.length ? undefined : picked,
				...(olderThanDays !== undefined ? { olderThanDays } : {}),
				...(keepTags !== undefined ? { keepTags } : {}),
				stage: 'plan'
			});
			skipped = [];
			follow(false);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			starting = false;
		}
	}

	async function cancel() {
		if (!operation) return;
		const wasPlanned = operation.status === 'planned';
		try {
			const next = await cancelOperation(operation.id);
			// Discarding a plan goes straight back to the scan form.
			if (wasPlanned) reset();
			else operation = next;
			void onsettled();
		} catch (error) {
			toast.error(errorMessage(error));
		}
	}

	async function apply() {
		if (!operation || applying) return;
		applying = true;
		try {
			operation = await applyOperation(operation.id, [...include]);
			confirmOpen = false;
			follow(true);
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			applying = false;
		}
	}

	function reset() {
		closeStream?.();
		closeStream = null;
		operation = null;
		include.clear();
		skipped = [];
		pages = {};
		expanded = null;
	}

	async function loadItems(category: PruneCategory, more = false) {
		if (!operation) return;
		const existing = pages[category];
		if (existing?.loading) return;
		pages[category] = {
			items: more ? (existing?.items ?? []) : [],
			cursor: more ? (existing?.cursor ?? 0) : 0,
			hasMore: false,
			loading: true
		};
		try {
			const page = await listItems(operation.id, {
				category,
				verdict: 'ok',
				limit: ITEM_PAGE,
				after: more ? existing?.cursor : undefined
			});
			pages[category] = {
				items: [...(more ? (existing?.items ?? []) : []), ...page.items],
				cursor: page.cursor,
				hasMore: page.hasMore,
				loading: false
			};
		} catch (error) {
			toast.error(errorMessage(error));
			pages[category] = { ...pages[category]!, loading: false };
		}
	}

	function toggleExpanded(category: PruneCategory) {
		expanded = expanded === category ? null : category;
		if (expanded && !pages[category]) void loadItems(category);
	}

	onMount(() => {
		const current = operation;
		if (!current || isTerminalOperation(current.status)) return;
		if (current.status === 'planned') void preparePlan(current);
		else follow(current.status === 'applying');
	});
	onDestroy(() => closeStream?.());
</script>

<Panel
	title="Prune"
	icon={SparklesIcon}
	description="Find and remove data nothing references any more: leftovers of deleted projects, unused releases, stale reservations, old registry images, stale runner registrations and old volume snapshots. You review the plan before anything is removed."
>
	{#if stage === 'idle'}
		<div class="space-y-4">
			{#if canPrunePlatform}
				<div class="flex flex-wrap items-center gap-3">
					<span class="text-sm font-medium">Scope</span>
					<ToggleGroup.Root
						type="single"
						variant="outline"
						size="sm"
						value={scope}
						onValueChange={setScope}
						class="bg-card"
						aria-label="Prune scope"
					>
						<ToggleGroup.Item value="org" class="px-3">This organisation</ToggleGroup.Item>
						<ToggleGroup.Item value="platform" class="px-3">Whole platform</ToggleGroup.Item>
					</ToggleGroup.Root>
				</div>
			{/if}
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="grid gap-1.5">
					<Label for="prune-older">Only items older than</Label>
					<div class="flex items-center gap-2">
						<Input
							id="prune-older"
							type="number"
							min={1}
							max={3650}
							placeholder="Retention default"
							bind:value={olderThanInput}
						/>
						<span class="text-sm text-muted-foreground">days</span>
					</div>
				</div>
				{#if chosen.has('registry_images')}
					<div class="grid gap-1.5">
						<Label for="prune-keep">Keep newest registry tags</Label>
						<Input
							id="prune-keep"
							type="number"
							min={0}
							max={1000}
							placeholder="Registry setting"
							bind:value={keepTagsInput}
						/>
					</div>
				{/if}
			</div>
			<p class="-mt-2 text-xs text-muted-foreground">
				Leave both blank to use the retention windows in Settings → Retention &amp; defaults. Pinned
				images and snapshots are never pruned.
			</p>
			<fieldset class="space-y-2">
				<legend class="mb-2 text-sm font-medium">What to look for</legend>
				<div class="grid gap-2 sm:grid-cols-2">
					{#each available as info (info.id)}
						<div class="flex items-start gap-2">
							<Checkbox
								id="prune-{info.id}"
								bind:checked={
									() => chosen.has(info.id),
									(value) => (value ? chosen.add(info.id) : chosen.delete(info.id))
								}
							/>
							<div class="grid gap-0.5 leading-tight">
								<Label for="prune-{info.id}" class="text-sm">{info.label}</Label>
								<p class="text-xs text-muted-foreground">{info.description}</p>
							</div>
						</div>
					{/each}
				</div>
			</fieldset>
			<div class="flex flex-wrap items-center gap-3">
				<Button onclick={scan} disabled={starting || chosen.size === 0}>
					{#if starting}<Spinner />{:else}<ScanSearchIcon />{/if}
					Scan
				</Button>
				<p class="text-xs text-muted-foreground">
					Scanning changes nothing. Anything younger than a day is left alone.
				</p>
			</div>
		</div>
	{:else if operation && stage === 'scanning'}
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm">
				<Spinner />
				<span class="font-medium">{operation.phase ?? 'Starting the scan'}</span>
			</div>
			<p class="text-sm text-muted-foreground tabular-nums">
				{operation.total}
				{operation.total === 1 ? 'item' : 'items'} found so far
			</p>
			<Button variant="outline" size="sm" onclick={cancel}>Cancel scan</Button>
		</div>
	{:else if operation && stage === 'planned'}
		<div class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
				<p>
					Found <span class="font-medium tabular-nums">{operation.total}</span>
					{operation.total === 1 ? 'item' : 'items'}{operation.scope === 'platform'
						? ' across the platform'
						: ''}.
				</p>
				{#if operation.planExpiresAt}
					<p class="text-xs text-muted-foreground">
						Plan expires {formatDateTime(operation.planExpiresAt)}
					</p>
				{/if}
			</div>

			{#if skipped.length}
				<Notice tone="warning" title="Some things could not be checked">
					<ul class="mt-1 space-y-0.5">
						{#each skipped as item (item.seq)}
							<li>{reasonLabel(item.reason)}{item.label ? ` — ${item.label}` : ''}</li>
						{/each}
					</ul>
				</Notice>
			{/if}

			<div class="overflow-hidden rounded-lg border">
				<Table.Root>
					<Table.Header class="bg-muted/45">
						<Table.Row>
							<Table.Head class="w-0 pr-0 pl-3"><span class="sr-only">Include</span></Table.Head>
							<Table.Head>Category</Table.Head>
							<Table.Head class="text-right">Items</Table.Head>
							<Table.Head class="pr-3 text-right">Size</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each scanned as info (info.id)}
							{@const entry = stats(info.id)}
							{@const page = pages[info.id]}
							<Table.Row>
								<Table.Cell class="pr-0 pl-3">
									<Checkbox
										bind:checked={
											() => include.has(info.id),
											(value) => (value ? include.add(info.id) : include.delete(info.id))
										}
										disabled={entry.planned === 0}
										aria-label="Include {info.label}"
									/>
								</Table.Cell>
								<Table.Cell>
									<div class="flex items-center gap-1.5">
										{#if entry.planned > 0}
											<button
												type="button"
												class="group inline-flex items-center gap-1 font-medium hover:underline"
												aria-expanded={expanded === info.id}
												onclick={() => toggleExpanded(info.id)}
											>
												<ChevronRightIcon
													class="size-3.5 transition-transform {expanded === info.id
														? 'rotate-90'
														: ''}"
												/>
												{info.label}
											</button>
										{:else}
											<span class="pl-5 text-muted-foreground">{info.label}</span>
										{/if}
										<Tooltip.Root>
											<Tooltip.Trigger>
												{#snippet child({ props })}
													<button
														{...props}
														type="button"
														class="text-muted-foreground hover:text-foreground"
														aria-label="About {info.label}"
													>
														<InfoIcon class="size-3.5" />
													</button>
												{/snippet}
											</Tooltip.Trigger>
											<Tooltip.Content class="max-w-xs">{info.description}</Tooltip.Content>
										</Tooltip.Root>
									</div>
								</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">
									{entry.planned}
								</Table.Cell>
								<Table.Cell class="pr-3 text-right font-mono text-xs tabular-nums">
									{entry.bytes ? formatBytes(entry.bytes) : '—'}
								</Table.Cell>
							</Table.Row>
							{#if expanded === info.id}
								<Table.Row class="hover:bg-transparent">
									<Table.Cell colspan={4} class="bg-muted/30 px-3 py-2">
										{#if page?.items.length}
											<ul class="max-h-64 space-y-1 overflow-y-auto font-mono text-xs">
												{#each page.items as item (item.seq)}
													<li class="flex justify-between gap-3">
														<span class="truncate">{item.label ?? item.targetId}</span>
														{#if item.bytes}<span class="shrink-0 text-muted-foreground"
																>{formatBytes(item.bytes)}</span
															>{/if}
													</li>
												{/each}
											</ul>
										{/if}
										{#if page?.loading}
											<p class="flex items-center gap-2 text-xs text-muted-foreground">
												<Spinner />Loading
											</p>
										{:else if page?.hasMore}
											<Button
												variant="ghost"
												size="xs"
												class="mt-1"
												onclick={() => loadItems(info.id, true)}>Show more</Button
											>
										{/if}
									</Table.Cell>
								</Table.Row>
							{/if}
						{/each}
					</Table.Body>
				</Table.Root>
			</div>

			<div class="flex flex-wrap items-center gap-2">
				<Button
					variant="destructive"
					disabled={selectedCount === 0}
					onclick={() => (confirmOpen = true)}
				>
					Prune {selectedCount}
					{selectedCount === 1 ? 'item' : 'items'}{selectedBytes
						? ` (${formatBytes(selectedBytes)})`
						: ''}
				</Button>
				<Button variant="outline" onclick={cancel}>Discard plan</Button>
				{#if operation.total === 0}
					<p class="text-sm text-muted-foreground">Nothing to prune. Everything is connected.</p>
				{/if}
			</div>
		</div>
	{:else if operation && stage === 'applying'}
		<div class="space-y-4">
			<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
				<span class="flex items-center gap-2 font-medium">
					<Spinner />Pruning · {operation.done} / {operation.total}
				</span>
				<span class="text-muted-foreground tabular-nums">
					Freed {formatBytes(operation.summary.freedBytes)}
				</span>
			</div>
			<ul class="space-y-3">
				{#each running as info (info.id)}
					{@const entry = stats(info.id)}
					{@const processed = entry.succeeded + entry.failed + entry.skipped}
					<li class="space-y-1">
						<div class="flex justify-between text-xs">
							<span>{info.label}</span>
							<span class="font-mono text-muted-foreground tabular-nums">
								{processed} / {entry.planned}{entry.failed ? ` · ${entry.failed} failed` : ''}
							</span>
						</div>
						<Progress value={processed} max={Math.max(entry.planned, 1)} aria-label={info.label} />
					</li>
				{/each}
			</ul>
			<Button variant="outline" size="sm" onclick={cancel}>Stop after the current item</Button>
		</div>
	{:else if operation}
		<div class="space-y-4">
			<div class="flex flex-wrap items-center gap-3 text-sm">
				<StatusBadge
					status={operation.status}
					label={operationStatusLabel(operation.status)}
					tone={operationStatusTone(operation.status)}
				/>
				{#if operation.done > 0 || operation.summary.freedBytes > 0}
					<span>
						Removed <span class="font-medium tabular-nums"
							>{operation.summary.statuses.succeeded}</span
						>
						{operation.summary.statuses.succeeded === 1 ? 'item' : 'items'} and freed
						<span class="font-medium">{formatBytes(operation.summary.freedBytes)}</span>.
					</span>
				{:else if operation.status === 'failed'}
					<span class="text-destructive">{operation.phase ?? 'The prune failed.'}</span>
				{:else}
					<span class="text-muted-foreground">Nothing was removed.</span>
				{/if}
			</div>
			{#if operation.done > 0}
				<div class="overflow-hidden rounded-lg border">
					<Table.Root>
						<Table.Header class="bg-muted/45">
							<Table.Row>
								<Table.Head class="pl-3">Category</Table.Head>
								<Table.Head class="text-right">Removed</Table.Head>
								<Table.Head class="text-right">Skipped</Table.Head>
								<Table.Head class="pr-3 text-right">Failed</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each scanned.filter((info) => stats(info.id).planned > 0) as info (info.id)}
								{@const entry = stats(info.id)}
								<Table.Row>
									<Table.Cell class="pl-3">{info.label}</Table.Cell>
									<Table.Cell class="text-right font-mono text-xs tabular-nums"
										>{entry.succeeded}</Table.Cell
									>
									<Table.Cell class="text-right font-mono text-xs tabular-nums"
										>{entry.skipped}</Table.Cell
									>
									<Table.Cell
										class="pr-3 text-right font-mono text-xs tabular-nums {entry.failed
											? 'text-destructive'
											: ''}">{entry.failed}</Table.Cell
									>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button
					variant="outline"
					href={resolve('/(dashboard)/settings/maintenance/operations/[id]', { id: operation.id })}
					>View details</Button
				>
				<Button onclick={reset}><ScanSearchIcon />Scan again</Button>
			</div>
		</div>
	{/if}
</Panel>

<AlertDialog.Root bind:open={confirmOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title class="text-destructive">
				Prune {selectedCount}
				{selectedCount === 1 ? 'item' : 'items'}?
			</AlertDialog.Title>
			<AlertDialog.Description>
				This removes exactly the planned items in the selected categories{selectedBytes
					? ` and frees about ${formatBytes(selectedBytes)}`
					: ''}. Each item is checked again first. It cannot be undone.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={applying}>Cancel</AlertDialog.Cancel>
			<Button variant="destructive" disabled={applying} onclick={apply}>
				{#if applying}<Spinner />{/if}
				Prune
			</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
