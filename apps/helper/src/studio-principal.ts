import { assertRecord, ValidationError, type DatabaseEngine } from './validate.ts';

/**
 * The read-only studio principal verb (plan 22, track G): `POST /v1/workloads/:id/studio-principal`
 * creates or updates one fixed `yoal_studio_ro` account inside a managed database, with only
 * read rights, so the database itself refuses a read-only studio session's writes.
 *
 * Like the credential verbs, the statements run through `podman exec` with the owner's (or, on
 * MySQL/MariaDB, local root's) password in podman's environment and the SQL on stdin: no secret
 * reaches argv, a log line or an error message. The user name is fixed and the password is
 * base64url, so nothing on the wire is ever spliced into a statement unchecked.
 *
 * | Engine | Grants |
 * |---|---|
 * | Postgres | `LOGIN`, `pg_read_all_data`, `CONNECT` on the database, connection limit 4, read-only default |
 * | MySQL, MariaDB | `SELECT, SHOW VIEW` on the database, `MAX_USER_CONNECTIONS 4` |
 * | MongoDB | `read` on the database, defined in `admin` like the owner |
 * | Valkey, Redis | ACL `+@read +@connection -@write -@admin -@dangerous` plus the plugin's gate commands |
 *
 * Valkey/Redis keep config-file ACL users only in memory, so the verb also writes the user into
 * the helper-generated server config, and `apply` renders it from the activation env: a restart,
 * a crash or a re-apply keeps the principal.
 */

export const STUDIO_PRINCIPAL_USER = 'yoal_studio_ro';
/** Two studio sessions of two connections each (plan 22 "Safety and limits"). */
export const STUDIO_PRINCIPAL_CONNECTION_LIMIT = 4;
/** Activation env that carries the Valkey/Redis principal's password into the generated config. */
export const STUDIO_PRINCIPAL_ENV = 'YOAL_STUDIO_RO_PASSWORD';
const PASSWORD_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const STEP_TIMEOUT_MS = 60_000;

/**
 * ACL rules after `on >password`. `-@dangerous` drops `INFO` and `KEYS`; `INFO` and `DBSIZE` come
 * back explicitly, and the studio's command gate needs `COMMAND INFO`/`DOCS` and `CLIENT SETNAME`.
 */
export const KEY_VALUE_STUDIO_ACL_RULES = [
	'~*',
	'&*',
	'+@read',
	'+@connection',
	'-@write',
	'-@admin',
	'-@dangerous',
	'+command|info',
	'+command|docs',
	'+client|setname',
	'+info',
	'+dbsize',
] as const;

export function assertStudioPrincipalPassword(value: unknown, label = 'password'): string {
	if (typeof value !== 'string' || !PASSWORD_PATTERN.test(value))
		throw new ValidationError(`${label} must be base64url (32–128 characters)`);
	return value;
}

/** The verb's body: exactly `{ user: "yoal_studio_ro", password }`. The engine comes from the workload. */
export function parseStudioPrincipalRequest(body: unknown): { password: string } {
	const record = assertRecord(body, 'request');
	for (const key of Object.keys(record))
		if (key !== 'user' && key !== 'password') throw new ValidationError(`request.${key} is not supported`);
	if (record.user !== STUDIO_PRINCIPAL_USER) throw new ValidationError(`user must be ${STUDIO_PRINCIPAL_USER}`);
	return { password: assertStudioPrincipalPassword(record.password) };
}

/** Owner facts the helper read back from its own env file. */
export interface StudioPrincipalOwner {
	engine: DatabaseEngine;
	user: string;
	password: string;
	/** Empty for Valkey/Redis. */
	database: string;
}

/** One in-container command: argv after the container name, env names for `-e`, and stdin. */
export interface StudioPrincipalStep {
	command: string[];
	env: Record<string, string>;
	stdin: string | null;
}

