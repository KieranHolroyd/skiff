import { describe, expect, test } from 'bun:test';
import { parseTrafficRange, trafficRangeHref } from './traffic-range.ts';

const NOW = Date.parse('2026-11-03T12:34:56Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('parseTrafficRange', () => {
	test('defaults to 24 hours of minute buckets', () => {
		const range = parseTrafficRange(null, NOW);
		expect(range.key).toBe('24h');
		expect(range.interval).toBe('1m');
		// 12:34 is still open and 12:33 may not be shipped yet; 12:32 is the last full minute.
		expect(Date.parse(range.to)).toBe(Date.parse('2026-11-03T12:32:00Z'));
		expect(Date.parse(range.from)).toBe(Date.parse('2026-11-02T12:33:00Z'));
		// Both ends are inclusive minute buckets: exactly 1440 of them, 24 hours of data.
		expect((Date.parse(range.to) - Date.parse(range.from)) / MINUTE + 1).toBe(1440);
		expect(range.windowSeconds).toBe(24 * 3600);
	});

	test('supports a one hour window of minute buckets', () => {
		const range = parseTrafficRange('1h', NOW);
		expect(range.key).toBe('1h');
		expect(range.interval).toBe('1m');
		expect(Date.parse(range.to) - Date.parse(range.from)).toBe(HOUR - MINUTE);
		expect(range.windowSeconds).toBe(3600);
	});

	test('uses hourly buckets and aligns the start for long ranges', () => {
		const range = parseTrafficRange('7d', NOW);
		expect(range.key).toBe('7d');
		expect(range.interval).toBe('1h');
		expect(Date.parse(range.to)).toBe(Date.parse('2026-11-03T12:32:00Z'));
		expect(Date.parse(range.from)).toBe(Date.parse('2026-10-27T12:00:00Z'));
		// The aligned start adds the 33 minutes of the first hour to the averaging window.
		expect(range.windowSeconds).toBe(7 * 24 * 3600 + 33 * 60);
	});

	test('never ends on a minute the agents have not reported', () => {
		const onTheMinute = parseTrafficRange('1h', Date.parse('2026-11-03T12:34:00Z'));
		expect(Date.parse(onTheMinute.to)).toBe(Date.parse('2026-11-03T12:32:00Z'));
	});

	test('falls back to 24h for an unknown or missing range', () => {
		expect(parseTrafficRange('nonsense', NOW)).toEqual(parseTrafficRange('24h', NOW));
	});
});

describe('trafficRangeHref', () => {
	test('keeps the current tab and other parameters', () => {
		const url = new URL('http://localhost/projects/site?tab=traffic&foo=bar');
		expect(trafficRangeHref(url, '7d')).toBe('/projects/site?tab=traffic&foo=bar&range=7d');
	});

	test('can force the traffic tab when building a project link', () => {
		const url = new URL('http://localhost/projects/site');
		expect(trafficRangeHref(url, '30d', { tab: 'traffic' })).toBe(
			'/projects/site?tab=traffic&range=30d'
		);
	});
});
