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
