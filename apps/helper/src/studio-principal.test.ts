import { describe, expect, test } from 'bun:test';
import { createHandler, type HelperRuntime } from './server.ts';
import {
	applyStudioPrincipal,
	keyValueStudioPassword,
	keyValueStudioUserLine,
	parseStudioPrincipalRequest,
	studioPrincipalPlan,
	takeStudioPrincipalEnv,
	withKeyValueStudioUser,
	type StudioPrincipalExecResult,
	type StudioPrincipalOwner,
	type StudioPrincipalStep,
} from './studio-principal.ts';
import { renderKeyValueConfig } from './units.ts';
import { ValidationError } from './validate.ts';

const PASSWORD = 'Ab0_-'.repeat(6) + 'xy'; // 32 base64url characters
const OWNER_PASSWORD = 'owner-password-1234567890';

function owner(engine: StudioPrincipalOwner['engine'], database = 'shop_db'): StudioPrincipalOwner {
	return { engine, user: 'shop_db', password: OWNER_PASSWORD, database: engine === 'valkey' || engine === 'redis' ? '' : database };
}

/** Records every step and answers from a script, so tests see exactly what reaches the container. */
function fakeExec(answers: Array<Partial<StudioPrincipalExecResult>>) {
	const steps: StudioPrincipalStep[] = [];
	const exec = async (step: StudioPrincipalStep): Promise<StudioPrincipalExecResult> => {
		steps.push(step);
		const answer = answers.shift() ?? {};
		return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
	};
	return { steps, exec };
}

