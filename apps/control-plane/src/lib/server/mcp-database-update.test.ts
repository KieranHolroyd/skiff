import { afterAll, describe, expect, mock, test } from 'bun:test';
import { principalStub } from './principal-stub.test-support';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES } from '@yoal/contracts';
import { LocalObjectStore, buildPrincipal, createCore, type Core } from '@yoal/core';
import { createDb } from '@yoal/db';

/** `update_database` (the MCP twin of `PATCH /databases/:name` and `yoal db update`) against a real core. */

const dir = mkdtempSync(join(tmpdir(), 'yoal-mcp-db-update-'));
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

describe('update_database', () => {
	test('setup: a postgres database on a node', () => {
		realCore.nodes.join({ token: realCore.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
		realCore.databases.create(owner, { name: 'main-db' });
	});

	test('is registered as non-destructive, but the assistant asks first', () => {
		const definition = yoalToolDefinitions(owner).find((entry) => entry.name === 'update_database');
		expect(definition?.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
		expect(CONFIRM_TOOLS.has('update_database')).toBe(true);
	});

	test('resizes and toggles the pooler through core', async () => {
		const result = await call('update_database', { database: 'main-db', memoryMb: 512, pooler: false });
		expect(result.ok).toBe(true);
		expect(result.body!.database).toMatchObject({ name: 'main-db', memoryMb: 512 });
		expect(realCore.databases.get(owner, 'main-db').memoryMb).toBe(512);
	});

	test('refuses a PostgreSQL major and points at the upgrade planner', async () => {
		const result = await call('update_database', { database: 'main-db', version: '18' });
		expect(result.ok).toBe(false);
		expect(result.text).toContain('yoal db upgrade main-db --to 18 --plan');
		expect(realCore.databases.get(owner, 'main-db').version).toBe('17');
	});
});
