<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import MinusCircleIcon from '@lucide/svelte/icons/circle-minus';
	import PinIcon from '@lucide/svelte/icons/pin';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import type { SelfUpdateStatus } from '@skiff/contracts';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatDateTime, formatRelative, plural } from '../../_lib/format.js';
	import { formatElapsed, methodOption, outcomes, toneTile } from './update-ui.js';

	interface Snapshot {
		dir: string;
		createdAt: string;
		pinned: boolean;
		/** The version the snapshot was taken for; null for a manual snapshot. */
		targetVersion: string | null;
		hasControlDb: boolean;
	}

	/** The last finished run and the rollback points the updater keeps on disk. */
	let {
		lastRun,
		snapshots
	}: {
		lastRun: SelfUpdateStatus | null;
		snapshots: Snapshot[];
	} = $props();

	const outcome = $derived(lastRun?.outcome ? outcomes[lastRun.outcome] : null);
	const OutcomeIcon = $derived(
		outcome?.tone === 'success'
			? CircleCheckIcon
			: outcome?.tone === 'danger'
				? CircleXIcon
				: lastRun?.outcome === 'rolled-back'
					? RotateCcwIcon
					: MinusCircleIcon
	);
	const finishedAt = $derived(lastRun ? (lastRun.finishedAt ?? lastRun.updatedAt) : null);
	const took = $derived(
		lastRun && finishedAt ? Date.parse(finishedAt) - Date.parse(lastRun.startedAt) : NaN
	);
	const visible = $derived(snapshots.slice(0, 4));
	const rollbackCommand = 'sudo skiff-update-self rollback';
</script>

<Panel title="History" icon={ClockIcon}>
	<div class="space-y-5">
		{#if lastRun && outcome}
			<div class="flex items-start gap-3.5">
				<span
					class="flex size-9 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset {toneTile[
						outcome.tone
					]}"
					aria-hidden="true"
				>
					<OutcomeIcon class="size-4" />
				</span>
				<div class="min-w-0 flex-1 space-y-1.5">
					<div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<p class="text-sm font-medium">Last update</p>
						<StatusBadge
							status={lastRun.outcome ?? 'done'}
							label={outcome.label}
							tone={outcome.tone}
						/>
						{#if lastRun.fromVersion && lastRun.toVersion && lastRun.fromVersion !== lastRun.toVersion}
							<span
								class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground tabular-nums"
							>
								v{lastRun.fromVersion}
								<ArrowRightIcon class="size-3" aria-label="to" />
								v{lastRun.toVersion}
							</span>
						{/if}
					</div>
					<p class="text-sm text-pretty">{lastRun.message}</p>
					<p class="text-xs text-muted-foreground">
						<span title={formatDateTime(finishedAt)}>Finished {formatRelative(finishedAt)}</span>
						{#if Number.isFinite(took) && took > 0}· took {formatElapsed(took)}{/if}
						· {lastRun.trigger === 'dashboard' ? 'from the dashboard' : 'from the command line'}
						· {methodOption(lastRun.method).short}
					</p>
				</div>
			</div>
		{/if}

		<div class={lastRun && outcome ? 'border-t pt-4' : ''}>
			<div class="mb-2 flex items-center justify-between gap-3">
				<p class="text-xs font-medium text-muted-foreground">
					Rollback points
					{#if snapshots.length > 0}
						<span class="ml-1 tabular-nums">{snapshots.length}</span>
					{/if}
				</p>
			</div>
			{#if snapshots.length === 0}
				<p class="text-sm text-muted-foreground">
					None yet. The updater snapshots the control database before every update.
				</p>
			{:else}
				<ul class="divide-y rounded-lg border">
					{#each visible as snapshot, index (snapshot.dir)}
						<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
							<ArchiveIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="font-medium">
								{#if snapshot.targetVersion}
									Before <span class="font-mono tabular-nums">v{snapshot.targetVersion}</span>
								{:else}
									Manual snapshot
								{/if}
							</span>
							{#if index === 0}
								<span
									class="rounded-full bg-muted px-1.5 py-px text-[0.65rem] font-medium text-muted-foreground"
									>Newest</span
								>
							{/if}
							<span class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
								{#if snapshot.hasControlDb}
									<span
										class="inline-flex items-center gap-1"
										title="Includes the control database"
									>
										<DatabaseIcon class="size-3" aria-hidden="true" />
										<span class="hidden sm:inline">Control DB</span>
									</span>
								{/if}
								{#if snapshot.pinned}
									<span class="inline-flex items-center gap-1" title="Pinned: never pruned">
										<PinIcon class="size-3" aria-hidden="true" />
										<span class="hidden sm:inline">Pinned</span>
									</span>
								{/if}
								<span title={formatDateTime(snapshot.createdAt)}
									>{formatRelative(snapshot.createdAt)}</span
								>
							</span>
						</li>
					{/each}
				</ul>
				{#if snapshots.length > visible.length}
					<p class="mt-2 text-xs text-muted-foreground">
						and {snapshots.length - visible.length} older
						{plural(snapshots.length - visible.length, 'point')} on the server
					</p>
				{/if}
			{/if}
		</div>
	</div>

	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<span class="text-pretty">
				Skiff rolls back on its own if health checks fail. To go back by hand, run on the server:
			</span>
			<span class="flex items-center gap-1.5">
				<code
					class="rounded-md border bg-background px-2 py-1 font-mono text-[0.7rem] text-foreground"
					>{rollbackCommand}</code
				>
				<CopyButton
					value={rollbackCommand}
					label="Copy command"
					iconOnly
					size="icon-xs"
					variant="ghost"
				/>
			</span>
		</div>
	{/snippet}
</Panel>