describe('studio principal statements', () => {
	test('postgres: idempotent role with pg_read_all_data, CONNECT, a connection limit and a read-only default', () => {
		const plan = studioPrincipalPlan(owner('postgres'), PASSWORD);
		expect(plan.apply.command).toEqual(['psql', '-h', '127.0.0.1', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'shop_db', '-d', 'shop_db']);
		expect(plan.apply.env).toEqual({ PGPASSWORD: OWNER_PASSWORD });
		const sql = plan.apply.stdin!;
		expect(sql).toContain(`CREATE ROLE "skiff_studio_ro" LOGIN PASSWORD '${PASSWORD}' CONNECTION LIMIT 4;`);
		expect(sql).toContain(`ALTER ROLE "skiff_studio_ro" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${PASSWORD}' CONNECTION LIMIT 4;`);
		expect(sql).toContain('GRANT pg_read_all_data TO "skiff_studio_ro";');
		expect(sql).toContain('GRANT CONNECT ON DATABASE "shop_db" TO "skiff_studio_ro";');
		expect(sql).toContain('ALTER ROLE "skiff_studio_ro" SET default_transaction_read_only = on;');
		expect(sql).not.toMatch(/pg_write_all_data|INSERT|UPDATE|DELETE/);
		expect(plan.verify).toEqual({
			command: ['psql', '-h', '127.0.0.1', '-tAc', 'SELECT 1', '-U', 'skiff_studio_ro', '-d', 'shop_db'],
			env: { PGPASSWORD: PASSWORD },
			stdin: null,
		});
		expect(plan.verified('1\n')).toBe(true);
		expect(plan.verified('')).toBe(false);
	});

	test('mysql and mariadb: SELECT, SHOW VIEW on the one database through local root', () => {
		for (const engine of ['mysql', 'mariadb'] as const) {
			const plan = studioPrincipalPlan(owner(engine), PASSWORD);
			expect(plan.apply.command).toEqual([engine === 'mysql' ? 'mysql' : 'mariadb', '-uroot']);
			expect(plan.apply.env).toEqual({ MYSQL_PWD: OWNER_PASSWORD });
			expect(plan.apply.stdin!.split('\n').filter(Boolean)).toEqual([
				`CREATE USER IF NOT EXISTS 'skiff_studio_ro'@'%' IDENTIFIED BY '${PASSWORD}' WITH MAX_USER_CONNECTIONS 4;`,
				`ALTER USER 'skiff_studio_ro'@'%' IDENTIFIED BY '${PASSWORD}' WITH MAX_USER_CONNECTIONS 4;`,
				"REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'skiff_studio_ro'@'%';",
				"GRANT SELECT, SHOW VIEW ON `shop_db`.* TO 'skiff_studio_ro'@'%';",
			]);
			expect(plan.verify.command).toEqual([
				engine === 'mysql' ? 'mysql' : 'mariadb',
				'-h',
				'127.0.0.1',
				'-u',
				'skiff_studio_ro',
				'-N',
				'-s',
				'-e',
				'SELECT 1',
				'shop_db',
			]);
			expect(plan.verify.env).toEqual({ MYSQL_PWD: PASSWORD });
		}
	});

	test('mongodb: createUser or updateUser in admin with read on the database, success by marker', () => {
		const plan = studioPrincipalPlan(owner('mongodb'), PASSWORD);
		expect(plan.apply.command).toEqual(['mongosh', '--quiet', '--nodb']);
		expect(plan.apply.env).toEqual({});
		const script = plan.apply.stdin!;
		expect(script).toContain(`connect('mongodb://127.0.0.1:27017/admin', "shop_db", "${OWNER_PASSWORD}")`);
		expect(script).toContain('usersInfo: "skiff_studio_ro"');
		expect(script).toContain(`updateUser: "skiff_studio_ro", pwd: "${PASSWORD}", roles: [{"role":"read","db":"shop_db"}]`);
		expect(script).toContain(`createUser: "skiff_studio_ro", pwd: "${PASSWORD}", roles: [{"role":"read","db":"shop_db"}]`);
		expect(plan.applied('> skiff-ok-1\n')).toBe(true);
		expect(plan.applied('skiff-error Unauthorized\n')).toBe(false);
		// An echoed script line that merely contains the marker is not success.
		expect(plan.applied("print(r.ok === 1 ? 'skiff-ok-1' : 'x')\n")).toBe(false);
		expect(plan.verify.stdin).toContain('listCollections');
	});

	test('valkey and redis: ACL SETUSER reset with the read-only rule set', () => {
		for (const engine of ['valkey', 'redis'] as const) {
			const plan = studioPrincipalPlan(owner(engine), PASSWORD);
			expect(plan.apply.command).toEqual([`${engine}-cli`, '--no-auth-warning', '--user', 'shop_db']);
			expect(plan.apply.env).toEqual({ REDISCLI_AUTH: OWNER_PASSWORD });
			expect(plan.apply.stdin).toBe(
				`ACL SETUSER skiff_studio_ro reset on >${PASSWORD} ~* &* +@read +@connection -@write -@admin -@dangerous +command|info +command|docs +client|setname +info +dbsize\n`,
			);
			expect(plan.applied('OK\n')).toBe(true);
			expect(plan.applied('(error) ERR Error in ACL SETUSER modifier\n')).toBe(false);
			expect(plan.verify).toEqual({
				command: [`${engine}-cli`, '--no-auth-warning', '--user', 'skiff_studio_ro', 'DBSIZE'],
				env: { REDISCLI_AUTH: PASSWORD },
				stdin: null,
			});
			expect(plan.verified('(integer) 3')).toBe(true);
			expect(plan.verified('12\n')).toBe(true);
			expect(plan.verified('NOPERM')).toBe(false);
		}
	});

	test('no password or secret ever reaches argv', () => {
		for (const engine of ['postgres', 'mysql', 'mariadb', 'mongodb', 'valkey', 'redis'] as const) {
			const plan = studioPrincipalPlan(owner(engine), PASSWORD);
			for (const step of [plan.apply, plan.verify]) {
				expect(step.command.join(' ')).not.toContain(PASSWORD);
				expect(step.command.join(' ')).not.toContain(OWNER_PASSWORD);
			}
		}
	});

	test('refuses passwords and identifiers it would have to quote', () => {
		expect(() => studioPrincipalPlan(owner('postgres'), "x'; DROP ROLE x; --".padEnd(40, 'a'))).toThrow(ValidationError);
		expect(() => studioPrincipalPlan(owner('postgres'), 'short')).toThrow(ValidationError);
		expect(() => studioPrincipalPlan(owner('mysql', 'a`b'), PASSWORD)).toThrow(ValidationError);
		expect(() => studioPrincipalPlan({ ...owner('postgres'), user: 'a"b' }, PASSWORD)).toThrow(ValidationError);
	});
});

describe('studio principal execution', () => {
	test('runs apply then verify and succeeds', async () => {
		const { steps, exec } = fakeExec([{ stdout: '' }, { stdout: '1\n' }]);
		await applyStudioPrincipal(exec, owner('postgres'), PASSWORD);
		expect(steps.map((step) => step.command[0])).toEqual(['psql', 'psql']);
		expect(steps[1]!.command).toContain('skiff_studio_ro');
	});

	test('maps a failed apply to an engine error without either password', async () => {
		const { steps, exec } = fakeExec([{ code: 3, stderr: `ERROR: permission denied (password '${PASSWORD}' for ${OWNER_PASSWORD})` }]);
		const error = await applyStudioPrincipal(exec, owner('postgres'), PASSWORD).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/^Could not create the read-only principal on postgres \(exit 3\): ERROR: permission denied/);
		expect((error as Error).message).not.toContain(PASSWORD);
		expect((error as Error).message).not.toContain(OWNER_PASSWORD);
		expect(steps).toHaveLength(1);
	});

	test('a CLI that exits 0 on a command error still fails, and so does a failed login check', async () => {
		const valkey = fakeExec([{ stdout: '(error) NOPERM this user has no permissions\n' }]);
		await expect(applyStudioPrincipal(valkey.exec, owner('valkey'), PASSWORD)).rejects.toThrow(/Could not create the read-only principal on valkey \(exit 0\): \(error\) NOPERM/);
		const mongo = fakeExec([{ stdout: 'skiff-ok-1\n' }, { stdout: 'MongoServerError: Authentication failed.\n' }]);
		await expect(applyStudioPrincipal(mongo.exec, owner('mongodb'), PASSWORD)).rejects.toThrow(/did not pass the login check/);
	});
});

