import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import { USER_POOL_IMPERSONATION_MAX_TTL_SECONDS } from './user-pool-engine.ts';

/**
 * Support impersonation (IAM.md I29): an admin with `userPool:impersonate-user` mints a short
 * pool session for one user, the session carries `impersonated_by`, the start/end are audited
 * with the admin as `actingFor`, and ending it revokes only impersonation sessions.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-user-pool-impersonation-'));
const opened = createDb({ path: ':memory:' });

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
		now: () => now,
	},
});

const owner: Principal = buildPrincipal({ kind: 'user', userId: 'user_admin', orgId: 'org_1', role: 'owner' });
const viewer: Principal = buildPrincipal({ kind: 'user', userId: 'user_view', orgId: 'org_1', role: 'viewer' });
let counter = 0;

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	opened.sqlite.exec(`
		DELETE FROM audit_log;
		DELETE FROM settings WHERE key LIKE 'user_pool.%';
		DELETE FROM user_pool_codes;
		DELETE FROM user_pool_sessions;
		DELETE FROM user_pool_email_tokens;
		DELETE FROM user_pool_invites;
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

async function createPoolWithUser() {
	counter += 1;
	const pool = await core.userPools.create(owner, { name: `pool-${counter}`, signupMode: 'open' });
	const signedUp = await core.userPoolEngine.signUp(
		pool.id,
		'ada@example.com',
		'correct horse battery',
		'Ada'
	);
	return { pool, user: signedUp.user };
}

function challenge(value: string): string {
	return createHash('sha256').update(value).digest('base64url');
}

describe('support impersonation (I29)', () => {
	test('requires userPool:impersonate-user and caps the session at one hour', async () => {
		const { pool, user } = await createPoolWithUser();
		expect(() => core.userPools.impersonateUser(viewer, pool.id, user.id)).toThrow(
			/userPool:impersonate-user/
		);
		expect(() =>
			core.userPools.impersonateUser(owner, pool.id, user.id, {
				ttlSeconds: USER_POOL_IMPERSONATION_MAX_TTL_SECONDS + 1,
			})
		).toThrow(/at most 3600 seconds/i);

		const impersonation = core.userPools.impersonateUser(owner, pool.id, user.id, {
			ttlSeconds: 600,
		});
		expect(impersonation.token).toBeString();
		expect(impersonation.session.impersonatedBy).toBe(owner.userId);
		expect(impersonation.session.expiresAt).toBe(now + 600_000);
	});

	test('the session view carries impersonated_by and the OIDC token repeats it', async () => {
		const { pool, user } = await createPoolWithUser();
		const client = core.userPools.createClient(owner, pool.id, {
			name: 'web',
			redirectUris: ['https://app.test/callback'],
			public: true,
		});
		const impersonation = core.userPools.impersonateUser(owner, pool.id, user.id);
		const session = core.userPoolEngine.session(pool.id, impersonation.token);
		expect(session?.session.impersonatedBy).toBe(owner.userId);

		const verifier = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-._~';
		const authorized = await core.userPoolEngine.authorize({
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://app.test/callback',
			responseType: 'code',
			scope: 'openid email',
			state: 'state-1',
			sessionToken: impersonation.token,
			codeChallenge: challenge(verifier),
			codeChallengeMethod: 'S256',
		});
		const code = new URL(authorized.redirect).searchParams.get('code');
		expect(code).toBeString();

		const tokens = await core.userPoolEngine.token({
			poolId: pool.id,
			grantType: 'authorization_code',
			clientId: client.client.clientId,
			code: code!,
			redirectUri: 'https://app.test/callback',
			codeVerifier: verifier,
		});
		const claims = JSON.parse(
			Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString('utf8')
		) as Record<string, unknown>;
		expect(claims.impersonated_by).toBe(owner.userId);
	});

	test('start and end are audited with the admin as actingFor', async () => {
		const { pool, user } = await createPoolWithUser();
		const impersonation = core.userPools.impersonateUser(owner, pool.id, user.id);

		const start = opened.sqlite
			.query<{ actor_id: string; args_json: string }, []>(
				"SELECT actor_id, args_json FROM audit_log WHERE action = 'user_pool.user.impersonate' ORDER BY rowid DESC LIMIT 1"
			)
			.get();
		expect(start?.actor_id).toBe(owner.userId);
		const startArgs = JSON.parse(start!.args_json) as Record<string, unknown>;
		expect(startArgs.actingFor).toBe(owner.userId);
		expect(startArgs.sessionId).toBe(impersonation.session.id);

		const ended = core.userPools.endImpersonation(owner, pool.id, user.id);
		expect(ended.revoked).toBe(1);

		const end = opened.sqlite
			.query<{ actor_id: string; args_json: string }, []>(
				"SELECT actor_id, args_json FROM audit_log WHERE action = 'user_pool.user.impersonation.end' ORDER BY rowid DESC LIMIT 1"
			)
			.get();
		expect(end?.actor_id).toBe(owner.userId);
		const endArgs = JSON.parse(end!.args_json) as Record<string, unknown>;
		expect(endArgs.actingFor).toBe(owner.userId);
		expect(endArgs.revoked).toBe(1);
	});

	test('ending impersonation revokes only the support session', async () => {
		const { pool, user } = await createPoolWithUser();
		const normal = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const impersonation = core.userPools.impersonateUser(owner, pool.id, user.id);

		expect(core.userPoolEngine.session(pool.id, impersonation.token)).not.toBeNull();
		const ended = core.userPools.endImpersonation(owner, pool.id, user.id);
		expect(ended.revoked).toBe(1);

		expect(core.userPoolEngine.session(pool.id, impersonation.token)).toBeNull();
		// The user's own real session is untouched.
		expect(core.userPoolEngine.session(pool.id, normal.token)).not.toBeNull();
		// A second end is a no-op, not an error.
		expect(core.userPools.endImpersonation(owner, pool.id, user.id).revoked).toBe(0);
	});
});
