import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-topology-'));
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

const edge = joinNode('edge');
const worker = joinNode('homelab');
core.nodes.update(admin, edge.nodeId, { zone: 'cloud-a', roles: ['ingress', 'control', 'compute', 'data'] });
core.nodes.update(admin, worker.nodeId, { zone: 'home', roles: ['compute', 'data', 'build'] });

opened.sqlite.run(
	`INSERT INTO projects (id, org_id, slug, name, runtime, placement, created_by, created_at, updated_at)
	 VALUES ('prj_topo', 'org_1', 'topo-app', 'Topology app', 'process', 'auto', 'user_1', ?, ?)`,
	[clock, clock],
);
opened.sqlite.run(
	`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, created_at, updated_at)
	 VALUES ('wl_topo', 'org_1', 'prj_topo', 'dep_topo', ?, 'process', 'running', '{}', 256, ?, ?)`,
	[worker.nodeId, clock, clock],
);
opened.sqlite.run(
	`INSERT INTO databases (id, org_id, name, engine, version, node_id, host_port, memory_mb, owner_secret, monitor_secret, created_by, created_at, updated_at)
	 VALUES ('db_topo', 'org_1', 'topo-db', 'postgres', '16', ?, 15432, 256, 'owner', 'monitor', 'user_1', ?, ?)`,
	[edge.nodeId, clock, clock],
);
opened.sqlite.run(
	`INSERT INTO node_volumes (id, node_id, name, kind, source_key, mount_path, fs_type, remote, tier, status, created_by, created_at, updated_at)
	 VALUES ('vol_topo', ?, 'media', 'filesystem', 'fs:topo', '/mnt/media', 'xfs', 0, 'bulk', 'ready', 'user_1', ?, ?)`,
	[worker.nodeId, clock, clock],
);

describe('topology view', () => {
	test('groups nodes by zone and includes roles, hardware and disks', () => {
		const view = core.topology.view(admin);
		expect(view.zones.map((zone) => zone.zone).sort()).toEqual(['cloud-a', 'home']);
		const home = view.nodes.find((node) => node.id === worker.nodeId)!;
		expect(home).toMatchObject({
			zone: 'home',
			roles: ['compute', 'data', 'build'],
			workloads: 1,
			databases: 0,
		});
		expect(home.disks).toEqual([
			expect.objectContaining({ id: 'vol_topo', name: 'media', tier: 'bulk' }),
		]);
		const edgeView = view.nodes.find((node) => node.id === edge.nodeId)!;
		expect(edgeView.databases).toBe(1);
	});

	test('blast radius of a node names the workloads and disks it would take down', () => {
		const blast = core.topology.blastRadius(admin, { kind: 'node', id: worker.nodeId });
		expect(blast.target.name).toBe('homelab');
		expect(blast.summary).toMatchObject({ workloads: 1, disks: 1, databases: 0 });
		expect(blast.items.map((item) => item.name)).toContain('Topology app');
	});

	test('blast radius of a zone aggregates its nodes', () => {
		const blast = core.topology.blastRadius(admin, { kind: 'zone', id: 'cloud-a' });
		expect(blast.affectedNodes).toEqual([edge.nodeId]);
		expect(blast.summary.databases).toBe(1);
	});

	test('needs a platform admin', () => {
		expect(() => core.topology.view(member)).toThrow(/Platform admin/);
		expect(() => core.topology.blastRadius(member, { kind: 'node', id: worker.nodeId })).toThrow(/Platform admin/);
	});
});
