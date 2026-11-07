import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { verifyPassword } from 'better-auth/crypto';
import { createDb } from '@skiff/db';

const appDir = join(import.meta.dir, '..');
const script = join(import.meta.dir, 'reset-password.ts');
let dataDir: string;
let userId: string;
let passkeyOnlyId: string;

function sqlite() {
	return createDb({ path: join(dataDir, 'skiff.db') }).sqlite;
}

async function run(args: string[], stdin?: string) {
	const proc = Bun.spawn(['bun', script, ...args], {
		cwd: appDir,
		env: { ...process.env, SKIFF_DATA_DIR: dataDir },
		stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	return { stdout, stderr, code };
}

beforeAll(async () => {
	dataDir = mkdtempSync(join(tmpdir(), 'skiff-reset-password-'));
	const db = sqlite();
	const auth = betterAuth({
		database: db,
		secret: 'test-secret-0123456789-0123456789',
		emailAndPassword: { enabled: true },
		logger: { disabled: true }
	});
	await (await getMigrations(auth.options)).runMigrations();
	// The organization plugin's table, as far as the script reads it.
	db.run(
		'CREATE TABLE IF NOT EXISTS member (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL, createdAt TEXT NOT NULL)'
	);
	const ctx = await auth.$context;
	const user = await ctx.internalAdapter.createUser(
		{ email: 'ada@example.com', name: 'Ada', emailVerified: true },
		{ method: 'admin' }
	);
	userId = user.id;
	await ctx.internalAdapter.linkAccount({
		userId,
		providerId: 'credential',
		accountId: userId,
		password: await ctx.password.hash('old password 123')
	});
	await ctx.internalAdapter.createSession(userId);
	await ctx.internalAdapter.createSession(userId);
	const future = new Date(Date.now() + 60_000);
	await ctx.internalAdapter.createVerificationValue({
		identifier: 'reset-password:tok1',
		value: userId,
		expiresAt: future
	});
	await ctx.internalAdapter.createVerificationValue({
		identifier: 'magic-link:keep',
		value: userId,
		expiresAt: future
	});
	db.run(
		"INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m1', 'org_a', ?, 'owner', ?)",
		[userId, new Date().toISOString()]
	);
	const passkeyOnly = await ctx.internalAdapter.createUser(
		{ email: 'grace@example.com', name: 'Grace', emailVerified: true },
		{ method: 'admin' }
	);
	passkeyOnlyId = passkeyOnly.id;
	db.close();
});

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe('scripts/reset-password.ts', () => {
	test('sets the new password, signs out every session, voids reset links and audits', async () => {
		const result = await run(['ADA@example.com', '--password', 'new password 456']);
		expect(result.stderr).toBe('');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('signed out 2 sessions, voided 1 reset link');

		const db = sqlite();
		const account = db
			.query<{ password: string }, [string]>(
				"SELECT password FROM account WHERE userId = ? AND providerId = 'credential'"
			)
			.get(userId)!;
		expect(await verifyPassword({ hash: account.password, password: 'new password 456' })).toBe(
			true
		);
		expect(await verifyPassword({ hash: account.password, password: 'old password 123' })).toBe(
			false
		);
		expect(db.query('SELECT 1 FROM session WHERE userId = ?').all(userId)).toHaveLength(0);
		expect(
			db
				.query<{ identifier: string }, [string]>(
					'SELECT identifier FROM verification WHERE value = ?'
				)
				.all(userId)
		).toEqual([{ identifier: 'magic-link:keep' }]);
		const audit = db
			.query<
				{
					org_id: string;
					actor_type: string;
					action: string;
					resource_id: string;
					args_json: string;
				},
				[]
			>(
				"SELECT org_id, actor_type, action, resource_id, args_json FROM audit_log WHERE action = 'user.password_reset'"
			)
			.all();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ org_id: 'org_a', actor_type: 'system', resource_id: userId });
		expect(JSON.parse(audit[0]!.args_json)).toEqual({ method: 'operator', sessionsRevoked: 2 });
		db.close();
	});

	test('reads the password from stdin and gives a password-less account one', async () => {
		const result = await run(['grace@example.com'], 'stdin password 789\n');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Set the password');
		expect(result.stdout).toContain('not in any organisation');
		const db = sqlite();
		const account = db
			.query<{ password: string }, [string]>(
				"SELECT password FROM account WHERE userId = ? AND providerId = 'credential'"
			)
			.get(passkeyOnlyId)!;
		expect(await verifyPassword({ hash: account.password, password: 'stdin password 789' })).toBe(
			true
		);
		db.close();
	});

	test('refuses unknown users and short passwords without changing anything', async () => {
		const unknown = await run(['nobody@example.com', '--password', 'long enough password']);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('no user with email nobody@example.com');
		const short = await run(['ada@example.com', '--password', 'short']);
		expect(short.code).toBe(1);
		expect(short.stderr).toContain('at least 12 characters');
		const db = sqlite();
		const account = db
			.query<{ password: string }, [string]>(
				"SELECT password FROM account WHERE userId = ? AND providerId = 'credential'"
			)
			.get(userId)!;
		expect(await verifyPassword({ hash: account.password, password: 'new password 456' })).toBe(
			true
		);
		db.close();
	});

	test('rejects a missing email and extra arguments', async () => {
		expect((await run([])).code).toBe(1);
		expect((await run(['a@example.com', 'b@example.com'])).code).toBe(1);
	});
});
