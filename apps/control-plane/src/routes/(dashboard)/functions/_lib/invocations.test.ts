import { describe, expect, test } from 'bun:test';
import { invocationErrorRate, outcomeTone } from './invocations.js';

describe('invocations', () => {
	test.each([
		['ok', 'success'],
		['exception', 'danger'],
		['exceededCpu', 'warning'],
		['canceled', 'warning'],
		['unknown', 'neutral']
	])('%s → %s', (outcome, tone) => {
		expect(outcomeTone(outcome)).toBe(tone as ReturnType<typeof outcomeTone>);
	});

	test('error rate counts everything that is not ok', () => {
		expect(invocationErrorRate({ ok: 9, exception: 1 })).toBeCloseTo(0.1);
		expect(invocationErrorRate({})).toBeNull();
	});
});
