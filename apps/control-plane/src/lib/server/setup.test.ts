import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SetupAlreadyCompleteError,
	claimInstance,
	needsSetup,
	organizationSlug,
	parseClaimInput,
	passwordProblem,
	resolveSetupToken,
	setupTokenMatches,
	setupUrl,
} from './setup';

/** The Better Auth columns setup writes to (see `.schema user` on a dev database). */
function authDb(path = ':memory:'): Database {
	const db = new Database(path);
	db.run(`
		CREATE TABLE IF NOT EXISTS "user" ("id" text not null primary key, "name" text not null, "email" text not null unique,
			"emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text,
			"banned" integer default 0, "banReason" text, "banExpires" date, "twoFactorEnabled" integer default 0);
		CREATE TABLE IF NOT EXISTS "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique,
			"logo" text, "createdAt" date not null, "metadata" text);
		CREATE TABLE IF NOT EXISTS "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null,
			"userId" text not null references "user" ("id"), "accessToken" text, "refreshToken" text, "idToken" text,
			"accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
		CREATE TABLE IF NOT EXISTS "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id"),
			"userId" text not null references "user" ("id"), "role" text not null, "createdAt" date not null);
	`);
	return db;
}

const owner = { name: 'Ada Lovelace', email: 'ada@example.com', organizationName: 'Analytical Engines' };
const claim = { ...owner, passwordHash: 'scrypt:hash' };
const password = 'correct horse battery staple';

describe('needsSetup', () => {
	test('true with no users, false once one exists', () => {
		const db = authDb();
		expect(needsSetup(db)).toBe(true);
		claimInstance(db, claim);
		expect(needsSetup(db)).toBe(false);
	});

	test('true before Better Auth has created its tables', () => {
		expect(needsSetup(new Database(':memory:'))).toBe(true);
	});
});

