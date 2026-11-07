/**
 * Reset a Skiff user's password directly in the control-plane database. For installs without
 * email (no SMTP, so "Forgot password?" can't send a link) and for recovery.
 *
 *   bun run reset-password <email> [--password …]
 *
 * - The new password is prompted for (hidden, confirmed) unless `--password` is given. When stdin
 *   is not a terminal, the first line of stdin is used. 12 to 128 characters (D103).
 * - Signs the user out of every session and voids their outstanding reset links, like a reset by
 *   email. It does not touch passkeys or the authenticator app: an owner still proves a second
 *   factor at the next sign-in (D10). An account without a password gets one.
 * - Recorded in the audit log of each organisation the user belongs to, as the system.
 * - Uses the same SKIFF_DATA_DIR as the server (default `.data`, relative to the cwd).
 *
 * `src/lib/server/auth.ts` imports SvelteKit's `$app/*` modules, so this script builds a minimal
 * Better Auth instance over the same SQLite file for its adapter and password hasher, as
 * `create-user.ts` does.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { createDb } from '@skiff/db';
import { AuditService, type CoreContext } from '@skiff/core';
import { deleteResetTokens, recordPasswordReset } from '../src/lib/server/password-reset';

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;
const usage = 'Usage: bun run reset-password <email> [--password <password>]';

function fail(message: string): never {
	console.error(`reset-password: ${message}`);
	process.exit(1);
}

let parsed;
try {
	parsed = parseArgs({
		options: {
			password: { type: 'string' },
			help: { type: 'boolean', short: 'h' }
		},
		allowPositionals: true,
		strict: true
	});
} catch (error) {
	fail(`${(error as Error).message}\n${usage}`);
}
const { values, positionals } = parsed;

if (values.help) {
	console.log(usage);
	process.exit(0);
}
if (positionals.length !== 1) fail(`give exactly one email address\n${usage}`);

const email = positionals[0]!.trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`a valid email is required\n${usage}`);

const dataDir = process.env.SKIFF_DATA_DIR ?? '.data';
const dbPath = `${dataDir}/skiff.db`;
if (!existsSync(dbPath))
	fail(`no database at ${dbPath}. Set SKIFF_DATA_DIR to the control plane's data directory.`);

const { sqlite, db } = createDb({ path: dbPath });
const hasUserTable = sqlite
	.query<{ name: string }, []>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'"
	)
	.get();
if (!hasUserTable)
	fail(`${dbPath} has no Better Auth tables yet. Start the control plane once first.`);

const user =
	sqlite
		.query<{ id: string; name: string | null; email: string }, [string]>(
			'SELECT id, name, email FROM user WHERE lower(email) = ?'
		)
		.get(email) ?? fail(`no user with email ${email}`);

const password = values.password ?? (await promptPassword());
checkLength(password);

const auth = betterAuth({
	database: sqlite,
	secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789',
	emailAndPassword: { enabled: true },
	logger: { disabled: true }
});
const ctx = await auth.$context;
const passwordHash = await ctx.password.hash(password);

const sessions =
	sqlite
		.query<{ count: number }, [string]>('SELECT count(*) AS count FROM session WHERE userId = ?')
		.get(user.id)?.count ?? 0;
// The same steps as a reset by email (Better Auth's resetCredentialPassword), plus the link cleanup
// and audit entry the server adds in auth.ts.
const hadPassword = Boolean(await ctx.internalAdapter.findCredentialAccount(user.id));
await ctx.internalAdapter.deleteUserSessions(user.id);
if (hadPassword) await ctx.internalAdapter.updatePassword(user.id, passwordHash);
else
	await ctx.internalAdapter.createAccount({
		userId: user.id,
		providerId: 'credential',
		accountId: user.id,
		password: passwordHash
	});
const links = deleteResetTokens(sqlite, user.id);
// AuditService writes through `ctx.db` only.
const audit = new AuditService({ db } as unknown as CoreContext);
const entries = recordPasswordReset(audit, sqlite, {
	userId: user.id,
	method: 'operator',
	sessionsRevoked: sessions
});

console.log(
	`${hadPassword ? 'Reset' : 'Set'} the password for ${user.name || user.email} <${user.email}> (${user.id})`
);
console.log(
	`  signed out ${sessions} session${sessions === 1 ? '' : 's'}${links ? `, voided ${links} reset link${links === 1 ? '' : 's'}` : ''}`
);
console.log(
	entries
		? `  recorded in the audit log of ${entries} organisation${entries === 1 ? '' : 's'}`
		: '  not in any organisation, so nothing to audit'
);
console.log(
	'  passkeys and the authenticator app are unchanged: owners still verify one after signing in'
);
sqlite.close();

function checkLength(value: string): void {
	if (value.length < MIN_PASSWORD_LENGTH)
		fail(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	if (value.length > MAX_PASSWORD_LENGTH)
		fail(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
}

/** Hidden, confirmed prompt on a terminal; first line of stdin otherwise. */
async function promptPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
	}
	const first = await readHidden('New password: ');
	checkLength(first);
	if ((await readHidden('Confirm password: ')) !== first) fail('passwords do not match');
	return first;
}

function readHidden(question: string): Promise<string> {
	const stdin = process.stdin;
	process.stdout.write(question);
	stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding('utf8');
	return new Promise((resolve) => {
		let value = '';
		const done = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
			process.stdout.write('\n');
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					done();
					return resolve(value);
				}
				if (char === '\u0003' || char === '\u0004') {
					done();
					process.exit(130);
				}
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else value += char;
			}
		};
		stdin.on('data', onData);
	});
}
