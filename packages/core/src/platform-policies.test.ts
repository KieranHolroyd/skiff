import { Database } from 'bun:sqlite';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_POLICIES_KEY, PLATFORM_POLICY_DEFAULTS } from '@skiff/contracts';
import { createDb } from '@skiff/db';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal, renameOrganization } from './orgs.ts';
import { ValidationError } from './errors.ts';

const dir = mkdtempSync(join(tmpdir(), 'skiff-policies-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeCore(): Core {
	const opened = createDb({ path: ':memory:' });
	return createCore({
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
		},
	});
}

const admin = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_a', role: 'owner', platformAdmin: true });

describe('platform policies', () => {
	test('default to the values that used to be hardcoded', () => {
		const core = makeCore();
		expect(core.policies.get()).toEqual(PLATFORM_POLICY_DEFAULTS);
		expect(core.policies.trashMs()).toBe(7 * 86_400_000);
		expect(core.ctx.quota.retention('org_a')).toBe(10);
	});

	test('an update merges, persists and is read by the services', () => {
		const core = makeCore();
		core.policies.update(admin, { trashDays: 14, retainedDeployments: 3 });
		expect(core.policies.get().trashDays).toBe(14);
		expect(core.policies.get().logRetentionDays).toBe(7);
		expect(core.ctx.quota.retention('org_a')).toBe(3);
		const row = core.ctx.sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(PLATFORM_POLICIES_KEY);
		expect(JSON.parse(row!.value).trashDays).toBe(14);
	});

	test('rejects out-of-range values, unknown keys and an incoherent certificate pair', () => {
		const core = makeCore();
		expect(() => core.policies.update(admin, { trashDays: 0 })).toThrow(ValidationError);
		expect(() => core.policies.update(admin, { nope: 1 })).toThrow(ValidationError);
		expect(() => core.policies.update(admin, { databaseBackupSchedule: 'every day' })).toThrow(ValidationError);
		expect(() => core.policies.update(admin, { certCriticalDays: 20 })).toThrow(ValidationError);
		expect(core.policies.get()).toEqual(PLATFORM_POLICY_DEFAULTS);
	});

	test('only a platform admin session changes them', () => {
		const core = makeCore();
		const orgOwner = buildPrincipal({ kind: 'user', userId: 'user_b', orgId: 'org_a', role: 'owner' });
		const adminKey = buildPrincipal({ kind: 'apiKey', userId: 'user_admin', orgId: 'org_a', role: 'owner', platformAdmin: true });
		for (const principal of [orgOwner, adminKey])
			expect(() => core.policies.update(principal, { trashDays: 30 })).toThrow(/platform admin/);
		expect(core.policies.get().trashDays).toBe(PLATFORM_POLICY_DEFAULTS.trashDays);
	});

	test('a bad stored field falls back to its default without losing the others', () => {
		const core = makeCore();
		core.ctx.sqlite.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)', [
			PLATFORM_POLICIES_KEY,
			JSON.stringify({ trashDays: 9999, logRetentionDays: 3 }),
		]);
		expect(core.policies.get().trashDays).toBe(7);
		expect(core.policies.get().logRetentionDays).toBe(3);
	});
});

describe('renameOrganization', () => {
	function authDb() {
		const sqlite = new Database(':memory:');
		sqlite.run('CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, createdAt TEXT)');
		sqlite.run("INSERT INTO organization VALUES ('org_a', 'Personal', 'org-aaaa', ''), ('org_b', 'Other', 'taken', '')");
		return sqlite;
	}
	const owner = buildPrincipal({ kind: 'user', userId: 'u1', orgId: 'org_a', role: 'owner' });

	test('owners and admins rename name and slug', () => {
		const sqlite = authDb();
		expect(renameOrganization(sqlite, owner, { name: '  Acme   Ltd ', slug: 'Acme-Ltd' })).toEqual({
			name: 'Acme Ltd',
			slug: 'acme-ltd',
		});
		const admin = buildPrincipal({ kind: 'user', userId: 'u2', orgId: 'org_a', role: 'admin' });
		renameOrganization(sqlite, admin, { name: 'Acme', slug: 'acme' });
		expect(sqlite.query('SELECT name, slug FROM organization WHERE id = ?').get('org_a')).toEqual({
			name: 'Acme',
			slug: 'acme',
		});
	});

	test('deployers, API keys, bad slugs and taken slugs are refused', () => {
		const sqlite = authDb();
		const deployer = buildPrincipal({ kind: 'user', userId: 'u3', orgId: 'org_a', role: 'deployer' });
		const key = buildPrincipal({ kind: 'apiKey', userId: 'u1', orgId: 'org_a', role: 'owner' });
		expect(() => renameOrganization(sqlite, deployer, { name: 'X', slug: 'xx' })).toThrow(/owner or admin/);
		expect(() => renameOrganization(sqlite, key, { name: 'X', slug: 'xx' })).toThrow(/owner or admin/);
		expect(() => renameOrganization(sqlite, owner, { name: 'X', slug: 'a--b' })).toThrow(/slug/);
		expect(() => renameOrganization(sqlite, owner, { name: '', slug: 'ok' })).toThrow(/name/);
		expect(() => renameOrganization(sqlite, owner, { name: 'X', slug: 'taken' })).toThrow(/already used/);
	});
});
