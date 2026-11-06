import { describe, expect, test } from 'bun:test';
import { cssColor, formatValue, thresholdColor } from './units.ts';

describe('formatValue', () => {
	test('short', () => {
		expect(formatValue(0)).toBe('0');
		expect(formatValue(12)).toBe('12');
		expect(formatValue(1234)).toBe('1.23K');
		expect(formatValue(1_500_000)).toBe('1.5M');
		expect(formatValue(2_000_000_000)).toBe('2B');
		expect(formatValue(1234, 'short', 1)).toBe('1.2K');
		expect(formatValue(0.25)).toBe('0.25');
	});

	test('bytes (IEC)', () => {
		expect(formatValue(512, 'bytes')).toBe('512 B');
		expect(formatValue(1536, 'bytes')).toBe('1.5 KiB');
		expect(formatValue(5 * 1024 ** 3, 'bytes')).toBe('5 GiB');
		expect(formatValue(2048, 'bytesps')).toBe('2 KiB/s');
	});

	test('durations', () => {
		expect(formatValue(120, 'ms')).toBe('120 ms');
		expect(formatValue(1500, 'ms')).toBe('1.5 s');
		expect(formatValue(90_000, 'ms')).toBe('1.5 min');
		expect(formatValue(0.5, 'ms')).toBe('500 µs');
		expect(formatValue(2, 's')).toBe('2 s');
	});

	test('percent', () => {
		expect(formatValue(12.345, 'percent')).toBe('12.3%');
		expect(formatValue(0.5, 'percent')).toBe('0.5%');
		expect(formatValue(0.125, 'percentunit')).toBe('12.5%');
		expect(formatValue(0.98765, 'percentunit', 2)).toBe('98.77%');
	});

	test('rates and plain numbers', () => {
		expect(formatValue(1200, 'reqps')).toBe('1.2K req/s');
		expect(formatValue(1234567, 'none')).toBe('1,234,567');
		expect(formatValue(3.14159, 'none', 2)).toBe('3.14');
	});

	test('missing values', () => {
		expect(formatValue(null)).toBe('—');
		expect(formatValue(Number.NaN, 'bytes')).toBe('—');
	});
});

describe('thresholds', () => {
	const steps = [
		{ value: null, color: 'green' },
		{ value: 80, color: 'orange' },
		{ value: 95, color: 'red' }
	];

	test('picks the highest step at or below the value', () => {
		expect(thresholdColor(10, steps)).toBe(cssColor('green'));
		expect(thresholdColor(80, steps)).toBe(cssColor('orange'));
		expect(thresholdColor(99, steps)).toBe(cssColor('red'));
	});

	test('unsorted input and no thresholds', () => {
		expect(thresholdColor(90, [steps[2]!, steps[0]!, steps[1]!])).toBe(cssColor('orange'));
		expect(thresholdColor(90, [])).toBeNull();
	});

	test('css colours pass through, junk falls back', () => {
		expect(cssColor('#ff0000')).toBe('#ff0000');
		expect(cssColor('url(evil)')).toBe('var(--color-chart-1)');
	});
});
