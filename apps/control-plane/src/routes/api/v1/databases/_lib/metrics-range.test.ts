import { describe, expect, test } from 'bun:test';
import { ValidationError } from '@yoal/core';
import { parseDatabaseMetricsRange } from './metrics-range.ts';

const now = Date.parse('2026-11-04T12:00:00.000Z');
const parse = (query: string) => parseDatabaseMetricsRange(new URLSearchParams(query), now);

describe('parseDatabaseMetricsRange', () => {
	test('defaults to the last hour at 1m', () => {
		const range = parse('');
		expect(range.interval).toBe('1m');
		expect(range.to.toISOString()).toBe('2026-11-04T12:00:00.000Z');
		expect(range.from.toISOString()).toBe('2026-11-04T11:00:00.000Z');
	});

	test('accepts ISO timestamps and epoch milliseconds', () => {
		const range = parse(`from=2026-11-04T06:00:00Z&to=${now}`);
		expect(range.from.toISOString()).toBe('2026-11-04T06:00:00.000Z');
		expect(range.to.getTime()).toBe(now);
		expect(range.interval).toBe('1m');
	});

	test('switches to 1h when the range exceeds 48 hours', () => {
		expect(parse('from=2026-11-02T12:00:00Z').interval).toBe('1m');
		expect(parse('from=2026-11-02T11:59:00Z').interval).toBe('1h');
		expect(parse('from=2026-10-28T12:00:00Z&interval=1h').interval).toBe('1h');
	});

	test('rejects bad input', () => {
		expect(() => parse('from=yesterday')).toThrow(ValidationError);
		expect(() => parse('interval=5m')).toThrow(ValidationError);
		expect(() => parse('from=2026-11-04T13:00:00Z')).toThrow('before');
		expect(() => parse('from=2026-10-28T12:00:00Z&interval=1m')).toThrow('48 hours');
		expect(() => parse('from=2026-01-01T00:00:00Z')).toThrow('92 days');
	});
});
