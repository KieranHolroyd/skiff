import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal, UserPoolTotpEnrolment } from '@skiff/contracts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import {
	USER_POOL_MFA_MAX_ATTEMPTS,
	USER_POOL_RECOVERY_CODE_COUNT,
	base32Decode
} from './user-pool-engine.ts';
import { userPoolSigningPurpose } from './user-pools.ts';

/**
 * TOTP MFA and first-class groups for the native pool engine (IAM.md I27, §11.2). The migrations
 * are applied from their files because the checked-in bundle is regenerated separately.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-user-pool-mfa-'));
const opened = createDb({ path: ':memory:' });
for (const migration of [
	'0097_user_pool_engine.sql',
	'0101_user_pool_passkeys.sql',
	'0102_user_pool_totp.sql',
	'0103_user_pool_groups.sql'
])
	opened.sqlite.exec(readFileSync(new URL(`../../db/migrations/${migration}`, import.meta.url), 'utf8'));

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
	opened.sqlite.exec(`
		DELETE FROM user_pool_totp;
		DELETE FROM user_pool_group_members;
		DELETE FROM user_pool_groups;
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

async function createPool(extra: { mfaRequired?: boolean } = {}) {
	counter += 1;
	return core.userPools.create(owner, {
		name: `pool-${counter}`,
		signupMode: 'open',
		...extra
	});
}

async function createUser(poolId: string, email = 'ada@example.com') {
	return core.userPoolEngine.signUp(poolId, email, 'correct horse battery', 'Ada');
}

/** Build the RFC 6238 code for a secret at a chosen instant, using the same 30-second step. */
function totp(secret: string, at = now): string {
	const counter = Math.floor(at / 1000 / 30);
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(BigInt(counter));
	const digest = createHmac('sha1', base32Decode(secret)).update(message).digest();
	const offset = digest[digest.length - 1]! & 0x0f;
	const value =
		((digest[offset]! & 0x7f) << 24) |
		((digest[offset + 1]! & 0xff) << 16) |
		((digest[offset + 2]! & 0xff) << 8) |
		(digest[offset + 3]! & 0xff);
	return String(value % 1_000_000).padStart(6, '0');
}

function enrol(poolId: string, userId: string): UserPoolTotpEnrolment {
	return core.userPoolEngine.totpEnrol(poolId, userId);
}

function enable(poolId: string, userId: string): string[] {
	const enrolment = enrol(poolId, userId);
	return core.userPoolEngine.totpConfirm(poolId, userId, totp(enrolment.secret)).recoveryCodes;
}

function publicClient(poolId: string) {
	return core.userPools.createClient(owner, poolId, {
		name: 'web-app',
		redirectUris: ['https://app.test/callback'],
		public: true
	});
}

function codeChallenge(verifier: string): string {
	return createHash('sha256').update(verifier).digest('base64url');
}

describe('TOTP enrolment', () => {
	test('enrolment returns a base32 secret and otpauth URI but stores only a sealed secret', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const enrolment = enrol(pool.id, created.user.id);

		expect(enrolment.secret).toMatch(/^[A-Z2-7]+$/);
		expect(enrolment.otpauthUri).toStartWith('otpauth://totp/');
		expect(enrolment.otpauthUri).toContain(`secret=${enrolment.secret}`);
		expect(enrolment.issuer).toBe(pool.name);
		expect(enrolment.account).toBe('ada@example.com');

		const row = opened.sqlite
			.query<{ secret_sealed: string; confirmed_at: number | null }, [string, string]>(
				'SELECT secret_sealed, confirmed_at FROM user_pool_totp WHERE pool_id = ? AND user_id = ?'
			)
			.get(pool.id, created.user.id);
		expect(row?.secret_sealed).toBeString();
		expect(row?.secret_sealed).not.toContain(enrolment.secret);
		expect(row?.confirmed_at).toBeNull();
		expect(core.userPoolEngine.totpStatus(pool.id, created.user.id)).toEqual({
			enabled: false,
			confirmedAt: null,
			recoveryCodesRemaining: 0
		});
	});

	test('confirm requires a valid code and returns ten one-time recovery codes exactly once', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const enrolment = enrol(pool.id, created.user.id);

		expect(() => core.userPoolEngine.totpConfirm(pool.id, created.user.id, '000000')).toThrow();
		const confirmed = core.userPoolEngine.totpConfirm(
			pool.id,
			created.user.id,
			totp(enrolment.secret)
		);
		expect(confirmed.recoveryCodes).toHaveLength(USER_POOL_RECOVERY_CODE_COUNT);
		expect(new Set(confirmed.recoveryCodes).size).toBe(USER_POOL_RECOVERY_CODE_COUNT);
		expect(confirmed.recoveryCodes[0]).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);

		const status = core.userPoolEngine.totpStatus(pool.id, created.user.id);
		expect(status.enabled).toBe(true);
		expect(status.confirmedAt).toBe(now);
		expect(status.recoveryCodesRemaining).toBe(USER_POOL_RECOVERY_CODE_COUNT);

		const stored = opened.sqlite
			.query<{ recovery_codes_json: string }, [string, string]>(
				'SELECT recovery_codes_json FROM user_pool_totp WHERE pool_id = ? AND user_id = ?'
			)
			.get(pool.id, created.user.id);
		expect(stored?.recovery_codes_json).not.toContain(confirmed.recoveryCodes[0]!);
		expect(JSON.parse(stored?.recovery_codes_json ?? '[]')).toHaveLength(USER_POOL_RECOVERY_CODE_COUNT);
	});
});

