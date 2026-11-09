import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@yoal/db';
import type { Principal } from '@yoal/contracts';
import { ConflictError, RateLimitError, UnauthorizedError } from './errors.ts';
import { createCore, type Core } from './index.ts';
import { LocalObjectStore } from './object-store.ts';
import { buildPrincipal } from './orgs.ts';
import {
	USER_POOL_PASSKEY_REGISTER_LIMIT,
	passkeyCounterAccepted,
	setUserPoolWebAuthnProvider,
	userPoolPasskeyRelyingParty,
	type UserPoolAuthenticationOptionsInput,
	type UserPoolAuthenticationVerifyInput,
	type UserPoolPasskeyAuthenticationResponse,
	type UserPoolPasskeyRegistrationResponse,
	type UserPoolRegistrationOptionsInput,
	type UserPoolRegistrationVerifyInput,
	type UserPoolWebAuthnProvider
} from './user-pool-engine.ts';

/**
 * Passkey (WebAuthn) flows for the native pool engine. Like the other engine tests, this executes
 * the real 0097 and 0101 migrations against an in-memory database; the checked-in migrations
 * bundle is regenerated separately and is not required here.
 *
 * The WebAuthn library is replaced with a deterministic fake, so these tests assert the engine's
 * own contract (challenge binding, counter handling, session creation) without touching a real
 * authenticator or the browser.
 */

const dir = mkdtempSync(join(tmpdir(), 'yoal-user-pool-passkeys-'));
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

interface WebAuthnCalls {
	registerOptions?: UserPoolRegistrationOptionsInput;
	registerVerify?: UserPoolRegistrationVerifyInput;
	loginOptions?: UserPoolAuthenticationOptionsInput;
	loginVerify?: UserPoolAuthenticationVerifyInput;
}

const calls: WebAuthnCalls = {};
let registrationCounter = 0;
let authenticationCounter = 0;
let registrationResult: { verified: boolean; registrationInfo?: { credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } } };
let authenticationResult: { verified: boolean; authenticationInfo?: { newCounter: number } };

const fakeWebAuthn: UserPoolWebAuthnProvider = {
	async generateRegistrationOptions(options) {
		calls.registerOptions = options;
		return {
			challenge: 'registration-challenge',
			rp: { id: options.rpID, name: options.rpName },
			user: {
				id: Buffer.from(options.userID).toString('base64url'),
				name: options.userName,
				displayName: options.userDisplayName ?? options.userName
			},
			pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
			attestation: 'none',
			excludeCredentials: options.excludeCredentials
		};
	},
	async verifyRegistrationResponse(options) {
		calls.registerVerify = options;
		return registrationResult;
	},
	async generateAuthenticationOptions(options) {
		calls.loginOptions = options;
		return {
			challenge: `authentication-challenge-${authenticationCounter}`,
			rpId: options.rpID,
			userVerification: options.userVerification
		};
	},
	async verifyAuthenticationResponse(options) {
		calls.loginVerify = options;
		return authenticationResult;
	}
};

