import type { TreeNode } from '@skiff/studio/protocol';
import { studioCall } from '../client.js';
import { describeStudioError } from './errors.js';
import { findItem, pathKey, toItem, type TreeItem } from './tree.js';

/** The session's lazily loaded object tree (plan 22). One per open session. */
export class StudioTree {
	roots = $state<TreeItem[] | null>(null);
	loading = $state(false);
	error = $state<string | null>(null);
	/** Whether the error means the session is gone. */
	sessionGone = $state(false);

	constructor(private readonly database: string) {}

	async load(): Promise<void> {
		this.loading = true;
		this.error = null;
		this.sessionGone = false;
		try {
			const result = await studioCall(this.database, 'tree', { path: [] });
			this.roots = result.nodes.map(toItem);
		} catch (caught) {
			const info = describeStudioError(caught);
			this.error = info.message;
			this.sessionGone = info.reopen;
		} finally {
			this.loading = false;
		}
	}

	/** Refresh: reload the roots, then the children of every branch that was open. */
	async refresh(): Promise<void> {
		const open = new Set<string>();
		const collect = (items: TreeItem[] | null) => {
			for (const item of items ?? []) {
				if (item.expanded) open.add(pathKey(item.node.path));
				collect(item.children);
			}
		};
		collect(this.roots);
		await this.load();
		const reopen = async (items: TreeItem[] | null) => {
			for (const item of items ?? []) {
				if (open.has(pathKey(item.node.path))) {
					await this.setExpanded(item, true);
					await reopen(item.children);
				}
			}
		};
		await reopen(this.roots);
	}

	async toggle(item: TreeItem): Promise<void> {
		await this.setExpanded(item, !item.expanded);
	}

	async setExpanded(item: TreeItem, expanded: boolean): Promise<void> {
		if (!item.node.hasChildren) return;
		item.expanded = expanded;
		if (!expanded || item.children !== null || item.loading) return;
		item.loading = true;
		item.error = null;
		try {
			const result = await studioCall(this.database, 'tree', { path: item.node.path });
			item.children = result.nodes.map(toItem);
		} catch (caught) {
			item.error = describeStudioError(caught).message;
			item.expanded = false;
		} finally {
			item.loading = false;
		}
	}

	/**
	 * Find the node at `path`, loading and expanding its ancestors on the way (foreign-key links
	 * and restored tabs). Null when it isn't in the tree.
	 */
	async reveal(path: readonly string[]): Promise<TreeNode | null> {
		if (this.roots === null && !this.loading) await this.load();
		for (let depth = 1; depth < path.length; depth += 1) {
			const ancestor = findItem(this.roots, path.slice(0, depth));
			if (!ancestor) break;
			await this.setExpanded(ancestor, true);
		}
		return findItem(this.roots, path)?.node ?? null;
	}
}
