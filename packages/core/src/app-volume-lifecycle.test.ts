import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES, type AppVolumeTaskResult } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { APP_VOLUME_TASK_TIMEOUT_MS, appVolumeSnapshotObjectKey, createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-app-volume-lifecycle-'));
const opened = createDb({ path: ':memory:' });
const objectsDir = join(dir, 'objects');
const store = new LocalObjectStore(objectsDir, 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');
const GIB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DAY = 86_400_000;
const SHA = 'a'.repeat(64);

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: store,
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
		features: { ...DEFAULT_FEATURES, APP_VOLUMES: true, BACKUPS_RESTORE: true },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });
const stats = {
	cpuPercent: 5,
	memoryBytes: 1 * GIB,
	memoryTotalBytes: 8 * GIB,
	diskUsedBytes: 10 * GIB,
	diskTotalBytes: 100 * GIB,
	diskFreeBytes: 90 * GIB,
	uptimeSeconds: 100,
	load1: 0.1,
	certs: [],
};

let token = '';
let nodeId = '';
const heartbeat = (extra: Record<string, unknown> = {}, capabilities = ['app-volumes']) =>
	core.nodes.heartbeat(token, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		capabilities,
		stats,
		releases: [],
		...extra,
	});
const project = () => core.projects.requireRow(owner, 'vol-api');
const result = (input: Partial<AppVolumeTaskResult> & Pick<AppVolumeTaskResult, 'snapshotId' | 'volumeId'>): AppVolumeTaskResult => ({
	taskId: input.snapshotId,
	action: 'snapshot',
	status: 'ok',
	...input,
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('app volume lifecycle', () => {
	let volumeId = '';
	let snapshotId = '';

	test('setup: a node, a process project and an attached volume', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		token = joined.token;
		nodeId = joined.nodeId;
		heartbeat({}, []);
		await core.projects.create(owner, {
			name: 'vol-api',
			slug: 'vol-api',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.workloads.setSpec(owner, project(), {
			runtime: 'process',
			command: ['bun', 'run', 'start'],
			port: 3000,
			memoryMb: 256,
			cpus: 1,
			healthPath: '/',
			socketActivation: false,
			env: {},
			secrets: [],
		});
		await core.uploads.deployInline(owner, project(), [file('index.js', 'x')], { promote: true });
		const view = core.appVolumes.create(owner, project(), { name: 'data', sizeMb: 100 });
		volumeId = view.id;
		core.appVolumes.attach(owner, project(), 'data', { workload: 'vol-api', mountPath: '/var/lib/app' });
	});

	test('a snapshot is refused on a node whose agent cannot run it', () => {
		expect(() => core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data')).toThrow(/cannot snapshot/);
	});

	test('queues a snapshot on the target that applies now; one at a time; viewers cannot', () => {
		heartbeat();
		expect(() => core.appVolumes.lifecycle.createSnapshot(viewer, project(), 'data')).toThrow();
		const snapshot = core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data', { label: 'before upgrade' });
		snapshotId = snapshot.id;
		expect(snapshot).toMatchObject({
			status: 'pending',
			label: 'before upgrade',
			quiesce: true,
			method: null,
			target: null,
			objectKey: appVolumeSnapshotObjectKey('org_1', volumeId, snapshot.id),
		});
		expect(snapshot.id).toMatch(/^avs_/);
		expect(() => core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data')).toThrow(/already running/);
		expect(core.appVolumes.get(owner, project(), 'data').snapshots.map((item) => item.id)).toEqual([snapshot.id]);
	});

	test('desired state hands the node usage refs and a presigned snapshot task, never a host path', async () => {
		const state = await core.nodes.desiredState(token);
		expect(state.appVolumes).toEqual([{ id: volumeId, projectId: project().id, backing: 'state_dir' }]);
		expect(state.appVolumePurges).toEqual([]);
		expect(state.appVolumeTasks).toHaveLength(1);
		const task = state.appVolumeTasks[0]!;
		expect(task).toMatchObject({ id: snapshotId, action: 'snapshot', snapshotId, quiesce: true, checksum: null });
		expect(task.url).toStartWith('https://control.test/');
		expect(JSON.stringify(state.appVolumeTasks)).not.toContain(dir);
		// The writer the agent pauses is named by the workload's read-write mount.
		expect(state.workloads[0]!.volumes).toEqual([
			{ id: volumeId, mountPath: '/var/lib/app', readOnly: false, backing: 'state_dir' },
		]);
	});

	test('a heartbeat result settles the snapshot, once', async () => {
		heartbeat({
			appVolumeTaskResults: [result({ snapshotId, volumeId, sizeBytes: 4096, sha256: SHA, method: 'reflink' })],
		});
		const [view] = core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data');
		expect(view).toMatchObject({ status: 'ok', sizeBytes: 4096, checksum: SHA, method: 'reflink' });
		expect(view!.finishedAt).not.toBeNull();
		heartbeat({ appVolumeTaskResults: [result({ snapshotId, volumeId, status: 'failed', error: 'late' })] });
		expect(core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data')[0]!.status).toBe('ok');
		expect((await core.nodes.desiredState(token)).appVolumeTasks).toEqual([]);
	});

	test('usage samples land on the node’s own volumes and flag near-quota', () => {
		heartbeat({ appVolumeUsage: [{ id: volumeId, usedBytes: 95 * MB }, { id: 'av_someone_else', usedBytes: 1 }] });
		const view = core.appVolumes.get(owner, project(), 'data');
		expect(view.usedBytes).toBe(95 * MB);
		expect(view.usedAt).toBe(new Date(clock).toISOString());
		expect(view.nearQuota).toBe(true);
		expect(core.appVolumes.lifecycle.alertCandidates(0.85).map((item) => item.row.id)).toEqual([volumeId]);
		expect(core.appVolumes.lifecycle.alertCandidates(0.99)).toEqual([]);
	});

	test('restore creates a new, unattachable volume and a restore task with the checksum', async () => {
		expect(() =>
			core.appVolumes.lifecycle.restore(owner, project(), 'data', snapshotId, { name: 'data-small', sizeMb: 50 }),
		).toThrow(/at least/);
		const restored = core.appVolumes.lifecycle.restore(owner, project(), 'data', snapshotId, { name: 'data-copy' });
		expect(restored).toMatchObject({ name: 'data-copy', sizeMb: 100, status: 'pending', restoringFrom: snapshotId });
		expect(() =>
			core.appVolumes.attach(owner, project(), 'data-copy', { workload: 'vol-api', mountPath: '/var/lib/copy' }),
		).toThrow(/still being restored/);
		expect(() => core.appVolumes.delete(owner, project(), 'data-copy')).toThrow(/being restored/);
		expect(() => core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data-copy')).toThrow(/being restored/);
		await expect(core.appVolumes.lifecycle.deleteSnapshot(owner, project(), 'data', snapshotId)).rejects.toThrow(
			/being restored/,
		);

		const state = await core.nodes.desiredState(token);
		const task = state.appVolumeTasks.find((item) => item.action === 'restore')!;
		expect(task).toMatchObject({
			id: `restore:${restored.id}`,
			volume: { id: restored.id, backing: 'state_dir' },
			snapshotId,
			checksum: SHA,
		});

		heartbeat({
			appVolumeTaskResults: [
				{ taskId: task.id, action: 'restore', snapshotId, volumeId: restored.id, status: 'ok' },
			],
		});
		const ready = core.appVolumes.get(owner, project(), 'data-copy');
		expect(ready).toMatchObject({ status: 'ready', restoringFrom: null, message: null });
		expect(core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data')[0]!.restoreVerifiedAt).not.toBeNull();
		core.appVolumes.attach(owner, project(), 'data-copy', {
			workload: 'vol-api',
			mountPath: '/var/lib/copy',
			readOnly: true,
		});
	});

	test('a failed restore leaves the new volume failed and unattachable', () => {
		const restored = core.appVolumes.lifecycle.restore(owner, project(), 'data', snapshotId, { name: 'data-bad' });
		heartbeat({
			appVolumeTaskResults: [
				{
					taskId: `restore:${restored.id}`,
					action: 'restore',
					snapshotId,
					volumeId: restored.id,
					status: 'failed',
					error: 'checksum mismatch',
				},
			],
		});
		const view = core.appVolumes.get(owner, project(), 'data-bad');
		expect(view.status).toBe('failed');
		expect(view.message).toContain('checksum mismatch');
		expect(() =>
			core.appVolumes.attach(owner, project(), 'data-bad', { workload: 'vol-api', mountPath: '/var/lib/bad' }),
		).toThrow(/checksum mismatch/);
		core.appVolumes.delete(owner, project(), 'data-bad');
	});

	test('a snapshot can name a backup target; work no node finished fails after six hours', async () => {
		const path = join(dir, 'named-target');
		core.backupTargets.create(owner, { name: 'nas', kind: 'local', path });
		expect(() => core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data', { target: 'nope' })).toThrow(
			/Backup target "nope"/,
		);
		const queued = core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data', { target: 'nas', quiesce: false });
		expect(queued.target?.name).toBe('nas');
		expect(queued.quiesce).toBe(false);
		clock += APP_VOLUME_TASK_TIMEOUT_MS + 60_000;
		const report = await core.appVolumes.lifecycle.tick();
		expect(report.timedOut).toBe(1);
		const failed = core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data').find((item) => item.id === queued.id)!;
		expect(failed.status).toBe('failed');
		expect(failed.error).toContain('6 hours');
	});

	test('deleting a snapshot removes its archive from the recorded target', async () => {
		const failed = core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data').find((item) => item.status === 'failed')!;
		const archive = join(dir, 'named-target', failed.objectKey);
		mkdirSync(join(archive, '..'), { recursive: true });
		writeFileSync(archive, 'gz');
		await core.appVolumes.lifecycle.deleteSnapshot(owner, project(), 'data', failed.id);
		expect(existsSync(archive)).toBe(false);
		expect(core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data').map((item) => item.id)).toEqual([snapshotId]);
	});

	test('prune removes an old unpinned finished snapshot and leaves a new one', async () => {
		const extra = core.appVolumes.lifecycle.createSnapshot(owner, project(), 'data');
		heartbeat({ appVolumeTaskResults: [result({ snapshotId: extra.id, volumeId, sizeBytes: 2048, sha256: SHA, method: 'reflink' })] });
		clock += DAY;
		expect(await core.appVolumes.lifecycle.pruneSnapshot(extra.id, clock - 30 * DAY)).toEqual({ removed: false, bytes: 0 });
		const archive = join(dir, 'named-target', appVolumeSnapshotObjectKey('org_1', volumeId, extra.id));
		mkdirSync(join(archive, '..'), { recursive: true });
		writeFileSync(archive, 'gz');
		expect(await core.appVolumes.lifecycle.pruneSnapshot(extra.id, clock)).toEqual({ removed: true, bytes: 2048 });
		expect(existsSync(archive)).toBe(false);
		expect(core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data').map((item) => item.id)).toEqual([snapshotId]);
	});

	test('a trashed volume is purged on its node after the window, then its snapshots go', async () => {
		core.appVolumes.detach(owner, project(), 'data', { workload: 'vol-api' });
		core.appVolumes.delete(owner, project(), 'data');
		// Snapshots of a trashed volume stay listed (and restorable) until the purge.
		expect(core.appVolumes.lifecycle.listSnapshots(owner, project(), 'data')).toHaveLength(1);
		await core.appVolumes.lifecycle.tick();
		expect((await core.nodes.desiredState(token)).appVolumePurges).toEqual([]);

		clock += 8 * DAY;
		// "data" and the failed restore "data-bad".
		expect((await core.appVolumes.lifecycle.tick()).purgesRequested).toBe(2);
		const state = await core.nodes.desiredState(token);
		const bad = core.appVolumes.get(owner, project(), 'data-bad', { includeDeleted: true }).id;
		expect(state.appVolumePurges.map((ref) => ref.id).sort()).toEqual([volumeId, bad].sort());
		expect(state.appVolumes.map((ref) => ref.id)).not.toContain(volumeId);

		const archive = join(objectsDir, appVolumeSnapshotObjectKey('org_1', volumeId, snapshotId));
		mkdirSync(join(archive, '..'), { recursive: true });
		writeFileSync(archive, 'gz');
		heartbeat({ purgedAppVolumes: [volumeId, bad] });
		expect(core.appVolumes.list(owner, project(), { includeDeleted: true }).map((item) => item.name)).toEqual(['data-copy']);
		expect((await core.nodes.desiredState(token)).appVolumePurges).toEqual([]);
		expect((await core.appVolumes.lifecycle.tick()).snapshotsRemoved).toBe(1);
		expect(existsSync(archive)).toBe(false);
	});
});
