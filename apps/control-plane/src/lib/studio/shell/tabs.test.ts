import { describe, expect, test } from 'bun:test';
import type { TreeNode } from '@skiff/studio/protocol';
import {
	closeObjectTabs,
	closeTab,
	renameObjectTab,
	emptyTabs,
	loadTabs,
	openObjectTab,
	openQueryTab,
	saveTabs,
	tabsStorageKey
} from './tabs.ts';

const users: TreeNode = { path: ['public', 'users'], name: 'users', kind: 'table', hasChildren: false, browsable: true };
const orders: TreeNode = { ...users, path: ['public', 'orders'], name: 'orders' };

function memory() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value)
	};
}

describe('tabs', () => {
	test('opening an object twice focuses its tab', () => {
		let state = openObjectTab(emptyTabs(), users);
		state = openQueryTab(state, 'SELECT 1');
		expect(state.active).toBe('q:1');
		state = openObjectTab(state, users);
		expect(state.tabs).toHaveLength(2);
		expect(state.active).toBe('o:["public","users"]');
	});

	test('closing the active tab focuses the right neighbour, else the left', () => {
		let state = openObjectTab(emptyTabs(), users);
		state = openObjectTab(state, orders);
		state = openQueryTab(state);
		state = closeTab({ ...state, active: 'o:["public","orders"]' }, 'o:["public","orders"]');
		expect(state.active).toBe('q:1');
		state = closeTab(state, 'q:1');
		expect(state.active).toBe('o:["public","users"]');
		state = closeTab(state, 'o:["public","users"]');
		expect(state).toEqual({ tabs: [], active: null, seq: 2 });
	});

	test('round-trips through storage per database', () => {
		const storage = memory();
		const state = openQueryTab(openObjectTab(emptyTabs(), users), 'SELECT 1');
		saveTabs(storage, 'app', state);
		expect(loadTabs(storage, 'app')).toEqual(state);
		expect(loadTabs(storage, 'other')).toEqual(emptyTabs());
	});

	test('survives broken or hostile storage', () => {
		const storage = memory();
		storage.map.set(tabsStorageKey('app'), '{not json');
		expect(loadTabs(storage, 'app')).toEqual(emptyTabs());
		storage.map.set(tabsStorageKey('app'), JSON.stringify({ tabs: [{ type: 'object', node: { bad: 1 } }, null], active: 'x' }));
		expect(loadTabs(storage, 'app')).toEqual({ tabs: [], active: null, seq: 1 });
		const throwing = {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('quota');
			}
		};
		expect(loadTabs(throwing, 'app')).toEqual(emptyTabs());
		expect(() => saveTabs(throwing, 'app', emptyTabs())).not.toThrow();
		expect(loadTabs(undefined, 'app')).toEqual(emptyTabs());
	});
});

describe('structure edits', () => {
	test('a renamed object keeps its tab, place and focus', () => {
		let state = openObjectTab(emptyTabs(), users);
		state = openObjectTab(state, orders);
		state = openQueryTab(state);
		state = { ...state, active: 'o:["public","users"]' };
		const renamed = { ...users, path: ['public', 'people'], name: 'people' };
		state = renameObjectTab(state, users.path, renamed);
		expect(state.tabs.map((tab) => tab.id)).toEqual(['o:["public","people"]', 'o:["public","orders"]', 'q:1']);
		expect(state.active).toBe('o:["public","people"]');
	});
	test('renaming an object without a tab changes nothing', () => {
		const state = openObjectTab(emptyTabs(), orders);
		expect(renameObjectTab(state, users.path, users)).toBe(state);
	});
	test('dropping a schema closes every tab inside it', () => {
		let state = openObjectTab(emptyTabs(), users);
		state = openObjectTab(state, orders);
		state = openObjectTab(state, { ...users, path: ['audit', 'log'], name: 'log' });
		state = closeObjectTabs(state, ['public']);
		expect(state.tabs.map((tab) => tab.id)).toEqual(['o:["audit","log"]']);
		expect(state.active).toBe('o:["audit","log"]');
	});
});
