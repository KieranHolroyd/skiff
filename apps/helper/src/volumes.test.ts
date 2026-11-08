import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SystemdDriver, type CommandRunner, type RunResult } from './systemd.ts';
import type { WorkloadDesired } from './validate.ts';
import {
	inventoryFrom,
	parseFindmnt,
	parseLsblk,
	parseWorkloadVolumes,
	verifyFrom,
	type HelperMount,
} from './volumes.ts';

const FINDMNT = JSON.stringify({
	filesystems: [
		{ target: '/', source: '/dev/mapper/vg-root', fstype: 'ext4', uuid: 'root-uuid', size: '1000', avail: '500', options: 'rw' },
		{ target: '/mnt/data', source: '/dev/sdb1', fstype: 'ext4', uuid: 'data-uuid', label: 'DATA', size: '100000', avail: '50000', options: 'rw,relatime' },
		{ target: '/mnt/moved', source: '/dev/sdc1', fstype: 'xfs', uuid: 'moved-uuid', size: '200000', avail: '100000', options: 'rw' },
		{ target: '/srv/nas', source: 'nas.test:/exports/skiff', fstype: 'nfs4', size: '400000', avail: '300000', options: 'vers=4.2' },
		{ target: '/mnt/zfs', source: 'tank/media', fstype: 'zfs', size: '500000', avail: '450000', options: 'rw' },
		{ target: '/mnt/luks', source: '/dev/mapper/cryptdata', fstype: 'ext4', uuid: 'luks-fs-uuid', size: '600000', avail: '550000', options: 'rw' },
		{ target: '/tmp', source: 'tmpfs', fstype: 'tmpfs', size: '100', avail: '50', options: 'rw' },
	],
});

const LSBLK = JSON.stringify({
	blockdevices: [
		{
			name: 'sda',
			kname: 'sda',
			type: 'disk',
			size: 1000,
			serial: 'SER-A',
			children: [
				{
					name: 'sda1',
					kname: 'sda1',
					type: 'part',
					uuid: 'root-uuid',
					mountpoint: '/',
					size: 1000,
					fstype: 'ext4',
				},
			],
		},
		{
			name: 'sdb',
			kname: 'sdb',
			type: 'disk',
			size: 100000,
			children: [
				{
					name: 'sdb1',
					kname: 'sdb1',
					type: 'part',
					uuid: 'data-uuid',
					mountpoint: '/mnt/data',
					size: 100000,
					fstype: 'ext4',
				},
			],
		},
		{ name: 'sdc', kname: 'sdc', type: 'disk', size: 500000, serial: 'FREE-1' },
		{ name: 'vg-root', kname: 'dm-0', type: 'lvm', size: 1000 },
		{ name: 'cryptdata', kname: 'dm-1', type: 'crypt', size: 600000 },
	],
});

function mounts(): HelperMount[] {
	return inventoryFrom(parseFindmnt(FINDMNT), parseLsblk(LSBLK), new Date('2026-11-05T00:00:00Z')).mounts;
}

