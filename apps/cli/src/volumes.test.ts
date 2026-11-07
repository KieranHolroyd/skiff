import { describe, expect, test } from 'bun:test';
import {
	nearQuotaWarning,
	snapshotTable,
	volumeDetails,
	volumeQuota,
	volumeStatusLabel,
	volumeTable,
	type AppVolumeSnapshotView,
	type AppVolumeView,
} from './volumes.ts';

function view(overrides: Partial<AppVolumeView> = {}): AppVolumeView {
	return {
		id: 'av_1',
		orgId: 'org_1',
		projectId: 'prj_1',
		projectSlug: 'api',
		name: 'app-data',
		nodeId: 'nod_1',
		backing: 'state_dir',
		nodeVolume: null,
		sizeMb: 1024,
		usedBytes: null,
		mountPath: '/var/lib/app',
		status: 'ready',
		message: null,
		singleWriter: true,
		writer: null,
		attachments: [],
		snapshots: [],
		createdAt: '2026-11-05T10:00:00.000Z',
		updatedAt: '2026-11-05T10:00:00.000Z',
		deletedAt: null,
		...overrides,
	};
}

describe('app volume formatting', () => {
	test('shows quota and usage without inventing a sample', () => {
		expect(volumeQuota({ usedBytes: null, sizeMb: 1024 })).toBe('- / 1.0 GiB');
		expect(volumeQuota({ usedBytes: 512 * 1024 * 1024, sizeMb: 1024 })).toBe('512 MiB / 1.0 GiB (50%)');
	});

	test('lists a node-volume backing by name and never prints a host path', () => {
		const out = volumeTable([
			view({
				backing: 'node_volume',
				nodeVolume: { id: 'vol_1', name: 'data', remote: false },
				attachments: [
					{
						id: 'ava_1',
						volumeId: 'av_1',
						volumeName: 'app-data',
						workloadId: 'wld_1',
						environment: 'production',
						mountPath: '/var/lib/app',
						readOnly: false,
						createdAt: '2026-11-05T10:00:00.000Z',
					},
				],
			}),
		]);
		expect(out).toContain('node:data');
		expect(out).toContain('/var/lib/app');
		expect(out).not.toContain('/mnt/data');
	});

	test('details name the writer and how to take the first snapshot', () => {
		const out = volumeDetails(
			view({
				writer: { workloadId: 'wld_1', environment: 'production' },
				attachments: [
					{
						id: 'ava_1',
						volumeId: 'av_1',
						volumeName: 'app-data',
						workloadId: 'wld_1',
						environment: 'production',
						mountPath: '/var/lib/app',
						readOnly: false,
						createdAt: '2026-11-05T10:00:00.000Z',
					},
				],
			}),
		);
		expect(out).toContain('production (single-writer)');
		expect(out).toContain('skif volume snapshot app-data --project api');
		expect(out).not.toContain('not implemented');
	});

	const snapshot = (overrides: Partial<AppVolumeSnapshotView> = {}): AppVolumeSnapshotView => ({
		id: 'avs_1',
		volumeId: 'av_1',
		target: { id: 'bt_1', name: 'nas' },
		objectKey: 'app-volumes/org_1/av_1/avs_1.tar.gz',
		sizeBytes: 2048,
		checksum: 'a'.repeat(64),
		pinned: false,
		status: 'ok',
		error: null,
		label: 'before upgrade',
		method: 'reflink',
		quiesce: true,
		createdAt: '2026-11-05T10:00:00.000Z',
		finishedAt: '2026-11-05T10:01:00.000Z',
		expiresAt: null,
		restoreVerifiedAt: null,
		...overrides,
	});

	test('lists snapshots with method, target and label', () => {
		const out = snapshotTable([snapshot(), snapshot({ id: 'avs_2', status: 'pending', method: null, sizeBytes: null, target: null, label: null })]);
		expect(out).toContain('avs_1');
		expect(out).toContain('reflink');
		expect(out).toContain('nas');
		expect(out).toContain('before upgrade');
		expect(out).toContain('platform');
	});

	test('details list recent snapshots and warn near the quota', () => {
		const out = volumeDetails(view({ usedBytes: 950 * 1024 * 1024, snapshots: [snapshot()] }));
		expect(out).toContain('Snapshots:');
		expect(out).toContain('avs_1');
		expect(out).toContain('Warning: Volume "app-data" is 93% full');
		expect(nearQuotaWarning(view({ usedBytes: 100 }))).toBeNull();
		expect(nearQuotaWarning(view({ usedBytes: null }))).toBeNull();
	});

	test('a volume being restored says so', () => {
		expect(volumeStatusLabel(view({ status: 'pending', restoringFrom: 'avs_1' }))).toBe('restoring');
		expect(volumeStatusLabel(view({ deletedAt: '2026-11-06T00:00:00.000Z' }))).toBe('deleted');
	});
});
