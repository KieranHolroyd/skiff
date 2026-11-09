<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import ListIcon from '@lucide/svelte/icons/list';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import type { Cell, RowChange } from '@yoal/studio/protocol';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import StudioErrorNotice from '../shell/StudioErrorNotice.svelte';
	import { cellView } from './cells.js';
	import { targetId, type BuildOutput } from './pending.js';

	/** "3 changes · Review · Apply · Discard" under the grid, and the review dialog (plan 22). */
	let {
		count,
		built,
		conflicts,
		applying,
		applyError,
		partial,
		onapply,
		ondiscard
	}: {
		count: number;
		/** The batch as it would be sent; built lazily by the grid. */
		built: () => BuildOutput;
		/** Target id → reason, from the last apply. */
		conflicts: Record<string, string>;
		applying: boolean;
		applyError: unknown;
		/** Rows the last apply did write before a conflict stopped it (MongoDB). */
		partial: number;
		onapply: () => void;
		ondiscard: () => void;
	} = $props();

	let reviewOpen = $state(false);
	let review = $state.raw<BuildOutput | null>(null);
	const conflictCount = $derived(Object.keys(conflicts).length);

	function openReview() {
		review = built();
		reviewOpen = true;
	}

	function text(cell: Cell): string {
		const view = cellView(cell);
		if (view.kind === 'null') return 'NULL';
		return view.text.length > 80 ? `${view.text.slice(0, 80)}…` : view.text;
	}

	function keyText(key: Record<string, Cell>): string {
		return Object.entries(key)
			.map(([name, cell]) => `${name} = ${text(cell)}`)
			.join(', ');
	}

	const opLabel: Record<RowChange['op'], string> = { insert: 'Insert', update: 'Update', delete: 'Delete' };
	const opVariant = { insert: 'success', update: 'warning', delete: 'danger' } as const;
</script>

<div class="space-y-2">
	{#if applyError}
		<StudioErrorNotice error={applyError} />
	{/if}
	{#if conflictCount > 0}
		<p class="text-xs text-destructive" role="alert">
			{conflictCount}
			{conflictCount === 1 ? 'row was' : 'rows were'} changed or removed by someone else since you
			loaded {conflictCount === 1 ? 'it' : 'them'}.
			{partial > 0
				? `${partial} other ${partial === 1 ? 'change was' : 'changes were'} applied; reload to see the current rows.`
				: 'Nothing was applied.'} Conflicting rows are marked.
		</p>
	{/if}
	<div
		class="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs"
		role="region"
		aria-label="Pending changes"
	>
		<span class="font-medium" aria-live="polite">
			{count}
			{count === 1 ? 'change' : 'changes'}
		</span>
		<div class="ml-auto flex items-center gap-1.5">
			<Button size="xs" variant="ghost" onclick={openReview}><ListIcon />Review</Button>
			<Button size="xs" disabled={applying} onclick={onapply}>
				{#if applying}<Spinner class="size-3" />{:else}<CheckIcon />{/if}Apply
			</Button>
			<Button size="xs" variant="ghost" disabled={applying} onclick={ondiscard}><Undo2Icon />Discard</Button>
		</div>
	</div>
</div>

<Dialog.Root bind:open={reviewOpen}>
	<Dialog.Content class="max-h-[80vh] overflow-hidden sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Review {count} {count === 1 ? 'change' : 'changes'}</Dialog.Title>
			<Dialog.Description>
				Changes apply together in one transaction where the engine supports it. A row changed by
				someone else since you loaded it is a conflict, and nothing is written.
			</Dialog.Description>
		</Dialog.Header>
		{#if review}
			{#if review.problems.length > 0}
				<ul class="space-y-1 text-xs text-destructive" role="alert">
					{#each review.problems as problem, index (index)}<li>{problem}</li>{/each}
				</ul>
			{/if}
			<ol class="max-h-[50vh] space-y-2 overflow-auto text-xs" aria-label="Changes">
				{#each review.changes as change, index (index)}
					{@const target = review.targets[index]}
					{@const conflict = target ? conflicts[targetId(target)] : undefined}
					<li class="rounded-md border p-2 {conflict ? 'border-destructive/60 bg-destructive/5' : ''}">
						<div class="flex flex-wrap items-center gap-2">
							<Badge variant={opVariant[change.op]}>{opLabel[change.op]}</Badge>
							{#if change.op !== 'insert'}
								<span class="font-mono text-muted-foreground">{keyText(change.key)}</span>
							{:else}
								<span class="text-muted-foreground">new row</span>
							{/if}
						</div>
						{#if change.op === 'update'}
							<dl class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
								{#each Object.entries(change.values) as [name, value] (name)}
									<dt class="text-muted-foreground">{name}</dt>
									<dd class="truncate">
										<span class="text-muted-foreground line-through">{text(change.original[name] ?? null)}</span>
										→ <span>{text(value)}</span>
									</dd>
								{/each}
							</dl>
						{:else if change.op === 'insert'}
							<dl class="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
								{#each Object.entries(change.values) as [name, value] (name)}
									<dt class="text-muted-foreground">{name}</dt>
									<dd class="truncate">{text(value)}</dd>
								{:else}
									<dd class="col-span-2 text-muted-foreground">All columns take their defaults.</dd>
								{/each}
							</dl>
						{/if}
						{#if conflict}
							<p class="mt-1 text-destructive">Conflict: {conflict}</p>
						{/if}
					</li>
				{/each}
			</ol>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (reviewOpen = false)}>Close</Button>
			<Button
				disabled={applying || (review?.problems.length ?? 0) > 0}
				onclick={() => {
					reviewOpen = false;
					onapply();
				}}><CheckIcon />Apply</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
