import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, nodeCapabilities } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** The read-replica MCP tools (list/create/delete; promotion is never exposed) against a real core. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-db-replicas-'));
const opened = createDb({ path: ':memory:' });
const realCore: Core = createCore({
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
		features: { ...DEFAULT_FEATURES }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { yoalToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');
const { CONFIRM_TOOLS } = await import('./assistant/confirm-policy');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });

async function call(name: string, args: Record<string, unknown>) {
	const tool = assistantTools(owner).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

describe('database replica tools', () => {
	test('setup: a postgres database and a second node that can run replicas', () => {
		const join = (name: string) => realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, name).token, name });
		const edge = join('edge');
		const worker = join('worker');
		for (const node of [edge, worker]) {
			realCore.nodes.update(owner, node.nodeId, { sliceMemoryMb: 4096 });
			realCore.nodes.heartbeat(node.token, {
				nodeId: node.nodeId,
				agentVersion: '0.1.0',
				actualStateVersion: 0,
				status: 'online',
				caddyOk: true,
				releases: [],
				capabilities: [...nodeCapabilities]
			});
		}
		opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.2' WHERE id = ?`, [edge.nodeId]);
		opened.sqlite.run(`UPDATE nodes SET private_address = '10.88.1.3' WHERE id = ?`, [worker.nodeId]);
		realCore.databases.create(owner, { name: 'main-db', placement: edge.nodeId });
	});

	test('promotion is not an MCP tool; removal is destructive; adding asks first in the assistant', () => {
		const names = yoalToolDefinitions(owner).map((entry) => entry.name);
		expect(names).toEqual(expect.arrayContaining(['list_database_replicas', 'create_database_replica', 'delete_database_replica']));
		expect(names.some((name) => name.includes('promote_database') || name.includes('replica_promote'))).toBe(false);
		const remove = yoalToolDefinitions(owner).find((entry) => entry.name === 'delete_database_replica');
		expect(remove?.config.annotations).toMatchObject({ destructiveHint: true });
		expect(CONFIRM_TOOLS.has('create_database_replica')).toBe(true);
	});

	test('create, list and delete through core', async () => {
		const created = await call('create_database_replica', { database: 'main-db', node: 'worker' });
		expect(created.ok).toBe(true);
		expect(created.body!.replica).toMatchObject({ nodeName: 'worker', status: 'pending', sameNode: false });
		const listed = await call('list_database_replicas', { database: 'main-db' });
		expect(listed.body!.replicas).toHaveLength(1);
		expect(listed.body!.primaryGeneration).toBe(0);
		const sync = await call('create_database_replica', { database: 'main-db', node: 'edge', mode: 'sync' });
		expect(sync.ok).toBe(false);
		expect(sync.text).toContain('Synchronous');
		const removed = await call('delete_database_replica', { database: 'main-db', replica: created.body!.replica.id });
		expect(removed.ok).toBe(true);
		expect(removed.body!.replica.removing).toBe(true);
	});
});
