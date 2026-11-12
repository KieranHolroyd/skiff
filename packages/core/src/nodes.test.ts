import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { buildPrincipal } from './orgs.ts';
import { createCore } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import type { Core } from './index.ts';

const dir = mkdtempSync(join(tmpdir(), 'yoal-nodes-'));
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
		const updated = core.nodes.update(admin, worker.nodeId, { dataDir: '/mnt/data/yoal', buildDir: '/mnt/data/builds' });
		expect(updated.storage).toMatchObject({ dataDir: '/mnt/data/yoal', buildDir: '/mnt/data/builds', status: null });
		expect((await core.nodes.desiredState(worker.token)).storage).toEqual({
			dataDir: '/mnt/data/yoal',
			buildDir: '/mnt/data/builds',
		});
		expect(core.nodes.storageFor(worker.token)).toEqual({ dataDir: '/mnt/data/yoal', buildDir: '/mnt/data/builds' });

		// The node reports what yoal-storage.service did through its heartbeat.
		core.nodes.heartbeat(worker.token, {
			nodeId: worker.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			workloads: [],
			storage: {
				requested: { dataDir: '/mnt/data/yoal', buildDir: '/mnt/data/builds' },
				dataDir: '/mnt/data/yoal',
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
		expect(() => core.nodes.update(admin, worker.nodeId, { dataDir: '/etc/yoal' })).toThrow(/inside \/etc/);
		expect(() => core.nodes.update(admin, worker.nodeId, { dataDir: 'relative' })).toThrow(/absolute/);
		expect(() =>
			core.nodes.update(admin, worker.nodeId, { dataDir: '/mnt/data/yoal', buildDir: '/mnt/data/yoal/builds' }),
		).toThrow(/separate/);
	});

	test('needs a platform admin', () => {
		expect(() => core.nodes.update(member, worker.nodeId, { name: 'nope' })).toThrow(/Platform admin/);
	});
});

describe('node removal', () => {
	const now = Date.now();
	const edgeId = core.nodes.list(admin).find((node) => node.mode === 'edge')!.id;

	test('refuses the edge node', () => {
		expect(() => core.nodes.remove(admin, edgeId)).toThrow(/edge node/);
	});

	test('needs a platform admin and an existing node', () => {
		const spare = joinNode('spare');
		expect(() => core.nodes.remove(member, spare.nodeId)).toThrow(/Platform admin/);
		expect(() => core.nodes.remove(admin, 'nod_missing')).toThrow(/Node/);
		core.nodes.remove(admin, spare.nodeId);
	});

	test('refuses while projects are placed on it or workloads run there', () => {
		const busy = joinNode('busy');
		opened.sqlite.run(
			`INSERT INTO projects (id, org_id, slug, name, runtime, placement, created_by, created_at, updated_at)
			 VALUES ('prj_pin', 'org_1', 'pinned-app', 'Pinned app', 'process', ?, 'user_1', ?, ?)`,
			[busy.nodeId, now, now],
		);
		expect(() => core.nodes.remove(admin, busy.nodeId)).toThrow(/projects placed on it \("Pinned app"\)/);

		opened.sqlite.run(`UPDATE projects SET placement = 'auto' WHERE id = 'prj_pin'`);
		opened.sqlite.run(
			`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
			 VALUES ('wl_pin', 'org_1', 'prj_pin', 'dep_pin', ?, 'process', 'running', '{}', 128, ?, ?)`,
			[busy.nodeId, now, now],
		);
		expect(() => core.nodes.remove(admin, busy.nodeId)).toThrow(/app workloads \("Pinned app"\)/);
		expect(core.nodes.get(busy.nodeId).name).toBe('busy');

		// A deleted project's leftover workload no longer pins the node.
		opened.sqlite.run(`UPDATE projects SET deleted_at = ? WHERE id = 'prj_pin'`, [now]);
		expect(core.nodes.removalBlockers(busy.nodeId)).toEqual([]);
		core.nodes.remove(admin, busy.nodeId);
	});

	test('revokes the token, drops volume registrations and requeues claimed builds', async () => {
		const gone = joinNode('retiring');
		opened.sqlite.run(
			`INSERT INTO node_volumes (id, node_id, name, kind, source_key, mount_path, fs_type, status, created_by, created_at, updated_at)
			 VALUES ('vol_gone', ?, 'data', 'filesystem', 'uuid:gone', '/mnt/data', 'ext4', 'ready', 'user_1', ?, ?)`,
			[gone.nodeId, now, now],
		);
		opened.sqlite.run(
			`INSERT INTO builds (id, org_id, project_id, git_source_id, status, ref, node_id, created_by, created_at, claimed_at)
			 VALUES ('bld_gone', 'org_1', 'prj_x', 'gs_x', 'building', 'main', ?, 'user_1', ?, ?)`,
			[gone.nodeId, now, now],
		);
		const before = core.nodes.stateVersion();

		expect(core.nodes.remove(admin, gone.nodeId)).toEqual({ ok: true, requeuedBuilds: 1 });

		expect(() => core.nodes.get(gone.nodeId)).toThrow(/Node/);
		expect(() => core.nodes.authenticate(gone.token)).toThrow(/Unknown node token/);
		await expect(core.nodes.desiredState(gone.token)).rejects.toThrow(/Unknown node token/);
		expect(opened.sqlite.query(`SELECT count(*) AS n FROM node_volumes WHERE node_id = ?`).get(gone.nodeId)).toEqual({ n: 0 });
		expect(opened.sqlite.query(`SELECT status, node_id AS nodeId FROM builds WHERE id = 'bld_gone'`).get()).toEqual({
			status: 'queued',
			nodeId: null,
		});
		expect(core.nodes.stateVersion()).toBeGreaterThan(before);
		expect(core.audit.list({ principal: admin, limit: 5, action: 'node.remove' }).map((entry) => entry.resourceId)).toContain(gone.nodeId);
	});
});

