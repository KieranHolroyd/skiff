import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { diskCandidates, deriveTier } from './disks.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-disks-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.parse('2026-11-08T10:00:00Z');
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
const DATA_UUID = '0b6f1c2e-6a1f-4b53-9a3e-1f0c2d3e4f50';
const ROOT_UUID = '11111111-2222-3333-4444-555555555555';

type Mount = {
	sourceKey: string;
	mountPath: string;
	kind?: 'filesystem' | 'nfs' | 'zfs';
	fsType?: string;
	device: string;
	size: number;
	free: number;
	rotational?: boolean | null;
};
type Device = {
	name: string;
	type: string;
	parent?: string;
	fsType?: string;
	uuid?: string;
	label?: string;
	mountPath?: string;
	holders?: string[];
	rotational?: boolean | null;
	model?: string;
};

function inventory(mounts: Mount[], devices: Device[] = []) {
	return {
		generatedAt: new Date(clock).toISOString(),
		mounts: mounts.map((mount) => ({
			sourceKey: mount.sourceKey,
			kind: mount.kind ?? 'filesystem',
			fsType: mount.fsType ?? (mount.kind === 'nfs' ? 'nfs4' : mount.kind === 'zfs' ? 'zfs' : 'ext4'),
			mountPath: mount.mountPath,
			device: mount.device,
			label: null,
			sizeBytes: mount.size,
			freeBytes: mount.free,
			remote: mount.kind === 'nfs',
			rotational: mount.rotational ?? null,
		})),
		devices: devices.map((device) => ({
			id: `dev:${device.name}`,
			name: `/dev/${device.name}`,
			type: device.type,
			parent: device.parent ?? null,
			model: device.model ?? null,
			serial: null,
			sizeBytes: 2 * TB,
			fsType: device.fsType ?? null,
			uuid: device.uuid ?? null,
			label: device.label ?? null,
			mountPath: device.mountPath ?? null,
			holders: device.holders ?? [],
			rotational: device.rotational ?? null,
			free: !device.fsType && !device.mountPath && !device.holders?.length,
		})),
	};
}

function heartbeat(node: { nodeId: string; token: string }, extra: Record<string, unknown> = {}) {
	core.nodes.heartbeat(node.token, {
		nodeId: node.nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		workloads: [],
		capabilities: ['disk-mounts', 'volume-profiles'],
		stats: { diskFreeBytes: 50_000_000_000, diskTotalBytes: 100_000_000_000 },
		...extra,
	} as Parameters<typeof core.nodes.heartbeat>[1]);
}

function enrol(name: string, mounts: Mount[], devices: Device[] = []) {
	const node = core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
	heartbeat(node, { volumes: inventory(mounts, devices) });
	return node;
}

const nodeView = (nodeId: string) => core.disks.overview(admin).nodes.find((node) => node.id === nodeId)!;

describe('candidates', () => {
	const devices: Device[] = [
		{ name: 'nvme0n1', type: 'disk', model: 'Samsung 990', holders: ['nvme0n1p1'], rotational: false },
		{ name: 'nvme0n1p1', type: 'part', parent: 'nvme0n1', fsType: 'ext4', uuid: ROOT_UUID, mountPath: '/' },
		{ name: 'sda', type: 'disk', model: 'WD Red', holders: ['sda1'], rotational: true },
		{ name: 'sda1', type: 'part', parent: 'sda', fsType: 'ext4', uuid: DATA_UUID, label: 'Bulk Data' },
		{ name: 'sdb', type: 'disk', model: 'Seagate', rotational: true },
		{ name: 'sdc1', type: 'part', fsType: 'LVM2_member', uuid: 'aaaa-bbbb' },
		{ name: 'sdd1', type: 'part', fsType: 'ntfs', uuid: 'CAFE1234' },
		{ name: 'zram0', type: 'disk' },
	];

	test('lists usable disks first with one key each, and folds the rest with a reason', () => {
		const list = diskCandidates({
			inventory: inventory([{ sourceKey: 'zfs:tank/media', mountPath: '/mnt/tank', kind: 'zfs', device: 'tank/media', size: TB, free: TB }], devices),
			disks: [],
			canMount: true,
		});
		const usable = list.filter((item) => item.usable);
		expect(usable.map((item) => [item.key, item.needsMount, item.suggestedName, item.suggestedTier])).toEqual([
			[`uuid:${DATA_UUID}`, true, 'bulk-data', 'bulk'],
			['mount:zfs:tank/media', false, 'tank', 'bulk'],
		]);
		const reasons = Object.fromEntries(list.filter((item) => !item.usable).map((item) => [item.device, item.reason]));
		expect(reasons['/dev/nvme0n1p1']).toContain('operating system');
		expect(reasons['/dev/sdb']).toContain('does not format');
		expect(reasons['/dev/sdc1']).toContain('LVM');
		expect(reasons['/dev/sdd1']).toContain('ntfs');
		expect(reasons['/dev/zram0']).toBeUndefined();
		expect(list.some((item) => item.device === '/dev/nvme0n1')).toBe(false);
	});

	test('an agent that cannot mount offers mounted filesystems only', () => {
		const list = diskCandidates({ inventory: inventory([], devices), disks: [], canMount: false });
		expect(list.find((item) => item.device === '/dev/sda1')).toMatchObject({ usable: false, reason: expect.stringContaining('Update the node') });
	});

	test('derives the tier from rotation, then NVMe, and treats shares as bulk', () => {
		expect(deriveTier({ remote: false, kind: 'filesystem', device: '/dev/sda1', sourceKey: 'fs:a', rotational: false })).toBe('fast');
		expect(deriveTier({ remote: false, kind: 'filesystem', device: '/dev/nvme0n1p1', sourceKey: 'fs:a', rotational: null })).toBe('fast');
		expect(deriveTier({ remote: false, kind: 'filesystem', device: '/dev/sda1', sourceKey: 'fs:a', rotational: null })).toBe('bulk');
		expect(deriveTier({ remote: true, kind: 'nfs', device: 'nas:/x', sourceKey: 'nfs:nas:/x', rotational: false })).toBe('bulk');
	});
});