describe('TOTP sign-in', () => {
	test('a password sign-in returns an MFA challenge instead of a session, and the code creates one', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const secret = enrol(pool.id, created.user.id).secret;
		core.userPoolEngine.totpConfirm(pool.id, created.user.id, totp(secret));

		const first = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(first.mfaRequired).toBe(true);
		expect(first.mfaToken).toBeString();
		expect(typeof first.mfaExpiresAt).toBe('number');
		// The challenge token is not a session: setting it as a cookie cannot authenticate.
		expect(core.userPoolEngine.session(pool.id, first.token)).toBeNull();

		const signedIn = core.userPoolEngine.totpVerify(pool.id, first.mfaToken!, totp(secret, now + 30_000));
		expect(signedIn.mfaRequired).toBe(false);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(created.user.id);
	});

	test('a code cannot be replayed, but the next step is accepted', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const secret = enrol(pool.id, created.user.id).secret;
		core.userPoolEngine.totpConfirm(pool.id, created.user.id, totp(secret));

		const nextStep = totp(secret, now + 30_000);
		const first = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		core.userPoolEngine.totpVerify(pool.id, first.mfaToken!, nextStep);

		const replay = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(() => core.userPoolEngine.totpVerify(pool.id, replay.mfaToken!, nextStep)).toThrow(
			/not valid/i
		);

		now += 30_000;
		const third = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(() =>
			core.userPoolEngine.totpVerify(pool.id, third.mfaToken!, totp(secret, now + 30_000))
		).not.toThrow();
	});

	test('five wrong codes burn the challenge, even if the next code is right', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const secret = enrol(pool.id, created.user.id).secret;
		core.userPoolEngine.totpConfirm(pool.id, created.user.id, totp(secret));

		const challenge = await core.userPoolEngine.signIn(
			pool.id,
			'ada@example.com',
			'correct horse battery'
		);
		for (let attempt = 0; attempt < USER_POOL_MFA_MAX_ATTEMPTS; attempt += 1)
			expect(() => core.userPoolEngine.totpVerify(pool.id, challenge.mfaToken!, '000000')).toThrow(
				/not valid/i
			);
		expect(() =>
			core.userPoolEngine.totpVerify(pool.id, challenge.mfaToken!, totp(secret, now + 30_000))
		).toThrow(/not valid/i);
	});

	test('a recovery code signs in once and is then spent', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const recoveryCodes = enable(pool.id, created.user.id);

		const first = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = core.userPoolEngine.totpVerify(pool.id, first.mfaToken!, recoveryCodes[0]!.toLowerCase());
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(created.user.id);
		expect(core.userPoolEngine.totpStatus(pool.id, created.user.id).recoveryCodesRemaining).toBe(
			USER_POOL_RECOVERY_CODE_COUNT - 1
		);

		const second = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(() => core.userPoolEngine.totpVerify(pool.id, second.mfaToken!, recoveryCodes[0]!)).toThrow(
			/not valid/i
		);
	});

	test('disabling MFA needs a current code and stops challenging sign-in', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const secret = enrol(pool.id, created.user.id).secret;
		core.userPoolEngine.totpConfirm(pool.id, created.user.id, totp(secret));

		expect(() => core.userPoolEngine.totpDisable(pool.id, created.user.id, '000000')).toThrow();
		expect(core.userPoolEngine.totpDisable(pool.id, created.user.id, totp(secret, now + 30_000))).toBe(
			true
		);
		expect(core.userPoolEngine.totpStatus(pool.id, created.user.id).enabled).toBe(false);
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(signedIn.mfaRequired).toBe(false);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)).not.toBeNull();
	});
});

describe('pool MFA policy', () => {
	test('the setting is stored, updated and exposed on the pool view and public info', async () => {
		const pool = await createPool({ mfaRequired: true });
		expect(pool.mfaRequired).toBe(true);
		expect(core.userPools.publicInfo(pool.id).mfaRequired).toBe(true);
		expect(core.userPoolEngine.mfaRequired(pool.id)).toBe(true);

		const updated = core.userPools.update(owner, pool.id, { mfaRequired: false });
		expect(updated.mfaRequired).toBe(false);
		expect(core.userPoolEngine.mfaRequired(pool.id)).toBe(false);
	});
});

