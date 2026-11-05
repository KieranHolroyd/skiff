import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-volumes-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
let clock = Date.parse('2026-11-05T10:00:00Z');
const GIB = 1024 * 1024 * 1024;

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
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

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

const heartbeat = (token: string, nodeId: string, extra: Record<string, unknown> = {}) =>
	core.nodes.heartbeat(token, {
		nodeId,
		agentVersion: '0.1.0',
		actualStateVersion: 1,
		status: 'online',
		caddyOk: true,
		releases: [],
		...extra,
	});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('node volumes', () => {
	let token = '';
	let nodeId = '';

	test('requires a platform admin to see volumes', () => {
		const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		token = edge.token;
		nodeId = edge.nodeId;
		core.nodes.update(owner, nodeId, { sliceMemoryMb: 8192 });
		expect(() => core.volumes.list(viewer, nodeId)).toThrow(/Platform admin required/);
	});

	test('an adoption needs a current inventory entry and becomes the default', () => {
		heartbeat(token, nodeId, { volumes: inventory([mount('fs:uuid-1', '/mnt/data')]) });
		const view = core.volumes.list(owner, nodeId);
		expect(view.inventory?.mounts).toHaveLength(1);
		expect(view.volumes).toEqual([]);

		expect(() => core.volumes.adopt(owner, nodeId, { name: 'data', sourceKey: 'fs:missing' })).toThrow(
			/not mounted/,
		);
		const adopted = core.volumes.adopt(owner, nodeId, { name: 'data', sourceKey: 'fs:uuid-1' });
		expect(adopted).toMatchObject({
			name: 'data',
			kind: 'filesystem',
			mountPath: '/mnt/data',
			status: 'ready',
			sizeBytes: 100 * GIB,
			freeBytes: 50 * GIB,
			isDefault: true,
			remote: false,
		});
	});

	test('storage on the default volume carries the volume id to the node', async () => {
		const storage = core.storage.create(owner, { name: 'media' });
		expect(storage.volume).toMatchObject({ name: 'data', mountPath: '/mnt/data' });
		const edge = core.nodes.list(owner).find((node) => node.id === nodeId)!;
		const desired = await core.nodes.desiredState(token);
		const workload = desired.workloads.find((item) => item.id === storage.id)!;
		const volume = core.volumes.list(owner, edge.id).volumes.find((item) => item.name === 'data')!;
		expect(workload.volumeId).toBe(volume.id);
		expect(desired.volumes).toEqual([
			{ id: volume.id, mountPath: '/mnt/data', sourceKey: 'fs:uuid-1', fsType: 'ext4' },
		]);
	});

	test('an explicit volume pins placement and is capacity-checked', () => {
		const storage = core.storage.create(owner, { name: 'archive', volume: 'data' });
		expect(storage.volume?.name).toBe('data');
		expect(() =>
			core.storage.create(owner, { name: 'huge', volume: 'data', storageMb: 60_000 }),
		).toThrow(/has 51200 MB free/);
	});

	test('a disappeared mount marks the volume missing and blocks new instances', () => {
		heartbeat(token, nodeId, { volumes: inventory([]) });
		const volume = core.volumes.list(owner, nodeId).volumes.find((item) => item.name === 'data')!;
		expect(volume.status).toBe('missing');
		expect(volume.message).toContain('no longer reports');
		expect(() => core.storage.create(owner, { name: 'later' })).toThrow(/is missing/);

		heartbeat(token, nodeId, { volumes: inventory([mount('fs:uuid-1', '/mnt/data')]) });
		expect(core.volumes.list(owner, nodeId).volumes[0]!.status).toBe('ready');
		expect(core.storage.create(owner, { name: 'later' }).volume?.name).toBe('data');
	});

	test('the default can be changed, and a mounted volume still in use cannot be removed', async () => {
		heartbeat(
			token,
			nodeId,
			{ volumes: inventory([mount('fs:uuid-1', '/mnt/data'), mount('fs:uuid-2', '/mnt/archive')]) },
		);
		const before = (await core.nodes.desiredState(token)).version;
		const archive = core.volumes.adopt(owner, nodeId, { name: 'archive', sourceKey: 'fs:uuid-2' });
		expect((await core.nodes.desiredState(token)).version).toBeGreaterThan(before);
		core.volumes.update(owner, nodeId, 'archive', { default: true });
		expect(core.volumes.list(owner, nodeId).volumes.find((item) => item.name === 'archive')?.isDefault).toBe(true);
		expect(core.nodes.list(owner).find((item) => item.id === nodeId)?.defaultVolumeId).toBe(archive.id);

		expect(() => core.volumes.remove(owner, nodeId, 'data')).toThrow(/still holds/);
		expect(core.volumes.remove(owner, nodeId, 'archive')).toEqual({ ok: true });
		expect(core.nodes.list(owner).find((item) => item.id === nodeId)?.defaultVolumeId).toBeNull();
	});

	test('restoring a trashed instance refuses a missing volume', () => {
		const storage = core.storage.create(owner, { name: 'restorable', volume: 'data' });
		core.storage.delete(owner, 'restorable');
		heartbeat(token, nodeId, { volumes: inventory([]) });
		expect(() => core.storage.restore(owner, 'restorable')).toThrow(/is missing/);
		heartbeat(token, nodeId, { volumes: inventory([mount('fs:uuid-1', '/mnt/data')]) });
		expect(core.storage.restore(owner, 'restorable').status).toBe('pending');
		expect(storage.volume?.name).toBe('data');
	});

	test('a mount that moved is not silently re-pointed', () => {
		heartbeat(token, nodeId, { volumes: inventory([mount('fs:uuid-1', '/mnt/elsewhere')]) });
		const volume = core.volumes.list(owner, nodeId).volumes.find((item) => item.name === 'data')!;
		expect(volume.status).toBe('missing');
		expect(volume.message).toContain('/mnt/elsewhere');
	});
});