describe('disks', () => {
	const edge = enrol('edge', [
		{ sourceKey: 'fs:edge-nvme', mountPath: '/mnt/nvme', device: '/dev/nvme0n1p1', size: TB, free: TB / 2 },
	]);
	const lab = enrol(
		'homelab',
		[
			{ sourceKey: 'fs:lab-ssd', mountPath: '/mnt/cache', device: '/dev/sdx1', size: TB, free: 0.8 * TB, rotational: false },
			{ sourceKey: 'fs:lab-hdd1', mountPath: '/mnt/disk1', device: '/dev/sda1', size: 8 * TB, free: 2 * TB, rotational: true },
			{ sourceKey: 'fs:lab-hdd2', mountPath: '/mnt/disk2', device: '/dev/sdb1', size: 8 * TB, free: 6 * TB, rotational: true },
		],
		[
			{ name: 'sdc', type: 'disk', holders: ['sdc1'], rotational: true },
			{ name: 'sdc1', type: 'part', parent: 'sdc', fsType: 'xfs', uuid: DATA_UUID, label: 'archive' },
		],
	);
	const add = (node: string, candidate: string, extra: { name?: string; tier?: 'fast' | 'bulk' } = {}) =>
		core.disks.add(admin, { node, candidate, ...extra });

	test('starts with nothing configured: every kind on the system disk', () => {
		const overview = core.disks.overview(admin);
		expect(overview.onboarding).toBe('pending');
		expect(overview.defaults.every((item) => item.target === 'system' && !item.configured)).toBe(true);
		// Usable first, then by device: sda1, sdb1, sdc1 (unmounted), sdx1.
		expect(nodeView(lab.nodeId).candidates.filter((item) => item.usable).map((item) => item.key)).toEqual([
			'mount:fs:lab-hdd1',
			'mount:fs:lab-hdd2',
			`uuid:${DATA_UUID}`,
			'mount:fs:lab-ssd',
		]);
		expect(() => core.disks.overview(member)).toThrow(/storage:read/);
		expect(() => core.disks.add(member, { node: 'homelab', candidate: 'mount:fs:lab-ssd' })).toThrow(/storage:create/);
	});

	test('Use this disk registers a mounted filesystem at once, with a derived tier', () => {
		expect(add('edge', 'mount:fs:edge-nvme')).toMatchObject({ name: 'nvme', tier: 'fast', tierSet: false, status: 'ready', mountedByYoal: false });
		expect(add('homelab', 'mount:fs:lab-ssd')).toMatchObject({ name: 'cache', tier: 'fast' });
		expect(add('homelab', 'mount:fs:lab-hdd1', { name: 'disk1' })).toMatchObject({ tier: 'bulk' });
		expect(add('homelab', 'mount:fs:lab-hdd2', { name: 'disk2' }).tier).toBe('bulk');
		expect(() => add('homelab', 'mount:fs:lab-hdd2')).toThrow(/does not report/);
		expect(() => add('homelab', 'mount:fs:nope')).toThrow(/does not report/);
		expect(() => core.disks.add(admin, { node: 'homelab', candidate: `uuid:${DATA_UUID}`, name: 'fast' })).toThrow();
		expect(() => add('homelab', `uuid:${DATA_UUID}`, { name: 'cache' })).toThrow(/already exists/);
		const overview = core.disks.overview(admin);
		expect(overview.tiers.fast.disks).toBe(2);
		expect(overview.tiers.bulk.sizeBytes).toBe(16 * TB);
	});

	test('an unmounted filesystem is mounted by UUID, then turns ready; removing unmounts it', async () => {
		const disk = add('homelab', `uuid:${DATA_UUID}`);
		expect(disk).toMatchObject({ name: 'archive', status: 'pending', mountedByYoal: true, mountPath: '/mnt/yoal-disks/archive', tier: 'bulk' });
		let desired = await core.nodes.desiredState(lab.token);
		expect(desired.diskMounts).toEqual([{ id: disk.id, name: 'archive', fsUuid: DATA_UUID, fsType: 'xfs' }]);
		expect(JSON.stringify(desired.diskMounts)).not.toContain('/dev/');

		heartbeat(lab, { diskMounts: [{ id: disk.id, mounted: false, error: 'wrong fs type, bad superblock' }] });
		expect(core.disks.byId(disk.id)).toMatchObject({ status: 'failed', message: 'wrong fs type, bad superblock' });

		// Mounted: the inventory shows the UUID at its path (btrfs-style key suffixes are accepted).
		heartbeat(lab, {
			diskMounts: [{ id: disk.id, mounted: true, error: null }],
			volumes: inventory([
				{ sourceKey: 'fs:lab-ssd', mountPath: '/mnt/cache', device: '/dev/sdx1', size: TB, free: 0.8 * TB, rotational: false },
				{ sourceKey: 'fs:lab-hdd1', mountPath: '/mnt/disk1', device: '/dev/sda1', size: 8 * TB, free: 2 * TB, rotational: true },
				{ sourceKey: 'fs:lab-hdd2', mountPath: '/mnt/disk2', device: '/dev/sdb1', size: 8 * TB, free: 6 * TB, rotational: true },
				{ sourceKey: `fs:${DATA_UUID}`, mountPath: '/mnt/yoal-disks/archive', fsType: 'xfs', device: '/dev/sdc1', size: 2 * TB, free: 2 * TB, rotational: true },
			]),
		});
		expect(core.disks.byId(disk.id)).toMatchObject({ status: 'ready', message: null, freeBytes: 2 * TB });
		expect(nodeView(lab.nodeId).candidates.some((item) => item.key === `uuid:${DATA_UUID}`)).toBe(false);

		// Renaming keeps the mount directory.
		core.disks.update(admin, disk.id, { name: 'cold' });
		desired = await core.nodes.desiredState(lab.token);
		expect(desired.diskMounts).toEqual([{ id: disk.id, name: 'archive', fsUuid: DATA_UUID, fsType: 'xfs' }]);

		expect(core.disks.remove(admin, disk.id)).toEqual({ ok: true, unmounting: true });
		desired = await core.nodes.desiredState(lab.token);
		expect(desired.diskMounts).toEqual([]);
		expect(desired.diskUnmounts).toEqual([{ id: disk.id, name: 'archive' }]);
		expect(desired.volumes.some((entry) => entry.id === disk.id)).toBe(false);
		heartbeat(lab, { unmountedDisks: [disk.id] });
		expect(core.disks.byId(disk.id)).toBeNull();
	});

	test('defaults pick a tier; placement only uses nodes with room on it and never another tier', () => {
		core.disks.setDefaults(admin, {
			defaults: [
				{ kind: 'databases', target: 'fast' },
				{ kind: 'object-storage', target: 'bulk' },
				{ kind: 'builds', target: 'bulk' },
			],
		});
		// Both nodes have a fast disk, so placement picks the node; the disk is that node's fast one.
		const db = core.databases.create(admin, { name: 'orders', memoryMb: 128, storageMb: 1024, placement: edge.nodeId });
		expect(db.disk).toMatchObject({ name: 'nvme', tier: 'fast' });
		expect(core.databases.create(admin, { name: 'events', memoryMb: 128, placement: lab.nodeId }).disk).toMatchObject({ name: 'cache' });
		// Only homelab has bulk disks, so placement is narrowed to it; the most-free one wins.
		const bucket = core.storage.create(admin, { name: 'media-store', memoryMb: 256, storageMb: 1024 });
		expect(bucket.disk).toMatchObject({ name: 'disk2', tier: 'bulk' });

		expect(core.databases.create(admin, { name: 'scratch', memoryMb: 128, storage: 'system' }).disk).toBeNull();
		const onCache = core.databases.create(admin, { name: 'on-cache', memoryMb: 128, storage: 'cache' });
		expect(onCache).toMatchObject({ nodeId: lab.nodeId, disk: { name: 'cache' } });
		expect(() => core.databases.create(admin, { name: 'pinned', memoryMb: 128, storage: 'bulk', placement: edge.nodeId })).toThrow(
			/edge cannot hold this on bulk disks: no bulk disk/,
		);
		expect(() => core.databases.create(admin, { name: 'wrong', memoryMb: 128, storage: 'cache', placement: edge.nodeId })).toThrow(
			/another node/,
		);
		expect(() => core.databases.create(admin, { name: 'huge', memoryMb: 128, storageMb: 1_000_000, storage: 'fast' })).toThrow(
			/No node can hold this on fast disks/,
		);
		expect(() => core.databases.create(admin, { name: 'ghost', memoryMb: 128, storage: 'nope' })).toThrow(/Disk "nope"/);

		// Choices for create forms: the default and which tiers exist; no paths or nodes.
		expect(core.disks.choices('databases')).toMatchObject({ defaultTarget: 'fast' });
		expect(core.disks.choices('databases').targets.map((item) => [item.value, item.available])).toEqual([
			['system', true],
			['fast', true],
			['bulk', true],
		]);
	});

	test('node-level kinds use a local disk of the tier, else the install default', async () => {
		expect(core.disks.nodeDirectory('builds', lab.nodeId)).toBe(`/mnt/disk2/yoal/node/${lab.nodeId}/builds`);
		expect(core.disks.nodeDirectory('builds', edge.nodeId)).toBeNull();
		expect(core.disks.nodeDirectory('site-data', lab.nodeId)).toBeNull();
		expect((await core.nodes.desiredState(lab.token)).storage).toMatchObject({
			buildDir: `/mnt/disk2/yoal/node/${lab.nodeId}/builds`,
		});
	});

	test('a disk that holds something cannot be removed; one that holds nothing can', () => {
		const nvme = nodeView(edge.nodeId).disks.find((disk) => disk.name === 'nvme')!;
		expect(nvme.holds).toEqual(['database orders']);
		expect(() => core.disks.remove(admin, nvme.id)).toThrow(/still holds database orders/);
		const disk2 = nodeView(lab.nodeId).disks.find((disk) => disk.name === 'disk2')!;
		expect(disk2.holds).toEqual(['object storage media-store', "the node's builds"]);
		const disk1 = nodeView(lab.nodeId).disks.find((disk) => disk.name === 'disk1')!;
		expect(core.disks.remove(admin, disk1.id)).toEqual({ ok: true, unmounting: false });
		expect(core.disks.byId(disk1.id)).toBeNull();
	});

	test('an operator tier sticks across reports; a vanished mount is missing', () => {
		const cache = nodeView(lab.nodeId).disks.find((disk) => disk.name === 'cache')!;
		core.disks.update(admin, cache.id, { tier: 'bulk' });
		heartbeat(lab, {
			volumes: inventory([
				{ sourceKey: 'fs:lab-ssd', mountPath: '/mnt/cache', device: '/dev/sdx1', size: TB, free: 0.7 * TB, rotational: false },
			]),
		});
		expect(core.disks.byId(cache.id)).toMatchObject({ tier: 'bulk', tierSet: true, status: 'ready', freeBytes: 0.7 * TB });
		const disk2 = nodeView(lab.nodeId).disks.find((disk) => disk.name === 'disk2')!;
		expect(disk2).toMatchObject({ status: 'missing' });
		expect(core.disks.overview(admin).defaults.find((item) => item.kind === 'databases')!.warnings).toEqual([]);
	});

	test('profiles a disk on a capable node and stores the result once', async () => {
		const nvme = nodeView(edge.nodeId).disks.find((disk) => disk.name === 'nvme')!;
		expect(core.disks.profile(admin, nvme.id)).toEqual({ queued: true });
		expect(() => core.disks.profile(admin, nvme.id)).toThrow(/already being profiled/);
		const [task] = (await core.nodes.desiredState(edge.token)).volumeProfileTasks;
		expect(task).toMatchObject({ volumeId: nvme.id, sizeMb: 512 });
		const result = {
			taskId: task!.id,
			status: 'succeeded',
			method: 'fio',
			seqReadMBps: 3000,
			seqWriteMBps: 2500,
			randReadIops: 400000.4,
			randWriteIops: 300000,
			syncWriteIops: 20000,
			syncWriteLatencyUs: 50,
			direct: true,
			notes: [],
			error: null,
		};
		heartbeat(edge, { volumeProfileResults: [result] });
		heartbeat(edge, { volumeProfileResults: [{ ...result, seqReadMBps: 1 }] });
		expect(nodeView(edge.nodeId).disks.find((disk) => disk.name === 'nvme')!.profile).toMatchObject({
			status: 'succeeded',
			seqReadMBps: 3000,
			randReadIops: 400000,
		});
		expect((await core.nodes.desiredState(edge.token)).volumeProfileTasks).toEqual([]);
	});

	test('onboarding is recorded', () => {
		core.disks.setOnboarding(admin, { state: 'done' });
		expect(core.disks.onboardingState()).toBe('done');
	});
});
