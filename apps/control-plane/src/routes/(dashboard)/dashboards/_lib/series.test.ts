import { describe, expect, test } from 'bun:test';
import type { QueryColumn, QueryResult } from '@skiff/contracts';
import { reduce, toCsv, toFrame, toItems } from './series.ts';

const time: QueryColumn = { name: 'time', type: "DateTime('UTC')", kind: 'time' };
const num = (name: string): QueryColumn => ({ name, type: 'Float64', kind: 'number' });
const str = (name: string): QueryColumn => ({ name, type: 'String', kind: 'string' });

function result(columns: QueryColumn[], rows: QueryResult['rows']): QueryResult {
	return {
		columns,
		rows,
		sql: 'SELECT 1',
		intervalSeconds: 60,
		resolution: '1m',
		stats: { elapsedMs: 1, rowsRead: rows.length, bytesRead: 0 },
		truncated: false
	};
}

const names = {
	project: { p1: 'Marketing site', p2: 'API' },
	database: {},
	storage: {},
	broker: {}
};

describe('toFrame', () => {
	test('time + numeric columns: one series per column', () => {
		const frame = toFrame(
			result(
				[time, num('requests'), num('bytes')],
				[
					[2000, 5, 50],
					[1000, 3, 30]
				]
			)
		);
		expect(frame.kind).toBe('time');
		if (frame.kind !== 'time') return;
		expect(frame.times).toEqual([1000, 2000]);
		expect(frame.series.map((series) => series.name)).toEqual(['requests', 'bytes']);
		expect(frame.series[0]!.values).toEqual([3, 5]);
	});

	test('long to wide with display names, gaps as null', () => {
		const frame = toFrame(
			result(
				[time, str('project_id'), num('requests')],
				[
					[1000, 'p1', 1],
					[1000, 'p2', 2],
					[2000, 'p1', 3],
					[3000, 'p3', 4]
				]
			),
			names
		);
		if (frame.kind !== 'time') throw new Error('expected time frame');
		expect(frame.times).toEqual([1000, 2000, 3000]);
		expect(frame.series.map((series) => series.name)).toEqual(['Marketing site', 'API', 'p3']);
		expect(frame.series[0]!.values).toEqual([1, 3, null]);
		expect(frame.series[1]!.values).toEqual([2, null, null]);
		expect(frame.series[2]!.values).toEqual([null, null, 4]);
	});

	test('long to wide with several numeric columns names both', () => {
		const frame = toFrame(
			result([time, str('host'), num('a'), num('b')], [[1000, 'x.test', 1, 2]])
		);
		if (frame.kind !== 'time') throw new Error('expected time frame');
		expect(frame.series.map((series) => series.name)).toEqual(['x.test · a', 'x.test · b']);
	});

	test('no time column: categories', () => {
		const frame = toFrame(
			result(
				[str('project_id'), num('requests')],
				[
					['p2', 10],
					['p1', 7]
				]
			),
			names
		);
		expect(frame).toEqual({
			kind: 'category',
			categories: ['API', 'Marketing site'],
			series: [{ name: 'requests', field: 'requests', values: [10, 7] }]
		});
	});

	test('numbers that arrive as strings are parsed', () => {
		const frame = toFrame(result([time, num('v')], [[1000, '12.5' as unknown as number]]));
		if (frame.kind !== 'time') throw new Error('expected time frame');
		expect(frame.series[0]!.values).toEqual([12.5]);
	});
});

describe('reduce and items', () => {
	test('reducers skip nulls', () => {
		const values = [null, 2, 8, null, 5];
		expect(reduce(values, 'last')).toBe(5);
		expect(reduce(values, 'first')).toBe(2);
		expect(reduce(values, 'max')).toBe(8);
		expect(reduce(values, 'min')).toBe(2);
		expect(reduce(values, 'sum')).toBe(15);
		expect(reduce(values, 'mean')).toBe(5);
		expect(reduce([null], 'last')).toBeNull();
	});

	test('category frame with one numeric column gives one item per row', () => {
		const frame = toFrame(
			result(
				[str('host'), num('hits')],
				[
					['a', 1],
					['b', 2]
				]
			)
		);
		expect(toItems(frame)).toEqual([
			{ name: 'a', value: 1 },
			{ name: 'b', value: 2 }
		]);
	});

	test('single-row category frame names the item after the column', () => {
		const frame = toFrame(result([num('error_rate')], [[0.05]]));
		expect(toItems(frame)).toEqual([{ name: 'error_rate', value: 0.05 }]);
	});
});

test('csv escapes and formats time', () => {
	const csv = toCsv(result([time, str('path')], [[0, 'a,"b"']]));
	expect(csv).toBe('time,path\n1970-01-01T00:00:00.000Z,"a,""b"""\n');
});
