import { describe, expect, test } from 'bun:test';
import { IngressHealth } from './ingress-health.ts';

const policy = { holdDownMs: 45_000, readdHoldDownMs: 120_000, minHealthy: 1 };
const nodes = ['edge', 'edge-b'];

describe('IngressHealth', () => {
	test('withdraws a failed node after the hold-down', () => {
		const health = new IngressHealth();
		health.observe({ nodeId: 'edge', ok: false, at: 0 });
		expect(health.decision(nodes, nodes, 44_999, policy).remove).toEqual([]);
		expect(health.decision(nodes, nodes, 45_000, policy).remove).toEqual(['edge']);
	});

	test('never withdraws the last healthy record', () => {
		const health = new IngressHealth();
		health.observe({ nodeId: 'edge', ok: false, at: 0 });
		health.observe({ nodeId: 'edge-b', ok: false, at: 0 });
		expect(health.decision(nodes, nodes, 60_000, policy).remove).toEqual([]);
	});

	test('adds a recovered node back after the longer hold-down', () => {
		const health = new IngressHealth();
		health.observe({ nodeId: 'edge', ok: false, at: 0 });
		health.observe({ nodeId: 'edge', ok: false, at: 50_000 });
		expect(health.decision(nodes, nodes, 60_000, policy).remove).toEqual(['edge']);
		health.observe({ nodeId: 'edge', ok: true, at: 61_000 });
		expect(health.decision(nodes, ['edge-b'], 180_999, policy).add).toEqual([]);
		expect(health.decision(nodes, ['edge-b'], 181_000, policy).add).toEqual(['edge']);
	});
});
