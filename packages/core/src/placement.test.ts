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

describe('placement spec', () => {
	const edge = node({ id: 'nod_edge', name: 'edge', mode: 'edge', zone: 'cloud-a', roles: ['ingress', 'control', 'compute', 'data'], labels: { 'yoal.io/arch': 'arm64' } });
	const cloud = node({ id: 'nod_cloud', name: 'cloud-b', zone: 'cloud-b', roles: ['compute', 'data'], labels: { tier: 'critical' }, volumeClasses: ['fast'] });
	const home = node({ id: 'nod_home', name: 'home', zone: 'home', roles: ['compute', 'data', 'build'], labels: { tier: 'bulk' }, volumeClasses: ['bulk', 'remote'], sliceMemoryMb: 4096 });

	const base = {
		runtime: 'process' as const,
		requested: 'auto',
		memoryMb: 128,
		edgeNodeId: edge.id,
		candidates: [edge, cloud, home],
	};

	test('restricts to a zone', () => {
		const decision = resolvePlacement({ ...base, spec: { zone: 'home' } });
		expect(decision).toMatchObject({ ok: true, nodeId: home.id });
	});

	test('requires every requested role', () => {
		const decision = resolvePlacement({ ...base, spec: { roles: ['build'] } });
		expect(decision).toMatchObject({ ok: true, nodeId: home.id });
	});

	test('matches labels including derived facts', () => {
		expect(resolvePlacement({ ...base, spec: { labels: { tier: 'critical' } } })).toMatchObject({ ok: true, nodeId: cloud.id });
		expect(resolvePlacement({ ...base, spec: { labels: { 'yoal.io/arch': 'arm64' } } })).toMatchObject({ ok: true, nodeId: edge.id });
	});

	test('requires a volume class', () => {
		expect(resolvePlacement({ ...base, spec: { volumeClass: 'fast' } })).toMatchObject({ ok: true, nodeId: cloud.id });
	});

	test('spread zones rejects a zone that already holds a replica', () => {
		expect(resolvePlacement({ ...base, spec: { spread: 'zone' }, replicaZones: ['cloud-b'] })).toMatchObject({
			ok: true,
			nodeId: home.id,
		});
	});

	test('near is a locality preference, not a hard filter', () => {
		expect(resolvePlacement({ ...base, spec: { near: 'db_1' }, nearNodeIds: [cloud.id] })).toMatchObject({
			ok: true,
			nodeId: cloud.id,
		});
	});

	test('names the first failing constraint per node', () => {
		const decision = resolvePlacement({ ...base, spec: { zone: 'nowhere' } });
		expect(decision.ok).toBe(false);
		if (!decision.ok) {
			expect(decision.message).toContain('matches the placement constraints');
			expect(decision.rejections?.map((row) => row.reason)).toContain('zone cloud-a is not nowhere');
		}
	});
});

describe('CPU admission', () => {
	const edge = node({ id: 'nod_edge', name: 'edge', mode: 'edge', cpuBudgetMillis: 2000, reservedCpuMillis: 0 });
	const cloud = node({ id: 'nod_cloud', name: 'cloud', cpuBudgetMillis: 2000, reservedCpuMillis: 1500 });
	const free = node({ id: 'nod_free', name: 'free', cpuBudgetMillis: null });
	const base = {
		runtime: 'process' as const,
		requested: 'auto',
		memoryMb: 128,
		edgeNodeId: edge.id,
		candidates: [edge, cloud, free],
	};

	test('refuses when the CPU reservation would exceed the node budget', () => {
		const decision = resolvePlacement({ ...base, spec: { node: cloud.id }, cpuMillis: 1000 });
		expect(decision.ok).toBe(false);
		if (!decision.ok) expect(decision.message).toContain('CPU budget');
	});

	test('admits when the request fits', () => {
		expect(resolvePlacement({ ...base, spec: { node: cloud.id }, cpuMillis: 500 })).toMatchObject({
			ok: true,
			nodeId: cloud.id,
		});
	});

	test('an uncapped node ignores CPU admission', () => {
		expect(resolvePlacement({ ...base, spec: { node: free.id }, cpuMillis: 9000 })).toMatchObject({
			ok: true,
			nodeId: free.id,
		});
	});
});
