import { describe, expect, test } from 'bun:test';
import type { StorageMetricPoint } from '@skiff/contracts';
import { storageChart, storageTotals } from './storage-series.ts';
import { bucketList } from './forms.server.ts';
import { grantsFromForm } from './grants.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const start = Date.parse('2026-11-04T10:00:00.000Z');

function point(bucket: number, overrides: Partial<StorageMetricPoint> = {}): StorageMetricPoint {
	return {
		bucket: new Date(bucket).toISOString(),
		up: 1,
		usedBytes: 1000,
		objects: 10,
		bucketCount: 2,
		memoryBytes: 100,
		...overrides
	};
}

describe('storageChart', () => {
	test('one bucket per minute for a short window', () => {
		const chart = storageChart([point(start + MINUTE), point(start)], '1m', {
			from: start,
			to: start + HOUR
		});
		expect(chart.span).toBe(1);
		expect(chart.buckets.map((bucket) => bucket.start)).toEqual([start, start + MINUTE]);
		expect(chart.buckets[0]!.end - chart.buckets[0]!.start).toBe(MINUTE);
	});

	test('merged buckets max the stored gauges and average memory', () => {
		const points = Array.from({ length: 10 }, (_, index) =>
			point(start + index * MINUTE, {
				usedBytes: 1000 + index,
				objects: 10 + index,
				memoryBytes: index * 10,
				up: index === 0 ? 0 : 1
			})
		);
		const chart = storageChart(points, '1m', { from: start, to: start + 24 * HOUR });
		expect(chart.span).toBe(10);
		expect(chart.buckets).toHaveLength(1);
		const bucket = chart.buckets[0]!;
		expect(bucket.usedBytes).toBe(1009);
		expect(bucket.objects).toBe(19);
		expect(bucket.memoryBytes).toBe(45);
		expect(bucket.up).toBeCloseTo(0.9);
	});
});

describe('storageTotals', () => {
	test('reads the newest gauges and averages uptime', () => {
		const totals = storageTotals([
			point(start + MINUTE, { usedBytes: 2000, objects: 3, up: 0 }),
			point(start)
		]);
		expect(totals.latestUsedBytes).toBe(2000);
		expect(totals.latestObjects).toBe(3);
		expect(totals.uptime).toBe(0.5);
	});

	test('empty input', () => {
		const totals = storageTotals([]);
		expect(totals.latestUsedBytes).toBeNull();
		expect(totals.uptime).toBeNull();
	});
});

describe('form helpers', () => {
	test('bucketList splits on commas and whitespace', () => {
		expect(bucketList(' Uploads, avatars  media,,')).toEqual(['uploads', 'avatars', 'media']);
		expect(bucketList('')).toEqual([]);
	});

	test('grantsFromForm keeps valid modes and drops no-access rows', () => {
		const data = new FormData();
		data.set('grant:uploads', 'read-write');
		data.set('grant:avatars', 'read');
		data.set('grant:logs', '');
		data.set('grant:bad', 'admin');
		data.set('project', 'web');
		expect(grantsFromForm(data)).toEqual([
			{ bucket: 'uploads', mode: 'read-write' },
			{ bucket: 'avatars', mode: 'read' }
		]);
	});
});
