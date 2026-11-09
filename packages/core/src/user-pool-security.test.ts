import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@skiff/db';
import type { Principal } from '@skiff/contracts';
import { RateLimitError, UnauthorizedError, ValidationError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import {
	USER_POOL_LOCKOUT_THRESHOLD,
	USER_POOL_OTP_MAX_ATTEMPTS,
	USER_POOL_OTP_TTL_SECONDS,
	setUserPoolBreachCheckFetch,
	type UserPoolMailMessage
} from './user-pool-engine.ts';

/**
 * Account-security specification for the native pool engine (IAM.md §11.2, I10): email OTP,
 * password lockout, breached-password checks and suspicious sign-in mail. Like the other engine
 * tests, the new migrations are executed here because the checked-in snapshot is regenerated
 * separately. No command in this slice runs this file.
 */

const dir = mkdtempSync(join(tmpdir(), 'skiff-user-pool-security-'));
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
const mails: UserPoolMailMessage[] = [];
core.ctx.userPoolMail = {
	send: async (message) => {
		mails.push(message);
	}
};

let counter = 0;

beforeEach(() => {
	now = Date.parse('2026-11-09T12:00:00Z');
	mails.length = 0;
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

async function createPool(options: { breachCheckEnabled?: boolean } = {}) {
	counter += 1;
	return core.userPools.create(owner, {
		name: `security-${counter}`,
		signupMode: 'open',
		...(options.breachCheckEnabled ? { breachCheckEnabled: true } : {})
	});
}

function lastMail(purpose: UserPoolMailMessage['purpose']): UserPoolMailMessage {
	const mail = [...mails].reverse().find((message) => message.purpose === purpose);
	if (!mail) throw new Error(`No ${purpose} mail was captured.`);
	return mail;
}

function codeFrom(mail: UserPoolMailMessage): string {
	const match = mail.text.match(/\b(\d{6})\b/);
	if (!match) throw new Error('The OTP mail carried no six-digit code.');
	return match[1]!;
}

describe('email OTP', () => {
	test('a requested code signs in once and marks the address verified', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com', { ip: '203.0.113.8' });

		const mail = lastMail('email_otp');
		expect(mail.to).toBe('ada@example.com');
		expect(mail.code).toMatch(/^\d{6}$/);
		expect(mail.text).toContain(mail.code!);
		expect(mail.link).toContain(`/pool/${pool.id}/otp`);

		const result = await core.userPoolEngine.verifyEmailOtp(
			pool.id,
			'ada@example.com',
			codeFrom(mail)
		);
		expect(result.user.emailVerified).toBe(true);
		expect(core.userPoolEngine.session(pool.id, result.token)?.user.email).toBe('ada@example.com');

		await expect(
			core.userPoolEngine.verifyEmailOtp(pool.id, 'ada@example.com', codeFrom(mail))
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('a code expires after ten minutes and only its hash is stored', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com');
		const mail = lastMail('email_otp');
		const stored = opened.sqlite
			.query<{ token_hash: string; expires_at: number }, [string]>(
				"SELECT token_hash, expires_at FROM user_pool_email_tokens WHERE pool_id = ? AND purpose = 'email_otp'"
			)
			.get(pool.id)!;
		expect(stored.token_hash).not.toContain(mail.code!);
		expect(stored.expires_at).toBe(now + USER_POOL_OTP_TTL_SECONDS * 1000);

		now += USER_POOL_OTP_TTL_SECONDS * 1000 + 1;
		await expect(
			core.userPoolEngine.verifyEmailOtp(pool.id, 'ada@example.com', codeFrom(mail))
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('five wrong codes retire the current request', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com');
		const code = codeFrom(lastMail('email_otp'));
		const wrong = code === '000000' ? '111111' : '000000';

		for (let attempt = 0; attempt < USER_POOL_OTP_MAX_ATTEMPTS; attempt += 1)
			await expect(
				core.userPoolEngine.verifyEmailOtp(pool.id, 'ada@example.com', wrong)
			).rejects.toBeInstanceOf(UnauthorizedError);
		await expect(
			core.userPoolEngine.verifyEmailOtp(pool.id, 'ada@example.com', code)
		).rejects.toBeInstanceOf(RateLimitError);

		// A new request starts a fresh budget and a fresh code.
		await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com');
		const fresh = codeFrom(lastMail('email_otp'));
		await expect(
			core.userPoolEngine.verifyEmailOtp(pool.id, 'ada@example.com', fresh)
		).resolves.toBeDefined();
	});

	test('resends are limited per address and an unknown address gets no mail', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		for (let request = 0; request < 5; request += 1)
			await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com');
		const sent = mails.filter((mail) => mail.purpose === 'email_otp').length;

		await core.userPoolEngine.requestEmailOtp(pool.id, 'ada@example.com');
		expect(mails.filter((mail) => mail.purpose === 'email_otp')).toHaveLength(sent);

		await expect(
			core.userPoolEngine.requestEmailOtp(pool.id, 'nobody@example.com')
		).resolves.toBeUndefined();
		expect(mails.filter((mail) => mail.purpose === 'email_otp')).toHaveLength(sent);
	});
});

describe('password lockout', () => {
	test('repeated failures lock one pool+email pair with a growing backoff', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');

		for (let attempt = 0; attempt < USER_POOL_LOCKOUT_THRESHOLD; attempt += 1)
			await expect(
				core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'wrong password')
			).rejects.toBeInstanceOf(UnauthorizedError);

		await expect(
			core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery')
		).rejects.toBeInstanceOf(RateLimitError);

		// A different address in the same pool is not locked out.
		await core.userPoolEngine.signUp(pool.id, 'grace@example.com', 'correct horse battery');
		await expect(
			core.userPoolEngine.signIn(pool.id, 'grace@example.com', 'correct horse battery')
		).resolves.toBeDefined();

		now += 61_000;
		const signedIn = await core.userPoolEngine.signIn(
			pool.id,
			'ada@example.com',
			'correct horse battery'
		);
		expect(signedIn.token).toBeString();
	});

	test('an unknown address is counted too, so lockout is not an account oracle', async () => {
		const pool = await createPool();
		for (let attempt = 0; attempt < USER_POOL_LOCKOUT_THRESHOLD; attempt += 1)
			await expect(
				core.userPoolEngine.signIn(pool.id, 'nobody@example.com', 'wrong password')
			).rejects.toBeInstanceOf(UnauthorizedError);
		await expect(
			core.userPoolEngine.signIn(pool.id, 'nobody@example.com', 'wrong password')
		).rejects.toBeInstanceOf(RateLimitError);
	});
});

describe('breached-password checks', () => {
	test('a network failure fails open and never blocks sign-up', async () => {
		const pool = await createPool({ breachCheckEnabled: true });
		setUserPoolBreachCheckFetch((async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch);
		await expect(
			core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery')
		).resolves.toBeDefined();
	});

	test('a prefix hit refuses the password while sending only the five-character prefix', async () => {
		const pool = await createPool({ breachCheckEnabled: true });
		const password = 'correct horse battery';
		const suffix = createHash('sha1').update(password).digest('hex').toUpperCase().slice(5);
		const calls: string[] = [];
		setUserPoolBreachCheckFetch((async (input) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			return new Response(`00112233445566778899AABBCCDDEEFF0:3\r\n${suffix}:42\r\n`);
		}) as typeof fetch);

		await expect(core.userPoolEngine.signUp(pool.id, 'ada@example.com', password)).rejects.toBeInstanceOf(
			ValidationError
		);
		expect(calls[0]).toMatch(/\/range\/[0-9A-F]{5}$/);
		expect(calls[0]).not.toContain(suffix);
		expect(core.userPools.listUsers(owner, pool.id)).toHaveLength(0);
	});

	test('the check is off by default', async () => {
		const pool = await createPool();
		let called = false;
		setUserPoolBreachCheckFetch((async () => {
			called = true;
			throw new Error('should not be called');
		}) as unknown as typeof fetch);
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		expect(called).toBe(false);
	});
});

describe('suspicious sign-in mail', () => {
	test('a new user-agent mails the owner without blocking the session', async () => {
		const pool = await createPool();
		await core.userPoolEngine.signUp(pool.id, 'ada@example.com', 'correct horse battery');
		await core.userPoolEngine.signIn(pool.id, 'ada@example.com', 'correct horse battery', {
			userAgent: 'device-one',
			country: 'GB'
		});
		expect(mails.filter((mail) => mail.purpose === 'suspicious_sign_in')).toHaveLength(0);

		const signedIn = await core.userPoolEngine.signIn(
			pool.id,
			'ada@example.com',
			'correct horse battery',
			{ userAgent: 'device-two', country: 'GB' }
		);
		expect(signedIn.token).toBeString();
		expect(lastMail('suspicious_sign_in').to).toBe('ada@example.com');
	});
});
