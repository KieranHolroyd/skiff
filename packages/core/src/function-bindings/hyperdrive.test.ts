import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FEATURES, type FunctionBinding } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { createCore } from '../index.ts';
import { LocalObjectStore } from '../object-store.ts';
import { buildPrincipal } from '../orgs.ts';
import type { Core } from '../index.ts';
import { resolveHyperdrive } from './hyperdrive.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-hyperdrive-'));
const opened = createDb({ path: ':memory:' });
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
		now: () => Date.parse('2026-11-06T10:00:00Z'),
		features: { ...DEFAULT_FEATURES, FUNCTIONS: true },
	},
});

const owner = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner', platformAdmin: true });
const otherOrg = buildPrincipal({ kind: 'user', userId: 'user_2', orgId: 'org_2', role: 'owner', platformAdmin: true });

const node = core.nodes.join({ token: core.nodes.createJoinToken(owner, 'edge').token, name: 'edge' });
core.nodes.update(owner, node.nodeId, { sliceMemoryMb: 16_384 });
await core.projects.create(owner, {
	name: 'fn-api',
	slug: 'fn-api',
	runtime: 'function',
	placement: 'auto',
	productionAccess: 'public',
	previewAccess: 'platform',
});
const project = core.projects.requireRow(owner, 'fn-api');

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

function binding(database: string, overrides: Record<string, unknown> = {}): FunctionBinding {
	return { name: 'DB', type: 'hyperdrive', database, ...overrides } as FunctionBinding;
}

function resolve(database: string) {
	return resolveHyperdrive({ core: core.ctx, project }, binding(database));
}

describe('resolveHyperdrive', () => {
	test('resolves an attached Postgres database to its env prefix', async () => {
		core.databases.create(owner, { name: 'ledger', project: 'fn-api', envPrefix: 'LEDGER' });
		expect(await resolve('ledger')).toEqual({
			name: 'DB',
			type: 'hyperdrive',
			database: 'ledger',
			envPrefix: 'LEDGER',
		});
	});

	test('defaults to the attachment prefix the control plane stores', async () => {
		core.databases.create(owner, { name: 'plain', project: 'fn-api' });
		const resolved = await resolve('plain');
		expect(resolved).toMatchObject({ type: 'hyperdrive', envPrefix: 'DATABASE' });
	});

	test('refuses a database that is not attached to the project', async () => {
		core.databases.create(owner, { name: 'loose' });
		expect(() => resolve('loose')).toThrow(
			'Binding DB: attach database "loose" to this project before using it as a Hyperdrive binding.',
		);
	});

	test('refuses a database that does not exist in the caller org', async () => {
		expect(() => resolve('missing')).toThrow(
			'Binding DB: database "missing" does not exist in this organisation.',
		);
		// Same name in another org is not visible here.
		core.databases.create(otherOrg, { name: 'secret-db' });
		expect(() => resolve('secret-db')).toThrow(/does not exist in this organisation/);
	});

	test('refuses a non-Postgres database', async () => {
		core.databases.create(owner, {
			name: 'cache-db',
			engine: 'valkey',
			version: '8.1',
			project: 'fn-api',
		});
		expect(() => resolve('cache-db')).toThrow(
			'Binding DB: database "cache-db" is valkey; Hyperdrive bindings need a Postgres database.',
		);
	});

	test('refuses a deleted database', async () => {
		core.databases.create(owner, { name: 'gone' });
		core.databases.delete(owner, 'gone');
		expect(() => resolve('gone')).toThrow(/does not exist in this organisation/);
	});

	test('refuses a binding of another type', () => {
		expect(() =>
			resolveHyperdrive({ core: core.ctx, project }, { name: 'GREETING', type: 'text', value: 'hi' }),
		).toThrow(/not "hyperdrive"/);
	});
});
