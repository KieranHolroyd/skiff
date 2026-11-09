import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';

/**
 * User-pool attachments (IAM.md I28, §11.2). These tests are the specification for the slice:
 * env injection, the sealed-secret path, attach/detach rules, event shape and `env.AUTH.verify`.
 *
 * `packages/db/src/migrations.ts` is regenerated separately, so the attachment table is applied
 * from its migration file here. The engine tables (0097) are already in the checked-in bundle.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-user-pool-attachments-'));
const opened = createDb({ path: ':memory:' });
opened.sqlite.exec(
	readFileSync(new URL('../../db/migrations/0099_user_pool_attachments.sql', import.meta.url), 'utf8')
);
opened.sqlite.exec(
	readFileSync(new URL('../../db/migrations/0101_user_pool_passkeys.sql', import.meta.url), 'utf8')
);
opened.sqlite.exec(
	readFileSync(new URL('../../db/migrations/0102_user_pool_totp.sql', import.meta.url), 'utf8')
);
opened.sqlite.exec(
	readFileSync(new URL('../../db/migrations/0103_user_pool_groups.sql', import.meta.url), 'utf8')
);

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
const otherOrg: Principal = buildPrincipal({ kind: 'user', userId: 'user_9', orgId: 'org_2', role: 'owner' });
let sequence = 0;

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM user_pool_attachments;
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
		DELETE FROM event_deliveries;
		DELETE FROM event_rules;
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function pool(name = 'shop', signupMode: 'open' | 'invite' = 'open') {
	// Pools are cleared before each test, so a fixed name is unique within one case.
	return core.userPools.create(owner, { name, signupMode });
}

function client(poolId: string, options: { name?: string; public?: boolean } = {}) {
	return core.userPools.createClient(owner, poolId, {
		name: options.name ?? 'web-app',
		redirectUris: ['https://app.test/auth/callback'],
		public: options.public ?? false
	});
}

async function project(name: string, runtime: 'process' | 'static' = 'process') {
	sequence += 1;
	const slug = `${name}-${sequence}`.slice(0, 40);
	await core.projects.create(owner, {
		name,
		slug,
		runtime,
		placement: 'auto',
		productionAccess: 'public',
		previewAccess: 'public'
	});
	return core.projects.requireRow(owner, slug);
}

describe('attachment env and secret path', () => {
	test('injects ISSUER, CLIENT_ID and CLIENT_SECRET under the attachment prefix', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const target = await project('shop-app');
		const { attachment } = core.userPools.attach(owner, target, {
			pool: created.name,
			client: app.client.name
		});

		expect(attachment).toMatchObject({
			poolName: created.name,
			clientName: app.client.name,
			clientId: app.client.clientId,
			projectSlug: target.slug,
			envPrefix: 'SHOP'
		});
		expect(attachment.envNames).toEqual([
			'SHOP_ISSUER',
			'SHOP_CLIENT_ID',
			'SHOP_CLIENT_SECRET'
		]);

		const env = core.userPools.consumerEnv(target.id);
		expect(env).toEqual({
			SHOP_ISSUER: created.issuer,
			SHOP_CLIENT_ID: app.client.clientId,
			SHOP_CLIENT_SECRET: app.clientSecret!
		});
		// The attachment view is safe to put in desired state and page data.
		expect(JSON.stringify(attachment)).not.toContain(app.clientSecret!);
		expect(core.userPools.consumerVersion(target.id)).not.toBe('');

		core.userPools.detach(owner, target, created.name);
		expect(core.userPools.consumerEnv(target.id)).toEqual({});
		expect(core.userPools.consumerVersion(target.id)).toBe('');
	});

	test('the client secret stays sealed at rest and only opens for activation', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const target = await project('shop-app');
		core.userPools.attach(owner, target, { pool: created.name, client: app.client.name });

		const sealed = String(
			opened.sqlite
				.query<{ client_secret_sealed: string | null }, [string]>(
					'SELECT client_secret_sealed FROM user_pool_clients WHERE id = ?'
				)
				.get(app.client.id)!.client_secret_sealed
		);
		expect(sealed).not.toBe(app.clientSecret);
		expect(sealed).toContain('.');
		expect(core.ctx.secrets.open('org_1', sealed)).toBe(app.clientSecret!);

		// The attachment row names the client and prefix, never the secret (or any ciphertext).
		const row = opened.sqlite
			.query<Record<string, unknown>, [string]>('SELECT * FROM user_pool_attachments WHERE project_id = ?')
			.get(target.id)!;
		expect(JSON.stringify(row)).not.toContain(app.clientSecret!);
		expect(row.client_row_id).toBe(app.client.id);
		expect(row).not.toHaveProperty('client_secret_sealed');
	});

	test('a custom prefix changes every injected name', async () => {
		const created = await pool('acme');
		const app = client(created.id);
		const target = await project('acme-app');
		const { attachment } = core.userPools.attach(owner, target, {
			pool: created.name,
			client: app.client.name,
			envPrefix: 'ACME_AUTH'
		});
		expect(attachment.envNames).toEqual([
			'ACME_AUTH_ISSUER',
			'ACME_AUTH_CLIENT_ID',
			'ACME_AUTH_CLIENT_SECRET'
		]);
		expect(core.userPools.consumerEnv(target.id).ACME_AUTH_ISSUER).toBe(created.issuer);
	});
});

describe('attach and detach rules', () => {
	test('refuses static projects, public clients, duplicates and duplicate prefixes', async () => {
		const created = await pool('shop');
		const confidential = client(created.id);
		const publicClient = client(created.id, { name: 'browser', public: true });
		const staticProject = await project('static-site', 'static');
		const target = await project('shop-app');

		expect(() =>
			core.userPools.attach(owner, staticProject, {
				pool: created.name,
				client: confidential.client.name
			})
		).toThrow(/static/);
		expect(() =>
			core.userPools.attach(owner, target, {
				pool: created.name,
				client: publicClient.client.name
			})
		).toThrow(/public/);

		core.userPools.attach(owner, target, {
			pool: created.name,
			client: confidential.client.name,
			envPrefix: 'AUTH'
		});
		expect(() =>
			core.userPools.attach(owner, target, {
				pool: created.name,
				client: confidential.client.name,
				envPrefix: 'OTHER'
			})
		).toThrow(/already attached/);

		const second = await pool('other');
		const secondClient = client(second.id);
		expect(() =>
			core.userPools.attach(owner, target, {
				pool: second.name,
				client: secondClient.client.name,
				envPrefix: 'AUTH'
			})
		).toThrow(/env prefix/);
	});

	test('refuses to delete a pool or client while attached, then allows it after detach', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const target = await project('shop-app');
		core.userPools.attach(owner, target, { pool: created.name, client: app.client.name });

		expect(() => core.userPools.deleteClient(owner, created.id, app.client.clientId)).toThrow(/attached to/);
		expect(() => core.userPools.delete(owner, created.id)).toThrow(/attached to/);

		core.userPools.detach(owner, target, created.name);
		core.userPools.deleteClient(owner, created.id, app.client.clientId);
		expect(core.userPools.delete(owner, created.id)).toBeUndefined();
		expect(core.userPools.list(owner)).toEqual([]);
	});

	test('an attach is scoped to its organisation', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const target = await project('shop-app');
		// Either the project check or the pool lookup refuses; both keep the other org out.
		expect(() =>
			core.userPools.attach(otherOrg, target, {
				pool: created.name,
				client: app.client.name
			})
		).toThrow();
	});
});

describe('pool events', () => {
	test('user.created and user.signed_in carry pool/user metadata and no secrets', async () => {
		const created = await pool('shop');
		opened.sqlite.run(
			`INSERT INTO event_rules
			   (id, org_id, source, events_json, filter_json, broker_id, queue, description, enabled, created_by, created_at, updated_at)
			 VALUES ('evr_pool', 'org_1', 'pools', '[]', '{}', 'brk_test', 'pool-events', NULL, 1, 'user_1', ?, ?)`,
			[now, now]
		);

		const signedUp = await core.userPoolEngine.signUp(
			created.id,
			'Ada@Example.com',
			'correct horse battery',
			'Ada'
		);
		const signedIn = await core.userPoolEngine.signIn(
			created.id,
			'ada@example.com',
			'correct horse battery'
		);

		const rows = opened.sqlite
			.query<{ event_type: string; body_json: string }, []>(
				'SELECT event_type, body_json FROM event_deliveries ORDER BY created_at'
			)
			.all();
		expect(rows.map((row) => row.event_type)).toEqual([
			'pools.user.created',
			'pools.user.signed_in'
		]);

		const createdBody = JSON.parse(rows[0]!.body_json) as {
			type: string;
			account: string;
			data: Record<string, unknown>;
		};
		expect(createdBody).toMatchObject({
			type: 'pools.user.created',
			account: 'org_1',
			data: {
				poolId: created.id,
				poolName: created.name,
				user: {
					id: signedUp.user.id,
					email: 'ada@example.com',
					name: 'Ada',
					emailVerified: false
				}
			}
		});

		const signedInBody = JSON.parse(rows[1]!.body_json) as { data: Record<string, unknown> };
		expect(signedInBody.data).toMatchObject({
			poolId: created.id,
			poolName: created.name,
			user: { id: signedIn.user.id, email: 'ada@example.com' }
		});
		expect((signedInBody.data.session as Record<string, unknown>).id).toBeString();

		const serialised = rows.map((row) => row.body_json).join('\n');
		for (const secret of [
			'correct horse battery',
			signedUp.verificationToken!,
			signedIn.token
		]) {
			expect(serialised).not.toContain(secret);
		}
	});
});

describe('env.AUTH.verify', () => {
	test('accepts a pool access token, rejects an id_token and a tampered token', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const signedUp = await core.userPoolEngine.signUp(
			created.id,
			'ada@example.com',
			'correct horse battery',
			'Ada'
		);
		const signedIn = await core.userPoolEngine.signIn(
			created.id,
			'ada@example.com',
			'correct horse battery'
		);
		const authorized = await core.userPoolEngine.authorize({
			poolId: created.id,
			clientId: app.client.clientId,
			redirectUri: 'https://app.test/auth/callback',
			responseType: 'code',
			scope: 'openid profile email',
			sessionToken: signedIn.token
		});
		const code = new URL(authorized.redirect).searchParams.get('code')!;
		const tokens = await core.userPoolEngine.token({
			poolId: created.id,
			grantType: 'authorization_code',
			clientId: app.client.clientId,
			clientSecret: app.clientSecret,
			code,
			redirectUri: 'https://app.test/auth/callback'
		});

		const verified = await core.userPools.verifyAccessToken(created.id, tokens.access_token);
		expect(verified).toMatchObject({
			id: signedUp.user.id,
			email: 'ada@example.com',
			name: 'Ada'
		});
		expect(await core.userPools.verifyAccessToken(created.id, tokens.id_token)).toBeNull();
		// Alter the payload, not a padding character: the signature must stop matching.
		const [header, payload, signature] = tokens.access_token.split('.');
		const tamperedPayload = `${payload!.slice(0, -2)}aa`;
		expect(
			await core.userPools.verifyAccessToken(
				created.id,
				`${header}.${tamperedPayload}.${signature}`
			)
		).toBeNull();
		expect(await core.userPools.verifyAccessToken(created.id, 'not-a-jwt')).toBeNull();

		const other = await pool('other');
		expect(await core.userPools.verifyAccessToken(other.id, tokens.access_token)).toBeNull();
	});

	test('an attached function binding carries the issuer and public JWKS, never the secret', async () => {
		const created = await pool('shop');
		const app = client(created.id);
		const target = await project('shop-fn');
		core.userPools.attach(owner, target, { pool: created.name, client: app.client.name });

		const binding = await core.userPools.authBindingForProject(target.id);
		expect(binding).toMatchObject({
			name: 'AUTH',
			type: 'auth',
			poolId: created.id,
			issuer: created.issuer
		});
		expect(binding.type === 'auth' ? binding.jwks.length : 0).toBeGreaterThan(0);
		expect(JSON.stringify(binding)).not.toContain(app.clientSecret!);
		expect(JSON.stringify(binding)).not.toContain('client_secret');
	});
});
