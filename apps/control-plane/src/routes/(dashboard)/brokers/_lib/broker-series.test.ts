import { describe, expect, test } from 'bun:test';
import type { BrokerMetricPoint } from '@yoal/contracts';
import { brokerChart, brokerTotals, streamAgeSeconds } from './broker-series.ts';

const MINUTE = 60_000;
const start = Date.parse('2026-11-07T10:00:00.000Z');

function point(bucket: number, overrides: Partial<BrokerMetricPoint> = {}): BrokerMetricPoint {
	return {
		bucket: new Date(bucket).toISOString(),
		up: 1,
		connections: 2,
		streams: 1,
		consumers: 1,
		storeBytes: 1000,
		storeLimitBytes: 10_000,
		memoryStoreBytes: 0,
		messages: 5,
		pending: 3,
		ackPending: 1,
		redelivered: 0,
		oldestAgeSeconds: 30,
		published: 10,
		messagesIn: 12,
		messagesOut: 11,
		bytesIn: 100,
		bytesOut: 200,
		slowConsumers: 0,
		memoryBytes: 50,
		...overrides
	};
}

describe('brokerChart', () => {
	test('one bucket per minute for a short window', () => {
		const chart = brokerChart([point(start + MINUTE), point(start)], '1m', {
			from: start,
			to: start + 60 * MINUTE
		});
		expect(chart.span).toBe(1);
		expect(chart.buckets.map((bucket) => bucket.start)).toEqual([start, start + MINUTE]);
	});

	test('merged buckets sum counters, average up/connections and keep gauge peaks', () => {
		const chart = brokerChart(
			[
				point(start, { up: 1, connections: 2, pending: 3, published: 10, storeBytes: 1000 }),
				point(start + MINUTE, { up: 0, connections: 4, pending: 9, published: 5, storeBytes: 800 })
			],
			'1m',
			{ from: start, to: start + 7 * 86_400_000 },
			10
		);
		expect(chart.span).toBeGreaterThan(1);
		expect(chart.buckets).toHaveLength(1);
		const [bucket] = chart.buckets;
		expect(bucket!.up).toBe(0.5);
		expect(bucket!.connections).toBe(3);
		expect(bucket!.pending).toBe(9);
		expect(bucket!.storeBytes).toBe(1000);
		expect(bucket!.published).toBe(15);
		expect(bucket!.end).toBe(start + 2 * MINUTE);
	});
});

describe('brokerTotals', () => {
	test('newest point, uptime, sums and peak backlog', () => {
		const totals = brokerTotals([
			point(start + MINUTE, { up: 0, pending: 7, ackPending: 2, published: 4 }),
			point(start, { published: 6 })
		]);
		expect(totals.latest?.bucket).toBe(new Date(start + MINUTE).toISOString());
		expect(totals.uptime).toBe(0.5);
		expect(totals.published).toBe(10);
		expect(totals.peakBacklog).toBe(9);
	});

	test('empty range', () => {
		expect(brokerTotals([])).toMatchObject({ latest: null, uptime: null, published: 0 });
	});
});

describe('streamAgeSeconds', () => {
	test('age at the listing, null when empty or unparseable', () => {
		expect(streamAgeSeconds('2026-11-07T10:00:00.000Z', '2026-11-07T10:01:30.000Z')).toBe(90);
		expect(streamAgeSeconds(null, '2026-11-07T10:01:30.000Z')).toBeNull();
		expect(streamAgeSeconds('nope', '2026-11-07T10:01:30.000Z')).toBeNull();
	});
});
