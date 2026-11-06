<script lang="ts">
	import { tick, type Component, type Snippet } from 'svelte';
	import BracesIcon from '@lucide/svelte/icons/braces';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import Link2Icon from '@lucide/svelte/icons/link-2';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TableIcon from '@lucide/svelte/icons/table';
	import TablePropertiesIcon from '@lucide/svelte/icons/table-properties';
	import type { TreeNode, TreeNodeKind } from '@skiff/studio/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { StudioTree } from './tree.svelte.js';
	import { formatBytes, formatCount, visibleItems, type VisibleItem } from './tree.js';

	/**
	 * The session's object tree (plan 22): lazy children, a filter over loaded nodes, and the
	 * WAI-ARIA tree keyboard model (arrows, Home/End, Enter opens).
	 */
	let {
		tree,
		label,
		activePath = null,
		onopen,
		onreopen,
		actions,
		filterInput = $bindable(null)
	}: {
		tree: StudioTree;
		label: string;
		/** Path key of the focused tab's object, highlighted in the tree. */
		activePath?: string | null;
		onopen: (node: TreeNode) => void;
		onreopen?: () => void;
		/** Extra header buttons beside Refresh (e.g. "New table"). */
		actions?: Snippet;
		filterInput?: HTMLInputElement | null;
	} = $props();

	const icons: Record<TreeNodeKind, Component<{ class?: string }>> = {
		database: DatabaseIcon,
		schema: LayersIcon,
		table: TableIcon,
		view: EyeIcon,
		'materialized-view': TablePropertiesIcon,
		'foreign-table': Link2Icon,
		collection: BracesIcon,
		keyspace: DatabaseIcon,
		'key-group': FolderIcon,
		key: KeyRoundIcon,
		folder: FolderIcon
	};

	let filter = $state('');
	let focusedKey = $state<string | null>(null);
	let list = $state<HTMLUListElement | null>(null);

	const rows = $derived(tree.roots ? visibleItems(tree.roots, filter) : []);
	const tabStop = $derived(
		rows.find((row) => row.key === focusedKey)?.key ??
			rows.find((row) => row.key === activePath)?.key ??
			rows[0]?.key ??
			null
	);

	const domId = (key: string) => `studio-tree-${encodeURIComponent(key).replace(/%/g, '_')}`;

	async function focusRow(key: string | undefined) {
		if (!key) return;
		focusedKey = key;
		await tick();
		list?.querySelector<HTMLElement>(`#${CSS.escape(domId(key))}`)?.focus();
	}

	function activate(row: VisibleItem) {
		focusedKey = row.key;
		if (row.item.node.browsable) onopen(row.item.node);
		else if (row.item.node.hasChildren) void tree.toggle(row.item);
	}

	function keydown(event: KeyboardEvent, row: VisibleItem, index: number) {
		const node = row.item.node;
		switch (event.key) {
			case 'ArrowDown':
				event.preventDefault();
				void focusRow(rows[index + 1]?.key);
				break;
			case 'ArrowUp':
				event.preventDefault();
				void focusRow(rows[index - 1]?.key);
				break;
			case 'Home':
				event.preventDefault();
				void focusRow(rows[0]?.key);
				break;
			case 'End':
				event.preventDefault();
				void focusRow(rows.at(-1)?.key);
				break;
			case 'ArrowRight':
				event.preventDefault();
				if (!node.hasChildren) break;
				if (!row.open) void tree.setExpanded(row.item, true);
				else void focusRow(rows[index + 1]?.key);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				if (row.open && row.item.expanded) void tree.setExpanded(row.item, false);
				else if (row.parent) void focusRow(row.parent);
				break;
			case 'Enter':
			case ' ':
				event.preventDefault();
				activate(row);
				break;
		}
	}

	function filterKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			void focusRow(rows[0]?.key);
		} else if (event.key === 'Escape' && filter) {
			event.preventDefault();
			filter = '';
		} else if (event.key === 'Enter') {
			const first = rows.find((row) => row.item.node.browsable);
			if (first) {
				event.preventDefault();
				activate(first);
			}
		}
	}

	function detail(node: TreeNode): string | null {
		const parts: string[] = [];
		if (node.detail?.rows !== undefined) parts.push(formatCount(node.detail.rows));
		if (node.detail?.bytes !== undefined) parts.push(formatBytes(node.detail.bytes));
		return parts.length > 0 ? parts.join(' · ') : null;
	}

	function title(node: TreeNode): string {
		const parts = [node.path.join('.'), node.detail?.type ?? node.kind];
		if (node.detail?.rows !== undefined) parts.push(`~${node.detail.rows.toLocaleString('en-GB')} rows`);
		if (node.detail?.bytes !== undefined) parts.push(formatBytes(node.detail.bytes));
		return parts.join(' · ');
	}
