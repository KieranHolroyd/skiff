import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, diskAdmissionProblem, nodeDiskFreeBytes } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-app-volumes-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');
const GIB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

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
		features: { ...DEFAULT_FEATURES, APP_VOLUMES: true },
	},
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true,
});
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });
const file = (path: string, content: string) => ({ path, content, encoding: 'utf8' as const });

const mount = (sourceKey: string, mountPath: string, freeBytes = 50 * GIB) => ({
	sourceKey,
	kind: 'filesystem' as const,
	fsType: 'ext4',
	mountPath,
	device: '/dev/sdb1',
	label: 'data',
	sizeBytes: 100 * GIB,
	freeBytes,
	remote: false,
});

const inventory = (mounts: ReturnType<typeof mount>[]) => ({
	generatedAt: new Date(clock).toISOString(),
	mounts,
	devices: [],
});

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

const heartbeat = (token: string, nodeId: string, extra: Record<string, unknown> = {}) =>
	core.nodes.heartbeat(token, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		stats,
		releases: [],
		...extra,
	});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('disk admission', () => {
	test('reserves at most 90% of free space and names the numbers', () => {
		expect(diskAdmissionProblem({ requestMb: 1000, freeBytes: 10 * GIB, reservedBytes: 0 })).toBeNull();
		const problem = diskAdmissionProblem({ requestMb: 9_500, freeBytes: 10 * GIB, reservedBytes: 0 });
		expect(problem).toContain('10240 MB free');
		expect(problem).toContain('9216 MB');
		expect(problem).toContain('9500 MB');
	});
	test('refuses when the node has not reported disk yet', () => {
		expect(diskAdmissionProblem({ requestMb: 100, freeBytes: null, reservedBytes: 0 })).toContain(
			'has not reported',
		);
	});
	test('derives free disk from total minus used for older agents', () => {
		expect(nodeDiskFreeBytes({ diskTotalBytes: 100, diskUsedBytes: 25 })).toBe(75);
		expect(nodeDiskFreeBytes({ diskTotalBytes: 100, diskUsedBytes: 25, diskFreeBytes: 10 })).toBe(10);
		expect(nodeDiskFreeBytes({})).toBeNull();
	});
});