describe('changing the edge node', () => {
	const beat = (node: { nodeId: string; token: string }) =>
		core.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
		});

	test('swaps the roles, so the new edge serves every site and the old one becomes a worker', async () => {
		const oldEdge = core.nodes.list(admin).find((node) => node.mode === 'edge')!;
		const next = joinNode('next-edge');
		beat(next);
		const before = core.nodes.stateVersion();

		expect(() => core.nodes.setEdge(member, next.nodeId)).toThrow(/Platform admin/);
		expect(core.nodes.setEdge(admin, next.nodeId)).toMatchObject({ id: next.nodeId, mode: 'edge' });
		expect(core.nodes.get(oldEdge.id).mode).toBe('worker');
		expect(core.nodes.list(admin).filter((node) => node.mode === 'edge').map((node) => node.id)).toEqual([next.nodeId]);
		expect(core.nodes.stateVersion()).toBeGreaterThan(before);
		expect(core.workloads.edgeNode()).toBe(next.nodeId);
		expect(core.audit.list({ principal: admin, limit: 5, action: 'node.set_edge' }).map((entry) => entry.resourceId)).toContain(
			next.nodeId,
		);
		// The old edge can now be removed like any worker.
		expect(() => core.nodes.remove(admin, next.nodeId)).toThrow(/edge node/);
		expect(core.nodes.removalBlockers(oldEdge.id)).toEqual([]);
	});

	test('refuses the current edge, offline nodes and an old edge whose apps would become unreachable', () => {
		const edge = core.nodes.list(admin).find((node) => node.mode === 'edge')!;
		expect(() => core.nodes.setEdge(admin, edge.id)).toThrow(/already the edge/);
		const quiet = joinNode('quiet');
		opened.sqlite.run(`UPDATE nodes SET status = 'offline' WHERE id = ?`, [quiet.nodeId]);
		expect(() => core.nodes.setEdge(admin, quiet.nodeId)).toThrow(/offline/);

		// An app pinned to the current edge, which has no address the new edge could proxy to.
		const now = Date.now();
		opened.sqlite.run(
			`INSERT INTO projects (id, org_id, slug, name, runtime, placement, created_by, created_at, updated_at)
			 VALUES ('prj_edgepin', 'org_1', 'edge-pinned', 'Edge pinned', 'process', ?, 'user_1', ?, ?)`,
			[edge.id, now, now],
		);
		const candidate = joinNode('candidate');
		beat(candidate);
		expect(() => core.nodes.setEdge(admin, candidate.nodeId)).toThrow(/no address the new edge could proxy to/);
		core.nodes.update(admin, edge.id, { publicAddress: '10.88.0.9:8080' });
		expect(core.nodes.setEdge(admin, candidate.nodeId).mode).toBe('edge');
		opened.sqlite.run(`UPDATE projects SET deleted_at = ? WHERE id = 'prj_edgepin'`, [now]);
	});
});

