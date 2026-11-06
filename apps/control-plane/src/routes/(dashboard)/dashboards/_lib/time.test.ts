import { describe, expect, test } from 'bun:test';
import {
	formatInterval,
	parseDuration,
	parseTime,
	rangeLabel,
	resolveRange,
	shiftRange,
	zoomOut
} from './time.ts';

// Thursday 2026-11-05 14:37:12.345 UTC
const NOW = Date.UTC(2026, 10, 5, 14, 37, 12, 345);
const HOUR = 3_600_000;

describe('parseTime', () => {
	test('now and offsets', () => {
		expect(parseTime('now', NOW)).toBe(NOW);
		expect(parseTime('now-6h', NOW)).toBe(NOW - 6 * HOUR);
		expect(parseTime('now-15m', NOW)).toBe(NOW - 15 * 60_000);
		expect(parseTime('now+1d', NOW)).toBe(NOW + 24 * HOUR);
		expect(parseTime('now-1w', NOW)).toBe(NOW - 7 * 24 * HOUR);
	});

	test('calendar months and years', () => {
		expect(parseTime('now-1M', NOW)).toBe(Date.UTC(2026, 9, 5, 14, 37, 12, 345));
		expect(parseTime('now-1y', NOW)).toBe(Date.UTC(2025, 10, 5, 14, 37, 12, 345));
	});

	test('rounding down and up', () => {
		expect(parseTime('now/d', NOW)).toBe(Date.UTC(2026, 10, 5));
		expect(parseTime('now/d', NOW, true)).toBe(Date.UTC(2026, 10, 6) - 1);
		expect(parseTime('now-1d/d', NOW)).toBe(Date.UTC(2026, 10, 4));
		expect(parseTime('now/h', NOW)).toBe(Date.UTC(2026, 10, 5, 14));
		// ISO week starts Monday 2026-11-02.
		expect(parseTime('now/w', NOW)).toBe(Date.UTC(2026, 10, 2));
		expect(parseTime('now/M', NOW)).toBe(Date.UTC(2026, 10, 1));
		expect(parseTime('now/M', NOW, true)).toBe(Date.UTC(2026, 11, 1) - 1);
	});

	test('absolute times', () => {
		expect(parseTime('2026-11-01T00:00:00Z', NOW)).toBe(Date.UTC(2026, 10, 1));
		expect(parseTime('2026-11-01 06:30', NOW)).toBe(Date.UTC(2026, 10, 1, 6, 30));
		expect(parseTime('2026-11-01', NOW)).toBe(Date.UTC(2026, 10, 1));
		expect(parseTime(String(Date.UTC(2026, 10, 1)), NOW)).toBe(Date.UTC(2026, 10, 1));
	});

	test('rejects junk', () => {
		expect(parseTime('', NOW)).toBeNull();
		expect(parseTime('now-6x', NOW)).toBeNull();
		expect(parseTime('yesterday', NOW)).toBeNull();
		expect(parseTime('now-', NOW)).toBeNull();
	});
});

describe('ranges', () => {
	test('resolveRange', () => {
		expect(resolveRange({ from: 'now-6h', to: 'now' }, NOW)).toEqual({
			from: NOW - 6 * HOUR,
			to: NOW
		});
		expect(resolveRange({ from: 'now', to: 'now-1h' }, NOW)).toBeNull();
		expect(resolveRange({ from: 'bad', to: 'now' }, NOW)).toBeNull();
	});

	test('labels', () => {
		expect(rangeLabel({ from: 'now-6h', to: 'now' }, NOW)).toBe('Last 6 hours');
		expect(rangeLabel({ from: 'now-4h', to: 'now' }, NOW)).toBe('Last 4 hours');
		expect(rangeLabel({ from: 'now/d', to: 'now/d' }, NOW)).toBe('Today');
		expect(rangeLabel({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' }, NOW)).toBe(
			'01 Nov 00:00 to 02 Nov 00:00'
		);
	});

	test('zoom out keeps relative ranges relative', () => {
		expect(zoomOut({ from: 'now-6h', to: 'now' }, NOW)).toEqual({ from: 'now-12h', to: 'now' });
		const zoomed = zoomOut(
			{ from: '2026-11-01T00:00:00.000Z', to: '2026-11-01T02:00:00.000Z' },
			NOW
		);
		expect(zoomed).toEqual({ from: '2026-10-31T23:00:00.000Z', to: '2026-11-01T03:00:00.000Z' });
	});

	test('shift by half a span, clamped at now', () => {
		const range = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-01T02:00:00.000Z' };
		expect(shiftRange(range, -1, NOW)).toEqual({
			from: '2026-10-31T23:00:00.000Z',
			to: '2026-11-01T01:00:00.000Z'
		});
		const forward = shiftRange({ from: 'now-1h', to: 'now' }, 1, NOW);
		expect(Date.parse(forward.to)).toBe(NOW);
		expect(Date.parse(forward.from)).toBe(NOW - HOUR);
	});
});

describe('durations', () => {
	test('parseDuration', () => {
		expect(parseDuration('10s')).toBe(10_000);
		expect(parseDuration('5m')).toBe(300_000);
		expect(parseDuration('1h')).toBe(HOUR);
		expect(parseDuration(null)).toBeNull();
		expect(parseDuration('off')).toBeNull();
		expect(parseDuration('0s')).toBeNull();
	});

	test('formatInterval', () => {
		expect(formatInterval(60)).toBe('1m');
		expect(formatInterval(300)).toBe('5m');
		expect(formatInterval(3600)).toBe('1h');
		expect(formatInterval(86_400)).toBe('1d');
		expect(formatInterval(45)).toBe('45s');
	});
});
