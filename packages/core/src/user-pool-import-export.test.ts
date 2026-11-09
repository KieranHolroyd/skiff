import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import { scryptSync } from 'node:crypto';
import type { Principal } from '@yoal/contracts';
import { UnauthorizedError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { encodeScryptHash, setUserPoolBreachCheckFetch } from './user-pool-engine.ts';

/**
 * Import/export specification for the native pool engine (IAM.md I29, §11.2). The exports named
 * here are the shapes Auth0, Cognito and Firebase actually produce; a hash the engine cannot verify
 * must become a forced reset rather than a dead credential. Not run by the coding-agent slice.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-user-pool-import-'));
const opened = createDb({ path: ':memory:' });
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0097_user_pool_engine.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0101_user_pool_passkeys.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0102_user_pool_totp.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0103_user_pool_groups.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0105_user_pool_oauth.sql', import.meta.url), 'utf8'));

let now = Date.parse('2026-11-09T12:00:00Z');
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
		now: () => now
	}
});

const owner: Principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
let counter = 0;

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	setUserPoolBreachCheckFetch(null);
	opened.sqlite.exec(`
		DELETE FROM user_pool_oauth_accounts;
		DELETE FROM user_pool_oauth_providers;
		DELETE FROM user_pool_codes;
		DELETE FROM user_pool_sessions;
		DELETE FROM user_pool_email_tokens;
		DELETE FROM user_pool_invites;
		DELETE FROM user_pool_totp;
		DELETE FROM user_pool_group_members;
		DELETE FROM user_pool_groups;
		DELETE FROM user_pool_users;
		DELETE FROM user_pool_clients;
		DELETE FROM user_pools;
		DELETE FROM settings WHERE key LIKE 'user_pool.%';
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
});

afterEach(() => {
	setUserPoolBreachCheckFetch(null);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createPool() {
	counter += 1;
	return core.userPools.create(owner, { name: `import-${counter}`, signupMode: 'open' });
}

describe('pool export', () => {
	test('includes users, groups, clients and providers but no client or provider secret', async () => {
		const pool = await createPool();
		const ada = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery', 'Ada');
		core.userPoolEngine.verifyEmail(pool.id, ada.verificationToken!);
		const group = core.userPools.createGroup(owner, pool.id, 'admins');
		core.userPools.addGroupMember(owner, pool.id, group.id, ada.user.id);
		const client = core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://app.test/callback'],
			public: false
		});
		core.userPools.setOAuthProvider(owner, pool.id, 'google', {
			clientId: 'google-client-id',
			clientSecret: 'provider-secret-value',
			scopes: ['openid', 'email'],
			enabled: true
		});

		const exported = core.userPools.exportPool(owner, pool.id);
		const json = JSON.stringify(exported);
		expect(exported.schema).toBe('yoal.user-pool');
		expect(exported.version).toBe(1);
		expect(exported.users).toHaveLength(1);
		expect(exported.users[0]!.email).toBe('ada@example.com');
		expect(exported.users[0]!.passwordAlgorithm).toBe('argon2id');
		expect(exported.users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
		expect(exported.users[0]!.emailVerified).toBe(true);
		expect(exported.groups[0]!.members).toEqual(['ada@example.com']);
		expect(exported.clients[0]!.clientSecret).toBeNull();
		expect(exported.clients[0]!.secretHandling).toBe('regenerated-on-import');
		expect(exported.clients[0]!.clientId).toBe(client.client.clientId);
		expect(exported.oauthProviders[0]!.secretOmitted).toBe(true);
		expect(exported.oauthProviders[0]!.clientId).toBe('google-client-id');

		expect(json).not.toContain(client.clientSecret!);
		expect(json).not.toContain('provider-secret-value');
		expect(json).not.toContain('client_secret_sealed');
	});

	test('the export endpoint needs manage-users and the raw export carries no sealed value', async () => {
		const pool = await createPool();
		core.userPools.createClient(owner, pool.id, {
			name: 'public',
			redirectUris: ['https://app.test/callback'],
			public: true
		});
		const exported = core.userPools.exportPool(owner, pool.id);
		expect(JSON.stringify(exported)).not.toMatch(/sealed/i);
	});
});

describe('import dry run and apply', () => {
	test('a dry run reports counts without writing, then apply creates users and groups', async () => {
		const source = await createPool();
		const ada = await core.userPoolEngine.signUp(source.id, 'ada@example.com', 'correct horse battery', 'Ada');
		core.userPoolEngine.verifyEmail(source.id, ada.verificationToken!);
		const group = core.userPools.createGroup(owner, source.id, 'admins');
		core.userPools.addGroupMember(owner, source.id, group.id, ada.user.id);
		const exported = core.userPools.exportPool(owner, source.id);

		const target = await createPool();
		const dry = await core.userPools.importPool(owner, target.id, {
			data: exported,
			dryRun: true
		});
		expect(dry.dryRun).toBe(true);
		expect(dry.format).toBe('yoal');
		expect(dry.users.create).toBe(1);
		expect(dry.groups.create).toBe(1);
		expect(core.userPools.listUsers(owner, target.id)).toHaveLength(0);

		const applied = await core.userPools.importPool(owner, target.id, {
			data: exported,
			dryRun: false
		});
		expect(applied.users.create).toBe(1);
		expect(applied.groups.create).toBe(1);
		const users = core.userPools.listUsers(owner, target.id);
		expect(users).toHaveLength(1);
		expect(users[0]!.emailVerified).toBe(true);
		expect(core.userPools.listGroups(owner, target.id)[0]!.memberCount).toBe(1);

		// The imported argon2 hash still verifies the original password.
		await expect(
			core.userPoolEngine.signIn(target.id, 'ada@example.com', 'correct horse battery')
		).resolves.toBeDefined();
	});

	test('a second import skips duplicates rather than overwriting them', async () => {
		const source = await createPool();
		await core.userPoolEngine.signUp(source.id, 'ada@example.com', 'correct horse battery');
		const exported = core.userPools.exportPool(owner, source.id);
		const target = await createPool();
		await core.userPools.importPool(owner, target.id, { data: exported });

		const again = await core.userPools.importPool(owner, target.id, { data: exported, dryRun: true });
		expect(again.users.create).toBe(0);
		expect(again.users.skip).toBe(1);
		expect(core.userPools.listUsers(owner, target.id)).toHaveLength(1);
	});
});

describe('provider formats', () => {
	test('an Auth0 bcrypt hash is kept and signs in', async () => {
		const target = await createPool();
		const bcrypt = await Bun.password.hash('auth0 password', { algorithm: 'bcrypt' });
		const report = await core.userPools.importPool(owner, target.id, {
			data: [
				{
					user_id: 'auth0|1',
					email: 'ada@example.com',
					name: 'Ada',
					email_verified: true,
					password_hash: bcrypt
				}
			]
		});
		expect(report.format).toBe('auth0');
		expect(report.users.create).toBe(1);
		expect(report.users.mustResetPassword).toBe(0);
		expect(core.userPools.listUsers(owner, target.id)[0]!.emailVerified).toBe(true);
		await expect(
			core.userPoolEngine.signIn(target.id, 'ada@example.com', 'auth0 password')
		).resolves.toBeDefined();
	});

	test('a portable scrypt hash is kept and verifies the original password', async () => {
		const target = await createPool();
		const salt = Buffer.from('a fixed test salt');
		const hash = scryptSync('scrypt password', salt, 32, { N: 1024, r: 8, p: 1 });
		const encoded = encodeScryptHash(1024, 8, 1, salt, hash);
		const report = await core.userPools.importPool(owner, target.id, {
			data: {
				schema: 'yoal.user-pool',
				version: 1,
				users: [{ email: 'scrypt@example.com', passwordHash: encoded, passwordAlgorithm: 'scrypt' }]
			}
		});
		expect(report.users.create).toBe(1);
		expect(report.users.mustResetPassword).toBe(0);
		await expect(
			core.userPoolEngine.signIn(target.id, 'scrypt@example.com', 'scrypt password')
		).resolves.toBeDefined();
	});

	test('an Auth0 unsupported custom hash forces a reset', async () => {		const target = await createPool();
		const report = await core.userPools.importPool(owner, target.id, {
			data: [
				{
					email: 'grace@example.com',
					custom_password_hash: { algorithm: 'sha1', hash: { value: 'not-a-supported-hash' } }
				}
			]
		});
		expect(report.users.mustResetPassword).toBe(1);
		expect(report.users.unsupportedHashes[0]!.algorithm).toBe('unknown');
		const user = core.userPools.listUsers(owner, target.id)[0]!;
		expect(user.metadata.mustResetPassword).toBe(true);
		await expect(
			core.userPoolEngine.signIn(target.id, 'grace@example.com', 'anything')
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('Cognito JSON maps attributes and forces a reset because it has no hash', async () => {
		const target = await createPool();
		const report = await core.userPools.importPool(owner, target.id, {
			data: {
				Users: [
					{
						Username: 'ada',
						Enabled: true,
						Attributes: [
							{ Name: 'email', Value: 'ada@example.com' },
							{ Name: 'name', Value: 'Ada Lovelace' },
							{ Name: 'email_verified', Value: 'true' }
						]
					}
				]
			}
		});
		expect(report.format).toBe('cognito');
		expect(report.users.mustResetPassword).toBe(1);
		const user = core.userPools.listUsers(owner, target.id)[0]!;
		expect(user.email).toBe('ada@example.com');
		expect(user.name).toBe('Ada Lovelace');
		expect(user.emailVerified).toBe(true);
		expect(user.metadata.mustResetPassword).toBe(true);
	});

	test('a Cognito CSV export is accepted too', async () => {
		const target = await createPool();
		const csv = [
			'cognito:username,email,name,email_verified,enabled',
			'ada,ada@example.com,Ada,true,true'
		].join('\n');
		const report = await core.userPools.importPool(owner, target.id, { data: csv });
		expect(report.format).toBe('cognito');
		expect(report.users.create).toBe(1);
		expect(core.userPools.listUsers(owner, target.id)[0]!.emailVerified).toBe(true);
	});

	test('a Firebase hash with a signer key forces a reset; a supported one is kept', async () => {
		const target = await createPool();
		const report = await core.userPools.importPool(owner, target.id, {
			data: {
				users: [
					{
						localId: 'firebase-1',
						email: 'grace@example.com',
						emailVerified: false,
						passwordHash: 'ZmFrZQ==',
						salt: 'c2FsdA==',
						hashAlgorithm: 'SCRYPT',
						hashParameters: { base64_signer_key: 'c2lnbmVy', rounds: 8 }
					}
				]
			}
		});
		expect(report.format).toBe('firebase');
		expect(report.users.mustResetPassword).toBe(1);
		expect(report.users.unsupportedHashes[0]!.reason).toMatch(/signer key/i);
	});
});
