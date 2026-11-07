import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@skiff/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@skiff/core';
import { createDb } from '@skiff/db';

/**
 * Named storage key tools (docs/OBJECT-STORAGE.md §5) against a real core. Metadata only: a key's
 * secret never comes back over MCP (D67).
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-mcp-storage-keys-'));
const opened = createDb({ path: ':memory:' });
const store = new LocalObjectStore(
	join(dir, 'objects'),
	'https://control.test',
	'object-secret-123'
);
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
mock.module('./config', () => ({ authSecret: 'test-secret' }));
mock.module('./principal', () => principalStub({ principalFromMcp: () => null }));

const { skiffToolDefinitions } = await import('./mcp');
const { assistantTools } = await import('./assistant/tools');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const owner = buildPrincipal({
	kind: 'user',
	userId: 'user_1',
	orgId: 'org_1',
	role: 'owner',
	platformAdmin: true
});
const viewer = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_1', role: 'viewer' });

async function call(name: string, args: Record<string, unknown>) {
	const tool = assistantTools(owner).find((entry) => entry.name === name);
	if (!tool) throw new Error(`no tool ${name}`);
	const result = await tool.run(args);
	return {
		ok: result.ok,
		text: result.text,
		body: result.ok ? (JSON.parse(result.text) as Record<string, any>) : null
	};
}

describe('storage key MCP tools', () => {
	test('setup: a storage instance with a bucket', () => {
		realCore.nodes.join({
			token: realCore.nodes.createJoinToken(owner, 'edge').token,
			name: 'edge'
		});
		realCore.storage.create(owner, { name: 'media', buckets: ['uploads'] });
	});

	test('are registered with the right annotations, and there is no reveal tool', () => {
		const definitions = new Map(skiffToolDefinitions(owner).map((entry) => [entry.name, entry]));
		expect(definitions.get('list_storage_keys')?.config.annotations?.readOnlyHint).toBe(true);
		expect(definitions.get('create_storage_key')?.config.annotations?.destructiveHint).toBe(false);
		expect(definitions.get('revoke_storage_key')?.config.annotations?.destructiveHint).toBe(true);
		expect(
			[...definitions.keys()].filter((name) => /storage.*(reveal|secret|credential)/.test(name))
		).toEqual([]);

		const tools = new Map(assistantTools(owner).map((entry) => [entry.name, entry]));
		expect(tools.get('list_storage_keys')?.destructive).toBe(false);
		// Creating a key widens access, so the assistant asks first too.
		expect(tools.get('create_storage_key')?.destructive).toBe(true);
		expect(tools.get('revoke_storage_key')?.destructive).toBe(true);
		const forViewer = new Set(assistantTools(viewer).map((entry) => entry.name));
		expect(forViewer.has('list_storage_keys')).toBe(true);
		expect(forViewer.has('create_storage_key')).toBe(false);
		expect(forViewer.has('revoke_storage_key')).toBe(false);
	});

	test('create, list and revoke return metadata only', async () => {
		const created = await call('create_storage_key', {
			storage: 'media',
			name: 'backup-tool',
			grants: [{ bucket: 'uploads', mode: 'read' }],
			purpose: 'nightly offsite copy'
		});
		expect(created.ok).toBe(true);
		const id = created.body!.key.id as string;
		expect(created.body!.key).toMatchObject({
			name: 'backup-tool',
			status: 'active',
			grants: [{ bucket: 'uploads', mode: 'read' }]
		});
		const secret = realCore.storage.revealKey(owner, 'media', id).secretAccessKey;
		expect(created.text).not.toContain(secret);

		const listed = await call('list_storage_keys', { storage: 'media' });
		expect(listed.body!.keys.map((key: { name: string }) => key.name)).toEqual(['backup-tool']);
		expect(listed.text).not.toContain(secret);
		expect(listed.text).not.toContain('secretAccessKey');

		const revoked = await call('revoke_storage_key', { storage: 'media', keyId: id });
		expect(revoked.body!.key.status).toBe('revoked');
	});
});