</script>

<nav class="flex h-full min-h-0 flex-col" aria-label={label}>
	<div class="flex items-center gap-1 border-b p-2">
		<div class="relative min-w-0 flex-1">
			<SearchIcon
				class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
			/>
			<input
				bind:this={filterInput}
				bind:value={filter}
				onkeydown={filterKeydown}
				type="search"
				aria-label="Filter objects"
				placeholder="Filter"
				autocomplete="off"
				spellcheck={false}
				class="h-7 w-full min-w-0 rounded-md border border-input bg-transparent pr-10 pl-7 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
			/>
			<Kbd class="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[0.625rem]"
				>⌘K</Kbd
			>
		</div>
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Refresh objects"
			title="Refresh objects"
			disabled={tree.loading}
			onclick={() => void tree.refresh()}
		>
			<RefreshCwIcon class={tree.loading ? 'animate-spin' : ''} />
		</Button>
		{@render actions?.()}
	</div>

	<div class="min-h-0 flex-1 overflow-auto p-1 text-sm">
		{#if tree.loading && !tree.roots}
			<div class="flex items-center gap-2 p-2 text-xs text-muted-foreground" role="status">
				<Spinner class="size-3.5" />Loading objects…
			</div>
		{:else if tree.error}
			<div class="space-y-2 p-2" role="alert">
				<p class="text-xs text-destructive">{tree.error}</p>
				{#if tree.sessionGone && onreopen}
					<Button size="xs" variant="outline" onclick={onreopen}>Open again</Button>
				{:else}
					<Button size="xs" variant="outline" onclick={() => void tree.load()}>Try again</Button>
				{/if}
			</div>
		{:else if tree.roots && tree.roots.length === 0}
			<p class="p-2 text-xs text-muted-foreground">No objects yet.</p>
		{:else if tree.roots && rows.length === 0}
			<p class="p-2 text-xs text-muted-foreground">
				Nothing loaded matches “{filter}”. Expand a branch to search inside it.
			</p>
		{:else if tree.roots}
			<ul bind:this={list} role="tree" aria-label={label} class="space-y-px">
				{#each rows as row, index (row.key)}
					{@const node = row.item.node}
					{@const Icon = icons[node.kind] ?? FolderIcon}
					{@const info = detail(node)}
					<li
						id={domId(row.key)}
						role="treeitem"
						aria-level={row.level}
						aria-posinset={row.posinset}
						aria-setsize={row.setsize}
						aria-expanded={node.hasChildren ? row.open : undefined}
						aria-selected={activePath === row.key}
						aria-busy={row.item.loading || undefined}
						tabindex={tabStop === row.key ? 0 : -1}
						title={title(node)}
						class="flex cursor-default items-center gap-1 rounded px-1.5 py-1 outline-none select-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring {activePath ===
						row.key
							? 'bg-muted font-medium'
							: ''}"
						style="padding-left: {0.375 + (row.level - 1) * 0.875}rem"
						onclick={() => activate(row)}
						onkeydown={(event) => keydown(event, row, index)}
						onfocus={() => (focusedKey = row.key)}
					>
						{#if node.hasChildren}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<span
								role="presentation"
								class="-m-0.5 rounded p-0.5 hover:bg-background"
								onclick={(event) => {
									event.stopPropagation();
									void tree.toggle(row.item);
								}}
							>
								<ChevronRightIcon
									class="size-3.5 shrink-0 text-muted-foreground transition-transform {row.open
										? 'rotate-90'
										: ''}"
								/>
							</span>
						{:else}
							<span class="size-3.5 shrink-0"></span>
						{/if}
						<Icon class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="truncate">{node.name}</span>
						{#if row.item.loading}
							<Spinner class="ml-auto size-3 shrink-0" />
						{:else if info}
							<span
								class="ml-auto shrink-0 pl-2 font-mono text-[0.625rem] text-muted-foreground tabular-nums"
								>{info}</span
							>
						{/if}
					</li>
					{#if row.item.error}
						<li role="none" class="px-2 text-xs text-destructive">{row.item.error}</li>
					{/if}
				{/each}
			</ul>
		{/if}
	</div>
</nav>