describe('volume inventory', () => {
	test('derives stable keys for ext4, LVM, LUKS, ZFS and NFS and skips pseudo filesystems', () => {
		const keys = Object.fromEntries(mounts().map((mount) => [mount.mountPath, mount.sourceKey]));
		expect(keys['/mnt/data']).toBe('fs:data-uuid');
		// Reserved paths (root, /data, /var/lib/skiff, …) cannot hold node data and are never offered.
		expect(keys['/']).toBeUndefined();
		expect(keys['/mnt/luks']).toBe('luks:cryptdata');
		expect(keys['/mnt/zfs']).toBe('zfs:tank/media');
		expect(keys['/srv/nas']).toBe('nfs:nas.test:/exports/skiff');
		expect(keys['/tmp']).toBeUndefined();
	});

	test('marks remote mounts and reports capacity in bytes', () => {
		const nas = mounts().find((mount) => mount.mountPath === '/srv/nas')!;
		expect(nas.remote).toBe(true);
		expect(nas.freeBytes).toBe(300_000);
		expect(mounts().find((mount) => mount.mountPath === '/mnt/data')!.remote).toBe(false);
	});

	test('lists free block devices and never calls a partitioned disk free', () => {
		const inventory = inventoryFrom(parseFindmnt(FINDMNT), parseLsblk(LSBLK));
		expect(inventory.devices.find((device) => device.name === '/dev/sdc')?.free).toBe(true);
		expect(inventory.devices.find((device) => device.name === '/dev/sdb')?.free).toBe(false);
		expect(inventory.devices.find((device) => device.name === '/dev/sdb1')?.free).toBe(false);
		expect(inventory.devices.find((device) => device.name === '/dev/sda')?.free).toBe(false);
	});

	test('reports whether the device behind a mount spins (lsblk ROTA, either encoding)', () => {
		const lsblk = JSON.stringify({
			blockdevices: [
				{ name: 'sdb', kname: 'sdb', type: 'disk', size: 100000, rota: true, children: [
					{ name: 'sdb1', kname: 'sdb1', type: 'part', uuid: 'data-uuid', mountpoint: '/mnt/data', size: 100000, fstype: 'ext4', rota: true },
				] },
				{ name: 'nvme0n1', kname: 'nvme0n1', type: 'disk', size: 500000, rota: '0' },
			],
		});
		const inventory = inventoryFrom(parseFindmnt(FINDMNT), parseLsblk(lsblk));
		expect(inventory.mounts.find((mount) => mount.mountPath === '/mnt/data')!.rotational).toBe(true);
		expect(inventory.mounts.find((mount) => mount.mountPath === '/srv/nas')!.rotational).toBeNull();
		expect(inventory.devices.find((device) => device.name === '/dev/nvme0n1')!.rotational).toBe(false);
		// Older lsblk without the column: unknown, not false.
		expect(inventoryFrom(parseFindmnt(FINDMNT), parseLsblk(LSBLK)).devices[0]!.rotational).toBeNull();
	});

	test('verifies the registered mount and rejects a shadowed path', () => {
		const ok = verifyFrom(FINDMNT, LSBLK, '/mnt/data', 'fs:data-uuid');
		expect(ok).toMatchObject({ ok: true, sourceKey: 'fs:data-uuid' });

		const missing = verifyFrom(FINDMNT, LSBLK, '/mnt/empty', 'fs:data-uuid');
		expect(missing.ok).toBe(false);
		expect(missing.message).toContain('Nothing is mounted at /mnt/empty');

		const shadowed = verifyFrom(FINDMNT, LSBLK, '/mnt/moved', 'fs:different');
		expect(shadowed.ok).toBe(false);
		expect(shadowed.message).toContain('but the volume is fs:different');
	});
});

// ------------------------------------------------------------------ driver

const directories: string[] = [];

class MountRunner implements CommandRunner {
	mounts = FINDMNT;
	lsblk = LSBLK;
	calls: string[][] = [];

	async run(argv: string[]): Promise<RunResult> {
		this.calls.push(argv);
		// `systemctl` accepts everything; `findmnt`/`lsblk` feed the volume check.
		if (argv[0] === '/usr/bin/findmnt') return { code: 0, stdout: this.mounts, stderr: '' };
		if (argv[0] === '/usr/bin/lsblk') return { code: 0, stdout: this.lsblk, stderr: '' };
		return { code: 0, stdout: '', stderr: '' };
	}
}

async function driverFixture(
	volumeRegistry?: (root: string) => Record<string, { mountPath: string; sourceKey: string; fsType: string }>,
): Promise<{
	driver: SystemdDriver;
	runner: MountRunner;
	root: string;
	volumesFile: string;
}> {
	const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-volumes-'));
	directories.push(root);
	const runner = new MountRunner();
	const volumesFile = join(root, 'volumes.json');
	await fs.writeFile(
		volumesFile,
		JSON.stringify({ vol_data: { mountPath: '/mnt/data', sourceKey: 'fs:data-uuid', fsType: 'ext4' } }),
	);
	const driver = new SystemdDriver({
		runner,
		unitDir: join(root, 'units'),
		quadletDir: join(root, 'quadlet'),
		runtimeDir: join(root, 'run'),
		stateDir: join(root, 'state'),
		volumeRegistryFile: volumesFile,
		...(volumeRegistry ? { volumeRegistry: volumeRegistry(root) } : {}),
		releaseDirs: [join(root, 'releases')],
		bunPath: '/usr/local/bin/bun',
	});
	return { driver, runner, root, volumesFile };
}

const workload = (volumeId?: string): WorkloadDesired =>
	({ id: 'st_abc123', volumeId }) as WorkloadDesired;

afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe('volume registry validation', () => {
	test('accepts absolute mount paths and rejects system trees, traversal and device paths', () => {
		expect(
			parseWorkloadVolumes([
				{ id: 'vol_data', mountPath: '/mnt/data', sourceKey: 'fs:data-uuid', fsType: 'ext4' },
				{ id: 'vol_nas', mountPath: '/srv/nas', sourceKey: 'nfs:nas.test:/exports/skiff', fsType: 'nfs4' },
			]),
		).toHaveLength(2);
		for (const mountPath of ['/etc/skiff', '/usr/local', '/', '/mnt/../etc', '/tmp/x', 'mnt/data'])
			expect(() =>
				parseWorkloadVolumes([{ id: 'vol_bad', mountPath, sourceKey: 'fs:x', fsType: 'ext4' }]),
			).toThrow();
		expect(() =>
			parseWorkloadVolumes([{ id: 'vol_bad', mountPath: '/mnt/data', sourceKey: '/dev/sdb1', fsType: 'ext4' }]),
		).toThrow(/stable identity/);
		expect(() =>
			parseWorkloadVolumes([
				{ id: 'vol_a', mountPath: '/mnt/a', sourceKey: 'fs:a', fsType: 'ext4' },
				{ id: 'vol_a', mountPath: '/mnt/b', sourceKey: 'fs:b', fsType: 'ext4' },
			]),
		).toThrow(/duplicate/);
	});

	test('writes the registry atomically and only when it changes', async () => {
		const { driver, root } = await driverFixture();
		const volumes = [{ id: 'vol_data', mountPath: '/mnt/data', sourceKey: 'fs:data-uuid', fsType: 'ext4' }];
		await expect(driver.syncVolumes(volumes)).resolves.toBe(1);
		const file = join(root, 'volumes.json');
		const content = await fs.readFile(file, 'utf8');
		expect(JSON.parse(content)).toEqual({
			vol_data: { mountPath: '/mnt/data', sourceKey: 'fs:data-uuid', fsType: 'ext4' },
		});
		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		// A second identical sync does not rewrite the file.
		const before = (await fs.stat(file)).mtimeMs;
		await driver.syncVolumes(volumes);
		expect((await fs.stat(file)).mtimeMs).toBe(before);
		await expect(driver.syncVolumes([{ id: 'vol_bad', mountPath: '/etc', sourceKey: 'fs:x', fsType: 'ext4' }])).rejects.toThrow(
			/too broad or reserved/,
		);
	});
});

describe('volume-backed data dirs', () => {
	test('resolves to <mount>/skiff/<id> only after the mount is verified', async () => {
		const { driver, runner } = await driverFixture();
		await expect(driver.resolveDataDir(workload('vol_data'))).resolves.toBe('/mnt/data/skiff/st_abc123');
		expect(runner.calls.some((argv) => argv[0] === '/usr/bin/findmnt')).toBe(true);
	});

	test('fails closed when the volume is unknown or not mounted', async () => {
		const { driver, runner } = await driverFixture();
		await expect(driver.resolveDataDir(workload('vol_unknown'))).rejects.toThrow(/not registered/);

		// The path exists but only the root filesystem is mounted: never write there.
		runner.mounts = JSON.stringify({
			filesystems: [{ target: '/', source: '/dev/sda1', fstype: 'ext4', uuid: 'root-uuid' }],
		});
		await expect(driver.resolveDataDir(workload('vol_data'))).rejects.toThrow(/is not mounted at \/mnt\/data/);
	});

	test('a workload without a volume keeps the state directory', async () => {
		const { driver, root } = await driverFixture();
		await expect(driver.resolveDataDir(workload())).resolves.toBe(join(root, 'state', 'st_abc123'));
	});

	test('purge removes the instance subtree on every registered volume', async () => {
		// The injected registry points at the temp mount path so the test never touches /mnt.
		// It cannot come from volumes.json: a real registry entry under the test temp directory
		// (for example /tmp on Linux CI) is rejected by the volume path rules.
		const { driver, root } = await driverFixture((root) => ({
			vol_data: { mountPath: join(root, 'mnt-data'), sourceKey: 'fs:data-uuid', fsType: 'ext4' },
		}));
		const stateTarget = join(root, 'state', 'st_abc123');
		const volumeTarget = join(root, 'mnt-data', 'skiff', 'st_abc123');
		await fs.mkdir(volumeTarget, { recursive: true });
		await fs.mkdir(stateTarget, { recursive: true });
		await driver.purge('st_abc123');
		await expect(fs.stat(volumeTarget)).rejects.toThrow();
		await expect(fs.stat(stateTarget)).rejects.toThrow();
	});
});
