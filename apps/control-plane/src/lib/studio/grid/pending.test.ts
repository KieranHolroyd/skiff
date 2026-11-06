import { describe, expect, test } from 'bun:test';
import type { Cell, Column } from '@skiff/studio/protocol';
import {
	addInsert,
	buildChanges,
	conflictsByTarget,
	editedValue,
	emptyPending,
	pendingCount,
	removeInsert,
	setCellEdit,
	setInsertValue,
	toggleDelete
} from './pending.ts';

const columns: Column[] = [
	{ name: 'id', nativeType: 'bigint', kind: 'bigint', key: 'primary' },
	{ name: 'name', nativeType: 'text', kind: 'text' },
	{ name: 'meta', nativeType: 'jsonb', kind: 'json' },
	{ name: 'body', nativeType: 'text', kind: 'text' }
];
const rows: Cell[][] = [
	[1, 'ada', { $t: 'json', v: { a: 1 } }, 'short'],
	[2, 'grace', null, { $t: 'truncated', v: 'lo', bytes: 100_000 }],
	[{ $t: 'bigint', v: '9007199254740993' }, 'big', null, 'x']
];

describe('pending edits', () => {
	test('keeps only cells that differ, and drops an edit made back to the original', () => {
		let pending = setCellEdit(emptyPending(), 0, 'name', 'ada lovelace', 'ada');
		expect(editedValue(pending, 0, 'name')).toBe('ada lovelace');
		expect(pendingCount(pending)).toBe(1);
		pending = setCellEdit(pending, 0, 'name', 'ada', 'ada');
		expect(pending.updates).toEqual({});
		expect(pendingCount(pending)).toBe(0);
	});

	test('counts rows, not cells, and a deleted row once', () => {
		let pending = setCellEdit(emptyPending(), 0, 'name', 'x', 'ada');
		pending = setCellEdit(pending, 0, 'meta', null, rows[0]![2]!);
		pending = toggleDelete(pending, 1);
		pending = addInsert(pending);
		expect(pendingCount(pending)).toBe(3);
		pending = toggleDelete(pending, 0);
		expect(pendingCount(pending)).toBe(3);
		pending = toggleDelete(pending, 0);
		pending = removeInsert(pending, 0);
		expect(pendingCount(pending)).toBe(2);
	});

	test('tagged values that are structurally equal are not a change', () => {
		const pending = setCellEdit(emptyPending(), 0, 'meta', { $t: 'json', v: { a: 1 } }, rows[0]![2]!);
		expect(pendingCount(pending)).toBe(0);
	});
});

describe('buildChanges', () => {
	test('update: key from keyColumns, only changed values, their loaded originals', () => {
		let pending = setCellEdit(emptyPending(), 0, 'name', 'ada lovelace', 'ada');
		pending = setCellEdit(pending, 0, 'meta', { $t: 'json', v: { a: 2 } }, rows[0]![2]!);
		const { changes, targets, problems } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(problems).toEqual([]);
		expect(changes).toEqual([
			{
				op: 'update',
				key: { id: 1 },
				values: { name: 'ada lovelace', meta: { $t: 'json', v: { a: 2 } } },
				original: { name: 'ada', meta: { $t: 'json', v: { a: 1 } } }
			}
		]);
		expect(targets).toEqual([{ op: 'update', row: 0 }]);
	});

	test('editing a key column keys the update by its loaded value', () => {
		const pending = setCellEdit(emptyPending(), 2, 'id', { $t: 'bigint', v: '9007199254740994' }, rows[2]![0]!);
		const { changes } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(changes[0]).toEqual({
			op: 'update',
			key: { id: { $t: 'bigint', v: '9007199254740993' } },
			values: { id: { $t: 'bigint', v: '9007199254740994' } },
			original: { id: { $t: 'bigint', v: '9007199254740993' } }
		});
	});

	test('delete: key and the original row without truncated previews', () => {
		const pending = toggleDelete(emptyPending(), 1);
		const { changes } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(changes).toEqual([
			{ op: 'delete', key: { id: 2 }, original: { id: 2, name: 'grace', meta: null } }
		]);
	});

	test('insert: only the values the user set', () => {
		let pending = addInsert(emptyPending());
		pending = setInsertValue(pending, 0, 'name', 'new');
		const { changes, targets } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(changes).toEqual([{ op: 'insert', values: { name: 'new' } }]);
		expect(targets).toEqual([{ op: 'insert', insert: 0 }]);
	});

	test('orders deletes, then updates, then inserts; drops updates of deleted rows', () => {
		let pending = addInsert(emptyPending());
		pending = setInsertValue(pending, 0, 'id', 2);
		pending = setCellEdit(pending, 0, 'name', 'x', 'ada');
		pending = setCellEdit(pending, 1, 'name', 'y', 'grace');
		pending = toggleDelete(pending, 1);
		const { changes, targets } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(changes.map((change) => change.op)).toEqual(['delete', 'update', 'insert']);
		expect(targets).toEqual([
			{ op: 'delete', row: 1 },
			{ op: 'update', row: 0 },
			{ op: 'insert', insert: 0 }
		]);
	});

	test('reports rows that cannot be identified', () => {
		const keyless = buildChanges({
			columns,
			rows,
			keyColumns: [],
			pending: toggleDelete(emptyPending(), 0)
		});
		expect(keyless.changes).toEqual([]);
		expect(keyless.problems[0]).toContain('no key');

		const nullKey = buildChanges({
			columns,
			rows: [[null, 'a', null, 'b']],
			keyColumns: ['id'],
			pending: toggleDelete(emptyPending(), 0)
		});
		expect(nullKey.problems[0]).toContain('NULL id');

		const missing = buildChanges({
			columns,
			rows,
			keyColumns: ['uuid'],
			pending: toggleDelete(emptyPending(), 0)
		});
		expect(missing.problems.join(' ')).toContain('uuid');
	});

	test('refuses to write back an edit of a still-truncated cell', () => {
		const pending = setCellEdit(emptyPending(), 1, 'body', 'new', rows[1]![3]!);
		const { changes, problems } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(changes).toEqual([]);
		expect(problems[0]).toContain('truncated');
	});

	test('maps conflicts back to their rows', () => {
		let pending = setCellEdit(emptyPending(), 0, 'name', 'x', 'ada');
		pending = toggleDelete(pending, 1);
		pending = addInsert(pending);
		const { targets } = buildChanges({ columns, rows, keyColumns: ['id'], pending });
		expect(
			conflictsByTarget(
				{ applied: 0, conflicts: [{ index: 1, reason: 'changed' }, { index: 2, reason: 'dup' }] },
				targets
			)
		).toEqual({ 'u:0': 'changed', 'i:0': 'dup' });
	});
});
