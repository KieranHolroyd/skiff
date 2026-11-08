import { describe, expect, test } from 'bun:test';
import { volumeInventorySchema, volumeNameSchema, volumeSourceKeySchema, isRemoteVolumeKind } from './volume.ts';
import { diskAddSchema, diskNameSchema, diskUpdateSchema, storageDefaultsSchema } from './disk.ts';

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

	test('disk names reserve the storage targets', () => {
		expect(diskNameSchema.parse('nvme')).toBe('nvme');
		for (const name of ['system', 'fast', 'bulk']) expect(diskNameSchema.safeParse(name).success).toBe(false);
	});

	test('adding a disk names a candidate; updates need a field', () => {
		expect(diskAddSchema.parse({ node: 'homelab', candidate: 'uuid:abcd-1234' })).toEqual({
			node: 'homelab',
			candidate: 'uuid:abcd-1234',
		});
		expect(diskAddSchema.safeParse({ node: 'homelab', candidate: 'uuid:abcd-1234', mountPath: '/mnt/x' }).success).toBe(false);
		expect(diskAddSchema.safeParse({ node: 'homelab', candidate: 'uuid:abcd-1234', tier: 'remote' }).success).toBe(false);
		expect(diskUpdateSchema.safeParse({}).success).toBe(false);
		expect(diskUpdateSchema.parse({ tier: 'fast' })).toEqual({ tier: 'fast' });
	});

	test('defaults are system or a tier', () => {
		expect(storageDefaultsSchema.safeParse({ defaults: [{ kind: 'databases', target: 'fast' }] }).success).toBe(true);
		expect(storageDefaultsSchema.safeParse({ defaults: [{ kind: 'databases', target: 'ssd' }] }).success).toBe(false);
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

	test('remote kinds', () => {
		expect(isRemoteVolumeKind('nfs')).toBe(true);
		expect(isRemoteVolumeKind('cifs')).toBe(true);
		expect(isRemoteVolumeKind('zfs')).toBe(false);
	});
});
