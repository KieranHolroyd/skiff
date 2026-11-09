/**
 * Create a Yoal user directly in the control-plane database, bypassing the invite-only gate (D10).
 * For bootstrapping the first owner and for local development.
 *
 *   bun run create-user <email> [name] [--password …] [--org slug --role admin] [--platform-admin]
 *
 * - The password is prompted for (hidden, confirmed) unless `--password` is given. When stdin is
 *   not a terminal, the first line of stdin is used. Sign in with that email and password (D103);
 *   owners then enrol a passkey or authenticator app.
 * - The first user in the database is the bootstrap user: platform admin (admin plugin role, which
 *   manages nodes) and owner of a personal org created on first sign-in. Later users need `--org`
 *   (or an invitation) to join an org; `--platform-admin` also grants the platform role.
 * - Uses the same YOAL_DATA_DIR as the server (default `.data`, relative to the cwd). Start the
 *   control plane once first so Better Auth's tables exist.
 *
 * `src/lib/server/auth.ts` imports SvelteKit's `$app/*` modules, so this script builds a minimal
 * Better Auth instance over the same SQLite file for its adapter and password hasher.
 */
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { createDb, platformDbPath } from '@yoal/db';
import { isRole } from '@yoal/core';

const usage =
	'Usage: bun run create-user <email> [name] [--password <password>] [--org <slug> --role <owner|admin|deployer|viewer>] [--platform-admin]';

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
			'platform-admin': { type: 'boolean' },
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

const dataDir = process.env.YOAL_DATA_DIR ?? '.data';
const dbPath = platformDbPath(dataDir);
if (!existsSync(dbPath))
	fail(`no database at ${dbPath}. Start the control plane once (or set YOAL_DATA_DIR).`);

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
const isFirstUser = !sqlite.query('SELECT 1 FROM user LIMIT 1').get();
const platformAdmin = isFirstUser || values['platform-admin'] === true;

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
if (password.length < 12) fail('password must be at least 12 characters');

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
if (platformAdmin) sqlite.run("UPDATE user SET role = 'admin' WHERE id = ?", [user.id]);
if (organization) {
	sqlite.run(
		'INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)',
		[crypto.randomUUID(), organization.id, user.id, role, new Date().toISOString()]
	);
}

console.log(`Created user ${user.name} <${user.email}> (${user.id})`);
if (organization) console.log(`  member of ${organization.name || organization.slug} as ${role}`);
else if (isFirstUser) console.log('  a personal org (owner) is created on first sign-in');
else console.log('  not in any org yet: invite them from the dashboard or re-run with --org');
if (platformAdmin) console.log('  platform admin (can manage nodes)');
console.log('  sign in with this email and password (owners then add a passkey or authenticator app)');
sqlite.close();

/** Hidden, confirmed prompt on a terminal; first line of stdin otherwise. */
async function promptPassword(): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		return Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '';
	}
	const first = await readHidden('Password: ');
	if (first.length < 12) fail('password must be at least 12 characters');
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
