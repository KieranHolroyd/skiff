import { describe, expect, test } from 'bun:test';
import type { FailoverPlan } from '@skiff/contracts';
import { advanceFailover, canAdvance, FAILOVER_BUDGET_MS } from './failover.ts';

const plan = {
	databaseId: 'db_1',
	candidateNodeId: 'nod_b',
	generation: 2,
	stage: 'detect' as const,
	reason: 'node offline',
};

describe('failover orchestration', () => {
	test('advances through fence, promote, repoint and heal', () => {
		let current: FailoverPlan = plan;
		for (const stage of ['decide', 'fence', 'promote', 'repoint', 'heal', 'complete'] as const) {
			current = advanceFailover(current);
			expect(current.stage).toBe(stage);
		}
		expect(advanceFailover(current)).toEqual(current);
	});

	test('refuses to skip fencing', () => {
		expect(canAdvance('decide', 'promote')).toBe(false);
		expect(canAdvance('fence', 'promote')).toBe(true);
	});

	test('the two-minute budget is explicit', () => {
		expect(FAILOVER_BUDGET_MS).toBe(120_000);
	});
});