describe('node updates from the dashboard (D99)', () => {
	const updatesDb = createDb({ path: ':memory:' });
	const fleet: Core = createCore({
		db: updatesDb.db,
		sqlite: updatesDb.sqlite,
		version: '0.8.0',
		config: {
			dataDir: dir,
			platformOrigin: 'https://control.test',
			contentDomain: 'sites.test',
			objectStore: new LocalObjectStore(join(dir, 'objects-updates'), 'https://control.test', 'object-secret-123'),
			masterKey: new Uint8Array(32).fill(7),
			siteCookieSecret: 'site-cookie-secret-123',
			objectStoreSecret: 'object-secret-123',
			desiredAgentVersion: '0.8.0',
			releaseRepo: 'owner/yoal',
			now: () => clock,
		},
	});
	afterAll(() => updatesDb.sqlite.close());

	const enrol = (name: string) => fleet.nodes.join({ token: fleet.nodes.createJoinToken(admin, name).token, name });
	const beat = (
		node: { nodeId: string; token: string },
		agentVersion: string,
		extra: { capabilities?: string[]; nodeUpdateResult?: { generation: number; error: string } } = {},
	) =>
		fleet.nodes.heartbeat(node.token, {
			nodeId: node.nodeId,
			agentVersion,
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			capabilities: extra.capabilities ?? ['studio-principal', 'node-update'],
			...(extra.nodeUpdateResult ? { nodeUpdateResult: extra.nodeUpdateResult } : {}),
		});
	const view = (id: string) => fleet.nodes.list(admin).find((node) => node.id === id)!;

	test('asks the node to install the control plane version through desired state', async () => {
		const worker = enrol('updates-1');
		beat(worker, '0.7.15');
		expect((await fleet.nodes.desiredState(worker.token)).nodeUpdate).toBeNull();
		const before = fleet.nodes.stateVersion();
		const requested = fleet.nodes.requestUpdate(admin, worker.nodeId);
		expect(requested.update).toMatchObject({ version: '0.8.0', status: 'pending', error: null });
		expect(fleet.nodes.stateVersion()).toBeGreaterThan(before);
		expect((await fleet.nodes.desiredState(worker.token)).nodeUpdate).toEqual({
			generation: 1,
			version: '0.8.0',
			repo: 'owner/yoal',
		});
		expect(fleet.audit.list({ principal: admin, limit: 5, action: 'node.update_agent' })[0]).toMatchObject({
			result: 'ok',
		});

		// The restarted agent's version is the proof; the task leaves desired state.
		beat(worker, '0.8.0');
		expect(view(worker.nodeId).update).toBeNull();
		expect((await fleet.nodes.desiredState(worker.token)).nodeUpdate).toBeNull();
		expect(() => fleet.nodes.requestUpdate(admin, worker.nodeId)).toThrow(/already runs 0\.8\.0/);
	});

	test('a reported failure stops the task until the operator retries', async () => {
		const worker = enrol('updates-2');
		beat(worker, '0.7.15');
		fleet.nodes.requestUpdate(admin, worker.nodeId);
		// A stale generation is ignored.
		beat(worker, '0.7.15', { nodeUpdateResult: { generation: 7, error: 'old' } });
		expect(view(worker.nodeId).update?.status).toBe('pending');
		beat(worker, '0.7.15', { nodeUpdateResult: { generation: 1, error: 'v0.8.0 is not trusted' } });
		expect(view(worker.nodeId).update).toMatchObject({ status: 'failed', error: 'v0.8.0 is not trusted' });
		expect((await fleet.nodes.desiredState(worker.token)).nodeUpdate).toBeNull();

		const retried = fleet.nodes.requestUpdate(admin, worker.nodeId);
		expect(retried.update).toMatchObject({ status: 'pending', error: null });
		expect((await fleet.nodes.desiredState(worker.token)).nodeUpdate?.generation).toBe(2);
	});

	test('refuses agents that cannot update themselves, non-admins and unknown nodes', () => {
		const worker = enrol('updates-3');
		beat(worker, '0.7.11', { capabilities: ['studio-principal'] });
		expect(() => fleet.nodes.requestUpdate(admin, worker.nodeId)).toThrow(/Update it by hand once/);
		expect(() => fleet.nodes.requestUpdate(member, worker.nodeId)).toThrow();
		expect(() => fleet.nodes.requestUpdate(admin, 'nod_missing')).toThrow();
	});
});

