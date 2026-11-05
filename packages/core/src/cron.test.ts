import { describe, expect, test } from 'bun:test';
import { cronMatches, nextCronTime, parseCron } from './cron.ts';

describe('cron', () => {
	test('parses wildcards, ranges, steps and lists', () => {
		expect(parseCron('*/15 3 * * *').minutes).toEqual(new Set([0, 15, 30, 45]));
		expect(parseCron('0 9-17 * * 1-5').hours).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
		expect(parseCron('0 0 1,15 * *').days).toEqual(new Set([1, 15]));
	});

	test('matches in UTC', () => {
		expect(cronMatches(new Date('2026-11-05T03:00:00Z'), '0 3 * * *')).toBe(true);
		expect(cronMatches(new Date('2026-11-05T03:01:00Z'), '0 3 * * *')).toBe(false);
		// 2026-11-05 is a Thursday (4).
		expect(cronMatches(new Date('2026-11-05T03:00:00Z'), '0 3 * * 4')).toBe(true);
		expect(cronMatches(new Date('2026-11-05T03:00:00Z'), '0 3 * * 5')).toBe(false);
	});

	test('finds the next fire time strictly after now', () => {
		const from = Date.parse('2026-11-05T10:04:30Z');
		expect(new Date(nextCronTime('0 3 * * *', from)!).toISOString()).toBe('2026-11-06T03:00:00.000Z');
		expect(new Date(nextCronTime('*/15 * * * *', from)!).toISOString()).toBe('2026-11-05T10:15:00.000Z');
	});

	test('rejects impossible and malformed schedules', () => {
		expect(() => parseCron('0 3 * *')).toThrow();
		expect(() => parseCron('60 * * * *')).toThrow();
		expect(() => parseCron('0 0 31 2 *')).not.toThrow();
		expect(nextCronTime('0 0 31 2 *', Date.parse('2026-11-05T10:00:00Z'))).toBeNull();
	});
});
