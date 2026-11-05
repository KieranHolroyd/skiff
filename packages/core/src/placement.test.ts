import { describe, expect, test } from 'bun:test';
import { resolvePlacement, type PlacementCandidate } from './placement.ts';

const node = (overrides: Partial<PlacementCandidate> & { id: string }): PlacementCandidate => ({
	mode: 'worker',
	status: 'online',
	sliceMemoryMb: 1024,
	reservedMemoryMb: 0,
	name: overrides.id,
	...overrides,
});

describe('resolvePlacement', () => {
	const edge = node({ id: 'nod_edge', name: 'edge', mode: 'edge', sliceMemoryMb: 1024 });
	const homelab = node({ id: 'nod_home', name: 'homelab', sliceMemoryMb: 4096 });
	const small = node({ id: 'nod_small', name: 'small', sliceMemoryMb: 512, reservedMemoryMb: 256 });

	test('static sites always go to the edge', () => {
		const decision = resolvePlacement({
			runtime: 'static',
			requested: 'auto',
			memoryMb: 0,
			edgeNodeId: edge.id,
			candidates: [edge, homelab],
		});
		expect(decision).toMatchObject({ ok: true, nodeId: edge.id, mode: 'edge' });
	});

	test('auto prefers the worker with the most free budget', () => {
		const decision = resolvePlacement({
			runtime: 'process',
			requested: 'auto',
			memoryMb: 256,
			edgeNodeId: edge.id,
			candidates: [edge, homelab, small],
		});
		expect(decision).toMatchObject({ ok: true, nodeId: homelab.id, mode: 'worker' });
	});

	test('auto falls back to the edge when no worker can admit', () => {
		const decision = resolvePlacement({
			runtime: 'container',
			requested: 'auto',
			memoryMb: 512,
			edgeNodeId: edge.id,
			candidates: [edge, small],
		});
		expect(decision).toMatchObject({ ok: true, nodeId: edge.id, mode: 'edge' });
	});

	test('rejects a deploy that would exceed the node budget', () => {
		const decision = resolvePlacement({
			runtime: 'process',
			requested: homelab.id,
			memoryMb: 5000,
			edgeNodeId: edge.id,
			candidates: [edge, homelab],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('5000 MB');
	});

	test('rejects when no node has room, naming the free budget', () => {
		const decision = resolvePlacement({
			runtime: 'process',
			requested: 'auto',
			memoryMb: 256,
			edgeNodeId: edge.id,
			candidates: [{ ...edge, reservedMemoryMb: 900 }, { ...small, reservedMemoryMb: 300 }],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.freeByNode.map((row) => row.freeMemoryMb)).toEqual([124, 212]);
	});

	test('optional disk admission refuses a node without room', () => {
		const decision = resolvePlacement({
			runtime: 'process',
			requested: homelab.id,
			memoryMb: 128,
			diskMb: 9_500,
			edgeNodeId: edge.id,
			candidates: [{ ...homelab, diskFreeBytes: 10 * 1024 * 1024 * 1024, reservedDiskBytes: 0 }],
		});
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('90% admission limit');
	});

	test('never places an app on a draining node', () => {
		const decision = resolvePlacement({
			runtime: 'process',
			requested: homelab.id,
			memoryMb: 128,
			edgeNodeId: edge.id,
			candidates: [edge, { ...homelab, status: 'draining' }],
		});
		expect(decision.ok).toBe(false);
	});
});
