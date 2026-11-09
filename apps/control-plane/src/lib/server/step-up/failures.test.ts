import { describe, expect, test } from 'bun:test';
import { StepUpFailureBudget } from './failures';

describe('StepUpFailureBudget', () => {
	test('counts across methods until the fifth failure exhausts the session', () => {
		const budget = new StepUpFailureBudget(5);
		for (let attempt = 1; attempt <= 4; attempt++)
			expect(budget.record('session')).toEqual({ count: attempt, exhausted: false });
		expect(budget.record('session')).toEqual({ count: 5, exhausted: true });
		expect(budget.exhausted('session')).toBe(true);
	});

	test('a success clears the budget', () => {
		const budget = new StepUpFailureBudget(5);
		budget.record('session');
		budget.record('session');
		budget.clear('session');
		expect(budget.count('session')).toBe(0);
		expect(budget.record('session')).toEqual({ count: 1, exhausted: false });
	});

	test('sessions have separate budgets', () => {
		const budget = new StepUpFailureBudget(5);
		for (let i = 0; i < 5; i++) budget.record('a');
		expect(budget.exhausted('a')).toBe(true);
		expect(budget.exhausted('b')).toBe(false);
	});
});
