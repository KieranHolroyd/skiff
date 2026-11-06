<script lang="ts">
	import { toast } from 'svelte-sonner';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import type { StudioInfo, TreeNode } from '@skiff/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { getStudioShell } from '../shell/context.js';
	import { canAlter, kindLabel, renamedNode } from './changes.js';
	import NameDialog from './NameDialog.svelte';
	import { affectedText, AlterReview } from './review.svelte.js';
	import ReviewDialog from './ReviewDialog.svelte';

	/**
	 * Rename, truncate (empty) and drop for the open table, view or collection. Each goes through
	 * the review dialog; afterwards the shell refreshes the tree and moves or closes the tab.
	 */
	let {
		database,
		info,
		object,
		/** Rows are "rows" or "documents" in messages. */
		unit = 'row',
		ontruncated
	}: {
		database: string;
		info: StudioInfo;
		object: TreeNode;
		unit?: string;
		/** The data was emptied; reload what is on screen. */
		ontruncated?: () => void;
	} = $props();

	const shell = getStudioShell();
	const review = new AlterReview(() => database);
	const kind = $derived(kindLabel(object.kind));
	const ref = $derived({ path: object.path, kind: object.kind });
	const canRename = $derived(canAlter(info, 'rename'));
	const canTruncate = $derived(
		canAlter(info, 'truncate') && (object.kind === 'table' || object.kind === 'collection')
	);
	const canDrop = $derived(canAlter(info, 'drop'));
	let renaming = $state(false);

	async function rename(name: string) {
		const from = object.path;
		const done = await review.start({
			title: `Rename ${kind} ${object.name}`,
			description: `Queries, views or code that use the old name will stop working.`,
			changes: [{ op: 'rename', object: ref, name }],
			confirmLabel: 'Rename'
		});
		if (!done) return;
		toast.success(`Renamed ${object.name} to ${name}.`);
		shell?.structureChanged({ kind: 'renamed', from, to: renamedNode(object, name) });
	}

	async function truncate() {
		const done = await review.start({
			title: `Empty ${kind} ${object.name}`,
			description: `Every ${unit} is deleted; the ${kind} and its structure stay.`,
			changes: [{ op: 'truncate', object: ref }],
			confirmLabel: `Delete every ${unit}`
		});
		if (!done) return;
		toast.success(`Emptied ${object.name}${affectedText(done, unit)}.`);
		ontruncated?.();
		shell?.structureChanged({ kind: 'changed' });
	}

	async function drop() {
		const path = object.path;
		const done = await review.start({
			title: `Drop ${kind} ${object.name}`,
			description: `The ${kind} and everything in it is deleted for good.`,
			changes: [{ op: 'drop', object: ref, cascade: false }],
			confirmLabel: `Drop ${kind}`
		});
		if (!done) return;
		toast.success(`Dropped ${object.name}.`);
		shell?.structureChanged({ kind: 'dropped', path });
	}
</script>

{#if canRename || canTruncate || canDrop}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} size="xs" variant="ghost" aria-label="{kind} actions" title="{kind} actions">
					<EllipsisIcon />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			{#if canRename}
				<DropdownMenu.Item onSelect={() => (renaming = true)}><PencilIcon />Rename {kind}…</DropdownMenu.Item>
			{/if}
			{#if canTruncate || canDrop}
				{#if canRename}<DropdownMenu.Separator />{/if}
				{#if canTruncate}
					<DropdownMenu.Item onSelect={() => void truncate()}><EraserIcon />Empty {kind}…</DropdownMenu.Item>
				{/if}
				{#if canDrop}
					<DropdownMenu.Item variant="destructive" onSelect={() => void drop()}><Trash2Icon />Drop {kind}…</DropdownMenu.Item>
				{/if}
			{/if}
		</DropdownMenu.Content>
	</DropdownMenu.Root>

	<NameDialog
		bind:open={renaming}
		title="Rename {kind} {object.name}"
		label="New name"
		initial={object.name}
		submitLabel="Review"
		onsubmit={(name) => void rename(name)}
	/>
	<ReviewDialog {review} />
{/if}