describe('claimInstance', () => {
	test('creates a platform-admin owner with their organisation and membership', () => {
		const db = authDb();
		const { userId, organizationId } = claimInstance(db, claim, new Date('2026-11-06T12:00:00Z'));
		const user = db.query<Record<string, unknown>, [string]>('SELECT * FROM user WHERE id = ?').get(userId);
		expect(user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: 1, role: 'admin' });
		expect(user?.createdAt).toBe('2026-11-06T12:00:00.000Z');
		const org = db.query<{ name: string; slug: string }, [string]>('SELECT name, slug FROM organization WHERE id = ?').get(organizationId);
		expect(org?.name).toBe('Analytical Engines');
		expect(org?.slug).toMatch(/^analytical-engines-[0-9a-f]{6}$/);
		const member = db.query<{ role: string; organizationId: string }, [string]>('SELECT role, organizationId FROM member WHERE userId = ?').get(userId);
		expect(member).toEqual({ role: 'owner', organizationId });
		const account = db
			.query<{ providerId: string; accountId: string; password: string }, [string]>(
				'SELECT providerId, accountId, password FROM account WHERE userId = ?',
			)
			.get(userId);
		expect(account).toEqual({ providerId: 'credential', accountId: userId, password: 'scrypt:hash' });
	});

	test('refuses once any user exists, and writes nothing', () => {
		const db = authDb();
		claimInstance(db, claim);
		expect(() => claimInstance(db, { ...claim, email: 'mallory@example.com' })).toThrow(SetupAlreadyCompleteError);
		expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM user').get()?.n).toBe(1);
		expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM organization').get()?.n).toBe(1);
	});

	test('only one of two connections to the same database can claim it', () => {
		const dir = mkdtempSync(join(tmpdir(), 'skiff-setup-'));
		try {
			const path = join(dir, 'skiff.db');
			const a = authDb(path);
			const b = authDb(path);
			const results = [a, b].map((db, i) => {
				try {
					claimInstance(db, { ...claim, email: `owner${i}@example.com` });
					return 'claimed';
				} catch (error) {
					return error instanceof SetupAlreadyCompleteError ? 'refused' : String(error);
				}
			});
			expect(results.sort()).toEqual(['claimed', 'refused']);
			expect(a.query<{ n: number }, []>('SELECT count(*) AS n FROM user').get()?.n).toBe(1);
			a.close();
			b.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('parseClaimInput', () => {
	test('trims and lower-cases', () => {
		expect(
			parseClaimInput({ name: '  Ada ', email: ' ADA@Example.com ', organizationName: ' Engines ', password: ` ${password} ` }),
		).toEqual({
			ok: true,
			// Passwords are not trimmed.
			value: { name: 'Ada', email: 'ada@example.com', organizationName: 'Engines', password: ` ${password} ` },
		});
	});

	test('names the invalid field', () => {
		const valid = { ...owner, password };
		expect(parseClaimInput({ ...valid, name: ' ' })).toMatchObject({ ok: false, field: 'name' });
		expect(parseClaimInput({ ...valid, email: 'not-an-email' })).toMatchObject({ ok: false, field: 'email' });
		expect(parseClaimInput({ ...valid, organizationName: '' })).toMatchObject({ ok: false, field: 'organizationName' });
		expect(parseClaimInput({ ...valid, name: 'x'.repeat(101) })).toMatchObject({ ok: false, field: 'name' });
		expect(parseClaimInput({ ...valid, password: 'short' })).toMatchObject({ ok: false, field: 'password' });
		expect(parseClaimInput({ ...valid, passwordConfirm: 'something else entirely' })).toMatchObject({
			ok: false,
			field: 'password',
			message: 'The passwords do not match.',
		});
		expect(parseClaimInput({ ...valid, passwordConfirm: password })).toMatchObject({ ok: true });
		expect(parseClaimInput(owner)).toMatchObject({ ok: false, field: 'password' });
		expect(parseClaimInput({ name: 1, email: null })).toMatchObject({ ok: false, field: 'name' });
	});
});

describe('passwordProblem', () => {
	test('enforces 12–128 characters and a matching confirmation', () => {
		expect(passwordProblem('a'.repeat(11))).toContain('at least 12');
		expect(passwordProblem('a'.repeat(12))).toBeUndefined();
		expect(passwordProblem('a'.repeat(129))).toContain('at most 128');
		expect(passwordProblem(password, password)).toBeUndefined();
		expect(passwordProblem(password, `${password}!`)).toBe('The passwords do not match.');
	});
});

describe('organizationSlug', () => {
	test('slugifies with a random suffix, and never returns an empty base', () => {
		expect(organizationSlug('Ada’s Team!')).toMatch(/^ada-s-team-[0-9a-f]{6}$/);
		expect(organizationSlug('★★★')).toMatch(/^org-[0-9a-f]{6}$/);
	});
});

describe('setup token', () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'skiff-setup-token-'));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test('the installer file wins when it is readable', () => {
		const file = join(dir, 'setup-token');
		writeFileSync(file, 'installer-token-0123456789abcdef\n');
		expect(resolveSetupToken({ configuredFile: file, dataDir: join(dir, 'data') })).toEqual({
			token: 'installer-token-0123456789abcdef',
			file,
		});
	});

	test('falls back to a generated token in the data dir, and keeps it across restarts', () => {
		const dataDir = join(dir, 'data');
		const first = resolveSetupToken({ configuredFile: undefined, dataDir });
		expect(first.file).toBe(join(dataDir, 'setup-token'));
		expect(first.token.length).toBeGreaterThanOrEqual(32);
		expect(statSync(first.file).mode & 0o777).toBe(0o600);
		expect(readFileSync(first.file, 'utf8').trim()).toBe(first.token);
		expect(resolveSetupToken({ configuredFile: undefined, dataDir })).toEqual(first);
	});

	test('an unreadable or too-short installer file falls back, with a warning when it exists', () => {
		const file = join(dir, 'setup-token');
		writeFileSync(file, 'short\n');
		const warnings: string[] = [];
		const resolved = resolveSetupToken({ configuredFile: file, dataDir: join(dir, 'data'), warn: (m) => warnings.push(m) });
		expect(resolved.file).toBe(join(dir, 'data', 'setup-token'));
		expect(warnings).toHaveLength(1);
		// A missing file is the normal dev case: no warning.
		resolveSetupToken({ configuredFile: join(dir, 'missing'), dataDir: join(dir, 'data'), warn: (m) => warnings.push(m) });
		expect(warnings).toHaveLength(1);
	});

	test('matching is exact (after trimming the candidate)', () => {
		expect(setupTokenMatches('abc123', 'abc123')).toBe(true);
		expect(setupTokenMatches('abc123', ' abc123\n')).toBe(true);
		expect(setupTokenMatches('abc123', 'abc124')).toBe(false);
		expect(setupTokenMatches('abc123', 'abc1234')).toBe(false);
		expect(setupTokenMatches('abc123', '')).toBe(false);
		expect(setupTokenMatches('abc123', null)).toBe(false);
	});

	test('setupUrl encodes the token', () => {
		expect(setupUrl('https://control.example.com', 'a+b/c')).toBe('https://control.example.com/setup?token=a%2Bb%2Fc');
	});
});
