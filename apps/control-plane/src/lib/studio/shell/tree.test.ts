import { describe, expect, test } from 'bun:test';
import type { TreeNode } from '@yoal/studio/protocol';
import { findItem, formatBytes, formatCount, toItem, visibleItems, type TreeItem } from './tree.ts';

const node = (path: string[], browsable = true): TreeNode => ({
	path,
	name: path.at(-1)!,
	kind: browsable ? 'table' : 'schema',
	hasChildren: !browsable,
	browsable
});

function fixture(): TreeItem[] {
	const pub = toItem(node(['public'], false));
	pub.children = [toItem(node(['public', 'users'])), toItem(node(['public', 'orders']))];
	const audit = toItem(node(['audit'], false));
	audit.children = [toItem(node(['audit', 'user_events']))];
	const empty = toItem(node(['empty'], false));
	return [pub, audit, empty];
}

describe('visibleItems', () => {
	test('shows expanded branches only', () => {
		const roots = fixture();
		expect(visibleItems(roots).map((v) => v.item.node.name)).toEqual(['public', 'audit', 'empty']);
		roots[0]!.expanded = true;
		const shown = visibleItems(roots);
		expect(shown.map((v) => `${v.level}:${v.item.node.name}`)).toEqual([
			'1:public',
			'2:users',
			'2:orders',
			'1:audit',
			'1:empty'
		]);
		expect(shown[1]).toMatchObject({ parent: '["public"]', posinset: 1, setsize: 2 });
	});

	test('filters loaded nodes and opens their ancestors', () => {
		const shown = visibleItems(fixture(), 'USER');
		expect(shown.map((v) => v.item.node.name)).toEqual(['public', 'users', 'audit', 'user_events']);
		expect(shown[0]!.open).toBe(true);
		expect(visibleItems(fixture(), 'nothing')).toEqual([]);
	});
});

describe('findItem', () => {
	test('walks the loaded tree by path', () => {
		const roots = fixture();
		expect(findItem(roots, ['public', 'orders'])?.node.name).toBe('orders');
		expect(findItem(roots, ['public', 'missing'])).toBeNull();
		expect(findItem(null, ['x'])).toBeNull();
	});
});

describe('formatting', () => {
	test('bytes and counts', () => {
		expect(formatBytes(512)).toBe('512 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
		expect(formatCount(999)).toBe('999');
		expect(formatCount(1234)).toBe('1.2k');
		expect(formatCount(2_500_000)).toBe('2.5M');
	});
});
