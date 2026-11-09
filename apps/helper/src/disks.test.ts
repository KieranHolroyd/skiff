import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskMounter, diskMountProblem } from './disks.ts';
import { inventoryFrom, parseFindmnt, parseLsblk } from './volumes.ts';

const DATA = '0b6f1c2e-6a1f-4b53-9a3e-1f0c2d3e4f50';

function lsblk(dataMount: string | null = null, extra: object[] = []): string {
	return JSON.stringify({
		blockdevices: [
			{
				name: 'nvme0n1',
				kname: 'nvme0n1',
				type: 'disk',
				model: 'Samsung 990',
				size: 1_000_000_000_000,
				children: [
					{ name: 'nvme0n1p1', kname: 'nvme0n1p1', type: 'part', fstype: 'vfat', uuid: 'ABCD-1234', mountpoint: '/boot/efi', size: 512_000_000 },
					{ name: 'nvme0n1p2', kname: 'nvme0n1p2', type: 'part', fstype: 'ext4', uuid: 'root-uuid', mountpoint: '/', size: 999_000_000_000 },
				],
			},
			{
				name: 'sda',
				kname: 'sda',
				type: 'disk',
				model: 'WD Red',
				serial: 'WD-123',
				size: 4_000_000_000_000,
				children: [{ name: 'sda1', kname: 'sda1', type: 'part', fstype: 'ext4', uuid: DATA, label: 'Bulk', mountpoint: dataMount, size: 4_000_000_000_000 }],
			},
			{ name: 'loop0', kname: 'loop0', type: 'loop', fstype: 'squashfs', mountpoint: '/snap/core/1', size: 1000 },
			...extra,
		],
	});
}

describe('inventory devices', () => {
	test('reports partitions with UUID, label, type and parent, and skips loop devices', () => {
		const inventory = inventoryFrom(parseFindmnt('{"filesystems":[]}'), parseLsblk(lsblk()));
		const sda1 = inventory.devices.find((device) => device.name === '/dev/sda1');
		expect(sda1).toMatchObject({ type: 'part', parent: 'sda', uuid: DATA, label: 'Bulk', fsType: 'ext4', mountPath: null, free: false });
		expect(inventory.devices.find((device) => device.name === '/dev/sda')).toMatchObject({ type: 'disk', holders: ['sda1'], model: 'WD Red' });
		expect(inventory.devices.some((device) => device.name.includes('loop'))).toBe(false);
	});
});

describe('diskMountProblem', () => {
	test('accepts only one unmounted, unheld device with the expected type', () => {
		expect(diskMountProblem(parseLsblk(lsblk()), { fsUuid: DATA, fsType: 'ext4' })).toBeNull();
		expect(diskMountProblem(parseLsblk(lsblk()), { fsUuid: DATA.toUpperCase(), fsType: 'ext4' })).toBeNull();
		expect(diskMountProblem(parseLsblk(lsblk('/data')), { fsUuid: DATA, fsType: 'ext4' })).toMatch(/already mounted at \/data/);
		expect(diskMountProblem(parseLsblk(lsblk()), { fsUuid: DATA, fsType: 'xfs' })).toMatch(/is ext4, not xfs/);
		expect(diskMountProblem(parseLsblk(lsblk()), { fsUuid: 'root-uuid', fsType: 'ext4' })).toMatch(/already mounted at \//);
		expect(diskMountProblem(parseLsblk(lsblk()), { fsUuid: 'nope', fsType: 'ext4' })).toMatch(/no filesystem/);
		const cloned = lsblk(null, [{ name: 'sdb1', kname: 'sdb1', type: 'part', fstype: 'ext4', uuid: DATA, size: 1 }]);
		expect(diskMountProblem(parseLsblk(cloned), { fsUuid: DATA, fsType: 'ext4' })).toMatch(/2 devices/);
	});
});

describe('DiskMounter', () => {
	const root = mkdtempSync(join(tmpdir(), 'yoal-disks-'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	function fakeRunner(options: { lsblk?: string; mountCode?: number; mountStderr?: string } = {}) {
		const calls: string[][] = [];
		const mounted = new Set<string>();
		const runner = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === 'mountpoint') return { code: mounted.has(argv[2]!) ? 0 : 1, stdout: '', stderr: '' };
			if (argv[0]!.endsWith('lsblk')) return { code: 0, stdout: options.lsblk ?? lsblk(), stderr: '' };
			if (argv[0] === 'mount') {
				if ((options.mountCode ?? 0) !== 0) return { code: options.mountCode!, stdout: '', stderr: options.mountStderr ?? '' };
				mounted.add(argv.at(-1)!);
				return { code: 0, stdout: '', stderr: '' };
			}
			if (argv[0] === 'umount') {
				mounted.delete(argv[1]!);
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 1, stdout: '', stderr: 'unexpected' };
		};
		return { runner, calls, mounted };
	}

	test('mounts by UUID with fixed options and unmounts without forcing', async () => {
		const { runner, calls } = fakeRunner();
		const mounter = new DiskMounter({ root, runner });
		const result = await mounter.mount({ id: 'bulk', fsUuid: DATA, fsType: 'ext4' });
		expect(result).toEqual({ id: 'bulk', mounted: true, mountPath: join(root, 'bulk'), error: null });
		expect(calls.find((argv) => argv[0] === 'mount')).toEqual([
			'mount',
			'-t',
			'ext4',
			'-o',
			'rw,noatime,nosuid,nodev',
			`/dev/disk/by-uuid/${DATA}`,
			join(root, 'bulk'),
		]);
		expect(await mounter.status(['bulk'])).toEqual([{ id: 'bulk', mounted: true, mountPath: join(root, 'bulk'), error: null }]);
		expect(await mounter.unmount('bulk')).toEqual({ id: 'bulk', mounted: false, error: null });
		expect(calls.find((argv) => argv[0] === 'umount')).toEqual(['umount', join(root, 'bulk')]);
		expect(existsSync(join(root, 'bulk'))).toBe(false);
	});

	test('refuses a device that is not free, and bad input, before running mount', async () => {
		const { runner, calls } = fakeRunner({ lsblk: lsblk('/data') });
		const mounter = new DiskMounter({ root, runner });
		const busy = await mounter.mount({ id: 'bulk', fsUuid: DATA, fsType: 'ext4' });
		expect(busy).toMatchObject({ mounted: false, error: expect.stringContaining('already mounted') });
		expect((await mounter.mount({ id: 'bulk', fsUuid: '../../etc', fsType: 'ext4' })).error).toMatch(/UUID/);
		expect((await mounter.mount({ id: 'bulk', fsUuid: DATA, fsType: 'ntfs' })).error).toMatch(/filesystem type/);
		expect(calls.some((argv) => argv[0] === 'mount')).toBe(false);
		await expect(mounter.mount({ id: '../etc', fsUuid: DATA, fsType: 'ext4' })).rejects.toThrow(/invalid/);
		expect(existsSync(join(root, 'bulk'))).toBe(false);
	});

	test('explains a failed mount and cleans up the mount point', async () => {
		const { runner } = fakeRunner({ mountCode: 32, mountStderr: 'mount: wrong fs type, bad option, bad superblock' });
		const mounter = new DiskMounter({ root, runner });
		const result = await mounter.mount({ id: 'bulk', fsUuid: DATA, fsType: 'ext4' });
		expect(result).toMatchObject({ mounted: false, error: expect.stringContaining('fsck') });
		expect(existsSync(join(root, 'bulk'))).toBe(false);
	});
});
