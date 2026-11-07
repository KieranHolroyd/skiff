import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-replicas-'));
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
		features: { ...DEFAULT_FEATURES, MULTI_NODE_REPLICAS: true, SERVICE_ENDPOINTS: false },
	},
});
const principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
core.nodes.join({ token: core.nodes.createJoinToken(principal, 'edge').token, name: 'edge' });
core.nodes.join({ token: core.nodes.createJoinToken(principal, 'worker-a').token, name: 'worker-a' });
core.nodes.join({ token: core.nodes.createJoinToken(principal, 'worker-b').token, name: 'worker-b' });
core.nodes.join({ token: core.nodes.createJoinToken(principal, 'worker-c').token, name: 'worker-c' });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('multi-node replica planning', () => {
	test('a 2-replica HTTP app is assigned to two workers', async () => {
		const project = await core.projects.create(principal, {
			name: 'Replicated app',
			slug: 'replicated-app',
			runtime: 'process',
			placement: 'auto',
			productionAccess: 'public',
			previewAccess: 'platform',
		});
		const resolved = core.workloads.plan(principal, core.projects.requireRow(principal, project.slug), {
			replicas: 2,
			ingress: 'http',
		});
		expect(resolved.replicas).toHaveLength(2);
		expect(new Set(resolved.replicas!.map((replica) => replica.nodeId)).size).toBe(2);
		expect(resolved.replicas!.map((replica) => replica.index)).toEqual([0, 1]);

		core.workloads.record(core.projects.requireRow(principal, project.slug), 'dep_replicated', resolved);
		// A draining node's copies move through the failover controller (failover off or on).
		const failed = resolved.replicas![0]!.nodeId;
		opened.sqlite.run(`UPDATE nodes SET status = 'draining' WHERE id = ?`, [failed]);
		expect((await core.failover.tick()).moved).toBe(1);
		const rows = opened.sqlite
			.query<{ nodeId: string }, []>('SELECT node_id AS nodeId FROM workload_replicas ORDER BY replica_index')
			.all();
		expect(rows.some((row) => row.nodeId === failed)).toBe(false);
		expect(new Set(rows.map((row) => row.nodeId)).size).toBe(2);
	});
});
