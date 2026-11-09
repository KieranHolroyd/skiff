import { describe, expect, test } from 'bun:test';
import { formatDuration, parseDurationSeconds } from './access.ts';

describe('parseDurationSeconds', () => {
	const now = Date.UTC(2026, 10, 9, 12, 0, 0);

	test('defaults to one hour', () => {
		expect(parseDurationSeconds(undefined, now)).toBe(3600);
	});

	test('reads the familiar durations', () => {
		expect(parseDurationSeconds('30m', now)).toBe(1_800);
		expect(parseDurationSeconds('2h', now)).toBe(7_200);
		expect(parseDurationSeconds('8h', now)).toBe(28_800);
	});

	test('refuses more than eight hours and nonsense', () => {
		expect(() => parseDurationSeconds('9h', now)).toThrow(/eight hours/);
		expect(() => parseDurationSeconds('soon', now)).toThrow();
		expect(() => parseDurationSeconds('2026-01-01T00:00:00Z', now)).toThrow();
	});
});

describe('formatDuration', () => {
	test('prefers hours, then minutes, then seconds', () => {
		expect(formatDuration(3600)).toBe('1h');
		expect(formatDuration(1800)).toBe('30m');
		expect(formatDuration(45)).toBe('45s');
	});
});
