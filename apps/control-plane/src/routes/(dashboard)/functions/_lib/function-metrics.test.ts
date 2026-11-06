import { describe, expect, test } from 'bun:test';
import { compactCount, formatRate, summariseTraffic } from './function-metrics.js';

const from = Date.parse('2026-11-06T00:00:00Z');

describe('summariseTraffic', () => {
	test('buckets hourly points into a padded series and derives rates', () => {
		const metrics = summariseTraffic(
			{
				totals: { requests: 200, status5xx: 4, durationP95Ms: 38 },
				series: [
					{ bucket: '2026-11-06T00:00:00Z', requests: 50 },
					{ bucket: '2026-11-06T02:00:00Z', requests: 150 },
					{ bucket: '2026-11-07T05:00:00Z', requests: 9 }
				]
			},
			{ from, hours: 4 }
		);
		expect(metrics.series).toEqual([50, 0, 150, 0]);
		expect(metrics.requests).toBe(200);
		expect(metrics.errorRate).toBeCloseTo(0.02);
		expect(metrics.p95Ms).toBe(38);
	});

	test('no traffic means no trend and no rates', () => {
		expect(
			summariseTraffic(
				{ totals: { requests: 0, status5xx: 0, durationP95Ms: 0 }, series: [] },
				{ from, hours: 24 }
			)
		).toEqual({ series: [], requests: 0, errorRate: null, p95Ms: null });
	});
});

describe('formatting', () => {
	test.each([
		[0, '0'],
		[842, '842'],
		[12_400, '12k'],
		[1_250, '1.3k'],
		[3_100_000, '3.1M']
	])('compactCount(%d) → %s', (value, expected) => {
		expect(compactCount(value)).toBe(expected);
	});

	test.each([
		[null, '—'],
		[0, '0%'],
		[0.0004, '<0.1%'],
		[0.002, '0.2%'],
		[0.12, '12%']
	])('formatRate(%p) → %s', (rate, expected) => {
		expect(formatRate(rate)).toBe(expected);
	});
});
