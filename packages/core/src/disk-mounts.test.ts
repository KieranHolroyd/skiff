import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-disk-mounts-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.now();
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
	},
});
const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const DATA_UUID = '0b6f1c2e-6a1f-4b53-9a3e-1f0c2d3e4f50';
const EFI_UUID = 'ABCD-1234';
const ROOT_UUID = '11111111-2222-3333-4444-555555555555';
const MEDIA_UUID = '99999999-8888-7777-6666-555555555555';

type Device = {
	name: string;
	type: string;
	parent?: string | null;
	fsType?: string | null;
	uuid?: string | null;
	label?: string | null;
	mountPath?: string | null;
	holders?: string[];
	sizeBytes?: number;
	model?: string | null;
};

function inventory(input: { devices: Device[]; mounts?: Array<{ sourceKey: string; mountPath: string; fsType?: string }> }) {
	return {
		generatedAt: new Date(clock).toISOString(),
		mounts: (input.mounts ?? []).map((mount) => ({
			sourceKey: mount.sourceKey,
			kind: 'filesystem' as const,
			fsType: mount.fsType ?? 'ext4',
			mountPath: mount.mountPath,
			device: null,
			label: null,
			sizeBytes: 2_000_000_000_000,
			freeBytes: 1_500_000_000_000,
			remote: false,
		})),
		devices: input.devices.map((device) => ({
			id: `dev:${device.name}`,
			name: `/dev/${device.name}`,
			type: device.type,
			parent: device.parent ?? null,
			model: device.model ?? null,
			serial: null,
			sizeBytes: device.sizeBytes ?? 2_000_000_000_000,
			fsType: device.fsType ?? null,
			uuid: device.uuid ?? null,
			label: device.label ?? null,
			mountPath: device.mountPath ?? null,
			holders: device.holders ?? [],
			free: !device.fsType && !device.mountPath && !(device.holders?.length),
		})),
	};
}

const baseDevices = (data: Partial<Device> = {}): Device[] => [
	{ name: 'nvme0n1', type: 'disk', model: 'Samsung 990', holders: ['nvme0n1p1', 'nvme0n1p2'] },
	{ name: 'nvme0n1p1', type: 'part', parent: 'nvme0n1', fsType: 'vfat', uuid: EFI_UUID, mountPath: '/boot/efi' },
	{ name: 'nvme0n1p2', type: 'part', parent: 'nvme0n1', fsType: 'ext4', uuid: ROOT_UUID, mountPath: '/' },
	{ name: 'sda', type: 'disk', model: 'WD Red', holders: ['sda1'] },
	{ name: 'sda1', type: 'part', parent: 'sda', fsType: 'ext4', uuid: DATA_UUID, label: 'Bulk Data', ...data },
	{ name: 'sdb', type: 'disk', model: 'Seagate' },
	{ name: 'sdc', type: 'disk', holders: ['sdc1'] },
	{ name: 'sdc1', type: 'part', parent: 'sdc', fsType: 'LVM2_member', uuid: 'aaaa-bbbb' },
	{ name: 'sdd1', type: 'part', fsType: 'ntfs', uuid: 'CAFE1234' },
	{ name: 'sde1', type: 'part', fsType: 'xfs', uuid: MEDIA_UUID, mountPath: '/srv/media' },
];