describe('cluster topology settings', () => {
	test('a joined worker defaults to the default zone, worker roles and no labels', () => {
		const fresh = joinNode('cluster-defaults');
		const view = core.nodes.get(fresh.nodeId);
		expect(view.zone).toBe('default');
		expect(view.roles).toEqual(['compute', 'data']);
		expect(view.labels).toEqual({});
		expect(view.derivedLabels).toEqual({});
		expect(view.hardware).toBeNull();
	});

	test('edits zone, roles, labels, LAN endpoint and CPU budget', () => {
		const fresh = joinNode('cluster-settings');
		const updated = core.nodes.update(admin, fresh.nodeId, {
			zone: 'cloud-b',
			roles: ['compute', 'data', 'build'],
			labels: { tier: 'critical', owner: 'media' },
			lanEndpoint: '192.168.1.20:51820',
			cpuBudgetMillis: 8000,
		});
		expect(updated).toMatchObject({
			zone: 'cloud-b',
			roles: ['compute', 'data', 'build'],
			labels: { tier: 'critical', owner: 'media' },
			lanEndpoint: '192.168.1.20:51820',
			cpuBudgetMillis: 8000,
		});
	});

	test('refuses reserved yoal.io labels and bad zones', () => {
		const fresh = joinNode('cluster-validation');
		expect(() => core.nodes.update(admin, fresh.nodeId, { labels: { 'yoal.io/arch': 'arm64' } })).toThrow(/reserved/);
		expect(() => core.nodes.update(admin, fresh.nodeId, { zone: 'Cloud B' })).toThrow();
	});

	test('refuses dropping a role while a database runs there', () => {
		const fresh = joinNode('cluster-role-guard');
		const now = Date.now();
		opened.sqlite.run(
			`INSERT INTO databases (id, org_id, name, engine, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_role', 'org_1', 'role-guard', 'postgres', '16', ?, 15432, 256, 'owner', 'monitor', 'user_1', ?, ?)`,
			[fresh.nodeId, now, now],
		);
		expect(() => core.nodes.update(admin, fresh.nodeId, { roles: ['compute'] })).toThrow(/still runs 1 database/);
		opened.sqlite.run(`DELETE FROM databases WHERE id = 'db_role'`);
		expect(core.nodes.update(admin, fresh.nodeId, { roles: ['compute'] }).roles).toEqual(['compute']);
	});

	test('stores hardware facts and derives yoal.io labels', () => {
		const fresh = joinNode('cluster-hardware');
		core.nodes.heartbeat(fresh.token, {
			nodeId: fresh.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			hardware: {
				arch: 'x64',
				cpuModel: 'AMD Ryzen 9 7950X',
				cores: 16,
				threads: 32,
				memoryBytes: 64 * 1024 ** 3,
				virtualization: 'kvm',
				gpus: [{ name: 'NVIDIA RTX 4090', memoryMiB: 24576 }],
			},
		});
		const view = core.nodes.get(fresh.nodeId);
		expect(view.hardware).toMatchObject({ arch: 'x64', cores: 16, virtualization: 'kvm' });
		expect(view.derivedLabels).toMatchObject({
			'yoal.io/arch': 'x64',
			'yoal.io/virt': 'kvm',
			'yoal.io/gpu': 'nvidia',
			'yoal.io/gpu-count': '1',
			'yoal.io/memory-gb': '64',
		});
		expect(view.hardwareAt).not.toBeNull();
		expect(view.hardwareError).toBeNull();
	});

	test('a bad hardware block does not clear the last good one', () => {
		const fresh = joinNode('cluster-hardware-bad');
		core.nodes.heartbeat(fresh.token, {
			nodeId: fresh.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			hardware: { arch: 'arm64', cores: 8 },
		});
		core.nodes.heartbeat(fresh.token, {
			nodeId: fresh.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			hardware: { cores: -1 } as never,
		});
		const view = core.nodes.get(fresh.nodeId);
		expect(view.hardware?.arch).toBe('arm64');
		expect(view.hardwareError).toMatch(/greater than or equal to 1|Too small/);
	});
});

