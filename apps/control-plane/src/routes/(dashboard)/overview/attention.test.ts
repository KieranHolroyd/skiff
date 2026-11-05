import { describe, expect, test } from 'bun:test';
import type { BuildView, DatabaseView, DomainView, StorageView } from '@skiff/contracts';
import type { DeploymentView, NodeView } from '@skiff/core';
import { buildAttention, type AttentionInput } from './attention.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const GB = 1024 ** 3;

// Fixtures carry only the fields the rules read.
const node = (over: Partial<NodeView>) =>
	({
		id: 'n1',
		name: 'edge',
		status: 'online',
		lastHeartbeatAt: hoursAgo(0),
		stats: {},
		...over
	}) as NodeView;
const database = (over: Partial<DatabaseView>) =>
	({
		id: 'd1',
		name: 'app-db',
		nodeId: 'n1',
		status: 'running',
		message: null,
		sizeBytes: null,
		storageMb: 1024,
		backup: { lastBackupStatus: 'ok', lastBackupError: null },
		...over
	}) as DatabaseView;
const bucketStore = (over: Partial<StorageView>) =>
	({
		id: 's1',
		name: 'files',
		nodeId: 'n1',
		status: 'running',
		message: null,
		usedBytes: null,
		storageMb: 1024,
		...over
	}) as StorageView;
const deployment = (over: Partial<DeploymentView>) =>
	({
		id: 'dep1',
		projectSlug: 'site',
		status: 'active',
		message: null,
		createdAt: hoursAgo(1),
		...over
	}) as DeploymentView;
const build = (over: Partial<BuildView>) =>
	({
		id: 'b1',
		projectSlug: 'site',
		status: 'succeeded',
		error: null,
		createdAt: hoursAgo(1),
		finishedAt: hoursAgo(1),
		...over
	}) as BuildView;
const domain = (over: Partial<DomainView>) =>
	({
		id: 'dom1',
		projectSlug: 'site',
		hostname: 'example.com',
		status: 'active',
		lastError: null,
		...over
	}) as DomainView;

function run(over: Partial<AttentionInput>) {
	return buildAttention({
		now: NOW,
		nodes: [],
		databases: [],
		storage: [],
		deployments: [],
		builds: [],
		domains: [],
		quotaWarnings: [],
		...over
	});
}

describe('buildAttention', () => {
	test('a healthy fleet needs nothing', () => {
		expect(
			run({ nodes: [node({})], databases: [database({})], storage: [bucketStore({})] })
		).toEqual([]);
	});

	test('an offline node absorbs the services that run on it', () => {
		const items = run({
			nodes: [node({ status: 'offline' })],
			databases: [database({ status: 'failed' })],
			storage: [bucketStore({ status: 'failed' })]
		});
		expect(items.map((item) => item.id)).toEqual(['node:n1']);
		expect(items[0]!.detail).toContain('app-db, files run on it');
	});

	test('a failed service on a healthy node is reported on its own, linking to its logs', () => {
		const items = run({ nodes: [node({})], databases: [database({ status: 'failed' })] });
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ tone: 'danger', href: '/databases/app-db/logs' });
	});

	test('a failed deploy fixed by a later one is dropped', () => {
		const fixed = run({
			deployments: [
				deployment({ id: 'new' }),
				deployment({ id: 'old', status: 'failed', createdAt: hoursAgo(2) })
			]
		});
		expect(fixed).toEqual([]);
		const broken = run({ deployments: [deployment({ status: 'failed' })] });
		expect(broken.map((item) => item.kind)).toEqual(['deployment']);
	});

	test('failures older than a day are not news', () => {
		expect(
			run({
				builds: [build({ status: 'failed', createdAt: hoursAgo(30), finishedAt: hoursAgo(30) })]
			})
		).toEqual([]);
	});

	test('nearly full disks and databases warn', () => {
		const items = run({
			nodes: [node({ stats: { diskUsedBytes: 95, diskTotalBytes: 100 } })],
			databases: [database({ sizeBytes: 0.9 * GB })]
		});
		expect(items.map((item) => item.title)).toEqual([
			'edge is 95% full',
			'app-db is 90% of its storage'
		]);
	});

	test('problems sort before notes, and pending domains collapse into one note', () => {
		const items = run({
			domains: [
				domain({ id: 'a', status: 'pending' }),
				domain({ id: 'b', status: 'pending', hostname: 'b.com' })
			],
			quotaWarnings: [{ metric: 'projects', used: 10, limit: 10, percent: 100 }]
		});
		expect(items.map((item) => item.tone)).toEqual(['danger', 'info']);
		expect(items[0]!.title).toBe('Projects is at 100% of its limit');
		expect(items[1]!.title).toBe('2 domains are waiting for their DNS records');
	});
});