describe('partition mounts', () => {
	const heartbeat = (node: { nodeId: string; token: string }, extra: Record<string, unknown> = {}, capabilities = ['disk-mounts']) =>
		core.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [],
			capabilities,
			...extra,
		} as Parameters<typeof core.nodes.heartbeat>[1]);
	const enrol = (name: string) => core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
	const partitions = (nodeId: string) => core.storagePools.overview(admin).nodes.find((node) => node.id === nodeId)!.partitions;

	test('lists every partition with what Add as volume would do', () => {
		const node = enrol('lister');
		heartbeat(node, {
			volumes: inventory({
				devices: baseDevices(),
				mounts: [{ sourceKey: `fs:${MEDIA_UUID}`, mountPath: '/srv/media', fsType: 'xfs' }],
			}),
		});
		const byDevice = Object.fromEntries(partitions(node.nodeId).map((part) => [part.device, part]));
		// Disks that only hold partitions are not rows; a bare disk is.
		expect(byDevice['/dev/nvme0n1']).toBeUndefined();
		expect(byDevice['/dev/sda']).toBeUndefined();
		expect(byDevice['/dev/nvme0n1p2']).toMatchObject({ state: 'system', model: 'Samsung 990' });
		expect(byDevice['/dev/nvme0n1p1']!.state).toBe('system');
		expect(byDevice['/dev/sda1']).toMatchObject({ state: 'mountable', suggestedName: 'bulk-data', model: 'WD Red', uuid: DATA_UUID });
		expect(byDevice['/dev/sdb']!.state).toBe('unformatted');
		expect(byDevice['/dev/sdc1']).toMatchObject({ state: 'in-use', reason: expect.stringContaining('LVM') });
		expect(byDevice['/dev/sdd1']).toMatchObject({ state: 'unsupported', reason: expect.stringContaining('ntfs') });
		expect(byDevice['/dev/sde1']).toMatchObject({ state: 'adoptable', sourceKey: `fs:${MEDIA_UUID}` });

		// Adopting the mounted one turns its row into a volume.
		core.volumes.adopt(admin, node.nodeId, { name: 'media', sourceKey: `fs:${MEDIA_UUID}` });
		expect(partitions(node.nodeId).find((part) => part.device === '/dev/sde1')).toMatchObject({ state: 'volume', volumeName: 'media' });
	});

	test('an older agent lists partitions but cannot mount them', () => {
		const node = enrol('old-agent');
		heartbeat(node, { volumes: inventory({ devices: baseDevices() }) }, []);
		expect(partitions(node.nodeId).find((part) => part.device === '/dev/sda1')).toMatchObject({
			state: 'unsupported',
			reason: expect.stringContaining('Update this node'),
		});
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: DATA_UUID, name: 'bulk' })).toThrow(/cannot mount partitions/);
	});

	test('mounts an unmounted partition by UUID, adopts it into a pool and unmounts it again', async () => {
		const node = enrol('disk-host');
		heartbeat(node, { volumes: inventory({ devices: baseDevices() }) });
		core.storagePools.createPool(admin, { name: 'hdd', allocation: 'most-free', minFreePercent: 10, volumes: [] });

		const row = core.diskMounts.mount(admin, node.nodeId, { fsUuid: DATA_UUID, name: 'bulk', pool: 'hdd' });
		expect(row).toMatchObject({ status: 'pending', name: 'bulk', fsType: 'ext4', device: '/dev/sda1' });
		expect(partitions(node.nodeId).find((part) => part.device === '/dev/sda1')!.state).toBe('mounting');

		const desired = await core.nodes.desiredState(node.token);
		expect(desired.diskMounts).toEqual([{ id: row.id, name: 'bulk', fsUuid: DATA_UUID, fsType: 'ext4' }]);
		expect(JSON.stringify(desired.diskMounts)).not.toContain('/dev/');

		// Mounted, but the inventory has not caught up: no volume yet.
		heartbeat(node, { diskMounts: [{ id: row.id, mounted: true, error: null }] });
		expect(core.volumes.list(admin, node.nodeId).volumes).toEqual([]);

		// The next inventory shows the UUID at /mnt/skiff-disks/bulk: it becomes a volume in "hdd".
		heartbeat(node, {
			diskMounts: [{ id: row.id, mounted: true, error: null }],
			volumes: inventory({
				devices: baseDevices({ mountPath: '/mnt/skiff-disks/bulk' }),
				mounts: [{ sourceKey: `fs:${DATA_UUID}`, mountPath: '/mnt/skiff-disks/bulk' }],
			}),
		});
		expect(core.volumes.list(admin, node.nodeId).volumes).toMatchObject([
			{ name: 'bulk', kind: 'filesystem', mountPath: '/mnt/skiff-disks/bulk', status: 'ready', isDefault: true },
		]);
		const pool = core.storagePools.overview(admin).pools.find((item) => item.name === 'hdd')!;
		expect(pool.members.map((member) => member.volumeName)).toEqual(['bulk']);
		expect(partitions(node.nodeId).find((part) => part.device === '/dev/sda1')).toMatchObject({
			state: 'volume',
			volumeName: 'bulk',
			diskMountId: row.id,
		});

		// The same partition cannot be requested twice, nor a taken name reused.
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: DATA_UUID, name: 'again' })).toThrow();
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: MEDIA_UUID, name: 'bulk' })).toThrow();

		// Unmount unregisters the volume, then waits for the node.
		core.diskMounts.unmount(admin, node.nodeId, row.id);
		expect(core.volumes.list(admin, node.nodeId).volumes).toEqual([]);
		const pulled = await core.nodes.desiredState(node.token);
		expect(pulled.diskMounts).toEqual([]);
		expect(pulled.diskUnmounts).toEqual([{ id: row.id, name: 'bulk' }]);
		heartbeat(node, { unmountedDisks: [row.id] });
		expect(core.diskMounts.rowsForNode(node.nodeId)).toEqual([]);
	});

	test('records a failed mount and refuses partitions that are not provably free', () => {
		const node = enrol('picky');
		heartbeat(node, { volumes: inventory({ devices: baseDevices() }) });
		expect(() => core.diskMounts.mount(member, node.nodeId, { fsUuid: DATA_UUID, name: 'bulk' })).toThrow(/Platform admin/);
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: ROOT_UUID, name: 'rootfs' })).toThrow(/already mounted/);
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: 'CAFE1234', name: 'windows' })).toThrow(/ntfs/);
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: 'aaaa-bbbb', name: 'lvm' })).toThrow(/LVM2_member/);
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: 'deadbeef', name: 'ghost' })).toThrow(/does not report/);
		expect(() => core.diskMounts.mount(admin, node.nodeId, { fsUuid: DATA_UUID, name: 'bulk', pool: 'nope' })).toThrow(/nope/);

		const row = core.diskMounts.mount(admin, node.nodeId, { fsUuid: DATA_UUID, name: 'bulk' });
		heartbeat(node, { diskMounts: [{ id: row.id, mounted: false, error: 'wrong fs type, bad superblock' }] });
		expect(partitions(node.nodeId).find((part) => part.device === '/dev/sda1')).toMatchObject({
			state: 'failed',
			reason: 'wrong fs type, bad superblock',
		});
	});
});
