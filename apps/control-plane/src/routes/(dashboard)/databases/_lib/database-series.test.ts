import { describe, expect, test } from 'bun:test';
import type { DatabaseMetricPoint } from '@skiff/contracts';
import { chooseSpan, databaseChart, databaseTotals, storagePercent } from './database-series.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;

function point(bucket: number, overrides: Partial<DatabaseMetricPoint> = {}): DatabaseMetricPoint {
	return {
		bucket: new Date(bucket).toISOString(),
		up: 1,
		sizeBytes: 1000,
		connectionsActive: 1,
		connectionsIdle: 2,
		connectionsTotal: 3,
		maxConnections: 100,
		memoryBytes: 0,
		poolerUp: 0,
		poolActive: 0,
		poolIdle: 0,
		poolWaiting: 0,
		poolSaturation: 0,
		poolAvgWaitMs: 0,
		xactCommit: 10,
		xactRollback: 1,
		tupReturned: 0,
		tupFetched: 0,
		tupInserted: 3,
		tupUpdated: 2,
		tupDeleted: 1,
		blksHit: 90,
		blksRead: 10,
		deadlocks: 0,
		tempBytes: 0,
		...overrides
	};
}

const start = Date.parse('2026-11-04T10:00:00.000Z');

describe('chooseSpan', () => {
	test('keeps an hour of minutes unmerged', () => {
		expect(chooseSpan(HOUR, '1m')).toBe(1);
	});
	test('merges a day of minutes into 10-minute buckets', () => {
		expect(chooseSpan(24 * HOUR, '1m')).toBe(10);
	});
	test('merges 30 days of hours into 6-hour buckets', () => {
		expect(chooseSpan(30 * 24 * HOUR, '1h')).toBe(6);
	});
});

describe('databaseChart', () => {
	test('one bucket per minute for a short window', () => {
		const points = [point(start), point(start + MINUTE)];
		const chart = databaseChart(points, '1m', { from: start, to: start + HOUR });
		expect(chart.span).toBe(1);
		expect(chart.buckets).toHaveLength(2);
		const first = chart.buckets[0]!;
		expect(first.commitPerMinute).toBe(10);
		expect(first.rowsWrittenPerMinute).toBe(6);
		expect(first.cacheHitRatio).toBeCloseTo(0.9);
		expect(first.end - first.start).toBe(MINUTE);
	});

	test('merged buckets average gauges, max the size and rate the counters', () => {
		const points = Array.from({ length: 10 }, (_, index) =>
			point(start + index * MINUTE, {
				sizeBytes: 1000 + index,
				connectionsActive: index,
				xactCommit: 20,
				blksHit: index === 0 ? 0 : 50,
				blksRead: index === 0 ? 50 : 0
			})
		);
		const chart = databaseChart(points, '1m', { from: start, to: start + 24 * HOUR });
		expect(chart.span).toBe(10);
		expect(chart.buckets).toHaveLength(1);
		const bucket = chart.buckets[0]!;
		expect(bucket.sizeBytes).toBe(1009);
		expect(bucket.connectionsActive).toBe(4.5);
		expect(bucket.commitPerMinute).toBe(20);
		expect(bucket.cacheHitRatio).toBeCloseTo(0.9);
	});

	test('hourly rollups become per-minute rates', () => {
		const chart = databaseChart([point(start, { xactCommit: 600 })], '1h', {
			from: start,
			to: start + 7 * 24 * HOUR
		});
		expect(chart.buckets[0]!.commitPerMinute).toBe(10);
	});

	test('no block access gives no cache ratio', () => {
		const chart = databaseChart([point(start, { blksHit: 0, blksRead: 0 })], '1m', {
			from: start,
			to: start + HOUR
		});
		expect(chart.buckets[0]!.cacheHitRatio).toBeNull();
	});

	test('sorts unordered input', () => {
		const chart = databaseChart([point(start + MINUTE), point(start)], '1m', {
			from: start,
			to: start + HOUR
		});
		expect(chart.buckets.map((bucket) => bucket.start)).toEqual([start, start + MINUTE]);
	});
});

describe('databaseTotals', () => {
	test('sums counters and reads the newest gauges', () => {
		const totals = databaseTotals([
			point(start + MINUTE, { sizeBytes: 2000, connectionsActive: 4, connectionsIdle: 1 }),
			point(start)
		]);
		expect(totals.latestSizeBytes).toBe(2000);
		expect(totals.latestConnections).toBe(5);
		expect(totals.commits).toBe(20);
		expect(totals.rowsWritten).toBe(12);
		expect(totals.cacheHitRatio).toBeCloseTo(0.9);
	});

	test('empty input', () => {
		const totals = databaseTotals([]);
		expect(totals.latestSizeBytes).toBeNull();
		expect(totals.cacheHitRatio).toBeNull();
	});
});

describe('storagePercent', () => {
	test('clamps and handles missing samples', () => {
		expect(storagePercent(null, 100)).toBeNull();
		expect(storagePercent(512 * 1024 * 1024, 1024)).toBe(50);
		expect(storagePercent(4096 * 1024 * 1024, 1024)).toBe(100);
	});
});