export interface StudioPrincipalPlan {
	apply: StudioPrincipalStep;
	/** Whether the apply step's stdout shows success (the CLIs that exit 0 on a command error). */
	applied(stdout: string): boolean;
	/** A fresh login as the principal, answered by a read the principal must be allowed. */
	verify: StudioPrincipalStep;
	verified(stdout: string): boolean;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** The statements per engine. Pure, so tests and the real-engine e2e run exactly these. */
export function studioPrincipalPlan(owner: StudioPrincipalOwner, password: string): StudioPrincipalPlan {
	assertStudioPrincipalPassword(password);
	if (!IDENTIFIER.test(owner.user)) throw new ValidationError('The owner user is not a valid identifier');
	const user = STUDIO_PRINCIPAL_USER;
	const limit = STUDIO_PRINCIPAL_CONNECTION_LIMIT;
	switch (owner.engine) {
		case 'postgres': {
			requireDatabase(owner);
			const db = owner.database;
			const sql = [
				'DO $$ BEGIN',
				`  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN`,
				`    CREATE ROLE "${user}" LOGIN PASSWORD '${password}' CONNECTION LIMIT ${limit};`,
				'  ELSE',
				`    ALTER ROLE "${user}" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}' CONNECTION LIMIT ${limit};`,
				'  END IF;',
				'END $$;',
				`GRANT pg_read_all_data TO "${user}";`,
				`GRANT CONNECT ON DATABASE "${db}" TO "${user}";`,
				`ALTER ROLE "${user}" SET default_transaction_read_only = on;`,
				'',
			].join('\n');
			return {
				apply: {
					command: ['psql', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-q', '-U', owner.user, '-d', db],
					env: { PGPASSWORD: owner.password },
					stdin: sql,
				},
				applied: () => true,
				verify: {
					command: ['psql', '-h', '127.0.0.1', '-tAc', 'SELECT 1', '-U', user, '-d', db],
					env: { PGPASSWORD: password },
					stdin: null,
				},
				verified: (stdout) => stdout.trim() === '1',
			};
		}
		case 'mysql':
		case 'mariadb': {
			requireDatabase(owner);
			const cli = owner.engine === 'mysql' ? 'mysql' : 'mariadb';
			const account = `'${user}'@'%'`;
			const sql = [
				`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS ${limit};`,
				`ALTER USER ${account} IDENTIFIED BY '${password}' WITH MAX_USER_CONNECTIONS ${limit};`,
				`REVOKE ALL PRIVILEGES, GRANT OPTION FROM ${account};`,
				`GRANT SELECT, SHOW VIEW ON \`${owner.database}\`.* TO ${account};`,
				'',
			].join('\n');
			return {
				// `root@localhost` keeps the owner's password on the container's own socket (D61).
				apply: { command: [cli, '-uroot'], env: { MYSQL_PWD: owner.password }, stdin: sql },
				applied: () => true,
				verify: {
					command: [cli, '-h', '127.0.0.1', '-u', user, '-N', '-s', '-e', 'SELECT 1', owner.database],
					env: { MYSQL_PWD: password },
					stdin: null,
				},
				verified: (stdout) => stdout.trim() === '1',
			};
		}
		case 'mongodb': {
			requireDatabase(owner);
			const roles = JSON.stringify([{ role: 'read', db: owner.database }]);
			// mongosh evaluates stdin line by line and keeps going after a throw, so success is a
			// marker printed only when every earlier line ran.
			const script = [
				`const c = connect('mongodb://127.0.0.1:27017/admin', ${JSON.stringify(owner.user)}, ${JSON.stringify(owner.password)});`,
				`const found = c.runCommand({ usersInfo: ${JSON.stringify(user)} });`,
				`const r = found.ok !== 1 ? found : found.users.length > 0 ? c.runCommand({ updateUser: ${JSON.stringify(user)}, pwd: ${JSON.stringify(password)}, roles: ${roles} }) : c.runCommand({ createUser: ${JSON.stringify(user)}, pwd: ${JSON.stringify(password)}, roles: ${roles} });`,
				`print(r.ok === 1 ? 'yoal-ok-1' : 'yoal-error ' + String(r.codeName || r.errmsg || 'unknown'));`,
				'',
			].join('\n');
			const verify = [
				`const c = connect('mongodb://127.0.0.1:27017/admin', ${JSON.stringify(user)}, ${JSON.stringify(password)});`,
				`print('yoal-ok-' + c.getSiblingDB(${JSON.stringify(owner.database)}).runCommand({ listCollections: 1, nameOnly: true }).ok);`,
				'',
			].join('\n');
			return {
				apply: { command: ['mongosh', '--quiet', '--nodb'], env: {}, stdin: script },
				applied: (stdout) => hasLine(stdout, 'yoal-ok-1'),
				verify: { command: ['mongosh', '--quiet', '--nodb'], env: {}, stdin: verify },
				verified: (stdout) => hasLine(stdout, 'yoal-ok-1'),
			};
		}
		case 'valkey':
		case 'redis': {
			const cli = owner.engine === 'valkey' ? 'valkey-cli' : 'redis-cli';
			return {
				apply: {
					command: [cli, '--no-auth-warning', '--user', owner.user],
					env: { REDISCLI_AUTH: owner.password },
					// `reset` first, so a re-apply replaces every earlier password and rule.
					stdin: `ACL SETUSER ${user} reset on >${password} ${KEY_VALUE_STUDIO_ACL_RULES.join(' ')}\n`,
				},
				// valkey-cli exits 0 on a command error; the reply is on stdout.
				applied: (stdout) => stdout.trim() === 'OK',
				verify: {
					command: [cli, '--no-auth-warning', '--user', user, 'DBSIZE'],
					env: { REDISCLI_AUTH: password },
					stdin: null,
				},
				verified: (stdout) => /^\(integer\) \d+$|^\d+$/.test(stdout.trim()),
			};
		}
		case 'clickhouse':
			// No studio plugin yet (the engine's `console` capability is off), so no principal.
			throw new ValidationError('The read-only studio account is not available for clickhouse');
	}
}

/** The principal's line in the generated Valkey/Redis server config. */
export function keyValueStudioUserLine(password: string): string {
	assertStudioPrincipalPassword(password);
	return `user ${STUDIO_PRINCIPAL_USER} on >${password} ${KEY_VALUE_STUDIO_ACL_RULES.join(' ')}`;
}

const STUDIO_USER_LINE = new RegExp(`^user ${STUDIO_PRINCIPAL_USER} `);

/** Replace (or add) the principal's line at the end of a generated server config. */
export function withKeyValueStudioUser(config: string, password: string): string {
	const lines = config.split('\n').filter((line) => !STUDIO_USER_LINE.test(line));
	while (lines.length > 0 && lines.at(-1) === '') lines.pop();
	return `${[...lines, keyValueStudioUserLine(password)].join('\n')}\n`;
}

/** The principal's password from an existing generated config, if it has the line. */
export function keyValueStudioPassword(config: string): string | null {
	for (const line of config.split('\n')) {
		if (!STUDIO_USER_LINE.test(line)) continue;
		const match = / >([A-Za-z0-9_-]{32,128}) /.exec(line);
		if (match) return match[1]!;
	}
	return null;
}

/**
 * Take the principal's password out of a workload env so it never lands in the container env file.
 * Returns null when absent; a malformed value is refused rather than rendered.
 */
export function takeStudioPrincipalEnv(env: Record<string, string>): string | null {
	if (!Object.hasOwn(env, STUDIO_PRINCIPAL_ENV)) return null;
	const value = env[STUDIO_PRINCIPAL_ENV];
	delete env[STUDIO_PRINCIPAL_ENV];
	return assertStudioPrincipalPassword(value, STUDIO_PRINCIPAL_ENV);
}

export interface StudioPrincipalExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type StudioPrincipalExec = (step: StudioPrincipalStep) => Promise<StudioPrincipalExecResult>;

/**
 * `<engine> exec [-i] -e NAME… <container> <command…>` with the values in the child's environment,
 * never argv. The helper passes podman; the real-engine e2e passes docker.
 */
export function containerExec(engine: readonly string[], container: string): StudioPrincipalExec {
	return async (step) => {
		const argv = [
			...engine,
			'exec',
			...(step.stdin !== null ? ['-i'] : []),
			...Object.keys(step.env).flatMap((name) => ['-e', name]),
			container,
			...step.command,
		];
		const child = Bun.spawn(argv, {
			env: { ...process.env, ...step.env },
			stdin: step.stdin !== null ? 'pipe' : 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
		});
		if (step.stdin !== null && child.stdin && typeof child.stdin !== 'number') {
			child.stdin.write(step.stdin);
			child.stdin.end();
		}
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout as ReadableStream).text(),
			new Response(child.stderr as ReadableStream).text(),
		]);
		return { code, stdout, stderr };
	};
}

