import { expect, test } from 'bun:test';
import type { BuilderSpec } from '@yoal/contracts';
import { builderSqlToMacros } from './sql-convert.ts';

const builder: BuilderSpec = {
	dataset: 'traffic',
	metrics: [{ field: 'requests', agg: 'sum' }],
	groupBy: ['host'],
	filters: [
		{ field: 'host', op: 'in', value: '$host' },
		{ field: 'host', op: 'eq', value: "o'neil.test" },
		{ field: 'project_id', op: 'in', value: ['a', 'b'] }
	],
	timeSeries: true,
	interval: 'auto'
};

test('rewrites range, interval, scope and filter parameters', () => {
	const sql = [
		'SELECT toStartOfInterval(bucket, INTERVAL 120 SECOND) AS __time, sum(requests) AS __m0',
		'FROM yoal.traffic_1m',
		"WHERE bucket >= {from:DateTime('UTC')} AND bucket <= {to:DateTime('UTC')} AND project_id IN {scope:Array(String)} AND host IN {f0:Array(String)} AND toString(host) = {f1:String} AND project_id IN {f2:Array(String)}",
		'GROUP BY __time'
	].join('\n');
	expect(builderSqlToMacros(sql, builder)).toBe(
		[
			'SELECT $__timeInterval(bucket) AS __time, sum(requests) AS __m0',
			'FROM yoal.traffic_1m',
			"WHERE $__timeFilter(bucket) AND host IN $host AND toString(host) = 'o\\'neil.test' AND project_id IN ('a', 'b')",
			'GROUP BY __time'
		].join('\n')
	);
});

test('leaves unknown parameters alone', () => {
	expect(builderSqlToMacros('SELECT {f9:String}', builder)).toBe('SELECT {f9:String}');
});
