import { describe, expect, test } from 'bun:test';
import {
	volumeAdoptSchema,
	volumeInventorySchema,
	volumeNameSchema,
	volumeSourceKeySchema,
	volumeUpdateSchema,
	isRemoteVolumeKind,
	volumeHasRoom,
} from './volume.ts';

describe('volume schemas', () => {
	test('names follow slug rules with no double hyphen', () => {
		for (const name of ['data', 'data-1', 'archive-disk']) expect(volumeNameSchema.parse(name)).toBe(name);
		for (const name of ['da', '-data', 'data-', 'a--b', 'Data', 'data_disk'])
			expect(volumeNameSchema.safeParse(name).success).toBe(false);
	});

	test('source keys are stable identities, not device paths', () => {
		for (const key of [
			'fs:6f1c9c1e-1d6b-4e2f-9a3b-4f7c1d2e3f40',
			'lvm:vg0/data',
			'md:1a2b3c4d',
			'zfs:tank/media',
			'luks:cryptdata',
			'nfs:nas.test:/exports/skiff',
			'cifs:nas.test/share',
		])
			expect(volumeSourceKeySchema.safeParse(key).success).toBe(true);
		expect(volumeSourceKeySchema.safeParse('/dev/sdb1').success).toBe(false);
		expect(volumeSourceKeySchema.safeParse('fs:a b').success).toBe(false);
	});

	test('adoption is strict and needs a name plus source key', () => {
		expect(volumeAdoptSchema.parse({ name: 'data', sourceKey: 'fs:abc' })).toEqual({
			name: 'data',
			sourceKey: 'fs:abc',
			default: false,
		});
		expect(volumeAdoptSchema.safeParse({ name: 'data', sourceKey: 'fs:abc', mountPath: '/mnt/x' }).success).toBe(
			false,
		);
		expect(volumeUpdateSchema.safeParse({}).success).toBe(false);
	});

	test('inventory rejects system mount paths and negative sizes', () => {
		const entry = {
			sourceKey: 'fs:abc',
			kind: 'filesystem',
			fsType: 'ext4',
			mountPath: '/mnt/data',
			sizeBytes: 100,
			freeBytes: 50,
		};
		expect(volumeInventorySchema.safeParse({ generatedAt: 'now', mounts: [entry] }).success).toBe(true);
		expect(
			volumeInventorySchema.safeParse({ generatedAt: 'now', mounts: [{ ...entry, mountPath: '/etc/skiff' }] })
				.success,
		).toBe(false);
		expect(
			volumeInventorySchema.safeParse({ generatedAt: 'now', mounts: [{ ...entry, freeBytes: -1 }] }).success,
		).toBe(false);
	});

	test('remote kinds and capacity checks', () => {
		expect(isRemoteVolumeKind('nfs')).toBe(true);
		expect(isRemoteVolumeKind('cifs')).toBe(true);
		expect(isRemoteVolumeKind('zfs')).toBe(false);
		expect(volumeHasRoom({ freeBytes: 10 * 1024 * 1024 }, 10)).toBe(true);
		expect(volumeHasRoom({ freeBytes: 9 * 1024 * 1024 }, 10)).toBe(false);
		expect(volumeHasRoom({ freeBytes: null }, 10_000)).toBe(true);
	});
});