describe('app volumes', () => {
	let token = '';
	let nodeId = '';

	test('registers the node and deploys a process project', async () => {
		const joined = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		token = joined.token;
		nodeId = joined.nodeId;
		heartbeat(token, nodeId);
		await core.projects.create(owner, {
			name: 'app-api',
			slug: 'app-api',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const project = core.projects.requireRow(owner, 'app-api');
		core.workloads.setSpec(owner, project, {
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
		await core.uploads.deployInline(owner, project, [file('index.js', 'x')], { promote: true });
		expect(core.workloads.view(project)?.nodeId).toBe(nodeId);
	});

	test('creates a state-dir volume after admission', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		expect(() => core.appVolumes.list(viewer, project)).not.toThrow();
		const view = core.appVolumes.create(owner, project, { name: 'app-data', sizeMb: 1024 });
		expect(view).toMatchObject({
			name: 'app-data',
			backing: 'state_dir',
			sizeMb: 1024,
			nodeId,
			status: 'ready',
			singleWriter: true,
			usedBytes: null,
		});
		expect(view.disk).toBeNull();
		expect(JSON.stringify(view)).not.toContain('/yoal/apps');
		expect(JSON.stringify(view)).not.toContain(dir);
	});

	test('refuses a create that would exceed 90% of free disk', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		expect(() => core.appVolumes.create(owner, project, { name: 'too-big', sizeMb: 90_000 })).toThrow(
			/90% admission limit/,
		);
		const capacity = core.workloads.capacity(owner).find((row) => row.nodeId === nodeId)!;
		expect(capacity.diskFreeBytes).toBe(90 * GIB);
		expect(capacity.diskTotalBytes).toBe(100 * GIB);
		expect(capacity.reservedDiskBytes).toBe(1024 * MB);
	});

	test('attaches read-write, enforces single-writer, and allows read-only', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		const attached = core.appVolumes.attach(owner, project, 'app-data', {
			workload: project.slug,
			environment: 'production',
			mountPath: '/var/lib/app',
			readOnly: false,
		});
		expect(attached.mountPath).toBe('/var/lib/app');
		expect(attached.writer).toEqual({
			workloadId: core.workloads.view(project)!.id,
			environment: 'production',
		});
		expect(() =>
			core.appVolumes.attach(owner, project, 'app-data', {
				workload: project.slug,
				environment: 'staging',
				mountPath: '/var/lib/staging',
				readOnly: false,
			}),
		).toThrow(/read-write/);
		const readOnly = core.appVolumes.attach(owner, project, 'app-data', {
			workload: project.slug,
			environment: 'staging',
			mountPath: '/var/lib/staging',
			readOnly: true,
		});
		expect(readOnly.attachments).toHaveLength(2);
		expect(readOnly.attachments.find((item) => item.environment === 'staging')?.readOnly).toBe(true);
	});

	test('mount paths are unique per environment and validated', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		core.appVolumes.create(owner, project, { name: 'assets', sizeMb: 256 });
		expect(() =>
			core.appVolumes.attach(owner, project, 'assets', {
				workload: project.slug,
				environment: 'production',
				mountPath: '/var/lib/app',
			}),
		).toThrow(/already used/);
		expect(() =>
			core.appVolumes.attach(owner, project, 'assets', {
				workload: project.slug,
				environment: 'production',
				mountPath: '/etc',
			}),
		).toThrow(/reserved|inside/);
	});

	test('desired state carries mounts but never a host path', async () => {
		const project = core.projects.requireRow(owner, 'app-api');
		const state = await core.nodes.desiredState(token);
		const workload = state.workloads[0]!;
		expect(workload.volumes).toEqual([
			{
				id: expect.stringMatching(/^av_/),
				mountPath: '/var/lib/app',
				readOnly: false,
				backing: 'state_dir',
			},
			{
				id: expect.stringMatching(/^av_/),
				mountPath: '/var/lib/staging',
				readOnly: true,
				backing: 'state_dir',
			},
		]);
		expect(JSON.stringify(state)).not.toContain('/yoal/apps');
		expect(JSON.stringify(state)).not.toContain(dir);
		const mounted = core.appVolumes.mountsForWorkload(core.workloads.view(project)!.id);
		expect(mounted).toHaveLength(2);
	});

	test('detaches, refuses delete while attached, then soft-deletes', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		expect(() => core.appVolumes.delete(owner, project, 'app-data')).toThrow(/still attached/);
		const detached = core.appVolumes.detach(owner, project, 'app-data', {
			workload: project.slug,
			environment: 'staging',
		});
		expect(detached.attachments).toHaveLength(1);
		core.appVolumes.detach(owner, project, 'app-data', {
			workload: project.slug,
			environment: 'production',
		});
		const result = core.appVolumes.delete(owner, project, 'app-data');
		expect(result.ok).toBe(true);
		expect(core.appVolumes.list(owner, project).map((item) => item.name)).not.toContain('app-data');
		const trash = core.appVolumes.list(owner, project, { includeDeleted: true });
		expect(trash.find((item) => item.name === 'app-data')?.status).toBe('deleting');
	});

	test('a volume on a disk pins the node and reports missing with its mount', () => {
		const project = core.projects.requireRow(owner, 'app-api');
		heartbeat(token, nodeId, { volumes: inventory([mount('fs:uuid-1', '/mnt/data')]) });
		core.disks.add(owner, { node: nodeId, candidate: 'mount:fs:uuid-1', name: 'data' });
		const volume = core.appVolumes.create(owner, project, { name: 'media', sizeMb: 1024, storage: 'data' });
		expect(volume.backing).toBe('node_volume');
		expect(volume.disk).toEqual({ id: expect.any(String), name: 'data', tier: 'bulk', remote: false });
		expect(JSON.stringify(volume)).not.toContain('/mnt/data');

		heartbeat(token, nodeId, { volumes: inventory([]) });
		const missing = core.appVolumes.get(owner, project, 'media');
		expect(missing.status).toBe('missing');
		expect(missing.message).toContain('no longer reports');
		expect(() =>
			core.appVolumes.attach(owner, project, 'media', {
				workload: project.slug,
				environment: 'production',
				mountPath: '/var/lib/media',
			}),
		).toThrow(/missing/);
	});

	test('org quotas cap volume count and reserved size; trashed volumes do not count', async () => {
		const project = core.projects.requireRow(owner, 'app-api');
		// Live: "assets" (256 MB) and "media" (1024 MB). "app-data" is in the trash and frees its quota.
		core.ctx.quota.set('org_1', { appVolumes: 3, appVolumeBytes: 2048 * MB });
		expect(() => core.appVolumes.create(owner, project, { name: 'too-large', sizeMb: 769 })).toThrow(
			'App volume storage quota (appVolumeBytes) exceeded: 2.00 GB used of 2.00 GB',
		);
		const cache = core.appVolumes.create(owner, project, { name: 'cache', sizeMb: 512 });
		expect(cache.sizeMb).toBe(512);
		let refused: unknown;
		try {
			core.appVolumes.create(owner, project, { name: 'third', sizeMb: 1 });
		} catch (error) {
			refused = error;
		}
		expect(refused).toMatchObject({ code: 'quota_exceeded', status: 409 });
		expect((refused as Error).message).toContain('App volumes quota (appVolumes) exceeded: 4 used of 3');

		// Growth checks only the delta: 1280 + 512 + 256 more = 2048 MB fits; one more MB does not.
		expect(core.appVolumes.update(owner, project, 'cache', { sizeMb: 768 }).sizeMb).toBe(768);
		expect(() => core.appVolumes.update(owner, project, 'cache', { sizeMb: 769 })).toThrow(/appVolumeBytes/);

		const usage = await core.usage.view(owner, { projectSlug: project.slug });
		expect(usage.metrics.appVolumes).toMatchObject({ used: 3, limit: 3, percent: 100 });
		expect(usage.metrics.appVolumeBytes).toMatchObject({ used: 2048 * MB, limit: 2048 * MB });
		core.ctx.quota.set('org_1', { appVolumes: -1, appVolumeBytes: -1 });
	});
});
