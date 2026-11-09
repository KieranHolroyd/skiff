import type { TreeNode } from '@yoal/studio/protocol';

/** The studio's lazy object tree (plan 22): items, flattening, filtering. Pure. */
export interface TreeItem {
	node: TreeNode;
	expanded: boolean;
	loading: boolean;
	error: string | null;
	/** `null` until the children are fetched. */
	children: TreeItem[] | null;
}

/** One row of the rendered tree, in display order. */
export interface VisibleItem {
	item: TreeItem;
	key: string;
	level: number;
	parent: string | null;
	posinset: number;
	setsize: number;
	/** Shown open: expanded, or forced open because a descendant matches the filter. */
	open: boolean;
}

export const pathKey = (path: readonly string[]): string => JSON.stringify(path);

export function toItem(node: TreeNode): TreeItem {
	return { node, expanded: false, loading: false, error: null, children: null };
}

function matches(item: TreeItem, needle: string): boolean {
	return item.node.name.toLowerCase().includes(needle);
}

function containsMatch(item: TreeItem, needle: string): boolean {
	return (item.children ?? []).some((child) => matches(child, needle) || containsMatch(child, needle));
}

/**
 * The rows to render. Without a filter: every expanded branch. With one: loaded nodes whose name
 * contains it (case-insensitive) plus their ancestors, which open to show them.
 */
export function visibleItems(roots: readonly TreeItem[], filter = ''): VisibleItem[] {
	const needle = filter.trim().toLowerCase();
	const out: VisibleItem[] = [];
	const walk = (items: readonly TreeItem[], level: number, parent: string | null) => {
		const shown = needle
			? items.filter((item) => matches(item, needle) || containsMatch(item, needle))
			: items;
		shown.forEach((item, index) => {
			const key = pathKey(item.node.path);
			const forced = needle !== '' && containsMatch(item, needle);
			const open = (item.expanded || forced) && item.children !== null;
			out.push({ item, key, level, parent, posinset: index + 1, setsize: shown.length, open });
			if (open) walk(item.children!, level + 1, key);
		});
	};
	walk(roots, 1, null);
	return out;
}

/** The loaded item at `path`, if any. */
export function findItem(roots: readonly TreeItem[] | null, path: readonly string[]): TreeItem | null {
	let level: readonly TreeItem[] | null = roots;
	let found: TreeItem | null = null;
	for (let depth = 1; depth <= path.length; depth += 1) {
		const key = pathKey(path.slice(0, depth));
		found = level?.find((item) => pathKey(item.node.path) === key) ?? null;
		if (!found) {
			// Some engines nest without the path growing one segment per level; search deeper.
			return searchAll(roots ?? [], pathKey(path));
		}
		level = found.children;
	}
	return found;
}

function searchAll(items: readonly TreeItem[], key: string): TreeItem | null {
	for (const item of items) {
		if (pathKey(item.node.path) === key) return item;
		const inner = searchAll(item.children ?? [], key);
		if (inner) return inner;
	}
	return null;
}

/** "1.2 MB"-style size for tree details. */
export function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "12.3k"-style row counts for tree details. */
export function formatCount(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}
