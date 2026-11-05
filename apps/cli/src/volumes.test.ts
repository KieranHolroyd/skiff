import { describe, expect, test } from 'bun:test';
import { volumeDetails, volumeQuota, volumeTable, type AppVolumeView } from './volumes.ts';

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

	test('details name the writer and the snapshot follow-up honestly', () => {
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
		expect(out).toContain('Snapshots: not implemented yet');
	});
});