beforeEach(() => {
	now = Date.parse('2026-11-08T12:00:00Z');
	registrationCounter = 0;
	authenticationCounter = 0;
	for (const key of Object.keys(calls) as Array<keyof WebAuthnCalls>) delete calls[key];
	registrationResult = {
		verified: true,
		registrationInfo: {
			credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] }
		}
	};
	authenticationResult = { verified: true, authenticationInfo: { newCounter: 1 } };
	setUserPoolWebAuthnProvider(fakeWebAuthn);
	opened.sqlite.exec(`
		DELETE FROM user_pool_passkeys;
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
	setUserPoolWebAuthnProvider(null);
	opened.sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

async function createPool(signupMode: 'open' | 'invite' = 'open') {
	counter += 1;
	return core.userPools.create(owner, { name: `passkey-pool-${counter}`, signupMode });
}

async function createUser(poolId: string, email = 'ada@example.com') {
	return core.userPoolEngine.signUp(poolId, email, 'correct horse battery');
}

function registrationResponse(id = 'cred-1'): UserPoolPasskeyRegistrationResponse {
	return {
		id,
		rawId: id,
		type: 'public-key',
		response: { clientDataJSON: 'client-data', attestationObject: 'attestation' }
	};
}

function authenticationResponse(id = 'cred-1'): UserPoolPasskeyAuthenticationResponse {
	return {
		id,
		rawId: id,
		type: 'public-key',
		response: {
			clientDataJSON: 'client-data',
			authenticatorData: 'authenticator-data',
			signature: 'signature'
		}
	};
}

async function registerPasskey(
	poolId: string,
	userId: string,
	credentialId = `cred-${++registrationCounter}`,
	counterValue = 0,
	name = 'Laptop'
) {
	registrationResult = {
		verified: true,
		registrationInfo: {
			credential: {
				id: credentialId,
				publicKey: new Uint8Array([1, 2, 3, 4]),
				counter: counterValue,
				transports: ['internal']
			}
		}
	};
	const issued = await core.userPoolEngine.passkeyRegisterOptions(
		poolId,
		userId,
		'https://auth.sites.test'
	);
	return core.userPoolEngine.passkeyRegisterVerify({
		poolId,
		userId,
		challengeId: issued.challengeId,
		response: registrationResponse(credentialId),
		name
	});
}

async function login(poolId: string, credentialId = 'cred-1', newCounter = 1) {
	authenticationCounter += 1;
	authenticationResult = { verified: true, authenticationInfo: { newCounter } };
	const issued = await core.userPoolEngine.passkeyLoginOptions(poolId);
	return core.userPoolEngine.passkeyLoginVerify({
		poolId,
		challengeId: issued.challengeId,
		response: authenticationResponse(credentialId)
	});
}

function storedPasskey(credentialId = 'cred-1') {
	return opened.sqlite
		.query<{ counter: number; last_used_at: number | null; public_key: string }, [string]>(
			'SELECT counter, last_used_at, public_key FROM user_pool_passkeys WHERE credential_id = ?'
		)
		.get(credentialId);
}

describe('relying party derivation', () => {
	test('the issuer host is the default RP id and origin', () => {
		expect(userPoolPasskeyRelyingParty('https://auth.sites.test/up_123')).toEqual({
			rpId: 'auth.sites.test',
			origin: 'https://auth.sites.test'
		});
	});

	test('a same-site page origin is used so the hosted page can actually run WebAuthn', () => {
		expect(
			userPoolPasskeyRelyingParty('https://auth.sites.test/up_123', 'https://control.sites.test')
		).toEqual({ rpId: 'control.sites.test', origin: 'https://control.sites.test' });
		expect(
			userPoolPasskeyRelyingParty('https://auth.localhost/up_123', 'http://localhost:5173')
		).toEqual({ rpId: 'localhost', origin: 'http://localhost:5173' });
	});

	test('an unrelated or insecure origin is refused', () => {
		expect(() =>
			userPoolPasskeyRelyingParty('https://auth.sites.test/up_123', 'https://evil.test')
		).toThrow(/another site/i);
		expect(() =>
			userPoolPasskeyRelyingParty('https://auth.sites.test/up_123', 'http://auth.sites.test')
		).toThrow(/HTTPS/i);
	});

	test('the counter must strictly advance once an authenticator reports one', () => {
		expect(passkeyCounterAccepted(0, 0)).toBe(true);
		expect(passkeyCounterAccepted(0, 5)).toBe(true);
		expect(passkeyCounterAccepted(5, 6)).toBe(true);
		expect(passkeyCounterAccepted(5, 5)).toBe(false);
		expect(passkeyCounterAccepted(5, 4)).toBe(false);
		expect(passkeyCounterAccepted(5, -1)).toBe(false);
	});
});

describe('passkey registration', () => {
	test('options are bound to the pool, user and a one-time challenge', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		const otherPool = await createPool();
		const otherUser = await createUser(otherPool.id, 'grace@example.com');

		const issued = await core.userPoolEngine.passkeyRegisterOptions(
			pool.id,
			user.user.id,
			'https://auth.sites.test'
		);
		expect(issued.options.rp.id).toBe('auth.sites.test');
		expect(calls.registerOptions?.userName).toBe('ada@example.com');
		expect(calls.registerOptions?.authenticatorSelection?.userVerification).toBe('required');
		expect(calls.registerOptions?.authenticatorSelection?.residentKey).toBe('required');

		await expect(
			core.userPoolEngine.passkeyRegisterVerify({
				poolId: otherPool.id,
				userId: otherUser.user.id,
				challengeId: issued.challengeId,
				response: registrationResponse()
			})
		).rejects.toBeInstanceOf(UnauthorizedError);

		// A challenge belongs to one user, not merely to one pool.
		const second = await core.userPoolEngine.passkeyRegisterOptions(
			pool.id,
			user.user.id,
			'https://auth.sites.test'
		);
		const anotherUser = await createUser(pool.id, 'linus@example.com');
		await expect(
			core.userPoolEngine.passkeyRegisterVerify({
				poolId: pool.id,
				userId: anotherUser.user.id,
				challengeId: second.challengeId,
				response: registrationResponse()
			})
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('a successful registration stores only the public key and refuses a reuse', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);

		const passkey = await registerPasskey(pool.id, user.user.id, 'cred-1', 0, 'Work laptop');
		expect(passkey).toMatchObject({ name: 'Work laptop', userId: user.user.id, lastUsedAt: null });
		expect(calls.registerVerify?.requireUserVerification).toBe(true);
		expect(calls.registerVerify?.expectedChallenge).toBe('registration-challenge');
		expect(calls.registerVerify?.expectedOrigin).toBe('https://auth.sites.test');
		expect(calls.registerVerify?.expectedRPID).toBe('auth.sites.test');
		const stored = storedPasskey();
		expect(stored?.public_key).toBe(Buffer.from([1, 2, 3, 4]).toString('base64url'));
		expect(stored?.counter).toBe(0);

		await expect(registerPasskey(pool.id, user.user.id, 'cred-1')).rejects.toBeInstanceOf(
			ConflictError
		);
		// The raw credential never appears in the view the page receives.
		expect(JSON.stringify(core.userPoolEngine.listPasskeys(pool.id, user.user.id))).not.toContain(
			'cred-1'
		);
	});

	test('registration challenges are rate limited per user', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		for (let attempt = 0; attempt < USER_POOL_PASSKEY_REGISTER_LIMIT; attempt += 1)
			await core.userPoolEngine.passkeyRegisterOptions(
				pool.id,
				user.user.id,
				'https://auth.sites.test'
			);
		await expect(
			core.userPoolEngine.passkeyRegisterOptions(pool.id, user.user.id, 'https://auth.sites.test')
		).rejects.toBeInstanceOf(RateLimitError);
	});

	test('a verified challenge cannot be spent twice', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		const issued = await core.userPoolEngine.passkeyRegisterOptions(
			pool.id,
			user.user.id,
			'https://auth.sites.test'
		);
		await core.userPoolEngine.passkeyRegisterVerify({
			poolId: pool.id,
			userId: user.user.id,
			challengeId: issued.challengeId,
			response: registrationResponse()
		});
		await expect(
			core.userPoolEngine.passkeyRegisterVerify({
				poolId: pool.id,
				userId: user.user.id,
				challengeId: issued.challengeId,
				response: registrationResponse()
			})
		).rejects.toBeInstanceOf(UnauthorizedError);
	});
});

describe('passkey sign-in', () => {
	test('a verified assertion advances the counter and starts a pool session', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);

		const signedIn = await login(pool.id, 'cred-1', 5);
		expect(signedIn.user.id).toBe(user.user.id);
		expect(signedIn.session.userId).toBe(user.user.id);
		expect(core.userPoolEngine.session(pool.id, signedIn.token)?.user.id).toBe(user.user.id);
		expect(storedPasskey()?.counter).toBe(5);
		expect(storedPasskey()?.last_used_at).toBe(now);
		expect(calls.loginVerify?.requireUserVerification).toBe(true);
		expect(calls.loginVerify?.expectedRPID).toBe('auth.sites.test');
		expect(calls.loginOptions?.userVerification).toBe('required');
	});

	test('a replayed or lower counter is refused as a possible clone', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);

		await login(pool.id, 'cred-1', 5);
		expect(storedPasskey()?.counter).toBe(5);

		await expect(login(pool.id, 'cred-1', 5)).rejects.toBeInstanceOf(UnauthorizedError);
		await expect(login(pool.id, 'cred-1', 4)).rejects.toBeInstanceOf(UnauthorizedError);
		// A refused clone attempt must not move the stored counter.
		expect(storedPasskey()?.counter).toBe(5);

		const fresh = await login(pool.id, 'cred-1', 6);
		expect(core.userPoolEngine.session(pool.id, fresh.token)).not.toBeNull();
		expect(storedPasskey()?.counter).toBe(6);
	});

	test('an assertion for another pool, or an unknown credential, is refused', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);
		const otherPool = await createPool();

		const issued = await core.userPoolEngine.passkeyLoginOptions(pool.id);
		await expect(
			core.userPoolEngine.passkeyLoginVerify({
				poolId: otherPool.id,
				challengeId: issued.challengeId,
				response: authenticationResponse('cred-1')
			})
		).rejects.toBeInstanceOf(UnauthorizedError);

		await expect(login(pool.id, 'not-a-credential', 1)).rejects.toBeInstanceOf(
			UnauthorizedError
		);
	});

	test('an email hint that does not own the credential is refused', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);

		const issued = await core.userPoolEngine.passkeyLoginOptions(pool.id, 'nobody@example.com');
		authenticationResult = { verified: true, authenticationInfo: { newCounter: 1 } };
		await expect(
			core.userPoolEngine.passkeyLoginVerify({
				poolId: pool.id,
				challengeId: issued.challengeId,
				response: authenticationResponse('cred-1'),
				email: 'nobody@example.com'
			})
		).rejects.toBeInstanceOf(UnauthorizedError);
	});

	test('options never reveal whether the address exists', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);

		const known = await core.userPoolEngine.passkeyLoginOptions(pool.id, 'ada@example.com');
		const unknown = await core.userPoolEngine.passkeyLoginOptions(pool.id, 'nobody@example.com');
		expect(known.options.allowCredentials).toBeUndefined();
		expect(unknown.options.allowCredentials).toBeUndefined();
		expect(known.options.rpId).toBe(unknown.options.rpId);
	});

	test('a disabled user cannot sign in with a passkey', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		await registerPasskey(pool.id, user.user.id, 'cred-1', 0);
		core.userPools.disableUser(owner, pool.id, user.user.id);

		await expect(login(pool.id, 'cred-1', 1)).rejects.toBeInstanceOf(UnauthorizedError);
	});
});

describe('passkey management', () => {
	test('list and delete are scoped to one pool user', async () => {
		const pool = await createPool();
		const user = await createUser(pool.id);
		const other = await createUser(pool.id, 'grace@example.com');
		const first = await registerPasskey(pool.id, user.user.id, 'cred-1', 0);
		const second = await registerPasskey(pool.id, user.user.id, 'cred-2', 0);

		expect(core.userPoolEngine.listPasskeys(pool.id, user.user.id)).toHaveLength(2);
		expect(core.userPoolEngine.deletePasskey(pool.id, other.user.id, first.id)).toBe(false);
		expect(core.userPoolEngine.deletePasskey(pool.id, user.user.id, first.id)).toBe(true);
		expect(core.userPoolEngine.listPasskeys(pool.id, user.user.id).map((item) => item.id)).toEqual([
			second.id
		]);
		expect(core.userPoolEngine.deletePasskey(pool.id, user.user.id, first.id)).toBe(false);
	});

	test('deleting a user or purging a pool removes their passkeys', async () => {
		const pool = await createPool();
		const first = await createUser(pool.id);
		const second = await createUser(pool.id, 'grace@example.com');
		await registerPasskey(pool.id, first.user.id, 'cred-1', 0);
		await registerPasskey(pool.id, second.user.id, 'cred-2', 0);

		core.userPools.deleteUser(owner, pool.id, first.user.id);
		expect(
			opened.sqlite
				.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM user_pool_passkeys WHERE user_id = ?')
				.get(first.user.id)?.n
		).toBe(0);

		core.userPools.delete(owner, pool.id);
		expect(
			opened.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_pool_passkeys').get()?.n
		).toBe(0);
	});
});
