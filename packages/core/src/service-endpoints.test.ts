import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-endpoint-'));
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
		features: { ...DEFAULT_FEATURES, SERVICE_ENDPOINTS: true },
	},
});

const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const edge = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
const worker = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'worker').token, name: 'worker' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('cross-node database endpoint', () => {
	test('a process app on another node gets a loopback endpoint and env URL', async () => {
		const project = await core.projects.create(principal, {
			name: 'Endpoint app',
			slug: 'endpoint-app',
			runtime: 'process',
			placement: 'edge',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		core.databases.create(principal, { name: 'remote-db', placement: worker.nodeId });
		core.databases.attach(principal, core.projects.requireRow(principal, project.slug), {
			database: 'remote-db',
			envPrefix: 'DB',
		});

		const resolved = core.workloads.plan(principal, core.projects.requireRow(principal, project.slug));
		expect(resolved.nodeId).toBe(edge.nodeId);
		const endpoint = opened.sqlite
			.query<{ localPort: number; upstreamNodeId: string; upstreamPort: number }, [string]>(
				'SELECT local_port AS localPort, upstream_node_id AS upstreamNodeId, upstream_port AS upstreamPort FROM service_endpoints WHERE consumer_node_id = ?',
			)
			.get(edge.nodeId);
		expect(endpoint).toMatchObject({ upstreamNodeId: worker.nodeId, localPort: 21_000 });

		const env = core.databases.consumerEnv(project.id, edge.nodeId, 'process');
		expect(env.DB_URL).toContain('127.0.0.1:21000');
		expect(env.DB_HOST).toBe('127.0.0.1');

		core.storage.create(principal, { name: 'remote-s3', placement: worker.nodeId, buckets: ['uploads'] });
		core.storage.attach(principal, core.projects.requireRow(principal, project.slug), {
			storage: 'remote-s3',
			envPrefix: 'S3',
			grants: [{ bucket: 'uploads' }],
		});
		core.workloads.plan(principal, core.projects.requireRow(principal, project.slug));
		const storageEnv = core.storage.consumerEnv(project.id, edge.nodeId, 'process');
		expect(storageEnv.S3_ENDPOINT_URL).toBe('http://127.0.0.1:21001');

		opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.2' WHERE id = ?`, [worker.nodeId]);
		const workerState = await core.nodes.desiredState(worker.token);
		expect(workerState.serviceProviders).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ listenPort: endpoint!.upstreamPort, targetPort: endpoint!.upstreamPort }),
			]),
		);
	});
});

/** A workload row for a project placed on a node, as a deploy would leave it. */
function placeWorkload(projectId: string, nodeId: string): void {
	opened.sqlite.run(
		`INSERT INTO workloads (id, org_id, project_id, deployment_id, node_id, runtime, status, spec_json, memory_mb, cpus, created_at, updated_at)
		 VALUES (?, 'org_1', ?, 'dep_x', ?, 'process', 'running', '{}', 128, 1, ?, ?)`,
		[`wl_${projectId}`, projectId, nodeId, clock, clock],
	);
}

describe('endpoint reconcile across projects (pre-existing bug)', () => {
	test('re-planning one project keeps the endpoints other projects on the node use', async () => {
		const consumer = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'shared').token, name: 'shared' });
		const provider = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'provider').token, name: 'provider' });
		core.nodes.update(principal, consumer.nodeId, { sliceMemoryMb: 4096 });
		const make = async (slug: string, database: string) => {
			const project = await core.projects.create(principal, {
				name: slug,
				slug,
				runtime: 'process',
				placement: consumer.nodeId,
				productionAccess: 'public',
				previewAccess: 'platform',
			});
			core.databases.create(principal, { name: database, placement: provider.nodeId });
			core.databases.attach(principal, core.projects.requireRow(principal, slug), { database, envPrefix: 'DB' });
			return project;
		};
		const first = await make('first-app', 'first-db');
		core.endpoints.reconcile(first.id, consumer.nodeId);
		placeWorkload(first.id, consumer.nodeId);
		const second = await make('second-app', 'second-db');
		core.endpoints.reconcile(second.id, consumer.nodeId);
		const rows = () =>
			opened.sqlite
				.query<{ serviceId: string; localPort: number }, [string]>(
					'SELECT service_id AS serviceId, local_port AS localPort FROM service_endpoints WHERE consumer_node_id = ? ORDER BY local_port',
				)
				.all(consumer.nodeId);
		const firstDb = core.databases.get(principal, 'first-db').id;
		const secondDb = core.databases.get(principal, 'second-db').id;
		// Before the fix the second reconcile deleted first-db's endpoint (and could reuse its port).
		expect(rows().map((row) => row.serviceId).sort()).toEqual([firstDb, secondDb].sort());
		expect(new Set(rows().map((row) => row.localPort)).size).toBe(2);
		expect(core.databases.consumerEnv(first.id, consumer.nodeId, 'process').DB_URL).toContain('127.0.0.1:');
	});

	test('two consumer nodes on one database share one provider listener', async () => {
		const provider = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'p2').token, name: 'p2' });
		const a = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'c-a').token, name: 'c-a' });
		const b = core.nodes.join({ token: core.nodes.createJoinToken(principal, 'c-b').token, name: 'c-b' });
		opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.9' WHERE id = ?`, [provider.nodeId]);
		const fingerprint = (char: string) => char.repeat(64);
		for (const [node, char] of [[a, 'a'], [b, 'b']] as const)
			core.nodes.heartbeat(node.token, {
				nodeId: node.nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 0,
				status: 'online',
				caddyOk: true,
				releases: [],
				nodeCertificate: { certPem: 'pem', fingerprint: fingerprint(char), expiresAt: new Date(clock + 86_400_000).toISOString() },
			});
		const db = core.databases.create(principal, { name: 'shared-db', placement: provider.nodeId });
		const port = Number(db.internalHost.process.split(':')[1]);
		for (const [node, local] of [[a, 21_000], [b, 21_000]] as const)
			opened.sqlite.run(
				`INSERT INTO service_endpoints (id, consumer_node_id, service_kind, service_id, local_port, upstream_node_id, upstream_port, created_at, updated_at)
				 VALUES (?, ?, 'database', ?, ?, ?, ?, ?, ?)`,
				[`sep_${node.nodeId}`, node.nodeId, db.id, local, provider.nodeId, port, clock, clock],
			);
		const state = await core.nodes.desiredState(provider.token);
		const listeners = state.serviceProviders.filter((item) => item.listenPort === port);
		// Before the fix: two providers on one port, and the agent kept only the last one.
		expect(listeners).toHaveLength(1);
		expect(listeners[0]!.allowedClientFingerprints).toEqual([fingerprint('a'), fingerprint('b')]);
	});
});
