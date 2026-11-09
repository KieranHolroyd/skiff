import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { CoreError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import {
	USER_POOL_MAGIC_EMAIL_LIMIT,
	USER_POOL_MAGIC_LINK_TTL_SECONDS,
	USER_POOL_PASSWORD_RESET_TTL_SECONDS,
	USER_POOL_REQUEST_IP_LIMIT,
	type UserPoolMailMessage
} from './user-pool-engine.ts';

/**
 * Account flows for the native pool engine (IAM.md I26, §11.2): verification, magic links,
 * password reset, invitation mail, request throttles and enumeration-safe answers. Like the other
 * engine test, this executes the real 0097 migration against an in-memory database and is not run
 * by the coding-agent slice.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-user-pool-accounts-'));
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

/** Replace the production mail seam with a capture so no test ever talks to SMTP. */
const mails: UserPoolMailMessage[] = [];
core.ctx.userPoolMail = {
	send: async (message) => {
		mails.push(message);
	}
};

const owner: Principal = buildPrincipal({ kind: 'user', userId: 'user_1', orgId: 'org_1', role: 'owner' });
let counter = 0;

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	mails.length = 0;
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
		DELETE FROM settings WHERE key LIKE 'user_pool.%';
		DELETE FROM signing_keys WHERE purpose LIKE 'pool:%';
	`);
});

afterAll(() => {
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createPool(signupMode: 'open' | 'invite' = 'open') {
	counter += 1;
	return core.userPools.create(owner, { name: `accounts-${counter}`, signupMode });
}

function lastMail(purpose: UserPoolMailMessage['purpose']): UserPoolMailMessage {
	const mail = [...mails].reverse().find((message) => message.purpose === purpose);
	if (!mail) throw new Error(`No ${purpose} mail was captured.`);
	return mail;
}

function tokenFrom(mail: UserPoolMailMessage, parameter: 'token' | 'invite' = 'token'): string {
	const value = new URL(mail.link).searchParams.get(parameter);
	if (!value) throw new Error(`The ${mail.purpose} link carried no ${parameter}.`);
	return value;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function insertUser(poolId: string, email: string): string {
	const id = `upu_test_${counter}_${Math.random().toString(36).slice(2, 10)}`;
	opened.sqlite.run(
		`INSERT INTO user_pool_users
		   (id, pool_id, email, email_verified_at, password_hash, name, metadata_json, created_at, updated_at, disabled_at)
		 VALUES (?, ?, ?, NULL, 'not-a-real-hash', '', '{}', ?, ?, NULL)`,
		[id, poolId, email, now, now]
	);
	return id;
}

describe('verification mail', () => {
	test('a sign-up mails a link whose token is stored only as a SHA-256 hash', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'Ada@Example.com', 'correct horse battery');

		expect(created.verificationToken).toBeString();
		const mail = lastMail('verify_email');
		expect(mail.to).toBe('ada@example.com');
		expect(mail.poolId).toBe(pool.id);
		expect(tokenFrom(mail)).toBe(created.verificationToken!);

		const row = opened.sqlite
			.query<{ token_hash: string; purpose: string; used_at: number | null }, [string]>(
				'SELECT token_hash, purpose, used_at FROM user_pool_email_tokens WHERE pool_id = ?'
			)
			.get(pool.id);
		expect(row?.purpose).toBe('verify_email');
		expect(row?.used_at).toBeNull();
		expect(row?.token_hash).toBe(sha256(created.verificationToken!));
		expect(row?.token_hash).not.toContain(created.verificationToken!);
	});

	test('a verification token is single use and expires', async () => {
		const first = await createPool();
		const firstSignUp = await core.userPoolEngine.signUp(first.id, 'ada@example.com', 'correct horse battery');
		expect(core.userPoolEngine.verifyEmail(first.id, firstSignUp.verificationToken!).emailVerified).toBe(true);
		expect(() => core.userPoolEngine.verifyEmail(first.id, firstSignUp.verificationToken!)).toThrow(
			/invalid|expired/i
		);

		const second = await createPool();
		await core.userPoolEngine.signUp(second.id, 'grace@example.com', 'correct horse battery');
		now += 24 * 60 * 60 * 1000 + 1;
		expect(() => core.userPoolEngine.verifyEmail(second.id, tokenFrom(lastMail('verify_email')))).toThrow(
			/invalid|expired/i
		);
	});

	test('a verification token cannot be spent as a magic link or a reset token', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await expect(
			core.userPoolEngine.magicLinkSignIn(pool.id, created.verificationToken!)
		).rejects.toThrow(/invalid|expired/i);
		await expect(
			core.userPoolEngine.resetPassword(pool.id, created.verificationToken!, 'another password')
		).rejects.toThrow(/invalid|expired/i);
	});
});

describe('magic link sign-in', () => {
	test('a requested link creates a session and marks the address verified', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		expect(created.user.emailVerified).toBe(false);

		await core.userPoolEngine.requestMagicLink(pool.id, 'ada@example.com', { ip: '203.0.113.4' });
		const token = tokenFrom(lastMail('magic_link'));
		const signedIn = await core.userPoolEngine.magicLinkSignIn(pool.id, token);

		expect(signedIn.user.emailVerified).toBe(true);
		expect(signedIn.emailVerificationPending).toBe(false);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(signedIn.user.id);

		// One click only.
		await expect(core.userPoolEngine.magicLinkSignIn(pool.id, token)).rejects.toThrow(/invalid|expired/i);
	});

	test('a magic link expires on its short clock', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.requestMagicLink(pool.id, 'ada@example.com', { ip: '203.0.113.5' });
		const token = tokenFrom(lastMail('magic_link'));

		now += USER_POOL_MAGIC_LINK_TTL_SECONDS * 1000 + 1;
		await expect(core.userPoolEngine.magicLinkSignIn(pool.id, token)).rejects.toThrow(/invalid|expired/i);
	});
});

describe('password reset', () => {
	test('a reset sets the new password and revokes every earlier session', async () => {
		const pool = await createPool();
		const created = await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const laptop = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		const phone = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');

		await core.userPoolEngine.requestPasswordReset(pool.id, 'ada@example.com', { ip: '203.0.113.6' });
		const token = tokenFrom(lastMail('password_reset'));
		const reset = await core.userPoolEngine.resetPassword(pool.id, token, 'a brand new password');

		expect(core.userPoolEngine.session(pool.id, laptop.token)).toBeNull();
		expect(core.userPoolEngine.session(pool.id, phone.token)).toBeNull();
		expect(core.userPoolEngine.session(pool.id, reset.token)?.user.id).toBe(created.user.id);
		expect(reset.user.emailVerified).toBe(true);

		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')
		).rejects.toBeInstanceOf(CoreError);
		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'a brand new password')
		).resolves.toBeDefined();

		// The link is single use and cannot be replayed.
		await expect(
			core.userPoolEngine.resetPassword(pool.id, token, 'yet another password')
		).rejects.toThrow(/invalid|expired/i);
	});

	test('a reset link expires after an hour', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.requestPasswordReset(pool.id, 'ada@example.com', { ip: '203.0.113.7' });
		const token = tokenFrom(lastMail('password_reset'));

		now += USER_POOL_PASSWORD_RESET_TTL_SECONDS * 1000 + 1;
		await expect(core.userPoolEngine.resetPassword(pool.id, token, 'a brand new password')).rejects.toThrow(
			/invalid|expired/i
		);
	});
});

describe('request throttles and enumeration safety', () => {
	test('magic links are limited per address', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		mails.length = 0;

		for (let attempt = 0; attempt < USER_POOL_MAGIC_EMAIL_LIMIT + 2; attempt += 1)
			await core.userPoolEngine.requestMagicLink(pool.id, 'ada@example.com', { ip: '198.51.100.1' });

		expect(mails.filter((mail) => mail.purpose === 'magic_link')).toHaveLength(
			USER_POOL_MAGIC_EMAIL_LIMIT
		);
	});

	test('requests are limited per client IP across addresses', async () => {
		const pool = await createPool();
		const addresses: string[] = [];
		for (let index = 0; index < USER_POOL_REQUEST_IP_LIMIT + 1; index += 1) {
			const address = `ip-${index}@example.com`;
			insertUser(pool.id, address);
			addresses.push(address);
		}
		mails.length = 0;

		for (const address of addresses)
			await core.userPoolEngine.requestMagicLink(pool.id, address, { ip: '198.51.100.2' });

		expect(mails.filter((mail) => mail.purpose === 'magic_link')).toHaveLength(
			USER_POOL_REQUEST_IP_LIMIT
		);
	});

	test('a known and an unknown address get the same answer', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		mails.length = 0;

		expect(
			await core.userPoolEngine.requestMagicLink(pool.id, 'ada@example.com', { ip: '198.51.100.3' })
		).toBeUndefined();
		expect(
			await core.userPoolEngine.requestMagicLink(pool.id, 'nobody@example.com', { ip: '198.51.100.3' })
		).toBeUndefined();
		expect(
			await core.userPoolEngine.requestPasswordReset(pool.id, 'ada@example.com', {
				ip: '198.51.100.4'
			})
		).toBeUndefined();
		expect(
			await core.userPoolEngine.requestPasswordReset(pool.id, 'nobody@example.com', {
				ip: '198.51.100.4'
			})
		).toBeUndefined();

		expect(mails.filter((mail) => mail.to === 'ada@example.com')).toHaveLength(2);
		expect(mails.filter((mail) => mail.to === 'nobody@example.com')).toHaveLength(0);
	});
});

describe('verification before sign-in', () => {
	test('an invite-only pool refuses an unverified password sign-in', async () => {
		const pool = await createPool('open');
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		core.userPools.update(owner, pool.id, { signupMode: 'invite' });

		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')
		).rejects.toMatchObject({ code: 'email_unverified', status: 403 });

		expect(core.userPoolEngine.verifyEmail(pool.id, tokenFrom(lastMail('verify_email'))).emailVerified).toBe(
			true
		);
		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')
		).resolves.toBeDefined();
	});

	test('an open pool lets an unverified account in with a pending reminder, and can opt in', async () => {
		const pool = await createPool('open');
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		const signedIn = await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery');
		expect(signedIn.emailVerificationPending).toBe(true);

		core.userPools.update(owner, pool.id, { requireEmailVerification: true });
		expect(core.userPools.get(owner, pool.id).requireEmailVerification).toBe(true);
		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')
		).rejects.toMatchObject({ code: 'email_unverified' });
	});
});

describe('invitations', () => {
	test('creating an invite mails an acceptance link that signs the address up verified', async () => {
		const pool = await createPool('invite');
		const created = core.userPools.inviteUser(owner, pool.id, 'grace@example.com');
		// `createInvite` is synchronous; the mail is dispatched without blocking the admin request.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const mail = lastMail('invite');
		expect(mail.to).toBe('grace@example.com');
		expect(mail.link).toContain(`/pool/${pool.id}/signup?invite=`);
		expect(tokenFrom(mail, 'invite')).toBe(created.token);

		const signedUp = await core.userPoolEngine.signUp(
			pool.id,
			'grace@example.com',
			'correct horse battery',
			'Grace',
			{ inviteToken: created.token }
		);
		expect(signedUp.user.emailVerified).toBe(true);
		expect(signedUp.verificationToken).toBeNull();
	});
});