describe('managed overlay join (C1)', () => {
	const key = `${'A'.repeat(43)}=`;

	test('allocates an address and returns the peer state', async () => {
		const token = core.nodes.createJoinToken(admin, 'managed-1').token;
		const joined = core.nodes.join({
			token,
			name: 'managed-1',
			networkMode: 'yoal',
			wireguardPublicKey: key,
		});
		expect(joined.wireguard).toMatchObject({
			mode: 'yoal',
			address: '10.88.1.1',
			cidr: '10.88.0.0/22',
			listenPort: 51820,
		});
		const view = core.nodes.get(joined.nodeId);
		expect(view).toMatchObject({
			networkMode: 'yoal',
			privateAddress: '10.88.1.1',
			wgPublicKey: key,
		});
		expect(view.publicAddress).toBe('10.88.1.1:8080');
		const state = await core.nodes.desiredState(joined.token);
		expect(state.wireguard).toMatchObject({ address: '10.88.1.1', mode: 'yoal' });

		core.nodes.heartbeat(joined.token, {
			nodeId: joined.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			wireguard: {
				interface: 'wg0',
				peers: [{ publicKey: key, endpoint: '203.0.113.10:51820', latestHandshakeAt: new Date(clock).toISOString(), rxBytes: 1, txBytes: 2 }],
			},
		});
		const withStatus = core.nodes.get(joined.nodeId);
		expect(withStatus.wireguardStatus?.peers[0]).toMatchObject({ endpoint: '203.0.113.10:51820', rxBytes: 1 });
		expect(withStatus.wireguardStatusAt).not.toBeNull();
	});

	test('a second managed node gets the next address', () => {
		const token = core.nodes.createJoinToken(admin, 'managed-2').token;
		const joined = core.nodes.join({
			token,
			name: 'managed-2',
			networkMode: 'yoal',
			wireguardPublicKey: `${'B'.repeat(43)}=`,
		});
		expect(joined.wireguard?.address).toBe('10.88.1.2');
	});

	test('refuses a managed join without a public key', () => {
		const token = core.nodes.createJoinToken(admin, 'managed-bad').token;
		expect(() => core.nodes.join({ token, name: 'managed-bad', networkMode: 'yoal' })).toThrow(/public key/);
	});

	test('a public address on a managed join is the WireGuard endpoint, not the proxied upstream', () => {
		const token = core.nodes.createJoinToken(admin, 'managed-public').token;
		const joined = core.nodes.join({
			token,
			name: 'managed-public',
			networkMode: 'yoal',
			publicAddress: '203.0.113.20',
			wireguardPublicKey: `${'C'.repeat(43)}=`,
		});
		const view = core.nodes.get(joined.nodeId);
		expect(view.wgEndpoint).toBe('203.0.113.20:51820');
		expect(view.publicAddress).toBe(`${view.privateAddress}:8080`);
	});

	test('adopts a host-networked node: address now, key from its first heartbeat', async () => {
		const plain = joinNode('adopt-me');
		const keyD = `${'D'.repeat(43)}=`;
		expect(() => core.nodes.adoptOverlay(member, plain.nodeId, { endpoint: '198.51.100.7' })).toThrow();
		const adopted = core.nodes.adoptOverlay(admin, plain.nodeId, { endpoint: '198.51.100.7' });
		expect(adopted).toMatchObject({ networkMode: 'yoal', wgEndpoint: '198.51.100.7:51820', wgPublicKey: null });
		expect(adopted.privateAddress).toMatch(/^10\.88\.1\.\d+$/);
		expect(() => core.nodes.adoptOverlay(admin, plain.nodeId, {})).toThrow(/already/);

		const state = await core.nodes.desiredState(plain.token);
		expect(state.wireguard).toMatchObject({ mode: 'yoal', address: adopted.privateAddress, cidr: '10.88.0.0/22' });

		const beat = { nodeId: plain.nodeId, agentVersion: '0.1.0', actualStateVersion: 1, status: 'online' as const, caddyOk: true, releases: [] };
		core.nodes.heartbeat(plain.token, { ...beat, wireguardPublicKey: keyD });
		expect(core.nodes.get(plain.nodeId).wgPublicKey).toBe(keyD);
		// A later, different key is not taken from a heartbeat.
		core.nodes.heartbeat(plain.token, { ...beat, wireguardPublicKey: `${'E'.repeat(43)}=` });
		expect(core.nodes.get(plain.nodeId).wgPublicKey).toBe(keyD);
	});

	test('a host-networked node ignores a reported key', () => {
		const plain = joinNode('stay-external');
		core.nodes.heartbeat(plain.token, {
			nodeId: plain.nodeId,
			agentVersion: '0.1.0',
			actualStateVersion: 1,
			status: 'online',
			caddyOk: true,
			releases: [],
			wireguardPublicKey: `${'F'.repeat(43)}=`,
		});
		expect(core.nodes.get(plain.nodeId).wgPublicKey).toBeNull();
	});
});

