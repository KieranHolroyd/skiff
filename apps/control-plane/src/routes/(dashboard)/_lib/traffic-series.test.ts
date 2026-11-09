import { describe, expect, test } from 'bun:test';
import type { TrafficSeriesPoint } from '@yoal/core';
import { downsampleSeries, spanLabel } from './traffic-series.ts';

const MINUTE = 60_000;
const HOUR = 3_600_000;

function series(
	startIso: string,
	count: number,
	step: number,
	requests: (index: number) => number
) {
	const start = Date.parse(startIso);
	return Array.from({ length: count }, (_, index): TrafficSeriesPoint => {
		const value = requests(index);
		return {
			bucket: new Date(start + index * step).toISOString(),
			requests: value,
			bytes: 0,
			status2xx: value,
			status3xx: 0,
			status4xx: 0,
			status5xx: index === 0 ? 1 : 0,
			durationP50Ms: 0,
			durationP95Ms: 0
		};
	});
}

describe('downsampleSeries', () => {
	test('keeps an hour of minutes as one-minute buckets', () => {
		const result = downsampleSeries(
			series('2026-11-03T11:33:00Z', 60, MINUTE, () => 3),
			'1m'
		);
		expect(result.span).toBe(1);
		expect(result.spanLabel).toBe('1 min');
		expect(result.buckets).toHaveLength(60);
		expect(result.total).toBe(180);
		expect(result.peak).toBe(3);
	});

	test('merges a day of minutes into clock-aligned 10 minute buckets', () => {
		// Starts at :33, so the first and last chunks are partial (7 and 3 minutes).
		const result = downsampleSeries(
			series('2026-11-02T12:33:00Z', 1440, MINUTE, () => 6),
			'1m'
		);
		expect(result.span).toBe(10);
		expect(result.spanLabel).toBe('10 min');
		expect(result.buckets.length).toBeLessThanOrEqual(160);
		expect(result.buckets[0]!.start).toBe('2026-11-02T12:30:00.000Z');
		expect(result.buckets[0]!.end).toBe('2026-11-02T12:40:00.000Z');
		expect(result.buckets[0]!.requests).toBe(42);
		expect(result.buckets[1]!.start).toBe('2026-11-02T12:40:00.000Z');
		expect(result.buckets.at(-1)!.requests).toBe(18);
		// Partial chunks plot the same rate as full ones: no false dip at the edges.
		for (const bucket of result.buckets) expect(bucket.requestRate).toBe(6);
		expect(result.total).toBe(1440 * 6);
	});

	test('reports the busiest single minute as the peak, not a merged sum', () => {
		const result = downsampleSeries(
			series('2026-11-02T12:30:00Z', 1440, MINUTE, (index) => (index === 500 ? 90 : 1)),
			'1m'
		);
		expect(result.peak).toBe(90);
		const spike = result.buckets.find((bucket) => bucket.requests === 99)!;
		expect(spike.requestRate).toBeCloseTo(9.9, 5);
	});

	test('averages 5xx per base interval too', () => {
		const result = downsampleSeries(
			series('2026-11-02T12:30:00Z', 1440, MINUTE, () => 1),
			'1m'
		);
		expect(result.buckets[0]!.status5xx).toBe(1);
		expect(result.buckets[0]!.errorRate).toBeCloseTo(0.1, 5);
	});

	test('uses round hour spans for long ranges', () => {
		const week = downsampleSeries(
			series('2026-10-27T12:00:00Z', 169, HOUR, () => 1),
			'1h'
		);
		expect(week.spanLabel).toBe('2 h');
		const month = downsampleSeries(
			series('2026-10-04T12:00:00Z', 721, HOUR, () => 1),
			'1h'
		);
		expect(month.spanLabel).toBe('6 h');
		expect(month.buckets.length).toBeLessThanOrEqual(160);
		expect(month.buckets[0]!.start).toBe('2026-10-04T12:00:00.000Z');
	});

	test('handles an empty series', () => {
		const result = downsampleSeries([], '1m');
		expect(result.buckets).toEqual([]);
		expect(result.peak).toBe(0);
		expect(result.total).toBe(0);
	});
});

describe('spanLabel', () => {
	test('formats minutes, hours and days', () => {
		expect(spanLabel(15, '1m')).toBe('15 min');
		expect(spanLabel(180, '1m')).toBe('3 h');
		expect(spanLabel(24, '1h')).toBe('1 d');
		expect(spanLabel(6, '1h')).toBe('6 h');
	});
});