describe('valkey/redis persistence', () => {
	const base = renderKeyValueConfig({ user: 'cache_db', password: OWNER_PASSWORD, memoryMb: 256 });

	test('adds the user line once, replaces it on re-apply and reads it back', () => {
		const once = withKeyValueStudioUser(base, PASSWORD);
		expect(once.startsWith(base.trimEnd())).toBe(true);
		expect(once.endsWith(`${keyValueStudioUserLine(PASSWORD)}\n`)).toBe(true);
		const other = 'Z'.repeat(32);
		const twice = withKeyValueStudioUser(once, other);
		expect(twice.match(/^user skiff_studio_ro /gm)).toHaveLength(1);
		expect(keyValueStudioPassword(twice)).toBe(other);
		expect(keyValueStudioPassword(base)).toBeNull();
		// The owner line is untouched.
		expect(twice).toContain(`user cache_db on >${OWNER_PASSWORD} ~* &* +@all`);
		// Idempotent: the same password renders the same bytes, so a re-apply changes nothing.
		expect(withKeyValueStudioUser(once, PASSWORD)).toBe(once);
	});

	test('the activation env value is taken out of the container env and validated', () => {
		const env: Record<string, string> = { VALKEY_USER: 'cache_db', SKIFF_STUDIO_RO_PASSWORD: PASSWORD };
		expect(takeStudioPrincipalEnv(env)).toBe(PASSWORD);
		expect(env).toEqual({ VALKEY_USER: 'cache_db' });
		expect(takeStudioPrincipalEnv(env)).toBeNull();
		expect(() => takeStudioPrincipalEnv({ SKIFF_STUDIO_RO_PASSWORD: 'x\nuser evil on' })).toThrow(ValidationError);
	});
});

describe('POST /v1/workloads/:id/studio-principal', () => {
	const calls: string[] = [];
	const runtime = {
		async ensureStudioPrincipal(id: string, password: string) {
			calls.push(`${id}:${password}`);
			if (id === 'db_broken') throw new Error('Could not create the read-only principal on postgres (exit 2): role busy');
			if (id === 'db_stopped') throw new ValidationError('Database db_stopped has no runtime env file; start it first.');
		},
	} as unknown as HelperRuntime;
	const handle = createHandler(runtime, { version: 'test' });
	const post = (id: string, body: unknown, method = 'POST') =>
		handle(
			new Request(`http://localhost/v1/workloads/${id}/studio-principal`, {
				method,
				headers: { 'content-type': 'application/json' },
				...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
			}),
		);

	test('applies the fixed user and never echoes the password', async () => {
		const response = await post('db_abc123', { user: 'skiff_studio_ro', password: PASSWORD });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({ ok: true, studioPrincipal: { user: 'skiff_studio_ro' } });
		expect(text).not.toContain(PASSWORD);
		expect(calls).toEqual([`db_abc123:${PASSWORD}`]);
	});

	test('validates strictly', async () => {
		const before = calls.length;
		for (const body of [
			{ user: 'shop_db', password: PASSWORD },
			{ password: PASSWORD },
			{ user: 'skiff_studio_ro', password: 'short' },
			{ user: 'skiff_studio_ro', password: `${PASSWORD}'` },
			{ user: 'skiff_studio_ro', password: PASSWORD, engine: 'postgres' },
			[],
		])
			expect((await post('db_abc123', body)).status).toBe(400);
		expect((await post('app_abc123', { user: 'skiff_studio_ro', password: PASSWORD })).status).toBe(400);
		expect((await post('db_abc123', undefined, 'GET')).status).toBe(405);
		expect(calls.length).toBe(before);
		expect(parseStudioPrincipalRequest({ user: 'skiff_studio_ro', password: PASSWORD })).toEqual({ password: PASSWORD });
	});

	test('maps runtime failures: validation is 400, an engine error is 500 with its message', async () => {
		expect((await post('db_stopped', { user: 'skiff_studio_ro', password: PASSWORD })).status).toBe(400);
		const failed = await post('db_broken', { user: 'skiff_studio_ro', password: PASSWORD });
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ error: 'Could not create the read-only principal on postgres (exit 2): role busy' });
	});
});