/**
 * Apply the principal, then prove a fresh login as it can read. Failures name the engine and the
 * step; the owner's and the principal's passwords are scrubbed from any detail.
 */
export async function applyStudioPrincipal(
	exec: StudioPrincipalExec,
	owner: StudioPrincipalOwner,
	password: string,
): Promise<void> {
	const plan = studioPrincipalPlan(owner, password);
	const scrub = (text: string) =>
		text.split(password).join('***').split(owner.password).join('***').trim().slice(0, 500) || 'no detail';
	const applied = await exec(plan.apply);
	if (applied.code !== 0 || !plan.applied(applied.stdout))
		throw new Error(
			`Could not create the read-only principal on ${owner.engine} (exit ${applied.code}): ${scrub(applied.stderr || applied.stdout)}`,
		);
	const verified = await exec(plan.verify);
	if (verified.code !== 0 || !plan.verified(verified.stdout))
		throw new Error(
			`The read-only principal on ${owner.engine} did not pass the login check (exit ${verified.code}): ${scrub(verified.stderr || verified.stdout)}`,
		);
}

function requireDatabase(owner: StudioPrincipalOwner): void {
	if (!IDENTIFIER.test(owner.database)) throw new ValidationError(`The ${owner.engine} database name is not a valid identifier`);
}

/** mongosh echoes a `> ` prompt before each line it reads from stdin. */
function hasLine(stdout: string, expected: string): boolean {
	return stdout.split('\n').some((line) => line.replace(/^(?:>\s*)+/, '').trim() === expected);
}
