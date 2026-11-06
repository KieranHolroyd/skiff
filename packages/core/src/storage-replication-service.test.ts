import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import { buildPrincipal } from './orgs.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-storage-repl-'));
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
core.nodes.update(owner, edge.nodeId, { sliceMemoryMb: 4096 });
core.nodes.update(owner, worker.nodeId, { sliceMemoryMb: 4096 });

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('storage replication registry', () => {
	test('links a source to a passive target on another node', () => {
		core.storage.create(owner, { name: 'primary-store', placement: edge.nodeId });
		core.storage.create(owner, { name: 'passive-store', placement: worker.nodeId });
		const added = core.storageReplication.add(owner, 'primary-store', { target: 'passive-store' });
		expect(added).toMatchObject({ sourceName: 'primary-store', targetName: 'passive-store', status: 'pending' });
		expect(core.storageReplication.list(owner, 'primary-store')).toHaveLength(1);
		expect(core.storageReplication.remove(owner, 'primary-store', added.id)).toEqual({ ok: true });
		expect(core.storageReplication.list(owner, 'primary-store')).toEqual([]);
	});

	test('refuses a target on the same node or a public target', () => {
		core.storage.create(owner, { name: 'same-a', placement: edge.nodeId });
		core.storage.create(owner, { name: 'same-b', placement: edge.nodeId });
		expect(() => core.storageReplication.add(owner, 'same-a', { target: 'same-b' })).toThrow(/another node/);
	});
});
