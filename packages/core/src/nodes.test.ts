import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-nodes-'));
const opened = createDb({ path: ':memory:' });
const clock = Date.now();

const core: Core = createCore({
	db: opened.db,
	sqlite: opened.sqlite,
	version: '0.1.0',
	config: {
		dataDir: dir,
		platformOrigin: 'https://control.test',
		contentDomain: 'sites.test',
		objectStore: new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123'),
		masterKey: new Uint8Array(32).fill(7),
		siteCookieSecret: 'site-cookie-secret-123',
		objectStoreSecret: 'object-secret-123',
		desiredAgentVersion: '0.1.0',
		now: () => clock,
	},
});

const admin = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const member = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'owner' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function joinNode(name: string) {
	return core.nodes.join({ token: core.nodes.createJoinToken(admin, name).token, name });
}

describe('node settings', () => {
	const edge = joinNode('edge');
	const worker = joinNode('homelab');

	test('lists the slice budget and builder role', () => {
		const view = core.nodes.list(admin).find((node) => node.id === worker.nodeId)!;
		expect(view).toMatchObject({ sliceMemoryMb: 1024, sliceCpuWeight: 200, canBuild: false });
	});

	test('edits name, address, slice and builder role and pushes them to desired state', async () => {
		const before = core.nodes.stateVersion();
		const updated = core.nodes.update(admin, worker.nodeId, {
			name: 'homelab-2',
			publicAddress: '10.8.0.2:8080',
			sliceMemoryMb: 4096,
			sliceCpuWeight: 50,
			canBuild: true,
		});
		expect(updated).toMatchObject({
			name: 'homelab-2',
			publicAddress: '10.8.0.2:8080',
			sliceMemoryMb: 4096,
			sliceCpuWeight: 50,
			canBuild: true,
		});
		expect(core.nodes.stateVersion()).toBeGreaterThan(before);
		const state = await core.nodes.desiredState(worker.token);
		expect(state.sliceMemoryMb).toBe(4096);
		expect(state.sliceCpuWeight).toBe(50);
		expect(core.workloads.capacityInternal().find((item) => item.nodeId === worker.nodeId)?.sliceMemoryMb).toBe(4096);
		expect(core.audit.list({ principal: admin, limit: 5, action: 'node.update' }).length).toBeGreaterThan(0);
	});

	test('the edge (or any regular node) can be given the Builder role and claim builds', async () => {
		core.nodes.update(admin, edge.nodeId, { canBuild: true });
		// No queued builds: a Builder gets null, not the 403 a non-Builder gets.
		expect(await core.builds.claim(edge.nodeId)).toBeNull();
		core.nodes.update(admin, edge.nodeId, { canBuild: false });
		await expect(core.builds.claim(edge.nodeId)).rejects.toMatchObject({ status: 403 });
	});

	test('clearing the address stores null', () => {
		expect(core.nodes.update(admin, worker.nodeId, { publicAddress: null }).publicAddress).toBeNull();
	});

	test('rejects a slice budget below what workloads already reserve', () => {
		const now = Date.now();
		// Only workloads of live projects reserve budget (docs/OPERATIONS.md L5), so the fixture needs one.
		opened.sqlite.run(
			`INSERT INTO projects (id, org_id, slug, name, runtime, created_by, created_at, updated_at)
			 VALUES ('prj_x', 'org_1', 'reserve-fixture', 'Reserve fixture', 'process', 'user_1', ?, ?)`,
			[now, now],
		);
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
			 VALUES ('wl_res', 'org_1', 'prj_x', 'dep_x', ?, 'process', 'running', '{}', 768, ?, ?)`,
			[worker.nodeId, now, now],
		);
		expect(() => core.nodes.update(admin, worker.nodeId, { sliceMemoryMb: 512 })).toThrow(/reserve 768 MB/);
		expect(core.nodes.update(admin, worker.nodeId, { sliceMemoryMb: 768 }).sliceMemoryMb).toBe(768);
	});

	test('validates input', () => {
		expect(() => core.nodes.update(admin, worker.nodeId, { sliceMemoryMb: 8 })).toThrow();
		expect(() => core.nodes.update(admin, worker.nodeId, { publicAddress: 'http://10.0.0.1/x' })).toThrow(/host:port/);
		expect(() => core.nodes.update(admin, worker.nodeId, { name: '  ' })).toThrow();
		expect(() => core.nodes.update(admin, 'nod_missing', { name: 'x' })).toThrow(/Node/);
	});

	test('storage locations reach desired state, the storage endpoint and the view', async () => {
		const updated = core.nodes.update(admin, worker.nodeId, { dataDir: '/mnt/data/skiff', buildDir: '/mnt/data/builds' });
		expect(updated.storage).toMatchObject({ dataDir: '/mnt/data/skiff', buildDir: '/mnt/data/builds', status: null });
		expect((await core.nodes.desiredState(worker.token)).storage).toEqual({
			dataDir: '/mnt/data/skiff',
			buildDir: '/mnt/data/builds',
		});
		expect(core.nodes.storageFor(worker.token)).toEqual({ dataDir: '/mnt/data/skiff', buildDir: '/mnt/data/builds' });

		// The node reports what skiff-storage.service did through its heartbeat.
		core.nodes.heartbeat(worker.token, {
			nodeId: worker.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [],
			storage: {
				requested: { dataDir: '/mnt/data/skiff', buildDir: '/mnt/data/builds' },
				dataDir: '/mnt/data/skiff',
				buildDir: '/mnt/data/builds',
				status: 'applied',
				message: null,
				updatedAt: new Date(clock).toISOString(),
			},
		});
		expect(core.nodes.get(worker.nodeId).storage.status?.status).toBe('applied');

		// Blank (null) goes back to the default.
		expect(core.nodes.update(admin, worker.nodeId, { buildDir: null }).storage.buildDir).toBeNull();
	});

	test('rejects unsafe or overlapping storage paths', () => {
		expect(() => core.nodes.update(admin, worker.nodeId, { dataDir: '/etc/skiff' })).toThrow(/inside \/etc/);
		expect(() => core.nodes.update(admin, worker.nodeId, { dataDir: 'relative' })).toThrow(/absolute/);
		expect(() =>
			core.nodes.update(admin, worker.nodeId, { dataDir: '/mnt/data/skiff', buildDir: '/mnt/data/skiff/builds' }),
		).toThrow(/separate/);
	});

	test('needs a platform admin', () => {
		expect(() => core.nodes.update(member, worker.nodeId, { name: 'nope' })).toThrow(/Platform admin/);
	});
});
