import { describe, expect, test } from 'bun:test';
import type { NodeView } from '@skiff/core';
import { summariseResources } from './resources.js';

const GB = 1024 ** 3;

// Fixtures carry only the fields the summariser reads.
const node = (over: Partial<NodeView>) =>
	({
		id: 'n1',
		name: 'edge',
		status: 'online',
		hardware: null,
		stats: {},
		...over
	}) as NodeView;

const stats = (
	cpu: number,
	memUsed: number,
	memTotal: number,
	diskUsed: number,
	diskTotal: number
) => ({
	cpuPercent: cpu,
	memoryBytes: memUsed * GB,
	memoryTotalBytes: memTotal * GB,
	diskUsedBytes: diskUsed * GB,
	diskTotalBytes: diskTotal * GB,
	load1: 0.5,
	uptimeSeconds: 3_600
});

describe('summariseResources', () => {
	test('a single node reports its own figures and no hotspots', () => {
		const { fleet } = summariseResources([
			node({ stats: stats(40, 2, 8, 30, 100), hardware: { threads: 4 } as NodeView['hardware'] })
		]);
		expect(fleet.reporting).toBe(1);
		expect(fleet.cpuPercent).toBe(40);
		expect(fleet.cpus).toBe(4);
		expect(fleet.memoryUsedBytes).toBe(2 * GB);
		expect(fleet.memoryTotalBytes).toBe(8 * GB);
		expect(fleet.diskTotalBytes).toBe(100 * GB);
		expect(fleet.busiest).toEqual({ cpu: null, memory: null, disk: null });
	});

	test('CPU is weighted by logical CPUs and totals are summed', () => {
		const { fleet } = summariseResources([
			node({
				id: 'a',
				name: 'small',
				stats: stats(100, 1, 2, 10, 20),
				hardware: { threads: 2 } as NodeView['hardware']
			}),
			node({
				id: 'b',
				name: 'big',
				stats: stats(10, 4, 30, 5, 80),
				hardware: { threads: 6 } as NodeView['hardware']
			})
		]);
		expect(fleet.cpuPercent).toBeCloseTo((100 * 2 + 10 * 6) / 8);
		expect(fleet.cpus).toBe(8);
		expect(fleet.load1).toBe(1);
		expect(fleet.memoryTotalBytes).toBe(32 * GB);
		expect(fleet.busiest.cpu).toEqual({ name: 'small', pct: 100 });
		expect(fleet.busiest.memory?.name).toBe('small');
		expect(fleet.busiest.disk?.name).toBe('small');
	});

	test('falls back to a plain average when a node has no hardware report', () => {
		const { fleet } = summariseResources([
			node({
				id: 'a',
				stats: stats(20, 1, 2, 1, 2),
				hardware: { threads: 8 } as NodeView['hardware']
			}),
			node({ id: 'b', stats: stats(60, 1, 2, 1, 2) })
		]);
		expect(fleet.cpuPercent).toBe(40);
		expect(fleet.cpus).toBeNull();
	});

	test('offline and silent nodes are left out', () => {
		const { fleet, nodes } = summariseResources([
			node({ id: 'a', stats: stats(50, 1, 4, 1, 10) }),
			node({ id: 'b', status: 'offline', stats: stats(99, 4, 4, 10, 10) }),
			node({ id: 'c', stats: null })
		]);
		expect(nodes).toHaveLength(3);
		expect(fleet.online).toBe(2);
		expect(fleet.reporting).toBe(1);
		expect(fleet.cpuPercent).toBe(50);
		expect(fleet.memoryTotalBytes).toBe(4 * GB);
	});

	test('no reporting nodes gives nulls, not zeros', () => {
		const { fleet } = summariseResources([node({ status: 'offline' })]);
		expect(fleet.reporting).toBe(0);
		expect(fleet.cpuPercent).toBeNull();
		expect(fleet.memoryTotalBytes).toBeNull();
		expect(fleet.uptimeSeconds).toBeNull();
	});
});