describe('user pool groups', () => {
	test('CRUD is case-insensitive on names and membership is per pool', async () => {
		const pool = await createPool();
		const other = await createPool();
		const user = await createUser(pool.id);

		const group = core.userPoolEngine.createGroup(pool.id, 'Engineering');
		expect(group).toMatchObject({ poolId: pool.id, name: 'Engineering', memberCount: 0 });
		expect(() => core.userPoolEngine.createGroup(pool.id, 'engineering')).toThrow(/already exists/i);
		expect(core.userPoolEngine.createGroup(other.id, 'engineering').name).toBe('engineering');

		core.userPoolEngine.addGroupMember(pool.id, group.id, user.user.id);
		core.userPoolEngine.addGroupMember(pool.id, group.id, user.user.id);
		expect(core.userPoolEngine.groupsForUser(pool.id, user.user.id)).toEqual(['Engineering']);
		expect(core.userPoolEngine.listGroups(pool.id)[0]?.memberCount).toBe(1);
		expect(core.userPoolEngine.listGroupMembers(pool.id, group.id)).toEqual([
			{
				userId: user.user.id,
				email: 'ada@example.com',
				name: 'Ada',
				addedAt: now
			}
		]);

		const renamed = core.userPoolEngine.renameGroup(pool.id, group.id, 'Platform');
		expect(renamed.name).toBe('Platform');
		expect(core.userPoolEngine.groupsForUser(pool.id, user.user.id)).toEqual(['Platform']);

		expect(core.userPoolEngine.removeGroupMember(pool.id, group.id, user.user.id)).toBe(true);
		expect(core.userPoolEngine.removeGroupMember(pool.id, group.id, user.user.id)).toBe(false);
		expect(core.userPoolEngine.deleteGroup(pool.id, group.id)).toBe(true);
		expect(core.userPoolEngine.listGroups(pool.id)).toEqual([]);
	});

	test('group names are a claim in the access token, id token and userinfo', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		const group = core.userPoolEngine.createGroup(pool.id, 'staff');
		core.userPoolEngine.addGroupMember(pool.id, group.id, created.user.id);
		const client = publicClient(pool.id);
		const signedIn = await core.userPoolEngine.signIn(
			pool.id,
			'ada@example.com',
			'correct horse battery'
		);

		const verifier = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-._~';
		const authorized = await core.userPoolEngine.authorize({
			poolId: pool.id,
			clientId: client.client.clientId,
			redirectUri: 'https://app.test/callback',
			responseType: 'code',
			scope: 'openid profile email',
			codeChallenge: codeChallenge(verifier),
			codeChallengeMethod: 'S256',
			sessionToken: signedIn.token
		});
		const code = new URL(authorized.redirect).searchParams.get('code');
		const tokens = await core.userPoolEngine.token({
			poolId: pool.id,
			grantType: 'authorization_code',
			clientId: client.client.clientId,
			code: code!,
			redirectUri: 'https://app.test/callback',
			codeVerifier: verifier
		});

		for (const token of [tokens.access_token, tokens.id_token]) {
			const claims = await core.ctx.signingKeys.verify(userPoolSigningPurpose(pool.id), token, {
				issuer: pool.issuer
			});
			expect(claims.groups).toEqual(['staff']);
		}
		const info = await core.userPoolEngine.userinfo(pool.id, tokens.access_token);
		expect(info.groups).toEqual(['staff']);
	});
});

describe('cleanup', () => {
	test('deleting a user removes their TOTP row and group memberships', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		enable(pool.id, created.user.id);
		const group = core.userPoolEngine.createGroup(pool.id, 'staff');
		core.userPoolEngine.addGroupMember(pool.id, group.id, created.user.id);

		expect(core.userPools.deleteUser(owner, pool.id, created.user.id)).toBeUndefined();
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM user_pool_totp WHERE pool_id = ?')
				.get(pool.id)?.n
		).toBe(0);
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>(
					'SELECT COUNT(*) AS n FROM user_pool_group_members WHERE pool_id = ?'
				)
				.get(pool.id)?.n
		).toBe(0);
		expect(core.userPoolEngine.listGroups(pool.id)[0]?.memberCount).toBe(0);
	});

	test('purging a pool removes TOTP, groups and members', async () => {
		const pool = await createPool();
		const created = await createUser(pool.id);
		enable(pool.id, created.user.id);
		const group = core.userPoolEngine.createGroup(pool.id, 'staff');
		core.userPoolEngine.addGroupMember(pool.id, group.id, created.user.id);

		core.userPoolEngine.purgePool(pool.id);

		for (const table of ['user_pool_totp', 'user_pool_groups', 'user_pool_group_members']) {
			expect(
				opened.sqlite
					.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM ${table} WHERE pool_id = ?`)
					.get(pool.id)?.n
			).toBe(0);
		}
	});
});
