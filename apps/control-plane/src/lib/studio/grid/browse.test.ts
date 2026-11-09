import { describe, expect, test } from 'bun:test';
import type { CellKind, Column } from '@yoal/studio/protocol';
import { buildFilter, filterOpsFor, nextSort, selectStatement } from './browse.ts';

const col = (name: string, kind: CellKind): Column => ({ name, nativeType: kind, kind });
const columns = [col('id', 'bigint'), col('name', 'text'), col('ok', 'boolean'), col('meta', 'json'), col('at', 'datetime')];

describe('filterOpsFor', () => {
	test('limits ops by kind', () => {
		expect(filterOpsFor(col('ok', 'boolean'))).toEqual(['eq', 'ne', 'is-null', 'not-null']);
		expect(filterOpsFor(col('meta', 'json'))).toEqual(['like', 'ilike', 'is-null', 'not-null']);
		expect(filterOpsFor(col('b', 'bytes'))).toEqual(['is-null', 'not-null']);
		expect(filterOpsFor(col('id', 'bigint'))).toEqual(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'is-null', 'not-null']);
		expect(filterOpsFor(col('name', 'text'))).toContain('ilike');
	});
});

describe('buildFilter', () => {
	test('types values by column kind', () => {
		const built = buildFilter(columns, [
			{ column: 'id', op: 'gt', value: '9007199254740993' },
			{ column: 'id', op: 'in', value: '1, 2,3' },
			{ column: 'ok', op: 'eq', value: 'true' },
			{ column: 'name', op: 'ilike', value: '%ada%' },
			{ column: 'at', op: 'gte', value: '2026-11-01T00:00:00Z' },
			{ column: 'meta', op: 'is-null', value: 'ignored' }
		]);
		expect(built).toEqual({
			ok: true,
			filter: [
				{ column: 'id', op: 'gt', value: { $t: 'bigint', v: '9007199254740993' } },
				{ column: 'id', op: 'in', value: [1, 2, 3] },
				{ column: 'ok', op: 'eq', value: true },
				{ column: 'name', op: 'ilike', value: '%ada%' },
				{ column: 'at', op: 'gte', value: { $t: 'datetime', v: '2026-11-01T00:00:00Z' } },
				{ column: 'meta', op: 'is-null' }
			]
		});
	});

	test('reports the first bad row', () => {
		const built = buildFilter(columns, [
			{ column: 'name', op: 'eq', value: 'x' },
			{ column: 'id', op: 'eq', value: 'abc' }
		]);
		expect(built.ok).toBe(false);
		if (!built.ok) expect(built.index).toBe(1);
		expect(buildFilter(columns, [{ column: 'ok', op: 'lt', value: 'true' }]).ok).toBe(false);
	});
});

describe('nextSort', () => {
	test('click cycles one column; shift-click adds', () => {
		let sort = nextSort([], 'a', false);
		expect(sort).toEqual([{ column: 'a', dir: 'asc' }]);
		sort = nextSort(sort, 'a', false);
		expect(sort).toEqual([{ column: 'a', dir: 'desc' }]);
		expect(nextSort(sort, 'a', false)).toEqual([]);
		sort = nextSort(sort, 'b', true);
		expect(sort).toEqual([
			{ column: 'a', dir: 'desc' },
			{ column: 'b', dir: 'asc' }
		]);
		expect(nextSort(sort, 'b', false)).toEqual([{ column: 'b', dir: 'desc' }]);
		expect(nextSort(sort, 'a', true)).toEqual([{ column: 'b', dir: 'asc' }]);
	});
});

describe('selectStatement', () => {
	test('quotes per dialect', () => {
		expect(selectStatement(['public', 'my "t"'], 'postgres')).toBe('SELECT * FROM "public"."my ""t""" LIMIT 100');
		expect(selectStatement(['or`ders'], 'mysql')).toBe('SELECT * FROM `or``ders` LIMIT 100');
		expect(selectStatement(['t'], 'mariadb', 10)).toBe('SELECT * FROM `t` LIMIT 10');
	});
});
