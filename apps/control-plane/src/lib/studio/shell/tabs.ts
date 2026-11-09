import { treeNodeSchema, type TreeNode } from '@yoal/studio/protocol';
import { pathKey } from './tree.js';

/** The studio's tab strip state (plan 22): object and query tabs, kept per database. Pure. */
export type StudioTab =
	| { id: string; type: 'object'; node: TreeNode }
	| { id: string; type: 'query'; title: string; input: string };

export interface TabsState {
	tabs: StudioTab[];
	active: string | null;
	/** Next query tab number. */
	seq: number;
}

export const emptyTabs = (): TabsState => ({ tabs: [], active: null, seq: 1 });

/** DOM ids for a tab and its panel. */
export const tabDomId = (id: string): string => `studio-tab-${encodeURIComponent(id).replace(/%/g, '_')}`;
export const tabPanelDomId = (id: string): string => `studio-panel-${encodeURIComponent(id).replace(/%/g, '_')}`;

export const objectTabId = (path: readonly string[]): string => `o:${pathKey(path)}`;

/** Open `node`'s tab, or focus it when it is already open. */
export function openObjectTab(state: TabsState, node: TreeNode): TabsState {
	const id = objectTabId(node.path);
	if (state.tabs.some((tab) => tab.id === id)) return { ...state, active: id };
	return { ...state, tabs: [...state.tabs, { id, type: 'object', node }], active: id };
}

export function openQueryTab(state: TabsState, input = ''): TabsState {
	const id = `q:${state.seq}`;
	const tab: StudioTab = { id, type: 'query', title: `Query ${state.seq}`, input };
	return { tabs: [...state.tabs, tab], active: id, seq: state.seq + 1 };
}

/** Close a tab; the active one hands focus to its right neighbour, else its left. */
export function closeTab(state: TabsState, id: string): TabsState {
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index < 0) return state;
	const tabs = state.tabs.filter((tab) => tab.id !== id);
	let active = state.active;
	if (active === id) active = (tabs[index] ?? tabs[index - 1])?.id ?? null;
	return { ...state, tabs, active };
}

/** A renamed object keeps its tab (and its place), under the new path. */
export function renameObjectTab(state: TabsState, from: readonly string[], node: TreeNode): TabsState {
	const oldId = objectTabId(from);
	const newId = objectTabId(node.path);
	if (!state.tabs.some((tab) => tab.id === oldId)) return state;
	// A tab already open at the new path would be a duplicate: keep the renamed one.
	const tabs = state.tabs
		.filter((tab) => tab.id !== newId || newId === oldId)
		.map((tab): StudioTab => (tab.id === oldId ? { id: newId, type: 'object', node } : tab));
	return { ...state, tabs, active: state.active === oldId || state.active === newId ? newId : state.active };
}

/** Close the tabs of a dropped object and of anything inside it (a dropped schema). */
export function closeObjectTabs(state: TabsState, path: readonly string[]): TabsState {
	let next = state;
	for (const tab of state.tabs) {
		if (tab.type !== 'object') continue;
		const inside = path.length <= tab.node.path.length && path.every((part, index) => tab.node.path[index] === part);
		if (inside) next = closeTab(next, tab.id);
	}
	return next;
}

export function focusTab(state: TabsState, id: string): TabsState {
	return state.tabs.some((tab) => tab.id === id) ? { ...state, active: id } : state;
}

type TabStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const tabsStorageKey = (database: string): string => `yoal:studio:tabs:${database}`;

/** Restore a database's tabs; anything unreadable or malformed starts empty. */
export function loadTabs(storage: TabStorage | undefined, database: string): TabsState {
	try {
		const raw = storage?.getItem(tabsStorageKey(database));
		if (!raw) return emptyTabs();
		const parsed = JSON.parse(raw) as Partial<TabsState>;
		const tabs: StudioTab[] = [];
		for (const tab of Array.isArray(parsed.tabs) ? parsed.tabs : []) {
			if (tab?.type === 'object') {
				const node = treeNodeSchema.safeParse(tab.node);
				if (node.success) tabs.push({ id: objectTabId(node.data.path), type: 'object', node: node.data });
			} else if (tab?.type === 'query' && typeof tab.id === 'string') {
				tabs.push({
					id: tab.id,
					type: 'query',
					title: typeof tab.title === 'string' ? tab.title : 'Query',
					input: typeof tab.input === 'string' ? tab.input : ''
				});
			}
		}
		const active = tabs.some((tab) => tab.id === parsed.active) ? (parsed.active as string) : (tabs[0]?.id ?? null);
		const seq = typeof parsed.seq === 'number' && parsed.seq > 0 ? Math.floor(parsed.seq) : tabs.length + 1;
		return { tabs, active, seq };
	} catch {
		return emptyTabs();
	}
}

export function saveTabs(storage: TabStorage | undefined, database: string, state: TabsState): void {
	try {
		storage?.setItem(tabsStorageKey(database), JSON.stringify(state));
	} catch {
		// Private mode or a full quota: tabs just aren't remembered.
	}
}
