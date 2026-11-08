import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@skiff/core';
import { createDb } from '@skiff/db';

/**
 * Named database credential tools (docs/DATABASES.md §16) against a real core. They carry metadata
 * only: no password ever comes back over MCP, matching D58.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mcp-db-credentials-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(join(dir, 'objects'), 'https://control.test', 'object-secret-123');
const realCore: Core = createCore({
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
		features: { ...DEFAULT_FEATURES }
	}
});

mock.module('./core', () => ({ core: realCore }));
mock.module('./config', () => ({ platformOrigin: 'https://control.test', authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

async function call(name: string, args: Record<string, unknown>) {
	const tool = assistantTools(owner).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return { ok: result.ok, text: result.text, body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null };
}

describe('database credential MCP tools', () => {
	let nodeId = '';

	test('setup: a postgres database on a node', () => {
		const joined = realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		nodeId = joined.nodeId;
		realCore.databases.create(owner, { name: 'main-db' });
	});

	test('are registered with the right annotations and confirmation policy', () => {
		const definitions = new Map(skiffToolDefinitions(owner).map((entry) => [entry.name, entry]));
		expect(definitions.get('list_database_credentials')?.config.annotations?.readOnlyHint).toBe(true);
		expect(definitions.get('create_database_credential')?.config.annotations?.destructiveHint).toBe(false);
		expect(definitions.get('rotate_database_credential')?.config.annotations?.destructiveHint).toBe(false);
		expect(definitions.get('revoke_database_credential')?.config.annotations?.destructiveHint).toBe(true);
		// There is no reveal tool: secrets never travel over MCP.
		expect([...definitions.keys()].filter((name) => /reveal|password/.test(name))).toEqual([]);

		const tools = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		expect(tools.get('list_database_credentials')?.destructive).toBe(false);
		for (const name of ['create_database_credential', 'rotate_database_credential', 'revoke_database_credential'])
			expect(tools.get(name)?.destructive).toBe(true);
		const forViewer = new Set(assistantTools(viewer).map((entry) => entry.name));
		expect(forViewer.has('list_database_credentials')).toBe(true);
		expect(forViewer.has('create_database_credential')).toBe(false);
		expect(forViewer.has('revoke_database_credential')).toBe(false);
	});

	test('create, list, rotate and revoke return metadata only', async () => {
		const created = await call('create_database_credential', { database: 'main-db', role: 'readonly', purpose: 'BI' });
		expect(created.ok).toBe(true);
		const id = created.body!.credential.id as string;
		expect(created.body!.credential).toMatchObject({ role: 'readonly', status: 'pending', purpose: 'BI' });
		const secret = realCore.databases.credentialActivation(nodeId, id).password!;
		realCore.databases.applyCredentialResults(nodeId, [
			{ taskId: id, databaseId: created.body!.credential.databaseId, status: 'ok' }
		]);

		const listed = await call('list_database_credentials', { database: 'main-db' });
		expect(listed.body!.credentials.map((item: { role: string }) => item.role).sort()).toEqual([
			'monitor',
			'owner',
			'readonly'
		]);
		expect(listed.text).not.toContain(secret);
		expect(listed.text).not.toContain('password');

		const rotated = await call('rotate_database_credential', { database: 'main-db', credentialId: id });
		expect(rotated.body!.credential.status).toBe('pending');
		expect(rotated.text).not.toContain(realCore.databases.credentialActivation(nodeId, id).password!);
		realCore.databases.applyCredentialResults(nodeId, [
			{ taskId: id, databaseId: created.body!.credential.databaseId, status: 'ok' }
		]);

		const revoked = await call('revoke_database_credential', { database: 'main-db', credentialId: id });
		expect(revoked.body!.credential.status).toBe('revoking');
	});
});