describe('withPort', () => {
	test('adds the default port only when none is given', async () => {
		const { withPort } = await import('./nodes.ts');
		expect(withPort('203.0.113.1', 51820)).toBe('203.0.113.1:51820');
		expect(withPort('203.0.113.1:4000', 51820)).toBe('203.0.113.1:4000');
		expect(withPort('vpn.example.com', 51820)).toBe('vpn.example.com:51820');
		expect(withPort('2001:db8::1', 51820)).toBe('[2001:db8::1]:51820');
		expect(withPort('[2001:db8::1]:9', 51820)).toBe('[2001:db8::1]:9');
	});
});

describe('service endpoints in desired state (C2)', () => {
	test('a consumer receives its loopback endpoint with the provider overlay address', async () => {
		const consumer = joinNode('endpoint-consumer');
		const provider = joinNode('endpoint-provider');
		const now = Date.now();
		opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.9' WHERE id = ?`, [provider.nodeId]);
		opened.sqlite.run(
			`INSERT INTO databases (id, org_id, name, engine, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
			 VALUES ('db_test', 'org_1', 'endpoint-db', 'postgres', '16', ?, 15432, 256, 'owner', 'monitor', 'user_1', ?, ?)`,
			[provider.nodeId, now, now],
		);
		opened.sqlite.run(
			`INSERT INTO service_endpoints (id, consumer_node_id, service_kind, service_id, local_port, upstream_node_id, upstream_port, created_at, updated_at)
			 VALUES ('sep_test', ?, 'database', 'db_test', 21000, ?, 15432, ?, ?)`,
			[consumer.nodeId, provider.nodeId, now, now],
		);
		const state = await core.nodes.desiredState(consumer.token);
		expect(state.serviceEndpoints).toEqual([
			{
				id: 'sep_test',
				kind: 'database',
				serviceId: 'db_test',
				localPort: 21000,
				upstream: { nodeId: provider.nodeId, address: '10.88.1.9', port: 15432 },
				tlsFingerprint: null,
			},
		]);
		const providerState = await core.nodes.desiredState(provider.token);
		expect(providerState.serviceProviders).toEqual([
			{
				id: 'svp_sep_test',
				listenAddress: '10.88.1.9',
				listenPort: 15432,
				targetPort: 15432,
				allowedClientFingerprints: [],
			},
		]);
	});
});