describe('SystemdDriver: valkey apply and the verb', () => {
	const DB_ID = 'db_cache123';

	async function driverFixture() {
		const { promises: fs } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const { SystemdDriver } = await import('./systemd.ts');
		const { parseWorkload } = await import('./validate.ts');
		const root = await fs.mkdtemp(join(tmpdir(), 'skiff-helper-principal-'));
		const runtimeDir = join(root, 'run');
		// A fake `podman` answers the live ACL SETUSER and the DBSIZE login check.
		const podmanPath = join(root, 'podman');
		await fs.writeFile(podmanPath, '#!/bin/sh\ncase "$*" in *DBSIZE*) echo "(integer) 0";; *) cat >/dev/null; echo OK;; esac\n', { mode: 0o755 });
		const calls: string[][] = [];
		const driver = new SystemdDriver({
			chown: async () => undefined,
			runner: {
				async run(argv: string[]) {
					calls.push(argv);
					return { code: 0, stdout: '', stderr: '' };
				},
			},
			unitDir: join(root, 'units'),
			quadletDir: join(root, 'quadlet'),
			runtimeDir,
			stateDir: join(root, 'state'),
			releaseDirs: [join(root, 'releases')],
			volumeRegistryFile: join(root, 'volumes.json'),
			bunPath: '/usr/local/bin/bun',
			socketMode: '0660',
			socketGroup: 'caddy',
			podmanPath,
		});
		const workload = parseWorkload({
			id: DB_ID,
			projectId: DB_ID,
			projectSlug: 'cache',
			deploymentId: DB_ID,
			runtime: 'container',
			status: 'running',
			release: null,
			image: 'docker.io/valkey/valkey:9.1-alpine',
			upstream: '127.0.0.1:16379',
			memoryMb: 256,
			cpus: 1,
			port: 16379,
			healthPath: '/',
			socketActivation: false,
			activationVersion: 'b'.repeat(64),
			env: { VALKEY_USER: 'cache_db' },
			secrets: [],
			dataSizeMb: null,
			database: { engine: 'valkey', version: '9.1' },
		});
		const activation = (env: Record<string, string>) => ({
			workloadId: DB_ID,
			activationVersion: 'b'.repeat(64),
			env: { VALKEY_PASSWORD: OWNER_PASSWORD, ...env },
			files: {},
		});
		const read = (name: string) => fs.readFile(join(runtimeDir, DB_ID, name), 'utf8');
		return { driver, workload, activation, read, calls, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
	}

	test('renders the principal from the activation env, keeps it out of the env file and keeps it on a re-apply without it', async () => {
		const f = await driverFixture();
		try {
			await f.driver.apply(f.workload, f.activation({ SKIFF_STUDIO_RO_PASSWORD: PASSWORD }));
			const config = await f.read('server.conf');
			expect(config).toContain(`${keyValueStudioUserLine(PASSWORD)}\n`);
			expect(config).toContain('user default off');
			const envFile = await f.read('env');
			expect(envFile).not.toContain(PASSWORD);
			expect(envFile).not.toContain('SKIFF_STUDIO_RO_PASSWORD');

			// An activation fetched before the principal existed must not drop it.
			await f.driver.apply(f.workload, f.activation({}));
			expect(await f.read('server.conf')).toBe(config);
		} finally {
			await f.cleanup();
		}
	});

	test('the verb applies live, verifies and then writes the user into the generated config', async () => {
		const f = await driverFixture();
		try {
			await f.driver.apply(f.workload, f.activation({}));
			expect(keyValueStudioPassword(await f.read('server.conf'))).toBeNull();
			await f.driver.ensureStudioPrincipal(DB_ID, PASSWORD);
			expect(keyValueStudioPassword(await f.read('server.conf'))).toBe(PASSWORD);
			// No restart: the live ACL already has the user.
			expect(f.calls.filter((argv) => argv.includes('restart')).length).toBe(1);
		} finally {
			await f.cleanup();
		}
	});

	test('refuses a database the helper never started', async () => {
		const f = await driverFixture();
		try {
			await expect(f.driver.ensureStudioPrincipal('db_missing1', PASSWORD)).rejects.toThrow(/no runtime env file/);
			await expect(f.driver.ensureStudioPrincipal(DB_ID, 'short')).rejects.toThrow(ValidationError);
		} finally {
			await f.cleanup();
		}
	});
});
