import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { NotFoundError, UnauthorizedError, ValidationError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import {
	USER_POOL_SESSION_TTL_SECONDS,
	USER_POOL_TOKEN_TTL_SECONDS
} from './user-pool-engine.ts';
import { userPoolSigningPurpose } from './user-pools.ts';

/**
 * The engine test executes the real 0097 migration against an in-memory database. The checked-in
 * `packages/db/src/migrations.ts` snapshot is regenerated separately, so `createDb` stops at 0096
 * and this file adds the engine tables directly. No command in this repository runs these tests
 * from the coding-agent slice; they are the specification for a later test run.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-user-pool-engine-'));
const opened = createDb({ path: ':memory:' });
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0097_user_pool_engine.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0101_user_pool_passkeys.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0102_user_pool_totp.sql', import.meta.url), 'utf8'));
opened.sqlite.exec(readFileSync(new URL('../../db/migrations/0103_user_pool_groups.sql', import.meta.url), 'utf8'));

let now = Date.parse('2026-11-08T12:00:00Z');
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
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
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
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createPool(signupMode: 'open' | 'invite' = 'open') {
	counter += 1;
	return core.userPools.create(owner, {
		name: `pool-${counter}`,
		signupMode
	});
}

function publicClient(poolId: string) {
	return core.userPools.createClient(owner, poolId, {
		name: 'web-app',
		redirectUris: ['https://app.test/callback'],
		public: true
	});
}

function confidentialClient(poolId: string) {
	return core.userPools.createClient(owner, poolId, {
		name: 'server-app',
		redirectUris: ['https://server.test/callback'],
		public: false
	});
}

function verifier(): string {
	return 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-._~';
}

function challenge(value: string): string {
	return createHash('sha256').update(value).digest('base64url');
}

function userRow(poolId: string, email: string): { password_hash: string } | null {
	return opened.sqlite
		.query<{ password_hash: string }, [string, string]>(
			'SELECT password_hash FROM user_pool_users WHERE pool_id = ? AND email = ?'
		)
		.get(poolId, email);
}

describe('sign-up modes', () => {
	test('an open pool signs anybody up and hashes the password with argon2id', async () => {
		const pool = await createPool('open');
		const created = await core.userPoolEngine.signUp(pool.id, 'Ada@Example.com', 'correct horse battery');
		expect(created.user.email).toBe('ada@example.com');
		expect(created.user.emailVerified).toBe(false);
		expect(created.verificationToken).toBeString();

		const stored = userRow(pool.id, 'ada@example.com');
		expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
		expect(stored?.password_hash).not.toContain('correct horse battery');
	});

	test('an invite pool refuses an address with no invitation', async () => {
		const pool = await createPool('invite');
		await expect(
			core.userPoolEngine.signUp(pool.id, 'grace@example.com', 'correct horse battery')
		).rejects.toThrow(/invite-only/i);
	});

	test('an invitation token admits the address and proves it', async () => {
		const pool = await createPool('invite');
		const invited = core.userPools.inviteUser(owner, pool.id, 'grace@example.com');
		const created = await core.userPoolEngine.signUp(
			pool.id,
			'grace@example.com',
			'correct horse battery',
			'Grace',
			{ inviteToken: invited.token }
		);
		expect(created.user.emailVerified).toBe(true);
		expect(created.verificationToken).toBeNull();
		expect(core.userPools.listInvites(owner, pool.id)[0]?.usedAt).toBe(now);
	});

	test('a pending invitation for the address is enough without pasting the token', async () => {
		const pool = await createPool('invite');
		core.userPools.inviteUser(owner, pool.id, 'linus@example.com');
		const created = await core.userPoolEngine.signUp(pool.id, 'linus@example.com', 'correct horse battery');
		expect(created.user.emailVerified).toBe(true);
	});

	test('a duplicate email in one pool conflicts, but another pool is independent', async () => {
		const first = await createPool('open');
		const second = await createPool('open');
		await core.userPoolEngine.signUp(first.id, 'same@example.com', 'correct horse battery');
		await expect(
			core.userPoolEngine.signUp(first.id, 'same@example.com', 'correct horse battery')
		).rejects.toThrow(/already exists/i);
		await expect(
			core.userPoolEngine.signUp(second.id, 'same@example.com', 'correct horse battery')
		).resolves.toBeDefined();
	});
});

describe('password verification', () => {
	test('sign-in returns a session only for the right password', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');

		await expect(core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'wrong password')).rejects.toBeInstanceOf(
			UnauthorizedError
		);
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(signedIn.token).toBeString();
		expect(signedIn.session.userId).toBe(signedIn.user.id);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(signedIn.user.id);
	});

	test('the email-verification token marks the address verified once', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		expect(created.verificationToken).toBeString();
		const verified = core.userPoolEngine.verifyEmail(pool.id, created.verificationToken!);
		expect(verified.emailVerified).toBe(true);
		expect(() => core.userPoolEngine.verifyEmail(pool.id, created.verificationToken!)).toThrow(
			/reused|invalid|expired/i
		);
	});
});

describe('sessions', () => {
	test('a session expires and sign-out revokes it immediately', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const first = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');

		now += 30_000;
		expect(core.userPoolEngine.session(pool.id, first.token)).not.toBeNull();

		expect(core.userPoolEngine.signOut(pool.id, first.token)).toBe(true);
		expect(core.userPoolEngine.session(pool.id, first.token)).toBeNull();

		const second = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		now += USER_POOL_SESSION_TTL_SECONDS * 1000 + 1;
		expect(core.userPoolEngine.session(pool.id, second.token)).toBeNull();
	});
});

describe('OIDC authorization code flow', () => {
	test('authorize issues a code and token exchanges it with PKCE for an id token', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery', 'Ada');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const client = publicClient(pool.id);
		const codeVerifier = verifier();

		const authorized = await core.userPoolEngine.authorize({
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://app.test/callback',
			responseType: 'code',
			scope: 'openid profile email',
			state: 'state-123',
			nonce: 'nonce-123',
			codeChallenge: challenge(codeVerifier),
			codeChallengeMethod: 'S256',
			sessionToken: signedIn.token
		});
		expect(authorized.needsLogin).toBe(false);
		const callback = new URL(authorized.redirect);
		expect(callback.origin + callback.pathname).toBe('https://app.test/callback');
		expect(callback.searchParams.get('state')).toBe('state-123');
		const code = callback.searchParams.get('code');
		expect(code).toBeString();

		const tokens = await core.userPoolEngine.token({
			poolId: pool.id,
			grantType: 'authorization_code',
			clientId: client.client.clientId,
			code: code!,
			redirectUri: 'https://app.test/callback',
			codeVerifier
		});
		expect(tokens.token_type).toBe('Bearer');
		expect(tokens.expires_in).toBe(USER_POOL_TOKEN_TTL_SECONDS);

		const idClaims = await core.ctx.signingKeys.verify(
			userPoolSigningPurpose(pool.id),
			tokens.id_token,
			{ issuer: pool.issuer, audience: client.client.clientId }
		);
		expect(idClaims.sub).toBe(signedIn.user.id);
		expect(idClaims.email).toBe('ada@example.com');
		expect(idClaims.name).toBe('Ada');
		expect(idClaims.nonce).toBe('nonce-123');

		const info = await core.userPoolEngine.userinfo(pool.id, tokens.access_token);
		expect(info).toEqual({
			sub: signedIn.user.id,
			email: 'ada@example.com',
			email_verified: false,
			name: 'Ada',
			groups: []
		});

		// A code is single use.
		await expect(
			core.userPoolEngine.token({
				poolId: pool.id,
				grantType: 'authorization_code',
				clientId: client.client.clientId,
				code: code!,
				redirectUri: 'https://app.test/callback',
				codeVerifier
			})
		).rejects.toThrow(/already used|invalid/i);
	});

	test('a wrong PKCE verifier and an unauthenticated authorize both fail safely', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const client = publicClient(pool.id);
		const codeVerifier = verifier();
		const input = {
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://app.test/callback',
			responseType: 'code',
			scope: 'openid',
			codeChallenge: challenge(codeVerifier),
			codeChallengeMethod: 'S256'
		};

		const anonymous = await core.userPoolEngine.authorize(input);
		expect(anonymous.needsLogin).toBe(true);
		expect(anonymous.redirect).toContain(`/pool/${pool.id}/login`);

		const authorized = await core.userPoolEngine.authorize({ ...input, sessionToken: signedIn.token });
		const code = new URL(authorized.redirect).searchParams.get('code');
		await expect(
			core.userPoolEngine.token({
				poolId: pool.id,
				grantType: 'authorization_code',
				clientId: client.client.clientId,
				code: code!,
				redirectUri: 'https://app.test/callback',
				codeVerifier: `${codeVerifier}x`
			})
		).rejects.toThrow(/PKCE/i);
	});

	test('a confidential client must prove its sealed secret', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const client = confidentialClient(pool.id);

		const authorized = await core.userPoolEngine.authorize({
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://server.test/callback',
			responseType: 'code',
			scope: 'openid',
			sessionToken: signedIn.token
		});
		const code = new URL(authorized.redirect).searchParams.get('code');
		await expect(
			core.userPoolEngine.token({
				poolId: pool.id,
				grantType: 'authorization_code',
				clientId: client.client.clientId,
				code: code!,
				redirectUri: 'https://server.test/callback',
				clientSecret: 'not-the-secret'
			})
		).rejects.toThrow(/client credentials/i);

		await expect(
			core.userPoolEngine.token({
				poolId: pool.id,
				grantType: 'authorization_code',
				clientId: client.client.clientId,
				code: code!,
				redirectUri: 'https://server.test/callback',
				clientSecret: client.clientSecret!
			})
		).resolves.toBeDefined();
	});

	test('an unregistered redirect is refused without redirecting to it', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const client = publicClient(pool.id);

		await expect(
			core.userPoolEngine.authorize({
				poolId: pool.id,
				clientId: client.client.clientId,
				redirectUri: 'https://evil.test/callback',
				responseType: 'code',
				scope: 'openid',
				codeChallenge: challenge(verifier()),
				codeChallengeMethod: 'S256',
				sessionToken: signedIn.token
			})
		).rejects.toBeInstanceOf(ValidationError);
	});
});

describe('disabled users and pools', () => {
	test('disabling a user blocks sign-in and invalidates their sessions', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');

		core.userPools.disableUser(owner, pool.id, created.user.id);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)).toBeNull();
		await expect(core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')).rejects.toBeInstanceOf(
			UnauthorizedError
		);
	});

	test('a disabled pool stops sign-in and discovery', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		core.userPools.update(owner, pool.id, { disabled: true });

		await expect(core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')).rejects.toBeInstanceOf(
			NotFoundError
		);
		expect(() => core.userPools.publicInfo(pool.id)).toThrow(NotFoundError);
	});

	test('deleting a user removes their rows and the pool purge removes every engine row', async () => {
		const pool = await createPool();
		const first = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.signUp(pool.id, 'grace@example.com', 'correct horse battery');
		core.userPools.deleteUser(owner, pool.id, first.user.id);
		expect(core.userPools.listUsers(owner, pool.id).map((user) => user.email)).toEqual(['grace@example.com']);

		core.userPools.delete(owner, pool.id);
		expect(opened.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_pool_users').get()?.n).toBe(0);
	});
});
