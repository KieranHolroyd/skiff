import { describe, expect, test } from 'bun:test';
import { planReplicas } from './replicas.ts';

const node = (id: string, zone: string, freeMemoryMb: number, status = 'online') => ({
	id,
	name: id,
	zone,
	status,
	freeMemoryMb,
});

describe('replica planner', () => {
	test('spreads copies across nodes by free memory', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 256,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 2048), node('c', 'home', 512)],
		});
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.plan.assignments.map((item) => item.nodeId)).toEqual(['b', 'a']);
	});

	test('zone spread refuses a second copy in one zone', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 128,
			spread: 'zone',
			candidates: [node('a', 'home', 1024), node('b', 'home', 1024)],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('Cannot place 2 replica');
	});

	test('refuses when a node lacks room and names it', () => {
		const decision = planReplicas({
			count: 2,
			memoryMb: 512,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024), node('b', 'home', 128)],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('only 128 MB free');
	});

	test('ignores offline nodes', () => {
		const decision = planReplicas({
			count: 1,
			memoryMb: 128,
			spread: 'node',
			candidates: [node('a', 'cloud', 1024, 'offline'), node('b', 'home', 512)],
		});
		expect(decision.ok).toBe(true);
		if (decision.ok) expect(decision.plan.assignments[0]!.nodeId).toBe('b');
	});
});
