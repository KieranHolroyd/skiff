import { describe, expect, test } from 'bun:test';
import { nodeStorageSchema, storageNeedsApply, storagePathProblem, type NodeStorageStatus } from './storage.ts';

describe('storage paths', () => {
	test('accepts directories on other disks', () => {
		for (const path of ['/mnt/data/skiff', '/srv/skiff-cache', '/data/skiff/agent', '/var/lib/skiff/agent', '/var/lib/skiff-agent2'])
			expect(storagePathProblem(path)).toBeNull();
	});

	test('rejects system trees, other Skiff state and broad mount roots', () => {
		for (const path of ['/', '/etc/skiff', '/usr/local/x', '/home/kieran/skiff', '/tmp/x', '/run/skiff/x', '/opt/skiff/data', '/var/lib/skiff', '/var/lib/skiff/data/x', '/mnt', '/var/lib'])
			expect(storagePathProblem(path)).not.toBeNull();
	});

	test('rejects relative, unnormalized and odd paths', () => {
		for (const path of ['data/skiff', '/mnt/data/', '/mnt//data', '/mnt/./x', '/mnt/../etc', '/mnt/da ta', '/mnt/$x'])
			expect(storagePathProblem(path)).not.toBeNull();
	});

	test('schema defaults to the install paths (null)', () => {
		expect(nodeStorageSchema.parse({})).toEqual({ dataDir: null, buildDir: null });
		expect(nodeStorageSchema.safeParse({ dataDir: '/etc/x' }).success).toBe(false);
	});

	test('a move is due until the node applied exactly this request; a failure is not retried', () => {
		const status = (overrides: Partial<NodeStorageStatus>): NodeStorageStatus => ({
			requested: { dataDir: '/mnt/a', buildDir: null },
			dataDir: '/mnt/a',
			buildDir: '/var/lib/skiff-builder',
			status: 'applied',
			message: null,
			updatedAt: new Date().toISOString(),
			...overrides,
		});
		expect(storageNeedsApply({ dataDir: null, buildDir: null }, null)).toBe(false);
		expect(storageNeedsApply({ dataDir: '/mnt/a', buildDir: null }, null)).toBe(true);
		expect(storageNeedsApply({ dataDir: '/mnt/a', buildDir: null }, status({}))).toBe(false);
		expect(storageNeedsApply({ dataDir: '/mnt/b', buildDir: null }, status({}))).toBe(true);
		expect(storageNeedsApply({ dataDir: '/mnt/a', buildDir: null }, status({ status: 'failed' }))).toBe(false);
		expect(storageNeedsApply({ dataDir: '/mnt/a', buildDir: null }, status({ status: 'pending' }))).toBe(true);
	});
});
