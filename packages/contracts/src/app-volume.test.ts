import { describe, expect, test } from 'bun:test';
import type { z } from 'zod';
import {
	appVolumeAttachSchema,
	appVolumeCreateSchema,
	appVolumeMountPathProblem,
	appVolumeNodeRefSchema,
	appVolumeRestoreSchema,
	appVolumeTaskSchema,
	appVolumeUsagePercent,
	appVolumeSnapshotCreateSchema,
	appVolumeSnapshotViewSchema,
	appVolumeUpdateSchema,
	appVolumeViewSchema,
} from './app-volume.ts';

const created = appVolumeCreateSchema.parse({ name: 'app-data' });

describe('app volume schemas', () => {
	test('create defaults to a state-dir single-writer volume', () => {
		expect(created).toEqual({
			name: 'app-data',
			sizeMb: 1024,
			backing: 'state_dir',
			singleWriter: true,
		});
		expect(appVolumeCreateSchema.safeParse({ name: 'app-data', nodeVolume: 'data' }).success).toBe(false);
		expect(appVolumeCreateSchema.safeParse({ name: 'app-data', backing: 'node_volume' }).success).toBe(false);
		expect(
			appVolumeCreateSchema.parse({ name: 'app-data', backing: 'node_volume', nodeVolume: 'data' }).nodeVolume,
		).toBe('data');
		expect(appVolumeCreateSchema.safeParse({ name: 'a--b' }).success).toBe(false);
		expect(appVolumeCreateSchema.safeParse({ name: 'app-data', unknown: true }).success).toBe(false);
	});

	test('mount paths reject system trees, the legacy /data and traversal', () => {
		expect(appVolumeMountPathProblem('/var/lib/app')).toBeNull();
		expect(appVolumeMountPathProblem('/mnt/data/app')).toBeNull();
		for (const path of ['/data', '/proc/x', '/etc/skiff', '/var/lib/skiff/x', 'data', '/mnt/data/', '/mnt/../etc'])
			expect(appVolumeMountPathProblem(path)).not.toBeNull();
	});

	test('attach validates the mount point and defaults to production', () => {
		expect(appVolumeAttachSchema.parse({ workload: 'wl_1', mountPath: '/var/lib/app' })).toEqual({
			workload: 'wl_1',
			environment: 'production',
			mountPath: '/var/lib/app',
			readOnly: false,
		});
		expect(appVolumeAttachSchema.safeParse({ workload: 'wl_1', mountPath: '/etc' }).success).toBe(false);
		expect(appVolumeAttachSchema.safeParse({ workload: 'wl_1', mountPath: '/var/lib/app', extra: 1 }).success).toBe(false);
	});

	test('update is partial and non-empty; restore creates a new volume', () => {
		expect(appVolumeUpdateSchema.parse({ sizeMb: 2048 })).toEqual({ sizeMb: 2048 });
		expect(appVolumeUpdateSchema.safeParse({}).success).toBe(false);
		expect(appVolumeRestoreSchema.parse({ name: 'restored' })).toEqual({ name: 'restored' });
		expect(appVolumeRestoreSchema.parse({ name: 'restored', sizeMb: 2048 }).sizeMb).toBe(2048);
		// Attach after the restore finished: restoring into a mounted directory is never offered.
		expect(appVolumeRestoreSchema.safeParse({ name: 'restored', mountPath: '/var/lib/app' }).success).toBe(false);
	});

	test('snapshots default to quiesced and unpinned', () => {
		expect(appVolumeSnapshotCreateSchema.parse({})).toEqual({ pinned: false, quiesce: true });
		expect(appVolumeSnapshotCreateSchema.parse({ target: 'offsite', quiesce: false }).target).toBe('offsite');
	});

	test('views round-trip and expose no host path or secret', () => {
		const snapshot: z.output<typeof appVolumeSnapshotViewSchema> = {
			id: 'avs_1',
			volumeId: 'av_1',
			target: { id: 'bt_1', name: 'offsite' },
			objectKey: 'skiff/backups/volumes/av_1.tar.zst',
			sizeBytes: 1024,
			checksum: 'a'.repeat(64),
			pinned: false,
			status: 'ok',
			error: null,
			label: 'before upgrade',
			method: 'reflink',
			quiesce: true,
			createdAt: '2026-11-05T00:00:00.000Z',
			finishedAt: '2026-11-05T00:01:00.000Z',
			expiresAt: null,
			restoreVerifiedAt: null,
		};
		expect(appVolumeSnapshotViewSchema.parse(snapshot)).toEqual(snapshot);

		const view: z.output<typeof appVolumeViewSchema> = {
			id: 'av_1',
			orgId: 'org_1',
			projectId: 'prj_1',
			projectSlug: 'my-app',
			name: 'app-data',
			nodeId: 'node_1',
			backing: 'state_dir',
			nodeVolume: null,
			sizeMb: 1024,
			usedBytes: 512,
			usedAt: '2026-11-05T00:00:00.000Z',
			nearQuota: false,
			restoringFrom: null,
			mountPath: '/var/lib/app',
			status: 'ready',
			message: null,
			singleWriter: true,
			writer: { workloadId: 'wl_1', environment: 'production' },
			attachments: [
				{
					id: 'ava_1',
					volumeId: 'av_1',
					volumeName: 'app-data',
					workloadId: 'wl_1',
					environment: 'production',
					mountPath: '/var/lib/app',
					readOnly: false,
					createdAt: '2026-11-05T00:00:00.000Z',
				},
			],
			snapshots: [snapshot],
			createdAt: '2026-11-05T00:00:00.000Z',
			updatedAt: '2026-11-05T00:00:00.000Z',
			deletedAt: null,
		};
		const parsed = appVolumeViewSchema.parse(view);
		expect(parsed).toEqual(view);
		expect(appVolumeViewSchema.parse(parsed)).toEqual(parsed);
	});

	test('usage percent and the node protocol', () => {
		expect(appVolumeUsagePercent({ usedBytes: null, sizeMb: 1 })).toBeNull();
		expect(appVolumeUsagePercent({ usedBytes: 943_718, sizeMb: 1 })).toBe(90);
		expect(appVolumeNodeRefSchema.safeParse({ id: 'av_1', projectId: 'prj_1', backing: 'state_dir' }).success).toBe(true);
		// Ids become path components on the node: no traversal, no slashes.
		expect(appVolumeNodeRefSchema.safeParse({ id: 'av_../x', projectId: 'prj_1', backing: 'state_dir' }).success).toBe(false);
		expect(appVolumeNodeRefSchema.safeParse({ id: 'av_1', projectId: 'a/b', backing: 'state_dir' }).success).toBe(false);
		const task = appVolumeTaskSchema.parse({
			id: 'avs_1',
			action: 'snapshot',
			volume: { id: 'av_1', projectId: 'prj_1', backing: 'state_dir' },
			snapshotId: 'avs_1',
			url: 'https://example.test/put',
		});
		expect(task).toMatchObject({ quiesce: true, checksum: null });
	});
});
