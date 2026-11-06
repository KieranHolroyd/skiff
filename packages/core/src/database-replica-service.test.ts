import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-db-replicas-'));
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
const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const edge = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
const worker = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'worker').token, name: 'worker' });
opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.2' WHERE id = ?`, [worker.nodeId]);

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('database replica registry', () => {
	test('adds, lists and removes a replica on another node', () => {
		core.databases.create(owner, { name: 'orders', placement: edge.nodeId });
		const added = core.databaseReplicas.add(owner, 'orders', { node: worker.nodeId });
		expect(added).toMatchObject({ nodeId: worker.nodeId, status: 'pending', nodeName: 'worker' });
		expect(core.databaseReplicas.list(owner, 'orders')).toHaveLength(1);
		expect(core.databaseReplicas.remove(owner, 'orders', added.id)).toEqual({ ok: true });
		expect(core.databaseReplicas.list(owner, 'orders')).toEqual([]);
	});

	test('refuses the primary node and a node without an overlay address', () => {
		core.databases.create(owner, { name: 'billing', placement: edge.nodeId });
		expect(() => core.databaseReplicas.add(owner, 'billing', { node: edge.nodeId })).toThrow(/different node/);
		opened.sqlite.run(`UPDATE nodes SET private_address = NULL WHERE id = ?`, [worker.nodeId]);
		expect(() => core.databaseReplicas.add(owner, 'billing', { node: worker.nodeId })).toThrow(/overlay/);
	});
});
