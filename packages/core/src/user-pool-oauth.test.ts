import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { UnauthorizedError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { setUserPoolOAuthFetch } from './user-pool-engine.ts';

/**
 * Social-login specification for the native user-pool engine (IAM.md §11.2). The provider HTTP
 * transport is injected, so no request leaves the process: the fake records the token exchange and
 * answers the userinfo call. Like the other engine tests, the new 0105 migration is executed here
 * because the checked-in migrations snapshot is regenerated separately.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-user-pool-oauth-'));
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

interface Call {
	url: string;
	init?: RequestInit;
}

let calls: Call[] = [];
let identity: {
	sub: string;
	email: string;
	email_verified: boolean;
	name: string;
} = {
	sub: 'google-subject-1',
	email: 'ada@example.com',
	email_verified: true,
	name: 'Ada'
};

function installFakeProvider(): void {
	calls = [];
	identity = {
		sub: 'google-subject-1',
		email: 'ada@example.com',
		email_verified: true,
		name: 'Ada'
	};
	setUserPoolOAuthFetch((async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init });
		if (url === 'https://oauth2.googleapis.com/token')
			return Response.json({ access_token: 'access-token-1', token_type: 'Bearer' });
		if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(identity);
		return new Response('not found', { status: 404 });
	}) as typeof fetch);
}

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	installFakeProvider();
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
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
});

afterAll(() => {
	setUserPoolOAuthFetch(null);
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createPool(signupMode: 'open' | 'invite' = 'open') {
	counter += 1;
	return core.userPools.create(owner, { name: `pool-${counter}`, signupMode });
}

function configure(poolId: string, provider = 'google', enabled = true) {
	return core.userPools.setOAuthProvider(owner, poolId, provider, {
		clientId: `${provider}-client-id`,
		clientSecret: `${provider}-client-secret`,
		enabled
	});
}

function start(poolId: string, provider = 'google', returnTo?: string) {
	const started = core.userPoolEngine.oauthStart(poolId, provider, { returnTo });
	const url = new URL(started.redirect);
	return { started, url, state: url.searchParams.get('state') ?? '' };
}

function challengeFor(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

function accountRows(poolId: string) {
	return opened.sqlite
		.query<{ user_id: string; provider: string; provider_account_id: string; email: string | null }, [string]>(
			'SELECT user_id, provider, provider_account_id, email FROM user_pool_oauth_accounts WHERE pool_id = ?'
		)
		.all(poolId);
}

describe('state and PKCE binding', () => {
	test('start sends state, callback URL and an S256 challenge; the callback consumes the state once', async () => {
		const pool = await createPool('open');
		configure(pool.id);
		const { url, state } = start(pool.id, 'google', `/pool/${pool.id}/login`);

		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(url.searchParams.get('client_id')).toBe('google-client-id');
		expect(url.searchParams.get('redirect_uri')).toBe(
			`https://control.test/api/v1/user-pools/${pool.id}/oauth/callback/google`
		);
		expect(url.searchParams.get('response_type')).toBe('code');
		expect(url.searchParams.get('scope')).toBe('openid email profile');
		expect(url.searchParams.get('state')).toBeString();
		expect(url.searchParams.get('code_challenge_method')).toBe('S256');
		expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);

		await expect(
			core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', `${state}x`)
		).rejects.toBeInstanceOf(UnauthorizedError);
		// A refused state never reaches the provider.
		expect(calls).toHaveLength(0);

		const result = await core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', state);
		expect(result.user.email).toBe('ada@example.com');
		expect(result.user.emailVerified).toBe(true);
		expect(result.returnTo).toBe(`/pool/${pool.id}/login`);
		expect(core.userPoolEngine.session(pool.id, result.token)?.user.id).toBe(result.user.id);

		// Single use: the same state cannot complete a second sign-in.
		await expect(
			core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', state)
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('the token exchange carries the code verifier and the sealed client secret', async () => {
		const pool = await createPool('open');
		configure(pool.id);
		const { url, state } = start(pool.id);
		const expectedChallenge = url.searchParams.get('code_challenge') ?? '';
		await core.userPoolEngine.oauthCallback(pool.id, 'google', 'one-time-code', state);

		const tokenCall = calls.find((call) => call.url === 'https://oauth2.googleapis.com/token');
		expect(tokenCall).toBeDefined();
		const body = new URLSearchParams(String(tokenCall?.init?.body));
		expect(body.get('grant_type')).toBe('authorization_code');
		expect(body.get('code')).toBe('one-time-code');
		expect(body.get('client_id')).toBe('google-client-id');
		expect(body.get('client_secret')).toBe('google-client-secret');
		expect(body.get('redirect_uri')).toBe(
			`https://control.test/api/v1/user-pools/${pool.id}/oauth/callback/google`
		);
		// 48 random bytes, base64url: the verifier the challenge committed to.
		expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
		expect(challengeFor(body.get('code_verifier') ?? '')).toBe(expectedChallenge);

		const userInfo = calls.find(
			(call) => call.url === 'https://openidconnect.googleapis.com/v1/userinfo'
		);
		expect(new Headers(userInfo?.init?.headers).get('authorization')).toBe('Bearer access-token-1');
	});

	test('a state created for one pool or provider cannot be used for another', async () => {
		const first = await createPool('open');
		const second = await createPool('open');
		configure(first.id);
		configure(second.id);
		const { state } = start(first.id);

		await expect(
			core.userPoolEngine.oauthCallback(second.id, 'google', 'code-123', state)
		).rejects.toBeInstanceOf(UnauthorizedError);
		// The failed attempt did not consume the state for the pool it belongs to.
		await expect(
			core.userPoolEngine.oauthCallback(first.id, 'google', 'code-123', state)
		).resolves.toBeDefined();
	});
});

describe('verified-email linking', () => {
	test('links a verified provider email to an existing verified pool user', async () => {
		const pool = await createPool('open');
		const created = await core.userPoolEngine.signUp(
			pool.id,
			'ada@example.com',
			'correct horse battery',
			'Ada'
		);
		core.userPoolEngine.verifyEmail(pool.id, created.verificationToken!);
		configure(pool.id);

		const { state } = start(pool.id);
		const result = await core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', state);

		expect(result.user.id).toBe(created.user.id);
		expect(accountRows(pool.id)).toEqual([
			{
				user_id: created.user.id,
				provider: 'google',
				provider_account_id: 'google-subject-1',
				email: 'ada@example.com'
			}
		]);
	});

	test('refuses to link into an unverified pool user, and never links an unverified provider email', async () => {
		const pool = await createPool('open');
		const unverified = await core.userPoolEngine.signUp(
			pool.id,
			'ada@example.com',
			'correct horse battery'
		);
		configure(pool.id);

		const { state } = start(pool.id);
		await expect(
			core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', state)
		).rejects.toBeInstanceOf(UnauthorizedError);
		expect(accountRows(pool.id)).toEqual([]);
		expect(core.userPoolEngine.listUsers(pool.id).map((user) => user.id)).toEqual([unverified.user.id]);

		// The provider's own `email_verified: false` is refused before any account is created.
		const { state: secondState } = start(pool.id);
		identity = { ...identity, email: 'grace@example.com', email_verified: false };
		await expect(
			core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-456', secondState)
		).rejects.toBeInstanceOf(UnauthorizedError);
		expect(core.userPoolEngine.listUsers(pool.id)).toHaveLength(1);
	});

	test('a second provider sign-in for the same account does not create a duplicate user', async () => {
		const pool = await createPool('open');
		configure(pool.id);
		const first = await core.userPoolEngine.oauthCallback(
			pool.id,
			'google',
			'code-1',
			start(pool.id).state
		);
		const second = await core.userPoolEngine.oauthCallback(
			pool.id,
			'google',
			'code-2',
			start(pool.id).state
		);
		expect(second.user.id).toBe(first.user.id);
		expect(core.userPoolEngine.listUsers(pool.id)).toHaveLength(1);
	});

	test('github uses the verified primary address from /user/emails, not the profile email', async () => {
		const pool = await createPool('open');
		configure(pool.id, 'github');
		setUserPoolOAuthFetch((async (input, init) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, init });
			if (url === 'https://github.com/login/oauth/access_token')
				// GitHub's default response is form-encoded, which the engine also accepts.
				return new Response('access_token=github-token&token_type=bearer', {
					headers: { 'content-type': 'application/x-www-form-urlencoded' }
				});
			if (url === 'https://api.github.com/user')
				return Response.json({ id: 4711, login: 'octocat', name: 'Octo Cat', email: 'wrong@example.com' });
			if (url === 'https://api.github.com/user/emails')
				return Response.json([
					{ email: 'old@example.com', primary: false, verified: false },
					{ email: 'octo@example.com', primary: true, verified: true }
				]);
			return new Response('not found', { status: 404 });
		}) as typeof fetch);

		const result = await core.userPoolEngine.oauthCallback(
			pool.id,
			'github',
			'code-gh',
			start(pool.id, 'github').state
		);
		expect(result.user.email).toBe('octo@example.com');
		expect(result.user.emailVerified).toBe(true);
		expect(accountRows(pool.id)).toEqual([
			{
				user_id: result.user.id,
				provider: 'github',
				provider_account_id: '4711',
				email: 'octo@example.com'
			}
		]);
	});
});

describe('new users under each signup mode', () => {
	test('an open pool creates a verified social-only user that password sign-in cannot enter', async () => {
		const pool = await createPool('open');
		configure(pool.id);
		const result = await core.userPoolEngine.oauthCallback(
			pool.id,
			'google',
			'code-123',
			start(pool.id).state
		);

		expect(result.user.email).toBe('ada@example.com');
		expect(result.user.emailVerified).toBe(true);
		await expect(core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'anything')).rejects.toBeInstanceOf(
			UnauthorizedError
		);
	});

	test('an invite pool refuses a new social user with no invitation', async () => {
		const pool = await createPool('invite');
		configure(pool.id);
		identity = { ...identity, email: 'grace@example.com' };

		await expect(
			core.userPoolEngine.oauthCallback(pool.id, 'google', 'code-123', start(pool.id).state)
		).rejects.toThrow(/invite-only/i);
		expect(core.userPoolEngine.listUsers(pool.id)).toEqual([]);
	});

	test('an invite pool admits a new social user when the address is invited, and spends the invite', async () => {
		const pool = await createPool('invite');
		configure(pool.id);
		const invited = core.userPools.inviteUser(owner, pool.id, 'grace@example.com');
		identity = { ...identity, email: 'grace@example.com' };

		const result = await core.userPoolEngine.oauthCallback(
			pool.id,
			'google',
			'code-123',
			start(pool.id).state
		);
		expect(result.user.email).toBe('grace@example.com');
		expect(result.user.emailVerified).toBe(true);
		expect(core.userPools.listInvites(owner, pool.id)[0]?.usedAt).toBe(now);
		expect(invited.token).toBeString();
	});
});

describe('provider configuration', () => {
	test('lists all four providers, seals the secret and exposes the exact callback URL', async () => {
		const pool = await createPool('open');
		const before = core.userPools.listOAuthProviders(owner, pool.id);
		expect(before.map((provider) => provider.provider)).toEqual([
			'google',
			'github',
			'microsoft',
			'apple'
		]);
		expect(before.every((provider) => !provider.configured && !provider.enabled)).toBe(true);

		const view = configure(pool.id);
		expect(view.enabled).toBe(true);
		expect(view.secretConfigured).toBe(true);
		expect(view.callbackUrl).toBe(
			`https://control.test/api/v1/user-pools/${pool.id}/oauth/callback/google`
		);

		const row = opened.sqlite
			.query<{ client_secret_sealed: string }, [string, string]>(
				'SELECT client_secret_sealed FROM user_pool_oauth_providers WHERE pool_id = ? AND provider = ?'
			)
			.get(pool.id, 'google');
		expect(row?.client_secret_sealed).toBeString();
		expect(row?.client_secret_sealed).not.toContain('google-client-secret');
		expect(core.ctx.secrets.open('org_1', row!.client_secret_sealed)).toBe('google-client-secret');
	});

	test('a disabled provider is hidden from the login page and cannot start a sign-in', async () => {
		const pool = await createPool('open');
		configure(pool.id, 'google', false);

		expect(core.userPoolEngine.enabledOAuthProviders(pool.id)).toEqual([]);
		expect(() => core.userPoolEngine.oauthStart(pool.id, 'google')).toThrow(/not available/i);

		core.userPools.setOAuthProvider(owner, pool.id, 'google', {
			clientId: 'google-client-id',
			enabled: true
		});
		expect(core.userPoolEngine.enabledOAuthProviders(pool.id)).toEqual([
			{ provider: 'google', label: 'Google' }
		]);
		expect(start(pool.id).url.searchParams.get('client_id')).toBe('google-client-id');
	});

	test('removing a provider stops new sign-ins but keeps existing account links', async () => {
		const pool = await createPool('open');
		configure(pool.id);
		const signedIn = await core.userPoolEngine.oauthCallback(
			pool.id,
			'google',
			'code-123',
			start(pool.id).state
		);
		core.userPools.deleteOAuthProvider(owner, pool.id, 'google');

		expect(core.userPoolEngine.enabledOAuthProviders(pool.id)).toEqual([]);
		expect(() => core.userPoolEngine.oauthStart(pool.id, 'google')).toThrow(/not available/i);
		expect(accountRows(pool.id)[0]?.user_id).toBe(signedIn.user.id);
	});
});
