import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-storage-pools-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-07T10:00:00Z');
const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES, SERVICE_ENDPOINTS: false },
	},
});
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const TB = 1_000_000_000_000;
type Mount = { sourceKey: string; mountPath: string; kind: 'filesystem' | 'nfs'; device: string; size: number; free: number };

function enrol(name: string, mounts: Mount[]) {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		workloads: [],
		stats: { diskFreeBytes: 50_000_000_000, diskTotalBytes: 100_000_000_000 },
		volumes: {
			generatedAt: new Date(clock).toISOString(),
			mounts: mounts.map((mount) => ({
				sourceKey: mount.sourceKey,
				kind: mount.kind,
				fsType: mount.kind === 'nfs' ? 'nfs4' : 'ext4',
				mountPath: mount.mountPath,
				device: mount.device,
				label: null,
				sizeBytes: mount.size,
				freeBytes: mount.free,
				remote: mount.kind === 'nfs',
			})),
			devices: [],
		},
	} as Parameters<typeof core.nodes.heartbeat>[1]);
	return node;
}

describe('storage pools', () => {
	const edge = enrol('edge', [
		{ sourceKey: 'fs:edge-nvme', mountPath: '/mnt/nvme', kind: 'filesystem', device: '/dev/nvme0n1p1', size: TB, free: TB / 2 },
	]);
	const worker = enrol('homelab', [
		{ sourceKey: 'fs:lab-nvme', mountPath: '/mnt/cache', kind: 'filesystem', device: '/dev/nvme1n1p1', size: TB, free: 0.8 * TB },
		{ sourceKey: 'fs:lab-hdd1', mountPath: '/mnt/disk1', kind: 'filesystem', device: '/dev/sda1', size: 8 * TB, free: 2 * TB },
		{ sourceKey: 'fs:lab-hdd2', mountPath: '/mnt/disk2', kind: 'filesystem', device: '/dev/sdb1', size: 8 * TB, free: 6 * TB },
		{ sourceKey: 'nfs:nas:/export/media', mountPath: '/mnt/skiff-shares/media', kind: 'nfs', device: 'nas:/export/media', size: 20 * TB, free: 10 * TB },
	]);

	test('starts pending with every kind on the system disk, and shows what nodes offer', () => {
		const overview = core.storagePools.overview(admin);
		expect(overview.onboarding).toBe('pending');
		expect(overview.pools).toEqual([]);
		expect(overview.defaults.map((item) => [item.kind, item.pool, item.configured])).toEqual([
			['databases', 'system', false],
			['object-storage', 'system', false],
			['brokers', 'system', false],
			['app-volumes', 'system', false],
			['builds', 'system', false],
			['site-data', 'system', false],
		]);
		expect(overview.nodes.find((node) => node.name === 'homelab')!.adoptable.map((mount) => mount.mountPath)).toEqual([
			'/mnt/cache',
			'/mnt/disk1',
			'/mnt/disk2',
			'/mnt/skiff-shares/media',
		]);
		expect(() => core.storagePools.overview(member)).toThrow(/Platform admin/);
	});

	test('groups volumes into pools, routes kinds to them and refuses what cannot fit', async () => {
		const adopt = (nodeId: string, name: string, sourceKey: string) => core.volumes.adopt(admin, nodeId, { name, sourceKey }).id;
		const edgeNvme = adopt(edge.nodeId, 'nvme', 'fs:edge-nvme');
		const labNvme = adopt(worker.nodeId, 'cache', 'fs:lab-nvme');
		const hdd1 = adopt(worker.nodeId, 'disk1', 'fs:lab-hdd1');
		const hdd2 = adopt(worker.nodeId, 'disk2', 'fs:lab-hdd2');
		const nas = adopt(worker.nodeId, 'media', 'nfs:nas:/export/media');

		const ssd = core.storagePools.createPool(admin, { name: 'ssd', volumes: [edgeNvme, labNvme] });
		expect(ssd).toMatchObject({ name: 'ssd', allocation: 'most-free', minFreePercent: 10, classes: ['fast'] });
		expect(ssd.members.map((m) => `${m.nodeName}/${m.volumeName}`)).toEqual(['edge/nvme', 'homelab/cache']);
		const hdd = core.storagePools.createPool(admin, { name: 'hdd', allocation: 'fill-up', volumes: [hdd1, hdd2] });
		expect(hdd.sizeBytes).toBe(16 * TB);
		core.storagePools.createPool(admin, { name: 'nas', volumes: [nas] });
		expect(() => core.storagePools.createPool(admin, { name: 'system' })).toThrow(/built-in/);
		expect(() => core.storagePools.createPool(admin, { name: 'ssd' })).toThrow(/already exists/);

		const defaults = core.storagePools.setDefaults(admin, {
			defaults: [
				{ kind: 'databases', pool: 'ssd' },
				{ kind: 'object-storage', pool: 'hdd' },
				{ kind: 'app-volumes', pool: 'ssd' },
				{ kind: 'builds', pool: 'hdd' },
				{ kind: 'site-data', pool: 'nas' },
			],
		});
		expect(defaults.find((item) => item.kind === 'object-storage')).toMatchObject({ pool: 'hdd', configured: true });
		expect(defaults.find((item) => item.kind === 'brokers')).toMatchObject({ pool: 'system', configured: false });
		expect(defaults.find((item) => item.kind === 'site-data')!.warnings.join(' ')).toContain('only has network volumes');
		expect(core.storagePools.choices('databases')).toMatchObject({ defaultPool: 'ssd' });

		// A database without a choice gets the ssd default; placement picks the node, the pool picks the volume.
		const db = core.databases.create(admin, { name: 'orders', memoryMb: 128, storageMb: 1024 });
		expect(db.volume?.name).toMatch(/^(nvme|cache)$/);

		// Object storage needs the hdd pool, which only homelab has; fill-up takes the fuller disk.
		const bucket = core.storage.create(admin, { name: 'media-store', memoryMb: 256, storageMb: 1024 });
		expect(bucket.volume?.name).toBe('disk1');

		// Choosing a pool at creation overrides the default; the system pool is always available.
		expect(core.databases.create(admin, { name: 'scratch', memoryMb: 128, pool: 'system' }).volume).toBeNull();
		expect(() => core.databases.create(admin, { name: 'pinned', memoryMb: 128, pool: 'hdd', placement: edge.nodeId })).toThrow(
			/edge cannot hold this under storage pool "hdd": no hdd volume/,
		);
		expect(() => core.databases.create(admin, { name: 'huge', memoryMb: 128, storageMb: 1_000_000, pool: 'ssd' })).toThrow(
			/below 10% free/,
		);

		// Node-level kinds: builds use the local hdd pool; site data skips the network-only pool.
		expect(core.storagePools.nodeDirectory('builds', worker.nodeId)).toBe(`/mnt/disk1/skiff/node/${worker.nodeId}/builds`);
		expect(core.storagePools.nodeDirectory('builds', edge.nodeId)).toBeNull();
		expect(core.storagePools.nodeDirectory('site-data', worker.nodeId)).toBeNull();
		expect((await core.nodes.desiredState(worker.token)).storage).toEqual({
			dataDir: null,
			buildDir: `/mnt/disk1/skiff/node/${worker.nodeId}/builds`,
		});
		expect(() => core.volumes.remove(admin, worker.nodeId, 'disk1')).toThrow(/builds/);

		// Default pools cannot be deleted; moving a volume out never touches placed data.
		expect(() => core.storagePools.deletePool(admin, 'hdd')).toThrow(/object storage, builds default/);
		core.storagePools.setVolumePool(admin, nas, null);
		expect(core.storagePools.overview(admin).pools.find((pool) => pool.name === 'nas')!.members).toEqual([]);
		expect(() => core.storagePools.deletePool(admin, 'nas')).toThrow(/site data default/);
		core.storagePools.setDefaults(admin, { defaults: [{ kind: 'site-data', pool: 'system' }] });
		expect(core.storagePools.deletePool(admin, 'nas')).toEqual({ ok: true });
	});

	test('onboarding is recorded', () => {
		expect(core.storagePools.setOnboarding(admin, { state: 'done' })).toEqual({ onboarding: 'done' });
		expect(core.storagePools.overview(admin).onboarding).toBe('done');
		expect(() => core.storagePools.setOnboarding(member, { state: 'skipped' })).toThrow(/Platform admin/);
	});

	test('profiles a pool on capable nodes and stores the results once', async () => {
		const overview = core.storagePools.overview(admin);
		const ssd = overview.pools.find((pool) => pool.name === 'ssd')!;
		// Neither node has declared the capability yet.
		expect(() => core.storagePools.profilePool(admin, 'ssd')).toThrow(/cannot profile yet/);
		core.nodes.heartbeat(worker.token, {
			nodeId: worker.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [],
			capabilities: ['volume-profiles'],
		} as Parameters<typeof core.nodes.heartbeat>[1]);

		const queued = core.storagePools.profilePool(admin, 'ssd');
		expect(queued.queued).toEqual(['cache']);
		expect(queued.skipped).toEqual([{ volume: 'nvme', reason: 'is on a node whose agent cannot profile yet; update it' }]);
		expect(() => core.storagePools.profilePool(admin, 'ssd')).toThrow(/already being profiled/);
		expect(() => core.storagePools.profilePool(member, 'ssd')).toThrow(/Platform admin/);

		const tasks = (await core.nodes.desiredState(worker.token)).volumeProfileTasks;
		const cacheId = ssd.members.find((m) => m.volumeName === 'cache')!.volumeId;
		expect(tasks).toEqual([{ id: tasks[0]!.id, volumeId: cacheId, sizeMb: 512, runtimeSeconds: 10 }]);
		expect((await core.nodes.desiredState(edge.token)).volumeProfileTasks).toEqual([]);

		const report = (result: Record<string, unknown>) =>
			core.nodes.heartbeat(worker.token, {
				nodeId: worker.nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 1,
				status: 'online',
				caddyOk: true,
				releases: [],
				workloads: [],
				capabilities: ['volume-profiles'],
				volumeProfileResults: [{ taskId: tasks[0]!.id, ...result }],
			} as unknown as Parameters<typeof core.nodes.heartbeat>[1]);
		report({ status: 'running' });
		expect(core.storagePools.overview(admin).pools.find((pool) => pool.name === 'ssd')!.profiling).toBe(true);
		report({
			status: 'succeeded',
			method: 'fio',
			seqReadMBps: 3100.5,
			seqWriteMBps: 2800,
			randReadIops: 410000,
			randWriteIops: 350000,
			syncWriteIops: 9000,
			syncWriteLatencyUs: 111,
			direct: true,
		});
		const after = core.storagePools.overview(admin).pools.find((pool) => pool.name === 'ssd')!;
		expect(after.profiling).toBe(false);
		expect(after.members.find((m) => m.volumeName === 'cache')!.profile).toMatchObject({
			status: 'succeeded',
			method: 'fio',
			seqReadMBps: 3100.5,
			randReadIops: 410000,
			syncWriteLatencyUs: 111,
		});
		expect((await core.nodes.desiredState(worker.token)).volumeProfileTasks).toEqual([]);
		// A late duplicate report changes nothing.
		report({ status: 'failed', error: 'late' });
		expect(core.storagePools.overview(admin).pools.find((pool) => pool.name === 'ssd')!.members.find((m) => m.volumeName === 'cache')!.profile!.status).toBe('succeeded');
	});
});
