/**
 * Create a Skiff user directly in the control-plane database, bypassing the invite-only gate (D10).
 * For bootstrapping the first owner and for local development.
 *
 *   bun run create-user <email> [name] [--password …] [--org slug --role admin]
 *
 * - The password is prompted for (hidden, confirmed) unless `--password` is given. When stdin is
 *   not a terminal, the first line of stdin is used. Password sign-in only works when the server
 *   runs with SKIFF_DEV_PASSWORD_LOGIN=1; otherwise sign in with a magic link, then add a passkey.
 * - Without `--org`, the user gets a personal org (as owner) on first sign-in, like every user.
 * - Uses the same SKIFF_DATA_DIR as the server (default `.data`, relative to the cwd). Start the
 *   control plane once first so Better Auth's tables exist.
 *
 * `src/lib/server/auth.ts` imports SvelteKit's `$app/*` modules, so this script builds a minimal
 * Better Auth instance over the same SQLite file for its adapter and password hasher.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { createDb } from '@skiff/db';
import { isRole } from '@skiff/core';

const usage =
	'Usage: bun run create-user <email> [name] [--password <password>] [--org <slug> --role <owner|admin|deployer|viewer>]';

function fail(message: string): never {
	console.error(`create-user: ${message}`);
	process.exit(1);
}

let parsed;
try {
	parsed = parseArgs({
		options: {
			password: { type: 'string' },
			org: { type: 'string' },
			role: { type: 'string' },
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
if (positionals.length > 2)
	fail(`too many arguments (quote a name with spaces: "Jane Doe")\n${usage}`);

const email = positionals[0]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
	fail(`a valid email is required\n${usage}`);
const name = positionals[1]?.trim() || email.split('@')[0]!;
if (values.role && !values.org) fail('--role requires --org');
const role = values.role ?? 'viewer';
if (!isRole(role)) fail(`unknown role "${role}" (owner, admin, deployer, viewer)`);

const dataDir = process.env.SKIFF_DATA_DIR ?? '.data';
const dbPath = `${dataDir}/skiff.db`;
if (!existsSync(dbPath))
	fail(`no database at ${dbPath}. Start the control plane once (or set SKIFF_DATA_DIR).`);

const { sqlite } = createDb({ path: dbPath });
const hasUserTable = sqlite
	.query<{ name: string }, []>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'"
	)
	.get();
if (!hasUserTable)
	fail(`${dbPath} has no Better Auth tables yet. Start the control plane once first.`);

if (sqlite.query('SELECT 1 FROM user WHERE email = ?').get(email))
	fail(`a user with email ${email} already exists`);

let organization: { id: string; name: string; slug: string } | undefined;
if (values.org) {
	organization =
		sqlite
			.query<{ id: string; name: string; slug: string }, [string, string]>(
				'SELECT id, name, slug FROM organization WHERE slug = ? OR id = ?'
			)
			.get(values.org, values.org) ?? fail(`no organization with slug or id "${values.org}"`);
}

const password = values.password ?? (await promptPassword());
if (password.length < 8) fail('password must be at least 8 characters');

const auth = betterAuth({
	database: sqlite,
	secret: process.env.BETTER_AUTH_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789',
	emailAndPassword: { enabled: true },
	logger: { disabled: true }
});
const ctx = await auth.$context;

const user = await ctx.internalAdapter.createUser(
	{ email, name, emailVerified: true },
	{ method: 'admin' }
);
await ctx.internalAdapter.linkAccount({
	userId: user.id,
	providerId: 'credential',
	accountId: user.id,
	password: await ctx.password.hash(password)
});
if (organization) {
	sqlite.run(
		'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
		[crypto.randomUUID(), organization.id, user.id, role, new Date().toISOString()]
	);
}

console.log(`Created user ${user.name} <${user.email}> (${user.id})`);
if (organization) console.log(`  member of ${organization.name || organization.slug} as ${role}`);
else console.log('  a personal org (owner) is created on first sign-in');
console.log('  password sign-in requires SKIFF_DEV_PASSWORD_LOGIN=1; magic links always work');
sqlite.close();

/** Hidden, confirmed prompt on a terminal; first line of stdin otherwise. */
async function promptPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
	}
	const first = await readHidden('Password: ');
	if (first.length < 8) fail('password must be at least 8 characters');
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
